import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The Linux-gated closure test observes the process file-descriptor table.
import { readdirSync, readlinkSync } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- These flows exercise real private SQLite storage and the required policy file at the node:test boundary.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Fixture paths are real host repository identities.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  type FileSystem,
  Option,
  type Path,
  Scope,
} from "effect";
import { TestClock } from "effect/testing";
import { Value } from "typebox/value";
import { CanonicalCommandError, type CanonicalCommandPorts } from "../src/canonical-commands.js";
import {
  CanonicalAppendCommandSchema,
  CanonicalEnqueueCommandSchema,
} from "../src/canonical-queue.js";
import type {
  ReconciliationCommit,
  ReconciliationDriver,
  ReconciliationMutation,
  ReconciliationOutcome,
} from "../src/canonical-reconciliation.js";
import {
  CanonicalRuntime,
  type CanonicalRuntimeAcquisition,
  type CanonicalRuntimeError,
  CanonicalRuntimeIdentityError,
  CanonicalRuntimeLeaseError,
  CanonicalRuntimeOperationError,
  CanonicalRuntimeStaleError,
  CanonicalRuntimeStoppedError,
} from "../src/canonical-runtime.js";
import {
  CANONICAL_RUNTIME_GENERATION_PROTOCOL,
  closeRuntimeGeneration,
  publishRuntimeGeneration,
  type RuntimeGenerationEntry,
  reserveRuntimeGenerationPath,
  resetRuntimeGenerationRegistryForTest,
  runtimeGeneration,
  unregisterRuntimeGeneration,
} from "../src/canonical-runtime-generation.js";
import {
  CanonicalStoreConflictError,
  type CanonicalStoreError,
  CanonicalStoreInvalidError,
  CanonicalWorkstreamStore,
} from "../src/canonical-workstream-store.js";
import {
  type Attempt,
  activateAttempt,
  type CoordinatorIdentity,
  checkpointCleanup,
  checkpointOutputRelease,
  createTask,
  createWorkstream,
  type Intent,
  type RepositoryIdentity,
  recordDeliverySuccess,
  recordWorkerExecution,
  type TerminalObservation,
  terminalizeAttempt,
  type Workstream,
} from "../src/domain/workstream.js";
import type { ModelPolicy } from "../src/model-policy.js";
import { liveLayer } from "../src/node-platform.js";

const ID = "runtime";
const COORDINATOR: CoordinatorIdentity = {
  sessionId: "coordinator-a",
  sessionFile: "/sessions/coordinator-a.jsonl",
};
const OTHER: CoordinatorIdentity = {
  sessionId: "coordinator-b",
  sessionFile: "/sessions/coordinator-b.jsonl",
};
const T0 = "2024-01-01T00:00:00.000Z";
const START_MILLIS = 1_700_000_000_000;
const DEAD_OBSERVED_AT = "2023-11-14T22:13:20.000Z";
const BASE_REVISION = "a".repeat(40);
const RESEARCH = { model: "fixture/research", thinking: "high" } as const;
const POLICY: ModelPolicy = {
  version: 6,
  roles: {
    research: [RESEARCH, { model: "fixture/research-2", thinking: "medium" }],
    review: [
      { model: "fixture/review", thinking: "high" },
      { model: "fixture/review-2", thinking: "low" },
    ],
    "implementation.guide": { model: "fixture/guide", thinking: "low" },
    "implementation.executor": { model: "fixture/executor", thinking: "xhigh" },
    "consultation.advisor": [
      { model: "fixture/advisor", thinking: "off" },
      { model: "fixture/advisor-2", thinking: "medium" },
    ],
  },
};
const ESCALATED_POLICY: ModelPolicy = {
  ...POLICY,
  roles: {
    ...POLICY.roles,
    "implementation.escalationExecutor": { model: "fixture/escalation", thinking: "max" },
  },
};

interface Fixture {
  readonly parent: string;
  readonly repository: RepositoryIdentity;
  readonly policyPath: string;
}

async function withFixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-runtime-"));
  const projectRoot = join(parent, "project");
  const gitCommonDir = join(projectRoot, ".git");
  await mkdir(gitCommonDir, { recursive: true, mode: 0o700 });
  await chmod(projectRoot, 0o700);
  await chmod(gitCommonDir, 0o700);
  const policyPath = join(parent, "models.json");
  await writePolicy(policyPath, POLICY);
  try {
    await run({ parent, repository: { projectRoot, gitCommonDir }, policyPath });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function writePolicy(path: string, policy: ModelPolicy): Promise<void> {
  return writeFile(path, `${JSON.stringify(policy)}\n`, { mode: 0o600 });
}

/** Run one program under a real caller Scope, optionally with a virtual Clock. */
function runCanonical<A, E>(
  program: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
  clock?: Clock.Clock,
): Promise<A> {
  const withClock =
    clock === undefined ? program : Effect.provideService(program, Clock.Clock, clock);
  return Effect.runPromise(Effect.scoped(withClock).pipe(Effect.provide(liveLayer)));
}

function deadObservation(subject = COORDINATOR) {
  return {
    subject,
    observedAt: DEAD_OBSERVED_AT,
    source: "herdr_api_snapshot_dead" as const,
  };
}

function generationLease(token: string, owner = COORDINATOR) {
  return {
    token,
    owner,
    acquiredAt: DEAD_OBSERVED_AT,
    heartbeatAt: DEAD_OBSERVED_AT,
    expiresAt: T0,
  };
}

function initialWorkstream(f: Fixture, coordinator = COORDINATOR): Workstream {
  const statement = "Own the canonical runtime.";
  const first: Intent = {
    statement,
    constraints: [],
    grounding: {
      kind: "human_input_receipt",
      id: "receipt-1",
      sessionId: coordinator.sessionId,
      sessionFile: coordinator.sessionFile,
      source: "interactive",
      text: statement,
      receivedAt: T0,
    },
    recordedAt: T0,
  };
  return createWorkstream({
    id: ID,
    purpose: statement,
    repository: f.repository,
    coordinator,
    intent: first,
    createdAt: T0,
  });
}

function canonicalCreate(f: Fixture, coordinator = COORDINATOR) {
  return CanonicalWorkstreamStore.create(initialWorkstream(f, coordinator)).pipe(
    Effect.map((attachment) => attachment.store),
  );
}

function openStore(f: Fixture) {
  return CanonicalWorkstreamStore.open(ID, f.repository).pipe(
    Effect.map((attachment) => attachment.store),
  );
}

function acquire(
  f: Fixture,
  coordinator: CoordinatorIdentity = COORDINATOR,
  extra: Partial<CanonicalRuntimeAcquisition> = {},
): Effect.Effect<
  CanonicalRuntime,
  CanonicalRuntimeError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  return CanonicalRuntime.acquire({
    id: ID,
    repository: f.repository,
    coordinator,
    policyPath: f.policyPath,
    driver: INERT_DRIVER,
    commands: COMMANDS,
    ownership: { kind: "attach" },
    ...extra,
  });
}

/**
 * The explicit inert driver for runtime command tests: it makes no external effect
 * and never commits, so the transient scheduler stays quiet. Frontier and
 * timing behavior is exercised separately with controlled drivers.
 */
const INERT_DRIVER: ReconciliationDriver = {
  reconcile: (): Effect.Effect<ReconciliationOutcome> => Effect.succeed({ kind: "waiting" }),
};

const COMMANDS: CanonicalCommandPorts = {
  git: {
    resolveRevision: (revision) => Effect.succeed(revision === "HEAD" ? BASE_REVISION : revision),
    head: Effect.succeed(BASE_REVISION),
    cleanHead: Effect.succeed(BASE_REVISION),
    validateCandidate: (placement, rootCommit, commit) =>
      Effect.succeed({ commit, rootCommit, commits: [commit], changedFiles: [], placement }),
    preflightCandidateApplication: () =>
      Effect.succeed({ expectedRef: "refs/heads/main", expectedHead: BASE_REVISION }),
    prepareCandidateApplication: (source, destination) =>
      Effect.succeed({ destination, action: { kind: "fast-forward", target: source.commit } }),
    // oxlint-disable-next-line effecttsgo/effect-succeed-with-void -- The port distinguishes a safe-retry undefined value from a void operation.
    recoverCandidateApplication: () => Effect.succeed<{ head: string } | undefined>(undefined),
    applyCandidate: (prepared) =>
      Effect.succeed(
        prepared.action.kind === "already-integrated"
          ? prepared.action.revision
          : prepared.action.target,
      ),
    releaseOutput: (placement, expectedHead) =>
      Effect.succeed({
        state: "completed",
        path: placement.path,
        branch: placement.branch,
        expectedHead,
        detail: "released",
      }),
  },
  workers: { steer: () => Effect.void },
};

