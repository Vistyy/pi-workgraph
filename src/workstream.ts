import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { ModelTargetSchema } from "./model-policy.js";
import { EvidenceSchema, WorkerReportSchema } from "./report-schema.js";

export const WORKSTREAM_STATE_VERSION = 4 as const;
const WORKSTREAM_FORMAT = "pi-workgraph-workstream" as const;

const NonEmptyStringSchema = Type.String({ minLength: 1 });
const TimestampSchema = Type.String({ minLength: 1 });
const SessionIdentitySchema = Type.Object(
  {
    sessionId: NonEmptyStringSchema,
    sessionFile: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);
const LifecycleSchema = Type.Object(
  {
    state: StringEnum([
      "active",
      "suspended",
      "completed",
      "abandoned",
      "archived",
    ] as const),
    changedAt: TimestampSchema,
    reason: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);
const HumanInputReceiptSchema = Type.Object(
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
const IntentSchema = Type.Object(
  {
    version: Type.Integer({ minimum: 0 }),
    statement: NonEmptyStringSchema,
    constraints: Type.Array(NonEmptyStringSchema),
    authorityReceiptIds: Type.Array(NonEmptyStringSchema),
    recordedAt: TimestampSchema,
  },
  { additionalProperties: false },
);
const AuthorityReferenceSchema = Type.Object(
  {
    receiptId: NonEmptyStringSchema,
    intentVersion: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
const ArtifactPolicySchema = Type.Object(
  {
    retain: Type.Array(NonEmptyStringSchema),
    discardOthers: Type.Literal(true),
  },
  { additionalProperties: false },
);
const ResultSubjectSchema = Type.Union([
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
    artifactPolicy: ArtifactPolicySchema,
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
const AssignmentSchema = Type.Union([
  ResearchAssignmentSchema,
  ExperimentAssignmentSchema,
  ImplementationAssignmentSchema,
  ReviewAssignmentSchema,
]);
const ArtifactSchema = Type.Object(
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
  /** Stable UUID retained for recovery and compatibility; semantic ids are the normal handle. */
  uuidAlias: Type.Optional(NonEmptyStringSchema),
  assignmentId: NonEmptyStringSchema,
  assignmentIntentVersion: Type.Integer({ minimum: 0 }),
  artifacts: Type.Array(ArtifactSchema),
  observedAt: TimestampSchema,
};
const ResultSchema = Type.Union([
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
const DispositionSchema = Type.Object(
  {
    resultId: NonEmptyStringSchema,
    status: StringEnum(["accepted", "rejected", "needs_followup"] as const),
    reason: NonEmptyStringSchema,
    recordedAt: TimestampSchema,
  },
  { additionalProperties: false },
);
const SelectionReceiptSchema = Type.Object(
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
const ModelsSchema = Type.Object(
  {
    guide: ModelTargetSchema,
    executor: Type.Optional(ModelTargetSchema),
    source: StringEnum(["policy", "override"] as const),
    overrideReason: Type.Optional(NonEmptyStringSchema),
    selection: Type.Optional(SelectionReceiptSchema),
  },
  { additionalProperties: false },
);
const ResourceSchema = Type.Object(
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
const AttemptPlacementSchema = Type.Union([
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
const AttemptSchema = Type.Object(
  {
    id: NonEmptyStringSchema,
    /** Stable UUID retained for recovery and compatibility; semantic ids are the normal handle. */
    uuidAlias: Type.Optional(NonEmptyStringSchema),
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
            source: Type.Optional(
              StringEnum(["selection", "message"] as const),
            ),
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
    composition: Type.Optional(
      Type.Object(
        {
          state: StringEnum([
            "pending",
            "composed",
            "blocked",
            "retained_not_applied",
          ] as const),
          commit: NonEmptyStringSchema,
          expectedHead: NonEmptyStringSchema,
          revision: Type.Optional(NonEmptyStringSchema),
          error: Type.Optional(NonEmptyStringSchema),
          reason: Type.Optional(NonEmptyStringSchema),
          retainedRef: Type.Optional(NonEmptyStringSchema),
          integratedRevision: Type.Optional(NonEmptyStringSchema),
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
          discard: Type.Boolean(),
          error: Type.Optional(NonEmptyStringSchema),
        },
        { additionalProperties: false },
      ),
    ),
    sessionFile: Type.Optional(NonEmptyStringSchema),
    placement: Type.Optional(AttemptPlacementSchema),
    /** @deprecated Derived only for isolated placement compatibility views. */
    worktreePath: Type.Optional(NonEmptyStringSchema),
    /** @deprecated Derived only for isolated placement compatibility views. */
    branch: Type.Optional(NonEmptyStringSchema),
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
const DeliverySchema = Type.Object(
  {
    resultId: NonEmptyStringSchema,
    state: StringEnum(["pending", "delivered", "acknowledged"] as const),
    requestedAt: TimestampSchema,
    attemptedBy: Type.Optional(NonEmptyStringSchema),
    error: Type.Optional(NonEmptyStringSchema),
    deliveredAt: Type.Optional(TimestampSchema),
    acknowledgedAt: Type.Optional(TimestampSchema),
    acknowledgment: Type.Optional(NonEmptyStringSchema),
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
const CompletionAccountingSchema = Type.Union([
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
const CompletionSchema = Type.Object(
  {
    conclusion: NonEmptyStringSchema,
    evidence: Type.Array(EvidenceSchema, { minItems: 1 }),
    limitations: Type.Array(NonEmptyStringSchema),
    accounting: Type.Array(CompletionAccountingSchema),
    completedAt: TimestampSchema,
  },
  { additionalProperties: false },
);
const RetainedTerminalEnvelopeSchema = Type.Object(
  {
    format: Type.Literal(WORKSTREAM_FORMAT),
    version: Type.Union([
      Type.Literal(1),
      Type.Literal(2),
      Type.Literal(3),
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
    dispositions: Type.Array(DispositionSchema),
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
export type ResultDisposition = Static<typeof DispositionSchema>;
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

type OmitEach<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type AssignmentInput = OmitEach<WorkAssignment, "createdAt">;
type ResultInput = OmitEach<WorkResult, "observedAt" | "artifacts"> & {
  artifacts?: RetainedArtifact[];
};

export class InvalidWorkstreamStateError extends Error {
  readonly code = "invalid_workstream_state";

  constructor(message: string) {
    super(message);
    this.name = "InvalidWorkstreamStateError";
  }
}

export class UnsupportedWorkstreamStateError extends Error {
  readonly code = "unsupported_workstream_state";

  constructor(
    readonly format: unknown,
    readonly version: unknown,
  ) {
    super(
      `Unsupported workstream state ${String(format)} version ${String(version)}.`,
    );
    this.name = "UnsupportedWorkstreamStateError";
  }
}

export class WorkstreamStore {
  private queue: Promise<unknown> = Promise.resolve();

  private mutationGuard: (() => void) | undefined;

  private constructor(
    readonly path: string,
    private owner: SessionIdentity,
  ) {}

  bindMutationGuard(guard: () => void): void {
    this.mutationGuard = guard;
  }

  async adopt(owner: SessionIdentity): Promise<WorkstreamState> {
    validateSession(owner);
    const state = await this.update(
      (draft) => {
        draft.coordinator = { ...owner };
      },
      undefined,
      ["active", "suspended"],
    );
    this.owner = { ...owner };
    return state;
  }

  static pathFor(gitCommonDir: string, id: string): string {
    validateId(id, "Workstream id");
    return join(
      resolve(gitCommonDir),
      "pi-workgraph",
      "workstreams",
      id,
      "workstream.json",
    );
  }

  static async create(input: {
    id: string;
    purpose: string;
    projectRoot: string;
    gitCommonDir: string;
    coordinator: SessionIdentity;
    now?: Date;
  }): Promise<{ store: WorkstreamStore; state: WorkstreamState }> {
    validateId(input.id, "Workstream id");
    requireText(input.purpose, "Workstream purpose");
    requireText(input.projectRoot, "Project root");
    requireText(input.gitCommonDir, "Git common directory");
    validateSession(input.coordinator);
    const path = WorkstreamStore.pathFor(input.gitCommonDir, input.id);
    await mkdir(dirname(dirname(path)), { recursive: true });
    await mkdir(dirname(path));
    const now = (input.now ?? new Date()).toISOString();
    const state: WorkstreamState = {
      format: WORKSTREAM_FORMAT,
      version: WORKSTREAM_STATE_VERSION,
      revision: 0,
      id: input.id,
      purpose: input.purpose.trim(),
      projectRoot: input.projectRoot,
      gitCommonDir: input.gitCommonDir,
      statePath: path,
      coordinator: { ...input.coordinator },
      lifecycle: {
        state: "active",
        changedAt: now,
        reason: "Workstream created.",
      },
      inputs: [],
      intents: [
        {
          version: 0,
          statement: input.purpose.trim(),
          constraints: [],
          authorityReceiptIds: [],
          recordedAt: now,
        },
      ],
      assignments: [],
      results: [],
      dispositions: [],
      attempts: [],
      deliveries: [],
      createdAt: now,
      updatedAt: now,
    };
    const store = new WorkstreamStore(path, input.coordinator);
    try {
      await store.write(state);
    } catch (error) {
      await rm(dirname(path), { recursive: true, force: true });
      throw error;
    }
    return { store, state: structuredClone(state) };
  }

  static open(path: string, owner: SessionIdentity): WorkstreamStore {
    validateSession(owner);
    return new WorkstreamStore(resolve(path), owner);
  }

  static async inspect(path: string): Promise<WorkstreamState> {
    return readState(resolve(path));
  }

  /**
   * Read a startup pointer without writes or ownership changes.
   * A canonical terminal envelope from a known workstream version may be retained
   * without applying the current mutable schema or adopting its ownership.
   */
  static async inspectForReattachment(
    path: string,
  ): Promise<WorkstreamReattachmentInspection> {
    const resolvedPath = resolve(path);
    const value = await readStateValue(resolvedPath);
    if (
      value.format === WORKSTREAM_FORMAT &&
      value.version === WORKSTREAM_STATE_VERSION
    ) {
      try {
        validateState(value);
        validateStoredPath(value, resolvedPath);
        return { kind: "current", state: structuredClone(value) };
      } catch (error) {
        const retained = retainedTerminalInspection(value, resolvedPath);
        if (retained) return retained;
        throw error;
      }
    }
    if (
      value.format === WORKSTREAM_FORMAT &&
      isKnownHistoricalWorkstreamVersion(value.version)
    ) {
      const retained = retainedTerminalInspection(value, resolvedPath);
      if (retained) return retained;
      if (
        isRecord(value.lifecycle) &&
        ["active", "suspended"].includes(String(value.lifecycle.state))
      )
        throw new UnsupportedWorkstreamStateError(value.format, value.version);
      throw new InvalidWorkstreamStateError(
        `Historical workstream state version ${value.version} cannot be classified as canonical terminal history.`,
      );
    }
    throw new UnsupportedWorkstreamStateError(value.format, value.version);
  }

  async load(): Promise<WorkstreamState> {
    const state = await readState(this.path);
    this.assertOwner(state);
    return state;
  }

  async recordInputEvent(input: {
    id?: string;
    sessionId: string;
    sessionFile: string;
    source: HumanInputSource;
    text: string;
    now?: Date;
  }): Promise<{ state: WorkstreamState; receipt: HumanInputReceipt }> {
    if (input.source === "extension")
      throw new Error(
        "Extension-generated input cannot create human authority.",
      );
    const source: HumanInputReceipt["source"] = input.source;
    validateSession(input);
    requireText(input.text, "Human input");
    let receipt: HumanInputReceipt | undefined;
    const state = await this.update(
      (draft, now) => {
        if (
          input.sessionId !== this.owner.sessionId ||
          input.sessionFile !== this.owner.sessionFile
        )
          throw new Error("Input receipt belongs to another session.");
        const previous = input.id
          ? draft.inputs.find((item) => item.id === input.id)
          : undefined;
        if (previous) {
          if (
            previous.text !== input.text.trim() ||
            previous.source !== source ||
            previous.sessionId !== input.sessionId
          )
            throw new Error("Conflicting input receipt.");
          receipt = previous;
          return;
        }
        receipt = {
          id: input.id ?? randomUUID(),
          sessionId: input.sessionId,
          sessionFile: input.sessionFile,
          source,
          text: input.text.trim(),
          receivedAt: (input.now ?? now).toISOString(),
        };
        const recorded = receipt;
        if (!recorded) throw new Error("Human input receipt was not recorded.");
        draft.inputs.push(recorded);
      },
      input.now,
      ["active", "suspended"],
    );
    if (!receipt) throw new Error("Human input receipt was not recorded.");
    return { state, receipt };
  }

  async setLifecycle(input: {
    state: "active" | "suspended" | "abandoned" | "archived";
    reason: string;
    now?: Date;
  }): Promise<WorkstreamState> {
    requireText(input.reason, "Lifecycle reason");
    return this.update(
      (draft, now) => {
        const from = draft.lifecycle.state;
        const allowed =
          from === "active"
            ? ["suspended", "abandoned", "archived"]
            : from === "suspended"
              ? ["active", "abandoned", "archived"]
              : [];
        if (!allowed.includes(input.state))
          throw new Error(
            `Cannot transition workstream lifecycle from ${from} to ${input.state}.`,
          );
        draft.lifecycle = {
          state: input.state,
          changedAt: (input.now ?? now).toISOString(),
          reason: input.reason.trim(),
        };
      },
      input.now,
      ["active", "suspended"],
    );
  }

  async reviseIntent(input: {
    authorityReceiptId: string;
    statement: string;
    constraints: string[];
    now?: Date;
  }): Promise<WorkstreamState> {
    requireText(input.statement, "Intent statement");
    requireTexts(input.constraints, "Intent constraints");
    return this.update((draft, now) => {
      requireReceipt(draft, input.authorityReceiptId);
      const current = currentIntent(draft);
      draft.intents.push({
        version: current.version + 1,
        statement: input.statement.trim(),
        constraints: input.constraints.map((item) => item.trim()),
        authorityReceiptIds: [input.authorityReceiptId],
        recordedAt: (input.now ?? now).toISOString(),
      });
    }, input.now);
  }

  async assign(
    input: AssignmentInput & { now?: Date },
  ): Promise<WorkstreamState> {
    return this.update(
      (draft, now) => addAssignment(draft, input, now),
      input.now,
    );
  }

  async enqueue(
    input: AssignmentInput,
    attempts:
      | {
          id: string;
          uuidAlias?: string;
          models: NonNullable<WorkAttempt["models"]>;
          continuationOf?: string;
          baseRevision?: string;
        }
      | Array<{
          id: string;
          uuidAlias?: string;
          models: NonNullable<WorkAttempt["models"]>;
          continuationOf?: string;
          baseRevision?: string;
        }>,
  ): Promise<WorkstreamState> {
    return this.update((draft, now) => {
      addAssignment(draft, input, now);
      const entries = Array.isArray(attempts) ? attempts : [attempts];
      if (entries.length === 0)
        throw new Error("At least one attempt is required.");
      for (const attempt of entries) {
        validateId(attempt.id, "Attempt id");
        if (draft.attempts.some((item) => item.id === attempt.id))
          throw new Error("Duplicate attempt.");
        if (
          attempt.continuationOf &&
          !draft.attempts.some(
            (item) =>
              item.id === attempt.continuationOf &&
              item.state === "settled" &&
              item.cleanup?.state === "completed" &&
              item.sessionFile,
          )
        )
          throw new Error(
            "Continuation requires a settled, cleaned worker trajectory; retained blocked work must be inspected first.",
          );
        draft.attempts.push({
          ...attempt,
          assignmentId: input.id,
          state: "queued",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
      }
    });
  }

  async retainResult(
    input: ResultInput & { now?: Date },
  ): Promise<WorkstreamState> {
    validateId(input.id, "Result id");
    return this.update(
      (draft, now) => {
        if (draft.results.some((result) => result.id === input.id))
          throw new Error(`Duplicate result ${input.id}.`);
        const assignment = requireAssignment(draft, input.assignmentId);
        if (input.assignmentIntentVersion !== assignment.intentVersion)
          throw new Error(
            "Result intent version does not match its assignment.",
          );
        const { now: _now, artifacts = [], ...fields } = input;
        validateArtifactsForAssignment(
          assignment,
          artifacts,
          input.validity === "typed" && input.report.status === "completed"
            ? "typed"
            : "absent",
        );
        const result: unknown = {
          ...fields,
          artifacts,
          observedAt: (input.now ?? now).toISOString(),
        };
        if (!Value.Check(ResultSchema, result))
          throw new Error(
            "Result input does not satisfy its validity contract.",
          );
        draft.results.push(result);
      },
      input.now,
      ["active", "suspended"],
    );
  }

  async startAttempt(input: {
    id: string;
    placement?: Static<typeof AttemptPlacementSchema>;
    worktreePath?: string;
    branch?: string;
    baseRevision?: string;
    now?: Date;
  }): Promise<WorkstreamState> {
    const placement = input.placement ?? {
      kind: "isolated_worktree" as const,
      path: requireTextValue(input.worktreePath, "worktree"),
      branch: requireTextValue(input.branch, "branch"),
    };
    return this.changeAttempt(
      input.id,
      (attempt) => {
        if (attempt.state === "starting") {
          if (
            sameValue(attempt.placement, placement) &&
            attempt.baseRevision === input.baseRevision
          )
            return;
          throw new Error(
            `Attempt ${input.id} has contradictory launch placement.`,
          );
        }
        if (attempt.state !== "queued")
          throw new Error(`Attempt ${input.id} is not awaiting launch.`);
        attempt.state = "starting";
        attempt.placement = structuredClone(placement);
        if (placement.kind === "isolated_worktree") {
          attempt.worktreePath = placement.path;
          attempt.branch = placement.branch;
        } else {
          delete attempt.worktreePath;
          delete attempt.branch;
        }
        if (input.baseRevision) attempt.baseRevision = input.baseRevision;
        else delete attempt.baseRevision;
        attempt.submission = "not_sent";
      },
      input.now,
    );
  }

  async recordSessionFile(
    id: string,
    sessionFile: string,
    now?: Date,
  ): Promise<WorkstreamState> {
    requireText(sessionFile, "Worker session file");
    return this.changeAttempt(
      id,
      (attempt) => {
        if (attempt.sessionFile) {
          if (attempt.sessionFile === sessionFile) return;
          throw new Error(`Attempt ${id} has contradictory session identity.`);
        }
        if (attempt.state !== "starting")
          throw new Error(`Attempt ${id} is not starting.`);
        attempt.sessionFile = sessionFile;
      },
      now,
    );
  }

  async recordLaunchPane(
    id: string,
    launchPane: NonNullable<WorkAttempt["launchPane"]>,
    now?: Date,
  ): Promise<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        if (!["starting", "running"].includes(attempt.state)) {
          if (attempt.launchPane && sameValue(attempt.launchPane, launchPane))
            return;
          throw new Error(`Attempt ${id} is not accepting launch placement.`);
        }
        if (attempt.launchPane && !sameValue(attempt.launchPane, launchPane))
          throw new Error(`Attempt ${id} has contradictory launch placement.`);
        attempt.launchPane = launchPane;
      },
      now,
    );
  }

  async recordResource(
    id: string,
    resource: NonNullable<WorkAttempt["resource"]>,
    now?: Date,
  ): Promise<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        if (!["starting", "running"].includes(attempt.state)) {
          if (attempt.resource && sameValue(attempt.resource, resource)) return;
          throw new Error(`Attempt ${id} is not accepting a resource.`);
        }
        if (attempt.resource && !sameValue(attempt.resource, resource))
          throw new Error(`Attempt ${id} has contradictory resource identity.`);
        attempt.resource = resource;
      },
      now,
    );
  }

  async recordWorker(
    id: string,
    worker: NonNullable<WorkAttempt["worker"]>,
    now?: Date,
  ): Promise<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        if (attempt.worker) {
          if (sameValue(attempt.worker, worker)) return;
          throw new Error(`Attempt ${id} has contradictory worker identity.`);
        }
        if (!attempt.sessionFile)
          throw new Error("Worker identity requires a session file.");
        if (!["starting", "running"].includes(attempt.state))
          throw new Error(`Attempt ${id} is not accepting worker identity.`);
        attempt.worker = worker;
      },
      now,
    );
  }

  async markSubmission(
    id: string,
    state: NonNullable<WorkAttempt["submission"]>,
    now?: Date,
  ): Promise<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        if (!attempt.sessionFile)
          throw new Error("Submission state requires a session file.");
        const previous = attempt.submission ?? "not_sent";
        const allowed =
          (previous === "not_sent" && state === "uncertain") ||
          (previous === "uncertain" &&
            ["submitted", "started"].includes(state)) ||
          (previous === "submitted" && state === "started") ||
          previous === state;
        if (!allowed)
          throw new Error(
            `Cannot transition submission from ${previous} to ${state}.`,
          );
        attempt.submission = state;
        if (state === "submitted") attempt.state = "running";
        if (state === "started" && attempt.state === "starting")
          attempt.state = "running";
      },
      now,
    );
  }

  async settleAttempt(input: {
    id: string;
    resultId: string;
    effectiveModels: NonNullable<WorkAttempt["effectiveModels"]>;
    now?: Date;
  }): Promise<WorkstreamState> {
    return this.changeAttempt(
      input.id,
      (attempt, draft) => {
        if (!attempt.sessionFile)
          throw new Error("Settlement requires a session file.");
        if (!draft.results.some((result) => result.id === input.resultId))
          throw new Error(
            `Settlement references unknown result ${input.resultId}.`,
          );
        if (attempt.state === "settled" || attempt.state === "cancelled") {
          if (
            attempt.resultId === input.resultId &&
            sameValue(attempt.effectiveModels, input.effectiveModels)
          )
            return;
          throw new Error(`Attempt ${input.id} has an immutable settlement.`);
        }
        if (
          !["running", "starting", "cancel_requested"].includes(attempt.state)
        )
          throw new Error(`Attempt ${input.id} is not settleable.`);
        attempt.state =
          attempt.state === "cancel_requested" ? "cancelled" : "settled";
        attempt.resultId = input.resultId;
        attempt.effectiveModels = input.effectiveModels;
      },
      input.now,
    );
  }

  async recordAttention(
    id: string,
    detail: string,
    now?: Date,
  ): Promise<WorkstreamState> {
    requireText(detail, "Attention detail");
    return this.changeAttempt(
      id,
      (attempt, _draft, current) => {
        if (attempt.error === detail) return;
        attempt.error = detail;
        attempt.attentionHistory ??= [];
        attempt.attentionHistory.push({
          detail: detail.trim(),
          at: current.toISOString(),
        });
      },
      now,
    );
  }

  async clearAttention(id: string, now?: Date): Promise<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        delete attempt.error;
      },
      now,
    );
  }

  async beginComposition(input: {
    id: string;
    commit: string;
    expectedHead: string;
    now?: Date;
  }): Promise<WorkstreamState> {
    return this.changeAttempt(
      input.id,
      (attempt) => {
        if (attempt.composition) {
          if (
            attempt.composition.state === "pending" &&
            attempt.composition.commit === input.commit &&
            attempt.composition.expectedHead === input.expectedHead
          )
            return;
          throw new Error(`Composition for ${input.id} is already recorded.`);
        }
        attempt.composition = {
          state: "pending",
          commit: input.commit,
          expectedHead: input.expectedHead,
        };
      },
      input.now,
    );
  }

  async retryComposition(
    id: string,
    now?: Date,
    retainedRef?: string,
  ): Promise<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        const composition = attempt.composition;
        if (composition?.state !== "blocked")
          throw new Error(`Composition for ${id} is not blocked.`);
        attempt.composition = {
          state: "pending",
          commit: composition.commit,
          expectedHead: composition.expectedHead,
          ...((retainedRef ?? composition.retainedRef)
            ? { retainedRef: retainedRef ?? composition.retainedRef }
            : {}),
        };
      },
      now,
    );
  }

  async retainCompositionNotApplied(input: {
    id: string;
    reason: string;
    retainedRef: string;
    integratedRevision: string;
    now?: Date;
  }): Promise<WorkstreamState> {
    requireText(input.reason, "Retained-not-applied reason");
    requireText(input.retainedRef, "Retained commit ref");
    requireText(input.integratedRevision, "Integrated revision");
    return this.changeAttempt(
      input.id,
      (attempt) => {
        const composition = attempt.composition;
        if (composition?.state !== "blocked")
          throw new Error(`Composition for ${input.id} is not blocked.`);
        attempt.composition = {
          ...composition,
          state: "retained_not_applied",
          reason: input.reason.trim(),
          retainedRef: input.retainedRef.trim(),
          integratedRevision: input.integratedRevision.trim(),
        };
      },
      input.now,
    );
  }

  async finishComposition(
    id: string,
    revision: string,
    now?: Date,
  ): Promise<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        const composition = attempt.composition;
        if (composition?.state === "composed") {
          if (composition.revision === revision) return;
          throw new Error(`Composition for ${id} has an immutable revision.`);
        }
        if (composition?.state !== "pending")
          throw new Error(`Composition for ${id} is not pending.`);
        attempt.composition = { ...composition, state: "composed", revision };
      },
      now,
    );
  }

  async blockComposition(
    id: string,
    error: string,
    now?: Date,
  ): Promise<WorkstreamState> {
    requireText(error, "Composition error");
    return this.changeAttempt(
      id,
      (attempt) => {
        const composition = attempt.composition;
        if (composition?.state === "blocked") {
          if (composition.error === error.trim()) return;
          throw new Error(
            `Composition for ${id} has contradictory failure evidence.`,
          );
        }
        if (composition?.state !== "pending")
          throw new Error(`Composition for ${id} is not pending.`);
        attempt.composition = {
          ...composition,
          state: "blocked",
          error: error.trim(),
        };
      },
      now,
    );
  }

  async beginCleanup(input: {
    id: string;
    expectedHead?: string;
    discard: boolean;
    now?: Date;
  }): Promise<WorkstreamState> {
    return this.changeAttempt(
      input.id,
      (attempt) => {
        if (attempt.cleanup) {
          if (
            attempt.cleanup.state === "pending" &&
            attempt.cleanup.expectedHead === input.expectedHead &&
            attempt.cleanup.discard === input.discard
          )
            return;
          throw new Error(`Cleanup for ${input.id} is already recorded.`);
        }
        if (!attempt.placement)
          throw new Error("Cleanup requires an attempt placement.");
        if (
          attempt.placement.kind === "isolated_worktree" &&
          !input.expectedHead
        )
          throw new Error("Isolated worktree cleanup requires its exact HEAD.");
        if (attempt.placement.kind === "shared_project" && input.discard)
          throw new Error("Shared project cleanup cannot discard files.");
        attempt.cleanup = {
          state: "pending",
          ...(input.expectedHead ? { expectedHead: input.expectedHead } : {}),
          workerClosed: false,
          discard: input.discard,
        };
      },
      input.now,
    );
  }

  async markWorkerClosed(id: string, now?: Date): Promise<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        if (attempt.cleanup?.state === "completed") return;
        if (attempt.cleanup?.state !== "pending")
          throw new Error(`Cleanup for ${id} is not pending.`);
        if (attempt.cleanup.workerClosed) return;
        attempt.cleanup = { ...attempt.cleanup, workerClosed: true };
      },
      now,
    );
  }

  async retryCleanup(id: string, now?: Date): Promise<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        if (attempt.cleanup?.state !== "blocked")
          throw new Error(`Cleanup for ${id} is not blocked.`);
        const cleanup = attempt.cleanup;
        if (!cleanup) throw new Error(`Cleanup for ${id} is not blocked.`);
        attempt.cleanup = { ...cleanup, state: "pending" };
        delete attempt.cleanup.error;
      },
      now,
    );
  }

  async finishCleanup(id: string, now?: Date): Promise<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        if (attempt.cleanup?.state === "completed") return;
        if (
          attempt.cleanup?.state !== "pending" ||
          !attempt.cleanup.workerClosed
        )
          throw new Error(`Cleanup for ${id} requires a closed worker.`);
        attempt.cleanup = { ...attempt.cleanup, state: "completed" };
      },
      now,
    );
  }

  async blockCleanup(
    id: string,
    error: string,
    now?: Date,
  ): Promise<WorkstreamState> {
    requireText(error, "Cleanup error");
    return this.changeAttempt(
      id,
      (attempt) => {
        if (!attempt.cleanup)
          throw new Error(`Cleanup for ${id} is not recorded.`);
        if (attempt.cleanup.state === "completed")
          throw new Error(`Cleanup for ${id} is already completed.`);
        if (attempt.cleanup.state === "blocked") {
          if (attempt.cleanup.error === error.trim()) return;
          throw new Error(
            `Cleanup for ${id} has contradictory failure evidence.`,
          );
        }
        attempt.cleanup = {
          ...attempt.cleanup,
          state: "blocked",
          error: error.trim(),
        };
      },
      now,
    );
  }

  async recordSteering(
    id: string,
    text: string,
    state: "uncertain" | "submitted",
    now?: Date,
  ): Promise<WorkstreamState> {
    requireText(text, "Steering instruction");
    return this.changeAttempt(
      id,
      (attempt) => {
        if (!attempt.worker)
          throw new Error("Steering requires a worker identity.");
        if (state === "submitted" && attempt.steering?.state !== "uncertain")
          throw new Error(
            "Submitted steering requires an uncertain submission record.",
          );
        attempt.steering = { text: text.trim(), state };
      },
      now,
    );
  }

  async cancelAttempt(id: string, now?: Date): Promise<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        if (attempt.state === "queued") {
          attempt.state = "cancelled";
          return;
        }
        if (!["starting", "running"].includes(attempt.state))
          throw new Error(`Attempt ${id} is not active.`);
        attempt.state = "cancel_requested";
      },
      now,
    );
  }

  private async changeAttempt(
    id: string,
    mutator: (attempt: WorkAttempt, draft: WorkstreamState, now: Date) => void,
    suppliedNow?: Date,
  ): Promise<WorkstreamState> {
    return this.update(
      (draft, now) => {
        const attempt = draft.attempts.find((candidate) => candidate.id === id);
        if (!attempt) throw new Error(`Unknown attempt ${id}.`);
        mutator(attempt, draft, suppliedNow ?? now);
        attempt.updatedAt = (suppliedNow ?? now).toISOString();
      },
      suppliedNow,
      ["active", "suspended"],
    );
  }

  async requestDelivery(
    resultId: string,
    now?: Date,
  ): Promise<WorkstreamState> {
    return this.update(
      (draft, current) => {
        if (!draft.results.some((result) => result.id === resultId))
          throw new Error(`Unknown result ${resultId}.`);
        if (
          !draft.deliveries.some((delivery) => delivery.resultId === resultId)
        ) {
          draft.deliveries.push({
            resultId,
            state: "pending",
            requestedAt: (now ?? current).toISOString(),
          });
        }
      },
      now,
      ["active", "suspended"],
    );
  }

  async deliveryAttempt(
    resultId: string,
    owner: string,
    error?: string,
  ): Promise<WorkstreamState> {
    return this.update(
      (draft, now) => {
        const delivery = draft.deliveries.find(
          (item) => item.resultId === resultId,
        );
        if (!delivery) throw new Error(`Unknown delivery ${resultId}.`);
        delivery.attemptedBy = owner;
        if (error) {
          requireText(error, "Delivery failure");
          delivery.error = error.trim();
          delivery.failureHistory ??= [];
          delivery.failureHistory.push({
            at: now.toISOString(),
            detail: error.trim(),
          });
        }
      },
      undefined,
      ["active", "suspended"],
    );
  }

  async addResultArtifacts(
    resultId: string,
    artifacts: RetainedArtifact[],
  ): Promise<WorkstreamState> {
    return this.update(
      (draft) => {
        const result = draft.results.find((item) => item.id === resultId);
        if (!result) throw new Error(`Unknown result ${resultId}.`);
        if (sameValue(result.artifacts, artifacts)) return;
        if (result.artifacts.length === 0) {
          result.artifacts = artifacts;
          return;
        }
        throw new Error(
          `Result ${resultId} artifacts are immutable after retention.`,
        );
      },
      undefined,
      ["active", "suspended"],
    );
  }

  /**
   * Record accepted notification enqueue or direct result-tool presentation.
   * Pi provides no queued-follow-up presentation receipt; this shared delivery
   * state alone proves neither queued presentation nor coordinator inspection.
   */
  async markDelivered(resultId: string, now?: Date): Promise<WorkstreamState> {
    return this.update(
      (draft, current) => {
        const delivery = draft.deliveries.find(
          (candidate) => candidate.resultId === resultId,
        );
        if (!delivery)
          throw new Error(`Result ${resultId} is not pending delivery.`);
        if (delivery.state !== "pending") return;
        delivery.state = "delivered";
        delivery.deliveredAt = (now ?? current).toISOString();
        delete delivery.error;
      },
      now,
      ["active", "suspended"],
    );
  }

  async acknowledge(
    resultId: string,
    acknowledgment: string,
    now?: Date,
  ): Promise<WorkstreamState> {
    requireText(acknowledgment, "Acknowledgment");
    return this.update(
      (draft, current) => {
        const delivery = draft.deliveries.find(
          (candidate) => candidate.resultId === resultId,
        );
        if (!delivery) throw new Error(`Unknown delivery ${resultId}.`);
        if (delivery.state === "acknowledged") return;
        // Explicit receipt also covers evidence read through status after an uncertain notification.
        // Do not invent deliveredAt: notification transport and coordinator receipt are different facts.
        delivery.state = "acknowledged";
        delete delivery.error;
        delivery.acknowledgedAt = (now ?? current).toISOString();
        delivery.acknowledgment = acknowledgment.trim();
      },
      now,
      ["active", "suspended"],
    );
  }

  async disposition(input: {
    resultId: string;
    status: ResultDisposition["status"];
    reason: string;
    now?: Date;
  }): Promise<WorkstreamState> {
    requireText(input.reason, "Disposition reason");
    return this.update((draft, now) => {
      requireActive(draft);
      if (!draft.results.some((result) => result.id === input.resultId))
        throw new Error(`Unknown result ${input.resultId}.`);
      draft.dispositions.push({
        resultId: input.resultId,
        status: input.status,
        reason: input.reason.trim(),
        recordedAt: (input.now ?? now).toISOString(),
      });
    }, input.now);
  }

  async complete(input: {
    conclusion: string;
    evidence: Static<typeof EvidenceSchema>[];
    limitations: string[];
    /** One reason per unresolved semantic task; mechanical entries are derived below. */
    reasons: Array<{ taskId: string; reason: string }>;
    now?: Date;
  }): Promise<WorkstreamState> {
    requireText(input.conclusion, "Completion conclusion");
    if (
      input.evidence.length === 0 ||
      !input.evidence.every((item) => Value.Check(EvidenceSchema, item))
    )
      throw new Error("Completion requires valid evidence.");
    requireTexts(input.limitations, "Completion limitations");
    return this.update((draft, now) => {
      requireActive(draft);
      if (
        draft.attempts.some(
          (attempt) =>
            ["queued", "starting", "running", "cancel_requested"].includes(
              attempt.state,
            ) ||
            (attempt.placement && attempt.cleanup?.state !== "completed"),
        )
      ) {
        throw new Error(
          "Complete only after workers and owned resources have settled and cleaned up.",
        );
      }
      const expectedAccounting = completionAccounting(draft);
      const expectedTasks = [
        ...new Set(
          expectedAccounting
            .map((entry) => accountingTaskId(draft, entry))
            .filter((taskId): taskId is string => taskId !== undefined),
        ),
      ];
      const reasonKeys = input.reasons.map((item) => item.taskId);
      if (
        reasonKeys.length !== new Set(reasonKeys).size ||
        input.reasons.some(
          (item) =>
            !draft.assignments.some(
              (assignment) => assignment.id === item.taskId,
            ) || !item.reason.trim(),
        ) ||
        expectedTasks.some((taskId) => !reasonKeys.includes(taskId)) ||
        reasonKeys.some((taskId) => !expectedTasks.includes(taskId))
      )
        throw new Error(
          `Completion requires exactly one reason per unresolved semantic task: ${expectedTasks.join(", ") || "none"}.`,
        );
      const reasonByTask = new Map(
        input.reasons.map((item) => [item.taskId, item.reason.trim()]),
      );
      // Every mechanical unresolved entry inherits the reason of its semantic task.
      const resolvedAccounting = expectedAccounting.map((entry) => ({
        ...entry,
        reason:
          reasonByTask.get(accountingTaskId(draft, entry) ?? "") ??
          entry.reason,
      }));
      const completedAt = (input.now ?? now).toISOString();
      draft.completion = {
        conclusion: input.conclusion.trim(),
        evidence: structuredClone(input.evidence),
        limitations: input.limitations.map((item) => item.trim()),
        accounting: resolvedAccounting,
        completedAt,
      };
      draft.lifecycle = {
        state: "completed",
        changedAt: completedAt,
        reason: "Coordinator completed the workstream with retained evidence.",
      };
    }, input.now);
  }

  isAssignmentCurrent(state: WorkstreamState, assignmentId: string): boolean {
    return (
      requireAssignment(state, assignmentId).intentVersion ===
      currentIntent(state).version
    );
  }

  isResultCurrent(state: WorkstreamState, resultId: string): boolean {
    const result = state.results.find((candidate) => candidate.id === resultId);
    if (!result) throw new Error(`Unknown result ${resultId}.`);
    return result.assignmentIntentVersion === currentIntent(state).version;
  }

  private async update(
    mutator: (draft: WorkstreamState, now: Date) => void,
    suppliedNow?: Date,
    allowedLifecycleStates: WorkstreamState["lifecycle"]["state"][] = [
      "active",
    ],
  ): Promise<WorkstreamState> {
    const operation = this.queue.then(async () => {
      this.mutationGuard?.();
      const current = await readState(this.path);
      this.assertOwner(current);
      if (!allowedLifecycleStates.includes(current.lifecycle.state))
        throw new Error(`Workstream is ${current.lifecycle.state}.`);
      const draft = structuredClone(current);
      const now = suppliedNow ?? new Date();
      mutator(draft, now);
      if (sameValue(draft, current)) return structuredClone(current);
      draft.revision = current.revision + 1;
      draft.updatedAt = now.toISOString();
      await this.write(draft);
      return structuredClone(draft);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private assertOwner(state: WorkstreamState): void {
    if (
      state.coordinator.sessionId !== this.owner.sessionId ||
      state.coordinator.sessionFile !== this.owner.sessionFile
    ) {
      throw new Error(
        "Workstream mutation owner does not match the bound coordinator.",
      );
    }
  }

  private async write(state: WorkstreamState): Promise<void> {
    validateState(state);
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      this.mutationGuard?.();
      await rename(temporaryPath, this.path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

async function readState(path: string): Promise<WorkstreamState> {
  const value = await readSupportedStateValue(path);
  validateState(value);
  validateStoredPath(value, path);
  return value;
}

async function readSupportedStateValue(
  path: string,
): Promise<Record<string, unknown>> {
  const value = await readStateValue(path);
  if (
    value.format !== WORKSTREAM_FORMAT ||
    value.version !== WORKSTREAM_STATE_VERSION
  )
    throw new UnsupportedWorkstreamStateError(value.format, value.version);
  return value;
}

async function readStateValue(path: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new InvalidWorkstreamStateError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!isRecord(value))
    throw new UnsupportedWorkstreamStateError(undefined, undefined);
  return value;
}

function retainedTerminalInspection(
  value: Record<string, unknown>,
  resolvedPath: string,
): WorkstreamReattachmentInspection | undefined {
  if (!Value.Check(RetainedTerminalEnvelopeSchema, value)) return undefined;
  try {
    if (
      value.statePath !== resolvedPath ||
      value.statePath !== WorkstreamStore.pathFor(value.gitCommonDir, value.id)
    )
      return undefined;
  } catch {
    return undefined;
  }
  return {
    kind: "retained_terminal",
    id: value.id,
    lifecycle: structuredClone(value.lifecycle),
  };
}

function isKnownHistoricalWorkstreamVersion(value: unknown): boolean {
  return value === 1 || value === 2 || value === 3;
}

function validateStoredPath(state: WorkstreamState, path: string): void {
  if (state.statePath !== path)
    throw new InvalidWorkstreamStateError(
      `Workstream state is stored at ${state.statePath}, not ${path}.`,
    );
}

function validateState(value: unknown): asserts value is WorkstreamState {
  if (!Value.Check(WorkstreamStateSchema, value))
    throw new InvalidWorkstreamStateError("Invalid workstream state.");
  const state = value;
  validateId(state.id, "Workstream id");
  if (state.statePath !== WorkstreamStore.pathFor(state.gitCommonDir, state.id))
    throw new InvalidWorkstreamStateError(
      "Workstream state path does not match its identity.",
    );
  validateSession(state.coordinator);
  const inputIds = unique(
    state.inputs.map((input) => input.id),
    "human input receipt",
  );
  for (const input of state.inputs) requireText(input.text, "Human input");
  state.intents.forEach((intent, index) => {
    if (intent.version !== index)
      throw new InvalidWorkstreamStateError(
        "Intent versions must be contiguous.",
      );
    for (const receiptId of intent.authorityReceiptIds)
      if (!inputIds.has(receiptId))
        throw new InvalidWorkstreamStateError(
          `Intent references unknown receipt ${receiptId}.`,
        );
  });
  const assignmentIds = unique(
    state.assignments.map((assignment) => assignment.id),
    "assignment",
  );
  for (const assignment of state.assignments) {
    if (
      !state.intents.some(
        (intent) => intent.version === assignment.intentVersion,
      )
    )
      throw new InvalidWorkstreamStateError(
        `Assignment ${assignment.id} references unknown intent.`,
      );
    if (
      assignment.artifactIntent === "disposable_experiment" ||
      assignment.capability === "implement"
    )
      validateAuthority(state, assignment.authority);
    if (assignment.capability === "review")
      validateSubject(state, assignment.subject);
  }
  const resultIds = unique(
    state.results.map((result) => result.id),
    "result",
  );
  for (const result of state.results) {
    if (!assignmentIds.has(result.assignmentId))
      throw new InvalidWorkstreamStateError(
        `Result ${result.id} references unknown assignment.`,
      );
    const assignment = state.assignments.find(
      (candidate) => candidate.id === result.assignmentId,
    )!;
    if (assignment.intentVersion !== result.assignmentIntentVersion)
      throw new InvalidWorkstreamStateError(
        `Result ${result.id} has the wrong intent version.`,
      );
    unique(
      result.artifacts.map((artifact) => artifact.id),
      `artifact in result ${result.id}`,
    );
    validateArtifactsForAssignment(
      assignment,
      result.artifacts,
      result.validity === "typed" && result.report.status === "completed"
        ? "typed"
        : "absent",
    );
  }
  for (const disposition of state.dispositions)
    if (!resultIds.has(disposition.resultId))
      throw new InvalidWorkstreamStateError(
        `Disposition references unknown result ${disposition.resultId}.`,
      );
  unique(
    state.attempts.map((attempt) => attempt.id),
    "attempt",
  );
  for (const attempt of state.attempts) {
    if (attempt.placement) {
      if (
        attempt.placement.kind === "shared_project" &&
        resolve(attempt.placement.path) !== resolve(state.projectRoot)
      )
        throw new InvalidWorkstreamStateError(
          `Attempt ${attempt.id} shared placement must be the project root.`,
        );
      if (attempt.placement.kind === "isolated_worktree") {
        if (!attempt.baseRevision)
          throw new InvalidWorkstreamStateError(
            `Attempt ${attempt.id} isolated placement has no base revision.`,
          );
        if (
          attempt.worktreePath !== attempt.placement.path ||
          attempt.branch !== attempt.placement.branch
        )
          throw new InvalidWorkstreamStateError(
            `Attempt ${attempt.id} isolated placement compatibility fields disagree.`,
          );
      } else if (attempt.worktreePath || attempt.branch)
        throw new InvalidWorkstreamStateError(
          `Attempt ${attempt.id} shared placement has isolated compatibility fields.`,
        );
    }
    if (!assignmentIds.has(attempt.assignmentId))
      throw new InvalidWorkstreamStateError(
        `Attempt ${attempt.id} references unknown assignment.`,
      );
    if (attempt.resultId && !resultIds.has(attempt.resultId))
      throw new InvalidWorkstreamStateError(
        `Attempt ${attempt.id} references unknown result.`,
      );
    if (attempt.resultId) {
      const result = state.results.find((item) => item.id === attempt.resultId);
      if (result?.assignmentId !== attempt.assignmentId)
        throw new InvalidWorkstreamStateError(
          `Attempt ${attempt.id} references a result from another assignment.`,
        );
    }
    if (
      attempt.models?.selection &&
      attempt.models.selection.selected.length === 0
    )
      throw new InvalidWorkstreamStateError(
        `Attempt ${attempt.id} has an empty model selection.`,
      );
  }
  for (const delivery of state.deliveries)
    if (!resultIds.has(delivery.resultId))
      throw new InvalidWorkstreamStateError(
        `Delivery references unknown result ${delivery.resultId}.`,
      );
  unique(
    state.deliveries.map((delivery) => delivery.resultId),
    "delivery",
  );
  if (state.completion) {
    for (const item of state.completion.accounting) {
      if (
        item.kind === "unresolved_assignment" &&
        !assignmentIds.has(item.assignmentId)
      )
        throw new InvalidWorkstreamStateError(
          `Completion references unknown assignment ${item.assignmentId}.`,
        );
      if (
        item.kind === "unresolved_attempt" &&
        !state.attempts.some((attempt) => attempt.id === item.attemptId)
      )
        throw new InvalidWorkstreamStateError(
          `Completion references unknown attempt ${item.attemptId}.`,
        );
      if (item.kind === "unresolved_result" && !resultIds.has(item.resultId))
        throw new InvalidWorkstreamStateError(
          `Completion references unknown result ${item.resultId}.`,
        );
      if (
        item.kind === "undelivered_result" &&
        !state.deliveries.some(
          (delivery) => delivery.resultId === item.resultId,
        )
      )
        throw new InvalidWorkstreamStateError(
          `Completion references unknown delivery ${item.resultId}.`,
        );
    }
  }
  if (state.lifecycle.state === "completed" && !state.completion)
    throw new InvalidWorkstreamStateError(
      "Completed workstream has no completion record.",
    );
  if (state.completion && state.lifecycle.state !== "completed")
    throw new InvalidWorkstreamStateError(
      "Completion record requires completed lifecycle.",
    );
}

function addAssignment(
  draft: WorkstreamState,
  input: AssignmentInput & { now?: Date },
  now: Date,
): void {
  validateId(input.id, "Assignment id");
  requireText(input.objective, "Assignment objective");
  requireActive(draft);
  if (draft.assignments.some((item) => item.id === input.id))
    throw new Error(`Duplicate assignment ${input.id}.`);
  const current = currentIntent(draft);
  if (input.intentVersion !== current.version)
    throw new Error(
      `Intent version ${input.intentVersion} is stale; current version is ${current.version}.`,
    );
  if (
    input.artifactIntent === "disposable_experiment" ||
    input.capability === "implement"
  )
    requireAuthority(draft, input.authority);
  if (input.capability === "review") requireSubject(draft, input.subject);
  const { now: suppliedNow, ...fields } = input;
  const assignment: unknown = {
    ...fields,
    createdAt: (suppliedNow ?? now).toISOString(),
  };
  if (!Value.Check(AssignmentSchema, assignment))
    throw new Error(
      "Assignment input does not satisfy its capability contract.",
    );
  draft.assignments.push(assignment);
}

function currentIntent(state: WorkstreamState): Intent {
  return state.intents[state.intents.length - 1]!;
}

function requireReceipt(state: WorkstreamState, id: string): HumanInputReceipt {
  const receipt = state.inputs.find((candidate) => candidate.id === id);
  if (!receipt) throw new Error(`Unknown human input receipt ${id}.`);
  return receipt;
}

function requireAssignment(state: WorkstreamState, id: string): WorkAssignment {
  const assignment = state.assignments.find((candidate) => candidate.id === id);
  if (!assignment) throw new Error(`Unknown assignment ${id}.`);
  return assignment;
}

function requireAuthority(
  state: WorkstreamState,
  authority: AuthorityReference,
): void {
  validateAuthority(state, authority);
  const current = currentIntent(state);
  if (authority.intentVersion !== current.version)
    throw new Error(
      `Authority intent ${authority.intentVersion} is stale; current version is ${current.version}.`,
    );
  if (!current.authorityReceiptIds.includes(authority.receiptId))
    throw new Error("Authority receipt does not authorize the current intent.");
}

function validateAuthority(
  state: WorkstreamState,
  authority: AuthorityReference,
): void {
  const receipt = state.inputs.find(
    (candidate) => candidate.id === authority.receiptId,
  );
  const intent = state.intents.find(
    (candidate) => candidate.version === authority.intentVersion,
  );
  if (!receipt || !intent?.authorityReceiptIds.includes(authority.receiptId))
    throw new InvalidWorkstreamStateError(
      "Assignment authority does not reference a retained human-backed intent.",
    );
}

function requireSubject(state: WorkstreamState, subject: ResultSubject): void {
  if (!Value.Check(ResultSubjectSchema, subject))
    throw new Error("Review requires an identified subject.");
  validateSubject(state, subject);
}

function validateSubject(state: WorkstreamState, subject: ResultSubject): void {
  if (subject.kind === "comparison") {
    const ids = new Set(subject.resultIds);
    if (ids.size !== subject.resultIds.length || subject.resultIds.length < 2)
      throw new InvalidWorkstreamStateError(
        "Comparison requires distinct retained results.",
      );
    for (const resultId of subject.resultIds)
      if (!state.results.some((result) => result.id === resultId))
        throw new InvalidWorkstreamStateError(
          `Comparison references unknown result ${resultId}.`,
        );
    return;
  }
  if (subject.kind === "result") {
    if (!state.results.some((result) => result.id === subject.resultId))
      throw new InvalidWorkstreamStateError(
        `Review references unknown result ${subject.resultId}.`,
      );
    return;
  }
  if (subject.kind === "artifact") {
    const result = state.results.find(
      (candidate) => candidate.id === subject.resultId,
    );
    const artifact = result?.artifacts.find(
      (candidate) => candidate.id === subject.artifactId,
    );
    if (artifact?.retention !== "retained")
      throw new InvalidWorkstreamStateError("Review artifact is not retained.");
    return;
  }
  const retained = state.results.some((result) =>
    result.artifacts.some(
      (artifact) =>
        artifact.kind === "revision" &&
        artifact.reference === subject.revision &&
        artifact.retention === "retained",
    ),
  );
  if (!retained)
    throw new InvalidWorkstreamStateError(
      `Review revision ${subject.revision} is not retained.`,
    );
}

function validateArtifactsForAssignment(
  assignment: WorkAssignment,
  artifacts: RetainedArtifact[],
  validity: WorkResult["validity"] = "typed",
): void {
  if (
    assignment.artifactIntent !== "disposable_experiment" ||
    validity !== "typed"
  )
    return;
  const retainedIds = artifacts
    .filter((artifact) => artifact.retention === "retained")
    .map((artifact) => artifact.id);
  const plannedIds = new Set(assignment.artifactPolicy.retain);
  if (
    new Set(retainedIds).size !== retainedIds.length ||
    retainedIds.length !== plannedIds.size ||
    retainedIds.some((id) => !plannedIds.has(id))
  ) {
    throw new Error(
      `Experiment ${assignment.id} did not retain exactly the artifacts named by its policy.`,
    );
  }
}

function assignmentResolved(
  state: WorkstreamState,
  assignment: WorkAssignment,
): boolean {
  // Resolution closes this assignment's original scope, not the current intent.
  // Every requested attempt is an independent contribution; no later success hides a failure.
  const attempts = state.attempts.filter(
    (attempt) => attempt.assignmentId === assignment.id,
  );
  if (attempts.length > 0)
    return attempts.every((attempt) => attemptResolved(state, attempt));
  if (assignment.capability === "implement") return false;
  const results = state.results.filter(
    (result) => result.assignmentId === assignment.id,
  );
  return (
    results.length > 0 &&
    results.every((result) => !resultUnresolved(state, result.id))
  );
}

function attemptResolved(
  state: WorkstreamState,
  attempt: WorkAttempt,
): boolean {
  const result = attempt.resultId
    ? state.results.find((candidate) => candidate.id === attempt.resultId)
    : undefined;
  if (!result || resultUnresolved(state, result.id)) return false;
  const assignment = state.assignments.find(
    (item) => item.id === attempt.assignmentId,
  );
  return (
    result.validity === "typed" &&
    result.report.status === "completed" &&
    (assignment?.capability !== "implement" ||
      attempt.composition?.state === "composed" ||
      (result.report.kind === "implementation" &&
        result.report.outcome === "no_change"))
  );
}

function resultUnresolved(state: WorkstreamState, resultId: string): boolean {
  const result = state.results.find((candidate) => candidate.id === resultId);
  if (result?.validity !== "typed" || result.report.status !== "completed")
    return true;
  return state.dispositions.some(
    (disposition) =>
      disposition.resultId === resultId && disposition.status !== "accepted",
  );
}

function completionAccounting(state: WorkstreamState): CompletionAccounting[] {
  const accounting: CompletionAccounting[] = [];
  for (const assignment of state.assignments)
    if (!assignmentResolved(state, assignment))
      accounting.push({
        kind: "unresolved_assignment",
        assignmentId: assignment.id,
        reason: "Unresolved assignment requires coordinator accounting.",
      });
  for (const attempt of state.attempts)
    if (!attemptResolved(state, attempt))
      accounting.push({
        kind: "unresolved_attempt",
        attemptId: attempt.id,
        reason: "Unresolved attempt requires coordinator accounting.",
      });
  for (const result of state.results)
    if (resultUnresolved(state, result.id))
      accounting.push({
        kind: "unresolved_result",
        resultId: result.id,
        reason: "Unresolved result requires coordinator accounting.",
      });
  for (const delivery of state.deliveries)
    if (delivery.state === "pending")
      accounting.push({
        kind: "undelivered_result",
        resultId: delivery.resultId,
        reason: "Undelivered result requires coordinator accounting.",
      });
  return accounting;
}

function accountingTaskId(
  state: WorkstreamState,
  item: CompletionAccounting,
): string | undefined {
  if (item.kind === "unresolved_assignment") return item.assignmentId;
  if (item.kind === "unresolved_attempt")
    return state.attempts.find((attempt) => attempt.id === item.attemptId)
      ?.assignmentId;
  return state.results.find((result) => result.id === item.resultId)
    ?.assignmentId;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireActive(state: WorkstreamState): void {
  if (state.lifecycle.state !== "active")
    throw new Error(`Workstream is ${state.lifecycle.state}.`);
}

function validateId(value: string, label: string): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value))
    throw new Error(`${label} must be a lowercase durable id.`);
}

function validateSession(value: SessionIdentity): void {
  requireText(value.sessionId, "Session id");
  requireText(value.sessionFile, "Session file");
}

function requireText(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required.`);
}
function requireTextValue(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required.`);
  return value;
}

function requireTexts(values: string[], label: string): void {
  if (values.some((value) => !value.trim()))
    throw new Error(`${label} cannot contain blank entries.`);
}

function unique(values: string[], label: string): Set<string> {
  const result = new Set(values);
  if (result.size !== values.length)
    throw new InvalidWorkstreamStateError(`Duplicate ${label} id.`);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
