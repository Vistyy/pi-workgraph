import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { WorkgraphEngine, type AssuranceInput, type ChildRunner } from "../src/engine.js";
import { GitRepository, runProcess, type WorktreePlacement } from "../src/git.js";
import { addNodes, transitionNode } from "../src/scheduler.js";
import type { ImplementationReport, WorkerReport } from "../src/types.js";
import {
  assuranceReview,
  assuranceSynthesis,
  commandAgreement,
  nodeSpec,
  testOutcome,
  verificationReport,
  zeroUsage,
} from "./helpers.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess("git", ["-C", cwd, ...args], { cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function setup() {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-recovery-"));
  const root = join(parent, "repo");
  await runProcess("mkdir", ["-p", root], { cwd: parent, timeoutMs: 5_000 });
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "workgraph@example.test");
  await git(root, "config", "user.name", "Workgraph Recovery");
  await writeFile(join(root, "value.txt"), "old\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  const repository = await GitRepository.open(root);
  const base = await repository.head();
  const begun = await WorkgraphEngine.begin({
    request: "Set value.",
    projectRoot: root,
    gitCommonDir: repository.commonDir,
    parentSessionId: "parent",
    parentSessionFile: join(parent, "parent.jsonl"),
    baseCommit: base,
    outcome: testOutcome.outcome,
      milestones: testOutcome.milestones,
  }, { repository });
  return { parent, root, repository, base, engine: begun.engine, runId: begun.run.runId };
}

async function workerCommit(repository: GitRepository, runId: string, base: string): Promise<{ placement: WorktreePlacement; commit: string; report: ImplementationReport }> {
  const placement = await repository.createWorktree(runId, "worker", base);
  await writeFile(join(placement.path, "value.txt"), "new\n");
  await git(placement.path, "add", "value.txt");
  await git(placement.path, "commit", "-m", "Set value");
  const commit = await repository.head(placement.path);
  return {
    placement,
    commit,
    report: {
      kind: "implementation",
      status: "completed",
      summary: "Set value.",
      evidence: [],
      findings: [],
      commit,
      changedFiles: ["value.txt"],
    },
  };
}

function appendReportSession(cwd: string, sessionDir: string, report: WorkerReport): string {
  const session = SessionManager.create(cwd, sessionDir);
  const user: UserMessage = { role: "user", content: "objective", timestamp: Date.now() };
  session.appendMessage(user);
  const assistant: AssistantMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: "report-call", name: "workgraph_report", arguments: report }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
  session.appendMessage(assistant);
  const result: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "report-call",
    toolName: "workgraph_report",
    content: [{ type: "text", text: "completed" }],
    details: { report },
    isError: false,
    timestamp: Date.now(),
  };
  session.appendMessage(result);
  return session.getSessionFile()!;
}

async function seedNode(
  engine: WorkgraphEngine,
  placement: WorktreePlacement,
  commit: string,
  state: "running" | "completed",
  sessionFile?: string,
): Promise<void> {
  await engine.store.update((run) => {
    run.agreement = {
      ...commandAgreement,
      outcome: "value.txt contains new.",
      verificationBoundary: "Check value.txt.",
      verificationCommands: ["test \"$(cat value.txt)\" = new"],
    };
    addNodes(run, [{
      ...nodeSpec("worker", ["value.txt"]),
      verificationCommands: ["test \"$(cat value.txt)\" = new"],
    }]);
    const node = run.nodes[0]!;
    transitionNode(node, "running");
    if (state === "completed") transitionNode(node, "completed");
    node.baseCommit = placement.baseCommit;
    node.branch = placement.branch;
    node.worktreePath = placement.path;
    node.commit = commit;
    if (sessionFile) node.sessionFile = sessionFile;
    run.phase = "executing";
  });
}