/** The one attachment read plus the ready runtime, in the caller Scope. */
function attached(f: Fixture, extra: Partial<CanonicalRuntimeAcquisition> = {}) {
  return Effect.gen(function* () {
    const store = yield* canonicalCreate(f);
    const runtime = yield* acquire(f, COORDINATOR, extra);
    return { store, runtime };
  });
}

function reported(statement: string): TerminalObservation {
  return {
    kind: "reported",
    observedAt: T0,
    artifacts: [],
    deliveryRequestedAt: T0,
    report: {
      kind: "research",
      status: "completed",
      summary: `${statement} reported.`,
      evidence: [],
      findings: [],
    },
  };
}

function waitFor(condition: () => boolean): Effect.Effect<Option.Option<void>> {
  return Effect.gen(function* () {
    while (!condition()) yield* Effect.sleep("5 millis");
  }).pipe(Effect.timeoutOption("3 seconds"));
}

/** Poll the lease row until its heartbeat advances past `previous`. */
function renews(
  store: CanonicalWorkstreamStore,
  previous: string,
): Effect.Effect<Option.Option<void>, CanonicalStoreError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    while (true) {
      const lease = yield* store.observeLease();
      if (lease !== undefined && lease.heartbeatAt !== previous) return;
      yield* Effect.sleep("5 millis");
    }
  }).pipe(Effect.timeoutOption("3 seconds"));
}

/** Fault-inject one real SQLite row through this test's own private handle. */
function rawUpdate(path: string, statement: string, ...parameters: Array<string | number>): void {
  const database = new DatabaseSync(path);
  try {
    database.prepare(statement).run(...parameters);
  } finally {
    database.close();
  }
}

function models(attempts: readonly Attempt[]): string[] {
  return attempts.map((attempt) =>
    attempt.selection.role === "implementation"
      ? attempt.selection.guide.model
      : attempt.selection.target.model,
  );
}

/** Release the exact held lease from an independent, already-closed probe handle. */
function releaseLeaseExternally(
  f: Fixture,
): Effect.Effect<void, CanonicalStoreError, FileSystem.FileSystem | Path.Path> {
  return Effect.scoped(
    Effect.gen(function* () {
      const probe = yield* openStore(f);
      const lease = yield* probe.observeLease();
      assert.ok(lease !== undefined);
      yield* probe.releaseLease(lease);
    }),
  );
}

/** Open file descriptors in this process that resolve to the exact storage path. */
function handleCount(path: string): number {
  let count = 0;
  for (const descriptor of readdirSync("/proc/self/fd"))
    try {
      if (readlinkSync(join("/proc/self/fd", descriptor)) === path) count += 1;
    } catch {
      // A descriptor can close between listing and reading; ignore it.
    }
  return count;
}

void test("runtime generation registry exposes one stable protocol and deterministic isolation", () => {
  assert.equal(CANONICAL_RUNTIME_GENERATION_PROTOCOL, 1);
  resetRuntimeGenerationRegistryForTest();
});

void test("generation close is shared and stale unregister cannot remove a successor", async () => {
  let closes = 0;
  const first: RuntimeGenerationEntry = {
    protocolVersion: CANONICAL_RUNTIME_GENERATION_PROTOCOL,
    path: "/registry/stale",
    workstreamId: ID,
    coordinator: COORDINATOR,
    lease: generationLease("first"),
    status: "active",
    handle: {
      close: async () => {
        closes += 1;
        return { quiescent: true };
      },
    },
  };
  publishRuntimeGeneration(first);
  const left = closeRuntimeGeneration(first);
  const right = closeRuntimeGeneration(first);
  assert.equal(left, right);
  assert.deepEqual(await left, { quiescent: true });
  assert.equal(closes, 1);
  assert.equal(first.status, "quiescent");

  const successor: RuntimeGenerationEntry = {
    protocolVersion: CANONICAL_RUNTIME_GENERATION_PROTOCOL,
    path: first.path,
    workstreamId: first.workstreamId,
    coordinator: first.coordinator,
    lease: generationLease("successor"),
    status: "active",
    handle: first.handle,
  };
  publishRuntimeGeneration(successor);
  unregisterRuntimeGeneration(first);
  assert.equal(runtimeGeneration(first.path), successor);
});

void test("an interrupted queued reservation cannot wedge later runtime acquisition", async () => {
  await withFixture(async (f) => {
    await runCanonical(
      Effect.gen(function* () {
        const store = yield* canonicalCreate(f);
        const path = yield* CanonicalWorkstreamStore.pathFor(f.repository, ID);
        const reserved = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* Effect.forkScoped(
          Effect.scoped(
            reserveRuntimeGenerationPath(path).pipe(
              Effect.tap(() => Deferred.succeed(reserved, undefined)),
              Effect.andThen(Deferred.await(release)),
            ),
          ),
        );
        yield* Deferred.await(reserved);

        const interrupted = yield* Effect.forkScoped(Effect.scoped(acquire(f)));
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(interrupted);
        assert.equal(yield* store.observeLease(), undefined);

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        const runtime = yield* acquire(f);
        assert.notEqual(yield* store.observeLease(), undefined);
        yield* runtime.close();
      }),
    );
  });
});

void test("acquisition fences exactly one lease and rejects identity or unproven takeover", async () => {
  await withFixture(async (f) => {
    const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));
    await Effect.runPromise(clock.setTime(START_MILLIS));
    const observed = await runCanonical(
      Effect.gen(function* () {
        const store = yield* canonicalCreate(f);
        yield* store.acquireLease(COORDINATOR);
        const lease = yield* store.observeLease();
        assert.ok(lease !== undefined);
        return lease;
      }),
      clock,
    );

    const identity = await runCanonical(Effect.flip(acquire(f, OTHER)), clock);
    assert.ok(identity instanceof CanonicalRuntimeIdentityError);
    // A same-session row from another process context cannot be recovered from expiry.
    const live = await runCanonical(
      Effect.gen(function* () {
        const store = yield* openStore(f);
        const failure = yield* Effect.flip(
          acquire(f, COORDINATOR, { ownership: { kind: "recover" } }),
        );
        return { failure, lease: yield* store.observeLease() };
      }),
      clock,
    );
    assert.ok(live.failure instanceof CanonicalRuntimeLeaseError);
    assert.equal(live.failure.code, "generation_proof_missing");
    assert.deepEqual(live.lease, observed);

    await Effect.runPromise(clock.setTime(START_MILLIS + 30_001));
    const expiredWithoutProof = await runCanonical(
      Effect.flip(acquire(f, COORDINATOR, { ownership: { kind: "recover" } })),
      clock,
    );
    assert.ok(expiredWithoutProof instanceof CanonicalRuntimeLeaseError);
    assert.equal(expiredWithoutProof.code, "generation_proof_missing");
    // Failed acquisitions left the exact observed lease and aggregate untouched.
    const untouched = await runCanonical(
      Effect.gen(function* () {
        const store = yield* openStore(f);
        assert.deepEqual(yield* store.observeLease(), observed);
        return yield* store.read();
      }),
      clock,
    );
    assert.equal(untouched.revision, 0);

    const taken = await runCanonical(
      Effect.gen(function* () {
        const store = yield* openStore(f);
        yield* store.releaseLease(observed);
        const runtime = yield* acquire(f, COORDINATOR);
        yield* runtime.checkOwnership();
        assert.equal((yield* runtime.snapshot()).revision, 0);
        const state = yield* runtime.enqueue({
          taskId: "queued-canonical-runtime.test-1",
          kind: "research",
          objective: "Ready",
          expectedEvidence: ["evidence"],
        });
        const lease = yield* store.observeLease();
        yield* runtime.close();
        assert.equal(yield* store.observeLease(), undefined);
        return { state, lease };
      }),
      clock,
    );
    assert.equal(taken.lease?.owner.sessionId, COORDINATOR.sessionId);
    assert.notEqual(taken.lease?.token, observed.token);
    assert.equal(taken.state.revision, 1);
  });
});

