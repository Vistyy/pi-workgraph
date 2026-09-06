import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- These regressions exercise the production Node artifact boundary with real bytes.
import { lstat, readdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Retained artifact path assertions use host path semantics.
import { join } from "node:path";
import test from "node:test";
import { type ArtifactRetentionIo, nodeArtifactRetentionIo } from "../src/workstream-runtime.js";
import { artifactFixture } from "./artifact-fixture.js";

void test("reconciliation resumes a settled retry immediately after its pending checkpoint", async () => {
  const f = await artifactFixture();
  try {
    const before = await f.store.load();
    const originalReport = structuredClone(before.results[0]);
    await f.store.blockArtifactRetention(f.attemptId, "simulated first interruption");
    await f.store.retryArtifactRetention(f.attemptId);

    const runtime = f.runtime();
    const recovered = await runtime.reconcile();
    const attempt = recovered.attempts[0];
    const result = recovered.results[0];
    assert.equal(attempt?.artifactRetention?.state, "completed");
    assert.equal(attempt?.cleanup?.state, "completed");
    assert.deepEqual({ ...result, artifacts: [] }, originalReport);
    assert.equal(
      await readFile(result?.artifacts[0]?.reference ?? "", "utf8"),
      "retained evidence\n",
    );
    assert.equal(f.workers.cleanupCount, 1);
  } finally {
    await f.dispose();
  }
});

void test("owned partial staging from an interrupted copy is quarantined and rebuilt", async () => {
  const f = await artifactFixture();
  try {
    let partialPath = "";
    const interrupted: ArtifactRetentionIo = {
      copy: async ({ target }) => {
        partialPath = target;
        await writeFile(target, "partial\n");
        throw new Error("copy interrupted after partial bytes");
      },
      publish: (input) => nodeArtifactRetentionIo.publish(input),
    };
    const first = f.runtime(interrupted);
    let state = await first.reconcile();
    assert.equal(state.attempts[0]?.artifactRetention?.state, "blocked");
    assert.equal(await readFile(partialPath, "utf8"), "partial\n");
    await first.stop();

    const retry = f.runtime();
    state = await retry.recoverAttempt({
      attemptId: f.attemptId,
      action: "retry",
      reason: "Rebuild the exact runtime-owned partial staging payload.",
    });
    assert.equal(state.attempts[0]?.artifactRetention?.state, "completed");
    const stagingRoot = state.attempts[0]?.artifactRetention?.stagingRoot ?? "";
    assert.equal(
      (await readdir(stagingRoot)).some((name) => name.includes(".quarantine-")),
      true,
    );
    assert.equal(
      await readFile(state.results[0]?.artifacts[0]?.reference ?? "", "utf8"),
      "retained evidence\n",
    );
  } finally {
    await f.dispose();
  }
});

void test("unsafe, unproven, and raced paths are preserved rather than removed or overwritten", async () => {
  const unproven = await artifactFixture();
  try {
    let staged = "";
    const interrupted: ArtifactRetentionIo = {
      copy: async ({ target }) => {
        staged = target;
        await writeFile(target, "partial without durable ownership\n");
        throw new Error("copy interrupted");
      },
      publish: (input) => nodeArtifactRetentionIo.publish(input),
    };
    const first = unproven.runtime(interrupted);
    let state = await first.reconcile();
    await first.stop();
    const stagingRoot = state.attempts[0]?.artifactRetention?.stagingRoot ?? "";
    const marker = (await readdir(stagingRoot)).find((name) => name.endsWith(".owner.json"));
    if (marker === undefined) assert.fail("Owned staging marker was not created.");
    await unlink(join(stagingRoot, marker));
    const retry = unproven.runtime();
    await retry.recoverAttempt({
      attemptId: unproven.attemptId,
      action: "retry",
      reason: "An unproven payload must remain untouched.",
    });
    state = await unproven.store.load();
    assert.equal(state.attempts[0]?.artifactRetention?.state, "blocked");
    assert.equal(await readFile(staged, "utf8"), "partial without durable ownership\n");
  } finally {
    await unproven.dispose();
  }

  const unsafe = await artifactFixture();
  try {
    let staged = "";
    const symlinked: ArtifactRetentionIo = {
      copy: async ({ source, target }) => {
        staged = target;
        await symlink(source, target);
        throw new Error("copy interrupted with unsafe staging");
      },
      publish: (input) => nodeArtifactRetentionIo.publish(input),
    };
    const runtime = unsafe.runtime(symlinked);
    await runtime.reconcile();
    await runtime.recoverAttempt({
      attemptId: unsafe.attemptId,
      action: "retry",
      reason: "Unsafe staging must remain for inspection.",
    });
    const state = await unsafe.store.load();
    assert.equal(state.attempts[0]?.artifactRetention?.state, "blocked");
    assert.equal((await lstat(staged)).isSymbolicLink(), true);
  } finally {
    await unsafe.dispose();
  }

  const raced = await artifactFixture();
  try {
    let target = "";
    const racingPublisher: ArtifactRetentionIo = {
      copy: (input) => nodeArtifactRetentionIo.copy(input),
      publish: async (input) => {
        target = input.target;
        await writeFile(target, "foreign bytes\n");
        await nodeArtifactRetentionIo.publish(input);
      },
    };
    const runtime = raced.runtime(racingPublisher);
    await runtime.reconcile();
    let state = await raced.store.load();
    assert.equal(state.attempts[0]?.artifactRetention?.state, "blocked");
    assert.equal(await readFile(target, "utf8"), "foreign bytes\n");
    await runtime.recoverAttempt({
      attemptId: raced.attemptId,
      action: "retry",
      reason: "Inspect the raced destination without overwriting it.",
    });
    state = await raced.store.load();
    assert.equal(state.attempts[0]?.artifactRetention?.state, "blocked");
    assert.equal(await readFile(target, "utf8"), "foreign bytes\n");
  } finally {
    await raced.dispose();
  }
});

void test("intent and lease loss after copy fence publication at the actual boundary", async () => {
  const stale = await artifactFixture();
  try {
    const input = (await stale.store.load()).inputs[0];
    assert.ok(input);
    const losingIntent: ArtifactRetentionIo = {
      copy: async (copy) => {
        await nodeArtifactRetentionIo.copy(copy);
        await stale.store.reviseIntent({
          authorityReceiptId: input.id,
          statement: "Supersede the probe before publication.",
          constraints: ["Do not publish the old probe."],
        });
      },
      publish: (publish) => nodeArtifactRetentionIo.publish(publish),
    };
    const runtime = stale.runtime(losingIntent);
    await runtime.reconcile();
    const state = await stale.store.load();
    const retention = state.attempts[0]?.artifactRetention;
    assert.equal(retention?.state, "blocked");
    await assert.rejects(readFile(join(retention?.destinationRoot ?? "", "probe.txt")), /ENOENT/);
  } finally {
    await stale.dispose();
  }

  const lostLease = await artifactFixture();
  try {
    const losingLease: ArtifactRetentionIo = {
      copy: async (copy) => {
        await nodeArtifactRetentionIo.copy(copy);
        lostLease.registry.db.prepare("DELETE FROM leases WHERE run_id=?").run("artifact-recovery");
      },
      publish: (publish) => nodeArtifactRetentionIo.publish(publish),
    };
    const runtime = lostLease.runtime(losingLease);
    await assert.rejects(runtime.reconcile(), /lease|owner/i);
    const state = await lostLease.store.load();
    const retention = state.attempts[0]?.artifactRetention;
    assert.equal(retention?.state, "pending");
    await assert.rejects(readFile(join(retention?.destinationRoot ?? "", "probe.txt")), /ENOENT/);
  } finally {
    await lostLease.dispose();
  }
});

void test("legacy pending and blocked cleanup preserve ignored required output and report history", async () => {
  for (const cleanupState of ["pending", "blocked"] as const) {
    const f = await artifactFixture({ legacyCleanup: cleanupState });
    try {
      const before = await f.store.load();
      const result = structuredClone(before.results[0]);
      const history = structuredClone(before.attempts[0]?.attentionHistory);
      const runtime = f.runtime();
      await assert.rejects(
        runtime.recoverAttempt({
          attemptId: f.attemptId,
          action: "retry",
          reason: "Legacy evidence cannot be reconstructed.",
        }),
        /no independently retained report and source checkpoint/,
      );
      if (cleanupState === "pending") {
        await assert.rejects(
          runtime.perform(() => f.store.markWorkerClosed(f.attemptId)),
          /no independently retained report and source checkpoint/,
        );
        await runtime.reconcile();
      } else {
        await assert.rejects(
          runtime.perform(() => f.store.retryCleanup(f.attemptId)),
          /no independently retained report and source checkpoint/,
        );
      }
      const after = await f.store.load();
      assert.deepEqual(after.results[0], result);
      assert.deepEqual(after.attempts[0]?.attentionHistory, history);
      assert.equal(after.attempts[0]?.cleanup?.state, cleanupState);
      assert.equal(await readFile(join(f.sourceRoot, "probe.txt"), "utf8"), "retained evidence\n");
      assert.equal(await f.repository.status(f.sourceRoot), "");
      assert.equal(f.workers.cleanupCount, 0);
    } finally {
      await f.dispose();
    }
  }
});
