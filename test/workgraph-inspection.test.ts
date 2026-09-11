import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  inspectWorkstream,
  MAX_DELIVERY_NOTIFICATION_CHARS,
  projectWorkstreamAction,
  WorkstreamInspectionError,
  type WorkstreamInspectionRequest,
  type WorkstreamInspectionView,
  workstreamOutcomeNotification,
} from "../src/coordination/inspection.js";
import type { WorkstreamRuntimeInspectionSnapshot } from "../src/coordination/runtime.js";
import {
  type Attempt,
  completeWorkstream,
  createTask,
  createWorkstream,
  recordDeliverySuccess,
  suspendWorkstream,
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

function completeFixture(): WorkstreamRuntimeInspectionSnapshot {
  let state = createWorkstream({
    id: "workstream-inspection",
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
        text: "Inspect the workstream aggregate.",
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
      evidence: [{ label: "flow", observation: "All sections retain workstream facts." }],
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

type ViewFor<Section extends WorkstreamInspectionRequest["section"]> = Extract<
  WorkstreamInspectionView,
  { readonly section: Section }
>;

async function inspectTyped<Section extends WorkstreamInspectionRequest["section"]>(
  snapshot: WorkstreamRuntimeInspectionSnapshot,
  request: WorkstreamInspectionRequest & { readonly section: Section },
): Promise<ViewFor<Section>> {
  return Effect.runPromise(inspectWorkstream(snapshot, request));
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Rejection cases intentionally exercise the schema-owning external boundary.
async function inspect(snapshot: WorkstreamRuntimeInspectionSnapshot, request: unknown) {
  return Effect.runPromise(inspectWorkstream(snapshot, request));
}

async function collectText(
  snapshot: WorkstreamRuntimeInspectionSnapshot,
  request: WorkstreamInspectionRequest,
): Promise<string> {
  let current: WorkstreamInspectionRequest = request;
  let result = "";
  for (let page = 0; page < 100; page += 1) {
    const view = await inspectTyped(snapshot, current);
    if (!("content" in view)) return assert.fail("text request returned an item projection");
    result += view.content.text;
    if (view.next === undefined) return result;
    current = view.next;
  }
  return assert.fail("text cursor did not finish");
}

void test("overview and context expose the bounded current suspension fact", async () => {
  const fixture = completeFixture();
  const initial = createWorkstream({
    id: "suspended-inspection",
    purpose: "Inspect suspension.",
    repository: fixture.workstream.repository,
    coordinator: fixture.workstream.coordinator,
    intent: fixture.workstream.intents[0] ?? assert.fail("intent"),
    createdAt: T0,
  });
  const workstream = suspendWorkstream(
    initial,
    { reason: "Await explicit input.", suspendedAt: T1 },
    T1,
  );
  const snapshot = { workstream, reconciliation: [] };
  const overview = await inspectTyped(snapshot, { section: "overview" });
  assert.equal(overview.summary.lifecycle, "suspended");
  assert.deepEqual(overview.summary.suspension, {
    reason: "Await explicit input.",
    suspendedAt: T1,
  });
  const context = await collectText(snapshot, { section: "context" });
  assert.match(context, /"lifecycle": "suspended"/);
  assert.match(context, /"reason": "Await explicit input\."/);
  assert.match(context, /"suspendedAt": "2026-01-01T00:00:01\.000Z"/);
  const suspendedAction = await Effect.runPromise(
    projectWorkstreamAction(snapshot, { action: "suspend" }),
  );
  assert.deepEqual(suspendedAction.workstream.suspension, workstream.suspension);
  const activeAction = await Effect.runPromise(
    projectWorkstreamAction({ workstream: initial, reconciliation: [] }, { action: "create" }),
  );
  assert.equal("suspension" in activeAction.workstream, false);
});

void test("one complete Workstream projects all sections with one bounded cursor", async () => {
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

  const overview = await inspectTyped(snapshot, { section: "overview" });
  const transient = overview.items.values.find((item) => item.record === "reconciliation");
  assert.equal(transient?.blockedReason, "Controlled transient delivery block.");
  const recovery = await inspectTyped(snapshot, {
    section: "recovery",
    attemptId: "attempt-1",
  });
  assert.equal(
    recovery.summary.reconciliation.values[0]?.blockedReason,
    "Controlled transient delivery block.",
  );

  const firstItems = await inspectTyped(snapshot, {
    section: "task",
    taskId: "task-exact",
    maxItems: 10,
  });
  assert.equal(firstItems.items.returnedItems, 10);
  assert.ok(firstItems.next?.cursor !== undefined);
  const secondItems = await inspectTyped(snapshot, firstItems.next);
  assert.equal(secondItems.items.values[0]?.attemptId, "attempt-11");

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
  const failures: ReadonlyArray<readonly [unknown, WorkstreamInspectionError["code"]]> = [
    [{ section: "report", outcomeId: "attempt-1:outcome", cursor: "malformed" }, "invalid_cursor"],
    [{ section: "report", outcomeId: "attempt-1:outcome", cursor: `${cursor}x` }, "invalid_cursor"],
    [{ section: "evidence", outcomeId: "attempt-1:outcome", cursor }, "cursor_mismatch"],
    [
      { section: "report", outcomeId: "attempt-1:outcome", cursor, maxChars: 101 },
      "cursor_mismatch",
    ],
    [{ section: "recovery", attemptId: "attempt-404" }, "unknown_handle"],
    [{ section: "task", taskId: "task-exact", attemptId: "attempt-1" }, "invalid_selector"],
    [{ section: "overview", maxChars: 8_001 }, "invalid_request"],
  ];
  for (const [request, code] of failures)
    await assert.rejects(
      () => inspect(snapshot, request),
      (error) => error instanceof WorkstreamInspectionError && error.code === code,
    );
  const advanced = structuredClone(snapshot);
  advanced.workstream.revision += 1;
  await assert.rejects(
    () => inspect(advanced, first.next),
    (error) => error instanceof WorkstreamInspectionError && error.code === "cursor_mismatch",
  );

  const malformed = structuredClone(snapshot);
  Reflect.set(malformed.workstream, "purpose", undefined);
  await assert.rejects(
    () => inspect(malformed, { section: "overview" }),
    (error) => error instanceof WorkstreamInspectionError && error.code === "internal_failure",
  );
});

void test("action and delivery projections stay compact and identify exact retrieval handles", async () => {
  const snapshot = completeFixture();
  const base = snapshot.reconciliation[0] ?? assert.fail("reconciliation fixture");
  const { blockedReason: _blockedReason, ...unblocked } = base;
  const mixedSnapshot: WorkstreamRuntimeInspectionSnapshot = {
    workstream: snapshot.workstream,
    reconciliation: [
      unblocked,
      { ...unblocked, deadlineAt: "2026-01-01T00:00:29.000Z" },
      ...Array.from({ length: 6 }, (_, index) => ({
        ...base,
        blockedReason: `blocked-${index + 1}`,
      })),
    ],
  };
  const action = await Effect.runPromise(
    projectWorkstreamAction(mixedSnapshot, {
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
  assert.equal(action.blocked.frontierCount, 8);
  assert.equal(action.blocked.blockedCount, 6);
  assert.deepEqual(
    action.blocked.values.map((item) => item.blockedReason),
    ["blocked-1", "blocked-2", "blocked-3", "blocked-4", "blocked-5"],
  );
  assert.equal(action.blocked.truncated, true);

  const notification = await Effect.runPromise(
    workstreamOutcomeNotification(snapshot, "attempt-1:outcome"),
  );
  assert.ok(notification.length <= MAX_DELIVERY_NOTIFICATION_CHARS);
  assert.match(notification, /Task task-exact; Attempt attempt-1; Outcome attempt-1:outcome/);
  assert.match(notification, /exact outcomeId attempt-1:outcome/);
});

void test("non-reported report projection exposes only report-equivalent reason and raw text", async () => {
  const snapshot = completeFixture();
  const attempt = snapshot.workstream.tasks[0]?.attempts[0] ?? assert.fail("attempt fixture");
  const reported = attempt.outcome ?? assert.fail("outcome fixture");
  attempt.outcome = {
    id: reported.id,
    kind: "unreported",
    observedAt: reported.observedAt,
    artifacts: reported.artifacts,
    reason: "Worker output did not match the report contract.",
    rawWorkerText: "raw retained worker text",
    delivery: reported.delivery,
  };
  const text = await collectText(snapshot, {
    section: "report",
    outcomeId: reported.id,
  });
  assert.deepEqual(JSON.parse(text), {
    kind: "unreported",
    reason: "Worker output did not match the report contract.",
    rawWorkerText: "raw retained worker text",
  });
});
