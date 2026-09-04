import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { CoordinatorRuntimeIdentity, ThinkingLevel, WorkerIdentity, WorkerObservationStatus, WorkerStage } from "./types.js";

export type HerdrAgentStatus = WorkerObservationStatus;

export interface HerdrObservation {
  identity: WorkerIdentity;
  status: HerdrAgentStatus;
  stage: WorkerStage;
  observedAt: string;
}

export interface WorkerLaunchRequest {
  workspaceId: string;
  runId: string;
  nodeId: string;
  attemptId: string;
  cwd: string;
  sessionFile: string;
  prompt: string;
  model?: string;
  thinking?: ThinkingLevel;
  env: Record<string, string>;
  onIdentity?: (identity: WorkerIdentity) => void | Promise<void>;
}

export interface WorkerRecoveryRequest {
  workspaceId: string;
  agentName: string;
  sessionFile: string;
  cwd: string;
}

export interface CoordinatorLaunchRequest {
  workspaceId: string;
  cwd: string;
  sessionFile: string;
}

export interface CoordinatorObservationRequest {
  paneId: string;
  sessionFile: string;
  cwd: string;
}

export interface WorkerCleanupResult {
  state: "pending" | "completed" | "blocked";
  identity: WorkerIdentity;
  observedAt: string;
  detail: string;
}

export interface VisibleWorkerRuntime {
  readonly available: boolean;
  launch(request: WorkerLaunchRequest): Promise<HerdrObservation>;
  recover?(request: WorkerRecoveryRequest): Promise<HerdrObservation | undefined>;
  observe(identity: WorkerIdentity): Promise<HerdrObservation>;
  interrupt(identity: WorkerIdentity): Promise<HerdrObservation>;
  cleanup?(identity: WorkerIdentity): Promise<WorkerCleanupResult>;
  cleanupDeletedWorktree?(identity: WorkerIdentity): Promise<WorkerCleanupResult>;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class HerdrCliRuntime implements VisibleWorkerRuntime {
  readonly available: boolean;

  constructor(
    private readonly command = process.env.PI_WORKGRAPH_HERDR_BIN || "herdr",
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.available = env.HERDR_ENV === "1" && typeof env.HERDR_WORKSPACE_ID === "string";
  }

  async launchCoordinator(request: CoordinatorLaunchRequest): Promise<WorkerIdentity> {
    if (!this.available) throw new Error("Herdr coordinator runtime is unavailable.");
    const tabResponse = await this.call(["tab", "create", "--workspace", request.workspaceId, "--cwd", request.cwd, "--label", "Workgraph coordinator", "--no-focus"]);
    const tab = object(object(tabResponse, "result"), "root_pane");
    const paneId = string(tab, "pane_id");
    const agentName = `wg-coordinator-${createHash("sha256").update(`${request.sessionFile}\0${request.cwd}`).digest("hex").slice(0, 16)}`;
    const started = parseAgent(object(object(await this.call(["agent", "start", agentName, "--kind", "pi", "--pane", paneId, "--", "--session", request.sessionFile], 45_000), "result"), "agent"));
    const identity: WorkerIdentity = {
      workspaceId: started.workspaceId,
      tabId: started.tabId,
      paneId: started.paneId,
      terminalId: started.terminalId,
      agentName,
      sessionFile: request.sessionFile,
      cwd: request.cwd,
    };
    assertIdentity(identity, started);
    return identity;
  }

  async observeCurrentCoordinator(request: CoordinatorObservationRequest): Promise<CoordinatorRuntimeIdentity> {
    if (!this.available) throw new Error("Herdr coordinator runtime is unavailable.");
    const current = parseCoordinator(object(object(await this.call(["agent", "get", request.paneId]), "result"), "agent"));
    if (current.sessionFile !== request.sessionFile) throw new Error("Current Herdr pane does not own the requested Pi session.");
    if (current.cwd !== request.cwd) throw new Error("Current Herdr pane cwd does not match the repository.");
    return current;
  }

  async launch(request: WorkerLaunchRequest): Promise<HerdrObservation> {
    if (!this.available) throw new Error("Herdr worker runtime is unavailable.");
    const tabResponse = await this.call([
      "tab", "create",
      "--workspace", request.workspaceId,
      "--cwd", request.cwd,
      "--label", `WG ${slug(request.nodeId).slice(0, 24) || "worker"}`,
      "--no-focus",
      ...envArgs(request.env),
    ]);
    const tabResult = object(tabResponse, "result");
    const pane = object(tabResult, "root_pane");
    const paneId = string(pane, "pane_id");
    const workerName = herdrAgentName(request.runId, request.nodeId, request.attemptId);
    const args = [
      "agent", "start", workerName,
      "--kind", "pi",
      "--pane", paneId,
      "--",
      "--session", request.sessionFile,
    ];
    if (request.model) args.push("--model", request.model);
    if (request.thinking) args.push("--thinking", request.thinking);
    const started = parseAgent(object(object(await this.call(args, 45_000), "result"), "agent"));
    const identity: WorkerIdentity = {
      workspaceId: started.workspaceId,
      tabId: started.tabId,
      paneId: started.paneId,
      terminalId: started.terminalId,
      agentName: workerName,
      sessionFile: request.sessionFile,
      cwd: request.cwd,
    };
    assertIdentity(identity, started);
    await request.onIdentity?.(identity);
    await this.call(["agent", "prompt", workerName, request.prompt], 15_000);
    return { identity, status: "working", stage: "executing", observedAt: new Date().toISOString() };
  }

  async recover(request: WorkerRecoveryRequest): Promise<HerdrObservation | undefined> {
    const response = await this.call(["api", "snapshot"]);
    const snapshot = object(object(response, "result"), "snapshot");
    const agents = snapshot.agents;
    if (!Array.isArray(agents)) throw new Error("Herdr snapshot omitted agents.");
    const matches = agents.filter((candidate): candidate is Record<string, unknown> => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const value = candidate as Record<string, unknown>;
      const session = value.agent_session;
      const sessionFile = session && typeof session === "object" ? optionalString(session as Record<string, unknown>, "value") : undefined;
      return value.workspace_id === request.workspaceId && value.name === request.agentName && value.cwd === request.cwd && sessionFile === request.sessionFile;
    });
    if (matches.length === 0) return undefined;
    if (matches.length !== 1) throw new Error(`Herdr recovery found ${matches.length} workers for ${request.agentName}.`);
    const current = parseAgent(matches[0]!);
    const identity: WorkerIdentity = {
      workspaceId: current.workspaceId,
      tabId: current.tabId,
      paneId: current.paneId,
      terminalId: current.terminalId,
      agentName: request.agentName,
      sessionFile: request.sessionFile,
      cwd: request.cwd,
    };
    assertIdentity(identity, current);
    return {
      identity,
      status: current.status,
      stage: current.status === "blocked" ? "attention" : current.status === "working" ? "executing" : "reporting",
      observedAt: new Date().toISOString(),
    };
  }

