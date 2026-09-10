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
  LaunchCheckpointSchema,
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
import { EvidenceInputSchema, WorkerReportInputSchema } from "../src/report-schema.js";

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
function resourceForTest() {
  return {
    phase: "resource" as const,
    workspaceId: "workspace",
    tabId: "tab",
    paneId: "pane",
    terminalId: "terminal",
    agentName: "agent",
    cwd: "/repo-work",
  };
}
function recordLaunchProgress(
  workstream: ReturnType<typeof add>,
  key: { taskId: string; attemptId: string },
  execution: NonNullable<Parameters<typeof activateAttempt>[3]>,
): ReturnType<typeof add> {
  let active = workstream;
  if (execution.placement !== undefined)
    active = recordWorkerExecution(active, key, { placement: execution.placement }, "t1a");
  if (execution.sessionFile !== undefined)
    active = recordWorkerExecution(active, key, { sessionFile: execution.sessionFile }, "t1b");
  if (execution.launch !== undefined) {
    const pane = {
      phase: "pane" as const,
      workspaceId: execution.launch.workspaceId,
      paneId: execution.launch.paneId,
    };
    active = recordWorkerExecution(active, key, { launch: pane }, "t1c");
    if (execution.launch.phase !== "pane") {
      const resource = { ...execution.launch, phase: "resource" as const };
      active = recordWorkerExecution(active, key, { launch: resource }, "t1d");
      if (execution.launch.phase === "ready")
        active = recordWorkerExecution(active, key, { launch: execution.launch }, "t1e");
    }
  }
  return active;
}
function isolatedPaneLaunch(key: { taskId: string; attemptId: string }): ReturnType<typeof add> {
  return recordLaunchProgress(activateAttempt(add(), key, "t1"), key, {
    placement: { kind: "isolated_worktree", path: "/repo-work", branch: "branch" },
    sessionFile: "/worker.json",
    launch: { phase: "pane", workspaceId: "workspace", paneId: "pane" },
  });
}
function finish(
  workstream: ReturnType<typeof add>,
  id: string,
  observation: TerminalObservation,
  taskId = "Task opaque",
  execution?: Parameters<typeof activateAttempt>[3],
) {
  const key = { taskId, attemptId: id };
  let active = activateAttempt(workstream, key, "t1");
  if (execution !== undefined) active = recordLaunchProgress(active, key, execution);
  if (execution?.submission !== undefined) {
    active = recordWorkerExecution(active, key, { submission: "not_sent" }, "t1f");
    if (execution.submission !== "not_sent") {
      active = recordWorkerExecution(active, key, { submission: "uncertain" }, "t1g");
      if (execution.submission !== "uncertain")
        active = recordWorkerExecution(active, key, { submission: execution.submission }, "t1h");
    }
  }
  return terminalizeAttempt(active, key, observation, "t2");
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
    Value.Check(EvidenceInputSchema, { label: "x", observation: "y", extra: true }),
    false,
  );
  assert.equal(
    Value.Check(WorkerReportInputSchema, {
      kind: "research",
      status: "completed",
      summary: "ok",
      evidence: [],
      findings: [],
      extra: true,
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
      worker: {
        workspaceId: "w",
        tabId: "tab",
        paneId: "pane",
        terminalId: "terminal",
        agentName: "agent",
        cwd: "/repo",
        sessionFile: "/worker.json",
      },
    }),
    false,
  );
  assert.throws(
    () => validateWorkstream({ ...workstream, tasks: [researchTask(workstream.id)] }),
    /globally distinct/,
  );
  const outcomeCollision = finish(add(), "Attempt A", reported());
  const collisionAttempt = outcomeCollision.tasks[0]?.attempts[0];
  assert.ok(collisionAttempt?.outcome);
  collisionAttempt.outcome.id = outcomeCollision.id;
  assert.throws(() => validateWorkstream(outcomeCollision), /globally distinct/);
  assert.equal(
    Value.Check(ApplicationSchema, {
      state: "pending",
      commit: changedCommit,
      expectedHead: baseCommit,
      rootCommit: baseCommit,
      commits: [commit("d"), changedCommit],
    }),
    true,
  );
});

