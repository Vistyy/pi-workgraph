// oxlint-disable-next-line effecttsgo/node-builtin-import -- This module is the Node child-process adapter.
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { Data, Deferred, Effect } from "effect";

const OUTPUT_LIMIT = 50 * 1024;
const DEFAULT_KILL_GRACE_MS = 5_000;

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stdoutTruncated: boolean;
  stdoutDigest?: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcessOptions {
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
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

interface ProcessClose {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error: Error | undefined;
}

interface OwnedProcess {
  readonly child: ChildProcess;
  readonly completion: Deferred.Deferred<ProcessClose>;
  readonly stdout: OutputCapture;
  readonly stderr: OutputCapture;
  readonly onStdout: (chunk: Buffer) => void;
  readonly onStderr: (chunk: Buffer) => void;
  readonly onError: (error: Error) => void;
  readonly onExit: () => void;
  readonly onClose: (code: number | null, signal: NodeJS.Signals | null) => void;
  closed: boolean;
  exited: boolean;
  spawnError: Error | undefined;
}

/** Effect-native process boundary; callers may use the Promise adapter below during migration. */
export function processEffect(
  command: string,
  args: readonly string[],
  options: Omit<ProcessOptions, "signal">,
): Effect.Effect<ProcessResult, ProcessExecutionError> {
  const outputLimit = resolveOutputLimit(options.outputLimit);
  const processError = (cause: unknown): ProcessExecutionError =>
    new ProcessExecutionError({ command, args, cause });

  return Effect.scoped(
    Effect.gen(function* () {
      const completion = yield* Deferred.make<ProcessClose>();
      const owned = yield* Effect.acquireRelease(
        Effect.try({
          try: () => acquireProcess(command, args, options, outputLimit, completion),
          catch: processError,
        }),
        (process) => releaseProcess(process, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS),
      );

      const timedOut = yield* Effect.race(
        Deferred.await(owned.completion).pipe(Effect.as(false)),
        Effect.sleep(options.timeoutMs).pipe(Effect.as(true)),
      );
      if (timedOut) {
        yield* terminateAndAwait(owned, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
      }

      const close = yield* Deferred.await(owned.completion);
      if (close.error !== undefined) {
        return yield* processError(close.error);
      }

      const result: ProcessResult = {
        exitCode: close.code ?? 1,
        stdout: captureText(owned.stdout),
        stdoutTruncated:
          owned.stdout.limit !== undefined && owned.stdout.totalBytes > owned.stdout.limit,
        stderr: captureText(owned.stderr),
        timedOut,
      };
      if (owned.stdout.digest !== undefined) {
        result.stdoutDigest = owned.stdout.digest.digest("hex");
      }
      return result;
    }),
  );
}

/** Temporary outward adapter for Git and Herdr callers that still expose Promises. */
export function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  if (options.signal?.aborted === true) {
    return Effect.runPromise(Effect.interrupt);
  }
  return Effect.runPromise(processEffect(command, args, options), {
    signal: options.signal,
  });
}

function acquireProcess(
  command: string,
  args: readonly string[],
  options: Omit<ProcessOptions, "signal">,
  outputLimit: number | undefined,
  completion: Deferred.Deferred<ProcessClose>,
): OwnedProcess {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = makeCapture(outputLimit, options.digestStdout === true);
  const stderr = makeCapture(outputLimit, false);
  const owned: OwnedProcess = {
    child,
    completion,
    stdout,
    stderr,
    closed: false,
    exited: child.exitCode !== null || child.signalCode !== null,
    spawnError: undefined,
    onStdout: (chunk: Buffer) => appendCapture(stdout, chunk),
    onStderr: (chunk: Buffer) => appendCapture(stderr, chunk),
    onError: (error: Error) => {
      owned.spawnError = error;
    },
    onExit: () => {
      owned.exited = true;
    },
    onClose: (code: number | null, signal: NodeJS.Signals | null) => {
      owned.exited = true;
      owned.closed = true;
      Deferred.doneUnsafe(completion, Effect.succeed({ code, signal, error: owned.spawnError }));
    },
  };

  child.stdout?.on("data", owned.onStdout);
  child.stderr?.on("data", owned.onStderr);
  child.on("error", owned.onError);
  child.on("exit", owned.onExit);
  child.on("close", owned.onClose);
  return owned;
}

function releaseProcess(owned: OwnedProcess, killGraceMs: number): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* terminateAndAwait(owned, killGraceMs);
    cleanupProcess(owned);
  });
}

function terminateAndAwait(owned: OwnedProcess, killGraceMs: number): Effect.Effect<void> {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      if (owned.closed) return;
      if (!owned.exited) {
        safeKill(owned.child, "SIGTERM");
        const closedDuringGrace = yield* Effect.race(
          Deferred.await(owned.completion).pipe(Effect.as(true)),
          Effect.sleep(killGraceMs).pipe(Effect.as(false)),
        );
        if (!closedDuringGrace && !owned.closed && !owned.exited) {
          safeKill(owned.child, "SIGKILL");
        }
      }
      yield* Deferred.await(owned.completion);
    }),
  );
}

function cleanupProcess(owned: OwnedProcess): void {
  owned.child.stdout?.off("data", owned.onStdout);
  owned.child.stderr?.off("data", owned.onStderr);
  owned.child.off("error", owned.onError);
  owned.child.off("exit", owned.onExit);
  owned.child.off("close", owned.onClose);
}

function safeKill(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // A concurrent exit is observed by the one close completion owned by the scope.
  }
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

function appendCapture(capture: OutputCapture, chunk: Buffer): void {
  capture.totalBytes += chunk.length;
  capture.digest?.update(chunk);
  if (capture.limit === 0) return;

  capture.chunks.push(chunk);
  capture.retainedBytes += chunk.length;
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

function captureText(capture: OutputCapture): string {
  const bytes = Buffer.concat(capture.chunks, capture.retainedBytes);
  const bounded = capture.limit === undefined ? bytes : validUtf8Suffix(bytes);
  return bounded.toString("utf8").trim();
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
