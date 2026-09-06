import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Recovery integration fixtures inspect real host resources.
import { existsSync } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Recovery integration fixtures mutate disposable native files and Git worktrees.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Fixture paths identify real Git, SQLite, Herdr, and session resources.
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Type } from "typebox";
import { GitRepository } from "../src/git.js";
import { HerdrCliRuntime } from "../src/herdr.js";
import { DEFAULT_MODEL_POLICY } from "../src/model-policy.js";
import { WorkgraphRegistry } from "../src/registry.js";
import type { WorkerReport } from "../src/types.js";
import { WorkstreamStore } from "../src/workstream.js";
import { WorkstreamRuntime } from "../src/workstream-runtime.js";
import {
  configureFixtureEnvironment,
  decodeTestValue,
  required,
  restoreFixtureEnvironment,
} from "./decoders.js";
import { extensionFixture, git, resultState, usage } from "./helpers.js";

const workspaceId = "recovery-workspace";
const transportStateSchema = Type.Object({
  status: Type.String(),
  closed: Type.Boolean(),
  paneGone: Type.Optional(Type.Boolean()),
  tabGone: Type.Optional(Type.Boolean()),
  agentGone: Type.Optional(Type.Boolean()),
  startupFailure: Type.Optional(Type.Boolean()),
  errorCode: Type.Optional(Type.String()),
  mismatchedCwd: Type.Optional(Type.String()),
});
type TransportChange = {
  status?: string;
  closed?: boolean;
  paneGone?: boolean;
  tabGone?: boolean;
  agentGone?: boolean;
  startupFailure?: boolean;
  errorCode?: string | undefined;
  mismatchedCwd?: string | undefined;
};
const blockedViewSchema = Type.Object({
  inspection: Type.Object({
    attention: Type.Object({ items: Type.Array(Type.Object({ blocker: Type.String() })) }),
  }),
});
const taskViewSchema = Type.Object({
  inspection: Type.Object({
    tasks: Type.Object({
      items: Type.Array(Type.Object({ idPreview: Type.String() })),
    }),
  }),
});
const outcomeViewSchema = Type.Object({ inspection: Type.Object({ result: Type.String() }) });

