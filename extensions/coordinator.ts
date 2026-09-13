/* oxlint-disable effecttsgo/any-unknown-in-error-context -- Pi callbacks are the sole Promise facade over workstream Effects whose independently typed failures converge at this host boundary. */
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The in-scope factory reads one immutable packaged instruction asset before registering its lifecycle hooks.
import { readFileSync } from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Data, Effect } from "effect";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { installCalmMode, isCoordinatorScope } from "../src/calm.js";
import { NonBlankReasonSchema } from "../src/coordination/commands.js";
import {
  WORKSTREAM_POINTER_ENTRY,
  WorkstreamCoordinatorController,
  type WorkstreamCoordinatorControllerOptions,
  type WorkstreamPointerRestoration,
  WorkstreamPointerSchema,
} from "../src/coordination/controller.js";
import { WorkstreamInspectionRequestSchema } from "../src/coordination/inspection.js";
import type { WorkstreamRuntime } from "../src/coordination/runtime.js";
import { installCoordinatorSessionState } from "../src/coordinator-notepad.js";
import { EvidenceSchema } from "../src/domain/report.js";
import type { HandoffGrant, HumanInputReceiptData } from "../src/domain/workstream.js";
import {
  HANDOFF_KICKOFF_CLAIM_ENTRY,
  HANDOFF_KICKOFF_ENTRY,
  handoffChildWorkstreamId,
  sealedHandoffGrant,
} from "../src/handoff-session.js";
import {
  loadModelPolicyEffect,
  MODEL_LIST_ROLES,
  modelPolicyPath,
  SelectionRequestSchema,
} from "../src/model-policy.js";
import { liveLayer } from "../src/node-platform.js";

