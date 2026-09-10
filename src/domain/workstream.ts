import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { ModelTargetSchema } from "../model-policy.js";
import { WorkerReportInputSchema } from "../report-schema.js";

export const CANONICAL_WORKSTREAM_FORMAT = "pi-workgraph-workstream" as const;
export const CANONICAL_WORKSTREAM_SCHEMA = "coordination-domain" as const;
export const CANONICAL_WORKSTREAM_SCHEMA_VERSION = 1 as const;

const NonEmptyString = Type.String({ minLength: 1 });
const Timestamp = Type.String({ minLength: 1 });
const Commit = Type.String({ pattern: "^[0-9a-f]{40,64}$" });
const DurableId = Type.String({ pattern: "^[a-z][a-z0-9_-]{0,127}$" });
const stringLiterals = StringEnum;

export const RepositoryIdentitySchema = Type.Object(
  { projectRoot: NonEmptyString, gitCommonDir: NonEmptyString },
  { additionalProperties: false },
);
export const CoordinatorIdentitySchema = Type.Object(
  { sessionId: NonEmptyString, sessionFile: NonEmptyString },
  { additionalProperties: false },
);
export const HumanInputReceiptSchema = Type.Object(
  {
    kind: Type.Literal("human_input_receipt"),
    id: DurableId,
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
    id: DurableId,
    parentReceipt: HumanInputReceiptSchema,
    parentWorkstreamId: DurableId,
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
export const IntentGroundingSchema = Type.Union([HumanInputReceiptSchema, HandoffGrantSchema]);
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
    { kind: Type.Literal("artifact"), outcomeId: NonEmptyString, artifactId: DurableId },
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
      parentAttemptId: DurableId,
      parentCommit: Commit,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("integration"),
      rootCommit: Commit,
      parentAttemptId: DurableId,
      parentCommit: Commit,
    },
    { additionalProperties: false },
  ),
]);

