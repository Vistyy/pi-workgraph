/* oxlint-disable typescript/no-this-alias -- Effect generators retain the runtime owner while yielding host and contract failures. */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Config, ConfigProvider, Data, DateTime, Effect } from "effect";
import { type Static, Type } from "typebox";
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
  hasActiveObjective,
  hasActivePhase,
  hasActiveRecovery,
  isWorkerIdentityData,
  phaseActivationMessage,
  recoveryMessage,
  type WorkerContextIdentity,
  type WorkerObjectiveRestore,
  type WorkerPolicyRole,
  workerSystemPolicy,
} from "./worker-context.js";
import {
  type PlanRestoreKind,
  WorkerContractError,
  type WorkerPlan,
  WorkerPlanState,
  type WorkerPlanToolInput,
} from "./worker-plan.js";

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
const AttemptStateSchema = Type.Object({
  runId: Type.String(),
  nodeId: Type.String(),
  phase: Type.Optional(Type.Union([Type.Literal("guide"), Type.Literal("executor")])),
  reminderCount: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_PLAN_REMINDERS })),
  switchedAt: Type.Optional(Type.String()),
  switchError: Type.Optional(Type.String()),
});
type AttemptState = Static<typeof AttemptStateSchema>;

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
  readonly plan?: WorkerPlan | undefined;
  readonly planStatus: PlanRestoreKind;
  readonly reminderCount: number;
  readonly switchedAt?: string | undefined;
  readonly switchError?: string | undefined;
  readonly continued?: boolean | undefined;
  readonly outcome?: "changed" | "no_change" | undefined;
  readonly baseCommit?: string | undefined;
  readonly revision?: string | undefined;
}

class WorkerHostError extends Data.TaggedError("WorkerHostError")<{
  readonly message: string;
  readonly operation: "exec" | "setModel";
}> {}
class WorkerGitError extends Data.TaggedError("WorkerGitError")<{
  readonly message: string;
}> {}
type WorkerExpectedError = WorkerContractError | WorkerHostError | WorkerGitError;

