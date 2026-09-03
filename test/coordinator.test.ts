import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import coordinator from "../extensions/coordinator.js";

test("a workgraph_begin tool batch gates sibling writes before tool execution", async () => {
  const handlers = new Map<string, Array<(event: any, ctx?: any) => any>>();
  const fakePi = {
    registerTool() {},
    on(name: string, handler: (event: any, ctx?: any) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  coordinator(fakePi);

  const messageEnd = handlers.get("message_end")![0]!;
  await messageEnd({
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "edit-first", name: "edit", arguments: { path: "src/a.ts" } },
        { type: "toolCall", id: "begin-second", name: "workgraph_begin", arguments: {} },
      ],
    },
  });
  const toolCall = handlers.get("tool_call")![0]!;
  const blocked = await toolCall({ toolName: "edit", input: { path: "src/a.ts" } });
  assert.match(blocked.reason, /coordinator read-only/);
  const destructiveFind = await toolCall({ toolName: "bash", input: { command: "find src -delete" } });
  assert.match(destructiveFind.reason, /read-only coordinator shell/);
});
