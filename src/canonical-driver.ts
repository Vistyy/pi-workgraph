/**
 * Staged external reconciliation driver. It consumes exactly one
 * immutable `FrontierEntry` plus the runtime-owned `ReconciliationControl`, and
 * performs external effects only through narrow injected Git/Herdr/Pi/session
 * and delivery ports. It never reads the aggregate, the store, or the frontier.
 *
 * Every durable fact is committed through control before the next external
 * effect, so a crash between two host observations re-enters at the exact last
 * committed stage. Ambiguous or unprovable host evidence blocks instead of
 * inventing a checkpoint or blindly retrying.
 */
import { Clock, DateTime, Effect, type FileSystem, type Path } from "effect";
import type { FrontierEntry } from "./canonical-frontier.js";
import {
  type ReconciliationContext,
  type ReconciliationControl,
  ReconciliationControlError,
  type ReconciliationDriver,
  type ReconciliationDriverError,
  type ReconciliationMutation,
  type ReconciliationOutcome,
} from "./canonical-reconciliation.js";
import {
  type Attempt,
  type CancellationCheckpoint,
  type OutputDisposition,
  outputDisposition,
  type Placement,
  type TaskContract,
  type TerminalObservation,
  type WorkerExecution,
} from "./domain/workstream.js";
import type { WorktreePlacement } from "./git.js";
import type { WorkerLaunchInspection, WorkerLaunchInspectionRequest } from "./herdr.js";
import type { WorkerLaunchEffectRequest } from "./herdr-launch.js";
import type { NativeFailureCategory, WorkerSessionResolution } from "./pi-process.js";
import type {
  ThinkingLevel,
  WorkerIdentity,
  WorkerObservationStatus,
  WorkerReport,
  WorkerSessionMode,
} from "./types.js";
import {
  type CanonicalAssignmentInput,
  type CanonicalWorkerAssignment,
  canonicalSessionMode,
  canonicalWorkerAssignment,
} from "./worker-context.js";

type WorkerPresence = WorkerObservationStatus | "absent";
type Stage = ReconciliationDriverError | ReconciliationControlError;
type Requirements = FileSystem.FileSystem | Path.Path;

/** Narrow Git ownership port: one derivation, exact ensure, exact cleanup. */
export interface CanonicalGitPort {
  readonly projectRoot: string;
  readonly gitCommonDir: string;
  readonly derivePlacement: (
    runId: string,
    nodeId: string,
  ) => { readonly path: string; readonly branch: string } | undefined;
  /** Adopt the exact registered worktree or create only after proven absence. */
  readonly ensureWorktree: (
    runId: string,
    nodeId: string,
    placement: WorktreePlacement,
  ) => Effect.Effect<WorktreePlacement, ReconciliationDriverError>;
  /** Propagate the host read failure; never convert it to a missing HEAD. */
  readonly currentHead: (cwd: string) => Effect.Effect<string, ReconciliationDriverError>;
  readonly validateNoChange: (
    placement: WorktreePlacement,
    revision: string,
  ) => Effect.Effect<void, ReconciliationDriverError>;
  readonly validateCommit: (
    placement: WorktreePlacement,
    reportedCommit: string | undefined,
  ) => Effect.Effect<string, ReconciliationDriverError>;
  readonly cleanupWorktree: (
    placement: WorktreePlacement,
    expectedHead: string,
    retainBranch: boolean,
  ) => Effect.Effect<void, ReconciliationDriverError>;
}

/** Narrow Herdr worker port over the existing progressive launch contract. */
export interface CanonicalWorkerPort {
  readonly workspaceId: string;
  readonly launch: (
    request: WorkerLaunchEffectRequest<Stage, Requirements>,
  ) => Effect.Effect<void, Stage, Requirements>;
  readonly inspectLaunch: (
    request: WorkerLaunchInspectionRequest,
  ) => Effect.Effect<WorkerLaunchInspection, ReconciliationDriverError>;
  readonly inspect: (
    identity: WorkerIdentity,
  ) => Effect.Effect<WorkerPresence, ReconciliationDriverError>;
  readonly interrupt: (
    identity: WorkerIdentity,
  ) => Effect.Effect<WorkerPresence, ReconciliationDriverError>;
  readonly steer: (
    identity: WorkerIdentity,
    instruction: string,
  ) => Effect.Effect<void, ReconciliationDriverError>;
  readonly cleanup: (
    identity: WorkerIdentity,
  ) => Effect.Effect<
    { readonly state: "pending" | "completed" | "blocked"; readonly detail: string },
    ReconciliationDriverError
  >;
}

/** One immutable worker-session creation request. */
export interface WorkerSessionRequest {
  runId: string;
  nodeId: string;
  targetCwd: string;
  sessionDir: string;
  objective: string;
  mode: WorkerSessionMode;
  continuationSessionFile?: string;
}

/** Narrow Pi/session port: exact pre-creation inspection plus retained evidence. */
export interface CanonicalSessionPort {
  readonly sessionDirectory: (runId: string) => Effect.Effect<string, never, Path.Path>;
  readonly inspectDirectory: (
    sessionDir: string,
    generation: { runId: string; nodeId: string },
  ) => Effect.Effect<WorkerSessionResolution, never, Requirements>;
  readonly create: (
    request: WorkerSessionRequest,
  ) => Effect.Effect<string, ReconciliationDriverError, FileSystem.FileSystem>;
  readonly readReport: (
    sessionFile: string,
    generation: { runId: string; nodeId: string },
  ) => {
    readonly report?: WorkerReport;
    readonly invalid: boolean;
    readonly unreadable: boolean;
    readonly error?: string;
  };
  readonly readText: (
    sessionFile: string,
    generation: { runId: string; nodeId: string },
  ) => string | undefined;
  readonly observeFailure: (
    sessionFile: string,
    generation: { runId: string; nodeId: string },
  ) => NativeFailureCategory | undefined;
  readonly models: (
    sessionFile: string,
    generation: { runId: string; nodeId: string },
  ) => readonly { model: string; thinking?: string; source?: "selection" | "message" }[];
  readonly started: (sessionFile: string, runId: string, nodeId: string) => boolean;
  readonly settled: (sessionFile: string, runId: string, nodeId: string) => boolean;
}

export interface CanonicalDeliveryPort {
  readonly deliver: (
    context: ReconciliationContext,
  ) => Effect.Effect<void, ReconciliationDriverError, Requirements>;
}

