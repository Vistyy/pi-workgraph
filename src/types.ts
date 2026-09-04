export const RUN_STATE_VERSION = 6 as const;

export type RunLifecycle = "active" | "suspended" | "completed" | "abandoned" | "archived";
export type PlanStatus = "absent" | "proposed" | "approved" | "superseded";
export type PlanChangeKind = "initial" | "internal" | "authority";
export type ExecutionStatus = "idle" | "scheduled" | "running" | "draining" | "paused";
export type AttentionStatus = "clear" | "blocked" | "failed" | "decision_required";
export type VerificationControlStatus = "absent" | "running" | "passed" | "failed" | "inconclusive";
export type WorkerRuntimeMode = "herdr" | "headless_degraded";
export type WorkerObservationStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export type AttemptState = "queued" | "starting" | "running" | "settling" | "completed" | "failed" | "cancel_requested" | "cancelled";
export type WorkerStage = "queued" | "allocating" | "starting" | "executing" | "attention" | "reporting" | "verifying" | "composing" | "settled";
export type CoordinatorHandoffKind = "begin" | "adopt" | "resume" | "recovery";

export interface SessionIdentity {
  sessionId: string;
  sessionFile: string;
}

export interface RunCreator extends SessionIdentity {
  createdAt: string;
}

export interface CoordinatorBinding extends SessionIdentity {
  boundAt: string;
  runtimeIdentity?: CoordinatorRuntimeIdentity;
}

