import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { ResolvedReviewInput } from "./canonical-reconciliation.js";
import type { CandidateLineage, Intent, TaskContract } from "./domain/workstream.js";
import type { WorkerSessionMode } from "./report-schema.js";

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

const WORKER_PHASE_MESSAGE_TYPE = "pi-workgraph-worker-phase";
const WORKER_RECOVERY_MESSAGE_TYPE = "pi-workgraph-worker-recovery";
const WORKER_OBJECTIVE_MESSAGE_TYPE = "pi-workgraph-objective";

const WorkerContextIdentitySchema = Type.Object({
  runId: Type.String(),
  nodeId: Type.String(),
});
const WorkerContextDetailsSchema = Type.Intersect([
  WorkerContextIdentitySchema,
  Type.Object({
    kind: Type.Union([Type.Literal("phase"), Type.Literal("recovery")]),
    phase: Type.Optional(Type.Union([Type.Literal("guide"), Type.Literal("executor")])),
  }),
]);
type ParsedWorkerContextIdentity = Static<typeof WorkerContextIdentitySchema>;
type WorkerContextDetails = Static<typeof WorkerContextDetailsSchema>;
type WorkerContextMessage = Pick<
  Parameters<ExtensionAPI["sendMessage"]>[0],
  "customType" | "content" | "display" | "details"
>;

const researchPolicy =
  "[WORKGRAPH RESEARCH WORKER POLICY]\nAnswer only the assigned question using read-only evidence from the live project cwd. Tracked and untracked local changes may be present; do not require cleanliness, copy files, or modify them. Supply the requested observations and retain material unknowns. Do not delegate another worker. Finish with workgraph_report.";
const experimentPolicy =
  "[WORKGRAPH EXPERIMENT WORKER POLICY]\nAnswer the question within the explicitly permitted effects and stop condition in this disposable worktree. Leave all outputs in the assigned worktree and report direct observations, failures and limits; the coordinator decides when to release the worktree. Do not compose, publish, or delegate another worker. Finish with workgraph_report.";
const consultationPolicy =
  "[WORKGRAPH CONSULTATION ADVISOR POLICY]\nProvide decision-oriented advice only for the assigned question and coordinator-known context. Advice is evidence, not authority, approval, or acceptance. Use read-only project research when useful; do not modify files or delegate another worker. Return one standard research report with material unknowns. Finish with workgraph_report.";
const reviewPolicy =
  "[WORKGRAPH REVIEW WORKER POLICY]\nReview only the identified subject and concern. Ordinary result, artifact, and comparison reviews may observe the live project cwd. An exact revision review runs in an owned worktree checked out at the requested SHA; inspect that exact commit with Git (for example git show, git diff, and git ls-tree) and cite that revision in evidence. Do not silently treat live working files as that commit or claim tests against another revision. Execute verification only when it genuinely targets the requested subject. Do not edit files or delegate another worker. Return evidence and actionable findings; zero findings is valid. Finish with workgraph_report.";
const guidePolicy =
  "Inspect the assignment and current isolated worktree. Treat its settled decisions as constraints; ground the local plan in code without replacing the intended solution. If implementation requires choosing an unsettled responsibility owner, retained or removed mechanism, interaction contract, consumer or integration change, end-to-end flow, or failure, ordering, precedence, concurrency, or lifetime behavior, escalate before editing. Return specific contradictions or consequential decisions outside the stated discretion to the coordinator rather than silently resolving them. If the requirement already holds, verify it and report no_change with the inspected base revision and reason; no edit or executor turn is required. If a change is needed, use workgraph_plan with action update to record one concise plan grounded in inspected code. Prefer 5-9 meaningful implementation or verification steps, use fewer for genuinely small work, and retain every explicitly required task. Record the local approach and rationale, concrete risks or unknowns, and meaningful verification. The update assigns stable step IDs. Then make the first useful implementation edit yourself. Recording or revising the plan does not switch models. The first successful edit or observed Git change triggers the executor switch; do not stop or wait for a handoff after planning. Changed work must complete through the executor. Missing plan state does not block truthful implementation, failure, or escalation. If required work crosses the authorized scope, report escalation without editing.";
