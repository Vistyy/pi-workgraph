import assert from "node:assert/strict";
// SAFETY: Test-only files stay inside an owned temporary directory.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// SAFETY: Test-only paths stay inside an owned temporary directory.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { join } from "node:path";
import test from "node:test";
import { loadWorkerDisabledTools } from "../../src/worker/settings.js";

void test("global Pi settings validate worker tool settings and ignore Calm sections", async () => {
  const root = await mkdtemp(join(tmpdir(), "wg-workgraph-settings-"));
  const path = join(root, "settings.json");

  try {
    assert.deepEqual(await loadWorkerDisabledTools(path), []);

    await writeFile(
      path,
      JSON.stringify({
        defaultModel: "fixture/model",
        "pi-workgraph": {
          worker: { disabledTools: ["rename_resource", "rename_resource", "custom_lookup"] },
        },
      }),
    );
    assert.deepEqual(await loadWorkerDisabledTools(path), ["rename_resource", "custom_lookup"]);

    // Retired Calm presentation settings must not invalidate the retained worker settings.
    await writeFile(
      path,
      JSON.stringify({
        "pi-workgraph": {
          calm: { additionalHiddenTools: ["web_search"] },
          worker: { disabledTools: ["rename_resource"] },
        },
      }),
    );
    assert.deepEqual(await loadWorkerDisabledTools(path), ["rename_resource"]);

    await writeFile(
      path,
      JSON.stringify({
        "pi-workgraph": {
          worker: { disabledTools: "rename_resource" },
        },
      }),
    );
    await assert.rejects(loadWorkerDisabledTools(path), /worker.disabledTools/);

    await writeFile(path, "{");
    await assert.rejects(loadWorkerDisabledTools(path), /Invalid JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
