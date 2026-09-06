import { createHash, randomUUID } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native mode metadata and open flags support the no-follow ownership fence absent from the public provider.
import { constants, type Stats } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native lstat, realpath, and exclusive handles are the explicit no-symlink ownership fence absent from the public provider.
import * as nativeFs from "node:fs/promises";
import { Context, Data, Effect, FileSystem, Layer, Option, Path } from "effect";
import { liveLayer } from "./node-platform.js";
import type { ArtifactRetention, RetainedArtifact } from "./workstream.js";

type NativeDirectory = Awaited<ReturnType<typeof nativeFs.opendir>>;
type NativeStats = Stats;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const CHUNK_SIZE = 64 * 1024;

export class ArtifactValidationError extends Data.TaggedError("ArtifactValidationError")<{
  readonly message: string;
}> {}

export class ArtifactSafetyError extends Data.TaggedError("ArtifactSafetyError")<{
  readonly message: string;
}> {}

export class ArtifactIoError extends Data.TaggedError("ArtifactIoError")<{
  readonly operation: string;
  readonly path: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

export type ArtifactStoreError = ArtifactValidationError | ArtifactSafetyError | ArtifactIoError;

export interface ArtifactSourceCheckpoint {
  readonly sourceRoot: string;
  readonly sourceIdentity: string;
}

export interface ArtifactSourceExpectation extends ArtifactSourceCheckpoint {
  readonly placement: string;
}

export interface RetainArtifactInput {
  readonly retention: ArtifactRetention;
  readonly name: string;
}

export interface ArtifactFingerprintExpectation extends RetainArtifactInput {
  readonly fingerprint: string;
}

export interface ArtifactMutationFence {
  readonly fingerprint: string;
}

/**
 * Typed artifact byte boundary.
 *
 * Runtime callers inject a fully provided `Layer.Layer<ArtifactStore>`.
 * `ArtifactStore.layer` requires Effect's `FileSystem` and `Path` services, while
 * `ArtifactStore.layerLive` supplies the shared Node providers for production.
 * The guard is an Effect value so every ownership/intent fence remains attached
 * to the calling fiber and is rerun immediately before an owned mutation window.
 */
export class ArtifactStore extends Context.Service<
  ArtifactStore,
  {
    readonly checkpointSource: (
      placement: string,
    ) => Effect.Effect<ArtifactSourceCheckpoint, ArtifactStoreError>;
    readonly verifySource: (
      expectation: ArtifactSourceExpectation,
    ) => Effect.Effect<void, ArtifactStoreError>;
    readonly verifyArtifact: (
      expectation: ArtifactFingerprintExpectation,
    ) => Effect.Effect<void, ArtifactStoreError>;
    readonly retain: <E, R>(
      input: RetainArtifactInput,
      guard: (fence: ArtifactMutationFence) => Effect.Effect<void, E, R>,
    ) => Effect.Effect<RetainedArtifact, ArtifactStoreError | E, R>;
  }
>()("@vistyy/pi-workgraph/ArtifactStore") {
  static readonly layer = Layer.effect(
    ArtifactStore,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const implementation = new NativeArtifactStore(fileSystem, paths);
      return ArtifactStore.of({
        checkpointSource: (placement) => implementation.checkpointSource(placement),
        verifySource: (expectation) => implementation.verifySource(expectation),
        verifyArtifact: (expectation) => implementation.verifyArtifact(expectation),
        retain: (input, guard) => implementation.retain(input, guard),
      });
    }),
  );

  static readonly layerLive = ArtifactStore.layer.pipe(Layer.provide(liveLayer));
}

class NativeArtifactStore {
  constructor(
    private readonly fileSystem: FileSystem.FileSystem,
    private readonly paths: Path.Path,
  ) {}

