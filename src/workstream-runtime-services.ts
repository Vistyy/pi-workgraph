import {
  Cause,
  Clock,
  Context,
  Data,
  DateTime,
  Effect,
  type FileSystem,
  Layer,
  type Path,
} from "effect";
import { ArtifactStore } from "./artifact-store.js";
import type { GitRepository, GitRepositoryEffects } from "./git.js";
import type {
  HerdrInspection,
  HerdrObservation,
  HerdrProtocolError,
  WorkerCleanupResult,
  WorkerLaunchEffectRequest,
  WorkerLaunchInspection,
  WorkerLaunchInspectionRequest,
  WorkerLaunchReadinessError,
  WorkerRecoveryRequest,
} from "./herdr.js";
import type { WorkerLaunchError } from "./herdr-launch.js";
import { loadModelPolicyEffect, type ModelPolicy } from "./model-policy.js";
import { liveLayer } from "./node-platform.js";
import {
  createWorkerSessionEffect,
  effectiveModelObservations,
  hasNativeAgentSettled,
  hasNativeAgentStarted,
  observeNativeFailure,
  readTerminalText,
  readWorkgraphReportResult,
} from "./pi-process.js";
import {
  type Lease,
  LeaseDecisionRequiredError,
  type LeaseOwner,
  WorkgraphRegistry,
} from "./registry.js";
import type { WorkerIdentity } from "./types.js";
import type {
  WorkstreamState,
  WorkstreamStore,
  WorkstreamStoreEffects,
  WorkstreamStoreError,
} from "./workstream.js";

export interface RuntimeHerdrEffects {
  readonly launch: (
    request: WorkerLaunchEffectRequest<WorkstreamStoreError, FileSystem.FileSystem | Path.Path>,
  ) => Effect.Effect<
    HerdrObservation,
    HerdrProtocolError | WorkerLaunchReadinessError | WorkerLaunchError<WorkstreamStoreError>,
    FileSystem.FileSystem | Path.Path
  >;
  readonly recover: (
    request: WorkerRecoveryRequest,
  ) => Effect.Effect<HerdrObservation | undefined, HerdrProtocolError | WorkerLaunchReadinessError>;
  readonly inspectLaunch: (
    request: WorkerLaunchInspectionRequest,
  ) => Effect.Effect<WorkerLaunchInspection, HerdrProtocolError>;
  readonly inspect: (
    identity: WorkerIdentity,
  ) => Effect.Effect<HerdrInspection, HerdrProtocolError>;
  readonly observe: (
    identity: WorkerIdentity,
  ) => Effect.Effect<HerdrObservation, HerdrProtocolError>;
  readonly interrupt: (
    identity: WorkerIdentity,
  ) => Effect.Effect<HerdrObservation, HerdrProtocolError>;
  readonly steer: (
    identity: WorkerIdentity,
    instruction: string,
  ) => Effect.Effect<void, HerdrProtocolError>;
  readonly cleanup: (
    identity: WorkerIdentity,
  ) => Effect.Effect<WorkerCleanupResult, HerdrProtocolError>;
}
export type RuntimeWorkerPort = {
  readonly available: boolean;
  readonly effects: RuntimeHerdrEffects;
};

