import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  CAPABILITY_SCENARIO_ASSIGNMENT_IDS,
  capabilityPromptAssignmentIds,
  capabilityScenarioPrompt,
  observeCoordinatorTurn,
  observeDelegatedOutcome,
  observeDirectEffect,
} from "../scripts/coordinator-observation.js";
import { WorkstreamStore } from "../src/workstream.js";
import { usage } from "./helpers.js";

const request = "Inspect the fixture.";

function settledAssistant(session: SessionManager, text = "Completed.") {
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "fixture",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

function failedAssistant(
  session: SessionManager,
  stopReason: "error" | "aborted" | "length",
) {
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Unable to continue." }],
    api: "test",
    provider: "test",
    model: "fixture",
    usage,
    stopReason,
    timestamp: Date.now(),
  });
}

function baseState() {
  const root = `/tmp/natural-test-${randomUUID()}`;
  return WorkstreamStore.create({
    id: "natural-test",
    purpose: "Test natural observation",
    projectRoot: root,
    gitCommonDir: `${root}/.git`,
    coordinator: {
      sessionId: "coordinator",
      sessionFile: `${root}/coordinator.jsonl`,
    },
  });
}

test("direct native outcome accepts the authorized tracked edit and rejects untracked effects", () => {
  const before = new Map([
    ["README.md", "cmVhZG1l"],
    ["value.txt", "YmVmb3JlCg=="],
  ]);
  const after = new Map([
    ["README.md", "cmVhZG1l"],
    ["value.txt", "YWZ0ZXIK"],
  ]);
  const direct = observeDirectEffect(before, after, "YWZ0ZXIK");
  assert.equal(direct.valid, true);
  assert.deepEqual(direct.changedPaths, ["value.txt"]);

  const withScratch = new Map(after).set("probe.txt", "c2NyYXRjaA==");
  const rejected = observeDirectEffect(before, withScratch, "YWZ0ZXIK");
  assert.equal(rejected.valid, false);
  assert.deepEqual(rejected.changedPaths, ["probe.txt", "value.txt"]);
});

test("delegated native outcome requires attributable composition, cleanup, and retained experiment output", async () => {
  const { state } = await baseState();
  const now = new Date().toISOString();
  state.lifecycle = { state: "completed", changedAt: now, reason: "done" };
  state.assignments.push(
    {
      id: "experiment",
      objective: "Observe bytes",
      intentVersion: 1,
      createdAt: now,
      capability: "research",
      artifactIntent: "disposable_experiment",
      authority: { receiptId: "receipt", intentVersion: 1 },
      permittedEffects: ["write probe.txt"],
      stopCondition: "one observation",
      expectedEvidence: ["probe bytes"],
      artifactPolicy: { retain: ["probe.txt"], discardOthers: true },
    },
    {
      id: "implementation",
      objective: "Update value",
      intentVersion: 1,
      createdAt: now,
      capability: "implement",
      artifactIntent: "maintained_change",
      authority: { receiptId: "receipt", intentVersion: 1 },
      acceptance: ["exact bytes"],
    },
  );
  state.attempts.push(
    {
      id: "attempt-experiment",
      assignmentId: "experiment",
      state: "settled",
      createdAt: now,
      updatedAt: now,
      sessionFile: "/tmp/experiment.jsonl",
      resultId: "result-experiment",
      worker: {
        workspaceId: "workspace",
        tabId: "tab",
        paneId: "pane",
        terminalId: "terminal",
        agentName: "worker-experiment",
        cwd: "/tmp/natural-test",
        sessionFile: "/tmp/experiment.jsonl",
      },
      cleanup: {
        state: "completed",
        expectedHead: "base",
        workerClosed: true,
        discard: true,
      },
    },
    {
      id: "attempt-implementation",
      assignmentId: "implementation",
      state: "settled",
      createdAt: now,
      updatedAt: now,
      sessionFile: "/tmp/implementation.jsonl",
      resultId: "result-implementation",
      worker: {
        workspaceId: "workspace",
        tabId: "tab",
        paneId: "pane",
        terminalId: "terminal",
        agentName: "worker-implementation",
        cwd: "/tmp/natural-test",
        sessionFile: "/tmp/implementation.jsonl",
      },
      composition: {
        state: "composed",
        commit: "commit",
        expectedHead: "base",
        revision: "revision",
      },
      cleanup: {
        state: "completed",
        expectedHead: "commit",
        workerClosed: true,
        discard: false,
      },
    },
  );
  state.results.push(
    {
      id: "result-experiment",
      assignmentId: "experiment",
      assignmentIntentVersion: 1,
      validity: "typed",
      observedAt: now,
      report: {
        kind: "research",
        status: "completed",
        summary: "observed",
        evidence: [],
        findings: [],
      },
      artifacts: [
        {
          id: "probe.txt",
          kind: "path",
          reference: "/tmp/probe.txt",
          retention: "retained",
          summary: "retained",
        },
      ],
    },
    {
      id: "result-implementation",
      assignmentId: "implementation",
      assignmentIntentVersion: 1,
      validity: "typed",
      observedAt: now,
      report: {
        kind: "implementation",
        status: "completed",
        summary: "changed",
        evidence: [],
        findings: [],
      },
      artifacts: [],
    },
  );
  const effect = observeDirectEffect(
    new Map([["value.txt", "YmVmb3JlCg=="]]),
    new Map([["value.txt", "YWZ0ZXIK"]]),
    "YWZ0ZXIK",
  );
  const result = observeDelegatedOutcome(state, effect);
  assert.equal(result.valid, true);
  assert.equal(result.delegationExercised, true);
  assert.equal(result.experiment, "verified");
});

