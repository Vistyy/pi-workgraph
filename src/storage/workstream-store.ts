import { Clock, Data, DateTime, Effect, FileSystem, Path, type Scope } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { InstantSchema, instantMillis as parseInstantMillis } from "../domain/values.js";
import {
  type CoordinatorIdentity,
  type HerdrDeadObservation,
  HerdrDeadObservationSchema,
  type RepositoryIdentity,
  validateWorkstream,
  validateWorkstreamInvariants,
  type Workstream,
  WorkstreamSchema,
} from "../domain/workstream.js";
import {
  inspectStorageEntry,
  newLeaseToken,
  openWorkstreamDatabase,
  type StorageEntry,
  type WorkstreamDatabase,
} from "./sqlite-host.js";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const LEASE_DURATION_MILLIS = 30_000;
const SQLITE_HEADER = "SQLite format 3\u0000";
const SQLITE_FILENAME = "workstream.sqlite";
const STORE_FORMAT = "pi-workgraph-workstream-sqlite";
const STORE_VERSION = 2;
const STORAGE_DIRECTORY = "pi-workgraph";
const WORKSTREAM_DIRECTORY = "workstreams";
const columnList = (value: string) => value.split(" ");

/** Complete workstream schema contract: each table must exist with these columns. */
const WORKSTREAM_SCHEMA = {
  store_header: columnList("format version"),
  workstream: columnList("state_json revision"),
  lease: columnList(
    "token owner_session_id owner_session_file acquired_at heartbeat_at expires_at",
  ),
};

