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
      (result.report.kind === "implementation" && result.report.outcome === "no_change") ||
      (attempt.application === undefined && includedByAppliedCandidateDescendant(state, attempt)))
  );
}

type CandidateHistoryEntry = {
  attempt: WorkAttempt;
  commit: string;
};

/**
 * A successful correction application is one persisted proof that its direct ancestors were
 * included. The proof is deliberately structural: exact attempt links and result commits must
 * match the persisted ordered application history. A shared SHA without that lineage is not
 * evidence that an unrelated attempt was applied.
 */
function includedByAppliedCandidateDescendant(
  state: WorkstreamState,
  target: WorkAttempt,
): boolean {
  for (const descendant of state.attempts) {
    if (descendant.id === target.id) continue;
    const application = descendant.application;
    if (
      application?.state !== "applied" ||
      application.rootCommit === undefined ||
      application.commits === undefined ||
      application.revision !== application.commit
    )
      continue;
    const history = candidateHistory(state, descendant);
    if (history === undefined || !history.some((entry) => entry.attempt.id === target.id)) continue;
    const expectedCommits = history.map((entry) => entry.commit);
    if (
      application.rootCommit !== candidateRoot(history) ||
      application.commit !== expectedCommits.at(-1) ||
      !sameValues(application.commits, expectedCommits)
    )
      continue;
    return true;
  }
  return false;
}

function candidateHistory(
  state: WorkstreamState,
  tip: WorkAttempt,
): CandidateHistoryEntry[] | undefined {
  const tipAssignment = state.assignments.find((item) => item.id === tip.assignmentId);
  if (tipAssignment?.capability !== "implement") return undefined;
  const entries: CandidateHistoryEntry[] = [];
  const visited = new Set<string>();
  let current: WorkAttempt | undefined = tip;
  while (current !== undefined) {
    if (visited.has(current.id)) return undefined;
    visited.add(current.id);
    const entry = candidateHistoryEntry(state, current, tipAssignment.intentVersion);
    if (entry === undefined) return undefined;
    entries.push(entry);
    const candidate = candidateLineage(current);
    if (candidate?.kind === "initial") {
      const history = entries.reverse();
      return isCompleteCandidateHistory(history) ? history : undefined;
    }
    current = nextCandidateParent(state, candidate);
  }
  return undefined;
}

function candidateHistoryEntry(
  state: WorkstreamState,
  attempt: WorkAttempt,
  intentVersion: number,
): CandidateHistoryEntry | undefined {
  const assignment = state.assignments.find((item) => item.id === attempt.assignmentId);
  const result = resultForAttempt(state, attempt);
  const commit = changedImplementationCommit(result);
  if (
    assignment?.capability !== "implement" ||
    assignment.intentVersion !== intentVersion ||
    result?.assignmentIntentVersion !== assignment.intentVersion ||
    attempt.state !== "settled" ||
    attempt.cleanup?.state !== "completed" ||
    attempt.cleanup.workerClosed !== true ||
    commit === undefined ||
    candidateLineage(attempt) === undefined
  )
    return undefined;
  return { attempt, commit };
}

function isInitialCandidate(
  attempt: WorkAttempt,
  candidate: NonNullable<WorkAttempt["candidate"]>,
): boolean {
  return (
    candidate.rootCommit === attempt.baseRevision &&
    candidate.parentAttemptId === undefined &&
    candidate.parentCommit === undefined
  );
}

function isCompleteCandidateHistory(history: readonly CandidateHistoryEntry[]): boolean {
  const first = history[0];
  const firstCandidate = first === undefined ? undefined : candidateLineage(first.attempt);
  if (
    first === undefined ||
    firstCandidate === undefined ||
    firstCandidate.kind !== "initial" ||
    !isInitialCandidate(first.attempt, firstCandidate)
  )
    return false;
  const rootCommit = firstCandidate.rootCommit;
  return history.every((entry, index) => {
    const candidate = candidateLineage(entry.attempt);
    if (candidate === undefined || candidate.rootCommit !== rootCommit) return false;
    if (index === 0) return candidate.kind === "initial";
    const parent = history[index - 1];
    return (
      candidate.kind === "correction" &&
      candidate.parentAttemptId === parent?.attempt.id &&
      candidate.parentCommit === parent?.commit &&
      entry.attempt.baseRevision === parent?.commit
    );
  });
}

function nextCandidateParent(
  state: WorkstreamState,
  candidate: NonNullable<WorkAttempt["candidate"]> | undefined,
): WorkAttempt | undefined {
  if (
    candidate?.kind !== "correction" ||
    candidate.parentAttemptId === undefined ||
    candidate.parentCommit === undefined
  )
    return undefined;
  const parent = state.attempts.find((item) => item.id === candidate.parentAttemptId);
  return parent !== undefined && candidate.parentCommit === commitForAttempt(state, parent)
    ? parent
    : undefined;
}

function candidateRoot(history: readonly CandidateHistoryEntry[]): string | undefined {
  return history[0]?.attempt.candidate?.rootCommit ?? history[0]?.attempt.baseRevision;
}

function candidateLineage(
  attempt: Pick<WorkAttempt, "baseRevision" | "candidate">,
): NonNullable<WorkAttempt["candidate"]> | undefined {
  if (attempt.candidate !== undefined) return attempt.candidate;
  if (attempt.baseRevision !== undefined && /^[0-9a-f]{40,64}$/.test(attempt.baseRevision))
    return { kind: "initial", rootCommit: attempt.baseRevision };
  return undefined;
}

function changedImplementationCommit(result: WorkResult | undefined): string | undefined {
  if (
    result?.validity !== "typed" ||
    result.report.kind !== "implementation" ||
    result.report.status !== "completed" ||
    result.report.outcome !== "changed" ||
    !/^[0-9a-f]{40,64}$/.test(result.report.commit ?? "")
  )
    return undefined;
  return result.report.commit;
}

function commitForAttempt(state: WorkstreamState, attempt: WorkAttempt): string | undefined {
  return changedImplementationCommit(resultForAttempt(state, attempt));
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
