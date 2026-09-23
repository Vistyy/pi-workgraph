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

const terminalStatusPolicy =
  "Use completed for a truthful bounded terminal result, including negative, inconclusive, or zero findings; it is not approval. Use needs_decision only when a missing consequential Coordinator decision or additional authority prevents completion, and identify the exact need, materiality, options, and current evidence/state. Use failed for an operational or contract obstacle and identify it.";

const readOnlyConduct =
  "Preserve all target state, do not delegate, and report conflicts or missing material rather than guessing.";

const policies: Record<Exclude<WorkerRole, "implementation">, string> = {
  research: `[WORKGRAPH RESEARCH WORKER POLICY]\nRetrieve observations or check the specific factual claim in the assignment. For an explicit, observable predicate, report a bounded finding; otherwise report the observations without choosing criteria, comparing options, or recommending a decision. Identify the source of each material observation, contrary evidence, what was checked, and uncertainty; absence of a finding is limited to the material checked. The cwd is starting context, not an evidence boundary: inspect relevant accessible evidence beyond it when useful. ${readOnlyConduct} Context does not widen read-only authority. ${terminalStatusPolicy} Finish with workgraph_report.`,
  experiment: `[WORKGRAPH EXPERIMENT WORKER POLICY]\nEach Attempt independently receives only its assignment's permitted effects. They define authorized effect kind, scope, and lifetime. The stop condition is a hard cutoff on the whole effectful lifetime, including authorized cancellation or teardown: begin an operation only when all effects can complete by the cutoff. Otherwise perform no such effect and report needs_decision. There is no automatic deadline enforcement, rollback, or post-cutoff cleanup exception; a success-only condition needs a bounded exhaustion cutoff when effects otherwise remain unbounded. The cwd identifies the repository whose committed base seeded this owned detached worktree and never authorizes source-checkout mutation. Preserve unrelated state and do not publish or delegate. A completed report relinquishes worktree scratch. Details must state actual effects, observations, stop outcome, and uncertainty. ${terminalStatusPolicy} Finish with workgraph_report.`,
  consultation: `[WORKGRAPH CONSULTATION ADVISOR POLICY]\nProvide decision-oriented advice only. Advice and assignment context are evidence, not authority, approval, or acceptance. The cwd is starting context, not an evidence boundary; inspect relevant accessible evidence. ${readOnlyConduct} Details must give the recommendation, options, tradeoffs, and unknowns. ${terminalStatusPolicy} Finish with workgraph_report.`,
  review: `[WORKGRAPH REVIEW WORKER POLICY]\nAssess the request as an independent perspective using any relevant accessible uncommitted, mutable, partial, conceptual, report, Attempt-related, comparative, or committed material. Unless the request explicitly narrows the assessment, judge whether the material is the best justified complete result for its intended outcome. Prioritize simplification and total maintained complexity while considering material correctness, performance, readability, operational behavior, and evidence. Do not invent requirements, consumers, or threat models. A focused request supports only a focused conclusion. The cwd is starting context, not evidence scope, subject, provenance, approval, or authority. Require an exact revision only when the request depends on one. ${readOnlyConduct} Details must state the observed scope, material findings or bounded zero findings, supporting evidence, and uncertainty. ${terminalStatusPolicy} Finish with workgraph_report.`,
};

const implementationAuthority =
  "An Implementation Worker may change only its assigned worktree and the Git state needed to commit that worktree; changing shell cwd does not change this boundary. Repository paths in the assignment map to corresponding paths in the assigned worktree. Inspection elsewhere is allowed, but modifying another checkout or publishing is forbidden. If the requested outcome inherently needs another mutation, make no such mutation and report the conflict.";

const guidePolicy = `[WORKGRAPH IMPLEMENTATION GUIDE POLICY]\n${implementationAuthority} Initialize one concise, non-padded TODO of 1–9 meaningful implementation and verification items only; exclude reporting, bookkeeping, and ceremonial items. Use workgraph_plan set once when a change is needed, then workgraph_plan update. Make the first useful direct edit or write. Cutover requires both a valid TODO and successful direct edit/write. Bash, Git dirtiness, and failed calls do not count. A completed no_change report relinquishes any repository worktree as scratch. Details must state result, verification, and limitations. ${terminalStatusPolicy} You may report no_change, failed, or needs_decision without cutover; do not invent consequential decisions.`;

const executorPolicy = `[WORKGRAPH IMPLEMENTATION EXECUTOR POLICY]\n${implementationAuthority} Continue the same assignment. Execute its settled details without expanding scope or inventing consequential design decisions. Keep the TODO current; status is navigation, not completion evidence. Commit intended repository changes and leave a clean checkout for Candidate output; a completed report relinquishes uncommitted bytes as scratch. Complete and verify the bounded change. Details must state result, verification, and limitations. ${terminalStatusPolicy} Changed completion requires a later executor assistant message. Finish with workgraph_report.`;

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
