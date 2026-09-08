import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Config, ConfigProvider, Data, DateTime, Effect } from "effect";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { ThinkingSchema } from "../src/model-policy.js";
import { MODEL_PREFLIGHT_MARKER } from "../src/pi-process.js";
import {
  EnrichmentPacketSchema,
  isWorkerReport,
  isWorkerReportInput,
  reportSchemaForMode,
} from "../src/report-schema.js";
import type {
  ImplementationReport,
  WorkerMode,
  WorkerReport,
  WorkerReportInput,
  WorkerSessionMode,
} from "../src/types.js";

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
  targetModel: Config.string("PI_WORKGRAPH_TARGET_MODEL").pipe(Config.withDefault("")),
  targetThinking: Config.string("PI_WORKGRAPH_TARGET_THINKING").pipe(Config.withDefault("off")),
});

// One bounded, worker-owned plan survives the guide/executor handoff. Status is
// navigation, never verification evidence or authority to expand the assignment.
const PlanStepStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("done"),
  Type.Literal("blocked"),
  Type.Literal("superseded"),
]);
const PlanStepIdSchema = Type.String({ pattern: "^step-[1-8]$" });
const TargetedPlanStepStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("done"),
  Type.Literal("blocked"),
]);
const WorkerPlanStepSchema = Type.Object(
  {
    id: PlanStepIdSchema,
    text: Type.String({ minLength: 3, maxLength: 1000 }),
    status: PlanStepStatusSchema,
    note: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);
const WorkerPlanSchema = Type.Object(
  {
    approach: Type.String({ minLength: 3, maxLength: 2000 }),
    rationale: Type.String({ minLength: 3, maxLength: 2000 }),
    risks: Type.String({ maxLength: 2000 }),
    steps: Type.Array(WorkerPlanStepSchema, { minItems: 1, maxItems: 8 }),
  },
  { additionalProperties: false },
);
const GuidePlanStepSchema = Type.Object(
  {
    text: Type.String({ minLength: 3, maxLength: 1000 }),
    status: PlanStepStatusSchema,
    note: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);
const GuidePlanInputSchema = Type.Object(
  {
    approach: Type.String({ minLength: 3, maxLength: 2000 }),
    rationale: Type.String({ minLength: 3, maxLength: 2000 }),
    risks: Type.String({ maxLength: 2000 }),
    steps: Type.Array(GuidePlanStepSchema, { minItems: 1, maxItems: 8 }),
  },
  { additionalProperties: false },
);
const LegacyPlanEntrySchema = Type.Object(
  {
    runId: Type.String(),
    nodeId: Type.String(),
    plan: GuidePlanInputSchema,
  },
  { additionalProperties: false },
);
const WorkerPlanGetSchema = Type.Object(
  { action: Type.Literal("get") },
  { additionalProperties: false },
);
const WorkerPlanUpdateSchema = Type.Object(
  { action: Type.Literal("update"), plan: GuidePlanInputSchema },
  { additionalProperties: false },
);
const WorkerPlanUpdateStepSchema = Type.Object(
  {
    action: Type.Literal("update_step"),
    id: PlanStepIdSchema,
    patch: Type.Object(
      {
        text: Type.Optional(Type.String({ minLength: 3, maxLength: 1000 })),
        status: Type.Optional(TargetedPlanStepStatusSchema),
        note: Type.Optional(Type.String({ maxLength: 1000 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const WorkerPlanAddStepSchema = Type.Object(
  {
    action: Type.Literal("add_step"),
    text: Type.String({ minLength: 3, maxLength: 1000 }),
    after_id: Type.Optional(PlanStepIdSchema),
  },
  { additionalProperties: false },
);
const WorkerPlanRemoveStepSchema = Type.Object(
  {
    action: Type.Literal("remove_step"),
    id: PlanStepIdSchema,
    reason: Type.String({ minLength: 3, maxLength: 1000 }),
  },
  { additionalProperties: false },
);
const WorkerPlanToolSchema = Type.Union([
  WorkerPlanGetSchema,
  WorkerPlanUpdateSchema,
  WorkerPlanUpdateStepSchema,
  WorkerPlanAddStepSchema,
  WorkerPlanRemoveStepSchema,
]);
const WorkerPlanEntrySchema = Type.Object(
  {
    runId: Type.String(),
    nodeId: Type.String(),
    plan: WorkerPlanSchema,
  },
  { additionalProperties: false },
);
const AttemptIdentitySchema = Type.Object({
  runId: Type.String(),
  nodeId: Type.String(),
});
const EnrichmentEntrySchema = Type.Intersect([
  AttemptIdentitySchema,
  Type.Object({ packet: EnrichmentPacketSchema }),
]);

type WorkerPlan = Static<typeof WorkerPlanSchema>;
type WorkerPlanToolInput = Static<typeof WorkerPlanToolSchema>;

const MAX_RETAINED_STEPS = 8;

function nextStepId(steps: ReadonlyArray<{ readonly id: string }>): string | undefined {
  const used = new Set(steps.map((step) => step.id));
  for (let number = 1; number <= MAX_RETAINED_STEPS; number += 1) {
    const id = `step-${number}`;
    if (!used.has(id)) return id;
  }
  return undefined;
}

type PlanRestore =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly plan: WorkerPlan }
  | { readonly kind: "malformed" };
type ObjectiveRestore =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly content: string }
  | { readonly kind: "malformed" };

const MAX_PLAN_REMINDERS = 2;
const RECONCILIATION_MESSAGE_TYPE = "pi-workgraph-reconciliation";
const ObjectiveContentSchema = Type.String();
const ReportToolDetailsSchema = Type.Object({ report: Type.Unknown() });
const AttemptStateSchema = Type.Object({
  runId: Type.String(),
  nodeId: Type.String(),
  phase: Type.Optional(Type.Union([Type.Literal("guide"), Type.Literal("executor")])),
  reminderCount: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_PLAN_REMINDERS })),
  switchedAt: Type.Optional(Type.String()),
  switchError: Type.Optional(Type.String()),
});

type AttemptState = Static<typeof AttemptStateSchema>;

class WorkerContractError extends Data.TaggedError("WorkerContractError")<{
  readonly message: string;
}> {}

class WorkerHostError extends Data.TaggedError("WorkerHostError")<{
  readonly message: string;
  readonly operation: "exec" | "setModel";
}> {}

class WorkerGitError extends Data.TaggedError("WorkerGitError")<{
  readonly message: string;
}> {}

type WorkerExpectedError = WorkerContractError | WorkerHostError | WorkerGitError;

type GuidePlanInput = Static<typeof GuidePlanInputSchema>;
type PlanStep = WorkerPlan["steps"][number];
type StepPatch = Extract<WorkerPlanToolInput, { readonly action: "update_step" }>["patch"];

function createGuidePlan(input: GuidePlanInput): WorkerPlan {
  return {
    ...input,
    steps: input.steps.map((step, index) => ({ ...step, id: `step-${index + 1}` })),
  };
}

function patchedStep(step: PlanStep, patch: StepPatch): PlanStep {
  return { ...step, ...patch };
}

function applyStepPatch(current: WorkerPlan, id: string, patch: StepPatch) {
  return Effect.gen(function* () {
    if (Object.keys(patch).length === 0)
      return yield* contractFailure(
        "Updating a step requires at least one of text, status, or note; no changes were made.",
      );
    const index = current.steps.findIndex((step) => step.id === id);
    if (index < 0)
      return yield* contractFailure(
        `Unknown step id: ${id}. No changes were made; use workgraph_plan get to inspect stable step IDs.`,
      );
    const next: WorkerPlan = {
      ...current,
      steps: current.steps.map((step, stepIndex) =>
        stepIndex === index ? patchedStep(step, patch) : { ...step },
      ),
    };
    if (!Value.Check(WorkerPlanSchema, next))
      return yield* contractFailure("Invalid step update; no changes were made.");
    return next;
  });
}

function applyStepAddition(current: WorkerPlan, text: string, afterId: string | undefined) {
  return Effect.gen(function* () {
    if (current.steps.length >= MAX_RETAINED_STEPS)
      return yield* contractFailure(
        "The bounded plan already retains 8 total steps including superseded steps; removal retains by supersession and the bound cannot be pruned. No changes were made.",
      );
    let insertAt = current.steps.length;
    if (afterId !== undefined) {
      const anchor = current.steps.findIndex((step) => step.id === afterId);
      if (anchor < 0)
        return yield* contractFailure(
          `Unknown anchor step id: ${afterId}. No changes were made; use workgraph_plan get to inspect stable step IDs.`,
        );
      insertAt = anchor + 1;
    }
    const id = nextStepId(current.steps);
    if (id === undefined)
      return yield* contractFailure(
        "No stable step ID remains in the bounded plan; no changes were made.",
      );
    const retained = [...current.steps];
    retained.splice(insertAt, 0, { id, text, status: "pending" });
    const next: WorkerPlan = { ...current, steps: retained };
    if (!Value.Check(WorkerPlanSchema, next))
      return yield* contractFailure("Invalid step addition; no changes were made.");
    return next;
  });
}

function applyStepRemoval(current: WorkerPlan, id: string, reason: string) {
  return Effect.gen(function* () {
    const index = current.steps.findIndex((step) => step.id === id);
    if (index < 0)
      return yield* contractFailure(
        `Unknown step id: ${id}. No changes were made; use workgraph_plan get to inspect stable step IDs.`,
      );
    const next: WorkerPlan = {
      ...current,
      steps: current.steps.map((step, stepIndex) =>
        stepIndex === index ? { ...step, status: "superseded", note: reason } : { ...step },
      ),
    };
    if (!Value.Check(WorkerPlanSchema, next))
      return yield* contractFailure("Invalid step removal; no changes were made.");
    return next;
  });
}

interface WorkerTerminalState {
  readonly plan?: WorkerPlan | undefined;
  readonly planStatus: PlanRestore["kind"];
  readonly reminderCount: number;
  readonly switchedAt?: string | undefined;
  readonly switchError?: string | undefined;
  readonly continued?: boolean | undefined;
  readonly outcome?: "changed" | "no_change" | undefined;
  readonly baseCommit?: string | undefined;
  readonly revision?: string | undefined;
}

interface WorkerReportExecutionState {
  readonly mode: WorkerMode;
  readonly phase: "guide" | "executor";
  readonly plan?: WorkerPlan | undefined;
  readonly planStatus: PlanRestore["kind"];
  readonly reminderCount: number;
  readonly switchedAt?: string | undefined;
  readonly switchError?: string | undefined;
  readonly continued: boolean;
  readonly baseCommit: string;
  readonly hasExecutorMessage: () => boolean;
}

export default function workgraphWorker(pi: ExtensionAPI): void {
  const environment = Effect.runSync(WorkerEnvironmentConfig.parse(ConfigProvider.fromEnv()));
  const mode = Effect.runSync(readMode(environment.mode));
  if (mode === null) return;
  const {
    runId,
    nodeId,
    executorModel,
    executorThinking,
    baseCommit,
    targetModel,
    targetThinking,
  } = environment;
  const generation = { runId, nodeId };
  const continued = environment.implementationStart === "executor";
  const experiment = environment.experiment === "1";
  let phase: "guide" | "executor" = mode === "implementation" && !continued ? "guide" : "executor";
  let plan: WorkerPlan | undefined;
  let planStatus: PlanRestore["kind"] = "absent";
  let planStateWarning: string | undefined;
  let stateWarning: string | undefined;
  let reminderCount = 0;
  let terminal = false;
  let switchError: string | undefined;
  let switchedAt: string | undefined;

  // SAFETY: session custom data is untrusted external input and is decoded before use.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Explicit Pi session decode boundary.
  function decodeAttemptState(data: unknown): AttemptState | undefined {
    return Value.Check(AttemptStateSchema, data)
      ? Value.Decode(AttemptStateSchema, data)
      : undefined;
  }

  function belongsToAttempt(data: AttemptState): boolean {
    return data.runId === runId && data.nodeId === nodeId;
  }

  function persistPlan(next: WorkerPlan, action: string) {
    const persisted = structuredClone(next);
    pi.appendEntry("pi-workgraph-worker-plan", { ...generation, plan: persisted });
    plan = next;
    planStatus = "valid";
    planStateWarning = undefined;
    return {
      content: [{ type: "text" as const, text: `Updated ${planText()}` }],
      details: { action, plan: structuredClone(next), planStatus, attempt: generation },
    };
  }

  function missingPlanFailure() {
    return contractFailure(
      planStatus === "malformed"
        ? "No valid current plan is available because the latest current-attempt plan state was malformed. Do not infer or author replacement direction; continue only with truthful work, report, or escalation within the inherited assignment and explain that no scope was inferred. No changes were made."
        : "No current plan is recorded yet. Do not infer or author plan direction; continue only with truthful work, report, or escalation within the inherited assignment and explain that no scope was inferred. No changes were made.",
    );
  }

  function handleGuideUpdate(input: GuidePlanInput | undefined) {
    return Effect.gen(function* () {
      if (phase !== "guide")
        return yield* contractFailure(
          "Only the guide phase may replace the full plan with workgraph_plan update. Use targeted get, update_step, add_step, or remove_step to execute the inherited approach, record findings in step notes, and escalate consequential approach conflicts instead of inferring new scope. No changes were made.",
        );
      if (input === undefined)
        return yield* contractFailure(
          "Updating the current plan requires a plan value. No changes were made.",
        );
      const created = createGuidePlan(input);
      if (!Value.Check(WorkerPlanSchema, created))
        return yield* contractFailure("Invalid full plan replacement; no changes were made.");
      return persistPlan(created, "update");
    });
  }

  type TargetedPlanInput = Extract<
    WorkerPlanToolInput,
    { readonly action: "update_step" | "add_step" | "remove_step" }
  >;

  function handleTargetedEdit(targeted: TargetedPlanInput) {
    return Effect.gen(function* () {
      if (plan === undefined) return yield* missingPlanFailure();
      if (targeted.action === "update_step") {
        const next = yield* applyStepPatch(plan, targeted.id, targeted.patch);
        return persistPlan(next, "update_step");
      }
      if (targeted.action === "add_step") {
        const next = yield* applyStepAddition(plan, targeted.text, targeted.after_id);
        return persistPlan(next, "add_step");
      }
      const next = yield* applyStepRemoval(plan, targeted.id, targeted.reason);
      return persistPlan(next, "remove_step");
    });
  }

  // Session order, not model selection or wall-clock time, proves a later generation.
  // Pi drains the current assistant message before tool preflight/execution.
  function hasExecutorMessage(entries: SessionEntry[]): boolean {
    const boundary = entries.findIndex((entry) => {
      if (entry.type !== "custom") return false;
      const data = decodeAttemptState(entry.data);
      if (data === undefined || !belongsToAttempt(data)) return false;
      return continued
        ? entry.customType === "pi-workgraph-agent-running"
        : entry.customType === "pi-workgraph-worker-state" &&
            data.phase === "executor" &&
            data.switchedAt !== undefined;
    });
    return (
      boundary >= 0 &&
      entries
        .slice(boundary + 1)
        .some(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "assistant" &&
            `${entry.message.provider}/${entry.message.model}` === executorModel &&
            !["error", "aborted", "pending"].includes(entry.message.stopReason),
        )
    );
  }

  if (mode === "implementation")
    pi.registerTool({
      name: "workgraph_plan",
      label: "Workgraph Plan",
      description:
        "Inspect one bounded current implementation plan or apply one atomic step edit. The plan guides work but is not proof of correctness or completion.",
      promptSnippet: "Inspect or apply one atomic edit to the bounded current plan",
      promptGuidelines: [
        "Use workgraph_plan to inspect the current plan or apply one atomic step edit with stable step IDs; keep targeted steps and notes current while executing the inherited approach, plan statuses are navigation only, not evidence.",
      ],
      parameters: WorkerPlanToolSchema,
      execute(_id, params: WorkerPlanToolInput) {
        return Effect.runPromise(
          Effect.gen(function* () {
            if (params.action === "get") {
              return {
                content: [{ type: "text" as const, text: planText() }],
                details: {
                  action: "get",
                  plan: plan === undefined ? undefined : structuredClone(plan),
                  planStatus,
                  attempt: generation,
                },
              };
            }
            if (params.action === "update") return yield* handleGuideUpdate(params.plan);
            return yield* handleTargetedEdit(params);
          }),
        );
      },
    });
  if (mode === "consultation_enricher") {
    pi.registerTool({
      name: "workgraph_enrichment",
      label: "Workgraph Enrichment",
      description:
        "Persist the strict bounded evidence packet for the consultation enricher. This packet records observations, counterevidence, local state and gaps; it must not decide or summarize the answer.",
      promptSnippet: "Finish the consultation evidence packet",
      parameters: EnrichmentPacketSchema,
      execute(_id, params) {
        if (terminal)
          return Promise.reject(
            new WorkerContractError({ message: "The enrichment packet is already terminal." }),
          );
        if (!Value.Check(EnrichmentPacketSchema, params))
          return Promise.reject(
            new WorkerContractError({
              message: "Enrichment packet is outside its strict bounded contract.",
            }),
          );
        pi.appendEntry("pi-workgraph-enrichment", {
          ...generation,
          packet: structuredClone(params),
        });
        terminal = true;
        return Promise.resolve({
          content: [
            { type: "text" as const, text: "Frozen consultation enrichment packet recorded." },
          ],
          details: { packet: structuredClone(params), attempt: generation },
          terminate: true,
        });
      },
    });
  } else if (mode !== "consultation")
    pi.registerTool({
      name: "workgraph_report",
      label: "Workgraph Report",
      description: "Return the terminal report for this bounded assignment.",
      promptSnippet: "Finish assigned work with a typed report",
      promptGuidelines: [
        "Use workgraph_report as the final action, with actual evidence and explicit limitations.",
      ],
      parameters: reportSchemaForMode(mode),
      execute(_id, params: WorkerReportInput, _signal, _update, ctx) {
        return Effect.runPromise(
          Effect.gen(function* () {
            const result = yield* handleWorkerReport(pi, ctx.cwd, params, {
              mode,
              phase,
              plan,
              planStatus,
              reminderCount,
              switchedAt,
              switchError,
              continued,
              baseCommit,
              hasExecutorMessage: () => hasExecutorMessage(ctx.sessionManager.getBranch()),
            });
            if (result.terminate === true) terminal = true;
            return result;
          }),
        );
      },
    });

  pi.on("tool_execution_end", (event, ctx) => {
    if (mode !== "implementation" || phase !== "guide") return;
    const directEdit = !event.isError && (event.toolName === "edit" || event.toolName === "write");
    const operation = directEdit
      ? transitionToExecutor(pi, ctx)
      : Effect.gen(function* () {
          if (!baseCommit) return;
          // Any tool can mutate or commit. Observe Git, not shell-command spelling.
          const status = yield* gitEffect(
            pi,
            ctx.cwd,
            ["status", "--porcelain", "--untracked-files=all"],
            true,
          );
          if (
            status.length === 0 &&
            (yield* gitEffect(pi, ctx.cwd, ["rev-parse", "HEAD"])) === baseCommit
          )
            return;
          yield* transitionToExecutor(pi, ctx);
        });
    return Effect.runPromise(
      operation.pipe(Effect.catch((error) => Effect.sync(() => recordSwitchFailure(pi, error)))),
    );
  });

  function transitionToExecutor(
    extension: ExtensionAPI,
    ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
  ) {
    return Effect.gen(function* () {
      const slash = executorModel.indexOf("/");
      if (slash <= 0) return yield* contractFailure(`Invalid executor model: ${executorModel}`);
      const model = ctx.modelRegistry.find(
        executorModel.slice(0, slash),
        executorModel.slice(slash + 1),
      );
      if (model === undefined)
        return yield* contractFailure(`Executor model is unavailable: ${executorModel}`);
      const selected = yield* Effect.tryPromise({
        try: () => extension.setModel(model),
        catch: () =>
          new WorkerHostError({
            operation: "setModel",
            message: `Pi could not select executor model: ${executorModel}`,
          }),
      });
      if (!selected)
        return yield* contractFailure(`Executor model has no usable credentials: ${executorModel}`);
      if (!Value.Check(ThinkingSchema, executorThinking))
        return yield* contractFailure(`Invalid executor thinking: ${executorThinking}`);
      extension.setThinkingLevel(executorThinking);
      phase = "executor";
      switchError = undefined;
      switchedAt = DateTime.formatIso(yield* DateTime.now);
      appendWorkerState(extension);
      appendRecoverySnapshot(extension, ctx.sessionManager);
    });
  }

  function appendWorkerState(extension: ExtensionAPI): void {
    const state: AttemptState = { ...generation, phase, reminderCount };
    if (switchedAt !== undefined) state.switchedAt = switchedAt;
    if (switchError !== undefined) state.switchError = switchError;
    extension.appendEntry("pi-workgraph-worker-state", state);
  }

  function recordSwitchFailure(extension: ExtensionAPI, error: WorkerExpectedError): void {
    switchError = error.message;
    appendWorkerState(extension);
  }
  pi.on("model_select", (event) => {
    pi.appendEntry("pi-workgraph-effective-model", {
      ...generation,
      model: `${event.model.provider}/${event.model.id}`,
      thinking: pi.getThinkingLevel(),
    });
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    if (ctx.model)
      pi.appendEntry("pi-workgraph-effective-model", {
        ...generation,
        model: `${ctx.model.provider}/${ctx.model.id}`,
        thinking: pi.getThinkingLevel(),
      });
  });
  function latestAttemptState(
    entries: SessionEntry[],
  ):
    | { readonly state: AttemptState; readonly malformed: false }
    | { readonly state: undefined; readonly malformed: boolean } {
    for (const entry of [...entries].reverse()) {
      if (entry.type !== "custom" || entry.customType !== "pi-workgraph-worker-state") continue;
      if (!isCurrentAttemptData(entry.data)) continue;
      const attempt = decodeAttemptState(entry.data);
      return attempt === undefined
        ? { state: undefined, malformed: true }
        : { state: attempt, malformed: false };
    }
    return { state: undefined, malformed: false };
  }

  // SAFETY: session custom data is untrusted external input and is decoded before use.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Explicit Pi session plan decode boundary.
  function restorePlanEntry(data: unknown): PlanRestore {
    if (Value.Check(WorkerPlanEntrySchema, data)) {
      const decoded = Value.Decode(WorkerPlanEntrySchema, data);
      const ids = decoded.plan.steps.map((step) => step.id);
      if (new Set(ids).size !== ids.length) return { kind: "malformed" };
      return { kind: "valid", plan: structuredClone(decoded.plan) };
    }
    if (Value.Check(LegacyPlanEntrySchema, data)) {
      const decoded = Value.Decode(LegacyPlanEntrySchema, data);
      return { kind: "valid", plan: createGuidePlan(decoded.plan) };
    }
    return { kind: "malformed" };
  }

  function latestAttemptPlan(entries: SessionEntry[]): PlanRestore {
    for (const entry of [...entries].reverse()) {
      if (entry.type !== "custom" || entry.customType !== "pi-workgraph-worker-plan") continue;
      if (!isCurrentAttemptData(entry.data)) continue;
      return restorePlanEntry(entry.data);
    }
    return { kind: "absent" };
  }

  function latestAttemptObjective(entries: SessionEntry[]): ObjectiveRestore {
    for (const entry of [...entries].reverse()) {
      if (entry.type !== "custom_message" || entry.customType !== "pi-workgraph-objective")
        continue;
      if (!isCurrentAttemptData(entry.details)) continue;
      if (!Value.Check(ObjectiveContentSchema, entry.content)) return { kind: "malformed" };
      return { kind: "valid", content: Value.Decode(ObjectiveContentSchema, entry.content) };
    }
    return { kind: "absent" };
  }

  function hasTerminalEnrichment(entries: SessionEntry[]): boolean {
    const boundary = entries.findLastIndex(
      (entry) =>
        entry.type === "custom_message" &&
        entry.customType === "pi-workgraph-objective" &&
        isCurrentAttemptData(entry.details),
    );
    if (boundary < 0) return false;
    return entries
      .slice(boundary + 1)
      .some(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "pi-workgraph-enrichment" &&
          isCurrentAttemptData(entry.data) &&
          Value.Check(EnrichmentEntrySchema, entry.data),
      );
  }

  function hasTerminalReport(entries: SessionEntry[]): boolean {
    const boundary = entries.findLastIndex(
      (entry) =>
        entry.type === "custom_message" &&
        entry.customType === "pi-workgraph-objective" &&
        isCurrentAttemptData(entry.details),
    );
    if (boundary < 0) return false;
    return entries.slice(boundary + 1).some((entry) => {
      if (entry.type !== "message" || entry.message.role !== "toolResult") return false;
      if (entry.message.toolName !== "workgraph_report" || entry.message.isError) return false;
      if (!Value.Check(ReportToolDetailsSchema, entry.message.details)) return false;
      const details = Value.Decode(ReportToolDetailsSchema, entry.message.details);
      return isWorkerReport(details.report);
    });
  }

  function reattachAttemptState(attempt: AttemptState): void {
    if (attempt.reminderCount !== undefined) reminderCount = attempt.reminderCount;
    if (attempt.switchedAt !== undefined) switchedAt = attempt.switchedAt;
    if (attempt.phase === "executor") phase = "executor";
    if (attempt.switchError !== undefined) switchError = attempt.switchError;
  }

  // SAFETY: session custom data is untrusted external input and is decoded before use.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Explicit Pi session identity decode boundary.
  function isCurrentAttemptData(data: unknown): boolean {
    if (!Value.Check(AttemptIdentitySchema, data)) return false;
    const identity = Value.Decode(AttemptIdentitySchema, data);
    return identity.runId === runId && identity.nodeId === nodeId;
  }

  function planText(): string {
    if (plan === undefined) {
      if (planStatus === "malformed")
        return phase === "guide"
          ? "Current bounded plan: unavailable because the latest current-attempt plan state was malformed. Recreate it with workgraph_plan update; do not treat the missing plan as evidence."
          : "Current bounded plan: unavailable because the latest current-attempt plan state was malformed. Do not infer or author replacement direction; continue only with truthful work, report, or escalation within the inherited assignment and explain that no scope was inferred.";
      return phase === "guide"
        ? "Current bounded plan: none recorded yet. Use workgraph_plan update only when a plan helps the assignment."
        : "Current bounded plan: none recorded yet. Do not infer or author plan direction; continue only with truthful work, report, or escalation within the inherited assignment and explain that no scope was inferred.";
    }
    const steps = plan.steps
      .map(
        (step) =>
          `${step.id} ${step.status}: ${step.text}${step.note === undefined ? "" : ` — ${step.note}`}`,
      )
      .join("\n");
    return [
      "Current bounded plan (navigation only; statuses are not correctness evidence):",
      `Approach: ${plan.approach}`,
      `Rationale and constraints: ${plan.rationale}`,
      `Risks and unknowns: ${plan.risks || "none recorded"}`,
      "Steps:",
      steps,
    ].join("\n");
  }

  function hasActionablePlanSteps(): boolean {
    return (
      plan?.steps.some((step) => step.status === "pending" || step.status === "in_progress") ??
      false
    );
  }

  function reconciliationReminder(count: number): string {
    return [
      `[WORKGRAPH RECONCILIATION REMINDER ${count}/${MAX_PLAN_REMINDERS}]`,
      "The executor settled without a terminal report while the current plan still has actionable steps.",
      "Inspect the worktree and current-attempt snapshot, then continue useful work or report truthful failure or escalation. Do not treat plan status as evidence or a completion gate.",
    ].join("\n");
  }

  function scheduleReconciliation(extension: ExtensionAPI): boolean {
    if (
      mode !== "implementation" ||
      phase !== "executor" ||
      terminal ||
      !hasActionablePlanSteps() ||
      reminderCount >= MAX_PLAN_REMINDERS
    )
      return false;
    reminderCount += 1;
    appendWorkerState(extension);
    extension.sendMessage(
      {
        customType: RECONCILIATION_MESSAGE_TYPE,
        content: reconciliationReminder(reminderCount),
        display: false,
        details: { ...generation, reminderCount },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
    return true;
  }

  function objectiveText(objective: ObjectiveRestore): string {
    if (objective.kind === "valid")
      return ["[WORKGRAPH CURRENT-ATTEMPT OBJECTIVE]", objective.content].join("\n");
    if (objective.kind === "malformed")
      return "[WORKGRAPH CURRENT-ATTEMPT OBJECTIVE]\nThe exact current-attempt objective snapshot was malformed and was ignored; do not guess its acceptance or constraints.";
    return "[WORKGRAPH CURRENT-ATTEMPT OBJECTIVE]\nNo exact current-attempt objective snapshot was found; do not infer acceptance, constraints, or authority from the mutable plan.";
  }

  function currentInstructions(objective: ObjectiveRestore): string {
    const base = phase === "guide" ? guideInstructions : executorInstructions();
    return [
      base,
      "[WORKGRAPH CURRENT ATTEMPT RECOVERY]",
      `Attempt identity: ${runId}/${nodeId}. Continue the inherited bounded assignment; do not invent new scope or infer authority from this message.`,
      "The objective below is restored verbatim from the latest matching raw session entry. Older objective and model snapshots are historical context and must not be replayed. Later workgraph_plan tool results supersede this snapshot's plan.",
      objectiveText(objective),
      planText(),
      planStateWarning ?? "",
      stateWarning ?? "",
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  }

  function appendModelPreflight(ctx: ExtensionContext): void {
    if (targetModel === "") return;
    const slash = targetModel.indexOf("/");
    const model =
      slash > 0
        ? ctx.modelRegistry.find(targetModel.slice(0, slash), targetModel.slice(slash + 1))
        : undefined;
    let state: "ready" | "missing_model" | "missing_credentials" | "unsupported_thinking" = "ready";
    let detail = `Model ${targetModel} and thinking ${targetThinking} passed local preflight.`;
    if (model === undefined) {
      state = "missing_model";
      detail = `Model ${targetModel} is not registered in Pi.`;
    } else if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
      state = "missing_credentials";
      detail = `Model ${targetModel} has no usable configured credentials.`;
    } else if (
      !Value.Check(ThinkingSchema, targetThinking) ||
      !getSupportedThinkingLevels(model).includes(targetThinking)
    ) {
      state = "unsupported_thinking";
      detail = `Model ${targetModel} does not support thinking ${targetThinking}.`;
    }
    pi.appendEntry(MODEL_PREFLIGHT_MARKER, {
      ...generation,
      model: targetModel,
      thinking: targetThinking,
      state,
      detail,
    });
  }

  function configureReadOnlyTools(): void {
    // Keep editing tools for implementation and authorized research experiments.
    // This filters tool availability; bash remains available and is not sandboxed.
    const readOnly = mode !== "implementation" && !(mode === "research" && experiment);
    const activeTools = pi.getActiveTools();
    const allowedTools = activeTools.filter(
      (name) => name !== "herdr_rename" && !(readOnly && (name === "edit" || name === "write")),
    );
    if (allowedTools.length !== activeTools.length) pi.setActiveTools(allowedTools);
  }

  function restoreWorkerSession(branch: SessionEntry[]): void {
    phase = mode === "implementation" && !continued ? "guide" : "executor";
    reminderCount = 0;
    switchError = undefined;
    switchedAt = undefined;
    terminal =
      mode === "consultation_enricher" ? hasTerminalEnrichment(branch) : hasTerminalReport(branch);
    const attempt = latestAttemptState(branch);
    stateWarning = attempt.malformed
      ? "The latest current-attempt worker state was malformed and was ignored; continue conservatively and report the limitation."
      : undefined;
    if (attempt.state !== undefined) reattachAttemptState(attempt.state);
    const restoredPlan = latestAttemptPlan(branch);
    planStatus = restoredPlan.kind;
    plan = restoredPlan.kind === "valid" ? restoredPlan.plan : undefined;
    planStateWarning =
      restoredPlan.kind === "malformed"
        ? "The latest current-attempt plan state was malformed and was ignored; continue conservatively and report the limitation."
        : undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    configureReadOnlyTools();
    appendModelPreflight(ctx);
    restoreWorkerSession(ctx.sessionManager.getBranch());
  });
  pi.on("agent_start", (_event, ctx) => {
    if (ctx.model)
      pi.appendEntry("pi-workgraph-effective-model", {
        ...generation,
        model: `${ctx.model.provider}/${ctx.model.id}`,
        thinking: pi.getThinkingLevel(),
      });
    pi.appendEntry("pi-workgraph-agent-running", {
      ...generation,
      startedAt: DateTime.formatIso(DateTime.nowUnsafe()),
    });
  });
  pi.on("agent_settled", () => {
    if (scheduleReconciliation(pi)) return;
    pi.appendEntry("pi-workgraph-agent-settled", {
      ...generation,
      settledAt: DateTime.formatIso(DateTime.nowUnsafe()),
    });
  });
  function recoverySnapshot(
    session: ExtensionContext["sessionManager"],
  ):
    | Pick<
        Parameters<ExtensionAPI["sendMessage"]>[0],
        "customType" | "content" | "display" | "details"
      >
    | undefined {
    const customType = phase === "guide" ? "pi-workgraph-guide" : "pi-workgraph-executor";
    if (
      session
        .buildContextEntries()
        .some(
          (entry) =>
            entry.type === "custom_message" &&
            entry.customType === customType &&
            isCurrentAttemptData(entry.details),
        )
    )
      return undefined;
    return {
      customType,
      content: currentInstructions(latestAttemptObjective(session.getBranch())),
      display: false,
      details: generation,
    };
  }

  function appendRecoverySnapshot(
    extension: ExtensionAPI,
    session: ExtensionContext["sessionManager"],
  ): void {
    const snapshot = recoverySnapshot(session);
    if (snapshot !== undefined) extension.sendMessage(snapshot);
  }

  // Persist guidance at real transcript boundaries, never move a synthetic tail
  // behind new assistant/tool history on every provider request.
  pi.on("session_compact", (_event, ctx) => {
    if (mode !== "implementation") return;
    appendRecoverySnapshot(pi, ctx.sessionManager);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (mode === "implementation") {
      const message = recoverySnapshot(ctx.sessionManager);
      return message === undefined ? undefined : { message };
    }
    return {
      message: {
        customType: `pi-workgraph-${mode}`,
        content: instructionForMode(mode, experiment),
        display: false,
        details: generation,
      },
    };
  });
}

function handleWorkerReport(
  pi: ExtensionAPI,
  cwd: string,
  params: WorkerReportInput,
  execution: WorkerReportExecutionState,
) {
  return Effect.gen(function* () {
    if (!isWorkerReportInput(params) || params.kind !== execution.mode)
      return yield* contractFailure(`Report must satisfy the ${execution.mode} contract.`);
    if (params.kind !== "implementation" || params.status !== "completed") {
      // Read-only is an instruction and authority boundary, not a filesystem sandbox.
      // Shared research and non-revision review deliberately observe the live project cwd,
      // including tracked and untracked local changes. Exact-revision review is launched in
      // an owned worktree at its requested SHA; do not confuse either cwd with another revision.
      return terminalReport(params, {
        plan: execution.plan,
        planStatus: execution.planStatus,
        reminderCount: execution.reminderCount,
        switchedAt: execution.switchedAt,
        switchError: execution.switchError,
      });
    }
    if (params.outcome === "no_change")
      return yield* noChangeImplementationReport(pi, cwd, params, execution);
    return yield* changedImplementationReport(pi, cwd, params, execution);
  });
}

function noChangeImplementationReport(
  pi: ExtensionAPI,
  cwd: string,
  report: Extract<ImplementationReport, { outcome: "no_change" }>,
  execution: WorkerReportExecutionState,
) {
  return Effect.gen(function* () {
    if (execution.baseCommit.length === 0)
      return yield* contractFailure("PI_WORKGRAPH_BASE_COMMIT is required.");
    yield* requireCleanWorktree(pi, cwd, "No-change implementation requires a clean worktree:");
    const revision = yield* gitEffect(pi, cwd, ["rev-parse", "HEAD"]);
    if (report.revision !== revision || revision !== execution.baseCommit)
      return yield* contractFailure(
        `No-change implementation must report the unchanged base revision ${execution.baseCommit}.`,
      );
    return terminalReport(report, {
      plan: execution.plan,
      planStatus: execution.planStatus,
      reminderCount: execution.reminderCount,
      switchedAt: execution.switchedAt,
      continued: execution.continued,
      outcome: "no_change",
      baseCommit: execution.baseCommit,
      revision,
    });
  });
}

function changedImplementationReport(
  pi: ExtensionAPI,
  cwd: string,
  report: Extract<ImplementationReport, { outcome: "changed" }>,
  execution: WorkerReportExecutionState,
) {
  return Effect.gen(function* () {
    if (execution.phase !== "executor")
      return yield* contractFailure(
        "Completed changed implementation requires the first-edit model transition.",
      );
    if (execution.switchError !== undefined)
      return yield* contractFailure(`Executor model transition failed: ${execution.switchError}`);
    if (!execution.hasExecutorMessage())
      return yield* contractFailure(
        "Completed changed implementation requires an actual executor assistant message after this attempt's transition/start. Continue with the executor before reporting.",
      );
    if (execution.baseCommit.length === 0)
      return yield* contractFailure("PI_WORKGRAPH_BASE_COMMIT is required.");
    const provenance = yield* changedCommitProvenance(pi, cwd, execution.baseCommit);
    return terminalReport(
      { ...report, ...provenance },
      {
        plan: execution.plan,
        planStatus: execution.planStatus,
        reminderCount: execution.reminderCount,
        switchedAt: execution.switchedAt,
        continued: execution.continued,
        outcome: "changed",
      },
    );
  });
}

function changedCommitProvenance(pi: ExtensionAPI, cwd: string, baseCommit: string) {
  return Effect.gen(function* () {
    yield* requireCleanWorktree(pi, cwd, "Commit and leave a clean worktree before reporting:");
    const [commit, parent, ...extraParents] = (yield* gitEffect(pi, cwd, [
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
      pi,
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

function requireCleanWorktree(pi: ExtensionAPI, cwd: string, errorPrefix: string) {
  return Effect.gen(function* () {
    const status = yield* gitEffect(
      pi,
      cwd,
      ["status", "--porcelain", "--untracked-files=all"],
      true,
    );
    if (status.length > 0) return yield* contractFailure(`${errorPrefix}\n${status}`);
  });
}

function terminalReport(report: WorkerReport, state: WorkerTerminalState) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${report.kind} ${report.status}: ${report.summary}`,
      },
    ],
    details: { report, state },
    terminate: true,
  };
}
const researchInstructions =
  "[WORKGRAPH RESEARCH]\nAnswer only the assigned question using read-only evidence from the live project cwd. Tracked and untracked local changes may be present; do not require cleanliness, copy files, or modify them. Supply the requested observations and retain material unknowns. Do not delegate another worker. Finish with workgraph_report.";
function instructionForMode(mode: WorkerSessionMode, experiment: boolean): string {
  if (mode === "review") return reviewInstructions;
  if (mode === "consultation") return consultationInstructions;
  if (mode === "consultation_enricher") return consultationEnricherInstructions;
  if (mode === "implementation") return guideInstructions;
  return experiment ? experimentInstructions : researchInstructions;
}

const experimentInstructions =
  "[WORKGRAPH EXPERIMENT]\nAnswer the question within the explicitly permitted effects and stop condition in this disposable worktree. Leave all outputs in the assigned worktree and report direct observations, failures and limits; the coordinator decides when to release the worktree. Do not compose, publish, or delegate another worker. Finish with workgraph_report.";
const consultationEnricherInstructions =
  "[WORKGRAPH CONSULTATION ENRICHER]\nYou are an evidence-only enricher. Answer no part of the consultation question and do not summarize or decide it. Use read-only local tools to collect relevant source observations, counterevidence, exact local/uncommitted state identity, and explicit gaps. Finish only with workgraph_enrichment using the strict bounded packet contract.";
const consultationInstructions =
  "[WORKGRAPH CONSULTATION ADVISOR]\nYou are the final evidence-only advisor. You receive a fresh context containing the precise question, constraints, coordinator-known context, and a frozen enrichment packet. The enricher transcript is not available. You may use read-only local tools to fill gaps. Return your final advice as assistant text; do not claim coordinator authority, acceptance, or implementation.";
const reviewInstructions =
  "[WORKGRAPH REVIEW]\nReview only the identified subject and concern. Ordinary result, artifact, and comparison reviews may observe the live project cwd. An exact revision review runs in an owned worktree checked out at the requested SHA; inspect that exact commit with Git (for example git show, git diff, and git ls-tree) and cite that revision in evidence. Do not silently treat live working files as that commit or claim tests against another revision. Execute verification only when it genuinely targets the requested subject. Do not edit files or delegate another worker. Return evidence and actionable findings; zero findings is valid. Finish with workgraph_report.";
const guideInstructions =
  "[WORKGRAPH LOCAL PREWALK - GUIDE]\nInspect the assignment and current isolated worktree. Treat its settled decisions as constraints; ground the local plan in code without replacing the intended solution. If implementation requires choosing an unsettled responsibility owner, retained or removed mechanism, interaction contract, consumer or integration change, end-to-end flow, or failure, ordering, precedence, concurrency, or lifetime behavior, escalate before editing. Return specific contradictions or consequential decisions outside the stated discretion to the coordinator rather than silently resolving them. If the requirement already holds, verify it and report no_change with the inspected base revision and reason; no edit or executor turn is required. If a change is needed, use workgraph_plan once with action update to record one concise bounded plan grounded in inspected code, with rationale and constraints, concrete risks or unknowns, and implementation and meaningful verification steps. The guide owns the approach, rationale, and initial risks; the update assigns stable step IDs. Then make the first useful implementation edit yourself. Recording or revising the plan does not switch models. The first successful edit or observed Git change triggers the executor switch; do not stop or wait for a handoff after planning. Changed work must complete through the executor. Missing plan state does not block truthful implementation, failure, or escalation. If required work crosses the authorized scope, report escalation without editing.";
function executorInstructions(): string {
  return "[WORKGRAPH EXECUTOR]\nContinue this same worker trajectory in the isolated worktree and preserve the inherited assignment. Adjust local execution steps within its stated discretion; return conflicts with settled decisions or missing consequential decisions to the coordinator rather than redesigning the solution. If later evidence exposes an unsettled responsibility owner, retained or removed mechanism, interaction contract, consumer or integration change, end-to-end flow, or failure, ordering, precedence, concurrency, or lifetime behavior, stop editing and escalate. Inspect the current bounded plan with stable step IDs and independently reconcile it against the worktree. Use workgraph_plan targeted actions only (get, update_step, add_step, remove_step) to execute the inherited approach: update step text, status, and notes as work proceeds and record new findings there; never replace the full plan or mutate the inherited approach, rationale, or initial risks. Escalate consequential approach conflicts to the coordinator instead of inferring new scope; no schema verifies semantic conformity. When the plan is absent or malformed, do not author replacement direction; continue only with truthful work, report, or escalation and explain that no scope was inferred. Plan statuses are not correctness evidence and unfinished steps do not block a truthful failure or escalation. Complete the bounded assignment and run meaningful verification. For changed code, create exactly one direct commit on the supplied base and leave the worktree clean. If verification establishes no change is needed and the worktree is clean at the supplied base, report no_change with that revision and reason instead. Return workgraph_report with evidence and explicit limitations. Escalate required work beyond the authorized scope.";
}
function gitEffect(pi: ExtensionAPI, cwd: string, args: string[], allowEmpty = false) {
  return Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () => pi.exec("git", ["-C", cwd, ...args]),
      catch: () =>
        new WorkerHostError({
          operation: "exec",
          message: `Pi could not execute git ${args.join(" ")}.`,
        }),
    });
    if (result.code !== 0)
      return yield* gitFailure(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    const output = result.stdout.trim();
    if (!allowEmpty && output.length === 0)
      return yield* gitFailure(`git ${args.join(" ")} returned no output.`);
    return output;
  });
}

function contractFailure(message: string) {
  return Effect.fail(new WorkerContractError({ message }));
}

function gitFailure(message: string) {
  return Effect.fail(new WorkerGitError({ message }));
}

function readMode(value: string) {
  if (value.length === 0) return Effect.succeed<WorkerSessionMode | null>(null);
  if (
    value === "research" ||
    value === "review" ||
    value === "implementation" ||
    value === "consultation" ||
    value === "consultation_enricher"
  )
    return Effect.succeed<WorkerSessionMode | null>(value);
  return contractFailure(`Invalid PI_WORKGRAPH_MODE: ${value}`);
}
