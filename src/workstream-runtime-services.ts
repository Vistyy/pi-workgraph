import type { FileSystem, Path, Scope } from "effect";
import { Cause, Data, DateTime, Effect } from "effect";
import type { HerdrEffects } from "./herdr.js";
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
import type { WorkstreamStoreEffects, WorkstreamStoreError } from "./workstream.js";

export type RuntimeWorkerPort = {
  readonly available: boolean;
  readonly effects: Pick<
    HerdrEffects,
    | "launch"
    | "recover"
    | "inspectLaunch"
    | "inspect"
    | "observe"
    | "interrupt"
    | "steer"
    | "cleanup"
  >;
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

/** Acquire the runtime's fenced lease and registry in the caller's scope. */
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
        finalizer(
          "release registry lease",
          () => registry.release(lease),
          options.onFinalizerError,
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              current = undefined;
            }),
          ),
        ),
    );
    const handle: RuntimeLeaseHandle = {
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
    options.store.bindMutationGuard(handle.assert);
    if (
      owner.sessionId !== state.coordinator.sessionId ||
      owner.sessionFile !== state.coordinator.sessionFile
    )
      yield* options.store.adopt(owner);
    return handle;
  });
}

/** Immutable native Pi operations used by the cohesive runtime resource. */
export const runtimePi = {
  createSession: createWorkerSessionEffect,
  readReport: (sessionFile: string, generation: { runId: string; nodeId: string }) =>
    pi("read worker report", () => readWorkgraphReportResult(sessionFile, generation)),
  readText: (sessionFile: string, generation: { runId: string; nodeId: string }) =>
    pi("read worker text", () => readTerminalText(sessionFile, generation)),
  observeFailure: (sessionFile: string, generation: { runId: string; nodeId: string }) =>
    pi("observe worker failure", () => observeNativeFailure(sessionFile, generation)),
  models: (sessionFile: string, generation: { runId: string; nodeId: string }) =>
    pi("read effective models", () => effectiveModelObservations(sessionFile, generation)),
  started: hasNativeAgentStarted,
  settled: hasNativeAgentSettled,
};

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
