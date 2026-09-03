import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expandDiscovery } from "../extensions/coordinator.js";
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

test("a role override persists independently of PStack configuration", async () => {
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

test("replicated discovery sends one question to diverse models and marks unavailable members", async () => {
  const ctx = {
    modelRegistry: {
      getAvailable: () => [
        { provider: "provider-a", id: "model-a" },
        { provider: "provider-b", id: "model-b" },
      ],
    },
  } as unknown as ExtensionContext;
  const assignments = await expandDiscovery({
    topology: "replicate",
    question: "Which ownership shape best preserves the invariant?",
    idPrefix: "shape",
    panelSize: 3,
    models: [
      { model: "provider-a/model-a", thinking: "high" },
      { model: "provider-b/model-b", thinking: "high" },
      { model: "provider-c/model-c", thinking: "high" },
    ],
  }, ctx, undefined);
  assert.deepEqual(assignments.map((item) => item.objective), [
    "Which ownership shape best preserves the invariant?",
    "Which ownership shape best preserves the invariant?",
    "Which ownership shape best preserves the invariant?",
  ]);
  assert.deepEqual(assignments.map((item) => item.model), ["provider-a/model-a", "provider-b/model-b", "provider-c/model-c"]);
  assert.equal(assignments[2]!.unavailableReason, "replicated lane 3 model is unavailable: provider-c/model-c");
});
