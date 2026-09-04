import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  WorkgraphEngine,
  type AgreementInput,
  type ModelAssignment,
} from "../src/engine.js";
import { GitRepository } from "../src/git.js";
import {
  loadModelPolicy,
  MODEL_ROLES,
  modelPolicyPath,
  roleTargets,
  setModelRole,
  type ModelRole,
  type ModelTarget,
} from "../src/model-policy.js";
import { stableParentEntry } from "../src/pi-process.js";
import { resolveChildCapabilities, WEB_TOOLS, WEB_PACKAGE, CODEX_PACKAGE } from "../src/capabilities.js";
import type {
  AssuranceResponsibility,
  DiscoveryAssignment,
  DiscoveryTopology,
  RunPointer,
  ThinkingLevel,
  UsageSummary,
  WorkgraphRun,
} from "../src/types.js";

const POINTER_ENTRY = "pi-workgraph-active";
const ThinkingSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
const ModelRoleSchema = StringEnum([...MODEL_ROLES]);
const AssuranceResponsibilitySchema = StringEnum(["behavior", "structure", "evidence"] as const);

const ModelTargetSchema = Type.Object({
  model: Type.String({ description: "Model selector as provider/model." }),
  thinking: Type.Optional(ThinkingSchema),
});

const InvestigationSchema = Type.Object({
  id: Type.String(),
  lens: Type.String(),
  objective: Type.String(),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(ThinkingSchema),
  supersedes: Type.Optional(Type.Array(Type.String())),
});

const BriefSchema = Type.Object({
  goal: Type.String(),
  context: Type.Array(Type.String()),
  acceptance: Type.Array(Type.String(), { minItems: 1 }),
  timeboxMinutes: Type.Integer({ minimum: 1, maximum: 240 }),
  forbidden: Type.Array(Type.String()),
  report: Type.String(),
});

const NodeSchema = Type.Object({
  id: Type.String(),
  brief: BriefSchema,
  claimedPaths: Type.Array(Type.String(), { minItems: 1 }),
  dependencies: Type.Array(Type.String()),
  verificationCommands: Type.Array(Type.String()),
  supersedes: Type.Optional(Type.Array(Type.String())),
  continuationOf: Type.Optional(Type.String()),
  guideModel: Type.Optional(Type.String()),
  executorModel: Type.Optional(Type.String()),
  guideThinking: Type.Optional(ThinkingSchema),
  executorThinking: Type.Optional(ThinkingSchema),
});

