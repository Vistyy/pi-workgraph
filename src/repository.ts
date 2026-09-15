import { existsSync, realpathSync } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Data, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type {
  AttemptOutput,
  AttemptSpec,
  CoordinatorCheckout,
  TaskTarget,
} from "./domain/records.js";
import { childProcessLayer } from "./node-platform.js";

type RepositoryTarget = Extract<TaskTarget, { kind: "repository" }>;

export interface RepositoryOperation {
  readonly attemptId: string;
  readonly spec: AttemptSpec;
  readonly output?: AttemptOutput;
  readonly target: RepositoryTarget;
  readonly worktreePath: string;
  readonly outputRef: string;
}

export class GitError extends Data.TaggedError("GitError")<{
  readonly operation: string;
  readonly message: string;
}> {}

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface CheckoutState {
  readonly head: string;
  readonly dirty: boolean;
}

interface AttachedCheckoutState extends CheckoutState {
  readonly ref: string;
}

interface ApplicationCheckpoint {
  readonly sourceTip: string;
  readonly destinationRef: string;
  readonly destinationHead: string;
  readonly replanned?: true;
}

export type ResolvedTaskTarget =
  | { readonly target: Extract<TaskTarget, { kind: "directory" }> }
  | {
      readonly target: Extract<TaskTarget, { kind: "repository" }>;
      readonly commit: string;
    };

/** Resolve one immutable Task target and retain the exact commit validated for a repository. */
export function resolveTaskTarget(
  input:
    | { readonly cwd: string; readonly path?: string; readonly kind: "directory" }
    | {
        readonly cwd: string;
        readonly path?: string;
        readonly kind: "repository";
        readonly revision?: string;
      },
): Effect.Effect<ResolvedTaskTarget, GitError> {
  return Effect.gen(function* () {
    const path = yield* filesystem("resolve target", () =>
      realpath(resolve(input.cwd, input.path ?? ".")),
    );

    const targetStat = yield* filesystem("resolve target", () => stat(path));

    if (!targetStat.isDirectory())
      return yield* fail("resolve target", "Target is not a directory.");

    if (input.kind === "directory") return { target: { kind: "directory" as const, path } };

    const discovery = yield* gitResult(path, ["rev-parse", "--git-dir"]);

    if (discovery.code !== 0)
      return yield* fail("resolve target", "Target is not an initialized Git work tree.");
    const inside = yield* git(path, ["rev-parse", "--is-inside-work-tree"]);
    const bare = yield* git(path, ["rev-parse", "--is-bare-repository"]);

    if (inside !== "true" || bare !== "false")
      return yield* fail("resolve target", "Bare repositories are not valid Task targets.");
    const checkoutText = yield* git(path, ["rev-parse", "--show-toplevel"]);
    const checkoutRoot = yield* filesystem("resolve checkout root", () => realpath(checkoutText));

    const commonText = yield* git(path, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);

    const commonDir = yield* filesystem("resolve common directory", () =>
      realpath(resolve(path, commonText)),
    );

    const commit = yield* exactCommit(commonDir, input.revision ?? "HEAD", "resolve target", path);

    return {
      target: { kind: "repository" as const, checkoutRoot, commonDir },
      commit,
    };
  });
}

export function resolveRevision(
  target: RepositoryTarget,
  revision: string,
): Effect.Effect<string, GitError> {
  return revalidate(target).pipe(
    Effect.flatMap(() =>
      exactCommit(target.commonDir, revision, "resolve revision", target.checkoutRoot),
    ),
  );
}

/** A candidate parent is reusable only while its exact clean ref remains compacted. */
export function validateRetainedCandidate(
  operation: RepositoryOperation,
): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(operation.target);
    const output = operation.output;

    if (output?.kind !== "retained")
      return yield* fail("extend candidate", "Candidate parent has no retained output.");
    yield* requireCompactedCandidate(operation);
    yield* requireExactRef(operation.target.commonDir, operation.outputRef, output.tip);
  });
}

export function isAncestor(
  target: RepositoryTarget,
  parent: string,
  child: string,
): Effect.Effect<boolean, GitError> {
  return ancestry(target.commonDir, parent, child);
}

export function coordinatorPlacement(input: { agentDir: string; checkoutId: string }) {
  const root = canonicalFuturePath(join(input.agentDir, "workgraph", "coordinator-checkouts"));

  return {
    managedPath: join(root, input.checkoutId),
    branchRef: `refs/heads/pi-workgraph/coordinators/${input.checkoutId}`,
  };
}

export function resolveCoordinatorRepository(
  cwd: string,
  path?: string,
): Effect.Effect<{ readonly target: RepositoryTarget; readonly commit: string }, GitError> {
  return Effect.gen(function* () {
    const resolved = yield* path === undefined
      ? resolveTaskTarget({ cwd, kind: "repository" })
      : resolveTaskTarget({ cwd, path, kind: "repository" });

    if (resolved.target.kind !== "repository" || !("commit" in resolved))
      return yield* fail("resolve Coordinator checkout", "Repository target resolution failed.");

    return resolved;
  });
}

export function validateCoordinatorDestination(input: {
  readonly target: RepositoryTarget;
  readonly commit: string;
}): Effect.Effect<{ readonly destinationRef: string }, GitError> {
  return Effect.gen(function* () {
    const destination = yield* destinationState(input.target);

    if (destination.head !== input.commit || destination.dirty)
      return yield* fail(
        "resolve Coordinator checkout",
        "Destination checkout is dirty or changed.",
      );

    return { destinationRef: destination.ref };
  });
}

/** Create or recover the exact branch-backed placement named by a durable placing row. */
export function ensureCoordinatorCheckout(
  checkout: CoordinatorCheckout,
): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(checkout.target);

    if (checkout.state.kind !== "placing")
      return yield* fail("create Coordinator checkout", "Placement is not checkpointed.");
    const destination = yield* destinationState(checkout.target);

    if (destination.ref !== checkout.destinationRef)
      return yield* fail(
        "create Coordinator checkout",
        "Destination branch changed after placement checkpoint.",
      );

    yield* ensureCoordinatorPlacementResources(checkout, destination);
    const state = yield* coordinatorCheckoutState(checkout);

    if (state.head !== checkout.baseCommit || state.dirty)
      return yield* fail(
        "create Coordinator checkout",
        "Coordinator checkout is not its exact clean base.",
      );
  });
}

