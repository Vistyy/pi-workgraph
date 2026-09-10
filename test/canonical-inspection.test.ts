import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  CanonicalInspectionError,
  type CanonicalInspectionRequest,
  canonicalOutcomeNotification,
  inspectCanonical,
  MAX_DELIVERY_NOTIFICATION_CHARS,
  projectCanonicalAction,
} from "../src/canonical-inspection.js";
import type { CanonicalRuntimeInspectionSnapshot } from "../src/canonical-runtime.js";
import {
  type Attempt,
  completeWorkstream,
  createTask,
  createWorkstream,
  recordDeliverySuccess,
  type Task,
  terminalizeAttempt,
} from "../src/domain/workstream.js";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:00:01.000Z";

function queuedAttempt(id: string): Attempt {
  return {
    id,
    state: "queued",
    createdAt: T0,
    updatedAt: T0,
    selection: {
      role: "research",
      target: { model: "fixture/research", thinking: "high" },
      source: "policy",
    },
  };
}

function completeFixture(): CanonicalRuntimeInspectionSnapshot {
  let state = createWorkstream({
    id: "canonical-inspection",
    purpose: `Inspect one complete Workstream ${"bounded context ".repeat(80)}`,
    repository: { projectRoot: "/repo", gitCommonDir: "/repo/.git" },
    coordinator: { sessionId: "session", sessionFile: "/session.jsonl" },
    intent: {
      statement: `Retain exact inspection substance ${"intent detail ".repeat(80)}`,
      constraints: ["Use exact handles."],
      grounding: {
        kind: "human_input_receipt",
        id: "receipt",
        sessionId: "session",
        sessionFile: "/session.jsonl",
        source: "interactive",
        text: "Inspect the canonical aggregate.",
        receivedAt: T0,
      },
      recordedAt: T0,
    },
    createdAt: T0,
  });
  const task: Task = {
    id: "task-exact",
    kind: "research",
    objective: `Establish inspection behavior ${"objective detail ".repeat(80)}`,
    intentIndex: 0,
    expectedEvidence: ["Complete retained report."],
    createdAt: T0,
    attempts: Array.from({ length: 22 }, (_, index) => queuedAttempt(`attempt-${index + 1}`)),
  };
  state = createTask(state, task, T0);
  for (const attempt of task.attempts) {
    const outcomeId = `${attempt.id}:outcome`;
    state = terminalizeAttempt(
      state,
      { taskId: task.id, attemptId: attempt.id },
      {
        kind: "reported",
        observedAt: T1,
        artifacts: [
          {
            id: `artifact-${attempt.id}`,
            kind: "reference",
            reference: `/retained/${attempt.id}`,
            retention: "retained",
            summary: "Retained evidence.",
          },
        ],
        report: {
          kind: "research",
          status: "completed",
          summary: `Complete report ${"substance 🧭 ".repeat(120)}`,
          evidence: Array.from({ length: 20 }, (_, index) => ({
            label: `evidence-${index}`,
            observation: `Observation ${index} ${"detail ".repeat(40)}`,
            class: "direct" as const,
          })),
          findings: [],
        },
        deliveryRequestedAt: T1,
      },
      T1,
    );
    state = recordDeliverySuccess(state, { taskId: task.id, attemptId: attempt.id }, T1, T1);
    assert.equal(
      state.tasks[0]?.attempts.find((item) => item.id === attempt.id)?.outcome?.id,
      outcomeId,
    );
  }
  state = completeWorkstream(
    state,
    {
      conclusion: `Inspection complete ${"conclusion detail ".repeat(80)}`,
      evidence: [{ label: "flow", observation: "All sections retain canonical facts." }],
      limitations: [],
      completedAt: T1,
    },
    T1,
  );
  return {
    workstream: state,
    reconciliation: [
      {
        entry: {
          kind: "delivery",
          key: { taskId: task.id, attemptId: "attempt-1" },
          outcomeId: "attempt-1:outcome",
        },
        deadlineAt: "2026-01-01T00:00:30.000Z",
        blockedReason: "Controlled transient delivery block.",
      },
    ],
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Rejection cases intentionally exercise the schema-owning external boundary.
async function inspect(snapshot: CanonicalRuntimeInspectionSnapshot, request: unknown) {
  return Effect.runPromise(inspectCanonical(snapshot, request));
}

async function collectText(
  snapshot: CanonicalRuntimeInspectionSnapshot,
  request: CanonicalInspectionRequest,
): Promise<string> {
  let current: CanonicalInspectionRequest = request;
  let result = "";
  for (let page = 0; page < 100; page += 1) {
    const view = await inspect(snapshot, current);
    result += view.content?.text ?? "";
    if (view.next === undefined) return result;
    current = view.next;
  }
  return assert.fail("text cursor did not finish");
}

void test("one complete canonical Workstream projects all sections with one bounded cursor", async () => {
  const snapshot = completeFixture();
  const outcomeId = "attempt-1:outcome";
  const requests = [
    { section: "overview" },
    { section: "context" },
    { section: "completion" },
    { section: "task", taskId: "task-exact" },
    { section: "assignment", taskId: "task-exact" },
    { section: "outcome", outcomeId },
    { section: "evidence", outcomeId },
    { section: "recovery", attemptId: "attempt-1" },
    { section: "report", outcomeId },
  ];
  for (const request of requests) {
    const view = await inspect(snapshot, request);
    assert.equal(view.section, request.section);
    assert.equal(view.workstreamId, snapshot.workstream.id);
  }

  const overview = await inspect(snapshot, { section: "overview" });
  // SAFETY: Overview item pages contain only the module's tagged stable preview records.
  const overviewItems = overview.items?.values as
    | readonly { record: string; blockedReason?: string }[]
    | undefined;
  const transient = overviewItems?.find((item) => item.record === "reconciliation");
  assert.equal(transient?.blockedReason, "Controlled transient delivery block.");
  const recovery = await inspect(snapshot, { section: "recovery", attemptId: "attempt-1" });
  // SAFETY: this assertion narrows the documented recovery summary for its section-specific check.
  const recoverySummary = recovery.summary as {
    reconciliation: { values: Array<{ blockedReason?: string }> };
  };
  assert.equal(
    recoverySummary.reconciliation.values[0]?.blockedReason,
    "Controlled transient delivery block.",
  );

  const firstItems = await inspect(snapshot, {
    section: "task",
    taskId: "task-exact",
    maxItems: 10,
  });
  assert.equal(firstItems.items?.returnedItems, 10);
  assert.ok(firstItems.next?.cursor !== undefined);
  const secondItems = await inspect(snapshot, firstItems.next);
  // SAFETY: Task item pages contain the module's stable Attempt preview shape.
  assert.equal(
    (secondItems.items?.values[0] as { attemptId?: string } | undefined)?.attemptId,
    "attempt-11",
  );

  const report = snapshot.workstream.tasks[0]?.attempts[0]?.outcome;
  assert.ok(report?.kind === "reported");
  const recovered = await collectText(snapshot, {
    section: "report",
    outcomeId,
    maxChars: 97,
  });
  assert.deepEqual(JSON.parse(recovered), report.report);
});

void test("cursor integrity, selectors, revisions, budgets, and exact handles reject with typed errors", async () => {
  const snapshot = completeFixture();
  const first = await inspect(snapshot, {
    section: "report",
    outcomeId: "attempt-1:outcome",
    maxChars: 100,
  });
  assert.ok(first.next?.cursor !== undefined);
  const cursor = first.next.cursor;
  const failures = [
    { section: "report", outcomeId: "attempt-1:outcome", cursor: `${cursor}x` },
    { section: "evidence", outcomeId: "attempt-1:outcome", cursor },
    { section: "report", outcomeId: "attempt-1:outcome", cursor, maxChars: 101 },
    { section: "recovery", attemptId: "attempt-404" },
    { section: "task", taskId: "task-exact", attemptId: "attempt-1" },
    { section: "overview", maxChars: 8_001 },
  ];
  for (const request of failures)
    await assert.rejects(
      () => inspect(snapshot, request),
      (error) => error instanceof CanonicalInspectionError,
    );
  const advanced = structuredClone(snapshot);
  advanced.workstream.revision += 1;
  await assert.rejects(
    () => inspect(advanced, first.next),
    (error) => error instanceof CanonicalInspectionError && error.code === "cursor_mismatch",
  );
});

void test("action and delivery projections stay compact and identify exact retrieval handles", async () => {
  const snapshot = completeFixture();
  const action = await Effect.runPromise(
    projectCanonicalAction(snapshot, {
      action: `record delivery ${"action ".repeat(100)}`,
      message: "Delivered.",
      taskId: "task-exact",
      attemptId: "attempt-1",
      outcomeId: "attempt-1:outcome",
    }),
  );
  assert.equal(action.affected.task?.taskId, "task-exact");
  assert.equal(action.affected.attempt?.attemptId, "attempt-1");
  assert.equal(action.affected.outcome?.outcomeId, "attempt-1:outcome");
  assert.ok(action.action.name.length <= 120);

  const notification = await Effect.runPromise(
    canonicalOutcomeNotification(snapshot, "attempt-1:outcome"),
  );
  assert.ok(notification.length <= MAX_DELIVERY_NOTIFICATION_CHARS);
  assert.match(notification, /Task task-exact; Attempt attempt-1; Outcome attempt-1:outcome/);
  assert.match(notification, /exact outcomeId attempt-1:outcome/);
});
