import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { WorkerSessionMode } from "./domain/report.js";

export type WorkerPhase = "guide" | "executor";
export type WorkerPolicyRole = WorkerSessionMode | "consultation" | "experiment";
export type WorkerObjectiveRestore =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly content: string }
  | { readonly kind: "malformed" };

export interface WorkerContextIdentity {
  readonly runId: string;
  readonly nodeId: string;
}

export const EXECUTOR_START_ENTRY = "pi-workgraph-executor-start";
const EXECUTOR_FAILURE_MESSAGE = "pi-workgraph-executor-failure";
const WORKER_RECOVERY_MESSAGE_TYPE = "pi-workgraph-worker-recovery";
const WORKER_OBJECTIVE_MESSAGE_TYPE = "pi-workgraph-objective";

const WorkerContextIdentitySchema = Type.Object({ runId: Type.String(), nodeId: Type.String() });
const WorkerMessageContentSchema = Type.String();
const WorkerContextDetailsSchema = Type.Intersect([
  WorkerContextIdentitySchema,
  Type.Object({ kind: Type.Literal("recovery") }),
]);
type WorkerContextDetails = Static<typeof WorkerContextDetailsSchema>;
type WorkerContextMessage = Pick<
  Parameters<ExtensionAPI["sendMessage"]>[0],
  "customType" | "content" | "display" | "details"
>;

const researchPolicy =
  "[WORKGRAPH RESEARCH WORKER POLICY]\nAnswer only the assigned question using read-only evidence from the live project cwd. Tracked and untracked local changes may be present; do not require cleanliness, copy files, or modify them. Supply the requested observations and retain material unknowns. Do not delegate another worker. Finish with workgraph_report.";
const experimentPolicy =
  "[WORKGRAPH EXPERIMENT WORKER POLICY]\nAnswer the question within the explicitly permitted effects and stop condition in this disposable worktree. Leave all outputs in the assigned worktree and report direct observations, failures and limits; the coordinator decides whether to apply or irreversibly discard the output. Do not compose, publish, or delegate another worker. Finish with workgraph_report.";
const consultationPolicy =
  "[WORKGRAPH CONSULTATION ADVISOR POLICY]\nProvide decision-oriented advice only for the assigned question and coordinator-known context. Advice is evidence, not authority, approval, or acceptance. Use read-only project research when useful; do not modify files or delegate another worker. Return one standard research report with material unknowns. Finish with workgraph_report.";
const reviewPolicy =
  "[WORKGRAPH REVIEW WORKER POLICY]\nReview only the identified subject and concern. Ordinary result, artifact, and comparison reviews may observe the live project cwd. An exact revision review runs in an owned worktree checked out at the requested SHA; inspect that exact commit with Git and cite that revision in evidence. Do not edit files or delegate another worker. Return evidence and actionable findings; zero findings is valid. Finish with workgraph_report.";
const guidePolicy =
  "[WORKGRAPH IMPLEMENTATION GUIDE POLICY]\nInspect the assignment and worktree, treating settled boundaries as constraints. If a change is needed, initialize one concise 1–9 item TODO with workgraph_plan set; each item must state its validation. Make the first useful edit yourself. Executor cutover occurs only after both a valid TODO and a successful direct edit or write, in either order. Failed edits, bash, and Git dirtiness do not count. If no change is needed, report no_change from the guide. Report failure or escalation without editing when appropriate; do not invent consequential design decisions.";
const executorPolicy =
  "[WORKGRAPH IMPLEMENTATION EXECUTOR POLICY]\nContinue the same assignment and worktree. Use workgraph_plan get or update to keep the current TODO accurate; status is navigation, not completion evidence. Do not expand scope or infer consequential design decisions. Complete and verify the bounded change, leave useful output in the assigned worktree, and finish with workgraph_report. A changed completion requires a later executor assistant message. Truthful failure or escalation remains valid.";

export function workerSystemPolicy(
  role: WorkerPolicyRole,
  phase: WorkerPhase = "executor",
): string {
  if (role === "research") return researchPolicy;
  if (role === "experiment") return experimentPolicy;
  if (role === "consultation") return consultationPolicy;
  if (role === "review") return reviewPolicy;
  return phase === "guide" ? guidePolicy : executorPolicy;
}

