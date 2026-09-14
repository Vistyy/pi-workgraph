/* oxlint-disable effecttsgo/node-builtin-import, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-return -- node:sqlite rows and TypeBox outputs are decoded at this private host boundary. */
/* biome-ignore-all lint/complexity/useLiteralKeys: SQLite rows require indexed access under noPropertyAccessFromIndexSignature. */
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { Data } from "effect";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  type AttemptOutput,
  AttemptOutputSchema,
  type AttemptRecord,
  type AttemptSpec,
  AttemptSpecSchema,
  type Outcome,
  OutcomeSchema,
  type Task,
  TaskIdSchema,
  type TaskRecord,
  TaskSchema,
  type WorkerState,
  WorkerStateSchema,
} from "../domain/records.js";

const MAX_PAGE = 100;
const BUSY_TIMEOUT_MS = 5_000;
const SCHEMA = `
CREATE TABLE tasks (
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_json TEXT NOT NULL,
  PRIMARY KEY(session_id,task_id)
) STRICT;
CREATE TABLE attempts (
  attempt_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  worker_json TEXT,
  output_json TEXT,
  outcome_json TEXT,
  FOREIGN KEY(session_id,task_id) REFERENCES tasks(session_id,task_id)
) STRICT;
PRAGMA user_version=1;
`;

type Row = Record<string, SQLOutputValue>;

export interface RecordCounts {
  readonly tasks: number;
  readonly attempts: number;
  readonly activeWorkers: number;
}

