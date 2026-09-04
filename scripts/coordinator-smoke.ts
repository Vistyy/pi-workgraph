import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../src/git.js";
import type { CoordinatorBoundaryKind, WorkgraphRun } from "../src/types.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guideModel = process.env.PI_WORKGRAPH_GUIDE_MODEL || "openai-codex/gpt-5.6-sol";
const executorModel = process.env.PI_WORKGRAPH_EXECUTOR_MODEL || "openai-codex/gpt-5.6-luna";
const keep = process.env.PI_WORKGRAPH_KEEP_SMOKE === "1";
const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-coordinator-"));
const root = join(parent, "fixture");
const agentDir = join(parent, "agent");
const tools: string[] = [];
const wakes: CoordinatorBoundaryKind[] = [];
const wakeTurnObservations: Array<{ kind: CoordinatorBoundaryKind; wakeEvent: number; turnStart?: number }> = [];
const promptIds: string[] = [];
let statePath: string | undefined;
let workspaceId: string | undefined;
let child: ChildProcessWithoutNullStreams | undefined;
let stderr = "";
let agentSettledSequence = 0;
let lastAssistantText = "";
let approvalPending = false;
let runCompleted = false;
let stopping = false;
let eventSequence = 0;
let turnSequence = 0;

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

function sendPrompt(id: string, message: string, streamingBehavior?: "steer" | "followUp"): void {
  promptIds.push(id);
  child!.stdin.write(`${JSON.stringify({ id, type: "prompt", message, ...(streamingBehavior ? { streamingBehavior } : {}) })}\n`);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string"))
    .map((part) => part.text)
    .join("\n");
}

function processEvent(event: Record<string, any>): void {
  eventSequence += 1;
  if (event.type === "response" && event.success === false) throw new Error(`RPC ${event.command} failed: ${event.error}`);
  if (event.type === "turn_start") {
    turnSequence += 1;
    for (const observation of wakeTurnObservations) {
      if (observation.turnStart === undefined && observation.wakeEvent < eventSequence) observation.turnStart = turnSequence;
    }
  }
  if (event.type === "tool_execution_start" && typeof event.toolName === "string") tools.push(event.toolName);
  if (event.type === "agent_settled") {
    agentSettledSequence += 1;
    if (approvalPending && !promptIds.includes("approval")) {
      approvalPending = false;
      sendPrompt("approval", "approved");
    }
  }
  if (event.type === "extension_error") throw new Error(`Extension error in ${event.event}: ${event.error}`);

  const message = event.message as Record<string, any> | undefined;
  if (event.type === "message_end" && message?.role === "assistant") {
    lastAssistantText = messageText(message.content) || String(message.errorMessage ?? "");
  }
  if ((event.type === "tool_execution_end") && event.result?.details) inspectToolResult(event.toolName, event.result.details);
  if ((event.type === "tool_result_end" || event.type === "message_end") && message?.role === "toolResult") inspectToolResult(message.toolName, message.details);
  if (event.type === "message_end" && message?.role === "user") {
    const text = messageText(message.content);
    const match = text.match(/^\[WORKGRAPH AUTOMATIC EXTENSION CONTINUATION\]\nWorkgraph \S+ reached (agreement|settle|verification|assurance|judgment) boundary /);
    if (match?.[1]) {
      const kind = match[1] as CoordinatorBoundaryKind;
      wakes.push(kind);
      wakeTurnObservations.push({ kind, wakeEvent: eventSequence });
    }
  }
}

function inspectToolResult(toolName: unknown, details: Record<string, any> | undefined): void {
  if (!details) return;
  if (typeof details.statePath === "string") statePath = details.statePath;
  if (toolName === "workgraph_plan" && details.plan?.status === "proposed" && !promptIds.includes("approval")) approvalPending = true;
}

