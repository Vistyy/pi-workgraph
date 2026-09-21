import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Effect } from "effect";
import type { AttemptOutput, AttemptSpec } from "../domain/records.js";
import {
  ancestry,
  canonicalFuturePath,
  dirty,
  error,
  exactCommit,
  fail,
  filesystem,
  type GitError,
  git,
  gitDir,
  gitDirResult,
  gitResult,
  isErrno,
  type RepositoryTarget,
  registeredWorktree,
  revalidate,
} from "./git.js";

interface CheckoutState {
  readonly head: string;
  readonly dirty: boolean;
}

export interface RepositoryOperation {
  readonly attemptId: string;
  readonly spec: AttemptSpec;
  readonly output?: AttemptOutput;
  readonly target: RepositoryTarget;
  readonly worktreePath: string;
  readonly outputRef: string;
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

    return yield* fail("apply output", "Destination changed after application preparation.");
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
  return Effect.gen(function* () {
    if (yield* isAppliedStructure(operation.target.commonDir, output, head)) return head;

    if (head !== output.destinationHead)
      return yield* fail("apply output", "Destination changed after application preparation.");

    if (yield* ancestry(operation.target.commonDir, output.sourceTip, head)) return head;

    if (yield* ancestry(operation.target.commonDir, head, output.sourceTip)) {
      yield* mergeIntoDestination(operation.target.checkoutRoot, output.sourceTip);

      return output.sourceTip;
    }

    const tree = yield* proveMergeable(operation.target.commonDir, head, output.sourceTip);

    const merge = yield* gitDir(operation.target.commonDir, [
      "commit-tree",
      tree,
      "-p",
      head,
      "-p",
      output.sourceTip,
      "-m",
      `Integrate Workgraph output ${operation.attemptId}`,
    ]);

    yield* mergeIntoDestination(operation.target.checkoutRoot, merge);

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
      dirty: yield* dirty(target.checkoutRoot, false),
    };
  });
}

function isAppliedStructure(
  commonDir: string,
  output: Extract<AttemptOutput, { kind: "applying" }>,
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
      dirty: yield* dirty(operation.worktreePath, true),
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
