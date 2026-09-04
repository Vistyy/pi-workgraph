import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { validateSynthesis, WorkgraphEngine, type ScheduleInput } from "./engine.js";
import type { WorktreePlacement } from "./git.js";
import { herdrAgentName, type HerdrObservation, type VisibleWorkerRuntime } from "./herdr.js";
import { forkSession, readTerminalText, readWorkgraphReportResult } from "./pi-process.js";
import { allNodesComposed, claimsOverlap, readyWave, transitionNode } from "./scheduler.js";
import { UnsupportedWorkgraphStateVersionError } from "./state-store.js";
import type { AssuranceReviewReport, AssuranceSynthesisReport, CleanupState, CoordinatorBoundaryKind, CoordinatorWakeRecord, DiscoveryReport, ImplementationReport, VerificationReport, WorkAttempt, WorkerIdentity, WorkNode, WorkgraphRun, WorkerMode, ResourceCleanupRecord } from "./types.js";

export interface SupervisorWake {
  kick(): void;
}

export async function persistSchedule(engine: WorkgraphEngine, input: ScheduleInput, supervisor: SupervisorWake): Promise<WorkgraphRun> {
  const run = await engine.schedule(input);
  supervisor.kick();
  return run;
}

export interface SupervisorOptions {
  workspaceId?: string;
  pollIntervalMs?: number;
  stableEntryId?: string | null;
  onRun?: (run: WorkgraphRun) => void;
  onCoordinatorWake?: (wake: CoordinatorWakeRecord, run: WorkgraphRun) => void | Promise<void>;
  onError?: (error: Error) => void;
}

export class WorkgraphSupervisor {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private controller = new AbortController();
  private stopped = false;
  private retryFailedWakeup = true;

  constructor(
    readonly engine: WorkgraphEngine,
    readonly runtime: VisibleWorkerRuntime,
    readonly options: SupervisorOptions = {},
  ) {}

