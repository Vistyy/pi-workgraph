import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import coordinator from "../extensions/coordinator.js";

test("the coordinator registers one stable tool inventory without mutation interception", async () => {
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

  assert.deepEqual(tools, [
    "workgraph_playbook",
    "workgraph_models",
    "workgraph_begin",
    "workgraph_progress",
    "workgraph_discover",
    "workgraph_synthesize",
    "workgraph_agree",
    "workgraph_execute",
    "workgraph_verify",
    "workgraph_assure",
    "workgraph_judge",
    "workgraph_status",
  ]);
  assert.equal(handlers.has("tool_call"), false);
  assert.equal(handlers.has("message_end"), false);
  assert.equal(activeToolChanges, 0);

  const policy = await handlers.get("before_agent_start")![0]!({}, {});
  assert.match(policy.message.content, /All normal coordinator tools remain available/);
  assert.match(policy.message.content, /substantial product implementation/);
});
