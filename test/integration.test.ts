import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkgraphEngine, type ChildRunner } from "../src/engine.js";
import { GitRepository, runProcess } from "../src/git.js";
import type { ChildOutcome, WorkerReport, WorkgraphRun } from "../src/types.js";

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess("git", ["-C", cwd, ...args], { cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function fixture(): Promise<{ parent: string; root: string; repository: GitRepository }> {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-integration-"));
  const root = join(parent, "repo");
  await runProcess("mkdir", ["-p", join(root, "src")], { cwd: parent, timeoutMs: 5_000 });
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "workgraph@example.test");
  await git(root, "config", "user.name", "Workgraph Test");
  await writeFile(join(root, "src", "a.txt"), "old-a\n");
  await writeFile(join(root, "src", "b.txt"), "old-b\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  return { parent, root, repository: await GitRepository.open(root) };
}

function report(kind: WorkerReport["kind"], summary: string, fields: Partial<WorkerReport> = {}): WorkerReport {
  return {
    kind,
    status: "completed",
    summary,
    evidence: [],
    findings: [],
    ...fields,
  };
}

function outcome(sessionFile: string, reportValue: WorkerReport, models: string[] = []): ChildOutcome {
  return {
    exitCode: 0,
    sessionFile,
    report: reportValue,
    stderr: "",
    usage: zeroUsage,
    models,
    timedOut: false,
  };
}

test("engine gates execution, composes parallel isolated commits deterministically, and assures the result", async () => {
  const { parent, root, repository } = await fixture();
  const calls: string[] = [];
  const fakeChild: ChildRunner = async (request) => {
    calls.push(`${request.mode}:${request.nodeId}`);
    if (request.mode === "discovery") {
      return outcome(join(parent, `${request.nodeId}.jsonl`), report("discovery", `Evidence for ${request.nodeId}`), [request.guideModel]);
    }
    if (request.mode === "assurance") {
      return outcome(join(parent, "assurance.jsonl"), report("assurance", "Composed behavior satisfies the envelope."), [request.guideModel]);
    }
    const file = request.nodeId === "alpha" ? "src/a.txt" : "src/b.txt";
    await writeFile(join(request.targetCwd, file), `${request.nodeId}\n`);
    await git(request.targetCwd, "add", file);
    await git(request.targetCwd, "commit", "-m", `Implement ${request.nodeId}`);
    const commit = await git(request.targetCwd, "rev-parse", "HEAD");
    return outcome(
      join(parent, `${request.nodeId}.jsonl`),
      report("implementation", `Implemented ${request.nodeId}`, { commit, changedFiles: [file] }),
      [request.guideModel, request.executorModel!],
    );
  };

  try {
    const info = await GitRepository.inspect(root);
    const begun = await WorkgraphEngine.begin({
      request: "Update both fixture values.",
      projectRoot: root,
      gitCommonDir: info.commonDir,
      parentSessionId: "parent-session",
      parentSessionFile: join(parent, "parent.jsonl"),
      baseCommit: info.head,
      runId: "integration-run",
    }, { repository, runChild: fakeChild });

    await assert.rejects(() => begun.engine.execute({ nodes: [] }), /expected approved/);
    let run = await begun.engine.discover({
      investigations: [
        { id: "how", lens: "mechanism", objective: "Find the files." },
        { id: "why", lens: "intent", objective: "Confirm the outcome." },
      ],
      model: "provider/guide",
      thinking: "high",
    });
    assert.equal(run.phase, "awaiting_agreement");

    run = await begun.engine.recordAgreement({
      outcome: "Both values are updated.",
      nonGoals: ["No third file."],
      reuseDecision: "Use existing files.",
      structure: "Each node owns one file.",
      expectedScale: "Two one-line edits.",
      verificationBoundary: "Read both files after composition.",
      verificationCommands: ["test \"$(cat src/a.txt)\" = alpha", "test \"$(cat src/b.txt)\" = beta"],
      unresolvedDecisions: [],
    }, true, "checkpoint");
    assert.equal(run.phase, "approved");

    run = await begun.engine.execute({
      nodes: [
        {
          id: "beta",
          objective: "Set b.",
          claimedPaths: ["src/b.txt"],
          dependencies: [],
          verificationCommands: ["test \"$(cat src/b.txt)\" = beta"],
          supersedes: [],
          guideModel: "provider/guide",
          executorModel: "provider/executor",
          guideThinking: "high",
          executorThinking: "high",
        },
        {
          id: "alpha",
          objective: "Set a.",
          claimedPaths: ["src/a.txt"],
          dependencies: [],
          verificationCommands: ["test \"$(cat src/a.txt)\" = alpha"],
          supersedes: [],
          guideModel: "provider/guide",
          executorModel: "provider/executor",
          guideThinking: "high",
          executorThinking: "high",
        },
      ],
      maxConcurrency: 2,
    });
    assert.equal(run.phase, "awaiting_assurance");
    assert.deepEqual(run.composition.map((item) => item.nodeId), ["alpha", "beta"]);
    assert.equal(await readFile(join(root, "src", "a.txt"), "utf8"), "alpha\n");
    assert.equal(await readFile(join(root, "src", "b.txt"), "utf8"), "beta\n");
    assert.equal(run.globalVerification.every((item) => item.exitCode === 0), true);
    assert.deepEqual(run.nodes.map((node) => node.state), ["composed", "composed"]);

    run = await begun.engine.assure({ model: "provider/guide", thinking: "high" });
    assert.equal(run.phase, "complete");
    assert.deepEqual(calls, ["discovery:how", "discovery:why", "implementation:alpha", "implementation:beta", "assurance:assurance"]);

    const recovered = await WorkgraphEngine.open(run.statePath, { repository, runChild: fakeChild }).load();
    assert.equal(recovered.revision, run.revision);
    assert.equal(recovered.composedCommit, await git(root, "rev-parse", "HEAD"));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a routine worker failure can be replaced inside the existing approved envelope", async () => {
  const { parent, root, repository } = await fixture();
  const child: ChildRunner = async (request) => {
    if (request.nodeId === "failed") {
      return outcome(join(parent, "failed.jsonl"), report("implementation", "Transient worker failure.", { status: "failed" }));
    }
    await writeFile(join(request.targetCwd, "src", "a.txt"), "recovered\n");
    await git(request.targetCwd, "add", "src/a.txt");
    await git(request.targetCwd, "commit", "-m", "Recover value");
    const commit = await git(request.targetCwd, "rev-parse", "HEAD");
    return outcome(join(parent, "replacement.jsonl"), report("implementation", "Recovered.", { commit, changedFiles: ["src/a.txt"] }));
  };
  try {
    const info = await GitRepository.inspect(root);
    const begun = await WorkgraphEngine.begin({
      request: "Recover the value.",
      projectRoot: root,
      gitCommonDir: info.commonDir,
      parentSessionId: "parent",
      parentSessionFile: join(parent, "parent.jsonl"),
      baseCommit: info.head,
    }, { repository, runChild: child });
    await begun.engine.store.update((run) => {
      run.agreement = {
        outcome: "src/a.txt contains recovered.",
        nonGoals: [],
        reuseDecision: "Reuse the file.",
        structure: "One node owns src/a.txt.",
        expectedScale: "One line.",
        verificationBoundary: "Check src/a.txt.",
        verificationCommands: ["test \"$(cat src/a.txt)\" = recovered"],
        unresolvedDecisions: [],
        approvedAt: new Date().toISOString(),
      };
      run.phase = "approved";
    });
    let run = await begun.engine.execute({
      nodes: [{
        id: "failed",
        objective: "Set src/a.txt.",
        claimedPaths: ["src/a.txt"],
        dependencies: [],
        verificationCommands: [],
        supersedes: [],
        guideModel: "provider/guide",
        executorModel: "provider/executor",
        guideThinking: "high",
        executorThinking: "high",
      }],
    });
    assert.equal(run.phase, "revision_required");
    run = await begun.engine.execute({
      nodes: [{
        id: "replacement",
        objective: "Replace the failed node and set src/a.txt.",
        claimedPaths: ["src/a.txt"],
        dependencies: [],
        verificationCommands: ["test \"$(cat src/a.txt)\" = recovered"],
        supersedes: ["failed"],
        guideModel: "provider/guide",
        executorModel: "provider/executor",
        guideThinking: "high",
        executorThinking: "high",
      }],
    });
    assert.equal(run.phase, "awaiting_assurance");
    assert.equal(run.nodes.find((node) => node.id === "failed")!.state, "superseded");
    assert.equal(run.nodes.find((node) => node.id === "replacement")!.state, "composed");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("Git composition aborts a conflict and preserves the pre-composition HEAD", async () => {
  const { parent, root, repository } = await fixture();
  try {
    const base = await repository.head();
    const placement = await repository.createWorktree("conflict-run", "worker", base);
    await writeFile(join(placement.path, "src", "a.txt"), "worker\n");
    await git(placement.path, "add", "src/a.txt");
    await git(placement.path, "commit", "-m", "worker change");
    const workerCommit = await git(placement.path, "rev-parse", "HEAD");

    await writeFile(join(root, "src", "a.txt"), "coordinator\n");
    await git(root, "add", "src/a.txt");
    await git(root, "commit", "-m", "coordinator change");
    const before = await repository.head();

    await assert.rejects(() => repository.compose(workerCommit, before), /Cherry-pick conflict or failure/);
    assert.equal(await repository.head(), before);
    assert.equal(await repository.status(), "");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
