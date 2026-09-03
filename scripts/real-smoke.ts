import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { WorkgraphEngine } from "../src/engine.js";
import { GitRepository, runProcess } from "../src/git.js";
import { loadModelPolicy, roleTargets } from "../src/model-policy.js";
import { getPlaybook } from "../src/playbooks.js";

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
  const featurePlaybook = getPlaybook("feature");
  const modelPolicy = await loadModelPolicy();
  const discoveryPanel = roleTargets(modelPolicy, "discovery.replicate");
  const begun = await WorkgraphEngine.begin({
    request: "Apply the two exact values established in the inherited parent trajectory to src/a.txt and src/b.txt.",
    projectRoot: root,
    gitCommonDir: repositoryInfo.commonDir,
    parentSessionId: parentSession.getSessionId(),
    parentSessionFile,
    baseCommit: repositoryInfo.head,
    runId: `real-${Date.now().toString(36)}`,
    playbook: {
      id: featurePlaybook.id,
      title: featurePlaybook.title,
      completionPredicate: "src/a.txt is ORBIT, src/b.txt is MOON, and the composed result passes both fixture checks.",
      steps: featurePlaybook.steps,
    },
  });

  console.log(JSON.stringify({ event: "begun", runId: begun.run.runId, root }));
  let run = await begun.engine.discover({
    topology: "replicate",
    assignments: [
      {
        id: "request-a",
        lens: "Independent replication 1 of 2",
        objective: "Identify the exact requested values, target files, smallest ownership split, and any material scope risk.",
        ...discoveryPanel[0]!,
      },
      {
        id: "request-b",
        lens: "Independent replication 2 of 2",
        objective: "Identify the exact requested values, target files, smallest ownership split, and any material scope risk.",
        ...discoveryPanel[1]!,
      },
    ],
  });
  console.log(JSON.stringify({ event: "discovered", phase: run.phase, reports: run.discoveries.map((item) => item.report?.summary ?? item.error) }));
  if (run.discoveries.some((item) => item.state !== "completed")) throw new Error("Real discovery did not complete.");

  run = await begun.engine.recordAgreement({
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
  }, true, "Real smoke fixture approval supplied by the explicitly invoked test harness.");
  console.log(JSON.stringify({ event: "approved", phase: run.phase }));

  const implementationNodes = [
    {
      id: "alpha",
      brief: {
        goal: "Set src/a.txt to the first exact value established in the inherited parent trajectory.",
        context: ["The inherited parent trajectory states that the first value is ORBIT."],
        acceptance: ["src/a.txt contains exactly ORBIT followed by a newline."],
        timeboxMinutes: 8,
        forbidden: ["Do not change fixture instructions, scripts, or src/b.txt."],
        report: "Return the exact commit, changed file, and verification result.",
      },
      claimedPaths: ["src/a.txt"],
      dependencies: [],
      verificationCommands: ["./verify-a.sh"],
      supersedes: [],
      guideModel,
      executorModel,
      guideThinking: "high" as const,
      executorThinking: "high" as const,
    },
    {
      id: "beta",
      brief: {
        goal: "Set src/b.txt to the second exact value established in the inherited parent trajectory.",
        context: ["The inherited parent trajectory states that the second value is MOON."],
        acceptance: ["src/b.txt contains exactly MOON followed by a newline."],
        timeboxMinutes: 8,
        forbidden: ["Do not change fixture instructions, scripts, or src/a.txt."],
        report: "Return the exact commit, changed file, and verification result.",
      },
      claimedPaths: ["src/b.txt"],
      dependencies: [],
      verificationCommands: ["./verify-b.sh"],
      supersedes: [],
      guideModel,
      executorModel,
      guideThinking: "high" as const,
      executorThinking: "high" as const,
    },
  ];
  run = await begun.engine.execute({ nodes: implementationNodes, maxConcurrency: 2 });
  console.log(JSON.stringify({
    event: "executed",
    phase: run.phase,
    nodes: run.nodes.map((node) => ({ id: node.id, state: node.state, commit: node.commit, models: node.models, error: node.error })),
    composedCommit: run.composedCommit,
  }));
  if (run.phase === "revision_required") {
    const failedIds = new Set(run.nodes.filter((node) => node.state === "failed").map((node) => node.id));
    const replacements = implementationNodes
      .filter((node) => failedIds.has(node.id))
      .map((node) => ({
        ...node,
        id: `${node.id}_retry`,
        brief: {
          ...node.brief,
          context: [...node.brief.context, "This is the single bounded replacement after the first worker process failed."],
        },
        supersedes: [node.id],
      }));
    if (replacements.length === 0) throw new Error("Real execution required revision without a replaceable failed node.");
    run = await begun.engine.execute({ nodes: replacements, maxConcurrency: 2 });
    console.log(JSON.stringify({
      event: "retried",
      phase: run.phase,
      nodes: run.nodes.map((node) => ({ id: node.id, state: node.state, commit: node.commit, error: node.error })),
      composedCommit: run.composedCommit,
    }));
  }
  if (run.phase !== "awaiting_assurance") throw new Error(`Real execution stopped in ${run.phase}.`);

  for (const step of featurePlaybook.steps) await begun.engine.recordProgress(step, "completed");
  run = await begun.engine.assure({
    reviewers: [
      { responsibility: "behavior", ...roleTargets(modelPolicy, "assurance.behavior")[0]! },
      { responsibility: "structure", ...roleTargets(modelPolicy, "assurance.structure")[0]! },
      { responsibility: "evidence", ...roleTargets(modelPolicy, "assurance.evidence")[0]! },
    ],
    synthesis: roleTargets(modelPolicy, "assurance.synthesis")[0]!,
  });
  if (run.phase !== "awaiting_judgment") throw new Error(`Assurance stopped in ${run.phase}.`);
  const dispositions = run.assurance?.synthesis?.report?.dispositions ?? [];
  run = await begun.engine.judgeAssurance({
    judgments: dispositions.map((item) => ({
      findingId: item.finding.id,
      disposition: item.disposition === "accept" ? "accept" as const : "dismiss" as const,
      reason: `Coordinator accepted the synthesizer's evidence classification (${item.disposition}): ${item.reason}`,
    })),
  });
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
