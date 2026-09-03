import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("Local Prewalk blocks premature edits and switches models after the first successful edit", async () => {
  process.env.PI_WORKGRAPH_MODE = "implementation";
  process.env.PI_WORKGRAPH_RUN_ID = "run";
  process.env.PI_WORKGRAPH_NODE_ID = "alpha";
  process.env.PI_WORKGRAPH_EXECUTOR_MODEL = "provider/executor";
  process.env.PI_WORKGRAPH_EXECUTOR_THINKING = "high";
  process.env.PI_WORKGRAPH_BASE_COMMIT = "base";
  process.env.PI_WORKGRAPH_ALLOWED_PATHS = JSON.stringify(["src/a"]);

  const tools = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const entries: Array<{ type: string; data: unknown }> = [];
  const selectedModels: unknown[] = [];
  const thinkingLevels: string[] = [];
  const fakePi = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    on(name: string, handler: (event: any, ctx: any) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
    async setModel(model: unknown) { selectedModels.push(model); return true; },
    setThinkingLevel(level: string) { thinkingLevels.push(level); },
  } as unknown as ExtensionAPI;
  const extension = (await import("../extensions/worker.js")).default;
  extension(fakePi);

  const ctx = {
    cwd: "/repo",
    modelRegistry: { find: (provider: string, model: string) => ({ provider, id: model }) },
  };
  const toolCall = handlers.get("tool_call")![0]!;
  const beforeTodo = await toolCall({ toolName: "edit", input: { path: "src/a/file.ts" } }, ctx);
  assert.match(beforeTodo.reason, /TODO/);
  const destructiveFind = await toolCall({ toolName: "bash", input: { command: "find src -delete" } }, ctx);
  assert.match(destructiveFind.reason, /guide phase is read-only/);

  const todo = tools.get("workgraph_todo");
  await todo.execute("todo", { items: ["Inspect current behavior", "Implement the bounded change"] });
  const outside = await toolCall({ toolName: "edit", input: { path: "src/b/file.ts" } }, ctx);
  assert.match(outside.reason, /outside/);
  assert.equal(await toolCall({ toolName: "edit", input: { path: "src/a/file.ts" } }, ctx), undefined);

  const toolEnd = handlers.get("tool_execution_end")![0]!;
  await toolEnd({ toolName: "edit", isError: false }, ctx);
  assert.deepEqual(selectedModels, [{ provider: "provider", id: "executor" }]);
  assert.deepEqual(thinkingLevels, ["high"]);
  assert.equal(entries.some((entry) => (entry.data as { phase?: string }).phase === "executor"), true);

  const context = handlers.get("context")![0]!;
  const transformed = await context({
    messages: [
      { role: "user", content: "objective", timestamp: 1 },
      { role: "custom", customType: "pi-workgraph-guide", content: "guide", display: false, timestamp: 2 },
    ],
  }, ctx);
  assert.equal(transformed.messages.some((message: any) => message.customType === "pi-workgraph-guide"), false);
  assert.equal(transformed.messages.some((message: any) => message.customType === "pi-workgraph-executor"), true);
  assert.equal(await toolCall({ toolName: "workgraph_report", input: { status: "completed" } }, ctx), undefined);
});
