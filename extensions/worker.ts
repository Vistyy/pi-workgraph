/* oxlint-disable effecttsgo/async-function -- Pi owns these native Promise callbacks. */
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Effect, Result } from "effect";
import type { WorkerReportInput } from "../src/domain/report.js";
import { type WorkerPlanToolInput, WorkerPlanToolSchema } from "../src/worker/plan.js";
import {
  configuredWorkerRole,
  type WorkerModelHost,
  WorkerRuntime,
} from "../src/worker/runtime.js";
import { loadWorkerDisabledTools } from "../src/worker/settings.js";

export default function workgraphWorker(pi: ExtensionAPI): void {
  // The dedicated Worker process receives its role through the launch environment.
  // biome-ignore lint/complexity/useLiteralKeys: ProcessEnv keys require indexed access under noPropertyAccessFromIndexSignature.
  const configuredRole = configuredWorkerRole(process.env["PI_WORKGRAPH_ROLE"]); // oxlint-disable-line effecttsgo/process-env

  if (Result.isFailure(configuredRole) || configuredRole.success === null) return;

  const runtime = new WorkerRuntime(configuredRole.success, (customType, data) =>
    pi.appendEntry(customType, data),
  );

  const branch = (ctx: ExtensionContext): SessionEntry[] => ctx.sessionManager.getBranch();

  const modelHost = (ctx: ExtensionContext): WorkerModelHost => ({
    current() {
      return ctx.model === undefined
        ? undefined
        : {
            model: `${ctx.model.provider}/${ctx.model.id}`,
            thinking: pi.getThinkingLevel(),
          };
    },
    async selectModel(provider, modelId) {
      const model = ctx.modelRegistry.find(provider, modelId);

      if (model === undefined) return "missing";

      return (await pi.setModel(model)) ? "selected" : "no_credentials";
    },
    setThinking(level) {
      // SAFETY: The objective's thinking value passed TypeBox ModelTarget decoding.
      pi.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
    },
  });

  const reconcileTools = (): void => {
    const current = pi.getActiveTools();
    const allowed = runtime.allowedTools(current);

    if (allowed.length !== current.length) pi.setActiveTools(allowed);
  };

  const failStartup = (current: readonly SessionEntry[], diagnostic: string): void => {
    runtime.failClosed(current, diagnostic);
    pi.sendMessage({
      customType: "pi-workgraph-worker-diagnostic",
      content: `[WORKGRAPH WORKER STARTUP FAILED]\n${diagnostic}\nOnly a truthful failed report is permitted.`,
      display: false,
    });
  };

  if (runtime.hasPlanTool()) {
    pi.registerTool({
      name: "workgraph_plan",
      label: "Workgraph Plan",
      description:
        "Initialize the current 1–9 item implementation TODO once, then update it. TODO status guides work but is not proof of completion.",
      promptSnippet: "Set once, then update the current implementation TODO",
      promptGuidelines: [
        "Use workgraph_plan set once to initialize a concise TODO with explicit validation, then update it as evidence changes.",
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
      "Use workgraph_report as the final action. Report actual evidence and limitations; use escalated only for missing decisions or authority.",
    ],
    parameters: runtime.reportParameters(),
    execute(_id, params: WorkerReportInput, _signal, _update, ctx) {
      return Effect.runPromise(runtime.completeReport(params, branch(ctx)));
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const disabled = await loadWorkerDisabledTools();
      const current = branch(ctx);
      const restored = runtime.restoreSession(current, disabled);

      if (Result.isFailure(restored)) {
        failStartup(current, restored.failure);
      } else {
        const diagnostic = await Effect.runPromise(runtime.recoverModel(current, modelHost(ctx)));

        if (diagnostic !== undefined) pi.sendMessage(diagnostic);
      }
    } catch (cause) {
      const diagnostic =
        cause instanceof Error ? cause.message : "Worker startup state is unreadable.";

      failStartup(branch(ctx), diagnostic);
    }

    reconcileTools();
  });
  pi.on("tool_call", (event) =>
    runtime.isToolDisabled(event.toolName)
      ? { block: true, reason: `Tool ${event.toolName} is unavailable to this Workgraph worker.` }
      : undefined,
  );
  pi.on("tool_execution_end", async (event, ctx) => {
    const result = await Effect.runPromise(runtime.observeToolExecution(event, modelHost(ctx)));

    if (result !== undefined) pi.sendMessage(result);
    reconcileTools();
  });
  pi.on("turn_end", () => reconcileTools());
  pi.on("agent_start", (_event, ctx) => {
    runtime.recordAgentStarted(
      ctx.model === undefined ? undefined : `${ctx.model.provider}/${ctx.model.id}`,
      pi.getThinkingLevel(),
    );
  });
  pi.on("agent_settled", (_event, ctx) => {
    runtime.settleAgent(branch(ctx), (message) =>
      pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true }),
    );
  });
  pi.on("session_compact", (_event, ctx) => {
    const recovery = runtime.compactionRecovery(ctx.sessionManager.buildContextEntries());

    if (recovery !== undefined) pi.sendMessage(recovery);
  });
  pi.on("context", (event) => {
    const checklist = runtime.completionChecklist(event.messages);

    return {
      messages: [
        {
          role: "custom" as const,
          customType: "pi-workgraph-policy",
          content: runtime.systemPolicy(),
          display: false,
          timestamp: 0,
        },
        ...(checklist === undefined
          ? []
          : [
              {
                role: "custom" as const,
                customType: "pi-workgraph-executor-checklist",
                content: checklist,
                display: false,
                timestamp: 0,
              },
            ]),
        ...event.messages.filter(
          (message) =>
            message.role !== "custom" ||
            (message.customType !== "pi-workgraph-policy" &&
              message.customType !== "pi-workgraph-executor-checklist"),
        ),
      ],
    };
  });
  pi.on("before_agent_start", (event) => {
    reconcileTools();

    return { systemPrompt: event.systemPrompt };
  });
}
