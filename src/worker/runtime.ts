import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Data, Effect, Result } from "effect";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  isWorkerReportInput,
  reportSchemaForMode,
  type WorkerReportInput,
  type WorkerSessionMode,
} from "../domain/report.js";
import {
  EXECUTOR_FAILURE_MESSAGE,
  EXECUTOR_START_ENTRY,
  readWorkerAssignment,
  type WorkerAssignment,
  type WorkerPhase,
  workerSystemPolicy,
} from "./context.js";
import {
  contractFailure,
  type WorkerContractError,
  WorkerPlanState,
  type WorkerPlanToolInput,
} from "./plan.js";
import type { WorkerRole } from "./session.js";

const MAX_PLAN_REMINDERS = 2;
const NON_SUCCESS_STOP_REASONS = new Set(["error", "aborted", "pending"]);
const REMINDER = "pi-workgraph-todo-reminder";
const MODEL_MARKER = "pi-workgraph-effective-model";
const SETTLED_MARKER = "pi-workgraph-agent-settled";
const ActualModelSchema = Type.Object(
  {
    model: Type.String({ minLength: 1 }),
    thinking: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

type WorkerEntry = SessionEntry;
type ContextMessage = {
  readonly role: string;
  readonly provider?: string;
  readonly model?: string;
  readonly stopReason?: string;
};
export interface WorkerModelHost {
  current(): { readonly model: string; readonly thinking: string } | undefined;
  selectModel(provider: string, model: string): Promise<"selected" | "missing" | "no_credentials">;
  setThinking(level: string): void;
}
type MessageSink = (message: {
  customType: string;
  content: string;
  display: false;
  details: object;
}) => void;

class WorkerHostError extends Data.TaggedError("WorkerHostError")<{ readonly message: string }> {}

export function configuredWorkerRole(
  value: string | undefined,
): Result.Result<WorkerRole | null, string> {
  if (value === undefined || value === "") return Result.succeed(null);
  if (
    value === "research" ||
    value === "experiment" ||
    value === "consultation" ||
    value === "review" ||
    value === "implementation"
  )
    return Result.succeed(value);
  return Result.fail(`Invalid PI_WORKGRAPH_ROLE: ${bounded(value)}`);
}

export class WorkerRuntime {
  private assignment: WorkerAssignment | undefined;
  private plan: WorkerPlanState | undefined;
  private phase: WorkerPhase = "guide";
  private directEditSeen = false;
  private executorMarkerSeen = false;
  private cutoverFailed = false;
  private settingsError: string | undefined;
  private disabledTools = new Set<string>();

  constructor(
    readonly role: WorkerRole,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Pi's custom-entry sink owns final serialization of each schema-checked marker.
    private readonly appendEntry: (customType: string, data: unknown) => void,
  ) {}

  restoreSession(
    branch: readonly WorkerEntry[],
    configuredDisabledTools: readonly string[],
  ): Result.Result<void, string> {
    const assignment = readWorkerAssignment(branch, this.role);
    if (Result.isFailure(assignment)) return Result.fail(assignment.failure);
    const protectedNames = new Set(["workgraph_report", "workgraph_plan"]);
    const invalid = configuredDisabledTools.find((name) => protectedNames.has(name));
    if (invalid !== undefined)
      return Result.fail(`Worker setting cannot disable protected tool ${invalid}.`);
    this.assignment = assignment.success;
    this.plan = new WorkerPlanState();
    const scoped = this.attemptBranch(branch);
    this.plan.restore(scoped);
    this.directEditSeen = hasSuccessfulDirectEdit(scoped);
    this.executorMarkerSeen = hasEntry(scoped, "custom", EXECUTOR_START_ENTRY);
    this.phase = this.executorMarkerSeen ? "executor" : "guide";
    this.cutoverFailed = hasEntry(scoped, "custom_message", EXECUTOR_FAILURE_MESSAGE);
    this.disabledTools = new Set(configuredDisabledTools);
    return Result.succeed(undefined);
  }

  failClosed(branch: readonly WorkerEntry[], diagnostic: string): void {
    this.settingsError = bounded(diagnostic);
    this.disabledTools.clear();
    if (this.assignment === undefined) {
      const assignment = readWorkerAssignment(branch, this.role);
      if (Result.isSuccess(assignment)) {
        this.assignment = assignment.success;
        this.plan = new WorkerPlanState();
        this.plan.restore(this.attemptBranch(branch));
      }
    }
  }

  hasPlanTool(): boolean {
    return this.role === "implementation";
  }
  reportParameters() {
    return reportSchemaForMode(reportMode(this.role));
  }
  executePlan(input: WorkerPlanToolInput) {
    if (this.settingsError !== undefined)
      return contractFailure("Worker settings are unreadable; only a failed report is permitted.");
    if (this.plan === undefined)
      return contractFailure("Authoritative Worker objective is unavailable.");
    return this.plan.execute(input);
  }

  isToolDisabled(name: string): boolean {
    if (name === "workgraph_report") return false;
    if (this.settingsError !== undefined) return true;
    if (name === "workgraph_plan") return this.role !== "implementation";
    if (this.disabledTools.has(name)) return true;
    if (name === "edit" || name === "write") {
      if (this.cutoverFailed) return true;
      return this.role !== "implementation" && this.role !== "experiment";
    }
    return false;
  }
  allowedTools(activeTools: readonly string[]): string[] {
    return activeTools.filter((name) => !this.isToolDisabled(name));
  }

  observeToolExecution(
    input: { readonly toolName: string; readonly isError: boolean },
    host: WorkerModelHost,
  ) {
    if (!input.isError && (input.toolName === "edit" || input.toolName === "write"))
      this.directEditSeen = true;
    return this.liveCutover(host);
  }

  recoverModel(branch: readonly WorkerEntry[], host: WorkerModelHost) {
    // Effect generators retain the runtime owner while yielding host failures.
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this;
    return Effect.gen(function* () {
      if (self.role !== "implementation" || self.assignment === undefined) return undefined;
      const executor = self.assignment.details.executor;
      if (executor === undefined) return undefined;
      const evidence = self.directEditSeen && self.plan?.todos !== undefined;
      const exactExecutor = selected(host, executor.model, executor.thinking);
      if (!self.cutoverFailed && exactExecutor && evidence) {
        self.promoteExecutor();
        return undefined;
      }
      self.phase = "guide";
      const guide = firstActualModel(self.attemptBranch(branch));
      if (guide !== undefined && !selected(host, guide.model, guide.thinking))
        yield* selectTarget(guide.model, guide.thinking, host);
      return undefined;
    }).pipe(
      Effect.catch((error: WorkerHostError | WorkerContractError) =>
        Effect.succeed(self.selectionFailure(error.message)),
      ),
    );
  }

  private liveCutover(host: WorkerModelHost) {
    // Effect generators retain the runtime owner while yielding host failures.
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this;
    return Effect.gen(function* () {
      if (
        self.role !== "implementation" ||
        self.phase !== "guide" ||
        self.cutoverFailed ||
        self.settingsError !== undefined ||
        !self.directEditSeen ||
        self.plan?.todos === undefined ||
        self.assignment?.details.executor === undefined
      )
        return undefined;
      const guide = host.current();
      if (guide === undefined)
        return self.selectionFailure("Pi has no current guide model to preserve.");
      const failure = yield* selectWithRestore(self.assignment.details.executor, guide, host);
      if (failure !== undefined) return self.selectionFailure(failure);
      self.promoteExecutor();
      return undefined;
    });
  }

  private promoteExecutor(): void {
    if (!this.executorMarkerSeen) {
      this.appendEntry(EXECUTOR_START_ENTRY, {});
      this.executorMarkerSeen = true;
    }
    this.phase = "executor";
  }

  private selectionFailure(message: string) {
    if (this.cutoverFailed) return undefined;
    this.cutoverFailed = true;
    return {
      customType: EXECUTOR_FAILURE_MESSAGE,
      content: `[WORKGRAPH EXECUTOR SELECTION FAILED]\n${bounded(message)}\nRemain on the guide, do not make further direct edits or retry selection automatically, and report failed unless a decision or authority is genuinely missing.`,
      display: false as const,
      details: {},
    };
  }

  recordAgentStarted(model: string | undefined, thinking: string): void {
    if (model !== undefined) this.appendEntry(MODEL_MARKER, { model, thinking });
  }
  settleAgent(branch: readonly WorkerEntry[], send: MessageSink): void {
    const scoped = this.attemptBranch(branch);
    if (hasEntry(scoped, "custom", SETTLED_MARKER) || this.scheduleReminder(scoped, send)) return;
    this.appendEntry(SETTLED_MARKER, {});
  }
  systemPolicy(): string {
    return workerSystemPolicy(this.role, this.phase);
  }
  completionChecklist(messages: readonly ContextMessage[]): string | undefined {
    const executor = this.assignment?.details.executor;
    if (this.phase !== "executor" || executor === undefined) return undefined;
    const hasExecutorAssistant = messages.some((message) =>
      isSuccessfulExecutorAssistant(message, executor.model),
    );
    return hasExecutorAssistant
      ? undefined
      : "[WORKGRAPH EXECUTOR COMPLETION CHECKLIST]\nBefore reporting, confirm the claimed behavior, exact scope, and material limitations.";
  }
  compactionRecovery(active: readonly WorkerEntry[]) {
    const assignment = this.assignment;
    if (assignment === undefined) return undefined;
    const visible = active.some(
      (entry) =>
        entry.type === "custom_message" &&
        (entry.customType === "pi-workgraph-objective" ||
          entry.customType === "pi-workgraph-compaction-recovery"),
    );
    if (visible) return undefined;
    return {
      customType: "pi-workgraph-compaction-recovery",
      content: ["[WORKGRAPH COMPACTION RECOVERY]", assignment.content, this.plan?.text()]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
      display: false as const,
      details: {},
    };
  }

  completeReport(params: WorkerReportInput, branch: readonly WorkerEntry[]) {
    const mode = reportMode(this.role);
    if (!isWorkerReportInput(params) || params.kind !== mode)
      return contractFailure(`Report must satisfy the ${mode} contract.`);
    if (this.settingsError !== undefined && params.status !== "failed")
      return contractFailure("Unreadable Worker settings permit only a truthful failed report.");
    if (
      params.kind === "implementation" &&
      params.status === "completed" &&
      params.outcome === "changed"
    ) {
      const scoped = this.attemptBranch(branch);
      if (this.phase !== "executor" || !hasEntry(scoped, "custom", EXECUTOR_START_ENTRY))
        return contractFailure("Changed implementation requires guide-to-executor cutover.");
      if (!hasLaterExecutorAssistant(scoped, this.assignment?.details.executor))
        return contractFailure(
          "Changed implementation requires a later successful executor assistant message.",
        );
    }
    return Effect.succeed({
      content: [
        { type: "text" as const, text: `${params.kind} ${params.status}: ${params.summary}` },
      ],
      details: { report: params },
      terminate: true,
    });
  }

  diagnostic(): string | undefined {
    return this.settingsError;
  }

  private scheduleReminder(scoped: readonly WorkerEntry[], send: MessageSink): boolean {
    if (
      this.role !== "implementation" ||
      this.phase !== "executor" ||
      this.plan?.hasActionableItems() !== true ||
      hasTerminalReport(scoped)
    )
      return false;
    const count = scoped.filter(
      (entry) => entry.type === "custom_message" && entry.customType === REMINDER,
    ).length;
    if (count >= MAX_PLAN_REMINDERS) return false;
    send({
      customType: REMINDER,
      content: `[WORKGRAPH TODO SETTLE REMINDER ${count + 1}/${MAX_PLAN_REMINDERS}]\nThe executor settled without a report while TODO items remain actionable. Continue useful work or report truthfully; TODO status is not a completion gate.`,
      display: false,
      details: {},
    });
    return true;
  }

  private attemptBranch(entries: readonly WorkerEntry[]): WorkerEntry[] {
    if (this.assignment === undefined) return [];
    const start = entries.findIndex(
      (entry) => entry.type === "custom_message" && entry.customType === "pi-workgraph-objective",
    );
    return start < 0 ? [] : entries.slice(start);
  }
}

function reportMode(role: WorkerRole): WorkerSessionMode {
  return role === "review" ? "review" : role === "implementation" ? "implementation" : "research";
}
function hasEntry(
  entries: readonly WorkerEntry[],
  entryType: "custom" | "custom_message",
  customType: string,
): boolean {
  return entries.some((entry) => entry.type === entryType && entry.customType === customType);
}
function hasSuccessfulDirectEdit(entries: readonly WorkerEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      (entry.message.toolName === "edit" || entry.message.toolName === "write") &&
      entry.message.isError !== true,
  );
}
function hasTerminalReport(entries: readonly WorkerEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.toolName === "workgraph_report" &&
      entry.message.isError !== true,
  );
}
function isSuccessfulExecutorAssistant(message: ContextMessage, model: string): boolean {
  return (
    message.role === "assistant" &&
    `${message.provider}/${message.model}` === model &&
    !NON_SUCCESS_STOP_REASONS.has(message.stopReason ?? "")
  );
}
function hasLaterExecutorAssistant(
  entries: readonly WorkerEntry[],
  executor: { readonly model: string; readonly thinking: string } | undefined,
): boolean {
  if (executor === undefined || executor.model.indexOf("/") <= 0) return false;
  const boundary = entries.findIndex(
    (entry) => entry.type === "custom" && entry.customType === EXECUTOR_START_ENTRY,
  );
  if (boundary < 0) return false;
  return entries.some(
    (entry, index) =>
      index > boundary &&
      entry.type === "message" &&
      isSuccessfulExecutorAssistant(entry.message, executor.model),
  );
}
function firstActualModel(entries: readonly WorkerEntry[]) {
  for (const entry of entries) {
    if (
      entry.type === "custom" &&
      entry.customType === MODEL_MARKER &&
      Value.Check(ActualModelSchema, entry.data)
    ) {
      const value = Value.Decode(ActualModelSchema, entry.data);
      return { model: value.model, thinking: value.thinking };
    }
  }
  return undefined;
}
function selected(host: WorkerModelHost, model: string, thinking: string): boolean {
  const current = host.current();
  return current?.model === model && current.thinking === thinking;
}
function selectWithRestore(
  target: { readonly model: string; readonly thinking: string },
  guide: { readonly model: string; readonly thinking: string },
  host: WorkerModelHost,
) {
  return Effect.gen(function* () {
    const transition = yield* Effect.result(selectTarget(target.model, target.thinking, host));
    if (transition._tag === "Success") return undefined;
    const restoration = yield* Effect.result(selectTarget(guide.model, guide.thinking, host));
    return restoration._tag === "Success"
      ? transition.failure.message
      : `${transition.failure.message} Guide restoration also failed: ${restoration.failure.message}`;
  });
}
function selectTarget(
  model: string,
  thinking: string,
  host: WorkerModelHost,
): Effect.Effect<void, WorkerHostError | WorkerContractError> {
  const slash = model.indexOf("/");
  if (slash <= 0) return contractFailure(`Invalid Worker model: ${model}`);
  return Effect.gen(function* () {
    if (!selected(host, model, thinking)) {
      const result = yield* Effect.tryPromise({
        try: () => host.selectModel(model.slice(0, slash), model.slice(slash + 1)),
        catch: () => new WorkerHostError({ message: `Pi could not select model ${model}.` }),
      });
      if (result !== "selected")
        return yield* new WorkerHostError({
          message:
            result === "missing"
              ? `Worker model is unavailable: ${model}`
              : `Worker model has no usable credentials: ${model}`,
        });
      yield* Effect.try({
        try: () => host.setThinking(thinking),
        catch: () => new WorkerHostError({ message: `Pi could not select thinking ${thinking}.` }),
      });
    }
    if (!selected(host, model, thinking))
      return yield* new WorkerHostError({
        message: "Pi did not apply the exact model and clamped thinking target.",
      });
  });
}
function bounded(message: string): string {
  return message.replace(/\s+/g, " ").slice(0, 300);
}
