import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkgraphEngine, type ChildRunner } from "../src/engine.js";
import { commandAgreement, testOutcome, zeroUsage } from "./helpers.js";

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
  usage: zeroUsage,
  models: [request.guideModel],
  timedOut: false,
});

test("discovery accounts for a failed lane without silently shrinking the requested fan-out", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workgraph-discovery-"));
  try {
    const begun = await WorkgraphEngine.begin({
      request: "request",
      projectRoot: root,
      gitCommonDir: join(root, ".git"),
      parentSessionId: "parent",
      parentSessionFile: join(root, "parent.jsonl"),
      baseCommit: "base",
      outcome: testOutcome.outcome,
      milestones: testOutcome.milestones,
    }, { runChild: failedDiscovery });
    const discovered = await begun.engine.discover({
      topology: "evidence",
      assignments: [{
        id: "history",
        lens: "history",
        objective: "Find decisive history evidence.",
        model: "provider/model",
        thinking: "high",
      }],
    });
    assert.equal(discovered.discoveries[0]!.state, "failed");
    assert.equal(discovered.discoveries[0]!.model, "provider/model");
    const retried = await begun.engine.discover({
      topology: "evidence",
      assignments: [{
        id: "history-retry",
        lens: "history",
        objective: "Retry the decisive history source.",
        model: "provider/model",
        thinking: "high",
        supersedes: ["history"],
      }],
    });
    assert.equal(retried.discoveries.find((record) => record.id === "history")?.state, "superseded");
    assert.equal(retried.discoveries.find((record) => record.id === "history")?.supersededBy, "history-retry");

    const { approvedAt: _approvedAt, ...agreement } = commandAgreement;
    const approved = await begun.engine.recordAgreement(agreement, true, "checkpoint");
    assert.equal(approved.phase, "approved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("substantial discovery fan-out can be reduced by an accounted synthesis child", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workgraph-discovery-"));
  const child: ChildRunner = async (request) => ({
    exitCode: 0,
    sessionFile: join(root, `${request.nodeId}.jsonl`),
    report: {
      kind: "discovery",
      status: "completed",
      summary: request.nodeId === "synthesis" ? "The lanes converge on one owner." : `Candidate ${request.nodeId}.`,
      evidence: [],
      findings: [],
    },
    stderr: "",
    usage: zeroUsage,
    models: [request.guideModel],
    timedOut: false,
  });
  try {
    const begun = await WorkgraphEngine.begin({
      request: "request",
      projectRoot: root,
      gitCommonDir: join(root, ".git"),
      parentSessionId: "parent",
      parentSessionFile: join(root, "parent.jsonl"),
      baseCommit: "base",
      outcome: testOutcome.outcome,
      milestones: testOutcome.milestones,
    }, { runChild: child });
    await begun.engine.discover({
      topology: "replicate",
      assignments: [
        { id: "shape-a", lens: "replication A", objective: "Choose an owner.", model: "provider/a", thinking: "high" },
        { id: "shape-b", lens: "replication B", objective: "Choose an owner.", model: "provider/b", thinking: "high" },
      ],
    });
    const run = await begun.engine.synthesizeDiscovery({
      id: "synthesis",
      sourceIds: ["shape-a", "shape-b"],
      model: "provider/synthesis",
      thinking: "high",
    });
    const synthesis = run.discoveries.find((record) => record.id === "synthesis");
    assert.equal(synthesis?.state, "completed");
    assert.deepEqual(synthesis?.synthesisOf, ["shape-a", "shape-b"]);
    assert.match(synthesis?.report?.summary ?? "", /converge/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preflight-unavailable discovery members become durable dropouts without spawning", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workgraph-discovery-"));
  let calls = 0;
  const child: ChildRunner = async () => {
    calls += 1;
    throw new Error("must not spawn");
  };
  try {
    const begun = await WorkgraphEngine.begin({
      request: "request",
      projectRoot: root,
      gitCommonDir: join(root, ".git"),
      parentSessionId: "parent",
      parentSessionFile: join(root, "parent.jsonl"),
      baseCommit: "base",
      outcome: testOutcome.outcome,
      milestones: testOutcome.milestones,
    }, { runChild: child });
    const run = await begun.engine.discover({
      topology: "replicate",
      assignments: [{
        id: "panel-a",
        lens: "Independent replication 1 of 1",
        objective: "Answer the same question.",
        model: "provider/missing",
        thinking: "high",
        unavailableReason: "Model is unavailable.",
      }],
    });
    assert.equal(calls, 0);
    assert.equal(run.discoveries[0]!.state, "unavailable");
    assert.equal(run.discoveries[0]!.error, "Model is unavailable.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
