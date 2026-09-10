import type { FileSystem, Path, Scope } from "effect";
import { Cause, Data, Effect } from "effect";
import type { GitRepository } from "./git.js";
import type { HerdrCliRuntime } from "./herdr.js";
import {
  createWorkerSessionEffect,
  effectiveModelObservations,
  hasNativeAgentSettled,
  hasNativeAgentStarted,
  observeNativeFailure,
  readWorkerText,
  readWorkgraphReportResult,
} from "./pi-process.js";
import { WorkgraphRegistry } from "./registry.js";
import type { WorkstreamStoreEffects, WorkstreamStoreError } from "./workstream.js";
import {
  type Lease,
  LeaseDecisionRequiredError,
  type LeaseOwner,
} from "./workstream-persistence.js";
import { legacyPathForWorkstream } from "./workstream-state.js";

export type WorkerHost = Pick<
  HerdrCliRuntime,
  "launch" | "recover" | "observe" | "interrupt" | "steer" | "cleanup"
>;

export type RepositoryGateway = Pick<
  GitRepository,
  | "root"
  | "head"
  | "resolveRevision"
  | "assertClean"
  | "createWorktree"
  | "validateWorkerNoChange"
  | "validateCandidate"
  | "preflightCandidateApplication"
  | "prepareCandidateApplication"
  | "recoverCandidateApplication"
  | "applyCandidate"
  | "releaseOutput"
  | "cleanupWorktree"
>;

export interface WorkerSessionReader {
  readonly createSession: typeof createWorkerSessionEffect;
  readonly readReport: (
    sessionFile: string,
    generation: { runId: string; nodeId: string },
  ) => ReturnType<typeof piReadReport>;
  readonly readText: (
    sessionFile: string,
    generation: { runId: string; nodeId: string },
  ) => ReturnType<typeof piReadText>;
  readonly observeFailure: (
    sessionFile: string,
    generation: { runId: string; nodeId: string },
  ) => ReturnType<typeof piObserveFailure>;
  readonly models: (
    sessionFile: string,
    generation: { runId: string; nodeId: string },
  ) => ReturnType<typeof piModels>;
  readonly started: typeof hasNativeAgentStarted;
  readonly settled: typeof hasNativeAgentSettled;
}

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

export interface RuntimeLeaseHandle {
  readonly assert: () => void;
  readonly renew: Effect.Effect<void, RuntimeRegistryError | LeaseDecisionRequiredError>;
}

export interface RuntimeLeaseOptions {
  readonly store: WorkstreamStoreEffects;
  readonly registry?: WorkgraphRegistry | undefined;
  readonly owner?: LeaseOwner | undefined;
  readonly priorOwnerLiveness?: "alive" | "dead" | "unknown" | undefined;
  readonly onFinalizerError?:
    | ((error: RuntimeRegistryError) => Effect.Effect<void, RuntimeHostError>)
    | undefined;
}

