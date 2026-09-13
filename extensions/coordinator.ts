/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/async-function, effecttsgo/global-date, effecttsgo/process-env, anti-slop/no-object-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread -- Pi callbacks are the Promise boundary; registered TypeBox schemas validate tool values before these typed callbacks. */
import { readFileSync } from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  buildContextEntries,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  SessionManager,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { Effect, Exit, Scope } from "effect";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { installCalmMode, isCoordinatorScope } from "../src/calm.js";
import { RuntimeError, WorkstreamRuntime } from "../src/coordination/runtime.js";
import { installCoordinatorReceipts } from "../src/coordinator-receipts.js";
import {
  type AttemptLineage,
  type AttemptRecord,
  type AttemptSelection,
  type CoordinatorOwner,
  type Intent,
  type TaskContract,
  TaskIdSchema,
  WORKSTREAM_FORMAT,
  WORKSTREAM_SCHEMA_VERSION,
  type WorkstreamMetadata,
} from "../src/domain/records.js";
import { resolveTaskTarget } from "../src/git.js";
import { HerdrCliRuntime, type WorkerIdentity } from "../src/herdr.js";
import {
  configuredTarget,
  implementationTargets,
  loadModelPolicy,
  MODEL_LIST_ROLES,
  modelPolicyPath,
  resolveSelection,
} from "../src/model-policy.js";
import { WorkstreamStore } from "../src/storage/workstream-store.js";

const POINTER = "pi-workgraph-workstream-pointer";
const Text = Type.String({ minLength: 1, pattern: "\\S" });
const Pointer = Type.Object(
  { version: Type.Literal(1), workstreamId: Text },
  { additionalProperties: false },
);
const Selection = Type.Optional(
  Type.Object(
    {
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
      distinctModels: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
);
const Candidate = Type.Optional(
  Type.Object(
    { attemptId: Text, mode: StringEnum(["extend", "integrate"] as const) },
    { additionalProperties: false },
  ),
);
const taskFields = { taskId: TaskIdSchema, cwd: Type.Optional(Text) };
const HumanAuthority = Type.Object(
  { receiptId: Text, sessionId: Text, sessionFile: Text },
  { additionalProperties: false },
);
const Owner = Type.Object(
  { sessionId: Text, sessionFile: Text, workspaceId: Text, tabId: Text },
  { additionalProperties: false },
);
const HandoffGrant = Type.Object(
  {
    version: Type.Literal(1),
    grantId: Text,
    rootHumanReceipt: HumanAuthority,
    parentCoordinator: Owner,
    parentWorkstreamId: Text,
    parentIntentIndex: Type.Integer({ minimum: 0 }),
    request: Text,
    constraints: Type.Array(Text),
  },
  { additionalProperties: false },
);
const ReviewSubject = Type.Union([
  Type.Object({ kind: Type.Literal("outcome"), outcomeId: Text }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal("comparison"), outcomeIds: Type.Array(Text, { minItems: 2 }) },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal("revision"), revision: Text }, { additionalProperties: false }),
]);

export interface CoordinatorOptions {
  readonly agentDir?: string;
  readonly policyPath?: string;
}

