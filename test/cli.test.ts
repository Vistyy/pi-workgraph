import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";

test("CLI status preserves uninterpreted historical bytes and does not create a registry", async () => {
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
    await assert.rejects(
      readFile(join(parent, "workgraph", "registry.sqlite")),
      /ENOENT/,
    );
    await assert.rejects(runCli(["status"]), /Provide/);
    await assert.rejects(runCli(["fork"], {}), /parent-session-file/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
