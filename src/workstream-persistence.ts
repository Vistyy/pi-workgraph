import { randomUUID } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This module is the real Node atomic-file owner behind the Effect store port.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Atomic-file ownership requires canonical host paths.
import { dirname } from "node:path";
import { Effect } from "effect";
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

export type StoreEffect<A> = Effect.Effect<A, WorkstreamStoreError>;

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
    return filesystemEffect("read workstream state", () => readFile(this.path, "utf8")).pipe(
      Effect.flatMap((text) => domainEffect(() => parsePersistedObject(text))),
    );
  }

  writeState(state: WorkstreamState): StoreEffect<void> {
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const prepareAndPublish = filesystemEffect("write temporary workstream state", () =>
      writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      }),
    ).pipe(
      Effect.andThen(
        Effect.uninterruptible(
          domainEffect(() => this.mutationGuard()?.()).pipe(
            Effect.andThen(
              filesystemEffect("atomically replace workstream state", () =>
                rename(temporaryPath, this.path),
              ),
            ),
          ),
        ),
      ),
      Effect.ensuring(
        filesystemEffect("remove temporary workstream state", () =>
          rm(temporaryPath, { force: true }),
        ).pipe(Effect.orDie),
      ),
    );
    return domainEffect(() => validateState(state)).pipe(
      Effect.andThen(
        filesystemEffect("prepare workstream directory", () =>
          mkdir(dirname(this.path), { recursive: true }),
        ),
      ),
      Effect.andThen(prepareAndPublish),
      Effect.asVoid,
    );
  }
}

export function claimWorkstreamDirectory(path: string): StoreEffect<void> {
  return filesystemEffect("prepare workstream parent directory", () =>
    mkdir(dirname(dirname(path)), { recursive: true }),
  ).pipe(
    Effect.andThen(filesystemEffect("claim workstream directory", () => mkdir(dirname(path)))),
    Effect.asVoid,
  );
}

export function removeWorkstreamDirectory(path: string): StoreEffect<void> {
  return filesystemEffect("remove failed workstream directory", () =>
    rm(dirname(path), { recursive: true, force: true }),
  );
}

function filesystemEffect<A>(operation: string, run: () => Promise<A>): StoreEffect<A> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => storeError(operation, cause),
  });
}

export function domainEffect<A>(run: () => A): StoreEffect<A> {
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
