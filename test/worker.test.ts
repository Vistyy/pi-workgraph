import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Worker fixtures exercise real Git repositories and session files.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Fixture paths identify real repository and session resources.
import { join } from "node:path";
import test from "node:test";
import type { ExtensionActions, SessionManager } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { configureFixtureEnvironment, restoreFixtureEnvironment } from "./decoders.js";
import { extensionFixture, git, usage } from "./helpers.js";

const timestamp = 1_788_235_200_000;
const todo: Array<{
  id: string;
  text: string;
  validation: string;
  status: "pending" | "in_progress" | "done" | "blocked";
  note?: string;
}> = [
  {
    id: "implement",
    text: "Implement the authorized worker change.",
    validation: "The focused worker behavior passes.",
    status: "pending" as const,
  },
  {
    id: "verify",
    text: "Verify the resulting worker flow.",
    validation: "Typecheck and worker tests pass.",
    status: "pending" as const,
  },
];

async function fixture(
  mode: "implementation" | "research" | "review" = "implementation",
  actions: Partial<ExtensionActions> = {},
) {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-worker-"));
  const root = join(parent, "repo");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "fixture@example.test");
  await git(root, "config", "user.name", "Fixture");
  await writeFile(join(root, "value.txt"), "before\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "Fixture");
  const previous = configureFixtureEnvironment({
    PI_CODING_AGENT_DIR: join(parent, "agent"),
    PI_WORKGRAPH_MODE: mode,
    PI_WORKGRAPH_POLICY_ROLE: mode,
    PI_WORKGRAPH_RUN_ID: "fixture",
    PI_WORKGRAPH_NODE_ID: "attempt",
    PI_WORKGRAPH_BASE_COMMIT: await git(root, "rev-parse", "HEAD"),
    PI_WORKGRAPH_EXECUTOR_MODEL: "openai/gpt-4o",
    PI_WORKGRAPH_EXECUTOR_THINKING: "high",
    PI_WORKGRAPH_IMPLEMENTATION_START: null,
    PI_WORKGRAPH_EXPERIMENT: null,
  });
  let activeTools = ["read", "bash", "edit", "write"];
  const pi = await extensionFixture("worker", root, parent, {
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools = [...names];
    },
    ...actions,
  });
  return {
    ...pi,
    root,
    activeTools: () => activeTools,
    async dispose() {
      await pi.close();
      restoreFixtureEnvironment(previous);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

function appendPlanResult(session: SessionManager, todos = todo) {
  session.appendMessage({
    role: "toolResult",
    toolCallId: "plan",
    toolName: "workgraph_plan",
    content: [{ type: "text", text: "TODO initialized" }],
    details: { action: "set", todos, attempt: { runId: "fixture", nodeId: "attempt" } },
    isError: false,
    timestamp,
  });
}

function appendToolResult(session: SessionManager, toolName: string, isError = false) {
  session.appendMessage({
    role: "toolResult",
    toolCallId: toolName,
    toolName,
    content: [],
    details: {},
    isError,
    timestamp,
  });
}

function assistant(session: SessionManager, model = "gpt-4o") {
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Executor continued." }],
    api: "openai-responses",
    provider: "openai",
    model,
    usage,
    stopReason: "stop",
    timestamp,
  });
}

void test("plan tool supports only strict get, set, and item update snapshots", async () => {
  const f = await fixture();
  try {
    const tool = f.runner.getToolDefinition("workgraph_plan");
    assert.ok(tool);
    assert.equal(Value.Check(tool.parameters, { action: "set", todos: todo }), true);
    assert.equal(Value.Check(tool.parameters, { action: "set", todos: [] }), false);
    assert.equal(
      Value.Check(tool.parameters, { action: "set", todos: Array(10).fill(todo[0]) }),
      false,
    );
    assert.equal(Value.Check(tool.parameters, { action: "add_step", text: "obsolete" }), false);
    assert.equal(
      Value.Check(tool.parameters, {
        action: "set",
        todos: [
          {
            id: "i".repeat(65),
            text: "t".repeat(1001),
            validation: "v".repeat(1001),
            status: "pending",
            note: "n".repeat(1001),
          },
        ],
      }),
      true,
    );

    const initial = await f.call("workgraph_plan", { action: "get" });
    assert.deepEqual(initial.details, {
      action: "get",
      attempt: { runId: "fixture", nodeId: "attempt" },
    });
    const set = await f.call("workgraph_plan", { action: "set", todos: todo });
    // SAFETY: The registered tool returned the schema-owned successful set details.
    assert.deepEqual((set.details as { todos: unknown }).todos, todo);
    const updated = await f.call("workgraph_plan", {
      action: "update",
      id: "implement",
      patch: { status: "in_progress", note: "Work started." },
    });
    // SAFETY: The registered tool returned the schema-owned successful update details.
    const todos = (updated.details as { todos: typeof todo }).todos;
    assert.equal(todos[0]?.status, "in_progress");
    assert.equal(todos[0]?.note, "Work started.");
    await assert.rejects(
      f.call("workgraph_plan", { action: "update", id: "missing", patch: { status: "done" } }),
      /Unknown TODO id/,
    );
    await assert.rejects(
      f.call("workgraph_plan", { action: "set", todos: [todo[0], todo[0]] }),
      /ids must be unique/,
    );
  } finally {
    await f.dispose();
  }
});

