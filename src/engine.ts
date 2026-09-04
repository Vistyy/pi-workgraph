import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { GitRepository, type WorktreePlacement } from "./git.js";
import { herdrAgentName } from "./herdr.js";
import { mapConcurrent, readTerminalText, readWorkgraphReport, type ChildRequest } from "./pi-process.js";
import { addNodes, allNodesComposed, blockedPendingNodes, readyWave, transitionNode } from "./scheduler.js";
import { RunStateStore, type NewRunInput } from "./state-store.js";
import { WorkgraphRegistry, type Lease, type LeaseOwner } from "./registry.js";
import type {
  Agreement,
  AssuranceFinding,
  EvidenceItem,
  OutcomeKind,
  AssuranceRecord,
  AssuranceResponsibility,
  AssuranceReviewRecord,
  AssuranceReviewReport,
  AssuranceSynthesisReport,
  ChildOutcome,
  ChildResultKind,
  ChildResultReview,
  DiscoveryAssignment,
  DiscoveryRecord,
  DiscoveryTopology,
  HumanDecision,
  ProductVerificationRecord,
  PlanChangeKind,
  RunPhase,
  ThinkingLevel,
  VerificationReport,
  WorkNode,
  WorkNodeSpec,
  WorkgraphRun,
  WorkAttempt,
  WorkerMode,
  WorkerIdentity,
  WorkerReport,
  ImplementationReport,
} from "./types.js";

export type ChildRunner = (request: ChildRequest) => Promise<ChildOutcome>;

export interface EngineDependencies {
  runChild?: ChildRunner;
  repository?: GitRepository;
  registry?: WorkgraphRegistry;
}

export interface DiscoveryInput {
  topology: DiscoveryTopology;
  assignments: DiscoveryAssignment[];
  stableEntryId?: string | null;
  signal?: AbortSignal;
}

export interface AsyncDiscoveryInput {
  topology: DiscoveryTopology;
  assignments: DiscoveryAssignment[];
  stableEntryId?: string | null;
}

export interface AsyncDiscoverySynthesisInput extends ModelAssignment {
  id: string;
  sourceIds: string[];
  stableEntryId?: string | null;
}

export interface AsyncVerificationInput extends ModelAssignment {
  stableEntryId?: string | null;
}

export interface AsyncAssuranceInput {
  reviewers: Array<ModelAssignment & { responsibility: AssuranceResponsibility }>;
  synthesis: ModelAssignment;
  stableEntryId?: string | null;
}

export interface DiscoverySynthesisInput extends ModelAssignment {
  id: string;
  sourceIds: string[];
  stableEntryId?: string | null;
  signal?: AbortSignal;
}

export interface AgreementInput extends Omit<Agreement, "approvedAt"> {}

export interface ExecuteInput {
  nodes: WorkNodeSpec[];
  maxConcurrency?: number;
  stableEntryId?: string | null;
  signal?: AbortSignal;
}

export interface ScheduleInput {
  nodes: WorkNodeSpec[];
  maxConcurrency?: number;
}

export type ControlInput =
  | { action: "pause"; mode?: "drain" | "immediate"; reason: string }
  | { action: "resume"; reason: string }
  | { action: "cancel"; reason: string; nodeIds?: string[] }
  | { action: "reprioritize"; priorities: Array<{ nodeId: string; priority: number }>; reason: string };

export interface ModelAssignment {
  model: string;
  thinking: ThinkingLevel;
  unavailableReason?: string;
}

export interface VerificationInput extends ModelAssignment {
  stableEntryId?: string | null;
  signal?: AbortSignal;
}

export interface AssuranceInput {
  reviewers: Array<ModelAssignment & { responsibility: AssuranceResponsibility }>;
  synthesis: ModelAssignment;
  stableEntryId?: string | null;
  signal?: AbortSignal;
}

export interface ChildResultReviewInput {
  attemptId: string;
  disposition: "accept" | "retry" | "reject";
  summary: string;
  evidence: EvidenceItem[];
  report?: WorkgraphRun["discoveries"][number]["report"] | ImplementationReport | VerificationReport | AssuranceReviewReport | AssuranceSynthesisReport;
}

export interface AssuranceJudgmentInput {
  judgments: Array<{
    findingId: string;
    disposition: "accept" | "dismiss";
    reason: string;
  }>;
}

export class WorkgraphEngine {
  private readonly runChild: ChildRunner;
  private repositoryPromise: Promise<GitRepository>;
  readonly registry: WorkgraphRegistry;
  private lease: Lease | undefined;

  constructor(readonly store: RunStateStore, dependencies: EngineDependencies = {}) {
    this.runChild = dependencies.runChild ?? legacyChildUnavailable;
    this.registry = dependencies.registry ?? new WorkgraphRegistry();
    this.repositoryPromise = dependencies.repository
      ? Promise.resolve(dependencies.repository)
      : this.store.load().then((run) => new GitRepository(run.projectRoot, run.gitCommonDir));
  }

  static async begin(input: NewRunInput, dependencies: EngineDependencies = {}): Promise<{ engine: WorkgraphEngine; run: WorkgraphRun }> {
    if (!input.request.trim()) throw new Error("A Workgraph request is required.");
    if (!input.outcome.statement.trim()) throw new Error("An explicit outcome statement is required.");
    if (!input.outcome.completionPredicate.trim()) throw new Error("A checkable completion predicate is required.");
    if (input.milestones?.some((milestone) => !milestone.description.trim())) throw new Error("Milestone descriptions are required.");
    const ids = new Set<string>();
    for (const milestone of input.milestones ?? []) {
      if (!/^[a-z][a-z0-9_-]{0,47}$/.test(milestone.id) || ids.has(milestone.id)) throw new Error(`Invalid or duplicate milestone id: ${milestone.id}`);
      ids.add(milestone.id);
    }
    const created = await RunStateStore.create(input);
    const engine = new WorkgraphEngine(created.store, dependencies);
    engine.registry.indexRun(created.run);
    engine.lease = engine.registry.acquire(created.run.runId, { sessionId: input.parentSessionId, sessionFile: input.parentSessionFile });
    return { engine, run: created.run };
  }

  static open(statePath: string, dependencies: EngineDependencies = {}): WorkgraphEngine {
    return new WorkgraphEngine(new RunStateStore(statePath), dependencies);
  }

  load(): Promise<WorkgraphRun> {
    return this.store.load();
  }

  repository(): Promise<GitRepository> {
    return this.repositoryPromise;
  }

  heartbeatLease(): void {
    if (!this.lease) throw new Error("This coordinator does not hold a Workgraph lease.");
    this.lease = this.registry.renew(this.lease);
  }

  async adopt(sessionId: string, sessionFile: string, liveness: "alive" | "dead" | "unknown" = "unknown", runtimeIdentity?: WorkerIdentity): Promise<WorkgraphRun> {
    if (!sessionId.trim() || !sessionFile.trim()) throw new Error("Adoption requires a Pi session identity.");
    const run = await this.load();
    if (run.lifecycle === "abandoned" || run.lifecycle === "archived") throw new Error(`Workgraph ${run.runId} is ${run.lifecycle}.`);
    const owner: LeaseOwner = { sessionId, sessionFile };
    this.lease = this.registry.acquire(run.runId, owner, new Date(), liveness);
    const adopted = await this.store.update((draft) => {
      const previous = draft.coordinator;
      draft.coordinator = { sessionId, sessionFile, boundAt: new Date().toISOString(), ...(runtimeIdentity ? { runtimeIdentity } : {}) };
      draft.handoffs.push({ kind: previous.sessionId === sessionId ? "resume" : "adopt", ...(previous.sessionId !== sessionId ? { fromSessionId: previous.sessionId } : {}), to: draft.coordinator, at: draft.coordinator.boundAt });
      if (draft.lifecycle === "suspended") {
        draft.lifecycle = "active";
        draft.lifecycleReason = "Adopted by a live coordinator.";
        draft.lifecycleUpdatedAt = draft.coordinator.boundAt;
      }
    });
    this.registry.indexRun(adopted);
    this.registry.bind(adopted.runId, owner);
    return adopted;
  }

  async setLifecycle(lifecycle: WorkgraphRun["lifecycle"], reason: string): Promise<WorkgraphRun> {
    if (!reason.trim()) throw new Error("A lifecycle transition requires a reason.");
    const run = await this.load();
    if (run.lifecycle === lifecycle) return run;
    const updated = await this.store.update((draft) => {
      if ((lifecycle === "completed" || lifecycle === "abandoned") && draft.attempts.some((attempt) => ["starting", "running", "settling", "cancel_requested"].includes(attempt.state))) {
        throw new Error(`Cannot settle lifecycle while a worker attempt is active.`);
      }
      const allowed: Record<WorkgraphRun["lifecycle"], readonly WorkgraphRun["lifecycle"][]> = {
        active: ["suspended", "completed", "abandoned"], suspended: ["active", "completed", "abandoned"], completed: ["archived"], abandoned: ["archived"], archived: [],
      };
      if (!allowed[draft.lifecycle].includes(lifecycle)) throw new Error(`Invalid lifecycle transition ${draft.lifecycle} -> ${lifecycle}.`);
      draft.lifecycle = lifecycle;
      draft.lifecycleReason = reason.trim();
      draft.lifecycleUpdatedAt = new Date().toISOString();
      if (lifecycle === "completed" || lifecycle === "abandoned") addCleanupIntents(draft);
    });
    try {
      this.registry.transitionLifecycle(updated.runId, lifecycle, reason);
    } catch {
      // The durable JSON run is semantic authority; repair the SQLite projection after a stale index race.
      this.registry.indexRun(updated);
    }
    this.registry.indexRun(updated);
    return updated;
  }

  releaseLease(): void {
    if (this.lease) this.registry.release(this.lease);
    this.lease = undefined;
  }

  async recordMilestone(milestoneId: string, status: "completed" | "skipped", reason?: string): Promise<WorkgraphRun> {
    if (!milestoneId.trim()) throw new Error("A milestone id is required.");
    if (status === "skipped" && !reason?.trim()) throw new Error("A skipped milestone requires a reason.");
    return this.store.update((run) => {
      const milestone = run.milestones.find((candidate) => candidate.id === milestoneId);
      if (!milestone) throw new Error(`Unknown milestone ${milestoneId}.`);
      milestone.status = status;
      if (reason?.trim()) milestone.reason = reason.trim();
      else delete milestone.reason;
      milestone.at = new Date().toISOString();
    });
  }

  async completeNonChange(kind: Exclude<OutcomeKind, "product_change">, conclusion: string, evidence: EvidenceItem[]): Promise<WorkgraphRun> {
    const run = await this.load();
    requirePhase(run, ["discovery", "awaiting_agreement", "approved"]);
    if (run.outcome.kind !== kind) throw new Error(`This run is for ${run.outcome.kind}, not ${kind}.`);
    if (!conclusion.trim()) throw new Error("A terminal conclusion is required.");
    validateEvidence(evidence);
    if (evidence.some((item) => item.class === "unknown" || item.class === "conflict")) throw new Error("Non-change completion requires conflicts and unknowns to be resolved or explicitly addressed.");
    return this.store.update((draft) => {
      draft.terminalOutcome = { kind, conclusion: conclusion.trim(), evidence: evidence.map((item) => ({ ...item, class: item.class ?? "direct" })), completedAt: new Date().toISOString() };
      setPhase(draft, "complete", `The ${kind} outcome is complete with typed evidence and no implementation claim.`);
    });
  }

