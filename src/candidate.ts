import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  type CandidateLineage,
  CandidateLineageSchema,
  CommitSchema,
  type WorkAssignment,
  type WorkAttempt,
  type WorkResult,
  type WorkstreamState,
} from "./workstream-state.js";

type CandidateAttempt = Pick<WorkAttempt, "id" | "baseRevision" | "candidate">;
type CandidateAssignment = Pick<WorkAssignment, "capability" | "intentVersion">;

type CandidateApplicationRecord = {
  state?: "pending" | "applied" | "blocked";
  commit: string;
  expectedRef?: string | undefined;
  rootCommit?: string | undefined;
  commits?: string[] | undefined;
  revision?: string | undefined;
};

/** Return the explicit content lineage, or the historical implicit initial candidate. */
export function candidateLineageForAttempt(
  attempt: Pick<WorkAttempt, "baseRevision" | "candidate">,
): CandidateLineage | undefined {
  if (attempt.candidate !== undefined) return attempt.candidate;
  if (attempt.baseRevision !== undefined && Value.Check(CommitSchema, attempt.baseRevision))
    return { kind: "initial", rootCommit: attempt.baseRevision };
  return undefined;
}

/** Locate the exact persisted parent named by a candidate, without inferring another parent. */
export function candidateParent(
  state: WorkstreamState,
  candidate: CandidateLineage,
): WorkAttempt | undefined {
  if (candidate.parentAttemptId === undefined) return undefined;
  return state.attempts.find((attempt) => attempt.id === candidate.parentAttemptId);
}

/**
 * Validate candidate metadata shared by enqueue and persisted-state validation.
 * Lifecycle and current-intent checks belong to retainedCandidate and the runtime.
 */
export function candidateLineageIssue(
  state: WorkstreamState,
  assignment: CandidateAssignment,
  attempt: CandidateAttempt,
): string | undefined {
  const candidate = attempt.candidate;
  if (candidate === undefined) return undefined;
  const baseIssue = candidateBaseIssue(assignment, attempt, candidate);
  if (baseIssue !== undefined || candidate.kind === "initial") return baseIssue;
  return candidateParentIssue(state, assignment, attempt, candidate);
}

function candidateBaseIssue(
  assignment: CandidateAssignment,
  attempt: CandidateAttempt,
  candidate: CandidateLineage,
): string | undefined {
  if (assignment.capability !== "implement")
    return "Candidate lineage is available only for maintained implementations.";
  if (attempt.baseRevision === undefined || !Value.Check(CommitSchema, attempt.baseRevision))
    return "Candidate lineage requires an exact assigned base revision.";
  if (!Value.Check(CandidateLineageSchema, candidate))
    return "Candidate lineage has an invalid shape.";
  if (candidate.kind === "initial") {
    return isInitialCandidate(attempt, candidate)
      ? undefined
      : "Initial candidate lineage must be rooted at its assigned base.";
  }
  return candidate.parentAttemptId === undefined || candidate.parentCommit === undefined
    ? `${candidate.kind} candidate lineage requires a parent attempt and commit.`
    : undefined;
}

function candidateParentIssue(
  state: WorkstreamState,
  assignment: CandidateAssignment,
  attempt: CandidateAttempt,
  candidate: CandidateLineage,
): string | undefined {
  const parentCommit = candidate.parentCommit;
  if (parentCommit === undefined) return "Candidate lineage has no exact parent commit.";
  const parent = candidateParent(state, candidate);
  if (parent === undefined)
    return `Candidate lineage references unknown parent attempt ${candidate.parentAttemptId}.`;
  if (parent.id === attempt.id) return "Candidate lineage cannot point to itself.";
  const parentScopeIssue = candidateParentScopeIssue(state, assignment, parent);
  if (parentScopeIssue !== undefined) return parentScopeIssue;
  const parentCandidate = candidateLineageForAttempt(parent);
  if (parentCandidate === undefined) return "Candidate parent has no exact assigned base revision.";
  const parentResult = resultForAttempt(state, parent);
  if (candidateParentResultIssue(parentResult, parentCommit) !== undefined)
    return "Candidate parent commit does not exactly match its retained implementation report.";
  const relationIssue = candidateRelationIssue(attempt, candidate, parentCandidate);
  return relationIssue ?? candidateCycleIssue(state, attempt, candidate);
}