export interface CanonicalReconciliationPorts {
  readonly git: CanonicalGitPort;
  readonly workers: CanonicalWorkerPort;
  readonly sessions: CanonicalSessionPort;
  readonly delivery: CanonicalDeliveryPort;
  /** Host-only configuration, injected so the pure driver reads no process global. */
  readonly host: { readonly codingAgentDir?: string };
}

const CONTINUATION_INSTRUCTION = "Continue the assigned Workgraph objective now.";
const WAITING: ReconciliationOutcome = { kind: "waiting" };

export function makeCanonicalReconciliationDriver(
  ports: CanonicalReconciliationPorts,
): ReconciliationDriver {
  return {
    reconcile: (entry, control) => reconcile(ports, entry, control),
  };
}

function reconcile(
  ports: CanonicalReconciliationPorts,
  entry: FrontierEntry,
  control: ReconciliationControl,
): Effect.Effect<ReconciliationOutcome, Stage, Requirements> {
  return Effect.gen(function* () {
    const context = control.context();
    const mismatch = repositoryMismatch(ports, context);
    if (mismatch !== undefined) return blocked(mismatch);
    const isolation = isolationMismatch(entry, context);
    if (isolation !== undefined) return blocked(isolation);
    switch (entry.kind) {
      case "queued":
        return yield* activate(ports, control);
      case "placement_recovery":
        return yield* recoverPlacement(ports, control);
      case "worker_poll":
        return yield* pollWorker(ports, entry, control);
      case "cancellation":
        return yield* reconcileCancellation(ports, entry, control);
      case "cleanup":
        return yield* reconcileCleanup(ports, entry, control);
      case "delivery":
        return yield* deliverOutcome(ports, entry, control);
    }
  });
}

/** Reject an aggregate whose repository identity is not the owned Git identity. */
function repositoryMismatch(
  ports: CanonicalReconciliationPorts,
  context: ReconciliationContext,
): string | undefined {
  if (context.repository.projectRoot !== ports.git.projectRoot)
    return "Attempt repository root does not match the owned Git repository; inspect before retrying.";
  if (context.repository.gitCommonDir !== ports.git.gitCommonDir)
    return "Attempt Git common directory does not match the owned repository; inspect before retrying.";
  return undefined;
}

/** A Task that requires isolation must never proceed on a non-isolated placement. */
function isolationMismatch(
  entry: FrontierEntry,
  context: ReconciliationContext,
): string | undefined {
  if (entry.kind !== "placement_recovery" && entry.kind !== "worker_poll") return undefined;
  if (!requiresIsolation(context.task)) return undefined;
  if (context.attempt.execution?.placement?.kind === "isolated_worktree") return undefined;
  return "Task requires an isolated worktree but the Attempt has no exact isolated placement; settlement validation cannot be skipped.";
}

/** Declaration-first activation: only the exact placement is committed here. */
function activate(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
): Effect.Effect<ReconciliationOutcome, Stage, Requirements> {
  return Effect.gen(function* () {
    const context = control.context();
    if (context.attempt.state !== "queued") return blocked("Attempt is not queued for activation.");
    const placement = placementFor(ports, context);
    if (placement === undefined)
      return blocked("Deterministic isolated placement could not be derived for this Attempt.");
    yield* commit(control, { kind: "activate", placement });
    return { kind: "waiting" };
  });
}

function placementFor(
  ports: CanonicalReconciliationPorts,
  context: ReconciliationContext,
): Placement | undefined {
  if (!requiresIsolation(context.task))
    return { kind: "shared_project", path: ports.git.projectRoot };
  const derived = ports.git.derivePlacement(context.workstreamId, context.attempt.id);
  return derived === undefined ? undefined : { kind: "isolated_worktree", ...derived };
}

function requiresIsolation(task: TaskContract): boolean {
  if (task.kind === "implementation" || task.kind === "experiment") return true;
  return task.kind === "review" && task.subject.kind === "revision";
}

/** The exact persisted base; a missing required base blocks rather than sampling HEAD. */
function persistedBase(context: ReconciliationContext): string | undefined {
  if (context.attempt.baseRevision !== undefined) return context.attempt.baseRevision;
  if (context.task.kind === "review" && context.task.subject.kind === "revision")
    return context.task.subject.revision;
  return undefined;
}

function recoverPlacement(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
): Effect.Effect<ReconciliationOutcome, Stage, Requirements> {
  return Effect.gen(function* () {
    const context = control.context();
    const placement = context.attempt.execution?.placement;
    if (placement === undefined)
      return blocked("Active Attempt has no durable placement declaration.");
    if (placement.kind === "isolated_worktree") {
      const failure = yield* ensureIsolatedWorktree(ports, control, placement);
      if (failure !== undefined) return blocked(failure);
    }
    const assignment = assignmentFor(ports, context, placement.path);
    const resolved = yield* ensureWorkerSession(ports, control, placement.path, assignment);
    if (resolved.kind === "blocked") return blocked(resolved.detail);
    return yield* launchOrAdvance(
      ports,
      control,
      placement.path,
      resolved.sessionFile,
      resolved.firstLaunchAuthorized,
      assignment,
    );
  });
}

/** Returns a blocker detail, or `undefined` when the exact worktree is ensured. */
function ensureIsolatedWorktree(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
  placement: Extract<Placement, { kind: "isolated_worktree" }>,
): Effect.Effect<string | undefined, Stage, Requirements> {
  return Effect.gen(function* () {
    const context = control.context();
    const base = persistedBase(context);
    if (base === undefined)
      return "Isolated placement requires a persisted base identity; recovery never samples mutable HEAD.";
    const derived = ports.git.derivePlacement(context.workstreamId, context.attempt.id);
    if (derived === undefined)
      return "Declared isolated placement does not match the Git-owned derivation.";
    if (derived.path !== placement.path || derived.branch !== placement.branch)
      return "Declared isolated placement differs from the deterministic Git-owned derivation; inspect before retrying.";
    yield* control.checkOwnership;
    const ensured = yield* Effect.result(
      ports.git.ensureWorktree(context.workstreamId, context.attempt.id, {
        ...placement,
        baseCommit: base,
      }),
    );
    if (ensured._tag === "Failure") return ensured.failure.detail;
    if (
      ensured.success.path !== placement.path ||
      ensured.success.branch !== placement.branch ||
      ensured.success.baseCommit !== base
    )
      return "Ensured isolated worktree does not match the declared path, branch, and base; inspect before retrying.";
    return undefined;
  });
}

