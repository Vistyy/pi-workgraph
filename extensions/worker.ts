import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { reportSchemaForMode } from "../src/report-schema.js";
import type { AssuranceResponsibility, EnvelopeImpact, ImplementationReport, WorkerMode, WorkerReport } from "../src/types.js";

const configuredMode = readMode();
const mode = configuredMode ?? "discovery";
const runId = process.env.PI_WORKGRAPH_RUN_ID || "unknown-run";
const nodeId = process.env.PI_WORKGRAPH_NODE_ID || "unknown-node";
const responsibility = process.env.PI_WORKGRAPH_RESPONSIBILITY || "";
const executorModel = process.env.PI_WORKGRAPH_EXECUTOR_MODEL || "";
const executorThinking = process.env.PI_WORKGRAPH_EXECUTOR_THINKING || "high";
const baseCommit = process.env.PI_WORKGRAPH_BASE_COMMIT || "";
const startInExecutor = process.env.PI_WORKGRAPH_IMPLEMENTATION_START === "executor";

const ReportSchema = reportSchemaForMode(mode);

const TodoSchema = Type.Object({
  items: Type.Array(Type.String({ minLength: 3 }), { minItems: 1, maxItems: 8 }),
});

export default function workgraphWorker(pi: ExtensionAPI): void {
  if (!configuredMode) return;
  let phase: "guide" | "executor" = mode === "implementation" && !startInExecutor ? "guide" : "executor";
  let todos: string[] = [];
  let switchError: string | undefined;
  let switchedAt: string | undefined = startInExecutor ? new Date().toISOString() : undefined;

  pi.registerTool({
    name: "workgraph_todo",
    label: "Workgraph TODO",
    description: "Record the bounded local implementation TODO list before the first edit.",
    parameters: TodoSchema,
    async execute(_toolCallId, params) {
      if (mode !== "implementation") throw new Error("workgraph_todo is only available during implementation.");
      if (phase !== "guide") throw new Error("A Local Prewalk TODO list can only be recorded before the first edit.");
      todos = [...params.items];
      pi.appendEntry("pi-workgraph-worker-state", { runId, nodeId, phase, todos });
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
      if (mode === "assurance_review" && params.kind === mode) {
        if (params.responsibility !== responsibility) throw new Error(`Assurance responsibility must be ${responsibility}.`);
        const invalidId = params.findings.find((finding) => !finding.id.startsWith(`${responsibility}-`));
        if (invalidId) throw new Error(`Assurance finding ids must start with ${responsibility}-: ${invalidId.id}`);
      }
      if (mode === "implementation" && params.kind === mode && params.status === "completed") {
        if (phase !== "executor") throw new Error("A completed implementation can only be reported after the first-edit model transition.");
        if (switchError) throw new Error(`Executor model transition failed: ${switchError}`);
        if (!baseCommit) throw new Error("PI_WORKGRAPH_BASE_COMMIT is required for implementation reports.");
        const status = await git(pi, ctx.cwd, ["status", "--porcelain", "--untracked-files=all"], true);
        if (status) throw new Error(`Commit the implementation and leave a clean worktree before reporting:\n${status}`);
        const commit = await git(pi, ctx.cwd, ["rev-parse", "HEAD"]);
        if (commit === baseCommit) throw new Error("A completed implementation requires one new commit.");
        const changedText = await git(pi, ctx.cwd, ["diff", "--name-only", "--no-renames", baseCommit, commit], true);
        const changedFiles = changedText ? changedText.split("\n").filter(Boolean).sort() : [];
        const report: ImplementationReport = { ...params, commit, changedFiles };
        return terminalReport(report, { todos, todoRecorded: todos.length > 0, switchedAt, continued: startInExecutor });
      }

      if (mode !== "implementation") {
        const status = await git(pi, ctx.cwd, ["status", "--porcelain", "--untracked-files=all"], true);
        if (status) throw new Error(`${mode} workers are read-only for product files, but the repository is dirty:\n${status}`);
      }
      return terminalReport(params as WorkerReport, { todos, switchedAt, switchError });
    },
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
      pi.appendEntry("pi-workgraph-worker-state", { runId, nodeId, phase, todos, executorModel, executorThinking, switchedAt });
    } catch (error) {
      switchError = error instanceof Error ? error.message : String(error);
      pi.appendEntry("pi-workgraph-worker-state", { runId, nodeId, phase, todos, switchError });
    }
  });

  pi.on("agent_start", async () => {
    pi.appendEntry("pi-workgraph-agent-running", { runId, nodeId, startedAt: new Date().toISOString() });
  });

  pi.on("agent_settled", async () => {
    pi.appendEntry("pi-workgraph-agent-settled", { runId, nodeId, settledAt: new Date().toISOString() });
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
      customType: mode === "implementation" && phase === "guide" ? "pi-workgraph-guide" : `pi-workgraph-${mode}`,
      content: modeInstructions(),
      display: false,
      details: { runId, nodeId, mode, responsibility },
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

export function verificationWorkerInstructions(): string {
  return `[WORKGRAPH PRODUCT VERIFICATION - ASSIGNED VERIFIER]\nThis session is already the independent product-verification worker assigned by Workgraph for the objective.\nDirectly execute the supplied verification procedure and report what you observe.\nDo not create, adopt, plan, schedule, verify, assure, judge, or otherwise coordinate another Workgraph, and do not delegate this assignment.\nDo not edit product files.\nUse the real product surface when commands alone cannot prove the behavior.\nRecord concrete artifacts such as screenshots, browser state, console or network output, traces, profiles, or stored values.\nDo not favor a verified verdict: return failed, inconclusive, or escalated when the observations warrant it.\nReturn inconclusive when the required browser, CLI, or TUI control surface is unavailable.\nReturn verified only when the evidence directly establishes the required scenarios.`;
}

function modeInstructions(): string {
  if (mode === "discovery") {
    return `[WORKGRAPH DISCOVERY]\nInvestigate only the assigned responsibility.\nUse read-only repository evidence and classify each item as direct, inference, conflict, or unknown.\nFor blast-radius-sensitive changes, identify and prove the external safety fact at the actual dependent boundary.\nDo not implement, edit files, or expand the question.\nFinish with a concise discovery report and account for unknowns that could change the implementation envelope.`;
  }
  if (mode === "review") {
    return `[WORKGRAPH REVIEW]\nInspect only the assigned subject and concern. Review the exact revision or proposal named in the assignment. Do not edit files or coordinate another Workgraph. Return concrete evidence and only actionable findings; zero findings is valid.`;
  }
  if (mode === "verification") return verificationWorkerInstructions();
  if (mode === "assurance_review") {
    return assuranceReviewInstructions(responsibility as AssuranceResponsibility);
  }
  if (mode === "assurance_synthesis") {
    return `[WORKGRAPH ASSURANCE SYNTHESIS]\nReconcile the three responsibility reports without inventing findings.\nDismiss duplicate, impossible, immaterial, speculative, stylistic, or unsupported findings.\nClassify a supported but non-required improvement as optional.\nAccept only findings whose invariant, evidence, reachable scenario, consequence, and simplest response establish required correction work.\nPrefer deletion and simpler ownership over additive correction.\nAPPROVE with no findings is valid.\nClassify an accepted envelope-changing finding as needs_decision and an accepted internal correction as revision_required.`;
  }
  if (startInExecutor) return executorInstructions();
  return `[WORKGRAPH LOCAL PREWALK - GUIDE PHASE]\nInspect the inherited trajectory and current worktree before deciding how to proceed.\nBefore the first edit, call workgraph_todo with no more than eight concrete local items.\nIf omitted, the report will honestly record that no Local Prewalk TODO list was supplied instead of blocking an otherwise valid implementation.\nThen make the smallest useful first edit through edit or write.\nThe runtime will switch models after that edit.\nIf evidence requires changing the approved envelope, do not edit and report an escalation instead.\nDo not report completion during the guide phase.`;
}

function assuranceReviewInstructions(role: AssuranceResponsibility): string {
  const focus = role === "behavior"
    ? "Inspect realistic correctness, integration, failures, concurrency, recovery, security, and performance only where relevant."
    : role === "structure"
      ? "Inspect deletion opportunities, simplicity, types, ownership, boundaries, abstractions, reader load, and maintainability."
      : "Inspect whether evidence proves distinct meaningful invariants without duplicate or implementation-detail test bloat.";
  return `[WORKGRAPH ASSURANCE - ${role.toUpperCase()}]\n${focus}\nStay within this responsibility and remain read-only.\nDo not seek a quota of issues, and treat approval with zero findings as a valid result.\nReject impossible, immaterial, duplicate, speculative, stylistic, or unsupported concerns.\nPrefix every finding id with ${role}-.\nEvery proposed finding must name the violated invariant, concrete evidence, a reachable scenario, material consequence, simplest response, confidence, envelope impact, and complexity effect.`;
}

function executorInstructions(): string {
  return `[WORKGRAPH EXECUTOR PHASE]\nContinue the same node trajectory${startInExecutor ? " from the retained implementer session" : " after the guide's first edit"}.\nComplete only the bounded brief for node ${nodeId}.\nRun the node verification commands from the objective.\nCreate exactly one commit directly on the provided worker branch and leave the worktree clean.\nThen return a completed implementation report with evidence.\nIf a required change crosses the approved envelope, stop and report an escalation.`;
}

async function git(pi: ExtensionAPI, cwd: string, args: string[], allowEmpty = false): Promise<string> {
  const result = await pi.exec("git", ["-C", cwd, ...args]);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  const output = result.stdout.trim();
  if (!allowEmpty && !output) throw new Error(`git ${args.join(" ")} returned no output.`);
  return output;
}

function splitModel(selector: string): [string, string] {
  const slash = selector.indexOf("/");
  if (slash <= 0 || slash === selector.length - 1) throw new Error(`Model selector must be provider/model: ${selector}`);
  return [selector.slice(0, slash), selector.slice(slash + 1)];
}

function readMode(): WorkerMode | undefined {
  const value = process.env.PI_WORKGRAPH_MODE;
  if (!value) return undefined;
  if (value === "discovery" || value === "review" || value === "implementation" || value === "verification" || value === "assurance_review" || value === "assurance_synthesis") return value;
  throw new Error(`Invalid PI_WORKGRAPH_MODE: ${value}`);
}

export function isEnvelopeChangingFinding(impact: EnvelopeImpact): boolean {
  return impact !== "none";
}
