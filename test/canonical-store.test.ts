import assert from "node:assert/strict";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"; // oxlint-disable-line effecttsgo/node-builtin-import -- These flows exercise real private SQLite storage and host filesystem identity at the node:test boundary.
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Fixture paths are real host repository identities.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Clock, Effect, type FileSystem, type Path, type Scope } from "effect";
import { TestClock } from "effect/testing";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  CanonicalStoreConflictError,
  CanonicalStoreHostError,
  CanonicalStoreIncompleteError,
  CanonicalStoreInvalidError,
  CanonicalStoreUnsupportedError,
  CanonicalWorkstreamStore,
} from "../src/canonical-workstream-store.js";
import {
  type CoordinatorIdentity,
  completeWorkstream,
  createWorkstream,
  type Intent,
  type RepositoryIdentity,
  reviseIntent,
  type Workstream,
} from "../src/domain/workstream.js";
import { liveLayer } from "../src/node-platform.js";
import { SqliteWorkstreamDatabase } from "../src/workstream-persistence.js";
import {
  pathForWorkstream,
  WORKSTREAM_FORMAT,
  WORKSTREAM_STATE_VERSION,
} from "../src/workstream-state.js";

const ID = "canonical";
const COORDINATOR: CoordinatorIdentity = {
  sessionId: "coordinator-a",
  sessionFile: "/sessions/coordinator-a.jsonl",
};
const OWNER_B: CoordinatorIdentity = {
  sessionId: "coordinator-b",
  sessionFile: "/sessions/coordinator-b.jsonl",
};
const T0 = "2024-01-01T00:00:00.000Z";
const START_MILLIS = 1_700_000_000_000;

function runCanonical<A, E>(
  program: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
  clock?: Clock.Clock,
): Promise<A> {
  const withClock =
    clock === undefined ? program : Effect.provideService(program, Clock.Clock, clock);
  return Effect.runPromise(Effect.scoped(withClock).pipe(Effect.provide(liveLayer)));
}

interface CanonicalFixture {
  readonly parent: string;
  readonly projectRoot: string;
  readonly gitCommonDir: string;
  readonly repository: RepositoryIdentity;
}

async function canonicalFixture(parentName = "pi-workgraph-canonical-"): Promise<CanonicalFixture> {
  const parent = await mkdtemp(join(tmpdir(), parentName));
  const projectRoot = join(parent, "project");
  const gitCommonDir = join(projectRoot, ".git");
  await mkdir(gitCommonDir, { recursive: true, mode: 0o700 });
  await chmod(projectRoot, 0o700);
  await chmod(gitCommonDir, 0o700);
  return { parent, projectRoot, gitCommonDir, repository: { projectRoot, gitCommonDir } };
}

function storageDirectory(fixture: CanonicalFixture, id = ID): string {
  return join(fixture.gitCommonDir, "pi-workgraph", "workstreams", id);
}

function storagePath(fixture: CanonicalFixture, id = ID): string {
  return join(storageDirectory(fixture, id), "workstream.sqlite");
}

function canonicalPath(fixture: CanonicalFixture, id = ID): Promise<string> {
  return runCanonical(CanonicalWorkstreamStore.pathFor(fixture.repository, id));
}

function receipt(id: string, text: string): Intent["grounding"] {
  return {
    kind: "human_input_receipt",
    id,
    sessionId: COORDINATOR.sessionId,
    sessionFile: COORDINATOR.sessionFile,
    source: "interactive",
    text,
    receivedAt: T0,
  };
}

function intent(statement: string, receiptId = "receipt-1"): Intent {
  return {
    statement,
    constraints: [],
    grounding: receipt(receiptId, statement),
    recordedAt: T0,
  };
}

function initialWorkstream(fixture: CanonicalFixture, id = ID): Workstream {
  return createWorkstream({
    id,
    purpose: "Persist the canonical aggregate.",
    repository: fixture.repository,
    coordinator: COORDINATOR,
    intent: intent("Persist the canonical aggregate."),
    createdAt: T0,
  });
}

function createCanonical(fixture: CanonicalFixture, id = ID) {
  return CanonicalWorkstreamStore.create(initialWorkstream(fixture, id)).pipe(
    Effect.map((attachment) => attachment.store),
  );
}

