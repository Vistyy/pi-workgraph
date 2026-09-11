/** Process-local workstream command and reconciliation owner. */
import { randomUUID } from "node:crypto";
import {
  Cause,
  Clock,
  Data,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  type FileSystem,
  type Path,
  Ref,
  Scope,
  Semaphore,
} from "effect";
import type { PlatformError } from "effect/PlatformError";
import { Value } from "typebox/value";
import {
  type AttemptKey,
  activateAttempt,
  type CoordinatorIdentity,
  checkpointCancellation,
  checkpointCleanup,
  completeWorkstream,
  type Intent,
  type RepositoryIdentity,
  recordDeliveryFailure,
  recordDeliverySuccess,
  recordEffectiveModel,
  recordWorkerExecution,
  type Task,
  terminalizeAttempt,
  type Workstream,
} from "../domain/workstream.js";
import { loadModelPolicyEffect, type ModelPolicy, type ModelPolicyError } from "../model-policy.js";
import {
  type AttemptRecords,
  type PlanningRecords,
  type WorkstreamPresentation,
  type WorkstreamRecordMutation,
  WorkstreamStore,
  type WorkstreamStoreError,
} from "../storage/workstream-store.js";
import {
  appendFacts,
  CancelCommandSchema,
  type CompleteCommand,
  CompleteCommandSchema,
  decodeCommand,
  enqueueFacts,
  exactAttempt,
  type ResumeCommand,
  ResumeCommandSchema,
  ReviseIntentCommandSchema,
  SteerCommandSchema,
  type SuspendCommand,
  SuspendCommandSchema,
  type WorkstreamAppendCommand,
  WorkstreamCommandError,
  type WorkstreamCommandPorts,
  type WorkstreamEnqueueCommand,
  workerIdentity,
} from "./commands.js";
import { classifyActionable, type FrontierEntry } from "./frontier.js";
import { applyMaintainedOutput, discardMaintainedOutput } from "./output.js";
import { decodeAppend, decodeEnqueue, planAppend, planEnqueue } from "./queue.js";
import {
  type ReconciliationAttention,
  type ReconciliationCommit,
  type ReconciliationContext,
  type ReconciliationControl,
  ReconciliationControlError,
  type ReconciliationDriver,
  type ReconciliationFrontierObservation,
  type ReconciliationMutation,
  ReconciliationScheduler,
  type ResolvedReviewInput,
} from "./reconciliation.js";

class WorkstreamRuntimeIdentityError extends Data.TaggedError("WorkstreamRuntimeIdentityError")<{
  readonly message: string;
}> {}

class WorkstreamRuntimeStoppedError extends Data.TaggedError("WorkstreamRuntimeStoppedError")<{
  readonly message: string;
}> {}

export class WorkstreamRuntimeOperationError extends Data.TaggedError(
  "WorkstreamRuntimeOperationError",
)<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

class WorkstreamRuntimeStaleError extends Data.TaggedError("WorkstreamRuntimeStaleError")<{
  readonly operation: string;
  readonly message: string;
}> {}

export type WorkstreamRuntimeError =
  | WorkstreamStoreError
  | ModelPolicyError
  | PlatformError
  | WorkstreamRuntimeIdentityError
  | WorkstreamRuntimeStoppedError
  | WorkstreamRuntimeStaleError
  | WorkstreamRuntimeOperationError
  | WorkstreamCommandError;

export type WorkstreamRuntimeEffect<A> = Effect.Effect<
  A,
  WorkstreamRuntimeError,
  FileSystem.FileSystem
>;

export interface WorkstreamRuntimeInspectionSnapshot {
  readonly workstream: Workstream;
  readonly reconciliation: readonly ReconciliationFrontierObservation[];
}

export interface WorkstreamRuntimeAcquisition {
  readonly id: string;
  readonly repository: RepositoryIdentity;
  readonly coordinator: CoordinatorIdentity;
  /** Process-local controller fence checked immediately before external effects. */
  readonly owns?: () => boolean;
  readonly policyPath?: string;
  readonly driver: ReconciliationDriver;
  readonly commands?: WorkstreamCommandPorts;
  readonly onReconciliationAttention?: ReconciliationAttention;
  readonly onPresentationChanged?: (state: WorkstreamPresentation) => Effect.Effect<void, never>;
  readonly onFatal?: (error: WorkstreamRuntimeError) => Effect.Effect<void, never>;
}

const STOPPED_MESSAGE = "Workstream runtime is closed and accepts no further commands.";

type RecordPlan =
  | Readonly<{ kind: "attempt"; key: AttemptKey }>
  | Readonly<{ kind: "lifecycle"; current: Workstream }>;

type QueuePlanningContext = {
  readonly planning: PlanningRecords;
  readonly tasks: Task[];
};
type WritableWorkstream = { -readonly [Key in keyof Workstream]: Workstream[Key] };
type MutableAttemptMutation = {
  -readonly [Key in keyof Extract<WorkstreamRecordMutation, { kind: "update_attempt" }>]: Extract<
    WorkstreamRecordMutation,
    { kind: "update_attempt" }
  >[Key];
};
type MutableLifecycleMutation = {
  -readonly [Key in keyof Extract<WorkstreamRecordMutation, { kind: "update_lifecycle" }>]: Extract<
    WorkstreamRecordMutation,
    { kind: "update_lifecycle" }
  >[Key];
};

