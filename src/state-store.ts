import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  RUN_STATE_VERSION,
  type RunPhase,
  type WorkgraphRun,
  type OutcomeKind,
  type RunLifecycle,
  type WorkgraphControl,
  type PlanRecord,
} from "./types.js";

export interface NewRunInput {
  request: string;
  projectRoot: string;
  gitCommonDir: string;
  parentSessionId: string;
  parentSessionFile: string;
  baseCommit: string;
  outcome: {
    kind: OutcomeKind;
    statement: string;
    completionPredicate: string;
  };
  milestones?: readonly { id: string; description: string }[];
  now?: Date;
  runId?: string;
}

export class RunStateStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  static pathFor(gitCommonDir: string, runId: string): string {
    return join(gitCommonDir, "pi-workgraph", "runs", runId, "state.json");
  }

  static async create(input: NewRunInput): Promise<{ store: RunStateStore; run: WorkgraphRun }> {
    const runId = input.runId ?? makeRunId(input.now);
    const statePath = RunStateStore.pathFor(input.gitCommonDir, runId);
    const store = new RunStateStore(statePath);
    const now = (input.now ?? new Date()).toISOString();
    const run: WorkgraphRun = {
      version: RUN_STATE_VERSION,
      revision: 0,
      runId,
      request: input.request,
      projectRoot: input.projectRoot,
      gitCommonDir: input.gitCommonDir,
      statePath,
      creator: { sessionId: input.parentSessionId, sessionFile: input.parentSessionFile, createdAt: now },
      coordinator: { sessionId: input.parentSessionId, sessionFile: input.parentSessionFile, boundAt: now },
      handoffs: [],
      lifecycle: "active",
      lifecycleUpdatedAt: now,
      parentSessionId: input.parentSessionId,
      parentSessionFile: input.parentSessionFile,
      phase: "discovery",
      baseCommit: input.baseCommit,
      composedCommit: input.baseCommit,
      createdAt: now,
      updatedAt: now,
      outcome: { ...input.outcome },
      control: {
        planStatus: "absent",
        executionStatus: "idle",
        attentionStatus: "clear",
        verificationStatus: "absent",
        maxConcurrency: 2,
        updatedAt: now,
      },
      plans: [],
      attempts: [],
      resultReviews: [],
      cleanup: [],
      milestones: (input.milestones ?? []).map((milestone) => ({
        id: milestone.id,
        description: milestone.description,
        status: "pending" as const,
      })),
      discoveries: [],
      nodes: [],
      composition: [],
      humanDecisions: [],
      transitions: [],
      globalVerification: [],
    };
    await store.write(run);
    return { store, run };
  }

  async load(): Promise<WorkgraphRun> {
    const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<WorkgraphRun> & { version?: number };
    if (typeof parsed.runId !== "string") throw new Error(`Unsupported or invalid workgraph state: ${this.path}`);
    const migrated = migrateRun(parsed);
    if (migrated.version !== parsed.version) await this.write(migrated);
    return migrated;
  }

  async update(mutator: (draft: WorkgraphRun) => void | Promise<void>): Promise<WorkgraphRun> {
    const operation = this.queue.then(async () => {
      const current = await this.load();
      const draft = structuredClone(current);
      await mutator(draft);
      draft.revision = current.revision + 1;
      draft.updatedAt = new Date().toISOString();
      await this.write(draft);
      return draft;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async transition(to: RunPhase, reason: string): Promise<WorkgraphRun> {
    return this.update((run) => {
      if (run.phase === to) return;
      run.transitions.push({
        sequence: run.transitions.length + 1,
        at: new Date().toISOString(),
        from: run.phase,
        to,
        reason,
      });
      run.phase = to;
    });
  }

  private async write(run: WorkgraphRun): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(run, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.path);
  }
}

function migrateRun(parsed: Partial<WorkgraphRun> & { version?: number }): WorkgraphRun {
  const version = (parsed as { version?: number }).version;
  if (version !== 3 && version !== 4 && version !== 5 && version !== 6 && version !== RUN_STATE_VERSION) {
    throw new Error(`Unsupported workgraph state version ${String(version)}: ${parsed.runId}`);
  }
  if (version === RUN_STATE_VERSION && parsed.resultReviews && parsed.cleanup) return parsed as WorkgraphRun;
  const createdAt = parsed.createdAt ?? new Date(0).toISOString();
  const updatedAt = parsed.updatedAt ?? createdAt;
  const legacy = parsed as Partial<WorkgraphRun> & { parentSessionId?: string; parentSessionFile?: string };
  const sessionId = legacy.parentSessionId ?? "unknown-session";
  const sessionFile = legacy.parentSessionFile ?? "";
  const lifecycle: RunLifecycle = version === 4 && parsed.lifecycle ? parsed.lifecycle : parsed.phase === "complete" ? "completed" : "active";
  const approvedAt = parsed.agreement?.approvedAt;
  const plans: PlanRecord[] = parsed.agreement ? [{
    version: 1,
    status: "approved",
    changeKind: "initial",
    agreement: agreementDraft(parsed.agreement),
    summary: parsed.agreementProposalText ?? parsed.agreement.outcome,
    proposedAt: approvedAt ?? createdAt,
    ...(approvedAt ? { approvedAt } : {}),
  }] : [];
  if (parsed.agreementProposal) {
    plans.push({
      version: plans.length + 1,
      status: "proposed",
      changeKind: parsed.agreement ? "authority" : "initial",
      agreement: { ...parsed.agreementProposal },
      summary: parsed.agreementProposalText ?? parsed.agreementProposal.outcome,
      proposedAt: updatedAt,
    });
  }
  const control = migratedControl(parsed, plans, lifecycle, updatedAt);
  return {
    ...(parsed as WorkgraphRun),
    version: RUN_STATE_VERSION,
    creator: parsed.creator ?? { sessionId, sessionFile, createdAt },
    coordinator: parsed.coordinator ?? { sessionId, sessionFile, boundAt: createdAt },
    handoffs: parsed.handoffs ?? [],
    lifecycle,
    lifecycleUpdatedAt: parsed.lifecycleUpdatedAt ?? updatedAt,
    control,
    plans,
    attempts: (parsed.attempts ?? []).map((attempt) => ({
      ...attempt,
      mode: attempt.mode ?? "implementation",
    })),
    resultReviews: parsed.resultReviews ?? [],
    cleanup: parsed.cleanup ?? [],
  };
}

function agreementDraft(agreement: NonNullable<Partial<WorkgraphRun>["agreement"]>): PlanRecord["agreement"] {
  const { approvedAt: _approvedAt, ...draft } = agreement;
  return draft;
}

function migratedControl(parsed: Partial<WorkgraphRun>, plans: PlanRecord[], lifecycle: RunLifecycle, updatedAt: string): WorkgraphControl {
  const phase = parsed.phase;
  const verification = parsed.productVerification?.state;
  return {
    planStatus: plans.at(-1)?.status ?? "absent",
    ...(plans.length > 0 ? { currentPlanVersion: plans.at(-1)!.version } : {}),
    executionStatus: lifecycle === "suspended" ? "paused" : phase === "executing" ? "running" : "idle",
    attentionStatus: phase === "needs_decision" ? "decision_required" : phase === "revision_required" || phase === "failed" ? "failed" : "clear",
    verificationStatus: verification === "running" ? "running" : verification === "completed" ? "passed" : verification === "failed" ? "failed" : verification === "inconclusive" ? "inconclusive" : "absent",
    maxConcurrency: 2,
    updatedAt,
  };
}

function makeRunId(now = new Date()): string {
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}
