import { relative, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pathIsClaimed } from "../src/scheduler.js";
import type { EnvelopeImpact, ReportKind, WorkerReport } from "../src/types.js";

const mode = readMode();
const runId = process.env.PI_WORKGRAPH_RUN_ID || "unknown-run";
const nodeId = process.env.PI_WORKGRAPH_NODE_ID || "unknown-node";
const executorModel = process.env.PI_WORKGRAPH_EXECUTOR_MODEL || "";
const executorThinking = process.env.PI_WORKGRAPH_EXECUTOR_THINKING || "high";
const baseCommit = process.env.PI_WORKGRAPH_BASE_COMMIT || "";
const allowedPaths = readAllowedPaths();

const EvidenceSchema = Type.Object({
  label: Type.String(),
  observation: Type.String(),
  command: Type.Optional(Type.String()),
});

const FindingSchema = Type.Object({
  severity: StringEnum(["info", "warning", "error", "blocker"] as const),
  title: Type.String(),
  detail: Type.String(),
  envelopeImpact: StringEnum([
    "none",
    "outcome",
    "non_goal",
    "owner",
    "public_interface",
    "dependency",
    "security",
    "scale",
    "reuse",
  ] as const),
});

const ReportSchema = Type.Object({
  kind: StringEnum(["discovery", "implementation", "assurance"] as const),
  status: StringEnum(["completed", "escalated", "failed"] as const),
  summary: Type.String(),
  evidence: Type.Array(EvidenceSchema, { maxItems: 20 }),
  findings: Type.Array(FindingSchema, { maxItems: 20 }),
  commit: Type.Optional(Type.String()),
  changedFiles: Type.Optional(Type.Array(Type.String())),
});

const TodoSchema = Type.Object({
  items: Type.Array(Type.String({ minLength: 3 }), { minItems: 1, maxItems: 8 }),
});

