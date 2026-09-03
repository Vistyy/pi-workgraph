import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { forkSession, stableParentEntry } from "../src/pi-process.js";

test("forkSession branches before an unresolved parent tool call and carries the objective", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workgraph-session-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent"));
    const user: UserMessage = { role: "user", content: "Original request", timestamp: Date.now() };
    const userId = parent.appendMessage(user);
    const assistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "workgraph_execute", arguments: {} }],
      api: "openai-responses",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
    parent.appendMessage(assistant);
    assert.equal(stableParentEntry(parent), userId);

    const parentFile = parent.getSessionFile();
    assert.ok(parentFile);
    const childFile = await forkSession({
      parentSessionFile: parentFile,
      targetCwd: root,
      sessionDir: join(root, "children"),
      objective: "Change only src/a.ts.",
      mode: "implementation",
      runId: "run-1",
      nodeId: "alpha",
    });
    const childContext = SessionManager.open(childFile).buildSessionContext().messages;
    assert.equal(childContext.some((message) => message.role === "assistant"), false);
    const objective = childContext.find((message) => message.role === "custom");
    assert.ok(objective && objective.role === "custom");
    assert.match(typeof objective.content === "string" ? objective.content : "", /Change only src\/a\.ts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
