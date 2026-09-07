// oxlint-disable-next-line effecttsgo/node-builtin-import -- Cross-reference path checks use the canonical host path implementation.
import { resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  type AuthorityReference,
  CandidateLineageSchema,
  CommitSchema,
  type CompletionAccounting,
  InvalidWorkstreamStateError,
  legacyPathForWorkstream,
  pathForWorkstream,
  type ResultSubject,
  RetainedTerminalEnvelopeSchema,
  type SessionIdentity,
  UnsupportedWorkstreamStateError,
  type WorkAssignment,
  type WorkAttempt,
  type WorkResult,
  type WorkstreamReattachmentInspection,
  type WorkstreamState,
  WorkstreamStateSchema,
} from "./workstream-state.js";
import {
  accountingIdentity,
  accountingTaskId,
  deriveCompletionAccounting,
} from "./workstream-transitions.js";

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
const JsonStringSchema = Type.String();

export type JsonObject = {
  readonly format?: JsonValue;
  readonly version?: JsonValue;
  readonly lifecycle?: JsonValue;
  readonly [key: string]: JsonValue | undefined;
};

/** Parse the JSON boundary once; the recursive type prevents unparsed dictionaries entering domain flow. */
export function parsePersistedObject(text: string): JsonObject {
  let parsed: unknown;
  try {
    // SAFETY: JSON.parse is the external I/O boundary; the recursive guard below establishes JsonObject.
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new InvalidWorkstreamStateError(`Invalid workstream JSON: ${boundedCause(cause)}.`);
  }
  if (!isJsonObject(parsed)) throw new UnsupportedWorkstreamStateError(undefined, undefined);
  return parsed;
}

