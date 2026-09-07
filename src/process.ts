import { createHash, type Hash } from "node:crypto";
import { Data, Effect, Fiber, Scope, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { liveLayer } from "./node-platform.js";

const OUTPUT_LIMIT = 50 * 1024;
const DEFAULT_KILL_GRACE_MS = 5_000;

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stdoutTruncated: boolean;
  stdoutDigest?: string;
  stderr: string;
  stderrTruncated: boolean;
  timedOut: boolean;
}

export interface ProcessOptions {
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly digestStdout?: boolean;
  /** External JSON protocols can opt out; Git diagnostics use the 50 KiB default. */
  readonly outputLimit?: number | false;
  /** Only shortened in tests; production retains the five-second escalation window. */
  readonly killGraceMs?: number;
}

export class ProcessExecutionError extends Data.TaggedError("ProcessExecutionError")<{
  readonly command: string;
  readonly args: readonly string[];
  readonly cause: unknown;
}> {}

interface OutputCapture {
  readonly limit: number | undefined;
  readonly digest: Hash | undefined;
  readonly chunks: Buffer[];
  totalBytes: number;
  retainedBytes: number;
}

interface CapturedText {
  readonly text: string;
  readonly truncated: boolean;
}

/** Runs a bounded child with the platform's scoped process owner and this module's diagnostic policy. */
export function processEffect(
  command: string,
  args: readonly string[],
  options: ProcessOptions,
): Effect.Effect<ProcessResult, ProcessExecutionError> {
  const outputLimit = resolveOutputLimit(options.outputLimit);
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const processError = (cause: unknown): ProcessExecutionError =>
    new ProcessExecutionError({ command, args, cause });

  const operation = Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const parentScope = yield* Effect.scope;
      // The process scope is registered after the stdio scope so its platform finalizer
      // terminates the child before the stdio finalizer waits for both pipes to close.
      const stdioScope = yield* Scope.fork(parentScope, "sequential");
      const processScope = yield* Scope.fork(parentScope, "sequential");
      const handle = yield* Scope.provide(processScope)(
        spawner
          .spawn(
            ChildProcess.make(command, [...args], {
              cwd: options.cwd,
              env: options.env,
              extendEnv: false,
              shell: false,
              detached: false,
              windowsHide: false,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              killSignal: "SIGTERM",
              forceKillAfter: killGraceMs,
            }),
          )
          .pipe(Effect.mapError(processError)),
      );

      const stdoutCapture = makeCapture(outputLimit, options.digestStdout === true);
      const stderrCapture = makeCapture(outputLimit, false);
      const stdoutFiber = yield* Scope.provide(stdioScope)(
        Effect.forkScoped(
          Stream.runFold(
            handle.stdout,
            () => stdoutCapture,
            (capture, chunk) => {
              appendCapture(capture, chunk);
              return capture;
            },
          ),
        ),
      );
      const stderrFiber = yield* Scope.provide(stdioScope)(
        Effect.forkScoped(
          Stream.runFold(
            handle.stderr,
            () => stderrCapture,
            (capture, chunk) => {
              appendCapture(capture, chunk);
              return capture;
            },
          ),
        ),
      );
      // forkScoped's normal interruption finalizers must run after this join. The
      // process scope closes first, so this preserves the native close fence even
      // when a descendant still owns one of the inherited stdio pipes.
      yield* Scope.addFinalizer(
        stdioScope,
        Effect.uninterruptible(
          Effect.all([Fiber.join(stdoutFiber), Fiber.join(stderrFiber)], {
            concurrency: "unbounded",
          }).pipe(Effect.ignore),
        ),
      );

      // The platform handle reports signal exits as failures. The native API exposed
      // those as a successful result with code 1, so normalize before the completion
      // race while still waiting for both output streams.
      const completion = Effect.all(
        [
          handle.exitCode.pipe(Effect.orElseSucceed(() => 1)),
          Fiber.join(stdoutFiber).pipe(Effect.mapError(processError)),
          Fiber.join(stderrFiber).pipe(Effect.mapError(processError)),
        ],
        { concurrency: "unbounded" },
      );
      const raced = yield* Effect.race(
        completion.pipe(Effect.map((result) => ({ timedOut: false as const, result }))),
        Effect.sleep(options.timeoutMs).pipe(Effect.as({ timedOut: true as const })),
      );
      const timedOut = raced.timedOut;
      let completionResult: readonly [number, OutputCapture, OutputCapture];
      if (timedOut) {
        yield* Effect.uninterruptible(
          handle.kill({ killSignal: "SIGTERM", forceKillAfter: killGraceMs }).pipe(Effect.ignore),
        );
        completionResult = yield* completion;
      } else {
        completionResult = raced.result;
      }
      const [exitCode, stdout, stderr] = completionResult;
      const capturedStdout = captureText(stdout);
      const capturedStderr = captureText(stderr);
      const result: ProcessResult = {
        exitCode: Number(exitCode),
        stdout: capturedStdout.text,
        stdoutTruncated: capturedStdout.truncated,
        stderr: capturedStderr.text,
        stderrTruncated: capturedStderr.truncated,
        timedOut,
      };
      if (stdout.digest !== undefined) {
        result.stdoutDigest = stdout.digest.digest("hex");
      }
      return result;
    }),
  );

  return Effect.provide(operation, liveLayer);
}

