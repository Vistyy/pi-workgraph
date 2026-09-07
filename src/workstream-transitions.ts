import type {
  CompletionAccounting,
  HumanInputReceipt,
  HumanInputSource,
  SessionIdentity,
  WorkAssignment,
  WorkAttempt,
  WorkResult,
  WorkstreamState,
} from "./workstream-state.js";

export type WorkstreamMutator = (draft: WorkstreamState, now: Date) => void;

export function recordInputTransition(
  draft: WorkstreamState,
  input: {
    id: string;
    owner: SessionIdentity;
    source: Exclude<HumanInputSource, "extension">;
    text: string;
    receivedAt: string;
  },
): HumanInputReceipt {
  if (
    input.owner.sessionId !== draft.coordinator.sessionId ||
    input.owner.sessionFile !== draft.coordinator.sessionFile
  )
    throw new Error("Input receipt belongs to another session.");
  const previous = draft.inputs.find((item) => item.id === input.id);
  if (previous !== undefined) {
    validatePreviousInput(previous, input);
    return previous;
  }
  const receipt: HumanInputReceipt = {
    id: input.id,
    sessionId: input.owner.sessionId,
    sessionFile: input.owner.sessionFile,
    source: input.source,
    text: input.text.trim(),
    receivedAt: input.receivedAt,
  };
  draft.inputs.push(receipt);
  return receipt;
}

function validatePreviousInput(
  previous: HumanInputReceipt,
  input: { source: Exclude<HumanInputSource, "extension">; text: string; owner: SessionIdentity },
): void {
  if (
    previous.text !== input.text.trim() ||
    previous.source !== input.source ||
    previous.sessionId !== input.owner.sessionId ||
    previous.sessionFile !== input.owner.sessionFile
  )
    throw new Error("Conflicting input receipt.");
}

export function startAttemptTransition(
  attempt: WorkAttempt,
  input: {
    id: string;
    placement: NonNullable<WorkAttempt["placement"]>;
    baseRevision: string | undefined;
  },
): void {
  if (attempt.state === "starting") {
    if (
      sameValue(attempt.placement, input.placement) &&
      attempt.baseRevision === input.baseRevision
    )
      return;
    throw new Error(`Attempt ${input.id} has contradictory launch placement.`);
  }
  if (attempt.state !== "queued") throw new Error(`Attempt ${input.id} is not awaiting launch.`);
  attempt.state = "starting";
  attempt.placement = structuredClone(input.placement);
  if (input.baseRevision !== undefined) attempt.baseRevision = input.baseRevision;
  else delete attempt.baseRevision;
  attempt.submission = "not_sent";
}

/** Apply one domain transition without performing I/O. */
export function transitionWorkstreamState(
  current: WorkstreamState,
  mutator: WorkstreamMutator,
  now: Date,
): WorkstreamState {
  const draft = structuredClone(current);
  mutator(draft, now);
  if (sameValue(draft, current)) return structuredClone(current);
  draft.revision = current.revision + 1;
  draft.updatedAt = now.toISOString();
  return draft;
}

/** Mechanical completion entries derived from retained domain facts. */
export function deriveCompletionAccounting(state: WorkstreamState): CompletionAccounting[] {
  const accounting: CompletionAccounting[] = [];
  for (const assignment of state.assignments)
    if (!assignmentResolved(state, assignment))
      accounting.push({
        kind: "unresolved_assignment",
        assignmentId: assignment.id,
        reason: "Unresolved assignment requires coordinator accounting.",
      });
  for (const attempt of state.attempts)
    if (!attemptResolved(state, attempt))
      accounting.push({
        kind: "unresolved_attempt",
        attemptId: attempt.id,
        reason: "Unresolved attempt requires coordinator accounting.",
      });
  for (const result of state.results)
    if (resultUnresolved(state, result.id))
      accounting.push({
        kind: "unresolved_result",
        resultId: result.id,
        reason: "Unresolved result requires coordinator accounting.",
      });
  for (const delivery of state.deliveries)
    if (delivery.state === "pending")
      accounting.push({
        kind: "undelivered_result",
        resultId: delivery.resultId,
        reason: "Undelivered result requires coordinator accounting.",
      });
  return accounting;
}

export function accountingTaskId(
  state: WorkstreamState,
  item: CompletionAccounting,
): string | undefined {
  if (item.kind === "unresolved_assignment") return item.assignmentId;
  if (item.kind === "unresolved_attempt")
    return state.attempts.find((attempt) => attempt.id === item.attemptId)?.assignmentId;
  return state.results.find((result) => result.id === item.resultId)?.assignmentId;
}

export function accountingIdentity(item: CompletionAccounting): string {
  if (item.kind === "unresolved_assignment") return `${item.kind}:${item.assignmentId}`;
  if (item.kind === "unresolved_attempt") return `${item.kind}:${item.attemptId}`;
  return `${item.kind}:${item.resultId}`;
}

export function hasActiveOrUncleanAttempt(_state: WorkstreamState, attempt: WorkAttempt): boolean {
  if (["queued", "starting", "running", "cancel_requested"].includes(attempt.state)) return true;
  if (attempt.placement === undefined) return false;
  if (attempt.cleanup?.state !== "completed" || attempt.cleanup.workerClosed !== true) return true;
  if (attempt.application?.state === "pending" || attempt.application?.state === "blocked")
    return true;
  return attempt.outputRelease?.state === "pending" || attempt.outputRelease?.state === "blocked";
}

function assignmentResolved(state: WorkstreamState, assignment: WorkAssignment): boolean {
  // Resolution closes the assignment's original scope, not a later intent.
  // Every requested attempt is independent, so a later success cannot hide a failure.
  const attempts = state.attempts.filter((attempt) => attempt.assignmentId === assignment.id);
  if (attempts.length > 0) return attempts.every((attempt) => attemptResolved(state, attempt));
  if (assignment.capability === "implement") return false;
  const results = state.results.filter((result) => result.assignmentId === assignment.id);
  return results.length > 0 && results.every((result) => !resultUnresolved(state, result.id));
}

function attemptResolved(state: WorkstreamState, attempt: WorkAttempt): boolean {
  const result = resultForAttempt(state, attempt);
  if (result === undefined || resultUnresolved(state, result.id)) return false;
  const assignment = state.assignments.find((item) => item.id === attempt.assignmentId);
  return (
    result.validity === "typed" &&
    result.report.status === "completed" &&
    (assignment?.capability !== "implement" ||
      attempt.application?.state === "applied" ||
      (result.report.kind === "implementation" && result.report.outcome === "no_change"))
  );
}

function resultForAttempt(state: WorkstreamState, attempt: WorkAttempt): WorkResult | undefined {
  if (attempt.resultId === undefined) return undefined;
  return state.results.find((candidate) => candidate.id === attempt.resultId);
}

function resultUnresolved(state: WorkstreamState, resultId: string): boolean {
  const result = state.results.find((candidate) => candidate.id === resultId);
  // Judgment cannot repair failed, invalid, absent, or untyped evidence.
  if (result?.validity !== "typed" || result.report.status !== "completed") return true;
  return state.dispositions.some(
    (disposition) => disposition.resultId === resultId && disposition.status !== "accepted",
  );
}

function sameValue<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
