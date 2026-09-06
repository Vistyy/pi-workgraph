import type { WorkAssignment, WorkAttempt, WorkResult, WorkstreamState } from "./workstream.js";

const DEFAULT_CHARS = 3_000;
const MAX_CHARS = 8_000;
const DEFAULT_ITEMS = 10;
const MAX_ITEMS = 20;
const PREVIEW_CHARS = 180;

export type InspectSection = "overview" | "task" | "outcome" | "evidence" | "recovery" | "report";

export interface InspectRequest {
  section: InspectSection;
  task?: string;
  attempt?: string;
  result?: string;
  offset?: number;
  maxChars?: number;
  itemOffset?: number;
  maxItems?: number;
}

export interface ActionProjectionOptions {
  action: string;
  message?: string;
  assignmentId?: string;
  attemptId?: string;
  resultId?: string;
  outcome?: string;
}

interface RetrievalTarget {
  section: InspectSection;
  task?: string;
  attempt?: string;
  result?: string;
}

interface BoundedTextProjection {
  text: string;
  encoding: "utf16-code-units";
  offset: number;
  returnedChars: number;
  totalChars: number;
  truncated: boolean;
  next?: RetrievalTarget & { offset: number; maxChars: number };
}

interface ItemPageProjection<T> {
  items: T[];
  itemOffset: number;
  returnedItems: number;
  totalItems: number;
  truncated: boolean;
  next?: RetrievalTarget & { itemOffset: number; maxItems: number };
}

interface Selection {
  task: WorkAssignment | undefined;
  attempt: WorkAttempt | undefined;
  outcome: WorkResult | undefined;
  taskAttempts: WorkAttempt[];
  taskOutcomes: WorkResult[];
}

export function compactText(value: string, max = PREVIEW_CHARS): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function attemptOrdinal(state: WorkstreamState, attempt: WorkAttempt): number {
  return (
    state.attempts.filter((item) => item.assignmentId === attempt.assignmentId).indexOf(attempt) + 1
  );
}

function attemptHandle(state: WorkstreamState, attempt: WorkAttempt): string {
  return `attempt-${attemptOrdinal(state, attempt)}`;
}

function outcomeOrdinal(state: WorkstreamState, result: WorkResult): number {
  const owner = state.attempts.find((attempt) => attempt.resultId === result.id);
  if (owner !== undefined) return attemptOrdinal(state, owner);
  return (
    state.results.filter((item) => item.assignmentId === result.assignmentId).indexOf(result) + 1
  );
}

function outcomeHandle(state: WorkstreamState, result: WorkResult): string {
  return `outcome-${outcomeOrdinal(state, result)}`;
}

function attemptMatches(state: WorkstreamState, attempt: WorkAttempt, handle: string): boolean {
  return (
    attempt.id === handle ||
    attempt.uuidAlias === handle ||
    attemptHandle(state, attempt) === handle
  );
}

export function resolveAttemptHandle(
  state: WorkstreamState,
  handle: string,
  taskId?: string,
): WorkAttempt {
  const matches = state.attempts.filter(
    (attempt) =>
      (taskId === undefined || attempt.assignmentId === taskId) &&
      attemptMatches(state, attempt, handle),
  );
  const match = matches.at(0);
  if (match === undefined)
    throw new Error(
      `Unknown attempt ${compactText(handle)}${taskId !== undefined ? ` for task ${compactText(taskId)}` : ""}.`,
    );
  if (matches.length > 1)
    throw new Error(
      `Ambiguous attempt ${compactText(handle)}; also provide task, or use one exact storage id: ${matches.map((item) => item.id).join(", ")}.`,
    );
  return match;
}

function resultMatches(state: WorkstreamState, result: WorkResult, handle: string): boolean {
  return (
    result.id === handle || result.uuidAlias === handle || outcomeHandle(state, result) === handle
  );
}

