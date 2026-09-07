// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native SQLite is the discovery boundary for CLI and runtime attachment.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native paths are part of the synchronous registry API.
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Config, ConfigProvider, Effect, Option } from "effect";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { legacyPathForWorkstream, pathForWorkstream } from "./workstream-state.js";

const StatePathRowSchema = Type.Object({ state_path: Type.String({ minLength: 1 }) });
const CURRENT_LOCATOR_TABLE = "workgraph_locators";
type StatePathRow = Static<typeof StatePathRowSchema>;
type NativeSqliteRow = Exclude<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>, undefined>;

function decodeStatePathRow(row: NativeSqliteRow): StatePathRow {
  if (!Value.Check(StatePathRowSchema, row)) throw new Error("Invalid registry state path row.");
  return Value.Decode(StatePathRowSchema, row);
}

/**
 * A discovery locator only. Lifecycle, project identity, aggregate state, and
 * fenced ownership belong to the private per-workstream SQLite database.
 *
 * Historical rows from the superseded schema are left untouched. Their
 * runs table is a read-only historical fallback; current attachment always
 * writes the minimal locator table.
 */
export class WorkgraphRegistry {
  readonly db: DatabaseSync;

  constructor(readonly path = defaultRegistryPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS ${CURRENT_LOCATOR_TABLE} (
        run_id TEXT PRIMARY KEY,
        state_path TEXT NOT NULL UNIQUE
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  indexWorkstream(reference: {
    runId: string;
    statePath: string;
    gitCommonDir?: string;
    legacyStatePath?: string;
  }): void {
    const current = readStatePath(this.db, CURRENT_LOCATOR_TABLE, reference.runId);
    if (current && current.statePath !== reference.statePath)
      throw new Error("Workstream registry identity collision.");

    const historical = readStatePath(this.db, "runs", reference.runId);
    if (
      historical &&
      historical.statePath !== reference.statePath &&
      !isCanonicalLegacyTransition(reference, historical.statePath)
    )
      throw new Error("Workstream registry identity collision.");

    this.db
      .prepare(
        `INSERT INTO ${CURRENT_LOCATOR_TABLE}(run_id,state_path) VALUES(?,?)
         ON CONFLICT(run_id) DO NOTHING`,
      )
      .run(reference.runId, reference.statePath);
    if (
      readStatePath(this.db, CURRENT_LOCATOR_TABLE, reference.runId)?.statePath !==
      reference.statePath
    )
      throw new Error("Workstream registry identity collision.");
  }

  findRun(runId: string): { statePath: string } | undefined {
    const current = readStatePath(this.db, CURRENT_LOCATOR_TABLE, runId);
    if (current !== undefined) return current;
    return readStatePath(this.db, "runs", runId);
  }
}

function isCanonicalLegacyTransition(
  reference: {
    runId: string;
    statePath: string;
    gitCommonDir?: string;
    legacyStatePath?: string;
  },
  historicalPath: string,
): boolean {
  const gitCommonDir = reference.gitCommonDir;
  return (
    gitCommonDir !== undefined &&
    reference.legacyStatePath === legacyPathForWorkstream(gitCommonDir, reference.runId) &&
    reference.statePath === pathForWorkstream(gitCommonDir, reference.runId) &&
    historicalPath === reference.legacyStatePath
  );
}

function readStatePath(
  db: DatabaseSync,
  table: string,
  runId: string,
): { statePath: string } | undefined {
  let row: NativeSqliteRow | undefined;
  try {
    row = db.prepare(`SELECT state_path FROM ${table} WHERE run_id=?`).get(runId);
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("no such table")) return undefined;
    throw cause;
  }
  if (!row) return undefined;
  const decoded = decodeStatePathRow(row);
  return { statePath: decoded.state_path };
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
