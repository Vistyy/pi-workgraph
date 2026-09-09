import assert from "node:assert/strict";
// SAFETY: Test-only files stay inside an owned temporary directory.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// SAFETY: Test-only paths stay inside an owned temporary directory.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { join } from "node:path";
import test from "node:test";
import {
  loadCalmAdditionalHiddenTools,
  loadWorkerDisabledTools,
} from "../src/workgraph-settings.js";

void test("global Pi settings validate Calm and worker tool settings independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "wg-workgraph-settings-"));
  const path = join(root, "settings.json");
  try {
    assert.deepEqual(await loadCalmAdditionalHiddenTools(path), []);
    assert.deepEqual(await loadWorkerDisabledTools(path), []);

    await writeFile(
      path,
      JSON.stringify({
        defaultModel: "fixture/model",
        "pi-workgraph": {
          calm: { additionalHiddenTools: ["web_search", "rename_resource", "web_search"] },
          worker: { disabledTools: ["rename_resource", "rename_resource", "custom_lookup"] },
        },
      }),
    );
    assert.deepEqual(await loadCalmAdditionalHiddenTools(path), ["web_search", "rename_resource"]);
    assert.deepEqual(await loadWorkerDisabledTools(path), ["rename_resource", "custom_lookup"]);

    await writeFile(
      path,
      JSON.stringify({
        "pi-workgraph": {
          calm: { additionalHiddenTools: "web_search" },
          worker: { disabledTools: ["rename_resource"] },
        },
      }),
    );
    await assert.rejects(loadCalmAdditionalHiddenTools(path), /calm.additionalHiddenTools/);
    assert.deepEqual(await loadWorkerDisabledTools(path), ["rename_resource"]);

    await writeFile(
      path,
      JSON.stringify({
        "pi-workgraph": {
          calm: { additionalHiddenTools: ["web_search"] },
          worker: { disabledTools: "rename_resource" },
        },
      }),
    );
    assert.deepEqual(await loadCalmAdditionalHiddenTools(path), ["web_search"]);
    await assert.rejects(loadWorkerDisabledTools(path), /worker.disabledTools/);

    await writeFile(path, "{");
    await assert.rejects(loadWorkerDisabledTools(path), /Invalid JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
