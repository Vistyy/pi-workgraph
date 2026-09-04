import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import { WorkgraphEngine } from "../src/engine.js";
import { GitRepository, runProcess } from "../src/git.js";
import { herdrAgentName, type HerdrObservation, type VisibleWorkerRuntime, type WorkerLaunchRequest, type WorkerRecoveryRequest } from "../src/herdr.js";
import { readWorkgraphReportResult } from "../src/pi-process.js";
import { WorkgraphSupervisor } from "../src/supervisor.js";
import type { WorkerIdentity } from "../src/types.js";
import { discoveryReport } from "./helpers.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess("git", ["-C", cwd, ...args], { cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

test("research can create an answer workstream without a plan and deliver after worker settlement", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-research-core-"));
  const root = join(parent, "repo");
  await runProcess("mkdir", ["-p", root], { cwd: parent, timeoutMs: 5_000 });
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "workgraph@example.test");
  await git(root, "config", "user.name", "Workgraph Research");
  await writeFile(join(root, "value.txt"), "value\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  const repository = await GitRepository.open(root);
  const parentSession = SessionManager.create(root, join(parent, "parent"));
  parentSession.appendMessage({ role: "user", content: "Research this fixture.", timestamp: Date.now() });
  parentSession.appendMessage({ role: "assistant", content: [{ type: "text", text: "Ready." }], api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
  const sessionFile = parentSession.getSessionFile();
  assert.ok(sessionFile);
  const begun = await WorkgraphEngine.begin({
    request: "Research this fixture.",
    projectRoot: root,
    gitCommonDir: repository.commonDir,
    parentSessionId: parentSession.getSessionId(),
    parentSessionFile: sessionFile,
    baseCommit: await repository.head(),
    outcome: { kind: "answer", statement: "Answer the question.", completionPredicate: "Coordinator judges the result." },
  }, { repository });
  let observations = 0;
  const wakes: string[] = [];
  class Runtime implements VisibleWorkerRuntime {
    readonly available = true;
    async launch(request: WorkerLaunchRequest): Promise<HerdrObservation> {
      const identity: WorkerIdentity = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", terminalId: "term1", agentName: herdrAgentName(request.runId, request.nodeId, request.attemptId), sessionFile: request.sessionFile, cwd: request.cwd };
      SessionManager.open(request.sessionFile).appendMessage({ role: "toolResult", toolCallId: "report", toolName: "workgraph_report", content: [{ type: "text", text: "done" }], details: { report: discoveryReport("The fixture is readable.") }, isError: false, timestamp: Date.now() });
      await request.onIdentity?.(identity);
      return { identity, status: "working", stage: "executing", observedAt: new Date().toISOString() };
    }
    async observe(identity: WorkerIdentity): Promise<HerdrObservation> {
      observations += 1;
      return { identity, status: "idle", stage: "reporting", observedAt: new Date().toISOString() };
    }
    async interrupt(identity: WorkerIdentity): Promise<HerdrObservation> { return { identity, status: "idle", stage: "reporting", observedAt: new Date().toISOString() }; }
    async recover(_request: WorkerRecoveryRequest): Promise<HerdrObservation | undefined> { return undefined; }
    async cleanup(identity: WorkerIdentity) { return { state: "completed" as const, identity, observedAt: new Date().toISOString(), detail: "closed" }; }
  }
  try {
    const queued = await begun.engine.queueDiscovery({ topology: "evidence", assignments: [{ id: "research-1", lens: "fixture", objective: "Read value.txt.", model: "provider/research", thinking: "high" }], stableEntryId: null });
    assert.equal(queued.control.planStatus, "absent");
    assert.equal(queued.phase, "discovery");
    const supervisor = new WorkgraphSupervisor(begun.engine, new Runtime(), { workspaceId: "w1", onCoordinatorWake: (wake) => { wakes.push(wake.id); } });
    await supervisor.reconcileNow();
    const running = await begun.engine.load();
    assert.equal(running.discoveries[0]?.state, "running", JSON.stringify(running, null, 2));
    assert.equal(running.discoveries[0]?.resultKind, undefined);
    await supervisor.reconcileNow();
    const settled = await supervisor.reconcileNow();
    assert.equal(observations, 1);
    assert.equal(settled.phase, "discovery");
    assert.equal(settled.discoveries[0]?.state, "completed");
    assert.equal(settled.discoveries[0]?.resultKind, "typed");
    assert.equal(settled.attempts[0]?.state, "completed");
    assert.equal(wakes.length, 1);
    assert.match(wakes[0]!, /^result:/);
    assert.equal(settled.coordinatorWakeups?.[0]?.state, "delivered");
    const acknowledged = await begun.engine.acknowledgeCoordinatorWake(wakes[0]!, "Reviewed the research result.");
    assert.ok(acknowledged.coordinatorWakeups?.[0]?.acknowledgedAt);
  } finally {
    begun.engine.registry.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("malformed persisted worker reports are classified as invalid evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workgraph-invalid-report-"));
  try {
    const session = SessionManager.create(root, join(root, "session"));
    session.appendMessage({ role: "user", content: "Invalid report.", timestamp: Date.now() });
    session.appendMessage({ role: "assistant", content: [{ type: "text", text: "Reporting." }], api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() });
    session.appendMessage({ role: "toolResult", toolCallId: "report", toolName: "workgraph_report", content: [{ type: "text", text: "invalid" }], details: { report: { kind: "discovery", status: "completed" } }, isError: false, timestamp: Date.now() });
    const result = readWorkgraphReportResult(session.getSessionFile()!);
    assert.equal(result.report, undefined);
    assert.equal(result.invalid, true, JSON.stringify(result));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
