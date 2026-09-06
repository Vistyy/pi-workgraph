import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This is a real isolated native SQLite filesystem test.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native temporary paths are part of the SQLite test boundary.
import { join } from "node:path";
import test from "node:test";
import { DateTime } from "effect";
import { WorkgraphRegistry } from "../src/registry.js";

function at(milliseconds: number): Date {
  return DateTime.toDate(DateTime.makeUnsafe(milliseconds));
}

await test("SQLite leases fence competing instances, expired unknown owners, renewal and stale release", async () => {
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
      updatedAt: at(0).toISOString(),
    });
    const owner = { sessionId: "one", sessionFile: "/one.jsonl" };
    const lease = a.acquire("fixture", owner, at(0));
    assert.throws(() => b.acquire("fixture", owner, at(1)), /runtime owner/);
    assert.throws(
      () => b.acquire("fixture", { sessionId: "two", sessionFile: "/two.jsonl" }, at(1)),
      /runtime owner/,
    );
    assert.throws(() => b.acquire("fixture", owner, at(31_000), "unknown"), /runtime owner/);
    assert.throws(() => a.renew(lease, at(31_000)), /live lease/);
    const replacement = b.acquire("fixture", owner, at(31_000), "dead");
    assert.notEqual(replacement.token, lease.token);
    a.release(lease);
    b.assertLease(replacement, at(32_000));
    const renewed = b.renew(replacement, at(32_000));
    assert.equal(renewed.expiresAt, at(62_000).toISOString());
    assert.throws(() => a.assertLease(lease, at(32_000)), /live lease/);
    b.release(renewed);
    assert.throws(() => b.assertLease(renewed, at(32_000)), /live lease/);

    b.db
      .prepare("UPDATE runs SET lifecycle=? WHERE run_id=?")
      .run("credential-super-secret", "fixture");
    assert.throws(
      () => b.acquire("fixture", owner, at(33_000)),
      /^Error: Invalid registry lifecycle row\.$/,
    );
    b.db.prepare("UPDATE runs SET lifecycle=? WHERE run_id=?").run("active", "fixture");
    const afterRollback = b.acquire("fixture", owner, at(33_000));
    b.release(afterRollback);
  } finally {
    a.close();
    b.close();
    await rm(parent, { recursive: true, force: true });
  }
});
