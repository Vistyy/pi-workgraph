import { randomUUID } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native fs checks protect SQLite permissions and legacy source identity.
import { chmodSync, closeSync, existsSync, lstatSync, openSync, readFileSync } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Effect's stat follows links; native lstat and realpath provide the static storage-component fence.
import { lstat as nativeLstat, realpath as nativeRealpath } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { Data, Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  InvalidWorkstreamStateError,
  type SessionIdentity,
  UnsupportedWorkstreamStateError,
  WORKSTREAM_FORMAT,
  WORKSTREAM_STATE_VERSION,
  type WorkstreamState,
  WorkstreamStoreOperationError,
} from "./workstream-state.js";
import {
  decodeLegacyState,
  decodeState,
  type JsonObject,
  parsePersistedObject,
  validateState,
  validateStoredPath,
} from "./workstream-validation.js";

export type WorkstreamStoreError =
  | InvalidWorkstreamStateError
  | UnsupportedWorkstreamStateError
  | WorkstreamStoreOperationError
  | LeaseDecisionRequiredError;

export type WorkstreamStoreRequirements = FileSystem.FileSystem | Path.Path;

export type StoreEffect<A, R = WorkstreamStoreRequirements> = Effect.Effect<
  A,
  WorkstreamStoreError,
  R
>;

export type LeaseOwner = SessionIdentity;
export interface Lease {
  runId: string;
  token: string;
  owner: LeaseOwner;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export class LeaseDecisionRequiredError extends Data.TaggedError("LeaseDecisionRequiredError")<{
  readonly code: "lease_decision_required";
  readonly message: string;
}> {
  constructor(message: string) {
    super({ code: "lease_decision_required", message });
  }
}

type Stats = Awaited<ReturnType<typeof nativeLstat>>;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SQLITE_HEADER = "SQLite format 3\u0000";
const SQLITE_FILENAME = "workstream.sqlite";

const StateRowSchema = Type.Object({
  state_json: Type.String(),
  revision: Type.Integer({ minimum: 0 }),
});
const LeaseRowSchema = Type.Object({
  token: Type.String({ minLength: 1 }),
  owner_session_id: Type.String({ minLength: 1 }),
  owner_session_file: Type.String({ minLength: 1 }),
  acquired_at: Type.String({ minLength: 1 }),
  heartbeat_at: Type.String({ minLength: 1 }),
  expires_at: Type.String({ minLength: 1 }),
});
type StateRow = Static<typeof StateRowSchema>;
type LeaseRow = Static<typeof LeaseRowSchema>;
type NativeSqliteRow = Exclude<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>, undefined>;

/** The canonical private owner of one workstream's aggregate and fenced lease. */
export class SqliteWorkstreamDatabase {
  private constructor(
    readonly path: string,
    readonly db: DatabaseSync,
  ) {}

  static use<A>(
    path: string,
    run: (database: SqliteWorkstreamDatabase) => A,
    options: { readOnly?: boolean } = {},
  ): A {
    using db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
    db.exec("PRAGMA busy_timeout = 5000;");
    return run(new SqliteWorkstreamDatabase(path, db));
  }

  static create(path: string, state: WorkstreamState): void {
    const descriptor = openSync(path, "wx", FILE_MODE);
    try {
      chmodSync(path, FILE_MODE);
    } finally {
      closeSync(descriptor);
    }
    SqliteWorkstreamDatabase.use(path, (database) => {
      database.db.exec(
        "PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;",
      );
      chmodPrivateDatabase(path);
      database.db.exec(`
        CREATE TABLE IF NOT EXISTS workstream_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          state_json TEXT NOT NULL,
          revision INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lease (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          token TEXT NOT NULL,
          owner_session_id TEXT NOT NULL,
          owner_session_file TEXT NOT NULL,
          acquired_at TEXT NOT NULL,
          heartbeat_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
      `);
      chmodPrivateDatabase(path);
      database.initialize(state);
    });
  }

  rawState(): string {
    const row = this.stateRow();
    return row.state_json;
  }