function resolveResultHandle(state: WorkstreamState, handle: string, taskId?: string): WorkResult {
  const matches = state.results.filter(
    (result) =>
      (taskId === undefined || result.assignmentId === taskId) &&
      resultMatches(state, result, handle),
  );
  const match = matches.at(0);
  if (match === undefined)
    throw new Error(
      `Unknown outcome ${compactText(handle)}${taskId !== undefined ? ` for task ${compactText(taskId)}` : ""}.`,
    );
  if (matches.length > 1)
    throw new Error(
      `Ambiguous outcome ${compactText(handle)}; also provide task, or use one exact storage id: ${matches.map((item) => item.id).join(", ")}.`,
    );
  return match;
}

function taskById(state: WorkstreamState, id: string): WorkAssignment {
  const task = state.assignments.find((item) => item.id === id);
  if (task === undefined) throw new Error(`Unknown task ${compactText(id)}.`);
  return task;
}

function resultById(state: WorkstreamState, id: string): WorkResult | undefined {
  return state.results.find((item) => item.id === id);
}

function selectedTask(
  state: WorkstreamState,
  request: InspectRequest,
  attempt: WorkAttempt | undefined,
  outcome: WorkResult | undefined,
): WorkAssignment | undefined {
  if (request.task !== undefined) return taskById(state, request.task);
  if (attempt !== undefined) return taskById(state, attempt.assignmentId);
  if (outcome !== undefined) return taskById(state, outcome.assignmentId);
  return undefined;
}

function assertCompatibleSelection(
  state: WorkstreamState,
  attempt: WorkAttempt | undefined,
  outcome: WorkResult | undefined,
): void {
  if (attempt === undefined || outcome === undefined || attempt.resultId === outcome.id) return;
  if (attempt.resultId === undefined)
    throw new Error(
      `Attempt ${attemptHandle(state, attempt)} has no retained outcome; it cannot select ${outcomeHandle(state, outcome)}.`,
    );
  const retained = resultById(state, attempt.resultId);
  const retainedIdentity =
    retained === undefined ? attempt.resultId : outcomeHandle(state, retained);
  throw new Error(
    `Attempt ${attemptHandle(state, attempt)} retained ${retainedIdentity}, not ${outcomeHandle(state, outcome)}.`,
  );
}

function implicitOutcome(
  state: WorkstreamState,
  request: InspectRequest,
  attempt: WorkAttempt | undefined,
  outcome: WorkResult | undefined,
  taskAttempts: WorkAttempt[],
  taskOutcomes: WorkResult[],
): WorkResult | undefined {
  if (outcome !== undefined) return outcome;
  if (attempt !== undefined && request.result === undefined && attempt.resultId !== undefined)
    return resultById(state, attempt.resultId);
  if (request.attempt !== undefined) return undefined;
  const onlyAttempt = taskAttempts.length === 1 ? taskAttempts.at(0) : undefined;
  if (onlyAttempt?.resultId !== undefined) {
    const result = resultById(state, onlyAttempt.resultId);
    if (result !== undefined) return result;
  }
  return taskOutcomes.length === 1 ? taskOutcomes.at(0) : undefined;
}

function resolveSelection(state: WorkstreamState, request: InspectRequest): Selection {
  const requestedTask = request.task === undefined ? undefined : taskById(state, request.task);
  const attempt =
    request.attempt === undefined
      ? undefined
      : resolveAttemptHandle(state, request.attempt, requestedTask?.id);
  const requestedOutcome =
    request.result === undefined
      ? undefined
      : resolveResultHandle(state, request.result, requestedTask?.id);
  const task = selectedTask(state, request, attempt, requestedOutcome);
  assertCompatibleSelection(state, attempt, requestedOutcome);
  const taskAttempts =
    task === undefined ? [] : state.attempts.filter((item) => item.assignmentId === task.id);
  const taskOutcomes =
    task === undefined ? [] : state.results.filter((item) => item.assignmentId === task.id);
  const outcome = implicitOutcome(
    state,
    request,
    attempt,
    requestedOutcome,
    taskAttempts,
    taskOutcomes,
  );
  return {
    task,
    attempt,
    outcome,
    taskAttempts,
    taskOutcomes,
  };
}