void test("absent-lease mismatch and uncertain generation fail before runtime effects", async () => {
  await withFixture(async (f) => {
    let driverEffects = 0;
    let closeEffects = 0;
    const driver: ReconciliationDriver = {
      reconcile: () =>
        Effect.sync(() => {
          driverEffects += 1;
          return { kind: "waiting" } as const;
        }),
    };
    await runCanonical(
      Effect.gen(function* () {
        const store = yield* canonicalCreate(f);
        const path = yield* CanonicalWorkstreamStore.pathFor(f.repository, ID);
        const handle = {
          close: async () => {
            closeEffects += 1;
            return { quiescent: true };
          },
        };
        publishRuntimeGeneration({
          protocolVersion: CANONICAL_RUNTIME_GENERATION_PROTOCOL,
          path,
          workstreamId: ID,
          coordinator: OTHER,
          lease: generationLease("mismatched", OTHER),
          handle,
          status: "quiescent",
          closeResult: Promise.resolve({ quiescent: true }),
        });
        const mismatch = yield* Effect.flip(acquire(f, COORDINATOR, { driver }));
        assert.ok(mismatch instanceof CanonicalRuntimeLeaseError);
        assert.equal(mismatch.code, "generation_proof_mismatch");
        assert.equal(yield* store.observeLease(), undefined);
        assert.equal(driverEffects, 0);

        publishRuntimeGeneration({
          protocolVersion: CANONICAL_RUNTIME_GENERATION_PROTOCOL,
          path,
          workstreamId: ID,
          coordinator: COORDINATOR,
          lease: generationLease("uncertain"),
          handle,
          status: "failed",
        });
        const uncertain = yield* Effect.flip(acquire(f, COORDINATOR, { driver }));
        assert.ok(uncertain instanceof CanonicalRuntimeLeaseError);
        assert.equal(uncertain.code, "generation_not_quiescent");
        assert.equal(yield* store.observeLease(), undefined);
        assert.equal(driverEffects, 0);

        const held = yield* store.acquireLease(COORDINATOR);
        publishRuntimeGeneration({
          protocolVersion: CANONICAL_RUNTIME_GENERATION_PROTOCOL,
          path,
          workstreamId: ID,
          coordinator: COORDINATOR,
          lease: { ...held, heartbeatAt: DEAD_OBSERVED_AT },
          handle,
          status: "quiescent",
          closeResult: Promise.resolve({ quiescent: true }),
        });
        const changed = yield* Effect.flip(
          acquire(f, COORDINATOR, { ownership: { kind: "recover" }, driver }),
        );
        assert.ok(changed instanceof CanonicalRuntimeLeaseError);
        assert.equal(changed.code, "generation_proof_mismatch");
        assert.deepEqual(yield* store.observeLease(), held);
        assert.equal(driverEffects, 0);
        assert.equal(closeEffects, 0);
        yield* store.releaseLease(held);
      }),
    );
  });
});

void test("controlled same-process reload quiesces the old runtime before fresh attachment", async () => {
  await withFixture(async (f) => {
    await runCanonical(
      Effect.gen(function* () {
        const store = yield* canonicalCreate(f);
        const first = yield* acquire(f);
        const queued = yield* first.enqueue({
          taskId: "reload-task",
          kind: "research",
          objective: "Survive controlled reload.",
          expectedEvidence: ["durable task"],
        });
        const oldLease = yield* store.observeLease();
        assert.ok(oldLease !== undefined);

        const second = yield* acquire(f, COORDINATOR, { ownership: { kind: "recover" } });
        const newLease = yield* store.observeLease();
        assert.ok(newLease !== undefined);
        assert.notEqual(newLease.token, oldLease.token);
        assert.deepEqual(newLease.owner, oldLease.owner);
        assert.equal((yield* second.read()).revision, queued.revision);
        assert.equal((yield* second.read()).tasks[0]?.id, "reload-task");
        assert.deepEqual((yield* second.read()).coordinatorTransfers, []);
        assert.ok((yield* Effect.flip(first.read())) instanceof CanonicalRuntimeStoppedError);
        assert.ok(
          (yield* Effect.flip(store.renewLease(oldLease))) instanceof CanonicalStoreConflictError,
        );
        yield* second.close();
      }),
    );
  });
});

void test("quiescent recovery re-observes a failed release and uses only expired exact-row CAS", async () => {
  await withFixture(async (f) => {
    const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));
    await Effect.runPromise(clock.setTime(START_MILLIS));
    await runCanonical(
      Effect.gen(function* () {
        yield* canonicalCreate(f);
        const first = yield* acquire(f);
        const store = yield* openStore(f);
        const observed = yield* store.observeLease();
        assert.ok(observed !== undefined);
        const path = join(
          f.repository.gitCommonDir,
          "pi-workgraph",
          "workstreams",
          ID,
          "workstream.sqlite",
        );
        const database = new DatabaseSync(path);
        database.exec(
          "CREATE TRIGGER reject_release BEFORE DELETE ON lease BEGIN SELECT RAISE(FAIL, 'release blocked'); END",
        );
        database.close();

        const blocked = yield* Effect.flip(
          acquire(f, COORDINATOR, { ownership: { kind: "recover" } }),
        );
        assert.ok(blocked instanceof CanonicalStoreConflictError);
        assert.deepEqual(yield* store.observeLease(), observed);
        assert.ok((yield* Effect.flip(first.read())) instanceof CanonicalRuntimeStoppedError);

        const cleanup = new DatabaseSync(path);
        cleanup.exec("DROP TRIGGER reject_release");
        cleanup.close();
        yield* TestClock.adjust("31 seconds");
        const recovered = yield* acquire(f, COORDINATOR, {
          ownership: { kind: "recover" },
        });
        const replacement = yield* store.observeLease();
        assert.ok(replacement !== undefined);
        assert.notEqual(replacement.token, observed.token);
        yield* recovered.close();
      }),
      clock,
    );
  });
});

void test("concurrent ordinary attachment selects exactly one runtime", async () => {
  await withFixture(async (f) => {
    await runCanonical(
      Effect.gen(function* () {
        yield* canonicalCreate(f);
        const exits = yield* Effect.all([Effect.exit(acquire(f)), Effect.exit(acquire(f))], {
          concurrency: "unbounded",
        });
        const winners = exits.filter(Exit.isSuccess);
        const losers = exits.filter(Exit.isFailure);
        assert.equal(winners.length, 1);
        assert.equal(losers.length, 1);
        const winner = winners[0];
        assert.ok(winner !== undefined && Exit.isSuccess(winner));
        yield* winner.value.close();
      }),
    );
  });
});

void test("lease absence still waits for an owned operation to join before replacement", async () => {
  await withFixture(async (f) => {
    let started = false;
    let joined = false;
    const blocking: ReconciliationDriver = {
      reconcile: () =>
        Effect.sync(() => {
          started = true;
        }).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              joined = true;
            }),
          ),
        ),
    };
    await runCanonical(
      Effect.gen(function* () {
        const store = yield* canonicalCreate(f);
        const first = yield* acquire(f, COORDINATOR, { driver: blocking });
        yield* first.enqueue({
          taskId: "joining-task",
          kind: "research",
          objective: "Hold one owned operation.",
          expectedEvidence: ["joined"],
        });
        assert.equal(Option.isSome(yield* waitFor(() => started)), true);
        assert.equal(joined, false);
        const held = yield* store.observeLease();
        assert.ok(held !== undefined);
        yield* store.releaseLease(held);
        assert.equal(yield* store.observeLease(), undefined);
        const second = yield* acquire(f, COORDINATOR, { driver: INERT_DRIVER });
        assert.equal(joined, true);
        assert.ok((yield* Effect.flip(first.read())) instanceof CanonicalRuntimeStoppedError);
        yield* second.close();
      }),
    );
  });
});

