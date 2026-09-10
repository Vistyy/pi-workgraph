import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import {
  ApplicationSchema,
  type Attempt,
  AttemptSchema,
  activateAttempt,
  appendAttempt,
  CandidateLineageSchema,
  checkpointApplication,
  checkpointCleanup,
  checkpointOutputRelease,
  completeWorkstream,
  createTask,
  createWorkstream,
  deriveCompletionAccounting,
  findAttempt,
  findTask,
  HandoffGrantSchema,
  type Intent,
  IntentSchema,
  outputDisposition,
  recordDeliveryFailure,
  recordDeliverySuccess,
  recordEffectiveModel,
  recordWorkerExecution,
  requestCancellation,
  reviseIntent,
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
  id: "receipt opaque",
  sessionId: "session",
  sessionFile: "/session.json",
  source: "interactive" as const,
  text: "Investigate the change.",
  receivedAt: "2026-01-01T00:00:00Z",
};
const intent: Intent = {
  statement: "Investigate the change.",
  constraints: ["Keep it isolated."],
  grounding: receipt,
  recordedAt: receipt.receivedAt,
};
const commit = (digit: string) => digit.repeat(40);
const baseCommit = commit("a");
const changedCommit = commit("b");

function attempt(id: string, extra: Partial<Attempt> = {}): Attempt {
  return {
    id,
    state: "queued",
    createdAt: "t0",
    updatedAt: "t0",
    selection: {
      role: "research",
      target: { model: "provider/research", thinking: "low" },
      source: "policy",
    },
    ...extra,
  };
}
function researchTask(id: string, attempts = [attempt("Attempt A")]): Task {
  return {
    kind: "research",
    id,
    objective: "Find evidence.",
    intentIndex: 0,
    createdAt: "t0",
    expectedEvidence: ["A result"],
    attempts,
  };
}
function reported(
  kind: "research" | "review" | "implementation" = "research",
): TerminalObservation {
  if (kind === "implementation")
    return {
      kind: "reported",
      observedAt: "t2",
      artifacts: [],
      deliveryRequestedAt: "t3",
      report: {
        kind,
        status: "completed",
        outcome: "changed",
        commit: changedCommit,
        summary: "Changed.",
        evidence: [],
        findings: [],
      },
    };
  return {
    kind: "reported",
    observedAt: "t2",
    artifacts: [],
    deliveryRequestedAt: "t3",
    report: { kind, status: "completed", summary: "Reported.", evidence: [], findings: [] },
  };
}
function cancelled(): TerminalObservation {
  return {
    kind: "cancelled",
    observedAt: "t2",
    artifacts: [],
    deliveryRequestedAt: "t3",
    reason: "Stopped.",
  };
}
function base() {
  return createWorkstream({
    id: "Workstream opaque",
    purpose: "Coordinate.",
    repository,
    coordinator,
    intent,
    createdAt: "t0",
  });
}
function add(workstream = base(), task = researchTask("Task opaque")) {
  return createTask(workstream, task, "t1");
}
function finish(
  workstream: ReturnType<typeof add>,
  id: string,
  observation: TerminalObservation,
  taskId = "Task opaque",
  execution?: Parameters<typeof activateAttempt>[3],
) {
  return terminalizeAttempt(
    activateAttempt(workstream, { taskId, attemptId: id }, "t1", execution),
    { taskId, attemptId: id },
    observation,
    "t2",
  );
}
function deliver(workstream: ReturnType<typeof add>, id: string, taskId = "Task opaque") {
  return recordDeliverySuccess(workstream, { taskId, attemptId: id }, "t4", "t4");
}

void test("pure aggregate schemas are strict and identifiers are opaque", () => {
  const workstream = base();
  assert.equal(Value.Check(WorkstreamSchema, workstream), true);
  assert.equal(Value.Check(AttemptSchema, { ...attempt("UPPER / arbitrary") }), true);
  assert.equal(Value.Check(WorkstreamSchema, { ...workstream, id: "" }), false);
  assert.equal(
    Value.Check(TaskSchema, {
      ...researchTask("Task"),
      attempts: [{ ...attempt("A"), selectedModels: { role: "research", selected: [] } }],
    }),
    false,
  );
  assert.equal(
    Value.Check(ApplicationSchema, {
      state: "pending",
      commit: baseCommit,
      expectedHead: baseCommit,
      rootCommit: baseCommit,
      commits: [baseCommit],
    }),
    true,
  );
  assert.equal(
    Value.Check(CandidateLineageSchema, { kind: "initial", rootCommit: baseCommit }),
    true,
  );
  assert.equal(
    Value.Check(WorkerExecutionSchema, {
      placement: { kind: "shared_project", path: "/repo" },
      resource: { workspaceId: "w" },
    }),
    false,
  );
});