  state(): WorkstreamState {
    const row = this.stateRow();
    const value = parsePersistedObject(row.state_json);
    if (value.format !== WORKSTREAM_FORMAT || value.version !== WORKSTREAM_STATE_VERSION)
      throw new UnsupportedWorkstreamStateError(value.format, value.version);
    const state = decodeState(value);
    validateStoredPath(state, this.path);
    if (state.revision !== row.revision)
      throw new InvalidWorkstreamStateError(
        "SQLite state revision does not match its aggregate row.",
      );
    return state;
  }

  initialize(state: WorkstreamState): void {
    validateState(state);
    validateStoredPath(state, this.path);
    this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM workstream_state WHERE singleton=1").get())
        throw new Error("Workstream SQLite state is already initialized.");
      this.db
        .prepare("INSERT INTO workstream_state(singleton,state_json,revision) VALUES(1,?,?)")
        .run(serializeState(state), state.revision);
    });
  }

  claimLease(owner: LeaseOwner, liveness: "alive" | "dead" | "unknown" = "unknown"): Lease {
    const token = randomUUID();
    return this.transaction(() => {
      const state = this.state();
      if (state.lifecycle.state !== "active" && state.lifecycle.state !== "suspended")
        throw new Error(`Workgraph ${state.id} is ${state.lifecycle.state}.`);
      const currentRow = this.db.prepare("SELECT * FROM lease WHERE singleton=1").get();
      const current = currentRow === undefined ? undefined : decodeLeaseRow(currentRow);
      // oxlint-disable-next-line effecttsgo/global-date -- SQLite lease expiry uses native wall-clock ordering after lock acquisition and row inspection.
      const leaseNow = new Date();
      const acquiredAt = leaseNow.toISOString();
      // oxlint-disable-next-line effecttsgo/global-date -- SQLite lease expiry uses native wall-clock ordering after lock acquisition.
      const expiresAt = new Date(leaseNow.getTime() + 30_000).toISOString();
      if (current && (current.expires_at > acquiredAt || liveness !== "dead"))
        throw new LeaseDecisionRequiredError(
          `Workstream ${state.id} already has a runtime owner; stop it or establish expired dead ownership before reattachment.`,
        );
      this.db
        .prepare(
          `INSERT INTO lease(singleton,token,owner_session_id,owner_session_file,acquired_at,heartbeat_at,expires_at)
           VALUES(1,?,?,?,?,?,?)
           ON CONFLICT(singleton) DO UPDATE SET token=excluded.token,
           owner_session_id=excluded.owner_session_id, owner_session_file=excluded.owner_session_file,
           acquired_at=excluded.acquired_at, heartbeat_at=excluded.heartbeat_at, expires_at=excluded.expires_at`,
        )
        .run(token, owner.sessionId, owner.sessionFile, acquiredAt, acquiredAt, expiresAt);
      return {
        runId: state.id,
        token,
        owner: { ...owner },
        acquiredAt,
        heartbeatAt: acquiredAt,
        expiresAt,
      };
    });
  }

  assertLease(lease: Lease, now?: Date): void {
    const row = this.db.prepare("SELECT * FROM lease WHERE singleton=1").get();
    // oxlint-disable-next-line effecttsgo/global-date -- Lease assertions use native wall-clock time unless an explicit fixture time is supplied.
    assertLeaseRow(row, lease, now ?? new Date());
  }

  renewLease(lease: Lease): Lease {
    return this.transaction(() => {
      const currentRow = this.db.prepare("SELECT * FROM lease WHERE singleton=1").get();
      // oxlint-disable-next-line effecttsgo/global-date -- SQLite lease renewal uses native wall-clock ordering after lock acquisition and row inspection.
      const leaseNow = new Date();
      const heartbeatAt = leaseNow.toISOString();
      // oxlint-disable-next-line effecttsgo/global-date -- SQLite lease renewal uses native wall-clock ordering after lock acquisition and row inspection.
      const expiresAt = new Date(leaseNow.getTime() + 30_000).toISOString();
      assertLeaseRow(currentRow, lease, leaseNow);
      // oxlint-disable-next-line effecttsgo/global-date -- The write fence uses a fresh native clock after the lease row check.
      const fenceNow = new Date();
      const result = this.db
        .prepare(
          `UPDATE lease SET heartbeat_at=?, expires_at=?
           WHERE singleton=1 AND token=? AND owner_session_id=? AND owner_session_file=? AND expires_at>?`,
        )
        .run(
          heartbeatAt,
          expiresAt,
          lease.token,
          lease.owner.sessionId,
          lease.owner.sessionFile,
          fenceNow.toISOString(),
        );
      if (result.changes !== 1)
        throw new LeaseDecisionRequiredError(
          `Lease for ${lease.runId} is no longer owned by session ${lease.owner.sessionId}.`,
        );
      return { ...lease, heartbeatAt, expiresAt };
    });
  }

  releaseLease(lease: Lease): void {
    this.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM lease WHERE singleton=1 AND token=? AND owner_session_id=? AND owner_session_file=?",
        )
        .run(lease.token, lease.owner.sessionId, lease.owner.sessionFile);
    });
  }

  update(
    lease: Lease,
    mutator: (draft: WorkstreamState, now: Date) => void,
    options: {
      expectedOwner?: SessionIdentity | undefined;
      suppliedNow?: Date | undefined;
      allowedLifecycleStates?: WorkstreamState["lifecycle"]["state"][] | undefined;
    } = {},
  ): WorkstreamState {
    return this.transaction(() => {
      // oxlint-disable-next-line effecttsgo/global-date -- The SQLite lease fence must use native wall-clock time after BEGIN IMMEDIATE, not a domain event timestamp.
      const leaseNow = new Date();
      const transitionNow = options.suppliedNow ?? leaseNow;
      assertLeaseRow(
        this.db.prepare("SELECT * FROM lease WHERE singleton=1").get(),
        lease,
        leaseNow,
      );
      const current = this.state();
      const expectedOwner = options.expectedOwner;
      if (
        expectedOwner !== undefined &&
        (current.coordinator.sessionId !== expectedOwner.sessionId ||
          current.coordinator.sessionFile !== expectedOwner.sessionFile)
      )
        throw new Error("Workstream mutation owner does not match the bound coordinator.");
      const allowed = options.allowedLifecycleStates;
      if (allowed !== undefined && !allowed.includes(current.lifecycle.state))
        throw new Error(`Workstream is ${current.lifecycle.state}.`);
      const draft = structuredClone(current);
      mutator(draft, transitionNow);
      if (JSON.stringify(draft) === JSON.stringify(current)) return structuredClone(current);
      draft.revision = current.revision + 1;
      draft.updatedAt = transitionNow.toISOString();
      validateState(draft);
      // oxlint-disable-next-line effecttsgo/global-date -- The final SQLite lease fence must use a fresh native wall-clock sample after the callback.
      const fenceNow = new Date();
      const result = this.db
        .prepare(
          `UPDATE workstream_state SET state_json=?, revision=?
           WHERE singleton=1 AND revision=? AND EXISTS (
             SELECT 1 FROM lease WHERE singleton=1 AND token=? AND owner_session_id=?
             AND owner_session_file=? AND expires_at>?
           )`,
        )
        .run(
          serializeState(draft),
          draft.revision,
          current.revision,
          lease.token,
          lease.owner.sessionId,
          lease.owner.sessionFile,
          fenceNow.toISOString(),
        );
      if (result.changes !== 1)
        throw new LeaseDecisionRequiredError(
          `Workstream ${current.id} lost its fenced lease before mutation commit.`,
        );
      return structuredClone(draft);
    });
  }

  private stateRow(): StateRow {
    const row = this.db
      .prepare("SELECT state_json, revision FROM workstream_state WHERE singleton=1")
      .get();
    if (!Value.Check(StateRowSchema, row))
      throw new InvalidWorkstreamStateError("Workstream SQLite aggregate is missing or malformed.");
    return Value.Decode(StateRowSchema, row);
  }

  private transaction<A>(run: () => A): A {
    this.db.exec("BEGIN IMMEDIATE");
    let open = true;
    try {
      const value = run();
      this.db.exec("COMMIT");
      open = false;
      return value;
    } catch (cause) {
      if (open) {
        try {
          this.db.exec("ROLLBACK");
        } catch (rollbackCause) {
          throw new WorkstreamStoreOperationError({
            code: "workstream_store_operation_failed",
            message: "SQLite rollback failed after a workstream operation failed.",
            cause: new AggregateError([cause, rollbackCause]),
          });
        }
      }
      throw cause;
    }
  }
}