function requireUnambiguousAttempt(
  state: WorkstreamState,
  selection: Selection,
): WorkAttempt | undefined {
  if (selection.attempt !== undefined) return selection.attempt;
  if (selection.taskAttempts.length <= 1) return selection.taskAttempts.at(0);
  throw new Error(
    `Task ${compactText(selection.task?.id ?? "")} has repeated attempts; specify one of: ${selection.taskAttempts.map((item) => attemptHandle(state, item)).join(", ")}.`,
  );
}

function requireUnambiguousOutcome(
  state: WorkstreamState,
  selection: Selection,
): WorkResult | undefined {
  if (selection.outcome !== undefined) return selection.outcome;
  if (selection.attempt !== undefined) return undefined;
  if (selection.taskOutcomes.length <= 1) return selection.taskOutcomes.at(0);
  throw new Error(
    `Task ${compactText(selection.task?.id ?? "")} has repeated outcomes; specify one of: ${selection.taskOutcomes.map((item) => outcomeHandle(state, item)).join(", ")}.`,
  );
}

function reportStatus(result: WorkResult) {
  if (result.validity !== "typed") return { validity: result.validity };
  const status = {
    validity: result.validity,
    kind: result.report.kind,
    status: result.report.status,
  };
  if (result.report.kind !== "implementation" || result.report.status !== "completed")
    return status;
  if (result.report.outcome === "no_change")
    return { ...status, outcome: result.report.outcome, inspectedRevision: result.report.revision };
  return { ...status, outcome: result.report.outcome, reportedCommit: result.report.commit };
}

function reportPreview(result: WorkResult) {
  if (result.validity !== "typed")
    return {
      ...reportStatus(result),
      detail: compactText(result.validity === "untyped" ? result.text : result.detail),
    };
  const report = result.report;
  return {
    ...reportStatus(result),
    summary: compactText(report.summary, 320),
    uncertainty: report.uncertainty?.slice(0, 3).map((item) => compactText(item)),
    evidence: report.evidence.slice(0, 3).map((item) => ({
      label: compactText(item.label, 120),
      observation: compactText(item.observation, 280),
      class: item.class,
      command: item.command === undefined ? undefined : compactText(item.command, 160),
      artifact: item.artifact === undefined ? undefined : compactText(item.artifact, 160),
    })),
    findings: report.findings.slice(0, 3).map((item) => ({
      severity: item.severity,
      title: compactText(item.title, 120),
      detail: compactText(item.detail, 280),
      envelopeImpact: item.envelopeImpact,
    })),
    counts: {
      uncertainty: report.uncertainty?.length ?? 0,
      evidence: report.evidence.length,
      findings: report.findings.length,
    },
  };
}

function deliveryPreview(state: WorkstreamState, result: WorkResult) {
  const delivery = state.deliveries.find((item) => item.resultId === result.id);
  if (delivery === undefined) return { state: "not_requested" as const };
  return {
    state: delivery.state,
    requestedAt: delivery.requestedAt,
    attemptedBy:
      delivery.attemptedBy === undefined ? undefined : compactText(delivery.attemptedBy, 120),
    deliveredAt: delivery.deliveredAt,
    acknowledgedAt: delivery.acknowledgedAt,
    error: delivery.error === undefined ? undefined : compactText(delivery.error, 280),
    failureCount: delivery.failureHistory?.length ?? 0,
  };
}

function applicationProjection(attempt: WorkAttempt | undefined, result: WorkResult) {
  const composition = attempt?.composition;
  if (composition?.state === "composed")
    return {
      state: "applied" as const,
      revision: composition.revision,
      reportedCommit: composition.commit,
    };
  if (composition?.state === "retained_not_applied")
    return {
      state: "retained_not_applied" as const,
      reportedCommit: composition.commit,
      integratedRevision: composition.integratedRevision,
      retainedRef: compactText(composition.retainedRef ?? "", 180),
      reason: compactText(composition.reason ?? "", 280),
    };
  if (composition !== undefined)
    return {
      state: composition.state,
      reportedCommit: composition.commit,
      blocker: composition.error === undefined ? undefined : compactText(composition.error, 280),
    };
  const report = result.validity === "typed" ? result.report : undefined;
  if (
    report?.kind === "implementation" &&
    report.status === "completed" &&
    report.outcome === "changed"
  )
    return { state: "reported_not_applied" as const, reportedCommit: report.commit };
  return { state: "not_applicable" as const };
}

