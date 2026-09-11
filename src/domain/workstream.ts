import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { ModelTargetSchema } from "./model-target.js";
import { EvidenceSchema, WorkerReportSchema } from "./report.js";
import { CommitSchema, InstantSchema, NonEmptyStringSchema } from "./values.js";

const WORKSTREAM_FORMAT = "pi-workgraph-workstream" as const;
const WORKSTREAM_SCHEMA_VERSION = 3 as const;

const NonEmptyString = NonEmptyStringSchema;
const NonBlankString = Type.String({ minLength: 1, pattern: "\\S" });
const Timestamp = InstantSchema;
const Commit = CommitSchema;
const stringLiterals = <const Values extends readonly string[]>(values: Values) =>
  Type.Unsafe<Values[number]>({ type: "string", enum: [...values] });

const RepositoryIdentitySchema = Type.Object(
  { projectRoot: NonEmptyString, gitCommonDir: NonEmptyString },
  { additionalProperties: false },
);
const CoordinatorIdentitySchema = Type.Object(
  { sessionId: NonEmptyString, sessionFile: NonEmptyString },
  { additionalProperties: false },
);
const HumanInputReceiptSchema = Type.Object(
  {
    kind: Type.Literal("human_input_receipt"),
    id: NonEmptyString,
    sessionId: NonEmptyString,
    sessionFile: NonEmptyString,
    source: stringLiterals(["interactive", "rpc"] as const),
    text: NonEmptyString,
    receivedAt: Timestamp,
  },
  { additionalProperties: false },
);
export const HumanInputReceiptDataSchema = Type.Omit(HumanInputReceiptSchema, ["kind"]);
export const HandoffGrantSchema = Type.Object(
  {
    kind: Type.Literal("handoff_grant"),
    id: NonEmptyString,
    parentReceipt: HumanInputReceiptSchema,
    parentWorkstreamId: NonEmptyString,
    parentRepository: RepositoryIdentitySchema,
    parentIntentIndex: Type.Integer({ minimum: 0 }),
    parentIntentStatement: NonEmptyString,
    parentIntentConstraints: Type.Array(NonEmptyString),
    narrowedRequest: NonEmptyString,
    targetRepository: RepositoryIdentitySchema,
    issuedAt: Timestamp,
  },
  { additionalProperties: false },
);
const IntentGroundingSchema = Type.Union([HumanInputReceiptSchema, HandoffGrantSchema]);
export const IntentSchema = Type.Object(
  {
    statement: NonEmptyString,
    constraints: Type.Array(NonEmptyString),
    grounding: IntentGroundingSchema,
    recordedAt: Timestamp,
  },
  { additionalProperties: false },
);

export const ReviewSubjectSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("outcome"), outcomeId: NonEmptyString },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("comparison"), outcomeIds: Type.Array(NonEmptyString, { minItems: 2 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("artifact"), outcomeId: NonEmptyString, artifactId: NonEmptyString },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("revision"), revision: Commit },
    { additionalProperties: false },
  ),
]);
export const CandidateLineageSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("initial"), rootCommit: Commit },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("correction"),
      rootCommit: Commit,
      parentAttemptId: NonEmptyString,
      parentCommit: Commit,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("integration"),
      rootCommit: Commit,
      parentAttemptId: NonEmptyString,
      parentCommit: Commit,
    },
    { additionalProperties: false },
  ),
]);

