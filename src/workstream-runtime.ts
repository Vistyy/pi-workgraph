import { randomUUID } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Git worktrees require the host's Node path semantics.
import { dirname, join } from "node:path";
import {
  Cause,
  Clock,
  Data,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  type FileSystem,
  Option,
  type Path,
  Schedule,
  Scope,
  Semaphore,
} from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { GitFailure, GitRepository, WorktreePlacement } from "./git.js";
import {
  type HerdrProtocolError,
  herdrWorkerName,
  legacyHerdrAgentName,
  legacyObjectiveHerdrWorkerName,
  type WorkerLaunchEffectRequest,
  type WorkerLaunchReadinessError,
  type WorkerRecoveryRequest,
} from "./herdr.js";
import type { WorkerLaunchError } from "./herdr-launch.js";
import {
  loadModelPolicyEffect,
  type ModelPolicy,
  type ModelPolicyError,
  resolveSelection,
  type SelectionRequest,
} from "./model-policy.js";
import type {
  createWorkerSessionEffect,
  NativeFailureCategory,
  PiSessionError,
} from "./pi-process.js";
import { LeaseDecisionRequiredError, type LeaseOwner, type WorkgraphRegistry } from "./registry.js";
import type { ThinkingLevel, WorkerIdentity } from "./types.js";
import type {
  StoreEffect,
  WorkAssignment,
  WorkAttempt,
  WorkResult,
  WorkstreamState,
  WorkstreamStoreEffects,
  WorkstreamStoreError,
} from "./workstream.js";
import {
  acquireRuntimeLease,
  type PiObservationError,
  type RuntimeHostError,
  type RuntimeLeaseHandle,
  RuntimeRegistryError,
  type RuntimeWorkerPort,
  runtimePi,
} from "./workstream-runtime-services.js";
import { WorkstreamStoreOperationError } from "./workstream-state.js";

export interface WorkstreamLaunch {
  workspaceId: string;
}
export interface QueueOptions {
  selection?: SelectionRequest;
  /** Explicit target compatibility is retained only with a reason. */
  model?: string;
  modelReason?: string;
  thinking?: ThinkingLevel;
  executor?: { model: string; thinking: ThinkingLevel };
  continuationOf?: string;
  baseRevision?: string;
}
export interface RuntimeOwnership {
  registry?: WorkgraphRegistry;
  owner?: LeaseOwner;
  priorOwnerLiveness?: "alive" | "dead" | "unknown";
  policy?: ModelPolicy;
  /** Test-only clock injection; production uses Effect's live Clock service. */
  clock?: Clock.Clock;
  /** Presentation/status observer for the latest reconciled state. */
  onState?: (state: WorkstreamState) => Effect.Effect<void, RuntimeHostError>;
  /** Host pointer bookkeeping after the runtime and its managed services are fully closed. */
  onStopped?: (error?: Error) => Effect.Effect<void, RuntimeHostError>;
}