// SAFETY: Unknown is used only for the JSON.parse result, before the recursive JSON contract is established.
function isJsonObject(value: unknown): value is JsonObject {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function boundedCause(cause: unknown): string {
  if (cause instanceof SyntaxError) return cause.message.slice(0, 160);
  return "parse failure";
}

function schemaDiagnostic(value: JsonObject): string {
  const issue = Value.Errors(WorkstreamStateSchema, value)[0];
  if (!issue) return "Invalid workstream state.";
  const path = issue.instancePath || "/";
  return `Invalid workstream state at ${path.slice(0, 120)}: ${issue.message.slice(0, 120)}.`;
}

export function retainedTerminalInspection(
  value: JsonObject,
  resolvedPath: string,
): WorkstreamReattachmentInspection | undefined {
  if (!Value.Check(RetainedTerminalEnvelopeSchema, value)) return undefined;
  const statePath = stringField(value, "statePath");
  const gitCommonDir = stringField(value, "gitCommonDir");
  const id = stringField(value, "id");
  const lifecycle = value.lifecycle;
  if (
    statePath === undefined ||
    gitCommonDir === undefined ||
    id === undefined ||
    !isJsonObject(lifecycle)
  )
    return undefined;
  const lifecycleState = lifecycle.state;
  const changedAt = stringField(lifecycle, "changedAt");
  const reason = stringField(lifecycle, "reason");
  if (
    statePath !== resolvedPath ||
    (statePath !== pathForWorkstream(gitCommonDir, id) &&
      statePath !== legacyPathForWorkstream(gitCommonDir, id)) ||
    (lifecycleState !== "completed" &&
      lifecycleState !== "abandoned" &&
      lifecycleState !== "archived") ||
    changedAt === undefined ||
    reason === undefined
  )
    return undefined;
  return {
    kind: "retained_terminal",
    id,
    lifecycle: { state: lifecycleState, changedAt, reason },
  };
}

function stringField(value: JsonObject, key: string): string | undefined {
  const field = value[key];
  return Value.Check(JsonStringSchema, field) ? field : undefined;
}

export function isKnownHistoricalWorkstreamVersion(value: JsonValue | undefined): boolean {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5 || value === 6;
}

export function isActiveHistoricalState(value: JsonObject): boolean {
  const lifecycle = value.lifecycle;
  if (!isJsonObject(lifecycle)) return false;
  const state = stringField(lifecycle, "state");
  return state === "active" || state === "suspended";
}

export function validateStoredPath(state: WorkstreamState, path: string): void {
  if (state.statePath !== path)
    throw new InvalidWorkstreamStateError(
      `Workstream state is stored at ${state.statePath}, not ${path}.`,
    );
}

export function decodeState(value: JsonObject): WorkstreamState {
  if (!Value.Check(WorkstreamStateSchema, value))
    throw new InvalidWorkstreamStateError(schemaDiagnostic(value));
  // SAFETY: Value.Check established the complete WorkstreamStateSchema contract immediately above.
  const state = value as WorkstreamState;
  validateState(state);
  return state;
}

export function decodeLegacyState(value: JsonObject, resolvedPath: string): WorkstreamState {
  if (!Value.Check(WorkstreamStateSchema, value))
    throw new InvalidWorkstreamStateError(schemaDiagnostic(value));
  // SAFETY: Value.Check established the complete WorkstreamStateSchema contract immediately above.
  const state = value as WorkstreamState;
  if (
    state.statePath !== resolvedPath ||
    state.statePath !== legacyPathForWorkstream(state.gitCommonDir, state.id)
  )
    throw new InvalidWorkstreamStateError(
      `Legacy workstream state identity does not match its exact path: ${resolvedPath}.`,
    );
  validateState({ ...state, statePath: pathForWorkstream(state.gitCommonDir, state.id) });
  return state;
}

export function validateState(state: WorkstreamState): void {
  validateId(state.id, "Workstream id");
  if (state.statePath !== pathForWorkstream(state.gitCommonDir, state.id))
    throw new InvalidWorkstreamStateError("Workstream state path does not match its identity.");
  validateSession(state.coordinator);
  validateInputsAndIntents(state);
  const assignmentIds = validateAssignments(state);
  const resultIds = validateResults(state, assignmentIds);
  validateAttempts(state, assignmentIds, resultIds);
  validateDeliveries(state, resultIds);
  validateCompletion(state, assignmentIds, resultIds);
  if (
    state.lifecycle.state === "completed" &&
    state.attempts.some(
      (attempt) =>
        ["queued", "starting", "running", "cancel_requested"].includes(attempt.state) ||
        (attempt.placement !== undefined &&
          (attempt.cleanup?.state !== "completed" ||
            !attempt.cleanup.workerClosed ||
            attempt.application?.state === "pending" ||
            attempt.application?.state === "blocked")),
    )
  )
    throw new InvalidWorkstreamStateError(
      "Completed workstream retains live execution or an unclosed worker/application boundary.",
    );
  if (state.lifecycle.state === "completed" && !state.completion)
    throw new InvalidWorkstreamStateError("Completed workstream has no completion record.");
  if (state.completion && state.lifecycle.state !== "completed")
    throw new InvalidWorkstreamStateError("Completion record requires completed lifecycle.");
}

function validateInputsAndIntents(state: WorkstreamState): Set<string> {
  const inputIds = unique(
    state.inputs.map((input) => input.id),
    "human input receipt",
  );
  for (const input of state.inputs) requireText(input.text, "Human input");
  state.intents.forEach((intent, index) => {
    if (intent.version !== index)
      throw new InvalidWorkstreamStateError("Intent versions must be contiguous.");
    for (const receiptId of intent.authorityReceiptIds)
      if (!inputIds.has(receiptId))
        throw new InvalidWorkstreamStateError(`Intent references unknown receipt ${receiptId}.`);
  });
  return inputIds;
}

function validateAssignments(state: WorkstreamState): Set<string> {
  const assignmentIds = unique(
    state.assignments.map((assignment) => assignment.id),
    "assignment",
  );
  for (const assignment of state.assignments) {
    if (!state.intents.some((intent) => intent.version === assignment.intentVersion))
      throw new InvalidWorkstreamStateError(
        `Assignment ${assignment.id} references unknown intent.`,
      );
    if (
      assignment.artifactIntent === "disposable_experiment" ||
      assignment.capability === "implement"
    ) {
      validateAuthority(state, assignment.authority);
      if (assignment.authority.intentVersion !== assignment.intentVersion)
        throw new InvalidWorkstreamStateError(
          `Assignment ${assignment.id} authority belongs to another intent.`,
        );
    }
    if (assignment.capability === "review") validateSubject(state, assignment.subject);
  }
  return assignmentIds;
}

function validateResults(state: WorkstreamState, assignmentIds: Set<string>): Set<string> {
  const resultIds = unique(
    state.results.map((result) => result.id),
    "result",
  );
  for (const result of state.results) {
    if (!assignmentIds.has(result.assignmentId))
      throw new InvalidWorkstreamStateError(`Result ${result.id} references unknown assignment.`);
    const assignment = state.assignments.find((candidate) => candidate.id === result.assignmentId);
    if (!assignment)
      throw new InvalidWorkstreamStateError(`Result ${result.id} references unknown assignment.`);
    if (assignment.intentVersion !== result.assignmentIntentVersion)
      throw new InvalidWorkstreamStateError(`Result ${result.id} has the wrong intent version.`);
    unique(
      result.artifacts.map((artifact) => artifact.id),
      `artifact in result ${result.id}`,
    );
    validateExperimentWorktree(state, assignment, result);
  }
  return resultIds;
}

function validateAttempts(
  state: WorkstreamState,
  assignmentIds: Set<string>,
  resultIds: Set<string>,
): void {
  unique(
    state.attempts.map((attempt) => attempt.id),
    "attempt",
  );
  for (const attempt of state.attempts) {
    validateAttemptPlacement(state, attempt);
    validateAttemptFields(attempt);
    if (!assignmentIds.has(attempt.assignmentId))
      throw new InvalidWorkstreamStateError(`Attempt ${attempt.id} references unknown assignment.`);
    if (attempt.resultId !== undefined && !resultIds.has(attempt.resultId))
      throw new InvalidWorkstreamStateError(`Attempt ${attempt.id} references unknown result.`);
    if (attempt.resultId !== undefined) {
      const result = state.results.find((item) => item.id === attempt.resultId);
      if (result?.assignmentId !== attempt.assignmentId)
        throw new InvalidWorkstreamStateError(
          `Attempt ${attempt.id} references a result from another assignment.`,
        );
    }
    validateCandidateRecord(state, attempt);
    validateApplicationRecord(attempt);
    if (attempt.models?.selection && attempt.models.selection.selected.length === 0)
      throw new InvalidWorkstreamStateError(`Attempt ${attempt.id} has an empty model selection.`);
    validateOutputRelease(state, attempt);
  }
}

function validateCandidateRecord(state: WorkstreamState, attempt: WorkAttempt): void {
  const candidate = attempt.candidate;
  if (candidate === undefined) return;
  validateCandidateShape(attempt, candidate);
  const assignment = state.assignments.find((item) => item.id === attempt.assignmentId);
  if (assignment?.capability !== "implement")
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} candidate lineage is outside maintained implementation.`,
    );
  validateCandidateAcyclic(state, attempt);
  if (candidate.kind === "initial") return;
  const parent = candidateParent(state, attempt, candidate.parentAttemptId);
  validateCandidateParentResult(state, attempt, parent, candidate.parentCommit);
  const parentCandidate = candidateLineageForAttempt(parent);
  if (candidate.kind === "correction") {
    if (
      parentCandidate === undefined ||
      candidate.rootCommit !== parentCandidate.rootCommit ||
      attempt.baseRevision !== candidate.parentCommit
    )
      throw new InvalidWorkstreamStateError(
        `Attempt ${attempt.id} correction candidate lineage is not directly rooted at its parent.`,
      );
  } else if (candidate.rootCommit !== attempt.baseRevision) {
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} integration candidate lineage is not rooted at its base.`,
    );
  }
}

