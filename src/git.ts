/* oxlint-disable effecttsgo/node-builtin-import -- Git placement identity includes host filesystem paths. */

import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import { Data, Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { Attempt, TaskTarget } from "./domain/records.js";
import { liveLayer } from "./node-platform.js";

const childProcessLayer = NodeChildProcessSpawner.layer.pipe(Layer.provide(liveLayer));

type RepositoryTarget = Extract<TaskTarget, { kind: "repository" }>;
export interface RepositoryOperation {
  readonly attemptId: string;
  readonly attempt: Attempt;
  readonly target: RepositoryTarget;
  readonly worktreePath: string;
  readonly outputRef: string;
  readonly applicable: boolean;
}

export class GitError extends Data.TaggedError("GitError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
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

/** Resolve one immutable Task target from its real filesystem and Git identity. */
export function resolveTaskTarget(input: {
  cwd: string;
  path?: string;
  kind?: "directory" | "repository";
  revision?: string;
}): Effect.Effect<TaskTarget, GitError> {
  return Effect.gen(function* () {
    const path = yield* filesystem("resolve target", () =>
      realpath(resolve(input.cwd, input.path ?? ".")),
    );
    const targetStat = yield* filesystem("resolve target", () => stat(path));
    if (!targetStat.isDirectory())
      return yield* fail("resolve target", "Target is not a directory.");
    if (input.kind === "directory") return { kind: "directory" as const, path };

    const discovery = yield* gitResult(path, ["rev-parse", "--git-dir"]);
    if (discovery.code !== 0) {
      if (input.kind === "repository")
        return yield* fail(
          "resolve target",
          "Target is not an initialized Git work tree.",
          discovery,
        );
      return { kind: "directory" as const, path };
    }
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
    yield* exactCommit(commonDir, input.revision ?? "HEAD", "resolve target", path);
    return { kind: "repository" as const, checkoutRoot, commonDir };
  }).pipe(Effect.provide(childProcessLayer));
}

export function currentRevision(target: RepositoryTarget): Effect.Effect<string, GitError> {
  return resolveRevision(target, "HEAD");
}

export function resolveRevision(
  target: RepositoryTarget,
  revision: string,
): Effect.Effect<string, GitError> {
  return revalidate(target).pipe(
    Effect.flatMap(() =>
      exactCommit(target.commonDir, revision, "resolve revision", target.checkoutRoot),
    ),
    Effect.provide(childProcessLayer),
  );
}

/** A candidate parent is reusable only while its exact clean ref remains compacted. */
export function validateRetainedCandidate(
  operation: RepositoryOperation,
): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(operation.target);
    const output = operation.attempt.output;
    if (output?.kind !== "retained")
      return yield* fail("extend candidate", "Candidate parent has no retained output.");
    yield* requireCompactedCandidate(operation, output.tip);
    yield* requireExactRef(operation.target.commonDir, operation.outputRef, output.tip);
  }).pipe(Effect.provide(childProcessLayer));
}

export function isAncestor(
  target: RepositoryTarget,
  parent: string,
  child: string,
): Effect.Effect<boolean, GitError> {
  return ancestry(target.commonDir, parent, child).pipe(Effect.provide(childProcessLayer));
}

export function detachedPlacement(input: {
  agentDir: string;
  workstreamId: string;
  attemptId: string;
}) {
  return {
    worktreePath: join(
      input.agentDir,
      "workgraph",
      "worktrees",
      input.workstreamId,
      input.attemptId,
    ),
    outputRef: `refs/pi-workgraph/outputs/${input.workstreamId}/${input.attemptId}`,
  };
}

/** Create or recover only the exact clean detached checkout declared by the Attempt. */
export function ensureDetachedWorktree(
  operation: RepositoryOperation,
): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(operation.target);
    const base = baseCommit(operation.attempt);
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
  }).pipe(Effect.provide(childProcessLayer));
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

