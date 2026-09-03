import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkgraphEngine, type AssuranceInput, type ChildRunner } from "../src/engine.js";
import type { GitRepository } from "../src/git.js";
import type { AssuranceFinding, EnvelopeImpact, WorkerReport } from "../src/types.js";
import {
  assuranceFinding,
  assuranceReview,
  assuranceSynthesis,
  commandAgreement,
  testPlaybook,
  zeroUsage,
} from "./helpers.js";

const assignments: AssuranceInput = {
  reviewers: [
    { responsibility: "behavior", model: "provider/behavior", thinking: "high" },
    { responsibility: "structure", model: "provider/structure", thinking: "high" },
    { responsibility: "evidence", model: "provider/evidence", thinking: "high" },
  ],
  synthesis: { model: "provider/synthesis", thinking: "high" },
};

async function runAssurance(
  impact: EnvelopeImpact,
  reviewStatus: WorkerReport["status"] = "completed",
  synthesisFinding?: AssuranceFinding,
  firstBehaviorInconclusive = false,
) {
  const root = await mkdtemp(join(tmpdir(), "pi-workgraph-assurance-"));
  const finding = assuranceFinding("behavior-1", impact);
  const calls = new Map<string, number>();
  const child: ChildRunner = async (request) => {
    calls.set(request.mode === "assurance_review" ? request.responsibility! : request.mode, (calls.get(request.mode === "assurance_review" ? request.responsibility! : request.mode) ?? 0) + 1);
    let report: WorkerReport;
    if (request.mode === "assurance_review") {
      const review = assuranceReview(request.responsibility as "behavior" | "structure" | "evidence", request.responsibility === "behavior" ? [finding] : []);
      report = request.responsibility === "behavior"
        ? firstBehaviorInconclusive && calls.get("behavior") === 1
          ? { ...review, recommendation: "inconclusive", findings: [], summary: "Evidence was inconclusive." }
          : { ...review, status: reviewStatus }
        : review;
    } else if (request.mode === "assurance_synthesis") {
      report = assuranceSynthesis([synthesisFinding ?? finding]);
    } else {
      throw new Error(`Unexpected mode ${request.mode}`);
    }
    return {
      exitCode: 0,
      sessionFile: join(root, `${request.nodeId}.jsonl`),
      report,
      stderr: "",
      usage: zeroUsage,
      models: [request.guideModel],
      timedOut: false,
    };
  };
  const repository = {
    async assertClean() {},
    async head() { return "base"; },
  } as unknown as GitRepository;
  const begun = await WorkgraphEngine.begin({
    request: "request",
    projectRoot: root,
    gitCommonDir: join(root, ".git"),
    parentSessionId: "parent",
    parentSessionFile: join(root, "parent.jsonl"),
    baseCommit: "base",
    playbook: testPlaybook,
  }, { runChild: child, repository });
  await begun.engine.store.update((run) => {
    run.agreement = commandAgreement;
    run.productVerification = { revision: "base", method: "commands", state: "completed", commands: [] };
    run.phase = "awaiting_assurance";
    for (const step of run.playbook.steps) step.status = "completed";
  });
  try {
    const assured = await begun.engine.assure(assignments);
    return { engine: begun.engine, assured, finding, calls };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function judgeAndCleanup(
  result: Awaited<ReturnType<typeof runAssurance>>,
  finding: AssuranceFinding,
): Promise<string> {
  try {
    const judged = await result.engine.judgeAssurance({
      judgments: [{ findingId: finding.id, disposition: "accept", reason: "The evidence establishes a material invariant violation." }],
    });
    return judged.phase;
  } finally {
    await rm(result.assured.projectRoot, { recursive: true, force: true });
  }
}

test("coordinator judgment routes an accepted internal correction back into the graph", async () => {
  const result = await runAssurance("none");
  assert.equal(result.assured.phase, "awaiting_judgment");
  await assert.rejects(() => result.engine.judgeAssurance({ judgments: [] }), /account for every assurance finding/);
  assert.equal(await judgeAndCleanup(result, result.finding), "revision_required");
});

test("coordinator judgment serializes an accepted envelope-changing finding", async () => {
  const result = await runAssurance("security");
  assert.equal(await judgeAndCleanup(result, result.finding), "needs_decision");
});

test("synthesis cannot change or invent a responsibility finding", async () => {
  const original = assuranceFinding("behavior-1", "none");
  const changed = { ...original, consequence: "A different consequence invented during synthesis." };
  const result = await runAssurance("none", "completed", changed);
  try {
    assert.equal(result.assured.phase, "assurance_inconclusive");
    assert.match(result.assured.assurance?.synthesis?.error ?? "", /changed candidate finding/);
  } finally {
    await rm(result.assured.projectRoot, { recursive: true, force: true });
  }
});

test("retrying inconclusive assurance reruns only that responsibility before synthesis", async () => {
  const result = await runAssurance("none", "completed", undefined, true);
  try {
    assert.equal(result.assured.phase, "assurance_inconclusive");
    const resumed = await result.engine.assure(assignments);
    assert.equal(resumed.phase, "awaiting_judgment");
    assert.equal(result.calls.get("behavior"), 2);
    assert.equal(result.calls.get("structure"), 1);
    assert.equal(result.calls.get("evidence"), 1);
    assert.equal(result.calls.get("assurance_synthesis"), 1);
  } finally {
    await rm(result.assured.projectRoot, { recursive: true, force: true });
  }
});

test("a required assurance reviewer failure produces an inconclusive run without synthesis", async () => {
  const result = await runAssurance("none", "failed");
  try {
    assert.equal(result.assured.phase, "assurance_inconclusive");
    assert.equal(result.assured.assurance?.synthesis, undefined);
  } finally {
    await rm(result.assured.projectRoot, { recursive: true, force: true });
  }
});