export class RuntimeOperationError extends Data.TaggedError("RuntimeOperationError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

export class RuntimeStoppedError extends Data.TaggedError("RuntimeStoppedError")<{
  readonly message: string;
}> {}

export type RuntimeError =
  | RuntimeOperationError
  | RuntimeStoppedError
  | WorkstreamStoreError
  | GitFailure
  | HerdrProtocolError
  | WorkerLaunchReadinessError
  | WorkerLaunchError<unknown>
  | PiSessionError
  | PiObservationError
  | ModelPolicyError
  | PlatformError
  | RuntimeHostError
  | RuntimeRegistryError
  | LeaseDecisionRequiredError;
export type RuntimeEffect<A, E = RuntimeError> = Effect.Effect<
  A,
  E,
  FileSystem.FileSystem | Path.Path
>;

export interface WorkstreamRuntimeEffects {
  readonly submit: <A, E>(effect: RuntimeEffect<A, E>) => RuntimeEffect<A, E | RuntimeError>;
  readonly queue: (
    input: Parameters<WorkstreamStoreEffects["enqueue"]>[0],
    options?: QueueOptions,
  ) => RuntimeEffect<WorkstreamState>;
  readonly reconcile: RuntimeEffect<WorkstreamState>;
  readonly apply: (
    attemptId: string,
    sourceCommit: string,
    destinationHead: string,
  ) => RuntimeEffect<WorkstreamState>;
  readonly releaseOutput: (attemptId: string, reason: string) => RuntimeEffect<WorkstreamState>;
  readonly steer: (attemptId: string, instruction: string) => RuntimeEffect<void>;
  readonly cancel: (attemptId: string) => RuntimeEffect<void>;
  readonly close: Effect.Effect<void, RuntimeRegistryError>;
}

/** Ready scoped owner for serialized work and its fenced registry lease. */
export class WorkstreamRuntime {
  private readonly deliveryOwner = randomUUID();
  private readonly onState: (state: WorkstreamState) => Effect.Effect<void, RuntimeHostError>;
  private closed = false;
  private reconciliationError: string | undefined;
  readonly effects: WorkstreamRuntimeEffects;

  private constructor(
    readonly store: WorkstreamStoreEffects,
    readonly repository: GitRepository,
    readonly workers: RuntimeWorkerPort,
    readonly launch: WorkstreamLaunch,
    readonly onResult: (
      resultId: string,
      state: WorkstreamState,
    ) => Effect.Effect<void, RuntimeHostError>,
    readonly onError: (error: Error) => Effect.Effect<void, RuntimeHostError>,
    private readonly lease: RuntimeLeaseHandle,
    private readonly scope: Scope.Closeable,
    private readonly semaphore: Semaphore.Semaphore,
    private readonly fibers: FiberSet.FiberSet<unknown, RuntimeError>,
    private readonly policy: Effect.Effect<
      ModelPolicy,
      ModelPolicyError | PlatformError,
      FileSystem.FileSystem
    >,
    private readonly clock: Clock.Clock | undefined,
    onState: ((state: WorkstreamState) => Effect.Effect<void, RuntimeHostError>) | undefined,
  ) {
    this.onState = onState ?? (() => Effect.void);
    this.effects = {
      submit: <A, E>(effect: RuntimeEffect<A, E>) =>
        this.submit(effect).pipe(Effect.mapError((error) => this.submissionError(error))),
      queue: (input, options = {}) => this.submit(this.queueEffect(input, options)),
      reconcile: this.submit(this.reconcileOperation()),
      apply: (attemptId, sourceCommit, destinationHead) =>
        this.submit(this.applyEffect(attemptId, sourceCommit, destinationHead)),
      releaseOutput: (attemptId, reason) =>
        this.submit(this.releaseOutputEffect(attemptId, reason)),
      steer: (attemptId, instruction) => this.submit(this.steerEffect(attemptId, instruction)),
      cancel: (attemptId) => this.submit(this.cancelEffect(attemptId)),
      close: Effect.suspend(() => this.close(Exit.void)),
    };
  }

  static acquire(
    store: WorkstreamStoreEffects,
    repository: GitRepository,
    workers: RuntimeWorkerPort,
    launch: WorkstreamLaunch,
    onResult: (resultId: string, state: WorkstreamState) => Effect.Effect<void, RuntimeHostError>,
    onError: (error: Error) => Effect.Effect<void, RuntimeHostError>,
    ownership: RuntimeOwnership = {},
  ): RuntimeEffect<WorkstreamRuntime> {
    return Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      let runtime: WorkstreamRuntime | undefined;
      yield* Scope.addFinalizerExit(scope, (exit) => {
        const stopped = ownership.onStopped?.(failureFromExit(exit));
        if (stopped === undefined) return Effect.void;
        return stopped.pipe(
          Effect.catch((error) =>
            onError(error).pipe(Effect.ignore, Effect.andThen(Effect.die(error))),
          ),
        );
      });
      const acquisition = Effect.gen(function* () {
        const lease = yield* acquireRuntimeLease({
          store,
          registry: ownership.registry,
          owner: ownership.owner,
          priorOwnerLiveness: ownership.priorOwnerLiveness,
          onFinalizerError: (error) => onError(error),
        });
        const semaphore = yield* Semaphore.make(1);
        const fibers = yield* FiberSet.make<unknown, RuntimeError>();
        runtime = new WorkstreamRuntime(
          store,
          repository,
          workers,
          launch,
          onResult,
          onError,
          lease,
          scope,
          semaphore,
          fibers,
          ownership.policy === undefined
            ? loadModelPolicyEffect()
            : Effect.succeed(ownership.policy),
          ownership.clock,
          ownership.onState,
        );
        const active = runtime;
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            active.closed = true;
          }),
        );
        yield* FiberSet.run(fibers, active.clocked(active.heartbeatLoop()));
        yield* FiberSet.run(fibers, active.clocked(active.reconciliationLoop()));
        return active;
      }).pipe(Scope.provide(scope));
      const configured =
        ownership.clock === undefined
          ? acquisition
          : Effect.provideService(acquisition, Clock.Clock, ownership.clock);
      return yield* configured.pipe(
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
      );
    });
  }

  private submit<T, E>(effect: RuntimeEffect<T, E>): RuntimeEffect<T, E | RuntimeError> {
    return Effect.suspend(() => {
      if (this.closed)
        return Effect.fail(new RuntimeStoppedError({ message: "Workstream runtime is stopped." }));
      const run = Effect.gen(
        function* (this: WorkstreamRuntime) {
          const fiber = yield* FiberSet.run(
            this.fibers,
            Effect.exit(
              this.semaphore.withPermit(
                Effect.suspend<T, E | RuntimeError, FileSystem.FileSystem | Path.Path>(() =>
                  this.closed
                    ? Effect.fail(
                        new RuntimeStoppedError({ message: "Workstream runtime is stopped." }),
                      )
                    : this.ownershipEffect().pipe(Effect.andThen(effect)),
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
      return this.clocked(run);
    });
  }

  private close(exit: Exit.Exit<unknown, RuntimeError>): Effect.Effect<void, RuntimeRegistryError> {
    return Scope.close(this.scope, exit).pipe(
      Effect.catchCause((cause) =>
        Effect.fail(
          new RuntimeRegistryError({
            operation: "close workstream runtime",
            cause: Cause.squash(cause),
          }),
        ),
      ),
    );
  }

  private clocked<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return this.clock === undefined
      ? effect
      : Effect.provideService(effect, Clock.Clock, this.clock);
  }

  private runtimeSync<A>(operation: string, run: () => A): RuntimeEffect<A, RuntimeOperationError> {
    return Effect.try({
      try: run,
      catch: (cause) => new RuntimeOperationError({ operation, cause }),
    });
  }

  private storeEffect<A>(
    run: (store: WorkstreamStoreEffects) => StoreEffect<A>,
  ): RuntimeEffect<A, WorkstreamStoreError | LeaseDecisionRequiredError> {
    return run(this.store).pipe(
      Effect.mapError((error) =>
        error instanceof WorkstreamStoreOperationError &&
        error.cause instanceof LeaseDecisionRequiredError
          ? error.cause
          : error,
      ),
    );
  }

  private gitEffect<A>(
    run: (repository: GitRepository["effects"]) => Effect.Effect<A, GitFailure>,
  ): RuntimeEffect<A, GitFailure> {
    return run(this.repository.effects);
  }

  private herdrEffect<A, E>(
    run: (workers: RuntimeWorkerPort["effects"]) => RuntimeEffect<A, E>,
  ): RuntimeEffect<A, E> {
    return run(this.workers.effects);
  }

  private ownershipEffect(): RuntimeEffect<
    void,
    LeaseDecisionRequiredError | RuntimeRegistryError
  > {
    return Effect.try({
      try: this.lease.assert,
      catch: (cause) =>
        cause instanceof LeaseDecisionRequiredError
          ? cause
          : new RuntimeRegistryError({ operation: "assert registry lease", cause }),
    });
  }

  private heartbeatLoop(): RuntimeEffect<void> {
    return this.lease.renew.pipe(
      Effect.repeat(Schedule.spaced("5 seconds")),
      Effect.asVoid,
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => {
          const failure = Cause.squash(cause);
          const fatal =
            failure instanceof LeaseDecisionRequiredError || failure instanceof RuntimeRegistryError
              ? failure
              : new RuntimeRegistryError({ operation: "renew registry lease", cause: failure });
          return this.terminate(fatal);
        },
      ),
    );
  }

  private terminate(fatal: RuntimeError): RuntimeEffect<void> {
    return Effect.suspend(() => {
      if (this.closed) return Effect.void;
      this.closed = true;
      return this.onError(fatal).pipe(
        Effect.ignore,
        Effect.andThen(this.close(Exit.fail(fatal))),
        Effect.asVoid,
      );
    });
  }

  private reconciliationLoop(): RuntimeEffect<void> {
    return Effect.sleep("1 second").pipe(
      Effect.andThen(this.submit(this.reconcileOperation())),
      Effect.tap(() => Effect.sync(() => (this.reconciliationError = undefined))),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => {
          const failure = Cause.squash(cause);
          const error = failure instanceof Error ? failure : new Error(String(failure));
          if (
            failure instanceof LeaseDecisionRequiredError ||
            failure instanceof RuntimeRegistryError
          )
            return this.terminate(failure);
          const detail = error.message;
          if (detail === this.reconciliationError) return Effect.void;
          this.reconciliationError = detail;
          return this.onError(error).pipe(Effect.ignore);
        },
      ),
      Effect.repeat(Schedule.forever),
      Effect.asVoid,
    );
  }

  private submissionError<E>(error: E | RuntimeError): E | RuntimeError {
    return error instanceof WorkstreamStoreOperationError
      ? new RuntimeOperationError({ operation: "submitted store operation", cause: error.cause })
      : error;
  }

  private queueEffect(
    input: Parameters<WorkstreamStoreEffects["enqueue"]>[0],
    options: QueueOptions,
  ): RuntimeEffect<WorkstreamState> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const policy = yield* this.policy;
        const baseRevision = yield* this.resolveQueueBaseEffect(input, options);
        const attempts = yield* this.runtimeSync("prepare queued attempt", () =>
          input.capability === "implement"
            ? implementationAttempt(policy, options, baseRevision)
            : selectedAttempts(input.capability, policy, options, baseRevision),
        );
        return yield* this.storeEffect((store) => store.enqueue(input, attempts));
      }.bind(this),
    );
  }

  private resolveQueueBaseEffect(
    input: Parameters<WorkstreamStoreEffects["enqueue"]>[0],
    options: QueueOptions,
  ): RuntimeEffect<string | undefined> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const subjectRevision =
          input.capability === "review" && input.subject.kind === "revision"
            ? input.subject.revision
            : undefined;
        if (
          subjectRevision !== undefined &&
          options.baseRevision !== undefined &&
          subjectRevision !== options.baseRevision
        )
          return yield* this.runtimeSync("validate review base", () => {
            throw new Error("Review base revision conflicts with its exact subject.");
          });
        const isolated =
          input.capability === "implement" || input.artifactIntent === "disposable_experiment";
        const repositoryHead =
          options.baseRevision === undefined && subjectRevision === undefined && isolated
            ? yield* this.gitEffect((repository) => repository.head())
            : undefined;
        const requested = options.baseRevision ?? subjectRevision ?? repositoryHead;
        return requested === undefined
          ? undefined
          : yield* this.gitEffect((repository) => repository.resolveRevision(requested));
      }.bind(this),
    );
  }

  private reconcileOperation(): RuntimeEffect<WorkstreamState> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const initial = yield* this.storeEffect((store) => store.load());
        if (initial.lifecycle.state !== "active" && initial.lifecycle.state !== "suspended")
          return initial;
        yield* Effect.forEach(initial.attempts, (attempt) => this.reconcileAttempt(attempt), {
          discard: true,
        });
        const state = yield* this.storeEffect((store) => store.load());
        if (state.lifecycle.state === "active")
          yield* Effect.forEach(state.deliveries, (delivery) => this.reconcileDelivery(delivery), {
            discard: true,
          });
        const reconciled = yield* this.storeEffect((store) => store.load());
        yield* this.onState(reconciled);
        return reconciled;
      }.bind(this),
    );
  }

  private reconcileAttempt(item: WorkstreamState["attempts"][number]): RuntimeEffect<void> {
    const operation = Effect.gen(
      function* (this: WorkstreamRuntime) {
        if (yield* this.preserveExistingBoundary(item)) return;
        yield* this.advance(item.id);
        const state = yield* this.storeEffect((store) => store.load());
        const advanced = findAttempt(state, item.id);
        const blocked = blockedDetail(advanced);
        if (blocked !== undefined)
          return yield* this.runtimeSync("validate advanced attempt", () => {
            throw new Error(blocked);
          });
        if (advanced.error !== undefined)
          yield* this.storeEffect((store) => store.clearAttention(item.id));
      }.bind(this),
    );
    return operation.pipe(Effect.catch((error) => this.recordAttemptFailure(item.id, error)));
  }

  private preserveExistingBoundary(item: WorkAttempt): RuntimeEffect<boolean> {
    if (item.state === "cancel_requested" && item.cleanup?.state === "completed")
      return this.storeEffect((store) => store.finishCleanup(item.id)).pipe(Effect.as(true));
    if (item.outputRelease?.state === "pending" || item.outputRelease?.state === "blocked")
      return this.runtimeSync("preserve interrupted retained-output release", () => {
        throw new Error(
          item.outputRelease?.error ??
            "Retained-output release is pending; freshly inspect exact worktree ownership and presence before any recovery.",
        );
      });
    if (item.application?.state === "pending" || item.application?.state === "blocked")
      return this.runtimeSync("preserve interrupted application", () => {
        throw new Error(
          item.application?.error ??
            "Application is pending; freshly inspect destination and source postconditions before any recovery.",
        );
      });
    if (item.cleanup?.state === "completed")
      return (
        item.error === undefined
          ? Effect.void
          : this.storeEffect((store) => store.clearAttention(item.id))
      ).pipe(Effect.as(true));
    const interruption =
      item.cleanup?.state === "pending" || item.cleanup?.state === "blocked"
        ? (item.cleanup.error ??
          "Cleanup was interrupted after its checkpoint; exact resources were preserved for coordinator diagnosis.")
        : undefined;
    if (interruption === undefined) return Effect.succeed(false);
    return this.runtimeSync("preserve interrupted operation", () => {
      throw new Error(interruption);
    });
  }

  private recordAttemptFailure(id: string, error: RuntimeError): RuntimeEffect<void> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const latest = yield* this.storeEffect((store) => store.load());
        const attempt = findAttempt(latest, id);
        if (attempt.error === error.message) return;
        yield* this.storeEffect((store) => store.recordAttention(id, error.message));
        yield* this.onError(new Error(`Attempt ${id}: ${error.message}`));
      }.bind(this),
    );
  }

  private reconcileDelivery(delivery: WorkstreamState["deliveries"][number]): RuntimeEffect<void> {
    if (delivery.state !== "pending" || delivery.attemptedBy === this.deliveryOwner)
      return Effect.void;
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        yield* this.storeEffect((store) =>
          store.deliveryAttempt(delivery.resultId, this.deliveryOwner),
        );
        const latest = yield* this.storeEffect((store) => store.load());
        const deliveryEffect = this.ownershipEffect().pipe(
          Effect.andThen(this.onResult(delivery.resultId, latest)),
          Effect.andThen(this.storeEffect((store) => store.markDelivered(delivery.resultId))),
        );
        yield* deliveryEffect.pipe(
          Effect.catch((error) =>
            this.storeEffect((store) =>
              store.deliveryAttempt(delivery.resultId, this.deliveryOwner, error.message),
            ),
          ),
        );
      }.bind(this),
    );
  }

  private advance(id: string): RuntimeEffect<void> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const state = yield* this.storeEffect((store) => store.load());
        const attempt = findAttempt(state, id);
        const assignment = findAssignment(state, attempt.assignmentId);
        if (attempt.cleanup?.state === "completed") return;
        if (attempt.state === "cancel_requested") {
          yield* this.beginCleanupIfNeeded(attempt);
          yield* this.cleanup(id);
          return;
        }
        if (requiresLaunch(attempt)) {
          if (state.lifecycle.state === "active")
            yield* this.launchAttempt(state, attempt, assignment);
          return;
        }
        if (attempt.state === "starting" && attempt.sessionFile === undefined)
          return yield* this.runtimeSync("validate worker session checkpoint", () => {
            throw new Error(
              "Worker session creation did not reach its retained checkpoint. Herdr launch was not invoked; inspect the Pi session directory before retrying session creation.",
            );
          });
        if (hasRetainedSession(attempt)) yield* this.reconcileWorker(state, attempt, assignment);
        yield* this.advanceRetainedResult(id, assignment);
      }.bind(this),
    );
  }

  private reconcileWorker(
    state: WorkstreamState,
    initial: WorkAttempt,
    assignment: WorkAssignment,
  ): RuntimeEffect<void> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const attempt =
          initial.worker === undefined
            ? yield* this.recoverWorker(state, initial, assignment)
            : initial;
        const worker = required(attempt.worker, "worker identity");
        const observation = yield* this.herdrEffect((workers) => workers.observe(worker));
        const pi = runtimePi;
        const started = pi.started(worker.sessionFile, state.id, attempt.id);
        if (started && attempt.submission !== "started")
          yield* this.storeEffect((store) => store.markSubmission(attempt.id, "started"));
        if (yield* this.resumeUnsentWorker(state, attempt, observation.status, started)) return;
        if (!pi.settled(worker.sessionFile, state.id, attempt.id)) {
          yield* this.validateUnsettledWorker(attempt, observation.status, started);
          return;
        }
        if (observation.status === "working" || observation.status === "blocked") return;
        yield* this.retain(state, attempt, assignment);
      }.bind(this),
    );
  }

  private recoverWorker(
    state: WorkstreamState,
    attempt: WorkAttempt,
    assignment: WorkAssignment,
  ): RuntimeEffect<WorkAttempt> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const request = workerRecoveryRequest(this.launch.workspaceId, state, attempt, assignment);
        const recovered = yield* this.herdrEffect((workers) => workers.recover(request));
        if (recovered === undefined)
          return yield* this.runtimeSync("validate recovered worker", () => {
            throw new Error(
              "Retained launch has no proven live identity; inspect before replacing it.",
            );
          });
        yield* this.storeEffect((store) => store.recordWorker(attempt.id, recovered.identity));
        const latest = yield* this.storeEffect((store) => store.load());
        return findAttempt(latest, attempt.id);
      }.bind(this),
    );
  }

  private resumeUnsentWorker(
    state: WorkstreamState,
    attempt: WorkAttempt,
    status: "idle" | "working" | "blocked" | "done" | "unknown",
    started: boolean,
  ): RuntimeEffect<boolean> {
    if (attempt.submission !== "not_sent" || started || state.lifecycle.state !== "active")
      return Effect.succeed(false);
    if (status !== "idle" && status !== "done")
      return this.runtimeSync("validate retained submission", () => {
        throw new Error("Worker is not ready for the retained unsent objective.");
      });
    const worker = required(attempt.worker, "worker identity");
    return this.storeEffect((store) => store.markSubmission(attempt.id, "uncertain")).pipe(
      Effect.andThen(
        this.herdrEffect((workers) =>
          workers.steer(worker, "Continue the assigned Workgraph objective now."),
        ),
      ),
      Effect.andThen(this.storeEffect((store) => store.markSubmission(attempt.id, "submitted"))),
      Effect.as(true),
    );
  }

  private validateUnsettledWorker(
    attempt: WorkAttempt,
    status: "idle" | "working" | "blocked" | "done" | "unknown",
    started: boolean,
  ): RuntimeEffect<void> {
    return this.runtimeSync("validate unsettled worker", () => {
      if (status === "blocked")
        throw new Error("Worker is blocked; inspect its visible session before proceeding.");
      if (attempt.submission === "uncertain" && !started)
        throw new Error(
          "Submission is uncertain and no current native start is recorded. Inspect before resending.",
        );
      // Herdr idle/done can lag Pi's native markers; absence of settlement does not authorize resend.
    });
  }

  private advanceRetainedResult(id: string, _assignment: WorkAssignment): RuntimeEffect<void> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        let state = yield* this.storeEffect((store) => store.load());
        let attempt = findAttempt(state, id);
        if (attempt.resultId === undefined) return;
        const result = state.results.find((item) => item.id === attempt.resultId);
        if (result === undefined)
          return yield* this.runtimeSync("validate retained result", () => {
            throw new Error("Retained attempt result is missing.");
          });
        if (!state.deliveries.some((delivery) => delivery.resultId === result.id))
          yield* this.storeEffect((store) => store.requestDelivery(result.id));
        // Reports, including malformed or failed reports, never prevent closure of
        // an independently proven stopped worker.
        // A worker report retains output; only an explicit coordinator apply may
        // mutate the destination repository.
        state = yield* this.storeEffect((store) => store.load());
        attempt = findAttempt(state, id);
        yield* this.beginCleanupIfNeeded(attempt);
        yield* this.cleanup(id);
      }.bind(this),
    );
  }

  private beginCleanupIfNeeded(attempt: WorkAttempt): RuntimeEffect<void> {
    if (attempt.cleanup !== undefined || attempt.placement === undefined) return Effect.void;
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const input: Parameters<WorkstreamStoreEffects["beginCleanup"]>[0] = {
          id: attempt.id,
        };
        if (attempt.placement?.kind === "isolated_worktree")
          input.expectedHead = yield* this.gitEffect((repository) =>
            repository.head(attempt.placement?.path),
          );
        yield* this.storeEffect((store) => store.beginCleanup(input));
      }.bind(this),
    );
  }

  private launchAttempt(
    state: WorkstreamState,
    attempt: WorkAttempt,
    assignment: WorkAssignment,
  ): RuntimeEffect<void> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const isolated =
          assignment.capability === "implement" ||
          assignment.artifactIntent === "disposable_experiment";
        const baseRevision = attempt.baseRevision;
        const placement = isolated
          ? yield* this.gitEffect((repository) =>
              repository.createWorktree(
                state.id,
                attempt.id,
                required(baseRevision, "base revision"),
              ),
            )
          : undefined;
        const workerCwd = placement?.path ?? this.repository.root;
        const start: Parameters<WorkstreamStoreEffects["startAttempt"]>[0] = {
          id: attempt.id,
          placement:
            placement === undefined
              ? { kind: "shared_project", path: workerCwd }
              : {
                  kind: "isolated_worktree",
                  path: placement.path,
                  branch: placement.branch,
                },
        };
        if (baseRevision !== undefined) start.baseRevision = baseRevision;
        yield* this.storeEffect((store) => store.startAttempt(start));
        const sessionRequest = workerSessionRequest(
          state,
          attempt,
          assignment,
          workerCwd,
          baseRevision,
        );
        const pi = runtimePi;
        const sessionFile = yield* pi.createSession(sessionRequest);
        yield* this.storeEffect((store) => store.recordSessionFile(attempt.id, sessionFile));
        const models = required(attempt.models, "assignment models");
        yield* this.ownershipEffect();
        const request = workerLaunchRequest(
          this.launch.workspaceId,
          state,
          attempt,
          assignment,
          workerCwd,
          sessionFile,
          models,
          baseRevision,
          this.store,
        );
        yield* this.herdrEffect((workers) => workers.launch(request));
      }.bind(this),
    );
  }

  private retain(
    state: WorkstreamState,
    attempt: WorkAttempt,
    assignment: WorkAssignment,
  ): RuntimeEffect<void> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const sessionFile = required(attempt.sessionFile, "session");
        const generation = { runId: state.id, nodeId: attempt.id };
        // Keep the opaque result identity stable across a crash between retention and settlement.
        const resultId = attempt.resultId ?? `result-${attempt.id}`;
        if (!state.results.some((item) => item.id === resultId))
          yield* this.retainNewResult(state, attempt, assignment, sessionFile, resultId);
        const effectiveModels = yield* runtimePi.models(sessionFile, generation);
        yield* this.storeEffect((store) =>
          store.settleAttempt({ id: attempt.id, resultId, effectiveModels }),
        );
        yield* this.storeEffect((store) => store.requestDelivery(resultId));
      }.bind(this),
    );
  }

  private retainNewResult(
    state: WorkstreamState,
    attempt: WorkAttempt,
    assignment: WorkAssignment,
    sessionFile: string,
    resultId: string,
  ): RuntimeEffect<void> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const generation = { runId: state.id, nodeId: attempt.id };
        const pi = runtimePi;
        const read = yield* pi.readReport(sessionFile, generation);
        const base = {
          id: resultId,
          assignmentId: assignment.id,
          assignmentIntentVersion: assignment.intentVersion,
        };
        if (read.report !== undefined && read.report.kind === modeFor(assignment)) {
          yield* this.retainTypedResult(attempt, assignment, base, read.report);
          return;
        }
        if (read.report !== undefined || read.invalid || read.unreadable) {
          yield* this.storeEffect((store) =>
            store.retainResult({
              ...base,
              validity: "invalid",
              detail:
                read.error ?? "Worker report kind does not match the assigned responsibility.",
            }),
          );
          return;
        }
        const text = yield* pi.readText(sessionFile, generation);
        if (text !== undefined && text !== "") {
          yield* this.storeEffect((store) =>
            store.retainResult({ ...base, validity: "untyped", text }),
          );
          return;
        }
        const nativeFailure = yield* pi.observeFailure(sessionFile, generation);
        yield* this.storeEffect((store) =>
          store.retainResult({
            ...base,
            validity: "absent",
            detail: absentResultDetail(nativeFailure),
          }),
        );
      }.bind(this),
    );
  }

  private retainTypedResult(
    attempt: WorkAttempt,
    assignment: WorkAssignment,
    base: { id: string; assignmentId: string; assignmentIntentVersion: number },
    report: WorkerReport,
  ): RuntimeEffect<void> {
    if (isNoChangeImplementation(assignment, report))
      return this.gitEffect((repository) =>
        repository.validateWorkerNoChange(placementOf(attempt), report.revision),
      ).pipe(
        Effect.andThen(
          this.storeEffect((store) => store.retainResult({ ...base, validity: "typed", report })),
        ),
        Effect.catch((error) => this.retainFailedNoChange(attempt, base, error)),
        Effect.asVoid,
      );
    const placement = attempt.placement;
    const retainsOutput =
      placement?.kind === "isolated_worktree" &&
      (assignment.artifactIntent === "disposable_experiment" ||
        assignment.capability === "implement");
    const artifacts = retainsOutput
      ? [
          {
            id: "retained-output-worktree",
            kind: "path" as const,
            reference: placement.path,
            retention: "retained" as const,
            summary: "Owned output worktree retained until explicit coordinator apply or release.",
          },
        ]
      : [];
    return this.storeEffect((store) =>
      store.retainResult({ ...base, validity: "typed", report, artifacts }),
    ).pipe(Effect.asVoid);
  }

  private retainFailedNoChange(
    attempt: WorkAttempt,
    base: { id: string; assignmentId: string; assignmentIntentVersion: number },
    error: RuntimeError,
  ): RuntimeEffect<void> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        yield* this.storeEffect((store) =>
          store.retainResult({
            ...base,
            validity: "invalid",
            detail: `No-change validation failed: ${error.message}`,
          }),
        );
        const cleanup: Parameters<WorkstreamStoreEffects["beginCleanup"]>[0] = {
          id: attempt.id,
        };
        if (attempt.placement?.kind === "isolated_worktree")
          cleanup.expectedHead = yield* this.gitEffect((repository) =>
            repository.head(attempt.placement?.path),
          );
        yield* this.storeEffect((store) => store.beginCleanup(cleanup));
        yield* this.storeEffect((store) => store.blockCleanup(attempt.id, error.message));
      }.bind(this),
    );
  }

  private applyEffect(
    attemptId: string,
    sourceCommit: string,
    destinationHead: string,
  ): RuntimeEffect<WorkstreamState> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const state = yield* this.storeEffect((store) => store.load());
        const attempt = findAttempt(state, attemptId);
        const assignment = findAssignment(state, attempt.assignmentId);
        const result = state.results.find((item) => item.id === attempt.resultId);
        const reportedCommit = validApplicationCommit(result);
        yield* this.runtimeSync("validate explicit application", () =>
          validateExplicitApplication(
            state,
            attempt,
            assignment,
            reportedCommit,
            sourceCommit,
            this.store.isAssignmentCurrent(state, assignment.id),
          ),
        );
        yield* this.applyMaintainedOutput(attempt, assignment, sourceCommit, destinationHead).pipe(
          Effect.catch((error) =>
            this.recoverApplication(attempt, sourceCommit, destinationHead, error),
          ),
        );
        const applied = findAttempt(yield* this.storeEffect((store) => store.load()), attemptId);
        if (applied.application?.state !== "applied")
          return yield* this.runtimeSync("validate application postcondition", () => {
            throw new Error("Application did not establish an applied destination revision.");
          });
        return yield* this.releaseOutputEffect(
          attemptId,
          `Applied source ${sourceCommit} to destination ${required(
            applied.application.revision,
            "applied revision",
          )}.`,
        );
      }.bind(this),
    );
  }

  private applyMaintainedOutput(
    attempt: WorkAttempt,
    assignment: WorkAssignment,
    commit: string,
    expectedHead: string,
  ): RuntimeEffect<void> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        yield* this.gitEffect((repository) =>
          repository.validateWorkerCommit(placementOf(attempt), commit),
        );
        yield* this.storeEffect((store) =>
          store.beginApplication({ id: attempt.id, commit, expectedHead }),
        );
        const state = yield* this.storeEffect((store) => store.load());
        yield* this.runtimeSync("validate current application intent", () => {
          if (!this.store.isAssignmentCurrent(state, assignment.id))
            throw new Error(
              "Intent changed; retained implementation is stale and cannot be applied.",
            );
        });
        yield* this.ownershipEffect();
        const revision = yield* this.gitEffect((repository) =>
          repository.applyCommit(commit, expectedHead),
        );
        yield* this.storeEffect((store) => store.finishApplication(attempt.id, revision));
        yield* this.recordApplicationArtifact(attempt, revision, `Applied ${commit}.`);
      }.bind(this),
    );
  }

  private recoverApplication(
    attempt: WorkAttempt,
    commit: string,
    expectedHead: string,
    originalError: RuntimeError,
  ): RuntimeEffect<void> {
    // A command or persistence error can occur after Git changed HEAD. Inspect before retry.
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const recovery = yield* this.gitEffect((repository) =>
          repository.recoverApplication(expectedHead, {
            baseCommit: required(attempt.baseRevision, "base revision"),
            commit,
          }),
        ).pipe(Effect.option);
        if (Option.isNone(recovery) || recovery.value === undefined) {
          yield* this.storeEffect((store) =>
            store.blockApplication(attempt.id, originalError.message),
          );
          return;
        }
        const recovered = recovery.value;
        yield* this.storeEffect((store) => store.finishApplication(attempt.id, recovered.head));
        yield* this.recordApplicationArtifact(
          attempt,
          recovered.head,
          `Recovered application of ${commit}.`,
        );
      }.bind(this),
    );
  }

  private recordApplicationArtifact(
    attempt: WorkAttempt,
    revision: string,
    summary: string,
  ): RuntimeEffect<void> {
    return this.storeEffect((store) =>
      store.addResultArtifacts(required(attempt.resultId, "result"), [
        {
          id: "maintained-revision",
          kind: "revision",
          reference: revision,
          retention: "retained",
          summary,
        },
      ]),
    ).pipe(Effect.asVoid);
  }

  private cleanup(id: string): RuntimeEffect<void> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const state = yield* this.storeEffect((store) => store.load());
        const attempt = findAttempt(state, id);
        const cleanup = attempt.cleanup;
        if (cleanup?.state !== "pending") return;
        const assignment = findAssignment(state, attempt.assignmentId);
        const operation = this.cleanupAttempt(state, attempt, cleanup, assignment);
        yield* operation.pipe(
          Effect.catch((error) =>
            this.storeEffect((store) => store.blockCleanup(id, error.message)),
          ),
        );
      }.bind(this),
    );
  }

  private cleanupAttempt(
    state: WorkstreamState,
    attempt: WorkAttempt,
    cleanup: NonNullable<WorkAttempt["cleanup"]>,
    assignment: WorkAssignment,
  ): RuntimeEffect<void> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        if (!cleanup.workerClosed) {
          const result = yield* this.herdrEffect((workers) =>
            workers.cleanup(required(attempt.worker, "worker identity")),
          );
          if (result.state === "pending") return;
          if (result.state !== "completed")
            return yield* this.runtimeSync("validate worker cleanup result", () => {
              throw new Error(result.detail ?? "Worker cleanup is not proven complete.");
            });
          yield* this.storeEffect((store) => store.markWorkerClosed(attempt.id));
        }
        yield* this.ownershipEffect();
        yield* this.cleanupPlacement(state, attempt, cleanup, assignment);
        yield* this.storeEffect((store) => store.finishCleanup(attempt.id));
      }.bind(this),
    );
  }

  private cleanupPlacement(
    state: WorkstreamState,
    attempt: WorkAttempt,
    cleanup: NonNullable<WorkAttempt["cleanup"]>,
    assignment: WorkAssignment,
  ): RuntimeEffect<void> {
    const result = state.results.find((item) => item.id === attempt.resultId);
    const noChange =
      result?.validity === "typed" &&
      result.report.kind === "implementation" &&
      result.report.status === "completed" &&
      result.report.outcome === "no_change";
    if (
      attempt.placement?.kind !== "isolated_worktree" ||
      assignment.artifactIntent === "disposable_experiment" ||
      (assignment.capability === "implement" &&
        attempt.application?.state !== "applied" &&
        !noChange)
    )
      return Effect.void;
    return this.gitEffect((repository) =>
      repository.cleanupWorktree(
        placementOf(attempt),
        required(cleanup.expectedHead, "expected worktree HEAD"),
      ),
    ).pipe(Effect.asVoid);
  }

  private releaseOutputEffect(attemptId: string, reason: string): RuntimeEffect<WorkstreamState> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        if (reason.trim() === "")
          return yield* this.runtimeSync("validate retained-output release", () => {
            throw new Error("Retained-output release reason is required.");
          });
        let state = yield* this.storeEffect((store) => store.load());
        let attempt = findAttempt(state, attemptId);
        const assignment = findAssignment(state, attempt.assignmentId);
        yield* this.runtimeSync("validate retained-output release", () => {
          const releasableAssignment =
            assignment.artifactIntent === "disposable_experiment" ||
            assignment.capability === "implement";
          if (
            !releasableAssignment ||
            !["settled", "failed", "cancelled"].includes(attempt.state) ||
            attempt.placement?.kind !== "isolated_worktree" ||
            attempt.cleanup?.state !== "completed" ||
            !attempt.cleanup.workerClosed
          )
            throw new Error(
              "Only closed retained output from an owned experiment or unapplied implementation can be released.",
            );
        });
        if (attempt.outputRelease?.state === "completed") return state;
        const expectedHead =
          attempt.outputRelease?.expectedHead ??
          (yield* this.gitEffect((repository) => repository.head(placementOf(attempt).path)));
        yield* this.storeEffect((store) =>
          store.beginOutputRelease({ id: attemptId, expectedHead, reason }),
        );
        state = yield* this.storeEffect((store) => store.load());
        attempt = findAttempt(state, attemptId);
        const release = Effect.gen(
          function* (this: WorkstreamRuntime) {
            yield* this.ownershipEffect();
            yield* this.gitEffect((repository) =>
              repository.discardExperiment(placementOf(attempt), expectedHead),
            );
            yield* this.ownershipEffect();
            yield* this.gitEffect((repository) =>
              repository.cleanupWorktree(placementOf(attempt), expectedHead),
            );
            yield* this.storeEffect((store) => store.finishOutputRelease(attemptId));
          }.bind(this),
        );
        yield* release.pipe(
          Effect.catch((error) =>
            this.storeEffect((store) => store.blockOutputRelease(attemptId, error.message)).pipe(
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        );
        return yield* this.storeEffect((store) => store.load());
      }.bind(this),
    );
  }

  private steerEffect(attemptId: string, instruction: string): RuntimeEffect<void> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const state = yield* this.storeEffect((store) => store.load());
        const attempt = findAttempt(state, attemptId);
        yield* this.runtimeSync("validate steering request", () => {
          if (instruction.trim() === "") throw new Error("Steering instruction is required.");
          if (
            attempt.worker === undefined ||
            (attempt.state !== "running" && attempt.state !== "starting")
          )
            throw new Error("Attempt has no steerable live worker.");
        });
        const worker = required(attempt.worker, "worker identity");
        yield* this.storeEffect((store) =>
          store.recordSteering(attemptId, instruction, "uncertain"),
        );
        yield* this.herdrEffect((workers) => workers.steer(worker, instruction));
        yield* this.storeEffect((store) =>
          store.recordSteering(attemptId, instruction, "submitted"),
        );
      }.bind(this),
    );
  }

  private cancelEffect(attemptId: string): RuntimeEffect<void> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const state = yield* this.storeEffect((store) => store.load());
        const attempt = findAttempt(state, attemptId);
        yield* this.validateCancellation(attempt);
        const worker = yield* this.recoverCancellationWorker(state, attempt);
        yield* this.storeEffect((store) => store.cancelAttempt(attemptId));
        if (attempt.state === "starting" && hasProvenNoNativeLaunch(attempt))
          return yield* this.finishUnlaunchedCancellation(attemptId);
        yield* this.cancelOwnedWorker(attemptId, attempt.state, worker);
      }.bind(this),
    );
  }

  private validateCancellation(attempt: WorkAttempt): RuntimeEffect<void> {
    return this.runtimeSync("validate cancellation request", () => {
      if (!["queued", "running", "starting"].includes(attempt.state))
        throw new Error("Attempt is not active.");
    });
  }

  private recoverCancellationWorker(
    state: WorkstreamState,
    attempt: WorkAttempt,
  ): RuntimeEffect<WorkerIdentity | undefined> {
    if (
      attempt.state !== "starting" ||
      attempt.sessionFile === undefined ||
      attempt.launchPane !== undefined ||
      attempt.worker !== undefined
    )
      return Effect.succeed(attempt.worker);
    const assignment = findAssignment(state, attempt.assignmentId);
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const recovered = yield* this.herdrEffect((workers) =>
          workers.recover(
            workerRecoveryRequest(this.launch.workspaceId, state, attempt, assignment),
          ),
        );
        if (recovered === undefined) return undefined;
        yield* this.storeEffect((store) => store.recordWorker(attempt.id, recovered.identity));
        return recovered.identity;
      }.bind(this),
    );
  }

  private finishUnlaunchedCancellation(attemptId: string): RuntimeEffect<void> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const cancelled = findAttempt(yield* this.storeEffect((store) => store.load()), attemptId);
        yield* this.beginCleanupIfNeeded(cancelled);
        yield* this.storeEffect((store) => store.markWorkerClosed(attemptId));
        yield* this.cleanup(attemptId);
      }.bind(this),
    );
  }

  private cancelOwnedWorker(
    attemptId: string,
    state: WorkAttempt["state"],
    worker: WorkerIdentity | undefined,
  ): RuntimeEffect<void> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        let interruptionError: HerdrProtocolError | undefined;
        if (state !== "queued" && worker !== undefined)
          yield* this.herdrEffect((workers) => workers.interrupt(worker)).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                interruptionError = error;
              }),
            ),
          );
        const cancelled = findAttempt(yield* this.storeEffect((store) => store.load()), attemptId);
        if (cancelled.placement === undefined) return;
        yield* this.beginCleanupIfNeeded(cancelled);
        yield* this.cleanup(attemptId);
        const latest = findAttempt(yield* this.storeEffect((store) => store.load()), attemptId);
        if (interruptionError !== undefined && latest.cleanup?.state !== "completed")
          yield* this.recordAttemptFailure(attemptId, interruptionError);
      }.bind(this),
    );
  }
}

