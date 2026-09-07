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
  steps: [
    { id: "step-1", text: "Inspect the provider transcript fixture.", status: "done" as const },
    {
      id: "step-2",
      text: "Confirm the serialized prefix stays stable.",
      status: "blocked" as const,
    },
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
const objective =
  "[WORKGRAPH IMPLEMENTATION OBJECTIVE]\nAcceptance: preserve the exact objective.\nConstraints: stay within the isolated worktree.";
const attempt = { runId: "fixture", nodeId: "attempt" };
type SerializedRequest = Static<typeof serializedRequestSchema>;
type ProviderEnvelope = { messages: unknown[]; tools?: unknown };
const providerToolResultSchema = Type.Object(
  { tool_call_id: Type.String() },
  { additionalProperties: true },
);

function targetedArguments(index: number) {
  if (index === 2)
    return {
      action: "update_step",
      id: "step-1",
      patch: { note: "Executor records progress in notes." },
    };
  if (index === 3)
    return {
      action: "add_step",
      text: "Record the second targeted mutation.",
      after_id: "step-1",
    };
  if (index === 4)
    return {
      action: "update_step",
      id: "step-3",
      patch: { status: "done" },
    };
  if (index === 5)
    return {
      action: "remove_step",
      id: "step-2",
      reason: "Superseded by the narrower recorded step.",
    };
  return undefined;
}

function providerResponse(index: number): string {
  const targeted = targetedArguments(index);
  const delta =
    targeted === undefined
      ? { role: "assistant", content: "done" }
      : {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `plan-call-${index}`,
              type: "function",
              function: {
                name: "workgraph_plan",
                arguments: JSON.stringify(targeted),
              },
            },
          ],
        };
  const toolCall = targeted !== undefined;
  const chunks = [
    { delta, finish_reason: null, usage: undefined },
    {
      delta: {},
      finish_reason: toolCall ? "tool_calls" : "stop",
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ].map(({ delta, finish_reason, usage }) => {
    const chunk = {
      id: `fixture-${index}`,
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason }],
    };
    if (usage === undefined) return chunk;
    return { ...chunk, usage };
  });
  const events = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
  return `${events.join("")}data: [DONE]\n\n`;
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
  rawRequests: string[],
): Promise<void> {
  try {
    const raw = await requestBody(request);
    const parsed: unknown = JSON.parse(raw);
    if (!Value.Check(serializedRequestSchema, parsed)) {
      response.writeHead(400);
      response.end();
      return;
    }
    const body = Value.Decode(serializedRequestSchema, parsed);
    requests.push(body);
    rawRequests.push(raw);
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
      connection: "keep-alive",
    });
    response.end(providerResponse(requests.length));
  } catch {
    response.destroy();
  }
}

void test("worker requests keep the serialized provider prefix stable across turns and targeted edits", async () => {
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
  const rawRequests: string[] = [];
  const server = createServer((request, response) => {
    void handleProviderRequest(request, response, requests, rawRequests);
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
    await agentSession.prompt("Second turn: apply targeted step edits");

    assert.equal(requests.length, 6);
    assert.equal(rawRequests.length, 6);
    const [first, second, third, fourth, fifth, sixth] = requests;
    if (
      first === undefined ||
      second === undefined ||
      third === undefined ||
      fourth === undefined ||
      fifth === undefined ||
      sixth === undefined
    )
      throw new Error("Fixture did not capture six provider requests");

    const firstJson = JSON.stringify(first);
    assert.match(firstJson, /\[WORKGRAPH EXECUTOR\]/);
    assert.doesNotMatch(firstJson, /\[WORKGRAPH LOCAL PREWALK - GUIDE\]/);
    assert.ok(firstJson.includes(JSON.stringify(objective)));
    const oldPlanMessage = first.messages.findIndex((message) =>
      JSON.stringify(message).includes(initialPlan.approach),
    );
    assert.ok(oldPlanMessage >= 0);

    const rawBodies = rawRequests.map((raw) => {
      // SAFETY: rawRequests are JSON bodies captured from the isolated local provider fixture.
      return JSON.parse(raw) as ProviderEnvelope;
    });
    const firstBody = rawBodies[0];
    assert.ok(firstBody !== undefined);
    const serializedTools = JSON.stringify(firstBody.tools);
    const serializedSystem = JSON.stringify(firstBody.messages[0]);
    assert.match(serializedSystem, /"role":"system"/);
    assert.match(serializedTools, /workgraph_plan/);
    const rawMessages = rawBodies.map((body) => body.messages);
    for (let index = 0; index < rawBodies.length; index += 1) {
      const body = rawBodies[index];
      const messages = rawMessages[index];
      assert.ok(body !== undefined && messages !== undefined);
      assert.equal(JSON.stringify(body.tools), serializedTools);
      assert.equal(JSON.stringify(messages[0]), serializedSystem);
      if (index === 0) continue;
      const previous = rawMessages[index - 1];
      assert.ok(previous !== undefined);
      assert.ok(messages.length >= previous.length);
      assert.deepEqual(messages.slice(0, previous.length), previous);
    }
    const sixthJson = JSON.stringify(rawBodies[5]);
    assert.ok(sixthJson.includes(initialPlan.approach));
    const toolResult = (index: number, callId: string): string => {
      const found = rawMessages[index]?.find(
        (message) =>
          Value.Check(providerToolResultSchema, message) &&
          Value.Decode(providerToolResultSchema, message).tool_call_id === callId,
      );
      assert.ok(found !== undefined, `Missing tool result ${callId}`);
      return JSON.stringify(found);
    };
    assert.match(toolResult(2, "plan-call-2"), /Executor records progress in notes/);
    assert.match(toolResult(3, "plan-call-3"), /Record the second targeted mutation/);
    assert.match(toolResult(4, "plan-call-4"), /step-3 done/);
    assert.match(toolResult(5, "plan-call-5"), /Superseded by the narrower recorded step/);
  } finally {
    agentSession?.dispose();
    await close(server);
    restoreFixtureEnvironment(previous);
    await rm(parent, { recursive: true, force: true });
  }
});
