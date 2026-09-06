import type {
  WorkAssignment,
  WorkAttempt,
  WorkResult,
  WorkstreamState,
} from "./workstream.js";

const DEFAULT_CHARS = 3_000;
const MAX_CHARS = 8_000;
const DEFAULT_ITEMS = 10;
const MAX_ITEMS = 20;
const PREVIEW_CHARS = 180;

export type InspectSection =
  | "overview"
  | "task"
  | "outcome"
  | "evidence"
  | "recovery"
  | "report";

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

export function compactText(value: string, max = PREVIEW_CHARS): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function attemptOrdinal(state: WorkstreamState, attempt: WorkAttempt): number {
  return (
    state.attempts
      .filter((item) => item.assignmentId === attempt.assignmentId)
      .indexOf(attempt) + 1
  );
}

function attemptHandle(state: WorkstreamState, attempt: WorkAttempt): string {
  return `attempt-${attemptOrdinal(state, attempt)}`;
}

function outcomeOrdinal(state: WorkstreamState, result: WorkResult): number {
  const owner = state.attempts.find(
    (attempt) => attempt.resultId === result.id,
  );
  if (owner) return attemptOrdinal(state, owner);
  return (
    state.results
      .filter((item) => item.assignmentId === result.assignmentId)
      .indexOf(result) + 1
  );
}

function outcomeHandle(state: WorkstreamState, result: WorkResult): string {
  return `outcome-${outcomeOrdinal(state, result)}`;
}

function attemptMatches(
  state: WorkstreamState,
  attempt: WorkAttempt,
  handle: string,
): boolean {
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
      (!taskId || attempt.assignmentId === taskId) &&
      attemptMatches(state, attempt, handle),
  );
  if (matches.length === 0)
    throw new Error(
      `Unknown attempt ${compactText(handle)}${taskId ? ` for task ${compactText(taskId)}` : ""}.`,
    );
  if (matches.length > 1)
    throw new Error(
      `Ambiguous attempt ${compactText(handle)}; also provide task, or use one exact storage id: ${matches.map((item) => item.id).join(", ")}.`,
    );
  return matches[0]!;
}

function resultMatches(
  state: WorkstreamState,
  result: WorkResult,
  handle: string,
): boolean {
  return (
    result.id === handle ||
    result.uuidAlias === handle ||
    outcomeHandle(state, result) === handle
  );
}

function resolveResultHandle(
  state: WorkstreamState,
  handle: string,
  taskId?: string,
): WorkResult {
  const matches = state.results.filter(
    (result) =>
      (!taskId || result.assignmentId === taskId) &&
      resultMatches(state, result, handle),
  );
  if (matches.length === 0)
    throw new Error(
      `Unknown outcome ${compactText(handle)}${taskId ? ` for task ${compactText(taskId)}` : ""}.`,
    );
  if (matches.length > 1)
    throw new Error(
      `Ambiguous outcome ${compactText(handle)}; also provide task, or use one exact storage id: ${matches.map((item) => item.id).join(", ")}.`,
    );
  return matches[0]!;
}

function taskById(state: WorkstreamState, id: string): WorkAssignment {
  const task = state.assignments.find((item) => item.id === id);
  if (!task) throw new Error(`Unknown task ${compactText(id)}.`);
  return task;
}

