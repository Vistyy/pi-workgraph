/* oxlint-disable effecttsgo/async-function, effecttsgo/process-env, anti-slop/no-conditional-empty-object-spread -- Pi callbacks are Promise boundaries; registered TypeBox schemas validate values before these typed callbacks. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Effect, Exit, Match, Scope } from "effect";
import { Type } from "typebox";
import { installCalmMode, isCoordinatorScope } from "../src/calm/index.js";
import { createCheckout, finishCheckout } from "../src/coordinator/checkouts.js";
import {
  deliverySettingsPath,
  installDeliveryTools,
  loadDeferredDeliveryTools,
} from "../src/coordinator/delivery-tools.js";
import type { HerdrCliRuntime } from "../src/coordinator/herdr.js";
import { inspect } from "../src/coordinator/inspection.js";
import {
  implementationTargets,
  loadModelPolicy,
  type ModelPolicy,
  modelPolicyPath,
  resolveSelection,
} from "../src/coordinator/model-policy.js";
import { installNotepad } from "../src/coordinator/notepad.js";
import { type CandidateRequest, SessionRuntime } from "../src/coordinator/runtime.js";
import { RecordStore } from "../src/coordinator/store.js";
import {
  CandidateOf,
  Context,
  ExpectedEvidence,
  nonBlank,
  PageFields,
  Selection,
  TaskFields,
  Text,
} from "../src/coordinator/tool-schema.js";
import {
  attemptReceipt,
  controlReceipt,
  publicMessage,
  registerTask,
  result,
  retainedTip,
} from "../src/coordinator/tool-support.js";
import {
  type AttemptRecord,
  type AttemptSelection,
  CommitSchema,
  type Task,
  type TaskContract,
  TaskIdSchema,
} from "../src/domain/records.js";
import { resolveRevision } from "../src/repository/candidate.js";
import { resolveTaskTarget } from "../src/repository/git.js";

const COORDINATOR_SECTION = "workgraph_coordinator_contract";

export interface CoordinatorOptions {
  readonly agentDir?: string;
  readonly policyPath?: string;
  readonly settingsPath?: string;
  readonly herdr?: HerdrCliRuntime;
}

export default function coordinator(pi: ExtensionAPI, options: CoordinatorOptions = {}): void {
  if (!isCoordinatorScope(process.env)) return;

  const coordinatorContractUrl = new URL("../COORDINATOR.md", import.meta.url);

  const coordinatorContract = readFileSync(coordinatorContractUrl, "utf8")
    .replace(
      /\[([^\]\n]+)\]\((references\/[^)\s]+)\)/gu,
      (_link, label: string, target: string) =>
        `${label} at ${JSON.stringify(fileURLToPath(new URL(target, coordinatorContractUrl)))}`,
    )
    .trim();

  const agentDir = options.agentDir ?? getAgentDir();
  const policyPath = options.policyPath ?? modelPolicyPath(agentDir);
  let deliverySettingsWarning: string | undefined;
  let deferredDeliveryTools: readonly string[] = [];

  try {
    deferredDeliveryTools = loadDeferredDeliveryTools(
      options.settingsPath ?? deliverySettingsPath(agentDir),
    );
  } catch (cause) {
    deliverySettingsWarning = publicMessage(cause);
  }

  installDeliveryTools(pi, deferredDeliveryTools);
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

  pi.on("before_agent_start", (event) => {
    if (event.systemPromptOptions.forceSystemPrompt !== undefined) {
      if (!event.systemPromptOptions.forceSystemPrompt.includes(coordinatorContract))
        event.systemPromptOptions.forceSystemPrompt = `${event.systemPromptOptions.forceSystemPrompt}\n\n${coordinatorContract}`;

      return;
    }

    event.systemPromptOptions.sections[COORDINATOR_SECTION] = coordinatorContract;
  });
  pi.on("session_start", (_event, ctx) =>
    serialize(async () => {
      if (deliverySettingsWarning !== undefined)
        ctx.ui.notify(`Workgraph delivery tools unchanged: ${deliverySettingsWarning}`, "warning");
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
    description: "Allocate/reuse or finish this session's deterministic branch-backed checkout.",
    parameters: Type.Union([
      Type.Object(
        {
          cwd: Type.Optional(
            nonBlank("Repository checkout to allocate from; defaults to the session cwd."),
          ),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          cwd: Type.Optional(
            nonBlank(
              "Repository checkout that identifies the owned checkout; defaults to session cwd.",
            ),
          ),
          checkoutId: nonBlank("Exact deterministic Coordinator checkout ID."),
          expectedHead: CommitSchema,
        },
        { additionalProperties: false },
      ),
    ]),
    execute(_id, params, _signal, _update, ctx) {
      return serialize(async () => {
        const common = {
          agentDir: runtime().agentDir,
          sessionId: ctx.sessionManager.getSessionId(),
          cwd: ctx.cwd,
          ...(params.cwd === undefined ? {} : { path: params.cwd }),
        };

        return result(
          "checkoutId" in params
            ? await finishCheckout({
                ...common,
                checkoutId: params.checkoutId,
                expectedHead: params.expectedHead,
                store: runtime().store,
              })
            : await createCheckout(common),
        );
      });
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
        context: Context,
        expectedEvidence: ExpectedEvidence,
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
          ...(params.context === undefined ? {} : { context: params.context }),
          ...(params.expectedEvidence === undefined
            ? {}
            : { expectedEvidence: params.expectedEvidence }),
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
        context: Context,
        expectedEvidence: ExpectedEvidence,
        permittedEffects: Type.Array(
          nonBlank("Effect kind, scope, and lifetime authorized independently for each Attempt."),
          { minItems: 1 },
        ),
        stopCondition: nonBlank(
          "Hard cutoff for effects and authorized teardown; include bounded exhaustion when success-dependent. Workgraph does not enforce it.",
        ),
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
          ...(params.context === undefined ? {} : { context: params.context }),
          ...(params.expectedEvidence === undefined
            ? {}
            : { expectedEvidence: params.expectedEvidence }),
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
        context: Context,
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
          Type.Boolean({
            description: "Require the configured escalation executor; fail if unavailable.",
          }),
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
        request: nonBlank(
          "Material to assess; require an exact revision only when the request depends on one.",
        ),
        context: Context,
        selection: Selection,
      },
      { additionalProperties: false },
    ),
    async (params, ctx) =>
      createTask(runtime(), ctx, policyPath, {
        id: params.id,
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        targetKind: "directory",
        contract: {
          kind: "review",
          request: params.request,
          ...(params.context === undefined ? {} : { context: params.context }),
        },
        ...(params.selection === undefined ? {} : { selection: params.selection }),
      }),
    serialize,
  );

  pi.registerTool({
    name: "workgraph_attempt",
    label: "Workgraph Attempt",
    description:
      "Retry the unchanged Task with current model policy and a fresh applicable base; changed assignment or authority requires a new Task.",
    parameters: Type.Object(
      {
        taskId: TaskIdSchema,
        candidateOf: CandidateOf,
        baseRevision: Type.Optional(CommitSchema),
        useEscalationExecutor: Type.Optional(
          Type.Boolean({
            description: "Require the configured escalation executor; fail if unavailable.",
          }),
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
            description: "Read a complete report or an explicit bounded slice.",
          }),
          attemptId: nonBlank("Exact Attempt ID."),
          offset: Type.Optional(
            Type.Integer({ minimum: 0, description: "Zero-based character offset." }),
          ),
          maxChars: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 20_000,
              description: "Slice limit; defaults to 20,000 characters.",
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

            return result(
              controlReceipt(
                current,
                params.action,
                current.store.readAttempt(params.attemptId),
                "submitted",
              ),
            );
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

          return result(controlReceipt(current, params.action, attempt));
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

  return Effect.runPromise(resolveRevision(task.target, baseRevision ?? "HEAD"));
}
