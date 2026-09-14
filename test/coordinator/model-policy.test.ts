import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This test owns an isolated policy-file boundary.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Temporary paths identify this test's isolated policy files.
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { Value } from "typebox/value";
import {
  implementationTargets,
  loadModelPolicy,
  loadModelPolicyEffect,
  type ModelPolicy,
  ModelPolicyError,
  resolveSelection,
  SelectionRequestSchema,
} from "../../src/coordinator/model-policy.js";
import { liveLayer } from "../../src/node-platform.js";

const valid: ModelPolicy = {
  roles: {
    research: [
      { model: "fixture/research-first", thinking: "high" },
      { model: "fixture/research-second", thinking: "low" },
    ],
    review: [{ model: "fixture/review", thinking: "medium" }],
    "implementation.guide": { model: "fixture/guide", thinking: "low" },
    "implementation.executor": { model: "fixture/executor", thinking: "xhigh" },
    "consultation.advisor": [{ model: "fixture/advisor", thinking: "off" }],
  },
};

await test("loads only the complete strict user policy shape", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-models-"));
  const path = join(parent, "models.json");

  try {
    await writeFile(path, `${JSON.stringify(valid)}\n`);
    assert.deepEqual(await loadModelPolicy(path), valid);

    for (const invalid of [
      undefined,
      { ...valid, extra: true },
      { ...valid, roles: { ...valid.roles, research: [] } },
      { ...valid, roles: { ...valid.roles, "extra.role": valid.roles.research } },
      {
        ...valid,
        roles: {
          ...valid.roles,
          research: [
            valid.roles.research[0],
            { model: valid.roles.research[0].model, thinking: "minimal" },
          ],
        },
      },
      {
        ...valid,
        roles: {
          ...valid.roles,
          "implementation.guide": { model: "not-a-target", thinking: "high" },
        },
      },
    ]) {
      if (invalid === undefined) {
        await rm(path);
        await assert.rejects(loadModelPolicy(path), /required/);
        await writeFile(path, JSON.stringify(valid));
      } else {
        await writeFile(path, JSON.stringify(invalid));
        await assert.rejects(loadModelPolicy(path), /Invalid Workgraph model policy/);
      }
    }

    const { review: _review, ...rolesWithoutReview } = valid.roles;
    await writeFile(path, JSON.stringify({ ...valid, roles: rolesWithoutReview }));
    await assert.rejects(loadModelPolicy(path), /Invalid Workgraph model policy/);
    await writeFile(path, "{broken");
    await assert.rejects(loadModelPolicy(path), /Invalid JSON/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

await test("policy Effect classifies missing and malformed files", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-policy-errors-"));

  try {
    const missing = await Effect.runPromise(
      Effect.flip(Effect.provide(loadModelPolicyEffect(join(parent, "missing.json")), liveLayer)),
    );

    assert.ok(missing instanceof ModelPolicyError);
    assert.equal(missing.operation, "read");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

await test("selection repeats independently or takes distinct policy-order targets", () => {
  const policy = valid;
  assert.deepEqual(
    resolveSelection("research", { count: 3 }, policy).selected.map((target) => target.model),
    ["fixture/research-first", "fixture/research-first", "fixture/research-first"],
  );
  assert.deepEqual(
    resolveSelection("research", { count: 2, distinctModels: true }, policy).selected.map(
      (target) => target.model,
    ),
    ["fixture/research-first", "fixture/research-second"],
  );
  assert.deepEqual(
    resolveSelection("review", { count: 2 }, policy).selected.map((target) => target.model),
    ["fixture/review", "fixture/review"],
  );
  assert.throws(
    () => resolveSelection("review", { count: 2, distinctModels: true }, policy),
    /only 1/,
  );
  assert.equal(Value.Check(SelectionRequestSchema, { diversity: "distinct-models" }), false);
  // Callers cannot supply arbitrary targets or thinking levels.
  assert.equal(Value.Check(SelectionRequestSchema, { model: "fixture/research-first" }), false);
});

await test("implementation uses its configured executor and only an explicitly requested escalation", () => {
  assert.deepEqual(implementationTargets(valid, false), {
    guide: { model: "fixture/guide", thinking: "low" },
    executor: { model: "fixture/executor", thinking: "xhigh" },
  });
  assert.throws(() => implementationTargets(valid, true), /escalationExecutor/);

  const escalated: ModelPolicy = {
    ...valid,
    roles: {
      ...valid.roles,
      "implementation.escalationExecutor": { model: "fixture/escalation", thinking: "max" },
    },
  };

  assert.deepEqual(implementationTargets(escalated, true), {
    guide: { model: "fixture/guide", thinking: "low" },
    executor: { model: "fixture/escalation", thinking: "max" },
  });
});
