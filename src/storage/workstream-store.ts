/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-widen-then-assert, anti-slop/require-safety-comment-for-type-assertion -- node:sqlite exposes untyped host rows; this boundary assembles them once and validates the complete strict Workstream schema before returning domain data. */
import { Clock, Data, Effect, FileSystem, Path, type Scope } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { Value } from "typebox/value";
import type {
  Attempt,
  AttemptKey,
  Completion,
  CoordinatorIdentity,
  Intent,
  RepositoryIdentity,
  Suspension,
  Task,
  Workstream,
} from "../domain/workstream.js";
import {
  AttemptSchema,
  IntentSchema,
  TaskSchema,
  validateWorkstream,
  validateWorkstreamInvariants,
  WorkstreamSchema,
} from "../domain/workstream.js";
import {
  inspectStorageEntry,
  openWorkstreamDatabase,
  type StorageEntry,
  type WorkstreamDatabase,
} from "./sqlite-host.js";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const SQLITE_HEADER = "SQLite format 3\u0000";
const SQLITE_FILENAME = "workstream.sqlite";
const STORE_FORMAT = "pi-workgraph-record-store";
const STORE_VERSION = 1;
const STORAGE_DIRECTORY = "pi-workgraph";
const WORKSTREAM_DIRECTORY = "workstreams";
const columns = (value: string) => value.split(" ");

const RECORD_SCHEMA = {
  store_header: columns("format version"),
  metadata: columns(
    "id purpose project_root git_common_dir owner_session_id owner_session_file revision lifecycle suspension_json completion_json created_at updated_at",
  ),
  intents: columns("intent_index intent_json"),
  tasks: columns("task_id intent_index kind contract_json"),
  attempts: columns("attempt_id task_id sequence operational_json"),
  outcomes: columns("outcome_id attempt_id outcome_json"),
  deliveries: columns("outcome_id delivery_json"),
};

const CREATE_SCHEMA = `
CREATE TABLE store_header (singleton INTEGER PRIMARY KEY CHECK(singleton=1), format TEXT NOT NULL, version INTEGER NOT NULL) STRICT;
CREATE TABLE metadata (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, purpose TEXT NOT NULL,
 project_root TEXT NOT NULL, git_common_dir TEXT NOT NULL, owner_session_id TEXT NOT NULL,
 owner_session_file TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0),
 lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','suspended','completed')),
 suspension_json TEXT, completion_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE intents (intent_index INTEGER PRIMARY KEY CHECK(intent_index>=0), intent_json TEXT NOT NULL) STRICT;
CREATE TABLE tasks (task_id TEXT PRIMARY KEY, intent_index INTEGER NOT NULL REFERENCES intents(intent_index), kind TEXT NOT NULL, contract_json TEXT NOT NULL) STRICT;
CREATE TABLE attempts (attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), sequence INTEGER NOT NULL CHECK(sequence>=0), operational_json TEXT NOT NULL, UNIQUE(task_id,sequence)) STRICT;
CREATE TABLE outcomes (outcome_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id), outcome_json TEXT NOT NULL) STRICT;
CREATE TABLE deliveries (outcome_id TEXT PRIMARY KEY REFERENCES outcomes(outcome_id), delivery_json TEXT NOT NULL) STRICT;
`;

