/* oxlint-disable anti-slop/no-reflect-get -- Assertions inspect untyped native node:sqlite result rows by their exact SQL aliases. */
import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The integration fixture owns real temporary SQLite and Git resources.
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native fixture paths identify real temporary repositories.
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Effect } from "effect";
import { commandFailure, type WorkstreamCommandPorts } from "../src/coordination/commands.js";
import {
  makeWorkstreamReconciliationDriver,
  type WorkstreamReconciliationPorts,
} from "../src/coordination/driver.js";
import type { ReconciliationDriver } from "../src/coordination/reconciliation.js";
import { WorkstreamRuntime } from "../src/coordination/runtime.js";
import {
  createWorkstream,
  deriveCompletionAccounting,
  type Intent,
  type Task,
} from "../src/domain/workstream.js";
import { GitRepository, type WorktreePlacement } from "../src/git.js";
import { liveLayer } from "../src/node-platform.js";
import {
  WorkstreamStore,
  WorkstreamStoreUnsupportedError,
} from "../src/storage/workstream-store.js";
import { git } from "./helpers.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workgraph-record-store-"));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "fixture@example.test");
  await git(root, "config", "user.name", "Fixture");
  await writeFile(join(root, "tracked.txt"), "initial\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  const common = join(root, ".git");
  const initial = createWorkstream({
    id: "record-store",
    purpose: "Exercise record persistence",
    repository: { projectRoot: root, gitCommonDir: common },
    coordinator: { sessionId: "session", sessionFile: "/session.jsonl" },
    intent: intent("Initial", "2026-01-01T00:00:00.000Z"),
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  return { root, initial };
}

function intent(statement: string, at: string): Intent {
  return {
    statement,
    constraints: [],
    grounding: {
      kind: "human_input_receipt",
      id: `receipt-${statement}`,
      sessionId: "session",
      sessionFile: "/session.jsonl",
      source: "interactive",
      text: statement,
      receivedAt: at,
    },
    recordedAt: at,
  };
}

function finishedCandidateTask(
  taskId: string,
  attemptId: string,
  base: string,
  commit: string,
  placement: WorktreePlacement,
): Task {
  return {
    kind: "implementation",
    id: taskId,
    objective: "Exercise a real maintained candidate",
    intentIndex: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    acceptance: ["candidate is settled exactly once"],
    attempts: [
      {
        id: attemptId,
        state: "finished",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        baseRevision: base,
        candidate: { kind: "initial", rootCommit: base },
        selection: {
          role: "implementation",
          guide: { model: "provider/guide", thinking: "low" },
          executor: { model: "provider/executor", thinking: "high" },
          source: "policy",
        },
        execution: {
          placement: { kind: "isolated_worktree", path: placement.path, branch: placement.branch },
          sessionFile: `/sessions/${attemptId}.jsonl`,
          submission: "started",
          launch: {
            phase: "ready",
            workspaceId: "workspace",
            tabId: `tab-${attemptId}`,
            paneId: `pane-${attemptId}`,
            terminalId: `terminal-${attemptId}`,
            agentName: `agent-${attemptId}`,
            cwd: placement.path,
          },
        },
        cleanup: { state: "completed", expectedHead: commit, workerClosed: true },
        outcome: {
          id: `${attemptId}:outcome`,
          kind: "reported",
          observedAt: "2026-01-01T00:00:01.000Z",
          artifacts: [],
          report: {
            kind: "implementation",
            status: "completed",
            outcome: "changed",
            commit,
            changedFiles: ["candidate.txt"],
            summary: "Changed",
            evidence: [],
            findings: [],
          },
          delivery: {
            state: "delivered",
            requestedAt: "2026-01-01T00:00:01.000Z",
            attemptCount: 1,
            failureHistory: [],
            deliveredAt: "2026-01-01T00:00:01.000Z",
          },
        },
      },
    ],
  };
}

function realCommands(
  repository: GitRepository,
  discardOutput: WorkstreamCommandPorts["git"]["discardOutput"],
): WorkstreamCommandPorts {
  const host = <A>(operation: string, effect: Effect.Effect<A, { readonly message: string }>) =>
    effect.pipe(Effect.mapError((error) => commandFailure(operation, error.message, error)));
  return {
    git: {
      resolveRevision: (revision) => host("resolve revision", repository.resolveRevision(revision)),
      head: host("inspect head", repository.head()),
      cleanHead: host(
        "inspect clean head",
        repository.assertClean().pipe(Effect.andThen(repository.head())),
      ),
      validateCandidate: (placement, root, commit) =>
        host("validate candidate", repository.validateCandidate(placement, root, commit)),
      inspectCandidateApplication: (source) =>
        host("inspect application", repository.inspectCandidateApplication(source)),
      recoverCandidateApplication: (destination, source) =>
        host("recover application", repository.recoverCandidateApplication(destination, source)),
      applyCandidate: (source, destination) =>
        host("apply candidate", repository.applyCandidate(source, destination)),
      discardOutput,
    },
    workers: { steer: () => Effect.void },
  };
}

void test("record store has cohesive tables and commits an Intent without an aggregate row", async () => {
  const f = await fixture();
  try {
    const path = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const attachment = yield* WorkstreamStore.create(f.initial);
          const nextRevision = yield* attachment.store.mutateRecords(f.initial.coordinator, 0, {
            kind: "append_intent",
            intent: intent("Revised", "2026-01-01T00:00:01.000Z"),
            updatedAt: "2026-01-01T00:00:01.000Z",
          });
          assert.equal(nextRevision, 1);
          return attachment.store.path;
        }),
      ).pipe(Effect.provide(liveLayer)),
    );
    const database = new DatabaseSync(path, { readOnly: true });
    const names = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => Reflect.get(row, "name"));
    assert.equal(names.includes("workstream"), false);
    assert.equal(names.includes("lease"), false);
    assert.deepEqual(
      ["metadata", "intents", "tasks", "attempts", "outcomes", "deliveries"].filter(
        (name) => !names.includes(name),
      ),
      [],
    );
    assert.equal(
      Reflect.get(database.prepare("SELECT count(*) AS count FROM intents").get() ?? {}, "count"),
      2,
    );
    assert.equal(
      Reflect.get(database.prepare("SELECT revision FROM metadata").get() ?? {}, "revision"),
      1,
    );
    database.close();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

