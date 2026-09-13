/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/async-function, effecttsgo/global-date, effecttsgo/process-env, anti-slop/no-object-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread -- Pi callbacks are the Promise boundary; registered TypeBox schemas validate tool values before these typed callbacks. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { WorkstreamRuntime } from "../src/coordination/runtime.js";
import { installCoordinatorSessionState } from "../src/coordinator-notepad.js";
import type {
  AttemptRecord,
  CoordinatorOwner,
  IntentRecord,
  TaskRecord,
  WorkstreamMetadata,
} from "../src/domain/records.js";
import { resolveTaskTarget } from "../src/git.js";
import { HerdrCliRuntime } from "../src/herdr.js";
import { herdrWorkerName } from "../src/herdr-naming.js";
import {
  configuredTarget,
  implementationTargets,
  loadModelPolicy,
  MODEL_LIST_ROLES,
  modelPolicyPath,
  resolveSelection,
} from "../src/model-policy.js";
import { runNodePlatformPromise } from "../src/node-platform.js";
import {
  createWorkerSessionEffect,
  hasNativeAgentSettled,
  readWorkgraphReportResult,
} from "../src/pi-process.js";
import { WorkstreamStore } from "../src/storage/workstream-store.js";

const POINTER = "pi-workgraph-record-pointer";
const Text = Type.String({ minLength: 1, pattern: "\\S" });
const Target = Type.Optional(
  Type.Object(
    {
      kind: Type.Optional(Type.Union([Type.Literal("directory"), Type.Literal("repository")])),
      path: Type.Optional(Text),
    },
    { additionalProperties: false },
  ),
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
const taskFields = { id: Text, target: Target };
const HandoffGrant = Type.Object(
  {
    grantId: Text,
    parentWorkstreamId: Text,
    parentIntentIndex: Type.Integer({ minimum: 0 }),
    request: Text,
    constraints: Type.Array(Text),
  },
  { additionalProperties: false },
);
const ResultSubject = Type.Union([
  Type.Object({ kind: Type.Literal("result"), resultId: Text }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal("comparison"), resultIds: Type.Array(Text, { minItems: 2 }) },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal("revision"), revision: Text }, { additionalProperties: false }),
]);

type RuntimePorts = Parameters<typeof WorkstreamRuntime.acquire>[0]["ports"];

export interface CoordinatorOptions {
  readonly agentDir?: string;
  readonly policyPath?: string;
  readonly ports?: RuntimePorts;
  readonly priorCoordinatorAbsent?: (owner: CoordinatorOwner) => Promise<boolean>;
}

