import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { ResolvedReviewInput } from "./coordination/reconciliation.js";
import type { WorkerSessionMode } from "./domain/report.js";
import type { CandidateLineage, Intent, TaskContract } from "./domain/workstream.js";

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
  "[WORKGRAPH IMPLEMENTATION EXECUTOR POLICY]\nContinue the same assignment and worktree. Use workgraph_plan get or update to keep the current TODO accurate; status is navigation, not completion evidence. Do not expand scope or infer consequential design decisions. Complete and verify the bounded change, create exactly one direct commit on the supplied base, leave the worktree clean, and finish with workgraph_report. A changed completion requires a later executor assistant message. Truthful failure or escalation remains valid.";

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

/** One concrete workstream worker assignment; every launch fact is built once here. */
export interface WorkerAssignment {
  readonly mode: WorkerSessionMode;
  readonly role: "consultation" | "implement" | "research" | "review";
  readonly objective: string;
  readonly prompt: string;
  readonly environment: Record<string, string>;
}

export interface AssignmentInput {
  task: TaskContract;
  intent: Intent;
  intentIndex: number;
  repositoryRoot: string;
  workerCwd: string;
  runId: string;
  attemptId: string;
  baseRevision?: string;
  candidate?: CandidateLineage;
  /** Resolved review content; an unresolved review falls back to its own subject. */
  reviewSubject?: ResolvedReviewInput;
  executor?: { model: string; thinking?: string };
  codingAgentDir?: string;
  continuationOf?: string;
}

export function workerAssignment(input: AssignmentInput): WorkerAssignment {
  const capability = capabilityForKind(input.task.kind);
  const experiment = input.task.kind === "experiment";
  return {
    mode: workerMode(capability),
    role: workerRole(capability),
    objective: assignmentObjective(input),
    prompt: assignmentPrompt(input),
    environment: assignmentEnvironment(input, capability, experiment),
  };
}

/** Session mode for one workstream Task; the kind-to-fact policy lives only here. */
export function workerSessionMode(task: TaskContract): WorkerSessionMode {
  return workerMode(capabilityForKind(task.kind));
}

type WorkerCapability = "implement" | "research" | "review" | "consultation";

function capabilityForKind(kind: TaskContract["kind"]): WorkerCapability {
  if (kind === "implementation") return "implement";
  if (kind === "review") return "review";
  if (kind === "consultation") return "consultation";
  return "research";
}

function workerMode(capability: WorkerCapability): WorkerSessionMode {
  if (capability === "implement") return "implementation";
  if (capability === "review") return "review";
  return "research";
}

function workerRole(capability: WorkerCapability): WorkerAssignment["role"] {
  if (capability === "implement") return "implement";
  if (capability === "review") return "review";
  if (capability === "consultation") return "consultation";
  return "research";
}

function workerPolicyRole(
  capability: WorkerCapability,
  disposableExperiment: boolean,
): WorkerPolicyRole {
  if (disposableExperiment) return "experiment";
  if (capability === "consultation") return "consultation";
  return workerMode(capability);
}

const CONTINUATION_INSTRUCTION = "Continue the assigned Workgraph objective now.";
const EXPERIMENT_NOTES = [
  "On successful clean isolated output the checkout is compacted and this exact maintained output branch remains until explicit apply or irreversible discard_output.",
  "Experimental changes are not maintained product changes and must not be applied to the destination.",
];

function assignmentObjective(input: AssignmentInput): string {
  const { task, intent, baseRevision } = input;
  const lines = [
    `Assignment: ${task.objective}`,
    `Intent index: ${input.intentIndex}`,
    `Intent: ${intent.statement}`,
    `Repository: ${input.repositoryRoot}`,
    `Assigned working directory: ${input.workerCwd}`,
    `Constraints: ${intent.constraints.join("; ")}`,
  ];
  if (baseRevision !== undefined) lines.push(`Exact base/review revision: ${baseRevision}`);
  appendCandidateLines(lines, input.candidate);
  if (task.kind === "research")
    lines.push(`Expected evidence: ${task.expectedEvidence.join("; ")}`);
  if (task.kind === "consultation" && task.context !== undefined)
    lines.push(`Coordinator-known context: ${task.context}`);
  if (task.kind === "experiment") {
    lines.push(
      `Permitted effects: ${task.permittedEffects.join("; ")}`,
      `Stop condition: ${task.stopCondition}`,
      `Expected evidence: ${task.expectedEvidence.join("; ")}`,
      ...EXPERIMENT_NOTES,
    );
  }
  if (task.kind === "implementation")
    lines.push(
      `Acceptance: ${task.acceptance.join("; ")}`,
      "If a change is needed, create one clean commit containing the assigned result and report its exact revision as a retained candidate. The Coordinator decides whether that candidate is a final result or an explicitly planned intermediate. If the requirement already holds, verify it and report no_change with the inspected base revision and reason.",
    );
  if (task.kind === "review")
    lines.push(
      `Concern: ${task.concern}`,
      `Subject: ${JSON.stringify(reviewSubjectFor(input))}`,
      "Do not edit files.",
    );
  return lines.join("\n");
}