function cleanupProjection(attempt: WorkAttempt | undefined) {
  const cleanup = attempt?.cleanup;
  if (cleanup === undefined) return { state: "not_recorded" as const };
  return {
    state: cleanup.state,
    workerClosed: cleanup.workerClosed,
    blocker: cleanup.error === undefined ? undefined : compactText(cleanup.error, 280),
  };
}

function settlement(state: WorkstreamState, result: WorkResult) {
  const attempt = state.attempts.find((item) => item.resultId === result.id);
  const blockers =
    result.validity === "typed"
      ? result.report.findings
          .filter((finding) => finding.severity === "blocker")
          .slice(0, 3)
          .map((finding) => compactText(`${finding.title}: ${finding.detail}`, 280))
      : [];
  if (attempt?.error !== undefined) blockers.push(compactText(attempt.error, 280));
  const blockerCount =
    (result.validity === "typed"
      ? result.report.findings.filter((finding) => finding.severity === "blocker").length
      : 0) + (attempt?.error === undefined ? 0 : 1);
  return {
    workerReport: reportStatus(result),
    blockers,
    blockerCount,
    application: applicationProjection(attempt, result),
    cleanup: cleanupProjection(attempt),
    delivery: deliveryPreview(state, result),
    recovery:
      attempt === undefined
        ? undefined
        : {
            section: "recovery" as const,
            attempt: attempt.id,
          },
  };
}

function itemPage<T, U>(
  items: T[],
  request: InspectRequest,
  retrieval: RetrievalTarget,
  project: (item: T) => U,
): ItemPageProjection<U> {
  const offset = request.itemOffset ?? 0;
  const limit = Math.min(MAX_ITEMS, Math.max(1, request.maxItems ?? DEFAULT_ITEMS));
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length)
    throw new Error(`Item offset must be between 0 and ${items.length}.`);
  const selected = items.slice(offset, offset + limit).map(project);
  const nextOffset = offset + selected.length;
  const page: ItemPageProjection<U> = {
    items: selected,
    itemOffset: offset,
    returnedItems: selected.length,
    totalItems: items.length,
    truncated: nextOffset < items.length,
  };
  if (nextOffset < items.length)
    page.next = { ...retrieval, itemOffset: nextOffset, maxItems: limit };
  return page;
}

function attemptPreview(state: WorkstreamState, attempt: WorkAttempt) {
  const result = attempt.resultId === undefined ? undefined : resultById(state, attempt.resultId);
  return {
    handle: attemptHandle(state, attempt),
    state: attempt.state,
    outcome: result === undefined ? undefined : outcomeHandle(state, result),
    blocker: attempt.error === undefined ? undefined : compactText(attempt.error, 280),
    recovery: { section: "recovery" as const, attempt: attempt.id },
  };
}

function taskPreview(state: WorkstreamState, assignment: WorkAssignment, attempts?: WorkAttempt[]) {
  const ownedAttempts =
    attempts ?? state.attempts.filter((attempt) => attempt.assignmentId === assignment.id);
  const latestAttempt = ownedAttempts.at(-1);
  return {
    idPreview: compactText(assignment.id, 120),
    capability: assignment.capability,
    objective: compactText(assignment.objective),
    intentVersion: assignment.intentVersion,
    attemptCount: ownedAttempts.length,
    latestAttempt: latestAttempt === undefined ? undefined : attemptPreview(state, latestAttempt),
  };
}

function taskRetrievalTarget(assignment: WorkAssignment, attempts: WorkAttempt[]): RetrievalTarget {
  const retrievalAttempt = attempts.at(0);
  if (retrievalAttempt !== undefined) return { section: "task", attempt: retrievalAttempt.id };
  return { section: "task", task: assignment.id };
}

