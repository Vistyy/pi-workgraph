import type { WorkAttempt, WorkResult, WorkstreamState } from "./workstream.js";

export type ResultSection =
  | "all"
  | "summary"
  | "evidence"
  | "findings"
  | "attention";

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

export function pageItems<T>(
  items: T[],
  offset: number,
  limit: number,
  continuation?: string,
) {
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    offset,
    limit,
    remaining: Math.max(0, items.length - offset - limit),
    ...(offset + limit < items.length ? { nextOffset: offset + limit } : {}),
    ...(continuation ? { continuation } : {}),
  };
}

function modelView(
  models: WorkAttempt["models"],
): Record<string, unknown> | undefined {
  if (!models) return undefined;
  return {
    guide: models.guide,
    ...(models.executor ? { executor: models.executor } : {}),
    source: models.source,
    ...(models.overrideReason
      ? { overrideReason: compactText(models.overrideReason) }
      : {}),
    ...(models.selection
      ? {
          selection: {
            requested: models.selection.requested,
            diversity: models.selection.diversity,
            selected: models.selection.selected,
            selectedCount: models.selection.selected.length,
            unfulfilled: models.selection.unfulfilled,
            unfulfilledCount: models.selection.unfulfilled.length,
            source: models.selection.source,
            reason: compactText(models.selection.reason),
          },
        }
      : {}),
  };
}

function effectiveModelView(
  entries: NonNullable<WorkAttempt["effectiveModels"]> = [],
) {
  const distinct = new Map<
    string,
    { model: string; thinking?: string; sources: Set<string> }
  >();
  const transitions: Array<{
    model: string;
    thinking?: string;
    source?: string;
  }> = [];
  let previous: string | undefined;
  for (const entry of entries) {
    const key = `${entry.model}|${entry.thinking ?? ""}`;
    if (!distinct.has(key))
      distinct.set(key, {
        model: entry.model,
        ...(entry.thinking ? { thinking: entry.thinking } : {}),
        sources: new Set(),
      });
    distinct.get(key)?.sources.add(entry.source ?? "unknown");
    if (key !== previous) {
      transitions.push({
        model: entry.model,
        ...(entry.thinking ? { thinking: entry.thinking } : {}),
        ...(entry.source ? { source: entry.source } : {}),
      });
      previous = key;
    }
  }
  return {
    observations: entries.length,
    distinctCount: distinct.size,
    omittedDistinct: Math.max(0, distinct.size - 8),
    distinct: [...distinct.values()]
      .slice(0, 8)
      .map(({ sources, ...entry }) => ({ ...entry, sources: [...sources] })),
    transitions: transitions.slice(0, 8),
    truncatedTransitions: Math.max(0, transitions.length - 8),
  };
}

function resultSummary(state: WorkstreamState, item: WorkResult) {
  const accounting = state.completion?.accounting ?? [];
  return {
    id: item.id,
    assignmentId: item.assignmentId,
    validity: item.validity,
    ...(item.validity === "typed"
      ? {
          kind: item.report.kind,
          status: item.report.status,
          ...(item.report.kind === "implementation" &&
          item.report.status === "completed"
            ? {
                outcome: item.report.outcome,
                ...(item.report.outcome === "no_change"
                  ? {
                      revision: item.report.revision,
                      reason: compactText(item.report.reason),
                    }
                  : {}),
              }
            : {}),
        }
      : {}),
    summary: compactText(
      item.validity === "typed"
        ? item.report.summary
        : item.validity === "untyped"
          ? item.text
          : item.detail,
    ),
    undeliveredEvidence: accounting
      .filter(
        (entry) =>
          entry.kind === "undelivered_result" && entry.resultId === item.id,
      )
      .map((entry) => ({ ...entry, reason: compactText(entry.reason, 320) })),
    retainedNotApplied: state.attempts
      .filter(
        (attempt) =>
          attempt.resultId === item.id &&
          attempt.composition?.state === "retained_not_applied",
      )
      .map((attempt) => ({
        attemptId: attempt.id,
        reason: attempt.composition?.reason
          ? compactText(attempt.composition.reason, 320)
          : undefined,
        retainedRef: attempt.composition?.retainedRef,
        integratedRevision: attempt.composition?.integratedRevision,
      })),
    handles: {
      summary: "summary",
      evidence: "evidence",
      findings: "findings",
      attention: "attention",
    },
  };
}

function attemptSummary(state: WorkstreamState, attempt: WorkAttempt) {
  const result = state.results.find((item) => item.id === attempt.resultId);
  const report = result?.validity === "typed" ? result.report : undefined;
  return {
    id: attempt.id,
    assignmentId: attempt.assignmentId,
    state: attempt.state,
    submission: attempt.submission,
    placement: attempt.placement?.kind,
    resultId: attempt.resultId,
    outcome:
      report?.kind === "implementation" && report.status === "completed"
        ? report.outcome
        : report?.status,
    models: modelView(attempt.models),
    effectiveModels: effectiveModelView(attempt.effectiveModels),
    composition: attempt.composition?.state,
    compositionReason: attempt.composition?.reason
      ? compactText(attempt.composition.reason, 320)
      : undefined,
    retainedRef: attempt.composition?.retainedRef,
    cleanup: attempt.cleanup?.state,
    attention: attempt.error ? compactText(attempt.error, 320) : undefined,
  };
}