const ReadOnlySelectionSchema = Type.Object(
  {
    role: stringLiterals(["research", "review", "consultation"] as const),
    target: ModelTargetSchema,
    source: Type.Literal("policy"),
  },
  { additionalProperties: false },
);
const ImplementationSelectionSchema = Type.Object(
  {
    role: Type.Literal("implementation"),
    guide: ModelTargetSchema,
    executor: ModelTargetSchema,
    source: Type.Literal("policy"),
  },
  { additionalProperties: false },
);
const SelectionSchema = Type.Union([ReadOnlySelectionSchema, ImplementationSelectionSchema]);
const EffectiveModelSchema = Type.Object(
  {
    model: NonEmptyString,
    thinking: Type.Optional(NonEmptyString),
    source: stringLiterals(["selection", "message"] as const),
  },
  { additionalProperties: false },
);
const PlacementSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("shared_project"), path: NonEmptyString },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("isolated_worktree"), path: NonEmptyString, branch: NonEmptyString },
    { additionalProperties: false },
  ),
]);
const PaneLaunchCheckpointSchema = Type.Object(
  {
    phase: Type.Literal("pane"),
    workspaceId: NonEmptyString,
    paneId: NonEmptyString,
  },
  { additionalProperties: false },
);
const ResourceLaunchFields = {
  workspaceId: NonEmptyString,
  tabId: NonEmptyString,
  paneId: NonEmptyString,
  terminalId: NonEmptyString,
  agentName: NonEmptyString,
  cwd: NonEmptyString,
};
const ResourceLaunchCheckpointSchema = Type.Object(
  { phase: Type.Literal("resource"), ...ResourceLaunchFields },
  { additionalProperties: false },
);
const ReadyLaunchCheckpointSchema = Type.Object(
  { phase: Type.Literal("ready"), ...ResourceLaunchFields },
  { additionalProperties: false },
);
export const LaunchCheckpointSchema = Type.Union([
  PaneLaunchCheckpointSchema,
  ResourceLaunchCheckpointSchema,
  ReadyLaunchCheckpointSchema,
]);
const SteeringObservationSchema = Type.Object(
  {
    text: NonEmptyString,
    state: stringLiterals(["uncertain", "submitted"] as const),
    observedAt: Timestamp,
  },
  { additionalProperties: false },
);
const CancellationCheckpointSchema = Type.Union([
  Type.Object(
    {
      state: Type.Literal("requested"),
      requestedAt: Timestamp,
      reason: NonEmptyString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      state: Type.Literal("uncertain"),
      requestedAt: Timestamp,
      reason: NonEmptyString,
      dispatchAt: Timestamp,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      state: Type.Literal("blocked"),
      requestedAt: Timestamp,
      reason: NonEmptyString,
      dispatchAt: Timestamp,
      blockedAt: Timestamp,
      error: NonEmptyString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      state: Type.Literal("terminated"),
      requestedAt: Timestamp,
      reason: NonEmptyString,
      dispatchAt: Timestamp,
      terminatedAt: Timestamp,
    },
    { additionalProperties: false },
  ),
]);
export const WorkerExecutionSchema = Type.Object(
  {
    placement: Type.Optional(PlacementSchema),
    sessionFile: Type.Optional(NonEmptyString),
    launch: Type.Optional(LaunchCheckpointSchema),
    submission: Type.Optional(
      stringLiterals(["not_sent", "uncertain", "submitted", "started"] as const),
    ),
    steering: Type.Optional(SteeringObservationSchema),
    cancellation: Type.Optional(CancellationCheckpointSchema),
  },
  { additionalProperties: false },
);
export const ApplicationSchema = Type.Object(
  {
    state: stringLiterals(["pending", "applied", "blocked"] as const),
    commit: Commit,
    expectedRef: NonEmptyString,
    expectedHead: Commit,
    rootCommit: Commit,
    commits: Type.Array(Commit, { minItems: 1 }),
    revision: Type.Optional(Commit),
    error: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);
export const CleanupSchema = Type.Object(
  {
    state: stringLiterals(["pending", "blocked", "completed"] as const),
    expectedHead: Type.Optional(Commit),
    workerClosed: Type.Boolean(),
    error: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);
const OutputDispositionSchema = Type.Object(
  {
    kind: stringLiterals(["applied", "discarded"] as const),
    state: stringLiterals(["pending", "blocked", "completed"] as const),
    expectedHead: Commit,
    reason: NonBlankString,
    error: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);
const RetainedArtifactSchema = Type.Object(
  {
    id: NonEmptyString,
    kind: stringLiterals(["path", "revision", "reference"] as const),
    reference: NonEmptyString,
    retention: stringLiterals(["retained", "discarded"] as const),
    summary: NonEmptyString,
  },
  { additionalProperties: false },
);
const DeliveryFailureSchema = Type.Object(
  { at: Timestamp, detail: NonEmptyString },
  { additionalProperties: false },
);
const DeliverySchema = Type.Union([
  Type.Object(
    {
      state: Type.Literal("pending"),
      requestedAt: Timestamp,
      attemptCount: Type.Integer({ minimum: 0 }),
      failureHistory: Type.Array(DeliveryFailureSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      state: Type.Literal("delivered"),
      requestedAt: Timestamp,
      attemptCount: Type.Integer({ minimum: 1 }),
      failureHistory: Type.Array(DeliveryFailureSchema),
      deliveredAt: Timestamp,
    },
    { additionalProperties: false },
  ),
]);
const OutcomeBase = {
  id: NonEmptyString,
  observedAt: Timestamp,
  artifacts: Type.Array(RetainedArtifactSchema),
  delivery: DeliverySchema,
};
export const OutcomeSchema = Type.Union([
  Type.Object(
    { ...OutcomeBase, kind: Type.Literal("reported"), report: WorkerReportSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...OutcomeBase,
      kind: Type.Literal("unreported"),
      reason: NonEmptyString,
      rawWorkerText: Type.Optional(NonEmptyString),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...OutcomeBase, kind: Type.Literal("cancelled"), reason: NonEmptyString },
    { additionalProperties: false },
  ),
]);

export const AttemptSchema = Type.Object(
  {
    id: NonEmptyString,
    state: stringLiterals(["queued", "active", "finished"] as const),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    continuationOf: Type.Optional(NonEmptyString),
    candidate: Type.Optional(CandidateLineageSchema),
    baseRevision: Type.Optional(Commit),
    selection: SelectionSchema,
    effectiveModels: Type.Optional(Type.Array(EffectiveModelSchema, { minItems: 1 })),
    execution: Type.Optional(WorkerExecutionSchema),
    application: Type.Optional(ApplicationSchema),
    cleanup: Type.Optional(CleanupSchema),
    outputDisposition: Type.Optional(OutputDispositionSchema),
    outcome: Type.Optional(OutcomeSchema),
  },
  { additionalProperties: false },
);
const TaskBase = {
  id: NonEmptyString,
  objective: NonEmptyString,
  intentIndex: Type.Integer({ minimum: 0 }),
  createdAt: Timestamp,
  attempts: Type.Array(AttemptSchema, { minItems: 1 }),
};
export const TaskSchema = Type.Union([
  Type.Object(
    {
      ...TaskBase,
      kind: Type.Literal("research"),
      expectedEvidence: Type.Array(NonEmptyString, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...TaskBase,
      kind: Type.Literal("experiment"),
      permittedEffects: Type.Array(NonEmptyString, { minItems: 1 }),
      stopCondition: NonEmptyString,
      expectedEvidence: Type.Array(NonEmptyString, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...TaskBase,
      kind: Type.Literal("implementation"),
      acceptance: Type.Array(NonEmptyString, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...TaskBase,
      kind: Type.Literal("review"),
      subject: ReviewSubjectSchema,
      concern: NonEmptyString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...TaskBase,
      kind: Type.Literal("consultation"),
      context: Type.Optional(Type.String({ maxLength: 20_000 })),
    },
    { additionalProperties: false },
  ),
]);
const CompletionAccountingSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("unresolved_attempt"),
      taskId: NonEmptyString,
      attemptId: NonEmptyString,
      reason: NonEmptyString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("unresolved_outcome"), outcomeId: NonEmptyString, reason: NonEmptyString },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("undelivered_outcome"),
      outcomeId: NonEmptyString,
      reason: NonEmptyString,
    },
    { additionalProperties: false },
  ),
]);
const CompletionSchema = Type.Object(
  {
    conclusion: NonEmptyString,
    evidence: Type.Array(EvidenceSchema, { minItems: 1 }),
    limitations: Type.Array(NonEmptyString),
    accounting: Type.Array(CompletionAccountingSchema),
    completedAt: Timestamp,
  },
  { additionalProperties: false },
);
const SuspensionSchema = Type.Object(
  { reason: NonEmptyString, suspendedAt: Timestamp },
  { additionalProperties: false },
);
export const WorkstreamSchema = Type.Object(
  {
    format: Type.Literal(WORKSTREAM_FORMAT),
    schemaVersion: Type.Literal(WORKSTREAM_SCHEMA_VERSION),
    revision: Type.Integer({ minimum: 0 }),
    id: NonEmptyString,
    purpose: NonEmptyString,
    repository: RepositoryIdentitySchema,
    coordinator: CoordinatorIdentitySchema,
    lifecycle: stringLiterals(["active", "suspended", "completed"] as const),
    suspension: Type.Optional(SuspensionSchema),
    intents: Type.Array(IntentSchema, { minItems: 1 }),
    tasks: Type.Array(TaskSchema),
    completion: Type.Optional(CompletionSchema),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  },
  { additionalProperties: false },
);

export type RepositoryIdentity = Static<typeof RepositoryIdentitySchema>;
export type CoordinatorIdentity = Static<typeof CoordinatorIdentitySchema>;
export type HumanInputReceiptData = Static<typeof HumanInputReceiptDataSchema>;
export type HandoffGrant = Static<typeof HandoffGrantSchema>;
export type Intent = Static<typeof IntentSchema>;
export type CandidateLineage = Static<typeof CandidateLineageSchema>;
export type ModelSelection = Static<typeof SelectionSchema>;
export type LaunchCheckpoint = Static<typeof LaunchCheckpointSchema>;
export type WorkerExecution = Static<typeof WorkerExecutionSchema>;
export type CancellationCheckpoint = Static<typeof CancellationCheckpointSchema>;
export type Placement = Static<typeof PlacementSchema>;
export type RetainedArtifact = Static<typeof RetainedArtifactSchema>;
export type Delivery = Static<typeof DeliverySchema>;
export type Outcome = Static<typeof OutcomeSchema>;
export type Attempt = Static<typeof AttemptSchema>;
export type Task = Static<typeof TaskSchema>;
/** An immutable Task contract; sibling Attempts are deliberately not exposed. */
export type TaskContract = Task extends infer Item
  ? Item extends Task
    ? Omit<Item, "attempts">
    : never
  : never;
export type CompletionAccounting = Static<typeof CompletionAccountingSchema>;
export type Completion = Static<typeof CompletionSchema>;
export type Suspension = Static<typeof SuspensionSchema>;
export type Workstream = Static<typeof WorkstreamSchema>;
export type AttemptKey = Readonly<{ taskId: string; attemptId: string }>;
export type TerminalObservation =
  | Readonly<{
      kind: "reported";
      observedAt: string;
      artifacts: RetainedArtifact[];
      report: Extract<Outcome, { kind: "reported" }>["report"];
      deliveryRequestedAt: string;
    }>
  | Readonly<{
      kind: "unreported";
      observedAt: string;
      artifacts: RetainedArtifact[];
      reason: string;
      rawWorkerText?: string;
      deliveryRequestedAt: string;
    }>
  | Readonly<{
      kind: "cancelled";
      observedAt: string;
      artifacts: RetainedArtifact[];
      reason: string;
      deliveryRequestedAt: string;
    }>;

function outcomeIdForAttempt(attemptId: string): string {
  return `${attemptId}:outcome`;
}

export function validateWorkstream(value: Workstream): void {
  if (!Value.Check(WorkstreamSchema, value)) {
    const issue = Value.Errors(WorkstreamSchema, value)[0];
    throw new Error(
      `Invalid Workstream at ${issue?.instancePath === undefined || issue.instancePath === "" ? "/" : issue.instancePath}: ${issue?.message ?? "schema mismatch"}.`,
    );
  }
  validateWorkstreamInvariants(value);
}

/** Validate domain relationships after the caller has checked WorkstreamSchema. */
export function validateWorkstreamInvariants(value: Workstream): void {
  validateGrounding(value);
  unique(
    value.tasks.map((task) => task.id),
    "Task",
  );
  const attempts = value.tasks.flatMap((task) => task.attempts);
  unique(
    attempts.map((attempt) => attempt.id),
    "Attempt",
  );
  unique(
    attempts.flatMap((attempt) => (attempt.outcome ? [attempt.outcome.id] : [])),
    "Outcome",
  );
  const handles = [
    value.id,
    ...value.tasks.map((task) => task.id),
    ...attempts.map((attempt) => attempt.id),
    ...attempts.flatMap((attempt) => (attempt.outcome ? [attempt.outcome.id] : [])),
  ];
  if (new Set(handles).size !== handles.length)
    throw new Error("Workstream, Task, Attempt, and Outcome ids must be globally distinct.");
  for (const task of value.tasks) {
    if (task.intentIndex >= value.intents.length)
      throw new Error(`Task ${task.id} references unknown Intent index ${task.intentIndex}.`);
    validateTask(value, task);
  }
  validateLifecycle(value);
}

function validateGrounding(workstream: Workstream): void {
  for (const [index, intent] of workstream.intents.entries()) {
    if (intent.grounding.kind === "human_input_receipt") {
      if (
        intent.grounding.sessionId !== workstream.coordinator.sessionId ||
        intent.grounding.sessionFile !== workstream.coordinator.sessionFile
      )
        throw new Error(`Intent ${index} direct receipt belongs to another coordinator session.`);
    } else {
      if (index !== 0)
        throw new Error("Handoff Grant grounding is only valid for the first Intent.");
      if (!sameValue(intent.grounding.targetRepository, workstream.repository))
        throw new Error(`Intent ${index} Handoff Grant targets another repository.`);
    }
  }
}
function validateTask(workstream: Workstream, task: Task): void {
  if (task.kind === "review") validateReviewSubject(workstream, task);
  for (const [index, attempt] of task.attempts.entries()) {
    validateAttempt(workstream, task, attempt);
    if (attempt.continuationOf !== undefined) {
      const parentIndex = task.attempts.findIndex((item) => item.id === attempt.continuationOf);
      if (parentIndex < 0 || parentIndex >= index)
        throw new Error(
          `Attempt ${attempt.id} continuation is not an earlier Attempt in Task ${task.id}.`,
        );
      const parent = task.attempts[parentIndex];
      if (
        parent?.state !== "finished" ||
        parent.execution?.sessionFile === undefined ||
        parent.cleanup?.state !== "completed" ||
        !parent.cleanup.workerClosed
      )
        throw new Error(
          `Attempt ${attempt.id} continuation parent has no retained closed Worker session.`,
        );
    }
  }
}
function validateReviewSubject(
  workstream: Workstream,
  task: Extract<Task, { kind: "review" }>,
): void {
  const subject = task.subject;
  if (subject.kind === "revision") return;
  const ids = subject.kind === "comparison" ? subject.outcomeIds : [subject.outcomeId];
  if (new Set(ids).size !== ids.length)
    throw new Error(`Review Task ${task.id} repeats an Outcome.`);
  for (const id of ids) {
    const outcome = findOutcome(workstream, id);
    if (outcome === undefined)
      throw new Error(`Review Task ${task.id} references unknown Outcome ${id}.`);
    if (
      subject.kind === "artifact" &&
      !outcome.artifacts.some(
        (artifact) => artifact.id === subject.artifactId && artifact.retention === "retained",
      )
    )
      throw new Error(`Review Task ${task.id} references an artifact that is not retained.`);
  }
}
function expectedReportKind(task: Task): "research" | "review" | "implementation" {
  return task.kind === "review"
    ? "review"
    : task.kind === "implementation"
      ? "implementation"
      : "research";
}
function validateAttempt(workstream: Workstream, task: Task, attempt: Attempt): void {
  validateAttemptBase(task, attempt);
  if ((attempt.state === "finished") !== (attempt.outcome !== undefined))
    throw new Error(`Attempt ${attempt.id} must embed exactly one Outcome iff finished.`);
  if (attempt.outcome !== undefined) validateOutcome(task, attempt, attempt.outcome);
  if (attempt.state === "queued" && hasOperationalFacts(attempt))
    throw new Error(`Queued Attempt ${attempt.id} contains execution or terminal facts.`);
  validateActiveDeclaration(attempt);
  if (
    attempt.state !== "finished" &&
    (attempt.application !== undefined || attempt.outputDisposition !== undefined)
  )
    throw new Error(`Unfinished Attempt ${attempt.id} contains output settlement facts.`);
  validateExecution(attempt);
  validateSelection(task, attempt);
  validateCandidate(workstream, task, attempt);
  validateApplication(task, attempt);
  validateCleanup(attempt);
  validateOutputDisposition(task, attempt);
}
function validateAttemptBase(task: Task, attempt: Attempt): void {
  if (task.kind === "experiment") {
    if (attempt.baseRevision === undefined)
      throw new Error(`Experiment Attempt ${attempt.id} requires an exact base revision.`);
    if (attempt.candidate !== undefined)
      throw new Error(`Experiment Attempt ${attempt.id} cannot contain candidate lineage.`);
    return;
  }
  if (task.kind === "implementation") {
    if (attempt.baseRevision === undefined || attempt.candidate === undefined)
      throw new Error(
        `Implementation Attempt ${attempt.id} requires exact base and candidate lineage.`,
      );
    return;
  }
  if (task.kind === "review" && task.subject.kind === "revision") {
    if (attempt.baseRevision !== task.subject.revision)
      throw new Error(
        `Revision review Attempt ${attempt.id} must persist its exact subject revision.`,
      );
    return;
  }
  if (attempt.baseRevision !== undefined || attempt.candidate !== undefined)
    throw new Error(`Attempt ${attempt.id} contains kind-incompatible Git lineage.`);
}

function validateOutcome(
  task: Task,
  attempt: Attempt,
  outcome: NonNullable<Attempt["outcome"]>,
): void {
  if (outcome.id !== outcomeIdForAttempt(attempt.id))
    throw new Error(`Attempt ${attempt.id} has a non-deterministic Outcome id.`);
  unique(
    outcome.artifacts.map((artifact) => artifact.id),
    `artifact in Outcome ${outcome.id}`,
  );
  const failureCount = outcome.delivery.failureHistory.length;
  const expectedDeliveryCount =
    outcome.delivery.state === "pending" ? failureCount : failureCount + 1;
  if (outcome.delivery.attemptCount !== expectedDeliveryCount)
    throw new Error(`Outcome ${outcome.id} delivery attempt count is not exact.`);
  if (outcome.kind === "reported" && outcome.report.kind !== expectedReportKind(task))
    throw new Error(`Attempt ${attempt.id} Report kind does not match Task kind ${task.kind}.`);
}
/**
 * An active Attempt must carry its exact deterministic placement declaration and
 * initial not-sent submission checkpoint. The declaration precedes any external
 * creation and does not prove a worktree or Worker resource exists.
 */
function validateActiveDeclaration(attempt: Attempt): void {
  if (attempt.state !== "active") return;
  if (attempt.execution?.placement !== undefined && attempt.execution.submission !== undefined)
    return;
  throw new Error(
    `Active Attempt ${attempt.id} must begin with its exact placement declaration and not-sent submission checkpoint.`,
  );
}
function hasOperationalFacts(attempt: Attempt): boolean {
  return (
    attempt.execution !== undefined ||
    attempt.effectiveModels !== undefined ||
    attempt.application !== undefined ||
    attempt.cleanup !== undefined ||
    attempt.outputDisposition !== undefined ||
    attempt.outcome !== undefined
  );
}
function validateExecution(attempt: Attempt): void {
  const execution = attempt.execution;
  if (execution === undefined) return;
  if (execution.sessionFile !== undefined && execution.placement === undefined)
    throw new Error(`Attempt ${attempt.id} has a Worker session without placement.`);
  if (execution.launch !== undefined) {
    if (execution.placement === undefined || execution.sessionFile === undefined)
      throw new Error(`Attempt ${attempt.id} launch checkpoint has no exact placement/session.`);
    if (execution.launch.phase !== "pane" && execution.launch.cwd !== execution.placement.path)
      throw new Error(`Attempt ${attempt.id} launch cwd does not match its placement.`);
  }
  if (execution.submission !== undefined && execution.placement === undefined)
    throw new Error(`Attempt ${attempt.id} has submission state without placement.`);
  if (
    execution.submission !== undefined &&
    execution.submission !== "not_sent" &&
    (execution.sessionFile === undefined || execution.launch?.phase !== "ready")
  )
    throw new Error(`Attempt ${attempt.id} sent submission requires a ready Worker session.`);
}
function executionTransition(
  attemptId: string,
  current: WorkerExecution | undefined,
  next: WorkerExecution,
  allowPlacementDeclaration = false,
): WorkerExecution {
  const merged = mergeExecution(current, next);
  assertImmutableExecutionFields(attemptId, current, next);
  if (current !== undefined && sameValue(current, merged)) return current;
  assertSingleExecutionAdvancement(attemptId, current, next, allowPlacementDeclaration);
  assertLaunchTransition(attemptId, current?.launch, next.launch);
  assertSubmissionTransition(attemptId, current?.submission, next.submission, current?.launch);
  assertSteeringTransition(attemptId, current?.steering, next.steering);
  return merged;
}
function assertSingleExecutionAdvancement(
  attemptId: string,
  current: WorkerExecution | undefined,
  next: WorkerExecution,
  allowPlacementDeclaration: boolean,
): void {
  const fields = ["placement", "sessionFile", "launch", "submission", "steering"] as const;
  const advanced = fields.filter(
    (field) => next[field] !== undefined && !sameValue(current?.[field], next[field]),
  );
  const placementWithDeclaration =
    advanced.length === 2 &&
    advanced.includes("placement") &&
    advanced.includes("submission") &&
    next.submission === "not_sent";
  if (advanced.length !== 1 && !(allowPlacementDeclaration && placementWithDeclaration))
    throw new Error(
      `Attempt ${attemptId} execution mutation must record exactly one new external-effect stage.`,
    );
  if (advanced.includes("sessionFile") && current?.placement === undefined)
    throw new Error(`Attempt ${attemptId} Worker session requires a prior placement checkpoint.`);
  if (advanced.includes("launch") && current?.sessionFile === undefined)
    throw new Error(`Attempt ${attemptId} launch requires a prior session checkpoint.`);
  if (
    advanced.includes("submission") &&
    next.submission === "not_sent" &&
    current?.placement === undefined &&
    !advanced.includes("placement")
  )
    throw new Error(`Attempt ${attemptId} submission declaration requires Worker placement.`);
}
function mergeExecution(
  current: WorkerExecution | undefined,
  next: WorkerExecution,
): WorkerExecution {
  const merged: WorkerExecution = { ...current };
  for (const field of ["placement", "sessionFile", "launch", "submission", "steering"] as const)
    if (next[field] !== undefined) Object.assign(merged, { [field]: next[field] });
  return merged;
}
function assertImmutableExecutionFields(
  attemptId: string,
  current: WorkerExecution | undefined,
  next: WorkerExecution,
): void {
  if (
    current?.placement !== undefined &&
    next.placement !== undefined &&
    !sameValue(current.placement, next.placement)
  )
    throw new Error(`Attempt ${attemptId} Worker placement is immutable.`);
  if (
    current?.sessionFile !== undefined &&
    next.sessionFile !== undefined &&
    current.sessionFile !== next.sessionFile
  )
    throw new Error(`Attempt ${attemptId} Worker session file is immutable.`);
  if (next.cancellation !== undefined)
    throw new Error(
      `Attempt ${attemptId} cancellation must use the cancellation checkpoint transition.`,
    );
}
function assertLaunchTransition(
  attemptId: string,
  current: WorkerExecution["launch"] | undefined,
  next: WorkerExecution["launch"] | undefined,
): void {
  if (next === undefined) return;
  if (current === undefined) {
    if (next.phase !== "pane")
      throw new Error(`Attempt ${attemptId} launch progression cannot skip pane.`);
    return;
  }
  if (sameValue(current, next)) return;
  if (current.phase === "pane" && next.phase === "resource") {
    if (current.workspaceId === next.workspaceId && current.paneId === next.paneId) return;
    throw new Error(`Attempt ${attemptId} launch resource does not match its pane.`);
  }
  if (current.phase === "resource" && next.phase === "ready") {
    if (
      current.workspaceId === next.workspaceId &&
      current.tabId === next.tabId &&
      current.paneId === next.paneId &&
      current.terminalId === next.terminalId &&
      current.agentName === next.agentName &&
      current.cwd === next.cwd
    )
      return;
    throw new Error(`Attempt ${attemptId} ready launch does not match its resource.`);
  }
  throw new Error(`Attempt ${attemptId} launch progression is not monotonic.`);
}
function assertSubmissionTransition(
  attemptId: string,
  oldSubmission: WorkerExecution["submission"] | undefined,
  newSubmission: WorkerExecution["submission"] | undefined,
  launch: WorkerExecution["launch"] | undefined,
): void {
  if (
    newSubmission !== undefined &&
    oldSubmission !== undefined &&
    !validSubmissionTransition(oldSubmission, newSubmission)
  )
    throw new Error(`Attempt ${attemptId} submission transition is not monotonic.`);
  if (newSubmission !== undefined && oldSubmission === undefined && newSubmission !== "not_sent")
    throw new Error(`Attempt ${attemptId} submission must begin at not_sent.`);
  if (newSubmission !== undefined && newSubmission !== "not_sent" && launch?.phase !== "ready")
    throw new Error(`Attempt ${attemptId} sent submission requires a ready launch.`);
}
function validSubmissionTransition(
  oldSubmission: NonNullable<WorkerExecution["submission"]>,
  newSubmission: NonNullable<WorkerExecution["submission"]>,
): boolean {
  if (oldSubmission === newSubmission) return true;
  if (oldSubmission === "not_sent") return newSubmission === "uncertain";
  if (oldSubmission === "uncertain")
    return newSubmission === "submitted" || newSubmission === "started";
  return oldSubmission === "submitted" && newSubmission === "started";
}
function assertSteeringTransition(
  attemptId: string,
  current: WorkerExecution["steering"] | undefined,
  next: WorkerExecution["steering"] | undefined,
): void {
  if (next === undefined || current === undefined || sameValue(current, next)) return;
  if (current.state === "uncertain") {
    if (next.state === "submitted" && next.text === current.text) return;
    throw new Error(`Attempt ${attemptId} uncertain steering checkpoint cannot be overwritten.`);
  }
  if (next.state === "uncertain" && next.text !== current.text) return;
  throw new Error(`Attempt ${attemptId} steering checkpoint progression is not exact.`);
}
function validateSelection(task: Task, attempt: Attempt): void {
  const selection = attempt.selection;
  if (task.kind === "implementation") {
    if (selection.role !== "implementation")
      throw new Error(`Attempt ${attempt.id} selection does not match implementation Task.`);
  } else {
    const expected: "research" | "review" | "consultation" =
      task.kind === "experiment" ? "research" : task.kind;
    if (selection.role !== expected)
      throw new Error(`Attempt ${attempt.id} selection does not match Task kind ${task.kind}.`);
    if (task.kind === "consultation" && !sameValue(selection, task.attempts[0]?.selection))
      throw new Error(`Attempt ${attempt.id} changes the consultation Task advisor selection.`);
  }
}
function validateCandidate(workstream: Workstream, task: Task, attempt: Attempt): void {
  const candidate = attempt.candidate;
  if (candidate === undefined) return;
  if (task.kind !== "implementation" || attempt.baseRevision === undefined)
    throw new Error(
      `Attempt ${attempt.id} candidate lineage is only valid for based implementation work.`,
    );
  if (candidate.kind === "initial") {
    validateInitialCandidate(attempt, candidate.rootCommit);
    return;
  }
  validateDerivedCandidate(workstream, attempt, candidate);
}
function validateInitialCandidate(attempt: Attempt, rootCommit: string): void {
  if (rootCommit !== attempt.baseRevision)
    throw new Error(`Attempt ${attempt.id} initial candidate is not rooted at its base revision.`);
}
function validateDerivedCandidate(
  workstream: Workstream,
  attempt: Attempt,
  candidate: Extract<CandidateLineage, { kind: "correction" | "integration" }>,
): void {
  const parentLocated = findAttemptLocation(workstream, candidate.parentAttemptId);
  if (parentLocated === undefined || parentLocated.task.kind !== "implementation")
    throw new Error(`Attempt ${attempt.id} candidate references an unknown implementation parent.`);
  const parent = parentLocated.attempt;
  const parentCommit = changedImplementationCommit(parent);
  if (parentCommit !== candidate.parentCommit)
    throw new Error(`Attempt ${attempt.id} candidate parent commit is not exact.`);
  if (!isCandidateLineageParent(parentLocated.task, parent, parentCommit))
    throw new Error(
      `Attempt ${attempt.id} candidate parent lineage is not maintained or disposed exactly.`,
    );
  if (parent.candidate === undefined || parent.baseRevision === undefined)
    throw new Error(`Attempt ${attempt.id} candidate parent lineage is incomplete.`);
  if (!validCandidateBase(parent))
    throw new Error(`Attempt ${attempt.id} candidate parent lineage is not exact.`);
  if (candidate.kind === "correction") {
    if (parent.candidate.rootCommit !== candidate.rootCommit)
      throw new Error(`Attempt ${attempt.id} correction does not preserve its candidate root.`);
    if (attempt.baseRevision !== candidate.parentCommit)
      throw new Error(`Attempt ${attempt.id} correction does not continue its exact candidate.`);
  }
  if (candidate.kind === "integration" && candidate.rootCommit !== attempt.baseRevision)
    throw new Error(`Attempt ${attempt.id} integration is not rooted at its destination base.`);
}
function isCandidateLineageParent(task: Task, attempt: Attempt, commit: string): boolean {
  if (isRetainedCandidateParent(task, attempt, commit)) return true;
  return (
    attempt.state === "finished" &&
    attempt.execution?.placement?.kind === "isolated_worktree" &&
    attempt.execution.launch?.phase === "ready" &&
    attempt.cleanup?.state === "completed" &&
    attempt.cleanup.workerClosed &&
    attempt.cleanup.expectedHead === commit &&
    attempt.outputDisposition !== undefined &&
    attempt.outputDisposition.expectedHead === commit
  );
}

export function isRetainedCandidateParent(task: Task, attempt: Attempt, commit: string): boolean {
  const cleanup = attempt.cleanup;
  const disposition = outputStateBeforeDisposition(task, attempt);
  return (
    attempt.state === "finished" &&
    attempt.execution?.placement?.kind === "isolated_worktree" &&
    attempt.execution.launch?.phase === "ready" &&
    cleanup?.state === "completed" &&
    cleanup.workerClosed &&
    cleanup.expectedHead === commit &&
    attempt.outputDisposition === undefined &&
    disposition.kind === "maintained_output" &&
    disposition.checkout === "removed" &&
    disposition.commit === commit
  );
}
function validCandidateBase(attempt: Attempt): boolean {
  const candidate = attempt.candidate;
  if (candidate === undefined || attempt.baseRevision === undefined) return false;
  return candidate.kind === "initial"
    ? attempt.baseRevision === candidate.rootCommit
    : candidate.kind === "correction"
      ? attempt.baseRevision === candidate.parentCommit
      : attempt.baseRevision === candidate.rootCommit;
}
function validateApplication(task: Task, attempt: Attempt): void {
  const application = attempt.application;
  if (application === undefined) return;
  if (
    task.kind !== "implementation" ||
    attempt.execution?.placement?.kind !== "isolated_worktree" ||
    attempt.execution.launch?.phase !== "ready"
  )
    throw new Error(
      `Attempt ${attempt.id} application is outside a ready isolated implementation.`,
    );
  const candidateCommit = changedImplementationCommit(attempt);
  if (
    candidateCommit === undefined ||
    attempt.candidate === undefined ||
    application.commit !== candidateCommit
  )
    throw new Error(
      `Attempt ${attempt.id} application is not bound to its reported changed candidate.`,
    );
  if (
    application.rootCommit !== attempt.candidate.rootCommit ||
    application.commits.at(-1) !== application.commit
  )
    throw new Error(`Attempt ${attempt.id} application lineage is not exact.`);
  if ((application.state === "applied") !== (application.revision !== undefined))
    throw new Error(`Attempt ${attempt.id} application revision does not match applied state.`);
  if ((application.state === "blocked") !== (application.error !== undefined))
    throw new Error(`Attempt ${attempt.id} application blocker does not match its state.`);
}
function validateCleanup(attempt: Attempt): void {
  const cleanup = attempt.cleanup;
  if (cleanup !== undefined) {
    validateCleanupShape(attempt, cleanup);
    if (attempt.state === "active") validateActiveCleanup(attempt, cleanup);
  }
  if (isCancelledWorkerSettlement(attempt)) validateCancelledWorkerSettlement(attempt, cleanup);
}
function isCancelledWorkerSettlement(attempt: Attempt): boolean {
  return (
    attempt.state === "finished" &&
    attempt.outcome?.kind === "cancelled" &&
    attempt.execution !== undefined
  );
}
function validateCleanupShape(attempt: Attempt, cleanup: NonNullable<Attempt["cleanup"]>): void {
  if ((cleanup.state === "blocked") !== (cleanup.error !== undefined))
    throw new Error(`Attempt ${attempt.id} cleanup blocker does not match its state.`);
  if (cleanup.state === "completed" && !cleanup.workerClosed)
    throw new Error(`Attempt ${attempt.id} completed cleanup has no closed Worker.`);
}
/** The active cleanup path exists only after verified Worker termination, and only its start. */
function validateActiveCleanup(attempt: Attempt, cleanup: NonNullable<Attempt["cleanup"]>): void {
  if (attempt.execution?.cancellation?.state !== "terminated")
    throw new Error(
      `Attempt ${attempt.id} active cleanup requires a terminated cancellation checkpoint.`,
    );
  if (cleanup.state !== "pending")
    throw new Error(`Attempt ${attempt.id} active cleanup may only be pending.`);
}
/** A cancelled Worker settlement keeps its exact termination proof and durable closure. */
function validateCancelledWorkerSettlement(attempt: Attempt, cleanup: Attempt["cleanup"]): void {
  if (attempt.execution?.cancellation?.state !== "terminated")
    throw new Error(
      `Attempt ${attempt.id} cancelled Worker settlement requires a terminated cancellation checkpoint.`,
    );
  if (cleanup?.workerClosed !== true)
    throw new Error(
      `Attempt ${attempt.id} cancelled Worker settlement requires durable Worker closure.`,
    );
}
function validateOutputDisposition(task: Task, attempt: Attempt): void {
  const disposition = attempt.outputDisposition;
  if (disposition === undefined) return;
  if (
    attempt.execution?.placement?.kind !== "isolated_worktree" ||
    attempt.cleanup?.workerClosed !== true ||
    attempt.cleanup.expectedHead === undefined
  )
    throw new Error(`Attempt ${attempt.id} output disposition lacks closed isolated ownership.`);
  if (attempt.cleanup.expectedHead !== disposition.expectedHead)
    throw new Error(`Attempt ${attempt.id} output disposition checkpoint does not match cleanup.`);
  if (
    !outputDispositionEligible(task, attempt) &&
    !(disposition.state === "completed" && attempt.cleanup.state === "completed")
  )
    throw new Error(`Attempt ${attempt.id} output disposition is not required.`);
  if (disposition.kind === "applied" && attempt.application?.state !== "applied")
    throw new Error(`Attempt ${attempt.id} applied output disposition lacks applied Git state.`);
  if (disposition.kind === "discarded" && attempt.application !== undefined)
    throw new Error(`Attempt ${attempt.id} cannot combine application with discarded output.`);
  if ((disposition.state === "blocked") !== (disposition.error !== undefined))
    throw new Error(`Attempt ${attempt.id} output disposition blocker does not match its state.`);
}
function validateLifecycle(workstream: Workstream): void {
  validateSuspension(workstream);
  if ((workstream.lifecycle === "completed") !== (workstream.completion !== undefined))
    throw new Error("Completed lifecycle and Completion must appear together.");
  if (workstream.lifecycle === "completed") validateCompletedLifecycle(workstream);
  if (workstream.completion === undefined) return;
  const expected = deriveCompletionAccounting(workstream);
  if (!sameValue(expected, workstream.completion.accounting))
    throw new Error("Completion accounting must be the exact derived set.");
}

function validateCompletedLifecycle(workstream: Workstream): void {
  // A completed Workstream cannot retain any unfinished Attempt; this mirrors
  // `completeWorkstream` at the persisted read boundary without widening the
  // existing completion accounting rules.
  for (const task of workstream.tasks)
    for (const attempt of task.attempts)
      if (attempt.state !== "finished")
        throw new Error(`Completed Workstream contains unfinished Attempt ${attempt.id}.`);
}

function validateSuspension(workstream: Workstream): void {
  if ((workstream.lifecycle === "suspended") !== (workstream.suspension !== undefined))
    throw new Error("Suspended lifecycle and current Suspension must appear together.");
  if (workstream.suspension === undefined) return;
  if (!workstream.suspension.reason.trim()) throw new Error("Suspension reason is required.");
}

export function findTask(workstream: Workstream, taskId: string): Task | undefined {
  return workstream.tasks.find((task) => task.id === taskId);
}
export function findAttempt(task: Task, attemptId: string): Attempt | undefined {
  return task.attempts.find((attempt) => attempt.id === attemptId);
}
export type AttemptLocation = { task: Task; attempt: Attempt };
export function findAttemptLocation(
  workstream: Workstream,
  attemptId: string,
): AttemptLocation | undefined {
  for (const task of workstream.tasks) {
    const attempt = findAttempt(task, attemptId);
    if (attempt !== undefined) return { task, attempt };
  }
  return undefined;
}
function findOutcome(workstream: Workstream, outcomeId: string): Outcome | undefined {
  for (const task of workstream.tasks)
    for (const attempt of task.attempts)
      if (attempt.outcome?.id === outcomeId) return attempt.outcome;
  return undefined;
}
function requireAttempt(workstream: Workstream, key: AttemptKey): AttemptLocation {
  const task = findTask(workstream, key.taskId);
  if (task === undefined) throw new Error(`Unknown Task ${key.taskId}.`);
  const attempt = findAttempt(task, key.attemptId);
  if (attempt === undefined)
    throw new Error(`Unknown Attempt ${key.attemptId} in Task ${key.taskId}.`);
  return { task, attempt };
}

export function createWorkstream(input: {
  id: string;
  purpose: string;
  repository: RepositoryIdentity;
  coordinator: CoordinatorIdentity;
  intent: Intent;
  createdAt: string;
}): Workstream {
  const workstream: Workstream = {
    format: WORKSTREAM_FORMAT,
    schemaVersion: WORKSTREAM_SCHEMA_VERSION,
    revision: 0,
    id: input.id,
    purpose: input.purpose,
    repository: clone(input.repository),
    coordinator: clone(input.coordinator),
    lifecycle: "active",
    intents: [clone(input.intent)],
    tasks: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
  validateWorkstream(workstream);
  return workstream;
}
export function suspendWorkstream(
  workstream: Workstream,
  suspension: Suspension,
  updatedAt: string,
): Workstream {
  assertActive(workstream, "suspend Workstream");
  return mutate(workstream, updatedAt, (draft) => {
    draft.lifecycle = "suspended";
    draft.suspension = clone(suspension);
  });
}
export function resumeWorkstream(workstream: Workstream, updatedAt: string): Workstream {
  if (workstream.lifecycle !== "suspended")
    throw new Error("Cannot resume a Workstream that is not suspended.");
  return mutate(workstream, updatedAt, (draft) => {
    draft.lifecycle = "active";
    delete draft.suspension;
  });
}
export function reviseIntent(
  workstream: Workstream,
  intent: Intent,
  updatedAt: string,
): Workstream {
  assertActive(workstream, "revise Intent");
  if (
    intent.grounding.kind !== "human_input_receipt" ||
    intent.grounding.sessionId !== workstream.coordinator.sessionId ||
    intent.grounding.sessionFile !== workstream.coordinator.sessionFile
  )
    throw new Error("Revised Intent requires a direct receipt from the current coordinator.");
  return mutate(workstream, updatedAt, (draft) => draft.intents.push(clone(intent)));
}
export function createTask(workstream: Workstream, task: Task, updatedAt: string): Workstream {
  assertActive(workstream, "create Task");
  if (task.intentIndex !== workstream.intents.length - 1)
    throw new Error(`Task ${task.id} must reference the current Intent.`);
  if (
    !task.attempts.every((attempt) => attempt.state === "queued" && !hasOperationalFacts(attempt))
  )
    throw new Error(`Task ${task.id} must begin with pristine queued Attempts.`);
  assertNewCandidateParentsRetained(workstream, task.attempts);
  return mutate(workstream, updatedAt, (draft) => draft.tasks.push(clone(task)));
}
export function appendAttempts(
  workstream: Workstream,
  taskId: string,
  attempts: readonly Attempt[],
  updatedAt: string,
): Workstream {
  assertActive(workstream, "append Attempts");
  const task = findTask(workstream, taskId);
  if (task === undefined) throw new Error(`Unknown Task ${taskId}.`);
  if (task.intentIndex !== workstream.intents.length - 1)
    throw new Error(`Task ${taskId} no longer belongs to the current Intent.`);
  if (!task.attempts.every((attempt) => isReattemptStable(task, attempt)))
    throw new Error(`Task ${taskId} has an unfinished or operationally unstable prior Attempt.`);
  if (attempts.length === 0) throw new Error(`Task ${taskId} requires at least one new Attempt.`);
  for (const attempt of attempts) {
    if (attempt.state !== "queued" || hasOperationalFacts(attempt))
      throw new Error(`Appended Attempt ${attempt.id} must be pristine and queued.`);
    validateSelection(task, attempt);
  }
  assertNewCandidateParentsRetained(workstream, attempts);
  return mutate(workstream, updatedAt, (draft) => {
    const target = findTask(draft, taskId);
    if (target === undefined) throw new Error(`Unknown Task ${taskId}.`);
    target.attempts.push(...clone(attempts));
  });
}
function assertNewCandidateParentsRetained(
  workstream: Workstream,
  attempts: readonly Attempt[],
): void {
  for (const attempt of attempts) {
    const candidate = attempt.candidate;
    if (candidate === undefined || candidate.kind === "initial") continue;
    const parent = findAttemptLocation(workstream, candidate.parentAttemptId);
    const commit = parent === undefined ? undefined : changedImplementationCommit(parent.attempt);
    if (
      parent === undefined ||
      commit === undefined ||
      !isRetainedCandidateParent(parent.task, parent.attempt, commit)
    )
      throw new Error(`Attempt ${attempt.id} candidate parent is not an eligible retained output.`);
  }
}

/**
 * Activate only by durably declaring the exact deterministic placement and the
 * initial not-sent submission checkpoint. This declaration precedes and does
 * not prove any external worktree or Worker resource creation.
 */
export function activateAttempt(
  workstream: Workstream,
  key: AttemptKey,
  updatedAt: string,
  execution: WorkerExecution,
): Workstream {
  assertActive(workstream, "activate Attempt");
  const located = requireAttempt(workstream, key);
  if (located.task.intentIndex !== workstream.intents.length - 1)
    throw new Error(`Attempt ${key.attemptId} no longer belongs to the current Intent.`);
  if (located.attempt.state !== "queued")
    throw new Error(`Attempt ${key.attemptId} is not queued.`);
  if (
    execution.placement === undefined ||
    execution.submission !== "not_sent" ||
    Object.keys(execution).some((field) => field !== "placement" && field !== "submission")
  )
    throw new Error(
      `Attempt ${key.attemptId} activation requires only exact placement and not-sent submission declaration.`,
    );
  const initialExecution = executionTransition(key.attemptId, undefined, execution, true);
  return mutate(workstream, updatedAt, (draft) => {
    const attempt = requireAttempt(draft, key).attempt;
    attempt.state = "active";
    attempt.updatedAt = updatedAt;
    attempt.execution = clone(initialExecution);
  });
}

export function recordEffectiveModel(
  workstream: Workstream,
  key: AttemptKey,
  observation: NonNullable<Attempt["effectiveModels"]>[number],
  updatedAt: string,
): Workstream {
  const current = requireAttempt(workstream, key).attempt;
  if (current.state === "queued")
    throw new Error(`Attempt ${key.attemptId} is not active or finished.`);
  assertNotCompleted(workstream, "record effective model");
  if (current.effectiveModels?.some((item) => sameValue(item, observation)) === true)
    return workstream;
  return mutate(workstream, updatedAt, (draft) => {
    const attempt = requireAttempt(draft, key).attempt;
    attempt.effectiveModels ??= [];
    attempt.effectiveModels.push(clone(observation));
    attempt.updatedAt = updatedAt;
  });
}
export function recordWorkerExecution(
  workstream: Workstream,
  key: AttemptKey,
  execution: WorkerExecution,
  updatedAt: string,
): Workstream {
  assertNotCompleted(workstream, "record Worker execution");
  const current = requireAttempt(workstream, key).attempt;
  if (current.state === "queued")
    throw new Error(`Attempt ${key.attemptId} is not active or finished.`);
  const next = executionTransition(key.attemptId, current.execution, execution);
  if (current.execution !== undefined && sameValue(current.execution, next)) return workstream;
  return mutate(workstream, updatedAt, (draft) => {
    const attempt = requireAttempt(draft, key).attempt;
    attempt.execution = clone(next);
    attempt.updatedAt = updatedAt;
  });
}
export function checkpointApplication(
  workstream: Workstream,
  key: AttemptKey,
  application: Static<typeof ApplicationSchema>,
  updatedAt: string,
): Workstream {
  const current = requireAttempt(workstream, key).attempt;
  if (current.state !== "finished")
    throw new Error(`Attempt ${key.attemptId} must be finished before application.`);
  if (current.outputDisposition?.kind === "discarded")
    throw new Error(`Attempt ${key.attemptId} output is committed to discard, not application.`);
  if (workstream.lifecycle === "completed" && current.application === undefined) {
    assertCompletedObligation(workstream, key, "application");
    if (application.state === "applied")
      throw new Error(`Attempt ${key.attemptId} application must begin with a pending checkpoint.`);
  }
  if (current.application !== undefined && !monotonicApplication(current.application, application))
    throw new Error(
      `Attempt ${key.attemptId} application transition rewrites identity or is not monotonic.`,
    );
  return mutate(workstream, updatedAt, (draft) => {
    requireAttempt(draft, key).attempt.application = clone(application);
    requireAttempt(draft, key).attempt.updatedAt = updatedAt;
    refreshCompletion(draft);
  });
}
export function checkpointCleanup(
  workstream: Workstream,
  key: AttemptKey,
  cleanup: Static<typeof CleanupSchema>,
  updatedAt: string,
): Workstream {
  const current = requireAttempt(workstream, key).attempt;
  if (current.execution?.placement === undefined)
    throw new Error(`Attempt ${key.attemptId} cleanup has no Worker placement.`);
  if (current.state === "active") {
    // Only the cancellation path may checkpoint cleanup while the Attempt is
    // still active, and only its pending start. Active normal-work cleanup and
    // active completed/blocked placement cleanup are forbidden.
    if (current.execution?.cancellation?.state !== "terminated")
      throw new Error(
        `Attempt ${key.attemptId} active cleanup requires a terminated cancellation checkpoint.`,
      );
    if (cleanup.state !== "pending")
      throw new Error(`Attempt ${key.attemptId} active cleanup may only begin pending.`);
  } else if (current.state !== "finished") {
    throw new Error(`Attempt ${key.attemptId} must be finished before cleanup.`);
  }
  if (workstream.lifecycle === "completed" && current.cleanup === undefined)
    assertCompletedObligation(workstream, key, "cleanup");
  if (current.cleanup !== undefined && !monotonicCleanup(current.cleanup, cleanup))
    throw new Error(
      `Attempt ${key.attemptId} cleanup transition is not monotonic or rewrites identity.`,
    );
  return mutate(workstream, updatedAt, (draft) => {
    requireAttempt(draft, key).attempt.cleanup = clone(cleanup);
    requireAttempt(draft, key).attempt.updatedAt = updatedAt;
    refreshCompletion(draft);
  });
}
export function checkpointOutputDisposition(
  workstream: Workstream,
  key: AttemptKey,
  disposition: Static<typeof OutputDispositionSchema>,
  updatedAt: string,
): Workstream {
  const located = requireAttempt(workstream, key);
  const current = located.attempt;
  if (current.state !== "finished")
    throw new Error(`Attempt ${key.attemptId} must be finished before output disposition.`);
  if (disposition.kind === "discarded" && current.application !== undefined)
    throw new Error(`Attempt ${key.attemptId} output is committed to application, not discard.`);
  if (workstream.lifecycle === "completed" && current.outputDisposition === undefined)
    assertCompletedObligation(workstream, key, "disposition");
  if (
    current.outputDisposition?.state !== "completed" &&
    !outputDispositionEligible(located.task, current)
  )
    throw new Error(`Attempt ${key.attemptId} output disposition is not required.`);
  if (
    current.outputDisposition !== undefined &&
    !monotonicDisposition(current.outputDisposition, disposition)
  )
    throw new Error(
      `Attempt ${key.attemptId} output disposition transition is not monotonic or rewrites identity.`,
    );
  return mutate(workstream, updatedAt, (draft) => {
    requireAttempt(draft, key).attempt.outputDisposition = clone(disposition);
    requireAttempt(draft, key).attempt.updatedAt = updatedAt;
    refreshCompletion(draft);
  });
}
function monotonicApplication(
  old: NonNullable<Attempt["application"]>,
  next: NonNullable<Attempt["application"]>,
): boolean {
  if (
    old.commit !== next.commit ||
    old.expectedHead !== next.expectedHead ||
    old.rootCommit !== next.rootCommit ||
    !sameValue(old.commits, next.commits) ||
    old.expectedRef !== next.expectedRef
  )
    return false;
  if (old.state === "applied")
    return next.state === "applied" && old.revision === next.revision && old.error === next.error;
  if (old.state === "blocked")
    return (next.state === "blocked" && old.error === next.error) || next.state === "applied";
  return next.state === "pending" || next.state === "blocked" || next.state === "applied";
}
function monotonicCleanup(old: Attempt["cleanup"], next: Attempt["cleanup"]): boolean {
  if (old === undefined || next === undefined) return false;
  if (sameValue(old, next)) return true;
  // A known expected head is immutable; an unknown head may only become known.
  if (old.workerClosed && !next.workerClosed) return false;
  if (old.expectedHead !== undefined && old.expectedHead !== next.expectedHead) return false;
  if (old.state === "completed") return false;
  if (old.state === "blocked")
    return next.state === "completed" && next.error === undefined && next.workerClosed;
  if (next.state === "pending") return old.error === undefined;
  if (next.state === "blocked") return next.error !== undefined;
  return next.state === "completed" && next.error === undefined && next.workerClosed;
}
function monotonicDisposition(
  old: Attempt["outputDisposition"],
  next: Attempt["outputDisposition"],
): boolean {
  if (old === undefined || next === undefined) return false;
  if (sameValue(old, next)) return true;
  if (
    old.kind !== next.kind ||
    old.expectedHead !== next.expectedHead ||
    old.reason !== next.reason
  )
    return false;
  if (old.state === "completed") return false;
  if (old.state === "blocked") return next.state === "completed" && next.error === undefined;
  if (next.state === "pending") return next.error === undefined;
  if (next.state === "blocked") return next.error !== undefined;
  return next.state === "completed" && next.error === undefined;
}
/** Own the one monotonic durable termination protocol for an active Attempt. */
export function checkpointCancellation(
  workstream: Workstream,
  key: AttemptKey,
  checkpoint: CancellationCheckpoint,
  updatedAt: string,
): Workstream {
  assertNotCompleted(workstream, "checkpoint cancellation");
  const attempt = requireAttempt(workstream, key).attempt;
  if (attempt.state !== "active") throw new Error(`Attempt ${key.attemptId} is not active.`);
  const current = attempt.execution?.cancellation;
  if (current !== undefined && sameValue(current, checkpoint)) return workstream;
  if (!validCancellationTransition(current, checkpoint))
    throw new Error(
      `Attempt ${key.attemptId} cancellation checkpoint is conflicting or not monotonic.`,
    );
  return mutate(workstream, updatedAt, (draft) => {
    const next = requireAttempt(draft, key).attempt;
    next.execution = { ...next.execution, cancellation: clone(checkpoint) };
    next.updatedAt = updatedAt;
  });
}
function validCancellationTransition(
  current: CancellationCheckpoint | undefined,
  next: CancellationCheckpoint,
): boolean {
  if (current === undefined) return next.state === "requested";
  if (current.requestedAt !== next.requestedAt || current.reason !== next.reason) return false;
  if (current.state === "requested") return next.state === "uncertain";
  if (current.state === "uncertain")
    return (
      (next.state === "blocked" || next.state === "terminated") &&
      current.dispatchAt === next.dispatchAt
    );
  if (current.state === "blocked")
    return next.state === "terminated" && current.dispatchAt === next.dispatchAt;
  return false;
}
export function terminalizeAttempt(
  workstream: Workstream,
  key: AttemptKey,
  observation: TerminalObservation,
  updatedAt: string,
): Workstream {
  const current = requireAttempt(workstream, key).attempt;
  const expected = outcomeFromObservation(key.attemptId, observation);
  if (current.outcome !== undefined) {
    if (sameTerminalSubstance(current.outcome, expected)) return workstream;
    throw new Error(`Attempt ${key.attemptId} already has a conflicting terminal Outcome.`);
  }
  assertNotCompleted(workstream, "terminalize Attempt");
  if (current.state !== "active" && current.state !== "queued")
    throw new Error(`Attempt ${key.attemptId} cannot be terminalized from ${current.state}.`);
  if (observation.kind === "cancelled" && current.state === "active") {
    // Durable cancelled settlement is gated on verified exact Worker absence
    // and a durable closure checkpoint. A queued pristine Attempt needs no Worker facts.
    if (current.execution?.cancellation?.state !== "terminated")
      throw new Error(
        `Attempt ${key.attemptId} active cancelled settlement requires a terminated cancellation checkpoint.`,
      );
    if (current.cleanup?.workerClosed !== true)
      throw new Error(
        `Attempt ${key.attemptId} active cancelled settlement requires durable Worker closure.`,
      );
  }
  return mutate(workstream, updatedAt, (draft) => {
    const attempt = requireAttempt(draft, key).attempt;
    attempt.state = "finished";
    attempt.outcome = expected;
    attempt.updatedAt = updatedAt;
  });
}
export function recordDeliveryFailure(
  workstream: Workstream,
  key: AttemptKey,
  failure: Static<typeof DeliveryFailureSchema>,
  updatedAt: string,
): Workstream {
  assertObligation(workstream);
  const outcome = requireAttempt(workstream, key).attempt.outcome;
  if (outcome === undefined) throw new Error(`Attempt ${key.attemptId} has no Outcome delivery.`);
  if (outcome.delivery.state !== "pending")
    throw new Error(`Outcome ${outcome.id} is already delivered.`);
  return mutate(workstream, updatedAt, (draft) => {
    const next = requireAttempt(draft, key).attempt.outcome;
    if (next === undefined || next.delivery.state !== "pending")
      throw new Error("Outcome delivery changed.");
    next.delivery.attemptCount += 1;
    next.delivery.failureHistory.push(clone(failure));
    requireAttempt(draft, key).attempt.updatedAt = updatedAt;
  });
}
export function recordDeliverySuccess(
  workstream: Workstream,
  key: AttemptKey,
  deliveredAt: string,
  updatedAt: string,
): Workstream {
  assertObligation(workstream);
  const outcome = requireAttempt(workstream, key).attempt.outcome;
  if (outcome === undefined) throw new Error(`Attempt ${key.attemptId} has no Outcome delivery.`);
  if (outcome.delivery.state === "delivered") {
    if (outcome.delivery.deliveredAt === deliveredAt) return workstream;
    throw new Error(`Outcome ${outcome.id} has a conflicting delivery acceptance.`);
  }
  return mutate(workstream, updatedAt, (draft) => {
    const attempt = requireAttempt(draft, key).attempt;
    const next = attempt.outcome;
    if (next === undefined || next.delivery.state !== "pending")
      throw new Error("Outcome delivery changed.");
    next.delivery = {
      ...next.delivery,
      state: "delivered",
      attemptCount: next.delivery.attemptCount + 1,
      deliveredAt,
    };
    attempt.updatedAt = updatedAt;
  });
}

export type OutputDisposition =
  | { kind: "not_applicable" }
  | { kind: "maintained_output"; checkout: "preserved_or_uncertain" | "removed"; commit?: string }
  | { kind: "preserve_checkout"; reason: string }
  | { kind: "applied" | "discarded" }
  | { kind: "remove_checkout_and_branch"; checkout: "preserved_or_uncertain" | "removed" };
export function outputDisposition(task: Pick<Task, "kind">, attempt: Attempt): OutputDisposition {
  if (attempt.outputDisposition?.state === "completed")
    return { kind: attempt.outputDisposition.kind };
  return outputStateBeforeDisposition(task, attempt);
}
function outputDispositionEligible(task: Pick<Task, "kind">, attempt: Attempt): boolean {
  return ["preserve_checkout", "maintained_output"].includes(
    outputStateBeforeDisposition(task, attempt).kind,
  );
}
function outputStateBeforeDisposition(
  task: Pick<Task, "kind">,
  attempt: Attempt,
): OutputDisposition {
  if (attempt.execution?.placement?.kind !== "isolated_worktree") return { kind: "not_applicable" };
  if (attempt.execution.launch?.phase !== "ready")
    return { kind: "preserve_checkout", reason: "Worker launch is only partially checkpointed." };
  if (attempt.cleanup?.state === "blocked")
    return { kind: "preserve_checkout", reason: attempt.cleanup.error ?? "Cleanup is blocked." };
  const outcome = attempt.outcome;
  if (outcome?.kind !== "reported" || outcome.report.status !== "completed")
    return {
      kind: "preserve_checkout",
      reason: "Output is cancelled, failed, malformed, or uncertain.",
    };
  const checkout = attempt.cleanup?.state === "completed" ? "removed" : "preserved_or_uncertain";
  if (task.kind === "experiment" && attempt.cleanup?.expectedHead !== attempt.baseRevision)
    return { kind: "maintained_output", checkout };
  const commit = changedImplementationCommit(attempt);
  if (task.kind === "implementation" && commit !== undefined)
    return { kind: "maintained_output", checkout, commit };
  return { kind: "remove_checkout_and_branch", checkout };
}
export function isOperationallyStable(task: Task, attempt: Attempt): boolean {
  if (attempt.state !== "finished" || attempt.outcome?.delivery.state !== "delivered") return false;
  if (attempt.execution?.placement === undefined) return true;
  const cleanup = attempt.cleanup;
  if (cleanup?.state !== "completed" || cleanup.workerClosed !== true) return false;
  if (attempt.execution.placement.kind === "shared_project") return true;
  const disposition = outputStateBeforeDisposition(task, attempt);
  if (attempt.outputDisposition?.state === "completed")
    return (
      cleanup.expectedHead !== undefined &&
      cleanup.expectedHead === attempt.outputDisposition.expectedHead
    );
  return (
    (disposition.kind === "maintained_output" ||
      disposition.kind === "remove_checkout_and_branch") &&
    disposition.checkout === "removed"
  );
}
function isReattemptStable(task: Task, attempt: Attempt): boolean {
  if (!isOperationallyStable(task, attempt)) return false;
  return attempt.application?.state !== "pending" && attempt.application?.state !== "blocked";
}
export function deriveCompletionAccounting(workstream: Workstream): CompletionAccounting[] {
  return workstream.tasks.flatMap((task) =>
    task.attempts.flatMap((attempt) => accountingForAttempt(workstream, task, attempt)),
  );
}
function accountingForAttempt(
  workstream: Workstream,
  task: Task,
  attempt: Attempt,
): CompletionAccounting[] {
  if (attempt.state !== "finished")
    return [
      {
        kind: "unresolved_attempt",
        taskId: task.id,
        attemptId: attempt.id,
        reason: "Attempt has not finished.",
      },
    ];
  const accounting: CompletionAccounting[] = [];
  if (
    !isOperationallyStable(task, attempt) ||
    attempt.application?.state === "pending" ||
    attempt.application?.state === "blocked"
  )
    accounting.push({
      kind: "unresolved_attempt",
      taskId: task.id,
      attemptId: attempt.id,
      reason:
        attempt.outputDisposition?.kind === "applied"
          ? "Applied candidate cleanup is incomplete."
          : attempt.outputDisposition?.kind === "discarded"
            ? "Irreversible output discard is incomplete."
            : "Attempt execution or owned output is not resolved.",
    });
  if (attempt.outcome !== undefined && !outcomeResolved(workstream, task, attempt))
    accounting.push({
      kind: "unresolved_outcome",
      outcomeId: attempt.outcome.id,
      reason: outcomeAccountingReason(workstream, task, attempt),
    });
  if (attempt.outcome?.delivery.state === "pending")
    accounting.push({
      kind: "undelivered_outcome",
      outcomeId: attempt.outcome.id,
      reason: "Outcome delivery is pending.",
    });
  return accounting;
}
function outcomeResolved(workstream: Workstream, task: Task, attempt: Attempt): boolean {
  const outcome = attempt.outcome;
  if (outcome === undefined) return false;
  if (outcome.kind !== "reported") return true;
  if (outcome.report.status !== "completed") return true;
  if (task.kind !== "implementation") return true;
  if (outcome.report.kind !== "implementation") return false;
  if (outcome.report.outcome === "no_change") return true;
  return (
    attempt.application?.state === "applied" ||
    attempt.outputDisposition?.state === "completed" ||
    includedByAppliedDescendant(workstream, attempt.id)
  );
}
function outcomeAccountingReason(workstream: Workstream, task: Task, attempt: Attempt): string {
  const outcome = attempt.outcome;
  if (outcome === undefined) return "Attempt has no terminal Outcome.";
  if (outcome.kind !== "reported") return `Attempt Outcome is ${outcome.kind}.`;
  if (outcome.report.status !== "completed")
    return `Worker Report status is ${outcome.report.status}.`;
  if (
    task.kind === "implementation" &&
    outcome.report.kind === "implementation" &&
    outcome.report.outcome === "changed" &&
    !outcomeResolved(workstream, task, attempt)
  )
    return "Maintained candidate is not applied, included, or explicitly discarded.";
  return "Outcome does not satisfy the Task contract.";
}
function includedByAppliedDescendant(workstream: Workstream, attemptId: string): boolean {
  const target = findAttemptLocation(workstream, attemptId)?.attempt;
  const commit = target === undefined ? undefined : changedImplementationCommit(target);
  if (commit === undefined) return false;
  return workstream.tasks.some((task) =>
    task.attempts.some(
      (candidate) =>
        candidate.application?.state === "applied" &&
        candidate.application.commits.includes(commit),
    ),
  );
}
export function completeWorkstream(
  workstream: Workstream,
  input: Omit<Completion, "accounting">,
  updatedAt: string,
): Workstream {
  assertActive(workstream, "complete Workstream");
  if (
    workstream.tasks.some((task) => task.attempts.some((attempt) => attempt.state !== "finished"))
  )
    throw new Error("Cannot complete Workstream while an Attempt is not terminal.");
  const accounting = deriveCompletionAccounting(workstream);
  return mutate(workstream, updatedAt, (draft) => {
    draft.lifecycle = "completed";
    draft.completion = { ...clone(input), accounting };
  });
}
function outcomeFromObservation(attemptId: string, observation: TerminalObservation): Outcome {
  const common = {
    id: outcomeIdForAttempt(attemptId),
    observedAt: observation.observedAt,
    artifacts: clone(observation.artifacts),
    delivery: {
      state: "pending" as const,
      requestedAt: observation.deliveryRequestedAt,
      attemptCount: 0,
      failureHistory: [],
    },
  };
  if (observation.kind === "reported")
    return { ...common, kind: "reported", report: clone(observation.report) };
  if (observation.kind === "cancelled")
    return { ...common, kind: "cancelled", reason: observation.reason };
  const unreported: Extract<Outcome, { kind: "unreported" }> = {
    ...common,
    kind: "unreported",
    reason: observation.reason,
  };
  if (observation.rawWorkerText !== undefined) unreported.rawWorkerText = observation.rawWorkerText;
  return unreported;
}
function sameTerminalSubstance(left: Outcome, right: Outcome): boolean {
  if (
    left.kind !== right.kind ||
    left.id !== right.id ||
    left.observedAt !== right.observedAt ||
    !sameValue(left.artifacts, right.artifacts)
  )
    return false;
  if (left.kind === "reported" && right.kind === "reported")
    return sameValue(left.report, right.report);
  if (left.kind === "unreported" && right.kind === "unreported")
    return left.reason === right.reason && left.rawWorkerText === right.rawWorkerText;
  return left.kind === "cancelled" && right.kind === "cancelled" && left.reason === right.reason;
}
export function changedImplementationCommit(attempt: Attempt): string | undefined {
  const outcome = attempt.outcome;
  return outcome?.kind === "reported" &&
    outcome.report.kind === "implementation" &&
    outcome.report.status === "completed" &&
    outcome.report.outcome === "changed"
    ? outcome.report.commit
    : undefined;
}
function refreshCompletion(workstream: Workstream): void {
  if (workstream.completion !== undefined)
    workstream.completion.accounting = deriveCompletionAccounting(workstream);
}
function mutate(
  workstream: Workstream,
  updatedAt: string,
  operation: (draft: Workstream) => void,
): Workstream {
  const draft = clone(workstream);
  operation(draft);
  refreshCompletion(draft);
  draft.revision += 1;
  draft.updatedAt = updatedAt;
  return draft;
}
function assertActive(workstream: Workstream, operation: string): void {
  if (workstream.lifecycle !== "active")
    throw new Error(
      `Cannot ${operation} unless the Workstream is active; completed Workstreams are terminal.`,
    );
}
function assertNotCompleted(workstream: Workstream, operation: string): void {
  if (workstream.lifecycle === "completed")
    throw new Error(`Cannot ${operation} on a completed Workstream.`);
}
function assertObligation(workstream: Workstream): void {
  if (workstream.lifecycle === "completed" && workstream.completion === undefined)
    throw new Error("Completed Workstream has no completion record.");
}
function assertCompletedObligation(
  workstream: Workstream,
  key: AttemptKey,
  kind: "application" | "cleanup" | "disposition",
): void {
  const located = requireAttempt(workstream, key);
  const attempt = located.attempt;
  if (kind === "cleanup" && attempt.execution?.placement !== undefined) return;
  if (kind === "application") {
    const task = located.task;
    if (
      task.kind === "implementation" &&
      changedImplementationCommit(attempt) !== undefined &&
      !outcomeResolved(workstream, task, attempt)
    )
      return;
  }
  if (
    kind === "disposition" &&
    attempt.execution?.placement?.kind === "isolated_worktree" &&
    attempt.cleanup?.workerClosed === true &&
    ["blocked", "completed"].includes(attempt.cleanup.state) &&
    attempt.cleanup.expectedHead !== undefined &&
    ["preserve_checkout", "maintained_output"].includes(
      outputStateBeforeDisposition(located.task, attempt).kind,
    )
  )
    return;
  throw new Error(`Attempt ${key.attemptId} has no existing ${kind} obligation after completion.`);
}
function unique(values: readonly string[], label: string): Set<string> {
  const result = new Set(values);
  if (result.size !== values.length) throw new Error(`Duplicate ${label} id.`);
  return result;
}
function clone<Value>(value: Value): Value {
  return structuredClone(value);
}
function sameValue<Value>(left: Value, right: Value): boolean {
  return Value.Equal(left, right);
}
