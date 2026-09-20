/* oxlint-disable effecttsgo/global-date -- Tests own disposable native files and protocol timestamps. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ExtensionActions, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { readWorkerSession, type WorkerObjective } from "../../src/worker/session.js";
import { configureFixtureEnvironment, restoreFixtureEnvironment } from "../support/decoders.js";
import { extensionFixture, persistentSession, usage } from "../support/helpers.js";

const defaultExecutor = { model: "openai/gpt-4o", thinking: "high" as const };

const objective: WorkerObjective = {
  content:
    "[WORKGRAPH WORKER OBJECTIVE]\nPurpose: exercise the Worker\nObjective: change only the fixture",
  details: {
    taskId: "worker",
    attemptId: "attempt",
    role: "implementation",
    executor: defaultExecutor,
  },
};

const todo = [
  {
    id: "implement",
    text: "Implement the bounded fixture change.",
    validation: "The supported Worker flow passes.",
    status: "in_progress" as const,
  },
];

const setTodo = todo.map(({ status: _status, ...item }) => item);

async function fixture(
  role: WorkerObjective["details"]["role"] = "implementation",
  actions: Partial<ExtensionActions> = {},
  settings?: string,
  executor = defaultExecutor,
) {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-worker-"));
  const root = join(parent, "repo");
  await mkdir(root);

  if (settings !== undefined) {
    await mkdir(join(parent, "agent"), { recursive: true });
    await writeFile(join(parent, "agent", "settings.json"), settings);
  }

  const previous = configureFixtureEnvironment({
    PI_CODING_AGENT_DIR: join(parent, "agent"),
    PI_WORKGRAPH_ROLE: role,
  });

  const session = persistentSession(root, join(parent, "sessions"));

  const assigned: WorkerObjective = {
    content: objective.content,
    details:
      role === "implementation"
        ? { ...objective.details, role, executor }
        : {
            taskId: objective.details.taskId,
            attemptId: objective.details.attemptId,
            role,
          },
  };

  session.appendCustomMessageEntry(
    "pi-workgraph-objective",
    assigned.content,
    true,
    assigned.details,
  );
  let activeTools = ["read", "bash", "edit", "write", "workgraph_plan", "workgraph_report"];

  const pi = await extensionFixture(
    "worker",
    root,
    parent,
    {
      getActiveTools: () => [...activeTools],
      setActiveTools: (names) => {
        activeTools = [...names];
      },
      ...actions,
    },
    [],
    session,
  );

  await pi.runner.emit({ type: "session_start", reason: "startup" });

  return {
    ...pi,
    activeTools: () => activeTools,
    async dispose() {
      await pi.close();
      restoreFixtureEnvironment(previous);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

async function endTool(f: Awaited<ReturnType<typeof fixture>>, toolName: string, isError = false) {
  await f.runner.emit({
    type: "tool_execution_end",
    toolCallId: toolName,
    toolName,
    result: {},
    isError,
  });
}

function appendPlan(session: SessionManager) {
  session.appendMessage({
    role: "toolResult",
    toolCallId: "plan",
    toolName: "workgraph_plan",
    content: [{ type: "text", text: "set" }],
    details: { action: "set", todos: todo },
    isError: false,
    timestamp: Date.now(),
  });
}

function appendResult(session: SessionManager, toolName: string, isError = false) {
  session.appendMessage({
    role: "toolResult",
    toolCallId: toolName,
    toolName,
    content: [],
    details: {},
    isError,
    timestamp: Date.now(),
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
    timestamp: Date.now(),
  });
}

void test("before_agent_start reconciles tools without forcing the system prompt", async () => {
  const f = await fixture("research");

  try {
    const started = await f.runner.emitBeforeAgentStart("Work", undefined, { cwd: "." });

    assert.equal(started.systemPromptOptions.forceSystemPrompt, undefined);
    assert.equal(f.activeTools().includes("edit"), false);
    assert.equal(f.activeTools().includes("workgraph_report"), true);
  } finally {
    await f.dispose();
  }
});

void test("plan tool keeps one strict nonblank 1–9 item current snapshot", async () => {
  const f = await fixture();

  try {
    const tool = f.runner.getToolDefinition("workgraph_plan");
    assert.ok(tool);
    assert.equal(Value.Check(tool.parameters, { action: "set", todos: setTodo }), true);
    assert.equal(
      Value.Check(tool.parameters, { action: "set", todos: [{ ...setTodo[0], text: " " }] }),
      false,
    );
    assert.equal(Value.Check(tool.parameters, { action: "set", todos: [] }), false);
    await assert.rejects(
      f.call("workgraph_plan", { action: "set", todos: [setTodo[0], setTodo[0]] }),
    );

    const second = {
      id: "verify",
      text: "Verify the bounded fixture change.",
      validation: "The supported Worker flow is observed.",
    };

    const set = await f.call("workgraph_plan", {
      action: "set",
      todos: [...setTodo, second],
    });

    assert.deepEqual(set.details, {
      action: "set",
      todos: [...todo, { ...second, status: "pending" }],
    });

    const update = await f.call("workgraph_plan", {
      action: "update",
      id: "implement",
      patch: { status: "done", note: "verified" },
    });

    // SAFETY: The registered plan tool returned schema-validated snapshot details.
    assert.equal((update.details as { todos: typeof todo }).todos[0]?.status, "done");
    await assert.rejects(f.call("workgraph_plan", { action: "set", todos: setTodo }));
  } finally {
    await f.dispose();
  }
});

void test("TODO and successful direct edit trigger one executor cutover in either order", async () => {
  for (const order of ["plan-first", "edit-first"] as const) {
    const f = await fixture();

    try {
      if (order === "plan-first") {
        await f.call("workgraph_plan", { action: "set", todos: setTodo });
        await endTool(f, "workgraph_plan");
        await endTool(f, "bash");
        await endTool(f, "write", true);
        assert.deepEqual(f.selected, []);
        await endTool(f, "edit");
      } else {
        await endTool(f, "write");
        assert.deepEqual(f.selected, []);
        await f.call("workgraph_plan", { action: "set", todos: setTodo });
        await endTool(f, "workgraph_plan");
      }

      assert.deepEqual(f.selected, ["openai/gpt-4o"]);
      await endTool(f, "edit");
      assert.deepEqual(f.selected, ["openai/gpt-4o"]);

      const executorStarts = f.session
        .getBranch()
        .filter(
          (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-executor-start",
        );

      assert.equal(executorStarts.length, 1);
      assert.deepEqual(
        executorStarts[0]?.type === "custom" ? executorStarts[0].data : undefined,
        {},
      );
      await f.runner.emit({ type: "agent_settled" });

      const reminder = f.messages.find(
        (message) => message.customType === "pi-workgraph-todo-reminder",
      );

      assert.deepEqual(reminder?.details, {});
    } finally {
      await f.dispose();
    }
  }
});

void test("selection failure remains guide-owned, blocks mutation, never retries, and permits failed report", async () => {
  let session: SessionManager | undefined;
  let calls = 0;

  const f = await fixture("implementation", {
    async setModel() {
      calls += 1;

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
    await f.call("workgraph_plan", { action: "set", todos: setTodo });
    await endTool(f, "workgraph_plan");
    await endTool(f, "edit");
    assert.equal(calls, 1);
    await endTool(f, "write");
    assert.equal(calls, 1);
    assert.equal(f.activeTools().includes("edit"), false);
    assert.equal(f.activeTools().includes("write"), false);
    assert.equal(
      f.session
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom_message" && entry.customType === "pi-workgraph-executor-failure",
        ).length,
      1,
    );

    const report = await f.call("workgraph_report", {
      status: "failed",
      summary: "Executor target could not be selected.",
      details: "The configured executor target could not be selected.",
    });

    assert.equal(report.terminate, true);
  } finally {
    session = undefined;
    await f.dispose();
  }
});

void test("recovery derives cutover and changed proof from the exact trajectory", async () => {
  const f = await fixture();

  try {
    appendPlan(f.session);
    appendResult(f.session, "write");
    await f.runner.emit({ type: "session_start", reason: "reload" });
    await endTool(f, "bash");
    await assert.rejects(
      f.call("workgraph_report", {
        status: "completed",
        outcome: "changed",
        summary: "Changed.",
        details: "Changed and verified the bounded target.",
      }),
      /later successful executor assistant message/,
    );
    assistant(f.session);

    const report = await f.call("workgraph_report", {
      status: "completed",
      outcome: "changed",
      summary: "Changed.",
      details: "Changed and verified the bounded target.",
    });

    assert.deepEqual(report.details, {
      report: {
        role: "implementation",
        status: "completed",
        outcome: "changed",
        summary: "Changed.",
        details: "Changed and verified the bounded target.",
      },
    });
  } finally {
    await f.dispose();
  }
});

void test("reattach promotes only exact frozen executor state with persisted TODO/edit evidence", async () => {
  const f = await fixture("implementation", {}, undefined, {
    model: "amazon-bedrock/amazon.nova-2-lite-v1:0",
    thinking: "high",
  });

  try {
    appendPlan(f.session);
    appendResult(f.session, "edit");
    await f.runner.emit({ type: "session_start", reason: "reload" });
    assert.deepEqual(f.selected, []);
    assert.equal(
      f.session
        .getBranch()
        .filter(
          (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-executor-start",
        ).length,
      1,
    );
  } finally {
    await f.dispose();
  }
});

void test("guide terminal paths and role-owned edit gates are independent", async () => {
  const guide = await fixture();

  try {
    const noChange = await guide.call("workgraph_report", {
      status: "completed",
      outcome: "no_change",
      summary: "Already satisfied.",
      details: "Direct inspection found no needed change.",
    });

    assert.equal(noChange.terminate, true);
    assert.deepEqual(noChange.details, {
      report: {
        role: "implementation",
        status: "completed",
        outcome: "no_change",
        summary: "Already satisfied.",
        details: "Direct inspection found no needed change.",
      },
    });
  } finally {
    await guide.dispose();
  }

  for (const role of ["research", "review", "consultation"] as const) {
    const worker = await fixture(role);

    try {
      assert.equal(worker.runner.getToolDefinition("workgraph_plan"), undefined);
      assert.equal(worker.activeTools().includes("bash"), true);
      assert.equal(worker.activeTools().includes("edit"), false);
      assert.equal(worker.activeTools().includes("write"), false);

      const report = await worker.call("workgraph_report", {
        status: "completed",
        summary: "Bounded result.",
        details: "Inspected the requested material and recorded uncertainty.",
      });

      assert.deepEqual(report.details, {
        report: {
          role,
          status: "completed",
          summary: "Bounded result.",
          details: "Inspected the requested material and recorded uncertainty.",
        },
      });
    } finally {
      await worker.dispose();
    }
  }

  const experiment = await fixture("experiment");

  try {
    assert.equal(experiment.activeTools().includes("edit"), true);
    assert.equal(experiment.activeTools().includes("write"), true);

    const report = await experiment.call("workgraph_report", {
      status: "completed",
      summary: "Experiment complete.",
      details: "No effects were needed; the cutoff was respected.",
    });

    assert.deepEqual(report.details, {
      report: {
        role: "experiment",
        status: "completed",
        summary: "Experiment complete.",
        details: "No effects were needed; the cutoff was respected.",
      },
    });
  } finally {
    await experiment.dispose();
  }
});

void test("malformed objective fails closed but retains actual-model and settled readback", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-worker-objective-"));
  const root = join(parent, "repo");
  await mkdir(root);

  const previous = configureFixtureEnvironment({
    PI_CODING_AGENT_DIR: join(parent, "agent"),
    PI_WORKGRAPH_ROLE: "implementation",
  });

  const session = SessionManager.create(root, join(parent, "sessions"), { id: "attempt" });
  session.appendCustomMessageEntry("pi-workgraph-objective", objective.content, true, {
    ...objective.details,
    role: "research",
    executor: undefined,
  });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Workgraph assignment loaded." }],
    api: "test",
    provider: "test",
    model: "fixture",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  });

  try {
    let activeTools = ["read", "bash", "edit", "write", "workgraph_plan", "workgraph_report"];

    const loaded = await extensionFixture(
      "worker",
      root,
      parent,
      {
        getActiveTools: () => [...activeTools],
        setActiveTools: (names) => {
          activeTools = [...names];
        },
      },
      [],
      session,
    );

    await loaded.runner.emit({ type: "session_start", reason: "startup" });
    await loaded.runner.emit({ type: "agent_start" });
    await loaded.runner.emit({ type: "agent_settled" });

    const report = await loaded.call("workgraph_report", {
      status: "failed",
      summary: "The authoritative objective was malformed.",
      details: "The objective role conflicts with the configured Worker role.",
    });

    assert.equal(report.terminate, true);
    const file = session.getSessionFile();

    if (file === undefined) assert.fail("Worker session was not persisted.");
    const read = readWorkerSession(file, root, objective);
    assert.equal(read.unreadable, false, read.unreadable ? read.error : "");

    if (!read.unreadable) {
      assert.equal(read.started, true);
      assert.equal(read.settled, true);
      assert.match(read.reportError ?? "", /objective.*mismatched/i);
    }

    await loaded.close();
  } finally {
    restoreFixtureEnvironment(previous);
    await rm(parent, { recursive: true, force: true });
  }
});

void test("invalid Worker role does not crash extension loading", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-worker-role-"));
  const root = join(parent, "repo");
  await mkdir(root);

  const previous = configureFixtureEnvironment({
    PI_CODING_AGENT_DIR: join(parent, "agent"),
    PI_WORKGRAPH_ROLE: "invalid-role",
  });

  try {
    const loaded = await extensionFixture("worker", root, parent);
    assert.equal(loaded.runner.getToolDefinition("workgraph_report"), undefined);
    await loaded.close();
  } finally {
    restoreFixtureEnvironment(previous);
    await rm(parent, { recursive: true, force: true });
  }
});

void test("unreadable or protected settings fail closed before requests and preserve failed reporting", async () => {
  for (const settings of [
    "{",
    JSON.stringify({ "pi-workgraph": { worker: { disabledTools: ["workgraph_plan"] } } }),
    JSON.stringify({ "pi-workgraph": { worker: { disabledTools: ["workgraph_report"] } } }),
  ]) {
    const f = await fixture("implementation", {}, settings);

    try {
      assert.deepEqual(f.activeTools(), ["workgraph_report"]);
      assert.equal(
        f.messages.filter((message) => message.customType === "pi-workgraph-worker-diagnostic")
          .length,
        1,
      );
      await assert.rejects(
        f.call("workgraph_report", {
          status: "needs_decision",
          summary: "Not a missing decision.",
          details: "No Coordinator decision is actually missing.",
        }),
        /only a truthful failed report/,
      );

      const failed = await f.call("workgraph_report", {
        status: "failed",
        summary: "Worker settings could not be trusted.",
        details: "The protected Worker settings were unreadable or invalid.",
      });

      assert.equal(failed.terminate, true);
    } finally {
      await f.dispose();
    }
  }
});

void test("genuine compaction restores the authoritative objective and current TODO once", async () => {
  const f = await fixture();

  try {
    await f.call("workgraph_plan", { action: "set", todos: setTodo });
    appendPlan(f.session);

    const kept = f.session.appendMessage({
      role: "user",
      content: "Continue after compaction.",
      timestamp: Date.now(),
    });

    f.session.appendCompaction("Earlier context compacted.", kept, 1_000);
    assert.equal(
      f.session
        .buildContextEntries()
        .some(
          (entry) =>
            entry.type === "custom_message" && entry.customType === "pi-workgraph-objective",
        ),
      false,
    );
    const compaction = f.session.getLeafEntry();
    assert.ok(compaction?.type === "compaction");
    await f.runner.emit({
      type: "session_compact",
      compactionEntry: compaction,
      fromExtension: false,
      reason: "manual",
      willRetry: false,
    });

    const recoveries = f.messages.filter(
      (message) => message.customType === "pi-workgraph-compaction-recovery",
    );

    assert.equal(recoveries.length, 1);
    const recovery = recoveries[0];
    assert.ok(recovery);
    const Content = Type.String();
    assert.equal(Value.Check(Content, recovery.content), true);
    const content = Value.Decode(Content, recovery.content);
    assert.match(content, /Purpose: exercise the Worker/);
    assert.match(content, /Current TODO/);
  } finally {
    await f.dispose();
  }
});

void test("actual models are recorded only at agent_start with actual thinking", async () => {
  const f = await fixture();

  try {
    await f.runner.emit({ type: "agent_start" });
    const model = f.registry.getAll()[0];
    assert.ok(model);
    await f.runner.emit({
      type: "model_select",
      model,
      previousModel: undefined,
      source: "set",
    });

    const markers = f.session
      .getBranch()
      .filter(
        (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-effective-model",
      );

    assert.equal(markers.length, 1);

    if (markers[0]?.type === "custom") {
      // SAFETY: The marker is emitted only from the typed agent_start observation.
      assert.equal((markers[0].data as { thinking: string }).thinking, "high");
    }
  } finally {
    await f.dispose();
  }
});