function ensureCoordinatorPlacementResources(
  checkout: CoordinatorCheckout,
  destination: AttachedCheckoutState,
): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    const registered = yield* registeredWorktree(checkout.target.commonDir, checkout.managedPath);
    const exists = yield* pathExists(checkout.managedPath);
    const branch = yield* readRef(checkout.target.commonDir, checkout.branchRef);

    if (registered !== undefined && exists && branch !== undefined) return;

    if (registered !== undefined || exists || branch !== undefined)
      return yield* fail(
        "create Coordinator checkout",
        "Coordinator checkout placement is one-sided, foreign, or incomplete.",
      );

    if (destination.head !== checkout.baseCommit || destination.dirty)
      return yield* fail(
        "create Coordinator checkout",
        "Destination changed before worktree placement.",
      );
    yield* filesystem("create Coordinator checkout directory", () =>
      mkdir(dirname(checkout.managedPath), { recursive: true, mode: 0o700 }),
    );
    yield* git(checkout.target.checkoutRoot, [
      "worktree",
      "add",
      "-b",
      checkout.branchRef.slice("refs/heads/".length),
      checkout.managedPath,
      checkout.baseCommit,
    ]);
  });
}

export function inspectCoordinatorCheckout(checkout: CoordinatorCheckout): Effect.Effect<
  {
    readonly head: string;
    readonly dirty: boolean;
    readonly sourcePresent: boolean;
    readonly destinationHead: string;
    readonly destinationDirty: boolean;
  },
  GitError
> {
  return Effect.gen(function* () {
    yield* revalidate(checkout.target);

    const source = yield* inspectCoordinatorSource(checkout);

    const destination = yield* destinationState(checkout.target);

    if (destination.ref !== checkout.destinationRef)
      return yield* fail("inspect Coordinator checkout", "Destination branch changed.");

    return {
      head: source.head,
      dirty: source.dirty,
      sourcePresent: source.present,
      destinationHead: destination.head,
      destinationDirty: destination.dirty,
    };
  });
}

/** Prove source and destination facts and return the durable pre-effect application checkpoint. */
export function prepareCoordinatorApplication(
  checkout: CoordinatorCheckout,
): Effect.Effect<CoordinatorCheckout, GitError> {
  return Effect.gen(function* () {
    const { source, destination } = yield* coordinatorApplicationFacts(checkout);
    const prior = checkout.state;

    if (prior.kind === "applying")
      return yield* prepareCoordinatorApplicationRetry(checkout, prior, source, destination);

    if (prior.kind !== "ready")
      return yield* fail("apply Coordinator checkout", "Coordinator checkout is not ready.");
    yield* proveMergeable(checkout.target.commonDir, destination.head, source.head);

    return {
      ...checkout,
      state: {
        kind: "applying",
        sourceTip: source.head,
        destinationRef: destination.ref,
        destinationHead: destination.head,
      },
    };
  });
}

function coordinatorApplicationFacts(
  checkout: CoordinatorCheckout,
): Effect.Effect<
  { readonly source: CheckoutState; readonly destination: AttachedCheckoutState },
  GitError
> {
  return Effect.gen(function* () {
    yield* revalidate(checkout.target);
    const source = yield* coordinatorCheckoutState(checkout);

    if (source.dirty)
      return yield* fail("apply Coordinator checkout", "Managed checkout is dirty.");

    if (!(yield* ancestry(checkout.target.commonDir, checkout.baseCommit, source.head)))
      return yield* fail(
        "apply Coordinator checkout",
        "Managed checkout no longer descends from its base.",
      );
    const destination = yield* destinationState(checkout.target);

    if (destination.ref !== checkout.destinationRef)
      return yield* fail("apply Coordinator checkout", "Destination branch changed.");

    if (destination.dirty)
      return yield* fail("apply Coordinator checkout", "Destination checkout is dirty.");

    if (!(yield* ancestry(checkout.target.commonDir, checkout.baseCommit, destination.head)))
      return yield* fail(
        "apply Coordinator checkout",
        "Destination no longer descends from the Coordinator checkout base.",
      );

    return { source, destination };
  });
}

function prepareCoordinatorApplicationRetry(
  checkout: CoordinatorCheckout,
  prior: Extract<CoordinatorCheckout["state"], { kind: "applying" }>,
  source: CheckoutState,
  destination: AttachedCheckoutState,
): Effect.Effect<CoordinatorCheckout, GitError> {
  return Effect.gen(function* () {
    if (source.head !== prior.sourceTip)
      return yield* fail("apply Coordinator checkout", "Managed source changed after preparation.");

    if (
      destination.head === prior.destinationHead ||
      (yield* isAppliedStructure(checkout.target.commonDir, prior, destination.head))
    )
      return checkout;

    if (
      prior.replanned === true ||
      !(yield* ancestry(checkout.target.commonDir, prior.destinationHead, destination.head))
    )
      return yield* fail(
        "apply Coordinator checkout",
        "Destination changed after application preparation.",
      );
    yield* proveMergeable(checkout.target.commonDir, destination.head, source.head);

    return {
      ...checkout,
      state: { ...prior, destinationHead: destination.head, replanned: true },
    };
  });
}

