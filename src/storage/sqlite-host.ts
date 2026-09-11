// oxlint-disable-next-line effecttsgo/node-builtin-import -- Workstream storage identity requires no-follow entry inspection (symlink kind, permission bits, and file size); Effect's FileSystem service follows links and exposes no lstat.
import { lstatSync } from "node:fs";
// node:sqlite owns the native record transaction guarantee; it has no Effect service equivalent.
import { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { Value } from "typebox/value";

const NameRowSchema = Type.Object({ name: Type.String() });

/** No-follow identity of one storage component, taken without resolving symlinks. */
export interface StorageEntry {
  readonly exists: boolean;
  readonly symbolicLink: boolean;
  readonly directory: boolean;
  readonly regularFile: boolean;
  readonly size: number;
  readonly mode: number;
}

type NodeSqliteRow = Exclude<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>, undefined>;

/** The narrow synchronous SQLite handle owned by one workstream store instance. */
export interface WorkstreamDatabase {
  exec(statement: string): void;
  tableNames(): string[];
  columnNames(table: string): string[];
  readRow(statement: string, ...parameters: Array<string | number>): NodeSqliteRow | undefined;
  readRows(statement: string, ...parameters: Array<string | number>): NodeSqliteRow[];
  write(statement: string, ...parameters: Array<string | number | null>): number;
  close(): void;
}

export function inspectStorageEntry(path: string): StorageEntry {
  let status: ReturnType<typeof lstatSync>;
  try {
    status = lstatSync(path);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return {
        exists: false,
        symbolicLink: false,
        directory: false,
        regularFile: false,
        size: 0,
        mode: 0,
      };
    throw cause;
  }
  return {
    exists: true,
    symbolicLink: status.isSymbolicLink(),
    directory: status.isDirectory(),
    regularFile: status.isFile(),
    size: status.size,
    mode: status.mode & 0o777,
  };
}

/**
 * Open and configure one workstream handle. Durability and isolation pragmas are
 * applied here so every caller of this adapter gets the same guarantees.
 */
export function openWorkstreamDatabase(path: string, readOnly = false): WorkstreamDatabase {
  const database = new DatabaseSync(path, { readOnly });
  database.exec("PRAGMA busy_timeout = 5000;");
  if (!readOnly)
    database.exec(
      "PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;",
    );
  const names = (statement: string) =>
    database
      .prepare(statement)
      .all()
      .map((row) => Value.Decode(NameRowSchema, row).name);
  return {
    exec: (statement) => {
      database.exec(statement);
    },
    tableNames: () => names("SELECT name FROM sqlite_master WHERE type='table'"),
    columnNames: (table) => names(`PRAGMA table_info(${table})`),
    readRow: (statement, ...parameters) => database.prepare(statement).get(...parameters),
    readRows: (statement, ...parameters) => database.prepare(statement).all(...parameters),
    write: (statement, ...parameters) =>
      Number(database.prepare(statement).run(...parameters).changes),
    close: () => {
      database.close();
    },
  };
}
