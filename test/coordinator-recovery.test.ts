import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { GitRepository } from "../src/git.js";
import { HerdrCliRuntime } from "../src/herdr.js";
import { DEFAULT_MODEL_POLICY } from "../src/model-policy.js";
import { WorkgraphRegistry } from "../src/registry.js";
import type { WorkerReport } from "../src/types.js";
import { WorkstreamStore } from "../src/workstream.js";
import { WorkstreamRuntime } from "../src/workstream-runtime.js";
import { extensionFixture, git, resultState, usage } from "./helpers.js";

const workspaceId = "recovery-workspace";

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
  await writeFile(
    transportState,
    JSON.stringify({ status: "working", closed: false }),
  );
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
  console.log(JSON.stringify({result:{agent:{workspace_id:"recovery-workspace",tab_id:"recovery-workspace:tab-1",pane_id:"recovery-workspace:pane-1",terminal_id:"terminal-1",agent_status:state.status,name:state.name,cwd:state.cwd,agent_session:{value:state.sessionFile}}}}));
} else if (args[0] === "agent" && args[1] === "get") {
  if (state.closed || state.paneGone) fail(state.errorCode || "pane_not_found");
  console.log(JSON.stringify({result:{agent:{workspace_id:"recovery-workspace",tab_id:"recovery-workspace:tab-1",pane_id:"recovery-workspace:pane-1",terminal_id:"terminal-1",agent_status:state.status,name:state.name,cwd:state.mismatchedCwd || state.cwd,agent_session:{value:state.sessionFile}}}}));
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

  const previous = { ...process.env };
  process.env.PI_CODING_AGENT_DIR = join(parent, "agent");
  process.env.PI_WORKGRAPH_HERDR_BIN = command;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_WORKSPACE_ID = workspaceId;
  delete process.env.PI_WORKGRAPH_MODE;
  const pi = await extensionFixture("coordinator", root, parent);
  const repository = await GitRepository.open(root);
  const owner = {
    sessionId: pi.session.getSessionId(),
    sessionFile: pi.session.getSessionFile()!,
  };
  const { store } = await WorkstreamStore.create({
    id: "ws-recovery",
    purpose: "Exercise registered recovery",
    projectRoot: root,
    gitCommonDir: repository.commonDir,
    coordinator: owner,
  });
  const registry = new WorkgraphRegistry(
    join(parent, "runtime-registry.sqlite"),
  );
  let registryOpen = true;
  const runtime = new WorkstreamRuntime(
    store,
    repository,
    new HerdrCliRuntime(command, {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: workspaceId,
    }),
    { workspaceId },
    () => {},
    () => {},
    { registry, policy: DEFAULT_MODEL_POLICY },
  );
  await runtime.perform(async () => undefined);

  async function setTransport(change: Record<string, unknown>) {
    const current = JSON.parse(
      await readFile(transportState, "utf8"),
    ) as Record<string, unknown>;
    await writeFile(transportState, JSON.stringify({ ...current, ...change }));
  }

  async function authorize() {
    return runtime.perform(async () => {
      const recorded = await store.recordInputEvent({
        ...owner,
        source: "interactive",
        text: "Implement and recover the disposable fixture change.",
      });
      await store.reviseIntent({
        authorityReceiptId: recorded.receipt.id,
        statement: "Implement the fixture change",
        constraints: [],
      });
      return { receiptId: recorded.receipt.id, intentVersion: 1 };
    });
  }

  async function settle(report: WorkerReport) {
    const state = await store.load();
    const attempt = state.attempts.at(-1)!;
    const session = SessionManager.open(attempt.sessionFile!);
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
      timestamp: Date.now(),
    });
    session.appendMessage({
      role: "toolResult",
      toolCallId: "report",
      toolName: "workgraph_report",
      content: [{ type: "text", text: "report" }],
      details: { report },
      isError: false,
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
    return resultState(
      (await pi.call("workgraph_adopt", { statePath: store.path })).details,
    );
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
      for (const key of Object.keys(process.env))
        if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

async function prepareBlockedComposition(
  integrated: boolean,
  dirtyRoot = false,
) {
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
  const attempt = state.attempts[0]!;
  await writeFile(join(attempt.worktreePath!, "value.txt"), "worker\n");
  await git(attempt.worktreePath!, "add", ".");
  await git(attempt.worktreePath!, "commit", "-m", "Worker change");
  const workerCommit = await git(attempt.worktreePath!, "rev-parse", "HEAD");
  let integratedRevision: string | undefined;
  if (integrated) {
    await writeFile(join(f.root, "value.txt"), "integrated\n");
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-m", "Integrated change");
    integratedRevision = await f.repository.head();
  }
  if (dirtyRoot)
    await writeFile(
      join(f.root, "transient-root.txt"),
      "known transient state\n",
    );
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
  const attempt = state.attempts[0]!;
  const obstruction = join(attempt.placement!.path, "transient.tmp");
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
    expectedHead: await f.repository.head(attempt.placement!.path),
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
    assert.equal(attempt.placement?.kind, "isolated_worktree");
    await git(f.root, "worktree", "remove", attempt.placement.path);
    await git(f.root, "branch", "-D", attempt.placement.branch);
  }
  await f.attachPublic();
  return { f, attempt };
}

test("registered shared recovery closes an absent worker without touching dirty project files", async () => {
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
    const attempt = (await f.store.load()).attempts[0]!;
    assert.equal(attempt.placement?.kind, "shared_project");
    const dirty = join(f.root, "local-edit.txt");
    await writeFile(dirty, "must remain untouched\\n");
    await f.settle({
      kind: "research",
      status: "completed",
      summary: "Read exact bytes",
      evidence: [
        { label: "value", observation: "value.txt contains before\\n" },
      ],
      findings: [],
    });
    await f.store.beginCleanup({ id: attempt.id, discard: false });
    await f.store.blockCleanup(
      attempt.id,
      "Worker closure bookkeeping interrupted",
    );
    await f.setTransport({ closed: true });
    await f.attachPublic();
    const state = resultState(
      (
        await f.pi.call("workgraph_control", {
          action: "recover",
          attemptId: attempt.id,
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

test("registered recover resumes Git cleanup after durable native worker closure", async () => {
  const { f, attempt } = await prepareBlockedCleanup(false);
  try {
    const state = resultState(
      (
        await f.pi.call("workgraph_control", {
          action: "recover",
          attemptId: attempt.id,
          reason: "Known fixture obstruction was removed",
        })
      ).details,
    );
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(existsSync(attempt.worktreePath!), false);
    await assert.rejects(
      git(f.root, "show-ref", "--verify", `refs/heads/${attempt.branch}`),
    );
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "before\n");
  } finally {
    await f.dispose();
  }
});

test("registered recover accepts an exactly attributed worktree and branch already removed", async () => {
  const { f, attempt } = await prepareBlockedCleanup(true);
  try {
    const state = resultState(
      (
        await f.pi.call("workgraph_control", {
          action: "recover",
          attemptId: attempt.id,
          reason: "Exact Git cleanup completed before bookkeeping",
        })
      ).details,
    );
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(existsSync(attempt.worktreePath!), false);
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(
        attempt.worktreePath!,
      ),
      false,
    );
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "before\n");
  } finally {
    await f.dispose();
  }
});

test("registered recover safely retries a transient Git composition failure and durably attributes the retained proposal", async () => {
  const { f, attempt, workerCommit } = await prepareBlockedComposition(
    false,
    true,
  );
  try {
    const blockedView = (await f.pi.call("workgraph_status", {})).details as {
      view: { attention: { items: Array<{ detail: string }> } };
    };
    assert.equal(blockedView.view.attention.items.length, 1);
    assert.match(
      blockedView.view.attention.items[0]!.detail,
      /Git working tree/,
    );
    const state = resultState(
      (
        await f.pi.call("workgraph_control", {
          action: "recover",
          attemptId: attempt.id,
          reason: "Inspected conflicting commit was removed before retry",
        })
      ).details,
    );
    const composition = state.attempts[0]?.composition;
    assert.equal(composition?.state, "composed", JSON.stringify(state));
    assert.ok(composition?.revision);
    assert.equal(
      await git(f.root, "rev-parse", `${composition.revision}^{tree}`),
      await git(f.root, "rev-parse", `${workerCommit}^{tree}`),
      "recovery must compose the exact worker tree, whether Git reuses the commit id or not",
    );
    assert.equal(
      composition?.retainedRef,
      `refs/workgraph-retained/${state.id}/${attempt.id}`,
    );
    assert.equal(
      await git(f.root, "rev-parse", composition!.retainedRef!),
      workerCommit,
    );
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(await f.repository.head(), composition.revision);
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "worker\n");
    await f.pi.call("workgraph_status", {});
    assert.equal(
      await f.repository.head(),
      composition.revision,
      "later reconciliation must not reapply",
    );
  } finally {
    await f.dispose();
  }
});

test("registered recovery reconciles a proven-absent worker before blocked composition bookkeeping", async () => {
  const { f, attempt, workerCommit } = await prepareBlockedComposition(
    false,
    true,
  );
  try {
    await f.setTransport({ closed: true });
    const beforeHead = await f.repository.head();
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "before\n");
    const state = resultState(
      (
        await f.pi.call("workgraph_control", {
          action: "recover",
          attemptId: attempt.id,
          reason: "Exact native worker tab is already absent",
        })
      ).details,
    );
    const composition = state.attempts[0]?.composition;
    assert.equal(composition?.state, "composed", JSON.stringify(state));
    assert.notEqual(composition.revision, beforeHead);
    assert.equal(
      await git(f.root, "rev-parse", composition!.retainedRef!),
      workerCommit,
    );
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "worker\n");
    assert.equal(state.attempts[0]?.cleanup?.workerClosed, true);
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    const recoveredHead = await f.repository.head();
    await f.pi.call("workgraph_status", {});
    assert.equal(await f.repository.head(), recoveredHead, "must not reapply");
  } finally {
    await f.dispose();
  }
});

test("registered absent-worker retain_not_applied preserves integrated HEAD and retained proposal", async () => {
  const { f, attempt, workerCommit, integratedRevision } =
    await prepareBlockedComposition(true);
  try {
    assert.ok(integratedRevision);
    await f.setTransport({ closed: true });
    const state = resultState(
      (
        await f.pi.call("workgraph_control", {
          action: "retain_not_applied",
          attemptId: attempt.id,
          integratedRevision,
          reason:
            "Integrated change remains authoritative after worker closure",
        })
      ).details,
    );
    assert.equal(state.attempts[0]?.composition?.state, "retained_not_applied");
    assert.equal(
      await git(
        f.root,
        "rev-parse",
        state.attempts[0]!.composition!.retainedRef!,
      ),
      workerCommit,
    );
    assert.equal(await f.repository.head(), integratedRevision);
    assert.equal(
      await readFile(join(f.root, "value.txt"), "utf8"),
      "integrated\n",
    );
    assert.equal(state.attempts[0]?.cleanup?.workerClosed, true);
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    await f.pi.call("workgraph_status", {});
    assert.equal(
      await f.repository.head(),
      integratedRevision,
      "must not reapply",
    );
  } finally {
    await f.dispose();
  }
});

test("registered retain_not_applied preserves integrated bytes and exact unresolved accounting", async () => {
  const { f, attempt, workerCommit, integratedRevision } =
    await prepareBlockedComposition(true);
  try {
    assert.ok(integratedRevision);
    const state = resultState(
      (
        await f.pi.call("workgraph_control", {
          action: "retain_not_applied",
          attemptId: attempt.id,
          integratedRevision,
          reason:
            "Integrated commit is authoritative; worker proposal remains retained",
        })
      ).details,
    );
    const composition = state.attempts[0]?.composition;
    assert.equal(composition?.state, "retained_not_applied");
    assert.equal(
      composition?.reason,
      "Integrated commit is authoritative; worker proposal remains retained",
    );
    assert.equal(composition?.integratedRevision, integratedRevision);
    assert.equal(
      await git(f.root, "rev-parse", composition!.retainedRef!),
      workerCommit,
    );
    assert.equal(await f.repository.head(), integratedRevision);
    assert.equal(
      await readFile(join(f.root, "value.txt"), "utf8"),
      "integrated\n",
    );
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    const againResponse = await f.pi.call("workgraph_status", {});
    const again = resultState(againResponse.details);
    assert.equal(again.attempts[0]?.composition?.state, "retained_not_applied");
    const againView = againResponse.details as {
      view: {
        results: {
          items: Array<{
            retainedNotApplied?: Array<{ reason?: string }>;
          }>;
        };
      };
    };
    assert.equal(
      againView.view.results.items[0]?.retainedNotApplied?.[0]?.reason,
      "Integrated commit is authoritative; worker proposal remains retained",
    );
    assert.equal(await f.repository.head(), integratedRevision);
    const accounting = [
      {
        kind: "unresolved_assignment" as const,
        assignmentId: "change",
        reason:
          "The conflicting worker proposal was intentionally not applied.",
      },
      {
        kind: "unresolved_attempt" as const,
        attemptId: attempt.id,
        reason: "The worker proposal was retained instead of composed.",
      },
    ];
    const completed = resultState(
      (
        await f.pi.call("workgraph_complete", {
          conclusion: "Integrated change retained; proposal is unresolved.",
          evidence: [{ label: "HEAD", observation: integratedRevision }],
          limitations: ["Proposal was not applied."],
          accounting,
        })
      ).details,
    );
    assert.equal(completed.lifecycle.state, "completed");
  } finally {
    await f.dispose();
  }
});

test("registered recovery rejects live workers and preserves dirty or mismatched resources", async () => {
  const { f, attempt, integratedRevision } =
    await prepareBlockedComposition(true);
  try {
    assert.ok(integratedRevision);
    await f.setTransport({ status: "working" });
    await assert.rejects(
      f.pi.call("workgraph_control", {
        action: "retain_not_applied",
        attemptId: attempt.id,
        integratedRevision,
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
        attemptId: attempt.id,
        integratedRevision,
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
        attemptId: attempt.id,
        integratedRevision,
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
        attemptId: attempt.id,
        integratedRevision,
        reason: "An ambiguous transport failure is not absence proof",
      }),
      /transport_failure/,
    );
    await f.setTransport({
      paneGone: false,
      tabGone: false,
      errorCode: undefined,
    });
    await writeFile(join(attempt.worktreePath!, "unattributed.txt"), "dirty\n");
    await assert.rejects(
      f.pi.call("workgraph_control", {
        action: "retain_not_applied",
        attemptId: attempt.id,
        integratedRevision,
        reason: "Dirty worktree remains for inspection",
      }),
      /Git working tree is not clean/,
    );
    const state = await f.store.load();
    assert.equal(state.attempts[0]?.composition?.state, "blocked");
    assert.equal(
      existsSync(join(attempt.worktreePath!, "unattributed.txt")),
      true,
    );
  } finally {
    await f.dispose();
  }
});

test("registered recovery refuses to mutate after its fenced ownership disappears", async () => {
  const { f, attempt } = await prepareBlockedCleanup(false);
  const registry = new WorkgraphRegistry(
    join(f.parent, "agent", "workgraph", "registry.sqlite"),
  );
  try {
    registry.db.prepare("DELETE FROM leases WHERE run_id=?").run("ws-recovery");
    await assert.rejects(
      f.pi.call("workgraph_control", {
        action: "recover",
        attemptId: attempt.id,
        reason: "Absent ownership must not mutate retained resources",
      }),
      /no lease|live lease|owner/i,
    );
    const state = await f.store.load();
    assert.equal(state.attempts[0]?.cleanup?.state, "blocked");
    assert.equal(existsSync(attempt.worktreePath!), true);
  } finally {
    registry.close();
    await f.dispose();
  }
});

test("registered result and status views retain first presentation and bounded attention history", async () => {
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
    await f.pi.call("workgraph_result", {
      resultId: "view-result",
      section: "evidence",
      limit: 1,
    });
    const first = resultState((await f.pi.call("workgraph_status", {})).details)
      .deliveries[0]!;
    assert.ok(first.deliveredAt);
    await f.pi.call("workgraph_result", {
      resultId: "view-result",
      section: "evidence",
      limit: 1,
    });
    const second = resultState(
      (await f.pi.call("workgraph_status", {})).details,
    ).deliveries[0]!;
    assert.equal(second.deliveredAt, first.deliveredAt);
    assert.equal(second.failureHistory?.length, 2);
    const status = await f.pi.call("workgraph_status", { offset: 0, limit: 1 });
    const view = (
      status.details as {
        view: {
          results: { items: unknown[]; total: number; remaining: number };
        };
      }
    ).view;
    assert.equal(view.results.items.length, 1);
    assert.equal(view.results.total, 1);
    assert.equal(view.results.remaining, 0);
  } finally {
    await f.dispose();
  }
});
