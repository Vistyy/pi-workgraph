import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkgraphEngine } from "../src/engine.js";
import { GitRepository, runProcess } from "../src/git.js";
import { HerdrCliRuntime, herdrAgentName, type HerdrAgentStatus, type HerdrObservation, type VisibleWorkerRuntime, type WorkerLaunchRequest, type WorkerRecoveryRequest } from "../src/herdr.js";
import { WorkgraphRegistry } from "../src/registry.js";
import { transitionNode } from "../src/scheduler.js";
import { persistSchedule, WorkgraphSupervisor } from "../src/supervisor.js";
import type { WorkerIdentity } from "../src/types.js";
import { commandAgreement, nodeSpec, testOutcome } from "./helpers.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess("git", ["-C", cwd, ...args], { cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-control-"));
  const root = join(parent, "repo");
  await runProcess("mkdir", ["-p", root], { cwd: parent, timeoutMs: 5_000 });
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "workgraph@example.test");
  await git(root, "config", "user.name", "Workgraph Control");
  await writeFile(join(root, "value.txt"), "value\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  const repository = await GitRepository.open(root);
  const registry = new WorkgraphRegistry(join(parent, "registry.sqlite"));
  const begun = await WorkgraphEngine.begin({
    request: "Exercise asynchronous control.",
    projectRoot: root,
    gitCommonDir: repository.commonDir,
    parentSessionId: "coordinator",
    parentSessionFile: join(parent, "coordinator.jsonl"),
    baseCommit: await repository.head(),
    outcome: testOutcome.outcome,
  }, { repository, registry });
  const { approvedAt: _approvedAt, ...agreement } = commandAgreement;
  await begun.engine.proposePlan(agreement, "Initial plan.", "initial");
  await begun.engine.recordPlanDecision(1, true, "approved");
  return { parent, root, repository, registry, engine: begun.engine };
}

class FakeRuntime implements VisibleWorkerRuntime {
  readonly available = true;
  launches: WorkerLaunchRequest[] = [];
  observations: WorkerIdentity[] = [];
  recoveries: WorkerRecoveryRequest[] = [];
  interrupts: WorkerIdentity[] = [];
  recovered?: WorkerIdentity;
  observeStatus: HerdrAgentStatus = "working";
  interruptStatus: HerdrAgentStatus = "idle";

  async launch(request: WorkerLaunchRequest): Promise<HerdrObservation> {
    this.launches.push(request);
    throw new Error("Unexpected launch in control reconciliation test.");
  }

  async recover(request: WorkerRecoveryRequest): Promise<HerdrObservation | undefined> {
    this.recoveries.push(structuredClone(request));
    return this.recovered ? { identity: structuredClone(this.recovered), status: "working", stage: "executing", observedAt: new Date().toISOString() } : undefined;
  }

  async observe(identity: WorkerIdentity): Promise<HerdrObservation> {
    this.observations.push(structuredClone(identity));
    return observation(identity, this.observeStatus);
  }

  async interrupt(identity: WorkerIdentity): Promise<HerdrObservation> {
    this.interrupts.push(structuredClone(identity));
    return observation(identity, this.interruptStatus);
  }
}

function observation(identity: WorkerIdentity, status: HerdrAgentStatus): HerdrObservation {
  return {
    identity: structuredClone(identity),
    status,
    stage: status === "working" ? "executing" : status === "blocked" || status === "unknown" ? "attention" : "reporting",
    observedAt: new Date().toISOString(),
  };
}

test("scheduling persists and returns before any worker settlement", async () => {
  const value = await fixture();
  try {
    let kicked = false;
    let settled = false;
    const run = await persistSchedule(value.engine, { nodes: [nodeSpec("async", ["value.txt"])], maxConcurrency: 1 }, {
      kick() {
        kicked = true;
        void new Promise<void>(() => {}).then(() => { settled = true; });
      },
    });
    assert.equal(kicked, true);
    assert.equal(settled, false);
    assert.equal(run.control.executionStatus, "scheduled");
    assert.equal(run.nodes[0]?.state, "pending");
    assert.equal(run.nodes[0]?.planVersion, 1);
    assert.deepEqual(run.attempts, []);
  } finally {
    value.registry.close();
    await rm(value.parent, { recursive: true, force: true });
  }
});

