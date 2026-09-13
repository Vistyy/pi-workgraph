/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/global-date, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion -- Behavioral tests exercise typed records returned by native temporary SQLite storage. */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect, Exit, Scope } from "effect";
import { Value } from "typebox/value";
import { RuntimeError, WorkstreamRuntime } from "../src/coordination/runtime.js";
import type {
  Attempt,
  CoordinatorOwner,
  Intent,
  Outcome,
  Task,
  WorkstreamMetadata,
} from "../src/domain/records.js";
import {
  AttemptSchema,
  TaskIdSchema,
  WORKSTREAM_FORMAT,
  WORKSTREAM_SCHEMA_VERSION,
} from "../src/domain/records.js";
import { HerdrCliRuntime } from "../src/herdr.js";
import { herdrWorkerTabLabel } from "../src/herdr-naming.js";
import { runNodePlatformPromise } from "../src/node-platform.js";
import { createWorkerSessionEffect, WORKER_KICKOFF } from "../src/pi-session.js";
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
function fakeHerdr(root: string, body: string): { runtime: HerdrCliRuntime; log: string } {
  const executable = join(root, "herdr-fixture.mjs");
  const log = join(root, "herdr.log");
  writeFileSync(
    executable,
    `#!/usr/bin/env node\nimport { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");\n${body}\n`,
  );
  chmodSync(executable, 0o700);
  return {
    runtime: new HerdrCliRuntime(executable, {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: owner.workspaceId,
    }),
    log,
  };
}
function commands(log: string): string[][] {
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}
async function waitFor(predicate: () => boolean, attempts = 120): Promise<void> {
  for (let count = 0; count < attempts; count += 1) {
    if (predicate()) return;
    await Effect.runPromise(Effect.sleep(25));
  }
  assert.fail("Timed out waiting for runtime settlement.");
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

void test("public Task IDs and persisted execution have strict bounded identity", () => {
  assert.equal(Value.Check(TaskIdSchema, "git-output-correction"), true);
  assert.equal(
    Value.Check(AttemptSchema, {
      ...attempt(),
      execution: { sessionFile: "/session.jsonl", submission: "confirmed", paneId: "native" },
    }),
    false,
  );
  const firstLabel = herdrWorkerTabLabel({ runId: "ws", attemptId: "attempt-one" });
  const secondLabel = herdrWorkerTabLabel({ runId: "ws", attemptId: "attempt-two" });
  assert.notEqual(firstLabel, secondLabel);
  assert.ok(firstLabel.length <= 18);
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
  const created = store.createTaskWithAttempt(owner, 0, "queued", task("queued"), "queued-1", {
    ...attempt(),
    selection: { kind: "implementation", guide: target, executor: target },
  });
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
    assert.deepEqual(outcomeRecord?.outcome.effectiveModels, [target]);
    assert.notEqual(store.readAttempt("queued-1").attempt.execution?.closedAt, undefined);
    assert.equal(delivered.length, 1);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(root, { recursive: true, force: true });
  }
});

