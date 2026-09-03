import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { WorkgraphEngine } from "../src/engine.js";
import { GitRepository, runProcess } from "../src/git.js";

const guideModel = process.env.PI_WORKGRAPH_GUIDE_MODEL || "openai-codex/gpt-5.6-sol";
const executorModel = process.env.PI_WORKGRAPH_EXECUTOR_MODEL || "openai-codex/gpt-5.6-luna";
const keep = process.env.PI_WORKGRAPH_KEEP_SMOKE === "1";
const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-real-"));
const root = join(parent, "fixture");

async function git(...args: string[]): Promise<string> {
  const result = await runProcess("git", ["-C", root, ...args], { cwd: root, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

try {
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
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  parentSession.appendMessage(acknowledgement);
  const parentSessionFile = parentSession.getSessionFile();
  if (!parentSessionFile) throw new Error("Could not create the parent smoke session.");

  const repositoryInfo = await GitRepository.inspect(root);
  const begun = await WorkgraphEngine.begin({
    request: "Apply the two exact values established in the inherited parent trajectory to src/a.txt and src/b.txt.",
    projectRoot: root,
    gitCommonDir: repositoryInfo.commonDir,
    parentSessionId: parentSession.getSessionId(),
    parentSessionFile,
    baseCommit: repositoryInfo.head,
    runId: `real-${Date.now().toString(36)}`,
  });

  console.log(JSON.stringify({ event: "begun", runId: begun.run.runId, root }));
  let run = await begun.engine.discover({
    investigations: [
      { id: "mechanism", lens: "how and ownership", objective: "Identify the target files, their current state, and the smallest independent ownership split." },
      { id: "intent", lens: "why and adversarial scope", objective: "Recover the two exact values from inherited context and identify any material ambiguity or scope risk." },
    ],
    model: guideModel,
    thinking: "high",
  });
  console.log(JSON.stringify({ event: "discovered", phase: run.phase, reports: run.discoveries.map((item) => item.report?.summary ?? item.error) }));
  if (run.discoveries.some((item) => item.state !== "completed")) throw new Error("Real discovery did not complete.");

  run = await begun.engine.recordAgreement({
    outcome: "src/a.txt contains ORBIT and src/b.txt contains MOON.",
    nonGoals: ["No changes to fixture instructions or verification scripts."],
    reuseDecision: "Use the existing files and shell checks without introducing code or dependencies.",
    structure: "Node alpha owns src/a.txt and node beta owns src/b.txt.",
    expectedScale: "Two independent one-line file changes and two commits before composition.",
    verificationBoundary: "Each worktree runs its owned script, and the composed root runs both scripts before read-only assurance.",
    verificationCommands: ["./verify-a.sh", "./verify-b.sh"],
    unresolvedDecisions: [],
  }, true, "Real smoke fixture approval supplied by the explicitly invoked test harness.");
  console.log(JSON.stringify({ event: "approved", phase: run.phase }));

  run = await begun.engine.execute({
    nodes: [
      {
        id: "alpha",
        objective: "Set src/a.txt to the first exact value established in the inherited parent trajectory.",
        claimedPaths: ["src/a.txt"],
        dependencies: [],
        verificationCommands: ["./verify-a.sh"],
        supersedes: [],
        guideModel,
        executorModel,
        guideThinking: "high",
        executorThinking: "high",
      },
      {
        id: "beta",
        objective: "Set src/b.txt to the second exact value established in the inherited parent trajectory.",
        claimedPaths: ["src/b.txt"],
        dependencies: [],
        verificationCommands: ["./verify-b.sh"],
        supersedes: [],
        guideModel,
        executorModel,
        guideThinking: "high",
        executorThinking: "high",
      },
    ],
    maxConcurrency: 2,
  });
  console.log(JSON.stringify({
    event: "executed",
    phase: run.phase,
    nodes: run.nodes.map((node) => ({ id: node.id, state: node.state, commit: node.commit, models: node.models, error: node.error })),
    composedCommit: run.composedCommit,
  }));
  if (run.phase !== "awaiting_assurance") throw new Error(`Real execution stopped in ${run.phase}.`);

  run = await begun.engine.assure({ model: guideModel, thinking: "high" });
  const result = {
    event: "assured",
    phase: run.phase,
    runId: run.runId,
    baseCommit: run.baseCommit,
    composedCommit: run.composedCommit,
    values: {
      a: (await readFile(join(root, "src", "a.txt"), "utf8")).trim(),
      b: (await readFile(join(root, "src", "b.txt"), "utf8")).trim(),
    },
    discoveries: run.discoveries,
    nodes: run.nodes,
    composition: run.composition,
    globalVerification: run.globalVerification,
    assurance: run.assurance,
    statePath: run.statePath,
    fixtureRoot: root,
  };
  console.log(JSON.stringify(result));
  if (run.phase !== "complete") throw new Error(`Assurance stopped in ${run.phase}.`);
  if (result.values.a !== "ORBIT" || result.values.b !== "MOON") throw new Error("Composed values are incorrect.");
} finally {
  if (keep) console.error(`Preserved smoke fixture: ${parent}`);
  else await rm(parent, { recursive: true, force: true });
}