test("worker identity, pause, cancellation, and repeated reconciliation are durable and independent of turn abort", async () => {
  const value = await fixture();
  const runtime = new FakeRuntime();
  const identity: WorkerIdentity = {
    workspaceId: "workspace-1",
    tabId: "workspace-1:tab-2",
    paneId: "workspace-1:pane-3",
    terminalId: "terminal-4",
    agentName: "wg-run-node-attempt",
    sessionFile: join(value.parent, "worker.jsonl"),
    cwd: join(value.parent, "worktree"),
  };
  runtime.recovered = identity;
  try {
    await value.engine.schedule({ nodes: [nodeSpec("controlled", ["value.txt"])], maxConcurrency: 1 });
    await value.engine.store.update((run) => {
      const node = run.nodes[0]!;
      transitionNode(node, "running");
      node.activeAttemptId = "attempt-1";
      node.sessionFile = identity.sessionFile;
      run.attempts.push({
        id: "attempt-1",
        nodeId: node.id,
        planVersion: 1,
        state: "running",
        stage: "executing",
        runtimeMode: "herdr",
        createdAt: new Date(0).toISOString(),
        startedAt: new Date(0).toISOString(),
        lastActivityAt: new Date(0).toISOString(),
        heartbeatAt: new Date(0).toISOString(),
        sessionFile: identity.sessionFile,
        worktreePath: identity.cwd,
        agentName: identity.agentName,
      });
      run.control.executionStatus = "running";
    });
    const supervisor = new WorkgraphSupervisor(value.engine, runtime, { workspaceId: identity.workspaceId });
    const unrelatedTurn = new AbortController();
    unrelatedTurn.abort();
    let run = await supervisor.reconcileNow();
    assert.equal(runtime.interrupts.length, 0);
    assert.equal(runtime.recoveries.length, 1);
    assert.deepEqual(runtime.recoveries[0], { workspaceId: identity.workspaceId, agentName: identity.agentName, sessionFile: identity.sessionFile, cwd: identity.cwd });
    assert.deepEqual(run.attempts[0]?.worker, identity);
    assert.equal(run.attempts[0]?.stage, "executing");
    assert.ok(run.attempts[0]?.heartbeatAt);

    run = await value.engine.controlExecution({ action: "pause", mode: "drain", reason: "Pause after active workers." });
    assert.equal(run.control.executionStatus, "draining");
    await supervisor.reconcileNow();
    assert.equal(runtime.interrupts.length, 0);

    runtime.interruptStatus = "working";
    run = await value.engine.controlExecution({ action: "pause", mode: "immediate", reason: "Stop the exact worker." });
    assert.equal(run.attempts[0]?.state, "cancel_requested");
    run = await supervisor.reconcileNow();
    assert.deepEqual(runtime.interrupts, [identity]);
    assert.equal(run.attempts[0]?.state, "cancel_requested");
    assert.ok(run.attempts[0]?.interruptRequestedAt);
    assert.equal(run.attempts[0]?.observedStatus, "working");
    assert.equal(run.nodes[0]?.state, "running");

    runtime.observeStatus = "blocked";
    run = await supervisor.reconcileNow();
    assert.equal(run.attempts[0]?.state, "cancel_requested");
    assert.match(run.attempts[0]?.attention ?? "", /blocked/);
    assert.equal(runtime.interrupts.length, 1);

    runtime.observeStatus = "unknown";
    run = await supervisor.reconcileNow();
    assert.equal(run.attempts[0]?.state, "cancel_requested");
    assert.match(run.attempts[0]?.attention ?? "", /unknown/);
    assert.equal(runtime.interrupts.length, 1);

    runtime.observeStatus = "idle";
    run = await supervisor.reconcileNow();
    assert.equal(run.attempts[0]?.state, "cancelled");
    assert.equal(run.nodes[0]?.state, "cancelled");
    assert.equal(run.control.attentionStatus, "clear");
    const attemptCount = run.attempts.length;
    await supervisor.reconcileNow();
    supervisor.stop();
    assert.equal(runtime.interrupts.length, 1);
    assert.equal((await value.engine.load()).attempts.length, attemptCount);
  } finally {
    value.registry.close();
    await rm(value.parent, { recursive: true, force: true });
  }
});

