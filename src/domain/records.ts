import { type Static, Type } from "typebox";
import { ModelTargetSchema } from "./model-target.js";
import { WorkerReportSchema } from "./report.js";

export const WORKSTREAM_FORMAT = "pi-workgraph-workstream" as const;
export const WORKSTREAM_SCHEMA_VERSION = 1 as const;

const Text = Type.String({ minLength: 1 });
const NonBlankText = Type.String({ minLength: 1, pattern: "\\S" });
const Instant = Type.String({ format: "date-time" });
const Commit = Type.String({ pattern: "^[0-9a-f]{40,64}$" });
export const TaskIdSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$",
});
const strict = <const Fields extends Parameters<typeof Type.Object>[0]>(fields: Fields) =>
  Type.Object(fields, { additionalProperties: false });

export const CoordinatorOwnerSchema = strict({
  sessionId: Text,
  sessionFile: Text,
  workspaceId: Text,
  tabId: Text,
});
const CompletionSchema = strict({
  conclusion: NonBlankText,
  evidence: Type.Array(Text),
  limitations: Type.Array(Text),
  completedAt: Instant,
});
export const WorkstreamMetadataSchema = strict({
  format: Type.Literal(WORKSTREAM_FORMAT),
  schemaVersion: Type.Literal(WORKSTREAM_SCHEMA_VERSION),
  id: Text,
  owner: CoordinatorOwnerSchema,
  lifecycle: Type.Union([Type.Literal("active"), Type.Literal("completed")]),
  completion: Type.Optional(CompletionSchema),
  createdAt: Instant,
  updatedAt: Instant,
});

const HumanIntentAuthoritySchema = strict({ receiptId: Text, sessionId: Text, sessionFile: Text });
const IntentAuthoritySchema = Type.Union([
  HumanIntentAuthoritySchema,
  strict({
    grantId: Text,
    rootHumanReceipt: HumanIntentAuthoritySchema,
    parentCoordinator: CoordinatorOwnerSchema,
    parentWorkstreamId: Text,
    parentIntentIndex: Type.Integer({ minimum: 0 }),
  }),
]);
export const IntentSchema = strict({
  statement: NonBlankText,
  constraints: Type.Array(Text),
  authority: IntentAuthoritySchema,
  recordedAt: Instant,
});

const TaskTargetSchema = Type.Union([
  strict({ kind: Type.Literal("directory"), path: Text }),
  strict({ kind: Type.Literal("repository"), checkoutRoot: Text, commonDir: Text }),
]);
const ReviewSubjectSchema = Type.Union([
  strict({ kind: Type.Literal("outcome"), outcomeId: Text }),
  strict({ kind: Type.Literal("comparison"), outcomeIds: Type.Array(Text, { minItems: 2 }) }),
  strict({ kind: Type.Literal("revision"), revision: Commit }),
]);
const TaskContractSchema = Type.Union([
  strict({
    kind: Type.Literal("research"),
    question: NonBlankText,
    expectedEvidence: Type.Array(Text, { minItems: 1 }),
  }),
  strict({
    kind: Type.Literal("experiment"),
    question: NonBlankText,
    expectedEvidence: Type.Array(Text, { minItems: 1 }),
    permittedEffects: Type.Array(Text, { minItems: 1 }),
    stopCondition: NonBlankText,
  }),
  strict({
    kind: Type.Literal("consultation"),
    question: NonBlankText,
    context: Type.Optional(Type.String({ maxLength: 20_000 })),
  }),
  strict({
    kind: Type.Literal("implementation"),
    objective: NonBlankText,
    acceptance: Type.Array(Text, { minItems: 1 }),
  }),
  strict({
    kind: Type.Literal("review"),
    objective: NonBlankText,
    concern: NonBlankText,
    subject: ReviewSubjectSchema,
  }),
]);
export const TaskSchema = strict({
  target: TaskTargetSchema,
  contract: TaskContractSchema,
  createdAt: Instant,
});

