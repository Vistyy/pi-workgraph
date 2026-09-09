import { createHash } from "node:crypto";
// oxlint-disable effecttsgo/node-builtin-import -- The provider owns private files and native process boundaries.
// oxlint-disable effecttsgo/async-function -- Effect owns the child; these functions are narrow filesystem/stream boundaries.
// oxlint-disable effecttsgo/process-env -- Workgraph and bundled-client settings are explicit host-boundary inputs.
// oxlint-disable effecttsgo/global-date -- Provider event timestamps are local protocol metadata.
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Api,
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { type ProcessResult, processEffect } from "../src/process.js";

export const CHATGPT_WEB_PROVIDER = "chatgpt-web";
export const CHATGPT_WEB_MODEL = "pro";
export const CHATGPT_WEB_API = "chatgpt-web-advisor";
export const RESEARCH_OBJECTIVE_PREFIX = "[WORKGRAPH RESEARCH OBJECTIVE]";
/** Fixed bound for the exact objective sent to the retained bridge client. */
export const RESEARCH_OBJECTIVE_MAX_BYTES = 400 * 1024;
const ArtifactRecordSchema = Type.Object(
  {
    state: Type.Optional(Type.String()),
    requested_model: Type.Optional(Type.String()),
    response_model: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    status: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
type ArtifactRecord = Static<typeof ArtifactRecordSchema>;
const CLIENT_ENV = "PI_WORKGRAPH_CHATGPT_WEB_CLIENT";
const DEFAULT_CLIENT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/codex-web-gpt-headless/consult.py",
);
const CLIENT_ROOT_ENV = "CODEX_WEB_GPT_HEADLESS_ROOT";
const ARTIFACT_NAMESPACE = "workgraph-advisor/chatgpt-web-pro";
const BRIDGE_TIMEOUT_MS = 31 * 60 * 1000;
const OUTPUT_LIMIT = 16 * 1024;
const FLOCK_CONFLICT_EXIT_CODE = 75;
type ArtifactInspection =
  | { readonly kind: "absent" }
  | { readonly kind: "completed"; readonly answer: string }
  | { readonly kind: "blocked"; readonly reason: string };

export function extractResearchObjective(messages: Context["messages"]): string {
  let objective = "";
  for (const message of messages) {
    if (message.role !== "user") continue;
    const blocks = Array.isArray(message.content)
      ? message.content
      : [{ type: "text" as const, text: message.content }];
    for (const block of blocks)
      if (block.type === "text" && block.text.startsWith(RESEARCH_OBJECTIVE_PREFIX))
        objective = block.text;
  }
  if (objective.length === 0) throw new Error("Missing Workgraph research objective.");
  if (objective.slice(RESEARCH_OBJECTIVE_PREFIX.length).trim().length === 0)
    throw new Error("Workgraph research objective is empty.");
  if (Buffer.byteLength(objective, "utf8") > RESEARCH_OBJECTIVE_MAX_BYTES)
    throw new Error("Workgraph research objective exceeds the 400 KiB limit.");
  return objective;
}

function clientRoot(): string {
  const configuredRoot =
    // oxlint-disable-next-line effecttsgo/process-env -- The bundled client owns this existing private-root setting.
    process.env[CLIENT_ROOT_ENV];
  return resolve(configuredRoot ?? join(homedir(), ".local/share/codex-web-gpt-headless"));
}

export function chatGPTWebArtifactPath(runId: string, nodeId: string): string {
  const identity = createHash("sha256")
    .update(`${runId}\0${nodeId}\0${CHATGPT_WEB_PROVIDER}/${CHATGPT_WEB_MODEL}`)
    .digest("hex");
  return join(clientRoot(), ARTIFACT_NAMESPACE, identity);
}

export function chatGPTWebClientPath(): string {
  // oxlint-disable-next-line effecttsgo/process-env -- This is the one documented test/alternate-client override.
  return resolve(process.env[CLIENT_ENV] ?? DEFAULT_CLIENT);
}

async function readJson(path: string): Promise<ArtifactRecord | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!Value.Check(ArtifactRecordSchema, value)) return undefined;
    return Value.Decode(ArtifactRecordSchema, value);
  } catch {
    return undefined;
  }
}

async function inspectArtifact(path: string): Promise<ArtifactInspection> {
  try {
    if (!(await stat(path)).isDirectory())
      return { kind: "blocked", reason: "artifact is not a directory" };
  } catch (error) {
    // SAFETY: Node's fs stat boundary supplies an ErrnoException with the code used here.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "blocked", reason: "artifact cannot be inspected" };
  }
  const status = await readJson(join(path, "status.json"));
  const response = await readJson(join(path, "response.json"));
  let answer: string;
  try {
    answer = await readFile(join(path, "answer.md"), "utf8");
  } catch {
    return { kind: "blocked", reason: "artifact has no readable answer" };
  }
  if (
    status?.state !== "completed" ||
    status?.requested_model !== `${CHATGPT_WEB_PROVIDER}/${CHATGPT_WEB_MODEL}` ||
    status?.response_model !== `${CHATGPT_WEB_PROVIDER}/${CHATGPT_WEB_MODEL}` ||
    status?.error !== undefined ||
    response?.status !== "completed" ||
    response?.model !== `${CHATGPT_WEB_PROVIDER}/${CHATGPT_WEB_MODEL}` ||
    answer.trim().length === 0
  )
    return {
      kind: "blocked",
      reason: "artifact is not a coherent completed chatgpt-web/pro result",
    };
  return { kind: "completed", answer };
}