const CREATE_SCHEMA = `
CREATE TABLE store_header (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  format TEXT NOT NULL,
  version INTEGER NOT NULL
);
CREATE TABLE workstream (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state_json TEXT NOT NULL,
  revision INTEGER NOT NULL
);
CREATE TABLE lease (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  token TEXT NOT NULL,
  owner_session_id TEXT NOT NULL,
  owner_session_file TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;

const HeaderRowSchema = Type.Object(
  { format: Type.String({ minLength: 1 }), version: Type.Integer() },
  { additionalProperties: false },
);
const AggregateRowSchema = Type.Object(
  { state_json: Type.String(), revision: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);
const LeaseOwnerSchema = Type.Object(
  { sessionId: Type.String({ minLength: 1 }), sessionFile: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
const IsoInstantSchema = InstantSchema;
const LeaseRowSchema = Type.Object(
  {
    token: Type.String({ minLength: 1 }),
    owner_session_id: Type.String({ minLength: 1 }),
    owner_session_file: Type.String({ minLength: 1 }),
    acquired_at: IsoInstantSchema,
    heartbeat_at: IsoInstantSchema,
    expires_at: IsoInstantSchema,
  },
  { additionalProperties: false },
);
type HeaderRow = Static<typeof HeaderRowSchema>;
type AggregateRow = Static<typeof AggregateRowSchema>;
type LeaseRow = Static<typeof LeaseRowSchema>;

export interface WorkstreamLease {
  readonly token: string;
  readonly owner: CoordinatorIdentity;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
}

type WorkstreamObservedLease =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly lease: WorkstreamLease };

export interface WorkstreamCoordinatorAdoption {
  readonly repository: RepositoryIdentity;
  readonly workstreamId: string;
  readonly expectedRevision: number;
  readonly priorCoordinator: CoordinatorIdentity;
  readonly coordinator: CoordinatorIdentity;
  readonly observedLease: WorkstreamObservedLease;
  readonly deathObservation: HerdrDeadObservation;
}

export interface WorkstreamCoordinatorAdoptionResult {
  readonly state: Workstream;
  readonly lease: WorkstreamLease;
}

export class WorkstreamStoreInvalidError extends Data.TaggedError("WorkstreamStoreInvalidError")<{
  readonly code: "workstream_store_invalid";
  readonly message: string;
}> {
  constructor(message: string) {
    super({ code: "workstream_store_invalid", message });
  }
}

export class WorkstreamStoreIncompleteError extends Data.TaggedError(
  "WorkstreamStoreIncompleteError",
)<{
  readonly code: "workstream_store_incomplete";
  readonly message: string;
}> {
  constructor(message: string) {
    super({ code: "workstream_store_incomplete", message });
  }
}

export class WorkstreamStoreUnsupportedError extends Data.TaggedError(
  "WorkstreamStoreUnsupportedError",
)<{
  readonly code: "workstream_store_unsupported";
  readonly message: string;
}> {
  constructor(message: string) {
    super({ code: "workstream_store_unsupported", message });
  }
}

export class WorkstreamStoreConflictError extends Data.TaggedError("WorkstreamStoreConflictError")<{
  readonly code: "workstream_store_conflict";
  readonly message: string;
}> {
  constructor(message: string) {
    super({ code: "workstream_store_conflict", message });
  }
}

export class WorkstreamStoreHostError extends Data.TaggedError("WorkstreamStoreHostError")<{
  readonly code: "workstream_store_host_failed";
  readonly operation: string;
  readonly message: string;
  readonly cause: unknown;
}> {
  constructor(operation: string, cause: unknown) {
    super({
      code: "workstream_store_host_failed",
      operation,
      message: `Failed to ${operation}.`,
      cause,
    });
  }
}

export type WorkstreamStoreError =
  | WorkstreamStoreInvalidError
  | WorkstreamStoreIncompleteError
  | WorkstreamStoreUnsupportedError
  | WorkstreamStoreConflictError
  | WorkstreamStoreHostError;

/**
 * One scoped store plus its validated attachment read, so callers never
 * re-read what open/create already established.
 */
export interface WorkstreamStoreAttachment {
  readonly store: WorkstreamStore;
  readonly state: Workstream;
}

/**
 * Unwired workstream persistence for one settled domain Workstream and its lease.
 * Effect owns scope, time, filesystem/path work, interruption, and transaction
 * sequencing; workstream-sqlite-host owns only guarantees unavailable there.
 */
export class WorkstreamStore {
  private constructor(
    readonly path: string,
    readonly id: string,
    readonly repository: RepositoryIdentity,
    private readonly database: WorkstreamDatabase,
  ) {}

  static pathFor(
    repository: RepositoryIdentity,
    id: string,
  ): Effect.Effect<string, WorkstreamStoreInvalidError, Path.Path> {
    return Effect.gen(function* () {
      const paths = yield* Path.Path;
      yield* validateIdentity(paths, repository, id);
      return workstreamPath(paths, repository.gitCommonDir, id);
    });
  }

  /** Persist an already-grounded, invariant-valid revision-0 Workstream verbatim. */
  static create(
    initial: Workstream,
  ): Effect.Effect<
    WorkstreamStoreAttachment,
    WorkstreamStoreError,
    Scope.Scope | FileSystem.FileSystem | Path.Path
  > {
    return Effect.gen(function* () {
      const paths = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* validateInitial(paths, initial);
      const path = workstreamPath(paths, initial.repository.gitCommonDir, initial.id);
      yield* assertGroundedCommonDirectory(initial.repository.gitCommonDir);
      yield* claimStorageDirectories(paths, fileSystem, path);
      const existing = yield* inspect(path);
      if (existing.exists)
        return yield* WorkstreamStore.classifyExisting(fileSystem, path, initial, existing);

      const store = yield* Effect.acquireUseRelease(
        createPrivateDatabaseFile(fileSystem, path),
        () => WorkstreamStore.initialize(path, initial),
        (_, exit) =>
          exit._tag === "Success"
            ? Effect.void
            : platform("remove the incomplete workstream database", fileSystem.remove(path)).pipe(
                Effect.ignore,
              ),
      );
      // The persisted aggregate is exactly the validated initial state, so the
      // caller seeds from the already-known value instead of re-reading it.
      return { store, state: structuredClone(initial) };
    });
  }

  /** Resume only the exact pointer-declared initial creation without deleting retained residue. */
  static resumeCreate(
    initial: Workstream,
  ): Effect.Effect<
    WorkstreamStoreAttachment,
    WorkstreamStoreError,
    Scope.Scope | FileSystem.FileSystem | Path.Path
  > {
    return Effect.gen(function* () {
      const paths = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* validateInitial(paths, initial);
      const path = workstreamPath(paths, initial.repository.gitCommonDir, initial.id);
      yield* assertGroundedCommonDirectory(initial.repository.gitCommonDir);
      yield* claimStorageDirectories(paths, fileSystem, path);
      const existing = yield* inspect(path);
      if (!existing.exists) {
        yield* createPrivateDatabaseFile(fileSystem, path);
        const store = yield* WorkstreamStore.initialize(path, initial);
        return { store, state: structuredClone(initial) };
      }
      if (existing.symbolicLink || !existing.regularFile || existing.mode !== FILE_MODE)
        return yield* invalid(
          `Workstream database residue is not an exact private ordinary file: ${path}.`,
        );
      if (existing.size === 0) {
        const store = yield* WorkstreamStore.initialize(path, initial);
        return { store, state: structuredClone(initial) };
      }
      yield* classifyFileHeader(fileSystem, path);
      const database = yield* acquireDatabase(path);
      if (database.tableNames().length === 0) {
        const store = new WorkstreamStore(
          path,
          initial.id,
          structuredClone(initial.repository),
          database,
        );
        yield* store.initializeEmpty(initial);
        return { store, state: structuredClone(initial) };
      }
      const store = new WorkstreamStore(
        path,
        initial.id,
        structuredClone(initial.repository),
        database,
      );
      const state = yield* store.read();
      if (!Value.Equal(state, initial))
        return yield* new WorkstreamStoreConflictError(
          `Workstream database does not equal its prepared creation declaration: ${path}.`,
        );
      return { store, state };
    });
  }

  static open(
    id: string,
    repository: RepositoryIdentity,
  ): Effect.Effect<
    WorkstreamStoreAttachment,
    WorkstreamStoreError,
    Scope.Scope | FileSystem.FileSystem | Path.Path
  > {
    return Effect.gen(function* () {
      const paths = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* validateIdentity(paths, repository, id);
      const path = workstreamPath(paths, repository.gitCommonDir, id);
      yield* assertGroundedCommonDirectory(repository.gitCommonDir);
      yield* assertPrivateStorage(paths, path);
      yield* classifyFileHeader(fileSystem, path);
      const database = yield* acquireDatabase(path);
      const store = new WorkstreamStore(path, id, structuredClone(repository), database);
      return { store, state: yield* store.read() };
    });
  }

  /** Discover one exact workstream attachment from an explicit untrusted path without writing. */
  static discover(
    statePath: string,
  ): Effect.Effect<
    WorkstreamStoreAttachment,
    WorkstreamStoreError,
    Scope.Scope | FileSystem.FileSystem | Path.Path
  > {
    return Effect.gen(function* () {
      const paths = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      if (!paths.isAbsolute(statePath) || paths.resolve(statePath) !== statePath)
        return yield* invalid("Workstream statePath must be absolute and normalized.");
      yield* assertPrivateStorage(paths, statePath);
      yield* classifyFileHeader(fileSystem, statePath);
      const database = yield* acquireDatabase(statePath, true);
      const state = yield* hostEffect("read the discovered Workstream", () =>
        readWorkstreamAggregate(database),
      );
      yield* validateIdentity(paths, state.repository, state.id);
      yield* assertGroundedCommonDirectory(state.repository.gitCommonDir);
      const expected = workstreamPath(paths, state.repository.gitCommonDir, state.id);
      if (statePath !== expected)
        return yield* invalid(
          "Workstream statePath does not match the aggregate repository and Workstream identity.",
        );
      const store = new WorkstreamStore(
        statePath,
        state.id,
        structuredClone(state.repository),
        database,
      );
      return { store, state: structuredClone(state) };
    });
  }

  /**
   * Classify an already-present workstream path: a complete store is a conflict,
   * while a process-death residue is classified by content instead of being
   * overwritten or reported as an opaque host failure.
   */
  private static classifyExisting(
    fileSystem: FileSystem.FileSystem,
    path: string,
    initial: Workstream,
    entry: StorageEntry,
  ): Effect.Effect<never, WorkstreamStoreError, Scope.Scope> {
    return Effect.gen(function* () {
      if (entry.symbolicLink || !entry.regularFile)
        return yield* invalid(`Workstream database path is not an ordinary file: ${path}.`);
      if (entry.mode !== FILE_MODE)
        return yield* invalid(
          `Workstream database is not private (${modeLabel(entry.mode)}): ${path}.`,
        );
      if (entry.size === 0)
        return yield* new WorkstreamStoreIncompleteError(
          `Workstream database is an incomplete creation residue: ${path}.`,
        );
      yield* classifyFileHeader(fileSystem, path);
      const database = yield* acquireDatabase(path, true);
      const store = new WorkstreamStore(
        path,
        initial.id,
        structuredClone(initial.repository),
        database,
      );
      yield* store.read();
      return yield* new WorkstreamStoreConflictError(
        `Workstream database already exists: ${path}.`,
      );
    });
  }

  private static initialize(
    path: string,
    initial: Workstream,
  ): Effect.Effect<WorkstreamStore, WorkstreamStoreError, Scope.Scope | FileSystem.FileSystem> {
    return Effect.gen(function* () {
      const database = yield* acquireDatabase(path);
      const store = new WorkstreamStore(
        path,
        initial.id,
        structuredClone(initial.repository),
        database,
      );
      yield* store.atomic(() => {
        database.exec(CREATE_SCHEMA);
        database.write(
          "INSERT INTO store_header(singleton,format,version) VALUES(1,?,?)",
          STORE_FORMAT,
          STORE_VERSION,
        );
        database.write(
          "INSERT INTO workstream(singleton,state_json,revision) VALUES(1,?,?)",
          serializeState(initial),
          initial.revision,
        );
      });
      return store;
    });
  }

  private initializeEmpty(
    initial: Workstream,
  ): Effect.Effect<void, WorkstreamStoreError, FileSystem.FileSystem> {
    return this.atomic(() => {
      this.database.exec(CREATE_SCHEMA);
      this.database.write(
        "INSERT INTO store_header(singleton,format,version) VALUES(1,?,?)",
        STORE_FORMAT,
        STORE_VERSION,
      );
      this.database.write(
        "INSERT INTO workstream(singleton,state_json,revision) VALUES(1,?,?)",
        serializeState(initial),
        initial.revision,
      );
    });
  }

  /** Read without normalization, migration, or writes. */
  read(): Effect.Effect<Workstream, WorkstreamStoreError> {
    return hostEffect("read the Workstream", () => this.readAggregate());
  }

  /** Atomically read the authoritative aggregate and prove the exact live lease. */
  readFenced(lease: WorkstreamLease): Effect.Effect<Workstream, WorkstreamStoreError> {
    return validateLeaseInput(lease).pipe(
      Effect.andThen(
        this.transaction((now) => {
          const current = this.readAggregate();
          this.assertHeldLease(lease, now());
          return current;
        }),
      ),
    );
  }

  observeLease(): Effect.Effect<WorkstreamLease | undefined, WorkstreamStoreError> {
    return hostEffect("observe the Workstream lease", () => this.readLeaseRow());
  }

  /**
   * Prove the exact held lease from the lease row alone, without reading or
   * validating the aggregate. Ownership verification never touches task history.
   */
  checkLease(lease: WorkstreamLease): Effect.Effect<void, WorkstreamStoreError> {
    return validateLeaseInput(lease).pipe(
      Effect.andThen(
        Clock.clockWith((clock) =>
          hostEffect("check the Workstream lease", () =>
            this.assertHeldLease(lease, clock.currentTimeMillisUnsafe()),
          ),
        ),
      ),
    );
  }

  acquireLease(
    owner: CoordinatorIdentity,
    observed?: WorkstreamLease,
  ): Effect.Effect<WorkstreamLease, WorkstreamStoreError, FileSystem.FileSystem> {
    if (!Value.Check(LeaseOwnerSchema, owner))
      return Effect.fail(new WorkstreamStoreInvalidError("Lease owner is malformed."));
    return this.atomic((nowMillis) => {
      const current = this.readLeaseRow();
      if (current === undefined) {
        if (observed !== undefined)
          throw new WorkstreamStoreConflictError(
            `Observed lease for ${this.id} no longer matches the store.`,
          );
      } else {
        if (observed === undefined || !sameLease(current, observed))
          throw new WorkstreamStoreConflictError(
            `Workstream ${this.id} already has a fenced lease; takeover requires the exact observed lease.`,
          );
        if (instantMillis(current.expiresAt) > nowMillis)
          throw new WorkstreamStoreConflictError(`Observed lease for ${this.id} has not expired.`);
      }
      const now = isoFromMillis(nowMillis);
      const lease: WorkstreamLease = {
        token: newLeaseToken(),
        owner: structuredClone(owner),
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: isoFromMillis(nowMillis + LEASE_DURATION_MILLIS),
      };
      this.writeLease(lease);
      return lease;
    });
  }

  renewLease(
    lease: WorkstreamLease,
  ): Effect.Effect<WorkstreamLease, WorkstreamStoreError, FileSystem.FileSystem> {
    return validateLeaseInput(lease).pipe(
      Effect.andThen(
        this.atomic((nowMillis) => {
          this.assertHeldLease(lease, nowMillis);
          const heartbeatAt = isoFromMillis(nowMillis);
          const expiresAt = isoFromMillis(nowMillis + LEASE_DURATION_MILLIS);
          const changes = this.database.write(
            `UPDATE lease SET heartbeat_at=?, expires_at=?
               WHERE singleton=1 AND token=? AND owner_session_id=? AND owner_session_file=? AND expires_at>?`,
            heartbeatAt,
            expiresAt,
            lease.token,
            lease.owner.sessionId,
            lease.owner.sessionFile,
            isoFromMillis(nowMillis),
          );
          if (changes !== 1) throw leaseConflict(lease);
          return { ...lease, heartbeatAt, expiresAt };
        }),
      ),
    );
  }

  releaseLease(
    lease: WorkstreamLease,
  ): Effect.Effect<void, WorkstreamStoreError, FileSystem.FileSystem> {
    return validateLeaseInput(lease).pipe(
      Effect.andThen(
        this.atomic(() => {
          const changes = this.database.write(
            "DELETE FROM lease WHERE singleton=1 AND token=? AND owner_session_id=? AND owner_session_file=?",
            lease.token,
            lease.owner.sessionId,
            lease.owner.sessionFile,
          );
          if (changes !== 1) throw leaseConflict(lease);
        }),
      ),
    );
  }

  /** Commit coordinator transfer and successor lease as one aggregate transaction. */
  adoptCoordinator(
    adoption: WorkstreamCoordinatorAdoption,
  ): Effect.Effect<
    WorkstreamCoordinatorAdoptionResult,
    WorkstreamStoreError,
    FileSystem.FileSystem
  > {
    return this.atomic((nowMillis) => {
      const current = this.readAggregate();
      const currentLease = this.readLeaseRow();
      this.validateAdoption(current, currentLease, adoption, nowMillis);
      const committedAt = isoFromMillis(nowMillis);
      const previous = current.coordinatorTransfers.at(-1);
      if (
        previous !== undefined &&
        workstreamInstantMillis(previous.committedAt, "coordinator transfer") >= nowMillis
      )
        throw new WorkstreamStoreConflictError(
          "Coordinator adoption time does not advance transfer history.",
        );
      const next: Workstream = structuredClone(current);
      next.revision = current.revision + 1;
      next.updatedAt = committedAt;
      next.coordinatorTransfers.push({
        from: structuredClone(adoption.priorCoordinator),
        to: structuredClone(adoption.coordinator),
        committedRevision: next.revision,
        committedAt,
        intentCountBoundary: current.intents.length,
        deathObservation: structuredClone(adoption.deathObservation),
      });
      next.coordinator = structuredClone(adoption.coordinator);
      validateWorkstream(next);
      const lease: WorkstreamLease = {
        token: newLeaseToken(),
        owner: structuredClone(adoption.coordinator),
        acquiredAt: committedAt,
        heartbeatAt: committedAt,
        expiresAt: isoFromMillis(nowMillis + LEASE_DURATION_MILLIS),
      };
      const changes = this.database.write(
        "UPDATE workstream SET state_json=?, revision=? WHERE singleton=1 AND revision=?",
        serializeState(next),
        next.revision,
        current.revision,
      );
      if (changes !== 1)
        throw new WorkstreamStoreConflictError("Coordinator adoption aggregate changed.");
      this.writeLease(lease);
      return { state: structuredClone(next), lease };
    });
  }

  private validateAdoption(
    current: Workstream,
    currentLease: WorkstreamLease | undefined,
    adoption: WorkstreamCoordinatorAdoption,
    nowMillis: number,
  ): void {
    this.validateAdoptionAggregate(current, adoption);
    validateAdoptionProof(adoption, nowMillis);
    validateAdoptionLease(currentLease, adoption, nowMillis);
  }

  private validateAdoptionAggregate(
    current: Workstream,
    adoption: WorkstreamCoordinatorAdoption,
  ): void {
    if (
      adoption.workstreamId !== this.id ||
      !Value.Equal(adoption.repository, this.repository) ||
      current.id !== adoption.workstreamId ||
      !Value.Equal(current.repository, adoption.repository)
    )
      throw new WorkstreamStoreConflictError(
        "Coordinator adoption repository or Workstream identity changed.",
      );
    if (current.revision !== adoption.expectedRevision)
      throw new WorkstreamStoreConflictError("Coordinator adoption revision changed.");
    if (!Value.Equal(current.coordinator, adoption.priorCoordinator))
      throw new WorkstreamStoreConflictError("Coordinator adoption prior owner changed.");
    if (Value.Equal(adoption.coordinator, adoption.priorCoordinator))
      throw new WorkstreamStoreInvalidError("Coordinator adoption requires a different successor.");
  }

  /**
   * Persist one settled domain transition. The callback receives a clone of the
   * validated authoritative aggregate; returning that input object is the only
   * no-op. A changed result must be valid at exactly current revision + 1.
   */
  transition(
    lease: WorkstreamLease,
    apply: (current: Workstream) => Workstream,
  ): Effect.Effect<Workstream, WorkstreamStoreError, FileSystem.FileSystem> {
    return validateLeaseInput(lease).pipe(
      Effect.andThen(
        this.atomic((nowMillis, resample) => {
          const current = this.readAggregate();
          this.assertHeldLease(lease, nowMillis);
          const input = structuredClone(current);
          const next = apply(input);
          if (next === input) return structuredClone(current);
          validateTransition(current, next);
          // The callback may consume arbitrary time, so the final lease
          // predicate uses a sample taken only after it returned.
          const changes = this.database.write(
            `UPDATE workstream SET state_json=?, revision=?
             WHERE singleton=1 AND revision=? AND EXISTS (
               SELECT 1 FROM lease WHERE singleton=1 AND token=? AND owner_session_id=?
               AND owner_session_file=? AND expires_at>?
             )`,
            serializeState(next),
            next.revision,
            current.revision,
            lease.token,
            lease.owner.sessionId,
            lease.owner.sessionFile,
            isoFromMillis(resample()),
          );
          if (changes !== 1)
            throw new WorkstreamStoreConflictError(
              `Workstream ${current.id} lost its fenced lease before mutation commit.`,
            );
          return structuredClone(next);
        }),
      ),
    );
  }

  private readAggregate(): Workstream {
    const state = readWorkstreamAggregate(this.database);
    if (state.id !== this.id || !Value.Equal(state.repository, this.repository))
      throw new WorkstreamStoreInvalidError(
        "Workstream store belongs to a foreign repository or Workstream identity.",
      );
    return state;
  }

  private readLeaseRow(): WorkstreamLease | undefined {
    assertWorkstreamSchema(this.database);
    const value = this.database.readRow(
      "SELECT token,owner_session_id,owner_session_file,acquired_at,heartbeat_at,expires_at FROM lease WHERE singleton=1",
    );
    if (value === undefined) return undefined;
    if (!Value.Check(LeaseRowSchema, value))
      throw new WorkstreamStoreInvalidError("Workstream lease row is malformed.");
    const row: LeaseRow = Value.Decode(LeaseRowSchema, value);
    const lease: WorkstreamLease = {
      token: row.token,
      owner: { sessionId: row.owner_session_id, sessionFile: row.owner_session_file },
      acquiredAt: row.acquired_at,
      heartbeatAt: row.heartbeat_at,
      expiresAt: row.expires_at,
    };
    validateLease(lease);
    return lease;
  }

  private writeLease(lease: WorkstreamLease): void {
    this.database.write(
      `INSERT INTO lease(singleton,token,owner_session_id,owner_session_file,acquired_at,heartbeat_at,expires_at)
       VALUES(1,?,?,?,?,?,?)
       ON CONFLICT(singleton) DO UPDATE SET token=excluded.token,
       owner_session_id=excluded.owner_session_id, owner_session_file=excluded.owner_session_file,
       acquired_at=excluded.acquired_at, heartbeat_at=excluded.heartbeat_at, expires_at=excluded.expires_at`,
      lease.token,
      lease.owner.sessionId,
      lease.owner.sessionFile,
      lease.acquiredAt,
      lease.heartbeatAt,
      lease.expiresAt,
    );
  }

  private assertHeldLease(lease: WorkstreamLease, nowMillis: number): void {
    const current = this.readLeaseRow();
    if (current === undefined || !sameLeaseHolder(current, lease)) throw leaseConflict(lease);
    if (instantMillis(current.expiresAt) <= nowMillis)
      throw new WorkstreamStoreConflictError("The fenced Workstream lease has expired.");
  }

  private atomic<A>(
    body: (nowMillis: number, resample: () => number) => A,
  ): Effect.Effect<A, WorkstreamStoreError, FileSystem.FileSystem> {
    return this.transaction((now) => body(now(), now)).pipe(
      Effect.tap(() => secureFiles(this.path)),
    );
  }

  /**
   * Run one write transaction. `BEGIN IMMEDIATE` takes the SQLite write lock
   * before the body samples the Clock, so every decision uses a time read after
   * the lock is held. The native critical section cannot be interrupted, and a
   * failure is rolled back and rethrown with its original typed identity.
   */
  private transaction<A>(run: (now: () => number) => A): Effect.Effect<A, WorkstreamStoreError> {
    return Effect.uninterruptible(
      Clock.clockWith((clock) =>
        hostEffect("run the workstream transaction", () => {
          this.database.exec("BEGIN IMMEDIATE");
          try {
            const value = run(() => clock.currentTimeMillisUnsafe());
            this.database.exec("COMMIT");
            return value;
          } catch (cause) {
            try {
              this.database.exec("ROLLBACK");
            } catch (rollbackCause) {
              throw new WorkstreamStoreHostError(
                "roll back the workstream transaction",
                new AggregateError([cause, rollbackCause]),
              );
            }
            throw cause;
          }
        }),
      ),
    );
  }
}

function assertWorkstreamSchema(database: WorkstreamDatabase): void {
  const tables = database.tableNames();
  for (const [table, columns] of Object.entries(WORKSTREAM_SCHEMA)) {
    if (!tables.includes(table))
      throw new WorkstreamStoreIncompleteError(`Workstream database is missing table: ${table}.`);
    const present = database.columnNames(table);
    const absent = columns.filter((column) => !present.includes(column));
    if (absent.length > 0)
      throw new WorkstreamStoreIncompleteError(
        `Workstream table ${table} lacks: ${absent.join(", ")}.`,
      );
  }
}

function readWorkstreamAggregate(database: WorkstreamDatabase): Workstream {
  assertWorkstreamSchema(database);
  const headerValue = database.readRow(
    "SELECT format, version FROM store_header WHERE singleton=1",
  );
  if (!Value.Check(HeaderRowSchema, headerValue))
    throw new WorkstreamStoreIncompleteError("Workstream store header is missing or malformed.");
  const header: HeaderRow = Value.Decode(HeaderRowSchema, headerValue);
  if (header.format !== STORE_FORMAT || header.version !== STORE_VERSION)
    throw new WorkstreamStoreUnsupportedError("Workstream store header is unsupported.");
  const rowValue = database.readRow(
    "SELECT state_json, revision FROM workstream WHERE singleton=1",
  );
  if (!Value.Check(AggregateRowSchema, rowValue))
    throw new WorkstreamStoreIncompleteError("Workstream row is missing or malformed.");
  const row: AggregateRow = Value.Decode(AggregateRowSchema, rowValue);
  const state = parseWorkstream(row.state_json);
  if (state.revision !== row.revision)
    throw new WorkstreamStoreInvalidError("Workstream revision diverges from its aggregate row.");
  return state;
}

function validateInitial(
  paths: Path.Path,
  initial: Workstream,
): Effect.Effect<void, WorkstreamStoreInvalidError> {
  return domainInvalid("validate initial Workstream", () => {
    validateIdentitySync(paths, initial.repository, initial.id);
    validateWorkstream(initial);
    if (initial.revision !== 0) throw new Error("Initial Workstream revision must be 0.");
  });
}

function validateIdentity(
  paths: Path.Path,
  repository: RepositoryIdentity,
  id: string,
): Effect.Effect<void, WorkstreamStoreInvalidError> {
  return domainInvalid("validate workstream identity", () =>
    validateIdentitySync(paths, repository, id),
  );
}

function validateIdentitySync(paths: Path.Path, repository: RepositoryIdentity, id: string): void {
  const safeSegment = id.length > 0 && id !== "." && id !== ".." && paths.basename(id) === id;
  if (!safeSegment) throw new Error(`Workstream id is not a safe path segment: ${id}.`);
  if (repository.projectRoot.length === 0 || repository.gitCommonDir.length === 0)
    throw new Error("Repository identity paths must be nonempty.");
  if (
    !paths.isAbsolute(repository.projectRoot) ||
    !paths.isAbsolute(repository.gitCommonDir) ||
    paths.resolve(repository.projectRoot) !== repository.projectRoot ||
    paths.resolve(repository.gitCommonDir) !== repository.gitCommonDir
  )
    throw new Error("Repository identity must contain absolute normalized paths.");
}

function validateTransition(current: Workstream, next: Workstream): void {
  for (const key of [
    "format",
    "schemaVersion",
    "id",
    "repository",
    "coordinator",
    "coordinatorTransfers",
    "purpose",
    "createdAt",
  ] as const)
    if (!Value.Equal(next[key], current[key]))
      throw new WorkstreamStoreInvalidError(`Transition cannot rewrite immutable ${key}.`);
  try {
    validateWorkstream(next);
  } catch (cause) {
    throw new WorkstreamStoreInvalidError(
      `Transition returned an invalid Workstream: ${errorMessage(cause)}`,
    );
  }
  if (next.revision !== current.revision + 1)
    throw new WorkstreamStoreInvalidError(
      `Changed transition must return revision ${current.revision + 1}.`,
    );
}

function parseWorkstream(text: string): Workstream {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WorkstreamStoreInvalidError("Workstream is not valid JSON.");
  }
  if (!Value.Check(WorkstreamSchema, value)) {
    const issue = Value.Errors(WorkstreamSchema, value)[0];
    const location = issue?.instancePath;
    throw new WorkstreamStoreInvalidError(
      `Workstream is malformed at ${location === undefined || location === "" ? "/" : location}.`,
    );
  }
  // SAFETY: WorkstreamSchema is transform-free and the value passed its complete structural check.
  const state = value as Workstream;
  try {
    validateWorkstreamInvariants(state);
  } catch (cause) {
    throw new WorkstreamStoreInvalidError(
      `Workstream violates domain invariants: ${errorMessage(cause)}`,
    );
  }
  return state;
}

function workstreamPath(paths: Path.Path, gitCommonDir: string, id: string): string {
  return paths.join(gitCommonDir, STORAGE_DIRECTORY, WORKSTREAM_DIRECTORY, id, SQLITE_FILENAME);
}

function acquireDatabase(
  path: string,
  readOnly = false,
): Effect.Effect<WorkstreamDatabase, WorkstreamStoreError, Scope.Scope> {
  return Effect.acquireRelease(
    hostEffect("open and configure the workstream SQLite database", () =>
      openWorkstreamDatabase(path, readOnly),
    ),
    (database) => Effect.sync(() => database.close()),
  );
}

function createPrivateDatabaseFile(
  fileSystem: FileSystem.FileSystem,
  path: string,
): Effect.Effect<void, WorkstreamStoreError, Scope.Scope> {
  return platform(
    "create the private workstream database file",
    Effect.scoped(fileSystem.open(path, { flag: "wx", mode: FILE_MODE })),
  ).pipe(
    Effect.andThen(platform("set the workstream database mode", fileSystem.chmod(path, FILE_MODE))),
  );
}

function claimStorageDirectories(
  paths: Path.Path,
  fileSystem: FileSystem.FileSystem,
  path: string,
): Effect.Effect<void, WorkstreamStoreError> {
  return Effect.gen(function* () {
    const workstreamDirectory = paths.dirname(path);
    const workstreamsDirectory = paths.dirname(workstreamDirectory);
    const storageDirectory = paths.dirname(workstreamsDirectory);
    const gitCommonDir = paths.dirname(storageDirectory);
    for (const component of [storageDirectory, workstreamsDirectory, workstreamDirectory])
      yield* claimStorageDirectory(fileSystem, component);
    const realBoundary = yield* platform(
      "resolve the Git common directory",
      fileSystem.realPath(gitCommonDir),
    );
    const realWorkstream = yield* platform(
      "resolve the Workstream directory",
      fileSystem.realPath(workstreamDirectory),
    );
    const relative = paths.relative(realBoundary, realWorkstream);
    if (relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative))
      return yield* invalid(`Workstream storage escapes its Git common directory: ${path}.`);
  });
}

function claimStorageDirectory(
  fileSystem: FileSystem.FileSystem,
  path: string,
): Effect.Effect<void, WorkstreamStoreError> {
  return Effect.gen(function* () {
    const entry = yield* inspect(path);
    if (entry.symbolicLink)
      return yield* invalid(`Workstream storage component is a symbolic link: ${path}.`);
    if (entry.exists && !entry.directory)
      return yield* invalid(`Workstream storage component is not a directory: ${path}.`);
    if (entry.exists) {
      if (entry.mode !== DIRECTORY_MODE)
        return yield* invalid(
          `Pre-existing Workstream storage component is unsafe (${modeLabel(entry.mode)}): ${path}.`,
        );
      return;
    }
    yield* platform(
      "create private Workstream storage directory",
      fileSystem.makeDirectory(path, { mode: DIRECTORY_MODE }),
    );
    yield* platform(
      "set private Workstream directory mode",
      fileSystem.chmod(path, DIRECTORY_MODE),
    );
    const created = yield* inspect(path);
    if (!created.directory || created.symbolicLink || created.mode !== DIRECTORY_MODE)
      return yield* invalid(`Created Workstream storage component is unsafe: ${path}.`);
  });
}

function assertGroundedCommonDirectory(path: string): Effect.Effect<void, WorkstreamStoreError> {
  return Effect.gen(function* () {
    const entry = yield* inspect(path);
    if (!entry.exists || !entry.directory || entry.symbolicLink)
      return yield* invalid(`Git common directory is not an ordinary directory: ${path}.`);
  });
}

function assertPrivateStorage(
  paths: Path.Path,
  path: string,
): Effect.Effect<void, WorkstreamStoreError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    for (const directory of [
      paths.dirname(paths.dirname(paths.dirname(path))),
      paths.dirname(paths.dirname(path)),
      paths.dirname(path),
    ])
      yield* assertPrivateDirectory(directory);
    yield* assertPrivateDatabaseFile(paths, path);
  });
}

function assertPrivateDirectory(directory: string): Effect.Effect<void, WorkstreamStoreError> {
  return Effect.gen(function* () {
    const entry = yield* inspect(directory);
    if (!entry.exists || !entry.directory || entry.symbolicLink || entry.mode !== DIRECTORY_MODE)
      return yield* invalid(
        `Workstream storage component is not a private ordinary directory: ${directory}.`,
      );
  });
}

function assertPrivateDatabaseFile(
  paths: Path.Path,
  path: string,
): Effect.Effect<void, WorkstreamStoreError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const file = yield* inspect(path);
    if (!file.exists) return yield* invalid(`Workstream database does not exist: ${path}.`);
    if (file.symbolicLink || !file.regularFile)
      return yield* invalid(`Workstream database is not an ordinary file: ${path}.`);
    if (file.mode !== FILE_MODE)
      return yield* invalid(
        `Workstream database is not private (${modeLabel(file.mode)}): ${path}.`,
      );
    const boundary = paths.dirname(paths.dirname(paths.dirname(paths.dirname(path))));
    const fileSystem = yield* FileSystem.FileSystem;
    const realBoundary = yield* platform(
      "resolve Git common directory",
      fileSystem.realPath(boundary),
    );
    const realFile = yield* platform("resolve workstream database", fileSystem.realPath(path));
    const relative = paths.relative(realBoundary, realFile);
    if (relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative))
      return yield* invalid(`Workstream database escapes its Git common directory: ${path}.`);
  });
}

function classifyFileHeader(
  fileSystem: FileSystem.FileSystem,
  path: string,
): Effect.Effect<void, WorkstreamStoreError> {
  return Effect.gen(function* () {
    const header = yield* platform(
      "read the workstream database header",
      Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fileSystem.open(path, { flag: "r" });
          const bytes = new Uint8Array(16);
          const count = yield* file.read(bytes);
          return bytes.subarray(0, Number(count));
        }),
      ),
    );
    if (header.length === 0)
      return yield* new WorkstreamStoreIncompleteError(
        `Workstream database creation is incomplete: ${path}.`,
      );
    if (new TextDecoder().decode(header) !== SQLITE_HEADER)
      return yield* invalid(`Workstream database is not a supported SQLite file: ${path}.`);
  });
}

function validateAdoptionProof(adoption: WorkstreamCoordinatorAdoption, nowMillis: number): void {
  if (
    !Value.Check(HerdrDeadObservationSchema, adoption.deathObservation) ||
    !Value.Equal(adoption.deathObservation.subject, adoption.priorCoordinator)
  )
    throw new WorkstreamStoreInvalidError(
      "Coordinator adoption requires an exact prior-owner Herdr API dead snapshot.",
    );
  const observedMillis = workstreamInstantMillis(
    adoption.deathObservation.observedAt,
    "Herdr dead observation",
  );
  if (observedMillis > nowMillis)
    throw new WorkstreamStoreInvalidError(
      "Coordinator adoption Herdr dead observation cannot be in the future.",
    );
}

function validateAdoptionLease(
  current: WorkstreamLease | undefined,
  adoption: WorkstreamCoordinatorAdoption,
  nowMillis: number,
): void {
  if (adoption.observedLease.kind === "absent") {
    if (current !== undefined)
      throw new WorkstreamStoreConflictError(
        "An absent lease observation no longer matches the store.",
      );
    return;
  }
  validateLease(adoption.observedLease.lease);
  if (current === undefined || !sameLease(current, adoption.observedLease.lease))
    throw new WorkstreamStoreConflictError("The exact observed adoption lease changed.");
  if (!Value.Equal(current.owner, adoption.priorCoordinator))
    throw new WorkstreamStoreConflictError(
      "The observed adoption lease belongs to another coordinator.",
    );
  if (instantMillis(current.expiresAt) > nowMillis)
    throw new WorkstreamStoreConflictError("The exact observed adoption lease has not expired.");
}

function validateLeaseInput(
  lease: WorkstreamLease,
): Effect.Effect<void, WorkstreamStoreInvalidError> {
  return domainInvalid("validate lease", () => validateLease(lease));
}

function validateLease(lease: WorkstreamLease): void {
  if (lease.token.length === 0 || !Value.Check(LeaseOwnerSchema, lease.owner))
    throw new WorkstreamStoreInvalidError("Workstream lease identity is malformed.");
  for (const instant of [lease.acquiredAt, lease.heartbeatAt, lease.expiresAt])
    instantMillis(instant);
}

function instantMillis(value: string): number {
  return workstreamInstantMillis(value, "lease");
}

function workstreamInstantMillis(value: string, subject: string): number {
  try {
    return parseInstantMillis(value);
  } catch {
    throw new WorkstreamStoreInvalidError(
      `Workstream ${subject} contains an invalid instant: ${value}.`,
    );
  }
}

function sameLease(left: WorkstreamLease, right: WorkstreamLease): boolean {
  return (
    sameLeaseHolder(left, right) &&
    left.acquiredAt === right.acquiredAt &&
    left.heartbeatAt === right.heartbeatAt &&
    left.expiresAt === right.expiresAt
  );
}

function sameLeaseHolder(left: WorkstreamLease, right: WorkstreamLease): boolean {
  return left.token === right.token && Value.Equal(left.owner, right.owner);
}

function leaseConflict(lease: WorkstreamLease): WorkstreamStoreConflictError {
  return new WorkstreamStoreConflictError(
    `Session ${lease.owner.sessionId} does not hold this store's fenced lease.`,
  );
}

