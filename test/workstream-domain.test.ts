import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { EvidenceSchema, WorkerReportSchema } from "../src/domain/report.js";
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
  checkpointOutputDisposition,
  completeWorkstream,
  createTask,
  createWorkstream,
  deriveCompletionAccounting,
  findAttempt,
  findTask,
  HandoffGrantSchema,
  type Intent,
  IntentSchema,
  isOperationallyStable,
  LaunchCheckpointSchema,
  outputDisposition,
  recordDeliveryFailure,
  recordDeliverySuccess,
  recordEffectiveModel,
  recordWorkerExecution,
  resumeWorkstream,
  reviseIntent,
  suspendWorkstream,
  type Task,
  TaskSchema,
  type TerminalObservation,
  terminalizeAttempt,
  validateWorkstream,
  WorkerExecutionSchema,
  WorkstreamSchema,
} from "../src/domain/workstream.js";
import { workerAssignment, workerSessionMode } from "../src/worker-context.js";

const repository = { projectRoot: "/repo", gitCommonDir: "/repo/.git" };
const coordinator = { sessionId: "session", sessionFile: "/session.json" };
const receipt = {
  kind: "human_input_receipt" as const,
  id: "receipt opaque",
  sessionId: "session",
  sessionFile: "/session.json",
  source: "interactive" as const,
  text: "Investigate the change.",
  receivedAt: "2026-01-01T00:00:00.000Z",
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
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
    createdAt: "2026-01-01T00:00:00.000Z",
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
      observedAt: "2026-01-01T00:00:02.000Z",
      artifacts: [],
      deliveryRequestedAt: "2026-01-01T00:00:03.000Z",
      report: {
        kind,
        status: "completed",
        outcome: "changed",
        commit: changedCommit,
        changedFiles: ["change.txt"],
        summary: "Changed.",
        evidence: [],
        findings: [],
      },
    };
  return {
    kind: "reported",
    observedAt: "2026-01-01T00:00:02.000Z",
    artifacts: [],
    deliveryRequestedAt: "2026-01-01T00:00:03.000Z",
    report: { kind, status: "completed", summary: "Reported.", evidence: [], findings: [] },
  };
}
function cancelled(): TerminalObservation {
  return {
    kind: "cancelled",
    observedAt: "2026-01-01T00:00:02.000Z",
    artifacts: [],
    deliveryRequestedAt: "2026-01-01T00:00:03.000Z",
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
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}
function add(workstream = base(), task = researchTask("Task opaque")) {
  return createTask(workstream, task, "2026-01-01T00:00:01.000Z");
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
/** The one durable placement declaration activating a workstream Attempt. */
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
    active = recordWorkerExecution(
      active,
      key,
      { sessionFile: execution.sessionFile },
      "2026-01-01T00:00:01.002Z",
    );
  if (execution.launch !== undefined) {
    const pane = {
      phase: "pane" as const,
      workspaceId: execution.launch.workspaceId,
      paneId: execution.launch.paneId,
    };
    active = recordWorkerExecution(active, key, { launch: pane }, "2026-01-01T00:00:01.003Z");
    if (execution.launch.phase !== "pane") {
      const resource = { ...execution.launch, phase: "resource" as const };
      active = recordWorkerExecution(active, key, { launch: resource }, "2026-01-01T00:00:01.004Z");
      if (execution.launch.phase === "ready")
        active = recordWorkerExecution(
          active,
          key,
          { launch: execution.launch },
          "2026-01-01T00:00:01.005Z",
        );
    }
  }
  return active;
}
function isolatedPaneLaunch(key: { taskId: string; attemptId: string }): ReturnType<typeof add> {
  const placement = { kind: "isolated_worktree" as const, path: "/repo-work", branch: "branch" };
  return recordLaunchProgress(
    activateAttempt(add(), key, "2026-01-01T00:00:01.000Z", declare(placement)),
    key,
    {
      sessionFile: "/worker.json",
      launch: { phase: "pane", workspaceId: "workspace", paneId: "pane" },
    },
  );
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
  let active = activateAttempt(workstream, key, "2026-01-01T00:00:01.000Z", declare(placement));
  if (execution !== undefined) active = recordLaunchProgress(active, key, execution);
  if (execution?.submission !== undefined && execution.submission !== "not_sent") {
    active = recordWorkerExecution(
      active,
      key,
      { submission: "uncertain" },
      "2026-01-01T00:00:01.007Z",
    );
    if (execution.submission !== "uncertain")
      active = recordWorkerExecution(
        active,
        key,
        { submission: execution.submission },
        "2026-01-01T00:00:01.008Z",
      );
  }
  // An active cancelled settlement is gated on verified termination plus
  // durably proven Worker closure, so the fixture satisfies it before settling.
  if (observation.kind === "cancelled") {
    const requested = {
      state: "requested" as const,
      requestedAt: "2026-01-01T00:00:01.009Z",
      reason: observation.reason,
    };
    active = checkpointCancellation(active, key, requested, "2026-01-01T00:00:01.009Z");
    active = checkpointCancellation(
      active,
      key,
      { ...requested, state: "uncertain", dispatchAt: "2026-01-01T00:00:01.010Z" },
      "2026-01-01T00:00:01.010Z",
    );
    active = checkpointCancellation(
      active,
      key,
      {
        ...requested,
        state: "terminated",
        dispatchAt: "2026-01-01T00:00:01.010Z",
        terminatedAt: "2026-01-01T00:00:01.011Z",
      },
      "2026-01-01T00:00:01.011Z",
    );
    active = checkpointCleanup(
      active,
      key,
      { state: "pending", workerClosed: true },
      "2026-01-01T00:00:01.012Z",
    );
  }
  active = terminalizeAttempt(active, key, observation, "2026-01-01T00:00:02.000Z");
  // A default shared placement has no isolated output, so its only remaining
  // operational obligation is exact Worker closure.
  return execution === undefined
    ? checkpointCleanup(
        active,
        key,
        { state: "completed", workerClosed: true },
        "2026-01-01T00:00:02.001Z",
      )
    : active;
}
function deliver(workstream: ReturnType<typeof add>, id: string, taskId = "Task opaque") {
  return recordDeliverySuccess(
    workstream,
    { taskId, attemptId: id },
    "2026-01-01T00:00:04.000Z",
    "2026-01-01T00:00:04.000Z",
  );
}

void test("consultation is a presentation role over the research session contract", () => {
  const task = {
    kind: "consultation" as const,
    id: "consultation-task",
    objective: "Advise on ownership.",
    intentIndex: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    context: "Known context.",
  };
  const assignment = workerAssignment({
    task,
    intent,
    intentIndex: 0,
    repositoryRoot: repository.projectRoot,
    workerCwd: repository.projectRoot,
    runId: "workstream",
    attemptId: "attempt",
  });
  assert.equal(workerSessionMode(task), "research");
  assert.equal(assignment.mode, "research");
  assert.equal(assignment.role, "consultation");
  const { PI_WORKGRAPH_MODE: mode, PI_WORKGRAPH_POLICY_ROLE: policyRole } = assignment.environment;
  assert.equal(mode, "research");
  assert.equal(policyRole, "consultation");
  assert.match(assignment.objective, /Coordinator-known context: Known context/);
});

void test("suspension is an exact lifecycle fact with active-only creation and resumption", () => {
  const active = add();
  const suspendedAt = "2026-01-02T03:04:05.000Z";
  const suspended = suspendWorkstream(
    active,
    { reason: "Await coordinator decision.", suspendedAt },
    suspendedAt,
  );
  assert.equal(suspended.lifecycle, "suspended");
  assert.deepEqual(suspended.suspension, {
    reason: "Await coordinator decision.",
    suspendedAt,
  });
  assert.equal(suspended.revision, active.revision + 1);
  assert.equal(suspended.updatedAt, suspendedAt);
  assert.deepEqual(suspended.tasks, active.tasks);
  assert.deepEqual(suspended.intents, active.intents);
  assert.throws(
    () =>
      suspendWorkstream(suspended, suspended.suspension ?? assert.fail("suspension"), suspendedAt),
    /active/,
  );
  assert.throws(() => createTask(suspended, researchTask("later"), suspendedAt), /active/);
  assert.throws(
    () =>
      completeWorkstream(
        suspended,
        {
          conclusion: "Not while suspended.",
          evidence: [{ label: "state", observation: "Suspended." }],
          limitations: [],
          completedAt: suspendedAt,
        },
        suspendedAt,
      ),
    /active/,
  );
  const key = { taskId: "Task opaque", attemptId: "Attempt A" };
  const running = activateAttempt(
    active,
    key,
    suspendedAt,
    declare({ kind: "shared_project", path: "/repo" }),
  );
  const suspendedRunning = suspendWorkstream(
    running,
    { reason: "Keep settling.", suspendedAt },
    suspendedAt,
  );
  const settled = terminalizeAttempt(suspendedRunning, key, reported(), suspendedAt);
  assert.equal(
    findAttempt(findTask(settled, key.taskId) ?? assert.fail("task"), key.attemptId)?.state,
    "finished",
  );
  assert.throws(
    () => validateWorkstream(suspendWorkstream(active, { reason: " ", suspendedAt }, suspendedAt)),
    /reason/,
  );
  assert.throws(
    () =>
      validateWorkstream(
        suspendWorkstream(
          active,
          { reason: "Wait.", suspendedAt: "2026-02-30T03:04:05.000Z" },
          suspendedAt,
        ),
      ),
    /suspendedAt|workstream UTC instant/,
  );
  assert.throws(
    () => validateWorkstream({ ...structuredClone(active), lifecycle: "suspended" }),
    /Suspension/,
  );
  assert.throws(
    () =>
      validateWorkstream({
        ...structuredClone(active),
        suspension: { reason: "Wait.", suspendedAt },
      }),
    /Suspension/,
  );

  const resumedAt = "2026-01-02T04:00:00.000Z";
  const resumed = resumeWorkstream(suspended, resumedAt);
  assert.equal(resumed.lifecycle, "active");
  assert.equal(resumed.suspension, undefined);
  assert.equal(resumed.revision, suspended.revision + 1);
  assert.equal(resumed.updatedAt, resumedAt);
  assert.deepEqual(resumed.tasks, active.tasks);
  assert.throws(() => resumeWorkstream(resumed, resumedAt), /not suspended/);
});

void test("pure aggregate schemas are strict and identifiers are opaque", () => {
  const workstream = base();
  assert.equal(Value.Check(WorkstreamSchema, workstream), true);
  assert.equal(Value.Check(AttemptSchema, { ...attempt("UPPER / arbitrary") }), true);
  assert.equal(Value.Check(WorkstreamSchema, { ...workstream, id: "" }), false);
  assert.equal(
    Value.Check(WorkstreamSchema, {
      ...workstream,
      updatedAt: "2026-02-30T00:00:00.000Z",
    }),
    false,
  );
  assert.equal(
    Value.Check(IntentSchema, {
      ...intent,
      recordedAt: "2026-01-01T00:00:00Z",
    }),
    false,
  );
  assert.equal(
    Value.Check(AttemptSchema, {
      ...attempt("A"),
      createdAt: "not-an-instant",
    }),
    false,
  );
  assert.equal(
    Value.Check(TaskSchema, {
      ...researchTask("Task"),
      attempts: [{ ...attempt("A"), selectedModels: { role: "research", selected: [] } }],
    }),
    false,
  );
  assert.equal(Value.Check(EvidenceSchema, { label: "x", observation: "y", extra: true }), false);
  assert.equal(
    Value.Check(WorkerReportSchema, {
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
      expectedRef: "refs/heads/main",
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
      expectedRef: "refs/heads/main",
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

  const initialized = activateAttempt(add(), key, "2026-01-01T00:00:01.000Z", {
    placement,
    submission: "not_sent",
  });
  assert.equal(initialized.tasks[0]?.attempts[0]?.execution?.submission, "not_sent");
  assert.throws(
    () =>
      activateAttempt(add(), key, "2026-01-01T00:00:01.000Z", {
        placement,
        sessionFile: "/worker.json",
      }),
    /activation requires only exact placement/,
  );
  assert.throws(
    // The declaration is the activation boundary; later stages are still
    // recorded exactly one at a time.
    () =>
      recordWorkerExecution(
        activateAttempt(add(), key, "2026-01-01T00:00:01.000Z", declare(placement)),
        key,
        { sessionFile: "/worker.json", launch: pane },
        "2026-01-01T00:00:02.000Z",
      ),
    /exactly one new external-effect stage/,
  );

  let workstream = recordWorkerExecution(
    initialized,
    key,
    { placement },
    "2026-01-01T00:00:02.000Z",
  );
  assert.throws(
    () =>
      recordWorkerExecution(
        workstream,
        key,
        { sessionFile: "/worker.json", launch: pane },
        "2026-01-01T00:00:03.000Z",
      ),
    /exactly one new external-effect stage/,
  );
  workstream = recordWorkerExecution(
    workstream,
    key,
    { sessionFile: "/worker.json" },
    "2026-01-01T00:00:03.000Z",
  );
  assert.throws(
    () => recordWorkerExecution(workstream, key, { launch: resource }, "2026-01-01T00:00:04.000Z"),
    /skip pane/,
  );
  workstream = recordWorkerExecution(workstream, key, { launch: pane }, "2026-01-01T00:00:04.000Z");
  workstream = recordWorkerExecution(
    workstream,
    key,
    { launch: resource },
    "2026-01-01T00:00:05.000Z",
  );
  workstream = recordWorkerExecution(
    workstream,
    key,
    { launch: ready },
    "2026-01-01T00:00:06.000Z",
  );
  assert.strictEqual(
    recordWorkerExecution(workstream, key, { launch: ready }, "2026-01-01T00:00:30.000Z"),
    workstream,
  );
  assert.throws(
    () =>
      recordWorkerExecution(
        workstream,
        key,
        { launch: { ...ready, paneId: "other" } },
        "2026-01-01T00:00:07.000Z",
      ),
    /progression/,
  );
  assert.throws(
    () =>
      recordWorkerExecution(
        workstream,
        key,
        { sessionFile: "/other.json" },
        "2026-01-01T00:00:08.000Z",
      ),
    /session file is immutable/,
  );
  const beforeReady = activateAttempt(add(), key, "before-ready", {
    placement,
    submission: "not_sent",
  });
  assert.throws(
    () =>
      recordWorkerExecution(
        beforeReady,
        key,
        { submission: "uncertain" },
        "2026-01-01T00:00:09.000Z",
      ),
    /ready launch/,
  );
  workstream = recordWorkerExecution(
    workstream,
    key,
    { submission: "uncertain" },
    "2026-01-01T00:00:10.000Z",
  );
  assert.throws(
    () =>
      recordWorkerExecution(
        workstream,
        key,
        {
          launch: { phase: "pane", workspaceId: "workspace", paneId: "late" },
          steering: { text: "Stop", state: "uncertain", observedAt: "2026-01-01T00:00:11.000Z" },
        },
        "2026-01-01T00:00:11.000Z",
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
          "2026-01-01T00:00:05.000Z",
        ),
      /launch resource does not match its pane/,
    );
});

void test("non-pane launch rejects cwd that does not match placement", () => {
  const key = { taskId: "Task opaque", attemptId: "Attempt A" };
  const workstream = isolatedPaneLaunch(key);
  assert.throws(
    () =>
      validateWorkstream(
        recordWorkerExecution(
          workstream,
          key,
          { launch: { ...resourceForTest(), cwd: "/other" } },
          "2026-01-01T00:00:05.000Z",
        ),
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
        "2026-01-01T00:00:05.000Z",
      ),
    /exactly one new external-effect stage/,
  );
});

void test("partial isolated launches preserve output until exact cleanup and discard", () => {
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
        validateWorkstream(
          checkpointOutputDisposition(
            workstream,
            key,
            {
              kind: "discarded",
              state: "completed",
              expectedHead: changedCommit,
              reason: "Too early.",
            },
            `2026-01-01T00:00:20.00${index}Z`,
          ),
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
    workstream = checkpointOutputDisposition(
      workstream,
      key,
      {
        kind: "discarded",
        state: "completed",
        expectedHead: changedCommit,
        reason: "Discard partial output.",
      },
      `discard-${index}`,
    );
    task = findTask(workstream, key.taskId);
    assert.ok(task);
    attemptValue = findAttempt(task, key.attemptId);
    assert.ok(attemptValue);
    assert.equal(outputDisposition(task, attemptValue).kind, "discarded");
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

void test("partial changed implementation discard clears accounting without candidate ancestry", () => {
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
    createdAt: "2026-01-01T00:00:00.000Z",
    acceptance: ["It works."],
    attempts: [parentAttempt],
  };
  const partialExecution = {
    placement: { kind: "isolated_worktree" as const, path: "/repo-work", branch: "branch" },
    sessionFile: "/worker.json",
    launch: resourceForTest(),
  };
  let workstream = finish(
    createTask(base(), parentTask, "2026-01-01T00:00:01.000Z"),
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
    "2026-01-01T00:00:05.000Z",
  );
  const childTask = (taskId: string, attemptId: string): Task => ({
    kind: "implementation",
    id: taskId,
    objective: "Continue.",
    intentIndex: 1,
    createdAt: "2026-01-01T00:00:06.000Z",
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
    { ...intent, statement: "Continue.", recordedAt: "2026-01-01T00:00:06.000Z" },
    "2026-01-01T00:00:06.000Z",
  );
  assert.notDeepEqual(deriveCompletionAccounting(workstream), []);
  assert.throws(
    () =>
      createTask(
        workstream,
        childTask("Before discard", "Before discard attempt"),
        "2026-01-01T00:00:07.000Z",
      ),
    /eligible retained output/,
  );
  workstream = checkpointOutputDisposition(
    workstream,
    key,
    {
      kind: "discarded",
      state: "completed",
      expectedHead: changedCommit,
      reason: "Discard partial output.",
    },
    "2026-01-01T00:00:08.000Z",
  );
  assert.deepEqual(deriveCompletionAccounting(workstream), []);
  const discardedTask = findTask(workstream, key.taskId);
  assert.ok(discardedTask);
  const discardedAttempt = findAttempt(discardedTask, key.attemptId);
  assert.ok(discardedAttempt);
  assert.equal(outputDisposition(discardedTask, discardedAttempt).kind, "discarded");
  assert.throws(
    () =>
      createTask(
        workstream,
        childTask("After discard", "After discard attempt"),
        "2026-01-01T00:00:09.000Z",
      ),
    /eligible retained output/,
  );
});

void test("partial shared launches settle after exact closure without output discard", () => {
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
    assert.equal(attemptValue.outputDisposition, undefined);
    assert.equal(outputDisposition(task, attemptValue).kind, "not_applicable");
  }
});

void test("selection is one policy-owned target, while implementation retains guide and executor", () => {
  const key = { taskId: "Task opaque", attemptId: "Attempt A" };
  let workstream = activateAttempt(
    add(),
    key,
    "2026-01-01T00:00:02.000Z",
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
  workstream = recordWorkerExecution(
    workstream,
    key,
    { placement: execution.placement },
    "2026-01-01T00:00:03.000Z",
  );
  const stagedTask = findTask(workstream, key.taskId);
  assert.ok(stagedTask);
  assert.equal(findAttempt(stagedTask, key.attemptId)?.execution?.launch, undefined);
  workstream = recordWorkerExecution(
    workstream,
    key,
    { sessionFile: execution.sessionFile },
    "2026-01-01T00:00:03.001Z",
  );
  workstream = recordWorkerExecution(
    workstream,
    key,
    { launch: { phase: "pane", workspaceId: "workspace", paneId: "pane" } },
    "2026-01-01T00:00:13.000Z",
  );
  workstream = recordWorkerExecution(
    workstream,
    key,
    { launch: { ...execution.launch, phase: "resource" as const } },
    "2026-01-01T00:00:03.003Z",
  );
  workstream = recordWorkerExecution(
    workstream,
    key,
    { launch: execution.launch },
    "2026-01-01T00:00:03.004Z",
  );
  workstream = recordWorkerExecution(
    workstream,
    key,
    { submission: "not_sent" },
    "2026-01-01T00:00:03.005Z",
  );
  workstream = recordWorkerExecution(
    workstream,
    key,
    { submission: "uncertain" },
    "2026-01-01T00:00:03.006Z",
  );
  workstream = recordWorkerExecution(
    workstream,
    key,
    { submission: "started" },
    "2026-01-01T00:00:03.007Z",
  );
  assert.strictEqual(
    recordWorkerExecution(workstream, key, { submission: "started" }, "2026-01-01T00:00:30.000Z"),
    workstream,
  );
  workstream = recordEffectiveModel(
    workstream,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { model: "provider/research", thinking: "low", source: "message" },
    "2026-01-01T00:00:04.000Z",
  );
  const duplicate = recordEffectiveModel(
    workstream,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { model: "provider/research", thinking: "low", source: "message" },
    "2026-01-01T00:00:05.000Z",
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
        "2026-01-01T00:00:05.000Z",
      ),
    /progression/,
  );
  const uncertainSteering = {
    steering: {
      text: "Continue.",
      state: "uncertain" as const,
      observedAt: "2026-01-01T00:00:04.001Z",
    },
  };
  workstream = recordWorkerExecution(
    workstream,
    key,
    uncertainSteering,
    "2026-01-01T00:00:04.001Z",
  );
  assert.strictEqual(
    recordWorkerExecution(workstream, key, uncertainSteering, "2026-01-01T00:00:30.000Z"),
    workstream,
  );
  assert.throws(
    () =>
      recordWorkerExecution(
        workstream,
        key,
        { steering: { text: "Stop.", state: "uncertain", observedAt: "2026-01-01T00:00:04.002Z" } },
        "2026-01-01T00:00:04.002Z",
      ),
    /cannot be overwritten/,
  );
  workstream = recordWorkerExecution(
    workstream,
    key,
    { steering: { text: "Continue.", state: "submitted", observedAt: "2026-01-01T00:00:04.003Z" } },
    "2026-01-01T00:00:04.003Z",
  );
  assert.throws(
    () =>
      recordWorkerExecution(
        workstream,
        key,
        {
          steering: {
            text: "Continue.",
            state: "uncertain",
            observedAt: "2026-01-01T00:00:04.004Z",
          },
        },
        "2026-01-01T00:00:04.004Z",
      ),
    /progression is not exact/,
  );
  workstream = recordWorkerExecution(
    workstream,
    key,
    { steering: { text: "Stop.", state: "uncertain", observedAt: "2026-01-01T00:00:04.005Z" } },
    "2026-01-01T00:00:04.005Z",
  );
  assert.throws(
    () =>
      recordWorkerExecution(
        workstream,
        key,
        { submission: "not_sent" },
        "2026-01-01T00:00:05.001Z",
      ),
    /monotonic/,
  );
  const conflictedTask = findTask(workstream, key.taskId);
  assert.ok(conflictedTask);
  assert.equal(findAttempt(conflictedTask, key.attemptId)?.execution?.submission, "started");
  workstream = checkpointCancellation(
    workstream,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { state: "requested", requestedAt: "2026-01-01T00:00:06.000Z", reason: "Stop." },
    "2026-01-01T00:00:06.000Z",
  );
  const updatedTask = findTask(workstream, "Task opaque");
  assert.ok(updatedTask);
  assert.equal(findAttempt(updatedTask, "Attempt A")?.execution?.cancellation?.reason, "Stop.");
  let late = activateAttempt(
    add(),
    { taskId: "Task opaque", attemptId: "Attempt A" },
    "2026-01-01T00:00:07.000Z",
    declare({ kind: "shared_project", path: "/repo" }),
  );
  late = recordWorkerExecution(
    late,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { placement: execution.placement },
    "2026-01-01T00:00:08.000Z",
  );
  late = checkpointCancellation(
    late,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    {
      state: "requested",
      requestedAt: "2026-01-01T00:00:09.000Z",
      reason: "Stop before worker session.",
    },
    "2026-01-01T00:00:09.000Z",
  );
  late = recordWorkerExecution(
    late,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { steering: { text: "Continue.", state: "uncertain", observedAt: "2026-01-01T00:00:09.001Z" } },
    "2026-01-01T00:00:09.001Z",
  );
  late = recordWorkerExecution(
    late,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { sessionFile: execution.sessionFile },
    "2026-01-01T00:00:10.000Z",
  );
  late = recordWorkerExecution(
    late,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { launch: { phase: "pane", workspaceId: "workspace", paneId: "pane" } },
    "2026-01-01T00:00:10.001Z",
  );
  late = recordWorkerExecution(
    late,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { launch: { ...execution.launch, phase: "resource" as const } },
    "2026-01-01T00:00:10.002Z",
  );
  late = recordWorkerExecution(
    late,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { launch: execution.launch },
    "2026-01-01T00:00:10.003Z",
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
    issuedAt: "2026-01-01T00:00:00.000Z",
  };
  const child = createWorkstream({
    id: "Child opaque",
    purpose: "Continue.",
    repository,
    coordinator,
    intent: { ...intent, grounding: grant },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(child.intents[0]?.grounding.kind, "handoff_grant");
  assert.throws(
    () => reviseIntent(child, { ...intent, grounding: grant }, "2026-01-01T00:00:01.000Z"),
    /direct receipt/,
  );
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
    () => validateWorkstream(finish(add(), "Attempt A", malformedReport as TerminalObservation)),
    /Report kind/,
  );
  const workstream = finish(add(), "Attempt A", reported());
  const reordered = {
    kind: "reported" as const,
    observedAt: "2026-01-01T00:00:02.000Z",
    artifacts: [],
    deliveryRequestedAt: "2026-01-01T00:00:03.000Z",
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
    observedAt: "2026-01-01T00:00:02.000Z",
    artifacts: [],
    deliveryRequestedAt: "2026-01-01T00:00:03.000Z",
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
    { at: "2026-01-01T00:00:03.000Z", detail: "Retry delivery." },
    "2026-01-01T00:00:03.000Z",
  );
  workstream = deliver(workstream, "Failed");
  workstream = deliver(finish(workstream, "Cancelled", cancelled()), "Cancelled");
  assert.deepEqual(deriveCompletionAccounting(workstream), []);
  let fanout = deliver(finish(add(), "Attempt A", reported()), "Attempt A");
  fanout = appendAttempts(fanout, "Task opaque", [attempt("Sibling")], "2026-01-01T00:00:05.000Z");
  assert.equal(findTask(fanout, "Task opaque")?.attempts.length, 2);
  workstream = completeWorkstream(
    workstream,
    {
      conclusion: "Settled.",
      evidence: [{ label: "check", observation: "done" }],
      limitations: [],
      completedAt: "2026-01-01T00:00:05.000Z",
    },
    "2026-01-01T00:00:05.000Z",
  );
  assert.deepEqual(workstream.completion?.accounting, []);
  assert.throws(
    () => createTask(workstream, researchTask("New"), "2026-01-01T00:00:06.000Z"),
    /completed/,
  );
  assert.throws(() => reviseIntent(workstream, intent, "2026-01-01T00:00:06.000Z"), /completed/);
});

void test("appendAttempts is one atomic nonempty batch that preserves order and validates the result", () => {
  const stable = deliver(finish(add(), "Attempt A", reported()), "Attempt A");
  const batch = appendAttempts(
    stable,
    "Task opaque",
    [attempt("Attempt B"), attempt("Attempt C"), attempt("Attempt D")],
    "2026-01-01T00:00:05.000Z",
  );
  assert.deepEqual(
    findTask(batch, "Task opaque")?.attempts.map((item) => item.id),
    ["Attempt A", "Attempt B", "Attempt C", "Attempt D"],
  );
  assert.equal(batch.revision, stable.revision + 1);
  validateWorkstream(batch);

  assert.throws(
    () => appendAttempts(stable, "Task opaque", [], "2026-01-01T00:00:05.000Z"),
    /at least one new Attempt/,
  );
  assert.throws(
    () =>
      appendAttempts(
        stable,
        "Task opaque",
        [{ ...attempt("Attempt B"), state: "active" }],
        "2026-01-01T00:00:05.000Z",
      ),
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
        "2026-01-01T00:00:05.000Z",
      ),
    /does not match Task kind/,
  );
  assert.throws(
    () => appendAttempts(stable, "Unknown", [attempt("Attempt B")], "2026-01-01T00:00:05.000Z"),
    /Unknown Task/,
  );
  assert.throws(
    () =>
      validateWorkstream(
        appendAttempts(
          stable,
          "Task opaque",
          [attempt("Attempt B", { continuationOf: "Attempt A" })],
          "2026-01-01T00:00:05.000Z",
        ),
      ),
    /retained closed Worker session/,
  );

  // An unstable pre-existing Attempt rejects the whole batch without a partial append.
  const unstable = finish(add(), "Attempt A", reported());
  assert.throws(
    () =>
      appendAttempts(
        unstable,
        "Task opaque",
        [attempt("Attempt B"), attempt("Attempt C")],
        "2026-01-01T00:00:05.000Z",
      ),
    /operationally unstable/,
  );
  assert.equal(findTask(unstable, "Task opaque")?.attempts.length, 1);
});

void test("isolated failed output remains blocked through cleanup until exact discard, including after completion", () => {
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
      observedAt: "2026-01-01T00:00:02.000Z",
      artifacts: [],
      deliveryRequestedAt: "2026-01-01T00:00:03.000Z",
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
    "2026-01-01T00:00:04.000Z",
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
      completedAt: "2026-01-01T00:00:05.000Z",
    },
    "2026-01-01T00:00:05.000Z",
  );
  assert.notDeepEqual(workstream.completion?.accounting, []);
  workstream = deliver(workstream, "Attempt A");
  assert.throws(
    () => appendAttempts(workstream, "Task opaque", [attempt("Later")], "2026-01-01T00:00:06.000Z"),
    /completed/,
  );
  workstream = checkpointOutputDisposition(
    workstream,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    {
      kind: "discarded",
      state: "completed",
      expectedHead: changedCommit,
      reason: "Discard failed checkout.",
    },
    "2026-01-01T00:00:06.000Z",
  );
  assert.notDeepEqual(deriveCompletionAccounting(workstream), []);
  workstream = checkpointCleanup(
    workstream,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { state: "completed", workerClosed: true, expectedHead: changedCommit },
    "2026-01-01T00:00:06.001Z",
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
          expectedRef: "refs/heads/main",
          expectedHead: changedCommit,
          rootCommit: baseCommit,
          commits: [commit("d"), changedCommit],
        },
        "2026-01-01T00:00:07.000Z",
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
      completedAt: "2026-01-01T00:00:05.000Z",
    },
    "2026-01-01T00:00:05.000Z",
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
        "2026-01-01T00:00:06.000Z",
      ),
    /not monotonic/,
  );
});

void test("an exact completed discard and cleanup is operationally stable", () => {
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
  let workstream = deliver(
    finish(add(), "Attempt A", reported(), "Task opaque", execution),
    "Attempt A",
  );
  workstream = checkpointCleanup(
    workstream,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { state: "completed", workerClosed: true, expectedHead: changedCommit },
    "2026-01-01T00:00:04.000Z",
  );
  const discarded = structuredClone(workstream);
  const discardedTask = discarded.tasks[0];
  assert.ok(discardedTask);
  const discardedAttempt = discardedTask.attempts[0];
  assert.ok(discardedAttempt);
  discardedAttempt.outputDisposition = {
    kind: "discarded",
    state: "completed",
    expectedHead: changedCommit,
    reason: "Exact discard checkpoint.",
  };
  validateWorkstream(discarded);
  assert.equal(isOperationallyStable(discardedTask, discardedAttempt), true);
  assert.deepEqual(deriveCompletionAccounting(discarded), []);
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
    () => appendAttempts(workstream, "Task opaque", [attempt("Later")], "2026-01-01T00:00:03.000Z"),
    /operationally unstable/,
  );
  workstream = deliver(workstream, "Attempt A");
  assert.notDeepEqual(deriveCompletionAccounting(workstream), []);
  workstream = checkpointCleanup(
    workstream,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { state: "blocked", workerClosed: true, error: "Worker cleanup blocked." },
    "2026-01-01T00:00:05.000Z",
  );
  assert.notDeepEqual(deriveCompletionAccounting(workstream), []);
  assert.throws(
    () =>
      appendAttempts(
        workstream,
        "Task opaque",
        [attempt("Still blocked")],
        "2026-01-01T00:00:06.000Z",
      ),
    /operationally unstable/,
  );
  workstream = completeWorkstream(
    workstream,
    {
      conclusion: "Shared worker is closed only after recovery.",
      evidence: [{ label: "cleanup", observation: "blocked" }],
      limitations: [],
      completedAt: "2026-01-01T00:00:07.000Z",
    },
    "2026-01-01T00:00:07.000Z",
  );
  workstream = checkpointCleanup(
    workstream,
    { taskId: "Task opaque", attemptId: "Attempt A" },
    { state: "completed", workerClosed: true },
    "2026-01-01T00:00:08.000Z",
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
    createdAt: "2026-01-01T00:00:00.000Z",
    acceptance: ["It works."],
    attempts: [parentAttempt],
  };
  let workstream = createTask(base(), parentTask, "2026-01-01T00:00:01.000Z");
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
      expectedRef: "refs/heads/main",
      expectedHead: baseCommit,
      rootCommit: baseCommit,
      commits: [commit("d"), changedCommit],
      revision: commit("c"),
    },
    "2026-01-01T00:00:03.000Z",
  );
  workstream = checkpointCleanup(
    workstream,
    { taskId: "Parent Task", attemptId: "Parent Attempt" },
    { state: "completed", workerClosed: true, expectedHead: changedCommit },
    "2026-01-01T00:00:04.000Z",
  );
  const settledParentTask = findTask(workstream, "Parent Task");
  assert.ok(settledParentTask);
  const settledParentAttempt = findAttempt(settledParentTask, "Parent Attempt");
  assert.ok(settledParentAttempt);
  assert.equal(
    outputDisposition(settledParentTask, settledParentAttempt).kind,
    "maintained_output",
  );
  const retained = reviseIntent(
    workstream,
    { ...intent, statement: "Revise.", recordedAt: "2026-01-01T00:00:05.000Z" },
    "2026-01-01T00:00:05.000Z",
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
    createdAt: "2026-01-01T00:00:05.000Z",
    acceptance: ["It works."],
    attempts: [childAttempt],
  };
  workstream = createTask(retained, childTask, "2026-01-01T00:00:06.000Z");
  assert.equal(findTask(workstream, "Child Task")?.intentIndex, 1);

  const discarded = checkpointOutputDisposition(
    retained,
    { taskId: "Parent Task", attemptId: "Parent Attempt" },
    { kind: "discarded", state: "completed", expectedHead: changedCommit, reason: "Discarded." },
    "2026-01-01T00:00:06.002Z",
  );
  assert.throws(
    () =>
      createTask(
        discarded,
        {
          ...childTask,
          id: "Discarded Child Task",
          attempts: [{ ...childAttempt, id: "Discarded Child Attempt" }],
        },
        "2026-01-01T00:00:07.000Z",
      ),
    /eligible retained output/,
  );
});