function resolveSelection(state: WorkstreamState, request: InspectRequest) {
  let task = request.task ? taskById(state, request.task) : undefined;
  const attempt = request.attempt
    ? resolveAttemptHandle(state, request.attempt, task?.id)
    : undefined;
  if (attempt) task ??= taskById(state, attempt.assignmentId);
  let outcome = request.result
    ? resolveResultHandle(state, request.result, task?.id)
    : undefined;
  if (outcome) task ??= taskById(state, outcome.assignmentId);
  if (attempt && outcome && attempt.resultId !== outcome.id)
    throw new Error(
      attempt.resultId
        ? `Attempt ${attemptHandle(state, attempt)} retained ${outcomeHandle(state, state.results.find((item) => item.id === attempt.resultId)!)}, not ${outcomeHandle(state, outcome)}.`
        : `Attempt ${attemptHandle(state, attempt)} has no retained outcome; it cannot select ${outcomeHandle(state, outcome)}.`,
    );
  const taskAttempts = task
    ? state.attempts.filter((item) => item.assignmentId === task.id)
    : [];
  if (!request.attempt && !outcome && taskAttempts.length === 1) {
    const only = taskAttempts[0]!;
    if (only.resultId)
      outcome = state.results.find((item) => item.id === only.resultId);
  }
  if (attempt && !request.result && attempt.resultId)
    outcome = state.results.find((item) => item.id === attempt.resultId);
  if (!request.attempt && !outcome && task) {
    const outcomes = state.results.filter(
      (item) => item.assignmentId === task.id,
    );
    if (outcomes.length === 1) outcome = outcomes[0];
  }
  return { task, attempt, outcome, taskAttempts };
}

function requireUnambiguousAttempt(
  state: WorkstreamState,
  selection: ReturnType<typeof resolveSelection>,
): WorkAttempt | undefined {
  if (selection.attempt) return selection.attempt;
  if (selection.taskAttempts.length <= 1) return selection.taskAttempts[0];
  throw new Error(
    `Task ${compactText(selection.task?.id ?? "")} has repeated attempts; specify one of: ${selection.taskAttempts.map((item) => attemptHandle(state, item)).join(", ")}.`,
  );
}

function requireUnambiguousOutcome(
  state: WorkstreamState,
  selection: ReturnType<typeof resolveSelection>,
): WorkResult | undefined {
  if (selection.outcome) return selection.outcome;
  if (selection.attempt) return undefined;
  const outcomes = selection.task
    ? state.results.filter((item) => item.assignmentId === selection.task?.id)
    : [];
  if (outcomes.length <= 1) return outcomes[0];
  throw new Error(
    `Task ${compactText(selection.task?.id ?? "")} has repeated outcomes; specify one of: ${outcomes.map((item) => outcomeHandle(state, item)).join(", ")}.`,
  );
}

function reportStatus(result: WorkResult) {
  if (result.validity !== "typed") return { validity: result.validity };
  return {
    validity: result.validity,
    kind: result.report.kind,
    status: result.report.status,
    ...(result.report.kind === "implementation" &&
    result.report.status === "completed"
      ? {
          outcome: result.report.outcome,
          ...(result.report.outcome === "no_change"
            ? { inspectedRevision: result.report.revision }
            : { reportedCommit: result.report.commit }),
        }
      : {}),
  };
}