/** A Clock whose successive millisecond reads advance by `stepMillis`. */
function steppingClock(startMillis: number, stepMillis: number): Clock.Clock {
  let reads = 0;
  const next = () => startMillis + reads++ * stepMillis;
  return {
    currentTimeMillisUnsafe: next,
    currentTimeMillis: Effect.sync(next),
    currentTimeNanosUnsafe: () => BigInt(startMillis + reads * stepMillis) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(startMillis + reads * stepMillis) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => 0n,
    monotonicTimeNanos: Effect.succeed(0n),
    sleep: () => Effect.void,
  };
}

function openCanonical(fixture: CanonicalFixture, id = ID) {
  return CanonicalWorkstreamStore.open(id, fixture.repository).pipe(
    Effect.map((attachment) => attachment.store),
  );
}

function rawDatabase<A>(path: string, run: (database: DatabaseSync) => A): A {
  const database = new DatabaseSync(path);
  try {
    return run(database);
  } finally {
    database.close();
  }
}

function rawUpdate(path: string, statement: string, ...parameters: Array<string | number>): void {
  rawDatabase(path, (database) => database.prepare(statement).run(...parameters));
}

const RawAggregateRowSchema = Type.Object(
  { state_json: Type.String() },
  { additionalProperties: false },
);

function rawStateText(path: string): string {
  return rawDatabase(path, (database) => {
    const row = database.prepare("SELECT state_json FROM workstream WHERE singleton = 1").get();
    assert.ok(Value.Check(RawAggregateRowSchema, row), "Missing canonical aggregate row.");
    return Value.Decode(RawAggregateRowSchema, row).state_json;
  });
}

/** Create a private SQLite file containing exactly the given partial schema. */
async function rawCanonicalSchema(
  fixture: CanonicalFixture,
  id: string,
  schema: string,
): Promise<void> {
  const path = storagePath(fixture, id);
  await mkdir(storageDirectory(fixture, id), { recursive: true, mode: 0o700 });
  rawDatabase(path, (database) => database.exec(schema));
  await chmod(path, 0o600);
}

async function assertPrivateModes(path: string): Promise<void> {
  assert.equal((await lstat(path)).mode & 0o777, 0o600, path);
  for (const directory of [join(path, "..", "..", ".."), join(path, "..", ".."), join(path, "..")])
    assert.equal((await lstat(directory)).mode & 0o777, 0o700, directory);
}

