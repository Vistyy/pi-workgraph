/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date -- This focused Node test fixture drives real filesystem, Git, and lease boundaries through the runtime's Promise API. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Artifact recovery tests require the concrete Node filesystem boundary used in production.
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Disposable Git worktree fixtures require host path semantics.
import { dirname, join } from "node:path";
import { Effect, Layer } from "effect";
import { ArtifactStore } from "../src/artifact-store.js";
import { GitRepository, runProcess } from "../src/git.js";
import type {
  HerdrInspection,
  HerdrObservation,
  VisibleWorkerRuntime,
  WorkerLaunchRequest,
} from "../src/herdr.js";
import { DEFAULT_MODEL_POLICY } from "../src/model-policy.js";
import { WorkgraphRegistry } from "../src/registry.js";
import type { WorkerIdentity, WorkerReport } from "../src/types.js";
import { WorkstreamStore } from "../src/workstream.js";
import { type RuntimeOwnership, WorkstreamRuntime } from "../src/workstream-runtime.js";

const report: WorkerReport = {
  kind: "research",
  status: "completed",
  summary: "Probe completed.",
  evidence: [{ label: "probe", observation: "probe.txt was produced.", class: "direct" }],
  findings: [],
};

class ArtifactWorker implements VisibleWorkerRuntime {
  readonly available = true;
  cleanupCount = 0;

  launch(_request: WorkerLaunchRequest): Promise<HerdrObservation> {
    return Promise.reject(new Error("Prepared artifact fixtures must not launch workers."));
  }

  inspect(identity: WorkerIdentity): Promise<HerdrInspection> {
    return this.observe(identity);
  }

  observe(identity: WorkerIdentity): Promise<HerdrObservation> {
    return Promise.resolve({ identity, status: "done", observedAt: new Date().toISOString() });
  }

  interrupt(identity: WorkerIdentity): Promise<HerdrObservation> {
    return this.observe(identity);
  }