/** Ready scoped owner for serialized workstream coordinator commands. */
export class WorkstreamRuntime {
  private closed = false;
  private started = false;

  private constructor(
    private readonly resourceScope: Scope.Scope,
    private readonly store: WorkstreamStore,
    private readonly semaphore: Semaphore.Semaphore,
    private readonly fibers: FiberSet.FiberSet<unknown, never>,
    private readonly scheduler: ReconciliationScheduler,
    private readonly closeRequest: Deferred.Deferred<WorkstreamRuntimeError | undefined>,
    private readonly shutdownClaimed: Ref.Ref<boolean>,
    private readonly completion: Deferred.Deferred<void, WorkstreamRuntimeError>,
    private readonly acquisition: WorkstreamRuntimeAcquisition,
  ) {}

  /**
   * Eagerly acquire a caller-Scope-owned workstream runtime. Escaping an
   * `Effect.scoped` acquisition returns an already-closed handle.
   */
  static acquire(
    acquisition: WorkstreamRuntimeAcquisition,
  ): Effect.Effect<WorkstreamRuntime, WorkstreamRuntimeError, FileSystem.FileSystem | Path.Path> {
    return WorkstreamRuntime.initialize(acquisition);
  }

  private static initialize(
    acquisition: WorkstreamRuntimeAcquisition,
  ): Effect.Effect<WorkstreamRuntime, WorkstreamRuntimeError, FileSystem.FileSystem | Path.Path> {
    return Effect.gen(function* () {
      const resourceScope = yield* Scope.make("sequential");
      return yield* WorkstreamRuntime.build(resourceScope, acquisition).pipe(
        Scope.provide(resourceScope),
        Effect.onError((cause) => Scope.close(resourceScope, Exit.failCause(cause))),
      );
    });
  }

  private static build(
    resourceScope: Scope.Scope,
    acquisition: WorkstreamRuntimeAcquisition,
  ): Effect.Effect<
    WorkstreamRuntime,
    WorkstreamRuntimeError,
    FileSystem.FileSystem | Path.Path | Scope.Scope
  > {
    return Effect.gen(function* () {
      const attachment = yield* WorkstreamStore.open(acquisition.id, acquisition.repository);
      const { store } = attachment;
      const state = attachment.state;
      if (!sameCoordinator(state.coordinator, acquisition.coordinator))
        return yield* new WorkstreamRuntimeIdentityError({
          message: `Workstream ${acquisition.id} belongs to another coordinator session.`,
        });
      const semaphore = yield* Semaphore.make(1);
      const fibers = yield* FiberSet.make<unknown, never>();
      const scheduler = yield* ReconciliationScheduler.make(
        acquisition.driver,
        acquisition.onReconciliationAttention ?? (() => Effect.void),
      );
      const closeRequest = yield* Deferred.make<WorkstreamRuntimeError | undefined>();
      const shutdownClaimed = yield* Ref.make(false);
      const completion = yield* Deferred.make<void, WorkstreamRuntimeError>();
      const runtime = new WorkstreamRuntime(
        resourceScope,
        store,
        semaphore,
        fibers,
        scheduler,
        closeRequest,
        shutdownClaimed,
        completion,
        acquisition,
      );
      yield* scheduler.provideControls((key) => runtime.controlFor(key));
      yield* scheduler.provideSource(() =>
        store
          .readActionable()
          .pipe(
            Effect.map((records) =>
              classifyActionable(records.lifecycle, records.currentIntentIndex, records.records),
            ),
          ),
      );
      if (acquisition.owns === undefined) yield* runtime.start();
      return runtime;
    });
  }

  /** Publish-time activation keeps controller acquisition free of external effects. */
  readonly start = (): Effect.Effect<
    void,
    WorkstreamRuntimeError,
    FileSystem.FileSystem | Path.Path
  > =>
    this.serialized(
      Effect.gen(
        function* (this: WorkstreamRuntime) {
          if (this.started) return;
          yield* this.fence();
          this.started = true;
          yield* this.scheduler.attach();
          yield* FiberSet.run(this.fibers, this.scheduler.run());
        }.bind(this),
      ),
    );

  /** Fenced read through the serialized boundary; also re-proves ownership. */
  readonly read = (): WorkstreamRuntimeEffect<Workstream> =>
    this.serialized(this.fencedRead().pipe(Effect.map((state) => structuredClone(state))));

  /** Assemble a current inspection view from authoritative records. */
  readonly snapshot = (): WorkstreamRuntimeEffect<Workstream> => this.serialized(this.store.read());

  /** Read only the status facts consumed by coordinator presentation. */
  readonly presentation = (): WorkstreamRuntimeEffect<WorkstreamPresentation> =>
    this.serialized(this.store.readPresentation());

  /** Read only the parent facts needed to derive a one-shot Handoff Grant. */
  readonly handoffParent = () => this.serialized(this.store.readHandoffParent());

  /** Process-local ownership is the exact active runtime instance. */
  readonly checkOwnership = (): WorkstreamRuntimeEffect<void> => this.serialized(this.fence());