void test("canonical store persists a grounded workstream and attaches a completed aggregate", async () => {
  const fixture = await canonicalFixture();
  const path = await canonicalPath(fixture);
  try {
    await runCanonical(
      Effect.gen(function* () {
        const store = yield* createCanonical(fixture);
        const created = yield* store.read();
        assert.equal(created.id, ID);
        assert.equal(created.revision, 0);
        assert.equal(created.repository.gitCommonDir, fixture.gitCommonDir);
        assert.equal(created.lifecycle, "active");
        assert.equal(yield* store.observeLease(), undefined);

        const lease = yield* store.acquireLease(COORDINATOR);
        assert.deepEqual(yield* store.observeLease(), lease);
        const updated = yield* store.transition(lease, (current) =>
          reviseIntent(
            current,
            intent("Persist the revised aggregate.", "receipt-2"),
            "2024-06-01T00:00:00.000Z",
          ),
        );
        assert.equal(updated.revision, 1);
        assert.equal(updated.intents.length, 2);
        assert.equal(updated.updatedAt, "2024-06-01T00:00:00.000Z");
        yield* store.releaseLease(lease);
        assert.equal(yield* store.observeLease(), undefined);
      }),
    );

    await assertPrivateModes(path);
    assert.equal(storagePath(fixture), path);

    const reopened = await runCanonical(
      Effect.gen(function* () {
        const store = yield* openCanonical(fixture);
        return yield* store.read();
      }),
    );
    assert.equal(reopened.revision, 1);
    assert.equal(reopened.intents.length, 2);

    const completed = await runCanonical(
      Effect.gen(function* () {
        const store = yield* openCanonical(fixture);
        const lease = yield* store.acquireLease(COORDINATOR);
        const next = yield* store.transition(lease, (current) =>
          completeWorkstream(
            current,
            {
              conclusion: "The canonical aggregate is complete.",
              evidence: [{ label: "aggregate", observation: "The canonical row persisted." }],
              limitations: [],
              completedAt: "2024-07-01T00:00:00.000Z",
            },
            "2024-07-01T00:00:00.000Z",
          ),
        );
        yield* store.releaseLease(lease);
        return next;
      }),
    );
    assert.equal(completed.lifecycle, "completed");
    assert.equal(completed.revision, 2);

    const attached = await runCanonical(
      Effect.gen(function* () {
        const store = yield* openCanonical(fixture);
        const lease = yield* store.acquireLease(COORDINATOR);
        yield* store.releaseLease(lease);
        return yield* store.read();
      }),
    );
    assert.equal(attached.lifecycle, "completed");
    assert.deepEqual(attached.completion, completed.completion);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

void test("canonical lease observation, fencing, and expired takeover stay exact-observed", async () => {
  const fixture = await canonicalFixture();
  const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));
  await Effect.runPromise(clock.setTime(START_MILLIS));
  try {
    await runCanonical(
      Effect.gen(function* () {
        const store = yield* createCanonical(fixture);
        yield* store.acquireLease(COORDINATOR);
      }),
      clock,
    );

    const observed = await runCanonical(
      Effect.gen(function* () {
        const store = yield* openCanonical(fixture);
        return yield* store.observeLease();
      }),
      clock,
    );
    assert.ok(observed !== undefined, "Expected a persisted observed lease.");
    assert.equal(observed.owner.sessionId, COORDINATOR.sessionId);

    await assert.rejects(
      runCanonical(
        Effect.gen(function* () {
          const store = yield* openCanonical(fixture);
          return yield* store.acquireLease(OWNER_B);
        }),
        clock,
      ),
      /exact observed lease/,
    );
    await assert.rejects(
      runCanonical(
        Effect.gen(function* () {
          const store = yield* openCanonical(fixture);
          return yield* store.acquireLease(OWNER_B, { ...observed, token: "forged" });
        }),
        clock,
      ),
      /exact observed lease/,
    );
    await assert.rejects(
      runCanonical(
        Effect.gen(function* () {
          const store = yield* openCanonical(fixture);
          return yield* store.acquireLease(OWNER_B, observed);
        }),
        clock,
      ),
      /has not expired/,
    );
    await assert.rejects(
      runCanonical(
        Effect.gen(function* () {
          const store = yield* openCanonical(fixture);
          return yield* store.transition({ ...observed, token: "forged" }, (current) => current);
        }),
        clock,
      ),
      /fenced lease/,
    );
    await assert.rejects(
      runCanonical(
        Effect.gen(function* () {
          const store = yield* openCanonical(fixture);
          return yield* store.acquireLease({ sessionId: "", sessionFile: "" });
        }),
        clock,
      ),
      CanonicalStoreInvalidError,
    );

    await Effect.runPromise(clock.setTime(START_MILLIS + 30_001));
    const taken = await runCanonical(
      Effect.gen(function* () {
        const store = yield* openCanonical(fixture);
        return yield* store.acquireLease(OWNER_B, observed);
      }),
      clock,
    );
    assert.notEqual(taken.token, observed.token);
    assert.equal(taken.owner.sessionId, OWNER_B.sessionId);

    await assert.rejects(
      runCanonical(
        Effect.gen(function* () {
          const store = yield* openCanonical(fixture);
          return yield* store.renewLease(observed);
        }),
        clock,
      ),
      /fenced lease/,
    );
    await assert.rejects(
      runCanonical(
        Effect.gen(function* () {
          const store = yield* openCanonical(fixture);
          return yield* store.releaseLease(observed);
        }),
        clock,
      ),
      /fenced lease/,
    );
    await assert.rejects(
      runCanonical(
        Effect.gen(function* () {
          const store = yield* openCanonical(fixture);
          return yield* store.transition(
            { ...taken, expiresAt: "not-a-time" },
            (current) => current,
          );
        }),
        clock,
      ),
      /invalid instant/,
    );

    await assert.rejects(
      runCanonical(
        Effect.gen(function* () {
          const store = yield* openCanonical(fixture);
          return yield* store.transition(taken, (current) =>
            reviseIntent(current, intent("Late revision.", "receipt-late"), T0),
          );
        }),
        // The second Clock read must drive the final lease predicate, not the
        // post-lock sample taken before the callback ran.
        steppingClock(START_MILLIS + 30_001, 100_000),
      ),
      /lost its fenced lease/,
    );

    rawUpdate(storagePath(fixture), "UPDATE lease SET expires_at=? WHERE singleton=1", "later");
    await assert.rejects(
      runCanonical(
        Effect.gen(function* () {
          const store = yield* openCanonical(fixture);
          return yield* store.observeLease();
        }),
        clock,
      ),
      /malformed|invalid instant/,
    );
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

void test("canonical create and open reject unsafe, foreign, partial, malformed, and predecessor storage", async () => {
  const fixture = await canonicalFixture();
  try {
    await runCanonical(createCanonical(fixture));
    const path = storagePath(fixture);
    const validBytes = await readFile(path);

    await assert.rejects(runCanonical(openCanonical(fixture, "escape/child")), /path segment/);
    await assert.rejects(runCanonical(createCanonical(fixture)), CanonicalStoreConflictError);
    assert.deepEqual(await readFile(path), validBytes);

    const foreignPath = storagePath(fixture, "foreign");
    await mkdir(storageDirectory(fixture, "foreign"), { recursive: true, mode: 0o700 });
    await copyFile(path, foreignPath);
    await chmod(foreignPath, 0o600);
    await assert.rejects(runCanonical(openCanonical(fixture, "foreign")), /foreign/);
    assert.deepEqual(await readFile(foreignPath), validBytes);

    await chmod(path, 0o644);
    await assert.rejects(runCanonical(openCanonical(fixture)), /not private/);
    assert.deepEqual(await readFile(path), validBytes);
    await chmod(path, 0o600);

    const unsafeDirectory = storageDirectory(fixture, "unsafe");
    await mkdir(unsafeDirectory, {
      recursive: true,
      mode: 0o755,
    });
    await assert.rejects(runCanonical(createCanonical(fixture, "unsafe")), /unsafe/);

    const symlinkFixture = await canonicalFixture("pi-workgraph-symlink-");
    try {
      await symlink(symlinkFixture.parent, join(symlinkFixture.gitCommonDir, "pi-workgraph"));
      await assert.rejects(runCanonical(createCanonical(symlinkFixture)), /symbolic link/);
    } finally {
      await rm(symlinkFixture.parent, { recursive: true, force: true });
    }

    rawUpdate(path, "UPDATE store_header SET version=? WHERE singleton=1", 2);
    await assert.rejects(runCanonical(openCanonical(fixture)), CanonicalStoreUnsupportedError);
    rawUpdate(path, "UPDATE store_header SET version=? WHERE singleton=1", 1);

    rawUpdate(path, "UPDATE workstream SET revision=? WHERE singleton=1", 5);
    await assert.rejects(runCanonical(openCanonical(fixture)), /diverges/);
    rawUpdate(path, "UPDATE workstream SET revision=? WHERE singleton=1", 0);

    const malformedState = rawStateText(path).replace(`"id": "${ID}"`, `"id": 5`);
    assert.notEqual(malformedState, rawStateText(path), "Expected to corrupt the aggregate id.");
    rawUpdate(path, "UPDATE workstream SET state_json=? WHERE singleton=1", malformedState);
    await assert.rejects(runCanonical(openCanonical(fixture)), /malformed/);
    rawUpdate(path, "UPDATE workstream SET state_json=? WHERE singleton=1", "{");
    await assert.rejects(runCanonical(openCanonical(fixture)), /not valid JSON/);

    const malformedPath = storagePath(fixture, "notsqlite");
    await mkdir(storageDirectory(fixture, "notsqlite"), { recursive: true, mode: 0o700 });
    await writeFile(malformedPath, "not a database", { mode: 0o600 });
    await assert.rejects(runCanonical(openCanonical(fixture, "notsqlite")), /supported SQLite/);
    assert.equal(await readFile(malformedPath, "utf8"), "not a database");

    const emptyPath = storagePath(fixture, "empty");
    await mkdir(storageDirectory(fixture, "empty"), { recursive: true, mode: 0o700 });
    await writeFile(emptyPath, "", { mode: 0o600 });
    await assert.rejects(
      runCanonical(openCanonical(fixture, "empty")),
      CanonicalStoreIncompleteError,
    );
    await assert.rejects(
      runCanonical(createCanonical(fixture, "empty")),
      CanonicalStoreIncompleteError,
    );

    const headerOnly =
      "CREATE TABLE store_header (singleton INTEGER PRIMARY KEY, format TEXT NOT NULL, version INTEGER NOT NULL);" +
      "CREATE TABLE workstream (singleton INTEGER PRIMARY KEY, state_json TEXT NOT NULL, revision INTEGER NOT NULL);";
    await rawCanonicalSchema(fixture, "partial", headerOnly);
    await assert.rejects(
      runCanonical(openCanonical(fixture, "partial")),
      CanonicalStoreIncompleteError,
    );
    await assert.rejects(
      runCanonical(createCanonical(fixture, "partial")),
      CanonicalStoreIncompleteError,
    );

    await rawCanonicalSchema(
      fixture,
      "partialcolumn",
      `${headerOnly}CREATE TABLE lease (singleton INTEGER PRIMARY KEY, token TEXT NOT NULL);`,
    );
    await assert.rejects(
      runCanonical(openCanonical(fixture, "partialcolumn")),
      CanonicalStoreIncompleteError,
    );

    const predecessorPath = storagePath(fixture, "predecessor");
    await mkdir(storageDirectory(fixture, "predecessor"), {
      recursive: true,
      mode: 0o700,
    });
    SqliteWorkstreamDatabase.create(predecessorPath, {
      format: WORKSTREAM_FORMAT,
      version: WORKSTREAM_STATE_VERSION,
      revision: 0,
      id: "predecessor",
      purpose: "Predecessor aggregate.",
      projectRoot: fixture.projectRoot,
      gitCommonDir: fixture.gitCommonDir,
      statePath: pathForWorkstream(fixture.gitCommonDir, "predecessor"),
      coordinator: COORDINATOR,
      lifecycle: { state: "active", changedAt: T0, reason: "Predecessor created." },
      inputs: [],
      intents: [
        {
          version: 0,
          statement: "Predecessor intent.",
          constraints: [],
          authorityReceiptIds: [],
          recordedAt: T0,
        },
      ],
      assignments: [],
      results: [],
      attempts: [],
      deliveries: [],
      createdAt: T0,
      updatedAt: T0,
    });
    const predecessorBytes = await readFile(predecessorPath);
    await assert.rejects(
      runCanonical(openCanonical(fixture, "predecessor")),
      CanonicalStoreUnsupportedError,
    );
    assert.deepEqual(await readFile(predecessorPath), predecessorBytes);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

void test("canonical transition stays no-op exact, rejects invalid results, and rolls back", async () => {
  const fixture = await canonicalFixture();
  const path = storagePath(fixture);
  try {
    await runCanonical(
      Effect.gen(function* () {
        const store = yield* createCanonical(fixture);
        yield* store.acquireLease(COORDINATOR);
      }),
    );
    const bytes = await readFile(path);
    const before = await runCanonical(
      Effect.gen(function* () {
        const store = yield* openCanonical(fixture);
        return yield* store.read();
      }),
    );

    await runCanonical(
      Effect.gen(function* () {
        const store = yield* openCanonical(fixture);
        const lease = yield* store.observeLease();
        assert.ok(lease !== undefined, "Expected the recovered lease.");
        const noop = yield* store.transition(lease, (current) => current);
        assert.equal(noop.revision, before.revision);
      }),
    );
    assert.deepEqual(await readFile(path), bytes);

    const cases: ReadonlyArray<readonly [(current: Workstream) => Workstream, RegExp]> = [
      [
        (current) => ({ ...current, id: "renamed", revision: current.revision + 1 }),
        /immutable id/,
      ],
      [
        (current) => ({
          ...current,
          purpose: "Another purpose.",
          revision: current.revision + 1,
        }),
        /immutable purpose/,
      ],
      [
        (current) => ({ ...current, intents: [], revision: current.revision + 1 }),
        /invalid Workstream/,
      ],
      [(current) => ({ ...current, revision: current.revision + 2 }), /must return revision/],
    ];
    for (const [mutate, expected] of cases) {
      await assert.rejects(
        runCanonical(
          Effect.gen(function* () {
            const opened = yield* openCanonical(fixture);
            const held = yield* opened.observeLease();
            assert.ok(held !== undefined, "Expected the recovered lease.");
            return yield* opened.transition(held, mutate);
          }),
        ),
        expected,
      );
    }

    await assert.rejects(
      runCanonical(
        Effect.gen(function* () {
          const opened = yield* openCanonical(fixture);
          const held = yield* opened.observeLease();
          assert.ok(held !== undefined, "Expected the recovered lease.");
          return yield* opened.transition(held, () => {
            throw new Error("fixture transition failure");
          });
        }),
      ),
      CanonicalStoreHostError,
    );

    const after = await runCanonical(
      Effect.gen(function* () {
        const store = yield* openCanonical(fixture);
        return yield* store.read();
      }),
    );
    assert.equal(after.revision, before.revision);
    assert.equal(after.intents.length, before.intents.length);
    assert.deepEqual(await readFile(path), bytes);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});