type EnqueuedAttempt = {
  id: string;
  models: NonNullable<WorkAttempt["models"]>;
  continuationOf?: string;
  baseRevision?: string;
};
type WorkerReport = Extract<WorkResult, { validity: "typed" }>["report"];

function implementationAttempt(
  policy: ModelPolicy,
  options: QueueOptions,
  baseRevision: string | undefined,
): EnqueuedAttempt {
  const guide = policy.roles["implementation.guide"];
  const hasGuideOverride = options.model !== undefined || options.thinking !== undefined;
  const hasExecutorOverride = options.executor !== undefined;
  const reason = options.modelReason?.trim() ?? "";
  if (hasGuideOverride && reason === "")
    throw new Error("An explicit worker model or thinking level requires a specific reason.");
  if (hasExecutorOverride && reason === "")
    throw new Error("An explicit executor target requires a specific reason.");
  const models = implementationModels(
    policy,
    options,
    guide,
    hasGuideOverride,
    hasExecutorOverride,
    reason,
  );
  const attempt: EnqueuedAttempt = { id: `attempt-${randomUUID()}`, models };
  if (options.continuationOf !== undefined) attempt.continuationOf = options.continuationOf;
  if (baseRevision !== undefined) attempt.baseRevision = baseRevision;
  return attempt;
}

