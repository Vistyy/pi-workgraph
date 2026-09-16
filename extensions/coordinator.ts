/* oxlint-disable effecttsgo/async-function, effecttsgo/process-env, anti-slop/no-object-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread -- Pi callbacks are Promise boundaries; registered TypeBox schemas validate values before these typed callbacks. */
import { readFileSync } from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Effect, Exit, Match, Scope } from "effect";
import { type Static, type TSchema, Type } from "typebox";
import { installCalmMode, isCoordinatorScope } from "../src/calm/index.js";
import { createCheckout } from "../src/coordinator/checkouts.js";
import type { HerdrCliRuntime } from "../src/coordinator/herdr.js";
import {
  implementationTargets,
  loadModelPolicy,
  type ModelPolicy,
  modelPolicyPath,
  resolveSelection,
  SelectionRequestSchema,
} from "../src/coordinator/model-policy.js";
import { installNotepad } from "../src/coordinator/notepad.js";
import { type CandidateRequest, RuntimeError, SessionRuntime } from "../src/coordinator/runtime.js";
import { RecordStore } from "../src/coordinator/store.js";
import {
  type AttemptRecord,
  type AttemptSelection,
  CommitSchema,
  ReviewSubjectSchema,
  type Task,
  type TaskContract,
  TaskIdSchema,
} from "../src/domain/records.js";
import { resolveRevision, resolveTaskTarget } from "../src/repository.js";

const Text = Type.String({ minLength: 1, pattern: "\\S" });

const nonBlank = (description: string) =>
  Type.String({ minLength: 1, pattern: "\\S", description });

const CandidateOf = Type.Optional(
  Type.Object(
    {
      attemptId: nonBlank("Exact parent Attempt ID."),
      mode: StringEnum(["extend", "integrate"] as const, {
        description:
          "extend continues from the parent's Candidate; integrate starts from the destination and includes the parent's retained output.",
      }),
    },
    {
      additionalProperties: false,
      description: "Optional parent Candidate relationship for the new Attempt.",
    },
  ),
);

const Selection = Type.Optional(SelectionRequestSchema);

const TaskFields = {
  id: TaskIdSchema,
  cwd: Type.Optional(nonBlank("Directory or repository that owns the Task target.")),
};

const PageFields = {
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based result offset." })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 100, description: "Maximum records to return." }),
  ),
};

export interface CoordinatorOptions {
  readonly agentDir?: string;
  readonly policyPath?: string;
  readonly herdr?: HerdrCliRuntime;
}

