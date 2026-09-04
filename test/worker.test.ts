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

test("verification workers own the assigned product procedure", async () => {
  const { verificationWorkerInstructions } = await import("../extensions/worker.js");
  const instructions = verificationWorkerInstructions();
  assert.match(instructions, /ASSIGNED VERIFIER/);
  assert.match(instructions, /already the independent product-verification worker assigned by Workgraph/);
  assert.match(instructions, /Directly execute the supplied verification procedure/);
  assert.match(instructions, /Do not create, adopt, plan, schedule, verify, assure, judge, or otherwise coordinate another Workgraph/);
  assert.match(instructions, /Do not favor a verified verdict/);
  assert.match(instructions, /return failed, inconclusive, or escalated/);
});

test("an implementation can report without a Local Prewalk TODO", async () => {
  const previous = { ...process.env };
  process.env.PI_WORKGRAPH_MODE = "implementation";
  process.env.PI_WORKGRAPH_IMPLEMENTATION_START = "guide";
  process.env.PI_WORKGRAPH_RUN_ID = "run-no-todo";
  process.env.PI_WORKGRAPH_NODE_ID = "no-todo";
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
      setModel: async () => true,
      setThinkingLevel() {},
      exec: async (_command: string, args: string[]) => {
        const operation = args.slice(2).join(" ");
        if (operation.startsWith("status")) return { code: 0, stdout: "", stderr: "" };
        if (operation.startsWith("rev-parse")) return { code: 0, stdout: "commit", stderr: "" };
        if (operation.startsWith("diff")) return { code: 0, stdout: "src/a.txt", stderr: "" };
        return { code: 1, stdout: "", stderr: `unexpected git operation: ${operation}` };
      },
    } as unknown as ExtensionAPI;
    const extension = (await import(`../extensions/worker.js?absent-todo-${Date.now()}`)).default;
    extension(fakePi);
    const transition = handlers.get("tool_execution_end")?.[0];
    assert.ok(transition);
    await transition({ toolName: "edit", isError: false }, {
      modelRegistry: { find: () => ({}) },
    });
    const result = await tools.get("workgraph_report")!.execute("report", {
      kind: "implementation",
      status: "completed",
      summary: "Committed without a prewalk TODO.",
      evidence: [],
      findings: [],
      commit: "ignored-by-worker",
      changedFiles: [],
    }, undefined, undefined, { cwd: "/tmp/fixture" });
    assert.equal(result.terminate, true);
    assert.equal(result.details.state.todoRecorded, false);
    assert.deepEqual(result.details.state.todos, []);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
});