void test("different-session adoption commits ownership before startup and replay adds no transfer", async () => {
  await withFixture(async (f) => {
    const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));
    await Effect.runPromise(clock.setTime(START_MILLIS));
    await runCanonical(
      Effect.gen(function* () {
        const store = yield* canonicalCreate(f);
        const prior = yield* store.acquireLease(COORDINATOR);
        yield* TestClock.adjust("31 seconds");
        const runtime = yield* acquire(f, OTHER, {
          ownership: { kind: "adopt", deathObservation: deadObservation() },
        });
        const state = yield* runtime.read();
        assert.deepEqual(state.coordinator, OTHER);
        assert.equal(state.coordinatorTransfers.length, 1);
        assert.equal(state.coordinatorTransfers[0]?.committedRevision, 1);
        assert.ok(
          (yield* Effect.flip(store.renewLease(prior))) instanceof CanonicalStoreConflictError,
        );
        yield* runtime.close();

        const replay = yield* acquire(f, OTHER, {
          ownership: { kind: "adopt", deathObservation: deadObservation() },
        });
        assert.equal((yield* replay.read()).coordinatorTransfers.length, 1);
        yield* replay.close();
      }),
      clock,
    );
  });
});

void test("local quiescence survives transient adoption failure and permits retry", async () => {
  await withFixture(async (f) => {
    const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));
    await Effect.runPromise(clock.setTime(START_MILLIS));
    await runCanonical(
      Effect.gen(function* () {
        const store = yield* canonicalCreate(f);
        const prior = yield* acquire(f);
        const path = yield* CanonicalWorkstreamStore.pathFor(f.repository, ID);
        const blocker = new DatabaseSync(path);
        blocker.exec(
          "CREATE TRIGGER reject_adoption_retry BEFORE UPDATE ON workstream BEGIN SELECT RAISE(FAIL, 'transient adoption failure'); END",
        );
        blocker.close();

        const failed = yield* Effect.flip(
          acquire(f, OTHER, {
            ownership: { kind: "adopt", deathObservation: deadObservation() },
          }),
        );
        assert.equal(failed._tag, "CanonicalStoreHostError");
        assert.ok((yield* Effect.flip(prior.read())) instanceof CanonicalRuntimeStoppedError);
        assert.equal(yield* store.observeLease(), undefined);
        const unchanged = yield* store.read();
        assert.equal(unchanged.revision, 0);
        assert.deepEqual(unchanged.coordinatorTransfers, []);

        const cleanup = new DatabaseSync(path);
        cleanup.exec("DROP TRIGGER reject_adoption_retry");
        cleanup.close();
        const successor = yield* acquire(f, OTHER, {
          ownership: { kind: "adopt", deathObservation: deadObservation() },
        });
        const adopted = yield* successor.read();
        assert.equal(adopted.coordinatorTransfers.length, 1);
        assert.deepEqual(adopted.coordinator, OTHER);
        yield* successor.close();
      }),
      clock,
    );
  });
});

void test("the caller Scope owns runtime lifetime: abandonment closes it and another runtime reacquires", async () => {
  await withFixture(async (f) => {
    await runCanonical(
      Effect.gen(function* () {
        const store = yield* canonicalCreate(f);
        // The acquisition Scope escapes immediately, so the runtime is already
        // closed: fibers joined, lease released, SQLite handle closed.
        const escaped = yield* Effect.scoped(acquire(f));
        yield* escaped.awaitClosed();
        const stopped = yield* Effect.flip(
          escaped.enqueue({
            taskId: "escaped-late",
            kind: "research",
            objective: "Late",
            expectedEvidence: ["evidence"],
          }),
        );
        assert.ok(stopped instanceof CanonicalRuntimeStoppedError);
        assert.equal(yield* store.observeLease(), undefined);
        assert.equal((yield* store.read()).revision, 0);

        // One explicitly parallel caller Scope owns the runtime, so scope close
        // races the runtime's own finalizer through the shared idempotent
        // shutdown claim. Close completes, the exact lease is gone, and no
        // heartbeat revives it.
        const parallel = yield* Scope.make("parallel");
        const leased = yield* acquire(f, COORDINATOR, { heartbeatInterval: "10 millis" }).pipe(
          Scope.provide(parallel),
        );
        assert.notEqual(yield* store.observeLease(), undefined);
        yield* Scope.close(parallel, Exit.void);
        yield* leased.awaitClosed();
        assert.equal(yield* store.observeLease(), undefined);
        yield* Effect.sleep("60 millis");
        assert.equal(yield* store.observeLease(), undefined);
        assert.equal((yield* store.read()).revision, 0);

        // Independent reacquisition succeeds on the released exact lease.
        const runtime = yield* acquire(f);
        const state = yield* runtime.enqueue({
          taskId: "queued-canonical-runtime.test-2",
          kind: "research",
          objective: "Reacquired",
          expectedEvidence: ["evidence"],
        });
        assert.equal(state.revision, 1);
        yield* runtime.close();
        assert.equal(yield* store.observeLease(), undefined);
      }),
    );
  });
});

void test("commands materialize atomically while every public projection stays a defensive clone", async () => {
  await withFixture(async (f) => {
    await runCanonical(
      Effect.gen(function* () {
        const { store, runtime } = yield* attached(f);

        // Two valid coordinator commands issued concurrently through one runtime
        // must be serialized by the shared Semaphore: snapshot planning cannot
        // let both commands observe the same revision, so both succeed with
        // consecutive revisions and one durable Task each.
        const [alpha, beta] = yield* Effect.all(
          [
            runtime.enqueue({
              taskId: "queued-canonical-runtime.test-3",
              kind: "research",
              objective: "Alpha",
              expectedEvidence: ["alpha evidence"],
              selection: { count: 3 },
            }),
            runtime.enqueue({
              taskId: "queued-canonical-runtime.test-4",
              kind: "review",
              objective: "Beta",
              subject: { kind: "revision", revision: BASE_REVISION },
              concern: "Exact review.",
              selection: { count: 2, distinctModels: true },
            }),
          ],
          { concurrency: "unbounded" },
        );
        assert.deepEqual(
          [alpha.revision, beta.revision].sort((left, right) => left - right),
          [1, 2],
        );
        const durable = yield* runtime.read();
        assert.equal(durable.revision, 2);
        assert.equal(new Set(durable.tasks.map((task) => task.id)).size, 2);
        const researchTask = durable.tasks.find((task) => task.kind === "research");
        const reviewTask = durable.tasks.find((task) => task.kind === "review");
        assert.ok(researchTask !== undefined && reviewTask !== undefined);
        assert.equal(researchTask.attempts.length, 3);
        assert.deepEqual(models(reviewTask.attempts), ["fixture/review", "fixture/review-2"]);

        // Mutating a returned projection never reaches the runtime's snapshot.
        const snapshot = yield* runtime.snapshot();
        snapshot.revision = 999;
        snapshot.tasks.length = 0;
        const read = yield* runtime.read();
        read.revision = 998;
        assert.equal((yield* runtime.snapshot()).revision, 2);

        // Cross-kind fields are rejected without writing anything at all.
        const bytes = yield* Effect.promise(() => readFile(store.path));
        const invalid = yield* Effect.flip(
          runtime.enqueue({
            taskId: "queued-canonical-runtime.test-5",
            kind: "research",
            objective: "Bad fields",
            expectedEvidence: ["evidence"],
            acceptance: ["not a research field"],
          }),
        );
        assert.ok(invalid instanceof CanonicalRuntimeOperationError);
        assert.deepEqual(yield* Effect.promise(() => readFile(store.path)), bytes);
        assert.equal((yield* runtime.read()).revision, 2);
        yield* runtime.close();
      }),
    );
  });
});

