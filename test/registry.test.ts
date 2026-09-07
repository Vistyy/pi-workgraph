import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- These tests coordinate bounded real child processes at SQLite boundaries.
import { spawn } from "node:child_process";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- These tests use real isolated SQLite files.
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Fixture paths are native filesystem identities.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DateTime, Deferred, Effect } from "effect";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { liveLayer } from "../src/node-platform.js";
import { WorkgraphRegistry } from "../src/registry.js";
import { type StoreEffect, WorkstreamStoreEffects } from "../src/workstream.js";
// biome-ignore lint/style/useImportType: Runtime instanceof establishes the fenced lease error boundary.
import {
  LeaseDecisionRequiredError,
  SqliteWorkstreamDatabase,
} from "../src/workstream-persistence.js";
import { acquireRuntimeLease } from "../src/workstream-runtime-services.js";
import { legacyPathForWorkstream } from "../src/workstream-state.js";
import { parsePersistedObject } from "../src/workstream-validation.js";

const TableInfoRowSchema = Type.Object({ name: Type.String({ minLength: 1 }) });
const RevisionRowSchema = Type.Object({ revision: Type.Integer({ minimum: 0 }) });

function at(milliseconds: number): Date {
  return DateTime.toDate(DateTime.makeUnsafe(milliseconds));
}

function run<A>(effect: StoreEffect<A>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(liveLayer)));
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function nativeExpiry(milliseconds: number): string {
  // oxlint-disable-next-line effecttsgo/global-date -- Lease race fixtures align the SQLite row with the native wall clock.
  return new Date(Date.now() + milliseconds).toISOString();
}

function startBoundaryProcess(script: string, environment: Record<string, string>) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    },
  );
  let stdout = "";
  let stderr = "";
  const ready = Deferred.makeUnsafe<void, Error>();
  const result = Deferred.makeUnsafe<{ code: number | null; stdout: string; stderr: string }>();
  let started = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    if (!started && stdout.includes("ready\n")) {
      started = true;
      Effect.runSync(Deferred.succeed(ready, undefined));
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.once("error", (error) => {
    Effect.runSync(Deferred.fail(ready, error));
  });
  child.once("close", (code) => {
    if (!started)
      Effect.runSync(
        Deferred.fail(ready, new Error(`Boundary process closed before ready: ${stderr}`)),
      );
    Effect.runSync(Deferred.succeed(result, { code, stdout, stderr }));
  });
  return {
    ready: Effect.runPromise(Deferred.await(ready)),
    result: Effect.runPromise(Deferred.await(result)),
  };
}

await test("fresh registry is only a run-id to state-path locator", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-locator-"));
  const registry = new WorkgraphRegistry(join(parent, "registry.sqlite"));
  try {
    registry.indexWorkstream({ runId: "fixture", statePath: join(parent, "state.sqlite") });
    assert.deepEqual(registry.findRun("fixture"), { statePath: join(parent, "state.sqlite") });
    assert.throws(
      () =>
        registry.indexWorkstream({
          runId: "fixture",
          statePath: join(parent, "other.sqlite"),
        }),
      /identity collision/,
    );
    const columns = registry.db
      .prepare("PRAGMA table_info(workgraph_locators)")
      .all()
      .flatMap((row) =>
        Value.Check(TableInfoRowSchema, row) ? [Value.Decode(TableInfoRowSchema, row).name] : [],
      );
    assert.deepEqual(columns, ["run_id", "state_path"]);
    assert.equal(
      registry.db.prepare("SELECT name FROM sqlite_master WHERE name='runs'").get(),
      undefined,
    );
  } finally {
    registry.close();
    await rm(parent, { recursive: true, force: true });
  }
});