void test("actionable query ignores malformed settled history instead of assembling all records", async () => {
  const f = await fixture();
  const settled: Task = {
    kind: "research",
    id: "settled-task",
    objective: "Retain settled history",
    intentIndex: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    expectedEvidence: ["result"],
    attempts: [
      {
        id: "settled-attempt",
        state: "finished",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        selection: {
          role: "research",
          target: { model: "provider/research", thinking: "low" },
          source: "policy",
        },
        outcome: {
          id: "outcome-settled-attempt",
          kind: "cancelled",
          observedAt: "2026-01-01T00:00:01.000Z",
          artifacts: [],
          reason: "Settled",
          delivery: {
            state: "delivered",
            requestedAt: "2026-01-01T00:00:01.000Z",
            attemptCount: 1,
            failureHistory: [],
            deliveredAt: "2026-01-01T00:00:01.000Z",
          },
        },
      },
    ],
  };
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const attachment = yield* WorkstreamStore.create(f.initial);
          yield* attachment.store.mutateRecords(f.initial.coordinator, 0, {
            kind: "create_task",
            task: settled,
            updatedAt: "2026-01-01T00:00:01.000Z",
          });
          const database = new DatabaseSync(attachment.store.path);
          database
            .prepare("UPDATE tasks SET contract_json='not-json' WHERE task_id=?")
            .run(settled.id);
          database.close();
          assert.deepEqual(yield* attachment.store.readActionable(), {
            lifecycle: "active",
            currentIntentIndex: 0,
            records: [],
          });
        }),
      ).pipe(Effect.provide(liveLayer)),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

void test("failed record transaction rolls back and advanced creation recovery never resets", async () => {
  const f = await fixture();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const attachment = yield* WorkstreamStore.create(f.initial);
          yield* attachment.store.mutateRecords(f.initial.coordinator, 0, {
            kind: "append_intent",
            intent: intent("Advanced", "2026-01-01T00:00:01.000Z"),
            updatedAt: "2026-01-01T00:00:01.000Z",
          });
          const failed = yield* Effect.result(
            attachment.store.mutateRecords(f.initial.coordinator, 0, {
              kind: "append_intent",
              intent: intent("Rejected", "2026-01-01T00:00:02.000Z"),
              updatedAt: "2026-01-01T00:00:02.000Z",
            }),
          );
          assert.equal(failed._tag, "Failure");
        }),
      ).pipe(Effect.provide(liveLayer)),
    );
    const recovered = await Effect.runPromise(
      Effect.scoped(WorkstreamStore.resumeCreate(f.initial)).pipe(Effect.provide(liveLayer)),
    );
    assert.equal(recovered.state.revision, 1);
    assert.equal(recovered.state.intents.length, 2);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