class HandoffKickoffError extends Data.TaggedError("HandoffKickoffError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const NonEmpty = Type.String({ minLength: 1 });
const Commit = Type.String({ pattern: "^[0-9a-f]{40,64}$" });
const IntentSchema = Type.Object(
  {
    statement: NonEmpty,
    constraints: Type.Optional(Type.Array(NonEmpty)),
    targetRepository: Type.Optional(NonEmpty),
    authorityReceiptId: Type.Optional(NonEmpty),
  },
  { additionalProperties: false },
);
const ExperimentSchema = Type.Object(
  { permittedEffects: Type.Array(NonEmpty, { minItems: 1 }), stopCondition: NonEmpty },
  { additionalProperties: false },
);
const ResearchSchema = Type.Union([
  Type.Object(
    {
      id: NonEmpty,
      question: NonEmpty,
      expectedEvidence: Type.Array(NonEmpty, { minItems: 1 }),
      selection: Type.Optional(SelectionRequestSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: NonEmpty,
      question: NonEmpty,
      expectedEvidence: Type.Array(NonEmpty, { minItems: 1 }),
      selection: Type.Optional(SelectionRequestSchema),
      experiment: ExperimentSchema,
      baseRevision: Type.Optional(Commit),
    },
    { additionalProperties: false },
  ),
]);
const ConsultSchema = Type.Object(
  {
    id: NonEmpty,
    question: Type.String({ minLength: 1, maxLength: 20_000 }),
    context: Type.Optional(Type.String({ maxLength: 20_000 })),
    advisor: Type.Optional(Type.String({ pattern: "^[^/\\s]+/\\S+$" })),
  },
  { additionalProperties: false },
);
const ImplementSchema = Type.Object(
  {
    id: NonEmpty,
    objective: NonEmpty,
    acceptance: Type.Array(NonEmpty, { minItems: 1 }),
    useEscalationExecutor: Type.Optional(Type.Boolean()),
    candidateOf: Type.Optional(NonEmpty),
    baseRevision: Type.Optional(Commit),
  },
  { additionalProperties: false },
);
const PublicReviewSubjectSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("result"), resultId: NonEmpty },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("comparison"), resultIds: Type.Array(NonEmpty, { minItems: 2 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("artifact"), resultId: NonEmpty, artifactId: NonEmpty },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("revision"), revision: Commit },
    { additionalProperties: false },
  ),
]);
const ReviewSchema = Type.Object(
  {
    id: NonEmpty,
    objective: NonEmpty,
    concern: NonEmpty,
    subject: PublicReviewSubjectSchema,
    selection: Type.Optional(SelectionRequestSchema),
  },
  { additionalProperties: false },
);
const AttemptSchema = Type.Object(
  {
    task: NonEmpty,
    continuationOf: Type.Optional(NonEmpty),
    candidateOf: Type.Optional(NonEmpty),
    baseRevision: Type.Optional(Commit),
    selection: Type.Optional(SelectionRequestSchema),
    useEscalationExecutor: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const ControlSchema = Type.Union(
  [
    Type.Object(
      { action: Type.Literal("suspend"), reason: NonBlankReasonSchema },
      { additionalProperties: false },
    ),
    Type.Object(
      { action: Type.Literal("resume"), reason: NonBlankReasonSchema },
      { additionalProperties: false },
    ),
    Type.Object(
      { action: Type.Literal("cancel"), attempt: NonEmpty },
      { additionalProperties: false },
    ),
    Type.Object(
      { action: Type.Literal("apply"), attempt: NonEmpty },
      { additionalProperties: false },
    ),
    Type.Object(
      { action: Type.Literal("steer"), attempt: NonEmpty, instruction: NonEmpty },
      { additionalProperties: false },
    ),
    Type.Object(
      { action: Type.Literal("discard_output"), attempt: NonEmpty, reason: NonBlankReasonSchema },
      { additionalProperties: false },
    ),
  ],
  { type: "object" },
);
const HandoffSchema = Type.Object(
  {
    request: Type.String({ minLength: 1, pattern: "\\S" }),
    includeContext: Type.Optional(Type.Boolean({ default: false })),
  },
  { additionalProperties: false },
);
const CompleteSchema = Type.Object(
  {
    conclusion: NonEmpty,
    evidence: Type.Array(EvidenceSchema, { minItems: 1 }),
    limitations: Type.Optional(Type.Array(NonEmpty)),
  },
  { additionalProperties: false },
);

export default function workstreamCoordinator(
  pi: ExtensionAPI,
  options: WorkstreamCoordinatorControllerOptions = {},
): void {
  if (!isCoordinatorScope(process.env)) return;
  const guidance = readFileSync(new URL("../COORDINATOR.md", import.meta.url), "utf8").trim();
  const calm = installCalmMode(pi);
  const publish = (
    ctx: ExtensionContext,
    state?: { lifecycle: string; activeAttemptCount: number },
  ) => {
    try {
      if (state === undefined) {
        ctx.ui.setStatus("workgraph", undefined);
        calm.setActiveWorkers(0);
        return;
      }
      ctx.ui.setStatus("workgraph", `WG ${state.lifecycle} - ${state.activeAttemptCount} active`);
      calm.setActiveWorkers(state.activeAttemptCount);
    } catch {
      // Presentation is best-effort and cannot alter committed Workstream records.
    }
  };
  const controller = new WorkstreamCoordinatorController(pi, options, publish);
  let sessionTail = Promise.resolve();
  const session = installCoordinatorSessionState(pi, {
    owner: (ctx) => controller.owner(ctx),
    serialize: (run) => {
      const result = sessionTail.then(run, run);
      sessionTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  });
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      import("effect").FileSystem.FileSystem | import("effect").Path.Path
    >,
    signal?: AbortSignal,
  ) => Effect.runPromise(effect.pipe(Effect.provide(liveLayer)), { signal });
  const receipt = (ctx: ExtensionContext, id?: string): HumanInputReceiptData => {
    const owner = controller.owner(ctx);
    const eligible = session
      .getHumanReceipts()
      .filter(
        (item) => item.sessionId === owner.sessionId && item.sessionFile === owner.sessionFile,
      );
    const selected = id === undefined ? eligible.at(-1) : eligible.find((item) => item.id === id);
    if (selected === undefined)
      throw new Error("Intent requires an eligible current-session human input receipt.");
    return selected;
  };
  const toolResult = <Value extends object>(value: Value) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  });
  const pointer = (ctx: ExtensionContext): WorkstreamPointerRestoration => {
    const entry = ctx.sessionManager
      .getBranch()
      .findLast((item) => item.type === "custom" && item.customType === WORKSTREAM_POINTER_ENTRY);
    if (entry?.type !== "custom") return undefined;
    return Value.Check(WorkstreamPointerSchema, entry.data)
      ? Value.Decode(WorkstreamPointerSchema, entry.data)
      : "malformed";
  };

  pi.on("session_start", (_event, ctx) =>
    run(
      Effect.gen(function* () {
        const grant = sealedHandoffGrant(ctx.sessionManager);
        const restoration = pointer(ctx);
        if (grant !== undefined && restoration !== undefined)
          validateChildPointer(restoration, grant, ctx.sessionManager.getSessionId());
        yield* controller.restore(ctx, () => restoration);
        if (grant === undefined) return;
        yield* controller.bootstrapHandoff(ctx, grant);
        yield* triggerHandoffKickoff(pi, ctx, grant);
      }).pipe(Effect.onError(() => controller.close(ctx).pipe(Effect.ignore))),
    ).catch((error) => {
      ctx.ui.notify(`Workstream reattachment skipped: ${publicMessage(error)}`, "warning");
    }),
  );
  pi.on("session_shutdown", (_event, ctx) => run(controller.close(ctx)));
  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt.endsWith(guidance)
      ? event.systemPrompt
      : `${event.systemPrompt}\n\n${guidance}`,
  }));

  pi.registerTool({
    name: "workgraph_models",
    label: "Workgraph Models",
    description:
      "List the exact configured workstream model targets for a selectable read-only role.",
    promptSnippet: "Inspect configured Workgraph model targets",
    parameters: Type.Object(
      { role: StringEnum(MODEL_LIST_ROLES) },
      { additionalProperties: false },
    ),
    execute(_id, params, signal) {
      return run(
        Effect.map(loadModelPolicyEffect(options.policyPath), (policy) =>
          toolResult({
            path: options.policyPath ?? modelPolicyPath(),
            role: params.role,
            targets: policy.roles[params.role],
          }),
        ),
        signal,
      );
    },
  });
  pi.registerTool({
    name: "workgraph_intent",
    label: "Workgraph Intent",
    description:
      "Create or revise the workstream Intent from an exact genuine current-session receipt; initial creation fixes the repository.",
    parameters: IntentSchema,
    execute(_id, params, signal, _update, ctx) {
      return run(
        Effect.suspend(() =>
          Effect.map(
            controller.establish(
              ctx,
              receipt(ctx, params.authorityReceiptId),
              intentRequest(params),
            ),
            toolResult,
          ),
        ),
        signal,
      );
    },
  });
  pi.registerTool({
    name: "workgraph_handoff",
    label: "Workgraph Handoff",
    description:
      "Launch one independent child coordinator with a narrowed request. includeContext=false starts clean; true includes only the discussion before this call as non-authoritative context. The request cannot broaden the current Intent. Returns exact native identity only when Herdr reports working or idle. Every current launch failure is uncertain: retain the child session and known native resources; do not clean up or retry. There is no result channel or retry lifecycle.",
    promptSnippet: "Launch an independent focused child coordinator",
    parameters: HandoffSchema,
    execute(id, params, signal, _update, ctx) {
      const request = {
        request: params.request,
        includeContext: params.includeContext ?? false,
      };
      return run(Effect.map(controller.handoff(ctx, id, request), toolResult), signal);
    },
  });
  pi.registerTool({
    name: "workgraph_research",
    label: "Workgraph Research",
    description:
      "Create one frozen workstream research or bounded disposable-experiment Task and its initial Attempt selection.",
    promptSnippet: "Delegate research or a bounded experiment",
    parameters: ResearchSchema,
    execute(_id, params, signal) {
      const command = !("experiment" in params)
        ? {
            taskId: params.id,
            objective: params.question,
            kind: "research" as const,
            expectedEvidence: params.expectedEvidence,
            selection: params.selection,
          }
        : {
            taskId: params.id,
            objective: params.question,
            kind: "experiment" as const,
            expectedEvidence: params.expectedEvidence,
            permittedEffects: params.experiment.permittedEffects,
            stopCondition: params.experiment.stopCondition,
            selection: params.selection,
            baseRevision: params.baseRevision,
          };
      return run(
        action(controller, (runtime) => runtime.enqueue(command), {
          action: "workgraph_research",
          taskId: params.id,
        }),
        signal,
      );
    },
  });
  pi.registerTool({
    name: "workgraph_consult",
    label: "Workgraph Consult",
    description:
      "Create one frozen evidence-only consultation Task using the configured default or exact advisor.",
    promptSnippet: "Consult one evidence advisor",
    parameters: ConsultSchema,
    execute(_id, params, signal) {
      return run(
        action(
          controller,
          (runtime) =>
            runtime.enqueue({
              taskId: params.id,
              objective: params.question,
              kind: "consultation",
              context: params.context,
              advisor: params.advisor,
            }),
          { action: "workgraph_consult", taskId: params.id },
        ),
        signal,
      );
    },
  });
  pi.registerTool({
    name: "workgraph_implement",
    label: "Workgraph Implement",
    description:
      "Create one frozen implementation assignment and its policy-owned guide/executor Attempt after that assignment's solution shape is settled.",
    promptSnippet: "Delegate an authorized implementation assignment",
    parameters: ImplementSchema,
    execute(_id, params, signal) {
      return run(
        action(
          controller,
          (runtime) =>
            runtime.enqueue({
              taskId: params.id,
              objective: params.objective,
              kind: "implementation",
              acceptance: params.acceptance,
              useEscalationExecutor: params.useEscalationExecutor,
              candidateOf: params.candidateOf,
              baseRevision: params.baseRevision,
            }),
          { action: "workgraph_implement", taskId: params.id },
        ),
        signal,
      );
    },
  });
  pi.registerTool({
    name: "workgraph_review",
    label: "Workgraph Review",
    description:
      "Create one frozen workstream review Task for exact retained result, artifact, comparison, or revision evidence.",
    promptSnippet: "Delegate selective review",
    parameters: ReviewSchema,
    execute(_id, params, signal) {
      return run(
        action(
          controller,
          (runtime) =>
            runtime.enqueue({
              taskId: params.id,
              objective: params.objective,
              kind: "review",
              concern: params.concern,
              subject: reviewSubject(params.subject),
              selection: params.selection,
            }),
          { action: "workgraph_review", taskId: params.id },
        ),
        signal,
      );
    },
  });
  pi.registerTool({
    name: "workgraph_attempt",
    label: "Workgraph Attempt",
    description:
      "Append workstream Attempt(s) to one exact frozen current-Intent Task after all prior Attempts are operationally stable.",
    parameters: AttemptSchema,
    execute(_id, params, signal) {
      return run(
        action(
          controller,
          (runtime) =>
            runtime.appendAttempts({
              taskId: params.task,
              continuationOf: params.continuationOf,
              candidateOf: params.candidateOf,
              baseRevision: params.baseRevision,
              selection: params.selection,
              useEscalationExecutor: params.useEscalationExecutor,
            }),
          { action: "workgraph_attempt", taskId: params.task },
        ),
        signal,
      );
    },
  });
  pi.registerTool({
    name: "workgraph_inspect",
    label: "Workgraph Inspect",
    description:
      "Return one bounded typed workstream inspection section using exact handles and an opaque revision-bound cursor.",
    promptSnippet: "Inspect workstream Workgraph state and retained evidence",
    parameters: WorkstreamInspectionRequestSchema,
    execute(_id, params, signal) {
      return run(Effect.map(controller.inspect(params), toolResult), signal);
    },
  });
  pi.registerTool({
    name: "workgraph_control",
    label: "Workgraph Control",
    description:
      "Suspend, resume, cancel, steer, apply maintained output, or irreversibly discard all exact-attempt checkout content (including dirty, untracked, and ignored files) through exact Workstream record boundaries.",
    parameters: ControlSchema,
    execute(_id, params, signal) {
      return run(
        action(
          controller,
          (runtime) => controlOperation(runtime, params),
          "attempt" in params
            ? { action: `workgraph_control:${params.action}`, attemptId: params.attempt }
            : { action: `workgraph_control:${params.action}` },
        ),
        signal,
      );
    },
  });
  pi.registerTool({
    name: "workgraph_complete",
    label: "Workgraph Complete",
    description:
      "Record the coordinator's goal evidence and limitations only after workstream operational accounting permits completion.",
    parameters: CompleteSchema,
    execute(_id, params, signal) {
      return run(
        action(
          controller,
          (runtime) =>
            runtime.complete({
              conclusion: params.conclusion,
              evidence: params.evidence,
              limitations: params.limitations ?? [],
            }),
          { action: "workgraph_complete" },
        ),
        signal,
      );
    },
  });
}