export class RuntimeRegistryError extends Data.TaggedError("RuntimeRegistryError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

export class RuntimeHostError extends Data.TaggedError("RuntimeHostError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

export class PiObservationError extends Data.TaggedError("PiObservationError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

export class RuntimeStore extends Context.Service<
  RuntimeStore,
  { readonly effects: WorkstreamStoreEffects }
>()("@vistyy/pi-workgraph/RuntimeStore") {}

export class RuntimeGit extends Context.Service<
  RuntimeGit,
  { readonly effects: GitRepositoryEffects }
>()("@vistyy/pi-workgraph/RuntimeGit") {}

export class RuntimeHerdr extends Context.Service<RuntimeHerdr, RuntimeWorkerPort>()(
  "@vistyy/pi-workgraph/RuntimeHerdr",
) {}

export class RuntimePolicy extends Context.Service<
  RuntimePolicy,
  {
    readonly policy: ReturnType<typeof loadModelPolicyEffect>;
  }
>()("@vistyy/pi-workgraph/RuntimePolicy") {}

export class RuntimePi extends Context.Service<
  RuntimePi,
  {
    readonly createSession: typeof createWorkerSessionEffect;
    readonly readReport: typeof readWorkgraphReportResultEffect;
    readonly readText: typeof readTerminalTextEffect;
    readonly observeFailure: typeof observeNativeFailureEffect;
    readonly models: typeof effectiveModelObservationsEffect;
    readonly started: typeof hasNativeAgentStarted;
    readonly settled: typeof hasNativeAgentSettled;
  }
>()("@vistyy/pi-workgraph/RuntimePi") {}

export class RuntimeHost extends Context.Service<
  RuntimeHost,
  {
    readonly deliver: (id: string, state: WorkstreamState) => Effect.Effect<void, RuntimeHostError>;
    readonly state: (state: WorkstreamState) => Effect.Effect<void, RuntimeHostError>;
    readonly error: (error: Error) => Effect.Effect<void, RuntimeHostError>;
  }
>()("@vistyy/pi-workgraph/RuntimeHost") {}

export interface RuntimeLeaseHandle {
  readonly registry: WorkgraphRegistry;
  readonly assert: () => void;
  readonly renew: Effect.Effect<void, RuntimeRegistryError | LeaseDecisionRequiredError>;
}
export class RuntimeLease extends Context.Service<RuntimeLease, RuntimeLeaseHandle>()(
  "@vistyy/pi-workgraph/RuntimeLease",
) {}

export interface RuntimeLayerOptions {
  readonly store: WorkstreamStore;
  readonly repository: GitRepository;
  readonly workers: RuntimeWorkerPort;
  readonly registry?: WorkgraphRegistry | undefined;
  readonly owner?: LeaseOwner | undefined;
  readonly priorOwnerLiveness?: "alive" | "dead" | "unknown" | undefined;
  readonly policy?: ModelPolicy | undefined;
  readonly artifactStoreLayer?:
    | Layer.Layer<ArtifactStore, never, FileSystem.FileSystem | Path.Path>
    | undefined;
  readonly clock?: Clock.Clock | undefined;
  readonly onResult: (id: string, state: WorkstreamState) => Effect.Effect<void, RuntimeHostError>;
  readonly onState: (state: WorkstreamState) => Effect.Effect<void, RuntimeHostError>;
  readonly onError: (error: Error) => Effect.Effect<void, RuntimeHostError>;
}

export function makeRuntimeLayer(options: RuntimeLayerOptions) {
  const base = Layer.mergeAll(
    liveLayer,
    Layer.succeed(RuntimeStore, { effects: options.store.effects }),
    Layer.succeed(RuntimeGit, { effects: options.repository.effects }),
    Layer.succeed(RuntimeHerdr, options.workers),
    Layer.succeed(RuntimePolicy, {
      policy:
        options.policy === undefined ? loadModelPolicyEffect() : Effect.succeed(options.policy),
    }),
    Layer.succeed(RuntimePi, {
      createSession: createWorkerSessionEffect,
      readReport: readWorkgraphReportResultEffect,
      readText: readTerminalTextEffect,
      observeFailure: observeNativeFailureEffect,
      models: effectiveModelObservationsEffect,
      started: hasNativeAgentStarted,
      settled: hasNativeAgentSettled,
    }),
    Layer.succeed(RuntimeHost, hostService(options)),
    ...(options.clock === undefined ? [] : [Layer.succeed(Clock.Clock, options.clock)]),
  );
  return Layer.mergeAll(
    options.artifactStoreLayer ?? ArtifactStore.layer,
    leaseLayer(options),
  ).pipe(Layer.provideMerge(base));
}

function leaseLayer(options: RuntimeLayerOptions) {
  return Layer.effect(
    RuntimeLease,
    Effect.gen(function* () {
      const store = yield* RuntimeStore;
      const registry = yield* Effect.acquireRelease(
        registryEffect(
          "open workstream registry",
          () => options.registry ?? new WorkgraphRegistry(),
        ),
        (value) =>
          options.registry === undefined
            ? finalizer("close workstream registry", () => value.close())
            : Effect.void,
      );
      const state = yield* store.effects.load();
      yield* registryEffect("index workstream", () =>
        registry.indexWorkstream({
          ...state,
          runId: state.id,
          lifecycle: state.lifecycle.state,
        }),
      );
      const now = yield* DateTime.nowAsDate;
      const owner = options.owner ?? state.coordinator;
      let current: Lease | undefined = yield* Effect.acquireRelease(
        registryEffect("claim registry lease", () =>
          registry.acquire(state.id, owner, now, options.priorOwnerLiveness ?? "unknown"),
        ),
        (lease) =>
          finalizer("release registry lease", () => registry.release(lease)).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                current = undefined;
              }),
            ),
          ),
      );
      const handle: RuntimeLeaseHandle = {
        registry,
        assert: () => {
          if (current === undefined)
            throw new LeaseDecisionRequiredError(
              `Workstream ${state.id} no longer holds a live lease.`,
            );
          registry.assertLease(current);
        },
        renew: Effect.suspend(() =>
          registryEffect("renew registry lease", () => {
            if (current === undefined)
              throw new LeaseDecisionRequiredError(
                `Workstream ${state.id} no longer holds a live lease.`,
              );
            current = registry.renew(current);
          }),
        ),
      };
      store.effects.bindMutationGuard(handle.assert);
      if (
        owner.sessionId !== state.coordinator.sessionId ||
        owner.sessionFile !== state.coordinator.sessionFile
      )
        yield* store.effects.adopt(owner);
      return handle;
    }),
  );
}

