/* oxlint-disable typescript/no-this-alias -- Effect generators retain the runtime owner while yielding host failures. */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Data, Effect } from "effect";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  isWorkerReportInput,
  reportSchemaForMode,
  type WorkerReportInput,
  type WorkerSessionMode,
} from "./domain/report.js";
import type { WorkerRole } from "./pi-session.js";
import {
  EXECUTOR_FAILURE_MESSAGE,
  EXECUTOR_START_ENTRY,
  readWorkerAssignment,
  sameAttempt,
  type WorkerAssignment,
  type WorkerDecision,
  type WorkerPhase,
  workerSystemPolicy,
} from "./worker-context.js";
import { WorkerContractError, WorkerPlanState, type WorkerPlanToolInput } from "./worker-plan.js";

const MAX_PLAN_REMINDERS = 2;
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

export function configuredWorkerRole(value: string | undefined): WorkerDecision<WorkerRole | null> {
  if (value === undefined || value === "") return { ok: true, value: null };
  if (
    value === "research" ||
    value === "experiment" ||
    value === "consultation" ||
    value === "review" ||
    value === "implementation"
  )
    return { ok: true, value };
  return { ok: false, error: `Invalid PI_WORKGRAPH_ROLE: ${bounded(value)}` };
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
  ): WorkerDecision<void> {
    const assignment = readWorkerAssignment(branch, this.role);
    if (!assignment.ok) return assignment;
    const protectedNames = new Set(["workgraph_report", "workgraph_plan"]);
    const invalid = configuredDisabledTools.find((name) => protectedNames.has(name));
    if (invalid !== undefined)
      return {
        ok: false,
        error: `Worker setting cannot disable protected tool ${invalid}.`,
      };
    this.assignment = assignment.value;
    this.plan = new WorkerPlanState(identityOf(assignment.value.details));
    this.plan.restore(this.attemptBranch(branch));
    this.directEditSeen = hasSuccessfulDirectEdit(this.attemptBranch(branch));
    this.executorMarkerSeen = this.hasMarker(branch, EXECUTOR_START_ENTRY);
    this.phase = this.executorMarkerSeen ? "executor" : "guide";
    this.cutoverFailed = this.hasMessage(branch, EXECUTOR_FAILURE_MESSAGE);
    this.disabledTools = new Set(configuredDisabledTools);
    return { ok: true, value: undefined };
  }

  failClosed(branch: readonly WorkerEntry[], diagnostic: string): void {
    this.settingsError = bounded(diagnostic);
    this.disabledTools.clear();
    if (this.assignment === undefined) {
      const assignment = readWorkerAssignment(branch, this.role);
      if (assignment.ok) {
        this.assignment = assignment.value;
        this.plan = new WorkerPlanState(identityOf(assignment.value.details));
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
    if ((name === "edit" || name === "write") && this.cutoverFailed) return true;
    if (name === "edit" || name === "write")
      return this.role !== "implementation" && this.role !== "experiment";
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
    if (this.hasMarker(branch, SETTLED_MARKER) || this.scheduleReminder(branch, send)) return;
    this.appendEntry(SETTLED_MARKER, {});
  }
  systemPolicy(): string {
    return workerSystemPolicy(this.role, this.phase);
  }
  completionChecklist(messages: readonly ContextMessage[]): string | undefined {
    const executor = this.assignment?.details.executor;
    if (this.phase !== "executor" || executor === undefined) return undefined;
    const hasExecutorAssistant = messages.some(
      (message) =>
        message.role === "assistant" &&
        `${message.provider}/${message.model}` === executor.model &&
        !["error", "aborted", "pending"].includes(message.stopReason ?? ""),
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
        (entry.type === "custom_message" &&
          entry.customType === "pi-workgraph-objective" &&
          sameAttempt(entry.details, assignment.details)) ||
        (entry.type === "custom_message" &&
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
      if (this.phase !== "executor" || !this.hasMarker(branch, EXECUTOR_START_ENTRY))
        return contractFailure("Changed implementation requires guide-to-executor cutover.");
      if (!hasLaterExecutorAssistant(this.attemptBranch(branch), this.assignment?.details.executor))
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

  private scheduleReminder(branch: readonly WorkerEntry[], send: MessageSink): boolean {
    if (
      this.role !== "implementation" ||
      this.phase !== "executor" ||
      this.plan?.hasActionableItems() !== true ||
      hasTerminalReport(this.attemptBranch(branch))
    )
      return false;
    const count = this.attemptBranch(branch).filter(
      (entry) => entry.type === "custom_message" && entry.customType === REMINDER,
    ).length;
    if (count >= MAX_PLAN_REMINDERS) return false;
    send({
      customType: REMINDER,
      content: `[WORKGRAPH TODO SETTLE REMINDER ${count + 1}/${MAX_PLAN_REMINDERS}]\nThe executor settled without a report while TODO items remain actionable. Continue useful work or report truthfully; TODO status is not a completion gate.`,
      display: false,
      details: { ordinal: count + 1, limit: MAX_PLAN_REMINDERS },
    });
    return true;
  }

  private attemptBranch(entries: readonly WorkerEntry[]): WorkerEntry[] {
    const details = this.assignment?.details;
    if (details === undefined) return [];
    const start = entries.findIndex(
      (entry) =>
        entry.type === "custom_message" &&
        entry.customType === "pi-workgraph-objective" &&
        sameAttempt(entry.details, details),
    );
    return start < 0 ? [] : entries.slice(start);
  }
  private hasMarker(entries: readonly WorkerEntry[], type: string): boolean {
    return this.attemptBranch(entries).some(
      (entry) => entry.type === "custom" && entry.customType === type,
    );
  }
  private hasMessage(entries: readonly WorkerEntry[], type: string): boolean {
    return this.attemptBranch(entries).some(
      (entry) => entry.type === "custom_message" && entry.customType === type,
    );
  }
}

function reportMode(role: WorkerRole): WorkerSessionMode {
  return role === "review" ? "review" : role === "implementation" ? "implementation" : "research";
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
function hasLaterExecutorAssistant(
  entries: readonly WorkerEntry[],
  executor: { readonly model: string; readonly thinking: string } | undefined,
): boolean {
  if (executor === undefined) return false;
  const boundary = entries.findIndex(
    (entry) => entry.type === "custom" && entry.customType === EXECUTOR_START_ENTRY,
  );
  const slash = executor.model.indexOf("/");
  return (
    boundary >= 0 &&
    entries
      .slice(boundary + 1)
      .some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          `${entry.message.provider}/${entry.message.model}` === executor.model &&
          !["error", "aborted", "pending"].includes(entry.message.stopReason ?? ""),
      ) &&
    slash > 0
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
  const self = { model, thinking };
  return Effect.gen(function* () {
    if (!selected(host, self.model, self.thinking)) {
      const result = yield* Effect.tryPromise({
        try: () => host.selectModel(self.model.slice(0, slash), self.model.slice(slash + 1)),
        catch: () => new WorkerHostError({ message: `Pi could not select model ${self.model}.` }),
      });
      if (result !== "selected")
        return yield* new WorkerHostError({
          message:
            result === "missing"
              ? `Worker model is unavailable: ${self.model}`
              : `Worker model has no usable credentials: ${self.model}`,
        });
      yield* Effect.try({
        try: () => host.setThinking(self.thinking),
        catch: () =>
          new WorkerHostError({ message: `Pi could not select thinking ${self.thinking}.` }),
      });
    }
    if (!selected(host, self.model, self.thinking))
      return yield* new WorkerHostError({
        message: "Pi did not apply the exact model and clamped thinking target.",
      });
  });
}
function contractFailure(message: string) {
  return Effect.fail(new WorkerContractError({ message }));
}
function identityOf(details: WorkerAssignment["details"]) {
  return {
    workstreamId: details.workstreamId,
    taskId: details.taskId,
    attemptId: details.attemptId,
  };
}
function bounded(message: string): string {
  return message.replace(/\s+/g, " ").slice(0, 300);
}