void test("serialized steering uses a direct owner fence and does not re-enter its Semaphore", async () => {
  const f = await fixture();
  const active: Task = {
    kind: "research",
    id: "active-task",
    objective: "Exercise steering",
    intentIndex: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    expectedEvidence: ["settlement"],
    attempts: [
      {
        id: "active-attempt",
        state: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        selection: {
          role: "research",
          target: { model: "provider/research", thinking: "low" },
          source: "policy",
        },
        execution: {
          placement: { kind: "shared_project", path: f.root },
          sessionFile: "/sessions/active.jsonl",
          submission: "started",
          launch: {
            phase: "ready",
            workspaceId: "workspace",
            tabId: "tab",
            paneId: "pane",
            terminalId: "terminal",
            agentName: "agent",
            cwd: f.root,
          },
        },
      },
    ],
  };
  const unused = () => Effect.die(new Error("unused Git port"));
  const steered: string[] = [];
  const commands: WorkstreamCommandPorts = {
    git: {
      resolveRevision: unused,
      head: unused(),
      cleanHead: unused(),
      validateCandidate: unused,
      inspectCandidateApplication: unused,
      recoverCandidateApplication: unused,
      applyCandidate: unused,
      discardOutput: unused,
    },
    workers: {
      steer: (_identity, instruction) => Effect.sync(() => steered.push(instruction)),
    },
  };
  const driver: ReconciliationDriver = { reconcile: () => Effect.succeed({ kind: "waiting" }) };
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const attachment = yield* WorkstreamStore.create(f.initial);
          yield* attachment.store.mutateRecords(f.initial.coordinator, 0, {
            kind: "create_task",
            task: active,
            updatedAt: "2026-01-01T00:00:01.000Z",
          });
        }),
      ).pipe(Effect.provide(liveLayer)),
    );
    await Effect.runPromise(
      Effect.timeoutOrElse(
        Effect.acquireUseRelease(
          WorkstreamRuntime.acquire({
            id: f.initial.id,
            repository: f.initial.repository,
            coordinator: f.initial.coordinator,
            driver,
            commands,
          }),
          (runtime) =>
            Effect.gen(function* () {
              yield* runtime.steer({ attemptId: "active-attempt", instruction: "Continue" });
              const state = yield* runtime.snapshot();
              assert.equal(state.tasks[0]?.attempts[0]?.execution?.steering?.state, "submitted");
              assert.deepEqual(steered, ["Continue"]);
            }),
          (runtime) => runtime.close().pipe(Effect.orDie),
        ),
        { duration: "2 seconds", orElse: () => Effect.die(new Error("steering deadlocked")) },
      ).pipe(Effect.provide(liveLayer)),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

void test("registered apply and output cleanup settle once through direct fences", async () => {
  const f = await fixture();
  const base = "a".repeat(40);
  const commit = "b".repeat(40);
  const candidate: Task = {
    kind: "implementation",
    id: "candidate-task",
    objective: "Apply candidate",
    intentIndex: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    acceptance: ["applied"],
    attempts: [
      {
        id: "candidate-attempt",
        state: "finished",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        baseRevision: base,
        candidate: { kind: "initial", rootCommit: base },
        selection: {
          role: "implementation",
          guide: { model: "provider/guide", thinking: "low" },
          executor: { model: "provider/executor", thinking: "high" },
          source: "policy",
        },
        execution: {
          placement: {
            kind: "isolated_worktree",
            path: join(f.root, "candidate"),
            branch: "candidate",
          },
          sessionFile: "/sessions/candidate.jsonl",
          submission: "started",
          launch: {
            phase: "ready",
            workspaceId: "workspace",
            tabId: "tab",
            paneId: "pane",
            terminalId: "terminal",
            agentName: "agent",
            cwd: join(f.root, "candidate"),
          },
        },
        cleanup: { state: "completed", expectedHead: commit, workerClosed: true },
        outcome: {
          id: "candidate-attempt:outcome",
          kind: "reported",
          observedAt: "2026-01-01T00:00:01.000Z",
          artifacts: [],
          report: {
            kind: "implementation",
            status: "completed",
            outcome: "changed",
            commit,
            changedFiles: ["change.txt"],
            summary: "Changed",
            evidence: [],
            findings: [],
          },
          delivery: {
            state: "delivered",
            requestedAt: "2026-01-01T00:00:01.000Z",
            attemptCount: 1,
            failureHistory: [],
            deliveredAt: "2026-01-01T00:00:01.000Z",
          },
        },
      },
    ],
  };
  let applied = 0;
  let discarded = 0;
  const commands: WorkstreamCommandPorts = {
    git: {
      resolveRevision: () => Effect.succeed(base),
      head: Effect.succeed(base),
      cleanHead: Effect.succeed(base),
      validateCandidate: () =>
        Effect.succeed({
          rootCommit: base,
          commit,
          commits: [commit],
          changedFiles: ["change.txt"],
        }),
      inspectCandidateApplication: () =>
        Effect.succeed({ expectedRef: "refs/heads/main", expectedHead: base }),
      // oxlint-disable-next-line effecttsgo/effect-succeed-with-void -- This port distinguishes a successful absent recovery result from void.
      recoverCandidateApplication: () => Effect.succeed(undefined),
      applyCandidate: () =>
        Effect.sync(() => {
          applied += 1;
          return commit;
        }),
      discardOutput: (placement, expectedHead) =>
        Effect.suspend(() => {
          discarded += 1;
          return discarded === 1
            ? Effect.fail(commandFailure("discard output", "simulated interrupted cleanup"))
            : Effect.succeed({
                state: "completed" as const,
                ...placement,
                expectedHead,
                detail: "discarded",
              });
        }),
    },
    workers: { steer: () => Effect.void },
  };
  const driver: ReconciliationDriver = { reconcile: () => Effect.succeed({ kind: "waiting" }) };
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const attachment = yield* WorkstreamStore.create(f.initial);
          yield* attachment.store.mutateRecords(f.initial.coordinator, 0, {
            kind: "create_task",
            task: candidate,
            updatedAt: "2026-01-01T00:00:01.000Z",
          });
        }),
      ).pipe(Effect.provide(liveLayer)),
    );
    await Effect.runPromise(
      Effect.timeoutOrElse(
        Effect.acquireUseRelease(
          WorkstreamRuntime.acquire({
            id: f.initial.id,
            repository: f.initial.repository,
            coordinator: f.initial.coordinator,
            driver,
            commands,
          }),
          (runtime) =>
            Effect.gen(function* () {
              const interrupted = yield* Effect.result(
                runtime.apply({ attemptId: "candidate-attempt" }),
              );
              assert.equal(interrupted._tag, "Failure");
              const afterInterruption = yield* runtime.snapshot();
              assert.equal(afterInterruption.tasks[0]?.attempts[0]?.application?.state, "applied");
              assert.equal(
                afterInterruption.tasks[0]?.attempts[0]?.outputDisposition?.state,
                "blocked",
              );
              yield* runtime.apply({ attemptId: "candidate-attempt" });
              const state = yield* runtime.snapshot();
              const attempt = state.tasks[0]?.attempts[0];
              assert.equal(attempt?.application?.state, "applied");
              assert.equal(attempt?.outputDisposition?.state, "completed");
              assert.equal(applied, 1);
              assert.equal(attempt?.outputDisposition?.kind, "applied");
              assert.equal(discarded, 2);
            }),
          (runtime) => runtime.close().pipe(Effect.orDie),
        ),
        { duration: "2 seconds", orElse: () => Effect.die(new Error("apply cleanup deadlocked")) },
      ).pipe(Effect.provide(liveLayer)),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

void test("runtime makes apply and discard choices mutually exclusive before Git effects", async () => {
  const f = await fixture();
  const base = "a".repeat(40);
  const commit = "b".repeat(40);
  const candidate = (taskId: string, attemptId: string, workerClosed = true): Task => ({
    kind: "implementation",
    id: taskId,
    objective: "Choose one output disposition",
    intentIndex: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    acceptance: ["settled"],
    attempts: [
      {
        id: attemptId,
        state: "finished",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        baseRevision: base,
        candidate: { kind: "initial", rootCommit: base },
        selection: {
          role: "implementation",
          guide: { model: "provider/guide", thinking: "low" },
          executor: { model: "provider/executor", thinking: "high" },
          source: "policy",
        },
        execution: {
          placement: {
            kind: "isolated_worktree",
            path: join(f.root, attemptId),
            branch: attemptId,
          },
          sessionFile: `/sessions/${attemptId}.jsonl`,
          submission: "started",
          launch: {
            phase: "ready",
            workspaceId: "workspace",
            tabId: `tab-${attemptId}`,
            paneId: `pane-${attemptId}`,
            terminalId: `terminal-${attemptId}`,
            agentName: `agent-${attemptId}`,
            cwd: join(f.root, attemptId),
          },
        },
        cleanup: workerClosed
          ? { state: "completed", expectedHead: commit, workerClosed: true }
          : {
              state: "blocked",
              expectedHead: commit,
              workerClosed: false,
              error: "Worker is still open.",
            },
        outcome: {
          id: `${attemptId}:outcome`,
          kind: "reported",
          observedAt: "2026-01-01T00:00:01.000Z",
          artifacts: [],
          report: {
            kind: "implementation",
            status: "completed",
            outcome: "changed",
            commit,
            changedFiles: ["change.txt"],
            summary: "Changed",
            evidence: [],
            findings: [],
          },
          delivery: {
            state: "delivered",
            requestedAt: "2026-01-01T00:00:01.000Z",
            attemptCount: 1,
            failureHistory: [],
            deliveredAt: "2026-01-01T00:00:01.000Z",
          },
        },
      },
    ],
  });
  const discardCalls = new Map<string, number>();
  let validations = 0;
  let inspections = 0;
  let applications = 0;
  const commands: WorkstreamCommandPorts = {
    git: {
      resolveRevision: () => Effect.succeed(base),
      head: Effect.succeed(base),
      cleanHead: Effect.succeed(base),
      validateCandidate: () => {
        validations += 1;
        return Effect.succeed({
          rootCommit: base,
          commit,
          commits: [commit],
          changedFiles: ["change.txt"],
        });
      },
      inspectCandidateApplication: () => {
        inspections += 1;
        return Effect.succeed({ expectedRef: "refs/heads/main", expectedHead: base });
      },
      // oxlint-disable-next-line effecttsgo/effect-succeed-with-void -- Undefined means structurally unchanged and retryable.
      recoverCandidateApplication: () => Effect.succeed(undefined),
      applyCandidate: () => {
        applications += 1;
        return Effect.succeed(commit);
      },
      discardOutput: (placement, expectedHead) => {
        const count = (discardCalls.get(placement.branch) ?? 0) + 1;
        discardCalls.set(placement.branch, count);
        return count === 1
          ? Effect.fail(commandFailure("discard output", "simulated cleanup interruption"))
          : Effect.succeed({
              state: "completed" as const,
              ...placement,
              expectedHead,
              detail: "discarded",
            });
      },
    },
    workers: { steer: () => Effect.void },
  };
  const driver: ReconciliationDriver = { reconcile: () => Effect.succeed({ kind: "waiting" }) };
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const attachment = yield* WorkstreamStore.create(f.initial);
          for (const [revision, task] of [
            candidate("discard-task", "discard-first"),
            candidate("apply-task", "apply-first"),
            candidate("open-task", "worker-open", false),
          ].entries())
            yield* attachment.store.mutateRecords(f.initial.coordinator, revision, {
              kind: "create_task",
              task,
              updatedAt: `2026-01-01T00:00:0${revision + 2}.000Z`,
            });
        }),
      ).pipe(Effect.provide(liveLayer)),
    );
    await Effect.runPromise(
      Effect.acquireUseRelease(
        WorkstreamRuntime.acquire({
          id: f.initial.id,
          repository: f.initial.repository,
          coordinator: f.initial.coordinator,
          driver,
          commands,
        }),
        (runtime) =>
          Effect.gen(function* () {
            assert.equal(
              (yield* Effect.result(
                runtime.discardOutput({ attemptId: "worker-open", reason: "Cannot yet discard" }),
              ))._tag,
              "Failure",
            );
            assert.equal(discardCalls.has("worker-open"), false);

            assert.equal(
              (yield* Effect.result(
                runtime.discardOutput({
                  attemptId: "discard-first",
                  reason: "Discard this output",
                }),
              ))._tag,
              "Failure",
            );
            const beforeRejectedApply = { validations, inspections, applications };
            const rejectedApply = yield* Effect.result(
              runtime.apply({ attemptId: "discard-first" }),
            );
            assert.equal(rejectedApply._tag, "Failure");
            assert.deepEqual({ validations, inspections, applications }, beforeRejectedApply);
            yield* runtime.discardOutput({
              attemptId: "discard-first",
              reason: "Retry keeps the first recorded reason",
            });
            assert.equal(discardCalls.get("discard-first"), 2);

            assert.equal(
              (yield* Effect.result(runtime.apply({ attemptId: "apply-first" })))._tag,
              "Failure",
            );
            assert.equal(applications, 1);
            const beforeRejectedDiscard = discardCalls.get("apply-first");
            const rejectedDiscard = yield* Effect.result(
              runtime.discardOutput({ attemptId: "apply-first", reason: "Must not discard" }),
            );
            assert.equal(rejectedDiscard._tag, "Failure");
            assert.equal(discardCalls.get("apply-first"), beforeRejectedDiscard);
            yield* runtime.apply({ attemptId: "apply-first" });
            assert.equal(applications, 1);
            assert.equal(discardCalls.get("apply-first"), 2);

            const state = yield* runtime.snapshot();
            const discarded = state.tasks[0]?.attempts[0];
            const applied = state.tasks[1]?.attempts[0];
            assert.equal(discarded?.outputDisposition?.kind, "discarded");
            assert.equal(discarded?.outputDisposition?.reason, "Discard this output");
            assert.equal(applied?.application?.state, "applied");
            assert.equal(applied?.outputDisposition?.kind, "applied");
          }),
        (runtime) => runtime.close().pipe(Effect.orDie),
      ).pipe(Effect.provide(liveLayer)),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

void test("persisted real-Git apply resumes cleanup without reintegration", async () => {
  const f = await fixture();
  const base = await git(f.root, "rev-parse", "HEAD");
  const repository = new GitRepository(f.root, join(f.root, ".git"));
  const placement = await Effect.runPromise(
    repository.createWorktree(f.initial.id, "real-apply", base),
  );
  await writeFile(join(placement.path, "candidate.txt"), "candidate bytes\n");
  await git(placement.path, "add", "candidate.txt");
  await git(placement.path, "commit", "-m", "candidate change");
  const candidateHead = await git(placement.path, "rev-parse", "HEAD");
  await writeFile(join(f.root, "destination.txt"), "destination bytes\n");
  await git(f.root, "add", "destination.txt");
  await git(f.root, "commit", "-m", "destination change");
  const destinationHead = await git(f.root, "rev-parse", "HEAD");
  const task = finishedCandidateTask(
    "real-apply-task",
    "real-apply-attempt",
    base,
    candidateHead,
    placement,
  );
  let inspections = 0;
  let integrations = 0;
  let cleanupCalls = 0;
  const discard = (target: WorktreePlacement, expectedHead: string) => {
    cleanupCalls += 1;
    const cleanup = repository
      .discardOutput(target, expectedHead)
      .pipe(Effect.mapError((error) => commandFailure("discard output", error.message, error)));
    return cleanupCalls === 1
      ? cleanup.pipe(
          Effect.andThen(
            Effect.fail(commandFailure("discard output", "simulated lost cleanup response")),
          ),
        )
      : cleanup;
  };
  const liveCommands = realCommands(repository, discard);
  const commands: WorkstreamCommandPorts = {
    ...liveCommands,
    git: {
      ...liveCommands.git,
      inspectCandidateApplication: (source) => {
        inspections += 1;
        return liveCommands.git.inspectCandidateApplication(source);
      },
      applyCandidate: (source, destination) => {
        integrations += 1;
        return liveCommands.git.applyCandidate(source, destination);
      },
    },
  };
  const driver: ReconciliationDriver = { reconcile: () => Effect.succeed({ kind: "waiting" }) };
  const acquire = () =>
    WorkstreamRuntime.acquire({
      id: f.initial.id,
      repository: f.initial.repository,
      coordinator: f.initial.coordinator,
      driver,
      commands,
    });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const attachment = yield* WorkstreamStore.create(f.initial);
          yield* attachment.store.mutateRecords(f.initial.coordinator, 0, {
            kind: "create_task",
            task,
            updatedAt: "2026-01-01T00:00:01.000Z",
          });
        }),
      ).pipe(Effect.provide(liveLayer)),
    );
    const appliedRevision = await Effect.runPromise(
      Effect.acquireUseRelease(
        acquire(),
        (runtime) =>
          Effect.gen(function* () {
            assert.equal(
              (yield* Effect.result(runtime.apply({ attemptId: "real-apply-attempt" })))._tag,
              "Failure",
            );
            const attempt = (yield* runtime.snapshot()).tasks[0]?.attempts[0];
            assert.equal(attempt?.application?.state, "applied");
            assert.equal(attempt?.outputDisposition?.state, "blocked");
            assert.ok(attempt?.application?.revision !== undefined);
            return attempt.application.revision;
          }),
        (runtime) => runtime.close().pipe(Effect.orDie),
      ).pipe(Effect.provide(liveLayer)),
    );
    assert.equal(await git(f.root, "rev-parse", "HEAD"), appliedRevision);
    await assert.rejects(readFile(join(placement.path, "candidate.txt"), "utf8"));
    await assert.rejects(git(f.root, "rev-parse", "--verify", `refs/heads/${placement.branch}`));

    await Effect.runPromise(
      Effect.acquireUseRelease(
        acquire(),
        (runtime) => runtime.apply({ attemptId: "real-apply-attempt" }),
        (runtime) => runtime.close().pipe(Effect.orDie),
      ).pipe(Effect.provide(liveLayer)),
    );
    assert.deepEqual(
      { inspections, integrations, cleanupCalls },
      {
        inspections: 1,
        integrations: 1,
        cleanupCalls: 2,
      },
    );
    const callsAfterCompletion = { inspections, integrations, cleanupCalls };
    const completed = await Effect.runPromise(
      Effect.acquireUseRelease(
        acquire(),
        (runtime) => runtime.apply({ attemptId: "real-apply-attempt" }),
        (runtime) => runtime.close().pipe(Effect.orDie),
      ).pipe(Effect.provide(liveLayer)),
    );
    const completedAttempt = completed.tasks[0]?.attempts[0];
    assert.equal(completedAttempt?.application?.state, "applied");
    assert.equal(completedAttempt?.outputDisposition?.state, "completed");
    assert.equal(completedAttempt?.cleanup?.state, "completed");
    assert.deepEqual({ inspections, integrations, cleanupCalls }, callsAfterCompletion);
    assert.equal(await git(f.root, "rev-parse", "HEAD"), appliedRevision);
    assert.equal(await git(f.root, "rev-parse", "refs/heads/main"), appliedRevision);
    assert.deepEqual((await git(f.root, "show", "-s", "--format=%P", "HEAD")).split(" "), [
      destinationHead,
      candidateHead,
    ]);
    assert.equal(await git(f.root, "show", "HEAD:candidate.txt"), "candidate bytes");
    assert.equal(await git(f.root, "show", "HEAD:destination.txt"), "destination bytes");
    assert.equal(await git(f.root, "rev-parse", "HEAD^{tree}"), await git(f.root, "write-tree"));
    assert.equal(await git(f.root, "status", "--porcelain", "--untracked-files=all"), "");
    await assert.rejects(git(f.root, "rev-parse", "--verify", "MERGE_HEAD"));
    await assert.rejects(readFile(join(placement.path, "candidate.txt"), "utf8"));
    await assert.rejects(git(f.root, "rev-parse", "--verify", `refs/heads/${placement.branch}`));
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(dirname(placement.path), { recursive: true, force: true });
  }
});