function validateCandidateAcyclic(state: WorkstreamState, attempt: WorkAttempt): void {
  const visited = new Set<string>();
  let current: WorkAttempt | undefined = attempt;
  while (current !== undefined) {
    const lineage = candidateLineageForAttempt(current);
    if (lineage?.kind === "initial") return;
    if (visited.has(current.id))
      throw new InvalidWorkstreamStateError(
        `Attempt ${attempt.id} candidate lineage contains a cycle.`,
      );
    visited.add(current.id);
    current = state.attempts.find((item) => item.id === lineage?.parentAttemptId);
  }
}

function validateCandidateShape(
  attempt: WorkAttempt,
  candidate: NonNullable<WorkAttempt["candidate"]>,
): void {
  if (!Value.Check(CandidateLineageSchema, candidate))
    throw new InvalidWorkstreamStateError(`Attempt ${attempt.id} has invalid candidate lineage.`);
  if (attempt.baseRevision === undefined || !Value.Check(CommitSchema, attempt.baseRevision))
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} candidate lineage has no exact assigned base.`,
    );
  if (
    candidate.kind === "initial" &&
    (candidate.rootCommit !== attempt.baseRevision ||
      candidate.parentAttemptId !== undefined ||
      candidate.parentCommit !== undefined)
  )
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} initial candidate lineage is inconsistent with its base.`,
    );
  if (
    candidate.kind !== "initial" &&
    (candidate.parentAttemptId === undefined || candidate.parentCommit === undefined)
  )
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} candidate lineage has no exact parent.`,
    );
}

function candidateParent(
  state: WorkstreamState,
  attempt: WorkAttempt,
  parentAttemptId: string | undefined,
): WorkAttempt {
  const parent = state.attempts.find((item) => item.id === parentAttemptId);
  if (parent === undefined || parent.id === attempt.id)
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} candidate lineage references an invalid parent.`,
    );
  return parent;
}

