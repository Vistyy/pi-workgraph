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

type CheckoutDisposition = "preserved_or_uncertain" | "removed";
type PreserveSource = "historical" | "cleanup_blocked" | "uncertain";
type PendingOutputDisposition =
  | { kind: "not_applicable" }
  | { kind: "remove_checkout_and_branch"; checkout: CheckoutDisposition }
  | { kind: "retain_branch"; checkout: CheckoutDisposition; commit?: string }
  | { kind: "preserve_checkout"; reason: string; source: PreserveSource };

export type OutputDisposition =
  | (PendingOutputDisposition & { release: "not_ready" | "ready" })
  | { kind: "released"; release: "not_ready" | "completed" };

/**
 * Classify the complete retained output contract. Placement owns exact paths/branches, cleanup owns
 * the fenced HEAD, and only the predecessor path artifact is interpreted as physical-output proof.
 */
export function outputDisposition(
  assignment: WorkAssignment | undefined,
  attempt: WorkAttempt,
  result: WorkResult | undefined,
): OutputDisposition {
  if (attempt.outputRelease?.state === "completed")
    return {
      kind: "released",
      release: isExactCompletedRelease(assignment, attempt) ? "completed" : "not_ready",
    };
  const pending = pendingOutputDisposition(assignment, attempt, result);
  return { ...pending, release: outputReleaseReadiness(pending, attempt) };
}

function isExactCompletedRelease(
  assignment: WorkAssignment | undefined,
  attempt: WorkAttempt,
): boolean {
  const { cleanup, outputRelease: release } = attempt;
  return (
    assignment !== undefined &&
    release?.state === "completed" &&
    release.error === undefined &&
    ["settled", "failed", "cancelled"].includes(attempt.state) &&
    attempt.placement?.kind === "isolated_worktree" &&
    cleanup?.workerClosed === true &&
    (cleanup.state === "blocked" || cleanup.state === "completed") &&
    cleanup.expectedHead !== undefined &&
    cleanup.expectedHead === release.expectedHead
  );
}

function pendingOutputDisposition(
  assignment: WorkAssignment | undefined,
  attempt: WorkAttempt,
  result: WorkResult | undefined,
): PendingOutputDisposition {
  const placement = attempt.placement;
  if (assignment === undefined || placement?.kind !== "isolated_worktree")
    return { kind: "not_applicable" };
  const preserved = preservedOutputDisposition(attempt, result);
  if (preserved !== undefined) return preserved;
  const checkout = attempt.cleanup?.state === "completed" ? "removed" : "preserved_or_uncertain";
  const usefulBranch = usefulBranchFor(assignment, attempt, result);
  return usefulBranch === undefined
    ? { kind: "remove_checkout_and_branch", checkout }
    : { kind: "retain_branch", checkout, ...usefulBranch };
}

function outputReleaseReadiness(
  disposition: PendingOutputDisposition,
  attempt: WorkAttempt,
): "not_ready" | "ready" {
  return ["retain_branch", "preserve_checkout"].includes(disposition.kind) &&
    ["settled", "failed", "cancelled"].includes(attempt.state) &&
    attempt.cleanup?.workerClosed === true &&
    (attempt.cleanup.state === "blocked" || attempt.cleanup.state === "completed")
    ? "ready"
    : "not_ready";
}

function preservedOutputDisposition(
  attempt: WorkAttempt,
  result: WorkResult | undefined,
): PendingOutputDisposition | undefined {
  if (hasLegacyRetainedOutputWorktree(attempt, result))
    return preserveCheckout(
      "Historical retained-worktree evidence requires exact release.",
      result?.validity === "typed" && result.report.status === "completed"
        ? "historical"
        : "uncertain",
    );
  if (attempt.cleanup?.state === "blocked")
    return preserveCheckout(
      attempt.cleanup.error ??
        "Cleanup is blocked; inspect the physical output and explicitly release it.",
      "cleanup_blocked",
    );
  if (
    attempt.state === "cancelled" ||
    result?.validity !== "typed" ||
    result.report.status !== "completed"
  )
    return preserveCheckout(
      "Isolated output is failed, cancelled, malformed, dirty, or uncertain; inspect it and explicitly release the exact attempt.",
      "uncertain",
    );
  return undefined;
}

function preserveCheckout(
  reason: string,
  source: PreserveSource,
): Extract<PendingOutputDisposition, { kind: "preserve_checkout" }> {
  return { kind: "preserve_checkout", reason, source };
}

function usefulBranchFor(
  assignment: WorkAssignment,
  attempt: WorkAttempt,
  result: WorkResult | undefined,
): { commit?: string } | undefined {
  if (
    assignment.artifactIntent === "disposable_experiment" &&
    (attempt.baseRevision === undefined ||
      (attempt.cleanup?.expectedHead !== undefined &&
        attempt.cleanup.expectedHead !== attempt.baseRevision))
  )
    return {};
  if (
    assignment.capability === "implement" &&
    result?.validity === "typed" &&
    result.report.kind === "implementation" &&
    result.report.status === "completed" &&
    result.report.outcome === "changed"
  )
    return result.report.commit === undefined ? {} : { commit: result.report.commit };
  return undefined;
}

/** The bounded historical artifact that proves a predecessor checkout may still exist. */
function hasLegacyRetainedOutputWorktree(
  attempt: WorkAttempt,
  result: WorkResult | undefined,
): boolean {
  const placement = attempt.placement;
  return (
    placement?.kind === "isolated_worktree" &&
    result?.artifacts.some(
      (artifact) =>
        artifact.id === "retained-output-worktree" &&
        artifact.kind === "path" &&
        artifact.reference === placement.path &&
        artifact.retention === "retained",
    ) === true
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

export function hasActiveOrUncleanAttempt(state: WorkstreamState, attempt: WorkAttempt): boolean {
  if (["queued", "starting", "running", "cancel_requested"].includes(attempt.state)) return true;
  if (attempt.placement === undefined) return false;
  const assignment = state.assignments.find((item) => item.id === attempt.assignmentId);
  const disposition = outputDisposition(assignment, attempt, resultForAttempt(state, attempt));
  if (disposition.kind === "not_applicable")
    return attempt.cleanup?.state !== "completed" || attempt.cleanup.workerClosed !== true;
  if (attempt.application?.state === "pending" || attempt.application?.state === "blocked")
    return true;
  if (disposition.kind === "released") return disposition.release !== "completed";
  if (disposition.kind === "preserve_checkout") return true;
  if (disposition.checkout === "preserved_or_uncertain") return true;
  if (attempt.outputRelease?.state === "pending" || attempt.outputRelease?.state === "blocked")
    return true;
  return false;
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
