import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { ModelTargetSchema } from "./model-target.js";

const CANONICAL_WORKSTREAM_FORMAT = "pi-workgraph-workstream" as const;
const CANONICAL_WORKSTREAM_SCHEMA = "coordination-domain" as const;
const CANONICAL_WORKSTREAM_SCHEMA_VERSION = 1 as const;

const NonEmptyString = Type.String({ minLength: 1 });
const Timestamp = Type.String({ minLength: 1 });
const Commit = Type.String({ pattern: "^[0-9a-f]{40,64}$" });
const stringLiterals = <const Values extends readonly string[]>(values: Values) =>
  Type.Unsafe<Values[number]>({ type: "string", enum: [...values] });

const EvidenceSchema = Type.Object(
  {
    label: Type.String(),
    observation: Type.String(),
    class: Type.Optional(stringLiterals(["direct", "inference", "conflict", "unknown"] as const)),
    command: Type.Optional(Type.String()),
    artifact: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const FindingSchema = Type.Object(
  {
    severity: stringLiterals(["info", "warning", "error", "blocker"] as const),
    title: Type.String(),
    detail: Type.String(),
  },
  { additionalProperties: false },
);
const ReportContent = {
  summary: Type.String(),
  uncertainty: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
  evidence: Type.Array(EvidenceSchema, { maxItems: 20 }),
  findings: Type.Array(FindingSchema, { maxItems: 20 }),
};
const ResearchReportSchema = Type.Object(
  {
    kind: Type.Literal("research"),
    status: stringLiterals(["completed", "escalated", "failed"] as const),
    ...ReportContent,
  },
  { additionalProperties: false },
);
const ReviewReportSchema = Type.Object(
  {
    kind: Type.Literal("review"),
    status: stringLiterals(["completed", "escalated", "failed"] as const),
    ...ReportContent,
  },
  { additionalProperties: false },
);
const ImplementationReportSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("implementation"),
      status: Type.Literal("completed"),
      outcome: Type.Literal("changed"),
      ...ReportContent,
      commit: Commit,
      changedFiles: Type.Optional(Type.Array(Type.String())),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("implementation"),
      status: Type.Literal("completed"),
      outcome: Type.Literal("no_change"),
      ...ReportContent,
      revision: Commit,
      reason: NonEmptyString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("implementation"),
      status: stringLiterals(["escalated", "failed"] as const),
      ...ReportContent,
    },
    { additionalProperties: false },
  ),
]);
const WorkerReportInputSchema = Type.Union([
  ResearchReportSchema,
  ReviewReportSchema,
  ImplementationReportSchema,
]);

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