await test("legacy registry rows follow only the validated JSON-to-SQLite migration", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-legacy-locator-"));
  const projectRoot = join(parent, "project");
  const gitCommonDir = join(projectRoot, ".git");
  const registryPath = join(parent, "registry.sqlite");
  const owner = { sessionId: "legacy-owner", sessionFile: "/legacy-owner.jsonl" };
  let opened: WorkstreamStoreEffects | undefined;
  let registry: WorkgraphRegistry | undefined;
  try {
    await mkdir(gitCommonDir, { recursive: true });
    const created = await run(
      WorkstreamStoreEffects.create({
        id: "legacy-attachment",
        purpose: "Attach one validated legacy state.",
        projectRoot,
        gitCommonDir,
        coordinator: owner,
        now: at(0),
      }),
    );
    const legacyPath = legacyPathForWorkstream(gitCommonDir, created.state.id);
    const source = `${JSON.stringify(
      {
        ...parsePersistedObject(await run(WorkstreamStoreEffects.readRaw(created.state.statePath))),
        statePath: legacyPath,
      },
      null,
      2,
    )}\n`;
    created.store.close();
    await rm(created.state.statePath, { force: true });
    await writeFile(legacyPath, source, { mode: 0o600 });

    const historical = new DatabaseSync(registryPath);
    historical.exec(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY, state_path TEXT NOT NULL UNIQUE,
        project_root TEXT NOT NULL, git_common_dir TEXT NOT NULL, phase TEXT NOT NULL,
        lifecycle TEXT NOT NULL, updated_at TEXT NOT NULL, indexed_at TEXT NOT NULL
      );
      CREATE TABLE leases (run_id TEXT PRIMARY KEY, token TEXT NOT NULL);
    `);
    historical
      .prepare("INSERT INTO runs VALUES(?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        created.state.id,
        legacyPath,
        projectRoot,
        gitCommonDir,
        "workstream",
        "active",
        "now",
        "now",
      );
    const oldRun = historical.prepare("SELECT * FROM runs").all();
    const oldColumns = historical.prepare("PRAGMA table_info(runs)").all();
    const oldLeases = historical.prepare("SELECT * FROM leases").all();
    historical.close();

    const currentRegistry = new WorkgraphRegistry(registryPath);
    registry = currentRegistry;
    assert.throws(
      () =>
        currentRegistry.indexWorkstream({
          runId: created.state.id,
          statePath: join(parent, "foreign.sqlite"),
        }),
      /identity collision/,
    );
    const migrated = await run(WorkstreamStoreEffects.migrateLegacy(legacyPath, "dead"));
    opened = WorkstreamStoreEffects.open(migrated.path, owner);
    await Effect.runPromise(
      Effect.scoped(
        acquireRuntimeLease({ store: opened, registry: currentRegistry }).pipe(Effect.asVoid),
      ).pipe(Effect.provide(liveLayer)),
    );

    assert.deepEqual(currentRegistry.findRun(created.state.id), { statePath: migrated.path });
    assert.equal(await readFile(legacyPath, "utf8"), source);
    assert.deepEqual(currentRegistry.db.prepare("SELECT * FROM runs").all(), oldRun);
    assert.deepEqual(currentRegistry.db.prepare("PRAGMA table_info(runs)").all(), oldColumns);
    assert.deepEqual(currentRegistry.db.prepare("SELECT * FROM leases").all(), oldLeases);
    assert.throws(
      () =>
        currentRegistry.indexWorkstream({
          runId: created.state.id,
          statePath: join(parent, "foreign.sqlite"),
        }),
      /identity collision/,
    );
  } finally {
    opened?.close();
    registry?.close();
    await rm(parent, { recursive: true, force: true });
  }
});

await test("SQLite lease fencing rejects lock-wait and long-callback commits", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-lease-race-"));
  const projectRoot = join(parent, "project");
  const gitCommonDir = join(projectRoot, ".git");
  await mkdir(gitCommonDir, { recursive: true });
  const owner = { sessionId: "lease-race", sessionFile: "/lease-race.jsonl" };
  const created = await run(
    WorkstreamStoreEffects.create({
      id: "lease-race",
      purpose: "Fence stale SQLite mutations",
      projectRoot,
      gitCommonDir,
      coordinator: owner,
      now: at(0),
    }),
  );
  const lease = await run(created.store.acquireLease(owner));
  let blocker: DatabaseSync | undefined;
  try {
    created.store.db
      .prepare("UPDATE lease SET expires_at=? WHERE singleton=1")
      .run(nativeExpiry(120));
    blocker = new DatabaseSync(created.store.path);
    blocker.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
    const persistenceUrl = JSON.stringify(
      new URL("../src/workstream-persistence.ts", import.meta.url).href,
    );
    const child = startBoundaryProcess(
      `import { LeaseDecisionRequiredError, SqliteWorkstreamDatabase } from ${persistenceUrl};
const database = SqliteWorkstreamDatabase.open(process.env.WG_DB_PATH);
const lease = JSON.parse(process.env.WG_LEASE);
process.stdout.write("ready\\n");
try {
  database.update(lease, (draft) => {
    draft.purpose = draft.purpose + " child";
  });
  process.stdout.write("committed\\n");
} catch (error) {
  if (error instanceof LeaseDecisionRequiredError) process.stdout.write("rejected\\n");
  else {
    console.error(error);
    process.exitCode = 1;
  }
} finally {
  database.close();
}`,
      { WG_DB_PATH: created.store.path, WG_LEASE: JSON.stringify(lease) },
    );
    await child.ready;
    sleepSync(300);
    blocker.exec("ROLLBACK");
    blocker.close();
    blocker = undefined;
    const waited = await child.result;
    assert.equal(waited.code, 0, waited.stderr);
    assert.match(waited.stdout, /rejected/);
    assert.doesNotMatch(waited.stdout, /committed/);
    assert.equal(
      Value.Decode(
        RevisionRowSchema,
        created.store.db.prepare("SELECT revision FROM workstream_state").get(),
      ).revision,
      0,
    );

    created.store.db
      .prepare("UPDATE lease SET expires_at=? WHERE singleton=1")
      .run(nativeExpiry(120));
    const direct = SqliteWorkstreamDatabase.open(created.store.path);
    try {
      assert.throws(
        () =>
          direct.update(lease, (draft) => {
            sleepSync(300);
            draft.purpose = `${draft.purpose} delayed`;
          }),
        /fenced lease|live lease/,
      );
    } finally {
      direct.close();
    }
    assert.equal(
      Value.Decode(
        RevisionRowSchema,
        created.store.db.prepare("SELECT revision FROM workstream_state").get(),
      ).revision,
      0,
    );
    await run(created.store.releaseLease(lease));
  } finally {
    if (blocker !== undefined) {
      try {
        blocker.exec("ROLLBACK");
      } catch {
        // The child may already have released the lock before fixture cleanup.
      }
      blocker.close();
    }
    created.store.close();
    await rm(parent, { recursive: true, force: true });
  }
});

await test("concurrent legacy imports retain the sole exclusive SQLite winner", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-import-race-"));
  const projectRoot = join(parent, "project");
  const gitCommonDir = join(projectRoot, ".git");
  await mkdir(gitCommonDir, { recursive: true });
  const owner = { sessionId: "import-race", sessionFile: "/import-race.jsonl" };
  const created = await run(
    WorkstreamStoreEffects.create({
      id: "import-race",
      purpose: "Prepare a concurrent legacy import",
      projectRoot,
      gitCommonDir,
      coordinator: owner,
      now: at(0),
    }),
  );
  const sourcePath = legacyPathForWorkstream(created.state.gitCommonDir, created.state.id);
  const raw = await run(WorkstreamStoreEffects.readRaw(created.state.statePath));
  const legacy = {
    ...parsePersistedObject(raw),
    statePath: sourcePath,
    purpose: "concurrent legacy import ".repeat(250_000),
  };
  const source = `${JSON.stringify(legacy, null, 2)}\n`;
  created.store.close();
  await rm(created.state.statePath, { force: true });
  await writeFile(sourcePath, source, { mode: 0o600 });
  const releasePath = join(parent, "release-import");
  const workstreamUrl = JSON.stringify(new URL("../src/workstream.ts", import.meta.url).href);
  const platformUrl = JSON.stringify(new URL("../src/node-platform.ts", import.meta.url).href);
  const childScript = `import { existsSync } from "node:fs";
import { Effect } from "effect";
import { liveLayer } from ${platformUrl};
import { WorkstreamStoreEffects } from ${workstreamUrl};
const sourcePath = process.env.WG_SOURCE_PATH;
const releasePath = process.env.WG_RELEASE_PATH;
process.stdout.write("ready\\n");
const wait = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(releasePath)) Atomics.wait(wait, 0, 0, 5);
try {
  await Effect.runPromise(WorkstreamStoreEffects.migrateLegacy(sourcePath, "dead").pipe(Effect.provide(liveLayer)));
  process.stdout.write("winner\\n");
} catch (error) {
  process.stdout.write("loser\\n");
}`;
  const first = startBoundaryProcess(childScript, {
    WG_SOURCE_PATH: sourcePath,
    WG_RELEASE_PATH: releasePath,
  });
  const second = startBoundaryProcess(childScript, {
    WG_SOURCE_PATH: sourcePath,
    WG_RELEASE_PATH: releasePath,
  });
  try {
    await Promise.all([first.ready, second.ready]);
    await writeFile(releasePath, "go", { mode: 0o600 });
    const outcomes = await Promise.all([first.result, second.result]);
    assert.equal(outcomes.filter((outcome) => outcome.stdout.includes("winner")).length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.stdout.includes("loser")).length, 1);
    for (const outcome of outcomes) assert.equal(outcome.code, 0, outcome.stderr);
    const imported = await run(WorkstreamStoreEffects.inspect(created.state.statePath));
    assert.equal(imported.id, created.state.id);
    assert.equal(imported.statePath, created.state.statePath);
    assert.equal(imported.purpose, legacy.purpose);
    assert.deepEqual(await readFile(sourcePath, "utf8"), source);
    assert.equal((await lstat(created.state.statePath)).mode & 0o777, 0o600);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

await test("private workstream SQLite fences leases and commits aggregate mutations together", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-private-lease-"));
  const projectRoot = join(parent, "project");
  const gitCommonDir = join(projectRoot, ".git");
  await mkdir(gitCommonDir, { recursive: true });
  const firstOwner = { sessionId: "one", sessionFile: "/one.jsonl" };
  const secondOwner = { sessionId: "two", sessionFile: "/two.jsonl" };
  const first = await run(
    WorkstreamStoreEffects.create({
      id: "fixture",
      purpose: "Private owner proof",
      projectRoot,
      gitCommonDir,
      coordinator: firstOwner,
      now: at(0),
    }),
  );
  const second = WorkstreamStoreEffects.open(first.store.path, firstOwner);
  try {
    const lease = await run(first.store.acquireLease(firstOwner));
    await assert.rejects(
      run(second.acquireLease(secondOwner)),
      (error: LeaseDecisionRequiredError) => error.message.includes("runtime owner"),
    );
    await assert.rejects(
      run(
        second.recordInputEvent({
          ...firstOwner,
          source: "interactive",
          text: "An unleased store must not mutate the active aggregate.",
        }),
      ),
      /requires its fenced lease/,
    );
    const updated = await run(
      first.store.recordInputEvent({
        ...firstOwner,
        source: "interactive",
        text: "Committed in the private aggregate.",
        now: at(2),
      }),
    );
    assert.equal(updated.state.revision, 1);
    const revisionRow = second.db.prepare("SELECT revision FROM workstream_state").get();
    assert.ok(Value.Check(RevisionRowSchema, revisionRow));
    assert.equal(Value.Decode(RevisionRowSchema, revisionRow).revision, 1);
    assert.throws(() => second.assertLease({ ...lease, token: "stale" }, at(3)), /live lease/);
    await run(first.store.releaseLease(lease));
    second.close();
  } finally {
    first.store.close();
    await rm(parent, { recursive: true, force: true });
  }
});