/** Recover an established merge or apply the exact prepared structure once. */
export function applyCoordinatorCheckout(
  checkout: CoordinatorCheckout,
): Effect.Effect<CoordinatorCheckout, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(checkout.target);
    const prepared = checkout.state;

    if (prepared.kind !== "applying")
      return yield* fail("apply Coordinator checkout", "Application is not prepared.");
    const source = yield* coordinatorCheckoutState(checkout);

    if (source.dirty || source.head !== prepared.sourceTip)
      return yield* fail("apply Coordinator checkout", "Managed source changed after preparation.");
    const destination = yield* destinationState(checkout.target);

    if (destination.ref !== prepared.destinationRef || destination.dirty)
      return yield* fail("apply Coordinator checkout", "Destination changed after preparation.");

    const revision = yield* preparedApplicationRevision({
      commonDir: checkout.target.commonDir,
      destinationPath: checkout.target.checkoutRoot,
      checkpoint: prepared,
      destinationHead: destination.head,
      mergeMessage: `Integrate Coordinator checkout ${checkout.checkoutId}`,
    });

    yield* revalidate(checkout.target);

    const final = yield* destinationState(checkout.target);
    const exactResult = yield* isAppliedStructure(checkout.target.commonDir, prepared, revision);

    const noOp =
      revision === prepared.destinationHead &&
      (yield* ancestry(checkout.target.commonDir, prepared.sourceTip, revision));

    if (
      final.ref !== prepared.destinationRef ||
      final.head !== revision ||
      final.dirty ||
      (!exactResult && !noOp)
    )
      return yield* fail(
        "apply Coordinator checkout",
        "Applied destination failed exact post-validation.",
      );

    return {
      ...checkout,
      state: { kind: "applied", sourceTip: prepared.sourceTip, revision },
    };
  });
}

/** Prove exact live source ownership before authorizing uncertain worktree removal. */
export function validateCoordinatorWorktreeRemoval(
  checkout: CoordinatorCheckout,
): Effect.Effect<void, GitError> {
  const state = checkout.state;

  if (
    (state.kind !== "applied" && state.kind !== "discarding") ||
    state.worktreeRemoval !== undefined
  )
    return fail("release Coordinator checkout", "Worktree removal cannot be requested.");

  return Effect.gen(function* () {
    yield* revalidate(checkout.target);

    const source = yield* coordinatorCheckoutState(checkout);

    if (source.head !== state.sourceTip)
      return yield* fail(
        "release Coordinator checkout",
        "Managed checkout HEAD differs from its disposition checkpoint.",
      );
  });
}

/** Remove only the exact clean worktree after application is durably established. */
export function removeAppliedCoordinatorWorktree(
  checkout: CoordinatorCheckout,
): Effect.Effect<void, GitError> {
  if (checkout.state.kind !== "applied" || checkout.state.worktreeRemoval !== "requested")
    return fail("cleanup Coordinator checkout", "Applied worktree removal is not requested.");
  const applied = checkout.state;

  return Effect.gen(function* () {
    yield* revalidate(checkout.target);
    const destination = yield* destinationState(checkout.target);

    if (
      destination.ref !== checkout.destinationRef ||
      destination.dirty ||
      !(yield* ancestry(checkout.target.commonDir, applied.revision, destination.head))
    )
      return yield* fail(
        "cleanup Coordinator checkout",
        "Applied destination no longer contains the checkpointed result.",
      );
    yield* removeCoordinatorWorktree(checkout, applied.sourceTip, false);
  });
}

export function prepareCoordinatorDiscard(
  checkout: CoordinatorCheckout,
  reason: string,
): Effect.Effect<CoordinatorCheckout, GitError> {
  if (reason.trim().length === 0)
    return fail("discard Coordinator checkout", "Discard requires a reason.");

  if (checkout.state.kind === "discarding") return Effect.succeed(checkout);

  if (checkout.state.kind !== "ready")
    return fail("discard Coordinator checkout", "Coordinator checkout is not ready.");

  return coordinatorCheckoutState(checkout).pipe(
    Effect.map((source) => ({
      ...checkout,
      state: { kind: "discarding" as const, sourceTip: source.head, reason },
    })),
  );
}

/** Destructively remove exact checkpointed source bytes while preserving mismatches. */
export function removeDiscardedCoordinatorWorktree(
  checkout: CoordinatorCheckout,
): Effect.Effect<void, GitError> {
  if (checkout.state.kind !== "discarding" || checkout.state.worktreeRemoval !== "requested")
    return fail("discard Coordinator checkout", "Discard worktree removal is not requested.");

  return removeCoordinatorWorktree(checkout, checkout.state.sourceTip, true);
}

/** Delete the exact owned branch only after worktree absence has a durable checkpoint. */
export function removeCoordinatorBranch(
  checkout: CoordinatorCheckout,
): Effect.Effect<void, GitError> {
  const state = checkout.state;

  if (
    (state.kind !== "applied" && state.kind !== "discarding") ||
    state.worktreeRemoval !== "confirmed"
  )
    return fail("release Coordinator checkout", "Worktree removal is not confirmed.");

  return Effect.gen(function* () {
    yield* revalidate(checkout.target);
    const registered = yield* registeredWorktree(checkout.target.commonDir, checkout.managedPath);
    const exists = yield* pathExists(checkout.managedPath);

    if (registered !== undefined || exists)
      return yield* fail(
        "release Coordinator checkout",
        "Managed worktree remains after its removal checkpoint.",
      );
    const branch = yield* readRef(checkout.target.commonDir, checkout.branchRef);

    if (branch === undefined) return;

    if (branch !== state.sourceTip)
      return yield* fail(
        "release Coordinator checkout",
        "Owned branch was repointed; nothing was deleted.",
      );
    yield* deleteExactRef(checkout.target.commonDir, checkout.branchRef, state.sourceTip);
  });
}

function removeCoordinatorWorktree(
  checkout: CoordinatorCheckout,
  tip: string,
  destructive: boolean,
): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(checkout.target);
    const registered = yield* registeredWorktree(checkout.target.commonDir, checkout.managedPath);
    const exists = yield* pathExists(checkout.managedPath);
    const branch = yield* readRef(checkout.target.commonDir, checkout.branchRef);

    if (registered === undefined && !exists && branch === tip) return;

    if (registered === undefined || !exists || branch !== tip)
      return yield* fail(
        "release Coordinator checkout",
        "Coordinator checkout resources are foreign, moved, or incomplete.",
      );

    const source = yield* coordinatorCheckoutState(checkout);

    if (source.head !== tip)
      return yield* fail(
        "release Coordinator checkout",
        "Managed checkout HEAD differs from its checkpoint.",
      );
    yield* cleanCoordinatorSource(checkout, source, tip, destructive);
    yield* git(
      checkout.target.checkoutRoot,
      ["worktree", "remove", "--force", checkout.managedPath],
      true,
    );

    if (
      (yield* pathExists(checkout.managedPath)) ||
      (yield* registeredWorktree(checkout.target.commonDir, checkout.managedPath)) !== undefined
    )
      return yield* fail(
        "release Coordinator checkout",
        "Managed checkout removal could not be established.",
      );
  });
}