void test("selection is one policy-owned target, while implementation retains guide and executor", () => {
  let workstream = activateAttempt(add(), { taskId: "Task opaque", attemptId: "Attempt A" }, "t2");
  const task = findTask(workstream, "Task opaque");
  assert.ok(task);
  assert.equal(findAttempt(task, "Attempt A")?.selection?.role, "research");
  assert.equal(
    Value.Check(AttemptSchema, {
      ...attempt("A"),
      selectedModels: [{ model: "provider/x" }],
      count: 2,
      distinctModels: true,
    }),
    false,
  );
  const execution = {
    placement: { kind: "shared_project" as const, path: "/repo" },
    worker: {
      workspaceId: "workspace",
      tabId: "tab",
      paneId: "pane",
      terminalId: "terminal",
      agentName: "agent",
      cwd: "/repo",
      sessionFile: "/worker.json",
    },
    submission: "not_sent" as const,
  };
  workstream = recordWorkerExecution(
    workstream,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    execution,
    "t3",
  );
  workstream = recordEffectiveModel(
    workstream,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { model: "provider/research", thinking: "low", source: "message" },
    "t4",
  );
  const duplicate = recordEffectiveModel(
    workstream,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { model: "provider/research", thinking: "low", source: "message" },
    "t5",
  );
  assert.strictEqual(duplicate, workstream);
  assert.throws(
    () =>
      recordWorkerExecution(
        workstream,
        { taskId: "Task opaque", attemptId: "Attempt A" },
        { ...execution, worker: { ...execution.worker, paneId: "other" } },
        "t5",
      ),
    /immutable/,
  );
  workstream = requestCancellation(
    workstream,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { requestedAt: "t6", reason: "Stop." },
    "t6",
  );
  const updatedTask = findTask(workstream, "Task opaque");
  assert.ok(updatedTask);
  assert.equal(findAttempt(updatedTask, "Attempt A")?.execution?.cancellation?.reason, "Stop.");
});

void test("grant is creation-only first grounding and revisions require a current direct receipt", () => {
  const grant = {
    kind: "handoff_grant" as const,
    id: "Grant opaque",
    parentReceipt: receipt,
    parentWorkstreamId: "Parent opaque",
    parentRepository: repository,
    parentIntentIndex: 0,
    parentIntentStatement: intent.statement,
    parentIntentConstraints: intent.constraints,
    narrowedRequest: "Continue.",
    targetRepository: repository,
    issuedAt: "t0",
  };
  const child = createWorkstream({
    id: "Child opaque",
    purpose: "Continue.",
    repository,
    coordinator,
    intent: { ...intent, grounding: grant },
    createdAt: "t0",
  });
  assert.equal(child.intents[0]?.grounding.kind, "handoff_grant");
  assert.throws(() => reviseIntent(child, { ...intent, grounding: grant }, "t1"), /direct receipt/);
  assert.equal(Value.Check(IntentSchema, { ...intent, grounding: grant }), true);
  assert.equal(Value.Check(HandoffGrantSchema, { ...grant, id: "" }), false);
  assert.throws(
    () =>
      validateWorkstream({
        ...child,
        intents: [...child.intents.slice(0, 1), { ...intent, grounding: grant }],
      }),
    /only valid for the first/,
  );
});

void test("report kind follows Task kind and first terminal replay uses structural equality", () => {
  const researchObservation = reported();
  assert.equal(researchObservation.kind, "reported");
  const malformedReport = {
    ...researchObservation,
    report: { ...researchObservation.report, kind: "review" },
  };
  // SAFETY: This intentionally crosses the report/Task boundary to verify aggregate rejection.
  assert.throws(
    () => finish(add(), "Attempt A", malformedReport as TerminalObservation),
    /Report kind/,
  );
  const workstream = finish(add(), "Attempt A", reported());
  const reordered = {
    kind: "reported" as const,
    observedAt: "t2",
    artifacts: [],
    deliveryRequestedAt: "t3",
    report: {
      findings: [],
      evidence: [],
      summary: "Reported.",
      status: "completed" as const,
      kind: "research" as const,
    },
  };
  const replay = terminalizeAttempt(
    workstream,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    reordered,
    "later",
  );
  assert.strictEqual(replay, workstream);
});