const ReviewSubjectSchema = Type.Union([
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
    source: Type.Optional(stringLiterals(["selection", "message"] as const)),
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
const WorkerIdentitySchema = Type.Object(
  {
    workspaceId: NonEmptyString,
    tabId: NonEmptyString,
    paneId: NonEmptyString,
    terminalId: NonEmptyString,
    agentName: NonEmptyString,
    cwd: NonEmptyString,
    sessionFile: NonEmptyString,
  },
  { additionalProperties: false },
);
const SteeringObservationSchema = Type.Object(
  {
    text: NonEmptyString,
    state: stringLiterals(["uncertain", "submitted"] as const),
    observedAt: Timestamp,
  },
  { additionalProperties: false },
);
const CancellationObservationSchema = Type.Object(
  { requestedAt: Timestamp, reason: NonEmptyString },
  { additionalProperties: false },
);
export const WorkerExecutionSchema = Type.Object(
  {
    placement: Type.Optional(PlacementSchema),
    worker: Type.Optional(WorkerIdentitySchema),
    submission: Type.Optional(
      stringLiterals(["not_sent", "uncertain", "submitted", "started"] as const),
    ),
    steering: Type.Optional(SteeringObservationSchema),
    cancellation: Type.Optional(CancellationObservationSchema),
  },
  { additionalProperties: false },
);
export const ApplicationSchema = Type.Object(
  {
    state: stringLiterals(["pending", "applied", "blocked"] as const),
    commit: Commit,
    expectedRef: Type.Optional(NonEmptyString),
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
const OutputReleaseSchema = Type.Object(
  {
    state: stringLiterals(["pending", "blocked", "completed"] as const),
    expectedHead: Commit,
    reason: NonEmptyString,
    error: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);
const AttentionSchema = Type.Object(
  { detail: NonEmptyString, at: Timestamp },
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
const OutcomeSchema = Type.Union([
  Type.Object(
    { ...OutcomeBase, kind: Type.Literal("reported"), report: WorkerReportInputSchema },
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
    outputRelease: Type.Optional(OutputReleaseSchema),
    attentionHistory: Type.Optional(Type.Array(AttentionSchema)),
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
const StrictEvidenceSchema = EvidenceSchema;
const CompletionAccountingSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("unresolved_task"), taskId: NonEmptyString, reason: NonEmptyString },
    { additionalProperties: false },
  ),
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
    evidence: Type.Array(StrictEvidenceSchema, { minItems: 1 }),
    limitations: Type.Array(NonEmptyString),
    accounting: Type.Array(CompletionAccountingSchema),
    completedAt: Timestamp,
  },
  { additionalProperties: false },
);
export const WorkstreamSchema = Type.Object(
  {
    format: Type.Literal(CANONICAL_WORKSTREAM_FORMAT),
    schema: Type.Literal(CANONICAL_WORKSTREAM_SCHEMA),
    schemaVersion: Type.Literal(CANONICAL_WORKSTREAM_SCHEMA_VERSION),
    revision: Type.Integer({ minimum: 0 }),
    id: NonEmptyString,
    purpose: NonEmptyString,
    repository: RepositoryIdentitySchema,
    coordinator: CoordinatorIdentitySchema,
    lifecycle: stringLiterals(["active", "completed"] as const),
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
export type HumanInputReceipt = Static<typeof HumanInputReceiptSchema>;
export type HandoffGrant = Static<typeof HandoffGrantSchema>;
export type Intent = Static<typeof IntentSchema>;
export type CandidateLineage = Static<typeof CandidateLineageSchema>;
export type ModelSelection = Static<typeof SelectionSchema>;
export type WorkerExecution = Static<typeof WorkerExecutionSchema>;
export type RetainedArtifact = Static<typeof RetainedArtifactSchema>;
export type Delivery = Static<typeof DeliverySchema>;
export type Outcome = Static<typeof OutcomeSchema>;
export type Attempt = Static<typeof AttemptSchema>;
export type Task = Static<typeof TaskSchema>;
export type CompletionAccounting = Static<typeof CompletionAccountingSchema>;
export type Completion = Static<typeof CompletionSchema>;
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
      `Invalid canonical Workstream at ${issue?.instancePath === undefined || issue.instancePath === "" ? "/" : issue.instancePath}: ${issue?.message ?? "schema mismatch"}.`,
    );
  }
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
  if (
    new Set([
      value.id,
      ...value.tasks.map((task) => task.id),
      ...attempts.map((attempt) => attempt.id),
    ]).size !==
    1 + value.tasks.length + attempts.length
  )
    throw new Error("Workstream, Task, and Attempt ids must be distinct.");
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
  if ((attempt.state === "finished") !== (attempt.outcome !== undefined))
    throw new Error(`Attempt ${attempt.id} must embed exactly one Outcome iff finished.`);
  if (attempt.outcome !== undefined) {
    if (attempt.outcome.id !== outcomeIdForAttempt(attempt.id))
      throw new Error(`Attempt ${attempt.id} has a non-deterministic Outcome id.`);
    unique(
      attempt.outcome.artifacts.map((artifact) => artifact.id),
      `artifact in Outcome ${attempt.outcome.id}`,
    );
    if (attempt.outcome.delivery.attemptCount < attempt.outcome.delivery.failureHistory.length)
      throw new Error(`Outcome ${attempt.outcome.id} delivery history exceeds its attempt count.`);
    if (
      attempt.outcome.kind === "reported" &&
      attempt.outcome.report.kind !== expectedReportKind(task)
    )
      throw new Error(`Attempt ${attempt.id} Report kind does not match Task kind ${task.kind}.`);
  }
  if (attempt.state === "queued" && hasOperationalFacts(attempt))
    throw new Error(`Queued Attempt ${attempt.id} contains execution or terminal facts.`);
  if (
    attempt.state !== "finished" &&
    (attempt.application !== undefined || attempt.outputRelease !== undefined)
  )
    throw new Error(`Unfinished Attempt ${attempt.id} contains output settlement facts.`);
  validateExecution(attempt);
  validateSelection(task, attempt);
  validateCandidate(workstream, task, attempt);
  validateApplication(task, attempt);
  validateCleanup(attempt);
  validateOutputRelease(attempt);
}
function hasOperationalFacts(attempt: Attempt): boolean {
  return (
    attempt.execution !== undefined ||
    attempt.effectiveModels !== undefined ||
    attempt.application !== undefined ||
    attempt.cleanup !== undefined ||
    attempt.outputRelease !== undefined ||
    attempt.attentionHistory !== undefined ||
    attempt.outcome !== undefined
  );
}
function validateExecution(attempt: Attempt): void {
  const execution = attempt.execution;
  if (execution === undefined) return;
  if (
    execution.worker !== undefined &&
    execution.placement !== undefined &&
    execution.worker.cwd !== execution.placement.path
  )
    throw new Error(`Attempt ${attempt.id} Worker identity does not match its placement.`);
  if (execution.submission !== undefined && execution.placement === undefined)
    throw new Error(`Attempt ${attempt.id} has submission state without placement.`);
  if (
    execution.submission !== undefined &&
    execution.submission !== "not_sent" &&
    execution.worker?.sessionFile === undefined
  )
    throw new Error(`Attempt ${attempt.id} sent submission has no exact Worker session.`);
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
  if (parent.candidate === undefined || parent.baseRevision === undefined)
    throw new Error(`Attempt ${attempt.id} candidate parent lineage is incomplete.`);
  if (parent.candidate.rootCommit !== candidate.rootCommit || !validCandidateBase(parent))
    throw new Error(`Attempt ${attempt.id} candidate parent lineage is not exact.`);
  if (candidate.kind === "correction" && attempt.baseRevision !== candidate.parentCommit)
    throw new Error(`Attempt ${attempt.id} correction does not continue its exact candidate.`);
  if (candidate.kind === "integration" && candidate.rootCommit !== attempt.baseRevision)
    throw new Error(`Attempt ${attempt.id} integration is not rooted at its destination base.`);
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
  if (task.kind !== "implementation" || attempt.execution?.placement?.kind !== "isolated_worktree")
    throw new Error(`Attempt ${attempt.id} application is outside isolated implementation work.`);
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
    application.commits[0] !== application.rootCommit ||
    application.commits.at(-1) !== application.commit
  )
    throw new Error(`Attempt ${attempt.id} application lineage is not exact.`);
  if ((application.state === "applied") !== (application.revision !== undefined))
    throw new Error(`Attempt ${attempt.id} application revision does not match applied state.`);
  if ((application.state === "blocked") !== (application.error !== undefined))
    throw new Error(`Attempt ${attempt.id} application blocker does not match its state.`);
}
function validateCleanup(attempt: Attempt): void {
  if (attempt.cleanup === undefined) return;
  if ((attempt.cleanup.state === "blocked") !== (attempt.cleanup.error !== undefined))
    throw new Error(`Attempt ${attempt.id} cleanup blocker does not match its state.`);
  if (attempt.cleanup.state === "completed" && !attempt.cleanup.workerClosed)
    throw new Error(`Attempt ${attempt.id} completed cleanup has no closed Worker.`);
}
function validateOutputRelease(attempt: Attempt): void {
  const release = attempt.outputRelease;
  if (release === undefined) return;
  if (
    attempt.execution?.placement?.kind !== "isolated_worktree" ||
    attempt.cleanup?.workerClosed !== true
  )
    throw new Error(`Attempt ${attempt.id} output release lacks closed isolated ownership.`);
  if (attempt.cleanup.expectedHead !== release.expectedHead)
    throw new Error(`Attempt ${attempt.id} output release checkpoint does not match cleanup.`);
  if ((release.state === "blocked") !== (release.error !== undefined))
    throw new Error(`Attempt ${attempt.id} output release blocker does not match its state.`);
}
function validateLifecycle(workstream: Workstream): void {
  if ((workstream.lifecycle === "completed") !== (workstream.completion !== undefined))
    throw new Error("Completed lifecycle and Completion must appear together.");
  if (workstream.completion === undefined) return;
  const expected = deriveCompletionAccounting(workstream);
  if (
    expected.length !== 0 ||
    workstream.completion.accounting.length !== 0 ||
    !sameValue(expected, workstream.completion.accounting)
  )
    throw new Error("Completion accounting must be the exact empty derived set.");
}

export function findTask(workstream: Workstream, taskId: string): Task | undefined {
  return workstream.tasks.find((task) => task.id === taskId);
}
export function findAttempt(task: Task, attemptId: string): Attempt | undefined {
  return task.attempts.find((attempt) => attempt.id === attemptId);
}
type AttemptLocation = { task: Task; attempt: Attempt };
function findAttemptLocation(
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
    format: CANONICAL_WORKSTREAM_FORMAT,
    schema: CANONICAL_WORKSTREAM_SCHEMA,
    schemaVersion: CANONICAL_WORKSTREAM_SCHEMA_VERSION,
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
  return mutate(workstream, updatedAt, (draft) => draft.tasks.push(clone(task)));
}
export function appendAttempt(
  workstream: Workstream,
  taskId: string,
  attempt: Attempt,
  updatedAt: string,
): Workstream {
  assertActive(workstream, "append Attempt");
  const task = findTask(workstream, taskId);
  if (task === undefined) throw new Error(`Unknown Task ${taskId}.`);
  if (task.intentIndex !== workstream.intents.length - 1)
    throw new Error(`Task ${taskId} no longer belongs to the current Intent.`);
  if (!task.attempts.every(isReattemptStable))
    throw new Error(`Task ${taskId} has an unfinished or operationally unstable prior Attempt.`);
  if (attempt.state !== "queued" || hasOperationalFacts(attempt))
    throw new Error(`Appended Attempt ${attempt.id} must be pristine and queued.`);
  return mutate(workstream, updatedAt, (draft) =>
    findTask(draft, taskId)?.attempts.push(clone(attempt)),
  );
}
export function activateAttempt(
  workstream: Workstream,
  key: AttemptKey,
  updatedAt: string,
  execution?: WorkerExecution,
): Workstream {
  assertActive(workstream, "activate Attempt");
  const located = requireAttempt(workstream, key);
  if (located.task.intentIndex !== workstream.intents.length - 1)
    throw new Error(`Attempt ${key.attemptId} no longer belongs to the current Intent.`);
  if (located.attempt.state !== "queued")
    throw new Error(`Attempt ${key.attemptId} is not queued.`);
  return mutate(workstream, updatedAt, (draft) => {
    const attempt = requireAttempt(draft, key).attempt;
    attempt.state = "active";
    attempt.updatedAt = updatedAt;
    if (execution !== undefined) attempt.execution = clone(execution);
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
  assertActive(workstream, "record effective model");
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
  assertActive(workstream, "record Worker execution");
  const current = requireAttempt(workstream, key).attempt;
  if (current.state === "queued")
    throw new Error(`Attempt ${key.attemptId} is not active or finished.`);
  if (current.execution !== undefined && !sameValue(current.execution, execution))
    throw new Error(`Attempt ${key.attemptId} Worker execution identity is immutable.`);
  return mutate(workstream, updatedAt, (draft) => {
    const attempt = requireAttempt(draft, key).attempt;
    if (attempt.execution === undefined) attempt.execution = clone(execution);
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
export function checkpointOutputRelease(
  workstream: Workstream,
  key: AttemptKey,
  release: Static<typeof OutputReleaseSchema>,
  updatedAt: string,
): Workstream {
  const current = requireAttempt(workstream, key).attempt;
  if (current.outputRelease !== undefined && !monotonicRelease(current.outputRelease, release))
    throw new Error(
      `Attempt ${key.attemptId} output release transition is not monotonic or rewrites identity.`,
    );
  return mutate(workstream, updatedAt, (draft) => {
    requireAttempt(draft, key).attempt.outputRelease = clone(release);
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
  if (old.expectedHead !== next.expectedHead || (old.workerClosed && !next.workerClosed))
    return false;
  if (old.state === "completed") return false;
  if (old.state === "blocked")
    return next.state === "completed" && next.error === undefined && next.workerClosed;
  if (next.state === "pending") return old.error === undefined;
  if (next.state === "blocked") return next.error !== undefined;
  return next.state === "completed" && next.error === undefined && next.workerClosed;
}
function monotonicRelease(old: Attempt["outputRelease"], next: Attempt["outputRelease"]): boolean {
  if (old === undefined || next === undefined) return false;
  if (sameValue(old, next)) return true;
  if (old.expectedHead !== next.expectedHead || old.reason !== next.reason) return false;
  if (old.state === "completed") return false;
  if (old.state === "blocked") return next.state === "completed" && next.error === undefined;
  if (next.state === "pending") return next.error === undefined;
  if (next.state === "blocked") return next.error !== undefined;
  return next.state === "completed" && next.error === undefined;
}
export function requestCancellation(
  workstream: Workstream,
  key: AttemptKey,
  cancellation: Static<typeof CancellationObservationSchema>,
  updatedAt: string,
): Workstream {
  assertActive(workstream, "request cancellation");
  const attempt = requireAttempt(workstream, key).attempt;
  if (attempt.state !== "active") throw new Error(`Attempt ${key.attemptId} is not active.`);
  const execution = attempt.execution;
  if (execution?.cancellation !== undefined) {
    if (sameValue(execution.cancellation, cancellation)) return workstream;
    throw new Error(`Attempt ${key.attemptId} has a conflicting cancellation request.`);
  }
  return mutate(workstream, updatedAt, (draft) => {
    const next = requireAttempt(draft, key).attempt;
    next.execution = { ...next.execution, cancellation: clone(cancellation) };
    next.updatedAt = updatedAt;
  });
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
  assertActive(workstream, "terminalize Attempt");
  if (current.state !== "active" && current.state !== "queued")
    throw new Error(`Attempt ${key.attemptId} cannot be terminalized from ${current.state}.`);
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
  | { kind: "retain_branch"; checkout: "preserved_or_uncertain" | "removed"; commit?: string }
  | { kind: "preserve_checkout"; reason: string }
  | { kind: "released" }
  | { kind: "remove_checkout_and_branch"; checkout: "preserved_or_uncertain" | "removed" };
export function outputDisposition(task: Task, attempt: Attempt): OutputDisposition {
  if (attempt.outputRelease?.state === "completed") return { kind: "released" };
  if (attempt.execution?.placement?.kind !== "isolated_worktree") return { kind: "not_applicable" };
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
    return { kind: "retain_branch", checkout };
  const commit = changedImplementationCommit(attempt);
  if (task.kind === "implementation" && commit !== undefined)
    return { kind: "retain_branch", checkout, commit };
  return { kind: "remove_checkout_and_branch", checkout };
}
function isReattemptStable(attempt: Attempt): boolean {
  if (attempt.state !== "finished") return false;
  if (attempt.application?.state === "pending" || attempt.application?.state === "blocked")
    return false;
  if (attempt.outputRelease?.state === "pending" || attempt.outputRelease?.state === "blocked")
    return false;
  if (attempt.outputRelease?.state === "completed") return true;
  return (
    attempt.execution === undefined ||
    (attempt.cleanup?.state === "completed" && attempt.cleanup.workerClosed)
  );
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
  if (!isReattemptStable(attempt))
    accounting.push({
      kind: "unresolved_attempt",
      taskId: task.id,
      attemptId: attempt.id,
      reason: "Attempt execution or owned output is not operationally stable.",
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
    attempt.outputRelease?.state === "completed" ||
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
    return "Maintained candidate is not applied, included, or explicitly released.";
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
  const accounting = deriveCompletionAccounting(workstream);
  if (accounting.length !== 0)
    throw new Error("Cannot complete Workstream while derived obligations remain.");
  return mutate(workstream, updatedAt, (draft) => {
    draft.lifecycle = "completed";
    draft.completion = { ...clone(input), accounting: [] };
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
function changedImplementationCommit(attempt: Attempt): string | undefined {
  const outcome = attempt.outcome;
  return outcome?.kind === "reported" &&
    outcome.report.kind === "implementation" &&
    outcome.report.status === "completed" &&
    outcome.report.outcome === "changed"
    ? outcome.report.commit
    : undefined;
}
function refreshCompletion(workstream: Workstream): void {
  if (workstream.completion !== undefined) {
    const accounting = deriveCompletionAccounting(workstream);
    if (accounting.length !== 0)
      throw new Error("Completed Workstream cannot acquire a pending obligation.");
    workstream.completion.accounting = [];
  }
}
function mutate(
  workstream: Workstream,
  updatedAt: string,
  operation: (draft: Workstream) => void,
): Workstream {
  const draft = clone(workstream);
  operation(draft);
  draft.revision += 1;
  draft.updatedAt = updatedAt;
  validateWorkstream(draft);
  return draft;
}
function assertActive(workstream: Workstream, operation: string): void {
  if (workstream.lifecycle !== "active")
    throw new Error(`Cannot ${operation} on a completed Workstream.`);
}
function assertObligation(workstream: Workstream): void {
  if (workstream.lifecycle === "completed" && workstream.completion === undefined)
    throw new Error("Completed Workstream has no completion record.");
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
