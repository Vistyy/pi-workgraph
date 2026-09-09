// oxlint-disable-next-line effecttsgo/node-builtin-import -- This is Pi's documented global settings location.
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Data, Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { runNodePlatformPromise } from "./node-platform.js";

const ToolNameSchema = Type.String({ minLength: 1, pattern: "^\\S+$" });
const CalmSettingsSchema = Type.Object(
  {
    additionalHiddenTools: Type.Optional(Type.Array(ToolNameSchema)),
  },
  { additionalProperties: true },
);
const WorkgraphSettingsSchema = Type.Object(
  {
    calm: Type.Optional(CalmSettingsSchema),
  },
  { additionalProperties: true },
);
const GlobalSettingsSchema = Type.Object(
  {
    "pi-workgraph": Type.Optional(WorkgraphSettingsSchema),
  },
  { additionalProperties: true },
);
type GlobalSettings = Static<typeof GlobalSettingsSchema>;

class CalmSettingsError extends Data.TaggedError("CalmSettingsError")<{
  readonly operation: "parse" | "decode";
  readonly path: string;
  readonly message: string;
}> {
  override readonly name = "Error";
}

function globalSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "settings.json");
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON.parse is the external settings boundary; this decoder immediately establishes the owned nested shape.
function decodeGlobalSettings(value: unknown, path: string): GlobalSettings {
  if (!Value.Check(GlobalSettingsSchema, value))
    throw new CalmSettingsError({
      operation: "decode",
      path,
      message: `Invalid pi-workgraph.calm.additionalHiddenTools in ${path}; expected an array of non-whitespace tool names.`,
    });
  return Value.Decode(GlobalSettingsSchema, value);
}

function loadCalmAdditionalHiddenToolsEffect(
  path = globalSettingsPath(),
): Effect.Effect<readonly string[], CalmSettingsError | PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const contents = yield* fileSystem.readFileString(path).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.void,
      ),
    );
    if (contents === undefined) return [];
    const parsed = yield* Effect.try({
      // oxlint-disable-next-line anti-slop/no-unknown-returns, effecttsgo/prefer-schema-over-json -- The result is validated immediately below.
      try: (): unknown => JSON.parse(contents),
      catch: () =>
        new CalmSettingsError({
          operation: "parse",
          path,
          message: `Invalid JSON in ${path}.`,
        }),
    });
    const settings = decodeGlobalSettings(parsed, path);
    return [...new Set(settings["pi-workgraph"]?.calm?.additionalHiddenTools ?? [])];
  });
}

/** Promise facade for Pi's extension callback boundary. */
export function loadCalmAdditionalHiddenTools(
  path = globalSettingsPath(),
): Promise<readonly string[]> {
  return runNodePlatformPromise(loadCalmAdditionalHiddenToolsEffect(path));
}
