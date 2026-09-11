import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { WorkerReportInput } from "../src/domain/report.js";
import { type WorkerPlanToolInput, WorkerPlanToolSchema } from "../src/worker-plan.js";
import {
  WorkerEnvironmentEffect,
  type WorkerModelHost,
  WorkerRuntime,
} from "../src/worker-runtime.js";
import { loadWorkerDisabledTools } from "../src/workgraph-settings.js";

export default function workgraphWorker(pi: ExtensionAPI): void {
  const environment = Effect.runSync(WorkerEnvironmentEffect);
  if (environment === null) return;

  const runtime = new WorkerRuntime(environment, (customType, data) =>
    pi.appendEntry(customType, data),
  );

  const branch = (ctx: ExtensionContext): SessionEntry[] => ctx.sessionManager.getBranch();
  const active = (ctx: ExtensionContext): SessionEntry[] =>
    ctx.sessionManager.buildContextEntries();
  const execGit = (cwd: string, args: string[]) => pi.exec("git", ["-C", cwd, ...args]);
  const modelHost = (ctx: ExtensionContext): WorkerModelHost => ({
    // oxlint-disable-next-line effecttsgo/async-function -- Pi's native model-selection Promise is adapted at this host boundary.
    async selectModel(provider, modelId) {
      const model = ctx.modelRegistry.find(provider, modelId);
      if (model === undefined) return "missing";
      return (await pi.setModel(model)) ? "selected" : "no_credentials";
    },
    setThinking(level) {
      // SAFETY: WorkerRuntime validates this value against ThinkingSchema before invoking the host callback.
      pi.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
    },
  });

  function reconcileWorkerTools(): void {
    const current = pi.getActiveTools();
    const allowed = runtime.allowedTools(current);
    if (allowed.length !== current.length) pi.setActiveTools(allowed);
  }

  if (runtime.hasPlanTool()) {
    pi.registerTool({
      name: "workgraph_plan",
      label: "Workgraph Plan",
      description:
        "Inspect one current implementation plan or apply one atomic targeted edit. The plan guides work but is not proof of correctness or completion.",
      promptSnippet: "Inspect or apply one atomic targeted edit to the current plan",
      promptGuidelines: [
        "Use workgraph_plan to inspect the current plan or apply one atomic targeted edit with stable step IDs; keep local implementation knowledge, steps, and notes current within the inherited assignment, plan statuses are navigation only, not evidence.",
      ],
      parameters: WorkerPlanToolSchema,
      execute(_id, params: WorkerPlanToolInput) {
        return Effect.runPromise(runtime.executePlan(params));
      },
    });
  }

  pi.registerTool({
    name: "workgraph_report",
    label: "Workgraph Report",
    description: "Return the terminal report for this bounded assignment.",
    promptSnippet: "Finish assigned work with a typed report",
    promptGuidelines: [
      "Use workgraph_report as the final action. Choose the status that matches the actual outcome; report failures as failed rather than implying completion, and include actual evidence and explicit limitations.",
    ],
    parameters: runtime.reportParameters(),
    execute(_id, params: WorkerReportInput, _signal: AbortSignal, _update, ctx) {
      return Effect.runPromise(runtime.completeReport(ctx.cwd, params, branch(ctx), execGit));
    },
  });

  pi.on("tool_execution_end", (event, ctx) =>
    Effect.runPromise(
      runtime
        .observeToolExecution(
          {
            toolName: event.toolName,
            isError: event.isError,
            cwd: ctx.cwd,
            active: active(ctx),
          },
          modelHost(ctx),
          execGit,
        )
        .pipe(
          Effect.tap((message) =>
            message === undefined ? Effect.void : Effect.sync(() => pi.sendMessage(message)),
          ),
          Effect.asVoid,
        ),
    ),
  );

  pi.on("model_select", (event) => {
    runtime.recordEffectiveModel(
      `${event.model.provider}/${event.model.id}`,
      pi.getThinkingLevel(),
    );
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    if (ctx.model)
      runtime.recordEffectiveModel(`${ctx.model.provider}/${ctx.model.id}`, pi.getThinkingLevel());
  });

  pi.on("session_start", (_event, ctx) =>
    loadWorkerDisabledTools()
      .catch(() => {
        ctx.ui.notify(
          "Could not load worker tool settings; configured tools remain available.",
          "warning",
        );
        return [];
      })
      .then((configuredTools) => {
        runtime.restoreSession(branch(ctx), configuredTools);
        reconcileWorkerTools();
      }),
  );
  pi.on("tool_call", (event) => {
    if (!runtime.isToolDisabled(event.toolName)) return;
    return {
      block: true,
      reason: `Tool ${event.toolName} is unavailable to this Workgraph worker.`,
    };
  });
  // A tool may register or activate another tool while executing. turn_end is
  // the last extension boundary before Pi snapshots tools for the next request.
  pi.on("turn_end", () => reconcileWorkerTools());
  pi.on("agent_start", (_event, ctx) => {
    runtime.recordAgentStarted(
      ctx.model === undefined ? undefined : `${ctx.model.provider}/${ctx.model.id}`,
      pi.getThinkingLevel(),
    );
  });
  pi.on("agent_settled", () => {
    runtime.settleAgent((message) =>
      pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true }),
    );
  });

  pi.on("session_compact", (_event, ctx) => {
    const snapshot = runtime.workerContext(active(ctx), branch(ctx), runtime.hasPlanTool()).message;
    if (snapshot !== undefined) pi.sendMessage(snapshot);
  });
  pi.on("before_agent_start", (event, ctx) => {
    reconcileWorkerTools();
    const prompt = runtime.workerContext(active(ctx), branch(ctx), false);
    const systemPrompt = `${event.systemPrompt}\n\n${prompt.systemPolicy}`;
    return prompt.message === undefined
      ? { systemPrompt }
      : { systemPrompt, message: prompt.message };
  });
}