  /** Enqueue one immutable Task with its resolved initial Attempt(s). */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Queue commands are external boundary values validated by the workstream TypeBox schema.
  readonly enqueue = (command: unknown): WorkstreamRuntimeEffect<Workstream> =>
    this.serialized(this.enqueueEffect(command));

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Queue commands are external boundary values validated by the workstream TypeBox schema.
  readonly appendAttempts = (command: unknown): WorkstreamRuntimeEffect<Workstream> =>
    this.serialized(this.appendEffect(command));

  readonly readAttempt = (
    attemptId: string,
  ): WorkstreamRuntimeEffect<ReturnType<typeof exactAttempt>> =>
    this.serialized(
      Effect.gen(
        function* (this: WorkstreamRuntime) {
          yield* this.fence();
          const records = yield* this.store.readAttempt(undefined, attemptId);
          return {
            key: { taskId: records.task.id, attemptId },
            task: records.task,
            attempt: records.attempt,
          };
        }.bind(this),
      ),
    );

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Workstream TypeBox schema decodes this external command value.
  readonly suspend = (command: unknown): WorkstreamRuntimeEffect<void> =>
    this.scheduler.withDispatchBarrier(
      Effect.uninterruptible(
        this.serialized(
          Effect.gen(
            function* (this: WorkstreamRuntime) {
              const input = yield* this.try("decode suspension", () =>
                decodeCommand<SuspendCommand>(SuspendCommandSchema, command, "suspension command"),
              );
              const now = yield* this.now();
              const revision = yield* this.store.readRevision();
              yield* this.store.mutateRecords(this.acquisition.coordinator, revision, {
                kind: "update_lifecycle",
                lifecycle: "suspended",
                suspension: { reason: input.reason, suspendedAt: now },
                updatedAt: now,
              });
              yield* this.scheduler.attach();
              yield* this.publishPresentation();
            }.bind(this),
          ),
        ),
      ),
    );

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Workstream TypeBox schema decodes this external command value.
  readonly resume = (command: unknown): WorkstreamRuntimeEffect<void> =>
    this.scheduler.withDispatchBarrier(
      Effect.uninterruptible(
        this.serialized(
          Effect.gen(
            function* (this: WorkstreamRuntime) {
              yield* this.try("decode resumption", () =>
                decodeCommand<ResumeCommand>(ResumeCommandSchema, command, "resumption command"),
              );
              const now = yield* this.now();
              const revision = yield* this.store.readRevision();
              yield* this.store.mutateRecords(this.acquisition.coordinator, revision, {
                kind: "update_lifecycle",
                lifecycle: "active",
                updatedAt: now,
              });
              yield* this.scheduler.attach();
              yield* this.publishPresentation();
            }.bind(this),
          ),
        ),
      ),
    );

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Workstream TypeBox schema decodes this external command value.
  readonly reviseIntent = (command: unknown): WorkstreamRuntimeEffect<void> =>
    this.serialized(
      Effect.gen(
        function* (this: WorkstreamRuntime) {
          const intent = yield* this.try("decode Intent revision", () =>
            decodeCommand<Intent>(ReviseIntentCommandSchema, command, "Intent revision"),
          );
          const revision = yield* this.store.readRevision();
          const now = yield* this.now();
          yield* this.store.mutateRecords(this.acquisition.coordinator, revision, {
            kind: "append_intent",
            intent,
            updatedAt: now,
          });
          yield* this.scheduler.attach();
        }.bind(this),
      ),
    );

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Workstream TypeBox schema decodes this external command value.
  readonly complete = (command: unknown): WorkstreamRuntimeEffect<Workstream> =>
    this.serialized(
      Effect.gen(
        function* (this: WorkstreamRuntime) {
          const input = yield* this.try("decode completion", () =>
            decodeCommand<CompleteCommand>(CompleteCommandSchema, command, "completion command"),
          );
          const now = yield* this.now();
          const current = yield* this.store.readCompletionState();
          return yield* this.authoritative(
            "complete Workstream",
            (state) => completeWorkstream(state, { ...input, completedAt: now }, now),
            { kind: "lifecycle", current },
          );
        }.bind(this),
      ),
    );

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Workstream TypeBox schema decodes this external command value.
  readonly cancel = (command: unknown): WorkstreamRuntimeEffect<Workstream> =>
    this.serialized(
      Effect.gen(
        function* (this: WorkstreamRuntime) {
          const input = yield* this.try("decode cancellation", () =>
            decodeCommand<{ attemptId: string; reason: string }>(
              CancelCommandSchema,
              command,
              "cancellation command",
            ),
          );
          const before = yield* this.keyedState(input.attemptId);
          const located = yield* this.try("resolve cancellation Attempt", () =>
            exactAttempt(before, input.attemptId),
          );
          const now = yield* this.now();
          const committed = yield* this.authoritative(
            "request workstream cancellation",
            (state) => planCancellation(state, located.key, input.reason, now),
            { kind: "attempt", key: located.key },
          );
          if (before.revision !== committed.revision)
            yield* this.notifyCommitted(committed, [located.key]);
          return committed;
        }.bind(this),
      ),
    );

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Workstream TypeBox schema decodes this external command value.
  readonly steer = (command: unknown): WorkstreamRuntimeEffect<Workstream> =>
    this.serialized(this.steerEffect(command));

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Workstream TypeBox schema decodes this external command value.
  readonly apply = (command: unknown): WorkstreamRuntimeEffect<Workstream> =>
    this.serialized(
      Effect.flatMap(this.commandPorts(), (ports) =>
        applyMaintainedOutput(this.outputControl(ports), command),
      ),
    );

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Workstream TypeBox schema decodes this external command value.
  readonly discardOutput = (command: unknown): WorkstreamRuntimeEffect<Workstream> =>
    this.serialized(
      Effect.flatMap(this.commandPorts(), (ports) =>
        discardMaintainedOutput(this.outputControl(ports), command),
      ),
    );

