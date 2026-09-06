import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Config, ConfigProvider, Effect, Option } from "effect";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { type InspectRequest, type InspectSection, inspectView } from "./agent-facing.js";
import { GitRepository } from "./git.js";
import { HerdrCliRuntime } from "./herdr.js";
import { forkConversationSession } from "./pi-process.js";
import { defaultRegistryPath } from "./registry.js";
import { WorkstreamStore } from "./workstream.js";

const StatePathRowSchema = Type.Object({ state_path: Type.String() });
const CliEnvironmentConfig = Config.all({
  sessionFile: Config.string("PI_SESSION_FILE").pipe(Config.option),
  herdrBin: Config.string("PI_WORKGRAPH_HERDR_BIN").pipe(Config.withDefault("herdr")),
  agentDir: Config.string("PI_CODING_AGENT_DIR").pipe(Config.option),
});

// oxlint-disable-next-line effecttsgo/async-function -- Public CLI callers require Promise interoperability.
export async function runCli(argv: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const [command, ...rest] = argv;
  if (command === undefined || ["help", "--help", "-h"].includes(command))
    return { command: "help", result: usage() };
  const options = parseOptions(rest);
  const environment = Effect.runSync(CliEnvironmentConfig.parse(ConfigProvider.fromEnvRecord(env)));
  if (command === "status") {
    const statePath = await resolveStatePath(options, Option.getOrUndefined(environment.agentDir));
    // Status deliberately preserves uninterpreted historical JSON.
    // SAFETY: status intentionally preserves arbitrary historical JSON without migration.
    const state: unknown = JSON.parse(await readUtf8(resolve(statePath)));
    return { command, statePath, state };
  }
  if (command === "inspect") {
    const statePath = await resolveStatePath(options, Option.getOrUndefined(environment.agentDir));
    const state = await WorkstreamStore.inspect(resolve(statePath));
    const section = options.get("section") ?? "overview";
    if (!["overview", "task", "outcome", "evidence", "recovery", "report"].includes(section))
      throw new Error(`Invalid inspection section ${section}.`);
    const task = options.get("task");
    const attempt = options.get("attempt");
    const result = options.get("result");
    const offset = options.get("offset");
    const maxChars = options.get("max-chars");
    const itemOffset = options.get("item-offset");
    const maxItems = options.get("max-items");
    // SAFETY: the preceding allow-list establishes section as an InspectSection.
    const request: InspectRequest = { section: section as InspectSection };
    if (task !== undefined) request.task = task;
    if (attempt !== undefined) request.attempt = attempt;
    if (result !== undefined) request.result = result;
    if (offset !== undefined) request.offset = parseInteger(offset, "offset");
    if (maxChars !== undefined) request.maxChars = parseInteger(maxChars, "max-chars");
    if (itemOffset !== undefined) request.itemOffset = parseInteger(itemOffset, "item-offset");
    if (maxItems !== undefined) request.maxItems = parseInteger(maxItems, "max-items");
    const view = inspectView(state, request);
    return { command, statePath, view };
  }
  if (command === "fork") {
    const parentSessionFile =
      options.get("parent-session-file") ?? Option.getOrUndefined(environment.sessionFile);
    if (parentSessionFile === undefined || parentSessionFile.length === 0)
      throw new Error("Fork requires --parent-session-file or PI_SESSION_FILE.");
    const targetCwd = resolve(options.get("target-cwd") ?? process.cwd());
    await GitRepository.inspect(targetCwd);
    const runtime = new HerdrCliRuntime(environment.herdrBin, env);
    if (!runtime.available)
      throw new Error("Herdr is unavailable. No hidden fallback was started.");
    const entryId = options.get("entry-id");
    const forkOptions: Parameters<typeof forkConversationSession>[0] = {
      parentSessionFile,
      targetCwd,
    };
    if (entryId !== undefined) forkOptions.entryId = entryId;
    const sessionFile = await forkConversationSession(forkOptions);
    const identity = await runtime.launchCoordinator({
      cwd: targetCwd,
      sessionFile,
    });
    return { command, sessionFile, identity };
  }
  throw new Error(`Unsupported command ${command}. ${usage()}`);
}

// oxlint-disable-next-line effecttsgo/async-function -- Registry lookup is a Promise-based host boundary.
async function resolveStatePath(
  options: Map<string, string>,
  agentDir: string | undefined,
): Promise<string> {
  const statePath = options.get("state");
  if (statePath !== undefined && statePath.length > 0) return statePath;
  const id = options.get("run-id");
  if (id === undefined || id.length === 0) throw new Error("Provide --state PATH or --run-id ID.");
  const registry = new DatabaseSync(options.get("registry") ?? defaultRegistryPath(agentDir), {
    readOnly: true,
  });
  try {
    const row: unknown = registry.prepare("SELECT state_path FROM runs WHERE run_id=?").get(id);
    if (!Value.Check(StatePathRowSchema, row)) throw new Error(`Unknown Workgraph ${id}.`);
    return Value.Decode(StatePathRowSchema, row).state_path;
  } finally {
    registry.close();
  }
}

function parseInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`Invalid non-negative integer for --${name}.`);
  return parsed;
}

function parseOptions(args: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();
  const supported = [
    "state",
    "run-id",
    "registry",
    "parent-session-file",
    "target-cwd",
    "entry-id",
    "section",
    "task",
    "attempt",
    "result",
    "offset",
    "max-chars",
    "item-offset",
    "max-items",
  ];
  for (let index = 0; index < args.length; index += 2) {
    const token = args[index];
    const key = token?.slice(2);
    const value = args[index + 1];
    if (
      token === undefined ||
      !token.startsWith("--") ||
      key === undefined ||
      key.length === 0 ||
      !supported.includes(key) ||
      value === undefined ||
      value.length === 0 ||
      value.startsWith("--") ||
      options.has(key)
    )
      throw new Error(`Invalid option: ${token ?? "undefined"}`);
    options.set(key, value);
  }
  return options;
}

function readUtf8(path: string): Promise<string> {
  return Effect.runPromise(Effect.promise(() => readFile(path, "utf8")));
}

function usage(): string {
  return [
    "pi-workgraph inspect --state PATH | --run-id ID [--registry PATH] [--section SECTION] [--task ID] [--attempt ID] [--result ID] [--offset N] [--max-chars N] [--item-offset N] [--max-items N]",
    "pi-workgraph status --state PATH | --run-id ID [--registry PATH]",
    "pi-workgraph fork --parent-session-file PATH --target-cwd PATH [--entry-id ID]",
    "Inspect is the bounded semantic view; status reads uninterpreted historical JSON without migration. Workstream mutation belongs to coordinator tools.",
  ].join("\n");
}

// oxlint-disable-next-line effecttsgo/async-function -- Node's executable boundary must await the public Promise API.
async function main(): Promise<void> {
  try {
    process.stdout.write(
      `${JSON.stringify({ ok: true, ...(await runCli(process.argv.slice(2))) })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exitCode = 1;
  }
}
const entrypoint = process.argv[1];
if (entrypoint !== undefined && resolve(entrypoint) === resolve(fileURLToPath(import.meta.url)))
  void main();
