/* oxlint-disable typescript/no-this-alias -- Effect generators retain the state owner while yielding validation failures. */
import { Data, Effect } from "effect";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { isWorkerIdentityData, type WorkerContextIdentity } from "./worker-context.js";

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
export const WorkerPlanToolSchema = Type.Union(
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

export type WorkerPlan = Static<typeof WorkerPlanSchema>;
export type WorkerPlanToolInput = Static<typeof WorkerPlanToolSchema>;
export type PlanRestoreKind = "absent" | "valid" | "malformed";
export type WorkerAttemptIdentity = WorkerContextIdentity;
export interface WorkerPlanEntry {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}
type PlanChange = { readonly removed: { readonly id: string; readonly reason: string } };

export interface WorkerPlanToolResult {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly details: {
    readonly action: string;
    readonly plan: WorkerPlan | undefined;
    readonly planStatus: PlanRestoreKind;
    readonly attempt: WorkerAttemptIdentity;
    readonly change?: PlanChange | undefined;
  };
}

export class WorkerContractError extends Data.TaggedError("WorkerContractError")<{
  readonly message: string;
}> {}

// This is a resource ceiling, not a semantic step-count limit.
const MAX_SERIALIZED_PLAN_CHARACTERS = 24_000;
type GuidePlanInput = Static<typeof GuidePlanInputSchema>;
type StepPatch = Extract<WorkerPlanToolInput, { readonly action: "update_step" }>["patch"];
type OverviewPatch = Extract<WorkerPlanToolInput, { readonly action: "update_overview" }>["patch"];

type PlanRestore =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly plan: WorkerPlan; readonly nextStepNumber: number }
  | { readonly kind: "malformed"; readonly nextStepNumber: number };

function contractFailure(message: string) {
  return Effect.fail(new WorkerContractError({ message }));
}

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

