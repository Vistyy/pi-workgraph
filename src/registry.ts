import { DatabaseSync } from "node:sqlite";
import { access, mkdir, readdir, readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RunLifecycle, WorkgraphRun } from "./types.js";

export const REGISTRY_SCHEMA_VERSION = 1 as const;
export const LEASE_DURATION_MS = 30_000;

export interface RegistryRun {
  runId: string;
  statePath: string;
  projectRoot: string;
  gitCommonDir: string;
  phase: string;
  lifecycle: RunLifecycle;
  updatedAt: string;
  ownerSessionId?: string;
  leaseExpiresAt?: string;
}

export interface LeaseOwner {
  sessionId: string;
  sessionFile: string;
}

export interface Lease {
  runId: string;
  token: string;
  owner: LeaseOwner;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export class LeaseDecisionRequiredError extends Error {
  readonly code = "lease_decision_required";
  constructor(message: string) {
    super(message);
    this.name = "LeaseDecisionRequiredError";
  }
}

export class WorkgraphRegistry {
  readonly db: DatabaseSync;

  constructor(readonly path = defaultRegistryPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        state_path TEXT NOT NULL UNIQUE,
        project_root TEXT NOT NULL,
        git_common_dir TEXT NOT NULL,
        phase TEXT NOT NULL,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','suspended','completed','abandoned','archived')),
        updated_at TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS leases (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        owner_session_id TEXT NOT NULL,
        owner_session_file TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bindings (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        session_file TEXT NOT NULL,
        bound_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lifecycle_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        from_lifecycle TEXT,
        to_lifecycle TEXT NOT NULL,
        reason TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_project_idx ON runs(project_root);
      CREATE INDEX IF NOT EXISTS runs_lifecycle_idx ON runs(lifecycle);
      CREATE INDEX IF NOT EXISTS lifecycle_events_run_idx ON lifecycle_events(run_id, id);
    `);
    this.db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES('version', ?)").run(String(REGISTRY_SCHEMA_VERSION));
  }

  close(): void { this.db.close(); }

  indexRun(run: WorkgraphRun): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO runs(run_id,state_path,project_root,git_common_dir,phase,lifecycle,updated_at,indexed_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET state_path=excluded.state_path, project_root=excluded.project_root,
      git_common_dir=excluded.git_common_dir, phase=excluded.phase, lifecycle=excluded.lifecycle,
      updated_at=excluded.updated_at, indexed_at=excluded.indexed_at`).run(
      run.runId, run.statePath, run.projectRoot, run.gitCommonDir, run.phase, run.lifecycle, run.updatedAt, now,
    );
    this.db.prepare(`INSERT INTO bindings(run_id,session_id,session_file,bound_at) VALUES(?,?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET session_id=excluded.session_id, session_file=excluded.session_file, bound_at=excluded.bound_at`).run(
      run.runId, run.coordinator.sessionId, run.coordinator.sessionFile, run.coordinator.boundAt,
    );
  }

  findRun(runId: string): RegistryRun | undefined {
    const row = this.db.prepare(`SELECT r.*, l.owner_session_id, l.expires_at AS lease_expires_at FROM runs r
      LEFT JOIN leases l ON l.run_id=r.run_id WHERE r.run_id=?`).get(runId) as Record<string, unknown> | undefined;
    return row ? toRegistryRun(row) : undefined;
  }

  findByProject(projectRoot: string): RegistryRun[] {
    return (this.db.prepare("SELECT r.*, l.owner_session_id, l.expires_at AS lease_expires_at FROM runs r LEFT JOIN leases l ON l.run_id=r.run_id WHERE r.project_root=? ORDER BY r.updated_at DESC").all(projectRoot) as Record<string, unknown>[]).map(toRegistryRun);
  }

  acquire(runId: string, owner: LeaseOwner, now = new Date(), liveness: "alive" | "dead" | "unknown" = "unknown"): Lease {
    const acquiredAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + LEASE_DURATION_MS).toISOString();
    const token = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.db.prepare("SELECT lifecycle FROM runs WHERE run_id=?").get(runId) as { lifecycle?: RunLifecycle } | undefined;
      if (!run) throw new Error(`Unknown Workgraph ${runId}.`);
      if (run.lifecycle === "archived" || run.lifecycle === "abandoned") throw new Error(`Workgraph ${runId} is ${run.lifecycle}.`);
      const current = this.db.prepare("SELECT * FROM leases WHERE run_id=?").get(runId) as LeaseRow | undefined;
      if (current && current.expires_at > acquiredAt && current.owner_session_id !== owner.sessionId) {
        throw new Error(`Workgraph ${runId} is leased by session ${current.owner_session_id}.`);
      }
      if (current && current.owner_session_id === owner.sessionId) {
        const renewed: Lease = { runId, token: current.token, owner, acquiredAt: current.acquired_at, heartbeatAt: acquiredAt, expiresAt };
        this.db.prepare("UPDATE leases SET owner_session_file=?, heartbeat_at=?, expires_at=? WHERE run_id=? AND token=?").run(owner.sessionFile, acquiredAt, expiresAt, runId, current.token);
        this.db.exec("COMMIT");
        return renewed;
      }
      if (current && liveness !== "dead") {
        throw new LeaseDecisionRequiredError(`Lease for ${runId} expired, but prior owner liveness is ${liveness}; reconcile before takeover.`);
      }
      this.db.prepare(`INSERT INTO leases(run_id,token,owner_session_id,owner_session_file,acquired_at,heartbeat_at,expires_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET token=excluded.token, owner_session_id=excluded.owner_session_id,
        owner_session_file=excluded.owner_session_file, acquired_at=excluded.acquired_at, heartbeat_at=excluded.heartbeat_at, expires_at=excluded.expires_at`).run(
        runId, token, owner.sessionId, owner.sessionFile, acquiredAt, acquiredAt, expiresAt,
      );
      this.db.exec("COMMIT");
      return { runId, token, owner, acquiredAt, heartbeatAt: acquiredAt, expiresAt };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  renew(lease: Lease, now = new Date()): Lease {
    const heartbeatAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + LEASE_DURATION_MS).toISOString();
    const result = this.db.prepare("UPDATE leases SET heartbeat_at=?, expires_at=? WHERE run_id=? AND token=? AND owner_session_id=?").run(heartbeatAt, expiresAt, lease.runId, lease.token, lease.owner.sessionId);
    if (result.changes !== 1) throw new Error(`Lease for ${lease.runId} is no longer owned by session ${lease.owner.sessionId}.`);
    return { ...lease, heartbeatAt, expiresAt };
  }