function validateCandidateParentResult(
  state: WorkstreamState,
  attempt: WorkAttempt,
  parent: WorkAttempt,
  parentCommit: string | undefined,
): void {
  const assignment = state.assignments.find((item) => item.id === attempt.assignmentId);
  const parentAssignment = state.assignments.find((item) => item.id === parent.assignmentId);
  const parentResult =
    parent.resultId === undefined
      ? undefined
      : state.results.find((item) => item.id === parent.resultId);
  if (
    assignment === undefined ||
    parentAssignment?.capability !== "implement" ||
    parentAssignment.intentVersion !== assignment.intentVersion ||
    candidateLineageForAttempt(parent) === undefined ||
    parentResult?.validity !== "typed" ||
    parentResult.report.kind !== "implementation" ||
    parentResult.report.status !== "completed" ||
    parentResult.report.outcome !== "changed" ||
    parentResult.report.commit !== parentCommit
  )
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} candidate lineage parent is not an exact implementation result.`,
    );
}

function candidateLineageForAttempt(
  attempt: Pick<WorkAttempt, "baseRevision" | "candidate">,
): NonNullable<WorkAttempt["candidate"]> | undefined {
  if (attempt.candidate !== undefined) return attempt.candidate;
  if (attempt.baseRevision !== undefined && Value.Check(CommitSchema, attempt.baseRevision))
    return { kind: "initial", rootCommit: attempt.baseRevision };
  return undefined;
}

function validateApplicationRecord(attempt: WorkAttempt): void {
  const application = attempt.application;
  if (application === undefined) return;
  if ((application.rootCommit === undefined) !== (application.commits === undefined))
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} application lineage is incomplete.`,
    );
  if (application.rootCommit === undefined || application.commits === undefined) return;
  if (
    !Value.Check(CommitSchema, application.rootCommit) ||
    application.commits.at(-1) !== application.commit
  )
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} application lineage does not end at its source commit.`,
    );
}

function validateAttemptFields(attempt: WorkAttempt): void {
  validateAttemptResultPair(attempt);
  validateAttemptIdentity(attempt);
  validateAttemptCleanup(attempt);
  if (attempt.state === "queued") {
    validateUnlaunchedAttempt(attempt, "Queued");
    return;
  }
  if (attempt.state === "cancelled" && attempt.placement === undefined) {
    validateUnlaunchedAttempt(attempt, "Unlaunched cancelled");
    return;
  }
  validateLaunchedAttempt(attempt);
}

function validateAttemptResultPair(attempt: WorkAttempt): void {
  if ((attempt.resultId !== undefined) !== (attempt.effectiveModels !== undefined))
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} result and effective models must be recorded together.`,
    );
}

