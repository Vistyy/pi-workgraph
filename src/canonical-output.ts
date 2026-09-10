import { Effect } from "effect";
import {
  type ApplyCommand,
  ApplyCommandSchema,
  type CanonicalCommandError,
  type CanonicalCommandPorts,
  commandFailure,
  decodeCommandEffect,
  exactAttempt,
  exactAttemptEffect,
  type ReleaseOutputCommand,
  ReleaseOutputCommandSchema,
} from "./canonical-commands.js";
import {
  changedImplementationCommit,
  checkpointApplication,
  checkpointCleanup,
  checkpointOutputRelease,
  type Placement,
  type Workstream,
} from "./domain/workstream.js";
import type { CandidateApplicationSource, WorktreePlacement } from "./git.js";

export interface MaintainedOutputControl<E, R> {
  readonly state: Effect.Effect<Workstream, E, R>;
  readonly commit: (
    operation: string,
    key: ReturnType<typeof exactAttempt>["key"],
    plan: (state: Workstream) => Workstream,
  ) => Effect.Effect<Workstream, E, R>;
  readonly fence: Effect.Effect<void, E, R>;
  readonly now: Effect.Effect<string, never, R>;
  readonly ports: CanonicalCommandPorts;
}

export function applyMaintainedOutput<E, R>(
  control: MaintainedOutputControl<E, R>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The strict application schema owns this external command boundary.
  value: unknown,
): Effect.Effect<Workstream, E | CanonicalCommandError, R> {
  return Effect.gen(function* () {
    const input = yield* decodeCommandEffect<ApplyCommand>(
      ApplyCommandSchema,
      value,
      "application command",
    );
    let state = yield* control.state;
    const located = yield* locate(state, input.attemptId);
    if (state.lifecycle === "active" && located.task.intentIndex !== state.intents.length - 1)
      return yield* failure(
        "apply candidate",
        `Attempt ${input.attemptId} does not belong to the current Intent.`,
      );
    let application = located.attempt.application;
    if (application?.state === "applied")
      return yield* releaseMaintainedOutput(control, {
        attemptId: input.attemptId,
        reason: located.attempt.outputRelease?.reason ?? "Applied maintained candidate.",
      });
    const source = yield* sourceFor(control, located.attempt);
    if (application === undefined) {
      const destination = yield* control.ports.git.preflightCandidateApplication(source);
      const now = yield* control.now;
      state = yield* control.commit("checkpoint candidate application", located.key, (current) =>
        checkpointApplication(
          current,
          located.key,
          {
            state: "pending",
            commit: source.commit,
            rootCommit: source.rootCommit,
            commits: [...source.commits],
            expectedRef: destination.expectedRef,
            expectedHead: destination.expectedHead,
          },
          now,
        ),
      );
      application = exactAttempt(state, input.attemptId).attempt.application;
    }
    if (application === undefined || application.expectedRef === undefined)
      return yield* failure(
        "apply candidate",
        "Candidate application has no exact destination checkpoint.",
      );
    const destination = {
      expectedRef: application.expectedRef,
      expectedHead: application.expectedHead,
    };
    if (application.state !== "applied")
      state = yield* resumeApplication(control, state, input.attemptId, source, destination);
    return yield* releaseMaintainedOutput(control, {
      attemptId: input.attemptId,
      reason:
        exactAttempt(state, input.attemptId).attempt.outputRelease?.reason ??
        "Applied maintained candidate.",
    });
  });
}

function resumeApplication<E, R>(
  control: MaintainedOutputControl<E, R>,
  state: Workstream,
  attemptId: string,
  source: CandidateApplicationSource,
  destination: { readonly expectedRef: string; readonly expectedHead: string },
): Effect.Effect<Workstream, E | CanonicalCommandError, R> {
  return Effect.gen(function* () {
    const recovered = yield* Effect.result(
      control.ports.git.recoverCandidateApplication(destination, source),
    );
    if (recovered._tag === "Failure") {
      yield* blockedApplication(control, state, attemptId, recovered.failure.message);
      return yield* recovered.failure;
    }
    if (recovered.success !== undefined)
      return yield* appliedCheckpoint(control, state, attemptId, recovered.success.head);

    yield* control.fence;
    state = yield* control.state;
    const located = yield* locate(state, attemptId);
    source = yield* sourceFor(control, located.attempt);
    const prepared = yield* Effect.result(
      control.ports.git.prepareCandidateApplication(source, destination),
    );
    if (prepared._tag === "Failure")
      return yield* failApplication(
        control,
        state,
        attemptId,
        source,
        destination,
        prepared.failure,
      );

    yield* control.fence;
    const applied = yield* Effect.result(control.ports.git.applyCandidate(prepared.success));
    return applied._tag === "Success"
      ? yield* appliedCheckpoint(control, state, attemptId, applied.success)
      : yield* failApplication(control, state, attemptId, source, destination, applied.failure);
  });
}