/** Acquire the runtime's private per-workstream lease and optional discovery locator. */
export function acquireRuntimeLease(
  options: RuntimeLeaseOptions,
): Effect.Effect<
  RuntimeLeaseHandle,
  RuntimeRegistryError | LeaseDecisionRequiredError | WorkstreamStoreError,
  Scope.Scope | FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const registry = yield* Effect.acquireRelease(
      registryEffect("open workstream registry", () => options.registry ?? new WorkgraphRegistry()),
      (value) =>
        options.registry === undefined
          ? finalizer("close workstream registry", () => value.close(), options.onFinalizerError)
          : Effect.void,
    );
    const state = yield* options.store.load();
    yield* registryEffect("index workstream discovery path", () =>
      registry.indexWorkstream({
        runId: state.id,
        statePath: state.statePath,
        gitCommonDir: state.gitCommonDir,
        legacyStatePath: legacyPathForWorkstream(state.gitCommonDir, state.id),
      }),
    );
    const owner = options.owner ?? state.coordinator;
    let current: Lease | undefined = yield* Effect.acquireRelease(
      options.store
        .acquireLease(owner, options.priorOwnerLiveness ?? "unknown")
        .pipe(Effect.mapError((error) => leaseAcquisitionError("claim workstream lease", error))),
      (lease) =>
        options.store.releaseLease(lease).pipe(
          Effect.mapError((error) => leaseAcquisitionError("release workstream lease", error)),
          Effect.ensuring(
            Effect.sync(() => {
              if (current?.token === lease.token) current = undefined;
            }),
          ),
          Effect.catchCause((cause) => {
            const error = new RuntimeRegistryError({
              operation: "release workstream lease",
              cause: Cause.squash(cause),
            });
            const report = options.onFinalizerError?.(error) ?? Effect.void;
            return report.pipe(Effect.ignore, Effect.andThen(Effect.die(error)));
          }),
        ),
    );
    const handle: RuntimeLeaseHandle = {
      assert: () => {
        if (current === undefined)
          throw new LeaseDecisionRequiredError(
            `Workstream ${state.id} no longer holds a live lease.`,
          );
        options.store.assertLease(current);
      },
      renew: Effect.suspend(() => {
        if (current === undefined)
          return Effect.fail(
            new LeaseDecisionRequiredError(`Workstream ${state.id} no longer holds a live lease.`),
          );
        return options.store.renewLease(current).pipe(
          Effect.map((lease) => {
            current = lease;
            return undefined;
          }),
          Effect.mapError((error) => leaseAcquisitionError("renew workstream lease", error)),
        );
      }),
    };
    if (
      owner.sessionId !== state.coordinator.sessionId ||
      owner.sessionFile !== state.coordinator.sessionFile
    )
      yield* options.store
        .adopt(owner)
        .pipe(Effect.mapError((error) => leaseAcquisitionError("adopt workstream owner", error)));
    return handle;
  });
}

const piReadReport = (sessionFile: string, generation: { runId: string; nodeId: string }) =>
  pi("read worker report", () => readWorkgraphReportResult(sessionFile, generation));
const piReadText = (sessionFile: string, generation: { runId: string; nodeId: string }) =>
  pi("read worker text", () => readWorkerText(sessionFile, generation));
const piObserveFailure = (sessionFile: string, generation: { runId: string; nodeId: string }) =>
  pi("observe worker failure", () => observeNativeFailure(sessionFile, generation));
const piModels = (sessionFile: string, generation: { runId: string; nodeId: string }) =>
  pi("read effective models", () => effectiveModelObservations(sessionFile, generation));

/** Native Pi/session adapter for the application-owned WorkerSessionReader port. */
export const liveWorkerSessionReader: WorkerSessionReader = {
  createSession: createWorkerSessionEffect,
  readReport: piReadReport,
  readText: piReadText,
  observeFailure: piObserveFailure,
  models: piModels,
  started: hasNativeAgentStarted,
  settled: hasNativeAgentSettled,
};

function leaseAcquisitionError(
  operation: string,
  error: WorkstreamStoreError,
): RuntimeRegistryError | LeaseDecisionRequiredError {
  if (error instanceof LeaseDecisionRequiredError) return error;
  return new RuntimeRegistryError({ operation, cause: error });
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

function finalizer(
  operation: string,
  run: () => void,
  onError: ((error: RuntimeRegistryError) => Effect.Effect<void, RuntimeHostError>) | undefined,
): Effect.Effect<void> {
  return Effect.sync(run).pipe(
    Effect.catchCause((cause) => {
      const error = new RuntimeRegistryError({ operation, cause: Cause.squash(cause) });
      const report = onError?.(error) ?? Effect.void;
      return report.pipe(Effect.ignore, Effect.andThen(Effect.die(error)));
    }),
  );
}

function pi<A>(operation: string, run: () => A) {
  return Effect.try({ try: run, catch: (cause) => new PiObservationError({ operation, cause }) });
}
