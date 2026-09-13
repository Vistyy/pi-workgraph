/* oxlint-disable effecttsgo/node-builtin-import, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread, typescript/no-unsafe-return -- node:sqlite rows and TypeBox outputs are decoded at this private host boundary; absent optional persisted facts remain omitted. */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { Data } from "effect";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  type Attempt,
  type AttemptRecord,
  AttemptSchema,
  type Completion,
  type CoordinatorOwner,
  CoordinatorOwnerSchema,
  type Intent,
  type IntentRecord,
  IntentSchema,
  type Outcome,
  type OutcomeDelivery,
  OutcomeDeliverySchema,
  type OutcomeRecord,
  OutcomeSchema,
  type Task,
  type TaskRecord,
  TaskSchema,
  WORKSTREAM_FORMAT,
  WORKSTREAM_SCHEMA_VERSION,
  type WorkstreamMetadata,
  WorkstreamMetadataSchema,
} from "../domain/records.js";

const MAX_PAGE = 100;
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SCHEMA = `
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS metadata (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  format TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  workstream_id TEXT NOT NULL UNIQUE,
  owner_session_id TEXT NOT NULL,
  owner_session_file TEXT NOT NULL,
  owner_workspace_id TEXT NOT NULL,
  owner_tab_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','completed')),
  completion_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS intents (
  intent_index INTEGER PRIMARY KEY CHECK(intent_index>=0),
  intent_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS tasks (
  task_index INTEGER NOT NULL UNIQUE CHECK(task_index>=0),
  task_id TEXT PRIMARY KEY,
  intent_index INTEGER NOT NULL REFERENCES intents(intent_index),
  task_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS attempts (
  attempt_index INTEGER NOT NULL UNIQUE CHECK(attempt_index>=0),
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  sequence INTEGER NOT NULL CHECK(sequence>=0),
  attempt_json TEXT NOT NULL,
  UNIQUE(task_id,sequence)
) STRICT;
CREATE TABLE IF NOT EXISTS outcomes (
  outcome_index INTEGER NOT NULL UNIQUE CHECK(outcome_index>=0),
  outcome_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id),
  outcome_json TEXT NOT NULL
) STRICT;
`;

type Row = Record<string, SQLOutputValue>;

