import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- These flows exercise real private SQLite storage at the node:test boundary.
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Fixture paths are real host repository identities.
import { join } from "node:path";
import test from "node:test";
import { Clock, Deferred, Effect, type FileSystem, Option, type Path, type Scope } from "effect";
import { TestClock } from "effect/testing";
import {
  applyAffectedKeys,
  classifyWorkstream,
  DELIVERY_RETRY_BASE_MILLIS,
  DELIVERY_RETRY_CAP_MILLIS,
  deliveryDueAt,
  deliveryRetryDelayMillis,
  type FrontierEntry,
  WORKER_POLL_INTERVAL_MILLIS,
} from "../src/canonical-frontier.js";
import {
  type ReconciliationContext,
  type ReconciliationDriver,
  ReconciliationDriverError,
} from "../src/canonical-reconciliation.js";
import {
  CanonicalRuntime,
  type CanonicalRuntimeAcquisition,
  type CanonicalRuntimeError,
} from "../src/canonical-runtime.js";
import { CanonicalWorkstreamStore } from "../src/canonical-workstream-store.js";
import {
  type Attempt,
  type AttemptKey,
  activateAttempt,
  type CoordinatorIdentity,
  checkpointApplication,
  checkpointCancellation,
  checkpointCleanup,
  createTask,
  createWorkstream,
  findAttempt,
  findTask,
  type RetainedArtifact,
  recordDeliveryFailure,
  recordDeliverySuccess,
  recordWorkerExecution,
  reviseIntent,
  type Task,
  type TerminalObservation,
  terminalizeAttempt,
  type Workstream,
} from "../src/domain/workstream.js";
import type { ModelPolicy } from "../src/model-policy.js";
import { liveLayer } from "../src/node-platform.js";

const T0 = "2024-01-01T00:00:00.000Z";
const T1 = "2024-01-01T00:00:01.000Z";
const T5 = "2024-01-01T00:00:05.000Z";
const T6 = "2024-01-01T00:00:06.000Z";
const BASE = "a".repeat(40);
const CHANGED = "b".repeat(40);
const ID = "frontier";
const COORDINATOR: CoordinatorIdentity = {
  sessionId: "coordinator-a",
  sessionFile: "/sessions/coordinator-a.jsonl",
};
const RESEARCH = {
  role: "research" as const,
  target: { model: "fixture/research", thinking: "high" as const },
  source: "policy" as const,
};
const IMPLEMENTATION = {
  role: "implementation" as const,
  guide: { model: "fixture/guide", thinking: "low" as const },
  executor: { model: "fixture/executor", thinking: "high" as const },
  source: "policy" as const,
};
const SHARED = { kind: "shared_project" as const, path: "/repo" };
const ISOLATED = { kind: "isolated_worktree" as const, path: "/repo-work", branch: "branch" };
const PANE = { phase: "pane" as const, workspaceId: "workspace", paneId: "pane" };
const KEY = (taskId: string, attemptId: string): AttemptKey => ({ taskId, attemptId });
const kinds = (entries: readonly FrontierEntry[]) =>
  entries.map((entry) => `${entry.kind}:${entry.key.attemptId}`);
const has = (entries: readonly FrontierEntry[], kind: string, attemptId: string) =>
  entries.some((entry) => entry.kind === kind && entry.key.attemptId === attemptId);
const entryFor = (entries: readonly FrontierEntry[], attemptId: string) =>
  entries.find((entry) => entry.key.attemptId === attemptId);
const receipt = () => ({
  kind: "human_input_receipt" as const,
  id: "receipt-1",
  sessionId: COORDINATOR.sessionId,
  sessionFile: COORDINATOR.sessionFile,
  source: "interactive" as const,
  text: "Coordinate.",
  receivedAt: T0,
});
const workerFor = (cwd: string) => ({
  workspaceId: "workspace",
  tabId: "tab",
  paneId: "pane",
  terminalId: "terminal",
  agentName: "agent",
  cwd,
});
const readyFor = (cwd: string) => ({ ...workerFor(cwd), phase: "ready" as const });
/** Exact ready identity: Herdr resource fields plus the Pi session file. */
const READY = (cwd: string) => ({ ...workerFor(cwd), sessionFile: "/worker.json" });