/**
 * Inspect the exact worker-session directory before creating anything. A
 * recorded session must be its unique current-generation match. Directory
 * absence and an unrecorded current-generation session both prove that the
 * first launch never happened, so that call adopts the session and may launch
 * once; a recorded session without a launch checkpoint stays ambiguous.
 */
type SessionResolution =
  | {
      readonly kind: "session";
      readonly sessionFile: string;
      readonly firstLaunchAuthorized: boolean;
    }
  | { readonly kind: "blocked"; readonly detail: string };

function ensureWorkerSession(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
  cwd: string,
  assignment: CanonicalWorkerAssignment,
): Effect.Effect<SessionResolution, Stage, Requirements> {
  return Effect.gen(function* () {
    const context = control.context();
    const generation = { runId: context.workstreamId, nodeId: context.attempt.id };
    const sessionDir = yield* ports.sessions.sessionDirectory(context.workstreamId);
    const recorded = context.attempt.execution?.sessionFile;
    const resolution = yield* ports.sessions.inspectDirectory(sessionDir, generation);
    if (recorded !== undefined) {
      if (resolution.state !== "exact" || resolution.sessionFile !== recorded)
        return {
          kind: "blocked" as const,
          detail:
            "Recorded Worker session is not the unique current-generation session in its directory; inspect before retrying.",
        };
      return {
        kind: "session" as const,
        sessionFile: recorded,
        firstLaunchAuthorized: false,
      };
    }
    if (resolution.state === "ambiguous")
      return { kind: "blocked" as const, detail: resolution.detail };
    if (resolution.state === "exact") {
      yield* commit(control, {
        kind: "record_worker_execution",
        execution: { sessionFile: resolution.sessionFile },
      });
      return {
        kind: "session" as const,
        sessionFile: resolution.sessionFile,
        firstLaunchAuthorized: true,
      };
    }
    const request: WorkerSessionRequest = {
      runId: context.workstreamId,
      nodeId: context.attempt.id,
      targetCwd: cwd,
      sessionDir,
      objective: assignment.objective,
      mode: assignment.mode,
    };
    if (context.continuationSessionFile !== undefined)
      request.continuationSessionFile = context.continuationSessionFile;
    yield* control.checkOwnership;
    const sessionFile = yield* ports.sessions.create(request);
    yield* commit(control, {
      kind: "record_worker_execution",
      execution: { sessionFile },
    });
    return {
      kind: "session" as const,
      sessionFile,
      firstLaunchAuthorized: true,
    };
  });
}

function launchOrAdvance(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
  cwd: string,
  sessionFile: string,
  firstLaunchAuthorized: boolean,
  assignment: CanonicalWorkerAssignment,
): Effect.Effect<ReconciliationOutcome, Stage, Requirements> {
  return Effect.gen(function* () {
    const context = control.context();
    const launch = context.attempt.execution?.launch;
    if (launch?.phase === "ready") return WAITING;
    if (launch === undefined) {
      if (!firstLaunchAuthorized)
        return blocked(
          "Recorded Worker session has no launch checkpoint; the first launch may already have occurred.",
        );
      return yield* launchFresh(ports, control, context, cwd, sessionFile, assignment);
    }
    return yield* advancePartialLaunch(ports, control, launch, cwd, sessionFile);
  });
}

function launchFresh(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
  context: ReconciliationContext,
  cwd: string,
  sessionFile: string,
  assignment: CanonicalWorkerAssignment,
): Effect.Effect<ReconciliationOutcome, Stage, Requirements> {
  return Effect.gen(function* () {
    const selection = guideModel(context);
    const request: WorkerLaunchEffectRequest<Stage, Requirements> = {
      workspaceId: ports.workers.workspaceId,
      runId: context.workstreamId,
      nodeId: context.attempt.id,
      attemptId: context.attempt.id,
      assignmentId: context.task.id,
      objective: context.task.objective,
      role: assignment.role,
      cwd,
      sessionFile,
      prompt: assignment.prompt,
      model: selection.model,
      env: assignment.environment,
      onFence: () => control.checkOwnership,
      onTab: (pane) =>
        commit(control, {
          kind: "record_worker_execution",
          execution: {
            launch: {
              phase: "pane",
              workspaceId: pane.workspaceId,
              paneId: pane.paneId,
            },
          },
        }),
      onResource: (resource) =>
        commit(control, {
          kind: "record_worker_execution",
          execution: { launch: resourceCheckpoint(resource) },
        }),
      onIdentity: (identity) =>
        commit(control, {
          kind: "record_worker_execution",
          execution: { launch: readyCheckpoint(identity) },
        }),
      onPreflight: () =>
        commit(control, {
          kind: "record_worker_execution",
          execution: { submission: "uncertain" },
        }),
      onSubmitted: () =>
        commit(control, {
          kind: "record_worker_execution",
          execution: { submission: "submitted" },
        }),
    };
    if (selection.thinking !== undefined) request.thinking = selection.thinking;
    yield* control.checkOwnership;
    yield* ports.workers.launch(request);
    return WAITING;
  });
}

/**
 * Partial launch recovery observes the exact retained pane/resource/session/cwd.
 * A live observation advances one checkpoint; anything else blocks, because the
 * launch checkpoint is monotonic and cannot be rewritten to a new identity.
 */
function advancePartialLaunch(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
  launch: NonNullable<WorkerExecution["launch"]>,
  cwd: string,
  sessionFile: string,
): Effect.Effect<ReconciliationOutcome, Stage, Requirements> {
  return Effect.gen(function* () {
    const inspection = yield* ports.workers.inspectLaunch(
      launchInspectionRequest(launch, sessionFile, cwd),
    );
    if (inspection.state !== "live") return blocked(inspection.detail);
    const failure = yield* advanceLaunchCheckpoint(control, launch, inspection.identity);
    return failure === undefined ? { kind: "waiting" } : blocked(failure);
  });
}