function registryEffect<A>(operation: string, run: () => A) {
  return Effect.try({
    try: run,
    catch: (cause) =>
      cause instanceof LeaseDecisionRequiredError
        ? cause
        : new RuntimeRegistryError({ operation, cause }),
  });
}

function finalizer(operation: string, run: () => void): Effect.Effect<void> {
  return Effect.sync(run).pipe(
    Effect.catchCause((cause) =>
      Effect.die(new RuntimeRegistryError({ operation, cause: Cause.squash(cause) })),
    ),
  );
}

function hostService(options: RuntimeLayerOptions): RuntimeHost["Service"] {
  const host = (
    operation: string,
    effect: Effect.Effect<void, RuntimeHostError>,
  ): Effect.Effect<void, RuntimeHostError> =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause instanceof RuntimeHostError ? cause : new RuntimeHostError({ operation, cause }),
      ),
    );
  return {
    deliver: (id, state) => host("deliver result", options.onResult(id, state)),
    state: (state) => host("publish state", options.onState(state)),
    error: (error) => host("report error", options.onError(error)),
  };
}

function pi<A>(operation: string, run: () => A) {
  return Effect.try({ try: run, catch: (cause) => new PiObservationError({ operation, cause }) });
}
function readWorkgraphReportResultEffect(
  sessionFile: string,
  generation: { runId: string; nodeId: string },
) {
  return pi("read worker report", () => readWorkgraphReportResult(sessionFile, generation));
}
function readTerminalTextEffect(
  sessionFile: string,
  generation: { runId: string; nodeId: string },
) {
  return pi("read worker text", () => readTerminalText(sessionFile, generation));
}
function observeNativeFailureEffect(
  sessionFile: string,
  generation: { runId: string; nodeId: string },
) {
  return pi("observe worker failure", () => observeNativeFailure(sessionFile, generation));
}
function effectiveModelObservationsEffect(
  sessionFile: string,
  generation: { runId: string; nodeId: string },
) {
  return pi("read effective models", () => effectiveModelObservations(sessionFile, generation));
}
