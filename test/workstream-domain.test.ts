import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import {
  ApplicationSchema,
  type Attempt,
  AttemptSchema,
  activateAttempt,
  appendAttempt,
  CANONICAL_WORKSTREAM_FORMAT,
  CANONICAL_WORKSTREAM_SCHEMA,
  CANONICAL_WORKSTREAM_SCHEMA_VERSION,
  CandidateLineageSchema,
  CleanupSchema,
  CompletionAccountingSchema,
  CompletionSchema,
  CoordinatorIdentitySchema,
  completeWorkstream,
  createTask,
  createWorkstream,
  DeliverySchema,
  deriveCompletionAccounting,
  findAttempt,
  findAttemptLocation,
  findOutcome,
  findTask,
  HandoffGrantSchema,
  HumanInputReceiptSchema,
  type Intent,
  IntentGroundingSchema,
  IntentSchema,
  isReattemptStable,
  OutcomeSchema,
  OutputReleaseSchema,
  outcomeIdForAttempt,
  outputDisposition,
  progressAttempt,
  RepositoryIdentitySchema,
  RetainedArtifactSchema,
  ReviewSubjectSchema,
  recordDeliveryFailure,
  recordDeliverySuccess,
  requestCancellation,
  requireAttempt,
  reviseIntent,
  SelectedModelsSchema,
  type Task,
  TaskSchema,
  type TerminalObservation,
  terminalizeAttempt,
  validateWorkstream,
  WorkerExecutionSchema,
  WorkstreamSchema,
} from "../src/domain/workstream.js";

const repository = { projectRoot: "/repo", gitCommonDir: "/repo/.git" };
const coordinator = { sessionId: "session", sessionFile: "/session.json" };
const receipt = {
  kind: "human_input_receipt" as const,
  id: "receipt-1",
  sessionId: coordinator.sessionId,
  sessionFile: coordinator.sessionFile,
  source: "interactive" as const,
  text: "Investigate the change.",
  receivedAt: "2026-01-01T00:00:00Z",
};
const intent: Intent = {
  statement: "Investigate the change.",
  constraints: ["Keep the work isolated."],
  grounding: receipt,
  recordedAt: receipt.receivedAt,
};

function attempt(id: string, overrides: Partial<Attempt> = {}): Attempt {
  return { id, state: "queued", createdAt: "2026-01-01", updatedAt: "2026-01-01", ...overrides };
}

function researchTask(id: string, ...attempts: Attempt[]): Task {
  return {
    kind: "research",
    id,
    objective: "Find relevant evidence.",
    intentIndex: 0,
    createdAt: "2026-01-01",
    expectedEvidence: ["A bounded observation"],
    attempts,
  };
}

function reportedObservation(deliveryRequestedAt = "2026-01-01T00:01:00Z"): TerminalObservation {
  return {
    kind: "reported",
    observedAt: "2026-01-01T00:02:00Z",
    artifacts: [],
    deliveryRequestedAt,
    report: {
      kind: "research",
      status: "completed",
      summary: "Evidence retained.",
      evidence: [{ label: "check", observation: "It passed." }],
      findings: [],
    },
  };
}

function cancelledObservation(): TerminalObservation {
  return {
    kind: "cancelled",
    observedAt: "2026-01-01T00:03:00Z",
    artifacts: [],
    deliveryRequestedAt: "2026-01-01T00:04:00Z",
    reason: "Native worker presence was uncertain.",
  };
}

function unreportedObservation(): TerminalObservation {
  return {
    kind: "unreported",
    observedAt: "2026-01-01T00:05:00Z",
    artifacts: [],
    deliveryRequestedAt: "2026-01-01T00:06:00Z",
    reason: "Worker stopped without a structured report.",
    rawWorkerText: "partial output",
  };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value.");
  return value;
}

function base() {
  return createWorkstream({
    id: "workstream-1",
    purpose: "Coordinate the investigation.",
    repository,
    coordinator,
    intent,
    createdAt: "2026-01-01T00:00:00Z",
  });
}

function addTask(workstream = base(), task = researchTask("task-1", attempt("attempt-1"))) {
  return createTask(workstream, task, "2026-01-01T00:00:01Z");
}

function finish(
  workstream: ReturnType<typeof addTask>,
  attemptId: string,
  observation: TerminalObservation,
) {
  return terminalizeAttempt(
    activateAttempt(workstream, { taskId: "task-1", attemptId }, "2026-01-01T00:00:02Z"),
    { taskId: "task-1", attemptId },
    observation,
    "2026-01-01T00:00:03Z",
  );
}