  start(): void {
    this.stopped = false;
    if (this.controller.signal.aborted) this.controller = new AbortController();
    if (!this.timer) {
      this.timer = setInterval(() => this.kick(), this.options.pollIntervalMs ?? 2_000);
      this.timer.unref();
    }
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    this.controller.abort("Supervisor stopped without interrupting visible workers.");
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async shutdown(): Promise<void> {
    this.stop();
    await this.active;
  }

  kick(): void {
    if (this.stopped || this.active) return;
    this.active = this.exclusively(() => this.reconcileCycle())
      .then((run) => { this.options.onRun?.(run); })
      .catch(async (error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.reportError(normalized);
        if (isForwardStateError(normalized)) this.stop();
        try { await this.recordSupervisorError(normalized); } catch {}
      })
      .finally(() => { this.active = undefined; });
  }

  async reconcileNow(): Promise<WorkgraphRun> {
    return this.exclusively(() => this.reconcileCycle());
  }

  async cleanupNow(): Promise<WorkgraphRun> {
    return this.exclusively(() => this.reconcileCleanupOnly());
  }

  private exclusively<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async reconcileCycle(): Promise<WorkgraphRun> {
    const run = await this.reconcileAndAdvance();
    return this.notifyCoordinatorBoundary(run);
  }

  private async reconcileCleanupOnly(): Promise<WorkgraphRun> {
    let run = await this.engine.load();
    await this.ensureCleanupIntents(run);
    run = await this.engine.load();
    await this.processCleanup(run);
    return this.engine.load();
  }

  private async reconcileAndAdvance(): Promise<WorkgraphRun> {
    this.engine.heartbeatLease();
    let run = await this.engine.load();
    if (run.lifecycle === "suspended" || run.lifecycle === "archived") return run;

    await this.reconcileAttempts(run);
    run = await this.engine.load();
    await this.composeCompleted(run);
    run = await this.engine.load();
    await this.ensureCleanupIntents(run);
    run = await this.engine.load();
    await this.processCleanup(run);
    run = await this.engine.load();
    if (run.lifecycle !== "active") return run;
    await this.updateDrainState(run);
    run = await this.engine.load();

    if (run.control.executionStatus === "scheduled" || run.control.executionStatus === "running") {
      await this.startReadyAttempts(run);
    }
    return this.engine.load();
  }

  private async reconcileAttempts(run: WorkgraphRun): Promise<void> {
    const active = run.attempts.filter((attempt) => attempt.state === "starting" || attempt.state === "running" || attempt.state === "settling" || attempt.state === "cancel_requested");
    for (const attempt of active) {
      if (attempt.state === "cancel_requested") {
        await this.cancelAttempt(attempt);
        continue;
      }
      if (!attempt.worker) {
        let recovered: HerdrObservation | undefined;
        if (this.runtime.recover && attempt.agentName && attempt.sessionFile && attempt.worktreePath) {
          try {
            recovered = await this.runtime.recover({
              workspaceId: this.options.workspaceId ?? "",
              agentName: attempt.agentName,
              sessionFile: attempt.sessionFile,
              cwd: attempt.worktreePath,
            });
          } catch (error) {
            await this.recordObservationFailure(attempt.id, error);
            continue;
          }
        }
        if (recovered) {
          await this.recordIdentity(attempt.id, recovered.identity);
          await this.consumeObservation(attempt, recovered);
          continue;
        }
        await this.recordMissingIdentity(attempt.id);
        continue;
      }
      try {
        const observation = await this.runtime.observe(attempt.worker);
        await this.consumeObservation(attempt, observation);
      } catch (error) {
        await this.recordObservationFailure(attempt.id, error);
      }
    }
  }

  private async consumeObservation(attempt: WorkAttempt, observation: HerdrObservation): Promise<void> {
    await this.recordObservation(attempt.id, observation);
    const reportResult = readWorkgraphReportResult(observation.identity.sessionFile);
    const report = reportResult.report;
    if (report && report.kind === (attempt.mode ?? "implementation") && (observation.status === "idle" || observation.status === "done")) {
      if (attempt.mode === "implementation" || !attempt.mode) await this.settleTypedAttempt(attempt.id, report as ImplementationReport);
      else await this.settleObserverAttempt(attempt.id, report as DiscoveryReport | VerificationReport | AssuranceReviewReport | AssuranceSynthesisReport);
      return;
    }
    if (observation.status === "idle" || observation.status === "done") {
      if (reportResult.invalid) await this.settleInvalidAttempt(attempt.id);
      else await this.settleUntypedAttempt(attempt.id, readTerminalText(observation.identity.sessionFile));
    }
  }

  private async recordMissingIdentity(attemptId: string): Promise<void> {
    await this.engine.store.update((draft) => {
      const current = draft.attempts.find((candidate) => candidate.id === attemptId);
      if (!current || current.worker || (current.state !== "starting" && current.state !== "running" && current.state !== "settling")) return;
      const attention = "Worker launch identity is incomplete; retained resources require reconciliation before retry.";
      if (current.stage === "attention" && current.attention === attention && draft.control.attentionStatus === "decision_required") return;
      current.stage = "attention";
      current.attention = attention;
      current.lastActivityAt = new Date().toISOString();
      draft.control.attentionStatus = "decision_required";
      draft.control.updatedAt = current.lastActivityAt;
    });
  }

  private async startReadyAttempts(run: WorkgraphRun): Promise<void> {
    if (!this.runtime.available || !this.options.workspaceId) {
      await this.engine.store.update((draft) => {
        draft.control.executionStatus = "paused";
        draft.control.attentionStatus = "blocked";
        draft.control.pauseReason = "Visible Herdr execution is unavailable. No headless fallback was started.";
        draft.control.updatedAt = new Date().toISOString();
      });
      return;
    }
    const activeCount = run.attempts.filter((attempt) => isActiveAttempt(attempt)).length;
    let capacity = Math.max(0, run.control.maxConcurrency - activeCount);
    if (capacity === 0) return;
    const runningNodes = run.nodes.filter((node) => node.state === "running");
    const ready = readyWave(run, capacity).filter((candidate) => !runningNodes.some((running) => claimsOverlap(candidate.claimedPaths, running.claimedPaths)));
    for (const node of ready) {
      await this.claimAndLaunch(node.id);
      capacity -= 1;
      if (capacity === 0) return;
    }
    const latest = await this.engine.load();
    const queued = latest.attempts.filter((attempt) => attempt.state === "queued").slice(0, capacity);
    for (const attempt of queued) await this.launchQueuedAttempt(attempt);
  }

  private async launchQueuedAttempt(attempt: WorkAttempt): Promise<void> {
    const run = await this.engine.load();
    const current = run.attempts.find((candidate) => candidate.id === attempt.id);
    if (!current || current.state !== "queued" || !current.mode || current.mode === "implementation") return;
    let liveLaunchAttempted = false;
    try {
      const repository = await this.engine.repository();
      const placement = await repository.createWorktree(run.runId, `observer-${current.nodeId}-${current.id.slice(0, 8)}`, run.composedCommit);
      const sessionFile = await forkSession({
        parentSessionFile: current.parentSessionFile ?? run.parentSessionFile,
        targetCwd: placement.path,
        sessionDir: join(dirname(run.statePath), "sessions", current.mode),
        objective: current.objective ?? `Complete the ${current.mode} Workgraph objective.`,
        mode: current.mode,
        runId: run.runId,
        nodeId: current.nodeId,
        ...(current.stableEntryId !== undefined ? { stableEntryId: current.stableEntryId } : {}),
      });
      await this.engine.store.update((draft) => {
        const retained = requiredAttempt(draft, current.id);
        if (retained.state !== "queued") return;
        retained.state = "starting";
        retained.stage = "starting";
        retained.worktreePath = placement.path;
        retained.branch = placement.branch;
        retained.baseCommit = placement.baseCommit;
        retained.sessionFile = sessionFile;
        retained.lastActivityAt = new Date().toISOString();
        if (retained.mode === "discovery") {
          const record = draft.discoveries.find((candidate) => candidate.attemptId === retained.id);
          if (record) record.sessionFile = sessionFile;
        } else if (retained.mode === "verification") {
          if (draft.productVerification?.attemptId === retained.id) draft.productVerification.sessionFile = sessionFile;
        } else if (retained.mode === "assurance_review") {
          const review = draft.assurance?.reviews.find((candidate) => candidate.attemptId === retained.id);
          if (review) review.sessionFile = sessionFile;
        } else if (retained.mode === "assurance_synthesis") {
          if (draft.assurance?.synthesis?.attemptId === retained.id) draft.assurance.synthesis.sessionFile = sessionFile;
        }
      });
      liveLaunchAttempted = true;
      const observation = await this.runtime.launch({
        workspaceId: this.options.workspaceId!,
        runId: run.runId,
        nodeId: current.nodeId,
        attemptId: current.id,
        cwd: placement.path,
        sessionFile,
        prompt: "Continue the assigned Workgraph objective now.",
        ...(current.model ? { model: current.model } : {}),
        ...(current.thinking ? { thinking: current.thinking } : {}),
        env: observerEnvironment(run, current, placement),
        onIdentity: async (identity) => this.recordIdentity(current.id, identity),
      });
      await this.recordObservation(current.id, observation);
    } catch (error) {
      await this.recordLaunchFailure(current.id, error, liveLaunchAttempted);
    }
  }

  private async claimAndLaunch(nodeId: string): Promise<void> {
    const attemptId = randomUUID();
    let claimed: { run: WorkgraphRun; node: WorkNode; attempt: WorkAttempt } | undefined;
    await this.engine.store.update((draft) => {
      if (draft.lifecycle !== "active" || (draft.control.executionStatus !== "scheduled" && draft.control.executionStatus !== "running")) return;
      const node = draft.nodes.find((candidate) => candidate.id === nodeId);
      if (!node || node.state !== "pending") return;
      const eligible = readyWave(draft, draft.control.maxConcurrency).some((candidate) => candidate.id === nodeId);
      if (!eligible) return;
      const now = new Date().toISOString();
      const attempt: WorkAttempt = {
        id: attemptId,
        nodeId,
        planVersion: node.planVersion ?? draft.control.currentPlanVersion ?? 0,
        state: "starting",
        stage: "allocating",
        runtimeMode: "herdr",
        createdAt: now,
        lastActivityAt: now,
        mode: "implementation",
        baseCommit: draft.composedCommit,
        parentSessionFile: draft.coordinator.sessionFile,
        objective: implementationObjective(draft, node),
        model: node.guideModel,
        thinking: node.guideThinking,
        executorModel: node.executorModel,
        executorThinking: node.executorThinking,
        agentName: herdrAgentName(draft.runId, nodeId, attemptId),
      };
      transitionNode(node, "running");
      node.activeAttemptId = attemptId;
      draft.attempts.push(attempt);
      draft.control.executionStatus = "running";
      draft.control.updatedAt = now;
      claimed = { run: structuredClone(draft), node: structuredClone(node), attempt: structuredClone(attempt) };
    });
    if (!claimed) return;

    const { run, node, attempt } = claimed;
    let liveLaunchAttempted = false;
    try {
      const repository = await this.engine.repository();
      const placement = await repository.createWorktree(run.runId, node.id, attempt.baseCommit!);
      const sessionFile = await forkSession({
        parentSessionFile: run.coordinator.sessionFile,
        targetCwd: placement.path,
        sessionDir: join(dirname(run.statePath), "sessions", "implementation"),
        objective: implementationObjective(run, node),
        mode: "implementation",
        runId: run.runId,
        nodeId: node.id,
        ...(this.options.stableEntryId !== undefined ? { stableEntryId: this.options.stableEntryId } : {}),
      });
      await this.engine.store.update((draft) => {
        const current = requiredAttempt(draft, attempt.id);
        current.worktreePath = placement.path;
        current.branch = placement.branch;
        current.baseCommit = placement.baseCommit;
        current.sessionFile = sessionFile;
        current.stage = "starting";
        current.lastActivityAt = new Date().toISOString();
        const currentNode = requiredNode(draft, node.id);
        currentNode.worktreePath = placement.path;
        currentNode.branch = placement.branch;
        currentNode.baseCommit = placement.baseCommit;
        currentNode.sessionFile = sessionFile;
      });
      liveLaunchAttempted = true;
      const observation = await this.runtime.launch({
        workspaceId: this.options.workspaceId!,
        runId: run.runId,
        nodeId: node.id,
        attemptId: attempt.id,
        cwd: placement.path,
        sessionFile,
        prompt: "Continue the assigned Workgraph objective now.",
        ...(node.guideModel ? { model: node.guideModel } : {}),
        ...(node.guideThinking ? { thinking: node.guideThinking } : {}),
        env: workerEnvironment(run, node, placement),
        onIdentity: async (identity) => this.recordIdentity(attempt.id, identity),
      });
      await this.recordObservation(attempt.id, observation);
    } catch (error) {
      await this.recordLaunchFailure(attempt.id, error, liveLaunchAttempted);
    }
  }

  private async settleObserverAttempt(
    attemptId: string,
    report: DiscoveryReport | VerificationReport | AssuranceReviewReport | AssuranceSynthesisReport,
  ): Promise<void> {
    const run = await this.engine.load();
    const attempt = run.attempts.find((candidate) => candidate.id === attemptId);
    if (!attempt || !attempt.mode || attempt.mode === "implementation" || !attempt.worktreePath || !attempt.baseCommit) return;
    try {
      if (attempt.mode === "assurance_review" && report.kind === "assurance_review" && report.responsibility !== attempt.responsibility) throw new Error("Assurance report responsibility does not match the scheduled attempt.");
      if (attempt.mode === "assurance_synthesis" && report.kind === "assurance_synthesis" && run.assurance) validateSynthesis(run.assurance.reviews, report.dispositions);
      const repository = await this.engine.repository();
      await repository.assertClean(attempt.worktreePath);
      if (await repository.head(attempt.worktreePath) !== attempt.baseCommit) throw new Error("Observer worktree HEAD changed from the exact composed revision.");
    } catch (error) {
      await this.recordAttemptFailure(attemptId, error instanceof Error ? error.message : String(error));
      return;
    }
    const now = new Date().toISOString();
    await this.engine.store.update((draft) => {
      const current = requiredAttempt(draft, attemptId);
      if (!isActiveAttempt(current)) return;
      current.state = "completed";
      current.stage = "settled";
      current.settledAt = now;
      current.lastActivityAt = now;
      if (current.mode === "discovery" && report.kind === "discovery") {
        const record = draft.discoveries.find((candidate) => candidate.attemptId === attemptId);
        if (record) {
          record.resultId ??= `${draft.runId}:discovery:${record.id}:${attemptId}`;
          record.resultKind = "typed";
          record.report = report;
          record.state = report.status === "completed" ? "completed" : report.status === "escalated" ? "review_required" : "failed";
          if (record.state !== "completed") record.error = report.summary;
          if (record.state === "completed") current.stage = "settled";
        }
      } else if (current.mode === "verification" && report.kind === "verification") {
        const verification = draft.productVerification;
        if (verification?.attemptId === attemptId) {
          verification.resultKind = "typed";
          verification.report = report;
          const envelopeChange = report.status === "escalated" || report.findings.some((finding) => finding.envelopeImpact !== "none");
          const failed = report.status === "failed" || report.verdict === "failed";
          verification.state = report.verdict === "inconclusive" ? "inconclusive" : failed ? "failed" : "completed";
          if (verification.state !== "completed") verification.error = report.summary;
          if (envelopeChange) setPhase(draft, "needs_decision", "Product verification found an envelope-changing problem.");
          else if (failed) setPhase(draft, "revision_required", "Product verification found a correction inside the approved envelope.");
          else if (verification.state === "completed") setPhase(draft, "awaiting_assurance", "Independent product verification established exact-revision evidence.");
        }
      } else if (current.mode === "assurance_review" && report.kind === "assurance_review") {
        const review = draft.assurance?.reviews.find((candidate) => candidate.attemptId === attemptId);
        if (review) {
          review.resultKind = "typed";
          review.report = report;
          review.state = report.status === "completed" ? "completed" : report.status === "escalated" ? "failed" : "failed";
          if (review.state !== "completed") review.error = report.summary;
        }
      } else if (current.mode === "assurance_synthesis" && report.kind === "assurance_synthesis") {
        const synthesis = draft.assurance?.synthesis;
        if (synthesis?.attemptId === attemptId) {
          synthesis.resultKind = "typed";
          synthesis.report = report;
          synthesis.state = report.status === "completed" && report.verdict !== "inconclusive" ? "completed" : "failed";
          if (synthesis.state === "completed") {
            if (draft.assurance) draft.assurance.state = "completed";
            setPhase(draft, "awaiting_judgment", "Assurance synthesis is ready for coordinator judgment.");
          } else synthesis.error = report.summary;
        }
      }
      draft.control.updatedAt = now;
    });
    if (attempt.mode === "discovery") await this.maybeAdvanceDiscovery();
    if (attempt.mode === "assurance_review") await this.maybeQueueAssuranceSynthesis();
    if (attempt.mode === "assurance_review" && report.kind === "assurance_review" && report.status !== "completed") await this.markAssuranceInconclusive("A visible assurance reviewer returned a non-completed report.");
    if (attempt.mode === "assurance_synthesis" && report.kind === "assurance_synthesis" && (report.status !== "completed" || report.verdict === "inconclusive")) await this.markAssuranceInconclusive("A visible assurance synthesizer returned a non-decision-ready report.");
  }

  private async maybeAdvanceDiscovery(): Promise<void> {
    const run = await this.engine.load();
    const active = run.discoveries.filter((record) => record.state !== "superseded");
    if (run.outcome.kind === "product_change" && active.length > 0 && active.every((record) => record.state === "completed" && record.report?.status === "completed")) {
      await this.engine.store.update((draft) => setPhase(draft, "awaiting_agreement", "Asynchronous discovery completed with typed reports for every active lane."));
    }
  }

  private async markAssuranceInconclusive(reason: string): Promise<void> {
    await this.engine.store.update((draft) => {
      if (draft.assurance) draft.assurance.state = "inconclusive";
      setPhase(draft, "assurance_inconclusive", reason);
      draft.control.attentionStatus = "decision_required";
      draft.control.updatedAt = new Date().toISOString();
    });
  }

  private async maybeQueueAssuranceSynthesis(): Promise<void> {
    const run = await this.engine.load();
    const assurance = run.assurance;
    if (!assurance || assurance.state !== "running" || assurance.synthesis || assurance.reviews.some((review) => review.state !== "completed" || !review.report)) return;
    await this.engine.store.update((draft) => {
      const current = draft.assurance;
      if (!current || current.synthesis || current.reviews.some((review) => review.state !== "completed" || !review.report)) return;
      const model = assurance.synthesisModel;
      if (!model) return;
      const thinking = assurance.synthesisThinking ?? "high";
      const attemptId = randomUUID();
      current.synthesis = { model, thinking, state: "running", attemptId };
      draft.attempts.push(observerAttempt(draft, { id: attemptId, nodeId: "assurance-synthesis", mode: "assurance_synthesis", model, thinking, objective: assuranceSynthesisObjective(draft), ...(assurance.stableEntryId !== undefined ? { stableEntryId: assurance.stableEntryId } : {}) }));
      draft.control.executionStatus = "scheduled";
      draft.control.updatedAt = new Date().toISOString();
    });
  }

  private async settleTypedAttempt(attemptId: string, report: ImplementationReport): Promise<void> {
    const run = await this.engine.load();
    const attempt = run.attempts.find((candidate) => candidate.id === attemptId);
    if (!attempt || (attempt.state !== "running" && attempt.state !== "starting" && attempt.state !== "settling")) return;
    const node = requiredNode(run, attempt.nodeId);
    if (report.status !== "completed") {
      await this.engine.store.update((draft) => {
        const current = requiredAttempt(draft, attemptId);
        const currentNode = requiredNode(draft, current.nodeId);
        current.state = "failed";
        current.stage = "settled";
        current.settledAt = new Date().toISOString();
        current.lastActivityAt = current.settledAt;
        current.error = report.summary;
        currentNode.report = report;
        currentNode.resultKind = "typed";
        transitionNode(currentNode, report.status === "escalated" ? "escalated" : "failed");
        delete currentNode.activeAttemptId;
        draft.control.attentionStatus = report.status === "escalated" ? "decision_required" : "failed";
        draft.control.updatedAt = current.settledAt;
      });
      return;
    }
    if (!attempt.worktreePath || !attempt.branch || !attempt.baseCommit) {
      await this.recordAttemptFailure(attemptId, "Completed report has no exact worktree placement.");
      return;
    }
    await this.engine.store.update((draft) => {
      const current = requiredAttempt(draft, attemptId);
      current.state = "settling";
      current.stage = "verifying";
      current.lastActivityAt = new Date().toISOString();
    });
    try {
      const repository = await this.engine.repository();
      const placement: WorktreePlacement = { path: attempt.worktreePath, branch: attempt.branch, baseCommit: attempt.baseCommit };
      const validated = await repository.validateWorkerCommit(placement, report.commit);
      const verification = await repository.runCommands(node.verificationCommands, attempt.worktreePath);
      if (verification.some((evidence) => evidence.exitCode !== 0)) throw new Error(`Node verification failed: ${verification.find((item) => item.exitCode !== 0)?.command}`);
      await this.engine.store.update((draft) => {
        const current = requiredAttempt(draft, attemptId);
        const currentNode = requiredNode(draft, current.nodeId);
        if (current.state === "completed") return;
        current.state = "settling";
        current.stage = "composing";
        current.lastActivityAt = new Date().toISOString();
        currentNode.report = report;
        currentNode.resultKind = "typed";
        currentNode.commit = validated.commit;
        currentNode.actualChangedFiles = validated.changedFiles;
        currentNode.verification = verification;
        transitionNode(currentNode, "completed");
      });
    } catch (error) {
      await this.recordAttemptFailure(attemptId, error instanceof Error ? error.message : String(error));
    }
  }

  private async composeCompleted(run: WorkgraphRun): Promise<void> {
    const candidates = run.nodes.filter((node) => node.state === "completed" && node.commit && node.baseCommit && node.activeAttemptId).sort((left, right) => left.id.localeCompare(right.id));
    const node = candidates[0];
    if (!node?.commit || !node.activeAttemptId) return;
    const repository = await this.engine.repository();
    try {
      const recovered = await repository.recoverComposedCandidate(
        run.composedCommit,
        candidates.map((candidate) => ({ nodeId: candidate.id, baseCommit: candidate.baseCommit!, commit: candidate.commit! })),
      );
      if (recovered) {
        const recoveredNode = requiredNode(run, recovered.nodeId);
        if (!recoveredNode.activeAttemptId) throw new Error(`Recovered node ${recovered.nodeId} has no active attempt.`);
        await this.recordComposition(recovered.nodeId, recoveredNode.activeAttemptId, recovered.sourceCommit, run.composedCommit, recovered.head);
        return;
      }
      const composedCommit = await repository.compose(node.commit, run.composedCommit);
      await this.recordComposition(node.id, node.activeAttemptId, node.commit, run.composedCommit, composedCommit);
    } catch (error) {
      const after = await this.engine.load();
      if (after.composedCommit !== run.composedCommit || after.nodes.find((candidate) => candidate.id === node.id)?.state === "composed") return;
      try {
        const recovered = await repository.recoverComposedCandidate(
          run.composedCommit,
          candidates.map((candidate) => ({ nodeId: candidate.id, baseCommit: candidate.baseCommit!, commit: candidate.commit! })),
        );
        if (recovered) {
          const recoveredNode = requiredNode(run, recovered.nodeId);
          if (!recoveredNode.activeAttemptId) throw new Error(`Recovered node ${recovered.nodeId} has no active attempt.`);
          await this.recordComposition(recovered.nodeId, recoveredNode.activeAttemptId, recovered.sourceCommit, run.composedCommit, recovered.head);
          return;
        }
      } catch {}
      await this.recordAttemptFailure(node.activeAttemptId, error instanceof Error ? error.message : String(error));
    }
  }

  private async recordComposition(nodeId: string, attemptId: string, sourceCommit: string, beforeCommit: string, afterCommit: string): Promise<void> {
    await this.engine.store.update((draft) => {
      const currentNode = requiredNode(draft, nodeId);
      if (currentNode.state === "composed") return;
      if (currentNode.state !== "completed" || currentNode.commit !== sourceCommit || draft.composedCommit !== beforeCommit) {
        throw new Error(`Composition facts changed while composing ${nodeId}.`);
      }
      const current = requiredAttempt(draft, attemptId);
      transitionNode(currentNode, "composed");
      currentNode.composedAt = new Date().toISOString();
      delete currentNode.activeAttemptId;
      current.state = "completed";
      current.stage = "settled";
      current.settledAt = currentNode.composedAt;
      current.lastActivityAt = current.settledAt;
      draft.composedCommit = afterCommit;
      draft.composition.push({ nodeId, sourceCommit, beforeCommit, afterCommit, status: "composed", at: current.settledAt });
      draft.control.updatedAt = current.settledAt;
    });
  }

  private async cancelAttempt(attempt: WorkAttempt): Promise<void> {
    if (!attempt.worker) {
      await this.recordAttemptFailure(attempt.id, "Cancellation requires an exact retained Herdr worker identity.");
      return;
    }
    let sendInterrupt = !attempt.interruptRequestedAt;
    if (sendInterrupt) {
      await this.engine.store.update((draft) => {
        const current = requiredAttempt(draft, attempt.id);
        if (current.state !== "cancel_requested" || current.interruptRequestedAt) {
          sendInterrupt = false;
          return;
        }
        current.interruptRequestedAt = new Date().toISOString();
        current.lastActivityAt = current.interruptRequestedAt;
        current.attention = "Interrupt requested; awaiting a verified non-working Herdr observation.";
        draft.control.updatedAt = current.interruptRequestedAt;
      });
    }
    try {
      const observation = sendInterrupt
        ? await this.runtime.interrupt(attempt.worker)
        : await this.runtime.observe(attempt.worker);
      await this.recordCancellationObservation(attempt.id, observation);
    } catch (error) {
      await this.recordObservationFailure(attempt.id, error);
    }
  }

  private async recordCancellationObservation(attemptId: string, observation: HerdrObservation): Promise<void> {
    await this.engine.store.update((draft) => {
      const current = requiredAttempt(draft, attemptId);
      if (current.state !== "cancel_requested") return;
      assertSameWorker(current.worker, observation.identity);
      current.observedStatus = observation.status;
      current.lastActivityAt = observation.observedAt;
      current.heartbeatAt = observation.observedAt;
      if (observation.status === "idle" || observation.status === "done") {
        current.state = "cancelled";
        current.stage = "settled";
        current.settledAt = observation.observedAt;
        delete current.attention;
        const node = draft.nodes.find((candidate) => candidate.id === current.nodeId);
        if (node) {
          if (node.state === "running") transitionNode(node, "cancelled");
          delete node.activeAttemptId;
        }
        const otherAttention = draft.attempts.some((candidate) => candidate.id !== current.id && candidate.stage === "attention" && candidate.state !== "completed" && candidate.state !== "cancelled" && candidate.state !== "failed");
        if (!otherAttention && !draft.nodes.some((candidate) => candidate.state === "failed" || candidate.state === "escalated")) {
          draft.control.attentionStatus = "clear";
        }
        draft.control.updatedAt = observation.observedAt;
        return;
      }
      current.stage = "attention";
      current.attention = observation.status === "working"
        ? "Interrupt was requested once; the worker still reports working."
        : observation.status === "blocked"
          ? "Interrupt was requested once; the worker reports blocked and requires attention."
          : "Interrupt was requested once; the worker status is unknown and requires reconciliation.";
      draft.control.attentionStatus = observation.status === "unknown" ? "decision_required" : "blocked";
      draft.control.updatedAt = observation.observedAt;
    });
  }

  private async ensureCleanupIntents(run: WorkgraphRun): Promise<void> {
    const settled = run.attempts.filter((attempt) => !isActiveAttempt(attempt) && attempt.worktreePath && attempt.branch && attempt.baseCommit);
    if (settled.length === 0) return;
    await this.engine.store.update((draft) => {
      const cleanup = draft.cleanup ??= [];
      for (const attempt of settled) {
        const current = draft.attempts.find((candidate) => candidate.id === attempt.id);
        if (!current?.worktreePath || !current.branch || !current.baseCommit) continue;
        const node = draft.nodes.find((candidate) => candidate.id === current.nodeId);
        const expectedHead = node?.commit ?? current.baseCommit;
        if (!cleanup.some((record) => record.attemptId === current.id && record.kind === "git_worktree")) {
          cleanup.push({ id: `${current.id}:git`, attemptId: current.id, kind: "git_worktree", state: "pending", requestedAt: new Date().toISOString(), path: current.worktreePath, branch: current.branch, expectedHead });
        }
        if (current.worker && !cleanup.some((record) => record.attemptId === current.id && record.kind === "herdr_worker")) {
          cleanup.push({ id: `${current.id}:herdr`, attemptId: current.id, kind: "herdr_worker", state: "pending", requestedAt: new Date().toISOString(), identity: { ...current.worker } });
        }
      }
    });
  }

  private async processCleanup(run: WorkgraphRun): Promise<void> {
    const ordered = [...(run.cleanup ?? [])].sort((left, right) => {
      if (left.attemptId !== right.attemptId) return left.requestedAt.localeCompare(right.requestedAt);
      return cleanupPriority(left) - cleanupPriority(right);
    });
    for (const original of ordered) {
      const latest = await this.engine.load();
      const record = (latest.cleanup ?? []).find((candidate) => candidate.id === original.id);
      if (!record || record.state === "completed") continue;
      try {
        if (record.kind === "herdr_worker") {
          const gitRecord = (latest.cleanup ?? []).find((candidate) => candidate.attemptId === record.attemptId && candidate.kind === "git_worktree");
          const cleanup = gitRecord?.state === "completed" ? this.runtime.cleanupDeletedWorktree : this.runtime.cleanup;
          if (!cleanup) {
            await this.recordCleanup(record.id, "blocked", "Herdr runtime does not provide exact worker cleanup.");
            continue;
          }
          const result = await cleanup.call(this.runtime, record.identity);
          await this.recordCleanup(record.id, result.state, result.detail);
          continue;
        }
        const herdrRecord = (latest.cleanup ?? []).find((candidate) => candidate.attemptId === record.attemptId && candidate.kind === "herdr_worker");
        if (herdrRecord && herdrRecord.state !== "completed") continue;
        const result = await (await this.engine.repository()).cleanupWorktree({ path: record.path, branch: record.branch, baseCommit: record.expectedHead }, record.expectedHead);
        await this.recordCleanup(record.id, result.state, result.detail);
      } catch (error) {
        await this.recordCleanup(record.id, "blocked", errorMessage(error));
      }
    }
  }

  private async recordCleanup(id: string, state: CleanupState, detail: string): Promise<void> {
    await this.engine.store.update((draft) => {
      const record = (draft.cleanup ?? []).find((candidate) => candidate.id === id);
      if (!record) return;
      record.state = state;
      record.inspectedAt = new Date().toISOString();
      record.detail = detail;
      if (state === "blocked") record.error = detail;
      else if (state === "completed") { delete record.error; record.completedAt = record.inspectedAt; }
      else { delete record.error; delete record.completedAt; }
      draft.control.updatedAt = record.inspectedAt;
      if (state === "blocked") draft.control.attentionStatus = "decision_required";
      else if (state === "completed" && (
        draft.control.attentionStatus === "decision_required"
        && !(draft.cleanup ?? []).some((candidate) => candidate.state === "blocked")
        && !draft.nodes.some((node) => node.state === "failed" || node.state === "escalated")
        && draft.phase !== "needs_decision"
        && draft.phase !== "revision_required"
        && draft.phase !== "assurance_inconclusive"
      )) draft.control.attentionStatus = "clear";
    });
  }

  private async updateDrainState(run: WorkgraphRun): Promise<void> {
    const active = run.attempts.some((attempt) => attempt.state === "starting" || attempt.state === "running" || attempt.state === "settling" || attempt.state === "cancel_requested");
    const pending = run.nodes.some((node) => node.state === "pending") || run.attempts.some((attempt) => attempt.state === "queued");
    let executionStatus = run.control.executionStatus;
    if (executionStatus === "draining" && !active) executionStatus = "paused";
    else if (!active && !pending) executionStatus = "idle";
    else if (active && executionStatus === "scheduled") executionStatus = "running";
    const attentionStatus = run.nodes.some((node) => node.state === "escalated")
      ? "decision_required"
      : run.nodes.some((node) => node.state === "failed")
        ? "failed"
        : run.control.attentionStatus;
    if (executionStatus === run.control.executionStatus && attentionStatus === run.control.attentionStatus) return;
    await this.engine.store.update((draft) => {
      draft.control.executionStatus = executionStatus;
      draft.control.attentionStatus = attentionStatus;
      draft.control.updatedAt = new Date().toISOString();
    });
  }

  private async recordIdentity(attemptId: string, identity: WorkerIdentity): Promise<void> {
    await this.engine.store.update((draft) => {
      const current = requiredAttempt(draft, attemptId);
      if (current.worker) assertSameWorker(current.worker, identity);
      current.worker = { ...identity };
      current.agentName = identity.agentName;
      current.sessionFile = identity.sessionFile;
      current.state = "running";
      current.stage = "executing";
      current.startedAt ??= new Date().toISOString();
      current.lastActivityAt = current.startedAt;
      current.heartbeatAt = current.startedAt;
    });
  }

  private async recordObservation(attemptId: string, observation: HerdrObservation): Promise<void> {
    await this.engine.store.update((draft) => {
      const current = requiredAttempt(draft, attemptId);
      assertSameWorker(current.worker, observation.identity);
      current.worker = { ...observation.identity };
      if (current.state === "starting") current.state = "running";
      current.stage = observation.stage;
      current.lastActivityAt = observation.observedAt;
      current.heartbeatAt = observation.observedAt;
      current.observedStatus = observation.status;
      if (observation.status === "blocked") {
        current.attention = "Herdr reports that the worker is blocked.";
        draft.control.attentionStatus = "blocked";
      }
    });
  }

  private async settleInvalidAttempt(attemptId: string): Promise<void> {
    await this.engine.store.update((draft) => {
      const current = requiredAttempt(draft, attemptId);
      if (current.state !== "running" && current.state !== "starting") return;
      const attention = "Worker returned an invalid Workgraph report; retained output requires explicit review.";
      current.state = "completed";
      current.stage = "attention";
      current.attention = attention;
      current.resultKind = "invalid";
      current.settledAt = new Date().toISOString();
      current.lastActivityAt = current.settledAt;
      const record = draft.discoveries.find((candidate) => candidate.attemptId === attemptId);
      if (record) { record.resultId ??= `${draft.runId}:discovery:${record.id}:${attemptId}`; record.resultKind = "invalid"; record.state = "review_required"; record.error = attention; }
      draft.control.attentionStatus = "decision_required";
      draft.control.updatedAt = current.lastActivityAt;
    });
  }

  private async settleUntypedAttempt(attemptId: string, terminalText?: string): Promise<void> {
    await this.engine.store.update((draft) => {
      const current = requiredAttempt(draft, attemptId);
      if (current.state !== "running" && current.state !== "starting") return;
      const attention = terminalText ? "Worker returned terminal prose without a typed report." : "Herdr observed a settled-looking worker without a typed report.";
      if (current.stage === "attention" && current.attention === attention && draft.control.attentionStatus === "decision_required") return;
      current.state = "completed";
      current.stage = "attention";
      current.attention = attention;
      current.settledAt = new Date().toISOString();
      current.lastActivityAt = current.settledAt;
      if ((current.mode ?? "implementation") === "implementation") {
        const node = requiredNode(draft, current.nodeId);
        node.resultKind = terminalText ? "untyped" : "absent";
        if (terminalText) node.terminalText = terminalText;
      } else if (current.mode === "discovery") {
        const record = draft.discoveries.find((candidate) => candidate.attemptId === attemptId);
        if (record) { record.resultId ??= `${draft.runId}:discovery:${record.id}:${attemptId}`; record.resultKind = terminalText ? "untyped" : "absent"; if (terminalText) record.terminalText = terminalText; record.state = "review_required"; record.error = attention; }
      } else if (current.mode === "verification") {
        const verification = draft.productVerification;
        if (verification?.attemptId === attemptId) { verification.resultKind = terminalText ? "untyped" : "absent"; if (terminalText) verification.terminalText = terminalText; verification.state = "inconclusive"; verification.error = attention; }
      } else if (current.mode === "assurance_review") {
        const review = draft.assurance?.reviews.find((candidate) => candidate.attemptId === attemptId);
        if (review) { review.resultKind = terminalText ? "untyped" : "absent"; if (terminalText) review.terminalText = terminalText; review.state = "failed"; review.error = attention; }
      } else if (current.mode === "assurance_synthesis") {
        const synthesis = draft.assurance?.synthesis;
        if (synthesis?.attemptId === attemptId) { synthesis.resultKind = terminalText ? "untyped" : "absent"; if (terminalText) synthesis.terminalText = terminalText; synthesis.state = "failed"; synthesis.error = attention; }
      }
      draft.control.attentionStatus = "decision_required";
      draft.control.updatedAt = current.lastActivityAt;
    });
  }

  private async recordLaunchFailure(attemptId: string, error: unknown, uncertainLiveLaunch: boolean): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.engine.store.update((draft) => {
      const current = requiredAttempt(draft, attemptId);
      current.lastActivityAt = new Date().toISOString();
      current.error = message;
      current.stage = "attention";
      if (!current.worker && !uncertainLiveLaunch) {
        current.state = "failed";
        current.settledAt = current.lastActivityAt;
        const node = draft.nodes.find((candidate) => candidate.id === current.nodeId);
        if (node) {
          if (node.state === "running") transitionNode(node, "failed");
          delete node.activeAttemptId;
        } else markObserverFailure(draft, current, message);
      }
      draft.control.attentionStatus = current.worker || uncertainLiveLaunch ? "decision_required" : "failed";
      draft.control.updatedAt = current.lastActivityAt;
    });
  }

