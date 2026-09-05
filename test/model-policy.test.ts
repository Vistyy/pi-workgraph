import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_MODEL_POLICY, loadModelPolicy, roleTargets, setModelRole } from "../src/model-policy.js";

test("the default policy keeps heterogeneous replication and independently assigned assurance roles", () => {
  assert.deepEqual(roleTargets(DEFAULT_MODEL_POLICY, "discovery.replicate").map((target) => target.model), [
    "opencode-go/muse-spark-1.3-contributor",
    "openai-codex/gpt-5.6-terra",
    "opencode-go/glm-5.3-flash",
    "opencode-go/deepseek-v4-flash",
  ]);
  assert.equal(roleTargets(DEFAULT_MODEL_POLICY, "discovery.partition")[0]!.model, "opencode-go/muse-spark-1.3-contributor");
  assert.equal(roleTargets(DEFAULT_MODEL_POLICY, "implementation.guide")[0]!.model, "openai-codex/gpt-5.6-sol");
  assert.equal(roleTargets(DEFAULT_MODEL_POLICY, "implementation.executor")[0]!.model, "openai-codex/gpt-5.6-luna");
  assert.equal(roleTargets(DEFAULT_MODEL_POLICY, "assurance.synthesis")[0]!.model, "openai-codex/gpt-5.6-luna");
  assert.notEqual(roleTargets(DEFAULT_MODEL_POLICY, "assurance.behavior")[0]!.model, roleTargets(DEFAULT_MODEL_POLICY, "assurance.structure")[0]!.model);
});

test("a role override persists independently of external configuration configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workgraph-models-"));
  const path = join(root, "models.json");
  try {
    await setModelRole("assurance.evidence", [{ model: "provider/evidence", thinking: "xhigh" }], path);
    const loaded = await loadModelPolicy(path);
    assert.deepEqual(loaded.roles["assurance.evidence"], [{ model: "provider/evidence", thinking: "xhigh" }]);
    assert.deepEqual(loaded.roles["implementation.executor"], DEFAULT_MODEL_POLICY.roles["implementation.executor"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configured model targets retain their recorded ordered fallbacks", () => {
  const targets = roleTargets(DEFAULT_MODEL_POLICY, "discovery.replicate");
  assert.equal(targets.length, 4);
  assert.deepEqual(targets[0], DEFAULT_MODEL_POLICY.roles["discovery.replicate"][0]);
  assert.notEqual(targets[0], DEFAULT_MODEL_POLICY.roles["discovery.replicate"][0]);
});
