/* oxlint-disable effecttsgo/async-function, effecttsgo/node-builtin-import, effecttsgo/global-date, anti-slop/no-runtime-typeof -- This temporary migration host boundary performs explicitly staged Node filesystem operations and recursively inspects parsed JSONL values only for exact steering evidence; its exported workflows remain typed Effects and it is removed after cutover. */
// TEMPORARY: remove this isolated predecessor-v7 preparation boundary after the
// inspected cutover has completed and its immutable archive has retired.
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Data, Effect, type FileSystem, type Path, type Scope } from "effect";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  type CanonicalStoreError,
  CanonicalWorkstreamStore,
} from "./canonical-workstream-store.js";
import type { ModelTarget } from "./domain/model-target.js";
import {
  type Attempt,
  type CoordinatorIdentity,
  type Delivery,
  type Intent,
  isOperationallyStable,
  type ModelSelection,
  type Outcome,
  type RepositoryIdentity,
  type Task,
  validateWorkstream,
  type Workstream,
  WorkstreamSchema,
} from "./domain/workstream.js";
import { WorkerReportInputSchema } from "./report-schema.js";
import {
  type WorkAssignment,
  type WorkAttempt,
  type WorkstreamState,
  WorkstreamStateSchema,
} from "./workstream-state.js";
import { validateState } from "./workstream-validation.js";