  private async recordAttemptFailure(attemptId: string, message: string): Promise<void> {
    await this.engine.store.update((draft) => {
      const current = requiredAttempt(draft, attemptId);
      if (current.state === "completed") return;
      current.state = "failed";
      current.stage = "settled";
      current.error = message;
      current.settledAt = new Date().toISOString();
      current.lastActivityAt = current.settledAt;
      const node = draft.nodes.find((candidate) => candidate.id === current.nodeId);
      if (node) {
        node.error = message;
        if (node.state === "running" || node.state === "completed") transitionNode(node, "failed");
        delete node.activeAttemptId;
      } else if (current.mode === "discovery") {
        const record = draft.discoveries.find((candidate) => candidate.attemptId === attemptId);
        if (record) { record.state = "failed"; record.error = message; }
      } else if (current.mode === "verification") {
        const verification = draft.productVerification;
        if (verification?.attemptId === attemptId) { verification.state = "inconclusive"; verification.error = message; }
      } else if (current.mode === "assurance_review") {
        const review = draft.assurance?.reviews.find((candidate) => candidate.attemptId === attemptId);
        if (review) { review.state = "failed"; review.error = message; }
      } else if (current.mode === "assurance_synthesis") {
        const synthesis = draft.assurance?.synthesis;
        if (synthesis?.attemptId === attemptId) { synthesis.state = "failed"; synthesis.error = message; }
      }
      if (current.mode === "assurance_review" || current.mode === "assurance_synthesis") {
        if (draft.assurance) draft.assurance.state = "inconclusive";
        setPhase(draft, "assurance_inconclusive", "A visible assurance worker failed before producing decision-ready evidence.");
      }
      draft.control.attentionStatus = "failed";
      draft.control.updatedAt = current.settledAt;
    });
  }

