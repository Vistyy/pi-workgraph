/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion, typescript/require-array-sort-compare -- focused tests inspect native SQLite row shapes through node:sqlite's open row type. */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Value } from "typebox/value";
import { RecordStore, StoreError } from "../../src/coordinator/store.js";
import {
  type AttemptSpec,
  AttemptSpecSchema,
  CommitSchema,
  type Outcome,
  type Task,
  TaskSchema,
  type WorkerState,
  WorkerStateSchema,
} from "../../src/domain/records.js";

const commit = "1".repeat(40);

const otherCommit = "2".repeat(40);

const model = { model: "provider/model", thinking: "medium" } as const;

const directoryTask: Task = {
  target: { kind: "directory", path: "/tmp/project" },
  contract: {
    kind: "research",
    question: "What is true?",
    expectedEvidence: ["Direct evidence"],
  },
};

const repositoryTask: Task = {
  target: { kind: "repository", checkoutRoot: "/tmp/repo", commonDir: "/tmp/repo/.git" },
  contract: {
    kind: "implementation",
    objective: "Make the change.",
    acceptance: ["It works."],
  },
};

const directorySpec: AttemptSpec = {
  selection: { kind: "target", target: model },
  base: { kind: "directory" },
};

const repositorySpec: AttemptSpec = {
  selection: { kind: "implementation", guide: model, executor: model },
  base: { kind: "repository", baseCommit: commit },
  lineage: { candidateRoot: commit },
};

const unreported: Outcome = {
  result: { kind: "unreported", reason: "No report was produced." },
  effectiveModels: [],
};

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "record-store-"));

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function worker(overrides: Partial<WorkerState> = {}): WorkerState {
  return {
    sessionFile: "/tmp/session.jsonl",
    workspaceId: "workspace-1",
    ...overrides,
  };
}

void test("record schemas accept exact current shapes and reject undeclared fields", () => {
  assert.equal(Value.Check(CommitSchema, "a".repeat(40)), true);
  assert.equal(Value.Check(CommitSchema, "a".repeat(64)), true);
  assert.equal(Value.Check(CommitSchema, "a".repeat(41)), false);
  assert.equal(Value.Check(CommitSchema, "A".repeat(40)), false);
  assert.equal(Value.Check(TaskSchema, directoryTask), true);
  assert.equal(Value.Check(TaskSchema, { ...directoryTask, unexpected: true }), false);
  assert.equal(Value.Check(AttemptSpecSchema, { ...directorySpec, unexpected: true }), false);
  assert.equal(Value.Check(WorkerStateSchema, worker({ closed: true })), true);
  assert.equal(Value.Check(WorkerStateSchema, { ...worker(), unexpected: true }), false);
});

void test("RecordStore creates one exact database lazily", () => {
  const { root, cleanup } = fixture();

  try {
    chmodSync(root, 0o751);
    const store = new RecordStore(root, "session-a");
    assert.equal(existsSync(store.path), false);
    assert.deepEqual(store.listTasks(0, 10), []);
    assert.deepEqual(store.unsettled(), []);
    assert.deepEqual(store.counts(), { tasks: 0, attempts: 0, activeWorkers: 0 });
    assert.equal(existsSync(store.path), false);

    store.createTaskWithAttempt("task", directoryTask, "attempt-a", directorySpec);
    assert.equal(store.path, join(root, "workgraph", "workgraph.sqlite"));
    assert.equal(existsSync(store.path), true);
    assert.equal(statSync(root).mode & 0o777, 0o751);
    assert.equal(statSync(join(root, "workgraph")).mode & 0o777, 0o700);
    assert.equal(statSync(store.path).mode & 0o777, 0o600);
    store.close();

    const database = new DatabaseSync(join(root, "workgraph", "workgraph.sqlite"), {
      readOnly: true,
    });

    assert.equal(
      (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      1,
    );
    assert.deepEqual(
      database
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name),
      ["attempts", "tasks"],
    );
    assert.deepEqual(
      database
        .prepare("PRAGMA table_info(tasks)")
        .all()
        .map((row) => (row as { name: string }).name),
      ["session_id", "task_id", "task_json"],
    );
    assert.deepEqual(
      database
        .prepare("PRAGMA table_info(attempts)")
        .all()
        .map((row) => (row as { name: string }).name),
      [
        "attempt_id",
        "session_id",
        "task_id",
        "spec_json",
        "worker_json",
        "output_json",
        "outcome_json",
      ],
    );
    assert.deepEqual(
      database
        .prepare("PRAGMA table_list")
        .all()
        .filter((row) => ["tasks", "attempts"].includes((row as { name: string }).name))
        .map((row) => [(row as { name: string }).name, (row as { strict: number }).strict])
        .sort(),
      [
        ["attempts", 1],
        ["tasks", 1],
      ],
    );
    database.close();
  } finally {
    cleanup();
  }
});