export default function coordinator(pi: ExtensionAPI, options: CoordinatorOptions = {}): void {
  if (!isCoordinatorScope(process.env)) return;
  const guidance = readFileSync(new URL("../COORDINATOR.md", import.meta.url), "utf8").trim();
  const agentDir = options.agentDir ?? getAgentDir();
  const calm = installCalmMode(pi);
  let attached: WorkstreamRuntime | undefined;
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
  const owner = (ctx: ExtensionContext): CoordinatorOwner => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    const workspaceId = process.env["HERDR_WORKSPACE_ID"];
    const tabId = process.env["HERDR_TAB_ID"];
    if (sessionFile === undefined) throw new Error("Coordinator session has no durable file.");
    if (workspaceId === undefined || tabId === undefined)
      throw new Error("Coordinator requires exact Herdr workspace and tab identity.");
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile,
      workspaceId,
      tabId,
    };
  };
  const receipts = installCoordinatorReceipts(pi, {
    owner: (ctx) => {
      const exact = owner(ctx);
      return { sessionId: exact.sessionId, sessionFile: exact.sessionFile };
    },
    serialize,
  });
  const toolResult = (value: object) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  });
  const runtime = (): WorkstreamRuntime => {
    if (attached === undefined)
      throw new Error("No Workstream is attached; establish an Intent or adopt one first.");
    return attached;
  };
  const close = async () => {
    attached = undefined;
    if (scope !== undefined) {
      const closing = scope;
      scope = undefined;
      await Effect.runPromise(Scope.close(closing, Exit.void));
    }
    calm.setActiveWorkers(0);
  };
  const attach = async (store: WorkstreamStore, exactOwner: CoordinatorOwner) => {
    await close();
    const nextScope = await Effect.runPromise(Scope.make());
    const result = await Effect.runPromise(
      WorkstreamRuntime.acquire({ store, owner: exactOwner, agentDir, pi }).pipe(
        Scope.provide(nextScope),
      ),
    );
    if (result.state !== "attached") {
      await Effect.runPromise(Scope.close(nextScope, Exit.void));
      throw new Error(result.state === "blocked" ? result.reason : "Workstream detached.");
    }
    scope = nextScope;
    attached = result.runtime;
  };
  const appendPointer = (workstreamId: string) =>
    pi.appendEntry(POINTER, { version: 1, workstreamId });
  const createOrAttach = async (ctx: ExtensionContext, workstreamId: string, intent: Intent) => {
    const exactOwner = owner(ctx);
    appendPointer(workstreamId);
    const at = new Date().toISOString();
    const metadata: WorkstreamMetadata = {
      format: WORKSTREAM_FORMAT,
      schemaVersion: WORKSTREAM_SCHEMA_VERSION,
      id: workstreamId,
      owner: exactOwner,
      lifecycle: "active",
      createdAt: at,
      updatedAt: at,
    };
    const store = WorkstreamStore.create(agentDir, metadata, intent);
    await attach(store, exactOwner);
  };

  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt.endsWith(guidance)
      ? event.systemPrompt
      : `${event.systemPrompt}\n\n${guidance}`,
  }));
  pi.on("session_shutdown", () => serialize(close));
  pi.on("session_start", (_event, ctx) =>
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one ordered recovery boundary prevents pointer/grant precedence from splitting across handlers.
    serialize(async () => {
      const branch = ctx.sessionManager.getBranch();
      const pointer = branch
        .filter((entry) => entry.type === "custom" && entry.customType === POINTER)
        .at(-1);
      try {
        if (pointer?.type === "custom" && Value.Check(Pointer, pointer.data)) {
          const decoded = Value.Decode(Pointer, pointer.data);
          const exactOwner = owner(ctx);
          try {
            await attach(
              WorkstreamStore.openOwned(agentDir, decoded.workstreamId, exactOwner),
              exactOwner,
            );
            return;
          } catch (cause) {
            const grant = latestGrant(branch);
            if (grant === undefined) throw cause;
            await createOrAttach(ctx, decoded.workstreamId, grantIntent(grant));
            return;
          }
        }
        const grant = latestGrant(branch);
        if (grant === undefined) return;
        await createOrAttach(ctx, deterministicWorkstreamId(ctx), grantIntent(grant));
      } catch (cause) {
        ctx.ui.notify(`Workgraph blocked: ${publicMessage(cause)}`, "warning");
      }
    }),
  );

  pi.registerTool({
    name: "workgraph_models",
    label: "Workgraph Models",
    description: "List exact configured Workgraph model targets.",
    parameters: Type.Object(
      { role: StringEnum(MODEL_LIST_ROLES) },
      { additionalProperties: false },
    ),
    async execute(_id, params) {
      const policy = await loadModelPolicy(options.policyPath);
      return toolResult({
        path: options.policyPath ?? modelPolicyPath(agentDir),
        role: params.role,
        targets: policy.roles[params.role],
      });
    },
  });
  pi.registerTool({
    name: "workgraph_intent",
    label: "Workgraph Intent",
    description:
      "Create or append a repository-neutral Intent from the latest genuine current-session human input.",
    parameters: Type.Object(
      { statement: Text, constraints: Type.Optional(Type.Array(Text)) },
      { additionalProperties: false },
    ),
    execute(_id, params, _signal, _update, ctx) {
      return serialize(async () => {
        const exactOwner = owner(ctx);
        const receipt = receipts
          .getHumanReceipts()
          .filter(
            (item) =>
              item.sessionId === exactOwner.sessionId &&
              item.sessionFile === exactOwner.sessionFile,
          )
          .at(-1);
        if (receipt === undefined)
          throw new Error("Intent requires genuine current-session human input.");
        const intent: Intent = {
          statement: params.statement,
          constraints: params.constraints ?? [],
          authority: {
            receiptId: receipt.id,
            sessionId: receipt.sessionId,
            sessionFile: receipt.sessionFile,
          },
          recordedAt: new Date().toISOString(),
        };
        if (attached === undefined)
          await createOrAttach(ctx, deterministicWorkstreamId(ctx), intent);
        else runtime().store.appendIntent(exactOwner, intent);
        const current = runtime().store.readLatestIntent();
        return toolResult({ workstreamId: runtime().store.id, intentIndex: current.index });
      });
    },
  });

  registerTask(
    pi,
    "workgraph_research",
    "Research",
    Type.Object(
      {
        ...taskFields,
        question: Text,
        expectedEvidence: Type.Array(Text, { minItems: 1 }),
        selection: Selection,
        experiment: Type.Optional(
          Type.Object(
            { permittedEffects: Type.Array(Text, { minItems: 1 }), stopCondition: Text },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    async (params, ctx) =>
      createAndQueue(
        runtime(),
        ctx.cwd,
        options,
        {
          taskId: params.taskId,
          cwd: params.cwd,
          targetKind: params.experiment === undefined ? "directory" : "repository",
          contract:
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
                  ...params.experiment,
                },
        },
        params.selection,
      ),
    serialize,
  );
  registerTask(
    pi,
    "workgraph_consult",
    "Consult",
    Type.Object(
      {
        ...taskFields,
        question: Text,
        context: Type.Optional(Type.String({ maxLength: 20_000 })),
        advisor: Type.Optional(Text),
      },
      { additionalProperties: false },
    ),
    async (params, ctx) => {
      const policy = await loadModelPolicy(options.policyPath);
      return createAndQueue(
        runtime(),
        ctx.cwd,
        options,
        {
          taskId: params.taskId,
          cwd: params.cwd,
          targetKind: "directory",
          contract:
            params.context === undefined
              ? { kind: "consultation", question: params.question }
              : { kind: "consultation", question: params.question, context: params.context },
        },
        undefined,
        {
          kind: "target",
          target: configuredTarget(policy, "consultation.advisor", params.advisor),
        },
      );
    },
    serialize,
  );
  registerTask(
    pi,
    "workgraph_implement",
    "Implement",
    Type.Object(
      {
        ...taskFields,
        objective: Text,
        acceptance: Type.Array(Text, { minItems: 1 }),
        useEscalationExecutor: Type.Optional(Type.Boolean()),
        candidate: Candidate,
        baseRevision: Type.Optional(Text),
      },
      { additionalProperties: false },
    ),
    async (params, ctx) => {
      if (params.candidate?.mode === "extend" && params.baseRevision !== undefined)
        throw new Error("Candidate extension forbids baseRevision.");
      const policy = await loadModelPolicy(options.policyPath);
      const models = implementationTargets(policy, params.useEscalationExecutor ?? false);
      return createAndQueue(
        runtime(),
        ctx.cwd,
        options,
        {
          taskId: params.taskId,
          cwd: params.cwd,
          targetKind: "repository",
          contract: {
            kind: "implementation",
            objective: params.objective,
            acceptance: params.acceptance,
          },
        },
        undefined,
        { kind: "implementation", guide: models.guide, executor: models.executor },
        candidateLineage(runtime(), params.candidate),
        params.baseRevision,
      );
    },
    serialize,
  );
  registerTask(
    pi,
    "workgraph_review",
    "Review",
    Type.Object(
      {
        ...taskFields,
        objective: Text,
        concern: Text,
        subject: ReviewSubject,
        selection: Selection,
      },
      { additionalProperties: false },
    ),
    async (params, ctx) =>
      createAndQueue(
        runtime(),
        ctx.cwd,
        options,
        {
          taskId: params.taskId,
          cwd: params.cwd,
          targetKind: params.subject.kind === "revision" ? "repository" : "directory",
          contract: {
            kind: "review",
            objective: params.objective,
            concern: params.concern,
            subject: params.subject,
          },
        },
        params.selection,
        undefined,
        undefined,
        params.subject.kind === "revision" ? params.subject.revision : undefined,
      ),
    serialize,
  );

  pi.registerTool({
    name: "workgraph_attempt",
    label: "Workgraph Attempt",
    description: "Create one fresh Attempt inheriting its immutable Task target.",
    parameters: Type.Object(
      {
        taskId: Text,
        candidate: Candidate,
        baseRevision: Type.Optional(Text),
        useEscalationExecutor: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    execute(_id, params) {
      return serialize(async () => {
        if (params.candidate?.mode === "extend" && params.baseRevision !== undefined)
          throw new Error("Candidate extension forbids baseRevision.");
        const attempt = await appendFreshAttempt(runtime(), options, params);
        return toolResult(attemptReceipt(attempt));
      });
    },
  });
  pi.registerTool({
    name: "workgraph_inspect",
    label: "Workgraph Inspect",
    description: "Discover Workstreams globally or inspect exact bounded record sections.",
    parameters: Type.Object(
      {
        section: StringEnum([
          "overview",
          "intent",
          "task",
          "attempt",
          "outcome",
          "completion",
        ] as const),
        workstreamId: Type.Optional(Text),
        intentIndex: Type.Optional(Type.Integer({ minimum: 0 })),
        taskId: Type.Optional(Text),
        attemptId: Type.Optional(Text),
        outcomeId: Type.Optional(Text),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        includeSettled: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    execute(_id, params) {
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one selector dispatcher keeps exact-id and paging precedence visible at the public inspection boundary.
      return serialize(async () => {
        if (params.section === "overview" && params.workstreamId === undefined)
          return toolResult(
            WorkstreamStore.discover(
              agentDir,
              params.includeSettled ?? false,
              params.offset ?? 0,
              params.limit ?? 20,
            ),
          );
        const selected = selectStore(agentDir, attached, params.workstreamId);
        try {
          const store = selected.store;
          if (params.section === "overview") {
            const status = selected.attached?.inspectionStatus();
            return toolResult({
              metadata: store.readMetadata(),
              title: store.title(),
              operationallyUnsettled: store.unsettled().length,
              ...(status?.blocker === undefined ? {} : { runtimeBlocker: status.blocker }),
            });
          }
          if (params.section === "completion")
            return toolResult({
              workstreamId: store.id,
              completion: store.readMetadata().completion ?? null,
            });
          if (params.section === "intent" && params.intentIndex !== undefined)
            return toolResult(store.readIntent(params.intentIndex));
          if (params.section === "task" && params.taskId !== undefined)
            return toolResult(store.readTask(params.taskId));
          if (params.section === "attempt" && params.attemptId !== undefined)
            return toolResult({
              ...store.readAttempt(params.attemptId),
              ...(selected.attached?.inspectionStatus().blocker?.includes(params.attemptId) === true
                ? { runtimeBlocker: selected.attached.inspectionStatus().blocker }
                : {}),
            });
          if (params.section === "outcome" && params.outcomeId !== undefined)
            return toolResult(store.readOutcomeById(params.outcomeId));
          const section = `${params.section}s` as "intents" | "tasks" | "attempts" | "outcomes";
          if (!(["intents", "tasks", "attempts", "outcomes"] as const).includes(section))
            throw new Error(`Exact selector required for ${params.section} inspection.`);
          const records = store.page(section, (params.offset ?? 0) - 1, params.limit ?? 20);
          return toolResult({ records, offset: params.offset ?? 0, limit: params.limit ?? 20 });
        } finally {
          if (selected.owned) selected.store.close();
        }
      });
    },
  });
  pi.registerTool({
    name: "workgraph_control",
    label: "Workgraph Control",
    description: "Cancel, steer, apply, or explicitly discard one exact Attempt.",
    parameters: Type.Union(
      [
        Type.Object(
          { action: Type.Literal("cancel"), attemptId: Text, reason: Type.Optional(Text) },
          { additionalProperties: false },
        ),
        Type.Object(
          { action: Type.Literal("steer"), attemptId: Text, instruction: Text },
          { additionalProperties: false },
        ),
        Type.Object(
          { action: Type.Literal("apply"), attemptId: Text },
          { additionalProperties: false },
        ),
        Type.Object(
          { action: Type.Literal("discard"), attemptId: Text, reason: Text },
          { additionalProperties: false },
        ),
      ],
      { type: "object" },
    ),
    execute(_id, params) {
      return serialize(async () => {
        const value =
          params.action === "cancel"
            ? await Effect.runPromise(
                runtime().cancel(params.attemptId, params.reason ?? "Cancelled by Coordinator."),
              )
            : params.action === "steer"
              ? await Effect.runPromise(runtime().steer(params.attemptId, params.instruction)).then(
                  () => ({ attemptId: params.attemptId, steered: true }),
                )
              : params.action === "apply"
                ? attemptReceipt(await Effect.runPromise(runtime().apply(params.attemptId)))
                : attemptReceipt(
                    await Effect.runPromise(runtime().discard(params.attemptId, params.reason)),
                  );
        return toolResult(value);
      });
    },
  });
  pi.registerTool({
    name: "workgraph_complete",
    label: "Workgraph Complete",
    description:
      "Record the goal-level conclusion; operational settlement remains independently inspectable.",
    parameters: Type.Object(
      {
        conclusion: Text,
        evidence: Type.Array(Text),
        limitations: Type.Optional(Type.Array(Text)),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params) {
      const completed = await Effect.runPromise(runtime().complete(params));
      return toolResult({
        workstreamId: completed.id,
        lifecycle: completed.lifecycle,
        completion: completed.completion,
      });
    },
  });
  pi.registerTool({
    name: "workgraph_adopt",
    label: "Workgraph Adopt",
    description:
      "Adopt a discovered Workstream only after Herdr proves its exact prior Coordinator absent.",
    parameters: Type.Object({ workstreamId: Text }, { additionalProperties: false }),
    execute(_id, params, _signal, _update, ctx) {
      return serialize(async () => {
        const inspecting = WorkstreamStore.openReadOnly(agentDir, params.workstreamId);
        const prior = inspecting.readMetadata().owner;
        inspecting.close();
        const successor = owner(ctx);
        if (sameOwner(prior, successor)) {
          await attach(
            WorkstreamStore.openOwned(agentDir, params.workstreamId, successor),
            successor,
          );
          appendPointer(params.workstreamId);
          return toolResult({
            workstreamId: params.workstreamId,
            adopted: true,
            alreadyCurrent: true,
          });
        }
        const observation = await Effect.runPromise(
          new HerdrCliRuntime().observeCoordinator(prior),
        );
        if (observation.state !== "absent")
          throw new Error("Prior Coordinator is still present; adoption is blocked.");
        const store = WorkstreamStore.openOwned(agentDir, params.workstreamId, prior);
        store.adopt(prior, successor, true, new Date().toISOString());
        await attach(store, successor);
        appendPointer(params.workstreamId);
        return toolResult({
          workstreamId: params.workstreamId,
          adopted: true,
          alreadyCurrent: false,
        });
      });
    },
  });
  pi.registerTool({
    name: "workgraph_handoff",
    label: "Workgraph Handoff",
    description:
      "Launch one independent parentless Coordinator with one narrowed grant and one kickoff.",
    parameters: Type.Object(
      { request: Text, includeContext: Type.Optional(Type.Boolean()) },
      { additionalProperties: false },
    ),
    execute(id, params, _signal, _update, ctx) {
      return serialize(async () => {
        const currentRuntime = runtime();
        const metadata = currentRuntime.store.readMetadata();
        if (metadata.lifecycle !== "active")
          throw new Error("Handoff requires an active Workstream.");
        const intent = currentRuntime.store.readLatestIntent();
        const rootHumanReceipt = rootAuthority(intent.intent);
        const child = SessionManager.create(ctx.cwd);
        child.appendCustomMessageEntry("pi-workgraph-handoff-grant", params.request, true, {
          version: 1,
          grantId: `grant-${id}`,
          rootHumanReceipt,
          parentCoordinator: metadata.owner,
          parentWorkstreamId: metadata.id,
          parentIntentIndex: intent.index,
          request: params.request,
          constraints: intent.intent.constraints,
        });
        if (params.includeContext === true)
          child.appendCustomMessageEntry(
            "pi-workgraph-handoff-context",
            handoffContext(ctx, id),
            false,
            { authority: "none" },
          );
        const sessionFile = child.getSessionFile();
        if (sessionFile === undefined) throw new Error("Handoff child session was not persisted.");
        const herdr = new HerdrCliRuntime();
        let identity: WorkerIdentity;
        try {
          identity = await Effect.runPromise(
            herdr.launchCoordinator({ cwd: ctx.cwd, sessionFile }),
          );
        } catch (cause) {
          throw new Error(
            `Handoff launch is uncertain; retained child session ${sessionFile}. ${publicMessage(cause)}`,
          );
        }
        try {
          await Effect.runPromise(
            herdr.prompt(identity, `[WORKGRAPH HANDOFF KICKOFF]\n${params.request}`),
          );
        } catch (cause) {
          throw new Error(
            `Handoff kickoff is uncertain; retained exact resources ${JSON.stringify(identity)}. ${publicMessage(cause)}`,
          );
        }
        return toolResult({ sessionId: child.getSessionId(), ...identity });
      });
    },
  });
}

function latestGrant(
  branch: ReturnType<SessionManager["getBranch"]>,
): Static<typeof HandoffGrant> | undefined {
  const entry = branch.findLast(
    (candidate) =>
      candidate.type === "custom_message" &&
      candidate.customType === "pi-workgraph-handoff-grant" &&
      Value.Check(HandoffGrant, candidate.details),
  );
  return entry?.type === "custom_message" ? Value.Decode(HandoffGrant, entry.details) : undefined;
}
function grantIntent(grant: Static<typeof HandoffGrant>): Intent {
  return {
    statement: grant.request,
    constraints: grant.constraints,
    authority: {
      grantId: grant.grantId,
      rootHumanReceipt: grant.rootHumanReceipt,
      parentCoordinator: grant.parentCoordinator,
      parentWorkstreamId: grant.parentWorkstreamId,
      parentIntentIndex: grant.parentIntentIndex,
    },
    recordedAt: new Date().toISOString(),
  };
}
function rootAuthority(intent: Intent): Static<typeof HumanAuthority> {
  return "receiptId" in intent.authority ? intent.authority : intent.authority.rootHumanReceipt;
}
function deterministicWorkstreamId(ctx: ExtensionContext): string {
  return `ws-${ctx.sessionManager.getSessionId()}`;
}
function selectStore(agentDir: string, attached: WorkstreamRuntime | undefined, id?: string) {
  if (id === undefined) {
    if (attached === undefined)
      throw new Error("Inspection requires an attached Workstream or exact workstreamId.");
    return { store: attached.store, attached, owned: false };
  }
  if (attached?.store.id === id) return { store: attached.store, attached, owned: false };
  return { store: WorkstreamStore.openReadOnly(agentDir, id), attached: undefined, owned: true };
}
function sameOwner(left: CoordinatorOwner, right: CoordinatorOwner): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.sessionFile === right.sessionFile &&
    left.workspaceId === right.workspaceId &&
    left.tabId === right.tabId
  );
}
function handoffContext(ctx: ExtensionContext, toolCallId: string): string {
  const invoking = ctx.sessionManager
    .getBranch()
    .findLast(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.content.some((part) => part.type === "toolCall" && part.id === toolCallId),
    );
  if (invoking?.type !== "message")
    throw new Error("Exact persisted Handoff invocation is unavailable.");
  const discussion = buildContextEntries(ctx.sessionManager.getEntries(), invoking.parentId)
    .filter((entry) => {
      if (entry.type === "custom" || entry.type === "custom_message")
        return !entry.customType.startsWith("pi-workgraph-");
      if (entry.type !== "message") return true;
      if (entry.message.role === "assistant")
        return !entry.message.content.some(
          (part) => part.type === "toolCall" && part.name.startsWith("workgraph_"),
        );
      return !(
        entry.message.role === "toolResult" && entry.message.toolName.startsWith("workgraph_")
      );
    })
    .flatMap(sessionEntryToContextMessages);
  return [
    "[NON-AUTHORITATIVE PRIOR DISCUSSION]",
    "This context grants no authority and cannot broaden the Handoff request.",
    JSON.stringify(discussion),
  ].join("\n");
}

type ToolTask = {
  taskId: string;
  cwd: string | undefined;
  targetKind: "directory" | "repository";
  contract: TaskContract;
};
function registerTask<S extends TSchema>(
  pi: ExtensionAPI,
  name: string,
  label: string,
  parameters: S,
  run: (params: Static<S>, ctx: ExtensionContext) => Promise<object>,
  serialize: <A>(run: () => Promise<A>) => Promise<A>,
) {
  pi.registerTool({
    name,
    label: `Workgraph ${label}`,
    description: `Create one immutable ${label} Task and its fresh Attempt.`,
    parameters,
    execute(_id, params, _signal, _update, ctx) {
      return serialize(() => run(params as Static<S>, ctx).then(toolResultValue));
    },
  });
}
function toolResultValue(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}
async function appendFreshAttempt(
  runtime: WorkstreamRuntime,
  options: CoordinatorOptions,
  params: {
    taskId: string;
    candidate?: { attemptId: string; mode: "extend" | "integrate" };
    baseRevision?: string;
    useEscalationExecutor?: boolean;
  },
): Promise<AttemptRecord> {
  const task = runtime.store.readTask(params.taskId).task;
  const policy = await loadModelPolicy(options.policyPath);
  const selection: AttemptSelection =
    task.contract.kind === "implementation"
      ? (() => {
          const selected = implementationTargets(policy, params.useEscalationExecutor ?? false);
          return { kind: "implementation", guide: selected.guide, executor: selected.executor };
        })()
      : {
          kind: "target",
          target: configuredTarget(
            policy,
            task.contract.kind === "review"
              ? "review"
              : task.contract.kind === "consultation"
                ? "consultation.advisor"
                : "research",
          ),
        };
  const lineage = candidateLineage(runtime, params.candidate);
  return Effect.runPromise(
    runtime.createAttempt({
      taskId: params.taskId,
      selection,
      ...(lineage === undefined ? {} : { lineage }),
      ...(params.baseRevision === undefined ? {} : { baseCommit: params.baseRevision }),
    }),
  );
}
async function createAndQueue(
  runtime: WorkstreamRuntime,
  invocationCwd: string,
  options: CoordinatorOptions,
  input: ToolTask,
  selection?: { count?: number; distinctModels?: boolean },
  fixedSelection?: AttemptSelection,
  candidate?: AttemptLineage,
  baseRevision?: string,
): Promise<object> {
  const target = await Effect.runPromise(
    resolveTaskTarget({
      cwd: invocationCwd,
      ...(input.cwd === undefined ? {} : { path: input.cwd }),
      kind: input.targetKind,
      ...(baseRevision === undefined ? {} : { revision: baseRevision }),
    }),
  );
  let selections: AttemptSelection[];
  if (fixedSelection !== undefined) selections = [fixedSelection];
  else {
    const policy = await loadModelPolicy(options.policyPath);
    const role = input.contract.kind === "review" ? "review" : "research";
    selections = resolveSelection(role, selection, policy).selected.map((target) => ({
      kind: "target" as const,
      target,
    }));
  }
  const first = selections[0];
  if (first === undefined) throw new Error("Task requires at least one selected model target.");
  const initial = await Effect.runPromise(
    runtime.createTask({
      id: input.taskId,
      target,
      contract: input.contract,
      selection: first,
      ...(candidate === undefined ? {} : { lineage: candidate }),
      ...(baseRevision === undefined ? {} : { baseCommit: baseRevision }),
    }),
  );
  const attempts = [initial];
  for (const selected of selections.slice(1))
    attempts.push(
      await Effect.runPromise(runtime.createAttempt({ taskId: input.taskId, selection: selected })),
    );
  return {
    workstreamId: runtime.store.id,
    taskId: input.taskId,
    attempts: attempts.map(attemptReceipt),
  };
}
function attemptReceipt(record: AttemptRecord) {
  return { taskId: record.taskId, attemptId: record.id, sequence: record.sequence };
}
function candidateLineage(
  runtime: WorkstreamRuntime,
  candidate?: { attemptId: string; mode: "extend" | "integrate" },
): AttemptLineage | undefined {
  if (candidate === undefined) return undefined;
  const parent = runtime.store.readAttempt(candidate.attemptId).attempt;
  if (parent.output?.kind !== "retained")
    throw new Error("Candidate parent has no retained commit.");
  const root =
    parent.lineage?.candidateRoot ??
    (parent.base.kind === "repository" ? parent.base.baseCommit : undefined);
  if (root === undefined) throw new Error("Candidate parent has no repository root.");
  return {
    candidateRoot: root,
    candidateOf:
      candidate.mode === "integrate"
        ? { kind: "integrate", attemptId: candidate.attemptId, sourceTip: parent.output.tip }
        : { kind: "extend", attemptId: candidate.attemptId },
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