void test("canonical shape round-trips and rejects invalid grounding without mutation", () => {
  const workstream = base();
  assert.equal(CANONICAL_WORKSTREAM_FORMAT, "pi-workgraph-workstream");
  assert.equal(CANONICAL_WORKSTREAM_SCHEMA, "coordination-domain");
  assert.equal(CANONICAL_WORKSTREAM_SCHEMA_VERSION, 1);
  const schemas = [
    RepositoryIdentitySchema,
    CoordinatorIdentitySchema,
    HumanInputReceiptSchema,
    HandoffGrantSchema,
    IntentGroundingSchema,
    IntentSchema,
    ReviewSubjectSchema,
    CandidateLineageSchema,
    SelectedModelsSchema,
    WorkerExecutionSchema,
    ApplicationSchema,
    CleanupSchema,
    OutputReleaseSchema,
    RetainedArtifactSchema,
    DeliverySchema,
    OutcomeSchema,
    AttemptSchema,
    TaskSchema,
    CompletionAccountingSchema,
    CompletionSchema,
    WorkstreamSchema,
  ];
  assert.equal(schemas.length, 21);
  assert.equal(outcomeIdForAttempt("attempt-1"), "attempt-1:outcome");
  assert.equal(Value.Check(WorkstreamSchema, workstream), true);
  assert.deepEqual(JSON.parse(JSON.stringify(workstream)), workstream);
  assert.throws(() =>
    createWorkstream({
      ...workstream,
      intent: {
        ...intent,
        grounding: { ...receipt, sessionId: "other-session" },
      },
    }),
  );
  const before = JSON.stringify(workstream);
  assert.throws(() =>
    reviseIntent(
      workstream,
      {
        ...intent,
        grounding: {
          kind: "handoff_grant",
          id: "grant-1",
          parentReceipt: receipt,
          parentWorkstreamId: "parent-workstream",
          parentRepository: repository,
          parentIntentIndex: 0,
          parentIntentStatement: intent.statement,
          parentIntentConstraints: intent.constraints,
          narrowedRequest: "Continue the investigation.",
          targetRepository: { projectRoot: "/other", gitCommonDir: "/other/.git" },
          issuedAt: "2026-01-01T00:07:00Z",
        },
        recordedAt: "2026-01-01T00:07:00Z",
      },
      "2026-01-01T00:07:00Z",
    ),
  );
  assert.equal(JSON.stringify(workstream), before);
});

void test("Task contracts, current intent indexing, and sibling fanout are enforced", () => {
  const workstream = base();
  assert.throws(() =>
    createTask(
      workstream,
      researchTask("task-1", attempt("attempt-1"), attempt("attempt-1")),
      "t1",
    ),
  );
  assert.throws(() =>
    createTask(
      workstream,
      { ...researchTask("task-1", attempt("attempt-1")), intentIndex: 1 },
      "t1",
    ),
  );
  assert.equal(
    Value.Check(TaskSchema, {
      ...researchTask("task-extra", attempt("attempt-extra")),
      artifactIntent: "evidence_only",
    }),
    false,
  );
  const fanout = addTask(
    workstream,
    researchTask("task-1", attempt("attempt-1"), attempt("attempt-2")),
  );
  assert.equal(findTask(fanout, "task-1")?.attempts.length, 2);
  assert.equal(findAttempt(required(findTask(fanout, "task-1")), "attempt-2")?.state, "queued");
  assert.deepEqual(findAttemptLocation(fanout, "attempt-1")?.task.id, "task-1");
  assert.equal(
    requireAttempt(fanout, { taskId: "task-1", attemptId: "attempt-2" }).attempt.id,
    "attempt-2",
  );
});

void test("terminalization is exact-attempt first-terminal and siblings remain independent", () => {
  let workstream = addTask(
    base(),
    researchTask(
      "task-1",
      attempt("attempt-report"),
      attempt("attempt-cancel"),
      attempt("attempt-unreported"),
    ),
  );
  workstream = finish(workstream, "attempt-report", reportedObservation());
  const replay = terminalizeAttempt(
    workstream,
    { taskId: "task-1", attemptId: "attempt-report" },
    reportedObservation(),
    "later",
  );
  assert.strictEqual(replay, workstream);
  const beforeConflict = JSON.stringify(workstream);
  assert.throws(() =>
    terminalizeAttempt(
      workstream,
      { taskId: "task-1", attemptId: "attempt-report" },
      cancelledObservation(),
      "later",
    ),
  );
  assert.equal(JSON.stringify(workstream), beforeConflict);
  workstream = finish(workstream, "attempt-cancel", cancelledObservation());
  workstream = finish(workstream, "attempt-unreported", unreportedObservation());
  assert.throws(() =>
    terminalizeAttempt(
      workstream,
      { taskId: "task-1", attemptId: "attempt-unreported" },
      reportedObservation(),
      "later",
    ),
  );
  assert.equal(findOutcome(workstream, "attempt-report:outcome")?.kind, "reported");
  assert.equal(findOutcome(workstream, "attempt-cancel:outcome")?.kind, "cancelled");
  assert.equal(findOutcome(workstream, "attempt-unreported:outcome")?.kind, "unreported");
});