void test("uncertain submission recovery requires the exact persisted kickoff, not a model marker", async () => {
  const root = temporary();
  const records = initial("ws-kickoff-proof");
  const store = WorkstreamStore.create(root, records.metadata, records.intent);
  const objective = {
    content: [
      "[WORKGRAPH WORKER OBJECTIVE]",
      `Intent: ${records.intent.statement}`,
      ...records.intent.constraints.map((constraint) => `Constraint: ${constraint}`),
      "Question: Research kickoff-proof",
      "Expected evidence: Direct observation",
    ].join("\n"),
    details: {
      workstreamId: records.metadata.id,
      taskId: "kickoff-proof",
      attemptId: "kickoff-proof-1",
      role: "research" as const,
    },
  };
  const createdSession = await runNodePlatformPromise(
    createWorkerSessionEffect({
      cwd: "/targets/kickoff-proof",
      sessionDir: join(root, "sessions"),
      objective,
    }),
  );
  const session = SessionManager.open(createdSession.sessionFile);
  session.appendCustomEntry("pi-workgraph-effective-model", target);
  store.createTaskWithAttempt(owner, 0, "kickoff-proof", task("kickoff-proof"), "kickoff-proof-1", {
    ...attempt(),
    execution: { sessionFile: createdSession.sessionFile, submission: "uncertain" },
  });
  const { runtime: herdr, log } = fakeHerdr(
    root,
    `const ok = (result) => console.log(JSON.stringify({ result }));
if (args[0] === "agent" && args[1] === "list") ok({ agents: [{ workspace_id: "workspace-1", tab_id: "tab-proof", pane_id: "pane-proof", terminal_id: "terminal-proof", agent_status: "working", cwd: "/targets/kickoff-proof", agent_session: { value: ${JSON.stringify(createdSession.sessionFile)} } }] });
else { console.error(JSON.stringify({ error: { code: "unexpected" } })); process.exitCode = 1; }`,
  );
  const scope = await Effect.runPromise(Scope.make());
  try {
    const attachment = await Effect.runPromise(
      WorkstreamRuntime.acquire({
        store,
        owner,
        agentDir: root,
        pi: { sendMessage() {} },
        herdr,
      }).pipe(Scope.provide(scope)),
    );
    assert.equal(attachment.state, "attached");
    if (attachment.state !== "attached") return;

    session.appendMessage({
      role: "user",
      content: [
        { type: "text", text: WORKER_KICKOFF },
        { type: "text", text: "extra" },
      ],
      timestamp: Date.now(),
    });
    session.appendMessage({
      role: "user",
      content: [
        { type: "text", text: WORKER_KICKOFF },
        { type: "image", data: "AA==", mimeType: "image/png" },
      ],
      timestamp: Date.now(),
    });
    await waitFor(() =>
      (attachment.runtime.inspectionStatus().blocker ?? "").includes(
        "does not prove the exact persisted kickoff",
      ),
    );
    assert.equal(store.readAttempt("kickoff-proof-1").attempt.execution?.submission, "uncertain");

    session.appendMessage({
      role: "user",
      content: [{ type: "text", text: WORKER_KICKOFF }],
      timestamp: Date.now(),
    });
    await waitFor(
      () => store.readAttempt("kickoff-proof-1").attempt.execution?.submission === "confirmed",
    );
    assert.equal(
      commands(log).filter((args) => args.slice(0, 2).join(" ") === "agent prompt").length,
      0,
    );
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(root, { recursive: true, force: true });
  }
});

