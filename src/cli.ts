import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { GitRepository } from "./git.js";
import { HerdrCliRuntime } from "./herdr.js";
import { forkConversationSession } from "./pi-process.js";
import { defaultRegistryPath } from "./registry.js";

export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const [command, ...rest] = argv;
  if (!command || ["help", "--help", "-h"].includes(command))
    return { command: "help", result: usage() };
  const options = parseOptions(rest);
  if (command === "status") {
    let statePath = options.get("state");
    if (!statePath) {
      const id = options.get("run-id");
      if (!id) throw new Error("Provide --state PATH or --run-id ID.");
      const registry = new DatabaseSync(
        options.get("registry") ?? defaultRegistryPath(env.PI_CODING_AGENT_DIR),
        { readOnly: true },
      );
      try {
        const row = registry
          .prepare("SELECT state_path FROM runs WHERE run_id=?")
          .get(id);
        if (typeof row?.state_path !== "string")
          throw new Error(`Unknown Workgraph ${id}.`);
        statePath = row.state_path;
      } finally {
        registry.close();
      }
    }
    // Inspection deliberately does not interpret, migrate or mutate historical state.
    const state: unknown = JSON.parse(
      await readFile(resolve(statePath), "utf8"),
    );
    return { command, statePath, state };
  }
  if (command === "fork") {
    const parentSessionFile =
      options.get("parent-session-file") ?? env.PI_SESSION_FILE;
    if (!parentSessionFile)
      throw new Error(
        "Fork requires --parent-session-file or PI_SESSION_FILE.",
      );
    const targetCwd = resolve(options.get("target-cwd") ?? process.cwd());
    await GitRepository.inspect(targetCwd);
    const runtime = new HerdrCliRuntime(
      env.PI_WORKGRAPH_HERDR_BIN || "herdr",
      env,
    );
    if (!runtime.available)
      throw new Error("Herdr is unavailable. No hidden fallback was started.");
    const entryId = options.get("entry-id");
    const sessionFile = await forkConversationSession({
      parentSessionFile,
      targetCwd,
      ...(entryId ? { entryId } : {}),
    });
    const identity = await runtime.launchCoordinator({
      cwd: targetCwd,
      sessionFile,
    });
    return { command, sessionFile, identity };
  }
  throw new Error(`Unsupported command ${command}. ${usage()}`);
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
  ];
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.slice(2);
    const value = args[index + 1];
    if (
      !args[index]?.startsWith("--") ||
      !key ||
      !supported.includes(key) ||
      !value ||
      value.startsWith("--") ||
      options.has(key)
    )
      throw new Error(`Invalid option: ${args[index]}`);
    options.set(key, value);
  }
  return options;
}

function usage(): string {
  return [
    "pi-workgraph status --state PATH | --run-id ID [--registry PATH]",
    "pi-workgraph fork --parent-session-file PATH --target-cwd PATH [--entry-id ID]",
    "Status reads current or historical JSON without migration. Workstream mutation belongs to coordinator tools.",
  ].join("\n");
}

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
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
)
  void main();
