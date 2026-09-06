import { randomUUID } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Effect's stat follows links; native lstat and realpath provide the static storage-component fence.
import { lstat as nativeLstat, realpath as nativeRealpath } from "node:fs/promises";
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
type Stats = Awaited<ReturnType<typeof nativeLstat>>;

type OwnedTemporary = {
  readonly path: string;
};

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

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
      const temporaryPath = yield* domainEffect(
        () => `${statePath}.${process.pid}.${randomUUID()}.tmp`,
      );
      // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- The established validated state schema is serialized in its existing human-readable format.
      const contents = new TextEncoder().encode(`${JSON.stringify(state, null, 2)}\n`);
      let ownership: OwnedTemporary | undefined;
      let published = false;

      const prepare = Effect.scoped(
        Effect.gen(function* () {
          const file = yield* Effect.uninterruptible(
            filesystemEffect(
              "exclusively acquire temporary workstream state",
              fileSystem.open(temporaryPath, { flag: "wx", mode: FILE_MODE }),
            ).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  ownership = { path: temporaryPath };
                }),
              ),
            ),
          );
          yield* Effect.uninterruptible(
            filesystemEffect(
              "set temporary workstream state permissions",
              fileSystem.chmod(temporaryPath, FILE_MODE),
            ).pipe(
              Effect.andThen(
                filesystemEffect("write temporary workstream state", file.writeAll(contents)),
              ),
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
          if (ownership !== undefined && !published) {
            const cleanupExit = yield* Effect.exit(
              filesystemEffect(
                "remove owned temporary workstream state",
                fileSystem.remove(ownership.path, { force: true }),
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
    const workstreamDirectory = paths.dirname(path);
    const workstreamsDirectory = paths.dirname(workstreamDirectory);
    const storageDirectory = paths.dirname(workstreamsDirectory);
    const gitCommonDirectory = paths.dirname(storageDirectory);

    yield* domainEffect(() => {
      if (
        paths.basename(path) !== "workstream.json" ||
        paths.basename(workstreamsDirectory) !== "workstreams" ||
        paths.basename(storageDirectory) !== "pi-workgraph"
      )
        throw new Error(`Workstream state path is outside the known storage layout: ${path}.`);
    });

    const realCommonDirectory = yield* prepareCommonDirectory(
      fileSystem,
      paths,
      gitCommonDirectory,
    );
    const storageComponents = [storageDirectory, workstreamsDirectory, workstreamDirectory];
    const existing = yield* Effect.forEach(storageComponents, (component) =>
      lstatOptional(component).pipe(
        Effect.tap((status) =>
          status === undefined
            ? Effect.void
            : assertExistingDirectory(paths, realCommonDirectory, component, status),
        ),
      ),
    );

    for (const [index, component] of storageComponents.slice(0, -1).entries()) {
      if (existing[index] !== undefined) continue;
      yield* createOwnedDirectory(fileSystem, component);
      yield* assertContainedDirectory(paths, realCommonDirectory, component);
    }

    yield* createOwnedDirectory(fileSystem, workstreamDirectory);
    yield* assertContainedDirectory(paths, realCommonDirectory, workstreamDirectory);
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

function prepareCommonDirectory(
  fileSystem: FileSystem.FileSystem,
  paths: Path.Path,
  gitCommonDirectory: string,
): StoreEffect<string, never> {
  return Effect.gen(function* () {
    const missing: string[] = [];
    let current = gitCommonDirectory;
    let status = yield* lstatOptional(current);
    while (status === undefined) {
      missing.unshift(current);
      const parent = paths.dirname(current);
      if (parent === current)
        return yield* storeError(
          "locate workstream storage boundary",
          new Error(`No existing ancestor contains Git common directory: ${gitCommonDirectory}.`),
        );
      current = parent;
      status = yield* lstatOptional(current);
    }
    yield* assertDirectoryStatus(current, status);
    const realExistingAncestor = yield* realPath(current);

    for (const directory of missing) {
      yield* createOwnedDirectory(fileSystem, directory);
      yield* assertContainedDirectory(paths, realExistingAncestor, directory);
    }

    return yield* realPath(gitCommonDirectory);
  });
}

function createOwnedDirectory(
  fileSystem: FileSystem.FileSystem,
  path: string,
): StoreEffect<void, never> {
  return Effect.uninterruptible(
    filesystemEffect(
      "create private workstream storage directory",
      fileSystem.makeDirectory(path, { mode: DIRECTORY_MODE }),
    ).pipe(
      Effect.andThen(
        filesystemEffect(
          "set private workstream storage directory permissions",
          fileSystem.chmod(path, DIRECTORY_MODE),
        ),
      ),
      Effect.andThen(lstat(path)),
      Effect.flatMap((status) =>
        domainEffect(() => {
          assertDirectory(path, status);
          if ((Number(status.mode) & 0o777) !== DIRECTORY_MODE)
            throw new Error(`New workstream storage directory is not private: ${path}.`);
        }),
      ),
    ),
  );
}

function assertExistingDirectory(
  paths: Path.Path,
  realCommonDirectory: string,
  path: string,
  status: Stats,
): StoreEffect<void, never> {
  return assertDirectoryStatus(path, status).pipe(
    Effect.andThen(assertContainedDirectory(paths, realCommonDirectory, path)),
  );
}

function assertContainedDirectory(
  paths: Path.Path,
  realBoundary: string,
  path: string,
): StoreEffect<void, never> {
  return realPath(path).pipe(
    Effect.flatMap((realDirectory) =>
      domainEffect(() => {
        const relative = paths.relative(realBoundary, realDirectory);
        if (
          relative === ".." ||
          relative.startsWith(`..${paths.sep}`) ||
          paths.isAbsolute(relative)
        )
          throw new Error(`Workstream storage directory escapes its boundary: ${path}.`);
      }),
    ),
  );
}

function assertDirectoryStatus(path: string, status: Stats): StoreEffect<void, never> {
  return domainEffect(() => assertDirectory(path, status));
}

function assertDirectory(path: string, status: Stats): void {
  if (status.isSymbolicLink() || !status.isDirectory())
    throw new Error(`Workstream storage component is not an ordinary directory: ${path}.`);
}

function lstat(path: string): StoreEffect<Stats, never> {
  return nativeFilesystemEffect("inspect workstream storage without following links", () =>
    nativeLstat(path),
  );
}

function lstatOptional(path: string): StoreEffect<Stats | undefined, never> {
  return nativeFilesystemEffect("inspect workstream storage without following links", () =>
    nativeLstat(path).catch((cause: unknown) => {
      if (isMissingPath(cause)) return undefined;
      return Promise.reject(cause);
    }),
  );
}

function realPath(path: string): StoreEffect<string, never> {
  return nativeFilesystemEffect("resolve workstream storage boundary", () => nativeRealpath(path));
}

function nativeFilesystemEffect<A>(
  operation: string,
  run: () => Promise<A>,
): StoreEffect<A, never> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => storeError(operation, cause),
  });
}

function isMissingPath(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
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
