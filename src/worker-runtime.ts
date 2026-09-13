/* oxlint-disable typescript/no-this-alias -- Effect generators retain the runtime owner while yielding host and contract failures. */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Config, ConfigProvider, Data, DateTime, Effect } from "effect";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ThinkingSchema } from "./domain/model-target.js";
import {
  type ImplementationReportInput,
  isWorkerReport,
  isWorkerReportInput,
  reportSchemaForMode,
  type WorkerReport,
  type WorkerReportInput,
  type WorkerSessionMode,
} from "./domain/report.js";
import {
  EXECUTOR_START_ENTRY,
  executorFailure,
  executorFailureMessage,
  hasActiveObjective,
  hasActiveRecovery,
  hasExecutorStart,
  isWorkerIdentityData,
  recoveryMessage,
  type WorkerContextIdentity,
  type WorkerObjectiveRestore,
  type WorkerPhase,
  type WorkerPolicyRole,
  workerSystemPolicy,
} from "./worker-context.js";
import { WorkerContractError, WorkerPlanState, type WorkerPlanToolInput } from "./worker-plan.js";

const WorkerEnvironmentConfig = Config.all({
  mode: Config.string("PI_WORKGRAPH_MODE").pipe(Config.withDefault("")),
  runId: Config.string("PI_WORKGRAPH_RUN_ID").pipe(Config.withDefault("unknown-workstream")),
  nodeId: Config.string("PI_WORKGRAPH_NODE_ID").pipe(Config.withDefault("unknown-attempt")),
  executorModel: Config.string("PI_WORKGRAPH_EXECUTOR_MODEL").pipe(Config.withDefault("")),
  executorThinking: Config.string("PI_WORKGRAPH_EXECUTOR_THINKING").pipe(
    Config.withDefault("high"),
  ),
  baseCommit: Config.string("PI_WORKGRAPH_BASE_COMMIT").pipe(Config.withDefault("")),
  implementationStart: Config.string("PI_WORKGRAPH_IMPLEMENTATION_START").pipe(
    Config.withDefault(""),
  ),
  experiment: Config.string("PI_WORKGRAPH_EXPERIMENT").pipe(Config.withDefault("")),
  policyRole: Config.string("PI_WORKGRAPH_POLICY_ROLE").pipe(Config.withDefault("")),
});

const ObjectiveContentSchema = Type.String();
const ReportToolDetailsSchema = Type.Object({ report: Type.Unknown() });
const MAX_PLAN_REMINDERS = 2;
const RECONCILIATION_MESSAGE_TYPE = "pi-workgraph-reconciliation";
type WorkerEntry = SessionEntry;

export interface WorkerEnvironment {
  readonly mode: WorkerSessionMode;
  readonly runId: string;
  readonly nodeId: string;
  readonly executorModel: string;
  readonly executorThinking: string;
  readonly baseCommit: string;
  readonly continued: boolean;
  readonly experiment: boolean;
  readonly policyRole: WorkerPolicyRole;
}

export interface WorkerTerminalState {
  readonly continued?: boolean | undefined;
  readonly outcome?: "changed" | "no_change" | undefined;
  readonly baseCommit?: string | undefined;
  readonly revision?: string | undefined;
}

class WorkerHostError extends Data.TaggedError("WorkerHostError")<{
  readonly message: string;
  readonly operation: "exec" | "setModel";
}> {}
class WorkerGitError extends Data.TaggedError("WorkerGitError")<{ readonly message: string }> {}
type WorkerExpectedError = WorkerContractError | WorkerHostError | WorkerGitError;

