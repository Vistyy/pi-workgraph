import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import coordinator, { deliverCoordinatorWake } from "../extensions/coordinator.js";
import type { CoordinatorWakeRecord, WorkgraphRun } from "../src/types.js";

test("coordinator wakes use the always-triggering extension user-message path", () => {
  const calls: Array<{ content: string; options: unknown }> = [];
  const fakePi = {
    sendUserMessage(content: string, options: unknown) { calls.push({ content, options }); },
    sendMessage() { throw new Error("custom messages must not deliver coordinator wakes"); },
  } as any;
  const fakeContext = {
    sessionManager: {
      getSessionId: () => "coordinator-session",
      getSessionFile: () => "/tmp/coordinator.jsonl",
    },
  } as any;
  const run = {
    runId: "run-1",
    composedCommit: "commit-1",
    coordinator: { sessionId: "coordinator-session", sessionFile: "/tmp/coordinator.jsonl" },
  } as WorkgraphRun;
  const wake = {
    id: "settle:commit-1",
    boundaryRevision: "revision-1",
    kind: "settle",
  } as CoordinatorWakeRecord;

  deliverCoordinatorWake(fakePi, fakeContext, wake, run);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.options, { deliverAs: "followUp" });
  assert.match(calls[0]?.content ?? "", /^\[WORKGRAPH AUTOMATIC EXTENSION CONTINUATION\]/);
  for (const phrase of ["automatically", "not a human message", "human approval", "envelope change", "assurance judgment", "completion decision"]) {
    assert.match(calls[0]?.content ?? "", new RegExp(phrase, "i"));
  }
});

test("coordinator wake delivery rejects a session identity mismatch before calling Pi", () => {
  let deliveries = 0;
  const fakePi = { sendUserMessage() { deliveries += 1; } } as any;
  const fakeContext = {
    sessionManager: {
      getSessionId: () => "different-session",
      getSessionFile: () => "/tmp/coordinator.jsonl",
    },
  } as any;
  const run = {
    runId: "run-1",
    composedCommit: "commit-1",
    coordinator: { sessionId: "coordinator-session", sessionFile: "/tmp/coordinator.jsonl" },
  } as WorkgraphRun;
  const wake = { id: "settle:commit-1", boundaryRevision: "revision-1", kind: "settle" } as CoordinatorWakeRecord;

  assert.throws(() => deliverCoordinatorWake(fakePi, fakeContext, wake, run), /does not match/);
  assert.equal(deliveries, 0);
});

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

    assert.ok(tools.includes("workgraph_research"));
    assert.ok(tools.includes("workgraph_acknowledge"));
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