  /** Derive the current reconciliation projection from SQLite facts. */
  readonly frontierSnapshot = (): Effect.Effect<
    readonly FrontierEntry[],
    never,
    FileSystem.FileSystem
  > => this.scheduler.snapshot();

  readonly inspectionSnapshot = (): WorkstreamRuntimeEffect<WorkstreamRuntimeInspectionSnapshot> =>
    this.serialized(
      Effect.gen(
        function* (this: WorkstreamRuntime) {
          const current = yield* this.fencedRead();
          return {
            workstream: structuredClone(current),
            reconciliation: yield* this.scheduler.inspectionSnapshot(),
          };
        }.bind(this),
      ),
    );

  /** Clear transient observations and wake reconciliation from current records. */
  readonly reconcile = (): WorkstreamRuntimeEffect<readonly FrontierEntry[]> =>
    this.serialized(
      Effect.gen(
        function* (this: WorkstreamRuntime) {
          yield* this.fence();
          yield* this.scheduler.attach();
          return yield* this.scheduler.snapshot();
        }.bind(this),
      ),
    );

  /** Restrict one driver dispatch to its exact Attempt. */
  private controlFor(
    key: AttemptKey,
  ): Effect.Effect<ReconciliationControl, ReconciliationControlError, FileSystem.FileSystem> {
    return this.serialized(this.contextFor(key)).pipe(
      Effect.map((initialContext) => {
        let context = initialContext;
        return {
          context: () => context,
          checkOwnership: this.fence().pipe(
            Effect.mapError((error) => controlError(errorMessage(error), error)),
          ),
          commit: (mutation: ReconciliationMutation) =>
            this.controlCommit(key, mutation).pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  if (result.kind === "committed") context = result.receipt.context;
                }),
              ),
            ),
        };
      }),
      Effect.mapError((error) => controlError(errorMessage(error), error)),
    );
  }

  /** Exact-key context assembled from one Attempt and explicitly referenced records. */
  private contextFor(key: AttemptKey): WorkstreamRuntimeEffect<ReconciliationContext> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const records = yield* this.store.readAttempt(key.taskId, key.attemptId);
        const { attempts: _attempts, ...contract } = records.task;
        const context: WritableContext = {
          workstreamId: records.workstreamId,
          repository: records.repository,
          intent: { index: records.task.intentIndex, value: records.intent },
          task: contract,
          attempt: records.attempt,
        };
        if (records.task.kind === "review")
          context.reviewInput = yield* this.resolveReviewInput(records.task.subject);
        const continuation = records.attempt.continuationOf;
        if (continuation !== undefined) {
          const parent = yield* this.store.readAttempt(records.task.id, continuation);
          const sessionFile = parent.attempt.execution?.sessionFile;
          if (sessionFile !== undefined) context.continuationSessionFile = sessionFile;
        }
        return structuredClone(context);
      }.bind(this),
    );
  }

  private resolveReviewInput(
    subject: Extract<Task, { kind: "review" }>["subject"],
  ): WorkstreamRuntimeEffect<ResolvedReviewInput> {
    switch (subject.kind) {
      case "revision":
        return Effect.succeed({ kind: "revision", revision: subject.revision });
      case "outcome":
        return this.store
          .readOutcome(subject.outcomeId)
          .pipe(Effect.map((outcome) => ({ kind: "outcome" as const, outcome })));
      case "comparison":
        return Effect.forEach(subject.outcomeIds, (id) => this.store.readOutcome(id)).pipe(
          Effect.map((outcomes) => ({ kind: "comparison" as const, outcomes })),
        );
      case "artifact":
        return Effect.flatMap(this.store.readOutcome(subject.outcomeId), (outcome) => {
          const artifact = outcome.artifacts.find(
            (item) => item.id === subject.artifactId && item.retention === "retained",
          );
          return artifact === undefined
            ? Effect.fail(
                new WorkstreamRuntimeOperationError({
                  operation: "resolve review input",
                  message: `Review subject references an artifact that is not retained: ${subject.artifactId}.`,
                }),
              )
            : Effect.succeed({ kind: "artifact" as const, outcome, artifact });
        });
    }
  }

  /** Commit one driver mutation; durable no-ops do not wake reconciliation. */
  private controlCommit(
    key: AttemptKey,
    mutation: ReconciliationMutation,
  ): Effect.Effect<ReconciliationCommit, ReconciliationControlError, FileSystem.FileSystem> {
    const effect = Effect.gen(
      function* (this: WorkstreamRuntime) {
        const beforeRevision = yield* this.store.readRevision();
        const now = yield* this.now();
        const committed = yield* this.authoritative(
          "apply workstream reconciliation mutation",
          (expected) => applyReconciliationMutation(expected, key, mutation, now),
          { kind: "attempt", key },
        );
        if (committed.revision === beforeRevision) return { kind: "no_change" } as const;
        yield* this.notifyCommitted(committed, [key]);
        return {
          kind: "committed",
          receipt: {
            key,
            revision: committed.revision,
            context: yield* this.contextFor(key),
          },
        } as const;
      }.bind(this),
    );
    return this.serialized(effect).pipe(
      Effect.mapError((error) => controlError(errorMessage(error), error)),
    );
  }

  /** The single idempotent close boundary for explicit shutdown. */
  readonly close = (): Effect.Effect<void, WorkstreamRuntimeError> => this.closeEffect();

  readonly awaitClosed = (): Effect.Effect<void, WorkstreamRuntimeError> =>
    Deferred.await(this.completion);

  private fencedRead(): Effect.Effect<Workstream, WorkstreamStoreError, FileSystem.FileSystem> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        return yield* this.store.read();
      }.bind(this),
    );
  }

  private enqueueEffect(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Queue commands are external boundary values validated by the workstream TypeBox schema.
    command: unknown,
  ): Effect.Effect<Workstream, WorkstreamRuntimeError, FileSystem.FileSystem> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const decoded = yield* this.try("decode workstream Task enqueue", () =>
          decodeEnqueue(command),
        );
        const policy = yield* this.policy();
        const plan = yield* this.try("plan workstream Task enqueue", () =>
          planEnqueue(decoded, policy),
        );
        const context = yield* this.enqueueState(decoded);
        if (yield* this.store.taskExists(plan.taskId))
          return yield* new WorkstreamRuntimeOperationError({
            operation: "enqueue workstream Task",
            message: `Task ${plan.taskId} already exists.`,
          });
        const facts = yield* enqueueFacts(context, decoded, this.acquisition.commands?.git);
        const now = yield* this.now();
        const attemptIds = Array.from(
          { length: plan.attemptCount },
          () => `attempt-${randomUUID()}`,
        );
        const task = yield* this.try("enqueue workstream Task", () =>
          plan.materialize(attemptIds, now, context.planning.currentIntentIndex, facts),
        );
        const revision = yield* this.store.mutateRecords(
          this.acquisition.coordinator,
          context.planning.revision,
          { kind: "create_task", task, updatedAt: now },
        );
        if (revision !== context.planning.revision + 1)
          return yield* staleError("enqueue workstream Task");
        yield* this.publishPresentation();
        const committed = yield* this.keyedState(attemptIds[0] ?? "");
        yield* this.notifyCommitted(
          committed,
          attemptIds.map((attemptId) => ({ taskId: plan.taskId, attemptId })),
        );
        return committed;
      }.bind(this),
    );
  }

  private appendEffect(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Queue commands are external boundary values validated by the workstream TypeBox schema.
    command: unknown,
  ): Effect.Effect<Workstream, WorkstreamRuntimeError, FileSystem.FileSystem> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const decoded = yield* this.try("decode workstream append command", () =>
          decodeAppend(command),
        );
        const policy = yield* this.policy();
        const context = yield* this.appendState(decoded);
        const resolved = yield* this.try("resolve workstream append plan", () => {
          const task = context.tasks.find((item) => item.id === decoded.taskId);
          if (task === undefined) throw new Error(`Unknown Task ${decoded.taskId}.`);
          return planAppend(decoded, task, policy);
        });
        const facts = yield* appendFacts(context, decoded, this.acquisition.commands?.git);
        const now = yield* this.now();
        const attemptIds = Array.from(
          { length: resolved.attemptCount },
          () => `attempt-${randomUUID()}`,
        );
        const attempts = yield* this.try("append workstream Attempts", () =>
          resolved.materialize(attemptIds, now, facts),
        );
        const revision = yield* this.store.mutateRecords(
          this.acquisition.coordinator,
          context.planning.revision,
          { kind: "append_attempts", taskId: decoded.taskId, attempts, updatedAt: now },
        );
        if (revision !== context.planning.revision + 1)
          return yield* staleError("append workstream Attempts");
        yield* this.publishPresentation();
        const committed = yield* this.keyedState(attemptIds[0] ?? "");
        yield* this.notifyCommitted(
          committed,
          attemptIds.map((attemptId) => ({ taskId: decoded.taskId, attemptId })),
        );
        return committed;
      }.bind(this),
    );
  }

  private enqueueState(
    command: WorkstreamEnqueueCommand,
  ): WorkstreamRuntimeEffect<QueuePlanningContext> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const planning = yield* this.store.readPlanningRecords();
        const tasks: Task[] = [];
        const candidate = candidateAttempt(command);
        if (candidate !== undefined) {
          const parent = yield* this.store.readAttempt(undefined, candidate);
          tasks.push(parent.task);
        }
        for (const id of reviewOutcomes(command)) {
          const records = yield* this.store.readAttemptForOutcome(id);
          yield* this.store.readOutcome(id);
          const existing = tasks.find((task) => task.id === records.task.id);
          if (existing === undefined) tasks.push(records.task);
          else if (!existing.attempts.some((attempt) => attempt.id === records.attempt.id))
            existing.attempts.push(records.attempt);
        }
        return { planning, tasks };
      }.bind(this),
    );
  }

  private appendState(
    command: WorkstreamAppendCommand,
  ): WorkstreamRuntimeEffect<QueuePlanningContext> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const planning = yield* this.store.readPlanningRecords();
        const tasks = [yield* this.store.readTask(command.taskId)];
        if (command.candidateOf !== undefined) {
          const parent = yield* this.store.readAttempt(undefined, command.candidateOf);
          const existing = tasks.find((task) => task.id === parent.task.id);
          if (existing === undefined) tasks.push(parent.task);
          else if (!existing.attempts.some((attempt) => attempt.id === parent.attempt.id))
            existing.attempts.push(parent.attempt);
        }
        return { planning, tasks };
      }.bind(this),
    );
  }

  private outputControl(ports: WorkstreamCommandPorts) {
    return {
      state: (attemptId: string) => this.keyedState(attemptId),
      commit: (operation: string, key: AttemptKey, plan: (state: Workstream) => Workstream) =>
        Effect.tap(this.authoritative(operation, plan, { kind: "attempt", key }), (committed) =>
          this.notifyCommitted(committed, [key]),
        ),
      fence: this.fence(),
      now: this.now(),
      ports,
    };
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Called only from the schema-owning public steering boundary.
  private steerEffect(command: unknown): WorkstreamRuntimeEffect<Workstream> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const input = yield* this.try("decode steering command", () =>
          decodeCommand<{ attemptId: string; instruction: string }>(
            SteerCommandSchema,
            command,
            "steering command",
          ),
        );
        const ports = yield* this.commandPorts();
        const initial = yield* this.keyedState(input.attemptId);
        const located = yield* this.try("resolve steering Attempt", () =>
          exactAttempt(initial, input.attemptId),
        );
        const currentSteering = located.attempt.execution?.steering;
        if (currentSteering?.state === "submitted" && currentSteering.text === input.instruction)
          return initial;
        if (currentSteering?.state === "uncertain")
          return yield* new WorkstreamCommandError({
            operation: "steer Worker",
            message: `Attempt ${input.attemptId} has an uncertain steering delivery; inspect before any resend.`,
          });
        const identity = yield* this.try("resolve ready Worker", () =>
          workerIdentity(located.attempt),
        );
        const now = yield* this.now();
        yield* this.authoritative(
          "checkpoint uncertain steering",
          (state) =>
            recordWorkerExecution(
              state,
              located.key,
              { steering: { text: input.instruction, state: "uncertain", observedAt: now } },
              now,
            ),
          { kind: "attempt", key: located.key },
        );
        yield* this.fence();
        yield* ports.workers.steer(identity, input.instruction);
        const submittedAt = yield* this.now();
        const committed = yield* this.authoritative(
          "checkpoint submitted steering",
          (state) =>
            recordWorkerExecution(
              state,
              located.key,
              {
                steering: { text: input.instruction, state: "submitted", observedAt: submittedAt },
              },
              submittedAt,
            ),
          { kind: "attempt", key: located.key },
        );
        yield* this.notifyCommitted(committed, [located.key]);
        return committed;
      }.bind(this),
    );
  }

  private keyedState(attemptId: string): WorkstreamRuntimeEffect<Workstream> {
    return this.store
      .readAttempt(undefined, attemptId)
      .pipe(Effect.map((records) => partialWorkstream(records, this.acquisition.coordinator)));
  }

  /** Direct fence for code already holding the sole runtime Semaphore. */
  private fence(): Effect.Effect<void, WorkstreamRuntimeIdentityError> {
    return Effect.suspend(() =>
      this.acquisition.owns === undefined || this.acquisition.owns()
        ? Effect.void
        : Effect.fail(
            new WorkstreamRuntimeIdentityError({
              message: "Workstream runtime is no longer the active controller instance.",
            }),
          ),
    );
  }

  private commandPorts(): Effect.Effect<WorkstreamCommandPorts, WorkstreamRuntimeOperationError> {
    return this.acquisition.commands === undefined
      ? Effect.fail(
          new WorkstreamRuntimeOperationError({
            operation: "workstream explicit command",
            message: "Workstream explicit command host ports are unavailable.",
          }),
        )
      : Effect.succeed(this.acquisition.commands);
  }

  /** Commit one planned domain mutation at the current record revision. */
  private authoritative(
    operation: string,
    plan: (expected: Workstream) => Workstream,
    records: RecordPlan,
  ): Effect.Effect<Workstream, WorkstreamRuntimeError, FileSystem.FileSystem> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const current =
          records.kind === "attempt"
            ? partialWorkstream(
                yield* this.store.readAttempt(records.key.taskId, records.key.attemptId),
                this.acquisition.coordinator,
              )
            : records.current;
        if (this.closed) return yield* stoppedError();
        const expectedRevision = current.revision;
        const next = yield* this.try(operation, () => plan(current));
        if (Value.Equal(current, next)) return structuredClone(current);
        const mutation = yield* this.try(operation, () => recordMutation(current, next, records));
        const revision = yield* this.store.mutateRecords(
          this.acquisition.coordinator,
          expectedRevision,
          mutation,
        );
        if (revision !== next.revision) return yield* staleError(operation);
        yield* this.publishPresentation();
        return structuredClone(next);
      }.bind(this),
    );
  }

  private publishPresentation(): Effect.Effect<void, never, FileSystem.FileSystem> {
    const publish = this.acquisition.onPresentationChanged;
    return publish === undefined
      ? Effect.void
      : this.store.readPresentation().pipe(Effect.flatMap(publish), Effect.ignoreCause);
  }

  private policy(): Effect.Effect<
    ModelPolicy,
    ModelPolicyError | PlatformError,
    FileSystem.FileSystem
  > {
    return loadModelPolicyEffect(this.acquisition.policyPath);
  }

  /** Update reconciliation for only the Attempts changed by a commit. */
  private notifyCommitted(committed: Workstream, keys: readonly AttemptKey[]): Effect.Effect<void> {
    return this.scheduler.notifyCommitted(committed, keys);
  }

  private now(): Effect.Effect<string> {
    return Clock.clockWith((clock) =>
      Effect.sync(() => isoFromMillis(clock.currentTimeMillisUnsafe())),
    );
  }

  private try<A>(
    operation: string,
    run: () => A,
  ): Effect.Effect<A, WorkstreamRuntimeOperationError> {
    return Effect.try({
      try: run,
      catch: (cause) =>
        new WorkstreamRuntimeOperationError({
          operation,
          message: errorMessage(cause),
          cause,
        }),
    });
  }

  /** Serialize a command in the owned FiberSet so close interrupts and joins it. */
  private serialized<A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | WorkstreamRuntimeStoppedError, R> {
    return Effect.suspend(
      function (this: WorkstreamRuntime) {
        if (this.closed) return Effect.fail(stoppedError());
        const run = Effect.gen(
          function* (this: WorkstreamRuntime) {
            const fiber = yield* FiberSet.run(
              this.fibers,
              Effect.exit(
                this.semaphore.withPermit(
                  Effect.suspend<A, E | WorkstreamRuntimeStoppedError, R>(() =>
                    this.closed ? Effect.fail(stoppedError()) : effect,
                  ),
                ),
              ),
            );
            const exit = yield* Fiber.join(fiber).pipe(
              Effect.onInterrupt(() => Fiber.interrupt(fiber).pipe(Effect.asVoid)),
            );
            return yield* exit;
          }.bind(this),
        );
        return run;
      }.bind(this),
    );
  }

  private requestClose(fatal?: WorkstreamRuntimeError): Effect.Effect<void> {
    return Effect.sync(() => {
      this.closed = true;
    }).pipe(Effect.andThen(Deferred.succeed(this.closeRequest, fatal)), Effect.asVoid);
  }

  /** One uninterruptible claim closes resources and settles shared completion. */
  private shutdown(): Effect.Effect<void, WorkstreamRuntimeError> {
    const close: Effect.Effect<WorkstreamRuntimeError | undefined> = Effect.uninterruptible(
      Effect.gen(
        function* (this: WorkstreamRuntime) {
          const owned = yield* Ref.getAndSet(this.shutdownClaimed, true);
          if (owned) return undefined;
          const fatal = yield* Deferred.await(this.closeRequest);
          const exit = yield* Effect.exit(Scope.close(this.resourceScope, Exit.void));
          const closeError = Exit.isFailure(exit) ? closeFailure(exit.cause) : undefined;
          if (closeError === undefined) yield* Deferred.succeed(this.completion, undefined);
          else yield* Deferred.fail(this.completion, closeError);
          if (fatal === undefined) return undefined;
          return closeError === undefined ? fatal : combineFatalClose(fatal, closeError);
        }.bind(this),
      ),
    );
    return close.pipe(
      Effect.tap((fatal) => (fatal === undefined ? Effect.void : this.report(fatal))),
      Effect.andThen(Deferred.await(this.completion)),
    );
  }

  private report(error: WorkstreamRuntimeError): Effect.Effect<void> {
    const report = this.acquisition.onFatal;
    return report === undefined ? Effect.void : report(error).pipe(Effect.ignoreCause);
  }

  private closeEffect(): Effect.Effect<void, WorkstreamRuntimeError> {
    return this.requestClose().pipe(Effect.andThen(this.shutdown()));
  }
}

