import { randomUUID } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Pi supplies Node filesystem promises as the concrete artifact-retention boundary.
import { access, cp, lstat, mkdir, realpath } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Git worktrees require the host's Node path semantics.
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  Cause,
  Clock,
  Data,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Queue,
  Ref,
  Schedule,
} from "effect";
import type { GitRepository, WorktreePlacement } from "./git.js";
import {
  herdrWorkerName,
  legacyHerdrAgentName,
  legacyObjectiveHerdrWorkerName,
  type VisibleWorkerRuntime,
  type WorkerLaunchRequest,
  type WorkerRecoveryRequest,
} from "./herdr.js";
import {
  loadModelPolicy,
  type ModelPolicy,
  resolveSelection,
  type SelectionRequest,
} from "./model-policy.js";
import {
  createWorkerSession,
  effectiveModelObservations,
  hasNativeAgentSettled,
  hasNativeAgentStarted,
  readTerminalText,
  readWorkgraphReportResult,
} from "./pi-process.js";
import { type Lease, type LeaseOwner, WorkgraphRegistry } from "./registry.js";
import type { ThinkingLevel } from "./types.js";
import type {
  RetainedArtifact,
  WorkAssignment,
  WorkAttempt,
  WorkResult,
  WorkstreamState,
  WorkstreamStore,
} from "./workstream.js";

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
}

export class RuntimeDependencyError extends Data.TaggedError("RuntimeDependencyError")<{
  readonly dependency: "store" | "git" | "herdr" | "pi" | "runtime";
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

class RuntimeStoppedError extends Data.TaggedError("RuntimeStoppedError")<{
  readonly message: string;
}> {}

type RuntimeError = RuntimeDependencyError | RuntimeStoppedError;
type OperationRequest =
  | { readonly _tag: "Operation"; readonly run: Effect.Effect<void, never> }
  | { readonly _tag: "Stop" };
type RuntimeLifecycle = "open" | "stopping" | "stopped";

/** One scoped, serialized execution owner backed by the registry's fenced lease. */
export class WorkstreamRuntime {
  private lease: Lease | undefined;
  private readonly deliveryOwner = randomUUID();
  private registry: WorkgraphRegistry | undefined;
  private readonly operations = Effect.runSync(Queue.unbounded<OperationRequest>());
  private readonly ready = Deferred.makeUnsafe<void, RuntimeError>();
  private readonly startRequested = Deferred.makeUnsafe<void>();
  private readonly applicationExit = Deferred.makeUnsafe<Exit.Exit<void, RuntimeError>>();
  private readonly lifecycle = Ref.makeUnsafe<RuntimeLifecycle>("open");
  private readonly effectRuntime = ManagedRuntime.make(Layer.empty);
  private policy: ModelPolicy | undefined;

  constructor(
    readonly store: WorkstreamStore,
    readonly repository: GitRepository,
    readonly workers: VisibleWorkerRuntime,
    readonly launch: WorkstreamLaunch,
    readonly onResult: (resultId: string, state: WorkstreamState) => void | Promise<void>,
    readonly onError: (error: Error) => void,
    ownership: RuntimeOwnership = {},
  ) {
    this.policy = ownership.policy;
    const application = ownership.clock
      ? Effect.provideService(this.application(ownership), Clock.Clock, ownership.clock)
      : this.application(ownership);
    this.effectRuntime.runFork(application);
  }

  private application(options: RuntimeOwnership): Effect.Effect<void, RuntimeError> {
    const owned = Effect.scoped(
      Effect.gen(
        function* (this: WorkstreamRuntime) {
          const registry = yield* Effect.acquireRelease(
            this.openRegistryEffect(options.registry),
            (opened) => this.closeRegistryEffect(opened, options.registry),
          );
          this.registry = registry;
          const lease = yield* Effect.acquireRelease(
            this.claimLeaseEffect(registry, options),
            (claimed) => this.releaseLeaseEffect(registry, claimed),
          );
          this.lease = lease;
          this.store.bindMutationGuard(() => this.assertOwnership());
          yield* this.adoptCoordinatorEffect(options);
          yield* Deferred.succeed(this.ready, undefined);
          yield* Effect.forkScoped(this.heartbeatLoop());
          yield* Effect.forkScoped(
            Deferred.await(this.startRequested).pipe(Effect.andThen(this.reconciliationLoop())),
          );
          yield* this.operationLoop();
        }.bind(this),
      ),
    );
    return owned.pipe(
      Effect.onExit((exit) =>
        Deferred.done(this.ready, exit).pipe(
          Effect.andThen(Ref.set(this.lifecycle, "stopped")),
          Effect.andThen(Deferred.succeed(this.applicationExit, exit)),
          Effect.asVoid,
        ),
      ),
    );
  }

  private openRegistryEffect(
    provided: WorkgraphRegistry | undefined,
  ): Effect.Effect<WorkgraphRegistry, RuntimeDependencyError> {
    return provided
      ? Effect.succeed(provided)
      : this.runtimeSync("open workstream registry", () => new WorkgraphRegistry());
  }

  private closeRegistryEffect(
    registry: WorkgraphRegistry,
    provided: WorkgraphRegistry | undefined,
  ): Effect.Effect<void> {
    return Effect.sync(() => {
      this.registry = undefined;
      if (provided === undefined) registry.close();
    });
  }