function reportPreview(result: WorkResult) {
  if (result.validity !== "typed")
    return {
      ...reportStatus(result),
      detail: compactText(
        result.validity === "untyped" ? result.text : result.detail,
      ),
    };
  const report = result.report;
  return {
    ...reportStatus(result),
    summary: compactText(report.summary, 320),
    uncertainty: report.uncertainty
      ?.slice(0, 3)
      .map((item) => compactText(item)),
    evidence: report.evidence.slice(0, 3).map((item) => ({
      label: compactText(item.label, 120),
      observation: compactText(item.observation, 280),
      class: item.class,
      command: item.command ? compactText(item.command, 160) : undefined,
      artifact: item.artifact ? compactText(item.artifact, 160) : undefined,
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
  if (!delivery) return { state: "not_requested" };
  return {
    state: delivery.state,
    requestedAt: delivery.requestedAt,
    attemptedBy: delivery.attemptedBy
      ? compactText(delivery.attemptedBy, 120)
      : undefined,
    deliveredAt: delivery.deliveredAt,
    acknowledgedAt: delivery.acknowledgedAt,
    error: delivery.error ? compactText(delivery.error, 280) : undefined,
    failureCount: delivery.failureHistory?.length ?? 0,
  };
}

function settlement(state: WorkstreamState, result: WorkResult) {
  const attempt = state.attempts.find((item) => item.resultId === result.id);
  const blockers =
    result.validity === "typed"
      ? result.report.findings
          .filter((finding) => finding.severity === "blocker")
          .slice(0, 3)
          .map((finding) =>
            compactText(`${finding.title}: ${finding.detail}`, 280),
          )
      : [];
  if (attempt?.error) blockers.push(compactText(attempt.error, 280));
  return {
    workerReport: reportStatus(result),
    blockers,
    blockerCount:
      (result.validity === "typed"
        ? result.report.findings.filter(
            (finding) => finding.severity === "blocker",
          ).length
        : 0) + (attempt?.error ? 1 : 0),
    application:
      attempt?.composition?.state === "composed"
        ? {
            state: "applied",
            revision: attempt.composition.revision,
            reportedCommit: attempt.composition.commit,
          }
        : attempt?.composition?.state === "retained_not_applied"
          ? {
              state: "retained_not_applied",
              reportedCommit: attempt.composition.commit,
              integratedRevision: attempt.composition.integratedRevision,
              retainedRef: compactText(
                attempt.composition.retainedRef ?? "",
                180,
              ),
              reason: compactText(attempt.composition.reason ?? "", 280),
            }
          : attempt?.composition
            ? {
                state: attempt.composition.state,
                reportedCommit: attempt.composition.commit,
                blocker: attempt.composition.error
                  ? compactText(attempt.composition.error, 280)
                  : undefined,
              }
            : result.validity === "typed" &&
                result.report.kind === "implementation" &&
                result.report.status === "completed" &&
                result.report.outcome === "changed"
              ? {
                  state: "reported_not_applied",
                  reportedCommit: result.report.commit,
                }
              : { state: "not_applicable" },
    cleanup: attempt?.cleanup
      ? {
          state: attempt.cleanup.state,
          workerClosed: attempt.cleanup.workerClosed,
          blocker: attempt.cleanup.error
            ? compactText(attempt.cleanup.error, 280)
            : undefined,
        }
      : { state: "not_recorded" },
    delivery: deliveryPreview(state, result),
    ...(attempt
      ? {
          recovery: {
            section: "recovery" as const,
            attempt: attempt.id,
          },
        }
      : {}),
  };
}

function itemPage<T, U>(
  items: T[],
  request: InspectRequest,
  retrieval: Record<string, unknown>,
  project: (item: T) => U,
) {
  const offset = request.itemOffset ?? 0;
  const limit = Math.min(
    MAX_ITEMS,
    Math.max(1, request.maxItems ?? DEFAULT_ITEMS),
  );
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length)
    throw new Error(`Item offset must be between 0 and ${items.length}.`);
  const selected = items.slice(offset, offset + limit).map(project);
  const nextOffset = offset + selected.length;
  return {
    items: selected,
    itemOffset: offset,
    returnedItems: selected.length,
    totalItems: items.length,
    truncated: nextOffset < items.length,
    ...(nextOffset < items.length
      ? {
          next: {
            ...retrieval,
            itemOffset: nextOffset,
            maxItems: limit,
          },
        }
      : {}),
  };
}

function attemptPreview(state: WorkstreamState, attempt: WorkAttempt) {
  const result = attempt.resultId
    ? state.results.find((item) => item.id === attempt.resultId)
    : undefined;
  return {
    handle: attemptHandle(state, attempt),
    state: attempt.state,
    outcome: result ? outcomeHandle(state, result) : undefined,
    blocker: attempt.error ? compactText(attempt.error, 280) : undefined,
    recovery: { section: "recovery" as const, attempt: attempt.id },
  };
}

function taskPreview(state: WorkstreamState, assignment: WorkAssignment) {
  const attempts = state.attempts.filter(
    (attempt) => attempt.assignmentId === assignment.id,
  );
  return {
    idPreview: compactText(assignment.id, 120),
    capability: assignment.capability,
    objective: compactText(assignment.objective),
    intentVersion: assignment.intentVersion,
    attemptCount: attempts.length,
    latestAttempt: attempts.length
      ? attemptPreview(state, attempts.at(-1)!)
      : undefined,
  };
}

function taskView(
  state: WorkstreamState,
  assignment: WorkAssignment,
  request: InspectRequest,
) {
  const attempts = state.attempts.filter(
    (attempt) => attempt.assignmentId === assignment.id,
  );
  const retrievalAttempt = attempts[0]?.id;
  return {
    ...taskPreview(state, assignment),
    taskIdentity: boundedText(
      assignment.id,
      request.offset ?? 0,
      request.maxChars ?? DEFAULT_CHARS,
      {
        section: "task",
        ...(retrievalAttempt
          ? { attempt: retrievalAttempt }
          : { task: assignment.id }),
      },
    ),
    attempts: itemPage(
      attempts,
      request,
      {
        section: "task",
        ...(retrievalAttempt
          ? { attempt: retrievalAttempt }
          : { task: assignment.id }),
      },
      (attempt) => attemptPreview(state, attempt),
    ),
  };
}

function attention(state: WorkstreamState) {
  return state.attempts.flatMap((attempt) => {
    const blocker =
      attempt.error ?? attempt.composition?.error ?? attempt.cleanup?.error;
    return blocker
      ? [
          {
            taskPreview: compactText(attempt.assignmentId, 120),
            attempt: attemptHandle(state, attempt),
            blocker: compactText(blocker, 280),
            recovery: { section: "recovery" as const, attempt: attempt.id },
          },
        ]
      : [];
  });
}

function overview(state: WorkstreamState, request: InspectRequest) {
  const active = state.attempts.filter((attempt) =>
    ["queued", "starting", "running", "cancel_requested"].includes(
      attempt.state,
    ),
  );
  const taskRetrieval = { section: "overview" as const };
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
      blockers: attention(state).length,
      pendingNotifications: state.deliveries.filter(
        (delivery) => delivery.state === "pending",
      ).length,
    },
    taskIndex: boundedText(
      JSON.stringify(state.assignments.map((item) => item.id)),
      request.offset ?? 0,
      request.maxChars ?? DEFAULT_CHARS,
      taskRetrieval,
    ),
    tasks: itemPage(state.assignments, request, taskRetrieval, (item) =>
      taskPreview(state, item),
    ),
    attention: {
      items: attention(state).slice(0, 5),
      totalItems: attention(state).length,
      truncated: attention(state).length > 5,
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
    completion: state.completion
      ? {
          completedAt: state.completion.completedAt,
          unresolvedCount: state.completion.accounting.length,
        }
      : undefined,
  };
}

function reportText(result: WorkResult, section: "evidence" | "report") {
  if (result.validity === "typed")
    return JSON.stringify(
      section === "evidence" ? result.report.evidence : result.report,
      null,
      2,
    );
  return result.validity === "untyped" ? result.text : result.detail;
}

function boundedText(
  text: string,
  offset: number,
  maxChars: number,
  retrieval: Record<string, unknown>,
) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length)
    throw new Error(`Offset must be between 0 and ${text.length}.`);
  const limit = Math.min(MAX_CHARS, Math.max(1, maxChars));
  const value = text.slice(offset, offset + limit);
  const nextOffset = offset + value.length;
  return {
    text: value,
    encoding: "utf16-code-units",
    offset,
    returnedChars: value.length,
    totalChars: text.length,
    truncated: nextOffset < text.length,
    ...(nextOffset < text.length
      ? { next: { ...retrieval, offset: nextOffset, maxChars: limit } }
      : {}),
  };
}