function resolveOutputLimit(outputLimit: number | false | undefined): number | undefined {
  if (outputLimit === false) return undefined;
  const limit = outputLimit ?? OUTPUT_LIMIT;
  return Number.isNaN(limit) ? 0 : Math.max(0, Math.trunc(limit));
}

function makeCapture(limit: number | undefined, digest: boolean): OutputCapture {
  return {
    limit,
    digest: digest ? createHash("sha256") : undefined,
    chunks: [],
    totalBytes: 0,
    retainedBytes: 0,
  };
}

function appendCapture(capture: OutputCapture, chunk: Uint8Array): void {
  const bytes = Buffer.from(chunk);
  capture.totalBytes += bytes.length;
  capture.digest?.update(bytes);
  if (capture.limit === 0) return;

  capture.chunks.push(bytes);
  capture.retainedBytes += bytes.length;
  if (capture.limit === undefined) return;

  let overflow = capture.retainedBytes - capture.limit;
  while (overflow > 0) {
    const first = capture.chunks[0];
    if (first === undefined) break;
    if (first.length <= overflow) {
      capture.chunks.shift();
      capture.retainedBytes -= first.length;
      overflow -= first.length;
    } else {
      capture.chunks[0] = Buffer.from(first.subarray(overflow));
      capture.retainedBytes -= overflow;
      overflow = 0;
    }
  }
}

function captureText(capture: OutputCapture): CapturedText {
  const bytes = Buffer.concat(capture.chunks, capture.retainedBytes);
  if (capture.limit === undefined) {
    return { text: bytes.toString("utf8").trim(), truncated: false };
  }

  const validSuffix = validUtf8Suffix(bytes);
  const decoded = boundUtf8Text(validSuffix.toString("utf8"), capture.limit);
  return {
    text: decoded.text.trim(),
    truncated:
      capture.totalBytes > bytes.length || validSuffix.length < bytes.length || decoded.truncated,
  };
}

function validUtf8Suffix(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length) {
    const byte = bytes[start];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    start += 1;
  }
  return bytes.subarray(start);
}

function boundUtf8Text(text: string, limit: number): CapturedText {
  let start = 0;
  let byteLength = Buffer.byteLength(text);
  while (byteLength > limit && start < text.length) {
    const codePoint = text.codePointAt(start);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    byteLength -= Buffer.byteLength(character);
    start += character.length;
  }
  return { text: text.slice(start), truncated: start > 0 };
}
