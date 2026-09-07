import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This test verifies the native atomic policy-file boundary.
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native temporary paths are part of the policy-file test boundary.
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
  DEFAULT_MODEL_POLICY,
  loadModelPolicy,
  loadModelPolicyEffect,
  ModelPolicyError,
  resolveSelection,
  setModelList,
  setModelRole,
} from "../src/model-policy.js";
import { liveLayer } from "../src/node-platform.js";

await test("policy defaults, legacy reads, and independent role-list writes use isolated paths", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-models-"));
  const path = join(parent, "models.json");
  try {
    assert.deepEqual(DEFAULT_MODEL_POLICY, {
      version: 4,
      roles: {
        research: [{ model: "openai-codex/gpt-5.6-luna", thinking: "high" }],
        "implementation.guide": { model: "openai-codex/gpt-6-astra", thinking: "low" },
        "implementation.executor": { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
        review: [
          { model: "openai-codex/gpt-5.6-terra", thinking: "high" },
          { model: "opencode-go/deepseek-v4-flash", thinking: "high" },
          { model: "opencode-go/glm-5.3-flash", thinking: "high" },
        ],
      },
    });
    assert.deepEqual(await loadModelPolicy(path), DEFAULT_MODEL_POLICY);

    const legacyV1 = JSON.stringify({
      version: 1,
      roles: {
        "discovery.evidence": [{ model: "fixture/research", thinking: "low" }],
        "implementation.guide": [{ model: "fixture/guide", thinking: "high" }],
        "implementation.executor": [{ model: "fixture/executor", thinking: "medium" }],
        "verification.product": [{ model: "fixture/reviewer", thinking: "off" }],
      },
    });
    await writeFile(path, legacyV1);
    const mappedV1 = await loadModelPolicy(path);
    assert.deepEqual(mappedV1.roles.research, [{ model: "fixture/research", thinking: "low" }]);
    assert.deepEqual(mappedV1.roles.review, [{ model: "fixture/reviewer", thinking: "off" }]);
    assert.equal(mappedV1.roles["implementation.guide"].model, "fixture/guide");
    assert.equal(mappedV1.roles["implementation.executor"].model, "fixture/executor");
    assert.equal(await readFile(path, "utf8"), legacyV1);

    const legacyV3 = JSON.stringify({
      version: 3,
      roles: {
        research: { model: "fixture/research-default", thinking: "low" },
        "implementation.guide": { model: "fixture/guide", thinking: "high" },
        "implementation.executor": { model: "fixture/executor", thinking: "medium" },
        review: { model: "fixture/review-default", thinking: "off" },
      },
      workerPool: [
        { model: "fixture/shared-first", thinking: "high" },
        { model: "fixture/shared-second", thinking: "medium" },
        { model: "fixture/research-default", thinking: "low" },
      ],
    });
    await writeFile(path, legacyV3);
    const mappedV3 = await loadModelPolicy(path);
    assert.deepEqual(mappedV3.roles.research, [
      { model: "fixture/research-default", thinking: "low" },
      { model: "fixture/shared-first", thinking: "high" },
      { model: "fixture/shared-second", thinking: "medium" },
    ]);
    assert.deepEqual(mappedV3.roles.review, [
      { model: "fixture/review-default", thinking: "off" },
      { model: "fixture/shared-first", thinking: "high" },
      { model: "fixture/shared-second", thinking: "medium" },
      { model: "fixture/research-default", thinking: "low" },
    ]);
    assert.equal(await readFile(path, "utf8"), legacyV3);

    await setModelList(
      "review",
      [
        { model: "fixture/review-first", thinking: "high" },
        { model: "fixture/review-second", thinking: "low" },
      ],
      path,
    );
    await setModelRole(
      "implementation.guide",
      { model: "fixture/guide-independent", thinking: "low" },
      path,
    );
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const written = await loadModelPolicy(path);
    assert.deepEqual(written.roles.review, [
      { model: "fixture/review-first", thinking: "high" },
      { model: "fixture/review-second", thinking: "low" },
    ]);
    assert.equal(written.roles.research[0].model, "fixture/research-default");
    assert.equal(written.roles["implementation.guide"].model, "fixture/guide-independent");
    assert.equal(written.version, 4);

    await assert.rejects(setModelList("research", [], path), /Invalid model list/);
    await writeFile(path, '{"version":4,"roles":{"research":[]}}');
    await assert.rejects(loadModelPolicy(path), /Invalid model list for research/);
    await writeFile(
      path,
      '{"version":4,"roles":{"research":{"model":"fixture/not-a-list","thinking":"high"}}}',
    );
    await assert.rejects(loadModelPolicy(path), /Invalid model list for research/);
    await writeFile(path, '{"version":3,"roles":{},"workerPool":[]}');
    await assert.rejects(loadModelPolicy(path), /Invalid Workgraph worker pool/);
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

await test("policy Effect classifies malformed data separately from provider failures", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-policy-errors-"));
  const malformed = join(parent, "malformed.json");
  try {
    await writeFile(malformed, '{"credential":"not-retained"');
    const parseFailure = await Effect.runPromise(
      Effect.flip(Effect.provide(loadModelPolicyEffect(malformed), liveLayer)),
    );
    assert.ok(parseFailure instanceof ModelPolicyError);
    assert.equal(parseFailure.operation, "parse");
    assert.equal(parseFailure.message.includes("not-retained"), false);

    const providerFailure = await Effect.runPromise(
      Effect.flip(Effect.provide(loadModelPolicyEffect(parent), liveLayer)),
    );
    assert.equal(providerFailure._tag, "PlatformError");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

await test("selection is role-owned, ordered, and explicit about insufficient diversity", () => {
  const policy = structuredClone(DEFAULT_MODEL_POLICY);
  const repeatedResearch = resolveSelection("research", { count: 3 }, policy);
  assert.deepEqual(
    repeatedResearch.selected.map((target) => target.model),
    ["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-luna"],
  );
  const distinctResearch = resolveSelection(
    "research",
    { count: 2, diversity: "distinct-models" },
    policy,
  );
  assert.deepEqual(
    distinctResearch.selected.map((target) => target.model),
    ["openai-codex/gpt-5.6-luna"],
  );
  assert.equal(distinctResearch.unfulfilled.length, 1);

  const distinctReview = resolveSelection(
    "review",
    { count: 3, diversity: "distinct-models" },
    policy,
  );
  assert.deepEqual(
    distinctReview.selected.map((target) => target.model),
    ["openai-codex/gpt-5.6-terra", "opencode-go/deepseek-v4-flash", "opencode-go/glm-5.3-flash"],
  );
  assert.equal(distinctReview.source, "policy");
  assert.match(distinctReview.reason, /policy order/);
  const unavailableReview = resolveSelection(
    "review",
    { count: 4, diversity: "distinct-models" },
    policy,
  );
  assert.equal(unavailableReview.selected.length, 3);
  assert.equal(unavailableReview.unfulfilled.length, 1);

  policy.roles.research = [
    { model: "fixture/research-first", thinking: "low" },
    { model: "fixture/research-second", thinking: "high" },
  ];
  policy.roles.review = [{ model: "fixture/review-only", thinking: "high" }];
  const isolated = resolveSelection("research", { count: 3, diversity: "distinct-models" }, policy);
  assert.deepEqual(
    isolated.selected.map((target) => target.model),
    ["fixture/research-first", "fixture/research-second"],
  );
  assert.equal(
    isolated.selected.some((target) => target.model === "fixture/review-only"),
    false,
  );

  const overridden = resolveSelection(
    "review",
    { override: { target: policy.roles.review[0], reason: "  required provenance  " } },
    policy,
  );
  assert.equal(overridden.source, "override");
  assert.equal(overridden.reason, "required provenance");
  assert.throws(
    () =>
      resolveSelection(
        "research",
        { override: { target: policy.roles.research[0], reason: "" } },
        policy,
      ),
    /specific reason/,
  );
});
