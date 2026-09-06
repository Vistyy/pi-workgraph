import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This exact Node, Pi, or live smoke boundary preserves its native callback and payload contract; validation remains in the boundary body.
import { readFileSync } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This exact Node, Pi, or live smoke boundary preserves its native callback and payload contract; validation remains in the boundary body.
import { join, resolve } from "node:path";
import type { ExtensionActions } from "@earendil-works/pi-coding-agent";
import {
  discoverAndLoadExtensions,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Clock, Effect } from "effect";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { runProcess } from "../src/git.js";
import type { WorkerReport } from "../src/types.js";
import { WorkstreamStateSchema } from "../src/workstream.js";

const ResultDetailsSchema = Type.Object({
  workstream: Type.Optional(WorkstreamStateSchema),
  statePath: Type.Optional(Type.String()),
});

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
  const result = await runProcess("git", ["-C", cwd, ...args], {
    cwd,
    timeoutMs: 30_000,
  });
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
) {
  const session = persistentSession(root, join(parent, "sessions"));
  const loaded = await discoverAndLoadExtensions(
    [resolve(`extensions/${name}.ts`)],
    root,
    join(parent, "agent"),
  );
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
    record.statePath === undefined ? undefined : JSON.parse(readFileSync(record.statePath, "utf8"));
  const state = record.workstream ?? persisted;
  assert.ok(Value.Check(WorkstreamStateSchema, state));
  return Value.Decode(WorkstreamStateSchema, state);
}
