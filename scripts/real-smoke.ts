import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { WorkgraphEngine, type AgreementInput } from "../src/engine.js";
import { GitRepository, runProcess } from "../src/git.js";
import { HerdrCliRuntime } from "../src/herdr.js";
import { loadModelPolicy, roleTargets } from "../src/model-policy.js";
import { WorkgraphRegistry } from "../src/registry.js";
import { persistSchedule, WorkgraphSupervisor } from "../src/supervisor.js";
import type { CoordinatorBoundaryKind, WorkgraphRun } from "../src/types.js";

const guideModel = process.env.PI_WORKGRAPH_GUIDE_MODEL || "openai-codex/gpt-5.6-sol";
const executorModel = process.env.PI_WORKGRAPH_EXECUTOR_MODEL || "openai-codex/gpt-5.6-luna";
const keep = process.env.PI_WORKGRAPH_KEEP_SMOKE === "1";
const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-real-"));
const root = join(parent, "fixture");
const registryPath = join(parent, "registry.sqlite");
const wakes: CoordinatorBoundaryKind[] = [];
let workspaceId: string | undefined;
let engine: WorkgraphEngine | undefined;
let registry: WorkgraphRegistry | undefined;
let supervisor: WorkgraphSupervisor | undefined;

async function git(...args: string[]): Promise<string> {
  const result = await runProcess("git", ["-C", root, ...args], { cwd: root, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function herdr(...args: string[]): Promise<Record<string, any>> {
  const result = await runProcess("herdr", args, { cwd: root, timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error(`herdr ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  const parsed = result.stdout ? JSON.parse(result.stdout) as Record<string, any> : { result: {} };
  if (!parsed.result) throw new Error(`herdr ${args.join(" ")} returned no result.`);
  return parsed;
}

async function waitFor(label: string, predicate: (run: WorkgraphRun) => boolean, timeoutMs = 20 * 60_000): Promise<WorkgraphRun> {
  const deadline = Date.now() + timeoutMs;
  let last = await engine!.load();
  while (Date.now() < deadline) {
    last = await engine!.load();
    if (predicate(last)) return last;
    if (["revision_required", "needs_decision", "assurance_inconclusive", "failed"].includes(last.phase)) {
      throw new Error(`${label} reached ${last.phase}: ${last.error ?? last.productVerification?.error ?? "no retained error"}`);
    }
    const unresolved = last.nodes.filter((node) => node.state === "failed" || node.state === "escalated");
    const activeImplementation = last.attempts.filter((attempt) =>
      attempt.mode === "implementation" && ["starting", "running", "settling", "cancel_requested"].includes(attempt.state),
    );
    if (last.control.executionStatus === "idle" && unresolved.length > 0 && activeImplementation.length === 0) {
      const diagnostics = unresolved.map((node) => ({
        nodeId: node.id,
        state: node.state,
        error: node.error,
        activeAttemptId: node.activeAttemptId,
        attempts: last.attempts.filter((attempt) => attempt.nodeId === node.id).map((attempt) => ({
          id: attempt.id,
          state: attempt.state,
          stage: attempt.stage,
          error: attempt.error,
          sessionFile: attempt.sessionFile,
        })),
      }));
      throw new Error(`${label} reached quiescent unresolved implementation work: ${JSON.stringify(diagnostics)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} timed out in ${last.phase} with execution ${last.control.executionStatus}.`);
}

function hasWake(run: WorkgraphRun, kind: CoordinatorBoundaryKind): boolean {
  return (run.coordinatorWakeups ?? []).some((wake) => wake.kind === kind && wake.state === "delivered");
}

try {
  if (process.env.HERDR_ENV !== "1") throw new Error("smoke:real requires a Herdr-managed environment so every model worker is visible.");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), `# Fixture instructions

Follow the Workgraph objective and runtime phase instructions.
Keep changes minimal and do not edit files outside the assigned claimed paths.
Use workgraph_report as the terminal action.
`);
  await writeFile(join(root, "src", "a.txt"), "unset\n");
  await writeFile(join(root, "src", "b.txt"), "unset\n");
  await writeFile(join(root, "verify-a.sh"), "#!/usr/bin/env bash\ntest \"$(cat src/a.txt)\" = ORBIT\n", { mode: 0o755 });
  await writeFile(join(root, "verify-b.sh"), "#!/usr/bin/env bash\ntest \"$(cat src/b.txt)\" = MOON\n", { mode: 0o755 });
  await runProcess("git", ["init", "-b", "main", root], { cwd: parent, timeoutMs: 30_000 });
  await git("config", "user.email", "workgraph@example.test");
  await git("config", "user.name", "Workgraph Smoke");
  await git("add", ".");
  await git("commit", "-m", "Create smoke fixture");

  const prior = await herdr("workspace", "list");
  const priorIds = new Set((prior.result.workspaces ?? []).map((item: Record<string, unknown>) => String(item.workspace_id ?? item.id)));
  const created = await herdr("workspace", "create", "--cwd", root, "--label", `Workgraph real smoke ${Date.now()}`, "--no-focus");
  workspaceId = String(created.result.workspace.workspace_id ?? created.result.workspace.id);
  if (!workspaceId || priorIds.has(workspaceId) || workspaceId === process.env.HERDR_WORKSPACE_ID) throw new Error("Herdr did not create a distinct disposable real-smoke workspace.");

  const parentSession = SessionManager.create(root, join(parent, "parent-sessions"));
  const parentMessage: UserMessage = {
    role: "user",
    content: "For this request, the first inherited trajectory value is exactly ORBIT and the second is exactly MOON. Update the two target files accordingly, but establish an agreement before implementation.",
    timestamp: Date.now(),
  };
  parentSession.appendMessage(parentMessage);
  const acknowledgement: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "I will preserve those exact inherited values and establish the implementation envelope before writes." }],
    api: "openai-responses",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  parentSession.appendMessage(acknowledgement);
  const parentSessionFile = parentSession.getSessionFile();
  if (!parentSessionFile) throw new Error("Could not create the parent smoke session.");

  const repository = await GitRepository.open(root);
  registry = new WorkgraphRegistry(registryPath);
  const begun = await WorkgraphEngine.begin({
    request: "Apply the two exact values established in the inherited parent trajectory to src/a.txt and src/b.txt.",
    projectRoot: root,
    gitCommonDir: repository.commonDir,
    parentSessionId: parentSession.getSessionId(),
    parentSessionFile,
    baseCommit: await repository.head(),
    runId: `real-${Date.now().toString(36)}`,
    outcome: { kind: "product_change", statement: "The exact fixture values are composed.", completionPredicate: "src/a.txt is ORBIT, src/b.txt is MOON, and the composed result passes both fixture checks." },
    milestones: ["discover", "implement", "verify", "assure"].map((id) => ({ id, description: `Complete ${id}.` })),
  }, { repository, registry });
  engine = begun.engine;
  supervisor = new WorkgraphSupervisor(engine, new HerdrCliRuntime("herdr", { ...process.env, HERDR_WORKSPACE_ID: workspaceId }), {
    workspaceId,
    pollIntervalMs: 250,
    stableEntryId: parentSession.getLeafId(),
    onCoordinatorWake: (wake) => { wakes.push(wake.kind); },
    onError: (error) => { console.error(JSON.stringify({ event: "supervisor-error", error: error.message })); },
  });
  supervisor.start();
  console.log(JSON.stringify({ event: "begun", runId: begun.run.runId, root, workspaceId }));

  const modelPolicy = await loadModelPolicy();
  const discoveryPanel = roleTargets(modelPolicy, "discovery.replicate");
  await engine.queueDiscovery({
    topology: "replicate",
    stableEntryId: parentSession.getLeafId(),
    assignments: [
      { id: "request-a", lens: "Independent replication 1 of 2", objective: "Identify the exact requested values, target files, smallest ownership split, and any material scope risk.", ...discoveryPanel[0]! },
      { id: "request-b", lens: "Independent replication 2 of 2", objective: "Independently identify the exact requested values, target files, smallest ownership split, and any material scope risk.", ...discoveryPanel[1]! },
    ],
  });
  supervisor.kick();
  let run = await waitFor("discovery", (candidate) => candidate.phase === "awaiting_agreement" && hasWake(candidate, "agreement"));
  if (run.discoveries.some((item) => item.state !== "completed" || item.resultKind !== "typed")) throw new Error("Visible discovery did not retain completed typed reports.");
  await engine.recordMilestone("discover", "completed");

  const agreement: AgreementInput = {
    outcome: "src/a.txt contains ORBIT and src/b.txt contains MOON.",
    nonGoals: ["No changes to fixture instructions or verification scripts."],
    reuseDecision: "Use the existing files and shell checks without introducing code or dependencies.",
    structure: "Node alpha owns src/a.txt and node beta owns src/b.txt.",
    expectedScale: "Two independent one-line file changes and two commits before composition.",
    verificationBoundary: "Each worktree runs its owned script, and the composed root runs both scripts before assurance.",
    verificationCommands: ["./verify-a.sh", "./verify-b.sh"],
    verificationMethod: "commands",
    verificationProcedure: "Run both existing scripts from the composed repository root.",
    requiredEvidence: ["Both existing scripts exit successfully against the composed revision."],
    unresolvedDecisions: [],
  };
  run = await engine.proposePlan(agreement, "Set the two inherited values in independently owned files.", "initial");
  run = await engine.recordPlanDecision(run.plans.at(-1)!.version, true, "approved by the explicitly invoked real smoke harness");

  await persistSchedule(engine, {
    maxConcurrency: 2,
    nodes: [
      {
        id: "alpha",
        brief: { goal: "Set src/a.txt to the first exact value established in the inherited parent trajectory.", context: ["The inherited parent trajectory states that the first value is ORBIT."], acceptance: ["src/a.txt contains exactly ORBIT followed by a newline."], timeboxMinutes: 8, forbidden: ["Do not change fixture instructions, scripts, or src/b.txt."], report: "Return the exact commit, changed file, and verification result." },
        claimedPaths: ["src/a.txt"], dependencies: [], verificationCommands: ["./verify-a.sh"], supersedes: [], guideModel, executorModel, guideThinking: "high", executorThinking: "high",
      },
      {
        id: "beta",
        brief: { goal: "Set src/b.txt to the second exact value established in the inherited parent trajectory.", context: ["The inherited parent trajectory states that the second value is MOON."], acceptance: ["src/b.txt contains exactly MOON followed by a newline."], timeboxMinutes: 8, forbidden: ["Do not change fixture instructions, scripts, or src/a.txt."], report: "Return the exact commit, changed file, and verification result." },
        claimedPaths: ["src/b.txt"], dependencies: [], verificationCommands: ["./verify-b.sh"], supersedes: [], guideModel, executorModel, guideThinking: "high", executorThinking: "high",
      },
    ],
  }, supervisor);
  run = await waitFor("implementation", (candidate) => hasWake(candidate, "settle"));
  if (run.nodes.some((node) => node.state !== "composed" || node.resultKind !== "typed")) throw new Error("Visible implementation did not compose completed typed results.");
  await engine.recordMilestone("implement", "completed");

  run = await engine.settle();
  if (run.phase !== "awaiting_assurance" || run.productVerification?.state !== "completed") throw new Error(`Command verification stopped in ${run.phase}.`);
  await engine.recordMilestone("verify", "completed");
  supervisor.kick();
  await waitFor("assurance boundary", (candidate) => hasWake(candidate, "assurance"));

  await engine.queueAssurance({
    reviewers: [
      { responsibility: "behavior", ...roleTargets(modelPolicy, "assurance.behavior")[0]! },
      { responsibility: "structure", ...roleTargets(modelPolicy, "assurance.structure")[0]! },
      { responsibility: "evidence", ...roleTargets(modelPolicy, "assurance.evidence")[0]! },
    ],
    synthesis: roleTargets(modelPolicy, "assurance.synthesis")[0]!,
    stableEntryId: parentSession.getLeafId(),
  });
  supervisor.kick();
  run = await waitFor("assurance", (candidate) => candidate.phase === "awaiting_judgment" && hasWake(candidate, "judgment"));
  const dispositions = run.assurance?.synthesis?.report?.dispositions ?? [];
  run = await engine.judgeAssurance({ judgments: dispositions.map((item) => ({ findingId: item.finding.id, disposition: item.disposition === "accept" ? "accept" as const : "dismiss" as const, reason: `Smoke coordinator followed the supported synthesis disposition (${item.disposition}): ${item.reason}` })) });
  if (run.phase !== "complete") throw new Error(`Coordinator judgment stopped in ${run.phase}.`);
  await engine.recordMilestone("assure", "completed");
  supervisor.kick();
  run = await waitFor("resource cleanup", (candidate) => (candidate.cleanup ?? []).length > 0 && (candidate.cleanup ?? []).every((record) => record.state === "completed"));

  const durableWakes = run.coordinatorWakeups ?? [];
  if (durableWakes.some((wake) => wake.state !== "delivered")) throw new Error(`The real smoke retained an undelivered wake: ${JSON.stringify(durableWakes)}`);
  if (new Set(durableWakes.map((wake) => wake.id)).size !== durableWakes.length) throw new Error("The real smoke retained duplicate wake identities.");
  for (const kind of ["agreement", "settle", "assurance", "judgment"] as const) if (!durableWakes.some((wake) => wake.kind === kind) || !wakes.includes(kind)) throw new Error(`The real smoke did not deliver the ${kind} boundary.`);
  if (run.discoveries.length !== 2 || run.discoveries.some((item) => item.resultKind !== "typed")) throw new Error("Replicated discovery did not retain two typed reports.");
  if (run.nodes.length !== 2 || run.nodes.some((node) => node.state !== "composed" || node.resultKind !== "typed")) throw new Error("Concurrent implementation did not retain two composed typed results.");
  if (run.assurance?.state !== "completed" || !run.assurance.finalJudgment) throw new Error("Assurance or final judgment did not complete.");
  const visibleAttempts = run.attempts.filter((attempt) => attempt.runtimeMode === "herdr");
  if (visibleAttempts.length === 0 || visibleAttempts.some((attempt) => !attempt.worker?.workspaceId || !attempt.worker.tabId || !attempt.worker.paneId || !attempt.worker.sessionFile)) throw new Error("A model-backed attempt did not retain its visible Herdr identity and session.");
  for (const attempt of visibleAttempts) {
    const records = (run.cleanup ?? []).filter((record) => record.attemptId === attempt.id);
    const herdrRecord = records.find((record) => record.kind === "herdr_worker");
    const gitRecord = records.find((record) => record.kind === "git_worktree");
    if (records.length !== 2 || herdrRecord?.state !== "completed" || gitRecord?.state !== "completed") throw new Error(`Attempt ${attempt.id} did not retain exact completed cleanup records: ${JSON.stringify(records)}`);
    if (!herdrRecord.completedAt || !gitRecord.completedAt || herdrRecord.completedAt > gitRecord.completedAt) throw new Error(`Attempt ${attempt.id} removed Git resources before its Herdr worker.`);
  }
  const values = {
    a: await readFile(join(root, "src", "a.txt"), "utf8"),
    b: await readFile(join(root, "src", "b.txt"), "utf8"),
  };
  if (values.a !== "ORBIT\n" || values.b !== "MOON\n") throw new Error(`Composed values are incorrect: ${JSON.stringify(values)}`);
  const tabs = (await herdr("tab", "list", "--workspace", workspaceId)).result.tabs as Array<Record<string, unknown>>;
  if (tabs.length !== 1) throw new Error(`Disposable workspace retained ${tabs.length - 1} worker tab(s).`);
  console.log(JSON.stringify({
    event: "complete",
    phase: run.phase,
    runId: run.runId,
    workspaceId,
    composedCommit: run.composedCommit,
    values: { a: values.a.trim(), b: values.b.trim() },
    wakes: durableWakes.map((wake) => ({ id: wake.id, kind: wake.kind, state: wake.state })),
    topology: visibleAttempts.map((attempt) => ({ mode: attempt.mode, nodeId: attempt.nodeId, tabId: attempt.worker?.tabId, paneId: attempt.worker?.paneId, sessionFile: attempt.worker?.sessionFile })),
    cleanup: { attempts: visibleAttempts.length, records: run.cleanup?.length ?? 0, ordered: true },
    verification: run.globalVerification,
    assurance: { state: run.assurance.state, reviews: run.assurance.reviews.length, judgments: run.assurance.finalJudgment?.judgments.length ?? 0 },
  }));
} finally {
  await supervisor?.shutdown().catch(() => undefined);
  engine?.releaseLease();
  registry?.close();
  if (workspaceId) await herdr("workspace", "close", workspaceId).catch(() => undefined);
  if (keep) console.error(`Preserved smoke fixture: ${parent}`);
  else await rm(parent, { recursive: true, force: true });
}
