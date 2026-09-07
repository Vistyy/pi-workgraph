import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Config, ConfigProvider, Data, DateTime, Effect } from "effect";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { ThinkingSchema } from "../src/model-policy.js";
import { isWorkerReportInput, reportSchemaForMode } from "../src/report-schema.js";
import type {
  ImplementationReport,
  WorkerMode,
  WorkerReport,
  WorkerReportInput,
} from "../src/types.js";

const WorkerEnvironmentConfig = Config.all({
  mode: Config.string("PI_WORKGRAPH_MODE").pipe(Config.withDefault("")),
  runId: Config.string("PI_WORKGRAPH_RUN_ID").pipe(Config.withDefault("unknown-workstream")),
  nodeId: Config.string("PI_WORKGRAPH_NODE_ID").pipe(Config.withDefault("unknown-attempt")),
  executorModel: Config.string("PI_WORKGRAPH_EXECUTOR_MODEL").pipe(Config.withDefault("")),
  executorThinking: Config.string("PI_WORKGRAPH_EXECUTOR_THINKING").pipe(
    Config.withDefault("high"),
  ),
  baseCommit: Config.string("PI_WORKGRAPH_BASE_COMMIT").pipe(Config.withDefault("")),
  implementationStart: Config.string("PI_WORKGRAPH_IMPLEMENTATION_START").pipe(
    Config.withDefault(""),
  ),
  experiment: Config.string("PI_WORKGRAPH_EXPERIMENT").pipe(Config.withDefault("")),
});

const AttemptStateSchema = Type.Object({
  runId: Type.String(),
  nodeId: Type.String(),
  phase: Type.Optional(Type.Union([Type.Literal("guide"), Type.Literal("executor")])),
  todos: Type.Optional(Type.Array(Type.String())),
  switchedAt: Type.Optional(Type.String()),
  switchError: Type.Optional(Type.String()),
});

type AttemptState = Static<typeof AttemptStateSchema>;

class WorkerContractError extends Data.TaggedError("WorkerContractError")<{
  readonly message: string;
}> {}

class WorkerHostError extends Data.TaggedError("WorkerHostError")<{
  readonly message: string;
  readonly operation: "exec" | "setModel";
}> {}

class WorkerGitError extends Data.TaggedError("WorkerGitError")<{
  readonly message: string;
}> {}

type WorkerExpectedError = WorkerContractError | WorkerHostError | WorkerGitError;

interface WorkerTerminalState {
  readonly todos: readonly string[];
  readonly todoRecorded?: boolean | undefined;
  readonly switchedAt?: string | undefined;
  readonly switchError?: string | undefined;
  readonly continued?: boolean | undefined;
  readonly outcome?: "changed" | "no_change" | undefined;
  readonly baseCommit?: string | undefined;
  readonly revision?: string | undefined;
}

interface WorkerReportExecutionState {
  readonly mode: WorkerMode;
  readonly phase: "guide" | "executor";
  readonly todos: readonly string[];
  readonly switchedAt?: string | undefined;
  readonly switchError?: string | undefined;
  readonly continued: boolean;
  readonly baseCommit: string;
  readonly hasExecutorMessage: () => boolean;
}