export default function coordinator(pi: ExtensionAPI, options: CoordinatorOptions = {}): void {
  if (!isCoordinatorScope(process.env)) return;
  const guidance = readFileSync(new URL("../COORDINATOR.md", import.meta.url), "utf8").trim();
  const agentDir = options.agentDir ?? getAgentDir();
  const policyPath = options.policyPath ?? modelPolicyPath(agentDir);
  const calm = installCalmMode(pi);
  let attached: SessionRuntime | undefined;
  let scope: Scope.Scope | undefined;
  let tail = Promise.resolve();

  const serialize = <A>(run: () => Promise<A>): Promise<A> => {
    const result = tail.then(run, run);
    tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  };

  const runtime = (): SessionRuntime => {
    if (attached === undefined) throw new Error("Workgraph session runtime is not attached.");

    return attached;
  };

  const close = async (): Promise<void> => {
    attached = undefined;

    if (scope !== undefined) {
      const closing = scope;
      scope = undefined;
      await Effect.runPromise(Scope.close(closing, Exit.void));
    }

    calm.setActiveWorkers(0);
  };

  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt.endsWith(guidance)
      ? event.systemPrompt
      : `${event.systemPrompt}\n\n${guidance}`,
  }));
  pi.on("session_start", (_event, ctx) =>
    serialize(async () => {
      await close();
      const nextScope = await Effect.runPromise(Scope.make());
      const store = new RecordStore(agentDir, ctx.sessionManager.getSessionId());

      try {
        const next = await Effect.runPromise(
          SessionRuntime.acquire({
            store,
            agentDir,
            // biome-ignore lint/complexity/useLiteralKeys: ProcessEnv keys require indexed access under noPropertyAccessFromIndexSignature.
            workspaceId: process.env["HERDR_WORKSPACE_ID"] ?? "",
            pi,
            ...(options.herdr === undefined ? {} : { herdr: options.herdr }),
            setActiveWorkers: (count) => calm.setActiveWorkers(count),
          }).pipe(Scope.provide(nextScope)),
        );

        scope = nextScope;
        attached = next;
      } catch (cause) {
        await Effect.runPromise(Scope.close(nextScope, Exit.void));
        ctx.ui.notify(`Workgraph blocked: ${publicMessage(cause)}`, "warning");
      }
    }),
  );
  pi.on("session_shutdown", () => serialize(close));

  installNotepad(pi);

  pi.registerTool({
    name: "workgraph_checkout",
    label: "Workgraph Checkout",
    description: "Create or exactly reuse this session's deterministic branch-backed checkout.",
    parameters: Type.Object(
      {
        cwd: Type.Optional(
          nonBlank("Repository checkout to allocate from; defaults to the session cwd."),
        ),
      },
      { additionalProperties: false },
    ),
    execute(_id, params, _signal, _update, ctx) {
      return serialize(async () =>
        result(
          await createCheckout({
            agentDir: runtime().agentDir,
            sessionId: ctx.sessionManager.getSessionId(),
            cwd: ctx.cwd,
            ...(params.cwd === undefined ? {} : { path: params.cwd }),
          }),
        ),
      );
    },
  });

  registerTask(
    pi,
    "workgraph_research",
    "Research",
    Type.Object(
      {
        ...TaskFields,
        question: nonBlank("Question the Research Task must answer."),
        expectedEvidence: Type.Array(Text, {
          minItems: 1,
          description: "Evidence the Research Outcome must provide.",
        }),
        selection: Selection,
      },
      { additionalProperties: false },
    ),
    async (params, ctx) => {
      return createTask(runtime(), ctx, policyPath, {
        id: params.id,
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        targetKind: "directory",
        contract: {
          kind: "research",
          question: params.question,
          expectedEvidence: params.expectedEvidence,
        },
        ...(params.selection === undefined ? {} : { selection: params.selection }),
      });
    },
    serialize,
  );

  registerTask(
    pi,
    "workgraph_experiment",
    "Experiment",
    Type.Object(
      {
        ...TaskFields,
        question: nonBlank("Question the Experiment Task must answer."),
        expectedEvidence: Type.Array(Text, { minItems: 1 }),
        permittedEffects: Type.Array(Text, {
          minItems: 1,
          description: "Effects independently permitted for every selected Attempt.",
        }),
        stopCondition: nonBlank("Stop condition independently binding every selected Attempt."),
        selection: Selection,
      },
      { additionalProperties: false },
    ),
    async (params, ctx) =>
      createTask(runtime(), ctx, policyPath, {
        id: params.id,
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        targetKind: "repository",
        contract: {
          kind: "experiment",
          question: params.question,
          expectedEvidence: params.expectedEvidence,
          permittedEffects: params.permittedEffects,
          stopCondition: params.stopCondition,
        },
        ...(params.selection === undefined ? {} : { selection: params.selection }),
      }),
    serialize,
  );

  registerTask(
    pi,
    "workgraph_consult",
    "Consult",
    Type.Object(
      {
        ...TaskFields,
        question: nonBlank("Question for the consultation advisor."),
        context: Type.Optional(
          Type.String({
            maxLength: 20_000,
            description: "Relevant context not already available in the target directory.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async (params, ctx) => {
      const policy = await loadModelPolicy(policyPath);

      const contract: TaskContract =
        params.context === undefined
          ? { kind: "consultation", question: params.question }
          : { kind: "consultation", question: params.question, context: params.context };

      return createTask(runtime(), ctx, policyPath, {
        id: params.id,
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        targetKind: "directory",
        contract,
        fixedSelection: {
          kind: "target",
          target: { ...policy.roles["consultation.advisor"] },
        },
      });
    },
    serialize,
  );

  registerTask(
    pi,
    "workgraph_implement",
    "Implement",
    Type.Object(
      {
        ...TaskFields,
        objective: nonBlank("Implementation outcome the Worker must produce."),
        acceptance: Type.Array(Text, {
          minItems: 1,
          description: "Observable acceptance conditions for the Candidate.",
        }),
        useEscalationExecutor: Type.Optional(
          Type.Boolean({ description: "Use the configured escalation executor." }),
        ),
        candidateOf: CandidateOf,
        baseRevision: Type.Optional(CommitSchema),
      },
      { additionalProperties: false },
    ),
    async (params, ctx) => {
      if (params.candidateOf?.mode === "extend" && params.baseRevision !== undefined)
        throw new Error("Candidate extension forbids baseRevision.");
      const policy = await loadModelPolicy(policyPath);
      const selected = implementationTargets(policy, params.useEscalationExecutor ?? false);

      return createTask(runtime(), ctx, policyPath, {
        id: params.id,
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        targetKind: "repository",
        contract: {
          kind: "implementation",
          objective: params.objective,
          acceptance: params.acceptance,
        },
        fixedSelection: {
          kind: "implementation",
          guide: selected.guide,
          executor: selected.executor,
        },
        ...(params.candidateOf === undefined ? {} : { candidateOf: params.candidateOf }),
        ...(params.baseRevision === undefined ? {} : { baseRevision: params.baseRevision }),
      });
    },
    serialize,
  );

  registerTask(
    pi,
    "workgraph_review",
    "Review",
    Type.Object(
      {
        ...TaskFields,
        objective: nonBlank("Outcome or behavior the review should assess."),
        concern: nonBlank("Specific risk or quality concern to investigate."),
        subject: ReviewSubjectSchema,
        selection: Selection,
      },
      { additionalProperties: false },
    ),
    async (params, ctx) =>
      createTask(runtime(), ctx, policyPath, {
        id: params.id,
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        targetKind: params.subject.kind === "revision" ? "repository" : "directory",
        contract: {
          kind: "review",
          objective: params.objective,
          concern: params.concern,
          subject: params.subject,
        },
        ...(params.selection === undefined ? {} : { selection: params.selection }),
        ...(params.subject.kind === "revision" ? { baseRevision: params.subject.revision } : {}),
      }),
    serialize,
  );

  pi.registerTool({
    name: "workgraph_attempt",
    label: "Workgraph Attempt",
    description:
      "Create another execution of the same immutable Task under current model policy and a fresh applicable base. Create a new Task instead when the assignment or authority changes.",
    parameters: Type.Object(
      {
        taskId: TaskIdSchema,
        candidateOf: CandidateOf,
        baseRevision: Type.Optional(CommitSchema),
        useEscalationExecutor: Type.Optional(
          Type.Boolean({ description: "Use the configured escalation executor." }),
        ),
      },
      { additionalProperties: false },
    ),
    execute(_id, params) {
      return serialize(async () => {
        const current = runtime();
        const attempt = await createAttempt(current, policyPath, params);

        return result(attemptReceipt(attempt));
      });
    },
  });

  pi.registerTool({
    name: "workgraph_inspect",
    label: "Workgraph Inspect",
    description: "Inspect bounded records for this Pi session.",
    parameters: Type.Union([
      Type.Object(
        {
          section: Type.Literal("overview", {
            description: "Summarize Task and Attempt state for this session.",
          }),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          section: Type.Literal("task", { description: "Read one exact Task by ID." }),
          id: TaskIdSchema,
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          section: Type.Literal("task", { description: "List Tasks for this session." }),
          ...PageFields,
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          section: Type.Literal("attempt", { description: "Read one exact Attempt by ID." }),
          id: nonBlank("Exact Attempt ID."),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          section: Type.Literal("attempt", {
            description: "List Attempts, optionally limited to one Task.",
          }),
          taskId: Type.Optional(TaskIdSchema),
          ...PageFields,
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          section: Type.Literal("report", {
            description: "Read a bounded slice of one Attempt's Worker report.",
          }),
          attemptId: nonBlank("Exact Attempt ID."),
          offset: Type.Optional(
            Type.Integer({ minimum: 0, description: "Zero-based character offset." }),
          ),
          maxChars: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 20_000,
              description: "Maximum report characters to return.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
    ]),
    execute(_id, params) {
      return serialize(async () => result(inspect(runtime(), params)));
    },
  });

  pi.registerTool({
    name: "workgraph_control",
    label: "Workgraph Control",
    description: "Cancel, steer, apply, or explicitly discard output for one exact Attempt.",
    parameters: Type.Union([
      Type.Object(
        {
          action: Type.Literal("cancel", {
            description: "Cancel the exact active Attempt and close its Worker.",
          }),
          attemptId: nonBlank("Exact Attempt ID."),
          reason: nonBlank("Why the Attempt is being cancelled."),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("steer", {
            description: "Send an instruction to the exact active Attempt.",
          }),
          attemptId: nonBlank("Exact Attempt ID."),
          instruction: nonBlank("Focused instruction for the active Worker."),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("apply", {
            description: "Apply the exact retained Candidate to its recorded destination.",
          }),
          attemptId: nonBlank("Exact Attempt ID."),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("discard_output", {
            description: "Explicitly discard the exact retained Candidate output.",
          }),
          attemptId: nonBlank("Exact Attempt ID."),
          reason: nonBlank("Why the retained output is being discarded."),
        },
        { additionalProperties: false },
      ),
    ]),
    execute(_id, params) {
      return serialize(async () => {
        const current = runtime();

        try {
          if (params.action === "steer") {
            await Effect.runPromise(current.steer(params.attemptId, params.instruction));

            return result({
              action: params.action,
              delivery: "submitted",
              attempt: inspectedAttempt(current, current.store.readAttempt(params.attemptId)),
            });
          }

          const operation = Match.value(params).pipe(
            Match.when({ action: "cancel" }, ({ attemptId, reason }) =>
              current.cancel(attemptId, reason),
            ),
            Match.when({ action: "apply" }, ({ attemptId }) => current.apply(attemptId)),
            Match.when({ action: "discard_output" }, ({ attemptId, reason }) =>
              current.discard(attemptId, reason),
            ),
            Match.exhaustive,
          );

          const attempt = await Effect.runPromise(operation);

          return result({ action: params.action, attempt: inspectedAttempt(current, attempt) });
        } catch (cause) {
          throw new Error(
            `${publicMessage(cause)} Inspect exact Attempt ${params.attemptId} persisted state before retrying.`,
            { cause },
          );
        }
      });
    },
  });
}

type CreateTaskInput = {
  readonly id: string;
  readonly cwd?: string;
  readonly targetKind: "directory" | "repository";
  readonly contract: TaskContract;
  readonly selection?: { readonly count?: number; readonly distinctModels?: boolean };
  readonly fixedSelection?: AttemptSelection;
  readonly candidateOf?: CandidateRequest;
  readonly baseRevision?: string;
};

async function createTask(
  runtime: SessionRuntime,
  ctx: ExtensionContext,
  policyPath: string,
  input: CreateTaskInput,
): Promise<object> {
  const revision =
    input.candidateOf?.mode === "extend"
      ? retainedTip(runtime, input.candidateOf.attemptId)
      : input.baseRevision;

  const resolved = await Effect.runPromise(
    resolveTaskTarget({
      cwd: ctx.cwd,
      ...(input.cwd === undefined ? {} : { path: input.cwd }),
      kind: input.targetKind,
      ...(input.targetKind === "repository" && revision !== undefined ? { revision } : {}),
    }),
  );

  const selections = await selectionsFor(input, policyPath);
  const first = selections[0];

  if (first === undefined) throw new Error("Task requires at least one model selection.");

  const initial = await Effect.runPromise(
    runtime.createTask({
      id: input.id,
      target: resolved.target,
      contract: input.contract,
      selection: first,
      ...(input.candidateOf === undefined ? {} : { candidateOf: input.candidateOf }),
      ...("commit" in resolved && input.candidateOf?.mode !== "extend"
        ? { baseCommit: resolved.commit }
        : {}),
    }),
  );

  const attempts = [initial];

  try {
    for (const selection of selections.slice(1)) {
      attempts.push(
        await Effect.runPromise(
          runtime.createAttempt({
            taskId: input.id,
            selection,
            ...("commit" in resolved ? { baseCommit: resolved.commit } : {}),
          }),
        ),
      );
    }
  } catch (cause) {
    throw new Error(
      `Task ${input.id} was durably created with ${attempts.length} Attempt(s) before creation failed. Inspect the Task and Attempts; do not retry blindly. ${publicMessage(cause)}`,
      { cause },
    );
  }

  return {
    task: { id: input.id, kind: input.contract.kind, target: resolved.target },
    attempts: attempts.map(attemptReceipt),
  };
}

async function selectionsFor(
  input: CreateTaskInput,
  policyPath: string,
): Promise<AttemptSelection[]> {
  if (input.fixedSelection !== undefined) return [input.fixedSelection];
  const policy = await loadModelPolicy(policyPath);
  const role = input.contract.kind === "review" ? "review" : "research";

  return resolveSelection(role, input.selection, policy).selected.map((target) => ({
    kind: "target",
    target,
  }));
}

async function createAttempt(
  runtime: SessionRuntime,
  policyPath: string,
  params: {
    readonly taskId: string;
    readonly candidateOf?: CandidateRequest;
    readonly baseRevision?: string;
    readonly useEscalationExecutor?: boolean;
  },
): Promise<AttemptRecord> {
  if (params.candidateOf?.mode === "extend" && params.baseRevision !== undefined)
    throw new Error("Candidate extension forbids baseRevision.");
  const task = runtime.store.readTask(params.taskId).task;

  if (params.candidateOf !== undefined && task.contract.kind !== "implementation")
    throw new Error("candidateOf is supported only for implementation Attempts.");

  if (params.useEscalationExecutor !== undefined && task.contract.kind !== "implementation")
    throw new Error("useEscalationExecutor is supported only for implementation Attempts.");

  if (params.baseRevision !== undefined && task.target.kind !== "repository")
    throw new Error("baseRevision is supported only for repository Attempts.");
  const policy = await loadModelPolicy(policyPath);
  const selection = selectionForAttempt(task.contract, policy, params.useEscalationExecutor);
  const baseCommit = await baseForAttempt(task, params.candidateOf, params.baseRevision);

  return Effect.runPromise(
    runtime.createAttempt({
      taskId: params.taskId,
      selection,
      ...(params.candidateOf === undefined ? {} : { candidateOf: params.candidateOf }),
      ...(baseCommit === undefined ? {} : { baseCommit }),
    }),
  );
}

function selectionForAttempt(
  contract: TaskContract,
  policy: ModelPolicy,
  useEscalationExecutor?: boolean,
): AttemptSelection {
  if (contract.kind === "implementation") {
    const selected = implementationTargets(policy, useEscalationExecutor ?? false);

    return { kind: "implementation", guide: selected.guide, executor: selected.executor };
  }

  if (contract.kind === "consultation")
    return { kind: "target", target: { ...policy.roles["consultation.advisor"] } };

  const role = Match.value(contract.kind).pipe(
    Match.when("review", () => "review" as const),
    Match.orElse(() => "research" as const),
  );

  return { kind: "target", target: { ...policy.roles[role][0] } };
}

async function baseForAttempt(
  task: Task,
  candidateOf?: CandidateRequest,
  baseRevision?: string,
): Promise<string | undefined> {
  if (task.target.kind !== "repository" || candidateOf?.mode === "extend") return undefined;

  const requested =
    baseRevision ??
    (task.contract.kind === "review" && task.contract.subject.kind === "revision"
      ? task.contract.subject.revision
      : "HEAD");

  return Effect.runPromise(resolveRevision(task.target, requested));
}

function retainedTip(runtime: SessionRuntime, attemptId: string): string {
  const attempt = runtime.store.readAttempt(attemptId);

  if (attempt.output?.kind !== "retained")
    throw new Error("Candidate parent has no retained output.");

  return attempt.output.tip;
}

type InspectInput =
  | { readonly section: "overview" }
  | {
      readonly section: "task";
      readonly id?: string;
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly section: "attempt";
      readonly id?: string;
      readonly taskId?: string;
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly section: "report";
      readonly attemptId: string;
      readonly offset?: number;
      readonly maxChars?: number;
    };

function inspect(runtime: SessionRuntime, params: Static<TSchema>) {
  // SAFETY: This helper receives only values decoded by the registered inspection union.
  const input = params as InspectInput;

  switch (input.section) {
    case "overview": {
      const status = runtime.inspectionStatus();

      return {
        counts: runtime.store.counts(),
        blockers: status.blockers,
        activeWorkers: status.activeWorkers,
      };
    }

    case "task":
      return inspectTasks(runtime, input);
    case "attempt":
      return inspectAttempts(runtime, input);
    case "report":
      return inspectReport(runtime, input);
  }
}

function inspectTasks(runtime: SessionRuntime, input: Extract<InspectInput, { section: "task" }>) {
  if (input.id !== undefined) return runtime.store.readTask(input.id);
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 20;

  return {
    offset,
    limit,
    tasks: runtime.store.listTasks(offset, limit).map((record) => ({
      id: record.id,
      targetKind: record.task.target.kind,
      taskKind: record.task.contract.kind,
    })),
  };
}

function inspectAttempts(
  runtime: SessionRuntime,
  input: Extract<InspectInput, { section: "attempt" }>,
) {
  if (input.id !== undefined) return inspectedAttempt(runtime, runtime.store.readAttempt(input.id));
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 20;

  return {
    offset,
    limit,
    attempts: runtime.store.listAttempts(offset, limit, input.taskId).map((attempt) => ({
      taskId: attempt.taskId,
      attemptId: attempt.id,
      outcome: attempt.outcome?.result.kind ?? null,
      output: attempt.output?.kind ?? null,
    })),
  };
}

function inspectReport(
  runtime: SessionRuntime,
  input: Extract<InspectInput, { section: "report" }>,
) {
  const attempt = runtime.store.readAttempt(input.attemptId);

  if (attempt.outcome?.result.kind !== "reported") throw new Error("Attempt has no report.");
  const text = JSON.stringify(attempt.outcome.result.report);
  const offset = input.offset ?? 0;
  const maxChars = input.maxChars ?? 4_000;

  return {
    attemptId: input.attemptId,
    offset,
    maxChars,
    totalChars: text.length,
    text: text.slice(offset, offset + maxChars),
  };
}

function inspectedAttempt(runtime: SessionRuntime, attempt: AttemptRecord) {
  const outcome = attempt.outcome;
  const task = runtime.store.readTask(attempt.taskId).task;

  return {
    attemptId: attempt.id,
    taskId: attempt.taskId,
    task: { target: task.target, contract: task.contract },
    spec: attempt.spec,
    worker: attempt.worker ?? null,
    output: attempt.output ?? null,
    blocker: runtime.blockerFor(attempt.id) ?? null,
    effectiveModels: outcome?.effectiveModels ?? [],
    outcome:
      outcome === undefined
        ? null
        : outcome.result.kind === "reported"
          ? {
              kind: outcome.result.kind,
              reportStatus: outcome.result.report.status,
              ...(outcome.result.report.kind === "implementation" &&
              "outcome" in outcome.result.report
                ? { reportOutcome: outcome.result.report.outcome }
                : {}),
              summary: outcome.result.report.summary,
            }
          : { kind: outcome.result.kind, summary: outcome.result.reason },
    reportPreview:
      outcome?.result.kind === "reported" ? previewReport(outcome.result.report) : null,
  };
}

function previewReport(report: object, maxChars = 2_000) {
  const text = JSON.stringify(report);

  return {
    text: text.slice(0, maxChars),
    totalChars: text.length,
    truncated: text.length > maxChars,
  };
}

function registerTask<S extends TSchema>(
  pi: ExtensionAPI,
  name: string,
  label: string,
  parameters: S,
  run: (params: Static<S>, ctx: ExtensionContext) => Promise<object>,
  serialize: <A>(run: () => Promise<A>) => Promise<A>,
): void {
  pi.registerTool({
    name,
    label: `Workgraph ${label}`,
    description: `Create one immutable ${label} Task with its selected initial Attempts.`,
    parameters,
    execute(_id, params, _signal, _update, ctx) {
      return serialize(() => run(params as Static<S>, ctx).then(result));
    },
  });
}

function attemptReceipt(record: AttemptRecord) {
  return { taskId: record.taskId, attemptId: record.id, spec: record.spec };
}

function result(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function publicMessage(cause: unknown): string {
  return (
    cause instanceof RuntimeError
      ? `${cause.operation}: ${cause.message}`
      : cause instanceof Error
        ? cause.message
        : "operation failed"
  )
    .replace(/\s+/g, " ")
    .slice(0, 500);
}
