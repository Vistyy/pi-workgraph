/* oxlint-disable typescript/no-this-alias -- Effect generators retain the runtime owner while yielding serialized lifecycle operations. */
/* biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: lifecycle ordering is intentionally visible in cohesive flow owners. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Clock, Data, Effect, Queue, type Scope, Semaphore } from "effect";
import type { ModelTarget } from "../domain/model-target.js";
import type {
  AttemptOutput,
  AttemptRecord,
  AttemptSelection,
  AttemptSpec,
  Outcome,
  Task,
  TaskContract,
  TaskRecord,
  TaskTarget,
  WorkerState,
} from "../domain/records.js";
import { liveLayer } from "../node-platform.js";
import {
  applyOutput,
  classifyOutput,
  cleanupAppliedOutput,
  detachedPlacement,
  discardOutput,
  ensureDetachedWorktree,
  GitError,
  isAncestor,
  prepareApplication,
  prepareDiscard,
  type RepositoryOperation,
  validateRetainedCandidate,
} from "../repository.js";
import {
  createWorkerSessionEffect,
  readWorkerSession,
  WORKER_KICKOFF,
  type WorkerObjective,
} from "../worker/session.js";
import {
  HerdrCliRuntime,
  HerdrError,
  type ReadyWorker,
  type WorkerLocator,
  type WorkerObservation,
  type WorkerRequest,
  type WorkerTab,
} from "./herdr.js";
import { type RecordStore, StoreError } from "./store.js";

export class RuntimeError extends Data.TaggedError("RuntimeError")<{
  readonly operation: string;
  readonly message: string;
}> {}

interface Blocker {
  readonly detail: string;
  readonly failures: number;
  readonly retryAt: number;
}

export interface CandidateRequest {
  readonly attemptId: string;
  readonly mode: "extend" | "integrate";
}

export interface RuntimeInspectionStatus {
  readonly blockers: readonly { readonly attemptId: string; readonly detail: string }[];
  readonly activeWorkers: number;
}

interface WorkerContext {
  readonly task: TaskRecord;
  readonly attempt: AttemptRecord;
  readonly cwd: string;
  readonly objective: WorkerObjective;
  readonly target: ModelTarget;
}

/** One Pi session's serialized coordination and reconciliation owner. */
export class SessionRuntime {
  private readonly blockers = new Map<string, Blocker>();
  private closed = false;

  private constructor(
    readonly store: RecordStore,
    readonly agentDir: string,
    readonly workspaceId: string,
    private readonly pi: Pick<ExtensionAPI, "sendMessage">,
    private readonly herdr: HerdrCliRuntime,
    private readonly semaphore: Semaphore.Semaphore,
    private readonly wakeSignal: Queue.Queue<void>,
    private readonly setActiveWorkers: (count: number) => void,
  ) {}

  static acquire(input: {
    readonly store: RecordStore;
    readonly agentDir: string;
    readonly workspaceId: string;
    readonly pi: Pick<ExtensionAPI, "sendMessage">;
    readonly herdr?: HerdrCliRuntime;
    readonly setActiveWorkers?: (count: number) => void;
  }): Effect.Effect<SessionRuntime, never, Scope.Scope> {
    return Effect.gen(function* () {
      const semaphore = yield* Semaphore.make(1);
      const wake = yield* Queue.dropping<void>(1);

      const runtime = new SessionRuntime(
        input.store,
        input.agentDir,
        input.workspaceId,
        input.pi,
        input.herdr ?? new HerdrCliRuntime(),
        semaphore,
        wake,
        input.setActiveWorkers ?? (() => {}),
      );

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtime.closed = true;
          runtime.setActiveWorkers(0);
          input.store.close();
        }),
      );
      runtime.publishActiveWorkers();
      yield* Effect.forkScoped(runtime.reconciliation());

