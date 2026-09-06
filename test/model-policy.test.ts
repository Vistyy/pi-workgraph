import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This test verifies the native atomic policy-file boundary.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native temporary paths are part of the policy-file test boundary.
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_MODEL_POLICY,
  loadModelPolicy,
  resolveSelection,
  setModelRole,
} from "../src/model-policy.js";

// oxlint-disable-next-line effecttsgo/async-function -- node:test owns and awaits this Promise callback.
await test("policy defaults, read-only legacy mapping and explicit current-role writes use isolated paths", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-models-"));
  const path = join(parent, "models.json");
  try {
    assert.deepEqual(DEFAULT_MODEL_POLICY, {
      version: 3,
      roles: {
        research: { model: "opencode-go/muse-spark-1.3-contributor", thinking: "high" },
        "implementation.guide": { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
        "implementation.executor": { model: "openai-codex/gpt-5.6-luna", thinking: "high" },
        review: { model: "opencode-go/muse-spark-1.3-contributor", thinking: "high" },
      },
      workerPool: [
        { model: "opencode-go/muse-spark-1.3-contributor", thinking: "high" },
        { model: "openai-codex/gpt-5.6-luna", thinking: "high" },
        { model: "deepseek/deepseek-v4-flash", thinking: "high" },
        { model: "zai/glm-5.3-flash", thinking: "high" },
        { model: "openai-codex/gpt-5.6-terra", thinking: "high" },
      ],
    });
    assert.deepEqual(await loadModelPolicy(path), DEFAULT_MODEL_POLICY);
    const legacy = JSON.stringify({
      version: 1,
      roles: {
        "discovery.evidence": [{ model: "fixture/research", thinking: "low" }],
        "implementation.guide": [{ model: "fixture/guide", thinking: "high" }],
        "implementation.executor": [{ model: "fixture/executor", thinking: "medium" }],
        "verification.product": [{ model: "fixture/reviewer", thinking: "off" }],
      },
    });
    await writeFile(path, legacy);
    const mapped = await loadModelPolicy(path);
    assert.equal(mapped.version, 3);
    assert.equal(mapped.roles.research.model, "fixture/research");
    assert.equal(mapped.roles.review.model, "fixture/reviewer");
    assert.equal(mapped.roles["implementation.guide"].model, "fixture/guide");
    assert.equal(mapped.roles["implementation.executor"].model, "fixture/executor");
    assert.equal(await readFile(path, "utf8"), legacy);
    await setModelRole("review", { model: "fixture/new", thinking: "max" }, path);
    assert.equal((await loadModelPolicy(path)).roles.review.model, "fixture/new");
    assert.equal((await loadModelPolicy(path)).roles.research.model, "fixture/research");
    await assert.rejects(
      setModelRole("review", { model: "not-a-selector", thinking: "high" }, path),
      /Invalid/,
    );
    await writeFile(path, '{"version":999,"roles":{}}');
    await assert.rejects(loadModelPolicy(path), /Unsupported/);
    await writeFile(path, '{"credential":"super-secret"');
    await assert.rejects(loadModelPolicy(path), /^Error: Invalid Workgraph model policy JSON\.$/);
    await writeFile(path, '{"version":2,"roles":{"review":{"model":"p/m","thinking":"invalid"}}}');
    await assert.rejects(loadModelPolicy(path), /Invalid model target/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

await test("selection is policy-owned, deterministic, and explicit about insufficient diversity", () => {
  const policy = structuredClone(DEFAULT_MODEL_POLICY);
  const repeated = resolveSelection("research", { count: 3 }, policy);
  assert.equal(repeated.selected.length, 3);
  assert.equal(new Set(repeated.selected.map((target) => target.model)).size, 1);
  const distinct = resolveSelection("review", { count: 3, diversity: "distinct-models" }, policy);
  assert.deepEqual(
    distinct.selected.map((target) => target.model),
    policy.workerPool.slice(0, 3).map((target) => target.model),
  );
  assert.equal(distinct.source, "policy");
  assert.match(distinct.reason, /policy order/);
  const overridden = resolveSelection(
    "review",
    { override: { target: policy.roles.review, reason: "  required provenance  " } },
    policy,
  );
  assert.equal(overridden.source, "override");
  assert.equal(overridden.reason, "required provenance");
  const unavailable = resolveSelection(
    "research",
    { count: 99, diversity: "distinct-models" },
    policy,
  );
  assert.equal(unavailable.selected.length, policy.workerPool.length);
  assert.equal(unavailable.unfulfilled.length, 1);
  assert.throws(
    () =>
      resolveSelection(
        "research",
        { override: { target: policy.roles.research, reason: "" } },
        policy,
      ),
    /specific reason/,
  );
});