const executorPolicy =
  "Continue this same worker trajectory in the isolated worktree and preserve the inherited assignment. Adjust local implementation knowledge and execution steps within its stated discretion; return conflicts with settled decisions or missing consequential decisions to the coordinator rather than redesigning the solution. If later evidence exposes an unsettled responsibility owner, retained or removed mechanism, interaction contract, consumer or integration change, end-to-end flow, or failure, ordering, precedence, concurrency, or lifetime behavior, stop editing and escalate. Inspect the current plan with stable step IDs and independently reconcile it against the worktree. Use workgraph_plan targeted actions only (get, update_overview, update_step, add_step, remove_step): keep the local approach, rationale, risks, step text, statuses, and notes current as evidence changes, but never replace the full plan. Escalate consequential conflicts to the coordinator instead of inferring new scope; the immutable assignment remains authoritative and no schema verifies semantic conformity. When the plan is absent or malformed, do not author replacement direction; continue only with truthful work, report, or escalation and explain that no scope was inferred. Plan statuses are not correctness evidence and unfinished steps do not block a truthful failure or escalation. Complete the bounded assignment and run meaningful verification. For changed code, create exactly one direct commit on the supplied base and leave the worktree clean. If verification establishes no change is needed and the worktree is clean at the supplied base, report no_change with that revision and reason instead. Return workgraph_report with evidence and explicit limitations. Escalate required work beyond the authorized scope.";

export function workerSystemPolicy(role: WorkerPolicyRole): string {
  if (role === "research") return researchPolicy;
  if (role === "experiment") return experimentPolicy;
  if (role === "consultation") return consultationPolicy;
  if (role === "review") return reviewPolicy;
  return [
    "[WORKGRAPH IMPLEMENTATION WORKER POLICY]",
    "The latest model-visible phase announcement or current-attempt recovery for this exact attempt selects one phase below. Apply only that phase's rules. A later executor announcement or recovery makes earlier guide state historical; phase never replaces or expands the assigned objective.",
    "[GUIDE PHASE RULES]",
    guidePolicy,
    "[EXECUTOR PHASE RULES]",
    executorPolicy,
  ].join("\n");
}