void test("session partitions share one file without sharing records or relations", () => {
  const { root, cleanup } = fixture();

  try {
    const first = new RecordStore(root, "session-a");
    const second = new RecordStore(root, "session-b");
    first.createTaskWithAttempt("same-task", directoryTask, "attempt-a", directorySpec);
    first.createTaskWithAttempt("foreign-only", directoryTask, "attempt-foreign", directorySpec);
    second.createTaskWithAttempt("same-task", repositoryTask, "attempt-b", repositorySpec);

    assert.equal(first.path, second.path);
    assert.equal(first.readTask("same-task").task.contract.kind, "research");
    assert.equal(second.readTask("same-task").task.contract.kind, "implementation");
    assert.throws(() => first.readAttempt("attempt-b"), StoreError);
    assert.throws(
      () => second.createAttempt("foreign-only", "attempt-c", directorySpec),
      StoreError,
    );
    assert.deepEqual(second.listAttempts(0, 10, "foreign-only"), []);
    assert.throws(() => second.createAttempt("same-task", "attempt-a", repositorySpec), StoreError);
    assert.deepEqual(first.counts(), { tasks: 2, attempts: 2, activeWorkers: 0 });
    assert.deepEqual(second.counts(), { tasks: 1, attempts: 1, activeWorkers: 0 });
    first.close();
    second.close();
  } finally {
    cleanup();
  }
});

void test("RecordStore permits only agentDir itself to redirect placement", () => {
  const { root, cleanup } = fixture();

  try {
    const realAgent = join(root, "real-agent");
    const linkedAgent = join(root, "linked-agent");
    mkdirSync(realAgent);
    symlinkSync(realAgent, linkedAgent, "dir");

    const store = new RecordStore(linkedAgent, "session-a");
    store.createTaskWithAttempt("task", directoryTask, "attempt", directorySpec);
    assert.equal(store.path, join(realAgent, "workgraph", "workgraph.sqlite"));
    assert.deepEqual(store.readTask("task"), { id: "task", task: directoryTask });
    store.close();
  } finally {
    cleanup();
  }
});

void test("RecordStore preserves and rejects a redirected Workgraph directory", () => {
  const { root, cleanup } = fixture();

  try {
    const outside = join(root, "outside");
    mkdirSync(outside, { mode: 0o751 });
    symlinkSync(outside, join(root, "workgraph"), "dir");

    const store = new RecordStore(root, "session-a");
    assert.throws(
      () => store.createTaskWithAttempt("task", directoryTask, "attempt", directorySpec),
      StoreError,
    );
    assert.equal(lstatSync(join(root, "workgraph")).isSymbolicLink(), true);
    assert.equal(existsSync(join(outside, "workgraph.sqlite")), false);
    assert.equal(statSync(outside).mode & 0o777, 0o751);
    store.close();
  } finally {
    cleanup();
  }
});

void test("RecordStore preserves and rejects a redirected database file", () => {
  const { root, cleanup } = fixture();

  try {
    const parent = join(root, "workgraph");
    const outside = join(root, "outside.sqlite");
    mkdirSync(parent, { mode: 0o700 });
    writeFileSync(outside, "foreign bytes", { mode: 0o640 });
    symlinkSync(outside, join(parent, "workgraph.sqlite"));

    const store = new RecordStore(root, "session-a");
    assert.throws(
      () => store.createTaskWithAttempt("task", directoryTask, "attempt", directorySpec),
      StoreError,
    );
    assert.equal(lstatSync(store.path).isSymbolicLink(), true);
    assert.equal(readFileSync(outside, "utf8"), "foreign bytes");
    assert.equal(statSync(outside).mode & 0o777, 0o640);
    store.close();
  } finally {
    cleanup();
  }
});