function candidateAttempt(command: WorkstreamEnqueueCommand): string | undefined {
  return command.kind === "implementation" ? command.candidateOf : undefined;
}

function reviewOutcomes(command: WorkstreamEnqueueCommand): readonly string[] {
  if (command.kind !== "review" || command.subject.kind === "revision") return [];
  return command.subject.kind === "comparison"
    ? command.subject.outcomeIds
    : [command.subject.outcomeId];
}

function partialWorkstream(records: AttemptRecords, coordinator: CoordinatorIdentity): Workstream {
  const intents = Array.from({ length: records.currentIntentIndex + 1 }, () =>
    structuredClone(records.intent),
  );
  const value: WritableWorkstream = {
    format: "pi-workgraph-workstream",
    schemaVersion: 3,
    revision: records.revision,
    id: records.workstreamId,
    purpose: records.intent.statement,
    repository: structuredClone(records.repository),
    coordinator: structuredClone(coordinator),
    lifecycle: records.lifecycle,
    intents,
    tasks: [structuredClone(records.task)],
    createdAt: records.attempt.createdAt,
    updatedAt: records.attempt.updatedAt,
  };
  if (records.suspension !== undefined) value.suspension = structuredClone(records.suspension);
  if (records.completion !== undefined) value.completion = structuredClone(records.completion);
  return value;
}

