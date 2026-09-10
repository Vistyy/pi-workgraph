/**
 * Canonical queue construction. TypeBox owns the externalizable command
 * shape; this module resolves settled model policy into exact Attempt
 * selections and materializes immutable Tasks/Attempts without IO or identity.
 */
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import {
  type Attempt,
  type CandidateLineage,
  CandidateLineageSchema,
  type ModelSelection,
  ReviewSubjectSchema,
  type Task,
} from "./domain/workstream.js";
import {
  configuredTarget,
  implementationTargets,
  type ModelPolicy,
  resolveSelection,
  type SelectionRequest,
  SelectionRequestSchema,
} from "./model-policy.js";

const NonEmptyString = Type.String({ minLength: 1 });
const Commit = Type.String({ pattern: "^[0-9a-f]{40,64}$" });
const Objective = { objective: NonEmptyString };

export const CanonicalEnqueueCommandSchema = Type.Union([
  Type.Object(
    {
      ...Objective,
      kind: Type.Literal("research"),
      expectedEvidence: Type.Array(NonEmptyString, { minItems: 1 }),
      selection: Type.Optional(SelectionRequestSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...Objective,
      kind: Type.Literal("experiment"),
      permittedEffects: Type.Array(NonEmptyString, { minItems: 1 }),
      stopCondition: NonEmptyString,
      expectedEvidence: Type.Array(NonEmptyString, { minItems: 1 }),
      selection: Type.Optional(SelectionRequestSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...Objective,
      kind: Type.Literal("implementation"),
      acceptance: Type.Array(NonEmptyString, { minItems: 1 }),
      useEscalationExecutor: Type.Optional(Type.Boolean()),
      baseRevision: Type.Optional(Commit),
      candidate: Type.Optional(CandidateLineageSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
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
      ...Objective,
      kind: Type.Literal("consultation"),
      context: Type.Optional(Type.String({ maxLength: 20_000 })),
      advisorModel: Type.Optional(NonEmptyString),
    },
    { additionalProperties: false },
  ),
]);
export type CanonicalEnqueueCommand = Static<typeof CanonicalEnqueueCommandSchema>;

export const CanonicalAppendCommandSchema = Type.Object(
  {
    taskId: NonEmptyString,
    continuationOf: Type.Optional(NonEmptyString),
    selection: Type.Optional(SelectionRequestSchema),
    advisorModel: Type.Optional(NonEmptyString),
    useEscalationExecutor: Type.Optional(Type.Boolean()),
    baseRevision: Type.Optional(Commit),
    candidate: Type.Optional(CandidateLineageSchema),
  },
  { additionalProperties: false },
);
export type CanonicalAppendCommand = Static<typeof CanonicalAppendCommandSchema>;

export interface EnqueueTaskIds {
  readonly taskId: string;
  readonly attemptIds: readonly string[];
}

export interface EnqueuePlan {
  readonly attemptCount: number;
  materialize(ids: EnqueueTaskIds, now: string, intentIndex: number): Task;
}

export interface AppendPlan {
  readonly attemptCount: number;
  materialize(attemptIds: readonly string[], now: string): Attempt[];
}

/**
 * Validate a new-Task command and resolve its exact Attempt selections before
 * any identity exists. Fanout Tasks create one Attempt per resolved target.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Queue commands are external boundary values validated by this strict decoder.
export function planEnqueue(value: unknown, policy: ModelPolicy): EnqueuePlan {
  const command = decodeEnqueue(value);
  const selections = taskSelections(command, policy);
  // Based implementation work preserves exact supplied base/lineage facts
  // verbatim; the queue never infers a revision or inspects Git itself.
  const supplied: {
    readonly baseRevision?: string | undefined;
    readonly candidate?: CandidateLineage | undefined;
  } = command.kind === "implementation" ? command : {};
  return {
    attemptCount: selections.length,
    materialize: ({ taskId, attemptIds }, now, intentIndex) => {
      if (attemptIds.length !== selections.length)
        throw new Error(
          "Canonical Task materialization requires one identity per resolved Attempt.",
        );
      const attempts = selections.map((selection, index) =>
        queuedAttempt(exactId(attemptIds, index), selection, now, {
          baseRevision: supplied.baseRevision,
          candidate: supplied.candidate,
        }),
      );
      return taskFor(command, taskId, attempts, now, intentIndex);
    },
  };
}

/** Decode an append command; the owning Task kind is resolved by the caller. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Queue commands are external boundary values validated by this strict decoder.
export function decodeAppend(value: unknown): CanonicalAppendCommand {
  // SAFETY: strict schema validation establishes the complete append command shape.
  return decodeCommand(
    CanonicalAppendCommandSchema,
    value,
    "canonical append command",
  ) as CanonicalAppendCommand;
}

/**
 * Validate an append command against its owning Task kind and resolve its exact
 * Attempt selections before any identity exists. The canonical domain appends
 * the whole nonempty batch after settled prior Attempts in one transition, so
 * one resolved selection becomes one queued pristine Attempt and only the first
 * Attempt carries the requested `continuationOf`.
 */
export function planAppend(
  command: CanonicalAppendCommand,
  kind: Task["kind"],
  policy: ModelPolicy,
): AppendPlan {
  const selections = appendSelections(command, kind, policy);
  if (selections.length === 0)
    throw new Error(`Canonical Task ${command.taskId} requires at least one Attempt selection.`);
  return {
    attemptCount: selections.length,
    materialize: (attemptIds, now) => {
      if (attemptIds.length !== selections.length)
        throw new Error("Canonical Attempt append requires one identity per resolved selection.");
      return selections.map((selection, index) =>
        queuedAttempt(exactId(attemptIds, index), selection, now, {
          continuationOf: index === 0 ? command.continuationOf : undefined,
          baseRevision: command.baseRevision,
          candidate: command.candidate,
        }),
      );
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
      return readOnlySelections("research", command.selection, policy);
    case "review":
      return readOnlySelections("review", command.selection, policy);
    case "consultation":
      return [
        {
          role: "consultation",
          target: configuredTarget(policy, "consultation.advisor", command.advisorModel),
          source: "policy",
        },
      ];
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
      rejectAppendFields(
        command,
        ["advisorModel", "useEscalationExecutor", "baseRevision", "candidate"],
        kind,
      );
      return readOnlySelections("research", command.selection, policy);
    case "review":
      rejectAppendFields(
        command,
        ["advisorModel", "useEscalationExecutor", "baseRevision", "candidate"],
        kind,
      );
      return readOnlySelections("review", command.selection, policy);
    case "consultation":
      rejectAppendFields(
        command,
        ["selection", "useEscalationExecutor", "baseRevision", "candidate"],
        kind,
      );
      return [
        {
          role: "consultation",
          target: configuredTarget(policy, "consultation.advisor", command.advisorModel),
          source: "policy",
        },
      ];
    case "implementation":
      rejectAppendFields(command, ["selection", "advisorModel"], kind);
      return [implementationSelection(policy, command.useEscalationExecutor === true)];
  }
}

function readOnlySelections(
  role: "research" | "review",
  request: SelectionRequest | undefined,
  policy: ModelPolicy,
): readonly ModelSelection[] {
  return resolveSelection(role, request, policy).selected.map((target) => ({
    role,
    target,
    source: "policy" as const,
  }));
}

function implementationSelection(
  policy: ModelPolicy,
  useEscalationExecutor: boolean,
): ModelSelection {
  const { guide, executor } = implementationTargets(policy, useEscalationExecutor);
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
  extra: {
    readonly continuationOf?: string | undefined;
    readonly baseRevision?: string | undefined;
    readonly candidate?: CandidateLineage | undefined;
  },
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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Queue commands are external boundary values validated by this strict decoder.
function decodeEnqueue(value: unknown): CanonicalEnqueueCommand {
  // SAFETY: strict schema validation establishes the complete enqueue command shape.
  return decodeCommand(
    CanonicalEnqueueCommandSchema,
    value,
    "canonical enqueue command",
  ) as CanonicalEnqueueCommand;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Queue commands are external boundary values validated by this strict decoder.
function decodeCommand(schema: TSchema, value: unknown, label: string): unknown {
  if (!Value.Check(schema, value)) {
    const issue = Value.Errors(schema, value)[0];
    const location =
      issue?.instancePath !== undefined && issue.instancePath !== "" ? issue.instancePath : "/";
    throw new Error(`Invalid ${label} at ${location}: ${issue?.message ?? "schema mismatch"}.`);
  }
  return Value.Decode(schema, value);
}
