import { randomUUID } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Synchronous SQLite setup requires synchronous directory creation.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native paths are part of the synchronous registry API.
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Config, ConfigProvider, Data, Effect, Option } from "effect";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { SessionIdentity, WorkstreamState } from "./workstream.js";

const LEASE_DURATION_MS = 30_000;
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

const StatePathRowSchema = Type.Object({ state_path: Type.String({ minLength: 1 }) });
const LifecycleRowSchema = Type.Object({
  lifecycle: Type.Union([
    Type.Literal("active"),
    Type.Literal("suspended"),
    Type.Literal("completed"),
    Type.Literal("abandoned"),
    Type.Literal("archived"),
  ]),
});
const LeaseRowSchema = Type.Object({
  token: Type.String({ minLength: 1 }),
  expires_at: Type.String({ minLength: 1 }),
});
const LeaseExpiryRowSchema = Type.Object({
  expires_at: Type.String({ minLength: 1 }),
});
type StatePathRow = Static<typeof StatePathRowSchema>;
type LifecycleRow = Static<typeof LifecycleRowSchema>;
type LeaseRow = Static<typeof LeaseRowSchema>;
type LeaseExpiryRow = Static<typeof LeaseExpiryRowSchema>;
type NativeSqliteRow = Exclude<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>, undefined>;

function decodeStatePathRow(row: NativeSqliteRow): StatePathRow {
  if (!Value.Check(StatePathRowSchema, row)) throw new Error("Invalid registry state path row.");
  return Value.Decode(StatePathRowSchema, row);
}

function decodeLifecycleRow(row: NativeSqliteRow): LifecycleRow {
  if (!Value.Check(LifecycleRowSchema, row)) throw new Error("Invalid registry lifecycle row.");
  return Value.Decode(LifecycleRowSchema, row);
}

function decodeLeaseRow(row: NativeSqliteRow): LeaseRow {
  if (!Value.Check(LeaseRowSchema, row)) throw new Error("Invalid registry lease row.");
  return Value.Decode(LeaseRowSchema, row);
}

function decodeLeaseExpiryRow(row: NativeSqliteRow): LeaseExpiryRow {
  if (!Value.Check(LeaseExpiryRowSchema, row)) throw new Error("Invalid registry lease row.");
  return Value.Decode(LeaseExpiryRowSchema, row);
}