export type WorkerExec = (
  cwd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;
export interface WorkerModelHost {
  selectModel(provider: string, model: string): Promise<"selected" | "missing" | "no_credentials">;
  setThinking(level: string): void;
}
type MessageSink = (message: {
  customType: string;
  content: string;
  display: false;
  details: object;
}) => void;

export const WorkerEnvironmentEffect = Effect.gen(function* () {
  const raw = yield* WorkerEnvironmentConfig.parse(ConfigProvider.fromEnv());
  const mode = yield* readMode(raw.mode);
  if (mode === null) return null;
  const experiment = raw.experiment === "1";
  const policyRole = yield* readPolicyRole(raw.policyRole, mode, experiment);
  return {
    mode,
    runId: raw.runId,
    nodeId: raw.nodeId,
    executorModel: raw.executorModel,
    executorThinking: raw.executorThinking,
    baseCommit: raw.baseCommit,
    continued: raw.implementationStart === "executor",
    experiment,
    policyRole,
  } satisfies WorkerEnvironment;
});

export class WorkerRuntime {
  private readonly identity: WorkerContextIdentity;
  private readonly plan: WorkerPlanState;
  private phase: WorkerPhase;
  private directEditSeen = false;
  private reminderCount = 0;
  private terminal = false;
  private cutoverFailure: string | undefined;
  private disabledTools = new Set<string>();

  constructor(
    private readonly environment: WorkerEnvironment,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Pi custom-entry data is the external persistence sink.
    private readonly appendEntry: (customType: string, data: unknown) => void,
  ) {
    this.identity = { runId: environment.runId, nodeId: environment.nodeId };
    this.phase =
      environment.mode === "implementation" && !environment.continued ? "guide" : "executor";
    this.plan = new WorkerPlanState(this.identity);
  }

  hasPlanTool(): boolean {
    return this.environment.mode === "implementation";
  }
  reportParameters() {
    return reportSchemaForMode(this.environment.mode);
  }
  executePlan(input: WorkerPlanToolInput) {
    return this.plan.execute(input);
  }

  restoreSession(branch: readonly WorkerEntry[], configuredDisabledTools: readonly string[]): void {
    this.disabledTools = new Set(configuredDisabledTools);
    this.plan.restore(branch);
    this.phase =
      this.environment.mode === "implementation" && !this.environment.continued
        ? "guide"
        : "executor";
    if (hasExecutorStart(branch, this.identity)) this.phase = "executor";
    this.cutoverFailure = executorFailure(branch, this.identity);
    this.directEditSeen = hasSuccessfulDirectEdit(branch, this.identity);
    this.reminderCount = branch.filter(
      (entry) =>
        entry.type === "custom_message" &&
        entry.customType === RECONCILIATION_MESSAGE_TYPE &&
        isWorkerIdentityData(entry.details, this.identity),
    ).length;
    this.terminal = this.hasTerminalReport(branch);
  }

  allowedTools(activeTools: readonly string[]): string[] {
    return activeTools.filter((name) => !this.isToolDisabled(name));
  }

  isToolDisabled(name: string): boolean {
    const readOnly =
      this.environment.mode !== "implementation" &&
      !(this.environment.mode === "research" && this.environment.experiment);
    const cutoverBlocked =
      this.cutoverFailure !== undefined && (name === "edit" || name === "write");
    return (
      this.disabledTools.has(name) ||
      cutoverBlocked ||
      (readOnly && (name === "edit" || name === "write"))
    );
  }

  observeToolExecution(
    input: { readonly toolName: string; readonly isError: boolean },
    host: WorkerModelHost,
  ) {
    const self = this;
    return Effect.gen(function* () {
      if (
        self.environment.mode !== "implementation" ||
        self.phase !== "guide" ||
        self.cutoverFailure !== undefined
      )
        return undefined;
      if (!input.isError && (input.toolName === "edit" || input.toolName === "write"))
        self.directEditSeen = true;
      if (!self.directEditSeen || self.plan.todos === undefined) return undefined;
      yield* selectExecutor(self.environment, host);
      yield* Effect.try({
        try: () => self.appendEntry(EXECUTOR_START_ENTRY, self.identity),
        catch: () =>
          new WorkerHostError({
            operation: "setModel",
            message: "Pi could not persist executor start.",
          }),
      });
      self.phase = "executor";
      return undefined;
    }).pipe(
      Effect.catch((error: WorkerExpectedError) =>
        Effect.sync(() => {
          self.cutoverFailure = error.message;
          return executorFailureMessage(self.identity, error.message);
        }),
      ),
    );
  }

  hasExecutorMessage(entries: readonly WorkerEntry[]): boolean {
    const boundary = entries.findIndex(
      (entry) =>
        entry.type === "custom" &&
        (this.environment.continued
          ? entry.customType === "pi-workgraph-agent-running"
          : entry.customType === EXECUTOR_START_ENTRY) &&
        isWorkerIdentityData(entry.data, this.identity),
    );
    return (
      boundary >= 0 &&
      entries
        .slice(boundary + 1)
        .some(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "assistant" &&
            `${entry.message.provider}/${entry.message.model}` === this.environment.executorModel &&
            !["error", "aborted", "pending"].includes(entry.message.stopReason ?? ""),
        )
    );
  }

  private scheduleReconciliation(send: MessageSink): boolean {
    if (
      this.environment.mode !== "implementation" ||
      this.phase !== "executor" ||
      this.terminal ||
      !this.plan.hasActionableItems() ||
      this.reminderCount >= MAX_PLAN_REMINDERS
    )
      return false;
    this.reminderCount += 1;
    send({
      customType: RECONCILIATION_MESSAGE_TYPE,
      content: `[WORKGRAPH TODO SETTLE REMINDER ${this.reminderCount}/${MAX_PLAN_REMINDERS}]\nThe executor settled without a terminal report while the TODO remains actionable. Continue useful work or report truthfully; TODO status is not a completion gate.`,
      display: false,
      details: this.identity,
    });
    return true;
  }

  recordEffectiveModel(model: string, thinking: string): void {
    this.appendEntry("pi-workgraph-effective-model", { ...this.identity, model, thinking });
  }

  recordAgentStarted(model: string | undefined, thinking: string): void {
    if (model !== undefined) this.recordEffectiveModel(model, thinking);
    this.appendEntry("pi-workgraph-agent-running", {
      ...this.identity,
      startedAt: DateTime.formatIso(DateTime.nowUnsafe()),
    });
  }

  settleAgent(send: MessageSink): void {
    if (this.scheduleReconciliation(send)) return;
    this.appendEntry("pi-workgraph-agent-settled", {
      ...this.identity,
      settledAt: DateTime.formatIso(DateTime.nowUnsafe()),
    });
  }

  workerContext(
    active: readonly SessionEntry[],
    branch: readonly WorkerEntry[],
    afterCompaction: boolean,
  ) {
    return {
      systemPolicy: workerSystemPolicy(this.environment.policyRole, this.phase),
      message: afterCompaction ? this.currentRecovery(active, branch) : undefined,
    };
  }

  // Provider payloads represent system instructions differently. Replace only the
  // package-owned exact policy string wherever that boundary serialized it.
  /* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof -- Provider payload traversal is the external provider-shape boundary. */
  rewriteProviderPayload(payload: unknown): unknown {
    if (this.environment.mode !== "implementation") return payload;
    const current = workerSystemPolicy(this.environment.policyRole, this.phase);
    const guide = workerSystemPolicy(this.environment.policyRole, "guide");
    const executor = workerSystemPolicy(this.environment.policyRole, "executor");
    const visit = (value: unknown): unknown => {
      if (typeof value === "string")
        return value.replace(guide, current).replace(executor, current);
      if (Array.isArray(value)) return value.map(visit);
      if (typeof value !== "object" || value === null) return value;
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    };
    return visit(payload);
  }
  /* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof */

  private currentRecovery(active: readonly SessionEntry[], branch: readonly WorkerEntry[]) {
    if (hasActiveRecovery(active, this.identity)) return undefined;
    const objective = this.latestAttemptObjective(branch);
    if (
      hasActiveObjective(active, this.identity) &&
      objective.kind === "valid" &&
      this.environment.mode !== "implementation"
    )
      return undefined;
    const recovery = {
      identity: this.identity,
      mode: this.environment.mode,
      phase: this.phase,
      objective,
      warnings: [this.cutoverFailure],
    };
    return this.environment.mode === "implementation"
      ? recoveryMessage({ ...recovery, planText: this.plan.text() })
      : recoveryMessage(recovery);
  }

  completeReport(
    cwd: string,
    params: WorkerReportInput,
    branch: readonly WorkerEntry[],
    exec: WorkerExec,
  ) {
    const self = this;
    return Effect.gen(function* () {
      if (!isWorkerReportInput(params) || params.kind !== self.environment.mode)
        return yield* contractFailure(`Report must satisfy the ${self.environment.mode} contract.`);
      if (params.kind !== "implementation" || params.status !== "completed")
        return terminalReport(params, self.terminalState());
      if (params.outcome === "no_change")
        return yield* self.noChangeImplementationReport(cwd, params, exec);
      return yield* self.changedImplementationReport(
        cwd,
        params,
        self.hasExecutorMessage(branch),
        exec,
      );
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          self.terminal = true;
        }),
      ),
    );
  }

  private noChangeImplementationReport(
    cwd: string,
    report: Extract<ImplementationReportInput, { outcome: "no_change" }>,
    exec: WorkerExec,
  ) {
    const self = this;
    return Effect.gen(function* () {
      if (self.environment.baseCommit.length === 0)
        return yield* contractFailure("PI_WORKGRAPH_BASE_COMMIT is required.");
      yield* requireCleanWorktree(exec, cwd, "No-change implementation requires a clean worktree:");
      const revision = yield* gitEffect(exec, cwd, ["rev-parse", "HEAD"]);
      if (report.revision !== revision || revision !== self.environment.baseCommit)
        return yield* contractFailure(
          `No-change implementation must report the unchanged base revision ${self.environment.baseCommit}.`,
        );
      return terminalReport(report, {
        continued: self.environment.continued,
        outcome: "no_change",
        baseCommit: self.environment.baseCommit,
        revision,
      });
    });
  }

  private changedImplementationReport(
    cwd: string,
    report: Extract<ImplementationReportInput, { outcome: "changed" }>,
    hasExecutorMessage: boolean,
    exec: WorkerExec,
  ) {
    const self = this;
    return Effect.gen(function* () {
      if (self.phase !== "executor")
        return yield* contractFailure(
          "Completed changed implementation requires guide-to-executor cutover.",
        );
      if (!hasExecutorMessage)
        return yield* contractFailure(
          "Completed changed implementation requires an actual executor assistant message after this attempt's executor start.",
        );
      if (self.environment.baseCommit.length === 0)
        return yield* contractFailure("PI_WORKGRAPH_BASE_COMMIT is required.");
      const provenance = yield* changedCommitProvenance(exec, cwd, self.environment.baseCommit);
      return terminalReport({ ...report, ...provenance }, self.terminalState());
    });
  }

  private terminalState(): WorkerTerminalState {
    return { continued: this.environment.continued };
  }

  private latestAttemptObjective(entries: readonly WorkerEntry[]): WorkerObjectiveRestore {
    for (const entry of [...entries].reverse()) {
      if (
        entry.type !== "custom_message" ||
        entry.customType !== "pi-workgraph-objective" ||
        !isWorkerIdentityData(entry.details, this.identity)
      )
        continue;
      if (!Value.Check(ObjectiveContentSchema, entry.content)) return { kind: "malformed" };
      return { kind: "valid", content: Value.Decode(ObjectiveContentSchema, entry.content) };
    }
    return { kind: "absent" };
  }

  private hasTerminalReport(entries: readonly WorkerEntry[]): boolean {
    const boundary = entries.findLastIndex(
      (entry) =>
        entry.type === "custom_message" &&
        entry.customType === "pi-workgraph-objective" &&
        isWorkerIdentityData(entry.details, this.identity),
    );
    if (boundary < 0) return false;
    return entries.slice(boundary + 1).some((entry) => {
      if (
        entry.type !== "message" ||
        entry.message.role !== "toolResult" ||
        entry.message.toolName !== "workgraph_report" ||
        entry.message.isError === true
      )
        return false;
      return (
        Value.Check(ReportToolDetailsSchema, entry.message.details) &&
        isWorkerReport(Value.Decode(ReportToolDetailsSchema, entry.message.details).report)
      );
    });
  }
}