void test("launch checkpoints enforce ordered single-stage execution mutations", () => {
  const key = { taskId: "Task opaque", attemptId: "Attempt A" };
  const placement = { kind: "isolated_worktree" as const, path: "/repo-work", branch: "branch" };
  const pane = { phase: "pane" as const, workspaceId: "workspace", paneId: "pane" };
  const resource = resourceForTest();
  const ready = { ...resource, phase: "ready" as const };
  assert.equal(Value.Check(LaunchCheckpointSchema, pane), true);

  const initialized = activateAttempt(add(), key, "t1", {
    placement,
    submission: "not_sent",
  });
  assert.equal(initialized.tasks[0]?.attempts[0]?.execution?.submission, "not_sent");
  assert.throws(
    () => activateAttempt(add(), key, "t1", { placement, sessionFile: "/worker.json" }),
    /exactly one new external-effect stage/,
  );
  assert.throws(
    () =>
      recordWorkerExecution(
        activateAttempt(add(), key, "t1"),
        key,
        { placement, submission: "not_sent" },
        "t2",
      ),
    /exactly one new external-effect stage/,
  );

  let workstream = recordWorkerExecution(initialized, key, { placement }, "t2");
  assert.throws(
    () =>
      recordWorkerExecution(workstream, key, { sessionFile: "/worker.json", launch: pane }, "t3"),
    /exactly one new external-effect stage/,
  );
  workstream = recordWorkerExecution(workstream, key, { sessionFile: "/worker.json" }, "t3");
  assert.throws(
    () => recordWorkerExecution(workstream, key, { launch: resource }, "t4"),
    /skip pane/,
  );
  workstream = recordWorkerExecution(workstream, key, { launch: pane }, "t4");
  workstream = recordWorkerExecution(workstream, key, { launch: resource }, "t5");
  workstream = recordWorkerExecution(workstream, key, { launch: ready }, "t6");
  assert.strictEqual(
    recordWorkerExecution(workstream, key, { launch: ready }, "replay"),
    workstream,
  );
  assert.throws(
    () => recordWorkerExecution(workstream, key, { launch: { ...ready, paneId: "other" } }, "t7"),
    /progression/,
  );
  assert.throws(
    () => recordWorkerExecution(workstream, key, { sessionFile: "/other.json" }, "t8"),
    /session file is immutable/,
  );
  const beforeReady = activateAttempt(add(), key, "before-ready", {
    placement,
    submission: "not_sent",
  });
  assert.throws(
    () => recordWorkerExecution(beforeReady, key, { submission: "uncertain" }, "t9"),
    /ready launch/,
  );
  workstream = recordWorkerExecution(workstream, key, { submission: "uncertain" }, "t10");
  assert.throws(
    () =>
      recordWorkerExecution(
        workstream,
        key,
        {
          steering: { text: "Stop", state: "uncertain", observedAt: "t11" },
          cancellation: { requestedAt: "t11", reason: "Stop" },
        },
        "t11",
      ),
    /exactly one new external-effect stage/,
  );
});

void test("pane to resource launch rejects workspace or pane identity mismatch", () => {
  const key = { taskId: "Task opaque", attemptId: "Attempt A" };
  const workstream = isolatedPaneLaunch(key);
  for (const identity of [{ workspaceId: "other" }, { paneId: "other" }])
    assert.throws(
      () =>
        recordWorkerExecution(
          workstream,
          key,
          { launch: { ...resourceForTest(), ...identity } },
          "t5",
        ),
      /launch resource does not match its pane/,
    );
});

void test("non-pane launch rejects cwd that does not match placement", () => {
  const key = { taskId: "Task opaque", attemptId: "Attempt A" };
  const workstream = isolatedPaneLaunch(key);
  assert.throws(
    () =>
      recordWorkerExecution(
        workstream,
        key,
        { launch: { ...resourceForTest(), cwd: "/other" } },
        "t5",
      ),
    /launch cwd does not match its placement/,
  );
});

void test("launch advancement cannot be combined with sent submission", () => {
  const key = { taskId: "Task opaque", attemptId: "Attempt A" };
  const workstream = isolatedPaneLaunch(key);
  assert.throws(
    () =>
      recordWorkerExecution(
        workstream,
        key,
        { launch: resourceForTest(), submission: "started" },
        "t5",
      ),
    /exactly one new external-effect stage/,
  );
});

