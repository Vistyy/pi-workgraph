import { includedByAppliedCandidateDescendant } from "./candidate.js";
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

/** Whether normal cleanup retains an isolated checkout as coordinator-owned output. */
export function cleanupRetainsOutput(
  assignment: WorkAssignment,
  attempt: WorkAttempt,
  result: WorkResult | undefined,
): boolean {
  const noChange =
    result?.validity === "typed" &&
    result.report.kind === "implementation" &&
    result.report.status === "completed" &&
    result.report.outcome === "no_change";
  return (
    assignment.artifactIntent === "disposable_experiment" ||
    (assignment.capability === "implement" && attempt.application?.state !== "applied" && !noChange)
  );
}

/** Mechanical completion entries derived from retained domain facts. */
export function deriveCompletionAccounting(state: WorkstreamState): CompletionAccounting[] {
  const accounting: CompletionAccounting[] = [];
  for (const assignment of state.assignments)
    if (!assignmentResolved(state, assignment))
      accounting.push({
        kind: "unresolved_assignment",
        assignmentId: assignment.id,
        reason: assignmentAccountingReason(state, assignment),
      });
  for (const attempt of state.attempts)
    if (!attemptResolved(state, attempt))
      accounting.push({
        kind: "unresolved_attempt",
        attemptId: attempt.id,
        reason: attemptAccountingReason(state, attempt),
      });
  for (const result of state.results)
    if (resultUnresolved(state, result.id))
      accounting.push({
        kind: "unresolved_result",
        resultId: result.id,
        reason: resultAccountingReason(result),
      });
  for (const delivery of state.deliveries)
    if (delivery.state === "pending")
      accounting.push({
        kind: "undelivered_result",
        resultId: delivery.resultId,
        reason: "Retained result delivery is pending.",
      });
  return accounting;
}

function assignmentAccountingReason(state: WorkstreamState, assignment: WorkAssignment): string {
  const attempts = state.attempts.filter((attempt) => attempt.assignmentId === assignment.id);
  if (attempts.length === 0) return "Assignment has no retained attempt result.";
  return "Assignment has an unresolved retained attempt or result.";
}

function attemptAccountingReason(state: WorkstreamState, attempt: WorkAttempt): string {
  const result = resultForAttempt(state, attempt);
  if (result === undefined) return "Attempt has no retained result.";
  if (result.validity !== "typed") return `Attempt result is ${result.validity}.`;
  if (result.report.status !== "completed")
    return `Attempt retained a ${result.report.status} ${result.report.kind} report.`;
  if (
    result.report.kind === "implementation" &&
    result.report.outcome === "changed" &&
    attempt.application?.state !== "applied" &&
    !includedByAppliedCandidateDescendant(state, attempt)
  )
    return "Completed implementation output is not applied or superseded by an applied candidate.";
  return "Attempt has no resolved completion outcome.";
}

function resultAccountingReason(result: WorkResult): string {
  if (result.validity !== "typed") return `Retained result is ${result.validity}.`;
  return `${result.report.kind} report status is ${result.report.status}.`;
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
      (result.report.kind === "implementation" && result.report.outcome === "no_change") ||
      (attempt.application === undefined && includedByAppliedCandidateDescendant(state, attempt)))
  );
}

function resultForAttempt(state: WorkstreamState, attempt: WorkAttempt): WorkResult | undefined {
  if (attempt.resultId === undefined) return undefined;
  return state.results.find((candidate) => candidate.id === attempt.resultId);
}

function resultUnresolved(state: WorkstreamState, resultId: string): boolean {
  const result = state.results.find((candidate) => candidate.id === resultId);
  return result?.validity !== "typed" || result.report.status !== "completed";
}

function sameValue<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