  private async recordObservationFailure(attemptId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.engine.store.update((draft) => {
      const current = draft.attempts.find((candidate) => candidate.id === attemptId);
      if (!current || current.state === "completed" || current.state === "cancelled") return;
      current.stage = "attention";
      current.attention = `Worker observation failed: ${message}`;
      current.lastActivityAt = new Date().toISOString();
      draft.control.attentionStatus = "decision_required";
      draft.control.updatedAt = current.lastActivityAt;
    });
  }

  private async notifyCoordinatorBoundary(run: WorkgraphRun): Promise<WorkgraphRun> {
    const boundary = coordinatorBoundary(run);
    if (!boundary || !this.options.onCoordinatorWake) return run;
    let claimed: CoordinatorWakeRecord | undefined;
    const retained = await this.engine.store.update((draft) => {
      const wakeups = draft.coordinatorWakeups ??= [];
      const previous = wakeups.find((candidate) => candidate.id === boundary.id);
      if (previous && (previous.state === "claimed" || previous.state === "delivered")) return;
      if (previous && previous.state === "failed" && !this.retryFailedWakeup) return;
      const now = new Date().toISOString();
      claimed = previous ?? {
        ...boundary,
        phase: draft.phase,
        composedCommit: draft.composedCommit,
        ...(draft.control.currentPlanVersion !== undefined ? { planVersion: draft.control.currentPlanVersion } : {}),
        state: "claimed",
        requestedAt: now,
      };
      if (previous) {
        previous.state = "claimed";
        previous.requestedAt = now;
        previous.deliveryAttempts = (previous.deliveryAttempts ?? 0) + 1;
        delete previous.error;
        claimed = previous;
      } else {
        claimed.deliveryAttempts = 1;
        wakeups.push(claimed);
      }
      this.retryFailedWakeup = false;
    });
    if (!claimed) return retained;
    try {
      await this.options.onCoordinatorWake(claimed, retained);
      return this.engine.store.update((draft) => {
        const wake = (draft.coordinatorWakeups ?? []).find((candidate) => candidate.id === claimed!.id);
        if (!wake || wake.state !== "claimed") return;
        wake.state = "delivered";
        wake.deliveredAt = new Date().toISOString();
      });
    } catch (error) {
      const message = errorMessage(error);
      this.reportError(new Error(`Coordinator wake ${claimed.id} failed: ${message}`));
      return this.engine.store.update((draft) => {
        const wake = (draft.coordinatorWakeups ?? []).find((candidate) => candidate.id === claimed!.id);
        if (!wake || wake.state !== "claimed") return;
        wake.state = "failed";
        wake.error = message;
        draft.control.attentionStatus = "decision_required";
        draft.control.updatedAt = new Date().toISOString();
      });
    }
  }