/** Classify repository bytes only after Worker closure, independent of semantic outcome. */
export function classifyOutput(
  operation: RepositoryOperation,
  at: string,
): Effect.Effect<Attempt, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(operation.target);
    const state = yield* ownedCheckout(operation, true);
    const base = baseCommit(operation.attempt);
    if (!(yield* ancestry(operation.target.commonDir, base, state.head)))
      return yield* fail("classify output", "Attempt HEAD is unrelated to its exact base.");
    yield* validateCandidate(operation, state.head);
    if (!state.dirty && state.head === base) {
      yield* removeCleanWorktree(operation);
      return { ...operation.attempt, output: { kind: "no_output" as const, completedAt: at } };
    }
    yield* createExactRef(operation.target.commonDir, operation.outputRef, state.head);
    if (!state.dirty) yield* removeCleanWorktree(operation);
    return {
      ...operation.attempt,
      output: {
        kind: "retained" as const,
        tip: state.head,
        reason: state.dirty
          ? "Dirty output is preserved for explicit disposition."
          : "Candidate output is retained.",
      },
    };
  }).pipe(Effect.provide(childProcessLayer));
}

/** Validate application facts and, at most once, checkpoint a clean same-ref advancement. */
export function prepareApplication(
  operation: RepositoryOperation,
): Effect.Effect<Attempt, GitError> {
  return Effect.gen(function* () {
    if (!operation.applicable)
      return yield* fail("apply output", "Only implementation output can be applied.");
    yield* revalidate(operation.target);
    const output = operation.attempt.output;
    return yield* output?.kind === "applying"
      ? prepareApplicationRetry(operation, output)
      : prepareRetainedApplication(operation);
  }).pipe(Effect.provide(childProcessLayer));
}

function prepareApplicationRetry(
  operation: RepositoryOperation,
  output: Extract<NonNullable<Attempt["output"]>, { kind: "applying" }>,
): Effect.Effect<Attempt, GitError> {
  return Effect.gen(function* () {
    const destination = yield* destinationState(operation.target);
    if (destination.ref !== output.destinationRef)
      return yield* fail("apply output", "Destination ref changed.");
    if (destination.dirty) return yield* fail("apply output", "Destination checkout is dirty.");
    if (
      destination.head === output.destinationHead ||
      (yield* isAppliedStructure(operation.target.commonDir, output, destination.head))
    )
      return operation.attempt;
    if (yield* ancestry(operation.target.commonDir, output.sourceTip, destination.head))
      return yield* fail("apply output", "Destination advanced beyond the exact candidate result.");
    if (
      output.replanned === true ||
      !(yield* ancestry(operation.target.commonDir, output.destinationHead, destination.head))
    )
      return yield* fail("apply output", "Destination changed after application preparation.");
    yield* proveMergeable(operation.target.commonDir, destination.head, output.sourceTip);
    return {
      ...operation.attempt,
      output: { ...output, destinationHead: destination.head, replanned: true as const },
    };
  });
}

function prepareRetainedApplication(
  operation: RepositoryOperation,
): Effect.Effect<Attempt, GitError> {
  return Effect.gen(function* () {
    const output = operation.attempt.output;
    if (output?.kind !== "retained")
      return yield* fail("apply output", "Attempt has no retained output.");
    yield* requireCompactedCandidate(operation, output.tip);
    const source = yield* requireExactRef(
      operation.target.commonDir,
      operation.outputRef,
      output.tip,
    );
    const root = candidateRoot(operation.attempt);
    if (!(yield* ancestry(operation.target.commonDir, root, source)))
      return yield* fail("apply output", "Candidate does not contain its source root.");
    const destination = yield* destinationState(operation.target);
    if (destination.dirty) return yield* fail("apply output", "Destination checkout is dirty.");
    if (
      !(yield* ancestry(
        operation.target.commonDir,
        baseCommit(operation.attempt),
        destination.head,
      ))
    )
      return yield* fail("apply output", "Destination no longer descends from the Attempt base.");
    yield* proveMergeable(operation.target.commonDir, destination.head, source);
    return {
      ...operation.attempt,
      output: {
        kind: "applying" as const,
        sourceRoot: root,
        sourceTip: source,
        destinationRef: destination.ref,
        destinationHead: destination.head,
      },
    };
  });
}

