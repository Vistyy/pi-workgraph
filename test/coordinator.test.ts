import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import coordinator from "../extensions/coordinator.js";

test("the coordinator exposes only conversational capability tools", async () => {
  const prior = process.env.PI_WORKGRAPH_MODE;
  delete process.env.PI_WORKGRAPH_MODE;
  const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>();
  const tools: string[] = [];
  const fakePi = {
    registerTool(tool: { name: string }) { tools.push(tool.name); },
    on(name: string, handler: (event: unknown, ctx?: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  } as unknown as ExtensionAPI;
  coordinator(fakePi);
  assert.deepEqual(tools.sort(), [
    "workgraph_acknowledge",
    "workgraph_adopt",
    "workgraph_begin",
    "workgraph_complete",
    "workgraph_control",
    "workgraph_disposition",
    "workgraph_fork",
    "workgraph_implement",
    "workgraph_intent",
    "workgraph_research",
    "workgraph_review",
    "workgraph_status",
  ]);
  assert.ok(handlers.has("input"));
  const policy = await handlers.get("before_agent_start")![0]!({}, {});
  assert.match((policy as { message: { content: string } }).message.content, /coordinator interprets human authority and judges evidence/i);
  if (prior === undefined) delete process.env.PI_WORKGRAPH_MODE;
  else process.env.PI_WORKGRAPH_MODE = prior;
});
