import { randomUUID } from "node:crypto";
import { access, cp, lstat, mkdir, realpath } from "node:fs/promises";
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

export class RuntimeDependencyError extends Data.TaggedError(
  "RuntimeDependencyError",
)<{
  readonly dependency: "store" | "git" | "herdr" | "pi" | "runtime";
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return asError(this.cause).message;
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
  private readonly operations = Effect.runSync(
    Queue.unbounded<OperationRequest>(),
  );
  private readonly ready = Deferred.makeUnsafe<void, RuntimeError>();
  private readonly startRequested = Deferred.makeUnsafe<void>();
  private readonly applicationExit = Deferred.makeUnsafe<
    Exit.Exit<void, RuntimeError>
  >();
  private readonly lifecycle = Ref.makeUnsafe<RuntimeLifecycle>("open");
  private readonly effectRuntime = ManagedRuntime.make(Layer.empty);
  private policy: ModelPolicy | undefined;

  constructor(
    readonly store: WorkstreamStore,
    readonly repository: GitRepository,
    readonly workers: VisibleWorkerRuntime,
    readonly launch: WorkstreamLaunch,
    readonly onResult: (
      resultId: string,
      state: WorkstreamState,
    ) => void | Promise<void>,
    readonly onError: (error: Error) => void,
    ownership: RuntimeOwnership = {},
  ) {
    this.policy = ownership.policy;
    const application = ownership.clock
      ? Effect.provideService(
          this.application(ownership),
          Clock.Clock,
          ownership.clock,
        )
      : this.application(ownership);
    this.effectRuntime.runFork(application);
  }

  private application(
    options: RuntimeOwnership,
  ): Effect.Effect<void, RuntimeError> {
    const owned = Effect.scoped(
      Effect.gen(function* (this: WorkstreamRuntime) {
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
          Deferred.await(this.startRequested).pipe(
            Effect.andThen(this.reconciliationLoop()),
          ),
        );
        yield* this.operationLoop();
      }.bind(this)),
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
      : this.runtimeSync("open workstream registry", () =>
          new WorkgraphRegistry(),
        );
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
    return Effect.gen(function* (this: WorkstreamRuntime) {
      const state = yield* this.dependency(
        "store",
        "load for lease claim",
        () => this.store.load(),
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
    }.bind(this));
  }

  private releaseLeaseEffect(
    registry: WorkgraphRegistry,
    lease: Lease,
  ): Effect.Effect<void> {
    return Effect.sync(() => {
      registry.release(lease);
      this.lease = undefined;
    });
  }

  private adoptCoordinatorEffect(
    options: RuntimeOwnership,
  ): Effect.Effect<void, RuntimeDependencyError> {
    return Effect.gen(function* (this: WorkstreamRuntime) {
      const state = yield* this.dependency("store", "load coordinator", () =>
        this.store.load(),
      );
      const owner = options.owner ?? state.coordinator;
      if (
        owner.sessionId !== state.coordinator.sessionId ||
        owner.sessionFile !== state.coordinator.sessionFile
      ) {
        yield* this.dependency("store", "adopt coordinator", () =>
          this.store.adopt(owner),
        );
      }
    }.bind(this));
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

  private submit<T>(
    effect: Effect.Effect<T, RuntimeError>,
  ): Effect.Effect<T, RuntimeError> {
    return Effect.gen(function* (this: WorkstreamRuntime) {
      yield* Deferred.await(this.ready);
      yield* this.acceptingEffect();
      const reply = yield* Deferred.make<T, RuntimeError>();
      const run = Effect.exit(
        this.ownershipEffect().pipe(Effect.andThen(effect)),
      ).pipe(
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
    }.bind(this));
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
          Effect.sync(() => this.onError(asError(Cause.squash(cause)))).pipe(
            Effect.andThen(Queue.offer(this.operations, { _tag: "Stop" })),
            Effect.asVoid,
          ),
      ),
    );
  }

  private reconciliationLoop(): Effect.Effect<void, RuntimeError> {
    return Effect.sleep("1 second").pipe(
      Effect.andThen(
        this.submit(
          this.dependency("runtime", "reconcile workstream", () =>
            this.reconcileOperation(),
          ),
        ),
      ),
      Effect.tap(() => Effect.sync(() => (this.reconciliationError = undefined))),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => {
          const error = asError(Cause.squash(cause));
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

  async perform<T>(operation: () => Promise<T>): Promise<T> {
    return this.runPromise(
      this.submit(this.dependency("pi", "host operation", operation)),
    );
  }

  start(): void {
    Deferred.doneUnsafe(this.startRequested, Effect.succeed(undefined));
  }

  async stop(): Promise<void> {
    const previous = Effect.runSync(
      Ref.modify(this.lifecycle, (state) => [
        state,
        state === "open" ? "stopping" : state,
      ] as const),
    );
    if (previous === "stopped") return;
    if (previous === "open")
      await this.runPromise(
        Deferred.await(this.ready).pipe(
          Effect.matchEffect({
            onFailure: () => Effect.void,
            onSuccess: () => Queue.offer(this.operations, { _tag: "Stop" }),
          }),
          Effect.andThen(Deferred.await(this.applicationExit)),
          Effect.asVoid,
        ),
      ).catch(() => undefined);
    else await this.runPromise(Deferred.await(this.applicationExit)).catch(() => undefined);
    await this.effectRuntime.dispose();
  }

  private async runPromise<T, E>(effect: Effect.Effect<T, E>): Promise<T> {
    if (Ref.getUnsafe(this.lifecycle) === "stopped")
      throw new RuntimeStoppedError({ message: "Workstream runtime is stopped." });
    const exit = await this.effectRuntime.runPromiseExit(effect);
    if (Exit.isSuccess(exit)) return exit.value;
    const error = Cause.squash(exit.cause);
    throw error instanceof Error ? error : new Error(String(error));
  }

  async queue(
    input: Parameters<WorkstreamStore["assign"]>[0],
    options: QueueOptions = {},
  ): Promise<WorkstreamState> {
    return this.perform(async () => {
      const policy = this.policy ?? (await loadModelPolicy());
      const baseRevision = await this.resolveQueueBase(input, options);
      if (input.capability === "implement") {
        const guide = policy.roles["implementation.guide"];
        const explicit =
          options.model || options.thinking
            ? {
                target: {
                  model: options.model ?? guide.model,
                  thinking: options.thinking ?? guide.thinking,
                },
                reason: options.modelReason ?? "",
              }
            : undefined;
        if (explicit && !explicit.reason.trim())
          throw new Error(
            "An explicit worker model or thinking level requires a specific reason.",
          );
        if (options.executor && !options.modelReason?.trim())
          throw new Error(
            "An explicit executor target requires a specific reason.",
          );
        const executor =
          options.executor ?? policy.roles["implementation.executor"];
        return this.store.enqueue(input, {
          id: `attempt-${randomUUID()}`,
          models: {
            guide: explicit?.target ?? guide,
            executor,
            ...(explicit || options.executor
              ? { overrideReason: options.modelReason?.trim() ?? "" }
              : {}),
            source: explicit || options.executor ? "override" : "policy",
          },
          ...(options.continuationOf
            ? { continuationOf: options.continuationOf }
            : {}),
          ...(baseRevision ? { baseRevision } : {}),
        });
      }
      const role = input.capability === "review" ? "review" : "research";
      const selectionRequest =
        options.model || options.thinking
          ? {
              ...(options.selection ?? {}),
              override: {
                target: {
                  model: options.model ?? policy.roles[role].model,
                  thinking: options.thinking ?? policy.roles[role].thinking,
                },
                reason: options.modelReason ?? "",
              },
            }
          : options.selection;
      const selection = resolveSelection(role, selectionRequest, policy);
      if (selection.unfulfilled.length > 0)
        throw new Error(selection.unfulfilled.join(" "));
      return this.store.enqueue(
        input,
        selection.selected.map((target, index) => ({
          id: `attempt-${randomUUID()}`,
          models: {
            guide: target,
            source: selection.source,
            selection,
          },
          ...(index === 0 && options.continuationOf
            ? { continuationOf: options.continuationOf }
            : {}),
          ...(baseRevision ? { baseRevision } : {}),
        })),
      );
    });
  }

  private async resolveQueueBase(
    input: Parameters<WorkstreamStore["assign"]>[0],
    options: QueueOptions,
  ): Promise<string | undefined> {
    const subjectRevision =
      input.capability === "review" && input.subject.kind === "revision"
        ? input.subject.revision
        : undefined;
    if (
      subjectRevision &&
      options.baseRevision &&
      subjectRevision !== options.baseRevision
    )
      throw new Error("Review base revision conflicts with its exact subject.");
    const requiresIsolatedBase =
      input.capability === "implement" ||
      input.artifactIntent === "disposable_experiment";
    const requested =
      options.baseRevision ??
      subjectRevision ??
      (requiresIsolatedBase ? await this.repository.head() : undefined);
    return requested ? this.repository.resolveRevision(requested) : undefined;
  }

  private async reconcileOperation(): Promise<WorkstreamState> {
      let state = await this.store.load();
      if (!["active", "suspended"].includes(state.lifecycle.state))
        return state;
      for (const item of state.attempts) {
        try {
          // Cleanup is terminal; delivery is reconciled independently below.
          if (item.cleanup?.state === "completed") {
            if (item.error) await this.store.clearAttention(item.id);
            continue;
          }
          await this.advance(item.id);
          const advanced = findAttempt(await this.store.load(), item.id);
          const blocked =
            advanced.composition?.state === "blocked"
              ? advanced.composition.error
              : advanced.cleanup?.state === "blocked"
                ? advanced.cleanup.error
                : undefined;
          if (blocked) throw new Error(blocked);
          if (advanced.error) await this.store.clearAttention(item.id);
        } catch (error) {
          const latest = await this.store.load();
          const attempt = findAttempt(latest, item.id);
          const detail = asError(error).message;
          if (attempt.error !== detail) {
            await this.store.recordAttention(attempt.id, detail);
            this.onError(new Error(`Attempt ${attempt.id}: ${detail}`));
          }
        }
      }
      state = await this.store.load();
      if (state.lifecycle.state === "active") {
        for (const delivery of state.deliveries) {
          if (
            delivery.state !== "pending" ||
            delivery.attemptedBy === this.deliveryOwner
          )
            continue;
          await this.store.deliveryAttempt(
            delivery.resultId,
            this.deliveryOwner,
          );
          try {
            this.assertOwnership();
            await this.onResult(delivery.resultId, await this.store.load());
            await this.store.markDelivered(delivery.resultId);
          } catch (error) {
            await this.store.deliveryAttempt(
              delivery.resultId,
              this.deliveryOwner,
              asError(error).message,
            );
          }
        }
      }
      return this.store.load();
  }

  async reconcile(): Promise<WorkstreamState> {
    return this.runPromise(
      this.submit(
        this.dependency("runtime", "reconcile workstream", () =>
          this.reconcileOperation(),
        ),
      ),
    );
  }

  private async advance(id: string): Promise<void> {
    let state = await this.store.load();
    let attempt = findAttempt(state, id);
    const assignment = findAssignment(state, attempt.assignmentId);
    if (attempt.cleanup?.state === "completed") return;
    if (
      attempt.state === "queued" ||
      (attempt.state === "starting" && !attempt.sessionFile)
    ) {
      if (state.lifecycle.state !== "active") return;
      await this.launchAttempt(state, attempt, assignment);
      return;
    }
    if (
      (attempt.state === "starting" ||
        attempt.state === "running" ||
        attempt.state === "cancel_requested") &&
      attempt.sessionFile
    ) {
      if (!attempt.worker) {
        const recover = this.workers.recover;
        if (!recover)
          throw new Error(
            "Worker transport cannot reconcile retained launch identity.",
          );
        const recovered = await recover.call(this.workers, {
          workspaceId: this.launch.workspaceId,
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
          cwd: placementPath(state, attempt),
          sessionFile: attempt.sessionFile,
          ...(attempt.resource ? { resource: attempt.resource } : {}),
        });
        if (!recovered)
          throw new Error(
            "Retained launch has no proven live identity; inspect before replacing it.",
          );
        await this.store.recordWorker(id, recovered.identity);
        attempt = findAttempt(await this.store.load(), id);
      }
      const worker = required(attempt.worker, "worker identity");
      const observation = await this.workers.observe(worker);
      const started = hasNativeAgentStarted(worker.sessionFile, state.id, id);
      if (started && attempt.submission !== "started")
        await this.store.markSubmission(id, "started");
      if (
        attempt.submission === "not_sent" &&
        !started &&
        state.lifecycle.state === "active"
      ) {
        if (
          !this.workers.steer ||
          !["idle", "done"].includes(observation.status)
        )
          throw new Error(
            "Worker is not ready for the retained unsent objective.",
          );
        await this.store.markSubmission(id, "uncertain");
        await this.workers.steer(
          worker,
          "Continue the assigned Workgraph objective now.",
        );
        await this.store.markSubmission(id, "submitted");
        return;
      }
      if (!hasNativeAgentSettled(worker.sessionFile, state.id, id)) {
        if (observation.status === "blocked")
          throw new Error(
            "Worker is blocked; inspect its visible session before proceeding.",
          );
        if (attempt.submission === "uncertain" && !started)
          throw new Error(
            "Submission is uncertain and no current native start is recorded. Inspect before resending.",
          );
        // Herdr idle/done can lag Pi's native markers during ordinary startup/settlement.
        // Absence of settlement alone is not an error or permission to resend.
        return;
      }
      if (observation.status === "working" || observation.status === "blocked")
        return;
      await this.retain(state, attempt, assignment);
    }
    state = await this.store.load();
    attempt = findAttempt(state, id);
    if (attempt.resultId) {
      const result = state.results.find((item) => item.id === attempt.resultId);
      if (!result) throw new Error("Retained attempt result is missing.");
      if (!state.deliveries.some((delivery) => delivery.resultId === result.id))
        await this.store.requestDelivery(result.id);
      if (
        assignment.capability === "implement" &&
        (result.validity !== "typed" || result.report.status !== "completed")
      ) {
        throw new Error(
          "Implementation did not produce valid successful evidence; retain its workspace for inspection.",
        );
      }
      if (
        assignment.capability === "implement" &&
        result.validity === "typed" &&
        result.report.status === "completed" &&
        result.report.kind === "implementation" &&
        result.report.outcome === "changed" &&
        attempt.state !== "cancelled" &&
        attempt.composition?.state !== "retained_not_applied"
      ) {
        if (state.lifecycle.state !== "active") return;
        await this.compose(state, attempt, assignment);
      }
      state = await this.store.load();
      attempt = findAttempt(state, id);
      if (!attempt.cleanup && attempt.placement) {
        const isolated = attempt.placement.kind === "isolated_worktree";
        await this.store.beginCleanup({
          id,
          ...(isolated
            ? {
                expectedHead: await this.repository.head(
                  attempt.placement.path,
                ),
              }
            : {}),
          discard: assignment.artifactIntent === "disposable_experiment",
        });
      }
      await this.cleanup(id);
    }
  }

  private async launchAttempt(
    state: WorkstreamState,
    attempt: WorkAttempt,
    assignment: WorkAssignment,
  ): Promise<void> {
    const isolated =
      assignment.capability === "implement" ||
      assignment.artifactIntent === "disposable_experiment";
    const baseRevision = attempt.baseRevision;
    const isolatedPlacement = isolated
      ? await this.repository.createWorktree(
          state.id,
          attempt.id,
          required(baseRevision, "base revision"),
        )
      : undefined;
    const workerCwd = isolatedPlacement?.path ?? this.repository.root;
    await this.store.startAttempt({
      id: attempt.id,
      placement: isolatedPlacement
        ? {
            kind: "isolated_worktree",
            path: isolatedPlacement.path,
            branch: isolatedPlacement.branch,
          }
        : { kind: "shared_project", path: workerCwd },
      ...(baseRevision ? { baseRevision } : {}),
    });
    const previous = attempt.continuationOf
      ? findAttempt(state, attempt.continuationOf)
      : undefined;
    const sessionFile = await createWorkerSession({
      targetCwd: workerCwd,
      sessionDir: join(dirname(state.statePath), "sessions"),
      objective: objectiveFor(state, assignment, baseRevision),
      mode: modeFor(assignment),
      runId: state.id,
      nodeId: attempt.id,
      ...(previous
        ? {
            continuationSessionFile: required(
              previous.sessionFile,
              "continuation session",
            ),
          }
        : {}),
    });
    await this.store.recordSessionFile(attempt.id, sessionFile);
    const models = required(attempt.models, "assignment models");
    this.assertOwnership();
    await this.workers.launch({
      workspaceId: this.launch.workspaceId,
      runId: state.id,
      nodeId: attempt.id,
      attemptId: attempt.id,
      assignmentId: assignment.id,
      objective: assignment.objective,
      role: assignment.capability,
      cwd: workerCwd,
      sessionFile,
      prompt: "Continue the assigned Workgraph objective now.",
      model: models.guide.model,
      thinking: models.guide.thinking,
      env: {
        PI_WORKGRAPH_MODE: modeFor(assignment),
        PI_WORKGRAPH_RUN_ID: state.id,
        PI_WORKGRAPH_NODE_ID: attempt.id,
        ...(baseRevision ? { PI_WORKGRAPH_BASE_COMMIT: baseRevision } : {}),
        ...(process.env["PI_CODING_AGENT_DIR"]
          ? { PI_CODING_AGENT_DIR: process.env["PI_CODING_AGENT_DIR"] }
          : {}),
        ...(assignment.artifactIntent === "disposable_experiment"
          ? { PI_WORKGRAPH_EXPERIMENT: "1" }
          : {}),
        ...(models.executor
          ? {
              PI_WORKGRAPH_IMPLEMENTATION_START: "guide",
              PI_WORKGRAPH_EXECUTOR_MODEL: models.executor.model,
              PI_WORKGRAPH_EXECUTOR_THINKING: models.executor.thinking,
            }
          : {}),
      },
      onTab: async (launchPane) => {
        await this.store.recordLaunchPane(attempt.id, launchPane);
      },
      onResource: async (resource) => {
        await this.store.recordResource(attempt.id, resource);
      },
      onIdentity: async (worker) => {
        await this.store.recordWorker(attempt.id, worker);
        await this.store.markSubmission(attempt.id, "uncertain");
      },
      onSubmitted: async () => {
        await this.store.markSubmission(attempt.id, "submitted");
      },
    });
  }

  private async retain(
    state: WorkstreamState,
    attempt: WorkAttempt,
    assignment: WorkAssignment,
  ): Promise<void> {
    const sessionFile = required(attempt.sessionFile, "session");
    const generation = { runId: state.id, nodeId: attempt.id };
    // Keep the opaque result identity stable across a crash between retention and settlement.
    const resultId = attempt.resultId ?? `result-${attempt.id}`;
    const existing = state.results.find((item) => item.id === resultId);
    const read = readWorkgraphReportResult(sessionFile, generation);
    if (!existing) {
      const base = {
        id: resultId,
        assignmentId: assignment.id,
        assignmentIntentVersion: assignment.intentVersion,
      };
      if (read.report && read.report.kind === modeFor(assignment)) {
        let artifacts: RetainedArtifact[] = [];
        try {
          if (
            assignment.capability === "implement" &&
            read.report.kind === "implementation" &&
            read.report.status === "completed" &&
            read.report.outcome === "no_change"
          )
            await this.repository.validateWorkerNoChange(
              placementOf(attempt),
              read.report.revision,
            );
          if (assignment.artifactIntent === "disposable_experiment")
            artifacts = await this.retainExperiment(
              state,
              assignment,
              attempt,
              resultId,
              read.report.status === "completed",
            );
          await this.store.retainResult({
            ...base,
            validity: "typed",
            report: read.report,
            artifacts,
          });
        } catch (error) {
          const detail = asError(error).message;
          const noChangeValidation =
            assignment.capability === "implement" &&
            read.report.kind === "implementation" &&
            read.report.status === "completed" &&
            read.report.outcome === "no_change";
          await this.store.retainResult({
            ...base,
            validity: "invalid",
            detail: `${noChangeValidation ? "No-change validation failed" : "Artifact retention failed"}: ${detail}`,
          });
          await this.store
            .beginCleanup({
              id: attempt.id,
              ...(attempt.placement?.kind === "isolated_worktree"
                ? {
                    expectedHead: await this.repository.head(
                      attempt.placement.path,
                    ),
                  }
                : {}),
              discard: false,
            })
            .then(() => this.store.blockCleanup(attempt.id, detail));
        }
      } else if (read.report || read.invalid || read.unreadable) {
        await this.store.retainResult({
          ...base,
          validity: "invalid",
          detail:
            read.error ??
            "Worker report kind does not match the assigned responsibility.",
        });
      } else {
        const text = readTerminalText(sessionFile, generation);
        await this.store.retainResult(
          text
            ? { ...base, validity: "untyped", text }
            : {
                ...base,
                validity: "absent",
                detail: "Pi settled without a current-attempt report.",
              },
        );
      }
    }
    const effectiveModels = effectiveModelObservations(sessionFile, generation);
    await this.store.settleAttempt({
      id: attempt.id,
      resultId,
      effectiveModels,
    });
    await this.store.requestDelivery(resultId);
  }

  private async compose(
    state: WorkstreamState,
    attempt: WorkAttempt,
    assignment: WorkAssignment,
  ): Promise<void> {
    if (attempt.composition?.state === "blocked") return;
    if (attempt.composition?.state === "composed") {
      await this.store.addResultArtifacts(
        required(attempt.resultId, "result"),
        [
          {
            id: "maintained-revision",
            kind: "revision",
            reference: required(
              attempt.composition.revision,
              "composed revision",
            ),
            retention: "retained",
            summary: `Composed ${attempt.composition.commit}.`,
          },
        ],
      );
      return;
    }
    const result = state.results.find((item) => item.id === attempt.resultId);
    if (
      result?.validity !== "typed" ||
      result.report.kind !== "implementation" ||
      result.report.status !== "completed" ||
      result.report.outcome !== "changed" ||
      !result.report.commit
    )
      throw new Error(
        "Composition requires a completed changed implementation report's exact commit.",
      );
    const commit = result.report.commit;
    const expectedHead =
      attempt.composition?.expectedHead ?? (await this.repository.head());
    try {
      if (!attempt.composition) {
        await this.repository.validateWorkerCommit(
          placementOf(attempt),
          commit,
        );
        await this.store.beginComposition({
          id: attempt.id,
          commit,
          expectedHead,
        });
      }
      if (
        !this.store.isAssignmentCurrent(await this.store.load(), assignment.id)
      )
        throw new Error(
          "Intent changed; retained implementation is stale and cannot compose.",
        );
      this.assertOwnership();
      const recovered = await this.repository.recoverComposition(expectedHead, {
        baseCommit: required(attempt.baseRevision, "base revision"),
        commit,
      });
      const revision =
        recovered?.head ??
        (await this.repository.compose(commit, expectedHead));
      await this.store.finishComposition(attempt.id, revision);
      await this.store.addResultArtifacts(
        required(attempt.resultId, "result"),
        [
          {
            id: "maintained-revision",
            kind: "revision",
            reference: revision,
            retention: "retained",
            summary: `Composed ${commit}.`,
          },
        ],
      );
    } catch (error) {
      // A command or persistence error can occur after Git changed HEAD. Inspect before retry.
      const recovered = await this.repository
        .recoverComposition(expectedHead, {
          baseCommit: required(attempt.baseRevision, "base revision"),
          commit,
        })
        .catch(() => undefined);
      if (recovered) {
        await this.store.finishComposition(attempt.id, recovered.head);
        await this.store.addResultArtifacts(
          required(attempt.resultId, "result"),
          [
            {
              id: "maintained-revision",
              kind: "revision",
              reference: recovered.head,
              retention: "retained",
              summary: `Recovered composition of ${commit}.`,
            },
          ],
        );
      } else
        await this.store.blockComposition(attempt.id, asError(error).message);
    }
  }

  private async retainExperiment(
    state: WorkstreamState,
    assignment: Extract<
      WorkAssignment,
      { artifactIntent: "disposable_experiment" }
    >,
    attempt: WorkAttempt,
    resultId: string,
    successful: boolean,
  ): Promise<RetainedArtifact[]> {
    const root = await realpath(
      required(
        attempt.placement?.kind === "isolated_worktree"
          ? attempt.placement.path
          : undefined,
        "experiment worktree",
      ),
    );
    const destination = join(dirname(state.statePath), "artifacts", resultId);
    const artifacts: RetainedArtifact[] = [];
    for (const name of assignment.artifactPolicy.retain) {
      if (!name.trim() || name.split(/[\\/]/).includes(".git") || name === ".")
        throw new Error(
          "Artifact must name a non-metadata path within the experiment.",
        );
      const source = resolve(root, name);
      const target = resolve(destination, name);
      try {
        await access(source);
      } catch (error) {
        if (
          !successful &&
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          continue;
        throw error;
      }
      if (
        !within(root, source) ||
        !within(destination, target) ||
        !within(root, await realpath(source))
      )
        throw new Error(`Experiment artifact escapes its workspace: ${name}.`);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, {
        recursive: true,
        force: true,
        filter: async (path) => {
          if ((await lstat(path)).isSymbolicLink())
            throw new Error(`Symlink artifact is not retained: ${path}.`);
          if (!within(root, await realpath(path)))
            throw new Error("Artifact escaped the experiment.");
          return true;
        },
      });
      artifacts.push({
        id: name,
        kind: "path",
        reference: target,
        retention: "retained",
        summary:
          "Retained from authorized disposable experiment before cleanup.",
      });
    }
    return artifacts;
  }

  private async cleanup(id: string): Promise<void> {
    const state = await this.store.load();
    const attempt = findAttempt(state, id);
    const cleanup = attempt.cleanup;
    if (
      cleanup?.state !== "pending" ||
      attempt.composition?.state === "blocked"
    )
      return;
    try {
      if (!cleanup.workerClosed) {
        const result = await this.workers.cleanup?.(
          required(attempt.worker, "worker identity"),
        );
        if (result?.state === "pending") return;
        if (result?.state !== "completed")
          throw new Error(
            result?.detail ?? "Worker cleanup is not proven complete.",
          );
        await this.store.markWorkerClosed(id);
      }
      this.assertOwnership();
      if (attempt.placement?.kind === "isolated_worktree") {
        const expectedHead = required(
          cleanup.expectedHead,
          "expected worktree HEAD",
        );
        if (cleanup.discard)
          await this.repository.discardExperiment(
            placementOf(attempt),
            expectedHead,
          );
        await this.repository.cleanupWorktree(
          placementOf(attempt),
          expectedHead,
        );
      } else if (cleanup.discard) {
        throw new Error("Shared project cleanup cannot discard files.");
      }
      await this.store.finishCleanup(id);
    } catch (error) {
      await this.store.blockCleanup(id, asError(error).message);
    }
  }

  async recoverAttempt(input: {
    attemptId: string;
    action: "retry" | "retain_not_applied";
    reason: string;
    integratedRevision?: string;
  }): Promise<WorkstreamState> {
    return this.perform(async () => {
      if (!input.reason.trim()) throw new Error("Recovery reason is required.");
      let state = await this.store.load();
      const attempt = findAttempt(state, input.attemptId);
      const assignment = findAssignment(state, attempt.assignmentId);
      const composition = attempt.composition;
      const cleanup = attempt.cleanup;
      if (input.action === "retain_not_applied" && !input.integratedRevision)
        throw new Error(
          "Retained-not-applied recovery requires the integrated revision.",
        );
      if (composition?.state === "blocked") {
        if (!attempt.worker)
          throw new Error(
            "Recovery cannot inspect the missing worker identity.",
          );
        const inspection = await this.workers.inspect(attempt.worker);
        if (
          inspection.status !== "absent" &&
          !["idle", "done"].includes(inspection.status)
        )
          throw new Error(
            `Recovery inspected worker ${inspection.status}; leave resources intact.`,
          );
        await this.repository.assertClean();
        await this.repository.validateWorkerCommit(
          placementOf(attempt),
          composition.commit,
        );
        this.assertOwnership();
        const retainedRef = await this.repository.retainCommit(
          state.id,
          attempt.id,
          composition.commit,
        );
        if (composition.retainedRef && composition.retainedRef !== retainedRef)
          throw new Error(
            `Retained ref provenance changed from ${composition.retainedRef} to ${retainedRef}.`,
          );
        if (input.action === "retry") {
          await this.store.retryComposition(attempt.id, undefined, retainedRef);
          state = await this.store.load();
          const retried = findAttempt(state, attempt.id);
          await this.compose(state, retried, assignment);
          state = await this.store.load();
          const composed = findAttempt(state, attempt.id);
          if (!composed.cleanup && composed.placement) {
            await this.store.beginCleanup({
              id: attempt.id,
              expectedHead: await this.repository.head(
                placementOf(composed).path,
              ),
              discard: false,
            });
          }
          await this.cleanup(attempt.id);
        } else {
          const integratedRevision = await this.repository.resolveRevision(
            input.integratedRevision!,
          );
          const currentHead = await this.repository.head();
          if (currentHead !== integratedRevision)
            throw new Error(
              `Integrated revision is ${integratedRevision}, but repository HEAD is ${currentHead}.`,
            );
          await this.store.retainCompositionNotApplied({
            id: attempt.id,
            reason: input.reason,
            retainedRef,
            integratedRevision,
          });
          state = await this.store.load();
          if (!state.attempts.find((item) => item.id === attempt.id)?.cleanup) {
            await this.store.beginCleanup({
              id: attempt.id,
              expectedHead: await this.repository.head(
                placementOf(attempt).path,
              ),
              discard: false,
            });
          }
          await this.cleanup(attempt.id);
        }
      } else if (cleanup?.state === "blocked") {
        if (!cleanup.workerClosed) {
          if (!attempt.worker)
            throw new Error(
              "Cleanup recovery cannot inspect the missing worker identity.",
            );
          const inspection = await this.workers.inspect(attempt.worker);
          if (
            inspection.status !== "absent" &&
            !["idle", "done"].includes(inspection.status)
          )
            throw new Error(
              `Recovery inspected worker ${inspection.status}; leave resources intact.`,
            );
        }
        await this.store.retryCleanup(attempt.id);
        await this.cleanup(attempt.id);
      } else {
        throw new Error(
          `Attempt ${attempt.id} has no blocked recovery boundary.`,
        );
      }
      return this.store.load();
    });
  }

  async steer(attemptId: string, instruction: string): Promise<void> {
    await this.perform(async () => {
      if (!instruction.trim())
        throw new Error("Steering instruction is required.");
      const attempt = findAttempt(await this.store.load(), attemptId);
      if (
        !attempt.worker ||
        !["running", "starting"].includes(attempt.state) ||
        !this.workers.steer
      )
        throw new Error("Attempt has no steerable live worker.");
      await this.store.recordSteering(attemptId, instruction, "uncertain");
      await this.workers.steer(attempt.worker, instruction);
      await this.store.recordSteering(attemptId, instruction, "submitted");
    });
  }

  async cancel(attemptId: string): Promise<void> {
    await this.perform(async () => {
      const attempt = findAttempt(await this.store.load(), attemptId);
      if (attempt.state === "queued") {
        await this.store.cancelAttempt(attemptId);
        return;
      }
      if (!["running", "starting"].includes(attempt.state))
        throw new Error("Attempt is not active.");
      await this.store.cancelAttempt(attemptId);
      if (attempt.worker) await this.workers.interrupt(attempt.worker);
    });
  }
}

function placementOf(attempt: WorkAttempt): WorktreePlacement {
  const placement = required(attempt.placement, "attempt placement");
  if (placement.kind !== "isolated_worktree")
    throw new Error(
      "Git worktree ownership is unavailable for shared placement.",
    );
  return {
    path: placement.path,
    branch: placement.branch,
    baseCommit: required(attempt.baseRevision, "base"),
  };
}
function placementPath(state: WorkstreamState, attempt: WorkAttempt): string {
  return attempt.placement?.path ?? state.projectRoot;
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
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
function within(root: string, path: string): boolean {
  const part = relative(resolve(root), resolve(path));
  return (
    part !== "" &&
    part !== ".." &&
    !part.startsWith(`..${sep}`) &&
    !part.startsWith(sep)
  );
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
  const intent = state.intents.find(
    (item) => item.version === assignment.intentVersion,
  );
  const common = [
    `Assignment: ${assignment.objective}`,
    `Intent version: ${assignment.intentVersion}`,
    `Constraints: ${intent?.constraints.join("; ") ?? ""}`,
    ...(baseRevision
      ? [
          `${assignment.capability === "implement" || assignment.artifactIntent === "disposable_experiment" ? "Isolated base revision" : "Requested Git revision evidence"}: ${baseRevision}`,
        ]
      : []),
  ];
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