  checkpointSource(placement: string): Effect.Effect<ArtifactSourceCheckpoint, ArtifactStoreError> {
    return Effect.gen(
      function* (this: NativeArtifactStore) {
        const sourceRoot = yield* native("resolve artifact source", placement, () =>
          nativeFs.realpath(placement),
        );
        const sourceIdentity = yield* this.sourceIdentity(sourceRoot);
        return { sourceRoot, sourceIdentity };
      }.bind(this),
    );
  }

  verifySource(expectation: ArtifactSourceExpectation): Effect.Effect<void, ArtifactStoreError> {
    return Effect.gen(
      function* (this: NativeArtifactStore) {
        const actual = yield* this.checkpointSource(expectation.placement);
        if (
          actual.sourceRoot !== expectation.sourceRoot ||
          actual.sourceIdentity !== expectation.sourceIdentity
        )
          return yield* new ArtifactSafetyError({
            message: "Required artifact source no longer has its exact owned identity.",
          });
      }.bind(this),
    );
  }

  verifyArtifact(
    expectation: ArtifactFingerprintExpectation,
  ): Effect.Effect<void, ArtifactStoreError> {
    const source = this.paths.resolve(expectation.retention.sourceRoot, expectation.name);
    return this.fingerprint(source, expectation.retention.sourceRoot).pipe(
      Effect.flatMap((fingerprint) =>
        fingerprint === expectation.fingerprint
          ? Effect.void
          : new ArtifactSafetyError({
              message: `Experiment artifact changed while being retained: ${expectation.name}.`,
            }),
      ),
    );
  }

  retain<E, R>(
    input: RetainArtifactInput,
    guard: (fence: ArtifactMutationFence) => Effect.Effect<void, E, R>,
  ): Effect.Effect<RetainedArtifact, ArtifactStoreError | E, R> {
    return Effect.scoped(
      Effect.gen(
        function* (this: NativeArtifactStore) {
          const { name, retention } = input;
          yield* this.validateArtifactName(retention.sourceRoot, name);
          const source = this.paths.resolve(retention.sourceRoot, name);
          if (!within(this.paths, retention.sourceRoot, source))
            return yield* new ArtifactValidationError({
              message: `Experiment artifact escapes its retained boundary: ${name}.`,
            });

          const sourceFingerprint = yield* this.fingerprint(source, retention.sourceRoot);
          const stagingKey = createHash("sha256")
            .update(`${name}\0${sourceFingerprint}`)
            .digest("hex");
          const payloadRoot = this.paths.join(retention.stagingRoot, `${stagingKey}.payload`);
          const staging = this.paths.resolve(payloadRoot, name);
          const marker = this.paths.join(retention.stagingRoot, `${stagingKey}.owner.json`);
          const ownership = stagingOwnership(retention, name, sourceFingerprint);
          if (!within(this.paths, payloadRoot, staging))
            return yield* new ArtifactValidationError({
              message: `Experiment artifact escapes its owned payload: ${name}.`,
            });

          const mutationFence = { fingerprint: sourceFingerprint };
          const freshGuard = () => guard(mutationFence);
          yield* freshGuard();
          yield* this.preparePrivateDirectory(
            retention.stagingRoot,
            retention.stagingRoot,
            freshGuard,
          );
          yield* freshGuard();
          yield* this.claimStaging(marker, payloadRoot, ownership);

          if (yield* this.pathExists(staging)) {
            const stagedFingerprint = yield* this.fingerprint(staging, retention.stagingRoot);
            if (stagedFingerprint !== sourceFingerprint) {
              yield* this.verifyOwnedStaging(marker, payloadRoot, retention.stagingRoot, ownership);
              yield* freshGuard();
              yield* this.quarantineOwnedStaging(marker, payloadRoot, ownership);
            }
          }

          if (!(yield* this.pathExists(staging))) {
            yield* freshGuard();
            yield* this.preparePrivateDirectory(
              retention.stagingRoot,
              this.paths.dirname(staging),
              freshGuard,
            );
            yield* this.copyTree(
              source,
              staging,
              retention.sourceRoot,
              retention.stagingRoot,
              freshGuard,
            );
          }

          const stagedFingerprint = yield* this.fingerprint(staging, retention.stagingRoot);
          if (stagedFingerprint !== sourceFingerprint)
            return yield* new ArtifactSafetyError({
              message: `Experiment artifact changed while being retained: ${name}.`,
            });

          yield* freshGuard();
          return retainedArtifact(name, staging);
        }.bind(this),
      ),
    );
  }

