import assert from "node:assert/strict";
import test from "node:test";
import { addNodes, allNodesComposed, claimsOverlap, readyWave, transitionNode } from "../src/scheduler.js";
import type { WorkNodeSpec, WorkgraphRun } from "../src/types.js";

const baseSpec = (id: string, claimedPaths: string[], dependencies: string[] = []): WorkNodeSpec => ({
  id,
  objective: `Implement ${id}`,
  claimedPaths,
  dependencies,
  verificationCommands: [],
  supersedes: [],
  guideModel: "provider/guide",
  executorModel: "provider/executor",
  guideThinking: "high",
  executorThinking: "high",
});

function runFixture(): WorkgraphRun {
  return {
    version: 1,
    revision: 0,
    runId: "run",
    request: "request",
    projectRoot: "/repo",
    gitCommonDir: "/repo/.git",
    statePath: "/repo/.git/pi-workgraph/runs/run/state.json",
    parentSessionId: "session",
    parentSessionFile: "/session.jsonl",
    phase: "approved",
    baseCommit: "base",
    composedCommit: "base",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    discoveries: [],
    nodes: [],
    composition: [],
    humanDecisions: [],
    transitions: [],
    globalVerification: [],
  };
}

test("readyWave selects deterministic non-overlapping nodes whose dependencies are composed", () => {
  const run = runFixture();
  addNodes(run, [
    baseSpec("alpha", ["src/a"]),
    baseSpec("beta", ["src/b"]),
    baseSpec("alpha_child", ["src/a/child"], ["alpha"]),
    baseSpec("docs", ["docs"]),
  ]);

  assert.deepEqual(readyWave(run, 3).map((node) => node.id), ["alpha", "beta", "docs"]);
  transitionNode(run.nodes[0]!, "running");
  transitionNode(run.nodes[0]!, "completed");
  transitionNode(run.nodes[0]!, "composed");
  assert.deepEqual(readyWave(run, 3).map((node) => node.id), ["alpha_child", "beta", "docs"]);
});

test("claimsOverlap treats claims as repository-relative path prefixes", () => {
  assert.equal(claimsOverlap(["src/auth"], ["src/auth/token.ts"]), true);
  assert.equal(claimsOverlap(["src/a"], ["src/ab"]), false);
  assert.equal(claimsOverlap(["."], ["docs"]), true);
});

test("addNodes rejects cycles, traversal, and duplicate ids", () => {
  const cyclic = runFixture();
  assert.throws(() => addNodes(cyclic, [
    baseSpec("alpha", ["a"], ["beta"]),
    baseSpec("beta", ["b"], ["alpha"]),
  ]), /cycle/);
  assert.throws(() => addNodes(runFixture(), [baseSpec("alpha", ["../outside"])]), /stay within/);
  assert.throws(() => addNodes(runFixture(), [baseSpec("alpha", ["a"]), baseSpec("alpha", ["b"])]), /Duplicate/);
});

test("a replacement supersedes a failed node and rewires pending dependents", () => {
  const run = runFixture();
  addNodes(run, [baseSpec("alpha", ["a"]), baseSpec("downstream", ["b"], ["alpha"])]);
  transitionNode(run.nodes[0]!, "running");
  transitionNode(run.nodes[0]!, "failed");
  const replacement = { ...baseSpec("alpha_retry", ["a"]), supersedes: ["alpha"] };
  addNodes(run, [replacement]);
  assert.equal(run.nodes[0]!.state, "superseded");
  assert.deepEqual(run.nodes[1]!.dependencies, ["alpha_retry"]);
  transitionNode(run.nodes[2]!, "running");
  transitionNode(run.nodes[2]!, "completed");
  transitionNode(run.nodes[2]!, "composed");
  transitionNode(run.nodes[1]!, "running");
  transitionNode(run.nodes[1]!, "completed");
  transitionNode(run.nodes[1]!, "composed");
  assert.equal(allNodesComposed(run), true);
});

test("transitionNode rejects skipped lifecycle states", () => {
  const run = runFixture();
  addNodes(run, [baseSpec("alpha", ["a"])]);
  assert.throws(() => transitionNode(run.nodes[0]!, "composed"), /Invalid work node transition/);
});
