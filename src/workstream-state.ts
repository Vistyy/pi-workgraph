// oxlint-disable-next-line effecttsgo/node-builtin-import -- Canonical persisted paths require the host Node path implementation; Effect exposes only the service contract here.
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Data } from "effect";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { ModelTargetSchema } from "./model-policy.js";
import { EvidenceSchema, WorkerReportSchema } from "./report-schema.js";

export const WORKSTREAM_STATE_VERSION = 7 as const;
export const WORKSTREAM_FORMAT = "pi-workgraph-workstream" as const;

export function pathForWorkstream(gitCommonDir: string, id: string): string {
  return join(resolve(gitCommonDir), "pi-workgraph", "workstreams", id, "workstream.json");
}

const NonEmptyStringSchema = Type.String({ minLength: 1 });
const TimestampSchema = Type.String({ minLength: 1 });
export const SessionIdentitySchema = Type.Object(
  {
    sessionId: NonEmptyStringSchema,
    sessionFile: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);
export const LifecycleSchema = Type.Object(
  {
    state: StringEnum(["active", "suspended", "completed", "abandoned", "archived"] as const),
    changedAt: TimestampSchema,
    reason: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);
export const HumanInputReceiptSchema = Type.Object(
  {
    id: NonEmptyStringSchema,
    sessionId: NonEmptyStringSchema,
    sessionFile: NonEmptyStringSchema,
    source: StringEnum(["interactive", "rpc"] as const),
    text: NonEmptyStringSchema,
    receivedAt: TimestampSchema,
  },
  { additionalProperties: false },
);
export const IntentSchema = Type.Object(
  {
    version: Type.Integer({ minimum: 0 }),
    statement: NonEmptyStringSchema,
    constraints: Type.Array(NonEmptyStringSchema),
    authorityReceiptIds: Type.Array(NonEmptyStringSchema),
    recordedAt: TimestampSchema,
  },
  { additionalProperties: false },
);
export const AuthorityReferenceSchema = Type.Object(
  {
    receiptId: NonEmptyStringSchema,
    intentVersion: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export const ResultSubjectSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("result"), resultId: NonEmptyStringSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("comparison"),
      resultIds: Type.Array(NonEmptyStringSchema, { minItems: 2 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("artifact"),
      resultId: NonEmptyStringSchema,
      artifactId: NonEmptyStringSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("revision"),
      revision: Type.String({ pattern: "^[0-9a-f]{40,64}$" }),
    },
    { additionalProperties: false },
  ),
]);
const AssignmentBase = {
  id: NonEmptyStringSchema,
  objective: NonEmptyStringSchema,
  intentVersion: Type.Integer({ minimum: 0 }),
  createdAt: TimestampSchema,
};
const ResearchAssignmentSchema = Type.Object(
  {
    ...AssignmentBase,
    capability: Type.Literal("research"),
    artifactIntent: Type.Literal("evidence_only"),
    expectedEvidence: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
const ExperimentAssignmentSchema = Type.Object(
  {
    ...AssignmentBase,
    capability: Type.Literal("research"),
    artifactIntent: Type.Literal("disposable_experiment"),
    authority: AuthorityReferenceSchema,
    permittedEffects: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
    stopCondition: NonEmptyStringSchema,
    expectedEvidence: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
const ImplementationAssignmentSchema = Type.Object(
  {
    ...AssignmentBase,
    capability: Type.Literal("implement"),
    artifactIntent: Type.Literal("maintained_change"),
    authority: AuthorityReferenceSchema,
    acceptance: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
const ReviewAssignmentSchema = Type.Object(
  {
    ...AssignmentBase,
    capability: Type.Literal("review"),
    artifactIntent: Type.Literal("evidence_only"),
    subject: ResultSubjectSchema,
    concern: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);
export const AssignmentSchema = Type.Union([
  ResearchAssignmentSchema,
  ExperimentAssignmentSchema,
  ImplementationAssignmentSchema,
  ReviewAssignmentSchema,
]);
export const ArtifactSchema = Type.Object(
  {
    id: NonEmptyStringSchema,
    kind: StringEnum(["path", "revision", "reference"] as const),
    reference: NonEmptyStringSchema,
    retention: StringEnum(["retained", "discarded"] as const),
    summary: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);
const ResultBase = {
  id: NonEmptyStringSchema,
  assignmentId: NonEmptyStringSchema,
  assignmentIntentVersion: Type.Integer({ minimum: 0 }),
  artifacts: Type.Array(ArtifactSchema),
  observedAt: TimestampSchema,
};
export const ResultSchema = Type.Union([
  Type.Object(
    {
      ...ResultBase,
      validity: Type.Literal("typed"),
      report: WorkerReportSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ResultBase,
      validity: Type.Literal("untyped"),
      text: NonEmptyStringSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ResultBase,
      validity: Type.Literal("invalid"),
      detail: NonEmptyStringSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ResultBase,
      validity: Type.Literal("absent"),
      detail: NonEmptyStringSchema,
    },
    { additionalProperties: false },
  ),
]);
export const SelectionReceiptSchema = Type.Object(
  {
    role: StringEnum(["research", "review"] as const),
    requested: Type.Integer({ minimum: 1 }),
    diversity: StringEnum(["same-model", "distinct-models"] as const),
    selected: Type.Array(ModelTargetSchema),
    unfulfilled: Type.Array(NonEmptyStringSchema),
    source: StringEnum(["policy", "override"] as const),
    reason: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);
export const ModelsSchema = Type.Object(
  {
    guide: ModelTargetSchema,
    executor: Type.Optional(ModelTargetSchema),
    source: StringEnum(["policy", "override"] as const),
    overrideReason: Type.Optional(NonEmptyStringSchema),
    selection: Type.Optional(SelectionReceiptSchema),
  },
  { additionalProperties: false },
);
export const ResourceSchema = Type.Object(
  {
    workspaceId: NonEmptyStringSchema,
    tabId: NonEmptyStringSchema,
    paneId: NonEmptyStringSchema,
    terminalId: NonEmptyStringSchema,
    agentName: NonEmptyStringSchema,
    cwd: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);
export const AttemptPlacementSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("shared_project"),
      path: NonEmptyStringSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("isolated_worktree"),
      path: NonEmptyStringSchema,
      branch: NonEmptyStringSchema,
    },
    { additionalProperties: false },
  ),
]);
export const AttemptSchema = Type.Object(
  {
    id: NonEmptyStringSchema,
    assignmentId: NonEmptyStringSchema,
    state: StringEnum([
      "queued",
      "starting",
      "running",
      "settled",
      "failed",
      "cancel_requested",
      "cancelled",
    ] as const),
    models: Type.Optional(ModelsSchema),
    effectiveModels: Type.Optional(
      Type.Array(
        Type.Object(
          {
            model: NonEmptyStringSchema,
            thinking: Type.Optional(NonEmptyStringSchema),
            source: Type.Optional(StringEnum(["selection", "message"] as const)),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    continuationOf: Type.Optional(NonEmptyStringSchema),
    launchPane: Type.Optional(
      Type.Object(
        { workspaceId: NonEmptyStringSchema, paneId: NonEmptyStringSchema },
        { additionalProperties: false },
      ),
    ),
    resource: Type.Optional(ResourceSchema),
    submission: Type.Optional(
      StringEnum(["not_sent", "uncertain", "submitted", "started"] as const),
    ),
    steering: Type.Optional(
      Type.Object(
        {
          text: NonEmptyStringSchema,
          state: StringEnum(["uncertain", "submitted"] as const),
        },
        { additionalProperties: false },
      ),
    ),
    application: Type.Optional(
      Type.Object(
        {
          state: StringEnum(["pending", "applied", "blocked"] as const),
          commit: NonEmptyStringSchema,
          expectedHead: NonEmptyStringSchema,
          revision: Type.Optional(NonEmptyStringSchema),
          error: Type.Optional(NonEmptyStringSchema),
        },
        { additionalProperties: false },
      ),
    ),
    cleanup: Type.Optional(
      Type.Object(
        {
          state: StringEnum(["pending", "blocked", "completed"] as const),
          expectedHead: Type.Optional(NonEmptyStringSchema),
          workerClosed: Type.Boolean(),
          error: Type.Optional(NonEmptyStringSchema),
        },
        { additionalProperties: false },
      ),
    ),
    outputRelease: Type.Optional(
      Type.Object(
        {
          state: StringEnum(["pending", "blocked", "completed"] as const),
          expectedHead: Type.String({ pattern: "^[0-9a-f]{40,64}$" }),
          reason: NonEmptyStringSchema,
          error: Type.Optional(NonEmptyStringSchema),
        },
        { additionalProperties: false },
      ),
    ),
    sessionFile: Type.Optional(NonEmptyStringSchema),
    placement: Type.Optional(AttemptPlacementSchema),
    baseRevision: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40,64}$" })),
    worker: Type.Optional(
      Type.Object(
        {
          workspaceId: NonEmptyStringSchema,
          tabId: NonEmptyStringSchema,
          paneId: NonEmptyStringSchema,
          terminalId: NonEmptyStringSchema,
          agentName: NonEmptyStringSchema,
          cwd: NonEmptyStringSchema,
          sessionFile: NonEmptyStringSchema,
        },
        { additionalProperties: false },
      ),
    ),
    resultId: Type.Optional(NonEmptyStringSchema),
    error: Type.Optional(NonEmptyStringSchema),
    attentionHistory: Type.Optional(
      Type.Array(
        Type.Object(
          { detail: NonEmptyStringSchema, at: TimestampSchema },
          { additionalProperties: false },
        ),
      ),
    ),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);
export const DeliverySchema = Type.Object(
  {
    resultId: NonEmptyStringSchema,
    state: StringEnum(["pending", "delivered"] as const),
    requestedAt: TimestampSchema,
    attemptedBy: Type.Optional(NonEmptyStringSchema),
    error: Type.Optional(NonEmptyStringSchema),
    deliveredAt: Type.Optional(TimestampSchema),
    failureHistory: Type.Optional(
      Type.Array(
        Type.Object(
          { at: TimestampSchema, detail: NonEmptyStringSchema },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);
export const CompletionAccountingSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("unresolved_assignment"),
      assignmentId: NonEmptyStringSchema,
      reason: NonEmptyStringSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("unresolved_attempt"),
      attemptId: NonEmptyStringSchema,
      reason: NonEmptyStringSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("unresolved_result"),
      resultId: NonEmptyStringSchema,
      reason: NonEmptyStringSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("undelivered_result"),
      resultId: NonEmptyStringSchema,
      reason: NonEmptyStringSchema,
    },
    { additionalProperties: false },
  ),
]);
export const CompletionSchema = Type.Object(
  {
    conclusion: NonEmptyStringSchema,
    evidence: Type.Array(EvidenceSchema, { minItems: 1 }),
    limitations: Type.Array(NonEmptyStringSchema),
    accounting: Type.Array(CompletionAccountingSchema),
    completedAt: TimestampSchema,
  },
  { additionalProperties: false },
);
export const RetainedTerminalEnvelopeSchema = Type.Object(
  {
    format: Type.Literal(WORKSTREAM_FORMAT),
    version: Type.Union([
      Type.Literal(1),
      Type.Literal(2),
      Type.Literal(3),
      Type.Literal(4),
      Type.Literal(5),
      Type.Literal(6),
      Type.Literal(WORKSTREAM_STATE_VERSION),
    ]),
    revision: Type.Integer({ minimum: 0 }),
    id: NonEmptyStringSchema,
    gitCommonDir: NonEmptyStringSchema,
    statePath: NonEmptyStringSchema,
    lifecycle: Type.Object(
      {
        state: StringEnum(["completed", "abandoned", "archived"] as const),
        changedAt: TimestampSchema,
        reason: NonEmptyStringSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: true },
);

export const WorkstreamStateSchema = Type.Object(
  {
    format: Type.Literal(WORKSTREAM_FORMAT),
    version: Type.Literal(WORKSTREAM_STATE_VERSION),
    revision: Type.Integer({ minimum: 0 }),
    id: NonEmptyStringSchema,
    purpose: NonEmptyStringSchema,
    projectRoot: NonEmptyStringSchema,
    gitCommonDir: NonEmptyStringSchema,
    statePath: NonEmptyStringSchema,
    coordinator: SessionIdentitySchema,
    lifecycle: LifecycleSchema,
    inputs: Type.Array(HumanInputReceiptSchema),
    intents: Type.Array(IntentSchema, { minItems: 1 }),
    assignments: Type.Array(AssignmentSchema),
    results: Type.Array(ResultSchema),
    attempts: Type.Array(AttemptSchema),
    deliveries: Type.Array(DeliverySchema),
    completion: Type.Optional(CompletionSchema),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export type SessionIdentity = Static<typeof SessionIdentitySchema>;
export type HumanInputSource = "interactive" | "rpc" | "extension";
export type HumanInputReceipt = Static<typeof HumanInputReceiptSchema>;
export type Intent = Static<typeof IntentSchema>;
export type AuthorityReference = Static<typeof AuthorityReferenceSchema>;
export type ResultSubject = Static<typeof ResultSubjectSchema>;
export type WorkAssignment = Static<typeof AssignmentSchema>;
export type RetainedArtifact = Static<typeof ArtifactSchema>;
export type WorkResult = Static<typeof ResultSchema>;
export type WorkAttempt = Static<typeof AttemptSchema>;
export type ResultDelivery = Static<typeof DeliverySchema>;
export type CompletionAccounting = Static<typeof CompletionAccountingSchema>;
export type WorkstreamState = Static<typeof WorkstreamStateSchema>;
export type WorkstreamReattachmentInspection =
  | { kind: "current"; state: WorkstreamState }
  | {
      kind: "retained_terminal";
      id: string;
      lifecycle: Static<typeof RetainedTerminalEnvelopeSchema>["lifecycle"];
    };

export class InvalidWorkstreamStateError extends Data.TaggedError("InvalidWorkstreamStateError")<{
  readonly code: "invalid_workstream_state";
  readonly message: string;
}> {
  constructor(message: string) {
    super({ code: "invalid_workstream_state", message });
  }
}

export class WorkstreamStoreOperationError extends Data.TaggedError(
  "WorkstreamStoreOperationError",
)<{
  readonly code: "workstream_store_operation_failed";
  readonly message: string;
  /** Original rejection retained as an opaque cause for inspection and recovery. */
  readonly cause: unknown;
}> {}

export class UnsupportedWorkstreamStateError extends Data.TaggedError(
  "UnsupportedWorkstreamStateError",
)<{
  readonly code: "unsupported_workstream_state";
  readonly format: unknown;
  readonly version: unknown;
  readonly message: string;
}> {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Public compatibility retains raw format/version metadata from the persisted JSON boundary.
  constructor(format: unknown, version: unknown) {
    super({
      code: "unsupported_workstream_state",
      format,
      version,
      message: `Unsupported workstream state ${describeHeaderValue(format)} version ${describeHeaderValue(version)}.`,
    });
  }
}

const DiagnosticStringSchema = Type.String();
const DiagnosticScalarSchema = Type.Union([Type.Number(), Type.Boolean()]);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This formatter receives only persisted header metadata and emits bounded diagnostics.
function describeHeaderValue(value: unknown): string {
  if (Value.Check(DiagnosticStringSchema, value)) return JSON.stringify(value.slice(0, 80));
  if (Value.Check(DiagnosticScalarSchema, value)) return String(value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return "[non-scalar]";
}
