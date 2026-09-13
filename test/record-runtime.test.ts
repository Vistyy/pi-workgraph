/* oxlint-disable effecttsgo/node-builtin-import, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion -- Behavioral tests exercise typed records returned by native temporary SQLite storage. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect, Exit, Scope } from "effect";
import { Value } from "typebox/value";
import { WorkstreamRuntime } from "../src/coordination/runtime.js";
import type {
  Attempt,
  CoordinatorOwner,
  Intent,
  Outcome,
  Task,
  WorkstreamMetadata,
} from "../src/domain/records.js";
import {
  TaskIdSchema,
  WORKSTREAM_FORMAT,
  WORKSTREAM_SCHEMA_VERSION,
} from "../src/domain/records.js";
import { StoreError, WorkstreamStore } from "../src/storage/workstream-store.js";

const at = "2026-03-20T12:00:00.000Z";
const later = "2026-03-20T12:01:00.000Z";
const owner: CoordinatorOwner = {
  sessionId: "coordinator",
  sessionFile: "/sessions/coordinator.jsonl",
  workspaceId: "workspace-1",
  tabId: "tab-1",
};
const target = { model: "test/model", thinking: "high" as const };

function temporary(): string {
  return mkdtempSync(join(tmpdir(), "workgraph-records-"));
}
function initial(id: string): { metadata: WorkstreamMetadata; intent: Intent } {
  return {
    metadata: {
      format: WORKSTREAM_FORMAT,
      schemaVersion: WORKSTREAM_SCHEMA_VERSION,
      id,
      owner,
      lifecycle: "active",
      createdAt: at,
      updatedAt: at,
    },
    intent: {
      statement: "Coordinate several independent targets",
      constraints: ["Keep each target independent"],
      authority: {
        receiptId: "receipt-1",
        sessionId: owner.sessionId,
        sessionFile: owner.sessionFile,
      },
      recordedAt: at,
    },
  };
}
function task(id: string): Task {
  return {
    target: { kind: "directory", path: `/targets/${id}` },
    contract: {
      kind: "research",
      question: `Research ${id}`,
      expectedEvidence: ["Direct observation"],
    },
    createdAt: at,
  };
}
function attempt(): Attempt {
  return { selection: { kind: "target", target }, base: { kind: "directory" } };
}
function outcome(summary: string): Outcome {
  return {
    result: {
      kind: "reported",
      report: { kind: "research", status: "completed", summary, evidence: [], findings: [] },
    },
    effectiveModels: [target],
    delivery: { requestedAt: later, failures: [] },
    observedAt: at,
  };
}

void test("public Task IDs are bounded safe identity components", () => {
  assert.equal(Value.Check(TaskIdSchema, "git-output-correction"), true);
  for (const unsafe of ["../foreign", "nested/task", ".hidden", "task.lock", "x".repeat(65)])
    assert.equal(Value.Check(TaskIdSchema, unsafe), false, unsafe);
});

void test("creation is private and retries attach without replaying an advanced store", () => {
  const root = temporary();
  try {
    const records = initial("ws-create");
    const first = WorkstreamStore.create(root, records.metadata, records.intent);
    const appended = first.appendIntent(owner, {
      ...records.intent,
      statement: "Refined intent",
      recordedAt: later,
    });
    assert.equal(appended.index, 1);
    first.close();

    const retry = WorkstreamStore.create(root, records.metadata, records.intent);
    assert.equal(retry.readLatestIntent().index, 1);
    assert.equal(retry.readLatestIntent().intent.statement, "Refined intent");
    assert.equal(retry.title(), "Refined intent");
    assert.equal(retry.path, WorkstreamStore.pathFor(root, "ws-create"));
    assert.equal(statSync(retry.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, "workgraph", "workstreams", "ws-create")).mode & 0o777, 0o700);
    retry.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("owned writes require the exact owner and adoption is one owner CAS", () => {
  const root = temporary();
  try {
    const records = initial("ws-owner");
    const store = WorkstreamStore.create(root, records.metadata, records.intent);
    const successor: CoordinatorOwner = {
      sessionId: "next",
      sessionFile: "/sessions/next.jsonl",
      workspaceId: "workspace-2",
      tabId: "tab-2",
    };
    assert.throws(
      () => store.appendIntent({ ...owner, workspaceId: "foreign" }, records.intent),
      StoreError,
    );
    assert.throws(() => store.adopt(owner, successor, false, later), StoreError);
    assert.deepEqual(store.readMetadata().owner, owner);
    assert.deepEqual(store.adopt(owner, successor, true, later).owner, successor);
    assert.throws(() => store.appendIntent(owner, records.intent), StoreError);
    store.close();
    assert.throws(() => WorkstreamStore.openOwned(root, "ws-owner", owner), StoreError);
    WorkstreamStore.openOwned(root, "ws-owner", successor).close();
    WorkstreamStore.openReadOnly(root, "ws-owner").close();
    assert.throws(() => WorkstreamStore.openReadOnly(root, "other"), StoreError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("Task and initial Attempt insert atomically and pages preserve SQL order", () => {
  const root = temporary();
  try {
    const records = initial("ws-pages");
    const store = WorkstreamStore.create(root, records.metadata, records.intent);
    assert.throws(
      () =>
        store.createTaskWithAttempt(owner, 0, "bad", task("bad"), "bad-1", {
          ...attempt(),
          selection: { kind: "target", target: { ...target, model: "invalid" } },
        }),
      StoreError,
    );
    assert.equal(store.page("tasks", -1, 10).length, 0);
    assert.equal(store.page("attempts", -1, 10).length, 0);

    const first = store.createTaskWithAttempt(owner, 0, "one", task("one"), "one-1", attempt());
    const second = store.createTaskWithAttempt(owner, 0, "two", task("two"), "two-1", attempt());
    const retry = store.appendAttempt(owner, "one", "one-2", attempt());
    assert.equal(first.task.index, 0);
    assert.equal(second.task.index, 1);
    assert.equal(retry.index, 2);
    assert.deepEqual(
      (store.page("tasks", -1, 1) as Array<{ id: string }>).map((record) => record.id),
      ["one"],
    );
    assert.deepEqual(
      (store.page("tasks", 0, 10) as Array<{ id: string }>).map((record) => record.id),
      ["two"],
    );
    assert.deepEqual(
      (store.page("attempts", -1, 10) as Array<{ id: string }>).map((record) => record.id),
      ["one-1", "two-1", "one-2"],
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("the concrete runtime settles and delivers prelaunch cancellation", async () => {
  const root = temporary();
  const records = initial("ws-cancel");
  const store = WorkstreamStore.create(root, records.metadata, records.intent);
  const created = store.createTaskWithAttempt(
    owner,
    0,
    "queued",
    task("queued"),
    "queued-1",
    attempt(),
  );
  store.checkpointAttempt(owner, created.attempt.id, {
    ...created.attempt.attempt,
    execution: {
      submission: "absent",
      cancellation: { reason: "No longer needed", requestedAt: later },
    },
  });
  const delivered: unknown[] = [];
  const pi: Pick<ExtensionAPI, "sendMessage"> = {
    sendMessage(message) {
      delivered.push(message);
    },
  };
  const scope = await Effect.runPromise(Scope.make());
  try {
    const attachment = await Effect.runPromise(
      WorkstreamRuntime.acquire({ store, owner, agentDir: root, pi }).pipe(Scope.provide(scope)),
    );
    assert.equal(attachment.state, "attached");
    for (
      let count = 0;
      count < 50 && (store.readOutcome("queued-1") === undefined || delivered.length === 0);
      count += 1
    )
      await Effect.runPromise(Effect.sleep(10));
    const outcomeRecord = store.readOutcome("queued-1");
    assert.equal(outcomeRecord?.outcome.result.kind, "cancelled");
    assert.notEqual(store.readAttempt("queued-1").attempt.execution?.closedAt, undefined);
    assert.equal(delivered.length, 1);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(root, { recursive: true, force: true });
  }
});

void test("review objectives retain cited Outcome summaries and exact source facts", async () => {
  const root = temporary();
  const records = initial("ws-review-source");
  const store = WorkstreamStore.create(root, records.metadata, records.intent);
  const source = store.createTaskWithAttempt(owner, 0, "source", task("source"), "source-1", {
    ...attempt(),
    execution: {
      sessionFile: "/sessions/source.jsonl",
      paneId: "source-pane",
      tabId: "source-tab",
      terminalId: "source-terminal",
      submission: "confirmed",
      closedAt: later,
    },
  });
  store.insertOutcome(owner, "source-outcome", source.attempt.id, {
    ...outcome("Exact source summary"),
    delivery: { requestedAt: later, failures: [], deliveredAt: later },
  });
  const scope = await Effect.runPromise(Scope.make());
  try {
    const attachment = await Effect.runPromise(
      WorkstreamRuntime.acquire({
        store,
        owner,
        agentDir: root,
        pi: { sendMessage() {} },
      }).pipe(Scope.provide(scope)),
    );
    assert.equal(attachment.state, "attached");
    if (attachment.state !== "attached") return;
    const review = await Effect.runPromise(
      attachment.runtime.createTask({
        id: "review",
        target: { kind: "directory", path: root },
        contract: {
          kind: "review",
          objective: "Review source result",
          concern: "Evidence quality",
          subject: { kind: "outcome", outcomeId: "source-outcome" },
        },
        selection: { kind: "target", target },
      }),
    );
    let sessionFile: string | undefined;
    for (let count = 0; count < 50 && sessionFile === undefined; count += 1) {
      sessionFile = store.readAttempt(review.id).attempt.execution?.sessionFile;
      if (sessionFile === undefined) await Effect.runPromise(Effect.sleep(10));
    }
    assert.notEqual(sessionFile, undefined);
    if (sessionFile === undefined) return;
    const objectiveEntry = SessionManager.open(sessionFile)
      .getBranch()
      .find(
        (entry) => entry.type === "custom_message" && entry.customType === "pi-workgraph-objective",
      );
    assert.equal(objectiveEntry?.type, "custom_message");
    if (objectiveEntry?.type !== "custom_message" || typeof objectiveEntry.content !== "string")
      return;
    assert.match(objectiveEntry.content, /Exact source summary/);
    assert.match(objectiveEntry.content, /source-outcome/);
    assert.match(objectiveEntry.content, /\/targets\/source/);
    assert.match(objectiveEntry.content, /\/sessions\/source\.jsonl/);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(root, { recursive: true, force: true });
  }
});

void test("Outcomes are independent, only delivery mutates, and Outcomes alone gate completion", () => {
  const root = temporary();
  try {
    const records = initial("ws-outcomes");
    const store = WorkstreamStore.create(root, records.metadata, records.intent);
    store.createTaskWithAttempt(owner, 0, "one", task("one"), "one-1", attempt());
    store.createTaskWithAttempt(owner, 0, "two", task("two"), "two-1", attempt());
    store.insertOutcome(owner, "outcome-one", "one-1", outcome("one complete"));
    assert.throws(
      () =>
        store.complete(owner, {
          conclusion: "Too early",
          evidence: [],
          limitations: [],
          completedAt: later,
        }),
      StoreError,
    );
    store.insertOutcome(owner, "outcome-two", "two-1", outcome("two complete"));

    const failed = store.updateDelivery(owner, "one-1", {
      requestedAt: later,
      failures: [{ at: later, detail: "Coordinator unavailable" }],
    });
    assert.equal(failed.outcome.result.kind, "reported");
    const delivered = store.updateDelivery(owner, "one-1", {
      ...failed.outcome.delivery,
      deliveredAt: later,
    });
    assert.equal(delivered.outcome.delivery.failures.length, 1);
    assert.equal(store.readOutcome("two-1")?.outcome.delivery.deliveredAt, undefined);

    const metadata = store.complete(owner, {
      conclusion: "All semantic work settled",
      evidence: ["Both Outcomes exist"],
      limitations: [],
      completedAt: later,
    });
    assert.equal(metadata.lifecycle, "completed");
    assert.equal(store.readOutcome("two-1")?.outcome.delivery.deliveredAt, undefined);
    const completion = metadata.completion;
    assert.ok(completion);
    assert.throws(() => store.complete(owner, completion), StoreError);
    assert.throws(
      () => store.createTaskWithAttempt(owner, 0, "late", task("late"), "late-1", attempt()),
      StoreError,
    );
    assert.throws(() => store.appendAttempt(owner, "one", "one-late", attempt()), StoreError);
    assert.throws(() => store.appendIntent(owner, records.intent), StoreError);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