  async observe(identity: WorkerIdentity): Promise<HerdrObservation> {
    const response = await this.call(["agent", "get", identity.paneId]);
    const current = parseAgent(object(object(response, "result"), "agent"));
    assertIdentity(identity, current);
    return {
      identity,
      status: current.status,
      stage: current.status === "blocked" ? "attention" : current.status === "working" ? "executing" : "reporting",
      observedAt: new Date().toISOString(),
    };
  }

  async interrupt(identity: WorkerIdentity): Promise<HerdrObservation> {
    await this.observe(identity);
    await this.call(["agent", "send-keys", identity.agentName, "esc"]);
    return this.observe(identity);
  }

  async cleanup(identity: WorkerIdentity): Promise<WorkerCleanupResult> {
    return this.cleanupExact(identity, false);
  }

  async cleanupDeletedWorktree(identity: WorkerIdentity): Promise<WorkerCleanupResult> {
    return this.cleanupExact(identity, true);
  }

  private async cleanupExact(identity: WorkerIdentity, allowDeletedWorktree: boolean): Promise<WorkerCleanupResult> {
    const observation = await this.observeForCleanup(identity, allowDeletedWorktree);
    if (!observation) {
      return { state: "completed", identity, observedAt: new Date().toISOString(), detail: `Exact Herdr tab ${identity.tabId} was already absent.` };
    }
    if (observation.status === "working") {
      return { state: "pending", identity, observedAt: observation.observedAt, detail: "Worker is still working; exact cleanup remains pending." };
    }
    if (observation.status === "blocked" || observation.status === "unknown") {
      return { state: "blocked", identity, observedAt: observation.observedAt, detail: `Worker is ${observation.status}; cleanup requires a verified idle or done worker.` };
    }
    await this.call(["tab", "close", identity.tabId]);
    if (!(await this.tabAbsent(identity.tabId))) throw new Error(`Herdr tab ${identity.tabId} still exists after cleanup.`);
    return { state: "completed", identity, observedAt: new Date().toISOString(), detail: `Closed and verified exact Herdr tab ${identity.tabId}.` };
  }

  private async observeForCleanup(identity: WorkerIdentity, allowDeletedWorktree: boolean): Promise<HerdrObservation | undefined> {
    const result = await spawnCommand(this.command, ["agent", "get", identity.paneId], 30_000);
    if (result.code !== 0) {
      if ((isNotFound(result, "agent_not_found") || isNotFound(result, "pane_not_found")) && await this.tabAbsent(identity.tabId)) return undefined;
      throw herdrError(["agent", "get", identity.paneId], result);
    }
    const parsed = parseSuccess(result, ["agent", "get", identity.paneId]);
    const current = parseAgent(object(object(parsed, "result"), "agent"));
    assertIdentity(identity, current, allowDeletedWorktree);
    return {
      identity,
      status: current.status,
      stage: current.status === "blocked" ? "attention" : current.status === "working" ? "executing" : "reporting",
      observedAt: new Date().toISOString(),
    };
  }

