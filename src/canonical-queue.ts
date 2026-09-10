import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import {
  type Attempt,
  type CandidateLineage,
  type ModelSelection,
  ReviewSubjectSchema,
  type Task,
} from "./domain/workstream.js";
import {
  implementationTargets,
  type ModelPolicy,
  resolveSelection,
  type SelectionRequest,
  SelectionRequestSchema,
} from "./model-policy.js";

const NonEmptyString = Type.String({ minLength: 1 });
const Commit = Type.String({ pattern: "^[0-9a-f]{40,64}$" });
const TaskIdentity = { taskId: NonEmptyString };
const Objective = { objective: NonEmptyString };

export const CanonicalEnqueueCommandSchema = Type.Union([
  Type.Object(
    {
      ...TaskIdentity,
      ...Objective,
      kind: Type.Literal("research"),
      expectedEvidence: Type.Array(NonEmptyString, { minItems: 1 }),
      selection: Type.Optional(SelectionRequestSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...TaskIdentity,
      ...Objective,
      kind: Type.Literal("experiment"),
      permittedEffects: Type.Array(NonEmptyString, { minItems: 1 }),
      stopCondition: NonEmptyString,
      expectedEvidence: Type.Array(NonEmptyString, { minItems: 1 }),
      selection: Type.Optional(SelectionRequestSchema),
      baseRevision: Type.Optional(Commit),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...TaskIdentity,
      ...Objective,
      kind: Type.Literal("implementation"),
      acceptance: Type.Array(NonEmptyString, { minItems: 1 }),
      useEscalationExecutor: Type.Optional(Type.Boolean()),
      baseRevision: Type.Optional(Commit),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...TaskIdentity,
      ...Objective,
      kind: Type.Literal("review"),
      subject: ReviewSubjectSchema,
      concern: NonEmptyString,
      selection: Type.Optional(SelectionRequestSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...TaskIdentity,
      ...Objective,
      kind: Type.Literal("consultation"),
      context: Type.Optional(Type.String({ maxLength: 20_000 })),
      selection: Type.Optional(SelectionRequestSchema),
    },
    { additionalProperties: false },
  ),
]);
export type CanonicalEnqueueCommand = Static<typeof CanonicalEnqueueCommandSchema>;

export const CanonicalAppendCommandSchema = Type.Object(
  {
    taskId: NonEmptyString,
    continuationOf: Type.Optional(NonEmptyString),
    candidateOf: Type.Optional(NonEmptyString),
    baseRevision: Type.Optional(Commit),
    selection: Type.Optional(SelectionRequestSchema),
    useEscalationExecutor: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type CanonicalAppendCommand = Static<typeof CanonicalAppendCommandSchema>;

export interface ResolvedQueueFacts {
  readonly baseRevision?: string;
  readonly candidate?: CandidateLineage;
}

export interface EnqueuePlan {
  readonly taskId: string;
  readonly command: CanonicalEnqueueCommand;
  readonly attemptCount: number;
  materialize(
    attemptIds: readonly string[],
    now: string,
    intentIndex: number,
    facts: ResolvedQueueFacts,
  ): Task;
}

export interface AppendPlan {
  readonly attemptCount: number;
  materialize(attemptIds: readonly string[], now: string, facts: ResolvedQueueFacts): Attempt[];
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The strict enqueue schema decodes this external boundary value.
export function decodeEnqueue(value: unknown): CanonicalEnqueueCommand {
  // SAFETY: strict schema validation in decodeCommand establishes the complete enqueue shape.
  return decodeCommand(
    CanonicalEnqueueCommandSchema,
    value,
    "canonical enqueue command",
  ) as CanonicalEnqueueCommand;
}

export function planEnqueue(command: CanonicalEnqueueCommand, policy: ModelPolicy): EnqueuePlan {
  const selections = taskSelections(command, policy);
  return {
    taskId: command.taskId,
    command,
    attemptCount: selections.length,
    materialize: (attemptIds, now, intentIndex, facts) => {
      if (attemptIds.length !== selections.length)
        throw new Error(
          "Canonical Task materialization requires one identity per resolved Attempt.",
        );
      const attempts = selections.map((selection, index) =>
        queuedAttempt(exactId(attemptIds, index), selection, now, facts),
      );
      return taskFor(command, command.taskId, attempts, now, intentIndex);
    },
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The strict append schema decodes this external boundary value.
export function decodeAppend(value: unknown): CanonicalAppendCommand {
  // SAFETY: strict schema validation in decodeCommand establishes the complete append shape.
  return decodeCommand(
    CanonicalAppendCommandSchema,
    value,
    "canonical append command",
  ) as CanonicalAppendCommand;
}

export function planAppend(
  command: CanonicalAppendCommand,
  kind: Task["kind"],
  policy: ModelPolicy,
): AppendPlan {
  if (command.continuationOf !== undefined && command.candidateOf !== undefined)
    throw new Error("candidateOf and continuationOf cannot be combined.");
  const selections = appendSelections(command, kind, policy);
  return {
    attemptCount: selections.length,
    materialize: (attemptIds, now, facts) => {
      if (attemptIds.length !== selections.length)
        throw new Error("Canonical Attempt append requires one identity per resolved selection.");
      return selections.map((selection, index) => {
        const continuation = index === 0 ? command.continuationOf : undefined;
        return queuedAttempt(
          exactId(attemptIds, index),
          selection,
          now,
          continuation === undefined ? facts : { ...facts, continuationOf: continuation },
        );
      });
    },
  };
}

function taskSelections(
  command: CanonicalEnqueueCommand,
  policy: ModelPolicy,
): readonly ModelSelection[] {
  switch (command.kind) {
    case "research":
    case "experiment":
      return listSelections("research", command.selection, policy, "research");
    case "review":
      return listSelections("review", command.selection, policy, "review");
    case "consultation":
      return listSelections("consultation.advisor", command.selection, policy, "consultation");
    case "implementation":
      return [implementationSelection(policy, command.useEscalationExecutor === true)];
  }
}

function appendSelections(
  command: CanonicalAppendCommand,
  kind: Task["kind"],
  policy: ModelPolicy,
): readonly ModelSelection[] {
  switch (kind) {
    case "research":
    case "experiment":
      rejectAppendFields(command, ["candidateOf", "useEscalationExecutor"], kind);
      if (kind === "research") rejectAppendFields(command, ["baseRevision"], kind);
      return listSelections("research", command.selection, policy, "research");
    case "review":
      rejectAppendFields(command, ["candidateOf", "useEscalationExecutor", "baseRevision"], kind);
      return listSelections("review", command.selection, policy, "review");
    case "consultation":
      rejectAppendFields(command, ["candidateOf", "useEscalationExecutor", "baseRevision"], kind);
      return listSelections("consultation.advisor", command.selection, policy, "consultation");
    case "implementation":
      rejectAppendFields(command, ["selection"], kind);
      return [implementationSelection(policy, command.useEscalationExecutor === true)];
  }
}

function listSelections(
  policyRole: "research" | "review" | "consultation.advisor",
  request: SelectionRequest | undefined,
  policy: ModelPolicy,
  role: "research" | "review" | "consultation",
): readonly ModelSelection[] {
  return resolveSelection(policyRole, request, policy).selected.map((target) => ({
    role,
    target,
    source: "policy" as const,
  }));
}

function implementationSelection(policy: ModelPolicy, escalated: boolean): ModelSelection {
  const { guide, executor } = implementationTargets(policy, escalated);
  return { role: "implementation", guide, executor, source: "policy" };
}

function rejectAppendFields(
  command: CanonicalAppendCommand,
  fields: readonly (keyof CanonicalAppendCommand)[],
  kind: Task["kind"],
): void {
  for (const field of fields)
    if (command[field] !== undefined)
      throw new Error(`Field ${field} is not valid when appending a ${kind} Attempt.`);
}

function queuedAttempt(
  id: string,
  selection: ModelSelection,
  now: string,
  extra: ResolvedQueueFacts & { readonly continuationOf?: string },
): Attempt {
  const attempt: Attempt = {
    id,
    state: "queued",
    createdAt: now,
    updatedAt: now,
    selection: structuredClone(selection),
  };
  if (extra.continuationOf !== undefined) attempt.continuationOf = extra.continuationOf;
  if (extra.baseRevision !== undefined) attempt.baseRevision = extra.baseRevision;
  if (extra.candidate !== undefined) attempt.candidate = structuredClone(extra.candidate);
  return attempt;
}

function taskFor(
  command: CanonicalEnqueueCommand,
  id: string,
  attempts: Attempt[],
  now: string,
  intentIndex: number,
): Task {
  const base = { id, objective: command.objective, intentIndex, createdAt: now, attempts };
  switch (command.kind) {
    case "research":
      return { ...base, kind: "research", expectedEvidence: [...command.expectedEvidence] };
    case "experiment":
      return {
        ...base,
        kind: "experiment",
        permittedEffects: [...command.permittedEffects],
        stopCondition: command.stopCondition,
        expectedEvidence: [...command.expectedEvidence],
      };
    case "implementation":
      return { ...base, kind: "implementation", acceptance: [...command.acceptance] };
    case "review":
      return {
        ...base,
        kind: "review",
        subject: structuredClone(command.subject),
        concern: command.concern,
      };
    case "consultation":
      return command.context === undefined
        ? { ...base, kind: "consultation" }
        : { ...base, kind: "consultation", context: command.context };
  }
}

function exactId(ids: readonly string[], index: number): string {
  const id = ids[index];
  if (id === undefined) throw new Error("Canonical Attempt identity is missing.");
  return id;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- This local decoder validates before returning to a named command decoder.
function decodeCommand(schema: TSchema, value: unknown, label: string): unknown {
  if (!Value.Check(schema, value)) {
    const issue = Value.Errors(schema, value)[0];
    const location =
      issue?.instancePath !== undefined && issue.instancePath !== "" ? issue.instancePath : "/";
    throw new Error(`Invalid ${label} at ${location}: ${issue?.message ?? "schema mismatch"}.`);
  }
  return Value.Decode(schema, value);
}