  private reportError(error: Error): void {
    try { this.options.onError?.(error); } catch {}
  }

  private async recordSupervisorError(error: Error): Promise<WorkgraphRun> {
    return this.engine.store.update((draft) => {
      draft.control.attentionStatus = "failed";
      draft.control.updatedAt = new Date().toISOString();
      draft.error = `Supervisor: ${error.message}`;
    });
  }
}

function cleanupPriority(record: ResourceCleanupRecord): number {
  return record.kind === "herdr_worker" ? 0 : 1;
}

function coordinatorBoundary(run: WorkgraphRun): Pick<CoordinatorWakeRecord, "id" | "boundaryRevision" | "kind" | "resultId" | "resultKind"> | undefined {
  if (run.lifecycle !== "active") return undefined;
  if (run.outcome.kind !== "product_change") {
    const wakeups = run.coordinatorWakeups ?? [];
    const researchResult = [...run.discoveries].reverse().find((record) => {
      if (!record.resultId || !record.resultKind) return false;
      const prior = wakeups.find((wake) => wake.resultId === record.resultId);
      return !prior || prior.state === "failed";
    });
    if (researchResult?.resultId && researchResult.resultKind) {
      const boundaryRevision = createHash("sha256").update(JSON.stringify({ resultId: researchResult.resultId, resultKind: researchResult.resultKind, state: researchResult.state, report: researchResult.report, terminalText: researchResult.terminalText, error: researchResult.error })).digest("hex").slice(0, 20);
      return { id: `result:${researchResult.resultId}:${boundaryRevision}`, boundaryRevision, kind: "result", resultId: researchResult.resultId, resultKind: researchResult.resultKind };
    }
  }
  const activeAttempt = run.attempts.some((attempt) => isActiveAttempt(attempt));
  let kind: CoordinatorBoundaryKind | undefined;
  if (run.phase === "awaiting_agreement" && !run.agreementProposal) kind = "agreement";
  else if (run.phase === "awaiting_verification" && !run.productVerification?.attemptId) kind = "verification";
  else if (run.phase === "awaiting_assurance" && run.assurance?.state !== "running") kind = "assurance";
  else if (run.phase === "awaiting_judgment") kind = "judgment";
  else if (
    run.phase === "revision_required"
    || run.phase === "needs_decision"
    || run.phase === "assurance_inconclusive"
    || run.phase === "failed"
    || run.nodes.some((node) => node.state === "failed" || node.state === "escalated")
    || (!activeAttempt && (run.productVerification?.state === "failed" || run.productVerification?.state === "inconclusive"))
    || run.attempts.some((attempt) => attempt.stage === "attention")
    || (run.cleanup ?? []).some((record) => record.state === "blocked")
  ) kind = "attention";
  else if (!activeAttempt && run.control.executionStatus === "idle" && run.control.verificationStatus === "absent" && run.phase === "executing" && allNodesComposed(run)) kind = "settle";
  if (!kind) return undefined;
  const semanticState = JSON.stringify({
    kind,
    discoveries: run.discoveries.map((record) => ({ id: record.id, resultId: record.resultId, state: record.state, resultKind: record.resultKind })),
    phase: run.phase,
    composedCommit: run.composedCommit,
    planVersion: run.control.currentPlanVersion,
    attention: run.control.attentionStatus,
    verification: run.productVerification ? { revision: run.productVerification.revision, state: run.productVerification.state } : undefined,
    assurance: run.assurance ? { revision: run.assurance.revision, state: run.assurance.state } : undefined,
    nodes: run.nodes.map((node) => [node.id, node.state]),
    attempts: run.attempts.filter((attempt) => attempt.stage === "attention").map((attempt) => [attempt.id, attempt.state, attempt.attention, attempt.error]),
    cleanup: (run.cleanup ?? []).filter((record) => record.state === "blocked").map((record) => [record.id, record.error]),
  });
  const boundaryRevision = createHash("sha256").update(semanticState).digest("hex").slice(0, 20);
  return { id: `${kind}:${boundaryRevision}`, boundaryRevision, kind };
}

