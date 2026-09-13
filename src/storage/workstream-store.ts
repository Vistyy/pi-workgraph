/* oxlint-disable effecttsgo/node-builtin-import, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread, typescript/no-unsafe-return -- node:sqlite exposes unknown host rows; every behavior-authorizing payload is strictly decoded below. */
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Data } from "effect";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  type AttemptRecord,
  AttemptRecordSchema,
  type CoordinatorOwner,
  CoordinatorOwnerSchema,
  type IntentRecord,
  IntentRecordSchema,
  type OutcomeRecord,
  OutcomeRecordSchema,
  type TaskRecord,
  TaskRecordSchema,
  type WorkstreamMetadata,
  WorkstreamMetadataSchema,
} from "../domain/records.js";

const SCHEMA = `
PRAGMA foreign_keys=ON;
CREATE TABLE metadata (id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
CREATE TABLE intents (workstream_id TEXT NOT NULL REFERENCES metadata(id), intent_index INTEGER NOT NULL CHECK(intent_index>=0), payload TEXT NOT NULL, PRIMARY KEY(workstream_id,intent_index)) STRICT;
CREATE TABLE tasks (id TEXT PRIMARY KEY, workstream_id TEXT NOT NULL REFERENCES metadata(id), intent_index INTEGER NOT NULL, payload TEXT NOT NULL, FOREIGN KEY(workstream_id,intent_index) REFERENCES intents(workstream_id,intent_index)) STRICT;
CREATE TABLE attempts (id TEXT PRIMARY KEY, workstream_id TEXT NOT NULL REFERENCES metadata(id), task_id TEXT NOT NULL REFERENCES tasks(id), sequence INTEGER NOT NULL CHECK(sequence>=0), payload TEXT NOT NULL, UNIQUE(task_id,sequence)) STRICT;
CREATE TABLE outcomes (id TEXT PRIMARY KEY, workstream_id TEXT NOT NULL REFERENCES metadata(id), attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id), payload TEXT NOT NULL) STRICT;
`;
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type Row = Record<string, unknown>;

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
  ) {
    this.path = path;
  }

  static pathFor(agentDir: string, id: string): string {
    if (!safeId.test(id))
      throw failure("resolve path", "Workstream id is not a safe path segment.");
    return join(agentDir, "workgraph", "workstreams", id, "workstream.sqlite");
  }

  static create(
    agentDir: string,
    metadata: WorkstreamMetadata,
    intent: IntentRecord,
  ): WorkstreamStore {
    return host("create workstream", () => {
      if (metadata.id !== intent.workstreamId || intent.index !== 0)
        throw failure("create workstream", "Initial records disagree.");
      decode(WorkstreamMetadataSchema, metadata, "metadata");
      decode(IntentRecordSchema, intent, "intent");
      const path = WorkstreamStore.pathFor(agentDir, metadata.id);
      const directory = join(agentDir, "workgraph", "workstreams", metadata.id);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(join(agentDir, "workgraph"), 0o700);
      chmodSync(join(agentDir, "workgraph", "workstreams"), 0o700);
      chmodSync(directory, 0o700);
      const database = new DatabaseSync(path);
      try {
        database.exec(SCHEMA);
        database
          .prepare("INSERT INTO metadata(id,payload) VALUES(?,?)")
          .run(metadata.id, json(metadata));
        database
          .prepare("INSERT INTO intents(workstream_id,intent_index,payload) VALUES(?,?,?)")
          .run(metadata.id, 0, json(intent));
        chmodSync(path, 0o600);
        return new WorkstreamStore(metadata.id, database, path);
      } catch (cause) {
        database.close();
        throw cause;
      }
    });
  }

  static open(agentDir: string, id: string): WorkstreamStore {
    return host("open workstream", () => {
      const path = WorkstreamStore.pathFor(agentDir, id);
      const database = new DatabaseSync(path);
      database.exec("PRAGMA foreign_keys=ON");
      const store = new WorkstreamStore(id, database, path);
      if (store.metadata().id !== id)
        throw failure("open workstream", "Foreign metadata identity.");
      return store;
    });
  }

  close(): void {
    host("close workstream", () => this.database.close());
  }

  metadata(): WorkstreamMetadata {
    const row = this.one("SELECT payload FROM metadata WHERE id=?", this.id);
    return payload(WorkstreamMetadataSchema, row, "metadata");
  }

  currentIntent(): IntentRecord {
    const row = this.one(
      "SELECT payload FROM intents WHERE workstream_id=? ORDER BY intent_index DESC LIMIT 1",
      this.id,
    );
    return payload(IntentRecordSchema, row, "intent");
  }

  appendIntent(owner: CoordinatorOwner, intent: IntentRecord): void {
    this.transaction("append intent", () => {
      this.requireOwner(owner);
      const current = this.currentIntent();
      if (intent.workstreamId !== this.id || intent.index !== current.index + 1)
        throw failure("append intent", "Intent order is not contiguous.");
      decode(IntentRecordSchema, intent, "intent");
      this.database
        .prepare("INSERT INTO intents(workstream_id,intent_index,payload) VALUES(?,?,?)")
        .run(this.id, intent.index, json(intent));
      this.touch(intent.recordedAt);
    });
  }

  createTask(owner: CoordinatorOwner, task: TaskRecord): void {
    this.transaction("create task", () => {
      this.requireOwner(owner);
      if (task.workstreamId !== this.id || task.intentIndex !== this.currentIntent().index)
        throw failure("create task", "Task must belong to the current Intent.");
      decode(TaskRecordSchema, task, "task");
      this.database
        .prepare("INSERT INTO tasks(id,workstream_id,intent_index,payload) VALUES(?,?,?,?)")
        .run(task.id, this.id, task.intentIndex, json(task));
      this.touch(task.createdAt);
    });
  }

  task(id: string): TaskRecord {
    return payload(
      TaskRecordSchema,
      this.one("SELECT payload FROM tasks WHERE id=? AND workstream_id=?", id, this.id),
      "task",
    );
  }

  createAttempt(owner: CoordinatorOwner, attempt: AttemptRecord): void {
    this.transaction("create attempt", () => {
      this.requireOwner(owner);
      const task = this.task(attempt.taskId);
      if (attempt.workstreamId !== this.id)
        throw failure("create attempt", "Attempt has a foreign Workstream.");
      const next = numberValue(
        this.database
          .prepare("SELECT count(*) AS value FROM attempts WHERE task_id=?")
          .get(task.id),
        "value",
      );
      if (attempt.sequence !== next)
        throw failure("create attempt", "Attempt sequence is not contiguous.");
      if (attempt.lineage !== undefined) this.requireLineage(task, attempt);
      decode(AttemptRecordSchema, attempt, "attempt");
      this.database
        .prepare(
          "INSERT INTO attempts(id,workstream_id,task_id,sequence,payload) VALUES(?,?,?,?,?)",
        )
        .run(attempt.id, this.id, task.id, attempt.sequence, json(attempt));
      this.touch(attempt.createdAt);
    });
  }

  attempt(id: string): AttemptRecord {
    return payload(
      AttemptRecordSchema,
      this.one("SELECT payload FROM attempts WHERE id=? AND workstream_id=?", id, this.id),
      "attempt",
    );
  }

  checkpointAttempt(owner: CoordinatorOwner, attempt: AttemptRecord): void {
    this.transaction("checkpoint attempt", () => {
      this.requireOwner(owner);
      const prior = this.attempt(attempt.id);
      if (
        prior.workstreamId !== attempt.workstreamId ||
        prior.taskId !== attempt.taskId ||
        prior.sequence !== attempt.sequence ||
        json(prior.models) !== json(attempt.models) ||
        json(prior.lineage) !== json(attempt.lineage)
      )
        throw failure("checkpoint attempt", "Immutable Attempt facts changed.");
      decode(AttemptRecordSchema, attempt, "attempt");
      this.database
        .prepare("UPDATE attempts SET payload=? WHERE id=? AND workstream_id=?")
        .run(json(attempt), attempt.id, this.id);
    });
  }

  recordOutcome(owner: CoordinatorOwner, outcome: OutcomeRecord): void {
    this.transaction("record outcome", () => {
      this.requireOwner(owner);
      const attempt = this.attempt(outcome.attemptId);
      if (attempt.workstreamId !== outcome.workstreamId)
        throw failure("record outcome", "Outcome has a foreign Attempt.");
      decode(OutcomeRecordSchema, outcome, "outcome");
      this.database
        .prepare("INSERT INTO outcomes(id,workstream_id,attempt_id,payload) VALUES(?,?,?,?)")
        .run(outcome.id, this.id, attempt.id, json(outcome));
      this.touch(outcome.observedAt);
    });
  }

  outcomeForAttempt(attemptId: string): OutcomeRecord | undefined {
    const row = this.database
      .prepare("SELECT payload FROM outcomes WHERE attempt_id=? AND workstream_id=?")
      .get(attemptId, this.id) as Row | undefined;
    return row === undefined ? undefined : payload(OutcomeRecordSchema, row, "outcome");
  }

  updateDelivery(owner: CoordinatorOwner, outcome: OutcomeRecord): void {
    this.transaction("update delivery", () => {
      this.requireOwner(owner);
      const prior = this.outcomeForAttempt(outcome.attemptId);
      if (
        prior === undefined ||
        json({ ...prior, delivery: undefined }) !== json({ ...outcome, delivery: undefined })
      )
        throw failure("update delivery", "Only Outcome delivery facts are mutable.");
      decode(OutcomeRecordSchema, outcome, "outcome");
      this.database
        .prepare("UPDATE outcomes SET payload=? WHERE id=? AND workstream_id=?")
        .run(json(outcome), outcome.id, this.id);
    });
  }

  unsettled(): Array<{ task: TaskRecord; attempt: AttemptRecord; outcome?: OutcomeRecord }> {
    return host("read unsettled records", () => {
      const rows = this.database
        .prepare(
          `SELECT t.payload AS task,a.payload AS attempt,o.payload AS outcome FROM attempts a JOIN tasks t ON t.id=a.task_id LEFT JOIN outcomes o ON o.attempt_id=a.id WHERE a.workstream_id=? AND (o.id IS NULL OR json_extract(o.payload,'$.delivery.state')='pending' OR json_extract(a.payload,'$.worker.closedAt') IS NULL) ORDER BY a.rowid`,
        )
        .all(this.id) as Row[];
      return rows.map((row) => ({
        task: jsonField(TaskRecordSchema, row["task"], "task"),
        attempt: jsonField(AttemptRecordSchema, row["attempt"], "attempt"),
        ...(row["outcome"] === null
          ? {}
          : { outcome: jsonField(OutcomeRecordSchema, row["outcome"], "outcome") }),
      }));
    });
  }

  page(
    section: "intents" | "tasks" | "attempts" | "outcomes",
    offset: number,
    limit: number,
  ): unknown[] {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw failure("inspect records", "Offset or limit is outside the supported range.");
    const schemas = {
      intents: IntentRecordSchema,
      tasks: TaskRecordSchema,
      attempts: AttemptRecordSchema,
      outcomes: OutcomeRecordSchema,
    } as const;
    return host("inspect records", () =>
      (
        this.database
          .prepare(
            `SELECT payload FROM ${section} WHERE workstream_id=? ORDER BY rowid LIMIT ? OFFSET ?`,
          )
          .all(this.id, limit, offset) as Row[]
      ).map((row) => payload(schemas[section], row, section)),
    );
  }

  complete(
    owner: CoordinatorOwner,
    completion: NonNullable<WorkstreamMetadata["completion"]>,
  ): WorkstreamMetadata {
    return this.transaction("complete workstream", () => {
      this.requireOwner(owner);
      const missing = numberValue(
        this.database
          .prepare(
            "SELECT count(*) AS value FROM attempts a LEFT JOIN outcomes o ON o.attempt_id=a.id WHERE a.workstream_id=? AND o.id IS NULL",
          )
          .get(this.id),
        "value",
      );
      if (missing !== 0)
        throw failure("complete workstream", "Every Attempt must have an Outcome.");
      const metadata = {
        ...this.metadata(),
        lifecycle: "completed" as const,
        completion,
        updatedAt: completion.completedAt,
      };
      decode(WorkstreamMetadataSchema, metadata, "metadata");
      this.database
        .prepare("UPDATE metadata SET payload=? WHERE id=?")
        .run(json(metadata), this.id);
      return metadata;
    });
  }

  adopt(
    expected: CoordinatorOwner,
    successor: CoordinatorOwner,
    exactPriorAbsent: boolean,
    at: string,
  ): WorkstreamMetadata {
    return this.transaction("adopt workstream", () => {
      if (!exactPriorAbsent)
        throw failure("adopt workstream", "Exact prior Coordinator absence was not established.");
      this.requireOwner(expected);
      decode(CoordinatorOwnerSchema, successor, "successor owner");
      const metadata = { ...this.metadata(), owner: successor, updatedAt: at };
      decode(WorkstreamMetadataSchema, metadata, "metadata");
      this.database
        .prepare("UPDATE metadata SET payload=? WHERE id=?")
        .run(json(metadata), this.id);
      return metadata;
    });
  }

  private requireLineage(task: TaskRecord, attempt: AttemptRecord): void {
    const lineage = attempt.lineage;
    if (
      lineage === undefined ||
      task.target.kind !== "repository" ||
      attempt.repository === undefined
    )
      throw failure("create attempt", "Candidate lineage requires a repository Attempt.");
    const parent = this.attempt(lineage.parentAttemptId);
    if (
      parent.repository === undefined ||
      parent.repository.commonDir !== task.target.commonDir ||
      parent.repository.candidateRevision !== lineage.parentCommit
    )
      throw failure(
        "create attempt",
        "Candidate lineage does not match retained parent output in the same repository.",
      );
  }

  private requireOwner(owner: CoordinatorOwner): void {
    if (!Value.Equal(this.metadata().owner, owner))
      throw failure("mutate workstream", "Coordinator is not the exact owner.");
  }

  private touch(at: string): void {
    const metadata = { ...this.metadata(), updatedAt: at };
    this.database.prepare("UPDATE metadata SET payload=? WHERE id=?").run(json(metadata), this.id);
  }

  private one(sql: string, ...params: Array<string | number>): Row {
    const row = this.database.prepare(sql).get(...params) as Row | undefined;
    if (row === undefined) throw failure("read record", "Required record is absent.");
    return row;
  }

  private transaction<A>(operation: string, run: () => A): A {
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

function payload<S extends TSchema>(schema: S, row: Row, name: string): Static<S> {
  return jsonField(schema, row["payload"], name);
}
function jsonField<S extends TSchema>(schema: S, value: unknown, name: string): Static<S> {
  if (typeof value !== "string") throw failure("decode record", `${name} payload is not text.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw failure("decode record", `${name} payload is not JSON.`, cause);
  }
  return decode(schema, parsed, name);
}
function decode<S extends TSchema>(schema: S, value: unknown, name: string): Static<S> {
  if (!Value.Check(schema, value)) throw failure("decode record", `${name} payload is malformed.`);
  return Value.Decode(schema, value) as Static<S>;
}
function numberValue(row: unknown, field: string): number {
  const value = (row as Row | undefined)?.[field];
  if (typeof value !== "number") throw failure("read record", `${field} is malformed.`);
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