  cleanup(identity: WorkerIdentity) {
    this.cleanupCount++;
    return Promise.resolve({
      state: "completed" as const,
      identity,
      observedAt: new Date().toISOString(),
      detail: "Exact fixture worker closed.",
    });
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess("git", ["-C", cwd, ...args], { cwd, timeoutMs: 30_000 });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

export interface ArtifactFixture {
  parent: string;
  root: string;
  store: WorkstreamStore;
  registry: WorkgraphRegistry;
  repository: GitRepository;
  workers: ArtifactWorker;
  attemptId: string;
  resultId: string;
  sourceRoot: string;
  runtime(artifactStoreLayer?: Layer.Layer<ArtifactStore>): WorkstreamRuntime;
  dispose(): Promise<void>;
}

export function transformArtifactStore(
  transform: (store: ArtifactStore["Service"]) => ArtifactStore["Service"],
): Layer.Layer<ArtifactStore> {
  return Layer.effect(
    ArtifactStore,
    ArtifactStore.use((store) => Effect.succeed(ArtifactStore.of(transform(store)))),
  ).pipe(Layer.provide(ArtifactStore.layerLive));
}

export async function artifactFixture(
  options: { legacyCleanup?: "pending" | "blocked" } = {},
): Promise<ArtifactFixture> {
  const parent = await mkdtemp(join(tmpdir(), "artifact-recovery-"));
  const root = join(parent, "repo");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "fixture@example.test");
  await git(root, "config", "user.name", "Artifact fixture");
  await writeFile(join(root, ".gitignore"), "probe.txt\n");
  await writeFile(join(root, "value.txt"), "initial\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  const repository = await GitRepository.open(root);
  const owner = { sessionId: "artifact-owner", sessionFile: join(parent, "owner.jsonl") };
  await writeFile(owner.sessionFile, "");
  const { store } = await WorkstreamStore.create({
    id: "artifact-recovery",
    purpose: "Exercise exact artifact recovery boundaries.",
    projectRoot: root,
    gitCommonDir: repository.commonDir,
    coordinator: owner,
  });
  const recorded = await store.recordInputEvent({
    ...owner,
    source: "interactive",
    text: "Run and retain the bounded probe.",
  });
  await store.reviseIntent({
    authorityReceiptId: recorded.receipt.id,
    statement: "Retain probe evidence.",
    constraints: [],
  });
  const baseRevision = await repository.head();
  const attemptId = "attempt-probe";
  const resultId = `result-${attemptId}`;
  await store.enqueue(
    {
      id: "probe",
      capability: "research",
      artifactIntent: "disposable_experiment",
      objective: "Produce probe.txt.",
      intentVersion: 1,
      authority: { receiptId: recorded.receipt.id, intentVersion: 1 },
      permittedEffects: ["Write ignored probe.txt."],
      stopCondition: "One output.",
      expectedEvidence: ["probe.txt"],
      artifactPolicy: { retain: ["probe.txt"], discardOthers: true },
    },
    {
      id: attemptId,
      models: { guide: { model: "fixture/model", thinking: "off" }, source: "policy" },
      baseRevision,
    },
  );
  const placement = await repository.createWorktree("artifact-recovery", attemptId, baseRevision);
  await store.startAttempt({
    id: attemptId,
    placement: { kind: "isolated_worktree", path: placement.path, branch: placement.branch },
    baseRevision,
  });
  const sessionFile = join(parent, "worker.jsonl");
  await writeFile(sessionFile, "");
  await store.recordSessionFile(attemptId, sessionFile);
  const worker: WorkerIdentity = {
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    terminalId: "terminal-1",
    agentName: "artifact-worker",
    cwd: placement.path,
    sessionFile,
  };
  await store.recordWorker(attemptId, worker);
  await store.markSubmission(attemptId, "uncertain");
  await store.markSubmission(attemptId, "started");
  await writeFile(join(placement.path, "probe.txt"), "retained evidence\n");

  if (options.legacyCleanup === undefined) {
    const sourceRoot = await realpath(placement.path);
    const sourceIdentity = createHash("sha256")
      .update(await readFile(join(sourceRoot, ".git")))
      .digest("hex");
    await store.retainResultPendingArtifacts({
      attemptId,
      id: resultId,
      assignmentId: "probe",
      assignmentIntentVersion: 1,
      report,
      sourceRoot,
      sourceIdentity,
      expectedHead: baseRevision,
      destinationRoot: join(dirname(store.path), "artifacts", resultId),
      stagingRoot: join(dirname(store.path), "artifact-staging", resultId),
      required: ["probe.txt"],
    });
    await store.settleAttempt({ id: attemptId, resultId, effectiveModels: [] });
  } else {
    await store.retainResult({
      id: resultId,
      assignmentId: "probe",
      assignmentIntentVersion: 1,
      validity: "invalid",
      detail: "Artifact retention failed: interrupted legacy copy",
    });
    await store.settleAttempt({ id: attemptId, resultId, effectiveModels: [] });
    await store.beginCleanup({ id: attemptId, expectedHead: baseRevision, discard: false });
    if (options.legacyCleanup === "blocked")
      await store.blockCleanup(attemptId, "interrupted legacy copy");
  }

  const registry = new WorkgraphRegistry(join(parent, "registry.sqlite"));
  const workers = new ArtifactWorker();
  const runtimes: WorkstreamRuntime[] = [];
  return {
    parent,
    root,
    store,
    registry,
    repository,
    workers,
    attemptId,
    resultId,
    sourceRoot: placement.path,
    runtime(artifactStoreLayer) {
      const ownership: RuntimeOwnership = { registry, policy: DEFAULT_MODEL_POLICY };
      if (artifactStoreLayer !== undefined) ownership.artifactStoreLayer = artifactStoreLayer;
      const runtime = new WorkstreamRuntime(
        store,
        repository,
        workers,
        { workspaceId: "w1" },
        () => undefined,
        () => undefined,
        ownership,
      );
      runtimes.push(runtime);
      return runtime;
    },
    async dispose() {
      for (const runtime of runtimes) await runtime.stop();
      registry.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}
