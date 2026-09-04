import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ChildCapability } from "./capabilities.js";
import type {
  ChildOutcome,
  ThinkingLevel,
  WorkerMode,
  UsageSummary,
  WorkerReport,
  ChildCapabilityRecord,
} from "./types.js";

const STDERR_LIMIT = 50 * 1024;

export interface ChildRequest {
  parentSessionFile: string;
  targetCwd: string;
  sessionDir: string;
  objective: string;
  mode: WorkerMode;
  guideModel: string;
  guideThinking: ThinkingLevel;
  executorModel?: string;
  executorThinking?: ThinkingLevel;
  runId: string;
  nodeId: string;
  baseCommit?: string;
  responsibility?: string;
  implementationStart?: "guide" | "executor";
  timeoutMs?: number;
  stableEntryId?: string | null;
  onSessionCreated?: (sessionFile: string) => void | Promise<void>;
  signal?: AbortSignal;
  capabilities?: ChildCapabilityRecord[];
}

export async function runPiChild(request: ChildRequest): Promise<ChildOutcome> {
  const sessionFile = await forkSession(request);
  await request.onSessionCreated?.(sessionFile);
  const capabilities = request.capabilities ?? [];
  const args = buildChildArguments(request, sessionFile, capabilities);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_WORKGRAPH_MODE: request.mode,
    PI_WORKGRAPH_RUN_ID: request.runId,
    PI_WORKGRAPH_NODE_ID: request.nodeId,
    PI_WORKGRAPH_EXECUTOR_MODEL: request.executorModel ?? request.guideModel,
    PI_WORKGRAPH_EXECUTOR_THINKING: request.executorThinking ?? request.guideThinking,
    PI_WORKGRAPH_BASE_COMMIT: request.baseCommit ?? "",
    PI_WORKGRAPH_RESPONSIBILITY: request.responsibility ?? "",
    PI_WORKGRAPH_IMPLEMENTATION_START: request.implementationStart ?? "guide",
  };

  return spawnPi({
    command: process.env.PI_WORKGRAPH_PI_BIN || "pi",
    args,
    cwd: request.targetCwd,
    env,
    sessionFile,
    timeoutMs: request.timeoutMs ?? 20 * 60_000,
    ...(request.signal ? { signal: request.signal } : {}),
    capabilities,
  });
}

export function buildChildArguments(request: Pick<ChildRequest, "mode" | "guideModel" | "guideThinking" | "executorModel" | "executorThinking" | "implementationStart">, sessionFile: string, _capabilities: ChildCapability[]): string[] {
  const startsInExecutor = request.mode === "implementation" && request.implementationStart === "executor";
  const initialModel = startsInExecutor ? request.executorModel ?? request.guideModel : request.guideModel;
  const initialThinking = startsInExecutor ? request.executorThinking ?? request.guideThinking : request.guideThinking;
  return ["--mode", "json", "--print", "--session", sessionFile, "--model", initialModel, "--thinking", initialThinking, "Continue the assigned Workgraph objective now."];
}

export async function forkConversationSession(request: { parentSessionFile: string; targetCwd: string; entryId?: string }): Promise<string> {
  const parent = SessionManager.open(request.parentSessionFile);
  const child = SessionManager.forkFrom(request.parentSessionFile, request.targetCwd);
  if (request.entryId) {
    if (!parent.getEntry(request.entryId)) throw new Error(`Unknown conversation entry: ${request.entryId}`);
    child.branch(request.entryId);
  }
  const file = child.getSessionFile();
  if (!file) throw new Error("Forked coordinator session did not produce a session file.");
  return file;
}

export async function forkSession(request: Pick<ChildRequest, "parentSessionFile" | "targetCwd" | "sessionDir" | "objective" | "mode" | "runId" | "nodeId" | "stableEntryId">): Promise<string> {
  await mkdir(request.sessionDir, { recursive: true });
  const parent = SessionManager.open(request.parentSessionFile);
  const child = SessionManager.forkFrom(request.parentSessionFile, request.targetCwd, request.sessionDir);
  const stableEntryId = request.stableEntryId === undefined ? stableParentEntry(parent) : request.stableEntryId;
  if (stableEntryId) child.branch(stableEntryId);
  else child.resetLeaf();
  child.appendCustomMessageEntry(
    "pi-workgraph-objective",
    [
      `[WORKGRAPH ${request.mode.toUpperCase()} OBJECTIVE]`,
      `Run: ${request.runId}`,
      `Node: ${request.nodeId}`,
      "",
      request.objective.trim(),
    ].join("\n"),
    false,
    { runId: request.runId, nodeId: request.nodeId, mode: request.mode },
  );
  const file = child.getSessionFile();
  if (!file) throw new Error("Forked child session did not produce a session file.");
  return file;
}

export function stableParentEntry(manager: Pick<SessionManager, "getLeafEntry">): string | null {
  const leaf = manager.getLeafEntry();
  if (!leaf) return null;
  if (leaf.type === "message" && leaf.message.role === "assistant") {
    const hasToolCall = leaf.message.content.some((part) => part.type === "toolCall");
    if (hasToolCall) return leaf.parentId;
  }
  return leaf.id;
}