function inspectCoordinatorSource(
  checkout: CoordinatorCheckout,
): Effect.Effect<
  { readonly head: string; readonly dirty: boolean; readonly present: boolean },
  GitError
> {
  const state = checkout.state;

  if (state.kind !== "applied" && state.kind !== "discarding")
    return coordinatorCheckoutState(checkout).pipe(
      Effect.map((source) => ({ ...source, present: true })),
    );

  if (state.worktreeRemoval === "confirmed")
    return inspectRemovedCoordinatorSource(checkout, state.sourceTip);

  if (state.worktreeRemoval !== "requested")
    return coordinatorCheckoutState(checkout).pipe(
      Effect.map((source) => ({ ...source, present: true })),
    );

  return Effect.gen(function* () {
    const registered = yield* registeredWorktree(checkout.target.commonDir, checkout.managedPath);
    const exists = yield* pathExists(checkout.managedPath);
    const branch = yield* readRef(checkout.target.commonDir, checkout.branchRef);

    if (registered === undefined && !exists && branch === state.sourceTip)
      return { head: state.sourceTip, dirty: false, present: false };

    if (registered === undefined || !exists || branch !== state.sourceTip)
      return yield* fail(
        "inspect Coordinator checkout",
        "Resources do not match the requested worktree removal.",
      );

    return { ...(yield* coordinatorCheckoutState(checkout)), present: true };
  });
}

function inspectRemovedCoordinatorSource(
  checkout: CoordinatorCheckout,
  tip: string,
): Effect.Effect<
  { readonly head: string; readonly dirty: false; readonly present: false },
  GitError
> {
  return Effect.gen(function* () {
    const registered = yield* registeredWorktree(checkout.target.commonDir, checkout.managedPath);
    const exists = yield* pathExists(checkout.managedPath);
    const branch = yield* readRef(checkout.target.commonDir, checkout.branchRef);

    if (registered !== undefined || exists || (branch !== undefined && branch !== tip))
      return yield* fail(
        "inspect Coordinator checkout",
        "Resources do not match the checkpointed worktree removal.",
      );

    return { head: tip, dirty: false as const, present: false as const };
  });
}

function cleanCoordinatorSource(
  checkout: CoordinatorCheckout,
  source: CheckoutState,
  tip: string,
  destructive: boolean,
): Effect.Effect<void, GitError> {
  if (!destructive)
    return source.dirty
      ? fail("release Coordinator checkout", "Applied source checkout became dirty.")
      : Effect.void;

  return Effect.gen(function* () {
    yield* git(checkout.managedPath, ["reset", "--hard", tip]);
    yield* git(checkout.managedPath, ["clean", "-fdx"], true);
  });
}

function coordinatorCheckoutState(
  checkout: CoordinatorCheckout,
): Effect.Effect<CheckoutState, GitError> {
  return Effect.gen(function* () {
    const registered = yield* registeredWorktree(checkout.target.commonDir, checkout.managedPath);

    if (registered === undefined)
      return yield* fail(
        "inspect Coordinator checkout",
        "Managed path is not an exact registered worktree.",
      );

    const actualPath = yield* filesystem("inspect Coordinator checkout", () =>
      realpath(checkout.managedPath),
    );

    if (actualPath !== checkout.managedPath)
      return yield* fail("inspect Coordinator checkout", "Managed path moved.");

    const commonText = yield* git(checkout.managedPath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);

    const common = yield* filesystem("inspect Coordinator checkout", () =>
      realpath(resolve(checkout.managedPath, commonText)),
    );

    if (common !== checkout.target.commonDir)
      return yield* fail(
        "inspect Coordinator checkout",
        "Managed checkout belongs to another repository.",
      );
    const symbolic = yield* gitResult(checkout.managedPath, ["symbolic-ref", "-q", "HEAD"]);

    if (symbolic.code !== 0 || symbolic.stdout !== checkout.branchRef)
      return yield* fail(
        "inspect Coordinator checkout",
        "Managed checkout is not on its exact owned branch.",
      );

    return {
      head: yield* exactCommit(
        checkout.target.commonDir,
        "HEAD",
        "inspect Coordinator checkout",
        checkout.managedPath,
      ),
      dirty: yield* destinationDirty(checkout.managedPath),
    };
  });
}

export function detachedPlacement(input: { agentDir: string; attemptId: string }) {
  const worktreeRoot = canonicalFuturePath(join(input.agentDir, "workgraph", "worktrees"));

  return {
    worktreePath: join(worktreeRoot, input.attemptId),
    outputRef: `refs/pi-workgraph/outputs/${input.attemptId}`,
  };
}

/** Create or recover only the exact clean detached checkout declared by the Attempt. */
export function ensureDetachedWorktree(
  operation: RepositoryOperation,
): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(operation.target);
    const base = baseCommit(operation.spec);
    yield* exactCommit(operation.target.commonDir, base, "create worktree");

    if ((yield* readRef(operation.target.commonDir, operation.outputRef)) !== undefined)
      return yield* fail("create worktree", "The Attempt private output ref already exists.");

    if (yield* recoverPlacement(operation, base)) return;
    yield* filesystem("create worktree directory", () =>
      mkdir(dirname(operation.worktreePath), { recursive: true, mode: 0o700 }),
    );
    yield* git(
      operation.target.checkoutRoot,
      ["worktree", "add", "--detach", operation.worktreePath, base],
      true,
    );
    const state = yield* ownedCheckout(operation, true);

    if (state.head !== base || state.dirty)
      return yield* fail("create worktree", "Created worktree failed exact post-validation.");
  });
}

function recoverPlacement(
  operation: RepositoryOperation,
  base: string,
): Effect.Effect<boolean, GitError> {
  return Effect.gen(function* () {
    const registration = yield* registeredWorktree(
      operation.target.commonDir,
      operation.worktreePath,
    );

    const exists = yield* pathExists(operation.worktreePath);

    if (registration === undefined && !exists) return false;

    if (registration === undefined || !exists)
      return yield* fail("create worktree", "Attempt placement is foreign or incomplete.");
    const state = yield* ownedCheckout(operation, true);

    if (state.head !== base || state.dirty)
      return yield* fail("create worktree", "Existing worktree is not the clean Attempt base.");

    return true;
  });
}