void test("fresh sessions launch once, recover by sessionFile, and cancellation closes once", async () => {
  const root = temporary();
  const records = initial("ws-native-ready");
  let store = WorkstreamStore.create(root, records.metadata, records.intent);
  const created = store.createTaskWithAttempt(
    owner,
    0,
    "ready",
    task("ready"),
    "ready-1",
    attempt(),
  );
  const statePath = join(root, "native-state.json");
  const { runtime: herdr, log } = fakeHerdr(
    root,
    `const statePath = ${JSON.stringify(statePath)};
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { present: false };
const save = () => writeFileSync(statePath, JSON.stringify(state));
const ok = (result) => console.log(JSON.stringify({ result }));
if (args[0] === "tab" && args[1] === "create") {
  state.present = true; save();
  ok({ tab: { tab_id: "tab-ready", workspace_id: "workspace-1" }, root_pane: { pane_id: "pane-ready", workspace_id: "workspace-1", tab_id: "tab-ready", cwd: "/targets/ready" } });
} else if (args[0] === "agent" && args[1] === "start") {
  state.sessionFile = args[args.indexOf("--session") + 1]; state.name = args[2]; save();
  ok({ agent: { workspace_id: "workspace-1", tab_id: "tab-ready", pane_id: "pane-ready", terminal_id: "terminal-ready", agent_status: "working", cwd: "/targets/ready", name: state.name, agent_session: { value: state.sessionFile }, interactive_ready: true } });
} else if (args[0] === "agent" && args[1] === "list") {
  ok({ agents: state.present && state.sessionFile ? [{ workspace_id: "workspace-1", tab_id: "tab-ready", pane_id: "pane-ready", terminal_id: "terminal-ready", agent_status: "working", cwd: "/targets/ready", agent_session: { value: state.sessionFile } }] : [] });
} else if (args[0] === "agent" && args[1] === "get") {
  ok({ agent: { workspace_id: "workspace-1", tab_id: "tab-ready", pane_id: "pane-ready", terminal_id: "terminal-ready", agent_status: "working", cwd: "/targets/ready", agent_session: { value: state.sessionFile } } });
} else if (args[0] === "tab" && args[1] === "list") ok({ tabs: [] });
else if (args[0] === "agent" && args[1] === "prompt") ok({});
else if (args[0] === "tab" && args[1] === "close") { state.present = false; save(); ok({}); }
else { console.error(JSON.stringify({ error: { code: "unexpected" } })); process.exitCode = 1; }`,
  );
  let scope = await Effect.runPromise(Scope.make());
  try {
    let attachment = await Effect.runPromise(
      WorkstreamRuntime.acquire({
        store,
        owner,
        agentDir: root,
        pi: { sendMessage() {} },
        herdr,
      }).pipe(Scope.provide(scope)),
    );
    assert.equal(attachment.state, "attached");
    if (attachment.state !== "attached") return;
    await waitFor(
      () => store.readAttempt(created.attempt.id).attempt.execution?.submission === "confirmed",
    );
    const execution = store.readAttempt(created.attempt.id).attempt.execution;
    assert.notEqual(execution?.sessionFile, undefined);
    assert.deepEqual(Object.keys(execution ?? {}).sort(), ["sessionFile", "submission"]);
    const observationsBeforeReload = commands(log).filter(
      (args) => args.slice(0, 2).join(" ") === "agent list",
    ).length;
    await Effect.runPromise(Scope.close(scope, Exit.void));

    store = WorkstreamStore.openOwned(root, records.metadata.id, owner);
    scope = await Effect.runPromise(Scope.make());
    attachment = await Effect.runPromise(
      WorkstreamRuntime.acquire({
        store,
        owner,
        agentDir: root,
        pi: { sendMessage() {} },
        herdr,
      }).pipe(Scope.provide(scope)),
    );
    assert.equal(attachment.state, "attached");
    if (attachment.state !== "attached") return;
    await waitFor(
      () =>
        commands(log).filter((args) => args.slice(0, 2).join(" ") === "agent list").length >
        observationsBeforeReload,
    );
    await Effect.runPromise(attachment.runtime.cancel(created.attempt.id, "Stop exact Worker"));
    assert.equal(store.readOutcome(created.attempt.id)?.outcome.result.kind, "cancelled");
    assert.notEqual(store.readAttempt(created.attempt.id).attempt.execution?.closedAt, undefined);
    await Effect.runPromise(Scope.close(scope, Exit.void));

    store = WorkstreamStore.openOwned(root, records.metadata.id, owner);
    scope = await Effect.runPromise(Scope.make());
    attachment = await Effect.runPromise(
      WorkstreamRuntime.acquire({
        store,
        owner,
        agentDir: root,
        pi: { sendMessage() {} },
        herdr,
      }).pipe(Scope.provide(scope)),
    );
    assert.equal(attachment.state, "attached");
    await Effect.runPromise(Effect.sleep(1_200));
    const nativeCommands = commands(log);
    assert.equal(
      nativeCommands.filter((args) => args.slice(0, 2).join(" ") === "tab create").length,
      1,
    );
    assert.equal(
      nativeCommands.filter((args) => args.slice(0, 2).join(" ") === "agent start").length,
      1,
    );
    assert.equal(
      nativeCommands.filter((args) => args.slice(0, 2).join(" ") === "agent prompt").length,
      1,
    );
    assert.equal(
      nativeCommands.filter((args) => args.slice(0, 2).join(" ") === "tab close").length,
      1,
    );
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(root, { recursive: true, force: true });
  }
});

