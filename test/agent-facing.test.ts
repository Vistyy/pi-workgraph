import assert from "node:assert/strict";
import test from "node:test";
import { inspectView, resolveAttemptHandle, resultNotification } from "../src/agent-facing.js";
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

function attempt(
  id: string,
  assignmentId: string,
  state: WorkAttempt["state"] = "queued",
): WorkAttempt {
  return {
    id,
    assignmentId,
    state,
    createdAt: timestamp,
    updatedAt: timestamp,
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
    version: 4,
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
    dispositions: [],
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

void test("retained authority, complete assignments, and coordinator judgments roundtrip exactly", () => {
  const longInput = `second human scope ${"scope detail 🧭 ".repeat(700)}`;
  const longObjective = `Implement exact behavior ${"objective detail ".repeat(650)}`;
  const longAcceptance = `Preserve acceptance ${"acceptance detail ".repeat(600)}`;
  const longDisposition = `Coordinator judgment ${"judgment detail ".repeat(620)}`;
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
    artifactPolicy: { retain: ["artifacts/probe.txt"], discardOthers: true },
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
  current.dispositions = [
    {
      resultId: outcome.id,
      status: "accepted",
      reason: longDisposition,
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

  let judgmentsText = "";
  let judgmentsOffset = 0;
  for (;;) {
    const view = inspectView(current, {
      section: "judgments",
      result: outcome.id,
      offset: judgmentsOffset,
      maxChars: 193,
    });
    judgmentsText += view.records.text;
    if (view.records.next === undefined) break;
    assert.equal(view.records.next.result, outcome.id);
    judgmentsOffset = view.records.next.offset;
  }
  assert.deepEqual(JSON.parse(judgmentsText), {
    lifecycle: current.lifecycle,
    dispositions: current.dispositions,
    completion: current.completion,
  });
});

void test("selection preserves pending attempts and rejects mismatched outcomes", () => {
  const pendingAttempt = attempt("opaque-pending", "research task");
  const sibling = typedResult("opaque-sibling-result", "research task", researchReport("Sibling"));
  const current = state([assignment("research task")], [pendingAttempt], [sibling]);
  const pending = inspectView(current, { section: "outcome", attempt: pendingAttempt.id });
  assert.equal("state" in pending, true);
  if ("state" in pending) {
    assert.equal(pending.state, "pending");
    assert.equal(pending.attempt?.state, "queued");
  }
  assert.throws(
    () =>
      inspectView(current, {
        section: "outcome",
        attempt: pendingAttempt.id,
        result: sibling.id,
      }),
    /has no retained outcome/,
  );
});

void test("recovery distinguishes prelaunch records and exact handles", () => {
  const prelaunch = attempt("opaque-prelaunch", "prelaunch");
  const current = state([assignment("prelaunch")], [prelaunch]);
  const view = inspectView(current, { section: "recovery", attempt: prelaunch.id });
  assert.equal(view.recordedFacts.launch, "never_launched");
  assert.equal(view.recordedFacts.runtimeSettlement, "not_recorded");
  assert.equal(view.recordedFacts.nativeOrGitStateFromTerminalStateAlone, false);

  prelaunch.error = "Inspect uncertain launch before retrying.";
  const other = assignment("other");
  current.assignments.push(other);
  current.attempts.push({ ...prelaunch, id: "other-attempt", assignmentId: other.id });
  const recovery = inspectView(current, { section: "recovery", attempt: prelaunch.id });
  assert.ok(recovery.guardedAction);
  assert.equal(resolveAttemptHandle(current, recovery.guardedAction.attempt).id, prelaunch.id);
});

void test("settlement exposes blocked artifact retention without changing worker report validity", () => {
  const experiment: WorkAssignment = {
    id: "experiment",
    capability: "research",
    artifactIntent: "disposable_experiment",
    objective: "Retain probe output",
    intentVersion: 0,
    authority: { receiptId: "human", intentVersion: 1 },
    permittedEffects: ["Write probe output"],
    stopCondition: "One output",
    expectedEvidence: ["probe.txt"],
    artifactPolicy: { retain: ["probe.txt"], discardOthers: true },
    createdAt: timestamp,
  };
  const result = typedResult("experiment-result", experiment.id, researchReport("Probe done"));
  const workerAttempt = attempt("experiment-attempt", experiment.id, "settled");
  workerAttempt.resultId = result.id;
  workerAttempt.artifactRetention = {
    state: "blocked",
    resultId: result.id,
    assignmentIntentVersion: 0,
    sourceRoot: "/tmp/probe-worktree",
    sourceIdentity: "b".repeat(64),
    expectedHead: "a".repeat(40),
    destinationRoot: "/tmp/state/artifacts/experiment-result",
    stagingRoot: "/tmp/state/artifact-staging/experiment-result",
    required: ["probe.txt"],
    error: "Required artifact is missing.",
  };
  const current = state([experiment], [workerAttempt], [result]);
  const outcome = inspectView(current, { section: "outcome", result: result.id });
  assert.equal("settlement" in outcome, true);
  if (!("settlement" in outcome)) return;
  assert.ok("status" in outcome.settlement.workerReport);
  assert.equal(outcome.settlement.workerReport.status, "completed");
  assert.equal(outcome.settlement.artifactRetention.state, "blocked");
  assert.equal(outcome.settlement.artifactRetention.retained, 0);
  assert.equal(current.dispositions.length, 0);
  const recovery = inspectView(current, { section: "recovery", attempt: workerAttempt.id });
  assert.match(recovery.blocker ?? "", /missing/);
  assert.ok(recovery.guardedAction);
});

void test("pre-settlement retained reports expose their exact pending or blocked retention checkpoint", () => {
  const experiment: WorkAssignment = {
    id: "pre-settlement-experiment",
    capability: "research",
    artifactIntent: "disposable_experiment",
    objective: "Retain probe output",
    intentVersion: 0,
    authority: { receiptId: "human", intentVersion: 1 },
    permittedEffects: ["Write probe output"],
    stopCondition: "One output",
    expectedEvidence: ["probe.txt"],
    artifactPolicy: { retain: ["probe.txt"], discardOthers: true },
    createdAt: timestamp,
  };
  for (const retentionState of ["pending", "blocked"] as const) {
    const result = typedResult(
      `pre-settlement-${retentionState}`,
      experiment.id,
      researchReport("Probe done"),
    );
    const workerAttempt = attempt(`attempt-${retentionState}`, experiment.id, "running");
    workerAttempt.artifactRetention = {
      state: retentionState,
      resultId: result.id,
      assignmentIntentVersion: 0,
      sourceRoot: "/tmp/probe-worktree",
      sourceIdentity: "b".repeat(64),
      expectedHead: "a".repeat(40),
      destinationRoot: `/tmp/state/artifacts/${result.id}`,
      stagingRoot: `/tmp/state/artifact-staging/${result.id}`,
      required: ["probe.txt"],
    };
    if (retentionState === "blocked") workerAttempt.artifactRetention.error = "Copy interrupted.";
    const current = state([experiment], [workerAttempt], [result]);
    const outcome = inspectView(current, {
      section: "outcome",
      attempt: workerAttempt.id,
      result: result.id,
    });
    assert.equal("settlement" in outcome, true);
    if (!("settlement" in outcome)) continue;
    assert.equal(outcome.settlement.artifactRetention.state, retentionState);
    assert.equal(outcome.settlement.artifactRetention.required, 1);
    assert.equal(outcome.settlement.recovery?.attempt, workerAttempt.id);
  }
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