/** Classify repository commits after closure; completed reports relinquish uncommitted scratch. */
export function classifyOutput(
  operation: RepositoryOperation,
  reportCompleted = false,
): Effect.Effect<AttemptOutput, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(operation.target);

    const registration = yield* registeredWorktree(
      operation.target.commonDir,
      operation.worktreePath,
    );

    const exists = yield* pathExists(operation.worktreePath);
    const base = baseCommit(operation.spec);

    if (registration === undefined && !exists) return yield* classifyAbsentOutput(operation, base);

    if (registration === undefined || !exists)
      return yield* fail("classify output", "Attempt placement is foreign or incomplete.");

    return yield* classifyPresentOutput(operation, base, reportCompleted);
  });
}

function classifyPresentOutput(
  operation: RepositoryOperation,
  base: string,
  reportCompleted: boolean,
): Effect.Effect<AttemptOutput, GitError> {
  return Effect.gen(function* () {
    const state = yield* ownedCheckout(operation, true);

    if (!(yield* ancestry(operation.target.commonDir, base, state.head)))
      return yield* fail("classify output", "Attempt HEAD is unrelated to its exact base.");
    yield* validateCandidate(operation, state.head);

    if (!reportCompleted && state.dirty) {
      yield* createExactRef(operation.target.commonDir, operation.outputRef, state.head);

      return {
        kind: "retained" as const,
        tip: state.head,
        reason: "Dirty checkout is preserved for explicit disposition.",
      };
    }

    if (state.head === base) {
      yield* removeWorktree(operation, reportCompleted);

      return { kind: "no_output" as const };
    }

    yield* createExactRef(operation.target.commonDir, operation.outputRef, state.head);
    yield* removeWorktree(operation, reportCompleted);

    return {
      kind: "retained" as const,
      tip: state.head,
      reason: "Committed output is retained.",
    };
  });
}

function classifyAbsentOutput(
  operation: RepositoryOperation,
  base: string,
): Effect.Effect<AttemptOutput, GitError> {
  return Effect.gen(function* () {
    const tip = yield* readRef(operation.target.commonDir, operation.outputRef);

    if (tip === undefined) return { kind: "no_output" as const };

    if (!(yield* ancestry(operation.target.commonDir, base, tip)))
      return yield* fail("classify output", "Attempt output ref is unrelated to its exact base.");
    yield* validateCandidate(operation, tip);

    return { kind: "retained" as const, tip, reason: "Committed output is retained." };
  });
}

/** Validate application facts and, at most once, checkpoint a clean same-ref advancement. */
export function prepareApplication(
  operation: RepositoryOperation,
): Effect.Effect<AttemptOutput, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(operation.target);
    const output = operation.output;

    return yield* output?.kind === "applying"
      ? prepareApplicationRetry(operation, output)
      : prepareRetainedApplication(operation);
  });
}

function prepareApplicationRetry(
  operation: RepositoryOperation,
  output: Extract<AttemptOutput, { kind: "applying" }>,
): Effect.Effect<AttemptOutput, GitError> {
  return Effect.gen(function* () {
    const destination = yield* destinationState(operation.target);

    if (destination.ref !== output.destinationRef)
      return yield* fail("apply output", "Destination ref changed.");

    if (destination.dirty) return yield* fail("apply output", "Destination checkout is dirty.");

    if (
      destination.head === output.destinationHead ||
      (yield* isAppliedStructure(operation.target.commonDir, output, destination.head))
    )
      return output;

    if (yield* ancestry(operation.target.commonDir, output.sourceTip, destination.head))
      return yield* fail("apply output", "Destination advanced beyond the exact candidate result.");

    if (
      output.replanned === true ||
      !(yield* ancestry(operation.target.commonDir, output.destinationHead, destination.head))
    )
      return yield* fail("apply output", "Destination changed after application preparation.");
    yield* proveMergeable(operation.target.commonDir, destination.head, output.sourceTip);

    return { ...output, destinationHead: destination.head, replanned: true as const };
  });
}

function prepareRetainedApplication(
  operation: RepositoryOperation,
): Effect.Effect<AttemptOutput, GitError> {
  return Effect.gen(function* () {
    const output = operation.output;

    if (output?.kind !== "retained")
      return yield* fail("apply output", "Attempt has no retained output.");
    yield* requireCompactedCandidate(operation);

    const source = yield* requireExactRef(
      operation.target.commonDir,
      operation.outputRef,
      output.tip,
    );

    const root = candidateRoot(operation.spec);

    if (!(yield* ancestry(operation.target.commonDir, root, source)))
      return yield* fail("apply output", "Candidate does not contain its source root.");
    const destination = yield* destinationState(operation.target);

    if (destination.dirty) return yield* fail("apply output", "Destination checkout is dirty.");

    if (
      !(yield* ancestry(operation.target.commonDir, baseCommit(operation.spec), destination.head))
    )
      return yield* fail("apply output", "Destination no longer descends from the Attempt base.");
    yield* proveMergeable(operation.target.commonDir, destination.head, source);

    return {
      kind: "applying" as const,
      sourceRoot: root,
      sourceTip: source,
      destinationRef: destination.ref,
      destinationHead: destination.head,
    };
  });
}

/** Recover structurally or advance only the prepared attached destination with merge --ff-only. */
export function applyOutput(
  operation: RepositoryOperation,
): Effect.Effect<AttemptOutput, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(operation.target);
    const output = operation.output;

    if (output?.kind !== "applying")
      return yield* fail("apply output", "Application has no durable preparation checkpoint.");
    yield* requireCompactedCandidate(operation);
    yield* requireExactRef(operation.target.commonDir, operation.outputRef, output.sourceTip);
    const destination = yield* destinationState(operation.target);

    if (destination.ref !== output.destinationRef)
      return yield* fail("apply output", "Destination ref changed.");

    if (destination.dirty) return yield* fail("apply output", "Destination checkout is dirty.");

    const revision = yield* applicationRevision(operation, output, destination.head);
    const final = yield* destinationState(operation.target);

    if (
      final.ref !== output.destinationRef ||
      final.head !== revision ||
      final.dirty ||
      !(yield* ancestry(operation.target.commonDir, output.sourceRoot, revision)) ||
      !(yield* ancestry(operation.target.commonDir, output.sourceTip, revision))
    )
      return yield* fail("apply output", "Applied destination failed exact post-validation.");

    return { kind: "applied" as const, revision, cleanupTip: output.sourceTip };
  });
}