function recordMutation(
  current: Workstream,
  next: Workstream,
  plan: RecordPlan,
): WorkstreamRecordMutation {
  switch (plan.kind) {
    case "attempt": {
      const mutation: MutableAttemptMutation = {
        kind: "update_attempt",
        key: plan.key,
        attempt: exactAttempt(next, plan.key.attemptId).attempt,
        updatedAt: next.updatedAt,
      };
      if (next.completion !== undefined) {
        const outcomeIds = new Set(
          [
            exactAttempt(current, plan.key.attemptId).attempt.outcome?.id,
            exactAttempt(next, plan.key.attemptId).attempt.outcome?.id,
          ].filter((id): id is string => id !== undefined),
        );
        mutation.completion =
          current.completion === undefined
            ? next.completion
            : {
                ...next.completion,
                accounting: [
                  ...current.completion.accounting.filter((item) =>
                    "taskId" in item
                      ? item.taskId !== plan.key.taskId || item.attemptId !== plan.key.attemptId
                      : !outcomeIds.has(item.outcomeId),
                  ),
                  ...next.completion.accounting,
                ],
              };
      }
      return mutation;
    }
    case "lifecycle": {
      const mutation: MutableLifecycleMutation = {
        kind: "update_lifecycle",
        lifecycle: next.lifecycle,
        updatedAt: next.updatedAt,
      };
      if (next.suspension !== undefined) mutation.suspension = next.suspension;
      if (next.completion !== undefined) mutation.completion = next.completion;
      return mutation;
    }
  }
}

