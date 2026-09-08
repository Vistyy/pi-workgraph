import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, type FileSystem, type Path, Semaphore } from "effect";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  actionView,
  type InspectView,
  inspectView,
  resultNotification,
} from "../src/agent-facing.js";
import { installCalmMode, isCoordinatorScope, updateCalmWorkers } from "../src/calm.js";
import {
  HumanInputReceiptSchema,
  installCoordinatorSessionState,
} from "../src/coordinator-notepad.js";
import { GitRepository, inspectRepository } from "../src/git.js";
import { HerdrCliRuntime } from "../src/herdr.js";
import {
  ImplementationModelOverridesSchema as ImplementationModels,
  type ListModelRole,
  loadModelPolicyEffect,
  MODEL_ROLES,
  type ModelPolicy,
  modelPolicyPath,
  ModelChoiceSchema as PolicyChoice,
  SelectionRequestSchema as Selection,
  setModelListEffect,
  setModelRoleEffect,
  ModelTargetSchema as Target,
} from "../src/model-policy.js";
import { liveLayer } from "../src/node-platform.js";
import { forkConversationSessionEffect } from "../src/pi-process.js";
import { EvidenceSchema } from "../src/report-schema.js";
import {
  type SessionIdentity,
  type WorkstreamState,
  WorkstreamStoreEffects,
} from "../src/workstream.js";
import {
  type QueueOptions,
  type RuntimeError,
  WorkstreamRuntime,
} from "../src/workstream-runtime.js";
import { RuntimeHostError, type RuntimeWorkerPort } from "../src/workstream-runtime-services.js";
import { isLegacyWorkstreamPath } from "../src/workstream-state.js";

const POINTER = "pi-workgraph-workstream";
const INPUT = "pi-workgraph-human-input";

const WorkstreamPointer = Type.Object({ path: Type.String({ minLength: 1 }) });
const InputReceipt = HumanInputReceiptSchema;
const NonemptyString = Type.String({ minLength: 1 });
const ControlSchema = Type.Union([
  Type.Object(
    { action: StringEnum(["suspend", "resume"] as const), reason: NonemptyString },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: StringEnum(["cancel"] as const), attempt: NonemptyString },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: StringEnum(["steer"] as const),
      attempt: NonemptyString,
      instruction: NonemptyString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: StringEnum(["apply"] as const), attempt: NonemptyString },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: StringEnum(["release_output"] as const),
      attempt: NonemptyString,
      reason: NonemptyString,
    },
    { additionalProperties: false },
  ),
]);
const CompleteSchema = Type.Object(
  {
    conclusion: NonemptyString,
    evidence: Type.Array(EvidenceSchema, { minItems: 1 }),
    limitations: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { default: [] })),
  },
  { additionalProperties: false },
);
const TargetRepository = Type.String({
  minLength: 1,
  description:
    "Repository fixed by initial intent creation. Defaults to coordinator cwd when creating; later intent revisions cannot switch repositories.",
});
type HostServices = FileSystem.FileSystem | Path.Path;
type CoordinatorEffect<T, E = RuntimeError, R = HostServices> = Effect.Effect<T, E, R>;

const QueueOptionFields = {
  continuationOf: Type.Optional(
    Type.String({
      description:
        "Exact prior attempt ID in this workstream whose retained session supplies continuation context. Requires a settled worker with completed cleanup and a retained session; with multiple attempts, only the first continues it.",
    }),
  ),
  candidateOf: Type.Optional(
    Type.String({
      description:
        "Retained candidate attempt to correct, or explicitly integrate onto the supplied current destination base.",
    }),
  ),
  baseRevision: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40,64}$" })),
};
const ModelOptions = {
  ...QueueOptionFields,
  selection: Type.Optional(Selection),
};
const ImplementationModelOptions = {
  ...QueueOptionFields,
  models: Type.Optional(ImplementationModels),
};