  private async tabAbsent(tabId: string): Promise<boolean> {
    const result = await spawnCommand(this.command, ["tab", "get", tabId], 30_000);
    if (result.code === 0) return false;
    if (isNotFound(result, "tab_not_found")) return true;
    throw herdrError(["tab", "get", tabId], result);
  }

  private async call(args: string[], timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const result = await spawnCommand(this.command, args, timeoutMs);
    if (result.code !== 0) throw herdrError(args, result);
    return parseSuccess(result, args);
  }
}

interface ParsedAgent {
  workspaceId: string;
  tabId: string;
  paneId: string;
  terminalId: string;
  name: string;
  status: HerdrAgentStatus;
  sessionFile: string;
  cwd: string;
}

function parseCoordinator(value: Record<string, unknown>): CoordinatorRuntimeIdentity {
  const session = object(value, "agent_session");
  const agentName = optionalString(value, "name");
  return {
    workspaceId: string(value, "workspace_id"),
    tabId: string(value, "tab_id"),
    paneId: string(value, "pane_id"),
    terminalId: string(value, "terminal_id"),
    ...(agentName ? { agentName } : {}),
    sessionFile: string(session, "value"),
    cwd: string(value, "cwd"),
  };
}

function parseAgent(value: Record<string, unknown>): ParsedAgent {
  const status = string(value, "agent_status");
  if (!isAgentStatus(status)) throw new Error(`Invalid Herdr agent status: ${status}`);
  const session = object(value, "agent_session");
  const result: ParsedAgent = {
    workspaceId: string(value, "workspace_id"),
    tabId: string(value, "tab_id"),
    paneId: string(value, "pane_id"),
    terminalId: string(value, "terminal_id"),
    name: string(value, "name"),
    status,
    cwd: string(value, "cwd"),
    sessionFile: string(session, "value"),
  };
  return result;
}

function assertIdentity(expected: WorkerIdentity, actual: ParsedAgent, allowDeletedWorktree = false): void {
  if (
    expected.workspaceId !== actual.workspaceId
    || expected.tabId !== actual.tabId
    || expected.paneId !== actual.paneId
    || expected.terminalId !== actual.terminalId
    || expected.agentName !== actual.name
  ) {
    throw new Error("Herdr worker identity changed.");
  }
  if (actual.sessionFile !== expected.sessionFile) throw new Error("Herdr native Pi session changed.");
  const attributableDeletedCwd = allowDeletedWorktree && actual.cwd === `${expected.cwd} (deleted)`;
  if (actual.cwd !== expected.cwd && !attributableDeletedCwd) throw new Error("Herdr worker cwd changed.");
}

function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

export function herdrAgentName(runId: string, nodeId: string, attemptId: string): string {
  const node = slug(nodeId).slice(0, 12) || "worker";
  const attemptKey = createHash("sha256").update(`${runId}\0${nodeId}\0${attemptId}`).digest("hex").slice(0, 12);
  return `wg-${node}-${attemptKey}`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/g, "");
}

function object(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const result = value[key];
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error(`Herdr response omitted object ${key}.`);
  return result as Record<string, unknown>;
}

function string(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || !result) throw new Error(`Herdr response omitted string ${key}.`);
  return result;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const result = value[key];
  return typeof result === "string" && result ? result : undefined;
}

function isAgentStatus(value: string): value is HerdrAgentStatus {
  return value === "idle" || value === "working" || value === "blocked" || value === "done" || value === "unknown";
}

function parseSuccess(result: CommandResult, args: string[]): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); }
  catch { throw new Error(`Herdr returned invalid JSON for ${args.slice(0, 2).join(" ")}.`); }
  if (!parsed || typeof parsed !== "object" || !("result" in parsed)) {
    throw new Error(`Herdr returned an invalid success response for ${args.slice(0, 2).join(" ")}.`);
  }
  return parsed as Record<string, unknown>;
}

function isNotFound(result: CommandResult, expectedCode: "agent_not_found" | "pane_not_found" | "tab_not_found"): boolean {
  for (const candidate of [result.stderr, result.stdout]) {
    try {
      const parsed = JSON.parse(candidate) as { error?: { code?: string } };
      if (parsed.error?.code === expectedCode) return true;
    } catch {}
  }
  return false;
}

function herdrError(args: string[], result: CommandResult): Error {
  let message = result.stderr || result.stdout || `Herdr exited ${result.code}.`;
  for (const candidate of [result.stderr, result.stdout]) {
    try {
      const parsed = JSON.parse(candidate) as { error?: { code?: string; message?: string } };
      message = [parsed.error?.code, parsed.error?.message].filter(Boolean).join(": ") || message;
      if (parsed.error) break;
    } catch {}
  }
  return new Error(`herdr ${args.slice(0, 2).join(" ")} failed: ${message}`);
}

function spawnCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}