  private sourceIdentity(root: string): Effect.Effect<string, ArtifactStoreError> {
    const marker = this.paths.join(root, ".git");
    return Effect.gen(function* () {
      const status = yield* lstat(marker);
      if (!status.isFile() || status.isSymbolicLink())
        return yield* new ArtifactSafetyError({
          message: "Experiment source has unsafe Git worktree metadata.",
        });
      return yield* withNativeFile(
        marker,
        constants.O_RDONLY | constants.O_NOFOLLOW,
        FILE_MODE,
        (handle) =>
          Effect.gen(function* () {
            const hash = createHash("sha256");
            const bytes = new Uint8Array(CHUNK_SIZE);
            let offset = 0;
            while (offset < status.size) {
              const read = yield* native("read artifact identity", marker, () =>
                handle.read(bytes, 0, bytes.length, offset),
              );
              if (read.bytesRead === 0) break;
              hash.update(bytes.subarray(0, read.bytesRead));
              offset += read.bytesRead;
            }
            if (offset !== status.size)
              return yield* new ArtifactSafetyError({
                message: "Experiment source metadata changed while its identity was read.",
              });
            return hash.digest("hex");
          }),
      );
    });
  }

  private validateArtifactName(
    sourceRoot: string,
    name: string,
  ): Effect.Effect<void, ArtifactValidationError> {
    return Effect.suspend(() => {
      if (
        name.trim() === "" ||
        name === "." ||
        this.paths.resolve(sourceRoot, name) === sourceRoot ||
        name.split(/[\\/]/).some((part) => part === ".git" || part === "..")
      )
        return new ArtifactValidationError({
          message: "Artifact must name a non-metadata path within the experiment.",
        });
      return Effect.void;
    });
  }

  private pathExists(path: string): Effect.Effect<boolean, ArtifactIoError> {
    return lstatOptional(path).pipe(Effect.map((status) => status !== undefined));
  }

  private preparePrivateDirectory<E, R>(
    root: string,
    path: string,
    guard: () => Effect.Effect<void, E, R>,
  ): Effect.Effect<void, ArtifactStoreError | E, R> {
    const base = this.paths.resolve(root, "..", "..");
    const part = this.paths.relative(base, path);
    if (part === ".." || part.startsWith(`..${this.paths.sep}`) || part.startsWith(this.paths.sep))
      return new ArtifactValidationError({
        message: `Artifact retention directory escapes its base: ${path}.`,
      });
    return Effect.gen(
      function* (this: NativeArtifactStore) {
        const baseStatus = yield* lstat(base);
        if (baseStatus.isSymbolicLink() || !baseStatus.isDirectory())
          return yield* new ArtifactSafetyError({
            message: `Artifact retention base is unsafe: ${base}.`,
          });
        const realBase = yield* native("resolve artifact base", base, () =>
          nativeFs.realpath(base),
        );
        let current = base;
        for (const component of part.split(this.paths.sep).filter(Boolean)) {
          current = this.paths.join(current, component);
          const existing = yield* lstatOptional(current);
          if (existing === undefined) {
            yield* guard();
            yield* createPrivateDirectory(current);
          } else {
            yield* assertPrivateDirectory(current, existing);
          }
          const realDirectory = yield* native("resolve artifact directory", current, () =>
            nativeFs.realpath(current),
          );
          if (realDirectory !== realBase && !within(this.paths, realBase, realDirectory))
            return yield* new ArtifactSafetyError({
              message: `Artifact retention directory escapes its base: ${current}.`,
            });
        }
      }.bind(this),
    );
  }

