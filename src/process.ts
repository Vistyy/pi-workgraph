import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Data, Effect } from "effect";

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

/** Effect-native process boundary; callers may use the Promise adapter below during migration. */
export function processEffect(
  command: string,
  args: readonly string[],
  options: Omit<ProcessOptions, "signal">,
): Effect.Effect<ProcessResult, ProcessExecutionError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            spawn(command, [...args], {
              cwd: options.cwd,
              env: options.env,
              shell: false,
              stdio: ["ignore", "pipe", "pipe"],
            }),
          catch: (cause) =>
            new ProcessExecutionError({
              command,
              args,
              cause,
            }),
        }),
        (process) =>
          Effect.sync(() => {
            terminate(process, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
          }),
      );
      return yield* Effect.tryPromise({
        try: (signal) => collect(child, options, signal),
        catch: (cause) =>
          new ProcessExecutionError({
            command,
            args,
            cause,
          }),
      });
    }),
  );
}

/** Temporary outward adapter for Git and Herdr callers that still expose Promises. */
export async function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  return Effect.runPromise(processEffect(command, args, options), {
    signal: options.signal,
  });
}

function collect(
  child: ChildProcess,
  options: Omit<ProcessOptions, "signal">,
  signal: AbortSignal,
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    let stdout = "";
    let stdoutBytes = 0;
    const digest = options.digestStdout ? createHash("sha256") : undefined;
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let escalationTimer: NodeJS.Timeout | undefined;
    const outputLimit =
      options.outputLimit === false ? undefined : (options.outputLimit ?? OUTPUT_LIMIT);

    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString();
      return outputLimit === undefined || Buffer.byteLength(next) <= outputLimit
        ? next
        : next.slice(-outputLimit);
    };
    const stop = (): void => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      escalationTimer = setTimeout(
        () => child.kill("SIGKILL"),
        options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
      );
      escalationTimer.unref();
    };
    const onAbort = (): void => stop();
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    timeout.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      digest?.update(chunk);
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    signal.addEventListener("abort", onAbort, { once: true });

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) =>
      finish(() => {
        const result: ProcessResult = {
          exitCode: code ?? 1,
          stdout: stdout.trim(),
          stdoutTruncated: outputLimit !== undefined && stdoutBytes > outputLimit,
          stderr: stderr.trim(),
          timedOut,
        };
        if (digest) result.stdoutDigest = digest.digest("hex");
        resolve(result);
      }),
    );

    if (signal.aborted) stop();
  });
}

function terminate(child: ChildProcess, killGraceMs: number): void {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const escalationTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
  escalationTimer.unref();
}
