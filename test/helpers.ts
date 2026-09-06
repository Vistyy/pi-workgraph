import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionActions } from "@earendil-works/pi-coding-agent";
import {
  discoverAndLoadExtensions,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { runProcess } from "../src/git.js";
import type { WorkerReport } from "../src/types.js";
import { WorkstreamStateSchema } from "../src/workstream.js";

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
  session.appendMessage({
    role: "user",
    content: "Fixture request",
    timestamp: Date.now(),
  });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Ready" }],
    api: "test",
    provider: "test",
    model: "fixture",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  });
  return session;
}

/** Real Pi registration/context machinery; only session actions are replaced, never a model call. */
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
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    root,
    session,
    registry,
  );
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
        notifications.push(
          type === undefined ? { message } : { message, type },
        );
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
    async call(toolName: string, params: unknown) {
      const tool = runner.getToolDefinition(toolName);
      assert.ok(tool, `Missing registered tool ${toolName}`);
      assert.ok(
        Value.Check(tool.parameters, params),
        `Invalid fixture input to ${toolName}`,
      );
      return tool.execute(
        "fixture",
        params,
        undefined,
        undefined,
        runner.createContext(),
      );
    },
    async close() {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      assert.deepEqual(errors, []);
    },
  };
}

export function resultState(details: unknown) {
  assert.ok(details && typeof details === "object");
  const record = details as { workstream?: unknown; statePath?: unknown };
  const state =
    record.workstream ??
    (typeof record.statePath === "string"
      ? JSON.parse(readFileSync(record.statePath, "utf8"))
      : undefined);
  assert.ok(Value.Check(WorkstreamStateSchema, state));
  return state;
}
