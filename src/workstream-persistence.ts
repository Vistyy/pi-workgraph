import { randomUUID } from "node:crypto";
import { Cause, Effect, Exit, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import {
  InvalidWorkstreamStateError,
  UnsupportedWorkstreamStateError,
  WORKSTREAM_FORMAT,
  WORKSTREAM_STATE_VERSION,
  type WorkstreamState,
  WorkstreamStoreOperationError,
} from "./workstream-state.js";
import {
  decodeState,
  type JsonObject,
  parsePersistedObject,
  validateState,
  validateStoredPath,
} from "./workstream-validation.js";

export type WorkstreamStoreError =
  | InvalidWorkstreamStateError
  | UnsupportedWorkstreamStateError
  | WorkstreamStoreOperationError;

export type WorkstreamStoreRequirements = FileSystem.FileSystem | Path.Path;

export type StoreEffect<A, R = WorkstreamStoreRequirements> = Effect.Effect<
  A,
  WorkstreamStoreError,
  R
>;

type MutationGuard = () => void;

/** Effect-native owner of the serialized store's real atomic state file. */
export class AtomicWorkstreamFile {
  constructor(
    readonly path: string,
    private readonly mutationGuard: () => MutationGuard | undefined,
  ) {}

  readState(): StoreEffect<WorkstreamState> {
    return this.readObject().pipe(
      Effect.flatMap((value) =>
        domainEffect(() => {
          if (value.format !== WORKSTREAM_FORMAT || value.version !== WORKSTREAM_STATE_VERSION)
            throw new UnsupportedWorkstreamStateError(value.format, value.version);
          const state = decodeState(value);
          validateStoredPath(state, this.path);
          return state;
        }),
      ),
    );
  }

  readObject(): StoreEffect<JsonObject> {
    const statePath = this.path;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const text = yield* filesystemEffect(
        "read workstream state",
        fileSystem.readFileString(statePath),
      );
      return yield* domainEffect(() => parsePersistedObject(text));
    });
  }

  writeState(state: WorkstreamState): StoreEffect<void> {
    const statePath = this.path;
    const mutationGuard = this.mutationGuard;
    return Effect.gen(function* () {
      yield* domainEffect(() => validateState(state));
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      yield* filesystemEffect(
        "prepare workstream directory",
        fileSystem.makeDirectory(paths.dirname(statePath), { recursive: true }),
      );

      const temporaryPath = yield* domainEffect(
        () => `${statePath}.${process.pid}.${randomUUID()}.tmp`,
      );
      // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- The established validated state schema is serialized in its existing human-readable format.
      const contents = new TextEncoder().encode(`${JSON.stringify(state, null, 2)}\n`);
      let acquired = false;
      let published = false;

      const prepare = Effect.scoped(
        Effect.gen(function* () {
          const file = yield* filesystemEffect(
            "exclusively acquire temporary workstream state",
            fileSystem.open(temporaryPath, { flag: "wx", mode: 0o600 }),
          );
          acquired = true;
          yield* Effect.uninterruptible(
            filesystemEffect("write temporary workstream state", file.writeAll(contents)).pipe(
              Effect.andThen(filesystemEffect("sync temporary workstream state", file.sync)),
            ),
          );
        }),
      );

      const publish = Effect.uninterruptible(
        domainEffect(() => mutationGuard()?.()).pipe(
          Effect.andThen(
            filesystemEffect(
              "atomically replace workstream state",
              fileSystem.rename(temporaryPath, statePath),
            ),
          ),
          Effect.tap(() =>
            Effect.sync(() => {
              published = true;
            }),
          ),
        ),
      );

      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const operationExit = yield* Effect.exit(restore(prepare.pipe(Effect.andThen(publish))));
          if (acquired && !published) {
            const cleanupExit = yield* Effect.exit(
              filesystemEffect(
                "remove owned temporary workstream state",
                fileSystem.remove(temporaryPath, { force: true }),
              ),
            );
            if (Exit.isFailure(operationExit) && Exit.isFailure(cleanupExit)) {
              return yield* new WorkstreamStoreOperationError({
                code: "workstream_store_operation_failed",
                message: "Workstream state preparation and cleanup both failed.",
                cause: new AggregateError([
                  Cause.squash(operationExit.cause),
                  Cause.squash(cleanupExit.cause),
                ]),
              });
            }
            yield* cleanupExit;
          }
          yield* operationExit;
        }),
      );
    });
  }
}

export function claimWorkstreamDirectory(path: string): StoreEffect<void> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    yield* filesystemEffect(
      "prepare workstream parent directory",
      fileSystem.makeDirectory(paths.dirname(paths.dirname(path)), { recursive: true }),
    );
    yield* filesystemEffect(
      "claim workstream directory",
      fileSystem.makeDirectory(paths.dirname(path)),
    );
  });
}

export function removeWorkstreamDirectory(path: string): StoreEffect<void> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    yield* filesystemEffect(
      "remove failed workstream directory",
      fileSystem.remove(paths.dirname(path), { recursive: true, force: true }),
    );
  });
}

function filesystemEffect<A, R>(
  operation: string,
  effect: Effect.Effect<A, PlatformError, R>,
): StoreEffect<A, R> {
  return effect.pipe(Effect.mapError((cause) => storeError(operation, cause)));
}

export function domainEffect<A>(run: () => A): StoreEffect<A, never> {
  return Effect.try({
    try: run,
    catch: (cause) => storeError("apply workstream domain operation", cause),
  });
}

function storeError(operation: string, cause: unknown): WorkstreamStoreError {
  if (
    cause instanceof InvalidWorkstreamStateError ||
    cause instanceof UnsupportedWorkstreamStateError ||
    cause instanceof WorkstreamStoreOperationError
  )
    return cause;
  return new WorkstreamStoreOperationError({
    code: "workstream_store_operation_failed",
    message: `Failed to ${operation}.`,
    cause,
  });
}