function attentionItems(state: WorkstreamState) {
  return state.attempts.flatMap((attempt) =>
    attempt.error
      ? [{ attemptId: attempt.id, detail: compactText(attempt.error, 320) }]
      : attempt.composition?.state === "blocked" ||
          attempt.cleanup?.state === "blocked"
        ? [
            {
              attemptId: attempt.id,
              detail: compactText(
                attempt.composition?.error ??
                  attempt.cleanup?.error ??
                  "Blocked attempt requires recovery.",
                320,
              ),
            },
          ]
        : [],
  );
}

function counts(state: WorkstreamState, attentionCount: number) {
  const activeAttempts = state.attempts.filter((attempt) =>
    ["starting", "running", "cancel_requested"].includes(attempt.state),
  ).length;
  const accounting = state.completion?.accounting ?? [];
  return {
    assignments: state.assignments.length,
    attempts: state.attempts.length,
    activeAttempts,
    results: state.results.length,
    deliveries: state.deliveries.length,
    attention: attentionCount,
    accounting: accounting.length,
  };
}

export function actionView(
  state: WorkstreamState,
  options: ActionProjectionOptions,
): Record<string, unknown> {
  const attention = attentionItems(state);
  const affectedAssignment = options.assignmentId
    ? state.assignments.find((item) => item.id === options.assignmentId)
    : undefined;
  const affectedAttempt = options.attemptId
    ? state.attempts.find((item) => item.id === options.attemptId)
    : options.assignmentId
      ? [...state.attempts]
          .reverse()
          .find((item) => item.assignmentId === options.assignmentId)
      : undefined;
  const affectedResult = options.resultId
    ? state.results.find((item) => item.id === options.resultId)
    : affectedAttempt?.resultId
      ? state.results.find((item) => item.id === affectedAttempt.resultId)
      : undefined;
  const assignmentAttempts = affectedAssignment
    ? state.attempts.filter(
        (attempt) => attempt.assignmentId === affectedAssignment.id,
      )
    : [];
  const omittedAttention = Math.max(0, attention.length - 8);
  return {
    workstream: {
      id: state.id,
      statePath: state.statePath,
      lifecycle: {
        ...state.lifecycle,
        reason: compactText(state.lifecycle.reason),
      },
    },
    action: {
      name: options.action,
      ...(options.message ? { message: options.message } : {}),
      ...(options.outcome ? { outcome: options.outcome } : {}),
    },
    counts: counts(state, attention.length),
    affected: {
      ...(affectedAssignment
        ? {
            assignment: {
              id: affectedAssignment.id,
              capability: affectedAssignment.capability,
              objective: compactText(affectedAssignment.objective),
              attemptCount: assignmentAttempts.length,
              activeAttemptCount: assignmentAttempts.filter((attempt) =>
                ["starting", "running", "cancel_requested"].includes(
                  attempt.state,
                ),
              ).length,
            },
          }
        : {}),
      ...(affectedAttempt
        ? { attempt: attemptSummary(state, affectedAttempt) }
        : {}),
      ...(affectedResult
        ? { result: resultSummary(state, affectedResult) }
        : {}),
    },
    attention: {
      items: attention.slice(0, 8),
      count: attention.length,
      omitted: omittedAttention,
      ...(omittedAttention > 0
        ? {
            continuation: `Call workgraph_status with offset 8 to inspect the remaining ${omittedAttention} attention item(s).`,
          }
        : {}),
    },
  };
}

export function compactStatus(state: WorkstreamState, offset = 0, limit = 20) {
  const attention = attentionItems(state);
  const accounting = state.completion?.accounting ?? [];
  return {
    id: state.id,
    statePath: state.statePath,
    purpose: compactText(state.purpose),
    lifecycle: {
      ...state.lifecycle,
      reason: compactText(state.lifecycle.reason),
    },
    counts: counts(state, attention.length),
    assignments: pageItems(
      state.assignments.map((assignment) => {
        const attempts = state.attempts.filter(
          (attempt) => attempt.assignmentId === assignment.id,
        );
        return {
          id: assignment.id,
          capability: assignment.capability,
          objective: compactText(assignment.objective),
          attempts: {
            count: attempts.length,
            active: attempts.filter((attempt) =>
              ["starting", "running", "cancel_requested"].includes(
                attempt.state,
              ),
            ).length,
            items: attempts
              .slice(-3)
              .map((attempt) => attemptSummary(state, attempt)),
            ...(attempts.length > 3
              ? { omittedHistory: attempts.length - 3 }
              : {}),
          },
        };
      }),
      offset,
      limit,
      "Call workgraph_status with the same offset and limit to continue assignments.",
    ),
    results: pageItems(
      state.results.map((item) => resultSummary(state, item)),
      offset,
      limit,
      "Call workgraph_status with the same offset and limit to continue results.",
    ),
    delivery: pageItems(
      state.deliveries.map((delivery) => ({
        resultId: delivery.resultId,
        state: delivery.state,
        error: delivery.error ? compactText(delivery.error, 320) : undefined,
        failureCount: delivery.failureHistory?.length ?? 0,
      })),
      offset,
      limit,
      "Call workgraph_status with the same offset and limit to continue deliveries.",
    ),
    attention: pageItems(
      attention,
      offset,
      limit,
      "Call workgraph_status with the same offset and limit to continue attention.",
    ),
    accounting: pageItems(
      accounting.map((entry) => ({
        ...entry,
        reason: compactText(entry.reason, 320),
      })),
      offset,
      limit,
      "Call workgraph_status with the same offset and limit to continue accounting.",
    ),
    judgment: pageItems(
      state.dispositions.map(({ resultId, status, reason }) => ({
        resultId,
        status,
        reason: compactText(reason, 320),
      })),
      offset,
      limit,
      "Call workgraph_status with the same offset and limit to continue judgment.",
    ),
    completion: state.completion
      ? {
          completedAt: state.completion.completedAt,
          accountingCount: state.completion.accounting.length,
        }
      : undefined,
  };
}

