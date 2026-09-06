import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Fixtures intentionally use real host storage at the node:test boundary.
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Fixture paths are host filesystem identities.
import { join } from "node:path";
import test from "node:test";
import { DateTime, Effect } from "effect";
import {
  type AuthorityReference,
  type HumanInputReceipt,
  InvalidWorkstreamStateError,
  type SessionIdentity,
  UnsupportedWorkstreamStateError,
  type WorkstreamState,
  WorkstreamStore,
} from "../src/workstream.js";
import { deriveCompletionAccounting } from "../src/workstream-transitions.js";
import { parsePersistedObject } from "../src/workstream-validation.js";
import { researchReport } from "./helpers.js";

function dateAt(milliseconds: number): Date {
  return DateTime.toDate(DateTime.makeUnsafe(milliseconds));
}

void test("accepted historical research closes its original scope after intent changes, without invented limitations", async () => {
  const { parent, store } = await fixture();
  try {
    await store.assign({
      id: "baseline",
      capability: "research",
      artifactIntent: "evidence_only",
      objective: "Read baseline",
      intentVersion: 0,
      expectedEvidence: ["Baseline bytes"],
    });
    await store.retainResult({
      id: "baseline-result",
      assignmentId: "baseline",
      assignmentIntentVersion: 0,
      validity: "typed",
      report: researchReport("Baseline observed"),
    });
    await store.disposition({
      resultId: "baseline-result",
      status: "accepted",
      reason: "Answers the original baseline question",
    });
    await recordedAuthority(store);
    const revised = await store.load();
    assert.equal(store.isResultCurrent(revised, "baseline-result"), false);
    assert.equal(revised.results[0]?.assignmentIntentVersion, 0);
    const state = await store.complete({
      conclusion: "Baseline research is resolved in its original scope",
      evidence: [{ label: "Baseline", observation: "Evidence predates the new intent" }],
      limitations: [],
      reasons: [],
    });
    assert.deepEqual(state.completion?.accounting, []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("accepting a failed report or uncomposed stale implementation as evidence does not resolve its assignment", async () => {
  for (const capability of ["research", "implement"] as const) {
    const { parent, store } = await fixture();
    try {
      const { receipt, authority } = await recordedAuthority(store);
      if (capability === "research")
        await store.assign({
          id: "work",
          capability,
          artifactIntent: "evidence_only",
          objective: "Read",
          intentVersion: 1,
          expectedEvidence: ["Bytes"],
        });
      else
        await store.assign({
          id: "work",
          capability,
          artifactIntent: "maintained_change",
          objective: "Change",
          intentVersion: 1,
          authority,
          acceptance: ["Correct bytes"],
        });
      await store.retainResult({
        id: "result",
        assignmentId: "work",
        assignmentIntentVersion: 1,
        validity: "typed",
        report:
          capability === "research"
            ? { ...researchReport("Could not read"), status: "failed" }
            : {
                kind: "implementation",
                status: "completed",
                outcome: "changed",
                summary: "Old change",
                commit: "a".repeat(40),
                evidence: [],
                findings: [],
              },
      });
      await store.disposition({
        resultId: "result",
        status: "accepted",
        reason: "Accepted as evidence, not proof of current completion",
      });
      await store.reviseIntent({
        authorityReceiptId: receipt.id,
        statement: "Changed requirements",
        constraints: ["New constraint"],
      });
      const completion = {
        conclusion: "Known unresolved work",
        evidence: [{ label: "Result", observation: "The assignment is not fulfilled" }],
        limitations: [],
        reasons: [],
      };
      await assert.rejects(
        store.complete(completion),
        /Completion requires exactly one reason per unresolved semantic task/,
      );
      const state = await store.complete({
        ...completion,
        limitations: [
          capability === "research" ? "The read failed" : "The stale change was never composed",
        ],
        reasons: [
          {
            taskId: "work",
            reason: "The assignment and its result are unresolved.",
          },
        ],
      });
      assert.deepEqual(
        state.completion?.accounting.map((item) =>
          item.kind === "unresolved_assignment"
            ? item.assignmentId
            : item.kind === "unresolved_result"
              ? item.resultId
              : "",
        ),
        capability === "research" ? ["work", "result"] : ["work"],
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }
});

const coordinator: SessionIdentity = {
  sessionId: "coordinator-session",
  sessionFile: "/sessions/coordinator.jsonl",
};

function fixture(): Promise<{ parent: string; store: WorkstreamStore }> {
  return mkdtemp(join(tmpdir(), "pi-workgraph-workstream-")).then((parent) =>
    WorkstreamStore.create({
      id: "workstream",
      purpose: "Determine the safe fixture change.",
      projectRoot: join(parent, "project"),
      gitCommonDir: join(parent, "project", ".git"),
      coordinator,
      now: dateAt(0),
    }).then(({ store }) => ({ parent, store })),
  );
}

function recordedAuthority(
  store: WorkstreamStore,
): Promise<{ receipt: HumanInputReceipt; authority: AuthorityReference }> {
  return store
    .recordInputEvent({
      ...coordinator,
      source: "interactive",
      text: "I approve the bounded fixture experiment and maintained correction.",
      now: dateAt(1_000),
    })
    .then(({ receipt }) =>
      store
        .reviseIntent({
          authorityReceiptId: receipt.id,
          statement: "Establish and correct the fixture behavior.",
          constraints: ["Keep the fixture local."],
          now: dateAt(2_000),
        })
        .then((revised) => {
          const intent = revised.intents.at(-1);
          if (!intent) throw new Error("Fixture intent was not recorded.");
          return { receipt, authority: { receiptId: receipt.id, intentVersion: intent.version } };
        }),
    );
}

void test("workstream persists human-backed intent, local readiness, and retained experiment evidence", async () => {
  const { parent, store } = await fixture();
  try {
    const { authority } = await recordedAuthority(store);
    let state = await store.assign({
      id: "research",
      capability: "research",
      artifactIntent: "evidence_only",
      objective: "Inspect the fixture behavior.",
      intentVersion: authority.intentVersion,
      expectedEvidence: ["A direct fixture observation."],
      now: dateAt(3_000),
    });
    assert.equal(state.assignments[0]?.capability, "research");

    state = await store.assign({
      id: "experiment",
      capability: "research",
      artifactIntent: "disposable_experiment",
      objective: "Probe whether the fixture accepts the candidate input.",
      intentVersion: authority.intentVersion,
      authority,
      permittedEffects: ["Write only under the disposable experiment directory."],
      stopCondition: "The fixture either accepts or rejects the candidate input.",
      expectedEvidence: ["The observed fixture output."],
      artifactPolicy: { retain: ["experiment-log"], discardOthers: true },
      now: dateAt(4_000),
    });
    assert.equal(state.assignments[1]?.artifactIntent, "disposable_experiment");

    await assert.rejects(
      store.retainResult({
        id: "unplanned-experiment-result",
        assignmentId: "experiment",
        assignmentIntentVersion: authority.intentVersion,
        validity: "typed",
        report: researchReport("The probe produced an unplanned artifact."),
        artifacts: [
          {
            id: "unplanned",
            kind: "path",
            reference: "artifacts/unplanned.log",
            retention: "retained",
            summary: "Not approved for retention.",
          },
        ],
      }),
      /exactly the artifacts named by its policy/,
    );

    state = await store.retainResult({
      id: "experiment-result",
      assignmentId: "experiment",
      assignmentIntentVersion: authority.intentVersion,
      validity: "typed",
      report: researchReport("The disposable probe rejected the candidate."),
      artifacts: [
        {
          id: "experiment-log",
          kind: "path",
          reference: "artifacts/experiment.log",
          retention: "retained",
          summary: "The bounded experiment output.",
        },
      ],
      now: dateAt(5_000),
    });
    assert.equal(state.results[0]?.artifacts[0]?.retention, "retained");

    state = await store.assign({
      id: "review",
      capability: "review",
      artifactIntent: "evidence_only",
      objective: "Review the experiment result.",
      intentVersion: authority.intentVersion,
      subject: {
        kind: "artifact",
        resultId: "experiment-result",
        artifactId: "experiment-log",
      },
      concern: "Does the retained output support the proposed conclusion?",
      now: dateAt(6_000),
    });
    assert.equal(state.assignments[2]?.capability, "review");

    const persisted = await WorkstreamStore.inspect(state.statePath);
    assert.deepEqual(
      persisted.assignments.map((assignment) => assignment.id),
      ["research", "experiment", "review"],
    );
    const experimentResult = persisted.results[0];
    assert.ok(experimentResult && experimentResult.validity === "typed");
    assert.equal(experimentResult.report.summary, "The disposable probe rejected the candidate.");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("workstream rejects extension or arbitrary authority and stale intent", async () => {
  const { parent, store } = await fixture();
  try {
    await assert.rejects(
      store.recordInputEvent({
        ...coordinator,
        source: "extension",
        text: "approved",
      }),
      /Extension-generated input/,
    );
    await assert.rejects(
      store.reviseIntent({
        authorityReceiptId: "invented",
        statement: "Mutate the fixture.",
        constraints: [],
      }),
      /Unknown human input receipt/,
    );

    const { receipt, authority } = await recordedAuthority(store);
    await assert.rejects(
      store.assign({
        id: "invalid-experiment",
        capability: "research",
        artifactIntent: "disposable_experiment",
        objective: "Run an unauthorized probe.",
        intentVersion: authority.intentVersion,
        authority: {
          receiptId: "invented",
          intentVersion: authority.intentVersion,
        },
        permittedEffects: ["Write an experiment file."],
        stopCondition: "The probe finishes.",
        expectedEvidence: ["Probe output."],
        artifactPolicy: { retain: [], discardOthers: true },
      }),
      /retained human-backed intent/,
    );

    const changed = await store.reviseIntent({
      authorityReceiptId: receipt.id,
      statement: "Correct the fixture with the newly added constraint.",
      constraints: ["Do not alter the fixture API."],
    });
    assert.equal(changed.intents.at(-1)?.version, authority.intentVersion + 1);
    await assert.rejects(
      store.assign({
        id: "stale-implementation",
        capability: "implement",
        artifactIntent: "maintained_change",
        objective: "Apply the old correction.",
        intentVersion: authority.intentVersion,
        authority,
        acceptance: ["The fixture passes."],
      }),
      /stale/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("workstream keeps worker validity, disposition, limitations, and stale results distinct", async () => {
  const { parent, store } = await fixture();
  try {
    const { receipt, authority } = await recordedAuthority(store);
    await store.assign({
      id: "research",
      capability: "research",
      artifactIntent: "evidence_only",
      objective: "Determine the fixture behavior.",
      intentVersion: authority.intentVersion,
      expectedEvidence: ["Direct fixture evidence."],
    });
    let state = await store.retainResult({
      id: "research-result",
      assignmentId: "research",
      assignmentIntentVersion: authority.intentVersion,
      validity: "typed",
      report: researchReport("The fixture currently accepts the input."),
    });
    assert.equal(store.isResultCurrent(state, "research-result"), true);
    state = await store.disposition({
      resultId: "research-result",
      status: "accepted",
      reason: "The evidence answers the bounded question.",
    });
    assert.equal(state.dispositions[0]?.status, "accepted");

    state = await store.reviseIntent({
      authorityReceiptId: receipt.id,
      statement: "Determine behavior under the new fixture constraint.",
      constraints: ["Exercise a second fixture input."],
    });
    assert.equal(store.isResultCurrent(state, "research-result"), false);
    state = await store.retainResult({
      id: "stale-result",
      assignmentId: "research",
      assignmentIntentVersion: authority.intentVersion,
      validity: "untyped",
      text: "Old worker prose.",
    });
    assert.equal(store.isResultCurrent(state, "stale-result"), false);

    state = await store.complete({
      conclusion:
        "The earlier fixture answer is retained but does not answer the revised question.",
      evidence: [
        {
          label: "retained result",
          observation: "The first result was produced under intent version 1.",
          class: "unknown",
        },
      ],
      limitations: ["The revised constraint has no accepted result yet."],
      reasons: [
        {
          taskId: "research",
          reason: "The revised assignment and stale result are unresolved.",
        },
      ],
    });
    assert.equal(state.lifecycle.state, "completed");
    assert.deepEqual(
      state.completion?.accounting.map((item) =>
        item.kind === "unresolved_assignment"
          ? item.assignmentId
          : item.kind === "unresolved_result"
            ? item.resultId
            : "",
      ),
      ["research", "stale-result"],
    );
    assert.equal(state.completion?.evidence[0]?.class, "unknown");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("every independent attempt remains accounted for regardless of result arrival order", async () => {
  for (const order of [
    ["failed", "success"],
    ["success", "failed"],
  ]) {
    const { parent, store } = await fixture();
    try {
      const queued = await store.enqueue(
        {
          id: "comparison",
          capability: "research",
          artifactIntent: "evidence_only",
          objective: "Compare independent observations",
          intentVersion: 0,
          expectedEvidence: ["Observation"],
        },
        order.map((_, index) => ({
          id: `attempt-${index}`,
          models: {
            guide: { model: "fixture/research", thinking: "low" },
            source: "policy" as const,
          },
        })),
      );
      for (let index = 0; index < order.length; index++) {
        await store.startAttempt({
          id: `attempt-${index}`,
          worktreePath: `/tmp/worktree-${index}`,
          branch: `branch-${index}`,
          baseRevision: "a".repeat(40),
        });
        await store.recordLaunchPane(`attempt-${index}`, {
          workspaceId: "fixture",
          paneId: `pane-${index}`,
        });
        await store.recordResource(`attempt-${index}`, {
          workspaceId: "fixture",
          tabId: `tab-${index}`,
          paneId: `pane-${index}`,
          terminalId: `terminal-${index}`,
          agentName: `agent-${index}`,
          cwd: `/tmp/worktree-${index}`,
        });
        await store.recordSessionFile(`attempt-${index}`, `/tmp/session-${index}`);
        await store.markSubmission(`attempt-${index}`, "uncertain");
        await store.markSubmission(`attempt-${index}`, "submitted");
        await store.retainResult({
          id: `result-${index}`,
          assignmentId: "comparison",
          assignmentIntentVersion: 0,
          validity: "typed",
          report: {
            kind: "research" as const,
            status: order[index] === "success" ? ("completed" as const) : ("failed" as const),
            summary: `${order[index]} observation`,
            evidence: [],
            findings: [],
          },
        });
        await store.settleAttempt({
          id: `attempt-${index}`,
          resultId: `result-${index}`,
          effectiveModels: [{ model: "fixture/research", thinking: "low" }],
        });
        await store.beginCleanup({
          id: `attempt-${index}`,
          expectedHead: "a".repeat(40),
          discard: false,
        });
        await store.markWorkerClosed(`attempt-${index}`);
        await store.finishCleanup(`attempt-${index}`);
        await assert.doesNotReject(
          store.recordLaunchPane(`attempt-${index}`, {
            workspaceId: "fixture",
            paneId: `pane-${index}`,
          }),
        );
        await assert.rejects(
          store.recordLaunchPane(`attempt-${index}`, {
            workspaceId: "fixture",
            paneId: "contradictory",
          }),
          /contradictory|not accepting/,
        );
        await assert.rejects(
          store.blockCleanup(`attempt-${index}`, "late cleanup failure"),
          /already completed/,
        );
      }
      const state = await store.load();
      assert.equal(queued.attempts.length, 2);
      await assert.rejects(
        store.complete({
          conclusion: "One contribution failed",
          evidence: [{ label: "comparison", observation: "Both attempts retained" }],
          limitations: ["The failed attempt remains unresolved."],
          reasons: [],
        }),
        /Completion requires exactly one reason per unresolved semantic task/,
      );
      const failed = state.attempts.find((attempt) =>
        attempt.id.endsWith(order.indexOf("failed").toString()),
      );
      assert.ok(failed);
      const failedResult = state.results.find((result) => result.id === failed.resultId);
      assert.ok(failedResult);
      const completed = await store.complete({
        conclusion: "One contribution failed",
        evidence: [{ label: "comparison", observation: "Both attempts retained" }],
        limitations: ["The failed attempt remains unresolved."],
        reasons: [
          {
            taskId: "comparison",
            reason: "One independent attempt and its result failed.",
          },
        ],
      });
      assert.deepEqual(
        completed.completion?.accounting.map((item) =>
          item.kind === "unresolved_assignment"
            ? item.assignmentId
            : item.kind === "unresolved_attempt"
              ? item.attemptId
              : item.kind === "unresolved_result"
                ? item.resultId
                : "",
        ),
        ["comparison", failed.id, failedResult.id],
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }
});

void test("malformed state diagnostics identify a bounded field path without echoing payloads", async () => {
  const { parent, store } = await fixture();
  try {
    const original = await readFile(store.path, "utf8");
    await writeFile(
      store.path,
      original
        .replace(
          '"purpose": "Determine the safe fixture change."',
          '"purpose": "credential=redacted-secret"',
        )
        .replace('"revision": 0', '"revision": "invalid"'),
    );
    await assert.rejects(
      WorkstreamStore.inspect(store.path),
      (error: Error) =>
        error instanceof InvalidWorkstreamStateError &&
        error.message.includes("/revision") &&
        !error.message.includes("credential=redacted-secret"),
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("workstream serializes receipt writes and rejects corrupt or foreign history without rewriting it", async () => {
  const { parent, store } = await fixture();
  try {
    await Promise.all([
      store.recordInputEvent({
        ...coordinator,
        source: "interactive",
        text: "First human constraint.",
      }),
      store.recordInputEvent({
        ...coordinator,
        source: "rpc",
        text: "Second human constraint.",
      }),
      store.recordInputEvent({
        ...coordinator,
        source: "interactive",
        text: "Third human constraint.",
      }),
    ]);
    let state = await store.load();
    assert.equal(state.revision, 3);
    assert.equal(new Set(state.inputs.map((input) => input.id)).size, 3);
    state = await store.setLifecycle({
      state: "suspended",
      reason: "Coordinator is offline.",
    });
    assert.equal(state.lifecycle.state, "suspended");
    await assert.rejects(
      store.assign({
        id: "blocked",
        capability: "research",
        artifactIntent: "evidence_only",
        objective: "Do not queue while suspended.",
        intentVersion: 0,
        expectedEvidence: ["No worker."],
      }),
      /suspended/,
    );
    state = await store.setLifecycle({
      state: "active",
      reason: "Coordinator resumed.",
    });
    assert.equal(state.lifecycle.state, "active");

    const foreignPath = join(parent, "foreign.json");
    await writeFile(
      foreignPath,
      JSON.stringify({ version: 7, runId: "old-run", phase: "discovery" }),
    );
    await assert.rejects(WorkstreamStore.inspect(foreignPath), UnsupportedWorkstreamStateError);
    const foreignObject = parsePersistedObject(await readFile(foreignPath, "utf8"));
    const runIdKey = "runId";
    assert.equal(foreignObject[runIdKey], "old-run");

    const copiedPath = join(parent, "copied.json");
    await writeFile(copiedPath, await readFile(state.statePath, "utf8"));
    await assert.rejects(WorkstreamStore.inspect(copiedPath), InvalidWorkstreamStateError);
    const copiedObject = parsePersistedObject(await readFile(copiedPath, "utf8"));
    const statePathKey = "statePath";
    assert.equal(copiedObject[statePathKey], state.statePath);

    const corruptPath = join(parent, "corrupt.json");
    await writeFile(corruptPath, "not JSON");
    await assert.rejects(WorkstreamStore.inspect(corruptPath), InvalidWorkstreamStateError);
    assert.equal(await readFile(corruptPath, "utf8"), "not JSON");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("latest appended disposition governs successful evidence without curing invalid evidence", async () => {
  const { parent, store } = await fixture();
  try {
    await store.assign({
      id: "research",
      capability: "research",
      artifactIntent: "evidence_only",
      objective: "Read the retained bytes.",
      intentVersion: 0,
      expectedEvidence: ["Retained bytes."],
    });
    await store.retainResult({
      id: "result",
      assignmentId: "research",
      assignmentIntentVersion: 0,
      validity: "typed",
      report: researchReport("The bytes were retained."),
    });
    await store.disposition({
      resultId: "result",
      status: "rejected",
      reason: "The first review found a gap.",
    });
    await store.disposition({
      resultId: "result",
      status: "accepted",
      reason: "The latest review resolved that gap.",
    });
    const completed = await store.complete({
      conclusion: "The latest judgment accepts the successful evidence.",
      evidence: [{ label: "result", observation: "The completed report was accepted." }],
      limitations: [],
      reasons: [],
    });
    assert.deepEqual(completed.completion?.accounting, []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }

  const invalidFixture = await fixture();
  try {
    await invalidFixture.store.assign({
      id: "research",
      capability: "research",
      artifactIntent: "evidence_only",
      objective: "Read the retained bytes.",
      intentVersion: 0,
      expectedEvidence: ["Retained bytes."],
    });
    await invalidFixture.store.retainResult({
      id: "result",
      assignmentId: "research",
      assignmentIntentVersion: 0,
      validity: "invalid",
      detail: "The report did not satisfy its schema.",
    });
    await invalidFixture.store.disposition({
      resultId: "result",
      status: "accepted",
      reason: "The prose was useful but remains invalid evidence.",
    });
    await assert.rejects(
      invalidFixture.store.complete({
        conclusion: "Invalid evidence remains unresolved.",
        evidence: [{ label: "result", observation: "The retained result is invalid." }],
        limitations: ["No valid report was retained."],
        reasons: [],
      }),
      /exactly one reason per unresolved semantic task/,
    );
  } finally {
    await rm(invalidFixture.parent, { recursive: true, force: true });
  }
});

void test("persisted authority, attempt, completion, and current terminal corruption are rejected", async () => {
  const authorityFixture = await fixture();
  try {
    const { receipt, authority } = await recordedAuthority(authorityFixture.store);
    await authorityFixture.store.assign({
      id: "implementation",
      capability: "implement",
      artifactIntent: "maintained_change",
      objective: "Apply the approved correction.",
      intentVersion: authority.intentVersion,
      authority,
      acceptance: ["The correction is retained."],
    });
    await authorityFixture.store.reviseIntent({
      authorityReceiptId: receipt.id,
      statement: "A later approved correction.",
      constraints: ["Retain the earlier assignment in history."],
    });
    const state = await authorityFixture.store.load();
    const assignment = state.assignments[0];
    assert.ok(assignment?.capability === "implement");
    assignment.authority.intentVersion = 2;
    await persistFixtureState(authorityFixture.store.path, state);
    await assert.rejects(
      WorkstreamStore.inspect(authorityFixture.store.path),
      /authority belongs to another intent/,
    );
  } finally {
    await rm(authorityFixture.parent, { recursive: true, force: true });
  }

  const attemptFixture = await fixture();
  try {
    await attemptFixture.store.enqueue(
      {
        id: "research",
        capability: "research",
        artifactIntent: "evidence_only",
        objective: "Read the fixture.",
        intentVersion: 0,
        expectedEvidence: ["Fixture bytes."],
      },
      {
        id: "attempt",
        models: {
          guide: { model: "fixture/research", thinking: "low" },
          source: "policy",
        },
      },
    );
    const malformed = await attemptFixture.store.load();
    const queued = malformed.attempts[0];
    assert.ok(queued);
    queued.sessionFile = "/tmp/impossible-session.jsonl";
    await persistFixtureState(attemptFixture.store.path, malformed);
    await assert.rejects(
      WorkstreamStore.inspect(attemptFixture.store.path),
      /Queued attempt attempt contains live or terminal fields/,
    );
  } finally {
    await rm(attemptFixture.parent, { recursive: true, force: true });
  }

  const terminalFixture = await fixture();
  try {
    await terminalFixture.store.enqueue(
      {
        id: "research",
        capability: "research",
        artifactIntent: "evidence_only",
        objective: "Read the fixture.",
        intentVersion: 0,
        expectedEvidence: ["Fixture bytes."],
      },
      {
        id: "attempt",
        models: {
          guide: { model: "fixture/research", thinking: "low" },
          source: "policy",
        },
      },
    );
    const terminal = await terminalFixture.store.load();
    const completedAt = dateAt(10_000).toISOString();
    terminal.lifecycle = { state: "completed", changedAt: completedAt, reason: "Malformed." };
    terminal.completion = {
      conclusion: "Malformed terminal state.",
      evidence: [{ label: "fixture", observation: "A queued attempt remains." }],
      limitations: ["The attempt remains live."],
      accounting: deriveCompletionAccounting(terminal).map((item) => ({
        ...item,
        reason: "The queued assignment and attempt remain unresolved.",
      })),
      completedAt,
    };
    await persistFixtureState(terminalFixture.store.path, terminal);
    await assert.rejects(
      WorkstreamStore.inspect(terminalFixture.store.path),
      /active attempt or unclean owned resource/,
    );
  } finally {
    await rm(terminalFixture.parent, { recursive: true, force: true });
  }

  const accountingFixture = await fixture();
  try {
    await accountingFixture.store.assign({
      id: "research",
      capability: "research",
      artifactIntent: "evidence_only",
      objective: "Read the fixture.",
      intentVersion: 0,
      expectedEvidence: ["Fixture bytes."],
    });
    await accountingFixture.store.retainResult({
      id: "result",
      assignmentId: "research",
      assignmentIntentVersion: 0,
      validity: "typed",
      report: researchReport("The fixture was read."),
    });
    const completed = await accountingFixture.store.complete({
      conclusion: "The assignment is resolved.",
      evidence: [{ label: "fixture", observation: "The report completed." }],
      limitations: [],
      reasons: [],
    });
    assert.ok(completed.completion);
    completed.completion.accounting.push({
      kind: "unresolved_assignment",
      assignmentId: "research",
      reason: "Invented unresolved accounting.",
    });
    await persistFixtureState(accountingFixture.store.path, completed);
    await assert.rejects(
      WorkstreamStore.inspect(accountingFixture.store.path),
      /does not exactly match derived unresolved records/,
    );

    const currentText = await readFile(accountingFixture.store.path, "utf8");
    await writeFile(
      accountingFixture.store.path,
      currentText.replace('"purpose": "Determine the safe fixture change.",', ""),
    );
    await assert.rejects(
      WorkstreamStore.inspectForReattachment(accountingFixture.store.path),
      InvalidWorkstreamStateError,
    );

    await writeFile(
      accountingFixture.store.path,
      currentText
        .replace('"version": 4', '"version": 3')
        .replace('"purpose": "Determine the safe fixture change.",', ""),
    );
    const historical = await WorkstreamStore.inspectForReattachment(accountingFixture.store.path);
    assert.equal(historical.kind, "retained_terminal");
  } finally {
    await rm(accountingFixture.parent, { recursive: true, force: true });
  }
});

void test("Effect store port fences both reads and renames and cleans unique 0600 temp state", async () => {
  const { parent, store } = await fixture();
  try {
    const initial = await Effect.runPromise(store.effects.load());
    assert.equal(initial.revision, 0);

    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      Effect.runPromise(
        store.effects.recordInputEvent({
          ...coordinator,
          source: "interactive",
          text: "This interrupted write must not be retained.",
        }),
        { signal: aborted.signal },
      ),
    );
    assert.equal((await WorkstreamStore.inspect(store.path)).revision, 0);

    let guardCalls = 0;
    store.bindMutationGuard(() => {
      guardCalls += 1;
      if (guardCalls === 2) throw new Error("lease fence changed before rename");
    });
    await assert.rejects(
      store.recordInputEvent({
        ...coordinator,
        source: "interactive",
        text: "This fenced write must not be retained.",
      }),
      /lease fence changed before rename/,
    );
    assert.equal(guardCalls, 2);
    assert.equal((await WorkstreamStore.inspect(store.path)).revision, 0);
    assert.deepEqual(await readdir(join(store.path, "..")), ["workstream.json"]);
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

function persistFixtureState(path: string, state: WorkstreamState): Promise<void> {
  return writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}