  private claimStaging(
    marker: string,
    payloadRoot: string,
    ownership: string,
  ): Effect.Effect<void, ArtifactStoreError> {
    return Effect.gen(
      function* (this: NativeArtifactStore) {
        const markerStatus = yield* lstatOptional(marker);
        if (markerStatus !== undefined) {
          yield* this.assertStagingMarker(marker, ownership, markerStatus);
          return;
        }
        if (yield* this.pathExists(payloadRoot))
          return yield* new ArtifactSafetyError({
            message: `Unproven artifact staging payload is preserved: ${payloadRoot}.`,
          });
        yield* withNativeFile(
          marker,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          FILE_MODE,
          (handle) =>
            Effect.gen(function* () {
              yield* native("set artifact marker permissions", marker, () =>
                handle.chmod(FILE_MODE),
              );
              yield* native("write artifact ownership marker", marker, () =>
                handle.writeFile(ownership, "utf8"),
              );
              yield* native("sync artifact ownership marker", marker, () => handle.sync());
            }),
        ).pipe(
          Effect.catchIf(
            (error) => isCode(error.cause, "EEXIST"),
            () => this.assertStagingMarker(marker, ownership),
          ),
        );
      }.bind(this),
    );
  }

  private assertStagingMarker(
    marker: string,
    ownership: string,
    knownStatus?: NativeStats,
  ): Effect.Effect<void, ArtifactStoreError> {
    return Effect.gen(function* () {
      const status = knownStatus ?? (yield* lstat(marker));
      if (
        !status.isFile() ||
        status.isSymbolicLink() ||
        (status.mode & 0o777) !== FILE_MODE ||
        status.size !== Buffer.byteLength(ownership)
      )
        return yield* new ArtifactSafetyError({
          message: `Artifact staging ownership marker is unsafe: ${marker}.`,
        });
      const actual = yield* withNativeFile(
        marker,
        constants.O_RDONLY | constants.O_NOFOLLOW,
        FILE_MODE,
        (handle) => readExact(handle, marker, status.size),
      );
      if (Buffer.from(actual).toString("utf8") !== ownership)
        return yield* new ArtifactSafetyError({
          message: `Artifact staging ownership is unproven: ${marker}.`,
        });
    });
  }

  private verifyOwnedStaging(
    marker: string,
    payloadRoot: string,
    stagingRoot: string,
    ownership: string,
  ): Effect.Effect<void, ArtifactStoreError> {
    return Effect.gen(
      function* (this: NativeArtifactStore) {
        yield* this.assertStagingMarker(marker, ownership);
        yield* this.fingerprint(payloadRoot, stagingRoot);
      }.bind(this),
    );
  }

  private quarantineOwnedStaging(
    marker: string,
    payloadRoot: string,
    ownership: string,
  ): Effect.Effect<void, ArtifactStoreError> {
    return Effect.gen(
      function* (this: NativeArtifactStore) {
        yield* this.assertStagingMarker(marker, ownership);
        const status = yield* lstat(payloadRoot);
        if (status.isSymbolicLink() || !status.isDirectory())
          return yield* new ArtifactSafetyError({
            message: `Artifact staging payload is unsafe: ${payloadRoot}.`,
          });
        const quarantine = `${payloadRoot}.quarantine-${randomUUID()}`;
        if (yield* this.pathExists(quarantine))
          return yield* new ArtifactSafetyError({
            message: `Artifact staging quarantine unexpectedly exists: ${quarantine}.`,
          });
        yield* this.fileSystem.rename(payloadRoot, quarantine).pipe(
          Effect.mapError(
            (cause) =>
              new ArtifactIoError({
                operation: "quarantine artifact payload",
                path: payloadRoot,
                cause,
              }),
          ),
        );
      }.bind(this),
    );
  }

