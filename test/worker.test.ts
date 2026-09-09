import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Worker integration fixtures use real host storage and Git files.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Fixture paths identify real repository and session resources.
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionActions,
  InlineExtension,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import workgraphWorker from "../extensions/worker.js";
import {
  configureFixtureEnvironment,
  decodeTestValue,
  restoreFixtureEnvironment,
} from "./decoders.js";
import { extensionFixture, git, usage } from "./helpers.js";

const fixtureTimestamp = 1_788_235_200_000;
const planStepSchema = Type.Object({
  id: Type.String(),
  text: Type.String(),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("done"),
    Type.Literal("blocked"),
    Type.Literal("superseded"),
  ]),
  note: Type.Optional(Type.String()),
});
const workerPlanSchema = Type.Object({
  approach: Type.String(),
  rationale: Type.String(),
  risks: Type.String(),
  steps: Type.Array(planStepSchema),
});
const planToolDetailsSchema = Type.Object({
  action: Type.Union([
    Type.Literal("get"),
    Type.Literal("update"),
    Type.Literal("update_step"),
    Type.Literal("update_overview"),
    Type.Literal("add_step"),
    Type.Literal("remove_step"),
  ]),
  plan: Type.Optional(workerPlanSchema),
  planStatus: Type.Union([
    Type.Literal("absent"),
    Type.Literal("valid"),
    Type.Literal("malformed"),
  ]),
  attempt: Type.Object({ runId: Type.String(), nodeId: Type.String() }),
  change: Type.Optional(
    Type.Object({
      removed: Type.Object({ id: Type.String(), reason: Type.String() }),
    }),
  ),
});
const reportDetailsSchema = Type.Object({
  state: Type.Object({
    plan: Type.Optional(workerPlanSchema),
    planStatus: Type.Union([
      Type.Literal("absent"),
      Type.Literal("valid"),
      Type.Literal("malformed"),
    ]),
    reminderCount: Type.Integer(),
  }),
  report: Type.Object({ commit: Type.String() }),
});
const noChangeDetailsSchema = Type.Object({
  report: Type.Object({ outcome: Type.Literal("no_change") }),
  state: Type.Object({ switchedAt: Type.Optional(Type.String()) }),
});

function assistant(session: SessionManager, model = "gpt-4o") {
  return session.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "fixture",
        name: "workgraph_report",
        arguments: {
          kind: "implementation",
          status: "completed",
          outcome: "changed",
          summary: "Changed fixture",
          evidence: [],
          findings: [],
        },
      },
    ],
    api: "openai-responses",
    provider: "openai",
    model,
    usage,
    stopReason: "toolUse",
    timestamp: fixtureTimestamp,
  });
}

