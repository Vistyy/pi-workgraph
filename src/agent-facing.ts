import type {
  WorkAssignment,
  WorkAttempt,
  WorkResult,
  WorkstreamState,
} from "./workstream.js";

const DEFAULT_CHARS = 4_000;
const MAX_CHARS = 8_000;

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
}

export interface ActionProjectionOptions {
  action: string;
  message?: string;
  assignmentId?: string;
  attemptId?: string;
  resultId?: string;
  outcome?: string;
}

export function compactText(value: string, max = 240): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function attemptAliases(attempt: WorkAttempt): string[] {
  return [attempt.id, ...(attempt.uuidAlias ? [attempt.uuidAlias] : [])];
}

function resultAliases(result: WorkResult, attempt?: WorkAttempt): string[] {
  return [
    result.id,
    ...(result.uuidAlias ? [result.uuidAlias] : []),
    ...(attempt ? attemptAliases(attempt) : []),
  ];
}

function matchingAttempt(state: WorkstreamState, handle: string): WorkAttempt {
  const matches = state.attempts.filter((attempt) =>
    attemptAliases(attempt).includes(handle),
  );
  if (matches.length === 0) throw new Error(`Unknown attempt ${handle}.`);
  if (matches.length > 1)
    throw new Error(
      `Ambiguous attempt ${handle}; use one of: ${matches.map((item) => item.id).join(", ")}.`,
    );
  return matches[0]!;
}

function matchingResult(state: WorkstreamState, handle: string): WorkResult {
  const matches = state.results.filter((result) => {
    const attempt = state.attempts.find((item) => item.resultId === result.id);
    return resultAliases(result, attempt).includes(handle);
  });
  if (matches.length === 0) throw new Error(`Unknown outcome ${handle}.`);
  if (matches.length > 1)
    throw new Error(
      `Ambiguous outcome ${handle}; use one of: ${matches.map((item) => item.id).join(", ")}.`,
    );
  return matches[0]!;
}

function taskById(state: WorkstreamState, id: string): WorkAssignment {
  const task = state.assignments.find((item) => item.id === id);
  if (!task) throw new Error(`Unknown task ${id}.`);
  return task;
}

function resolveSelection(state: WorkstreamState, request: InspectRequest) {
  let task = request.task ? taskById(state, request.task) : undefined;
  const attempt = request.attempt
    ? matchingAttempt(state, request.attempt)
    : undefined;
  if (attempt) {
    if (task && attempt.assignmentId !== task.id)
      throw new Error(
        `Attempt ${attempt.id} belongs to task ${attempt.assignmentId}, not ${task.id}.`,
      );
    task ??= taskById(state, attempt.assignmentId);
  }
  let outcome = request.result
    ? matchingResult(state, request.result)
    : undefined;
  if (outcome) {
    if (task && outcome.assignmentId !== task.id)
      throw new Error(
        `Outcome ${outcome.id} belongs to task ${outcome.assignmentId}, not ${task.id}.`,
      );
    if (attempt?.resultId && attempt.resultId !== outcome.id)
      throw new Error(
        `Attempt ${attempt.id} retained ${attempt.resultId}, not ${outcome.id}.`,
      );
    task ??= taskById(state, outcome.assignmentId);
  }
  const taskAttempts = task
    ? state.attempts.filter((item) => item.assignmentId === task.id)
    : [];
  if (!attempt && taskAttempts.length === 1) {
    const only = taskAttempts[0]!;
    if (!outcome && only.resultId)
      outcome = state.results.find((item) => item.id === only.resultId);
  }
  if (!outcome && attempt?.resultId)
    outcome = state.results.find((item) => item.id === attempt.resultId);
  if (!outcome && task) {
    const outcomes = state.results.filter(
      (item) => item.assignmentId === task.id,
    );
    if (outcomes.length === 1) outcome = outcomes[0];
  }
  return { task, attempt, outcome, taskAttempts };
}

function requireUnambiguousAttempt(
  selection: ReturnType<typeof resolveSelection>,
): WorkAttempt | undefined {
  if (selection.attempt) return selection.attempt;
  if (selection.taskAttempts.length <= 1) return selection.taskAttempts[0];
  throw new Error(
    `Task ${selection.task?.id} has repeated attempts; specify attempt as one of: ${selection.taskAttempts.map((item) => item.id).join(", ")}.`,
  );
}

