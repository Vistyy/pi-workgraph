import { randomUUID } from "node:crypto";
// SAFETY: Resolves the extension-owned preference file within Pi's configured agent directory.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Data, Effect, FileSystem, Path } from "effect";
import { runNodePlatformPromise } from "./node-platform.js";

class CalmPreferenceError extends Data.TaggedError("CalmPreferenceError")<{ message: string }> {}

export interface CalmPreferences {
  load(): Promise<boolean>;
  save(on: boolean): Promise<void>;
}

/** A separate scalar file avoids read/modify/write races with unrelated settings. */
export function calmPreferences(
  path = join(getAgentDir(), "workgraph", "calm-default"),
): CalmPreferences {
  return {
    load: () =>
      runNodePlatformPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const text = yield* fs
            .readFileString(path)
            .pipe(
              Effect.catchTag("PlatformError", (error) =>
                error.reason._tag === "NotFound" ? Effect.succeed("off") : Effect.fail(error),
              ),
            );
          if (text.trim() === "on") return true;
          if (text.trim() === "off") return false;
          return yield* new CalmPreferenceError({
            message: `Invalid Calm default in ${path}; expected on or off.`,
          });
        }),
      ),
    save: (on) =>
      runNodePlatformPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const paths = yield* Path.Path;
          yield* fs.makeDirectory(paths.dirname(path), { recursive: true });
          const temporary = `${path}.${randomUUID()}.tmp`;
          const write = Effect.gen(function* () {
            yield* fs.writeFileString(temporary, on ? "on\n" : "off\n", { mode: 0o600 });
            yield* fs.rename(temporary, path);
          });
          const result = yield* Effect.exit(write);
          yield* fs.remove(temporary, { force: true });
          yield* result;
        }),
      ),
  };
}
