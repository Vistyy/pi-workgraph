/* oxlint-disable effecttsgo/node-builtin-import, anti-slop/require-safety-comment-for-type-assertion -- Behavioral tests inspect native temporary SQLite, Git, paths, and files. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Effect, Exit, Scope } from "effect";
import { WorkstreamRuntime } from "../src/coordination/runtime.js";
import type { CoordinatorOwner, IntentRecord, WorkstreamMetadata } from "../src/domain/records.js";
import { resolveTaskTarget } from "../src/git.js";
import { StoreError, WorkstreamStore } from "../src/storage/workstream-store.js";

type RuntimePorts = Parameters<typeof WorkstreamRuntime.acquire>[0]["ports"];

const owner: CoordinatorOwner = {
  sessionId: "coordinator",
  sessionFile: "/sessions/coordinator.jsonl",
  tabId: "tab-1",
};
const at = "2026-03-20T12:00:00.000Z";

function records(id: string) {
  return {
    metadata: {
      id,
      purpose: "Coordinate several targets",
      owner,
      lifecycle: "active",
      createdAt: at,
      updatedAt: at,
    },
    intent: {
      workstreamId: id,
      index: 0,
      statement: "Coordinate several targets",
      constraints: [],
      authority: {
        receiptId: "receipt-1",
        sessionId: owner.sessionId,
        sessionFile: owner.sessionFile,
      },
      recordedAt: at,
    },
  } satisfies { metadata: WorkstreamMetadata; intent: IntentRecord };
}
function temporary(): string {
  return mkdtempSync(join(tmpdir(), "workgraph-records-"));
}
function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
function repository(root: string): string {
  const path = join(root, "repository");
  execFileSync("git", ["init", "-q", path]);
  git(path, ["config", "user.name", "Workgraph Test"]);
  git(path, ["config", "user.email", "workgraph@example.invalid"]);
  writeFileSync(join(path, "value.txt"), "base\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-qm", "base"]);
  return path;
}
function ports(overrides: Partial<RuntimePorts["worker"]> = {}): RuntimePorts {
  let session = 0;
  return {
    worker: {
      async createSession() {
        session += 1;
        return `/sessions/worker-${session}.jsonl`;
      },
      async launch() {
        return {
          paneId: `pane-${session}`,
          tabId: `tab-${session}`,
          terminalId: `terminal-${session}`,
        };
      },
      async inspect() {
        return { state: "done", outcome: { kind: "reported", result: { summary: "done" } } };
      },
      async prompt() {},
      async close() {
        return "absent";
      },
      async readSession() {
        return { state: "done", outcome: { kind: "reported", result: { summary: "done" } } };
      },
      ...overrides,
    },
    delivery: {
      async deliver() {
        throw new Error("Coordinator turn is not available yet.");
      },
    },
  };
}
async function acquire(store: WorkstreamStore, agentDir: string, runtimePorts = ports()) {
  const scope = await Effect.runPromise(Scope.make());
  const attachment = await Effect.runPromise(
    WorkstreamRuntime.acquire({ store, owner, agentDir, ports: runtimePorts }).pipe(
      Scope.provide(scope),
    ),
  );
  assert.equal(attachment.state, "attached");
  if (attachment.state !== "attached") throw new Error("runtime did not attach");
  return { runtime: attachment.runtime, scope };
}

void test("global five-table store keeps repository-neutral records and exact ownership", () => {
  const root = temporary();
  try {
    const initial = records("ws-records");
    const store = WorkstreamStore.create(root, initial.metadata, initial.intent);
    assert.equal(
      store.path,
      join(root, "workgraph", "workstreams", "ws-records", "workstream.sqlite"),
    );
    const db = new DatabaseSync(store.path, { readOnly: true });
    assert.deepEqual(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
      ["attempts", "intents", "metadata", "outcomes", "tasks"],
    );
    db.close();
    store.createTask(owner, {
      id: "directory-task",
      workstreamId: store.id,
      intentIndex: 0,
      kind: "research",
      objective: "Read another directory",
      target: { kind: "directory", path: join(root, "elsewhere") },
      contract: {},
      createdAt: at,
    });
    assert.equal(store.task("directory-task").target.kind, "directory");
    assert.throws(
      () => store.appendIntent({ ...owner, tabId: "foreign" }, { ...initial.intent, index: 1 }),
      StoreError,
    );
    assert.deepEqual(store.page("tasks", 0, 1), [store.task("directory-task")]);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("Worker Outcome precedes closure and alone permits completion while delivery remains pending", async () => {
  const root = temporary();
  const events: string[] = [];
  try {
    const initial = records("ws-worker");
    const store = WorkstreamStore.create(root, initial.metadata, initial.intent);
    let closeCount = 0;
    const runtimePorts = ports({
      async prompt() {
        events.push("prompt");
      },
      async inspect() {
        events.push("inspect");
        return { state: "done", outcome: { kind: "reported", result: { summary: "complete" } } };
      },
      async close() {
        closeCount += 1;
        events.push(
          store.outcomeForAttempt("directory-task-1") === undefined
            ? "close-before-outcome"
            : "close-after-outcome",
        );
        return closeCount === 1 ? "present" : "absent";
      },
    });
    const { runtime, scope } = await acquire(store, root, runtimePorts);
    await Effect.runPromise(
      runtime.createTask({
        id: "directory-task",
        kind: "research",
        objective: "Observe",
        target: { kind: "directory", path: root },
      }),
    );
    const attempt = await Effect.runPromise(
      runtime.createAttempt({
        taskId: "directory-task",
        models: [{ role: "research", model: "test/model" }],
      }),
    );
    await Effect.runPromise(runtime.launch(attempt.id));
    await assert.rejects(Effect.runPromise(runtime.observe(attempt.id)));
    const outcome = store.outcomeForAttempt(attempt.id);
    assert.equal(outcome?.delivery.state, "pending");
    assert.deepEqual(events, ["prompt", "inspect", "close-after-outcome"]);
    const completed = await Effect.runPromise(
      runtime.complete({ conclusion: "Complete", evidence: ["Outcome exists"] }),
    );
    assert.equal(completed.lifecycle, "completed");
    assert.equal(store.outcomeForAttempt(attempt.id)?.delivery.state, "pending");
    await Effect.runPromise(runtime.observe(attempt.id));
    assert.notEqual(store.attempt(attempt.id).worker?.closedAt, undefined);
    assert.equal(events.at(-1), "close-after-outcome");
    await Effect.runPromise(Scope.close(scope, Exit.void));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("repository Attempts retain private refs, enforce lineage, apply exact content, and explicitly discard dirty output", async () => {
  const root = temporary();
  let ownedScope: Scope.Scope | undefined;
  try {
    const checkout = repository(root);
    const target = resolveTaskTarget({ cwd: checkout, kind: "repository" });
    assert.equal(target.kind, "repository");
    if (target.kind !== "repository") return;
    const initial = records("ws-git");
    const store = WorkstreamStore.create(root, initial.metadata, initial.intent);
    const { runtime, scope } = await acquire(store, root);
    ownedScope = scope;
    await Effect.runPromise(
      runtime.createTask({
        id: "implementation",
        kind: "implementation",
        objective: "Change bytes",
        target,
      }),
    );
    const first = await Effect.runPromise(
      runtime.createAttempt({
        taskId: "implementation",
        models: [
          { role: "guide", model: "test/guide" },
          { role: "executor", model: "test/executor" },
        ],
      }),
    );
    const firstRepository = first.repository;
    assert.ok(firstRepository);
    await Effect.runPromise(runtime.launch(first.id));
    writeFileSync(join(firstRepository.worktreePath, "value.txt"), "candidate\n");
    git(firstRepository.worktreePath, ["add", "."]);
    git(firstRepository.worktreePath, ["commit", "-qm", "candidate"]);
    await Effect.runPromise(runtime.observe(first.id));
    const retained = store.attempt(first.id);
    assert.equal(retained.repository?.output, "retained");
    const retainedRepository = retained.repository;
    if (retainedRepository?.candidateRevision === undefined)
      throw new Error("Expected retained candidate output.");
    assert.equal(
      git(checkout, ["rev-parse", retainedRepository.outputRef]),
      retainedRepository.candidateRevision,
    );
    const extension = await Effect.runPromise(
      runtime.createAttempt({
        taskId: "implementation",
        models: first.models,
        lineage: {
          kind: "extend",
          parentAttemptId: first.id,
          parentCommit: retainedRepository.candidateRevision,
        },
        baseRevision: retainedRepository.candidateRevision,
      }),
    );
    assert.equal(extension.repository?.baseRevision, retained.repository?.candidateRevision);
    const applied = await Effect.runPromise(runtime.apply(first.id));
    assert.equal(applied.repository?.output, "applied");
    assert.equal(readFileSync(join(checkout, "value.txt"), "utf8"), "candidate\n");

    await Effect.runPromise(
      runtime.createTask({
        id: "dirty",
        kind: "experiment",
        objective: "Dirty experiment",
        target,
      }),
    );
    const dirty = await Effect.runPromise(
      runtime.createAttempt({
        taskId: "dirty",
        models: [{ role: "research", model: "test/model" }],
        experiment: true,
      }),
    );
    const dirtyRepository = dirty.repository;
    assert.ok(dirtyRepository);
    await Effect.runPromise(runtime.launch(dirty.id));
    writeFileSync(join(dirtyRepository.worktreePath, "untracked.txt"), "useful\n");
    await Effect.runPromise(runtime.cancel(dirty.id, "Stop experiment"));
    assert.equal(store.attempt(dirty.id).repository?.output, "dirty");
    await assert.rejects(Effect.runPromise(runtime.apply(dirty.id)));
    const discarded = await Effect.runPromise(
      runtime.discard(dirty.id, "Experiment is no longer needed"),
    );
    assert.equal(discarded.repository?.output, "discarded");
    await Effect.runPromise(Scope.close(scope, Exit.void));
    ownedScope = undefined;
  } finally {
    if (ownedScope !== undefined) await Effect.runPromise(Scope.close(ownedScope, Exit.void));
    rmSync(root, { recursive: true, force: true });
  }
});

void test("adoption atomically replaces the owner only after exact prior absence", () => {
  const root = temporary();
  try {
    const initial = records("ws-adopt");
    const store = WorkstreamStore.create(root, initial.metadata, initial.intent);
    const successor = { sessionId: "next", sessionFile: "/sessions/next.jsonl", tabId: "tab-next" };
    assert.throws(() => store.adopt(owner, successor, false, at), StoreError);
    assert.deepEqual(store.metadata().owner, owner);
    assert.deepEqual(store.adopt(owner, successor, true, at).owner, successor);
    assert.throws(
      () =>
        store.createTask(owner, {
          id: "stale",
          workstreamId: store.id,
          intentIndex: 0,
          kind: "research",
          objective: "stale",
          target: { kind: "directory", path: root },
          contract: {},
          createdAt: at,
        }),
      StoreError,
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