  async queueDiscovery(input: AsyncDiscoveryInput): Promise<WorkgraphRun> {
    const run = await this.load();
    requirePhase(run, ["discovery", "awaiting_agreement"]);
    validateDiscoveryAssignments(run, input.assignments);
    const now = new Date().toISOString();
    return this.store.update((draft) => {
      const replacements = new Map<string, string>();
      for (const assignment of input.assignments) {
        for (const replacedId of assignment.supersedes ?? []) replacements.set(replacedId, assignment.id);
      }
      for (const [replacedId, replacementId] of replacements) {
        const replaced = draft.discoveries.find((record) => record.id === replacedId);
        if (!replaced) throw new Error(`Unknown discovery lane ${replacedId}.`);
        replaced.state = "superseded";
        replaced.supersededBy = replacementId;
      }
      for (const assignment of input.assignments) {
        const record: DiscoveryRecord = {
          ...assignment,
          topology: input.topology,
          state: assignment.unavailableReason ? "unavailable" : "running",
          ...(assignment.unavailableReason ? { error: assignment.unavailableReason } : {}),
        };
        draft.discoveries.push(record);
        if (assignment.unavailableReason) continue;
        const attemptId = randomUUID();
        record.attemptId = attemptId;
        draft.attempts.push(observerAttempt(draft, {
          id: attemptId,
          nodeId: assignment.id,
          mode: "discovery",
          model: assignment.model,
          thinking: assignment.thinking,
          objective: discoveryObjective(draft, input.topology, assignment),
          stableEntryId: input.stableEntryId,
          planVersion: draft.control.currentPlanVersion ?? 0,
        }));
      }
      draft.control.executionStatus = "scheduled";
      draft.control.updatedAt = now;
    });
  }

  async queueDiscoverySynthesis(input: AsyncDiscoverySynthesisInput): Promise<WorkgraphRun> {
    const run = await this.load();
    requirePhase(run, ["awaiting_agreement"]);
    validateModel(input.model, "Discovery synthesizer");
    const sourceIds = [...new Set(input.sourceIds)];
    if (sourceIds.length < 2 || sourceIds.length > 5) throw new Error("Discovery synthesis requires between two and five distinct source reports.");
    const sources = sourceIds.map((id) => {
      const source = run.discoveries.find((record) => record.id === id);
      if (!source) throw new Error(`Unknown discovery synthesis source: ${id}`);
      if (source.state === "running" || source.state === "superseded") throw new Error(`Discovery synthesis source ${id} is not settled.`);
      return source;
    });
    if (!sources.some((source) => source.state === "completed" && source.report)) throw new Error("Discovery synthesis requires at least one completed source report.");
    return this.store.update((draft) => {
      if (draft.discoveries.some((record) => record.id === input.id)) throw new Error(`Duplicate investigation id: ${input.id}`);
      const record: DiscoveryRecord = {
        id: input.id,
        lens: "Independent synthesis",
        objective: `Reconcile discovery reports: ${sourceIds.join(", ")}`,
        model: input.model,
        thinking: input.thinking,
        topology: sources[0]!.topology,
        synthesisOf: sourceIds,
        state: input.unavailableReason ? "unavailable" : "running",
        ...(input.unavailableReason ? { error: input.unavailableReason } : {}),
      };
      draft.discoveries.push(record);
      if (!input.unavailableReason) {
        const attemptId = randomUUID();
        record.attemptId = attemptId;
        draft.attempts.push(observerAttempt(draft, {
          id: attemptId,
          nodeId: input.id,
          mode: "discovery",
          model: input.model,
          thinking: input.thinking,
          objective: discoverySynthesisObjective(draft, sources),
          stableEntryId: input.stableEntryId,
          planVersion: draft.control.currentPlanVersion ?? 0,
        }));
        draft.control.executionStatus = "scheduled";
      }
      draft.control.updatedAt = new Date().toISOString();
    });
  }

  async queueVerification(input: AsyncVerificationInput): Promise<WorkgraphRun> {
    const run = await this.load();
    requirePhase(run, ["awaiting_verification"]);
    if (!run.agreement || run.agreement.verificationMethod !== "independent") throw new Error("Independent product verification is not required by the approved envelope.");
    const repositoryError = await this.composedRepositoryError(run);
    if (repositoryError) return this.store.update((draft) => { if (draft.productVerification) draft.productVerification.error = repositoryError; setPhase(draft, "needs_decision", "Product verification found repository state outside Workgraph composition."); });
    validateModel(input.model, "Product verifier");
    return this.store.update((draft) => {
      const verification: ProductVerificationRecord = { revision: draft.composedCommit, method: "independent", state: "running", model: input.model, thinking: input.thinking, commands: [...draft.globalVerification] };
      const attemptId = randomUUID();
      verification.attemptId = attemptId;
      draft.productVerification = verification;
      draft.attempts.push(observerAttempt(draft, {
        id: attemptId,
        nodeId: "product-verification",
        mode: "verification",
        model: input.model,
        thinking: input.thinking,
        objective: verificationObjective(draft),
        stableEntryId: input.stableEntryId,
        planVersion: draft.control.currentPlanVersion ?? 0,
      }));
      draft.control.executionStatus = "scheduled";
      draft.control.verificationStatus = "running";
      draft.control.updatedAt = new Date().toISOString();
    });
  }

  async queueAssurance(input: AsyncAssuranceInput): Promise<WorkgraphRun> {
    const run = await this.load();
    requirePhase(run, ["awaiting_assurance", "assurance_inconclusive"]);
    if (run.outcome.kind !== "product_change") throw new Error("Assurance is only available for product-change outcomes.");
    if (!run.agreement) throw new Error("An approved implementation envelope is required.");
    requireCurrentVerification(run);
    const repositoryError = await this.composedRepositoryError(run);
    if (repositoryError) return this.store.update((draft) => { draft.error = repositoryError; setPhase(draft, "needs_decision", "Assurance found repository state outside Workgraph composition."); });
    validateAssuranceAssignments(input);
    const previous = run.phase === "assurance_inconclusive" && run.assurance?.revision === run.composedCommit ? run.assurance : undefined;
    return this.store.update((draft) => {
      const assurance: AssuranceRecord = { revision: draft.composedCommit, state: "running", synthesisModel: input.synthesis.model, synthesisThinking: input.synthesis.thinking, ...(input.stableEntryId !== undefined ? { stableEntryId: input.stableEntryId } : {}), reviews: input.reviewers.map((reviewer) => {
        const settled = previous?.reviews.find((candidate) => candidate.responsibility === reviewer.responsibility);
        if (settled?.state === "completed" && settled.report?.status === "completed" && settled.report.recommendation !== "inconclusive") return settled;
        const review: AssuranceReviewRecord = { responsibility: reviewer.responsibility, model: reviewer.model, thinking: reviewer.thinking, state: reviewer.unavailableReason ? "unavailable" : "running" };
        if (reviewer.unavailableReason) review.error = reviewer.unavailableReason;
        if (!reviewer.unavailableReason) {
          const attemptId = randomUUID();
          review.attemptId = attemptId;
          draft.attempts.push(observerAttempt(draft, { id: attemptId, nodeId: `assurance-${reviewer.responsibility}`, mode: "assurance_review", responsibility: reviewer.responsibility, model: reviewer.model, thinking: reviewer.thinking, objective: assuranceReviewObjective(draft, reviewer.responsibility), stableEntryId: input.stableEntryId, planVersion: draft.control.currentPlanVersion ?? 0 }));
        }
        return review;
      }) };
      draft.assurance = assurance;
      draft.control.executionStatus = "scheduled";
      draft.control.updatedAt = new Date().toISOString();
    });
  }