function reportFor(answer: string, artifact: string) {
  return {
    kind: "research" as const,
    status: "completed" as const,
    summary: answer,
    evidence: [{ label: "provider", observation: "ChatGPT Web Pro artifact.", artifact }],
    findings: [],
  };
}

async function invokeBridge(
  objective: string,
  artifact: string,
  signal?: AbortSignal,
): Promise<string> {
  const current = await inspectArtifact(artifact);
  if (current.kind === "completed") return current.answer;
  if (current.kind === "blocked")
    throw new Error(`${current.reason}; retained artifact: ${artifact}`);
  const artifactDirectory = dirname(artifact);
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const lockPath = join(dirname(artifactDirectory), "workgraph-advisor.lock");
  const promptDirectory = await mkdtemp(join(tmpdir(), "pi-workgraph-chatgpt-"));
  try {
    const promptPath = join(promptDirectory, "objective.txt");
    await writeFile(promptPath, objective, { encoding: "utf8", mode: 0o600 });
    let result: ProcessResult;
    try {
      result = await Effect.runPromise(
        processEffect(
          "flock",
          [
            "--exclusive",
            "--nonblock",
            "--no-fork",
            "--conflict-exit-code",
            String(FLOCK_CONFLICT_EXIT_CODE),
            lockPath,
            "python3",
            chatGPTWebClientPath(),
            promptPath,
            "--output",
            artifact,
          ],
          {
            timeoutMs: BRIDGE_TIMEOUT_MS,
            outputLimit: OUTPUT_LIMIT,
            env: { ...process.env },
          },
        ),
        { signal },
      );
    } catch {
      const interrupted = await inspectArtifact(artifact);
      if (interrupted.kind === "completed") return interrupted.answer;
      if (interrupted.kind === "absent")
        throw new Error("ChatGPT Web client failed before submission; no artifact was retained.");
      throw new Error(`${interrupted.reason}; retained artifact: ${artifact}; do not resubmit.`);
    }
    const after = await inspectArtifact(artifact);
    if (after.kind === "completed") return after.answer;
    if (result.exitCode === FLOCK_CONFLICT_EXIT_CODE)
      throw new Error("Another ChatGPT Web consultation is in progress; no submission was made.");
    if (after.kind === "absent")
      throw new Error("ChatGPT Web client failed before submission; no artifact was retained.");
    throw new Error(`${after.reason}; retained artifact: ${artifact}; do not resubmit.`);
  } finally {
    await rm(promptDirectory, { recursive: true, force: true });
  }
}
function outputMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function streamChatGPTWeb(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  const output = outputMessage(model);
  stream.push({ type: "start", partial: output });
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This stream boundary owns preflight, bridge uncertainty, and one terminal report.
  void (async () => {
    try {
      const mode = process.env["PI_WORKGRAPH_MODE"];
      if (mode !== "research")
        throw new Error("chatgpt-web/pro is available only to Workgraph research.");
      const runId = process.env["PI_WORKGRAPH_RUN_ID"]?.trim() ?? "";
      const nodeId = process.env["PI_WORKGRAPH_NODE_ID"]?.trim() ?? "";
      if (runId.length === 0 || nodeId.length === 0)
        throw new Error("Workgraph advisor identity is absent.");
      const objective = extractResearchObjective(context.messages);
      const artifact = chatGPTWebArtifactPath(runId, nodeId);
      const answer = await invokeBridge(objective, artifact, options?.signal);
      if (options?.signal?.aborted === true)
        throw new Error(
          `ChatGPT Web bridge invocation is uncertain; retained artifact: ${artifact}; do not resubmit.`,
        );
      const report = reportFor(answer, artifact);
      const argumentsText = JSON.stringify(report);
      const toolCall: ToolCall = {
        type: "toolCall",
        id: `workgraph-report-${createHash("sha256").update(artifact).digest("hex").slice(0, 16)}`,
        name: "workgraph_report",
        arguments: report,
      };
      output.content.push(toolCall);
      stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
      stream.push({
        type: "toolcall_delta",
        contentIndex: 0,
        delta: argumentsText,
        partial: output,
      });
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
      output.stopReason = "toolUse";
      stream.push({ type: "done", reason: "toolUse", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted === true ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : "ChatGPT Web provider failed.";
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

export default function registerChatGPTWebProvider(pi: ExtensionAPI): void {
  pi.registerProvider(CHATGPT_WEB_PROVIDER, {
    name: "ChatGPT Web",
    baseUrl: "http://127.0.0.1",
    apiKey: "workgraph-local",
    api: CHATGPT_WEB_API,
    models: [
      {
        id: CHATGPT_WEB_MODEL,
        name: "ChatGPT Web Pro",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 400_000,
        maxTokens: 128_000,
      },
    ],
    streamSimple: streamChatGPTWeb,
  });
}
