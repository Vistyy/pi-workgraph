import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Config, ConfigProvider, DateTime, Effect } from "effect";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { ThinkingSchema } from "../src/model-policy.js";
import { isWorkerReport, reportSchemaForMode } from "../src/report-schema.js";
import type { ImplementationReport, WorkerMode, WorkerReport } from "../src/types.js";

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

export default function workgraphWorker(pi: ExtensionAPI): void {
  const environment = Effect.runSync(WorkerEnvironmentConfig.parse(ConfigProvider.fromEnv()));
  const mode = readMode(environment.mode);
  if (mode === undefined) return;
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
        Effect.sync(() => {
          if (mode !== "implementation" || phase !== "guide")
            throw new Error("Local Prewalk TODOs belong before the first implementation edit.");
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
        Effect.gen(function* () {
          if (!isWorkerReport(params) || params.kind !== mode)
            throw new Error(`Report must satisfy the ${mode} contract.`);
          if (params.kind === "implementation" && params.status === "completed") {
            if (params.outcome === "no_change") {
              if (baseCommit.length === 0) throw new Error("PI_WORKGRAPH_BASE_COMMIT is required.");
              const status = yield* gitEffect(
                pi,
                ctx.cwd,
                ["status", "--porcelain", "--untracked-files=all"],
                true,
              );
              if (status.length > 0)
                throw new Error(`No-change implementation requires a clean worktree:\n${status}`);
              const revision = yield* gitEffect(pi, ctx.cwd, ["rev-parse", "HEAD"]);
              if (params.revision !== revision || revision !== baseCommit)
                throw new Error(
                  `No-change implementation must report the unchanged base revision ${baseCommit}.`,
                );
              return terminalReport(params, {
                todos,
                todoRecorded: todos.length > 0,
                switchedAt,
                continued,
                outcome: "no_change",
                baseCommit,
                revision,
              });
            }
            if (phase !== "executor")
              throw new Error(
                "Completed changed implementation requires the first-edit model transition.",
              );
            if (switchError !== undefined)
              throw new Error(`Executor model transition failed: ${switchError}`);
            if (!hasExecutorMessage(ctx.sessionManager.getBranch()))
              throw new Error(
                "Completed changed implementation requires an actual executor assistant message after this attempt's transition/start. Continue with the executor before reporting.",
              );
            if (baseCommit.length === 0) throw new Error("PI_WORKGRAPH_BASE_COMMIT is required.");
            const status = yield* gitEffect(
              pi,
              ctx.cwd,
              ["status", "--porcelain", "--untracked-files=all"],
              true,
            );
            if (status.length > 0)
              throw new Error(`Commit and leave a clean worktree before reporting:\n${status}`);
            const [commit, parent, ...extraParents] = (yield* gitEffect(pi, ctx.cwd, [
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
              throw new Error(
                "A completed changed implementation requires exactly one direct commit on the supplied base.",
              );
            const changedText = yield* gitEffect(
              pi,
              ctx.cwd,
              ["diff", "--name-only", "--no-renames", baseCommit, commit],
              true,
            );
            const report: ImplementationReport = {
              ...params,
              commit,
              changedFiles: changedText
                .split("\n")
                .filter((path) => path.length > 0)
                .sort(),
            };
            return terminalReport(report, {
              todos,
              todoRecorded: todos.length > 0,
              switchedAt,
              continued,
              outcome: "changed",
            });
          }
          // Read-only is an instruction and authority boundary, not a filesystem sandbox.
          // Shared research and review deliberately observe the live project cwd, including
          // tracked and untracked local changes. Do not claim an immutable base unless the
          // report records exact Git evidence for the requested revision.
          return terminalReport(params, { todos, switchedAt, switchError });
        }),
      );
    },
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (mode !== "implementation" || phase !== "guide") return;
    const directEdit = !event.isError && (event.toolName === "edit" || event.toolName === "write");
    if (!directEdit) {
      if (!baseCommit) return;
      // Any tool can mutate or commit. Observe Git, not shell-command spelling.
      return Effect.runPromise(
        Effect.gen(function* () {
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
        }).pipe(Effect.catchCause((cause) => Effect.sync(() => recordSwitchFailure(pi, cause)))),
      );
    }
    return Effect.runPromise(
      transitionToExecutor(pi, ctx).pipe(
        Effect.catchCause((cause) => Effect.sync(() => recordSwitchFailure(pi, cause))),
      ),
    );
  });

  function transitionToExecutor(
    extension: ExtensionAPI,
    ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
  ) {
    return Effect.gen(function* () {
      const slash = executorModel.indexOf("/");
      if (slash <= 0) throw new Error(`Invalid executor model: ${executorModel}`);
      const model = ctx.modelRegistry.find(
        executorModel.slice(0, slash),
        executorModel.slice(slash + 1),
      );
      if (model === undefined) throw new Error(`Executor model is unavailable: ${executorModel}`);
      if (!(yield* Effect.promise(() => extension.setModel(model))))
        throw new Error(`Executor model has no usable credentials: ${executorModel}`);
      if (!Value.Check(ThinkingSchema, executorThinking))
        throw new Error(`Invalid executor thinking: ${executorThinking}`);
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

  function recordSwitchFailure(extension: ExtensionAPI, cause: unknown): void {
    switchError = String(cause);
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
  pi.on("session_start", (_event, ctx) => {
    for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
      if (entry.type !== "custom" || entry.customType !== "pi-workgraph-worker-state") continue;
      const attempt = decodeAttemptState(entry.data);
      if (attempt === undefined || !belongsToAttempt(attempt)) continue;
      if (attempt.todos !== undefined) todos = attempt.todos;
      if (attempt.switchedAt !== undefined) switchedAt = attempt.switchedAt;
      if (attempt.phase === "executor") phase = "executor";
      if (attempt.switchError !== undefined) switchError = attempt.switchError;
      break;
    }
  });
  pi.on("agent_start", (_event, ctx) =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (ctx.model)
          pi.appendEntry("pi-workgraph-effective-model", {
            ...generation,
            model: `${ctx.model.provider}/${ctx.model.id}`,
            thinking: pi.getThinkingLevel(),
          });
        pi.appendEntry("pi-workgraph-agent-running", {
          ...generation,
          startedAt: DateTime.formatIso(yield* DateTime.now),
        });
      }),
    ),
  );
  pi.on("agent_settled", () =>
    Effect.runPromise(
      DateTime.now.pipe(
        Effect.map((now) => {
          pi.appendEntry("pi-workgraph-agent-settled", {
            ...generation,
            settledAt: DateTime.formatIso(now),
          });
        }),
      ),
    ),
  );
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
  "[WORKGRAPH EXPERIMENT]\nAnswer the question within the explicitly permitted effects and stop condition in this disposable worktree. Retain the named artifacts and report direct observations, failures and limits. Do not compose, publish, or delegate another worker. Finish with workgraph_report.";
const reviewInstructions =
  "[WORKGRAPH REVIEW]\nReview only the identified subject and concern. For an exact revision subject, inspect that exact commit with Git (for example git show, git diff, and git ls-tree) and cite the revision in evidence; do not silently treat live working files as that commit. Do not claim tests against current working files validate another revision. Execute verification only when it genuinely targets the requested subject. Do not edit files or delegate another worker. Return evidence and actionable findings; zero findings is valid. Finish with workgraph_report.";
const guideInstructions =
  "[WORKGRAPH LOCAL PREWALK - GUIDE]\nInspect the assignment and current isolated worktree. If the requirement already holds, verify it and report no_change with the inspected base revision and reason; no edit or executor turn is required. If a change is needed, record at most eight concrete local TODO items with workgraph_todo before the first useful edit; the runtime then switches models and changed work must complete through the executor. Missing TODO telemetry does not block an otherwise valid implementation. If required work crosses the authorized scope, report escalation without editing.";
function executorInstructions(): string {
  return "[WORKGRAPH EXECUTOR]\nContinue this same worker trajectory in the isolated worktree. Complete the bounded assignment and run its verification. For changed code, create exactly one direct commit on the supplied base and leave the worktree clean. If verification establishes no change is needed and the worktree is clean at the supplied base, report no_change with that revision and reason instead. Return workgraph_report with evidence. Escalate required work beyond the authorized scope.";
}
function gitEffect(pi: ExtensionAPI, cwd: string, args: string[], allowEmpty = false) {
  return Effect.gen(function* () {
    const result = yield* Effect.promise(() => pi.exec("git", ["-C", cwd, ...args]));
    if (result.code !== 0)
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    const output = result.stdout.trim();
    if (!allowEmpty && output.length === 0)
      throw new Error(`git ${args.join(" ")} returned no output.`);
    return output;
  });
}
function readMode(value: string): WorkerMode | undefined {
  if (value.length === 0) return undefined;
  if (value === "research" || value === "review" || value === "implementation") return value;
  throw new Error(`Invalid PI_WORKGRAPH_MODE: ${value}`);
}
