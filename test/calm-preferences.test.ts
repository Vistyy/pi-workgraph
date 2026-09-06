import assert from "node:assert/strict";
// SAFETY: Native reads verify the preference file boundary independently of the Effect writer.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// SAFETY: Test-only paths are contained in the owned temporary directory.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { join } from "node:path";
import test from "node:test";
import { calmPreferences } from "../src/calm-preferences.js";

void test("Calm default persists across readers, atomically replaces, and rejects corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "wg-calm-"));
  const path = join(root, "workgraph", "calm-default");
  try {
    const first = calmPreferences(path);
    assert.equal(await first.load(), false);
    await first.save(true);
    assert.equal(await calmPreferences(path).load(), true);
    await calmPreferences(path).save(false);
    assert.equal(await first.load(), false);
    assert.equal(await readFile(path, "utf8"), "off\n");
    assert.deepEqual(await readdir(join(root, "workgraph")), ["calm-default"]);
    await writeFile(path, "not-a-preference");
    await assert.rejects(first.load(), /Invalid Calm default/);
    assert.equal(await readFile(path, "utf8"), "not-a-preference");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
