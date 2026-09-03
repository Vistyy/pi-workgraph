import { dirname, join } from "node:path";
import { GitRepository, type WorktreePlacement } from "./git.js";
import { mapConcurrent, readWorkgraphReport, runPiChild, type ChildRequest } from "./pi-process.js";
import { addNodes, allNodesComposed, blockedPendingNodes, readyWave, transitionNode } from "./scheduler.js";
import { RunStateStore, type NewRunInput } from "./state-store.js";
import type {
  Agreement,
  AssuranceFinding,
  AssuranceRecord,
  AssuranceResponsibility,
  AssuranceReviewRecord,
  ChildOutcome,
  DiscoveryAssignment,
  DiscoveryRecord,
  DiscoveryTopology,
  HumanDecision,
  ProductVerificationRecord,
  RunPhase,
  ThinkingLevel,
  VerificationReport,
  WorkNode,
  WorkNodeSpec,
  WorkgraphRun,
} from "./types.js";

export type ChildRunner = (request: ChildRequest) => Promise<ChildOutcome>;

export interface EngineDependencies {
  runChild?: ChildRunner;
  repository?: GitRepository;
}

export interface DiscoveryInput {
  topology: DiscoveryTopology;
  assignments: DiscoveryAssignment[];
  stableEntryId?: string | null;
  signal?: AbortSignal;
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

  constructor(readonly store: RunStateStore, dependencies: EngineDependencies = {}) {
    this.runChild = dependencies.runChild ?? runPiChild;
    this.repositoryPromise = dependencies.repository
      ? Promise.resolve(dependencies.repository)
      : this.store.load().then((run) => new GitRepository(run.projectRoot, run.gitCommonDir));
  }

  static async begin(input: NewRunInput, dependencies: EngineDependencies = {}): Promise<{ engine: WorkgraphEngine; run: WorkgraphRun }> {
    if (!input.request.trim()) throw new Error("A Workgraph request is required.");
    if (!input.playbook.completionPredicate.trim()) throw new Error("A checkable completion predicate is required.");
    if (input.playbook.steps.length === 0) throw new Error("The selected playbook has no steps.");
    const created = await RunStateStore.create(input);
    return { engine: new WorkgraphEngine(created.store, dependencies), run: created.run };
  }

  static open(statePath: string, dependencies: EngineDependencies = {}): WorkgraphEngine {
    return new WorkgraphEngine(new RunStateStore(statePath), dependencies);
  }

  load(): Promise<WorkgraphRun> {
    return this.store.load();
  }

  async recordProgress(stepId: string, status: "completed" | "skipped", reason?: string): Promise<WorkgraphRun> {
    if (!stepId.trim()) throw new Error("A playbook step id is required.");
    if (status === "skipped" && !reason?.trim()) throw new Error("A skipped playbook step requires a reason.");
    return this.store.update((run) => {
      const step = run.playbook.steps.find((candidate) => candidate.id === stepId);
      if (!step) throw new Error(`Unknown step ${stepId} for playbook ${run.playbook.id}.`);
      step.status = status;
      if (reason?.trim()) step.reason = reason.trim();
      else delete step.reason;
      step.at = new Date().toISOString();
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
            : unavailableModelFailure(outcome)
              ? "unavailable"
              : "failed";
        record.error = childFailure(outcome);
      });
    });

    return this.changePhase("awaiting_agreement", `${input.topology} discovery settled with every requested lane accounted for.`);
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

  async recordAgreement(input: AgreementInput, accepted: boolean, prompt: string): Promise<WorkgraphRun> {
    const run = await this.load();
    requirePhase(run, ["awaiting_agreement", "needs_decision"]);
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
      if (!accepted) return;
      draft.agreement = { ...input, approvedAt: decision.at };
      delete draft.productVerification;
      delete draft.assurance;
      setPhase(draft, "approved", decision.kind === "agreement"
        ? "The user approved the implementation envelope."
        : "The user approved the revised implementation envelope.");
    });
  }

  async execute(input: ExecuteInput): Promise<WorkgraphRun> {
    let run = await this.load();
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
      if (!report || report.kind !== "implementation" || !node.worktreePath || !node.branch || !node.baseCommit) {
        await this.updateNode(node.id, (draft) => {
          transitionNode(draft, "escalated");
          draft.error = "Recovery found no complete typed implementation result. Inspect the retained worktree and child session before replacing this node.";
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
        const validated = await repository.validateWorkerCommit(placement, node.claimedPaths, report.commit);
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
    if (!run.agreement) throw new Error("An approved implementation envelope is required.");
    requireCurrentVerification(run);
    const pendingSteps = run.playbook.steps.filter((step) => step.status === "pending").map((step) => step.id);
    if (pendingSteps.length > 0) {
      throw new Error(`Settle every playbook step before assurance: ${pendingSteps.join(", ")}.`);
    }
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
        allowedPaths: node.claimedPaths,
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
      draft.usage = outcome.usage;
      draft.models = outcome.models;
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
      const validated = await repository.validateWorkerCommit(placement, node.claimedPaths, outcome.report.commit);
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

function validateSynthesis(
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
    `Selected playbook: ${run.playbook.id}`,
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
  if (outcome.stderr) return outcome.stderr;
  return `Child exited ${outcome.exitCode} without a typed report. Session: ${outcome.sessionFile}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
