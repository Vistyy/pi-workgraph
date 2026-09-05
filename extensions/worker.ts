import type {
  ExtensionAPI,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ThinkingSchema } from "../src/model-policy.js";
import { isWorkerReport, reportSchemaForMode } from "../src/report-schema.js";
import type {
  ImplementationReport,
  WorkerMode,
  WorkerReport,
} from "../src/types.js";

export default function workgraphWorker(pi: ExtensionAPI): void {
  const mode = readMode();
  if (!mode) return;
  const runId = process.env.PI_WORKGRAPH_RUN_ID || "unknown-workstream";
  const nodeId = process.env.PI_WORKGRAPH_NODE_ID || "unknown-attempt";
  const generation = { runId, nodeId };
  const executorModel = process.env.PI_WORKGRAPH_EXECUTOR_MODEL || "";
  const executorThinking = process.env.PI_WORKGRAPH_EXECUTOR_THINKING || "high";
  const baseCommit = process.env.PI_WORKGRAPH_BASE_COMMIT || "";
  const continued =
    process.env.PI_WORKGRAPH_IMPLEMENTATION_START === "executor";
  const experiment = process.env.PI_WORKGRAPH_EXPERIMENT === "1";
  let phase: "guide" | "executor" =
    mode === "implementation" && !continued ? "guide" : "executor";
  let todos: string[] = [];
  let switchError: string | undefined;
  let switchedAt: string | undefined;

  function belongsToAttempt(data: unknown): data is typeof generation {
    return (
      !!data &&
      typeof data === "object" &&
      "runId" in data &&
      "nodeId" in data &&
      data.runId === runId &&
      data.nodeId === nodeId
    );
  }

  // Session order, not model selection or wall-clock time, proves a later generation.
  // Pi drains the current assistant message before tool preflight/execution.
  function hasExecutorMessage(entries: SessionEntry[]): boolean {
    const boundary = entries.findIndex((entry) => {
      if (entry.type !== "custom" || !belongsToAttempt(entry.data))
        return false;
      const data = entry.data;
      return continued
        ? entry.customType === "pi-workgraph-agent-running"
        : entry.customType === "pi-workgraph-worker-state" &&
            "phase" in data &&
            data.phase === "executor" &&
            "switchedAt" in data &&
            typeof data.switchedAt === "string";
    });
    return (
      boundary >= 0 &&
      entries
        .slice(boundary + 1)
        .some(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "assistant" &&
            `${entry.message.provider}/${entry.message.model}` ===
              executorModel &&
            !["error", "aborted", "pending"].includes(entry.message.stopReason),
        )
    );
  }

  pi.registerTool({
    name: "workgraph_todo",
    label: "Workgraph TODO",
    description:
      "Record a bounded local implementation TODO before the first edit.",
    parameters: Type.Object({
      items: Type.Array(Type.String({ minLength: 3 }), {
        minItems: 1,
        maxItems: 8,
      }),
    }),
    async execute(_id, params) {
      if (mode !== "implementation" || phase !== "guide")
        throw new Error(
          "Local Prewalk TODOs belong before the first implementation edit.",
        );
      todos = params.items;
      pi.appendEntry("pi-workgraph-worker-state", {
        ...generation,
        phase,
        todos,
      });
      return {
        content: [
          {
            type: "text",
            text: `Recorded ${todos.length} Local Prewalk items.`,
          },
        ],
        details: { items: todos },
      };
    },
  });
  pi.registerTool({
    name: "workgraph_report",
    label: "Workgraph Report",
    description: "Return the terminal report for this bounded assignment.",
    promptSnippet: "Finish assigned work with a typed report",
    promptGuidelines: [
      "Use workgraph_report as the final action, with actual evidence and explicit limitations.",
    ],
    parameters: reportSchemaForMode(mode),
    async execute(_id, params, _signal, _update, ctx) {
      if (!isWorkerReport(params) || params.kind !== mode)
        throw new Error(`Report must satisfy the ${mode} contract.`);
      if (params.kind === "implementation" && params.status === "completed") {
        if (phase !== "executor")
          throw new Error(
            "Completed implementation requires the first-edit model transition.",
          );
        if (switchError)
          throw new Error(`Executor model transition failed: ${switchError}`);
        if (!hasExecutorMessage(ctx.sessionManager.getBranch()))
          throw new Error(
            "Completed implementation requires an actual executor assistant message after this attempt's transition/start. Continue with the executor before reporting.",
          );
        if (!baseCommit)
          throw new Error("PI_WORKGRAPH_BASE_COMMIT is required.");
        const status = await git(
          pi,
          ctx.cwd,
          ["status", "--porcelain", "--untracked-files=all"],
          true,
        );
        if (status)
          throw new Error(
            `Commit and leave a clean worktree before reporting:\n${status}`,
          );
        const [commit, parent, ...extraParents] = (
          await git(pi, ctx.cwd, ["rev-list", "--parents", "-n", "1", "HEAD"])
        ).split(" ");
        if (!commit || parent !== baseCommit || extraParents.length)
          throw new Error(
            "A completed implementation requires exactly one direct commit on the supplied base.",
          );
        const changedText = await git(
          pi,
          ctx.cwd,
          ["diff", "--name-only", "--no-renames", baseCommit, commit],
          true,
        );
        const report: ImplementationReport = {
          ...params,
          commit,
          changedFiles: changedText.split("\n").filter(Boolean).sort(),
        };
        return terminalReport(report, {
          todos,
          todoRecorded: todos.length > 0,
          switchedAt,
          continued,
        });
      }
      // Read-only is an instruction and authority boundary, not a filesystem sandbox.
      // Shared research and review deliberately observe the live project cwd, including
      // tracked and untracked local changes. Do not claim an immutable base unless the
      // report records exact Git evidence for the requested revision.
      return terminalReport(params, { todos, switchedAt, switchError });
    },
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (mode !== "implementation" || phase !== "guide") return;
    const directEdit =
      !event.isError &&
      (event.toolName === "edit" || event.toolName === "write");
    if (!directEdit) {
      if (!baseCommit) return;
      // Any tool can mutate or commit. Observe Git, not shell-command spelling.
      const status = await git(
        pi,
        ctx.cwd,
        ["status", "--porcelain", "--untracked-files=all"],
        true,
      );
      if (
        !status &&
        (await git(pi, ctx.cwd, ["rev-parse", "HEAD"])) === baseCommit
      )
        return;
    }
    try {
      const slash = executorModel.indexOf("/");
      if (slash <= 0)
        throw new Error(`Invalid executor model: ${executorModel}`);
      const model = ctx.modelRegistry.find(
        executorModel.slice(0, slash),
        executorModel.slice(slash + 1),
      );
      if (!model)
        throw new Error(`Executor model is unavailable: ${executorModel}`);
      if (!(await pi.setModel(model)))
        throw new Error(
          `Executor model has no usable credentials: ${executorModel}`,
        );
      if (!Value.Check(ThinkingSchema, executorThinking))
        throw new Error(`Invalid executor thinking: ${executorThinking}`);
      pi.setThinkingLevel(executorThinking);
      phase = "executor";
      switchError = undefined;
      switchedAt = new Date().toISOString();
      pi.appendEntry("pi-workgraph-worker-state", {
        ...generation,
        phase,
        todos,
        executorModel,
        executorThinking,
        switchedAt,
      });
    } catch (error) {
      switchError = error instanceof Error ? error.message : String(error);
      pi.appendEntry("pi-workgraph-worker-state", {
        ...generation,
        phase,
        todos,
        switchError,
      });
    }
  });
  pi.on("model_select", (event) => {
    pi.appendEntry("pi-workgraph-effective-model", {
      ...generation,
      model: `${event.model.provider}/${event.model.id}`,
      thinking: pi.getThinkingLevel(),
    });
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    if (ctx.model)
      pi.appendEntry("pi-workgraph-effective-model", {
        ...generation,
        model: `${ctx.model.provider}/${ctx.model.id}`,
        thinking: pi.getThinkingLevel(),
      });
  });
  pi.on("session_start", (_event, ctx) => {
    for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
      if (
        entry.type !== "custom" ||
        entry.customType !== "pi-workgraph-worker-state"
      )
        continue;
      const data: unknown = entry.data;
      if (!belongsToAttempt(data)) continue;
      if ("todos" in data && Array.isArray(data.todos))
        todos = data.todos.filter(
          (item): item is string => typeof item === "string",
        );
      if ("switchedAt" in data && typeof data.switchedAt === "string")
        switchedAt = data.switchedAt;
      if ("phase" in data && data.phase === "executor") phase = "executor";
      if ("switchError" in data && typeof data.switchError === "string")
        switchError = data.switchError;
      break;
    }
  });
  pi.on("agent_start", (_event, ctx) => {
    if (ctx.model)
      pi.appendEntry("pi-workgraph-effective-model", {
        ...generation,
        model: `${ctx.model.provider}/${ctx.model.id}`,
        thinking: pi.getThinkingLevel(),
      });
    pi.appendEntry("pi-workgraph-agent-running", {
      ...generation,
      startedAt: new Date().toISOString(),
    });
  });
  pi.on("agent_settled", () => {
    pi.appendEntry("pi-workgraph-agent-settled", {
      ...generation,
      settledAt: new Date().toISOString(),
    });
  });
  pi.on("context", (event) => {
    if (mode !== "implementation" || phase !== "executor") return;
    return {
      messages: [
        ...event.messages.filter(
          (message) =>
            !(
              message.role === "custom" &&
              message.customType === "pi-workgraph-guide"
            ),
        ),
        {
          role: "custom" as const,
          customType: "pi-workgraph-executor",
          content: executorInstructions(),
          display: false,
          details: generation,
          timestamp: Date.now(),
        },
      ],
    };
  });
  pi.on("before_agent_start", () => ({
    message: {
      customType:
        mode === "implementation" && phase === "guide"
          ? "pi-workgraph-guide"
          : `pi-workgraph-${mode}`,
      content:
        mode === "implementation"
          ? phase === "guide"
            ? guideInstructions
            : executorInstructions()
          : mode === "review"
            ? reviewInstructions
            : experiment
              ? experimentInstructions
              : researchInstructions,
      display: false,
      details: generation,
    },
  }));
}