function projectedModels(attempt: WorkAttempt) {
  const selected = attempt.models
    ? {
        source: attempt.models.source,
        guide: {
          model: compactText(attempt.models.guide.model, 160),
          thinking: attempt.models.guide.thinking,
        },
        executor: attempt.models.executor
          ? {
              model: compactText(attempt.models.executor.model, 160),
              thinking: attempt.models.executor.thinking,
            }
          : undefined,
        overrideReason: attempt.models.overrideReason
          ? compactText(attempt.models.overrideReason, 240)
          : undefined,
      }
    : undefined;
  return {
    selected,
    observed: attempt.effectiveModels?.slice(0, 4).map((item) => ({
      model: compactText(item.model, 160),
      thinking: item.thinking ? compactText(item.thinking, 80) : undefined,
      source: item.source,
    })),
    observedCount: attempt.effectiveModels?.length ?? 0,
  };
}

function recoveryView(
  state: WorkstreamState,
  task: WorkAssignment | undefined,
  attempt: WorkAttempt | undefined,
  request: InspectRequest,
) {
  if (!task || !attempt)
    throw new Error("Recovery inspection requires a task or attempt handle.");
  const delivery = attempt.resultId
    ? state.deliveries.find((item) => item.resultId === attempt.resultId)
    : undefined;
  const neverLaunched =
    !attempt.launchPane &&
    !attempt.resource &&
    !attempt.worker &&
    !attempt.sessionFile &&
    (!attempt.submission || attempt.submission === "not_sent");
  const runtimeSettlementRecorded = Boolean(
    attempt.resultId && attempt.sessionFile && attempt.effectiveModels,
  );
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
    delivery,
  };
  const blocker =
    attempt.error ?? attempt.composition?.error ?? attempt.cleanup?.error;
  return {
    taskPreview: compactText(task.id, 120),
    attempt: {
      handle: attemptHandle(state, attempt),
      storageId: attempt.id,
      state: attempt.state,
    },
    blocker: blocker ? compactText(blocker, 320) : undefined,
    recordedFacts: {
      attribution: "recorded_workstream_v4",
      recordedAt: attempt.updatedAt,
      freshLiveObservation: false,
      launch: neverLaunched
        ? "never_launched"
        : {
            launchPaneRecorded: Boolean(attempt.launchPane),
            resourceRecorded: Boolean(attempt.resource),
            workerIdentityRecorded: Boolean(attempt.worker),
            sessionFileRecorded: Boolean(attempt.sessionFile),
            submission: attempt.submission,
          },
      runtimeSettlement: runtimeSettlementRecorded
        ? "recorded_after_runtime_native_marker_check"
        : "not_recorded",
      nativeOrGitStateFromTerminalStateAlone: false,
      composition: attempt.composition
        ? {
            state: attempt.composition.state,
            revision: attempt.composition.revision,
            commit: attempt.composition.commit,
            blocker: attempt.composition.error
              ? compactText(attempt.composition.error, 280)
              : undefined,
          }
        : { state: "not_recorded" },
      cleanup: attempt.cleanup
        ? {
            state: attempt.cleanup.state,
            workerClosed: attempt.cleanup.workerClosed,
            blocker: attempt.cleanup.error
              ? compactText(attempt.cleanup.error, 280)
              : undefined,
          }
        : { state: "not_recorded" },
      delivery:
        delivery && attempt.resultId
          ? deliveryPreview(
              state,
              state.results.find((item) => item.id === attempt.resultId)!,
            )
          : { state: "not_recorded" },
      models: projectedModels(attempt),
      attentionCount: attempt.attentionHistory?.length ?? 0,
    },
    exactRecordedDetail: boundedText(
      JSON.stringify(exactRecord, null, 2),
      request.offset ?? 0,
      request.maxChars ?? DEFAULT_CHARS,
      { section: "recovery", attempt: attempt.id },
    ),
    uncertainty: [
      "This view reports durable recorded evidence, not a fresh Herdr, filesystem, or Git observation.",
      ...(blocker
        ? [
            "A guarded recovery must re-check the exact live boundary before mutation.",
          ]
        : []),
    ],
    guardedAction: blocker
      ? {
          tool: "workgraph_control",
          attempt: attempt.id,
          actions: ["recover", "retain_not_applied"],
        }
      : undefined,
  };
}