export default function coordinator(pi: ExtensionAPI, options: CoordinatorOptions = {}): void {
  if (!isCoordinatorScope(process.env)) return;
  const guidance = readFileSync(new URL("../COORDINATOR.md", import.meta.url), "utf8").trim();
  const agentDir = options.agentDir ?? getAgentDir();
  const ports = options.ports ?? nativePorts(agentDir, pi);
  const calm = installCalmMode(pi);
  let attached: WorkstreamRuntime | undefined;
  let scope: Scope.Scope | undefined;
  let tail = Promise.resolve();

  const owner = (ctx: ExtensionContext): CoordinatorOwner => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile === undefined) throw new Error("Coordinator session has no durable file.");
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile,
      tabId: process.env["HERDR_TAB_ID"] ?? ctx.sessionManager.getSessionId(),
    };
  };
  const session = installCoordinatorSessionState(pi, {
    owner: (ctx) => {
      const value = owner(ctx);
      return { sessionId: value.sessionId, sessionFile: value.sessionFile };
    },
    serialize: (run) => {
      const result = tail.then(run, run);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  });
  const toolResult = (value: object) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  });
  const serialize = <A>(run: () => Promise<A>): Promise<A> => {
    const result = tail.then(run, run);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const runtime = (): WorkstreamRuntime => {
    if (attached === undefined)
      throw new Error("No Workstream is attached; establish an Intent first.");
    return attached;
  };
  const close = async () => {
    attached = undefined;
    if (scope !== undefined) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      scope = undefined;
    }
    calm.setActiveWorkers(0);
  };
  const attach = async (store: WorkstreamStore, exactOwner: CoordinatorOwner) => {
    await close();
    const nextScope = await Effect.runPromise(Scope.make());
    const result = await Effect.runPromise(
      WorkstreamRuntime.acquire({ store, owner: exactOwner, agentDir, ports }).pipe(
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

  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt.endsWith(guidance)
      ? event.systemPrompt
      : `${event.systemPrompt}\n\n${guidance}`,
  }));
  pi.on("session_shutdown", () => close());
  pi.on("session_start", (_event, ctx) =>
    serialize(async () => {
      const branch = ctx.sessionManager.getBranch();
      const pointer = branch
        .filter((entry) => entry.type === "custom" && entry.customType === POINTER)
        .at(-1);
      try {
        if (
          pointer?.type === "custom" &&
          Value.Check(
            Type.Object({ workstreamId: Text }, { additionalProperties: false }),
            pointer.data,
          )
        ) {
          await attach(
            WorkstreamStore.open(agentDir, (pointer.data as { workstreamId: string }).workstreamId),
            owner(ctx),
          );
          return;
        }
        const grantEntry = branch.find(
          (entry) =>
            entry.type === "custom_message" &&
            entry.customType === "pi-workgraph-handoff-grant" &&
            Value.Check(HandoffGrant, entry.details),
        );
        if (grantEntry?.type !== "custom_message") return;
        const grant = Value.Decode(HandoffGrant, grantEntry.details);
        const exactOwner = owner(ctx);
        const at = new Date().toISOString();
        const id = `ws-${ctx.sessionManager.getSessionId()}`;
        const store = WorkstreamStore.create(
          agentDir,
          {
            id,
            purpose: grant.request,
            owner: exactOwner,
            lifecycle: "active",
            createdAt: at,
            updatedAt: at,
          },
          {
            workstreamId: id,
            index: 0,
            statement: grant.request,
            constraints: grant.constraints,
            authority: {
              grantId: grant.grantId,
              parentWorkstreamId: grant.parentWorkstreamId,
              parentIntentIndex: grant.parentIntentIndex,
            },
            recordedAt: at,
          },
        );
        await attach(store, exactOwner);
        pi.appendEntry(POINTER, { workstreamId: id });
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
      "Create or append a repository-neutral Intent grounded in exact current-session human input.",
    parameters: Type.Object(
      {
        statement: Text,
        constraints: Type.Optional(Type.Array(Text)),
        authorityReceiptId: Type.Optional(Text),
      },
      { additionalProperties: false },
    ),
    execute(_id, params, _signal, _update, ctx) {
      return serialize(async () => {
        const exactOwner = owner(ctx);
        const receipts = session
          .getHumanReceipts()
          .filter(
            (item) =>
              item.sessionId === exactOwner.sessionId &&
              item.sessionFile === exactOwner.sessionFile,
          );
        const receipt =
          params.authorityReceiptId === undefined
            ? receipts.at(-1)
            : receipts.find((item) => item.id === params.authorityReceiptId);
        if (receipt === undefined)
          throw new Error("Intent requires an exact current-session human input receipt.");
        const at = new Date().toISOString();
        if (attached === undefined) {
          const id = `ws-${ctx.sessionManager.getSessionId()}`;
          const metadata: WorkstreamMetadata = {
            id,
            purpose: params.statement,
            owner: exactOwner,
            lifecycle: "active",
            createdAt: at,
            updatedAt: at,
          };
          const intent: IntentRecord = {
            workstreamId: id,
            index: 0,
            statement: params.statement,
            constraints: params.constraints ?? [],
            authority: {
              receiptId: receipt.id,
              sessionId: receipt.sessionId,
              sessionFile: receipt.sessionFile,
            },
            recordedAt: at,
          };
          const store = WorkstreamStore.create(agentDir, metadata, intent);
          await attach(store, exactOwner);
          pi.appendEntry(POINTER, { workstreamId: id });
        } else {
          const index = attached.store.currentIntent().index + 1;
          attached.store.appendIntent(exactOwner, {
            workstreamId: attached.store.id,
            index,
            statement: params.statement,
            constraints: params.constraints ?? [],
            authority: {
              receiptId: receipt.id,
              sessionId: receipt.sessionId,
              sessionFile: receipt.sessionFile,
            },
            recordedAt: at,
          });
        }
        return toolResult({
          workstreamId: runtime().store.id,
          intent: runtime().store.currentIntent(),
        });
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
    async (params, ctx) => {
      const kind = params.experiment === undefined ? "research" : "experiment";
      return createAndLaunch(
        runtime(),
        ctx.cwd,
        options,
        {
          id: params.id,
          kind,
          objective: params.question,
          target: params.target,
          contract:
            params.experiment === undefined
              ? { expectedEvidence: params.expectedEvidence }
              : { expectedEvidence: params.expectedEvidence, ...params.experiment },
        },
        params.selection,
      );
    },
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
      const model = configuredTarget(policy, "consultation.advisor", params.advisor);
      return createAndLaunch(
        runtime(),
        ctx.cwd,
        options,
        {
          id: params.id,
          kind: "consultation",
          objective: params.question,
          target: params.target,
          contract: params.context === undefined ? {} : { context: params.context },
        },
        undefined,
        [modelFact("consultation", model)],
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
        candidateOf: Type.Optional(Text),
        integrate: Type.Optional(Type.Boolean()),
        baseRevision: Type.Optional(Text),
      },
      { additionalProperties: false },
    ),
    async (params, ctx) => {
      const policy = await loadModelPolicy(options.policyPath);
      const models = implementationTargets(policy, params.useEscalationExecutor ?? false);
      return createAndLaunch(
        runtime(),
        ctx.cwd,
        options,
        {
          id: params.id,
          kind: "implementation",
          objective: params.objective,
          target: params.target,
          contract: { acceptance: params.acceptance },
        },
        undefined,
        [modelFact("guide", models.guide), modelFact("executor", models.executor)],
        lineage(runtime(), params.candidateOf, params.integrate),
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
        subject: ResultSubject,
        selection: Selection,
      },
      { additionalProperties: false },
    ),
    async (params, ctx) =>
      createAndLaunch(
        runtime(),
        ctx.cwd,
        options,
        {
          id: params.id,
          kind: "review",
          objective: params.objective,
          target: params.target,
          contract: { concern: params.concern, subject: params.subject },
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
    description: "Create and launch one fresh Attempt for an immutable Task.",
    parameters: Type.Object(
      {
        task: Text,
        candidateOf: Type.Optional(Text),
        integrate: Type.Optional(Type.Boolean()),
        baseRevision: Type.Optional(Text),
      },
      { additionalProperties: false },
    ),
    execute(_id, params) {
      return serialize(() =>
        appendFreshAttempt(runtime(), options, params).then((attempt) => toolResult(attempt)),
      );
    },
  });
  pi.registerTool({
    name: "workgraph_inspect",
    label: "Workgraph Inspect",
    description: "Read bounded Workstream records with a numeric offset.",
    parameters: Type.Object(
      {
        section: StringEnum(["metadata", "intents", "tasks", "attempts", "outcomes"]),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params) {
      if (params.section === "metadata") return toolResult(runtime().store.metadata());
      return toolResult(
        await Effect.runPromise(
          runtime().inspect(
            params.section as "intents" | "tasks" | "attempts" | "outcomes",
            params.offset,
            params.limit,
          ),
        ),
      );
    },
  });
  pi.registerTool({
    name: "workgraph_control",
    label: "Workgraph Control",
    description: "Cancel, steer, apply, or explicitly discard exact Attempt output.",
    parameters: Type.Union(
      [
        Type.Object(
          { action: Type.Literal("cancel"), attempt: Text, reason: Type.Optional(Text) },
          { additionalProperties: false },
        ),
        Type.Object(
          { action: Type.Literal("steer"), attempt: Text, instruction: Text },
          { additionalProperties: false },
        ),
        Type.Object(
          { action: Type.Literal("apply"), attempt: Text },
          { additionalProperties: false },
        ),
        Type.Object(
          { action: Type.Literal("discard_output"), attempt: Text, reason: Text },
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
                runtime().cancel(params.attempt, params.reason ?? "Cancelled by coordinator."),
              )
            : params.action === "steer"
              ? await Effect.runPromise(runtime().steer(params.attempt, params.instruction)).then(
                  () => ({ steered: params.attempt }),
                )
              : params.action === "apply"
                ? await Effect.runPromise(runtime().apply(params.attempt))
                : await Effect.runPromise(runtime().discard(params.attempt, params.reason));
        return toolResult(value);
      });
    },
  });
  pi.registerTool({
    name: "workgraph_complete",
    label: "Workgraph Complete",
    description:
      "Complete when every Attempt has an Outcome; delivery and output settle independently.",
    parameters: Type.Object(
      {
        conclusion: Text,
        evidence: Type.Array(Text),
        limitations: Type.Optional(Type.Array(Text)),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params) {
      return toolResult(await Effect.runPromise(runtime().complete(params)));
    },
  });
  pi.registerTool({
    name: "workgraph_adopt",
    label: "Workgraph Adopt",
    description: "Adopt only after exact prior Coordinator tab and Pi session absence.",
    parameters: Type.Object(
      {
        workstreamId: Text,
        prior: Type.Object(
          { sessionId: Text, sessionFile: Text, tabId: Text },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    execute(_id, params, _signal, _update, ctx) {
      return serialize(async () => {
        const store = WorkstreamStore.open(agentDir, params.workstreamId);
        const absent = await (options.priorCoordinatorAbsent?.(params.prior) ??
          Effect.runPromise(new HerdrCliRuntime().coordinatorAbsent(params.prior)));
        const successor = owner(ctx);
        store.adopt(params.prior, successor, absent, new Date().toISOString());
        await attach(store, successor);
        pi.appendEntry(POINTER, { workstreamId: params.workstreamId });
        return toolResult({ adopted: params.workstreamId, owner: successor });
      });
    },
  });
  pi.registerTool({
    name: "workgraph_handoff",
    label: "Workgraph Handoff",
    description:
      "Launch one independent parentless Coordinator at the current cwd; no Workstream record is created.",
    parameters: Type.Object(
      { request: Text, includeContext: Type.Optional(Type.Boolean()) },
      { additionalProperties: false },
    ),
    execute(id, params, _signal, _update, ctx) {
      return serialize(async () => {
        const child = SessionManager.create(ctx.cwd);
        const intent = runtime().store.currentIntent();
        child.appendCustomMessageEntry("pi-workgraph-handoff-grant", params.request, true, {
          grantId: `grant-${id}`,
          parentWorkstreamId: runtime().store.id,
          parentIntentIndex: intent.index,
          request: params.request,
          constraints: intent.constraints,
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
        const identity = await Effect.runPromise(
          herdr.launchCoordinator({ cwd: ctx.cwd, sessionFile }),
        );
        await Effect.runPromise(
          herdr.prompt(
            identity,
            `[WORKGRAPH HANDOFF KICKOFF]\n${params.request}\nInherited constraints:\n${intent.constraints.map((item) => `- ${item}`).join("\n")}`,
          ),
        );
        return toolResult(identity);
      });
    },
  });
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
  id: string;
  kind: TaskRecord["kind"];
  objective: string;
  target: { kind?: "directory" | "repository"; path?: string } | undefined;
  contract: Record<string, unknown>;
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
    description: `Create an immutable ${label} Task and fresh Attempt.`,
    parameters,
    execute(_id, params, _signal, _update, ctx) {
      return serialize(() =>
        run(params as Static<S>, ctx).then((value) => ({
          content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
          details: value,
        })),
      );
    },
  });
}
async function appendFreshAttempt(
  runtime: WorkstreamRuntime,
  options: CoordinatorOptions,
  params: {
    task: string;
    candidateOf?: string;
    integrate?: boolean;
    baseRevision?: string;
  },
): Promise<AttemptRecord> {
  const task = runtime.store.task(params.task);
  const policy = await loadModelPolicy(options.policyPath);
  let models: AttemptRecord["models"];
  if (task.kind === "implementation") {
    const selected = implementationTargets(policy, false);
    models = [modelFact("guide", selected.guide), modelFact("executor", selected.executor)];
  } else {
    const role =
      task.kind === "review"
        ? "review"
        : task.kind === "consultation"
          ? "consultation.advisor"
          : "research";
    models = [modelFact(task.kind, configuredTarget(policy, role))];
  }
  const candidate = lineage(runtime, params.candidateOf, params.integrate);
  const attempt = await Effect.runPromise(
    runtime.createAttempt({
      taskId: task.id,
      models,
      ...(candidate === undefined ? {} : { lineage: candidate }),
      ...(params.baseRevision === undefined ? {} : { baseRevision: params.baseRevision }),
      experiment: task.kind === "experiment",
    }),
  );
  return Effect.runPromise(runtime.launch(attempt.id));
}

async function createAndLaunch(
  runtime: WorkstreamRuntime,
  cwd: string,
  options: CoordinatorOptions,
  input: ToolTask,
  selection?: { count?: number; distinctModels?: boolean },
  fixedModels?: AttemptRecord["models"],
  candidate?: AttemptRecord["lineage"],
  baseRevision?: string,
): Promise<AttemptRecord[]> {
  const target = resolveTaskTarget({
    cwd,
    ...(input.target?.path === undefined ? {} : { path: input.target.path }),
    ...(input.target?.kind === undefined ? {} : { kind: input.target.kind }),
  });
  await Effect.runPromise(runtime.createTask({ ...input, target }));
  let models = fixedModels;
  if (models === undefined) {
    const policy = await loadModelPolicy(options.policyPath);
    const role = input.kind === "review" ? "review" : "research";
    models = resolveSelection(role, selection, policy).selected.map((model) =>
      modelFact(input.kind, model),
    );
  }
  const attempts: AttemptRecord[] = [];
  for (const model of models) {
    const attempt = await Effect.runPromise(
      runtime.createAttempt({
        taskId: input.id,
        models: fixedModels === undefined ? [model] : models,
        ...(candidate === undefined ? {} : { lineage: candidate }),
        ...(baseRevision === undefined ? {} : { baseRevision }),
        experiment: input.kind === "experiment",
      }),
    );
    attempts.push(await Effect.runPromise(runtime.launch(attempt.id)));
    if (fixedModels !== undefined) break;
  }
  return attempts;
}
function modelFact(
  role: string,
  target: { model: string; thinking?: string },
): AttemptRecord["models"][number] {
  return target.thinking === undefined
    ? { role, model: target.model }
    : { role, model: target.model, thinking: target.thinking };
}
function lineage(
  runtime: WorkstreamRuntime,
  parentId?: string,
  integrate?: boolean,
): AttemptRecord["lineage"] | undefined {
  if (parentId === undefined) return undefined;
  const parent = runtime.store.attempt(parentId);
  if (parent.repository?.candidateRevision === undefined)
    throw new Error("Candidate parent has no retained commit.");
  return {
    kind: integrate === true ? "integrate" : "extend",
    parentAttemptId: parentId,
    parentCommit: parent.repository.candidateRevision,
  };
}
function nativePorts(agentDir: string, pi: ExtensionAPI): RuntimePorts {
  const herdr = new HerdrCliRuntime();
  const exactWorker = (
    identity: Parameters<RuntimePorts["worker"]["inspect"]>[0],
  ): import("../src/herdr-identity.js").WorkerIdentity => ({
    workspaceId: process.env["HERDR_WORKSPACE_ID"] ?? "",
    tabId: identity.tabId,
    paneId: identity.paneId,
    terminalId: identity.terminalId,
    agentName: herdrWorkerName({
      runId: identity.workstreamId,
      nodeId: identity.attemptId,
      attemptId: identity.attemptId,
      assignmentId: identity.taskId,
      objective: identity.objective,
      role: identity.role,
    }),
    sessionFile: identity.sessionFile,
    cwd: identity.cwd,
  });
  const launchFacts = new Map<
    string,
    {
      workstreamId: string;
      attemptId: string;
      objective: string;
      environment: Record<string, string>;
    }
  >();
  return {
    worker: {
      async createSession(input) {
        launchFacts.set(input.attemptId, input);
        const mode = input.environment["PI_WORKGRAPH_MODE"];
        if (mode !== "implementation" && mode !== "review" && mode !== "research")
          throw new Error("Invalid Worker mode.");
        const file = await runNodePlatformPromise(
          createWorkerSessionEffect({
            runId: input.workstreamId,
            nodeId: input.attemptId,
            targetCwd: input.cwd,
            sessionDir: join(agentDir, "workgraph", "worker-sessions", input.workstreamId),
            objective: input.objective,
            mode,
          }),
        );
        launchFacts.set(file, input);
        return file;
      },
      async launch(input) {
        const fact = launchFacts.get(input.sessionFile);
        if (fact === undefined) throw new Error("Missing Worker launch facts.");
        const selected = fact.environment["PI_WORKGRAPH_INITIAL_MODEL"];
        const thinking = fact.environment["PI_WORKGRAPH_INITIAL_THINKING"];
        const observation = await Effect.runPromise(
          herdr.launch({
            workspaceId: process.env["HERDR_WORKSPACE_ID"] ?? "",
            runId: input.workstreamId,
            nodeId: input.attemptId,
            attemptId: input.attemptId,
            assignmentId: input.taskId,
            objective: input.objective,
            role: input.role,
            cwd: input.cwd,
            sessionFile: input.sessionFile,
            env: fact.environment,
            ...(selected === undefined ? {} : { model: selected }),
            ...(thinking === undefined ? {} : { thinking }),
          }),
        );
        return {
          paneId: observation.identity.paneId,
          tabId: observation.identity.tabId,
          terminalId: observation.identity.terminalId,
        };
      },
      async inspect(identity) {
        const value = await Effect.runPromise(herdr.inspect(exactWorker(identity)));
        if (value.status !== "done") return { state: value.status };
        return this.readSession(identity.sessionFile, identity.workstreamId, identity.attemptId);
      },
      async prompt(identity, text) {
        await Effect.runPromise(herdr.prompt(exactWorker(identity), text));
      },
      async close(identity) {
        return Effect.runPromise(herdr.close(exactWorker(identity)));
      },
      async readSession(sessionFile, workstreamId, attemptId) {
        if (!hasNativeAgentSettled(sessionFile, workstreamId, attemptId))
          return { state: "working" };
        const report = readWorkgraphReportResult(sessionFile, {
          runId: workstreamId,
          nodeId: attemptId,
        });
        return report.report === undefined
          ? { state: "done" }
          : { state: "done", outcome: { kind: "reported", result: { report: report.report } } };
      },
    },
    delivery: {
      async deliver(outcome) {
        pi.sendMessage(
          {
            customType: "pi-workgraph-outcome",
            content: JSON.stringify(outcome),
            display: true,
            details: { outcomeId: outcome.id },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      },
    },
  };
}
function publicMessage(cause: unknown): string {
  return (cause instanceof Error ? cause.message : "operation failed")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}
