import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This exact Node, Pi, or live smoke boundary preserves its native callback and payload contract; validation remains in the boundary body.
import { readFileSync } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This exact Node, Pi, or live smoke boundary preserves its native callback and payload contract; validation remains in the boundary body.
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { processEffect } from "../src/process.js";
import type { WorkerReport } from "../src/types.js";
import { WorkstreamStateSchema } from "../src/workstream.js";
import { isNativeSqliteFile } from "../src/workstream-persistence.js";
import { parsePersistedObject } from "../src/workstream-validation.js";

const ResultDetailsSchema = Type.Object({
  workstream: Type.Optional(WorkstreamStateSchema),
  statePath: Type.Optional(Type.String()),
});
const PersistedSqliteRowSchema = Type.Object({ state_json: Type.String() });

export const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
export function researchReport(summary = "Evidence found."): WorkerReport {
  return {
    kind: "research",
    status: "completed",
    summary,
    evidence: [],
    findings: [],
  };
}

// oxlint-disable-next-line effecttsgo/async-function -- This exact Node, Pi, or live smoke boundary preserves its native callback and payload contract; validation remains in the boundary body.
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await Effect.runPromise(
    processEffect("git", ["-C", cwd, ...args], {
      cwd,
      timeoutMs: 30_000,
    }),
  );
  assert.equal(result.exitCode, 0, result.stderr);
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
// oxlint-disable-next-line effecttsgo/async-function -- This exact Node, Pi, or live smoke boundary preserves its native callback and payload contract; validation remains in the boundary body.
export async function extensionFixture(
  name: "coordinator" | "worker",
  root: string,
  parent: string,
  actions: Partial<ExtensionActions> = {},
  extensionFactories: InlineExtension[] = [],
) {
  const session = persistentSession(root, join(parent, "sessions"));
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(parent, "agent"),
    additionalExtensionPaths:
      extensionFactories.length === 0 ? [resolve(`extensions/${name}.ts`)] : [],
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
      getAllTools: () => [
        ...["read", "bash", "edit", "write"].map((name) => ({
          name,
          description: "Fixture built-in tool",
          parameters: Type.Object({}),
          sourceInfo: {
            path: `<builtin:${name}>`,
            source: "builtin",
            scope: "temporary" as const,
            origin: "top-level" as const,
          },
        })),
        ...runner.getAllRegisteredTools().map(({ definition, sourceInfo }) => {
          const info: ReturnType<ExtensionActions["getAllTools"]>[number] = {
            name: definition.name,
            description: definition.description,
            parameters: definition.parameters,
            sourceInfo,
          };
          if (definition.promptGuidelines !== undefined)
            info.promptGuidelines = definition.promptGuidelines;
          return info;
        }),
      ],
      setThinkingLevel: (next) => {
        level = next;
      },
      // oxlint-disable-next-line effecttsgo/async-function -- This exact Node, Pi, or live smoke boundary preserves its native callback and payload contract; validation remains in the boundary body.
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
      const tool = runner.getToolDefinition(toolName);
      assert.ok(tool !== undefined, `Missing registered tool ${toolName}`);
      assert.ok(Value.Check(tool.parameters, params), `Invalid fixture input to ${toolName}`);
      // SAFETY: Pi's registered definition erases its concrete schema generic, but Value.Check above validates this value against the exact runtime schema.
      const decoded = Value.Decode(tool.parameters, params);
      return tool.execute("fixture", decoded, signal, undefined, runner.createContext());
    },
    // oxlint-disable-next-line effecttsgo/async-function -- This exact Node, Pi, or live smoke boundary preserves its native callback and payload contract; validation remains in the boundary body.
    async close() {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      assert.deepEqual(errors, []);
    },
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Pi tool result details are external input and are decoded immediately against their domain schema.
export function resultState(details: unknown) {
  assert.ok(Value.Check(ResultDetailsSchema, details), "Invalid Pi tool result details");
  const record = Value.Decode(ResultDetailsSchema, details);
  const persisted: unknown =
    record.statePath === undefined ? undefined : readPersistedState(record.statePath);
  const state = record.workstream ?? persisted;
  assert.ok(Value.Check(WorkstreamStateSchema, state));
  return Value.Decode(WorkstreamStateSchema, state);
}

function readPersistedState(path: string): Static<typeof WorkstreamStateSchema> {
  let value: ReturnType<typeof parsePersistedObject>;
  if (!isNativeSqliteFile(path)) value = parsePersistedObject(readFileSync(path, "utf8"));
  else {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const row = database
        .prepare("SELECT state_json FROM workstream_state WHERE singleton=1")
        .get();
      if (!Value.Check(PersistedSqliteRowSchema, row))
        throw new Error("Missing persisted SQLite aggregate.");
      value = parsePersistedObject(Value.Decode(PersistedSqliteRowSchema, row).state_json);
    } finally {
      database.close();
    }
  }
  assert.ok(Value.Check(WorkstreamStateSchema, value), "Invalid persisted workstream state");
  return Value.Decode(WorkstreamStateSchema, value);
}