void test("partial isolated launches preserve output until exact cleanup and release", () => {
  type Execution = NonNullable<Parameters<typeof activateAttempt>[3]>;
  const partials: Array<{ name: string; execution: Execution }> = [
    {
      name: "placement",
      execution: {
        placement: { kind: "isolated_worktree", path: "/repo-work", branch: "branch" },
      },
    },
    {
      name: "session",
      execution: {
        placement: { kind: "isolated_worktree", path: "/repo-work", branch: "branch" },
        sessionFile: "/worker.json",
      },
    },
    {
      name: "pane",
      execution: {
        placement: { kind: "isolated_worktree", path: "/repo-work", branch: "branch" },
        sessionFile: "/worker.json",
        launch: { phase: "pane", workspaceId: "workspace", paneId: "pane" },
      },
    },
    {
      name: "resource",
      execution: {
        placement: { kind: "isolated_worktree", path: "/repo-work", branch: "branch" },
        sessionFile: "/worker.json",
        launch: resourceForTest(),
      },
    },
  ];
  for (const [index, partial] of partials.entries()) {
    const key = { taskId: "Task opaque", attemptId: "Attempt A" };
    let workstream = finish(add(), key.attemptId, cancelled(), key.taskId, partial.execution);
    workstream = deliver(workstream, key.attemptId, key.taskId);
    let task = findTask(workstream, key.taskId);
    assert.ok(task);
    let attemptValue = findAttempt(task, key.attemptId);
    assert.ok(attemptValue);
    assert.equal(outputDisposition(task, attemptValue).kind, "preserve_checkout");
    assert.notDeepEqual(deriveCompletionAccounting(workstream), []);
    assert.throws(
      () =>
        checkpointOutputRelease(
          workstream,
          key,
          { state: "completed", expectedHead: changedCommit, reason: "Too early." },
          `early-release-${index}`,
        ),
      /closed isolated ownership/,
    );
    workstream = checkpointCleanup(
      workstream,
      key,
      { state: "completed", workerClosed: true, expectedHead: changedCommit },
      `cleanup-${index}`,
    );
    task = findTask(workstream, key.taskId);
    assert.ok(task);
    attemptValue = findAttempt(task, key.attemptId);
    assert.ok(attemptValue);
    assert.equal(outputDisposition(task, attemptValue).kind, "preserve_checkout");
    workstream = checkpointOutputRelease(
      workstream,
      key,
      { state: "completed", expectedHead: changedCommit, reason: "Release partial output." },
      `release-${index}`,
    );
    task = findTask(workstream, key.taskId);
    assert.ok(task);
    attemptValue = findAttempt(task, key.attemptId);
    assert.ok(attemptValue);
    assert.equal(outputDisposition(task, attemptValue).kind, "released");
    assert.deepEqual(deriveCompletionAccounting(workstream), []);
    workstream = completeWorkstream(
      workstream,
      {
        conclusion: "Partial launch settled.",
        evidence: [{ label: "cleanup", observation: partial.name }],
        limitations: [],
        completedAt: `complete-${index}`,
      },
      `complete-${index}`,
    );
    assert.deepEqual(workstream.completion?.accounting, []);
  }
});