void test("queue planning resolves policy-owned selections, atomic fanout, and configured consultation", async () => {
  await withFixture(async (f) => {
    await runCanonical(
      Effect.gen(function* () {
        const { store, runtime } = yield* attached(f);

        const research = yield* runtime.enqueue({
          taskId: "queued-canonical-runtime.test-6",
          kind: "research",
          objective: "Default research",
          expectedEvidence: ["evidence"],
        });
        assert.deepEqual(research.tasks[0]?.attempts[0]?.selection, {
          role: "research",
          target: RESEARCH,
          source: "policy",
        });
        const implementation = yield* runtime.enqueue({
          taskId: "queued-canonical-runtime.test-7",
          kind: "implementation",
          objective: "Implement",
          acceptance: ["accepted"],
          baseRevision: BASE_REVISION,
        });
        const impl = implementation.tasks[1]?.attempts[0];
        assert.equal(impl?.selection.role, "implementation");
        assert.deepEqual(impl?.selection.guide, { model: "fixture/guide", thinking: "low" });
        assert.deepEqual(impl?.selection.executor, {
          model: "fixture/executor",
          thinking: "xhigh",
        });
        assert.equal(impl?.baseRevision, BASE_REVISION);
        assert.deepEqual(impl?.candidate, { kind: "initial", rootCommit: BASE_REVISION });

        const unconfigured = yield* Effect.flip(
          runtime.enqueue({
            taskId: "queued-canonical-runtime.test-8",
            kind: "implementation",
            objective: "Escalate without configuration",
            acceptance: ["accepted"],
            useEscalationExecutor: true,
          }),
        );
        assert.ok(unconfigured instanceof CanonicalRuntimeOperationError);
        yield* Effect.promise(() => writePolicy(f.policyPath, ESCALATED_POLICY));
        const escalated = yield* runtime.enqueue({
          taskId: "queued-canonical-runtime.test-9",
          kind: "implementation",
          objective: "Escalate",
          acceptance: ["accepted"],
          useEscalationExecutor: true,
        });
        assert.deepEqual(escalated.tasks[2]?.attempts[0]?.selection, {
          role: "implementation",
          guide: { model: "fixture/guide", thinking: "low" },
          executor: { model: "fixture/escalation", thinking: "max" },
          source: "policy",
        });

        // Consultation uses the shared ordered fanout contract.
        const defaultAdvisor = yield* runtime.enqueue({
          taskId: "queued-canonical-runtime.test-10",
          kind: "consultation",
          objective: "Advise by default",
          context: "Coordinator-known context.",
        });
        assert.deepEqual(defaultAdvisor.tasks[3]?.attempts[0]?.selection, {
          role: "consultation",
          target: { model: "fixture/advisor", thinking: "off" },
          source: "policy",
        });
        const selectedAdvisor = yield* runtime.enqueue({
          taskId: "queued-canonical-runtime.test-11",
          kind: "consultation",
          objective: "Advise broadly",
          selection: { count: 2, distinctModels: true },
        });
        assert.deepEqual(models(selectedAdvisor.tasks[4]?.attempts ?? []), [
          "fixture/advisor",
          "fixture/advisor-2",
        ]);
        const beforeUnknown = yield* runtime.read();
        const invalidSelection = yield* Effect.flip(
          runtime.enqueue({
            taskId: "queued-canonical-runtime.test-12",
            kind: "consultation",
            objective: "Too many advisors",
            selection: { count: 3, distinctModels: true },
          }),
        );
        assert.ok(invalidSelection instanceof CanonicalRuntimeOperationError);
        assert.deepEqual(yield* runtime.read(), beforeUnknown);

        // The append batch is atomic: settle the first Attempt, then append N with
        // only the first carrying the requested continuation.
        const task = research.tasks[0];
        assert.ok(task !== undefined);
        const attemptId = task.attempts[0]?.id;
        assert.ok(attemptId !== undefined);
        const key = { taskId: task.id, attemptId };
        const lease = yield* store.observeLease();
        assert.ok(lease !== undefined);
        yield* store.transition(lease, (current) =>
          activateAttempt(current, key, T0, {
            placement: { kind: "shared_project", path: f.repository.projectRoot },
            submission: "not_sent",
          }),
        );
        yield* store.transition(lease, (current) =>
          recordWorkerExecution(current, key, { sessionFile: "/sessions/retained.jsonl" }, T0),
        );
        yield* store.transition(lease, (current) =>
          terminalizeAttempt(current, key, reported("Continuation"), T0),
        );
        yield* store.transition(lease, (current) =>
          checkpointCleanup(current, key, { state: "completed", workerClosed: true }, T0),
        );
        yield* store.transition(lease, (current) => recordDeliverySuccess(current, key, T0, T0));
        const batchBase = yield* runtime.read();
        const invalidContinuation = yield* Effect.flip(
          runtime.appendAttempts({ taskId: task.id, continuationOf: "missing-attempt" }),
        );
        assert.ok(invalidContinuation instanceof CanonicalCommandError);
        assert.deepEqual(yield* runtime.read(), batchBase);
        const appended = yield* runtime.appendAttempts({
          taskId: task.id,
          continuationOf: attemptId,
          selection: { count: 2 },
        });
        const attempts = appended.tasks[0]?.attempts ?? [];
        assert.equal(appended.revision, batchBase.revision + 1);
        assert.equal(attempts.length, 3);
        assert.equal(attempts[0]?.state, "finished");
        assert.equal(attempts[1]?.continuationOf, attemptId);
        assert.equal(attempts[2]?.continuationOf, undefined);
        assert.deepEqual(models(attempts.slice(1)), ["fixture/research", "fixture/research"]);

        const experiment = yield* runtime.enqueue({
          taskId: "experiment-head",
          kind: "experiment",
          objective: "Try in isolation",
          permittedEffects: ["fixture only"],
          stopCondition: "One observation",
          expectedEvidence: ["result"],
        });
        assert.equal(experiment.tasks.at(-1)?.attempts[0]?.baseRevision, BASE_REVISION);
        yield* runtime.close();
      }),
    );
  });
});

