import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkgraphRegistry } from "../src/registry.js";

test("SQLite leases fence competing instances, expired unknown owners, renewal and stale release", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-lease-"));
  const a = new WorkgraphRegistry(join(parent, "registry.sqlite"));
  const b = new WorkgraphRegistry(a.path);
  try {
    a.indexWorkstream({
      runId: "fixture",
      statePath: join(parent, "state.json"),
      projectRoot: parent,
      gitCommonDir: parent,
      lifecycle: "active",
      updatedAt: new Date(0).toISOString(),
    });
    const owner = { sessionId: "one", sessionFile: "/one.jsonl" };
    const lease = a.acquire("fixture", owner, new Date(0));
    assert.throws(
      () => b.acquire("fixture", owner, new Date(1)),
      /runtime owner/,
    );
    assert.throws(
      () =>
        b.acquire(
          "fixture",
          { sessionId: "two", sessionFile: "/two.jsonl" },
          new Date(1),
        ),
      /runtime owner/,
    );
    assert.throws(
      () => b.acquire("fixture", owner, new Date(31_000), "unknown"),
      /runtime owner/,
    );
    assert.throws(() => a.renew(lease, new Date(31_000)), /live lease/);
    const replacement = b.acquire("fixture", owner, new Date(31_000), "dead");
    assert.notEqual(replacement.token, lease.token);
    a.release(lease);
    b.assertLease(replacement, new Date(32_000));
    const renewed = b.renew(replacement, new Date(32_000));
    assert.equal(renewed.expiresAt, new Date(62_000).toISOString());
    assert.throws(() => a.assertLease(lease, new Date(32_000)), /live lease/);
    b.release(renewed);
    assert.throws(() => b.assertLease(renewed, new Date(32_000)), /live lease/);
  } finally {
    a.close();
    b.close();
    await rm(parent, { recursive: true, force: true });
  }
});
