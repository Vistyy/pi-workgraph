import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildChildArguments, forkSession, runPiChild, stableParentEntry } from "../src/pi-process.js";

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

test("normal child arguments retain the process defaults and explicit assignment model", () => {
  const args = buildChildArguments({ mode: "discovery", guideModel: "provider/model", guideThinking: "high" }, "/tmp/session.jsonl", []);
  assert.deepEqual(args, ["--mode", "json", "--print", "--session", "/tmp/session.jsonl", "--model", "provider/model", "--thinking", "high", "Continue the assigned Workgraph objective now."]);
  assert.equal(args.some((arg) => arg.includes("extensions") || arg.includes("tools") || arg.includes("prompt")), false);
});

test("a prose-only child result is retained as untyped terminal evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workgraph-prose-child-"));
  const previous = process.env.PI_WORKGRAPH_PI_BIN;
  try {
    const fakePi = join(root, "fake-pi.sh");
    await writeFile(fakePi, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Useful final prose\"}]}}'",
    ].join("\n"), { mode: 0o755 });
    process.env.PI_WORKGRAPH_PI_BIN = fakePi;
    const parent = SessionManager.create(root, join(root, "parent"));
    parent.appendMessage({ role: "user", content: "Evidence objective", timestamp: Date.now() });
    parent.appendMessage({ role: "assistant", content: [{ type: "text", text: "Ready." }], api: "openai-responses", provider: "provider", model: "model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
    const parentFile = parent.getSessionFile();
    assert.ok(parentFile);
    const outcome = await runPiChild({ parentSessionFile: parentFile, targetCwd: root, sessionDir: join(root, "children"), objective: "Inspect evidence.", mode: "discovery", guideModel: "provider/model", guideThinking: "high", runId: "run", nodeId: "child" });
    assert.equal(outcome.resultKind, "untyped");
    assert.equal(outcome.terminalText, "Useful final prose");
    assert.equal(outcome.report, undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_WORKGRAPH_PI_BIN;
    else process.env.PI_WORKGRAPH_PI_BIN = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a completed child outcome retains its resolved capability selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workgraph-capability-child-"));
  const previous = process.env.PI_WORKGRAPH_PI_BIN;
  try {
    const fakePi = join(root, "fake-pi.sh");
    await writeFile(fakePi, "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"agent_end\"}'\n", { mode: 0o755 });
    process.env.PI_WORKGRAPH_PI_BIN = fakePi;
    const parent = SessionManager.create(root, join(root, "parent"));
    parent.appendMessage({ role: "user", content: "Evidence objective", timestamp: Date.now() });
    parent.appendMessage({ role: "assistant", content: [{ type: "text", text: "Ready." }], api: "openai-responses", provider: "provider", model: "model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
    const parentFile = parent.getSessionFile();
    assert.ok(parentFile);
    const capabilities = [{ id: "web_access" as const, packageSource: "npm:pi-web-access@0.14.0", resourceIdentity: "pi-web-access:./index.ts", version: "0.14.0", tools: ["web_search", "source_check", "fetch_content", "get_search_content"], available: true }];
    const outcome = await runPiChild({ parentSessionFile: parentFile, targetCwd: root, sessionDir: join(root, "children"), objective: "Inspect evidence.", mode: "discovery", guideModel: "provider/model", guideThinking: "high", runId: "run", nodeId: "child", capabilities });
    assert.deepEqual(outcome.capabilities, capabilities);
  } finally {
    if (previous === undefined) delete process.env.PI_WORKGRAPH_PI_BIN;
    else process.env.PI_WORKGRAPH_PI_BIN = previous;
    await rm(root, { recursive: true, force: true });
  }
});