const AttemptSelectionSchema = Type.Union([
  strict({ kind: Type.Literal("target"), target: ModelTargetSchema }),
  strict({
    kind: Type.Literal("implementation"),
    guide: ModelTargetSchema,
    executor: ModelTargetSchema,
  }),
]);
const AttemptBaseSchema = Type.Union([
  strict({ kind: Type.Literal("directory") }),
  strict({ kind: Type.Literal("repository"), baseCommit: Commit }),
]);
const CandidateOfSchema = Type.Union([
  strict({ kind: Type.Literal("extend"), attemptId: Text }),
  strict({ kind: Type.Literal("integrate"), attemptId: Text, sourceTip: Commit }),
]);
const AttemptLineageSchema = strict({
  candidateRoot: Commit,
  candidateOf: Type.Optional(CandidateOfSchema),
});
const AttemptExecutionSchema = strict({
  sessionFile: Type.Optional(Text),
  submission: Type.Union([
    Type.Literal("absent"),
    Type.Literal("uncertain"),
    Type.Literal("confirmed"),
  ]),
  cancellation: Type.Optional(
    strict({
      reason: NonBlankText,
      requestedAt: Instant,
    }),
  ),
  closedAt: Type.Optional(Instant),
});
const AttemptOutputSchema = Type.Union([
  strict({ kind: Type.Literal("retained"), tip: Commit, reason: NonBlankText }),
  strict({
    kind: Type.Literal("applying"),
    sourceRoot: Commit,
    sourceTip: Commit,
    destinationRef: Text,
    destinationHead: Commit,
    replanned: Type.Optional(Type.Literal(true)),
  }),
  strict({
    kind: Type.Literal("discarding"),
    tip: Commit,
    reason: NonBlankText,
    applied: Type.Optional(strict({ revision: Commit, completedAt: Instant })),
  }),
  strict({ kind: Type.Literal("no_output"), completedAt: Instant }),
  strict({
    kind: Type.Literal("applied"),
    revision: Commit,
    completedAt: Instant,
    cleanupTip: Type.Optional(Commit),
    cleanupReason: Type.Optional(NonBlankText),
  }),
  strict({ kind: Type.Literal("discarded"), reason: NonBlankText, completedAt: Instant }),
]);
export const AttemptSchema = strict({
  selection: AttemptSelectionSchema,
  base: AttemptBaseSchema,
  lineage: Type.Optional(AttemptLineageSchema),
  execution: Type.Optional(AttemptExecutionSchema),
  output: Type.Optional(AttemptOutputSchema),
});

const OutcomeResultSchema = Type.Union([
  strict({ kind: Type.Literal("reported"), report: WorkerReportSchema }),
  strict({ kind: Type.Literal("unreported"), reason: NonBlankText }),
  strict({ kind: Type.Literal("cancelled"), reason: NonBlankText }),
]);
export const OutcomeDeliverySchema = strict({
  requestedAt: Instant,
  failures: Type.Array(strict({ at: Instant, detail: NonBlankText })),
  deliveredAt: Type.Optional(Instant),
});
export const OutcomeSchema = strict({
  result: OutcomeResultSchema,
  effectiveModels: Type.Array(ModelTargetSchema, { minItems: 1 }),
  delivery: OutcomeDeliverySchema,
  observedAt: Instant,
});

export type CoordinatorOwner = Static<typeof CoordinatorOwnerSchema>;
export type Completion = Static<typeof CompletionSchema>;
export type WorkstreamMetadata = Static<typeof WorkstreamMetadataSchema>;
export type Intent = Static<typeof IntentSchema>;
export type TaskTarget = Static<typeof TaskTargetSchema>;
export type TaskContract = Static<typeof TaskContractSchema>;
export type Task = Static<typeof TaskSchema>;
export type AttemptSelection = Static<typeof AttemptSelectionSchema>;
export type AttemptLineage = Static<typeof AttemptLineageSchema>;
export type Attempt = Static<typeof AttemptSchema>;
export type OutcomeDelivery = Static<typeof OutcomeDeliverySchema>;
export type Outcome = Static<typeof OutcomeSchema>;

export interface IntentRecord {
  readonly index: number;
  readonly intent: Intent;
}
export interface TaskRecord {
  readonly index: number;
  readonly id: string;
  readonly intentIndex: number;
  readonly task: Task;
}
export interface AttemptRecord {
  readonly index: number;
  readonly id: string;
  readonly taskId: string;
  readonly sequence: number;
  readonly attempt: Attempt;
}
export interface OutcomeRecord {
  readonly index: number;
  readonly id: string;
  readonly attemptId: string;
  readonly outcome: Outcome;
}