export function focusedResult(
  state: WorkstreamState,
  resultId: string,
  section: ResultSection,
  offset: number,
  limit: number,
): Record<string, unknown> {
  const item = state.results.find((candidate) => candidate.id === resultId);
  if (!item) throw new Error(`Unknown result ${resultId}.`);
  const accounting =
    state.completion?.accounting.filter(
      (entry) =>
        (entry.kind === "unresolved_result" ||
          entry.kind === "undelivered_result") &&
        entry.resultId === item.id,
    ) ?? [];
  const base = {
    id: item.id,
    assignmentId: item.assignmentId,
    validity: item.validity,
    accounting,
  };
  if (item.validity !== "typed")
    return {
      ...base,
      ...(item.validity === "untyped"
        ? { text: item.text }
        : { detail: item.detail }),
    };
  const report = item.report;
  if (section === "summary")
    return {
      ...base,
      kind: report.kind,
      status: report.status,
      summary: report.summary,
      uncertainty: report.uncertainty ?? [],
      evidenceCount: report.evidence.length,
      findingsCount: report.findings.length,
      ...(report.kind === "implementation" && report.status === "completed"
        ? {
            outcome: report.outcome,
            ...(report.outcome === "no_change"
              ? { revision: report.revision, reason: report.reason }
              : { commit: report.commit }),
          }
        : {}),
      detail:
        "Use section evidence or findings to retrieve complete individual items.",
    };
  if (section === "evidence")
    return {
      ...base,
      evidence: pageItems(
        report.evidence,
        offset,
        limit,
        "Call workgraph_result with section evidence and nextOffset to continue.",
      ),
    };
  if (section === "findings")
    return {
      ...base,
      findings: pageItems(
        report.findings,
        offset,
        limit,
        "Call workgraph_result with section findings and nextOffset to continue.",
      ),
    };
  if (section === "attention")
    return {
      ...base,
      delivery: state.deliveries.find(
        (delivery) => delivery.resultId === resultId,
      ),
      judgments: state.dispositions.filter(
        (disposition) => disposition.resultId === resultId,
      ),
      retainedNotApplied: state.attempts
        .filter(
          (attempt) =>
            attempt.resultId === resultId &&
            attempt.composition?.state === "retained_not_applied",
        )
        .map((attempt) => ({
          attemptId: attempt.id,
          reason: attempt.composition?.reason,
          retainedRef: attempt.composition?.retainedRef,
          integratedRevision: attempt.composition?.integratedRevision,
        })),
    };
  return {
    ...base,
    kind: report.kind,
    status: report.status,
    summary: report.summary,
    uncertainty: report.uncertainty ?? [],
    evidence: pageItems(
      report.evidence,
      offset,
      limit,
      "Call workgraph_result with section evidence and nextOffset to continue.",
    ),
    findings: pageItems(
      report.findings,
      offset,
      limit,
      "Call workgraph_result with section findings and nextOffset to continue.",
    ),
    ...(report.kind === "implementation" && report.status === "completed"
      ? {
          outcome: report.outcome,
          ...(report.outcome === "no_change"
            ? { revision: report.revision, reason: report.reason }
            : { commit: report.commit }),
        }
      : {}),
    artifacts: item.artifacts,
  };
}

export function resultNotification(
  state: WorkstreamState,
  resultId: string,
): string {
  return [
    `Workgraph retained result ${resultId} is available for ${state.id}.`,
    "This is a retained-result availability notice, not new outstanding work.",
    "It may be presented after the result was already inspected or the workstream was completed; do not reprocess or reopen work solely because of this notice.",
    JSON.stringify(focusedResult(state, resultId, "summary", 0, 20), null, 2),
    "Use workgraph_result with this resultId and section evidence or findings for complete detail; continuation offsets are returned when needed.",
  ].join("\n");
}