export class StoreError extends Data.TaggedError("StoreError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class RecordStore {
  readonly path: string;

  private database: DatabaseSync | undefined;
  private closed = false;

  constructor(
    agentDir: string,
    private readonly sessionId: string,
  ) {
    if (sessionId.length === 0) throw failure("construct Store", "Session id is empty.");
    const placement = host("resolve Store placement", () => {
      const resolved = realpathSync(agentDir);
      if (!lstatSync(resolved).isDirectory())
        throw failure("resolve Store placement", "Agent directory is not a directory.");
      return resolved;
    });
    this.path = join(placement, "workgraph", "workgraph.sqlite");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    host("close Store", () => this.database?.close());
    this.database = undefined;
  }

  createTaskWithAttempt(
    taskId: string,
    task: Task,
    attemptId: string,
    spec: AttemptSpec,
  ): { task: TaskRecord; attempt: AttemptRecord } {
    decode(TaskIdSchema, taskId, "Task id");
    decode(TaskSchema, task, "Task");
    validateAttemptId(attemptId);
    decode(AttemptSpecSchema, spec, "Attempt specification");
    return this.transaction("create Task and Attempt", true, (database) => {
      database
        .prepare("INSERT INTO tasks(session_id,task_id,task_json) VALUES(?,?,?)")
        .run(this.sessionId, taskId, json(task));
      database
        .prepare("INSERT INTO attempts(attempt_id,session_id,task_id,spec_json) VALUES(?,?,?,?)")
        .run(attemptId, this.sessionId, taskId, json(spec));
      return {
        task: { id: taskId, task },
        attempt: { id: attemptId, taskId, spec },
      };
    });
  }

  createAttempt(taskId: string, attemptId: string, spec: AttemptSpec): AttemptRecord {
    decode(TaskIdSchema, taskId, "Task id");
    validateAttemptId(attemptId);
    decode(AttemptSpecSchema, spec, "Attempt specification");
    return this.transaction("create Attempt", false, (database) => {
      this.readTaskFrom(database, taskId);
      database
        .prepare("INSERT INTO attempts(attempt_id,session_id,task_id,spec_json) VALUES(?,?,?,?)")
        .run(attemptId, this.sessionId, taskId, json(spec));
      return { id: attemptId, taskId, spec };
    });
  }

  readTask(taskId: string): TaskRecord {
    decode(TaskIdSchema, taskId, "Task id");
    const database = this.requireExisting("read Task");
    return this.readTaskFrom(database, taskId);
  }

  readAttempt(attemptId: string): AttemptRecord {
    validateAttemptId(attemptId);
    const database = this.requireExisting("read Attempt");
    return this.readAttemptFrom(database, attemptId);
  }

  checkpointWorker(attemptId: string, worker: WorkerState): AttemptRecord {
    validateAttemptId(attemptId);
    decode(WorkerStateSchema, worker, "Worker state");
    return this.transaction("checkpoint Worker", false, (database) => {
      const prior = this.readAttemptFrom(database, attemptId);
      database
        .prepare("UPDATE attempts SET worker_json=? WHERE attempt_id=? AND session_id=?")
        .run(json(worker), attemptId, this.sessionId);
      return { ...prior, worker };
    });
  }

  checkpointOutput(attemptId: string, output: AttemptOutput): AttemptRecord {
    validateAttemptId(attemptId);
    decode(AttemptOutputSchema, output, "Attempt output");
    return this.transaction("checkpoint output", false, (database) => {
      const prior = this.readAttemptFrom(database, attemptId);
      database
        .prepare("UPDATE attempts SET output_json=? WHERE attempt_id=? AND session_id=?")
        .run(json(output), attemptId, this.sessionId);
      return { ...prior, output };
    });
  }

  recordOutcome(attemptId: string, outcome: Outcome): AttemptRecord {
    validateAttemptId(attemptId);
    return this.transaction("record Outcome", false, (database) => {
      const prior = this.readAttemptFrom(database, attemptId);
      validateOutcome(outcome, this.readTaskFrom(database, prior.taskId).task);
      if (prior.outcome !== undefined)
        throw failure("record Outcome", "Outcome is already recorded.");
      database
        .prepare(
          "UPDATE attempts SET outcome_json=? WHERE attempt_id=? AND session_id=? AND outcome_json IS NULL",
        )
        .run(json(outcome), attemptId, this.sessionId);
      return { ...prior, outcome };
    });
  }

  settleCancellation(
    attemptId: string,
    closedWorker: WorkerState,
    outcome: Outcome,
  ): AttemptRecord {
    validateAttemptId(attemptId);
    decode(WorkerStateSchema, closedWorker, "Worker state");
    if (closedWorker.closing?.kind !== "cancelled" || closedWorker.closed !== true)
      throw failure("settle cancellation", "Worker is not closed as cancelled.");
    if (outcome.result.kind !== "cancelled")
      throw failure("settle cancellation", "Outcome is not cancelled.");
    return this.transaction("settle cancellation", false, (database) => {
      const prior = this.readAttemptFrom(database, attemptId);
      validateOutcome(outcome, this.readTaskFrom(database, prior.taskId).task);
      if (prior.outcome !== undefined)
        throw failure("settle cancellation", "Outcome is already recorded.");
      database
        .prepare(
          "UPDATE attempts SET worker_json=?,outcome_json=? WHERE attempt_id=? AND session_id=? AND outcome_json IS NULL",
        )
        .run(json(closedWorker), json(outcome), attemptId, this.sessionId);
      return { ...prior, worker: closedWorker, outcome };
    });
  }

  unsettled(): AttemptRecord[] {
    const database = this.existingOrUndefined("read unsettled Attempts");
    if (database === undefined) return [];
    const rows = database
      .prepare(
        `SELECT * FROM attempts
         WHERE session_id=? AND (
           outcome_json IS NULL OR
           (worker_json IS NOT NULL AND json_extract(worker_json,'$.closed') IS NOT 1) OR
           (json_extract(spec_json,'$.base.kind')='repository' AND (
             output_json IS NULL OR
             json_extract(output_json,'$.kind') IN ('applying','discarding') OR
             (json_extract(output_json,'$.kind')='applied' AND json_extract(output_json,'$.cleanupTip') IS NOT NULL)
           ))
         ) ORDER BY rowid`,
      )
      .all(this.sessionId) as Row[];
    return rows.map((row) => this.attemptRecord(database, row));
  }

  hasUnclassifiedIntegrationChild(parentAttemptId: string): boolean {
    validateAttemptId(parentAttemptId);
    const database = this.existingOrUndefined("read integration children");
    if (database === undefined) return false;
    return (
      integer(
        database
          .prepare(
            `SELECT count(*) AS value FROM attempts child
             WHERE child.session_id=?
               AND json_extract(child.spec_json,'$.lineage.candidateOf.kind')='integrate'
               AND json_extract(child.spec_json,'$.lineage.candidateOf.attemptId')=?
               AND child.output_json IS NULL
               AND EXISTS (
                 SELECT 1 FROM attempts parent
                 WHERE parent.attempt_id=? AND parent.session_id=child.session_id
               )`,
          )
          .get(this.sessionId, parentAttemptId, parentAttemptId) as Row | undefined,
        "value",
      ) > 0
    );
  }

  hasUnplacedExtensionChild(parentAttemptId: string): boolean {
    validateAttemptId(parentAttemptId);
    const database = this.existingOrUndefined("read extension children");
    if (database === undefined) return false;
    return (
      integer(
        database
          .prepare(
            `SELECT count(*) AS value FROM attempts child
             WHERE child.session_id=?
               AND json_extract(child.spec_json,'$.lineage.candidateOf.kind')='extend'
               AND json_extract(child.spec_json,'$.lineage.candidateOf.attemptId')=?
               AND child.worker_json IS NULL
               AND child.outcome_json IS NULL
               AND EXISTS (
                 SELECT 1 FROM attempts parent
                 WHERE parent.attempt_id=? AND parent.session_id=child.session_id
               )`,
          )
          .get(this.sessionId, parentAttemptId, parentAttemptId) as Row | undefined,
        "value",
      ) > 0
    );
  }

  listTasks(offset: number, limit: number): TaskRecord[] {
    validatePage(offset, limit);
    const database = this.existingOrUndefined("list Tasks");
    if (database === undefined) return [];
    return (
      database
        .prepare("SELECT * FROM tasks WHERE session_id=? ORDER BY rowid LIMIT ? OFFSET ?")
        .all(this.sessionId, limit, offset) as Row[]
    ).map(taskRecord);
  }

  listAttempts(offset: number, limit: number, taskId?: string): AttemptRecord[] {
    validatePage(offset, limit);
    if (taskId !== undefined) decode(TaskIdSchema, taskId, "Task id");
    const database = this.existingOrUndefined("list Attempts");
    if (database === undefined) return [];
    const rows =
      taskId === undefined
        ? (database
            .prepare("SELECT * FROM attempts WHERE session_id=? ORDER BY rowid LIMIT ? OFFSET ?")
            .all(this.sessionId, limit, offset) as Row[])
        : (database
            .prepare(
              "SELECT * FROM attempts WHERE session_id=? AND task_id=? ORDER BY rowid LIMIT ? OFFSET ?",
            )
            .all(this.sessionId, taskId, limit, offset) as Row[]);
    return rows.map((row) => this.attemptRecord(database, row));
  }

  counts(): RecordCounts {
    const database = this.existingOrUndefined("count records");
    if (database === undefined) return { tasks: 0, attempts: 0, activeWorkers: 0 };
    const row = database
      .prepare(
        `SELECT
           (SELECT count(*) FROM tasks WHERE session_id=?) AS tasks,
           count(*) AS attempts,
           coalesce(sum(CASE
             WHEN worker_json IS NOT NULL AND json_extract(worker_json,'$.closed') IS NOT 1 THEN 1
             ELSE 0
           END),0) AS active_workers
         FROM attempts WHERE session_id=?`,
      )
      .get(this.sessionId, this.sessionId) as Row | undefined;
    return {
      tasks: integer(row, "tasks"),
      attempts: integer(row, "attempts"),
      activeWorkers: integer(row, "active_workers"),
    };
  }

  private readTaskFrom(database: DatabaseSync, taskId: string): TaskRecord {
    const row = database
      .prepare("SELECT * FROM tasks WHERE session_id=? AND task_id=?")
      .get(this.sessionId, taskId) as Row | undefined;
    if (row === undefined) throw failure("read Task", "Required Task is absent.");
    return taskRecord(row);
  }

  private readAttemptFrom(database: DatabaseSync, attemptId: string): AttemptRecord {
    const row = database
      .prepare("SELECT * FROM attempts WHERE session_id=? AND attempt_id=?")
      .get(this.sessionId, attemptId) as Row | undefined;
    if (row === undefined) throw failure("read Attempt", "Required Attempt is absent.");
    return this.attemptRecord(database, row);
  }

  private attemptRecord(database: DatabaseSync, row: Row): AttemptRecord {
    const taskId = text(row, "task_id");
    const task = this.readTaskFrom(database, taskId).task;
    const outcome = nullableParse(OutcomeSchema, row["outcome_json"], "Outcome");
    if (outcome !== undefined) validateOutcome(outcome, task);
    return {
      id: text(row, "attempt_id"),
      taskId,
      spec: parse(AttemptSpecSchema, row["spec_json"], "Attempt specification"),
      ...optional("worker", nullableParse(WorkerStateSchema, row["worker_json"], "Worker state")),
      ...optional(
        "output",
        nullableParse(AttemptOutputSchema, row["output_json"], "Attempt output"),
      ),
      ...optional("outcome", outcome),
    };
  }

  private transaction<A>(
    operation: string,
    mayInitialize: boolean,
    run: (database: DatabaseSync) => A,
  ): A {
    return host(operation, () => {
      const acquired = mayInitialize && this.database === undefined;
      const database = mayInitialize ? this.forInitialMutation() : this.requireExisting(operation);
      try {
        database.exec("BEGIN IMMEDIATE");
        if (mayInitialize) initializeOrValidate(database);
        const result = run(database);
        database.exec("COMMIT");
        if (acquired) this.database = database;
        return result;
      } catch (cause) {
        abandonTransaction(database, acquired);
        throw cause;
      }
    });
  }

  private forInitialMutation(): DatabaseSync {
    this.requireOpen();
    if (this.database !== undefined) return this.database;
    prepareParent(this.path, true, "initialize Store");
    prepareDatabase(this.path, true, "initialize Store");
    return openDatabase(this.path);
  }

  private requireExisting(operation: string): DatabaseSync {
    const database = this.existingOrUndefined(operation);
    if (database === undefined) throw failure(operation, "Record Store is absent.");
    return database;
  }

  private existingOrUndefined(operation: string): DatabaseSync | undefined {
    this.requireOpen();
    if (this.database !== undefined) return this.database;
    return host(operation, () => {
      if (!prepareParent(this.path, false, operation)) return undefined;
      if (!prepareDatabase(this.path, false, operation)) return undefined;
      const database = openDatabase(this.path);
      try {
        if (isInitialized(database, operation)) {
          this.database = database;
          return database;
        }
        database.close();
        return undefined;
      } catch (cause) {
        database.close();
        throw cause;
      }
    });
  }

  private requireOpen(): void {
    if (this.closed) throw failure("use Store", "Record Store is closed.");
  }
}

