import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Data, Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { runNodePlatformPromise } from "../node-platform.js";

const ToolNameSchema = Type.String({ minLength: 1, pattern: "^\\S+$" });

const WorkerSettingsSchema = Type.Object(
  { disabledTools: Type.Optional(Type.Array(ToolNameSchema)) },
  { additionalProperties: true },
);

const WorkgraphSettingsDocumentSchema = Type.Object(
  { worker: Type.Optional(Type.Unknown()) },
  { additionalProperties: true },
);

const GlobalSettingsDocumentSchema = Type.Object(
  { "pi-workgraph": Type.Optional(Type.Unknown()) },
  { additionalProperties: true },
);

type GlobalSettingsDocument = Static<typeof GlobalSettingsDocumentSchema>;

type WorkgraphSettingsDocument = Static<typeof WorkgraphSettingsDocumentSchema>;

class WorkgraphSettingsError extends Data.TaggedError("WorkgraphSettingsError")<{
  readonly operation: "parse" | "decode";
  readonly path: string;
  readonly message: string;
}> {
  override readonly name = "Error";
}

function globalSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "settings.json");
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON.parse supplies the raw document immediately checked against the owned top-level schema.
function parseGlobalSettingsDocument(value: unknown, path: string): GlobalSettingsDocument {
  if (!Value.Check(GlobalSettingsDocumentSchema, value))
    throw new WorkgraphSettingsError({
      operation: "decode",
      path,
      message: `Invalid pi-workgraph settings in ${path}.`,
    });

  return Value.Decode(GlobalSettingsDocumentSchema, value);
}

function workgraphSettings(
  settings: GlobalSettingsDocument,
  path: string,
): WorkgraphSettingsDocument | undefined {
  const workgraph = settings["pi-workgraph"];

  if (workgraph === undefined) return undefined;

  if (!Value.Check(WorkgraphSettingsDocumentSchema, workgraph))
    throw new WorkgraphSettingsError({
      operation: "decode",
      path,
      message: `Invalid pi-workgraph.worker settings in ${path}.`,
    });

  return Value.Decode(WorkgraphSettingsDocumentSchema, workgraph);
}

function decodeWorker(value: GlobalSettingsDocument, path: string): readonly string[] {
  const worker = workgraphSettings(value, path)?.worker;

  if (worker === undefined) return [];

  if (!Value.Check(WorkerSettingsSchema, worker))
    throw new WorkgraphSettingsError({
      operation: "decode",
      path,
      message: `Invalid pi-workgraph.worker.disabledTools in ${path}; expected an array of non-whitespace tool names.`,
    });

  return unique(Value.Decode(WorkerSettingsSchema, worker).disabledTools ?? []);
}

function loadGlobalSettingsEffect<A>(
  decode: (value: GlobalSettingsDocument, path: string) => A,
  path = globalSettingsPath(),
): Effect.Effect<A, WorkgraphSettingsError | PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    const contents = yield* fileSystem
      .readFileString(path)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));

    if (contents === undefined) return decode({}, path);

    const parsed = yield* Effect.try({
      // oxlint-disable-next-line anti-slop/no-unknown-returns, effecttsgo/prefer-schema-over-json -- The result is decoded by the requested owned subsection immediately below.
      try: (): unknown => JSON.parse(contents),
      catch: () =>
        new WorkgraphSettingsError({
          operation: "parse",
          path,
          message: `Invalid JSON in ${path}.`,
        }),
    });

    return decode(parseGlobalSettingsDocument(parsed, path), path);
  });
}

function unique(names: readonly string[]): readonly string[] {
  return [...new Set(names)];
}

/** Promise facade for Pi's extension callback boundary. */
export function loadWorkerDisabledTools(path = globalSettingsPath()): Promise<readonly string[]> {
  return runNodePlatformPromise(loadGlobalSettingsEffect(decodeWorker, path));
}