test("recovery consumes a terminal child report, validates it, and finishes composition", async () => {
  const fixture = await setup();
  try {
    const worker = await workerCommit(fixture.repository, fixture.runId, fixture.base);
    const sessionFile = appendReportSession(worker.placement.path, join(fixture.parent, "sessions"), worker.report);
    await seedNode(fixture.engine, worker.placement, worker.commit, "running", sessionFile);
    const run = await fixture.engine.reconcile();
    assert.equal(run.phase, "awaiting_assurance");
    assert.equal(run.nodes[0]!.state, "composed");
    assert.equal(await readFile(join(fixture.root, "value.txt"), "utf8"), "new\n");
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("recovery consumes an interrupted product-verification report for the exact revision", async () => {
  const fixture = await setup();
  try {
    const report = verificationReport("verified");
    const sessionFile = appendReportSession(fixture.root, join(fixture.parent, "verification-sessions"), report);
    await fixture.engine.store.update((run) => {
      run.agreement = {
        ...commandAgreement,
        verificationMethod: "independent",
        verificationProcedure: "Read value.txt.",
        requiredEvidence: ["The stored value."],
      };
      run.productVerification = {
        revision: run.composedCommit,
        method: "independent",
        state: "running",
        commands: [],
        sessionFile,
      };
      run.phase = "awaiting_verification";
    });
    const recovered = await fixture.engine.reconcile();
    assert.equal(recovered.phase, "awaiting_assurance");
    assert.equal(recovered.productVerification?.state, "completed");
    assert.equal(recovered.productVerification?.report?.verdict, "verified");
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("assurance recovery preserves completed reviews and retries only synthesis", async () => {
  const fixture = await setup();
  const responsibilities = ["behavior", "structure", "evidence"] as const;
  try {
    const sessions = Object.fromEntries(responsibilities.map((responsibility) => [
      responsibility,
      appendReportSession(fixture.root, join(fixture.parent, `${responsibility}-sessions`), assuranceReview(responsibility)),
    ]));
    await fixture.engine.store.update((run) => {
      run.agreement = commandAgreement;
      run.productVerification = { revision: run.composedCommit, method: "commands", state: "completed", commands: [] };
      for (const step of run.milestones) step.status = "completed";
      run.assurance = {
        revision: run.composedCommit,
        state: "running",
        reviews: responsibilities.map((responsibility) => ({
          responsibility,
          model: `provider/${responsibility}`,
          thinking: "high",
          state: "running",
          sessionFile: sessions[responsibility]!,
        })),
      };
      run.phase = "awaiting_assurance";
    });
    const reconciled = await fixture.engine.reconcile();
    assert.equal(reconciled.phase, "assurance_inconclusive");
    assert.equal(reconciled.assurance?.reviews.every((review) => review.state === "completed"), true);

    const calls: string[] = [];
    const child: ChildRunner = async (request) => {
      calls.push(request.mode);
      return {
        exitCode: 0,
        sessionFile: join(fixture.parent, "synthesis.jsonl"),
        report: assuranceSynthesis([]),
        stderr: "",
        usage: zeroUsage,
        models: [request.guideModel],
        timedOut: false,
      };
    };
    const input: AssuranceInput = {
      reviewers: responsibilities.map((responsibility) => ({ responsibility, model: `provider/${responsibility}`, thinking: "high" })),
      synthesis: { model: "provider/synthesis", thinking: "high" },
    };
    const resumed = await WorkgraphEngine.open(reconciled.statePath, { repository: fixture.repository, runChild: child }).assure(input);
    assert.equal(resumed.phase, "awaiting_judgment");
    assert.deepEqual(calls, ["assurance_synthesis"]);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("recovery attributes one unrecorded cherry-pick before advancing durable state", async () => {
  const fixture = await setup();
  try {
    const worker = await workerCommit(fixture.repository, fixture.runId, fixture.base);
    await seedNode(fixture.engine, worker.placement, worker.commit, "completed");
    const landed = await fixture.repository.compose(worker.commit, fixture.base);
    const run = await fixture.engine.reconcile();
    assert.equal(run.phase, "awaiting_assurance");
    assert.equal(run.composedCommit, landed);
    assert.equal(run.nodes[0]!.state, "composed");
    assert.equal(run.composition.length, 1);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});
