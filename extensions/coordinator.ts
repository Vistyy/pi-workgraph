/* oxlint-disable effecttsgo/async-function, effecttsgo/process-env, anti-slop/no-object-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread -- Pi callbacks are Promise boundaries; registered TypeBox schemas validate values before these typed callbacks. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Effect, Exit, Match, Scope } from "effect";
import { type Static, type TSchema, Type } from "typebox";
import { installCalmMode, isCoordinatorScope } from "../src/calm/index.js";
import { createCheckout, deliverCheckout } from "../src/coordinator/checkouts.js";
import {
  deliverySettingsPath,
  installDeliveryTools,
  loadDeferredDeliveryTools,
} from "../src/coordinator/delivery-tools.js";
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
  AssignmentContextSchema,
  type AttemptRecord,
  type AttemptSelection,
  CommitSchema,
  ExpectedEvidenceSchema,
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

const Context = Type.Optional(AssignmentContextSchema);

const ExpectedEvidence = Type.Optional(ExpectedEvidenceSchema);

const TaskFields = {
  id: TaskIdSchema,
  cwd: Type.Optional(
    nonBlank(
      "Resolved starting directory for read-only roles, repository seed for Experiment, or destination identity for Implementation; defaults to session cwd and never widens role authority.",
    ),
  ),
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
    const contract = event.systemPrompt.includes(coordinatorContract)
      ? event.systemPrompt
      : `${event.systemPrompt}\n\n${coordinatorContract}`;

    const unfinished = attached?.store
      .listCheckouts()
      .filter(({ disposition }) => disposition.kind !== "complete")
      .map(({ checkoutId, disposition }) => `${checkoutId}: ${disposition.kind}`);

    return {
      systemPrompt:
        unfinished === undefined || unfinished.length === 0
          ? contract
          : `${contract}\n\nUnfinished session-owned Coordinator checkout lifecycle: ${unfinished.join(", ")}. Inspect it before deciding the next delivery action.`,
    };
  });
  pi.on("session_start", (_event, ctx) =>
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Session attachment and one authorized checkout reconciliation keep ordering visible.
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

        for (const checkout of store.listCheckouts()) {
          if (checkout.disposition.kind !== "local") continue;

          try {
            await deliverCheckout({
              request: { checkoutId: checkout.checkoutId },
              store,
              blockCleanup: () => checkoutCleanupBlocker(store, checkout.managedPath),
            });
          } catch (cause) {
            ctx.ui.notify(`Workgraph checkout unfinished: ${publicMessage(cause)}`, "warning");
          }
        }
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
            store: runtime().store,
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
          nonBlank(
            "Authorized effect kind, scope, and lifetime independently granted to each Attempt.",
          ),
          { minItems: 1 },
        ),
        stopCondition: nonBlank(
          "Hard cutoff by which effects and authorized teardown must be complete; a success-dependent cutoff must include bounded exhaustion, and Workgraph does not automatically enforce it.",
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
            description:
              "Require the configured escalation executor; Task creation fails if it is unavailable.",
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
          "Natural-language request for material the Review should assess; exact revisions are required only when the request depends on them.",
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
      "Create another execution of the same immutable Task under current model policy and a fresh applicable base. Create a new Task instead when the assignment or authority changes.",
    parameters: Type.Object(
      {
        taskId: TaskIdSchema,
        candidateOf: CandidateOf,
        baseRevision: Type.Optional(CommitSchema),
        useEscalationExecutor: Type.Optional(
          Type.Boolean({
            description:
              "Require the configured escalation executor; Attempt creation fails if it is unavailable.",
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
          section: Type.Literal("checkout", {
            description: "Read one exact Coordinator checkout lifecycle by ID.",
          }),
          id: nonBlank("Exact Coordinator checkout ID."),
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
    name: "workgraph_deliver",
    label: "Workgraph Deliver",
    description:
      "Record or resume the accepted Coordinator checkout disposition. Local delivery integrates only the exact accepted committed revision into the exact authorized attached destination and then verifies owned cleanup; preserve deliberately retains resources.",
    parameters: Type.Union([
      Type.Object(
        {
          checkoutId: nonBlank("Exact session-owned Coordinator checkout ID."),
          route: Type.Literal("local"),
          revision: CommitSchema,
          destination: Type.Optional(
            Type.Object(
              {
                cwd: nonBlank("Same-repository attached destination checkout."),
                ref: nonBlank("Exact attached destination ref."),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          checkoutId: nonBlank("Exact session-owned Coordinator checkout ID."),
          route: Type.Literal("preserve"),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        { checkoutId: nonBlank("Resume an already-recorded disposition without new authority.") },
        { additionalProperties: false },
      ),
    ]),
    execute(_id, params) {
      return serialize(async () => {
        const current = runtime();

        const checkout = await deliverCheckout({
          request: params,
          store: current.store,
          blockCleanup: () => {
            const record = current.store
              .listCheckouts()
              .find(({ checkoutId }) => checkoutId === params.checkoutId);

            return record === undefined
              ? "checkout record disappeared"
              : checkoutCleanupBlocker(current.store, record.managedPath);
          },
        });

        return result(checkout);
      });
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

  return Effect.runPromise(resolveRevision(task.target, baseRevision ?? "HEAD"));
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
  | { readonly section: "checkout"; readonly id: string }
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
        checkouts: runtime.store.listCheckouts(),
      };
    }

    case "task":
      return inspectTasks(runtime, input);
    case "attempt":
      return inspectAttempts(runtime, input);
    case "checkout": {
      const checkout = runtime.store
        .listCheckouts()
        .find(({ checkoutId }) => checkoutId === input.id);

      if (checkout === undefined) throw new Error("Coordinator checkout record is absent.");

      return checkout;
    }

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
              ...(outcome.result.report.role === "implementation" &&
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
    description: `Create one immutable ${label} Task with one or more selected initial Attempts.`,
    parameters,
    execute(_id, params, _signal, _update, ctx) {
      return serialize(() => run(params as Static<S>, ctx).then(result));
    },
  });
}

function attemptReceipt(record: AttemptRecord) {
  return { taskId: record.taskId, attemptId: record.id, spec: record.spec };
}

function checkoutCleanupBlocker(store: RecordStore, managedPath: string): string | undefined {
  const dependencies = store.checkoutDependencyCount(managedPath);

  return dependencies === 0
    ? undefined
    : `${dependencies} Worker or Candidate disposition(s) still target this checkout`;
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