export async function mapConcurrent<TInput, TOutput>(
  inputs: TInput[],
  concurrency: number,
  operation: (input: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Concurrency must be a positive integer.");
  const outputs = new Array<TOutput>(inputs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= inputs.length) return;
      const input = inputs[index];
      if (input === undefined) return;
      outputs[index] = await operation(input, index);
    }
  });
  await Promise.all(workers);
  return outputs;
}

interface SpawnPiOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  sessionFile: string;
  timeoutMs: number;
  signal?: AbortSignal;
  capabilities?: ChildCapabilityRecord[];
}

async function spawnPi(options: SpawnPiOptions): Promise<ChildOutcome> {
  return new Promise<ChildOutcome>((resolvePromise) => {
    const usage: UsageSummary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
    const models: string[] = [];
    let report: WorkerReport | undefined;
    let terminalText = "";
    let stderr = "";
    let lineBuffer = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const processLine = (line: string): void => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const message = event.message as Record<string, unknown> | undefined;
      if (event.type === "message_end" && message?.role === "assistant") {
        terminalText = assistantText(message);
        usage.turns += 1;
        const messageUsage = message.usage as Record<string, unknown> | undefined;
        const cost = messageUsage?.cost as Record<string, unknown> | undefined;
        usage.input += numberValue(messageUsage?.input);
        usage.output += numberValue(messageUsage?.output);
        usage.cacheRead += numberValue(messageUsage?.cacheRead);
        usage.cacheWrite += numberValue(messageUsage?.cacheWrite);
        usage.cost += numberValue(cost?.total);
        const provider = typeof message.provider === "string" ? message.provider : "";
        const model = typeof message.model === "string" ? message.model : "";
        const selector = provider && model ? `${provider}/${model}` : model;
        if (selector && models.at(-1) !== selector) models.push(selector);
      }
      if ((event.type === "tool_result_end" || event.type === "message_end") && message?.role === "toolResult" && message.toolName === "workgraph_report") {
        const details = isRecord(message.details) ? message.details : undefined;
        if (isWorkerReport(details?.report)) report = details.report;
      }
      if (event.type === "tool_execution_end" && event.toolName === "workgraph_report") {
        const result = isRecord(event.result) ? event.result : undefined;
        const details = isRecord(result?.details) ? result.details : undefined;
        if (isWorkerReport(details?.report)) report = details.report;
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = tailBytes(stderr + chunk.toString(), STDERR_LIMIT);
    });

    const stop = (): void => {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
      force.unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    timeout.unref();
    const onAbort = (): void => stop();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      stderr = tailBytes(`${stderr}\n${error.message}`.trim(), STDERR_LIMIT);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      if (lineBuffer.trim()) processLine(lineBuffer);
      const storedReport = readWorkgraphReportResult(options.sessionFile);
      report ??= storedReport.report;
      resolvePromise({
        exitCode: code ?? 1,
        sessionFile: options.sessionFile,
        resultKind: report ? "typed" : storedReport.invalid ? "invalid" : terminalText ? "untyped" : "absent",
        ...(report ? { report } : {}),
        ...(terminalText ? { terminalText } : {}),
        stderr: stderr.trim(),
        usage,
        models,
        timedOut,
        ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      });
    });
  });
}

function assistantText(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .filter((part): part is { type: string; text: string } => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export interface WorkgraphReportRead {
  report?: WorkerReport;
  invalid: boolean;
}

export function readWorkgraphReportResult(sessionFile: string): WorkgraphReportRead {
  try {
    const messages = SessionManager.open(sessionFile).buildSessionContext().messages;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "toolResult" || message.toolName !== "workgraph_report") continue;
      const details = isRecord(message.details) ? message.details : undefined;
      if (isWorkerReport(details?.report)) return { report: details.report, invalid: false };
      return { invalid: true };
    }
  } catch {
    return { invalid: false };
  }
  return { invalid: false };
}

export function readWorkgraphReport(sessionFile: string): WorkerReport | undefined {
  return readWorkgraphReportResult(sessionFile).report;
}

function isWorkerReport(value: unknown): value is WorkerReport {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.status !== "string" || typeof value.summary !== "string") return false;
  if (!(["discovery", "implementation", "verification", "assurance_review", "assurance_synthesis"] as string[]).includes(value.kind)) return false;
  if (!(["completed", "escalated", "failed"] as string[]).includes(value.status)) return false;
  if (!Array.isArray(value.evidence) || !Array.isArray(value.findings)) return false;
  if (value.kind === "verification" && !(["verified", "failed", "inconclusive"] as string[]).includes(String(value.verdict))) return false;
  if (value.kind === "assurance_review" && typeof value.responsibility !== "string") return false;
  if (value.kind === "assurance_synthesis" && typeof value.verdict !== "string") return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readTerminalText(sessionFile: string): string | undefined {
  try {
    const messages = SessionManager.open(sessionFile).buildSessionContext().messages;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "assistant") continue;
      const text = assistantText(message as unknown as Record<string, unknown>);
      if (text) return text;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function tailBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = value.slice(-maxBytes);
  while (Buffer.byteLength(result) > maxBytes) result = result.slice(1);
  return result;
}