function intentRequest(params: Static<typeof IntentSchema>): {
  statement: string;
  constraints: string[];
  targetRepository?: string;
} {
  const base = { statement: params.statement, constraints: params.constraints ?? [] };
  return params.targetRepository === undefined
    ? base
    : { ...base, targetRepository: params.targetRepository };
}

function controlOperation(runtime: WorkstreamRuntime, params: Static<typeof ControlSchema>) {
  switch (params.action) {
    case "suspend":
      return runtime.suspend({ reason: params.reason });
    case "resume":
      return runtime.resume({ reason: params.reason });
    case "cancel":
      return runtime.cancel({
        attemptId: params.attempt,
        reason: "Cancelled by coordinator through workgraph_control.",
      });
    case "steer":
      return runtime.steer({ attemptId: params.attempt, instruction: params.instruction });
    case "apply":
      return runtime.apply({ attemptId: params.attempt });
    case "discard_output":
      return runtime.discardOutput({ attemptId: params.attempt, reason: params.reason });
  }
}

function action<Error>(
  controller: WorkstreamCoordinatorController,
  operation: (
    runtime: WorkstreamRuntime,
  ) => Effect.Effect<
    unknown,
    Error,
    import("effect").FileSystem.FileSystem | import("effect").Path.Path
  >,
  projection: { action: string; taskId?: string; attemptId?: string },
) {
  return Effect.map(controller.action(operation, projection), (value) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  }));
}

