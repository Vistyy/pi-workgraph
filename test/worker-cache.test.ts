import assert from "node:assert/strict";
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
import { Effect } from "effect";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { configureFixtureEnvironment, restoreFixtureEnvironment } from "./decoders.js";

const initialPlan = {
  approach: "Inspect the stable provider transcript.",
  rationale: "Keep canonical history append-only while the plan evolves in tool results.",
  risks: "A compaction boundary may omit the original snapshot.",
  steps: [
    { text: "Capture the first serialized request.", status: "pending" as const },
    { text: "Capture the plan update result.", status: "pending" as const },
  ],
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
type SerializedRequest = Static<typeof serializedRequestSchema>;

function textResponse(index: number, text: string): string {
  const id = `fixture-${index}`;
  const chunks = [
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
  ];
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

function planToolResponse(index: number): string {
  const id = `fixture-${index}`;
  const arguments_ = JSON.stringify({ action: "update", plan: initialPlan });
  const chunks = [
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
  ];
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
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
  await Effect.runPromise(
    Effect.callback<void, Error>((resume) => {
      const onError = (error: Error) => {
        server.off("error", onError);
        resume(Effect.fail(error));
      };
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resume(Effect.void);
      });
      return Effect.sync(() => server.off("error", onError));
    }),
  );
  const address = server.address();
  if (address === null || !Value.Check(addressSchema, address))
    throw new Error("Fixture server did not bind");
  const port = Value.Decode(addressSchema, address).port;
  return `http://127.0.0.1:${port}/v1`;
}

async function close(server: Server): Promise<void> {
  await Effect.runPromise(
    Effect.callback<void, Error>((resume) => {
      server.close((error) => resume(error === undefined ? Effect.void : Effect.fail(error)));
    }),
  );
}

async function handleProviderRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: SerializedRequest[],
): Promise<void> {
  try {
    if (request.method !== "POST") {
      response.writeHead(404);
      response.end();
      return;
    }
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
        ? planToolResponse(requests.length)
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
    PI_WORKGRAPH_IMPLEMENTATION_START: "true",
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
    sessionManager.appendCustomMessageEntry(
      "pi-workgraph-objective",
      "[WORKGRAPH IMPLEMENTATION OBJECTIVE]\nAcceptance: preserve the exact objective.\nConstraints: stay within the isolated worktree.",
      false,
      { runId: "fixture", nodeId: "attempt", mode: "implementation" },
    );
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

    await agentSession.prompt("First turn");
    await agentSession.prompt("Second turn: update the bounded plan");

    assert.equal(requests.length, 3);
    assert.deepEqual(
      requests[1]?.messages.slice(0, requests[0]?.messages.length),
      requests[0]?.messages,
    );
    assert.deepEqual(
      requests[2]?.messages.slice(0, requests[1]?.messages.length),
      requests[1]?.messages,
    );
    assert.match(JSON.stringify(requests[2]), /Keep canonical history append-only/);
    assert.doesNotMatch(JSON.stringify(requests[0]), /timestamp/);
    assert.doesNotMatch(JSON.stringify(requests[1]), /timestamp/);
    assert.doesNotMatch(JSON.stringify(requests[2]), /timestamp/);
  } finally {
    agentSession?.dispose();
    await close(server);
    restoreFixtureEnvironment(previous);
    await rm(parent, { recursive: true, force: true });
  }
});
