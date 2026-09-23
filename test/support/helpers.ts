import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionActions } from "@earendil-works/pi-coding-agent";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  type InlineExtension,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Clock, Effect } from "effect";
import { Value } from "typebox/value";
import type { ModelPolicy } from "../../src/coordinator/model-policy.js";

const execFilePromise = promisify(execFile);

export const fixturePolicy: ModelPolicy = {
  roles: {
    research: [
      { model: "fixture/research", thinking: "high" },
      { model: "fixture/research-2", thinking: "medium" },
    ],
    review: [
      { model: "fixture/review", thinking: "high" },
      { model: "fixture/review-2", thinking: "low" },
    ],
    "implementation.guide": { model: "fixture/guide", thinking: "high" },
    "implementation.executor": { model: "fixture/executor", thinking: "xhigh" },
    "consultation.advisor": { model: "fixture/advisor", thinking: "low" },
  },
};

export const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// oxlint-disable-next-line effecttsgo/async-function -- Real Git fixture setup exposes the native Promise returned by execFile.
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFilePromise("git", ["-C", cwd, ...args], { cwd });

  return result.stdout.trim();
}

export function persistentSession(root: string, sessionDir: string) {
  const session = SessionManager.create(root, sessionDir);
  const timestamp = Effect.runSync(Clock.currentTimeMillis);
  session.appendMessage({
    role: "user",
    content: "Fixture request",
    timestamp,
  });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Ready" }],
    api: "test",
    provider: "test",
    model: "fixture",
    usage,
    stopReason: "stop",
    timestamp,
  });

  return session;
}

/** Real Pi registration/context machinery; only session actions are replaced, never a model call. */
// oxlint-disable-next-line effecttsgo/async-function -- Pi resource and model loading expose native Promise boundaries.
export async function extensionFixture(
  name: "coordinator" | "worker",
  root: string,
  parent: string,
  actions: Partial<ExtensionActions> = {},
  extensionFactories: InlineExtension[] = [],
  sessionOverride?: SessionManager,
) {
  const session = sessionOverride ?? persistentSession(root, join(parent, "sessions"));
  await mkdir(join(parent, "agent", "workgraph"), { recursive: true });
  await writeFile(
    join(parent, "agent", "workgraph", "models.json"),
    `${JSON.stringify(fixturePolicy)}\n`,
    { mode: 0o600 },
  );

  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(parent, "agent"),
    additionalExtensionPaths:
      extensionFactories.length === 0
        ? [resolve(name === "coordinator" ? "extensions/coordinator.ts" : "extensions/worker.ts")]
        : [],
    extensionFactories,
    noExtensions: extensionFactories.length > 0,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

  await resourceLoader.reload();
  const loaded = resourceLoader.getExtensions();
  assert.deepEqual(loaded.errors, []);

  const models = await ModelRuntime.create({
    authPath: join(parent, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(parent, "catalog.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });

  const registry = new ModelRegistry(models);
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, session, registry);

  const fixtureToolNames = [
    "workgraph_attempt",
    "workgraph_checkout",
    "workgraph_consult",
    "workgraph_control",
    "workgraph_experiment",
    "workgraph_implement",
    "workgraph_inspect",
    "workgraph_load_delivery_tools",
    "workgraph_notepad",
    "workgraph_research",
    "workgraph_review",
    "workgraph_report",
    "workgraph_plan",
  ];

  let activeToolNames = [...fixtureToolNames];
  const messages: Parameters<ExtensionActions["sendMessage"]>[0][] = [];
  const selected: string[] = [];
  let level: ReturnType<ExtensionActions["getThinkingLevel"]> = "high";
  let model = registry.getAll()[0];
  const errors: string[] = [];

  const notifications: Array<{
    message: string;
    type?: "info" | "warning" | "error";
  }> = [];

  runner.onError((error) => errors.push(error.error));
  runner.setUIContext(
    {
      ...runner.getUIContext(),
      notify(message, type) {
        notifications.push(type === undefined ? { message } : { message, type });
      },
    },
    "rpc",
  );
  runner.bindCore(
    {
      ...loaded.runtime,
      appendEntry: (type, data) => {
        session.appendCustomEntry(type, data);
      },
      sendMessage: (message) => {
        messages.push(message);
      },
      getThinkingLevel: () => level,
      getActiveTools: () => [...activeToolNames],
      setActiveTools: (names) => {
        activeToolNames = [...names];
      },
      getAllTools: () =>
        fixtureToolNames.flatMap((name) => {
          const tool = runner.getToolDefinition(name);

          return tool === undefined
            ? []
            : [
                {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                  sourceInfo: {
                    path: "fixture",
                    source: "fixture",
                    scope: "temporary" as const,
                    origin: "top-level" as const,
                  },
                },
              ];
        }),
      setThinkingLevel: (next) => {
        level = next;
      },
      // oxlint-disable-next-line effecttsgo/async-function -- ExtensionActions.setModel requires a Promise<boolean> callback.
      setModel: async (next) => {
        model = next;
        selected.push(`${next.provider}/${next.id}`);

        return true;
      },
      ...actions,
    },
    {
      getModel: () => model,
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort() {},
      hasPendingMessages: () => false,
      shutdown() {},
      getContextUsage: () => undefined,
      compact() {
        throw new Error("Unexpected compaction");
      },
      getSystemPrompt: () => "Fixture",
    },
  );

  // oxlint-disable-next-line effecttsgo/async-function -- Raw fixture input is decoded against the exact registered tool schema before execution.
  async function callWithId(
    toolCallId: string,
    toolName: string,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Value.Check and Value.Decode below parse this raw fixture input against the selected registered tool schema.
    params: unknown,
    signal?: AbortSignal,
  ) {
    const tool = runner.getToolDefinition(toolName);
    assert.ok(tool !== undefined, `Missing registered tool ${toolName}`);
    assert.ok(Value.Check(tool.parameters, params), `Invalid fixture input to ${toolName}`);
    const decoded = Value.Decode(tool.parameters, params);

    return tool.execute(toolCallId, decoded, signal, undefined, runner.createContext());
  }

  return {
    runner,
    session,
    messages,
    notifications,
    selected,
    registry,
    // oxlint-disable-next-line effecttsgo/async-function -- Genuine input is delivered through the asynchronous pinned Pi runner event boundary.
    async input(text: string, source: "interactive" | "rpc" = "interactive") {
      return runner.emitInput(text, undefined, source);
    },
    // oxlint-disable-next-line anti-slop/no-unknown-parameters, effecttsgo/async-function -- Raw input intentionally enters through Pi's registered tool boundary and is decoded against that exact registration schema before execute performs authority validation.
    async call(toolName: string, params: unknown, signal?: AbortSignal) {
      return callWithId("fixture", toolName, params, signal);
    },
    callWithId,
    // oxlint-disable-next-line effecttsgo/async-function -- The Pi shutdown event must settle before fixture errors are asserted.
    async close() {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      assert.deepEqual(errors, []);
    },
  };
}