      return runtime;
    });
  }

  inspectionStatus(): RuntimeInspectionStatus {
    return {
      blockers: [...this.blockers.entries()].slice(0, 20).map(([attemptId, value]) => ({
        attemptId,
        detail: value.detail,
      })),
      activeWorkers: this.store.counts().activeWorkers,
    };
  }

  blockerFor(attemptId: string): string | undefined {
    return this.blockers.get(attemptId)?.detail;
  }

  createTask(input: {
    readonly id: string;
    readonly target: TaskTarget;
    readonly contract: TaskContract;
    readonly selection: AttemptSelection;
    readonly candidateOf?: CandidateRequest;
    readonly baseCommit?: string;
  }): Effect.Effect<AttemptRecord, RuntimeError> {
    const self = this;

    return this.serializedEffect(
      "create Task",
      Effect.gen(function* () {
        yield* self.requireLaunchAvailable("create Task");
        const task: Task = { target: input.target, contract: input.contract };

        const spec = yield* self.newAttemptSpec(
          task,
          input.selection,
          input.candidateOf,
          input.baseCommit,
        );

        const attemptId = newAttemptId();
        const result = self.store.createTaskWithAttempt(input.id, task, attemptId, spec).attempt;
        yield* self.wake();

        return result;
      }),
    );
  }

  createAttempt(input: {
    readonly taskId: string;
    readonly selection: AttemptSelection;
    readonly candidateOf?: CandidateRequest;
    readonly baseCommit?: string;
  }): Effect.Effect<AttemptRecord, RuntimeError> {
    const self = this;

    return this.serializedEffect(
      "create Attempt",
      Effect.gen(function* () {
        yield* self.requireLaunchAvailable("create Attempt");
        const task = self.store.readTask(input.taskId);

        const spec = yield* self.newAttemptSpec(
          task.task,
          input.selection,
          input.candidateOf,
          input.baseCommit,
        );

        const result = self.store.createAttempt(task.id, newAttemptId(), spec);
        yield* self.wake();

        return result;
      }),
    );
  }

  steer(attemptId: string, instruction: string): Effect.Effect<void, RuntimeError> {
    const self = this;

    return this.serializedEffect(
      "steer Worker",
      Effect.gen(function* () {
        if (instruction.trim().length === 0)
          return yield* fail("steer Worker", "Steering instruction cannot be blank.");
        const attempt = self.store.readAttempt(attemptId);

        if (attempt.outcome !== undefined || attempt.worker?.closing !== undefined)
          return yield* fail("steer Worker", "Attempt is settling or already has an Outcome.");
        const observed = yield* self.observe(attempt);

        if (observed.state !== "agent")
          return yield* fail(
            "steer Worker",
            `Exact Worker is ${observed.state}; no prompt was issued.`,
          );
        yield* self.herdr
          .prompt(observed, instruction)
          .pipe(Effect.mapError((cause) => runtimeError("steer Worker", cause)));
      }),
    );
  }

  cancel(attemptId: string, reason: string): Effect.Effect<AttemptRecord, RuntimeError> {
    const self = this;

    return this.serializedEffect(
      "cancel Attempt",
      Effect.gen(function* () {
        const trimmed = reason.trim();

        if (trimmed.length === 0)
          return yield* fail("cancel Attempt", "Cancellation requires a nonblank reason.");
        let attempt = self.store.readAttempt(attemptId);

        if (attempt.outcome !== undefined)
          return yield* fail("cancel Attempt", "Attempt already has an Outcome.");

        if (attempt.worker === undefined) {
          const saved = self.store.recordOutcome(attemptId, cancelled(trimmed, []));
          self.blockers.delete(attemptId);
          yield* self.notify(saved);

          return saved;
        }

        if (attempt.worker.closing !== undefined)
          return yield* fail(
            "cancel Attempt",
            "Worker close is already checkpointed and will not be repeated.",
          );

        if (attempt.worker.tab === undefined) {
          const closed = {
            ...attempt.worker,
            closing: { kind: "cancelled" as const, reason: trimmed },
            closed: true as const,
          };

          const saved = self.store.settleCancellation(
            attemptId,
            closed,
            cancelled(trimmed, self.models(attempt)),
          );

          self.blockers.delete(attemptId);
          yield* self.notify(saved);

          return saved;
        }

        const closing = {
          ...attempt.worker,
          closing: { kind: "cancelled" as const, reason: trimmed },
        };

        attempt = self.store.checkpointWorker(attemptId, closing);
        const observed = yield* self.observe(attempt);

        if (observed.state !== "absent") {
          const closed = yield* self.herdr
            .closeObservedWorker(self.request(attempt), observed)
            .pipe(Effect.mapError((cause) => runtimeError("cancel Worker", cause)));

          if (closed !== "absent")
            return yield* fail(
              "cancel Worker",
              "Worker remains present; close will not be repeated.",
            );
        }

        const saved = self.store.settleCancellation(
          attemptId,
          { ...closing, closed: true },
          cancelled(trimmed, self.models(attempt)),
        );

        self.blockers.delete(attemptId);
        yield* self.notify(saved);

        return saved;
      }),
    );
  }

  apply(attemptId: string): Effect.Effect<AttemptRecord, RuntimeError> {
    const self = this;

    return this.serializedEffect(
      "apply output",
      Effect.gen(function* () {
        let attempt = self.requireClassifiable(attemptId, "apply output");
        const task = self.store.readTask(attempt.taskId);

        if (task.task.contract.kind !== "implementation")
          return yield* fail("apply output", "Only implementation output can be applied.");

        if (attempt.output?.kind !== "retained" && attempt.output?.kind !== "applying")
          return yield* fail("apply output", "Attempt has no retained or applying output.");

        let prepared = yield* prepareApplication(self.repositoryOperation(attempt)).pipe(
          Effect.mapError((cause) => runtimeError("apply output", cause)),
        );

        attempt = self.store.checkpointOutput(attemptId, prepared);
        prepared = yield* prepareApplication(self.repositoryOperation(attempt)).pipe(
          Effect.mapError((cause) => runtimeError("apply output", cause)),
        );
        attempt = self.store.checkpointOutput(attemptId, prepared);

        const applied = yield* applyOutput(self.repositoryOperation(attempt)).pipe(
          Effect.mapError((cause) => runtimeError("apply output", cause)),
        );

        attempt = self.store.checkpointOutput(attemptId, applied);

        if (self.store.hasUnclassifiedIntegrationChild(attemptId)) {
          self.blockers.delete(attemptId);

          return attempt;
        }

        const cleaned = yield* cleanupAppliedOutput(self.repositoryOperation(attempt)).pipe(
          Effect.mapError((cause) => runtimeError("apply output", cause)),
        );

        const saved = self.store.checkpointOutput(attemptId, cleaned);
        self.blockers.delete(attemptId);

        return saved;
      }),
    );
  }

  discard(attemptId: string, reason: string): Effect.Effect<AttemptRecord, RuntimeError> {
    const self = this;

    return this.serializedEffect(
      "discard output",
      Effect.gen(function* () {
        let attempt = self.requireClassifiable(attemptId, "discard output");

        if (self.store.hasUnclassifiedIntegrationChild(attemptId))
          return yield* fail(
            "discard output",
            "An unclassified integration child pins this output.",
          );

        if (self.store.hasUnplacedExtensionChild(attemptId))
          return yield* fail("discard output", "An unplaced extension child pins this output.");

        const checkpoint = yield* prepareDiscard(self.repositoryOperation(attempt), reason).pipe(
          Effect.mapError((cause) => runtimeError("discard output", cause)),
        );

        attempt = self.store.checkpointOutput(attemptId, checkpoint);

        const discarded = yield* discardOutput(self.repositoryOperation(attempt)).pipe(
          Effect.mapError((cause) => runtimeError("discard output", cause)),
        );

        const saved = self.store.checkpointOutput(attemptId, discarded);
        self.blockers.delete(attemptId);

        return saved;
      }),
    );
  }

  private requireClassifiable(attemptId: string, operation: string): AttemptRecord {
    const attempt = this.store.readAttempt(attemptId);

    if (attempt.outcome === undefined)
      throw new RuntimeError({ operation, message: "Attempt has no Outcome." });

    if (attempt.worker !== undefined && attempt.worker.closed !== true)
      throw new RuntimeError({ operation, message: "Worker must be definitively closed first." });

    if (attempt.spec.base.kind !== "repository")
      throw new RuntimeError({ operation, message: "Attempt has no repository output." });

    return attempt;
  }

  private newAttemptSpec(
    task: Task,
    selection: AttemptSelection,
    candidate?: CandidateRequest,
    baseCommit?: string,
  ): Effect.Effect<AttemptSpec, RuntimeError> {
    if (task.target.kind === "directory") {
      if (candidate !== undefined || baseCommit !== undefined)
        return fail("create Attempt", "Directory Attempts reject base and candidate lineage.");

      return Effect.succeed({ selection, base: { kind: "directory" } });
    }

    if (candidate === undefined) {
      if (baseCommit === undefined)
        return fail(
          "create Attempt",
          "Independent repository Attempts require an exact base commit.",
        );

      return Effect.succeed({ selection, base: { kind: "repository", baseCommit } });
    }

    return this.candidateSpec(task.target, selection, candidate, baseCommit);
  }

  private candidateSpec(
    target: Extract<TaskTarget, { kind: "repository" }>,
    selection: AttemptSelection,
    candidate: CandidateRequest,
    baseCommit?: string,
  ): Effect.Effect<AttemptSpec, RuntimeError> {
    const parent = this.store.readAttempt(candidate.attemptId);
    const parentTask = this.store.readTask(parent.taskId);

    if (
      parentTask.task.target.kind !== "repository" ||
      parentTask.task.target.commonDir !== target.commonDir ||
      parentTask.task.contract.kind !== "implementation" ||
      parent.output?.kind !== "retained"
    )
      return fail(
        "create Attempt",
        "Candidate source is not clean retained implementation output in this repository.",
      );
    const operation = this.repositoryOperation(parent);
    const retained = parent.output;

    return validateRetainedCandidate(operation).pipe(
      Effect.mapError((cause) => runtimeError("create Attempt", cause)),
      Effect.flatMap((): Effect.Effect<AttemptSpec, RuntimeError> => {
        if (candidate.mode === "extend") {
          if (baseCommit !== undefined)
            return fail("create Attempt", "Extend forbids an independent base.");

          const root =
            parent.spec.lineage?.candidateRoot ??
            (parent.spec.base.kind === "repository" ? parent.spec.base.baseCommit : retained.tip);

          return isAncestor(target, root, retained.tip).pipe(
            Effect.mapError((cause) => runtimeError("create Attempt", cause)),
            Effect.filterOrFail(
              Boolean,
              () =>
                new RuntimeError({
                  operation: "create Attempt",
                  message: "Candidate root is not an ancestor of its retained tip.",
                }),
            ),
            Effect.as({
              selection,
              base: { kind: "repository" as const, baseCommit: retained.tip },
              lineage: {
                candidateRoot: root,
                candidateOf: { kind: "extend" as const, attemptId: parent.id },
              },
            }),
          );
        }

        if (baseCommit === undefined)
          return fail("create Attempt", "Integration requires an exact destination base.");

        return Effect.succeed({
          selection,
          base: { kind: "repository" as const, baseCommit },
          lineage: {
            candidateRoot: baseCommit,
            candidateOf: {
              kind: "integrate" as const,
              attemptId: candidate.attemptId,
              sourceTip: retained.tip,
            },
          },
        });
      }),
    );
  }

  private reconcileAttempt(id: string): Effect.Effect<void, RuntimeError> {
    const attempt = this.store.readAttempt(id);

    if (attempt.outcome === undefined)
      return attempt.worker?.closing?.kind === "cancelled"
        ? this.reconcileCancellation(attempt)
        : this.reconcileExecution(attempt);

    if (attempt.worker !== undefined && attempt.worker.closed !== true)
      return this.reconcileClosure(attempt);

    return this.reconcileOutput(attempt);
  }

  private reconcileExecution(initial: AttemptRecord): Effect.Effect<void, RuntimeError> {
    const self = this;

    return Effect.gen(function* () {
      let attempt = initial;
      const context = self.context(attempt);

      if (attempt.worker === undefined) yield* self.requireLaunchAvailable("launch Worker");

      if (attempt.spec.base.kind === "repository" && attempt.worker?.agent === undefined)
        yield* ensureDetachedWorktree(self.repositoryOperation(attempt)).pipe(
          Effect.mapError((cause) => runtimeError("prepare repository", cause)),
        );

      if (attempt.worker === undefined) {
        const session = yield* createWorkerSessionEffect({
          cwd: context.cwd,
          sessionDir: join(self.agentDir, "workgraph", "worker-sessions"),
          objective: context.objective,
        }).pipe(
          Effect.provide(liveLayer),
          Effect.mapError((cause) => runtimeError("create Worker session", cause)),
        );

        attempt = self.store.checkpointWorker(attempt.id, {
          sessionFile: session.sessionFile,
          workspaceId: self.workspaceId,
        });
      }

      let worker = attempt.worker;

      if (worker === undefined)
        return yield* fail("launch Worker", "Worker session checkpoint is absent.");

      if (worker.tab === undefined) {
        worker = { ...worker, tab: { state: "uncertain" } };
        attempt = self.store.checkpointWorker(attempt.id, worker);

        const tab = yield* self.herdr
          .createWorkerTab(self.request(attempt))
          .pipe(Effect.mapError((cause) => runtimeError("create Worker tab", cause)));

        worker = { ...worker, tab: { state: "ready", tabId: tab.tabId, paneId: tab.paneId } };
        attempt = self.store.checkpointWorker(attempt.id, worker);
      } else if (worker.tab.state === "uncertain") {
        const observed = yield* self.observe(attempt);

        if (observed.state === "absent")
          return yield* self.recordUnreported(
            attempt,
            "Worker disappeared after uncertain tab creation.",
          );

        if (observed.state === "agent")
          return yield* fail(
            "recover Worker tab",
            "An agent exists although agent start was never checkpointed.",
          );
        worker = {
          ...worker,
          tab: { state: "ready", tabId: observed.tabId, paneId: observed.paneId },
        };
        attempt = self.store.checkpointWorker(attempt.id, worker);
      }

      worker = attempt.worker;

      if (worker === undefined) return yield* fail("start Worker", "Worker checkpoint is absent.");

      if (worker.agent === undefined) {
        worker = { ...worker, agent: "uncertain" };
        attempt = self.store.checkpointWorker(attempt.id, worker);
        yield* self.herdr
          .startWorker(tabOf(worker), self.request(attempt))
          .pipe(Effect.mapError((cause) => runtimeError("start Worker", cause)));
        worker = { ...worker, agent: "ready" };
        attempt = self.store.checkpointWorker(attempt.id, worker);
      } else if (worker.agent === "uncertain") {
        const observed = yield* self.observe(attempt);

        if (observed.state !== "agent")
          return yield* self.recordUnreported(
            attempt,
            `Worker is ${observed.state} after uncertain agent start.`,
          );
        worker = { ...worker, agent: "ready" };
        attempt = self.store.checkpointWorker(attempt.id, worker);
      }

      worker = attempt.worker;

      if (worker === undefined)
        return yield* fail("kickoff Worker", "Worker checkpoint is absent.");

      if (worker.kickoff === undefined) {
        const observed = yield* self.requireReady(attempt, "kickoff Worker");
        worker = { ...worker, kickoff: "uncertain" };
        attempt = self.store.checkpointWorker(attempt.id, worker);
        yield* self.herdr
          .prompt(observed, WORKER_KICKOFF)
          .pipe(Effect.mapError((cause) => runtimeError("kickoff Worker", cause)));
        self.store.checkpointWorker(attempt.id, { ...worker, kickoff: "confirmed" });

        return;
      }

      const read = readWorkerSession(worker.sessionFile, context.cwd, context.objective);

      if (worker.kickoff === "uncertain") {
        if (read.kickoffPersisted) {
          self.store.checkpointWorker(attempt.id, { ...worker, kickoff: "confirmed" });

          return;
        }

        const observed = yield* self.observe(attempt);

        if (observed.state === "agent")
          return yield* fail(
            "recover kickoff",
            "Kickoff is uncertain and not yet persisted; it will not be replayed.",
          );

        return yield* self.recordUnreported(
          attempt,
          `Worker is ${observed.state} after uncertain kickoff.`,
        );
      }

      if (read.unreadable) {
        const observed = yield* self.observe(attempt);

        if (observed.state !== "absent") return yield* fail("read Worker session", read.error);

        return yield* self.recordUnreported(attempt, read.error);
      }

      if (!read.settled) {
        const observed = yield* self.observe(attempt);

        if (observed.state === "absent")
          return yield* self.recordUnreported(
            attempt,
            "Worker disappeared without a terminal report.",
          );

        return;
      }

      const result: Outcome["result"] =
        read.report === undefined
          ? { kind: "unreported", reason: read.reportError ?? "Settled Worker report is absent." }
          : { kind: "reported", report: read.report };

      yield* self.recordNormalOutcome(attempt, {
        result,
        effectiveModels: [...read.effectiveModels],
      });
    });
  }

  private recordUnreported(
    attempt: AttemptRecord,
    reason: string,
  ): Effect.Effect<void, RuntimeError> {
    const models = attempt.worker === undefined ? [] : this.models(attempt);

    return this.recordNormalOutcome(attempt, {
      result: { kind: "unreported", reason: bounded(reason) },
      effectiveModels: models,
    });
  }

  private recordNormalOutcome(
    attempt: AttemptRecord,
    outcome: Outcome,
  ): Effect.Effect<void, RuntimeError> {
    const self = this;

    return Effect.gen(function* () {
      let saved = self.store.recordOutcome(attempt.id, outcome);
      yield* self.notify(saved);
      const worker = saved.worker;

      if (worker === undefined) return;
      const closing = { ...worker, closing: { kind: "settled" as const } };
      saved = self.store.checkpointWorker(saved.id, closing);
      const observed = yield* self.observe(saved);

      if (observed.state !== "absent") {
        const closed = yield* self.herdr
          .closeObservedWorker(self.request(saved), observed)
          .pipe(Effect.mapError((cause) => runtimeError("close Worker", cause)));

        if (closed !== "absent")
          return yield* fail("close Worker", "Worker remains present; close will not be repeated.");
      }

      self.store.checkpointWorker(saved.id, { ...closing, closed: true });
    });
  }

  private reconcileClosure(attempt: AttemptRecord): Effect.Effect<void, RuntimeError> {
    const worker = attempt.worker;

    if (worker === undefined) return Effect.void;

    if (worker.closing === undefined) {
      const closing = { ...worker, closing: { kind: "settled" as const } };
      this.store.checkpointWorker(attempt.id, closing);

      return this.closeOnce(this.store.readAttempt(attempt.id), closing);
    }

    return this.observe(attempt).pipe(
      Effect.flatMap((observed) =>
        observed.state === "absent"
          ? this.finishClosure(attempt, worker)
          : fail("close Worker", `Worker remains ${observed.state}; close will not be repeated.`),
      ),
    );
  }

  private closeOnce(
    attempt: AttemptRecord,
    worker: WorkerState,
  ): Effect.Effect<void, RuntimeError> {
    const self = this;

    return Effect.gen(function* () {
      const observed = yield* self.observe(attempt);

      if (observed.state !== "absent") {
        const result = yield* self.herdr
          .closeObservedWorker(self.request(attempt), observed)
          .pipe(Effect.mapError((cause) => runtimeError("close Worker", cause)));

        if (result !== "absent")
          return yield* fail("close Worker", "Worker remains present; close will not be repeated.");
      }

      yield* self.finishClosure(attempt, worker);
    });
  }

  private reconcileCancellation(attempt: AttemptRecord): Effect.Effect<void, RuntimeError> {
    const self = this;
    const worker = attempt.worker;

    if (worker?.closing?.kind !== "cancelled") return Effect.void;
    const reason = worker.closing.reason;

    return Effect.gen(function* () {
      const observed = yield* self.observe(attempt);

      if (observed.state !== "absent")
        return yield* fail(
          "cancel Worker",
          `Worker remains ${observed.state}; close will not be repeated.`,
        );

      const saved = self.store.settleCancellation(
        attempt.id,
        { ...worker, closed: true },
        cancelled(reason, self.models(attempt)),
      );

      self.blockers.delete(attempt.id);
      yield* self.notify(saved);
    });
  }

  private finishClosure(
    attempt: AttemptRecord,
    worker: WorkerState,
  ): Effect.Effect<void, RuntimeError> {
    return Effect.sync(() => {
      this.store.checkpointWorker(attempt.id, { ...worker, closed: true });
    });
  }

  private reconcileOutput(attempt: AttemptRecord): Effect.Effect<void, RuntimeError> {
    if (
      attempt.spec.base.kind !== "repository" ||
      (attempt.worker !== undefined && attempt.worker.closed !== true)
    )
      return Effect.void;
    const operation = this.repositoryOperation(attempt);
    let action: Effect.Effect<AttemptOutput, GitError>;

    if (attempt.output?.kind === "applying")
      action = prepareApplication(operation).pipe(
        Effect.flatMap((output) =>
          Effect.sync(() => this.store.checkpointOutput(attempt.id, output)),
        ),
        Effect.flatMap((saved) => applyOutput(this.repositoryOperation(saved))),
      );
    else if (attempt.output?.kind === "discarding") action = discardOutput(operation);
    else if (attempt.output?.kind === "applied" && attempt.output.cleanupTip !== undefined) {
      if (this.store.hasUnclassifiedIntegrationChild(attempt.id)) return Effect.void;
      action = cleanupAppliedOutput(operation);
    } else if (attempt.output === undefined)
      action = classifyOutput(operation, this.hasCompletedReport(attempt));
    else return Effect.void;

    return action.pipe(
      Effect.flatMap((output) =>
        Effect.sync(() => {
          this.store.checkpointOutput(attempt.id, output);
        }),
      ),
      Effect.mapError((cause) => runtimeError("reconcile output", cause)),
    );
  }

  private hasCompletedReport(attempt: AttemptRecord): boolean {
    const result = attempt.outcome?.result;

    return result?.kind === "reported" && result.report.status === "completed";
  }

  private context(attempt: AttemptRecord): WorkerContext {
    const task = this.store.readTask(attempt.taskId);

    const cwd =
      task.task.target.kind === "directory"
        ? task.task.target.path
        : this.repositoryOperation(attempt).worktreePath;

    const target =
      attempt.spec.selection.kind === "implementation"
        ? attempt.spec.selection.guide
        : attempt.spec.selection.target;

    return { task, attempt, cwd, target, objective: this.objective(task, attempt) };
  }

  private objective(task: TaskRecord, attempt: AttemptRecord): WorkerObjective {
    const contract = task.task.contract;

    let targetDescription: string;

    if (contract.kind === "implementation")
      targetDescription = `Task ${task.id} target (destination identity, not the Worker's execution location): ${JSON.stringify(task.task.target)}`;
    else if (contract.kind === "experiment")
      targetDescription = `Task ${task.id} repository seed identity (cwd is the owned detached worktree): ${JSON.stringify(task.task.target)}`;
    else
      targetDescription = `Task ${task.id} resolved starting context (not evidence scope or authority): ${JSON.stringify(task.task.target)}`;

    const lines = ["[WORKGRAPH WORKER OBJECTIVE]", targetDescription];

    if (contract.kind === "research")
      lines.push(
        `Question: ${contract.question}`,
        ...(contract.context === undefined ? [] : [`Context: ${contract.context}`]),
        ...(contract.expectedEvidence ?? []).map((value) => `Expected evidence: ${value}`),
      );
    else if (contract.kind === "experiment")
      lines.push(
        `Question: ${contract.question}`,
        ...(contract.context === undefined ? [] : [`Context: ${contract.context}`]),
        ...(contract.expectedEvidence ?? []).map((value) => `Expected evidence: ${value}`),
        ...contract.permittedEffects.map((value) => `Permitted effect: ${value}`),
        `Hard stop cutoff: ${contract.stopCondition}`,
      );
    else if (contract.kind === "consultation")
      lines.push(
        `Question: ${contract.question}`,
        ...(contract.context === undefined ? [] : [`Context: ${contract.context}`]),
      );
    else if (contract.kind === "implementation")
      lines.push(
        `Objective: ${contract.objective}`,
        ...contract.acceptance.map((value) => `Acceptance: ${value}`),
      );
    else
      lines.push(
        `Request: ${contract.request}`,
        ...(contract.context === undefined ? [] : [`Context: ${contract.context}`]),
      );

    if (attempt.spec.base.kind === "repository")
      lines.push(`Base revision: ${attempt.spec.base.baseCommit}`);

    if (attempt.spec.lineage !== undefined)
      lines.push(`Candidate facts: ${JSON.stringify(attempt.spec.lineage)}`);

    return {
      content: lines.join("\n"),
      details: {
        taskId: task.id,
        attemptId: attempt.id,
        role: contract.kind,
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Only implementation assignments carry an executor target.
        ...(attempt.spec.selection.kind === "implementation"
          ? { executor: attempt.spec.selection.executor }
          : {}),
      },
    };
  }

  private models(attempt: AttemptRecord): ModelTarget[] {
    if (attempt.worker === undefined) return [];
    const context = this.context(attempt);
    const read = readWorkerSession(attempt.worker.sessionFile, context.cwd, context.objective);

    return read.unreadable ? [] : [...read.effectiveModels];
  }

  private request(attempt: AttemptRecord): WorkerRequest {
    const worker = attempt.worker;

    if (worker === undefined)
      throw new RuntimeError({
        operation: "observe Worker",
        message: "Worker checkpoint is absent.",
      });
    const context = this.context(attempt);

    return {
      taskId: attempt.taskId,
      attemptId: attempt.id,
      role: context.objective.details.role,
      workspaceId: worker.workspaceId,
      cwd: context.cwd,
      sessionFile: worker.sessionFile,
      model: context.target.model,
      thinking: context.target.thinking,
      environment: {
        PI_WORKGRAPH_ROLE: context.objective.details.role,
        PI_CODING_AGENT_DIR: this.agentDir,
      },
    };
  }

  private locator(worker: WorkerState): WorkerLocator {
    return worker.tab?.state === "ready"
      ? {
          state: "ready",
          workspaceId: worker.workspaceId,
          tabId: worker.tab.tabId,
          paneId: worker.tab.paneId,
        }
      : { state: "uncertain", workspaceId: worker.workspaceId };
  }
  private observe(attempt: AttemptRecord): Effect.Effect<WorkerObservation, RuntimeError> {
    if (attempt.worker === undefined) return fail("observe Worker", "Worker checkpoint is absent.");

    return this.herdr
      .observeWorker(this.request(attempt), this.locator(attempt.worker))
      .pipe(Effect.mapError((cause) => runtimeError("observe Worker", cause)));
  }
  private requireReady(
    attempt: AttemptRecord,
    operation: string,
  ): Effect.Effect<ReadyWorker, RuntimeError> {
    return this.observe(attempt).pipe(
      Effect.filterOrFail(
        (observed): observed is ReadyWorker =>
          observed.state === "agent" &&
          (observed.status === "idle" || observed.status === "working"),
        (observed) =>
          new RuntimeError({
            operation,
            message: `Exact Worker is not ready (${observed.state}).`,
          }),
      ),
    );
  }
  private repositoryOperation(attempt: AttemptRecord): RepositoryOperation {
    const target = this.store.readTask(attempt.taskId).task.target;

    if (target.kind !== "repository")
      throw new RuntimeError({
        operation: "repository output",
        message: "Task has no repository target.",
      });

    return {
      attemptId: attempt.id,
      spec: attempt.spec,
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Absence remains omitted across the exact repository boundary.
      ...(attempt.output === undefined ? {} : { output: attempt.output }),
      target,
      ...detachedPlacement({ agentDir: this.agentDir, attemptId: attempt.id }),
    };
  }
  private notify(attempt: AttemptRecord): Effect.Effect<void> {
    return Effect.sync(() => {
      try {
        const outcome = attempt.outcome?.result;

        const summary =
          outcome?.kind === "reported"
            ? outcome.report.summary
            : (outcome?.reason ?? "unavailable");

        const reviewNotice =
          outcome?.kind === "reported" &&
          this.store.readTask(attempt.taskId).task.contract.kind === "review"
            ? " Review output is independent evidence; it neither approves the result nor turns its findings into requirements."
            : "";

        const pending = this.store.hasPendingOutcomes();

        const pendingNotice = pending
          ? " Other Attempts in this Coordinator session still await Outcomes. Use this turn for coordination only, such as inspecting evidence, arranging follow-on work, cancellation, or asking for a necessary decision. Do not provide a substantive user-facing synthesis unless the user explicitly requested partial results."
          : " No Attempts in this Coordinator session await Outcomes. Inspect all relevant persisted Outcomes and provide one complete standalone response that restates the relevant conclusions without assuming the user read earlier incremental assistant messages.";

        this.pi.sendMessage(
          {
            customType: "pi-workgraph-outcome",
            content: `Workgraph Outcome for Task ${attempt.taskId}, Attempt ${attempt.id}: ${outcome?.kind ?? "unknown"}: ${summary.replace(/\s+/g, " ").slice(0, 500)}${reviewNotice}${pendingNotice}`,
            display: true,
            details: { taskId: attempt.taskId, attemptId: attempt.id },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      } catch {
        /* Best-effort, one-shot notification is not retried. */
      }
    });
  }

  private reconciliation(): Effect.Effect<never, never> {
    const tick = Effect.gen(
      function* (this: SessionRuntime) {
        const at = yield* Clock.currentTimeMillis;

        const read = yield* Effect.result(
          this.serializedEffect(
            "read unsettled",
            Effect.sync(() => this.store.unsettled()),
          ),
        );

        if (read._tag === "Failure") {
          const prior = this.blockers.get("runtime");
          const failures = (prior?.failures ?? 0) + 1;
          this.blockers.set("runtime", {
            detail: read.failure.message,
            failures,
            retryAt: at + Math.min(30_000, 250 * 2 ** Math.min(failures, 7)),
          });

          return yield* Effect.sleep(1000);
        }

        this.blockers.delete("runtime");
        const records = read.success;

        for (const record of records) {
          const prior = this.blockers.get(record.id);

          if (prior !== undefined && prior.retryAt > at) continue;

          const result = yield* Effect.result(
            this.serializedEffect("reconcile Attempt", this.reconcileAttempt(record.id)),
          );

          if (result._tag === "Success") this.blockers.delete(record.id);
          else {
            const failures = (prior?.failures ?? 0) + 1;
            this.blockers.set(record.id, {
              detail: result.failure.message,
              failures,
              retryAt: at + Math.min(30_000, 250 * 2 ** Math.min(failures, 7)),
            });

            if (this.blockers.size > 128)
              this.blockers.delete(this.blockers.keys().next().value ?? "");
          }
        }

        this.publishActiveWorkers();
        yield* Queue.take(this.wakeSignal).pipe(
          Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.void }),
        );
      }.bind(this),
    );

    return Effect.forever(tick);
  }
  private requireLaunchAvailable(operation: string): Effect.Effect<void, RuntimeError> {
    return this.herdr.available && this.workspaceId.trim().length > 0
      ? Effect.void
      : fail(operation, "Herdr runtime and exact workspace identity are unavailable.");
  }
  private publishActiveWorkers(): void {
    this.setActiveWorkers(this.store.counts().activeWorkers);
  }
  private wake(): Effect.Effect<void> {
    this.publishActiveWorkers();

    return Queue.offer(this.wakeSignal, undefined).pipe(Effect.asVoid);
  }
  private serializedEffect<A>(
    operation: string,
    value: Effect.Effect<A, RuntimeError>,
  ): Effect.Effect<A, RuntimeError> {
    if (this.closed) return fail(operation, "Runtime is closed.");

    return this.semaphore.withPermit(
      value.pipe(
        Effect.catchDefect((cause) =>
          isExpected(cause) ? Effect.fail(runtimeError(operation, cause)) : Effect.die(cause),
        ),
      ),
    );
  }
}