export class StoreError extends Data.TaggedError("StoreError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class WorkstreamStore {
  readonly path: string;

  private constructor(
    readonly id: string,
    private readonly database: DatabaseSync,
    path: string,
    private readonly readOnly: boolean,
  ) {
    this.path = path;
  }

  static pathFor(agentDir: string, id: string): string {
    if (!safeId.test(id)) throw failure("locate", "Workstream id is not a safe path segment.");
    return join(agentDir, "workgraph", "workstreams", id, "workstream.sqlite");
  }

  static create(agentDir: string, metadata: WorkstreamMetadata, intent: Intent): WorkstreamStore {
    return host("create workstream", () => {
      decode(WorkstreamMetadataSchema, metadata, "metadata");
      decode(IntentSchema, intent, "Intent");
      if (metadata.lifecycle !== "active" || metadata.completion !== undefined)
        throw failure("create workstream", "A new Workstream must be active and incomplete.");
      const path = WorkstreamStore.pathFor(agentDir, metadata.id);
      privateParents(path);
      const database = new DatabaseSync(path);
      const store = new WorkstreamStore(metadata.id, database, path, false);
      try {
        database.exec(SCHEMA);
        chmodSync(path, 0o600);
        store.transaction("create workstream", () => {
          const existing = database
            .prepare("SELECT workstream_id FROM metadata WHERE singleton=1")
            .get() as Row | undefined;
          if (existing !== undefined) {
            store.readMetadata();
            store.requireOwner(metadata.owner);
            return;
          }
          const residue = number(
            database
              .prepare(
                "SELECT (SELECT count(*) FROM intents)+(SELECT count(*) FROM tasks)+(SELECT count(*) FROM attempts)+(SELECT count(*) FROM outcomes) AS value",
              )
              .get(),
            "value",
          );
          if (residue !== 0)
            throw failure(
              "create workstream",
              "Creation residue contains records without metadata.",
            );
          database
            .prepare(
              `INSERT INTO metadata(singleton,format,schema_version,workstream_id,owner_session_id,owner_session_file,owner_workspace_id,owner_tab_id,lifecycle,completion_json,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              metadata.format,
              metadata.schemaVersion,
              metadata.id,
              metadata.owner.sessionId,
              metadata.owner.sessionFile,
              metadata.owner.workspaceId,
              metadata.owner.tabId,
              metadata.lifecycle,
              null,
              metadata.createdAt,
              metadata.updatedAt,
            );
          database
            .prepare("INSERT INTO intents(intent_index,intent_json) VALUES(0,?)")
            .run(json(intent));
        });
        store.readLatestIntent();
        return store;
      } catch (cause) {
        database.close();
        throw cause;
      }
    });
  }

  static openOwned(agentDir: string, id: string, owner: CoordinatorOwner): WorkstreamStore {
    const store = WorkstreamStore.openExact(agentDir, id, false);
    try {
      store.requireOwner(owner);
      return store;
    } catch (cause) {
      store.close();
      throw cause;
    }
  }

  static openReadOnly(agentDir: string, id: string): WorkstreamStore {
    return WorkstreamStore.openExact(agentDir, id, true);
  }

  private static openExact(agentDir: string, id: string, readOnly: boolean): WorkstreamStore {
    return host(readOnly ? "open read-only workstream" : "open owned workstream", () => {
      const path = WorkstreamStore.pathFor(agentDir, id);
      if (!existsSync(path)) throw failure("open workstream", "Workstream store is absent.");
      const database = new DatabaseSync(path, { readOnly });
      const store = new WorkstreamStore(id, database, path, readOnly);
      try {
        database.exec("PRAGMA foreign_keys=ON");
        store.readMetadata();
        store.readLatestIntent();
        return store;
      } catch (cause) {
        database.close();
        throw cause;
      }
    });
  }

  close(): void {
    host("close workstream", () => this.database.close());
  }

  readMetadata(): WorkstreamMetadata {
    return host("read metadata", () => {
      const row = this.one("SELECT * FROM metadata WHERE singleton=1");
      const metadata = decode(
        WorkstreamMetadataSchema,
        {
          format: text(row, "format"),
          schemaVersion: number(row, "schema_version"),
          id: text(row, "workstream_id"),
          owner: {
            sessionId: text(row, "owner_session_id"),
            sessionFile: text(row, "owner_session_file"),
            workspaceId: text(row, "owner_workspace_id"),
            tabId: text(row, "owner_tab_id"),
          },
          lifecycle: text(row, "lifecycle"),
          ...(row["completion_json"] === null
            ? {}
            : {
                completion: parse(
                  WorkstreamMetadataSchema.properties.completion,
                  row["completion_json"],
                  "completion",
                ),
              }),
          createdAt: text(row, "created_at"),
          updatedAt: text(row, "updated_at"),
        },
        "metadata",
      );
      if (metadata.id !== this.id) throw failure("read metadata", "Foreign Workstream identity.");
      if (metadata.format !== WORKSTREAM_FORMAT)
        throw failure("read metadata", "Unsupported Workstream format.");
      if (metadata.schemaVersion !== WORKSTREAM_SCHEMA_VERSION)
        throw failure("read metadata", "Unsupported Workstream schema version.");
      if ((metadata.lifecycle === "completed") !== (metadata.completion !== undefined))
        throw failure("read metadata", "Lifecycle and completion disagree.");
      return metadata;
    });
  }

  title(): string {
    return this.readLatestIntent().intent.statement;
  }

  readLatestIntent(): IntentRecord {
    const row = this.one(
      "SELECT intent_index,intent_json FROM intents ORDER BY intent_index DESC LIMIT 1",
    );
    return intentRecord(row);
  }

  readIntent(index: number): IntentRecord {
    return intentRecord(
      this.one("SELECT intent_index,intent_json FROM intents WHERE intent_index=?", index),
    );
  }

  appendIntent(owner: CoordinatorOwner, intent: Intent): IntentRecord {
    return this.transaction("append Intent", () => {
      this.requireOwner(owner);
      if (this.readMetadata().lifecycle !== "active")
        throw failure("append Intent", "Completed Workstreams reject new work.");
      decode(IntentSchema, intent, "Intent");
      const index = this.readLatestIntent().index + 1;
      this.database
        .prepare("INSERT INTO intents(intent_index,intent_json) VALUES(?,?)")
        .run(index, json(intent));
      this.touch(intent.recordedAt);
      return { index, intent };
    });
  }

  createTaskWithAttempt(
    owner: CoordinatorOwner,
    intentIndex: number,
    taskId: string,
    task: Task,
    attemptId: string,
    attempt: Attempt,
  ): { task: TaskRecord; attempt: AttemptRecord } {
    return this.transaction("create Task and Attempt", () => {
      this.requireOwner(owner);
      if (this.readMetadata().lifecycle !== "active")
        throw failure("create Task and Attempt", "Completed Workstreams reject new work.");
      decode(TaskSchema, task, "Task");
      decode(AttemptSchema, attempt, "Attempt");
      if (this.readLatestIntent().index !== intentIndex)
        throw failure("create Task and Attempt", "Task must bind to the latest Intent.");
      const taskIndex = this.nextIndex("tasks", "task_index");
      const attemptIndex = this.nextIndex("attempts", "attempt_index");
      this.database
        .prepare("INSERT INTO tasks(task_index,task_id,intent_index,task_json) VALUES(?,?,?,?)")
        .run(taskIndex, taskId, intentIndex, json(task));
      this.database
        .prepare(
          "INSERT INTO attempts(attempt_index,attempt_id,task_id,sequence,attempt_json) VALUES(?,?,?,?,?)",
        )
        .run(attemptIndex, attemptId, taskId, 0, json(attempt));
      this.touch(task.createdAt);
      return {
        task: { index: taskIndex, id: taskId, intentIndex, task },
        attempt: { index: attemptIndex, id: attemptId, taskId, sequence: 0, attempt },
      };
    });
  }

  appendAttempt(
    owner: CoordinatorOwner,
    taskId: string,
    attemptId: string,
    attempt: Attempt,
  ): AttemptRecord {
    return this.transaction("append Attempt", () => {
      this.requireOwner(owner);
      if (this.readMetadata().lifecycle !== "active")
        throw failure("append Attempt", "Completed Workstreams reject new work.");
      decode(AttemptSchema, attempt, "Attempt");
      const task = this.readTask(taskId);
      if (task.intentIndex !== this.readLatestIntent().index)
        throw failure("append Attempt", "Attempt Task does not belong to the latest Intent.");
      const index = this.nextIndex("attempts", "attempt_index");
      const sequence = number(
        this.database.prepare("SELECT count(*) AS value FROM attempts WHERE task_id=?").get(taskId),
        "value",
      );
      this.database
        .prepare(
          "INSERT INTO attempts(attempt_index,attempt_id,task_id,sequence,attempt_json) VALUES(?,?,?,?,?)",
        )
        .run(index, attemptId, taskId, sequence, json(attempt));
      return { index, id: attemptId, taskId, sequence, attempt };
    });
  }

  readTask(id: string): TaskRecord {
    return taskRecord(
      this.one("SELECT task_index,task_id,intent_index,task_json FROM tasks WHERE task_id=?", id),
    );
  }

  readAttempt(id: string): AttemptRecord {
    return attemptRecord(
      this.one(
        "SELECT attempt_index,attempt_id,task_id,sequence,attempt_json FROM attempts WHERE attempt_id=?",
        id,
      ),
    );
  }

  checkpointAttempt(owner: CoordinatorOwner, attemptId: string, attempt: Attempt): AttemptRecord {
    return this.transaction("checkpoint Attempt", () => {
      this.requireOwner(owner);
      decode(AttemptSchema, attempt, "Attempt");
      const prior = this.readAttempt(attemptId);
      if (
        json({ ...prior.attempt, execution: undefined, output: undefined }) !==
        json({ ...attempt, execution: undefined, output: undefined })
      )
        throw failure("checkpoint Attempt", "Immutable Attempt facts changed.");
      this.database
        .prepare("UPDATE attempts SET attempt_json=? WHERE attempt_id=?")
        .run(json(attempt), attemptId);
      return { ...prior, attempt };
    });
  }

  insertOutcome(
    owner: CoordinatorOwner,
    id: string,
    attemptId: string,
    outcome: Outcome,
  ): OutcomeRecord {
    return this.transaction("insert Outcome", () => {
      this.requireOwner(owner);
      const attempt = this.readAttempt(attemptId);
      const task = this.readTask(attempt.taskId);
      decodeOutcome(outcome, task.task);
      const index = this.nextIndex("outcomes", "outcome_index");
      this.database
        .prepare(
          "INSERT INTO outcomes(outcome_index,outcome_id,attempt_id,outcome_json) VALUES(?,?,?,?)",
        )
        .run(index, id, attemptId, json(outcome));
      this.touch(outcome.observedAt);
      return { index, id, attemptId, outcome };
    });
  }

  readOutcomeById(id: string): OutcomeRecord {
    const row = this.one(
      "SELECT outcome_index,outcome_id,attempt_id,outcome_json FROM outcomes WHERE outcome_id=?",
      id,
    );
    const attempt = this.readAttempt(text(row, "attempt_id"));
    return outcomeRecord(row, this.readTask(attempt.taskId).task);
  }

  readOutcome(attemptId: string): OutcomeRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT outcome_index,outcome_id,attempt_id,outcome_json FROM outcomes WHERE attempt_id=?",
      )
      .get(attemptId) as Row | undefined;
    return row === undefined
      ? undefined
      : outcomeRecord(row, this.readTask(this.readAttempt(attemptId).taskId).task);
  }

  updateDelivery(
    owner: CoordinatorOwner,
    attemptId: string,
    delivery: OutcomeDelivery,
  ): OutcomeRecord {
    return this.transaction("update Outcome delivery", () => {
      this.requireOwner(owner);
      decode(OutcomeDeliverySchema, delivery, "Outcome delivery");
      const record = this.readOutcome(attemptId);
      if (record === undefined) throw failure("update Outcome delivery", "Outcome is absent.");
      const outcome = { ...record.outcome, delivery };
      decodeOutcome(outcome, this.readTask(this.readAttempt(attemptId).taskId).task);
      this.database
        .prepare("UPDATE outcomes SET outcome_json=? WHERE attempt_id=?")
        .run(json(outcome), attemptId);
      return { ...record, outcome };
    });
  }

  unsettled(): Array<{ task: TaskRecord; attempt: AttemptRecord; outcome?: OutcomeRecord }> {
    return host("read unsettled records", () => {
      const rows = this.database
        .prepare(
          `SELECT a.attempt_id FROM attempts a LEFT JOIN outcomes o ON o.attempt_id=a.attempt_id WHERE o.attempt_id IS NULL OR json_extract(o.outcome_json,'$.delivery.deliveredAt') IS NULL OR json_extract(a.attempt_json,'$.execution.closedAt') IS NULL OR (json_extract(a.attempt_json,'$.base.kind')='repository' AND (json_extract(a.attempt_json,'$.output.kind') IS NULL OR json_extract(a.attempt_json,'$.output.kind') IN ('applying','discarding') OR (json_extract(a.attempt_json,'$.output.kind')='applied' AND json_extract(a.attempt_json,'$.output.cleanupTip') IS NOT NULL))) ORDER BY a.attempt_index`,
        )
        .all() as Row[];
      return rows.map((row) => {
        const attempt = this.readAttempt(text(row, "attempt_id"));
        const outcome = this.readOutcome(attempt.id);
        return {
          task: this.readTask(attempt.taskId),
          attempt,
          ...(outcome === undefined ? {} : { outcome }),
        };
      });
    });
  }

  hasUnclassifiedIntegrationChild(parentAttemptId: string): boolean {
    const row = this.database
      .prepare(
        `SELECT count(*) AS value FROM attempts WHERE json_extract(attempt_json,'$.lineage.candidateOf.kind')='integrate' AND json_extract(attempt_json,'$.lineage.candidateOf.attemptId')=? AND json_extract(attempt_json,'$.output.kind') IS NULL`,
      )
      .get(parentAttemptId) as Row | undefined;
    return number(row, "value") > 0;
  }

  page(
    section: "intents" | "tasks" | "attempts" | "outcomes",
    after: number,
    limit: number,
  ): unknown[] {
    if (
      !Number.isSafeInteger(after) ||
      after < -1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_PAGE
    )
      throw failure("page records", "Page boundary is outside the supported range.");
    if (section === "intents")
      return (
        this.database
          .prepare(
            "SELECT intent_index,intent_json FROM intents WHERE intent_index>? ORDER BY intent_index LIMIT ?",
          )
          .all(after, limit) as Row[]
      ).map(intentRecord);
    if (section === "tasks")
      return (
        this.database
          .prepare(
            "SELECT task_index,task_id,intent_index,task_json FROM tasks WHERE task_index>? ORDER BY task_index LIMIT ?",
          )
          .all(after, limit) as Row[]
      ).map(taskRecord);
    if (section === "attempts")
      return (
        this.database
          .prepare(
            "SELECT attempt_index,attempt_id,task_id,sequence,attempt_json FROM attempts WHERE attempt_index>? ORDER BY attempt_index LIMIT ?",
          )
          .all(after, limit) as Row[]
      ).map(attemptRecord);
    return (
      this.database
        .prepare(
          "SELECT outcome_index,outcome_id,attempt_id,outcome_json FROM outcomes WHERE outcome_index>? ORDER BY outcome_index LIMIT ?",
        )
        .all(after, limit) as Row[]
    ).map((row) => {
      const attempt = this.readAttempt(text(row, "attempt_id"));
      return outcomeRecord(row, this.readTask(attempt.taskId).task);
    });
  }

  complete(owner: CoordinatorOwner, completion: Completion): WorkstreamMetadata {
    return this.transaction("complete Workstream", () => {
      this.requireOwner(owner);
      decode(WorkstreamMetadataSchema.properties.completion, completion, "completion");
      if (this.readMetadata().lifecycle === "completed")
        throw failure("complete Workstream", "Workstream is already complete.");
      const missing = number(
        this.database
          .prepare(
            "SELECT count(*) AS value FROM attempts a LEFT JOIN outcomes o ON o.attempt_id=a.attempt_id WHERE o.attempt_id IS NULL",
          )
          .get(),
        "value",
      );
      if (missing !== 0)
        throw failure("complete Workstream", "Every Attempt must have an Outcome.");
      this.database
        .prepare(
          "UPDATE metadata SET lifecycle='completed',completion_json=?,updated_at=? WHERE singleton=1",
        )
        .run(json(completion), completion.completedAt);
      return this.readMetadata();
    });
  }

  adopt(
    expected: CoordinatorOwner,
    successor: CoordinatorOwner,
    exactPriorAbsent: boolean,
    at: string,
  ): WorkstreamMetadata {
    return this.transaction("adopt Workstream", () => {
      if (!exactPriorAbsent)
        throw failure("adopt Workstream", "Exact prior Coordinator absence was not established.");
      this.requireOwner(expected);
      decode(CoordinatorOwnerSchema, successor, "successor owner");
      this.database
        .prepare(
          "UPDATE metadata SET owner_session_id=?,owner_session_file=?,owner_workspace_id=?,owner_tab_id=?,updated_at=? WHERE singleton=1",
        )
        .run(
          successor.sessionId,
          successor.sessionFile,
          successor.workspaceId,
          successor.tabId,
          at,
        );
      return this.readMetadata();
    });
  }

  private requireOwner(owner: CoordinatorOwner): void {
    if (!Value.Equal(this.readMetadata().owner, owner))
      throw failure("write Workstream", "Coordinator is not the exact owner.");
  }

  private touch(at: string): void {
    this.database.prepare("UPDATE metadata SET updated_at=? WHERE singleton=1").run(at);
  }

  private nextIndex(table: "tasks" | "attempts" | "outcomes", column: string): number {
    return number(
      this.database.prepare(`SELECT coalesce(max(${column}),-1)+1 AS value FROM ${table}`).get(),
      "value",
    );
  }

  private one(sql: string, ...parameters: Array<string | number>): Row {
    const row = this.database.prepare(sql).get(...parameters) as Row | undefined;
    if (row === undefined) throw failure("read record", "Required record is absent.");
    return row;
  }

  private transaction<A>(operation: string, run: () => A): A {
    if (this.readOnly) throw failure(operation, "Store is read-only.");
    return host(operation, () => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const result = run();
        this.database.exec("COMMIT");
        return result;
      } catch (cause) {
        this.database.exec("ROLLBACK");
        throw cause;
      }
    });
  }
}

function privateParents(path: string): void {
  const workstreams = dirname(dirname(path));
  const workgraph = dirname(workstreams);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(workgraph, 0o700);
  chmodSync(workstreams, 0o700);
  chmodSync(dirname(path), 0o700);
}
function intentRecord(row: Row): IntentRecord {
  return {
    index: number(row, "intent_index"),
    intent: parse(IntentSchema, row["intent_json"], "Intent"),
  };
}
function taskRecord(row: Row): TaskRecord {
  return {
    index: number(row, "task_index"),
    id: text(row, "task_id"),
    intentIndex: number(row, "intent_index"),
    task: parse(TaskSchema, row["task_json"], "Task"),
  };
}
function attemptRecord(row: Row): AttemptRecord {
  return {
    index: number(row, "attempt_index"),
    id: text(row, "attempt_id"),
    taskId: text(row, "task_id"),
    sequence: number(row, "sequence"),
    attempt: parse(AttemptSchema, row["attempt_json"], "Attempt"),
  };
}
function outcomeRecord(row: Row, task: Task): OutcomeRecord {
  const outcome = parse(OutcomeSchema, row["outcome_json"], "Outcome");
  decodeOutcome(outcome, task);
  return {
    index: number(row, "outcome_index"),
    id: text(row, "outcome_id"),
    attemptId: text(row, "attempt_id"),
    outcome,
  };
}
function decodeOutcome(outcome: Outcome, task: Task): void {
  decode(OutcomeSchema, outcome, "Outcome");
  const keys = outcome.effectiveModels.map((target) => `${target.model}\0${target.thinking}`);
  if (new Set(keys).size !== keys.length)
    throw failure("decode Outcome", "Effective models are not ordered-distinct.");
  if (outcome.result.kind === "reported") {
    const expected =
      task.contract.kind === "implementation"
        ? "implementation"
        : task.contract.kind === "review"
          ? "review"
          : "research";
    if (outcome.result.report.kind !== expected)
      throw failure("decode Outcome", "Report kind does not match its Task.");
  }
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
function text(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw failure("decode row", `${field} is malformed.`);
  return value;
}
function number(row: Row | undefined, field: string): number {
  const value = row?.[field];
  if (typeof value !== "number") throw failure("decode row", `${field} is malformed.`);
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