const SelectionSourceSchema = stringLiterals(["policy", "requested-model"] as const);
export const SelectedModelsSchema = Type.Union([
  Type.Object(
    {
      role: stringLiterals(["research", "review"] as const),
      count: Type.Integer({ minimum: 1, maximum: 32 }),
      distinctModels: Type.Boolean(),
      selected: Type.Array(ModelTargetSchema, { minItems: 1, maxItems: 32 }),
      source: SelectionSourceSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      role: Type.Literal("consultation"),
      selected: Type.Array(ModelTargetSchema, { minItems: 1, maxItems: 1 }),
      source: SelectionSourceSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      role: Type.Literal("implementation"),
      guide: ModelTargetSchema,
      executor: ModelTargetSchema,
      source: Type.Literal("policy"),
    },
    { additionalProperties: false },
  ),
]);
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
const LaunchPaneSchema = Type.Object(
  { workspaceId: NonEmptyString, paneId: NonEmptyString },
  { additionalProperties: false },
);
const ResourceSchema = Type.Object(
  {
    workspaceId: NonEmptyString,
    tabId: NonEmptyString,
    paneId: NonEmptyString,
    terminalId: NonEmptyString,
    agentName: NonEmptyString,
    cwd: NonEmptyString,
  },
  { additionalProperties: false },
);
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
    launchPane: Type.Optional(LaunchPaneSchema),
    resource: Type.Optional(ResourceSchema),
    sessionFile: Type.Optional(NonEmptyString),
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
    rootCommit: Type.Optional(Commit),
    commits: Type.Optional(Type.Array(Commit, { minItems: 1 })),
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
export const OutputReleaseSchema = Type.Object(
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

export const RetainedArtifactSchema = Type.Object(
  {
    id: DurableId,
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
export const DeliverySchema = Type.Union([
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
    id: DurableId,
    state: stringLiterals(["queued", "active", "finished"] as const),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    continuationOf: Type.Optional(DurableId),
    candidate: Type.Optional(CandidateLineageSchema),
    selectedModels: Type.Optional(SelectedModelsSchema),
    effectiveModels: Type.Optional(Type.Array(EffectiveModelSchema, { minItems: 1 })),
    execution: Type.Optional(WorkerExecutionSchema),
    baseRevision: Type.Optional(Commit),
    application: Type.Optional(ApplicationSchema),
    cleanup: Type.Optional(CleanupSchema),
    outputRelease: Type.Optional(OutputReleaseSchema),
    attentionHistory: Type.Optional(Type.Array(AttentionSchema)),
    outcome: Type.Optional(OutcomeSchema),
  },
  { additionalProperties: false },
);
const TaskBase = {
  id: DurableId,
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

const StrictEvidenceSchema = Type.Object(
  {
    label: Type.String(),
    observation: Type.String(),
    class: Type.Optional(stringLiterals(["direct", "inference", "conflict", "unknown"] as const)),
    command: Type.Optional(Type.String()),
    artifact: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export const CompletionAccountingSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("unresolved_task"), taskId: DurableId, reason: NonEmptyString },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("unresolved_attempt"),
      taskId: DurableId,
      attemptId: DurableId,
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
export const CompletionSchema = Type.Object(
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
    id: DurableId,
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
export type HumanInputReceipt = Static<typeof HumanInputReceiptSchema>;
export type HandoffGrant = Static<typeof HandoffGrantSchema>;
export type Intent = Static<typeof IntentSchema>;
export type CandidateLineage = Static<typeof CandidateLineageSchema>;
export type SelectedModels = Static<typeof SelectedModelsSchema>;
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

export function outcomeIdForAttempt(attemptId: string): string {
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
  const taskIds = unique(
    value.tasks.map((task) => task.id),
    "Task",
  );
  const attempts = value.tasks.flatMap((task) => task.attempts);
  unique(
    attempts.map((attempt) => attempt.id),
    "Attempt",
  );
  const outcomeIds = attempts.flatMap((attempt) => (attempt.outcome ? [attempt.outcome.id] : []));
  unique(outcomeIds, "Outcome");
  for (const task of value.tasks) {
    if (task.intentIndex >= value.intents.length)
      throw new Error(`Task ${task.id} references unknown Intent index ${task.intentIndex}.`);
    validateTask(value, task);
  }
  if (taskIds.has(value.id)) throw new Error("Workstream and Task ids must be distinct.");
  validateLifecycle(value);
}

function validateGrounding(workstream: Workstream): void {
  for (const [index, intent] of workstream.intents.entries()) {
    const grounding = intent.grounding;
    if (grounding.kind === "human_input_receipt") {
      if (
        grounding.sessionId !== workstream.coordinator.sessionId ||
        grounding.sessionFile !== workstream.coordinator.sessionFile
      )
        throw new Error(`Intent ${index} direct receipt belongs to another coordinator session.`);
    } else if (!sameValue(grounding.targetRepository, workstream.repository)) {
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
  }
  if (attempt.state === "queued" && hasOperationalFacts(attempt))
    throw new Error(`Queued Attempt ${attempt.id} contains execution or terminal facts.`);
  if (
    attempt.state !== "finished" &&
    (attempt.application !== undefined || attempt.outputRelease !== undefined)
  )
    throw new Error(`Unfinished Attempt ${attempt.id} contains output settlement facts.`);
  validateExecution(attempt);
  validateCandidate(workstream, task, attempt);
  validateApplication(task, attempt);
  validateCleanup(attempt);
  validateOutputRelease(attempt);
  validateSelectedModels(task, attempt);
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
    (execution.resource !== undefined || execution.launchPane !== undefined) &&
    execution.placement === undefined
  )
    throw new Error(`Attempt ${attempt.id} has a native launch identity without placement.`);
  if (execution.worker !== undefined) {
    if (
      execution.sessionFile !== execution.worker.sessionFile ||
      execution.placement === undefined ||
      execution.worker.cwd !== execution.placement.path
    )
      throw new Error(`Attempt ${attempt.id} Worker identity does not match its launch.`);
  }
  if (execution.submission !== undefined && execution.placement === undefined)
    throw new Error(`Attempt ${attempt.id} has submission state without placement.`);
  if (
    execution.submission !== undefined &&
    execution.submission !== "not_sent" &&
    execution.sessionFile === undefined
  )
    throw new Error(`Attempt ${attempt.id} sent submission has no exact session.`);
}

function validateSelectedModels(task: Task, attempt: Attempt): void {
  const selection = attempt.selectedModels;
  if (selection === undefined) return;
  if (
    selection.role !== task.kind &&
    !(task.kind === "experiment" && selection.role === "research")
  )
    throw new Error(`Attempt ${attempt.id} model selection does not match Task kind ${task.kind}.`);
  if ("selected" in selection) {
    if ("count" in selection && selection.count !== selection.selected.length)
      throw new Error(`Attempt ${attempt.id} model selection count is not exact.`);
    if ("distinctModels" in selection && selection.distinctModels)
      unique(
        selection.selected.map((target) => target.model),
        `selected model in Attempt ${attempt.id}`,
      );
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
    if (candidate.rootCommit !== attempt.baseRevision)
      throw new Error(
        `Attempt ${attempt.id} initial candidate is not rooted at its base revision.`,
      );
    return;
  }
  const parentLocated = findAttemptLocation(workstream, candidate.parentAttemptId);
  if (parentLocated === undefined || parentLocated.task.kind !== "implementation")
    throw new Error(`Attempt ${attempt.id} candidate references an unknown implementation parent.`);
  if (parentLocated.task.intentIndex !== task.intentIndex)
    throw new Error(`Attempt ${attempt.id} candidate parent belongs to another Intent.`);
  const parent = parentLocated.attempt;
  const parentCommit = changedImplementationCommit(parent);
  if (parentCommit !== candidate.parentCommit)
    throw new Error(`Attempt ${attempt.id} candidate parent commit is not exact.`);
  if (candidate.kind === "correction") {
    if (
      attempt.baseRevision !== candidate.parentCommit ||
      candidate.rootCommit !== parent.candidate?.rootCommit
    )
      throw new Error(`Attempt ${attempt.id} correction does not continue its exact candidate.`);
  } else if (candidate.rootCommit !== attempt.baseRevision) {
    throw new Error(`Attempt ${attempt.id} integration is not rooted at its destination base.`);
  }
}

function validateApplication(task: Task, attempt: Attempt): void {
  const application = attempt.application;
  if (application === undefined) return;
  if (task.kind !== "implementation" || attempt.execution?.placement?.kind !== "isolated_worktree")
    throw new Error(`Attempt ${attempt.id} application is outside isolated implementation work.`);
  if ((application.rootCommit === undefined) !== (application.commits === undefined))
    throw new Error(`Attempt ${attempt.id} application lineage is incomplete.`);
  if (application.commits !== undefined && application.commits.at(-1) !== application.commit)
    throw new Error(
      `Attempt ${attempt.id} application history does not end at its candidate commit.`,
    );
  if ((application.state === "applied") !== (application.revision !== undefined))
    throw new Error(`Attempt ${attempt.id} application revision does not match applied state.`);
  if (
    application.expectedRef !== undefined &&
    !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(application.expectedRef)
  )
    throw new Error(`Attempt ${attempt.id} application destination is not an exact branch ref.`);
  if ((application.state === "blocked") !== (application.error !== undefined))
    throw new Error(`Attempt ${attempt.id} application blocker does not match its state.`);
}

function validateCleanup(attempt: Attempt): void {
  const cleanup = attempt.cleanup;
  if (cleanup === undefined) return;
  if ((cleanup.state === "blocked") !== (cleanup.error !== undefined))
    throw new Error(`Attempt ${attempt.id} cleanup blocker does not match its state.`);
  if (cleanup.state === "completed" && !cleanup.workerClosed)
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
  if (!workstream.tasks.flatMap((task) => task.attempts).every(isReattemptStable))
    throw new Error("Completed Workstream contains an operationally unstable Attempt.");
  const expected = deriveCompletionAccounting(workstream);
  if (!sameValue(expected, workstream.completion.accounting))
    throw new Error("Completion accounting does not exactly match derived accounting.");
}

export function findTask(workstream: Workstream, taskId: string): Task | undefined {
  return workstream.tasks.find((task) => task.id === taskId);
}

export function findAttempt(task: Task, attemptId: string): Attempt | undefined {
  return task.attempts.find((attempt) => attempt.id === attemptId);
}

type AttemptLocation = { task: Task; attempt: Attempt };

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

export function findOutcome(workstream: Workstream, outcomeId: string): Outcome | undefined {
  for (const task of workstream.tasks)
    for (const attempt of task.attempts)
      if (attempt.outcome?.id === outcomeId) return attempt.outcome;
  return undefined;
}

export function requireAttempt(workstream: Workstream, key: AttemptKey): AttemptLocation {
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
  coordinator: Static<typeof CoordinatorIdentitySchema>;
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
  return mutate(workstream, updatedAt, (draft) => {
    draft.intents.push(clone(intent));
  });
}

export function createTask(workstream: Workstream, task: Task, updatedAt: string): Workstream {
  assertActive(workstream, "create Task");
  if (task.intentIndex !== workstream.intents.length - 1)
    throw new Error(`Task ${task.id} must reference the current Intent.`);
  if (
    !task.attempts.every((attempt) => attempt.state === "queued" && !hasOperationalFacts(attempt))
  )
    throw new Error(`Task ${task.id} must begin with one or more pristine queued Attempts.`);
  return mutate(workstream, updatedAt, (draft) => {
    draft.tasks.push(clone(task));
  });
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
  return mutate(workstream, updatedAt, (draft) => {
    findTask(draft, taskId)?.attempts.push(clone(attempt));
  });
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

export type AttemptProgress = Readonly<{
  execution?: Partial<WorkerExecution>;
  selectedModels?: SelectedModels;
  effectiveModels?: Attempt["effectiveModels"];
  application?: Attempt["application"];
  cleanup?: Attempt["cleanup"];
  outputRelease?: Attempt["outputRelease"];
  attention?: Static<typeof AttentionSchema>;
}>;

export function progressAttempt(
  workstream: Workstream,
  key: AttemptKey,
  progress: AttemptProgress,
  updatedAt: string,
): Workstream {
  const existing = requireAttempt(workstream, key).attempt;
  if (existing.state === "queued")
    throw new Error(`Attempt ${key.attemptId} is not active or finished.`);
  if (
    existing.selectedModels !== undefined &&
    progress.selectedModels !== undefined &&
    !sameValue(existing.selectedModels, progress.selectedModels)
  )
    throw new Error(`Attempt ${key.attemptId} selected model facts are immutable.`);
  return mutate(workstream, updatedAt, (draft) => {
    const attempt = requireAttempt(draft, key).attempt;
    if (progress.execution !== undefined)
      attempt.execution = { ...attempt.execution, ...clone(progress.execution) };
    assignDefined(attempt, "selectedModels", progress.selectedModels);
    assignDefined(attempt, "effectiveModels", progress.effectiveModels);
    assignDefined(attempt, "application", progress.application);
    assignDefined(attempt, "cleanup", progress.cleanup);
    assignDefined(attempt, "outputRelease", progress.outputRelease);
    if (progress.attention !== undefined) {
      attempt.attentionHistory ??= [];
      attempt.attentionHistory.push(clone(progress.attention));
    }
    attempt.updatedAt = updatedAt;
    refreshCompletion(draft);
  });
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
  if (attempt.execution?.cancellation !== undefined) {
    if (sameValue(attempt.execution.cancellation, cancellation)) return workstream;
    throw new Error(`Attempt ${key.attemptId} has a conflicting cancellation request.`);
  }
  return progressAttempt(workstream, key, { execution: { cancellation } }, updatedAt);
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
  if (workstream.lifecycle === "completed")
    throw new Error("Cannot terminalize an Attempt after completion.");
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
    refreshCompletion(draft);
  });
}

export function recordDeliverySuccess(
  workstream: Workstream,
  key: AttemptKey,
  deliveredAt: string,
  updatedAt: string,
): Workstream {
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
    refreshCompletion(draft);
  });
}

export type OutputDisposition =
  | { kind: "not_applicable" }
  | { kind: "remove_checkout_and_branch"; checkout: "preserved_or_uncertain" | "removed" }
  | { kind: "retain_branch"; checkout: "preserved_or_uncertain" | "removed"; commit?: string }
  | { kind: "preserve_checkout"; reason: string }
  | { kind: "released" };

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

export function isReattemptStable(attempt: Attempt): boolean {
  if (attempt.state !== "finished") return false;
  if (attempt.execution === undefined) return true;
  if (attempt.application?.state === "pending" || attempt.application?.state === "blocked")
    return false;
  if (attempt.outputRelease?.state === "pending" || attempt.outputRelease?.state === "blocked")
    return false;
  if (attempt.outputRelease?.state === "completed") return true;
  return attempt.cleanup?.state === "completed" && attempt.cleanup.workerClosed;
}

export function deriveCompletionAccounting(workstream: Workstream): CompletionAccounting[] {
  const accounting: CompletionAccounting[] = [];
  for (const task of workstream.tasks) {
    if (!task.attempts.every((attempt) => attemptResolved(workstream, task, attempt)))
      accounting.push({
        kind: "unresolved_task",
        taskId: task.id,
        reason: "Task has an unresolved Attempt Outcome.",
      });
    for (const attempt of task.attempts) {
      if (!attemptResolved(workstream, task, attempt))
        accounting.push({
          kind: "unresolved_attempt",
          taskId: task.id,
          attemptId: attempt.id,
          reason: attemptAccountingReason(workstream, task, attempt),
        });
      if (attempt.outcome !== undefined && !outcomeResolved(workstream, task, attempt))
        accounting.push({
          kind: "unresolved_outcome",
          outcomeId: attempt.outcome.id,
          reason: outcomeAccountingReason(task, attempt),
        });
      if (attempt.outcome?.delivery.state === "pending")
        accounting.push({
          kind: "undelivered_outcome",
          outcomeId: attempt.outcome.id,
          reason: "Outcome delivery is pending.",
        });
    }
  }
  return accounting;
}

function attemptResolved(workstream: Workstream, task: Task, attempt: Attempt): boolean {
  return isReattemptStable(attempt) && outcomeResolved(workstream, task, attempt);
}

function outcomeResolved(workstream: Workstream, task: Task, attempt: Attempt): boolean {
  const outcome = attempt.outcome;
  if (outcome?.kind !== "reported" || outcome.report.status !== "completed") return false;
  if (task.kind !== "implementation") return true;
  if (outcome.report.kind !== "implementation") return false;
  if (outcome.report.outcome === "no_change") return true;
  return (
    attempt.application?.state === "applied" || includedByAppliedDescendant(workstream, attempt.id)
  );
}

function attemptAccountingReason(workstream: Workstream, task: Task, attempt: Attempt): string {
  if (!isReattemptStable(attempt))
    return "Attempt execution or owned output is not operationally stable.";
  return outcomeAccountingReason(task, attempt, workstream);
}

function outcomeAccountingReason(task: Task, attempt: Attempt, workstream?: Workstream): string {
  const outcome = attempt.outcome;
  if (outcome === undefined) return "Attempt has no terminal Outcome.";
  if (outcome.kind !== "reported") return `Attempt Outcome is ${outcome.kind}.`;
  if (outcome.report.status !== "completed")
    return `Worker Report status is ${outcome.report.status}.`;
  if (
    task.kind === "implementation" &&
    outcome.report.kind === "implementation" &&
    outcome.report.outcome === "changed" &&
    attempt.application?.state !== "applied" &&
    (workstream === undefined || !includedByAppliedDescendant(workstream, attempt.id))
  )
    return "Maintained candidate is not applied or included by an applied descendant.";
  return "Outcome does not satisfy the Task contract.";
}

function includedByAppliedDescendant(workstream: Workstream, attemptId: string): boolean {
  for (const task of workstream.tasks) {
    for (const candidate of task.attempts) {
      if (candidate.application?.state !== "applied" || candidate.application.commits === undefined)
        continue;
      const target = findAttemptLocation(workstream, attemptId)?.attempt;
      const commit = target === undefined ? undefined : changedImplementationCommit(target);
      if (commit !== undefined && candidate.application.commits.includes(commit)) return true;
    }
  }
  return false;
}

export function completeWorkstream(
  workstream: Workstream,
  input: Omit<Completion, "accounting">,
  updatedAt: string,
): Workstream {
  assertActive(workstream, "complete Workstream");
  if (!workstream.tasks.flatMap((task) => task.attempts).every(isReattemptStable))
    throw new Error("Cannot complete while an Attempt is operationally unstable.");
  return mutate(workstream, updatedAt, (draft) => {
    draft.lifecycle = "completed";
    draft.completion = { ...clone(input), accounting: deriveCompletionAccounting(draft) };
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
  if (left.kind !== right.kind || left.id !== right.id || left.observedAt !== right.observedAt)
    return false;
  if (!sameValue(left.artifacts, right.artifacts)) return false;
  if (left.kind === "reported" && right.kind === "reported")
    return sameValue(left.report, right.report);
  if (left.kind === "unreported" && right.kind === "unreported")
    return left.reason === right.reason && left.rawWorkerText === right.rawWorkerText;
  if (left.kind === "cancelled" && right.kind === "cancelled") return left.reason === right.reason;
  return false;
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
  draft.revision += 1;
  draft.updatedAt = updatedAt;
  validateWorkstream(draft);
  return draft;
}

function assertActive(workstream: Workstream, operation: string): void {
  if (workstream.lifecycle !== "active")
    throw new Error(`Cannot ${operation} on a completed Workstream.`);
}

function unique(values: readonly string[], label: string): Set<string> {
  const result = new Set(values);
  if (result.size !== values.length) throw new Error(`Duplicate ${label} id.`);
  return result;
}

function assignDefined<Key extends keyof Attempt>(
  attempt: Attempt,
  key: Key,
  value: Attempt[Key] | undefined,
): void {
  if (value !== undefined) {
    // SAFETY: The caller supplies a value for the matching Attempt key; the enclosing mutation is schema-validated.
    attempt[key] = clone(value) as Attempt[Key];
  }
}

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function sameValue<Value>(left: Value, right: Value): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