void test("partial changed implementation release clears accounting without candidate ancestry", () => {
  const key = { taskId: "Parent Task", attemptId: "Parent Attempt" };
  const parentAttempt = attempt(key.attemptId, {
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
    id: key.taskId,
    objective: "Implement.",
    intentIndex: 0,
    createdAt: "t0",
    acceptance: ["It works."],
    attempts: [parentAttempt],
  };
  const partialExecution = {
    placement: { kind: "isolated_worktree" as const, path: "/repo-work", branch: "branch" },
    sessionFile: "/worker.json",
    launch: resourceForTest(),
  };
  let workstream = finish(
    createTask(base(), parentTask, "t1"),
    key.attemptId,
    reported("implementation"),
    key.taskId,
    partialExecution,
  );
  workstream = deliver(workstream, key.attemptId, key.taskId);
  workstream = checkpointCleanup(
    workstream,
    key,
    { state: "completed", workerClosed: true, expectedHead: changedCommit },
    "t5",
  );
  const childTask = (taskId: string, attemptId: string): Task => ({
    kind: "implementation",
    id: taskId,
    objective: "Continue.",
    intentIndex: 1,
    createdAt: "t6",
    acceptance: ["It works."],
    attempts: [
      attempt(attemptId, {
        baseRevision: changedCommit,
        candidate: {
          kind: "correction",
          rootCommit: baseCommit,
          parentAttemptId: key.attemptId,
          parentCommit: changedCommit,
        },
        selection: {
          role: "implementation",
          guide: { model: "provider/guide", thinking: "low" },
          executor: { model: "provider/executor", thinking: "high" },
          source: "policy",
        },
      }),
    ],
  });
  workstream = reviseIntent(
    workstream,
    { ...intent, statement: "Continue.", recordedAt: "t6" },
    "t6",
  );
  assert.notDeepEqual(deriveCompletionAccounting(workstream), []);
  assert.throws(
    () => createTask(workstream, childTask("Before release", "Before release attempt"), "t7"),
    /eligible retained output/,
  );
  workstream = checkpointOutputRelease(
    workstream,
    key,
    { state: "completed", expectedHead: changedCommit, reason: "Release partial output." },
    "t8",
  );
  assert.deepEqual(deriveCompletionAccounting(workstream), []);
  const releasedTask = findTask(workstream, key.taskId);
  assert.ok(releasedTask);
  const releasedAttempt = findAttempt(releasedTask, key.attemptId);
  assert.ok(releasedAttempt);
  assert.equal(outputDisposition(releasedTask, releasedAttempt).kind, "released");
  assert.throws(
    () => createTask(workstream, childTask("After release", "After release attempt"), "t9"),
    /eligible retained output/,
  );
});

void test("partial shared launches settle after exact closure without output release", () => {
  type Execution = NonNullable<Parameters<typeof activateAttempt>[3]>;
  const partials: Execution[] = [
    { placement: { kind: "shared_project", path: "/repo" } },
    { placement: { kind: "shared_project", path: "/repo" }, sessionFile: "/worker.json" },
    {
      placement: { kind: "shared_project", path: "/repo" },
      sessionFile: "/worker.json",
      launch: { phase: "pane", workspaceId: "workspace", paneId: "pane" },
    },
    {
      placement: { kind: "shared_project", path: "/repo" },
      sessionFile: "/worker.json",
      launch: { ...resourceForTest(), cwd: "/repo" },
    },
  ];
  for (const [index, execution] of partials.entries()) {
    const key = { taskId: "Task opaque", attemptId: "Attempt A" };
    let workstream = deliver(
      finish(add(), key.attemptId, reported(), key.taskId, execution),
      key.attemptId,
    );
    assert.notDeepEqual(deriveCompletionAccounting(workstream), []);
    workstream = checkpointCleanup(
      workstream,
      key,
      { state: "completed", workerClosed: true },
      `shared-cleanup-${index}`,
    );
    assert.deepEqual(deriveCompletionAccounting(workstream), []);
    const task = findTask(workstream, key.taskId);
    assert.ok(task);
    const attemptValue = findAttempt(task, key.attemptId);
    assert.ok(attemptValue);
    assert.equal(attemptValue.outputRelease, undefined);
    assert.equal(outputDisposition(task, attemptValue).kind, "not_applicable");
  }
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
    sessionFile: "/worker.json",
    launch: {
      phase: "ready" as const,
      workspaceId: "workspace",
      tabId: "tab",
      paneId: "pane",
      terminalId: "terminal",
      agentName: "agent",
      cwd: "/repo",
    },
    submission: "not_sent" as const,
  };
  const key = { taskId: "Task opaque", attemptId: "Attempt A" };
  workstream = recordWorkerExecution(workstream, key, { placement: execution.placement }, "t3");
  const stagedTask = findTask(workstream, key.taskId);
  assert.ok(stagedTask);
  assert.equal(findAttempt(stagedTask, key.attemptId)?.execution?.launch, undefined);
  workstream = recordWorkerExecution(
    workstream,
    key,
    { sessionFile: execution.sessionFile },
    "t3a",
  );
  workstream = recordWorkerExecution(
    workstream,
    key,
    { launch: { phase: "pane", workspaceId: "workspace", paneId: "pane" } },
    "t3b",
  );
  workstream = recordWorkerExecution(
    workstream,
    key,
    { launch: { ...execution.launch, phase: "resource" as const } },
    "t3c",
  );
  workstream = recordWorkerExecution(workstream, key, { launch: execution.launch }, "t3d");
  workstream = recordWorkerExecution(workstream, key, { submission: "not_sent" }, "t3e");
  workstream = recordWorkerExecution(workstream, key, { submission: "uncertain" }, "t3f");
  workstream = recordWorkerExecution(workstream, key, { submission: "started" }, "t3g");
  assert.strictEqual(
    recordWorkerExecution(workstream, key, { submission: "started" }, "replay"),
    workstream,
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
        key,
        {
          launch: {
            ...execution.launch,
            paneId: "other",
          },
        },
        "t5",
      ),
    /progression/,
  );
  const uncertainSteering = {
    steering: { text: "Continue.", state: "uncertain" as const, observedAt: "t4a" },
  };
  workstream = recordWorkerExecution(workstream, key, uncertainSteering, "t4a");
  assert.strictEqual(
    recordWorkerExecution(workstream, key, uncertainSteering, "replay"),
    workstream,
  );
  assert.throws(
    () =>
      recordWorkerExecution(
        workstream,
        key,
        { steering: { text: "Stop.", state: "uncertain", observedAt: "t4b" } },
        "t4b",
      ),
    /cannot be overwritten/,
  );
  workstream = recordWorkerExecution(
    workstream,
    key,
    { steering: { text: "Continue.", state: "submitted", observedAt: "t4c" } },
    "t4c",
  );
  assert.throws(
    () =>
      recordWorkerExecution(
        workstream,
        key,
        { steering: { text: "Continue.", state: "uncertain", observedAt: "t4d" } },
        "t4d",
      ),
    /progression is not exact/,
  );
  workstream = recordWorkerExecution(
    workstream,
    key,
    { steering: { text: "Stop.", state: "uncertain", observedAt: "t4e" } },
    "t4e",
  );
  assert.throws(
    () => recordWorkerExecution(workstream, key, { submission: "not_sent" }, "t5a"),
    /monotonic/,
  );
  const conflictedTask = findTask(workstream, key.taskId);
  assert.ok(conflictedTask);
  assert.equal(findAttempt(conflictedTask, key.attemptId)?.execution?.submission, "started");
  workstream = requestCancellation(
    workstream,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { requestedAt: "t6", reason: "Stop." },
    "t6",
  );
  const updatedTask = findTask(workstream, "Task opaque");
  assert.ok(updatedTask);
  assert.equal(findAttempt(updatedTask, "Attempt A")?.execution?.cancellation?.reason, "Stop.");
  let late = activateAttempt(add(), { taskId: "Task opaque", attemptId: "Attempt A" }, "t7");
  late = recordWorkerExecution(
    late,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { placement: execution.placement },
    "t8",
  );
  late = requestCancellation(
    late,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { requestedAt: "t9", reason: "Stop before worker session." },
    "t9",
  );
  late = recordWorkerExecution(
    late,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { steering: { text: "Continue.", state: "uncertain", observedAt: "t9a" } },
    "t9a",
  );
  late = recordWorkerExecution(
    late,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { sessionFile: execution.sessionFile },
    "t10",
  );
  late = recordWorkerExecution(
    late,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { launch: { phase: "pane", workspaceId: "workspace", paneId: "pane" } },
    "t10a",
  );
  late = recordWorkerExecution(
    late,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { launch: { ...execution.launch, phase: "resource" as const } },
    "t10b",
  );
  late = recordWorkerExecution(
    late,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { launch: execution.launch },
    "t10c",
  );
  const lateTask = findTask(late, "Task opaque");
  assert.ok(lateTask);
  assert.equal(findAttempt(lateTask, "Attempt A")?.execution?.sessionFile, "/worker.json");
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

void test("isolated failed output remains blocked through cleanup until exact release, including after completion", () => {
  const execution = {
    placement: { kind: "isolated_worktree" as const, path: "/repo-work", branch: "branch" },
    sessionFile: "/worker.json",
    launch: {
      phase: "ready" as const,
      workspaceId: "w",
      tabId: "tab",
      paneId: "pane",
      terminalId: "term",
      agentName: "agent",
      cwd: "/repo-work",
    },
    submission: "started" as const,
  };
  let workstream = finish(
    add(),
    "Attempt A",
    {
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
    },
    "Task opaque",
    execution,
  );
  workstream = checkpointCleanup(
    workstream,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    {
      state: "blocked",
      workerClosed: true,
      expectedHead: changedCommit,
      error: "Checkout cleanup interrupted.",
    },
    "t4",
  );
  const isolatedTask = findTask(workstream, "Task opaque");
  assert.ok(isolatedTask);
  const isolatedAttempt = findAttempt(isolatedTask, "Attempt A");
  assert.ok(isolatedAttempt);
  assert.equal(outputDisposition(isolatedTask, isolatedAttempt).kind, "preserve_checkout");
  assert.notDeepEqual(deriveCompletionAccounting(workstream), []);
  workstream = completeWorkstream(
    workstream,
    {
      conclusion: "Stopped with retained output.",
      evidence: [{ label: "failure", observation: "retained" }],
      limitations: [],
      completedAt: "t5",
    },
    "t5",
  );
  assert.notDeepEqual(workstream.completion?.accounting, []);
  workstream = deliver(workstream, "Attempt A");
  assert.throws(
    () => appendAttempt(workstream, "Task opaque", attempt("Later"), "t6"),
    /completed/,
  );
  workstream = checkpointOutputRelease(
    workstream,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { state: "completed", expectedHead: changedCommit, reason: "Discard failed checkout." },
    "t6",
  );
  assert.notDeepEqual(deriveCompletionAccounting(workstream), []);
  workstream = checkpointCleanup(
    workstream,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { state: "completed", workerClosed: true, expectedHead: changedCommit },
    "t6a",
  );
  assert.deepEqual(deriveCompletionAccounting(workstream), []);
  assert.throws(
    () =>
      checkpointApplication(
        workstream,
        { taskId: "Task opaque", attemptId: "Attempt A" },
        {
          state: "pending",
          commit: changedCommit,
          expectedHead: changedCommit,
          rootCommit: baseCommit,
          commits: [commit("d"), changedCommit],
        },
        "t7",
      ),
    /no existing application obligation/,
  );
  let shared = deliver(finish(add(), "Attempt A", reported()), "Attempt A");
  shared = completeWorkstream(
    shared,
    {
      conclusion: "Shared settled.",
      evidence: [{ label: "done", observation: "done" }],
      limitations: [],
      completedAt: "t5",
    },
    "t5",
  );
  assert.throws(
    () =>
      checkpointCleanup(
        shared,
        { taskId: "Task opaque", attemptId: "Attempt A" },
        {
          state: "completed",
          workerClosed: true,
          expectedHead: baseCommit,
        },
        "t6",
      ),
    /no Worker placement/,
  );
});

void test("shared Worker closure and delivery gate reattempt and accounting", () => {
  const execution = {
    placement: { kind: "shared_project" as const, path: "/repo" },
    sessionFile: "/worker.json",
    launch: {
      phase: "ready" as const,
      workspaceId: "w",
      tabId: "tab",
      paneId: "pane",
      terminalId: "term",
      agentName: "agent",
      cwd: "/repo",
    },
    submission: "started" as const,
  };
  let workstream = finish(add(), "Attempt A", reported(), "Task opaque", execution);
  assert.notDeepEqual(deriveCompletionAccounting(workstream), []);
  assert.throws(
    () => appendAttempt(workstream, "Task opaque", attempt("Later"), "t3"),
    /operationally unstable/,
  );
  workstream = deliver(workstream, "Attempt A");
  assert.notDeepEqual(deriveCompletionAccounting(workstream), []);
  workstream = checkpointCleanup(
    workstream,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { state: "blocked", workerClosed: true, error: "Worker cleanup blocked." },
    "t5",
  );
  assert.notDeepEqual(deriveCompletionAccounting(workstream), []);
  assert.throws(
    () => appendAttempt(workstream, "Task opaque", attempt("Still blocked"), "t6"),
    /operationally unstable/,
  );
  workstream = completeWorkstream(
    workstream,
    {
      conclusion: "Shared worker is closed only after recovery.",
      evidence: [{ label: "cleanup", observation: "blocked" }],
      limitations: [],
      completedAt: "t7",
    },
    "t7",
  );
  workstream = checkpointCleanup(
    workstream,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { state: "completed", workerClosed: true },
    "t8",
  );
  assert.deepEqual(deriveCompletionAccounting(workstream), []);
});

void test("implementation candidate ancestry may cross Intents but application is exact and immutable", () => {
  const execution = {
    placement: { kind: "isolated_worktree" as const, path: "/repo-work", branch: "branch" },
    sessionFile: "/worker.json",
    launch: {
      phase: "ready" as const,
      workspaceId: "w",
      tabId: "tab",
      paneId: "pane",
      terminalId: "term",
      agentName: "agent",
      cwd: "/repo-work",
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
      commits: [commit("d"), changedCommit],
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
  const retained = reviseIntent(
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
  workstream = createTask(retained, childTask, "t6");
  assert.equal(findTask(workstream, "Child Task")?.intentIndex, 1);

  const released = checkpointOutputRelease(
    retained,
    { taskId: "Parent Task", attemptId: "Parent Attempt" },
    { state: "completed", expectedHead: changedCommit, reason: "Released." },
    "t6b",
  );
  assert.throws(
    () =>
      createTask(
        released,
        {
          ...childTask,
          id: "Released Child Task",
          attempts: [{ ...childAttempt, id: "Released Child Attempt" }],
        },
        "t7",
      ),
    /eligible retained output/,
  );
});
