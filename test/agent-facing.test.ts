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
import { required } from "./decoders.js";

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

function settlementProjection(state: WorkstreamState, resultId: string) {
  const view = inspectView(state, { section: "outcome", result: resultId });
  if (!("settlement" in view)) throw new Error("Expected settlement projection");
  return view.settlement;
}

function recoveryProjection(state: WorkstreamState, attemptId: string) {
  const view = inspectView(state, { section: "recovery", attempt: attemptId });
  if (!("guardedActions" in view) || !("recordedFacts" in view))
    throw new Error("Expected recovery projection");
  return view;
}

function recoveryActions(state: WorkstreamState, attemptId: string) {
  return recoveryProjection(state, attemptId).guardedActions;
}

function assertOutputProjection(
  state: WorkstreamState,
  resultId: string,
  attemptId: string,
  disposition: string,
  actions: string[],
): void {
  assert.equal(settlementProjection(state, resultId).retainedOutput.state, disposition);
  const recovery = recoveryProjection(state, attemptId);
  assert.equal(recovery.recordedFacts.retainedOutput.state, disposition);
  assert.deepEqual(
    new Set(recovery.guardedActions.map((action) => action.action)),
    new Set(actions),
  );
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
  assert.equal(overview.workstream.currentIntent, 0);
  assert.equal(overview.workstream.currentIntentStatement, "Test projections.");
  assert.deepEqual(overview.workstream.currentIntentContext, { section: "context" });
  assert.equal(overview.tasks.totalItems, ids.length);
  assert.equal(overview.tasks.truncated, true);
  assert.ok(overview.tasks.next);
  assert.ok("activeAttempts" in overview);
  assert.equal("remainingWork" in overview, false);
});

