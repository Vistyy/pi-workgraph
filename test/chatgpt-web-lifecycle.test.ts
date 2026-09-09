import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Lifecycle paths are a filesystem boundary under test.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Lifecycle paths are a filesystem boundary under test.
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { processEffect } from "../src/process.js";

const scriptRoot = join(process.cwd(), "scripts/codex-web-gpt-headless");
const scripts = [join(scriptRoot, "start.sh"), join(scriptRoot, "stop.sh")];
const status = join(scriptRoot, "status.sh");

async function processStartTime(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  return (
    stat
      .slice(stat.lastIndexOf(") ") + 2)
      .trim()
      .split(" ")[19] ?? ""
  );
}

async function runScript(script: string, root: string) {
  return Effect.runPromise(
    processEffect("sh", [script], {
      timeoutMs: 5_000,
      outputLimit: 4_000,
      env: { ...process.env, CODEX_WEB_GPT_HEADLESS_ROOT: root },
    }),
  );
}

await test("bundled lifecycle preserves a live foreign supervisor PID record", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workgraph-lifecycle-"));
  const pidFile = join(root, "runtime/session.pid");
  try {
    const record = `${process.pid} ${await processStartTime(process.pid)}\n`;
    await mkdir(join(root, "runtime"), { recursive: true, mode: 0o700 });
    await writeFile(pidFile, record, { mode: 0o600 });
    for (const script of scripts) {
      const result = await runScript(script, root);
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /preserve|inspect|migrate/);
      assert.equal(await readFile(pidFile, "utf8"), record);
    }
    const stale = "99999999 1\n";
    await writeFile(pidFile, stale, { mode: 0o600 });
    assert.equal((await runScript(status, root)).exitCode, 0);
    assert.equal(await readFile(pidFile, "utf8"), stale);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