function planCancellation(
  state: Workstream,
  key: AttemptKey,
  reason: string,
  now: string,
): Workstream {
  const current = exactAttempt(state, key.attemptId).attempt;
  if (current.state === "queued")
    return terminalizeAttempt(
      state,
      key,
      {
        kind: "cancelled",
        observedAt: now,
        artifacts: [],
        reason,
        deliveryRequestedAt: now,
      },
      now,
    );
  if (current.state === "finished") {
    if (current.outcome?.kind === "cancelled" && current.outcome.reason === reason) return state;
    throw new Error(`Attempt ${key.attemptId} is already finished.`);
  }
  const existing = current.execution?.cancellation;
  if (existing !== undefined) {
    if (existing.reason === reason) return state;
    throw new Error(`Attempt ${key.attemptId} has a conflicting cancellation request.`);
  }
  return checkpointCancellation(state, key, { state: "requested", requestedAt: now, reason }, now);
}

/** A mutable context shape so optional facts are added only when present. */
type WritableContext = {
  -readonly [Key in keyof ReconciliationContext]: ReconciliationContext[Key];
};

function applyReconciliationMutation(
  workstream: Workstream,
  key: AttemptKey,
  mutation: ReconciliationMutation,
  now: string,
): Workstream {
  switch (mutation.kind) {
    case "activate":
      return activateAttempt(workstream, key, now, {
        placement: mutation.placement,
        submission: "not_sent",
      });
    case "record_worker_execution":
      return recordWorkerExecution(workstream, key, mutation.execution, now);
    case "record_effective_model":
      return recordEffectiveModel(workstream, key, mutation.observation, now);
    case "checkpoint_cancellation":
      return checkpointCancellation(workstream, key, mutation.checkpoint, now);
    case "checkpoint_cleanup":
      return checkpointCleanup(workstream, key, mutation.checkpoint, now);
    case "terminalize":
      return terminalizeAttempt(workstream, key, mutation.observation, now);
    case "record_delivery_failure":
      return recordDeliveryFailure(workstream, key, { at: now, detail: mutation.detail }, now);
    case "record_delivery_success":
      return recordDeliverySuccess(workstream, key, now, now);
  }
}

