export const RUN_STATE_VERSION = 1 as const;

export type RunPhase =
  | "discovery"
  | "awaiting_agreement"
  | "approved"
  | "executing"
  | "awaiting_assurance"
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
  | "superseded";

export type ReportKind = "discovery" | "implementation" | "assurance";
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

export interface EvidenceItem {
  label: string;
  observation: string;
  command?: string;
}

export interface Finding {
  severity: FindingSeverity;
  title: string;
  detail: string;
  envelopeImpact: EnvelopeImpact;
}

export interface WorkerReport {
  kind: ReportKind;
  status: ReportStatus;
  summary: string;
  evidence: EvidenceItem[];
  findings: Finding[];
  commit?: string;
  changedFiles?: string[];
}

export interface UsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface ChildOutcome {
  exitCode: number;
  sessionFile: string;
  report?: WorkerReport;
  stderr: string;
  usage: UsageSummary;
  models: string[];
  timedOut: boolean;
}

export interface InvestigationSpec {
  id: string;
  lens: string;
  objective: string;
}

export interface DiscoveryRecord extends InvestigationSpec {
  model: string;
  state: "running" | "completed" | "failed";
  sessionFile?: string;
  report?: WorkerReport;
  error?: string;
  usage?: UsageSummary;
}

export interface Agreement {
  outcome: string;
  nonGoals: string[];
  reuseDecision: string;
  structure: string;
  expectedScale: string;
  verificationBoundary: string;
  verificationCommands: string[];
  unresolvedDecisions: string[];
  approvedAt: string;
}

export interface WorkNodeSpec {
  id: string;
  objective: string;
  claimedPaths: string[];
  dependencies: string[];
  verificationCommands: string[];
  supersedes: string[];
  guideModel: string;
  executorModel: string;
  guideThinking: ThinkingLevel;
  executorThinking: ThinkingLevel;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface CommandEvidence {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface WorkNode extends WorkNodeSpec {
  state: NodeState;
  baseCommit?: string;
  branch?: string;
  worktreePath?: string;
  sessionFile?: string;
  processExitCode?: number;
  report?: WorkerReport;
  commit?: string;
  actualChangedFiles?: string[];
  verification?: CommandEvidence[];
  error?: string;
  usage?: UsageSummary;
  models?: string[];
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

export interface AssuranceRecord {
  model: string;
  state: "running" | "completed" | "failed";
  sessionFile?: string;
  report?: WorkerReport;
  error?: string;
  usage?: UsageSummary;
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
  phase: RunPhase;
  baseCommit: string;
  composedCommit: string;
  createdAt: string;
  updatedAt: string;
  agreement?: Agreement;
  discoveries: DiscoveryRecord[];
  nodes: WorkNode[];
  composition: CompositionRecord[];
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