function pollWorker(
  ports: CanonicalReconciliationPorts,
  entry: Extract<FrontierEntry, { kind: "worker_poll" }>,
  control: ReconciliationControl,
): Effect.Effect<ReconciliationOutcome, Stage, Requirements> {
  return Effect.gen(function* () {
    const context = control.context();
    const execution = context.attempt.execution;
    if (execution?.launch?.phase !== "ready" || execution.sessionFile === undefined)
      return blocked("Worker polling requires an exact ready Worker identity.");
    const generation = { runId: context.workstreamId, nodeId: context.attempt.id };
    const sessionFile = execution.sessionFile;
    const submissionOutcome = yield* resolveSubmission(
      ports,
      control,
      entry,
      sessionFile,
      execution.submission,
    );
    if (submissionOutcome !== undefined) return submissionOutcome;
    return yield* observeWorker(ports, control, entry, sessionFile, generation);
  });
}

/** Resolves `not_sent`/`uncertain` submission; `undefined` means polling may proceed. */
function resolveSubmission(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
  entry: Extract<FrontierEntry, { kind: "worker_poll" }>,
  sessionFile: string,
  submission: WorkerExecution["submission"],
): Effect.Effect<ReconciliationOutcome | undefined, Stage, Requirements> {
  return Effect.gen(function* () {
    if (submission === "not_sent") return yield* submitObjective(ports, control, entry);
    if (submission !== "uncertain") return undefined;
    const generation = {
      runId: control.context().workstreamId,
      nodeId: control.context().attempt.id,
    };
    if (!ports.sessions.started(sessionFile, generation.runId, generation.nodeId))
      return blocked(
        "Submission is uncertain and no current native start is recorded; inspect before resending.",
      );
    yield* commit(control, {
      kind: "record_worker_execution",
      execution: { submission: "started" },
    });
    return undefined;
  });
}

function observeWorker(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
  entry: Extract<FrontierEntry, { kind: "worker_poll" }>,
  sessionFile: string,
  generation: { runId: string; nodeId: string },
): Effect.Effect<ReconciliationOutcome, Stage, Requirements> {
  return Effect.gen(function* () {
    const presence = yield* ports.workers.inspect(entry.worker);
    if (presence === "unknown")
      return blocked("Exact Herdr worker presence is unknown; no conclusion was made.");
    const started = ports.sessions.started(sessionFile, generation.runId, generation.nodeId);
    const settled = ports.sessions.settled(sessionFile, generation.runId, generation.nodeId);
    if (settled) return yield* retainSettled(ports, control, sessionFile);
    if (presence === "blocked")
      return blocked("Worker is blocked; inspect its visible session before proceeding.");
    if (presence === "absent")
      return blocked(
        "Exact worker is absent before native settlement; inspect the session evidence before proceeding.",
      );
    if (started && control.context().attempt.execution?.submission !== "started")
      yield* commit(control, {
        kind: "record_worker_execution",
        execution: { submission: "started" },
      });
    return { kind: "waiting" };
  });
}

function submitObjective(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
  entry: Extract<FrontierEntry, { kind: "worker_poll" }>,
): Effect.Effect<ReconciliationOutcome, Stage, Requirements> {
  return Effect.gen(function* () {
    yield* control.checkOwnership;
    yield* commit(control, {
      kind: "record_worker_execution",
      execution: { submission: "uncertain" },
    });
    yield* control.checkOwnership;
    const steered = yield* Effect.result(
      ports.workers.steer(entry.worker, submissionInstruction()),
    );
    if (steered._tag === "Failure") return blocked(steered.failure.detail);
    yield* commit(control, {
      kind: "record_worker_execution",
      execution: { submission: "submitted" },
    });
    return { kind: "waiting" };
  });
}

function submissionInstruction(): string {
  // The objective already lives in the session; recovery only nudges the
  // retained unsent worker without re-deriving a new assignment prompt.
  return CONTINUATION_INSTRUCTION;
}

/** Read the exact current-generation evidence and atomically terminalize. */
function retainSettled(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
  sessionFile: string,
): Effect.Effect<ReconciliationOutcome, Stage, Requirements> {
  return Effect.gen(function* () {
    const context = control.context();
    const generation = { runId: context.workstreamId, nodeId: context.attempt.id };
    const observedAt = yield* nowIso();
    for (const observation of ports.sessions.models(sessionFile, generation))
      yield* commit(control, { kind: "record_effective_model", observation });
    yield* commit(control, {
      kind: "terminalize",
      observation: yield* terminalObservation(ports, context, sessionFile, generation, observedAt),
    });
    return { kind: "waiting" };
  });
}

function terminalObservation(
  ports: CanonicalReconciliationPorts,
  context: ReconciliationContext,
  sessionFile: string,
  generation: { runId: string; nodeId: string },
  observedAt: string,
): Effect.Effect<TerminalObservation, Stage, Requirements> {
  return Effect.gen(function* () {
    const read = ports.sessions.readReport(sessionFile, generation);
    if (read.report !== undefined && read.report.kind === canonicalSessionMode(context.task))
      return yield* typedReportObservation(
        ports,
        context,
        sessionFile,
        generation,
        read.report,
        observedAt,
      );
    return untypedObservation(ports, sessionFile, generation, read, observedAt);
  });
}

function typedReportObservation(
  ports: CanonicalReconciliationPorts,
  context: ReconciliationContext,
  sessionFile: string,
  generation: { runId: string; nodeId: string },
  report: WorkerReport,
  observedAt: string,
): Effect.Effect<TerminalObservation, Stage, Requirements> {
  return Effect.gen(function* () {
    const validated = yield* validateReportFacts(ports, context, report);
    if (validated !== undefined)
      return unreported(observedAt, validated, ports.sessions.readText(sessionFile, generation));
    return {
      kind: "reported",
      observedAt,
      artifacts: [],
      report,
      deliveryRequestedAt: observedAt,
    };
  });
}

function untypedObservation(
  ports: CanonicalReconciliationPorts,
  sessionFile: string,
  generation: { runId: string; nodeId: string },
  read: { report?: WorkerReport; invalid: boolean; unreadable: boolean; error?: string },
  observedAt: string,
): TerminalObservation {
  if (read.report !== undefined || read.invalid || read.unreadable)
    return unreported(
      observedAt,
      read.error ?? "Worker report kind does not match the assigned responsibility.",
      ports.sessions.readText(sessionFile, generation),
    );
  const text = ports.sessions.readText(sessionFile, generation);
  if (text !== undefined && text !== "")
    return unreported(observedAt, "Pi settled without a current-attempt typed report.", text);
  return unreported(
    observedAt,
    absentDetail(ports.sessions.observeFailure(sessionFile, generation)),
    undefined,
  );
}