function taskView(state: WorkstreamState, assignment: WorkAssignment, request: InspectRequest) {
  const attempts = state.attempts.filter((attempt) => attempt.assignmentId === assignment.id);
  const retrieval = taskRetrievalTarget(assignment, attempts);
  return {
    ...taskPreview(state, assignment, attempts),
    taskIdentity: boundedText(
      assignment.id,
      request.offset ?? 0,
      request.maxChars ?? DEFAULT_CHARS,
      retrieval,
    ),
    attempts: itemPage(attempts, request, retrieval, (attempt) => attemptPreview(state, attempt)),
  };
}

function attention(state: WorkstreamState) {
  return state.attempts.flatMap((attempt) => {
    const blocker = attempt.error ?? attempt.composition?.error ?? attempt.cleanup?.error;
    if (blocker === undefined) return [];
    return [
      {
        taskPreview: compactText(attempt.assignmentId, 120),
        attempt: attemptHandle(state, attempt),
        blocker: compactText(blocker, 280),
        recovery: { section: "recovery" as const, attempt: attempt.id },
      },
    ];
  });
}

function overview(state: WorkstreamState, request: InspectRequest) {
  const active = state.attempts.filter((attempt) =>
    ["queued", "starting", "running", "cancel_requested"].includes(attempt.state),
  );
  const taskRetrieval = { section: "overview" as const };
  const attentionItems = attention(state);
  return {
    workstream: {
      id: state.id,
      lifecycle: state.lifecycle.state,
      purpose: compactText(state.purpose),
      statePathPreview: compactText(state.statePath, 240),
      currentIntent: state.intents.at(-1)?.version,
    },
    counts: {
      tasks: state.assignments.length,
      attempts: state.attempts.length,
      active: active.length,
      outcomes: state.results.length,
      blockers: attentionItems.length,
      pendingNotifications: state.deliveries.filter((delivery) => delivery.state === "pending")
        .length,
    },
    taskIndex: boundedText(
      JSON.stringify(state.assignments.map((item) => item.id)),
      request.offset ?? 0,
      request.maxChars ?? DEFAULT_CHARS,
      taskRetrieval,
    ),
    tasks: itemPage(state.assignments, request, taskRetrieval, (item) => taskPreview(state, item)),
    attention: {
      items: attentionItems.slice(0, 5),
      totalItems: attentionItems.length,
      truncated: attentionItems.length > 5,
    },
    remainingWork: {
      items: active.slice(0, 10).map((attempt) => ({
        taskPreview: compactText(attempt.assignmentId, 120),
        attempt: attemptHandle(state, attempt),
        state: attempt.state,
        recovery: { section: "recovery" as const, attempt: attempt.id },
      })),
      totalItems: active.length,
      truncated: active.length > 10,
    },
    completion:
      state.completion === undefined
        ? undefined
        : {
            completedAt: state.completion.completedAt,
            unresolvedCount: state.completion.accounting.length,
          },
  };
}

function reportText(result: WorkResult, section: "evidence" | "report"): string {
  if (result.validity === "typed")
    return JSON.stringify(section === "evidence" ? result.report.evidence : result.report, null, 2);
  return result.validity === "untyped" ? result.text : result.detail;
}

function boundedText(
  text: string,
  offset: number,
  maxChars: number,
  retrieval: RetrievalTarget,
): BoundedTextProjection {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length)
    throw new Error(`Offset must be between 0 and ${text.length}.`);
  const limit = Math.min(MAX_CHARS, Math.max(1, maxChars));
  const value = text.slice(offset, offset + limit);
  const nextOffset = offset + value.length;
  const projection: BoundedTextProjection = {
    text: value,
    encoding: "utf16-code-units",
    offset,
    returnedChars: value.length,
    totalChars: text.length,
    truncated: nextOffset < text.length,
  };
  if (nextOffset < text.length)
    projection.next = { ...retrieval, offset: nextOffset, maxChars: limit };
  return projection;
}