/** Fenced ownership and an index only. Workstream files own lifecycle and coordinator history. */
export class WorkgraphRegistry {
  readonly db: DatabaseSync;
  constructor(readonly path = defaultRegistryPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    // Keep the existing index column names so historical references remain readable.
    // No historical state or unused tables are migrated or rewritten here.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY, state_path TEXT NOT NULL UNIQUE,
        project_root TEXT NOT NULL, git_common_dir TEXT NOT NULL, phase TEXT NOT NULL,
        lifecycle TEXT NOT NULL, updated_at TEXT NOT NULL, indexed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS leases (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE, owner_session_id TEXT NOT NULL,
        owner_session_file TEXT NOT NULL, acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
    `);
  }
  close(): void {
    this.db.close();
  }

  indexWorkstream(reference: {
    runId: string;
    statePath: string;
    projectRoot: string;
    gitCommonDir: string;
    lifecycle: WorkstreamState["lifecycle"]["state"];
    updatedAt: string;
  }): void {
    const previous = this.findRun(reference.runId);
    if (previous && previous.statePath !== reference.statePath)
      throw new Error("Workstream registry identity collision.");
    this.db
      .prepare(`INSERT INTO runs(run_id,state_path,project_root,git_common_dir,phase,lifecycle,updated_at,indexed_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET lifecycle=excluded.lifecycle,
      updated_at=excluded.updated_at,indexed_at=excluded.indexed_at`)
      .run(
        reference.runId,
        reference.statePath,
        reference.projectRoot,
        reference.gitCommonDir,
        "workstream",
        reference.lifecycle,
        reference.updatedAt,
        // oxlint-disable-next-line effecttsgo/global-date -- Registry indexing records a native wall-clock timestamp synchronously.
        new Date().toISOString(),
      );
  }

  findRun(runId: string): { statePath: string } | undefined {
    const row = this.db.prepare("SELECT state_path FROM runs WHERE run_id=?").get(runId);
    if (!row) return undefined;
    const decoded = decodeStatePathRow(row);
    return { statePath: decoded.state_path };
  }

  acquire(
    runId: string,
    owner: LeaseOwner,
    // oxlint-disable-next-line effecttsgo/global-date -- The public fenced-lease API accepts native Date values for SQLite ISO ordering.
    now = new Date(),
    liveness: "alive" | "dead" | "unknown" = "unknown",
  ): Lease {
    const acquiredAt = now.toISOString();
    // oxlint-disable-next-line effecttsgo/global-date -- Lease timestamps remain native ISO strings for synchronous SQLite comparison.
    const expiresAt = new Date(now.getTime() + LEASE_DURATION_MS).toISOString();
    const token = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.db.prepare("SELECT lifecycle FROM runs WHERE run_id=?").get(runId);
      if (!run) throw new Error(`Unknown Workgraph ${runId}.`);
      const lifecycle = decodeLifecycleRow(run).lifecycle;
      if (lifecycle !== "active" && lifecycle !== "suspended")
        throw new Error(`Workgraph ${runId} is ${lifecycle}.`);
      const current = this.db.prepare("SELECT expires_at FROM leases WHERE run_id=?").get(runId);
      const currentLease = current ? decodeLeaseExpiryRow(current) : undefined;
      if (currentLease && (currentLease.expires_at > acquiredAt || liveness !== "dead")) {
        throw new LeaseDecisionRequiredError(
          `Workstream ${runId} already has a runtime owner; stop it or establish expired dead ownership before reattachment.`,
        );
      }
      this.db
        .prepare(`INSERT INTO leases(run_id,token,owner_session_id,owner_session_file,acquired_at,heartbeat_at,expires_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET token=excluded.token, owner_session_id=excluded.owner_session_id,
        owner_session_file=excluded.owner_session_file, acquired_at=excluded.acquired_at, heartbeat_at=excluded.heartbeat_at, expires_at=excluded.expires_at`)
        .run(runId, token, owner.sessionId, owner.sessionFile, acquiredAt, acquiredAt, expiresAt);
      this.db.exec("COMMIT");
      return {
        runId,
        token,
        owner,
        acquiredAt,
        heartbeatAt: acquiredAt,
        expiresAt,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  assertLease(
    lease: Lease,
    // oxlint-disable-next-line effecttsgo/global-date -- The public fenced-lease API accepts native Date values.
    now = new Date(),
  ): void {
    const row = this.db
      .prepare("SELECT token, expires_at FROM leases WHERE run_id=? AND owner_session_id=?")
      .get(lease.runId, lease.owner.sessionId);
    const decoded = row ? decodeLeaseRow(row) : undefined;
    if (
      decoded === undefined ||
      decoded.token !== lease.token ||
      decoded.expires_at <= now.toISOString()
    ) {
      throw new LeaseDecisionRequiredError(
        `Workstream ${lease.runId} no longer holds a live lease.`,
      );
    }
  }

  renew(
    lease: Lease,
    // oxlint-disable-next-line effecttsgo/global-date -- The public fenced-lease API accepts native Date values.
    now = new Date(),
  ): Lease {
    this.assertLease(lease, now);
    const heartbeatAt = now.toISOString();
    // oxlint-disable-next-line effecttsgo/global-date -- Lease timestamps remain native ISO strings for synchronous SQLite comparison.
    const expiresAt = new Date(now.getTime() + LEASE_DURATION_MS).toISOString();
    const result = this.db
      .prepare(
        "UPDATE leases SET heartbeat_at=?, expires_at=? WHERE run_id=? AND token=? AND owner_session_id=? AND expires_at>?",
      )
      .run(heartbeatAt, expiresAt, lease.runId, lease.token, lease.owner.sessionId, heartbeatAt);
    if (result.changes !== 1)
      throw new Error(
        `Lease for ${lease.runId} is no longer owned by session ${lease.owner.sessionId}.`,
      );
    return { ...lease, heartbeatAt, expiresAt };
  }

  release(lease: Lease): void {
    this.db
      .prepare("DELETE FROM leases WHERE run_id=? AND token=? AND owner_session_id=?")
      .run(lease.runId, lease.token, lease.owner.sessionId);
  }
}

const RegistryAgentDirectoryConfig = Config.nonEmptyString("PI_CODING_AGENT_DIR").pipe(
  Config.option,
);

export function defaultRegistryPath(agentDir?: string): string {
  const configured =
    agentDir === undefined
      ? Option.getOrUndefined(
          Effect.runSync(
            RegistryAgentDirectoryConfig.parse(ConfigProvider.fromEnvRecord(process.env)),
          ),
        )
      : agentDir;
  return join(configured ?? join(homedir(), ".pi", "agent"), "workgraph", "registry.sqlite");
}
