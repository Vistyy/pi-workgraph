import { randomUUID } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The extension loads one immutable packaged instruction asset before registering runtime Effects.
import { readFileSync } from "node:fs";
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
  loadModelPolicyEffect,
  MODEL_LIST_ROLES,
  modelPolicyPath,
  SelectionRequestSchema as Selection,
} from "../src/model-policy.js";
import { liveLayer } from "../src/node-platform.js";
import { forkConversationSessionEffect } from "../src/pi-process.js";
import { EvidenceSchema } from "../src/report-schema.js";
import { loadCalmAdditionalHiddenTools } from "../src/workgraph-settings.js";
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
const COORDINATOR_GUIDANCE = readFileSync(
  new URL("../COORDINATOR.md", import.meta.url),
  "utf8",
).trim();

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

export default function workgraphCoordinator(
  pi: ExtensionAPI,
  runtimeWorker: () => RuntimeWorkerPort = () => new HerdrCliRuntime(),
): void {
  if (!isCoordinatorScope(process.env)) return;
  const calm = installCalmMode(pi, { loadAdditionalHiddenTools: loadCalmAdditionalHiddenTools });
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
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${COORDINATOR_GUIDANCE}`,
  }));

  pi.registerTool({
    name: "workgraph_models",
    label: "Workgraph Models",
    description:
      "Return the configured ordered model targets for research, review, or consultation.advisor.",
    promptSnippet: "Inspect configured Workgraph model targets",
    parameters: Type.Object(
      { role: StringEnum(MODEL_LIST_ROLES) },
      { additionalProperties: false },
    ),
    execute(_id, params, signal) {
      return runCallback(
        Effect.gen(function* () {
          const policy = yield* loadModelPolicyEffect();
          const targets = policy.roles[params.role];
          return {
            // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- Configured targets are already validated domain values and this is the read-only tool response.
            content: [{ type: "text", text: JSON.stringify(targets, null, 2) }],
            details: { path: modelPolicyPath(), role: params.role, targets },
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
      "Queue bounded evidence work within the established intent. State the question and observations needed; an optional disposable experiment must also bound its permitted effects and stopping condition.",
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
      "Queue one read-only advisor under the established intent. It receives the question and optional coordinator context. Advice is evidence, not authority or acceptance.",
    promptSnippet: "Consult one evidence advisor",
    parameters: Type.Object(
      {
        id: Type.String({ minLength: 1 }),
        question: Type.String({ minLength: 1, maxLength: 20_000 }),
        context: Type.Optional(Type.String({ maxLength: 20_000 })),
        advisor: Type.Optional(Type.String({ pattern: "^[^/\\s]+/\\S+$" })),
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
            intentVersion: intent.version,
          };
          if (params.context !== undefined) assignment.context = params.context;
          if (params.advisor !== undefined) assignment.advisorModel = params.advisor;
          const state = yield* active.effects.queue(assignment);
          return mutationResult(
            `Queued consultation ${params.id}; advisor execution is observed asynchronously.`,
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
      "Establish or revise the shared Workgraph goal and constraints from retained human input. The first intent fixes the repository; later revisions cannot switch it. Required before delegation.",
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
      "Queue a maintained change only after its consequential design is settled with the user. Carry that design and observable acceptance conditions in the assignment; the worker chooses only local mechanics. Newer input does not change the established intent automatically.",
    promptSnippet: "Delegate an authorized maintained change",
    parameters: Type.Object(
      {
        id: Type.String(),
        objective: Type.String(),
        acceptance: Type.Array(Type.String(), { minItems: 1 }),
        ...QueueOptionFields,
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
            queueOptions(params),
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
      "Queue read-only review of an exact retained result, artifact, revision, or comparison for one specific concern. Request discrepancies and supporting evidence, not an acceptance decision. Revision review inspects that revision rather than live files.",
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
      "Read a bounded view of workstream state, retained context, assignments, outcomes, evidence, completion, or recovery. Notifications normally contain enough to act; inspect when uncertainty, blockers, repeated attempts, or truncation could change the decision.",
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
      "Suspend or resume coordination; cancel or steer one exact attempt; apply one exact retained maintained output; or release one exact retained output. Settlement never applies output, and cancellation preserves output.",
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
      "Transfer a retained workstream from a coordinator proven dead to the current coordinator session. This preserves its repository, scope, suspension state, and human-input history; lease expiry alone is insufficient.",
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
      "Fork the coordinator conversation into a new unfocused Herdr workspace at the requested working directory. This starts separate coordination rather than continuing or adopting a workstream.",
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
      "Record the coordinator's goal-level conclusion, supporting evidence, and limitations after owned work and resources settle. Runtime-derived unresolved accounting still blocks completion.",
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

function formatInspection(view: InspectView): string {
  return JSON.stringify(view, null, 2);
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
