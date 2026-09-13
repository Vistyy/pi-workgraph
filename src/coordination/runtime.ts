/* oxlint-disable effecttsgo/node-builtin-import, typescript/no-this-alias, effecttsgo/try-catch-in-effect-gen, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread -- Effect owns runtime serialization; store pages and reports are decoded before use, while exact optional runtime facts remain omitted. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Clock, Data, DateTime, Effect, Queue, type Scope, Semaphore } from "effect";
import type { ModelTarget } from "../domain/model-target.js";
import type {
  Attempt,
  AttemptLineage,
  AttemptRecord,
  AttemptSelection,
  CoordinatorOwner,
  Intent,
  Outcome,
  OutcomeRecord,
  Task,
  TaskContract,
  TaskRecord,
  TaskTarget,
  WorkstreamMetadata,
} from "../domain/records.js";
import {
  applyOutput,
  classifyOutput,
  cleanupAppliedOutput,
  currentRevision,
  detachedPlacement,
  discardOutput,
  ensureDetachedWorktree,
  GitError,
  isAncestor,
  prepareApplication,
  prepareDiscard,
  type RepositoryOperation,
  resolveRevision,
  validateRetainedCandidate,
} from "../git.js";
import {
  HerdrCliRuntime,
  HerdrError,
  type HerdrLaunchRequest,
  type WorkerObservation,
} from "../herdr.js";
import { liveLayer } from "../node-platform.js";
import {
  createWorkerSessionEffect,
  readWorkerSession,
  type WorkerObjective,
  type WorkerRole,
} from "../pi-session.js";
import { StoreError, type WorkstreamStore } from "../storage/workstream-store.js";

interface WorkerContext {
  readonly workstreamId: string;
  readonly attemptId: string;
  readonly taskId: string;
  readonly cwd: string;
  readonly objective: WorkerObjective;
  readonly role: WorkerRole;
  readonly target: ModelTarget;
}

export class RuntimeError extends Data.TaggedError("RuntimeError")<{
  readonly operation: string;
  readonly message: string;
}> {}
export type Attachment =
  | { readonly state: "detached" }
  | { readonly state: "blocked"; readonly reason: string }
  | { readonly state: "attached"; readonly runtime: WorkstreamRuntime };

interface ReconciliationBlocker {
  readonly detail: string;
  readonly failures: number;
  readonly retryAt: number;
}

interface SessionPreparation {
  readonly record: AttemptRecord;
  readonly fresh: boolean;
}

export class WorkstreamRuntime {
  private readonly blockers = new Map<string, ReconciliationBlocker>();
  private closed = false;
  private constructor(
    readonly store: WorkstreamStore,
    readonly owner: CoordinatorOwner,
    readonly agentDir: string,
    private readonly pi: Pick<ExtensionAPI, "sendMessage">,
    private readonly herdr: HerdrCliRuntime,
    private readonly semaphore: Semaphore.Semaphore,
    private readonly wakeQueue: Queue.Queue<void>,
  ) {}

  static acquire(input: {
    store: WorkstreamStore;
    owner: CoordinatorOwner;
    agentDir: string;
    pi: Pick<ExtensionAPI, "sendMessage">;
    herdr?: HerdrCliRuntime;
  }): Effect.Effect<Attachment, never, Scope.Scope> {
    return Effect.gen(function* () {
      let metadata: WorkstreamMetadata;
      try {
        metadata = input.store.readMetadata();
      } catch (cause) {
        return { state: "blocked" as const, reason: message(cause) };
      }
      if (!sameOwner(metadata.owner, input.owner))
        return { state: "blocked" as const, reason: "Workstream belongs to another Coordinator." };
      const semaphore = yield* Semaphore.make(1);
      const wakeQueue = yield* Queue.dropping<void>(1);
      const runtime = new WorkstreamRuntime(
        input.store,
        input.owner,
        input.agentDir,
        input.pi,
        input.herdr ?? new HerdrCliRuntime(),
        semaphore,
        wakeQueue,
      );
      // Registered first so forkScoped's later finalizer interrupts and joins reconciliation first.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtime.closed = true;
          input.store.close();
        }),
      );
      yield* Effect.forkScoped(runtime.reconciliation());
      return { state: "attached" as const, runtime };
    });
  }

  status(): { lifecycle: WorkstreamMetadata["lifecycle"]; blocker?: string } {
    const status = { lifecycle: this.store.readMetadata().lifecycle };
    const blocker = [...this.blockers.entries()]
      .map(([attemptId, blocked]) => `${attemptId}: ${blocked.detail}`)
      .join("; ");
    return blocker.length === 0 ? status : { ...status, blocker };
  }

  createTask(input: {
    id: string;
    target: TaskTarget;
    contract: TaskContract;
    selection: AttemptSelection;
    lineage?: AttemptLineage;
    baseCommit?: string;
  }): Effect.Effect<AttemptRecord, RuntimeError> {
    const self = this;
    return this.serializedEffect(
      "create Task",
      Effect.gen(function* () {
        const task: Task = { target: input.target, contract: input.contract, createdAt: now() };
        const attemptId = `${input.id}-1`;
        const attempt = yield* self.newAttempt(
          task,
          input.selection,
          input.lineage,
          input.baseCommit,
        );
        const records = self.store.createTaskWithAttempt(
          self.owner,
          self.store.readLatestIntent().index,
          input.id,
          task,
          attemptId,
          attempt,
        );
        yield* self.wake();
        return records.attempt;
      }).pipe(Effect.mapError((cause) => runtimeError("create Task", cause))),
    );
  }

  createAttempt(input: {
    taskId: string;
    selection: AttemptSelection;
    lineage?: AttemptLineage;
    baseCommit?: string;
  }): Effect.Effect<AttemptRecord, RuntimeError> {
    const self = this;
    return this.serializedEffect(
      "create Attempt",
      Effect.gen(function* () {
        const task = self.store.readTask(input.taskId);
        const attemptId = `${task.id}-${randomUUID()}`;
        const attempt = yield* self.newAttempt(
          task.task,
          input.selection,
          input.lineage,
          input.baseCommit,
        );
        const record = self.store.appendAttempt(self.owner, task.id, attemptId, attempt);
        yield* self.wake();
        return record;
      }).pipe(Effect.mapError((cause) => runtimeError("create Attempt", cause))),
    );
  }

  steer(attemptId: string, instruction: string): Effect.Effect<void, RuntimeError> {
    const self = this;
    return this.serializedEffect(
      "steer Worker",
      Effect.gen(function* () {
        const record = self.store.readAttempt(attemptId);
        const observation = yield* self.observeWorker(record);
        if (observation.state !== "ready")
          return yield* new RuntimeError({
            operation: "steer Worker",
            message: `Exact Worker is ${observation.state}; no prompt was issued.`,
          });
        yield* self.herdr
          .prompt(observation.identity, instruction)
          .pipe(Effect.mapError((cause) => runtimeError("steer Worker", cause)));
      }),
    );
  }

  cancel(attemptId: string, reason: string): Effect.Effect<AttemptRecord, RuntimeError> {
    const self = this;
    return this.serializedEffect(
      "request cancellation",
      Effect.gen(function* () {
        if (reason.trim().length === 0)
          return yield* new RuntimeError({
            operation: "request cancellation",
            message: "Cancellation requires a nonblank reason.",
          });
        const record = self.store.readAttempt(attemptId);
        if (self.store.readOutcome(attemptId) !== undefined)
          return yield* new RuntimeError({
            operation: "request cancellation",
            message: "Attempt already has an Outcome.",
          });
        if (record.attempt.execution?.cancellation !== undefined)
          return yield* new RuntimeError({
            operation: "request cancellation",
            message: "Cancellation was already requested; close will not be repeated.",
          });
        const execution = record.attempt.execution ?? { submission: "absent" as const };
        const saved = self.store.checkpointAttempt(self.owner, attemptId, {
          ...record.attempt,
          execution: {
            ...execution,
            cancellation: { reason, requestedAt: now() },
          },
        });
        self.blockers.delete(attemptId);
        yield* self.closeNewCancellation(saved);
        yield* self.wake();
        return self.store.readAttempt(attemptId);
      }),
    );
  }

  observe(attemptId: string): Effect.Effect<OutcomeRecord | undefined, RuntimeError> {
    const self = this;
    return this.serializedEffect(
      "reconcile Attempt",
      Effect.gen(function* () {
        yield* self.reconcileAttempt(attemptId);
        return self.store.readOutcome(attemptId);
      }),
    );
  }

  apply(attemptId: string): Effect.Effect<AttemptRecord, RuntimeError> {
    const self = this;
    return this.serializedEffect(
      "apply output",
      Effect.gen(function* () {
        let record = self.store.readAttempt(attemptId);
        if (self.store.readTask(record.taskId).intentIndex !== self.store.readLatestIntent().index)
          return yield* new RuntimeError({
            operation: "apply output",
            message: "Attempt does not belong to the latest Intent.",
          });
        if (record.attempt.execution?.closedAt === undefined)
          return yield* new RuntimeError({
            operation: "apply output",
            message: "Worker must be definitively closed first.",
          });
        let prepared = yield* prepareApplication(self.repositoryOperation(record));
        record = self.store.checkpointAttempt(self.owner, attemptId, prepared);
        prepared = yield* prepareApplication(self.repositoryOperation(record));
        record = self.store.checkpointAttempt(self.owner, attemptId, prepared);
        const applied = yield* applyOutput(self.repositoryOperation(record), now());
        record = self.store.checkpointAttempt(self.owner, attemptId, applied);
        if (self.store.hasUnclassifiedIntegrationChild(attemptId)) return record;
        const cleaned = yield* cleanupAppliedOutput(self.repositoryOperation(record));
        return self.store.checkpointAttempt(self.owner, attemptId, cleaned);
      }).pipe(Effect.mapError((cause) => runtimeError("apply output", cause))),
    );
  }
  discard(attemptId: string, reason: string): Effect.Effect<AttemptRecord, RuntimeError> {
    const self = this;
    return this.serializedEffect(
      "discard output",
      Effect.gen(function* () {
        let record = self.store.readAttempt(attemptId);
        if (record.attempt.execution?.closedAt === undefined)
          return yield* new RuntimeError({
            operation: "discard output",
            message: "Worker must be definitively closed first.",
          });
        if (self.store.hasUnclassifiedIntegrationChild(attemptId))
          return yield* new RuntimeError({
            operation: "discard output",
            message: "An integration child still depends on this private source.",
          });
        const checkpoint = prepareDiscard(self.repositoryOperation(record), reason);
        record = self.store.checkpointAttempt(self.owner, attemptId, checkpoint);
        const discarded = yield* discardOutput(self.repositoryOperation(record), now());
        return self.store.checkpointAttempt(self.owner, attemptId, discarded);
      }).pipe(Effect.mapError((cause) => runtimeError("discard output", cause))),
    );
  }
  inspect(
    section: "intents" | "tasks" | "attempts" | "outcomes",
    after = -1,
    limit = 20,
  ): Effect.Effect<{ records: unknown[]; nextAfter?: number }, RuntimeError> {
    return this.serialized("inspect records", () => {
      const records = this.store.page(section, after, limit);
      const last = records.at(-1) as { index?: number } | undefined;
      return records.length < limit || last?.index === undefined
        ? { records }
        : { records, nextAfter: last.index };
    });
  }
  complete(input: {
    conclusion: string;
    evidence: string[];
    limitations?: string[];
  }): Effect.Effect<WorkstreamMetadata, RuntimeError> {
    return this.serialized("complete Workstream", () =>
      this.store.complete(this.owner, {
        ...input,
        limitations: input.limitations ?? [],
        completedAt: now(),
      }),
    );
  }

  private newAttempt(
    task: Task,
    selection: AttemptSelection,
    lineage?: AttemptLineage,
    requestedBase?: string,
  ): Effect.Effect<Attempt, RuntimeError> {
    if (task.target.kind === "directory") {
      if (lineage !== undefined || requestedBase !== undefined)
        throw new RuntimeError({
          operation: "create Attempt",
          message: "Directory Tasks cannot carry candidate lineage.",
        });
      return Effect.succeed({ selection, base: { kind: "directory" } });
    }
    return this.repositoryAttempt(task.target, selection, lineage, requestedBase).pipe(
      Effect.mapError((cause) => runtimeError("create Attempt", cause)),
    );
  }
  private repositoryAttempt(
    target: Extract<TaskTarget, { kind: "repository" }>,
    selection: AttemptSelection,
    lineage?: AttemptLineage,
    requestedBase?: string,
  ): Effect.Effect<Attempt, RuntimeError | import("../git.js").GitError> {
    const self = this;
    return Effect.gen(function* () {
      const baseCommit =
        requestedBase === undefined
          ? yield* currentRevision(target)
          : yield* resolveRevision(target, requestedBase);
      if (lineage?.candidateOf === undefined)
        return { selection, base: { kind: "repository" as const, baseCommit } };
      const facts = yield* self.candidateFacts(
        target,
        { ...lineage, candidateOf: lineage.candidateOf },
        baseCommit,
        requestedBase,
      );
      return {
        selection,
        base: { kind: "repository" as const, baseCommit: facts.baseCommit },
        lineage: facts.lineage,
      };
    });
  }
  private candidateFacts(
    target: Extract<TaskTarget, { kind: "repository" }>,
    lineage: AttemptLineage & { candidateOf: NonNullable<AttemptLineage["candidateOf"]> },
    baseCommit: string,
    requestedBase?: string,
  ): Effect.Effect<
    { baseCommit: string; lineage: AttemptLineage },
    RuntimeError | import("../git.js").GitError
  > {
    const parentRecord = this.store.readAttempt(lineage.candidateOf.attemptId);
    const parent = parentRecord.attempt;
    if (parent.output?.kind !== "retained")
      return Effect.fail(
        new RuntimeError({
          operation: "create Attempt",
          message: "Candidate parent has no retained output.",
        }),
      );
    const parentOperation = this.repositoryOperation(parentRecord);
    if (parentOperation.target.commonDir !== target.commonDir)
      return Effect.fail(
        new RuntimeError({
          operation: "create Attempt",
          message: "Candidate parent belongs to another Task repository.",
        }),
      );
    return validateRetainedCandidate(parentOperation).pipe(
      Effect.flatMap(() =>
        lineage.candidateOf.kind === "extend"
          ? this.extendFacts(target, parentRecord, requestedBase)
          : this.integrateFacts(lineage, parentRecord, baseCommit),
      ),
    );
  }
  private extendFacts(
    target: Extract<TaskTarget, { kind: "repository" }>,
    parentRecord: AttemptRecord,
    requestedBase?: string,
  ): Effect.Effect<
    { baseCommit: string; lineage: AttemptLineage },
    RuntimeError | import("../git.js").GitError
  > {
    const parent = parentRecord.attempt;
    if (parent.output?.kind !== "retained")
      return Effect.fail(
        new RuntimeError({
          operation: "create Attempt",
          message: "Candidate parent is not retained.",
        }),
      );
    const parentTip = parent.output.tip;
    if (requestedBase !== undefined)
      return Effect.fail(
        new RuntimeError({
          operation: "create Attempt",
          message: "Extend forbids an independent base revision.",
        }),
      );
    const inheritedRoot =
      parent.lineage?.candidateRoot ??
      (parent.base.kind === "repository" ? parent.base.baseCommit : parentTip);
    return isAncestor(target, inheritedRoot, parentTip).pipe(
      Effect.flatMap((present) =>
        present
          ? Effect.succeed({
              baseCommit: parentTip,
              lineage: {
                candidateRoot: inheritedRoot,
                candidateOf: { kind: "extend", attemptId: parentRecord.id },
              },
            })
          : Effect.fail(
              new RuntimeError({
                operation: "create Attempt",
                message: "Candidate lineage is not present in the Task repository.",
              }),
            ),
      ),
    );
  }
  private integrateFacts(
    lineage: AttemptLineage & { candidateOf: NonNullable<AttemptLineage["candidateOf"]> },
    parentRecord: AttemptRecord,
    baseCommit: string,
  ): Effect.Effect<{ baseCommit: string; lineage: AttemptLineage }, RuntimeError> {
    const parent = parentRecord.attempt;
    if (
      parent.output?.kind !== "retained" ||
      lineage.candidateOf.kind !== "integrate" ||
      lineage.candidateOf.sourceTip !== parent.output.tip
    )
      return Effect.fail(
        new RuntimeError({
          operation: "create Attempt",
          message: "Integration source tip no longer matches its retained parent.",
        }),
      );
    return Effect.succeed({
      baseCommit,
      lineage: {
        candidateRoot: baseCommit,
        candidateOf: {
          kind: "integrate",
          attemptId: parentRecord.id,
          sourceTip: parent.output.tip,
        },
      },
    });
  }
  private ensureRepository(
    task: TaskRecord,
    attempt: AttemptRecord,
  ): Effect.Effect<void, import("../git.js").GitError> {
    return task.task.target.kind === "repository"
      ? ensureDetachedWorktree(this.repositoryOperation(attempt))
      : Effect.void;
  }
  private repositoryOperation(record: AttemptRecord): RepositoryOperation {
    const task = this.store.readTask(record.taskId).task;
    if (task.target.kind !== "repository")
      throw new RuntimeError({
        operation: "inspect output",
        message: "Attempt Task has no repository target.",
      });
    return {
      attemptId: record.id,
      attempt: record.attempt,
      target: task.target,
      ...detachedPlacement({
        agentDir: this.agentDir,
        workstreamId: this.store.id,
        attemptId: record.id,
      }),
      applicable: task.contract.kind === "implementation",
    };
  }
  private reconcileAttempt(attemptId: string): Effect.Effect<void, RuntimeError> {
    const self = this;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this one ordered flow keeps independent settlement failures visible.
    return Effect.gen(function* () {
      let record = self.store.readAttempt(attemptId);
      let outcome = self.store.readOutcome(attemptId);
      const transitionResult =
        outcome === undefined
          ? yield* Effect.result(
              record.attempt.execution?.cancellation === undefined
                ? self.reconcileExecution(record)
                : self.reconcileCancellation(record),
            )
          : undefined;
      record = self.store.readAttempt(attemptId);
      outcome = self.store.readOutcome(attemptId);
      const closureResult =
        outcome !== undefined && record.attempt.execution?.closedAt === undefined
          ? yield* Effect.result(self.settleObservedClosure(record))
          : undefined;
      record = self.store.readAttempt(attemptId);
      const outputResult =
        outcome !== undefined && record.attempt.execution?.closedAt !== undefined
          ? yield* Effect.result(self.reconcileOutput(record))
          : undefined;
      const currentOutcome = self.store.readOutcome(attemptId);
      const deliveryResult =
        currentOutcome !== undefined && currentOutcome.outcome.delivery.deliveredAt === undefined
          ? yield* Effect.result(self.deliver(currentOutcome))
          : undefined;
      const failures = [transitionResult, closureResult, outputResult, deliveryResult].flatMap(
        (result) => (result?._tag === "Failure" ? [result.failure.message] : []),
      );
      if (failures.length > 0)
        return yield* new RuntimeError({
          operation: "reconcile Attempt",
          message: failures.join("; "),
        });
    });
  }

  private reconcileExecution(record: AttemptRecord): Effect.Effect<void, RuntimeError> {
    const task = this.store.readTask(record.taskId);
    const context = this.workerContext(record, task);
    return this.ensureRepository(task, record).pipe(
      Effect.mapError((cause) => runtimeError("prepare Attempt repository", cause)),
      Effect.flatMap(() => this.ensureWorkerSession(record, context)),
      Effect.flatMap((prepared) => this.ensureWorkerAgent(prepared, context)),
      Effect.flatMap((agentRecord) => this.reconcileWorkerSession(agentRecord, context)),
    );
  }

  private ensureWorkerSession(
    record: AttemptRecord,
    context: WorkerContext,
  ): Effect.Effect<SessionPreparation, RuntimeError> {
    if (record.attempt.execution?.sessionFile !== undefined)
      return Effect.succeed({ record, fresh: false });
    return createWorkerSessionEffect({
      cwd: context.cwd,
      sessionDir: join(this.agentDir, "workgraph", "worker-sessions", this.store.id),
      objective: context.objective,
    }).pipe(
      Effect.provide(liveLayer),
      Effect.mapError((cause) => runtimeError("create Worker session", cause)),
      Effect.map((created) => ({
        fresh: created.fresh,
        record: this.store.checkpointAttempt(this.owner, record.id, {
          ...record.attempt,
          execution: { submission: "absent", sessionFile: created.sessionFile },
        }),
      })),
    );
  }

  private ensureWorkerAgent(
    prepared: SessionPreparation,
    context: WorkerContext,
  ): Effect.Effect<AttemptRecord, RuntimeError> {
    const execution = prepared.record.attempt.execution;
    if (execution?.sessionFile === undefined)
      return Effect.fail(
        new RuntimeError({
          operation: "prepare Worker session",
          message: "Session checkpoint is absent.",
        }),
      );
    const request = this.herdrRequest(context, execution.sessionFile);
    if (prepared.fresh)
      return this.herdr.launch(request).pipe(
        Effect.mapError((cause) => runtimeError(cause.operation, cause)),
        Effect.as(prepared.record),
      );
    return this.herdr.observeWorker(request).pipe(
      Effect.mapError((cause) => runtimeError(cause.operation, cause)),
      Effect.flatMap((observation) =>
        observation.state === "ready"
          ? Effect.succeed(prepared.record)
          : Effect.fail(
              new RuntimeError({
                operation: "recover Worker",
                message:
                  observation.state === "partial"
                    ? `${observation.detail} Launch will not be continued automatically.`
                    : "No exact Worker resource follows the prior session; launch will not be replayed.",
              }),
            ),
      ),
    );
  }

  private reconcileWorkerSession(
    record: AttemptRecord,
    context: WorkerContext,
  ): Effect.Effect<void, RuntimeError> {
    const execution = record.attempt.execution;
    if (execution?.sessionFile === undefined) return Effect.void;
    const read = readWorkerSession(execution.sessionFile, context.cwd, context.objective);
    if (execution.submission === "uncertain") return this.recoverSubmission(record, read.started);
    if (execution.submission === "absent") return this.submitWorker(record);
    if (read.unreadable)
      return Effect.fail(
        new RuntimeError({ operation: "read Worker session", message: read.error }),
      );
    if (!read.settled) return Effect.void;
    if (read.effectiveModels.length === 0)
      return Effect.fail(
        new RuntimeError({
          operation: "record Outcome",
          message: "Settled session has no exact effective model.",
        }),
      );
    const result: Outcome["result"] =
      read.report === undefined
        ? { kind: "unreported", reason: read.reportError ?? "Worker report is absent." }
        : { kind: "reported", report: read.report };
    const self = this;
    return Effect.gen(function* () {
      self.store.insertOutcome(
        self.owner,
        `${record.id}-outcome`,
        record.id,
        outcomeFor(result, read.effectiveModels, now()),
      );
      yield* self.closeNewOutcome(record);
    });
  }

  private recoverSubmission(
    record: AttemptRecord,
    started: boolean,
  ): Effect.Effect<void, RuntimeError> {
    if (!started)
      return Effect.fail(
        new RuntimeError({
          operation: "recover Worker submission",
          message: "Kickoff is uncertain and the session does not prove actual start.",
        }),
      );
    const execution = record.attempt.execution;
    return effect("confirm Worker submission", () => {
      if (execution === undefined) return;
      this.store.checkpointAttempt(this.owner, record.id, {
        ...record.attempt,
        execution: { ...execution, submission: "confirmed" },
      });
    });
  }

  private submitWorker(record: AttemptRecord): Effect.Effect<void, RuntimeError> {
    const execution = record.attempt.execution;
    if (execution === undefined) return Effect.void;
    const self = this;
    return Effect.gen(function* () {
      const observation = yield* self.observeWorker(record);
      if (observation.state !== "ready")
        return yield* new RuntimeError({
          operation: "submit Worker",
          message: `Exact Worker is ${observation.state}; kickoff was not issued.`,
        });
      const checkpoint = self.store.checkpointAttempt(self.owner, record.id, {
        ...record.attempt,
        execution: { ...execution, submission: "uncertain" },
      });
      yield* self.herdr
        .prompt(observation.identity, "Begin the assigned Workgraph task")
        .pipe(Effect.mapError((cause) => runtimeError(cause.operation, cause)));
      const uncertain = checkpoint.attempt.execution;
      if (uncertain !== undefined)
        self.store.checkpointAttempt(self.owner, record.id, {
          ...checkpoint.attempt,
          execution: { ...uncertain, submission: "confirmed" },
        });
    });
  }

  /** Reconciliation after reload is observation-only and never repeats close. */
  private reconcileCancellation(record: AttemptRecord): Effect.Effect<void, RuntimeError> {
    const execution = record.attempt.execution;
    if (execution?.cancellation === undefined) return Effect.void;
    if (execution.sessionFile === undefined) return this.settleCancellation(record);
    return this.observeWorker(record).pipe(
      Effect.flatMap((observation) =>
        observation.state === "absent"
          ? this.settleCancellation(record)
          : Effect.fail(
              new RuntimeError({
                operation: "cancel Worker",
                message:
                  `Exact Worker is ${observation.state}; close will not be repeated. ${observation.state === "partial" ? observation.detail : ""}`.trim(),
              }),
            ),
      ),
    );
  }

  /** Only the call that newly persisted cancellation may issue its one close. */
  private closeNewCancellation(record: AttemptRecord): Effect.Effect<void, RuntimeError> {
    const execution = record.attempt.execution;
    if (execution?.cancellation === undefined) return Effect.void;
    if (execution.sessionFile === undefined) return this.settleCancellation(record);
    const self = this;
    return Effect.gen(function* () {
      const observation = yield* self.observeWorker(record);
      if (observation.state === "absent") return yield* self.settleCancellation(record);
      const closed = yield* self.closeObservedWorker(record, observation);
      if (closed !== "absent")
        return yield* new RuntimeError({
          operation: "cancel Worker",
          message: `Exact Worker remains ${closed}; close will not be repeated.`,
        });
      yield* self.settleCancellation(record);
    });
  }

  private settleCancellation(record: AttemptRecord): Effect.Effect<void, RuntimeError> {
    const execution = record.attempt.execution;
    const cancellation = execution?.cancellation;
    if (execution === undefined || cancellation === undefined) return Effect.void;
    const observedAt = now();
    return effect("settle cancellation", () => {
      this.store.settleCancellation(
        this.owner,
        `${record.id}-outcome`,
        record.id,
        { ...record.attempt, execution: { ...execution, closedAt: observedAt } },
        outcomeFor(
          { kind: "cancelled", reason: cancellation.reason },
          selectedModels(record.attempt),
          observedAt,
        ),
      );
    });
  }

  /** Only the transition that newly inserted the normal Outcome may issue its one close. */
  private closeNewOutcome(record: AttemptRecord): Effect.Effect<void, RuntimeError> {
    const self = this;
    return Effect.gen(function* () {
      const observation = yield* self.observeWorker(record);
      if (observation.state !== "absent") {
        const closed = yield* self.closeObservedWorker(record, observation);
        if (closed !== "absent")
          return yield* new RuntimeError({
            operation: "close Worker",
            message: `Exact Worker remains ${closed}; close will not be repeated.`,
          });
      }
      yield* self.recordClosed(record);
    });
  }

  /** Later reconciliation can settle verified absence but cannot issue close. */
  private settleObservedClosure(record: AttemptRecord): Effect.Effect<void, RuntimeError> {
    const execution = record.attempt.execution;
    if (execution === undefined)
      return Effect.fail(
        new RuntimeError({ operation: "close Worker", message: "Worker checkpoint is absent." }),
      );
    const outcome = this.store.readOutcome(record.id);
    const context = this.workerContext(record, this.store.readTask(record.taskId));
    if (outcome?.outcome.result.kind !== "cancelled") {
      const read =
        execution.sessionFile === undefined
          ? undefined
          : readWorkerSession(execution.sessionFile, context.cwd, context.objective);
      if (read === undefined || read.unreadable || !read.settled)
        return Effect.fail(
          new RuntimeError({
            operation: "close Worker",
            message: "Durable Outcome exists, but the exact readable session is not settled.",
          }),
        );
    }
    if (execution.sessionFile === undefined) return this.recordClosed(record);
    return this.observeWorker(record).pipe(
      Effect.flatMap((observation) =>
        observation.state === "absent"
          ? this.recordClosed(record)
          : Effect.fail(
              new RuntimeError({
                operation: "close Worker",
                message:
                  `Exact Worker is ${observation.state}; close will not be repeated. ${observation.state === "partial" ? observation.detail : ""}`.trim(),
              }),
            ),
      ),
    );
  }

  private recordClosed(record: AttemptRecord): Effect.Effect<void, RuntimeError> {
    const execution = record.attempt.execution;
    if (execution === undefined) return Effect.void;
    return effect("record Worker closure", () => {
      this.store.checkpointAttempt(this.owner, record.id, {
        ...record.attempt,
        execution: { ...execution, closedAt: now() },
      });
    });
  }

  private closeObservedWorker(
    record: AttemptRecord,
    observation: Exclude<WorkerObservation, { readonly state: "absent" }>,
  ): Effect.Effect<"absent" | "present", RuntimeError> {
    const request = this.workerRequest(record);
    return this.herdr.closeObservedWorker(request, observation).pipe(
      Effect.mapError(
        (cause) =>
          new RuntimeError({
            operation: cause.operation,
            message: `${cause.message} ${workerObservationDetail(observation)} Close will not be repeated.`,
          }),
      ),
    );
  }

  private reconcileOutput(record: AttemptRecord): Effect.Effect<void, RuntimeError> {
    if (record.attempt.base.kind !== "repository") return Effect.void;
    const operation = this.repositoryOperation(record);
    const output = record.attempt.output;
    const action =
      output?.kind === "applying"
        ? prepareApplication(operation).pipe(
            Effect.flatMap((attempt) =>
              effect("checkpoint application plan", () =>
                this.store.checkpointAttempt(this.owner, record.id, attempt),
              ),
            ),
            Effect.flatMap((checkpoint) =>
              applyOutput(this.repositoryOperation(checkpoint), now()),
            ),
          )
        : output?.kind === "discarding"
          ? discardOutput(operation, now())
          : output?.kind === "applied" &&
              output.cleanupTip !== undefined &&
              !this.store.hasUnclassifiedIntegrationChild(record.id)
            ? cleanupAppliedOutput(operation)
            : output === undefined
              ? classifyOutput(operation, now())
              : Effect.succeed(record.attempt);
    return action.pipe(
      Effect.flatMap((attempt) =>
        effect("checkpoint repository output", () => {
          this.store.checkpointAttempt(this.owner, record.id, attempt);
        }),
      ),
      Effect.mapError((cause) => runtimeError("reconcile repository output", cause)),
    );
  }

  private observeWorker(record: AttemptRecord): Effect.Effect<WorkerObservation, RuntimeError> {
    const request = this.workerRequest(record);
    return this.herdr
      .observeWorker(request)
      .pipe(Effect.mapError((cause) => runtimeError(cause.operation, cause)));
  }

  private workerRequest(record: AttemptRecord): HerdrLaunchRequest {
    const context = this.workerContext(record, this.store.readTask(record.taskId));
    const sessionFile = record.attempt.execution?.sessionFile;
    if (sessionFile === undefined)
      throw new RuntimeError({
        operation: "observe Worker",
        message: "Attempt has no durable Worker session identity.",
      });
    return this.herdrRequest(context, sessionFile);
  }

  private herdrRequest(context: WorkerContext, sessionFile: string): HerdrLaunchRequest {
    return {
      workspaceId: this.owner.workspaceId,
      runId: context.workstreamId,
      nodeId: context.attemptId,
      attemptId: context.attemptId,
      assignmentId: context.taskId,
      objective: context.objective.content,
      role: herdrRole(context.role),
      cwd: context.cwd,
      sessionFile,
      environment: {
        PI_WORKGRAPH_ROLE: context.role,
        PI_CODING_AGENT_DIR: this.agentDir,
      },
      model: context.target.model,
      thinking: context.target.thinking,
    };
  }

  private workerContext(attempt: AttemptRecord, task: TaskRecord): WorkerContext {
    const target = task.task.target;
    const cwd =
      target.kind === "directory" ? target.path : this.repositoryOperation(attempt).worktreePath;
    const role = task.task.contract.kind;
    const intent = this.store.readIntent(task.intentIndex);
    const modelTarget =
      attempt.attempt.selection.kind === "implementation"
        ? attempt.attempt.selection.guide
        : attempt.attempt.selection.target;
    return {
      workstreamId: this.store.id,
      attemptId: attempt.id,
      taskId: task.id,
      cwd,
      target: modelTarget,
      role,
      objective: this.workerObjective(task, attempt, role, intent.intent),
    };
  }

  private workerObjective(
    task: TaskRecord,
    attempt: AttemptRecord,
    role: WorkerRole,
    intent: Intent,
  ): WorkerObjective {
    const objective = workerObjective(
      this.store.id,
      task.id,
      attempt.id,
      role,
      intent,
      task.task.contract,
      attempt.attempt,
    );
    if (task.task.contract.kind !== "review") return objective;
    const ids =
      task.task.contract.subject.kind === "outcome"
        ? [task.task.contract.subject.outcomeId]
        : task.task.contract.subject.kind === "comparison"
          ? task.task.contract.subject.outcomeIds
          : [];
    const sources = ids.map((id) => {
      const outcome = this.store.readOutcomeById(id);
      const sourceAttempt = this.store.readAttempt(outcome.attemptId);
      const sourceTask = this.store.readTask(sourceAttempt.taskId);
      const summary =
        outcome.outcome.result.kind === "reported"
          ? outcome.outcome.result.report.summary
          : outcome.outcome.result.reason;
      return `Review source Outcome ${id}: summary=${JSON.stringify(summary)} task=${sourceTask.id} target=${JSON.stringify(sourceTask.task.target)} session=${sourceAttempt.attempt.execution?.sessionFile ?? "none"} revision=${sourceAttempt.attempt.output?.kind === "retained" ? sourceAttempt.attempt.output.tip : sourceAttempt.attempt.base.kind === "repository" ? sourceAttempt.attempt.base.baseCommit : "none"}`;
    });
    return { ...objective, content: [...objective.content.split("\n"), ...sources].join("\n") };
  }

  private reconciliation(): Effect.Effect<never, never> {
    const tick = Effect.gen(
      function* (this: WorkstreamRuntime) {
        const unsettled = yield* this.serialized("read unsettled records", () =>
          this.store.unsettled(),
        );
        this.blockers.delete("runtime");
        const tickAt = yield* Clock.currentTimeMillis;
        for (const item of unsettled) {
          const prior = this.blockers.get(item.attempt.id);
          if (prior !== undefined && prior.retryAt > tickAt) continue;
          const result = yield* Effect.result(
            this.serializedEffect("reconcile Attempt", this.reconcileAttempt(item.attempt.id)),
          );
          if (result._tag === "Success") this.blockers.delete(item.attempt.id);
          else {
            const failures = (prior?.failures ?? 0) + 1;
            const delay = Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5));
            this.blockers.set(item.attempt.id, {
              detail: result.failure.message,
              failures,
              retryAt: tickAt + delay,
            });
          }
        }
        yield* Queue.take(this.wakeQueue).pipe(
          Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.void }),
        );
      }.bind(this),
    ).pipe(
      Effect.catch((failure) =>
        Effect.sync(() => {
          this.blockers.set("runtime", {
            detail: failure.message,
            failures: 1,
            retryAt: 0,
          });
        }).pipe(Effect.andThen(Effect.sleep(1_000))),
      ),
    );
    return Effect.forever(tick);
  }

  private deliver(record: OutcomeRecord): Effect.Effect<void, RuntimeError> {
    let current = record;
    const delivered = Effect.result(
      boundaryEffect("deliver Outcome", () => {
        this.pi.sendMessage(
          {
            customType: "pi-workgraph-outcome",
            content: `Workgraph Outcome ${current.id} for Attempt ${current.attemptId}: ${JSON.stringify(current.outcome.result)}`,
            display: true,
            details: { outcomeId: current.id, attemptId: current.attemptId },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      }),
    );
    const self = this;
    return Effect.gen(function* () {
      const result = yield* delivered;
      const delivery =
        result._tag === "Success"
          ? { ...current.outcome.delivery, deliveredAt: now() }
          : {
              ...current.outcome.delivery,
              failures: [
                ...current.outcome.delivery.failures.slice(-4),
                { at: now(), detail: result.failure.message },
              ],
            };
      current = self.store.updateDelivery(self.owner, record.attemptId, delivery);
      if (result._tag === "Failure") return yield* result.failure;
    });
  }

  private wake(): Effect.Effect<void> {
    return Queue.offer(this.wakeQueue, undefined).pipe(Effect.asVoid);
  }
  private serialized<A>(operation: string, run: () => A): Effect.Effect<A, RuntimeError> {
    return this.serializedEffect(operation, effect(operation, run));
  }
  private serializedEffect<A>(
    operation: string,
    value: Effect.Effect<A, RuntimeError>,
  ): Effect.Effect<A, RuntimeError> {
    if (this.closed)
      return Effect.fail(new RuntimeError({ operation, message: "Runtime is closed." }));
    return this.semaphore.withPermit(
      value.pipe(
        Effect.catchDefect((cause) =>
          isExpectedError(cause) ? Effect.fail(runtimeError(operation, cause)) : Effect.die(cause),
        ),
      ),
    );
  }
}

function workerObjective(
  workstreamId: string,
  taskId: string,
  attemptId: string,
  role: WorkerRole,
  intent: Intent,
  contract: TaskContract,
  attempt: Attempt,
): WorkerObjective {
  const lines = [
    "[WORKGRAPH WORKER OBJECTIVE]",
    `Intent: ${intent.statement}`,
    ...intent.constraints.map((constraint) => `Constraint: ${constraint}`),
  ];
  if (contract.kind === "research") {
    lines.push(`Question: ${contract.question}`);
    lines.push(...contract.expectedEvidence.map((item) => `Expected evidence: ${item}`));
  } else if (contract.kind === "experiment") {
    lines.push(`Question: ${contract.question}`);
    lines.push(...contract.expectedEvidence.map((item) => `Expected evidence: ${item}`));
    lines.push(...contract.permittedEffects.map((item) => `Permitted effect: ${item}`));
    lines.push(`Stop condition: ${contract.stopCondition}`);
  } else if (contract.kind === "consultation") {
    lines.push(`Question: ${contract.question}`);
    if (contract.context !== undefined) lines.push(`Context: ${contract.context}`);
  } else if (contract.kind === "implementation") {
    lines.push(`Objective: ${contract.objective}`);
    lines.push(...contract.acceptance.map((item) => `Acceptance: ${item}`));
  } else {
    lines.push(`Objective: ${contract.objective}`, `Concern: ${contract.concern}`);
    lines.push(`Review subject: ${JSON.stringify(contract.subject)}`);
  }
  if (attempt.base.kind === "repository") lines.push(`Base revision: ${attempt.base.baseCommit}`);
  if (attempt.lineage !== undefined)
    lines.push(`Candidate facts: ${JSON.stringify(attempt.lineage)}`);
  return {
    content: lines.join("\n"),
    details: {
      workstreamId,
      taskId,
      attemptId,
      role,
      ...(attempt.selection.kind === "implementation"
        ? { executor: attempt.selection.executor }
        : {}),
    },
  };
}
function workerObservationDetail(
  observation: Exclude<WorkerObservation, { readonly state: "absent" }>,
): string {
  const native = observation.state === "ready" ? observation.identity : observation.pane;
  return `Exact resource workspace=${native.workspaceId} tab=${native.tabId} pane=${native.paneId}.`;
}
function selectedModels(attempt: Attempt): ModelTarget[] {
  const selected =
    attempt.selection.kind === "target"
      ? [attempt.selection.target]
      : [attempt.selection.guide, attempt.selection.executor];
  const seen = new Set<string>();
  return selected.filter((target) => {
    const key = `${target.model}\0${target.thinking}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function outcomeFor(
  result: Outcome["result"],
  effectiveModels: readonly ModelTarget[],
  observedAt: string,
): Outcome {
  if (effectiveModels.length === 0)
    throw new RuntimeError({
      operation: "record Outcome",
      message: "No exact effective Worker model was observed.",
    });
  return {
    result,
    effectiveModels: [...effectiveModels],
    delivery: { requestedAt: observedAt, failures: [] },
    observedAt,
  };
}
function runtimeError(operation: string, cause: unknown): RuntimeError {
  return cause instanceof RuntimeError
    ? cause
    : new RuntimeError({ operation, message: message(cause) });
}
function isExpectedError(
  cause: unknown,
): cause is RuntimeError | StoreError | GitError | HerdrError {
  return (
    cause instanceof RuntimeError ||
    cause instanceof StoreError ||
    cause instanceof GitError ||
    cause instanceof HerdrError
  );
}
function effect<A>(operation: string, run: () => A): Effect.Effect<A, RuntimeError> {
  return Effect.try({
    try: run,
    catch: (cause) => {
      if (isExpectedError(cause)) return runtimeError(operation, cause);
      throw cause;
    },
  });
}
function boundaryEffect<A>(operation: string, run: () => A): Effect.Effect<A, RuntimeError> {
  return Effect.try({
    try: run,
    catch: (cause) => runtimeError(operation, cause),
  });
}
function herdrRole(role: WorkerRole): import("../herdr-naming.js").WorkerRole {
  return role === "implementation" ? "implement" : role === "experiment" ? "research" : role;
}
function sameOwner(left: CoordinatorOwner, right: CoordinatorOwner): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.sessionFile === right.sessionFile &&
    left.workspaceId === right.workspaceId &&
    left.tabId === right.tabId
  );
}
function now(): string {
  return DateTime.formatIso(DateTime.nowUnsafe());
}
function message(cause: unknown): string {
  return cause instanceof StoreError || cause instanceof Error
    ? cause.message
    : "Operation failed.";
}
