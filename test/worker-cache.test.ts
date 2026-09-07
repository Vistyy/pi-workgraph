import assert from "node:assert/strict";
import { once } from "node:events";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The provider-bound test owns an isolated temporary directory and never contacts a remote service.
import { mkdtemp, rm } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The provider-bound test uses an isolated local HTTP server and never contacts a remote service.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The provider-bound test uses explicit isolated paths for its local fixture.
import { join, resolve } from "node:path";
import test from "node:test";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { configureFixtureEnvironment, restoreFixtureEnvironment } from "./decoders.js";

const initialPlan = {
  approach: "Inspect the stable provider transcript.",
  rationale: "Keep canonical history append-only while the plan evolves in tool results.",
  risks: "A compaction boundary may omit the original snapshot.",
  steps: [{ text: "Inspect the provider transcript fixture.", status: "done" as const }],
};

const serializedMessageSchema = Type.Object({
  role: Type.String(),
  content: Type.Optional(
    Type.Union([
      Type.String(),
      Type.Null(),
      Type.Array(Type.Object({ type: Type.String(), text: Type.String() })),
    ]),
  ),
});
const serializedRequestSchema = Type.Object({
  model: Type.String(),
  messages: Type.Array(serializedMessageSchema),
});
const addressSchema = Type.Object({ port: Type.Integer() });
const revisedPlan = {
  ...initialPlan,
  approach: "Verify the unchanged prefix after plan revision.",
};
const objective =
  "[WORKGRAPH IMPLEMENTATION OBJECTIVE]\nAcceptance: preserve the exact objective.\nConstraints: stay within the isolated worktree.";
const attempt = { runId: "fixture", nodeId: "attempt" };
type SerializedRequest = Static<typeof serializedRequestSchema>;

function sseResponse(chunks: readonly unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

function textResponse(index: number, text: string): string {
  const id = `fixture-${index}`;
  return sseResponse([
    {
      id,
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture-model",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id,
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ]);
}

function planToolResponse(index: number, plan: typeof initialPlan): string {
  const id = `fixture-${index}`;
  const arguments_ = JSON.stringify({ action: "update", plan });
  return sseResponse([
    {
      id,
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture-model",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "plan-call",
                type: "function",
                function: { name: "workgraph_plan", arguments: arguments_ },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id,
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ]);
}

async function requestBody(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  const chunks: string[] = [];
  for await (const chunk of request) {
    // SAFETY: setEncoding("utf8") makes IncomingMessage's async iterator yield text chunks.
    chunks.push(chunk as string);
  }
  return chunks.join("");
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || !Value.Check(addressSchema, address))
    throw new Error("Fixture server did not bind");
  return `http://127.0.0.1:${Value.Decode(addressSchema, address).port}/v1`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = once(server, "close");
  server.close();
  await closed;
}

async function handleProviderRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: SerializedRequest[],
): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(await requestBody(request));
    if (!Value.Check(serializedRequestSchema, parsed)) {
      response.writeHead(400);
      response.end();
      return;
    }
    const body = Value.Decode(serializedRequestSchema, parsed);
    requests.push(body);
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
      connection: "keep-alive",
    });
    response.end(
      requests.length === 2
        ? planToolResponse(requests.length, revisedPlan)
        : textResponse(requests.length, "done"),
    );
  } catch {
    response.destroy();
  }
}

void test("worker requests keep the serialized provider prefix stable across turns and plan updates", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-cache-"));
  const previous = configureFixtureEnvironment({
    PI_CODING_AGENT_DIR: join(parent, "agent"),
    PI_WORKGRAPH_BASE_COMMIT: "fixture-base",
    PI_WORKGRAPH_EXECUTOR_MODEL: "fixture/model",
    PI_WORKGRAPH_EXECUTOR_THINKING: "high",
    PI_WORKGRAPH_IMPLEMENTATION_START: "executor",
    PI_WORKGRAPH_MODE: "implementation",
    PI_WORKGRAPH_NODE_ID: "attempt",
    PI_WORKGRAPH_RUN_ID: "fixture",
  });
  const requests: SerializedRequest[] = [];
  const server = createServer((request, response) => {
    void handleProviderRequest(request, response, requests);
  });
  let agentSession: AgentSession | undefined;
  try {
    const baseUrl = await listen(server);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(parent, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(parent, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    modelRuntime.registerProvider("fixture", {
      name: "Fixture",
      api: "openai-completions",
      apiKey: "fixture-key",
      baseUrl,
      models: [
        {
          id: "model",
          name: "Fixture model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_000,
          maxTokens: 1_000,
        },
      ],
    });
    const model = modelRuntime.getModel("fixture", "model");
    assert.ok(model !== undefined);
    const sessionManager = SessionManager.inMemory(parent);
    sessionManager.appendCustomMessageEntry("pi-workgraph-objective", objective, false, {
      ...attempt,
      mode: "implementation",
    });
    sessionManager.appendCustomEntry("pi-workgraph-worker-plan", {
      ...attempt,
      plan: initialPlan,
    });
    sessionManager.appendCustomEntry("pi-workgraph-worker-state", {
      ...attempt,
      phase: "executor",
    });
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: parent,
      agentDir: join(parent, "agent"),
      settingsManager,
      additionalExtensionPaths: [resolve("extensions/worker.ts")],
      noContextFiles: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      systemPrompt: "Provider-bound fixture",
    });
    await resourceLoader.reload();
    const created = await createAgentSession({
      cwd: parent,
      agentDir: join(parent, "agent"),
      modelRuntime,
      model,
      tools: ["workgraph_plan"],
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    agentSession = created.session;
    await agentSession.bindExtensions({});

    await agentSession.prompt("First turn");
    await agentSession.prompt("Second turn: update the bounded plan");

    assert.equal(requests.length, 3);
    const [first, second, third] = requests;
    if (first === undefined || second === undefined || third === undefined)
      throw new Error("Fixture did not capture three provider requests");

    const firstJson = JSON.stringify(first);
    assert.match(firstJson, /\[WORKGRAPH EXECUTOR\]/);
    assert.doesNotMatch(firstJson, /\[WORKGRAPH LOCAL PREWALK - GUIDE\]/);
    assert.ok(firstJson.includes(JSON.stringify(objective)));
    const oldPlanMessage = first.messages.findIndex((message) =>
      JSON.stringify(message).includes(initialPlan.approach),
    );
    assert.ok(oldPlanMessage >= 0);
    assert.equal(
      first.messages.findIndex((message) => JSON.stringify(message).includes(revisedPlan.approach)),
      -1,
    );

    assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
    assert.deepEqual(third.messages.slice(0, second.messages.length), second.messages);
    const newPlanMessage = third.messages.findIndex(
      (message) =>
        message.role === "tool" &&
        JSON.stringify(message).includes("Updated Current bounded plan") &&
        JSON.stringify(message).includes(revisedPlan.approach),
    );
    assert.ok(newPlanMessage > oldPlanMessage);
  } finally {
    agentSession?.dispose();
    await close(server);
    restoreFixtureEnvironment(previous);
    await rm(parent, { recursive: true, force: true });
  }
});
