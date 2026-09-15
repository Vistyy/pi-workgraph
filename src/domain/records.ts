import { type Static, Type } from "typebox";
import { ModelTargetSchema } from "./model-target.js";
import { WorkerReportSchema } from "./report.js";

const Text = Type.String({ minLength: 1 });

const NonBlankText = Type.String({ minLength: 1, pattern: "\\S" });

const strict = <const Fields extends Parameters<typeof Type.Object>[0]>(fields: Fields) =>
  Type.Object(fields, { additionalProperties: false });

export const CommitSchema = Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" });

export const TaskIdSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$",
});

const TaskTargetSchema = Type.Union([
  strict({ kind: Type.Literal("directory"), path: Text }),
  strict({ kind: Type.Literal("repository"), checkoutRoot: Text, commonDir: Text }),
]);

export const ReviewSubjectSchema = Type.Union([
  strict({ kind: Type.Literal("attempt"), attemptId: Text }),
  strict({
    kind: Type.Literal("comparison"),
    attemptIds: Type.Array(Text, { minItems: 2 }),
  }),
  strict({ kind: Type.Literal("revision"), revision: CommitSchema }),
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
  strict({ kind: Type.Literal("repository"), baseCommit: CommitSchema }),
]);

const CandidateOfSchema = Type.Union([
  strict({ kind: Type.Literal("extend"), attemptId: Text }),
  strict({ kind: Type.Literal("integrate"), attemptId: Text, sourceTip: CommitSchema }),
]);

const AttemptLineageSchema = strict({
  candidateRoot: CommitSchema,
  candidateOf: Type.Optional(CandidateOfSchema),
});

export const AttemptSpecSchema = strict({
  selection: AttemptSelectionSchema,
  base: AttemptBaseSchema,
  lineage: Type.Optional(AttemptLineageSchema),
});

export const WorkerStateSchema = strict({
  sessionFile: Text,
  workspaceId: NonBlankText,
  tab: Type.Optional(
    Type.Union([
      strict({ state: Type.Literal("uncertain") }),
      strict({ state: Type.Literal("ready"), tabId: Text, paneId: Text }),
    ]),
  ),
  agent: Type.Optional(Type.Union([Type.Literal("uncertain"), Type.Literal("ready")])),
  kickoff: Type.Optional(Type.Union([Type.Literal("uncertain"), Type.Literal("confirmed")])),
  closing: Type.Optional(
    Type.Union([
      strict({ kind: Type.Literal("settled") }),
      strict({ kind: Type.Literal("cancelled"), reason: NonBlankText }),
    ]),
  ),
  closed: Type.Optional(Type.Literal(true)),
});

export const AttemptOutputSchema = Type.Union([
  strict({ kind: Type.Literal("retained"), tip: CommitSchema, reason: NonBlankText }),
  strict({
    kind: Type.Literal("applying"),
    sourceRoot: CommitSchema,
    sourceTip: CommitSchema,
    destinationRef: Text,
    destinationHead: CommitSchema,
    replanned: Type.Optional(Type.Literal(true)),
  }),
  strict({
    kind: Type.Literal("discarding"),
    tip: CommitSchema,
    reason: NonBlankText,
    applied: Type.Optional(strict({ revision: CommitSchema })),
  }),
  strict({ kind: Type.Literal("no_output") }),
  strict({
    kind: Type.Literal("applied"),
    revision: CommitSchema,
    cleanupTip: Type.Optional(CommitSchema),
    cleanupReason: Type.Optional(NonBlankText),
  }),
  strict({ kind: Type.Literal("discarded"), reason: NonBlankText }),
]);

const OutcomeResultSchema = Type.Union([
  strict({ kind: Type.Literal("reported"), report: WorkerReportSchema }),
  strict({ kind: Type.Literal("unreported"), reason: NonBlankText }),
  strict({ kind: Type.Literal("cancelled"), reason: NonBlankText }),
]);

export const OutcomeSchema = strict({
  result: OutcomeResultSchema,
  effectiveModels: Type.Array(ModelTargetSchema, { uniqueItems: true }),
});

const CoordinatorCheckoutStateSchema = Type.Union([
  strict({ kind: Type.Literal("placing") }),
  strict({ kind: Type.Literal("ready") }),
  strict({
    kind: Type.Literal("applying"),
    sourceTip: CommitSchema,
    destinationRef: Text,
    destinationHead: CommitSchema,
    replanned: Type.Optional(Type.Literal(true)),
  }),
  strict({
    kind: Type.Literal("applied"),
    sourceTip: CommitSchema,
    revision: CommitSchema,
  }),
  strict({
    kind: Type.Literal("discarding"),
    sourceTip: CommitSchema,
    reason: NonBlankText,
  }),
]);

export const CoordinatorCheckoutSchema = strict({
  checkoutId: TaskIdSchema,
  target: strict({ kind: Type.Literal("repository"), checkoutRoot: Text, commonDir: Text }),
  managedPath: Text,
  branchRef: Text,
  baseCommit: CommitSchema,
  destinationRef: Text,
  state: CoordinatorCheckoutStateSchema,
});

export type TaskTarget = Static<typeof TaskTargetSchema>;

export type TaskContract = Static<typeof TaskContractSchema>;

export type Task = Static<typeof TaskSchema>;

export type AttemptSelection = Static<typeof AttemptSelectionSchema>;

export type AttemptSpec = Static<typeof AttemptSpecSchema>;

export type WorkerState = Static<typeof WorkerStateSchema>;

export type AttemptOutput = Static<typeof AttemptOutputSchema>;

export type Outcome = Static<typeof OutcomeSchema>;

export type CoordinatorCheckout = Static<typeof CoordinatorCheckoutSchema>;

export interface TaskRecord {
  readonly id: string;
  readonly task: Task;
}

export interface AttemptRecord {
  readonly id: string;
  readonly taskId: string;
  readonly spec: AttemptSpec;
  readonly worker?: WorkerState;
  readonly output?: AttemptOutput;
  readonly outcome?: Outcome;
}