  private fingerprint(path: string, root: string): Effect.Effect<string, ArtifactStoreError> {
    const accumulator = new Uint8Array(32);
    let entries = 0;
    const visit = (current: string): Effect.Effect<void, ArtifactStoreError> =>
      Effect.suspend(() =>
        Effect.gen(
          function* (this: NativeArtifactStore) {
            const status = yield* this.assertSafePath(current, root);
            const name = this.paths.relative(path, current);
            if (status.isDirectory()) {
              accumulate(accumulator, createHash("sha256").update(`directory\0${name}\0`).digest());
              entries++;
              yield* withDirectory(current, (directory) => {
                const next = (): Effect.Effect<void, ArtifactStoreError> =>
                  native("read artifact directory", current, () => directory.read()).pipe(
                    Effect.flatMap((entry) => {
                      if (entry === null) return Effect.void;
                      return visit(this.paths.join(current, entry.name)).pipe(
                        Effect.andThen(next()),
                      );
                    }),
                  );
                return next();
              });
              return;
            }
            if (!status.isFile())
              return yield* new ArtifactSafetyError({
                message: `Unsupported artifact file type: ${current}.`,
              });
            const digest = yield* this.hashFile(current, name, status);
            accumulate(accumulator, digest);
            entries++;
          }.bind(this),
        ),
      );
    return visit(path).pipe(
      Effect.map(() =>
        createHash("sha256")
          .update(`artifact-tree\0${entries}\0`)
          .update(accumulator)
          .digest("hex"),
      ),
    );
  }

  private hashFile(
    path: string,
    name: string,
    status: NativeStats,
  ): Effect.Effect<Uint8Array, ArtifactStoreError> {
    return Effect.scoped(
      Effect.gen(
        function* (this: NativeArtifactStore) {
          const handle = yield* this.fileSystem
            .open(path, { flag: "r" })
            .pipe(
              Effect.mapError(
                (cause) => new ArtifactIoError({ operation: "open artifact file", path, cause }),
              ),
            );
          const opened = yield* handle.stat.pipe(
            Effect.mapError(
              (cause) =>
                new ArtifactIoError({ operation: "inspect open artifact file", path, cause }),
            ),
          );
          if (opened.type !== "File" || opened.size !== BigInt(status.size))
            return yield* new ArtifactSafetyError({
              message: `Artifact changed while being fingerprinted: ${path}.`,
            });
          const hash = createHash("sha256").update(`file\0${name}\0${status.size}\0`);
          let bytesRead = 0n;
          while (true) {
            const chunk = yield* handle
              .readAlloc(CHUNK_SIZE)
              .pipe(
                Effect.mapError(
                  (cause) => new ArtifactIoError({ operation: "read artifact file", path, cause }),
                ),
              );
            if (Option.isNone(chunk)) break;
            hash.update(chunk.value);
            bytesRead += BigInt(chunk.value.length);
          }
          if (bytesRead !== BigInt(status.size))
            return yield* new ArtifactSafetyError({
              message: `Artifact changed while being fingerprinted: ${path}.`,
            });
          return hash.digest();
        }.bind(this),
      ),
    );
  }

