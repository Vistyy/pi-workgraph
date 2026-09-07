// oxlint-disable-next-line effecttsgo/node-builtin-import -- Entrypoint detection is the executable host boundary.
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Config, ConfigProvider, Data, Effect, type FileSystem, Option, Path } from "effect";
import type { ConfigError } from "effect/Config";
import type { PlatformError } from "effect/PlatformError";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { type InspectView, inspectView } from "./agent-facing.js";
import { CliInputError, type CliRequest, parseCliRequest, usage } from "./cli-parse.js";
import { type GitFailure, inspectRepository } from "./git.js";
import {
  type CoordinatorLaunchError,
  HerdrCliRuntime,
  type HerdrEffects,
  type HerdrProtocolError,
} from "./herdr.js";
import { liveLayer } from "./node-platform.js";
import { forkConversationSessionEffect, type PiSessionError } from "./pi-process.js";
import { defaultRegistryPath } from "./registry.js";
import type { WorkerIdentity } from "./types.js";
import { WorkstreamStoreEffects, type WorkstreamStoreError } from "./workstream.js";

const StatePathRowSchema = Type.Object({ state_path: Type.String() });
const CliEnvironmentConfig = Config.all({
  sessionFile: Config.string("PI_SESSION_FILE").pipe(Config.option),
  herdrBin: Config.string("PI_WORKGRAPH_HERDR_BIN").pipe(Config.withDefault("herdr")),
  agentDir: Config.string("PI_CODING_AGENT_DIR").pipe(Config.option),
});

interface CliEnvironment {
  readonly sessionFile: Option.Option<string>;
  readonly herdrBin: string;
  readonly agentDir: Option.Option<string>;
}

type StateRequest = Extract<CliRequest, { command: "status" | "inspect" }>;
type ForkRequest = Parameters<typeof forkConversationSessionEffect>[0];
type CliFailure =
  | ConfigError
  | CliInputError
  | CliOperationError
  | PlatformError
  | WorkstreamStoreError
  | GitFailure
  | PiSessionError
  | CoordinatorLaunchError
  | HerdrProtocolError;
type CliEffect<A> = Effect.Effect<A, CliFailure, FileSystem.FileSystem | Path.Path>;

export type CliResult =
  | { command: "help"; result: string }
  | { command: "status"; statePath: string; state: unknown }
  | { command: "inspect"; statePath: string; view: InspectView }
  | { command: "fork"; sessionFile: string; identity: WorkerIdentity };

export interface NativeHerdr {
  readonly available: boolean;
  readonly effects: Pick<HerdrEffects, "launchCoordinator">;
}

export type NativeHerdrFactory = (command: string, env: NodeJS.ProcessEnv) => NativeHerdr;

export class CliOperationError extends Data.TaggedError("CliOperationError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const makeNativeHerdr: NativeHerdrFactory = (command, env) => new HerdrCliRuntime(command, env);

/** The single Effect-to-Promise boundary for programmatic and executable CLI hosts. */
export function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  nativeHerdr: NativeHerdrFactory = makeNativeHerdr,
): Promise<CliResult> {
  return Effect.runPromise(cliEffect(argv, env, nativeHerdr).pipe(Effect.provide(liveLayer)));
}

function cliEffect(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  nativeHerdr: NativeHerdrFactory,
): Effect.Effect<CliResult, CliFailure, FileSystem.FileSystem | Path.Path> {
  return parseEffect(argv).pipe(
    Effect.flatMap((request) => {
      if (request.command === "help") return Effect.succeed({ command: "help", result: usage() });
      return CliEnvironmentConfig.parse(ConfigProvider.fromEnvRecord(env)).pipe(
        Effect.flatMap((environment) => commandEffect(request, environment, env, nativeHerdr)),
      );
    }),
  );
}

function commandEffect(
  request: Exclude<CliRequest, { command: "help" }>,
  environment: CliEnvironment,
  env: NodeJS.ProcessEnv,
  nativeHerdr: NativeHerdrFactory,
): CliEffect<CliResult> {
  if (request.command === "status") return statusEffect(request, environment);
  if (request.command === "inspect") return inspectEffect(request, environment);
  return forkEffect(request, environment, env, nativeHerdr);
}

function statusEffect(
  request: Extract<CliRequest, { command: "status" }>,
  environment: CliEnvironment,
): CliEffect<Extract<CliResult, { command: "status" }>> {
  return Effect.gen(function* () {
    const paths = yield* Path.Path;
    const statePath = yield* resolveStatePath(request, environment);
    const text = yield* WorkstreamStoreEffects.readRaw(paths.resolve(statePath));
    // Status deliberately preserves uninterpreted historical JSON without migration.
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- This command intentionally returns historical JSON without schema interpretation or migration.
    const state = yield* operationEffect((): unknown => JSON.parse(text));
    return { command: request.command, statePath, state };
  });
}

