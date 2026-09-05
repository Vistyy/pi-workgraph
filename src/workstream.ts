import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { EvidenceSchema, WorkerReportSchema } from "./report-schema.js";
import type { WorkerReport } from "./types.js";

export const WORKSTREAM_STATE_VERSION = 1 as const;
const WORKSTREAM_FORMAT = "pi-workgraph-workstream" as const;

const NonEmptyStringSchema = Type.String({ minLength: 1 });
const TimestampSchema = Type.String({ minLength: 1 });
const SessionIdentitySchema = Type.Object({
  sessionId: NonEmptyStringSchema,
  sessionFile: NonEmptyStringSchema,
}, { additionalProperties: false });
const LifecycleSchema = Type.Object({
  state: StringEnum(["active", "suspended", "completed", "abandoned", "archived"] as const),
  changedAt: TimestampSchema,
  reason: NonEmptyStringSchema,
}, { additionalProperties: false });
const HumanInputReceiptSchema = Type.Object({
  id: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  sessionFile: NonEmptyStringSchema,
  source: StringEnum(["interactive", "rpc"] as const),
  text: NonEmptyStringSchema,
  receivedAt: TimestampSchema,
}, { additionalProperties: false });
const IntentSchema = Type.Object({
  version: Type.Integer({ minimum: 0 }),
  statement: NonEmptyStringSchema,
  constraints: Type.Array(NonEmptyStringSchema),
  authorityReceiptIds: Type.Array(NonEmptyStringSchema),
  recordedAt: TimestampSchema,
}, { additionalProperties: false });
const AuthorityReferenceSchema = Type.Object({
  receiptId: NonEmptyStringSchema,
  intentVersion: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
const ArtifactPolicySchema = Type.Object({
  retain: Type.Array(NonEmptyStringSchema),
  discardOthers: Type.Literal(true),
}, { additionalProperties: false });
const ResultSubjectSchema = Type.Union([
  Type.Object({ kind: Type.Literal("result"), resultId: NonEmptyStringSchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("artifact"), resultId: NonEmptyStringSchema, artifactId: NonEmptyStringSchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("revision"), revision: Type.String({ pattern: "^[0-9a-f]{40,64}$" }) }, { additionalProperties: false }),
]);
const AssignmentBase = {
  id: NonEmptyStringSchema,
  objective: NonEmptyStringSchema,
  intentVersion: Type.Integer({ minimum: 0 }),
  createdAt: TimestampSchema,
};
const ResearchAssignmentSchema = Type.Object({
  ...AssignmentBase,
  capability: Type.Literal("research"),
  artifactIntent: Type.Literal("evidence_only"),
  expectedEvidence: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
}, { additionalProperties: false });
const ExperimentAssignmentSchema = Type.Object({
  ...AssignmentBase,
  capability: Type.Literal("research"),
  artifactIntent: Type.Literal("disposable_experiment"),
  authority: AuthorityReferenceSchema,
  permittedEffects: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
  stopCondition: NonEmptyStringSchema,
  expectedEvidence: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
  artifactPolicy: ArtifactPolicySchema,
}, { additionalProperties: false });
const ImplementationAssignmentSchema = Type.Object({
  ...AssignmentBase,
  capability: Type.Literal("implement"),
  artifactIntent: Type.Literal("maintained_change"),
  authority: AuthorityReferenceSchema,
  acceptance: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
}, { additionalProperties: false });
const ReviewAssignmentSchema = Type.Object({
  ...AssignmentBase,
  capability: Type.Literal("review"),
  artifactIntent: Type.Literal("evidence_only"),
  subject: ResultSubjectSchema,
  concern: NonEmptyStringSchema,
}, { additionalProperties: false });
const AssignmentSchema = Type.Union([
  ResearchAssignmentSchema,
  ExperimentAssignmentSchema,
  ImplementationAssignmentSchema,
  ReviewAssignmentSchema,
]);
const ArtifactSchema = Type.Object({
  id: NonEmptyStringSchema,
  kind: StringEnum(["path", "revision", "reference"] as const),
  reference: NonEmptyStringSchema,
  retention: StringEnum(["retained", "discarded"] as const),
  summary: NonEmptyStringSchema,
}, { additionalProperties: false });
const ResultBase = {
  id: NonEmptyStringSchema,
  assignmentId: NonEmptyStringSchema,
  assignmentIntentVersion: Type.Integer({ minimum: 0 }),
  artifacts: Type.Array(ArtifactSchema),
  observedAt: TimestampSchema,
};
const ResultSchema = Type.Union([
  Type.Object({ ...ResultBase, validity: Type.Literal("typed"), report: WorkerReportSchema }, { additionalProperties: false }),
  Type.Object({ ...ResultBase, validity: Type.Literal("untyped"), text: NonEmptyStringSchema }, { additionalProperties: false }),
  Type.Object({ ...ResultBase, validity: Type.Literal("invalid"), detail: NonEmptyStringSchema }, { additionalProperties: false }),
  Type.Object({ ...ResultBase, validity: Type.Literal("absent"), detail: NonEmptyStringSchema }, { additionalProperties: false }),
]);
const DispositionSchema = Type.Object({
  resultId: NonEmptyStringSchema,
  status: StringEnum(["accepted", "rejected", "needs_followup"] as const),
  reason: NonEmptyStringSchema,
  recordedAt: TimestampSchema,
}, { additionalProperties: false });
const CompletionSchema = Type.Object({
  conclusion: NonEmptyStringSchema,
  evidence: Type.Array(EvidenceSchema, { minItems: 1 }),
  limitations: Type.Array(NonEmptyStringSchema),
  unresolvedAssignmentIds: Type.Array(NonEmptyStringSchema),
  completedAt: TimestampSchema,
}, { additionalProperties: false });

export const WorkstreamStateSchema = Type.Object({
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
  completion: Type.Optional(CompletionSchema),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}, { additionalProperties: false });

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
export type WorkstreamState = Static<typeof WorkstreamStateSchema>;

type AssignmentInput =
  | { id: string; capability: "research"; artifactIntent: "evidence_only"; objective: string; intentVersion: number; expectedEvidence: string[] }
  | { id: string; capability: "research"; artifactIntent: "disposable_experiment"; objective: string; intentVersion: number; authority: AuthorityReference; permittedEffects: string[]; stopCondition: string; expectedEvidence: string[]; artifactPolicy: Static<typeof ArtifactPolicySchema> }
  | { id: string; capability: "implement"; artifactIntent: "maintained_change"; objective: string; intentVersion: number; authority: AuthorityReference; acceptance: string[] }
  | { id: string; capability: "review"; artifactIntent: "evidence_only"; objective: string; intentVersion: number; subject: ResultSubject; concern: string };

type ResultInput =
  | { id: string; assignmentId: string; assignmentIntentVersion: number; artifacts?: RetainedArtifact[]; validity: "typed"; report: WorkerReport }
  | { id: string; assignmentId: string; assignmentIntentVersion: number; artifacts?: RetainedArtifact[]; validity: "untyped"; text: string }
  | { id: string; assignmentId: string; assignmentIntentVersion: number; artifacts?: RetainedArtifact[]; validity: "invalid" | "absent"; detail: string };

export class InvalidWorkstreamStateError extends Error {
  readonly code = "invalid_workstream_state";

  constructor(message: string) {
    super(message);
    this.name = "InvalidWorkstreamStateError";
  }
}

export class UnsupportedWorkstreamStateError extends Error {
  readonly code = "unsupported_workstream_state";

  constructor(readonly format: unknown, readonly version: unknown) {
    super(`Unsupported workstream state ${String(format)} version ${String(version)}.`);
    this.name = "UnsupportedWorkstreamStateError";
  }
}

export class WorkstreamStore {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(readonly path: string, private readonly owner: SessionIdentity) {}

  static pathFor(gitCommonDir: string, id: string): string {
    validateId(id, "Workstream id");
    return join(resolve(gitCommonDir), "pi-workgraph", "workstreams", id, "workstream.json");
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
      lifecycle: { state: "active", changedAt: now, reason: "Workstream created." },
      inputs: [],
      intents: [{ version: 0, statement: input.purpose.trim(), constraints: [], authorityReceiptIds: [], recordedAt: now }],
      assignments: [],
      results: [],
      dispositions: [],
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

  async load(): Promise<WorkstreamState> {
    const state = await readState(this.path);
    this.assertOwner(state);
    return state;
  }

  async recordInputEvent(input: {
    sessionId: string;
    sessionFile: string;
    source: HumanInputSource;
    text: string;
    now?: Date;
  }): Promise<{ state: WorkstreamState; receipt: HumanInputReceipt }> {
    if (input.source === "extension") throw new Error("Extension-generated input cannot create human authority.");
    const source: HumanInputReceipt["source"] = input.source;
    validateSession(input);
    requireText(input.text, "Human input");
    let receipt: HumanInputReceipt | undefined;
    const state = await this.update((draft, now) => {
      if (input.sessionId !== this.owner.sessionId || input.sessionFile !== this.owner.sessionFile) {
        throw new Error("Human input does not belong to the bound coordinator session.");
      }
      receipt = {
        id: randomUUID(),
        sessionId: input.sessionId,
        sessionFile: input.sessionFile,
        source,
        text: input.text.trim(),
        receivedAt: (input.now ?? now).toISOString(),
      };
      const recorded = receipt;
      if (!recorded) throw new Error("Human input receipt was not recorded.");
      draft.inputs.push(recorded);
    }, input.now);
    if (!receipt) throw new Error("Human input receipt was not recorded.");
    return { state, receipt };
  }

  async setLifecycle(input: { state: "active" | "suspended" | "abandoned" | "archived"; reason: string; now?: Date }): Promise<WorkstreamState> {
    requireText(input.reason, "Lifecycle reason");
    return this.update((draft, now) => {
      const from = draft.lifecycle.state;
      const allowed = from === "active"
        ? ["suspended", "abandoned", "archived"]
        : from === "suspended"
          ? ["active", "abandoned", "archived"]
          : [];
      if (!allowed.includes(input.state)) throw new Error(`Cannot transition workstream lifecycle from ${from} to ${input.state}.`);
      draft.lifecycle = { state: input.state, changedAt: (input.now ?? now).toISOString(), reason: input.reason.trim() };
    }, input.now, ["active", "suspended"]);
  }

  async reviseIntent(input: { authorityReceiptId: string; statement: string; constraints: string[]; now?: Date }): Promise<WorkstreamState> {
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

  async assign(input: AssignmentInput & { now?: Date }): Promise<WorkstreamState> {
    validateId(input.id, "Assignment id");
    requireText(input.objective, "Assignment objective");
    return this.update((draft, now) => {
      requireActive(draft);
      if (draft.assignments.some((assignment) => assignment.id === input.id)) throw new Error(`Duplicate assignment ${input.id}.`);
      const current = currentIntent(draft);
      if (input.intentVersion !== current.version) throw new Error(`Intent version ${input.intentVersion} is stale; current version is ${current.version}.`);
      if (input.artifactIntent === "disposable_experiment" || input.capability === "implement") {
        requireAuthority(draft, input.authority);
      }
      if (input.capability === "review") requireSubject(draft, input.subject);
      const { now: _now, ...fields } = input;
      const assignment: unknown = { ...fields, createdAt: (input.now ?? now).toISOString() };
      if (!Value.Check(AssignmentSchema, assignment)) throw new Error("Assignment input does not satisfy its capability contract.");
      draft.assignments.push(assignment);
    }, input.now);
  }

  async retainResult(input: ResultInput & { now?: Date }): Promise<WorkstreamState> {
    validateId(input.id, "Result id");
    return this.update((draft, now) => {
      requireActive(draft);
      if (draft.results.some((result) => result.id === input.id)) throw new Error(`Duplicate result ${input.id}.`);
      const assignment = requireAssignment(draft, input.assignmentId);
      if (input.assignmentIntentVersion !== assignment.intentVersion) throw new Error("Result intent version does not match its assignment.");
      const { now: _now, artifacts = [], ...fields } = input;
      validateArtifactsForAssignment(assignment, artifacts);
      const result: unknown = { ...fields, artifacts, observedAt: (input.now ?? now).toISOString() };
      if (!Value.Check(ResultSchema, result)) throw new Error("Result input does not satisfy its validity contract.");
      draft.results.push(result);
    }, input.now);
  }

  async disposition(input: { resultId: string; status: ResultDisposition["status"]; reason: string; now?: Date }): Promise<WorkstreamState> {
    requireText(input.reason, "Disposition reason");
    return this.update((draft, now) => {
      requireActive(draft);
      if (!draft.results.some((result) => result.id === input.resultId)) throw new Error(`Unknown result ${input.resultId}.`);
      draft.dispositions.push({
        resultId: input.resultId,
        status: input.status,
        reason: input.reason.trim(),
        recordedAt: (input.now ?? now).toISOString(),
      });
    }, input.now);
  }

  async complete(input: { conclusion: string; evidence: Static<typeof EvidenceSchema>[]; limitations: string[]; now?: Date }): Promise<WorkstreamState> {
    requireText(input.conclusion, "Completion conclusion");
    if (input.evidence.length === 0 || !input.evidence.every((item) => Value.Check(EvidenceSchema, item))) throw new Error("Completion requires valid evidence.");
    requireTexts(input.limitations, "Completion limitations");
    return this.update((draft, now) => {
      requireActive(draft);
      const unresolvedAssignmentIds = draft.assignments
        .filter((assignment) => !assignmentResolved(draft, assignment))
        .map((assignment) => assignment.id);
      if (unresolvedAssignmentIds.length > 0 && input.limitations.length === 0) {
        throw new Error("Completion with unresolved assignments requires an explicit limitation.");
      }
      const completedAt = (input.now ?? now).toISOString();
      draft.completion = {
        conclusion: input.conclusion.trim(),
        evidence: structuredClone(input.evidence),
        limitations: input.limitations.map((item) => item.trim()),
        unresolvedAssignmentIds,
        completedAt,
      };
      draft.lifecycle = { state: "completed", changedAt: completedAt, reason: "Coordinator completed the workstream with retained evidence." };
    }, input.now);
  }

  isAssignmentCurrent(state: WorkstreamState, assignmentId: string): boolean {
    return requireAssignment(state, assignmentId).intentVersion === currentIntent(state).version;
  }

  isResultCurrent(state: WorkstreamState, resultId: string): boolean {
    const result = state.results.find((candidate) => candidate.id === resultId);
    if (!result) throw new Error(`Unknown result ${resultId}.`);
    return result.assignmentIntentVersion === currentIntent(state).version;
  }

  private async update(
    mutator: (draft: WorkstreamState, now: Date) => void,
    suppliedNow?: Date,
    allowedLifecycleStates: WorkstreamState["lifecycle"]["state"][] = ["active"],
  ): Promise<WorkstreamState> {
    const operation = this.queue.then(async () => {
      const current = await readState(this.path);
      this.assertOwner(current);
      if (!allowedLifecycleStates.includes(current.lifecycle.state)) throw new Error(`Workstream is ${current.lifecycle.state}.`);
      const draft = structuredClone(current);
      const now = suppliedNow ?? new Date();
      mutator(draft, now);
      draft.revision = current.revision + 1;
      draft.updatedAt = now.toISOString();
      validateState(draft);
      await this.write(draft);
      return structuredClone(draft);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private assertOwner(state: WorkstreamState): void {
    if (state.coordinator.sessionId !== this.owner.sessionId || state.coordinator.sessionFile !== this.owner.sessionFile) {
      throw new Error("Workstream mutation owner does not match the bound coordinator.");
    }
  }

  private async write(state: WorkstreamState): Promise<void> {
    validateState(state);
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

async function readState(path: string): Promise<WorkstreamState> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new InvalidWorkstreamStateError(error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(value) || value.format !== WORKSTREAM_FORMAT || value.version !== WORKSTREAM_STATE_VERSION) {
    throw new UnsupportedWorkstreamStateError(isRecord(value) ? value.format : undefined, isRecord(value) ? value.version : undefined);
  }
  if (!Value.Check(WorkstreamStateSchema, value)) throw new InvalidWorkstreamStateError(`Invalid workstream state at ${path}.`);
  validateState(value);
  if (value.statePath !== path) throw new InvalidWorkstreamStateError(`Workstream state is stored at ${value.statePath}, not ${path}.`);
  return structuredClone(value);
}

function validateState(state: WorkstreamState): void {
  const candidate: unknown = state;
  if (!Value.Check(WorkstreamStateSchema, candidate)) throw new InvalidWorkstreamStateError(`Invalid workstream state for ${state.id}.`);
  validateId(state.id, "Workstream id");
  if (state.statePath !== WorkstreamStore.pathFor(state.gitCommonDir, state.id)) throw new InvalidWorkstreamStateError("Workstream state path does not match its identity.");
  validateSession(state.coordinator);
  const inputIds = unique(state.inputs.map((input) => input.id), "human input receipt");
  for (const input of state.inputs) {
    if (input.sessionId !== state.coordinator.sessionId || input.sessionFile !== state.coordinator.sessionFile) throw new InvalidWorkstreamStateError("Human input receipt belongs to another coordinator.");
    requireText(input.text, "Human input");
  }
  state.intents.forEach((intent, index) => {
    if (intent.version !== index) throw new InvalidWorkstreamStateError("Intent versions must be contiguous.");
    for (const receiptId of intent.authorityReceiptIds) if (!inputIds.has(receiptId)) throw new InvalidWorkstreamStateError(`Intent references unknown receipt ${receiptId}.`);
  });
  const assignmentIds = unique(state.assignments.map((assignment) => assignment.id), "assignment");
  for (const assignment of state.assignments) {
    if (!state.intents.some((intent) => intent.version === assignment.intentVersion)) throw new InvalidWorkstreamStateError(`Assignment ${assignment.id} references unknown intent.`);
    if (assignment.artifactIntent === "disposable_experiment" || assignment.capability === "implement") validateAuthority(state, assignment.authority);
    if (assignment.capability === "review") validateSubject(state, assignment.subject);
  }
  const resultIds = unique(state.results.map((result) => result.id), "result");
  for (const result of state.results) {
    if (!assignmentIds.has(result.assignmentId)) throw new InvalidWorkstreamStateError(`Result ${result.id} references unknown assignment.`);
    const assignment = state.assignments.find((candidate) => candidate.id === result.assignmentId)!;
    if (assignment.intentVersion !== result.assignmentIntentVersion) throw new InvalidWorkstreamStateError(`Result ${result.id} has the wrong intent version.`);
    unique(result.artifacts.map((artifact) => artifact.id), `artifact in result ${result.id}`);
    validateArtifactsForAssignment(assignment, result.artifacts);
  }
  for (const disposition of state.dispositions) if (!resultIds.has(disposition.resultId)) throw new InvalidWorkstreamStateError(`Disposition references unknown result ${disposition.resultId}.`);
  if (state.lifecycle.state === "completed" && !state.completion) throw new InvalidWorkstreamStateError("Completed workstream has no completion record.");
  if (state.completion && state.lifecycle.state !== "completed") throw new InvalidWorkstreamStateError("Completion record requires completed lifecycle.");
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

function requireAuthority(state: WorkstreamState, authority: AuthorityReference): void {
  validateAuthority(state, authority);
  const current = currentIntent(state);
  if (authority.intentVersion !== current.version) throw new Error(`Authority intent ${authority.intentVersion} is stale; current version is ${current.version}.`);
  if (!current.authorityReceiptIds.includes(authority.receiptId)) throw new Error("Authority receipt does not authorize the current intent.");
}

function validateAuthority(state: WorkstreamState, authority: AuthorityReference): void {
  const receipt = state.inputs.find((candidate) => candidate.id === authority.receiptId);
  const intent = state.intents.find((candidate) => candidate.version === authority.intentVersion);
  if (!receipt || !intent || !intent.authorityReceiptIds.includes(authority.receiptId)) throw new InvalidWorkstreamStateError("Assignment authority does not reference a retained human-backed intent.");
}

function requireSubject(state: WorkstreamState, subject: ResultSubject): void {
  if (!Value.Check(ResultSubjectSchema, subject)) throw new Error("Review requires an identified subject.");
  validateSubject(state, subject);
}

function validateSubject(state: WorkstreamState, subject: ResultSubject): void {
  if (subject.kind === "result") {
    if (!state.results.some((result) => result.id === subject.resultId)) throw new InvalidWorkstreamStateError(`Review references unknown result ${subject.resultId}.`);
    return;
  }
  if (subject.kind === "artifact") {
    const result = state.results.find((candidate) => candidate.id === subject.resultId);
    const artifact = result?.artifacts.find((candidate) => candidate.id === subject.artifactId);
    if (!artifact || artifact.retention !== "retained") throw new InvalidWorkstreamStateError("Review artifact is not retained.");
    return;
  }
  const retained = state.results.some((result) => result.artifacts.some((artifact) => artifact.kind === "revision" && artifact.reference === subject.revision && artifact.retention === "retained"));
  if (!retained) throw new InvalidWorkstreamStateError(`Review revision ${subject.revision} is not retained.`);
}

function validateArtifactsForAssignment(assignment: WorkAssignment, artifacts: RetainedArtifact[]): void {
  if (assignment.artifactIntent !== "disposable_experiment") return;
  const retainedIds = artifacts.filter((artifact) => artifact.retention === "retained").map((artifact) => artifact.id);
  const plannedIds = new Set(assignment.artifactPolicy.retain);
  if (new Set(retainedIds).size !== retainedIds.length || retainedIds.length !== plannedIds.size || retainedIds.some((id) => !plannedIds.has(id))) {
    throw new Error(`Experiment ${assignment.id} did not retain exactly the artifacts named by its policy.`);
  }
}

function assignmentResolved(state: WorkstreamState, assignment: WorkAssignment): boolean {
  if (assignment.intentVersion !== currentIntent(state).version) return false;
  const result = [...state.results].reverse().find((candidate) => candidate.assignmentId === assignment.id);
  if (!result || result.validity !== "typed") return false;
  const disposition = [...state.dispositions].reverse().find((candidate) => candidate.resultId === result.id);
  return disposition?.status === "accepted";
}

function requireActive(state: WorkstreamState): void {
  if (state.lifecycle.state !== "active") throw new Error(`Workstream is ${state.lifecycle.state}.`);
}

function validateId(value: string, label: string): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value)) throw new Error(`${label} must be a lowercase durable id.`);
}

function validateSession(value: SessionIdentity): void {
  requireText(value.sessionId, "Session id");
  requireText(value.sessionFile, "Session file");
}

function requireText(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required.`);
}

function requireTexts(values: string[], label: string): void {
  if (values.some((value) => !value.trim())) throw new Error(`${label} cannot contain blank entries.`);
}

function unique(values: string[], label: string): Set<string> {
  const result = new Set(values);
  if (result.size !== values.length) throw new InvalidWorkstreamStateError(`Duplicate ${label} id.`);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