export class WorkstreamStoreInvalidError extends Data.TaggedError("WorkstreamStoreInvalidError")<{
  readonly code: "workstream_store_invalid";
  readonly message: string;
}> {
  constructor(message: string) {
    super({ code: "workstream_store_invalid", message });
  }
}
class WorkstreamStoreIncompleteError extends Data.TaggedError("WorkstreamStoreIncompleteError")<{
  readonly code: "workstream_store_incomplete";
  readonly message: string;
}> {
  constructor(message: string) {
    super({ code: "workstream_store_incomplete", message });
  }
}
export class WorkstreamStoreUnsupportedError extends Data.TaggedError(
  "WorkstreamStoreUnsupportedError",
)<{ readonly code: "workstream_store_unsupported"; readonly message: string }> {
  constructor(message: string) {
    super({ code: "workstream_store_unsupported", message });
  }
}
class WorkstreamStoreConflictError extends Data.TaggedError("WorkstreamStoreConflictError")<{
  readonly code: "workstream_store_conflict";
  readonly message: string;
}> {
  constructor(message: string) {
    super({ code: "workstream_store_conflict", message });
  }
}
class WorkstreamStoreHostError extends Data.TaggedError("WorkstreamStoreHostError")<{
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

export interface WorkstreamStoreAttachment {
  readonly store: WorkstreamStore;
  readonly state: Workstream;
}

export type WorkstreamRecordMutation = Readonly<
  | { kind: "append_intent"; intent: Intent; updatedAt: string }
  | { kind: "create_task"; task: Task; updatedAt: string }
  | { kind: "append_attempts"; taskId: string; attempts: readonly Attempt[]; updatedAt: string }
  | {
      kind: "update_attempt";
      key: AttemptKey;
      attempt: Attempt;
      completion?: Completion;
      updatedAt: string;
    }
  | {
      kind: "update_lifecycle";
      lifecycle: Workstream["lifecycle"];
      suspension?: Suspension;
      completion?: Completion;
      updatedAt: string;
    }
>;

export interface AttemptRecords {
  readonly revision: number;
  readonly lifecycle: Workstream["lifecycle"];
  readonly workstreamId: string;
  readonly repository: RepositoryIdentity;
  readonly currentIntentIndex: number;
  readonly suspension?: Suspension;
  readonly completion?: Completion;
  readonly intent: Intent;
  readonly task: Task;
  readonly attempt: Attempt;
}

export interface ActionableRecords {
  readonly lifecycle: Workstream["lifecycle"];
  readonly currentIntentIndex: number;
  readonly records: readonly Readonly<{ task: Task; attempt: Attempt }>[];
}
/** Private record store. Full assembly is reserved for inspection and pure-domain validation. */
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
      validateIdentity(paths, repository, id);
      return workstreamPath(paths, repository.gitCommonDir, id);
    });
  }

  static create(
    initial: Workstream,
  ): Effect.Effect<
    WorkstreamStoreAttachment,
    WorkstreamStoreError,
    Scope.Scope | FileSystem.FileSystem | Path.Path
  > {
    return Effect.gen(function* () {
      const paths = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      validateInitial(paths, initial);
      const path = workstreamPath(paths, initial.repository.gitCommonDir, initial.id);
      yield* claimStorageDirectories(paths, fs, path);
      const entry = yield* inspect(path);
      if (entry.exists)
        return yield* new WorkstreamStoreConflictError(
          `Workstream database already exists: ${path}.`,
        );
      yield* createPrivateDatabaseFile(fs, path);
      return yield* Effect.onError(WorkstreamStore.initialize(path, initial), () =>
        platform("remove incomplete workstream database", fs.remove(path)).pipe(Effect.ignore),
      );
    });
  }

  /** Recover only absent/empty creation residue, or attach an exact valid advanced store without resetting it. */
  static resumeCreate(
    initial: Workstream,
  ): Effect.Effect<
    WorkstreamStoreAttachment,
    WorkstreamStoreError,
    Scope.Scope | FileSystem.FileSystem | Path.Path
  > {
    return Effect.gen(function* () {
      const paths = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      validateInitial(paths, initial);
      const path = workstreamPath(paths, initial.repository.gitCommonDir, initial.id);
      yield* claimStorageDirectories(paths, fs, path);
      const entry = yield* inspect(path);
      if (!entry.exists) yield* createPrivateDatabaseFile(fs, path);
      else if (entry.symbolicLink || !entry.regularFile || entry.mode !== FILE_MODE)
        return yield* invalid(
          `Workstream creation residue is not a private ordinary file: ${path}.`,
        );
      if (!entry.exists || entry.size === 0)
        return yield* WorkstreamStore.initialize(path, initial);
      yield* classifyFileHeader(fs, path);
      const attached = yield* WorkstreamStore.openAt(path, false);
      if (
        attached.state.id !== initial.id ||
        !Value.Equal(attached.state.repository, initial.repository) ||
        !Value.Equal(attached.state.coordinator, initial.coordinator)
      )
        return yield* new WorkstreamStoreConflictError(
          "Advanced creation recovery identity does not match the prepared Workstream.",
        );
      return attached;
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
      validateIdentity(paths, repository, id);
      const path = workstreamPath(paths, repository.gitCommonDir, id);
      yield* assertPrivateStorage(paths, path);
      const attached = yield* WorkstreamStore.openAt(path, false);
      if (attached.state.id !== id || !Value.Equal(attached.state.repository, repository))
        return yield* invalid("Workstream store has a foreign identity.");
      return attached;
    });
  }

  static discover(
    path: string,
  ): Effect.Effect<
    WorkstreamStoreAttachment,
    WorkstreamStoreError,
    Scope.Scope | FileSystem.FileSystem | Path.Path
  > {
    return Effect.gen(function* () {
      const paths = yield* Path.Path;
      if (!paths.isAbsolute(path) || paths.resolve(path) !== path)
        return yield* invalid("Workstream statePath must be absolute and normalized.");
      yield* assertPrivateStorage(paths, path);
      const attached = yield* WorkstreamStore.openAt(path, true);
      validateIdentity(paths, attached.state.repository, attached.state.id);
      if (workstreamPath(paths, attached.state.repository.gitCommonDir, attached.state.id) !== path)
        return yield* invalid("Workstream statePath does not match its record identity.");
      return attached;
    });
  }

  private static openAt(
    path: string,
    readOnly: boolean,
  ): Effect.Effect<
    WorkstreamStoreAttachment,
    WorkstreamStoreError,
    Scope.Scope | FileSystem.FileSystem
  > {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* classifyFileHeader(fs, path);
      const database = yield* acquireDatabase(path, readOnly);
      assertRecordSchema(database);
      assertHeader(database);
      const state = readRecords(database);
      return {
        store: new WorkstreamStore(path, state.id, structuredClone(state.repository), database),
        state,
      };
    });
  }

  private static initialize(
    path: string,
    initial: Workstream,
  ): Effect.Effect<
    WorkstreamStoreAttachment,
    WorkstreamStoreError,
    Scope.Scope | FileSystem.FileSystem
  > {
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
        writeRecords(database, initial);
      });
      return { store, state: structuredClone(initial) };
    });
  }

  /** Assemble the complete immutable inspection view; command paths should prefer keyed reads. */
  read(): Effect.Effect<Workstream, WorkstreamStoreError> {
    return hostEffect("read Workstream records", () => this.readChecked());
  }

  /** Query only rows whose durable state can produce reconciliation work. */
  readActionable(): Effect.Effect<ActionableRecords, WorkstreamStoreError> {
    return hostEffect("read actionable Workstream records", () => {
      const metadata = requiredRow(
        this.database.readRow(
          "SELECT lifecycle,(SELECT max(intent_index) FROM intents) AS current_intent FROM metadata WHERE singleton=1",
        ),
        "metadata",
      );
      const lifecycle = stringField(metadata, "lifecycle") as Workstream["lifecycle"];
      if (lifecycle !== "active" && lifecycle !== "suspended" && lifecycle !== "completed")
        throw new WorkstreamStoreInvalidError("lifecycle is malformed.");
      const currentIntentIndex = numberField(metadata, "current_intent");
      const rows = this.database.readRows(
        `SELECT t.contract_json,a.operational_json,o.outcome_json,d.delivery_json
         FROM attempts a JOIN tasks t ON t.task_id=a.task_id
         LEFT JOIN outcomes o ON o.attempt_id=a.attempt_id
         LEFT JOIN deliveries d ON d.outcome_id=o.outcome_id
         WHERE json_extract(a.operational_json,'$.state') IN ('queued','active')
            OR (json_extract(a.operational_json,'$.state')='finished' AND
                (json_extract(d.delivery_json,'$.state')='pending'
                 OR (json_extract(a.operational_json,'$.execution.placement') IS NOT NULL AND
                     (json_extract(a.operational_json,'$.cleanup') IS NULL OR json_extract(a.operational_json,'$.cleanup.state')='pending'))))
         ORDER BY a.rowid`,
      );
      const records = rows.map((row) => {
        const operational = parseJson(stringField(row, "operational_json")) as Record<
          string,
          unknown
        >;
        // biome-ignore lint/complexity/useLiteralKeys: node:sqlite rows are index-signature records under strict TypeScript.
        const outcomeValue = row["outcome_json"];
        const attemptValue =
          outcomeValue === null
            ? operational
            : {
                ...operational,
                outcome: {
                  ...(parseJson(stringField(row, "outcome_json")) as Record<string, unknown>),
                  delivery: parseJson(stringField(row, "delivery_json")),
                },
              };
        const taskValue = {
          ...(parseJson(stringField(row, "contract_json")) as Record<string, unknown>),
          attempts: [attemptValue],
        };
        if (!Value.Check(TaskSchema, taskValue) || !Value.Check(AttemptSchema, attemptValue))
          throw new WorkstreamStoreInvalidError("Actionable Task or Attempt record is malformed.");
        return {
          task: structuredClone(taskValue as Task),
          attempt: structuredClone(attemptValue as Attempt),
        };
      });
      return { lifecycle, currentIntentIndex, records };
    });
  }

  /** Minimal current-Intent projection for queue planning; it contains no Task scan. */
  readPlanningState(): Effect.Effect<Workstream, WorkstreamStoreError> {
    return hostEffect("read Workstream planning metadata", () => {
      const row = requiredRow(
        this.database.readRow(
          `SELECT m.*,(SELECT max(intent_index) FROM intents) AS current_intent,
                  (SELECT intent_json FROM intents ORDER BY intent_index DESC LIMIT 1) AS intent_json
           FROM metadata m WHERE singleton=1`,
        ),
        "metadata",
      );
      const currentIntentIndex = numberField(row, "current_intent");
      const intent = parseJson(stringField(row, "intent_json"));
      if (!Value.Check(IntentSchema, intent))
        throw new WorkstreamStoreInvalidError("Current Intent record is malformed.");
      return {
        format: "pi-workgraph-workstream",
        schemaVersion: 3,
        revision: numberField(row, "revision"),
        id: stringField(row, "id"),
        purpose: stringField(row, "purpose"),
        repository: {
          projectRoot: stringField(row, "project_root"),
          gitCommonDir: stringField(row, "git_common_dir"),
        },
        coordinator: {
          sessionId: stringField(row, "owner_session_id"),
          sessionFile: stringField(row, "owner_session_file"),
        },
        lifecycle: stringField(row, "lifecycle") as Workstream["lifecycle"],
        ...nullableJson(row, "suspension_json", "suspension"),
        intents: Array.from({ length: currentIntentIndex + 1 }, () =>
          structuredClone(intent as Intent),
        ),
        tasks: [],
        ...nullableJson(row, "completion_json", "completion"),
        createdAt: stringField(row, "created_at"),
        updatedAt: stringField(row, "updated_at"),
      };
    });
  }

  /** Query only Tasks that can affect completion accounting or candidate inclusion. */
  readCompletionState(): Effect.Effect<Workstream, WorkstreamStoreError> {
    return Effect.gen(
      function* (this: WorkstreamStore) {
        const state = yield* this.readPlanningState();
        const taskIds = yield* hostEffect("read completion-related Task keys", () =>
          this.database
            .readRows(
              `SELECT DISTINCT a.task_id FROM attempts a
               JOIN tasks t ON t.task_id=a.task_id
               LEFT JOIN outcomes o ON o.attempt_id=a.attempt_id
               LEFT JOIN deliveries d ON d.outcome_id=o.outcome_id
               WHERE json_extract(a.operational_json,'$.state')!='finished'
                  OR coalesce(json_extract(d.delivery_json,'$.state'),'pending')!='delivered'
                  OR json_extract(a.operational_json,'$.application.state') IN ('pending','blocked','applied')
                  OR (json_extract(a.operational_json,'$.execution.placement') IS NOT NULL AND
                      (json_extract(a.operational_json,'$.cleanup.state')!='completed'
                       OR coalesce(json_extract(a.operational_json,'$.cleanup.workerClosed'),0)!=1))
                  OR (json_extract(a.operational_json,'$.execution.placement.kind')='isolated_worktree'
                      AND coalesce(json_extract(a.operational_json,'$.outputRelease.state'),'')!='completed')
               ORDER BY a.task_id`,
            )
            .map((row) => stringField(row, "task_id")),
        );
        state.tasks.push(...(yield* Effect.forEach(taskIds, (id) => this.readTask(id))));
        return state;
      }.bind(this),
    );
  }

  taskExists(taskId: string): Effect.Effect<boolean, WorkstreamStoreError> {
    return hostEffect(
      "read keyed Task identity",
      () =>
        this.database.readRow("SELECT task_id FROM tasks WHERE task_id=?", taskId) !== undefined,
    );
  }

  readTask(taskId: string): Effect.Effect<Task, WorkstreamStoreError> {
    return Effect.gen(
      function* (this: WorkstreamStore) {
        const ids = yield* hostEffect("read Task Attempt keys", () =>
          this.database
            .readRows("SELECT attempt_id FROM attempts WHERE task_id=? ORDER BY sequence", taskId)
            .map((row) => stringField(row, "attempt_id")),
        );
        if (ids.length === 0)
          return yield* new WorkstreamStoreConflictError(`Unknown Task ${taskId}.`);
        const records = yield* Effect.forEach(ids, (id) => this.readAttempt(taskId, id));
        const first = records[0];
        if (first === undefined)
          return yield* new WorkstreamStoreConflictError(`Unknown Task ${taskId}.`);
        return { ...first.task, attempts: records.map((record) => record.attempt) } as Task;
      }.bind(this),
    );
  }

  readAttemptForOutcome(outcomeId: string): Effect.Effect<AttemptRecords, WorkstreamStoreError> {
    return Effect.flatMap(
      hostEffect("read Outcome Attempt key", () => {
        const row = this.database.readRow(
          "SELECT a.task_id,a.attempt_id FROM outcomes o JOIN attempts a ON a.attempt_id=o.attempt_id WHERE o.outcome_id=?",
          outcomeId,
        );
        if (row === undefined)
          throw new WorkstreamStoreConflictError(`Unknown Outcome ${outcomeId}.`);
        return { taskId: stringField(row, "task_id"), attemptId: stringField(row, "attempt_id") };
      }),
      (key) => this.readAttempt(key.taskId, key.attemptId),
    );
  }

  readRevision(): Effect.Effect<number, WorkstreamStoreError> {
    return hostEffect("read Workstream revision", () =>
      integerField(
        this.database.readRow("SELECT revision FROM metadata WHERE singleton=1"),
        "revision",
      ),
    );
  }

  readAttempt(
    taskId: string | undefined,
    attemptId: string,
  ): Effect.Effect<AttemptRecords, WorkstreamStoreError> {
    return hostEffect("read keyed Attempt context", () => {
      const statement = `SELECT m.id,m.project_root,m.git_common_dir,m.revision,m.lifecycle,m.suspension_json,m.completion_json,
                (SELECT max(intent_index) FROM intents) AS current_intent,
                i.intent_json,t.contract_json,a.operational_json,o.outcome_json,d.delivery_json
         FROM attempts a JOIN tasks t ON t.task_id=a.task_id
         JOIN intents i ON i.intent_index=t.intent_index JOIN metadata m ON m.singleton=1
         LEFT JOIN outcomes o ON o.attempt_id=a.attempt_id
         LEFT JOIN deliveries d ON d.outcome_id=o.outcome_id
         WHERE ${taskId === undefined ? "a.attempt_id=?" : "t.task_id=? AND a.attempt_id=?"}`;
      const row =
        taskId === undefined
          ? this.database.readRow(statement, attemptId)
          : this.database.readRow(statement, taskId, attemptId);
      if (row === undefined)
        throw new WorkstreamStoreConflictError(`Unknown Attempt ${attemptId}.`);
      const operational = parseJson(stringField(row, "operational_json")) as Record<
        string,
        unknown
      >;
      const attemptValue =
        // biome-ignore lint/complexity/useLiteralKeys: node:sqlite rows are index-signature records under strict TypeScript.
        row["outcome_json"] === null
          ? operational
          : {
              ...operational,
              outcome: {
                ...(parseJson(stringField(row, "outcome_json")) as Record<string, unknown>),
                delivery: parseJson(stringField(row, "delivery_json")),
              },
            };
      const taskValue = {
        ...(parseJson(stringField(row, "contract_json")) as Record<string, unknown>),
        attempts: [attemptValue],
      };
      const intentValue = parseJson(stringField(row, "intent_json"));
      if (
        !Value.Check(IntentSchema, intentValue) ||
        !Value.Check(TaskSchema, taskValue) ||
        !Value.Check(AttemptSchema, attemptValue)
      )
        throw new WorkstreamStoreInvalidError("Keyed Attempt records are malformed.");
      const lifecycle = {
        ...nullableJson(row, "suspension_json", "suspension"),
        ...nullableJson(row, "completion_json", "completion"),
      } as { suspension?: Suspension; completion?: Completion };
      return {
        revision: numberField(row, "revision"),
        lifecycle: stringField(row, "lifecycle") as Workstream["lifecycle"],
        workstreamId: stringField(row, "id"),
        repository: {
          projectRoot: stringField(row, "project_root"),
          gitCommonDir: stringField(row, "git_common_dir"),
        },
        currentIntentIndex: numberField(row, "current_intent"),
        ...lifecycle,
        intent: structuredClone(intentValue as Intent),
        task: structuredClone(taskValue as Task),
        attempt: structuredClone(attemptValue as Attempt),
      };
    });
  }

  readOutcome(
    outcomeId: string,
  ): Effect.Effect<NonNullable<Attempt["outcome"]>, WorkstreamStoreError> {
    return hostEffect("read keyed Outcome record", () => {
      const row = this.database.readRow(
        `SELECT o.outcome_json,d.delivery_json FROM outcomes o
         JOIN deliveries d ON d.outcome_id=o.outcome_id WHERE o.outcome_id=?`,
        outcomeId,
      );
      if (row === undefined)
        throw new WorkstreamStoreConflictError(`Unknown Outcome ${outcomeId}.`);
      const value = {
        ...(parseJson(stringField(row, "outcome_json")) as Record<string, unknown>),
        delivery: parseJson(stringField(row, "delivery_json")),
      };
      return structuredClone(value as NonNullable<Attempt["outcome"]>);
    });
  }

  /** Apply one purpose-specific record mutation with an owner/revision fence. */
  mutateRecords(
    owner: CoordinatorIdentity,
    expectedRevision: number,
    mutation: WorkstreamRecordMutation,
  ): Effect.Effect<number, WorkstreamStoreError, FileSystem.FileSystem> {
    return this.atomic(() => {
      const metadata = requiredRow(
        this.database.readRow(
          "SELECT owner_session_id,owner_session_file,revision FROM metadata WHERE singleton=1",
        ),
        "metadata",
      );
      if (
        stringField(metadata, "owner_session_id") !== owner.sessionId ||
        stringField(metadata, "owner_session_file") !== owner.sessionFile
      )
        throw new WorkstreamStoreConflictError("Workstream owner changed during mutation.");
      const revision = numberField(metadata, "revision");
      if (revision !== expectedRevision)
        throw new WorkstreamStoreConflictError(
          `Expected revision ${expectedRevision}, found ${revision}.`,
        );
      applyRecordMutation(this.database, mutation);
      const nextRevision = revision + 1;
      const changed = this.database.write(
        "UPDATE metadata SET revision=?,updated_at=? WHERE singleton=1 AND revision=? AND owner_session_id=? AND owner_session_file=?",
        nextRevision,
        mutation.updatedAt,
        revision,
        owner.sessionId,
        owner.sessionFile,
      );
      if (changed !== 1)
        throw new WorkstreamStoreConflictError("Workstream revision changed during mutation.");
      return nextRevision;
    });
  }

  private readChecked(): Workstream {
    const state = readRecords(this.database);
    if (state.id !== this.id || !Value.Equal(state.repository, this.repository))
      throw new WorkstreamStoreInvalidError("Workstream store has a foreign identity.");
    return state;
  }

  private atomic<A>(
    body: (nowMillis: number) => A,
  ): Effect.Effect<A, WorkstreamStoreError, FileSystem.FileSystem> {
    return Effect.uninterruptible(
      Clock.clockWith((clock) =>
        hostEffect("run Workstream record transaction", () => {
          this.database.exec("BEGIN IMMEDIATE");
          try {
            const value = body(clock.currentTimeMillisUnsafe());
            this.database.exec("COMMIT");
            return value;
          } catch (cause) {
            try {
              this.database.exec("ROLLBACK");
            } catch (rollback) {
              throw new WorkstreamStoreHostError(
                "roll back Workstream record transaction",
                new AggregateError([cause, rollback]),
              );
            }
            throw cause;
          }
        }),
      ),
    ).pipe(Effect.tap(() => secureFiles(this.path)));
  }
}

