import assert from "node:assert/strict";
import test from "node:test";
import { inspectView, resultNotification } from "../src/agent-facing.js";
import type { WorkerReport } from "../src/types.js";
import type {
  RetainedArtifact,
  WorkAssignment,
  WorkAttempt,
  WorkResult,
  WorkstreamState,
} from "../src/workstream.js";

const timestamp = "2026-01-01T00:00:00.000Z";

function assignment(id: string): WorkAssignment {
  return {
    id,
    capability: "research",
    artifactIntent: "evidence_only",
    objective: `Read ${id}`,
    intentVersion: 0,
    expectedEvidence: ["bytes"],
    createdAt: timestamp,
  };
}

function typedResult(id: string, assignmentId: string, report: WorkerReport): WorkResult {
  return {
    id,
    assignmentId,
    assignmentIntentVersion: 0,
    artifacts: [],
    observedAt: timestamp,
    validity: "typed",
    report,
  };
}

function untypedResult(
  id: string,
  assignmentId: string,
  validity: "untyped" | "invalid" | "absent",
  content: string,
): WorkResult {
  return validity === "untyped"
    ? {
        id,
        assignmentId,
        assignmentIntentVersion: 0,
        artifacts: [],
        observedAt: timestamp,
        validity,
        text: content,
      }
    : {
        id,
        assignmentId,
        assignmentIntentVersion: 0,
        artifacts: [],
        observedAt: timestamp,
        validity,
        detail: content,
      };
}

