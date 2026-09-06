import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The regression exercises the native executable boundary.
import { spawnSync } from "node:child_process";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The test uses a real temporary filesystem boundary.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The test uses a native temporary path identity.
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";

void test("CLI status preserves uninterpreted historical bytes and does not create a registry", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-cli-"));
  const path = join(parent, "retained.json");
  const bytes = '{ "version": 999, "retained": ["untouched"] }\n';
  try {
    await writeFile(path, bytes);
    const result = await runCli(["status", "--state", path], {
      PI_CODING_AGENT_DIR: parent,
    });
    assert.deepEqual(result.state, { version: 999, retained: ["untouched"] });
    assert.equal(await readFile(path, "utf8"), bytes);
    await assert.rejects(readFile(join(parent, "workgraph", "registry.sqlite")), /ENOENT/);
    await assert.rejects(runCli(["status"]), /Provide/);
    await assert.rejects(runCli(["fork"], {}), /parent-session-file/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("CLI bootstrap resolves its loader from an unrelated caller cwd", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-cli-bootstrap-"));
  const bootstrap = fileURLToPath(new URL("../bin/pi-workgraph.mjs", import.meta.url));
  try {
    const result = spawnSync(process.execPath, [bootstrap, "--help"], {
      cwd: parent,
      env: process.env,
      encoding: "utf8",
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.match(result.stdout, /^\{"ok":true,"command":"help"/);
    assert.equal(result.stderr, "");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
