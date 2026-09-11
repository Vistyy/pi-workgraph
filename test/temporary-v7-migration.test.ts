/* oxlint-disable effecttsgo/global-date -- Legacy v7 transition fixtures require the predecessor Date-based public API. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"; // oxlint-disable-line effecttsgo/node-builtin-import -- Migration tests exercise real byte and SQLite boundaries.
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Real migration path identity is asserted at the Node filesystem boundary.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Effect } from "effect";
import { CanonicalWorkstreamStore } from "../src/canonical-workstream-store.js";
import { liveLayer } from "../src/node-platform.js";
import {
  classifyV7MigrationRecovery,
  commitV7Migration,
  normalizeV7Workstream,
  preflightV7Migration,
  prepareV7Migration,
  recoverV7Migration,
  type V7MigrationBreadcrumb,
  type V7MigrationBreadcrumbPort,
} from "../src/temporary-v7-migration.js";
import { WorkstreamStoreEffects } from "../src/workstream.js";
import {
  pathForWorkstream,
  WORKSTREAM_FORMAT,
  WORKSTREAM_STATE_VERSION,
  type WorkstreamState,
} from "../src/workstream-state.js";

const T0 = "2024-01-01T00:00:00.000Z";
const MODEL = { model: "fixture/research", thinking: "high" as const };

function sourceState(
  projectRoot: string,
  gitCommonDir: string,
  sessionFile: string,
): WorkstreamState {
  const id = "migration";
  const receipt = {
    id: "receipt-1",
    sessionId: "coordinator",
    sessionFile: "/sessions/coordinator.jsonl",
    source: "interactive" as const,
    text: "Research exact migration behavior.",
    receivedAt: T0,
  };
  return {
    format: WORKSTREAM_FORMAT,
    version: WORKSTREAM_STATE_VERSION,
    revision: 17,
    id,
    purpose: receipt.text,
    projectRoot,
    gitCommonDir,
    statePath: pathForWorkstream(gitCommonDir, id),
    coordinator: { sessionId: receipt.sessionId, sessionFile: receipt.sessionFile },
    lifecycle: { state: "active", changedAt: T0, reason: "Active." },
    inputs: [receipt],
    intents: [
      {
        version: 0,
        statement: receipt.text,
        constraints: [],
        authorityReceiptIds: [],
        recordedAt: T0,
      },
      {
        version: 1,
        statement: receipt.text,
        constraints: ["Stay exact."],
        authorityReceiptIds: [receipt.id],
        recordedAt: T0,
      },
    ],
    assignments: [
      {
        id: "research-task",
        objective: "Inspect migration semantics.",
        intentVersion: 1,
        createdAt: T0,
        capability: "research",
        artifactIntent: "evidence_only",
        expectedEvidence: ["Exact evidence."],
      },
    ],
    results: [
      {
        id: "legacy-result",
        assignmentId: "research-task",
        assignmentIntentVersion: 1,
        artifacts: [],
        observedAt: T0,
        validity: "typed",
        report: {
          kind: "research",
          status: "completed",
          summary: "Inspected.",
          evidence: [{ label: "state", observation: "Exact." }],
          findings: [],
        },
      },
    ],
    attempts: [
      {
        id: "research-attempt",
        assignmentId: "research-task",
        state: "settled",
        models: {
          guide: MODEL,
          source: "requested-model",
          selection: {
            role: "research",
            count: 1,
            distinctModels: false,
            selected: [MODEL],
            source: "requested-model",
          },
        },
        effectiveModels: [{ model: MODEL.model, thinking: MODEL.thinking, source: "selection" }],
        placement: { kind: "shared_project", path: projectRoot },
        sessionFile,
        submission: "started",
        worker: {
          workspaceId: "workspace",
          tabId: "tab",
          paneId: "pane",
          terminalId: "terminal",
          agentName: "worker",
          cwd: projectRoot,
          sessionFile,
        },
        cleanup: { state: "completed", workerClosed: true },
        resultId: "legacy-result",
        baseRevision: "a".repeat(40),
        createdAt: T0,
        updatedAt: T0,
      },
    ],
    deliveries: [
      {
        resultId: "legacy-result",
        state: "delivered",
        requestedAt: T0,
        attemptedBy: "ephemeral-generation",
        deliveredAt: T0,
      },
    ],
    createdAt: T0,
    updatedAt: T0,
  };
}

async function fixture(mutate?: (state: WorkstreamState) => void) {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-v7-migration-"));
  const projectRoot = join(parent, "project");
  const gitCommonDir = join(projectRoot, ".git");
  await mkdir(gitCommonDir, { recursive: true, mode: 0o700 });
  await chmod(projectRoot, 0o700);
  await chmod(gitCommonDir, 0o700);
  const coordinator = { sessionId: "coordinator", sessionFile: "/sessions/coordinator.jsonl" };
  const created = await Effect.runPromise(
    WorkstreamStoreEffects.create({
      id: "migration",
      purpose: "Research exact migration behavior.",
      projectRoot,
      gitCommonDir,
      coordinator,
      now: new Date(T0),
    }).pipe(Effect.provide(liveLayer)),
  );
  const lease = await Effect.runPromise(
    created.store.acquireLease(coordinator).pipe(Effect.provide(liveLayer)),
  );
  const input = await Effect.runPromise(
    created.store
      .recordInputEvent({
        id: "receipt-1",
        ...coordinator,
        source: "interactive",
        text: "Research exact migration behavior.",
        now: new Date(T0),
      })
      .pipe(Effect.provide(liveLayer)),
  );
  const revised = await Effect.runPromise(
    created.store
      .reviseIntent({
        authorityReceiptId: input.receipt.id,
        statement: input.receipt.text,
        constraints: ["Stay exact."],
        now: new Date(T0),
      })
      .pipe(Effect.provide(liveLayer)),
  );
  await Effect.runPromise(created.store.releaseLease(lease).pipe(Effect.provide(liveLayer)));
  const legacySessionDirectory = join(
    gitCommonDir,
    "pi-workgraph",
    "workstreams",
    "migration",
    "sessions",
  );
  await mkdir(legacySessionDirectory, { mode: 0o700 });
  const sessionFile = join(legacySessionDirectory, "legacy-worker.jsonl");
  await writeFile(sessionFile, `${JSON.stringify({ type: "session", timestamp: T0 })}\n`);
  const state = sourceState(projectRoot, gitCommonDir, sessionFile);
  state.inputs = structuredClone(revised.inputs);
  state.intents = structuredClone(revised.intents);
  mutate?.(state);
  const path = state.statePath;
  using database = new DatabaseSync(path);
  database
    .prepare("UPDATE workstream_state SET state_json=?, revision=? WHERE singleton=1")
    .run(JSON.stringify(state), state.revision);
  return { parent, projectRoot, gitCommonDir, sessionFile, state, path };
}

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function migrationTemporaryPath(target: string, identity: string): string {
  return `${target}.migration-tmp-${digest(identity).slice(0, 16)}`;
}

void test("v7 mapping reindexes grounded Intent, preserves models, and ledgers forbidden active facts", async () => {
  const f = await fixture();
  try {
    const mapped = normalizeV7Workstream(f.state, new Map());
    assert.equal(mapped.state.revision, 17);
    assert.equal(mapped.state.intents.length, 1);
    assert.equal(mapped.state.tasks[0]?.intentIndex, 0);
    assert.equal(mapped.state.tasks[0]?.attempts[0]?.selection.source, "policy");
    assert.equal(mapped.state.tasks[0]?.attempts[0]?.outcome?.id, "research-attempt:outcome");
    assert.equal(mapped.state.tasks[0]?.attempts[0]?.baseRevision, undefined);
    assert.deepEqual(mapped.ledger.omittedBaseRevisions, [
      { attemptId: "research-attempt", baseRevision: "a".repeat(40) },
    ]);
    assert.equal(mapped.ledger.requestedModelProvenance.length, 1);
    assert.deepEqual(mapped.ledger.omittedDeliveryAttemptedBy, [
      { resultId: "legacy-result", attemptedBy: "ephemeral-generation" },
    ]);

    const ambiguous = structuredClone(f.state);
    const intentZero = ambiguous.intents[0];
    assert.ok(intentZero);
    intentZero.statement = "Not duplicated.";
    assert.throws(
      () => normalizeV7Workstream(ambiguous, new Map()),
      /not the approved ungrounded, Task-free duplicate/,
    );

    const steered = structuredClone(f.state);
    const steeredAttempt = steered.attempts[0];
    assert.ok(steeredAttempt);
    steeredAttempt.steering = { text: "Inspect twice.", state: "uncertain" };
    const duplicateEvidence = `${JSON.stringify({ type: "message", timestamp: T0, message: { role: "user", content: [{ type: "text", text: "Inspect twice." }] } })}\n${JSON.stringify({ type: "message", timestamp: T0, message: { role: "user", content: [{ type: "text", text: "Inspect twice." }] } })}\n`;
    assert.throws(
      () => normalizeV7Workstream(steered, new Map([[f.sessionFile, duplicateEvidence]])),
      /steering has 2 exact Pi user-message records/,
    );
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

void test("migration rejects non-active, non-settled, unresolved, and non-user steering sources", async () => {
  const f = await fixture();
  try {
    const inactive = structuredClone(f.state);
    inactive.lifecycle = { state: "suspended", changedAt: T0, reason: "Paused." };
    assert.throws(
      () => normalizeV7Workstream(inactive, new Map()),
      /not the one active migration source/,
    );

    const failed = structuredClone(f.state);
    const failedAttempt = failed.attempts[0];
    assert.ok(failedAttempt);
    failedAttempt.state = "failed";
    failedAttempt.error = "Historical failure.";
    assert.throws(() => normalizeV7Workstream(failed, new Map()), /not exactly settled/);

    const cleanup = structuredClone(f.state);
    const cleanupAttempt = cleanup.attempts[0];
    assert.ok(cleanupAttempt);
    cleanupAttempt.cleanup = { state: "pending", workerClosed: false };
    assert.throws(() => normalizeV7Workstream(cleanup, new Map()), /unresolved cleanup obligation/);

    const release = structuredClone(f.state);
    const releaseAttempt = release.attempts[0];
    assert.ok(releaseAttempt);
    releaseAttempt.outputRelease = {
      state: "pending",
      expectedHead: "a".repeat(40),
      reason: "Await release.",
    };
    assert.throws(
      () => normalizeV7Workstream(release, new Map()),
      /unresolved output-release obligation/,
    );

    const steered = structuredClone(f.state);
    const steeredAttempt = steered.attempts[0];
    assert.ok(steeredAttempt);
    steeredAttempt.steering = { text: "Exact steering.", state: "submitted" };
    const quoted = `${JSON.stringify({ type: "message", timestamp: T0, message: { role: "assistant", content: [{ type: "text", text: "Exact steering." }] } })}\n`;
    assert.throws(
      () => normalizeV7Workstream(steered, new Map([[f.sessionFile, quoted]])),
      /0 exact Pi user-message records/,
    );
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

void test("prepared migration archives source, imports its revision, and copies Worker JSONL byte-identically", async () => {
  const f = await fixture();
  try {
    const sourceBytes = await readFile(f.path);
    const declaration = {
      repository: { projectRoot: f.projectRoot, gitCommonDir: f.gitCommonDir },
      workstreamId: f.state.id,
      expectedRevision: f.state.revision,
      expectedSourceSha256: digest(sourceBytes),
    };
    const preflight = await Effect.runPromise(
      preflightV7Migration(declaration, T0).pipe(Effect.provide(liveLayer)),
    );
    const records: V7MigrationBreadcrumb[] = [];
    const port: V7MigrationBreadcrumbPort = {
      append: async (record) => {
        records.push(structuredClone(record));
      },
      read: async () => structuredClone(records),
    };
    const manifest = await Effect.runPromise(
      Effect.scoped(prepareV7Migration(preflight, port)).pipe(Effect.provide(liveLayer)),
    );
    assert.equal(manifest.source.revision, 17);
    assert.deepEqual(await readFile(preflight.paths.archiveDatabase), sourceBytes);
    assert.deepEqual(
      await readFile(join(preflight.paths.workerSessionDirectory, "research-attempt.jsonl")),
      await readFile(f.sessionFile),
    );
    assert.equal(records.length, 1);
    // Exact-equal preparation replay neither duplicates the breadcrumb nor rewrites bytes.
    await Effect.runPromise(
      Effect.scoped(prepareV7Migration(preflight, port)).pipe(Effect.provide(liveLayer)),
    );
    assert.equal(records.length, 1);

    await Effect.runPromise(commitV7Migration(preflight, port, T0));
    const committed = await Effect.runPromise(
      Effect.scoped(
        CanonicalWorkstreamStore.open(f.state.id, declaration.repository).pipe(
          Effect.flatMap((attachment) => attachment.store.read()),
        ),
      ).pipe(Effect.provide(liveLayer)),
    );
    assert.equal(committed.revision, 17);
    assert.equal(records.length, 2);
    // A crash after rename but before response/record confirmation is recoverable without swapping again.
    await Effect.runPromise(commitV7Migration(preflight, port, T0));
    assert.equal(records.length, 2);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

void test("restart driver resumes from a durable prepared breadcrumb and recognizes committed replay", async () => {
  const f = await fixture();
  try {
    const declaration = {
      repository: { projectRoot: f.projectRoot, gitCommonDir: f.gitCommonDir },
      workstreamId: f.state.id,
      expectedRevision: f.state.revision,
      expectedSourceSha256: digest(await readFile(f.path)),
    };
    const sourceBytes = await readFile(f.path);
    const preflight = await Effect.runPromise(preflightV7Migration(declaration, T0));
    const records: V7MigrationBreadcrumb[] = [structuredClone(preflight.prepared)];
    await mkdir(preflight.paths.workerSessionDirectory, { recursive: true, mode: 0o700 });
    const session = preflight.sessions[0];
    assert.ok(session);
    const sessionTemporary = migrationTemporaryPath(session.target.path, session.source.sha256);
    await writeFile(sessionTemporary, "torn session copy", { mode: 0o600 });
    const port: V7MigrationBreadcrumbPort = {
      append: async (record) => {
        if (record.phase === "committed") {
          assert.deepEqual(await readFile(preflight.paths.archiveDatabase), sourceBytes);
          assert.equal(await readFile(preflight.paths.manifest, "utf8").then(Boolean), true);
        }
        records.push(structuredClone(record));
      },
      read: async () => structuredClone(records),
    };
    const committed = await Effect.runPromise(
      Effect.scoped(recoverV7Migration(declaration, port, T0)).pipe(Effect.provide(liveLayer)),
    );
    assert.equal(committed.phase, "committed");
    assert.equal(records.length, 2);
    const replay = await Effect.runPromise(
      Effect.scoped(recoverV7Migration(declaration, port, T0)).pipe(Effect.provide(liveLayer)),
    );
    assert.deepEqual(replay, committed);
    assert.equal(records.length, 2);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

void test("initial preflight rejects and preserves unowned deterministic staging residue", async () => {
  const f = await fixture();
  try {
    const declaration = {
      repository: { projectRoot: f.projectRoot, gitCommonDir: f.gitCommonDir },
      workstreamId: f.state.id,
      expectedRevision: f.state.revision,
      expectedSourceSha256: digest(await readFile(f.path)),
    };
    const first = await Effect.runPromise(preflightV7Migration(declaration, T0));
    const stagingTemporary = migrationTemporaryPath(
      first.paths.stagingDatabase,
      first.prepared.canonicalStateSha256,
    );
    const residue = Buffer.from("pre-existing unowned residue");
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const path = `${stagingTemporary}${suffix}`;
      await writeFile(path, residue, { mode: 0o600 });
      await assert.rejects(
        Effect.runPromise(preflightV7Migration(declaration, T0)),
        /Pre-existing unowned migration temporary must be absent/,
      );
      assert.deepEqual(await readFile(path), residue);
      await rm(path);
    }
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

void test("recovery removes torn staging and manifest temps and completes in one call", async () => {
  const stagingFixture = await fixture();
  try {
    const declaration = {
      repository: {
        projectRoot: stagingFixture.projectRoot,
        gitCommonDir: stagingFixture.gitCommonDir,
      },
      workstreamId: stagingFixture.state.id,
      expectedRevision: stagingFixture.state.revision,
      expectedSourceSha256: digest(await readFile(stagingFixture.path)),
    };
    const preflight = await Effect.runPromise(preflightV7Migration(declaration, T0));
    const records: V7MigrationBreadcrumb[] = [structuredClone(preflight.prepared)];
    const port: V7MigrationBreadcrumbPort = {
      append: async (record) => {
        records.push(structuredClone(record));
      },
      read: async () => structuredClone(records),
    };
    const stagingTemporary = migrationTemporaryPath(
      preflight.paths.stagingDatabase,
      preflight.prepared.canonicalStateSha256,
    );
    await writeFile(stagingTemporary, "torn sqlite initialization", { mode: 0o600 });
    const committed = await Effect.runPromise(
      Effect.scoped(recoverV7Migration(declaration, port, T0)).pipe(Effect.provide(liveLayer)),
    );
    assert.equal(committed.phase, "committed");
    await assert.rejects(readFile(stagingTemporary), { code: "ENOENT" });
  } finally {
    await rm(stagingFixture.parent, { recursive: true, force: true });
  }

  const manifestFixture = await fixture();
  try {
    const declaration = {
      repository: {
        projectRoot: manifestFixture.projectRoot,
        gitCommonDir: manifestFixture.gitCommonDir,
      },
      workstreamId: manifestFixture.state.id,
      expectedRevision: manifestFixture.state.revision,
      expectedSourceSha256: digest(await readFile(manifestFixture.path)),
    };
    const preflight = await Effect.runPromise(preflightV7Migration(declaration, T0));
    const records: V7MigrationBreadcrumb[] = [];
    const port: V7MigrationBreadcrumbPort = {
      append: async (record) => {
        records.push(structuredClone(record));
      },
      read: async () => structuredClone(records),
    };
    await Effect.runPromise(
      Effect.scoped(prepareV7Migration(preflight, port)).pipe(Effect.provide(liveLayer)),
    );
    const manifestContents = await readFile(preflight.paths.manifest, "utf8");
    const manifestTemporary = migrationTemporaryPath(
      preflight.paths.manifest,
      digest(manifestContents),
    );
    await rm(preflight.paths.manifest);
    await writeFile(manifestTemporary, "torn manifest", { mode: 0o600 });
    const committed = await Effect.runPromise(
      Effect.scoped(recoverV7Migration(declaration, port, T0)).pipe(Effect.provide(liveLayer)),
    );
    assert.equal(committed.phase, "committed");
    assert.equal(await readFile(preflight.paths.manifest, "utf8"), manifestContents);
    await assert.rejects(readFile(manifestTemporary), { code: "ENOENT" });
  } finally {
    await rm(manifestFixture.parent, { recursive: true, force: true });
  }
});

void test("recovery refuses and preserves a foreign published staging collision", async () => {
  const f = await fixture();
  try {
    const declaration = {
      repository: { projectRoot: f.projectRoot, gitCommonDir: f.gitCommonDir },
      workstreamId: f.state.id,
      expectedRevision: f.state.revision,
      expectedSourceSha256: digest(await readFile(f.path)),
    };
    const preflight = await Effect.runPromise(preflightV7Migration(declaration, T0));
    const records: V7MigrationBreadcrumb[] = [structuredClone(preflight.prepared)];
    const port: V7MigrationBreadcrumbPort = {
      append: async (record) => {
        records.push(structuredClone(record));
      },
      read: async () => structuredClone(records),
    };
    const collision = Buffer.from("foreign published staging");
    await writeFile(preflight.paths.stagingDatabase, collision, { mode: 0o600 });
    await assert.rejects(
      Effect.runPromise(
        Effect.scoped(recoverV7Migration(declaration, port, T0)).pipe(Effect.provide(liveLayer)),
      ),
      /restart state is ambiguous/,
    );
    assert.deepEqual(await readFile(preflight.paths.stagingDatabase), collision);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

void test("Worker-session copy rejects a conflicting canonical collision", async () => {
  const f = await fixture();
  try {
    const declaration = {
      repository: { projectRoot: f.projectRoot, gitCommonDir: f.gitCommonDir },
      workstreamId: f.state.id,
      expectedRevision: f.state.revision,
      expectedSourceSha256: digest(await readFile(f.path)),
    };
    const preflight = await Effect.runPromise(preflightV7Migration(declaration, T0));
    await mkdir(preflight.paths.workerSessionDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(preflight.paths.workerSessionDirectory, "research-attempt.jsonl"),
      "conflicting bytes\n",
    );
    const records: V7MigrationBreadcrumb[] = [];
    const port: V7MigrationBreadcrumbPort = {
      append: async (record) => {
        records.push(structuredClone(record));
      },
      read: async () => structuredClone(records),
    };
    await assert.rejects(
      Effect.runPromise(
        Effect.scoped(prepareV7Migration(preflight, port)).pipe(Effect.provide(liveLayer)),
      ),
      /Conflicting migration collision/,
    );
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

void test("preflight rejects unsafe attempt/session paths and a present predecessor lease", async () => {
  const unsafe = await fixture((state) => {
    const attempt = state.attempts[0];
    assert.ok(attempt);
    attempt.id = "../escape";
  });
  try {
    const declaration = {
      repository: { projectRoot: unsafe.projectRoot, gitCommonDir: unsafe.gitCommonDir },
      workstreamId: unsafe.state.id,
      expectedRevision: unsafe.state.revision,
      expectedSourceSha256: digest(await readFile(unsafe.path)),
    };
    await assert.rejects(
      Effect.runPromise(preflightV7Migration(declaration, T0)),
      /safe target filename segment/,
    );
  } finally {
    await rm(unsafe.parent, { recursive: true, force: true });
  }

  const outside = await fixture((state) => {
    const attempt = state.attempts[0];
    assert.ok(attempt);
    attempt.sessionFile = join(state.projectRoot, "outside.jsonl");
    if (attempt.worker) attempt.worker.sessionFile = attempt.sessionFile;
  });
  try {
    const declaration = {
      repository: { projectRoot: outside.projectRoot, gitCommonDir: outside.gitCommonDir },
      workstreamId: outside.state.id,
      expectedRevision: outside.state.revision,
      expectedSourceSha256: digest(await readFile(outside.path)),
    };
    await assert.rejects(
      Effect.runPromise(preflightV7Migration(declaration, T0)),
      /not an exact direct child/,
    );
  } finally {
    await rm(outside.parent, { recursive: true, force: true });
  }

  const leased = await fixture();
  try {
    using database = new DatabaseSync(leased.path);
    database
      .prepare("INSERT INTO lease VALUES(1,?,?,?,?,?,?)")
      .run("token", "owner", "/owner.jsonl", T0, T0, T0);
    const declaration = {
      repository: { projectRoot: leased.projectRoot, gitCommonDir: leased.gitCommonDir },
      workstreamId: leased.state.id,
      expectedRevision: leased.state.revision,
      expectedSourceSha256: digest(await readFile(leased.path)),
    };
    await assert.rejects(
      Effect.runPromise(preflightV7Migration(declaration, T0)),
      /lease is present/,
    );
  } finally {
    await rm(leased.parent, { recursive: true, force: true });
  }
});

void test("commit rejects incomplete staging validation and breadcrumb identity conflicts", async () => {
  const f = await fixture();
  try {
    const declaration = {
      repository: { projectRoot: f.projectRoot, gitCommonDir: f.gitCommonDir },
      workstreamId: f.state.id,
      expectedRevision: f.state.revision,
      expectedSourceSha256: digest(await readFile(f.path)),
    };
    const preflight = await Effect.runPromise(preflightV7Migration(declaration, T0));
    const records: V7MigrationBreadcrumb[] = [];
    const port: V7MigrationBreadcrumbPort = {
      append: async (record) => {
        records.push(structuredClone(record));
      },
      read: async () => structuredClone(records),
    };
    await Effect.runPromise(
      Effect.scoped(prepareV7Migration(preflight, port)).pipe(Effect.provide(liveLayer)),
    );
    await chmod(preflight.paths.stagingDatabase, 0o644);
    await assert.rejects(Effect.runPromise(commitV7Migration(preflight, port, T0)), /not private/);
    await chmod(preflight.paths.stagingDatabase, 0o600);
    records.push({ ...structuredClone(preflight.prepared), migrationId: "foreign" });
    await assert.rejects(
      Effect.runPromise(
        Effect.scoped(recoverV7Migration(declaration, port, T0)).pipe(Effect.provide(liveLayer)),
      ),
      /Another migration identity/,
    );
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

void test("migration recovery classifies supported boundaries and fails closed on conflicts", () => {
  assert.equal(
    classifyV7MigrationRecovery({
      breadcrumb: "absent",
      source: "v7_exact",
      archive: "absent",
      stage: "absent",
      manifest: "absent",
      sessions: "absent",
    }),
    "ready",
  );
  assert.equal(
    classifyV7MigrationRecovery({
      breadcrumb: "prepared",
      source: "canonical_exact",
      archive: "v7_exact",
      stage: "absent",
      manifest: "exact",
      sessions: "exact",
    }),
    "commit_record_required",
  );
  assert.equal(
    classifyV7MigrationRecovery({
      breadcrumb: "committed",
      source: "canonical_exact",
      archive: "conflicting",
      stage: "absent",
      manifest: "exact",
      sessions: "exact",
    }),
    "ambiguous",
  );
});