void test("activation declares durable placement before any external effect", () => {
  const key = { taskId: "Task opaque", attemptId: "Attempt A" };
  const placement = { kind: "isolated_worktree" as const, path: "/repo-work", branch: "branch" };

  // The declaration is placement plus the initial not-sent submission checkpoint.
  const declared = activateAttempt(add(), key, "2026-01-01T00:00:01.000Z", declare(placement));
  assert.deepEqual(declared.tasks[0]?.attempts[0]?.execution, {
    placement,
    submission: "not_sent",
  });

  // A missing placement or a pre-progressed submission can never begin activation.
  assert.throws(
    () => activateAttempt(add(), key, "2026-01-01T00:00:01.000Z", { submission: "not_sent" }),
    /exact placement and not-sent submission/,
  );
  assert.throws(
    () =>
      activateAttempt(add(), key, "2026-01-01T00:00:01.000Z", {
        placement,
        submission: "uncertain",
      }),
    /exact placement and not-sent submission/,
  );
  assert.throws(
    () =>
      activateAttempt(add(), key, "2026-01-01T00:00:01.000Z", {
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

  const progressed = recordWorkerExecution(
    declared,
    key,
    { sessionFile: "/worker.json" },
    "2026-01-01T00:00:02.000Z",
  );
  const progressedActive = progressed.tasks[0]?.attempts[0]?.execution;
  assert.ok(progressedActive);
  Reflect.deleteProperty(progressedActive, "submission");
  assert.throws(() => validateWorkstream(progressed), /not-sent submission checkpoint/);
});

void test("cancellation is one monotonic termination protocol with exact absence", () => {
  const key = { taskId: "Task opaque", attemptId: "Attempt A" };
  const placement = { kind: "shared_project" as const, path: "/repo" };
  const active = activateAttempt(add(), key, "2026-01-01T00:00:01.000Z", declare(placement));
  const requested = {
    state: "requested" as const,
    requestedAt: "2026-01-01T00:00:02.000Z",
    reason: "Stop.",
  };
  const uncertain = {
    ...requested,
    state: "uncertain" as const,
    dispatchAt: "2026-01-01T00:00:03.000Z",
  };
  const terminated = {
    ...uncertain,
    state: "terminated" as const,
    terminatedAt: "2026-01-01T00:00:04.000Z",
  };

  let workstream = checkpointCancellation(active, key, requested, "2026-01-01T00:00:02.000Z");
  assert.equal(workstream.tasks[0]?.attempts[0]?.execution?.cancellation?.state, "requested");
  // Exact replay is a structural no-op; the request identity and reason persist.
  assert.strictEqual(
    checkpointCancellation(workstream, key, requested, "2026-01-01T00:00:02.002Z"),
    workstream,
  );
  // No skip and no backward move.
  assert.throws(
    () => checkpointCancellation(workstream, key, terminated, "2026-01-01T00:00:02.003Z"),
    /not monotonic/,
  );
  // A different request identity cannot overwrite the durable request.
  assert.throws(
    () =>
      checkpointCancellation(
        workstream,
        key,
        {
          state: "uncertain",
          requestedAt: "2026-01-01T00:00:09.000Z",
          reason: "Other.",
          dispatchAt: "2026-01-01T00:00:03.000Z",
        },
        "2026-01-01T00:00:02.005Z",
      ),
    /not monotonic/,
  );
  workstream = checkpointCancellation(workstream, key, uncertain, "2026-01-01T00:00:03.000Z");
  assert.equal(workstream.tasks[0]?.attempts[0]?.execution?.cancellation?.state, "uncertain");
  assert.throws(
    () =>
      checkpointCancellation(
        workstream,
        key,
        { ...uncertain, dispatchAt: "2026-01-01T00:00:09.000Z" },
        "2026-01-01T00:00:13.000Z",
      ),
    /not monotonic/,
  );
  workstream = checkpointCancellation(workstream, key, terminated, "2026-01-01T00:00:04.000Z");
  const terminal = workstream.tasks[0]?.attempts[0]?.execution?.cancellation;
  assert.deepEqual(terminal, terminated);
  assert.strictEqual(
    checkpointCancellation(workstream, key, terminated, "2026-01-01T00:00:04.002Z"),
    workstream,
  );
  // A terminal checkpoint cannot be rewritten or moved backward.
  assert.throws(
    () => checkpointCancellation(workstream, key, uncertain, "2026-01-01T00:00:05.000Z"),
    /not monotonic/,
  );

  // An active cancelled settlement needs both verified termination and durable
  // closure; while active, cleanup may only be the cancellation path's start.
  const pending = { state: "pending" as const, workerClosed: true };
  assert.throws(
    () => terminalizeAttempt(active, key, cancelled(), "2026-01-01T00:00:05.000Z"),
    /terminated cancellation/,
  );
  assert.throws(
    () => terminalizeAttempt(workstream, key, cancelled(), "2026-01-01T00:00:05.000Z"),
    /durable Worker closure/,
  );
  assert.throws(
    () => checkpointCleanup(active, key, pending, "2026-01-01T00:00:05.000Z"),
    /terminated cancellation/,
  );
  assert.throws(
    () =>
      checkpointCleanup(
        workstream,
        key,
        { state: "completed", workerClosed: true },
        "2026-01-01T00:00:05.000Z",
      ),
    /only begin pending/,
  );
  // The fully proven path settles cancelled, then ordinary cleanup resumes.
  const closed = checkpointCleanup(workstream, key, pending, "2026-01-01T00:00:06.000Z");
  const settled = terminalizeAttempt(closed, key, cancelled(), "2026-01-01T00:00:07.000Z");
  assert.equal(settled.tasks[0]?.attempts[0]?.state, "finished");
  assert.equal(settled.tasks[0]?.attempts[0]?.outcome?.kind, "cancelled");
  const completed = checkpointCleanup(
    settled,
    key,
    { state: "completed", workerClosed: true, expectedHead: changedCommit },
    "2026-01-01T00:00:08.000Z",
  );
  assert.equal(completed.tasks[0]?.attempts[0]?.cleanup?.state, "completed");
  // A queued pristine Attempt settles cancelled without any Worker facts.
  assert.equal(
    terminalizeAttempt(add(), key, cancelled(), "2026-01-01T00:00:09.000Z").tasks[0]?.attempts[0]
      ?.state,
    "finished",
  );
});

void test("persisted read validation mirrors cancellation settlement and completion lifecycle", () => {
  const key = { taskId: "Task opaque", attemptId: "Attempt A" };
  const placement = { kind: "shared_project" as const, path: "/repo" };
  const requested = {
    state: "requested" as const,
    requestedAt: "2026-01-01T00:00:02.000Z",
    reason: "Stop.",
  };
  const uncertain = {
    ...requested,
    state: "uncertain" as const,
    dispatchAt: "2026-01-01T00:00:03.000Z",
  };
  const terminated = {
    ...uncertain,
    state: "terminated" as const,
    terminatedAt: "2026-01-01T00:00:04.000Z",
  };
  let active = checkpointCancellation(
    activateAttempt(add(), key, "2026-01-01T00:00:01.000Z", declare(placement)),
    key,
    requested,
    "2026-01-01T00:00:02.000Z",
  );
  active = checkpointCancellation(active, key, uncertain, "2026-01-01T00:00:03.000Z");
  active = checkpointCancellation(active, key, terminated, "2026-01-01T00:00:04.000Z");

  // A pending active cancellation cleanup and a pristine queued cancellation
  // settlement are both valid persisted states.
  const pendingCleanup = checkpointCleanup(
    active,
    key,
    { state: "pending", workerClosed: true },
    "2026-01-01T00:00:05.000Z",
  );
  assert.doesNotThrow(() => validateWorkstream(pendingCleanup));
  assert.doesNotThrow(() =>
    validateWorkstream(terminalizeAttempt(add(), key, cancelled(), "2026-01-01T00:00:05.000Z")),
  );

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

  // A finished cancelled Worker settlement keeps its exact termination proof and
  // durable Worker closure on read.
  const settled = terminalizeAttempt(pendingCleanup, key, cancelled(), "2026-01-01T00:00:06.000Z");
  assert.doesNotThrow(() => validateWorkstream(settled));
  const withoutCancellation = structuredClone(settled);
  const uncancelledAttempt = withoutCancellation.tasks[0]?.attempts[0];
  assert.ok(uncancelledAttempt?.execution);
  Reflect.deleteProperty(uncancelledAttempt.execution, "cancellation");
  assert.throws(() => validateWorkstream(withoutCancellation), /terminated cancellation/);
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
      completedAt: "2026-01-01T00:00:06.000Z",
    },
    "2026-01-01T00:00:06.000Z",
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
  let failed = recordDeliveryFailure(
    pending,
    key,
    { at: "2026-01-01T00:00:03.000Z", detail: "Retry." },
    "2026-01-01T00:00:03.000Z",
  );
  failed = recordDeliveryFailure(
    failed,
    key,
    { at: "2026-01-01T00:00:04.000Z", detail: "Retry again." },
    "2026-01-01T00:00:04.000Z",
  );
  const failedDelivery = failed.tasks[0]?.attempts[0]?.outcome?.delivery;
  assert.equal(failedDelivery?.attemptCount, 2);
  assert.equal(failedDelivery?.failureHistory.length, 2);
  const accepted = recordDeliverySuccess(
    failed,
    key,
    "2026-01-01T00:00:05.000Z",
    "2026-01-01T00:00:05.000Z",
  );
  const acceptedDelivery = accepted.tasks[0]?.attempts[0]?.outcome?.delivery;
  assert.equal(acceptedDelivery?.attemptCount, 3);
  assert.equal(acceptedDelivery?.failureHistory.length, 2);
});
