/**
 * Canonical runtime core. It eagerly opens the exact canonical store, takes
 * the validated aggregate read from that one attachment, verifies the supplied
 * coordinator identity, fences one lease, and returns only once a Semaphore, a
 * scoped FiberSet, and the background heartbeat are ready. The store result is
 * the lease-scoped committed snapshot: commands materialize their complete next
 * aggregate from it under the shared Semaphore and then perform exactly one
 * authoritative transition whose callback compares the transaction's current
 * state with that expected projection.
 *
 * The caller's `Scope.Scope` owns the whole lifetime. A distinct child resource
 * Scope holds the database, lease, FiberSet, and heartbeat; a controller fiber
 * forked into the caller Scope waits for a fatal request and closes that child.
 * One uninterruptible, idempotent shutdown claim is shared by explicit close,
 * fatal close, and caller-scope finalization, so a heartbeat or command fiber
 * never closes and awaits its own Scope/FiberSet.
 */
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
import type { FrontierEntry } from "./canonical-frontier.js";
import { decodeAppend, planAppend, planEnqueue } from "./canonical-queue.js";
import {
  type ReconciliationAttention,
  type ReconciliationCommit,
  type ReconciliationContext,
  type ReconciliationControl,
  ReconciliationControlError,
  type ReconciliationDriver,
  type ReconciliationMutation,
  ReconciliationScheduler,
  type ResolvedReviewInput,
} from "./canonical-reconciliation.js";
import {
  type CanonicalLease,
  CanonicalStoreConflictError,
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
  createTask,
  findAttempt,
  findOutcome,
  findTask,
  type Outcome,
  type RepositoryIdentity,
  recordDeliveryFailure,
  recordDeliverySuccess,
  recordEffectiveModel,
  recordWorkerExecution,
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
  readonly code: "lease_takeover_requires_dead_owner";
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
  | CanonicalRuntimeOperationError;

export type CanonicalRuntimeEffect<A> = Effect.Effect<
  A,
  CanonicalRuntimeError,
  FileSystem.FileSystem
>;

export interface CanonicalRuntimeAcquisition {
  readonly id: string;
  readonly repository: RepositoryIdentity;
  readonly coordinator: CoordinatorIdentity;
  /** Caller-supplied proof about the previous owner; only `dead` permits a takeover. */
  readonly priorOwnerLiveness?: "alive" | "dead" | "unknown";
  readonly policyPath?: string;
  /**
   * Required reconciliation driver. Acquisition never installs a silent
   * inert default; tests pass one explicit inert or controlled driver.
   */
  readonly driver: ReconciliationDriver;
  /** One callback for contained driver failures and blocked outcomes. */
  readonly onReconciliationAttention?: ReconciliationAttention;
  /** Test/runtime isolation seam; production uses the settled five-second heartbeat. */
  readonly heartbeatInterval?: Duration.Input;
  /** One bounded fatal channel: the typed cause of an involuntary runtime close. */
  readonly onFatal?: (error: CanonicalRuntimeError) => Effect.Effect<void, never>;
}

const DEFAULT_HEARTBEAT_INTERVAL: Duration.Input = "5 seconds";
const STOPPED_MESSAGE = "Canonical runtime is closed and accepts no further commands.";

/** Ready scoped owner for serialized canonical coordinator commands. */
export class CanonicalRuntime {
  private closed = false;

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
    return Effect.acquireRelease(CanonicalRuntime.initialize(acquisition), (runtime) =>
      runtime.ownerFinalizer(),
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
      const runtime = yield* CanonicalRuntime.build(resourceScope, acquisition).pipe(
        Scope.provide(resourceScope),
        Effect.onError((cause) => Scope.close(resourceScope, Exit.failCause(cause))),
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
      const { store, state } = attachment;
      if (!sameCoordinator(state.coordinator, acquisition.coordinator))
        return yield* new CanonicalRuntimeIdentityError({
          message: `Workstream ${acquisition.id} is coordinated by another session; adoption is a separate authority boundary.`,
        });
      const observed = yield* store.observeLease();
      const lease = yield* Effect.acquireRelease(
        acquireLease(store, acquisition, observed),
        (held) =>
          // Release the exact current lease only while it is still held. A conflict
          // means it is no longer ours, so nothing is released twice. Caller-Scope
          // owner finalization intentionally contains a duplicate close failure;
          // close()/awaitClosed() retain the typed completion failure.
          store.releaseLease(held).pipe(
            Effect.catchIf(
              (error) => error instanceof CanonicalStoreConflictError,
              () => Effect.void,
            ),
            Effect.orDie,
          ),
      );
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
        acquisition,
      );
      // The exact-key control must be usable before the first attachment wake can
      // dispatch, so it is installed while the scheduler is still asleep.
      yield* scheduler.provideControls((key) => runtime.controlFor(key));
      // The attachment read is the one full classification; the scheduler then
      // sleeps until a committed notification or manual reconcile wakes it.
      yield* scheduler.attach(state);
      yield* FiberSet.run(fibers, runtime.heartbeatLoop());
      yield* FiberSet.run(fibers, scheduler.run());
      return runtime;
    });
  }

  /** Fenced read through the serialized boundary; also re-proves ownership. */
  readonly read = (): CanonicalRuntimeEffect<Workstream> =>
    this.serialized(this.fencedRead().pipe(Effect.map((state) => structuredClone(state))));

  /**
   * The one defensive snapshot of the committed aggregate. It is a derived
   * write-through projection (planning and frontier input) maintained by
   * authoritative reads and committed transitions, never authority: SQLite
   * remains authoritative, commands plan from it under the Semaphore, and the
   * transition callback compares the transaction's actual current state with
   * that expected projection before any write.
   */
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

  /**
   * Defensive frontier projection for inspection. It reads only the
   * lease-lifetime frontier, never the SQLite aggregate.
   */
  readonly frontierSnapshot = (): Effect.Effect<readonly FrontierEntry[]> =>
    this.scheduler.snapshot();

  /**
   * One manual reconcile: under the shared Semaphore, perform one fenced
   * authoritative aggregate read, rebuild the complete frontier, clear transient
   * in-memory blocks, coalesce a wake for fresh exact inspection through the
   * reconciliation driver, and return a defensive frontier snapshot. It never directly
   * retries an unsafe effect.
   */
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

  /**
   * Exact-key control for one dispatch. The runtime, not the driver, maps the
   * closed mutation union to domain transitions, commits under the shared
   * Semaphore with the snapshot fence, updates the projection, and notifies the
   * exact affected key. The driver never sees the whole Workstream and cannot
   * reach private store or frontier internals.
   */
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

  /**
   * Map one closed mutation to its domain transition and commit it once under
   * the shared Semaphore. A durable no-op returns `no_change` without notifying,
   * so a driver can never manufacture progress by re-asserting current facts.
   */
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
        const policy = yield* this.policy();
        const plan = yield* this.try("plan canonical Task enqueue", () =>
          planEnqueue(command, policy),
        );
        const now = yield* this.now();
        const taskId = `task-${randomUUID()}`;
        const attemptIds = Array.from(
          { length: plan.attemptCount },
          () => `attempt-${randomUUID()}`,
        );
        const committed = yield* this.authoritative("enqueue canonical Task", (expected) =>
          createTask(
            expected,
            plan.materialize({ taskId, attemptIds }, now, expected.intents.length - 1),
            now,
          ),
        );
        yield* this.notifyCommitted(
          committed,
          attemptIds.map((attemptId) => ({ taskId, attemptId })),
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
        const now = yield* this.now();
        const expected = yield* Ref.get(this.committed);
        const resolved = yield* this.try("resolve canonical append plan", () => {
          const task = findTask(expected, decoded.taskId);
          if (task === undefined) throw new Error(`Unknown Task ${decoded.taskId}.`);
          return planAppend(decoded, task.kind, policy);
        });
        const attemptIds = Array.from(
          { length: resolved.attemptCount },
          () => `attempt-${randomUUID()}`,
        );
        const committed = yield* this.authoritative("append canonical Attempts", (current) =>
          appendAttempts(current, decoded.taskId, resolved.materialize(attemptIds, now), now),
        );
        yield* this.notifyCommitted(
          committed,
          attemptIds.map((attemptId) => ({ taskId: decoded.taskId, attemptId })),
        );
        return committed;
      }.bind(this),
    );
  }

  /**
   * Perform exactly one authoritative store transition for a command. Under the
   * Semaphore the complete next aggregate is materialized from the internal
   * committed projection before any transaction begins; the single transition
   * callback then compares the transaction's current state exactly with that
   * expected projection. A mismatch writes nothing and fails as a stale
   * projection, so an authoritative `read` (or a future manual reconcile) is
   * required before retry. The snapshot is replaced only from a successful
   * authoritative result.
   */
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

  /**
   * The one affected-key commit hook. Every committed transition that changes
   * attempted work announces its exact Attempt keys here so the frontier
   * replaces only those entries; future transitions use the same hook.
   */
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

  /**
   * Run one coordinator command under the shared Semaphore. The command is
   * forked into the scoped FiberSet so that scope close interrupts and joins it,
   * and caller interruption remains ordinary Effect interruption.
   */
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

  /**
   * Exactly one caller closes the child resource Scope and completes the shared
   * boundary. That critical section is uninterruptible, so parallel or
   * sequential caller-Scope finalization cannot strand a claimed shutdown when
   * it also interrupts the controller. Fatal reporting starts only after the
   * resources and completion boundary settle; it remains ordinarily
   * interruptible because ignoring callback failure does not bound callback
   * duration.
   */
  private shutdown(): Effect.Effect<void, CanonicalRuntimeError> {
    const close: Effect.Effect<CanonicalRuntimeError | undefined> = Effect.uninterruptible(
      Effect.gen(
        function* (this: CanonicalRuntime) {
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

  private report(error: CanonicalRuntimeError): Effect.Effect<void> {
    const report = this.acquisition.onFatal;
    return report === undefined ? Effect.void : report(error).pipe(Effect.ignoreCause);
  }

  private ownerFinalizer(): Effect.Effect<void> {
    return this.requestClose().pipe(Effect.andThen(this.shutdown()), Effect.ignore);
  }

  private closeEffect(): Effect.Effect<void, CanonicalRuntimeError> {
    return this.requestClose().pipe(Effect.andThen(this.shutdown()));
  }
}

function acquireLease(
  store: CanonicalWorkstreamStore,
  acquisition: CanonicalRuntimeAcquisition,
  observed: CanonicalLease | undefined,
): Effect.Effect<CanonicalLease, CanonicalRuntimeError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    if (observed === undefined) return yield* store.acquireLease(acquisition.coordinator);
    // An existing lease is replaceable only with its exact expired observation
    // and caller-supplied proof that its prior owner is dead. The store fences
    // the exact observation and expiry; the runtime owns the liveness rule.
    if (acquisition.priorOwnerLiveness !== "dead")
      return yield* new CanonicalRuntimeLeaseError({
        code: "lease_takeover_requires_dead_owner",
        message: `Workstream ${acquisition.id} already has a fenced lease; replacement requires the exact expired observation and caller-supplied prior-owner liveness "dead".`,
      });
    return yield* store.acquireLease(acquisition.coordinator, observed);
  });
}

/** A mutable context shape so optional facts are added only when present. */
type WritableContext = {
  -readonly [Key in keyof ReconciliationContext]: ReconciliationContext[Key];
};

/**
 * Resolve one already-validated review subject into only the canonical content
 * the review boundary needs: an exact revision, the referenced Outcome(s) in
 * declared order, or one referenced Outcome plus its exact retained artifact.
 * It fails closed if a durable invariant is somehow absent instead of
 * fabricating partial review input.
 */
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

/**
 * Runtime-owned mapping from the closed reconciliation mutation union to canonical domain
 * transitions. Timestamps are runtime-owned except where the value is an
 * external observation the driver actually made.
 */
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