void test("persisted runtime discard removes dirty, untracked, and ignored owned output", async () => {
  const f = await fixture();
  const base = await git(f.root, "rev-parse", "HEAD");
  const repository = new GitRepository(f.root, join(f.root, ".git"));
  const placement = await Effect.runPromise(
    repository.createWorktree(f.initial.id, "real-discard", base),
  );
  await writeFile(join(placement.path, ".gitignore"), "*.ignored\n");
  await writeFile(join(placement.path, "candidate.txt"), "candidate bytes\n");
  await git(placement.path, "add", ".gitignore", "candidate.txt");
  await git(placement.path, "commit", "-m", "discarded candidate");
  const candidateHead = await git(placement.path, "rev-parse", "HEAD");
  await writeFile(join(placement.path, "tracked.txt"), "dirty bytes\n");
  await writeFile(join(placement.path, "untracked.txt"), "untracked bytes\n");
  await writeFile(join(placement.path, "secret.ignored"), "ignored bytes\n");
  const task = finishedCandidateTask(
    "real-discard-task",
    "real-discard-attempt",
    base,
    candidateHead,
    placement,
  );
  const discard = (target: WorktreePlacement, expectedHead: string) =>
    repository
      .discardOutput(target, expectedHead)
      .pipe(Effect.mapError((error) => commandFailure("discard output", error.message, error)));
  const commands = realCommands(repository, discard);
  const driver: ReconciliationDriver = { reconcile: () => Effect.succeed({ kind: "waiting" }) };
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const attachment = yield* WorkstreamStore.create(f.initial);
          yield* attachment.store.mutateRecords(f.initial.coordinator, 0, {
            kind: "create_task",
            task,
            updatedAt: "2026-01-01T00:00:01.000Z",
          });
        }),
      ).pipe(Effect.provide(liveLayer)),
    );
    await Effect.runPromise(
      Effect.acquireUseRelease(
        WorkstreamRuntime.acquire({
          id: f.initial.id,
          repository: f.initial.repository,
          coordinator: f.initial.coordinator,
          driver,
          commands,
        }),
        (runtime) =>
          runtime.discardOutput({
            attemptId: "real-discard-attempt",
            reason: "Irreversibly remove all exact owned output",
          }),
        (runtime) => runtime.close().pipe(Effect.orDie),
      ).pipe(Effect.provide(liveLayer)),
    );
    assert.equal(await git(f.root, "rev-parse", "HEAD"), base);
    assert.equal(await git(f.root, "status", "--porcelain", "--untracked-files=all"), "");
    await assert.rejects(readFile(join(placement.path, "tracked.txt"), "utf8"));
    await assert.rejects(git(f.root, "rev-parse", "--verify", `refs/heads/${placement.branch}`));
    const records = await git(f.root, "worktree", "list", "--porcelain");
    assert.equal(records.includes(placement.path), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(dirname(placement.path), { recursive: true, force: true });
  }
});