function abandonTransaction(database: DatabaseSync, close: boolean): void {
  try {
    if (database.isTransaction) database.exec("ROLLBACK");
  } finally {
    if (close) database.close();
  }
}

function configure(database: DatabaseSync): DatabaseSync {
  database.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${BUSY_TIMEOUT_MS};`);
  return database;
}

function initializeOrValidate(database: DatabaseSync): void {
  if (!isInitialized(database, "initialize Store")) database.exec(SCHEMA);
}

function isInitialized(database: DatabaseSync, operation: string): boolean {
  const version = userVersion(database);
  if (version === 1) return true;
  if (version === 0 && schemaObjectCount(database) === 0) return false;
  throw failure(operation, "Unsupported database schema version.");
}

function userVersion(database: DatabaseSync): number {
  return integer(database.prepare("PRAGMA user_version").get() as Row | undefined, "user_version");
}

function schemaObjectCount(database: DatabaseSync): number {
  return integer(
    database.prepare("SELECT count(*) AS value FROM sqlite_schema").get() as Row | undefined,
    "value",
  );
}

function prepareParent(path: string, create: boolean, operation: string): boolean {
  const parent = dirname(path);
  let entry = lstatSync(parent, { throwIfNoEntry: false });
  if (entry === undefined) {
    if (!create) return false;
    try {
      mkdirSync(parent, { mode: 0o700 });
    } catch (cause) {
      if (!hasCode(cause, "EEXIST")) throw cause;
    }
    entry = lstatSync(parent);
  }
  if (!entry.isDirectory())
    throw failure(operation, "Workgraph data directory is not an owned directory.");
  chmodSync(parent, 0o700);
  return true;
}

function prepareDatabase(path: string, create: boolean, operation: string): boolean {
  let entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry === undefined) {
    if (!create) return false;
    try {
      closeSync(openSync(path, "wx", 0o600));
    } catch (cause) {
      if (!hasCode(cause, "EEXIST")) throw cause;
    }
    entry = lstatSync(path);
  }
  if (!entry.isFile()) throw failure(operation, "Record Store path is not an owned regular file.");
  chmodSync(path, 0o600);
  return true;
}

function openDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  try {
    return configure(database);
  } catch (cause) {
    database.close();
    throw cause;
  }
}

function hasCode(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

function taskRecord(row: Row): TaskRecord {
  return {
    id: text(row, "task_id"),
    task: parse(TaskSchema, row["task_json"], "Task"),
  };
}

function validateOutcome(outcome: Outcome, task: Task): void {
  decode(OutcomeSchema, outcome, "Outcome");
  if (outcome.result.kind !== "reported") return;
  const expected =
    task.contract.kind === "implementation"
      ? "implementation"
      : task.contract.kind === "review"
        ? "review"
        : "research";
  if (outcome.result.report.kind !== expected)
    throw failure("decode Outcome", "Report kind does not match its Task.");
}

function validateAttemptId(attemptId: string): void {
  if (attemptId.length === 0) throw failure("decode Attempt id", "Attempt id is empty.");
}

function validatePage(offset: number, limit: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_PAGE
  )
    throw failure("list records", "Page boundary is outside the supported range.");
}

function nullableParse<S extends TSchema>(
  schema: S,
  value: unknown,
  name: string,
): Static<S> | undefined {
  return value === null ? undefined : parse(schema, value, name);
}

function parse<S extends TSchema>(schema: S, value: unknown, name: string): Static<S> {
  if (typeof value !== "string") throw failure(`decode ${name}`, `${name} JSON is not text.`);
  try {
    return decode(schema, JSON.parse(value), name);
  } catch (cause) {
    if (cause instanceof StoreError) throw cause;
    throw failure(`decode ${name}`, `${name} JSON is malformed.`, cause);
  }
}

function decode<S extends TSchema>(schema: S, value: unknown, name: string): Static<S> {
  if (!Value.Check(schema, value)) throw failure(`decode ${name}`, `${name} is malformed.`);
  return Value.Decode(schema, value) as Static<S>;
}

function optional<const Name extends string, Value>(name: Name, value: Value | undefined) {
  return value === undefined ? {} : ({ [name]: value } as { [Key in Name]: Value });
}

function text(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw failure("decode row", `${field} is malformed.`);
  return value;
}

function integer(row: Row | undefined, field: string): number {
  const value = row?.[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw failure("decode row", `${field} is malformed.`);
  return value;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function failure(operation: string, message: string, cause?: unknown): StoreError {
  return new StoreError({ operation, message, cause });
}

function host<A>(operation: string, run: () => A): A {
  try {
    return run();
  } catch (cause) {
    if (cause instanceof StoreError) throw cause;
    throw failure(operation, `Failed to ${operation}.`, cause);
  }
}