void test("RecordStore resumes an interrupted empty initialization", () => {
  const { root, cleanup } = fixture();

  try {
    const parent = join(root, "workgraph");
    const path = join(parent, "workgraph.sqlite");
    mkdirSync(parent, { mode: 0o700 });
    writeFileSync(path, "", { mode: 0o600 });

    const store = new RecordStore(root, "session-a");
    assert.deepEqual(store.counts(), { tasks: 0, attempts: 0, activeWorkers: 0 });
    store.createTaskWithAttempt("task", directoryTask, "attempt", directorySpec);
    assert.deepEqual(store.readTask("task"), { id: "task", task: directoryTask });
    store.close();

    const database = new DatabaseSync(path, { readOnly: true });
    assert.equal(
      (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      1,
    );
    database.close();
  } finally {
    cleanup();
  }
});

void test("RecordStore preserves and rejects a nonempty version-zero database", () => {
  const { root, cleanup } = fixture();

  try {
    const parent = join(root, "workgraph");
    const path = join(parent, "workgraph.sqlite");
    mkdirSync(parent, { mode: 0o700 });
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE foreign_record(value TEXT) STRICT;");
    database.close();

    const store = new RecordStore(root, "session-a");
    assert.throws(() => store.counts(), StoreError);
    assert.throws(
      () => store.createTaskWithAttempt("task", directoryTask, "attempt", directorySpec),
      StoreError,
    );
    store.close();

    const preserved = new DatabaseSync(path, { readOnly: true });
    assert.deepEqual(
      preserved
        .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
        .all()
        .map((row) => (row as { name: string }).name),
      ["foreign_record"],
    );
    preserved.close();
  } finally {
    cleanup();
  }
});

void test("supported reads strictly decode persisted JSON rows", () => {
  const { root, cleanup } = fixture();

  try {
    const store = new RecordStore(root, "session-a");
    store.createTaskWithAttempt("task", directoryTask, "attempt", directorySpec);
    store.close();

    const database = new DatabaseSync(join(root, "workgraph", "workgraph.sqlite"));
    database
      .prepare("UPDATE tasks SET task_json=? WHERE session_id=? AND task_id=?")
      .run(JSON.stringify({ ...directoryTask, unexpected: true }), "session-a", "task");
    database.close();

    const restored = new RecordStore(root, "session-a");
    assert.throws(() => restored.readTask("task"), StoreError);
    restored.close();
  } finally {
    cleanup();
  }
});

void test("Task and initial Attempt are atomic and focused checkpoints preserve the spec", () => {
  const { root, cleanup } = fixture();

  try {
    const store = new RecordStore(root, "session-a");
    store.createTaskWithAttempt("existing", directoryTask, "global-attempt", directorySpec);
    assert.throws(
      () =>
        store.createTaskWithAttempt(
          "rolled-back",
          repositoryTask,
          "global-attempt",
          repositorySpec,
        ),
      StoreError,
    );
    assert.throws(() => store.readTask("rolled-back"), StoreError);

    store.checkpointWorker("global-attempt", worker({ agent: "uncertain" }));
    store.checkpointWorker("global-attempt", worker({ agent: "ready", kickoff: "confirmed" }));
    store.checkpointOutput("global-attempt", { kind: "no_output" });
    assert.deepEqual(store.readAttempt("global-attempt"), {
      id: "global-attempt",
      taskId: "existing",
      spec: directorySpec,
      worker: worker({ agent: "ready", kickoff: "confirmed" }),
      output: { kind: "no_output" },
    });
    store.close();
  } finally {
    cleanup();
  }
});

void test("Outcome is null-to-value once and validates report kind and distinct models", () => {
  const { root, cleanup } = fixture();

  try {
    const store = new RecordStore(root, "session-a");
    store.createTaskWithAttempt("task", directoryTask, "attempt", directorySpec);

    const wrongReport: Outcome = {
      result: {
        kind: "reported",
        report: {
          kind: "review",
          status: "completed",
          summary: "Reviewed.",
          evidence: [],
          findings: [],
        },
      },
      effectiveModels: [model],
    };

    assert.throws(() => store.recordOutcome("attempt", wrongReport), StoreError);
    assert.throws(
      () =>
        store.recordOutcome("attempt", {
          result: { kind: "unreported", reason: "No report." },
          effectiveModels: [model, model],
        }),
      StoreError,
    );
    store.recordOutcome("attempt", unreported);
    assert.deepEqual(store.readAttempt("attempt").outcome, unreported);
    assert.throws(() => store.recordOutcome("attempt", unreported), StoreError);
    store.close();
  } finally {
    cleanup();
  }
});

void test("cancellation settles Worker and Outcome atomically", () => {
  const { root, cleanup } = fixture();

  try {
    const store = new RecordStore(root, "session-a");
    store.createTaskWithAttempt("task", directoryTask, "attempt", directorySpec);
    const cancelling = worker({ closing: { kind: "cancelled", reason: "No longer needed." } });
    store.checkpointWorker("attempt", cancelling);

    const cancelled: Outcome = {
      result: { kind: "cancelled", reason: "No longer needed." },
      effectiveModels: [],
    };

    assert.throws(() => store.settleCancellation("attempt", cancelling, cancelled), StoreError);
    assert.deepEqual(store.readAttempt("attempt"), {
      id: "attempt",
      taskId: "task",
      spec: directorySpec,
      worker: cancelling,
    });

    const closed = { ...cancelling, closed: true as const };
    store.settleCancellation("attempt", closed, cancelled);
    assert.deepEqual(store.readAttempt("attempt"), {
      id: "attempt",
      taskId: "task",
      spec: directorySpec,
      worker: closed,
      outcome: cancelled,
    });
    store.close();
  } finally {
    cleanup();
  }
});

void test("only same-session queued extension children pin their exact parent", () => {
  const { root, cleanup } = fixture();

  try {
    const store = new RecordStore(root, "session-a");
    const other = new RecordStore(root, "session-b");
    store.createTaskWithAttempt("source", repositoryTask, "parent", repositorySpec);
    other.createTaskWithAttempt("other", repositoryTask, "other-root", repositorySpec);

    const extensionSpec: AttemptSpec = {
      ...repositorySpec,
      base: { kind: "repository", baseCommit: otherCommit },
      lineage: {
        candidateRoot: commit,
        candidateOf: { kind: "extend", attemptId: "parent" },
      },
    };

    store.createAttempt("source", "queued-extension", extensionSpec);
    assert.equal(store.hasUnplacedExtensionChild("parent"), true);

    store.recordOutcome("queued-extension", {
      result: { kind: "cancelled", reason: "Cancelled while queued." },
      effectiveModels: [],
    });
    assert.equal(store.hasUnplacedExtensionChild("parent"), false);

    store.createAttempt("source", "placed-extension", extensionSpec);
    assert.equal(store.hasUnplacedExtensionChild("parent"), true);
    store.checkpointWorker("placed-extension", worker());
    assert.equal(store.hasUnplacedExtensionChild("parent"), false);

    store.createAttempt("source", "integration-child", {
      ...repositorySpec,
      lineage: {
        candidateRoot: commit,
        candidateOf: { kind: "integrate", attemptId: "parent", sourceTip: otherCommit },
      },
    });
    assert.equal(store.hasUnplacedExtensionChild("parent"), false);

    other.createAttempt("other", "other-session-extension", extensionSpec);
    assert.equal(store.hasUnplacedExtensionChild("parent"), false);
    assert.equal(other.hasUnplacedExtensionChild("parent"), false);

    store.close();
    other.close();
  } finally {
    cleanup();
  }
});

void test("numeric rowid paging and settlement queries expose meaningful current state", () => {
  const { root, cleanup } = fixture();

  try {
    const store = new RecordStore(root, "session-a");
    store.createTaskWithAttempt("task-a", directoryTask, "attempt-a", directorySpec);
    store.createTaskWithAttempt("task-b", repositoryTask, "attempt-b", repositorySpec);
    store.createAttempt("task-b", "attempt-c", {
      ...repositorySpec,
      lineage: {
        candidateRoot: commit,
        candidateOf: { kind: "integrate", attemptId: "attempt-b", sourceTip: otherCommit },
      },
    });
    store.createAttempt("task-b", "attempt-d", repositorySpec);

    assert.deepEqual(
      store.listTasks(1, 1).map((record) => record.id),
      ["task-b"],
    );
    assert.deepEqual(
      store.listAttempts(1, 2).map((record) => record.id),
      ["attempt-b", "attempt-c"],
    );
    assert.deepEqual(
      store.listAttempts(1, 1, "task-b").map((record) => record.id),
      ["attempt-c"],
    );
    assert.equal(store.hasUnclassifiedIntegrationChild("attempt-b"), true);

    store.checkpointWorker("attempt-a", worker({ agent: "ready" }));
    store.recordOutcome("attempt-a", unreported);
    store.recordOutcome("attempt-b", unreported);
    store.checkpointOutput("attempt-b", {
      kind: "retained",
      tip: otherCommit,
      reason: "Useful candidate.",
    });
    store.recordOutcome("attempt-d", unreported);
    store.checkpointOutput("attempt-d", { kind: "no_output" });

    assert.deepEqual(store.counts(), { tasks: 2, attempts: 4, activeWorkers: 1 });
    assert.deepEqual(
      store.unsettled().map((record) => record.id),
      ["attempt-a", "attempt-c"],
    );
    store.checkpointWorker(
      "attempt-a",
      worker({ agent: "ready", closing: { kind: "settled" }, closed: true }),
    );
    assert.deepEqual(store.counts(), { tasks: 2, attempts: 4, activeWorkers: 0 });
    store.close();
  } finally {
    cleanup();
  }
});
