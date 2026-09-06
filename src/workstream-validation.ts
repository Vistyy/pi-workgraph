// oxlint-disable-next-line effecttsgo/node-builtin-import -- The existing Promise store API requires direct host filesystem reads at this external I/O boundary.
import { readFile } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Cross-reference path checks use the canonical host path implementation.
import { resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  type AuthorityReference,
  InvalidWorkstreamStateError,
  pathForWorkstream,
  type ResultSubject,
  type RetainedArtifact,
  RetainedTerminalEnvelopeSchema,
  type SessionIdentity,
  UnsupportedWorkstreamStateError,
  WORKSTREAM_FORMAT,
  WORKSTREAM_STATE_VERSION,
  type WorkAssignment,
  type WorkAttempt,
  type WorkResult,
  type WorkstreamReattachmentInspection,
  type WorkstreamState,
  WorkstreamStateSchema,
} from "./workstream-state.js";

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

export function readState(path: string): Promise<WorkstreamState> {
  return readSupportedStateValue(path).then((value) => {
    const state = decodeState(value);
    validateStoredPath(state, path);
    return state;
  });
}

export function readSupportedStateValue(path: string): Promise<JsonObject> {
  return readStateValue(path).then((value) => {
    const format = value.format;
    const version = value.version;
    if (format !== WORKSTREAM_FORMAT || version !== WORKSTREAM_STATE_VERSION)
      throw new UnsupportedWorkstreamStateError(format, version);
    return value;
  });
}

export function readStateValue(path: string): Promise<JsonObject> {
  return readFile(path, "utf8").then(parsePersistedObject);
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
    statePath !== pathForWorkstream(gitCommonDir, id) ||
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
  return value === 1 || value === 2 || value === 3;
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
    )
      validateAuthority(state, assignment.authority);
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
    const retention = state.attempts.find(
      (attempt) => attempt.artifactRetention?.resultId === result.id,
    )?.artifactRetention;
    validateArtifactsForAssignment(
      assignment,
      result.artifacts,
      result.validity === "typed" &&
        result.report.status === "completed" &&
        retention?.state !== "pending" &&
        retention?.state !== "blocked"
        ? "typed"
        : "absent",
    );
  }
  for (const disposition of state.dispositions)
    if (!resultIds.has(disposition.resultId))
      throw new InvalidWorkstreamStateError(
        `Disposition references unknown result ${disposition.resultId}.`,
      );
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
  unique(
    state.attempts.flatMap((attempt) =>
      attempt.artifactRetention === undefined ? [] : [attempt.artifactRetention.resultId],
    ),
    "artifact retention result",
  );
  for (const attempt of state.attempts) {
    validateAttemptPlacement(state, attempt);
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
    if (attempt.models?.selection && attempt.models.selection.selected.length === 0)
      throw new InvalidWorkstreamStateError(`Attempt ${attempt.id} has an empty model selection.`);
    validateArtifactRetention(state, attempt);
  }
}