function tabOf(worker: WorkerState): WorkerTab {
  if (worker.tab?.state !== "ready")
    throw new RuntimeError({
      operation: "start Worker",
      message: "Exact Worker tab checkpoint is absent.",
    });

  return { workspaceId: worker.workspaceId, tabId: worker.tab.tabId, paneId: worker.tab.paneId };
}

function newAttemptId(): string {
  return `attempt-${randomUUID()}`;
}

function cancelled(reason: string, effectiveModels: ModelTarget[]): Outcome {
  return { result: { kind: "cancelled", reason }, effectiveModels };
}

function bounded(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 300) || "Worker ended without a report.";
}

function fail(operation: string, message: string): Effect.Effect<never, RuntimeError> {
  return Effect.fail(new RuntimeError({ operation, message }));
}

function runtimeError(operation: string, cause: unknown): RuntimeError {
  return cause instanceof RuntimeError
    ? cause
    : new RuntimeError({
        operation,
        message: cause instanceof Error ? cause.message : "Operation failed.",
      });
}

function isExpected(cause: unknown): cause is RuntimeError | StoreError | GitError | HerdrError {
  return (
    cause instanceof RuntimeError ||
    cause instanceof StoreError ||
    cause instanceof GitError ||
    cause instanceof HerdrError
  );
}