function applicationRevision(
  operation: RepositoryOperation,
  output: Extract<AttemptOutput, { kind: "applying" }>,
  head: string,
): Effect.Effect<string, GitError> {
  return preparedApplicationRevision({
    commonDir: operation.target.commonDir,
    destinationPath: operation.target.checkoutRoot,
    checkpoint: output,
    destinationHead: head,
    mergeMessage: `Integrate Workgraph output ${operation.attemptId}`,
  });
}

function preparedApplicationRevision(input: {
  readonly commonDir: string;
  readonly destinationPath: string;
  readonly checkpoint: ApplicationCheckpoint;
  readonly destinationHead: string;
  readonly mergeMessage: string;
}): Effect.Effect<string, GitError> {
  return Effect.gen(function* () {
    const { checkpoint } = input;

    if (yield* isAppliedStructure(input.commonDir, checkpoint, input.destinationHead))
      return input.destinationHead;

    if (input.destinationHead !== checkpoint.destinationHead)
      return yield* fail("apply output", "Destination changed after application preparation.");

    if (yield* ancestry(input.commonDir, checkpoint.sourceTip, input.destinationHead))
      return input.destinationHead;

    if (yield* ancestry(input.commonDir, input.destinationHead, checkpoint.sourceTip)) {
      yield* mergeIntoDestination(input.destinationPath, checkpoint.sourceTip);

      return checkpoint.sourceTip;
    }

    const tree = yield* proveMergeable(
      input.commonDir,
      input.destinationHead,
      checkpoint.sourceTip,
    );

    const merge = yield* gitDir(input.commonDir, [
      "commit-tree",
      tree,
      "-p",
      input.destinationHead,
      "-p",
      checkpoint.sourceTip,
      "-m",
      input.mergeMessage,
    ]);

    yield* mergeIntoDestination(input.destinationPath, merge);

    return merge;
  });
}

function mergeIntoDestination(cwd: string, revision: string): Effect.Effect<string, GitError> {
  return git(cwd, ["merge", "--ff-only", "--no-overwrite-ignore", revision]);
}

/** Remove still-exact clean source resources only after the applied checkpoint is durable. */
export function cleanupAppliedOutput(
  operation: RepositoryOperation,
): Effect.Effect<AttemptOutput, GitError> {
  return Effect.gen(function* () {
    const output = operation.output;

    if (output?.kind !== "applied")
      return yield* fail("cleanup applied output", "Attempt has no applied output to clean up.");

    if (output.cleanupTip === undefined) return output;
    yield* revalidate(operation.target);
    yield* requireCompactedCandidate(operation);
    yield* deleteExactRef(operation.target.commonDir, operation.outputRef, output.cleanupTip);
    const { cleanupTip: _cleanupTip, ...cleaned } = output;

    return cleaned;
  });
}

export function prepareDiscard(
  operation: RepositoryOperation,
  reason: string,
): Effect.Effect<AttemptOutput, GitError> {
  if (reason.trim().length === 0)
    return Effect.fail(error("discard output", "Discard requires a reason."));
  const output = operation.output;

  if (output?.kind === "discarding") return Effect.succeed(output);

  if (output?.kind === "retained")
    return Effect.succeed({ kind: "discarding", tip: output.tip, reason });

  if (output?.kind === "applied" && output.cleanupTip !== undefined)
    return Effect.succeed({
      kind: "discarding",
      tip: output.cleanupTip,
      reason,
      applied: { revision: output.revision },
    });

  return Effect.fail(error("discard output", "Attempt has no releasable output."));
}

/** Destructively remove only resources named by a durable exact-attempt discard checkpoint. */
export function discardOutput(
  operation: RepositoryOperation,
): Effect.Effect<AttemptOutput, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(operation.target);
    const output = operation.output;

    if (output?.kind !== "discarding")
      return yield* fail("discard output", "Discard has no durable checkpoint.");

    const registration = yield* registeredWorktree(
      operation.target.commonDir,
      operation.worktreePath,
    );

    const exists = yield* pathExists(operation.worktreePath);

    if (registration === undefined && !exists) {
      yield* deleteExactRef(operation.target.commonDir, operation.outputRef, output.tip);
    } else {
      if (registration === undefined || !exists)
        return yield* fail("discard output", "Attempt placement is foreign or incomplete.");
      yield* requireExactRef(operation.target.commonDir, operation.outputRef, output.tip);
      const state = yield* ownedCheckout(operation, true);

      if (state.head !== output.tip)
        return yield* fail(
          "discard output",
          "Attempt checkout HEAD no longer matches its checkpoint.",
        );
      yield* git(operation.worktreePath, ["reset", "--hard", output.tip]);
      yield* git(operation.worktreePath, ["clean", "-fdx"], true);
      yield* removeWorktree(operation);
      yield* deleteExactRef(operation.target.commonDir, operation.outputRef, output.tip);
    }

    return output.applied === undefined
      ? { kind: "discarded" as const, reason: output.reason }
      : { kind: "applied" as const, ...output.applied, cleanupReason: output.reason };
  });
}

function baseCommit(spec: AttemptSpec): string {
  if (spec.base.kind !== "repository")
    throw error("inspect output", "Attempt has no repository base.");

  return spec.base.baseCommit;
}

function candidateRoot(spec: AttemptSpec): string {
  return spec.lineage?.candidateRoot ?? baseCommit(spec);
}

function validateCandidate(
  operation: RepositoryOperation,
  head: string,
): Effect.Effect<void, GitError> {
  const lineage = operation.spec.lineage?.candidateOf;

  if (lineage?.kind !== "integrate") return Effect.void;

  return Effect.all([
    ancestry(operation.target.commonDir, baseCommit(operation.spec), head),
    ancestry(operation.target.commonDir, lineage.sourceTip, head),
  ]).pipe(
    Effect.flatMap(([destination, source]) =>
      destination && source
        ? Effect.void
        : fail(
            "classify output",
            "Integration output lacks required destination or source ancestry.",
          ),
    ),
  );
}

