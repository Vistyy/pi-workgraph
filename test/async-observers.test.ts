import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { WorkgraphEngine } from "../src/engine.js";
import { GitRepository, runProcess } from "../src/git.js";
import { HerdrObservation, herdrAgentName, VisibleWorkerRuntime, WorkerLaunchRequest, WorkerRecoveryRequest } from "../src/herdr.js";
import { WorkgraphSupervisor } from "../src/supervisor.js";
import type { WorkerIdentity } from "../src/types.js";
import { commandAgreement, discoveryReport, testOutcome } from "./helpers.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess("git", ["-C", cwd, ...args], { cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

test("discovery, verification, and assurance are durable visible-attempt queues", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-async-observers-"));
  const root = join(parent, "repo");
  await runProcess("mkdir", ["-p", root], { cwd: parent, timeoutMs: 5_000 });
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "workgraph@example.test");
  await git(root, "config", "user.name", "Workgraph Async");
  await writeFile(join(root, "value.txt"), "value\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  const repository = await GitRepository.open(root);
  const begun = await WorkgraphEngine.begin({
    request: "Queue every observer mode.",
    projectRoot: root,
    gitCommonDir: repository.commonDir,
    parentSessionId: "coordinator",
    parentSessionFile: join(parent, "coordinator.jsonl"),
    baseCommit: await repository.head(),
    outcome: testOutcome.outcome,
  }, { repository });
  try {
    let run = await begun.engine.queueDiscovery({
      topology: "evidence",
      assignments: [{ id: "history", lens: "history", objective: "Inspect history.", model: "provider/discovery", thinking: "high" }],
    });
    assert.equal(run.control.executionStatus, "scheduled");
    assert.equal(run.discoveries[0]?.state, "running");
    assert.equal(run.attempts[0]?.mode, "discovery");
    assert.equal(run.attempts[0]?.state, "queued");
    assert.equal(run.attempts[0]?.model, "provider/discovery");
    assert.equal(run.attempts[0]?.worktreePath, undefined);

    const agreement = { ...commandAgreement, verificationMethod: "independent" as const, requiredEvidence: ["Exact revision evidence."], verificationProcedure: "Read the exact composed revision." };
    await begun.engine.store.update((draft) => {
      draft.agreement = agreement;
      draft.phase = "awaiting_verification";
      delete draft.productVerification;
    });
    run = await begun.engine.queueVerification({ model: "provider/verifier", thinking: "high" });
    assert.equal(run.productVerification?.state, "running");
    assert.equal(run.productVerification?.attemptId, run.attempts.find((attempt) => attempt.mode === "verification")?.id);

    await begun.engine.store.update((draft) => {
      draft.phase = "awaiting_assurance";
      draft.productVerification = { revision: draft.composedCommit, method: "independent", state: "completed", commands: [] };
    });
    run = await begun.engine.queueAssurance({
      reviewers: [
        { responsibility: "behavior", model: "provider/behavior", thinking: "high" },
        { responsibility: "structure", model: "provider/structure", thinking: "high" },
        { responsibility: "evidence", model: "provider/evidence", thinking: "high" },
      ],
      synthesis: { model: "provider/synthesis", thinking: "high" },
      stableEntryId: "stable-branch",
    });
    assert.equal(run.assurance?.state, "running");
    assert.equal(run.assurance?.stableEntryId, "stable-branch");
    assert.deepEqual(run.attempts.filter((attempt) => attempt.mode === "assurance_review").map((attempt) => attempt.responsibility).sort(), ["behavior", "evidence", "structure"]);
    assert.equal(run.attempts.filter((attempt) => attempt.mode === "assurance_review").every((attempt) => attempt.state === "queued"), true);
    assert.equal(run.attempts.some((attempt) => attempt.mode === "assurance_synthesis"), false);
  } finally {
    begun.engine.registry.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("the visible supervisor settles a discovery report from an isolated exact-revision worktree", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-visible-discovery-"));
  const agentDir = join(parent, "agent-config");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const root = join(parent, "repo");
  await runProcess("mkdir", ["-p", root], { cwd: parent, timeoutMs: 5_000 });
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "workgraph@example.test");
  await git(root, "config", "user.name", "Workgraph Async");
  await writeFile(join(root, "value.txt"), "value\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  const repository = await GitRepository.open(root);
  const parentSessionFile = join(parent, "coordinator.jsonl");
  await writeFile(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "coordinator", timestamp: new Date().toISOString(), cwd: root })}\n${JSON.stringify({ type: "message", id: "00000001", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "Visible discovery.", timestamp: Date.now() } })}\n`);
  const begun = await WorkgraphEngine.begin({ request: "Visible discovery.", projectRoot: root, gitCommonDir: repository.commonDir, parentSessionId: "coordinator", parentSessionFile, baseCommit: await repository.head(), outcome: testOutcome.outcome }, { repository });
  class Runtime implements VisibleWorkerRuntime {
    readonly available = true;
    async launch(request: WorkerLaunchRequest): Promise<HerdrObservation> {
      assert.equal(request.env.PI_CODING_AGENT_DIR, agentDir);
      const identity: WorkerIdentity = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", terminalId: "term1", agentName: herdrAgentName(request.runId, request.nodeId, request.attemptId), sessionFile: request.sessionFile, cwd: request.cwd };
      const session = SessionManager.open(request.sessionFile);
      session.appendMessage({ role: "toolResult", toolCallId: "report", toolName: "workgraph_report", content: [{ type: "text", text: "done" }], details: { report: discoveryReport("Observed exact revision.") }, isError: false, timestamp: Date.now() });
      session.appendCustomEntry("pi-workgraph-agent-settled", { runId: request.runId, nodeId: request.nodeId });
      await request.onIdentity?.(identity);
      return { identity, status: "working", stage: "executing", observedAt: new Date().toISOString() };
    }
    async observe(identity: WorkerIdentity): Promise<HerdrObservation> { return { identity, status: "idle", stage: "reporting", nativeSettled: true, observedAt: new Date().toISOString() }; }
    async interrupt(identity: WorkerIdentity): Promise<HerdrObservation> { return { identity, status: "idle", stage: "reporting", nativeSettled: true, observedAt: new Date().toISOString() }; }
    async recover(_request: WorkerRecoveryRequest): Promise<HerdrObservation | undefined> { return undefined; }
  }
  try {
    await begun.engine.queueDiscovery({ topology: "evidence", assignments: [{ id: "visible", lens: "visible lane", objective: "Inspect the fixture.", model: "provider/discovery", thinking: "high" }] });
    const supervisor = new WorkgraphSupervisor(begun.engine, new Runtime(), { workspaceId: "w1" });
    await supervisor.reconcileNow();
    const run = await supervisor.reconcileNow();
    assert.equal(run.discoveries[0]?.state, "completed", JSON.stringify(run, null, 2));
    assert.equal(run.phase, "awaiting_agreement");
    assert.equal(run.attempts[0]?.state, "completed");
    assert.equal(run.attempts[0]?.worker?.cwd, run.attempts[0]?.worktreePath);
    assert.equal(await repository.head(), run.composedCommit);
    assert.equal(await repository.status(), "");
  } finally {
    begun.engine.registry.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(parent, { recursive: true, force: true });
  }
});