  async discover(input: DiscoveryInput): Promise<WorkgraphRun> {
    const run = await this.load();
    requirePhase(run, ["discovery", "awaiting_agreement"]);
    if (input.assignments.length < 1 || input.assignments.length > 5) {
      throw new Error("Discovery requires between one and five bounded assignments.");
    }
    const ids = new Set(run.discoveries.map((record) => record.id));
    const replacements = new Map<string, string>();
    for (const assignment of input.assignments) {
      if (!/^[a-z][a-z0-9_-]{0,47}$/.test(assignment.id)) throw new Error(`Invalid investigation id: ${assignment.id}`);
      if (ids.has(assignment.id)) throw new Error(`Duplicate investigation id: ${assignment.id}`);
      ids.add(assignment.id);
      if (!assignment.lens.trim() || !assignment.objective.trim()) throw new Error(`Investigation ${assignment.id} is incomplete.`);
      validateModel(assignment.model, `Investigation ${assignment.id}`);
      for (const replacedId of assignment.supersedes ?? []) {
        const replaced = run.discoveries.find((record) => record.id === replacedId);
        if (!replaced) throw new Error(`Investigation ${assignment.id} cannot supersede unknown lane ${replacedId}.`);
        if (replaced.state === "completed" || replaced.state === "running" || replaced.state === "superseded") {
          throw new Error(`Investigation ${assignment.id} cannot supersede lane ${replacedId} in ${replaced.state}.`);
        }
        if (replacements.has(replacedId)) throw new Error(`Discovery lane ${replacedId} has more than one replacement.`);
        replacements.set(replacedId, assignment.id);
      }
    }

    await this.store.update((draft) => {
      for (const [replacedId, replacementId] of replacements) {
        const replaced = draft.discoveries.find((record) => record.id === replacedId);
        if (!replaced) throw new Error(`Unknown discovery lane ${replacedId}.`);
        replaced.state = "superseded";
        replaced.supersededBy = replacementId;
      }
      draft.discoveries.push(...input.assignments.map<DiscoveryRecord>((assignment) => ({
        ...assignment,
        topology: input.topology,
        state: assignment.unavailableReason ? "unavailable" : "running",
        ...(assignment.unavailableReason ? { error: assignment.unavailableReason } : {}),
      })));
    });

    const runnableAssignments = input.assignments.filter((assignment) => !assignment.unavailableReason);
    const sessionDir = join(dirname(run.statePath), "sessions", "discovery");
    await mapConcurrent(runnableAssignments, Math.max(1, Math.min(4, runnableAssignments.length)), async (assignment) => {
      let outcome: ChildOutcome;
      try {
        outcome = await this.runChild({
          parentSessionFile: run.parentSessionFile,
          targetCwd: run.projectRoot,
          sessionDir,
          objective: discoveryObjective(run, input.topology, assignment),
          mode: "discovery",
          guideModel: assignment.model,
          guideThinking: assignment.thinking,
          runId: run.runId,
          nodeId: assignment.id,
          ...(input.stableEntryId !== undefined ? { stableEntryId: input.stableEntryId } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (error) {
        await this.updateDiscovery(assignment.id, (record) => {
          record.state = input.signal?.aborted ? "cancelled" : "failed";
          record.error = errorMessage(error);
        });
        return;
      }
      await this.updateDiscovery(assignment.id, (record) => {
        record.sessionFile = outcome.sessionFile;
        record.usage = outcome.usage;
        if (outcome.resultKind) record.resultKind = outcome.resultKind;
        if (outcome.terminalText) record.terminalText = outcome.terminalText;
        if (outcome.capabilities) record.capabilities = outcome.capabilities;
        if (outcome.exitCode === 0 && outcome.report?.kind === "discovery" && outcome.report.status === "completed") {
          record.state = "completed";
          record.report = outcome.report;
          return;
        }
        if (outcome.report?.kind === "discovery") record.report = outcome.report;
        record.state = outcome.timedOut
          ? "timed_out"
          : input.signal?.aborted
            ? "cancelled"
            : outcome.resultKind === "untyped"
              ? "review_required"
              : unavailableModelFailure(outcome)
                ? "unavailable"
                : "failed";
        record.error = childFailure(outcome);
      });
    });

    const settled = await this.load();
    const activeLanes = settled.discoveries.filter((record) => record.state !== "superseded");
    const ready = activeLanes.length > 0 && activeLanes.every((record) => record.state === "completed" && record.report?.kind === "discovery" && record.report.status === "completed");
    return this.changePhase(ready ? "awaiting_agreement" : "discovery", ready
      ? `${input.topology} discovery completed with typed reports for every active lane.`
      : `${input.topology} discovery remains open because every active lane requires a completed typed report or explicit disposition.`);
  }

  async synthesizeDiscovery(input: DiscoverySynthesisInput): Promise<WorkgraphRun> {
    const run = await this.load();
    requirePhase(run, ["awaiting_agreement"]);
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(input.id)) throw new Error(`Invalid synthesis id: ${input.id}`);
    if (run.discoveries.some((record) => record.id === input.id)) throw new Error(`Duplicate investigation id: ${input.id}`);
    const sourceIds = [...new Set(input.sourceIds)];
    if (sourceIds.length < 2 || sourceIds.length > 5) throw new Error("Discovery synthesis requires between two and five distinct source reports.");
    const sources = sourceIds.map((id) => {
      const source = run.discoveries.find((record) => record.id === id);
      if (!source) throw new Error(`Unknown discovery synthesis source: ${id}`);
      if (source.state === "running" || source.state === "superseded") throw new Error(`Discovery synthesis source ${id} is not a settled active lane.`);
      return source;
    });
    if (!sources.some((source) => source.state === "completed" && source.report)) {
      throw new Error("Discovery synthesis requires at least one completed source report.");
    }
    validateModel(input.model, "Discovery synthesizer");
    const record: DiscoveryRecord = {
      id: input.id,
      lens: "Independent synthesis",
      objective: `Reconcile discovery reports: ${sourceIds.join(", ")}`,
      model: input.model,
      thinking: input.thinking,
      topology: sources[0]!.topology,
      synthesisOf: sourceIds,
      state: input.unavailableReason ? "unavailable" : "running",
      ...(input.unavailableReason ? { error: input.unavailableReason } : {}),
    };
    await this.store.update((draft) => { draft.discoveries.push(record); });
    if (input.unavailableReason) return this.load();

    let outcome: ChildOutcome;
    try {
      outcome = await this.runChild({
        parentSessionFile: run.parentSessionFile,
        targetCwd: run.projectRoot,
        sessionDir: join(dirname(run.statePath), "sessions", "discovery"),
        objective: discoverySynthesisObjective(run, sources),
        mode: "discovery",
        guideModel: input.model,
        guideThinking: input.thinking,
        runId: run.runId,
        nodeId: input.id,
        ...(input.stableEntryId !== undefined ? { stableEntryId: input.stableEntryId } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      return this.updateDiscovery(input.id, (draft) => {
        draft.state = input.signal?.aborted ? "cancelled" : "failed";
        draft.error = errorMessage(error);
      });
    }
    return this.updateDiscovery(input.id, (draft) => {
      draft.sessionFile = outcome.sessionFile;
      draft.usage = outcome.usage;
      if (outcome.resultKind) draft.resultKind = outcome.resultKind;
      if (outcome.terminalText) draft.terminalText = outcome.terminalText;
      if (outcome.capabilities) draft.capabilities = outcome.capabilities;
      if (outcome.exitCode === 0 && outcome.report?.kind === "discovery" && outcome.report.status === "completed") {
        draft.state = "completed";
        draft.report = outcome.report;
      } else {
        if (outcome.report?.kind === "discovery") draft.report = outcome.report;
        draft.state = outcome.timedOut ? "timed_out" : unavailableModelFailure(outcome) ? "unavailable" : "failed";
        draft.error = childFailure(outcome);
      }
    });
  }

  async proposeAgreement(input: AgreementInput, summary: string): Promise<WorkgraphRun> {
    const run = await this.load();
    if (run.outcome.kind !== "product_change") throw new Error("Agreement is only required for product-change outcomes.");
    requirePhase(run, ["awaiting_agreement", "needs_decision"]);
    if (!discoveryAgreementReady(run)) throw new Error("Agreement is blocked until every active discovery lane has a completed typed report or an explicit coordinator disposition.");
    validateAgreement(input);
    if (input.unresolvedDecisions.length > 0) throw new Error("Resolve material decisions before proposing the implementation envelope.");
    if (!summary.trim()) throw new Error("An agreement summary is required.");
    return this.store.update((draft) => {
      draft.agreementProposal = { ...input };
      draft.agreementProposalText = summary.trim();
    });
  }

  async recordAgreement(input: AgreementInput, accepted: boolean, prompt: string): Promise<WorkgraphRun> {
    const run = await this.load();
    if (run.outcome.kind !== "product_change") throw new Error("Agreement is only required for product-change outcomes.");
    requirePhase(run, ["awaiting_agreement", "needs_decision"]);
    if (accepted && !discoveryAgreementReady(run)) throw new Error("Agreement approval is blocked until every active discovery lane has a completed typed report or an explicit coordinator disposition.");
    validateAgreement(input);
    if (accepted && input.unresolvedDecisions.length > 0) {
      throw new Error("Resolve material decisions before approving the implementation envelope.");
    }
    return this.store.update((draft) => {
      const decision: HumanDecision = {
        kind: draft.phase === "needs_decision" ? "envelope_change" : "agreement",
        prompt,
        accepted,
        at: new Date().toISOString(),
      };
      draft.humanDecisions.push(decision);
      if (!accepted) {
        delete draft.agreementProposal;
        delete draft.agreementProposalText;
        return;
      }
      draft.agreement = { ...input, approvedAt: decision.at };
      delete draft.agreementProposal;
      delete draft.agreementProposalText;
      delete draft.productVerification;
      delete draft.assurance;
      setPhase(draft, "approved", decision.kind === "agreement"
        ? "The user approved the implementation envelope."
        : "The user approved the revised implementation envelope.");
    });
  }

  async proposePlan(input: AgreementInput, summary: string, changeKind: PlanChangeKind): Promise<WorkgraphRun> {
    const run = await this.load();
    if (run.outcome.kind !== "product_change") throw new Error("Planning is only available for product-change outcomes.");
    requireActiveLifecycle(run);
    if (!discoveryAgreementReady(run)) throw new Error("Planning is blocked until every active discovery lane has a completed typed report or an explicit coordinator disposition.");
    validateAgreement(input);
    if (input.unresolvedDecisions.length > 0) throw new Error("Resolve material decisions before proposing a plan.");
    if (!summary.trim()) throw new Error("A plan summary is required.");
    const current = currentApprovedPlan(run);
    if (changeKind === "internal" && !current) throw new Error("An internal plan change requires an approved plan.");
    if (changeKind === "authority" && !current) throw new Error("An authority-changing plan requires a previously approved plan.");
    if (changeKind === "initial" && current) throw new Error("A run with an approved plan must use an internal or authority-changing revision.");
    return this.store.update((draft) => {
      const now = new Date().toISOString();
      const version = (draft.plans.at(-1)?.version ?? 0) + 1;
      for (const plan of draft.plans) {
        if (plan.status === "proposed") plan.status = "superseded";
      }
      const approved = changeKind === "internal";
      if (approved) {
        for (const plan of draft.plans) if (plan.status === "approved") plan.status = "superseded";
      }
      draft.plans.push({
        version,
        status: approved ? "approved" : "proposed",
        changeKind,
        agreement: { ...input },
        summary: summary.trim(),
        proposedAt: now,
        ...(approved ? { approvedAt: now, decisionText: "Internal plan change did not alter authority." } : {}),
      });
      draft.control.planStatus = approved ? "approved" : "proposed";
      draft.control.currentPlanVersion = version;
      draft.control.attentionStatus = approved ? "clear" : "decision_required";
      if (!approved && (draft.control.executionStatus === "scheduled" || draft.control.executionStatus === "running")) {
        draft.control.executionStatus = "draining";
      }
      draft.control.updatedAt = now;
      if (approved) {
        draft.agreement = { ...input, approvedAt: now };
        delete draft.agreementProposal;
        delete draft.agreementProposalText;
      } else {
        draft.agreementProposal = { ...input };
        draft.agreementProposalText = summary.trim();
      }
    });
  }

  async reviewChildResult(input: ChildResultReviewInput): Promise<WorkgraphRun> {
    if (!input.summary.trim()) throw new Error("A child-result review requires a summary.");
    validateEvidence(input.evidence);
    const run = await this.load();
    requireActiveLifecycle(run);
    const attempt = run.attempts.find((candidate) => candidate.id === input.attemptId);
    if (!attempt || !attempt.mode) throw new Error(`Unknown child attempt ${input.attemptId}.`);
    const original = childResultRecord(run, attempt);
    if (!original || (original.resultKind !== "untyped" && original.resultKind !== "absent")) throw new Error("Only an untyped or absent child result can be reviewed.");
    if (input.disposition === "accept") {
      if (!input.report || input.report.kind !== attempt.mode || input.report.status !== "completed") throw new Error("Accepting an untyped child result requires a completed typed report matching the attempt mode.");
    }
    const report = input.report;
    const reviewed = await this.store.update((draft) => {
      const current = requiredAttempt(draft, input.attemptId);
      const retained = childResultRecord(draft, current);
      if (!retained || (retained.resultKind !== "untyped" && retained.resultKind !== "absent")) throw new Error("Child result changed before review was recorded.");
      const review: ChildResultReview = {
        id: randomUUID(),
        attemptId: input.attemptId,
        mode: current.mode!,
        disposition: input.disposition,
        originalResultKind: retained.resultKind,
        ...(retained.terminalText ? { originalTerminalText: retained.terminalText } : {}),
        summary: input.summary.trim(),
        evidence: input.evidence.map((item) => ({ ...item, class: item.class ?? "direct" })),
        ...(report ? { report } : {}),
        reviewedAt: new Date().toISOString(),
      };
      (draft.resultReviews ??= []).push(review);
      if (input.disposition === "accept" && report) promoteReviewedResult(draft, current, report as WorkerReport);
      else {
        current.state = "completed";
        current.stage = "settled";
        current.settledAt = review.reviewedAt;
        markRejectedResult(draft, current, `${input.disposition}: ${input.summary.trim()}`);
      }
      draft.control.attentionStatus = input.disposition === "accept" ? "clear" : "decision_required";
      draft.control.updatedAt = review.reviewedAt;
    });
    if (input.disposition === "accept" && attempt.mode === "discovery" && discoveryAgreementReady(reviewed) && reviewed.phase === "discovery") {
      return this.store.update((draft) => setPhase(draft, "awaiting_agreement", "Coordinator accepted typed evidence for every active discovery lane."));
    }
    return reviewed;
  }

  async recordPlanDecision(version: number, accepted: boolean, prompt: string): Promise<WorkgraphRun> {
    if (!Number.isSafeInteger(version) || version < 1) throw new Error("A valid plan version is required.");
    if (!prompt.trim()) throw new Error("A plan decision must preserve the user's exact reply.");
    return this.store.update((draft) => {
      requireActiveLifecycle(draft);
      const plan = draft.plans.find((candidate) => candidate.version === version);
      if (!plan || plan.status !== "proposed") throw new Error(`Plan v${version} is not awaiting approval.`);
      const latest = draft.plans.at(-1);
      if (latest?.version !== version) throw new Error(`Plan v${version} is not the latest plan.`);
      const now = new Date().toISOString();
      draft.humanDecisions.push({ kind: draft.agreement ? "envelope_change" : "agreement", prompt: prompt.trim(), accepted, at: now });
      plan.decisionText = prompt.trim();
      if (!accepted) {
        plan.status = "superseded";
        const previous = [...draft.plans].reverse().find((candidate) => candidate.status === "approved");
        draft.control.planStatus = previous ? "approved" : "absent";
        if (previous) draft.control.currentPlanVersion = previous.version;
        else delete draft.control.currentPlanVersion;
        draft.control.attentionStatus = "clear";
        if (draft.control.executionStatus === "draining") {
          draft.control.executionStatus = draft.nodes.some((node) => node.state === "running") ? "running" : draft.nodes.some((node) => node.state === "pending") ? "scheduled" : "idle";
        }
        delete draft.agreementProposal;
        delete draft.agreementProposalText;
        draft.control.updatedAt = now;
        return;
      }
      for (const candidate of draft.plans) {
        if (candidate.version !== version && candidate.status === "approved") candidate.status = "superseded";
      }
      plan.status = "approved";
      plan.approvedAt = now;
      draft.control.planStatus = "approved";
      draft.control.currentPlanVersion = version;
      draft.control.attentionStatus = "clear";
      draft.control.executionStatus = draft.nodes.some((node) => node.state === "running") ? "running" : draft.nodes.some((node) => node.state === "pending") ? "scheduled" : "idle";
      draft.control.updatedAt = now;
      draft.agreement = { ...plan.agreement, approvedAt: now };
      delete draft.agreementProposal;
      delete draft.agreementProposalText;
      delete draft.productVerification;
      delete draft.assurance;
    });
  }

  async schedule(input: ScheduleInput): Promise<WorkgraphRun> {
    const run = await this.load();
    if (run.outcome.kind !== "product_change") throw new Error("Scheduling is only available for product-change outcomes.");
    requireActiveLifecycle(run);
    const plan = currentApprovedPlan(run);
    if (!plan || run.control.planStatus !== "approved" || run.control.currentPlanVersion !== plan.version) {
      throw new Error("Scheduling requires the current approved plan.");
    }
    if (run.control.executionStatus === "paused" || run.control.executionStatus === "draining") {
      throw new Error(`Scheduling is unavailable while execution is ${run.control.executionStatus}.`);
    }
    const repositoryError = await this.composedRepositoryError(run);
    if (repositoryError) throw new Error(repositoryError);
    const maxConcurrency = input.maxConcurrency ?? run.control.maxConcurrency;
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 8) {
      throw new Error("maxConcurrency must be an integer from 1 through 8.");
    }
    return this.store.update((draft) => {
      if (input.nodes.length > 0) {
        const before = new Set(draft.nodes.map((node) => node.id));
        addNodes(draft, input.nodes);
        for (const node of draft.nodes) {
          if (!before.has(node.id)) node.planVersion = plan.version;
        }
      } else if (!draft.nodes.some((node) => node.state === "pending")) {
        throw new Error("No new or pending work nodes are available to schedule.");
      }
      for (const node of draft.nodes) {
        if (node.state === "pending" && node.planVersion === undefined) node.planVersion = plan.version;
      }
      const now = new Date().toISOString();
      draft.control.executionStatus = "scheduled";
      draft.control.attentionStatus = "clear";
      draft.control.maxConcurrency = maxConcurrency;
      draft.control.verificationStatus = "absent";
      draft.control.updatedAt = now;
      delete draft.productVerification;
      delete draft.assurance;
      draft.globalVerification = [];
      setPhase(draft, "executing", input.nodes.length > 0 ? `Scheduled ${input.nodes.length} asynchronous work node(s).` : "Resumed asynchronous pending work.");
    });
  }

  async controlExecution(input: ControlInput): Promise<WorkgraphRun> {
    if (!input.reason.trim()) throw new Error("A control action requires a reason.");
    return this.store.update((draft) => {
      requireActiveLifecycle(draft);
      const now = new Date().toISOString();
      if (input.action === "pause") {
        const mode = input.mode ?? "drain";
        draft.control.executionStatus = mode === "drain" && draft.nodes.some((node) => node.state === "running") ? "draining" : "paused";
        draft.control.pauseMode = mode;
        draft.control.pauseReason = input.reason.trim();
        if (mode === "immediate") {
          for (const attempt of draft.attempts) {
            if (attempt.state === "running" || attempt.state === "starting") attempt.state = "cancel_requested";
          }
        }
      } else if (input.action === "resume") {
        if (draft.control.planStatus !== "approved") throw new Error("Execution cannot resume without a current approved plan.");
        draft.control.executionStatus = draft.nodes.some((node) => node.state === "running") ? "running" : draft.nodes.some((node) => node.state === "pending") ? "scheduled" : "idle";
        delete draft.control.pauseMode;
        delete draft.control.pauseReason;
      } else if (input.action === "cancel") {
        const targets = input.nodeIds?.length ? new Set(input.nodeIds) : undefined;
        for (const node of draft.nodes) {
          if (targets && !targets.has(node.id)) continue;
          if (node.state === "pending") transitionNode(node, "cancelled");
          if (node.state === "running" && node.activeAttemptId) {
            const attempt = draft.attempts.find((candidate) => candidate.id === node.activeAttemptId);
            if (attempt && (attempt.state === "running" || attempt.state === "starting")) attempt.state = "cancel_requested";
          }
        }
        if (targets) {
          for (const nodeId of targets) if (!draft.nodes.some((node) => node.id === nodeId)) throw new Error(`Unknown work node ${nodeId}.`);
        }
      } else {
        for (const change of input.priorities) {
          if (!Number.isSafeInteger(change.priority) || change.priority < -1000 || change.priority > 1000) throw new Error(`Invalid priority for ${change.nodeId}.`);
          const node = draft.nodes.find((candidate) => candidate.id === change.nodeId);
          if (!node) throw new Error(`Unknown work node ${change.nodeId}.`);
          if (node.state !== "pending") throw new Error(`Only pending work can be reprioritized: ${change.nodeId} is ${node.state}.`);
          node.priority = change.priority;
        }
      }
      draft.control.updatedAt = now;
    });
  }

  async settle(): Promise<WorkgraphRun> {
    const run = await this.load();
    requireActiveLifecycle(run);
    const unsettled = run.attempts.some((attempt) => attempt.state === "starting" || attempt.state === "running" || attempt.state === "settling" || attempt.state === "cancel_requested");
    if (unsettled) throw new Error("Workgraph has active attempts; inspect status or pause before settlement.");
    if (!allNodesComposed(run)) {
      const attention = run.nodes.some((node) => node.state === "escalated") ? "decision_required" : run.nodes.some((node) => node.state === "failed") ? "failed" : "blocked";
      return this.store.update((draft) => {
        draft.control.executionStatus = "idle";
        draft.control.attentionStatus = attention;
        draft.control.updatedAt = new Date().toISOString();
      });
    }
    if (run.productVerification?.revision === run.composedCommit && run.control.verificationStatus !== "absent") return run;
    await this.finalizeComposition(run);
    return this.store.update((draft) => {
      const verification = draft.productVerification;
      draft.control.executionStatus = "idle";
      draft.control.verificationStatus = verification?.state === "completed"
        ? "passed"
        : verification?.state === "failed"
          ? "failed"
          : verification?.state === "inconclusive"
            ? "inconclusive"
            : verification?.state === "running"
              ? "running"
              : "absent";
      draft.control.attentionStatus = verification?.state === "failed" ? "failed" : verification?.state === "inconclusive" ? "decision_required" : "clear";
      draft.control.updatedAt = new Date().toISOString();
    });
  }

  async execute(input: ExecuteInput): Promise<WorkgraphRun> {
    let run = await this.load();
    if (run.outcome.kind !== "product_change") throw new Error("Implementation execution is only available for product-change outcomes.");
    requirePhase(run, ["approved", "awaiting_verification", "awaiting_assurance", "assurance_inconclusive", "revision_required"]);
    if (!run.agreement) throw new Error("An approved implementation envelope is required.");
    const repositoryError = await this.composedRepositoryError(run);
    if (repositoryError) {
      return this.store.update((draft) => {
        draft.error = repositoryError;
        setPhase(draft, "needs_decision", "Execution found repository state outside Workgraph composition.");
      });
    }
    const maxConcurrency = input.maxConcurrency ?? 2;
    await this.store.update((draft) => {
      if (input.nodes.length > 0) {
        addNodes(draft, input.nodes);
        delete draft.productVerification;
        delete draft.assurance;
        draft.globalVerification = [];
      } else if (!draft.nodes.some((node) => node.state === "pending")) {
        throw new Error("No new or pending work nodes are available to execute.");
      }
      setPhase(draft, "executing", input.nodes.length > 0
        ? `Scheduled ${input.nodes.length} work node(s).`
        : "Resumed pending work nodes after reconciliation.");
    });

    while (true) {
      run = await this.load();
      const wave = readyWave(run, maxConcurrency);
      if (wave.length === 0) break;
      const waveBase = run.composedCommit;
      const runnable: Array<{ node: WorkNode; placement: WorktreePlacement }> = [];
      const repository = await this.repositoryPromise;

      for (const node of wave) {
        try {
          const placement = await repository.createWorktree(run.runId, node.id, waveBase);
          await this.updateNode(node.id, (draft) => {
            transitionNode(draft, "running");
            draft.baseCommit = waveBase;
            draft.branch = placement.branch;
            draft.worktreePath = placement.path;
            draft.startedAt = new Date().toISOString();
          });
          runnable.push({ node, placement });
        } catch (error) {
          await this.updateNode(node.id, (draft) => {
            transitionNode(draft, "failed");
            draft.error = errorMessage(error);
            draft.settledAt = new Date().toISOString();
          });
        }
      }

      await mapConcurrent(runnable, maxConcurrency, async ({ node, placement }) => {
        await this.runImplementationNode(run, node, placement, input);
      });

      for (const nodeId of runnable.map(({ node }) => node.id).sort()) {
        const current = await this.load();
        const node = requireNode(current, nodeId);
        if (node.state !== "completed" || !node.commit || !node.worktreePath || !node.branch || !node.baseCommit) continue;
        const before = current.composedCommit;
        try {
          const after = await repository.compose(node.commit, before);
          await this.store.update((draft) => {
            const mutable = requireNode(draft, nodeId);
            transitionNode(mutable, "composed");
            mutable.composedAt = new Date().toISOString();
            draft.composedCommit = after;
            draft.composition.push({
              nodeId,
              sourceCommit: node.commit!,
              beforeCommit: before,
              afterCommit: after,
              status: "composed",
              at: new Date().toISOString(),
            });
          });
          try {
            await repository.removeWorktree({ path: node.worktreePath, branch: node.branch, baseCommit: node.baseCommit });
          } catch (error) {
            await this.updateNode(nodeId, (draft) => {
              draft.error = `Composition succeeded, but cleanup failed: ${errorMessage(error)}`;
            });
          }
        } catch (error) {
          await this.store.update((draft) => {
            const mutable = requireNode(draft, nodeId);
            transitionNode(mutable, "failed");
            mutable.error = errorMessage(error);
            draft.composition.push({
              nodeId,
              sourceCommit: node.commit!,
              beforeCommit: before,
              status: errorMessage(error).includes("conflict") ? "conflict" : "failed",
              error: errorMessage(error),
              at: new Date().toISOString(),
            });
          });
        }
      }
    }

    run = await this.load();
    if (allNodesComposed(run)) return this.finalizeComposition(run);

    const blocked = blockedPendingNodes(run);
    const hasEscalation = run.nodes.some((node) => node.state === "escalated");
    const hasFailure = run.nodes.some((node) => node.state === "failed");
    return this.changePhase(
      hasEscalation ? "needs_decision" : hasFailure || blocked.length > 0 ? "revision_required" : "failed",
      hasEscalation
        ? "Affected work reported a semantic or uncertain-result escalation."
        : hasFailure || blocked.length > 0
          ? "Routine failed work requires a bounded replacement node inside the approved envelope."
          : "No schedulable node remained before completion.",
    );
  }

  async reconcile(): Promise<WorkgraphRun> {
    let run = await this.load();
    if (run.phase === "awaiting_verification" && run.productVerification?.state === "running") {
      return this.reconcileVerification(run);
    }
    if ((run.phase === "awaiting_assurance" || run.phase === "assurance_inconclusive") && run.assurance?.state === "running") {
      return this.reconcileAssurance(run);
    }
    requirePhase(run, ["executing"]);
    const repository = await this.repositoryPromise;
    try {
      const recovered = await repository.recoverComposedCandidate(
        run.composedCommit,
        run.nodes.flatMap((node) => node.state === "completed" && node.commit && node.baseCommit
          ? [{ nodeId: node.id, baseCommit: node.baseCommit, commit: node.commit }]
          : []),
      );
      if (recovered) {
        const recoveredNode = requireNode(run, recovered.nodeId);
        const before = run.composedCommit;
        run = await this.store.update((draft) => {
          const node = requireNode(draft, recovered.nodeId);
          transitionNode(node, "composed");
          node.composedAt = new Date().toISOString();
          draft.composedCommit = recovered.head;
          draft.composition.push({
            nodeId: recovered.nodeId,
            sourceCommit: recovered.sourceCommit,
            beforeCommit: before,
            afterCommit: recovered.head,
            status: "composed",
            at: new Date().toISOString(),
          });
        });
        if (recoveredNode.worktreePath && recoveredNode.branch && recoveredNode.baseCommit) {
          await repository.removeWorktree({
            path: recoveredNode.worktreePath,
            branch: recoveredNode.branch,
            baseCommit: recoveredNode.baseCommit,
          }).catch(async (error) => {
            await this.updateNode(recovered.nodeId, (node) => {
              node.error = `Recovered composition, but cleanup failed: ${errorMessage(error)}`;
            });
          });
        }
      }
    } catch (error) {
      return this.store.update((draft) => {
        draft.error = `Recovery could not reconcile coordinator Git state: ${errorMessage(error)}`;
        setPhase(draft, "needs_decision", "Recovery found unattributed coordinator repository state.");
      });
    }

    run = await this.load();
    for (const node of run.nodes.filter((candidate) => candidate.state === "running")) {
      const report = node.sessionFile ? readWorkgraphReport(node.sessionFile) : undefined;
      const terminalText = !report && node.sessionFile ? readTerminalText(node.sessionFile) : undefined;
      if (!report || report.kind !== "implementation" || !node.worktreePath || !node.branch || !node.baseCommit) {
        await this.updateNode(node.id, (draft) => {
          if (terminalText) {
            draft.resultKind = "untyped";
            draft.terminalText = terminalText;
          } else {
            draft.resultKind = "absent";
          }
          transitionNode(draft, "escalated");
          draft.error = terminalText
            ? "Recovery retained final worker prose without a typed implementation result; inspect it before replacement."
            : "Recovery found no terminal implementation result. Inspect the retained worktree and child session before replacing this node.";
          draft.settledAt = new Date().toISOString();
        });
        continue;
      }
      await this.updateNode(node.id, (draft) => { draft.report = report; });
      if (report.status === "escalated") {
        await this.updateNode(node.id, (draft) => {
          transitionNode(draft, "escalated");
          draft.error = report.summary;
          draft.settledAt = new Date().toISOString();
        });
        continue;
      }
      if (report.status !== "completed") {
        await this.updateNode(node.id, (draft) => {
          transitionNode(draft, "failed");
          draft.error = report.summary;
          draft.settledAt = new Date().toISOString();
        });
        continue;
      }
      try {
        const placement = { path: node.worktreePath, branch: node.branch, baseCommit: node.baseCommit };
        const validated = await repository.validateWorkerCommit(placement, report.commit);
        const verification = await repository.runCommands(node.verificationCommands, node.worktreePath);
        const failed = verification.find((item) => item.exitCode !== 0);
        if (failed) throw new Error(`Node verification failed during recovery: ${failed.command}`);
        await this.updateNode(node.id, (draft) => {
          transitionNode(draft, "completed");
          draft.commit = validated.commit;
          draft.actualChangedFiles = validated.changedFiles;
          draft.verification = verification;
          draft.settledAt = new Date().toISOString();
        });
      } catch (error) {
        await this.updateNode(node.id, (draft) => {
          transitionNode(draft, "failed");
          draft.error = errorMessage(error);
          draft.settledAt = new Date().toISOString();
        });
      }
    }

    run = await this.load();
    for (const nodeId of run.nodes.filter((node) => node.state === "completed").map((node) => node.id).sort()) {
      const current = await this.load();
      const node = requireNode(current, nodeId);
      if (node.state !== "completed" || !node.commit || !node.worktreePath || !node.branch || !node.baseCommit) continue;
      const before = current.composedCommit;
      try {
        const after = await repository.compose(node.commit, before);
        await this.store.update((draft) => {
          const mutable = requireNode(draft, nodeId);
          transitionNode(mutable, "composed");
          mutable.composedAt = new Date().toISOString();
          draft.composedCommit = after;
          draft.composition.push({
            nodeId,
            sourceCommit: node.commit!,
            beforeCommit: before,
            afterCommit: after,
            status: "composed",
            at: new Date().toISOString(),
          });
        });
        await repository.removeWorktree({ path: node.worktreePath, branch: node.branch, baseCommit: node.baseCommit }).catch(async (error) => {
          await this.updateNode(nodeId, (draft) => {
            draft.error = `Recovered node composed, but cleanup failed: ${errorMessage(error)}`;
          });
        });
      } catch (error) {
        await this.updateNode(nodeId, (draft) => {
          transitionNode(draft, "failed");
          draft.error = errorMessage(error);
        });
      }
    }

    run = await this.load();
    if (allNodesComposed(run)) return this.finalizeComposition(run);
    if (run.nodes.some((node) => node.state === "escalated")) {
      return this.changePhase("needs_decision", "Recovery found a semantic escalation or a worker with an uncertain terminal result.");
    }
    if (run.nodes.some((node) => node.state === "failed")) {
      return this.changePhase("revision_required", "Recovered failed work can be replaced inside the approved envelope.");
    }
    if (run.nodes.some((node) => node.state === "pending")) {
      return this.changePhase("approved", "Recovery reconciled settled operations; pending nodes can resume.");
    }
    return this.changePhase("needs_decision", "Recovery could not identify a safe next operation.");
  }

  async verify(input: VerificationInput): Promise<WorkgraphRun> {
    const run = await this.load();
    requirePhase(run, ["awaiting_verification"]);
    if (!run.agreement || run.agreement.verificationMethod !== "independent") {
      throw new Error("Independent product verification is not required by the approved envelope.");
    }
    const repositoryError = await this.composedRepositoryError(run);
    if (repositoryError) {
      return this.store.update((draft) => {
        if (draft.productVerification) {
          draft.productVerification.state = "inconclusive";
          draft.productVerification.error = repositoryError;
        }
        setPhase(draft, "needs_decision", "Product verification found repository state outside Workgraph composition.");
      });
    }
    validateModel(input.model, "Product verifier");
    const verification: ProductVerificationRecord = {
      revision: run.composedCommit,
      method: "independent",
      state: "running",
      model: input.model,
      thinking: input.thinking,
      commands: [...run.globalVerification],
    };
    await this.store.update((draft) => { draft.productVerification = verification; });

    let outcome: ChildOutcome;
    try {
      outcome = await this.runChild({
        parentSessionFile: run.parentSessionFile,
        targetCwd: run.projectRoot,
        sessionDir: join(dirname(run.statePath), "sessions", "verification"),
        objective: verificationObjective(run),
        mode: "verification",
        guideModel: input.model,
        guideThinking: input.thinking,
        runId: run.runId,
        nodeId: "product-verification",
        onSessionCreated: async (sessionFile) => {
          await this.store.update((draft) => {
            if (draft.productVerification?.revision === run.composedCommit) draft.productVerification.sessionFile = sessionFile;
          });
        },
        ...(input.stableEntryId !== undefined ? { stableEntryId: input.stableEntryId } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      return this.store.update((draft) => {
        draft.productVerification = { ...verification, state: "inconclusive", error: errorMessage(error) };
      });
    }

    const postVerificationRepositoryError = await this.composedRepositoryError(run);
    if (postVerificationRepositoryError) {
      return this.store.update((draft) => {
        draft.productVerification = {
          ...verification,
          ...(outcome.resultKind ? { resultKind: outcome.resultKind } : {}),
          ...(outcome.terminalText ? { terminalText: outcome.terminalText } : {}),
          state: "inconclusive",
          sessionFile: outcome.sessionFile,
          usage: outcome.usage,
          error: postVerificationRepositoryError,
        };
        setPhase(draft, "needs_decision", "Product verification changed or observed unexpected repository state.");
      });
    }
    if (outcome.exitCode !== 0 || outcome.report?.kind !== "verification") {
      return this.store.update((draft) => {
        draft.productVerification = {
          ...verification,
          ...(outcome.resultKind ? { resultKind: outcome.resultKind } : {}),
          ...(outcome.terminalText ? { terminalText: outcome.terminalText } : {}),
          state: "inconclusive",
          sessionFile: outcome.sessionFile,
          usage: outcome.usage,
          error: childFailure(outcome),
        };
      });
    }

    const report = outcome.report;
    const { envelopeChange, failed, inconclusive } = classifyVerificationReport(report);
    return this.store.update((draft) => {
      draft.productVerification = {
        ...verification,
        ...(outcome.resultKind ? { resultKind: outcome.resultKind } : {}),
        ...(outcome.terminalText ? { terminalText: outcome.terminalText } : {}),
        state: inconclusive ? "inconclusive" : failed ? "failed" : "completed",
        sessionFile: outcome.sessionFile,
        usage: outcome.usage,
        report,
        ...(failed || inconclusive ? { error: report.summary } : {}),
      };
      if (envelopeChange) setPhase(draft, "needs_decision", "Product verification found an envelope-changing problem.");
      else if (failed) setPhase(draft, "revision_required", "Product verification found a correction inside the approved envelope.");
      else if (!inconclusive) setPhase(draft, "awaiting_assurance", "Independent product verification established evidence for the composed revision.");
    });
  }

  async assure(input: AssuranceInput): Promise<WorkgraphRun> {
    const run = await this.load();
    requirePhase(run, ["awaiting_assurance", "assurance_inconclusive"]);
    if (run.outcome.kind !== "product_change") throw new Error("Assurance is only available for product-change outcomes.");
    if (!run.agreement) throw new Error("An approved implementation envelope is required.");
    requireCurrentVerification(run);
    const repositoryError = await this.composedRepositoryError(run);
    if (repositoryError) {
      return this.store.update((draft) => {
        draft.error = repositoryError;
        setPhase(draft, "needs_decision", "Assurance found repository state outside Workgraph composition.");
      });
    }
    validateAssuranceAssignments(input);
    const previous = run.phase === "assurance_inconclusive" && run.assurance?.revision === run.composedCommit
      ? run.assurance
      : undefined;
    const assurance: AssuranceRecord = {
      revision: run.composedCommit,
      state: "running",
      reviews: input.reviewers.map((reviewer) => {
        const settled = previous?.reviews.find((candidate) => candidate.responsibility === reviewer.responsibility);
        if (settled?.state === "completed" && settled.report?.status === "completed" && settled.report.recommendation !== "inconclusive") return settled;
        return {
          responsibility: reviewer.responsibility,
          model: reviewer.model,
          thinking: reviewer.thinking,
          state: reviewer.unavailableReason ? "unavailable" : "running",
          ...(reviewer.unavailableReason ? { error: reviewer.unavailableReason } : {}),
        };
      }),
    };
    await this.store.update((draft) => { draft.assurance = assurance; });

    const runnableRoles = new Set(assurance.reviews.filter((review) => review.state === "running").map((review) => review.responsibility));
    const runnableReviewers = input.reviewers.filter((reviewer) => runnableRoles.has(reviewer.responsibility));
    await mapConcurrent(runnableReviewers, Math.max(1, runnableReviewers.length), async (reviewer) => {
      let outcome: ChildOutcome;
      try {
        outcome = await this.runChild({
          parentSessionFile: run.parentSessionFile,
          targetCwd: run.projectRoot,
          sessionDir: join(dirname(run.statePath), "sessions", "assurance", reviewer.responsibility),
          objective: assuranceReviewObjective(run, reviewer.responsibility),
          mode: "assurance_review",
          responsibility: reviewer.responsibility,
          guideModel: reviewer.model,
          guideThinking: reviewer.thinking,
          runId: run.runId,
          nodeId: `assurance-${reviewer.responsibility}`,
          onSessionCreated: async (sessionFile) => {
            await this.updateAssuranceReview(reviewer.responsibility, (record) => { record.sessionFile = sessionFile; });
          },
          ...(input.stableEntryId !== undefined ? { stableEntryId: input.stableEntryId } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (error) {
        await this.updateAssuranceReview(reviewer.responsibility, (record) => {
          record.state = "failed";
          record.error = errorMessage(error);
        });
        return;
      }
      await this.updateAssuranceReview(reviewer.responsibility, (record) => {
        record.sessionFile = outcome.sessionFile;
        if (outcome.resultKind) record.resultKind = outcome.resultKind;
        if (outcome.terminalText) record.terminalText = outcome.terminalText;
        record.usage = outcome.usage;
        if (outcome.exitCode === 0 && outcome.report?.kind === "assurance_review" && outcome.report.responsibility === reviewer.responsibility && outcome.report.status === "completed") {
          record.state = "completed";
          record.report = outcome.report;
        } else {
          record.state = outcome.timedOut ? "timed_out" : unavailableModelFailure(outcome) ? "unavailable" : "failed";
          record.error = childFailure(outcome);
        }
      });
    });

    let current = await this.load();
    if (!current.assurance || current.assurance.reviews.some((review) => review.state !== "completed" || !review.report)) {
      return this.store.update((draft) => {
        if (!draft.assurance) throw new Error("Assurance state disappeared.");
        draft.assurance.state = "inconclusive";
        setPhase(draft, "assurance_inconclusive", "At least one required assurance responsibility did not return a valid report.");
      });
    }
    if (current.assurance.reviews.some((review) => review.report?.recommendation === "inconclusive")) {
      return this.store.update((draft) => {
        if (!draft.assurance) throw new Error("Assurance state disappeared.");
        draft.assurance.state = "inconclusive";
        setPhase(draft, "assurance_inconclusive", "At least one assurance responsibility could not reach a supported verdict.");
      });
    }

    if (input.synthesis.unavailableReason) {
      const unavailableReason = input.synthesis.unavailableReason;
      return this.store.update((draft) => {
        if (!draft.assurance) throw new Error("Assurance state disappeared.");
        draft.assurance.state = "inconclusive";
        draft.assurance.synthesis = {
          model: input.synthesis.model,
          thinking: input.synthesis.thinking,
          state: "failed",
          error: unavailableReason,
        };
        setPhase(draft, "assurance_inconclusive", "The configured assurance synthesizer is unavailable.");
      });
    }
    const synthesis = { model: input.synthesis.model, thinking: input.synthesis.thinking, state: "running" as const };
    await this.store.update((draft) => {
      if (!draft.assurance) throw new Error("Assurance state disappeared.");
      draft.assurance.synthesis = synthesis;
    });
    let outcome: ChildOutcome;
    try {
      outcome = await this.runChild({
        parentSessionFile: run.parentSessionFile,
        targetCwd: run.projectRoot,
        sessionDir: join(dirname(run.statePath), "sessions", "assurance", "synthesis"),
        objective: assuranceSynthesisObjective(current),
        mode: "assurance_synthesis",
        guideModel: input.synthesis.model,
        guideThinking: input.synthesis.thinking,
        runId: run.runId,
        nodeId: "assurance-synthesis",
        onSessionCreated: async (sessionFile) => {
          await this.store.update((draft) => {
            if (draft.assurance?.synthesis?.state === "running") draft.assurance.synthesis.sessionFile = sessionFile;
          });
        },
        ...(input.stableEntryId !== undefined ? { stableEntryId: input.stableEntryId } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      return this.inconclusiveSynthesis(synthesis, undefined, errorMessage(error));
    }

    if (outcome.exitCode !== 0 || outcome.report?.kind !== "assurance_synthesis") {
      return this.inconclusiveSynthesis(synthesis, outcome, childFailure(outcome));
    }
    const report = outcome.report;
    try {
      validateSynthesis(current.assurance.reviews, report.dispositions);
    } catch (error) {
      return this.inconclusiveSynthesis(synthesis, outcome, errorMessage(error));
    }
    if (report.status !== "completed" || report.verdict === "inconclusive") {
      return this.store.update((draft) => {
        if (!draft.assurance) throw new Error("Assurance state disappeared.");
        draft.assurance.state = "inconclusive";
        draft.assurance.synthesis = {
          ...synthesis,
          ...(outcome.resultKind ? { resultKind: outcome.resultKind } : {}),
          ...(outcome.terminalText ? { terminalText: outcome.terminalText } : {}),
          state: outcome.timedOut ? "timed_out" : report.status === "completed" ? "completed" : "failed",
          sessionFile: outcome.sessionFile,
          usage: outcome.usage,
          report,
          error: report.summary,
        };
        setPhase(draft, "assurance_inconclusive", "Assurance synthesis could not produce a decision-ready candidate set.");
      });
    }

    return this.store.update((draft) => {
      if (!draft.assurance) throw new Error("Assurance state disappeared.");
      draft.assurance.state = "completed";
      draft.assurance.synthesis = {
        ...synthesis,
        ...(outcome.resultKind ? { resultKind: outcome.resultKind } : {}),
        ...(outcome.terminalText ? { terminalText: outcome.terminalText } : {}),
        state: "completed",
        sessionFile: outcome.sessionFile,
        usage: outcome.usage,
        report,
      };
      setPhase(draft, "awaiting_judgment", "Assurance synthesis is ready for coordinator judgment.");
    });
  }

  async judgeAssurance(input: AssuranceJudgmentInput): Promise<WorkgraphRun> {
    const run = await this.load();
    requirePhase(run, ["awaiting_judgment"]);
    if (!run.assurance || run.assurance.revision !== run.composedCommit || !run.assurance.synthesis?.report) {
      throw new Error("Current assurance evidence is required before final judgment.");
    }
    const repositoryError = await this.composedRepositoryError(run);
    if (repositoryError) {
      return this.store.update((draft) => {
        draft.error = repositoryError;
        setPhase(draft, "needs_decision", "Final judgment found repository state outside Workgraph composition.");
      });
    }
    const findings = assuranceFindings(run.assurance.reviews);
    const byId = new Map(findings.map((finding) => [finding.id, finding]));
    if (byId.size !== findings.length) throw new Error("Assurance finding ids must be unique across responsibilities.");
    if (input.judgments.length !== findings.length) throw new Error("Final judgment must account for every assurance finding exactly once.");
    const seen = new Set<string>();
    for (const judgment of input.judgments) {
      if (!byId.has(judgment.findingId)) throw new Error(`Unknown assurance finding: ${judgment.findingId}`);
      if (seen.has(judgment.findingId)) throw new Error(`Duplicate assurance judgment: ${judgment.findingId}`);
      if (!judgment.reason.trim()) throw new Error(`Assurance judgment ${judgment.findingId} requires a reason.`);
      seen.add(judgment.findingId);
    }
    const accepted = input.judgments
      .filter((judgment) => judgment.disposition === "accept")
      .map((judgment) => byId.get(judgment.findingId)!);
    const envelopeChange = accepted.some((finding) => finding.envelopeImpact !== "none");
    return this.store.update((draft) => {
      if (!draft.assurance) throw new Error("Assurance state disappeared.");
      draft.assurance.finalJudgment = {
        judgments: input.judgments.map((judgment) => ({ ...judgment })),
        acceptedFindings: accepted,
        at: new Date().toISOString(),
      };
      setPhase(
        draft,
        envelopeChange ? "needs_decision" : accepted.length > 0 ? "revision_required" : "complete",
        envelopeChange
          ? "Coordinator judgment accepted an envelope-changing assurance finding."
          : accepted.length > 0
            ? "Coordinator judgment accepted bounded corrections inside the approved envelope."
            : "Coordinator judgment accepted the composed result.",
      );
    });
  }

  private async reconcileVerification(run: WorkgraphRun): Promise<WorkgraphRun> {
    const repositoryError = await this.composedRepositoryError(run);
    if (repositoryError) {
      return this.store.update((draft) => {
        if (draft.productVerification) {
          draft.productVerification.state = "inconclusive";
          draft.productVerification.error = repositoryError;
        }
        setPhase(draft, "needs_decision", "Verification recovery found unattributed coordinator repository state.");
      });
    }
    const record = run.productVerification!;
    const report = record.sessionFile ? readWorkgraphReport(record.sessionFile) : undefined;
    if (!report || report.kind !== "verification") {
      return this.store.update((draft) => {
        if (!draft.productVerification) throw new Error("Product verification state disappeared.");
        draft.productVerification.state = "inconclusive";
        draft.productVerification.error = "Interrupted product verification has no complete typed result. Inspect the retained session before retrying.";
      });
    }
    const { envelopeChange, failed, inconclusive } = classifyVerificationReport(report);
    return this.store.update((draft) => {
      if (!draft.productVerification) throw new Error("Product verification state disappeared.");
      draft.productVerification.report = report;
      draft.productVerification.state = inconclusive ? "inconclusive" : failed ? "failed" : "completed";
      if (envelopeChange) setPhase(draft, "needs_decision", "Recovered product verification found an envelope-changing problem.");
      else if (failed) setPhase(draft, "revision_required", "Recovered product verification found a bounded correction.");
      else if (!inconclusive) setPhase(draft, "awaiting_assurance", "Recovered product verification established exact-revision evidence.");
    });
  }

  private async reconcileAssurance(run: WorkgraphRun): Promise<WorkgraphRun> {
    const repositoryError = await this.composedRepositoryError(run);
    if (repositoryError) {
      return this.store.update((draft) => {
        if (draft.assurance) draft.assurance.state = "inconclusive";
        draft.error = repositoryError;
        setPhase(draft, "needs_decision", "Assurance recovery found unattributed coordinator repository state.");
      });
    }

    const currentAssurance = run.assurance;
    if (!currentAssurance) throw new Error("Assurance state disappeared.");
    const recoveredReviews = new Map<AssuranceResponsibility, ReturnType<typeof readWorkgraphReport>>();
    for (const review of currentAssurance.reviews) {
      if (review.state === "running" && review.sessionFile) recoveredReviews.set(review.responsibility, readWorkgraphReport(review.sessionFile));
    }
    const synthesisReport = currentAssurance.synthesis?.state === "running" && currentAssurance.synthesis.sessionFile
      ? readWorkgraphReport(currentAssurance.synthesis.sessionFile)
      : undefined;
    return this.store.update((draft) => {
      const assurance = draft.assurance;
      if (!assurance) throw new Error("Assurance state disappeared.");
      for (const review of assurance.reviews) {
        if (review.state !== "running") continue;
        const report = recoveredReviews.get(review.responsibility);
        if (report?.kind === "assurance_review" && report.responsibility === review.responsibility && report.status === "completed") {
          review.state = "completed";
          review.report = report;
        } else {
          review.state = "failed";
          review.error = "Interrupted assurance review has no complete typed result. The retained session was inspected before retry.";
        }
      }
      if (assurance.reviews.some((review) => review.state !== "completed" || review.report?.recommendation === "inconclusive")) {
        assurance.state = "inconclusive";
        setPhase(draft, "assurance_inconclusive", "Assurance recovery found an incomplete responsibility result.");
        return;
      }
      if (assurance.synthesis?.state === "running") {
        if (synthesisReport?.kind === "assurance_synthesis" && synthesisReport.status === "completed" && synthesisReport.verdict !== "inconclusive") {
          try {
            validateSynthesis(assurance.reviews, synthesisReport.dispositions);
            assurance.synthesis.state = "completed";
            assurance.synthesis.report = synthesisReport;
            assurance.state = "completed";
            setPhase(draft, "awaiting_judgment", "Recovered assurance synthesis is ready for coordinator judgment.");
            return;
          } catch (error) {
            assurance.synthesis.error = errorMessage(error);
          }
        } else {
          assurance.synthesis.error = "Interrupted assurance synthesis has no complete decision-ready result.";
        }
        assurance.synthesis.state = "failed";
      }
      assurance.state = "inconclusive";
      setPhase(draft, "assurance_inconclusive", "Assurance reviews were preserved; synthesis can be retried without rerunning settled reviewers.");
    });
  }

  private async finalizeComposition(run: WorkgraphRun): Promise<WorkgraphRun> {
    if (!run.agreement) throw new Error("An approved implementation envelope is required.");
    const repository = await this.repositoryPromise;
    const verification = await repository.runCommands(run.agreement.verificationCommands);
    const repositoryError = await this.composedRepositoryError(run);
    return this.store.update((draft) => {
      draft.globalVerification = verification;
      if (repositoryError) {
        draft.productVerification = {
          revision: draft.composedCommit,
          method: draft.agreement!.verificationMethod,
          state: "inconclusive",
          commands: verification,
          error: repositoryError,
        };
        setPhase(draft, "needs_decision", "Composed-result verification changed or observed unexpected repository state.");
        return;
      }
      const failed = verification.some((item) => item.exitCode !== 0);
      if (failed) {
        draft.productVerification = {
          revision: draft.composedCommit,
          method: draft.agreement!.verificationMethod,
          state: "failed",
          commands: verification,
          error: "Composed-result verification command failed.",
        };
        setPhase(draft, "revision_required", "Composed-result verification failed.");
        return;
      }
      if (draft.agreement!.verificationMethod === "commands") {
        draft.productVerification = {
          revision: draft.composedCommit,
          method: "commands",
          state: "completed",
          commands: verification,
        };
        setPhase(draft, "awaiting_assurance", "Command verification established evidence for the composed revision.");
      } else {
        draft.productVerification = {
          revision: draft.composedCommit,
          method: "independent",
          state: "running",
          commands: verification,
        };
        setPhase(draft, "awaiting_verification", "The composed revision requires independent product verification.");
      }
    });
  }

  private async composedRepositoryError(run: WorkgraphRun): Promise<string | undefined> {
    const repository = await this.repositoryPromise;
    try {
      await repository.assertClean();
      const head = await repository.head();
      if (head !== run.composedCommit) return `Composition HEAD changed: expected ${run.composedCommit}, found ${head}.`;
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  }

  private async runImplementationNode(
    run: WorkgraphRun,
    node: WorkNode,
    placement: WorktreePlacement,
    input: ExecuteInput,
  ): Promise<void> {
    let outcome: ChildOutcome;
    const continuedNode = node.continuationOf ? run.nodes.find((candidate) => candidate.id === node.continuationOf) : undefined;
    try {
      outcome = await this.runChild({
        parentSessionFile: continuedNode?.sessionFile ?? run.parentSessionFile,
        targetCwd: placement.path,
        sessionDir: join(dirname(run.statePath), "sessions", "implementation"),
        objective: implementationObjective(run, node),
        mode: "implementation",
        guideModel: node.guideModel,
        guideThinking: node.guideThinking,
        executorModel: node.executorModel,
        executorThinking: node.executorThinking,
        implementationStart: continuedNode ? "executor" : "guide",
        timeoutMs: node.brief.timeboxMinutes * 60_000,
        runId: run.runId,
        nodeId: node.id,
        baseCommit: placement.baseCommit,
        onSessionCreated: async (sessionFile) => {
          await this.updateNode(node.id, (draft) => { draft.sessionFile = sessionFile; });
        },
        ...(!continuedNode && input.stableEntryId !== undefined ? { stableEntryId: input.stableEntryId } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      await this.updateNode(node.id, (draft) => {
        transitionNode(draft, "failed");
        draft.error = errorMessage(error);
        draft.settledAt = new Date().toISOString();
      });
      return;
    }

    await this.updateNode(node.id, (draft) => {
      draft.sessionFile = outcome.sessionFile;
      draft.processExitCode = outcome.exitCode;
      if (outcome.resultKind) draft.resultKind = outcome.resultKind;
      if (outcome.terminalText) draft.terminalText = outcome.terminalText;
      draft.usage = outcome.usage;
      draft.models = outcome.models;
      if (outcome.capabilities) draft.capabilities = outcome.capabilities;
      if (outcome.report?.kind === "implementation") draft.report = outcome.report;
    });
    if (outcome.exitCode !== 0 || outcome.report?.kind !== "implementation") {
      await this.updateNode(node.id, (draft) => {
        transitionNode(draft, "failed");
        draft.error = childFailure(outcome);
        draft.settledAt = new Date().toISOString();
      });
      return;
    }
    if (outcome.report.status === "escalated") {
      await this.updateNode(node.id, (draft) => {
        transitionNode(draft, "escalated");
        draft.error = outcome.report!.summary;
        draft.settledAt = new Date().toISOString();
      });
      return;
    }
    if (outcome.report.status !== "completed") {
      await this.updateNode(node.id, (draft) => {
        transitionNode(draft, "failed");
        draft.error = outcome.report!.summary;
        draft.settledAt = new Date().toISOString();
      });
      return;
    }

    try {
      const repository = await this.repositoryPromise;
      const validated = await repository.validateWorkerCommit(placement, outcome.report.commit);
      const verification = await repository.runCommands(node.verificationCommands, placement.path);
      const failedCommand = verification.find((item) => item.exitCode !== 0);
      if (failedCommand) throw new Error(`Node verification failed: ${failedCommand.command}`);
      await this.updateNode(node.id, (draft) => {
        transitionNode(draft, "completed");
        draft.commit = validated.commit;
        draft.actualChangedFiles = validated.changedFiles;
        draft.verification = verification;
        draft.settledAt = new Date().toISOString();
      });
    } catch (error) {
      await this.updateNode(node.id, (draft) => {
        transitionNode(draft, "failed");
        draft.error = errorMessage(error);
        draft.settledAt = new Date().toISOString();
      });
    }
  }

  private async inconclusiveSynthesis(
    synthesis: { model: string; thinking: ThinkingLevel; state: "running" },
    outcome: ChildOutcome | undefined,
    error: string,
  ): Promise<WorkgraphRun> {
    return this.store.update((draft) => {
      if (!draft.assurance) throw new Error("Assurance state disappeared.");
      draft.assurance.state = "inconclusive";
      draft.assurance.synthesis = {
        ...synthesis,
        state: outcome?.timedOut ? "timed_out" : "failed",
        ...(outcome ? { sessionFile: outcome.sessionFile, usage: outcome.usage } : {}),
        error,
      };
      setPhase(draft, "assurance_inconclusive", "Assurance synthesis failed or returned invalid evidence.");
    });
  }

  private updateNode(id: string, mutator: (node: WorkNode) => void): Promise<WorkgraphRun> {
    return this.store.update((run) => mutator(requireNode(run, id)));
  }

  private updateDiscovery(id: string, mutator: (record: DiscoveryRecord) => void): Promise<WorkgraphRun> {
    return this.store.update((run) => {
      const record = run.discoveries.find((candidate) => candidate.id === id);
      if (!record) throw new Error(`Unknown discovery record: ${id}`);
      mutator(record);
    });
  }

  private updateAssuranceReview(
    responsibility: AssuranceResponsibility,
    mutator: (record: AssuranceReviewRecord) => void,
  ): Promise<WorkgraphRun> {
    return this.store.update((run) => {
      const record = run.assurance?.reviews.find((candidate) => candidate.responsibility === responsibility);
      if (!record) throw new Error(`Unknown assurance responsibility: ${responsibility}`);
      mutator(record);
    });
  }

  private changePhase(to: RunPhase, reason: string): Promise<WorkgraphRun> {
    return this.store.update((run) => setPhase(run, to, reason));
  }
}

function validateDiscoveryAssignments(run: WorkgraphRun, assignments: DiscoveryAssignment[]): void {
  if (assignments.length < 1 || assignments.length > 5) throw new Error("Discovery requires between one and five bounded assignments.");
  const ids = new Set(run.discoveries.map((record) => record.id));
  const replacements = new Set<string>();
  for (const assignment of assignments) {
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(assignment.id) || ids.has(assignment.id)) throw new Error(`Invalid or duplicate investigation id: ${assignment.id}`);
    ids.add(assignment.id);
    if (!assignment.lens.trim() || !assignment.objective.trim()) throw new Error(`Investigation ${assignment.id} is incomplete.`);
    validateModel(assignment.model, `Investigation ${assignment.id}`);
    for (const replacedId of assignment.supersedes ?? []) {
      const replaced = run.discoveries.find((record) => record.id === replacedId);
      if (!replaced) throw new Error(`Investigation ${assignment.id} cannot supersede unknown lane ${replacedId}.`);
      if (replaced.state === "completed" || replaced.state === "running" || replaced.state === "superseded") throw new Error(`Investigation ${assignment.id} cannot supersede lane ${replacedId} in ${replaced.state}.`);
      if (replacements.has(replacedId)) throw new Error(`Discovery lane ${replacedId} has more than one replacement.`);
      replacements.add(replacedId);
    }
  }
}

function observerAttempt(
  run: WorkgraphRun,
  input: {
    id: string;
    nodeId: string;
    mode: WorkerMode;
    planVersion: number;
    model: string;
    thinking: ThinkingLevel;
    objective: string;
    stableEntryId?: string | null | undefined;
    responsibility?: AssuranceResponsibility;
  },
): WorkAttempt {
  const now = new Date().toISOString();
  return {
    id: input.id,
    nodeId: input.nodeId,
    mode: input.mode,
    planVersion: input.planVersion,
    state: "queued",
    stage: "queued",
    runtimeMode: "herdr",
    createdAt: now,
    lastActivityAt: now,
    baseCommit: run.composedCommit,
    parentSessionFile: run.parentSessionFile,
    ...(input.stableEntryId !== undefined ? { stableEntryId: input.stableEntryId } : {}),
    objective: input.objective,
    model: input.model,
    thinking: input.thinking,
    ...(input.responsibility ? { responsibility: input.responsibility } : {}),
    agentName: herdrAgentName(run.runId, input.nodeId, input.id),
  };
}

function validateEvidence(evidence: EvidenceItem[]): void {
  if (evidence.length === 0) throw new Error("Typed terminal completion requires evidence.");
  for (const item of evidence) {
    if (!item.label.trim() || !item.observation.trim()) throw new Error("Evidence labels and observations are required.");
  }
}

function validateAgreement(input: AgreementInput): void {
  const required = [
    ["outcome", input.outcome],
    ["reuseDecision", input.reuseDecision],
    ["structure", input.structure],
    ["expectedScale", input.expectedScale],
    ["verificationBoundary", input.verificationBoundary],
    ["verificationProcedure", input.verificationProcedure],
  ] as const;
  const missing = required.filter(([, value]) => !value.trim()).map(([name]) => name);
  if (missing.length > 0) throw new Error(`Implementation envelope fields must not be empty: ${missing.join(", ")}.`);
  if (input.verificationCommands.some((command) => !command.trim())) throw new Error("Verification commands must not contain empty entries.");
  if (input.requiredEvidence.some((item) => !item.trim())) throw new Error("Required evidence must not contain empty entries.");
  if (input.verificationMethod === "commands" && input.verificationCommands.length === 0) {
    throw new Error("Command verification requires at least one composed-root command.");
  }
  if (input.verificationMethod === "independent" && input.requiredEvidence.length === 0) {
    throw new Error("Independent verification requires at least one concrete evidence item.");
  }
}

function validateAssuranceAssignments(input: AssuranceInput): void {
  const responsibilities = input.reviewers.map((reviewer) => reviewer.responsibility);
  const expected: AssuranceResponsibility[] = ["behavior", "structure", "evidence"];
  if (responsibilities.length !== expected.length || expected.some((role) => responsibilities.filter((candidate) => candidate === role).length !== 1)) {
    throw new Error("Assurance requires exactly one behavior, structure, and evidence reviewer.");
  }
  for (const reviewer of input.reviewers) validateModel(reviewer.model, `${reviewer.responsibility} reviewer`);
  validateModel(input.synthesis.model, "Assurance synthesizer");
}

export function validateSynthesis(
  reviews: AssuranceReviewRecord[],
  dispositions: Array<{ finding: AssuranceFinding; disposition: "accept" | "optional" | "dismiss"; reason: string }>,
): void {
  const findings = assuranceFindings(reviews);
  const byId = new Map<string, AssuranceFinding>();
  for (const finding of findings) {
    if (byId.has(finding.id)) throw new Error(`Duplicate assurance finding id: ${finding.id}`);
    byId.set(finding.id, finding);
  }
  if (dispositions.length !== findings.length) throw new Error("Assurance synthesis must account for every candidate finding exactly once.");
  const seen = new Set<string>();
  for (const disposition of dispositions) {
    const original = byId.get(disposition.finding.id);
    if (!original) throw new Error(`Assurance synthesis invented finding ${disposition.finding.id}.`);
    if (seen.has(disposition.finding.id)) throw new Error(`Assurance synthesis duplicated finding ${disposition.finding.id}.`);
    if (JSON.stringify(original) !== JSON.stringify(disposition.finding)) {
      throw new Error(`Assurance synthesis changed candidate finding ${disposition.finding.id}.`);
    }
    if (!disposition.reason.trim()) throw new Error(`Assurance synthesis disposition ${disposition.finding.id} requires a reason.`);
    seen.add(disposition.finding.id);
  }
}

function assuranceFindings(reviews: AssuranceReviewRecord[]): AssuranceFinding[] {
  return reviews.flatMap((review) => review.report?.findings ?? []);
}

function requireCurrentVerification(run: WorkgraphRun): void {
  const verification = run.productVerification;
  if (!verification || verification.state !== "completed" || verification.revision !== run.composedCommit) {
    throw new Error("Product verification must be complete for the exact composed revision before assurance.");
  }
}

function requirePhase(run: WorkgraphRun, phases: RunPhase[]): void {
  if (!phases.includes(run.phase)) throw new Error(`Workgraph ${run.runId} is ${run.phase}; expected ${phases.join(" or ")}.`);
}

function requireActiveLifecycle(run: WorkgraphRun): void {
  if (run.lifecycle !== "active") throw new Error(`Workgraph ${run.runId} lifecycle is ${run.lifecycle}; expected active.`);
}

function currentApprovedPlan(run: WorkgraphRun) {
  return [...run.plans].reverse().find((plan) => plan.status === "approved");
}

function discoveryAgreementReady(run: WorkgraphRun): boolean {
  const active = run.discoveries.filter((record) => record.state !== "superseded");
  return active.length === 0 || active.every((record) => record.state === "completed" && record.report?.kind === "discovery" && record.report.status === "completed");
}

type ResultCarrier = { resultKind?: ChildResultKind; terminalText?: string; report?: WorkerReport; state?: string; error?: string };

function childResultRecord(run: WorkgraphRun, attempt: WorkAttempt): ResultCarrier | undefined {
  if (attempt.mode === "implementation") return run.nodes.find((node) => node.activeAttemptId === attempt.id || node.id === attempt.nodeId);
  if (attempt.mode === "discovery") return run.discoveries.find((record) => record.attemptId === attempt.id);
  if (attempt.mode === "verification") return run.productVerification?.attemptId === attempt.id ? run.productVerification : undefined;
  if (attempt.mode === "assurance_review") return run.assurance?.reviews.find((record) => record.attemptId === attempt.id);
  if (attempt.mode === "assurance_synthesis") return run.assurance?.synthesis?.attemptId === attempt.id ? run.assurance.synthesis : undefined;
  return undefined;
}

function promoteReviewedResult(run: WorkgraphRun, attempt: WorkAttempt, report: WorkerReport): void {
  const now = new Date().toISOString();
  attempt.resultKind = "typed";
  attempt.state = "completed";
  attempt.stage = "settled";
  attempt.settledAt = now;
  attempt.lastActivityAt = now;
  if (attempt.mode === "discovery" && report.kind === "discovery") {
    const record = run.discoveries.find((candidate) => candidate.attemptId === attempt.id);
    if (record) { record.resultKind = "typed"; record.report = report; record.state = "completed"; delete record.error; }
  } else if (attempt.mode === "verification" && report.kind === "verification") {
    const verification = run.productVerification;
    if (verification?.attemptId === attempt.id) { verification.resultKind = "typed"; verification.report = report; verification.state = "completed"; delete verification.error; }
  } else if (attempt.mode === "assurance_review" && report.kind === "assurance_review") {
    const review = run.assurance?.reviews.find((candidate) => candidate.attemptId === attempt.id);
    if (review) { review.resultKind = "typed"; review.report = report; review.state = "completed"; delete review.error; }
  } else if (attempt.mode === "assurance_synthesis" && report.kind === "assurance_synthesis") {
    const synthesis = run.assurance?.synthesis;
    if (synthesis?.attemptId === attempt.id) { synthesis.resultKind = "typed"; synthesis.report = report; synthesis.state = "completed"; delete synthesis.error; }
  } else if (attempt.mode === "implementation" && report.kind === "implementation") {
    const node = run.nodes.find((candidate) => candidate.id === attempt.nodeId);
    if (node) {
      node.resultKind = "typed";
      node.report = report;
      node.error = "Coordinator accepted typed evidence, but implementation commit validation is still required.";
      if (node.state === "running") transitionNode(node, "escalated");
      delete node.activeAttemptId;
    }
  }
}

function addCleanupIntents(run: WorkgraphRun): void {
  const cleanup = run.cleanup ??= [];
  for (const attempt of run.attempts) {
    if (!attempt.worktreePath || !attempt.branch || !attempt.baseCommit) continue;
    const node = run.nodes.find((candidate) => candidate.id === attempt.nodeId);
    const expectedHead = node?.commit ?? attempt.baseCommit;
    if (!cleanup.some((record) => record.attemptId === attempt.id && record.kind === "git_worktree")) {
      cleanup.push({ id: `${attempt.id}:git`, attemptId: attempt.id, kind: "git_worktree", state: "pending", requestedAt: new Date().toISOString(), path: attempt.worktreePath, branch: attempt.branch, expectedHead });
    }
    if (attempt.worker && !cleanup.some((record) => record.attemptId === attempt.id && record.kind === "herdr_worker")) {
      cleanup.push({ id: `${attempt.id}:herdr`, attemptId: attempt.id, kind: "herdr_worker", state: "pending", requestedAt: new Date().toISOString(), identity: { ...attempt.worker } });
    }
  }
}

function markRejectedResult(run: WorkgraphRun, attempt: WorkAttempt, reason: string): void {
  attempt.attention = `Coordinator disposition requires follow-up: ${reason}`;
  const carrier = childResultRecord(run, attempt);
  if (carrier) carrier.error = reason;
  if (attempt.mode === "implementation") {
    const node = run.nodes.find((candidate) => candidate.id === attempt.nodeId);
    if (node) { if (node.state === "running") transitionNode(node, "escalated"); delete node.activeAttemptId; node.error = reason; }
  } else if (attempt.mode === "discovery") {
    const record = run.discoveries.find((candidate) => candidate.attemptId === attempt.id);
    if (record) record.state = "failed";
  }
}

function requiredAttempt(run: WorkgraphRun, id: string): WorkAttempt {
  const attempt = run.attempts.find((candidate) => candidate.id === id);
  if (!attempt) throw new Error(`Unknown work attempt ${id}.`);
  return attempt;
}

function requireNode(run: WorkgraphRun, id: string): WorkNode {
  const node = run.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`Unknown work node: ${id}`);
  return node;
}

function setPhase(run: WorkgraphRun, to: RunPhase, reason: string): void {
  if (run.phase === to) return;
  run.transitions.push({
    sequence: run.transitions.length + 1,
    at: new Date().toISOString(),
    from: run.phase,
    to,
    reason,
  });
  run.phase = to;
}

function discoveryObjective(run: WorkgraphRun, topology: DiscoveryTopology, assignment: DiscoveryAssignment): string {
  return [
    `Original request: ${run.request}`,
    `Outcome: ${run.outcome.kind}`,
    `Discovery topology: ${topology}`,
    `Assigned responsibility: ${assignment.lens}`,
    `Bounded question: ${assignment.objective}`,
    "Inspect only evidence needed to answer this responsibility.",
    "Return decisive source pointers and identify only unknowns that could change the implementation envelope.",
  ].join("\n\n");
}

function discoverySynthesisObjective(run: WorkgraphRun, sources: DiscoveryRecord[]): string {
  return [
    `Original request: ${run.request}`,
    `Outcome: ${run.outcome.kind}`,
    "Discovery reports to reconcile:",
    JSON.stringify(sources.map((source) => ({
      id: source.id,
      topology: source.topology,
      lens: source.lens,
      model: source.model,
      state: source.state,
      report: source.report,
      error: source.error,
    })), null, 2),
    "Identify convergence, disagreement, decisive evidence, and unresolved unknowns without inventing facts.",
    "Return one compact discovery report for the coordinator's agreement decision.",
  ].join("\n\n");
}

function implementationObjective(run: WorkgraphRun, node: WorkNode): string {
  const dependencyEvidence = node.dependencies.map((id) => {
    const dependency = run.nodes.find((candidate) => candidate.id === id);
    return { id, commit: dependency?.commit, summary: dependency?.report?.summary };
  });
  return [
    `Original request: ${run.request}`,
    `Outcome: ${run.outcome.kind}`,
    "Approved implementation envelope:",
    JSON.stringify(run.agreement, null, 2),
    "Bounded worker brief:",
    `GOAL\n${node.brief.goal}`,
    `SCOPE\n${node.claimedPaths.join("\n")}`,
    `CONTEXT\n${node.brief.context.map((item) => `- ${item}`).join("\n") || "- None"}`,
    `ACCEPTANCE\n${node.brief.acceptance.map((item) => `- ${item}`).join("\n")}`,
    `VERIFY\n${node.verificationCommands.map((command) => `- ${command}`).join("\n") || "- None"}`,
    `TIMEBOX\n${node.brief.timeboxMinutes} minutes`,
    `FORBIDDEN\n${node.brief.forbidden.map((item) => `- ${item}`).join("\n") || "- No additional restrictions"}`,
    `REPORT\n${node.brief.report}`,
    "Already composed dependency pointers:",
    JSON.stringify(dependencyEvidence, null, 2),
    node.continuationOf
      ? `Continue the retained implementer trajectory from node ${node.continuationOf} against the current composed base.`
      : "Use Local Prewalk and implement the smallest complete change inside this node's ownership.",
  ].join("\n\n");
}

function verificationObjective(run: WorkgraphRun): string {
  return [
    `Original request: ${run.request}`,
    `Exact composed revision: ${run.composedCommit}`,
    `Verification boundary: ${run.agreement?.verificationBoundary}`,
    `Procedure: ${run.agreement?.verificationProcedure}`,
    "Required evidence:",
    JSON.stringify(run.agreement?.requiredEvidence ?? [], null, 2),
    "Scheduler command evidence:",
    JSON.stringify(run.globalVerification, null, 2),
    "Observe the matching product surface independently and attach concise artifact paths or concrete observations to the report.",
  ].join("\n\n");
}

function assuranceReviewObjective(run: WorkgraphRun, responsibility: AssuranceResponsibility): string {
  const nodes = run.nodes.map((node) => ({
    id: node.id,
    goal: node.brief.goal,
    commit: node.commit,
    changedFiles: node.actualChangedFiles,
    verification: node.verification,
  }));
  return [
    `Original request: ${run.request}`,
    `Assurance responsibility: ${responsibility}`,
    `Exact composed revision: ${run.composedCommit}`,
    "Approved implementation envelope:",
    JSON.stringify(run.agreement, null, 2),
    "Composed node pointers:",
    JSON.stringify(nodes, null, 2),
    "Product verification evidence:",
    JSON.stringify(run.productVerification, null, 2),
    "Inspect the actual repository and report only material candidates within the assigned responsibility.",
  ].join("\n\n");
}

function assuranceSynthesisObjective(run: WorkgraphRun): string {
  return [
    `Original request: ${run.request}`,
    `Exact composed revision: ${run.composedCommit}`,
    "Approved implementation envelope:",
    JSON.stringify(run.agreement, null, 2),
    "Independent responsibility reports:",
    JSON.stringify(run.assurance?.reviews.map((review) => ({
      responsibility: review.responsibility,
      model: review.model,
      report: review.report,
    })), null, 2),
    "Account for every candidate by its exact id, preserve each candidate unchanged, and propose accept or dismiss with a concise reason.",
    "Do not invent new findings.",
  ].join("\n\n");
}

function classifyVerificationReport(report: VerificationReport): {
  envelopeChange: boolean;
  failed: boolean;
  inconclusive: boolean;
} {
  return {
    envelopeChange: report.status === "escalated" || report.findings.some((finding) => finding.envelopeImpact !== "none"),
    failed: report.status === "failed" || report.verdict === "failed",
    inconclusive: report.verdict === "inconclusive",
  };
}

function validateModel(model: string, owner: string): void {
  if (!/^[^/]+\/.+$/.test(model)) throw new Error(`${owner} model must use provider/model.`);
}

function unavailableModelFailure(outcome: ChildOutcome): boolean {
  return /model.*(?:unavailable|not found|unknown)|no usable credentials/i.test(`${outcome.stderr}\n${outcome.report?.summary ?? ""}`);
}

function childFailure(outcome: ChildOutcome): string {
  if (outcome.timedOut) return `Child timed out. Session: ${outcome.sessionFile}`;
  if (outcome.report?.summary) return outcome.report.summary;
  if (outcome.terminalText) return `Child returned prose requiring coordinator review: ${outcome.terminalText}`;
  if (outcome.stderr) return outcome.stderr;
  return `Child exited ${outcome.exitCode} without a terminal result. Session: ${outcome.sessionFile}`;
}

function legacyChildUnavailable(): Promise<ChildOutcome> {
  return Promise.reject(new Error("Legacy piped child execution is disabled; use the visible asynchronous Workgraph supervisor."));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