  private claimLeaseEffect(
    registry: WorkgraphRegistry,
    options: RuntimeOwnership,
  ): Effect.Effect<Lease, RuntimeDependencyError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const state = yield* this.dependency("store", "load for lease claim", () =>
          this.store.load(),
        );
        yield* this.runtimeSync("index workstream", () =>
          registry.indexWorkstream({
            ...state,
            runId: state.id,
            lifecycle: state.lifecycle.state,
          }),
        );
        const now = yield* DateTime.nowAsDate;
        return yield* this.runtimeSync("claim registry lease", () =>
          registry.acquire(
            state.id,
            options.owner ?? state.coordinator,
            now,
            options.priorOwnerLiveness ?? "unknown",
          ),
        );
      }.bind(this),
    );
  }

  private releaseLeaseEffect(registry: WorkgraphRegistry, lease: Lease): Effect.Effect<void> {
    return Effect.sync(() => {
      registry.release(lease);
      this.lease = undefined;
    });
  }

  private adoptCoordinatorEffect(
    options: RuntimeOwnership,
  ): Effect.Effect<void, RuntimeDependencyError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const state = yield* this.dependency("store", "load coordinator", () => this.store.load());
        const owner = options.owner ?? state.coordinator;
        if (
          owner.sessionId !== state.coordinator.sessionId ||
          owner.sessionFile !== state.coordinator.sessionFile
        ) {
          yield* this.dependency("store", "adopt coordinator", () => this.store.adopt(owner));
        }
      }.bind(this),
    );
  }

  private runtimeSync<A>(
    operation: string,
    run: () => A,
  ): Effect.Effect<A, RuntimeDependencyError> {
    return Effect.try({
      try: run,
      catch: (cause) =>
        new RuntimeDependencyError({
          dependency: "runtime",
          operation,
          cause,
        }),
    });
  }

  private dependency<A>(
    dependency: RuntimeDependencyError["dependency"],
    operation: string,
    run: () => PromiseLike<A>,
  ): Effect.Effect<A, RuntimeDependencyError> {
    return Effect.uninterruptible(
      Effect.tryPromise({
        try: run,
        catch: (cause) =>
          cause instanceof RuntimeDependencyError
            ? cause
            : new RuntimeDependencyError({ dependency, operation, cause }),
      }),
    );
  }

  private assertOwnership(): void {
    const registry = this.registry;
    if (!this.lease || !registry)
      throw new RuntimeStoppedError({
        message: "Workstream runtime is stopped or has no lease.",
      });
    registry.assertLease(this.lease);
  }

  private ownershipEffect(): Effect.Effect<void, RuntimeError> {
    return Effect.try({
      try: () => this.assertOwnership(),
      catch: (cause) =>
        cause instanceof RuntimeStoppedError
          ? cause
          : new RuntimeDependencyError({
              dependency: "runtime",
              operation: "assert registry lease",
              cause,
            }),
    });
  }

  private operationLoop(): Effect.Effect<void, never> {
    return Effect.suspend(() =>
      Queue.take(this.operations).pipe(
        Effect.flatMap((request) =>
          request._tag === "Stop"
            ? Effect.void
            : request.run.pipe(Effect.andThen(this.operationLoop())),
        ),
      ),
    );
  }

  private submit<T>(effect: Effect.Effect<T, RuntimeError>): Effect.Effect<T, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        yield* Deferred.await(this.ready);
        yield* this.acceptingEffect();
        const reply = yield* Deferred.make<T, RuntimeError>();
        const run = Effect.exit(this.ownershipEffect().pipe(Effect.andThen(effect))).pipe(
          Effect.flatMap((exit) => Deferred.done(reply, exit)),
          Effect.asVoid,
        );
        yield* Queue.offer(this.operations, { _tag: "Operation", run });
        return yield* Effect.raceFirst(
          Deferred.await(reply),
          Deferred.await(this.applicationExit).pipe(
            Effect.flatMap((exit) =>
              Exit.isFailure(exit)
                ? Effect.failCause(exit.cause)
                : Effect.fail(
                    new RuntimeStoppedError({
                      message: "Workstream runtime is stopped.",
                    }),
                  ),
            ),
          ),
        );
      }.bind(this),
    );
  }

  private acceptingEffect(): Effect.Effect<void, RuntimeStoppedError> {
    return Effect.flatMap(Ref.get(this.lifecycle), (state) =>
      state === "open"
        ? Effect.void
        : Effect.fail(
            new RuntimeStoppedError({
              message: "Workstream runtime is stopped.",
            }),
          ),
    );
  }

  private heartbeatLoop(): Effect.Effect<void, RuntimeError> {
    const heartbeat = Effect.try({
      try: () => {
        this.assertOwnership();
        const lease = this.lease;
        const registry = this.registry;
        if (!lease || !registry) throw new Error("Heartbeat has no lease.");
        this.lease = registry.renew(lease);
      },
      catch: (cause) =>
        new RuntimeDependencyError({
          dependency: "runtime",
          operation: "renew registry lease",
          cause,
        }),
    });
    return heartbeat.pipe(
      Effect.repeat(Schedule.spaced("5 seconds")),
      Effect.asVoid,
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.sync(() => {
            const failure = Cause.squash(cause);
            this.onError(failure instanceof Error ? failure : new Error(String(failure)));
          }).pipe(Effect.andThen(Queue.offer(this.operations, { _tag: "Stop" })), Effect.asVoid),
      ),
    );
  }

  private reconciliationLoop(): Effect.Effect<void, RuntimeError> {
    return Effect.sleep("1 second").pipe(
      Effect.andThen(this.submit(this.reconcileOperation())),
      Effect.tap(() => Effect.sync(() => (this.reconciliationError = undefined))),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => {
          const failure = Cause.squash(cause);
          const error = failure instanceof Error ? failure : new Error(String(failure));
          const detail = error.message;
          return Effect.sync(() => {
            if (detail !== this.reconciliationError) {
              this.reconciliationError = detail;
              this.onError(error);
            }
          });
        },
      ),
      Effect.repeat(Schedule.forever),
      Effect.asVoid,
    );
  }

  private reconciliationError: string | undefined;

  /** Pi's extension contract is Promise-based; internal work enters through this typed Effect boundary. */
  perform<T>(operation: () => Promise<T>): Promise<T> {
    return this.runPromise(this.submit(this.dependency("pi", "host operation", operation)));
  }

  start(): void {
    Deferred.doneUnsafe(this.startRequested, Effect.void);
  }

  stop(): Promise<void> {
    const previous = Effect.runSync(
      Ref.modify(
        this.lifecycle,
        (state) => [state, state === "open" ? "stopping" : state] as const,
      ),
    );
    if (previous === "stopped") return Promise.resolve();
    const waitForExit = Deferred.await(this.applicationExit).pipe(Effect.asVoid);
    const shutdown =
      previous === "open"
        ? Deferred.await(this.ready).pipe(
            Effect.matchEffect({
              onFailure: () => Effect.void,
              onSuccess: () => Queue.offer(this.operations, { _tag: "Stop" }),
            }),
            Effect.andThen(waitForExit),
          )
        : waitForExit;
    return this.runPromise(shutdown)
      .catch(() => undefined)
      .then(() => this.effectRuntime.dispose());
  }

  private runPromise<T, E>(effect: Effect.Effect<T, E>): Promise<T> {
    if (Ref.getUnsafe(this.lifecycle) === "stopped")
      return Promise.reject(new RuntimeStoppedError({ message: "Workstream runtime is stopped." }));
    return this.effectRuntime.runPromiseExit(effect).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      const failure = Cause.squash(exit.cause);
      throw failure instanceof Error ? failure : new Error(String(failure));
    });
  }

  queue(
    input: Parameters<WorkstreamStore["assign"]>[0],
    options: QueueOptions = {},
  ): Promise<WorkstreamState> {
    return this.runPromise(this.submit(this.queueEffect(input, options)));
  }

  private queueEffect(
    input: Parameters<WorkstreamStore["assign"]>[0],
    options: QueueOptions,
  ): Effect.Effect<WorkstreamState, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const policy =
          this.policy ?? (yield* this.dependency("runtime", "load model policy", loadModelPolicy));
        const baseRevision = yield* this.resolveQueueBaseEffect(input, options);
        const attempts = yield* this.runtimeSync("prepare queued attempt", () =>
          input.capability === "implement"
            ? implementationAttempt(policy, options, baseRevision)
            : selectedAttempts(input.capability, policy, options, baseRevision),
        );
        return yield* this.dependency("store", "enqueue assignment", () =>
          this.store.enqueue(input, attempts),
        );
      }.bind(this),
    );
  }

  private resolveQueueBaseEffect(
    input: Parameters<WorkstreamStore["assign"]>[0],
    options: QueueOptions,
  ): Effect.Effect<string | undefined, RuntimeError> {
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
            ? yield* this.dependency("git", "read queue base", () => this.repository.head())
            : undefined;
        const requested = options.baseRevision ?? subjectRevision ?? repositoryHead;
        return requested === undefined
          ? undefined
          : yield* this.dependency("git", "resolve queue base", () =>
              this.repository.resolveRevision(requested),
            );
      }.bind(this),
    );
  }

  private reconcileOperation(): Effect.Effect<WorkstreamState, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const initial = yield* this.dependency("store", "load reconciliation state", () =>
          this.store.load(),
        );
        if (initial.lifecycle.state !== "active" && initial.lifecycle.state !== "suspended")
          return initial;
        yield* Effect.forEach(initial.attempts, (attempt) => this.reconcileAttempt(attempt), {
          discard: true,
        });
        const state = yield* this.dependency("store", "load delivery state", () =>
          this.store.load(),
        );
        if (state.lifecycle.state === "active")
          yield* Effect.forEach(state.deliveries, (delivery) => this.reconcileDelivery(delivery), {
            discard: true,
          });
        return yield* this.dependency("store", "load reconciled state", () => this.store.load());
      }.bind(this),
    );
  }

  private reconcileAttempt(
    item: WorkstreamState["attempts"][number],
  ): Effect.Effect<void, RuntimeError> {
    const operation = Effect.gen(
      function* (this: WorkstreamRuntime) {
        // Cleanup is terminal; delivery is reconciled independently.
        if (item.cleanup?.state === "completed") {
          if (item.error !== undefined)
            yield* this.dependency("store", "clear terminal attention", () =>
              this.store.clearAttention(item.id),
            );
          return;
        }
        yield* this.advance(item.id);
        const state = yield* this.dependency("store", "load advanced attempt", () =>
          this.store.load(),
        );
        const advanced = findAttempt(state, item.id);
        const blocked = blockedDetail(advanced);
        if (blocked !== undefined)
          return yield* this.runtimeSync("validate advanced attempt", () => {
            throw new Error(blocked);
          });
        if (advanced.error !== undefined)
          yield* this.dependency("store", "clear attempt attention", () =>
            this.store.clearAttention(item.id),
          );
      }.bind(this),
    );
    return operation.pipe(Effect.catch((error) => this.recordAttemptFailure(item.id, error)));
  }

  private recordAttemptFailure(id: string, error: RuntimeError): Effect.Effect<void, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const latest = yield* this.dependency("store", "load failed attempt", () =>
          this.store.load(),
        );
        const attempt = findAttempt(latest, id);
        if (attempt.error === error.message) return;
        yield* this.dependency("store", "record attempt attention", () =>
          this.store.recordAttention(id, error.message),
        );
        yield* Effect.sync(() => this.onError(new Error(`Attempt ${id}: ${error.message}`)));
      }.bind(this),
    );
  }

  private reconcileDelivery(
    delivery: WorkstreamState["deliveries"][number],
  ): Effect.Effect<void, RuntimeError> {
    if (delivery.state !== "pending" || delivery.attemptedBy === this.deliveryOwner)
      return Effect.void;
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        yield* this.dependency("store", "record delivery attempt", () =>
          this.store.deliveryAttempt(delivery.resultId, this.deliveryOwner),
        );
        const latest = yield* this.dependency("store", "load result delivery payload", () =>
          this.store.load(),
        );
        const deliveryEffect = this.ownershipEffect().pipe(
          Effect.andThen(
            this.dependency("pi", "deliver retained result", () =>
              Promise.resolve(this.onResult(delivery.resultId, latest)),
            ),
          ),
          Effect.andThen(
            this.dependency("store", "mark result delivered", () =>
              this.store.markDelivered(delivery.resultId),
            ),
          ),
        );
        yield* deliveryEffect.pipe(
          Effect.catch((error) =>
            this.dependency("store", "record delivery failure", () =>
              this.store.deliveryAttempt(delivery.resultId, this.deliveryOwner, error.message),
            ),
          ),
        );
      }.bind(this),
    );
  }

  reconcile(): Promise<WorkstreamState> {
    return this.runPromise(this.submit(this.reconcileOperation()));
  }

  private advance(id: string): Effect.Effect<void, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const state = yield* this.dependency("store", "load attempt to advance", () =>
          this.store.load(),
        );
        const attempt = findAttempt(state, id);
        const assignment = findAssignment(state, attempt.assignmentId);
        if (attempt.cleanup?.state === "completed") return;
        if (requiresLaunch(attempt)) {
          if (state.lifecycle.state === "active")
            yield* this.launchAttempt(state, attempt, assignment);
          return;
        }
        if (hasRetainedSession(attempt)) yield* this.reconcileWorker(state, attempt, assignment);
        yield* this.advanceRetainedResult(id, assignment);
      }.bind(this),
    );
  }

  private reconcileWorker(
    state: WorkstreamState,
    initial: WorkAttempt,
    assignment: WorkAssignment,
  ): Effect.Effect<void, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const attempt =
          initial.worker === undefined
            ? yield* this.recoverWorker(state, initial, assignment)
            : initial;
        const worker = required(attempt.worker, "worker identity");
        const observation = yield* this.dependency("herdr", "observe worker", () =>
          this.workers.observe(worker),
        );
        const started = hasNativeAgentStarted(worker.sessionFile, state.id, attempt.id);
        if (started && attempt.submission !== "started")
          yield* this.dependency("store", "record native worker start", () =>
            this.store.markSubmission(attempt.id, "started"),
          );
        if (yield* this.resumeUnsentWorker(state, attempt, observation.status, started)) return;
        if (!hasNativeAgentSettled(worker.sessionFile, state.id, attempt.id)) {
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
  ): Effect.Effect<WorkAttempt, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        if (this.workers.recover === undefined)
          return yield* this.runtimeSync("validate worker recovery", () => {
            throw new Error("Worker transport cannot reconcile retained launch identity.");
          });
        const request = workerRecoveryRequest(this.launch.workspaceId, state, attempt, assignment);
        const recovered = yield* this.dependency(
          "herdr",
          "recover worker identity",
          () => this.workers.recover?.(request) ?? Promise.resolve(undefined),
        );
        if (recovered === undefined)
          return yield* this.runtimeSync("validate recovered worker", () => {
            throw new Error(
              "Retained launch has no proven live identity; inspect before replacing it.",
            );
          });
        yield* this.dependency("store", "record recovered worker", () =>
          this.store.recordWorker(attempt.id, recovered.identity),
        );
        const latest = yield* this.dependency("store", "reload recovered worker", () =>
          this.store.load(),
        );
        return findAttempt(latest, attempt.id);
      }.bind(this),
    );
  }

  private resumeUnsentWorker(
    state: WorkstreamState,
    attempt: WorkAttempt,
    status: Awaited<ReturnType<VisibleWorkerRuntime["observe"]>>["status"],
    started: boolean,
  ): Effect.Effect<boolean, RuntimeError> {
    if (attempt.submission !== "not_sent" || started || state.lifecycle.state !== "active")
      return Effect.succeed(false);
    if (this.workers.steer === undefined || (status !== "idle" && status !== "done"))
      return this.runtimeSync("validate retained submission", () => {
        throw new Error("Worker is not ready for the retained unsent objective.");
      });
    const worker = required(attempt.worker, "worker identity");
    return this.dependency("store", "mark submission uncertain", () =>
      this.store.markSubmission(attempt.id, "uncertain"),
    ).pipe(
      Effect.andThen(
        this.dependency(
          "herdr",
          "resume retained worker",
          () =>
            this.workers.steer?.(worker, "Continue the assigned Workgraph objective now.") ??
            Promise.resolve(),
        ),
      ),
      Effect.andThen(
        this.dependency("store", "mark submission sent", () =>
          this.store.markSubmission(attempt.id, "submitted"),
        ),
      ),
      Effect.as(true),
    );
  }

  private validateUnsettledWorker(
    attempt: WorkAttempt,
    status: Awaited<ReturnType<VisibleWorkerRuntime["observe"]>>["status"],
    started: boolean,
  ): Effect.Effect<void, RuntimeError> {
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

  private advanceRetainedResult(
    id: string,
    assignment: WorkAssignment,
  ): Effect.Effect<void, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        let state = yield* this.dependency("store", "load retained result", () =>
          this.store.load(),
        );
        let attempt = findAttempt(state, id);
        if (attempt.resultId === undefined) return;
        const result = state.results.find((item) => item.id === attempt.resultId);
        if (result === undefined)
          return yield* this.runtimeSync("validate retained result", () => {
            throw new Error("Retained attempt result is missing.");
          });
        if (!state.deliveries.some((delivery) => delivery.resultId === result.id))
          yield* this.dependency("store", "request result delivery", () =>
            this.store.requestDelivery(result.id),
          );
        yield* this.runtimeSync("validate implementation result", () =>
          validateImplementationResult(assignment, result),
        );
        if (shouldCompose(assignment, attempt, result)) {
          if (state.lifecycle.state !== "active") return;
          yield* this.compose(state, attempt, assignment);
        }
        state = yield* this.dependency("store", "reload cleanup state", () => this.store.load());
        attempt = findAttempt(state, id);
        yield* this.beginCleanupIfNeeded(attempt, assignment);
        yield* this.cleanup(id);
      }.bind(this),
    );
  }

  private beginCleanupIfNeeded(
    attempt: WorkAttempt,
    assignment: WorkAssignment,
  ): Effect.Effect<void, RuntimeError> {
    if (attempt.cleanup !== undefined || attempt.placement === undefined) return Effect.void;
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const input: Parameters<WorkstreamStore["beginCleanup"]>[0] = {
          id: attempt.id,
          discard: assignment.artifactIntent === "disposable_experiment",
        };
        if (attempt.placement?.kind === "isolated_worktree")
          input.expectedHead = yield* this.dependency("git", "read cleanup head", () =>
            this.repository.head(attempt.placement?.path),
          );
        yield* this.dependency("store", "begin attempt cleanup", () =>
          this.store.beginCleanup(input),
        );
      }.bind(this),
    );
  }

  private launchAttempt(
    state: WorkstreamState,
    attempt: WorkAttempt,
    assignment: WorkAssignment,
  ): Effect.Effect<void, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const isolated =
          assignment.capability === "implement" ||
          assignment.artifactIntent === "disposable_experiment";
        const baseRevision = attempt.baseRevision;
        const placement = isolated
          ? yield* this.dependency("git", "create worker worktree", () =>
              this.repository.createWorktree(
                state.id,
                attempt.id,
                required(baseRevision, "base revision"),
              ),
            )
          : undefined;
        const workerCwd = placement?.path ?? this.repository.root;
        const start: Parameters<WorkstreamStore["startAttempt"]>[0] = {
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
        yield* this.dependency("store", "start worker attempt", () =>
          this.store.startAttempt(start),
        );
        const sessionRequest = workerSessionRequest(
          state,
          attempt,
          assignment,
          workerCwd,
          baseRevision,
        );
        const sessionFile = yield* this.dependency("pi", "create worker session", () =>
          createWorkerSession(sessionRequest),
        );
        yield* this.dependency("store", "record worker session", () =>
          this.store.recordSessionFile(attempt.id, sessionFile),
        );
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
        yield* this.dependency("herdr", "launch worker", () => this.workers.launch(request));
      }.bind(this),
    );
  }

  private retain(
    state: WorkstreamState,
    attempt: WorkAttempt,
    assignment: WorkAssignment,
  ): Effect.Effect<void, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const sessionFile = required(attempt.sessionFile, "session");
        const generation = { runId: state.id, nodeId: attempt.id };
        // Keep the opaque result identity stable across a crash between retention and settlement.
        const resultId = attempt.resultId ?? `result-${attempt.id}`;
        if (!state.results.some((item) => item.id === resultId))
          yield* this.retainNewResult(state, attempt, assignment, sessionFile, resultId);
        const effectiveModels = yield* this.runtimeSync("read effective model observations", () =>
          effectiveModelObservations(sessionFile, generation),
        );
        yield* this.dependency("store", "settle worker attempt", () =>
          this.store.settleAttempt({ id: attempt.id, resultId, effectiveModels }),
        );
        yield* this.dependency("store", "request retained result delivery", () =>
          this.store.requestDelivery(resultId),
        );
      }.bind(this),
    );
  }

  private retainNewResult(
    state: WorkstreamState,
    attempt: WorkAttempt,
    assignment: WorkAssignment,
    sessionFile: string,
    resultId: string,
  ): Effect.Effect<void, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const generation = { runId: state.id, nodeId: attempt.id };
        const read = yield* this.runtimeSync("read worker report", () =>
          readWorkgraphReportResult(sessionFile, generation),
        );
        const base = {
          id: resultId,
          assignmentId: assignment.id,
          assignmentIntentVersion: assignment.intentVersion,
        };
        if (read.report !== undefined && read.report.kind === modeFor(assignment)) {
          yield* this.retainTypedResult(state, attempt, assignment, base, read.report);
          return;
        }
        if (read.report !== undefined || read.invalid || read.unreadable) {
          yield* this.dependency("store", "retain invalid worker result", () =>
            this.store.retainResult({
              ...base,
              validity: "invalid",
              detail:
                read.error ?? "Worker report kind does not match the assigned responsibility.",
            }),
          );
          return;
        }
        const text = yield* this.runtimeSync("read terminal worker text", () =>
          readTerminalText(sessionFile, generation),
        );
        yield* this.dependency("store", "retain untyped worker result", () =>
          text === undefined || text === ""
            ? this.store.retainResult({
                ...base,
                validity: "absent",
                detail: "Pi settled without a current-attempt report.",
              })
            : this.store.retainResult({ ...base, validity: "untyped", text }),
        );
      }.bind(this),
    );
  }

  private retainTypedResult(
    state: WorkstreamState,
    attempt: WorkAttempt,
    assignment: WorkAssignment,
    base: { id: string; assignmentId: string; assignmentIntentVersion: number },
    report: NonNullable<ReturnType<typeof readWorkgraphReportResult>["report"]>,
  ): Effect.Effect<void, RuntimeError> {
    const retention = Effect.gen(
      function* (this: WorkstreamRuntime) {
        if (isNoChangeImplementation(assignment, report))
          yield* this.dependency("git", "validate no-change worker", () =>
            this.repository.validateWorkerNoChange(placementOf(attempt), report.revision),
          );
        const artifacts =
          assignment.artifactIntent === "disposable_experiment"
            ? yield* this.retainExperiment(
                state,
                assignment,
                attempt,
                base.id,
                report.status === "completed",
              )
            : [];
        yield* this.dependency("store", "retain typed worker result", () =>
          this.store.retainResult({
            ...base,
            validity: "typed",
            report,
            artifacts,
          }),
        );
      }.bind(this),
    );
    return retention.pipe(
      Effect.catch((error) =>
        this.retainFailedResult(attempt, base, isNoChangeImplementation(assignment, report), error),
      ),
    );
  }

  private retainFailedResult(
    attempt: WorkAttempt,
    base: { id: string; assignmentId: string; assignmentIntentVersion: number },
    noChangeValidation: boolean,
    error: RuntimeError,
  ): Effect.Effect<void, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        yield* this.dependency("store", "retain failed worker result", () =>
          this.store.retainResult({
            ...base,
            validity: "invalid",
            detail: `${noChangeValidation ? "No-change validation failed" : "Artifact retention failed"}: ${error.message}`,
          }),
        );
        const cleanup: Parameters<WorkstreamStore["beginCleanup"]>[0] = {
          id: attempt.id,
          discard: false,
        };
        if (attempt.placement?.kind === "isolated_worktree")
          cleanup.expectedHead = yield* this.dependency("git", "read failed retention head", () =>
            this.repository.head(attempt.placement?.path),
          );
        yield* this.dependency("store", "begin blocked retention cleanup", () =>
          this.store.beginCleanup(cleanup),
        );
        yield* this.dependency("store", "block failed retention cleanup", () =>
          this.store.blockCleanup(attempt.id, error.message),
        );
      }.bind(this),
    );
  }

  private compose(
    state: WorkstreamState,
    attempt: WorkAttempt,
    assignment: WorkAssignment,
  ): Effect.Effect<void, RuntimeError> {
    if (attempt.composition?.state === "blocked") return Effect.void;
    if (attempt.composition?.state === "composed")
      return this.recordCompositionArtifact(
        attempt,
        required(attempt.composition.revision, "composed revision"),
        `Composed ${attempt.composition.commit}.`,
      );
    const result = state.results.find((item) => item.id === attempt.resultId);
    const commit = validCompositionCommit(result);
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const expectedHead =
          attempt.composition?.expectedHead ??
          (yield* this.dependency("git", "read composition head", () => this.repository.head()));
        const operation = this.applyComposition(attempt, assignment, commit, expectedHead);
        yield* operation.pipe(
          Effect.catch((error) => this.recoverComposition(attempt, commit, expectedHead, error)),
        );
      }.bind(this),
    );
  }

  private applyComposition(
    attempt: WorkAttempt,
    assignment: WorkAssignment,
    commit: string,
    expectedHead: string,
  ): Effect.Effect<void, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        if (attempt.composition === undefined) {
          yield* this.dependency("git", "validate worker commit", () =>
            this.repository.validateWorkerCommit(placementOf(attempt), commit),
          );
          yield* this.dependency("store", "begin composition", () =>
            this.store.beginComposition({ id: attempt.id, commit, expectedHead }),
          );
        }
        const state = yield* this.dependency("store", "load composition intent", () =>
          this.store.load(),
        );
        yield* this.runtimeSync("validate current composition intent", () => {
          if (!this.store.isAssignmentCurrent(state, assignment.id))
            throw new Error("Intent changed; retained implementation is stale and cannot compose.");
        });
        yield* this.ownershipEffect();
        const recovery = yield* this.dependency("git", "inspect composition", () =>
          this.repository.recoverComposition(expectedHead, {
            baseCommit: required(attempt.baseRevision, "base revision"),
            commit,
          }),
        );
        const revision =
          recovery?.head ??
          (yield* this.dependency("git", "compose worker commit", () =>
            this.repository.compose(commit, expectedHead),
          ));
        yield* this.dependency("store", "finish composition", () =>
          this.store.finishComposition(attempt.id, revision),
        );
        yield* this.recordCompositionArtifact(attempt, revision, `Composed ${commit}.`);
      }.bind(this),
    );
  }

  private recoverComposition(
    attempt: WorkAttempt,
    commit: string,
    expectedHead: string,
    originalError: RuntimeError,
  ): Effect.Effect<void, RuntimeError> {
    // A command or persistence error can occur after Git changed HEAD. Inspect before retry.
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const recovered = yield* this.dependency("git", "recover failed composition", () =>
          this.repository.recoverComposition(expectedHead, {
            baseCommit: required(attempt.baseRevision, "base revision"),
            commit,
          }),
        ).pipe(Effect.catch(() => Effect.void));
        if (recovered === undefined) {
          yield* this.dependency("store", "block failed composition", () =>
            this.store.blockComposition(attempt.id, originalError.message),
          );
          return;
        }
        yield* this.dependency("store", "finish recovered composition", () =>
          this.store.finishComposition(attempt.id, recovered.head),
        );
        yield* this.recordCompositionArtifact(
          attempt,
          recovered.head,
          `Recovered composition of ${commit}.`,
        );
      }.bind(this),
    );
  }

  private recordCompositionArtifact(
    attempt: WorkAttempt,
    revision: string,
    summary: string,
  ): Effect.Effect<void, RuntimeError> {
    return this.dependency("store", "record composition artifact", () =>
      this.store.addResultArtifacts(required(attempt.resultId, "result"), [
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

  private retainExperiment(
    state: WorkstreamState,
    assignment: Extract<WorkAssignment, { artifactIntent: "disposable_experiment" }>,
    attempt: WorkAttempt,
    resultId: string,
    successful: boolean,
  ): Effect.Effect<RetainedArtifact[], RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const placement = required(
          attempt.placement?.kind === "isolated_worktree" ? attempt.placement.path : undefined,
          "experiment worktree",
        );
        const root = yield* this.dependency("runtime", "resolve experiment root", () =>
          realpath(placement),
        );
        const destination = join(dirname(state.statePath), "artifacts", resultId);
        const retained = yield* Effect.forEach(assignment.artifactPolicy.retain, (name) =>
          this.retainExperimentArtifact(root, destination, name, successful),
        );
        return retained.filter((artifact): artifact is RetainedArtifact => artifact !== undefined);
      }.bind(this),
    );
  }

  private retainExperimentArtifact(
    root: string,
    destination: string,
    name: string,
    successful: boolean,
  ): Effect.Effect<RetainedArtifact | undefined, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        yield* this.runtimeSync("validate experiment artifact name", () => {
          if (name.trim() === "" || name.split(/[\\/]/).includes(".git") || name === ".")
            throw new Error("Artifact must name a non-metadata path within the experiment.");
        });
        const source = resolve(root, name);
        const target = resolve(destination, name);
        const exists = yield* this.artifactExists(source, successful);
        if (!exists) return undefined;
        const realSource = yield* this.dependency("runtime", "resolve experiment artifact", () =>
          realpath(source),
        );
        yield* this.runtimeSync("validate experiment artifact path", () => {
          if (!within(root, source) || !within(destination, target) || !within(root, realSource))
            throw new Error(`Experiment artifact escapes its workspace: ${name}.`);
        });
        yield* this.dependency("runtime", "create artifact destination", () =>
          mkdir(dirname(target), { recursive: true }),
        );
        yield* this.dependency("runtime", "copy experiment artifact", () =>
          cp(source, target, {
            recursive: true,
            force: true,
            filter: (path) =>
              lstat(path)
                .then((status) => {
                  if (status.isSymbolicLink())
                    throw new Error(`Symlink artifact is not retained: ${path}.`);
                  return realpath(path);
                })
                .then((resolvedPath) => {
                  if (!within(root, resolvedPath))
                    throw new Error("Artifact escaped the experiment.");
                  return true;
                }),
          }),
        );
        const artifact: RetainedArtifact = {
          id: name,
          kind: "path",
          reference: target,
          retention: "retained",
          summary: "Retained from authorized disposable experiment before cleanup.",
        };
        return artifact;
      }.bind(this),
    );
  }

  private artifactExists(
    source: string,
    successful: boolean,
  ): Effect.Effect<boolean, RuntimeError> {
    return this.dependency("runtime", "access experiment artifact", () => access(source)).pipe(
      Effect.as(true),
      Effect.catch((error) => {
        const cause = error.cause;
        return !successful && cause instanceof Error && "code" in cause && cause.code === "ENOENT"
          ? Effect.succeed(false)
          : Effect.fail(error);
      }),
    );
  }

  private cleanup(id: string): Effect.Effect<void, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const state = yield* this.dependency("store", "load cleanup state", () =>
          this.store.load(),
        );
        const attempt = findAttempt(state, id);
        const cleanup = attempt.cleanup;
        if (cleanup?.state !== "pending" || attempt.composition?.state === "blocked") return;
        const operation = this.cleanupAttempt(attempt, cleanup);
        yield* operation.pipe(
          Effect.catch((error) =>
            this.dependency("store", "block attempt cleanup", () =>
              this.store.blockCleanup(id, error.message),
            ),
          ),
        );
      }.bind(this),
    );
  }

  private cleanupAttempt(
    attempt: WorkAttempt,
    cleanup: NonNullable<WorkAttempt["cleanup"]>,
  ): Effect.Effect<void, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        if (!cleanup.workerClosed) {
          const result = yield* this.dependency("herdr", "cleanup worker", () =>
            this.workers.cleanup === undefined
              ? Promise.reject(new Error("Worker cleanup is not proven complete."))
              : this.workers.cleanup(required(attempt.worker, "worker identity")),
          );
          if (result.state === "pending") return;
          if (result.state !== "completed")
            return yield* this.runtimeSync("validate worker cleanup result", () => {
              throw new Error(result.detail ?? "Worker cleanup is not proven complete.");
            });
          yield* this.dependency("store", "mark worker closed", () =>
            this.store.markWorkerClosed(attempt.id),
          );
        }
        yield* this.ownershipEffect();
        yield* this.cleanupPlacement(attempt, cleanup);
        yield* this.dependency("store", "finish attempt cleanup", () =>
          this.store.finishCleanup(attempt.id),
        );
      }.bind(this),
    );
  }

  private cleanupPlacement(
    attempt: WorkAttempt,
    cleanup: NonNullable<WorkAttempt["cleanup"]>,
  ): Effect.Effect<void, RuntimeError> {
    if (attempt.placement?.kind !== "isolated_worktree")
      return this.runtimeSync("validate shared cleanup", () => {
        if (cleanup.discard) throw new Error("Shared project cleanup cannot discard files.");
      });
    const placement = placementOf(attempt);
    const expectedHead = required(cleanup.expectedHead, "expected worktree HEAD");
    const discard = cleanup.discard
      ? this.dependency("git", "discard experiment", () =>
          this.repository.discardExperiment(placement, expectedHead),
        )
      : Effect.void;
    return discard.pipe(
      Effect.andThen(
        this.dependency("git", "cleanup worktree", () =>
          this.repository.cleanupWorktree(placement, expectedHead),
        ),
      ),
    );
  }

  recoverAttempt(input: {
    attemptId: string;
    action: "retry" | "retain_not_applied";
    reason: string;
    integratedRevision?: string;
  }): Promise<WorkstreamState> {
    return this.runPromise(this.submit(this.recoverAttemptEffect(input)));
  }

  private recoverAttemptEffect(input: {
    attemptId: string;
    action: "retry" | "retain_not_applied";
    reason: string;
    integratedRevision?: string;
  }): Effect.Effect<WorkstreamState, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        yield* this.runtimeSync("validate recovery request", () => {
          if (input.reason.trim() === "") throw new Error("Recovery reason is required.");
          if (input.action === "retain_not_applied" && input.integratedRevision === undefined)
            throw new Error("Retained-not-applied recovery requires the integrated revision.");
        });
        const state = yield* this.dependency("store", "load recovery state", () =>
          this.store.load(),
        );
        const attempt = findAttempt(state, input.attemptId);
        if (attempt.composition?.state === "blocked")
          yield* this.recoverBlockedComposition(state, attempt, input);
        else if (attempt.cleanup?.state === "blocked") yield* this.recoverBlockedCleanup(attempt);
        else
          yield* this.runtimeSync("validate recovery boundary", () => {
            throw new Error(`Attempt ${attempt.id} has no blocked recovery boundary.`);
          });
        return yield* this.dependency("store", "load recovered state", () => this.store.load());
      }.bind(this),
    );
  }

  private recoverBlockedComposition(
    state: WorkstreamState,
    attempt: WorkAttempt,
    input: {
      action: "retry" | "retain_not_applied";
      reason: string;
      integratedRevision?: string;
    },
  ): Effect.Effect<void, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const composition = required(attempt.composition, "blocked composition");
        const worker = required(attempt.worker, "worker identity");
        yield* this.inspectRecoverableWorker(worker);
        yield* this.dependency("git", "assert clean recovery repository", () =>
          this.repository.assertClean(),
        );
        yield* this.dependency("git", "validate retained worker commit", () =>
          this.repository.validateWorkerCommit(placementOf(attempt), composition.commit),
        );
        yield* this.ownershipEffect();
        const retainedRef = yield* this.dependency("git", "retain worker commit", () =>
          this.repository.retainCommit(state.id, attempt.id, composition.commit),
        );
        yield* this.runtimeSync("validate retained commit provenance", () => {
          if (composition.retainedRef !== undefined && composition.retainedRef !== retainedRef)
            throw new Error(
              `Retained ref provenance changed from ${composition.retainedRef} to ${retainedRef}.`,
            );
        });
        if (input.action === "retry")
          yield* this.retryBlockedComposition(
            attempt,
            findAssignment(state, attempt.assignmentId),
            retainedRef,
          );
        else yield* this.retainBlockedComposition(attempt, input, retainedRef);
      }.bind(this),
    );
  }

  private retryBlockedComposition(
    attempt: WorkAttempt,
    assignment: WorkAssignment,
    retainedRef: string,
  ): Effect.Effect<void, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        yield* this.dependency("store", "retry blocked composition", () =>
          this.store.retryComposition(attempt.id, undefined, retainedRef),
        );
        let state = yield* this.dependency("store", "load retried composition", () =>
          this.store.load(),
        );
        yield* this.compose(state, findAttempt(state, attempt.id), assignment);
        state = yield* this.dependency("store", "load composed recovery", () => this.store.load());
        yield* this.beginCleanupIfNeeded(findAttempt(state, attempt.id), assignment);
        yield* this.cleanup(attempt.id);
      }.bind(this),
    );
  }

  private retainBlockedComposition(
    attempt: WorkAttempt,
    input: { reason: string; integratedRevision?: string },
    retainedRef: string,
  ): Effect.Effect<void, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const requested = required(input.integratedRevision, "integrated revision");
        const integratedRevision = yield* this.dependency(
          "git",
          "resolve integrated revision",
          () => this.repository.resolveRevision(requested),
        );
        const currentHead = yield* this.dependency("git", "read integrated head", () =>
          this.repository.head(),
        );
        yield* this.runtimeSync("validate integrated revision", () => {
          if (currentHead !== integratedRevision)
            throw new Error(
              `Integrated revision is ${integratedRevision}, but repository HEAD is ${currentHead}.`,
            );
        });
        yield* this.dependency("store", "retain unapplied composition", () =>
          this.store.retainCompositionNotApplied({
            id: attempt.id,
            reason: input.reason,
            retainedRef,
            integratedRevision,
          }),
        );
        const state = yield* this.dependency("store", "load retained composition", () =>
          this.store.load(),
        );
        const latest = findAttempt(state, attempt.id);
        if (latest.cleanup === undefined) {
          const expectedHead = yield* this.dependency("git", "read recovery worktree head", () =>
            this.repository.head(placementOf(attempt).path),
          );
          yield* this.dependency("store", "begin retained recovery cleanup", () =>
            this.store.beginCleanup({
              id: attempt.id,
              expectedHead,
              discard: false,
            }),
          );
        }
        yield* this.cleanup(attempt.id);
      }.bind(this),
    );
  }

  private recoverBlockedCleanup(attempt: WorkAttempt): Effect.Effect<void, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        if (attempt.cleanup?.workerClosed !== true)
          yield* this.inspectRecoverableWorker(required(attempt.worker, "worker identity"));
        yield* this.dependency("store", "retry blocked cleanup", () =>
          this.store.retryCleanup(attempt.id),
        );
        yield* this.cleanup(attempt.id);
      }.bind(this),
    );
  }

  private inspectRecoverableWorker(
    worker: NonNullable<WorkAttempt["worker"]>,
  ): Effect.Effect<void, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const inspection = yield* this.dependency("herdr", "inspect recovery worker", () =>
          this.workers.inspect(worker),
        );
        yield* this.runtimeSync("validate recovery inspection", () => {
          if (
            inspection.status !== "absent" &&
            inspection.status !== "idle" &&
            inspection.status !== "done"
          )
            throw new Error(
              `Recovery inspected worker ${inspection.status}; leave resources intact.`,
            );
        });
      }.bind(this),
    );
  }

  steer(attemptId: string, instruction: string): Promise<void> {
    return this.runPromise(this.submit(this.steerEffect(attemptId, instruction)));
  }

  private steerEffect(attemptId: string, instruction: string): Effect.Effect<void, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const state = yield* this.dependency("store", "load steerable attempt", () =>
          this.store.load(),
        );
        const attempt = findAttempt(state, attemptId);
        yield* this.runtimeSync("validate steering request", () => {
          if (instruction.trim() === "") throw new Error("Steering instruction is required.");
          if (
            attempt.worker === undefined ||
            (attempt.state !== "running" && attempt.state !== "starting") ||
            this.workers.steer === undefined
          )
            throw new Error("Attempt has no steerable live worker.");
        });
        const worker = required(attempt.worker, "worker identity");
        yield* this.dependency("store", "record uncertain steering", () =>
          this.store.recordSteering(attemptId, instruction, "uncertain"),
        );
        yield* this.dependency(
          "herdr",
          "steer worker",
          () => this.workers.steer?.(worker, instruction) ?? Promise.resolve(),
        );
        yield* this.dependency("store", "record submitted steering", () =>
          this.store.recordSteering(attemptId, instruction, "submitted"),
        );
      }.bind(this),
    );
  }

  cancel(attemptId: string): Promise<void> {
    return this.runPromise(this.submit(this.cancelEffect(attemptId)));
  }

  private cancelEffect(attemptId: string): Effect.Effect<void, RuntimeError> {
    return Effect.gen(
      function* (this: WorkstreamRuntime) {
        const state = yield* this.dependency("store", "load cancellable attempt", () =>
          this.store.load(),
        );
        const attempt = findAttempt(state, attemptId);
        if (attempt.state !== "queued")
          yield* this.runtimeSync("validate cancellation request", () => {
            if (attempt.state !== "running" && attempt.state !== "starting")
              throw new Error("Attempt is not active.");
          });
        yield* this.dependency("store", "cancel attempt", () =>
          this.store.cancelAttempt(attemptId),
        );
        if (attempt.state !== "queued" && attempt.worker !== undefined)
          yield* this.dependency("herdr", "interrupt cancelled worker", () =>
            this.workers.interrupt(required(attempt.worker, "worker identity")),
          );
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
        model: options.model ?? policy.roles[role].model,
        thinking: options.thinking ?? policy.roles[role].thinking,
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
  if (attempt.composition?.state === "blocked") return attempt.composition.error;
  if (attempt.cleanup?.state === "blocked") return attempt.cleanup.error;
  return undefined;
}
function requiresLaunch(attempt: WorkAttempt): boolean {
  return (
    attempt.state === "queued" ||
    (attempt.state === "starting" && attempt.sessionFile === undefined)
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
function validateImplementationResult(assignment: WorkAssignment, result: WorkResult): void {
  if (
    assignment.capability === "implement" &&
    (result.validity !== "typed" || result.report.status !== "completed")
  )
    throw new Error(
      "Implementation did not produce valid successful evidence; retain its workspace for inspection.",
    );
}
function shouldCompose(
  assignment: WorkAssignment,
  attempt: WorkAttempt,
  result: WorkResult,
): boolean {
  return (
    assignment.capability === "implement" &&
    result.validity === "typed" &&
    result.report.kind === "implementation" &&
    result.report.status === "completed" &&
    result.report.outcome === "changed" &&
    attempt.state !== "cancelled" &&
    attempt.composition?.state !== "retained_not_applied"
  );
}
function workerSessionRequest(
  state: WorkstreamState,
  attempt: WorkAttempt,
  assignment: WorkAssignment,
  workerCwd: string,
  baseRevision: string | undefined,
): Parameters<typeof createWorkerSession>[0] {
  const request: Parameters<typeof createWorkerSession>[0] = {
    targetCwd: workerCwd,
    sessionDir: join(dirname(state.statePath), "sessions"),
    objective: objectiveFor(state, assignment, baseRevision),
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
  store: WorkstreamStore,
): WorkerLaunchRequest {
  const environment = new Map<string, string>([
    ["PI_WORKGRAPH_MODE", modeFor(assignment)],
    ["PI_WORKGRAPH_RUN_ID", state.id],
    ["PI_WORKGRAPH_NODE_ID", attempt.id],
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
    prompt: "Continue the assigned Workgraph objective now.",
    model: models.guide.model,
    thinking: models.guide.thinking,
    env,
    onTab: (pane) => store.recordLaunchPane(attempt.id, pane).then(() => undefined),
    onResource: (resource) => store.recordResource(attempt.id, resource).then(() => undefined),
    onIdentity: (worker) =>
      store
        .recordWorker(attempt.id, worker)
        .then(() => store.markSubmission(attempt.id, "uncertain"))
        .then(() => undefined),
    onSubmitted: () => store.markSubmission(attempt.id, "submitted").then(() => undefined),
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
function validCompositionCommit(result: WorkResult | undefined): string {
  if (
    result?.validity !== "typed" ||
    result.report.kind !== "implementation" ||
    result.report.status !== "completed" ||
    result.report.outcome !== "changed" ||
    result.report.commit === undefined ||
    result.report.commit === ""
  )
    throw new Error(
      "Composition requires a completed changed implementation report's exact commit.",
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
function within(root: string, path: string): boolean {
  const part = relative(resolve(root), resolve(path));
  return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !part.startsWith(sep);
}
function modeFor(assignment: WorkAssignment) {
  return assignment.capability === "implement"
    ? "implementation"
    : assignment.capability === "review"
      ? "review"
      : "research";
}
function objectiveFor(
  state: WorkstreamState,
  assignment: WorkAssignment,
  baseRevision?: string,
): string {
  const intent = state.intents.find((item) => item.version === assignment.intentVersion);
  const common = [
    `Assignment: ${assignment.objective}`,
    `Intent version: ${assignment.intentVersion}`,
    `Constraints: ${intent?.constraints.join("; ") ?? ""}`,
  ];
  if (baseRevision !== undefined)
    common.push(
      `${assignment.capability === "implement" || assignment.artifactIntent === "disposable_experiment" ? "Isolated base revision" : "Requested Git revision evidence"}: ${baseRevision}`,
    );
  if (assignment.capability === "research")
    common.push(`Expected evidence: ${assignment.expectedEvidence.join("; ")}`);
  if (assignment.artifactIntent === "disposable_experiment")
    common.push(
      `Permitted effects: ${assignment.permittedEffects.join("; ")}`,
      `Stop condition: ${assignment.stopCondition}`,
      `Retain isolated-worktree-relative artifacts: ${assignment.artifactPolicy.retain.join(", ") || "none"}.`,
      "Experimental changes are not maintained product changes and must not be committed for composition.",
    );
  if (assignment.capability === "implement")
    common.push(
      `Acceptance: ${assignment.acceptance.join("; ")}`,
      "If a change is needed, create one clean maintained commit and report its exact commit for composition. If the requirement already holds, verify it and report no_change with the inspected base revision and reason, without manufacturing an edit, commit, or executor turn.",
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