function controlError(detail: string, cause?: unknown): ReconciliationControlError {
  return new ReconciliationControlError(cause === undefined ? { detail } : { detail, cause });
}

function sameCoordinator(left: CoordinatorIdentity, right: CoordinatorIdentity): boolean {
  return left.sessionId === right.sessionId && left.sessionFile === right.sessionFile;
}

function stoppedError(): WorkstreamRuntimeStoppedError {
  return new WorkstreamRuntimeStoppedError({ message: STOPPED_MESSAGE });
}

function staleError(operation: string): WorkstreamRuntimeStaleError {
  return new WorkstreamRuntimeStaleError({
    operation,
    message: `${operation} planned from revision that no longer matches authoritative records; inspect or reconcile before retrying.`,
  });
}

function closeFailure(cause: Cause.Cause<unknown>): WorkstreamRuntimeOperationError {
  return new WorkstreamRuntimeOperationError({
    operation: "close workstream runtime",
    message: "Failed to close the workstream runtime.",
    cause: Cause.squash(cause),
  });
}

/** Preserve both a fatal runtime episode and a close failure. */
function combineFatalClose(
  fatal: WorkstreamRuntimeError,
  closeError: WorkstreamRuntimeOperationError,
): WorkstreamRuntimeError {
  return new WorkstreamRuntimeOperationError({
    operation: "close workstream runtime after fatal failure",
    message: "Workstream runtime failure and close failure.",
    cause: new AggregateError([fatal, closeError]),
  });
}

function isoFromMillis(millis: number): string {
  return DateTime.toDate(DateTime.makeUnsafe(millis)).toISOString();
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message.slice(0, 300) : "unspecified failure";
}