/** Returns a blocker reason when the report's Git facts do not hold. */
function validateReportFacts(
  ports: CanonicalReconciliationPorts,
  context: ReconciliationContext,
  report: WorkerReport,
): Effect.Effect<string | undefined, Stage, Requirements> {
  return Effect.gen(function* () {
    if (report.kind !== "implementation" || report.status !== "completed") return undefined;
    return yield* validateImplementationFacts(ports, context, report);
  });
}

function validateImplementationFacts(
  ports: CanonicalReconciliationPorts,
  context: ReconciliationContext,
  report: Extract<WorkerReport, { kind: "implementation"; status: "completed" }>,
): Effect.Effect<string | undefined, Stage, Requirements> {
  return Effect.gen(function* () {
    const placement = context.attempt.execution?.placement;
    if (placement?.kind !== "isolated_worktree")
      return "Implementation settlement requires an exact isolated worktree placement; validation cannot be skipped.";
    const base = persistedBase(context);
    if (base === undefined) return "Implementation report requires a persisted base identity.";
    const target: WorktreePlacement = { ...placement, baseCommit: base };
    if (report.outcome === "no_change") {
      const checked = yield* Effect.result(ports.git.validateNoChange(target, report.revision));
      return checked._tag === "Failure"
        ? `No-change validation failed: ${checked.failure.detail}`
        : undefined;
    }
    return yield* validateChangedCandidate(ports, target, report);
  });
}

function validateChangedCandidate(
  ports: CanonicalReconciliationPorts,
  target: WorktreePlacement,
  report: Extract<
    WorkerReport,
    { kind: "implementation"; status: "completed"; outcome: "changed" }
  >,
): Effect.Effect<string | undefined, Stage, Requirements> {
  return Effect.gen(function* () {
    const checked = yield* Effect.result(ports.git.validateCommit(target, report.commit));
    if (checked._tag === "Failure") return `Candidate validation failed: ${checked.failure.detail}`;
    if (report.commit === undefined || report.commit !== checked.success)
      return "Implementation report does not carry its exact validated candidate commit.";
    return undefined;
  });
}

function unreported(
  observedAt: string,
  reason: string,
  rawWorkerText: string | undefined,
): TerminalObservation {
  const base = {
    kind: "unreported" as const,
    observedAt,
    artifacts: [],
    reason,
    deliveryRequestedAt: observedAt,
  };
  return rawWorkerText === undefined ? base : { ...base, rawWorkerText };
}

function reconcileCancellation(
  ports: CanonicalReconciliationPorts,
  entry: Extract<FrontierEntry, { kind: "cancellation" }>,
  control: ReconciliationControl,
): Effect.Effect<ReconciliationOutcome, Stage, Requirements> {
  return Effect.gen(function* () {
    const context = control.context();
    if (context.attempt.execution?.placement === undefined)
      return blocked("Cancellation requires a durable placement declaration.");
    const checkpoint = entry.cancellation;
    if (checkpoint.state === "requested") return yield* beginCancellation(ports, control, entry);
    if (checkpoint.state === "uncertain") return yield* resumeInterrupt(ports, control, entry);
    return yield* closeCancelled(ports, control, entry, checkpoint);
  });
}

function beginCancellation(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
  entry: Extract<FrontierEntry, { kind: "cancellation" }>,
): Effect.Effect<ReconciliationOutcome, Stage, Requirements> {
  return Effect.gen(function* () {
    const now = yield* nowIso();
    yield* control.checkOwnership;
    yield* commit(control, {
      kind: "checkpoint_cancellation",
      checkpoint: { ...requestedFields(entry.cancellation), state: "uncertain", dispatchAt: now },
    });
    return yield* dispatchInterrupt(ports, control, entry);
  });
}

function resumeInterrupt(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
  entry: Extract<FrontierEntry, { kind: "cancellation" }>,
): Effect.Effect<ReconciliationOutcome, Stage, Requirements> {
  return Effect.gen(function* () {
    if (entry.worker !== undefined) {
      const presence = yield* ports.workers.inspect(entry.worker);
      if (presence === "unknown")
        return blocked("Exact cancelled worker presence is unknown; no interruption was retried.");
      if (presence === "idle" || presence === "done" || presence === "absent") {
        yield* observedCancellation(control, presence);
        return { kind: "waiting" };
      }
      return yield* interruptObserved(ports, control, entry.worker);
    }
    return yield* dispatchInterrupt(ports, control, entry);
  });
}

/**
 * Without a ready Worker identity only exact retained launch observation may
 * decide. A live partial resource advances one durable launch stage per commit;
 * a proven-absent or proven-unlaunched Attempt records exact absence; anything
 * unknown blocks.
 */
function dispatchInterrupt(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
  entry: Extract<FrontierEntry, { kind: "cancellation" }>,
): Effect.Effect<ReconciliationOutcome, Stage, Requirements> {
  return Effect.gen(function* () {
    if (entry.worker !== undefined) return yield* interruptObserved(ports, control, entry.worker);
    const inspection = yield* inspectRetainedLaunch(
      ports,
      control,
      retainedLaunchInput(entry, entry.placement.path, false),
    );
    if (inspection.kind === "blocked") return blocked(inspection.detail);
    if (inspection.kind !== "live") {
      yield* observedCancellation(control, "absent");
      return { kind: "waiting" };
    }
    const failure = yield* advanceLaunchCheckpoint(control, entry.launch, inspection.identity);
    return failure === undefined ? { kind: "waiting" } : blocked(failure);
  });
}

type RetainedLaunchInput = {
  launch?: NonNullable<WorkerExecution["launch"]>;
  sessionFile?: string;
  cwd: string;
};

type RetainedLaunchObservation =
  | { readonly kind: "live"; readonly identity: WorkerIdentity }
  /** Proven by no possible launch or an exact launch handle observed absent. */
  | { readonly kind: "absent" }
  | { readonly kind: "blocked"; readonly detail: string };

function inspectRetainedLaunch(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
  input: RetainedLaunchInput,
): Effect.Effect<RetainedLaunchObservation, Stage, Requirements> {
  return Effect.gen(function* () {
    const { launch, sessionFile, cwd } = input;
    if (launch === undefined || sessionFile === undefined) {
      if (launch !== undefined || sessionFile !== undefined)
        return {
          kind: "blocked" as const,
          detail:
            "Retained Worker launch facts are incomplete; inspect the exact session and pane before concluding absence.",
        };
      return yield* proveNoPriorLaunch(ports, control);
    }
    const inspection = yield* ports.workers.inspectLaunch(
      launchInspectionRequest(launch, sessionFile, cwd),
    );
    if (inspection.state === "live")
      return { kind: "live" as const, identity: inspection.identity };
    return inspection.state === "absent"
      ? { kind: "absent" as const }
      : { kind: "blocked" as const, detail: inspection.detail };
  });
}

