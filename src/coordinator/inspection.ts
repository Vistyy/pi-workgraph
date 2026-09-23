import type { Static, TSchema } from "typebox";
import type { AttemptRecord } from "../domain/records.js";
import type { WorkerReport } from "../domain/report.js";
import type { SessionRuntime } from "./runtime.js";

type InspectInput =
  | { readonly section: "overview" }
  | {
      readonly section: "task";
      readonly id?: string;
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly section: "attempt";
      readonly id?: string;
      readonly taskId?: string;
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly section: "report";
      readonly attemptId: string;
      readonly offset?: number;
      readonly maxChars?: number;
    };

export function inspect(runtime: SessionRuntime, params: Static<TSchema>) {
  // Pi decodes the registered inspection union before calling this helper.
  const input = params as InspectInput;

  switch (input.section) {
    case "overview": {
      const status = runtime.inspectionStatus();

      return {
        counts: runtime.store.counts(),
        blockers: status.blockers,
        activeWorkers: status.activeWorkers,
      };
    }

    case "task":
      return inspectTasks(runtime, input);
    case "attempt":
      return inspectAttempts(runtime, input);
    case "report":
      return inspectReport(runtime, input);
  }
}

function inspectTasks(runtime: SessionRuntime, input: Extract<InspectInput, { section: "task" }>) {
  if (input.id !== undefined) return runtime.store.readTask(input.id);
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 20;

  return {
    offset,
    limit,
    tasks: runtime.store.listTasks(offset, limit).map((record) => ({
      id: record.id,
      targetKind: record.task.target.kind,
      taskKind: record.task.contract.kind,
    })),
  };
}

function inspectAttempts(
  runtime: SessionRuntime,
  input: Extract<InspectInput, { section: "attempt" }>,
) {
  if (input.id !== undefined) return inspectedAttempt(runtime, runtime.store.readAttempt(input.id));
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 20;

  return {
    offset,
    limit,
    attempts: runtime.store.listAttempts(offset, limit, input.taskId).map((attempt) => ({
      taskId: attempt.taskId,
      attemptId: attempt.id,
      outcome: attempt.outcome?.result.kind ?? null,
      output: attempt.output?.kind ?? null,
    })),
  };
}

function inspectReport(
  runtime: SessionRuntime,
  input: Extract<InspectInput, { section: "report" }>,
) {
  const attempt = runtime.store.readAttempt(input.attemptId);

  if (attempt.outcome?.result.kind !== "reported") throw new Error("Attempt has no report.");
  const text = JSON.stringify(attempt.outcome.result.report);
  const offset = input.offset ?? 0;
  const maxChars = input.maxChars ?? 20_000;
  const totalChars = text.length;

  if (offset > totalChars)
    throw new Error(`Report offset ${offset} exceeds totalChars ${totalChars}.`);

  if (offset === 0 && totalChars <= maxChars)
    return { attemptId: input.attemptId, totalChars, report: attempt.outcome.result.report };

  const nextOffset = Math.min(offset + maxChars, totalChars);

  return {
    attemptId: input.attemptId,
    offset,
    maxChars,
    totalChars,
    text: text.slice(offset, nextOffset),
    nextOffset: nextOffset < totalChars ? nextOffset : null,
  };
}

type InspectedOutcome = {
  kind: string;
  summary: string;
  reportStatus?: string;
  reportOutcome?: string;
};

function inspectedAttempt(runtime: SessionRuntime, attempt: AttemptRecord) {
  const outcome = attempt.outcome;
  const task = runtime.store.readTask(attempt.taskId).task;
  let outcomeReceipt: InspectedOutcome | null = null;

  if (outcome?.result.kind === "reported") {
    outcomeReceipt = {
      kind: outcome.result.kind,
      reportStatus: outcome.result.report.status,
      summary: outcome.result.report.summary,
    };

    if (outcome.result.report.role === "implementation" && "outcome" in outcome.result.report)
      outcomeReceipt.reportOutcome = outcome.result.report.outcome;
  } else if (outcome !== undefined) {
    outcomeReceipt = { kind: outcome.result.kind, summary: outcome.result.reason };
  }

  return {
    attemptId: attempt.id,
    taskId: attempt.taskId,
    task: { target: task.target, contract: task.contract },
    spec: attempt.spec,
    worker: attempt.worker ?? null,
    output: attempt.output ?? null,
    blocker: runtime.blockerFor(attempt.id) ?? null,
    effectiveModels: outcome?.effectiveModels ?? [],
    outcome: outcomeReceipt,
    reportPreview:
      outcome?.result.kind === "reported" ? previewReport(outcome.result.report) : null,
  };
}

function previewReport(report: WorkerReport, maxChars = 2_000) {
  const text = JSON.stringify(report);

  return {
    text: text.slice(0, maxChars),
    totalChars: text.length,
    truncated: text.length > maxChars,
  };
}
