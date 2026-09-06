import { Data } from "effect";
import type { InspectRequest, InspectSection } from "./agent-facing.js";

export const inspectSections = [
  "overview",
  "context",
  "task",
  "assignment",
  "outcome",
  "evidence",
  "recovery",
  "report",
  "judgments",
] as const satisfies readonly InspectSection[];

const stateOptions = ["state", "run-id", "registry"] as const;
const inspectOptions = [
  ...stateOptions,
  "section",
  "task",
  "attempt",
  "result",
  "offset",
  "max-chars",
  "item-offset",
  "max-items",
] as const;
const forkOptions = ["parent-session-file", "target-cwd", "entry-id"] as const;

interface StateSelection {
  state: string | undefined;
  runId: string | undefined;
  registry: string | undefined;
}

export type CliRequest =
  | { command: "help" }
  | { command: "status"; selection: StateSelection }
  | { command: "inspect"; selection: StateSelection; inspection: InspectRequest }
  | {
      command: "fork";
      parentSessionFile: string | undefined;
      targetCwd: string | undefined;
      entryId: string | undefined;
    };

export class CliInputError extends Data.TaggedError("CliInputError")<{
  readonly message: string;
}> {}

export function parseCliRequest(argv: readonly string[]): CliRequest {
  const [command, ...args] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h")
    return { command: "help" };
  if (command === "status")
    return { command, selection: stateSelection(parseOptions(args, stateOptions)) };
  if (command === "inspect") {
    const options = parseOptions(args, inspectOptions);
    return {
      command,
      selection: stateSelection(options),
      inspection: inspectRequest(options),
    };
  }
  if (command === "fork") {
    const options = parseOptions(args, forkOptions);
    return {
      command,
      parentSessionFile: options.get("parent-session-file"),
      targetCwd: options.get("target-cwd"),
      entryId: options.get("entry-id"),
    };
  }
  throw new CliInputError({ message: `Unsupported command ${command}. ${usage()}` });
}

function stateSelection(options: ReadonlyMap<string, string>): StateSelection {
  return {
    state: options.get("state"),
    runId: options.get("run-id"),
    registry: options.get("registry"),
  };
}

function inspectRequest(options: ReadonlyMap<string, string>): InspectRequest {
  const task = options.get("task");
  const attempt = options.get("attempt");
  const result = options.get("result");
  const offset = options.get("offset");
  const maxChars = options.get("max-chars");
  const itemOffset = options.get("item-offset");
  const maxItems = options.get("max-items");
  const request: InspectRequest = {
    section: parseInspectSection(options.get("section") ?? "overview"),
  };
  if (task !== undefined) request.task = task;
  if (attempt !== undefined) request.attempt = attempt;
  if (result !== undefined) request.result = result;
  if (offset !== undefined) request.offset = parseInteger(offset, "offset");
  if (maxChars !== undefined) request.maxChars = parseInteger(maxChars, "max-chars");
  if (itemOffset !== undefined) request.itemOffset = parseInteger(itemOffset, "item-offset");
  if (maxItems !== undefined) request.maxItems = parseInteger(maxItems, "max-items");
  return request;
}

function parseInspectSection(value: string): InspectSection {
  if (isInspectSection(value)) return value;
  throw new CliInputError({ message: `Invalid inspection section ${value}.` });
}

function isInspectSection(value: string): value is InspectSection {
  return inspectSections.some((section) => section === value);
}

function parseInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw new CliInputError({ message: `Invalid non-negative integer for --${name}.` });
}

function parseOptions(
  args: readonly string[],
  supported: readonly string[],
): ReadonlyMap<string, string> {
  const options = new Map<string, string>();
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
      throw new CliInputError({ message: `Invalid option: ${token ?? "undefined"}` });
    options.set(key, value);
  }
  return options;
}

export function usage(): string {
  return [
    "pi-workgraph inspect --state PATH | --run-id ID [--registry PATH] [--section SECTION] [--task ID] [--attempt ID] [--result ID] [--offset N] [--max-chars N] [--item-offset N] [--max-items N]",
    "pi-workgraph status --state PATH | --run-id ID [--registry PATH]",
    "pi-workgraph fork --parent-session-file PATH --target-cwd PATH [--entry-id ID]",
    "Inspect is the bounded semantic view; status reads uninterpreted historical JSON without migration. Workstream mutation belongs to coordinator tools.",
  ].join("\n");
}
