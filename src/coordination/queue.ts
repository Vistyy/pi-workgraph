import type { Attempt, ModelSelection, Task } from "../domain/workstream.js";
import {
  configuredTarget,
  implementationTargets,
  type ModelPolicy,
  resolveSelection,
  type SelectionRequest,
} from "../model-policy.js";
import {
  decodeCommand,
  type ResolvedQueueFacts,
  type WorkstreamAppendCommand,
  WorkstreamAppendCommandSchema,
  type WorkstreamEnqueueCommand,
  WorkstreamEnqueueCommandSchema,
} from "./commands.js";

export interface EnqueuePlan {
  readonly taskId: string;
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
export function decodeEnqueue(value: unknown): WorkstreamEnqueueCommand {
  // SAFETY: strict schema validation in decodeCommand establishes the complete enqueue shape.
  return decodeCommand(
    WorkstreamEnqueueCommandSchema,
    value,
    "workstream enqueue command",
  ) as WorkstreamEnqueueCommand;
}

export function planEnqueue(command: WorkstreamEnqueueCommand, policy: ModelPolicy): EnqueuePlan {
  const selections = taskSelections(command, policy);
  return {
    taskId: command.taskId,
    attemptCount: selections.length,
    materialize: (attemptIds, now, intentIndex, facts) => {
      if (attemptIds.length !== selections.length)
        throw new Error(
          "Workstream Task materialization requires one identity per resolved Attempt.",
        );
      const attempts = selections.map((selection, index) =>
        queuedAttempt(exactId(attemptIds, index), selection, now, facts),
      );
      return taskFor(command, command.taskId, attempts, now, intentIndex);
    },
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The strict append schema decodes this external boundary value.
export function decodeAppend(value: unknown): WorkstreamAppendCommand {
  // SAFETY: strict schema validation in decodeCommand establishes the complete append shape.
  return decodeCommand(
    WorkstreamAppendCommandSchema,
    value,
    "workstream append command",
  ) as WorkstreamAppendCommand;
}

export function planAppend(
  command: WorkstreamAppendCommand,
  task: Task,
  policy: ModelPolicy,
): AppendPlan {
  if (command.continuationOf !== undefined && command.candidateOf !== undefined)
    throw new Error("candidateOf and continuationOf cannot be combined.");
  const selections = appendSelections(command, task, policy);
  return {
    attemptCount: selections.length,
    materialize: (attemptIds, now, facts) => {
      if (attemptIds.length !== selections.length)
        throw new Error("Workstream Attempt append requires one identity per resolved selection.");
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
  command: WorkstreamEnqueueCommand,
  policy: ModelPolicy,
): readonly ModelSelection[] {
  switch (command.kind) {
    case "research":
    case "experiment":
      return listSelections("research", command.selection, policy, "research");
    case "review":
      return listSelections("review", command.selection, policy, "review");
    case "consultation":
      return [consultationSelection(policy, command.advisor)];
    case "implementation":
      return [implementationSelection(policy, command.useEscalationExecutor === true)];
  }
}

function appendSelections(
  command: WorkstreamAppendCommand,
  task: Task,
  policy: ModelPolicy,
): readonly ModelSelection[] {
  const kind = task.kind;
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
      rejectAppendFields(
        command,
        ["candidateOf", "useEscalationExecutor", "baseRevision", "selection"],
        kind,
      );
      return [consultationTaskSelection(task, policy)];
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

function consultationSelection(policy: ModelPolicy, advisor?: string): ModelSelection {
  return {
    role: "consultation",
    target: configuredTarget(policy, "consultation.advisor", advisor),
    source: "policy",
  };
}

function consultationTaskSelection(
  task: Extract<Task, { kind: "consultation" }>,
  policy: ModelPolicy,
) {
  const selection = task.attempts[0]?.selection;
  if (selection?.role !== "consultation")
    throw new Error(`Consultation Task ${task.id} has no exact advisor selection.`);
  const configured = configuredTarget(policy, "consultation.advisor", selection.target.model);
  if (configured.thinking !== selection.target.thinking)
    throw new Error(`Consultation Task ${task.id} advisor selection is no longer configured.`);
  return structuredClone(selection);
}

function implementationSelection(policy: ModelPolicy, escalated: boolean): ModelSelection {
  const { guide, executor } = implementationTargets(policy, escalated);
  return { role: "implementation", guide, executor, source: "policy" };
}

function rejectAppendFields(
  command: WorkstreamAppendCommand,
  fields: readonly (keyof WorkstreamAppendCommand)[],
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
  command: WorkstreamEnqueueCommand,
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
  if (id === undefined) throw new Error("Workstream Attempt identity is missing.");
  return id;
}
