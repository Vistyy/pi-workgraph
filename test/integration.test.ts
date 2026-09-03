import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkgraphEngine, type AssuranceInput, type ChildRunner } from "../src/engine.js";
import { GitRepository, runProcess } from "../src/git.js";
import type { ChildOutcome, WorkerReport } from "../src/types.js";
import {
  assuranceReview,
  assuranceSynthesis,
  commandAgreement,
  discoveryReport,
  implementationReport,
  nodeSpec,
  testPlaybook,
  zeroUsage,
} from "./helpers.js";

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

function outcome(sessionFile: string, report: WorkerReport, models: string[] = []): ChildOutcome {
  return {
    exitCode: 0,
    sessionFile,
    report,
    stderr: "",
    usage: zeroUsage,
    models,
    timedOut: false,
  };
}

const assuranceAssignments: AssuranceInput = {
  reviewers: [
    { responsibility: "behavior", model: "provider/behavior", thinking: "high" },
    { responsibility: "structure", model: "provider/structure", thinking: "high" },
    { responsibility: "evidence", model: "provider/evidence", thinking: "high" },
  ],
  synthesis: { model: "provider/synthesis", thinking: "high" },
};

test("engine composes isolated commits, verifies the exact result, and runs responsibility assurance", async () => {
  const { parent, root, repository } = await fixture();
  const calls: string[] = [];
  const fakeChild: ChildRunner = async (request) => {
    calls.push(`${request.mode}:${request.nodeId}`);
    if (request.mode === "discovery") {
      return outcome(join(parent, `${request.nodeId}.jsonl`), discoveryReport(`Evidence for ${request.nodeId}`), [request.guideModel]);
    }
    if (request.mode === "assurance_review") {
      return outcome(
        join(parent, `${request.nodeId}.jsonl`),
        assuranceReview(request.responsibility as "behavior" | "structure" | "evidence"),
        [request.guideModel],
      );
    }
    if (request.mode === "assurance_synthesis") {
      return outcome(join(parent, "synthesis.jsonl"), assuranceSynthesis([]), [request.guideModel]);
    }
    if (request.mode !== "implementation") throw new Error(`Unexpected mode ${request.mode}`);
    const file = request.nodeId === "alpha" ? "src/a.txt" : "src/b.txt";
    await writeFile(join(request.targetCwd, file), `${request.nodeId}\n`);
    await git(request.targetCwd, "add", file);
    await git(request.targetCwd, "commit", "-m", `Implement ${request.nodeId}`);
    const commit = await git(request.targetCwd, "rev-parse", "HEAD");
    return outcome(
      join(parent, `${request.nodeId}.jsonl`),
      implementationReport(`Implemented ${request.nodeId}`, commit, [file]),
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
      playbook: testPlaybook,
    }, { repository, runChild: fakeChild });

    await assert.rejects(() => begun.engine.execute({ nodes: [] }), /expected approved/);
    let run = await begun.engine.discover({
      topology: "partition",
      assignments: [
        { id: "how", lens: "mechanism", objective: "Find the files.", model: "provider/guide", thinking: "high" },
        { id: "why", lens: "intent", objective: "Confirm the outcome.", model: "provider/guide", thinking: "high" },
      ],
    });
    assert.equal(run.phase, "awaiting_agreement");

    const { approvedAt: _approvedAt, ...agreement } = commandAgreement;
    run = await begun.engine.recordAgreement({
      ...agreement,
      outcome: "Both values are updated.",
      nonGoals: ["No third file."],
      structure: "Each node owns one file.",
      expectedScale: "Two one-line edits.",
      verificationBoundary: "Read both files after composition.",
      verificationCommands: ["test \"$(cat src/a.txt)\" = alpha", "test \"$(cat src/b.txt)\" = beta"],
      verificationProcedure: "Read both files from the composed root.",
      requiredEvidence: ["Both composed-root value checks pass."],
    }, true, "checkpoint");
    assert.equal(run.phase, "approved");

    run = await begun.engine.execute({
      nodes: [
        {
          ...nodeSpec("beta", ["src/b.txt"]),
          brief: { ...nodeSpec("beta", ["src/b.txt"]).brief, goal: "Set b." },
          verificationCommands: ["test \"$(cat src/b.txt)\" = beta"],
        },
        {
          ...nodeSpec("alpha", ["src/a.txt"]),
          brief: { ...nodeSpec("alpha", ["src/a.txt"]).brief, goal: "Set a." },
          verificationCommands: ["test \"$(cat src/a.txt)\" = alpha"],
        },
      ],
      maxConcurrency: 2,
    });
    assert.equal(run.phase, "awaiting_assurance");
    assert.deepEqual(run.composition.map((item) => item.nodeId), ["alpha", "beta"]);
    assert.equal(await readFile(join(root, "src", "a.txt"), "utf8"), "alpha\n");
    assert.equal(await readFile(join(root, "src", "b.txt"), "utf8"), "beta\n");
    assert.equal(run.globalVerification.every((item) => item.exitCode === 0), true);
    assert.equal(run.productVerification?.revision, run.composedCommit);
    assert.deepEqual(run.nodes.map((node) => node.state), ["composed", "composed"]);

    for (const step of testPlaybook.steps) await begun.engine.recordProgress(step, "completed");
    run = await begun.engine.assure(assuranceAssignments);
    assert.equal(run.phase, "awaiting_judgment");
    run = await begun.engine.judgeAssurance({ judgments: [] });
    assert.equal(run.phase, "complete");
    assert.deepEqual(calls, [
      "discovery:how",
      "discovery:why",
      "implementation:alpha",
      "implementation:beta",
      "assurance_review:assurance-behavior",
      "assurance_review:assurance-structure",
      "assurance_review:assurance-evidence",
      "assurance_synthesis:assurance-synthesis",
    ]);

    const recovered = await WorkgraphEngine.open(run.statePath, { repository, runChild: fakeChild }).load();
    assert.equal(recovered.revision, run.revision);
    assert.equal(recovered.composedCommit, await git(root, "rev-parse", "HEAD"));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("scheduler rejects a committed file outside the worker's claimed paths", async () => {
  const { parent, root, repository } = await fixture();
  const child: ChildRunner = async (request) => {
    await writeFile(join(request.targetCwd, "src", "b.txt"), "outside-claim\n");
    await git(request.targetCwd, "add", "src/b.txt");
    await git(request.targetCwd, "commit", "-m", "Change outside claim");
    const commit = await git(request.targetCwd, "rev-parse", "HEAD");
    return outcome(join(parent, "outside.jsonl"), implementationReport("Changed the wrong file.", commit, ["src/b.txt"]));
  };
  try {
    const info = await GitRepository.inspect(root);
    const begun = await WorkgraphEngine.begin({
      request: "Change only a.",
      projectRoot: root,
      gitCommonDir: info.commonDir,
      parentSessionId: "parent",
      parentSessionFile: join(parent, "parent.jsonl"),
      baseCommit: info.head,
      playbook: testPlaybook,
    }, { repository, runChild: child });
    await begun.engine.store.update((run) => {
      run.agreement = commandAgreement;
      run.phase = "approved";
    });
    const run = await begun.engine.execute({ nodes: [nodeSpec("claimed", ["src/a.txt"])] });
    assert.equal(run.phase, "revision_required");
    assert.equal(run.nodes[0]!.state, "failed");
    assert.match(run.nodes[0]!.error ?? "", /outside its claimed paths/);
    assert.equal(await readFile(join(root, "src", "b.txt"), "utf8"), "old-b\n");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a routine worker failure can be replaced inside the existing approved envelope", async () => {
  const { parent, root, repository } = await fixture();
  const child: ChildRunner = async (request) => {
    if (request.nodeId === "failed") {
      return outcome(join(parent, "failed.jsonl"), { ...implementationReport("Transient worker failure."), status: "failed" });
    }
    await writeFile(join(request.targetCwd, "src", "a.txt"), "recovered\n");
    await git(request.targetCwd, "add", "src/a.txt");
    await git(request.targetCwd, "commit", "-m", "Recover value");
    const commit = await git(request.targetCwd, "rev-parse", "HEAD");
    return outcome(join(parent, "replacement.jsonl"), implementationReport("Recovered.", commit, ["src/a.txt"]));
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
      playbook: testPlaybook,
    }, { repository, runChild: child });
    await begun.engine.store.update((run) => {
      run.agreement = {
        ...commandAgreement,
        outcome: "src/a.txt contains recovered.",
        verificationBoundary: "Check src/a.txt.",
        verificationCommands: ["test \"$(cat src/a.txt)\" = recovered"],
      };
      run.phase = "approved";
    });
    let run = await begun.engine.execute({ nodes: [nodeSpec("failed", ["src/a.txt"])] });
    assert.equal(run.phase, "revision_required");
    run = await begun.engine.execute({
      nodes: [{
        ...nodeSpec("replacement", ["src/a.txt"]),
        supersedes: ["failed"],
        verificationCommands: ["test \"$(cat src/a.txt)\" = recovered"],
      }],
    });
    assert.equal(run.phase, "awaiting_assurance");
    assert.equal(run.nodes.find((node) => node.id === "failed")!.state, "superseded");
    assert.equal(run.nodes.find((node) => node.id === "replacement")!.state, "composed");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("worktree creation reuses a clean crash-window placement for the same pending node", async () => {
  const { parent, repository } = await fixture();
  try {
    const base = await repository.head();
    const first = await repository.createWorktree("retry-run", "worker", base);
    const second = await repository.createWorktree("retry-run", "worker", base);
    assert.deepEqual(second, first);
    assert.equal(await repository.head(second.path), base);
    assert.equal(await repository.status(second.path), "");
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
