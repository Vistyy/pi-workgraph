import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Data, Effect } from "effect";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import {
  type Attempt,
  findAttemptLocation,
  findTask,
  type Outcome,
  outputDisposition,
  type Task,
  type Workstream,
} from "../domain/workstream.js";
import type { ReconciliationFrontierObservation } from "./reconciliation.js";
import type { WorkstreamRuntimeInspectionSnapshot } from "./runtime.js";

const DEFAULT_INSPECTION_CHARS = 3_000;
const MAX_INSPECTION_CHARS = 8_000;
const DEFAULT_INSPECTION_ITEMS = 10;
const MAX_INSPECTION_ITEMS = 20;
export const MAX_DELIVERY_NOTIFICATION_CHARS = 3_000;

let cursorIntegrityKey: Buffer | undefined;
const NonEmptyString = Type.String({ minLength: 1 });
const SectionSchema = Type.Union([
  Type.Literal("overview"),
  Type.Literal("context"),
  Type.Literal("completion"),
  Type.Literal("task"),
  Type.Literal("assignment"),
  Type.Literal("outcome"),
  Type.Literal("evidence"),
  Type.Literal("recovery"),
  Type.Literal("report"),
]);
export const WorkstreamInspectionRequestSchema = Type.Object(
  {
    section: SectionSchema,
    taskId: Type.Optional(NonEmptyString),
    attemptId: Type.Optional(NonEmptyString),
    outcomeId: Type.Optional(NonEmptyString),
    cursor: Type.Optional(NonEmptyString),
    maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_INSPECTION_CHARS })),
    maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_INSPECTION_ITEMS })),
  },
  { additionalProperties: false },
);
export type WorkstreamInspectionRequest = Static<typeof WorkstreamInspectionRequestSchema>;