async function recoveryFixture() {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-public-recovery-"));
  const root = join(parent, "repo");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "fixture@example.test");
  await git(root, "config", "user.name", "Recovery fixture");
  await writeFile(join(root, "value.txt"), "before\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "Fixture base");

  const transportState = join(parent, "herdr-state.json");
  const transportLog = join(parent, "herdr-commands.jsonl");
  const command = join(parent, "fake-herdr.mjs");
  await writeFile(transportState, JSON.stringify({ status: "working", closed: false }));
  await writeFile(
    command,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const statePath = ${JSON.stringify(transportState)};
const logPath = ${JSON.stringify(transportLog)};
const args = process.argv.slice(2);
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const state = JSON.parse(readFileSync(statePath, "utf8"));
const save = () => writeFileSync(statePath, JSON.stringify(state));
const fail = (code) => { console.error(JSON.stringify({error:{code,message:"fixture absence"}})); process.exit(1); };
const value = (flag) => args[args.indexOf(flag) + 1];
if (args[0] === "tab" && args[1] === "create") {
  state.cwd = value("--cwd");
  save();
  console.log(JSON.stringify({result:{root_pane:{pane_id:"recovery-workspace:pane-1"}}}));
} else if (args[0] === "agent" && args[1] === "start") {
  state.name = args[2];
  state.sessionFile = value("--session");
  save();
  if (state.startupFailure) fail("startup_failed");
  console.log(JSON.stringify({result:{agent:{workspace_id:"recovery-workspace",tab_id:"recovery-workspace:tab-1",pane_id:"recovery-workspace:pane-1",terminal_id:"terminal-1",agent_status:state.status,name:state.name,cwd:state.cwd,agent_session:{value:state.sessionFile}}}}));
} else if (args[0] === "agent" && args[1] === "get") {
  if (state.closed || state.paneGone) fail(state.errorCode || "pane_not_found");
  if (state.agentGone) fail("agent_not_found");
  console.log(JSON.stringify({result:{agent:{workspace_id:"recovery-workspace",tab_id:"recovery-workspace:tab-1",pane_id:"recovery-workspace:pane-1",terminal_id:"terminal-1",agent_status:state.status,name:state.name,cwd:state.mismatchedCwd || state.cwd,agent_session:{value:state.sessionFile}}}}));
} else if (args[0] === "pane" && args[1] === "get") {
  if (state.closed || state.paneGone) fail("pane_not_found");
  console.log(JSON.stringify({result:{pane:{workspace_id:"recovery-workspace",tab_id:"recovery-workspace:tab-1",pane_id:"recovery-workspace:pane-1",terminal_id:"terminal-1",cwd:state.cwd}}}));
} else if (args[0] === "pane" && args[1] === "process-info") {
  console.log(JSON.stringify({result:{shell_pid:10,foreground_process_group_id:11,foreground_processes:["fish","pi"]}}));
} else if (args[0] === "tab" && args[1] === "close") {
  state.closed = true;
  save();
  console.log(JSON.stringify({result:{type:"ok"}}));
} else if (args[0] === "tab" && args[1] === "get") {
  if (state.closed || state.tabGone) fail("tab_not_found");
  console.log(JSON.stringify({result:{tab:{tab_id:"recovery-workspace:tab-1"}}}));
} else if (args[0] === "api" && args[1] === "snapshot") {
  const agents = state.closed ? [] : [{workspace_id:"recovery-workspace",tab_id:"recovery-workspace:tab-1",pane_id:"recovery-workspace:pane-1",terminal_id:"terminal-1",agent_status:state.status,name:state.name,cwd:state.cwd,agent_session:{value:state.sessionFile}}];
  console.log(JSON.stringify({result:{snapshot:{agents}}}));
} else {
  console.log(JSON.stringify({result:{accepted:true}}));
}
`,
  );
  await chmod(command, 0o755);

  const previous = configureFixtureEnvironment({
    PI_CODING_AGENT_DIR: join(parent, "agent"),
    PI_WORKGRAPH_HERDR_BIN: command,
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: workspaceId,
    PI_WORKGRAPH_MODE: null,
  });
  const pi = await extensionFixture("coordinator", root, parent);
  const repository = await GitRepository.open(root);
  const owner = {
    sessionId: pi.session.getSessionId(),
    sessionFile: required(pi.session.getSessionFile(), "coordinator session file"),
  };
  const { store } = await WorkstreamStore.create({
    id: "ws-recovery",
    purpose: "Exercise registered recovery",
    projectRoot: root,
    gitCommonDir: repository.commonDir,
    coordinator: owner,
  });
  const registry = new WorkgraphRegistry(join(parent, "runtime-registry.sqlite"));
  let registryOpen = true;
  const runtime = new WorkstreamRuntime(
    store,
    repository,
    new HerdrCliRuntime(command, {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: workspaceId,
    }),
    { workspaceId },
    () => Effect.void,
    () => Effect.void,
    { registry, policy: DEFAULT_MODEL_POLICY },
  );
  await Effect.runPromise(runtime.effects.submit(Effect.void));

  async function setTransport(change: TransportChange) {
    const current = decodeTestValue(
      transportStateSchema,
      JSON.parse(await readFile(transportState, "utf8")),
    );
    await writeFile(transportState, JSON.stringify({ ...current, ...change }));
  }

  async function authorize() {
    return Effect.runPromise(
      runtime.effects.submit(
        Effect.gen(function* () {
          const recorded = yield* store.effects.recordInputEvent({
            ...owner,
            source: "interactive",
            text: "Implement and recover the disposable fixture change.",
          });
          yield* store.effects.reviseIntent({
            authorityReceiptId: recorded.receipt.id,
            statement: "Implement the fixture change",
            constraints: [],
          });
          return { receiptId: recorded.receipt.id, intentVersion: 1 };
        }),
      ),
    );
  }

  async function settle(report: WorkerReport) {
    const state = await store.load();
    const attempt = required(state.attempts.at(-1), "latest recovery attempt");
    const session = SessionManager.open(required(attempt.sessionFile, "worker session file"));
    session.appendCustomEntry("pi-workgraph-agent-running", {
      runId: state.id,
      nodeId: attempt.id,
    });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Deterministic native worker output" }],
      api: "test",
      provider: "test",
      model: "worker",
      usage,
      stopReason: "stop",
      // oxlint-disable-next-line effecttsgo/global-date -- Pi's native persisted session contract requires a current epoch timestamp.
      timestamp: Date.now(),
    });
    session.appendMessage({
      role: "toolResult",
      toolCallId: "report",
      toolName: "workgraph_report",
      content: [{ type: "text", text: "report" }],
      details: { report },
      isError: false,
      // oxlint-disable-next-line effecttsgo/global-date -- Pi's native persisted session contract requires a current epoch timestamp.
      timestamp: Date.now(),
    });
    session.appendCustomEntry("pi-workgraph-agent-settled", {
      runId: state.id,
      nodeId: attempt.id,
    });
    await setTransport({ status: "idle" });
  }

  async function attachPublic() {
    await runtime.stop();
    registry.close();
    registryOpen = false;
    return resultState((await pi.call("workgraph_adopt", { statePath: store.path })).details);
  }

  return {
    parent,
    root,
    command,
    transportLog,
    pi,
    store,
    repository,
    runtime,
    authorize,
    settle,
    setTransport,
    attachPublic,
    async dispose() {
      await runtime.stop();
      if (registryOpen) registry.close();
      await pi.close();
      restoreFixtureEnvironment(previous);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

async function prepareBlockedComposition(integrated: boolean, dirtyRoot = false) {
  const f = await recoveryFixture();
  const authority = await f.authorize();
  await f.runtime.queue({
    id: "change",
    capability: "implement",
    artifactIntent: "maintained_change",
    objective: "Change value",
    intentVersion: authority.intentVersion,
    authority,
    acceptance: ["The value changes"],
  });
  await f.runtime.reconcile();
  let state = await f.store.load();
  const attempt = required(state.attempts[0], "queued implementation attempt");
  const worktreePath = required(attempt.worktreePath, "isolated implementation worktree");
  await writeFile(join(worktreePath, "value.txt"), "worker\n");
  await git(worktreePath, "add", ".");
  await git(worktreePath, "commit", "-m", "Worker change");
  const workerCommit = await git(worktreePath, "rev-parse", "HEAD");
  let integratedRevision: string | undefined;
  if (integrated) {
    await writeFile(join(f.root, "value.txt"), "integrated\n");
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-m", "Integrated change");
    integratedRevision = await f.repository.head();
  }
  if (dirtyRoot) await writeFile(join(f.root, "transient-root.txt"), "known transient state\n");
  await f.settle({
    kind: "implementation",
    status: "completed",
    outcome: "changed",
    summary: "Worker changed value",
    evidence: [{ label: "commit", observation: workerCommit }],
    findings: [],
    commit: workerCommit,
  });
  state = await f.runtime.reconcile();
  assert.equal(state.attempts[0]?.composition?.state, "blocked");
  if (dirtyRoot) await rm(join(f.root, "transient-root.txt"));
  await f.attachPublic();
  return { f, attempt, workerCommit, integratedRevision };
}

async function prepareFailedProposal(attach = true) {
  const f = await recoveryFixture();
  const authority = await f.authorize();
  await f.runtime.queue({
    id: "failed-change",
    capability: "implement",
    artifactIntent: "maintained_change",
    objective: "Attempt the value change",
    intentVersion: authority.intentVersion,
    authority,
    acceptance: ["Retain exact failed proposal evidence"],
  });
  await f.runtime.reconcile();
  let state = await f.store.load();
  const attempt = required(state.attempts[0], "failed implementation attempt");
  const worktreePath = required(attempt.worktreePath, "failed implementation worktree");
  await writeFile(join(worktreePath, "value.txt"), "partial proposal\n");
  await git(worktreePath, "add", ".");
  await git(worktreePath, "commit", "-m", "Failed partial proposal");
  const workerCommit = await git(worktreePath, "rev-parse", "HEAD");
  const report: WorkerReport = {
    kind: "implementation",
    status: "failed",
    summary: "Implementation failed after producing an inspectable partial proposal",
    evidence: [{ label: "partial", observation: workerCommit }],
    findings: [],
  };
  await f.settle(report);
  state = await f.runtime.reconcile();
  assert.equal(state.results[0]?.validity, "typed");
  assert.deepEqual(state.results[0]?.report, report);
  assert.equal(state.attempts[0]?.composition, undefined);
  assert.equal(state.attempts[0]?.cleanup, undefined);
  if (attach) await f.attachPublic();
  return { f, attempt, workerCommit, report };
}

async function prepareIdentitylessCancelledLaunch() {
  const f = await recoveryFixture();
  const authority = await f.authorize();
  await f.setTransport({ startupFailure: true });
  await f.runtime.queue({
    id: "cancelled-startup",
    capability: "implement",
    artifactIntent: "maintained_change",
    objective: "Start then cancel before submission",
    intentVersion: authority.intentVersion,
    authority,
    acceptance: ["No objective is submitted after cancellation"],
  });
  let state = await f.runtime.reconcile();
  const attempt = required(state.attempts[0], "identity-less startup attempt");
  assert.equal(attempt.state, "starting");
  assert.equal(attempt.submission, "not_sent");
  assert.ok(attempt.launchPane);
  assert.notEqual(attempt.sessionFile, undefined);
  assert.equal(attempt.resource, undefined);
  assert.equal(attempt.worker, undefined);
  await f.runtime.cancel(attempt.id);
  state = await f.store.load();
  assert.equal(state.attempts[0]?.state, "cancel_requested");
  await f.attachPublic();
  return { f, attempt };
}

async function prepareBlockedCleanup(removeBeforeRecovery: boolean) {
  const f = await recoveryFixture();
  const authority = await f.authorize();
  await f.runtime.queue({
    id: "cleanup",
    capability: "implement",
    artifactIntent: "maintained_change",
    authority,
    acceptance: ["The bounded cleanup fixture is retained"],
    objective: "Retain a cleanup fixture",
    intentVersion: authority.intentVersion,
  });
  await f.runtime.reconcile();
  let state = await f.store.load();
  const attempt = required(state.attempts[0], "queued cleanup attempt");
  const placement = required(attempt.placement, "isolated cleanup placement");
  const obstruction = join(placement.path, "transient.tmp");
  await f.settle({
    kind: "implementation",
    status: "failed",
    summary: "Retained cleanup fixture",
    evidence: [{ label: "value", observation: "value.txt contains before\\n" }],
    findings: [],
  });
  await writeFile(obstruction, "known fixture obstruction\n");
  state = await f.runtime.reconcile();
  await f.store.beginCleanup({
    id: attempt.id,
    expectedHead: await f.repository.head(placement.path),
    discard: false,
  });
  await f.store.markWorkerClosed(attempt.id);
  await f.store.blockCleanup(attempt.id, "Known fixture obstruction");
  state = await f.store.load();
  assert.equal(state.attempts[0]?.cleanup?.state, "blocked");
  assert.equal(state.attempts[0]?.cleanup?.workerClosed, true);
  assert.equal(existsSync(obstruction), true);
  await rm(obstruction);
  if (removeBeforeRecovery) {
    if (placement.kind !== "isolated_worktree") {
      throw new Error("cleanup fixture requires an isolated worktree placement");
    }
    await git(f.root, "worktree", "remove", placement.path);
    await git(f.root, "branch", "-D", placement.branch);
  }
  await f.attachPublic();
  return { f, attempt };
}

type RecoveryFixture = Awaited<ReturnType<typeof recoveryFixture>>;
type CompositionFixture = Awaited<ReturnType<typeof prepareBlockedComposition>>;

async function retainNotApplied(
  f: RecoveryFixture,
  attempt: CompositionFixture["attempt"],
  workerCommit: string,
  integratedRevision: string,
  reason: string,
) {
  const state = resultState(
    (
      await f.pi.call("workgraph_control", {
        action: "retain_not_applied",
        attempt: attempt.id,
        integratedRevision,
        reason,
      })
    ).details,
  );
  const composition = required(state.attempts[0]?.composition, "retained-not-applied composition");
  assert.equal(composition.state, "retained_not_applied");
  assert.equal(
    await git(f.root, "rev-parse", required(composition.retainedRef, "retained proposal ref")),
    workerCommit,
  );
  assert.equal(await f.repository.head(), integratedRevision);
  assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "integrated\n");
  assert.equal(state.attempts[0]?.cleanup?.workerClosed, true);
  assert.equal(state.attempts[0]?.cleanup?.state, "completed");
  await f.pi.call("workgraph_inspect", { section: "overview" });
  assert.equal(await f.repository.head(), integratedRevision, "must not reapply");
  return state;
}

void test("registered shared recovery closes an absent worker without touching dirty project files", async () => {
  const f = await recoveryFixture();
  try {
    await f.runtime.queue({
      id: "cleanup-absent",
      capability: "research",
      artifactIntent: "evidence_only",
      objective: "Read value",
      intentVersion: 0,
      expectedEvidence: ["Exact bytes"],
    });
    await f.runtime.reconcile();
    const attempt = required((await f.store.load()).attempts[0], "queued shared-project attempt");
    assert.equal(attempt.placement?.kind, "shared_project");
    const dirty = join(f.root, "local-edit.txt");
    await writeFile(dirty, "must remain untouched\\n");
    await f.settle({
      kind: "research",
      status: "completed",
      summary: "Read exact bytes",
      evidence: [{ label: "value", observation: "value.txt contains before\\n" }],
      findings: [],
    });
    await f.store.beginCleanup({ id: attempt.id, discard: false });
    await f.store.blockCleanup(attempt.id, "Worker closure bookkeeping interrupted");
    await f.setTransport({ closed: true });
    await f.attachPublic();
    const state = resultState(
      (
        await f.pi.call("workgraph_control", {
          action: "recover",
          attempt: attempt.id,
          reason:
            "Exact native worker tab is absent; shared project bytes remain owned by the user",
        })
      ).details,
    );
    assert.equal(state.attempts[0]?.cleanup?.workerClosed, true);
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(await readFile(dirty, "utf8"), "must remain untouched\\n");
    assert.equal(await f.repository.status(), "?? local-edit.txt");
  } finally {
    await f.dispose();
  }
});

void test("registered recover resumes Git cleanup after durable native worker closure", async () => {
  const { f, attempt } = await prepareBlockedCleanup(false);
  try {
    const state = resultState(
      (
        await f.pi.call("workgraph_control", {
          action: "recover",
          attempt: attempt.id,
          reason: "Known fixture obstruction was removed",
        })
      ).details,
    );
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(existsSync(required(attempt.worktreePath, "cleanup worktree path")), false);
    await assert.rejects(git(f.root, "show-ref", "--verify", `refs/heads/${attempt.branch}`));
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "before\n");
  } finally {
    await f.dispose();
  }
});

void test("registered recover accepts an exactly attributed worktree and branch already removed", async () => {
  const { f, attempt } = await prepareBlockedCleanup(true);
  try {
    const state = resultState(
      (
        await f.pi.call("workgraph_control", {
          action: "recover",
          attempt: attempt.id,
          reason: "Exact Git cleanup completed before bookkeeping",
        })
      ).details,
    );
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    const worktreePath = required(attempt.worktreePath, "removed cleanup worktree path");
    assert.equal(existsSync(worktreePath), false);
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(worktreePath),
      false,
    );
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "before\n");
  } finally {
    await f.dispose();
  }
});

void test("registered recover safely retries a transient Git composition failure and durably attributes the retained proposal", async () => {
  const { f, attempt, workerCommit } = await prepareBlockedComposition(false, true);
  try {
    const blockedView = decodeTestValue(
      blockedViewSchema,
      (await f.pi.call("workgraph_inspect", { section: "overview" })).details,
    );
    assert.equal(blockedView.inspection.attention.items.length, 1);
    assert.match(
      required(blockedView.inspection.attention.items[0], "blocked attention item").blocker,
      /Git working tree/,
    );
    const state = resultState(
      (
        await f.pi.call("workgraph_control", {
          action: "recover",
          attempt: attempt.id,
          reason: "Inspected conflicting commit was removed before retry",
        })
      ).details,
    );
    const composition = state.attempts[0]?.composition;
    assert.equal(composition?.state, "composed", JSON.stringify(state));
    const composedRevision = required(composition?.revision, "composed revision");
    assert.equal(
      await git(f.root, "rev-parse", `${composedRevision}^{tree}`),
      await git(f.root, "rev-parse", `${workerCommit}^{tree}`),
      "recovery must compose the exact worker tree, whether Git reuses the commit id or not",
    );
    assert.equal(composition?.retainedRef, `refs/workgraph-retained/${state.id}/${attempt.id}`);
    assert.equal(
      await git(
        f.root,
        "rev-parse",
        required(composition?.retainedRef, "composed retained proposal ref"),
      ),
      workerCommit,
    );
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(await f.repository.head(), composedRevision);
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "worker\n");
    await f.pi.call("workgraph_inspect", { section: "overview" });
    assert.equal(
      await f.repository.head(),
      composedRevision,
      "later reconciliation must not reapply",
    );
  } finally {
    await f.dispose();
  }
});

void test("registered recovery reconciles a proven-absent worker before blocked composition bookkeeping", async () => {
  const { f, attempt, workerCommit } = await prepareBlockedComposition(false, true);
  try {
    await f.setTransport({ closed: true });
    const beforeHead = await f.repository.head();
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "before\n");
    const state = resultState(
      (
        await f.pi.call("workgraph_control", {
          action: "recover",
          attempt: attempt.id,
          reason: "Exact native worker tab is already absent",
        })
      ).details,
    );
    const composition = required(state.attempts[0]?.composition, "recovered composition");
    assert.equal(composition.state, "composed", JSON.stringify(state));
    assert.notEqual(composition.revision, beforeHead);
    assert.equal(
      await git(
        f.root,
        "rev-parse",
        required(composition.retainedRef, "recovered retained proposal ref"),
      ),
      workerCommit,
    );
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "worker\n");
    assert.equal(state.attempts[0]?.cleanup?.workerClosed, true);
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    const recoveredHead = await f.repository.head();
    await f.pi.call("workgraph_inspect", { section: "overview" });
    assert.equal(await f.repository.head(), recoveredHead, "must not reapply");
  } finally {
    await f.dispose();
  }
});

void test("registered absent-worker retain_not_applied preserves integrated HEAD and retained proposal", async () => {
  const { f, attempt, workerCommit, integratedRevision } = await prepareBlockedComposition(true);
  try {
    const integratedHead = required(integratedRevision, "integrated repository revision");
    await f.setTransport({ closed: true });
    await retainNotApplied(
      f,
      attempt,
      workerCommit,
      integratedHead,
      "Integrated change remains authoritative after worker closure",
    );
  } finally {
    await f.dispose();
  }
});

void test("registered retain_not_applied preserves integrated bytes and exact unresolved accounting", async () => {
  const { f, attempt, workerCommit, integratedRevision } = await prepareBlockedComposition(true);
  try {
    const integratedHead = required(integratedRevision, "integrated repository revision");
    const state = await retainNotApplied(
      f,
      attempt,
      workerCommit,
      integratedHead,
      "Integrated commit is authoritative; worker proposal remains retained",
    );
    const composition = state.attempts[0]?.composition;
    assert.equal(
      composition?.reason,
      "Integrated commit is authoritative; worker proposal remains retained",
    );
    assert.equal(composition?.integratedRevision, integratedRevision);
    const againResponse = await f.pi.call("workgraph_inspect", {
      section: "overview",
    });
    const again = resultState(againResponse.details);
    assert.equal(again.attempts[0]?.composition?.state, "retained_not_applied");
    const againView = decodeTestValue(taskViewSchema, againResponse.details);
    assert.equal(againView.inspection.tasks.items[0]?.idPreview, "change");
    assert.equal(await f.repository.head(), integratedRevision);
    const unresolved = [
      {
        task: "change",
        reason: "The conflicting worker proposal was intentionally not applied.",
      },
    ];
    const completed = resultState(
      (
        await f.pi.call("workgraph_complete", {
          conclusion: "Integrated change retained; proposal is unresolved.",
          evidence: [{ label: "HEAD", observation: integratedRevision }],
          limitations: ["Proposal was not applied."],
          unresolved,
        })
      ).details,
    );
    assert.equal(completed.lifecycle.state, "completed");
  } finally {
    await f.dispose();
  }
});

void test("registered retain_not_applied checkpoints a failed proposal and immutable failed report before repeatable cleanup", async () => {
  const { f, attempt, workerCommit, report } = await prepareFailedProposal();
  try {
    const integratedRevision = await f.repository.head();
    const recover = () =>
      f.pi.call("workgraph_control", {
        action: "retain_not_applied",
        attempt: attempt.id,
        integratedRevision,
        reason: "Retain the exact failed partial proposal without applying it",
      });
    let state = resultState((await recover()).details);
    const retained = required(state.attempts[0]?.composition, "retained failed proposal");
    assert.equal(retained.state, "retained_not_applied");
    assert.equal(retained.commit, workerCommit);
    assert.equal(retained.integratedRevision, integratedRevision);
    assert.equal(
      await git(f.root, "rev-parse", required(retained.retainedRef, "failed proposal ref")),
      workerCommit,
    );
    assert.equal(await f.repository.head(), integratedRevision);
    const result = required(state.results[0], "retained failed result");
    assert.equal(result.validity, "typed");
    if (result.validity !== "typed") throw new Error("Expected a typed failed result.");
    assert.deepEqual(result.report, report);
    assert.deepEqual(result.artifacts, [
      {
        id: "failed-proposal",
        kind: "revision",
        reference: workerCommit,
        retention: "retained",
        summary: `Failed implementation proposal retained at ${retained.retainedRef}; it was not applied.`,
      },
    ]);
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(existsSync(required(attempt.worktreePath, "failed proposal worktree")), false);
    await assert.rejects(git(f.root, "show-ref", "--verify", `refs/heads/${attempt.branch}`));

    state = resultState((await recover()).details);
    assert.equal(state.attempts[0]?.composition?.state, "retained_not_applied");
    const repeatedResult = required(state.results[0], "repeated retained failed result");
    if (repeatedResult.validity !== "typed") throw new Error("Expected a typed failed result.");
    assert.deepEqual(repeatedResult.report, report);
    assert.equal(await f.repository.head(), integratedRevision);
  } finally {
    await f.dispose();
  }
});

void test("failed proposal recovery preserves dirty, branch-mismatched, and ref-mismatched resources", async () => {
  for (const mismatch of ["dirty", "branch", "ref"] as const) {
    const { f, attempt, report } = await prepareFailedProposal();
    try {
      const worktreePath = required(attempt.worktreePath, "failed proposal worktree");
      const retainedRef = `refs/workgraph-retained/ws-recovery/${attempt.id}`;
      if (mismatch === "dirty") await writeFile(join(worktreePath, "unattributed.txt"), "dirty\n");
      else if (mismatch === "branch")
        await git(worktreePath, "switch", "-c", "foreign-proposal-branch");
      else
        await git(
          f.root,
          "update-ref",
          retainedRef,
          required(attempt.baseRevision, "failed proposal base"),
        );
      await assert.rejects(
        f.pi.call("workgraph_control", {
          action: "retain_not_applied",
          attempt: attempt.id,
          integratedRevision: await f.repository.head(),
          reason: `Preserve ${mismatch} failed proposal resources`,
        }),
        mismatch === "dirty"
          ? /Git working tree is not clean/
          : mismatch === "branch"
            ? /requires the recorded isolated worktree/
            : /points to a different commit/,
      );
      const state = await f.store.load();
      assert.equal(state.attempts[0]?.composition, undefined);
      assert.equal(state.attempts[0]?.cleanup, undefined);
      const result = required(state.results[0], "preserved failed result");
      if (result.validity !== "typed") throw new Error("Expected a typed failed result.");
      assert.deepEqual(result.report, report);
      assert.equal(existsSync(worktreePath), true);
      if (mismatch === "ref")
        assert.equal(
          await git(f.root, "rev-parse", retainedRef),
          required(attempt.baseRevision, "failed proposal base"),
        );
      else await assert.rejects(git(f.root, "show-ref", "--verify", retainedRef));
    } finally {
      await f.dispose();
    }
  }
});

void test("failed proposal retention resumes after durable ref and state checkpoint windows", async () => {
  for (const window of ["ref", "checkpoint"] as const) {
    const { f, attempt, workerCommit, report } = await prepareFailedProposal(false);
    try {
      const integratedRevision = await f.repository.head();
      const placement = required(attempt.placement, "failed proposal placement");
      if (placement.kind !== "isolated_worktree") throw new Error("Expected isolated placement.");
      const proposal = await f.repository.validateWorkerCommit({
        path: placement.path,
        branch: placement.branch,
        baseCommit: required(attempt.baseRevision, "failed proposal base"),
      });
      assert.equal(proposal.commit, workerCommit);
      const retainedRef = await f.repository.retainCommit("ws-recovery", attempt.id, workerCommit);
      if (window === "checkpoint")
        await Effect.runPromise(
          f.runtime.effects.submit(
            f.store.effects.retainFailedProposalNotApplied({
              id: attempt.id,
              commit: workerCommit,
              expectedHead: integratedRevision,
              reason: "Retain the failed proposal across an interrupted cleanup",
              retainedRef,
              integratedRevision,
            }),
          ),
        );
      await f.attachPublic();
      const state = resultState(
        (
          await f.pi.call("workgraph_control", {
            action: "retain_not_applied",
            attempt: attempt.id,
            integratedRevision,
            reason: "Retain the failed proposal across an interrupted cleanup",
          })
        ).details,
      );
      assert.equal(state.attempts[0]?.composition?.state, "retained_not_applied");
      assert.equal(state.attempts[0]?.cleanup?.state, "completed");
      assert.equal(await git(f.root, "rev-parse", retainedRef), workerCommit);
      const result = required(state.results[0], "recovered checkpoint result");
      if (result.validity !== "typed") throw new Error("Expected a typed failed result.");
      assert.deepEqual(result.report, report);
    } finally {
      await f.dispose();
    }
  }
});

void test("cancelled identity-less unsent launch releases only after authoritative pane absence and repeats safely", async () => {
  const { f, attempt } = await prepareIdentitylessCancelledLaunch();
  try {
    await f.setTransport({ paneGone: true });
    const recover = () =>
      f.pi.call("workgraph_control", {
        action: "recover",
        attempt: attempt.id,
        reason: "The exact retained startup pane is authoritatively absent",
      });
    let state = resultState((await recover()).details);
    assert.equal(state.attempts[0]?.state, "cancelled");
    assert.equal(state.attempts[0]?.submission, "not_sent");
    assert.equal(state.attempts[0]?.worker, undefined);
    assert.equal(state.results[0]?.validity, "absent");
    assert.equal(state.attempts[0]?.cleanup?.workerClosed, true);
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(existsSync(required(attempt.worktreePath, "cancelled startup worktree")), false);

    state = resultState((await recover()).details);
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(state.results.length, 1);
  } finally {
    await f.dispose();
  }
});

void test("cancelled identity-less unsent launch keeps agent-not-found uncertainty and live resources", async () => {
  const { f, attempt } = await prepareIdentitylessCancelledLaunch();
  try {
    const request = () =>
      f.pi.call("workgraph_control", {
        action: "recover",
        attempt: attempt.id,
        reason: "Do not infer process death from native agent lookup alone",
      });
    await f.setTransport({ agentGone: true });
    await assert.rejects(request(), /inspection is unknown/);
    await f.setTransport({ agentGone: false });
    await assert.rejects(request(), /inspection is live/);
    const state = await f.store.load();
    assert.equal(state.attempts[0]?.state, "cancel_requested");
    assert.equal(state.attempts[0]?.worker, undefined);
    assert.equal(state.attempts[0]?.resultId, undefined);
    assert.equal(state.attempts[0]?.cleanup, undefined);
    assert.equal(existsSync(required(attempt.worktreePath, "retained startup worktree")), true);
  } finally {
    await f.dispose();
  }
});

void test("registered recovery rejects live workers and preserves dirty or mismatched resources", async () => {
  const { f, attempt, integratedRevision } = await prepareBlockedComposition(true);
  try {
    const integratedHead = required(integratedRevision, "integrated repository revision");
    await f.setTransport({ status: "working" });
    await assert.rejects(
      f.pi.call("workgraph_control", {
        action: "retain_not_applied",
        attempt: attempt.id,
        integratedRevision: integratedHead,
        reason: "Do not recover a working worker",
      }),
      /inspected worker working/,
    );
    await f.setTransport({
      status: "idle",
      mismatchedCwd: `${attempt.worktreePath}-other`,
    });
    await assert.rejects(
      f.pi.call("workgraph_control", {
        action: "retain_not_applied",
        attempt: attempt.id,
        integratedRevision: integratedHead,
        reason: "Do not recover a mismatched worker",
      }),
      /worker cwd changed/,
    );
    await f.setTransport({
      mismatchedCwd: undefined,
      paneGone: true,
      tabGone: false,
      errorCode: undefined,
    });
    await assert.rejects(
      f.pi.call("workgraph_control", {
        action: "retain_not_applied",
        attempt: attempt.id,
        integratedRevision: integratedHead,
        reason: "A missing pane with a present tab is ambiguous",
      }),
      /pane_not_found/,
    );
    await f.setTransport({
      paneGone: true,
      tabGone: true,
      errorCode: "transport_failure",
    });
    await assert.rejects(
      f.pi.call("workgraph_control", {
        action: "retain_not_applied",
        attempt: attempt.id,
        integratedRevision: integratedHead,
        reason: "An ambiguous transport failure is not absence proof",
      }),
      /transport_failure/,
    );
    await f.setTransport({
      paneGone: false,
      tabGone: false,
      errorCode: undefined,
    });
    const worktreePath = required(attempt.worktreePath, "blocked implementation worktree");
    await writeFile(join(worktreePath, "unattributed.txt"), "dirty\n");
    await assert.rejects(
      f.pi.call("workgraph_control", {
        action: "retain_not_applied",
        attempt: attempt.id,
        integratedRevision: integratedHead,
        reason: "Dirty worktree remains for inspection",
      }),
      /Git working tree is not clean/,
    );
    const state = await f.store.load();
    assert.equal(state.attempts[0]?.composition?.state, "blocked");
    assert.equal(existsSync(join(worktreePath, "unattributed.txt")), true);
  } finally {
    await f.dispose();
  }
});

void test("registered recovery refuses to mutate after its fenced ownership disappears", async () => {
  const { f, attempt } = await prepareBlockedCleanup(false);
  const registry = new WorkgraphRegistry(join(f.parent, "agent", "workgraph", "registry.sqlite"));
  try {
    registry.db.prepare("DELETE FROM leases WHERE run_id=?").run("ws-recovery");
    await assert.rejects(
      f.pi.call("workgraph_control", {
        action: "recover",
        attempt: attempt.id,
        reason: "Absent ownership must not mutate retained resources",
      }),
      /no lease|live lease|owner/i,
    );
    const state = await f.store.load();
    assert.equal(state.attempts[0]?.cleanup?.state, "blocked");
    assert.equal(existsSync(required(attempt.worktreePath, "blocked cleanup worktree")), true);
  } finally {
    registry.close();
    await f.dispose();
  }
});

void test("registered result and status views retain first presentation and bounded attention history", async () => {
  const f = await recoveryFixture();
  try {
    await f.store.assign({
      id: "view",
      capability: "research",
      artifactIntent: "evidence_only",
      objective: "View evidence",
      intentVersion: 0,
      expectedEvidence: ["bytes"],
    });
    await f.store.retainResult({
      id: "view-result",
      assignmentId: "view",
      assignmentIntentVersion: 0,
      validity: "typed",
      report: {
        kind: "research",
        status: "completed",
        summary: "View",
        evidence: Array.from({ length: 3 }, (_, index) => ({
          label: `e${index}`,
          observation: `o${index}`,
        })),
        findings: [],
      },
    });
    await f.store.requestDelivery("view-result");
    await f.store.deliveryAttempt("view-result", "wake-1", "wake failed once");
    await f.store.deliveryAttempt("view-result", "wake-2", "wake failed twice");
    await f.attachPublic();
    await f.pi.call("workgraph_inspect", {
      result: "view-result",
      section: "report",
      maxChars: 1_000,
    });
    const first = required(
      resultState((await f.pi.call("workgraph_inspect", { section: "overview" })).details)
        .deliveries[0],
      "first delivery projection",
    );
    assert.equal(first.deliveredAt, undefined);
    await f.pi.call("workgraph_inspect", {
      result: "view-result",
      section: "report",
      maxChars: 1_000,
    });
    const second = required(
      resultState((await f.pi.call("workgraph_inspect", { section: "overview" })).details)
        .deliveries[0],
      "second delivery projection",
    );
    assert.equal(second.deliveredAt, first.deliveredAt);
    assert.equal(second.failureHistory?.length, 2);
    const status = await f.pi.call("workgraph_inspect", {
      section: "outcome",
      result: "view-result",
    });
    const view = decodeTestValue(outcomeViewSchema, status.details).inspection;
    assert.equal(view.result, "outcome-1");
  } finally {
    await f.dispose();
  }
});