export function inspectView(
  state: WorkstreamState,
  request: InspectRequest,
): Record<string, unknown> {
  if (request.section === "overview") return overview(state, request);
  const selection = resolveSelection(state, request);
  if (!selection.task)
    throw new Error(
      `${request.section} inspection requires a task, attempt, or result handle.`,
    );
  if (request.section === "task")
    return taskView(state, selection.task, request);
  if (request.section === "recovery")
    return recoveryView(
      state,
      selection.task,
      requireUnambiguousAttempt(state, selection),
      request,
    );
  const outcome = requireUnambiguousOutcome(state, selection);
  if (!outcome)
    return {
      taskPreview: compactText(selection.task.id, 120),
      state: "pending",
      attempt: selection.attempt
        ? attemptPreview(state, selection.attempt)
        : undefined,
      attempts: selection.attempt
        ? undefined
        : selection.taskAttempts
            .slice(0, 5)
            .map((item) => attemptPreview(state, item)),
      attemptCount: selection.taskAttempts.length,
    };
  if (request.section === "outcome")
    return {
      taskPreview: compactText(outcome.assignmentId, 120),
      result: outcomeHandle(state, outcome),
      observedAt: outcome.observedAt,
      report: reportPreview(outcome),
      settlement: settlement(state, outcome),
      ...(outcome.artifacts.length
        ? {
            retainedArtifacts: boundedText(
              JSON.stringify(outcome.artifacts, null, 2),
              request.offset ?? 0,
              request.maxChars ?? DEFAULT_CHARS,
              { section: "outcome", result: outcome.id },
            ),
          }
        : {}),
      fullReport: { section: "report", result: outcome.id },
      fullEvidence: { section: "evidence", result: outcome.id },
    };
  return {
    taskPreview: compactText(outcome.assignmentId, 120),
    result: outcomeHandle(state, outcome),
    observedAt: outcome.observedAt,
    settlement: settlement(state, outcome),
    content: boundedText(
      reportText(outcome, request.section),
      request.offset ?? 0,
      request.maxChars ?? DEFAULT_CHARS,
      { section: request.section, result: outcome.id },
    ),
  };
}

