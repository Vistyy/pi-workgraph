import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Config, ConfigProvider, Data, DateTime, Effect } from "effect";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { ThinkingSchema } from "../src/domain/model-target.js";
import {
  type ImplementationReportInput,
  isWorkerReport,
  isWorkerReportInput,
  reportSchemaForMode,
  type WorkerMode,
  type WorkerReport,
  type WorkerReportInput,
  type WorkerSessionMode,
} from "../src/report-schema.js";
import {
  hasActiveObjective,
  hasActivePhase,
  hasActiveRecovery,
  phaseActivationMessage,
  recoveryMessage,
  type WorkerObjectiveRestore,
  type WorkerPolicyRole,
  workerSystemPolicy,
} from "../src/worker-context.js";
import { loadWorkerDisabledTools } from "../src/workgraph-settings.js";

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

// One concise, worker-owned plan survives the guide/executor handoff. Status is
// navigation, never verification evidence or authority to expand the assignment.
const PlanStepStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("done"),
  Type.Literal("blocked"),
  Type.Literal("superseded"),
]);
const PlanStepIdSchema = Type.String({ pattern: "^step-[1-9][0-9]*$", maxLength: 21 });
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
    steps: Type.Array(WorkerPlanStepSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
const GuidePlanStepSchema = Type.Object(
  {
    text: Type.String({ minLength: 3, maxLength: 1000 }),
    status: TargetedPlanStepStatusSchema,
    note: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);
const GuidePlanInputSchema = Type.Object(
  {
    approach: Type.String({ minLength: 3, maxLength: 2000 }),
    rationale: Type.String({ minLength: 3, maxLength: 2000 }),
    risks: Type.String({ maxLength: 2000 }),
    steps: Type.Array(GuidePlanStepSchema, { minItems: 1 }),
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
const WorkerPlanUpdateOverviewSchema = Type.Object(
  {
    action: Type.Literal("update_overview"),
    patch: Type.Object(
      {
        approach: Type.Optional(Type.String({ minLength: 3, maxLength: 2000 })),
        rationale: Type.Optional(Type.String({ minLength: 3, maxLength: 2000 })),
        risks: Type.Optional(Type.String({ maxLength: 2000 })),
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
const WorkerPlanToolSchema = Type.Union(
  [
    WorkerPlanGetSchema,
    WorkerPlanUpdateSchema,
    WorkerPlanUpdateStepSchema,
    WorkerPlanUpdateOverviewSchema,
    WorkerPlanAddStepSchema,
    WorkerPlanRemoveStepSchema,
  ],
  { type: "object" },
);
const WorkerPlanEntrySchema = Type.Object(
  {
    runId: Type.String(),
    nodeId: Type.String(),
    plan: WorkerPlanSchema,
    nextStepNumber: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);
const AttemptIdentitySchema = Type.Object({
  runId: Type.String(),
  nodeId: Type.String(),
});
type WorkerPlan = Static<typeof WorkerPlanSchema>;
type WorkerPlanToolInput = Static<typeof WorkerPlanToolSchema>;

// This is a resource ceiling, not a semantic step-count limit. It roughly preserves
// the previous maximum serialized payload while allowing concise plans to evolve.
const MAX_SERIALIZED_PLAN_CHARACTERS = 24_000;

function stepNumber(id: string): number | undefined {
  const number = Number(id.slice("step-".length));
  return Number.isSafeInteger(number) && number >= 1 ? number : undefined;
}

function nextNumberAfter(steps: ReadonlyArray<{ readonly id: string }>): number | undefined {
  let maximum = 0;
  for (const step of steps) {
    const number = stepNumber(step.id);
    if (number === undefined) return undefined;
    maximum = Math.max(maximum, number);
  }
  return maximum < Number.MAX_SAFE_INTEGER ? maximum + 1 : undefined;
}

function planValidationFailure(candidate: WorkerPlan): string | undefined {
  if (!Value.Check(WorkerPlanSchema, candidate)) return "Invalid plan";
  if (JSON.stringify(candidate).length > MAX_SERIALIZED_PLAN_CHARACTERS)
    return `The current plan exceeds the ${MAX_SERIALIZED_PLAN_CHARACTERS}-character serialized safety limit`;
  return undefined;
}

type PlanRestore =
  | { readonly kind: "absent" }
  | {
      readonly kind: "valid";
      readonly plan: WorkerPlan;
      readonly nextStepNumber: number;
    }
  | { readonly kind: "malformed"; readonly nextStepNumber: number };
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
type OverviewPatch = Extract<WorkerPlanToolInput, { readonly action: "update_overview" }>["patch"];

function createGuidePlan(input: GuidePlanInput, firstStepNumber: number): WorkerPlan | undefined {
  if (input.steps.length > Number.MAX_SAFE_INTEGER - firstStepNumber || firstStepNumber < 1)
    return undefined;
  return {
    ...input,
    steps: input.steps.map((step, index) => ({
      ...step,
      id: `step-${firstStepNumber + index}`,
    })),
  };
}

function patchedStep(step: PlanStep, patch: StepPatch): PlanStep {
  return { ...step, ...patch };
}

function applyOverviewPatch(current: WorkerPlan, patch: OverviewPatch) {
  return Effect.gen(function* () {
    if (Object.keys(patch).length === 0)
      return yield* contractFailure(
        "Updating the plan overview requires at least one of approach, rationale, or risks; no changes were made.",
      );
    const next: WorkerPlan = {
      ...current,
      ...patch,
      steps: current.steps.map((step) => ({ ...step })),
    };
    const failure = planValidationFailure(next);
    if (failure !== undefined) return yield* contractFailure(`${failure}; no changes were made.`);
    return next;
  });
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
    const failure = planValidationFailure(next);
    if (failure !== undefined) return yield* contractFailure(`${failure}; no changes were made.`);
    return next;
  });
}

function applyStepAddition(
  current: WorkerPlan,
  text: string,
  afterId: string | undefined,
  nextStepNumber: number,
) {
  return Effect.gen(function* () {
    let insertAt = current.steps.length;
    if (afterId !== undefined) {
      const anchor = current.steps.findIndex((step) => step.id === afterId);
      if (anchor < 0)
        return yield* contractFailure(
          `Unknown anchor step id: ${afterId}. No changes were made; use workgraph_plan get to inspect stable step IDs.`,
        );
      insertAt = anchor + 1;
    }
    if (!Number.isSafeInteger(nextStepNumber) || nextStepNumber >= Number.MAX_SAFE_INTEGER)
      return yield* contractFailure(
        "No stable step ID remains in the current plan; no changes were made.",
      );
    const retained = current.steps.map((step) => ({ ...step }));
    retained.splice(insertAt, 0, {
      id: `step-${nextStepNumber}`,
      text,
      status: "pending",
    });
    const next: WorkerPlan = { ...current, steps: retained };
    const failure = planValidationFailure(next);
    if (failure !== undefined) return yield* contractFailure(`${failure}; no changes were made.`);
    return { plan: next, nextStepNumber: nextStepNumber + 1 };
  });
}

function applyStepRemoval(current: WorkerPlan, id: string, reason: string) {
  return Effect.gen(function* () {
    const index = current.steps.findIndex((step) => step.id === id);
    if (index < 0)
      return yield* contractFailure(
        `Unknown step id: ${id}. No changes were made; use workgraph_plan get to inspect stable step IDs.`,
      );
    if (current.steps.length === 1)
      return yield* contractFailure(
        "The current plan must retain at least one step; update or replace the last step instead. No changes were made.",
      );
    const next: WorkerPlan = {
      ...current,
      steps: current.steps
        .filter((_step, stepIndex) => stepIndex !== index)
        .map((step) => ({ ...step })),
    };
    const failure = planValidationFailure(next);
    if (failure !== undefined) return yield* contractFailure(`${failure}; no changes were made.`);
    return { plan: next, removed: { id, reason } };
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
  const workerMode: WorkerSessionMode = mode;
  const { runId, nodeId, executorModel, executorThinking, baseCommit } = environment;
  const generation = { runId, nodeId };
  const continued = environment.implementationStart === "executor";
  const experiment = environment.experiment === "1";
  const policyRole = Effect.runSync(readPolicyRole(environment.policyRole, workerMode, experiment));
  const systemPolicy = workerSystemPolicy(policyRole);
  let phase: "guide" | "executor" = mode === "implementation" && !continued ? "guide" : "executor";
  let plan: WorkerPlan | undefined;
  let nextStepNumber = 1;
  let planStatus: PlanRestore["kind"] = "absent";
  let planStateWarning: string | undefined;
  let stateWarning: string | undefined;
  let reminderCount = 0;
  let terminal = false;
  let switchError: string | undefined;
  let switchedAt: string | undefined;
  let disabledTools = new Set<string>();

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

  function persistPlan(
    next: WorkerPlan,
    action: string,
    allocatedThrough = nextStepNumber,
    change?: { readonly removed: { readonly id: string; readonly reason: string } },
  ) {
    const persisted = structuredClone(next);
    pi.appendEntry("pi-workgraph-worker-plan", {
      ...generation,
      plan: persisted,
      nextStepNumber: allocatedThrough,
    });
    plan = next;
    nextStepNumber = allocatedThrough;
    planStatus = "valid";
    planStateWarning = undefined;
    return {
      content: [{ type: "text" as const, text: `Updated ${planText()}` }],
      details: {
        action,
        plan: structuredClone(next),
        planStatus,
        attempt: generation,
        change: change === undefined ? undefined : structuredClone(change),
      },
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
          "Only the guide phase may replace the full plan with workgraph_plan update. Use targeted get, update_overview, update_step, add_step, or remove_step to keep local implementation knowledge current within the inherited assignment, and escalate consequential conflicts instead of inferring new scope. No changes were made.",
        );
      if (input === undefined)
        return yield* contractFailure(
          "Updating the current plan requires a plan value. No changes were made.",
        );
      const created = createGuidePlan(input, nextStepNumber);
      if (created === undefined)
        return yield* contractFailure(
          "No stable step IDs remain for a full plan replacement. No changes were made.",
        );
      const failure = planValidationFailure(created);
      if (failure !== undefined) return yield* contractFailure(`${failure}; no changes were made.`);
      return persistPlan(created, "update", nextStepNumber + created.steps.length);
    });
  }

  type TargetedPlanInput = Extract<
    WorkerPlanToolInput,
    {
      readonly action: "update_step" | "update_overview" | "add_step" | "remove_step";
    }
  >;

  function handleTargetedEdit(targeted: TargetedPlanInput) {
    return Effect.gen(function* () {
      if (plan === undefined) return yield* missingPlanFailure();
      if (targeted.action === "update_step") {
        const next = yield* applyStepPatch(plan, targeted.id, targeted.patch);
        return persistPlan(next, "update_step");
      }
      if (targeted.action === "update_overview") {
        const next = yield* applyOverviewPatch(plan, targeted.patch);
        return persistPlan(next, "update_overview");
      }
      if (targeted.action === "add_step") {
        const next = yield* applyStepAddition(
          plan,
          targeted.text,
          targeted.after_id,
          nextStepNumber,
        );
        return persistPlan(next.plan, "add_step", next.nextStepNumber);
      }
      const next = yield* applyStepRemoval(plan, targeted.id, targeted.reason);
      return persistPlan(next.plan, "remove_step", nextStepNumber, { removed: next.removed });
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
        "Inspect one current implementation plan or apply one atomic targeted edit. The plan guides work but is not proof of correctness or completion.",
      promptSnippet: "Inspect or apply one atomic targeted edit to the current plan",
      promptGuidelines: [
        "Use workgraph_plan to inspect the current plan or apply one atomic targeted edit with stable step IDs; keep local implementation knowledge, steps, and notes current within the inherited assignment, plan statuses are navigation only, not evidence.",
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
  pi.registerTool({
    name: "workgraph_report",
    label: "Workgraph Report",
    description: "Return the terminal report for this bounded assignment.",
    promptSnippet: "Finish assigned work with a typed report",
    promptGuidelines: [
      "Use workgraph_report as the final action. Choose the status that matches the actual outcome; report failures as failed rather than implying completion, and include actual evidence and explicit limitations.",
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
      appendPhaseActivation(extension, ctx.sessionManager);
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
      const minimumNext = nextNumberAfter(decoded.plan.steps);
      const restoredNext = decoded.nextStepNumber;
      if (
        new Set(ids).size !== ids.length ||
        minimumNext === undefined ||
        restoredNext < minimumNext ||
        planValidationFailure(decoded.plan) !== undefined
      )
        return { kind: "malformed", nextStepNumber: 1 };
      return {
        kind: "valid",
        plan: structuredClone(decoded.plan),
        nextStepNumber: restoredNext,
      };
    }
    return { kind: "malformed", nextStepNumber: 1 };
  }

  function latestAttemptPlan(entries: SessionEntry[]): PlanRestore {
    let latest: PlanRestore = { kind: "absent" };
    let allocationFloor = 1;
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== "pi-workgraph-worker-plan") continue;
      if (!isCurrentAttemptData(entry.data)) continue;
      const restored = restorePlanEntry(entry.data);
      if (restored.kind === "valid")
        allocationFloor = Math.max(allocationFloor, restored.nextStepNumber);
      latest =
        restored.kind === "valid"
          ? { ...restored, nextStepNumber: allocationFloor }
          : { kind: "malformed", nextStepNumber: allocationFloor };
    }
    return latest;
  }

  function latestAttemptObjective(entries: SessionEntry[]): WorkerObjectiveRestore {
    for (const entry of [...entries].reverse()) {
      if (entry.type !== "custom_message" || entry.customType !== "pi-workgraph-objective")
        continue;
      if (!isCurrentAttemptData(entry.details)) continue;
      if (!Value.Check(ObjectiveContentSchema, entry.content)) return { kind: "malformed" };
      return { kind: "valid", content: Value.Decode(ObjectiveContentSchema, entry.content) };
    }
    return { kind: "absent" };
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
          ? "Current plan: unavailable because the latest current-attempt plan state was malformed. Recreate it with workgraph_plan update; do not treat the missing plan as evidence."
          : "Current plan: unavailable because the latest current-attempt plan state was malformed. Do not infer or author replacement direction; continue only with truthful work, report, or escalation within the inherited assignment and explain that no scope was inferred.";
      return phase === "guide"
        ? "Current plan: none recorded yet. Use workgraph_plan update only when a plan helps the assignment."
        : "Current plan: none recorded yet. Do not infer or author plan direction; continue only with truthful work, report, or escalation within the inherited assignment and explain that no scope was inferred.";
    }
    const steps = plan.steps
      .map(
        (step) =>
          `${step.id} ${step.status}: ${step.text}${step.note === undefined ? "" : ` — ${step.note}`}`,
      )
      .join("\n");
    return [
      "Current plan (navigation only; statuses are not correctness evidence):",
      `Approach: ${plan.approach}`,
      `Rationale: ${plan.rationale}`,
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

  function assignmentDisables(name: string): boolean {
    // Keep editing tools for implementation and authorized research experiments.
    // This filters model tool availability; bash remains available and is not sandboxed.
    const readOnly = mode !== "implementation" && !(mode === "research" && experiment);
    return readOnly && (name === "edit" || name === "write");
  }

  function isDisabled(name: string): boolean {
    return disabledTools.has(name) || assignmentDisables(name);
  }

  function reconcileWorkerTools(): void {
    const active = pi.getActiveTools();
    const allowed = active.filter((name) => !isDisabled(name));
    if (allowed.length !== active.length) pi.setActiveTools(allowed);
  }

  function restoreWorkerSession(branch: SessionEntry[]): void {
    phase = mode === "implementation" && !continued ? "guide" : "executor";
    nextStepNumber = 1;
    reminderCount = 0;
    switchError = undefined;
    switchedAt = undefined;
    terminal = hasTerminalReport(branch);
    const attempt = latestAttemptState(branch);
    stateWarning = attempt.malformed
      ? "The latest current-attempt worker state was malformed and was ignored; continue conservatively and report the limitation."
      : undefined;
    if (attempt.state !== undefined) reattachAttemptState(attempt.state);
    const restoredPlan = latestAttemptPlan(branch);
    planStatus = restoredPlan.kind;
    plan = restoredPlan.kind === "valid" ? restoredPlan.plan : undefined;
    if (restoredPlan.kind !== "absent") nextStepNumber = restoredPlan.nextStepNumber;
    planStateWarning =
      restoredPlan.kind === "malformed"
        ? "The latest current-attempt plan state was malformed and was ignored; continue conservatively and report the limitation."
        : undefined;
  }

  pi.on("session_start", (_event, ctx) =>
    loadWorkerDisabledTools()
      .catch(() => {
        ctx.ui.notify(
          "Could not load worker tool settings; configured tools remain available.",
          "warning",
        );
        return [];
      })
      .then((configuredTools) => {
        disabledTools = new Set(configuredTools);
        reconcileWorkerTools();
        restoreWorkerSession(ctx.sessionManager.getBranch());
      }),
  );
  pi.on("tool_call", (event) => {
    if (!isDisabled(event.toolName)) return;
    return {
      block: true,
      reason: `Tool ${event.toolName} is unavailable to this Workgraph worker.`,
    };
  });
  // A tool may register or activate another tool while executing. turn_end is
  // the last extension boundary before AgentSession snapshots tools for the
  // next provider request; tool_call above remains the race backstop.
  pi.on("turn_end", () => reconcileWorkerTools());
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
  function currentRecovery(session: ExtensionContext["sessionManager"], restorePlan: boolean) {
    const active = session.buildContextEntries();
    if (hasActiveRecovery(active, generation, phase)) return undefined;
    const objective = latestAttemptObjective(session.getBranch());
    const needsObjective = !hasActiveObjective(active, generation) || objective.kind !== "valid";
    const hasWarning = planStateWarning !== undefined || stateWarning !== undefined;
    if (!restorePlan && !needsObjective && !hasWarning) return undefined;
    const recovery = {
      identity: generation,
      mode: workerMode,
      phase,
      objective,
      warnings: [planStateWarning, stateWarning],
    };
    return workerMode === "implementation"
      ? recoveryMessage({ ...recovery, planText: planText() })
      : recoveryMessage(recovery);
  }

  function currentPhaseActivation(session: ExtensionContext["sessionManager"]) {
    if (mode !== "implementation") return undefined;
    return hasActivePhase(session.buildContextEntries(), generation, phase)
      ? undefined
      : phaseActivationMessage(generation, phase);
  }

  function appendPhaseActivation(
    extension: ExtensionAPI,
    session: ExtensionContext["sessionManager"],
  ): void {
    const message = currentPhaseActivation(session);
    if (message !== undefined) extension.sendMessage(message);
  }

  // Stable package policy stays in the system prefix. Assignment, phase, and
  // mutable plan state enter conversation history only at genuine boundaries.
  pi.on("session_compact", (_event, ctx) => {
    const snapshot = currentRecovery(ctx.sessionManager, mode === "implementation");
    if (snapshot !== undefined) pi.sendMessage(snapshot);
  });
  pi.on("before_agent_start", (event, ctx) => {
    reconcileWorkerTools();
    const recovery = currentRecovery(ctx.sessionManager, false);
    const message = recovery ?? currentPhaseActivation(ctx.sessionManager);
    const systemPrompt = `${event.systemPrompt}\n\n${systemPolicy}`;
    return message === undefined ? { systemPrompt } : { systemPrompt, message };
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
  report: Extract<ImplementationReportInput, { outcome: "no_change" }>,
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
  report: Extract<ImplementationReportInput, { outcome: "changed" }>,
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
