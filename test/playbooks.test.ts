import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkgraphEngine } from "../src/engine.js";
import { listPlaybooks, loadPlaybook, PLAYBOOKS } from "../src/playbooks.js";
import { commandAgreement, testPlaybook } from "./helpers.js";

test("the catalog discovers every substantive Workgraph playbook", async () => {
  const listed = listPlaybooks();
  assert.equal(listed.length, 16);
  assert.deepEqual(new Set(listed.map((item) => item.family)), new Set(["understand", "decide", "change", "operate"]));
  for (const definition of PLAYBOOKS) {
    const loaded = await loadPlaybook(definition.id);
    assert.equal(loaded.definition.id, definition.id);
    assert.match(loaded.content, /## Completion predicate/);
    assert.match(loaded.content, /## (Failure|Implementation|Agreement|Correction)/);
    assert.ok(loaded.content.length > 2_500, `${definition.id} is still only a skeleton`);
    for (const step of definition.steps) assert.match(loaded.content, new RegExp(`\\x60${step}\\x60`));
  }
});

test("playbook progress and explicit skip reasons survive a durable reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workgraph-playbook-"));
  try {
    const begun = await WorkgraphEngine.begin({
      request: "request",
      projectRoot: root,
      gitCommonDir: join(root, ".git"),
      parentSessionId: "parent",
      parentSessionFile: join(root, "parent.jsonl"),
      baseCommit: "base",
      playbook: testPlaybook,
    });
    await begun.engine.recordProgress("understand", "completed");
    await assert.rejects(() => begun.engine.recordProgress("design", "skipped"), /requires a reason/);
    await begun.engine.recordProgress("design", "skipped", "The ownership is already enforced by one existing boundary.");
    await begun.engine.store.update((run) => {
      run.agreement = commandAgreement;
      run.productVerification = { revision: run.composedCommit, method: "commands", state: "completed", commands: [] };
      run.phase = "awaiting_assurance";
    });
    await assert.rejects(() => begun.engine.assure({
      reviewers: [
        { responsibility: "behavior", model: "provider/behavior", thinking: "high" },
        { responsibility: "structure", model: "provider/structure", thinking: "high" },
        { responsibility: "evidence", model: "provider/evidence", thinking: "high" },
      ],
      synthesis: { model: "provider/synthesis", thinking: "high" },
    }), /Settle every playbook step/);
    const restored = await WorkgraphEngine.open(begun.run.statePath).load();
    assert.equal(restored.playbook.completionPredicate, testPlaybook.completionPredicate);
    assert.equal(restored.playbook.steps[0]!.status, "completed");
    assert.deepEqual(restored.playbook.steps[1], {
      id: "design",
      status: "skipped",
      reason: "The ownership is already enforced by one existing boundary.",
      at: restored.playbook.steps[1]!.at,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