function implementationModels(
  policy: ModelPolicy,
  options: QueueOptions,
  guide: ModelPolicy["roles"]["implementation.guide"],
  hasGuideOverride: boolean,
  hasExecutorOverride: boolean,
  reason: string,
): NonNullable<WorkAttempt["models"]> {
  const models: NonNullable<WorkAttempt["models"]> = {
    guide: hasGuideOverride
      ? {
          model: options.model ?? guide.model,
          thinking: options.thinking ?? guide.thinking,
        }
      : guide,
    executor: options.executor ?? policy.roles["implementation.executor"],
    source: hasGuideOverride || hasExecutorOverride ? "override" : "policy",
  };
  if (hasGuideOverride || hasExecutorOverride) models.overrideReason = reason;
  return models;
}

function selectedAttempts(
  capability: "research" | "review",
  policy: ModelPolicy,
  options: QueueOptions,
  baseRevision: string | undefined,
): EnqueuedAttempt[] {
  const request = options.selection === undefined ? {} : { ...options.selection };
  if (options.model !== undefined || options.thinking !== undefined) {
    const role = capability === "review" ? "review" : "research";
    request.override = {
      target: {
        model: options.model ?? policy.roles[role][0].model,
        thinking: options.thinking ?? policy.roles[role][0].thinking,
      },
      reason: options.modelReason ?? "",
    };
  }
  const selection = resolveSelection(capability, request, policy);
  if (selection.unfulfilled.length > 0) throw new Error(selection.unfulfilled.join(" "));
  return selection.selected.map((target, index) => {
    const attempt: EnqueuedAttempt = {
      id: `attempt-${randomUUID()}`,
      models: { guide: target, source: selection.source, selection },
    };
    if (index === 0 && options.continuationOf !== undefined)
      attempt.continuationOf = options.continuationOf;
    if (baseRevision !== undefined) attempt.baseRevision = baseRevision;
    return attempt;
  });
}