void test("normal Outcome insertion closes once and reload only observes settled closure", async () => {
  const root = temporary();
  const records = initial("ws-normal-close");
  let store = WorkstreamStore.create(root, records.metadata, records.intent);
  const objective = {
    content:
      "[WORKGRAPH WORKER OBJECTIVE]\nIntent: Coordinate several independent targets\nConstraint: Keep each target independent\nQuestion: Research normal\nExpected evidence: Direct observation",
    details: {
      workstreamId: records.metadata.id,
      taskId: "normal",
      attemptId: "normal-1",
      role: "research" as const,
    },
  };
  const createdSession = await runNodePlatformPromise(
    createWorkerSessionEffect({
      cwd: "/targets/normal",
      sessionDir: join(root, "sessions"),
      objective,
    }),
  );
  const session = SessionManager.open(createdSession.sessionFile);
  session.appendCustomEntry("pi-workgraph-effective-model", target);
  session.appendMessage({
    role: "toolResult",
    toolCallId: "report",
    toolName: "workgraph_report",
    content: [{ type: "text", text: "done" }],
    details: {
      report: {
        kind: "research",
        status: "completed",
        summary: "Normal completion",
        evidence: [],
        findings: [],
      },
    },
    isError: false,
    timestamp: Date.now(),
  });
  session.appendCustomEntry("pi-workgraph-agent-settled", {});
  const sessionFile = createdSession.sessionFile;
  store.createTaskWithAttempt(owner, 0, "normal", task("normal"), "normal-1", {
    ...attempt(),
    execution: { sessionFile, submission: "confirmed" },
  });
  const statePath = join(root, "normal-native.json");
  writeFileSync(statePath, JSON.stringify({ present: true }));
  const { runtime: herdr, log } = fakeHerdr(
    root,
    `const statePath = ${JSON.stringify(statePath)};
const state = JSON.parse(readFileSync(statePath, "utf8"));
const ok = (result) => console.log(JSON.stringify({ result }));
if (args[0] === "agent" && args[1] === "list") ok({ agents: state.present ? [{ workspace_id: "workspace-1", tab_id: "tab-normal", pane_id: "pane-normal", terminal_id: "terminal-normal", agent_status: "idle", cwd: "/targets/normal", agent_session: { value: ${JSON.stringify(sessionFile)} } }] : [] });
else if (args[0] === "tab" && args[1] === "list") ok({ tabs: [] });
else if (args[0] === "tab" && args[1] === "close") { state.present = false; writeFileSync(statePath, JSON.stringify(state)); ok({}); }
else { console.error(JSON.stringify({ error: { code: "unexpected" } })); process.exitCode = 1; }`,
  );
  let scope = await Effect.runPromise(Scope.make());
  try {
    let attachment = await Effect.runPromise(
      WorkstreamRuntime.acquire({
        store,
        owner,
        agentDir: root,
        pi: { sendMessage() {} },
        herdr,
      }).pipe(Scope.provide(scope)),
    );
    assert.equal(attachment.state, "attached");
    await waitFor(
      () =>
        store.readOutcome("normal-1") !== undefined &&
        store.readAttempt("normal-1").attempt.execution?.closedAt !== undefined,
    );
    await Effect.runPromise(Scope.close(scope, Exit.void));
    store = WorkstreamStore.openOwned(root, records.metadata.id, owner);
    scope = await Effect.runPromise(Scope.make());
    attachment = await Effect.runPromise(
      WorkstreamRuntime.acquire({
        store,
        owner,
        agentDir: root,
        pi: { sendMessage() {} },
        herdr,
      }).pipe(Scope.provide(scope)),
    );
    assert.equal(attachment.state, "attached");
    await Effect.runPromise(Effect.sleep(1_200));
    assert.equal(
      commands(log).filter((args) => args.slice(0, 2).join(" ") === "tab close").length,
      1,
    );
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(root, { recursive: true, force: true });
  }
});

