import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Process integration tests narrowly observe actual Node ChildProcess events.
import { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Process integration tests inspect real child-process filesystem effects.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Marker paths identify native child-process resources.
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Effect } from "effect";
import { ProcessExecutionError, processEffect } from "../src/process.js";

type ProcessRunOptions = Parameters<typeof processEffect>[2];
type NativeClose = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
};

interface DeferredPromise<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

interface NativeChildObservation {
  child: ChildProcess | undefined;
  launchCount: number;
  readonly ready: Promise<void>;
  readonly closed: Promise<NativeClose>;
}

const node = process.execPath;
const cwd = process.cwd();
let nextToken = 0;
const run = (command: string, args: readonly string[], options: ProcessRunOptions) =>
  Effect.runPromise(processEffect(command, args, options));

function deferred<T>(): DeferredPromise<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  // oxlint-disable-next-line effecttsgo/new-promise -- Native event observation needs a Promise bridge.
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function within<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  // oxlint-disable-next-line effecttsgo/new-promise -- A bounded deadline must race a native Promise.
  return new Promise<T>((resolve, reject) => {
    // oxlint-disable-next-line effecttsgo/global-timers -- Bounded native-process observation deadline.
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function observeNativeChild(
  t: TestContext,
  token: string,
  readiness = "READY",
): NativeChildObservation {
  const ready = deferred<void>();
  const closed = deferred<NativeClose>();
  // oxlint-disable-next-line typescript/unbound-method -- Preserve the native emitter for the call-through observer.
  const originalEmit = ChildProcess.prototype.emit;
  const observation: NativeChildObservation = {
    child: undefined,
    launchCount: 0,
    ready: ready.promise,
    closed: closed.promise,
  };
  t.mock.method(
    ChildProcess.prototype,
    "emit",
    function (this: ChildProcess, ...args: Parameters<ChildProcess["emit"]>): boolean {
      // SAFETY: ChildProcess emits string or symbol event names; the library typing selects one overload.
      const event = args[0] as string | symbol;
      const eventArgs = args.slice(1);
      if (event === "spawn" && this.spawnargs.some((argument) => argument.includes(token))) {
        observation.child = this;
        observation.launchCount += 1;
        let stdout = "";
        this.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.includes(readiness)) ready.resolve();
        });
      } else if (event === "close" && this === observation.child) {
        closed.resolve(parseNativeClose(eventArgs));
      }
      return originalEmit.apply(this, args);
    },
  );

  return observation;
}

function parseNativeClose(args: readonly unknown[]): NativeClose {
  // SAFETY: Node's close event supplies a nullable exit code and signal in this order.
  const code = args[0] as number | null;
  // SAFETY: Node's close event supplies a nullable NodeJS signal as its second argument.
  const signal = args[1] as NodeJS.Signals | null;
  return { code, signal };
}

async function cleanupObservedChild(observation: NativeChildObservation): Promise<void> {
  const child = observation.child;
  if (child === undefined) return;
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await within(observation.closed, "native child close");
}

const malformedByteCases = [
  {
    name: "single malformed bytes",
    stdout: Buffer.from([0xff]),
    stderr: Buffer.from([0xfe]),
    outputLimit: 1,
    expectedStdout: "",
    expectedStderr: "",
    digestStdout: true,
  },
  {
    name: "malformed UTF-8 suffixes",
    stdout: Buffer.from([0x41, 0xff, 0xf0, 0x9f, 0x98, 0x80]),
    stderr: Buffer.from([0xc3, 0x28, 0xe2, 0x82, 0xac]),
    outputLimit: 6,
    expectedStdout: "😀",
    expectedStderr: "(€",
    digestStdout: false,
  },
] as const;

void test("the Effect process owner returns normal output through its native API", async () => {
  const result = await run(node, ["-e", "process.stdout.write('hello')"], {
    cwd,
    timeoutMs: 1_000,
  });
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "hello",
    stdoutTruncated: false,
    stderr: "",
    stderrTruncated: false,
    timedOut: false,
  });
});

void test("bounded diagnostics do not change the complete stdout fingerprint", async () => {
  const full = `prefix-${"x".repeat(100_000)}-suffix`;
  const result = await run(node, ["-e", `process.stdout.write(${JSON.stringify(full)})`], {
    cwd,
    timeoutMs: 1_000,
    digestStdout: true,
    outputLimit: 32,
  });
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stdout, full.slice(-32));
  assert.equal(result.stdoutDigest, createHash("sha256").update(full).digest("hex"));
});

void test("timeout observes a ready child accepting SIGTERM", { timeout: 5_000 }, async (t) => {
  const token = `accept-sigterm-${process.pid}-${++nextToken}`;
  const observation = observeNativeChild(t, token);
  try {
    const running = run(
      node,
      [
        "-e",
        `const token = ${JSON.stringify(token)}; process.on('SIGTERM', () => { process.stdout.write('TERM\\n'); process.exit(0) }); process.stdout.write('READY\\n'); setInterval(() => {}, 1_000)`,
      ],
      { cwd, timeoutMs: 500, killGraceMs: 500 },
    );
    await within(observation.ready, "child readiness");
    const result = await within(running, "timeout result");
    assert.equal(result.timedOut, true);
    assert.match(result.stdout, /READY/);
    if (process.platform !== "win32") {
      assert.match(result.stdout, /TERM/);
      assert.equal(result.exitCode, 0);
    }
    await within(observation.closed, "native child close");
  } finally {
    await cleanupObservedChild(observation);
  }
});

