import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Effect } from "effect";
import { processEffect, runProcess } from "../src/process.js";

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
