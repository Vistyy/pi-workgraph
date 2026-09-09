/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/global-timers, effecttsgo/node-builtin-import, typescript/strict-boolean-expressions */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Effect } from "effect";
import { type ProcessResult, processEffect } from "../../src/process.js";

const checkout = process.cwd();
const started = Date.now();
const controller = new AbortController();
const deadlineTimer = setTimeout(
  () => controller.abort(new Error("verify:package exceeded its 180-second overall deadline.")),
  180_000,
);
let parent: string | undefined;

async function command(
  cwd: string,
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const result = await Effect.runPromise(
    processEffect(file, args, { cwd, timeoutMs: 30_000, outputLimit: 2_000_000, env }),
    { signal: controller.signal },
  );
  assert.equal(result.timedOut, false, `${file} exceeded its 30-second command deadline.`);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdoutTruncated || result.stderrTruncated, false);
  return result.stdout.trim();
}

async function runPackage(): Promise<void> {
  parent = await mkdtemp(join(tmpdir(), "workgraph-package-check-"));
  const packed = await command(checkout, "pnpm", ["pack", "--pack-destination", parent]);
  const tarball = packed.split("\n").at(-1);
  assert.ok(tarball);
  const consumer = join(parent, "consumer");
  const tarballPath = isAbsolute(tarball) ? tarball : join(parent, tarball);
  const entries = await command(parent, "tar", ["-tzf", tarballPath]);
  assert.match(entries, /package\/scripts\/codex-web-gpt-headless\/consult\.py\n/);
  assert.doesNotMatch(entries, /package\/scripts\/live\//);
  await mkdir(consumer);
  await command(parent, "pnpm", [
    "add",
    "--dir",
    consumer,
    "--ignore-workspace",
    "--ignore-scripts",
    tarballPath,
  ]);
  const response: unknown = JSON.parse(
    await command(consumer, "pnpm", ["exec", "pi-workgraph", "--help"]),
  );
  const packageRoot = join(consumer, "node_modules/@vistyy/pi-workgraph");
  const lifecycleTarget = join(packageRoot, "bin/codex-web-gpt-lifecycle.sh");
  assert.ok((await stat(lifecycleTarget)).mode & 0o111);
  await stat(join(packageRoot, "scripts/codex-web-gpt-headless/consult.py"));
  const installedBin = await realpath(
    join(consumer, "node_modules/.bin/pi-workgraph-chatgpt-web-start"),
  );
  assert.ok((await stat(installedBin)).mode & 0o111);
  assert.partialDeepStrictEqual(response, { ok: true, command: "help" });

  const npmBin = join(parent, "npm-bin/pi-workgraph-chatgpt-web-start");
  await mkdir(join(parent, "npm-bin"));
  await symlink(await realpath(lifecycleTarget), npmBin);
  for (const executable of [lifecycleTarget, npmBin]) {
    const result: ProcessResult = await Effect.runPromise(
      processEffect(executable, [], {
        cwd: consumer,
        timeoutMs: 30_000,
        outputLimit: 2_000_000,
        env: { ...process.env, CODEX_WEB_GPT_HEADLESS_ROOT: join(parent, "isolated-root") },
      }),
    );
    assert.equal(result.exitCode, 1, result.stderr);
    assert.match(result.stderr, /scripts\/codex-web-gpt-headless\/install\.sh/);
  }
  process.stdout.write(
    `${JSON.stringify({ status: "passed", tarball, consumer, totalMs: Date.now() - started })}\n`,
  );
}

try {
  await runPackage();
} catch (cause) {
  const failure: unknown = controller.signal.aborted ? controller.signal.reason : cause;
  process.stderr.write(
    `verify:package failed at the pack/install/help boundary. Package installation needs registry/network access for uncached peers and dependencies. ${failure instanceof Error ? failure.message : String(failure)}\n`,
  );
  process.exitCode = 1;
} finally {
  clearTimeout(deadlineTimer);
  if (parent !== undefined) await rm(parent, { recursive: true, force: true });
}
