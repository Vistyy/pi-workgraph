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
