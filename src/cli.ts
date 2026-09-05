import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { forkConversationSession } from "./pi-process.js";
import { GitRepository } from "./git.js";
import { WorkgraphRegistry } from "./registry.js";
import { WorkgraphEngine } from "./engine.js";
import { HerdrCliRuntime } from "./herdr.js";
import { WorkgraphSupervisor } from "./supervisor.js";
import type { RunLifecycle, WorkgraphRun } from "./types.js";

export interface CliOptions {
  registryPath?: string;
  runId?: string;
  statePath?: string;
  cwd?: string;
  sessionId?: string;
  sessionFile?: string;
  liveness?: "alive" | "dead" | "unknown";
  reason?: string;
  targetCwd?: string;
  parentSessionFile?: string;
  entryId?: string;
  workspaceId?: string;
}

export interface CliResult {
  command: string;
  run?: WorkgraphRun;
  identity?: unknown;
  sessionFile?: string;
  result?: unknown;
}

export async function runCli(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<CliResult> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") return { command: "help", result: usage() };
  const options = parseOptions(rest);
  switch (command) {
    case "status": return status(options);
    case "fork": return fork(options, env);
    case "adopt":
    case "suspend":
    case "resume":
    case "abandon":
    case "archive":
    case "recovery":
    case "cleanup": throw new CliError("unsupported", `${command} is retired for current Workstreams. Use the coordinator capability tools; status is read-only historical inspection.`);
    default: throw new CliError("usage", `Unknown Workgraph command: ${command}`);
  }
}

async function status(options: CliOptions): Promise<CliResult> {
  const registry = new WorkgraphRegistry(options.registryPath);
  try {
    const indexed = findIndexed(registry, options);
    const run = JSON.parse(await readFile(indexed.statePath, "utf8")) as WorkgraphRun;
    return { command: "status", run };
  } finally { registry.close(); }
}

async function adopt(options: CliOptions, env: NodeJS.ProcessEnv): Promise<CliResult> {
  const registry = new WorkgraphRegistry(options.registryPath);
  try {
    const indexed = findIndexed(registry, options);
    const cwd = resolve(options.cwd ?? env.PWD ?? process.cwd());
    const repository = await GitRepository.inspect(cwd);
    if (repository.root !== indexed.projectRoot) throw new CliError("project_mismatch", `Workgraph ${indexed.runId} belongs to ${indexed.projectRoot}, not ${repository.root}.`);
    const sessionId = options.sessionId ?? env.PI_SESSION_ID;
    const sessionFile = options.sessionFile ?? env.PI_SESSION_FILE;
    if (!sessionId || !sessionFile) throw new CliError("session_required", "Adoption requires PI_SESSION_ID and PI_SESSION_FILE, or --session-id and --session-file.");
    const engine = WorkgraphEngine.open(indexed.statePath, { registry });
    const runtime = new HerdrCliRuntime(env.PI_WORKGRAPH_HERDR_BIN || "herdr", env);
    let runtimeIdentity;
    if (runtime.available) {
      const paneId = env.HERDR_PANE_ID;
      if (!paneId) throw new CliError("pane_required", "Herdr adoption requires HERDR_PANE_ID for the current pane.");
      runtimeIdentity = await runtime.observeCurrentCoordinator({ paneId, sessionFile, cwd: repository.root });
    }
    const run = await engine.adopt(sessionId, sessionFile, options.liveness ?? "unknown", runtimeIdentity);
    return { command: "adopt", run, result: { forked: false, sessionFile: run.coordinator.sessionFile } };
  } finally { registry.close(); }
}

async function fork(options: CliOptions, env: NodeJS.ProcessEnv): Promise<CliResult> {
  const parentSessionFile = options.parentSessionFile ?? env.PI_SESSION_FILE;
  const targetCwd = resolve(options.targetCwd ?? options.cwd ?? process.cwd());
  if (!parentSessionFile) throw new CliError("session_required", "Fork requires PI_SESSION_FILE or --parent-session-file.");
  const repository = await GitRepository.inspect(targetCwd);
  const workspaceId = options.workspaceId ?? env.HERDR_WORKSPACE_ID;
  const runtimeEnv = workspaceId ? { ...env, HERDR_WORKSPACE_ID: workspaceId } : env;
  const runtime = new HerdrCliRuntime(env.PI_WORKGRAPH_HERDR_BIN || "herdr", runtimeEnv);
  if (!runtime.available || !workspaceId) throw new CliError("herdr_unavailable", "Herdr coordinator runtime is unavailable. No hidden fallback was started.");
  const childSession = await forkConversationSession({ parentSessionFile, targetCwd: repository.root, ...(options.entryId ? { entryId: options.entryId } : {}) });
  const identity = await runtime.launchCoordinator({ workspaceId, cwd: repository.root, sessionFile: childSession });
  return { command: "fork", sessionFile: childSession, identity, result: { cwd: repository.root } };
}