void test("serialized manual cancellation, steering, Intent revision, completion, and exact reads", async () => {
  await withFixture(async (f) => {
    const steered: string[] = [];
    const commands: CanonicalCommandPorts = {
      ...COMMANDS,
      workers: {
        steer: (_identity, instruction) =>
          Effect.sync(() => steered.push(instruction)).pipe(
            Effect.andThen(
              instruction === "fail"
                ? Effect.fail(
                    new CanonicalCommandError({
                      operation: "steer Worker",
                      message: "submission failed",
                    }),
                  )
                : Effect.void,
            ),
          ),
      },
    };
    await runCanonical(
      Effect.gen(function* () {
        const { store, runtime } = yield* attached(f, { commands });
        const queued = yield* runtime.enqueue({
          taskId: "cancel-queued",
          kind: "research",
          objective: "Cancel queued",
          expectedEvidence: ["none"],
        });
        const queuedId = queued.tasks[0]?.attempts[0]?.id ?? assert.fail("attempt");
        const cancelled = yield* runtime.cancel({
          attemptId: queuedId,
          reason: "No longer needed.",
        });
        assert.equal(exactState(cancelled, queuedId).state, "finished");
        assert.equal(exactState(cancelled, queuedId).outcome?.kind, "cancelled");

        const active = yield* runtime.enqueue({
          taskId: "cancel-active",
          kind: "research",
          objective: "Cancel active",
          expectedEvidence: ["none"],
        });
        const activeId = active.tasks[1]?.attempts[0]?.id ?? assert.fail("attempt");
        const activeKey = { taskId: "cancel-active", attemptId: activeId };
        const lease = yield* store.observeLease();
        assert.ok(lease !== undefined);
        yield* store.transition(lease, (state) =>
          activateAttempt(state, activeKey, T0, {
            placement: { kind: "shared_project", path: f.repository.projectRoot },
            submission: "not_sent",
          }),
        );
        yield* runtime.read();
        const requested = yield* runtime.cancel({ attemptId: activeId, reason: "Stop safely." });
        assert.equal(exactState(requested, activeId).state, "active");
        assert.equal(exactState(requested, activeId).execution?.cancellation?.state, "requested");

        const steering = yield* runtime.enqueue({
          taskId: "steer-active",
          kind: "research",
          objective: "Steer",
          expectedEvidence: ["result"],
        });
        const steerId = steering.tasks[2]?.attempts[0]?.id ?? assert.fail("attempt");
        const steerKey = { taskId: "steer-active", attemptId: steerId };
        yield* store.transition(lease, (state) =>
          activateAttempt(state, steerKey, T0, {
            placement: { kind: "shared_project", path: f.repository.projectRoot },
            submission: "not_sent",
          }),
        );
        yield* store.transition(lease, (state) =>
          recordWorkerExecution(state, steerKey, { sessionFile: "/sessions/steer.jsonl" }, T0),
        );
        yield* store.transition(lease, (state) =>
          recordWorkerExecution(
            state,
            steerKey,
            { launch: { phase: "pane", workspaceId: "workspace", paneId: "pane" } },
            T0,
          ),
        );
        const resource = {
          workspaceId: "workspace",
          tabId: "tab",
          paneId: "pane",
          terminalId: "terminal",
          agentName: "agent",
          cwd: f.repository.projectRoot,
        } as const;
        yield* store.transition(lease, (state) =>
          recordWorkerExecution(
            state,
            steerKey,
            { launch: { phase: "resource", ...resource } },
            T0,
          ),
        );
        yield* store.transition(lease, (state) =>
          recordWorkerExecution(state, steerKey, { launch: { phase: "ready", ...resource } }, T0),
        );
        yield* runtime.read();
        const steeredState = yield* runtime.steer({
          attemptId: steerId,
          instruction: "Inspect the exact failure.",
        });
        assert.deepEqual(steered, ["Inspect the exact failure."]);
        assert.equal(exactState(steeredState, steerId).execution?.steering?.state, "submitted");
        assert.equal((yield* runtime.readAttempt(steerId)).attempt.id, steerId);
        assert.ok(
          (yield* Effect.flip(runtime.readAttempt("unknown-attempt"))) instanceof
            CanonicalRuntimeOperationError,
        );
        assert.ok(
          (yield* Effect.flip(
            runtime.steer({ attemptId: steerId, instruction: "fail" }),
          )) instanceof CanonicalCommandError,
        );
        assert.equal(
          exactState(yield* runtime.read(), steerId).execution?.steering?.state,
          "uncertain",
        );
        assert.ok(
          (yield* Effect.flip(
            runtime.steer({ attemptId: steerId, instruction: "fail" }),
          )) instanceof CanonicalCommandError,
        );
        assert.deepEqual(steered, ["Inspect the exact failure.", "fail"]);

        const revised = yield* runtime.reviseIntent({
          statement: "Revised directly.",
          constraints: ["Keep ownership."],
          recordedAt: T0,
          grounding: {
            kind: "human_input_receipt",
            id: "receipt-revised",
            sessionId: COORDINATOR.sessionId,
            sessionFile: COORDINATOR.sessionFile,
            source: "interactive",
            text: "Revised directly.",
            receivedAt: T0,
          },
        });
        assert.equal(revised.intents.length, 2);
        yield* runtime.close();
      }),
    );
  });
});

void test("completed output release re-entry finishes a matching pending cleanup", async () => {
  await withFixture(async (f) => {
    await runCanonical(
      Effect.gen(function* () {
        const store = yield* canonicalCreate(f);
        const lease = yield* store.acquireLease(COORDINATOR);
        const key = { taskId: "blocked-output", attemptId: "blocked-attempt" };
        yield* store.transition(lease, (state) =>
          createTask(
            state,
            {
              id: key.taskId,
              kind: "experiment",
              objective: "Retain uncertain output.",
              intentIndex: 0,
              createdAt: T0,
              permittedEffects: ["fixture only"],
              stopCondition: "Stopped",
              expectedEvidence: ["observation"],
              attempts: [
                {
                  id: key.attemptId,
                  state: "queued",
                  createdAt: T0,
                  updatedAt: T0,
                  baseRevision: BASE_REVISION,
                  selection: { role: "research", target: RESEARCH, source: "policy" },
                },
              ],
            },
            T0,
          ),
        );
        yield* store.transition(lease, (state) =>
          activateAttempt(state, key, T0, {
            placement: { kind: "isolated_worktree", path: "/owned/output", branch: "owned-output" },
            submission: "not_sent",
          }),
        );
        yield* store.transition(lease, (state) =>
          terminalizeAttempt(
            state,
            key,
            {
              kind: "unreported",
              observedAt: T0,
              artifacts: [],
              reason: "Worker output is uncertain.",
              deliveryRequestedAt: T0,
            },
            T0,
          ),
        );
        yield* store.transition(lease, (state) => recordDeliverySuccess(state, key, T0, T0));
        yield* store.transition(lease, (state) =>
          checkpointCleanup(
            state,
            key,
            { state: "pending", expectedHead: BASE_REVISION, workerClosed: true },
            T0,
          ),
        );
        yield* store.transition(lease, (state) =>
          checkpointOutputRelease(
            state,
            key,
            {
              state: "completed",
              expectedHead: BASE_REVISION,
              reason: "Discard inspected output.",
            },
            T0,
          ),
        );
        yield* store.releaseLease(lease);
        let releaseCalls = 0;
        const runtime = yield* acquire(f, COORDINATOR, {
          commands: {
            ...COMMANDS,
            git: {
              ...COMMANDS.git,
              releaseOutput: () =>
                Effect.sync(() => {
                  releaseCalls += 1;
                  return assert.fail("completed release must not repeat Git cleanup");
                }),
            },
          },
        });
        const completed = yield* runtime.complete({
          conclusion: "Stopped with retained output.",
          evidence: [{ label: "closure", observation: "The Worker is closed." }],
          limitations: ["Output remains retained."],
        });
        assert.equal(completed.completion?.accounting.length, 1);
        const released = yield* runtime.releaseOutput({
          attemptId: key.attemptId,
          reason: "Discard inspected output.",
        });
        const attempt = exactState(released, key.attemptId);
        assert.equal(attempt.outputRelease?.state, "completed");
        assert.equal(attempt.cleanup?.state, "completed");
        assert.equal(releaseCalls, 0);
        assert.deepEqual(released.completion?.accounting, []);
        assert.deepEqual(yield* runtime.frontierSnapshot(), []);
        yield* runtime.close();
      }),
    );
  });
});

void test("completion derives accounting and rejects later delegation", async () => {
  await withFixture(async (f) => {
    await runCanonical(
      Effect.gen(function* () {
        const { runtime } = yield* attached(f);
        const completed = yield* runtime.complete({
          conclusion: "No delegated work was required.",
          evidence: [{ label: "inspection", observation: "The intent was already satisfied." }],
          limitations: [],
        });
        assert.equal(completed.lifecycle, "completed");
        assert.deepEqual(completed.completion?.accounting, []);
        assert.ok(
          (yield* Effect.flip(
            runtime.enqueue({
              taskId: "late-task",
              kind: "research",
              objective: "Late",
              expectedEvidence: ["none"],
            }),
          )) instanceof CanonicalRuntimeOperationError,
        );
        yield* runtime.close();
        const noPorts = yield* CanonicalRuntime.acquire({
          id: ID,
          repository: f.repository,
          coordinator: COORDINATOR,
          ownership: { kind: "attach" },
          policyPath: f.policyPath,
          driver: INERT_DRIVER,
        });
        const apply = noPorts.apply({ attemptId: "unknown" });
        const release = noPorts.releaseOutput({ attemptId: "unknown", reason: "Inspect." });
        assert.ok((yield* Effect.flip(apply)) instanceof CanonicalRuntimeOperationError);
        assert.ok((yield* Effect.flip(release)) instanceof CanonicalRuntimeOperationError);
        yield* noPorts.close();
      }),
    );
  });
});

function exactState(state: Workstream, attemptId: string): Attempt {
  const attempt = state.tasks
    .flatMap((task) => task.attempts)
    .find((item) => item.id === attemptId);
  return attempt ?? assert.fail(`Missing Attempt ${attemptId}`);
}