function taskFor(id: string, intentIndex: number, implementation = false): Task {
  const attempt: Attempt = {
    id: `${id}-a`,
    state: "queued",
    createdAt: T0,
    updatedAt: T0,
    selection: implementation ? IMPLEMENTATION : RESEARCH,
  };
  if (implementation) {
    attempt.baseRevision = BASE;
    attempt.candidate = { kind: "initial", rootCommit: BASE };
  }
  const base = {
    id,
    objective: `Objective ${id}`,
    intentIndex,
    createdAt: T0,
    attempts: [attempt],
  };
  return implementation
    ? { ...base, kind: "implementation", acceptance: ["accepted"] }
    : { ...base, kind: "research", expectedEvidence: ["evidence"] };
}

function reported(implementation = false): TerminalObservation {
  const base = { status: "completed" as const, evidence: [], findings: [] };
  const report = implementation
    ? {
        ...base,
        kind: "implementation" as const,
        outcome: "changed" as const,
        commit: CHANGED,
        summary: "Changed.",
      }
    : { ...base, kind: "research" as const, summary: "Reported." };
  return { kind: "reported", observedAt: T1, artifacts: [], deliveryRequestedAt: T1, report };
}

const activate = (ws: Workstream, key: AttemptKey, placement: typeof SHARED | typeof ISOLATED) =>
  activateAttempt(ws, key, T0, { placement, submission: "not_sent" });

/** Advance an activated Attempt to an exact ready launch with a sent submission. */
function toReady(ws: Workstream, key: AttemptKey, cwd: string): Workstream {
  let next = recordWorkerExecution(ws, key, { sessionFile: "/worker.json" }, T1);
  next = recordWorkerExecution(next, key, { launch: PANE }, T1);
  next = recordWorkerExecution(next, key, { launch: { ...readyFor(cwd), phase: "resource" } }, T1);
  next = recordWorkerExecution(next, key, { launch: readyFor(cwd) }, T1);
  next = recordWorkerExecution(next, key, { submission: "uncertain" }, T1);
  return recordWorkerExecution(next, key, { submission: "started" }, T1);
}

/** One mixed aggregate: settled history plus every exact transient obligation. */
function mixedWorkstream(): Workstream {
  const repository = { projectRoot: "/repo", gitCommonDir: "/repo/.git" };
  const intent0 = {
    statement: "First intent.",
    constraints: [],
    grounding: receipt(),
    recordedAt: T0,
  };
  let ws = createWorkstream({
    id: "ws",
    purpose: "Coordinate.",
    repository,
    coordinator: COORDINATOR,
    intent: intent0,
    createdAt: T0,
  });
  ws = createTask(ws, taskFor("stale", 0), T0);
  ws = reviseIntent(ws, { ...intent0, statement: "Second intent.", recordedAt: T1 }, T1);
  const add = (id: string, implementation = false) => {
    ws = createTask(ws, taskFor(id, 1, implementation), T1);
    return KEY(id, `${id}-a`);
  };
  const start = (key: AttemptKey, placement: typeof SHARED | typeof ISOLATED, ready = false) => {
    ws = activate(ws, key, placement);
    if (ready) ws = toReady(ws, key, placement.path);
  };
  const close = (key: AttemptKey) => {
    ws = terminalizeAttempt(ws, key, reported(), T1);
    ws = checkpointCleanup(ws, key, { state: "completed", workerClosed: true }, T1);
  };
  const cancel = (key: AttemptKey, state: "requested" | "uncertain" | "submitted_or_observed") => {
    const base = { requestedAt: T1, reason: "Stop." };
    if (state === "requested") {
      ws = checkpointCancellation(ws, key, { ...base, state }, T1);
      return;
    }
    const dispatch = { ...base, state: "uncertain" as const, dispatchAt: T1 };
    if (state === "uncertain") {
      ws = checkpointCancellation(ws, key, dispatch, T1);
      return;
    }
    ws = checkpointCancellation(
      ws,
      key,
      { ...dispatch, state, observedAt: T1, evidence: "idle" },
      T1,
    );
  };

  add("q");
  start(add("pr"), ISOLATED);
  start(add("wp"), SHARED, true);
  const observed = add("co");
  start(observed, SHARED, true);
  cancel(observed, "requested");
  cancel(observed, "uncertain");
  cancel(observed, "submitted_or_observed");
  const immediate = add("di");
  start(immediate, SHARED);
  close(immediate);
  const backedOff = add("db");
  start(backedOff, SHARED);
  close(backedOff);
  ws = recordDeliveryFailure(ws, backedOff, { at: T5, detail: "Retry one." }, T5);
  ws = recordDeliveryFailure(ws, backedOff, { at: T6, detail: "Retry two." }, T6);
  const cleanupWorker = add("cw");
  start(cleanupWorker, ISOLATED, true);
  ws = terminalizeAttempt(ws, cleanupWorker, reported(), T1);
  ws = recordDeliverySuccess(ws, cleanupWorker, T1, T1);
  const cleanupPending = add("cp");
  start(cleanupPending, ISOLATED);
  ws = terminalizeAttempt(ws, cleanupPending, reported(), T1);
  ws = recordDeliverySuccess(ws, cleanupPending, T1, T1);
  const cleanupBlocked = add("cb");
  start(cleanupBlocked, ISOLATED);
  ws = terminalizeAttempt(ws, cleanupBlocked, reported(), T1);
  ws = recordDeliverySuccess(ws, cleanupBlocked, T1, T1);
  ws = checkpointCleanup(
    ws,
    cleanupBlocked,
    { state: "blocked", workerClosed: true, error: "No." },
    T1,
  );
  const settled = add("st");
  start(settled, SHARED);
  close(settled);
  ws = recordDeliverySuccess(ws, settled, T1, T1);
  const applied = add("ap", true);
  start(applied, ISOLATED, true);
  ws = terminalizeAttempt(ws, applied, reported(true), T1);
  ws = checkpointApplication(
    ws,
    applied,
    {
      state: "pending",
      commit: CHANGED,
      expectedHead: BASE,
      rootCommit: BASE,
      commits: [BASE, CHANGED],
    },
    T1,
  );
  ws = checkpointCleanup(
    ws,
    applied,
    { state: "completed", workerClosed: true, expectedHead: CHANGED },
    T1,
  );
  return recordDeliverySuccess(ws, applied, T1, T1);
}