function diagnostics(run?: WorkgraphRun): string {
  return JSON.stringify({
    fixturePath: root,
    statePath,
    coordinatorSession: run?.coordinator ?? null,
    phase: run?.phase ?? null,
    revision: run?.revision ?? null,
    composedCommit: run?.composedCommit ?? null,
    models: { guide: guideModel, executor: executorModel },
    lastAssistantText: lastAssistantText.slice(-1_000),
    wakes: run?.coordinatorWakeups?.slice(-5).map((wake) => ({ id: wake.id, kind: wake.kind, state: wake.state, error: wake.error })) ?? wakes.slice(-5),
    attempts: run?.attempts?.slice(-8).map((attempt) => ({ id: attempt.id, nodeId: attempt.nodeId, mode: attempt.mode, state: attempt.state, stage: attempt.stage, model: attempt.model, executorModel: attempt.executorModel, observedStatus: attempt.observedStatus, error: attempt.error })) ?? [],
    cleanup: run?.cleanup?.slice(-12).map((record) => ({ id: record.id, attemptId: record.attemptId, kind: record.kind, state: record.state, detail: record.detail, error: record.error })) ?? [],
  });
}

function failure(message: string, run?: WorkgraphRun): Error {
  return new Error(`${message} Diagnostics: ${diagnostics(run)}`);
}

