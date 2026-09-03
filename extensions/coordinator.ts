import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WorkgraphEngine, type AgreementInput } from "../src/engine.js";
import { GitRepository } from "../src/git.js";
import { stableParentEntry } from "../src/pi-process.js";
import type { RunPointer, ThinkingLevel, UsageSummary, WorkgraphRun } from "../src/types.js";

const POINTER_ENTRY = "pi-workgraph-active";
const ThinkingSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);

const InvestigationSchema = Type.Object({
  id: Type.String(),
  lens: Type.String(),
  objective: Type.String(),
});

const NodeSchema = Type.Object({
  id: Type.String(),
  objective: Type.String(),
  claimedPaths: Type.Array(Type.String(), { minItems: 1 }),
  dependencies: Type.Array(Type.String()),
  verificationCommands: Type.Array(Type.String()),
  supersedes: Type.Optional(Type.Array(Type.String())),
  guideModel: Type.Optional(Type.String()),
  executorModel: Type.Optional(Type.String()),
  guideThinking: Type.Optional(ThinkingSchema),
  executorThinking: Type.Optional(ThinkingSchema),
});

export default function workgraphCoordinator(pi: ExtensionAPI): void {
  let engine: WorkgraphEngine | undefined;
  let activeRun: WorkgraphRun | undefined;
  let gatePending = false;
  let ungatedTools: string[] | undefined;
  let exclusiveTail: Promise<unknown> = Promise.resolve();

  const exclusively = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = exclusiveTail.then(operation, operation);
    exclusiveTail = result.catch(() => undefined);
    return result;
  };

  const remember = (run: WorkgraphRun): WorkgraphRun => {
    activeRun = run;
    applyCoordinatorGate();
    return run;
  };

  const requireEngine = (): WorkgraphEngine => {
    if (!engine) throw new Error("No active Workgraph. Call workgraph_begin first.");
    return engine;
  };

  const applyCoordinatorGate = (): void => {
    if (!activeRun || activeRun.phase === "complete" || activeRun.phase === "failed") {
      if (ungatedTools) pi.setActiveTools(ungatedTools);
      ungatedTools = undefined;
      return;
    }
    ungatedTools ??= pi.getActiveTools();
    pi.setActiveTools(ungatedTools.filter((name) => name !== "edit" && name !== "write"));
  };

  const restore = async (ctx: ExtensionContext): Promise<void> => {
    engine = undefined;
    activeRun = undefined;
    applyCoordinatorGate();
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (entry?.type !== "custom" || entry.customType !== POINTER_ENTRY) continue;
      const pointer = entry.data as Partial<RunPointer> | undefined;
      if (!pointer?.statePath) continue;
      try {
        engine = WorkgraphEngine.open(pointer.statePath);
        activeRun = await engine.load();
        if (activeRun.phase === "executing") {
          activeRun = await engine.reconcile();
          ctx.ui.notify(`Reconciled interrupted Workgraph ${activeRun.runId} to ${activeRun.phase}.`, activeRun.phase === "needs_decision" ? "warning" : "info");
        }
        applyCoordinatorGate();
      } catch (error) {
        ctx.ui.notify(`Could not restore Workgraph ${pointer.runId ?? ""}: ${errorMessage(error)}`, "warning");
      }
      return;
    }
  };

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    if (event.message.content.some((part) => part.type === "toolCall" && part.name === "workgraph_begin")) {
      gatePending = true;
    }
  });

  pi.on("turn_end", () => {
    if (!activeRun || activeRun.phase === "complete" || activeRun.phase === "failed") gatePending = false;
  });

  pi.on("before_agent_start", () => {
    const run = activeRun;
    const inProgress = run && run.phase !== "complete" && run.phase !== "failed";
    const state = inProgress
      ? `Active Workgraph ${run.runId} is in phase ${run.phase}. The coordinator must stay read-only and use Workgraph tools for state changes.`
      : "For a materially ambiguous or structurally consequential coding request, call workgraph_begin before product writes. Clear, local, reversible changes may proceed directly.";
    return {
      message: {
        customType: "pi-workgraph-policy",
        content: `[WORKGRAPH COORDINATION POLICY]\n${state}\nUse bounded discovery to establish evidence, present one complete agreement checkpoint, and expose only approval or envelope-changing decisions to the user.`,
        display: false,
      },
    };
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName === "workgraph_begin") {
      gatePending = true;
      return;
    }
    const inProgress = activeRun && activeRun.phase !== "complete" && activeRun.phase !== "failed";
    if (!inProgress && !gatePending) return;
    if (event.toolName === "edit" || event.toolName === "write") {
      return { block: true, reason: "The active Workgraph keeps the coordinator read-only. Delegate approved writes through workgraph_execute." };
    }
    if (event.toolName === "bash") {
      const command = String((event.input as { command?: unknown }).command ?? "");
      if (!isCoordinatorReadOnlyCommand(command)) {
        return { block: true, reason: "The active Workgraph permits only simple read-only coordinator shell commands." };
      }
    }
  });

  pi.registerTool({
    name: "workgraph_begin",
    label: "Workgraph Begin",
    description: "Begin agreement-gated orchestration for a materially ambiguous or structurally consequential repository change. This activates a coordinator write gate.",
    promptSnippet: "Begin a durable, agreement-gated Workgraph before consequential product writes",
    promptGuidelines: [
      "Use workgraph_begin before product writes when a request is materially ambiguous or structurally consequential, then use bounded discovery and workgraph_agree.",
    ],
    parameters: Type.Object({
      request: Type.String({ description: "The user's requested outcome in their terms." }),
      reason: Type.String({ description: "Why this request requires an agreement checkpoint." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return exclusively(async () => {
        try {
          if (activeRun && !["complete", "failed"].includes(activeRun.phase)) {
            throw new Error(`Workgraph ${activeRun.runId} is still ${activeRun.phase}.`);
          }
          const sessionFile = ctx.sessionManager.getSessionFile();
          if (!sessionFile) throw new Error("Workgraph orchestration requires a persistent parent Pi session.");
          const repositoryInfo = await GitRepository.inspect(ctx.cwd);
          if (repositoryInfo.status) throw new Error(`Start from a clean Git worktree:\n${repositoryInfo.status}`);
          const begun = await WorkgraphEngine.begin({
            request: params.request.trim(),
            projectRoot: repositoryInfo.root,
            gitCommonDir: repositoryInfo.commonDir,
            parentSessionId: ctx.sessionManager.getSessionId(),
            parentSessionFile: sessionFile,
            baseCommit: repositoryInfo.head,
          });
          engine = begun.engine;
          remember(begun.run);
          gatePending = false;
          pi.appendEntry(POINTER_ENTRY, { runId: begun.run.runId, statePath: begun.run.statePath } satisfies RunPointer);
          applyCoordinatorGate();
          return {
            content: [{ type: "text", text: `Started Workgraph ${begun.run.runId}. Coordinator writes are gated. Next, run bounded discovery. Reason: ${params.reason}` }],
            details: summaryDetails(begun.run),
          };
        } catch (error) {
          gatePending = false;
          throw error;
        }
      });
    },
  });

  pi.registerTool({
    name: "workgraph_discover",
    label: "Workgraph Discover",
    description: "Run one to five bounded read-only investigations in inherited Pi session forks and return typed evidence without worker chatter.",
    promptSnippet: "Run parallel read-only Workgraph investigations",
    parameters: Type.Object({
      investigations: Type.Array(InvestigationSchema, { minItems: 1, maxItems: 5 }),
      model: Type.Optional(Type.String({ description: "Guide model as provider/model. Defaults to the coordinator model." })),
      thinking: Type.Optional(ThinkingSchema),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return exclusively(async () => {
        const selectedModel = params.model ?? currentModel(ctx);
        onUpdate?.({ content: [{ type: "text", text: `Running ${params.investigations.length} bounded investigation(s)...` }], details: {} });
        const run = remember(await requireEngine().discover({
          investigations: params.investigations,
          model: selectedModel,
          thinking: params.thinking ?? coordinatorThinking(ctx),
          stableEntryId: stableParentEntry(ctx.sessionManager),
          ...(signal ? { signal } : {}),
        }));
        const reports = run.discoveries.map((record) => ({
          id: record.id,
          lens: record.lens,
          state: record.state,
          summary: record.report?.summary,
          evidence: record.report?.evidence,
          findings: record.report?.findings,
          error: record.error,
          sessionFile: record.sessionFile,
        }));
        return {
          content: [{ type: "text", text: formatDiscoveries(run) }],
          details: { ...summaryDetails(run), reports },
          usage: nestedUsage(run.discoveries.flatMap((record) => record.usage ? [record.usage] : [])),
        };
      });
    },
  });

  pi.registerTool({
    name: "workgraph_agree",
    label: "Workgraph Agreement",
    description: "Present a complete initial or revised implementation envelope as a serialized human approval checkpoint. Implementation cannot start or cross an envelope change without approval.",
    promptSnippet: "Request approval for a complete Workgraph implementation envelope",
    parameters: Type.Object({
      outcome: Type.String(),
      nonGoals: Type.Array(Type.String()),
      reuseDecision: Type.String(),
      structure: Type.String(),
      expectedScale: Type.String(),
      verificationBoundary: Type.String(),
      verificationCommands: Type.Array(Type.String()),
      unresolvedDecisions: Type.Array(Type.String()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return exclusively(async () => {
        if (!ctx.hasUI) throw new Error("Workgraph approval requires Pi TUI or RPC UI confirmation.");
        const checkpoint = formatAgreement(params);
        if (params.unresolvedDecisions.length > 0) {
          return {
            content: [{ type: "text", text: `${checkpoint}\n\nResolve the listed decisions before requesting approval.` }],
            details: { approved: false, unresolved: true },
          };
        }
        const accepted = await ctx.ui.confirm("Approve implementation envelope?", checkpoint);
        const run = remember(await requireEngine().recordAgreement(params, accepted, checkpoint));
        return {
          content: [{ type: "text", text: accepted ? "Implementation envelope approved. Schedule bounded work nodes next." : "Implementation envelope was not approved. Revise it without writing product code." }],
          details: { ...summaryDetails(run), approved: accepted },
        };
      });
    },
  });

  pi.registerTool({
    name: "workgraph_execute",
    label: "Workgraph Execute",
    description: "Add bounded nodes to the approved graph, or resume reconciled pending nodes with an empty list, then run isolated Local Prewalk workers, verify them, and compose exact commits.",
    promptSnippet: "Execute approved Workgraph nodes in isolated inherited-context workers",
    parameters: Type.Object({
      nodes: Type.Array(NodeSchema, { minItems: 0, maxItems: 8 }),
      maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return exclusively(async () => {
        const guideDefault = currentModel(ctx);
        const executorDefault = defaultExecutorModel(guideDefault);
        const nodeIds = params.nodes.map((node) => node.id);
        onUpdate?.({ content: [{ type: "text", text: nodeIds.length > 0 ? `Executing ${nodeIds.length} approved work node(s)...` : "Resuming reconciled pending work nodes..." }], details: { nodeIds } });
        const run = remember(await requireEngine().execute({
          nodes: params.nodes.map((node) => ({
            ...node,
            supersedes: node.supersedes ?? [],
            guideModel: node.guideModel ?? guideDefault,
            executorModel: node.executorModel ?? executorDefault,
            guideThinking: node.guideThinking ?? coordinatorThinking(ctx),
            executorThinking: node.executorThinking ?? "high",
          })),
          maxConcurrency: params.maxConcurrency ?? 2,
          stableEntryId: stableParentEntry(ctx.sessionManager),
          ...(signal ? { signal } : {}),
        }));
        const selected = nodeIds.length > 0 ? run.nodes.filter((node) => nodeIds.includes(node.id)) : run.nodes;
        return {
          content: [{ type: "text", text: formatExecution(run, selected) }],
          details: {
            ...summaryDetails(run),
            nodes: selected.map((node) => ({
              id: node.id,
              state: node.state,
              commit: node.commit,
              changedFiles: node.actualChangedFiles,
              error: node.error,
              supersededBy: node.supersededBy,
              sessionFile: node.sessionFile,
              models: node.models,
              findings: node.report?.findings,
            })),
            globalVerification: run.globalVerification,
          },
          usage: nestedUsage(selected.flatMap((node) => node.usage ? [node.usage] : [])),
        };
      });
    },
  });

  pi.registerTool({
    name: "workgraph_assure",
    label: "Workgraph Assure",
    description: "Run inherited-context read-only assurance over the composed result and classify findings by implementation-envelope impact.",
    promptSnippet: "Assure the composed Workgraph result against the approved envelope",
    parameters: Type.Object({
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(ThinkingSchema),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return exclusively(async () => {
        onUpdate?.({ content: [{ type: "text", text: "Running read-only assurance over the composed result..." }], details: {} });
        const run = remember(await requireEngine().assure({
          model: params.model ?? currentModel(ctx),
          thinking: params.thinking ?? coordinatorThinking(ctx),
          stableEntryId: stableParentEntry(ctx.sessionManager),
          ...(signal ? { signal } : {}),
        }));
        const usage = run.assurance?.usage ? nestedUsage([run.assurance.usage]) : undefined;
        return {
          content: [{ type: "text", text: formatAssurance(run) }],
          details: { ...summaryDetails(run), assurance: run.assurance },
          ...(usage ? { usage } : {}),
        };
      });
    },
  });

  pi.registerTool({
    name: "workgraph_status",
    label: "Workgraph Status",
    description: "Read the durable phase, nodes, child sessions, exact commits, verification, and pending decisions for the active Workgraph.",
    promptSnippet: "Inspect durable Workgraph status and evidence",
    parameters: Type.Object({}),
    async execute() {
      return exclusively(async () => {
        const run = remember(await requireEngine().load());
        return {
          content: [{ type: "text", text: formatStatus(run) }],
          details: summaryDetails(run),
        };
      });
    },
  });
}

function coordinatorThinking(ctx: ExtensionContext): ThinkingLevel {
  return (ctx.thinkingLevel ?? "off") as ThinkingLevel;
}

function currentModel(ctx: ExtensionContext): string {
  if (!ctx.model) throw new Error("A selected model is required.");
  return `${ctx.model.provider}/${ctx.model.id}`;
}

function defaultExecutorModel(guide: string): string {
  return guide === "openai-codex/gpt-5.6-sol" ? "openai-codex/gpt-5.6-luna" : guide;
}

function formatAgreement(agreement: AgreementInput): string {
  const list = (items: string[]): string => items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None";
  return [
    `Outcome\n${agreement.outcome}`,
    `Non-goals\n${list(agreement.nonGoals)}`,
    `Reuse decision\n${agreement.reuseDecision}`,
    `Structural ownership\n${agreement.structure}`,
    `Expected scale\n${agreement.expectedScale}`,
    `Verification boundary\n${agreement.verificationBoundary}`,
    `Verification commands\n${list(agreement.verificationCommands)}`,
    `Unresolved decisions\n${list(agreement.unresolvedDecisions)}`,
  ].join("\n\n");
}

function formatDiscoveries(run: WorkgraphRun): string {
  const lines = [`Discovery settled for ${run.runId}:`];
  for (const record of run.discoveries) {
    lines.push(`- ${record.id} [${record.state}]: ${record.report?.summary ?? record.error ?? "No report."}`);
  }
  lines.push("Synthesize this evidence into one complete agreement checkpoint.");
  return lines.join("\n");
}

function formatExecution(run: WorkgraphRun, nodes: WorkgraphRun["nodes"]): string {
  const lines = [`Workgraph execution phase: ${run.phase}.`, `Composed HEAD: ${run.composedCommit}.`];
  for (const node of nodes) {
    const commit = node.commit ? ` commit ${node.commit.slice(0, 12)}` : "";
    lines.push(`- ${node.id}: ${node.state}${commit}${node.error ? ` - ${node.error}` : ""}`);
  }
  if (run.phase === "awaiting_assurance") lines.push("Run workgraph_assure next.");
  if (run.phase === "needs_decision") lines.push("Affected work stopped. Present only the authority-changing decision to the user.");
  if (run.phase === "revision_required") lines.push("Add bounded corrective nodes if the findings remain inside the approved envelope.");
  return lines.join("\n");
}

function formatAssurance(run: WorkgraphRun): string {
  const report = run.assurance?.report;
  const lines = [`Assurance phase: ${run.phase}.`, report?.summary ?? run.assurance?.error ?? "No assurance report."];
  for (const finding of report?.findings ?? []) {
    lines.push(`- [${finding.severity}/${finding.envelopeImpact}] ${finding.title}: ${finding.detail}`);
  }
  return lines.join("\n");
}

function formatStatus(run: WorkgraphRun): string {
  const nodeCounts = new Map<string, number>();
  for (const node of run.nodes) nodeCounts.set(node.state, (nodeCounts.get(node.state) ?? 0) + 1);
  const counts = [...nodeCounts].map(([state, count]) => `${state}=${count}`).join(", ") || "none";
  return [
    `Workgraph ${run.runId}`,
    `Phase: ${run.phase}`,
    `Base: ${run.baseCommit}`,
    `Composed: ${run.composedCommit}`,
    `Nodes: ${counts}`,
    `State: ${run.statePath}`,
  ].join("\n");
}

function summaryDetails(run: WorkgraphRun) {
  return {
    runId: run.runId,
    phase: run.phase,
    statePath: run.statePath,
    baseCommit: run.baseCommit,
    composedCommit: run.composedCommit,
  };
}

function nestedUsage(items: UsageSummary[]) {
  const aggregate = items.reduce<UsageSummary>((total, item) => ({
    input: total.input + item.input,
    output: total.output + item.output,
    cacheRead: total.cacheRead + item.cacheRead,
    cacheWrite: total.cacheWrite + item.cacheWrite,
    cost: total.cost + item.cost,
    turns: total.turns + item.turns,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
  return {
    input: aggregate.input,
    output: aggregate.output,
    cacheRead: aggregate.cacheRead,
    cacheWrite: aggregate.cacheWrite,
    totalTokens: aggregate.input + aggregate.output + aggregate.cacheRead + aggregate.cacheWrite,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: aggregate.cost,
    },
  };
}

function isCoordinatorReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || /[;&|><`\n]/.test(trimmed) || /\$\(/.test(trimmed) || /(?:^|\s)(?:--output(?:=|\s)|-o(?:\s|$))/.test(trimmed)) return false;
  return /^(pwd|ls|grep|cat|head|tail|wc|stat|file|du|git\s+(status|diff|show|log|rev-parse|ls-files|branch\s+--show-current))\b/.test(trimmed);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