function isForwardStateError(error: Error): boolean {
  return error instanceof UnsupportedWorkgraphStateVersionError;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isActiveAttempt(attempt: WorkAttempt): boolean {
  return attempt.state === "starting" || attempt.state === "running" || attempt.state === "settling" || attempt.state === "cancel_requested";
}

function observerAttempt(
  run: WorkgraphRun,
  input: { id: string; nodeId: string; mode: WorkerMode; model: string; thinking: NonNullable<WorkAttempt["thinking"]>; objective: string; stableEntryId?: string | null; responsibility?: WorkAttempt["responsibility"] },
): WorkAttempt {
  const now = new Date().toISOString();
  return {
    id: input.id,
    nodeId: input.nodeId,
    mode: input.mode,
    planVersion: run.control.currentPlanVersion ?? 0,
    state: "queued",
    stage: "queued",
    runtimeMode: "herdr",
    createdAt: now,
    lastActivityAt: now,
    baseCommit: run.composedCommit,
    parentSessionFile: run.parentSessionFile,
    objective: input.objective,
    model: input.model,
    thinking: input.thinking,
    ...(input.stableEntryId !== undefined ? { stableEntryId: input.stableEntryId } : {}),
    ...(input.responsibility ? { responsibility: input.responsibility } : {}),
    agentName: herdrAgentName(run.runId, input.nodeId, input.id),
  };
}

function markObserverFailure(run: WorkgraphRun, attempt: WorkAttempt, message: string): void {
  if (attempt.mode === "discovery") {
    const record = run.discoveries.find((candidate) => candidate.attemptId === attempt.id);
    if (record) { record.state = "failed"; record.error = message; }
  } else if (attempt.mode === "verification") {
    const verification = run.productVerification;
    if (verification?.attemptId === attempt.id) { verification.state = "inconclusive"; verification.error = message; }
  } else if (attempt.mode === "assurance_review") {
    const review = run.assurance?.reviews.find((candidate) => candidate.attemptId === attempt.id);
    if (review) { review.state = "failed"; review.error = message; }
  } else if (attempt.mode === "assurance_synthesis") {
    const synthesis = run.assurance?.synthesis;
    if (synthesis?.attemptId === attempt.id) { synthesis.state = "failed"; synthesis.error = message; }
  }
}

function observerEnvironment(run: WorkgraphRun, attempt: WorkAttempt, placement: WorktreePlacement): Record<string, string> {
  return {
    PI_WORKGRAPH_MODE: attempt.mode ?? "discovery",
    PI_WORKGRAPH_RUN_ID: run.runId,
    PI_WORKGRAPH_NODE_ID: attempt.nodeId,
    PI_WORKGRAPH_BASE_COMMIT: placement.baseCommit,
    ...(attempt.responsibility ? { PI_WORKGRAPH_RESPONSIBILITY: attempt.responsibility } : {}),
  };
}

function assuranceSynthesisObjective(run: WorkgraphRun): string {
  return [
    `Original request: ${run.request}`,
    `Exact composed revision: ${run.composedCommit}`,
    "Approved implementation envelope:",
    JSON.stringify(run.agreement, null, 2),
    "Independent responsibility reports:",
    JSON.stringify(run.assurance?.reviews.map((review) => ({ responsibility: review.responsibility, model: review.model, report: review.report })), null, 2),
    "Account for every candidate by its exact id, preserve each candidate unchanged, and propose accept or dismiss with a concise reason.",
    "Do not invent new findings.",
  ].join("\n\n");
}

function setPhase(run: WorkgraphRun, to: WorkgraphRun["phase"], reason: string): void {
  if (run.phase === to) return;
  run.transitions.push({ sequence: run.transitions.length + 1, at: new Date().toISOString(), from: run.phase, to, reason });
  run.phase = to;
}

function requiredAttempt(run: WorkgraphRun, id: string): WorkAttempt {
  const attempt = run.attempts.find((candidate) => candidate.id === id);
  if (!attempt) throw new Error(`Unknown work attempt ${id}.`);
  return attempt;
}

function requiredNode(run: WorkgraphRun, id: string): WorkNode {
  const node = run.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`Unknown work node ${id}.`);
  return node;
}

