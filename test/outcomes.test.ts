import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkgraphEngine } from "../src/engine.js";
import { GitRepository } from "../src/git.js";
import type { EvidenceItem } from "../src/types.js";

const evidence: EvidenceItem[] = [{ label: "source", observation: "The requested answer is established.", class: "direct" }];

test("non-change outcomes finish with typed evidence and no implementation state", async () => {
  for (const kind of ["answer", "decision", "operation"] as const) {
    const root = await mkdtemp(join(tmpdir(), `pi-workgraph-${kind}-`));
    try {
      const begun = await WorkgraphEngine.begin({ request: "request", projectRoot: root, gitCommonDir: join(root, ".git"), parentSessionId: "parent", parentSessionFile: join(root, "parent.jsonl"), baseCommit: "base", outcome: { kind, statement: "A result.", completionPredicate: "The result is evidenced." } });
      const run = await begun.engine.completeNonChange(kind, "The result is established.", evidence);
      assert.equal(run.phase, "complete");
      assert.equal(run.terminalOutcome?.kind, kind);
      assert.equal(run.nodes.length, 0);
      assert.equal(run.agreement, undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("non-change completion rejects unresolved conflicts and product execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workgraph-outcome-"));
  try {
    const begun = await WorkgraphEngine.begin({ request: "request", projectRoot: root, gitCommonDir: join(root, ".git"), parentSessionId: "parent", parentSessionFile: join(root, "parent.jsonl"), baseCommit: "base", outcome: { kind: "answer", statement: "A result.", completionPredicate: "The result is evidenced." }, milestones: [{ id: "check", description: "Check evidence." }] });
    await assert.rejects(() => begun.engine.completeNonChange("answer", "result", [{ label: "conflict", observation: "sources disagree", class: "conflict" }]), /conflicts and unknowns/);
    await assert.rejects(() => begun.engine.execute({ nodes: [] }), /only available for product-change/);
    const resumed = await WorkgraphEngine.open(begun.run.statePath).load();
    assert.equal(resumed.milestones[0]?.status, "pending");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("trusted capabilities retain stable package identity and exact web tools", async () => {
  const { resolveChildCapabilities, WEB_TOOLS } = await import("../src/capabilities.js");
  const capabilities = await resolveChildCapabilities("discovery", "openai-codex/gpt-test", "/definitely-missing");
  const web = capabilities.find((capability) => capability.id === "web_access");
  assert.ok(web);
  assert.equal(web.packageSource, "npm:pi-web-access@0.14.0");
  assert.deepEqual(web.tools, [...WEB_TOOLS]);
  assert.equal(web.available, false);
  assert.match(web.diagnostic ?? "", /unavailable/);
});
