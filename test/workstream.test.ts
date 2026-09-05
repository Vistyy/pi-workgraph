import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type AuthorityReference,
  type HumanInputReceipt,
  InvalidWorkstreamStateError,
  type SessionIdentity,
  UnsupportedWorkstreamStateError,
  WorkstreamStore,
} from "../src/workstream.js";
import { researchReport } from "./helpers.js";

test("accepted historical research closes its original scope after intent changes, without invented limitations", async () => {
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
      evidence: [
        { label: "Baseline", observation: "Evidence predates the new intent" },
      ],
      limitations: [],
      accounting: [],
    });
    assert.deepEqual(state.completion?.accounting, []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("accepting a failed report or uncomposed stale implementation as evidence does not resolve its assignment", async () => {
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
        evidence: [
          { label: "Result", observation: "The assignment is not fulfilled" },
        ],
        limitations: [],
        accounting: [],
      };
      await assert.rejects(
        store.complete(completion),
        /Completion accounting|unresolved assignments/,
      );
      const state = await store.complete({
        ...completion,
        limitations: [
          capability === "research"
            ? "The read failed"
            : "The stale change was never composed",
        ],
        accounting: [
          {
            kind: "unresolved_assignment",
            assignmentId: "work",
            reason: "The assignment is unresolved.",
          },
          ...(capability === "research"
            ? [
                {
                  kind: "unresolved_result" as const,
                  resultId: "result",
                  reason: "The result is failed or stale.",
                },
              ]
            : []),
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

async function fixture(): Promise<{ parent: string; store: WorkstreamStore }> {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-workstream-"));
  const { store } = await WorkstreamStore.create({
    id: "workstream",
    purpose: "Determine the safe fixture change.",
    projectRoot: join(parent, "project"),
    gitCommonDir: join(parent, "project", ".git"),
    coordinator,
    now: new Date(0),
  });
  return { parent, store };
}

async function recordedAuthority(
  store: WorkstreamStore,
): Promise<{ receipt: HumanInputReceipt; authority: AuthorityReference }> {
  const { receipt } = await store.recordInputEvent({
    ...coordinator,
    source: "interactive",
    text: "I approve the bounded fixture experiment and maintained correction.",
    now: new Date(1_000),
  });
  const revised = await store.reviseIntent({
    authorityReceiptId: receipt.id,
    statement: "Establish and correct the fixture behavior.",
    constraints: ["Keep the fixture local."],
    now: new Date(2_000),
  });
  const authority = {
    receiptId: receipt.id,
    intentVersion: revised.intents.at(-1)!.version,
  };
  return { receipt, authority };
}

test("workstream persists human-backed intent, local readiness, and retained experiment evidence", async () => {
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
      now: new Date(3_000),
    });
    assert.equal(state.assignments[0]?.capability, "research");

    state = await store.assign({
      id: "experiment",
      capability: "research",
      artifactIntent: "disposable_experiment",
      objective: "Probe whether the fixture accepts the candidate input.",
      intentVersion: authority.intentVersion,
      authority,
      permittedEffects: [
        "Write only under the disposable experiment directory.",
      ],
      stopCondition:
        "The fixture either accepts or rejects the candidate input.",
      expectedEvidence: ["The observed fixture output."],
      artifactPolicy: { retain: ["experiment-log"], discardOthers: true },
      now: new Date(4_000),
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
      now: new Date(5_000),
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
      now: new Date(6_000),
    });
    assert.equal(state.assignments[2]?.capability, "review");

    const persisted = await WorkstreamStore.inspect(state.statePath);
    assert.deepEqual(
      persisted.assignments.map((assignment) => assignment.id),
      ["research", "experiment", "review"],
    );
    const experimentResult = persisted.results[0];
    assert.ok(experimentResult && experimentResult.validity === "typed");
    assert.equal(
      experimentResult.report.summary,
      "The disposable probe rejected the candidate.",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("workstream rejects extension or arbitrary authority and stale intent", async () => {
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

test("workstream keeps worker validity, disposition, limitations, and stale results distinct", async () => {
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
      accounting: [
        {
          kind: "unresolved_assignment",
          assignmentId: "research",
          reason: "The revised assignment is unresolved.",
        },
        {
          kind: "unresolved_result",
          resultId: "stale-result",
          reason: "The stale result is not usable.",
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

test("every independent attempt remains accounted for regardless of result arrival order", async () => {
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
        await store.recordSessionFile(
          `attempt-${index}`,
          `/tmp/session-${index}`,
        );
        await store.markSubmission(`attempt-${index}`, "uncertain");
        await store.markSubmission(`attempt-${index}`, "submitted");
        await store.retainResult({
          id: `result-${index}`,
          assignmentId: "comparison",
          assignmentIntentVersion: 0,
          validity: "typed",
          report: {
            kind: "research" as const,
            status:
              order[index] === "success"
                ? ("completed" as const)
                : ("failed" as const),
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
          evidence: [
            { label: "comparison", observation: "Both attempts retained" },
          ],
          limitations: ["The failed attempt remains unresolved."],
          accounting: [],
        }),
        /Completion accounting|unresolved attempts|unresolved results/,
      );
      const failed = state.attempts.find((attempt) =>
        attempt.id.endsWith(order.indexOf("failed").toString()),
      )!;
      const failedResult = state.results.find(
        (result) => result.id === failed.resultId,
      )!;
      const completed = await store.complete({
        conclusion: "One contribution failed",
        evidence: [
          { label: "comparison", observation: "Both attempts retained" },
        ],
        limitations: ["The failed attempt remains unresolved."],
        accounting: [
          {
            kind: "unresolved_assignment",
            assignmentId: "comparison",
            reason: "One attempt failed.",
          },
          {
            kind: "unresolved_attempt",
            attemptId: failed.id,
            reason: "The attempt failed.",
          },
          {
            kind: "unresolved_result",
            resultId: failedResult.id,
            reason: "The result failed.",
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

test("workstream serializes receipt writes and rejects corrupt or foreign history without rewriting it", async () => {
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
    await assert.rejects(
      WorkstreamStore.inspect(foreignPath),
      UnsupportedWorkstreamStateError,
    );
    assert.equal(
      JSON.parse(await readFile(foreignPath, "utf8")).runId,
      "old-run",
    );

    const copiedPath = join(parent, "copied.json");
    await writeFile(copiedPath, await readFile(state.statePath, "utf8"));
    await assert.rejects(
      WorkstreamStore.inspect(copiedPath),
      InvalidWorkstreamStateError,
    );
    assert.equal(
      JSON.parse(await readFile(copiedPath, "utf8")).statePath,
      state.statePath,
    );

    const corruptPath = join(parent, "corrupt.json");
    await writeFile(corruptPath, "not JSON");
    await assert.rejects(
      WorkstreamStore.inspect(corruptPath),
      InvalidWorkstreamStateError,
    );
    assert.equal(await readFile(corruptPath, "utf8"), "not JSON");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
