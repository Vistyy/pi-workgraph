import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import {
  ApplicationSchema,
  type Attempt,
  AttemptSchema,
  activateAttempt,
  appendAttempts,
  CandidateLineageSchema,
  checkpointApplication,
  checkpointCancellation,
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
/** The one durable placement declaration activating a canonical Attempt. */
function declare(
  placement: NonNullable<NonNullable<Attempt["execution"]>["placement"]>,
): NonNullable<Parameters<typeof activateAttempt>[3]> {
  return { placement, submission: "not_sent" };
}
function recordLaunchProgress(
  workstream: ReturnType<typeof add>,
  key: { taskId: string; attemptId: string },
  execution: NonNullable<Parameters<typeof recordWorkerExecution>[2]>,
): ReturnType<typeof add> {
  let active = workstream;
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
  const placement = { kind: "isolated_worktree" as const, path: "/repo-work", branch: "branch" };
  return recordLaunchProgress(activateAttempt(add(), key, "t1", declare(placement)), key, {
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
  const placement = execution?.placement ?? { kind: "shared_project" as const, path: "/repo" };
  let active = activateAttempt(workstream, key, "t1", declare(placement));
  if (execution !== undefined) active = recordLaunchProgress(active, key, execution);
  if (execution?.submission !== undefined && execution.submission !== "not_sent") {
    active = recordWorkerExecution(active, key, { submission: "uncertain" }, "t1g");
    if (execution.submission !== "uncertain")
      active = recordWorkerExecution(active, key, { submission: execution.submission }, "t1h");
  }
  // An active cancelled settlement is gated on the full interrupt protocol plus
  // durably proven Worker closure, so the fixture satisfies it before settling.
  if (observation.kind === "cancelled") {
    const requested = {
      state: "requested" as const,
      requestedAt: "t1i",
      reason: observation.reason,
    };
    active = checkpointCancellation(active, key, requested, "t1i");
    active = checkpointCancellation(
      active,
      key,
      { ...requested, state: "uncertain", dispatchAt: "t1j" },
      "t1j",
    );
    active = checkpointCancellation(
      active,
      key,
      {
        ...requested,
        state: "submitted_or_observed",
        dispatchAt: "t1j",
        observedAt: "t1k",
        evidence: "done",
      },
      "t1k",
    );
    active = checkpointCleanup(active, key, { state: "pending", workerClosed: true }, "t1l");
  }
  active = terminalizeAttempt(active, key, observation, "t2");
  // A default shared placement has no isolated output, so its only remaining
  // operational obligation is exact Worker closure.
  return execution === undefined
    ? checkpointCleanup(active, key, { state: "completed", workerClosed: true }, "t2a")
    : active;
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
    /activation requires only exact placement/,
  );
  assert.throws(
    // The declaration is the activation boundary; later stages are still
    // recorded exactly one at a time.
    () =>
      recordWorkerExecution(
        activateAttempt(add(), key, "t1", declare(placement)),
        key,
        { sessionFile: "/worker.json", launch: pane },
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
          launch: { phase: "pane", workspaceId: "workspace", paneId: "late" },
          steering: { text: "Stop", state: "uncertain", observedAt: "t11" },
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
  const key = { taskId: "Task opaque", attemptId: "Attempt A" };
  let workstream = activateAttempt(
    add(),
    key,
    "t2",
    declare({ kind: "shared_project", path: "/repo" }),
  );
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
  workstream = checkpointCancellation(
    workstream,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { state: "requested", requestedAt: "t6", reason: "Stop." },
    "t6",
  );
  const updatedTask = findTask(workstream, "Task opaque");
  assert.ok(updatedTask);
  assert.equal(findAttempt(updatedTask, "Attempt A")?.execution?.cancellation?.reason, "Stop.");
  let late = activateAttempt(
    add(),
    { taskId: "Task opaque", attemptId: "Attempt A" },
    "t7",
    declare({ kind: "shared_project", path: "/repo" }),
  );
  late = recordWorkerExecution(
    late,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { placement: execution.placement },
    "t8",
  );
  late = checkpointCancellation(
    late,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { state: "requested", requestedAt: "t9", reason: "Stop before worker session." },
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
  fanout = appendAttempts(fanout, "Task opaque", [attempt("Sibling")], "t5");
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

void test("appendAttempts is one atomic nonempty batch that preserves order and validates the result", () => {
  const stable = deliver(finish(add(), "Attempt A", reported()), "Attempt A");
  const batch = appendAttempts(
    stable,
    "Task opaque",
    [attempt("Attempt B"), attempt("Attempt C"), attempt("Attempt D")],
    "t5",
  );
  assert.deepEqual(
    findTask(batch, "Task opaque")?.attempts.map((item) => item.id),
    ["Attempt A", "Attempt B", "Attempt C", "Attempt D"],
  );
  assert.equal(batch.revision, stable.revision + 1);
  validateWorkstream(batch);

  assert.throws(() => appendAttempts(stable, "Task opaque", [], "t5"), /at least one new Attempt/);
  assert.throws(
    () =>
      appendAttempts(stable, "Task opaque", [{ ...attempt("Attempt B"), state: "active" }], "t5"),
    /pristine and queued/,
  );
  assert.throws(
    () =>
      appendAttempts(
        stable,
        "Task opaque",
        [
          attempt("Attempt B", {
            selection: {
              role: "review",
              target: { model: "provider/review", thinking: "low" },
              source: "policy",
            },
          }),
        ],
        "t5",
      ),
    /does not match Task kind/,
  );
  assert.throws(
    () => appendAttempts(stable, "Unknown", [attempt("Attempt B")], "t5"),
    /Unknown Task/,
  );

  // An unstable pre-existing Attempt rejects the whole batch without a partial append.
  const unstable = finish(add(), "Attempt A", reported());
  assert.throws(
    () =>
      appendAttempts(unstable, "Task opaque", [attempt("Attempt B"), attempt("Attempt C")], "t5"),
    /operationally unstable/,
  );
  assert.equal(findTask(unstable, "Task opaque")?.attempts.length, 1);
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
    () => appendAttempts(workstream, "Task opaque", [attempt("Later")], "t6"),
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
  // A shared placement is settled by exact Worker closure; once cleanup is
  // completed it cannot be replayed with different identity.
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
    /not monotonic/,
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
    () => appendAttempts(workstream, "Task opaque", [attempt("Later")], "t3"),
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
    () => appendAttempts(workstream, "Task opaque", [attempt("Still blocked")], "t6"),
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

void test("activation declares durable placement before any external effect", () => {
  const key = { taskId: "Task opaque", attemptId: "Attempt A" };
  const placement = { kind: "isolated_worktree" as const, path: "/repo-work", branch: "branch" };

  // The declaration is placement plus the initial not-sent submission checkpoint.
  const declared = activateAttempt(add(), key, "t1", declare(placement));
  assert.deepEqual(declared.tasks[0]?.attempts[0]?.execution, {
    placement,
    submission: "not_sent",
  });

  // A missing placement or a pre-progressed submission can never begin activation.
  assert.throws(
    () => activateAttempt(add(), key, "t1", { submission: "not_sent" }),
    /exact placement and not-sent submission/,
  );
  assert.throws(
    () => activateAttempt(add(), key, "t1", { placement, submission: "uncertain" }),
    /exact placement and not-sent submission/,
  );
  assert.throws(
    () =>
      activateAttempt(add(), key, "t1", {
        placement,
        submission: "not_sent",
        sessionFile: "/worker.json",
      }),
    /exact placement and not-sent submission/,
  );

  // Aggregate validation rejects a persisted active Attempt that lacks its
  // declaration; the durable placement is the invariant, not proof a worktree exists.
  const undeclared = structuredClone(declared);
  const undeclaredAttempt = undeclared.tasks[0]?.attempts[0];
  assert.ok(undeclaredAttempt?.execution);
  Reflect.deleteProperty(undeclaredAttempt, "execution");
  assert.throws(() => validateWorkstream(undeclared), /exact placement declaration/);

  const progressed = recordWorkerExecution(declared, key, { sessionFile: "/worker.json" }, "t2");
  const progressedActive = progressed.tasks[0]?.attempts[0]?.execution;
  assert.ok(progressedActive);
  Reflect.deleteProperty(progressedActive, "submission");
  assert.throws(() => validateWorkstream(progressed), /not-sent submission checkpoint/);
});

void test("cancellation is one monotonic interrupt protocol with exact evidence", () => {
  const key = { taskId: "Task opaque", attemptId: "Attempt A" };
  const placement = { kind: "shared_project" as const, path: "/repo" };
  const active = activateAttempt(add(), key, "t1", declare(placement));
  const requested = { state: "requested" as const, requestedAt: "t2", reason: "Stop." };
  const uncertain = { ...requested, state: "uncertain" as const, dispatchAt: "t3" };
  const observed = {
    ...uncertain,
    state: "submitted_or_observed" as const,
    observedAt: "t4",
    evidence: "done" as const,
  };

  let workstream = checkpointCancellation(active, key, requested, "t2");
  assert.equal(workstream.tasks[0]?.attempts[0]?.execution?.cancellation?.state, "requested");
  // Exact replay is a structural no-op; the request identity and reason persist.
  assert.strictEqual(checkpointCancellation(workstream, key, requested, "t2b"), workstream);
  // No skip and no backward move.
  assert.throws(() => checkpointCancellation(workstream, key, observed, "t2c"), /not monotonic/);
  // A different request identity cannot overwrite the durable request.
  assert.throws(
    () =>
      checkpointCancellation(
        workstream,
        key,
        { state: "uncertain", requestedAt: "t9", reason: "Other.", dispatchAt: "t3" },
        "t2e",
      ),
    /not monotonic/,
  );
  workstream = checkpointCancellation(workstream, key, uncertain, "t3");
  assert.equal(workstream.tasks[0]?.attempts[0]?.execution?.cancellation?.state, "uncertain");
  assert.throws(
    () => checkpointCancellation(workstream, key, { ...uncertain, dispatchAt: "t9" }, "t3b"),
    /not monotonic/,
  );
  workstream = checkpointCancellation(workstream, key, observed, "t4");
  const terminal = workstream.tasks[0]?.attempts[0]?.execution?.cancellation;
  assert.deepEqual(terminal, observed);
  assert.strictEqual(checkpointCancellation(workstream, key, observed, "t4b"), workstream);
  // A terminal checkpoint cannot be rewritten or moved backward.
  assert.throws(() => checkpointCancellation(workstream, key, uncertain, "t5"), /not monotonic/);

  // An active cancelled settlement needs both observed cancellation and durable
  // closure; while active, cleanup may only be the cancellation path's start.
  const pending = { state: "pending" as const, workerClosed: true };
  assert.throws(() => terminalizeAttempt(active, key, cancelled(), "t5"), /submitted-or-observed/);
  assert.throws(
    () => terminalizeAttempt(workstream, key, cancelled(), "t5"),
    /durable Worker closure/,
  );
  assert.throws(() => checkpointCleanup(active, key, pending, "t5"), /observed cancellation/);
  assert.throws(
    () => checkpointCleanup(workstream, key, { state: "completed", workerClosed: true }, "t5"),
    /only begin pending/,
  );
  // The fully proven path settles cancelled, then ordinary cleanup resumes.
  const closed = checkpointCleanup(workstream, key, pending, "t6");
  const settled = terminalizeAttempt(closed, key, cancelled(), "t7");
  assert.equal(settled.tasks[0]?.attempts[0]?.state, "finished");
  assert.equal(settled.tasks[0]?.attempts[0]?.outcome?.kind, "cancelled");
  const completed = checkpointCleanup(
    settled,
    key,
    { state: "completed", workerClosed: true, expectedHead: changedCommit },
    "t8",
  );
  assert.equal(completed.tasks[0]?.attempts[0]?.cleanup?.state, "completed");
  // A queued pristine Attempt settles cancelled without any Worker facts.
  assert.equal(
    terminalizeAttempt(add(), key, cancelled(), "t9").tasks[0]?.attempts[0]?.state,
    "finished",
  );
});

void test("persisted read validation mirrors cancellation settlement and completion lifecycle", () => {
  const key = { taskId: "Task opaque", attemptId: "Attempt A" };
  const placement = { kind: "shared_project" as const, path: "/repo" };
  const requested = { state: "requested" as const, requestedAt: "t2", reason: "Stop." };
  const uncertain = { ...requested, state: "uncertain" as const, dispatchAt: "t3" };
  const observed = {
    ...uncertain,
    state: "submitted_or_observed" as const,
    observedAt: "t4",
    evidence: "done" as const,
  };
  let active = checkpointCancellation(
    activateAttempt(add(), key, "t1", declare(placement)),
    key,
    requested,
    "t2",
  );
  active = checkpointCancellation(active, key, uncertain, "t3");
  active = checkpointCancellation(active, key, observed, "t4");

  // A pending active cancellation cleanup and a pristine queued cancellation
  // settlement are both valid persisted states.
  const pendingCleanup = checkpointCleanup(
    active,
    key,
    { state: "pending", workerClosed: true },
    "t5",
  );
  assert.doesNotThrow(() => validateWorkstream(pendingCleanup));
  assert.doesNotThrow(() => validateWorkstream(terminalizeAttempt(add(), key, cancelled(), "t5")));

  // Active completed or blocked cleanup is rejected on read exactly as the
  // transition boundary rejects it.
  const completedCleanup = structuredClone(active);
  const completedAttempt = completedCleanup.tasks[0]?.attempts[0];
  assert.ok(completedAttempt);
  completedAttempt.cleanup = { state: "completed", workerClosed: true };
  assert.throws(() => validateWorkstream(completedCleanup), /active cleanup may only be pending/);
  const blockedCleanup = structuredClone(active);
  const blockedAttempt = blockedCleanup.tasks[0]?.attempts[0];
  assert.ok(blockedAttempt);
  blockedAttempt.cleanup = { state: "blocked", workerClosed: false, error: "Cleanup blocked." };
  assert.throws(() => validateWorkstream(blockedCleanup), /active cleanup may only be pending/);

  // A finished cancelled Worker settlement keeps its exact interruption proof and
  // durable Worker closure on read.
  const settled = terminalizeAttempt(pendingCleanup, key, cancelled(), "t6");
  assert.doesNotThrow(() => validateWorkstream(settled));
  const withoutCancellation = structuredClone(settled);
  const uncancelledAttempt = withoutCancellation.tasks[0]?.attempts[0];
  assert.ok(uncancelledAttempt?.execution);
  Reflect.deleteProperty(uncancelledAttempt.execution, "cancellation");
  assert.throws(() => validateWorkstream(withoutCancellation), /submitted-or-observed/);
  const reopenedWorker = structuredClone(settled);
  const reopenedAttempt = reopenedWorker.tasks[0]?.attempts[0];
  assert.ok(reopenedAttempt?.cleanup);
  reopenedAttempt.cleanup.workerClosed = false;
  assert.throws(() => validateWorkstream(reopenedWorker), /durable Worker closure/);

  // A completed Workstream cannot retain an unfinished Attempt on read.
  const complete = completeWorkstream(
    deliver(finish(add(), key.attemptId, reported()), key.attemptId),
    {
      conclusion: "Complete.",
      evidence: [{ label: "completion", observation: "The Workstream completed." }],
      limitations: [],
      completedAt: "t6",
    },
    "t6",
  );
  const stillWorking = structuredClone(complete);
  const task = stillWorking.tasks[0];
  assert.ok(task);
  task.attempts.push(attempt("Attempt B"));
  assert.throws(() => validateWorkstream(stillWorking), /unfinished Attempt/);
});

void test("delivery attempt counts are exact against failure history", () => {
  const key = { taskId: "Task opaque", attemptId: "Attempt A" };
  let workstream = finish(add(), key.attemptId, reported());
  workstream = deliver(workstream, key.attemptId);
  const delivered = workstream.tasks[0]?.attempts[0]?.outcome?.delivery;
  assert.equal(delivered?.state, "delivered");
  assert.equal(delivered?.attemptCount, 1);
  assert.equal(delivered?.failureHistory.length, 0);

  // Pending counts equal its failures; delivered counts equal failures + 1.
  const pending = finish(add(), key.attemptId, reported());
  const corrupted = structuredClone(pending);
  const corruptedDelivery = corrupted.tasks[0]?.attempts[0]?.outcome?.delivery;
  assert.ok(corruptedDelivery);
  corruptedDelivery.attemptCount = 1;
  assert.throws(() => validateWorkstream(corrupted), /attempt count is not exact/);
  let failed = recordDeliveryFailure(pending, key, { at: "t3", detail: "Retry." }, "t3");
  failed = recordDeliveryFailure(failed, key, { at: "t4", detail: "Retry again." }, "t4");
  const failedDelivery = failed.tasks[0]?.attempts[0]?.outcome?.delivery;
  assert.equal(failedDelivery?.attemptCount, 2);
  assert.equal(failedDelivery?.failureHistory.length, 2);
  const accepted = recordDeliverySuccess(failed, key, "t5", "t5");
  const acceptedDelivery = accepted.tasks[0]?.attempts[0]?.outcome?.delivery;
  assert.equal(acceptedDelivery?.attemptCount, 3);
  assert.equal(acceptedDelivery?.failureHistory.length, 2);
});