void test("valid TODO then successful direct edit selects executor exactly once", async () => {
  const f = await fixture();
  try {
    await f.call("workgraph_plan", { action: "set", todos: todo });
    await f.runner.emit({
      type: "tool_execution_end",
      toolCallId: "plan",
      toolName: "workgraph_plan",
      result: {},
      isError: false,
    });
    await f.runner.emit({
      type: "tool_execution_end",
      toolCallId: "bash",
      toolName: "bash",
      result: {},
      isError: false,
    });
    await f.runner.emit({
      type: "tool_execution_end",
      toolCallId: "edit-failed",
      toolName: "edit",
      result: {},
      isError: true,
    });
    await f.runner.emit({
      type: "tool_execution_end",
      toolCallId: "write-failed",
      toolName: "write",
      result: {},
      isError: true,
    });
    assert.deepEqual(f.selected, []);
    await f.runner.emit({
      type: "tool_execution_end",
      toolCallId: "edit",
      toolName: "edit",
      result: {},
      isError: false,
    });
    assert.deepEqual(f.selected, ["openai/gpt-4o"]);
    assert.equal(
      f.session
        .getBranch()
        .filter(
          (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-executor-start",
        ).length,
      1,
    );
    await f.runner.emit({
      type: "tool_execution_end",
      toolCallId: "write",
      toolName: "write",
      result: {},
      isError: false,
    });
    assert.deepEqual(f.selected, ["openai/gpt-4o"]);
  } finally {
    await f.dispose();
  }
});

void test("successful direct edit then valid TODO also selects executor", async () => {
  const f = await fixture();
  try {
    await f.runner.emit({
      type: "tool_execution_end",
      toolCallId: "write",
      toolName: "write",
      result: {},
      isError: false,
    });
    assert.deepEqual(f.selected, []);
    await f.call("workgraph_plan", { action: "set", todos: todo });
    await f.runner.emit({
      type: "tool_execution_end",
      toolCallId: "plan",
      toolName: "workgraph_plan",
      result: {},
      isError: false,
    });
    assert.deepEqual(f.selected, ["openai/gpt-4o"]);
  } finally {
    await f.dispose();
  }
});

void test("recovery derives TODO, edit, and executor phase from persisted trajectory", async () => {
  const f = await fixture();
  try {
    appendPlanResult(f.session);
    appendToolResult(f.session, "write");
    f.session.appendCustomEntry("pi-workgraph-executor-start", {
      runId: "fixture",
      nodeId: "attempt",
    });
    await f.runner.emit({ type: "session_start", reason: "reload" });
    const context = await f.runner.emitBeforeAgentStart("continue", undefined, "Fixture", {
      cwd: f.root,
    });
    assert.match(context?.systemPrompt ?? "", /IMPLEMENTATION EXECUTOR POLICY/);
    assert.doesNotMatch(context?.systemPrompt ?? "", /GUIDE POLICY/);
    const restored = await f.call("workgraph_plan", { action: "get" });
    // SAFETY: The restored get result passed through the registered plan tool boundary.
    assert.deepEqual((restored.details as { todos: unknown }).todos, todo);
    await f.runner.emit({
      type: "tool_execution_end",
      toolCallId: "write-again",
      toolName: "write",
      result: {},
      isError: false,
    });
    assert.deepEqual(f.selected, []);
    const repeated = await f.runner.emitBeforeAgentStart("continue", undefined, "Fixture", {
      cwd: f.root,
    });
    assert.equal(repeated?.systemPrompt, context?.systemPrompt);
  } finally {
    await f.dispose();
  }
});

void test("reattach resolves durable TODO and edit evidence before the next model request", async () => {
  const f = await fixture();
  try {
    appendPlanResult(f.session);
    appendToolResult(f.session, "write");
    await f.runner.emit({ type: "session_start", reason: "reload" });
    assert.deepEqual(f.selected, ["openai/gpt-4o"]);
    assert.equal(
      f.session
        .getBranch()
        .filter(
          (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-executor-start",
        ).length,
      1,
    );
    const context = await f.runner.emitBeforeAgentStart("continue", undefined, "Fixture", {
      cwd: f.root,
    });
    assert.match(context?.systemPrompt ?? "", /IMPLEMENTATION EXECUTOR POLICY/);
    assert.doesNotMatch(context?.systemPrompt ?? "", /GUIDE POLICY/);
  } finally {
    await f.dispose();
  }
});

void test("recovered executor selection failure emits one diagnostic and is never retried", async () => {
  let session: SessionManager | undefined;
  let selectionCalls = 0;
  const f = await fixture("implementation", {
    async setModel() {
      selectionCalls += 1;
      return false;
    },
    sendMessage(message) {
      session?.appendCustomMessageEntry(
        message.customType,
        message.content,
        message.display,
        message.details,
      );
    },
  });
  session = f.session;
  try {
    appendPlanResult(f.session);
    appendToolResult(f.session, "edit");
    await f.runner.emit({ type: "session_start", reason: "reload" });
    assert.equal(selectionCalls, 1);
    assert.equal(
      f.session
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom_message" && entry.customType === "pi-workgraph-executor-failure",
        ).length,
      1,
    );
    await f.runner.emit({ type: "session_start", reason: "reload" });
    assert.equal(selectionCalls, 1);
    assert.equal(f.activeTools().includes("edit"), false);
    assert.equal(f.activeTools().includes("write"), false);
    await f.runner.emit({
      type: "tool_execution_end",
      toolCallId: "again",
      toolName: "edit",
      result: {},
      isError: false,
    });
    assert.equal(selectionCalls, 1);
    const context = await f.runner.emitBeforeAgentStart("continue", undefined, "Fixture", {
      cwd: f.root,
    });
    assert.match(context?.systemPrompt ?? "", /IMPLEMENTATION GUIDE POLICY/);
    const failed = await f.call("workgraph_report", {
      kind: "implementation",
      status: "failed",
      summary: "Executor unavailable.",
      evidence: [],
      findings: [],
    });
    assert.equal(failed.terminate, true);
  } finally {
    session = undefined;
    await f.dispose();
  }
});

void test("guide no-change and changed executor completion retain their report boundaries", async () => {
  const guide = await fixture();
  try {
    const revision = await git(guide.root, "rev-parse", "HEAD");
    const result = await guide.call("workgraph_report", {
      kind: "implementation",
      status: "completed",
      outcome: "no_change",
      summary: "Already correct.",
      revision,
      reason: "Inspected base already satisfies the requirement.",
      evidence: [],
      findings: [],
    });
    assert.equal(result.terminate, true);
    assert.deepEqual(guide.selected, []);
  } finally {
    await guide.dispose();
  }

  const executor = await fixture();
  try {
    await executor.call("workgraph_plan", { action: "set", todos: todo });
    await writeFile(join(executor.root, "value.txt"), "after\n");
    await executor.runner.emit({
      type: "tool_execution_end",
      toolCallId: "write",
      toolName: "write",
      result: {},
      isError: false,
    });
    await git(executor.root, "add", ".");
    await git(executor.root, "commit", "-m", "Changed value");
    await assert.rejects(
      executor.call("workgraph_report", {
        kind: "implementation",
        status: "completed",
        outcome: "changed",
        summary: "Changed.",
        evidence: [],
        findings: [],
      }),
      /executor assistant message/,
    );
    assistant(executor.session);
    const result = await executor.call("workgraph_report", {
      kind: "implementation",
      status: "completed",
      outcome: "changed",
      summary: "Changed.",
      evidence: [],
      findings: [],
    });
    assert.equal(result.terminate, true);
    assert.equal(await readFile(join(executor.root, "value.txt"), "utf8"), "after\n");
  } finally {
    await executor.dispose();
  }
});

void test("bounded incomplete-TODO reminders settle and blocked TODO does not loop", async () => {
  const sent: string[] = [];
  const f = await fixture("implementation", {
    sendMessage(message) {
      sent.push(message.customType);
    },
  });
  try {
    await f.call("workgraph_plan", { action: "set", todos: todo });
    await f.runner.emit({
      type: "tool_execution_end",
      toolCallId: "edit",
      toolName: "edit",
      result: {},
      isError: false,
    });
    await f.runner.emit({ type: "agent_settled" });
    await f.runner.emit({ type: "agent_settled" });
    await f.runner.emit({ type: "agent_settled" });
    assert.equal(sent.filter((type) => type === "pi-workgraph-reconciliation").length, 2);
  } finally {
    await f.dispose();
  }

  const blockedSent: string[] = [];
  const blocked = await fixture("implementation", {
    sendMessage(message) {
      blockedSent.push(message.customType);
    },
  });
  try {
    await blocked.call("workgraph_plan", {
      action: "set",
      todos: [{ ...todo[0], status: "blocked" }],
    });
    await blocked.runner.emit({
      type: "tool_execution_end",
      toolCallId: "edit",
      toolName: "edit",
      result: {},
      isError: false,
    });
    await blocked.runner.emit({ type: "agent_settled" });
    assert.deepEqual(blockedSent, []);
  } finally {
    await blocked.dispose();
  }
});

void test("read-only workers hide plans and editing tools", async () => {
  for (const mode of ["research", "review"] as const) {
    const f = await fixture(mode);
    try {
      await f.runner.emit({ type: "session_start", reason: "startup" });
      assert.equal(f.runner.getToolDefinition("workgraph_plan"), undefined);
      assert.equal(f.activeTools().includes("edit"), false);
      assert.equal(f.activeTools().includes("write"), false);
    } finally {
      await f.dispose();
    }
  }
});