void test("cancellation records uncertainty without terminalizing native work, and ordering is first-terminal", () => {
  let workstream = addTask();
  workstream = activateAttempt(workstream, { taskId: "task-1", attemptId: "attempt-1" }, "t2", {
    placement: { kind: "shared_project", path: "/repo" },
    submission: "started",
    sessionFile: "/worker.json",
  });
  workstream = requestCancellation(
    workstream,
    { taskId: "task-1", attemptId: "attempt-1" },
    {
      requestedAt: "t3",
      reason: "Stop safely.",
    },
    "t3",
  );
  assert.equal(findAttempt(required(findTask(workstream, "task-1")), "attempt-1")?.state, "active");
  const reported = terminalizeAttempt(
    workstream,
    { taskId: "task-1", attemptId: "attempt-1" },
    reportedObservation(),
    "t4",
  );
  assert.throws(() =>
    terminalizeAttempt(
      reported,
      { taskId: "task-1", attemptId: "attempt-1" },
      cancelledObservation(),
      "t5",
    ),
  );
  assert.equal(findOutcome(reported, "attempt-1:outcome")?.kind, "reported");
});

void test("delivery failures are rereadable and success does not replace terminal substance", () => {
  let workstream = finish(addTask(), "attempt-1", reportedObservation());
  const original = required(findOutcome(workstream, "attempt-1:outcome"));
  workstream = recordDeliveryFailure(
    workstream,
    { taskId: "task-1", attemptId: "attempt-1" },
    { at: "t5", detail: "temporary delivery failure" },
    "t5",
  );
  assert.equal(findOutcome(workstream, original.id)?.delivery.attemptCount, 1);
  workstream = recordDeliverySuccess(
    workstream,
    { taskId: "task-1", attemptId: "attempt-1" },
    "t6",
    "t6",
  );
  const delivered = required(findOutcome(workstream, original.id));
  assert.equal(delivered.delivery.state, "delivered");
  assert.equal(delivered.delivery.attemptCount, 2);
  assert.deepEqual({ ...delivered, delivery: undefined }, { ...original, delivery: undefined });
});

void test("reattempts require a current task and stable prior output", () => {
  let workstream = addTask();
  assert.throws(() => appendAttempt(workstream, "task-1", attempt("attempt-2"), "t2"));
  workstream = finish(workstream, "attempt-1", reportedObservation());
  assert.equal(
    isReattemptStable(required(findAttempt(required(findTask(workstream, "task-1")), "attempt-1"))),
    true,
  );
  workstream = appendAttempt(workstream, "task-1", attempt("attempt-2"), "t5");
  workstream = reviseIntent(
    workstream,
    { ...intent, statement: "A revised investigation.", recordedAt: "t6" },
    "t6",
  );
  assert.throws(() => appendAttempt(workstream, "task-1", attempt("attempt-3"), "t7"));
});

void test("completion is derived and completed authority cannot expand, while operational progress remains possible", () => {
  let workstream = finish(addTask(), "attempt-1", reportedObservation());
  workstream = completeWorkstream(
    workstream,
    {
      conclusion: "Investigation recorded.",
      evidence: [{ label: "test", observation: "Invariant held." }],
      limitations: [],
      completedAt: "t8",
    },
    "t8",
  );
  validateWorkstream(workstream);
  assert.deepEqual(workstream.completion?.accounting, deriveCompletionAccounting(workstream));
  assert.throws(() => reviseIntent(workstream, intent, "t9"));
  assert.throws(() => createTask(workstream, researchTask("task-2", attempt("attempt-2")), "t9"));
  assert.throws(() => appendAttempt(workstream, "task-1", attempt("attempt-2"), "t9"));
  const progressed = progressAttempt(
    workstream,
    { taskId: "task-1", attemptId: "attempt-1" },
    {
      attention: { detail: "Post-completion operational note.", at: "t9" },
    },
    "t9",
  );
  assert.equal(progressed.lifecycle, "completed");
  const completedTask = required(findTask(progressed, "task-1"));
  assert.equal(
    outputDisposition(completedTask, required(findAttempt(completedTask, "attempt-1"))).kind,
    "not_applicable",
  );
});