function assignmentPrompt(input: AssignmentInput): string {
  const { task } = input;
  const lines = [
    `Workgraph assignment for Task ${task.id}.`,
    `Repository: ${input.repositoryRoot}`,
    `Assigned working directory: ${input.workerCwd}`,
  ];
  if (input.baseRevision !== undefined)
    lines.push(`Exact base/review revision: ${input.baseRevision}`);
  appendCandidateLines(lines, input.candidate);
  if (task.kind === "implementation")
    lines.push(
      "For a changed result, use the assigned worktree, create exactly one direct commit on the exact base, and leave it clean; report that commit. For no change, report the unchanged exact base without a commit. Do not integrate into the coordinator repository or push.",
    );
  if (task.kind === "review")
    lines.push(
      "Review only the assigned subject; an exact revision must be inspected as that revision.",
    );
  lines.push(CONTINUATION_INSTRUCTION);
  return lines.join("\n");
}

function assignmentEnvironment(
  input: AssignmentInput,
  capability: WorkerCapability,
  experiment: boolean,
): Record<string, string> {
  const environment = new Map<string, string>([
    ["PI_WORKGRAPH_MODE", workerMode(capability)],
    ["PI_WORKGRAPH_POLICY_ROLE", workerPolicyRole(capability, experiment)],
    ["PI_WORKGRAPH_RUN_ID", input.runId],
    ["PI_WORKGRAPH_NODE_ID", input.attemptId],
    ["PI_WORKGRAPH_REPOSITORY", input.repositoryRoot],
    ["PI_WORKGRAPH_WORKER_CWD", input.workerCwd],
  ]);
  if (input.baseRevision !== undefined)
    environment.set("PI_WORKGRAPH_BASE_COMMIT", input.baseRevision);
  if (input.codingAgentDir !== undefined && input.codingAgentDir !== "")
    environment.set("PI_CODING_AGENT_DIR", input.codingAgentDir);
  if (experiment) environment.set("PI_WORKGRAPH_EXPERIMENT", "1");
  if (input.executor !== undefined) {
    environment.set("PI_WORKGRAPH_IMPLEMENTATION_START", "guide");
    environment.set("PI_WORKGRAPH_EXECUTOR_MODEL", input.executor.model);
    if (input.executor.thinking !== undefined)
      environment.set("PI_WORKGRAPH_EXECUTOR_THINKING", input.executor.thinking);
  }
  if (input.continuationOf !== undefined)
    environment.set("PI_WORKGRAPH_CONTINUATION_OF", input.continuationOf);
  return Object.fromEntries(environment);
}

function appendCandidateLines(lines: string[], candidate: CandidateLineage | undefined): void {
  if (candidate === undefined) return;
  lines.push(`Candidate lineage: ${candidate.kind}; root commit ${candidate.rootCommit}.`);
  if (candidate.kind === "initial") return;
  lines.push(
    `Retained parent candidate: attempt ${candidate.parentAttemptId}, exact commit ${candidate.parentCommit}.`,
  );
  lines.push(
    candidate.kind === "correction"
      ? "This is an isolated correction: continue the retained candidate history from the parent commit and preserve a direct commit."
      : "This is an explicit isolated integration: integrate the retained parent candidate's content into the assigned current destination base, then report only the new candidate commit and its current-base evidence.",
  );
}

function reviewSubjectFor(
  input: AssignmentInput,
): ResolvedReviewInput | Extract<TaskContract, { kind: "review" }>["subject"] | undefined {
  if (input.reviewSubject !== undefined) return input.reviewSubject;
  return input.task.kind === "review" ? input.task.subject : undefined;
}
