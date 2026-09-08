/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/global-timers, effecttsgo/new-promise, effecttsgo/node-builtin-import, typescript/strict-boolean-expressions */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const checkout = process.cwd();
const started = Date.now();
let deadlineTimer: NodeJS.Timeout | undefined;
const deadline = new Promise<never>((_, reject) => {
  deadlineTimer = setTimeout(
    () => reject(new Error("verify:package exceeded its 180-second overall deadline.")),
    180_000,
  );
});
let parent: string | undefined;

async function command(cwd: string, file: string, args: string[]): Promise<string> {
  const result = await exec(file, args, { cwd, timeout: 30_000, maxBuffer: 2_000_000 });
  return result.stdout.trim();
}

async function runPackage(): Promise<void> {
  parent = await mkdtemp(join(tmpdir(), "workgraph-package-check-"));
  const packed = await command(checkout, "pnpm", ["pack", "--pack-destination", parent]);
  const tarball = packed.split("\n").at(-1);
  assert.ok(tarball);
  const consumer = join(parent, "consumer");
  const tarballPath = isAbsolute(tarball) ? tarball : join(parent, tarball);
  await mkdir(consumer);
  await command(parent, "pnpm", [
    "add",
    "--dir",
    consumer,
    "--ignore-workspace",
    "--ignore-scripts",
    tarballPath,
  ]);
  const help = await command(consumer, "pnpm", ["exec", "pi-workgraph", "--help"]);
  assert.match(help, /workgraph|Usage|help/i);
  process.stdout.write(
    `${JSON.stringify({ status: "passed", tarball, consumer, totalMs: Date.now() - started })}\n`,
  );
}

try {
  await Promise.race([runPackage(), deadline]);
} catch (cause) {
  process.stderr.write(
    `verify:package failed at the pack/install/help boundary. Package installation needs registry/network access for uncached peers and dependencies. ${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  process.exitCode = 1;
} finally {
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  if (parent !== undefined) await rm(parent, { recursive: true, force: true });
}