function validateAttemptIdentity(attempt: WorkAttempt): void {
  const placement = attempt.placement;
  if (
    attempt.worker !== undefined &&
    (attempt.sessionFile === undefined ||
      attempt.worker.sessionFile !== attempt.sessionFile ||
      placement === undefined ||
      resolve(attempt.worker.cwd) !== resolve(placement.path))
  )
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} worker identity does not match its retained launch.`,
    );
  if (attempt.resource !== undefined && placement === undefined)
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} resource has no retained placement.`,
    );
  if (attempt.launchPane !== undefined && placement === undefined)
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} launch pane has no retained placement.`,
    );
}

function validateUnlaunchedAttempt(attempt: WorkAttempt, label: string): void {
  if (hasLaunchOrTerminalFields(attempt))
    throw new InvalidWorkstreamStateError(
      `${label} attempt ${attempt.id} contains live or terminal fields.`,
    );
}

function hasLaunchOrTerminalFields(attempt: WorkAttempt): boolean {
  return (
    attempt.placement !== undefined ||
    attempt.sessionFile !== undefined ||
    attempt.submission !== undefined ||
    attempt.launchPane !== undefined ||
    attempt.resource !== undefined ||
    attempt.worker !== undefined ||
    attempt.resultId !== undefined ||
    attempt.steering !== undefined ||
    attempt.application !== undefined ||
    attempt.cleanup !== undefined ||
    attempt.outputRelease !== undefined
  );
}

function validateLaunchedAttempt(attempt: WorkAttempt): void {
  const hasResult = attempt.resultId !== undefined;
  if (attempt.placement === undefined || attempt.submission === undefined)
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} state ${attempt.state} requires retained launch preparation.`,
    );
  validateSubmissionCheckpoint(attempt);
  if (attempt.state === "running") validateRunningAttempt(attempt);
  if (attempt.state === "settled" && (attempt.sessionFile === undefined || !hasResult))
    throw new InvalidWorkstreamStateError(
      `Settled attempt ${attempt.id} lacks settlement evidence.`,
    );
  if (isActiveAttemptState(attempt.state) && hasResult)
    throw new InvalidWorkstreamStateError(
      `Active attempt ${attempt.id} contains terminal result evidence.`,
    );
  if (attempt.application !== undefined && (attempt.state !== "settled" || !hasResult))
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} application is outside a settled result.`,
    );
}

function validateSubmissionCheckpoint(attempt: WorkAttempt): void {
  if (attempt.submission === "not_sent") return;
  if (attempt.sessionFile === undefined)
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} sent checkpoint has no retained session.`,
    );
  if (
    (attempt.submission === "submitted" || attempt.submission === "started") &&
    attempt.state === "starting"
  )
    throw new InvalidWorkstreamStateError(
      `Starting attempt ${attempt.id} contains a submitted launch checkpoint.`,
    );
}

function validateRunningAttempt(attempt: WorkAttempt): void {
  if (attempt.submission !== "submitted" && attempt.submission !== "started")
    throw new InvalidWorkstreamStateError(
      `Running attempt ${attempt.id} has not retained a submitted session.`,
    );
}

function validateAttemptCleanup(attempt: WorkAttempt): void {
  const cleanup = attempt.cleanup;
  if (cleanup === undefined) return;
  if ((cleanup.state === "blocked") !== (cleanup.error !== undefined))
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} cleanup blocker does not match its state.`,
    );
  if (cleanup.state === "completed" && !cleanup.workerClosed)
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} completed cleanup has no closed worker.`,
    );
}

function isActiveAttemptState(state: WorkAttempt["state"]): boolean {
  return state === "starting" || state === "running" || state === "cancel_requested";
}

function validateOutputRelease(state: WorkstreamState, attempt: WorkAttempt): void {
  const release = attempt.outputRelease;
  if (release === undefined) return;
  const assignment = state.assignments.find((item) => item.id === attempt.assignmentId);
  const releasableAssignment =
    assignment?.artifactIntent === "disposable_experiment" ||
    assignment?.capability === "implement";
  if (
    !releasableAssignment ||
    !["settled", "failed", "cancelled"].includes(attempt.state) ||
    attempt.placement?.kind !== "isolated_worktree" ||
    attempt.cleanup?.state !== "completed" ||
    !attempt.cleanup.workerClosed
  )
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} retained-output release is outside closed owned output.`,
    );
  if ((release.state === "blocked") !== (release.error !== undefined))
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} retained-output release blocker does not match its state.`,
    );
}

