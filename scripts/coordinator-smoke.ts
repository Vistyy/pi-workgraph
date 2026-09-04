import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../src/git.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guideModel = process.env.PI_WORKGRAPH_GUIDE_MODEL || "openai-codex/gpt-5.6-sol";
const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-coordinator-"));
const root = join(parent, "fixture");
const tools: string[] = [];
const confirmations: Array<{ title: string; message: string }> = [];
let statePath: string | undefined;
let stderr = "";

async function git(...args: string[]): Promise<string> {
  const result = await runProcess("git", ["-C", root, ...args], { cwd: root, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

try {
  await mkdir(join(root, "src"), { recursive: true });
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

  const child = spawn(process.env.PI_WORKGRAPH_PI_BIN || "pi", [
    "--mode", "rpc",
    "--session-dir", join(parent, "sessions"),
    "--model", guideModel,
    "--thinking", "high",
    "--no-extensions",
    "--extension", packageRoot,
  ], {
    cwd: root,
    env: process.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  let buffer = "";
  let finished = false;
  const completion = new Promise<void>((resolvePromise, reject) => {
    const deadline = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Coordinator RPC smoke timed out."));
    }, 20 * 60_000);
    deadline.unref();

    const processLine = (line: string): void => {
      if (!line.trim()) return;
      let event: any;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "tool_execution_start" && typeof event.toolName === "string") tools.push(event.toolName);
      if ((event.type === "tool_result_end" || event.type === "message_end") && event.message?.role === "toolResult") {
        const path = event.message.details?.statePath;
        if (typeof path === "string") statePath = path;
      }
      if (event.type === "extension_ui_request" && event.method === "confirm") {
        confirmations.push({ title: event.title, message: event.message });
        child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, confirmed: true })}\n`);
      }
      if (event.type === "agent_end" && !finished) {
        finished = true;
        clearTimeout(deadline);
        resolvePromise();
      }
      if (event.type === "extension_error") {
        clearTimeout(deadline);
        reject(new Error(`Extension error in ${event.event}: ${event.error}`));
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (!finished) {
        clearTimeout(deadline);
        reject(new Error(`Coordinator Pi exited ${code}: ${stderr}`));
      }
    });
  });

  const prompt = `Use Workgraph for this request and do not stop before coordinator judgment returns complete.
Begin with a product_change outcome and the predicate that src/value.txt contains exactly AURORA followed by a newline and ./verify.sh succeeds at the composed revision.
Treat this as consequential enough for an agreement checkpoint so the orchestration boundary is exercised.
Run one partitioned discovery call with two bounded read-only responsibilities: mechanism and ownership, then intent and scope risk.
Use ${guideModel} with high thinking for both discovery responsibilities.
Present an agreement with no unresolved decisions, reuse the existing file and verify.sh, use command verification, describe running ./verify.sh as the verification procedure, and require its successful output as evidence.
Use one implementation node claiming only src/value.txt with a complete GOAL, SCOPE, CONTEXT, ACCEPTANCE, VERIFY, TIMEBOX, FORBIDDEN, and REPORT brief.
Use ./verify.sh for node and composed verification.
Use ${guideModel} as guide and openai-codex/gpt-5.6-luna as executor.
Record task-specific milestones as completed before assurance.
Run behavior, structure, and evidence assurance with ${guideModel}, then use openai-codex/gpt-5.6-luna for synthesis.
Finally call workgraph_judge and account for every candidate finding, accepting only concrete material findings.
Do not make direct coordinator product edits, and accept the UI response as the user's approval decision.`;
  child.stdin.write(`${JSON.stringify({ id: "smoke", type: "prompt", message: prompt })}\n`);
  await completion;
  child.kill("SIGTERM");
  await new Promise((resolvePromise) => child.once("close", resolvePromise));

  const expectedTools = ["workgraph_begin", "workgraph_discover", "workgraph_agree", "workgraph_execute", "workgraph_progress", "workgraph_assure", "workgraph_judge"];
  for (const tool of expectedTools) {
    if (!tools.includes(tool)) throw new Error(`Coordinator did not call ${tool}. Called: ${tools.join(", ")}`);
  }
  if (confirmations.length !== 1) throw new Error(`Expected one approval confirmation, observed ${confirmations.length}. Tools: ${tools.join(", ")}. Prompts: ${JSON.stringify(confirmations)}`);
  if (!statePath) throw new Error("Coordinator did not expose the durable Workgraph state path.");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const value = await readFile(join(root, "src", "value.txt"), "utf8");
  if (state.phase !== "complete") throw new Error(`Coordinator Workgraph ended in ${state.phase}.`);
  if (value !== "AURORA\n") throw new Error(`Coordinator composed the wrong value: ${JSON.stringify(value)}`);
  console.log(JSON.stringify({
    phase: state.phase,
    tools,
    approvalPrompts: confirmations.length,
    nodeModels: state.nodes.map((node: any) => node.models),
    value: value.trim(),
    globalVerification: state.globalVerification,
    assuranceFindings: state.assurance?.reviews?.flatMap((review: any) => review.report?.findings ?? []),
    usage: {
      discoveries: state.discoveries.map((item: any) => item.usage),
      nodes: state.nodes.map((item: any) => item.usage),
      assuranceReviews: state.assurance?.reviews?.map((review: any) => review.usage),
      assuranceSynthesis: state.assurance?.synthesis?.usage,
    },
  }));
} finally {
  await rm(parent, { recursive: true, force: true });
}