export default function workgraphWorker(pi: ExtensionAPI): void {
  let phase: "guide" | "executor" = mode === "implementation" ? "guide" : "executor";
  let todos: string[] = [];
  let switchError: string | undefined;
  let switchedAt: string | undefined;

  pi.registerTool({
    name: "workgraph_todo",
    label: "Workgraph TODO",
    description: "Record the bounded local implementation TODO list before the first edit.",
    parameters: TodoSchema,
    async execute(_toolCallId, params) {
      if (mode !== "implementation") throw new Error("workgraph_todo is only available during implementation.");
      if (phase !== "guide") throw new Error("The Local Prewalk TODO list is already fixed for this assignment.");
      todos = [...params.items];
      pi.appendEntry("pi-workgraph-worker-state", {
        runId,
        nodeId,
        phase,
        todos,
      });
      return {
        content: [{ type: "text", text: `Recorded ${todos.length} Local Prewalk TODO item(s).` }],
        details: { items: todos },
      };
    },
  });

  pi.registerTool({
    name: "workgraph_report",
    label: "Workgraph Report",
    description: "Return the typed terminal report for this bounded Workgraph assignment.",
    parameters: ReportSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.kind !== mode) throw new Error(`Report kind must be ${mode}.`);
      if (mode === "implementation" && params.status === "completed") {
        if (todos.length === 0) throw new Error("A completed implementation requires a Local Prewalk TODO list.");
        if (phase !== "executor") throw new Error("A completed implementation can only be reported after the first-edit model transition.");
        if (switchError) throw new Error(`Executor model transition failed: ${switchError}`);
        if (!baseCommit) throw new Error("PI_WORKGRAPH_BASE_COMMIT is required for implementation reports.");
        const status = await git(pi, ctx.cwd, ["status", "--porcelain", "--untracked-files=all"], true);
        if (status) throw new Error(`Commit the implementation and leave a clean worktree before reporting:\n${status}`);
        const commit = await git(pi, ctx.cwd, ["rev-parse", "HEAD"]);
        if (commit === baseCommit) throw new Error("A completed implementation requires one new commit.");
        const changedText = await git(pi, ctx.cwd, ["diff", "--name-only", "--no-renames", baseCommit, commit], true);
        const changedFiles = changedText ? changedText.split("\n").filter(Boolean).sort() : [];
        const outside = changedFiles.filter((path) => !pathIsClaimed(path, allowedPaths));
        if (outside.length > 0) throw new Error(`Changed files exceed this node's claimed paths: ${outside.join(", ")}`);
        const report: WorkerReport = {
          ...params,
          kind: mode,
          commit,
          changedFiles,
        };
        return terminalReport(report, { todos, switchedAt });
      }

      if (mode !== "implementation") {
        const status = await git(pi, ctx.cwd, ["status", "--porcelain", "--untracked-files=all"], true);
        if (status) throw new Error(`${mode} workers are read-only, but the repository is dirty:\n${status}`);
      }
      const report: WorkerReport = { ...params, kind: mode };
      return terminalReport(report, { todos, switchedAt, switchError });
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "workgraph_report") {
      const status = (event.input as { status?: string }).status;
      if (mode === "implementation" && status === "completed" && phase !== "executor") {
        return { block: true, reason: "Complete the first-edit model transition before reporting completion." };
      }
      return;
    }

    if (mode !== "implementation") {
      if (event.toolName === "edit" || event.toolName === "write") {
        return { block: true, reason: `${mode} assignments are read-only.` };
      }
      if (event.toolName === "bash" && !isReadOnlyCommand(String((event.input as { command?: unknown }).command ?? ""))) {
        return { block: true, reason: `${mode} assignments permit only simple read-only shell commands.` };
      }
      return;
    }

    if (event.toolName === "edit" || event.toolName === "write") {
      if (phase === "guide" && todos.length === 0) {
        return { block: true, reason: "Record a bounded TODO list with workgraph_todo before the first edit." };
      }
      const rawPath = (event.input as { path?: unknown }).path;
      if (typeof rawPath !== "string") return { block: true, reason: "A file mutation requires a path." };
      const path = repositoryRelativePath(ctx.cwd, rawPath);
      if (!path || !pathIsClaimed(path, allowedPaths)) {
        return { block: true, reason: `Path ${rawPath} is outside this node's claimed paths: ${allowedPaths.join(", ")}` };
      }
    }

    if (event.toolName === "bash") {
      const command = String((event.input as { command?: unknown }).command ?? "");
      if (phase === "guide" && !isReadOnlyCommand(command)) {
        return { block: true, reason: "The guide phase is read-only except for the first edit through edit or write." };
      }
      if (forbiddenGitControlCommand(command)) {
        return { block: true, reason: "Worker branches cannot rewrite history, change branches, or manage worktrees." };
      }
    }
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (mode !== "implementation" || phase !== "guide" || event.isError) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    phase = "executor";
    try {
      const [provider, modelId] = splitModel(executorModel);
      const model = ctx.modelRegistry.find(provider, modelId);
      if (!model) throw new Error(`Executor model is unavailable: ${executorModel}`);
      const selected = await pi.setModel(model);
      if (!selected) throw new Error(`Executor model has no usable credentials: ${executorModel}`);
      pi.setThinkingLevel(executorThinking as Parameters<typeof pi.setThinkingLevel>[0]);
      switchedAt = new Date().toISOString();
      pi.appendEntry("pi-workgraph-worker-state", {
        runId,
        nodeId,
        phase,
        todos,
        executorModel,
        executorThinking,
        switchedAt,
      });
    } catch (error) {
      switchError = error instanceof Error ? error.message : String(error);
      pi.appendEntry("pi-workgraph-worker-state", {
        runId,
        nodeId,
        phase,
        todos,
        switchError,
      });
    }
  });

  pi.on("context", (event) => {
    const withoutGuide = event.messages.filter((message) => {
      const custom = message as { role?: string; customType?: string };
      return !(phase === "executor" && custom.role === "custom" && custom.customType === "pi-workgraph-guide");
    });
    if (mode !== "implementation" || phase !== "executor") return { messages: withoutGuide };
    return {
      messages: [
        ...withoutGuide,
        {
          role: "custom" as const,
          customType: "pi-workgraph-executor",
          content: executorInstructions(),
          display: false,
          details: { runId, nodeId },
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on("before_agent_start", () => ({
    message: {
      customType: mode === "implementation" ? "pi-workgraph-guide" : `pi-workgraph-${mode}`,
      content: modeInstructions(),
      display: false,
      details: { runId, nodeId, mode },
    },
  }));
}

function terminalReport(report: WorkerReport, state: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: `${report.kind} ${report.status}: ${report.summary}` }],
    details: { report, state },
    terminate: true,
  };
}

function modeInstructions(): string {
  if (mode === "discovery") {
    return `[WORKGRAPH DISCOVERY]
Investigate only the assigned lens.
Use read-only repository evidence and distinguish observations, inferences, and unknowns.
Do not implement, edit files, or expand the question.
Finish by calling workgraph_report with kind discovery, concise evidence, and any envelope-changing findings.`;
  }
  if (mode === "assurance") {
    return `[WORKGRAPH ASSURANCE]
Review the composed result against the approved outcome and verification boundary.
Stay read-only and prioritize realistic correctness, integration, security, and scope failures.
Do not demand unrelated improvements.
Finish by calling workgraph_report with kind assurance and typed findings.`;
  }
  return `[WORKGRAPH LOCAL PREWALK - GUIDE PHASE]
Stay within node ${nodeId} and claimed path prefixes: ${allowedPaths.join(", ")}.
Inspect the inherited trajectory and current worktree before deciding how to proceed.
Call workgraph_todo with no more than eight concrete local items.
Then make the smallest useful first edit through edit or write.
The runtime will switch models after that edit.
If evidence requires changing the approved outcome, non-goal, owner, public interface, dependency, security guarantee, scale, or reuse decision, do not edit and report an escalation instead.
Do not report completion during the guide phase.`;
}

function executorInstructions(): string {
  return `[WORKGRAPH EXECUTOR PHASE]
Continue the same node trajectory after the guide's first edit.
Complete only the recorded TODOs needed for node ${nodeId} within: ${allowedPaths.join(", ")}.
Run the node verification commands from the objective.
Create exactly one commit directly on the provided worker branch and leave the worktree clean.
Then call workgraph_report with kind implementation, status completed, evidence, and findings.
If a required change crosses the approved envelope, stop and report status escalated with the applicable envelopeImpact.`;
}

async function git(pi: ExtensionAPI, cwd: string, args: string[], allowEmpty = false): Promise<string> {
  const result = await pi.exec("git", ["-C", cwd, ...args]);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  const output = result.stdout.trim();
  if (!allowEmpty && !output) throw new Error(`git ${args.join(" ")} returned no output.`);
  return output;
}

function repositoryRelativePath(cwd: string, rawPath: string): string | undefined {
  const absolute = resolve(cwd, rawPath.replace(/^@/, ""));
  const path = relative(cwd, absolute).replaceAll("\\", "/");
  if (!path || path === ".." || path.startsWith("../")) return undefined;
  return path;
}

function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || /[;&|><`\n]/.test(trimmed) || /\$\(/.test(trimmed) || /(?:^|\s)(?:--output(?:=|\s)|-o(?:\s|$))/.test(trimmed)) return false;
  return /^(pwd|ls|grep|cat|head|tail|wc|stat|file|du|git\s+(status|diff|show|log|rev-parse|ls-files|branch\s+--show-current))\b/.test(trimmed);
}

function forbiddenGitControlCommand(command: string): boolean {
  return /\bgit\s+(checkout|switch|reset|clean|rebase|merge|cherry-pick|worktree|branch\s+(-[dDmM]|--delete|--move))\b/.test(command);
}

function splitModel(selector: string): [string, string] {
  const slash = selector.indexOf("/");
  if (slash <= 0 || slash === selector.length - 1) throw new Error(`Model selector must be provider/model: ${selector}`);
  return [selector.slice(0, slash), selector.slice(slash + 1)];
}

function readMode(): ReportKind {
  const value = process.env.PI_WORKGRAPH_MODE;
  if (value === "discovery" || value === "implementation" || value === "assurance") return value;
  throw new Error(`Invalid PI_WORKGRAPH_MODE: ${value ?? "(missing)"}`);
}

function readAllowedPaths(): string[] {
  try {
    const parsed = JSON.parse(process.env.PI_WORKGRAPH_ALLOWED_PATHS || "[]") as unknown;
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) throw new Error();
    return parsed;
  } catch {
    throw new Error("PI_WORKGRAPH_ALLOWED_PATHS must be a JSON string array.");
  }
}

export function isEnvelopeChangingFinding(impact: EnvelopeImpact): boolean {
  return impact !== "none";
}