export type WorkerExec = (
  cwd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;
export interface WorkerModelHost {
  selectModel(provider: string, model: string): Promise<"selected" | "missing" | "no_credentials">;
  setThinking(level: string): void;
}
type ReconciliationSink = (message: {
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
  private readonly systemPolicy: string;
  private readonly plan: WorkerPlanState;
  private phase: "guide" | "executor";
  private reminderCount = 0;
  private terminal = false;
  private switchError: string | undefined;
  private switchedAt: string | undefined;
  private stateWarning: string | undefined;
  private disabledTools = new Set<string>();

  constructor(
    private readonly environment: WorkerEnvironment,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Pi owns the custom-entry sink; runtime methods supply schema-owned records.
    private readonly appendEntry: (customType: string, data: unknown) => void,
  ) {
    this.identity = { runId: environment.runId, nodeId: environment.nodeId };
    this.systemPolicy = workerSystemPolicy(environment.policyRole);
    this.phase =
      environment.mode === "implementation" && !environment.continued ? "guide" : "executor";
    this.plan = new WorkerPlanState(this.identity, appendEntry);
  }

  hasPlanTool(): boolean {
    return this.environment.mode === "implementation";
  }

  reportParameters() {
    return reportSchemaForMode(this.environment.mode);
  }

  executePlan(input: WorkerPlanToolInput) {
    return this.plan.execute(input, this.phase);
  }

  restoreSession(branch: readonly WorkerEntry[], configuredDisabledTools: readonly string[]): void {
    this.disabledTools = new Set(configuredDisabledTools);
    this.phase =
      this.environment.mode === "implementation" && !this.environment.continued
        ? "guide"
        : "executor";
    this.reminderCount = 0;
    this.switchError = undefined;
    this.switchedAt = undefined;
    this.terminal = this.hasTerminalReport(branch);
    const attempt = this.latestAttemptState(branch);
    this.stateWarning = attempt.malformed
      ? "The latest current-attempt worker state was malformed and was ignored; continue conservatively and report the limitation."
      : undefined;
    if (attempt.state !== undefined) this.reattachAttemptState(attempt.state);
    this.plan.restore(branch);
  }

  allowedTools(activeTools: readonly string[]): string[] {
    return activeTools.filter((name) => !this.isToolDisabled(name));
  }

  isToolDisabled(name: string): boolean {
    // Keep editing tools for implementation and authorized research experiments.
    // This filters model tool availability; bash remains available and is not sandboxed.
    const readOnly =
      this.environment.mode !== "implementation" &&
      !(this.environment.mode === "research" && this.environment.experiment);
    return this.disabledTools.has(name) || (readOnly && (name === "edit" || name === "write"));
  }

  observeToolExecution(
    input: {
      readonly toolName: string;
      readonly isError: boolean;
      readonly cwd: string;
      readonly active: readonly SessionEntry[];
    },
    host: WorkerModelHost,
    exec: WorkerExec,
  ) {
    const self = this;
    return Effect.gen(function* () {
      if (self.environment.mode !== "implementation" || self.phase !== "guide") return undefined;
      const directEdit =
        !input.isError && (input.toolName === "edit" || input.toolName === "write");
      if (!directEdit) {
        if (self.environment.baseCommit.length === 0) return undefined;
        const status = yield* gitEffect(
          exec,
          input.cwd,
          ["status", "--porcelain", "--untracked-files=all"],
          true,
        );
        if (
          status.length === 0 &&
          (yield* gitEffect(exec, input.cwd, ["rev-parse", "HEAD"])) === self.environment.baseCommit
        )
          return undefined;
      }
      yield* selectExecutor(self.environment, host);
      self.phase = "executor";
      self.switchError = undefined;
      self.switchedAt = DateTime.formatIso(yield* DateTime.now);
      self.appendWorkerState();
      return self.currentPhaseActivation(input.active);
    }).pipe(
      Effect.catch((error: WorkerExpectedError) =>
        Effect.sync(() => {
          self.switchError = error.message;
          self.appendWorkerState();
          return undefined;
        }),
      ),
    );
  }

  private appendWorkerState(): void {
    const state: AttemptState = {
      ...this.identity,
      phase: this.phase,
      reminderCount: this.reminderCount,
    };
    if (this.switchedAt !== undefined) state.switchedAt = this.switchedAt;
    if (this.switchError !== undefined) state.switchError = this.switchError;
    this.appendEntry("pi-workgraph-worker-state", state);
  }

  // Session order, not model selection or wall-clock time, proves a later generation.
  // Pi drains the current assistant message before tool preflight/execution.
  hasExecutorMessage(entries: readonly WorkerEntry[]): boolean {
    const boundary = entries.findIndex((entry) => {
      if (entry.type !== "custom") return false;
      const data = this.decodeAttemptState(entry.data);
      if (data === undefined || !this.isCurrentAttemptData(data)) return false;
      return this.environment.continued
        ? entry.customType === "pi-workgraph-agent-running"
        : entry.customType === "pi-workgraph-worker-state" &&
            data.phase === "executor" &&
            data.switchedAt !== undefined;
    });
    return (
      boundary >= 0 &&
      entries.slice(boundary + 1).some((entry) => {
        if (entry.type !== "message") return false;
        const message = entry.message;
        return (
          message.role === "assistant" &&
          `${message.provider}/${message.model}` === this.environment.executorModel &&
          !["error", "aborted", "pending"].includes(message.stopReason ?? "")
        );
      })
    );
  }

  private scheduleReconciliation(send: ReconciliationSink): boolean {
    if (
      this.environment.mode !== "implementation" ||
      this.phase !== "executor" ||
      this.terminal ||
      !this.plan.hasActionableSteps() ||
      this.reminderCount >= MAX_PLAN_REMINDERS
    )
      return false;
    this.reminderCount += 1;
    this.appendWorkerState();
    send({
      customType: RECONCILIATION_MESSAGE_TYPE,
      content: [
        `[WORKGRAPH RECONCILIATION REMINDER ${this.reminderCount}/${MAX_PLAN_REMINDERS}]`,
        "The executor settled without a terminal report while the current plan still has actionable steps.",
        "Inspect the worktree and current-attempt snapshot, then continue useful work or report truthful failure or escalation. Do not treat plan status as evidence or a completion gate.",
      ].join("\n"),
      display: false,
      details: { ...this.identity, reminderCount: this.reminderCount },
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

  settleAgent(send: ReconciliationSink): void {
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
    const recovery = this.currentRecovery(active, branch, afterCompaction);
    return {
      systemPolicy: this.systemPolicy,
      message: afterCompaction ? recovery : (recovery ?? this.currentPhaseActivation(active)),
    };
  }

  private currentRecovery(
    active: readonly SessionEntry[],
    branch: readonly WorkerEntry[],
    restorePlan: boolean,
  ) {
    if (hasActiveRecovery(active, this.identity, this.phase)) return undefined;
    const objective = this.latestAttemptObjective(branch);
    const needsObjective = !hasActiveObjective(active, this.identity) || objective.kind !== "valid";
    const hasWarning = this.plan.warning !== undefined || this.stateWarning !== undefined;
    if (!restorePlan && !needsObjective && !hasWarning) return undefined;
    const recovery = {
      identity: this.identity,
      mode: this.environment.mode,
      phase: this.phase,
      objective,
      warnings: [this.plan.warning, this.stateWarning],
    };
    return this.environment.mode === "implementation"
      ? recoveryMessage({ ...recovery, planText: this.plan.text(this.phase) })
      : recoveryMessage(recovery);
  }

  private currentPhaseActivation(active: readonly SessionEntry[]) {
    if (this.environment.mode !== "implementation") return undefined;
    return hasActivePhase(active, this.identity, this.phase)
      ? undefined
      : phaseActivationMessage(this.identity, this.phase);
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
      if (params.kind !== "implementation" || params.status !== "completed") {
        // Read-only is an instruction and authority boundary, not a filesystem sandbox.
        // Shared research and non-revision review deliberately observe the live project cwd,
        // including tracked and untracked local changes. Exact-revision review is launched in
        // an owned worktree at its requested SHA; do not confuse either cwd with another revision.
        return terminalReport(params, self.terminalState());
      }
      if (params.outcome === "no_change")
        return yield* self.noChangeImplementationReport(cwd, params, exec);
      return yield* self.changedImplementationReport(
        cwd,
        params,
        self.hasExecutorMessage(branch),
        exec,
      );
    }).pipe(Effect.tap(() => Effect.sync(() => (self.terminal = true))));
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
        plan: self.plan.plan,
        planStatus: self.plan.status,
        reminderCount: self.reminderCount,
        switchedAt: self.switchedAt,
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
          "Completed changed implementation requires the first-edit model transition.",
        );
      if (self.switchError !== undefined)
        return yield* contractFailure(`Executor model transition failed: ${self.switchError}`);
      if (!hasExecutorMessage)
        return yield* contractFailure(
          "Completed changed implementation requires an actual executor assistant message after this attempt's transition/start. Continue with the executor before reporting.",
        );
      if (self.environment.baseCommit.length === 0)
        return yield* contractFailure("PI_WORKGRAPH_BASE_COMMIT is required.");
      const provenance = yield* changedCommitProvenance(exec, cwd, self.environment.baseCommit);
      return terminalReport(
        { ...report, ...provenance },
        {
          plan: self.plan.plan,
          planStatus: self.plan.status,
          reminderCount: self.reminderCount,
          switchedAt: self.switchedAt,
          continued: self.environment.continued,
          outcome: "changed",
        },
      );
    });
  }

  private terminalState(): WorkerTerminalState {
    return {
      plan: this.plan.plan,
      planStatus: this.plan.status,
      reminderCount: this.reminderCount,
      switchedAt: this.switchedAt,
      switchError: this.switchError,
    };
  }

  private latestAttemptState(
    entries: readonly WorkerEntry[],
  ):
    | { readonly state: AttemptState; readonly malformed: false }
    | { readonly state: undefined; readonly malformed: boolean } {
    for (const entry of [...entries].reverse()) {
      if (entry.type !== "custom" || entry.customType !== "pi-workgraph-worker-state") continue;
      if (!this.isCurrentAttemptData(entry.data)) continue;
      const attempt = this.decodeAttemptState(entry.data);
      return attempt === undefined
        ? { state: undefined, malformed: true }
        : { state: attempt, malformed: false };
    }
    return { state: undefined, malformed: false };
  }

  private latestAttemptObjective(entries: readonly WorkerEntry[]): WorkerObjectiveRestore {
    for (const entry of [...entries].reverse()) {
      if (entry.type !== "custom_message" || entry.customType !== "pi-workgraph-objective")
        continue;
      if (!this.isCurrentAttemptData(entry.details)) continue;
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
        this.isCurrentAttemptData(entry.details),
    );
    if (boundary < 0) return false;
    return entries.slice(boundary + 1).some((entry) => {
      if (entry.type !== "message") return false;
      const message = entry.message;
      if (message.role !== "toolResult") return false;
      if (message.toolName !== "workgraph_report" || message.isError === true) return false;
      if (!Value.Check(ReportToolDetailsSchema, message.details)) return false;
      return isWorkerReport(Value.Decode(ReportToolDetailsSchema, message.details).report);
    });
  }

  private reattachAttemptState(attempt: AttemptState): void {
    if (attempt.reminderCount !== undefined) this.reminderCount = attempt.reminderCount;
    if (attempt.switchedAt !== undefined) this.switchedAt = attempt.switchedAt;
    if (attempt.phase === "executor") this.phase = "executor";
    if (attempt.switchError !== undefined) this.switchError = attempt.switchError;
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The strict attempt-state schema decodes this Pi session boundary.
  private decodeAttemptState(data: unknown): AttemptState | undefined {
    return Value.Check(AttemptStateSchema, data)
      ? Value.Decode(AttemptStateSchema, data)
      : undefined;
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Shared strict identity decoding owns this Pi session boundary.
  private isCurrentAttemptData(data: unknown): boolean {
    return isWorkerIdentityData(data, this.identity);
  }
}

function selectExecutor(environment: WorkerEnvironment, host: WorkerModelHost) {
  return Effect.gen(function* () {
    const slash = environment.executorModel.indexOf("/");
    if (slash <= 0)
      return yield* contractFailure(`Invalid executor model: ${environment.executorModel}`);
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
    if (!Value.Check(ThinkingSchema, environment.executorThinking))
      return yield* contractFailure(`Invalid executor thinking: ${environment.executorThinking}`);
    host.setThinking(environment.executorThinking);
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
      return yield* new WorkerGitError({
        message: `git ${args.join(" ")} returned no output.`,
      });
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
