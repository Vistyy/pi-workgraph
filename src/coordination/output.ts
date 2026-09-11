import { Effect } from "effect";
import {
  changedImplementationCommit,
  checkpointApplication,
  checkpointCleanup,
  checkpointOutputDisposition,
  type Placement,
  type Workstream,
} from "../domain/workstream.js";
import type { CandidateApplicationSource, WorktreePlacement } from "../git.js";
import {
  type ApplyCommand,
  ApplyCommandSchema,
  commandFailure,
  type DiscardOutputCommand,
  DiscardOutputCommandSchema,
  decodeCommandEffect,
  exactAttempt,
  exactAttemptEffect,
  type WorkstreamCommandError,
  type WorkstreamCommandPorts,
} from "./commands.js";

export interface MaintainedOutputControl<E, R> {
  readonly state: (attemptId: string) => Effect.Effect<Workstream, E, R>;
  readonly commit: (
    operation: string,
    key: ReturnType<typeof exactAttempt>["key"],
    plan: (state: Workstream) => Workstream,
  ) => Effect.Effect<Workstream, E, R>;
  readonly fence: Effect.Effect<void, E, R>;
  readonly now: Effect.Effect<string, never, R>;
  readonly ports: WorkstreamCommandPorts;
}

export function applyMaintainedOutput<E, R>(
  control: MaintainedOutputControl<E, R>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The strict application schema owns this external command boundary.
  value: unknown,
): Effect.Effect<Workstream, E | WorkstreamCommandError, R> {
  return Effect.gen(function* () {
    const input = yield* decodeCommandEffect<ApplyCommand>(
      ApplyCommandSchema,
      value,
      "application command",
    );
    let state = yield* control.state(input.attemptId);
    const located = yield* locate(state, input.attemptId);
    if (state.lifecycle !== "completed" && located.task.intentIndex !== state.intents.length - 1)
      return yield* failure(
        "apply candidate",
        `Attempt ${input.attemptId} does not belong to the current Intent.`,
      );
    if (located.attempt.outputDisposition?.kind === "discarded")
      return yield* failure(
        "apply candidate",
        `Attempt ${input.attemptId} output is committed to discard, not application.`,
      );
    let application = located.attempt.application;
    if (application?.state === "applied")
      return yield* disposeMaintainedOutput(
        control,
        input.attemptId,
        "applied",
        located.attempt.outputDisposition?.reason ?? "Applied maintained candidate.",
      );
    const source = yield* sourceFor(control, located.attempt);
    if (application === undefined) {
      const destination = yield* control.ports.git.inspectCandidateApplication(source);
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
    if (application === undefined)
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
    return yield* disposeMaintainedOutput(
      control,
      input.attemptId,
      "applied",
      exactAttempt(state, input.attemptId).attempt.outputDisposition?.reason ??
        "Applied maintained candidate.",
    );
  });
}

function resumeApplication<E, R>(
  control: MaintainedOutputControl<E, R>,
  state: Workstream,
  attemptId: string,
  source: CandidateApplicationSource,
  destination: { readonly expectedRef: string; readonly expectedHead: string },
): Effect.Effect<Workstream, E | WorkstreamCommandError, R> {
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
    state = yield* control.state(attemptId);
    const located = yield* locate(state, attemptId);
    source = yield* sourceFor(control, located.attempt);
    const applied = yield* Effect.result(control.ports.git.applyCandidate(source, destination));
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
  failure: WorkstreamCommandError,
): Effect.Effect<never, E | WorkstreamCommandError, R> {
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

export function discardMaintainedOutput<E, R>(
  control: MaintainedOutputControl<E, R>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The strict discard schema owns this external command boundary.
  value: unknown,
): Effect.Effect<Workstream, E | WorkstreamCommandError, R> {
  return Effect.gen(function* () {
    const input = yield* decodeCommandEffect<DiscardOutputCommand>(
      DiscardOutputCommandSchema,
      value,
      "output discard command",
    );
    return yield* disposeMaintainedOutput(control, input.attemptId, "discarded", input.reason);
  });
}

function disposeMaintainedOutput<E, R>(
  control: MaintainedOutputControl<E, R>,
  attemptId: string,
  kind: "applied" | "discarded",
  requestedReason: string,
): Effect.Effect<Workstream, E | WorkstreamCommandError, R> {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: every branch preserves one destructive-disposition fence or durable checkpoint.
  return Effect.gen(function* () {
    let state = yield* control.state(attemptId);
    const located = yield* locate(state, attemptId);
    if (state.lifecycle !== "completed" && located.task.intentIndex !== state.intents.length - 1)
      return yield* failure(
        "dispose output",
        `Attempt ${attemptId} does not belong to the current Intent.`,
      );
    const attempt = located.attempt;
    if (kind === "discarded" && attempt.application !== undefined)
      return yield* failure(
        "dispose output",
        `Attempt ${attemptId} output is committed to application, not discard.`,
      );
    const placement = attempt.execution?.placement;
    const expectedHead = attempt.cleanup?.expectedHead;
    if (
      placement?.kind !== "isolated_worktree" ||
      expectedHead === undefined ||
      attempt.cleanup?.workerClosed !== true
    )
      return yield* failure(
        "dispose output",
        `Attempt ${attemptId} has no exact closed isolated output.`,
      );
    const disposition = attempt.outputDisposition;
    const reason = disposition?.reason ?? requestedReason;
    if (disposition !== undefined && disposition.kind !== kind)
      return yield* failure(
        "dispose output",
        `Attempt ${attemptId} already has a different output disposition checkpoint.`,
      );
    if (disposition?.state === "completed")
      return yield* completeDisposedCleanup(control, state, located.key, expectedHead);
    if (disposition === undefined) {
      const now = yield* control.now;
      state = yield* control.commit(
        "checkpoint pending output disposition",
        located.key,
        (current) =>
          checkpointOutputDisposition(
            current,
            located.key,
            { kind, state: "pending", expectedHead, reason },
            now,
          ),
      );
    }
    yield* control.fence;
    const discarded = yield* Effect.result(
      control.ports.git.discardOutput(
        placementFor(placement, attempt.baseRevision ?? expectedHead),
        expectedHead,
      ),
    );
    yield* control.fence;
    const now = yield* control.now;
    if (discarded._tag === "Failure") {
      yield* control.commit("checkpoint blocked output disposition", located.key, (current) =>
        checkpointOutputDisposition(
          current,
          located.key,
          { kind, state: "blocked", expectedHead, reason, error: discarded.failure.message },
          now,
        ),
      );
      return yield* discarded.failure;
    }
    state = yield* control.commit(
      "checkpoint completed output disposition",
      located.key,
      (current) =>
        checkpointOutputDisposition(
          current,
          located.key,
          { kind, state: "completed", expectedHead, reason },
          now,
        ),
    );
    return yield* completeDisposedCleanup(control, state, located.key, expectedHead, now);
  });
}

function completeDisposedCleanup<E, R>(
  control: MaintainedOutputControl<E, R>,
  state: Workstream,
  key: ReturnType<typeof exactAttempt>["key"],
  expectedHead: string,
  completedAt?: string,
): Effect.Effect<Workstream, E | WorkstreamCommandError, R> {
  return Effect.gen(function* () {
    if (exactAttempt(state, key.attemptId).attempt.cleanup?.state === "completed") return state;
    const now = completedAt ?? (yield* control.now);
    return yield* control.commit("complete disposed output cleanup", key, (current) =>
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
): Effect.Effect<CandidateApplicationSource, WorkstreamCommandError, R> {
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
        "Validated candidate differs from workstream lineage.",
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
): Effect.Effect<Workstream, E | WorkstreamCommandError, R> {
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
): Effect.Effect<Workstream, E | WorkstreamCommandError, R> {
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
): Effect.Effect<ReturnType<typeof exactAttempt>, WorkstreamCommandError> {
  return exactAttemptEffect(state, id);
}

function failure(operation: string, message: string, cause?: unknown): WorkstreamCommandError {
  return commandFailure(operation, message, cause);
}