test("stale composition reconciliation is exact and idempotent", async () => {
  const value = await fixture();
  const runtime = new FakeRuntime();
  try {
    let run = await value.engine.schedule({ nodes: [nodeSpec("stale", ["value.txt"])], maxConcurrency: 1 });
    const placement = await value.repository.createWorktree(run.runId, "stale", run.composedCommit);
    await writeFile(join(placement.path, "value.txt"), "changed\n");
    await git(placement.path, "add", "value.txt");
    await git(placement.path, "commit", "-m", "stale candidate");
    const commit = await git(placement.path, "rev-parse", "HEAD");
    const identity: WorkerIdentity = {
      workspaceId: "workspace-1",
      tabId: "workspace-1:tab-stale",
      paneId: "workspace-1:pane-stale",
      terminalId: "terminal-stale",
      agentName: "wg-stale",
      sessionFile: join(value.parent, "stale.jsonl"),
      cwd: placement.path,
    };
    await value.engine.store.update((draft) => {
      const node = draft.nodes[0]!;
      transitionNode(node, "running");
      transitionNode(node, "completed");
      node.activeAttemptId = "attempt-stale";
      node.baseCommit = placement.baseCommit;
      node.branch = placement.branch;
      node.worktreePath = placement.path;
      node.sessionFile = identity.sessionFile;
      node.commit = commit;
      draft.attempts.push({
        id: "attempt-stale",
        nodeId: node.id,
        planVersion: 1,
        state: "settling",
        stage: "composing",
        runtimeMode: "herdr",
        createdAt: new Date(0).toISOString(),
        startedAt: new Date(0).toISOString(),
        lastActivityAt: new Date(0).toISOString(),
        baseCommit: placement.baseCommit,
        branch: placement.branch,
        worktreePath: placement.path,
        sessionFile: identity.sessionFile,
        agentName: identity.agentName,
        worker: identity,
      });
      draft.control.executionStatus = "running";
    });
    const unrecordedHead = await value.repository.compose(commit, run.composedCommit);
    const supervisor = new WorkgraphSupervisor(value.engine, runtime, { workspaceId: identity.workspaceId });
    run = await supervisor.reconcileNow();
    assert.equal(run.nodes[0]?.state, "composed");
    assert.equal(run.attempts[0]?.state, "completed");
    assert.equal(run.composedCommit, unrecordedHead);
    assert.equal(run.composition.length, 1);
    run = await supervisor.reconcileNow();
    assert.equal(run.composition.length, 1);
    assert.equal(run.composedCommit, unrecordedHead);
  } finally {
    value.registry.close();
    await rm(value.parent, { recursive: true, force: true });
  }
});

test("an internal replan remains available after legacy revision_required attention", async () => {
  const value = await fixture();
  try {
    await value.engine.store.update((run) => {
      run.phase = "revision_required";
      run.control.attentionStatus = "failed";
    });
    const { approvedAt: _approvedAt, ...agreement } = commandAgreement;
    const run = await value.engine.proposePlan({ ...agreement, structure: "A repaired internal DAG." }, "Repair the failed node.", "internal");
    assert.equal(run.phase, "revision_required");
    assert.equal(run.control.planStatus, "approved");
    assert.equal(run.control.currentPlanVersion, 2);
    assert.equal(run.control.attentionStatus, "clear");
    assert.equal(run.plans[0]?.status, "superseded");
    assert.equal(run.plans[1]?.status, "approved");
  } finally {
    value.registry.close();
    await rm(value.parent, { recursive: true, force: true });
  }
});