function blockedDetail(attempt: WorkAttempt): string | undefined {
  if (attempt.application?.state === "blocked") return attempt.application.error;
  if (attempt.cleanup?.state === "blocked") return attempt.cleanup.error;
  return undefined;
}
function requiresLaunch(attempt: WorkAttempt): boolean {
  return attempt.state === "queued";
}

/** A missing session checkpoint proves Herdr launch was never invoked by this sequence. */
function hasProvenNoNativeLaunch(attempt: WorkAttempt): boolean {
  return (
    attempt.sessionFile === undefined &&
    attempt.launchPane === undefined &&
    attempt.resource === undefined &&
    attempt.worker === undefined
  );
}
function hasRetainedSession(attempt: WorkAttempt): boolean {
  return (
    (attempt.state === "starting" ||
      attempt.state === "running" ||
      attempt.state === "cancel_requested") &&
    attempt.sessionFile !== undefined
  );
}
function workerRecoveryRequest(
  workspaceId: string,
  state: WorkstreamState,
  attempt: WorkAttempt,
  assignment: WorkAssignment,
): WorkerRecoveryRequest {
  const request: WorkerRecoveryRequest = {
    workspaceId,
    agentName: herdrWorkerName({
      runId: state.id,
      nodeId: attempt.id,
      attemptId: attempt.id,
      assignmentId: assignment.id,
      objective: assignment.objective,
      role: assignment.capability,
    }),
    compatibleAgentNames: [
      legacyObjectiveHerdrWorkerName({
        runId: state.id,
        nodeId: attempt.id,
        attemptId: attempt.id,
        assignmentId: assignment.id,
        objective: assignment.objective,
        role: assignment.capability,
      }),
      legacyHerdrAgentName(state.id, attempt.id, attempt.id),
    ],
    cwd: attempt.placement?.path ?? state.projectRoot,
    sessionFile: required(attempt.sessionFile, "session file"),
  };
  if (attempt.resource !== undefined) request.resource = attempt.resource;
  return request;
}
function workerSessionRequest(
  state: WorkstreamState,
  attempt: WorkAttempt,
  assignment: WorkAssignment,
  workerCwd: string,
  baseRevision: string | undefined,
): Parameters<typeof createWorkerSessionEffect>[0] {
  const request: Parameters<typeof createWorkerSessionEffect>[0] = {
    targetCwd: workerCwd,
    sessionDir: join(dirname(state.statePath), "sessions"),
    objective: objectiveFor(state, assignment, workerCwd, baseRevision),
    mode: modeFor(assignment),
    runId: state.id,
    nodeId: attempt.id,
  };
  if (attempt.continuationOf !== undefined)
    request.continuationSessionFile = required(
      findAttempt(state, attempt.continuationOf).sessionFile,
      "continuation session",
    );
  return request;
}
function workerLaunchRequest(
  workspaceId: string,
  state: WorkstreamState,
  attempt: WorkAttempt,
  assignment: WorkAssignment,
  cwd: string,
  sessionFile: string,
  models: NonNullable<WorkAttempt["models"]>,
  baseRevision: string | undefined,
  store: WorkstreamStoreEffects,
): WorkerLaunchEffectRequest<WorkstreamStoreError, FileSystem.FileSystem | Path.Path> {
  const environment = new Map<string, string>([
    ["PI_WORKGRAPH_MODE", modeFor(assignment)],
    ["PI_WORKGRAPH_RUN_ID", state.id],
    ["PI_WORKGRAPH_NODE_ID", attempt.id],
    ["PI_WORKGRAPH_REPOSITORY", state.projectRoot],
  ]);
  if (baseRevision !== undefined) environment.set("PI_WORKGRAPH_BASE_COMMIT", baseRevision);
  const { PI_CODING_AGENT_DIR: codingAgentDir } = process.env;
  if (codingAgentDir !== undefined && codingAgentDir !== "")
    environment.set("PI_CODING_AGENT_DIR", codingAgentDir);
  if (assignment.artifactIntent === "disposable_experiment")
    environment.set("PI_WORKGRAPH_EXPERIMENT", "1");
  if (models.executor !== undefined) {
    environment.set("PI_WORKGRAPH_IMPLEMENTATION_START", "guide");
    environment.set("PI_WORKGRAPH_EXECUTOR_MODEL", models.executor.model);
    environment.set("PI_WORKGRAPH_EXECUTOR_THINKING", models.executor.thinking);
  }
  const env = Object.fromEntries(environment);
  return {
    workspaceId,
    runId: state.id,
    nodeId: attempt.id,
    attemptId: attempt.id,
    assignmentId: assignment.id,
    objective: assignment.objective,
    role: assignment.capability,
    cwd,
    sessionFile,
    prompt: workerPrompt(state, assignment, cwd, baseRevision),
    model: models.guide.model,
    thinking: models.guide.thinking,
    env,
    onTab: (pane) => store.recordLaunchPane(attempt.id, pane).pipe(Effect.asVoid),
    onResource: (resource) => store.recordResource(attempt.id, resource).pipe(Effect.asVoid),
    onIdentity: (worker) =>
      store
        .recordWorker(attempt.id, worker)
        .pipe(Effect.andThen(store.markSubmission(attempt.id, "uncertain")), Effect.asVoid),
    onSubmitted: () => store.markSubmission(attempt.id, "submitted").pipe(Effect.asVoid),
  };
}
function isNoChangeImplementation(
  assignment: WorkAssignment,
  report: WorkerReport,
): report is Extract<
  WorkerReport,
  { kind: "implementation"; status: "completed"; outcome: "no_change" }