async function waitForCompletion(timeoutMs = 30 * 60_000): Promise<WorkgraphRun> {
  const deadline = Date.now() + timeoutMs;
  let last: WorkgraphRun | undefined;
  while (Date.now() < deadline) {
    if (!statePath && agentSettledSequence > 0) throw failure(`Coordinator settled before beginning a Workgraph. stderr: ${stderr || "empty"}`);
    if (statePath) {
      last = JSON.parse(await readFile(statePath, "utf8")) as WorkgraphRun;
      if (["revision_required", "needs_decision", "assurance_inconclusive", "failed"].includes(last.phase)) {
        throw failure(`Coordinator Workgraph reached ${last.phase}: ${last.error ?? last.productVerification?.error ?? "no retained error"}`, last);
      }
      const agreementWake = (last.coordinatorWakeups ?? []).find((wake) => wake.kind === "agreement" && wake.state === "delivered");
      if (last.phase === "awaiting_agreement" && agreementWake?.deliveredAt && Date.now() - Date.parse(agreementWake.deliveredAt) > 30_000 && !tools.includes("workgraph_plan")) {
        throw failure("Agreement wake did not resume coordinator planning.", last);
      }
      if (last.phase === "complete" && (last.cleanup ?? []).length > 0 && (last.cleanup ?? []).every((record) => record.state === "completed")) return last;
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw failure(`Coordinator RPC smoke timed out${last ? ` in ${last.phase} with ${last.control.executionStatus}` : " before exposing state"}.`, last);
}

async function linkIfPresent(source: string, target: string): Promise<void> {
  try {
    await access(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await symlink(source, target);
}

try {
  if (process.env.HERDR_ENV !== "1") throw new Error("smoke:coordinator requires a Herdr-managed environment so scheduled workers are visible.");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(root, "AGENTS.md"), `# Fixture instructions

Use the requested Workgraph flow end to end.
Keep changes minimal and use the Workgraph terminal report tools in child assignments.
`);
  await writeFile(join(root, "src", "value.txt"), "unset\n");
  await writeFile(join(root, "verify.sh"), "#!/usr/bin/env bash\ntest \"$(cat src/value.txt)\" = AURORA\n", { mode: 0o755 });
  await runProcess("git", ["init", "-b", "main", root], { cwd: parent, timeoutMs: 30_000 });
  await git("config", "user.email", "workgraph@example.test");
  await git("config", "user.name", "Workgraph Coordinator Smoke");
  await git("add", ".");
  await git("commit", "-m", "Create coordinator fixture");

  const prior = await herdr("workspace", "list");
  const priorIds = new Set((prior.result.workspaces ?? []).map((item: Record<string, unknown>) => String(item.workspace_id ?? item.id)));
  const created = await herdr("workspace", "create", "--cwd", root, "--label", `Workgraph coordinator smoke ${Date.now()}`, "--no-focus");
  workspaceId = String(created.result.workspace.workspace_id ?? created.result.workspace.id);
  if (!workspaceId || priorIds.has(workspaceId) || workspaceId === process.env.HERDR_WORKSPACE_ID) throw new Error("Herdr did not create a distinct disposable coordinator-smoke workspace.");

  const sourceAgentDir = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
  await linkIfPresent(join(sourceAgentDir, "auth.json"), join(agentDir, "auth.json"));
  await linkIfPresent(join(sourceAgentDir, "models.json"), join(agentDir, "models.json"));
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PI_AGENT_DIR: agentDir,
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: workspaceId,
    PI_WORKGRAPH_GUIDE_MODEL: guideModel,
    PI_WORKGRAPH_EXECUTOR_MODEL: executorModel,
  };
  delete childEnv.HERDR_PANE_ID;
  delete childEnv.PI_WORKGRAPH_MODE;
  delete childEnv.PI_WORKGRAPH_RUN_ID;
  delete childEnv.PI_WORKGRAPH_NODE_ID;
  delete childEnv.PI_WORKGRAPH_BASE_COMMIT;
  delete childEnv.PI_WORKGRAPH_RESPONSIBILITY;
  delete childEnv.PI_WORKGRAPH_IMPLEMENTATION_START;

  child = spawn(process.env.PI_WORKGRAPH_PI_BIN || "pi", [
    "--mode", "rpc",
    "--session-dir", join(parent, "sessions"),
    "--model", guideModel,
    "--thinking", "high",
    "--no-extensions",
    "--extension", join(packageRoot, "extensions", "coordinator.ts"),
    "--approve",
  ], { cwd: root, env: childEnv, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-50 * 1024); });
  let buffer = "";
  let protocolFailure: Error | undefined;
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      try { processEvent(JSON.parse(line) as Record<string, any>); }
      catch (error) { protocolFailure = error instanceof Error ? error : new Error(String(error)); }
    }
  });
  let processFailure: Error | undefined;
  child.on("error", (error) => { processFailure = error; });
  child.on("close", (code) => {
    if (!stopping && !runCompleted) processFailure = new Error(`Coordinator Pi exited ${code ?? "without a code"} before completion: ${stderr || "empty stderr"}`);
  });

  const prompt = `Use Workgraph for this request and continue whenever a pi-workgraph-coordinator-wake message arrives.
Begin a product_change Workgraph whose outcome is that src/value.txt contains exactly AURORA followed by a newline and whose completion predicate also requires ./verify.sh to succeed at the composed revision.
Declare milestones discover, implement, verify, and assure.
Queue replicated discovery with panel size 2 and the identical question: identify the exact requested value, target file, smallest ownership boundary, and material scope risk.
Do not call workgraph_synthesize; the two completed replicated reports are sufficient for this bounded fixture.
After any asynchronous queueing tool returns, end that response and wait for the next matching coordinator-wake message before calling a later-phase tool.
At the agreement wake, immediately propose an initial plan with no unresolved decisions, reuse src/value.txt and verify.sh, claim one node owns src/value.txt, use independent verification, describe running ./verify.sh and inspecting the exact composed value as the verification procedure, and require both as evidence.
Wait for the exact subsequent user message approved before scheduling.
After approval, schedule one implementation node that claims only src/value.txt, writes exactly AURORA followed by a newline, runs ./verify.sh, uses ${guideModel} as guide and ${executorModel} as executor with high thinking, and returns the exact commit and verification.
At the settle wake, call workgraph_settle.
At the verification wake, call workgraph_verify with ${guideModel} and high thinking.
At the assurance wake, first mark discover, implement, and verify complete, then call workgraph_assure using ${guideModel} with high thinking for behavior, structure, evidence, and synthesis.
At the judgment wake, first mark assure complete, then inspect every synthesized disposition and call workgraph_judge accounting for every finding, dismissing unsupported or optional findings and accepting only concrete required corrections.
Do not edit product files directly, do not call removed workgraph_agree or workgraph_execute tools, and do not ask the user to nudge an already approved run.`;
  sendPrompt("initial", prompt);

  const run = await Promise.race([
    waitForCompletion(),
    new Promise<never>((_resolve, reject) => {
      const interval = setInterval(() => {
        if (protocolFailure || processFailure) {
          clearInterval(interval);
          reject(protocolFailure ?? processFailure);
        }
      }, 100);
      interval.unref();
    }),
  ]);
  runCompleted = true;

  const expectedTools = ["workgraph_begin", "workgraph_discover", "workgraph_plan", "workgraph_schedule", "workgraph_settle", "workgraph_verify", "workgraph_progress", "workgraph_assure", "workgraph_judge"];
  for (const tool of expectedTools) if (!tools.includes(tool)) throw new Error(`Coordinator did not call ${tool}. Called: ${tools.join(", ")}`);
  for (const kind of ["agreement", "settle", "verification", "assurance", "judgment"] as const) if (!wakes.includes(kind)) throw new Error(`Coordinator did not receive the ${kind} wake. Received: ${wakes.join(", ")}`);
  for (const kind of ["agreement", "settle", "verification", "assurance", "judgment"] as const) {
    const observation = wakeTurnObservations.find((candidate) => candidate.kind === kind);
    if (!observation?.turnStart) throw new Error(`The ${kind} wake was not followed by an observed coordinator turn. Sequence: ${JSON.stringify(wakeTurnObservations)}`);
  }
  const durableWakes = run.coordinatorWakeups ?? [];
  if (durableWakes.some((wake) => wake.state !== "delivered")) throw new Error(`Coordinator retained an undelivered wake: ${JSON.stringify(durableWakes)}`);
  if (new Set(durableWakes.map((wake) => wake.id)).size !== durableWakes.length) throw new Error("Coordinator retained duplicate wake identities.");
  for (const kind of ["agreement", "settle", "verification", "assurance", "judgment"] as const) if (!durableWakes.some((wake) => wake.kind === kind)) throw new Error(`Coordinator did not retain the ${kind} wake.`);
  if (promptIds.join(",") !== "initial,approval") throw new Error(`Harness supplied an unexpected manual nudge: ${promptIds.join(",")}`);
  if (run.humanDecisions.filter((decision) => decision.accepted).at(-1)?.prompt !== "approved") throw new Error("Coordinator did not retain the exact approval message.");
  if (run.milestones.some((milestone) => milestone.status !== "completed")) throw new Error(`Coordinator left a milestone incomplete: ${JSON.stringify(run.milestones)}`);
  if (run.productVerification?.state !== "completed" || run.productVerification.method !== "independent" || run.productVerification.report?.verdict !== "verified") throw new Error(`Independent verification did not complete: ${JSON.stringify(run.productVerification)}`);
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
  const value = await readFile(join(root, "src", "value.txt"), "utf8");
  if (value !== "AURORA\n") throw new Error(`Coordinator composed the wrong value: ${JSON.stringify(value)}`);
  const tabs = (await herdr("tab", "list", "--workspace", workspaceId)).result.tabs as Array<Record<string, unknown>>;
  if (tabs.length !== 1) throw new Error(`Disposable workspace retained ${tabs.length - 1} worker tab(s).`);

  console.log(JSON.stringify({
    phase: run.phase,
    workspaceId,
    coordinator: { mode: "rpc", sessionId: run.coordinator.sessionId, sessionFile: run.coordinator.sessionFile },
    prompts: promptIds,
    wakes: durableWakes.map((wake) => ({ id: wake.id, kind: wake.kind, state: wake.state })),
    wakeToTurn: wakeTurnObservations,
    tools,
    workers: visibleAttempts.map((attempt) => ({ mode: attempt.mode, nodeId: attempt.nodeId, tabId: attempt.worker?.tabId, paneId: attempt.worker?.paneId, sessionFile: attempt.worker?.sessionFile })),
    cleanup: { attempts: visibleAttempts.length, records: run.cleanup?.length ?? 0, ordered: true },
    value: value.trim(),
    verification: { method: run.productVerification.method, state: run.productVerification.state, verdict: run.productVerification.report?.verdict, commands: run.productVerification.commands },
    assurance: { state: run.assurance.state, reviews: run.assurance.reviews.length, judgments: run.assurance.finalJudgment?.judgments.length ?? 0 },
  }));
} finally {
  stopping = true;
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => {
      const timeout = setTimeout(resolvePromise, 5_000);
      child!.once("close", () => { clearTimeout(timeout); resolvePromise(); });
    });
  }
  if (workspaceId) await herdr("workspace", "close", workspaceId).catch(() => undefined);
  if (keep) console.error(`Preserved coordinator smoke fixture: ${parent}`);
  else await rm(parent, { recursive: true, force: true });
}
