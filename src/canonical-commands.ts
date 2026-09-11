import { Data, Effect } from "effect";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import type {
  CanonicalAppendCommand,
  CanonicalEnqueueCommand,
  ResolvedQueueFacts,
} from "./canonical-queue.js";
import {
  type Attempt,
  type AttemptKey,
  changedImplementationCommit,
  findAttemptLocation,
  findTask,
  IntentSchema,
  isRetainedCandidateParent,
  type Task,
  type Workstream,
} from "./domain/workstream.js";
import type {
  CandidateApplicationDestination,
  CandidateApplicationSource,
  PreparedCandidateApplication,
  ValidatedCandidate,
  WorktreeCleanupResult,
  WorktreePlacement,
} from "./git.js";
import { EvidenceInputSchema } from "./report-schema.js";
import type { WorkerIdentity } from "./types.js";

const NonEmptyString = Type.String({ minLength: 1 });
const AttemptHandle = { attemptId: NonEmptyString };
export const ReviseIntentCommandSchema = IntentSchema;
export const CompleteCommandSchema = Type.Object(
  {
    conclusion: NonEmptyString,
    evidence: Type.Array(EvidenceInputSchema, { minItems: 1 }),
    limitations: Type.Array(NonEmptyString),
  },
  { additionalProperties: false },
);
export const SuspendCommandSchema = Type.Object(
  { reason: NonEmptyString },
  { additionalProperties: false },
);
export const ResumeCommandSchema = Type.Object({}, { additionalProperties: false });
export const CancelCommandSchema = Type.Object(
  { ...AttemptHandle, reason: NonEmptyString },
  { additionalProperties: false },
);
export const SteerCommandSchema = Type.Object(
  { ...AttemptHandle, instruction: NonEmptyString },
  { additionalProperties: false },
);
export const ApplyCommandSchema = Type.Object(AttemptHandle, { additionalProperties: false });
export const ReleaseOutputCommandSchema = Type.Object(
  { ...AttemptHandle, reason: NonEmptyString },
  { additionalProperties: false },
);
export type CompleteCommand = Static<typeof CompleteCommandSchema>;
export type SuspendCommand = Static<typeof SuspendCommandSchema>;
export type ResumeCommand = Static<typeof ResumeCommandSchema>;
export type CancelCommand = Static<typeof CancelCommandSchema>;
export type SteerCommand = Static<typeof SteerCommandSchema>;
export type ApplyCommand = Static<typeof ApplyCommandSchema>;
export type ReleaseOutputCommand = Static<typeof ReleaseOutputCommandSchema>;