> {
  return (
    assignment.capability === "implement" &&
    report.kind === "implementation" &&
    report.status === "completed" &&
    report.outcome === "no_change"
  );
}
function validateExplicitApplication(
  state: WorkstreamState,
  attempt: WorkAttempt,
  assignment: WorkAssignment,
  reportedCommit: string,
  sourceCommit: string,
  current: boolean,
): void {
  if (state.lifecycle.state !== "active")
    throw new Error("Maintained output can be applied only while coordination is active.");
  if (assignment.capability !== "implement" || attempt.state !== "settled")
    throw new Error("Attempt is not settled maintained implementation output.");
  if (!current)
    throw new Error("Intent changed; retained implementation is stale and cannot be applied.");
  if (reportedCommit !== sourceCommit)
    throw new Error("Source commit does not exactly match the worker report.");
  if (attempt.application !== undefined)
    throw new Error("Application already has a recorded checkpoint; inspect it before recovery.");
}

function validApplicationCommit(result: WorkResult | undefined): string {
  if (
    result?.validity !== "typed" ||
    result.report.kind !== "implementation" ||
    result.report.status !== "completed" ||
    result.report.outcome !== "changed" ||
    result.report.commit === undefined ||
    result.report.commit === ""
  )
    throw new Error(
      "Application requires a completed changed implementation report's exact commit.",
    );
  return result.report.commit;
}

