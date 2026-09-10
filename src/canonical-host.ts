/**
 * Production host adapters for automatic reconciliation and explicit commands.
 * The reconciliation driver remains free of aggregate, store, and frontier state.
 */
import { Effect, Path } from "effect";
import { CanonicalCommandError, type CanonicalCommandPorts } from "./canonical-commands.js";
import type {
  CanonicalDeliveryPort,
  CanonicalGitPort,
  CanonicalReconciliationPorts,
  CanonicalSessionPort,
  CanonicalWorkerPort,
} from "./canonical-driver.js";
import { makeCanonicalReconciliationDriver } from "./canonical-driver.js";
import {
  ReconciliationControlError,
  type ReconciliationDriver,
  ReconciliationDriverError,
} from "./canonical-reconciliation.js";
import type { RepositoryIdentity } from "./domain/workstream.js";
import type { GitRepository, WorktreePlacement } from "./git.js";
import type { HerdrCliRuntime } from "./herdr.js";
import { WorkerLaunchError } from "./herdr-launch.js";
import {
  createWorkerSessionEffect,
  effectiveModelObservations,
  hasNativeAgentSettled,
  hasNativeAgentStarted,
  inspectWorkerSessionDirectory,
  observeNativeFailure,
  readWorkerText,
  readWorkgraphReportResult,
} from "./pi-process.js";

export function liveGitPort(git: GitRepository): CanonicalGitPort {
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

function liveWorkerPort(workers: HerdrCliRuntime, workspaceId: string): CanonicalWorkerPort {
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
    interrupt: (identity) =>
      workers.interrupt(identity).pipe(
        Effect.map((observation) => observation.status),
        Effect.mapError((error) => hostFailure("interrupt Herdr worker", error)),
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

function liveSessionPort(repository: RepositoryIdentity): CanonicalSessionPort {
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

export function liveCanonicalCommandPorts(
  git: GitRepository,
  workers: HerdrCliRuntime,
): CanonicalCommandPorts {
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
): Effect.Effect<A, CanonicalCommandError, R> {
  return effect.pipe(
    Effect.mapError(
      (cause) => new CanonicalCommandError({ operation, message: cause.message, cause }),
    ),
  );
}

export interface CanonicalHostOptions {
  readonly repository: RepositoryIdentity;
  readonly workspaceId: string;
  readonly git: GitRepository;
  readonly workers: HerdrCliRuntime;
  readonly delivery: CanonicalDeliveryPort;
  /** Host-only configuration injected into the pure driver; defaults to the host process. */
  readonly codingAgentDir?: string;
  /** Test seam: replace any narrow port while keeping the rest live. */
  readonly overrides?: Partial<CanonicalReconciliationPorts>;
}

/** One production-usable driver over the existing host adapters. */
export function makeLiveCanonicalReconciliationDriver(
  options: CanonicalHostOptions,
): ReconciliationDriver {
  const { PI_CODING_AGENT_DIR: hostCodingAgentDir } = process.env;
  const codingAgentDir = options.codingAgentDir ?? hostCodingAgentDir;
  const ports: CanonicalReconciliationPorts = {
    git: liveGitPort(options.git),
    workers: liveWorkerPort(options.workers, options.workspaceId),
    sessions: liveSessionPort(options.repository),
    delivery: options.delivery,
    host: codingAgentDir === undefined ? {} : { codingAgentDir },
    ...options.overrides,
  };
  return makeCanonicalReconciliationDriver(ports);
}

function hostFailure(
  operation: string,
  failure: { readonly message: string },
): ReconciliationDriverError {
  return new ReconciliationDriverError({
    detail: `${operation}: ${failure.message.slice(0, 300)}`,
  });
}