function inspectEffect(
  request: Extract<CliRequest, { command: "inspect" }>,
  environment: CliEnvironment,
): CliEffect<Extract<CliResult, { command: "inspect" }>> {
  return Effect.gen(function* () {
    const paths = yield* Path.Path;
    const statePath = yield* resolveStatePath(request, environment);
    const state = yield* WorkstreamStoreEffects.inspect(paths.resolve(statePath));
    const view = yield* operationEffect(() => inspectView(state, request.inspection));
    return { command: request.command, statePath, view };
  });
}

function forkEffect(
  request: Extract<CliRequest, { command: "fork" }>,
  environment: CliEnvironment,
  env: NodeJS.ProcessEnv,
  makeHerdr: NativeHerdrFactory,
): CliEffect<Extract<CliResult, { command: "fork" }>> {
  return Effect.gen(function* () {
    const paths = yield* Path.Path;
    const parentSessionFile =
      request.parentSessionFile ?? Option.getOrUndefined(environment.sessionFile);
    if (parentSessionFile === undefined || parentSessionFile.length === 0)
      return yield* new CliInputError({
        message: "Fork requires --parent-session-file or PI_SESSION_FILE.",
      });
    const targetCwd = paths.resolve(request.targetCwd ?? process.cwd());
    yield* inspectRepository(targetCwd);
    const herdr = makeHerdr(environment.herdrBin, env);
    if (!herdr.available)
      return yield* new CliInputError({
        message: "Herdr is unavailable. No hidden fallback was started.",
      });
    const forkRequest: ForkRequest = { parentSessionFile, targetCwd };
    if (request.entryId !== undefined) forkRequest.entryId = request.entryId;
    const sessionFile = yield* forkConversationSessionEffect(forkRequest);
    const identity: WorkerIdentity = yield* herdr.effects.launchCoordinator({
      cwd: targetCwd,
      sessionFile,
    });
    return { command: request.command, sessionFile, identity };
  });
}

function resolveStatePath(
  request: StateRequest,
  environment: CliEnvironment,
): Effect.Effect<string, CliInputError | CliOperationError> {
  const { state, runId, registry } = request.selection;
  if (state !== undefined && state.length > 0) return Effect.succeed(state);
  if (runId === undefined || runId.length === 0)
    return Effect.fail(new CliInputError({ message: "Provide --state PATH or --run-id ID." }));
  return lookupStatePath(
    registry ?? defaultRegistryPath(Option.getOrUndefined(environment.agentDir)),
    runId,
  );
}

function lookupStatePath(
  registryPath: string,
  runId: string,
): Effect.Effect<string, CliInputError | CliOperationError> {
  return operationEffect(() => {
    const registry = new DatabaseSync(registryPath, { readOnly: true });
    try {
      try {
        const current = registry
          .prepare("SELECT state_path FROM workgraph_locators WHERE run_id=?")
          .get(runId);
        if (current !== undefined) return current;
      } catch (cause) {
        if (!(cause instanceof Error) || !cause.message.includes("no such table")) throw cause;
      }
      return registry.prepare("SELECT state_path FROM runs WHERE run_id=?").get(runId);
    } finally {
      registry.close();
    }
  }).pipe(
    Effect.flatMap((row) =>
      Value.Check(StatePathRowSchema, row)
        ? Effect.succeed(Value.Decode(StatePathRowSchema, row).state_path)
        : Effect.fail(new CliInputError({ message: `Unknown Workgraph ${runId}.` })),
    ),
  );
}

function parseEffect(argv: readonly string[]): Effect.Effect<CliRequest, CliInputError> {
  return Effect.try({
    try: () => parseCliRequest(argv),
    catch: (cause) =>
      cause instanceof CliInputError ? cause : new CliInputError({ message: errorMessage(cause) }),
  });
}

function operationEffect<A>(run: () => A): Effect.Effect<A, CliOperationError> {
  return Effect.try({
    try: run,
    catch: (cause) => new CliOperationError({ message: errorMessage(cause), cause }),
  });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function main(): void {
  void runCli(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`),
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejection is parsed into the stable JSON error message at this executable host boundary.
    (error: unknown) => {
      process.stderr.write(`${JSON.stringify({ ok: false, error: errorMessage(error) })}\n`);
      process.exitCode = 1;
    },
  );
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && resolve(entrypoint) === resolve(fileURLToPath(import.meta.url)))
  main();
