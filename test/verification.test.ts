import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkgraphEngine, type ChildRunner } from "../src/engine.js";
import { GitRepository, runProcess } from "../src/git.js";
import { implementationReport, nodeSpec, testPlaybook, verificationReport, zeroUsage } from "./helpers.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess("git", ["-C", cwd, ...args], { cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

test("independent product evidence is revision-keyed and a correction continues the original implementer trajectory", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-verification-"));
  const root = join(parent, "repo");
  await runProcess("mkdir", ["-p", root], { cwd: parent, timeoutMs: 5_000 });
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "workgraph@example.test");
  await git(root, "config", "user.name", "Workgraph Verification");
  await writeFile(join(root, "value.txt"), "old\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  const implementationRequests: Parameters<ChildRunner>[0][] = [];
  const child: ChildRunner = async (request) => {
    if (request.mode === "verification") {
      return {
        exitCode: 0,
        sessionFile: join(parent, `${request.nodeId}.jsonl`),
        report: verificationReport("verified"),
        stderr: "",
        usage: zeroUsage,
        models: [request.guideModel],
        timedOut: false,
      };
    }
    if (request.mode !== "implementation") throw new Error(`Unexpected mode ${request.mode}`);
    implementationRequests.push(request);
    const value = request.nodeId === "initial" ? "first" : "corrected";
    await writeFile(join(request.targetCwd, "value.txt"), `${value}\n`);
    await git(request.targetCwd, "add", "value.txt");
    await git(request.targetCwd, "commit", "-m", `Set ${value}`);
    const commit = await git(request.targetCwd, "rev-parse", "HEAD");
    return {
      exitCode: 0,
      sessionFile: join(parent, `${request.nodeId}.jsonl`),
      report: implementationReport(`Set ${value}.`, commit, ["value.txt"]),
      stderr: "",
      usage: zeroUsage,
      models: [request.guideModel, request.executorModel!],
      timedOut: false,
    };
  };

  try {
    const repository = await GitRepository.open(root);
    const begun = await WorkgraphEngine.begin({
      request: "Set and verify the value.",
      projectRoot: root,
      gitCommonDir: repository.commonDir,
      parentSessionId: "parent",
      parentSessionFile: join(parent, "parent.jsonl"),
      baseCommit: await repository.head(),
      playbook: testPlaybook,
    }, { repository, runChild: child });
    await begun.engine.store.update((run) => {
      run.agreement = {
        outcome: "value.txt contains the selected value.",
        nonGoals: [],
        reuseDecision: "Reuse value.txt.",
        structure: "One node owns value.txt.",
        expectedScale: "One line per correction.",
        verificationBoundary: "Observe value.txt independently.",
        verificationCommands: ["test -s value.txt"],
        verificationMethod: "independent",
        verificationProcedure: "Read value.txt from the composed root.",
        requiredEvidence: ["The stored value from the exact composed revision."],
        unresolvedDecisions: [],
        approvedAt: new Date().toISOString(),
      };
      run.phase = "approved";
    });

    let run = await begun.engine.execute({ nodes: [nodeSpec("initial", ["value.txt"])] });
    assert.equal(run.phase, "awaiting_verification");
    assert.match(implementationRequests[0]!.objective, /GOAL\nImplement initial\./);
    assert.match(implementationRequests[0]!.objective, /SCOPE\nvalue\.txt/);
    assert.match(implementationRequests[0]!.objective, /CONTEXT\n- Use the fixture\./);
    assert.match(implementationRequests[0]!.objective, /ACCEPTANCE/);
    assert.match(implementationRequests[0]!.objective, /TIMEBOX\n20 minutes/);
    assert.match(implementationRequests[0]!.objective, /FORBIDDEN/);
    assert.match(implementationRequests[0]!.objective, /REPORT/);
    assert.equal(implementationRequests[0]!.timeoutMs, 20 * 60_000);
    run = await begun.engine.verify({ model: "provider/verifier", thinking: "high" });
    assert.equal(run.phase, "awaiting_assurance");
    const firstEvidenceRevision = run.productVerification!.revision;
    assert.equal(run.productVerification?.report?.verdict, "verified");

    run = await begun.engine.execute({
      nodes: [{ ...nodeSpec("correction", ["value.txt"]), continuationOf: "initial" }],
    });
    assert.equal(run.phase, "awaiting_verification");
    assert.notEqual(run.productVerification!.revision, firstEvidenceRevision);
    assert.equal(run.productVerification!.revision, run.composedCommit);
    assert.equal(run.productVerification!.report, undefined);
    assert.equal(implementationRequests[1]!.parentSessionFile, join(parent, "initial.jsonl"));
    assert.equal(implementationRequests[1]!.implementationStart, "executor");

    run = await begun.engine.verify({ model: "provider/verifier", thinking: "high" });
    for (const step of testPlaybook.steps) await begun.engine.recordProgress(step, "completed");
    await writeFile(join(root, "outside.txt"), "unattributed\n");
    await git(root, "add", "outside.txt");
    await git(root, "commit", "-m", "Unattributed coordinator change");
    run = await begun.engine.assure({
      reviewers: [
        { responsibility: "behavior", model: "provider/behavior", thinking: "high" },
        { responsibility: "structure", model: "provider/structure", thinking: "high" },
        { responsibility: "evidence", model: "provider/evidence", thinking: "high" },
      ],
      synthesis: { model: "provider/synthesis", thinking: "high" },
    });
    assert.equal(run.phase, "needs_decision");
    assert.match(run.error ?? "", /Composition HEAD changed/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