function candidateParentScopeIssue(
  state: WorkstreamState,
  assignment: CandidateAssignment,
  parent: WorkAttempt,
): string | undefined {
  const parentAssignment = state.assignments.find((item) => item.id === parent.assignmentId);
  return parentAssignment?.capability === "implement" &&
    parentAssignment.intentVersion === assignment.intentVersion
    ? undefined
    : "Candidate parent is outside the current maintained implementation scope.";
}

function candidateParentResultIssue(
  result: WorkResult | undefined,
  parentCommit: string,
): string | undefined {
  return result?.validity === "typed" &&
    result.report.kind === "implementation" &&
    result.report.status === "completed" &&
    result.report.outcome === "changed" &&
    result.report.commit === parentCommit
    ? undefined
    : "Candidate parent commit does not exactly match its retained implementation report.";
}

function candidateRelationIssue(
  attempt: CandidateAttempt,
  candidate: CandidateLineage,
  parentCandidate: CandidateLineage,
): string | undefined {
  if (candidate.kind === "correction")
    return candidate.rootCommit === parentCandidate.rootCommit &&
      attempt.baseRevision === candidate.parentCommit
      ? undefined
      : "Correction candidate must continue directly from its retained parent.";
  return candidate.rootCommit === attempt.baseRevision
    ? undefined
    : "Integration candidate must be rooted at its assigned destination base.";
}

function candidateCycleIssue(
  state: WorkstreamState,
  attempt: CandidateAttempt,
  candidate: CandidateLineage,
): string | undefined {
  const visited = new Set<string>();
  let currentId = attempt.id;
  let current: CandidateLineage | undefined = candidate;
  while (current !== undefined && current.kind !== "initial") {
    if (visited.has(currentId)) return `Attempt ${attempt.id} candidate lineage contains a cycle.`;
    visited.add(currentId);
    const parent = candidateParent(state, current);
    if (parent === undefined) return undefined;
    currentId = parent.id;
    current = candidateLineageForAttempt(parent);
  }
  return undefined;
}

/**
 * Return the source details usable for a new correction or integration. This is a state-only
 * predicate: the runtime separately proves that the assignment is still current and authorized.
 */
export function retainedCandidate(
  state: WorkstreamState,
  parent: WorkAttempt,
  intentVersion: number,
): { candidate: CandidateLineage; commit: string } | undefined {
  const assignment = state.assignments.find((item) => item.id === parent.assignmentId);
  const candidate = candidateLineageForAttempt(parent);
  const result =
    parent.resultId === undefined
      ? undefined
      : state.results.find((item) => item.id === parent.resultId);
  if (
    assignment?.capability !== "implement" ||
    assignment.intentVersion !== intentVersion ||
    parent.state !== "settled" ||
    parent.cleanup?.state !== "completed" ||
    !parent.cleanup.workerClosed ||
    parent.placement?.kind !== "isolated_worktree" ||
    parent.outputRelease !== undefined ||
    (parent.application !== undefined && parent.application.state !== "blocked") ||
    candidate === undefined ||
    (candidate.kind !== "initial" && candidate.parentAttemptId === parent.id) ||
    result?.validity !== "typed" ||
    result.report.kind !== "implementation" ||
    result.report.status !== "completed" ||
    result.report.outcome !== "changed" ||
    result.report.commit === undefined
  )
    return undefined;
  return { candidate, commit: result.report.commit };
}

/** Validate candidate-specific application metadata without claiming Git proof. */
export function candidateApplicationIssue(
  state: WorkstreamState,
  assignment: CandidateAssignment,
  attempt: CandidateAttempt,
  sourceCommit: string,
): string | undefined {
  const candidate = candidateLineageForAttempt(attempt);
  if (candidate === undefined) return "Missing candidate base revision.";
  const lineageIssue = candidateLineageIssue(state, assignment, attempt);
  if (lineageIssue !== undefined) return lineageIssue;
  if (candidate.kind !== "initial") {
    const parent = candidateParent(state, candidate);
    if (
      parent === undefined ||
      retainedCandidate(state, parent, assignment.intentVersion) === undefined
    )
      return "Retained candidate lineage parent is no longer an exact live candidate.";
  }
  if (candidate.kind !== "initial" && sourceCommit === candidate.parentCommit)
    return "Candidate application source must be newer than its parent candidate.";
  return undefined;
}