export function actionView(
  state: WorkstreamState,
  options: ActionProjectionOptions,
): Record<string, unknown> {
  const affectedTask = options.assignmentId
    ? state.assignments.find((item) => item.id === options.assignmentId)
    : undefined;
  const affectedAttempt = options.attemptId
    ? state.attempts.find(
        (item) =>
          item.id === options.attemptId || item.uuidAlias === options.attemptId,
      )
    : affectedTask
      ? state.attempts.findLast((item) => item.assignmentId === affectedTask.id)
      : undefined;
  const affectedResult = options.resultId
    ? state.results.find((item) => item.id === options.resultId)
    : affectedAttempt?.resultId
      ? state.results.find((item) => item.id === affectedAttempt.resultId)
      : undefined;
  return {
    workstream: {
      id: state.id,
      lifecycle: state.lifecycle.state,
      statePathPreview: compactText(state.statePath, 240),
    },
    action: {
      name: compactText(options.action, 120),
      outcome: options.outcome ? compactText(options.outcome, 120) : undefined,
      message: options.message ? compactText(options.message, 280) : undefined,
    },
    affected: {
      task: affectedTask ? taskPreview(state, affectedTask) : undefined,
      attempt: affectedAttempt
        ? {
            ...attemptPreview(state, affectedAttempt),
            models: projectedModels(affectedAttempt),
          }
        : undefined,
      result: affectedResult
        ? {
            handle: outcomeHandle(state, affectedResult),
            report: reportPreview(affectedResult),
            settlement: settlement(state, affectedResult),
          }
        : undefined,
    },
    attention: {
      items: attention(state).slice(0, 5),
      totalItems: attention(state).length,
      truncated: attention(state).length > 5,
    },
  };
}

export function resultNotification(
  state: WorkstreamState,
  resultId: string,
): string {
  const result = state.results.find((item) => item.id === resultId);
  if (!result) throw new Error(`Unknown outcome ${compactText(resultId)}.`);
  const view = inspectView(state, { section: "outcome", result: resultId });
  return [
    `[WORKGRAPH OUTCOME] Task ${compactText(result.assignmentId, 120)} produced ${outcomeHandle(state, result)}.`,
    "Decide from this bounded outcome; inspect only when uncertainty or truncated detail matters.",
    JSON.stringify(view, null, 2),
    "A repeated notification is transport recurrence, not new work or semantic acceptance.",
  ].join("\n");
}