void test("classifies mixed obligations and replaces only affected keys in place", () => {
  const ws = mixedWorkstream();
  const frontier = classifyWorkstream(ws);
  assert.deepEqual(kinds(frontier), [
    "queued:q-a",
    "placement_recovery:pr-a",
    "worker_poll:wp-a",
    "cancellation:co-a",
    "delivery:di-a",
    "delivery:db-a",
    "cleanup:cw-a",
    "cleanup:cp-a",
  ]);
  assert.deepEqual(entryFor(frontier, "wp-a"), {
    kind: "worker_poll",
    key: KEY("wp", "wp-a"),
    worker: READY(SHARED.path),
  });
  const cancellation = entryFor(frontier, "co-a");
  assert.ok(cancellation?.kind === "cancellation");
  assert.equal(cancellation.cancellation.state, "submitted_or_observed");
  assert.deepEqual(cancellation.placement, SHARED);
  assert.equal(cancellation.sessionFile, "/worker.json");
  assert.deepEqual(cancellation.worker, READY(SHARED.path));
  const withWorker = entryFor(frontier, "cw-a");
  assert.ok(withWorker?.kind === "cleanup");
  assert.deepEqual(withWorker.worker, READY(ISOLATED.path));
  const withoutWorker = entryFor(frontier, "cp-a");
  assert.ok(withoutWorker?.kind === "cleanup");
  assert.equal(withoutWorker.worker, undefined);
  // Settled history, stale-Intent queued work, blocked cleanup, and manual
  // application/output release are never runnable.
  for (const absent of ["stale-a", "cb-a", "st-a", "ap-a"])
    assert.equal(entryFor(frontier, absent), undefined, absent);

  // Incremental replacement keeps other positions and identities and appends a
  // genuinely new key; unknown keys are inert.
  const key = KEY("q", "q-a");
  const activated = applyAffectedKeys(frontier, activate(ws, key, SHARED), [key]);
  assert.equal(activated.length, frontier.length);
  assert.deepEqual(entryFor(activated, "q-a"), {
    kind: "placement_recovery",
    key,
    placement: SHARED,
  });
  assert.equal(kinds(activated)[0], "placement_recovery:q-a");
  for (const original of frontier)
    if (original.key.attemptId !== "q-a") assert.equal(activated.includes(original), true);
  const extended = createTask(ws, taskFor("new", 1), T1);
  assert.equal(
    applyAffectedKeys(frontier, extended, [KEY("new", "new-a")]).at(-1)?.key.attemptId,
    "new-a",
  );
  assert.deepEqual(applyAffectedKeys(frontier, ws, [KEY("missing", "missing-a")]), frontier);
});

