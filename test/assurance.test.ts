import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkgraphEngine, type ChildRunner } from "../src/engine.js";
import type { EnvelopeImpact, WorkerReport } from "../src/types.js";

const agreement = {
  outcome: "outcome",
  nonGoals: [],
  reuseDecision: "reuse",
  structure: "structure",
  expectedScale: "small",
  verificationBoundary: "boundary",
  verificationCommands: [],
  unresolvedDecisions: [],
  approvedAt: new Date(0).toISOString(),
};

async function runAssurance(impact: EnvelopeImpact, status: WorkerReport["status"] = "completed") {
  const root = await mkdtemp(join(tmpdir(), "pi-workgraph-assurance-"));
  const report: WorkerReport = {
    kind: "assurance",
    status,
    summary: "Finding",
    evidence: [],
    findings: [{ severity: "error", title: "Issue", detail: "Correction required.", envelopeImpact: impact }],
  };
  const child: ChildRunner = async () => ({
    exitCode: 0,
    sessionFile: join(root, "assurance.jsonl"),
    report,
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    models: ["provider/model"],
    timedOut: false,
  });
  const begun = await WorkgraphEngine.begin({
    request: "request",
    projectRoot: root,
    gitCommonDir: join(root, ".git"),
    parentSessionId: "parent",
    parentSessionFile: join(root, "parent.jsonl"),
    baseCommit: "base",
  }, { runChild: child });
  await begun.engine.store.update((run) => {
    run.agreement = agreement;
    run.phase = "awaiting_assurance";
  });
  try {
    return await begun.engine.assure({ model: "provider/model", thinking: "high" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("assurance routes an internal correction back into the graph", async () => {
  assert.equal((await runAssurance("none")).phase, "revision_required");
});

test("assurance serializes an envelope-changing finding as a human decision", async () => {
  assert.equal((await runAssurance("security")).phase, "needs_decision");
});

test("assurance does not accept a typed failed report", async () => {
  assert.equal((await runAssurance("none", "failed")).phase, "failed");
});