void test("read-only task-scoped attempt ordinals resolve while projections expose exact IDs", () => {
  const first = {
    id: "attempt-a1",
    assignmentId: "task",
    state: "queued" as const,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const second = {
    id: "attempt-a2",
    assignmentId: "task",
    state: "running" as const,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const other = {
    id: "attempt-b1",
    assignmentId: "other",
    state: "queued" as const,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const current = state([assignment("task"), assignment("other")], [first, second, other]);

  const selected = inspectView(current, {
    section: "recovery",
    task: "task",
    attempt: "attempt-2",
  });
  assert.deepEqual(selected.attempt, {
    handle: "attempt-a2",
    storageId: "attempt-a2",
    state: "running",
  });
  const overview = inspectView(current, { section: "overview" });
  assert.deepEqual(
    overview.activeAttempts.items.map((item) => item.attempt),
    ["attempt-a1", "attempt-a2", "attempt-b1"],
  );
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
    currentIntent: current.intents.at(-1),
    purpose: current.purpose,
    inputs: current.inputs,
    intents: current.intents.slice(0, -1),
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

void test("output projections follow cleanup ownership and retain uncertainty", () => {
  const revision = "a".repeat(40);
  const authority = { receiptId: "receipt", intentVersion: 0 };
  const review: WorkAssignment = {
    id: "exact-review",
    capability: "review",
    artifactIntent: "evidence_only",
    objective: "Review the exact revision",
    intentVersion: 0,
    subject: { kind: "revision", revision },
    concern: "Inspect the selected revision",
    createdAt: timestamp,
  };
  const noChange: WorkAssignment = {
    id: "no-change",
    capability: "implement",
    artifactIntent: "maintained_change",
    objective: "Confirm existing behavior",
    intentVersion: 0,
    authority,
    acceptance: ["Existing behavior remains correct"],
    createdAt: timestamp,
  };
  const changed: WorkAssignment = {
    id: "changed",
    capability: "implement",
    artifactIntent: "maintained_change",
    objective: "Implement the change",
    intentVersion: 0,
    authority,
    acceptance: ["The behavior changes"],
    createdAt: timestamp,
  };
  const experiment: WorkAssignment = {
    id: "experiment",
    capability: "research",
    artifactIntent: "disposable_experiment",
    objective: "Try an isolated experiment",
    intentVersion: 0,
    authority,
    permittedEffects: ["Write only in the isolated worktree"],
    stopCondition: "The experiment is understood",
    expectedEvidence: ["Experiment evidence"],
    createdAt: timestamp,
  };
  const reviewResult = typedResult("review-result", review.id, {
    kind: "review",
    status: "completed",
    summary: "Reviewed the exact revision.",
    evidence: [],
    findings: [],
  });
  const noChangeResult = typedResult("no-change-result", noChange.id, {
    kind: "implementation",
    status: "completed",
    outcome: "no_change",
    revision,
    reason: "The requested behavior already holds.",
    summary: "No change was needed.",
    evidence: [],
    findings: [],
  });
  const changedResult = typedResult("changed-result", changed.id, {
    kind: "implementation",
    status: "completed",
    outcome: "changed",
    commit: "b".repeat(40),
    summary: "Changed the behavior.",
    evidence: [],
    findings: [],
  });
  const experimentResult = typedResult(
    "experiment-result",
    experiment.id,
    researchReport("Experiment"),
  );
  const attempts: WorkAttempt[] = [
    {
      id: "review-attempt",
      assignmentId: review.id,
      state: "settled",
      resultId: reviewResult.id,
      placement: { kind: "isolated_worktree", path: "/tmp/review", branch: "review" },
      cleanup: { state: "completed", workerClosed: true },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "no-change-attempt",
      assignmentId: noChange.id,
      state: "settled",
      resultId: noChangeResult.id,
      placement: { kind: "isolated_worktree", path: "/tmp/no-change", branch: "no-change" },
      cleanup: { state: "completed", workerClosed: true },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "changed-attempt",
      assignmentId: changed.id,
      state: "settled",
      resultId: changedResult.id,
      placement: { kind: "isolated_worktree", path: "/tmp/changed", branch: "changed" },
      cleanup: { state: "completed", workerClosed: true },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "experiment-attempt",
      assignmentId: experiment.id,
      state: "settled",
      resultId: experimentResult.id,
      placement: { kind: "isolated_worktree", path: "/tmp/experiment", branch: "experiment" },
      cleanup: { state: "completed", workerClosed: true },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  const current = state([review, noChange, changed, experiment], attempts, [
    reviewResult,
    noChangeResult,
    changedResult,
    experimentResult,
  ]);

  assertOutputProjection(current, reviewResult.id, "review-attempt", "not_applicable", []);
  assertOutputProjection(current, noChangeResult.id, "no-change-attempt", "not_applicable", []);
  assertOutputProjection(current, changedResult.id, "changed-attempt", "retained", [
    "apply",
    "release_output",
  ]);
  assertOutputProjection(current, experimentResult.id, "experiment-attempt", "retained", [
    "release_output",
  ]);
  const legacy = structuredClone(current);
  const legacyResult = required(
    legacy.results.find((result) => result.id === experimentResult.id),
    "legacy experiment result",
  );
  legacyResult.artifacts = [
    {
      id: "retained-output-worktree",
      kind: "path",
      reference: "/tmp/experiment",
      retention: "retained",
      summary: "Historical physical output.",
    },
  ];
  const legacySettlement = settlementProjection(legacy, experimentResult.id);
  assert.equal(legacySettlement.retainedOutput.checkout, "preserved_or_uncertain");
  assert.equal(legacySettlement.retainedOutput.path, "/tmp/experiment");

  const retainedAttempt = required(
    attempts.find((item) => item.id === "changed-attempt"),
    "changed attempt",
  );
  const invalidResult = untypedResult(
    "invalid-result",
    changed.id,
    "invalid",
    "Malformed implementation report.",
  );
  const invalidState = state(
    [changed],
    [
      {
        ...retainedAttempt,
        id: "invalid-attempt",
        resultId: invalidResult.id,
        cleanup: { state: "blocked" as const, workerClosed: true, error: "Malformed output." },
      },
    ],
    [invalidResult],
  );
  assertOutputProjection(invalidState, invalidResult.id, "invalid-attempt", "retained", [
    "release_output",
  ]);

  const failedResult = typedResult("failed-result", changed.id, {
    kind: "implementation",
    status: "failed",
    summary: "The implementation failed.",
    evidence: [],
    findings: [],
  });
  const failedState = state(
    [changed],
    [
      {
        ...retainedAttempt,
        id: "failed-attempt",
        resultId: failedResult.id,
        cleanup: { state: "blocked" as const, workerClosed: true, error: "Failed output." },
      },
    ],
    [failedResult],
  );
  assertOutputProjection(failedState, failedResult.id, "failed-attempt", "retained", [
    "release_output",
  ]);

  const released = structuredClone(current);
  const changedAttempt = required(
    released.attempts.find((item) => item.id === "changed-attempt"),
    "changed attempt",
  );
  changedAttempt.outputRelease = {
    state: "completed",
    expectedHead: revision,
    reason: "Released after inspection.",
  };
  assertOutputProjection(released, changedResult.id, "changed-attempt", "released", []);

  const uncertain = structuredClone(current);
  const reviewAttempt = required(
    uncertain.attempts.find((item) => item.id === "review-attempt"),
    "review attempt",
  );
  reviewAttempt.cleanup = {
    state: "blocked",
    workerClosed: true,
    error: "Worktree identity could not be verified.",
  };
  const uncertainSettlement = settlementProjection(uncertain, reviewResult.id);
  assert.equal(uncertainSettlement.retainedOutput.state, "retained");
  assert.equal(uncertainSettlement.retainedOutput.path, "/tmp/review");
  assert.equal(uncertainSettlement.cleanup.state, "blocked");
  assert.deepEqual(
    recoveryActions(uncertain, reviewAttempt.id).map((action) => action.action),
    ["release_output"],
  );
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