/** Return an application-record shape error, or undefined when the fields are coherent. */
export function applicationRecordIssue(
  application: CandidateApplicationRecord,
): string | undefined {
  if (!Value.Check(CommitSchema, application.commit))
    return "Application source requires an exact commit id.";
  if (application.state === "applied" && !Value.Check(CommitSchema, application.revision ?? ""))
    return "Applied application requires an exact revision.";
  if (application.state !== "applied" && application.revision !== undefined)
    return "Unfinished application cannot retain an applied revision.";
  if (
    application.expectedRef !== undefined &&
    !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(application.expectedRef)
  )
    return "Application destination requires an exact attached branch ref.";
  if ((application.rootCommit === undefined) !== (application.commits === undefined))
    return "Application lineage requires both rootCommit and commits.";
  if (
    (application.rootCommit !== undefined && !Value.Check(CommitSchema, application.rootCommit)) ||
    (application.commits !== undefined &&
      (!Value.Check(CommitListSchema, application.commits) ||
        application.commits.at(-1) !== application.commit))
  )
    return "Application lineage does not match the exact candidate history.";
  return undefined;
}

const CommitListSchema = Type.Array(CommitSchema, { minItems: 1 });

/**
 * A successful correction application is persisted proof that exact direct ancestors were
 * included. A shared SHA without that lineage is not evidence of an unrelated application.
 */
export function includedByAppliedCandidateDescendant(
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
      application.revision === undefined
    )
      continue;
    const history = candidateHistory(state, descendant);
    if (history === undefined || !history.some((entry) => entry.attempt.id === target.id)) continue;
    const expectedCommits = history.map((entry) => entry.commit);
    if (
      application.rootCommit !== history[0]?.candidate.rootCommit ||
      application.commit !== expectedCommits.at(-1) ||
      !sameValues(application.commits, expectedCommits)
    )
      continue;
    return true;
  }
  return false;
}

type CandidateHistoryEntry = {
  attempt: WorkAttempt;
  candidate: CandidateLineage;
  commit: string;
};

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
    if (entry.candidate.kind !== "correction") {
      const history = entries.reverse();
      return isCompleteCandidateHistory(state, history) ? history : undefined;
    }
    current = candidateParent(state, entry.candidate);
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
  const candidate = candidateLineageForAttempt(attempt);
  const commit = changedImplementationCommit(result);
  if (
    assignment?.capability !== "implement" ||
    assignment.intentVersion !== intentVersion ||
    result?.assignmentIntentVersion !== assignment.intentVersion ||
    attempt.state !== "settled" ||
    attempt.cleanup?.state !== "completed" ||
    attempt.cleanup.workerClosed !== true ||
    candidate === undefined ||
    commit === undefined
  )
    return undefined;
  return { attempt, candidate, commit };
}

function isCompleteCandidateHistory(
  state: WorkstreamState,
  history: readonly CandidateHistoryEntry[],
): boolean {
  const first = history[0];
  if (first === undefined || first.candidate.kind === "correction") return false;
  const assignment = state.assignments.find((item) => item.id === first.attempt.assignmentId);
  if (
    assignment === undefined ||
    candidateLineageIssue(state, assignment, first.attempt) !== undefined
  )
    return false;
  return history.every((entry, index) => {
    if (entry.candidate.rootCommit !== first.candidate.rootCommit) return false;
    if (index === 0) return true;
    const parent = history[index - 1];
    return (
      entry.candidate.kind === "correction" &&
      entry.candidate.parentAttemptId === parent?.attempt.id &&
      entry.candidate.parentCommit === parent?.commit &&
      entry.attempt.baseRevision === parent?.commit
    );
  });
}

function isInitialCandidate(
  attempt: Pick<WorkAttempt, "baseRevision">,
  candidate: CandidateLineage,
): boolean {
  return (
    candidate.rootCommit === attempt.baseRevision &&
    candidate.parentAttemptId === undefined &&
    candidate.parentCommit === undefined
  );
}

function changedImplementationCommit(result: WorkResult | undefined): string | undefined {
  if (
    result?.validity !== "typed" ||
    result.report.kind !== "implementation" ||
    result.report.status !== "completed" ||
    result.report.outcome !== "changed" ||
    !Value.Check(CommitSchema, result.report.commit ?? "")
  )
    return undefined;
  return result.report.commit;
}

function resultForAttempt(state: WorkstreamState, attempt: WorkAttempt): WorkResult | undefined {
  if (attempt.resultId === undefined) return undefined;
  return state.results.find((result) => result.id === attempt.resultId);
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
