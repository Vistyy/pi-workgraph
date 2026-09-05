import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_MODEL_POLICY,
  loadModelPolicy,
  setModelRole,
} from "../src/model-policy.js";

test("policy defaults, read-only legacy mapping and explicit current-role writes use isolated paths", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-models-"));
  const path = join(parent, "models.json");
  try {
    assert.deepEqual(await loadModelPolicy(path), DEFAULT_MODEL_POLICY);
    const legacy = JSON.stringify({
      version: 1,
      roles: {
        "discovery.evidence": [{ model: "fixture/research", thinking: "low" }],
        "implementation.guide": [{ model: "fixture/guide", thinking: "high" }],
        "implementation.executor": [
          { model: "fixture/executor", thinking: "medium" },
        ],
        "verification.product": [
          { model: "fixture/reviewer", thinking: "off" },
        ],
      },
    });
    await writeFile(path, legacy);
    const mapped = await loadModelPolicy(path);
    assert.equal(mapped.version, 2);
    assert.equal(mapped.roles.research.model, "fixture/research");
    assert.equal(mapped.roles.review.model, "fixture/reviewer");
    assert.equal(mapped.roles["implementation.guide"].model, "fixture/guide");
    assert.equal(
      mapped.roles["implementation.executor"].model,
      "fixture/executor",
    );
    assert.equal(await readFile(path, "utf8"), legacy);
    await setModelRole(
      "review",
      { model: "fixture/new", thinking: "max" },
      path,
    );
    assert.equal(
      (await loadModelPolicy(path)).roles.review.model,
      "fixture/new",
    );
    assert.equal(
      (await loadModelPolicy(path)).roles.research.model,
      "fixture/research",
    );
    await assert.rejects(
      setModelRole(
        "review",
        { model: "not-a-selector", thinking: "high" },
        path,
      ),
      /Invalid/,
    );
    await writeFile(path, '{"version":999,"roles":{}}');
    await assert.rejects(loadModelPolicy(path), /Unsupported/);
    await writeFile(
      path,
      '{"version":2,"roles":{"review":{"model":"p/m","thinking":"invalid"}}}',
    );
    await assert.rejects(loadModelPolicy(path), /Invalid model target/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