export function executorFailureMessage(
  identity: WorkerContextIdentity,
  diagnostic: string,
): WorkerContextMessage {
  return {
    customType: EXECUTOR_FAILURE_MESSAGE,
    content: `[WORKGRAPH EXECUTOR SELECTION FAILED]\n${diagnostic}\nRemain on the guide. Do not make further changed implementation attempts or retry selection automatically. A truthful failed or escalated report remains available.`,
    display: false,
    details: identity,
  };
}

export function recoveryMessage(input: {
  readonly identity: WorkerContextIdentity;
  readonly mode: WorkerSessionMode;
  readonly phase: WorkerPhase;
  readonly objective: WorkerObjectiveRestore;
  readonly planText?: string;
  readonly warnings: ReadonlyArray<string | undefined>;
}): WorkerContextMessage {
  const { identity, mode, phase, objective, planText, warnings } = input;
  const details: WorkerContextDetails = { ...identity, kind: "recovery" };
  return {
    customType: WORKER_RECOVERY_MESSAGE_TYPE,
    content: [
      "[WORKGRAPH CURRENT-ATTEMPT RECOVERY]",
      `Attempt identity: ${identity.runId}/${identity.nodeId}.`,
      `Worker mode: ${mode}.`,
      mode === "implementation" ? `Current phase: ${phase}.` : "",
      objectiveText(objective),
      planText ?? "",
      ...warnings,
    ]
      .filter((line): line is string => line !== undefined && line.length > 0)
      .join("\n"),
    display: false,
    details,
  };
}

export function hasActiveObjective(
  entries: readonly SessionEntry[],
  identity: WorkerContextIdentity,
): boolean {
  return entries.some(
    (entry) =>
      entry.type === "custom_message" &&
      ((entry.customType === WORKER_OBJECTIVE_MESSAGE_TYPE &&
        isWorkerIdentityData(entry.details, identity)) ||
        (entry.customType === WORKER_RECOVERY_MESSAGE_TYPE &&
          contextDetails(entry.details, identity) !== undefined)),
  );
}

export function hasActiveRecovery(
  entries: readonly SessionEntry[],
  identity: WorkerContextIdentity,
): boolean {
  return entries.some(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === WORKER_RECOVERY_MESSAGE_TYPE &&
      contextDetails(entry.details, identity) !== undefined,
  );
}

export function hasExecutorStart(
  entries: readonly SessionEntry[],
  identity: WorkerContextIdentity,
): boolean {
  return entries.some(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === EXECUTOR_START_ENTRY &&
      isWorkerIdentityData(entry.data, identity),
  );
}

export function executorFailure(
  entries: readonly SessionEntry[],
  identity: WorkerContextIdentity,
): string | undefined {
  for (const entry of [...entries].reverse()) {
    if (
      entry.type !== "custom_message" ||
      entry.customType !== EXECUTOR_FAILURE_MESSAGE ||
      !isWorkerIdentityData(entry.details, identity)
    )
      continue;
    return Value.Check(WorkerMessageContentSchema, entry.content)
      ? Value.Decode(WorkerMessageContentSchema, entry.content)
      : "Executor selection failed.";
  }
  return undefined;
}

function objectiveText(objective: WorkerObjectiveRestore): string {
  if (objective.kind === "valid")
    return `[WORKGRAPH CURRENT-ATTEMPT OBJECTIVE]\n${objective.content}`;
  if (objective.kind === "malformed")
    return "[WORKGRAPH CURRENT-ATTEMPT OBJECTIVE]\nThe exact objective snapshot was malformed; do not guess its constraints.";
  return "[WORKGRAPH CURRENT-ATTEMPT OBJECTIVE]\nNo exact objective snapshot was found; do not infer authority.";
}

function contextDetails(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Session custom-message details are decoded here at their external boundary.
  data: unknown,
  identity: WorkerContextIdentity,
): WorkerContextDetails | undefined {
  if (!Value.Check(WorkerContextDetailsSchema, data)) return undefined;
  const details = Value.Decode(WorkerContextDetailsSchema, data);
  return isWorkerIdentityData(details, identity) ? details : undefined;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Shared session-entry identity data is decoded here at its external boundary.
export function isWorkerIdentityData(data: unknown, identity: WorkerContextIdentity): boolean {
  if (!Value.Check(WorkerContextIdentitySchema, data)) return false;
  const decoded = Value.Decode(WorkerContextIdentitySchema, data);
  return decoded.runId === identity.runId && decoded.nodeId === identity.nodeId;
}