function hasSuccessfulDirectEdit(
  entries: readonly WorkerEntry[],
  identity: WorkerContextIdentity,
): boolean {
  const objective = entries.findLastIndex(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === "pi-workgraph-objective" &&
      isWorkerIdentityData(entry.details, identity),
  );
  return entries
    .slice(objective + 1)
    .some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        (entry.message.toolName === "edit" || entry.message.toolName === "write") &&
        entry.message.isError !== true,
    );
}

function selectExecutor(environment: WorkerEnvironment, host: WorkerModelHost) {
  return Effect.gen(function* () {
    const slash = environment.executorModel.indexOf("/");
    if (slash <= 0)
      return yield* contractFailure(`Invalid executor model: ${environment.executorModel}`);
    if (!Value.Check(ThinkingSchema, environment.executorThinking))
      return yield* contractFailure(`Invalid executor thinking: ${environment.executorThinking}`);
    const selected = yield* Effect.tryPromise({
      try: () =>
        host.selectModel(
          environment.executorModel.slice(0, slash),
          environment.executorModel.slice(slash + 1),
        ),
      catch: () =>
        new WorkerHostError({
          operation: "setModel",
          message: `Pi could not select executor model: ${environment.executorModel}`,
        }),
    });
    if (selected !== "selected")
      return yield* contractFailure(
        selected === "missing"
          ? `Executor model is unavailable: ${environment.executorModel}`
          : `Executor model has no usable credentials: ${environment.executorModel}`,
      );
    yield* Effect.try({
      try: () => host.setThinking(environment.executorThinking),
      catch: () =>
        new WorkerHostError({
          operation: "setModel",
          message: `Pi could not select executor thinking: ${environment.executorThinking}`,
        }),
    });
  });
}

