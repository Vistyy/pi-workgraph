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

function collectPages(
  read: (offset: number) => { text: string; truncated: boolean; next?: { offset: number } },
): string {
  let text = "";
  for (let page = 0; page < 1_000; page++) {
    const content = read(text.length);
    text += content.text;
    assert.equal(content.truncated, content.next !== undefined);
    if (content.next === undefined) return text;
    assert.ok(content.text.length > 0, "pagination must make progress");
    assert.equal(content.next.offset, text.length);
  }
  assert.fail("pagination did not finish within the fixture's page budget");
}

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
    statePath: "/tmp/project/.git/pi-workgraph/workstreams/agent-facing/workstream.sqlite",
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

void test("candidate projection uses the canonical historical initial lineage", () => {
  const baseRevision = "a".repeat(40);
  const current = state(undefined, [
    {
      id: "attempt",
      assignmentId: "task",
      state: "queued",
      baseRevision,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ]);
  const view = inspectView(current, { section: "task", task: "task" });
  assert.deepEqual(view.latestAttempt?.candidate, {
    kind: "initial",
    rootCommit: baseRevision,
    parentAttemptId: undefined,
    parentCommit: undefined,
  });
});

void test("overview task index recovers every arbitrary task id", () => {
  const ids = [
    "task 0 with spaces",
    "Task with spaces, uppercase, and a long semantic identifier",
    "task 2 with spaces",
    "task 3 with spaces",
    "task 4 with spaces",
  ];
  const current = state(ids.map((id) => assignment(id)));
  const recovered = collectPages(
    (offset) => inspectView(current, { section: "overview", offset, maxChars: 31 }).taskIndex,
  );
  assert.deepEqual(JSON.parse(recovered), ids);
  const overview = inspectView(current, { section: "overview", maxItems: 4 });
  assert.equal(overview.tasks.totalItems, ids.length);
  assert.equal(overview.tasks.truncated, true);
  assert.ok(overview.tasks.next);
});

void test("retained authority, complete assignments, and completion roundtrip exactly", () => {
  const longInput = `second human scope ${"scope detail 🧭 ".repeat(40)}`;
  const longObjective = `Implement exact behavior ${"objective detail ".repeat(40)}`;
  const longAcceptance = `Preserve acceptance ${"acceptance detail ".repeat(30)}`;
  const longConclusion = `Completion substance ${"completion detail ".repeat(40)}`;
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
  const outcome = typedResult("implementation-result", implementation.id, researchReport("Done"));
  const current = state([implementation], [], [outcome]);
  current.purpose = `Original human scope ${"original context ".repeat(40)}`;
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

  const contextText = collectPages((offset) => {
    const { records } = inspectView(current, { section: "context", offset, maxChars: 257 });
    if (records.next !== undefined) assert.equal(records.next.section, "context");
    return records;
  });
  assert.deepEqual(JSON.parse(contextText), {
    purpose: current.purpose,
    inputs: current.inputs,
    intents: current.intents,
  });

  for (const expected of current.assignments) {
    const assignmentText = collectPages((offset) => {
      const { content } = inspectView(current, {
        section: "assignment",
        task: expected.id,
        offset,
        maxChars: 211,
      });
      if (content.next !== undefined) assert.equal(content.next.task, expected.id);
      return content;
    });
    assert.deepEqual(JSON.parse(assignmentText), expected);
  }

  const completionText = collectPages((offset) => {
    const { records } = inspectView(current, { section: "completion", offset, maxChars: 193 });
    if (records.next !== undefined) assert.equal(records.next.section, "completion");
    return records;
  });
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
  results.push(untypedResult("untyped", "task", "untyped", "raw worker output ".repeat(2)));
  results.push(untypedResult("invalid", "task", "invalid", "malformed report ".repeat(2)));
  results.push(untypedResult("absent", "task", "absent", "missing report ".repeat(2)));
  const current = state(undefined, [], results);
  for (const result of results) {
    const outcome = inspectView(current, { section: "outcome", result: result.id });
    assert.ok("result" in outcome);
    let target = outcome.result;
    const recovered = collectPages((offset) => {
      const page = inspectView(current, {
        section: "report",
        result: target,
        offset,
        maxChars: 20,
      });
      assert.ok("content" in page);
      assert.ok(page.content.text.length <= 20);
      if (offset === 0) assert.ok(page.content.next);
      if (page.content.next !== undefined) {
        assert.equal(page.content.next.section, "report");
        assert.ok(page.content.next.result !== undefined && page.content.next.result.length > 0);
        target = page.content.next.result;
      }
      return page.content;
    });
    if (result.validity === "typed") assert.deepEqual(JSON.parse(recovered), result.report);
    else assert.equal(recovered, result.validity === "untyped" ? result.text : result.detail);
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

  const recovered = collectPages((offset) => {
    const view = inspectView(current, {
      section: "outcome",
      result: result.id,
      offset,
      maxChars: 1_000,
    });
    assert.ok("retainedArtifacts" in view);
    const next = view.retainedArtifacts.next;
    if (next !== undefined) {
      assert.equal(next.section, "outcome");
      assert.equal(next.result, result.id);
    }
    return view.retainedArtifacts;
  });
  assert.deepEqual(JSON.parse(recovered), artifacts);
});