/**
 * Only the exact session directory can prove that no launch ever happened: an
 * absent directory or an unrecorded current-generation session precedes the
 * launch checkpoint, while a recorded session without a launch checkpoint is
 * ambiguous because tab creation may already have succeeded.
 */
function proveNoPriorLaunch(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
): Effect.Effect<RetainedLaunchObservation, Stage, Requirements> {
  return Effect.gen(function* () {
    const context = control.context();
    if (context.attempt.execution?.sessionFile !== undefined)
      return {
        kind: "blocked" as const,
        detail:
          "A recorded Worker session has no launch checkpoint; a prior launch cannot be excluded.",
      };
    const sessionDir = yield* ports.sessions.sessionDirectory(context.workstreamId);
    const resolution = yield* ports.sessions.inspectDirectory(sessionDir, {
      runId: context.workstreamId,
      nodeId: context.attempt.id,
    });
    if (resolution.state === "exact") return { kind: "absent" as const };
    if (resolution.state === "none") return { kind: "absent" as const };
    return { kind: "blocked" as const, detail: resolution.detail };
  });
}

/** Commit exactly one monotonic launch stage for an observed live partial resource. */
function advanceLaunchCheckpoint(
  control: ReconciliationControl,
  launch: NonNullable<WorkerExecution["launch"]> | undefined,
  identity: WorkerIdentity,
): Effect.Effect<string | undefined, Stage, Requirements> {
  return Effect.gen(function* () {
    if (launch === undefined) return "No retained launch checkpoint to advance.";
    if (launch.phase === "pane") {
      yield* commit(control, {
        kind: "record_worker_execution",
        execution: { launch: resourceCheckpoint(identity) },
      });
      return undefined;
    }
    if (launch.phase === "resource") {
      yield* commit(control, {
        kind: "record_worker_execution",
        execution: { launch: readyCheckpoint(identity) },
      });
      return undefined;
    }
    return "Retained launch is already ready without an exact Worker identity; inspect before retrying.";
  });
}

function interruptObserved(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
  worker: WorkerIdentity,
): Effect.Effect<ReconciliationOutcome, Stage, Requirements> {
  return Effect.gen(function* () {
    yield* control.checkOwnership;
    const interrupted = yield* Effect.result(ports.workers.interrupt(worker));
    if (interrupted._tag === "Failure") return blocked(interrupted.failure.detail);
    yield* observedCancellation(control, "interrupt_submitted");
    return { kind: "waiting" };
  });
}

function observedCancellation(
  control: ReconciliationControl,
  evidence: "interrupt_submitted" | "idle" | "done" | "absent",
): Effect.Effect<void, Stage, Requirements> {
  return Effect.gen(function* () {
    // The committed uncertain checkpoint owns the exact dispatch instant, so it
    // is read back rather than reconstructed from the entry's stale value.
    const current = control.context().attempt.execution?.cancellation;
    if (current === undefined || current.state === "submitted_or_observed")
      return yield* new ReconciliationControlError({
        detail: "Cancellation has no uncertain checkpoint to observe.",
      });
    const now = yield* nowIso();
    yield* commit(control, {
      kind: "checkpoint_cancellation",
      checkpoint: {
        requestedAt: current.requestedAt,
        reason: current.reason,
        state: "submitted_or_observed",
        dispatchAt: dispatchAt(current),
        observedAt: now,
        evidence,
      },
    });
  });
}

function closeCancelled(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
  entry: Extract<FrontierEntry, { kind: "cancellation" }>,
  checkpoint: Extract<CancellationCheckpoint, { state: "submitted_or_observed" }>,
): Effect.Effect<ReconciliationOutcome, Stage, Requirements> {
  return Effect.gen(function* () {
    yield* ensureCleanupPending(control);
    const closure = yield* ensureCancellationClosure(ports, control, entry, checkpoint);
    if (closure.kind === "blocked") return blocked(closure.detail);
    if (closure.kind === "waiting") return { kind: "waiting" };
    const now = yield* nowIso();
    yield* commit(control, {
      kind: "terminalize",
      observation: {
        kind: "cancelled",
        observedAt: now,
        artifacts: [],
        reason: checkpoint.reason,
        deliveryRequestedAt: now,
      },
    });
    return { kind: "waiting" };
  });
}

function ensureCancellationClosure(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
  entry: Extract<FrontierEntry, { kind: "cancellation" }>,
  checkpoint: Extract<CancellationCheckpoint, { state: "submitted_or_observed" }>,
): Effect.Effect<Closure, Stage, Requirements> {
  return Effect.gen(function* () {
    if (control.context().attempt.cleanup?.workerClosed === true) return { kind: "closed" };
    const closure = yield* ensureClosure(
      ports,
      control,
      retainedLaunchInput(entry, entry.placement.path, checkpoint.evidence === "absent"),
    );
    if (closure.kind === "closed") yield* commitCleanup(control, { workerClosed: true });
    return closure;
  });
}

type Closure =
  | { readonly kind: "closed" }
  | { readonly kind: "waiting" }
  | { readonly kind: "blocked"; readonly detail: string };

interface ClosureInput extends RetainedLaunchInput {
  worker?: WorkerIdentity;
  /** An exact recorded absence observation already authorizes closure. */
  absenceAuthorized: boolean;
}

function retainedLaunchInput(
  source: {
    readonly worker?: WorkerIdentity;
    readonly launch?: NonNullable<WorkerExecution["launch"]>;
    readonly sessionFile?: string;
  },
  cwd: string,
  absenceAuthorized: boolean,
): ClosureInput {
  const input: ClosureInput = { cwd, absenceAuthorized };
  if (source.worker !== undefined) input.worker = source.worker;
  if (source.launch !== undefined) input.launch = source.launch;
  if (source.sessionFile !== undefined) input.sessionFile = source.sessionFile;
  return input;
}