function failApplication<E, R>(
  control: MaintainedOutputControl<E, R>,
  state: Workstream,
  attemptId: string,
  source: CandidateApplicationSource,
  destination: { readonly expectedRef: string; readonly expectedHead: string },
  failure: CanonicalCommandError,
): Effect.Effect<never, E | CanonicalCommandError, R> {
  return Effect.gen(function* () {
    const classification = yield* Effect.result(
      control.ports.git.recoverCandidateApplication(destination, source),
    );
    if (classification._tag === "Success" && classification.success !== undefined)
      yield* appliedCheckpoint(control, state, attemptId, classification.success.head);
    else if (classification._tag === "Failure")
      yield* blockedApplication(control, state, attemptId, classification.failure.message);
    return yield* failure;
  });
}

export function releaseMaintainedOutput<E, R>(
  control: MaintainedOutputControl<E, R>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The strict release schema owns this external command boundary.
  value: unknown,
): Effect.Effect<Workstream, E | CanonicalCommandError, R> {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: every branch preserves one destructive-release fence or durable checkpoint.
  return Effect.gen(function* () {
    const input = yield* decodeCommandEffect<ReleaseOutputCommand>(
      ReleaseOutputCommandSchema,
      value,
      "output release command",
    );
    let state = yield* control.state;
    const located = yield* locate(state, input.attemptId);
    const attempt = located.attempt;
    const placement = attempt.execution?.placement;
    const expectedHead = attempt.cleanup?.expectedHead;
    if (
      placement?.kind !== "isolated_worktree" ||
      expectedHead === undefined ||
      attempt.cleanup?.workerClosed !== true
    )
      return yield* failure(
        "release output",
        `Attempt ${input.attemptId} has no exact closed isolated output.`,
      );
    if (attempt.outputRelease?.state === "completed")
      return yield* completeReleasedCleanup(control, state, located.key, expectedHead);
    const reason = attempt.outputRelease?.reason ?? input.reason;
    if (attempt.outputRelease !== undefined && reason !== input.reason)
      return yield* failure(
        "release output",
        `Attempt ${input.attemptId} has a release checkpoint with another reason.`,
      );
    if (attempt.outputRelease === undefined) {
      const now = yield* control.now;
      state = yield* control.commit("checkpoint pending output release", located.key, (current) =>
        checkpointOutputRelease(
          current,
          located.key,
          { state: "pending", expectedHead, reason },
          now,
        ),
      );
    }
    yield* control.fence;
    const released = yield* Effect.result(
      control.ports.git.releaseOutput(
        placementFor(placement, attempt.baseRevision ?? expectedHead),
        expectedHead,
      ),
    );
    yield* control.fence;
    const now = yield* control.now;
    if (released._tag === "Failure") {
      yield* control.commit("checkpoint blocked output release", located.key, (current) =>
        checkpointOutputRelease(
          current,
          located.key,
          { state: "blocked", expectedHead, reason, error: released.failure.message },
          now,
        ),
      );
      return yield* released.failure;
    }
    if (released.success.state === "blocked") {
      state = yield* control.commit("checkpoint blocked output release", located.key, (current) =>
        checkpointOutputRelease(
          current,
          located.key,
          { state: "blocked", expectedHead, reason, error: released.success.detail },
          now,
        ),
      );
      return state;
    }
    state = yield* control.commit("checkpoint completed output release", located.key, (current) =>
      checkpointOutputRelease(
        current,
        located.key,
        { state: "completed", expectedHead, reason },
        now,
      ),
    );
    return yield* completeReleasedCleanup(control, state, located.key, expectedHead, now);
  });
}