function validateExperimentWorktree(
  state: WorkstreamState,
  assignment: WorkAssignment,
  result: WorkResult,
): void {
  if (
    assignment.artifactIntent !== "disposable_experiment" ||
    result.validity !== "typed" ||
    result.report.status !== "completed"
  )
    return;
  const artifact = result.artifacts.length === 1 ? result.artifacts[0] : undefined;
  const attempt = state.attempts.find(
    (item) =>
      item.assignmentId === assignment.id &&
      item.placement?.kind === "isolated_worktree" &&
      resolve(item.placement.path) === resolve(artifact?.reference ?? ""),
  );
  if (
    artifact?.id !== "retained-output-worktree" ||
    artifact.kind !== "path" ||
    artifact.retention !== "retained" ||
    attempt === undefined
  )
    throw new InvalidWorkstreamStateError(
      `Experiment ${assignment.id} must retain its exact isolated worktree.`,
    );
}

function validateAttemptPlacement(state: WorkstreamState, attempt: WorkAttempt): void {
  const placement = attempt.placement;
  if (!placement) return;
  if (placement.kind === "shared_project" && resolve(placement.path) !== resolve(state.projectRoot))
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} shared placement must be the project root.`,
    );
  if (placement.kind === "isolated_worktree" && attempt.baseRevision === undefined)
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} isolated placement has no base revision.`,
    );
}

function validateDeliveries(state: WorkstreamState, resultIds: Set<string>): void {
  for (const delivery of state.deliveries)
    if (!resultIds.has(delivery.resultId))
      throw new InvalidWorkstreamStateError(
        `Delivery references unknown result ${delivery.resultId}.`,
      );
  unique(
    state.deliveries.map((delivery) => delivery.resultId),
    "delivery",
  );
}

function validateCompletion(
  state: WorkstreamState,
  assignmentIds: Set<string>,
  resultIds: Set<string>,
): void {
  if (!state.completion) return;
  for (const item of state.completion.accounting)
    validateCompletionReference(state, item, assignmentIds, resultIds);

  const expected = deriveCompletionAccounting(state);
  const actualIdentities = state.completion.accounting.map(accountingIdentity);
  const expectedIdentities = expected.map(accountingIdentity);
  if (JSON.stringify(actualIdentities) !== JSON.stringify(expectedIdentities))
    throw new InvalidWorkstreamStateError(
      "Completion accounting does not exactly match derived unresolved records.",
    );

  const reasonByTask = new Map<string, string>();
  for (const item of state.completion.accounting) {
    const taskId = accountingTaskId(state, item);
    if (taskId === undefined) continue;
    const previous = reasonByTask.get(taskId);
    if (previous !== undefined && previous !== item.reason)
      throw new InvalidWorkstreamStateError(
        `Completion accounting has conflicting reasons for task ${taskId}.`,
      );
    reasonByTask.set(taskId, item.reason);
  }
}

function validateCompletionReference(
  state: WorkstreamState,
  item: CompletionAccounting,
  assignmentIds: Set<string>,
  resultIds: Set<string>,
): void {
  if (item.kind === "unresolved_assignment" && !assignmentIds.has(item.assignmentId))
    throw new InvalidWorkstreamStateError(
      `Completion references unknown assignment ${item.assignmentId}.`,
    );
  if (
    item.kind === "unresolved_attempt" &&
    !state.attempts.some((attempt) => attempt.id === item.attemptId)
  )
    throw new InvalidWorkstreamStateError(
      `Completion references unknown attempt ${item.attemptId}.`,
    );
  if (item.kind === "unresolved_result" && !resultIds.has(item.resultId))
    throw new InvalidWorkstreamStateError(`Completion references unknown result ${item.resultId}.`);
  if (
    item.kind === "undelivered_result" &&
    !state.deliveries.some((delivery) => delivery.resultId === item.resultId)
  )
    throw new InvalidWorkstreamStateError(
      `Completion references unknown delivery ${item.resultId}.`,
    );
}