function ensureClosure(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
  input: ClosureInput,
): Effect.Effect<Closure, Stage, Requirements> {
  return Effect.gen(function* () {
    if (input.worker !== undefined) return yield* closeIdentity(ports, control, input.worker);
    if (input.absenceAuthorized) return { kind: "closed" };
    const inspection = yield* inspectRetainedLaunch(ports, control, input);
    if (inspection.kind === "blocked") return { kind: "blocked", detail: inspection.detail };
    if (inspection.kind === "absent") return { kind: "closed" };
    const failure = yield* advanceLaunchCheckpoint(control, input.launch, inspection.identity);
    return failure === undefined ? { kind: "waiting" } : { kind: "blocked", detail: failure };
  });
}

function closeIdentity(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
  worker: WorkerIdentity,
): Effect.Effect<Closure, Stage, Requirements> {
  return Effect.gen(function* () {
    yield* control.checkOwnership;
    const result = yield* Effect.result(ports.workers.cleanup(worker));
    if (result._tag === "Failure") return { kind: "blocked", detail: result.failure.detail };
    if (result.success.state === "completed") return { kind: "closed" };
    if (result.success.state === "pending") return { kind: "waiting" };
    return { kind: "blocked", detail: result.success.detail };
  });
}

function reconcileCleanup(
  ports: CanonicalReconciliationPorts,
  entry: Extract<FrontierEntry, { kind: "cleanup" }>,
  control: ReconciliationControl,
): Effect.Effect<ReconciliationOutcome, Stage, Requirements> {
  return Effect.gen(function* () {
    const context = control.context();
    if (explicitRelease(context.attempt))
      return blocked("Retained output is in explicit release; cleanup never overrides it.");
    const placement = context.attempt.execution?.placement;
    if (placement === undefined)
      return blocked("Cleanup requires a durable placement declaration.");
    yield* ensureCleanupPending(control);
    const closure = yield* ensureWorkerClosed(ports, entry, placement, control);
    if (closure.kind === "blocked") return blocked(closure.detail);
    if (closure.kind === "waiting") return { kind: "waiting" };
    return yield* applyCleanupDisposition(ports, control, placement);
  });
}

function explicitRelease(attempt: Attempt): boolean {
  return attempt.outputRelease?.state === "pending" || attempt.outputRelease?.state === "blocked";
}

function ensureWorkerClosed(
  ports: CanonicalReconciliationPorts,
  entry: Extract<FrontierEntry, { kind: "cleanup" }>,
  placement: Placement,
  control: ReconciliationControl,
): Effect.Effect<Closure, Stage, Requirements> {
  return Effect.gen(function* () {
    if (control.context().attempt.cleanup?.workerClosed === true) return { kind: "closed" };
    const closure = yield* ensureClosure(
      ports,
      control,
      retainedLaunchInput(entry, placement.path, false),
    );
    if (closure.kind === "closed") yield* commitCleanup(control, { workerClosed: true });
    return closure;
  });
}

function applyCleanupDisposition(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
  placement: Placement,
): Effect.Effect<ReconciliationOutcome, Stage, Requirements> {
  return Effect.gen(function* () {
    const context = control.context();
    const disposition = outputDisposition(context.task, context.attempt);
    if (!requiresIsolatedCleanup(disposition, placement)) {
      yield* commitCleanup(control, { state: "completed", workerClosed: true }, true);
      return WAITING;
    }
    const observed = yield* checkpointExpectedHead(ports, control, placement);
    if (observed.kind === "blocked") return blocked(observed.detail);
    if (disposition.kind === "preserve_checkout") {
      yield* commitCleanup(control, {
        state: "blocked",
        workerClosed: true,
        expectedHead: observed.head,
        error: disposition.reason,
      });
      return blocked(disposition.reason);
    }
    return yield* performIsolatedCleanup(
      ports,
      control,
      context,
      disposition,
      placement,
      observed.head,
    );
  });
}

function requiresIsolatedCleanup(disposition: OutputDisposition, placement: Placement): boolean {
  if (placement.kind !== "isolated_worktree") return false;
  return disposition.kind !== "released" && disposition.kind !== "not_applicable";
}

function performIsolatedCleanup(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
  context: ReconciliationContext,
  disposition: OutputDisposition,
  placement: Placement,
  expectedHead: string,
): Effect.Effect<ReconciliationOutcome, Stage, Requirements> {
  return Effect.gen(function* () {
    if (placement.kind !== "isolated_worktree")
      return blocked("Isolated cleanup requires an exact isolated placement.");
    const base = persistedBase(context);
    const target: WorktreePlacement = { ...placement, baseCommit: base ?? expectedHead };
    yield* control.checkOwnership;
    const cleaned = yield* Effect.result(
      ports.git.cleanupWorktree(target, expectedHead, disposition.kind === "retain_branch"),
    );
    if (cleaned._tag === "Failure") return blocked(cleaned.failure.detail);
    yield* commitCleanup(control, { state: "completed", workerClosed: true, expectedHead }, true);
    return { kind: "waiting" };
  });
}

type ExpectedHeadObservation =
  | { readonly kind: "head"; readonly head: string }
  | { readonly kind: "blocked"; readonly detail: string };

/** Fence the exact observed isolated HEAD before any Git cleanup or preserve decision. */
function checkpointExpectedHead(
  ports: CanonicalReconciliationPorts,
  control: ReconciliationControl,
  placement: Placement,
): Effect.Effect<ExpectedHeadObservation, Stage, Requirements> {
  return Effect.gen(function* () {
    const known = control.context().attempt.cleanup?.expectedHead;
    if (known !== undefined) return { kind: "head", head: known };
    if (placement.kind !== "isolated_worktree")
      return {
        kind: "blocked",
        detail: "Isolated cleanup requires an exact expected HEAD; none could be established.",
      };
    const observed = yield* Effect.result(ports.git.currentHead(placement.path));
    if (observed._tag === "Failure")
      return {
        kind: "blocked",
        detail: `Isolated cleanup could not observe the exact worktree HEAD: ${observed.failure.detail}`,
      };
    yield* commitCleanup(control, { workerClosed: true, expectedHead: observed.success });
    return { kind: "head", head: observed.success };
  });
}

function ensureCleanupPending(
  control: ReconciliationControl,
): Effect.Effect<void, Stage, Requirements> {
  return Effect.gen(function* () {
    if (control.context().attempt.cleanup !== undefined) return;
    yield* commit(control, {
      kind: "checkpoint_cleanup",
      checkpoint: { state: "pending", workerClosed: false },
    });
  });
}

