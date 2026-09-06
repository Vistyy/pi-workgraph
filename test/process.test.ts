import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { ProcessExecutionError, processEffect, runProcess } from "../src/process.js";

const node = process.execPath;
const cwd = process.cwd();

test("the Effect process owner returns normal output through its native API", async () => {
  const result = await Effect.runPromise(
    processEffect(node, ["-e", "process.stdout.write('hello')"], {
      cwd,
      timeoutMs: 1_000,
    }),
  );
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "hello",
    stdoutTruncated: false,
    stderr: "",
    timedOut: false,
  });
});

test("bounded diagnostics do not change the complete stdout fingerprint", async () => {
  const full = `prefix-${"x".repeat(100_000)}-suffix`;
  const result = await runProcess(node, ["-e", `process.stdout.write(${JSON.stringify(full)})`], {
    cwd,
    timeoutMs: 1_000,
    digestStdout: true,
    outputLimit: 32,
  });
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stdout, full.slice(-32));
  assert.equal(result.stdoutDigest, createHash("sha256").update(full).digest("hex"));
});

test("timeout keeps the diagnostic result and escalates from SIGTERM to SIGKILL", async () => {
  const result = await runProcess(
    node,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"],
    { cwd, timeoutMs: 25, killGraceMs: 50 },
  );
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});

test("spawn failures are reported through the process error", async () => {
  await assert.rejects(
    runProcess("/definitely/not/a/real/process", [], { cwd, timeoutMs: 1_000 }),
    (error: unknown) => error instanceof ProcessExecutionError,
  );
});

test("bounded output retains a valid UTF-8 suffix within the byte limit", async () => {
  const full = "🙂".repeat(1_000);
  const result = await runProcess(node, ["-e", `process.stdout.write(${JSON.stringify(full)})`], {
    cwd,
    timeoutMs: 1_000,
    outputLimit: 7,
  });
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stdout, "🙂");
  assert.equal(Buffer.byteLength(result.stdout), 4);
  assert.ok(Buffer.byteLength(result.stdout) <= 7);
});

test("malformed bytes stay within the display byte limit and preserve the raw digest", async () => {
  const result = await runProcess(
    node,
    ["-e", "process.stdout.write(Buffer.from([0xff])); process.stderr.write(Buffer.from([0xfe]))"],
    {
      cwd,
      timeoutMs: 1_000,
      digestStdout: true,
      outputLimit: 1,
    },
  );
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(result.stdoutTruncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 1);
  assert.ok(Buffer.byteLength(result.stderr) <= 1);
  assert.equal(
    result.stdoutDigest,
    createHash("sha256")
      .update(Buffer.from([0xff]))
      .digest("hex"),
  );
});

test("decoded malformed suffixes are bounded for both output streams", async () => {
  const stdout = Buffer.from([0x41, 0xff, 0xf0, 0x9f, 0x98, 0x80]);
  const stderr = Buffer.from([0xc3, 0x28, 0xe2, 0x82, 0xac]);
  const result = await runProcess(
    node,
    [
      "-e",
      `process.stdout.write(Buffer.from([${[...stdout]}])); process.stderr.write(Buffer.from([${[...stderr]}]))`,
    ],
    { cwd, timeoutMs: 1_000, outputLimit: 6 },
  );
  assert.equal(result.stdout, "😀");
  assert.equal(result.stderr, "(€");
  assert.equal(result.stdoutTruncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 6);
  assert.ok(Buffer.byteLength(result.stderr) <= 6);
});

test("interrupting the Effect waits for the owned process to close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-process-"));
  const marker = join(directory, "closed");
  try {
    const controller = new AbortController();
    const running = Effect.runPromise(
      processEffect(
        node,
        [
          "-e",
          `process.on('SIGTERM', () => setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'closed'); process.exit(0) }, 75)); setInterval(() => {}, 1_000)`,
        ],
        { cwd, timeoutMs: 10_000 },
      ),
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 150).unref();
    await assert.rejects(running);
    assert.equal(await readFile(marker, "utf8"), "closed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a pre-aborted signal does not launch a process", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runProcess("/definitely/not/a/real/process", [], {
      cwd,
      timeoutMs: 1_000,
      signal: controller.signal,
    }),
  );
});

test("interrupting the Effect cancels the owned process", async () => {
  const controller = new AbortController();
  const running = runProcess(
    node,
    ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000)"],
    { cwd, timeoutMs: 10_000, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 25).unref();
  await assert.rejects(running);
});