function serializeState(state: Workstream): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function isoFromMillis(millis: number): string {
  return DateTime.toDate(DateTime.makeUnsafe(millis)).toISOString();
}

function inspect(path: string): Effect.Effect<StorageEntry, WorkstreamStoreError> {
  return hostEffect("inspect storage entry without following links", () =>
    inspectStorageEntry(path),
  );
}

/** Contain the database and any journal/WAL sidecars to 0600 through Effect FileSystem. */
function secureFiles(
  path: string,
): Effect.Effect<void, WorkstreamStoreError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const target = `${path}${suffix}`;
      if (suffix !== "" && !(yield* platform(`inspect ${target}`, fileSystem.exists(target))))
        continue;
      yield* platform(`secure ${target}`, fileSystem.chmod(target, FILE_MODE));
    }
  });
}

function modeLabel(mode: number): string {
  return `0${mode.toString(8).padStart(3, "0")}`;
}

function hostEffect<A>(operation: string, run: () => A): Effect.Effect<A, WorkstreamStoreError> {
  return Effect.try({ try: run, catch: (cause) => toStoreError(cause, operation) });
}

function platform<A, R>(
  operation: string,
  effect: Effect.Effect<A, PlatformError, R>,
): Effect.Effect<A, WorkstreamStoreError, R> {
  return effect.pipe(Effect.mapError((cause) => new WorkstreamStoreHostError(operation, cause)));
}

function domainInvalid<A>(
  operation: string,
  run: () => A,
): Effect.Effect<A, WorkstreamStoreInvalidError> {
  return Effect.try({
    try: run,
    catch: (cause) =>
      cause instanceof WorkstreamStoreInvalidError
        ? cause
        : new WorkstreamStoreInvalidError(`${operation}: ${errorMessage(cause)}`),
  });
}

function invalid(message: string): Effect.Effect<never, WorkstreamStoreInvalidError> {
  return Effect.fail(new WorkstreamStoreInvalidError(message));
}

function toStoreError(cause: unknown, operation: string): WorkstreamStoreError {
  if (
    cause instanceof WorkstreamStoreInvalidError ||
    cause instanceof WorkstreamStoreIncompleteError ||
    cause instanceof WorkstreamStoreUnsupportedError ||
    cause instanceof WorkstreamStoreConflictError ||
    cause instanceof WorkstreamStoreHostError
  )
    return cause;
  return new WorkstreamStoreHostError(operation, cause);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message.slice(0, 300) : "unspecified failure";
}