function requireCompactedCandidate(operation: RepositoryOperation): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    const registration = yield* registeredWorktree(
      operation.target.commonDir,
      operation.worktreePath,
    );

    const exists = yield* pathExists(operation.worktreePath);

    if (registration !== undefined || exists)
      return yield* fail("apply output", "Only clean compacted candidate output can be applied.");
  });
}

function destinationState(
  target: RepositoryTarget,
): Effect.Effect<{ ref: string; head: string; dirty: boolean }, GitError> {
  return Effect.gen(function* () {
    const refResult = yield* gitResult(target.checkoutRoot, ["symbolic-ref", "-q", "HEAD"]);

    if (refResult.code !== 0 || !refResult.stdout.startsWith("refs/heads/"))
      return yield* fail("apply output", "Destination must be an attached branch checkout.");

    return {
      ref: refResult.stdout,
      head: yield* exactCommit(target.commonDir, "HEAD", "apply output", target.checkoutRoot),
      dirty: yield* destinationDirty(target.checkoutRoot),
    };
  });
}

function isAppliedStructure(
  commonDir: string,
  output: ApplicationCheckpoint,
  revision: string,
): Effect.Effect<boolean, GitError> {
  return Effect.gen(function* () {
    if (
      revision === output.sourceTip &&
      (yield* ancestry(commonDir, output.destinationHead, revision))
    )
      return true;
    const parentsText = yield* gitDir(commonDir, ["show", "-s", "--format=%P", revision], true);
    const parents = parentsText.length === 0 ? [] : parentsText.split(" ");

    if (
      parents.length !== 2 ||
      parents[0] !== output.destinationHead ||
      parents[1] !== output.sourceTip
    )
      return false;
    const expectedTree = yield* proveMergeable(commonDir, output.destinationHead, output.sourceTip);
    const actualTree = yield* gitDir(commonDir, ["show", "-s", "--format=%T", revision]);

    return actualTree === expectedTree;
  });
}

function proveMergeable(
  commonDir: string,
  destination: string,
  source: string,
): Effect.Effect<string, GitError> {
  return gitDir(commonDir, ["merge-tree", "--write-tree", destination, source]).pipe(
    Effect.mapError(() =>
      error("apply output", "Candidate conflicts with the destination; nothing was mutated."),
    ),
  );
}

function ownedCheckout(
  operation: RepositoryOperation,
  requireDetached: boolean,
): Effect.Effect<CheckoutState, GitError> {
  return Effect.gen(function* () {
    const registered = yield* registeredWorktree(
      operation.target.commonDir,
      operation.worktreePath,
    );

    if (registered === undefined)
      return yield* fail("inspect output", "Attempt checkout is not an exact registered worktree.");
    const actualPath = yield* filesystem("inspect output", () => realpath(operation.worktreePath));

    if (actualPath !== operation.worktreePath)
      return yield* fail("inspect output", "Attempt checkout path is not its real placement.");

    const common = yield* git(operation.worktreePath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);

    const actualCommon = yield* filesystem("inspect output", () =>
      realpath(resolve(operation.worktreePath, common)),
    );

    if (actualCommon !== operation.target.commonDir)
      return yield* fail("inspect output", "Attempt checkout belongs to another repository.");

    if (requireDetached) {
      const symbolic = yield* gitResult(operation.worktreePath, ["symbolic-ref", "-q", "HEAD"]);

      if (symbolic.code === 0)
        return yield* fail("inspect output", "Attempt checkout is no longer detached.");
    }

    return {
      head: yield* exactCommit(
        operation.target.commonDir,
        "HEAD",
        "inspect output",
        operation.worktreePath,
      ),
      dirty: yield* attemptDirty(operation.worktreePath),
    };
  });
}

function removeWorktree(
  operation: RepositoryOperation,
  force = false,
): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    const state = yield* ownedCheckout(operation, false);

    if (!force && state.dirty)
      return yield* fail("remove worktree", "Refusing to remove a dirty Attempt checkout.");
    yield* git(
      operation.target.checkoutRoot,
      ["worktree", "remove", ...(force ? ["--force"] : []), operation.worktreePath],
      true,
    );

    if (
      (yield* pathExists(operation.worktreePath)) ||
      (yield* registeredWorktree(operation.target.commonDir, operation.worktreePath)) !== undefined
    )
      return yield* fail("remove worktree", "Attempt checkout removal could not be established.");
  });
}

function revalidate(target: RepositoryTarget): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    const root = yield* filesystem("revalidate repository", () => realpath(target.checkoutRoot));

    const commonText = yield* git(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);

    const common = yield* filesystem("revalidate repository", () =>
      realpath(resolve(root, commonText)),
    );

    const inside = yield* git(root, ["rev-parse", "--is-inside-work-tree"]);
    const bare = yield* git(root, ["rev-parse", "--is-bare-repository"]);

    if (
      root !== target.checkoutRoot ||
      common !== target.commonDir ||
      inside !== "true" ||
      bare !== "false"
    )
      return yield* fail("revalidate repository", "Stored Task repository identity changed.");
  });
}

function registeredWorktree(
  commonDir: string,
  path: string,
): Effect.Effect<string | undefined, GitError> {
  return gitDir(commonDir, ["worktree", "list", "--porcelain", "-z"]).pipe(
    Effect.map((text) => {
      for (const field of text.split("\0")) {
        if (!field.startsWith("worktree ")) continue;
        const candidate = field.slice("worktree ".length);

        if (resolve(candidate) === path) return candidate;
      }

      return undefined;
    }),
  );
}

function destinationDirty(cwd: string): Effect.Effect<boolean, GitError> {
  return dirty(cwd, false);
}

function attemptDirty(cwd: string): Effect.Effect<boolean, GitError> {
  return dirty(cwd, true);
}

