import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"; // oxlint-disable-line effecttsgo/node-builtin-import -- Fixtures intentionally use real host storage at the node:test boundary.
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Fixture paths are host filesystem identities.
import { join } from "node:path";
import test from "node:test";
import { DateTime, Effect, type FileSystem, type Path, PlatformError } from "effect";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { liveLayer } from "../src/node-platform.js";
import {
  type AuthorityReference,
  type HumanInputReceipt,
  InvalidWorkstreamStateError,
  type SessionIdentity,
  UnsupportedWorkstreamStateError,
  type WorkstreamState,
  WorkstreamStoreEffects,
} from "../src/workstream.js";
import { SqliteWorkstreamDatabase } from "../src/workstream-persistence.js";
import { legacyPathForWorkstream, WorkstreamStoreOperationError } from "../src/workstream-state.js";
import { deriveCompletionAccounting } from "../src/workstream-transitions.js";
import { parsePersistedObject } from "../src/workstream-validation.js";
import { researchReport } from "./helpers.js";

const PersistedSqliteRowSchema = Type.Object({ state_json: Type.String() });

function runStore<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(liveLayer))).catch((failure) => {
    if (failure instanceof WorkstreamStoreOperationError) {
      if (failure.cause instanceof PlatformError.PlatformError && "cause" in failure.cause.reason)
        throw failure.cause.reason.cause;
      throw failure.cause;
    }
    throw failure;
  });
}

type AssignmentInput = Parameters<WorkstreamStoreEffects["enqueue"]>[0];

async function enqueueFixtureAssignment(
  store: WorkstreamStoreEffects,
  input: AssignmentInput,
  attemptId = `${input.id}-attempt`,
): Promise<void> {
  await runStore(
    store.enqueue(input, {
      id: attemptId,
      models: { guide: { model: "fixture/model", thinking: "low" }, source: "policy" },
    }),
  );
}

async function settleFixtureAttempt(
  store: WorkstreamStoreEffects,
  attemptId: string,
  resultId: string,
): Promise<void> {
  const projectRoot = (await runStore(store.load())).projectRoot;
  await runStore(
    store.startAttempt({
      id: attemptId,
      placement: { kind: "shared_project", path: projectRoot },
      baseRevision: "a".repeat(40),
    }),
  );
  await runStore(store.recordSessionFile(attemptId, `/tmp/${attemptId}.jsonl`));
  await runStore(
    store.settleAttempt({
      id: attemptId,
      resultId,
      effectiveModels: [{ model: "fixture/model", thinking: "low" }],
    }),
  );
  await runStore(store.beginCleanup({ id: attemptId }));
  await runStore(store.markWorkerClosed(attemptId));
  await runStore(store.finishCleanup(attemptId));
}

function dateAt(milliseconds: number): Date {
  return DateTime.toDate(DateTime.makeUnsafe(milliseconds));
}

function requiredValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}.`);
  return value;
}

void test("historical research closes its original scope after intent changes, without invented limitations", async () => {
  const { parent, store } = await fixture();
  try {
    await enqueueFixtureAssignment(store, {
      id: "baseline",
      capability: "research",
      artifactIntent: "evidence_only",
      objective: "Read baseline",
      intentVersion: 0,
      expectedEvidence: ["Baseline bytes"],
    });
    await runStore(
      store.retainResult({
        id: "baseline-result",
        assignmentId: "baseline",
        assignmentIntentVersion: 0,
        validity: "typed",
        report: researchReport("Baseline observed"),
      }),
    );
    await settleFixtureAttempt(store, "baseline-attempt", "baseline-result");
    await recordedAuthority(store);
    const revised = await runStore(store.load());
    assert.equal(revised.results[0]?.assignmentIntentVersion, 0);
    const state = await runStore(
      store.complete({
        conclusion: "Baseline research is resolved in its original scope",
        evidence: [{ label: "Baseline", observation: "Evidence predates the new intent" }],
        limitations: [],
        reasons: [],
      }),
    );
    assert.deepEqual(state.completion?.accounting, []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("accepting a failed report or unapplied stale implementation as evidence does not resolve its assignment", async () => {
  for (const capability of ["research", "implement"] as const) {
    const { parent, store } = await fixture();
    try {
      const { receipt, authority } = await recordedAuthority(store);
      if (capability === "research")
        await enqueueFixtureAssignment(store, {
          id: "work",
          capability,
          artifactIntent: "evidence_only",
          objective: "Read",
          intentVersion: 1,
          expectedEvidence: ["Bytes"],
        });
      else
        await enqueueFixtureAssignment(store, {
          id: "work",
          capability,
          artifactIntent: "maintained_change",
          objective: "Change",
          intentVersion: 1,
          authority,
          acceptance: ["Correct bytes"],
        });
      await runStore(
        store.retainResult({
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
        }),
      );
      await settleFixtureAttempt(store, "work-attempt", "result");
      await runStore(
        store.reviseIntent({
          authorityReceiptId: receipt.id,
          statement: "Changed requirements",
          constraints: ["New constraint"],
        }),
      );
      const completion = {
        conclusion: "Known unresolved work",
        evidence: [{ label: "Result", observation: "The assignment is not fulfilled" }],
        limitations: [],
        reasons: [],
      };
      await assert.rejects(
        runStore(store.complete(completion)),
        /Completion requires exactly one reason per unresolved semantic task/,
      );
      const state = await runStore(
        store.complete({
          ...completion,
          limitations: [
            capability === "research" ? "The read failed" : "The stale change was never applied",
          ],
          reasons: [
            {
              taskId: "work",
              reason: "The assignment and its result are unresolved.",
            },
          ],
        }),
      );
      assert.deepEqual(
        state.completion?.accounting.map((item) =>
          item.kind === "unresolved_assignment"
            ? item.assignmentId
            : item.kind === "unresolved_attempt"
              ? item.attemptId
              : item.kind === "unresolved_result"
                ? item.resultId
                : "",
        ),
        capability === "research" ? ["work", "work-attempt", "result"] : ["work", "work-attempt"],
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

async function fixture(): Promise<{ parent: string; store: WorkstreamStoreEffects }> {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-workstream-"));
  const projectRoot = join(parent, "project");
  const gitCommonDir = join(projectRoot, ".git");
  await mkdir(gitCommonDir, { recursive: true });
  const { store } = await runStore(
    WorkstreamStoreEffects.create({
      id: "workstream",
      purpose: "Determine the safe fixture change.",
      projectRoot,
      gitCommonDir,
      coordinator,
      now: dateAt(0),
    }),
  );
  await runStore(store.acquireLease(coordinator));
  return { parent, store };
}

async function candidateAccountingFixture(): Promise<{
  parent: string;
  store: WorkstreamStoreEffects;
  state: WorkstreamState;
  base: string;
  firstCommit: string;
  correctionCommit: string;
  firstAttemptId: string;
  correctionAttemptId: string;
}> {
  const { parent, store } = await fixture();
  const { authority } = await recordedAuthority(store);
  const base = "a".repeat(40);
  const firstCommit = "b".repeat(40);
  const correctionCommit = "c".repeat(40);
  const models = {
    guide: { model: "fixture/implementation", thinking: "low" as const },
    source: "policy" as const,
  };
  await runStore(
    store.enqueue(
      {
        id: "initial-candidate",
        capability: "implement",
        artifactIntent: "maintained_change",
        objective: "Create the initial candidate.",
        intentVersion: authority.intentVersion,
        authority,
        acceptance: ["The candidate is retained."],
      },
      {
        id: "initial-attempt",
        models,
        baseRevision: base,
        candidate: { kind: "initial", rootCommit: base },
      },
    ),
  );
  await runStore(
    store.startAttempt({
      id: "initial-attempt",
      placement: {
        kind: "isolated_worktree",
        path: "/tmp/workgraph-accounting-initial",
        branch: "pi-workgraph/accounting-initial",
      },
      baseRevision: base,
    }),
  );
  await runStore(store.recordSessionFile("initial-attempt", "/tmp/accounting-initial.jsonl"));
  await runStore(
    store.retainResult({
      id: "initial-result",
      assignmentId: "initial-candidate",
      assignmentIntentVersion: authority.intentVersion,
      validity: "typed",
      report: {
        kind: "implementation",
        status: "completed",
        outcome: "changed",
        summary: "Initial candidate",
        commit: firstCommit,
        evidence: [],
        findings: [],
      },
    }),
  );
  await runStore(
    store.settleAttempt({
      id: "initial-attempt",
      resultId: "initial-result",
      effectiveModels: [models.guide],
    }),
  );
  await runStore(store.beginCleanup({ id: "initial-attempt", expectedHead: firstCommit }));
  await runStore(store.markWorkerClosed("initial-attempt"));
  await runStore(store.finishCleanup("initial-attempt"));

  await runStore(
    store.enqueue(
      {
        id: "correction-candidate",
        capability: "implement",
        artifactIntent: "maintained_change",
        objective: "Correct the initial candidate.",
        intentVersion: authority.intentVersion,
        authority,
        acceptance: ["The correction is retained."],
      },
      {
        id: "correction-attempt",
        models,
        baseRevision: firstCommit,
        candidate: {
          kind: "correction",
          rootCommit: base,
          parentAttemptId: "initial-attempt",
          parentCommit: firstCommit,
        },
      },
    ),
  );
  await runStore(
    store.startAttempt({
      id: "correction-attempt",
      placement: {
        kind: "isolated_worktree",
        path: "/tmp/workgraph-accounting-correction",
        branch: "pi-workgraph/accounting-correction",
      },
      baseRevision: firstCommit,
    }),
  );
  await runStore(store.recordSessionFile("correction-attempt", "/tmp/accounting-correction.jsonl"));
  await runStore(
    store.retainResult({
      id: "correction-result",
      assignmentId: "correction-candidate",
      assignmentIntentVersion: authority.intentVersion,
      validity: "typed",
      report: {
        kind: "implementation",
        status: "completed",
        outcome: "changed",
        summary: "Correction candidate",
        commit: correctionCommit,
        evidence: [],
        findings: [],
      },
    }),
  );
  await runStore(
    store.settleAttempt({
      id: "correction-attempt",
      resultId: "correction-result",
      effectiveModels: [models.guide],
    }),
  );
  await runStore(store.beginCleanup({ id: "correction-attempt", expectedHead: correctionCommit }));
  await runStore(store.markWorkerClosed("correction-attempt"));
  await runStore(store.finishCleanup("correction-attempt"));
  return {
    parent,
    store,
    state: await runStore(store.load()),
    base,
    firstCommit,
    correctionCommit,
    firstAttemptId: "initial-attempt",
    correctionAttemptId: "correction-attempt",
  };
}

function appliedCandidateState(
  source: WorkstreamState,
  correctionAttemptId: string,
  rootCommit: string,
  correctionCommit: string,
  commits: string[],
  state: "applied" | "blocked" = "applied",
): WorkstreamState {
  const result = structuredClone(source);
  const attempt = result.attempts.find((item) => item.id === correctionAttemptId);
  assert.ok(attempt !== undefined);
  attempt.application = {
    state,
    commit: correctionCommit,
    expectedHead: rootCommit,
    rootCommit,
    commits,
    ...(state === "applied" ? { revision: correctionCommit } : { error: "application refused" }),
  };
  return result;
}

void test("completion accounting resolves only exact applied candidate ancestors", async () => {
  const f = await candidateAccountingFixture();
  try {
    const successful = appliedCandidateState(
      f.state,
      f.correctionAttemptId,
      f.base,
      f.correctionCommit,
      [f.firstCommit, f.correctionCommit],
    );
    assert.deepEqual(deriveCompletionAccounting(successful), []);

    const failed = appliedCandidateState(
      f.state,
      f.correctionAttemptId,
      f.base,
      f.correctionCommit,
      [f.firstCommit, f.correctionCommit],
      "blocked",
    );
    assert.ok(
      deriveCompletionAccounting(failed).some(
        (item) => item.kind === "unresolved_attempt" && item.attemptId === f.firstAttemptId,
      ),
    );

    const stale = appliedCandidateState(
      f.state,
      f.correctionAttemptId,
      f.base,
      f.correctionCommit,
      [f.firstCommit, f.correctionCommit],
    );
    const staleAssignment = stale.assignments.find((item) => item.id === "initial-candidate");
    assert.ok(staleAssignment !== undefined);
    staleAssignment.intentVersion += 1;
    assert.ok(
      deriveCompletionAccounting(stale).some(
        (item) => item.kind === "unresolved_attempt" && item.attemptId === f.firstAttemptId,
      ),
    );

    const unrelated = appliedCandidateState(
      f.state,
      f.correctionAttemptId,
      f.base,
      f.correctionCommit,
      [f.firstCommit, f.correctionCommit],
    );
    const initialAssignment = requiredValue(
      unrelated.assignments.find((item) => item.id === "initial-candidate"),
      "initial assignment",
    );
    const initialAttempt = requiredValue(
      unrelated.attempts.find((item) => item.id === f.firstAttemptId),
      "initial attempt",
    );
    const initialResult = requiredValue(
      unrelated.results.find((item) => item.id === "initial-result"),
      "initial result",
    );
    unrelated.assignments.push({
      ...structuredClone(initialAssignment),
      id: "unrelated-candidate",
    });
    unrelated.attempts.push({
      ...structuredClone(initialAttempt),
      id: "unrelated-attempt",
      assignmentId: "unrelated-candidate",
      resultId: "unrelated-result",
    });
    unrelated.results.push({
      ...structuredClone(initialResult),
      id: "unrelated-result",
      assignmentId: "unrelated-candidate",
    });
    assert.ok(
      deriveCompletionAccounting(unrelated).some(
        (item) => item.kind === "unresolved_attempt" && item.attemptId === "unrelated-attempt",
      ),
    );

    const partial = appliedCandidateState(
      f.state,
      f.correctionAttemptId,
      f.base,
      f.correctionCommit,
      [f.correctionCommit],
    );
    assert.ok(
      deriveCompletionAccounting(partial).some(
        (item) => item.kind === "unresolved_attempt" && item.attemptId === f.firstAttemptId,
      ),
    );
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

void test("integration-root candidate accounting excludes its superseded source", async () => {
  const f = await candidateAccountingFixture();
  try {
    const integrated = structuredClone(f.state);
    const destination = "d".repeat(40);
    const integrationCommit = "e".repeat(40);
    const sourceAssignment = requiredValue(
      integrated.assignments.find((item) => item.id === "correction-candidate"),
      "correction assignment",
    );
    const sourceAttempt = requiredValue(
      integrated.attempts.find((item) => item.id === f.correctionAttemptId),
      "correction attempt",
    );
    const sourceResult = requiredValue(
      integrated.results.find((item) => item.id === "correction-result"),
      "correction result",
    );
    const integrationAssignment = structuredClone(sourceAssignment);
    integrationAssignment.id = "integration-candidate";
    const integrationAttempt = structuredClone(sourceAttempt);
    integrationAttempt.id = "integration-attempt";
    integrationAttempt.assignmentId = integrationAssignment.id;
    integrationAttempt.resultId = "integration-result";
    integrationAttempt.baseRevision = destination;
    integrationAttempt.candidate = {
      kind: "integration",
      rootCommit: destination,
      parentAttemptId: f.firstAttemptId,
      parentCommit: f.firstCommit,
    };
    const integrationResult = structuredClone(sourceResult);
    integrationResult.id = "integration-result";
    integrationResult.assignmentId = integrationAssignment.id;
    if (
      integrationResult.validity !== "typed" ||
      integrationResult.report.kind !== "implementation" ||
      integrationResult.report.status !== "completed" ||
      integrationResult.report.outcome !== "changed"
    )
      assert.fail("Expected a typed changed implementation result.");
    integrationResult.report.commit = integrationCommit;
    integrated.assignments.push(integrationAssignment);
    integrated.attempts.push(integrationAttempt);
    integrated.results.push(integrationResult);

    sourceAttempt.baseRevision = integrationCommit;
    sourceAttempt.candidate = {
      kind: "correction",
      rootCommit: destination,
      parentAttemptId: integrationAttempt.id,
      parentCommit: integrationCommit,
    };
    sourceAttempt.application = {
      state: "applied",
      commit: f.correctionCommit,
      expectedHead: destination,
      rootCommit: destination,
      commits: [integrationCommit, f.correctionCommit],
      revision: f.correctionCommit,
    };

    const unresolvedAttempts = (state: WorkstreamState) =>
      deriveCompletionAccounting(state)
        .filter((item) => item.kind === "unresolved_attempt")
        .map((item) => item.attemptId);
    assert.deepEqual(unresolvedAttempts(integrated), [f.firstAttemptId]);

    const crossRoot = structuredClone(integrated);
    const crossRootApplication = requiredValue(
      crossRoot.attempts.find((item) => item.id === f.correctionAttemptId)?.application,
      "correction application",
    );
    crossRootApplication.rootCommit = f.base;
    assert.deepEqual(unresolvedAttempts(crossRoot), [f.firstAttemptId, integrationAttempt.id]);

    const partial = structuredClone(integrated);
    const partialApplication = requiredValue(
      partial.attempts.find((item) => item.id === f.correctionAttemptId)?.application,
      "correction application",
    );
    partialApplication.commits = [f.correctionCommit];
    assert.deepEqual(unresolvedAttempts(partial), [f.firstAttemptId, integrationAttempt.id]);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

function recordedAuthority(
  store: WorkstreamStoreEffects,
): Promise<{ receipt: HumanInputReceipt; authority: AuthorityReference }> {
  return runStore(
    store.recordInputEvent({
      ...coordinator,
      source: "interactive",
      text: "I approve the bounded fixture experiment and maintained correction.",
      now: dateAt(1_000),
    }),
  ).then(({ receipt }) =>
    runStore(
      store.reviseIntent({
        authorityReceiptId: receipt.id,
        statement: "Establish and correct the fixture behavior.",
        constraints: ["Keep the fixture local."],
        now: dateAt(2_000),
      }),
    ).then((revised) => {
      const intent = revised.intents.at(-1);
      if (!intent) throw new Error("Fixture intent was not recorded.");
      return { receipt, authority: { receiptId: receipt.id, intentVersion: intent.version } };
    }),
  );
}

void test("workstream rejects extension or arbitrary authority and stale intent", async () => {
  const { parent, store } = await fixture();
  try {
    await assert.rejects(
      runStore(
        store.recordInputEvent({
          ...coordinator,
          source: "extension",
          text: "approved",
        }),
      ),
      /Extension-generated input/,
    );
    await assert.rejects(
      runStore(
        store.reviseIntent({
          authorityReceiptId: "invented",
          statement: "Mutate the fixture.",
          constraints: [],
        }),
      ),
      /Unknown human input receipt/,
    );

    const { receipt, authority } = await recordedAuthority(store);
    await assert.rejects(
      enqueueFixtureAssignment(
        store,
        {
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
        },
        "invalid-experiment-attempt",
      ),
      /retained human-backed intent/,
    );

    const changed = await runStore(
      store.reviseIntent({
        authorityReceiptId: receipt.id,
        statement: "Correct the fixture with the newly added constraint.",
        constraints: ["Do not alter the fixture API."],
      }),
    );
    assert.equal(changed.intents.at(-1)?.version, authority.intentVersion + 1);
    await assert.rejects(
      enqueueFixtureAssignment(
        store,
        {
          id: "stale-implementation",
          capability: "implement",
          artifactIntent: "maintained_change",
          objective: "Apply the old correction.",
          intentVersion: authority.intentVersion,
          authority,
          acceptance: ["The fixture passes."],
        },
        "stale-implementation-attempt",
      ),
      /stale/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("workstream rejects broken and cross-intent candidate lineage before enqueue", async () => {
  const { parent, store } = await fixture();
  try {
    const { authority } = await recordedAuthority(store);
    const base = "a".repeat(40);
    const parentCommit = "b".repeat(40);
    const models = {
      guide: { model: "fixture/implementation", thinking: "low" as const },
      source: "policy" as const,
    };
    await runStore(
      store.enqueue(
        {
          id: "parent-task",
          capability: "implement",
          artifactIntent: "maintained_change",
          objective: "Retain a candidate",
          intentVersion: authority.intentVersion,
          authority,
          acceptance: ["Candidate exists"],
        },
        {
          id: "parent-attempt",
          models,
          baseRevision: base,
        },
      ),
    );
    await runStore(
      store.startAttempt({
        id: "parent-attempt",
        placement: {
          kind: "isolated_worktree",
          path: "/tmp/workgraph-parent-candidate",
          branch: "pi-workgraph-parent",
        },
        baseRevision: base,
      }),
    );
    await runStore(store.recordSessionFile("parent-attempt", "/tmp/parent-session.jsonl"));
    await runStore(store.markSubmission("parent-attempt", "uncertain"));
    await runStore(store.markSubmission("parent-attempt", "submitted"));
    await runStore(
      store.retainResult({
        id: "parent-result",
        assignmentId: "parent-task",
        assignmentIntentVersion: authority.intentVersion,
        validity: "typed",
        report: {
          kind: "implementation",
          status: "completed",
          outcome: "changed",
          summary: "Retained candidate",
          commit: parentCommit,
          evidence: [],
          findings: [],
        },
      }),
    );
    await runStore(
      store.settleAttempt({
        id: "parent-attempt",
        resultId: "parent-result",
        effectiveModels: [models.guide],
      }),
    );
    await runStore(store.beginCleanup({ id: "parent-attempt", expectedHead: parentCommit }));
    await runStore(store.markWorkerClosed("parent-attempt"));
    await runStore(store.finishCleanup("parent-attempt"));
    const beforeBroken = await runStore(store.load());
    await assert.rejects(
      runStore(
        store.enqueue(
          {
            id: "broken-task",
            capability: "implement",
            artifactIntent: "maintained_change",
            objective: "Use a wrong parent commit",
            intentVersion: authority.intentVersion,
            authority,
            acceptance: ["Rejected"],
          },
          {
            id: "broken-attempt",
            models,
            baseRevision: parentCommit,
            candidate: {
              kind: "correction",
              rootCommit: base,
              parentAttemptId: "parent-attempt",
              parentCommit: "c".repeat(40),
            },
          },
        ),
      ),
      /exactly match/,
    );
    assert.deepEqual(await runStore(store.load()), beforeBroken);

    const input = await runStore(
      store.recordInputEvent({
        ...coordinator,
        source: "interactive",
        text: "Change the maintained scope for the candidate.",
      }),
    );
    const receipt = input.receipt;
    await runStore(
      store.reviseIntent({
        authorityReceiptId: receipt.id,
        statement: "Use a new maintained scope.",
        constraints: ["New scope"],
      }),
    );
    const beforeCrossIntent = await runStore(store.load());
    await assert.rejects(
      runStore(
        store.enqueue(
          {
            id: "cross-intent-task",
            capability: "implement",
            artifactIntent: "maintained_change",
            objective: "Use an old intent candidate",
            intentVersion: 2,
            authority: { receiptId: receipt.id, intentVersion: 2 },
            acceptance: ["Rejected"],
          },
          {
            id: "cross-intent-attempt",
            models,
            baseRevision: parentCommit,
            candidate: {
              kind: "correction",
              rootCommit: base,
              parentAttemptId: "parent-attempt",
              parentCommit,
            },
          },
        ),
      ),
      /current maintained implementation scope/,
    );
    assert.deepEqual(await runStore(store.load()), beforeCrossIntent);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("workstream keeps worker validity, limitations, and stale results distinct", async () => {
  const { parent, store } = await fixture();
  try {
    const { receipt, authority } = await recordedAuthority(store);
    await enqueueFixtureAssignment(store, {
      id: "research",
      capability: "research",
      artifactIntent: "evidence_only",
      objective: "Determine the fixture behavior.",
      intentVersion: authority.intentVersion,
      expectedEvidence: ["Direct fixture evidence."],
    });
    let state = await runStore(
      store.retainResult({
        id: "research-result",
        assignmentId: "research",
        assignmentIntentVersion: authority.intentVersion,
        validity: "typed",
        report: researchReport("The fixture currently accepts the input."),
      }),
    );
    await settleFixtureAttempt(store, "research-attempt", "research-result");
    state = await runStore(store.load());
    state = await runStore(
      store.reviseIntent({
        authorityReceiptId: receipt.id,
        statement: "Determine behavior under the new fixture constraint.",
        constraints: ["Exercise a second fixture input."],
      }),
    );
    state = await runStore(
      store.retainResult({
        id: "stale-result",
        assignmentId: "research",
        assignmentIntentVersion: authority.intentVersion,
        validity: "untyped",
        text: "Old worker prose.",
      }),
    );

    state = await runStore(
      store.complete({
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
      }),
    );
    assert.equal(state.lifecycle.state, "completed");
    assert.deepEqual(
      state.completion?.accounting.map((item) =>
        item.kind === "unresolved_assignment"
          ? item.assignmentId
          : item.kind === "unresolved_result"
            ? item.resultId
            : "",
      ),
      ["stale-result"],
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
      const queued = await runStore(
        store.enqueue(
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
        ),
      );
      for (let index = 0; index < order.length; index++) {
        await runStore(
          store.retainResult({
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
          }),
        );
        await settleFixtureAttempt(store, `attempt-${index}`, `result-${index}`);
      }
      const state = await runStore(store.load());
      assert.equal(queued.attempts.length, 2);
      await assert.rejects(
        runStore(
          store.complete({
            conclusion: "One contribution failed",
            evidence: [{ label: "comparison", observation: "Both attempts retained" }],
            limitations: ["The failed attempt remains unresolved."],
            reasons: [],
          }),
        ),
        /Completion requires exactly one reason per unresolved semantic task/,
      );
      const failed = state.attempts.find((attempt) =>
        attempt.id.endsWith(order.indexOf("failed").toString()),
      );
      assert.ok(failed);
      const failedResult = state.results.find((result) => result.id === failed.resultId);
      assert.ok(failedResult);
      const completed = await runStore(
        store.complete({
          conclusion: "One contribution failed",
          evidence: [{ label: "comparison", observation: "Both attempts retained" }],
          limitations: ["The failed attempt remains unresolved."],
          reasons: [
            {
              taskId: "comparison",
              reason: "One independent attempt and its result failed.",
            },
          ],
        }),
      );
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
    const originalRow = SqliteWorkstreamDatabase.use(store.path, (database) =>
      database.db.prepare("SELECT state_json FROM workstream_state WHERE singleton=1").get(),
    );
    assert.ok(Value.Check(PersistedSqliteRowSchema, originalRow));
    const original = Value.Decode(PersistedSqliteRowSchema, originalRow);
    SqliteWorkstreamDatabase.use(store.path, (database) => {
      database.db
        .prepare("UPDATE workstream_state SET state_json=? WHERE singleton=1")
        .run(
          original.state_json
            .replace(
              '"purpose": "Determine the safe fixture change."',
              '"purpose": "credential=redacted-secret"',
            )
            .replace('"revision": 0', '"revision": "invalid"'),
        );
    });
    await assert.rejects(
      runStore(WorkstreamStoreEffects.inspect(store.path)),
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
      runStore(
        store.recordInputEvent({
          ...coordinator,
          source: "interactive",
          text: "First human constraint.",
        }),
      ),
      runStore(
        store.recordInputEvent({
          ...coordinator,
          source: "rpc",
          text: "Second human constraint.",
        }),
      ),
      runStore(
        store.recordInputEvent({
          ...coordinator,
          source: "interactive",
          text: "Third human constraint.",
        }),
      ),
    ]);
    let state = await runStore(store.load());
    assert.equal(state.revision, 3);
    assert.equal(new Set(state.inputs.map((input) => input.id)).size, 3);
    state = await runStore(
      store.setLifecycle({
        state: "suspended",
        reason: "Coordinator is offline.",
      }),
    );
    assert.equal(state.lifecycle.state, "suspended");
    await assert.rejects(
      enqueueFixtureAssignment(
        store,
        {
          id: "blocked",
          capability: "research",
          artifactIntent: "evidence_only",
          objective: "Do not queue while suspended.",
          intentVersion: 0,
          expectedEvidence: ["No worker."],
        },
        "blocked-attempt",
      ),
      /suspended/,
    );
    state = await runStore(
      store.setLifecycle({
        state: "active",
        reason: "Coordinator resumed.",
      }),
    );
    assert.equal(state.lifecycle.state, "active");

    const foreignPath = join(parent, "foreign.json");
    await writeFile(
      foreignPath,
      JSON.stringify({ version: 7, runId: "old-run", phase: "discovery" }),
    );
    await assert.rejects(
      runStore(WorkstreamStoreEffects.inspect(foreignPath)),
      UnsupportedWorkstreamStateError,
    );
    const foreignObject = parsePersistedObject(await readFile(foreignPath, "utf8"));
    const runIdKey = "runId";
    assert.equal(foreignObject[runIdKey], "old-run");

    const copiedPath = join(parent, "copied.sqlite");
    await writeFile(copiedPath, await readFile(state.statePath));
    await assert.rejects(
      runStore(WorkstreamStoreEffects.inspect(copiedPath)),
      InvalidWorkstreamStateError,
    );
    const copiedObject = parsePersistedObject(
      await runStore(WorkstreamStoreEffects.readRaw(copiedPath)),
    );
    const statePathKey = "statePath";
    assert.equal(copiedObject[statePathKey], state.statePath);

    const corruptPath = join(parent, "corrupt.json");
    await writeFile(corruptPath, "not JSON");
    await assert.rejects(
      runStore(WorkstreamStoreEffects.inspect(corruptPath)),
      InvalidWorkstreamStateError,
    );
    assert.equal(await readFile(corruptPath, "utf8"), "not JSON");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("invalid evidence remains unresolved", async () => {
  const invalidFixture = await fixture();
  try {
    await enqueueFixtureAssignment(invalidFixture.store, {
      id: "research",
      capability: "research",
      artifactIntent: "evidence_only",
      objective: "Read the retained bytes.",
      intentVersion: 0,
      expectedEvidence: ["Retained bytes."],
    });
    await runStore(
      invalidFixture.store.retainResult({
        id: "result",
        assignmentId: "research",
        assignmentIntentVersion: 0,
        validity: "invalid",
        detail: "The report did not satisfy its schema.",
      }),
    );
    await settleFixtureAttempt(invalidFixture.store, "research-attempt", "result");
    await assert.rejects(
      runStore(
        invalidFixture.store.complete({
          conclusion: "Invalid evidence remains unresolved.",
          evidence: [{ label: "result", observation: "The retained result is invalid." }],
          limitations: ["No valid report was retained."],
          reasons: [],
        }),
      ),
      /exactly one reason per unresolved semantic task/,
    );
  } finally {
    await rm(invalidFixture.parent, { recursive: true, force: true });
  }
});

void test("legacy current JSON imports only after dead-owner proof and preserves the source", async () => {
  const { parent, store } = await fixture();
  try {
    const state = await runStore(store.load());
    const legacyPath = legacyPathForWorkstream(state.gitCommonDir, state.id);
    const raw = await runStore(WorkstreamStoreEffects.readRaw(state.statePath));
    const legacy = { ...parsePersistedObject(raw), statePath: legacyPath };
    await rm(state.statePath, { force: true });
    await writeFile(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`);
    const before = await readFile(legacyPath);
    await assert.rejects(
      runStore(WorkstreamStoreEffects.migrateLegacy(legacyPath, "unknown")),
      /dead/,
    );
    const migrated = await runStore(WorkstreamStoreEffects.migrateLegacy(legacyPath, "dead"));
    assert.equal(migrated.state.statePath, state.statePath);
    assert.deepEqual(await readFile(legacyPath), before);
    assert.equal((await runStore(WorkstreamStoreEffects.inspect(state.statePath))).id, state.id);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("new storage is private across umasks and existing shared directories keep their mode", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-private-storage-"));
  const originalUmask = process.umask();
  try {
    for (const [name, mask] of [
      ["permissive", 0],
      ["restrictive", 0o777],
    ] as const) {
      const gitCommonDir = join(parent, name, ".git");
      await mkdir(gitCommonDir, { recursive: true, mode: 0o755 });
      await chmod(gitCommonDir, 0o755);
      process.umask(mask);
      const { state } = await runStore(
        WorkstreamStoreEffects.create({
          id: "private-store",
          purpose: "Verify private persistence modes.",
          projectRoot: join(parent, name),
          gitCommonDir,
          coordinator,
          now: dateAt(0),
        }),
      );
      process.umask(originalUmask);

      for (const directory of [
        join(gitCommonDir, "pi-workgraph"),
        join(gitCommonDir, "pi-workgraph", "workstreams"),
        join(gitCommonDir, "pi-workgraph", "workstreams", "private-store"),
      ])
        assert.equal((await lstat(directory)).mode & 0o777, 0o700, directory);
      assert.equal((await lstat(state.statePath)).mode & 0o777, 0o600);
    }

    const gitCommonDir = join(parent, "shared", ".git");
    const sharedStorage = join(gitCommonDir, "pi-workgraph");
    await mkdir(sharedStorage, { recursive: true, mode: 0o755 });
    await chmod(sharedStorage, 0o755);
    await runStore(
      WorkstreamStoreEffects.create({
        id: "compatible-store",
        purpose: "Preserve a legitimate shared storage parent.",
        projectRoot: join(parent, "shared"),
        gitCommonDir,
        coordinator,
        now: dateAt(0),
      }),
    );
    assert.equal((await lstat(sharedStorage)).mode & 0o777, 0o755);
  } finally {
    process.umask(originalUmask);
    await rm(parent, { recursive: true, force: true });
  }
});