function terminalReport(report: WorkerReport, state: WorkerTerminalState) {
  return {
    content: [
      { type: "text" as const, text: `${report.kind} ${report.status}: ${report.summary}` },
    ],
    details: { report, state },
    terminate: true,
  };
}

function changedCommitProvenance(exec: WorkerExec, cwd: string, baseCommit: string) {
  return Effect.gen(function* () {
    yield* requireCleanWorktree(exec, cwd, "Commit and leave a clean worktree before reporting:");
    const [commit, parent, ...extraParents] = (yield* gitEffect(exec, cwd, [
      "rev-list",
      "--parents",
      "-n",
      "1",
      "HEAD",
    ])).split(" ");
    if (
      commit === undefined ||
      commit.length === 0 ||
      parent !== baseCommit ||
      extraParents.length > 0
    )
      return yield* contractFailure(
        "A completed changed implementation requires exactly one direct commit on the supplied base.",
      );
    const changedText = yield* gitEffect(
      exec,
      cwd,
      ["diff", "--name-only", "--no-renames", baseCommit, commit],
      true,
    );
    return {
      commit,
      changedFiles: changedText
        .split("\n")
        .filter((path) => path.length > 0)
        .sort(),
    };
  });
}

function requireCleanWorktree(exec: WorkerExec, cwd: string, errorPrefix: string) {
  return Effect.gen(function* () {
    const status = yield* gitEffect(
      exec,
      cwd,
      ["status", "--porcelain", "--untracked-files=all"],
      true,
    );
    if (status.length > 0) return yield* contractFailure(`${errorPrefix}\n${status}`);
  });
}

