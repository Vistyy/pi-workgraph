import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import { Data, Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { decodeErrorResponse } from "./herdr-decoder.js";
import { liveLayer } from "./node-platform.js";

const childProcessLayer = NodeChildProcessSpawner.layer.pipe(Layer.provide(liveLayer));

export interface HerdrCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class HerdrProtocolError extends Data.TaggedError("HerdrProtocolError")<{
  readonly operation: string;
  readonly reason: "process" | "command" | "malformed" | "identity" | "unavailable";
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.detail;
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Each supplied decoder validates this raw Herdr protocol value.
export type HerdrResponseDecoder<Decoded> = (value: unknown) => Decoded;

class InvalidInspection extends Data.TaggedClass("InvalidInspection")<{
  readonly message: string;
}> {}

export type InspectionDecode<Decoded> =
  | { readonly _tag: "DecodedInspection"; readonly value: Decoded }
  | InvalidInspection;

/** Owns Herdr command execution and protocol-envelope decoding. */
export class HerdrCommandTransport {
  constructor(private readonly command: string) {}

  call<Decoded>(
    args: string[],
    decode: HerdrResponseDecoder<Decoded>,
    timeoutMs = 30_000,
  ): Effect.Effect<Decoded, HerdrProtocolError> {
    return this.spawn(args, timeoutMs).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? protocolDecode(result, args, decode)
          : Effect.fail(protocolCommandError(args, result)),
      ),
    );
  }

  spawn(args: string[], timeoutMs: number): Effect.Effect<HerdrCommandResult, HerdrProtocolError> {
    const command = ChildProcess.make(this.command, args, {
      cwd: process.cwd(),
      stdin: "ignore",
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(command);
        const result = yield* Effect.all(
          {
            code: child.exitCode,
            stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
          },
          { concurrency: "unbounded" },
        );
        return {
          code: Number(result.code),
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        };
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new HerdrProtocolError({
            operation: operationName(args),
            reason: "process",
            detail: `Herdr process failed for ${operationName(args)}.`,
            cause,
          }),
      ),
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(
            new HerdrProtocolError({
              operation: operationName(args),
              reason: "command",
              detail: `herdr ${operationName(args)} failed: command timed out after ${timeoutMs}ms.`,
            }),
          ),
      }),
      Effect.provide(childProcessLayer),
    );
  }
}

function operationName(args: readonly string[]): string {
  return args.slice(0, 2).join(" ") || "availability";
}

export function protocolFailure(
  args: readonly string[],
  reason: HerdrProtocolError["reason"],
  detail: string,
  cause?: unknown,
): Effect.Effect<never, HerdrProtocolError> {
  return Effect.fail(protocolError(args, reason, detail, cause));
}

export function protocolError(
  args: readonly string[],
  reason: HerdrProtocolError["reason"],
  detail: string,
  cause?: unknown,
): HerdrProtocolError {
  return new HerdrProtocolError({ operation: operationName(args), reason, detail, cause });
}

export function protocolTry<A>(
  args: readonly string[],
  evaluate: () => A,
): Effect.Effect<A, HerdrProtocolError> {
  return Effect.try({
    try: evaluate,
    catch: (cause) =>
      new HerdrProtocolError({
        operation: operationName(args),
        reason: "identity",
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
}

export function protocolDecode<Decoded>(
  result: HerdrCommandResult,
  args: string[],
  decode: HerdrResponseDecoder<Decoded>,
): Effect.Effect<Decoded, HerdrProtocolError> {
  return Effect.try({
    try: () => decodeCommandResponse(result, args, decode),
    catch: (cause) =>
      cause instanceof HerdrProtocolError
        ? cause
        : new HerdrProtocolError({
            operation: operationName(args),
            reason: "malformed",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
  });
}

export function decodeInspection<Decoded>(
  result: HerdrCommandResult,
  args: string[],
  decode: HerdrResponseDecoder<Decoded>,
): Effect.Effect<InspectionDecode<Decoded>> {
  return Effect.sync(() => {
    try {
      return {
        _tag: "DecodedInspection" as const,
        value: decodeCommandResponse(result, args, decode),
      };
    } catch (cause) {
      return new InvalidInspection({
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  });
}

function decodeCommandResponse<Decoded>(
  result: HerdrCommandResult,
  args: string[],
  decode: HerdrResponseDecoder<Decoded>,
): Decoded {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (cause) {
    throw new HerdrProtocolError({
      operation: operationName(args),
      reason: "malformed",
      detail: `Herdr returned invalid JSON for ${operationName(args)}.`,
      cause,
    });
  }
  return decode(parsed);
}

export function isNotFound(
  result: HerdrCommandResult,
  expectedCode: "agent_not_found" | "pane_not_found" | "tab_not_found",
): boolean {
  for (const candidate of [result.stderr, result.stdout]) {
    try {
      const error = decodeErrorResponse(JSON.parse(candidate));
      if (error?.code === expectedCode) return true;
    } catch {}
  }
  return false;
}

export function protocolCommandError(
  args: string[],
  result: HerdrCommandResult,
): HerdrProtocolError {
  let message = result.stderr || result.stdout || `Herdr exited ${result.code}.`;
  for (const candidate of [result.stderr, result.stdout]) {
    try {
      const error = decodeErrorResponse(JSON.parse(candidate));
      if (error === undefined) continue;
      const details = [error.code, error.message].filter(
        (part) => part !== undefined && part !== "",
      );
      if (details.length > 0) message = details.join(": ");
      break;
    } catch {}
  }
  return new HerdrProtocolError({
    operation: operationName(args),
    reason: "command",
    detail: `herdr ${operationName(args)} failed: ${message}`,
  });
}