void test("canonical queue schemas remain the strict kind-owned command owner", () => {
  assert.equal(
    Value.Check(CanonicalEnqueueCommandSchema, {
      kind: "research",
      objective: "Research",
      expectedEvidence: ["evidence"],
      acceptance: ["not a research field"],
    }),
    false,
  );
  assert.equal(
    Value.Check(CanonicalAppendCommandSchema, { taskId: "task", selection: { model: "any" } }),
    false,
  );
  for (const command of [
    {
      taskId: "research",
      kind: "research",
      objective: "Research",
      expectedEvidence: ["evidence"],
      candidateOf: "candidate",
    },
    {
      taskId: "experiment",
      kind: "experiment",
      objective: "Experiment",
      permittedEffects: ["fixture"],
      stopCondition: "done",
      expectedEvidence: ["evidence"],
      candidateOf: "candidate",
    },
    {
      taskId: "review",
      kind: "review",
      objective: "Review",
      subject: { kind: "revision", revision: BASE_REVISION },
      concern: "Safety",
      candidateOf: "candidate",
    },
    {
      taskId: "consultation",
      kind: "consultation",
      objective: "Consult",
      candidateOf: "candidate",
    },
  ])
    assert.equal(Value.Check(CanonicalEnqueueCommandSchema, command), false);
});

void test("a stale projection writes nothing until an authoritative read refreshes it", async () => {
  await withFixture(async (f) => {
    await runCanonical(
      Effect.gen(function* () {
        const { store, runtime } = yield* attached(f);
        const first = yield* runtime.enqueue({
          taskId: "queued-canonical-runtime.test-13",
          kind: "research",
          objective: "First",
          expectedEvidence: ["evidence"],
        });
        assert.equal(first.revision, 1);
        const direct = createTask(
          first,
          {
            kind: "research",
            id: "task-direct",
            objective: "Direct store commit.",
            intentIndex: 0,
            createdAt: T0,
            expectedEvidence: ["evidence"],
            attempts: [
              {
                id: "attempt-direct",
                state: "queued",
                createdAt: T0,
                updatedAt: T0,
                selection: { role: "research", target: RESEARCH, source: "policy" },
              },
            ],
          },
          T0,
        );

        // A direct store commit advances the authoritative aggregate behind the
        // runtime's committed projection.
        const lease = yield* store.observeLease();
        assert.ok(lease !== undefined);
        yield* store.transition(lease, () => direct);
        assert.equal((yield* runtime.snapshot()).revision, 1);
        const bytes = yield* Effect.promise(() => readFile(store.path));
        const stale = yield* Effect.flip(
          runtime.enqueue({
            taskId: "stale",
            kind: "research",
            objective: "Stale",
            expectedEvidence: ["evidence"],
          }),
        );
        assert.ok(stale instanceof CanonicalRuntimeStaleError);
        assert.deepEqual(yield* Effect.promise(() => readFile(store.path)), bytes);
        // The failed command left the projection untouched; only a read refreshes.
        assert.equal((yield* runtime.snapshot()).revision, 1);
        const refreshed = yield* runtime.read();
        assert.equal(refreshed.revision, 2);
        assert.equal(refreshed.tasks.length, 2);
        assert.equal((yield* runtime.snapshot()).revision, 2);

        const retried = yield* runtime.enqueue({
          taskId: "queued-canonical-runtime.test-14",
          kind: "research",
          objective: "Retried",
          expectedEvidence: ["evidence"],
        });
        assert.equal(retried.revision, 3);
        assert.equal(retried.tasks.length, 3);
        assert.equal((yield* runtime.snapshot()).revision, 3);
        yield* runtime.close();
      }),
    );
  });
});

void test("one shutdown boundary owns heartbeat, explicit close, close races, and interruption", async () => {
  await withFixture(async (f) => {
    await runCanonical(
      Effect.gen(function* () {
        const store = yield* canonicalCreate(f);

        // Explicit close is idempotent and no heartbeat survives it to re-create
        // the released lease.
        const first = yield* acquire(f, COORDINATOR, { heartbeatInterval: "10 millis" });
        yield* first.close();
        yield* first.close();
        yield* first.awaitClosed();
        assert.equal(yield* store.observeLease(), undefined);
        yield* Effect.sleep("60 millis");
        assert.equal(yield* store.observeLease(), undefined);

        // Every committed raced command is exactly one Task with one Attempt, and
        // the aggregate never advances without that Task.
        for (let index = 0; index < 3; index += 1) {
          const runtime = yield* acquire(f, COORDINATOR, { heartbeatInterval: "10 millis" });
          yield* Effect.all(
            [
              runtime.close(),
              runtime
                .enqueue({
                  taskId: "queued-canonical-runtime.test-15",
                  kind: "research",
                  objective: `Race ${index}`,
                  expectedEvidence: ["evidence"],
                })
                .pipe(Effect.exit),
            ],
            { concurrency: "unbounded" },
          );
          yield* runtime.awaitClosed();
          assert.equal(yield* store.observeLease(), undefined);
          const state = yield* store.read();
          assert.equal(state.revision, state.tasks.length);
          for (const task of state.tasks) assert.equal(task.attempts.length, 1);
        }

        // Caller interruption cancels a command through ordinary fiber interruption
        // and leaves the runtime usable and leased.
        const runtime = yield* acquire(f);
        const fiber = yield* Effect.forkChild(
          runtime
            .enqueue({
              taskId: "interrupted",
              kind: "research",
              objective: "Interrupted",
              expectedEvidence: ["evidence"],
            })
            .pipe(Effect.exit),
        );
        yield* Fiber.interrupt(fiber);
        const interrupted = yield* runtime.read();
        assert.ok(interrupted.revision === 0 || interrupted.revision === 1);
        const next = yield* runtime.enqueue({
          taskId: "queued-canonical-runtime.test-16",
          kind: "research",
          objective: "After interruption",
          expectedEvidence: ["evidence"],
        });
        assert.equal(next.revision, interrupted.revision + 1);
        yield* runtime.close();
        assert.equal(yield* store.observeLease(), undefined);

        // A divergent aggregate row is invisible to lease-only renewal and to a
        // lease-scoped ownership check; a heartbeat or ownership check that
        // reloaded history would fail and close the runtime.
        const beating = yield* acquire(f, COORDINATOR, { heartbeatInterval: "10 millis" });
        const lease = yield* store.observeLease();
        assert.ok(lease !== undefined);
        const projectedRevision = (yield* beating.snapshot()).revision;
        rawUpdate(store.path, "UPDATE workstream SET revision=? WHERE singleton=1", 99);
        yield* beating.checkOwnership();
        const inspection = yield* beating.inspectionSnapshot();
        assert.equal(inspection.workstream.revision, projectedRevision);
        const readFailure = yield* Effect.flip(beating.read());
        assert.ok(readFailure instanceof CanonicalStoreInvalidError);
        assert.ok(Option.isSome(yield* renews(store, lease.heartbeatAt)), "expected a heartbeat");
        yield* beating.close();
        assert.equal(yield* store.observeLease(), undefined);
        rawUpdate(
          store.path,
          "UPDATE workstream SET revision=? WHERE singleton=1",
          projectedRevision,
        );

        const stale = yield* acquire(f, COORDINATOR, { heartbeatInterval: "5 seconds" });
        yield* releaseLeaseExternally(f);
        const staleInspection = yield* Effect.flip(stale.inspectionSnapshot());
        assert.ok(staleInspection instanceof CanonicalStoreConflictError);
        yield* stale.close();
      }),
    );
  });
});