function reviewSubject(subject: Static<typeof PublicReviewSubjectSchema>) {
  switch (subject.kind) {
    case "result":
      return { kind: "outcome" as const, outcomeId: subject.resultId };
    case "comparison":
      return { kind: "comparison" as const, outcomeIds: subject.resultIds };
    case "artifact":
      return {
        kind: "artifact" as const,
        outcomeId: subject.resultId,
        artifactId: subject.artifactId,
      };
    case "revision":
      return subject;
  }
}

function validateChildPointer(
  pointer: WorkstreamPointerRestoration,
  grant: HandoffGrant,
  childSessionId: string,
): void {
  if (
    pointer === "malformed" ||
    pointer === undefined ||
    pointer.workstreamId !== handoffChildWorkstreamId(childSessionId) ||
    !Value.Equal(pointer.repository, grant.targetRepository)
  )
    throw new Error("Retained workstream pointer conflicts with the child Handoff Grant.");
}

function triggerHandoffKickoff(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  grant: HandoffGrant,
): Effect.Effect<void, HandoffKickoffError> {
  return Effect.try({
    try: () => {
      const branch = ctx.sessionManager.getBranch();
      const identity = {
        grantId: grant.id,
        childSessionId: ctx.sessionManager.getSessionId(),
      };
      const retained = retainedKickoff(branch, identity);
      if (retained === "claim") {
        ctx.ui.notify(
          "The retained Workgraph handoff kickoff claim has no exact submitted message; submission is uncertain and was not duplicated.",
          "warning",
        );
        return;
      }
      if (retained !== undefined) {
        if (!hasAssistantAfter(branch, retained))
          ctx.ui.notify(
            "The retained Workgraph handoff kickoff has no observed child response; it was not duplicated.",
            "warning",
          );
        return;
      }
      pi.appendEntry(HANDOFF_KICKOFF_CLAIM_ENTRY, identity);
      pi.sendMessage(
        {
          customType: HANDOFF_KICKOFF_ENTRY,
          content: [
            "[WORKGRAPH HANDOFF KICKOFF]",
            grant.narrowedRequest,
            "",
            "Inherited parent constraints:",
            ...grant.parentIntentConstraints.map((constraint) => `- ${constraint}`),
          ].join("\n"),
          display: true,
          details: identity,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    },
    catch: (cause) =>
      new HandoffKickoffError({
        message: `Handoff child session start failed: ${publicMessage(cause)}`,
        cause,
      }),
  });
}

type KickoffIdentity = { readonly grantId: string; readonly childSessionId: string };

function retainedKickoff(
  branch: readonly SessionEntry[],
  identity: KickoffIdentity,
): Extract<SessionEntry, { type: "custom_message" }> | "claim" | undefined {
  const claims = branch.filter(
    (entry): entry is Extract<SessionEntry, { type: "custom" }> =>
      entry.type === "custom" && entry.customType === HANDOFF_KICKOFF_CLAIM_ENTRY,
  );
  const messages = branch.filter(
    (entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
      entry.type === "custom_message" && entry.customType === HANDOFF_KICKOFF_ENTRY,
  );
  if (claims.length > 1 || messages.length > 1)
    throw new Error("Child session contains multiple handoff kickoff claims or messages.");
  const claim = claims[0];
  if (claim !== undefined && !Value.Equal(claim.data, identity))
    throw new Error("Child session contains a conflicting handoff kickoff claim.");
  const message = messages[0];
  if (message !== undefined && !Value.Equal(message.details, identity))
    throw new Error("Child session contains a malformed handoff kickoff message.");
  if (message !== undefined && claim === undefined)
    throw new Error("Child session handoff kickoff message has no pre-effect claim.");
  if (message !== undefined) return message;
  return claim === undefined ? undefined : "claim";
}

function hasAssistantAfter(
  branch: readonly SessionEntry[],
  kickoff: Extract<SessionEntry, { type: "custom_message" }>,
): boolean {
  return branch
    .slice(branch.indexOf(kickoff) + 1)
    .some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.provider !== "workgraph",
    );
}

function publicMessage(cause: unknown): string {
  return (cause instanceof Error ? cause.message : "operation failed")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}
