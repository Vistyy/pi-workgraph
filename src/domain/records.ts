import { type Static, Type } from "typebox";

const Text = Type.String({ minLength: 1, pattern: "\\S" });
const Instant = Type.String({ format: "date-time" });
const Commit = Type.String({ pattern: "^[0-9a-f]{40,64}$" });
const literals = <const Values extends readonly string[]>(values: Values) =>
  Type.Unsafe<Values[number]>({ type: "string", enum: [...values] });

export const HumanInputReceiptDataSchema = Type.Object(
  {
    id: Text,
    sessionId: Text,
    sessionFile: Text,
    source: literals(["interactive", "rpc"] as const),
    text: Text,
    receivedAt: Instant,
  },
  { additionalProperties: false },
);
export const CoordinatorOwnerSchema = Type.Object(
  { sessionId: Text, sessionFile: Text, tabId: Text },
  { additionalProperties: false },
);
export const WorkstreamMetadataSchema = Type.Object(
  {
    id: Text,
    purpose: Text,
    owner: CoordinatorOwnerSchema,
    lifecycle: literals(["active", "completed"] as const),
    completion: Type.Optional(
      Type.Object(
        {
          conclusion: Text,
          evidence: Type.Array(Text),
          limitations: Type.Array(Text),
          completedAt: Instant,
        },
        { additionalProperties: false },
      ),
    ),
    createdAt: Instant,
    updatedAt: Instant,
  },
  { additionalProperties: false },
);
export const IntentRecordSchema = Type.Object(
  {
    workstreamId: Text,
    index: Type.Integer({ minimum: 0 }),
    statement: Text,
    constraints: Type.Array(Text),
    authority: Type.Union([
      Type.Object(
        { receiptId: Text, sessionId: Text, sessionFile: Text },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          grantId: Text,
          parentWorkstreamId: Text,
          parentIntentIndex: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ]),
    recordedAt: Instant,
  },
  { additionalProperties: false },
);
const TaskTargetSchema = Type.Union([
  Type.Object({ kind: Type.Literal("directory"), path: Text }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal("repository"), checkoutRoot: Text, commonDir: Text },
    { additionalProperties: false },
  ),
]);
export const TaskRecordSchema = Type.Object(
  {
    id: Text,
    workstreamId: Text,
    intentIndex: Type.Integer({ minimum: 0 }),
    kind: literals(["research", "consultation", "implementation", "review", "experiment"] as const),
    objective: Text,
    target: TaskTargetSchema,
    contract: Type.Record(Type.String(), Type.Unknown()),
    createdAt: Instant,
  },
  { additionalProperties: false },
);
const WorkerSchema = Type.Object(
  {
    sessionFile: Text,
    paneId: Type.Optional(Text),
    tabId: Type.Optional(Text),
    terminalId: Type.Optional(Text),
    submission: literals(["absent", "uncertain", "confirmed"] as const),
    cancellation: Type.Optional(
      Type.Object({ reason: Text, requestedAt: Instant }, { additionalProperties: false }),
    ),
    closedAt: Type.Optional(Instant),
  },
  { additionalProperties: false },
);
const RepositoryAttemptSchema = Type.Object(
  {
    checkoutRoot: Text,
    commonDir: Text,
    baseRevision: Commit,
    candidateRevision: Type.Optional(Commit),
    worktreePath: Text,
    outputRef: Text,
    output: Type.Optional(
      literals(["unchanged", "retained", "dirty", "applied", "discarded", "blocked"] as const),
    ),
    application: Type.Optional(
      Type.Object(
        {
          expectedRef: Text,
          expectedHead: Commit,
          expectedResult: Commit,
          replanCount: Type.Integer({ minimum: 0, maximum: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    experiment: Type.Boolean(),
  },
  { additionalProperties: false },
);
export const AttemptRecordSchema = Type.Object(
  {
    id: Text,
    workstreamId: Text,
    taskId: Text,
    sequence: Type.Integer({ minimum: 0 }),
    createdAt: Instant,
    models: Type.Array(
      Type.Object(
        { role: Text, model: Text, thinking: Type.Optional(Text) },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    lineage: Type.Optional(
      Type.Object(
        {
          kind: literals(["extend", "integrate"] as const),
          parentAttemptId: Text,
          parentCommit: Commit,
        },
        { additionalProperties: false },
      ),
    ),
    worker: Type.Optional(WorkerSchema),
    repository: Type.Optional(RepositoryAttemptSchema),
  },
  { additionalProperties: false },
);
export const OutcomeRecordSchema = Type.Object(
  {
    id: Text,
    workstreamId: Text,
    attemptId: Text,
    kind: literals(["reported", "failed", "cancelled"] as const),
    result: Type.Record(Type.String(), Type.Unknown()),
    observedAt: Instant,
    delivery: Type.Object(
      {
        state: literals(["pending", "delivered"] as const),
        attempts: Type.Integer({ minimum: 0 }),
        deliveredAt: Type.Optional(Instant),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type HumanInputReceiptData = Static<typeof HumanInputReceiptDataSchema>;
export type CoordinatorOwner = Static<typeof CoordinatorOwnerSchema>;
export type WorkstreamMetadata = Static<typeof WorkstreamMetadataSchema>;
export type IntentRecord = Static<typeof IntentRecordSchema>;
export type TaskTarget = Static<typeof TaskTargetSchema>;
export type TaskRecord = Static<typeof TaskRecordSchema>;
export type AttemptRecord = Static<typeof AttemptRecordSchema>;
export type OutcomeRecord = Static<typeof OutcomeRecordSchema>;
