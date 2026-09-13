/* oxlint-disable effecttsgo/node-builtin-import, typescript/no-this-alias, effecttsgo/try-catch-in-effect-gen, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread -- Effect owns runtime serialization; store pages and reports are decoded before use, while exact optional runtime facts remain omitted. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Data, DateTime, Effect, Queue, type Scope, Semaphore } from "effect";
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
  isAncestor,
  prepareApplication,
  prepareDiscard,
  type RepositoryOperation,
  resolveRevision,
  validateRetainedCandidate,
} from "../git.js";
import {
  HerdrCliRuntime,
  type WorkerIdentity as HerdrWorkerIdentity,
  type WorkerPane,
} from "../herdr.js";
import { herdrWorkerName } from "../herdr-naming.js";
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

export class WorkstreamRuntime {
  private readonly blockers = new Map<string, string>();
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
        new HerdrCliRuntime(),
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
      .map(([attemptId, detail]) => `${attemptId}: ${detail}`)
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
    return this.serializedEffect(
      "steer Worker",
      this.herdr
        .prompt(this.workerIdentity(attemptId), instruction)
        .pipe(Effect.mapError((cause) => runtimeError("steer Worker", cause))),
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
        const requestedAt = now();
        const execution = record.attempt.execution ?? { submission: "absent" as const };
        const saved = self.store.checkpointAttempt(self.owner, attemptId, {
          ...record.attempt,
          execution: { ...execution, cancellation: { reason, requestedAt } },
        });
        self.blockers.delete(attemptId);
        yield* self.wake();
        return saved;
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
    return Effect.gen(function* () {
      let record = self.store.readAttempt(attemptId);
      let outcome = self.store.readOutcome(attemptId);
      if (outcome === undefined && record.attempt.execution?.cancellation !== undefined) {
        yield* self.reconcileCancellation(record);
        record = self.store.readAttempt(attemptId);
        outcome = self.store.readOutcome(attemptId);
      }
      if (outcome === undefined) {
        yield* self.reconcileExecution(record);
        record = self.store.readAttempt(attemptId);
        outcome = self.store.readOutcome(attemptId);
      }
      if (outcome !== undefined && record.attempt.execution?.closedAt === undefined) {
        yield* self.closeReportedWorker(record);
        record = self.store.readAttempt(attemptId);
      }
      if (outcome !== undefined && record.attempt.execution?.closedAt !== undefined)
        yield* Effect.result(self.reconcileOutput(record));
      const currentOutcome = self.store.readOutcome(attemptId);
      if (currentOutcome !== undefined && currentOutcome.outcome.delivery.deliveredAt === undefined)
        yield* Effect.result(self.deliver(currentOutcome));
      self.blockers.delete(attemptId);
    });
  }

  private reconcileExecution(record: AttemptRecord): Effect.Effect<void, RuntimeError> {
    const task = this.store.readTask(record.taskId);
    const context = this.workerContext(record, task);
    return this.ensureRepository(task, record).pipe(
      Effect.mapError((cause) => runtimeError("prepare Attempt repository", cause)),
      Effect.flatMap(() => this.ensureWorkerSession(record, context)),
      Effect.flatMap((sessionRecord) => this.ensureWorkerAgent(sessionRecord, context)),
      Effect.flatMap((agentRecord) => this.reconcileWorkerSession(agentRecord, context)),
    );
  }

  private ensureWorkerSession(
    record: AttemptRecord,
    context: WorkerContext,
  ): Effect.Effect<AttemptRecord, RuntimeError> {
    if (record.attempt.execution?.sessionFile !== undefined) return Effect.succeed(record);
    return createWorkerSessionEffect({
      cwd: context.cwd,
      sessionDir: join(this.agentDir, "workgraph", "worker-sessions", this.store.id),
      objective: context.objective,
    }).pipe(
      Effect.provide(liveLayer),
      Effect.mapError((cause) => runtimeError("create Worker session", cause)),
      Effect.map((sessionFile) =>
        this.store.checkpointAttempt(this.owner, record.id, {
          ...record.attempt,
          execution: { submission: "absent", sessionFile },
        }),
      ),
    );
  }

  private ensureWorkerAgent(
    record: AttemptRecord,
    context: WorkerContext,
  ): Effect.Effect<AttemptRecord, RuntimeError> {
    const execution = record.attempt.execution;
    if (execution?.sessionFile === undefined)
      return Effect.fail(
        new RuntimeError({
          operation: "prepare Worker session",
          message: "Session checkpoint is absent.",
        }),
      );
    if (execution.terminalId !== undefined) return Effect.succeed(record);
    const self = this;
    const sessionFile = execution.sessionFile;
    const request = this.herdrRequest(context, sessionFile);
    return Effect.gen(function* () {
      let current = record;
      let pane: WorkerPane;
      let mayStart = false;
      if (execution.paneId === undefined || execution.tabId === undefined) {
        pane = yield* self.herdr
          .createWorkerTab(request)
          .pipe(Effect.mapError((cause) => runtimeError(cause.operation, cause)));
        current = self.store.checkpointAttempt(self.owner, record.id, {
          ...record.attempt,
          execution: { ...execution, paneId: pane.paneId, tabId: pane.tabId },
        });
        mayStart = true;
      } else pane = self.workerPane(context, execution.paneId, execution.tabId);
      const recovered = yield* self.herdr
        .recoverWorker(pane, sessionFile)
        .pipe(Effect.mapError((cause) => runtimeError(cause.operation, cause)));
      const observation =
        recovered ??
        (mayStart
          ? yield* self.herdr
              .startWorker(pane, request)
              .pipe(Effect.mapError((cause) => runtimeError(cause.operation, cause)))
          : undefined);
      if (observation === undefined || observation.status === "absent")
        return yield* new RuntimeError({
          operation: "recover Worker",
          message: "No exact agent follows the staged pane; start was not replayed.",
        });
      const currentExecution = current.attempt.execution;
      if (currentExecution === undefined)
        return yield* new RuntimeError({
          operation: "checkpoint Worker",
          message: "Worker execution checkpoint is absent.",
        });
      return self.store.checkpointAttempt(self.owner, record.id, {
        ...current.attempt,
        execution: { ...currentExecution, terminalId: observation.identity.terminalId },
      });
    });
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
    return effect("record Outcome", () => {
      this.store.insertOutcome(
        this.owner,
        `${record.id}-outcome`,
        record.id,
        outcomeFor(result, read.effectiveModels, now()),
      );
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
    const checkpoint = this.store.checkpointAttempt(this.owner, record.id, {
      ...record.attempt,
      execution: { ...execution, submission: "uncertain" },
    });
    return this.herdr
      .prompt(this.workerIdentity(record.id), "Begin the assigned Workgraph task")
      .pipe(
        Effect.mapError((cause) => runtimeError(cause.operation, cause)),
        Effect.flatMap(() =>
          effect("confirm Worker submission", () => {
            const uncertain = checkpoint.attempt.execution;
            if (uncertain === undefined) return;
            this.store.checkpointAttempt(this.owner, record.id, {
              ...checkpoint.attempt,
              execution: { ...uncertain, submission: "confirmed" },
            });
          }),
        ),
      );
  }

  private reconcileCancellation(record: AttemptRecord): Effect.Effect<void, RuntimeError> {
    const execution = record.attempt.execution;
    const cancellation = execution?.cancellation;
    if (execution === undefined || cancellation === undefined) return Effect.void;
    const self = this;
    return Effect.gen(function* () {
      let closed: "absent" | "present" | "unknown" = "absent";
      if (execution.paneId !== undefined && execution.tabId !== undefined) {
        closed =
          execution.terminalId === undefined
            ? yield* self.herdr
                .closeWorkerPane(
                  self.workerPane(
                    self.workerContext(record, self.store.readTask(record.taskId)),
                    execution.paneId,
                    execution.tabId,
                  ),
                )
                .pipe(Effect.mapError((cause) => runtimeError(cause.operation, cause)))
            : yield* self.herdr
                .close(self.workerIdentity(record.id))
                .pipe(Effect.mapError((cause) => runtimeError(cause.operation, cause)));
      }
      if (closed !== "absent")
        return yield* new RuntimeError({
          operation: "cancel Worker",
          message: `Exact Worker absence is ${closed}; destructive close will not be retried.`,
        });
      const observedAt = now();
      const saved = self.store.checkpointAttempt(self.owner, record.id, {
        ...record.attempt,
        execution: { ...execution, closedAt: observedAt },
      });
      self.store.insertOutcome(
        self.owner,
        `${record.id}-outcome`,
        record.id,
        outcomeFor(
          { kind: "cancelled", reason: cancellation.reason },
          selectedModels(saved.attempt),
          observedAt,
        ),
      );
    });
  }

  private closeReportedWorker(record: AttemptRecord): Effect.Effect<void, RuntimeError> {
    const execution = record.attempt.execution;
    if (execution === undefined)
      return Effect.fail(
        new RuntimeError({ operation: "close Worker", message: "Worker checkpoint is absent." }),
      );
    const context = this.workerContext(record, this.store.readTask(record.taskId));
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
    const self = this;
    return Effect.gen(function* () {
      const closed = yield* self.herdr
        .close(self.workerIdentity(record.id))
        .pipe(Effect.mapError((cause) => runtimeError(cause.operation, cause)));
      if (closed !== "absent")
        return yield* new RuntimeError({
          operation: "close Worker",
          message: `Exact Worker absence is ${closed}; destructive close will not be retried.`,
        });
      self.store.checkpointAttempt(self.owner, record.id, {
        ...record.attempt,
        execution: { ...execution, closedAt: now() },
      });
    });
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
          : output?.kind === "applied" && output.cleanupTip !== undefined
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

  private workerIdentity(attemptId: string): HerdrWorkerIdentity {
    const attempt = this.store.readAttempt(attemptId);
    const context = this.workerContext(attempt, this.store.readTask(attempt.taskId));
    const execution = attempt.attempt.execution;
    if (
      execution?.sessionFile === undefined ||
      execution.paneId === undefined ||
      execution.tabId === undefined ||
      execution.terminalId === undefined
    )
      throw new RuntimeError({
        operation: "inspect Worker",
        message: "Attempt has no exact Worker identity.",
      });
    return {
      ...this.workerPane(context, execution.paneId, execution.tabId),
      terminalId: execution.terminalId,
      sessionFile: execution.sessionFile,
    };
  }

  private workerPane(context: WorkerContext, paneId: string, tabId: string): WorkerPane {
    return {
      workspaceId: this.owner.workspaceId,
      tabId,
      paneId,
      agentName: herdrWorkerName({
        runId: context.workstreamId,
        nodeId: context.attemptId,
        attemptId: context.attemptId,
        assignmentId: context.taskId,
        objective: context.objective.content,
        role: herdrRole(context.role),
      }),
      cwd: context.cwd,
    };
  }

  private herdrRequest(context: WorkerContext, sessionFile: string) {
    return {
      ...this.workerPane(context, "pending", "pending"),
      runId: context.workstreamId,
      nodeId: context.attemptId,
      attemptId: context.attemptId,
      assignmentId: context.taskId,
      objective: context.objective.content,
      role: herdrRole(context.role),
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
        for (const item of unsettled) {
          if (this.blockers.has(item.attempt.id)) continue;
          const result = yield* Effect.result(
            this.serializedEffect("reconcile Attempt", this.reconcileAttempt(item.attempt.id)),
          );
          if (result._tag === "Failure") this.blockers.set(item.attempt.id, result.failure.message);
        }
        yield* Queue.take(this.wakeQueue).pipe(
          Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.void }),
        );
      }.bind(this),
    ).pipe(Effect.ignore);
    return Effect.forever(tick);
  }

  private deliver(record: OutcomeRecord): Effect.Effect<void, RuntimeError> {
    let current = record;
    const delivered = Effect.result(
      effect("deliver Outcome", () => {
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
                ...current.outcome.delivery.failures,
                { at: now(), detail: result.failure.message },
              ],
            };
      current = self.store.updateDelivery(self.owner, record.attemptId, delivery);
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
    return this.semaphore.withPermit(value);
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
function selectedModels(attempt: Attempt) {
  return attempt.selection.kind === "target"
    ? [attempt.selection.target]
    : [attempt.selection.guide, attempt.selection.executor];
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
function effect<A>(operation: string, run: () => A): Effect.Effect<A, RuntimeError> {
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