function validateArtifactRetention(state: WorkstreamState, attempt: WorkAttempt): void {
  const retention = attempt.artifactRetention;
  if (retention === undefined) return;
  const assignment = state.assignments.find((item) => item.id === attempt.assignmentId);
  const result = state.results.find((item) => item.id === retention.resultId);
  if (
    assignment?.artifactIntent !== "disposable_experiment" ||
    attempt.placement?.kind !== "isolated_worktree" ||
    result?.validity !== "typed" ||
    result.report.status !== "completed" ||
    result.assignmentId !== assignment.id ||
    (attempt.resultId !== undefined && attempt.resultId !== retention.resultId) ||
    retention.assignmentIntentVersion !== assignment.intentVersion ||
    retention.assignmentIntentVersion !== result.assignmentIntentVersion ||
    JSON.stringify(retention.required) !== JSON.stringify(assignment.artifactPolicy.retain)
  )
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} has artifact retention outside its exact experiment result.`,
    );
  const expectedDestination = resolve(state.statePath, "..", "artifacts", retention.resultId);
  const expectedStaging = resolve(state.statePath, "..", "artifact-staging", retention.resultId);
  if (
    resolve(retention.destinationRoot) !== expectedDestination ||
    resolve(retention.stagingRoot) !== expectedStaging
  )
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} artifact retention has foreign destination paths.`,
    );
  if ((retention.state === "blocked") !== (retention.error !== undefined))
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} artifact retention blocker does not match its state.`,
    );
  if (retention.state !== "completed" && result.artifacts.length > 0)
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} has artifacts before retention completed.`,
    );
  if (retention.state === "completed") {
    validateArtifactsForAssignment(assignment, result.artifacts, "typed");
    if (
      result.artifacts.some(
        (artifact) =>
          artifact.kind !== "path" ||
          resolve(artifact.reference) !== resolve(retention.destinationRoot, artifact.id),
      )
    )
      throw new InvalidWorkstreamStateError(
        `Attempt ${attempt.id} retained artifacts have foreign references.`,
      );
  }
  if (retention.state !== "completed" && attempt.cleanup !== undefined)
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} cleanup began before required artifact retention completed.`,
    );
}

function validateAttemptPlacement(state: WorkstreamState, attempt: WorkAttempt): void {
  const placement = attempt.placement;
  if (!placement) return;
  if (placement.kind === "shared_project" && resolve(placement.path) !== resolve(state.projectRoot))
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} shared placement must be the project root.`,
    );
  if (placement.kind === "isolated_worktree") {
    if (attempt.baseRevision === undefined)
      throw new InvalidWorkstreamStateError(
        `Attempt ${attempt.id} isolated placement has no base revision.`,
      );
    if (attempt.worktreePath !== placement.path || attempt.branch !== placement.branch)
      throw new InvalidWorkstreamStateError(
        `Attempt ${attempt.id} isolated placement compatibility fields disagree.`,
      );
  } else if (attempt.worktreePath !== undefined || attempt.branch !== undefined) {
    throw new InvalidWorkstreamStateError(
      `Attempt ${attempt.id} shared placement has isolated compatibility fields.`,
    );
  }
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
  for (const item of state.completion.accounting) {
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
      throw new InvalidWorkstreamStateError(
        `Completion references unknown result ${item.resultId}.`,
      );
    if (
      item.kind === "undelivered_result" &&
      !state.deliveries.some((delivery) => delivery.resultId === item.resultId)
    )
      throw new InvalidWorkstreamStateError(
        `Completion references unknown delivery ${item.resultId}.`,
      );
  }
}

export function validateArtifactsForAssignment(
  assignment: WorkAssignment,
  artifacts: RetainedArtifact[],
  validity: WorkResult["validity"] = "typed",
): void {
  if (assignment.artifactIntent !== "disposable_experiment" || validity !== "typed") return;
  const retainedIds = artifacts
    .filter((artifact) => artifact.retention === "retained")
    .map((artifact) => artifact.id);
  const plannedIds = new Set(assignment.artifactPolicy.retain);
  if (
    new Set(retainedIds).size !== retainedIds.length ||
    retainedIds.length !== plannedIds.size ||
    retainedIds.some((id) => !plannedIds.has(id))
  ) {
    throw new Error(
      `Experiment ${assignment.id} did not retain exactly the artifacts named by its policy.`,
    );
  }
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
  const retained = state.results.some((result) =>
    result.artifacts.some(
      (artifact) =>
        artifact.kind === "revision" &&
        artifact.reference === revision &&
        artifact.retention === "retained",
    ),
  );
  if (!retained)
    throw new InvalidWorkstreamStateError(`Review revision ${revision} is not retained.`);
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

export function unique(values: string[], label: string): Set<string> {
  const result = new Set(values);
  if (result.size !== values.length)
    throw new InvalidWorkstreamStateError(`Duplicate ${label} id.`);
  return result;
}
