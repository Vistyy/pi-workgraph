import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkgraphEngine, type ChildRunner } from "../src/engine.js";

const failedDiscovery: ChildRunner = async (request) => ({
  exitCode: 0,
  sessionFile: join(request.sessionDir, "failed.jsonl"),
  report: {
    kind: "discovery",
    status: "failed",
    summary: "Evidence unavailable.",
    evidence: [],
    findings: [],
  },
  stderr: "",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  models: [request.guideModel],
  timedOut: false,
});

test("a typed failed discovery cannot become an approved envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workgraph-discovery-"));
  try {
    const begun = await WorkgraphEngine.begin({
      request: "request",
      projectRoot: root,
      gitCommonDir: join(root, ".git"),
      parentSessionId: "parent",
      parentSessionFile: join(root, "parent.jsonl"),
      baseCommit: "base",
    }, { runChild: failedDiscovery });
    const discovered = await begun.engine.discover({
      investigations: [{ id: "evidence", lens: "evidence", objective: "Find decisive evidence." }],
      model: "provider/model",
      thinking: "high",
    });
    assert.equal(discovered.discoveries[0]!.state, "failed");
    await assert.rejects(() => begun.engine.recordAgreement({
      outcome: "outcome",
      nonGoals: [],
      reuseDecision: "reuse",
      structure: "structure",
      expectedScale: "small",
      verificationBoundary: "boundary",
      verificationCommands: [],
      unresolvedDecisions: [],
    }, true, "checkpoint"), /discovery failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