function gitEffect(exec: WorkerExec, cwd: string, args: string[], allowEmpty = false) {
  return Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () => exec(cwd, args),
      catch: () =>
        new WorkerHostError({
          operation: "exec",
          message: `Pi could not execute git ${args.join(" ")}.`,
        }),
    });
    if (result.code !== 0)
      return yield* new WorkerGitError({
        message: `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
      });
    const output = result.stdout.trim();
    if (!allowEmpty && output.length === 0)
      return yield* new WorkerGitError({ message: `git ${args.join(" ")} returned no output.` });
    return output;
  });
}

function contractFailure(message: string) {
  return Effect.fail(new WorkerContractError({ message }));
}

function readPolicyRole(value: string, mode: WorkerSessionMode, experiment: boolean) {
  const defaultRole: WorkerPolicyRole = mode === "research" && experiment ? "experiment" : mode;
  const role = value.length === 0 ? defaultRole : value;
  if (role === defaultRole || (role === "consultation" && mode === "research" && !experiment))
    return Effect.succeed<WorkerPolicyRole>(role);
  return contractFailure(`Invalid PI_WORKGRAPH_POLICY_ROLE ${value} for worker mode ${mode}`);
}

function readMode(value: string) {
  if (value.length === 0) return Effect.succeed<WorkerSessionMode | null>(null);
  if (value === "research" || value === "review" || value === "implementation")
    return Effect.succeed<WorkerSessionMode | null>(value);
  return contractFailure(`Invalid PI_WORKGRAPH_MODE: ${value}`);
}