function state(
  assignments: WorkAssignment[] = [assignment("task")],
  attempts: WorkAttempt[] = [],
  results: WorkResult[] = [],
): WorkstreamState {
  return {
    format: "pi-workgraph-workstream",
    version: 7,
    revision: 0,
    id: "agent-facing",
    purpose: "Test bounded agent-facing projections.",
    projectRoot: "/tmp/project",
    gitCommonDir: "/tmp/project/.git",
    statePath: "/tmp/project/.git/pi-workgraph/workstreams/agent-facing/workstream.json",
    coordinator: {
      sessionId: "agent-facing-test",
      sessionFile: "/tmp/agent-facing-test.jsonl",
    },
    lifecycle: { state: "active", changedAt: timestamp, reason: "Testing." },
    inputs: [],
    intents: [
      {
        version: 0,
        statement: "Test projections.",
        constraints: [],
        authorityReceiptIds: [],
        recordedAt: timestamp,
      },
    ],
    assignments,
    attempts,
    results,
    deliveries: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function researchReport(summary: string): WorkerReport {
  return {
    kind: "research",
    status: "completed",
    summary,
    evidence: [
      {
        label: "source",
        observation: "A detailed observation.",
        class: "direct",
        command: "printf detailed command",
        artifact: "retained/source.txt",
      },
    ],
    findings: [],
  };
}

void test("overview task index recovers every arbitrary task id", () => {
  const ids = Array.from({ length: 27 }, (_, index) =>
    index === 3
      ? "Task with spaces, uppercase, and a deliberately long semantic identifier"
      : `task ${index} with spaces`,
  );
  const current = state(ids.map((id) => assignment(id)));
  const recovered: string[] = [];
  let offset = 0;
  let truncated = true;
  while (truncated) {
    const view = inspectView(current, { section: "overview", offset, maxChars: 31 });
    recovered.push(view.taskIndex.text);
    truncated = view.taskIndex.truncated;
    offset = view.taskIndex.next?.offset ?? offset;
  }
  assert.equal(recovered.join(""), JSON.stringify(ids));
  const overview = inspectView(current, { section: "overview", maxItems: 4 });
  assert.equal(overview.tasks.totalItems, ids.length);
  assert.equal(overview.tasks.truncated, true);
  assert.ok(overview.tasks.next);
});

void test("retained authority, complete assignments, and completion roundtrip exactly", () => {
  const longInput = `second human scope ${"scope detail 🧭 ".repeat(700)}`;
  const longObjective = `Implement exact behavior ${"objective detail ".repeat(650)}`;
  const longAcceptance = `Preserve acceptance ${"acceptance detail ".repeat(600)}`;
  const longConclusion = `Completion substance ${"completion detail ".repeat(640)}`;
  const implementation: WorkAssignment = {
    id: "implementation task",
    capability: "implement",
    artifactIntent: "maintained_change",
    objective: longObjective,
    intentVersion: 2,
    authority: { receiptId: "receipt-2", intentVersion: 2 },
    acceptance: [longAcceptance],
    createdAt: timestamp,
  };
  const experiment: WorkAssignment = {
    id: "experiment task",
    capability: "research",
    artifactIntent: "disposable_experiment",
    objective: "Run the bounded probe",
    intentVersion: 2,
    authority: { receiptId: "receipt-2", intentVersion: 2 },
    permittedEffects: ["Write one temporary probe"],
    stopCondition: "Stop after the first observation",
    expectedEvidence: ["Exact probe bytes"],
    createdAt: timestamp,
  };
  const review: WorkAssignment = {
    id: "review task",
    capability: "review",
    artifactIntent: "evidence_only",
    objective: "Review the exact retained revision",
    intentVersion: 2,
    subject: { kind: "revision", revision: "a".repeat(40) },
    concern: "Authority and inspection loss",
    createdAt: timestamp,
  };
  const outcome = typedResult("implementation-result", implementation.id, researchReport("Done"));
  const current = state([implementation, experiment, review], [], [outcome]);
  current.purpose = `Original human scope ${"original context ".repeat(500)}`;
  current.inputs = [
    {
      id: "receipt-1",
      sessionId: "agent-facing-test",
      sessionFile: "/tmp/agent-facing-test.jsonl",
      source: "interactive",
      text: "first human scope",
      receivedAt: timestamp,
    },
    {
      id: "receipt-2",
      sessionId: "agent-facing-test",
      sessionFile: "/tmp/agent-facing-test.jsonl",
      source: "rpc",
      text: longInput,
      receivedAt: timestamp,
    },
  ];
  current.intents = [
    {
      version: 0,
      statement: current.purpose,
      constraints: [],
      authorityReceiptIds: [],
      recordedAt: timestamp,
    },
    {
      version: 1,
      statement: "Coordinator interpretation of first scope",
      constraints: ["Keep historical scope"],
      authorityReceiptIds: ["receipt-1"],
      recordedAt: timestamp,
    },
    {
      version: 2,
      statement: longObjective,
      constraints: ["Keep historical scope"],
      authorityReceiptIds: ["receipt-2"],
      recordedAt: timestamp,
    },
  ];
  current.completion = {
    conclusion: longConclusion,
    evidence: [{ label: "exact", observation: "All retained decisions were inspected." }],
    limitations: ["No live host observation"],
    accounting: [],
    completedAt: timestamp,
  };

  let contextText = "";
  let contextOffset = 0;
  for (;;) {
    const view = inspectView(current, {
      section: "context",
      offset: contextOffset,
      maxChars: 257,
    });
    contextText += view.records.text;
    if (view.records.next === undefined) break;
    assert.equal(view.records.next.section, "context");
    contextOffset = view.records.next.offset;
  }
  assert.deepEqual(JSON.parse(contextText), {
    purpose: current.purpose,
    inputs: current.inputs,
    intents: current.intents,
  });

  for (const expected of current.assignments) {
    let assignmentText = "";
    let assignmentOffset = 0;
    for (;;) {
      const view = inspectView(current, {
        section: "assignment",
        task: expected.id,
        offset: assignmentOffset,
        maxChars: 211,
      });
      assignmentText += view.content.text;
      if (view.content.next === undefined) break;
      assert.equal(view.content.next.task, expected.id);
      assignmentOffset = view.content.next.offset;
    }
    assert.deepEqual(JSON.parse(assignmentText), expected);
  }

  let completionText = "";
  let completionOffset = 0;
  for (;;) {
    const view = inspectView(current, {
      section: "completion",
      offset: completionOffset,
      maxChars: 193,
    });
    completionText += view.records.text;
    if (view.records.next === undefined) break;
    assert.equal(view.records.next.section, "completion");
    completionOffset = view.records.next.offset;
  }
  assert.deepEqual(JSON.parse(completionText), {
    lifecycle: current.lifecycle,
    completion: current.completion,
  });
});

void test("typed report kinds and untyped or malformed reports remain inspectable", () => {
  const reports: WorkerReport[] = [
    researchReport("Research"),
    {
      kind: "review",
      status: "failed",
      summary: "Review failed",
      evidence: [],
      findings: [],
    },
    {
      kind: "implementation" as const,
      status: "completed" as const,
      outcome: "no_change" as const,
      revision: "0123456789abcdef0123456789abcdef01234567",
      reason: "The requested behavior already holds.",
      summary: "No change",
      evidence: [],
      findings: [],
    },
  ];
  const results = reports.map((report, index) => typedResult(`typed-${index}`, "task", report));
  results.push(untypedResult("untyped", "task", "untyped", "raw worker output ".repeat(10)));
  results.push(untypedResult("invalid", "task", "invalid", "malformed report ".repeat(10)));
  results.push(untypedResult("absent", "task", "absent", "missing report ".repeat(10)));
  const current = state(undefined, [], results);
  for (const result of results) {
    const outcome = inspectView(current, { section: "outcome", result: result.id });
    assert.equal("result" in outcome, true);
    if (!("result" in outcome)) continue;
    assert.equal(
      outcome.result,
      result.id.startsWith("typed")
        ? `outcome-${Number(result.id.slice(-1)) + 1}`
        : `outcome-${results.indexOf(result) + 1}`,
    );
    const report = inspectView(current, { section: "report", result: result.id, maxChars: 20 });
    assert.equal("content" in report, true);
    if (!("content" in report)) continue;
    assert.ok(report.content.text.length <= 20);
    assert.equal(report.content.truncated, true);
    assert.ok(report.content.next);
  }
});

void test("large delivery errors and retained artifacts stay bounded with lossless artifact access", () => {
  const artifacts: RetainedArtifact[] = [
    {
      id: "probe",
      kind: "path",
      reference: "/retained/probe.txt",
      retention: "retained",
      summary: "artifact detail ".repeat(1_000),
    },
  ];
  const result = typedResult("delivery-result", "delivery", researchReport("Small"));
  result.artifacts = artifacts;
  const current = state([assignment("delivery")], [], [result]);
  current.deliveries.push({
    resultId: result.id,
    state: "pending",
    requestedAt: timestamp,
    error: `delivery-error-${"x".repeat(100_000)}`,
  });
  const notice = resultNotification(current, result.id);
  assert.ok(notice.length < 12_000);
  assert.equal(notice.includes(current.deliveries[0]?.error ?? ""), false);
  assert.ok(notice.includes(artifacts[0]?.reference ?? ""));

  let offset = 0;
  let recovered = "";
  for (;;) {
    const view = inspectView(current, {
      section: "outcome",
      result: result.id,
      offset,
      maxChars: 1_000,
    });
    assert.equal("retainedArtifacts" in view, true);
    if (!("retainedArtifacts" in view)) break;
    recovered += view.retainedArtifacts.text;
    const next = view.retainedArtifacts.next;
    if (next === undefined) break;
    assert.equal(next.section, "outcome");
    assert.equal(next.result, result.id);
    offset = next.offset;
  }
  assert.deepEqual(JSON.parse(recovered), artifacts);
});
