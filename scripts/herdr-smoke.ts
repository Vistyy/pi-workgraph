import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { runCli } from "../src/cli.js";
import { WorkgraphEngine } from "../src/engine.js";
import { GitRepository, runProcess } from "../src/git.js";
import { HerdrCliRuntime } from "../src/herdr.js";
import { readTerminalText } from "../src/pi-process.js";
import { WorkgraphRegistry } from "../src/registry.js";
import { WorkgraphSupervisor } from "../src/supervisor.js";
import type { WorkerIdentity } from "../src/types.js";

const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-herdr-smoke-"));
const root = join(parent, "fixture");
const registryPath = join(parent, "registry.sqlite");
const createdTabs: string[] = [];
let workspaceId: string | undefined;
let coordinator: WorkerIdentity | undefined;
let worker: WorkerIdentity | undefined;
let registry: WorkgraphRegistry | undefined;
const observations: string[] = [];

async function herdr(...args: string[]): Promise<Record<string, any>> {
  const result = await runProcess("herdr", args, { cwd: root, timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error(`herdr ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  if (!result.stdout) return { result: {} };
  const parsed = JSON.parse(result.stdout) as Record<string, any>;
  if (!parsed.result) throw new Error(`herdr ${args.join(" ")} returned no result.`);
  return parsed;
}

async function git(...args: string[]): Promise<string> {
  const result = await runProcess("git", ["-C", root, ...args], { cwd: root, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function identityWithPane(identity: WorkerIdentity, paneId: string): WorkerIdentity {
  return { ...identity, paneId };
}

try {
  if (process.env.HERDR_ENV !== "1") throw new Error("INCONCLUSIVE: HERDR_ENV is not 1; live Herdr verification is unavailable.");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "value.txt"), "fixture\n");
  await runProcess("git", ["init", "-b", "main", root], { cwd: parent, timeoutMs: 30_000 });
  await git("config", "user.email", "workgraph@example.test");
  await git("config", "user.name", "Workgraph Herdr Smoke");
  await git("add", ".");
  await git("commit", "-m", "Create disposable smoke fixture");

  const before = await herdr("workspace", "list");
  const priorWorkspaceIds = new Set((before.result.workspaces ?? []).map((item: any) => item.workspace_id ?? item.id));
  const created = await herdr("workspace", "create", "--cwd", root, "--label", `Workgraph smoke ${Date.now()}`, "--no-focus");
  const workspace = created.result.workspace;
  workspaceId = String(workspace.workspace_id ?? workspace.id);
  if (!workspaceId || priorWorkspaceIds.has(workspaceId)) throw new Error("Refusing smoke: Herdr returned a pre-existing workspace.");
  observations.push(`created workspace ${workspaceId}`);

  const repository = await GitRepository.open(root);
  const parentSession = SessionManager.create(root, join(parent, "parent-sessions"));
  parentSession.appendMessage({ role: "user", content: "Use the disposable fixture without changing its setup.", timestamp: Date.now() });
  const acknowledgement: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "I will keep this disposable fixture unchanged." }],
    api: "openai-responses",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  parentSession.appendMessage(acknowledgement);
  const parentSessionFile = parentSession.getSessionFile();
  if (!parentSessionFile) throw new Error("Could not create the disposable parent session.");
  registry = new WorkgraphRegistry(registryPath);
  const begun = await WorkgraphEngine.begin({
    request: "Exercise live fallback boundaries.",
    projectRoot: root,
    gitCommonDir: repository.commonDir,
    parentSessionId: parentSession.getSessionId(),
    parentSessionFile,
    baseCommit: await repository.head(),
    outcome: { kind: "product_change", statement: "The disposable boundary checks complete.", completionPredicate: "All live resource and lifecycle checks pass." },
  }, { repository, registry });

  const status = await runCli(["status", "--run-id", begun.run.runId, "--registry", registryPath]);
  if (status.run?.runId !== begun.run.runId) throw new Error("CLI status did not read the isolated registry.");
  const adopted = await runCli(["adopt", "--run-id", begun.run.runId, "--registry", registryPath, "--cwd", root, "--session-id", parentSession.getSessionId(), "--session-file", parentSessionFile], { ...process.env, HERDR_ENV: "", HERDR_WORKSPACE_ID: "" });
  if ((adopted.result as { forked?: boolean } | undefined)?.forked !== false || adopted.run?.coordinator.sessionFile !== parentSessionFile) throw new Error("CLI adoption forked or changed the current session path.");
  assertDuplicateLease(registry, begun.run.runId, parentSessionFile);
  observations.push("status, unchanged-session adoption, and duplicate lease refusal passed");
  begun.engine.releaseLease();

  const runtime = new HerdrCliRuntime();
  const childManager = SessionManager.forkFrom(parentSessionFile, root, join(parent, "forked-sessions"));
  const childSession = childManager.getSessionFile();
  if (!childSession) throw new Error("Forked coordinator session did not produce a file.");
  coordinator = await runtime.launchCoordinator({ workspaceId, cwd: root, sessionFile: childSession });
  createdTabs.push(coordinator.tabId);
  await herdr("agent", "rename", coordinator.paneId, "--clear");
  const rebound = await runCli([
    "adopt", "--run-id", begun.run.runId, "--registry", registryPath, "--cwd", root,
    "--session-id", childManager.getSessionId(), "--session-file", childSession, "--liveness", "dead",
  ], { ...process.env, HERDR_ENV: "1", HERDR_WORKSPACE_ID: workspaceId, HERDR_PANE_ID: coordinator.paneId });
  if ((rebound.result as { forked?: boolean } | undefined)?.forked !== false) throw new Error("Recovered current-session adoption forked the coordinator.");
  if (rebound.run?.coordinator.runtimeIdentity?.paneId !== coordinator.paneId || rebound.run.coordinator.runtimeIdentity.agentName !== undefined) throw new Error("Recovered unnamed coordinator pane was not retained exactly.");
  await herdr("agent", "rename", coordinator.paneId, coordinator.agentName);
  const coordinatorObservation = await runtime.observe(coordinator);
  if (coordinatorObservation.identity.sessionFile !== childSession || coordinatorObservation.identity.cwd !== root) throw new Error("Coordinator identity did not retain normal Pi session and cwd.");
  observations.push(`unnamed current-session rebind and normal coordinator identity passed for ${childSession}`);

  const base = await repository.head();
  const placement = await repository.createWorktree(begun.run.runId, "isolation", base);
  const tab = await herdr("tab", "create", "--workspace", workspaceId, "--cwd", placement.path, "--label", "Workgraph smoke shell", "--no-focus");
  const tabId = String(tab.result.tab.tab_id ?? tab.result.tab.id);
  const paneId = String(tab.result.root_pane.pane_id);
  createdTabs.push(tabId);
  await herdr("pane", "run", paneId, "printf 'workgraph-smoke-shell\\n'");
  await herdr("pane", "wait-output", paneId, "--match", "workgraph-smoke-shell", "--timeout", "10000");
  const workerSessionManager = SessionManager.forkFrom(parentSessionFile, placement.path, join(parent, "worker-sessions"));
  const workerSessionFile = workerSessionManager.getSessionFile();
  if (!workerSessionFile) throw new Error("Worker session fork did not produce a file.");
  const workerName = `wg-smoke-${workspaceId.toLowerCase()}`;
  const startedWorker = await herdr("agent", "start", workerName, "--kind", "pi", "--pane", paneId, "--", "--session", workerSessionFile);
  const agent = startedWorker.result.agent;
  worker = {
    workspaceId: String(agent.workspace_id),
    tabId: String(agent.tab_id),
    paneId: String(agent.pane_id),
    terminalId: String(agent.terminal_id),
    agentName: workerName,
    sessionFile: String(agent.agent_session.value),
    cwd: String(agent.cwd),
  };
  const workerObservation = await runtime.observe(worker);
  if (workerObservation.identity.sessionFile !== workerSessionFile || workerObservation.identity.cwd !== placement.path) throw new Error("Worker did not retain its normal Pi session and isolated cwd.");
  observations.push("normal Herdr shell resources and isolated Pi worker session passed");

  const proseSession = SessionManager.create(root, join(parent, "prose-sessions"));
  proseSession.appendMessage({ role: "user", content: "Retain this terminal result.", timestamp: Date.now() });
  proseSession.appendMessage({ ...acknowledgement, content: [{ type: "text", text: "Useful final prose retained by recovery." }], timestamp: Date.now() });
  const proseFile = proseSession.getSessionFile();
  if (!proseFile || readTerminalText(proseFile) !== "Useful final prose retained by recovery.") throw new Error("Prose-only terminal evidence was not retained.");
  observations.push("prose-only terminal evidence retention passed");

  if (placement.path === root || (await repository.head()) !== base) throw new Error("Worktree isolation changed the disposable coordinator checkout.");
  await begun.engine.store.update((run) => {
    run.attempts.push({
      id: "live-cleanup-attempt",
      nodeId: "live-cleanup",
      mode: "implementation",
      planVersion: 0,
      state: "completed",
      stage: "settled",
      runtimeMode: "herdr",
      createdAt: new Date().toISOString(),
      settledAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      baseCommit: placement.baseCommit,
      branch: placement.branch,
      worktreePath: placement.path,
      sessionFile: workerSessionFile,
      agentName: worker!.agentName,
      worker: { ...worker! },
    });
  });
  const cleanupRun = await new WorkgraphSupervisor(begun.engine, runtime, { workspaceId }).cleanupNow();
  const workerCleanup = cleanupRun.cleanup?.filter((record) => record.attemptId === "live-cleanup-attempt") ?? [];
  const herdrCleanup = workerCleanup.find((record) => record.kind === "herdr_worker");
  const gitCleanup = workerCleanup.find((record) => record.kind === "git_worktree");
  if (herdrCleanup?.state !== "completed" || gitCleanup?.state !== "completed") throw new Error(`Ordered cleanup did not complete: ${JSON.stringify(workerCleanup)}`);
  if (!herdrCleanup.completedAt || !gitCleanup.completedAt || herdrCleanup.completedAt > gitCleanup.completedAt) throw new Error("Git cleanup completed before exact Herdr cleanup.");
  worker = undefined;
  observations.push("exact Herdr closure preceded clean worktree removal and retained both records");

  await begun.engine.store.update((run) => { run.phase = "discovery"; });
  await expectRejected(begun.engine.execute({ nodes: [], maxConcurrency: 1 }), "expected approved");
  await begun.engine.store.update((run) => { run.phase = "executing"; });
  const recovered = await runCli(["recovery", "--run-id", begun.run.runId, "--registry", registryPath]);
  if (recovered.run?.phase !== "needs_decision") throw new Error("Recovery did not preserve the discovery gate for an empty execution.");
  observations.push("discovery gating and recovery diagnostics passed");

  const interrupted = await runtime.interrupt(coordinator);
  if (interrupted.identity.agentName !== coordinator.agentName) throw new Error("Interruption changed the exact coordinator identity.");
  await expectRejected(runtime.cleanup(identityWithPane(coordinator, `${coordinator.paneId}-mismatch`)), "agent");
  const cleanedCoordinator = await runtime.cleanup(coordinator);
  if (cleanedCoordinator.state !== "completed") throw new Error("Exact coordinator cleanup did not complete.");
  coordinator = undefined;
  observations.push("interruption recovery and identity-mismatch cleanup refusal passed");

  const suspended = await runCli(["suspend", "--run-id", begun.run.runId, "--registry", registryPath, "--reason", "Smoke lifecycle pause."]);
  const resumed = await runCli(["resume", "--run-id", begun.run.runId, "--registry", registryPath, "--reason", "Smoke lifecycle resume."]);
  if (suspended.run?.lifecycle !== "suspended" || resumed.run?.lifecycle !== "active") throw new Error("Lifecycle suspend/resume did not persist.");
  const abandoned = await runCli(["abandon", "--run-id", begun.run.runId, "--registry", registryPath, "--reason", "Smoke lifecycle abandon."]);
  const archived = await runCli(["archive", "--run-id", begun.run.runId, "--registry", registryPath, "--reason", "Smoke lifecycle archive."]);
  if (abandoned.run?.lifecycle !== "abandoned" || archived.run?.lifecycle !== "archived") throw new Error("Lifecycle abandon/archive did not persist.");
  const cleaned = await runCli(["cleanup", "--run-id", begun.run.runId, "--registry", registryPath]);
  if (cleaned.run?.lifecycle !== "archived") throw new Error("CLI cleanup did not use the isolated Workgraph state.");
  observations.push("lifecycle and cleanup commands passed");

  console.log(JSON.stringify({ status: "passed", herdr: "0.8.2", workspaceId, observations }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ status: message.startsWith("INCONCLUSIVE:") ? "inconclusive" : "failed", herdr: "0.8.2", workspaceId, observations, error: message }));
  if (!message.startsWith("INCONCLUSIVE:")) process.exitCode = 1;
} finally {
  if (worker) {
    try { await new HerdrCliRuntime().cleanup(worker); } catch {}
  }
  if (coordinator && workspaceId) {
    try { await new HerdrCliRuntime().cleanup(coordinator); } catch {}
  }
  for (const tabId of [...new Set(createdTabs)].reverse()) {
    try { await herdr("tab", "close", tabId); } catch {}
  }
  if (workspaceId) {
    try { await herdr("workspace", "close", workspaceId); } catch {}
  }
  registry?.close();
  await rm(parent, { recursive: true, force: true });
}

function assertDuplicateLease(current: WorkgraphRegistry, runId: string, sessionFile: string): void {
  assert.throws(() => current.acquire(runId, { sessionId: "other-session", sessionFile }, new Date()), /leased by session/);
}

async function expectRejected(operation: Promise<unknown>, pattern: string): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error && error.message.includes(pattern)) return;
    throw error;
  }
  throw new Error(`Expected operation to reject with ${pattern}.`);
}

