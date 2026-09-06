import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inspectView,
  resolveAttemptHandle,
  resultNotification,
} from "../src/agent-facing.js";
import { WorkstreamStore } from "../src/workstream.js";

const coordinator = {
  sessionId: "agent-facing-test",
  sessionFile: "/tmp/agent-facing-test.jsonl",
};

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-agent-facing-"));
  const { store } = await WorkstreamStore.create({
    id: "agent-facing",
    purpose: "Test bounded agent-facing projections.",
    projectRoot: join(parent, "project"),
    gitCommonDir: join(parent, "project", ".git"),
    coordinator,
  });
  return { parent, store };
}

test("overview task index recovers every arbitrary task id", async () => {
  const { parent, store } = await fixture();
  try {
    const ids = Array.from({ length: 27 }, (_, index) =>
      index === 3
        ? "Task with spaces, uppercase, and a deliberately long semantic identifier"
        : `task ${index} with spaces`,
    );
    for (const id of ids)
      await store.assign({
        id,
        capability: "research",
        artifactIntent: "evidence_only",
        objective: `Read ${id}`,
        intentVersion: 0,
        expectedEvidence: ["bytes"],
      });
    const recovered: string[] = [];
    let offset = 0;
    let truncated = true;
    while (truncated) {
      const view = inspectView(await store.load(), {
        section: "overview",
        offset,
        maxChars: 31,
      }) as {
        taskIndex: {
          text: string;
          truncated: boolean;
          next?: { offset: number };
        };
      };
      recovered.push(view.taskIndex.text);
      truncated = view.taskIndex.truncated;
      offset = view.taskIndex.next?.offset ?? offset;
    }
    assert.equal(recovered.join(""), JSON.stringify(ids));
    const overview = inspectView(await store.load(), {
      section: "overview",
      maxItems: 4,
    }) as { tasks: { totalItems: number; truncated: boolean; next?: unknown } };
    assert.equal(overview.tasks.totalItems, ids.length);
    assert.equal(overview.tasks.truncated, true);
    assert.ok(overview.tasks.next);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("pending explicit attempt does not inherit a sibling outcome and mismatches fail", async () => {
  const { parent, store } = await fixture();
  try {
    await store.enqueue(
      {
        id: "research task",
        capability: "research",
        artifactIntent: "evidence_only",
        objective: "Read the fixture",
        intentVersion: 0,
        expectedEvidence: ["bytes"],
      },
      {
        id: "opaque-pending",
        models: {
          guide: { model: "fixture/research", thinking: "low" },
          source: "policy",
        },
      },
    );
    await store.retainResult({
      id: "opaque-sibling-result",
      assignmentId: "research task",
      assignmentIntentVersion: 0,
      validity: "typed",
      report: {
        kind: "research",
        status: "completed",
        summary: "Sibling",
        evidence: [],
        findings: [],
      },
    });
    const pending = inspectView(await store.load(), {
      section: "outcome",
      attempt: "opaque-pending",
    }) as { state: string; attempt?: { state: string } };
    assert.equal(pending.state, "pending");
    assert.equal(pending.attempt?.state, "queued");
    const mismatchState = await store.load();
    assert.throws(
      () =>
        inspectView(mismatchState, {
          section: "outcome",
          attempt: "opaque-pending",
          result: "opaque-sibling-result",
        }),
      /has no retained outcome/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("prelaunch recovery does not claim native settlement", async () => {
  const { parent, store } = await fixture();
  try {
    await store.enqueue(
      {
        id: "prelaunch",
        capability: "research",
        artifactIntent: "evidence_only",
        objective: "Read before launch",
        intentVersion: 0,
        expectedEvidence: ["bytes"],
      },
      {
        id: "opaque-prelaunch",
        models: {
          guide: { model: "fixture/research", thinking: "low" },
          source: "policy",
        },
      },
    );
    const attempt = (await store.load()).attempts[0]!;
    const view = inspectView(await store.load(), {
      section: "recovery",
      attempt: attempt.id,
    }) as {
      recordedFacts: {
        launch: string;
        runtimeSettlement: string;
        nativeOrGitStateFromTerminalStateAlone: boolean;
      };
    };
    assert.equal(view.recordedFacts.launch, "never_launched");
    assert.equal(view.recordedFacts.runtimeSettlement, "not_recorded");
    assert.equal(
      view.recordedFacts.nativeOrGitStateFromTerminalStateAlone,
      false,
    );
    const state = await store.load();
    state.attempts[0]!.error = "Inspect uncertain launch before retrying.";
    state.assignments.push({ ...state.assignments[0]!, id: "other" });
    state.attempts.push({
      ...attempt,
      id: "other-attempt",
      assignmentId: "other",
    });
    const recovery = inspectView(state, {
      section: "recovery",
      attempt: attempt.id,
    }) as { guardedAction: { attempt: string } };
    assert.equal(
      resolveAttemptHandle(state, recovery.guardedAction.attempt).id,
      attempt.id,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("large delivery errors and retained artifacts stay bounded with lossless artifact access", async () => {
  const { parent, store } = await fixture();
  try {
    await store.assign({
      id: "delivery",
      capability: "research",
      artifactIntent: "evidence_only",
      objective: "Read delivery",
      intentVersion: 0,
      expectedEvidence: ["bytes"],
    });
    const artifacts = [
      {
        id: "probe",
        kind: "path" as const,
        reference: "/retained/probe.txt",
        retention: "retained" as const,
        summary: "artifact detail ".repeat(1_000),
      },
    ];
    await store.retainResult({
      id: "delivery-result",
      artifacts,
      assignmentId: "delivery",
      assignmentIntentVersion: 0,
      validity: "typed",
      report: {
        kind: "research",
        status: "completed",
        summary: "Small",
        evidence: [],
        findings: [],
      },
    });
    await store.requestDelivery("delivery-result");
    const largeError = `delivery-error-${"x".repeat(100_000)}`;
    await store.deliveryAttempt("delivery-result", "wake", largeError);
    const notice = resultNotification(await store.load(), "delivery-result");
    assert.ok(notice.length < 12_000);
    assert.equal(notice.includes(largeError), false);
    assert.ok(notice.includes(artifacts[0]!.reference));
    const state = await store.load();
    let offset = 0;
    let recovered = "";
    for (;;) {
      const view = inspectView(state, {
        section: "outcome",
        result: "delivery-result",
        offset,
        maxChars: 1_000,
      }) as {
        retainedArtifacts: {
          text: string;
          next?: { section: string; result: string; offset: number };
        };
      };
      recovered += view.retainedArtifacts.text;
      const next = view.retainedArtifacts.next;
      if (!next) break;
      assert.equal(next.section, "outcome");
      assert.equal(next.result, "delivery-result");
      offset = next.offset;
    }
    assert.deepEqual(JSON.parse(recovered), artifacts);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