function dirty(cwd: string, includeIgnored: boolean): Effect.Effect<boolean, GitError> {
  const statusArgs = ["status", "--porcelain", "--untracked-files=all"];

  if (includeIgnored) statusArgs.push("--ignored=matching");

  return Effect.all([
    git(cwd, statusArgs, true),
    gitResult(cwd, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]),
  ]).pipe(
    Effect.flatMap(([status, mergeHead]) => {
      if (mergeHead.code !== 0 && mergeHead.code !== 1)
        return fail("inspect checkout", "Git could not inspect merge state.");

      return Effect.succeed(status.length > 0 || mergeHead.code === 0);
    }),
  );
}

function ancestry(
  commonDir: string,
  parent: string,
  child: string,
): Effect.Effect<boolean, GitError> {
  return gitDirResult(commonDir, ["merge-base", "--is-ancestor", parent, child]).pipe(
    Effect.flatMap((result) => {
      if (result.code === 0) return Effect.succeed(true);

      if (result.code === 1) return Effect.succeed(false);

      return fail("inspect ancestry", "Git could not inspect candidate ancestry.");
    }),
  );
}

function exactCommit(
  commonDir: string,
  revision: string,
  operation: string,
  cwd?: string,
): Effect.Effect<string, GitError> {
  const command =
    cwd === undefined
      ? gitDir(commonDir, ["rev-parse", "--verify", `${revision}^{commit}`])
      : git(cwd, ["rev-parse", "--verify", `${revision}^{commit}`]);

  return command.pipe(
    Effect.filterOrFail(
      (commit) => /^[0-9a-f]{40,64}$/.test(commit),
      () => error(operation, "Revision did not resolve to one exact commit."),
    ),
    Effect.mapError(() => error(operation, "Revision did not resolve to one exact commit.")),
  );
}

function readRef(commonDir: string, ref: string): Effect.Effect<string | undefined, GitError> {
  return gitDirResult(commonDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).pipe(
    Effect.flatMap((result) => {
      if (result.code === 0) return Effect.succeed(result.stdout);

      // oxlint-disable-next-line effecttsgo/effect-succeed-with-void -- This branch inhabits the explicit optional-ref result.
      if (result.code === 1) return Effect.succeed<string | undefined>(undefined);

      return fail("inspect output ref", "Private output ref could not be inspected.");
    }),
  );
}

function requireExactRef(
  commonDir: string,
  ref: string,
  tip: string,
): Effect.Effect<string, GitError> {
  return readRef(commonDir, ref).pipe(
    Effect.filterOrFail(
      (actual): actual is string => actual === tip,
      () => error("inspect output ref", "Private output ref is absent or was repointed."),
    ),
  );
}

function createExactRef(
  commonDir: string,
  ref: string,
  tip: string,
): Effect.Effect<void, GitError> {
  return readRef(commonDir, ref).pipe(
    Effect.flatMap((actual) => {
      if (actual === tip) return Effect.void;

      if (actual !== undefined)
        return fail("retain output", "Private output ref was already owned by other content.");

      return gitDir(commonDir, ["update-ref", ref, tip, "0".repeat(tip.length)], true).pipe(
        Effect.asVoid,
      );
    }),
  );
}

function deleteExactRef(
  commonDir: string,
  ref: string,
  tip: string,
): Effect.Effect<void, GitError> {
  return readRef(commonDir, ref).pipe(
    Effect.flatMap((actual) => {
      if (actual === undefined) return Effect.void;

      if (actual !== tip)
        return fail("discard output", "Private output ref was repointed; nothing was deleted.");

      return gitDir(commonDir, ["update-ref", "-d", ref, tip], true).pipe(Effect.asVoid);
    }),
  );
}

function pathExists(path: string): Effect.Effect<boolean, GitError> {
  return Effect.tryPromise({
    try: () =>
      stat(path).then(
        () => true,
        (cause: unknown) => {
          if (isErrno(cause, "ENOENT")) return false;
          throw cause;
        },
      ),
    catch: () => error("inspect path", "Attempt placement could not be inspected."),
  });
}

function isErrno(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

function filesystem<A>(operation: string, run: () => Promise<A>): Effect.Effect<A, GitError> {
  return Effect.tryPromise({
    try: run,
    catch: () => error(operation, "Filesystem operation failed."),
  });
}

function git(cwd: string, args: string[], allowEmpty = false): Effect.Effect<string, GitError> {
  return gitResult(cwd, args).pipe(Effect.flatMap((result) => checked(args, result, allowEmpty)));
}

function gitDir(
  commonDir: string,
  args: string[],
  allowEmpty = false,
): Effect.Effect<string, GitError> {
  return gitDirResult(commonDir, args).pipe(
    Effect.flatMap((result) => checked(args, result, allowEmpty)),
  );
}

function gitDirResult(commonDir: string, args: string[]): Effect.Effect<CommandResult, GitError> {
  return command([`--git-dir=${commonDir}`, ...args]);
}

function gitResult(cwd: string, args: string[]): Effect.Effect<CommandResult, GitError> {
  return command(["-C", cwd, ...args]);
}

function command(args: string[]): Effect.Effect<CommandResult, GitError> {
  const process = ChildProcess.make("git", args, {
    cwd: globalThis.process.cwd(),
    stdin: "ignore",
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(process);

      const result = yield* Effect.all(
        {
          code: child.exitCode,
          stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        },
        { concurrency: "unbounded" },
      );

      return {
        code: Number(result.code),
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      };
    }),
  ).pipe(
    Effect.mapError(() => error(args.join(" "), "Git process failed.")),
    Effect.provide(childProcessLayer),
  );
}

function checked(
  args: readonly string[],
  result: CommandResult,
  allowEmpty: boolean,
): Effect.Effect<string, GitError> {
  if (result.code !== 0)
    return fail(args.join(" "), result.stderr || result.stdout || "Git command failed.");

  if (!allowEmpty && result.stdout.length === 0)
    return fail(args.join(" "), "Git returned no output.");

  return Effect.succeed(result.stdout);
}

function fail(operation: string, message: string): Effect.Effect<never, GitError> {
  return Effect.fail(error(operation, message));
}

function error(operation: string, message: string): GitError {
  return new GitError({ operation, message });
}

function canonicalFuturePath(path: string): string {
  const missing: string[] = [];
  let ancestor = resolve(path);

  while (!existsSync(ancestor)) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }

  return join(realpathSync(ancestor), ...missing);
}