function projectedModels(attempt: WorkAttempt) {
  const models = attempt.models;
  const selected =
    models === undefined
      ? undefined
      : {
          source: models.source,
          guide: {
            model: compactText(models.guide.model, 160),
            thinking: models.guide.thinking,
          },
          executor:
            models.executor === undefined
              ? undefined
              : {
                  model: compactText(models.executor.model, 160),
                  thinking: models.executor.thinking,
                },
          overrideReason:
            models.overrideReason === undefined
              ? undefined
              : compactText(models.overrideReason, 240),
        };
  return {
    selected,
    observed: attempt.effectiveModels?.slice(0, 4).map((item) => ({
      model: compactText(item.model, 160),
      thinking: item.thinking === undefined ? undefined : compactText(item.thinking, 80),
      source: item.source,
    })),
    observedCount: attempt.effectiveModels?.length ?? 0,
  };
}

function launchFact(attempt: WorkAttempt) {
  const neverLaunched =
    attempt.launchPane === undefined &&
    attempt.resource === undefined &&
    attempt.worker === undefined &&
    attempt.sessionFile === undefined &&
    (attempt.submission === undefined || attempt.submission === "not_sent");
  if (neverLaunched) return "never_launched" as const;
  return {
    launchPaneRecorded: attempt.launchPane !== undefined,
    resourceRecorded: attempt.resource !== undefined,
    workerIdentityRecorded: attempt.worker !== undefined,
    sessionFileRecorded: attempt.sessionFile !== undefined,
    submission: attempt.submission,
  };
}

function recordedComposition(attempt: WorkAttempt) {
  const composition = attempt.composition;
  if (composition === undefined) return { state: "not_recorded" as const };
  return {
    state: composition.state,
    revision: composition.revision,
    commit: composition.commit,
    blocker: composition.error === undefined ? undefined : compactText(composition.error, 280),
  };
}

function recordedCleanup(attempt: WorkAttempt) {
  const cleanup = attempt.cleanup;
  if (cleanup === undefined) return { state: "not_recorded" as const };
  return {
    state: cleanup.state,
    workerClosed: cleanup.workerClosed,
    blocker: cleanup.error === undefined ? undefined : compactText(cleanup.error, 280),
  };
}

function recordedDelivery(state: WorkstreamState, attempt: WorkAttempt) {
  if (attempt.resultId === undefined) return { state: "not_recorded" as const };
  const result = resultById(state, attempt.resultId);
  if (result === undefined) return { state: "not_recorded" as const };
  const delivery = state.deliveries.find((item) => item.resultId === result.id);
  if (delivery === undefined) return { state: "not_recorded" as const };
  return deliveryPreview(state, result);
}