function writeRecords(database: WorkstreamDatabase, state: Workstream): void {
  database.write(
    `INSERT INTO metadata(singleton,id,purpose,project_root,git_common_dir,owner_session_id,owner_session_file,revision,lifecycle,suspension_json,completion_json,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?)`,
    state.id,
    state.purpose,
    state.repository.projectRoot,
    state.repository.gitCommonDir,
    state.coordinator.sessionId,
    state.coordinator.sessionFile,
    state.revision,
    state.lifecycle,
    optionalJson(state.suspension),
    optionalJson(state.completion),
    state.createdAt,
    state.updatedAt,
  );
  state.intents.forEach((value, index) => {
    database.write("INSERT INTO intents(intent_index,intent_json) VALUES(?,?)", index, json(value));
  });
  for (const task of state.tasks) {
    const { attempts, ...contract } = task;
    database.write(
      "INSERT INTO tasks(task_id,intent_index,kind,contract_json) VALUES(?,?,?,?)",
      task.id,
      task.intentIndex,
      task.kind,
      json(contract),
    );
    attempts.forEach((attempt, sequence) => {
      const { outcome, ...operational } = attempt;
      database.write(
        "INSERT INTO attempts(attempt_id,task_id,sequence,operational_json) VALUES(?,?,?,?)",
        attempt.id,
        task.id,
        sequence,
        json(operational),
      );
      if (outcome !== undefined) {
        const { delivery, ...immutableOutcome } = outcome;
        database.write(
          "INSERT INTO outcomes(outcome_id,attempt_id,outcome_json) VALUES(?,?,?)",
          outcome.id,
          attempt.id,
          json(immutableOutcome),
        );
        database.write(
          "INSERT INTO deliveries(outcome_id,delivery_json) VALUES(?,?)",
          outcome.id,
          json(delivery),
        );
      }
    });
  }
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the closed mutation union keeps each table-owned transaction explicit.
function applyRecordMutation(
  database: WorkstreamDatabase,
  mutation: WorkstreamRecordMutation,
): void {
  switch (mutation.kind) {
    case "append_intent": {
      if (!Value.Check(IntentSchema, mutation.intent))
        throw new WorkstreamStoreInvalidError("Intent record is malformed.");
      const row = requiredRow(
        database.readRow(
          "SELECT lifecycle,(SELECT max(intent_index) FROM intents) AS current_intent FROM metadata WHERE singleton=1",
        ),
        "metadata",
      );
      if (stringField(row, "lifecycle") !== "active")
        throw new WorkstreamStoreConflictError(
          "Cannot revise Intent outside an active Workstream.",
        );
      if (
        mutation.intent.grounding.kind !== "human_input_receipt" ||
        mutation.intent.grounding.sessionId !==
          stringField(metadataOwner(database), "owner_session_id") ||
        mutation.intent.grounding.sessionFile !==
          stringField(metadataOwner(database), "owner_session_file")
      )
        throw new WorkstreamStoreConflictError(
          "Revised Intent requires a direct receipt from the current owner.",
        );
      database.write(
        "INSERT INTO intents(intent_index,intent_json) VALUES(?,?)",
        numberField(row, "current_intent") + 1,
        json(mutation.intent),
      );
      return;
    }
    case "create_task": {
      if (!Value.Check(TaskSchema, mutation.task))
        throw new WorkstreamStoreInvalidError("Task record is malformed.");
      const row = requiredRow(
        database.readRow(
          "SELECT lifecycle,(SELECT max(intent_index) FROM intents) AS current_intent FROM metadata WHERE singleton=1",
        ),
        "metadata",
      );
      if (
        stringField(row, "lifecycle") !== "active" ||
        mutation.task.intentIndex !== numberField(row, "current_intent")
      )
        throw new WorkstreamStoreConflictError(
          "Task does not belong to the active current Intent.",
        );
      insertTaskRecords(database, mutation.task);
      return;
    }
    case "append_attempts": {
      const task = database.readRow(
        "SELECT intent_index FROM tasks WHERE task_id=?",
        mutation.taskId,
      );
      if (task === undefined)
        throw new WorkstreamStoreConflictError(`Unknown Task ${mutation.taskId}.`);
      const nextSequence = integerField(
        database.readRow(
          "SELECT coalesce(max(sequence),-1)+1 AS sequence FROM attempts WHERE task_id=?",
          mutation.taskId,
        ),
        "sequence",
      );
      mutation.attempts.forEach((attempt, offset) => {
        insertAttemptRecord(database, mutation.taskId, nextSequence + offset, attempt);
      });
      return;
    }
    case "update_attempt": {
      if (
        !Value.Check(AttemptSchema, mutation.attempt) ||
        mutation.attempt.id !== mutation.key.attemptId
      )
        throw new WorkstreamStoreInvalidError("Attempt record is malformed or mismatched.");
      const existing = database.readRow(
        "SELECT attempt_id FROM attempts WHERE task_id=? AND attempt_id=?",
        mutation.key.taskId,
        mutation.key.attemptId,
      );
      if (existing === undefined)
        throw new WorkstreamStoreConflictError(`Unknown Attempt ${mutation.key.attemptId}.`);
      writeAttemptRecord(database, mutation.key.taskId, mutation.attempt);
      if (mutation.completion !== undefined)
        database.write(
          "UPDATE metadata SET completion_json=? WHERE singleton=1",
          json(mutation.completion),
        );
      return;
    }
    case "update_lifecycle": {
      const current = stringField(
        requiredRow(
          database.readRow("SELECT lifecycle FROM metadata WHERE singleton=1"),
          "metadata",
        ),
        "lifecycle",
      );
      const valid =
        (current === "active" &&
          mutation.lifecycle === "suspended" &&
          mutation.suspension !== undefined &&
          mutation.completion === undefined) ||
        (current === "suspended" &&
          mutation.lifecycle === "active" &&
          mutation.suspension === undefined &&
          mutation.completion === undefined) ||
        (current === "active" &&
          mutation.lifecycle === "completed" &&
          mutation.suspension === undefined &&
          mutation.completion !== undefined);
      if (!valid)
        throw new WorkstreamStoreConflictError(
          `Invalid Workstream lifecycle transition from ${current} to ${mutation.lifecycle}.`,
        );
      database.write(
        "UPDATE metadata SET lifecycle=?,suspension_json=?,completion_json=? WHERE singleton=1",
        mutation.lifecycle,
        optionalJson(mutation.suspension),
        optionalJson(mutation.completion),
      );
      return;
    }
  }
}

function metadataOwner(database: WorkstreamDatabase): Record<string, unknown> {
  return requiredRow(
    database.readRow("SELECT owner_session_id,owner_session_file FROM metadata WHERE singleton=1"),
    "metadata owner",
  );
}

function insertTaskRecords(database: WorkstreamDatabase, task: Task): void {
  const { attempts, ...contract } = task;
  database.write(
    "INSERT INTO tasks(task_id,intent_index,kind,contract_json) VALUES(?,?,?,?)",
    task.id,
    task.intentIndex,
    task.kind,
    json(contract),
  );
  attempts.forEach((attempt, sequence) => {
    insertAttemptRecord(database, task.id, sequence, attempt);
  });
}

function insertAttemptRecord(
  database: WorkstreamDatabase,
  taskId: string,
  sequence: number,
  attempt: Attempt,
): void {
  if (!Value.Check(AttemptSchema, attempt))
    throw new WorkstreamStoreInvalidError("Attempt record is malformed.");
  const { outcome, ...operational } = attempt;
  database.write(
    "INSERT INTO attempts(attempt_id,task_id,sequence,operational_json) VALUES(?,?,?,?)",
    attempt.id,
    taskId,
    sequence,
    json(operational),
  );
  if (outcome !== undefined) insertOutcomeRecord(database, attempt.id, outcome);
}

function writeAttemptRecord(database: WorkstreamDatabase, taskId: string, attempt: Attempt): void {
  const { outcome, ...operational } = attempt;
  const changed = database.write(
    "UPDATE attempts SET operational_json=? WHERE attempt_id=? AND task_id=?",
    json(operational),
    attempt.id,
    taskId,
  );
  if (changed !== 1) throw new WorkstreamStoreConflictError(`Unknown Attempt ${attempt.id}.`);
  const prior = database.readRow(
    "SELECT outcome_id,outcome_json FROM outcomes WHERE attempt_id=?",
    attempt.id,
  );
  if (outcome === undefined) {
    if (prior !== undefined)
      throw new WorkstreamStoreInvalidError(`Outcome for ${attempt.id} is immutable.`);
    return;
  }
  if (prior === undefined) {
    insertOutcomeRecord(database, attempt.id, outcome);
    return;
  }
  const { delivery, ...immutableOutcome } = outcome;
  if (
    stringField(prior, "outcome_id") !== outcome.id ||
    !Value.Equal(parseJson(stringField(prior, "outcome_json")), immutableOutcome)
  )
    throw new WorkstreamStoreInvalidError(`Outcome ${outcome.id} is immutable.`);
  database.write(
    "UPDATE deliveries SET delivery_json=? WHERE outcome_id=?",
    json(delivery),
    outcome.id,
  );
}

function insertOutcomeRecord(
  database: WorkstreamDatabase,
  attemptId: string,
  outcome: NonNullable<Attempt["outcome"]>,
): void {
  const { delivery, ...immutableOutcome } = outcome;
  database.write(
    "INSERT INTO outcomes(outcome_id,attempt_id,outcome_json) VALUES(?,?,?)",
    outcome.id,
    attemptId,
    json(immutableOutcome),
  );
  database.write(
    "INSERT INTO deliveries(outcome_id,delivery_json) VALUES(?,?)",
    outcome.id,
    json(delivery),
  );
}

function readRecords(database: WorkstreamDatabase): Workstream {
  assertRecordSchema(database);
  assertHeader(database);
  const metadata = requiredRow(
    database.readRow("SELECT * FROM metadata WHERE singleton=1"),
    "metadata",
  );
  const intents = database
    .readRows("SELECT intent_json FROM intents ORDER BY intent_index")
    .map((row) => parseJson(stringField(row, "intent_json")));
  const tasks = database
    .readRows("SELECT task_id,contract_json FROM tasks ORDER BY rowid")
    .map((row) => {
      const contract = parseJson(stringField(row, "contract_json")) as Record<string, unknown>;
      const attempts = database
        .readRows(
          "SELECT attempt_id,operational_json FROM attempts WHERE task_id=? ORDER BY sequence",
          stringField(row, "task_id"),
        )
        .map((attemptRow) => {
          const operational = parseJson(stringField(attemptRow, "operational_json")) as Record<
            string,
            unknown
          >;
          const outcomeRow = database.readRow(
            "SELECT outcome_id,outcome_json FROM outcomes WHERE attempt_id=?",
            stringField(attemptRow, "attempt_id"),
          );
          if (outcomeRow === undefined) return operational;
          const outcome = parseJson(stringField(outcomeRow, "outcome_json")) as Record<
            string,
            unknown
          >;
          const delivery = requiredRow(
            database.readRow(
              "SELECT delivery_json FROM deliveries WHERE outcome_id=?",
              stringField(outcomeRow, "outcome_id"),
            ),
            "delivery",
          );
          return {
            ...operational,
            outcome: { ...outcome, delivery: parseJson(stringField(delivery, "delivery_json")) },
          };
        });
      return { ...contract, attempts };
    });
  const state: unknown = {
    format: "pi-workgraph-workstream",
    schemaVersion: 3,
    revision: numberField(metadata, "revision"),
    id: stringField(metadata, "id"),
    purpose: stringField(metadata, "purpose"),
    repository: {
      projectRoot: stringField(metadata, "project_root"),
      gitCommonDir: stringField(metadata, "git_common_dir"),
    },
    coordinator: {
      sessionId: stringField(metadata, "owner_session_id"),
      sessionFile: stringField(metadata, "owner_session_file"),
    },
    lifecycle: stringField(metadata, "lifecycle"),
    ...nullableJson(metadata, "suspension_json", "suspension"),
    intents,
    tasks,
    ...nullableJson(metadata, "completion_json", "completion"),
    createdAt: stringField(metadata, "created_at"),
    updatedAt: stringField(metadata, "updated_at"),
  };
  if (!Value.Check(WorkstreamSchema, state)) {
    const issue = Value.Errors(WorkstreamSchema, state)[0];
    throw new WorkstreamStoreInvalidError(
      `Workstream records are malformed at ${issue?.instancePath === undefined || issue.instancePath === "" ? "/" : issue.instancePath}.`,
    );
  }
  try {
    validateWorkstreamInvariants(state as Workstream);
  } catch (cause) {
    throw new WorkstreamStoreInvalidError(
      `Workstream records violate invariants: ${message(cause)}`,
    );
  }
  return structuredClone(state as Workstream);
}
function nullableJson(row: Record<string, unknown>, field: string, property: string): object {
  const value = row[field];
  if (value === null) return {};
  if (typeof value !== "string") throw new WorkstreamStoreInvalidError(`${field} is malformed.`);
  return { [property]: parseJson(value) };
}
function assertHeader(database: WorkstreamDatabase): void {
  const row = requiredRow(
    database.readRow("SELECT format,version FROM store_header WHERE singleton=1"),
    "store header",
  );
  if (stringField(row, "format") !== STORE_FORMAT || numberField(row, "version") !== STORE_VERSION)
    throw new WorkstreamStoreUnsupportedError(
      "Workstream store format is unsupported; historical aggregate stores are retained without migration.",
    );
}
function assertRecordSchema(database: WorkstreamDatabase): void {
  const tables = database.tableNames();
  for (const [table, expected] of Object.entries(RECORD_SCHEMA)) {
    if (!tables.includes(table))
      throw new WorkstreamStoreUnsupportedError(
        `Workstream database is not a record store (missing ${table}).`,
      );
    const actual = database.columnNames(table);
    const absent = expected.filter((name) => !actual.includes(name));
    if (absent.length > 0)
      throw new WorkstreamStoreIncompleteError(
        `Workstream record table ${table} lacks ${absent.join(", ")}.`,
      );
  }
}
function validateInitial(paths: Path.Path, state: Workstream): void {
  validateIdentity(paths, state.repository, state.id);
  validateWorkstream(state);
  if (state.revision !== 0)
    throw new WorkstreamStoreInvalidError("Initial Workstream revision must be zero.");
}
function validateIdentity(paths: Path.Path, repository: RepositoryIdentity, id: string): void {
  if (!id || id === "." || id === ".." || paths.basename(id) !== id)
    throw new WorkstreamStoreInvalidError("Workstream id is not a safe path segment.");
  for (const value of [repository.projectRoot, repository.gitCommonDir])
    if (!paths.isAbsolute(value) || paths.resolve(value) !== value)
      throw new WorkstreamStoreInvalidError(
        "Repository identity paths must be absolute and normalized.",
      );
}
function json(value: unknown): string {
  return JSON.stringify(value);
}
function optionalJson(value: unknown): string | null {
  return value === undefined ? null : json(value);
}
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new WorkstreamStoreInvalidError("Record JSON is malformed.");
  }
}
function requiredRow(
  value: Record<string, unknown> | undefined,
  name: string,
): Record<string, unknown> {
  if (value === undefined)
    throw new WorkstreamStoreIncompleteError(`Workstream ${name} row is missing.`);
  return value;
}
function stringField(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new WorkstreamStoreInvalidError(`${name} is malformed.`);
  return value;
}
function numberField(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new WorkstreamStoreInvalidError(`${name} is malformed.`);
  return value;
}
function integerField(row: Record<string, unknown> | undefined, name: string): number {
  return numberField(requiredRow(row, name), name);
}
function workstreamPath(paths: Path.Path, common: string, id: string): string {
  return paths.join(common, STORAGE_DIRECTORY, WORKSTREAM_DIRECTORY, id, SQLITE_FILENAME);
}
function acquireDatabase(
  path: string,
  readOnly = false,
): Effect.Effect<WorkstreamDatabase, WorkstreamStoreError, Scope.Scope> {
  return Effect.acquireRelease(
    hostEffect("open Workstream SQLite database", () => openWorkstreamDatabase(path, readOnly)),
    (database) => Effect.sync(() => database.close()),
  );
}
function createPrivateDatabaseFile(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<void, WorkstreamStoreError, Scope.Scope> {
  return platform(
    "create private Workstream database",
    Effect.scoped(fs.open(path, { flag: "wx", mode: FILE_MODE })),
  ).pipe(Effect.andThen(platform("secure Workstream database", fs.chmod(path, FILE_MODE))));
}
function claimStorageDirectories(
  paths: Path.Path,
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<void, WorkstreamStoreError> {
  return Effect.gen(function* () {
    for (const directory of [
      paths.dirname(paths.dirname(paths.dirname(path))),
      paths.dirname(paths.dirname(path)),
      paths.dirname(path),
    ]) {
      const entry = yield* inspect(directory);
      if (
        entry.symbolicLink ||
        (entry.exists && (!entry.directory || entry.mode !== DIRECTORY_MODE))
      )
        return yield* invalid(`Unsafe Workstream storage directory: ${directory}.`);
      if (!entry.exists) {
        yield* platform(
          "create private Workstream directory",
          fs.makeDirectory(directory, { mode: DIRECTORY_MODE }),
        );
        yield* platform("secure Workstream directory", fs.chmod(directory, DIRECTORY_MODE));
      }
    }
  });
}
function assertPrivateStorage(
  paths: Path.Path,
  path: string,
): Effect.Effect<void, WorkstreamStoreError> {
  return Effect.gen(function* () {
    for (const directory of [
      paths.dirname(paths.dirname(paths.dirname(path))),
      paths.dirname(paths.dirname(path)),
      paths.dirname(path),
    ]) {
      const entry = yield* inspect(directory);
      if (!entry.directory || entry.symbolicLink || entry.mode !== DIRECTORY_MODE)
        return yield* invalid(`Workstream storage directory is unsafe: ${directory}.`);
    }
    const file = yield* inspect(path);
    if (!file.regularFile || file.symbolicLink || file.mode !== FILE_MODE)
      return yield* invalid(`Workstream database is not a private ordinary file: ${path}.`);
  });
}
function classifyFileHeader(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<void, WorkstreamStoreError> {
  return Effect.gen(function* () {
    const bytes = yield* platform(
      "read Workstream database header",
      Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(path, { flag: "r" });
          const value = new Uint8Array(16);
          const count = yield* file.read(value);
          return value.subarray(0, Number(count));
        }),
      ),
    );
    if (bytes.length === 0)
      return yield* new WorkstreamStoreIncompleteError(
        "Workstream database is empty creation residue.",
      );
    if (new TextDecoder().decode(bytes) !== SQLITE_HEADER)
      return yield* invalid("Workstream database is not SQLite.");
  });
}
function secureFiles(
  path: string,
): Effect.Effect<void, WorkstreamStoreError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const file = `${path}${suffix}`;
      if (suffix && !(yield* platform("inspect SQLite sidecar", fs.exists(file)))) continue;
      yield* platform("secure SQLite file", fs.chmod(file, FILE_MODE));
    }
  });
}
function inspect(path: string): Effect.Effect<StorageEntry, WorkstreamStoreError> {
  return hostEffect("inspect Workstream storage", () => inspectStorageEntry(path));
}
function invalid(text: string): Effect.Effect<never, WorkstreamStoreInvalidError> {
  return Effect.fail(new WorkstreamStoreInvalidError(text));
}
function hostEffect<A>(operation: string, run: () => A): Effect.Effect<A, WorkstreamStoreError> {
  return Effect.try({
    try: run,
    catch: (cause) =>
      cause instanceof WorkstreamStoreInvalidError ||
      cause instanceof WorkstreamStoreIncompleteError ||
      cause instanceof WorkstreamStoreUnsupportedError ||
      cause instanceof WorkstreamStoreConflictError ||
      cause instanceof WorkstreamStoreHostError
        ? cause
        : new WorkstreamStoreHostError(operation, cause),
  });
}
function platform<A, R>(
  operation: string,
  effect: Effect.Effect<A, PlatformError, R>,
): Effect.Effect<A, WorkstreamStoreError, R> {
  return effect.pipe(Effect.mapError((cause) => new WorkstreamStoreHostError(operation, cause)));
}
function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