test("Herdr agent names satisfy the authoritative boundary and distinguish attempts", () => {
  const first = herdrAgentName("RUN/with spaces and symbols", "123-VERY-LONG-NODE-NAME-with_symbols", "attempt-one");
  const second = herdrAgentName("RUN/with spaces and symbols", "123-VERY-LONG-NODE-NAME-with_symbols", "attempt-two");
  assert.match(first, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.match(second, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.notEqual(first, second);
});

test("Herdr identity validation rejects missing and mismatched native session or cwd", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-herdr-identity-"));
  const responsePath = join(parent, "agent.json");
  const command = join(parent, "fake-herdr-identity.mjs");
  const identity: WorkerIdentity = {
    workspaceId: "workspace-1",
    tabId: "workspace-1:tab-1",
    paneId: "workspace-1:pane-1",
    terminalId: "terminal-1",
    agentName: herdrAgentName("run", "node", "attempt"),
    sessionFile: join(parent, "worker.jsonl"),
    cwd: join(parent, "worktree"),
  };
  const valid = {
    workspace_id: identity.workspaceId,
    tab_id: identity.tabId,
    pane_id: identity.paneId,
    terminal_id: identity.terminalId,
    agent_status: "working",
    name: identity.agentName,
    cwd: identity.cwd,
    agent_session: { value: identity.sessionFile },
  };
  await writeFile(command, `#!/usr/bin/env node\nimport { readFileSync } from "node:fs";\nconst agent = JSON.parse(readFileSync(${JSON.stringify(responsePath)}, "utf8"));\nconsole.log(JSON.stringify({result:{agent}}));\n`);
  await chmod(command, 0o755);
  const runtime = new HerdrCliRuntime(command, { HERDR_ENV: "1", HERDR_WORKSPACE_ID: identity.workspaceId });
  try {
    const missingSession = structuredClone(valid) as Partial<typeof valid>;
    delete missingSession.agent_session;
    await writeFile(responsePath, JSON.stringify(missingSession));
    await assert.rejects(() => runtime.observe(identity), /agent_session/);

    const missingCwd = structuredClone(valid) as Partial<typeof valid>;
    delete missingCwd.cwd;
    await writeFile(responsePath, JSON.stringify(missingCwd));
    await assert.rejects(() => runtime.observe(identity), /cwd/);

    await writeFile(responsePath, JSON.stringify({ ...valid, agent_session: { value: join(parent, "other.jsonl") } }));
    await assert.rejects(() => runtime.observe(identity), /native Pi session changed/);

    await writeFile(responsePath, JSON.stringify({ ...valid, cwd: join(parent, "other-worktree") }));
    await assert.rejects(() => runtime.observe(identity), /worker cwd changed/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the Herdr adapter launches without waiting and validates exact identity before interrupt", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-herdr-"));
  const log = join(parent, "commands.jsonl");
  const command = join(parent, "fake-herdr.mjs");
  const cwd = join(parent, "worktree");
  const sessionFile = join(parent, "worker.jsonl");
  const agentName = herdrAgentName("run", "node", "attempt");
  const agent = {
    workspace_id: "workspace-1",
    tab_id: "workspace-1:tab-1",
    pane_id: "workspace-1:pane-1",
    terminal_id: "terminal-1",
    agent_status: "working",
    name: agentName,
    cwd,
    agent_session: { value: sessionFile },
  };
  await writeFile(command, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");\nif (args[0] === "tab") console.log(JSON.stringify({result:{root_pane:{pane_id:"workspace-1:pane-1"}}}));\nelse if (args[0] === "api") console.log(JSON.stringify({result:{snapshot:{agents:[${JSON.stringify(agent)}]}}}));\nelse if (args[0] === "agent" && args[1] === "start") console.log(JSON.stringify({result:{agent:${JSON.stringify(agent)}}}));\nelse if (args[0] === "agent" && args[1] === "get") console.log(JSON.stringify({result:{agent:${JSON.stringify(agent)}}}));\nelse console.log(JSON.stringify({result:{accepted:true}}));\n`);
  await chmod(command, 0o755);
  try {
    const runtime = new HerdrCliRuntime(command, { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1" });
    let retained: WorkerIdentity | undefined;
    const observation = await runtime.launch({
      workspaceId: "workspace-1",
      runId: "run",
      nodeId: "node",
      attemptId: "attempt",
      cwd,
      sessionFile,
      prompt: "Continue now.",
      env: { PI_WORKGRAPH_MODE: "implementation" },
      onIdentity(identity) { retained = identity; },
    });
    assert.deepEqual(retained, observation.identity);
    assert.equal(observation.identity.workspaceId, "workspace-1");
    assert.equal(observation.identity.paneId, "workspace-1:pane-1");
    assert.equal(observation.identity.sessionFile, sessionFile);
    const recovered = await runtime.recover({ workspaceId: "workspace-1", agentName: observation.identity.agentName, sessionFile, cwd });
    assert.deepEqual(recovered?.identity, observation.identity);
    assert.equal(recovered?.status, "working");
    await runtime.interrupt(observation.identity);
    const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const prompt = calls.find((args) => args[0] === "agent" && args[1] === "prompt")!;
    assert.equal(prompt.includes("--wait"), false);
    assert.deepEqual(calls.find((args) => args[0] === "agent" && args[1] === "send-keys")?.slice(-1), ["esc"]);
    assert.equal(calls.filter((args) => args[0] === "agent" && args[1] === "get").length, 2);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
