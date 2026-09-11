/** Lease-scoped canonical command and reconciliation owner. */
import { randomUUID } from "node:crypto";
import {
  Cause,
  Clock,
  Data,
  DateTime,
  Deferred,
  type Duration,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  type FileSystem,
  Option,
  type Path,
  Ref,
  Scope,
  Semaphore,
} from "effect";
import type { PlatformError } from "effect/PlatformError";
import { Value } from "typebox/value";
import {
  appendFacts,
  CancelCommandSchema,
  CanonicalCommandError,
  type CanonicalCommandPorts,
  type CompleteCommand,
  CompleteCommandSchema,
  decodeCommand,
  enqueueFacts,
  exactAttempt,
  ResumeCommandSchema,
  ReviseIntentCommandSchema,
  SteerCommandSchema,
  type SuspendCommand,
  SuspendCommandSchema,
  workerIdentity,
} from "./canonical-commands.js";
import type { FrontierEntry } from "./canonical-frontier.js";
import { applyMaintainedOutput, releaseMaintainedOutput } from "./canonical-output.js";
import { decodeAppend, decodeEnqueue, planAppend, planEnqueue } from "./canonical-queue.js";
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
} from "./canonical-reconciliation.js";
import {
  CANONICAL_RUNTIME_GENERATION_PROTOCOL,
  closeRuntimeGeneration,
  compatibleRuntimeGeneration,
  publishRuntimeGeneration,
  type RuntimeGenerationEntry,
  type RuntimeGenerationHandle,
  type RuntimeGenerationQuiescence,
  type RuntimeGenerationRegistryError,
  recordRuntimeGenerationQuiescence,
  reserveRuntimeGenerationPath,
  runtimeGeneration,
  unregisterRuntimeGeneration,
} from "./canonical-runtime-generation.js";
import {
  type CanonicalCoordinatorAdoption,
  type CanonicalLease,
  type CanonicalStoreError,
  CanonicalWorkstreamStore,
} from "./canonical-workstream-store.js";
import {
  type AttemptKey,
  activateAttempt,
  appendAttempts,
  type CoordinatorIdentity,
  checkpointCancellation,
  checkpointCleanup,
  completeWorkstream,
  createTask,
  findAttempt,
  findOutcome,
  findTask,
  type HerdrDeadObservation,
  type Intent,
  type Outcome,
  type RepositoryIdentity,
  recordDeliveryFailure,
  recordDeliverySuccess,
  recordEffectiveModel,
  recordWorkerExecution,
  resumeWorkstream,
  reviseIntent,
  suspendWorkstream,
  type Task,
  terminalizeAttempt,
  type Workstream,
} from "./domain/workstream.js";
import { loadModelPolicyEffect, type ModelPolicy, type ModelPolicyError } from "./model-policy.js";

export class CanonicalRuntimeIdentityError extends Data.TaggedError(
  "CanonicalRuntimeIdentityError",
)<{
  readonly message: string;
}> {}

export class CanonicalRuntimeLeaseError extends Data.TaggedError("CanonicalRuntimeLeaseError")<{
  readonly code:
    | "lease_already_held"
    | "generation_proof_missing"
    | "generation_proof_mismatch"
    | "generation_not_quiescent"
    | "lease_changed_after_close";
  readonly message: string;
}> {}

export class CanonicalRuntimeStoppedError extends Data.TaggedError("CanonicalRuntimeStoppedError")<{
  readonly message: string;
}> {}

export class CanonicalRuntimeOperationError extends Data.TaggedError(
  "CanonicalRuntimeOperationError",
)<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class CanonicalRuntimeStaleError extends Data.TaggedError("CanonicalRuntimeStaleError")<{
  readonly operation: string;
  readonly message: string;
}> {}

export type CanonicalRuntimeError =
  | CanonicalStoreError
  | ModelPolicyError
  | PlatformError
  | CanonicalRuntimeIdentityError
  | CanonicalRuntimeLeaseError
  | CanonicalRuntimeStoppedError
  | CanonicalRuntimeStaleError
  | CanonicalRuntimeOperationError
  | RuntimeGenerationRegistryError
  | CanonicalCommandError;

export type CanonicalRuntimeEffect<A> = Effect.Effect<
  A,
  CanonicalRuntimeError,
  FileSystem.FileSystem
>;

export interface CanonicalRuntimeInspectionSnapshot {
  readonly workstream: Workstream;
  readonly reconciliation: readonly ReconciliationFrontierObservation[];
}

export type CanonicalRuntimeOwnership =
  | { readonly kind: "attach" }
  | { readonly kind: "recover" }
  | { readonly kind: "adopt"; readonly deathObservation: HerdrDeadObservation };

export interface CanonicalRuntimeAcquisition {
  readonly id: string;
  readonly repository: RepositoryIdentity;
  readonly coordinator: CoordinatorIdentity;
  readonly ownership: CanonicalRuntimeOwnership;
  readonly policyPath?: string;
  readonly driver: ReconciliationDriver;
  readonly commands?: CanonicalCommandPorts;
  readonly onReconciliationAttention?: ReconciliationAttention;
  readonly heartbeatInterval?: Duration.Input;
  readonly onFatal?: (error: CanonicalRuntimeError) => Effect.Effect<void, never>;
}

const DEFAULT_HEARTBEAT_INTERVAL: Duration.Input = "5 seconds";
const STOPPED_MESSAGE = "Canonical runtime is closed and accepts no further commands.";

/** Ready scoped owner for serialized canonical coordinator commands. */
export class CanonicalRuntime {
  private closed = false;
  private generationEntry?: RuntimeGenerationEntry;