  release(lease: Lease): void {
    this.db.prepare("DELETE FROM leases WHERE run_id=? AND token=? AND owner_session_id=?").run(lease.runId, lease.token, lease.owner.sessionId);
  }

  bind(runId: string, owner: LeaseOwner, at = new Date()): void {
    this.db.prepare(`INSERT INTO bindings(run_id,session_id,session_file,bound_at) VALUES(?,?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET session_id=excluded.session_id, session_file=excluded.session_file, bound_at=excluded.bound_at`).run(runId, owner.sessionId, owner.sessionFile, at.toISOString());
  }

  transitionLifecycle(runId: string, to: RunLifecycle, reason: string, at = new Date()): void {
    const row = this.db.prepare("SELECT lifecycle FROM runs WHERE run_id=?").get(runId) as { lifecycle?: RunLifecycle } | undefined;
    if (!row?.lifecycle) throw new Error(`Unknown Workgraph ${runId}.`);
    const from = row.lifecycle;
    if (!allowedLifecycleTransitions[from].includes(to)) throw new Error(`Invalid lifecycle transition ${runId}: ${from} -> ${to}.`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE runs SET lifecycle=?, updated_at=?, indexed_at=? WHERE run_id=?").run(to, at.toISOString(), at.toISOString(), runId);
      this.db.prepare("INSERT INTO lifecycle_events(run_id,from_lifecycle,to_lifecycle,reason,at) VALUES(?,?,?,?,?)").run(runId, from, to, reason, at.toISOString());
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  async rebuild(runsRoot: string): Promise<number> {
    let count = 0;
    for (const entry of await readdir(runsRoot, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const path = join(runsRoot, entry.name, "state.json");
      try {
        const run = JSON.parse(await readFile(path, "utf8")) as WorkgraphRun;
        if (typeof run.runId === "string" && run.coordinator && run.lifecycle) { this.indexRun(run); count++; }
      } catch { /* Retained malformed state is not invented into the index. */ }
    }
    return count;
  }
}

const allowedLifecycleTransitions: Record<RunLifecycle, readonly RunLifecycle[]> = {
  active: ["suspended", "completed", "abandoned"],
  suspended: ["active", "completed", "abandoned"],
  completed: ["archived"],
  abandoned: ["archived"],
  archived: [],
};

export function canTransitionLifecycle(from: RunLifecycle, to: RunLifecycle): boolean { return allowedLifecycleTransitions[from].includes(to); }

interface LeaseRow { token: string; expires_at: string; owner_session_id: string; acquired_at: string; }
function toRegistryRun(row: Record<string, unknown>): RegistryRun {
  return {
    runId: String(row.run_id), statePath: String(row.state_path), projectRoot: String(row.project_root), gitCommonDir: String(row.git_common_dir),
    phase: String(row.phase), lifecycle: row.lifecycle as RunLifecycle, updatedAt: String(row.updated_at),
    ...(row.owner_session_id ? { ownerSessionId: String(row.owner_session_id) } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: String(row.lease_expires_at) } : {}),
  };
}

export function defaultRegistryPath(agentDir = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent")): string {
  return join(agentDir, "workgraph", "registry.sqlite");
}

export async function ensureRegistryPath(path: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await access(dirname(path)); }