function chmodPrivateDatabase(path: string): void {
  chmodSync(path, FILE_MODE);
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    const sidecar = `${path}${suffix}`;
    if (existsSync(sidecar)) chmodSync(sidecar, FILE_MODE);
  }
}

function decodeLeaseRow(row: NativeSqliteRow): LeaseRow {
  if (!Value.Check(LeaseRowSchema, row)) throw new Error("Invalid workstream lease row.");
  return Value.Decode(LeaseRowSchema, row);
}

function assertLeaseRow(row: NativeSqliteRow | undefined, lease: Lease, now: Date): void {
  const decoded = row === undefined ? undefined : decodeLeaseRow(row);
  if (
    decoded === undefined ||
    decoded.token !== lease.token ||
    decoded.owner_session_id !== lease.owner.sessionId ||
    decoded.owner_session_file !== lease.owner.sessionFile ||
    decoded.expires_at <= now.toISOString()
  )
    throw new LeaseDecisionRequiredError(`Workstream ${lease.runId} no longer holds a live lease.`);
}

function serializeState(state: WorkstreamState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function readLegacyText(path: string): StoreEffect<string, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* filesystemEffect(
      "read historical workstream state",
      fileSystem.readFileString(path),
    );
  });
}

export function readLegacyObject(path: string): StoreEffect<JsonObject, FileSystem.FileSystem> {
  return readLegacyText(path).pipe(
    Effect.flatMap((text) => domainEffect(() => parsePersistedObject(text))),
  );
}