const MANIFEST_FORMAT = "pi-workgraph-v7-normalization-manifest" as const;
const MANIFEST_VERSION = 1 as const;
export const V7_MIGRATION_BREADCRUMB_ENTRY = "pi-workgraph-v7-migration" as const;
const BREADCRUMB_FORMAT = V7_MIGRATION_BREADCRUMB_ENTRY;
const BREADCRUMB_VERSION = 1 as const;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const SQLITE_HEADER = "SQLite format 3\u0000";
const StateRow = Type.Object(
  { state_json: Type.String(), revision: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);
const LeaseCountRow = Type.Object({ count: Type.Integer({ minimum: 0 }) });
const NameRow = Type.Object({ name: Type.String() });
const CanonicalHeaderRow = Type.Object(
  { format: Type.String(), version: Type.Integer() },
  { additionalProperties: false },
);
const ExactPiUserMessageRecord = Type.Object(
  {
    type: Type.Literal("message"),
    message: Type.Object(
      {
        role: Type.Literal("user"),
        content: Type.Union([
          Type.String(),
          Type.Tuple([Type.Object({ type: Type.Literal("text"), text: Type.String() })]),
        ]),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);
const TimestampRecord = Type.Object(
  { timestamp: Type.String({ minLength: 1 }) },
  { additionalProperties: true },
);
export const V7MigrationBreadcrumbSchema = Type.Object(
  {
    format: Type.Literal(BREADCRUMB_FORMAT),
    version: Type.Literal(BREADCRUMB_VERSION),
    phase: Type.Union([Type.Literal("prepared"), Type.Literal("committed")]),
    migrationId: Type.String({ minLength: 1 }),
    declaration: Type.Object(
      {
        repository: Type.Object(
          {
            projectRoot: Type.String({ minLength: 1 }),
            gitCommonDir: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
        workstreamId: Type.String({ minLength: 1 }),
        expectedRevision: Type.Integer({ minimum: 0 }),
        expectedSourceSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
      },
      { additionalProperties: false },
    ),
    paths: Type.Object(
      {
        source: Type.String({ minLength: 1 }),
        target: Type.String({ minLength: 1 }),
        archiveDirectory: Type.String({ minLength: 1 }),
        archiveDatabase: Type.String({ minLength: 1 }),
        manifest: Type.String({ minLength: 1 }),
        stagingDatabase: Type.String({ minLength: 1 }),
        workerSessionDirectory: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    canonicalStateSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    recordedAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export class V7MigrationError extends Data.TaggedError("V7MigrationError")<{
  readonly code: "v7_migration_rejected";
  readonly message: string;
  readonly cause?: unknown;
}> {
  constructor(message: string, cause?: unknown) {
    super({ code: "v7_migration_rejected", message, cause });
  }
}

export interface V7MigrationPaths {
  readonly source: string;
  readonly target: string;
  readonly archiveDirectory: string;
  readonly archiveDatabase: string;
  readonly manifest: string;
  readonly stagingDatabase: string;
  readonly workerSessionDirectory: string;
}

export interface FileIdentity {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface SessionCopyIdentity {
  readonly attemptId: string;
  readonly source: FileIdentity;
  readonly target: FileIdentity;
}

export interface V7NormalizationLedger {
  readonly omittedIntent: {
    readonly oldVersion: 0;
    readonly reason: string;
    readonly exact: WorkstreamState["intents"][number];
  };
  readonly intentVersions: ReadonlyArray<{
    readonly oldVersion: number;
    readonly intentIndex: number;
  }>;
  readonly assignmentToTask: ReadonlyArray<{
    readonly assignmentId: string;
    readonly taskId: string;
  }>;
  readonly attemptIds: ReadonlyArray<{ readonly oldAttemptId: string; readonly attemptId: string }>;
  readonly resultToOutcome: ReadonlyArray<{
    readonly resultId: string;
    readonly outcomeId: string;
  }>;
  readonly requestedModelProvenance: ReadonlyArray<{
    readonly attemptId: string;
    readonly exactModels: WorkAttempt["models"];
  }>;
  readonly omittedBaseRevisions: ReadonlyArray<{
    readonly attemptId: string;
    readonly baseRevision: string;
  }>;
  readonly omittedCrossTaskContinuations: ReadonlyArray<{
    readonly attemptId: string;
    readonly continuationOf: string;
  }>;
  readonly omittedDeliveryAttemptedBy: ReadonlyArray<{
    readonly resultId: string;
    readonly attemptedBy: string;
  }>;
  readonly steeringEvidence: ReadonlyArray<{
    readonly attemptId: string;
    readonly sessionFile: string;
    readonly line: number;
    readonly lineSha256: string;
    readonly observedAt: string;
  }>;
  readonly normalization: readonly string[];
}

export interface V7MigrationManifest {
  readonly format: typeof MANIFEST_FORMAT;
  readonly version: typeof MANIFEST_VERSION;
  readonly repository: RepositoryIdentity;
  readonly workstreamId: string;
  readonly source: FileIdentity & { readonly revision: number; readonly stateSha256: string };
  readonly archive: FileIdentity;
  readonly rawState: string;
  readonly receipts: WorkstreamState["inputs"];
  readonly ledger: V7NormalizationLedger;
  readonly sessions: readonly SessionCopyIdentity[];
  readonly canonicalStateSha256: string;
  readonly prepared: V7MigrationBreadcrumb;
  readonly committedIdentity: {
    readonly migrationId: string;
    readonly phase: "committed";
    readonly canonicalStateSha256: string;
  };
}

export interface V7MigrationDeclaration {
  readonly repository: RepositoryIdentity;
  readonly workstreamId: string;
  readonly expectedRevision: number;
  readonly expectedSourceSha256: string;
}

export interface V7MigrationBreadcrumb {
  readonly format: typeof BREADCRUMB_FORMAT;
  readonly version: typeof BREADCRUMB_VERSION;
  readonly phase: "prepared" | "committed";
  readonly migrationId: string;
  readonly declaration: V7MigrationDeclaration;
  readonly paths: V7MigrationPaths;
  readonly canonicalStateSha256: string;
  readonly recordedAt: string;
}

/** Append-only host seam implemented by Pi session custom records at cutover. */
export interface V7MigrationBreadcrumbPort {
  readonly append: (record: V7MigrationBreadcrumb) => Promise<void>;
  readonly read: () => Promise<readonly V7MigrationBreadcrumb[]>;
}

export interface V7Normalization {
  readonly state: Workstream;
  readonly ledger: V7NormalizationLedger;
}

export interface V7MigrationPreflight {
  readonly declaration: V7MigrationDeclaration;
  readonly paths: V7MigrationPaths;
  readonly source: WorkstreamState;
  readonly sourceRawState: string;
  readonly sourceIdentity: FileIdentity;
  readonly canonical: Workstream;
  readonly ledger: V7NormalizationLedger;
  readonly sessions: readonly SessionCopyIdentity[];
  readonly prepared: V7MigrationBreadcrumb;
}

function v7MigrationPaths(repository: RepositoryIdentity, workstreamId: string): V7MigrationPaths {
  if (!safeSegment(workstreamId)) throw reject("Workstream id is not a safe path segment.");
  const directory = join(repository.gitCommonDir, "pi-workgraph", "workstreams", workstreamId);
  const source = join(directory, "workstream.sqlite");
  return {
    source,
    target: source,
    archiveDirectory: join(directory, "v7-migration-archive"),
    archiveDatabase: join(directory, "v7-migration-archive", "workstream-v7.sqlite"),
    manifest: join(directory, "v7-migration-archive", "manifest-v1.json"),
    stagingDatabase: join(directory, "workstream.canonical-staging.sqlite"),
    workerSessionDirectory: join(
      repository.gitCommonDir,
      "pi-workgraph",
      "worker-sessions",
      workstreamId,
    ),
  };
}

export function normalizeV7Workstream(
  source: WorkstreamState,
  sessionRecords: ReadonlyMap<string, string>,
  canonicalSessionPaths?: ReadonlyMap<string, string>,
): V7Normalization {
  if (source.lifecycle.state !== "active")
    throw reject(
      `Legacy lifecycle ${source.lifecycle.state} is not the one active migration source.`,
    );
  assertOmittableIntentZero(source);
  for (const attempt of source.attempts) {
    if (!safeSegment(attempt.id))
      throw reject(`Attempt id is not a safe target filename segment: ${attempt.id}.`);
    if (attempt.state !== "settled")
      throw reject(`Attempt ${attempt.id} is not exactly settled (${attempt.state}).`);
    assertNoOutstandingObligation(attempt);
  }
  validateState(source);
  const assignments = new Map(source.assignments.map((assignment) => [assignment.id, assignment]));
  const attemptTask = new Map(source.attempts.map((attempt) => [attempt.id, attempt.assignmentId]));
  const resultMap = new Map(
    source.results.map((result) => [
      result.id,
      `${attemptForResult(source, result.id).id}:outcome`,
    ]),
  );
  const ledger: MutableLedger = {
    omittedIntent: {
      oldVersion: 0,
      reason:
        "Legacy Intent v0 was ungrounded, had no Assignments/Tasks, and was immediately duplicated by grounded Intent v1.",
      exact: structuredClone(requiredValue(source.intents[0], "approved Intent v0")),
    },
    intentVersions: source.intents.slice(1).map((intent, intentIndex) => ({
      oldVersion: intent.version,
      intentIndex,
    })),
    assignmentToTask: source.assignments.map((assignment) => ({
      assignmentId: assignment.id,
      taskId: assignment.id,
    })),
    attemptIds: source.attempts.map((attempt) => ({
      oldAttemptId: attempt.id,
      attemptId: attempt.id,
    })),
    resultToOutcome: [...resultMap].map(([resultId, outcomeId]) => ({ resultId, outcomeId })),
    requestedModelProvenance: [],
    omittedBaseRevisions: [],
    omittedCrossTaskContinuations: [],
    omittedDeliveryAttemptedBy: [],
    steeringEvidence: [],
    normalization: [
      "The canonical aggregate is a normalized operational projection; the archived v7 aggregate and this ledger retain omitted provenance.",
      "Canonical Selection.source is policy; predecessor requested-model provenance is retained only in this ledger.",
      "Legacy Result ids are deterministically rewritten to <Attempt id>:outcome.",
    ],
  };
  const intents = source.intents.slice(1).map((legacy): Intent => {
    if (legacy.authorityReceiptIds.length !== 1)
      throw reject(`Intent v${legacy.version} does not have one exact grounding receipt.`);
    const receipt = source.inputs.find((input) => input.id === legacy.authorityReceiptIds[0]);
    if (receipt === undefined)
      throw reject(`Intent v${legacy.version} grounding receipt is absent.`);
    return {
      statement: legacy.statement,
      constraints: [...legacy.constraints],
      grounding: { kind: "human_input_receipt", ...structuredClone(receipt) },
      recordedAt: legacy.recordedAt,
    };
  });
  const tasks = source.assignments.map((assignment): Task => {
    const legacyAttempts = source.attempts.filter(
      (attempt) => attempt.assignmentId === assignment.id,
    );
    if (legacyAttempts.length === 0) throw reject(`Assignment ${assignment.id} has no Attempt.`);
    const attempts = legacyAttempts.map((attempt, index) =>
      mapAttempt(
        source,
        assignment,
        attempt,
        index,
        legacyAttempts.length,
        attemptTask,
        resultMap,
        sessionRecords,
        canonicalSessionPaths,
        ledger,
      ),
    );
    return mapTask(assignment, attempts, resultMap);
  });
  const lifecycle = canonicalLifecycle(source.lifecycle.state);
  const state: Workstream = {
    format: "pi-workgraph-workstream",
    schema: "coordination-domain",
    schemaVersion: 2,
    revision: source.revision,
    id: source.id,
    purpose: source.purpose,
    repository: { projectRoot: source.projectRoot, gitCommonDir: source.gitCommonDir },
    coordinator: structuredClone(source.coordinator),
    coordinatorTransfers: [],
    lifecycle,
    intents,
    tasks,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
  if (assignments.size !== tasks.length) throw reject("Assignment mapping is not one-to-one.");
  validateWorkstream(state);
  for (const task of state.tasks)
    for (const attempt of task.attempts) {
      if (!isOperationallyStable(task, attempt))
        throw reject(
          `Attempt ${attempt.id} is not operationally stable after exact obligation checks.`,
        );
    }
  return { state, ledger };
}

function mapTask(
  assignment: WorkAssignment,
  attempts: Attempt[],
  resultMap: ReadonlyMap<string, string>,
): Task {
  const common = {
    id: assignment.id,
    objective: assignment.objective,
    intentIndex: assignment.intentVersion - 1,
    createdAt: assignment.createdAt,
    attempts,
  };
  if (assignment.capability === "implement")
    return { ...common, kind: "implementation", acceptance: [...assignment.acceptance] };
  if (assignment.capability === "review")
    return {
      ...common,
      kind: "review",
      subject: mapReviewSubject(assignment.subject, resultMap),
      concern: assignment.concern,
    };
  if (assignment.capability === "consultation") {
    const task: Extract<Task, { kind: "consultation" }> = { ...common, kind: "consultation" };
    if (assignment.context !== undefined) task.context = assignment.context;
    return task;
  }
  if (assignment.artifactIntent === "disposable_experiment")
    return {
      ...common,
      kind: "experiment",
      permittedEffects: [...assignment.permittedEffects],
      stopCondition: assignment.stopCondition,
      expectedEvidence: [...assignment.expectedEvidence],
    };
  return { ...common, kind: "research", expectedEvidence: [...assignment.expectedEvidence] };
}

function mapReviewSubject(
  subject: Extract<WorkAssignment, { capability: "review" }>["subject"],
  resultMap: ReadonlyMap<string, string>,
): Extract<Task, { kind: "review" }>["subject"] {
  if (subject.kind === "revision") return structuredClone(subject);
  const outcome = (resultId: string) => {
    const mapped = resultMap.get(resultId);
    if (mapped === undefined) throw reject(`Review subject references unknown Result ${resultId}.`);
    return mapped;
  };
  if (subject.kind === "result") return { kind: "outcome", outcomeId: outcome(subject.resultId) };
  if (subject.kind === "comparison")
    return { kind: "comparison", outcomeIds: subject.resultIds.map(outcome) };
  return { kind: "artifact", outcomeId: outcome(subject.resultId), artifactId: subject.artifactId };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this temporary adapter explicitly accounts for every optional predecessor field.
function mapAttempt(
  source: WorkstreamState,
  assignment: WorkAssignment,
  legacy: WorkAttempt,
  assignmentAttemptIndex: number,
  assignmentAttemptCount: number,
  attemptTask: ReadonlyMap<string, string>,
  resultMap: ReadonlyMap<string, string>,
  sessionRecords: ReadonlyMap<string, string>,
  canonicalSessionPaths: ReadonlyMap<string, string> | undefined,
  ledger: MutableLedger,
): Attempt {
  if (legacy.state !== "settled")
    throw reject(`Attempt ${legacy.id} is not exactly settled (${legacy.state}).`);
  const selection = mapSelection(
    assignment,
    legacy,
    assignmentAttemptIndex,
    assignmentAttemptCount,
  );
  if (
    legacy.models?.source === "requested-model" ||
    legacy.models?.selection?.source === "requested-model"
  )
    ledger.requestedModelProvenance.push({
      attemptId: legacy.id,
      exactModels: structuredClone(legacy.models),
    });
  const attempt: Attempt = {
    id: legacy.id,
    state: "finished",
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
    selection,
    outcome: mapOutcome(source, assignment, legacy, resultMap, ledger),
  };
  if (legacy.effectiveModels !== undefined)
    attempt.effectiveModels = structuredClone(legacy.effectiveModels);
  if (legacy.candidate !== undefined) {
    if (legacy.candidate.kind === "initial")
      attempt.candidate = { kind: "initial", rootCommit: legacy.candidate.rootCommit };
    else {
      if (
        legacy.candidate.parentAttemptId === undefined ||
        legacy.candidate.parentCommit === undefined
      )
        throw reject(`Attempt ${legacy.id} candidate lineage is incomplete.`);
      attempt.candidate = {
        kind: legacy.candidate.kind,
        rootCommit: legacy.candidate.rootCommit,
        parentAttemptId: legacy.candidate.parentAttemptId,
        parentCommit: legacy.candidate.parentCommit,
      };
    }
  }
  if (legacy.baseRevision !== undefined) {
    if (retainsBaseRevision(assignment)) attempt.baseRevision = legacy.baseRevision;
    else
      ledger.omittedBaseRevisions.push({ attemptId: legacy.id, baseRevision: legacy.baseRevision });
  }
  if (legacy.continuationOf !== undefined) {
    if (attemptTask.get(legacy.continuationOf) === legacy.assignmentId)
      attempt.continuationOf = legacy.continuationOf;
    else
      ledger.omittedCrossTaskContinuations.push({
        attemptId: legacy.id,
        continuationOf: legacy.continuationOf,
      });
  }
  const execution = mapExecution(legacy, sessionRecords, canonicalSessionPaths, ledger);
  if (execution !== undefined) attempt.execution = execution;
  if (legacy.application !== undefined) {
    if (legacy.application.rootCommit === undefined || legacy.application.commits === undefined)
      throw reject(`Attempt ${legacy.id} application lineage is incomplete.`);
    attempt.application = {
      ...structuredClone(legacy.application),
      rootCommit: legacy.application.rootCommit,
      commits: [...legacy.application.commits],
    };
  }
  if (legacy.cleanup !== undefined) attempt.cleanup = structuredClone(legacy.cleanup);
  if (legacy.outputRelease !== undefined)
    attempt.outputRelease = structuredClone(legacy.outputRelease);
  if (legacy.attentionHistory !== undefined)
    attempt.attentionHistory = structuredClone(legacy.attentionHistory);
  return attempt;
}

function mapSelection(
  assignment: WorkAssignment,
  attempt: WorkAttempt,
  index: number,
  count: number,
): ModelSelection {
  const models = attempt.models;
  if (models === undefined)
    throw reject(`Attempt ${attempt.id} has no exact selected model target.`);
  if (assignment.capability === "implement") {
    if (models.executor === undefined)
      throw reject(`Implementation Attempt ${attempt.id} has no exact executor target.`);
    return {
      role: "implementation",
      guide: exactTarget(models.guide, attempt.id),
      executor: exactTarget(models.executor, attempt.id),
      source: "policy",
    };
  }
  const selected = models.selection?.selected;
  let target: ModelTarget | undefined;
  if (selected?.length === 1) target = selected[0];
  else if (selected?.length === count) target = selected[index];
  else if (assignment.capability === "consultation") target = models.guide;
  if (target === undefined)
    throw reject(`Attempt ${attempt.id} selected-model allocation is ambiguous.`);
  if (!Value.Equal(target, models.guide))
    throw reject(`Attempt ${attempt.id} guide target conflicts with its selection position.`);
  const role =
    assignment.capability === "consultation"
      ? "consultation"
      : assignment.capability === "review"
        ? "review"
        : "research";
  return { role, target: exactTarget(target, attempt.id), source: "policy" };
}

function exactTarget(target: ModelTarget, _attemptId: string): ModelTarget {
  return structuredClone(target);
}

function retainsBaseRevision(assignment: WorkAssignment): boolean {
  return (
    assignment.capability === "implement" ||
    assignment.artifactIntent === "disposable_experiment" ||
    (assignment.capability === "review" && assignment.subject.kind === "revision")
  );
}

function mapExecution(
  attempt: WorkAttempt,
  sessionRecords: ReadonlyMap<string, string>,
  canonicalSessionPaths: ReadonlyMap<string, string> | undefined,
  ledger: MutableLedger,
): Attempt["execution"] {
  if (attempt.placement === undefined) return undefined;
  const execution: NonNullable<Attempt["execution"]> = {
    placement: structuredClone(attempt.placement),
  };
  if (attempt.sessionFile !== undefined)
    execution.sessionFile = canonicalSessionPaths?.get(attempt.id) ?? attempt.sessionFile;
  if (attempt.worker !== undefined) {
    const { sessionFile: _sessionFile, ...ready } = attempt.worker;
    execution.launch = { phase: "ready", ...structuredClone(ready) };
  } else if (attempt.resource !== undefined) {
    execution.launch = { phase: "resource", ...structuredClone(attempt.resource) };
  } else if (attempt.launchPane !== undefined) {
    execution.launch = { phase: "pane", ...structuredClone(attempt.launchPane) };
  }
  if (attempt.submission !== undefined) execution.submission = attempt.submission;
  if (attempt.steering !== undefined) {
    if (attempt.sessionFile === undefined)
      throw reject(`Attempt ${attempt.id} steering has no session.`);
    const record = sessionRecords.get(attempt.sessionFile);
    if (record === undefined) throw reject(`Attempt ${attempt.id} steering session was not read.`);
    const evidence = uniqueSteeringRecord(
      record,
      attempt.steering.text,
      attempt.id,
      attempt.sessionFile,
    );
    execution.steering = { ...structuredClone(attempt.steering), observedAt: evidence.observedAt };
    ledger.steeringEvidence.push(evidence);
  }
  return execution;
}

function uniqueSteeringRecord(
  jsonl: string,
  text: string,
  attemptId: string,
  sessionFile: string,
): MutableLedger["steeringEvidence"][number] {
  const matches: Array<{ line: number; raw: string; observedAt: string }> = [];
  for (const [index, raw] of jsonl.split("\n").entries()) {
    if (raw === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw reject(`Worker session ${sessionFile} contains malformed JSONL at line ${index + 1}.`);
    }
    if (!isExactUserMessage(value, text)) continue;
    if (!Value.Check(TimestampRecord, value))
      throw reject(`Steering evidence at ${sessionFile}:${index + 1} has no exact timestamp.`);
    matches.push({
      line: index + 1,
      raw,
      observedAt: Value.Decode(TimestampRecord, value).timestamp,
    });
  }
  if (matches.length !== 1)
    throw reject(
      `Attempt ${attemptId} steering has ${matches.length} exact Pi user-message records.`,
    );
  const match = requiredValue(matches[0], `unique steering evidence for ${attemptId}`);
  return {
    attemptId,
    sessionFile,
    line: match.line,
    lineSha256: sha256(match.raw),
    observedAt: match.observedAt,
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSONL input is decoded immediately through the exact Pi user-message schema.
function isExactUserMessage(value: unknown, expected: string): boolean {
  if (!Value.Check(ExactPiUserMessageRecord, value)) return false;
  const message = Value.Decode(ExactPiUserMessageRecord, value).message;
  if (typeof message.content === "string") return message.content === expected;
  return message.content[0].text === expected;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: terminal projection rejects every unsupported Result/Attempt combination explicitly.
function mapOutcome(
  source: WorkstreamState,
  assignment: WorkAssignment,
  attempt: WorkAttempt,
  resultMap: ReadonlyMap<string, string>,
  ledger: MutableLedger,
): Outcome {
  const result =
    attempt.resultId === undefined
      ? undefined
      : source.results.find((item) => item.id === attempt.resultId);
  const delivery =
    result === undefined
      ? undefined
      : source.deliveries.find((item) => item.resultId === result.id);
  if (result !== undefined && resultMap.get(result.id) !== `${attempt.id}:outcome`)
    throw reject(`Result ${result.id} does not map uniquely to Attempt ${attempt.id}.`);
  if (result !== undefined && delivery?.attemptedBy !== undefined)
    ledger.omittedDeliveryAttemptedBy.push({
      resultId: result.id,
      attemptedBy: delivery.attemptedBy,
    });
  const canonicalDelivery = mapDelivery(result?.id, delivery);
  const common = {
    id: `${attempt.id}:outcome`,
    observedAt: result?.observedAt ?? attempt.updatedAt,
    artifacts: structuredClone(result?.artifacts ?? []),
    delivery: canonicalDelivery,
  };
  if (attempt.state === "cancelled") {
    if (attempt.error === undefined)
      throw reject(`Cancelled Attempt ${attempt.id} has no exact reason.`);
    return { ...common, kind: "cancelled", reason: attempt.error };
  }
  if (result === undefined) throw reject(`Terminal Attempt ${attempt.id} has no Result.`);
  if (result.validity === "typed") {
    if (!Value.Check(WorkerReportInputSchema, result.report))
      throw reject(`Result ${result.id} report is not accepted by the canonical report boundary.`);
    const expectedKind =
      assignment.capability === "implement"
        ? "implementation"
        : assignment.capability === "review"
          ? "review"
          : "research";
    if (result.report.kind !== expectedKind)
      throw reject(`Result ${result.id} report kind does not match its Task.`);
    return { ...common, kind: "reported", report: structuredClone(result.report) };
  }
  const reason =
    result.validity === "untyped" ? "Legacy Result retained untyped Worker output." : result.detail;
  const outcome: Extract<Outcome, { kind: "unreported" }> = {
    ...common,
    kind: "unreported",
    reason,
  };
  if (result.validity === "untyped") outcome.rawWorkerText = result.text;
  return outcome;
}

function mapDelivery(
  resultId: string | undefined,
  delivery: WorkstreamState["deliveries"][number] | undefined,
): Delivery {
  if (
    resultId === undefined ||
    delivery === undefined ||
    delivery.state !== "delivered" ||
    delivery.deliveredAt === undefined
  )
    throw reject(`Result ${resultId ?? "<absent>"} is not exactly delivered.`);
  const failures = structuredClone(delivery.failureHistory ?? []);
  return {
    state: "delivered",
    requestedAt: delivery.requestedAt,
    attemptCount: failures.length + 1,
    failureHistory: failures,
    deliveredAt: delivery.deliveredAt,
  };
}

function attemptForResult(source: WorkstreamState, resultId: string): WorkAttempt {
  const matches = source.attempts.filter((attempt) => attempt.resultId === resultId);
  if (matches.length !== 1)
    throw reject(`Result ${resultId} is referenced by ${matches.length} Attempts.`);
  return requiredValue(matches[0], `unique Attempt for Result ${resultId}`);
}

function assertOmittableIntentZero(source: WorkstreamState): void {
  const zero = source.intents[0];
  const one = source.intents[1];
  if (
    zero === undefined ||
    one === undefined ||
    zero.version !== 0 ||
    one.version !== 1 ||
    zero.authorityReceiptIds.length !== 0 ||
    source.assignments.some((assignment) => assignment.intentVersion === 0) ||
    zero.statement !== one.statement
  )
    throw reject("Intent v0 is not the approved ungrounded, Task-free duplicate of Intent v1.");
}

type MutableLedger = {
  -readonly [Key in keyof V7NormalizationLedger]: V7NormalizationLedger[Key] extends ReadonlyArray<
    infer Item
  >
    ? Item[]
    : V7NormalizationLedger[Key];
};

/**
 * TEMPORARY: derive the exact immutable declaration from the retained predecessor
 * pointer without writing either the Pi session or repository storage.
 */
export function declareV7MigrationSource(
  sourcePath: string,
  expectedOwner: CoordinatorIdentity,
): Effect.Effect<V7MigrationDeclaration, V7MigrationError> {
  return Effect.tryPromise({
    try: async () => {
      if (!isAbsolute(sourcePath) || resolve(sourcePath) !== sourcePath)
        throw reject("Retained v7 pointer path must be absolute and normalized.");
      const before = await fileIdentity(sourcePath);
      const { state } = readV7Database(sourcePath);
      const declaration: V7MigrationDeclaration = {
        repository: { projectRoot: state.projectRoot, gitCommonDir: state.gitCommonDir },
        workstreamId: state.id,
        expectedRevision: state.revision,
        expectedSourceSha256: before.sha256,
      };
      validateDeclaration(declaration);
      if (v7MigrationPaths(declaration.repository, declaration.workstreamId).source !== sourcePath)
        throw reject("Retained v7 pointer does not match its repository and Workstream identity.");
      if (!Value.Equal(state.coordinator, expectedOwner))
        throw reject("Retained v7 source belongs to a different coordinator session.");
      if (!Value.Equal(before, await fileIdentity(sourcePath)))
        throw reject("v7 source bytes changed while deriving its declaration.");
      return declaration;
    },
    catch: migrationCause,
  });
}

/** TEMPORARY: confirm the predecessor owner from source or immutable archive. */
export function validateV7MigrationOwner(
  declaration: V7MigrationDeclaration,
  expectedOwner: CoordinatorIdentity,
): Effect.Effect<void, V7MigrationError> {
  return Effect.tryPromise({
    try: async () => {
      validateDeclaration(declaration);
      const paths = v7MigrationPaths(declaration.repository, declaration.workstreamId);
      let source: V7DatabaseRead;
      try {
        source = readV7Database(paths.source);
      } catch (cause) {
        if (!(await exists(paths.archiveDatabase))) throw cause;
        const archive = await fileIdentity(paths.archiveDatabase);
        if (archive.sha256 !== declaration.expectedSourceSha256)
          throw reject("Immutable v7 archive differs from the migration declaration.");
        source = readV7Database(paths.archiveDatabase);
      }
      if (
        source.state.id !== declaration.workstreamId ||
        source.state.revision !== declaration.expectedRevision ||
        source.state.projectRoot !== declaration.repository.projectRoot ||
        source.state.gitCommonDir !== declaration.repository.gitCommonDir ||
        !Value.Equal(source.state.coordinator, expectedOwner)
      )
        throw reject("v7 migration source identity or coordinator owner conflicts.");
    },
    catch: migrationCause,
  });
}

export function preflightV7Migration(
  declaration: V7MigrationDeclaration,
  recordedAt: string,
): Effect.Effect<V7MigrationPreflight, V7MigrationError> {
  return buildV7Preflight(declaration, recordedAt);
}

function buildV7Preflight(
  declaration: V7MigrationDeclaration,
  recordedAt: string,
  preparedOverride?: V7MigrationBreadcrumb,
): Effect.Effect<V7MigrationPreflight, V7MigrationError> {
  return Effect.tryPromise({
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: preflight deliberately keeps all read-only fail-closed checks in one pass.
    try: async () => {
      validateDeclaration(declaration);
      const paths = v7MigrationPaths(declaration.repository, declaration.workstreamId);
      await assertSafePreflightShape(paths, preparedOverride !== undefined);
      const before = await fileIdentity(paths.source);
      if (before.sha256 !== declaration.expectedSourceSha256)
        throw reject("v7 source digest does not match the declared stable source.");
      const { state, rawState } = readV7Database(paths.source);
      if (state.revision !== declaration.expectedRevision)
        throw reject("v7 source revision does not match the declared stable source.");
      if (
        state.id !== declaration.workstreamId ||
        state.projectRoot !== declaration.repository.projectRoot ||
        state.gitCommonDir !== declaration.repository.gitCommonDir ||
        state.statePath !== paths.source
      )
        throw reject(
          "v7 source repository, Workstream, or path identity differs from declaration.",
        );
      const legacySessionDirectory = join(dirname(paths.source), "sessions");
      const sessionFiles = state.attempts.flatMap((attempt) =>
        attempt.sessionFile === undefined ? [] : [attempt.sessionFile],
      );
      if (sessionFiles.length > 0) {
        await assertOrdinaryDirectory(legacySessionDirectory);
        if ((await realpath(legacySessionDirectory)) !== legacySessionDirectory)
          throw reject("Legacy Worker sessions directory is not an exact ordinary directory.");
      }
      if (new Set(sessionFiles).size !== sessionFiles.length)
        throw reject("Multiple Attempts reference the same legacy Worker session.");
      const sessionRecords = new Map<string, string>();
      const targetPaths = new Map<string, string>();
      const sessionCopies: SessionCopyIdentity[] = [];
      for (const attempt of state.attempts) {
        if (attempt.sessionFile === undefined) continue;
        if (!safeSegment(attempt.id))
          throw reject(`Attempt id is not a safe target filename segment: ${attempt.id}.`);
        const legacySession = attempt.sessionFile;
        if (
          !isAbsolute(legacySession) ||
          resolve(legacySession) !== legacySession ||
          dirname(legacySession) !== legacySessionDirectory
        )
          throw reject(
            `Legacy Worker session is not an exact direct child of ${legacySessionDirectory}: ${legacySession}.`,
          );
        await assertOrdinaryFile(legacySession);
        if ((await realpath(legacySession)) !== legacySession)
          throw reject(
            `Legacy Worker session escapes its exact sessions directory: ${legacySession}.`,
          );
        if (attempt.worker?.sessionFile !== legacySession)
          throw reject(`Attempt ${attempt.id} Worker/session identities differ.`);
        const raw = await readFile(legacySession);
        sessionRecords.set(attempt.sessionFile, raw.toString("utf8"));
        const target = join(paths.workerSessionDirectory, `${attempt.id}.jsonl`);
        targetPaths.set(attempt.id, target);
        const sourceIdentity = identity(attempt.sessionFile, raw);
        sessionCopies.push({
          source: sourceIdentity,
          target: { ...sourceIdentity, path: target },
          attemptId: attempt.id,
        });
      }
      if (sessionCopies.length !== sessionFiles.length)
        throw reject("Legacy Worker-session copy inventory is incomplete.");
      if (preparedOverride !== undefined)
        await assertRecoverySessionMembership(paths, sessionCopies);
      const normalized = normalizeV7Workstream(state, sessionRecords, targetPaths);
      const canonicalStateSha256 = sha256(serialize(normalized.state));
      const after = await fileIdentity(paths.source);
      if (!Value.Equal(before, after)) throw reject("v7 source bytes changed during preflight.");
      const derivedPrepared: V7MigrationBreadcrumb = {
        format: BREADCRUMB_FORMAT,
        version: BREADCRUMB_VERSION,
        phase: "prepared",
        migrationId: sha256(`${before.sha256}\n${canonicalStateSha256}`).slice(0, 32),
        declaration: structuredClone(declaration),
        paths,
        canonicalStateSha256,
        recordedAt: canonicalTimestamp(recordedAt, "prepared breadcrumb"),
      };
      const prepared = preparedOverride ?? derivedPrepared;
      if (preparedOverride === undefined) {
        const stagingTemporary = temporaryPath(paths.stagingDatabase, canonicalStateSha256);
        for (const suffix of ["", "-journal", "-wal", "-shm"])
          if (await exists(`${stagingTemporary}${suffix}`))
            throw reject(
              `Pre-existing unowned migration temporary must be absent: ${stagingTemporary}${suffix}.`,
            );
      }
      if (
        preparedOverride !== undefined &&
        (!Value.Equal(
          { ...preparedOverride, recordedAt: derivedPrepared.recordedAt },
          derivedPrepared,
        ) ||
          preparedOverride.phase !== "prepared")
      )
        throw reject(
          "Prepared breadcrumb does not match facts reconstructed from the exact v7 source.",
        );
      const preflight: V7MigrationPreflight = {
        declaration: structuredClone(declaration),
        paths,
        source: state,
        sourceRawState: rawState,
        sourceIdentity: before,
        canonical: normalized.state,
        ledger: normalized.ledger,
        sessions: sessionCopies,
        prepared,
      };
      if (preparedOverride !== undefined) await assertExactRecoveryTemporaryMembership(preflight);
      return preflight;
    },
    catch: migrationCause,
  });
}

export function prepareV7Migration(
  preflight: V7MigrationPreflight,
  breadcrumbs: V7MigrationBreadcrumbPort,
): Effect.Effect<
  V7MigrationManifest,
  V7MigrationError | CanonicalStoreError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: async () => {
        const current = await fileIdentity(preflight.paths.source);
        if (!Value.Equal(current, preflight.sourceIdentity))
          throw reject("v7 source changed after preflight.");
        await ensureBreadcrumb(breadcrumbs, preflight.prepared);
        await tightenOwnedDirectories(preflight.paths, preflight.declaration.repository);
        await mkdir(preflight.paths.archiveDirectory, { recursive: true, mode: DIRECTORY_MODE });
        await chmod(preflight.paths.archiveDirectory, DIRECTORY_MODE);
        await copyExact(
          preflight.paths.source,
          preflight.paths.archiveDatabase,
          preflight.sourceIdentity.sha256,
        );
        await copySessions(preflight.sessions);
      },
      catch: migrationCause,
    });
    const stagingTemporary = temporaryPath(
      preflight.paths.stagingDatabase,
      preflight.prepared.canonicalStateSha256,
    );
    const stagingExists = yield* Effect.tryPromise({
      try: () => exists(preflight.paths.stagingDatabase),
      catch: migrationCause,
    });
    if (stagingExists) {
      yield* CanonicalWorkstreamStore.validateMigrationStaging(
        preflight.paths.stagingDatabase,
        preflight.canonical,
      );
      yield* Effect.tryPromise({
        try: () => removeOwnedTemporaryDatabase(stagingTemporary),
        catch: migrationCause,
      });
    } else {
      yield* Effect.tryPromise({
        try: () => removeOwnedTemporaryDatabase(stagingTemporary),
        catch: migrationCause,
      });
      const imported = yield* CanonicalWorkstreamStore.importStaging(
        stagingTemporary,
        preflight.canonical,
        preflight.paths.stagingDatabase,
      );
      const reread = yield* imported.store.read();
      if (
        reread.revision !== preflight.source.revision ||
        !Value.Equal(reread, preflight.canonical)
      )
        return yield* reject(
          "Canonical staging import did not preserve the exact aggregate revision.",
        );
      yield* CanonicalWorkstreamStore.validateMigrationStaging(
        stagingTemporary,
        preflight.canonical,
        preflight.paths.stagingDatabase,
      );
      yield* Effect.tryPromise({
        try: async () => {
          await syncFile(stagingTemporary);
          await publishNoReplace(stagingTemporary, preflight.paths.stagingDatabase);
          await syncDirectory(dirname(preflight.paths.stagingDatabase));
        },
        catch: migrationCause,
      });
      yield* CanonicalWorkstreamStore.validateMigrationStaging(
        preflight.paths.stagingDatabase,
        preflight.canonical,
      );
    }
    return yield* Effect.tryPromise({
      try: async () => {
        const archive = await fileIdentity(preflight.paths.archiveDatabase);
        const manifest = buildManifest(preflight, archive);
        await writeImmutable(preflight.paths.manifest, serialize(manifest));
        await verifyPreparedArtifacts(preflight, manifest);
        await syncDirectory(preflight.paths.archiveDirectory);
        await syncDirectory(preflight.paths.workerSessionDirectory);
        await syncDirectory(dirname(preflight.paths.stagingDatabase));
        return manifest;
      },
      catch: migrationCause,
    });
  });
}

export type V7RecoveryClassification =
  | "ready"
  | "resume_prepared"
  | "prepared_complete"
  | "commit_record_required"
  | "committed"
  | "ambiguous";

export interface V7RecoveryShape {
  readonly breadcrumb: "absent" | "prepared" | "committed" | "conflicting";
  readonly source: "v7_exact" | "canonical_exact" | "absent" | "conflicting";
  readonly archive: "absent" | "v7_exact" | "conflicting";
  readonly stage: "absent" | "canonical_exact" | "conflicting";
  readonly manifest: "absent" | "exact" | "conflicting";
  readonly sessions: "absent" | "exact" | "conflicting";
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: supported crash shapes are enumerated directly and every other conjunction is ambiguous.
export function classifyV7MigrationRecovery(shape: V7RecoveryShape): V7RecoveryClassification {
  if (
    shape.breadcrumb === "conflicting" ||
    shape.source === "conflicting" ||
    shape.archive === "conflicting" ||
    shape.stage === "conflicting" ||
    shape.manifest === "conflicting" ||
    shape.sessions === "conflicting"
  )
    return "ambiguous";
  if (shape.breadcrumb === "absent")
    return shape.source === "v7_exact" &&
      shape.archive === "absent" &&
      shape.stage === "absent" &&
      shape.manifest === "absent" &&
      shape.sessions === "absent"
      ? "ready"
      : "ambiguous";
  if (shape.breadcrumb === "prepared") {
    if (
      shape.source === "canonical_exact" &&
      shape.archive === "v7_exact" &&
      shape.stage === "absent" &&
      shape.manifest === "exact" &&
      shape.sessions === "exact"
    )
      return "commit_record_required";
    if (shape.source !== "v7_exact") return "ambiguous";
    if (
      shape.archive === "v7_exact" &&
      shape.stage === "canonical_exact" &&
      shape.manifest === "exact" &&
      shape.sessions === "exact"
    )
      return "prepared_complete";
    const resumable =
      (shape.archive === "absent" || shape.archive === "v7_exact") &&
      (shape.stage === "absent" || shape.stage === "canonical_exact") &&
      (shape.manifest === "absent" || shape.manifest === "exact") &&
      (shape.sessions === "absent" || shape.sessions === "exact");
    return resumable ? "resume_prepared" : "ambiguous";
  }
  return shape.source === "canonical_exact" &&
    shape.archive === "v7_exact" &&
    shape.stage === "absent" &&
    shape.manifest === "exact" &&
    shape.sessions === "exact"
    ? "committed"
    : "ambiguous";
}

/** TEMPORARY: read-only proof used when an attached canonical pointer already exists. */
export function confirmCommittedV7Migration(
  declaration: V7MigrationDeclaration,
  breadcrumbs: V7MigrationBreadcrumbPort,
): Effect.Effect<V7MigrationBreadcrumb, V7MigrationError> {
  return Effect.tryPromise({
    try: async () => {
      validateDeclaration(declaration);
      const paths = v7MigrationPaths(declaration.repository, declaration.workstreamId);
      const all = await readBreadcrumbs(breadcrumbs);
      const relevant = all.filter(
        (record) =>
          record.declaration.workstreamId === declaration.workstreamId ||
          record.paths.source === paths.source ||
          record.paths.target === paths.target,
      );
      if (relevant.length !== 2)
        throw reject(
          "Attached canonical pointer requires exact prepared and committed breadcrumbs.",
        );
      const prepared = requiredValue(relevant[0], "prepared migration breadcrumb");
      if (
        prepared.phase !== "prepared" ||
        !Value.Equal(prepared.declaration, declaration) ||
        !Value.Equal(prepared.paths, paths)
      )
        throw reject("Attached canonical pointer has conflicting migration history.");
      const history = await migrationBreadcrumbHistory(breadcrumbs, prepared);
      const recovered = await reconstructRecoveryPreflight(declaration, prepared);
      const shape = await inspectRecoveryShape(recovered, history);
      if (classifyV7MigrationRecovery(shape) !== "committed")
        throw reject("Attached canonical pointer migration is not durably committed.");
      return requiredValue(history[1], "committed migration breadcrumb");
    },
    catch: migrationCause,
  });
}

/** Restart-safe public driver. It derives durable state rather than trusting caller-held preflight data. */
export function recoverV7Migration(
  declaration: V7MigrationDeclaration,
  breadcrumbs: V7MigrationBreadcrumbPort,
  recordedAt: string,
): Effect.Effect<
  V7MigrationBreadcrumb,
  V7MigrationError | CanonicalStoreError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  return Effect.gen(function* () {
    const history = yield* Effect.tryPromise({
      try: async () => {
        validateDeclaration(declaration);
        const paths = v7MigrationPaths(declaration.repository, declaration.workstreamId);
        const all = await readBreadcrumbs(breadcrumbs);
        const relevant = all.filter(
          (record) =>
            record.declaration.workstreamId === declaration.workstreamId ||
            record.paths.source === paths.source ||
            record.paths.target === paths.target,
        );
        if (relevant.length === 0) return [];
        const prepared = requiredValue(relevant[0], "prepared migration breadcrumb");
        if (prepared.phase !== "prepared")
          throw reject("Migration breadcrumb history does not begin with prepared.");
        if (!Value.Equal(prepared.declaration, declaration) || !Value.Equal(prepared.paths, paths))
          throw reject("Another migration identity claims this declaration or path.");
        return [...(await migrationBreadcrumbHistory(breadcrumbs, prepared))];
      },
      catch: migrationCause,
    });
    if (history.length === 0) {
      const fresh = yield* buildV7Preflight(declaration, recordedAt);
      yield* prepareV7Migration(fresh, breadcrumbs);
      return yield* commitV7Migration(fresh, breadcrumbs, recordedAt);
    }
    const prepared = requiredValue(history[0], "prepared migration breadcrumb");
    const recovered = yield* Effect.tryPromise({
      try: () => reconstructRecoveryPreflight(declaration, prepared),
      catch: migrationCause,
    });
    const shape = yield* Effect.tryPromise({
      try: () => inspectRecoveryShape(recovered, history),
      catch: migrationCause,
    });
    const classification = classifyV7MigrationRecovery(shape);
    if (classification === "ambiguous")
      return yield* reject("Migration restart state is ambiguous.");
    if (classification === "committed") return requiredValue(history[1], "committed breadcrumb");
    if (classification === "ready")
      return yield* reject("Prepared recovery unexpectedly classified ready.");
    if (classification === "resume_prepared") yield* prepareV7Migration(recovered, breadcrumbs);
    return yield* commitV7Migration(recovered, breadcrumbs, recordedAt);
  });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: restart reconstruction validates each immutable cross-artifact identity at one boundary.
async function reconstructRecoveryPreflight(
  declaration: V7MigrationDeclaration,
  prepared: V7MigrationBreadcrumb,
): Promise<V7MigrationPreflight> {
  try {
    readV7Database(prepared.paths.source);
    return await Effect.runPromise(buildV7Preflight(declaration, prepared.recordedAt, prepared));
  } catch (sourceCause) {
    if (!(await exists(prepared.paths.manifest))) throw sourceCause;
    const value: unknown = JSON.parse(await readFile(prepared.paths.manifest, "utf8"));
    // SAFETY: The fields consumed before deeper use are checked below, and complete manifest equality is checked by inspectRecoveryShape before mutation.
    const manifest = value as V7MigrationManifest;
    if (
      manifest.format !== MANIFEST_FORMAT ||
      manifest.version !== MANIFEST_VERSION ||
      !Value.Equal(manifest.prepared, prepared) ||
      !Value.Equal(manifest.repository, declaration.repository) ||
      manifest.workstreamId !== declaration.workstreamId
    )
      throw reject("Recovery manifest identity is malformed or conflicting.");
    const archive = await fileIdentity(prepared.paths.archiveDatabase);
    if (
      !sameBytes(archive, manifest.archive) ||
      archive.sha256 !== declaration.expectedSourceSha256
    )
      throw reject("Recovery archive does not match the declared immutable v7 source.");
    const database = readV7Database(prepared.paths.archiveDatabase);
    const sessionRecords = new Map<string, string>();
    const targetPaths = new Map<string, string>();
    for (const session of manifest.sessions) {
      const bytes = await readFile(session.target.path);
      if (
        digestIdentity(bytes) !== session.target.sha256 ||
        bytes.byteLength !== session.target.size
      )
        throw reject(`Recovery Worker session differs: ${session.attemptId}.`);
      sessionRecords.set(session.source.path, bytes.toString("utf8"));
      targetPaths.set(session.attemptId, session.target.path);
    }
    const normalized = normalizeV7Workstream(database.state, sessionRecords, targetPaths);
    const canonicalStateSha256 = sha256(serialize(normalized.state));
    if (canonicalStateSha256 !== prepared.canonicalStateSha256)
      throw reject("Recovery canonical projection differs from its prepared breadcrumb.");
    return {
      declaration: structuredClone(declaration),
      paths: prepared.paths,
      source: database.state,
      sourceRawState: database.rawState,
      sourceIdentity: { ...manifest.source, path: prepared.paths.source },
      canonical: normalized.state,
      ledger: normalized.ledger,
      sessions: manifest.sessions,
      prepared,
    };
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: recovery classification observes every durable crash-shape dimension explicitly.
async function inspectRecoveryShape(
  preflight: V7MigrationPreflight,
  history: readonly V7MigrationBreadcrumb[],
): Promise<V7RecoveryShape> {
  const source = (() => {
    try {
      const identity = fileIdentitySync(preflight.paths.source);
      if (sameBytes(identity, preflight.sourceIdentity)) return "v7_exact" as const;
      const canonical = validateCanonicalDatabase(preflight.paths.source, preflight.canonical);
      return canonical.stateSha256 === preflight.prepared.canonicalStateSha256
        ? ("canonical_exact" as const)
        : ("conflicting" as const);
    } catch {
      return "conflicting" as const;
    }
  })();
  const archive = !(await exists(preflight.paths.archiveDatabase))
    ? "absent"
    : sameBytes(await fileIdentity(preflight.paths.archiveDatabase), preflight.sourceIdentity)
      ? "v7_exact"
      : "conflicting";
  let stage: V7RecoveryShape["stage"] = "absent";
  if (await exists(preflight.paths.stagingDatabase)) {
    try {
      validateCanonicalDatabase(preflight.paths.stagingDatabase, preflight.canonical);
      stage = "canonical_exact";
    } catch {
      stage = "conflicting";
    }
  }
  let manifest: V7RecoveryShape["manifest"] = "absent";
  if (await exists(preflight.paths.manifest)) {
    try {
      const archiveIdentity = await fileIdentity(preflight.paths.archiveDatabase);
      const parsed: unknown = JSON.parse(await readFile(preflight.paths.manifest, "utf8"));
      manifest = Value.Equal(parsed, buildManifest(preflight, archiveIdentity))
        ? "exact"
        : "conflicting";
    } catch {
      manifest = "conflicting";
    }
  }
  let sessions: V7RecoveryShape["sessions"] = preflight.sessions.length === 0 ? "exact" : "absent";
  if (preflight.sessions.length > 0) {
    const present = await Promise.all(
      preflight.sessions.map((session) => exists(session.target.path)),
    );
    if (present.every(Boolean))
      sessions = (
        await Promise.all(
          preflight.sessions.map(async (session) =>
            sameBytes(await fileIdentity(session.target.path), session.source),
          ),
        )
      ).every(Boolean)
        ? "exact"
        : "conflicting";
    else if (present.some(Boolean)) sessions = "absent";
  }
  return {
    breadcrumb: history.length === 2 ? "committed" : "prepared",
    source,
    archive,
    stage,
    manifest,
    sessions,
  };
}

function fileIdentitySync(path: string): FileIdentity {
  const bytes = readFileSyncBytes(path);
  return identity(path, bytes);
}

function readFileSyncBytes(path: string): Uint8Array {
  const descriptor = openSync(path, "r");
  try {
    const size = fstatSync(descriptor).size;
    const bytes = new Uint8Array(size);
    readSync(descriptor, bytes, 0, size, 0);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function digestIdentity(bytes: Uint8Array): string {
  return sha256(bytes);
}

export function commitV7Migration(
  preflight: V7MigrationPreflight,
  breadcrumbs: V7MigrationBreadcrumbPort,
  recordedAt: string,
): Effect.Effect<V7MigrationBreadcrumb, V7MigrationError> {
  return Effect.tryPromise({
    try: async () => {
      await confirmBreadcrumb(breadcrumbs, preflight.prepared);
      const archive = await fileIdentity(preflight.paths.archiveDatabase);
      const stageExists = await exists(preflight.paths.stagingDatabase);
      await verifyPreparedArtifacts(preflight, buildManifest(preflight, archive), stageExists);
      if (stageExists) {
        const source = await fileIdentity(preflight.paths.source);
        const stage = await fileIdentity(preflight.paths.stagingDatabase);
        if (!Value.Equal(source, preflight.sourceIdentity))
          throw reject("Commit source is not the exact prepared v7 database.");
        if (stage.size === 0) throw reject("Commit staging database is empty.");
        validateCanonicalDatabase(preflight.paths.stagingDatabase, preflight.canonical);
        await syncFile(preflight.paths.archiveDatabase);
        await syncFile(preflight.paths.manifest);
        for (const session of preflight.sessions) await syncFile(session.target.path);
        await syncFile(preflight.paths.stagingDatabase);
        await syncDirectory(preflight.paths.archiveDirectory);
        await syncDirectory(preflight.paths.workerSessionDirectory);
        await syncDirectory(dirname(preflight.paths.target));
        await rename(preflight.paths.stagingDatabase, preflight.paths.target);
        await syncDirectory(dirname(preflight.paths.target));
      } else {
        validateCanonicalDatabase(preflight.paths.target, preflight.canonical);
      }
      const committed: V7MigrationBreadcrumb = {
        ...preflight.prepared,
        phase: "committed",
        recordedAt: canonicalTimestamp(recordedAt, "committed breadcrumb"),
      };
      await ensureBreadcrumb(breadcrumbs, committed);
      return committed;
    },
    catch: migrationCause,
  });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: path safety checks enumerate every owned migration location explicitly.
async function assertSafePreflightShape(paths: V7MigrationPaths, recovery: boolean): Promise<void> {
  const workstreamDirectory = dirname(paths.source);
  for (const directory of [
    dirname(dirname(dirname(workstreamDirectory))),
    dirname(dirname(workstreamDirectory)),
    dirname(workstreamDirectory),
    workstreamDirectory,
  ])
    await assertOrdinaryDirectory(directory);
  await assertOrdinaryFile(paths.source);
  for (const suffix of ["-journal", "-wal", "-shm"])
    if (await exists(`${paths.source}${suffix}`))
      throw reject(`v7 source has an uncertain SQLite sidecar: ${paths.source}${suffix}.`);
  if (!recovery)
    for (const absent of [
      paths.archiveDirectory,
      paths.archiveDatabase,
      paths.manifest,
      paths.stagingDatabase,
    ])
      if (await exists(absent)) throw reject(`Migration destination must be absent: ${absent}.`);
  if (recovery) await assertRecoveryArtifactMembership(paths);
  const workerSessionsParent = dirname(paths.workerSessionDirectory);
  if (await exists(workerSessionsParent)) await assertOrdinaryDirectory(workerSessionsParent);
  if (await exists(paths.workerSessionDirectory)) {
    await assertOrdinaryDirectory(paths.workerSessionDirectory);
    const entries = await readdir(paths.workerSessionDirectory);
    if (!recovery && entries.length > 0)
      throw reject("Canonical Worker-session destination is not empty.");
  }
}

async function assertRecoveryArtifactMembership(paths: V7MigrationPaths): Promise<void> {
  const workstreamEntries = await readdir(dirname(paths.source));
  const allowed = new Set([
    basename(paths.source),
    basename(paths.stagingDatabase),
    basename(paths.archiveDirectory),
    "sessions",
  ]);
  const stagingTemporaryPrefix = `${basename(paths.stagingDatabase)}.migration-tmp-`;
  for (const entry of workstreamEntries)
    if (!allowed.has(entry) && !entry.startsWith(stagingTemporaryPrefix))
      throw reject(`Foreign migration artifact in Workstream directory: ${entry}.`);
  if (await exists(paths.archiveDirectory)) {
    await assertOrdinaryDirectory(paths.archiveDirectory);
    const exact = [basename(paths.archiveDatabase), basename(paths.manifest)];
    for (const entry of await readdir(paths.archiveDirectory))
      if (
        !exact.includes(entry) &&
        !exact.some((name) => entry.startsWith(`${name}.migration-tmp-`))
      )
        throw reject(`Foreign migration archive artifact: ${entry}.`);
  }
}

async function assertRecoverySessionMembership(
  paths: V7MigrationPaths,
  sessions: readonly SessionCopyIdentity[],
): Promise<void> {
  if (!(await exists(paths.workerSessionDirectory))) return;
  const allowed = new Set(
    sessions.flatMap((session) => [
      basename(session.target.path),
      basename(temporaryPath(session.target.path, session.source.sha256)),
    ]),
  );
  for (const entry of await readdir(paths.workerSessionDirectory))
    if (!allowed.has(entry)) throw reject(`Foreign canonical Worker-session artifact: ${entry}.`);
}

async function assertExactRecoveryTemporaryMembership(
  preflight: V7MigrationPreflight,
): Promise<void> {
  const stagingTemporary = temporaryPath(
    preflight.paths.stagingDatabase,
    preflight.prepared.canonicalStateSha256,
  );
  const allowedWorkstream = new Set([
    basename(preflight.paths.source),
    basename(preflight.paths.stagingDatabase),
    basename(preflight.paths.archiveDirectory),
    "sessions",
    basename(stagingTemporary),
    ...["-journal", "-wal", "-shm"].map((suffix) => basename(`${stagingTemporary}${suffix}`)),
  ]);
  for (const entry of await readdir(dirname(preflight.paths.source)))
    if (!allowedWorkstream.has(entry))
      throw reject(`Foreign migration artifact in Workstream directory: ${entry}.`);

  if (!(await exists(preflight.paths.archiveDirectory))) return;
  const allowedArchive = new Set([
    basename(preflight.paths.archiveDatabase),
    basename(preflight.paths.manifest),
    basename(temporaryPath(preflight.paths.archiveDatabase, preflight.sourceIdentity.sha256)),
  ]);
  if (await exists(preflight.paths.archiveDatabase)) {
    const archive = await fileIdentity(preflight.paths.archiveDatabase);
    if (sameBytes(archive, preflight.sourceIdentity))
      allowedArchive.add(
        basename(
          temporaryPath(
            preflight.paths.manifest,
            sha256(serialize(buildManifest(preflight, archive))),
          ),
        ),
      );
  }
  for (const entry of await readdir(preflight.paths.archiveDirectory))
    if (!allowedArchive.has(entry)) throw reject(`Foreign migration archive artifact: ${entry}.`);
}

interface V7DatabaseRead {
  readonly state: WorkstreamState;
  readonly rawState: string;
}

function readV7Database(path: string): V7DatabaseRead {
  const bytes = requireSqliteHeader(path);
  if (!bytes) throw reject("v7 source is not SQLite.");
  using database = new DatabaseSync(path, { readOnly: true });
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => Value.Decode(NameRow, row).name);
  if (!Value.Equal(tables, ["lease", "workstream_state"]))
    throw reject("v7 source has an unexpected SQLite schema shape.");
  const columns = (table: string) =>
    database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => Value.Decode(NameRow, row).name);
  if (
    !Value.Equal(columns("workstream_state"), ["singleton", "state_json", "revision"]) ||
    !Value.Equal(columns("lease"), [
      "singleton",
      "token",
      "owner_session_id",
      "owner_session_file",
      "acquired_at",
      "heartbeat_at",
      "expires_at",
    ])
  )
    throw reject("v7 source has unexpected SQLite columns.");
  const leaseRow = database.prepare("SELECT COUNT(*) AS count FROM lease").get();
  if (!Value.Check(LeaseCountRow, leaseRow) || Value.Decode(LeaseCountRow, leaseRow).count !== 0)
    throw reject("v7 predecessor lease is present or malformed.");
  const row = database
    .prepare("SELECT state_json, revision FROM workstream_state WHERE singleton=1")
    .get();
  if (!Value.Check(StateRow, row)) throw reject("v7 aggregate row is missing or malformed.");
  const decoded = Value.Decode(StateRow, row);
  let value: unknown;
  try {
    value = JSON.parse(decoded.state_json);
  } catch {
    throw reject("v7 aggregate JSON is malformed.");
  }
  if (!Value.Check(WorkstreamStateSchema, value))
    throw reject("v7 aggregate does not strictly match schema version 7.");
  const state = Value.Decode(WorkstreamStateSchema, value);
  validateState(state);
  if (state.revision !== decoded.revision) throw reject("v7 aggregate and row revisions differ.");
  return { state, rawState: decoded.state_json };
}

async function copySessions(sessions: readonly SessionCopyIdentity[]): Promise<void> {
  const directories = new Set(sessions.map((session) => dirname(session.target.path)));
  for (const directory of directories) await assertPrivateDirectory(directory);
  for (const session of sessions)
    await copyExact(session.source.path, session.target.path, session.source.sha256);
  const copied = await Promise.all(sessions.map((session) => fileIdentity(session.target.path)));
  if (
    copied.length !== sessions.length ||
    copied.some((item, index) => {
      const session = sessions[index];
      return session === undefined || !sameBytes(item, session.source);
    })
  )
    throw reject("Canonical Worker-session copy count or byte identity differs.");
}

async function copyExact(source: string, target: string, expectedSha256: string): Promise<void> {
  await assertOrdinaryFile(source);
  if (await exists(target)) {
    const collision = await fileIdentity(target);
    if (
      collision.sha256 === expectedSha256 &&
      collision.size === (await stat(source)).size &&
      (await byteEqual(source, target))
    )
      return;
    throw reject(`Conflicting migration collision at ${target}.`);
  }
  const temporary = temporaryPath(target, expectedSha256);
  try {
    const copied = await prepareTemporaryCopy(source, temporary, expectedSha256, target);
    try {
      await publishNoReplace(temporary, target);
      await syncDirectory(dirname(target));
    } catch (cause) {
      if (await exists(target)) {
        const collision = await fileIdentity(target);
        if (
          collision.sha256 === expectedSha256 &&
          collision.size === copied.size &&
          (await byteEqual(source, target))
        )
          return;
      }
      throw cause;
    }
  } finally {
    await removeOwnedTemporaryFile(temporary);
  }
}

async function prepareTemporaryCopy(
  source: string,
  temporary: string,
  expectedSha256: string,
  target: string,
): Promise<FileIdentity> {
  if (await exists(temporary)) {
    await assertOrdinaryFile(temporary);
    const residue = await fileIdentity(temporary);
    if (residue.sha256 !== expectedSha256 || !(await byteEqual(source, temporary)))
      await removeOwnedTemporaryFile(temporary);
  }
  if (!(await exists(temporary))) {
    await copyFile(source, temporary, 1);
    await chmod(temporary, FILE_MODE);
    await syncFile(temporary);
  }
  const copied = await fileIdentity(temporary);
  if (copied.sha256 !== expectedSha256 || !(await byteEqual(source, temporary)))
    throw reject(`Temporary copy bytes or digest differ for ${target}.`);
  return copied;
}

async function writeImmutable(path: string, contents: string): Promise<void> {
  if (await exists(path)) {
    const existing = await readFile(path, "utf8");
    if (existing === contents) return;
    throw reject(`Conflicting immutable migration artifact: ${path}.`);
  }
  const temporary = temporaryPath(path, sha256(contents));
  try {
    if (await exists(temporary)) {
      await assertOrdinaryFile(temporary);
      if ((await readFile(temporary, "utf8")) !== contents)
        await removeOwnedTemporaryFile(temporary);
    }
    if (!(await exists(temporary)))
      await writeFile(temporary, contents, { flag: "wx", mode: FILE_MODE });
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await publishNoReplace(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await removeOwnedTemporaryFile(temporary);
  }
}

function buildManifest(
  preflight: V7MigrationPreflight,
  archive: FileIdentity,
): V7MigrationManifest {
  return {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    repository: structuredClone(preflight.declaration.repository),
    workstreamId: preflight.declaration.workstreamId,
    source: {
      ...preflight.sourceIdentity,
      revision: preflight.source.revision,
      stateSha256: sha256(preflight.sourceRawState),
    },
    archive,
    rawState: preflight.sourceRawState,
    receipts: structuredClone(preflight.source.inputs),
    ledger: structuredClone(preflight.ledger),
    sessions: structuredClone(preflight.sessions),
    canonicalStateSha256: preflight.prepared.canonicalStateSha256,
    prepared: structuredClone(preflight.prepared),
    committedIdentity: {
      migrationId: preflight.prepared.migrationId,
      phase: "committed",
      canonicalStateSha256: preflight.prepared.canonicalStateSha256,
    },
  };
}

async function verifyPreparedArtifacts(
  preflight: V7MigrationPreflight,
  manifest: V7MigrationManifest,
  requireV7Source = true,
): Promise<void> {
  const archive = await fileIdentity(preflight.paths.archiveDatabase);
  if (!sameBytes(preflight.sourceIdentity, archive))
    throw reject("Prepared archive digest or size differs from the stable v7 source.");
  if (requireV7Source) {
    const source = await fileIdentity(preflight.paths.source);
    if (
      !Value.Equal(source, preflight.sourceIdentity) ||
      !(await byteEqual(preflight.sourceIdentity.path, archive.path))
    )
      throw reject("Prepared archive is not byte-identical to the stable v7 source.");
  }
  for (const session of manifest.sessions) {
    const target = await fileIdentity(session.target.path);
    if (
      !sameBytes(session.source, target) ||
      (requireV7Source && !(await byteEqual(session.source.path, target.path)))
    )
      throw reject(`Worker session copy differs: ${session.attemptId}.`);
  }
  const parsed: unknown = JSON.parse(await readFile(preflight.paths.manifest, "utf8"));
  if (!Value.Equal(parsed, manifest)) throw reject("Immutable manifest readback differs.");
}

async function tightenOwnedDirectories(
  paths: V7MigrationPaths,
  repository: RepositoryIdentity,
): Promise<void> {
  const exact = [
    join(repository.gitCommonDir, "pi-workgraph"),
    join(repository.gitCommonDir, "pi-workgraph", "workstreams"),
    dirname(paths.source),
  ];
  const workerDirectories = [dirname(paths.workerSessionDirectory), paths.workerSessionDirectory];
  for (const directory of [...exact, ...workerDirectories]) {
    const resolved = resolve(directory);
    const boundary = resolve(repository.gitCommonDir);
    const relative = resolved.slice(boundary.length);
    if (resolved === boundary || !relative.startsWith(sep))
      throw reject("Refusing to chmod outside current repository Workgraph storage.");
    if (workerDirectories.includes(directory))
      await mkdir(directory, { recursive: false, mode: DIRECTORY_MODE }).catch(
        async (cause: unknown) => {
          if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
        },
      );
    await chmod(directory, DIRECTORY_MODE);
    await assertPrivateDirectory(directory);
  }
}

async function ensureBreadcrumb(
  port: V7MigrationBreadcrumbPort,
  expected: V7MigrationBreadcrumb,
): Promise<void> {
  let history = await migrationBreadcrumbHistory(port, expected);
  const existing = history.find((record) => record.phase === expected.phase);
  if (existing === undefined) {
    if (expected.phase === "committed" && history.length !== 1)
      throw reject("Committed migration breadcrumb requires one exact prepared predecessor.");
    await port.append(expected);
    history = await migrationBreadcrumbHistory(port, expected);
  } else if (!Value.Equal(existing, expected)) {
    throw reject(`Durable ${expected.phase} migration breadcrumb conflicts.`);
  }
  const matches = history.filter((record) => record.phase === expected.phase);
  if (matches.length !== 1 || !Value.Equal(matches[0], expected))
    throw reject(`Durable ${expected.phase} migration breadcrumb was not confirmed exactly once.`);
}

async function confirmBreadcrumb(
  port: V7MigrationBreadcrumbPort,
  expected: V7MigrationBreadcrumb,
): Promise<void> {
  const records = await migrationBreadcrumbHistory(port, expected);
  const match = records.filter((record) => record.phase === expected.phase);
  if (match.length !== 1 || !Value.Equal(match[0], expected))
    throw reject(`Durable ${expected.phase} migration breadcrumb was not confirmed exactly once.`);
}

async function migrationBreadcrumbHistory(
  port: V7MigrationBreadcrumbPort,
  expected: V7MigrationBreadcrumb,
): Promise<readonly V7MigrationBreadcrumb[]> {
  const all = await readBreadcrumbs(port);
  const relevant = all.filter(
    (record) =>
      record.declaration.workstreamId === expected.declaration.workstreamId ||
      record.paths.source === expected.paths.source ||
      record.paths.target === expected.paths.target,
  );
  for (const record of relevant)
    if (
      record.migrationId !== expected.migrationId ||
      !Value.Equal(record.declaration, expected.declaration) ||
      !Value.Equal(record.paths, expected.paths) ||
      record.canonicalStateSha256 !== expected.canonicalStateSha256
    )
      throw reject("Another migration identity claims this Workstream declaration or path.");
  if (
    relevant.length > 2 ||
    (relevant.length > 0 && relevant[0]?.phase !== "prepared") ||
    (relevant.length === 2 && relevant[1]?.phase !== "committed")
  )
    throw reject(
      "Migration breadcrumb history is not one prepared then at most one committed record.",
    );
  return relevant;
}

async function readBreadcrumbs(
  port: V7MigrationBreadcrumbPort,
): Promise<readonly V7MigrationBreadcrumb[]> {
  const records = await port.read();
  for (const record of records)
    if (!Value.Check(V7MigrationBreadcrumbSchema, record))
      throw reject("Migration breadcrumb host returned a malformed record.");
  return records;
}

interface ValidatedCanonicalDatabase {
  readonly state: Workstream;
  readonly stateSha256: string;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: replay validation intentionally covers the complete canonical file boundary in one read.
function validateCanonicalDatabase(
  path: string,
  expected?: Workstream,
): ValidatedCanonicalDatabase {
  if (!requireSqliteHeader(path)) throw reject("Canonical database has no exact SQLite header.");
  const mode = statSyncMode(path);
  if (mode !== FILE_MODE) throw reject(`Canonical database is not private: ${path}.`);
  using database = new DatabaseSync(path, { readOnly: true });
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => Value.Decode(NameRow, row).name);
  if (!Value.Equal(tables, ["lease", "store_header", "workstream"]))
    throw reject("Canonical database has an unexpected schema shape.");
  const columns = (table: string) =>
    database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => Value.Decode(NameRow, row).name);
  if (
    !Value.Equal(columns("store_header"), ["singleton", "format", "version"]) ||
    !Value.Equal(columns("workstream"), ["singleton", "state_json", "revision"]) ||
    !Value.Equal(columns("lease"), [
      "singleton",
      "token",
      "owner_session_id",
      "owner_session_file",
      "acquired_at",
      "heartbeat_at",
      "expires_at",
    ])
  )
    throw reject("Canonical database has unexpected columns.");
  const headerValue = database
    .prepare("SELECT format, version FROM store_header WHERE singleton=1")
    .get();
  if (!Value.Check(CanonicalHeaderRow, headerValue))
    throw reject("Canonical database header is missing or malformed.");
  const header = Value.Decode(CanonicalHeaderRow, headerValue);
  if (header.format !== "pi-workgraph-workstream-sqlite" || header.version !== 2)
    throw reject("Canonical database header is unsupported.");
  const leases = database.prepare("SELECT COUNT(*) AS count FROM lease").get();
  if (!Value.Check(LeaseCountRow, leases) || Value.Decode(LeaseCountRow, leases).count !== 0)
    throw reject("Canonical migration database unexpectedly contains a lease.");
  const row = database
    .prepare("SELECT state_json, revision FROM workstream WHERE singleton=1")
    .get();
  if (!Value.Check(StateRow, row)) throw reject("Canonical aggregate row is missing or malformed.");
  const decoded = Value.Decode(StateRow, row);
  let value: unknown;
  try {
    value = JSON.parse(decoded.state_json);
  } catch {
    throw reject("Canonical aggregate JSON is malformed.");
  }
  if (!Value.Check(WorkstreamSchema, value))
    throw reject("Canonical aggregate does not match the current Workstream schema.");
  const state = Value.Decode(WorkstreamSchema, value);
  validateWorkstream(state);
  if (state.revision !== decoded.revision)
    throw reject("Canonical aggregate and row revisions differ.");
  if (expected !== undefined && !Value.Equal(state, expected))
    throw reject("Canonical migration database differs from the complete expected aggregate.");
  return { state, stateSha256: sha256(decoded.state_json) };
}

function statSyncMode(path: string): number {
  const descriptor = openSync(path, "r");
  try {
    return fstatSync(descriptor).mode & 0o777;
  } finally {
    closeSync(descriptor);
  }
}

function temporaryPath(target: string, identity: string): string {
  return `${target}.migration-tmp-${sha256(identity).slice(0, 16)}`;
}

async function publishNoReplace(temporary: string, target: string): Promise<void> {
  await link(temporary, target);
  await unlink(temporary);
}

async function removeOwnedTemporaryFile(path: string): Promise<void> {
  if (!(await exists(path))) return;
  await assertOrdinaryFile(path);
  await rm(path);
}

async function removeOwnedTemporaryDatabase(path: string): Promise<void> {
  for (const artifact of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`])
    await removeOwnedTemporaryFile(artifact);
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fileIdentity(path: string): Promise<FileIdentity> {
  await assertOrdinaryFile(path);
  const bytes = await readFile(path);
  return identity(path, bytes);
}
function identity(path: string, bytes: Uint8Array): FileIdentity {
  return { path, size: bytes.byteLength, sha256: sha256(bytes) };
}
function sameBytes(
  left: Pick<FileIdentity, "size" | "sha256">,
  right: Pick<FileIdentity, "size" | "sha256">,
): boolean {
  return left.size === right.size && left.sha256 === right.sha256;
}
async function byteEqual(left: string, right: string): Promise<boolean> {
  const [leftBytes, rightBytes] = await Promise.all([readFile(left), readFile(right)]);
  return leftBytes.equals(rightBytes);
}
async function assertOrdinaryFile(path: string): Promise<void> {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink())
    throw reject(`Migration source is not an ordinary file: ${path}.`);
}
async function assertOrdinaryDirectory(path: string): Promise<void> {
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink() || (await realpath(path)) !== path)
    throw reject(`Migration path component is not an exact ordinary directory: ${path}.`);
}
async function assertPrivateDirectory(path: string): Promise<void> {
  await assertOrdinaryDirectory(path);
  if (((await lstat(path)).mode & 0o777) !== DIRECTORY_MODE)
    throw reject(`Migration directory is not private: ${path}.`);
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}
function requireSqliteHeader(path: string): boolean {
  const header = new Uint8Array(16);
  const descriptor = openSync(path, "r");
  try {
    readSync(descriptor, header, 0, header.length, 0);
  } finally {
    closeSync(descriptor);
  }
  return new TextDecoder().decode(header) === SQLITE_HEADER;
}
function canonicalLifecycle(value: WorkstreamState["lifecycle"]["state"]): Workstream["lifecycle"] {
  if (value === "active") return value;
  throw reject(`Legacy lifecycle ${value} is not the one active migration source.`);
}

function assertNoOutstandingObligation(attempt: WorkAttempt): void {
  if (attempt.cleanup?.state === "pending" || attempt.cleanup?.state === "blocked")
    throw reject(`Attempt ${attempt.id} retains an unresolved cleanup obligation.`);
  if (attempt.cleanup?.state !== "completed")
    throw reject(`Attempt ${attempt.id} has no exact completed cleanup evidence.`);
  if (attempt.application?.state === "pending" || attempt.application?.state === "blocked")
    throw reject(`Attempt ${attempt.id} retains an unresolved application obligation.`);
  if (attempt.outputRelease?.state === "pending" || attempt.outputRelease?.state === "blocked")
    throw reject(`Attempt ${attempt.id} retains an unresolved output-release obligation.`);
  if (
    attempt.outputRelease?.state === "completed" &&
    attempt.cleanup.expectedHead !== attempt.outputRelease.expectedHead
  )
    throw reject(`Attempt ${attempt.id} completed cleanup and output-release identities differ.`);
}
function validateDeclaration(declaration: V7MigrationDeclaration): void {
  for (const path of [declaration.repository.projectRoot, declaration.repository.gitCommonDir])
    if (!isAbsolute(path) || resolve(path) !== path)
      throw reject("Repository identity paths must be absolute and normalized.");
  if (
    !safeSegment(declaration.workstreamId) ||
    declaration.expectedRevision < 0 ||
    !/^[0-9a-f]{64}$/.test(declaration.expectedSourceSha256)
  )
    throw reject("Migration declaration is malformed.");
}
function safeSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && basename(value) === value;
}
function canonicalTimestamp(value: string, label: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value)
    throw reject(`${label} timestamp is not canonical UTC.`);
  return value;
}
function serialize<Value>(value: Value): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function migrationCause(cause: unknown): V7MigrationError {
  return cause instanceof V7MigrationError
    ? cause
    : reject("v7 migration host operation failed.", cause);
}
function reject(message: string, cause?: unknown): V7MigrationError {
  return new V7MigrationError(message, cause);
}
function requiredValue<Value>(value: Value | undefined, label: string): Value {
  if (value === undefined) throw reject(`Missing ${label}.`);
  return value;
}
