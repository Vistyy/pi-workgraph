import { Data, Effect } from "effect";
import type { CanonicalLease } from "./canonical-workstream-store.js";
import type { CoordinatorIdentity } from "./domain/workstream.js";

export const CANONICAL_RUNTIME_GENERATION_PROTOCOL = 1 as const;
const REGISTRY_SYMBOL = Symbol.for("pi-workgraph.canonical-runtime-generations.v1");

export interface RuntimeGenerationQuiescence {
  readonly quiescent: boolean;
  readonly detail?: string;
}

export interface RuntimeGenerationHandle {
  readonly close: () => Promise<RuntimeGenerationQuiescence>;
}

export interface RuntimeGenerationEntry {
  readonly protocolVersion: typeof CANONICAL_RUNTIME_GENERATION_PROTOCOL;
  readonly path: string;
  readonly workstreamId: string;
  readonly coordinator: CoordinatorIdentity;
  readonly token: string;
  readonly handle: RuntimeGenerationHandle;
  status: "active" | "closing" | "failed";
  closeResult?: Promise<RuntimeGenerationQuiescence>;
}

interface RuntimeGenerationRegistry {
  readonly protocolVersion: typeof CANONICAL_RUNTIME_GENERATION_PROTOCOL;
  readonly entries: Map<string, RuntimeGenerationEntry>;
  readonly tails: Map<string, Promise<void>>;
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
      existing.protocolVersion !== CANONICAL_RUNTIME_GENERATION_PROTOCOL ||
      !(existing.entries instanceof Map) ||
      !(existing.tails instanceof Map)
    )
      throw new RuntimeGenerationRegistryError({
        message: `Incompatible process-global canonical runtime generation protocol; expected version ${CANONICAL_RUNTIME_GENERATION_PROTOCOL}.`,
      });
    return existing;
  }
  const created: RuntimeGenerationRegistry = {
    protocolVersion: CANONICAL_RUNTIME_GENERATION_PROTOCOL,
    entries: new Map(),
    tails: new Map(),
  };
  host[REGISTRY_SYMBOL] = created;
  return created;
}

/** Reserve all attachment and replacement decisions for one exact canonical path. */
export function reserveRuntimeGenerationPath(
  path: string,
): Effect.Effect<() => void, RuntimeGenerationRegistryError> {
  return Effect.tryPromise({
    // oxlint-disable-next-line effecttsgo/async-function -- The stable process-global lock protocol deliberately uses host Promises, not package-generation Effect values.
    try: async () => {
      const state = registry();
      const prior = state.tails.get(path) ?? Promise.resolve();
      let release!: () => void;
      // oxlint-disable-next-line effecttsgo/new-promise -- This externally released Promise is the narrow process-global path reservation primitive.
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = prior.catch(() => undefined).then(() => held);
      state.tails.set(path, tail);
      await prior.catch(() => undefined);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
        void tail.finally(() => {
          if (state.tails.get(path) === tail) state.tails.delete(path);
        });
      };
    },
    catch: (cause) =>
      new RuntimeGenerationRegistryError({
        message: `Failed to serialize canonical runtime attachment for ${path}: ${String(cause)}`,
      }),
  });
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
      if (!value.quiescent) entry.status = "failed";
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

/** Remove only the exact successfully closed generation; stale finalizers are harmless. */
export function unregisterRuntimeGeneration(
  path: string,
  token: string,
  handle: RuntimeGenerationHandle,
): void {
  const state = registry();
  const entry = state.entries.get(path);
  if (entry?.token === token && entry.handle === handle && entry.status === "active")
    state.entries.delete(path);
}

export function compatibleRuntimeGeneration(
  entry: RuntimeGenerationEntry,
  input: {
    readonly path: string;
    readonly workstreamId: string;
    readonly coordinator: CoordinatorIdentity;
    readonly lease: CanonicalLease;
  },
): boolean {
  return (
    entry.protocolVersion === CANONICAL_RUNTIME_GENERATION_PROTOCOL &&
    entry.path === input.path &&
    entry.workstreamId === input.workstreamId &&
    entry.token === input.lease.token &&
    entry.coordinator.sessionId === input.coordinator.sessionId &&
    entry.coordinator.sessionFile === input.coordinator.sessionFile &&
    input.lease.owner.sessionId === input.coordinator.sessionId &&
    input.lease.owner.sessionFile === input.coordinator.sessionFile
  );
}

/** Deterministic isolation for tests that own all canonical runtimes in this process. */
export function resetRuntimeGenerationRegistryForTest(): void {
  const state = registry();
  state.entries.clear();
  state.tails.clear();
}
