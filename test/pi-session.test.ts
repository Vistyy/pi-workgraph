/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/global-date -- Tests own disposable native files and protocol timestamps. */
import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { runNodePlatformPromise } from "../src/node-platform.js";
import {
  createWorkerSessionEffect,
  readWorkerSession,
  WORKER_KICKOFF,
  type WorkerObjective,
  WorkerObjectiveDetailsSchema,
} from "../src/pi-session.js";

const objective: WorkerObjective = {
  content:
    "[WORKGRAPH WORKER OBJECTIVE]\nPurpose: verify exact session ownership\nObjective: exercise readback",
  details: {
    taskId: "session",
    attemptId: "session-1",
    role: "implementation",
    executor: { model: "fixture/executor", thinking: "high" },
  },
};

void test("Worker session creation uses the Attempt id and recovers only the exact header/objective", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-session-"));
  const cwd = join(parent, "cwd");
  const sessionDir = join(parent, "agent", "workgraph", "worker-sessions");
  try {
    assert.equal(Value.Check(WorkerObjectiveDetailsSchema, objective.details), true);
    assert.equal(
      Value.Check(WorkerObjectiveDetailsSchema, { ...objective.details, extra: "rejected" }),
      false,
    );
    const first = await runNodePlatformPromise(
      createWorkerSessionEffect({ cwd, sessionDir, objective }),
    );
    assert.equal(first.fresh, true);
    const opened = SessionManager.open(first.sessionFile);
    assert.equal(opened.getHeader()?.id, objective.details.attemptId);
    assert.equal(opened.getHeader()?.cwd, cwd);
    assert.equal(opened.getHeader()?.parentSession, undefined);
    assert.equal(opened.getSessionDir(), sessionDir);
    assert.deepEqual(
      await runNodePlatformPromise(createWorkerSessionEffect({ cwd, sessionDir, objective })),
      { sessionFile: first.sessionFile, fresh: false },
    );

    const objectiveEntries = opened
      .getBranch()
      .filter(
        (entry) => entry.type === "custom_message" && entry.customType === "pi-workgraph-objective",
      );
    assert.equal(objectiveEntries.length, 1);
    assert.equal(
      opened
        .getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "assistant").length,
      1,
    );
    await assert.rejects(
      runNodePlatformPromise(
        createWorkerSessionEffect({ cwd: join(parent, "other"), sessionDir, objective }),
      ),
      /header and objective/,
    );

    await copyFile(first.sessionFile, join(sessionDir, "duplicate_session-1.jsonl"));
    await assert.rejects(
      runNodePlatformPromise(createWorkerSessionEffect({ cwd, sessionDir, objective })),
      /Multiple Worker sessions/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("Worker session readback derives ordered actual models, settlement, and semantic report", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-readback-"));
  const cwd = join(parent, "cwd");
  const sessionDir = join(parent, "sessions");
  try {
    const created = await runNodePlatformPromise(
      createWorkerSessionEffect({ cwd, sessionDir, objective }),
    );
    const file = created.sessionFile;
    const session = SessionManager.open(file);
    session.appendCustomEntry("pi-workgraph-effective-model", {
      model: "fixture/guide",
      thinking: "medium",
    });
    session.appendMessage({ role: "user", content: WORKER_KICKOFF, timestamp: Date.now() });
    session.appendCustomEntry("pi-workgraph-effective-model", {
      model: "fixture/executor",
      thinking: "high",
    });
    session.appendCustomEntry("pi-workgraph-effective-model", {
      model: "fixture/guide",
      thinking: "medium",
    });
    session.appendMessage({
      role: "toolResult",
      toolCallId: "report",
      toolName: "workgraph_report",
      content: [{ type: "text", text: "done" }],
      details: {
        report: {
          kind: "implementation",
          status: "completed",
          outcome: "changed",
          summary: "Changed the bounded target.",
          evidence: [],
          findings: [],
        },
      },
      isError: false,
      timestamp: Date.now(),
    });
    session.appendCustomEntry("pi-workgraph-agent-settled", {});

    const read = readWorkerSession(file, cwd, objective);
    assert.equal(read.unreadable, false);
    assert.equal(read.started, true);
    assert.equal(read.kickoffPersisted, true);
    assert.equal(read.settled, true);
    assert.deepEqual(read.effectiveModels, [
      { model: "fixture/guide", thinking: "medium" },
      { model: "fixture/executor", thinking: "high" },
    ]);
    if (!read.unreadable) assert.equal(read.report?.kind, "implementation");

    const wrong = readWorkerSession(file, join(parent, "wrong"), objective);
    assert.equal(wrong.unreadable, true);
    assert.match(wrong.unreadable ? wrong.error : "", /header/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("settled readable sessions expose bounded report errors", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-report-error-"));
  const cwd = join(parent, "cwd");
  try {
    const created = await runNodePlatformPromise(
      createWorkerSessionEffect({ cwd, sessionDir: join(parent, "sessions"), objective }),
    );
    const file = created.sessionFile;
    const session = SessionManager.open(file);
    session.appendCustomEntry("pi-workgraph-effective-model", {
      model: "fixture/guide",
      thinking: "medium",
    });
    session.appendCustomEntry("pi-workgraph-agent-settled", {});
    const read = readWorkerSession(file, cwd, objective);
    assert.equal(read.unreadable, false);
    if (!read.unreadable) assert.match(read.reportError ?? "", /no successful terminal report/);

    const mismatched = readWorkerSession(file, cwd, {
      ...objective,
      content: `${objective.content}\nDifferent acceptance`,
    });
    assert.equal(mismatched.unreadable, false);
    if (!mismatched.unreadable) {
      assert.equal(mismatched.started, true);
      assert.equal(mismatched.settled, true);
      assert.match(mismatched.reportError ?? "", /objective.*mismatched/i);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