void test("a failed fresh start recovers a labelled partial tab without relaunch", async () => {
  const root = temporary();
  const records = initial("ws-native-partial");
  let store = WorkstreamStore.create(root, records.metadata, records.intent);
  store.createTaskWithAttempt(owner, 0, "partial", task("partial"), "partial-1", attempt());
  const label = herdrWorkerTabLabel({
    runId: records.metadata.id,
    attemptId: "partial-1",
    assignmentId: "partial",
    role: "research",
  });
  const { runtime: herdr, log } = fakeHerdr(
    root,
    `const ok = (result) => console.log(JSON.stringify({ result }));
if (args[0] === "tab" && args[1] === "create") ok({ tab: { tab_id: "tab-partial", workspace_id: "workspace-1" }, root_pane: { pane_id: "pane-partial", workspace_id: "workspace-1", tab_id: "tab-partial", cwd: "/targets/partial" } });
else if (args[0] === "agent" && args[1] === "start") { console.error(JSON.stringify({ error: { code: "start_failed" } })); process.exitCode = 1; }
else if (args[0] === "agent" && args[1] === "list") ok({ agents: [] });
else if (args[0] === "tab" && args[1] === "list") ok({ tabs: [{ tab_id: "tab-partial", workspace_id: "workspace-1", label: ${JSON.stringify(label)} }] });
else if (args[0] === "pane" && args[1] === "list") ok({ panes: [{ workspace_id: "workspace-1", tab_id: "tab-partial", pane_id: "pane-partial", terminal_id: "terminal-partial", cwd: "/targets/partial" }] });
else { console.error(JSON.stringify({ error: { code: "unexpected_write" } })); process.exitCode = 1; }`,
  );
  let scope = await Effect.runPromise(Scope.make());
  try {
    let attachment = await Effect.runPromise(
      WorkstreamRuntime.acquire({
        store,
        owner,
        agentDir: root,
        pi: { sendMessage() {} },
        herdr,
      }).pipe(Scope.provide(scope)),
    );
    assert.equal(attachment.state, "attached");
    if (attachment.state !== "attached") return;
    const firstRuntime = attachment.runtime;
    await waitFor(() => (firstRuntime.inspectionStatus().blocker ?? "").includes("partial"));
    await Effect.runPromise(Effect.sleep(1_200));
    await Effect.runPromise(Scope.close(scope, Exit.void));
    store = WorkstreamStore.openOwned(root, records.metadata.id, owner);
    scope = await Effect.runPromise(Scope.make());
    attachment = await Effect.runPromise(
      WorkstreamRuntime.acquire({
        store,
        owner,
        agentDir: root,
        pi: { sendMessage() {} },
        herdr,
      }).pipe(Scope.provide(scope)),
    );
    assert.equal(attachment.state, "attached");
    await Effect.runPromise(Effect.sleep(1_200));
    const nativeCommands = commands(log);
    assert.equal(
      nativeCommands.filter((args) => args.slice(0, 2).join(" ") === "tab create").length,
      1,
    );
    assert.equal(
      nativeCommands.filter((args) => args.slice(0, 2).join(" ") === "agent start").length,
      1,
    );
    assert.ok(nativeCommands.some((args) => args.slice(0, 2).join(" ") === "pane list"));
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
    await assert.rejects(
      Effect.runPromise(
        attachment.runtime.createTask({
          id: "missing-review",
          target: { kind: "directory", path: root },
          contract: {
            kind: "review",
            objective: "Review missing source",
            concern: "Evidence quality",
            subject: { kind: "outcome", outcomeId: "missing-outcome" },
          },
          selection: { kind: "target", target },
        }),
      ),
      RuntimeError,
    );
    assert.equal(store.page("tasks", -1, 10).length, 1);
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

void test("output and delivery failures remain visible with bounded independent backoff", async () => {
  const root = temporary();
  const records = initial("ws-visible-failures");
  const store = WorkstreamStore.create(root, records.metadata, records.intent);
  const broken = store.createTaskWithAttempt(
    owner,
    0,
    "broken-output",
    {
      target: {
        kind: "repository",
        checkoutRoot: join(root, "absent-checkout"),
        commonDir: join(root, "absent-git"),
      },
      contract: {
        kind: "implementation",
        objective: "Classify output",
        acceptance: ["Surface failure"],
      },
      createdAt: at,
    },
    "broken-output-1",
    {
      selection: { kind: "implementation", guide: target, executor: target },
      base: { kind: "repository", baseCommit: "f".repeat(40) },
      execution: { submission: "confirmed", closedAt: later },
    },
  );
  store.insertOutcome(owner, "broken-outcome", broken.attempt.id, {
    result: { kind: "cancelled", reason: "Fixture is already closed" },
    effectiveModels: [target],
    delivery: { requestedAt: later, failures: [], deliveredAt: later },
    observedAt: later,
  });
  const queued = store.createTaskWithAttempt(owner, 0, "delivery", task("delivery"), "delivery-1", {
    ...attempt(),
    execution: {
      submission: "absent",
      cancellation: { reason: "No work", requestedAt: later },
    },
  });
  let deliveries = 0;
  const scope = await Effect.runPromise(Scope.make());
  try {
    const attachment = await Effect.runPromise(
      WorkstreamRuntime.acquire({
        store,
        owner,
        agentDir: root,
        pi: {
          sendMessage() {
            deliveries += 1;
            throw new Error("delivery unavailable");
          },
        },
      }).pipe(Scope.provide(scope)),
    );
    assert.equal(attachment.state, "attached");
    if (attachment.state !== "attached") return;
    await waitFor(() => {
      const blocker = attachment.runtime.inspectionStatus().blocker ?? "";
      return blocker.includes("broken-output-1") && blocker.includes("delivery unavailable");
    });
    await Effect.runPromise(Effect.sleep(2_400));
    assert.ok(deliveries <= 2, `expected bounded delivery retries, observed ${deliveries}`);
    assert.ok((store.readOutcome(queued.attempt.id)?.outcome.delivery.failures.length ?? 0) <= 2);
    assert.match(attachment.runtime.inspectionStatus().blocker ?? "", /broken-output-1/);
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