function createGuidePlan(input: GuidePlanInput, firstStepNumber: number): WorkerPlan | undefined {
  if (input.steps.length > Number.MAX_SAFE_INTEGER - firstStepNumber || firstStepNumber < 1)
    return undefined;
  return {
    ...input,
    steps: input.steps.map((step, index) => ({ ...step, id: `step-${firstStepNumber + index}` })),
  };
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
        stepIndex === index ? { ...step, ...patch } : { ...step },
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
    retained.splice(insertAt, 0, { id: `step-${nextStepNumber}`, text, status: "pending" });
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

export class WorkerPlanState {
  plan: WorkerPlan | undefined;
  status: PlanRestoreKind = "absent";
  nextStepNumber = 1;
  warning: string | undefined;

  constructor(
    readonly identity: WorkerAttemptIdentity,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Pi custom-entry data is an external sink; this owner supplies its strictly constructed plan record.
    private readonly append: (customType: string, data: unknown) => void,
  ) {}

  restore(entries: readonly WorkerPlanEntry[]): void {
    const restored = this.latest(entries);
    this.status = restored.kind;
    this.plan = restored.kind === "valid" ? restored.plan : undefined;
    this.nextStepNumber = restored.kind === "absent" ? 1 : restored.nextStepNumber;
    this.warning =
      restored.kind === "malformed"
        ? "The latest current-attempt plan state was malformed and was ignored; continue conservatively and report the limitation."
        : undefined;
  }

  execute(
    input: WorkerPlanToolInput,
    phase: "guide" | "executor",
  ): Effect.Effect<WorkerPlanToolResult, WorkerContractError> {
    if (input.action === "get") return Effect.succeed(this.result("get", phase));
    if (input.action === "update") return this.guideUpdate(input.plan, phase);
    return this.targetedEdit(input);
  }

  text(phase: "guide" | "executor"): string {
    if (this.plan === undefined) {
      if (this.status === "malformed")
        return phase === "guide"
          ? "Current plan: unavailable because the latest current-attempt plan state was malformed. Recreate it with workgraph_plan update; do not treat the missing plan as evidence."
          : "Current plan: unavailable because the latest current-attempt plan state was malformed. Do not infer or author replacement direction; continue only with truthful work, report, or escalation within the inherited assignment and explain that no scope was inferred.";
      return phase === "guide"
        ? "Current plan: none recorded yet. Use workgraph_plan update only when a plan helps the assignment."
        : "Current plan: none recorded yet. Do not infer or author plan direction; continue only with truthful work, report, or escalation within the inherited assignment and explain that no scope was inferred.";
    }
    return [
      "Current plan (navigation only; statuses are not correctness evidence):",
      `Approach: ${this.plan.approach}`,
      `Rationale: ${this.plan.rationale}`,
      `Risks and unknowns: ${this.plan.risks || "none recorded"}`,
      "Steps:",
      this.plan.steps
        .map(
          (step) =>
            `${step.id} ${step.status}: ${step.text}${step.note === undefined ? "" : ` — ${step.note}`}`,
        )
        .join("\n"),
    ].join("\n");
  }

  hasActionableSteps(): boolean {
    return (
      this.plan?.steps.some((step) => step.status === "pending" || step.status === "in_progress") ??
      false
    );
  }

  private result(action: string, phase: "guide" | "executor"): WorkerPlanToolResult {
    return {
      content: [{ type: "text", text: this.text(phase) }],
      details: {
        action,
        plan: this.plan === undefined ? undefined : structuredClone(this.plan),
        planStatus: this.status,
        attempt: this.identity,
      },
    };
  }

  private persist(
    next: WorkerPlan,
    action: string,
    allocatedThrough = this.nextStepNumber,
    change?: PlanChange,
  ) {
    this.append("pi-workgraph-worker-plan", {
      ...this.identity,
      plan: structuredClone(next),
      nextStepNumber: allocatedThrough,
    });
    this.plan = next;
    this.nextStepNumber = allocatedThrough;
    this.status = "valid";
    this.warning = undefined;
    return {
      content: [{ type: "text" as const, text: `Updated ${this.text("executor")}` }],
      details: {
        action,
        plan: structuredClone(next),
        planStatus: this.status,
        attempt: this.identity,
        change: change === undefined ? undefined : structuredClone(change),
      },
    };
  }

  private guideUpdate(input: GuidePlanInput, phase: "guide" | "executor") {
    const self = this;
    return Effect.gen(function* () {
      if (phase !== "guide")
        return yield* contractFailure(
          "Only the guide phase may replace the full plan with workgraph_plan update. Use targeted get, update_overview, update_step, add_step, or remove_step to keep local implementation knowledge current within the inherited assignment, and escalate consequential conflicts instead of inferring new scope. No changes were made.",
        );
      const created = createGuidePlan(input, self.nextStepNumber);
      if (created === undefined)
        return yield* contractFailure(
          "No stable step IDs remain for a full plan replacement. No changes were made.",
        );
      const failure = planValidationFailure(created);
      if (failure !== undefined) return yield* contractFailure(`${failure}; no changes were made.`);
      return self.persist(created, "update", self.nextStepNumber + created.steps.length);
    });
  }

  private targetedEdit(input: Exclude<WorkerPlanToolInput, { readonly action: "get" | "update" }>) {
    const self = this;
    return Effect.gen(function* () {
      if (self.plan === undefined) return yield* self.missingPlanFailure();
      if (input.action === "update_step")
        return self.persist(yield* applyStepPatch(self.plan, input.id, input.patch), "update_step");
      if (input.action === "update_overview")
        return self.persist(yield* applyOverviewPatch(self.plan, input.patch), "update_overview");
      if (input.action === "add_step") {
        const next = yield* applyStepAddition(
          self.plan,
          input.text,
          input.after_id,
          self.nextStepNumber,
        );
        return self.persist(next.plan, "add_step", next.nextStepNumber);
      }
      const next = yield* applyStepRemoval(self.plan, input.id, input.reason);
      return self.persist(next.plan, "remove_step", self.nextStepNumber, { removed: next.removed });
    });
  }

  private missingPlanFailure() {
    return contractFailure(
      this.status === "malformed"
        ? "No valid current plan is available because the latest current-attempt plan state was malformed. Do not infer or author replacement direction; continue only with truthful work, report, or escalation within the inherited assignment and explain that no scope was inferred. No changes were made."
        : "No current plan is recorded yet. Do not infer or author plan direction; continue only with truthful work, report, or escalation within the inherited assignment and explain that no scope was inferred. No changes were made.",
    );
  }

  private latest(entries: readonly WorkerPlanEntry[]): PlanRestore {
    let latest: PlanRestore = { kind: "absent" };
    let allocationFloor = 1;
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== "pi-workgraph-worker-plan") continue;
      if (!this.isCurrentAttemptData(entry.data)) continue;
      const restored = this.restoreEntry(entry.data);
      if (restored.kind === "valid")
        allocationFloor = Math.max(allocationFloor, restored.nextStepNumber);
      latest =
        restored.kind === "valid"
          ? { ...restored, nextStepNumber: allocationFloor }
          : { kind: "malformed", nextStepNumber: allocationFloor };
    }
    return latest;
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The strict persisted-plan schema decodes this Pi session boundary.
  private restoreEntry(data: unknown): PlanRestore {
    if (Value.Check(WorkerPlanEntrySchema, data)) {
      const decoded = Value.Decode(WorkerPlanEntrySchema, data);
      const ids = decoded.plan.steps.map((step) => step.id);
      const minimumNext = nextNumberAfter(decoded.plan.steps);
      if (
        new Set(ids).size === ids.length &&
        minimumNext !== undefined &&
        decoded.nextStepNumber >= minimumNext &&
        planValidationFailure(decoded.plan) === undefined
      ) {
        return {
          kind: "valid",
          plan: structuredClone(decoded.plan),
          nextStepNumber: decoded.nextStepNumber,
        };
      }
    }
    return { kind: "malformed", nextStepNumber: 1 };
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Shared strict identity decoding owns this Pi session boundary.
  private isCurrentAttemptData(data: unknown): boolean {
    return isWorkerIdentityData(data, this.identity);
  }
}
