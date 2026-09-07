import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Worker integration fixtures use real host storage and Git files.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Fixture paths identify real repository and session resources.
import { join } from "node:path";
import test from "node:test";
import type { ExtensionActions, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  configureFixtureEnvironment,
  decodeTestValue,
  restoreFixtureEnvironment,
} from "./decoders.js";
import { extensionFixture, git, usage } from "./helpers.js";

const fixtureTimestamp = 1_788_235_200_000;
const planStepSchema = Type.Object({
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
  action: Type.Union([Type.Literal("get"), Type.Literal("update")]),
  plan: Type.Optional(workerPlanSchema),
  planStatus: Type.Union([
    Type.Literal("absent"),
    Type.Literal("valid"),
    Type.Literal("malformed"),
  ]),
  attempt: Type.Object({ runId: Type.String(), nodeId: Type.String() }),
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
  const pi = await extensionFixture("worker", root, parent, {
    getActiveTools: () => [...activeTools],
    setActiveTools: (toolNames) => {
      activeTools = [...toolNames];
    },
    ...actions,
  });
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

void test("worker scope does not expose coordinator-only notepad tools", async () => {
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
    assert.match(messageText(deliveries[0] ?? { content: undefined }), /Current bounded plan/);
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

void test("executor can inspect and revise the current plan without bypassing the first-edit handoff", async () => {
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
    assert.deepEqual(f.selected, ["openai/gpt-4o"]);
    const revisedPlan = {
      ...initialPlan,
      rationale: "The first edit exposed a smaller verification seam than expected.",
      steps: [
        {
          text: "Keep the implementation change and inspect its exact diff.",
          status: "done" as const,
        },
        {
          text: "Run focused deterministic tests and the project checks.",
          status: "in_progress" as const,
          note: "The full check remains before terminal reporting.",
        },
        {
          text: "Reconcile any blocked native boundary with the coordinator.",
          status: "blocked" as const,
        },
      ],
    };
    const result = await f.call("workgraph_plan", { action: "update", plan: revisedPlan });
    const resultDetails = decodeTestValue(planToolDetailsSchema, result.details);
    assert.deepEqual(resultDetails.plan, revisedPlan);
    const current = await f.call("workgraph_plan", { action: "get" });
    const currentDetails = decodeTestValue(planToolDetailsSchema, current.details);
    assert.deepEqual(currentDetails.plan, revisedPlan);
    assert.equal(currentDetails.attempt.runId, "fixture");
    assert.equal(currentDetails.attempt.nodeId, "attempt");
  } finally {
    await f.dispose();
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

    const failed = await f.call("workgraph_report", {
      kind: "implementation",
      status: "failed",
      summary: "The bounded native verification is unavailable.",
      evidence: [],
      findings: [],
    });
    assert.equal(failed.terminate, true);
    await f.runner.emit({ type: "agent_settled" });
    assert.equal(reminders().length, 2);
    const finalStates = f.session
      .getBranch()
      .filter(
        (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-worker-state",
      )
      .map((entry) => (entry.type === "custom" ? entry.data : undefined))
      .filter(
        (data): data is { reminderCount?: number } => typeof data === "object" && data !== null,
      );
    assert.equal(finalStates.at(-1)?.reminderCount, 2);
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
      decodeTestValue(noChangeDetailsSchema, result.details).report.outcome,
      "no_change",
    );
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
      ? ["read", "bash", "edit", "write", "custom_lookup"]
      : ["read", "bash", "custom_lookup"];
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

void test("registered report schemas reject undeclared fields in every mode, with one execution boundary", async () => {
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
      if (mode === "research")
        for (const candidate of invalid)
          await assert.rejects(f.call("workgraph_report", candidate), /Invalid fixture input/);
    } finally {
      await f.dispose();
    }
  }
});

void test("read-only review observes dirty live files without changing them", async () => {
  const f = await fixture("review");
  const report = {
    kind: "review",
    status: "completed",
    summary: "Reviewed",
    evidence: [],
    findings: [],
  };
  try {
    assert.equal((await f.call("workgraph_report", report)).terminate, true);
    await writeFile(join(f.root, "value.txt"), "changed\n");
    assert.equal((await f.call("workgraph_report", report)).terminate, true);
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "changed\n");
    await git(f.root, "commit", "-am", "Observed local change");
    assert.equal((await f.call("workgraph_report", report)).terminate, true);
  } finally {
    await f.dispose();
  }
});
