/**
 * Production host adapters for automatic reconciliation and explicit commands.
 * The reconciliation driver remains free of aggregate, store, and frontier state.
 */
import { Effect, Path } from "effect";
import type { RepositoryIdentity } from "../domain/workstream.js";
import type { GitRepository, WorktreePlacement } from "../git.js";
import type { HerdrCliRuntime } from "../herdr.js";
import { WorkerLaunchError } from "../herdr-launch.js";
import {
  createWorkerSessionEffect,
  effectiveModelObservations,
  hasNativeAgentSettled,
  hasNativeAgentStarted,
  inspectWorkerSessionDirectory,
  observeNativeFailure,
  readWorkerText,
  readWorkgraphReportResult,
} from "../pi-process.js";
import { WorkstreamCommandError, type WorkstreamCommandPorts } from "./commands.js";
import type {
  WorkstreamDeliveryPort,
  WorkstreamGitPort,
  WorkstreamReconciliationPorts,
  WorkstreamSessionPort,
  WorkstreamWorkerPort,
} from "./driver.js";
import { makeWorkstreamReconciliationDriver } from "./driver.js";
import {
  ReconciliationControlError,
  type ReconciliationDriver,
  ReconciliationDriverError,
} from "./reconciliation.js";

export function liveGitPort(git: GitRepository): WorkstreamGitPort {
  return {
    projectRoot: git.root,
    gitCommonDir: git.commonDir,
    derivePlacement: (runId, nodeId) => {
      const derived = git.deriveWorktreePlacement(runId, nodeId);
      return derived === undefined ? undefined : { path: derived.path, branch: derived.branch };
    },
    ensureWorktree: (runId, nodeId, placement) =>
      git
        .createWorktree(runId, nodeId, placement.baseCommit)
        .pipe(Effect.mapError((error) => hostFailure("ensure isolated worktree", error))),
    currentHead: (cwd) =>
      git.head(cwd).pipe(Effect.mapError((error) => hostFailure("observe isolated HEAD", error))),
    validateNoChange: (placement: WorktreePlacement, revision) =>
      git.validateWorkerNoChange(placement, revision).pipe(
        Effect.asVoid,
        Effect.mapError((error) => hostFailure("validate no-change output", error)),
      ),
    validateCommit: (placement, reportedCommit) =>
      git.validateWorkerCommit(placement, reportedCommit).pipe(
        Effect.map((validated) => validated.commit),
        Effect.mapError((error) => hostFailure("validate candidate commit", error)),
      ),
    cleanupWorktree: (placement, expectedHead, retainBranch) =>
      git.cleanupWorktree(placement, expectedHead, retainBranch).pipe(
        Effect.asVoid,
        Effect.mapError((error) => hostFailure("clean up isolated output", error)),
      ),
  };
}

function liveWorkerPort(workers: HerdrCliRuntime, workspaceId: string): WorkstreamWorkerPort {
  return {
    workspaceId,
    launch: (request) =>
      Effect.gen(function* () {
        const attempted = yield* Effect.result(workers.launch(request));
        if (attempted._tag === "Success") return;
        const error = attempted.failure;
        if (error instanceof WorkerLaunchError) {
          const cause = error.cause;
          if (cause instanceof ReconciliationControlError) return yield* cause;
          return yield* hostFailure("Herdr worker launch checkpoint", cause);
        }
        return yield* hostFailure("Herdr worker launch", error);
      }),
    inspectLaunch: (request) =>
      workers
        .inspectLaunch(request)
        .pipe(Effect.mapError((error) => hostFailure("inspect partial Herdr launch", error))),
    inspect: (identity) =>
      workers.inspect(identity).pipe(
        Effect.map((observation) => observation.status),
        Effect.mapError((error) => hostFailure("inspect Herdr worker", error)),
      ),
    terminate: (identity) =>
      workers.terminate(identity).pipe(
        Effect.map((result) => ({ state: result.state, detail: result.detail })),
        Effect.mapError((error) => hostFailure("terminate Herdr worker", error)),
      ),
    steer: (identity, instruction) =>
      workers
        .steer(identity, instruction)
        .pipe(Effect.mapError((error) => hostFailure("submit worker objective", error))),
    cleanup: (identity) =>
      workers.cleanup(identity).pipe(
        Effect.map((result) => ({ state: result.state, detail: result.detail })),
        Effect.mapError((error) => hostFailure("close Herdr worker", error)),
      ),
  };
}