void test("delivery retry timing is transient 1s/2s/4s doubling to a 30s cap", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7].map(deliveryRetryDelayMillis),
    [0, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000],
  );
  assert.equal(DELIVERY_RETRY_CAP_MILLIS, 30_000);
  assert.equal(DELIVERY_RETRY_BASE_MILLIS, 1_000);
  assert.equal(WORKER_POLL_INTERVAL_MILLIS, 1_000);
  const pending = {
    state: "pending" as const,
    requestedAt: T6,
    attemptCount: 1,
    failureHistory: [{ at: T5, detail: "one" }],
  };
  assert.equal(deliveryDueAt(undefined), undefined);
  assert.equal(deliveryDueAt(pending), "2024-01-01T00:00:06.000Z");
  // The classifier derives the same due time from two recorded failures.
  const backedOff = entryFor(classifyWorkstream(mixedWorkstream()), "db-a");
  assert.ok(backedOff?.kind === "delivery");
  assert.equal(backedOff.dueAt, "2024-01-01T00:00:08.000Z");
});

// Runtime flows over real private SQLite storage.

const POLICY: ModelPolicy = {
  version: 6,
  roles: {
    research: [RESEARCH.target],
    review: [{ model: "fixture/review", thinking: "high" }],
    "implementation.guide": { model: "fixture/guide", thinking: "low" },
    "implementation.executor": { model: "fixture/executor", thinking: "xhigh" },
    "consultation.advisor": [{ model: "fixture/advisor", thinking: "off" }],
  },
};
interface Fixture {
  readonly repository: { projectRoot: string; gitCommonDir: string };
  readonly policyPath: string;
}