  private constructor(
    private readonly resourceScope: Scope.Scope,
    private readonly store: CanonicalWorkstreamStore,
    private readonly lease: CanonicalLease,
    private readonly semaphore: Semaphore.Semaphore,
    private readonly fibers: FiberSet.FiberSet<unknown, never>,
    private readonly scheduler: ReconciliationScheduler,
    private readonly committed: Ref.Ref<Workstream>,
    private readonly closeRequest: Deferred.Deferred<CanonicalRuntimeError | undefined>,
    private readonly shutdownClaimed: Ref.Ref<boolean>,
    private readonly completion: Deferred.Deferred<void, CanonicalRuntimeError>,
    private readonly generationQuiescence: Deferred.Deferred<RuntimeGenerationQuiescence>,
    private readonly releaseFailure: Ref.Ref<CanonicalStoreError | undefined>,
    private readonly acquisition: CanonicalRuntimeAcquisition,
  ) {}

  /**
   * Eagerly acquire a caller-Scope-owned canonical runtime. Escaping an
   * `Effect.scoped` acquisition returns an already-closed handle.
   */
  static acquire(
    acquisition: CanonicalRuntimeAcquisition,
  ): Effect.Effect<
    CanonicalRuntime,
    CanonicalRuntimeError,
    FileSystem.FileSystem | Path.Path | Scope.Scope
  > {
    return Effect.acquireRelease(
      CanonicalRuntime.initialize(acquisition),
      (runtime) => runtime.ownerFinalizer(),
      { interruptible: true },
    );
  }

