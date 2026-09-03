import { dirname, join } from "node:path";
import { GitRepository, type WorktreePlacement } from "./git.js";
import { mapConcurrent, readWorkgraphReport, runPiChild, type ChildRequest } from "./pi-process.js";
import { addNodes, allNodesComposed, blockedPendingNodes, readyWave, transitionNode } from "./scheduler.js";
import { RunStateStore, type NewRunInput } from "./state-store.js";
import type {
  Agreement,
  AssuranceRecord,
  ChildOutcome,
  DiscoveryRecord,
  HumanDecision,
  InvestigationSpec,
  RunPhase,
  ThinkingLevel,
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
  investigations: InvestigationSpec[];
  model: string;
  thinking: ThinkingLevel;
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

export interface AssuranceInput {
  model: string;
  thinking: ThinkingLevel;
  stableEntryId?: string | null;
  signal?: AbortSignal;
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
    const created = await RunStateStore.create(input);
    return { engine: new WorkgraphEngine(created.store, dependencies), run: created.run };
  }

  static open(statePath: string, dependencies: EngineDependencies = {}): WorkgraphEngine {
    return new WorkgraphEngine(new RunStateStore(statePath), dependencies);
  }

  load(): Promise<WorkgraphRun> {
    return this.store.load();
  }

  async discover(input: DiscoveryInput): Promise<WorkgraphRun> {
    const run = await this.load();
    requirePhase(run, ["discovery"]);
    if (input.investigations.length < 1 || input.investigations.length > 5) {
      throw new Error("Discovery requires between one and five bounded investigations.");
    }
    const ids = new Set<string>();
    for (const investigation of input.investigations) {
      if (!/^[a-z][a-z0-9_-]{0,47}$/.test(investigation.id)) throw new Error(`Invalid investigation id: ${investigation.id}`);
      if (ids.has(investigation.id)) throw new Error(`Duplicate investigation id: ${investigation.id}`);
      ids.add(investigation.id);
      if (!investigation.lens.trim() || !investigation.objective.trim()) throw new Error(`Investigation ${investigation.id} is incomplete.`);
    }

    await this.store.update((draft) => {
      draft.discoveries = input.investigations.map<DiscoveryRecord>((investigation) => ({
        ...investigation,
        model: input.model,
        state: "running",
      }));
    });

    const sessionDir = join(dirname(run.statePath), "sessions", "discovery");
    await mapConcurrent(input.investigations, Math.min(4, input.investigations.length), async (investigation) => {
      let outcome: ChildOutcome;
      try {
        outcome = await this.runChild({
          parentSessionFile: run.parentSessionFile,
          targetCwd: run.projectRoot,
          sessionDir,
          objective: discoveryObjective(run, investigation),
          mode: "discovery",
          guideModel: input.model,
          guideThinking: input.thinking,
          runId: run.runId,
          nodeId: investigation.id,
          ...(input.stableEntryId !== undefined ? { stableEntryId: input.stableEntryId } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (error) {
        await this.updateDiscovery(investigation.id, (record) => {
          record.state = "failed";
          record.error = errorMessage(error);
        });
        return;
      }
      await this.updateDiscovery(investigation.id, (record) => {
        record.sessionFile = outcome.sessionFile;
        record.usage = outcome.usage;
        if (outcome.exitCode === 0 && outcome.report?.kind === "discovery" && outcome.report.status === "completed") {
          record.state = "completed";
          record.report = outcome.report;
        } else {
          record.state = "failed";
          if (outcome.report?.kind === "discovery") record.report = outcome.report;
          record.error = childFailure(outcome);
        }
      });
    });

    return this.changePhase("awaiting_agreement", "Bounded discovery settled.");
  }

  async recordAgreement(input: AgreementInput, accepted: boolean, prompt: string): Promise<WorkgraphRun> {
    const run = await this.load();
    requirePhase(run, ["awaiting_agreement", "needs_decision"]);
    validateAgreement(input);
    if (accepted && run.phase === "awaiting_agreement" && run.discoveries.some((record) => record.state !== "completed")) {
      throw new Error("The implementation envelope cannot be approved while a discovery failed.");
    }
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
      setPhase(draft, "approved", decision.kind === "agreement"
        ? "The user approved the implementation envelope."
        : "The user approved the revised implementation envelope.");
    });
  }

  async execute(input: ExecuteInput): Promise<WorkgraphRun> {
    let run = await this.load();
    requirePhase(run, ["approved", "awaiting_assurance", "revision_required"]);
    if (!run.agreement) throw new Error("An approved implementation envelope is required.");
    const maxConcurrency = input.maxConcurrency ?? 2;
    await this.store.update((draft) => {
      if (input.nodes.length > 0) addNodes(draft, input.nodes);
      else if (!draft.nodes.some((node) => node.state === "pending")) throw new Error("No new or pending work nodes are available to execute.");
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
    if (allNodesComposed(run)) {
      const repository = await this.repositoryPromise;
      const verification = await repository.runCommands(run.agreement!.verificationCommands);
      run = await this.store.update((draft) => {
        draft.globalVerification = verification;
        const failed = verification.some((item) => item.exitCode !== 0);
        setPhase(
          draft,
          failed ? "revision_required" : "awaiting_assurance",
          failed ? "Composed-result verification failed." : "All scheduled nodes were composed and verified.",
        );
      });
      return run;
    }

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
      if (!report || !node.worktreePath || !node.branch || !node.baseCommit) {
        await this.updateNode(node.id, (draft) => {
          transitionNode(draft, "escalated");
          draft.error = "Recovery found no complete typed result. Inspect the retained worktree and child session before replacing this node.";
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
    if (allNodesComposed(run)) {
      const verification = await repository.runCommands(run.agreement?.verificationCommands ?? []);
      return this.store.update((draft) => {
        draft.globalVerification = verification;
        const failed = verification.some((item) => item.exitCode !== 0);
        setPhase(draft, failed ? "revision_required" : "awaiting_assurance", failed
          ? "Recovered composition failed composed-root verification."
          : "Recovered work was composed and verified.");
      });
    }
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

  async assure(input: AssuranceInput): Promise<WorkgraphRun> {
    const run = await this.load();
    requirePhase(run, ["awaiting_assurance"]);
    if (!run.agreement) throw new Error("An approved implementation envelope is required.");
    const assurance: AssuranceRecord = { model: input.model, state: "running" };
    await this.store.update((draft) => { draft.assurance = assurance; });
    let outcome: ChildOutcome;
    try {
      outcome = await this.runChild({
        parentSessionFile: run.parentSessionFile,
        targetCwd: run.projectRoot,
        sessionDir: join(dirname(run.statePath), "sessions", "assurance"),
        objective: assuranceObjective(run),
        mode: "assurance",
        guideModel: input.model,
        guideThinking: input.thinking,
        runId: run.runId,
        nodeId: "assurance",
        ...(input.stableEntryId !== undefined ? { stableEntryId: input.stableEntryId } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      return this.store.update((draft) => {
        draft.assurance = { ...assurance, state: "failed", error: errorMessage(error) };
        setPhase(draft, "failed", "Assurance process failed.");
      });
    }

    if (outcome.exitCode !== 0 || outcome.report?.kind !== "assurance") {
      return this.store.update((draft) => {
        draft.assurance = {
          ...assurance,
          state: "failed",
          sessionFile: outcome.sessionFile,
          usage: outcome.usage,
          error: childFailure(outcome),
        };
        setPhase(draft, "failed", "Assurance did not return a valid typed report.");
      });
    }

    const report = outcome.report;
    const envelopeChange = report.status === "escalated"
      || report.findings.some((finding) => finding.envelopeImpact !== "none");
    const requiredCorrection = report.findings.some((finding) => finding.severity === "error" || finding.severity === "blocker");
    return this.store.update((draft) => {
      draft.assurance = {
        ...assurance,
        state: report.status === "failed" ? "failed" : "completed",
        sessionFile: outcome.sessionFile,
        usage: outcome.usage,
        report,
        ...(report.status === "failed" ? { error: report.summary } : {}),
      };
      setPhase(
        draft,
        report.status === "failed" ? "failed" : envelopeChange ? "needs_decision" : requiredCorrection ? "revision_required" : "complete",
        report.status === "failed"
          ? "Assurance returned a failed terminal report."
          : envelopeChange
            ? "Assurance found a change outside the approved envelope."
            : requiredCorrection
              ? "Assurance found required corrections inside the approved envelope."
              : "Assurance accepted the composed result.",
      );
    });
  }

  private async runImplementationNode(
    run: WorkgraphRun,
    node: WorkNode,
    placement: WorktreePlacement,
    input: ExecuteInput,
  ): Promise<void> {
    let outcome: ChildOutcome;
    try {
      outcome = await this.runChild({
        parentSessionFile: run.parentSessionFile,
        targetCwd: placement.path,
        sessionDir: join(dirname(run.statePath), "sessions", "implementation"),
        objective: implementationObjective(run, node),
        mode: "implementation",
        guideModel: node.guideModel,
        guideThinking: node.guideThinking,
        executorModel: node.executorModel,
        executorThinking: node.executorThinking,
        runId: run.runId,
        nodeId: node.id,
        baseCommit: placement.baseCommit,
        allowedPaths: node.claimedPaths,
        onSessionCreated: async (sessionFile) => {
          await this.updateNode(node.id, (draft) => { draft.sessionFile = sessionFile; });
        },
        ...(input.stableEntryId !== undefined ? { stableEntryId: input.stableEntryId } : {}),
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
      if (outcome.report) draft.report = outcome.report;
    });
    if (outcome.exitCode !== 0 || !outcome.report) {
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
  ] as const;
  const missing = required.filter(([, value]) => !value.trim()).map(([name]) => name);
  if (missing.length > 0) throw new Error(`Implementation envelope fields must not be empty: ${missing.join(", ")}.`);
  if (input.verificationCommands.some((command) => !command.trim())) {
    throw new Error("Verification commands must not contain empty entries.");
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

function discoveryObjective(run: WorkgraphRun, investigation: InvestigationSpec): string {
  return [
    `Original request: ${run.request}`,
    `Investigation lens: ${investigation.lens}`,
    `Bounded question: ${investigation.objective}`,
    "Inspect only evidence needed to answer this question.",
    "Return decisive sources and identify only unknowns that could change the implementation envelope.",
  ].join("\n\n");
}

function implementationObjective(run: WorkgraphRun, node: WorkNode): string {
  return [
    `Original request: ${run.request}`,
    "Approved implementation envelope:",
    JSON.stringify(run.agreement, null, 2),
    `Branch objective: ${node.objective}`,
    `Claimed path prefixes: ${node.claimedPaths.join(", ")}`,
    `Dependencies already composed: ${node.dependencies.join(", ") || "none"}`,
    `Verification commands:\n${node.verificationCommands.map((command) => `- ${command}`).join("\n") || "- none"}`,
    "Implement the smallest complete change inside this node's ownership.",
  ].join("\n\n");
}

function assuranceObjective(run: WorkgraphRun): string {
  const composedNodes = run.nodes.map((node) => ({
    id: node.id,
    objective: node.objective,
    commit: node.commit,
    changedFiles: node.actualChangedFiles,
    verification: node.verification,
  }));
  return [
    `Original request: ${run.request}`,
    "Approved implementation envelope:",
    JSON.stringify(run.agreement, null, 2),
    `Base commit: ${run.baseCommit}`,
    `Composed commit: ${run.composedCommit}`,
    "Composed nodes and worktree evidence:",
    JSON.stringify(composedNodes, null, 2),
    "Scheduler-owned composed-root verification evidence:",
    JSON.stringify(run.globalVerification, null, 2),
    "Treat successful scheduler records as evidence that the listed commands ran in the composed repository root before assurance.",
    "Stay read-only while independently inspecting the actual repository diff and relevant behavior.",
    "Report only concrete findings that affect the accepted outcome or its verification boundary.",
  ].join("\n\n");
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