async function fixture(
  mode: "implementation" | "research" | "review",
  continued = false,
  actions: Partial<ExtensionActions> = {},
  experiment = false,
  extensionFactories: InlineExtension[] = [],
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
    PI_WORKGRAPH_RUN_ID: "fixture",
    PI_WORKGRAPH_NODE_ID: "attempt",
    PI_WORKGRAPH_BASE_COMMIT: await git(root, "rev-parse", "HEAD"),
    PI_WORKGRAPH_EXECUTOR_MODEL: "openai/gpt-4o",
    PI_WORKGRAPH_EXECUTOR_THINKING: "high",
    PI_WORKGRAPH_IMPLEMENTATION_START: continued ? "executor" : null,
    PI_WORKGRAPH_EXPERIMENT: experiment ? "1" : null,
  });
  let activeTools = ["read", "bash", "edit", "write"];
  const pi = await extensionFixture(
    "worker",
    root,
    parent,
    {
      getActiveTools: () => [...activeTools],
      setActiveTools: (toolNames) => {
        activeTools = [...toolNames];
      },
      ...actions,
    },
    extensionFactories.length === 0 ? [] : [workgraphWorker, ...extensionFactories],
  );
  return {
    ...pi,
    root,
    async dispose() {
      await pi.close();
      restoreFixtureEnvironment(previous);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

void test("research workers do not expose coordinator notes or implementation plans", async () => {
  const f = await fixture("research");
  try {
    assert.equal(f.runner.getToolDefinition("workgraph_notepad"), undefined);
    assert.equal(f.runner.getToolDefinition("workgraph_note"), undefined);
    assert.equal(f.runner.getToolDefinition("workgraph_plan"), undefined);
  } finally {
    await f.dispose();
  }
});

void test("registered worker observes a non-edit mutation, switches locally, reports a direct commit and native settlement", async () => {
  const f = await fixture("implementation");
  try {
    assert.ok(f.registry.find("openai", "gpt-4o"));
    const report = {
      kind: "implementation",
      status: "completed",
      outcome: "changed",
      summary: "Changed fixture",
      evidence: [],
      findings: [],
    };
    // A forked trajectory's earlier attempt must not restore this attempt's phase.
    f.session.appendCustomEntry("pi-workgraph-worker-state", {
      runId: "fixture",
      nodeId: "prior-attempt",
      phase: "executor",
      switchedAt: "2026-09-01T00:00:00.000Z",
    });
    assistant(f.session);
    await f.runner.emit({ type: "session_start", reason: "startup" });
    await assert.rejects(f.call("workgraph_report", report), {
      _tag: "WorkerContractError",
      message: "Completed changed implementation requires the first-edit model transition.",
    });
    await f.runner.emit({ type: "agent_start" });
    await f.runner.emit({
      type: "tool_execution_end",
      toolCallId: "read",
      toolName: "read",
      result: {},
      isError: false,
    });
    assert.deepEqual(f.selected, []);
    // Even guide == executor must produce a later generation, not merely select itself.
    assistant(f.session);
    await writeFile(join(f.root, "value.txt"), "after\n");
    await f.runner.emit({
      type: "tool_execution_end",
      toolCallId: "opaque",
      toolName: "custom_mutation",
      result: {},
      isError: false,
    });
    assert.deepEqual(f.selected, ["openai/gpt-4o"]);
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-m", "Changed value");
    // A clean direct commit and selection metadata cannot validate a batched guide report.
    await assert.rejects(f.call("workgraph_report", report), /actual executor assistant message/);
    assistant(f.session, "wrong-model");
    await assert.rejects(f.call("workgraph_report", report), /actual executor assistant message/);
    assistant(f.session);
    await f.runner.emit({ type: "session_start", reason: "reload" });
    const result = await f.call("workgraph_report", report);
    assert.equal(result.terminate, true);
    const details = decodeTestValue(reportDetailsSchema, result.details);
    assert.equal(details.state.planStatus, "absent");
    assert.equal(details.state.reminderCount, 0);
    assert.equal(details.report.commit, await git(f.root, "rev-parse", "HEAD"));
    await f.runner.emit({ type: "agent_settled" });
    const markers = f.session
      .getBranch()
      .filter((entry) => entry.type === "custom")
      .map((entry) => entry.customType);
    assert.ok(markers.includes("pi-workgraph-agent-running"));
    assert.ok(markers.includes("pi-workgraph-agent-settled"));
    await writeFile(join(f.root, "value.txt"), "third\n");
    await git(f.root, "commit", "-am", "Extra commit");
    await assert.rejects(f.call("workgraph_report", report), /exactly one direct commit/);
  } finally {
    await f.dispose();
  }
});

const initialPlan = {
  approach: "Inspect the worker extension and implement the smallest cohesive state owner.",
  rationale: "Preserve the existing handoff while making the current assignment recoverable.",
  risks: "Compaction may hide earlier model discussion; verification must remain independent.",
  steps: [
    {
      text: "Implement the bounded current plan and its restoration path.",
      status: "pending" as const,
    },
    { text: "Run focused deterministic tests and the project checks.", status: "pending" as const },
  ],
};

const textContentSchema = Type.String();
const textPartsSchema = Type.Array(
  Type.Object({ type: Type.Literal("text"), text: Type.String() }),
);

// Content is decoded before assertions so tests observe the same native message boundary as Pi.
function messageText(message: { content: unknown }): string {
  if (Value.Check(textContentSchema, message.content))
    return Value.Decode(textContentSchema, message.content);
  if (!Value.Check(textPartsSchema, message.content)) return "";
  return Value.Decode(textPartsSchema, message.content)
    .map((part) => part.text)
    .join("\\n");
}

void test("worker guidance is persisted once per phase and restored once after compaction", async () => {
  const deliveries: Array<{
    customType: string;
    content: unknown;
    display: boolean;
    details?: unknown;
  }> = [];
  let session: SessionManager | undefined;
  const f = await fixture("implementation", false, {
    sendMessage(message) {
      deliveries.push(message);
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
    const objective =
      "[WORKGRAPH IMPLEMENTATION OBJECTIVE]\nAcceptance: preserve the exact acceptance text.\nConstraints: preserve the exact constraints text.";
    session.appendCustomMessageEntry("pi-workgraph-objective", objective, true, {
      runId: "fixture",
      nodeId: "attempt",
      mode: "implementation",
    });
    const updated = await f.call("workgraph_plan", { action: "update", plan: initialPlan });
    assert.equal(decodeTestValue(planToolDetailsSchema, updated.details).planStatus, "valid");
    await f.runner.emit({ type: "session_start", reason: "startup" });

    const first = await f.runner.emitBeforeAgentStart("continue", undefined, "Fixture", {
      cwd: session.getCwd(),
    });
    const guide = first?.messages?.find((message) => message.customType === "pi-workgraph-guide");
    assert.ok(guide !== undefined);
    assert.match(messageText(guide), /Approach: Inspect the worker extension/);
    assert.match(messageText(guide), /meaningful verification/);
    assert.match(messageText(guide), /navigation only/);
    assert.match(messageText(guide), /Acceptance: preserve the exact acceptance text/);
    assert.match(messageText(guide), /Constraints: preserve the exact constraints text/);
    session.appendCustomMessageEntry(guide.customType, guide.content, guide.display, guide.details);
    assert.equal(
      await f.runner.emitBeforeAgentStart("continue", undefined, "Fixture", {
        cwd: session.getCwd(),
      }),
      undefined,
    );

    await f.runner.emit({ type: "session_shutdown", reason: "reload" });
    await f.runner.emit({ type: "session_start", reason: "reload" });
    assert.equal(
      await f.runner.emitBeforeAgentStart("continue", undefined, "Fixture", {
        cwd: session.getCwd(),
      }),
      undefined,
    );
    assert.equal(
      session
        .getBranch()
        .filter(
          (entry) => entry.type === "custom_message" && entry.customType === "pi-workgraph-guide",
        ).length,
      1,
    );

    const kept = session.appendMessage({
      role: "user",
      content: "After compaction",
      timestamp: fixtureTimestamp,
    });
    session.appendCompaction("Compacted", kept, 100);
    const compaction = session.getLeafEntry();
    assert.ok(compaction?.type === "compaction");
    await f.runner.emit({
      type: "session_compact",
      compactionEntry: compaction,
      fromExtension: false,
      reason: "manual",
      willRetry: false,
    });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.customType, "pi-workgraph-guide");
    assert.match(messageText(deliveries[0] ?? { content: undefined }), /Current plan/);
    assert.match(
      messageText(deliveries[0] ?? { content: undefined }),
      /Acceptance: preserve the exact acceptance text/,
    );
    assert.equal(
      await f.runner.emitBeforeAgentStart("continue", undefined, "Fixture", {
        cwd: session.getCwd(),
      }),
      undefined,
    );
    await f.runner.emit({ type: "session_shutdown", reason: "reload" });
    await f.runner.emit({ type: "session_start", reason: "reload" });
    assert.equal(deliveries.length, 1);
    assert.equal(
      session
        .getBranch()
        .filter(
          (entry) => entry.type === "custom_message" && entry.customType === "pi-workgraph-guide",
        ).length,
      2,
    );
  } finally {
    session = undefined;
    await f.dispose();
  }
});

void test("guide assigns monotonic IDs; executor updates local knowledge and cannot replace the full plan", async () => {
  const f = await fixture("implementation");
  try {
    const created = await f.call("workgraph_plan", { action: "update", plan: initialPlan });
    const stored = decodeTestValue(planToolDetailsSchema, created.details).plan;
    assert.ok(stored !== undefined);
    assert.deepEqual(
      stored?.steps.map((step) => step.id),
      ["step-1", "step-2"],
    );
    assert.equal(stored?.approach, initialPlan.approach);
    assistant(f.session);
    await writeFile(join(f.root, "value.txt"), "after\n");
    await f.runner.emit({
      type: "tool_execution_end",
      toolCallId: "opaque",
      toolName: "custom_mutation",
      result: {},
      isError: false,
    });
    assert.deepEqual(f.selected, ["openai/gpt-4o"]);
    await assert.rejects(
      f.call("workgraph_plan", { action: "update", plan: initialPlan }),
      /Only the guide phase may replace the full plan/,
    );
    const kept = decodeTestValue(
      planToolDetailsSchema,
      (await f.call("workgraph_plan", { action: "get" })).details,
    ).plan;
    assert.equal(kept?.approach, initialPlan.approach);
    const overview = await f.call("workgraph_plan", {
      action: "update_overview",
      patch: {
        approach: "Use the inspected worker boundary and preserve append-only plan history.",
        rationale: "Later evidence refined the local mechanics without changing the assignment.",
        risks: "A mutable overview must remain an appended tool result, never a rewritten prefix.",
      },
    });
    const overviewPlan = decodeTestValue(planToolDetailsSchema, overview.details).plan;
    assert.match(overviewPlan?.approach ?? "", /append-only/);
    assert.match(overviewPlan?.rationale ?? "", /refined/);
    assert.match(overviewPlan?.risks ?? "", /rewritten prefix/);
    const stepped = await f.call("workgraph_plan", {
      action: "update_step",
      id: "step-1",
      patch: { status: "in_progress", note: "Executor owns this note." },
    });
    const steppedPlan = decodeTestValue(planToolDetailsSchema, stepped.details).plan;
    assert.equal(steppedPlan?.steps[0]?.status, "in_progress");
    assert.equal(steppedPlan?.steps[0]?.note, "Executor owns this note.");
    assert.equal(steppedPlan?.steps[0]?.text, kept?.steps[0]?.text);
    assert.equal(steppedPlan?.approach, overviewPlan?.approach);
    const added = await f.call("workgraph_plan", {
      action: "add_step",
      text: "Verify the isolated diff and focused checks.",
      after_id: "step-1",
    });
    const addedPlan = decodeTestValue(planToolDetailsSchema, added.details).plan;
    assert.deepEqual(
      addedPlan?.steps.map((step) => step.id),
      ["step-1", "step-3", "step-2"],
    );
    assert.equal(addedPlan?.steps[1]?.status, "pending");
    const removed = await f.call("workgraph_plan", {
      action: "remove_step",
      id: "step-2",
      reason: "Superseded by the narrower verification step.",
    });
    const removedDetails = decodeTestValue(planToolDetailsSchema, removed.details);
    const removedPlan = removedDetails.plan;
    assert.deepEqual(removedDetails.change?.removed, {
      id: "step-2",
      reason: "Superseded by the narrower verification step.",
    });
    assert.deepEqual(
      removedPlan?.steps.map((step) => step.id),
      ["step-1", "step-3"],
    );
    await assert.rejects(
      f.call("workgraph_plan", {
        action: "update_step",
        id: "step-2",
        patch: { status: "pending" },
      }),
      /Unknown step id/,
    );
    const appended = await f.call("workgraph_plan", {
      action: "add_step",
      text: "Record the final independently justified result.",
    });
    const appendedPlan = decodeTestValue(planToolDetailsSchema, appended.details).plan;
    assert.deepEqual(
      appendedPlan?.steps.map((step) => step.id),
      ["step-1", "step-3", "step-4"],
    );
    const current = decodeTestValue(
      planToolDetailsSchema,
      (await f.call("workgraph_plan", { action: "get" })).details,
    );
    assert.deepEqual(current.plan, appendedPlan);
    assert.equal(current.attempt.runId, "fixture");
    assert.equal(current.attempt.nodeId, "attempt");
  } finally {
    await f.dispose();
  }
});

void test("targeted edits reject invalid requests atomically and allow concise plans to grow", async () => {
  const f = await fixture("implementation");
  try {
    await f.call("workgraph_plan", { action: "update", plan: initialPlan });
    assistant(f.session);
    await writeFile(join(f.root, "value.txt"), "after\n");
    await f.runner.emit({
      type: "tool_execution_end",
      toolCallId: "opaque",
      toolName: "custom_mutation",
      result: {},
      isError: false,
    });
    const unchangedAfterInvalid = async (operation: () => Promise<object>, pattern: RegExp) => {
      const before = decodeTestValue(
        planToolDetailsSchema,
        (await f.call("workgraph_plan", { action: "get" })).details,
      ).plan;
      const beforeEntries = f.session
        .getBranch()
        .filter(
          (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-worker-plan",
        ).length;
      await assert.rejects(operation(), pattern);
      const after = decodeTestValue(
        planToolDetailsSchema,
        (await f.call("workgraph_plan", { action: "get" })).details,
      ).plan;
      const afterEntries = f.session
        .getBranch()
        .filter(
          (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-worker-plan",
        ).length;
      assert.deepEqual(after, before);
      assert.equal(afterEntries, beforeEntries);
    };
    await unchangedAfterInvalid(
      () =>
        f.call("workgraph_plan", {
          action: "update_step",
          id: "step-8",
          patch: { status: "done" },
        }),
      /Unknown step id/,
    );
    await unchangedAfterInvalid(
      () => f.call("workgraph_plan", { action: "update_step", id: "step-1", patch: {} }),
      /at least one of text, status, or note/,
    );
    await unchangedAfterInvalid(
      () => f.call("workgraph_plan", { action: "update_overview", patch: {} }),
      /at least one of approach, rationale, or risks/,
    );
    const tool = f.runner.getToolDefinition("workgraph_plan");
    assert.ok(tool !== undefined);
    assert.equal(
      Value.Check(tool.parameters, {
        action: "update_step",
        id: "step-1",
        patch: { status: "superseded" },
      }),
      false,
    );
    await unchangedAfterInvalid(
      () =>
        f.call("workgraph_plan", {
          action: "add_step",
          text: "Anchor against a missing step.",
          after_id: "step-8",
        }),
      /Unknown anchor step id/,
    );
    await unchangedAfterInvalid(
      () =>
        f.call("workgraph_plan", {
          action: "remove_step",
          id: "step-8",
          reason: "Missing.",
        }),
      /Unknown step id/,
    );
    assert.equal(
      Value.Check(tool.parameters, {
        action: "update_step",
        id: "step-1",
        patch: { status: "done", unexpected: true },
      }),
      false,
    );
    assert.equal(
      Value.Check(tool.parameters, {
        action: "update_overview",
        patch: { risks: "Current local risk.", unexpected: true },
      }),
      false,
    );
    for (let index = 3; index <= 12; index += 1)
      await f.call("workgraph_plan", {
        action: "add_step",
        text: `Current plan step number ${index}.`,
      });
    const grown = decodeTestValue(
      planToolDetailsSchema,
      (await f.call("workgraph_plan", { action: "get" })).details,
    ).plan;
    assert.equal(grown?.steps.length, 12);
    assert.equal(grown?.steps.at(-1)?.id, "step-12");
    await f.call("workgraph_plan", {
      action: "remove_step",
      id: "step-12",
      reason: "The final check was consolidated without erasing its transcript history.",
    });
    const appended = await f.call("workgraph_plan", {
      action: "add_step",
      text: "A later discovery receives a new monotonic identity.",
    });
    const after = decodeTestValue(planToolDetailsSchema, appended.details).plan;
    assert.equal(after?.steps.length, 12);
    assert.equal(after?.steps.at(-1)?.id, "step-13");
  } finally {
    await f.dispose();
  }
});

void test("removing the only current step is rejected without changing plan state", async () => {
  const f = await fixture("implementation");
  try {
    const singleStepPlan = { ...initialPlan, steps: [initialPlan.steps[0]] };
    const created = await f.call("workgraph_plan", {
      action: "update",
      plan: singleStepPlan,
    });
    const before = decodeTestValue(planToolDetailsSchema, created.details).plan;
    const beforeEntries = f.session
      .getBranch()
      .filter(
        (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-worker-plan",
      ).length;
    await assert.rejects(
      f.call("workgraph_plan", {
        action: "remove_step",
        id: "step-1",
        reason: "No current navigation step would remain.",
      }),
      /must retain at least one step/,
    );
    const after = decodeTestValue(
      planToolDetailsSchema,
      (await f.call("workgraph_plan", { action: "get" })).details,
    ).plan;
    assert.deepEqual(after, before);
    assert.equal(
      f.session
        .getBranch()
        .filter(
          (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-worker-plan",
        ).length,
      beforeEntries,
    );
  } finally {
    await f.dispose();
  }
});

void test("initial plan count is guidance while serialized state remains bounded", async () => {
  const f = await fixture("implementation");
  try {
    const tool = f.runner.getToolDefinition("workgraph_plan");
    assert.ok(tool !== undefined);
    const twelveStepPlan = {
      ...initialPlan,
      steps: Array.from({ length: 12 }, (_, index) => ({
        text: `Meaningful implementation or verification step ${index + 1}.`,
        status: "pending" as const,
      })),
    };
    assert.equal(Value.Check(tool.parameters, { action: "update", plan: twelveStepPlan }), true);
    const accepted = await f.call("workgraph_plan", {
      action: "update",
      plan: twelveStepPlan,
    });
    const acceptedPlan = decodeTestValue(planToolDetailsSchema, accepted.details).plan;
    assert.equal(acceptedPlan?.steps.length, 12);
    assert.equal(acceptedPlan?.steps.at(-1)?.id, "step-12");

    const oversized = {
      ...initialPlan,
      steps: Array.from({ length: 30 }, (_, index) => ({
        text: `${index + 1} ${"x".repeat(995)}`,
        status: "pending" as const,
      })),
    };
    assert.equal(Value.Check(tool.parameters, { action: "update", plan: oversized }), true);
    const beforeEntries = f.session
      .getBranch()
      .filter(
        (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-worker-plan",
      ).length;
    await assert.rejects(
      f.call("workgraph_plan", { action: "update", plan: oversized }),
      /24000-character serialized safety limit/,
    );
    const current = decodeTestValue(
      planToolDetailsSchema,
      (await f.call("workgraph_plan", { action: "get" })).details,
    ).plan;
    assert.deepEqual(current, acceptedPlan);
    assert.equal(
      f.session
        .getBranch()
        .filter(
          (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-worker-plan",
        ).length,
      beforeEntries,
    );

    const nearLimit = {
      ...initialPlan,
      steps: Array.from({ length: 24 }, (_, index) => ({
        text: `${index + 1} ${"x".repeat(895)}`,
        status: "pending" as const,
      })),
    };
    const nearAccepted = await f.call("workgraph_plan", {
      action: "update",
      plan: nearLimit,
    });
    const nearAcceptedPlan = decodeTestValue(planToolDetailsSchema, nearAccepted.details).plan;
    const nearEntries = f.session
      .getBranch()
      .filter(
        (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-worker-plan",
      ).length;
    await assert.rejects(
      f.call("workgraph_plan", {
        action: "update_overview",
        patch: { risks: "r".repeat(2000) },
      }),
      /24000-character serialized safety limit/,
    );
    assert.deepEqual(
      decodeTestValue(
        planToolDetailsSchema,
        (await f.call("workgraph_plan", { action: "get" })).details,
      ).plan,
      nearAcceptedPlan,
    );
    assert.equal(
      f.session
        .getBranch()
        .filter(
          (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-worker-plan",
        ).length,
      nearEntries,
    );

    f.session.appendCustomEntry("pi-workgraph-worker-plan", {
      runId: "fixture",
      nodeId: "attempt",
      nextStepNumber: 131,
      plan: {
        ...oversized,
        steps: oversized.steps.map((step, index) => ({ ...step, id: `step-${101 + index}` })),
      },
    });
    await f.runner.emit({ type: "session_start", reason: "reload" });
    const restored = decodeTestValue(
      planToolDetailsSchema,
      (await f.call("workgraph_plan", { action: "get" })).details,
    );
    assert.equal(restored.planStatus, "malformed");
    assert.equal(restored.plan, undefined);
  } finally {
    await f.dispose();
  }
});

void test("plan persistence publishes before state and leaves the old plan on append failure", async () => {
  let session: SessionManager | undefined;
  let failAppend = false;
  let persistedEntries = 0;
  const f = await fixture("implementation", false, {
    appendEntry(type, data) {
      if (failAppend) throw new Error("Injected plan append failure");
      if (type === "pi-workgraph-worker-plan") persistedEntries += 1;
      session?.appendCustomEntry(type, data);
    },
  });
  session = f.session;
  try {
    await f.call("workgraph_plan", { action: "update", plan: initialPlan });
    const before = decodeTestValue(
      planToolDetailsSchema,
      (await f.call("workgraph_plan", { action: "get" })).details,
    );
    assert.equal(persistedEntries, 1);
    failAppend = true;
    await assert.rejects(
      f.call("workgraph_plan", {
        action: "update_step",
        id: "step-1",
        patch: { status: "done" },
      }),
      /Injected plan append failure/,
    );
    const after = decodeTestValue(
      planToolDetailsSchema,
      (await f.call("workgraph_plan", { action: "get" })).details,
    );
    assert.deepEqual(after, before);
    assert.equal(persistedEntries, 1);
    assert.equal(
      f.session
        .getBranch()
        .filter(
          (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-worker-plan",
        ).length,
      1,
    );
  } finally {
    session = undefined;
    await f.dispose();
  }
});

void test("legacy plans restore with monotonic IDs; malformed identities and allocators stay rejected", async () => {
  const f = await fixture("implementation");
  try {
    f.session.appendCustomEntry("pi-workgraph-worker-plan", {
      runId: "fixture",
      nodeId: "attempt",
      plan: initialPlan,
    });
    await f.runner.emit({ type: "session_start", reason: "reload" });
    const restored = decodeTestValue(
      planToolDetailsSchema,
      (await f.call("workgraph_plan", { action: "get" })).details,
    );
    assert.equal(restored.planStatus, "valid");
    assert.deepEqual(
      restored.plan?.steps.map((step) => step.id),
      ["step-1", "step-2"],
    );
    const first = decodeTestValue(
      planToolDetailsSchema,
      (await f.call("workgraph_plan", { action: "get" })).details,
    ).plan;
    assert.ok(first !== undefined);
    const firstStep = first.steps[0];
    assert.ok(firstStep !== undefined);
    firstStep.text = "Mutated through the returned reference.";
    const second = decodeTestValue(
      planToolDetailsSchema,
      (await f.call("workgraph_plan", { action: "get" })).details,
    ).plan;
    assert.notEqual(second?.steps[0]?.text, "Mutated through the returned reference.");
    assert.notEqual(first, second);
  } finally {
    await f.dispose();
  }
  const numbered = await fixture("implementation");
  try {
    numbered.session.appendCustomEntry("pi-workgraph-worker-plan", {
      runId: "fixture",
      nodeId: "attempt",
      plan: {
        ...initialPlan,
        steps: [
          {
            id: "step-8",
            text: "A legacy superseded row remains readable.",
            status: "superseded",
            note: "Historical removal reason.",
          },
          { id: "step-9", text: "A valid widened identity.", status: "pending" },
        ],
      },
    });
    await numbered.runner.emit({ type: "session_start", reason: "reload" });
    const added = await numbered.call("workgraph_plan", {
      action: "add_step",
      text: "Allocation continues beyond the greatest restored identity.",
    });
    const plan = decodeTestValue(planToolDetailsSchema, added.details).plan;
    assert.deepEqual(
      plan?.steps.map((step) => step.id),
      ["step-8", "step-9", "step-10"],
    );
    const removed = await numbered.call("workgraph_plan", {
      action: "remove_step",
      id: "step-8",
      reason: "Clear the migrated legacy tombstone from current navigation.",
    });
    assert.deepEqual(
      decodeTestValue(planToolDetailsSchema, removed.details).plan?.steps.map((step) => step.id),
      ["step-9", "step-10"],
    );
  } finally {
    await numbered.dispose();
  }
  const corruptedLatest = await fixture("implementation");
  try {
    corruptedLatest.session.appendCustomEntry("pi-workgraph-worker-plan", {
      runId: "fixture",
      nodeId: "attempt",
      nextStepNumber: 6,
      plan: {
        ...initialPlan,
        steps: [{ id: "step-5", text: "Earlier valid plan state.", status: "pending" }],
      },
    });
    corruptedLatest.session.appendCustomEntry("pi-workgraph-worker-plan", {
      runId: "fixture",
      nodeId: "attempt",
      plan: { steps: [] },
    });
    await corruptedLatest.runner.emit({ type: "session_start", reason: "reload" });
    const malformed = decodeTestValue(
      planToolDetailsSchema,
      (await corruptedLatest.call("workgraph_plan", { action: "get" })).details,
    );
    assert.equal(malformed.planStatus, "malformed");
    const recreated = await corruptedLatest.call("workgraph_plan", {
      action: "update",
      plan: initialPlan,
    });
    assert.deepEqual(
      decodeTestValue(planToolDetailsSchema, recreated.details).plan?.steps.map((step) => step.id),
      ["step-6", "step-7"],
    );
  } finally {
    await corruptedLatest.dispose();
  }
  for (const invalid of [
    {
      runId: "fixture",
      nodeId: "attempt",
      plan: {
        ...initialPlan,
        steps: [
          { id: "step-1", text: "First retained step.", status: "pending" },
          { text: "Second step without an identity.", status: "pending" },
        ],
      },
    },
    {
      runId: "fixture",
      nodeId: "attempt",
      plan: {
        ...initialPlan,
        steps: [
          { id: "step-1", text: "First retained step.", status: "pending" },
          { id: "step-1", text: "Duplicate retained identity.", status: "pending" },
        ],
      },
    },
    {
      runId: "fixture",
      nodeId: "attempt",
      plan: {
        ...initialPlan,
        steps: [{ id: "step-0", text: "Identity zero is invalid.", status: "pending" }],
      },
    },
    {
      runId: "fixture",
      nodeId: "attempt",
      nextStepNumber: 1,
      plan: {
        ...initialPlan,
        steps: [{ id: "step-9", text: "Allocator would reuse history.", status: "pending" }],
      },
    },
    {
      runId: "fixture",
      nodeId: "attempt",
      plan: {
        ...initialPlan,
        steps: [{ id: "step-9007199254740992", text: "Unsafe identity.", status: "pending" }],
      },
    },
  ]) {
    const g = await fixture("implementation");
    try {
      g.session.appendCustomEntry("pi-workgraph-worker-plan", invalid);
      await g.runner.emit({ type: "session_start", reason: "reload" });
      const current = decodeTestValue(
        planToolDetailsSchema,
        (await g.call("workgraph_plan", { action: "get" })).details,
      );
      assert.equal(current.planStatus, "malformed");
      assert.equal(current.plan, undefined);
    } finally {
      await g.dispose();
    }
  }
});

void test("current-attempt identity, malformed plan state, and bounded reminders never become completion gates", async () => {
  const deliveries: Array<{
    customType: string;
    content: unknown;
    options: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean } | undefined;
  }> = [];
  const f = await fixture("implementation", false, {
    sendMessage(message, options) {
      deliveries.push({ customType: message.customType, content: message.content, options });
    },
  });
  try {
    const reminders = () =>
      deliveries.filter((delivery) => delivery.customType === "pi-workgraph-reconciliation");
    f.session.appendCustomEntry("pi-workgraph-worker-plan", {
      runId: "other-workstream",
      nodeId: "attempt",
      plan: initialPlan,
    });
    f.session.appendCustomEntry("pi-workgraph-worker-plan", {
      runId: "fixture",
      nodeId: "attempt",
      plan: { steps: [] },
    });
    f.session.appendCustomEntry("pi-workgraph-worker-state", {
      runId: "fixture",
      nodeId: "attempt",
      reminderCount: 99,
    });
    f.session.appendCustomMessageEntry("pi-workgraph-objective", [], true, {
      runId: "fixture",
      nodeId: "attempt",
      mode: "implementation",
    });
    await f.runner.emit({ type: "session_start", reason: "reload" });
    const malformed = await f.call("workgraph_plan", { action: "get" });
    const malformedDetails = decodeTestValue(planToolDetailsSchema, malformed.details);
    assert.equal(malformedDetails.planStatus, "malformed");
    assert.equal(malformedDetails.plan, undefined);
    const recovery = await f.runner.emitBeforeAgentStart("continue", undefined, "Fixture", {
      cwd: f.session.getCwd(),
    });
    const recoveryMessage = recovery?.messages?.find(
      (message) => message.customType === "pi-workgraph-guide",
    );
    assert.ok(recoveryMessage !== undefined);
    assert.match(messageText(recoveryMessage), /worker state/);
    assert.match(messageText(recoveryMessage), /malformed/);
    assert.match(messageText(recoveryMessage), /objective snapshot was malformed/);
    f.session.appendCustomMessageEntry(
      recoveryMessage.customType,
      recoveryMessage.content,
      recoveryMessage.display,
      recoveryMessage.details,
    );

    await f.call("workgraph_plan", { action: "update", plan: initialPlan });
    assistant(f.session);
    await writeFile(join(f.root, "value.txt"), "after\n");
    await f.runner.emit({
      type: "tool_execution_end",
      toolCallId: "opaque",
      toolName: "custom_mutation",
      result: {},
      isError: false,
    });
    await f.runner.emit({ type: "agent_settled" });
    assert.equal(reminders().length, 1);
    assert.match(String(reminders()[0]?.content), /RECONCILIATION REMINDER 1\/2/);
    assert.deepEqual(reminders()[0]?.options, { deliverAs: "followUp", triggerTurn: true });
    assert.equal(
      f.session
        .getBranch()
        .some(
          (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-agent-settled",
        ),
      false,
    );

    await f.runner.emit({ type: "session_shutdown", reason: "reload" });
    await f.runner.emit({ type: "session_start", reason: "reload" });
    await f.runner.emit({ type: "agent_settled" });
    assert.equal(reminders().length, 2);
    assert.match(String(reminders()[1]?.content), /RECONCILIATION REMINDER 2\/2/);
    assert.deepEqual(reminders()[1]?.options, { deliverAs: "followUp", triggerTurn: true });
    await f.runner.emit({ type: "agent_settled" });
    assert.equal(
      f.session
        .getBranch()
        .some(
          (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-agent-settled",
        ),
      true,
    );
    const states = f.session
      .getBranch()
      .filter(
        (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-worker-state",
      )
      .map((entry) => (entry.type === "custom" ? entry.data : undefined))
      .filter(
        (data): data is { reminderCount?: number } => typeof data === "object" && data !== null,
      );
    assert.equal(states.at(-1)?.reminderCount, 2);
    assert.deepEqual(await f.runner.emitContext([]), []);
    const exhaustedRecovery = await f.runner.emitBeforeAgentStart(
      "continue",
      undefined,
      "Fixture",
      { cwd: f.session.getCwd() },
    );
    assert.ok(exhaustedRecovery !== undefined);
    assert.ok(exhaustedRecovery.messages !== undefined);
    assert.ok(
      exhaustedRecovery.messages.every(
        (message) => !/RECONCILIATION REMINDER/.test(messageText(message)),
      ),
    );
  } finally {
    await f.dispose();
  }
});

void test("terminal failure stops pending reconciliation before the reminder budget is exhausted", async () => {
  let reconciliationCount = 0;
  const f = await fixture("implementation", false, {
    sendMessage(message) {
      if (message.customType === "pi-workgraph-reconciliation") reconciliationCount += 1;
    },
  });
  try {
    await f.call("workgraph_plan", { action: "update", plan: initialPlan });
    assistant(f.session);
    await writeFile(join(f.root, "value.txt"), "after\n");
    await f.runner.emit({
      type: "tool_execution_end",
      toolCallId: "opaque",
      toolName: "custom_mutation",
      result: {},
      isError: false,
    });
    await f.runner.emit({ type: "agent_settled" });
    assert.equal(reconciliationCount, 1);
    const failed = await f.call("workgraph_report", {
      kind: "implementation",
      status: "failed",
      summary: "The executor cannot continue within the assignment.",
      evidence: [],
      findings: [],
    });
    assert.equal(failed.terminate, true);
    await f.runner.emit({ type: "agent_settled" });
    assert.equal(reconciliationCount, 1);
  } finally {
    await f.dispose();
  }
});

void test("blocked-only plan steps do not schedule a pointless reconciliation loop", async () => {
  const deliveries: unknown[] = [];
  const f = await fixture("implementation", false, {
    sendMessage(message) {
      deliveries.push(message);
    },
  });
  try {
    await f.call("workgraph_plan", {
      action: "update",
      plan: {
        ...initialPlan,
        steps: [
          {
            text: "Wait for the unavailable native boundary.",
            status: "blocked" as const,
          },
        ],
      },
    });
    await f.runner.emit({
      type: "tool_execution_end",
      toolCallId: "opaque",
      toolName: "custom_mutation",
      result: {},
      isError: false,
    });
    await f.runner.emit({ type: "agent_settled" });
    assert.equal(deliveries.length, 0);
    assert.equal(
      f.session
        .getBranch()
        .some(
          (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-agent-settled",
        ),
      true,
    );
  } finally {
    await f.dispose();
  }
});

void test("no-change implementation can report from the guide without manufacturing an edit or executor turn", async () => {
  const f = await fixture("implementation");
  try {
    const revision = await git(f.root, "rev-parse", "HEAD");
    const report = {
      kind: "implementation" as const,
      status: "completed" as const,
      outcome: "no_change" as const,
      summary: "No source change was needed.",
      revision,
      reason: "The requirement already holds on the inspected base.",
      evidence: [{ label: "Git boundary", observation: `HEAD remains ${revision}` }],
      findings: [],
    };
    const result = await f.call("workgraph_report", report);
    assert.equal(result.terminate, true);
    assert.equal(
      decodeTestValue(noChangeDetailsSchema, result.details).state.switchedAt,
      undefined,
    );
    assert.deepEqual(f.selected, []);
    assert.equal(await git(f.root, "rev-parse", "HEAD"), revision);
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "before\n");
  } finally {
    await f.dispose();
  }
});

void test("worker tool availability follows assignment permissions across reload", async () => {
  for (const [mode, experiment, canEdit] of [
    ["implementation", false, true],
    ["research", false, false],
    ["review", false, false],
    ["research", true, true],
    ["review", true, false],
  ] as const) {
    const originalTools = ["read", "bash", "edit", "write", "herdr_rename", "custom_lookup"];
    let activeTools = [...originalTools];
    const f = await fixture(
      mode,
      false,
      {
        getActiveTools: () => [...activeTools],
        setActiveTools: (toolNames) => {
          activeTools = [...toolNames];
        },
      },
      experiment,
    );
    const expected = canEdit
      ? ["read", "bash", "edit", "write", "herdr_rename", "custom_lookup"]
      : ["read", "bash", "herdr_rename", "custom_lookup"];
    try {
      await f.runner.emit({ type: "session_start", reason: "startup" });
      assert.deepEqual(activeTools, expected);

      activeTools = [...originalTools];
      await f.runner.emit({ type: "session_start", reason: "reload" });
      assert.deepEqual(activeTools, expected);
    } finally {
      await f.dispose();
    }
  }
});

void test("worker reload applies newly disabled tools without reactivating removed names", async () => {
  let activeTools = ["read", "bash", "extension_denied"];
  const companion: InlineExtension = {
    name: "denied-extension-tool",
    factory(pi) {
      pi.registerTool({
        name: "extension_denied",
        label: "Extension denied",
        description: "Fixture extension tool",
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text", text: "unexpected" }], details: {} };
        },
      });
    },
  };
  const f = await fixture(
    "implementation",
    false,
    {
      getActiveTools: () => [...activeTools],
      setActiveTools: (toolNames) => {
        activeTools = [...toolNames];
      },
    },
    false,
    [companion],
  );
  try {
    await mkdir(join(f.root, "..", "agent"), { recursive: true });
    const settings = join(f.root, "..", "agent", "settings.json");
    await writeFile(
      settings,
      JSON.stringify({ "pi-workgraph": { worker: { disabledTools: ["extension_denied"] } } }),
    );
    await f.runner.emit({ type: "session_start", reason: "startup" });
    assert.deepEqual(activeTools, ["read", "bash"]);

    await writeFile(
      settings,
      JSON.stringify({ "pi-workgraph": { worker: { disabledTools: ["read"] } } }),
    );
    await f.runner.emit({ type: "session_start", reason: "reload" });
    assert.deepEqual(activeTools, ["bash"]);

    await writeFile(settings, JSON.stringify({ "pi-workgraph": { worker: {} } }));
    await f.runner.emit({ type: "session_start", reason: "reload" });
    assert.deepEqual(activeTools, ["bash"]);
  } finally {
    await f.dispose();
  }
});

void test("invalid worker settings warn without weakening read-only assignment restrictions", async () => {
  let activeTools = ["read", "bash", "edit", "write"];
  const f = await fixture("review", false, {
    getActiveTools: () => [...activeTools],
    setActiveTools: (toolNames) => {
      activeTools = [...toolNames];
    },
  });
  try {
    await mkdir(join(f.root, "..", "agent"), { recursive: true });
    await writeFile(
      join(f.root, "..", "agent", "settings.json"),
      JSON.stringify({ "pi-workgraph": { worker: { disabledTools: [" "] } } }),
    );
    await f.runner.emit({ type: "session_start", reason: "startup" });
    assert.deepEqual(activeTools, ["read", "bash"]);
    assert.deepEqual(f.notifications, [
      {
        message: "Could not load worker tool settings; configured tools remain available.",
        type: "warning",
      },
    ]);
  } finally {
    await f.dispose();
  }
});

void test("worker blocks configured and assignment-disabled calls if stale tool exposure races filtering", async () => {
  const f = await fixture("review");
  try {
    await mkdir(join(f.root, "..", "agent"), { recursive: true });
    await writeFile(
      join(f.root, "..", "agent", "settings.json"),
      JSON.stringify({ "pi-workgraph": { worker: { disabledTools: ["read"] } } }),
    );
    await f.runner.emit({ type: "session_start", reason: "startup" });
    assert.deepEqual(
      await f.runner.emitToolCall({
        type: "tool_call",
        toolName: "read",
        toolCallId: "stale-read",
        input: { path: "value.txt" },
      }),
      { block: true, reason: "Tool read is unavailable to this Workgraph worker." },
    );
    assert.deepEqual(
      await f.runner.emitToolCall({
        type: "tool_call",
        toolName: "write",
        toolCallId: "stale-write",
        input: { path: "value.txt", content: "after\n" },
      }),
      { block: true, reason: "Tool write is unavailable to this Workgraph worker." },
    );
  } finally {
    await f.dispose();
  }
});

void test("continued implementation requires this attempt's native start and later executor message, not inherited evidence", async () => {
  const f = await fixture("implementation", true);
  const report = {
    kind: "implementation",
    status: "completed",
    outcome: "changed",
    summary: "Continued work",
    evidence: [],
    findings: [],
  };
  try {
    f.session.appendCustomEntry("pi-workgraph-worker-state", {
      runId: "fixture",
      nodeId: "prior-attempt",
      phase: "executor",
      switchedAt: "2026-09-01T00:00:00.000Z",
    });
    f.session.appendCustomEntry("pi-workgraph-agent-running", {
      runId: "fixture",
      nodeId: "prior-attempt",
    });
    assistant(f.session);
    await f.runner.emit({ type: "session_start", reason: "startup" });
    await writeFile(join(f.root, "value.txt"), "after\n");
    await git(f.root, "commit", "-am", "Continued change");
    await assert.rejects(f.call("workgraph_report", report), /actual executor assistant message/);
    await f.runner.emit({ type: "agent_start" });
    await assert.rejects(f.call("workgraph_report", report), /actual executor assistant message/);
    assistant(f.session);
    assert.equal((await f.call("workgraph_report", report)).terminate, true);
    await writeFile(join(f.root, "value.txt"), "dirty\n");
    await assert.rejects(f.call("workgraph_report", report), /clean worktree/);
  } finally {
    await f.dispose();
  }
});

void test("registered report schemas reject undeclared fields in every mode", async () => {
  for (const mode of ["research", "review", "implementation"] as const) {
    const f = await fixture(mode);
    try {
      const tool = f.runner.getToolDefinition("workgraph_report");
      assert.ok(tool !== undefined);
      const report = {
        kind: mode,
        status: "failed",
        summary: "Boundary regression",
        evidence: [{ label: "Boundary", observation: "Observed" }],
        findings: [],
      };
      const invalid = [
        { ...report, authorization: "Bearer retained-secret" },
        {
          ...report,
          evidence: [{ ...report.evidence[0], rawProviderError: "credential-bearing failure" }],
        },
      ];
      for (const candidate of invalid)
        assert.equal(
          Value.Check(tool.parameters, candidate),
          false,
          `${mode} accepted extra input`,
        );
    } finally {
      await f.dispose();
    }
  }
});

void test("read-only review reports accept dirty live files without changing them", async () => {
  const f = await fixture("review");
  const report = {
    kind: "review",
    status: "completed",
    summary: "Reviewed",
    evidence: [],
    findings: [],
  };
  try {
    const head = await git(f.root, "rev-parse", "HEAD");
    await writeFile(join(f.root, "value.txt"), "changed\n");
    assert.equal((await f.call("workgraph_report", report)).terminate, true);
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "changed\n");
    assert.equal(await git(f.root, "rev-parse", "HEAD"), head);
  } finally {
    await f.dispose();
  }
});