  private static initialize(
    acquisition: CanonicalRuntimeAcquisition,
  ): Effect.Effect<
    CanonicalRuntime,
    CanonicalRuntimeError,
    FileSystem.FileSystem | Path.Path | Scope.Scope
  > {
    return Effect.gen(function* () {
      const ownerScope = yield* Scope.Scope;
      // The child resource Scope is registered with the caller Scope first, so a
      // failed, interrupted, or escaped acquisition always dismantles it even
      // before its own explicit close path runs.
      const resourceScope = yield* Effect.acquireRelease(Scope.make("sequential"), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const path = yield* CanonicalWorkstreamStore.pathFor(acquisition.repository, acquisition.id);
      const runtime = yield* Effect.scoped(
        reserveRuntimeGenerationPath(path).pipe(
          Effect.andThen(
            CanonicalRuntime.build(resourceScope, acquisition, path).pipe(
              Scope.provide(resourceScope),
              Effect.onError((cause) => Scope.close(resourceScope, Exit.failCause(cause))),
            ),
          ),
        ),
      );
      // This controller is owned by the caller Scope, never the global Scope and
      // never the child Scope whose FiberSet it may need to close.
      yield* Effect.forkIn(runtime.runCloseSupervisor(), ownerScope);
      return runtime;
    });
  }

  private static build(
    resourceScope: Scope.Scope,
    acquisition: CanonicalRuntimeAcquisition,
    path: string,
  ): Effect.Effect<
    CanonicalRuntime,
    CanonicalRuntimeError,
    FileSystem.FileSystem | Path.Path | Scope.Scope
  > {
    return Effect.gen(function* () {
      const attachment = yield* CanonicalWorkstreamStore.open(
        acquisition.id,
        acquisition.repository,
      );
      const { store } = attachment;
      const releaseFailure = yield* Ref.make<CanonicalStoreError | undefined>(undefined);
      const owned = yield* Effect.acquireRelease(
        prepareOwnership(store, attachment.state, acquisition, path),
        ({ lease }) =>
          store.releaseLease(lease).pipe(
            Effect.catch((error) =>
              store.observeLease().pipe(
                Effect.flatMap((row) =>
                  row === undefined ? Effect.void : Ref.set(releaseFailure, error),
                ),
                Effect.catch(() => Ref.set(releaseFailure, error)),
              ),
            ),
          ),
      );
      const { state, lease } = owned;
      const semaphore = yield* Semaphore.make(1);
      const fibers = yield* FiberSet.make<unknown, never>();
      const scheduler = yield* ReconciliationScheduler.make(
        acquisition.driver,
        acquisition.onReconciliationAttention ?? (() => Effect.void),
      );
      // One defensive snapshot of the committed aggregate, seeded from the
      // attachment read and replaced only by successful transitions.
      const committed = yield* Ref.make(structuredClone(state));
      const closeRequest = yield* Deferred.make<CanonicalRuntimeError | undefined>();
      const shutdownClaimed = yield* Ref.make(false);
      const completion = yield* Deferred.make<void, CanonicalRuntimeError>();
      const generationQuiescence = yield* Deferred.make<RuntimeGenerationQuiescence>();
      const runtime = new CanonicalRuntime(
        resourceScope,
        store,
        lease,
        semaphore,
        fibers,
        scheduler,
        committed,
        closeRequest,
        shutdownClaimed,
        completion,
        generationQuiescence,
        releaseFailure,
        acquisition,
      );
      const handle: RuntimeGenerationHandle = {
        // oxlint-disable-next-line effecttsgo/run-effect-inside-effect -- The versioned globalThis protocol invokes this host Promise after acquisition has returned.
        close: () => Effect.runPromise(runtime.closeForGeneration()),
      };
      const entry: RuntimeGenerationEntry = {
        protocolVersion: CANONICAL_RUNTIME_GENERATION_PROTOCOL,
        path,
        workstreamId: acquisition.id,
        coordinator: structuredClone(acquisition.coordinator),
        lease: structuredClone(lease),
        handle,
        status: "active",
      };
      runtime.generationEntry = entry;
      publishRuntimeGeneration(entry);
      yield* Effect.gen(function* () {
        yield* scheduler.provideControls((key) => runtime.controlFor(key));
        yield* scheduler.attach(state);
        yield* FiberSet.run(fibers, runtime.heartbeatLoop());
        yield* FiberSet.run(fibers, scheduler.run());
      }).pipe(Effect.onError(() => runtime.recordPublishedQuiescence(entry)));
      return runtime;
    });
  }

  /** Fenced read through the serialized boundary; also re-proves ownership. */
  readonly read = (): CanonicalRuntimeEffect<Workstream> =>
    this.serialized(this.fencedRead().pipe(Effect.map((state) => structuredClone(state))));

  /** Lease-local projection; SQLite remains authoritative. */
  readonly snapshot = (): Effect.Effect<Workstream> =>
    Ref.get(this.committed).pipe(Effect.map((state) => structuredClone(state)));

  /** Prove the held lease from the lease row alone, never full task history. */
  readonly checkOwnership = (): CanonicalRuntimeEffect<void> =>
    this.serialized(this.store.checkLease(this.lease));

  /** Enqueue one immutable Task with its resolved initial Attempt(s). */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Queue commands are external boundary values validated by the canonical TypeBox schema.
  readonly enqueue = (command: unknown): CanonicalRuntimeEffect<Workstream> =>
    this.serialized(this.enqueueEffect(command));

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Queue commands are external boundary values validated by the canonical TypeBox schema.
  readonly appendAttempts = (command: unknown): CanonicalRuntimeEffect<Workstream> =>
    this.serialized(this.appendEffect(command));

  readonly readAttempt = (
    attemptId: string,
  ): CanonicalRuntimeEffect<ReturnType<typeof exactAttempt>> =>
    this.serialized(
      Effect.gen(
        function* (this: CanonicalRuntime) {
          const state = yield* this.fencedRead();
          const located = yield* this.try("resolve Attempt", () => exactAttempt(state, attemptId));
          return structuredClone(located);
        }.bind(this),
      ),
    );

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Canonical TypeBox schema decodes this external command value.
  readonly suspend = (command: unknown): CanonicalRuntimeEffect<Workstream> =>
    this.scheduler.withDispatchBarrier(
      Effect.uninterruptible(
        this.serialized(
          Effect.gen(
            function* (this: CanonicalRuntime) {
              const input = yield* this.try("decode suspension", () =>
                decodeCommand<SuspendCommand>(SuspendCommandSchema, command, "suspension command"),
              );
              const now = yield* this.now();
              const committed = yield* this.authoritative("suspend canonical Workstream", (state) =>
                suspendWorkstream(state, { reason: input.reason, suspendedAt: now }, now),
              );
              yield* this.scheduler.attach(committed);
              return committed;
            }.bind(this),
          ),
        ),
      ),
    );

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Canonical TypeBox schema decodes this external command value.
  readonly resume = (command: unknown): CanonicalRuntimeEffect<Workstream> =>
    this.scheduler.withDispatchBarrier(
      Effect.uninterruptible(
        this.serialized(
          Effect.gen(
            function* (this: CanonicalRuntime) {
              yield* this.try("decode resumption", () =>
                decodeCommand(ResumeCommandSchema, command, "resumption command"),
              );
              const now = yield* this.now();
              const committed = yield* this.authoritative("resume canonical Workstream", (state) =>
                resumeWorkstream(state, now),
              );
              yield* this.scheduler.attach(committed);
              return committed;
            }.bind(this),
          ),
        ),
      ),
    );

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Canonical TypeBox schema decodes this external command value.
  readonly reviseIntent = (command: unknown): CanonicalRuntimeEffect<Workstream> =>
    this.serialized(
      Effect.gen(
        function* (this: CanonicalRuntime) {
          const intent = yield* this.try("decode Intent revision", () =>
            decodeCommand<Intent>(ReviseIntentCommandSchema, command, "Intent revision"),
          );
          const before = yield* Ref.get(this.committed);
          const affected = before.tasks.flatMap((task) =>
            task.attempts.map((attempt) => ({ taskId: task.id, attemptId: attempt.id })),
          );
          const now = yield* this.now();
          const committed = yield* this.authoritative("revise canonical Intent", (state) =>
            reviseIntent(state, intent, now),
          );
          yield* this.notifyCommitted(committed, affected);
          return committed;
        }.bind(this),
      ),
    );

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Canonical TypeBox schema decodes this external command value.
  readonly complete = (command: unknown): CanonicalRuntimeEffect<Workstream> =>
    this.serialized(
      Effect.gen(
        function* (this: CanonicalRuntime) {
          const input = yield* this.try("decode completion", () =>
            decodeCommand<CompleteCommand>(CompleteCommandSchema, command, "completion command"),
          );
          const now = yield* this.now();
          return yield* this.authoritative("complete canonical Workstream", (state) =>
            completeWorkstream(state, { ...input, completedAt: now }, now),
          );
        }.bind(this),
      ),
    );

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Canonical TypeBox schema decodes this external command value.
  readonly cancel = (command: unknown): CanonicalRuntimeEffect<Workstream> =>
    this.serialized(
      Effect.gen(
        function* (this: CanonicalRuntime) {
          const input = yield* this.try("decode cancellation", () =>
            decodeCommand<{ attemptId: string; reason: string }>(
              CancelCommandSchema,
              command,
              "cancellation command",
            ),
          );
          const before = yield* Ref.get(this.committed);
          const located = yield* this.try("resolve cancellation Attempt", () =>
            exactAttempt(before, input.attemptId),
          );
          const now = yield* this.now();
          const committed = yield* this.authoritative("request canonical cancellation", (state) =>
            planCancellation(state, located.key, input.reason, now),
          );
          if (!Value.Equal(before, committed))
            yield* this.notifyCommitted(committed, [located.key]);
          return committed;
        }.bind(this),
      ),
    );

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Canonical TypeBox schema decodes this external command value.
  readonly steer = (command: unknown): CanonicalRuntimeEffect<Workstream> =>
    this.serialized(this.steerEffect(command));

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Canonical TypeBox schema decodes this external command value.
  readonly apply = (command: unknown): CanonicalRuntimeEffect<Workstream> =>
    this.serialized(
      Effect.flatMap(this.commandPorts(), (ports) =>
        applyMaintainedOutput(this.outputControl(ports), command),
      ),
    );

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Canonical TypeBox schema decodes this external command value.
  readonly releaseOutput = (command: unknown): CanonicalRuntimeEffect<Workstream> =>
    this.serialized(
      Effect.flatMap(this.commandPorts(), (ports) =>
        releaseMaintainedOutput(this.outputControl(ports), command),
      ),
    );

  /**
   * Defensive frontier projection for inspection. It reads only the
   * lease-lifetime frontier, never the SQLite aggregate.
   */
  readonly frontierSnapshot = (): Effect.Effect<readonly FrontierEntry[]> =>
    this.scheduler.snapshot();

  readonly inspectionSnapshot = (): CanonicalRuntimeEffect<CanonicalRuntimeInspectionSnapshot> =>
    this.serialized(
      Effect.gen(
        function* (this: CanonicalRuntime) {
          yield* this.store.checkLease(this.lease);
          return {
            workstream: structuredClone(yield* Ref.get(this.committed)),
            reconciliation: yield* this.scheduler.inspectionSnapshot(),
          };
        }.bind(this),
      ),
    );

  /** Rebuild transient reconciliation state from one fenced aggregate read. */
  readonly reconcile = (): CanonicalRuntimeEffect<readonly FrontierEntry[]> =>
    this.serialized(
      Effect.gen(
        function* (this: CanonicalRuntime) {
          const state = yield* this.fencedRead();
          yield* this.scheduler.attach(state);
          return yield* this.scheduler.snapshot();
        }.bind(this),
      ),
    );

  /** Restrict one driver dispatch to its exact Attempt. */
  private controlFor(key: AttemptKey): ReconciliationControl {
    return {
      context: () => this.controlContext(key),
      checkOwnership: this.serialized(this.store.checkLease(this.lease)).pipe(
        Effect.mapError((error) => controlError(errorMessage(error), error)),
      ),
      commit: (mutation) => this.controlCommit(key, mutation),
    };
  }

  /** Defensive exact-key context read from the committed projection. */
  private controlContext(key: AttemptKey): ReconciliationContext {
    const state = Ref.getUnsafe(this.committed);
    const task = findTask(state, key.taskId);
    if (task === undefined) throw controlError(`Unknown Task ${key.taskId}.`);
    const attempt = findAttempt(task, key.attemptId);
    if (attempt === undefined) throw controlError(`Unknown Attempt ${key.attemptId}.`);
    const intent = state.intents[task.intentIndex];
    if (intent === undefined)
      throw controlError(`Attempt ${key.attemptId} references an unknown Intent index.`);
    const { attempts: _attempts, ...contract } = task;
    const context: WritableContext = {
      workstreamId: state.id,
      repository: state.repository,
      intent: { index: task.intentIndex, value: intent },
      task: contract,
      attempt,
    };
    if (task.kind === "review") context.reviewInput = resolveReviewInput(state, task.subject);
    const continuationSessionFile =
      attempt.continuationOf === undefined
        ? undefined
        : findAttempt(task, attempt.continuationOf)?.execution?.sessionFile;
    if (continuationSessionFile !== undefined)
      context.continuationSessionFile = continuationSessionFile;
    return structuredClone(context);
  }

  /** Commit one driver mutation; durable no-ops do not wake reconciliation. */
  private controlCommit(
    key: AttemptKey,
    mutation: ReconciliationMutation,
  ): Effect.Effect<ReconciliationCommit, ReconciliationControlError, FileSystem.FileSystem> {
    const effect = Effect.gen(
      function* (this: CanonicalRuntime) {
        const before = yield* Ref.get(this.committed);
        const now = yield* this.now();
        const committed = yield* this.authoritative(
          "apply canonical reconciliation mutation",
          (expected) => applyReconciliationMutation(expected, key, mutation, now),
        );
        if (Value.Equal(committed, before)) return { kind: "no_change" } as const;
        yield* this.notifyCommitted(committed, [key]);
        return {
          kind: "committed",
          receipt: { key, revision: committed.revision, context: this.controlContext(key) },
        } as const;
      }.bind(this),
    );
    return this.serialized(effect).pipe(
      Effect.mapError((error) => controlError(errorMessage(error), error)),
    );
  }

  /** The single idempotent close boundary for explicit shutdown. */
  readonly close = (): Effect.Effect<void, CanonicalRuntimeError> => this.closeEffect();

  readonly awaitClosed = (): Effect.Effect<void, CanonicalRuntimeError> =>
    Deferred.await(this.completion);

  private fencedRead(): Effect.Effect<Workstream, CanonicalStoreError, FileSystem.FileSystem> {
    return Effect.gen(
      function* (this: CanonicalRuntime) {
        // An unchanged fenced transition re-proves the held lease and returns the
        // committed aggregate without writing.
        const current = yield* this.store.transition(this.lease, (state) => state);
        yield* Ref.set(this.committed, current);
        return current;
      }.bind(this),
    );
  }

  private enqueueEffect(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Queue commands are external boundary values validated by the canonical TypeBox schema.
    command: unknown,
  ): Effect.Effect<Workstream, CanonicalRuntimeError, FileSystem.FileSystem> {
    return Effect.gen(
      function* (this: CanonicalRuntime) {
        const decoded = yield* this.try("decode canonical Task enqueue", () =>
          decodeEnqueue(command),
        );
        const policy = yield* this.policy();
        const plan = yield* this.try("plan canonical Task enqueue", () =>
          planEnqueue(decoded, policy),
        );
        const expected = yield* Ref.get(this.committed);
        if (findTask(expected, plan.taskId) !== undefined)
          return yield* new CanonicalRuntimeOperationError({
            operation: "enqueue canonical Task",
            message: `Task ${plan.taskId} already exists.`,
          });
        const facts = yield* enqueueFacts(expected, decoded, this.acquisition.commands?.git);
        const now = yield* this.now();
        const attemptIds = Array.from(
          { length: plan.attemptCount },
          () => `attempt-${randomUUID()}`,
        );
        const committed = yield* this.authoritative("enqueue canonical Task", (expected) =>
          createTask(
            expected,
            plan.materialize(attemptIds, now, expected.intents.length - 1, facts),
            now,
          ),
        );
        yield* this.notifyCommitted(
          committed,
          attemptIds.map((attemptId) => ({ taskId: plan.taskId, attemptId })),
        );
        return committed;
      }.bind(this),
    );
  }

  private appendEffect(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Queue commands are external boundary values validated by the canonical TypeBox schema.
    command: unknown,
  ): Effect.Effect<Workstream, CanonicalRuntimeError, FileSystem.FileSystem> {
    return Effect.gen(
      function* (this: CanonicalRuntime) {
        const decoded = yield* this.try("decode canonical append command", () =>
          decodeAppend(command),
        );
        const policy = yield* this.policy();
        const expected = yield* Ref.get(this.committed);
        const resolved = yield* this.try("resolve canonical append plan", () => {
          const task = findTask(expected, decoded.taskId);
          if (task === undefined) throw new Error(`Unknown Task ${decoded.taskId}.`);
          return planAppend(decoded, task.kind, policy);
        });
        const facts = yield* appendFacts(expected, decoded, this.acquisition.commands?.git);
        const now = yield* this.now();
        const attemptIds = Array.from(
          { length: resolved.attemptCount },
          () => `attempt-${randomUUID()}`,
        );
        const committed = yield* this.authoritative("append canonical Attempts", (current) =>
          appendAttempts(
            current,
            decoded.taskId,
            resolved.materialize(attemptIds, now, facts),
            now,
          ),
        );
        yield* this.notifyCommitted(
          committed,
          attemptIds.map((attemptId) => ({ taskId: decoded.taskId, attemptId })),
        );
        return committed;
      }.bind(this),
    );
  }

  private outputControl(ports: CanonicalCommandPorts) {
    return {
      state: Ref.get(this.committed).pipe(Effect.map((state) => structuredClone(state))),
      commit: (operation: string, key: AttemptKey, plan: (state: Workstream) => Workstream) =>
        Effect.tap(this.authoritative(operation, plan), (committed) =>
          this.notifyCommitted(committed, [key]),
        ),
      fence: this.store.checkLease(this.lease),
      now: this.now(),
      ports,
    };
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Called only from the schema-owning public steering boundary.
  private steerEffect(command: unknown): CanonicalRuntimeEffect<Workstream> {
    return Effect.gen(
      function* (this: CanonicalRuntime) {
        const input = yield* this.try("decode steering command", () =>
          decodeCommand<{ attemptId: string; instruction: string }>(
            SteerCommandSchema,
            command,
            "steering command",
          ),
        );
        const ports = yield* this.commandPorts();
        const initial = yield* Ref.get(this.committed);
        const located = yield* this.try("resolve steering Attempt", () =>
          exactAttempt(initial, input.attemptId),
        );
        const currentSteering = located.attempt.execution?.steering;
        if (currentSteering?.state === "submitted" && currentSteering.text === input.instruction)
          return initial;
        if (currentSteering?.state === "uncertain")
          return yield* new CanonicalCommandError({
            operation: "steer Worker",
            message: `Attempt ${input.attemptId} has an uncertain steering delivery; inspect before any resend.`,
          });
        const identity = yield* this.try("resolve ready Worker", () =>
          workerIdentity(located.attempt),
        );
        const now = yield* this.now();
        yield* this.authoritative("checkpoint uncertain steering", (state) =>
          recordWorkerExecution(
            state,
            located.key,
            { steering: { text: input.instruction, state: "uncertain", observedAt: now } },
            now,
          ),
        );
        yield* this.store.checkLease(this.lease);
        yield* ports.workers.steer(identity, input.instruction);
        const submittedAt = yield* this.now();
        const committed = yield* this.authoritative("checkpoint submitted steering", (state) =>
          recordWorkerExecution(
            state,
            located.key,
            { steering: { text: input.instruction, state: "submitted", observedAt: submittedAt } },
            submittedAt,
          ),
        );
        yield* this.notifyCommitted(committed, [located.key]);
        return committed;
      }.bind(this),
    );
  }

  private commandPorts(): Effect.Effect<CanonicalCommandPorts, CanonicalRuntimeOperationError> {
    return this.acquisition.commands === undefined
      ? Effect.fail(
          new CanonicalRuntimeOperationError({
            operation: "canonical explicit command",
            message: "Canonical explicit command host ports are unavailable.",
          }),
        )
      : Effect.succeed(this.acquisition.commands);
  }

  /** Fence each planned transition against the exact lease-local projection. */
  private authoritative(
    operation: string,
    plan: (expected: Workstream) => Workstream,
  ): Effect.Effect<Workstream, CanonicalRuntimeError, FileSystem.FileSystem> {
    return Effect.gen(
      function* (this: CanonicalRuntime) {
        const expected = yield* Ref.get(this.committed);
        const planned = yield* this.try(operation, () => plan(expected));
        let failure: CanonicalRuntimeError | undefined;
        const committed = yield* this.store.transition(this.lease, (current) => {
          if (this.closed) {
            failure = stoppedError();
            return current;
          }
          if (!Value.Equal(current, expected)) {
            failure = staleError(operation);
            return current;
          }
          return planned;
        });
        if (failure !== undefined) return yield* failure;
        yield* Ref.set(this.committed, committed);
        return structuredClone(committed);
      }.bind(this),
    );
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
  ): Effect.Effect<A, CanonicalRuntimeOperationError> {
    return Effect.try({
      try: run,
      catch: (cause) =>
        new CanonicalRuntimeOperationError({
          operation,
          message: errorMessage(cause),
          cause,
        }),
    });
  }

  /** Serialize a command in the owned FiberSet so close interrupts and joins it. */
  private serialized<A>(effect: CanonicalRuntimeEffect<A>): CanonicalRuntimeEffect<A> {
    return Effect.suspend(
      function (this: CanonicalRuntime) {
        if (this.closed) return Effect.fail(stoppedError());
        const run = Effect.gen(
          function* (this: CanonicalRuntime) {
            const fiber = yield* FiberSet.run(
              this.fibers,
              Effect.exit(
                this.semaphore.withPermit(
                  Effect.suspend<A, CanonicalRuntimeError, FileSystem.FileSystem>(() =>
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

  private heartbeatLoop(): Effect.Effect<void, never, FileSystem.FileSystem> {
    const interval = this.acquisition.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL;
    return Effect.gen(
      function* (this: CanonicalRuntime) {
        while (!this.closed) {
          yield* Effect.sleep(interval);
          if (this.closed) return;
          // Renewal shares the mutation Semaphore, so it is serialized with every
          // coordinator command and uses ordinary fiber interruption.
          yield* this.renewLease().pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause) ? Effect.void : this.requestClose(fatalCause(cause)),
            ),
          );
        }
      }.bind(this),
    );
  }

  private renewLease(): CanonicalRuntimeEffect<void> {
    return Effect.gen(
      function* (this: CanonicalRuntime) {
        yield* Effect.suspend(() => (this.closed ? Effect.fail(stoppedError()) : Effect.void));
        yield* this.semaphore.withPermit(this.store.renewLease(this.lease).pipe(Effect.asVoid));
      }.bind(this),
    );
  }

  /** Parent-owned controller for fatal requests raised by child resource fibers. */
  private runCloseSupervisor(): Effect.Effect<void, never> {
    // The shared completion boundary already carries any close failure, so this
    // controller never fails its owning caller Scope.
    return Deferred.await(this.closeRequest).pipe(Effect.andThen(this.shutdown()), Effect.ignore);
  }

  private requestClose(fatal?: CanonicalRuntimeError): Effect.Effect<void> {
    return Effect.sync(() => {
      this.closed = true;
    }).pipe(Effect.andThen(Deferred.succeed(this.closeRequest, fatal)), Effect.asVoid);
  }

  /** One uninterruptible claim closes resources and settles shared completion. */
  private shutdown(): Effect.Effect<void, CanonicalRuntimeError> {
    const close: Effect.Effect<CanonicalRuntimeError | undefined> = Effect.uninterruptible(
      Effect.gen(
        function* (this: CanonicalRuntime) {
          const owned = yield* Ref.getAndSet(this.shutdownClaimed, true);
          if (owned) return undefined;
          const fatal = yield* Deferred.await(this.closeRequest);
          const exit = yield* Effect.exit(Scope.close(this.resourceScope, Exit.void));
          const resourceError = Exit.isFailure(exit) ? closeFailure(exit.cause) : undefined;
          yield* Deferred.succeed(
            this.generationQuiescence,
            resourceError === undefined
              ? { quiescent: true }
              : { quiescent: false, detail: resourceError.message },
          );
          const releaseError = yield* Ref.get(this.releaseFailure);
          const closeError =
            resourceError ??
            (releaseError === undefined ? undefined : releaseFailureError(releaseError));
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

  private report(error: CanonicalRuntimeError): Effect.Effect<void> {
    const report = this.acquisition.onFatal;
    return report === undefined ? Effect.void : report(error).pipe(Effect.ignoreCause);
  }

  private ownerFinalizer(): Effect.Effect<void> {
    return Effect.gen(
      function* (this: CanonicalRuntime) {
        const entry = this.generationEntry;
        if (entry === undefined) return;
        yield* this.recordPublishedQuiescence(entry);
        if ((yield* Ref.get(this.releaseFailure)) === undefined) unregisterRuntimeGeneration(entry);
      }.bind(this),
    ).pipe(Effect.ignore);
  }

  private recordPublishedQuiescence(entry: RuntimeGenerationEntry): Effect.Effect<void> {
    return Effect.gen(
      function* (this: CanonicalRuntime) {
        yield* this.requestClose();
        yield* Effect.exit(this.shutdown());
        const result = yield* Deferred.await(this.generationQuiescence);
        yield* Effect.sync(() => recordRuntimeGenerationQuiescence(entry, result));
      }.bind(this),
    );
  }

  private closeEffect(): Effect.Effect<void, CanonicalRuntimeError> {
    return this.requestClose().pipe(Effect.andThen(this.shutdown()));
  }

  private closeForGeneration(): Effect.Effect<RuntimeGenerationQuiescence> {
    return this.requestClose().pipe(
      Effect.andThen(this.shutdown().pipe(Effect.ignore)),
      Effect.andThen(Deferred.await(this.generationQuiescence)),
    );
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

function prepareOwnership(
  store: CanonicalWorkstreamStore,
  initial: Workstream,
  acquisition: CanonicalRuntimeAcquisition,
  path: string,
): Effect.Effect<
  { readonly state: Workstream; readonly lease: CanonicalLease },
  CanonicalRuntimeError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const observed = yield* store.observeLease();
    if (sameCoordinator(initial.coordinator, acquisition.coordinator))
      return yield* prepareCurrentCoordinator(store, initial, acquisition, path, observed);
    if (acquisition.ownership.kind !== "adopt")
      return yield* new CanonicalRuntimeIdentityError({
        message: `Workstream ${acquisition.id} is coordinated by ${initial.coordinator.sessionId}; different-session attachment requires explicit adoption.`,
      });
    return yield* adoptDifferentCoordinator(
      store,
      initial,
      acquisition,
      path,
      observed,
      acquisition.ownership.deathObservation,
    );
  });
}

function prepareCurrentCoordinator(
  store: CanonicalWorkstreamStore,
  initial: Workstream,
  acquisition: CanonicalRuntimeAcquisition,
  path: string,
  observed: CanonicalLease | undefined,
): Effect.Effect<
  { readonly state: Workstream; readonly lease: CanonicalLease },
  CanonicalRuntimeError,
  FileSystem.FileSystem
> {
  if (observed === undefined) {
    const retained = runtimeGeneration(path);
    if (retained !== undefined)
      return quiesceExactGeneration(retained, acquisition, path, undefined).pipe(
        Effect.andThen(store.acquireLease(acquisition.coordinator)),
        Effect.map((lease) => ({ state: initial, lease })),
      );
    return store
      .acquireLease(acquisition.coordinator)
      .pipe(Effect.map((lease) => ({ state: initial, lease })));
  }
  if (acquisition.ownership.kind === "attach")
    return leaseError(
      "lease_already_held",
      path,
      observed,
      "ordinary attachment found an existing same-session lease; explicit controlled recovery is required",
    );
  if (acquisition.ownership.kind === "adopt")
    return leaseError(
      "generation_proof_mismatch",
      path,
      observed,
      "Herdr-dead proof cannot authorize same-session generation recovery; explicit controlled recovery is required",
    );
  return recoverGeneration(store, acquisition, path, observed);
}

function adoptDifferentCoordinator(
  store: CanonicalWorkstreamStore,
  initial: Workstream,
  acquisition: CanonicalRuntimeAcquisition,
  path: string,
  observed: CanonicalLease | undefined,
  deathObservation: HerdrDeadObservation,
): Effect.Effect<
  { readonly state: Workstream; readonly lease: CanonicalLease },
  CanonicalRuntimeError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const local = runtimeGeneration(path);
    if (local !== undefined)
      yield* quiesceExactGeneration(
        local,
        { ...acquisition, coordinator: initial.coordinator },
        path,
        observed,
      );
    const locallyQuiesced = local !== undefined;
    const current = yield* store.read();
    if (!Value.Equal(current, initial))
      return yield* new CanonicalRuntimeIdentityError({
        message: `Canonical state changed before coordinator adoption at ${path}.`,
      });
    const currentLease = yield* store.observeLease();
    yield* validateAdoptionReobservation(path, observed, currentLease, locallyQuiesced);
    const adoption: CanonicalCoordinatorAdoption = {
      repository: acquisition.repository,
      workstreamId: acquisition.id,
      expectedRevision: initial.revision,
      priorCoordinator: initial.coordinator,
      coordinator: acquisition.coordinator,
      observedLease:
        currentLease === undefined ? { kind: "absent" } : { kind: "present", lease: currentLease },
      deathObservation,
    };
    return yield* store.adoptCoordinator(adoption);
  });
}

function validateAdoptionReobservation(
  path: string,
  before: CanonicalLease | undefined,
  after: CanonicalLease | undefined,
  locallyQuiesced: boolean,
): Effect.Effect<void, CanonicalRuntimeLeaseError> {
  if (before === undefined && after === undefined) return Effect.void;
  if (before !== undefined && after !== undefined && sameExactLease(before, after))
    return Effect.void;
  if (before !== undefined && after === undefined && locallyQuiesced) return Effect.void;
  return leaseError(
    "lease_changed_after_close",
    path,
    after,
    "the lease row changed after the adoption observation",
  );
}

function quiesceExactGeneration(
  entry: RuntimeGenerationEntry,
  acquisition: CanonicalRuntimeAcquisition,
  path: string,
  observed: CanonicalLease | undefined,
): Effect.Effect<void, CanonicalRuntimeLeaseError> {
  return Effect.gen(function* () {
    const compatible =
      observed === undefined
        ? compatibleRuntimeGeneration(entry, {
            path,
            workstreamId: acquisition.id,
            coordinator: acquisition.coordinator,
          })
        : compatibleRuntimeGeneration(entry, {
            path,
            workstreamId: acquisition.id,
            coordinator: acquisition.coordinator,
            lease: observed,
          });
    if (!compatible)
      return yield* leaseError(
        "generation_proof_mismatch",
        path,
        observed,
        "the retained generation does not match the exact path, Workstream, coordinator, or present lease",
      );
    if (entry.status === "failed")
      return yield* leaseError(
        "generation_not_quiescent",
        path,
        observed,
        "the retained generation has failed or uncertain quiescence",
      );
    const closeResult = entry.closeResult;
    const result =
      entry.status === "quiescent" && closeResult !== undefined
        ? yield* Effect.promise(() => closeResult)
        : yield* Effect.promise(() => closeRuntimeGeneration(entry));
    if (!result.quiescent)
      return yield* leaseError(
        "generation_not_quiescent",
        path,
        observed,
        result.detail ?? "the retained generation did not prove operation and resource quiescence",
      );
  });
}

function recoverGeneration(
  store: CanonicalWorkstreamStore,
  acquisition: CanonicalRuntimeAcquisition,
  path: string,
  observed: CanonicalLease,
): Effect.Effect<
  { readonly state: Workstream; readonly lease: CanonicalLease },
  CanonicalRuntimeError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const entry = runtimeGeneration(path);
    if (entry === undefined)
      return yield* leaseError(
        "generation_proof_missing",
        path,
        observed,
        "no compatible process-local generation exists; cross-process same-session recovery is unsupported",
      );
    yield* quiesceExactGeneration(entry, acquisition, path, observed);
    const after = yield* store.observeLease();
    if (after === undefined)
      return {
        state: yield* store.read(),
        lease: yield* store.acquireLease(acquisition.coordinator),
      };
    if (!sameExactLease(after, observed))
      return yield* leaseError(
        "lease_changed_after_close",
        path,
        after,
        "the lease row changed while the prior runtime closed",
      );
    return {
      state: yield* store.read(),
      lease: yield* store.acquireLease(acquisition.coordinator, after),
    };
  });
}

function leaseError(
  code: CanonicalRuntimeLeaseError["code"],
  path: string,
  observed: CanonicalLease | undefined,
  proof: string,
): Effect.Effect<never, CanonicalRuntimeLeaseError> {
  const row =
    observed === undefined
      ? "observed lease absence"
      : `observed owner ${observed.owner.sessionId}, token ${observed.token}, expiry ${observed.expiresAt}`;
  return Effect.fail(
    new CanonicalRuntimeLeaseError({ code, message: `${path}: ${row}; ${proof}.` }),
  );
}

function sameExactLease(left: CanonicalLease, right: CanonicalLease): boolean {
  return Value.Equal(left, right);
}

/** A mutable context shape so optional facts are added only when present. */
type WritableContext = {
  -readonly [Key in keyof ReconciliationContext]: ReconciliationContext[Key];
};

/** Resolve only the canonical content named by a validated review subject. */
function resolveReviewInput(
  workstream: Workstream,
  subject: Extract<Task, { kind: "review" }>["subject"],
): ResolvedReviewInput {
  switch (subject.kind) {
    case "revision":
      return { kind: "revision", revision: subject.revision };
    case "outcome":
      return { kind: "outcome", outcome: requireOutcome(workstream, subject.outcomeId) };
    case "comparison":
      return {
        kind: "comparison",
        outcomes: subject.outcomeIds.map((outcomeId) => requireOutcome(workstream, outcomeId)),
      };
    case "artifact": {
      const outcome = requireOutcome(workstream, subject.outcomeId);
      const artifact = outcome.artifacts.find(
        (item) => item.id === subject.artifactId && item.retention === "retained",
      );
      if (artifact === undefined)
        throw controlError(
          `Review subject references an artifact that is not retained: ${subject.artifactId}.`,
        );
      return { kind: "artifact", outcome, artifact };
    }
  }
}

function requireOutcome(workstream: Workstream, outcomeId: string): Outcome {
  const outcome = findOutcome(workstream, outcomeId);
  if (outcome === undefined)
    throw controlError(`Review subject references unknown Outcome ${outcomeId}.`);
  return outcome;
}

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

function stoppedError(): CanonicalRuntimeStoppedError {
  return new CanonicalRuntimeStoppedError({ message: STOPPED_MESSAGE });
}

function staleError(operation: string): CanonicalRuntimeStaleError {
  return new CanonicalRuntimeStaleError({
    operation,
    message: `${operation} planned from a projection that no longer matches the authoritative aggregate; run an authoritative read or manual reconcile before retrying.`,
  });
}

function releaseFailureError(cause: CanonicalStoreError): CanonicalRuntimeOperationError {
  return new CanonicalRuntimeOperationError({
    operation: "release canonical runtime lease",
    message: "Runtime resources are quiescent but exact lease release failed.",
    cause,
  });
}

function closeFailure(cause: Cause.Cause<unknown>): CanonicalRuntimeOperationError {
  return new CanonicalRuntimeOperationError({
    operation: "close canonical runtime",
    message: "Failed to close the canonical runtime.",
    cause: Cause.squash(cause),
  });
}

/** Combine a fatal lease episode with a close failure into one typed report. */
function combineFatalClose(
  fatal: CanonicalRuntimeError,
  closeError: CanonicalRuntimeOperationError,
): CanonicalRuntimeError {
  return new CanonicalRuntimeOperationError({
    operation: "close canonical runtime after fatal lease loss",
    message: "Canonical runtime lease loss and close failure.",
    cause: new AggregateError([fatal, closeError]),
  });
}

function fatalCause(cause: Cause.Cause<CanonicalRuntimeError>): CanonicalRuntimeError {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure)) return failure.value;
  const defect = Cause.squash(cause);
  return new CanonicalRuntimeOperationError({
    operation: "renew canonical Workstream lease",
    message: errorMessage(defect),
    cause: defect,
  });
}

function isoFromMillis(millis: number): string {
  return DateTime.toDate(DateTime.makeUnsafe(millis)).toISOString();
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message.slice(0, 300) : "unspecified failure";
}