export function validateAuthority(state: WorkstreamState, authority: AuthorityReference): void {
  const receipt = state.inputs.find((candidate) => candidate.id === authority.receiptId);
  const intent = state.intents.find((candidate) => candidate.version === authority.intentVersion);
  if (
    receipt === undefined ||
    intent === undefined ||
    !intent.authorityReceiptIds.includes(authority.receiptId)
  )
    throw new InvalidWorkstreamStateError(
      "Assignment authority does not reference a retained human-backed intent.",
    );
}

export function validateSubject(state: WorkstreamState, subject: ResultSubject): void {
  if (subject.kind === "comparison") {
    validateComparison(state, subject.resultIds);
    return;
  }
  if (subject.kind === "result") {
    validateResultSubject(state, subject.resultId);
    return;
  }
  if (subject.kind === "artifact") {
    validateArtifactSubject(state, subject.resultId, subject.artifactId);
    return;
  }
  validateRevisionSubject(state, subject.revision);
}

function validateComparison(state: WorkstreamState, resultIds: string[]): void {
  const distinct = new Set(resultIds);
  if (distinct.size !== resultIds.length || resultIds.length < 2)
    throw new InvalidWorkstreamStateError("Comparison requires distinct retained results.");
  for (const resultId of resultIds)
    validateResultSubject(state, resultId, "Comparison references unknown result");
}

function validateResultSubject(
  state: WorkstreamState,
  resultId: string,
  prefix = "Review references unknown result",
): void {
  if (!state.results.some((result) => result.id === resultId))
    throw new InvalidWorkstreamStateError(`${prefix} ${resultId}.`);
}

function validateArtifactSubject(
  state: WorkstreamState,
  resultId: string,
  artifactId: string,
): void {
  const result = state.results.find((candidate) => candidate.id === resultId);
  const artifact = result?.artifacts.find((candidate) => candidate.id === artifactId);
  if (artifact?.retention !== "retained")
    throw new InvalidWorkstreamStateError("Review artifact is not retained.");
}

function validateRevisionSubject(state: WorkstreamState, revision: string): void {
  const retainedArtifact = state.results.some((result) =>
    result.artifacts.some(
      (artifact) =>
        artifact.kind === "revision" &&
        artifact.reference === revision &&
        artifact.retention === "retained",
    ),
  );
  if (retainedArtifact || retainedCandidateRevision(state, revision)) return;
  throw new InvalidWorkstreamStateError(`Review revision ${revision} is not retained.`);
}

function retainedCandidateRevision(state: WorkstreamState, revision: string): boolean {
  return state.results.some((result) => {
    if (
      result.validity !== "typed" ||
      result.report.kind !== "implementation" ||
      result.report.status !== "completed" ||
      result.report.outcome !== "changed" ||
      result.report.commit !== revision
    )
      return false;
    const attempt = state.attempts.find((candidate) => candidate.resultId === result.id);
    const application = attempt?.application;
    // An application checkpoint retains the exact source while the destination transition is in flight;
    // an applied source remains retained in destination history even after its output worktree is released.
    if (
      application?.commit === revision &&
      (application.state === "applied" || attempt?.outputRelease === undefined)
    )
      return true;
    return (
      attempt?.placement?.kind === "isolated_worktree" &&
      attempt.cleanup?.state === "completed" &&
      attempt.cleanup.workerClosed &&
      attempt.outputRelease === undefined &&
      application?.state !== "pending" &&
      application?.state !== "applied"
    );
  });
}

export function validateId(value: string, label: string): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value))
    throw new Error(`${label} must be a lowercase durable id.`);
}

export function validateSession(value: SessionIdentity): void {
  requireText(value.sessionId, "Session id");
  requireText(value.sessionFile, "Session file");
}

export function requireText(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required.`);
}

function unique(values: string[], label: string): Set<string> {
  const result = new Set(values);
  if (result.size !== values.length)
    throw new InvalidWorkstreamStateError(`Duplicate ${label} id.`);
  return result;
}