async function lifecycle(target: RunLifecycle, options: CliOptions, env: NodeJS.ProcessEnv): Promise<CliResult> {
  const registry = new WorkgraphRegistry(options.registryPath);
  try {
    const indexed = findIndexed(registry, options);
    const reason = options.reason;
    if (!reason?.trim()) throw new CliError("reason_required", `The ${target} command requires --reason.`);
    const engine = WorkgraphEngine.open(indexed.statePath, { registry });
    const run = await engine.setLifecycle(target, reason);
    return { command: target === "active" ? "resume" : target, run };
  } finally { registry.close(); }
}

async function recovery(options: CliOptions): Promise<CliResult> {
  const registry = new WorkgraphRegistry(options.registryPath);
  try {
    const indexed = findIndexed(registry, options);
    const engine = WorkgraphEngine.open(indexed.statePath, { registry });
    const run = await engine.reconcile();
    return { command: "recovery", run };
  } finally { registry.close(); }
}

async function cleanup(options: CliOptions, env: NodeJS.ProcessEnv): Promise<CliResult> {
  const registry = new WorkgraphRegistry(options.registryPath);
  try {
    const indexed = findIndexed(registry, options);
    const engine = WorkgraphEngine.open(indexed.statePath, { registry });
    const workspaceId = options.workspaceId ?? env.HERDR_WORKSPACE_ID;
    const runtimeEnv = workspaceId ? { ...env, HERDR_WORKSPACE_ID: workspaceId } : env;
    const runtime = new HerdrCliRuntime(env.PI_WORKGRAPH_HERDR_BIN || "herdr", runtimeEnv);
    const supervisor = new WorkgraphSupervisor(engine, runtime, workspaceId ? { workspaceId } : {});
    const run = await supervisor.cleanupNow();
    return { command: "cleanup", run, result: { cleanup: run.cleanup ?? [] } };
  } finally { registry.close(); }
}

function findIndexed(registry: WorkgraphRegistry, options: CliOptions) {
  if (options.statePath) {
    return { runId: options.runId ?? "state", statePath: resolve(options.statePath), projectRoot: options.cwd ? resolve(options.cwd) : process.cwd() };
  }
  if (!options.runId) throw new CliError("run_required", "Provide --run-id or --state.");
  const indexed = registry.findRun(options.runId);
  if (!indexed) throw new CliError("unknown_run", `Unknown Workgraph ${options.runId}.`);
  return indexed;
}

function parseOptions(args: readonly string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) throw new CliError("usage", `Unexpected argument: ${arg ?? ""}`);
    const key = arg.slice(2);
    if (["help"].includes(key)) continue;
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new CliError("usage", `Option --${key} requires a value.`);
    switch (key) {
      case "registry": options.registryPath = resolve(value); break;
      case "run-id": options.runId = value; break;
      case "state": options.statePath = resolve(value); break;
      case "cwd": options.cwd = value; break;
      case "session-id": options.sessionId = value; break;
      case "session-file": options.sessionFile = resolve(value); break;
      case "liveness": if (value !== "alive" && value !== "dead" && value !== "unknown") throw new CliError("usage", `Invalid liveness: ${value}`); options.liveness = value; break;
      case "reason": options.reason = value; break;
      case "target-cwd": options.targetCwd = value; break;
      case "parent-session-file": options.parentSessionFile = resolve(value); break;
      case "entry-id": options.entryId = value; break;
      case "workspace": options.workspaceId = value; break;
      default: throw new CliError("usage", `Unknown option: --${key}`);
    }
  }
  return options;
}

function usage(): string {
  return [
    "pi-workgraph <command> [options]",
    "commands: status, fork",
    "status reads retained historical runs; current Workstreams are controlled by coordinator capability tools.",
    "common options: --run-id ID --state PATH --registry PATH --reason TEXT",
    "fork options: --parent-session-file PATH --target-cwd PATH --entry-id ID --workspace ID",
  ].join("\n");
}

export class CliError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "CliError"; }
}

async function main(): Promise<void> {
  try {
    const result = await runCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    const normalized = error instanceof CliError ? error : new Error(error instanceof Error ? error.message : String(error));
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: error instanceof CliError ? error.code : "runtime_error", message: normalized.message } })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) void main();