export default function workgraphCoordinator(
  pi: ExtensionAPI,
  runtimeWorker: () => RuntimeWorkerPort = () => new HerdrCliRuntime(),
): void {
  if (!isCoordinatorScope(process.env)) return;
  const calm = installCalmMode(pi);
  let runtime: WorkstreamRuntime | undefined;
  let pending: Static<typeof InputReceipt>[] = [];
  const hostSemaphore = Semaphore.makeUnsafe(1);
  const attachmentSemaphore = Semaphore.makeUnsafe(1);
  const sdk = <T>(operation: string, run: () => T): Effect.Effect<T, RuntimeHostError> =>
    Effect.try({
      try: run,
      catch: (cause) => new RuntimeHostError({ operation, cause }),
    });
  const runCallback = <T, E>(
    operation: CoordinatorEffect<T, E>,
    signal?: AbortSignal,
  ): Promise<T> => Effect.runPromise(operation.pipe(Effect.provide(liveLayer)), { signal });
  const owner = (ctx: ExtensionContext): SessionIdentity => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile === undefined || sessionFile === "")
      throw new Error("Workgraph requires a persistent Pi session.");
    return { sessionId: ctx.sessionManager.getSessionId(), sessionFile };
  };
  const current = (): WorkstreamRuntime => {
    if (!runtime)
      throw new Error(
        "No attached workstream. Delegate work or attach a retained workstream first.",
      );
    return runtime;
  };
  const remember = (
    state: WorkstreamState,
    ctx: ExtensionContext,
  ): Effect.Effect<WorkstreamState, RuntimeHostError> =>
    sdk("publish coordinator state", () => {
      const active = state.attempts.filter((item) =>
        ["running", "starting"].includes(item.state),
      ).length;
      ctx.ui.setStatus("workgraph", `WG ${state.lifecycle.state} - ${active} active`);
      updateCalmWorkers(calm, state);
      return state;
    });
  const attachOwned = (
    ctx: ExtensionContext,
    target: WorkstreamStoreEffects,
    priorOwnerLiveness: "alive" | "dead" | "unknown" = "unknown",
  ): CoordinatorEffect<WorkstreamRuntime> =>
    Effect.suspend(() => {
      const attached = runtime;
      if (attached?.store.path === target.path)
        return attached.effects.submit(Effect.void).pipe(Effect.as(attached));
      return Effect.gen(function* () {
        const previous = runtime;
        const state = yield* target.load();
        const { HERDR_WORKSPACE_ID: workspaceId } = process.env;
        let next: WorkstreamRuntime;
        next = yield* WorkstreamRuntime.acquire(
          target,
          new GitRepository(state.projectRoot, state.gitCommonDir),
          runtimeWorker(),
          { workspaceId: workspaceId ?? "" },
          (resultId, latest) =>
            sdk("deliver workstream result", () => {
              if (ctx.sessionManager.getSessionId() !== latest.coordinator.sessionId)
                throw new Error("Coordinator session changed before result delivery.");
              pi.sendMessage(
                {
                  customType: POINTER,
                  content: resultNotification(latest, resultId),
                  display: true,
                  details: { resultId, statePath: latest.statePath },
                },
                { triggerTurn: true, deliverAs: "followUp" },
              );
            }),
          (error) =>
            sdk("report workstream error", () => {
              ctx.ui.notify(`Workgraph: ${error.message}`, "warning");
              pi.sendMessage(
                {
                  customType: "pi-workgraph-attention",
                  content: `Workgraph requires reconciliation: ${error.message}. Use workgraph_inspect for retained evidence; this notification does not authorize new scope.`,
                  display: true,
                },
                { triggerTurn: true, deliverAs: "followUp" },
              );
            }),
          {
            owner: owner(ctx),
            priorOwnerLiveness,
            onState: (latest) =>
              sdk("publish workstream state", () => updateCalmWorkers(calm, latest)),
            onStopped: () =>
              hostSemaphore.withPermit(
                sdk("clear stopped runtime pointer", () => {
                  if (runtime === next) runtime = undefined;
                }),
              ),
          },
        );
        if (previous !== undefined)
          yield* previous.effects.close.pipe(
            Effect.onError(() => next.effects.close.pipe(Effect.ignore)),
          );
        runtime = next;
        return next;
      });
    });
  const attachEffect = (
    ctx: ExtensionContext,
    target: WorkstreamStoreEffects,
    priorOwnerLiveness: "alive" | "dead" | "unknown" = "unknown",
  ): CoordinatorEffect<WorkstreamRuntime> =>
    attachmentSemaphore.withPermit(attachOwned(ctx, target, priorOwnerLiveness));
  const importInputsEffect = (active: WorkstreamRuntime): CoordinatorEffect<void> =>
    hostSemaphore.withPermit(Effect.sync(() => [...pending])).pipe(
      Effect.flatMap((receipts) =>
        active.effects.submit(
          Effect.forEach(receipts, (receipt) => active.store.recordInputEvent(receipt), {
            discard: true,
          }),
        ),
      ),
    );
  installCoordinatorSessionState(pi, {
    owner,
    serialize: (run) =>
      Effect.runPromise(
        hostSemaphore.withPermit(
          Effect.tryPromise({
            try: run,
            catch: (cause) =>
              new RuntimeHostError({ operation: "update coordinator notepad", cause }),
          }),
        ),
      ),
    onHumanInput: (receipt) => {
      pending.push(receipt);
      const active = runtime;
      if (active === undefined) return Promise.resolve();
      return runCallback(
        active.effects
          .submit(active.store.load())
          .pipe(
            Effect.flatMap((state) =>
              state.lifecycle.state !== "active" && state.lifecycle.state !== "suspended"
                ? Effect.void
                : active.effects.submit(active.store.recordInputEvent(receipt).pipe(Effect.asVoid)),
            ),
          ),
      );
    },
  });
  const validateTargetEffect = (
    state: WorkstreamState,
    targetRepository?: string,
  ): CoordinatorEffect<void> =>
    targetRepository === undefined
      ? Effect.void
      : inspectRepository(targetRepository).pipe(
          Effect.flatMap((requested) =>
            requested.commonDir === state.gitCommonDir && requested.root === state.projectRoot
              ? Effect.void
              : Effect.fail(
                  new RuntimeHostError({
                    operation: "validate target repository",
                    cause: new Error(
                      `Target repository ${requested.root} does not match the fixed workstream repository ${state.projectRoot}.`,
                    ),
                  }),
                ),
          ),
        );
  const reuseOrStopEffect = (
    targetRepository?: string,
  ): CoordinatorEffect<WorkstreamRuntime | undefined> =>
    Effect.gen(function* () {
      if (runtime === undefined) return undefined;
      const attached = runtime;
      const state = yield* attached.effects.submit(attached.store.load());
      if (state.lifecycle.state === "suspended")
        throw new Error("Workstream is suspended; resume explicitly before delegating.");
      if (state.lifecycle.state !== "active") {
        yield* attached.effects.close;
        if (runtime === attached) runtime = undefined;
        return undefined;
      }
      yield* validateTargetEffect(state, targetRepository);
      return attached;
    });
  const ensureEffect = (
    ctx: ExtensionContext,
    purpose: string,
    targetRepository?: string,
  ): CoordinatorEffect<WorkstreamRuntime> =>
    attachmentSemaphore.withPermit(
      Effect.gen(function* () {
        const existing = yield* reuseOrStopEffect(targetRepository);
        if (existing !== undefined) return existing;
        const repository = yield* inspectRepository(targetRepository ?? ctx.cwd);
        const created = yield* WorkstreamStoreEffects.create({
          id: `ws-${randomUUID()}`,
          purpose,
          projectRoot: repository.root,
          gitCommonDir: repository.commonDir,
          coordinator: owner(ctx),
        });
        const active = yield* attachOwned(ctx, created.store);
        yield* importInputsEffect(active);
        yield* sdk("retain workstream pointer", () =>
          pi.appendEntry(POINTER, { path: created.store.path }),
        );
        return active;
      }),
    );
  const establishedScopeEffect = (
    active: WorkstreamRuntime,
  ): CoordinatorEffect<{ state: WorkstreamState; authorization: AuthorizationSelection }> =>
    active.effects.submit(
      Effect.gen(function* () {
        const state = yield* active.store.load();
        const intent = requiredValue(state.intents.at(-1), "workstream intent");
        if (intent.version === 0)
          throw new Error(
            "Current scope is not established. Record it explicitly with workgraph_intent before delegation.",
          );
        const selected = selectWorkstreamAuthority(state);
        const authorization: AuthorizationSelection = {
          authority: { receiptId: selected.receiptId, intentVersion: intent.version },
        };
        if (selected.latestObservedInput !== undefined)
          authorization.latestObservedInput = selected.latestObservedInput;
        return { state, authorization };
      }),
    );
  const activeEstablishedScopeEffect = (): CoordinatorEffect<{
    active: WorkstreamRuntime;
    state: WorkstreamState;
    authorization: AuthorizationSelection;
  }> =>
    Effect.gen(function* () {
      const active = current();
      const { state, authorization } = yield* establishedScopeEffect(active);
      if (state.lifecycle.state === "suspended")
        throw new Error("Workstream is suspended; resume explicitly before delegating.");
      if (state.lifecycle.state !== "active")
        throw new Error(`Cannot delegate while workstream is ${state.lifecycle.state}.`);
      return { active, state, authorization };
    });

  const reattach = (
    ctx: ExtensionContext,
    identity: SessionIdentity,
    path: string,
  ): CoordinatorEffect<void> =>
    Effect.gen(function* () {
      const inspection = yield* WorkstreamStoreEffects.inspectForReattachment(path);
      if (inspection.kind === "retained_terminal") {
        yield* sdk("report retained terminal workstream", () =>
          ctx.ui.notify(
            `Workstream reattachment skipped: ${inspection.lifecycle.state} older history ${inspection.id} was preserved and not attached.`,
            "info",
          ),
        );
        return;
      }
      if (inspection.kind === "legacy_current") {
        yield* sdk("report legacy workstream migration requirement", () =>
          ctx.ui.notify(
            `Workstream reattachment skipped: active JSON state at ${path} is retained read-only; use workgraph_adopt after the prior owner is proven dead to perform the bounded SQLite import.`,
            "warning",
          ),
        );
        return;
      }
      if (
        inspection.state.lifecycle.state === "completed" ||
        inspection.state.lifecycle.state === "archived" ||
        inspection.state.lifecycle.state === "abandoned"
      )
        return;
      const active = yield* attachEffect(ctx, WorkstreamStoreEffects.open(path, identity));
      yield* importInputsEffect(active);
      const state = yield* active.effects.submit(active.store.load());
      yield* remember(state, ctx);
    }).pipe(
      Effect.catch((error) =>
        sdk("report reattachment failure", () =>
          ctx.ui.notify(
            `Workstream reattachment skipped for ${path}: ${failureMessage(error)}. Inspect the retained pointer and state, then reconcile explicitly.`,
            "warning",
          ),
        ),
      ),
    );

  pi.on("session_start", (_event, ctx) =>
    runCallback(
      Effect.gen(function* () {
        const active = runtime;
        if (active !== undefined) yield* active.effects.close;
        runtime = undefined;
        const identity = owner(ctx);
        const entries = ctx.sessionManager.getBranch();
        pending = entries.flatMap((entry) =>
          entry.type === "custom" &&
          entry.customType === INPUT &&
          Value.Check(InputReceipt, entry.data) &&
          entry.data.sessionId === identity.sessionId &&
          entry.data.sessionFile === identity.sessionFile
            ? [entry.data]
            : [],
        );
        const pointer = [...entries]
          .reverse()
          .find((entry) => entry.type === "custom" && entry.customType === POINTER);
        const data = pointer?.type === "custom" ? pointer.data : undefined;
        if (!Value.Check(WorkstreamPointer, data)) {
          if (pointer !== undefined)
            yield* sdk("report malformed workstream pointer", () =>
              ctx.ui.notify(
                "Workstream reattachment skipped: the retained pointer is malformed; inspect its session entry and repair it explicitly.",
                "warning",
              ),
            );
          return;
        }
        yield* reattach(ctx, identity, data.path);
      }),
    ),
  );
  pi.on("session_shutdown", () => {
    const active = runtime;
    return runCallback(active === undefined ? Effect.void : active.effects.close);
  });
  pi.on("before_agent_start", () => ({
    message: {
      customType: "pi-workgraph-policy",
      content:
        "[WORKGRAPH]\nAfter queuing work, do immediately useful independent work if any; otherwise end the turn so retained-result notifications can resume coordination. Do not poll status or run waits for workers. Finish the requested work through verification and correction within scope.",
      display: false,
    },
  }));

  pi.registerTool({
    name: "workgraph_models",
    label: "Workgraph Models",
    description:
      "Get model defaults and their configuration path, or persist an implementation default, singleton consultation enricher, or ordered research/review/consultation advisor list backed by a retained interactive or RPC input receipt. Assignment selection or per-role models overrides use policy defaults without changing policy or the coordinator model.",
    promptSnippet: "Inspect or configure Workgraph model defaults",
    parameters: Type.Object({
      action: StringEnum(["get", "set", "set_list", "rates"] as const),
      authorityReceiptId: Type.Optional(
        Type.String({
          description:
            "Retained interactive/RPC input receipt authorizing set or set_list. Omit to use the latest retained genuine input.",
        }),
      ),
      role: Type.Optional(StringEnum(MODEL_ROLES)),
      target: Type.Optional(Target),
      list: Type.Optional(Type.Array(PolicyChoice, { minItems: 1 })),
      models: Type.Optional(Type.Array(Type.String())),
    }),
    execute(_id, params, signal, _update, ctx) {
      return runCallback(
        Effect.gen(function* () {
          validateModelRequest(params.action, params.role, params.target, params.list);
          if (params.action === "rates") {
            const policy = yield* loadModelPolicyEffect();
            const models = params.models ?? policyModelIds(policy);
            const rates = modelRates(models, ctx);
            return {
              content: [{ type: "text", text: formatRates(rates) }],
              details: { rates },
            };
          }
          const authority = isPersistentModelMutation(params.action)
            ? selectSessionAuthority(pending, params.authorityReceiptId)
            : undefined;
          const policy = yield* resolveModelPolicyEffect(
            params.action,
            params.role,
            params.target,
            params.list,
          );
          return {
            content: [
              {
                type: "text",
                text:
                  authority === undefined
                    ? formatPolicy(policy)
                    : `${formatPolicy(policy)}\nAuthority receipt: ${authority.receiptId} (${authority.source}).`,
              },
            ],
            details: { path: modelPolicyPath(), policy, rates: [], authority },
          };
        }),
        signal,
      );
    },
  });

  pi.registerTool({
    name: "workgraph_research",
    label: "Workgraph Research",
    description:
      "Delegate a specific evidence question under the established current intent, not responsibility for choosing the design. Identify the relevant scope and required observations. Disposable experiments also require explicitly authorized effects and a stopping condition.",
    promptSnippet: "Delegate research or a bounded experiment",
    parameters: Type.Object(
      {
        id: Type.String(),
        question: Type.String(),
        expectedEvidence: Type.Array(Type.String(), { minItems: 1 }),
        ...ModelOptions,
        experiment: Type.Optional(
          Type.Object(
            {
              permittedEffects: Type.Array(Type.String(), { minItems: 1 }),
              stopCondition: Type.String(),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    execute(_id, params, signal, _update, ctx) {
      return runCallback(
        Effect.gen(function* () {
          const {
            active,
            state: stateBefore,
            authorization,
          } = yield* activeEstablishedScopeEffect();
          const intent = requiredValue(stateBefore.intents.at(-1), "established workstream intent");
          const authority = params.experiment === undefined ? undefined : authorization;
          const assignment = researchAssignment(params, intent.version, authority?.authority);
          const state = yield* active.effects.queue(assignment, queueOptions(params));
          const projection: Parameters<typeof actionView>[1] = {
            action: "workgraph_research",
            assignmentId: params.id,
            outcome: "queued",
          };
          if (authority !== undefined)
            projection.authorityContext = projectAuthorityContext(authority);
          return mutationResult(
            `Queued ${params.id}; submission and execution are observed asynchronously.`,
            yield* remember(state, ctx),
            projection,
          );
        }),
        signal,
      );
    },
  });
  pi.registerTool({
    name: "workgraph_consult",
    label: "Workgraph Consult",
    description:
      "Queue one evidence-only consultation under the established current intent. A fresh read-only enricher produces a strict frozen packet before a fresh advisor phase. The advisor returns evidence, not authority or acceptance.",
    promptSnippet: "Consult an ordered evidence advisor",
    parameters: Type.Object(
      {
        id: Type.String({ minLength: 1 }),
        question: Type.String({ minLength: 1, maxLength: 20_000 }),
        context: Type.Optional(Type.String({ maxLength: 20_000 })),
        enrichmentFocus: Type.Optional(Type.String({ maxLength: 4_000 })),
        advisor: Type.Optional(Target),
      },
      { additionalProperties: false },
    ),
    execute(_id, params, signal, _update, ctx) {
      return runCallback(
        Effect.gen(function* () {
          const { active, state: before } = yield* activeEstablishedScopeEffect();
          const intent = requiredValue(before.intents.at(-1), "established workstream intent");
          const assignment: Parameters<WorkstreamStoreEffects["enqueue"]>[0] = {
            id: params.id,
            capability: "consultation",
            artifactIntent: "evidence_only",
            objective: params.question,
            question: params.question,
            intentVersion: intent.version,
          };
          if (params.context !== undefined) assignment.context = params.context;
          if (params.enrichmentFocus !== undefined)
            assignment.enrichmentFocus = params.enrichmentFocus;
          if (params.advisor !== undefined) assignment.advisorOverride = params.advisor;
          const state = yield* active.effects.queue(assignment);
          return mutationResult(
            `Queued consultation ${params.id}; enrichment and advice are observed asynchronously.`,
            yield* remember(state, ctx),
            { action: "workgraph_consult", assignmentId: params.id, outcome: "queued" },
          );
        }),
        signal,
      );
    },
  });
  pi.registerTool({
    name: "workgraph_intent",
    label: "Workgraph Intent",
    description:
      "Explicitly establish or revise the coordinator's semantic scope against a retained human input receipt. This is required before delegation; receiving or selecting a receipt alone does not change scope, and earlier results remain tied to their old intent.",
    parameters: Type.Object(
      {
        statement: Type.String({ minLength: 1 }),
        constraints: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { default: [] })),
        targetRepository: Type.Optional(TargetRepository),
        authorityReceiptId: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Retained human input grounding this scope. Omit to use the latest genuinely retained input.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute(_id, params, signal, _update, ctx) {
      return runCallback(
        Effect.gen(function* () {
          const attached = runtime;
          const attachedState =
            attached === undefined
              ? undefined
              : yield* attached.effects.submit(attached.store.load());
          const canRevise =
            attachedState?.lifecycle.state === "active" ||
            attachedState?.lifecycle.state === "suspended";
          let active: WorkstreamRuntime;
          let receiptId: string;
          if (canRevise && attached !== undefined && attachedState !== undefined) {
            yield* validateTargetEffect(attachedState, params.targetRepository);
            active = attached;
            receiptId = selectIntentAuthority(attachedState, params.authorityReceiptId).receiptId;
          } else {
            receiptId = selectSessionAuthority(pending, params.authorityReceiptId).receiptId;
            active = yield* ensureEffect(ctx, params.statement, params.targetRepository);
          }
          const state = yield* active.effects.submit(
            active.store.reviseIntent({
              authorityReceiptId: receiptId,
              statement: params.statement,
              constraints: params.constraints ?? [],
            }),
          );
          return mutationResult("Recorded intent revision.", yield* remember(state, ctx), {
            action: "workgraph_intent",
            outcome: "recorded",
          });
        }),
        signal,
      );
    },
  });
  pi.registerTool({
    name: "workgraph_implement",
    label: "Workgraph Implement",
    description:
      "Delegate implementation of a bounded, decided change under the established human-backed intent. Include context, intended relationships, constraints, and worker discretion sufficient to execute without inventing the design. Resolve consequential uncertainties before requesting implementation. The default keeps current scope even when newer input is retained; changed scope must first be recorded with workgraph_intent.",
    promptSnippet: "Delegate an authorized maintained change",
    parameters: Type.Object(
      {
        id: Type.String(),
        objective: Type.String(),
        acceptance: Type.Array(Type.String(), { minItems: 1 }),
        ...ImplementationModelOptions,
      },
      { additionalProperties: false },
    ),
    execute(_id, params, signal, _update, ctx) {
      return runCallback(
        Effect.gen(function* () {
          const { active, authorization } = yield* activeEstablishedScopeEffect();
          const state = yield* active.effects.queue(
            {
              id: params.id,
              capability: "implement",
              artifactIntent: "maintained_change",
              objective: params.objective,
              intentVersion: authorization.authority.intentVersion,
              authority: authorization.authority,
              acceptance: params.acceptance,
            },
            implementationQueueOptions(params),
          );
          return mutationResult(
            `Queued maintained change ${params.id}.`,
            yield* remember(state, ctx),
            {
              action: "workgraph_implement",
              assignmentId: params.id,
              outcome: "queued",
              authorityContext: projectAuthorityContext(authorization),
            },
          );
        }),
        signal,
      );
    },
  });
  pi.registerTool({
    name: "workgraph_review",
    label: "Workgraph Review",
    description:
      "Delegate read-only independent review under the established current intent of a retained result, artifact, exact revision, or comparison of retained results for a specific concern. State the expected behavior or constraint to check; request discrepancies and supporting evidence, not an acceptance decision. Exact-revision evidence must come from that revision, not live working files.",
    promptSnippet: "Delegate selective review",
    parameters: Type.Object(
      {
        id: Type.String(),
        objective: Type.String(),
        concern: Type.String(),
        subject: Type.Union([
          Type.Object(
            { kind: Type.Literal("result"), resultId: Type.String() },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              kind: Type.Literal("artifact"),
              resultId: Type.String(),
              artifactId: Type.String(),
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              kind: Type.Literal("revision"),
              revision: Type.String({
                description: "Exact existing commit in the workstream's fixed repository.",
              }),
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              kind: Type.Literal("comparison"),
              resultIds: Type.Array(Type.String(), { minItems: 2 }),
            },
            { additionalProperties: false },
          ),
        ]),
        ...ModelOptions,
      },
      { additionalProperties: false },
    ),
    execute(_id, params, signal, _update, ctx) {
      return runCallback(
        Effect.gen(function* () {
          const { active, state: before } = yield* activeEstablishedScopeEffect();
          const intent = requiredValue(before.intents.at(-1), "established workstream intent");
          const state = yield* active.effects.queue(
            {
              id: params.id,
              capability: "review",
              artifactIntent: "evidence_only",
              objective: params.objective,
              intentVersion: intent.version,
              subject: params.subject,
              concern: params.concern,
            },
            queueOptions(params),
          );
          return mutationResult(`Queued review ${params.id}.`, yield* remember(state, ctx), {
            action: "workgraph_review",
            assignmentId: params.id,
            outcome: "queued",
          });
        }),
        signal,
      );
    },
  });
  pi.registerTool({
    name: "workgraph_inspect",
    label: "Workgraph Inspect",
    description:
      "Inspect one unified bounded view of workstream overview, retained human context, a semantic task or complete assignment, its outcome/evidence, completion, or exact recovery. Notifications already include a bounded actionable outcome; inspect only for uncertainty, blockers, repeated attempts, or truncated content. Detail reads are character-bounded and lossless through the returned next handle, including exact inputs, intents, assignments, completion, and untyped or malformed reports.",
    promptSnippet:
      "Inspect Workgraph overview, retained context, complete assignments, outcomes, completion, or recovery",
    parameters: Type.Object({
      section: StringEnum([
        "overview",
        "context",
        "completion",
        "task",
        "assignment",
        "outcome",
        "evidence",
        "recovery",
        "report",
      ] as const),
      task: Type.Optional(Type.String()),
      attempt: Type.Optional(Type.String()),
      result: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 8_000 })),
      itemOffset: Type.Optional(Type.Integer({ minimum: 0 })),
      maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    execute(_id, params, signal) {
      return runCallback(
        Effect.gen(function* () {
          const active = current();
          const state = yield* active.effects.submit(active.store.load());
          const view = inspectView(state, { ...params, section: params.section });
          return {
            content: [{ type: "text" as const, text: formatInspection(view) }],
            details: { inspection: view, statePath: state.statePath },
          };
        }),
        signal,
      );
    },
  });
  pi.registerTool({
    name: "workgraph_control",
    label: "Workgraph Control",
    description:
      "Suspend or resume coordination, cancel or steer one exact worker attempt, apply one exact retained maintained output, or release one exact retained output. Settlement never applies output; cancellation preserves output. Application observes destination state and derives the retained source under current intent. Inspect resulting effects before retrying uncertain application or release.",
    parameters: ControlSchema,
    execute(_id, params, signal, _update, ctx) {
      return runCallback(
        Effect.gen(function* () {
          const active = current();
          const affectedAttemptId = isAttemptControl(params)
            ? yield* controlAttemptEffect(active, params)
            : yield* lifecycleControlEffect(active, params);
          const message = controlMessage(params.action);
          const state = yield* active.effects.submit(active.store.load());
          const projection: Parameters<typeof actionView>[1] = {
            action: `workgraph_control:${params.action}`,
            message,
            outcome: controlOutcome(params.action),
          };
          if (affectedAttemptId !== undefined) projection.attemptId = affectedAttemptId;
          return mutationResult(message, yield* remember(state, ctx), projection);
        }),
        signal,
      );
    },
  });
  pi.registerTool({
    name: "workgraph_adopt",
    label: "Workgraph Adopt",
    description:
      "Attach a retained workstream only after expired prior ownership is authoritatively dead. Preserve suspension and original human receipts.",
    parameters: Type.Object({ statePath: Type.String() }),
    execute(_id, params, signal, _update, ctx) {
      return runCallback(
        Effect.gen(function* () {
          let state = yield* WorkstreamStoreEffects.inspect(params.statePath);
          const repository = yield* inspectRepository(state.projectRoot);
          if (repository.commonDir !== state.gitCommonDir)
            throw new Error("The retained workstream belongs to another repository.");
          const herdr = new HerdrCliRuntime();
          const liveness = yield* herdr.coordinatorLiveness(state.coordinator.sessionFile);
          let targetPath = params.statePath;
          if (isLegacyWorkstreamPath(state.statePath)) {
            const migrated = yield* WorkstreamStoreEffects.migrateLegacy(
              params.statePath,
              liveness,
            );
            state = migrated.state;
            targetPath = migrated.path;
          }
          const target = WorkstreamStoreEffects.open(targetPath, state.coordinator);
          const active = yield* attachEffect(ctx, target, liveness);
          yield* sdk("retain adopted workstream pointer", () =>
            pi.appendEntry(POINTER, { path: target.path }),
          );
          yield* importInputsEffect(active);
          const adopted = yield* active.effects.submit(active.store.load());
          return mutationResult(
            "Adopted without changing lifecycle.",
            yield* remember(adopted, ctx),
            {
              action: "workgraph_adopt",
              outcome: "adopted",
            },
          );
        }),
        signal,
      );
    },
  });
  pi.registerTool({
    name: "workgraph_fork",
    label: "Workgraph Fork",
    description:
      "Explicitly fork the coordinator conversation into a new no-focus Herdr workspace; workers remain tabs in that coordinator workspace, not a worker continuation or workstream adoption.",
    parameters: Type.Object({ targetCwd: Type.String() }),
    execute(_id, params, signal, _update, ctx) {
      return runCallback(
        Effect.gen(function* () {
          const sessionFile = yield* forkConversationSessionEffect({
            parentSessionFile: owner(ctx).sessionFile,
            targetCwd: params.targetCwd,
          });
          const herdr = new HerdrCliRuntime();
          const identity = yield* herdr.launchCoordinator({
            cwd: params.targetCwd,
            sessionFile,
          });
          return {
            content: [
              {
                type: "text",
                text: `Forked coordinator: workspace ${identity.workspaceId}, tab ${identity.tabId}, pane ${identity.paneId}, cwd ${identity.cwd}, native session ${identity.sessionFile}.`,
              },
            ],
            details: identity,
          };
        }),
        signal,
      );
    },
  });
  pi.registerTool({
    name: "workgraph_complete",
    label: "Workgraph Complete",
    description:
      "Complete after owned workers and resources settle. Runtime derives factual unresolved accounting from retained state; provide the coordinator's conclusion, nonempty evidence, and optional limitations.",
    parameters: CompleteSchema,
    execute(_id, params, signal, _update, ctx) {
      return runCallback(
        Effect.gen(function* () {
          const active = current();
          const state = yield* active.effects.submit(
            active.store.complete({
              ...params,
              limitations: params.limitations ?? [],
            }),
          );
          // Keep the scoped owner available for exact retained-output release after
          // semantic completion. Terminal lifecycle prevents launches or resume;
          // extension shutdown remains the native owner close boundary.
          return mutationResult("Completed workstream.", yield* remember(state, ctx), {
            action: "workgraph_complete",
            outcome: "completed",
          });
        }),
        signal,
      );
    },
  });
}

type ControlParams = Static<typeof ControlSchema>;
type ControlAction = ControlParams["action"];
type AttemptControlParams = Extract<
  ControlParams,
  { action: "cancel" | "steer" | "apply" | "release_output" }
>;
type LifecycleControlParams = Extract<ControlParams, { action: "suspend" | "resume" }>;
type ResultView = InspectView | ReturnType<typeof actionView>;

type ResearchParams = {
  id: string;
  question: string;
  expectedEvidence: string[];
  experiment?: {
    permittedEffects: string[];
    stopCondition: string;
  };
};

type ObservedInputReceipt = {
  receiptId: string;
  source: "interactive" | "rpc";
};

type AuthorizationSelection = {
  authority: {
    receiptId: string;
    intentVersion: number;
  };
  latestObservedInput?: ObservedInputReceipt;
};

type WorkstreamAuthoritySelection = {
  receiptId: string;
  latestObservedInput?: ObservedInputReceipt;
};

function projectAuthorityContext(selection: AuthorizationSelection) {
  const selectedScope = {
    intentVersion: selection.authority.intentVersion,
    authorityReceiptId: selection.authority.receiptId,
  };
  return selection.latestObservedInput === undefined
    ? { selectedScope }
    : { selectedScope, latestObservedInput: selection.latestObservedInput };
}

function requiredAuthorityReceipt(receipt: string | undefined): string {
  if (receipt === undefined || receipt === "")
    throw new Error("Mutation requires an actual retained human input receipt.");
  return receipt;
}

function selectIntentAuthority(
  state: WorkstreamState,
  requestedReceiptId: string | undefined,
): WorkstreamAuthoritySelection {
  const receiptId = requestedReceiptId ?? state.inputs.at(-1)?.id;
  if (receiptId === undefined)
    throw new Error("Intent requires an actual retained human input receipt.");
  if (!state.inputs.some((receipt) => receipt.id === receiptId))
    throw new Error(`Unknown retained human input receipt ${receiptId}.`);
  return { receiptId };
}

function selectWorkstreamAuthority(state: WorkstreamState): WorkstreamAuthoritySelection {
  const intent = requiredValue(state.intents.at(-1), "workstream intent");
  const latestReceipt = state.inputs.at(-1);
  const selectedReceipt = state.inputs.findLast((receipt) =>
    intent.authorityReceiptIds.includes(receipt.id),
  );
  const receiptId = requiredAuthorityReceipt(selectedReceipt?.id);
  if (selectedReceipt === undefined)
    throw new Error(`Current intent ${intent.version} has no retained authority receipt.`);
  if (latestReceipt === undefined || latestReceipt.id === receiptId) return { receiptId };
  return {
    receiptId,
    latestObservedInput: { receiptId: latestReceipt.id, source: latestReceipt.source },
  };
}

function selectSessionAuthority(
  receipts: Static<typeof InputReceipt>[],
  requestedReceiptId: string | undefined,
) {
  const receiptId = requiredAuthorityReceipt(requestedReceiptId ?? receipts.at(-1)?.id);
  const receipt = receipts.find((item) => item.id === receiptId);
  if (receipt === undefined) throw new Error(`Unknown retained human input receipt ${receiptId}.`);
  return {
    receiptId: receipt.id,
    sessionId: receipt.sessionId,
    sessionFile: receipt.sessionFile,
    source: receipt.source,
  };
}

function isPersistentModelMutation(action: "get" | "set" | "set_list" | "rates"): boolean {
  return action === "set" || action === "set_list";
}

function researchAssignment(
  params: ResearchParams,
  intentVersion: number,
  authority: { receiptId: string; intentVersion: number } | undefined,
): Parameters<WorkstreamStoreEffects["enqueue"]>[0] {
  const common = {
    id: params.id,
    capability: "research" as const,
    objective: params.question,
    intentVersion,
    expectedEvidence: params.expectedEvidence,
  };
  if (params.experiment === undefined || authority === undefined)
    return { ...common, artifactIntent: "evidence_only" };
  return {
    ...common,
    artifactIntent: "disposable_experiment",
    authority,
    permittedEffects: params.experiment.permittedEffects,
    stopCondition: params.experiment.stopCondition,
  };
}

function isModelListRole(role: (typeof MODEL_ROLES)[number] | undefined): role is ListModelRole {
  return role === "research" || role === "review" || role === "consultation.advisor";
}

function requiredModelListRole(role: (typeof MODEL_ROLES)[number] | undefined): ListModelRole {
  if (!isModelListRole(role))
    throw new Error(
      "Model list operations require research, review, or consultation.advisor role.",
    );
  return role;
}

function validateModelRequest(
  action: "get" | "set" | "set_list" | "rates",
  role: (typeof MODEL_ROLES)[number] | undefined,
  target: Static<typeof Target> | undefined,
  list: Static<typeof PolicyChoice>[] | undefined,
): void {
  if (action === "set" && (role === undefined || target === undefined))
    throw new Error("Setting a model default requires role and target.");
  if (action === "set_list" && (!isModelListRole(role) || list === undefined))
    throw new Error(
      "Setting a model list requires research, review, or consultation.advisor role and a nonempty list.",
    );
}

function resolveModelPolicyEffect(
  action: "get" | "set" | "set_list" | "rates",
  role: (typeof MODEL_ROLES)[number] | undefined,
  target: Static<typeof Target> | undefined,
  list: Static<typeof PolicyChoice>[] | undefined,
) {
  if (action === "set")
    return setModelRoleEffect(
      requiredValue(role, "model role"),
      requiredValue(target, "model target"),
    );
  if (action === "set_list")
    return setModelListEffect(requiredModelListRole(role), requiredValue(list, "model list"));
  return loadModelPolicyEffect();
}

function policyModelIds(policy: ModelPolicy): string[] {
  return [
    ...policy.roles.research,
    ...policy.roles.review,
    policy.roles["implementation.guide"],
    policy.roles["implementation.executor"],
    policy.roles["consultation.enricher"],
    ...policy.roles["consultation.advisor"],
  ].reduce<string[]>((models, target) => {
    if (!models.includes(target.model)) models.push(target.model);
    return models;
  }, []);
}

function formatRates(rates: ReturnType<typeof modelRates>): string {
  return JSON.stringify({ rates }, null, 2);
}
function formatPolicy(policy: ModelPolicy): string {
  return JSON.stringify({ path: modelPolicyPath(), policy }, null, 2);
}
function formatInspection(view: InspectView): string {
  return JSON.stringify(view, null, 2);
}

function modelRates(models: string[], ctx: ExtensionContext) {
  return models.map((modelId) => {
    const slash = modelId.indexOf("/");
    const model =
      slash > 0
        ? ctx.modelRegistry.find(modelId.slice(0, slash), modelId.slice(slash + 1))
        : undefined;
    return model === undefined
      ? {
          model: modelId,
          source: "Pi registry configured estimate unavailable",
          verified: false,
        }
      : {
          model: modelId,
          source: "Pi registry configured estimate",
          verified: false,
          ratesPerMillionTokens: { ...model.cost },
        };
  });
}

function isAttemptControl(params: ControlParams): params is AttemptControlParams {
  return (
    params.action === "cancel" ||
    params.action === "steer" ||
    params.action === "apply" ||
    params.action === "release_output"
  );
}

function controlAttemptEffect(
  active: WorkstreamRuntime,
  params: AttemptControlParams,
): CoordinatorEffect<string, RuntimeError | Error> {
  return Effect.gen(function* () {
    const state = yield* active.effects.submit(active.store.load());
    const attempt = state.attempts.find((item) => item.id === params.attempt);
    if (attempt === undefined) throw new Error(`Unknown exact attempt ${params.attempt}.`);
    yield* executeAttemptControl(active, params, attempt.id);
    return attempt.id;
  });
}

function executeAttemptControl(
  active: WorkstreamRuntime,
  params: AttemptControlParams,
  attemptId: string,
): CoordinatorEffect<void> {
  if (params.action === "cancel") return active.effects.cancel(attemptId);
  if (params.action === "steer") return active.effects.steer(attemptId, params.instruction);
  if (params.action === "apply") return active.effects.apply(attemptId).pipe(Effect.asVoid);
  return active.effects.releaseOutput(attemptId, params.reason).pipe(Effect.asVoid);
}

function lifecycleControlEffect(
  active: WorkstreamRuntime,
  params: LifecycleControlParams,
): CoordinatorEffect<undefined> {
  return active.effects
    .submit(
      active.store.setLifecycle({
        state: params.action === "suspend" ? "suspended" : "active",
        reason: params.reason,
      }),
    )
    .pipe(Effect.as(undefined));
}

function controlMessage(action: ControlAction): string {
  if (action === "steer") return "Steering submitted; application is not yet established.";
  if (action === "apply") return "Applied the exact retained maintained output.";
  if (action === "release_output") return "Released the exact retained output worktree.";
  return "Control request recorded.";
}
function controlOutcome(action: ControlAction): "submitted" | "inspected" | "recorded" {
  if (action === "steer") return "submitted";
  if (action === "apply" || action === "release_output") return "recorded";
  return "recorded";
}
function requiredValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}.`);
  return value;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Reattachment failures join typed Effect and native filesystem causes; this diagnostic walks only Error cause chains and does not authorize a retry.
function failureMessage(failure: unknown): string {
  const messages: string[] = [];
  let current: unknown = failure;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error && current.message !== "") messages.push(current.message);
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- A raw string is the only non-Error cause representation retained by supported native failures.
    else if (typeof current === "string" && current !== "") messages.push(current);
    // SAFETY: Object membership is checked before reading the standard Error cause field.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- See SAFETY above.
    current = typeof current === "object" && "cause" in current ? current.cause : undefined;
  }
  return [...new Set(messages)].join(": ") || String(failure);
}

function result(
  text: string,
  state: WorkstreamState,
  view: ResultView = inspectView(state, { section: "overview" }),
) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${text}\n\n${JSON.stringify(view, null, 2)}`,
      },
    ],
    details: { view, statePath: state.statePath },
  };
}

function mutationResult(
  text: string,
  state: WorkstreamState,
  options: Parameters<typeof actionView>[1],
) {
  return result(text, state, actionView(state, { ...options, message: text }));
}

function queueOptions(params: {
  selection?: QueueOptions["selection"];
  continuationOf?: string;
  candidateOf?: string;
  baseRevision?: string;
}): QueueOptions {
  const options: QueueOptions = {};
  if (params.selection !== undefined) options.selection = params.selection;
  if (params.continuationOf !== undefined && params.continuationOf !== "")
    options.continuationOf = params.continuationOf;
  if (params.candidateOf !== undefined && params.candidateOf !== "")
    options.candidateOf = params.candidateOf;
  if (params.baseRevision !== undefined && params.baseRevision !== "")
    options.baseRevision = params.baseRevision;
  return options;
}

function implementationQueueOptions(
  params: Parameters<typeof queueOptions>[0] & {
    models?: QueueOptions["models"];
  },
): QueueOptions {
  const options = queueOptions(params);
  if (params.models !== undefined) options.models = params.models;
  return options;
}
