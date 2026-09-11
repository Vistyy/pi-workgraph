import { Data, Effect, type Scope } from "effect";
import type { CoordinatorIdentity } from "../domain/workstream.js";
import type { WorkstreamLease } from "../storage/workstream-store.js";

export const WORKSTREAM_RUNTIME_GENERATION_PROTOCOL = 2 as const;
const REGISTRY_SYMBOL = Symbol.for("pi-workgraph.runtime-generations.v2");

export interface RuntimeGenerationQuiescence {
  readonly quiescent: boolean;
  readonly detail?: string;
}

export interface RuntimeGenerationHandle {
  readonly close: () => Promise<RuntimeGenerationQuiescence>;
}

export interface RuntimeGenerationEntry {
  readonly protocolVersion: typeof WORKSTREAM_RUNTIME_GENERATION_PROTOCOL;
  readonly path: string;
  readonly workstreamId: string;
  readonly coordinator: CoordinatorIdentity;
  readonly lease: WorkstreamLease;
  readonly handle: RuntimeGenerationHandle;
  status: "active" | "closing" | "quiescent" | "failed";
  closeResult?: Promise<RuntimeGenerationQuiescence>;
}

interface RuntimeGenerationRegistry {
  readonly protocolVersion: typeof WORKSTREAM_RUNTIME_GENERATION_PROTOCOL;
  readonly entries: Map<string, RuntimeGenerationEntry>;
  readonly tails: Map<string, Promise<void>>;
}

interface RuntimeGenerationReservation {
  readonly prior: Promise<void>;
  readonly release: () => void;
}

export class RuntimeGenerationRegistryError extends Data.TaggedError(
  "RuntimeGenerationRegistryError",
)<{ readonly message: string }> {}

function registry(): RuntimeGenerationRegistry {
  // SAFETY: This Symbol.for slot is the versioned host protocol boundary; only this module writes it.
  const host = globalThis as typeof globalThis & {
    [REGISTRY_SYMBOL]?: RuntimeGenerationRegistry;
  };
  const existing = host[REGISTRY_SYMBOL];
  if (existing !== undefined) {
    if (
      existing.protocolVersion !== WORKSTREAM_RUNTIME_GENERATION_PROTOCOL ||
      !(existing.entries instanceof Map) ||
      !(existing.tails instanceof Map)
    )
      throw new RuntimeGenerationRegistryError({
        message: `Incompatible process-global workstream runtime generation protocol; expected version ${WORKSTREAM_RUNTIME_GENERATION_PROTOCOL}.`,
      });
    return existing;
  }
  const created: RuntimeGenerationRegistry = {
    protocolVersion: WORKSTREAM_RUNTIME_GENERATION_PROTOCOL,
    entries: new Map(),
    tails: new Map(),
  };
  host[REGISTRY_SYMBOL] = created;
  return created;
}

/** Reserve all attachment and replacement decisions for one exact workstream path. */
export function reserveRuntimeGenerationPath(
  path: string,
): Effect.Effect<void, RuntimeGenerationRegistryError, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.try({
      try: () => enqueueReservation(path),
      catch: (cause) =>
        new RuntimeGenerationRegistryError({
          message: `Failed to serialize workstream runtime attachment for ${path}: ${String(cause)}`,
        }),
    }),
    (reservation) => Effect.sync(reservation.release),
  ).pipe(Effect.andThen((reservation) => Effect.promise(() => reservation.prior)));
}

function enqueueReservation(path: string): RuntimeGenerationReservation {
  const state = registry();
  const prior = state.tails.get(path) ?? Promise.resolve();
  let releaseHeld!: () => void;
  // oxlint-disable-next-line effecttsgo/new-promise -- The externally released Promise is the narrow process-global path reservation protocol.
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  const tail = prior.catch(() => undefined).then(() => held);
  state.tails.set(path, tail);
  let released = false;
  return {
    prior: prior.catch(() => undefined),
    release: () => {
      if (released) return;
      released = true;
      releaseHeld();
      void tail.finally(() => {
        if (state.tails.get(path) === tail) state.tails.delete(path);
      });
    },
  };
}

export function runtimeGeneration(path: string): RuntimeGenerationEntry | undefined {
  return registry().entries.get(path);
}

export function publishRuntimeGeneration(entry: RuntimeGenerationEntry): void {
  registry().entries.set(entry.path, entry);
}

export function closeRuntimeGeneration(
  entry: RuntimeGenerationEntry,
): Promise<RuntimeGenerationQuiescence> {
  if (entry.closeResult !== undefined) return entry.closeResult;
  entry.status = "closing";
  const result = entry.handle.close().then(
    (value) => {
      entry.status = value.quiescent ? "quiescent" : "failed";
      return value;
    },
    (cause) => {
      entry.status = "failed";
      return { quiescent: false, detail: String(cause) };
    },
  );
  entry.closeResult = result;
  return result;
}

export function recordRuntimeGenerationQuiescence(
  entry: RuntimeGenerationEntry,
  result: RuntimeGenerationQuiescence,
): void {
  entry.status = result.quiescent ? "quiescent" : "failed";
  entry.closeResult ??= Promise.resolve(result);
}

/** Remove only the exact quiescent generation; stale finalizers are harmless. */
export function unregisterRuntimeGeneration(entry: RuntimeGenerationEntry): void {
  const state = registry();
  if (state.entries.get(entry.path) === entry && entry.status === "quiescent")
    state.entries.delete(entry.path);
}

export function compatibleRuntimeGeneration(
  entry: RuntimeGenerationEntry,
  input: {
    readonly path: string;
    readonly workstreamId: string;
    readonly coordinator: CoordinatorIdentity;
    readonly lease?: WorkstreamLease;
  },
): boolean {
  if (
    entry.protocolVersion !== WORKSTREAM_RUNTIME_GENERATION_PROTOCOL ||
    entry.path !== input.path ||
    entry.workstreamId !== input.workstreamId ||
    entry.coordinator.sessionId !== input.coordinator.sessionId ||
    entry.coordinator.sessionFile !== input.coordinator.sessionFile
  )
    return false;
  const lease = input.lease;
  return (
    lease === undefined ||
    (entry.lease.token === lease.token &&
      entry.lease.owner.sessionId === lease.owner.sessionId &&
      entry.lease.owner.sessionFile === lease.owner.sessionFile)
  );
}

/** Deterministic isolation for tests that own all workstream runtimes in this process. */
export function resetRuntimeGenerationRegistryForTest(): void {
  const state = registry();
  state.entries.clear();
  state.tails.clear();
}