export function phaseActivationMessage(
  identity: WorkerContextIdentity,
  phase: WorkerPhase,
): WorkerContextMessage {
  const details: WorkerContextDetails = { ...identity, kind: "phase", phase };
  return {
    customType: WORKER_PHASE_MESSAGE_TYPE,
    content: [
      "[WORKGRAPH IMPLEMENTATION PHASE]",
      `Attempt identity: ${identity.runId}/${identity.nodeId}.`,
      `Current phase: ${phase}.`,
      "This exact current-attempt phase announcement supersedes earlier phase announcements for this attempt. It does not replace or expand the assigned objective.",
    ].join("\n"),
    display: false,
    details,
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
  if (mode === "implementation") details.phase = phase;
  return {
    customType: WORKER_RECOVERY_MESSAGE_TYPE,
    content: [
      "[WORKGRAPH CURRENT-ATTEMPT RECOVERY]",
      `Attempt identity: ${identity.runId}/${identity.nodeId}.`,
      `Worker mode: ${mode}.`,
      mode === "implementation" ? `Current phase: ${phase}.` : "",
      "This bounded snapshot restores operational context that may have left the active transcript. The exact assigned objective remains authoritative; plan state is navigation only and later workgraph_plan tool results supersede it.",
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
  return entries.some((entry) => {
    if (entry.type !== "custom_message") return false;
    if (entry.customType === WORKER_OBJECTIVE_MESSAGE_TYPE) {
      const objective = objectiveIdentity(entry.details);
      return objective !== undefined && belongsToIdentity(objective, identity);
    }
    const details = contextDetails(entry.details, identity);
    return entry.customType === WORKER_RECOVERY_MESSAGE_TYPE && details?.kind === "recovery";
  });
}

export function hasActivePhase(
  entries: readonly SessionEntry[],
  identity: WorkerContextIdentity,
  phase: WorkerPhase,
): boolean {
  return entries.some((entry) => {
    if (entry.type !== "custom_message") return false;
    if (
      entry.customType !== WORKER_PHASE_MESSAGE_TYPE &&
      entry.customType !== WORKER_RECOVERY_MESSAGE_TYPE
    )
      return false;
    const details = contextDetails(entry.details, identity);
    return details?.phase === phase;
  });
}

export function hasActiveRecovery(
  entries: readonly SessionEntry[],
  identity: WorkerContextIdentity,
  phase: WorkerPhase,
): boolean {
  return entries.some((entry) => {
    if (entry.type !== "custom_message" || entry.customType !== WORKER_RECOVERY_MESSAGE_TYPE)
      return false;
    const details = contextDetails(entry.details, identity);
    return details?.kind === "recovery" && (details.phase === undefined || details.phase === phase);
  });
}

function objectiveText(objective: WorkerObjectiveRestore): string {
  if (objective.kind === "valid")
    return ["[WORKGRAPH CURRENT-ATTEMPT OBJECTIVE]", objective.content].join("\n");
  if (objective.kind === "malformed")
    return "[WORKGRAPH CURRENT-ATTEMPT OBJECTIVE]\nThe exact current-attempt objective snapshot was malformed and was ignored; do not guess its acceptance or constraints.";
  return "[WORKGRAPH CURRENT-ATTEMPT OBJECTIVE]\nNo exact current-attempt objective snapshot was found; do not infer acceptance, constraints, or authority from mutable operational state.";
}

function contextDetails(
  // SAFETY: Session custom-message details are untrusted input decoded before use.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Explicit Pi session decode boundary.
  data: unknown,
  identity: WorkerContextIdentity,
): WorkerContextDetails | undefined {
  if (!Value.Check(WorkerContextDetailsSchema, data)) return undefined;
  const details = Value.Decode(WorkerContextDetailsSchema, data);
  return belongsToIdentity(details, identity) ? details : undefined;
}

// SAFETY: Session custom-message details are untrusted input decoded before use.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Explicit Pi session decode boundary.
function objectiveIdentity(data: unknown): ParsedWorkerContextIdentity | undefined {
  return Value.Check(WorkerContextIdentitySchema, data)
    ? Value.Decode(WorkerContextIdentitySchema, data)
    : undefined;
}

function belongsToIdentity(
  data: ParsedWorkerContextIdentity,
  identity: WorkerContextIdentity,
): boolean {
  return data.runId === identity.runId && data.nodeId === identity.nodeId;
}

/** One concrete canonical worker assignment; every launch fact is built once here. */
export interface CanonicalWorkerAssignment {
  readonly mode: WorkerSessionMode;
  readonly role: "consultation" | "implement" | "research" | "review";
  readonly objective: string;
  readonly prompt: string;
  readonly environment: Record<string, string>;
}

export interface CanonicalAssignmentInput {
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

export function canonicalWorkerAssignment(
  input: CanonicalAssignmentInput,
): CanonicalWorkerAssignment {
  const capability = capabilityForKind(input.task.kind);
  const experiment = input.task.kind === "experiment";
  return {
    mode: workerMode(capability),
    role: workerRole(capability),
    objective: canonicalObjective(input),
    prompt: canonicalPrompt(input),
    environment: canonicalEnvironment(input, capability, experiment),
  };
}

/** Session mode for one canonical Task; the kind-to-fact policy lives only here. */
export function canonicalSessionMode(task: TaskContract): WorkerSessionMode {
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

function workerRole(capability: WorkerCapability): CanonicalWorkerAssignment["role"] {
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
  "On successful clean isolated output the checkout is compacted and this exact output branch is retained until explicit release.",
  "Experimental changes are not maintained product changes and must not be applied to the destination.",
];

function canonicalObjective(input: CanonicalAssignmentInput): string {
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
      "If a change is needed, create one clean maintained commit and report its exact commit for application. If the requirement already holds, verify it and report no_change with the inspected base revision and reason.",
    );
  if (task.kind === "review")
    lines.push(
      `Concern: ${task.concern}`,
      `Subject: ${JSON.stringify(reviewSubjectFor(input))}`,
      "Do not edit files.",
    );
  return lines.join("\n");
}

function canonicalPrompt(input: CanonicalAssignmentInput): string {
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

function canonicalEnvironment(
  input: CanonicalAssignmentInput,
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
  input: CanonicalAssignmentInput,
): ResolvedReviewInput | Extract<TaskContract, { kind: "review" }>["subject"] | undefined {
  if (input.reviewSubject !== undefined) return input.reviewSubject;
  return input.task.kind === "review" ? input.task.subject : undefined;
}
