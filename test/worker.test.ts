import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("assignment resources are role-aware without tool-call policing", async () => {
  const previous = process.env.PI_WORKGRAPH_MODE;
  const previousStart = process.env.PI_WORKGRAPH_IMPLEMENTATION_START;
  process.env.PI_WORKGRAPH_MODE = "implementation";
  process.env.PI_WORKGRAPH_IMPLEMENTATION_START = "guide";
  process.env.PI_WORKGRAPH_RUN_ID = "run";
  process.env.PI_WORKGRAPH_NODE_ID = "alpha";
  process.env.PI_WORKGRAPH_EXECUTOR_MODEL = "provider/executor";
  process.env.PI_WORKGRAPH_EXECUTOR_THINKING = "high";
  process.env.PI_WORKGRAPH_BASE_COMMIT = "base";

  try {
    const tools = new Map<string, any>();
    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
    const fakePi = {
      registerTool(tool: any) { tools.set(tool.name, tool); },
      appendEntry() {},
      on(name: string, handler: (event: any, ctx: any) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    } as unknown as ExtensionAPI;
    const extension = (await import("../extensions/worker.js")).default;
    extension(fakePi);

    assert.deepEqual([...tools.keys()], ["workgraph_todo", "workgraph_report"]);
    assert.equal(handlers.has("tool_call"), false);
    assert.equal(handlers.has("tool_execution_end"), true);

    const todo = tools.get("workgraph_todo");
    await todo.execute("todo", { items: ["Inspect current behavior"] });
    const report = tools.get("workgraph_report");
    assert.equal(typeof report.execute, "function");
  } finally {
    if (previous === undefined) delete process.env.PI_WORKGRAPH_MODE;
    else process.env.PI_WORKGRAPH_MODE = previous;
    delete process.env.PI_WORKGRAPH_RUN_ID;
    delete process.env.PI_WORKGRAPH_NODE_ID;
    delete process.env.PI_WORKGRAPH_EXECUTOR_MODEL;
    delete process.env.PI_WORKGRAPH_EXECUTOR_THINKING;
    delete process.env.PI_WORKGRAPH_BASE_COMMIT;
    if (previousStart === undefined) delete process.env.PI_WORKGRAPH_IMPLEMENTATION_START;
    else process.env.PI_WORKGRAPH_IMPLEMENTATION_START = previousStart;
  }
});