function recoveryView(
  state: WorkstreamState,
  task: WorkAssignment | undefined,
  attempt: WorkAttempt | undefined,
  request: InspectRequest,
) {
  if (task === undefined || attempt === undefined)
    throw new Error("Recovery inspection requires a task or attempt handle.");
  const exactRecord = {
    storageAttemptId: attempt.id,
    legacyUuidAlias: attempt.uuidAlias,
    taskId: task.id,
    resource: attempt.resource,
    worker: attempt.worker,
    sessionFile: attempt.sessionFile,
    placement: attempt.placement,
    launchPane: attempt.launchPane,
    submission: attempt.submission,
    composition: attempt.composition,
    cleanup: attempt.cleanup,
    attentionHistory: attempt.attentionHistory,
    models: attempt.models,
    effectiveModels: attempt.effectiveModels,
    delivery: state.deliveries.find((item) => item.resultId === attempt.resultId),
  };
  const blocker = attempt.error ?? attempt.composition?.error ?? attempt.cleanup?.error;
  const runtimeSettlementRecorded =
    attempt.resultId !== undefined &&
    attempt.sessionFile !== undefined &&
    attempt.effectiveModels !== undefined;
  const uncertainty = [
    "This view reports durable recorded evidence, not a fresh Herdr, filesystem, or Git observation.",
  ];
  if (blocker !== undefined)
    uncertainty.push("A guarded recovery must re-check the exact live boundary before mutation.");
  return {
    taskPreview: compactText(task.id, 120),
    attempt: {
      handle: attemptHandle(state, attempt),
      storageId: attempt.id,
      state: attempt.state,
    },
    blocker: blocker === undefined ? undefined : compactText(blocker, 320),
    recordedFacts: {
      attribution: "recorded_workstream_v4" as const,
      recordedAt: attempt.updatedAt,
      freshLiveObservation: false,
      launch: launchFact(attempt),
      runtimeSettlement: runtimeSettlementRecorded
        ? ("recorded_after_runtime_native_marker_check" as const)
        : ("not_recorded" as const),
      nativeOrGitStateFromTerminalStateAlone: false,
      composition: recordedComposition(attempt),
      cleanup: recordedCleanup(attempt),
      delivery: recordedDelivery(state, attempt),
      models: projectedModels(attempt),
      attentionCount: attempt.attentionHistory?.length ?? 0,
    },
    exactRecordedDetail: boundedText(
      JSON.stringify(exactRecord, null, 2),
      request.offset ?? 0,
      request.maxChars ?? DEFAULT_CHARS,
      { section: "recovery", attempt: attempt.id },
    ),
    uncertainty,
    guardedAction:
      blocker === undefined
        ? undefined
        : {
            tool: "workgraph_control" as const,
            attempt: attempt.id,
            actions: ["recover", "retain_not_applied"] as const,
          },
  };
}

function pendingView(state: WorkstreamState, selection: Selection) {
  const task = selection.task;
  if (task === undefined) throw new Error("Pending outcome projection requires a task.");
  return {
    taskPreview: compactText(task.id, 120),
    state: "pending" as const,
    attempt: selection.attempt === undefined ? undefined : attemptPreview(state, selection.attempt),
    attempts:
      selection.attempt === undefined
        ? selection.taskAttempts.slice(0, 5).map((item) => attemptPreview(state, item))
        : undefined,
    attemptCount: selection.taskAttempts.length,
  };
}

function outcomeView(state: WorkstreamState, outcome: WorkResult, request: InspectRequest) {
  const base = {
    taskPreview: compactText(outcome.assignmentId, 120),
    result: outcomeHandle(state, outcome),
    observedAt: outcome.observedAt,
    report: reportPreview(outcome),
    settlement: settlement(state, outcome),
    fullReport: { section: "report" as const, result: outcome.id },
    fullEvidence: { section: "evidence" as const, result: outcome.id },
  };
  if (outcome.artifacts.length === 0) return base;
  return {
    ...base,
    retainedArtifacts: boundedText(
      JSON.stringify(outcome.artifacts, null, 2),
      request.offset ?? 0,
      request.maxChars ?? DEFAULT_CHARS,
      { section: "outcome", result: outcome.id },
    ),
  };
}

function reportView(
  state: WorkstreamState,
  outcome: WorkResult,
  request: InspectRequest,
  section: "evidence" | "report",
) {
  return {
    taskPreview: compactText(outcome.assignmentId, 120),
    result: outcomeHandle(state, outcome),
    observedAt: outcome.observedAt,
    settlement: settlement(state, outcome),
    content: boundedText(
      reportText(outcome, section),
      request.offset ?? 0,
      request.maxChars ?? DEFAULT_CHARS,
      { section, result: outcome.id },
    ),
  };
}

type OverviewView = ReturnType<typeof overview>;
type TaskView = ReturnType<typeof taskView>;
type RecoveryView = ReturnType<typeof recoveryView>;
type PendingView = ReturnType<typeof pendingView>;
type OutcomeView = ReturnType<typeof outcomeView>;
type ReportView = ReturnType<typeof reportView>;
export type InspectView =
  | OverviewView
  | TaskView
  | RecoveryView
  | PendingView
  | OutcomeView
  | ReportView;