export interface CoordinatorHandoff {
  kind: CoordinatorHandoffKind;
  fromSessionId?: string;
  to: CoordinatorBinding;
  at: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type RunPhase =
  | "discovery"
  | "awaiting_agreement"
  | "approved"
  | "executing"
  | "awaiting_verification"
  | "awaiting_assurance"
  | "awaiting_judgment"
  | "assurance_inconclusive"
  | "revision_required"
  | "needs_decision"
  | "complete"
  | "failed";

export type NodeState =
  | "pending"
  | "running"
  | "completed"
  | "composed"
  | "escalated"
  | "failed"
  | "cancelled"
  | "superseded";

export type WorkerMode = "discovery" | "implementation" | "verification" | "assurance_review" | "assurance_synthesis";
export type ReportKind = WorkerMode;
export type ReportStatus = "completed" | "escalated" | "failed";
export type FindingSeverity = "info" | "warning" | "error" | "blocker";
export type EnvelopeImpact =
  | "none"
  | "outcome"
  | "non_goal"
  | "owner"
  | "public_interface"
  | "dependency"
  | "security"
  | "scale"
  | "reuse";

export type OutcomeKind = "answer" | "decision" | "product_change" | "operation";
export type EvidenceClass = "direct" | "inference" | "conflict" | "unknown";

export interface EvidenceItem {
  label: string;
  observation: string;
  class?: EvidenceClass;
  command?: string;
  artifact?: string;
}

export interface OutcomeContract {
  kind: OutcomeKind;
  statement: string;
  completionPredicate: string;
}

export type MilestoneStatus = "pending" | "completed" | "skipped";

export interface MilestoneRecord {
  id: string;
  description: string;
  status: MilestoneStatus;
  reason?: string;
  at?: string;
}

export interface TerminalOutcome {
  kind: Exclude<OutcomeKind, "product_change">;
  conclusion: string;
  evidence: EvidenceItem[];
  implementationClaim?: never;
  completedAt: string;
}

export interface Finding {
  severity: FindingSeverity;
  title: string;
  detail: string;
  envelopeImpact: EnvelopeImpact;
}

interface ReportBase<K extends ReportKind> {
  kind: K;
  status: ReportStatus;
  summary: string;
  evidence: EvidenceItem[];
}

export interface DiscoveryReport extends ReportBase<"discovery"> {
  findings: Finding[];
}

export interface ImplementationReport extends ReportBase<"implementation"> {
  findings: Finding[];
  commit?: string;
  changedFiles?: string[];
}

export interface VerificationReport extends ReportBase<"verification"> {
  verdict: "verified" | "failed" | "inconclusive";
  findings: Finding[];
}

export type AssuranceResponsibility = "behavior" | "structure" | "evidence";
export type ComplexityEffect = "reduces" | "neutral" | "adds";
export type FindingConfidence = "low" | "medium" | "high";

export interface AssuranceFinding {
  id: string;
  category: string;
  violatedInvariant: string;
  evidence: string[];
  reachableScenario: string;
  consequence: string;
  simplestResponse: string;
  complexityEffect: ComplexityEffect;
  confidence: FindingConfidence;
  envelopeImpact: EnvelopeImpact;
  ownerNodeId?: string;
}

export interface AssuranceReviewReport extends ReportBase<"assurance_review"> {
  responsibility: AssuranceResponsibility;
  recommendation: "approve" | "changes_required" | "inconclusive";
  findings: AssuranceFinding[];
}

export interface FindingDisposition {
  finding: AssuranceFinding;
  disposition: "accept" | "optional" | "dismiss";
  reason: string;
}

export interface AssuranceSynthesisReport extends ReportBase<"assurance_synthesis"> {
  verdict: "approve" | "revision_required" | "needs_decision" | "inconclusive";
  dispositions: FindingDisposition[];
}

export type WorkerReport =
  | DiscoveryReport
  | ImplementationReport
  | VerificationReport
  | AssuranceReviewReport
  | AssuranceSynthesisReport;

export interface UsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface ChildCapabilityRecord {
  id: "web_access" | "codex_remote_compaction";
  packageSource: string;
  resourceIdentity: string;
  version?: string;
  tools: string[];
  available: boolean;
  diagnostic?: string;
}

export type ChildResultKind = "typed" | "untyped" | "invalid" | "absent";
export type ResultReviewDisposition = "accept" | "retry" | "reject";

export interface ChildResultReview {
  id: string;
  attemptId: string;
  mode: WorkerMode;
  disposition: ResultReviewDisposition;
  originalResultKind: Exclude<ChildResultKind, "typed">;
  originalTerminalText?: string;
  summary: string;
  evidence: EvidenceItem[];
  report?: WorkerReport;
  reviewedAt: string;
}

export interface ChildOutcome {
  exitCode: number;
  sessionFile: string;
  resultKind?: ChildResultKind;
  report?: WorkerReport;
  terminalText?: string;
  stderr: string;
  usage: UsageSummary;
  models: string[];
  timedOut: boolean;
  capabilities?: ChildCapabilityRecord[];
}

export type DiscoveryTopology = "partition" | "replicate" | "evidence";

export interface InvestigationSpec {
  id: string;
  lens: string;
  objective: string;
}

export interface DiscoveryAssignment extends InvestigationSpec {
  model: string;
  thinking: ThinkingLevel;
  unavailableReason?: string;
  supersedes?: string[];
}

export interface DiscoveryRecord extends DiscoveryAssignment {
  topology: DiscoveryTopology;
  attemptId?: string;
  resultId?: string;
  resultKind?: ChildResultKind;
  terminalText?: string;
  synthesisOf?: string[];
  state: "running" | "completed" | "failed" | "review_required" | "timed_out" | "cancelled" | "unavailable" | "superseded";
  supersededBy?: string;
  sessionFile?: string;
  report?: DiscoveryReport;
  error?: string;
  usage?: UsageSummary;
  capabilities?: ChildCapabilityRecord[];
}

export type VerificationMethod = "commands" | "independent";

export interface AgreementDraft {
  outcome: string;
  nonGoals: string[];
  reuseDecision: string;
  structure: string;
  expectedScale: string;
  verificationBoundary: string;
  verificationCommands: string[];
  verificationMethod: VerificationMethod;
  verificationProcedure: string;
  requiredEvidence: string[];
  unresolvedDecisions: string[];
}

export interface Agreement extends AgreementDraft {
  approvedAt: string;
}

export interface WorkerBrief {
  goal: string;
  context: string[];
  acceptance: string[];
  timeboxMinutes: number;
  forbidden: string[];
  report: string;
}

export interface WorkNodeSpec {
  id: string;
  brief: WorkerBrief;
  claimedPaths: string[];
  dependencies: string[];
  priority?: number;
  verificationCommands: string[];
  supersedes: string[];
  continuationOf?: string;
  guideModel: string;
  executorModel: string;
  guideThinking: ThinkingLevel;
  executorThinking: ThinkingLevel;
}

export interface CommandEvidence {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface WorkNode extends WorkNodeSpec {
  state: NodeState;
  planVersion?: number;
  activeAttemptId?: string;
  resultKind?: ChildResultKind;
  terminalText?: string;
  baseCommit?: string;
  branch?: string;
  worktreePath?: string;
  sessionFile?: string;
  processExitCode?: number;
  report?: ImplementationReport;
  commit?: string;
  actualChangedFiles?: string[];
  verification?: CommandEvidence[];
  error?: string;
  usage?: UsageSummary;
  models?: string[];
  capabilities?: ChildCapabilityRecord[];
  startedAt?: string;
  settledAt?: string;
  composedAt?: string;
  supersededBy?: string;
}

export interface CompositionRecord {
  nodeId: string;
  sourceCommit: string;
  beforeCommit: string;
  afterCommit?: string;
  status: "composed" | "conflict" | "failed";
  error?: string;
  at: string;
}

export interface ProductVerificationRecord {
  revision: string;
  attemptId?: string;
  resultKind?: ChildResultKind;
  terminalText?: string;
  method: VerificationMethod;
  state: "running" | "completed" | "failed" | "inconclusive";
  model?: string;
  thinking?: ThinkingLevel;
  sessionFile?: string;
  report?: VerificationReport;
  commands: CommandEvidence[];
  error?: string;
  usage?: UsageSummary;
  capabilities?: ChildCapabilityRecord[];
}

export interface AssuranceReviewRecord {
  responsibility: AssuranceResponsibility;
  attemptId?: string;
  resultKind?: ChildResultKind;
  terminalText?: string;
  model: string;
  thinking: ThinkingLevel;
  state: "running" | "completed" | "failed" | "timed_out" | "unavailable";
  sessionFile?: string;
  report?: AssuranceReviewReport;
  error?: string;
  usage?: UsageSummary;
}

export interface AssuranceSynthesisRecord {
  model: string;
  attemptId?: string;
  resultKind?: ChildResultKind;
  terminalText?: string;
  thinking: ThinkingLevel;
  state: "running" | "completed" | "failed" | "timed_out";
  sessionFile?: string;
  report?: AssuranceSynthesisReport;
  error?: string;
  usage?: UsageSummary;
}

export interface AssuranceJudgment {
  judgments: Array<{
    findingId: string;
    disposition: "accept" | "dismiss";
    reason: string;
  }>;
  acceptedFindings: AssuranceFinding[];
  at: string;
}

export interface AssuranceRecord {
  revision: string;
  state: "running" | "completed" | "inconclusive";
  synthesisModel?: string;
  synthesisThinking?: ThinkingLevel;
  stableEntryId?: string | null;
  reviews: AssuranceReviewRecord[];
  synthesis?: AssuranceSynthesisRecord;
  finalJudgment?: AssuranceJudgment;
}

export interface HumanDecision {
  kind: "agreement" | "envelope_change";
  prompt: string;
  accepted: boolean;
  at: string;
}

export interface Transition {
  sequence: number;
  at: string;
  from: RunPhase;
  to: RunPhase;
  reason: string;
}

export interface PlanRecord {
  version: number;
  status: Exclude<PlanStatus, "absent">;
  changeKind: PlanChangeKind;
  agreement: AgreementDraft;
  summary: string;
  proposedAt: string;
  approvedAt?: string;
  decisionText?: string;
}

export interface CoordinatorRuntimeIdentity {
  workspaceId: string;
  tabId: string;
  paneId: string;
  terminalId: string;
  agentName?: string;
  sessionFile: string;
  cwd: string;
}

export interface WorkerIdentity extends CoordinatorRuntimeIdentity {
  agentName: string;
}

export interface WorkerResourceIdentity {
  workspaceId: string;
  tabId: string;
  paneId: string;
  terminalId: string;
  agentName: string;
  cwd: string;
}

export type WorkerSubmissionState = "pending" | "native_ready" | "uncertain" | "submitted" | "agent_started";

export interface WorkerSubmissionRecord {
  id: string;
  prompt: string;
  state: WorkerSubmissionState;
  nativeReadyAt?: string;
  submittedAt?: string;
  agentStartedAt?: string;
  detail?: string;
}

export type CoordinatorBoundaryKind = "result" | "agreement" | "settle" | "verification" | "assurance" | "judgment" | "attention";

export interface CoordinatorWakeRecord {
  id: string;
  boundaryRevision: string;
  kind: CoordinatorBoundaryKind;
  phase: RunPhase;
  composedCommit: string;
  planVersion?: number;
  resultId?: string;
  resultKind?: ChildResultKind;
  state: "claimed" | "delivered" | "failed";
  requestedAt: string;
  deliveryAttempts?: number;
  deliveryOwner?: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
  acknowledgment?: string;
  error?: string;
}

export type CleanupState = "pending" | "completed" | "blocked";

interface CleanupRecordBase {
  id: string;
  attemptId: string;
  state: CleanupState;
  requestedAt: string;
  inspectedAt?: string;
  completedAt?: string;
  detail?: string;
  error?: string;
}

export interface GitWorktreeCleanupRecord extends CleanupRecordBase {
  kind: "git_worktree";
  path: string;
  branch: string;
  expectedHead: string;
}

export interface HerdrWorkerCleanupRecord extends CleanupRecordBase {
  kind: "herdr_worker";
  identity: WorkerIdentity;
}

export type ResourceCleanupRecord = GitWorktreeCleanupRecord | HerdrWorkerCleanupRecord;

export interface WorkAttempt {
  id: string;
  nodeId: string;
  mode?: WorkerMode;
  planVersion: number;
  state: AttemptState;
  stage: WorkerStage;
  runtimeMode: WorkerRuntimeMode;
  createdAt: string;
  startedAt?: string;
  settledAt?: string;
  lastActivityAt: string;
  heartbeatAt?: string;
  interruptRequestedAt?: string;
  observedStatus?: WorkerObservationStatus;
  worktreePath?: string;
  branch?: string;
  baseCommit?: string;
  parentSessionFile?: string;
  stableEntryId?: string | null;
  objective?: string;
  model?: string;
  thinking?: ThinkingLevel;
  executorModel?: string;
  executorThinking?: ThinkingLevel;
  responsibility?: AssuranceResponsibility;
  dependencies?: string[];
  sessionFile?: string;
  agentName?: string;
  worker?: WorkerIdentity;
  resource?: WorkerResourceIdentity;
  submission?: WorkerSubmissionRecord;
  resultKind?: ChildResultKind;
  workerHistory?: WorkerIdentity[];
  attention?: string;
  error?: string;
}

export interface UnsupportedControlRecord {
  id: string;
  action: "steer";
  attemptId: string;
  instruction: string;
  reason: string;
  at: string;
}

export interface WorkgraphControl {
  planStatus: PlanStatus;
  currentPlanVersion?: number;
  executionStatus: ExecutionStatus;
  attentionStatus: AttentionStatus;
  verificationStatus: VerificationControlStatus;
  maxConcurrency: number;
  pauseMode?: "drain" | "immediate";
  pauseReason?: string;
  updatedAt: string;
}

export interface WorkgraphRun {
  version: typeof RUN_STATE_VERSION;
  revision: number;
  runId: string;
  request: string;
  projectRoot: string;
  gitCommonDir: string;
  statePath: string;
  parentSessionId: string;
  parentSessionFile: string;
  creator: RunCreator;
  coordinator: CoordinatorBinding;
  handoffs: CoordinatorHandoff[];
  lifecycle: RunLifecycle;
  lifecycleUpdatedAt: string;
  lifecycleReason?: string;
  phase: RunPhase;
  baseCommit: string;
  composedCommit: string;
  createdAt: string;
  updatedAt: string;
  outcome: OutcomeContract;
  control: WorkgraphControl;
  plans: PlanRecord[];
  attempts: WorkAttempt[];
  resultReviews?: ChildResultReview[];
  cleanup?: ResourceCleanupRecord[];
  coordinatorWakeups?: CoordinatorWakeRecord[];
  unsupportedControls?: UnsupportedControlRecord[];
  milestones: MilestoneRecord[];
  terminalOutcome?: TerminalOutcome;
  agreement?: Agreement;
  agreementProposal?: AgreementDraft;
  agreementProposalText?: string;
  discoveries: DiscoveryRecord[];
  nodes: WorkNode[];
  composition: CompositionRecord[];
  productVerification?: ProductVerificationRecord;
  assurance?: AssuranceRecord;
  humanDecisions: HumanDecision[];
  transitions: Transition[];
  globalVerification: CommandEvidence[];
  error?: string;
}

export interface RunPointer {
  runId: string;
  statePath: string;
}
