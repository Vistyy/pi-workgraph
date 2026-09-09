import assert from "node:assert/strict";
// SAFETY: Test-only files stay inside an owned temporary directory.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// SAFETY: Test-only paths stay inside an owned temporary directory.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { join } from "node:path";
import test from "node:test";
import { loadCalmAdditionalHiddenTools } from "../src/calm-settings.js";

void test("global Pi settings provide validated user-owned Calm tool additions", async () => {
  const root = await mkdtemp(join(tmpdir(), "wg-calm-settings-"));
  const path = join(root, "settings.json");
  try {
    assert.deepEqual(await loadCalmAdditionalHiddenTools(path), []);

    await writeFile(
      path,
      JSON.stringify({
        defaultModel: "fixture/model",
        "pi-workgraph": {
          calm: {
            additionalHiddenTools: ["web_search", "rename_resource", "web_search"],
          },
        },
      }),
    );
    assert.deepEqual(await loadCalmAdditionalHiddenTools(path), ["web_search", "rename_resource"]);

    await writeFile(
      path,
      JSON.stringify({ "pi-workgraph": { calm: { additionalHiddenTools: "web_search" } } }),
    );
    await assert.rejects(loadCalmAdditionalHiddenTools(path), /additionalHiddenTools/);

    await writeFile(path, "{");
    await assert.rejects(loadCalmAdditionalHiddenTools(path), /Invalid JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