export default function workgraphCoordinator(pi: ExtensionAPI): void {
  if (process.env.PI_WORKGRAPH_MODE) return;
  let engine: WorkgraphEngine | undefined;
  let activeRun: WorkgraphRun | undefined;
  let exclusiveTail: Promise<unknown> = Promise.resolve();

  const exclusively = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = exclusiveTail.then(operation, operation);
    exclusiveTail = result.catch(() => undefined);
    return result;
  };

  const remember = (run: WorkgraphRun): WorkgraphRun => {
    activeRun = run;
    return run;
  };

  const requireEngine = (): WorkgraphEngine => {
    if (!engine) throw new Error("No active Workgraph. Call workgraph_begin first.");
    return engine;
  };

  const restore = async (ctx: ExtensionContext): Promise<void> => {
    engine = undefined;
    activeRun = undefined;
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (entry?.type !== "custom" || entry.customType !== POINTER_ENTRY) continue;
      const pointer = entry.data as Partial<RunPointer> | undefined;
      if (!pointer?.statePath) continue;
      try {
        engine = WorkgraphEngine.open(pointer.statePath);
        activeRun = await engine.load();
        const interrupted = activeRun.phase === "executing"
          || (activeRun.phase === "awaiting_verification" && activeRun.productVerification?.state === "running")
          || ((activeRun.phase === "awaiting_assurance" || activeRun.phase === "assurance_inconclusive") && activeRun.assurance?.state === "running");
        if (interrupted) {
          activeRun = await engine.reconcile();
          ctx.ui.notify(`Reconciled interrupted Workgraph ${activeRun.runId} to ${activeRun.phase}.`, activeRun.phase === "needs_decision" || activeRun.phase === "assurance_inconclusive" ? "warning" : "info");
        }
      } catch (error) {
        ctx.ui.notify(`Could not restore Workgraph ${pointer.runId ?? ""}: ${errorMessage(error)}`, "warning");
      }
      return;
    }
  };

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));

  pi.on("before_agent_start", async (event) => {
    let run = activeRun;
    if (engine && run?.agreementProposal) {
      const decision = conversationalDecision(event.prompt);
      if (decision !== undefined) {
        run = remember(await engine.recordAgreement(run.agreementProposal, decision, event.prompt));
      }
    }
    const inProgress = run !== undefined && run.phase !== "complete" && run.phase !== "failed";
    const state = inProgress && run
      ? `Active Workgraph ${run.runId} is in phase ${run.phase} for a ${run.outcome.kind} outcome. All normal coordinator tools remain available. Keep substantial product implementation behind the approved agreement and use Workgraph boundaries for delegated writes, composition, evidence, and assurance.`
      : "All normal coordinator tools remain available. For materially ambiguous or structurally consequential work, begin a durable Workgraph before substantial product implementation. Clear, local, reversible work may proceed directly.";
    const proposal = run?.agreementProposal
      ? " A Workgraph implementation plan is awaiting an exact approval or rejection in a later user message."
      : "";
    return {
      message: {
        customType: "pi-workgraph-policy",
        content: `[WORKGRAPH COORDINATION POLICY]\n${state}${proposal}\nThe coordinator owns semantic synthesis and final judgment. Keep outcome and milestone progress durable, account for every child, and expose only the agreement, authority-changing decisions, material blockers, and final evidenced result to the user.`,
        display: false,
      },
    };
  });

  pi.registerTool({
    name: "workgraph_models",
    label: "Workgraph Models",
    description: "Read or update Workgraph's durable role-to-model policy without depending on external configuration.",
    promptSnippet: "Inspect or configure Workgraph model roles",
    parameters: Type.Object({
      action: StringEnum(["get", "set"] as const),
      role: Type.Optional(ModelRoleSchema),
      targets: Type.Optional(Type.Array(ModelTargetSchema, { minItems: 1, maxItems: 4 })),
    }),
    async execute(_id, params) {
      const policy = params.action === "set"
        ? await setConfiguredRole(params.role, params.targets)
        : await loadModelPolicy();
      return {
        content: [{ type: "text", text: formatModelPolicy(policy.roles) }],
        details: { path: modelPolicyPath(), policy },
      };
    },
  });

  pi.registerTool({
    name: "workgraph_capabilities",
    label: "Workgraph Capabilities",
    description: "Inspect Workgraph's trusted child-capability configuration and resolved installed resources.",
    promptSnippet: "Inspect trusted child capabilities without configuring executable paths",
    parameters: Type.Object({ action: StringEnum(["get"] as const), model: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const model = params.model ?? "openai-codex/gpt-5.6-sol";
      const capabilities = await resolveChildCapabilities("discovery", model);
      return { content: [{ type: "text", text: JSON.stringify({ trusted: [WEB_PACKAGE, CODEX_PACKAGE], tools: WEB_TOOLS, model, capabilities }, null, 2) }], details: { capabilities } };
    },
  });

  pi.registerTool({
    name: "workgraph_begin",
    label: "Workgraph Begin",
    description: "Begin a durable outcome-driven Workgraph for a materially ambiguous or structurally consequential repository task.",
    promptSnippet: "Begin a durable Workgraph with an explicit outcome and completion predicate",
    promptGuidelines: [
      "Choose the outcome kind and begin Workgraph before substantial product implementation for consequential requests.",
      "Normal coordinator tools remain available; this boundary records orchestration state and does not install a tool gate.",
    ],
    parameters: Type.Object({
      request: Type.String({ description: "The user's requested outcome in their terms." }),
      reason: Type.String({ description: "Why the Workgraph lifecycle is proportionate." }),
      outcomeKind: StringEnum(["answer", "decision", "product_change", "operation"] as const),
      outcomeStatement: Type.String({ description: "The explicit answer, decision, change, or operation outcome." }),
      completionPredicate: Type.String({ description: "A falsifiable condition for completion." }),
      milestones: Type.Optional(Type.Array(Type.Object({ id: Type.String(), description: Type.String() }), { maxItems: 12 })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return exclusively(async () => {
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
          outcome: {
            kind: params.outcomeKind,
            statement: params.outcomeStatement.trim(),
            completionPredicate: params.completionPredicate.trim(),
          },
          ...(params.milestones ? { milestones: params.milestones } : {}),
        });
        engine = begun.engine;
        remember(begun.run);
        pi.appendEntry(POINTER_ENTRY, { runId: begun.run.runId, statePath: begun.run.statePath } satisfies RunPointer);
        return {
          content: [{ type: "text", text: `Started Workgraph ${begun.run.runId} for ${begun.run.outcome.kind}. All coordinator tools remain stable. Reason: ${params.reason}` }],
          details: summaryDetails(begun.run),
        };
      });
    },
  });

  pi.registerTool({
    name: "workgraph_progress",
    label: "Workgraph Milestone",
    description: "Mark a run-declared task milestone completed or explicitly skipped.",
    promptSnippet: "Record durable task-specific milestone progress",
    parameters: Type.Object({
      milestone: Type.String(),
      status: StringEnum(["completed", "skipped"] as const),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      return exclusively(async () => {
        const run = remember(await requireEngine().recordMilestone(params.milestone, params.status, params.reason));
        return {
          content: [{ type: "text", text: formatMilestoneProgress(run) }],
          details: { ...summaryDetails(run), milestones: run.milestones },
        };
      });
    },
  });

  pi.registerTool({
    name: "workgraph_complete",
    label: "Workgraph Complete",
    description: "Complete an answer, decision, or operation outcome with typed evidence and no implementation claim.",
    promptSnippet: "Finish a non-change Workgraph outcome with direct evidence",
    parameters: Type.Object({
      conclusion: Type.String(),
      evidence: Type.Array(Type.Object({
        label: Type.String(), observation: Type.String(), class: Type.Optional(StringEnum(["direct", "inference", "conflict", "unknown"] as const)),
        command: Type.Optional(Type.String()), artifact: Type.Optional(Type.String()),
      }), { minItems: 1, maxItems: 30 }),
    }),
    async execute(_id, params) {
      return exclusively(async () => {
        const current = await requireEngine().load();
        if (current.outcome.kind === "product_change") throw new Error("Product-change outcomes must use agreement, execution, verification, assurance, and judgment.");
        const run = remember(await requireEngine().completeNonChange(current.outcome.kind, params.conclusion, params.evidence));
        return { content: [{ type: "text", text: `Outcome ${run.outcome.kind} completed: ${run.terminalOutcome?.conclusion}` }], details: { ...summaryDetails(run), terminalOutcome: run.terminalOutcome } };
      });
    },
  });

  pi.registerTool({
    name: "workgraph_discover",
    label: "Workgraph Discover",
    description: "Run one topology-declared discovery fan-out with role-based models, inherited session context, typed evidence, and explicit dropout accounting.",
    promptSnippet: "Run partitioned, replicated, or evidence-source Workgraph discovery",
    parameters: Type.Object({
      topology: StringEnum(["partition", "replicate", "evidence"] as const),
      investigations: Type.Optional(Type.Array(InvestigationSchema, { minItems: 1, maxItems: 5 })),
      question: Type.Optional(Type.String({ description: "The identical question for replicated discovery." })),
      idPrefix: Type.Optional(Type.String({ description: "Stable lowercase id prefix for replicated lanes." })),
      panelSize: Type.Optional(Type.Integer({ minimum: 2, maximum: 4 })),
      models: Type.Optional(Type.Array(ModelTargetSchema, { minItems: 1, maxItems: 4 })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return exclusively(async () => {
        const assignments = await expandDiscovery(params, ctx, activeRun);
        onUpdate?.({ content: [{ type: "text", text: `Running ${assignments.length} ${params.topology} discovery lane(s)...` }], details: { assignments } });
        const run = remember(await requireEngine().discover({
          topology: params.topology,
          assignments,
          stableEntryId: stableParentEntry(ctx.sessionManager),
          ...(signal ? { signal } : {}),
        }));
        const selectedIds = new Set(assignments.map((assignment) => assignment.id));
        const records = run.discoveries.filter((record) => selectedIds.has(record.id));
        return {
          content: [{ type: "text", text: formatDiscoveries(run, records) }],
          details: {
            ...summaryDetails(run),
            topology: params.topology,
            records,
          },
          usage: nestedUsage(records.flatMap((record) => record.usage ? [record.usage] : [])),
        };
      });
    },
  });

  pi.registerTool({
    name: "workgraph_synthesize",
    label: "Workgraph Synthesize",
    description: "Reduce two to five settled discovery lanes, including explicit dropouts, into one independently generated convergence, disagreement, and unknowns report.",
    promptSnippet: "Synthesize substantial Workgraph discovery fan-out before coordinator judgment",
    parameters: Type.Object({
      id: Type.String(),
      sourceIds: Type.Array(Type.String(), { minItems: 2, maxItems: 5 }),
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(ThinkingSchema),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return exclusively(async () => {
        const target = withAvailability(await resolveTarget("discovery.synthesis", params.model, params.thinking), ctx, "discovery synthesizer");
        onUpdate?.({ content: [{ type: "text", text: `Synthesizing ${params.sourceIds.length} discovery reports with ${target.model}...` }], details: { sourceIds: params.sourceIds, target } });
        const run = remember(await requireEngine().synthesizeDiscovery({
          id: params.id,
          sourceIds: params.sourceIds,
          ...target,
          stableEntryId: stableParentEntry(ctx.sessionManager),
          ...(signal ? { signal } : {}),
        }));
        const record = run.discoveries.find((candidate) => candidate.id === params.id);
        return {
          content: [{ type: "text", text: `Discovery synthesis ${params.id} [${record?.state ?? "missing"}]: ${record?.report?.summary ?? record?.error ?? "No report."}` }],
          details: { ...summaryDetails(run), synthesis: record },
          ...(record?.usage ? { usage: nestedUsage([record.usage]) } : {}),
        };
      });
    },
  });

  pi.registerTool({
    name: "workgraph_agree",
    label: "Workgraph Agreement",
    description: "Present a complete implementation plan for conversational approval in the next user message.",
    promptSnippet: "Request approval for a complete Workgraph implementation envelope",
    parameters: Type.Object({
      outcome: Type.String(),
      nonGoals: Type.Array(Type.String()),
      reuseDecision: Type.String(),
      structure: Type.String(),
      expectedScale: Type.String(),
      verificationBoundary: Type.String(),
      verificationCommands: Type.Array(Type.String()),
      verificationMethod: StringEnum(["commands", "independent"] as const),
      verificationProcedure: Type.String(),
      requiredEvidence: Type.Array(Type.String()),
      unresolvedDecisions: Type.Array(Type.String()),
    }),
    async execute(_id, params) {
      return exclusively(async () => {
        const checkpoint = formatAgreementSummary(params);
        const run = remember(await requireEngine().proposeAgreement(params, checkpoint));
        return {
          content: [{ type: "text", text: `${checkpoint}\n\nReply with your approval or requested changes. Workgraph will record the next user decision.` }],
          details: { ...summaryDetails(run), proposal: params },
        };
      });
    },
  });

  pi.registerTool({
    name: "workgraph_execute",
    label: "Workgraph Execute",
    description: "Add bounded nodes to the approved implementation DAG or resume pending nodes, then run isolated Local Prewalk workers, verify commits, and compose exact changes.",
    promptSnippet: "Execute approved Workgraph nodes from complete bounded worker briefs",
    parameters: Type.Object({
      nodes: Type.Array(NodeSchema, { minItems: 0, maxItems: 8 }),
      maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return exclusively(async () => {
        const policy = await loadModelPolicy();
        const guideDefault = roleTargets(policy, "implementation.guide")[0]!;
        const executorDefault = roleTargets(policy, "implementation.executor")[0]!;
        const nodes = params.nodes.map((node) => ({
          ...node,
          supersedes: node.supersedes ?? [],
          guideModel: node.guideModel ?? guideDefault.model,
          executorModel: node.executorModel ?? executorDefault.model,
          guideThinking: node.guideThinking ?? guideDefault.thinking,
          executorThinking: node.executorThinking ?? executorDefault.thinking,
        }));
        for (const node of nodes) {
          requireAvailable(node.guideModel, ctx, `${node.id} guide`);
          requireAvailable(node.executorModel, ctx, `${node.id} executor`);
        }
        const nodeIds = nodes.map((node) => node.id);
        onUpdate?.({ content: [{ type: "text", text: nodeIds.length > 0 ? `Executing ${nodeIds.length} approved work node(s)...` : "Resuming reconciled pending work nodes..." }], details: { nodeIds } });
        const run = remember(await requireEngine().execute({
          nodes,
          maxConcurrency: params.maxConcurrency ?? 2,
          stableEntryId: stableParentEntry(ctx.sessionManager),
          ...(signal ? { signal } : {}),
        }));
        const selected = nodeIds.length > 0 ? run.nodes.filter((node) => nodeIds.includes(node.id)) : run.nodes;
        return {
          content: [{ type: "text", text: formatExecution(run, selected) }],
          details: {
            ...summaryDetails(run),
            nodes: selected,
            globalVerification: run.globalVerification,
            productVerification: run.productVerification,
          },
          usage: nestedUsage(selected.flatMap((node) => node.usage ? [node.usage] : [])),
        };
      });
    },
  });

  pi.registerTool({
    name: "workgraph_verify",
    label: "Workgraph Verify",
    description: "Run independent product verification against the exact composed revision when the approved boundary cannot be established by commands alone.",
    promptSnippet: "Observe the composed product independently and retain exact-revision evidence",
    parameters: Type.Object({
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(ThinkingSchema),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return exclusively(async () => {
        const target = await resolveTarget("verification.product", params.model, params.thinking);
        requireAvailable(target.model, ctx, "product verifier");
        onUpdate?.({ content: [{ type: "text", text: `Verifying composed product with ${target.model}...` }], details: { target } });
        const run = remember(await requireEngine().verify({
          ...target,
          stableEntryId: stableParentEntry(ctx.sessionManager),
          ...(signal ? { signal } : {}),
        }));
        return {
          content: [{ type: "text", text: formatVerification(run) }],
          details: { ...summaryDetails(run), verification: run.productVerification },
          ...(run.productVerification?.usage ? { usage: nestedUsage([run.productVerification.usage]) } : {}),
        };
      });
    },
  });

  pi.registerTool({
    name: "workgraph_assure",
    label: "Workgraph Assure",
    description: "Run exactly one behavior, structure, and evidence reviewer, then have Luna synthesize their candidate findings for coordinator judgment.",
    promptSnippet: "Run responsibility-specific assurance and synthesis over exact-revision product evidence",
    parameters: Type.Object({
      behavior: Type.Optional(ModelTargetSchema),
      structure: Type.Optional(ModelTargetSchema),
      evidence: Type.Optional(ModelTargetSchema),
      synthesis: Type.Optional(ModelTargetSchema),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return exclusively(async () => {
        const reviewers = await resolveReviewers(params, ctx);
        const synthesis = withAvailability(await resolveTarget("assurance.synthesis", params.synthesis?.model, params.synthesis?.thinking), ctx, "assurance synthesis");
        onUpdate?.({ content: [{ type: "text", text: "Running behavior, structure, and evidence assurance, followed by synthesis..." }], details: { reviewers, synthesis } });
        const run = remember(await requireEngine().assure({
          reviewers,
          synthesis,
          stableEntryId: stableParentEntry(ctx.sessionManager),
          ...(signal ? { signal } : {}),
        }));
        const usages = [
          ...(run.assurance?.reviews.flatMap((review) => review.usage ? [review.usage] : []) ?? []),
          ...(run.assurance?.synthesis?.usage ? [run.assurance.synthesis.usage] : []),
        ];
        return {
          content: [{ type: "text", text: formatAssurance(run) }],
          details: { ...summaryDetails(run), assurance: run.assurance },
          ...(usages.length > 0 ? { usage: nestedUsage(usages) } : {}),
        };
      });
    },
  });

  pi.registerTool({
    name: "workgraph_judge",
    label: "Workgraph Judge",
    description: "Record the Sol coordinator's final accept or dismiss judgment for every assurance candidate and route accepted findings.",
    promptSnippet: "Make the final coordinator judgment over synthesized assurance candidates",
    parameters: Type.Object({
      judgments: Type.Array(Type.Object({
        findingId: Type.String(),
        disposition: StringEnum(["accept", "dismiss"] as const),
        reason: Type.String(),
      }), { maxItems: 60 }),
    }),
    async execute(_id, params) {
      return exclusively(async () => {
        const run = remember(await requireEngine().judgeAssurance(params));
        return {
          content: [{ type: "text", text: formatJudgment(run) }],
          details: { ...summaryDetails(run), judgment: run.assurance?.finalJudgment },
        };
      });
    },
  });

  pi.registerTool({
    name: "workgraph_status",
    label: "Workgraph Status",
    description: "Read durable outcome, milestone, lane, child, exact-commit, verification, assurance, and pending-decision state.",
    promptSnippet: "Inspect durable Workgraph status and evidence",
    parameters: Type.Object({}),
    async execute() {
      return exclusively(async () => {
        const run = remember(await requireEngine().load());
        return {
          content: [{ type: "text", text: formatStatus(run) }],
          details: { ...summaryDetails(run), run },
        };
      });
    },
  });
}

async function setConfiguredRole(role: ModelRole | undefined, targets: Array<{ model: string; thinking?: ThinkingLevel }> | undefined) {
  if (!role || !targets) throw new Error("Model role and targets are required for action set.");
  return setModelRole(role, targets.map((target) => ({ model: target.model, thinking: target.thinking ?? "high" })));
}

export async function expandDiscovery(
  params: {
    topology: DiscoveryTopology;
    investigations?: Array<{ id: string; lens: string; objective: string; model?: string; thinking?: ThinkingLevel; supersedes?: string[] }>;
    question?: string;
    idPrefix?: string;
    panelSize?: number;
    models?: Array<{ model: string; thinking?: ThinkingLevel }>;
  },
  ctx: ExtensionContext,
  run: WorkgraphRun | undefined,
): Promise<DiscoveryAssignment[]> {
  const policy = await loadModelPolicy();
  if (params.topology === "replicate") {
    if (!params.question?.trim()) throw new Error("Replicated discovery requires one identical question.");
    const configured = params.models?.map((target) => ({ model: target.model, thinking: target.thinking ?? "high" }))
      ?? roleTargets(policy, "discovery.replicate");
    const panelSize = params.panelSize ?? Math.min(3, configured.length);
    if (configured.length < panelSize) throw new Error(`Replicated discovery requested ${panelSize} models but only ${configured.length} were supplied.`);
    const priorRuns = run?.discoveries.filter((record) => record.topology === "replicate").length ?? 0;
    const prefix = params.idPrefix?.trim() || `replicate${priorRuns + 1}`;
    return configured.slice(0, panelSize).map((target, index) => ({
      id: `${prefix}-${String.fromCharCode(97 + index)}`,
      lens: `Independent replication ${index + 1} of ${panelSize}`,
      objective: params.question!.trim(),
      ...withAvailability(target, ctx, `replicated lane ${index + 1}`),
    }));
  }

  if (!params.investigations || params.investigations.length === 0) {
    throw new Error(`${params.topology} discovery requires explicit investigation responsibilities.`);
  }
  const role: ModelRole = params.topology === "partition" ? "discovery.partition" : "discovery.evidence";
  const defaultTarget = params.models?.[0]
    ? { model: params.models[0].model, thinking: params.models[0].thinking ?? "high" }
    : roleTargets(policy, role)[0]!;
  return params.investigations.map((investigation) => ({
    id: investigation.id,
    lens: investigation.lens,
    objective: investigation.objective,
    ...(investigation.supersedes ? { supersedes: investigation.supersedes } : {}),
    ...withAvailability({
      model: investigation.model ?? defaultTarget.model,
      thinking: investigation.thinking ?? defaultTarget.thinking,
    }, ctx, `${investigation.id} discovery lane`),
  }));
}

async function resolveTarget(role: ModelRole, model?: string, thinking?: ThinkingLevel): Promise<ModelTarget> {
  const configured = roleTargets(await loadModelPolicy(), role)[0]!;
  return { model: model ?? configured.model, thinking: thinking ?? configured.thinking };
}

async function resolveReviewers(
  params: Partial<Record<AssuranceResponsibility, { model: string; thinking?: ThinkingLevel }>>,
  ctx: ExtensionContext,
): Promise<Array<ModelAssignment & { responsibility: AssuranceResponsibility }>> {
  const responsibilities: AssuranceResponsibility[] = ["behavior", "structure", "evidence"];
  return Promise.all(responsibilities.map(async (responsibility) => ({
    responsibility,
    ...withAvailability(await resolveTarget(`assurance.${responsibility}`, params[responsibility]?.model, params[responsibility]?.thinking), ctx, `${responsibility} reviewer`),
  })));
}

function withAvailability(target: ModelTarget, ctx: ExtensionContext, owner: string): ModelAssignment {
  const available = new Set(ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`));
  return available.has(target.model)
    ? { ...target }
    : { ...target, unavailableReason: `${owner} model is unavailable: ${target.model}` };
}

function requireAvailable(model: string, ctx: ExtensionContext, owner: string): void {
  const target = withAvailability({ model, thinking: "off" }, ctx, owner);
  if (target.unavailableReason) throw new Error(target.unavailableReason);
}

function formatAgreementSummary(agreement: AgreementInput): string {
  return [
    `Plan: ${agreement.outcome}`,
    `Scope: ${agreement.structure}`,
    `Verification: ${agreement.verificationMethod} at ${agreement.verificationBoundary}`,
    `Checks: ${agreement.verificationCommands.join(", ")}`,
    agreement.nonGoals.length > 0 ? `Non-goals: ${agreement.nonGoals.join("; ")}` : "Non-goals: none",
  ].join("\n");
}

function conversationalDecision(prompt: string): boolean | undefined {
  const normalized = prompt.trim().toLowerCase().replace(/[.!?]+$/g, "");
  if (/^(approve|approved|yes|y|lgtm)$/.test(normalized)) return true;
  if (/^(reject|rejected|decline|declined|no|n)$/.test(normalized)) return false;
  return undefined;
}

function formatDiscoveries(run: WorkgraphRun, records: WorkgraphRun["discoveries"]): string {
  const lines = [`${records[0]?.topology ?? "Discovery"} settled for ${run.runId}:`];
  for (const record of records) {
    lines.push(`- ${record.id} [${record.model}; ${record.state}]: ${record.report?.summary ?? record.error ?? "No report."}`);
  }
  lines.push("The Sol coordinator should reconcile convergence, disagreement, dropouts, and unknowns before choosing the next operation.");
  return lines.join("\n");
}

function formatExecution(run: WorkgraphRun, nodes: WorkgraphRun["nodes"]): string {
  const lines = [`Workgraph execution phase: ${run.phase}.`, `Composed HEAD: ${run.composedCommit}.`];
  for (const node of nodes) {
    const commit = node.commit ? ` commit ${node.commit.slice(0, 12)}` : "";
    lines.push(`- ${node.id}: ${node.state}${commit}${node.error ? ` - ${node.error}` : ""}`);
  }
  if (run.phase === "awaiting_verification") lines.push("Run workgraph_verify next.");
  if (run.phase === "awaiting_assurance") lines.push("Run workgraph_assure.");
  if (run.phase === "needs_decision") lines.push("Affected work stopped. Present only the authority-changing decision to the user.");
  if (run.phase === "revision_required") lines.push("Add bounded corrective nodes if accepted findings remain inside the approved envelope.");
  return lines.join("\n");
}

function formatVerification(run: WorkgraphRun): string {
  const verification = run.productVerification;
  return [
    `Product verification phase: ${run.phase}.`,
    `Revision: ${verification?.revision ?? "none"}.`,
    `State: ${verification?.state ?? "missing"}.`,
    verification?.report?.summary ?? verification?.error ?? "No verifier report.",
  ].join("\n");
}

function formatAssurance(run: WorkgraphRun): string {
  const lines = [`Assurance phase: ${run.phase}.`, `Revision: ${run.assurance?.revision ?? "none"}.`];
  for (const review of run.assurance?.reviews ?? []) {
    lines.push(`- ${review.responsibility} [${review.model}; ${review.state}]: ${review.report?.summary ?? review.error ?? "No report."}`);
    for (const finding of review.report?.findings ?? []) lines.push(`  - ${finding.id}: ${finding.violatedInvariant}`);
  }
  if (run.assurance?.synthesis) {
    lines.push(`- synthesis [${run.assurance.synthesis.model}; ${run.assurance.synthesis.state}]: ${run.assurance.synthesis.report?.summary ?? run.assurance.synthesis.error ?? "No report."}`);
  }
  if (run.phase === "awaiting_judgment") lines.push("The coordinator must inspect and disposition every candidate with workgraph_judge.");
  return lines.join("\n");
}

function formatJudgment(run: WorkgraphRun): string {
  const accepted = run.assurance?.finalJudgment?.acceptedFindings ?? [];
  const lines = [`Coordinator judgment routed Workgraph to ${run.phase}.`, `Accepted findings: ${accepted.length}.`];
  for (const finding of accepted) lines.push(`- ${finding.id} [${finding.envelopeImpact}]: ${finding.violatedInvariant}`);
  return lines.join("\n");
}

function formatMilestoneProgress(run: WorkgraphRun): string {
  return [
    `${run.outcome.kind} milestones:`,
    ...(run.milestones.length ? run.milestones.map((milestone) => `- ${milestone.id}: ${milestone.status}${milestone.reason ? ` - ${milestone.reason}` : ""}`) : ["- None declared"]),
  ].join("\n");
}

function formatStatus(run: WorkgraphRun): string {
  const nodeCounts = new Map<string, number>();
  for (const node of run.nodes) nodeCounts.set(node.state, (nodeCounts.get(node.state) ?? 0) + 1);
  const counts = [...nodeCounts].map(([state, count]) => `${state}=${count}`).join(", ") || "none";
  const dropouts = run.discoveries.filter((record) => record.state !== "completed").length;
  return [
    `Workgraph ${run.runId}`,
    `Phase: ${run.phase}`,
    `Outcome: ${run.outcome.kind}`,
    `Statement: ${run.outcome.statement}`,
    `Predicate: ${run.outcome.completionPredicate}`,
    `Milestones: ${run.milestones.map((milestone) => `${milestone.id}=${milestone.status}`).join(", ") || "none"}`,
    `Discovery lanes: ${run.discoveries.length}, dropouts=${dropouts}`,
    `Base: ${run.baseCommit}`,
    `Composed: ${run.composedCommit}`,
    `Product evidence: ${run.productVerification?.state ?? "none"} at ${run.productVerification?.revision ?? "none"}`,
    `Nodes: ${counts}`,
    `State: ${run.statePath}`,
  ].join("\n");
}

function formatModelPolicy(roles: Record<ModelRole, ModelTarget[]>): string {
  return MODEL_ROLES.flatMap((role) => [
    `${role}:`,
    ...roles[role].map((target) => `- ${target.model} (${target.thinking})`),
  ]).join("\n");
}

function summaryDetails(run: WorkgraphRun) {
  return {
    runId: run.runId,
    phase: run.phase,
    statePath: run.statePath,
    outcome: run.outcome,
    milestones: run.milestones,
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
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: aggregate.cost },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