async function withFixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-frontier-"));
  const projectRoot = join(parent, "project");
  const gitCommonDir = join(projectRoot, ".git");
  await mkdir(gitCommonDir, { recursive: true, mode: 0o700 });
  await chmod(projectRoot, 0o700);
  await chmod(gitCommonDir, 0o700);
  const policyPath = join(parent, "models.json");
  await writeFile(policyPath, `${JSON.stringify(POLICY)}\n`, { mode: 0o600 });
  try {
    await run({ repository: { projectRoot, gitCommonDir }, policyPath });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function runCanonical<A, E>(
  program: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
  clock?: Clock.Clock,
): Promise<A> {
  const withClock =
    clock === undefined ? program : Effect.provideService(program, Clock.Clock, clock);
  return Effect.runPromise(Effect.scoped(withClock).pipe(Effect.provide(liveLayer)));
}

const freshWorkstream = (f: Fixture) =>
  createWorkstream({
    id: ID,
    purpose: "Own the frontier.",
    repository: f.repository,
    coordinator: COORDINATOR,
    intent: {
      statement: "Own the frontier.",
      constraints: [],
      grounding: receipt(),
      recordedAt: T0,
    },
    createdAt: T0,
  });
const createStore = (state: Workstream) =>
  CanonicalWorkstreamStore.create(state).pipe(Effect.map((attachment) => attachment.store));
const openStore = (f: Fixture) =>
  CanonicalWorkstreamStore.open(ID, f.repository).pipe(
    Effect.map((attachment) => attachment.store),
  );
const acquire = (
  f: Fixture,
  driver: ReconciliationDriver,
  extra: Partial<CanonicalRuntimeAcquisition> = {},
) =>
  CanonicalRuntime.acquire({
    id: ID,
    repository: f.repository,
    coordinator: COORDINATOR,
    policyPath: f.policyPath,
    driver,
    ...extra,
  });
const driverFrom = (handler: ReconciliationDriver["reconcile"]): ReconciliationDriver => ({
  reconcile: handler,
});
const waitFor = (condition: Effect.Effect<boolean>): Effect.Effect<Option.Option<void>> =>
  Effect.gen(function* () {
    while (!(yield* condition)) yield* Effect.sleep("5 millis");
  }).pipe(Effect.timeoutOption("3 seconds"));
const expectSome = (option: Option.Option<unknown>) => assert.equal(Option.isSome(option), true);
const awaitKind = (runtime: CanonicalRuntime, kind: string, attemptId: string) =>
  waitFor(runtime.frontierSnapshot().pipe(Effect.map((entries) => has(entries, kind, attemptId))));

/** One fresh store plus its runtime, closed after the body settles. */
async function withRuntime(
  f: Fixture,
  options: {
    readonly driver: ReconciliationDriver;
    readonly extra?: Partial<CanonicalRuntimeAcquisition>;
    readonly clock?: Clock.Clock;
    readonly initial?: (f: Fixture) => Workstream;
  },
  body: (
    runtime: CanonicalRuntime,
  ) => Effect.Effect<void, CanonicalRuntimeError, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Promise<void> {
  await runCanonical(
    Effect.gen(function* () {
      yield* createStore((options.initial ?? freshWorkstream)(f));
      const runtime = yield* acquire(f, options.driver, options.extra ?? {});
      yield* body(runtime);
      yield* runtime.close();
    }),
    options.clock,
  );
}

void test("a control commit is exact-key and runtime-owned, while unchanged waiting is retained", async () => {
  const contexts: ReconciliationContext[] = [];
  const attention: string[] = [];
  let holdWait = false;
  const driver = driverFrom((entry, control) =>
    Effect.gen(function* () {
      if (entry.kind !== "queued") return { kind: "waiting" } as const;
      const objective = control.context().task.objective;
      if (objective === "Wait") {
        if (holdWait) return yield* Effect.never;
        return { kind: "waiting" } as const;
      }
      contexts.push(control.context());
      yield* control.checkOwnership;
      assert.equal(
        (yield* control.commit({ kind: "activate", placement: SHARED })).kind,
        "committed",
      );
      // A stale outcome, or a failure, after a commit must not block or erase it.
      if (objective === "Fail")
        return yield* new ReconciliationDriverError({ detail: "controlled driver failure" });
      return { kind: "blocked", detail: "activation committed" } as const;
    }),
  );
  const extra = {
    onReconciliationAttention: (detail: string) => Effect.sync(() => attention.push(detail)),
  };
  await withFixture((f) =>
    withRuntime(f, { driver, extra }, (runtime) =>
      Effect.gen(function* () {
        const enqueue = (objective: string) =>
          runtime.enqueue({
            taskId: `task-${objective}`,
            kind: "research",
            objective,
            expectedEvidence: ["evidence"],
          });
        const activating = yield* enqueue("Activate");
        const activateTask = activating.tasks[0]?.id ?? assert.fail("task");
        const activateId = activating.tasks[0]?.attempts[0]?.id ?? assert.fail("attempt");
        const waitId = (yield* enqueue("Wait")).tasks[1]?.attempts[0]?.id ?? assert.fail("attempt");
        const failId = (yield* enqueue("Fail")).tasks[2]?.attempts[0]?.id ?? assert.fail("attempt");
        expectSome(yield* awaitKind(runtime, "placement_recovery", activateId));
        expectSome(yield* awaitKind(runtime, "placement_recovery", failId));
        expectSome(
          yield* waitFor(
            Effect.sync(() => attention.some((item) => item.includes("controlled driver failure"))),
          ),
        );
        const current = yield* runtime.read();
        const attempt = findAttempt(
          findTask(current, activateTask) ?? assert.fail("task"),
          activateId,
        );
        assert.equal(attempt?.state, "active");
        assert.deepEqual(attempt?.execution?.placement, SHARED);
        assert.equal(attempt?.execution?.submission, "not_sent");
        // Context is the exact key with the immutable Task contract and no siblings.
        const context = contexts[0] ?? assert.fail("context");
        assert.equal(context.workstreamId, ID);
        assert.equal(context.attempt.id, activateId);
        assert.equal(context.intent.index, 0);
        assert.equal("attempts" in context.task, false);
        // Both replacements survive; the unchanged waiting obligation is retained.
        const entries = yield* runtime.frontierSnapshot();
        assert.equal(has(entries, "queued", activateId), false);
        assert.equal(has(entries, "queued", waitId), true);
        assert.equal(has(entries, "placement_recovery", failId), true);
        assert.equal(
          attention.some((item) => item.includes("queued remains unresolved")),
          true,
        );
        const blocked = yield* runtime.inspectionSnapshot();
        const waiting = blocked.reconciliation.find((item) => item.entry.key.attemptId === waitId);
        assert.equal(
          waiting?.blockedReason,
          "queued remains unresolved without an exact identity.",
        );
        assert.ok(waiting !== undefined);
        Reflect.set(waiting.entry.key, "attemptId", "mutated-inspection");
        assert.ok(
          (yield* runtime.inspectionSnapshot()).reconciliation.some(
            (item) => item.entry.key.attemptId === waitId,
          ),
        );
        holdWait = true;
        yield* runtime.reconcile();
        for (let spin = 0; spin < 20; spin += 1) yield* Effect.yieldNow;
        const cleared = yield* runtime.inspectionSnapshot();
        assert.equal(
          cleared.reconciliation.find((item) => item.entry.key.attemptId === waitId)?.blockedReason,
          undefined,
        );
        cleared.workstream.tasks.length = 0;
        assert.notEqual((yield* runtime.inspectionSnapshot()).workstream.tasks.length, 0);
      }),
    ),
  );
});

/** One retained research artifact reused by the review-input boundary check. */
const REVIEW_ARTIFACT: RetainedArtifact = {
  id: "art-1",
  kind: "reference",
  reference: "/tmp/retained-artifact",
  retention: "retained",
  summary: "Retained review artifact.",
};

function reviewTaskFor(id: string, subject: Extract<Task, { kind: "review" }>["subject"]): Task {
  return {
    id,
    kind: "review",
    objective: `Review ${id}`,
    intentIndex: 0,
    createdAt: T0,
    subject,
    concern: "Review the referenced canonical content.",
    attempts: [
      {
        id: `${id}-a`,
        state: "queued",
        createdAt: T0,
        updatedAt: T0,
        selection: {
          role: "review",
          target: { model: "fixture/review", thinking: "high" },
          source: "policy",
        },
      },
    ],
  };
}

/** Two settled Outcomes plus the review Tasks that reference them by exact identity. */
function reviewWorkstream(f: Fixture): Workstream {
  let ws = freshWorkstream(f);
  const settle = (id: string, artifacts: readonly RetainedArtifact[] = []) => {
    const key = KEY(id, `${id}-a`);
    ws = createTask(ws, taskFor(id, 0), T0);
    ws = activate(ws, key, SHARED);
    ws = terminalizeAttempt(ws, key, { ...reported(), artifacts: [...artifacts] }, T0);
    return key;
  };
  settle("first", [REVIEW_ARTIFACT]);
  settle("second");
  const outcomeId = (id: string) => {
    const task = findTask(ws, id) ?? assert.fail(`task ${id}`);
    const attempt = findAttempt(task, `${id}-a`) ?? assert.fail(`attempt ${id}`);
    return (attempt.outcome ?? assert.fail(`outcome ${id}`)).id;
  };
  const firstOutcomeId = outcomeId("first");
  const secondOutcomeId = outcomeId("second");
  ws = createTask(
    ws,
    reviewTaskFor("compare", {
      kind: "comparison",
      outcomeIds: [secondOutcomeId, firstOutcomeId],
    }),
    T0,
  );
  ws = createTask(
    ws,
    reviewTaskFor("by-artifact", {
      kind: "artifact",
      outcomeId: firstOutcomeId,
      artifactId: REVIEW_ARTIFACT.id,
    }),
    T0,
  );
  // The store fixture owns revision 0 for a freshly created aggregate.
  return { ...ws, revision: 0 };
}

void test("a review dispatch context resolves only the referenced canonical content", async () => {
  const inputs = new Map<string, ReconciliationContext["reviewInput"]>();
  const driver = driverFrom((_entry, control) =>
    Effect.sync(() => {
      const exposed = control.context();
      if (exposed.task.kind !== "review") return { kind: "waiting" } as const;
      // Mutating one defensive clone never reaches a later exact-key read.
      const mutated = control.context().reviewInput;
      if (mutated?.kind === "artifact") Object.assign(mutated.outcome, { id: "mutated" });
      inputs.set(exposed.task.id, exposed.reviewInput);
      return { kind: "waiting" } as const;
    }),
  );
  await withFixture((f) =>
    withRuntime(f, { driver, initial: reviewWorkstream }, (runtime) =>
      Effect.gen(function* () {
        expectSome(yield* waitFor(Effect.sync(() => inputs.size === 2)));
        const durable = yield* runtime.read();
        const outcomeOf = (id: string) => {
          const task = durable.tasks.find((item) => item.id === id) ?? assert.fail(`task ${id}`);
          return task.attempts[0]?.outcome ?? assert.fail(`outcome ${id}`);
        };
        assert.deepEqual(inputs.get("by-artifact"), {
          kind: "artifact",
          outcome: outcomeOf("first"),
          artifact: REVIEW_ARTIFACT,
        });
        // Comparison preserves declared order rather than any projection order.
        const comparison = inputs.get("compare");
        assert.equal(comparison?.kind, "comparison");
        if (comparison?.kind !== "comparison") assert.fail("comparison input");
        assert.deepEqual(
          comparison.outcomes.map((outcome) => outcome.id),
          [outcomeOf("second").id, outcomeOf("first").id],
        );
      }),
    ),
  );
});

void test("a coalesced wake never blocks a commit while the single driver fiber is busy", async () => {
  const entered = await Effect.runPromise(Deferred.make<void>());
  const gate = await Effect.runPromise(Deferred.make<void>());
  const seen: string[] = [];
  const driver = driverFrom((entry) =>
    Effect.gen(function* () {
      seen.push(entry.key.attemptId);
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(gate);
      return { kind: "waiting" } as const;
    }),
  );
  await withFixture((f) =>
    withRuntime(f, { driver }, (runtime) =>
      Effect.gen(function* () {
        yield* runtime.enqueue({
          taskId: "queued-canonical-frontier.test-1",
          kind: "research",
          objective: "Gated",
          expectedEvidence: ["evidence"],
        });
        yield* Deferred.await(entered);
        // Five more commits land while the scheduler fiber is blocked in one
        // dispatch: a blocking bounded wake would hang these commits.
        const burst = yield* Effect.all(
          Array.from({ length: 5 }, (_, index) =>
            runtime.enqueue({
              taskId: `queued-canonical-frontier.test-${index + 2}`,
              kind: "research",
              objective: `Burst ${index}`,
              expectedEvidence: ["evidence"],
            }),
          ),
        ).pipe(Effect.timeoutOption("3 seconds"));
        expectSome(burst);
        yield* Deferred.succeed(gate, undefined);
        expectSome(yield* waitFor(Effect.sync(() => new Set(seen).size === 6)));
        assert.equal(seen.length, 6);
      }),
    ),
  );
});

void test("Intent revision removes every superseded queued key before a blocked dispatch resumes", async () => {
  const entered = await Effect.runPromise(Deferred.make<void>());
  const gate = await Effect.runPromise(Deferred.make<void>());
  const seen: string[] = [];
  const attention: string[] = [];
  const driver = driverFrom((entry) =>
    Effect.gen(function* () {
      seen.push(entry.key.attemptId);
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(gate);
      return { kind: "waiting" } as const;
    }),
  );
  await withFixture((f) =>
    withRuntime(
      f,
      {
        driver,
        extra: { onReconciliationAttention: (detail) => Effect.sync(() => attention.push(detail)) },
      },
      (runtime) =>
        Effect.gen(function* () {
          yield* runtime.enqueue({
            taskId: "old-first",
            kind: "research",
            objective: "Block dispatch",
            expectedEvidence: ["evidence"],
          });
          yield* Deferred.await(entered);
          const queued = yield* runtime.enqueue({
            taskId: "old-second",
            kind: "research",
            objective: "Must become stale",
            expectedEvidence: ["evidence"],
          });
          const staleId = queued.tasks[1]?.attempts[0]?.id ?? assert.fail("stale Attempt");
          assert.equal(has(yield* runtime.frontierSnapshot(), "queued", staleId), true);
          yield* runtime.reviseIntent({
            statement: "Replace queued work.",
            constraints: [],
            grounding: { ...receipt(), id: "receipt-2", text: "Replace queued work." },
            recordedAt: T1,
          });
          assert.deepEqual(yield* runtime.frontierSnapshot(), []);
          yield* Deferred.succeed(gate, undefined);
          for (let spin = 0; spin < 100; spin += 1) yield* Effect.yieldNow;
          assert.deepEqual(seen, [queued.tasks[0]?.attempts[0]?.id]);
          assert.deepEqual(attention, []);
        }),
    ),
  );
});

/** One active ready Worker identity plus one finished Attempt with a pending delivery. */
function clockWorkstream(f: Fixture): Workstream {
  const intent = { statement: "Time it.", constraints: [], grounding: receipt(), recordedAt: T0 };
  let ws = createWorkstream({
    id: ID,
    purpose: "Time it.",
    repository: f.repository,
    coordinator: COORDINATOR,
    intent,
    createdAt: T0,
  });
  const polling = KEY("wp", "wp-a");
  ws = createTask(ws, taskFor("wp", 0), T0);
  ws = toReady(activate(ws, polling, SHARED), polling, SHARED.path);
  const delivery = KEY("dl", "dl-a");
  ws = createTask(ws, taskFor("dl", 0), T0);
  ws = activate(ws, delivery, SHARED);
  ws = terminalizeAttempt(ws, delivery, reported(), T1);
  ws = checkpointCleanup(ws, delivery, { state: "completed", workerClosed: true }, T1);
  return { ...ws, revision: 0 };
}

void test("TestClock polls exact workers and retries delivery through the runtime control", async () => {
  const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));
  const start = Date.parse(T0);
  await Effect.runPromise(clock.setTime(start));
  const workerCalls: number[] = [];
  const deliveryCalls: number[] = [];
  const driver = driverFrom((entry, control) =>
    Effect.gen(function* () {
      const millis = (yield* Clock.currentTimeMillis) - start;
      if (entry.kind === "worker_poll") workerCalls.push(millis);
      if (entry.kind === "delivery") {
        deliveryCalls.push(millis);
        assert.equal(
          (yield* control.commit({ kind: "record_delivery_failure", detail: "boom" })).kind,
          "committed",
        );
      }
      return { kind: "waiting" } as const;
    }),
  );
  const advance = (millis: number, expected: number) =>
    Effect.gen(function* () {
      yield* clock.adjust(`${millis} millis`);
      let reached = workerCalls.length + deliveryCalls.length >= expected;
      for (let spin = 0; spin < 20_000 && !reached; spin += 1) {
        yield* Effect.yieldNow;
        reached = workerCalls.length + deliveryCalls.length >= expected;
      }
      assert.equal(reached, true, `expected ${expected} dispatches at ${millis}`);
      // Let the scheduler finish applying every outcome and install its next
      // deadline before the clock advances again.
      for (let spin = 0; spin < 100; spin += 1) yield* Effect.yieldNow;
    });
  await withFixture((f) =>
    withRuntime(f, { driver, clock, initial: clockWorkstream }, (runtime) =>
      Effect.gen(function* () {
        // A committed failure replaces the due entry with a one-second wait.
        yield* advance(0, 2);
        assert.deepEqual(workerCalls, [0]);
        assert.deepEqual(deliveryCalls, [0]);
        const observed = yield* runtime.inspectionSnapshot();
        assert.equal(observed.workstream.revision, 1);
        assert.deepEqual(
          observed.reconciliation.map((item) => item.deadlineAt),
          [T1, T1],
        );
        yield* advance(1_000, 4);
        yield* advance(1_000, 5);
        // The second failure doubles the wait to two seconds.
        yield* advance(1_000, 7);
        // The third failure doubles again to four seconds; the owner keeps retrying.
        yield* advance(1_000, 8);
        yield* advance(1_000, 9);
        yield* advance(1_000, 10);
        yield* advance(1_000, 12);
        assert.deepEqual(workerCalls, [0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000]);
        assert.deepEqual(deliveryCalls, [0, 1_000, 3_000, 7_000]);
      }),
    ),
  );
});

