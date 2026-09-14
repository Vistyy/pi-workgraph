import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Result } from "effect";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  type WorkerObjectiveDetails,
  WorkerObjectiveDetailsSchema,
  type WorkerRole,
} from "./session.js";

export type WorkerPhase = "guide" | "executor";

export const EXECUTOR_START_ENTRY = "pi-workgraph-executor-start";

export const EXECUTOR_FAILURE_MESSAGE = "pi-workgraph-executor-failure";

const WORKER_OBJECTIVE_MESSAGE_TYPE = "pi-workgraph-objective";

const ContentSchema = Type.String({ minLength: 1, pattern: "\\S" });

const policies: Record<Exclude<WorkerRole, "implementation">, string> = {
  research:
    "[WORKGRAPH RESEARCH WORKER POLICY]\nAnswer only the assigned question using read-only evidence from the assigned cwd. Repository dirtiness is allowed: preserve unrelated changes and disclose material unknowns. Read-only inspection is the only permitted effect; the Coordinator owns disposition. Do not modify files or delegate another worker. Finish with workgraph_report.",
  experiment:
    "[WORKGRAPH EXPERIMENT WORKER POLICY]\nWork only within the assignment's explicit permitted effects and stop condition. A completed report relinquishes any repository worktree as scratch, so include the durable evidence in the report. Do not publish or delegate. Disclose observed effects and material unknowns; the Coordinator owns uncertain output. Finish with workgraph_report.",
  consultation:
    "[WORKGRAPH CONSULTATION ADVISOR POLICY]\nProvide decision-oriented advice only. Advice is evidence, not authority, approval, or acceptance. Repository dirtiness is allowed; preserve unrelated changes and surface consequential unknowns. Read-only inspection is the only permitted effect, and the Coordinator owns disposition. Do not modify files or delegate. Finish with workgraph_report.",
  review:
    "[WORKGRAPH REVIEW WORKER POLICY]\nReview only the assigned subject and concern at the exact stated base and candidate revisions; verify that identity before making claims. Repository dirtiness is allowed: preserve unrelated changes and disclose material unknowns. Read-only inspection is the only permitted effect, and the Coordinator owns disposition. Do not edit files or delegate. Return evidence and actionable findings; zero findings is valid. Finish with workgraph_report.",
};

const guidePolicy =
  "[WORKGRAPH IMPLEMENTATION GUIDE POLICY]\nInspect the assignment and initialize one concise 1–9 item TODO with workgraph_plan set when a change is needed. Make the first useful direct edit or write. Cutover requires both a valid TODO and successful direct edit/write. Bash, Git dirtiness, and failed calls do not count. A completed no_change report relinquishes any repository worktree as scratch. You may report no_change, failed, or escalated without cutover; do not invent consequential decisions.";

const executorPolicy =
  "[WORKGRAPH IMPLEMENTATION EXECUTOR POLICY]\nContinue the same assignment. Execute its settled details without expanding scope or inventing consequential design decisions. Keep the TODO current; status is navigation, not completion evidence. Commit intended repository changes and leave a clean checkout for Candidate output; a completed report relinquishes uncommitted bytes as scratch. Complete and verify the bounded change. Changed completion requires a later executor assistant message. Finish with workgraph_report.";

export function workerSystemPolicy(role: WorkerRole, phase: WorkerPhase): string {
  return role === "implementation"
    ? phase === "guide"
      ? guidePolicy
      : executorPolicy
    : policies[role];
}

export interface WorkerAssignment {
  readonly content: string;
  readonly details: WorkerObjectiveDetails;
}

/** The exact current-branch objective is the sole Worker assignment authority. */
export function readWorkerAssignment(
  entries: readonly SessionEntry[],
  configuredRole: string,
): Result.Result<WorkerAssignment, string> {
  const objectives = entries.filter(
    (entry) =>
      entry.type === "custom_message" && entry.customType === WORKER_OBJECTIVE_MESSAGE_TYPE,
  );

  if (objectives.length !== 1)
    return Result.fail("Worker requires exactly one objective on its branch.");
  const objective = objectives[0];

  if (
    objective?.type !== "custom_message" ||
    !Value.Check(ContentSchema, objective.content) ||
    !Value.Check(WorkerObjectiveDetailsSchema, objective.details)
  )
    return Result.fail("Worker objective is malformed.");
  const details = Value.Decode(WorkerObjectiveDetailsSchema, objective.details);

  if (details.role !== configuredRole)
    return Result.fail("Worker role does not match the authoritative objective.");

  if (
    details.role === "implementation"
      ? details.executor === undefined
      : details.executor !== undefined
  )
    return Result.fail("Worker objective has invalid executor details for its role.");

  return Result.succeed({ content: objective.content, details });
}
