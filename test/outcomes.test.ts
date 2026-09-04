import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkgraphEngine } from "../src/engine.js";
import { commandAgreement, testOutcome } from "./helpers.js";
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

test("conversational agreement persists the exact subsequent user decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workgraph-agreement-"));
  try {
    const begun = await WorkgraphEngine.begin({ request: "request", projectRoot: root, gitCommonDir: join(root, ".git"), parentSessionId: "parent", parentSessionFile: join(root, "parent.jsonl"), baseCommit: "base", outcome: testOutcome.outcome });
    const { approvedAt: _approvedAt, ...draft } = commandAgreement;
    await begun.engine.store.transition("awaiting_agreement", "Discovery is ready for the agreement proposal.");
    const proposed = await begun.engine.proposeAgreement(draft, "Plan summary");
    assert.equal(proposed.phase, "awaiting_agreement");
    assert.deepEqual(proposed.agreementProposal, draft);
    const approved = await begun.engine.recordAgreement(draft, true, "approved");
    assert.equal(approved.phase, "approved");
    assert.equal(approved.humanDecisions[0]?.prompt, "approved");
    assert.equal(approved.agreementProposal, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
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

test("normal child launches do not inject a restricted resource selection", async () => {
  const { resolveChildCapabilities, WEB_TOOLS } = await import("../src/capabilities.js");
  const root = await mkdtemp(join(tmpdir(), "pi-workgraph-capability-"));
  try {
    await mkdir(join(root, "node_modules", "pi-web-access"), { recursive: true });
    await writeFile(join(root, "node_modules", "pi-web-access", "package.json"), JSON.stringify({ name: "pi-web-access", version: "0.14.0", pi: { extensions: ["./index.ts"] } }));
    const capabilities = await resolveChildCapabilities("discovery", "provider/model", root);
    const web = capabilities.find((capability) => capability.id === "web_access");
    assert.ok(web);
    assert.equal(web.packageSource, "npm:pi-web-access@0.14.0");
    assert.equal(web.resourceIdentity, "pi-web-access:./index.ts");
    assert.equal(web.available, true);
    assert.deepEqual(web.tools, [...WEB_TOOLS]);
    const { buildChildArguments } = await import("../src/pi-process.js");
    const args = buildChildArguments({ mode: "discovery", guideModel: "provider/model", guideThinking: "high" }, "/tmp/session.jsonl", capabilities);
    assert.equal(args.includes("--no-extensions"), false);
    assert.equal(args.includes("--tools"), false);
    assert.equal(args.includes(join(root, "node_modules", "pi-web-access", "index.ts")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("trusted capability and milestone diagnostics remain explicit", async () => {
  const { resolveChildCapabilities } = await import("../src/capabilities.js");
  const capabilities = await resolveChildCapabilities("discovery", "openai-codex/gpt-test", "/definitely-missing");
  assert.equal(capabilities.find((capability) => capability.id === "web_access")?.available, false);
  assert.match(capabilities.find((capability) => capability.id === "web_access")?.diagnostic ?? "", /unavailable/);
  const root = await mkdtemp(join(tmpdir(), "pi-workgraph-milestone-"));
  try {
    await assert.rejects(() => WorkgraphEngine.begin({ request: "request", projectRoot: root, gitCommonDir: join(root, ".git"), parentSessionId: "parent", parentSessionFile: join(root, "parent.jsonl"), baseCommit: "base", outcome: { kind: "answer", statement: "answer", completionPredicate: "evidence" }, milestones: [{ id: "bad", description: "  " }] }), /Milestone descriptions/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
