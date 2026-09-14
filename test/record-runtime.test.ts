/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/global-date, anti-slop/no-object-parameters, typescript/no-unsafe-member-access, anti-slop/require-safety-comment-for-type-assertion -- Flow tests inspect deterministic native transport logs and real Pi session files. */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect, Exit, Scope } from "effect";
import { RuntimeError, SessionRuntime } from "../src/coordination/runtime.js";
import type { AttemptSpec, Task } from "../src/domain/records.js";
import { HerdrCliRuntime } from "../src/herdr.js";
import { herdrWorkerName, herdrWorkerTabLabel } from "../src/herdr-naming.js";
import { runNodePlatformPromise } from "../src/node-platform.js";
import { createWorkerSessionEffect, type WorkerObjective } from "../src/pi-session.js";
import { RecordStore } from "../src/storage/record-store.js";

const target = { model: "test/model", thinking: "high" as const };
const selection = { kind: "target" as const, target };
const spec: AttemptSpec = { selection, base: { kind: "directory" } };
const task = (root: string, id: string): Task => ({
  target: { kind: "directory", path: join(root, id) },
  contract: {
    kind: "research",
    question: `Research ${id}`,
    expectedEvidence: ["Direct observation"],
  },
});
const objective = (taskId: string, attemptId: string, value: Task): WorkerObjective => ({
  content: [
    "[WORKGRAPH WORKER OBJECTIVE]",
    `Task ${taskId} target: ${JSON.stringify(value.target)}`,
    `Question: Research ${taskId}`,
    "Expected evidence: Direct observation",
  ].join("\n"),
  details: { taskId, attemptId, role: "research" },
});
function temporary(): string {
  return mkdtempSync(join(tmpdir(), "session-runtime-"));
}
function fixture(root: string, initial: object = {}) {
  const executable = join(root, "herdr.mjs");
  const statePath = join(root, "native.json");
  const log = join(root, "commands.log");
  writeFileSync(statePath, JSON.stringify(initial));
  writeFileSync(
    executable,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args=process.argv.slice(2); appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+"\\n");
const path=${JSON.stringify(statePath)}; const state=JSON.parse(readFileSync(path,"utf8")); const save=()=>writeFileSync(path,JSON.stringify(state)); const ok=(result)=>console.log(JSON.stringify({result}));
if(args[0]==="tab"&&args[1]==="create"){state.present=true;state.partial=true;state.workspace=args[args.indexOf("--workspace")+1];state.cwd=args[args.indexOf("--cwd")+1];state.label=args[args.indexOf("--label")+1];save();ok({tab:{workspace_id:state.workspace,tab_id:"tab-1"},root_pane:{workspace_id:state.workspace,tab_id:"tab-1",pane_id:"pane-1",cwd:state.cwd}})}
else if(args[0]==="agent"&&args[1]==="start"){state.partial=false;state.session=args[args.indexOf("--session")+1];state.name=args[2];save();ok({agent:{workspace_id:state.workspace,tab_id:"tab-1",pane_id:"pane-1",agent_status:state.status??"working",cwd:state.cwd,name:state.name,agent_session:{value:state.session},interactive_ready:true}})}
else if(args[0]==="agent"&&args[1]==="list")ok({agents:state.present&&!state.partial?[{workspace_id:state.workspace,tab_id:"tab-1",pane_id:"pane-1",agent_status:state.status??"working",cwd:state.cwd,name:state.name,agent_session:{value:state.session}}]:[]})
else if(args[0]==="tab"&&args[1]==="list")ok({tabs:state.present?[{workspace_id:state.workspace,tab_id:"tab-1",label:state.label}]:[]})
else if(args[0]==="pane"&&args[1]==="list")ok({panes:state.present?[{workspace_id:state.workspace,tab_id:"tab-1",pane_id:"pane-1",cwd:state.cwd}]:[]})
else if(args[0]==="agent"&&args[1]==="prompt")ok({})
else if(args[0]==="tab"&&args[1]==="close"){if(!state.ignoreClose)state.present=false;save();ok({})}
else{console.error(JSON.stringify({error:{code:"unexpected"}}));process.exitCode=1}`,
  );
  chmodSync(executable, 0o700);
  return {
    herdr: new HerdrCliRuntime(executable, { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "coordinator" }),
    statePath,
    log,
  };
}
function commands(path: string): string[][] {
  try {
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
}
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 160; index += 1) {
    if (predicate()) return;
    await Effect.runPromise(Effect.sleep(25));
  }
  assert.fail("timed out");
}
function workerName(taskId: string, attemptId: string): string {
  return herdrWorkerName({ taskId, attemptId, role: "research" });
}
async function session(root: string, taskId: string, attemptId: string, value: Task) {
  return runNodePlatformPromise(
    createWorkerSessionEffect({
      cwd: value.target.kind === "directory" ? value.target.path : value.target.checkoutRoot,
      sessionDir: join(root, "sessions"),
      objective: objective(taskId, attemptId, value),
    }),
  );
}

void test("staged launch persists original workspace and shutdown never closes the Worker", async () => {
  const root = temporary();
  const store = new RecordStore(root, "session-a");
  const value = task(root, "launch");
  const attempt = store.createTaskWithAttempt("launch", value, "attempt-launch", spec).attempt;
  const native = fixture(root);
  const scope = await Effect.runPromise(Scope.make());
  try {
    const runtime = await Effect.runPromise(
      SessionRuntime.acquire({
        store,
        agentDir: root,
        workspaceId: "workspace-old",
        pi: { sendMessage() {} },
        herdr: native.herdr,
      }).pipe(Scope.provide(scope)),
    );
    await waitFor(
      () =>
        store.readAttempt(attempt.id).worker?.kickoff === "confirmed" ||
        runtime.inspectionStatus().blockers.length > 0,
    );
    assert.equal(
      store.readAttempt(attempt.id).worker?.kickoff,
      "confirmed",
      runtime
        .inspectionStatus()
        .blockers.map((item) => item.detail)
        .join("; "),
    );
    const start = commands(native.log).find(
      (entry) => entry[0] === "agent" && entry[1] === "start",
    );
    assert.match(start?.[2] ?? "", /^wg-research-[0-9a-f]{6}$/);
    assert.equal(store.readAttempt(attempt.id).worker?.workspaceId, "workspace-old");
    await Effect.runPromise(Scope.close(scope, Exit.void));
    assert.equal(
      commands(native.log).filter((entry) => entry[0] === "tab" && entry[1] === "close").length,
      0,
    );
    assert.equal(JSON.parse(readFileSync(native.statePath, "utf8")).present, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("uncertain tab, agent, and kickoff recover from persisted facts without replay", async () => {
  for (const stage of ["tab", "agent", "kickoff"] as const) {
    const root = temporary();
    const store = new RecordStore(root, `session-${stage}`);
    const value = task(root, stage);
    const attempt = store.createTaskWithAttempt(stage, value, `attempt-${stage}`, spec).attempt;
    const created = await session(root, stage, attempt.id, value);
    const state = {
      present: true,
      partial: stage === "tab",
      workspace: "workspace-owner",
      cwd: value.target.kind === "directory" ? value.target.path : "",
      label: "",
      session: created.sessionFile,
      name: workerName(stage, attempt.id),
    };
    const native = fixture(root, state);
    const requestLabel = herdrWorkerTabLabel({
      taskId: stage,
      attemptId: attempt.id,
      role: "research",
    });
    state.label = requestLabel;
    writeFileSync(native.statePath, JSON.stringify(state));
    if (stage === "tab")
      store.checkpointWorker(attempt.id, {
        sessionFile: created.sessionFile,
        workspaceId: "workspace-owner",
        tab: { state: "uncertain" },
      });
    if (stage === "agent")
      store.checkpointWorker(attempt.id, {
        sessionFile: created.sessionFile,
        workspaceId: "workspace-owner",
        tab: { state: "ready", tabId: "tab-1", paneId: "pane-1" },
        agent: "uncertain",
      });
    if (stage === "kickoff")
      store.checkpointWorker(attempt.id, {
        sessionFile: created.sessionFile,
        workspaceId: "workspace-owner",
        tab: { state: "ready", tabId: "tab-1", paneId: "pane-1" },
        agent: "ready",
        kickoff: "uncertain",
      });
    const scope = await Effect.runPromise(Scope.make());
    try {
      const runtime = await Effect.runPromise(
        SessionRuntime.acquire({
          store,
          agentDir: root,
          workspaceId: "workspace-new",
          pi: { sendMessage() {} },
          herdr: native.herdr,
        }).pipe(Scope.provide(scope)),
      );
      if (stage === "kickoff") {
        await waitFor(() =>
          runtime
            .inspectionStatus()
            .blockers.some((item) => /Kickoff is uncertain/.test(item.detail)),
        );
        assert.equal(store.readAttempt(attempt.id).worker?.kickoff, "uncertain");
        const cancelled = await Effect.runPromise(runtime.cancel(attempt.id, "stop"));
        assert.equal(cancelled.outcome?.result.kind, "cancelled");
      } else await waitFor(() => store.readAttempt(attempt.id).worker?.kickoff === "confirmed");
      const log = commands(native.log);
      assert.equal(log.filter((entry) => entry.slice(0, 2).join(" ") === "tab create").length, 0);
      assert.equal(
        log.filter((entry) => entry.slice(0, 2).join(" ") === "agent start").length,
        stage === "tab" ? 1 : 0,
      );
      assert.equal(
        log.filter((entry) => entry.slice(0, 2).join(" ") === "agent prompt").length,
        stage === "kickoff" ? 0 : 1,
      );
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      rmSync(root, { recursive: true, force: true });
    }
  }
});

void test("Outcome is written before one close and reload duplicates neither close nor notification", async () => {
  const root = temporary();
  let store = new RecordStore(root, "session-settle");
  const value = task(root, "settle");
  const attempt = store.createTaskWithAttempt("settle", value, "attempt-settle", spec).attempt;
  const created = await session(root, "settle", attempt.id, value);
  const manager = SessionManager.open(created.sessionFile);
  manager.appendCustomEntry("pi-workgraph-effective-model", target);
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "report",
    toolName: "workgraph_report",
    content: [{ type: "text", text: "done" }],
    details: {
      report: {
        kind: "research",
        status: "completed",
        summary: "settled",
        evidence: [],
        findings: [],
      },
    },
    isError: false,
    timestamp: Date.now(),
  });
  manager.appendCustomEntry("pi-workgraph-agent-settled", {});
  store.checkpointWorker(attempt.id, {
    sessionFile: created.sessionFile,
    workspaceId: "workspace-owner",
    tab: { state: "ready", tabId: "tab-1", paneId: "pane-1" },
    agent: "ready",
    kickoff: "confirmed",
  });
  const native = fixture(root, {
    present: true,
    partial: false,
    status: "done",
    workspace: "workspace-owner",
    cwd: value.target.kind === "directory" ? value.target.path : "",
    session: created.sessionFile,
    name: workerName("settle", attempt.id),
  });
  let notifications = 0;
  let outcomeWasDurableAtNotification = false;
  let scope = await Effect.runPromise(Scope.make());
  try {
    await Effect.runPromise(
      SessionRuntime.acquire({
        store,
        agentDir: root,
        workspaceId: "workspace-new",
        pi: {
          sendMessage() {
            notifications += 1;
            outcomeWasDurableAtNotification = store.readAttempt(attempt.id).outcome !== undefined;
          },
        },
        herdr: native.herdr,
      }).pipe(Scope.provide(scope)),
    );
    await waitFor(() => store.readAttempt(attempt.id).worker?.closed === true);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    store = new RecordStore(root, "session-settle");
    scope = await Effect.runPromise(Scope.make());
    await Effect.runPromise(
      SessionRuntime.acquire({
        store,
        agentDir: root,
        workspaceId: "other",
        pi: {
          sendMessage() {
            notifications += 1;
          },
        },
        herdr: native.herdr,
      }).pipe(Scope.provide(scope)),
    );
    await Effect.runPromise(Effect.sleep(400));
    assert.equal(notifications, 1);
    assert.equal(outcomeWasDurableAtNotification, true);
    assert.equal(
      commands(native.log).filter((entry) => entry.slice(0, 2).join(" ") === "tab close").length,
      1,
    );
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(root, { recursive: true, force: true });
  }
});

void test("queued cancellation makes no Herdr call and active cancellation closes exactly once", async () => {
  const root = temporary();
  const store = new RecordStore(root, "session-cancel");
  const queued = store.createTaskWithAttempt(
    "queued",
    task(root, "queued"),
    "attempt-queued",
    spec,
  ).attempt;
  const activeValue = task(root, "active");
  const active = store.createTaskWithAttempt("active", activeValue, "attempt-active", spec).attempt;
  const created = await session(root, "active", active.id, activeValue);
  const actualTarget = { model: "observed/model", thinking: "medium" as const };
  SessionManager.open(created.sessionFile).appendCustomEntry(
    "pi-workgraph-effective-model",
    actualTarget,
  );
  store.checkpointWorker(active.id, {
    sessionFile: created.sessionFile,
    workspaceId: "workspace-owner",
    tab: { state: "ready", tabId: "tab-1", paneId: "pane-1" },
    agent: "ready",
    kickoff: "confirmed",
  });
  const native = fixture(root, {
    present: true,
    partial: false,
    status: "blocked",
    workspace: "workspace-owner",
    cwd: activeValue.target.kind === "directory" ? activeValue.target.path : "",
    session: created.sessionFile,
    name: workerName("active", active.id),
  });
  const scope = await Effect.runPromise(Scope.make());
  let notifications = 0;
  try {
    const runtime = await Effect.runPromise(
      SessionRuntime.acquire({
        store,
        agentDir: root,
        workspaceId: "workspace-new",
        pi: {
          sendMessage() {
            notifications += 1;
          },
        },
        herdr: native.herdr,
      }).pipe(Scope.provide(scope)),
    );
    await assert.rejects(Effect.runPromise(runtime.steer(active.id, "continue")), RuntimeError);
    assert.equal(
      commands(native.log).filter((entry) => entry.slice(0, 2).join(" ") === "agent prompt").length,
      0,
    );
    const before = commands(native.log).length;
    const queuedCancelled = await Effect.runPromise(runtime.cancel(queued.id, "not needed"));
    assert.equal(queuedCancelled.outcome?.result.kind, "cancelled");
    assert.deepEqual(queuedCancelled.outcome?.effectiveModels, []);
    assert.equal(commands(native.log).length, before);
    const activeCancelled = await Effect.runPromise(runtime.cancel(active.id, "stop"));
    assert.equal(activeCancelled.worker?.closed, true);
    assert.deepEqual(activeCancelled.outcome?.effectiveModels, [actualTarget]);
    assert.equal(
      commands(native.log).filter((entry) => entry.slice(0, 2).join(" ") === "tab close").length,
      1,
    );
    assert.equal(notifications, 2);
    await assert.rejects(Effect.runPromise(runtime.cancel(active.id, "again")), RuntimeError);
    assert.equal(notifications, 2);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(root, { recursive: true, force: true });
  }
});

void test("creation uses global Attempt IDs and rejects unsettled review sources before mutation", async () => {
  const root = temporary();
  const store = new RecordStore(root, "session-create");
  const native = fixture(root);
  const scope = await Effect.runPromise(Scope.make());
  try {
    const runtime = await Effect.runPromise(
      SessionRuntime.acquire({
        store,
        agentDir: root,
        workspaceId: "workspace-owner",
        pi: { sendMessage() {} },
        herdr: native.herdr,
      }).pipe(Scope.provide(scope)),
    );
    const first = await Effect.runPromise(
      runtime.createTask({
        id: "source",
        target: task(root, "source").target,
        contract: task(root, "source").contract,
        selection,
      }),
    );
    const second = await Effect.runPromise(runtime.createAttempt({ taskId: "source", selection }));
    assert.match(first.id, /^attempt-[0-9a-f-]{36}$/);
    assert.match(second.id, /^attempt-[0-9a-f-]{36}$/);
    assert.notEqual(first.id, second.id);
    await assert.rejects(
      Effect.runPromise(
        runtime.createTask({
          id: "review",
          target: task(root, "review").target,
          contract: {
            kind: "review",
            objective: "Review source",
            concern: "Evidence",
            subject: { kind: "attempt", attemptId: first.id },
          },
          selection,
        }),
      ),
      RuntimeError,
    );
    assert.equal(store.counts().tasks, 1);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(root, { recursive: true, force: true });
  }
});

void test("a close-present blocker never repeats the close effect", async () => {
  const root = temporary();
  const store = new RecordStore(root, "session-close-blocked");
  const value = task(root, "blocked");
  const attempt = store.createTaskWithAttempt("blocked", value, "attempt-blocked", spec).attempt;
  const created = await session(root, "blocked", attempt.id, value);
  const manager = SessionManager.open(created.sessionFile);
  manager.appendCustomEntry("pi-workgraph-agent-settled", {});
  store.checkpointWorker(attempt.id, {
    sessionFile: created.sessionFile,
    workspaceId: "workspace-owner",
    tab: { state: "ready", tabId: "tab-1", paneId: "pane-1" },
    agent: "ready",
    kickoff: "confirmed",
  });
  const native = fixture(root, {
    present: true,
    partial: false,
    ignoreClose: true,
    workspace: "workspace-owner",
    cwd: value.target.kind === "directory" ? value.target.path : "",
    session: created.sessionFile,
    name: workerName("blocked", attempt.id),
  });
  const scope = await Effect.runPromise(Scope.make());
  try {
    const runtime = await Effect.runPromise(
      SessionRuntime.acquire({
        store,
        agentDir: root,
        workspaceId: "new",
        pi: { sendMessage() {} },
        herdr: native.herdr,
      }).pipe(Scope.provide(scope)),
    );
    await waitFor(() => store.readAttempt(attempt.id).worker?.closing?.kind === "settled");
    await Effect.runPromise(Effect.sleep(800));
    assert.equal(
      commands(native.log).filter((entry) => entry.slice(0, 2).join(" ") === "tab close").length,
      1,
    );
    assert.match(
      runtime
        .inspectionStatus()
        .blockers.map((item) => item.detail)
        .join("; "),
      /close will not be repeated/,
    );
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(root, { recursive: true, force: true });
  }
});

void test("steering and repository classification reject inexact or open Workers without mutation", async () => {
  const root = temporary();
  const store = new RecordStore(root, "session-guard");
  const value = task(root, "guard");
  const attempt = store.createTaskWithAttempt("guard", value, "attempt-guard", spec).attempt;
  const created = await session(root, "guard", attempt.id, value);
  store.checkpointWorker(attempt.id, {
    sessionFile: created.sessionFile,
    workspaceId: "workspace-owner",
    tab: { state: "ready", tabId: "tab-1", paneId: "pane-1" },
    agent: "ready",
    kickoff: "confirmed",
  });
  const native = fixture(root, {
    present: false,
    partial: false,
    workspace: "workspace-owner",
    cwd: value.target.kind === "directory" ? value.target.path : "",
    session: created.sessionFile,
  });
  const scope = await Effect.runPromise(Scope.make());
  try {
    const runtime = await Effect.runPromise(
      SessionRuntime.acquire({
        store,
        agentDir: root,
        workspaceId: "new",
        pi: { sendMessage() {} },
        herdr: native.herdr,
      }).pipe(Scope.provide(scope)),
    );
    await assert.rejects(Effect.runPromise(runtime.steer(attempt.id, "continue")), RuntimeError);
    assert.equal(
      commands(native.log).filter((entry) => entry.slice(0, 2).join(" ") === "agent prompt").length,
      0,
    );
    await assert.rejects(Effect.runPromise(runtime.apply(attempt.id)), RuntimeError);
    await waitFor(
      () =>
        store.readAttempt(attempt.id).outcome?.result.kind === "unreported" &&
        store.readAttempt(attempt.id).worker?.closed === true,
    );
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(root, { recursive: true, force: true });
  }
});