void test("terminal failures and cancellation settle once operational obligations are delivered", () => {
  let workstream = add(
    base(),
    researchTask("Task opaque", [attempt("Failed"), attempt("Cancelled")]),
  );
  workstream = finish(workstream, "Failed", {
    kind: "reported",
    observedAt: "t2",
    artifacts: [],
    deliveryRequestedAt: "t3",
    report: {
      kind: "research",
      status: "failed",
      summary: "Failed.",
      evidence: [],
      findings: [],
    },
  });
  workstream = recordDeliveryFailure(
    workstream,
    { taskId: "Task opaque", attemptId: "Failed" },
    { at: "t3", detail: "Retry delivery." },
    "t3",
  );
  workstream = deliver(workstream, "Failed");
  workstream = deliver(finish(workstream, "Cancelled", cancelled()), "Cancelled");
  assert.deepEqual(deriveCompletionAccounting(workstream), []);
  let fanout = deliver(finish(add(), "Attempt A", reported()), "Attempt A");
  fanout = appendAttempt(fanout, "Task opaque", attempt("Sibling"), "t5");
  assert.equal(findTask(fanout, "Task opaque")?.attempts.length, 2);
  workstream = completeWorkstream(
    workstream,
    {
      conclusion: "Settled.",
      evidence: [{ label: "check", observation: "done" }],
      limitations: [],
      completedAt: "t5",
    },
    "t5",
  );
  assert.deepEqual(workstream.completion?.accounting, []);
  assert.throws(() => createTask(workstream, researchTask("New"), "t6"), /completed/);
  assert.throws(() => reviseIntent(workstream, intent, "t6"), /completed/);
});

void test("implementation candidate ancestry may cross Intents but application is exact and immutable", () => {
  const execution = {
    placement: { kind: "isolated_worktree" as const, path: "/repo-work", branch: "branch" },
    worker: {
      workspaceId: "w",
      tabId: "tab",
      paneId: "pane",
      terminalId: "term",
      agentName: "agent",
      cwd: "/repo-work",
      sessionFile: "/worker.json",
    },
    submission: "started" as const,
  };
  const parentAttempt = attempt("Parent Attempt", {
    baseRevision: baseCommit,
    candidate: { kind: "initial", rootCommit: baseCommit },
    selection: {
      role: "implementation",
      guide: { model: "provider/guide", thinking: "low" },
      executor: { model: "provider/executor", thinking: "high" },
      source: "policy",
    },
  });
  const parentTask: Task = {
    kind: "implementation",
    id: "Parent Task",
    objective: "Implement.",
    intentIndex: 0,
    createdAt: "t0",
    acceptance: ["It works."],
    attempts: [parentAttempt],
  };
  let workstream = createTask(base(), parentTask, "t1");
  workstream = finish(
    workstream,
    "Parent Attempt",
    reported("implementation"),
    "Parent Task",
    execution,
  );
  workstream = checkpointApplication(
    workstream,
    { taskId: "Parent Task", attemptId: "Parent Attempt" },
    {
      state: "applied",
      commit: changedCommit,
      expectedHead: baseCommit,
      rootCommit: baseCommit,
      commits: [baseCommit, changedCommit],
      revision: commit("c"),
    },
    "t3",
  );
  workstream = checkpointCleanup(
    workstream,
    { taskId: "Parent Task", attemptId: "Parent Attempt" },
    { state: "completed", workerClosed: true, expectedHead: changedCommit },
    "t4",
  );
  const settledParentTask = findTask(workstream, "Parent Task");
  assert.ok(settledParentTask);
  const settledParentAttempt = findAttempt(settledParentTask, "Parent Attempt");
  assert.ok(settledParentAttempt);
  assert.equal(outputDisposition(settledParentTask, settledParentAttempt).kind, "retain_branch");
  workstream = checkpointOutputRelease(
    workstream,
    { taskId: "Parent Task", attemptId: "Parent Attempt" },
    { state: "completed", expectedHead: changedCommit, reason: "Released." },
    "t4b",
  );
  workstream = reviseIntent(
    workstream,
    { ...intent, statement: "Revise.", recordedAt: "t5" },
    "t5",
  );
  const childAttempt = attempt("Child Attempt", {
    baseRevision: changedCommit,
    candidate: {
      kind: "correction",
      rootCommit: baseCommit,
      parentAttemptId: "Parent Attempt",
      parentCommit: changedCommit,
    },
    selection: {
      role: "implementation",
      guide: { model: "provider/guide", thinking: "low" },
      executor: { model: "provider/executor", thinking: "high" },
      source: "policy",
    },
  });
  const childTask: Task = {
    kind: "implementation",
    id: "Child Task",
    objective: "Correct.",
    intentIndex: 1,
    createdAt: "t5",
    acceptance: ["It works."],
    attempts: [childAttempt],
  };
  workstream = createTask(workstream, childTask, "t6");
  assert.equal(findTask(workstream, "Child Task")?.intentIndex, 1);
});