test("natural observer accepts read-only delegation followed by a direct edit and rejects unaccounted effects", async () => {
  const { state } = await baseState();
  const now = new Date().toISOString();
  state.lifecycle = { state: "completed", changedAt: now, reason: "done" };
  state.assignments.push({
    id: "research",
    objective: "Read the current value",
    intentVersion: 0,
    createdAt: now,
    capability: "research",
    artifactIntent: "evidence_only",
    expectedEvidence: ["value bytes"],
  });
  state.attempts.push({
    id: "attempt-research",
    assignmentId: "research",
    state: "settled",
    createdAt: now,
    updatedAt: now,
    sessionFile: "/tmp/research.jsonl",
    resultId: "result-research",
    worker: {
      workspaceId: "workspace",
      tabId: "tab",
      paneId: "pane",
      terminalId: "terminal",
      agentName: "research-worker",
      cwd: "/tmp/natural-test",
      sessionFile: "/tmp/research.jsonl",
    },
    cleanup: {
      state: "completed",
      expectedHead: "base",
      workerClosed: true,
      discard: false,
    },
  });
  state.results.push({
    id: "result-research",
    assignmentId: "research",
    assignmentIntentVersion: 0,
    validity: "typed",
    observedAt: now,
    report: {
      kind: "research",
      status: "completed",
      summary: "Read value",
      evidence: [],
      findings: [],
    },
    artifacts: [],
  });
  const before = new Map([["value.txt", "YmVmb3JlCg=="]]);
  const after = new Map([["value.txt", "YWZ0ZXIK"]]);
  const mixed = observeDelegatedOutcome(
    state,
    observeDirectEffect(before, after, "YWZ0ZXIK"),
  );
  assert.equal(mixed.valid, true, mixed.detail);
  assert.equal(mixed.delegationExercised, true);
  assert.equal(mixed.implementationOrigin, "direct");

  const unauthorized = observeDelegatedOutcome(
    state,
    observeDirectEffect(
      before,
      new Map([...after, ["probe.txt", "c2NyYXRjaA=="]]),
      "YWZ0ZXIK",
    ),
  );
  assert.equal(unauthorized.valid, false);
  assert.match(unauthorized.detail, /authorized/);

  state.attempts[0]!.state = "running";
  assert.equal(
    observeDelegatedOutcome(
      state,
      observeDirectEffect(before, after, "YWZ0ZXIK"),
    ).valid,
    false,
  );
  state.attempts[0]!.state = "settled";
  delete state.attempts[0]!.worker;
  assert.match(
    observeDelegatedOutcome(
      state,
      observeDirectEffect(before, after, "YWZ0ZXIK"),
    ).detail,
    /no worker identity/,
  );
});

test("native observer requires request progression and reports early blocker or incomplete turns promptly", () => {
  const session = SessionManager.inMemory();
  assert.equal(
    observeCoordinatorTurn(session.getBranch(), request).state,
    "waiting",
  );
  session.appendMessage({
    role: "user",
    content: request,
    timestamp: Date.now(),
  });
  assert.equal(
    observeCoordinatorTurn(session.getBranch(), request).state,
    "waiting",
  );
  failedAssistant(session, "length");
  const incomplete = observeCoordinatorTurn(session.getBranch(), request);
  assert.equal(incomplete.state, "failed");
  assert.match(incomplete.detail, /incomplete/);

  const settled = SessionManager.inMemory();
  settled.appendMessage({
    role: "user",
    content: request,
    timestamp: Date.now(),
  });
  settledAssistant(settled);
  assert.equal(
    observeCoordinatorTurn(settled.getBranch(), request).state,
    "settled",
  );

  const blocked = SessionManager.inMemory();
  blocked.appendMessage({
    role: "user",
    content: request,
    timestamp: Date.now(),
  });
  settledAssistant(
    blocked,
    "I cannot complete the request because access is unavailable.",
  );
  const blocker = observeCoordinatorTurn(blocked.getBranch(), request);
  assert.equal(blocker.state, "blocked");
  assert.match(blocker.detail, /blocker/);

  const failed = SessionManager.inMemory();
  failed.appendMessage({
    role: "user",
    content: request,
    timestamp: Date.now(),
  });
  failedAssistant(failed, "error");
  const failure = observeCoordinatorTurn(failed.getBranch(), request);
  assert.equal(failure.state, "failed");
  assert.match(failure.detail, /error/);
});

test("capability prompt emits the independently specified assignment ids", () => {
  const expected = [
    "baseline-research",
    "uppercase-experiment",
    "update-value",
    "concurrent-readme",
    "exact-revision-review",
  ];
  assert.deepEqual([...CAPABILITY_SCENARIO_ASSIGNMENT_IDS], expected);
  assert.deepEqual(
    capabilityPromptAssignmentIds(capabilityScenarioPrompt("private")),
    expected,
  );

  const mismatch = capabilityScenarioPrompt("private").replace(
    "id baseline-research",
    "id initial-evidence",
  );
  assert.notDeepEqual(capabilityPromptAssignmentIds(mismatch), expected);
});