export function readLegacyCurrentState(
  path: string,
): StoreEffect<WorkstreamState, FileSystem.FileSystem> {
  return readLegacyObject(path).pipe(
    Effect.flatMap((value) =>
      domainEffect(() => {
        if (value.format !== WORKSTREAM_FORMAT || value.version !== WORKSTREAM_STATE_VERSION)
          throw new UnsupportedWorkstreamStateError(value.format, value.version);
        return decodeLegacyState(value, path);
      }),
    ),
  );
}

export function claimWorkstreamDirectory(
  path: string,
  allowExistingWorkstreamDirectory = false,
): StoreEffect<void> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const workstreamDirectory = paths.dirname(path);
    const workstreamsDirectory = paths.dirname(workstreamDirectory);
    const storageDirectory = paths.dirname(workstreamsDirectory);
    const gitCommonDirectory = paths.dirname(storageDirectory);

    yield* domainEffect(() => {
      if (
        paths.basename(path) !== SQLITE_FILENAME ||
        paths.basename(workstreamsDirectory) !== "workstreams" ||
        paths.basename(storageDirectory) !== "pi-workgraph"
      )
        throw new Error(`Workstream state path is outside the known storage layout: ${path}.`);
    });

    const realCommonDirectory = yield* prepareCommonDirectory(gitCommonDirectory);
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

    if (existing[2] === undefined) {
      yield* createOwnedDirectory(fileSystem, workstreamDirectory);
      yield* assertContainedDirectory(paths, realCommonDirectory, workstreamDirectory);
    } else if (!allowExistingWorkstreamDirectory) {
      yield* filesystemEffect(
        "claim new workstream storage directory",
        fileSystem.makeDirectory(workstreamDirectory, { mode: DIRECTORY_MODE }),
      );
    }
  });
}

function prepareCommonDirectory(gitCommonDirectory: string): StoreEffect<string, never> {
  return Effect.gen(function* () {
    const status = yield* lstatOptional(gitCommonDirectory);
    if (status === undefined)
      return yield* storeError(
        "validate Git common directory",
        new Error(`Git common directory does not exist: ${gitCommonDirectory}.`),
      );
    yield* assertDirectoryStatus(gitCommonDirectory, status);
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
    cause instanceof WorkstreamStoreOperationError ||
    cause instanceof LeaseDecisionRequiredError
  )
    return cause;
  return new WorkstreamStoreOperationError({
    code: "workstream_store_operation_failed",
    message: `Failed to ${operation}.`,
    cause,
  });
}

export function isNativeSqliteFile(path: string): boolean {
  try {
    return readFileSync(path, "utf8").startsWith(SQLITE_HEADER);
  } catch {
    return false;
  }
}

export function assertLegacySourceFile(path: string): void {
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink())
    throw new Error(`Legacy workstream state is not an ordinary file: ${path}.`);
}