  private copyTree<E, R>(
    source: string,
    target: string,
    sourceRoot: string,
    stagingRoot: string,
    guard: () => Effect.Effect<void, E, R>,
  ): Effect.Effect<void, ArtifactStoreError | E, R> {
    const copy = (
      currentSource: string,
      currentTarget: string,
    ): Effect.Effect<void, ArtifactStoreError | E, R> =>
      Effect.suspend(() =>
        Effect.gen(
          function* (this: NativeArtifactStore) {
            const status = yield* this.assertSafePath(currentSource, sourceRoot);
            if (status.isDirectory()) {
              yield* guard();
              yield* this.preparePrivateDirectory(stagingRoot, currentTarget, guard);
              yield* withDirectory(currentSource, (directory) => {
                const next = (): Effect.Effect<void, ArtifactStoreError | E, R> =>
                  native("read artifact directory", currentSource, () => directory.read()).pipe(
                    Effect.flatMap((entry) => {
                      if (entry === null) return Effect.void;
                      return copy(
                        this.paths.join(currentSource, entry.name),
                        this.paths.join(currentTarget, entry.name),
                      ).pipe(Effect.andThen(next()));
                    }),
                  );
                return next();
              });
              return;
            }
            if (!status.isFile())
              return yield* new ArtifactSafetyError({
                message: `Unsupported artifact file type: ${currentSource}.`,
              });
            yield* guard();
            yield* this.copyFile(currentSource, currentTarget, status);
          }.bind(this),
        ),
      );
    return copy(source, target);
  }

  private copyFile(
    source: string,
    target: string,
    sourceStatus: NativeStats,
  ): Effect.Effect<void, ArtifactStoreError> {
    return Effect.scoped(
      Effect.gen(
        function* (this: NativeArtifactStore) {
          const sourceHandle = yield* this.fileSystem
            .open(source, { flag: "r" })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ArtifactIoError({ operation: "open artifact source", path: source, cause }),
              ),
            );
          const opened = yield* sourceHandle.stat.pipe(
            Effect.mapError(
              (cause) =>
                new ArtifactIoError({ operation: "inspect artifact source", path: source, cause }),
            ),
          );
          if (opened.type !== "File" || opened.size !== BigInt(sourceStatus.size))
            return yield* new ArtifactSafetyError({
              message: `Artifact changed while being retained: ${source}.`,
            });
          yield* withNativeFile(
            target,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
            FILE_MODE,
            (targetHandle) =>
              Effect.gen(function* () {
                yield* native("set retained artifact permissions", target, () =>
                  targetHandle.chmod(FILE_MODE),
                );
                let copied = 0n;
                while (true) {
                  const chunk = yield* sourceHandle.readAlloc(CHUNK_SIZE).pipe(
                    Effect.mapError(
                      (cause) =>
                        new ArtifactIoError({
                          operation: "read artifact source",
                          path: source,
                          cause,
                        }),
                    ),
                  );
                  if (Option.isNone(chunk)) break;
                  yield* native("write retained artifact", target, () =>
                    targetHandle.write(chunk.value),
                  );
                  copied += BigInt(chunk.value.length);
                }
                if (copied !== BigInt(sourceStatus.size))
                  return yield* new ArtifactSafetyError({
                    message: `Artifact changed while being retained: ${source}.`,
                  });
                yield* native("sync retained artifact", target, () => targetHandle.sync());
              }),
          );
        }.bind(this),
      ),
    );
  }

  private assertSafePath(
    path: string,
    root: string,
  ): Effect.Effect<NativeStats, ArtifactStoreError> {
    return Effect.gen(
      function* (this: NativeArtifactStore) {
        const status = yield* lstat(path);
        if (status.isSymbolicLink())
          return yield* new ArtifactSafetyError({
            message: `Symlink artifact is not retained: ${path}.`,
          });
        const resolvedPath = yield* native("resolve artifact path", path, () =>
          nativeFs.realpath(path),
        );
        if (resolvedPath !== root && !within(this.paths, root, resolvedPath))
          return yield* new ArtifactSafetyError({
            message: `Artifact escaped its experiment: ${path}.`,
          });
        return status;
      }.bind(this),
    );
  }
}

function retainedArtifact(name: string, target: string): RetainedArtifact {
  return {
    id: name,
    kind: "path",
    reference: target,
    retention: "retained",
    summary: "Retained from authorized disposable experiment before cleanup.",
  };
}