export default function workgraphWorker(pi: ExtensionAPI): void {
  const environment = Effect.runSync(WorkerEnvironmentConfig.parse(ConfigProvider.fromEnv()));
  const mode = Effect.runSync(readMode(environment.mode));
  if (mode === null) return;
  const { runId, nodeId, executorModel, executorThinking, baseCommit } = environment;
  const generation = { runId, nodeId };
  const continued = environment.implementationStart === "executor";
  const experiment = environment.experiment === "1";
  let phase: "guide" | "executor" = mode === "implementation" && !continued ? "guide" : "executor";
  let todos: string[] = [];
  let switchError: string | undefined;
  let switchedAt: string | undefined;

  // SAFETY: session custom data is untrusted external input and is decoded before use.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Explicit Pi session decode boundary.
  function decodeAttemptState(data: unknown): AttemptState | undefined {
    return Value.Check(AttemptStateSchema, data)
      ? Value.Decode(AttemptStateSchema, data)
      : undefined;
  }

  function belongsToAttempt(data: AttemptState): boolean {
    return data.runId === runId && data.nodeId === nodeId;
  }

  // Session order, not model selection or wall-clock time, proves a later generation.
  // Pi drains the current assistant message before tool preflight/execution.
  function hasExecutorMessage(entries: SessionEntry[]): boolean {
    const boundary = entries.findIndex((entry) => {
      if (entry.type !== "custom") return false;
      const data = decodeAttemptState(entry.data);
      if (data === undefined || !belongsToAttempt(data)) return false;
      return continued
        ? entry.customType === "pi-workgraph-agent-running"
        : entry.customType === "pi-workgraph-worker-state" &&
            data.phase === "executor" &&
            data.switchedAt !== undefined;
    });
    return (
      boundary >= 0 &&
      entries
        .slice(boundary + 1)
        .some(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "assistant" &&
            `${entry.message.provider}/${entry.message.model}` === executorModel &&
            !["error", "aborted", "pending"].includes(entry.message.stopReason),
        )
    );
  }

  pi.registerTool({
    name: "workgraph_todo",
    label: "Workgraph TODO",
    description: "Record a bounded local implementation TODO before the first edit.",
    parameters: Type.Object({
      items: Type.Array(Type.String({ minLength: 3 }), {
        minItems: 1,
        maxItems: 8,
      }),
    }),
    execute(_id, params) {
      return Effect.runPromise(
        Effect.gen(function* () {
          if (mode !== "implementation" || phase !== "guide")
            return yield* contractFailure(
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
                type: "text" as const,
                text: `Recorded ${todos.length} Local Prewalk items.`,
              },
            ],
            details: { items: todos },
          };
        }),
      );
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
    execute(_id, params, _signal, _update, ctx) {
      return Effect.runPromise(
        handleWorkerReport(pi, ctx.cwd, params, {
          mode,
          phase,
          todos,
          switchedAt,
          switchError,
          continued,
          baseCommit,
          hasExecutorMessage: () => hasExecutorMessage(ctx.sessionManager.getBranch()),
        }),
      );
    },
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (mode !== "implementation" || phase !== "guide") return;
    const directEdit = !event.isError && (event.toolName === "edit" || event.toolName === "write");
    const operation = directEdit
      ? transitionToExecutor(pi, ctx)
      : Effect.gen(function* () {
          if (!baseCommit) return;
          // Any tool can mutate or commit. Observe Git, not shell-command spelling.
          const status = yield* gitEffect(
            pi,
            ctx.cwd,
            ["status", "--porcelain", "--untracked-files=all"],
            true,
          );
          if (
            status.length === 0 &&
            (yield* gitEffect(pi, ctx.cwd, ["rev-parse", "HEAD"])) === baseCommit
          )
            return;
          yield* transitionToExecutor(pi, ctx);
        });
    return Effect.runPromise(
      operation.pipe(Effect.catch((error) => Effect.sync(() => recordSwitchFailure(pi, error)))),
    );
  });

  function transitionToExecutor(
    extension: ExtensionAPI,
    ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
  ) {
    return Effect.gen(function* () {
      const slash = executorModel.indexOf("/");
      if (slash <= 0) return yield* contractFailure(`Invalid executor model: ${executorModel}`);
      const model = ctx.modelRegistry.find(
        executorModel.slice(0, slash),
        executorModel.slice(slash + 1),
      );
      if (model === undefined)
        return yield* contractFailure(`Executor model is unavailable: ${executorModel}`);
      const selected = yield* Effect.tryPromise({
        try: () => extension.setModel(model),
        catch: () =>
          new WorkerHostError({
            operation: "setModel",
            message: `Pi could not select executor model: ${executorModel}`,
          }),
      });
      if (!selected)
        return yield* contractFailure(`Executor model has no usable credentials: ${executorModel}`);
      if (!Value.Check(ThinkingSchema, executorThinking))
        return yield* contractFailure(`Invalid executor thinking: ${executorThinking}`);
      extension.setThinkingLevel(executorThinking);
      phase = "executor";
      switchError = undefined;
      switchedAt = DateTime.formatIso(yield* DateTime.now);
      extension.appendEntry("pi-workgraph-worker-state", {
        ...generation,
        phase,
        todos,
        executorModel,
        executorThinking,
        switchedAt,
      });
    });
  }

  function recordSwitchFailure(extension: ExtensionAPI, error: WorkerExpectedError): void {
    switchError = error.message;
    extension.appendEntry("pi-workgraph-worker-state", {
      ...generation,
      phase,
      todos,
      switchError,
    });
  }
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
  function latestAttemptState(entries: SessionEntry[]): AttemptState | undefined {
    for (const entry of [...entries].reverse()) {
      if (entry.type !== "custom" || entry.customType !== "pi-workgraph-worker-state") continue;
      const attempt = decodeAttemptState(entry.data);
      if (attempt !== undefined && belongsToAttempt(attempt)) return attempt;
    }
    return undefined;
  }

  function reattachAttemptState(attempt: AttemptState): void {
    if (attempt.todos !== undefined) todos = attempt.todos;
    if (attempt.switchedAt !== undefined) switchedAt = attempt.switchedAt;
    if (attempt.phase === "executor") phase = "executor";
    if (attempt.switchError !== undefined) switchError = attempt.switchError;
  }

  pi.on("session_start", (_event, ctx) => {
    // Workgraph workers must not be able to rename their Herdr tab. Preserve every
    // other active tool, including tools supplied by the host or another extension.
    const activeTools = pi.getActiveTools();
    if (activeTools.includes("herdr_rename"))
      pi.setActiveTools(activeTools.filter((toolName) => toolName !== "herdr_rename"));

    const attempt = latestAttemptState(ctx.sessionManager.getBranch());
    if (attempt !== undefined) reattachAttemptState(attempt);
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
      startedAt: DateTime.formatIso(DateTime.nowUnsafe()),
    });
  });
  pi.on("agent_settled", () => {
    pi.appendEntry("pi-workgraph-agent-settled", {
      ...generation,
      settledAt: DateTime.formatIso(DateTime.nowUnsafe()),
    });
  });
  pi.on("context", (event) => {
    if (mode !== "implementation" || phase !== "executor") return;
    return {
      messages: [
        ...event.messages.filter(
          (message) => !(message.role === "custom" && message.customType === "pi-workgraph-guide"),
        ),
        {
          role: "custom" as const,
          customType: "pi-workgraph-executor",
          content: executorInstructions(),
          display: false,
          details: generation,
          timestamp: DateTime.toEpochMillis(DateTime.nowUnsafe()),
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

function handleWorkerReport(
  pi: ExtensionAPI,
  cwd: string,
  params: WorkerReportInput,
  execution: WorkerReportExecutionState,
) {
  return Effect.gen(function* () {
    if (!isWorkerReportInput(params) || params.kind !== execution.mode)
      return yield* contractFailure(`Report must satisfy the ${execution.mode} contract.`);
    if (params.kind !== "implementation" || params.status !== "completed") {
      // Read-only is an instruction and authority boundary, not a filesystem sandbox.
      // Shared research and review deliberately observe the live project cwd, including
      // tracked and untracked local changes. Do not claim an immutable base unless the
      // report records exact Git evidence for the requested revision.
      return terminalReport(params, {
        todos: execution.todos,
        switchedAt: execution.switchedAt,
        switchError: execution.switchError,
      });
    }
    if (params.outcome === "no_change")
      return yield* noChangeImplementationReport(pi, cwd, params, execution);
    return yield* changedImplementationReport(pi, cwd, params, execution);
  });
}

function noChangeImplementationReport(
  pi: ExtensionAPI,
  cwd: string,
  report: Extract<ImplementationReport, { outcome: "no_change" }>,
  execution: WorkerReportExecutionState,
) {
  return Effect.gen(function* () {
    if (execution.baseCommit.length === 0)
      return yield* contractFailure("PI_WORKGRAPH_BASE_COMMIT is required.");
    yield* requireCleanWorktree(pi, cwd, "No-change implementation requires a clean worktree:");
    const revision = yield* gitEffect(pi, cwd, ["rev-parse", "HEAD"]);
    if (report.revision !== revision || revision !== execution.baseCommit)
      return yield* contractFailure(
        `No-change implementation must report the unchanged base revision ${execution.baseCommit}.`,
      );
    return terminalReport(report, {
      todos: execution.todos,
      todoRecorded: execution.todos.length > 0,
      switchedAt: execution.switchedAt,
      continued: execution.continued,
      outcome: "no_change",
      baseCommit: execution.baseCommit,
      revision,
    });
  });
}

function changedImplementationReport(
  pi: ExtensionAPI,
  cwd: string,
  report: Extract<ImplementationReport, { outcome: "changed" }>,
  execution: WorkerReportExecutionState,
) {
  return Effect.gen(function* () {
    if (execution.phase !== "executor")
      return yield* contractFailure(
        "Completed changed implementation requires the first-edit model transition.",
      );
    if (execution.switchError !== undefined)
      return yield* contractFailure(`Executor model transition failed: ${execution.switchError}`);
    if (!execution.hasExecutorMessage())
      return yield* contractFailure(
        "Completed changed implementation requires an actual executor assistant message after this attempt's transition/start. Continue with the executor before reporting.",
      );
    if (execution.baseCommit.length === 0)
      return yield* contractFailure("PI_WORKGRAPH_BASE_COMMIT is required.");
    const provenance = yield* changedCommitProvenance(pi, cwd, execution.baseCommit);
    return terminalReport(
      { ...report, ...provenance },
      {
        todos: execution.todos,
        todoRecorded: execution.todos.length > 0,
        switchedAt: execution.switchedAt,
        continued: execution.continued,
        outcome: "changed",
      },
    );
  });
}

function changedCommitProvenance(pi: ExtensionAPI, cwd: string, baseCommit: string) {
  return Effect.gen(function* () {
    yield* requireCleanWorktree(pi, cwd, "Commit and leave a clean worktree before reporting:");
    const [commit, parent, ...extraParents] = (yield* gitEffect(pi, cwd, [
      "rev-list",
      "--parents",
      "-n",
      "1",
      "HEAD",
    ])).split(" ");
    if (
      commit === undefined ||
      commit.length === 0 ||
      parent !== baseCommit ||
      extraParents.length > 0
    )
      return yield* contractFailure(
        "A completed changed implementation requires exactly one direct commit on the supplied base.",
      );
    const changedText = yield* gitEffect(
      pi,
      cwd,
      ["diff", "--name-only", "--no-renames", baseCommit, commit],
      true,
    );
    return {
      commit,
      changedFiles: changedText
        .split("\n")
        .filter((path) => path.length > 0)
        .sort(),
    };
  });
}

function requireCleanWorktree(pi: ExtensionAPI, cwd: string, errorPrefix: string) {
  return Effect.gen(function* () {
    const status = yield* gitEffect(
      pi,
      cwd,
      ["status", "--porcelain", "--untracked-files=all"],
      true,
    );
    if (status.length > 0) return yield* contractFailure(`${errorPrefix}\n${status}`);
  });
}

function terminalReport(report: WorkerReport, state: WorkerTerminalState) {
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
  "[WORKGRAPH EXPERIMENT]\nAnswer the question within the explicitly permitted effects and stop condition in this disposable worktree. Leave all outputs in the assigned worktree and report direct observations, failures and limits; the coordinator decides when to release the worktree. Do not compose, publish, or delegate another worker. Finish with workgraph_report.";
const reviewInstructions =
  "[WORKGRAPH REVIEW]\nReview only the identified subject and concern. For an exact revision subject, inspect that exact commit with Git (for example git show, git diff, and git ls-tree) and cite the revision in evidence; do not silently treat live working files as that commit. Do not claim tests against current working files validate another revision. Execute verification only when it genuinely targets the requested subject. Do not edit files or delegate another worker. Return evidence and actionable findings; zero findings is valid. Finish with workgraph_report.";
const guideInstructions =
  "[WORKGRAPH LOCAL PREWALK - GUIDE]\nInspect the assignment and current isolated worktree. If the requirement already holds, verify it and report no_change with the inspected base revision and reason; no edit or executor turn is required. If a change is needed, record at most eight concrete local TODO items with workgraph_todo before the first useful edit; the runtime then switches models and changed work must complete through the executor. Missing TODO telemetry does not block an otherwise valid implementation. If required work crosses the authorized scope, report escalation without editing.";
function executorInstructions(): string {
  return "[WORKGRAPH EXECUTOR]\nContinue this same worker trajectory in the isolated worktree. Complete the bounded assignment and run its verification. For changed code, create exactly one direct commit on the supplied base and leave the worktree clean. If verification establishes no change is needed and the worktree is clean at the supplied base, report no_change with that revision and reason instead. Return workgraph_report with evidence. Escalate required work beyond the authorized scope.";
}
function gitEffect(pi: ExtensionAPI, cwd: string, args: string[], allowEmpty = false) {
  return Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () => pi.exec("git", ["-C", cwd, ...args]),
      catch: () =>
        new WorkerHostError({
          operation: "exec",
          message: `Pi could not execute git ${args.join(" ")}.`,
        }),
    });
    if (result.code !== 0)
      return yield* gitFailure(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    const output = result.stdout.trim();
    if (!allowEmpty && output.length === 0)
      return yield* gitFailure(`git ${args.join(" ")} returned no output.`);
    return output;
  });
}

function contractFailure(message: string) {
  return Effect.fail(new WorkerContractError({ message }));
}

function gitFailure(message: string) {
  return Effect.fail(new WorkerGitError({ message }));
}

function readMode(value: string) {
  if (value.length === 0) return Effect.succeed<WorkerMode | null>(null);
  if (value === "research" || value === "review" || value === "implementation")
    return Effect.succeed<WorkerMode | null>(value);
  return contractFailure(`Invalid PI_WORKGRAPH_MODE: ${value}`);
}