void test("stable history sleeps without aggregate reads; manual reconcile alone rebuilds", async () => {
  const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));
  await Effect.runPromise(clock.setTime(Date.parse(T0)));
  const calls: string[] = [];
  const driver = driverFrom((entry) =>
    Effect.sync(() => {
      calls.push(entry.key.attemptId);
      return { kind: "waiting" } as const;
    }),
  );
  await withFixture((f) =>
    withRuntime(f, { driver, clock, extra: { heartbeatInterval: "5 seconds" } }, (runtime) =>
      Effect.gen(function* () {
        const store = yield* openStore(f);
        assert.deepEqual(yield* runtime.frontierSnapshot(), []);
        yield* clock.adjust("10 seconds");
        yield* Effect.yieldNow;
        assert.deepEqual(calls, []);
        // A direct store commit bypasses the affected-key hook: sleeping must not
        // read the aggregate, so the frontier stays empty and the driver idle.
        const lease = yield* store.observeLease();
        assert.ok(lease !== undefined);
        yield* store.transition(lease, (current) => createTask(current, taskFor("direct", 0), T1));
        yield* clock.adjust("10 seconds");
        yield* Effect.yieldNow;
        assert.deepEqual(calls, []);
        assert.deepEqual(yield* runtime.frontierSnapshot(), []);
        // One manual reconcile performs the authoritative read and full rebuild.
        assert.deepEqual(kinds(yield* runtime.reconcile()), ["queued:direct-a"]);
        for (let spin = 0; spin < 20 && calls.length === 0; spin += 1) yield* Effect.yieldNow;
        assert.deepEqual(calls, ["direct-a"]);
      }),
    ),
  );
});

void test("close interrupts and joins driver work before the lease is released", async () => {
  await withFixture(async (f) => {
    const entered = await Effect.runPromise(Deferred.make<void>());
    await runCanonical(
      Effect.gen(function* () {
        yield* createStore(freshWorkstream(f));
        const store = yield* openStore(f);
        let leaseHeldAtInterrupt: boolean | undefined;
        const driver = driverFrom(() =>
          Effect.gen(function* () {
            // `onInterrupt` installs its finalizer before this inner effect runs,
            // so signalling `entered` here proves the finalizer is armed.
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                leaseHeldAtInterrupt = (yield* store.observeLease()) !== undefined;
              }).pipe(Effect.orDie),
            ),
          ),
        );
        const runtime = yield* acquire(f, driver);
        yield* runtime.enqueue({
          taskId: "queued-canonical-frontier.test-3",
          kind: "research",
          objective: "Interrupt",
          expectedEvidence: ["evidence"],
        });
        yield* Deferred.await(entered);
        yield* runtime.close();
        assert.equal(leaseHeldAtInterrupt, true);
        assert.equal(yield* store.observeLease(), undefined);
      }),
    );
  });
});
