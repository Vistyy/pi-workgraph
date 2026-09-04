import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { capabilityArgs, capabilityTools, resolveChildCapabilities, type ChildCapability } from "./capabilities.js";
import type {
  ChildOutcome,
  ThinkingLevel,
  WorkerMode,
  UsageSummary,
  WorkerReport,
  ChildCapabilityRecord,
} from "./types.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultWorkerExtension = resolve(packageRoot, "extensions", "worker.ts");
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
  allowedPaths?: string[];
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
  const capabilities = request.capabilities ?? await resolveChildCapabilities(request.mode, request.guideModel);
  const args = buildChildArguments(request, sessionFile, capabilities);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_WORKGRAPH_MODE: request.mode,
    PI_WORKGRAPH_RUN_ID: request.runId,
    PI_WORKGRAPH_NODE_ID: request.nodeId,
    PI_WORKGRAPH_EXECUTOR_MODEL: request.executorModel ?? request.guideModel,
    PI_WORKGRAPH_EXECUTOR_THINKING: request.executorThinking ?? request.guideThinking,
    PI_WORKGRAPH_BASE_COMMIT: request.baseCommit ?? "",
    PI_WORKGRAPH_ALLOWED_PATHS: JSON.stringify(request.allowedPaths ?? []),
    PI_WORKGRAPH_RESPONSIBILITY: request.responsibility ?? "",
    PI_WORKGRAPH_IMPLEMENTATION_START: request.implementationStart ?? "guide",
    PI_WORKGRAPH_CAPABILITIES: JSON.stringify(capabilities),
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

export function buildChildArguments(request: Pick<ChildRequest, "mode" | "guideModel" | "guideThinking" | "executorModel" | "executorThinking" | "implementationStart">, sessionFile: string, capabilities: ChildCapability[]): string[] {
  const startsInExecutor = request.mode === "implementation" && request.implementationStart === "executor";
  const initialModel = startsInExecutor ? request.executorModel ?? request.guideModel : request.guideModel;
  const initialThinking = startsInExecutor ? request.executorThinking ?? request.guideThinking : request.guideThinking;
  const tools = request.mode === "implementation"
    ? ["read","bash","grep","find","ls","edit","write","workgraph_todo","workgraph_report"]
    : ["read","bash","grep","find","ls","workgraph_report"];
  if (request.mode === "discovery") tools.push(...capabilityTools(capabilities));
  return ["--mode", "json", "--print", "--session", sessionFile, "--model", initialModel, "--thinking", initialThinking, "--no-extensions", "--extension", defaultWorkerExtension, ...capabilityArgs(capabilities), "--no-prompt-templates", "--tools", tools.join(","), "Continue the assigned Workgraph objective now."];
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
        const details = message.details as { report?: WorkerReport } | undefined;
        if (details?.report) report = details.report;
      }
      if (event.type === "tool_execution_end" && event.toolName === "workgraph_report") {
        const result = event.result as { details?: { report?: WorkerReport } } | undefined;
        if (result?.details?.report) report = result.details.report;
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
      report ??= readWorkgraphReport(options.sessionFile);
      resolvePromise({
        exitCode: code ?? 1,
        sessionFile: options.sessionFile,
        ...(report ? { report } : {}),
        stderr: stderr.trim(),
        usage,
        models,
        timedOut,
        ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      });
    });
  });
}

export function readWorkgraphReport(sessionFile: string): WorkerReport | undefined {
  try {
    const messages = SessionManager.open(sessionFile).buildSessionContext().messages;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "toolResult" || message.toolName !== "workgraph_report") continue;
      const details = message.details as { report?: WorkerReport } | undefined;
      if (details?.report) return details.report;
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