const WorkstreamActionProjectionRequestSchema = Type.Object(
  {
    action: NonEmptyString,
    message: Type.Optional(Type.String()),
    taskId: Type.Optional(NonEmptyString),
    attemptId: Type.Optional(NonEmptyString),
    outcomeId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);
type WorkstreamActionProjectionRequest = Static<typeof WorkstreamActionProjectionRequestSchema>;

type InspectSection = WorkstreamInspectionRequest["section"];
type Selector = Pick<WorkstreamInspectionRequest, "section" | "taskId" | "attemptId" | "outcomeId">;
interface CursorPayload {
  readonly version: 1;
  readonly workstreamId: string;
  readonly revision: number;
  readonly selector: Selector;
  readonly textOffset: number;
  readonly itemOffset: number;
  readonly maxChars: number;
  readonly maxItems: number;
}

const CursorPayloadSchema = Type.Object(
  {
    version: Type.Literal(1),
    workstreamId: NonEmptyString,
    revision: Type.Integer({ minimum: 0 }),
    selector: Type.Object(
      {
        section: SectionSchema,
        taskId: Type.Optional(NonEmptyString),
        attemptId: Type.Optional(NonEmptyString),
        outcomeId: Type.Optional(NonEmptyString),
      },
      { additionalProperties: false },
    ),
    textOffset: Type.Integer({ minimum: 0 }),
    itemOffset: Type.Integer({ minimum: 0 }),
    maxChars: Type.Integer({ minimum: 1, maximum: MAX_INSPECTION_CHARS }),
    maxItems: Type.Integer({ minimum: 1, maximum: MAX_INSPECTION_ITEMS }),
  },
  { additionalProperties: false },
);

export class WorkstreamInspectionError extends Data.TaggedError("WorkstreamInspectionError")<{
  readonly code:
    | "invalid_request"
    | "invalid_cursor"
    | "cursor_mismatch"
    | "invalid_selector"
    | "unknown_handle"
    | "notification_too_large"
    | "internal_failure";
  readonly message: string;
}> {}

interface InspectionViewBase<Section extends InspectSection, Summary> {
  readonly section: Section;
  readonly workstreamId: string;
  readonly revision: number;
  readonly summary: Summary;
  readonly next?: Omit<Selector, "section"> & {
    readonly section: Section;
    readonly cursor: string;
  };
}

interface TextInspectionView<Section extends InspectSection, Summary>
  extends InspectionViewBase<Section, Summary> {
  readonly content: {
    readonly text: string;
    readonly encoding: "utf16-code-units";
    readonly returnedChars: number;
    readonly totalChars: number;
    readonly truncated: boolean;
  };
}

interface ItemInspectionView<Section extends InspectSection, Summary, Item>
  extends InspectionViewBase<Section, Summary> {
  readonly items: {
    readonly values: readonly Item[];
    readonly returnedItems: number;
    readonly totalItems: number;
    readonly truncated: boolean;
  };
}

type TaskPreview = ReturnType<typeof taskPreview>;
type AttemptPreview = ReturnType<typeof attemptPreview>;
type OutcomePreview = ReturnType<typeof outcomePreview>;
type FrontierPreview = ReturnType<typeof frontierPreview>;
type OverviewSummary = ReturnType<typeof overviewSummary>;
type ContextSummary = ReturnType<typeof contextSummary>;
type CompletionSummary = ReturnType<typeof completionSummary>;
type RecoverySummary = ReturnType<typeof recoverySummary>;
type OverviewItem =
  | ({ readonly record: "task" } & TaskPreview)
  | ({ readonly record: "reconciliation" } & FrontierPreview);
type OutcomeArtifactPreview = Outcome["artifacts"][number] & {
  readonly reference: string;
  readonly summary: string;
};

export type WorkstreamInspectionView =
  | ItemInspectionView<"overview", OverviewSummary, OverviewItem>
  | TextInspectionView<"context", ContextSummary>
  | TextInspectionView<"completion", CompletionSummary>
  | ItemInspectionView<"task", TaskPreview, AttemptPreview>
  | TextInspectionView<"assignment", { readonly taskId: string; readonly kind: Task["kind"] }>
  | ItemInspectionView<"outcome", OutcomePreview, OutcomeArtifactPreview>
  | TextInspectionView<"evidence", OutcomePreview>
  | TextInspectionView<"recovery", RecoverySummary>
  | TextInspectionView<"report", OutcomePreview>;

interface Selection {
  readonly task?: Task;
  readonly attempt?: Attempt;
  readonly outcome?: Outcome;
}

type SectionProjection =
  | {
      readonly section: "overview";
      readonly summary: OverviewSummary;
      readonly items: readonly OverviewItem[];
    }
  | { readonly section: "context"; readonly summary: ContextSummary; readonly text: string }
  | { readonly section: "completion"; readonly summary: CompletionSummary; readonly text: string }
  | {
      readonly section: "task";
      readonly summary: TaskPreview;
      readonly items: readonly AttemptPreview[];
    }
  | {
      readonly section: "assignment";
      readonly summary: { readonly taskId: string; readonly kind: Task["kind"] };
      readonly text: string;
    }
  | {
      readonly section: "outcome";
      readonly summary: OutcomePreview;
      readonly items: readonly OutcomeArtifactPreview[];
    }
  | { readonly section: "evidence"; readonly summary: OutcomePreview; readonly text: string }
  | { readonly section: "recovery"; readonly summary: RecoverySummary; readonly text: string }
  | { readonly section: "report"; readonly summary: OutcomePreview; readonly text: string };

export function inspectWorkstream<Section extends InspectSection>(
  snapshot: WorkstreamRuntimeInspectionSnapshot,
  input: WorkstreamInspectionRequest & { readonly section: Section },
): Effect.Effect<
  Extract<WorkstreamInspectionView, { readonly section: Section }>,
  WorkstreamInspectionError
>;
export function inspectWorkstream(
  snapshot: WorkstreamRuntimeInspectionSnapshot,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The implementation validates this external boundary with the exported request schema.
  input: unknown,
): Effect.Effect<WorkstreamInspectionView, WorkstreamInspectionError>;
export function inspectWorkstream(
  snapshot: WorkstreamRuntimeInspectionSnapshot,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The exported TypeBox schema owns this external inspection boundary.
  input: unknown,
): Effect.Effect<WorkstreamInspectionView, WorkstreamInspectionError> {
  return boundary(() => inspect(snapshot, decodeRequest(input)));
}

interface ActionWorkstreamProjection {
  readonly id: string;
  readonly revision: number;
  readonly lifecycle: Workstream["lifecycle"];
  readonly suspension?: NonNullable<Workstream["suspension"]>;
}

export interface WorkstreamActionProjection {
  readonly workstream: ActionWorkstreamProjection;
  readonly action: { readonly name: string; readonly message: string | undefined };
  readonly affected: {
    readonly task: ReturnType<typeof taskPreview> | undefined;
    readonly attempt: ReturnType<typeof attemptPreview> | undefined;
    readonly outcome: ReturnType<typeof outcomePreview> | undefined;
  };
  readonly blocked: ReturnType<typeof blockedPreview>;
}

export function projectWorkstreamAction(
  snapshot: WorkstreamRuntimeInspectionSnapshot,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The exported TypeBox schema owns this external action projection boundary.
  input: unknown,
): Effect.Effect<WorkstreamActionProjection, WorkstreamInspectionError> {
  return boundary(() => {
    const request = decode<WorkstreamActionProjectionRequest>(
      WorkstreamActionProjectionRequestSchema,
      input,
      "action projection",
    );
    const selected = resolveActionSelection(snapshot.workstream, request);
    return {
      workstream: actionWorkstreamProjection(snapshot.workstream),
      action: {
        name: compact(request.action, 120),
        message: request.message === undefined ? undefined : compact(request.message, 280),
      },
      affected: {
        task: selected.task === undefined ? undefined : taskPreview(selected.task),
        attempt: selected.attempt === undefined ? undefined : attemptPreview(selected.attempt),
        outcome: selected.outcome === undefined ? undefined : outcomePreview(selected.outcome),
      },
      blocked: blockedPreview(snapshot.reconciliation),
    };
  });
}

function actionWorkstreamProjection(workstream: Workstream): ActionWorkstreamProjection {
  const base = {
    id: workstream.id,
    revision: workstream.revision,
    lifecycle: workstream.lifecycle,
  };
  return workstream.suspension === undefined
    ? base
    : { ...base, suspension: structuredClone(workstream.suspension) };
}

export function workstreamOutcomeNotification(
  snapshot: WorkstreamRuntimeInspectionSnapshot,
  outcomeId: string,
): Effect.Effect<string, WorkstreamInspectionError> {
  return boundary(() => {
    const owner = outcomeOwner(snapshot.workstream, outcomeId);
    if (owner === undefined) fail("unknown_handle", `Unknown Outcome ${compact(outcomeId)}.`);
    const handles = `Task ${owner.task.id}; Attempt ${owner.attempt.id}; Outcome ${owner.outcome.id}.`;
    const retrieval = `Inspect with section outcome/report/evidence and exact outcomeId ${owner.outcome.id}.`;
    const fixed = `[WORKGRAPH OUTCOME]\n${handles}\n${retrieval}\n`;
    if (fixed.length > MAX_DELIVERY_NOTIFICATION_CHARS)
      fail(
        "notification_too_large",
        "Exact Outcome retrieval handles exceed the notification budget.",
      );
    const detail = outcomeNotificationDetail(owner.outcome);
    const remaining = MAX_DELIVERY_NOTIFICATION_CHARS - fixed.length;
    return `${fixed}${compact(detail, remaining)}`;
  });
}

function inspect(
  snapshot: WorkstreamRuntimeInspectionSnapshot,
  request: WorkstreamInspectionRequest,
): WorkstreamInspectionView {
  const workstream = snapshot.workstream;
  const selector = selectorOf(request);
  const cursor =
    request.cursor === undefined ? initialCursor(workstream, request) : readCursor(request.cursor);
  assertCursor(workstream, request, cursor);
  const projection = projectSection(
    snapshot,
    selector.section,
    resolveSection(workstream, selector),
  );
  switch (projection.section) {
    case "overview":
      return pageItems(workstream, selector, cursor, projection);
    case "task":
      return pageItems(workstream, selector, cursor, projection);
    case "outcome":
      return pageItems(workstream, selector, cursor, projection);
    case "context":
      return pageText(workstream, selector, cursor, projection);
    case "completion":
      return pageText(workstream, selector, cursor, projection);
    case "assignment":
      return pageText(workstream, selector, cursor, projection);
    case "evidence":
      return pageText(workstream, selector, cursor, projection);
    case "recovery":
      return pageText(workstream, selector, cursor, projection);
    case "report":
      return pageText(workstream, selector, cursor, projection);
  }
}

type ItemProjection = Extract<SectionProjection, { readonly items: readonly object[] }>;
type TextProjection = Extract<SectionProjection, { readonly text: string }>;

function pageItems<Projection extends ItemProjection>(
  workstream: Workstream,
  selector: Selector,
  cursor: CursorPayload,
  projection: Projection,
): ItemInspectionView<Projection["section"], Projection["summary"], Projection["items"][number]> {
  if (cursor.textOffset !== 0 || cursor.itemOffset > projection.items.length)
    fail("cursor_mismatch", "Cursor offsets do not match the selected content.");
  const values = projection.items.slice(cursor.itemOffset, cursor.itemOffset + cursor.maxItems);
  const nextOffset = cursor.itemOffset + values.length;
  const truncated = nextOffset < projection.items.length;
  const view: ItemInspectionView<
    Projection["section"],
    Projection["summary"],
    Projection["items"][number]
  > = {
    section: projection.section,
    workstreamId: workstream.id,
    revision: workstream.revision,
    summary: projection.summary,
    items: {
      values,
      returnedItems: values.length,
      totalItems: projection.items.length,
      truncated,
    },
  };
  if (truncated)
    Object.assign(view, {
      next: nextPage(selector, projection.section, {
        ...cursor,
        textOffset: 0,
        itemOffset: nextOffset,
      }),
    });
  return view;
}

function pageText<Projection extends TextProjection>(
  workstream: Workstream,
  selector: Selector,
  cursor: CursorPayload,
  projection: Projection,
): TextInspectionView<Projection["section"], Projection["summary"]> {
  if (cursor.itemOffset !== 0 || cursor.textOffset > projection.text.length)
    fail("cursor_mismatch", "Cursor offsets do not match the selected content.");
  const text = projection.text.slice(cursor.textOffset, cursor.textOffset + cursor.maxChars);
  const nextOffset = cursor.textOffset + text.length;
  const truncated = nextOffset < projection.text.length;
  const view: TextInspectionView<Projection["section"], Projection["summary"]> = {
    section: projection.section,
    workstreamId: workstream.id,
    revision: workstream.revision,
    summary: projection.summary,
    content: {
      text,
      encoding: "utf16-code-units",
      returnedChars: text.length,
      totalChars: projection.text.length,
      truncated,
    },
  };
  if (truncated)
    Object.assign(view, {
      next: nextPage(selector, projection.section, {
        ...cursor,
        textOffset: nextOffset,
        itemOffset: 0,
      }),
    });
  return view;
}

function nextPage<Section extends InspectSection>(
  selector: Selector,
  section: Section,
  cursor: CursorPayload,
): Omit<Selector, "section"> & { readonly section: Section; readonly cursor: string } {
  return { ...selector, section, cursor: writeCursor(cursor) };
}

function projectSection(
  snapshot: WorkstreamRuntimeInspectionSnapshot,
  section: InspectSection,
  selection: Selection,
): SectionProjection {
  const state = snapshot.workstream;
  switch (section) {
    case "overview":
      return {
        section,
        summary: overviewSummary(snapshot),
        items: [
          ...state.tasks.map((task) => ({ record: "task" as const, ...taskPreview(task) })),
          ...snapshot.reconciliation.map((item) => ({
            record: "reconciliation" as const,
            ...frontierPreview(item),
          })),
        ],
      };
    case "context":
      return {
        section,
        summary: contextSummary(state),
        text: json({
          purpose: state.purpose,
          repository: state.repository,
          lifecycle: state.lifecycle,
          suspension: state.suspension,
          intents: state.intents,
        }),
      };
    case "completion":
      return {
        section,
        summary: completionSummary(state),
        text: json({ lifecycle: state.lifecycle, completion: state.completion }),
      };
    case "task": {
      const task = required(selection.task);
      return { section, summary: taskPreview(task), items: task.attempts.map(attemptPreview) };
    }
    case "assignment": {
      const task = required(selection.task);
      const { attempts: _attempts, ...assignment } = task;
      return { section, summary: { taskId: task.id, kind: task.kind }, text: json(assignment) };
    }
    case "outcome": {
      const outcome = required(selection.outcome);
      return {
        section,
        summary: outcomePreview(outcome),
        items: outcome.artifacts.map((artifact) => ({
          ...artifact,
          reference: compact(artifact.reference, 240),
          summary: compact(artifact.summary, 280),
        })),
      };
    }
    case "evidence": {
      const outcome = required(selection.outcome);
      const evidence = outcome.kind === "reported" ? outcome.report.evidence : [];
      return { section, summary: outcomePreview(outcome), text: json(evidence) };
    }
    case "report": {
      const outcome = required(selection.outcome);
      const report =
        outcome.kind === "reported"
          ? outcome.report
          : outcome.kind === "unreported"
            ? { kind: outcome.kind, reason: outcome.reason, rawWorkerText: outcome.rawWorkerText }
            : { kind: outcome.kind, reason: outcome.reason };
      return { section, summary: outcomePreview(outcome), text: json(report) };
    }
    case "recovery": {
      const attempt = required(selection.attempt);
      const task = required(selection.task);
      const reconciliation = snapshot.reconciliation.filter(
        (item) => item.entry.key.attemptId === attempt.id,
      );
      return {
        section,
        summary: recoverySummary(task, attempt, reconciliation),
        text: json({
          execution: attempt.execution,
          cancellation: attempt.execution?.cancellation,
          application: attempt.application,
          cleanup: attempt.cleanup,
          outputRelease: attempt.outputRelease,
          reconciliation,
        }),
      };
    }
  }
}

function resolveSection(workstream: Workstream, selector: Selector): Selection {
  switch (selector.section) {
    case "overview":
    case "context":
    case "completion":
      assertOnlySelector(selector);
      return {};
    case "task":
    case "assignment":
      assertOnlySelector(selector, "taskId");
      return { task: exactTask(workstream, required(selector.taskId)) };
    case "recovery":
      assertOnlySelector(selector, "attemptId");
      return exactAttemptLocation(workstream, required(selector.attemptId));
    case "outcome":
    case "evidence":
    case "report":
      assertOnlySelector(selector, "outcomeId");
      return exactOutcomeOwner(workstream, required(selector.outcomeId));
  }
}

function assertOnlySelector(
  selector: Selector,
  requiredKey?: "taskId" | "attemptId" | "outcomeId",
): void {
  const supplied = (["taskId", "attemptId", "outcomeId"] as const).filter(
    (key) => selector[key] !== undefined,
  );
  if (
    (requiredKey === undefined && supplied.length > 0) ||
    (requiredKey !== undefined && (supplied.length !== 1 || supplied[0] !== requiredKey))
  )
    fail(
      "invalid_selector",
      requiredKey === undefined
        ? `${selector.section} inspection accepts no handle selector.`
        : `${selector.section} inspection requires only an exact ${requiredKey}.`,
    );
}

function resolveActionSelection(
  workstream: Workstream,
  request: WorkstreamActionProjectionRequest,
): Selection {
  const task = request.taskId === undefined ? undefined : exactTask(workstream, request.taskId);
  const attemptLocation =
    request.attemptId === undefined
      ? undefined
      : exactAttemptLocation(workstream, request.attemptId);
  const outcomeLocation =
    request.outcomeId === undefined ? undefined : exactOutcomeOwner(workstream, request.outcomeId);
  assertCompatibleAction(task, attemptLocation, outcomeLocation);
  const selection: Selection = {};
  const selectedTask = task ?? attemptLocation?.task ?? outcomeLocation?.task;
  const selectedAttempt = attemptLocation?.attempt ?? outcomeLocation?.attempt;
  if (selectedTask !== undefined) Object.assign(selection, { task: selectedTask });
  if (selectedAttempt !== undefined) Object.assign(selection, { attempt: selectedAttempt });
  if (outcomeLocation !== undefined) Object.assign(selection, { outcome: outcomeLocation.outcome });
  return selection;
}

function assertCompatibleAction(
  task: Task | undefined,
  attempt: { task: Task; attempt: Attempt } | undefined,
  outcome: { task: Task; attempt: Attempt; outcome: Outcome } | undefined,
): void {
  const taskIds = [task?.id, attempt?.task.id, outcome?.task.id].filter(
    (id): id is string => id !== undefined,
  );
  if (new Set(taskIds).size > 1)
    fail("invalid_selector", "Action Task, Attempt, and Outcome handles are incompatible.");
  if (attempt !== undefined && outcome !== undefined && attempt.attempt.id !== outcome.attempt.id)
    fail("invalid_selector", "Action Attempt and Outcome handles are incompatible.");
}

function exactTask(workstream: Workstream, taskId: string): Task {
  const task = findTask(workstream, taskId);
  if (task === undefined) fail("unknown_handle", `Unknown Task ${compact(taskId)}.`);
  return task;
}

function exactAttemptLocation(workstream: Workstream, attemptId: string) {
  const located = findAttemptLocation(workstream, attemptId);
  if (located === undefined) fail("unknown_handle", `Unknown Attempt ${compact(attemptId)}.`);
  return located;
}

function exactOutcomeOwner(workstream: Workstream, outcomeId: string) {
  const owner = outcomeOwner(workstream, outcomeId);
  if (owner === undefined) fail("unknown_handle", `Unknown Outcome ${compact(outcomeId)}.`);
  return owner;
}

function initialCursor(
  workstream: Workstream,
  request: WorkstreamInspectionRequest,
): CursorPayload {
  return {
    version: 1,
    workstreamId: workstream.id,
    revision: workstream.revision,
    selector: selectorOf(request),
    textOffset: 0,
    itemOffset: 0,
    maxChars: request.maxChars ?? DEFAULT_INSPECTION_CHARS,
    maxItems: request.maxItems ?? DEFAULT_INSPECTION_ITEMS,
  };
}

function assertCursor(
  workstream: Workstream,
  request: WorkstreamInspectionRequest,
  cursor: CursorPayload,
): void {
  if (
    cursor.workstreamId !== workstream.id ||
    cursor.revision !== workstream.revision ||
    !Value.Equal(cursor.selector, selectorOf(request)) ||
    (request.maxChars !== undefined && request.maxChars !== cursor.maxChars) ||
    (request.maxItems !== undefined && request.maxItems !== cursor.maxItems)
  )
    fail("cursor_mismatch", "Cursor does not match the selected Workstream revision or request.");
}

function selectorOf(request: WorkstreamInspectionRequest): Selector {
  const selector: Selector = { section: request.section };
  if (request.taskId !== undefined) Object.assign(selector, { taskId: request.taskId });
  if (request.attemptId !== undefined) Object.assign(selector, { attemptId: request.attemptId });
  if (request.outcomeId !== undefined) Object.assign(selector, { outcomeId: request.outcomeId });
  return selector;
}

function writeCursor(payload: CursorPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${digest(encoded)}`;
}

function readCursor(cursor: string): CursorPayload {
  const parts = cursor.split(".");
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined)
    fail("invalid_cursor", "Inspection cursor is malformed.");
  const expected = Buffer.from(digest(parts[0]));
  const received = Buffer.from(parts[1]);
  if (expected.length !== received.length || !timingSafeEqual(expected, received))
    fail("invalid_cursor", "Inspection cursor integrity check failed.");
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    return decode<CursorPayload>(CursorPayloadSchema, value, "inspection cursor");
  } catch {
    fail("invalid_cursor", "Inspection cursor payload is malformed.");
  }
}

function digest(encoded: string): string {
  cursorIntegrityKey ??= randomBytes(32);
  return createHmac("sha256", cursorIntegrityKey).update(encoded).digest("base64url");
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The workstream inspection request schema parses this boundary value.
function decodeRequest(input: unknown): WorkstreamInspectionRequest {
  return decode<WorkstreamInspectionRequest>(
    WorkstreamInspectionRequestSchema,
    input,
    "inspection request",
  );
}

function decode<Value>(
  schema: TSchema,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The supplied TypeBox schema parses this boundary value.
  input: unknown,
  label: string,
): Value {
  if (!Value.Check(schema, input)) {
    const issue = Value.Errors(schema, input)[0];
    fail(
      "invalid_request",
      `Invalid ${label} at ${issue?.instancePath === undefined || issue.instancePath === "" ? "/" : issue.instancePath}: ${issue?.message ?? "schema mismatch"}.`,
    );
  }
  // SAFETY: strict validation against the same schema established the input's static type.
  return input as Value;
}

function boundary<A>(run: () => A): Effect.Effect<A, WorkstreamInspectionError> {
  return Effect.try({
    try: run,
    catch: (cause) =>
      cause instanceof WorkstreamInspectionError
        ? cause
        : new WorkstreamInspectionError({
            code: "internal_failure",
            message: cause instanceof Error ? cause.message : "Inspection failed.",
          }),
  });
}

function fail(code: WorkstreamInspectionError["code"], message: string): never {
  throw new WorkstreamInspectionError({ code, message });
}

function outcomeOwner(
  workstream: Workstream,
  outcomeId: string,
): { task: Task; attempt: Attempt; outcome: Outcome } | undefined {
  for (const task of workstream.tasks)
    for (const attempt of task.attempts)
      if (attempt.outcome?.id === outcomeId) return { task, attempt, outcome: attempt.outcome };
  return undefined;
}

function overviewSummary(snapshot: WorkstreamRuntimeInspectionSnapshot) {
  const state = snapshot.workstream;
  return {
    lifecycle: state.lifecycle,
    suspension: state.suspension,
    purpose: compact(state.purpose),
    intentIndex: state.intents.length - 1,
    taskCount: state.tasks.length,
    attemptCount: state.tasks.reduce((count, task) => count + task.attempts.length, 0),
    outcomeCount: state.tasks.reduce(
      (count, task) => count + task.attempts.filter((attempt) => attempt.outcome).length,
      0,
    ),
    reconciliation: {
      frontierCount: snapshot.reconciliation.length,
      blockedCount: snapshot.reconciliation.filter((item) => item.blockedReason !== undefined)
        .length,
    },
  };
}

function contextSummary(workstream: Workstream) {
  return {
    lifecycle: workstream.lifecycle,
    suspension: workstream.suspension,
    intentCount: workstream.intents.length,
    currentIntentIndex: workstream.intents.length - 1,
  };
}

function completionSummary(workstream: Workstream) {
  return {
    lifecycle: workstream.lifecycle,
    recorded: workstream.completion !== undefined,
    accountingCount: workstream.completion?.accounting.length ?? 0,
  };
}

function recoverySummary(
  task: Task,
  attempt: Attempt,
  reconciliation: readonly ReconciliationFrontierObservation[],
) {
  const values = reconciliation.map(frontierPreview);
  return {
    taskId: task.id,
    attemptId: attempt.id,
    state: attempt.state,
    durableBlocker: durableBlocker(attempt),
    reconciliation: { values, totalItems: values.length },
    output: outputPreview(task, attempt),
  };
}

function taskPreview(task: Task) {
  return {
    taskId: task.id,
    kind: task.kind,
    objective: compact(task.objective),
    intentIndex: task.intentIndex,
    attemptCount: task.attempts.length,
  };
}

function attemptPreview(attempt: Attempt) {
  return {
    attemptId: attempt.id,
    state: attempt.state,
    outcomeId: attempt.outcome?.id,
    updatedAt: attempt.updatedAt,
    blocker: durableBlocker(attempt),
  };
}

function outcomePreview(outcome: Outcome) {
  return {
    outcomeId: outcome.id,
    kind: outcome.kind,
    observedAt: outcome.observedAt,
    delivery: {
      state: outcome.delivery.state,
      attemptCount: outcome.delivery.attemptCount,
      failureCount: outcome.delivery.failureHistory.length,
    },
    report:
      outcome.kind === "reported"
        ? {
            kind: outcome.report.kind,
            status: outcome.report.status,
            summary: compact(outcome.report.summary, 320),
          }
        : { reason: compact(outcome.reason, 320) },
  };
}

function frontierPreview(observation: ReconciliationFrontierObservation) {
  return {
    kind: observation.entry.kind,
    taskId: observation.entry.key.taskId,
    attemptId: observation.entry.key.attemptId,
    deadlineAt: observation.deadlineAt,
    blockedReason:
      observation.blockedReason === undefined ? undefined : compact(observation.blockedReason, 320),
  };
}

function blockedPreview(observations: readonly ReconciliationFrontierObservation[]) {
  const blocked = observations.filter((item) => item.blockedReason !== undefined);
  return {
    frontierCount: observations.length,
    blockedCount: blocked.length,
    values: blocked.slice(0, 5).map(frontierPreview),
    truncated: blocked.length > 5,
  };
}

function outputPreview(task: Task, attempt: Attempt) {
  const disposition = outputDisposition(task, attempt);
  return disposition.kind === "preserve_checkout"
    ? { ...disposition, reason: compact(disposition.reason, 320) }
    : disposition;
}

function durableBlocker(attempt: Attempt): string | undefined {
  const detail =
    attempt.outputRelease?.error ?? attempt.application?.error ?? attempt.cleanup?.error;
  return detail === undefined ? undefined : compact(detail, 320);
}

function outcomeNotificationDetail(outcome: Outcome): string {
  if (outcome.kind !== "reported") return `${outcome.kind}: ${outcome.reason}`;
  const report = outcome.report;
  const status = `${report.kind} ${report.status}`;
  return `${status}: ${report.summary}`;
}

function compact(value: string, limit = 180): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (limit <= 0) return "";
  return text.length <= limit ? text : limit === 1 ? "…" : `${text.slice(0, limit - 1)}…`;
}

function json<Value>(value: Value): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) fail("invalid_selector", "Required inspection selection is absent.");
  return value;
}