function liveSessionPort(repository: RepositoryIdentity): WorkstreamSessionPort {
  return {
    sessionDirectory: (runId) =>
      Effect.map(Path.Path, (path) =>
        path.join(repository.gitCommonDir, "pi-workgraph", "worker-sessions", runId),
      ),
    inspectDirectory: (sessionDir, generation) =>
      inspectWorkerSessionDirectory(sessionDir, generation),
    create: (request) =>
      createWorkerSessionEffect(request).pipe(
        Effect.mapError((error) => hostFailure("create Worker session", error)),
      ),
    readReport: (sessionFile, generation) => readWorkgraphReportResult(sessionFile, generation),
    readText: (sessionFile, generation) => readWorkerText(sessionFile, generation),
    observeFailure: (sessionFile, generation) => observeNativeFailure(sessionFile, generation),
    models: (sessionFile, generation) => effectiveModelObservations(sessionFile, generation),
    started: (sessionFile, runId, nodeId) => hasNativeAgentStarted(sessionFile, runId, nodeId),
    settled: (sessionFile, runId, nodeId) => hasNativeAgentSettled(sessionFile, runId, nodeId),
  };
}

export function liveWorkstreamCommandPorts(
  git: GitRepository,
  workers: HerdrCliRuntime,
): WorkstreamCommandPorts {
  return {
    git: {
      resolveRevision: (revision) =>
        commandHostEffect("resolve Git revision", git.resolveRevision(revision)),
      head: commandHostEffect("inspect Git HEAD", git.head()),
      cleanHead: commandHostEffect(
        "inspect clean destination",
        git.assertClean().pipe(Effect.andThen(git.head())),
      ),
      validateCandidate: (placement, root, commit) =>
        commandHostEffect(
          "validate retained candidate",
          git.validateCandidate(placement, root, commit),
        ),
      preflightCandidateApplication: (source) =>
        commandHostEffect(
          "preflight candidate application",
          git.preflightCandidateApplication(source),
        ),
      prepareCandidateApplication: (source, destination) =>
        commandHostEffect(
          "prepare candidate application",
          git.prepareCandidateApplication(source, destination),
        ),
      recoverCandidateApplication: (destination, source) =>
        commandHostEffect(
          "recover candidate application",
          git.recoverCandidateApplication(destination, source),
        ),
      applyCandidate: (prepared) =>
        commandHostEffect("apply candidate", git.applyCandidate(prepared)),
      releaseOutput: (placement, head) =>
        commandHostEffect("release output", git.releaseOutput(placement, head)),
    },
    workers: {
      steer: (identity, instruction) =>
        commandHostEffect("steer Worker", workers.steer(identity, instruction)),
    },
  };
}

function commandHostEffect<A, E extends { readonly message: string }, R>(
  operation: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, WorkstreamCommandError, R> {
  return effect.pipe(
    Effect.mapError(
      (cause) => new WorkstreamCommandError({ operation, message: cause.message, cause }),
    ),
  );
}

export interface WorkstreamHostOptions {
  readonly repository: RepositoryIdentity;
  readonly workspaceId: string;
  readonly git: GitRepository;
  readonly workers: HerdrCliRuntime;
  readonly delivery: WorkstreamDeliveryPort;
  /** Host-only configuration injected into the pure driver; defaults to the host process. */
  readonly codingAgentDir?: string;
  /** Test seam: replace any narrow port while keeping the rest live. */
  readonly overrides?: Partial<WorkstreamReconciliationPorts>;
}

/** One production-usable driver over the existing host adapters. */
export function makeLiveWorkstreamReconciliationDriver(
  options: WorkstreamHostOptions,
): ReconciliationDriver {
  const { PI_CODING_AGENT_DIR: hostCodingAgentDir } = process.env;
  const codingAgentDir = options.codingAgentDir ?? hostCodingAgentDir;
  const ports: WorkstreamReconciliationPorts = {
    git: liveGitPort(options.git),
    workers: liveWorkerPort(options.workers, options.workspaceId),
    sessions: liveSessionPort(options.repository),
    delivery: options.delivery,
    host: codingAgentDir === undefined ? {} : { codingAgentDir },
    ...options.overrides,
  };
  return makeWorkstreamReconciliationDriver(ports);
}

function hostFailure(
  operation: string,
  failure: { readonly message: string },
): ReconciliationDriverError {
  return new ReconciliationDriverError({
    detail: `${operation}: ${failure.message.slice(0, 300)}`,
  });
}