function placementOf(attempt: WorkAttempt): WorktreePlacement {
  const placement = required(attempt.placement, "attempt placement");
  if (placement.kind !== "isolated_worktree")
    throw new Error("Git worktree ownership is unavailable for shared placement.");
  return {
    path: placement.path,
    branch: placement.branch,
    baseCommit: required(attempt.baseRevision, "base"),
  };
}
function findAttempt(state: WorkstreamState, id: string): WorkAttempt {
  return required(
    state.attempts.find((item) => item.id === id),
    `attempt ${id}`,
  );
}
function findAssignment(state: WorkstreamState, id: string): WorkAssignment {
  return required(
    state.assignments.find((item) => item.id === id),
    `assignment ${id}`,
  );
}
function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}.`);
  return value;
}
function failureFromExit(exit: Exit.Exit<unknown, unknown>): Error | undefined {
  if (Exit.isSuccess(exit)) return undefined;
  const failure = Cause.squash(exit.cause);
  return failure instanceof Error ? failure : new Error(String(failure));
}
function absentResultDetail(failure: NativeFailureCategory | undefined): string {
  switch (failure) {
    case undefined:
      return "Pi settled without a current-attempt report.";
    case "provider-rate-limit":
      return "Pi settled without a current-attempt report after a provider rate limit.";
    case "native-abort":
      return "Pi settled without a current-attempt report after the native turn was aborted.";
    case "native-error":
      return "Pi settled without a current-attempt report after a native provider error.";
  }
}

function modeFor(assignment: WorkAssignment) {
  return assignment.capability === "implement"
    ? "implementation"
    : assignment.capability === "review"
      ? "review"
      : "research";
}
function workerPrompt(
  state: WorkstreamState,
  assignment: WorkAssignment,
  workerCwd: string,
  baseRevision?: string,
): string {
  const lines = [
    `Workgraph assignment ${assignment.id}.`,
    `Repository: ${state.projectRoot}`,
    `Assigned working directory: ${workerCwd}`,
  ];
  if (baseRevision !== undefined) lines.push(`Exact base/review revision: ${baseRevision}`);
  if (assignment.capability === "implement")
    lines.push(
      "For a changed result, use the assigned worktree, create exactly one direct commit on the exact base, and leave it clean; report that commit. For no change, report the unchanged exact base without a commit. Do not integrate into the coordinator repository or push; application remains a coordinator decision.",
    );
  if (assignment.capability === "review")
    lines.push(
      "Review only the assigned subject; an exact revision must be inspected as that revision, not as live files.",
    );
  lines.push("Continue the assigned Workgraph objective now.");
  return lines.join("\n");
}
function objectiveFor(
  state: WorkstreamState,
  assignment: WorkAssignment,
  workerCwd: string,
  baseRevision?: string,
): string {
  const intent = state.intents.find((item) => item.version === assignment.intentVersion);
  const common = [
    `Assignment: ${assignment.objective}`,
    `Intent version: ${assignment.intentVersion}`,
    `Repository: ${state.projectRoot}`,
    `Assigned working directory: ${workerCwd}`,
    `Constraints: ${intent?.constraints.join("; ") ?? ""}`,
  ];
  if (baseRevision !== undefined)
    common.push(
      `${assignment.capability === "implement" || assignment.artifactIntent === "disposable_experiment" ? "Exact isolated base revision" : "Exact requested Git revision"}: ${baseRevision}`,
    );
  if (assignment.capability === "research")
    common.push(`Expected evidence: ${assignment.expectedEvidence.join("; ")}`);
  if (assignment.artifactIntent === "disposable_experiment")
    common.push(
      `Permitted effects: ${assignment.permittedEffects.join("; ")}`,
      `Stop condition: ${assignment.stopCondition}`,
      "The complete isolated worktree is retained after completion until the coordinator explicitly releases it.",
      "Experimental changes are not maintained product changes and must not be committed for application.",
    );
  if (assignment.capability === "implement")
    common.push(
      `Acceptance: ${assignment.acceptance.join("; ")}`,
      "If a change is needed, create one clean maintained commit and report its exact commit for application. If the requirement already holds, verify it and report no_change with the inspected base revision and reason, without manufacturing an edit, commit, or executor turn.",
    );
  if (assignment.capability === "review") {
    common.push(
      `Concern: ${assignment.concern}`,
      `Subject: ${JSON.stringify(assignment.subject)}`,
      "Do not edit files.",
    );
    const subject = assignment.subject;
    if (subject.kind === "comparison")
      common.push(
        `Compared retained results: ${JSON.stringify(subject.resultIds.map((id) => state.results.find((item) => item.id === id)))}`,
      );
    else if (subject.kind !== "revision")
      common.push(
        `Retained result: ${JSON.stringify(state.results.find((item) => item.id === subject.resultId))}`,
      );
  }
  return common.join("\n");
}
