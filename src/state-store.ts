import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  RUN_STATE_VERSION,
  type RunPhase,
  type WorkgraphRun,
} from "./types.js";

export interface NewRunInput {
  request: string;
  projectRoot: string;
  gitCommonDir: string;
  parentSessionId: string;
  parentSessionFile: string;
  baseCommit: string;
  playbook: {
    id: string;
    title: string;
    completionPredicate: string;
    steps: readonly string[];
  };
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
      parentSessionId: input.parentSessionId,
      parentSessionFile: input.parentSessionFile,
      phase: "discovery",
      baseCommit: input.baseCommit,
      composedCommit: input.baseCommit,
      createdAt: now,
      updatedAt: now,
      playbook: {
        id: input.playbook.id,
        title: input.playbook.title,
        completionPredicate: input.playbook.completionPredicate,
        steps: input.playbook.steps.map((id) => ({ id, status: "pending" })),
      },
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
    const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<WorkgraphRun>;
    if (parsed.version !== RUN_STATE_VERSION || typeof parsed.runId !== "string") {
      throw new Error(`Unsupported or invalid workgraph state: ${this.path}`);
    }
    return parsed as WorkgraphRun;
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

function makeRunId(now = new Date()): string {
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}