void test("missing or invalid common roots are rejected without external mutation", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-common-root-fence-"));
  try {
    const existingAncestor = join(parent, "existing");
    await mkdir(existingAncestor, { mode: 0o755 });
    await chmod(existingAncestor, 0o755);
    const missingProject = join(existingAncestor, "project");
    const missingCommonDir = join(missingProject, "nested", ".git");

    await assert.rejects(
      runStore(
        WorkstreamStoreEffects.create({
          id: "missing-root",
          purpose: "A missing common root must not be created.",
          projectRoot: missingProject,
          gitCommonDir: missingCommonDir,
          coordinator,
          now: dateAt(0),
        }),
      ),
      /Git common directory does not exist/,
    );
    assert.deepEqual(await readdir(existingAncestor), []);
    assert.equal((await lstat(existingAncestor)).mode & 0o777, 0o755);
    await assert.rejects(
      lstat(missingProject),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );

    const commonFile = join(existingAncestor, "common-file");
    await writeFile(commonFile, "foreign common root");
    await assert.rejects(
      runStore(
        WorkstreamStoreEffects.create({
          id: "file-root",
          purpose: "A file common root must remain untouched.",
          projectRoot: existingAncestor,
          gitCommonDir: commonFile,
          coordinator,
          now: dateAt(0),
        }),
      ),
      /not an ordinary directory/,
    );
    assert.equal(await readFile(commonFile, "utf8"), "foreign common root");

    const external = join(parent, "external");
    const commonLink = join(existingAncestor, "common-link");
    await mkdir(external);
    await symlink(external, commonLink, "dir");
    await assert.rejects(
      runStore(
        WorkstreamStoreEffects.create({
          id: "link-root",
          purpose: "A symlink common root must remain untouched.",
          projectRoot: existingAncestor,
          gitCommonDir: commonLink,
          coordinator,
          now: dateAt(0),
        }),
      ),
      /not an ordinary directory/,
    );
    assert.equal((await lstat(commonLink)).isSymbolicLink(), true);
    assert.deepEqual(await readdir(external), []);
    assert.equal((await lstat(existingAncestor)).mode & 0o777, 0o755);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("state creation refuses static storage redirection before mutation", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-storage-fence-"));
  try {
    const gitCommonDir = join(parent, "project", ".git");
    const storageDirectory = join(gitCommonDir, "pi-workgraph");
    const external = join(parent, "external");
    await mkdir(storageDirectory, { recursive: true });
    await mkdir(external);
    const workstreamsDirectory = join(storageDirectory, "workstreams");
    await symlink(external, workstreamsDirectory, "dir");

    await assert.rejects(
      runStore(
        WorkstreamStoreEffects.create({
          id: "redirected",
          purpose: "This must not leave the Git storage boundary.",
          projectRoot: join(parent, "project"),
          gitCommonDir,
          coordinator,
          now: dateAt(0),
        }),
      ),
      /not an ordinary directory/,
    );
    assert.equal((await lstat(workstreamsDirectory)).isSymbolicLink(), true);
    assert.deepEqual(await readdir(external), []);

    await rm(workstreamsDirectory);
    await writeFile(workstreamsDirectory, "foreign component");
    await assert.rejects(
      runStore(
        WorkstreamStoreEffects.create({
          id: "not-a-directory",
          purpose: "This must not traverse a file component.",
          projectRoot: join(parent, "project"),
          gitCommonDir,
          coordinator,
          now: dateAt(0),
        }),
      ),
      /not an ordinary directory/,
    );
    assert.equal(await readFile(workstreamsDirectory, "utf8"), "foreign component");
    assert.deepEqual(await readdir(external), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("legitimate existing storage supports new ids and preserves claimed-directory collisions", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-storage-collision-"));
  try {
    const gitCommonDir = join(parent, "project", ".git");
    await mkdir(gitCommonDir, { recursive: true });
    const first = await runStore(
      WorkstreamStoreEffects.create({
        id: "first",
        purpose: "Create the shared storage hierarchy.",
        projectRoot: join(parent, "project"),
        gitCommonDir,
        coordinator,
        now: dateAt(0),
      }),
    );
    const firstBytes = await readFile(first.state.statePath, "utf8");
    await runStore(
      WorkstreamStoreEffects.create({
        id: "second",
        purpose: "Reuse the legitimate shared storage hierarchy.",
        projectRoot: join(parent, "project"),
        gitCommonDir,
        coordinator,
        now: dateAt(0),
      }),
    );
    await assert.rejects(
      runStore(
        WorkstreamStoreEffects.create({
          id: "first",
          purpose: "Do not adopt an existing directory claim.",
          projectRoot: join(parent, "project"),
          gitCommonDir,
          coordinator,
          now: dateAt(0),
        }),
      ),
      /EEXIST/,
    );
    assert.equal(await readFile(first.state.statePath, "utf8"), firstBytes);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
