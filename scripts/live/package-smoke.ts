/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/global-timers, effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { processEffect } from "../../src/process.js";

const checkout = process.cwd();
const started = Date.now();
const controller = new AbortController();
const deadlineTimer = setTimeout(
  () => controller.abort(new Error("verify:package exceeded its 180-second overall deadline.")),
  180_000,
);
let parent: string | undefined;

async function command(cwd: string, file: string, args: string[]): Promise<string> {
  const result = await Effect.runPromise(
    processEffect(file, args, {
      cwd,
      timeoutMs: 30_000,
      outputLimit: 2_000_000,
      env: process.env,
    }),
    { signal: controller.signal },
  );
  assert.equal(result.timedOut, false, `${file} exceeded its 30-second command deadline.`);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdoutTruncated || result.stderrTruncated, false);
  return result.stdout.trim();
}

async function smokePackage(): Promise<void> {
  parent = await mkdtemp(join(tmpdir(), "workgraph-package-smoke-"));
  const packed = await command(checkout, "pnpm", ["pack", "--pack-destination", parent]);
  const tarball = packed.split("\n").at(-1);
  if (tarball === undefined || tarball === "")
    throw new Error("pnpm pack returned no tarball path.");
  const tarballPath = isAbsolute(tarball) ? tarball : join(parent, tarball);
  const consumer = join(parent, "consumer");
  await mkdir(consumer);
  await command(consumer, "npm", ["init", "--yes"]);
  await command(consumer, "npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    tarballPath,
  ]);
  const packageRoot = join(consumer, "node_modules/@vistyy/pi-workgraph");
  const modules = ["extensions/coordinator.ts", "extensions/worker.ts"].map(
    (path) => pathToFileURL(join(packageRoot, path)).href,
  );
  await command(consumer, "node", [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    `for (const url of ${JSON.stringify(modules)}) { const loaded = await import(url); if (typeof loaded.default !== "function") throw new Error(\`Missing extension factory: \${url}\`); }`,
  ]);
  const response: unknown = JSON.parse(
    await command(consumer, join(consumer, "node_modules/.bin/pi-workgraph"), ["--help"]),
  );
  assert.partialDeepStrictEqual(response, { ok: true, command: "help" });
  process.stdout.write(
    `${JSON.stringify({ status: "passed", boundary: "pack/install/import/cli", totalMs: Date.now() - started })}\n`,
  );
}

try {
  await smokePackage();
} catch (cause) {
  const failure: unknown = controller.signal.aborted ? controller.signal.reason : cause;
  process.stderr.write(
    `verify:package failed at the pack/install/import/CLI boundary. Installation may require registry access for uncached peers and dependencies. ${failure instanceof Error ? failure.message : String(failure)}\n`,
  );
  process.exitCode = 1;
} finally {
  clearTimeout(deadlineTimer);
  if (parent !== undefined) await rm(parent, { recursive: true, force: true });
}
