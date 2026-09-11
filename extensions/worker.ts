import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { DateTime, Effect } from "effect";
import { reportSchemaForMode, type WorkerReportInput } from "../src/domain/report.js";
import { type WorkerPlanToolInput, WorkerPlanToolSchema } from "../src/worker-plan.js";
import {
  gitEffect,
  WorkerEnvironmentEffect,
  type WorkerExpectedError,
  WorkerRuntime,
} from "../src/worker-runtime.js";
import { loadWorkerDisabledTools } from "../src/workgraph-settings.js";

export default function workgraphWorker(pi: ExtensionAPI): void {
  const environment = Effect.runSync(WorkerEnvironmentEffect);
  if (environment === null) return;

  const runtime = new WorkerRuntime(environment, (customType, data) =>
    pi.appendEntry(customType, data),
  );
  let disabledTools = new Set<string>();

  const branch = (ctx: ExtensionContext): SessionEntry[] => ctx.sessionManager.getBranch();
  const active = (ctx: ExtensionContext) => ctx.sessionManager.buildContextEntries();
  const execGit = (cwd: string, args: string[]) => pi.exec("git", ["-C", cwd, ...args]);

  function isDisabled(name: string): boolean {
    return disabledTools.has(name) || runtime.assignmentDisables(name);
  }

  function reconcileWorkerTools(): void {
    const current = pi.getActiveTools();
    const allowed = current.filter((name) => !isDisabled(name));
    if (allowed.length !== current.length) pi.setActiveTools(allowed);
  }

  function appendPhaseActivation(ctx: ExtensionContext): void {
    const message = runtime.currentPhaseActivation(active(ctx));
    if (message !== undefined) pi.sendMessage(message);
  }

  function transitionToExecutor(ctx: ExtensionContext) {
    return runtime
      .transitionToExecutor(
        // oxlint-disable-next-line effecttsgo/async-function -- Pi's native model-selection Promise is adapted at this host boundary.
        async (provider, modelId) => {
          const model = ctx.modelRegistry.find(provider, modelId);
          if (model === undefined) return "missing";
          return (await pi.setModel(model)) ? "selected" : "no_credentials";
        },
        (level) => {
          // SAFETY: WorkerRuntime validates this value against ThinkingSchema before invoking the host callback.
          pi.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
        },
      )
      .pipe(Effect.tap(() => Effect.sync(() => appendPhaseActivation(ctx))));
  }

  if (environment.mode === "implementation") {
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
    parameters: reportSchemaForMode(environment.mode),
    execute(_id, params: WorkerReportInput, _signal: AbortSignal, _update, ctx) {
      return Effect.runPromise(
        runtime
          .handleReport(ctx.cwd, params, runtime.hasExecutorMessage(branch(ctx)), execGit)
          .pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                if (result.terminate === true) runtime.terminal = true;
              }),
            ),
          ),
      );
    },
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (environment.mode !== "implementation" || runtime.phase !== "guide") return;
    const directEdit = !event.isError && (event.toolName === "edit" || event.toolName === "write");
    const operation = directEdit
      ? transitionToExecutor(ctx)
      : Effect.gen(function* () {
          if (!environment.baseCommit) return;
          const status = yield* gitEffect(
            execGit,
            ctx.cwd,
            ["status", "--porcelain", "--untracked-files=all"],
            true,
          );
          if (
            status.length === 0 &&
            (yield* gitEffect(execGit, ctx.cwd, ["rev-parse", "HEAD"])) === environment.baseCommit
          )
            return;
          yield* transitionToExecutor(ctx);
        });
    return Effect.runPromise(
      operation.pipe(
        Effect.catch((error: WorkerExpectedError) =>
          Effect.sync(() => runtime.recordSwitchFailure(error)),
        ),
      ),
    );
  });

  pi.on("model_select", (event) => {
    pi.appendEntry("pi-workgraph-effective-model", {
      ...runtime.generation,
      model: `${event.model.provider}/${event.model.id}`,
      thinking: pi.getThinkingLevel(),
    });
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    if (ctx.model)
      pi.appendEntry("pi-workgraph-effective-model", {
        ...runtime.generation,
        model: `${ctx.model.provider}/${ctx.model.id}`,
        thinking: pi.getThinkingLevel(),
      });
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
        disabledTools = new Set(configuredTools);
        reconcileWorkerTools();
        runtime.restoreSession(branch(ctx));
      }),
  );
  pi.on("tool_call", (event) => {
    if (!isDisabled(event.toolName)) return;
    return {
      block: true,
      reason: `Tool ${event.toolName} is unavailable to this Workgraph worker.`,
    };
  });
  // A tool may register or activate another tool while executing. turn_end is
  // the last extension boundary before Pi snapshots tools for the next request.
  pi.on("turn_end", () => reconcileWorkerTools());
  pi.on("agent_start", (_event, ctx) => {
    if (ctx.model)
      pi.appendEntry("pi-workgraph-effective-model", {
        ...runtime.generation,
        model: `${ctx.model.provider}/${ctx.model.id}`,
        thinking: pi.getThinkingLevel(),
      });
    pi.appendEntry("pi-workgraph-agent-running", {
      ...runtime.generation,
      startedAt: DateTime.formatIso(DateTime.nowUnsafe()),
    });
  });
  pi.on("agent_settled", () => {
    if (
      runtime.scheduleReconciliation((message) =>
        pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true }),
      )
    )
      return;
    pi.appendEntry("pi-workgraph-agent-settled", {
      ...runtime.generation,
      settledAt: DateTime.formatIso(DateTime.nowUnsafe()),
    });
  });

  pi.on("session_compact", (_event, ctx) => {
    const snapshot = runtime.currentRecovery(
      active(ctx),
      branch(ctx),
      environment.mode === "implementation",
    );
    if (snapshot !== undefined) pi.sendMessage(snapshot);
  });
  pi.on("before_agent_start", (event, ctx) => {
    reconcileWorkerTools();
    const recovery = runtime.currentRecovery(active(ctx), branch(ctx), false);
    const message = recovery ?? runtime.currentPhaseActivation(active(ctx));
    const systemPrompt = `${event.systemPrompt}\n\n${runtime.systemPolicy}`;
    return message === undefined ? { systemPrompt } : { systemPrompt, message };
  });
}