function terminalReport(report: WorkerReport, state: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${report.kind} ${report.status}: ${report.summary}`,
      },
    ],
    details: { report, state },
    terminate: true,
  };
}
const researchInstructions =
  "[WORKGRAPH RESEARCH]\nAnswer only the assigned question using read-only evidence from the live project cwd. Tracked and untracked local changes may be present; do not require cleanliness, copy files, or modify them. Supply the requested observations and retain material unknowns. Do not delegate another worker. Finish with workgraph_report.";
const experimentInstructions =
  "[WORKGRAPH EXPERIMENT]\nAnswer the question within the explicitly permitted effects and stop condition in this disposable worktree. Retain the named artifacts and report direct observations, failures and limits. Do not compose, publish, or delegate another worker. Finish with workgraph_report.";
const reviewInstructions =
  "[WORKGRAPH REVIEW]\nReview only the identified subject and concern. For an exact revision subject, inspect that exact commit with Git (for example git show, git diff, and git ls-tree) and cite the revision in evidence; do not silently treat live working files as that commit. Do not claim tests against current working files validate another revision. Execute verification only when it genuinely targets the requested subject. Do not edit files or delegate another worker. Return evidence and actionable findings; zero findings is valid. Finish with workgraph_report.";
const guideInstructions =
  "[WORKGRAPH LOCAL PREWALK - GUIDE]\nInspect the assignment and current isolated worktree. Record at most eight concrete local TODO items with workgraph_todo before the first edit. Missing TODO telemetry does not block an otherwise valid implementation. Make the first useful edit; the runtime then switches models. If required work crosses the authorized scope, report escalation without editing. Do not report completion during the guide phase.";
function executorInstructions(): string {
  return "[WORKGRAPH EXECUTOR]\nContinue this same worker trajectory in the isolated worktree. Complete the bounded assignment, run its verification, create exactly one direct commit on the supplied base, and leave the worktree clean. Return workgraph_report with evidence. Escalate required work beyond the authorized scope.";
}
async function git(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  allowEmpty = false,
): Promise<string> {
  const result = await pi.exec("git", ["-C", cwd, ...args]);
  if (result.code !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  const output = result.stdout.trim();
  if (!allowEmpty && !output)
    throw new Error(`git ${args.join(" ")} returned no output.`);
  return output;
}
function readMode(): WorkerMode | undefined {
  const value = process.env.PI_WORKGRAPH_MODE;
  if (!value) return undefined;
  if (value === "research" || value === "review" || value === "implementation")
    return value;
  throw new Error(`Invalid PI_WORKGRAPH_MODE: ${value}`);
}