function assertSameWorker(expected: WorkerIdentity | undefined, actual: WorkerIdentity): void {
  if (!expected) throw new Error("Work attempt has no retained worker identity.");
  if (
    expected.workspaceId !== actual.workspaceId
    || expected.tabId !== actual.tabId
    || expected.paneId !== actual.paneId
    || expected.terminalId !== actual.terminalId
    || expected.agentName !== actual.agentName
    || expected.sessionFile !== actual.sessionFile
    || expected.cwd !== actual.cwd
  ) throw new Error("Live worker does not match the retained Workgraph identity.");
}

function workerEnvironment(run: WorkgraphRun, node: WorkNode, placement: WorktreePlacement): Record<string, string> {
  return {
    PI_WORKGRAPH_MODE: "implementation",
    PI_WORKGRAPH_RUN_ID: run.runId,
    PI_WORKGRAPH_NODE_ID: node.id,
    PI_WORKGRAPH_BASE_COMMIT: placement.baseCommit,
    PI_WORKGRAPH_IMPLEMENTATION_START: "guide",
    PI_WORKGRAPH_EXECUTOR_MODEL: node.executorModel,
    PI_WORKGRAPH_EXECUTOR_THINKING: node.executorThinking,
  };
}

function implementationObjective(run: WorkgraphRun, node: WorkNode): string {
  return [
    `Implement only Workgraph node ${node.id}.`,
    `Run: ${run.runId}`,
    `Plan version: ${node.planVersion ?? run.control.currentPlanVersion ?? "unknown"}`,
    `Base commit: ${run.composedCommit}`,
    `Goal: ${node.brief.goal}`,
    "Context:",
    ...node.brief.context.map((item) => `- ${item}`),
    "Acceptance:",
    ...node.brief.acceptance.map((item) => `- ${item}`),
    "Forbidden:",
    ...node.brief.forbidden.map((item) => `- ${item}`),
    `Timebox: ${node.brief.timeboxMinutes} minutes.`,
    `Report contract: ${node.brief.report}`,
    "Run the node verification commands, create exactly one direct commit, leave the worktree clean, and return workgraph_report.",
  ].join("\n");
}