function completeReleasedCleanup<E, R>(
  control: MaintainedOutputControl<E, R>,
  state: Workstream,
  key: ReturnType<typeof exactAttempt>["key"],
  expectedHead: string,
  completedAt?: string,
): Effect.Effect<Workstream, E | CanonicalCommandError, R> {
  return Effect.gen(function* () {
    const cleanup = exactAttempt(state, key.attemptId).attempt.cleanup;
    if (cleanup?.state === "completed") return state;
    if (cleanup?.workerClosed !== true || cleanup.expectedHead !== expectedHead)
      return yield* failure(
        "release output",
        `Attempt ${key.attemptId} released output does not match its closed cleanup checkpoint.`,
      );
    const now = completedAt ?? (yield* control.now);
    return yield* control.commit("complete released output cleanup", key, (current) =>
      checkpointCleanup(
        current,
        key,
        { state: "completed", expectedHead, workerClosed: true },
        now,
      ),
    );
  });
}

function sourceFor<E, R>(
  control: MaintainedOutputControl<E, R>,
  attempt: ReturnType<typeof exactAttempt>["attempt"],
): Effect.Effect<CandidateApplicationSource, CanonicalCommandError, R> {
  return Effect.gen(function* () {
    const commit = changedImplementationCommit(attempt);
    const candidate = attempt.candidate;
    const placement = attempt.execution?.placement;
    if (
      commit === undefined ||
      candidate === undefined ||
      attempt.baseRevision === undefined ||
      placement?.kind !== "isolated_worktree" ||
      attempt.cleanup?.workerClosed !== true ||
      attempt.cleanup.state !== "completed"
    )
      return yield* failure(
        "apply candidate",
        `Attempt ${attempt.id} is not an exact retained changed implementation.`,
      );
    const validated = yield* control.ports.git.validateCandidate(
      placementFor(placement, attempt.baseRevision),
      candidate.rootCommit,
      commit,
    );
    if (validated.commit !== commit || validated.rootCommit !== candidate.rootCommit)
      return yield* failure(
        "apply candidate",
        "Validated candidate differs from canonical lineage.",
      );
    return {
      rootCommit: validated.rootCommit,
      commit: validated.commit,
      commits: [...validated.commits],
    };
  });
}

function appliedCheckpoint<E, R>(
  control: MaintainedOutputControl<E, R>,
  state: Workstream,
  attemptId: string,
  revision: string,
): Effect.Effect<Workstream, E | CanonicalCommandError, R> {
  return Effect.gen(function* () {
    const located = yield* locate(state, attemptId);
    const application = located.attempt.application;
    if (application === undefined)
      return yield* failure("apply candidate", "Missing pending application checkpoint.");
    const now = yield* control.now;
    const { error: _error, ...identity } = application;
    return yield* control.commit("checkpoint applied candidate", located.key, (current) =>
      checkpointApplication(current, located.key, { ...identity, state: "applied", revision }, now),
    );
  });
}

function blockedApplication<E, R>(
  control: MaintainedOutputControl<E, R>,
  state: Workstream,
  attemptId: string,
  error: string,
): Effect.Effect<Workstream, E | CanonicalCommandError, R> {
  return Effect.gen(function* () {
    const located = yield* locate(state, attemptId);
    const application = located.attempt.application;
    if (application === undefined)
      return yield* failure("apply candidate", "Missing pending application checkpoint.");
    const now = yield* control.now;
    const { revision: _revision, ...identity } = application;
    return yield* control.commit(
      "checkpoint blocked candidate application",
      located.key,
      (current) =>
        checkpointApplication(current, located.key, { ...identity, state: "blocked", error }, now),
    );
  });
}

function placementFor(
  placement: Extract<Placement, { kind: "isolated_worktree" }>,
  baseCommit: string,
): WorktreePlacement {
  return { path: placement.path, branch: placement.branch, baseCommit };
}

function locate(
  state: Workstream,
  id: string,
): Effect.Effect<ReturnType<typeof exactAttempt>, CanonicalCommandError> {
  return exactAttemptEffect(state, id);
}

function failure(operation: string, message: string, cause?: unknown): CanonicalCommandError {
  return commandFailure(operation, message, cause);
}