void test("timeout escalates from a ready child ignoring SIGTERM", {
  timeout: 5_000,
}, async (t) => {
  const token = `ignore-sigterm-${process.pid}-${++nextToken}`;
  const observation = observeNativeChild(t, token);
  try {
    const running = run(
      node,
      [
        "-e",
        `const token = ${JSON.stringify(token)}; process.on('SIGTERM', () => process.stdout.write('TERM\\n')); process.stdout.write('READY\\n'); setInterval(() => {}, 1_000)`,
      ],
      { cwd, timeoutMs: 500, killGraceMs: 100 },
    );
    await within(observation.ready, "child readiness");
    const result = await within(running, "timeout result");
    assert.equal(result.timedOut, true);
    assert.match(result.stdout, /READY/);
    assert.notEqual(result.exitCode, 0);
    const close = await within(observation.closed, "native child close");
    if (process.platform !== "win32") {
      assert.match(result.stdout, /TERM/);
      assert.equal(close.signal, "SIGKILL");
    }
  } finally {
    await cleanupObservedChild(observation);
  }
});

void test("timeout includes streams held by a child after the parent exits", async () => {
  const result = await run(
    node,
    [
      "-e",
      "const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 350)'], { stdio: 'inherit' }); child.unref();",
    ],
    { cwd, timeoutMs: 50, killGraceMs: 50 },
  );
  assert.equal(result.timedOut, true);
});

void test("spawn failures are reported through the process error", async () => {
  await assert.rejects(
    run("/definitely/not/a/real/process", [], { cwd, timeoutMs: 1_000 }),
    (error: Error) => error instanceof ProcessExecutionError,
  );
});

void test("bounded output retains a valid UTF-8 suffix within the byte limit", async () => {
  const full = "🙂".repeat(1_000);
  const result = await run(node, ["-e", `process.stdout.write(${JSON.stringify(full)})`], {
    cwd,
    timeoutMs: 1_000,
    outputLimit: 7,
  });
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stdout, "🙂");
  assert.equal(Buffer.byteLength(result.stdout), 4);
  assert.ok(Buffer.byteLength(result.stdout) <= 7);
});

for (const byteCase of malformedByteCases) {
  void test(`bounded ${byteCase.name} stays within its byte limit`, async () => {
    const result = await run(
      node,
      [
        "-e",
        `process.stdout.write(Buffer.from("${byteCase.stdout.toString("hex")}", "hex")); process.stderr.write(Buffer.from("${byteCase.stderr.toString("hex")}", "hex"))`,
      ],
      {
        cwd,
        timeoutMs: 1_000,
        digestStdout: byteCase.digestStdout,
        outputLimit: byteCase.outputLimit,
      },
    );
    assert.equal(result.stdout, byteCase.expectedStdout);
    assert.equal(result.stderr, byteCase.expectedStderr);
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stderrTruncated, true);
    assert.ok(Buffer.byteLength(result.stdout) <= byteCase.outputLimit);
    assert.ok(Buffer.byteLength(result.stderr) <= byteCase.outputLimit);
    if (byteCase.digestStdout) {
      assert.equal(result.stdoutDigest, createHash("sha256").update(byteCase.stdout).digest("hex"));
    }
  });
}

void test("interrupting the Effect observes native close before rejection", {
  timeout: 5_000,
}, async (t) => {
  const token = `interrupt-${process.pid}-${++nextToken}`;
  const observation = observeNativeChild(t, token);
  const controller = new AbortController();
  try {
    const running = Effect.runPromise(
      processEffect(
        node,
        [
          "-e",
          `const token = ${JSON.stringify(token)}; process.on('SIGTERM', () => setTimeout(() => process.exit(0), 75)); process.stdout.write('READY\\n'); setInterval(() => {}, 1_000)`,
        ],
        { cwd, timeoutMs: 10_000 },
      ),
      { signal: controller.signal },
    );
    await within(observation.ready, "SIGTERM handler readiness");
    const child = observation.child;
    assert.ok(child !== undefined);
    assert.equal(child.exitCode, null);
    controller.abort();
    const first = await within(
      Promise.race([
        observation.closed.then(() => "close" as const),
        running.then(
          () => "settled" as const,
          () => "settled" as const,
        ),
      ]),
      "close-before-rejection ordering",
    );
    assert.equal(first, "close");
    await assert.rejects(running);
  } finally {
    controller.abort();
    await cleanupObservedChild(observation);
  }
});

void test("a pre-aborted signal does not launch a real executable", {
  timeout: 5_000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-process-pre-abort-"));
  const marker = join(directory, "launched");
  const token = `pre-abort-${process.pid}-${++nextToken}`;
  const observation = observeNativeChild(t, token);
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      Effect.runPromise(
        processEffect(
          node,
          [
            "-e",
            `const token = ${JSON.stringify(token)}; require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`,
          ],
          { cwd, timeoutMs: 1_000 },
        ),
        { signal: controller.signal },
      ),
    );
    // oxlint-disable-next-line effecttsgo/new-promise -- One event-loop turn flushes a forbidden native launch observation.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(observation.launchCount, 0);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally {
    await cleanupObservedChild(observation);
    await rm(directory, { recursive: true, force: true });
  }
});