export function inspectView(
  state: WorkstreamState,
  request: InspectRequest & { section: "overview" },
): OverviewView;
export function inspectView(
  state: WorkstreamState,
  request: InspectRequest & { section: "task" },
): TaskView;
export function inspectView(
  state: WorkstreamState,
  request: InspectRequest & { section: "recovery" },
): RecoveryView;
export function inspectView(
  state: WorkstreamState,
  request: InspectRequest & { section: "outcome" },
): PendingView | OutcomeView;
export function inspectView(
  state: WorkstreamState,
  request: InspectRequest & { section: "evidence" | "report" },
): PendingView | ReportView;
export function inspectView(state: WorkstreamState, request: InspectRequest): InspectView;
export function inspectView(state: WorkstreamState, request: InspectRequest): InspectView {
  if (request.section === "overview") return overview(state, request);
  const selection = resolveSelection(state, request);
  if (selection.task === undefined)
    throw new Error(`${request.section} inspection requires a task, attempt, or result handle.`);
  if (request.section === "task") return taskView(state, selection.task, request);
  if (request.section === "recovery")
    return recoveryView(
      state,
      selection.task,
      requireUnambiguousAttempt(state, selection),
      request,
    );
  const outcome = requireUnambiguousOutcome(state, selection);
  if (outcome === undefined) return pendingView(state, selection);
  if (request.section === "outcome") return outcomeView(state, outcome, request);
  if (request.section === "evidence" || request.section === "report")
    return reportView(state, outcome, request, request.section);
  throw new Error("Unsupported inspection section.");
}

export function actionView(state: WorkstreamState, options: ActionProjectionOptions) {
  const affectedTask =
    options.assignmentId === undefined
      ? undefined
      : state.assignments.find((item) => item.id === options.assignmentId);
  const affectedAttempt =
    options.attemptId !== undefined
      ? state.attempts.find(
          (item) => item.id === options.attemptId || item.uuidAlias === options.attemptId,
        )
      : affectedTask === undefined
        ? undefined
        : state.attempts.findLast((item) => item.assignmentId === affectedTask.id);
  const affectedResult =
    options.resultId !== undefined
      ? state.results.find((item) => item.id === options.resultId)
      : affectedAttempt?.resultId === undefined
        ? undefined
        : resultById(state, affectedAttempt.resultId);
  const attentionItems = attention(state);
  return {
    workstream: {
      id: state.id,
      lifecycle: state.lifecycle.state,
      statePathPreview: compactText(state.statePath, 240),
    },
    action: {
      name: compactText(options.action, 120),
      outcome: options.outcome === undefined ? undefined : compactText(options.outcome, 120),
      message: options.message === undefined ? undefined : compactText(options.message, 280),
    },
    affected: {
      task: affectedTask === undefined ? undefined : taskPreview(state, affectedTask),
      attempt:
        affectedAttempt === undefined
          ? undefined
          : {
              ...attemptPreview(state, affectedAttempt),
              models: projectedModels(affectedAttempt),
            },
      result:
        affectedResult === undefined
          ? undefined
          : {
              handle: outcomeHandle(state, affectedResult),
              report: reportPreview(affectedResult),
              settlement: settlement(state, affectedResult),
            },
    },
    attention: {
      items: attentionItems.slice(0, 5),
      totalItems: attentionItems.length,
      truncated: attentionItems.length > 5,
    },
  };
}

export function resultNotification(state: WorkstreamState, resultId: string): string {
  const result = resultById(state, resultId);
  if (result === undefined) throw new Error(`Unknown outcome ${compactText(resultId)}.`);
  const view = inspectView(state, { section: "outcome", result: resultId });
  return [
    `[WORKGRAPH OUTCOME] Task ${compactText(result.assignmentId, 120)} produced ${outcomeHandle(state, result)}.`,
    "Decide from this bounded outcome; inspect only when uncertainty or truncated detail matters.",
    JSON.stringify(view, null, 2),
    "A repeated notification is transport recurrence, not new work or semantic acceptance.",
  ].join("\n");
}
