import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import type { AttemptRecord } from "../domain/records.js";
import { RuntimeError, type SessionRuntime } from "./runtime.js";

export function retainedTip(runtime: SessionRuntime, attemptId: string): string {
  const attempt = runtime.store.readAttempt(attemptId);

  if (attempt.output?.kind !== "retained")
    throw new Error("Candidate parent has no retained output.");

  return attempt.output.tip;
}

type ControlReceipt = {
  action: "cancel" | "steer" | "apply" | "discard_output";
  taskId: string;
  attemptId: string;
  output: AttemptRecord["output"] | null;
  outcome: unknown;
  blocker: string | null;
  steering?: { status: "submitted" };
};

export function controlReceipt(
  runtime: SessionRuntime,
  action: "cancel" | "steer" | "apply" | "discard_output",
  attempt: AttemptRecord,
  steering?: "submitted",
) {
  const result = attempt.outcome?.result;

  const receipt: ControlReceipt = {
    action,
    taskId: attempt.taskId,
    attemptId: attempt.id,
    output: attempt.output ?? null,
    outcome:
      result === undefined
        ? null
        : result.kind === "reported"
          ? {
              kind: result.kind,
              status: result.report.status,
              summary: result.report.summary,
            }
          : { kind: result.kind, reason: result.reason },
    blocker: runtime.blockerFor(attempt.id) ?? null,
  };

  if (steering !== undefined) receipt.steering = { status: steering };

  return receipt;
}

export function registerTask<S extends TSchema>(
  pi: ExtensionAPI,
  name: string,
  label: string,
  parameters: S,
  run: (params: Static<S>, ctx: ExtensionContext) => Promise<object>,
  serialize: <A>(run: () => Promise<A>) => Promise<A>,
): void {
  pi.registerTool({
    name,
    label: `Workgraph ${label}`,
    description: `Create one immutable ${label} Task with one or more selected initial Attempts.`,
    parameters,
    execute(_id, params, _signal, _update, ctx) {
      // Pi decodes params against the registered TypeBox schema before execution.
      const decoded = params as Static<S>;

      return serialize(() => run(decoded, ctx).then(result));
    },
  });
}

export function attemptReceipt(record: AttemptRecord) {
  return { taskId: record.taskId, attemptId: record.id, spec: record.spec };
}

export function result<Value>(value: Value) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value,
  };
}

export function publicMessage(cause: unknown): string {
  return (
    cause instanceof RuntimeError
      ? `${cause.operation}: ${cause.message}`
      : cause instanceof Error
        ? cause.message
        : "operation failed"
  )
    .replace(/\s+/g, " ")
    .slice(0, 500);
}