function commitCleanup(
  control: ReconciliationControl,
  patch: {
    readonly state?: "pending" | "blocked" | "completed";
    readonly workerClosed?: boolean;
    readonly expectedHead?: string;
    readonly error?: string;
  },
  finalize = false,
): Effect.Effect<void, Stage, Requirements> {
  return Effect.gen(function* () {
    const current = control.context().attempt.cleanup;
    if (finalize && current?.state === "completed") return;
    const state = patch.state ?? current?.state ?? "pending";
    const next: NonNullable<Attempt["cleanup"]> = {
      state,
      workerClosed: patch.workerClosed ?? current?.workerClosed ?? false,
    };
    const expectedHead = current?.expectedHead ?? patch.expectedHead;
    if (expectedHead !== undefined) next.expectedHead = expectedHead;
    if (state === "blocked") next.error = patch.error ?? current?.error ?? "Cleanup is blocked.";
    yield* control.commit({ kind: "checkpoint_cleanup", checkpoint: next });
  });
}

function deliverOutcome(
  ports: CanonicalReconciliationPorts,
  entry: Extract<FrontierEntry, { kind: "delivery" }>,
  control: ReconciliationControl,
): Effect.Effect<ReconciliationOutcome, Stage, Requirements> {
  return Effect.gen(function* () {
    const context = control.context();
    const outcome = context.attempt.outcome;
    if (outcome === undefined || outcome.id !== entry.outcomeId)
      return blocked("Pending delivery does not match the current Outcome.");
    if (outcome.delivery.state !== "pending") return { kind: "waiting" };
    yield* control.checkOwnership;
    const delivered = yield* Effect.result(ports.delivery.deliver(context));
    if (delivered._tag === "Success") {
      yield* commit(control, { kind: "record_delivery_success" });
      return { kind: "waiting" };
    }
    yield* commit(control, {
      kind: "record_delivery_failure",
      detail: delivered.failure.detail,
    });
    return { kind: "waiting" };
  });
}

function commit(
  control: ReconciliationControl,
  mutation: ReconciliationMutation,
): Effect.Effect<void, Stage, Requirements> {
  return control.commit(mutation).pipe(Effect.asVoid);
}

function requestedFields(checkpoint: CancellationCheckpoint) {
  return { requestedAt: checkpoint.requestedAt, reason: checkpoint.reason };
}

function dispatchAt(checkpoint: CancellationCheckpoint): string {
  return checkpoint.state === "requested" ? checkpoint.requestedAt : checkpoint.dispatchAt;
}

function resourceCheckpoint(resource: {
  workspaceId: string;
  tabId: string;
  paneId: string;
  terminalId: string;
  agentName: string;
  cwd: string;
}): Extract<NonNullable<WorkerExecution["launch"]>, { phase: "resource" }> {
  return {
    phase: "resource",
    workspaceId: resource.workspaceId,
    tabId: resource.tabId,
    paneId: resource.paneId,
    terminalId: resource.terminalId,
    agentName: resource.agentName,
    cwd: resource.cwd,
  };
}

function readyCheckpoint(
  identity: WorkerIdentity,
): Extract<NonNullable<WorkerExecution["launch"]>, { phase: "ready" }> {
  return {
    phase: "ready",
    workspaceId: identity.workspaceId,
    tabId: identity.tabId,
    paneId: identity.paneId,
    terminalId: identity.terminalId,
    agentName: identity.agentName,
    cwd: identity.cwd,
  };
}

function launchInspectionRequest(
  launch: NonNullable<WorkerExecution["launch"]>,
  sessionFile: string,
  cwd: string,
): WorkerLaunchInspectionRequest {
  const request: WorkerLaunchInspectionRequest = {
    workspaceId: launch.workspaceId,
    paneId: launch.paneId,
    sessionFile,
    cwd,
  };
  if (launch.phase !== "pane") {
    request.tabId = launch.tabId;
    request.terminalId = launch.terminalId;
  }
  return request;
}

interface SelectedGuideModel {
  readonly model: string;
  readonly thinking?: ThinkingLevel;
}

function guideModel(context: ReconciliationContext): SelectedGuideModel {
  const selection = context.attempt.selection;
  if ("guide" in selection)
    return { model: selection.guide.model, thinking: selection.guide.thinking };
  return { model: selection.target.model, thinking: selection.target.thinking };
}

/** Map one exact immutable context into the single concrete canonical assignment. */
function assignmentFor(
  ports: CanonicalReconciliationPorts,
  context: ReconciliationContext,
  cwd: string,
): CanonicalWorkerAssignment {
  const assignment: CanonicalAssignmentInput = {
    task: context.task,
    intent: context.intent.value,
    intentIndex: context.intent.index,
    repositoryRoot: context.repository.projectRoot,
    workerCwd: cwd,
    runId: context.workstreamId,
    attemptId: context.attempt.id,
  };
  const base = persistedBase(context);
  if (base !== undefined) assignment.baseRevision = base;
  if (context.attempt.candidate !== undefined) assignment.candidate = context.attempt.candidate;
  if (context.reviewInput !== undefined) assignment.reviewSubject = context.reviewInput;
  const selection = context.attempt.selection;
  if ("executor" in selection)
    assignment.executor =
      selection.executor.thinking === undefined
        ? { model: selection.executor.model }
        : { model: selection.executor.model, thinking: selection.executor.thinking };
  if (ports.host.codingAgentDir !== undefined)
    assignment.codingAgentDir = ports.host.codingAgentDir;
  if (context.attempt.continuationOf !== undefined)
    assignment.continuationOf = context.attempt.continuationOf;
  return canonicalWorkerAssignment(assignment);
}

function absentDetail(failure: NativeFailureCategory | undefined): string {
  switch (failure) {
    case "provider-rate-limit":
      return "Pi settled without a current-attempt report after a provider rate limit.";
    case "native-abort":
      return "Pi settled without a current-attempt report after the native turn was aborted.";
    case "native-error":
      return "Pi settled without a current-attempt report after a native provider error.";
    case undefined:
      return "Pi settled without a current-attempt report.";
  }
}

function blocked(detail: string): ReconciliationOutcome {
  return { kind: "blocked", detail };
}

function nowIso(): Effect.Effect<string> {
  return Clock.clockWith((clock) =>
    Effect.sync(() =>
      DateTime.toDate(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe())).toISOString(),
    ),
  );
}