/** Recover structurally or advance only the prepared attached destination with merge --ff-only. */
export function applyOutput(
  operation: RepositoryOperation,
  at: string,
): Effect.Effect<Attempt, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(operation.target);
    const output = operation.attempt.output;
    if (output?.kind !== "applying")
      return yield* fail("apply output", "Application has no durable preparation checkpoint.");
    yield* requireCompactedCandidate(operation, output.sourceTip);
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
    return {
      ...operation.attempt,
      output: { kind: "applied" as const, revision, completedAt: at, cleanupTip: output.sourceTip },
    };
  }).pipe(Effect.provide(childProcessLayer));
}

function applicationRevision(
  operation: RepositoryOperation,
  output: Extract<NonNullable<Attempt["output"]>, { kind: "applying" }>,
  head: string,
): Effect.Effect<string, GitError> {
  return Effect.gen(function* () {
    if (yield* isAppliedStructure(operation.target.commonDir, output, head)) return head;
    if (head !== output.destinationHead)
      return yield* fail("apply output", "Destination changed after application preparation.");
    if (yield* ancestry(operation.target.commonDir, output.sourceTip, head)) return head;
    if (yield* ancestry(operation.target.commonDir, head, output.sourceTip)) {
      yield* git(operation.target.checkoutRoot, ["merge", "--ff-only", output.sourceTip]);
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
    yield* git(operation.target.checkoutRoot, ["merge", "--ff-only", merge]);
    return merge;
  });
}

/** Remove still-exact clean source resources only after the applied checkpoint is durable. */
export function cleanupAppliedOutput(
  operation: RepositoryOperation,
): Effect.Effect<Attempt, GitError> {
  return Effect.gen(function* () {
    const output = operation.attempt.output;
    if (output?.kind !== "applied" || output.cleanupTip === undefined) return operation.attempt;
    yield* revalidate(operation.target);
    yield* requireCompactedCandidate(operation, output.cleanupTip);
    yield* deleteExactRef(operation.target.commonDir, operation.outputRef, output.cleanupTip);
    const { cleanupTip: _cleanupTip, ...cleaned } = output;
    return { ...operation.attempt, output: cleaned };
  }).pipe(Effect.provide(childProcessLayer));
}

export function prepareDiscard(operation: RepositoryOperation, reason: string): Attempt {
  if (reason.trim().length === 0) throw error("discard output", "Discard requires a reason.");
  const output = operation.attempt.output;
  if (output?.kind === "discarding") return operation.attempt;
  if (output?.kind === "retained")
    return {
      ...operation.attempt,
      output: { kind: "discarding", tip: output.tip, reason },
    };
  if (output?.kind === "applied" && output.cleanupTip !== undefined)
    return {
      ...operation.attempt,
      output: {
        kind: "discarding",
        tip: output.cleanupTip,
        reason,
        applied: { revision: output.revision, completedAt: output.completedAt },
      },
    };
  throw error("discard output", "Attempt has no releasable output.");
}

/** Destructively remove only resources named by a durable exact-attempt discard checkpoint. */
export function discardOutput(
  operation: RepositoryOperation,
  at: string,
): Effect.Effect<Attempt, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(operation.target);
    const output = operation.attempt.output;
    if (output?.kind !== "discarding")
      return yield* fail("discard output", "Discard has no durable checkpoint.");
    const registration = yield* registeredWorktree(
      operation.target.commonDir,
      operation.worktreePath,
    );
    const exists = yield* pathExists(operation.worktreePath);
    if (registration !== undefined || exists) {
      if (registration === undefined || !exists)
        return yield* fail("discard output", "Attempt placement is foreign or incomplete.");
      const state = yield* ownedCheckout(operation, true);
      if (state.head !== output.tip)
        return yield* fail(
          "discard output",
          "Attempt checkout HEAD no longer matches its checkpoint.",
        );
      yield* git(operation.worktreePath, ["reset", "--hard", output.tip]);
      yield* git(operation.worktreePath, ["clean", "-fdx"], true);
      yield* removeCleanWorktree(operation);
    }
    yield* deleteExactRef(operation.target.commonDir, operation.outputRef, output.tip);
    return output.applied === undefined
      ? {
          ...operation.attempt,
          output: { kind: "discarded" as const, reason: output.reason, completedAt: at },
        }
      : {
          ...operation.attempt,
          output: {
            kind: "applied" as const,
            ...output.applied,
            cleanupReason: output.reason,
          },
        };
  }).pipe(Effect.provide(childProcessLayer));
}

