/* oxlint-disable effecttsgo/async-function, effecttsgo/process-env, anti-slop/no-object-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread -- Pi callbacks are Promise boundaries; registered TypeBox schemas validate values before these typed callbacks. */
import { readFileSync } from "node:fs";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Effect, Exit, Match, Scope } from "effect";
import type { Static, TSchema } from "typebox";
import { installCalmMode, isCoordinatorScope } from "../src/calm/index.js";
import {
  applyCheckout,
  createCheckout,
  discardCheckout,
  inspectCheckout,
  listCheckouts,
} from "../src/coordinator/checkouts.js";
import type { HerdrCliRuntime } from "../src/coordinator/herdr.js";
import {
  configuredTarget,
  implementationTargets,
  loadModelPolicy,
  type ModelPolicy,
  modelPolicyPath,
  resolveSelection,
} from "../src/coordinator/model-policy.js";
import { installNotepad } from "../src/coordinator/notepad.js";
import { type CandidateRequest, RuntimeError, SessionRuntime } from "../src/coordinator/runtime.js";
import { RecordStore } from "../src/coordinator/store.js";
import {
  AttemptParameters,
  CheckoutParameters,
  ConsultParameters,
  ControlParameters,
  ImplementParameters,
  InspectParameters,
  ModelsParameters,
  ResearchParameters,
  ReviewParameters,
} from "../src/coordinator/tool-parameters.js";
import type { AttemptRecord, AttemptSelection, Task, TaskContract } from "../src/domain/records.js";
import { resolveRevision, resolveTaskTarget } from "../src/repository.js";

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
    name: "workgraph_models",
    label: "Workgraph Models",
    description: "List exact configured Workgraph model targets for one selectable role.",
    parameters: ModelsParameters,
    async execute(_id, params) {
      const policy = await loadModelPolicy(policyPath);

      return result({
        path: policyPath,
        role: params.role,
        targets: policy.roles[params.role],
      });
    },
  });

  pi.registerTool({
    name: "workgraph_checkout",
    label: "Workgraph Checkout",
    description: "Manage this session's branch-backed Coordinator checkouts.",
    parameters: CheckoutParameters,
    execute(_id, params, _signal, _update, ctx) {
      return serialize(async () => result(await checkoutAction(runtime(), ctx, params)));
    },
  });

  registerTask(
    pi,
    "workgraph_research",
    "Research",
    ResearchParameters,
    async (params, ctx) => {
      const contract: TaskContract =
        params.experiment === undefined
          ? {
              kind: "research",
              question: params.question,
              expectedEvidence: params.expectedEvidence,
            }
          : {
              kind: "experiment",
              question: params.question,
              expectedEvidence: params.expectedEvidence,
              permittedEffects: params.experiment.permittedEffects,
              stopCondition: params.experiment.stopCondition,
            };

      return createTask(runtime(), ctx, policyPath, {
        id: params.id,
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        targetKind: params.experiment === undefined ? "directory" : "repository",
        contract,
        ...(params.selection === undefined ? {} : { selection: params.selection }),
      });
    },
    serialize,
  );

  registerTask(
    pi,
    "workgraph_consult",
    "Consult",
    ConsultParameters,
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
          target: configuredTarget(policy, "consultation.advisor", params.advisor),
        },
      });
    },
    serialize,
  );

  registerTask(
    pi,
    "workgraph_implement",
    "Implement",
    ImplementParameters,
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
    ReviewParameters,
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
    description: "Create one fresh Attempt inheriting its immutable Task target.",
    parameters: AttemptParameters,
    execute(_id, params) {
      return serialize(async () =>
        result(attemptReceipt(await createAttempt(runtime(), policyPath, params))),
      );
    },
  });

  pi.registerTool({
    name: "workgraph_inspect",
    label: "Workgraph Inspect",
    description: "Inspect bounded records for this Pi session.",
    parameters: InspectParameters,
    execute(_id, params) {
      return serialize(async () => result(inspect(runtime(), params)));
    },
  });

  pi.registerTool({
    name: "workgraph_control",
    label: "Workgraph Control",
    description: "Cancel, steer, apply, or explicitly discard output for one exact Attempt.",
    parameters: ControlParameters,
    execute(_id, params) {
      return serialize(async () => {
        const current = runtime();

        if (params.action === "steer") {
          await Effect.runPromise(current.steer(params.attemptId, params.instruction));

          return result({ attemptId: params.attemptId, steered: true });
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

        return result(attemptReceipt(attempt));
      });
    },
  });
}

async function checkoutAction(
  runtime: SessionRuntime,
  ctx: ExtensionContext,
  input: Static<typeof CheckoutParameters>,
): Promise<object> {
  switch (input.action) {
    case "create":
      return Effect.runPromise(
        createCheckout({ store: runtime.store, agentDir: runtime.agentDir }, ctx.cwd, input.cwd),
      );
    case "inspect":
      return Effect.runPromise(inspectCheckout(runtime.store, input.checkoutId));
    case "list": {
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 20;

      return {
        offset,
        limit,
        checkouts: await Effect.runPromise(listCheckouts(runtime.store, offset, limit)),
      };
    }

    case "apply":
      return Effect.runPromise(applyCheckout(runtime.store, input.checkoutId));
    case "discard":
      return Effect.runPromise(discardCheckout(runtime.store, input.checkoutId, input.reason));
  }
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

  return { taskId: input.id, attempts: attempts.map(attemptReceipt) };
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

  return {
    kind: "target",
    target: configuredTarget(
      policy,
      Match.value(contract.kind).pipe(
        Match.when("review", () => "review" as const),
        Match.when("consultation", () => "consultation.advisor" as const),
        Match.orElse(() => "research" as const),
      ),
    ),
  };
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

function inspect(runtime: SessionRuntime, params: Static<typeof InspectParameters>) {
  // SAFETY: Collapse the schema's same-section variants into optional fields for dispatch.
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
  if (input.id !== undefined) return inspectedAttempt(runtime.store.readAttempt(input.id));
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

function inspectedAttempt(attempt: AttemptRecord) {
  const outcome = attempt.outcome;

  return {
    attemptId: attempt.id,
    taskId: attempt.taskId,
    spec: attempt.spec,
    ...(attempt.worker === undefined ? {} : { worker: attempt.worker }),
    ...(attempt.output === undefined ? {} : { output: attempt.output }),
    ...(outcome === undefined
      ? {}
      : {
          outcome: {
            kind: outcome.result.kind,
            summary:
              outcome.result.kind === "reported"
                ? outcome.result.report.summary
                : outcome.result.reason,
            effectiveModels: outcome.effectiveModels,
          },
        }),
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
    description: `Create one immutable ${label} Task and its initial Attempt.`,
    parameters,
    execute(_id, params, _signal, _update, ctx) {
      return serialize(() => run(params as Static<S>, ctx).then(result));
    },
  });
}

function attemptReceipt(record: AttemptRecord) {
  return { taskId: record.taskId, attemptId: record.id };
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