void test("keyed review Outcome reads reject malformed and mismatched persisted records", async () => {
  const f = await fixture();
  const task = finishedTask("review-source", "delivered");
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const attachment = yield* WorkstreamStore.create(f.initial);
          yield* attachment.store.mutateRecords(f.initial.coordinator, 0, {
            kind: "create_task",
            task,
            updatedAt: "2026-01-01T00:00:01.000Z",
          });
          const outcomeId = task.attempts[0]?.outcome?.id;
          assert.ok(outcomeId !== undefined);
          const database = new DatabaseSync(attachment.store.path);
          database
            .prepare(
              "UPDATE outcomes SET outcome_json=json_set(outcome_json,'$.extra','invalid') WHERE outcome_id=?",
            )
            .run(outcomeId);
          database.close();
          const result = yield* Effect.result(attachment.store.readOutcome(outcomeId));
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure")
            assert.equal(result.failure._tag, "WorkstreamStoreInvalidError");
        }),
      ).pipe(Effect.provide(liveLayer)),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

void test("real driver cancellation refreshes committed context and terminates exactly once", async () => {
  const f = await fixture();
  const task = activeCancellationTask(f.root);
  let terminateCalls = 0;
  const activeCounts: number[] = [];
  const ports = reconciliationPorts(f.root, {
    terminate: () =>
      Effect.sync(() => {
        terminateCalls += 1;
        return { state: "completed" as const, detail: "terminated" };
      }),
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const attachment = yield* WorkstreamStore.create(f.initial);
          yield* attachment.store.mutateRecords(f.initial.coordinator, 0, {
            kind: "create_task",
            task,
            updatedAt: "2026-01-01T00:00:01.000Z",
          });
        }),
      ).pipe(Effect.provide(liveLayer)),
    );
    await Effect.runPromise(
      Effect.timeoutOrElse(
        Effect.acquireUseRelease(
          WorkstreamRuntime.acquire({
            id: f.initial.id,
            repository: f.initial.repository,
            coordinator: f.initial.coordinator,
            driver: makeWorkstreamReconciliationDriver(ports),
            onPresentationChanged: (presentation) =>
              Effect.sync(() => activeCounts.push(presentation.activeAttemptCount)),
          }),
          (runtime) =>
            Effect.gen(function* () {
              while (true) {
                const state = yield* runtime.snapshot();
                const attempt = state.tasks[0]?.attempts[0];
                if (attempt?.state === "finished") {
                  assert.equal(attempt.execution?.cancellation?.state, "terminated");
                  assert.equal(
                    (yield* runtime.frontierSnapshot()).some(
                      (entry) => entry.kind === "cancellation",
                    ),
                    false,
                  );
                  break;
                }
                yield* Effect.sleep("10 millis");
              }
            }),
          (runtime) => runtime.close().pipe(Effect.orDie),
        ),
        { duration: "2 seconds", orElse: () => Effect.die(new Error("cancellation stalled")) },
      ).pipe(Effect.provide(liveLayer)),
    );
    assert.equal(terminateCalls, 1);
    assert.equal(activeCounts.includes(1), true);
    assert.equal(activeCounts.at(-1), 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

void test("delivery after completion replaces outcome accounting and remains attachable", async () => {
  const f = await fixture();
  const task = finishedTask("pending-source", "pending");
  const waiting: ReconciliationDriver = { reconcile: () => Effect.succeed({ kind: "waiting" }) };
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const attachment = yield* WorkstreamStore.create(f.initial);
          yield* attachment.store.mutateRecords(f.initial.coordinator, 0, {
            kind: "create_task",
            task,
            updatedAt: "2026-01-01T00:00:01.000Z",
          });
        }),
      ).pipe(Effect.provide(liveLayer)),
    );
    await Effect.runPromise(
      Effect.acquireUseRelease(
        WorkstreamRuntime.acquire({
          id: f.initial.id,
          repository: f.initial.repository,
          coordinator: f.initial.coordinator,
          driver: waiting,
        }),
        (runtime) =>
          Effect.gen(function* () {
            const completed = yield* runtime.complete({
              conclusion: "Complete while delivery remains pending.",
              evidence: [{ label: "fixture", observation: "Outcome retained." }],
              limitations: [],
            });
            assert.equal(completed.lifecycle, "completed");
            assert.equal(completed.completion?.accounting[0]?.kind, "unresolved_attempt");
            assert.equal(
              completed.completion?.accounting.some((item) => item.kind === "undelivered_outcome"),
              true,
            );
          }),
        (runtime) => runtime.close().pipe(Effect.orDie),
      ).pipe(Effect.provide(liveLayer)),
    );
    const ports = reconciliationPorts(f.root);
    await Effect.runPromise(
      Effect.timeoutOrElse(
        Effect.acquireUseRelease(
          WorkstreamRuntime.acquire({
            id: f.initial.id,
            repository: f.initial.repository,
            coordinator: f.initial.coordinator,
            driver: makeWorkstreamReconciliationDriver(ports),
          }),
          (runtime) =>
            Effect.gen(function* () {
              while (true) {
                const state = yield* runtime.snapshot();
                if (state.tasks[0]?.attempts[0]?.outcome?.delivery.state === "delivered") {
                  assert.deepEqual(state.completion?.accounting, deriveCompletionAccounting(state));
                  break;
                }
                yield* Effect.sleep("10 millis");
              }
            }),
          (runtime) => runtime.close().pipe(Effect.orDie),
        ),
        { duration: "2 seconds", orElse: () => Effect.die(new Error("delivery stalled")) },
      ).pipe(Effect.provide(liveLayer)),
    );
    const attached = await Effect.runPromise(
      Effect.scoped(WorkstreamStore.open(f.initial.id, f.initial.repository)).pipe(
        Effect.provide(liveLayer),
      ),
    );
    assert.deepEqual(
      attached.state.completion?.accounting,
      deriveCompletionAccounting(attached.state),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

function finishedTask(id: string, delivery: "pending" | "delivered"): Task {
  const at = "2026-01-01T00:00:01.000Z";
  return {
    kind: "research",
    id,
    objective: "Produce an Outcome",
    intentIndex: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    expectedEvidence: ["result"],
    attempts: [
      {
        id: `${id}-attempt`,
        state: "finished",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: at,
        selection: {
          role: "research",
          target: { model: "provider/research", thinking: "low" },
          source: "policy",
        },
        outcome: {
          id: `${id}-attempt:outcome`,
          kind: "cancelled",
          observedAt: at,
          artifacts: [],
          reason: "Fixture terminal Outcome",
          delivery:
            delivery === "pending"
              ? { state: "pending", requestedAt: at, attemptCount: 0, failureHistory: [] }
              : {
                  state: "delivered",
                  requestedAt: at,
                  attemptCount: 1,
                  failureHistory: [],
                  deliveredAt: at,
                },
        },
      },
    ],
  };
}

function activeCancellationTask(root: string): Task {
  return {
    kind: "research",
    id: "cancel-task",
    objective: "Cancel the Worker",
    intentIndex: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    expectedEvidence: ["termination"],
    attempts: [
      {
        id: "cancel-attempt",
        state: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        selection: {
          role: "research",
          target: { model: "provider/research", thinking: "low" },
          source: "policy",
        },
        execution: {
          placement: { kind: "shared_project", path: root },
          sessionFile: "/sessions/cancel.jsonl",
          submission: "started",
          launch: {
            phase: "ready",
            workspaceId: "workspace",
            tabId: "tab",
            paneId: "pane",
            terminalId: "terminal",
            agentName: "agent",
            cwd: root,
          },
          cancellation: {
            state: "requested",
            requestedAt: "2026-01-01T00:00:01.000Z",
            reason: "Stop exactly once",
          },
        },
      },
    ],
  };
}

function reconciliationPorts(
  root: string,
  overrides: Partial<WorkstreamReconciliationPorts["workers"]> = {},
): WorkstreamReconciliationPorts {
  const unused = () => Effect.die(new Error("unused reconciliation port"));
  return {
    git: {
      projectRoot: root,
      gitCommonDir: join(root, ".git"),
      derivePlacement: () => undefined,
      ensureWorktree: unused,
      currentHead: unused,
      validateNoChange: unused,
      validateCommit: unused,
      cleanupWorktree: unused,
    },
    workers: {
      workspaceId: "workspace",
      launch: unused,
      inspectLaunch: unused,
      inspect: () => Effect.succeed("absent"),
      terminate: () => Effect.succeed({ state: "completed", detail: "terminated" }),
      steer: unused,
      cleanup: () => Effect.succeed({ state: "completed", detail: "cleaned" }),
      ...overrides,
    },
    sessions: {
      sessionDirectory: () => Effect.succeed("/sessions"),
      inspectDirectory: () => Effect.succeed({ state: "none" }),
      create: unused,
      readReport: () => ({ invalid: false, unreadable: false }),
      readText: () => undefined,
      observeFailure: () => undefined,
      models: () => [],
      started: () => true,
      settled: () => true,
    },
    delivery: { deliver: () => Effect.void },
    host: {},
  };
}

void test("unsupported historical store is rejected byte-for-byte without migration", async () => {
  const f = await fixture();
  try {
    const path = await Effect.runPromise(
      Effect.scoped(WorkstreamStore.create(f.initial)).pipe(
        Effect.map((attachment) => attachment.store.path),
        Effect.provide(liveLayer),
      ),
    );
    const database = new DatabaseSync(path);
    database
      .prepare("UPDATE store_header SET format='pi-workgraph-workstream-sqlite',version=2")
      .run();
    database.close();
    await chmod(path, 0o600);
    const before = await readFile(path);
    await assert.rejects(
      Effect.runPromise(
        Effect.scoped(WorkstreamStore.discover(path)).pipe(Effect.provide(liveLayer)),
      ),
      WorkstreamStoreUnsupportedError,
    );
    assert.deepEqual(await readFile(path), before);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