function baseCommit(attempt: Attempt): string {
  if (attempt.base.kind !== "repository")
    throw error("inspect output", "Attempt has no repository base.");
  return attempt.base.baseCommit;
}
function candidateRoot(attempt: Attempt): string {
  return attempt.lineage?.candidateRoot ?? baseCommit(attempt);
}

function validateCandidate(
  operation: RepositoryOperation,
  head: string,
): Effect.Effect<void, GitError> {
  const lineage = operation.attempt.lineage?.candidateOf;
  if (lineage?.kind !== "integrate") return Effect.void;
  return Effect.all([
    ancestry(operation.target.commonDir, baseCommit(operation.attempt), head),
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

function requireCompactedCandidate(
  operation: RepositoryOperation,
  _tip: string,
): Effect.Effect<void, GitError> {
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
      return yield* fail(
        "apply output",
        "Destination must be an attached branch checkout.",
        refResult,
      );
    return {
      ref: refResult.stdout,
      head: yield* exactCommit(target.commonDir, "HEAD", "apply output", target.checkoutRoot),
      dirty: yield* dirty(target.checkoutRoot),
    };
  });
}

function isAppliedStructure(
  commonDir: string,
  output: Extract<NonNullable<Attempt["output"]>, { kind: "applying" }>,
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
    Effect.mapError((cause) =>
      error(
        "apply output",
        "Candidate conflicts with the destination; nothing was mutated.",
        cause,
      ),
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
      dirty: yield* dirty(operation.worktreePath),
    };
  });
}

function removeCleanWorktree(operation: RepositoryOperation): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    const state = yield* ownedCheckout(operation, false);
    if (state.dirty)
      return yield* fail("remove worktree", "Refusing to remove a dirty Attempt checkout.");
    yield* git(operation.target.checkoutRoot, ["worktree", "remove", operation.worktreePath], true);
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

function dirty(cwd: string): Effect.Effect<boolean, GitError> {
  return git(
    cwd,
    ["status", "--porcelain", "--untracked-files=all", "--ignored=matching"],
    true,
  ).pipe(Effect.map((output) => output.length > 0));
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
      return fail("inspect ancestry", "Git could not inspect candidate ancestry.", result);
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
    Effect.mapError((cause) =>
      cause.operation === operation
        ? cause
        : error(operation, "Revision did not resolve to one exact commit.", cause),
    ),
  );
}

function readRef(commonDir: string, ref: string): Effect.Effect<string | undefined, GitError> {
  return gitDirResult(commonDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).pipe(
    Effect.flatMap((result) => {
      if (result.code === 0) return Effect.succeed(result.stdout);
      // oxlint-disable-next-line effecttsgo/effect-succeed-with-void -- This branch inhabits the explicit optional-ref result.
      if (result.code === 1) return Effect.succeed<string | undefined>(undefined);
      return fail("inspect output ref", "Private output ref could not be inspected.", result);
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
    catch: (cause) => error("inspect path", "Attempt placement could not be inspected.", cause),
  });
}
function isErrno(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}
function filesystem<A>(operation: string, run: () => Promise<A>): Effect.Effect<A, GitError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => error(operation, "Filesystem operation failed.", cause),
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
  const process = ChildProcess.make("git", args, { cwd: processCwd(), stdin: "ignore" });
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
    Effect.mapError((cause) => error(args.join(" "), "Git process failed.", cause)),
    Effect.provide(childProcessLayer),
  );
}
function checked(
  args: readonly string[],
  result: CommandResult,
  allowEmpty: boolean,
): Effect.Effect<string, GitError> {
  if (result.code !== 0)
    return fail(args.join(" "), result.stderr || result.stdout || "Git command failed.", result);
  if (!allowEmpty && result.stdout.length === 0)
    return fail(args.join(" "), "Git returned no output.", result);
  return Effect.succeed(result.stdout);
}
function fail(operation: string, message: string, cause?: unknown): Effect.Effect<never, GitError> {
  return Effect.fail(error(operation, message, cause));
}
function error(operation: string, message: string, cause?: unknown): GitError {
  return new GitError({ operation, message, cause });
}
function processCwd(): string {
  return globalThis.process.cwd();
}