function requireUnambiguousOutcome(
  state: WorkstreamState,
  selection: ReturnType<typeof resolveSelection>,
): WorkResult | undefined {
  if (selection.outcome) return selection.outcome;
  const outcomes = selection.task
    ? state.results.filter((item) => item.assignmentId === selection.task?.id)
    : [];
  if (outcomes.length <= 1) return outcomes[0];
  throw new Error(
    `Task ${selection.task?.id} has repeated outcomes; specify result as one of: ${outcomes.map((item) => item.id).join(", ")}.`,
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

function settlement(state: WorkstreamState, result: WorkResult) {
  const attempt = state.attempts.find((item) => item.resultId === result.id);
  const blockers =
    result.validity === "typed"
      ? result.report.findings
          .filter((finding) => finding.severity === "blocker")
          .map((finding) =>
            compactText(`${finding.title}: ${finding.detail}`, 500),
          )
      : [];
  if (attempt?.error) blockers.push(compactText(attempt.error, 500));
  return {
    workerReport: reportStatus(result),
    blockers,
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
              retainedRef: attempt.composition.retainedRef,
              reason: compactText(attempt.composition.reason ?? "", 500),
            }
          : attempt?.composition
            ? {
                state: attempt.composition.state,
                reportedCommit: attempt.composition.commit,
                blocker: attempt.composition.error
                  ? compactText(attempt.composition.error, 500)
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
            ? compactText(attempt.cleanup.error, 500)
            : undefined,
        }
      : { state: "not_recorded" },
    delivery: state.deliveries.find(
      (delivery) => delivery.resultId === result.id,
    ),
  };
}

function taskSummary(state: WorkstreamState, assignment: WorkAssignment) {
  const attempts = state.attempts.filter(
    (attempt) => attempt.assignmentId === assignment.id,
  );
  return {
    id: assignment.id,
    capability: assignment.capability,
    objective: compactText(assignment.objective),
    intentVersion: assignment.intentVersion,
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      uuidAlias: attempt.uuidAlias,
      state: attempt.state,
      result: attempt.resultId,
      blocker: attempt.error ? compactText(attempt.error, 500) : undefined,
    })),
  };
}

function attention(state: WorkstreamState) {
  return state.attempts.flatMap((attempt) => {
    const blocker =
      attempt.error ?? attempt.composition?.error ?? attempt.cleanup?.error;
    return blocker
      ? [
          {
            task: attempt.assignmentId,
            attempt: attempt.id,
            blocker: compactText(blocker, 500),
            recovery: {
              section: "recovery",
              task: attempt.assignmentId,
              attempt: attempt.id,
            },
          },
        ]
      : [];
  });
}

function overview(state: WorkstreamState) {
  const active = state.attempts.filter((attempt) =>
    ["queued", "starting", "running", "cancel_requested"].includes(
      attempt.state,
    ),
  );
  const pendingDeliveries = state.deliveries.filter(
    (delivery) => delivery.state === "pending",
  );
  return {
    workstream: {
      id: state.id,
      lifecycle: state.lifecycle.state,
      purpose: compactText(state.purpose),
      statePath: state.statePath,
      currentIntent: state.intents.at(-1)?.version,
    },
    counts: {
      tasks: state.assignments.length,
      attempts: state.attempts.length,
      active: active.length,
      outcomes: state.results.length,
      blockers: attention(state).length,
      pendingNotifications: pendingDeliveries.length,
    },
    tasks: state.assignments.slice(-20).map((item) => taskSummary(state, item)),
    taskTruncation:
      state.assignments.length > 20
        ? {
            shown: 20,
            total: state.assignments.length,
            retrieval: { section: "task", task: "<task-id>" },
          }
        : undefined,
    attention: attention(state).slice(0, 20),
    remainingWork: active.map((attempt) => ({
      task: attempt.assignmentId,
      attempt: attempt.id,
      state: attempt.state,
    })),
    completion: state.completion
      ? {
          completedAt: state.completion.completedAt,
          unresolvedCount: state.completion.accounting.length,
        }
      : undefined,
  };
}

