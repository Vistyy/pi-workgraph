import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import coordinator from "../extensions/coordinator.js";

test("the coordinator registers one stable tool inventory without mutation interception", async () => {
  const previous = process.env.PI_WORKGRAPH_MODE;
  delete process.env.PI_WORKGRAPH_MODE;
  try {
    const handlers = new Map<string, Array<(event: any, ctx?: any) => any>>();
    const tools: string[] = [];
    let activeToolChanges = 0;
    const fakePi = {
      registerTool(tool: { name: string }) { tools.push(tool.name); },
      on(name: string, handler: (event: any, ctx?: any) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      setActiveTools() { activeToolChanges += 1; },
    } as unknown as ExtensionAPI;
    coordinator(fakePi);

    assert.ok(tools.includes("workgraph_begin"));
    assert.ok(tools.includes("workgraph_plan"));
    assert.ok(tools.includes("workgraph_schedule"));
    assert.ok(tools.includes("workgraph_control"));
    assert.ok(tools.includes("workgraph_reconcile"));
    assert.ok(tools.includes("workgraph_settle"));
    assert.equal(handlers.has("tool_call"), false);
    assert.equal(handlers.has("message_end"), false);
    assert.equal(activeToolChanges, 0);

    const policy = await handlers.get("before_agent_start")![0]!({}, {});
    assert.match(policy.message.content, /All normal coordinator tools remain available/);
    assert.match(policy.message.content, /substantial product implementation/);
    assert.match(policy.message.content, /outcome/);
  } finally {
    if (previous === undefined) delete process.env.PI_WORKGRAPH_MODE;
    else process.env.PI_WORKGRAPH_MODE = previous;
  }
});