void test("fatal lease loss reports one typed episode, closes once, and permits reacquisition", async () => {
  await withFixture(async (f) => {
    await runCanonical(
      Effect.gen(function* () {
        const store = yield* canonicalCreate(f);
        let fatal: CanonicalRuntimeError | undefined;
        let fatalCalls = 0;
        const runtime = yield* acquire(f, COORDINATOR, {
          heartbeatInterval: "10 millis",
          onFatal: (error) =>
            Effect.sync(() => {
              fatalCalls += 1;
              fatal = error;
            }),
        });
        yield* releaseLeaseExternally(f);
        assert.ok(Option.isSome(yield* waitFor(() => fatal !== undefined)));
        assert.equal(fatalCalls, 1);
        assert.ok(fatal instanceof CanonicalStoreConflictError);
        yield* runtime.awaitClosed();
        const stopped = yield* Effect.flip(
          runtime.enqueue({
            taskId: "late",
            kind: "research",
            objective: "Late",
            expectedEvidence: ["evidence"],
          }),
        );
        assert.ok(stopped instanceof CanonicalRuntimeStoppedError);
        yield* runtime.close();
        yield* runtime.close();

        // Removing the lease table fails both renewal (the fatal episode) and the
        // lease-release finalizer, combined into one typed report.
        let combined: CanonicalRuntimeError | undefined;
        let combinedCalls = 0;
        const failing = yield* acquire(f, COORDINATOR, {
          heartbeatInterval: "10 millis",
          onFatal: (error) =>
            Effect.sync(() => {
              combinedCalls += 1;
              combined = error;
            }),
        });
        rawUpdate(store.path, "DROP TABLE lease");
        assert.ok(Option.isSome(yield* waitFor(() => combined !== undefined)));
        assert.equal(combinedCalls, 1);
        assert.ok(combined instanceof CanonicalRuntimeOperationError);
        assert.ok(combined.cause instanceof AggregateError);
        assert.ok(
          (yield* Effect.flip(failing.awaitClosed())) instanceof CanonicalRuntimeOperationError,
        );
        assert.ok((yield* Effect.flip(failing.close())) instanceof CanonicalRuntimeOperationError);
      }),
    );
  });
});

// The /proc/self/fd table only exists on Linux; elsewhere this check is skipped
// rather than silently passing without observing closure.
const FD_SKIP =
  process.platform === "linux"
    ? false
    : `file-descriptor inspection via /proc/self/fd is unavailable on ${process.platform}`;

void test("a fatal close releases the runtime's own SQLite file descriptor", {
  skip: FD_SKIP,
}, async () => {
  await withFixture(async (f) => {
    const path = await runCanonical(canonicalCreate(f).pipe(Effect.map((store) => store.path)));
    let fatal: CanonicalRuntimeError | undefined;
    await runCanonical(
      Effect.gen(function* () {
        const runtime = yield* acquire(f, COORDINATOR, {
          heartbeatInterval: "10 millis",
          onFatal: (error) =>
            Effect.sync(() => {
              fatal = error;
            }),
        });
        assert.ok(handleCount(path) >= 1, "expected the runtime SQLite handle to be open");
        yield* releaseLeaseExternally(f);
        assert.ok(Option.isSome(yield* waitFor(() => fatal !== undefined)));
        yield* runtime.awaitClosed();
        assert.equal(handleCount(path), 0, "expected the runtime SQLite handle to close");
      }),
    );
  });
});

void test("one runtime control flow drives the cancellation checkpoint, cleanup, terminalize, and replay", async () => {
  await withFixture(async (f) => {
    const SHARED = { kind: "shared_project" as const, path: "/repo" };
    const requested = { state: "requested" as const, requestedAt: T0, reason: "Stop." };
    const uncertain = { ...requested, state: "uncertain" as const, dispatchAt: T0 };
    const observed = {
      ...uncertain,
      state: "submitted_or_observed" as const,
      observedAt: T0,
      evidence: "done" as const,
    };
    const cancelled: TerminalObservation = {
      kind: "cancelled",
      observedAt: T0,
      artifacts: [],
      deliveryRequestedAt: T0,
      reason: "Stopped.",
    };
    const commits: ReconciliationCommit[] = [];
    const finishedMutation = (attempt: Attempt): ReconciliationMutation | undefined =>
      attempt.cleanup?.state === "pending"
        ? { kind: "checkpoint_cleanup", checkpoint: { state: "completed", workerClosed: true } }
        : undefined;
    const activeMutation = (attempt: Attempt): ReconciliationMutation | undefined => {
      const cancellation = attempt.execution?.cancellation;
      if (cancellation === undefined)
        return { kind: "checkpoint_cancellation", checkpoint: requested };
      if (cancellation.state === "requested")
        return { kind: "checkpoint_cancellation", checkpoint: uncertain };
      if (cancellation.state === "uncertain")
        return { kind: "checkpoint_cancellation", checkpoint: observed };
      if (attempt.cleanup === undefined)
        return { kind: "checkpoint_cleanup", checkpoint: { state: "pending", workerClosed: true } };
      return { kind: "terminalize", observation: cancelled };
    };
    const nextMutation = (attempt: Attempt): ReconciliationMutation | undefined => {
      if (attempt.state === "queued") return { kind: "activate", placement: SHARED };
      if (attempt.state === "finished") return finishedMutation(attempt);
      return activeMutation(attempt);
    };
    // The target Task's objective is the deterministic selector: the second Task is
    // deliberately left untouched so exact-key notification is observable.
    const driver: ReconciliationDriver = {
      reconcile: (_entry, control) =>
        Effect.gen(function* () {
          if (control.context().task.objective !== "Cancellable")
            return { kind: "waiting" } as const;
          const mutation = nextMutation(control.context().attempt);
          if (mutation === undefined) return { kind: "waiting" } as const;
          commits.push(yield* control.commit(mutation));
          // A replayed terminalize is a durable no-op: no revision and no notify.
          if (mutation.kind === "terminalize") commits.push(yield* control.commit(mutation));
          return { kind: "waiting" } as const;
        }),
    };

    await runCanonical(
      Effect.gen(function* () {
        const { runtime } = yield* attached(f, { driver });
        const target = yield* runtime.enqueue({
          taskId: "queued-canonical-runtime.test-17",
          kind: "research",
          objective: "Cancellable",
          expectedEvidence: ["evidence"],
        });
        const other = yield* runtime.enqueue({
          taskId: "queued-canonical-runtime.test-18",
          kind: "research",
          objective: "Untouched",
          expectedEvidence: ["evidence"],
        });
        const taskId = target.tasks[0]?.id ?? assert.fail("target task");
        const attemptId = target.tasks[0]?.attempts[0]?.id ?? assert.fail("target attempt");
        const otherId = other.tasks[1]?.attempts[0]?.id ?? assert.fail("other attempt");

        const settled = Effect.gen(function* () {
          while (true) {
            const state = yield* runtime.snapshot();
            const attempt = state.tasks[0]?.attempts[0];
            if (attempt?.state === "finished" && attempt.cleanup?.state === "completed") return;
            yield* Effect.sleep("5 millis");
          }
        }).pipe(Effect.timeoutOption("3 seconds"));
        assert.equal(Option.isSome(yield* settled), true);

        // Each control commit advanced exactly one durable revision; the replayed
        // terminalize produced one no-op receipt without a revision or a notify.
        const revisions: number[] = [];
        let firstReceiptKey: unknown;
        let noChanges = 0;
        for (const item of commits)
          if (item.kind === "committed") {
            revisions.push(item.receipt.revision);
            firstReceiptKey ??= item.receipt.key;
          } else noChanges += 1;
        assert.equal(noChanges, 1);
        assert.equal(revisions.length, 7);
        for (let index = 1; index < revisions.length; index += 1)
          assert.equal(revisions[index], (revisions[index - 1] ?? 0) + 1);
        assert.deepEqual(firstReceiptKey, { taskId, attemptId });

        // The committed projection and the authoritative read agree on the exact
        // terminal facts; the snapshot is a write-through, never authority.
        const projection = yield* runtime.snapshot();
        const authoritative = yield* runtime.read();
        assert.deepEqual(authoritative, projection);
        assert.equal(projection.revision, revisions.at(-1));
        const attempt = projection.tasks[0]?.attempts[0];
        assert.equal(attempt?.state, "finished");
        assert.equal(attempt?.outcome?.kind, "cancelled");
        assert.equal(attempt?.execution?.cancellation?.state, "submitted_or_observed");
        assert.equal(attempt?.cleanup?.state, "completed");
        assert.equal(attempt?.cleanup?.workerClosed, true);

        // Exact-key progression: only the target key advanced to its retained
        // pending delivery, while the untouched Attempt stays queued.
        const entries = yield* runtime.frontierSnapshot();
        assert.deepEqual(
          entries.filter((item) => item.key.attemptId === attemptId).map((item) => item.kind),
          ["delivery"],
        );
        assert.deepEqual(
          entries.filter((item) => item.key.attemptId === otherId).map((item) => item.kind),
          ["queued"],
        );
        yield* runtime.close();
      }),
    );
  });
});
