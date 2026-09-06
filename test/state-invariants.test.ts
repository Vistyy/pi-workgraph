import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Persisted-state fixtures intentionally cross the real host filesystem boundary.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Fixture paths are host filesystem identities.
import { join } from "node:path";
import test from "node:test";
import { DateTime } from "effect";
import { type SessionIdentity, type WorkstreamState, WorkstreamStore } from "../src/workstream.js";
import { hasActiveOrUncleanAttempt } from "../src/workstream-transitions.js";
import { researchReport } from "./helpers.js";

const coordinator: SessionIdentity = {
  sessionId: "coordinator-session",
  sessionFile: "/sessions/coordinator.jsonl",
};

void test("persisted launch checkpoints reject impossible submission states and retain recovery progress", async () => {
  const fixture = await stateFixture();
  try {
    await fixture.store.enqueue(
      {
        id: "research",
        capability: "research",
        artifactIntent: "evidence_only",
        objective: "Inspect launch checkpoints.",
        intentVersion: 0,
        expectedEvidence: ["Persisted launch state."],
      },
      {
        id: "attempt",
        models: {
          guide: { model: "fixture/research", thinking: "low" },
          source: "policy",
        },
      },
    );
    await fixture.store.startAttempt({
      id: "attempt",
      placement: { kind: "shared_project", path: fixture.projectRoot },
    });
    const startingNotSent = await fixture.store.load();
    await fixture.store.recordSessionFile("attempt", "/tmp/worker-session.jsonl");
    const startingWithSession = await fixture.store.load();
    await fixture.store.markSubmission("attempt", "uncertain");
    const uncertain = await fixture.store.load();
    await fixture.store.markSubmission("attempt", "submitted");
    const submitted = await fixture.store.load();
    await fixture.store.markSubmission("attempt", "started");
    const started = await fixture.store.load();
    await fixture.store.retainResult({
      id: "result",
      assignmentId: "research",
      assignmentIntentVersion: 0,
      validity: "typed",
      report: researchReport("Launch progress was inspected."),
    });
    await fixture.store.settleAttempt({
      id: "attempt",
      resultId: "result",
      effectiveModels: [{ model: "fixture/research", thinking: "low" }],
    });
    const settled = await fixture.store.load();

    for (const [label, state] of [
      ["starting not_sent", startingNotSent],
      ["starting with retained session", startingWithSession],
      ["starting uncertain", uncertain],
      ["running submitted", submitted],
      ["running started", started],
      ["settled", settled],
    ] as const)
      await assert.doesNotReject(
        persistAndInspect(fixture.store.path, state),
        `${label} checkpoint should decode`,
      );

    for (const submission of ["submitted", "started"] as const) {
      const impossibleStarting = structuredClone(startingWithSession);
      const attempt = requiredAttempt(impossibleStarting);
      attempt.submission = submission;
      await assert.rejects(
        persistAndInspect(fixture.store.path, impossibleStarting),
        /Starting attempt attempt contains a submitted launch checkpoint/,
      );
    }

    const missingUncertainSession = structuredClone(uncertain);
    delete requiredAttempt(missingUncertainSession).sessionFile;
    await assert.rejects(
      persistAndInspect(fixture.store.path, missingUncertainSession),
      /sent checkpoint has no retained session/,
    );

    const missingSubmittedSession = structuredClone(submitted);
    delete requiredAttempt(missingSubmittedSession).sessionFile;
    await assert.rejects(
      persistAndInspect(fixture.store.path, missingSubmittedSession),
      /sent checkpoint has no retained session/,
    );
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

void test("persisted cleanup checkpoints require coherent blockers and proven worker closure", async () => {
  const fixture = await settledFixture();
  try {
    const notRecorded = await fixture.store.load();
    await fixture.store.beginCleanup({ id: "attempt", discard: false });
    const pending = await fixture.store.load();
    await fixture.store.blockCleanup("attempt", "Worker closure is not yet proven.");
    const blocked = await fixture.store.load();
    await fixture.store.retryCleanup("attempt");
    await fixture.store.markWorkerClosed("attempt");
    const workerClosed = await fixture.store.load();
    await fixture.store.blockCleanup("attempt", "Placement cleanup needs recovery.");
    const blockedAfterClosure = await fixture.store.load();
    await fixture.store.retryCleanup("attempt");
    await fixture.store.finishCleanup("attempt");
    const completed = await fixture.store.load();

    for (const [label, state] of [
      ["not recorded", notRecorded],
      ["pending worker closure", pending],
      ["blocked worker closure", blocked],
      ["pending placement cleanup", workerClosed],
      ["blocked placement cleanup", blockedAfterClosure],
      ["completed cleanup", completed],
    ] as const)
      await assert.doesNotReject(
        persistAndInspect(fixture.store.path, state),
        `${label} checkpoint should decode`,
      );

    const completedWithoutClosure = structuredClone(completed);
    const uncleanAttempt = requiredAttempt(completedWithoutClosure);
    assert.ok(uncleanAttempt.cleanup);
    uncleanAttempt.cleanup.workerClosed = false;
    assert.equal(hasActiveOrUncleanAttempt(uncleanAttempt), true);
    await assert.rejects(
      persistAndInspect(fixture.store.path, completedWithoutClosure),
      /completed cleanup has no closed worker/,
    );

    const completedWithBlocker = structuredClone(completed);
    const completedCleanup = requiredAttempt(completedWithBlocker).cleanup;
    assert.ok(completedCleanup);
    completedCleanup.error = "Contradictory completed blocker.";
    await assert.rejects(
      persistAndInspect(fixture.store.path, completedWithBlocker),
      /cleanup blocker does not match its state/,
    );

    const pendingWithBlocker = structuredClone(pending);
    const pendingCleanup = requiredAttempt(pendingWithBlocker).cleanup;
    assert.ok(pendingCleanup);
    pendingCleanup.error = "Contradictory pending blocker.";
    await assert.rejects(
      persistAndInspect(fixture.store.path, pendingWithBlocker),
      /cleanup blocker does not match its state/,
    );

    const blockedWithoutError = structuredClone(blocked);
    const blockedCleanup = requiredAttempt(blockedWithoutError).cleanup;
    assert.ok(blockedCleanup);
    delete blockedCleanup.error;
    await assert.rejects(
      persistAndInspect(fixture.store.path, blockedWithoutError),
      /cleanup blocker does not match its state/,
    );
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

void test("persisted unlaunched and launched cancellation histories remain valid", async () => {
  const fixture = await stateFixture();
  try {
    await fixture.store.enqueue(
      {
        id: "cancelled-work",
        capability: "research",
        artifactIntent: "evidence_only",
        objective: "Retain cancellation history.",
        intentVersion: 0,
        expectedEvidence: ["Cancellation checkpoint."],
      },
      [
        {
          id: "unlaunched",
          models: {
            guide: { model: "fixture/research", thinking: "low" },
            source: "policy",
          },
        },
        {
          id: "launched",
          models: {
            guide: { model: "fixture/research", thinking: "low" },
            source: "policy",
          },
        },
      ],
    );
    await fixture.store.cancelAttempt("unlaunched");
    const unlaunched = await fixture.store.load();
    await fixture.store.startAttempt({
      id: "launched",
      placement: { kind: "shared_project", path: fixture.projectRoot },
    });
    await fixture.store.recordSessionFile("launched", "/tmp/cancelled-session.jsonl");
    await fixture.store.markSubmission("launched", "uncertain");
    await fixture.store.cancelAttempt("launched");
    const cancelRequested = await fixture.store.load();
    await fixture.store.retainResult({
      id: "cancelled-result",
      assignmentId: "cancelled-work",
      assignmentIntentVersion: 0,
      validity: "typed",
      report: researchReport("Cancellation retained a terminal report."),
    });
    await fixture.store.settleAttempt({
      id: "launched",
      resultId: "cancelled-result",
      effectiveModels: [{ model: "fixture/research", thinking: "low" }],
    });
    await fixture.store.beginCleanup({ id: "launched", discard: false });
    await fixture.store.markWorkerClosed("launched");
    await fixture.store.finishCleanup("launched");
    const cancelled = await fixture.store.load();

    for (const [label, state] of [
      ["unlaunched cancellation", unlaunched],
      ["uncertain cancellation request", cancelRequested],
      ["settled cancellation", cancelled],
    ] as const)
      await assert.doesNotReject(
        persistAndInspect(fixture.store.path, state),
        `${label} checkpoint should decode`,
      );
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

async function stateFixture(): Promise<{
  parent: string;
  projectRoot: string;
  store: WorkstreamStore;
}> {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-state-invariants-"));
  const projectRoot = join(parent, "project");
  await mkdir(join(projectRoot, ".git"), { recursive: true });
  const { store } = await WorkstreamStore.create({
    id: "workstream",
    purpose: "Exercise persisted state invariants.",
    projectRoot,
    gitCommonDir: join(projectRoot, ".git"),
    coordinator,
    now: DateTime.toDate(DateTime.makeUnsafe(0)),
  });
  return { parent, projectRoot, store };
}

async function settledFixture(): Promise<{
  parent: string;
  projectRoot: string;
  store: WorkstreamStore;
}> {
  const fixture = await stateFixture();
  await fixture.store.enqueue(
    {
      id: "research",
      capability: "research",
      artifactIntent: "evidence_only",
      objective: "Inspect cleanup checkpoints.",
      intentVersion: 0,
      expectedEvidence: ["Persisted cleanup state."],
    },
    {
      id: "attempt",
      models: {
        guide: { model: "fixture/research", thinking: "low" },
        source: "policy",
      },
    },
  );
  await fixture.store.startAttempt({
    id: "attempt",
    placement: { kind: "shared_project", path: fixture.projectRoot },
  });
  await fixture.store.recordSessionFile("attempt", "/tmp/worker-session.jsonl");
  await fixture.store.markSubmission("attempt", "uncertain");
  await fixture.store.markSubmission("attempt", "submitted");
  await fixture.store.retainResult({
    id: "result",
    assignmentId: "research",
    assignmentIntentVersion: 0,
    validity: "typed",
    report: researchReport("Cleanup progress was inspected."),
  });
  await fixture.store.settleAttempt({
    id: "attempt",
    resultId: "result",
    effectiveModels: [{ model: "fixture/research", thinking: "low" }],
  });
  return fixture;
}

function requiredAttempt(state: WorkstreamState) {
  const attempt = state.attempts.find((candidate) => candidate.id === "attempt");
  assert.ok(attempt);
  return attempt;
}

async function persistAndInspect(path: string, state: WorkstreamState): Promise<WorkstreamState> {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
  return WorkstreamStore.inspect(path);
}