function reportText(
  result: WorkResult,
  section: "outcome" | "evidence" | "report",
) {
  if (result.validity === "typed") {
    const value =
      section === "evidence" ? result.report.evidence : result.report;
    return JSON.stringify(value, null, 2);
  }
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

function recoveryView(
  task: WorkAssignment | undefined,
  attempt: WorkAttempt | undefined,
) {
  if (!task || !attempt)
    throw new Error("Recovery inspection requires a task or attempt handle.");
  return {
    task: task.id,
    attempt: { id: attempt.id, uuidAlias: attempt.uuidAlias },
    blocker: attempt.error
      ? compactText(attempt.error, 1_000)
      : attempt.composition?.error
        ? compactText(attempt.composition.error, 1_000)
        : attempt.cleanup?.error
          ? compactText(attempt.cleanup.error, 1_000)
          : undefined,
    exactIdentity: {
      resource: attempt.resource,
      worker: attempt.worker,
      sessionFile: attempt.sessionFile,
      placement: attempt.placement,
      launchPane: attempt.launchPane,
    },
    durableSettlementEvidence: {
      attribution: "recorded_workstream_v4",
      recordedAt: attempt.updatedAt,
      freshLiveObservation: false,
      attemptState: attempt.state,
      submission: attempt.submission,
      nativeSessionSettlement:
        attempt.state === "settled" || attempt.state === "cancelled"
          ? "runtime_recorded_after_native_settlement_marker"
          : "not_recorded_settled",
      composition: attempt.composition,
      cleanup: attempt.cleanup,
      attentionHistory: attempt.attentionHistory,
      effectiveModels: attempt.effectiveModels,
    },
    uncertainty: [
      "This view reports durable recorded evidence, not a fresh Herdr, filesystem, or Git observation.",
      ...(attempt.error
        ? [
            "A guarded recovery must re-check the exact live boundary before mutation.",
          ]
        : []),
    ],
    guardedAction: attempt.error
      ? {
          tool: "workgraph_control",
          task: task.id,
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
  if (request.section === "overview") return overview(state);
  const selection = resolveSelection(state, request);
  if (!selection.task)
    throw new Error(
      `${request.section} inspection requires a task, attempt, or result handle.`,
    );
  if (request.section === "task") return taskSummary(state, selection.task);
  if (request.section === "recovery")
    return recoveryView(selection.task, requireUnambiguousAttempt(selection));
  const outcome = requireUnambiguousOutcome(state, selection);
  if (!outcome)
    return {
      task: selection.task.id,
      state: "pending",
      attempts: selection.taskAttempts.map((item) => ({
        id: item.id,
        state: item.state,
      })),
    };
  const section = request.section;
  const retrieval = {
    section,
    task: outcome.assignmentId,
    result: outcome.id,
  };
  return {
    task: outcome.assignmentId,
    result: outcome.id,
    observedAt: outcome.observedAt,
    settlement: settlement(state, outcome),
    content: boundedText(
      reportText(outcome, section),
      request.offset ?? 0,
      request.maxChars ?? DEFAULT_CHARS,
      retrieval,
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
      statePath: state.statePath,
    },
    action: {
      name: options.action,
      outcome: options.outcome,
      message: options.message,
    },
    affected: {
      task: affectedTask ? taskSummary(state, affectedTask) : undefined,
      attempt: affectedAttempt
        ? {
            id: affectedAttempt.id,
            uuidAlias: affectedAttempt.uuidAlias,
            state: affectedAttempt.state,
            models: affectedAttempt.effectiveModels ?? affectedAttempt.models,
          }
        : undefined,
      result: affectedResult
        ? {
            id: affectedResult.id,
            ...settlement(state, affectedResult),
          }
        : undefined,
    },
    attention: attention(state).slice(0, 8),
  };
}

export function resultNotification(
  state: WorkstreamState,
  resultId: string,
): string {
  const result = state.results.find((item) => item.id === resultId);
  if (!result) throw new Error(`Unknown outcome ${resultId}.`);
  const view = inspectView(state, {
    section: "outcome",
    result: resultId,
    maxChars: 5_000,
  });
  return [
    `[WORKGRAPH OUTCOME] Task ${result.assignmentId} produced ${resultId}.`,
    "Decide from this bounded outcome; inspect only when uncertainty or truncated detail matters.",
    JSON.stringify(view, null, 2),
    "A repeated notification is transport recurrence, not new work or semantic acceptance.",
  ].join("\n");
}