function stagingOwnership(
  retention: ArtifactRetention,
  name: string,
  sourceFingerprint: string,
): string {
  return `${JSON.stringify({
    format: "pi-workgraph-artifact-staging",
    version: 1,
    resultId: retention.resultId,
    sourceIdentity: retention.sourceIdentity,
    expectedHead: retention.expectedHead,
    name,
    sourceFingerprint,
  })}\n`;
}

function within(paths: Path.Path, root: string, path: string): boolean {
  const part = paths.relative(paths.resolve(root), paths.resolve(path));
  return (
    part !== "" &&
    part !== ".." &&
    !part.startsWith(`..${paths.sep}`) &&
    !part.startsWith(paths.sep)
  );
}

function accumulate(total: Uint8Array, digest: Uint8Array): void {
  let carry = 0;
  for (let index = total.length - 1; index >= 0; index--) {
    const value = (total[index] ?? 0) + (digest[index] ?? 0) + carry;
    total[index] = value & 0xff;
    carry = value >>> 8;
  }
}

function isCode(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

function native<A>(
  operation: string,
  path: string,
  run: () => Promise<A>,
): Effect.Effect<A, ArtifactIoError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new ArtifactIoError({ operation, path, cause }),
  });
}

function lstat(path: string): Effect.Effect<NativeStats, ArtifactIoError> {
  return native("inspect artifact path without following links", path, () => nativeFs.lstat(path));
}

function lstatOptional(path: string): Effect.Effect<NativeStats | undefined, ArtifactIoError> {
  return lstat(path).pipe(
    Effect.catchIf(
      (error) => isCode(error.cause, "ENOENT"),
      () => Effect.void.pipe(Effect.as(undefined)),
    ),
  );
}

function withNativeFile<A, E, R>(
  path: string,
  flags: number,
  mode: number,
  use: (handle: nativeFs.FileHandle) => Effect.Effect<A, E, R>,
): Effect.Effect<A, ArtifactIoError | E, R> {
  return Effect.acquireUseRelease(
    native("open artifact file handle", path, () => nativeFs.open(path, flags, mode)),
    use,
    (handle) => native("close artifact file handle", path, () => handle.close()),
  );
}

function withDirectory<A, E, R>(
  path: string,
  use: (directory: NativeDirectory) => Effect.Effect<A, E, R>,
): Effect.Effect<A, ArtifactIoError | E, R> {
  return Effect.acquireUseRelease(
    native("open artifact directory handle", path, () => nativeFs.opendir(path)),
    use,
    (directory) => native("close artifact directory handle", path, () => directory.close()),
  );
}

function createPrivateDirectory(path: string): Effect.Effect<void, ArtifactStoreError> {
  return Effect.gen(function* () {
    yield* native("create private artifact directory", path, () =>
      nativeFs.mkdir(path, { mode: DIRECTORY_MODE }),
    );
    yield* withNativeFile(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      DIRECTORY_MODE,
      (handle) =>
        native("set private artifact directory permissions", path, () =>
          handle.chmod(DIRECTORY_MODE),
        ),
    );
    const status = yield* lstat(path);
    yield* assertPrivateDirectory(path, status);
  });
}

function assertPrivateDirectory(
  path: string,
  status: NativeStats,
): Effect.Effect<void, ArtifactSafetyError> {
  return status.isDirectory() &&
    !status.isSymbolicLink() &&
    (status.mode & 0o777) === DIRECTORY_MODE
    ? Effect.void
    : new ArtifactSafetyError({ message: `Artifact retention directory is unsafe: ${path}.` });
}

function readExact(
  handle: nativeFs.FileHandle,
  path: string,
  size: number,
): Effect.Effect<Uint8Array, ArtifactStoreError> {
  return Effect.gen(function* () {
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = yield* native("read artifact ownership marker", path, () =>
        handle.read(bytes, offset, bytes.length - offset, offset),
      );
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset !== bytes.length)
      return yield* new ArtifactSafetyError({
        message: `Artifact staging ownership changed while being read: ${path}.`,
      });
    return bytes;
  });
}