export class CanonicalCommandError extends Data.TaggedError("CanonicalCommandError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

type CommandEffect<A> = Effect.Effect<A, CanonicalCommandError>;
export interface CanonicalCommandGitPort {
  readonly resolveRevision: (revision: string) => CommandEffect<string>;
  readonly head: CommandEffect<string>;
  readonly cleanHead: CommandEffect<string>;
  readonly validateCandidate: (
    placement: WorktreePlacement,
    rootCommit: string,
    commit: string,
  ) => CommandEffect<ValidatedCandidate>;
  readonly preflightCandidateApplication: (
    source: CandidateApplicationSource,
  ) => CommandEffect<CandidateApplicationDestination>;
  readonly prepareCandidateApplication: (
    source: CandidateApplicationSource,
    destination: CandidateApplicationDestination,
  ) => CommandEffect<PreparedCandidateApplication>;
  readonly recoverCandidateApplication: (
    destination: CandidateApplicationDestination,
    source: CandidateApplicationSource,
  ) => CommandEffect<{ head: string } | undefined>;
  readonly applyCandidate: (prepared: PreparedCandidateApplication) => CommandEffect<string>;
  readonly releaseOutput: (
    placement: WorktreePlacement,
    expectedHead: string,
  ) => CommandEffect<WorktreeCleanupResult>;
}
export interface CanonicalCommandWorkerPort {
  readonly steer: (identity: WorkerIdentity, instruction: string) => CommandEffect<void>;
}
export interface CanonicalCommandPorts {
  readonly git: CanonicalCommandGitPort;
  readonly workers: CanonicalCommandWorkerPort;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Explicit command values are decoded by the supplied strict TypeBox schema.
export function decodeCommand<A>(schema: TSchema, value: unknown, label: string): A {
  if (!Value.Check(schema, value)) {
    const issue = Value.Errors(schema, value)[0];
    const location =
      issue?.instancePath !== undefined && issue.instancePath !== "" ? issue.instancePath : "/";
    throw new Error(`Invalid ${label} at ${location}: ${issue?.message ?? "schema mismatch"}.`);
  }
  // SAFETY: strict schema validation above establishes the caller-owned decoded type.
  return Value.Decode(schema, value) as A;
}

export function decodeCommandEffect<A>(
  schema: TSchema,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The supplied strict schema owns this external command boundary.
  value: unknown,
  label: string,
): CommandEffect<A> {
  return Effect.try({
    try: () => decodeCommand<A>(schema, value, label),
    catch: (cause) =>
      commandFailure(
        "decode explicit command",
        cause instanceof Error ? cause.message : "Invalid command.",
        cause,
      ),
  });
}

export interface ExactAttempt {
  readonly key: AttemptKey;
  readonly task: Task;
  readonly attempt: Attempt;
}

export function exactAttempt(workstream: Workstream, attemptId: string): ExactAttempt {
  const located = findAttemptLocation(workstream, attemptId);
  if (located === undefined) throw new Error(`Unknown Attempt ${attemptId}.`);
  return { key: { taskId: located.task.id, attemptId }, ...located };
}

export function exactAttemptEffect(
  workstream: Workstream,
  attemptId: string,
): CommandEffect<ExactAttempt> {
  return Effect.try({
    try: () => exactAttempt(workstream, attemptId),
    catch: (cause) =>
      commandFailure(
        "resolve Attempt",
        cause instanceof Error ? cause.message : "Unknown Attempt.",
        cause,
      ),
  });
}

export function enqueueFacts(
  workstream: Workstream,
  command: CanonicalEnqueueCommand,
  git: CanonicalCommandGitPort | undefined,
): CommandEffect<ResolvedQueueFacts> {
  return Effect.gen(function* () {
    if (command.kind === "experiment") {
      const port = yield* requireGit(git);
      return { baseRevision: yield* resolvedBase(port, command.baseRevision) };
    }
    if (command.kind === "implementation") {
      const port = yield* requireGit(git);
      if (command.candidateOf !== undefined)
        return yield* candidateFacts(
          workstream,
          candidateRequest(command.candidateOf, command.baseRevision),
          port,
        );
      const baseRevision = yield* resolvedBase(port, command.baseRevision);
      return { baseRevision, candidate: { kind: "initial", rootCommit: baseRevision } };
    }
    if (command.kind !== "review" || command.subject.kind !== "revision") return {};
    const port = yield* requireGit(git);
    const baseRevision = yield* exactRevision(port, command.subject.revision);
    if (baseRevision !== command.subject.revision)
      return yield* commandFailure(
        "resolve review revision",
        "Revision review subject did not resolve to its exact supplied commit.",
      );
    return { baseRevision };
  });
}

export function appendFacts(
  workstream: Workstream,
  command: CanonicalAppendCommand,
  git: CanonicalCommandGitPort | undefined,
): CommandEffect<ResolvedQueueFacts> {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: kind-owned preflight stays explicit so incompatible fields cannot share Git behavior.
  return Effect.gen(function* () {
    const task = findTask(workstream, command.taskId);
    if (task === undefined)
      return yield* commandFailure("append Attempt", `Unknown Task ${command.taskId}.`);
    if (command.continuationOf !== undefined) {
      const continuationError = continuationFailure(task, command.continuationOf);
      if (continuationError !== undefined) return yield* continuationError;
    }
    if (task.kind === "experiment") {
      const port = yield* requireGit(git);
      return { baseRevision: yield* resolvedBase(port, command.baseRevision) };
    }
    if (task.kind === "review" && task.subject.kind === "revision")
      return { baseRevision: task.subject.revision };
    if (task.kind !== "implementation") return {};
    const port = yield* requireGit(git);
    if (command.candidateOf === undefined) {
      const baseRevision = yield* resolvedBase(port, command.baseRevision);
      return { baseRevision, candidate: { kind: "initial", rootCommit: baseRevision } };
    }
    return yield* candidateFacts(
      workstream,
      candidateRequest(command.candidateOf, command.baseRevision),
      port,
    );
  });
}

function candidateFacts(
  workstream: Workstream,
  command: { readonly candidateOf: string; readonly baseRevision?: string },
  commandGit: CanonicalCommandGitPort,
): CommandEffect<ResolvedQueueFacts> {
  return Effect.gen(function* () {
    const { parent, parentCommit, rootCommit, placement } = yield* retainedCandidate(
      workstream,
      command.candidateOf,
    );
    const validated = yield* commandGit.validateCandidate(placement, rootCommit, parentCommit);
    if (validated.commit !== parentCommit || validated.rootCommit !== rootCommit)
      return yield* commandFailure(
        "append candidate",
        "Retained candidate Git lineage does not match canonical state.",
      );
    const requestedBase =
      command.baseRevision === undefined
        ? parentCommit
        : yield* exactRevision(commandGit, command.baseRevision);
    if (requestedBase === parentCommit)
      return {
        baseRevision: parentCommit,
        candidate: {
          kind: "correction",
          rootCommit,
          parentAttemptId: parent.id,
          parentCommit,
        },
      };
    const head = yield* commandGit.cleanHead;
    if (requestedBase !== head)
      return yield* commandFailure(
        "append candidate",
        `Integration base ${requestedBase} is not clean destination HEAD ${head}.`,
      );
    return {
      baseRevision: requestedBase,
      candidate: {
        kind: "integration",
        rootCommit: requestedBase,
        parentAttemptId: parent.id,
        parentCommit,
      },
    };
  });
}

function candidateRequest(
  candidateOf: string,
  baseRevision: string | undefined,
): { readonly candidateOf: string; readonly baseRevision?: string } {
  return baseRevision === undefined ? { candidateOf } : { candidateOf, baseRevision };
}

function retainedCandidate(
  workstream: Workstream,
  attemptId: string,
): CommandEffect<{
  readonly parent: Attempt;
  readonly parentCommit: string;
  readonly rootCommit: string;
  readonly placement: WorktreePlacement;
}> {
  const located = findAttemptLocation(workstream, attemptId);
  if (located === undefined) return Effect.fail(ineligibleCandidate(attemptId));
  const parent = located.attempt;
  const parentCommit = changedImplementationCommit(parent);
  const candidate = parent.candidate;
  const baseCommit = parent.baseRevision;
  const placement = parent.execution?.placement;
  if (
    parentCommit === undefined ||
    !isRetainedCandidateParent(located.task, parent, parentCommit) ||
    candidate === undefined ||
    baseCommit === undefined ||
    placement?.kind !== "isolated_worktree"
  )
    return Effect.fail(ineligibleCandidate(attemptId));
  return Effect.succeed({
    parent,
    parentCommit,
    rootCommit: candidate.rootCommit,
    placement: { ...placement, baseCommit },
  });
}

function ineligibleCandidate(attemptId: string): CanonicalCommandError {
  return commandFailure(
    "append candidate",
    `Attempt ${attemptId} is not an eligible retained implementation parent.`,
  );
}

function requireGit(
  git: CanonicalCommandGitPort | undefined,
): CommandEffect<CanonicalCommandGitPort> {
  return git === undefined
    ? Effect.fail(
        commandFailure("canonical queue preflight", "Canonical Git command port is unavailable."),
      )
    : Effect.succeed(git);
}

function continuationFailure(
  task: NonNullable<ReturnType<typeof findTask>>,
  attemptId: string,
): CanonicalCommandError | undefined {
  const parent = task.attempts.find((attempt) => attempt.id === attemptId);
  return parent?.state === "finished" &&
    parent.execution?.sessionFile !== undefined &&
    parent.cleanup?.state === "completed" &&
    parent.cleanup.workerClosed
    ? undefined
    : commandFailure(
        "append continuation",
        `Attempt ${attemptId} is not an exact retained closed continuation parent.`,
      );
}

function resolvedBase(
  git: CanonicalCommandGitPort,
  revision: string | undefined,
): CommandEffect<string> {
  return revision === undefined ? exactHead(git) : exactRevision(git, revision);
}

function exactHead(git: CanonicalCommandGitPort): CommandEffect<string> {
  return git.head.pipe(
    Effect.filterOrFail(
      (head) => /^[0-9a-f]{40,64}$/.test(head),
      () => commandFailure("resolve Git HEAD", "Git did not return an exact HEAD."),
    ),
  );
}

function exactRevision(git: CanonicalCommandGitPort, revision: string): CommandEffect<string> {
  return Effect.gen(function* () {
    const resolved = yield* git.resolveRevision(revision);
    if (!/^[0-9a-f]{40,64}$/.test(resolved))
      return yield* commandFailure("resolve Git revision", "Git did not return an exact revision.");
    return resolved;
  });
}

export function commandFailure(
  operation: string,
  message: string,
  cause?: unknown,
): CanonicalCommandError {
  return new CanonicalCommandError(
    cause === undefined ? { operation, message } : { operation, message, cause },
  );
}

export function workerIdentity(attempt: Attempt): WorkerIdentity {
  const launch = attempt.execution?.launch;
  const sessionFile = attempt.execution?.sessionFile;
  if (attempt.state !== "active" || launch?.phase !== "ready" || sessionFile === undefined)
    throw new Error(`Attempt ${attempt.id} has no active ready Worker.`);
  return {
    workspaceId: launch.workspaceId,
    tabId: launch.tabId,
    paneId: launch.paneId,
    terminalId: launch.terminalId,
    agentName: launch.agentName,
    cwd: launch.cwd,
    sessionFile,
  };
}
