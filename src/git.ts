/* oxlint-disable effecttsgo/node-builtin-import -- Git is an exact subprocess boundary. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Data } from "effect";
import type { Attempt, TaskTarget } from "./domain/records.js";

class GitError extends Data.TaggedError("GitError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

type RepositoryTarget = Extract<TaskTarget, { kind: "repository" }>;
export interface RepositoryOperation {
  readonly attemptId: string;
  readonly attempt: Attempt;
  readonly target: RepositoryTarget;
  readonly worktreePath: string;
  readonly outputRef: string;
  readonly experiment: boolean;
}

export function resolveTaskTarget(input: {
  cwd: string;
  path?: string;
  kind?: "directory" | "repository";
}): TaskTarget {
  const path = resolve(input.cwd, input.path ?? ".");
  if (input.kind === "directory") return { kind: "directory", path };
  try {
    const checkoutRoot = git(path, ["rev-parse", "--show-toplevel"]);
    const common = git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return { kind: "repository", checkoutRoot, commonDir: resolve(path, common) };
  } catch (cause) {
    if (input.kind === "repository") throw cause;
    return { kind: "directory", path };
  }
}
export function currentRevision(target: RepositoryTarget): string {
  return git(target.checkoutRoot, ["rev-parse", "HEAD"]);
}
export function isAncestor(commonDir: string, parent: string, child: string): boolean {
  try {
    gitDir(commonDir, ["merge-base", "--is-ancestor", parent, child], true);
    return true;
  } catch {
    return false;
  }
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
export function ensureDetachedWorktree(operation: RepositoryOperation): void {
  const base = baseCommit(operation.attempt);
  if (!isCommit(operation.target.commonDir, base))
    throw error("create worktree", "Base commit is not in the Task repository.");
  if (existsSync(operation.worktreePath)) {
    const commonDir = resolve(
      operation.worktreePath,
      git(operation.worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    );
    const head = git(operation.worktreePath, ["rev-parse", "HEAD"]);
    if (commonDir !== operation.target.commonDir || head !== base)
      throw error("create worktree", "Existing worktree does not match the Attempt declaration.");
    return;
  }
  mkdirSync(dirname(operation.worktreePath), { recursive: true, mode: 0o700 });
  git(operation.target.checkoutRoot, ["worktree", "add", "--detach", operation.worktreePath, base]);
}
export function classifyOutput(
  operation: RepositoryOperation,
  successful: boolean,
  at: string,
): Attempt {
  const head = git(operation.worktreePath, ["rev-parse", "HEAD"]);
  const dirty =
    git(operation.worktreePath, ["status", "--porcelain", "--untracked-files=all"], true).length >
    0;
  if (!dirty && head === baseCommit(operation.attempt)) {
    removeWorktree(operation.target.checkoutRoot, operation.worktreePath);
    return { ...operation.attempt, output: { kind: "no_output", completedAt: at } };
  }
  if (
    !dirty &&
    successful &&
    isAncestor(operation.target.commonDir, baseCommit(operation.attempt), head)
  ) {
    gitDir(operation.target.commonDir, ["update-ref", operation.outputRef, head], true);
    removeWorktree(operation.target.checkoutRoot, operation.worktreePath);
    return {
      ...operation.attempt,
      output: { kind: "retained", tip: head, reason: "Successful candidate output." },
    };
  }
  return {
    ...operation.attempt,
    output: {
      kind: "retained",
      tip: head,
      reason: dirty
        ? "Dirty output requires explicit disposition."
        : "Output retained after unsuccessful execution.",
    },
  };
}
export function prepareApplication(operation: RepositoryOperation): Attempt {
  const output = operation.attempt.output;
  if (output?.kind === "applying") return operation.attempt;
  if (operation.experiment) throw error("apply output", "Experiment output cannot be applied.");
  if (output?.kind !== "retained") throw error("apply output", "Attempt has no retained output.");
  const source = gitDir(operation.target.commonDir, ["rev-parse", operation.outputRef]);
  if (source !== output.tip) throw error("apply output", "Private output ref was repointed.");
  const destinationRef = git(operation.target.checkoutRoot, ["symbolic-ref", "-q", "HEAD"]);
  const destinationHead = git(operation.target.checkoutRoot, ["rev-parse", "HEAD"]);
  if (
    git(operation.target.checkoutRoot, ["status", "--porcelain", "--untracked-files=all"], true)
      .length > 0
  )
    throw error("apply output", "Destination checkout is dirty.");
  const root = candidateRoot(operation.attempt);
  if (!isAncestor(operation.target.commonDir, baseCommit(operation.attempt), destinationHead))
    throw error("apply output", "Destination no longer descends from the exact Attempt base.");
  const preparedRevision = isAncestor(operation.target.commonDir, source, destinationHead)
    ? destinationHead
    : mergeResult(operation.target.commonDir, destinationHead, source, operation.attemptId);
  return {
    ...operation.attempt,
    output: {
      kind: "applying",
      sourceRoot: root,
      sourceTip: source,
      destinationRef,
      destinationHead,
      preparedRevision,
    },
  };
}
export function applyOutput(operation: RepositoryOperation, at: string): Attempt {
  const output = operation.attempt.output;
  if (output?.kind === "applied") return operation.attempt;
  if (output?.kind !== "applying" || output.preparedRevision === undefined)
    throw error("apply output", "Application has no durable preparation checkpoint.");
  const ref = git(operation.target.checkoutRoot, ["symbolic-ref", "-q", "HEAD"]);
  const head = git(operation.target.checkoutRoot, ["rev-parse", "HEAD"]);
  if (ref !== output.destinationRef) throw error("apply output", "Destination ref changed.");
  if (head !== output.preparedRevision) {
    if (head !== output.destinationHead)
      throw error("apply output", "Destination changed after preparation.");
    git(operation.target.checkoutRoot, ["merge", "--ff-only", output.preparedRevision]);
  }
  gitDir(operation.target.commonDir, ["update-ref", "-d", operation.outputRef], true);
  return {
    ...operation.attempt,
    output: { kind: "applied", revision: output.preparedRevision, completedAt: at },
  };
}
export function discardOutput(operation: RepositoryOperation, reason: string, at: string): Attempt {
  if (reason.trim().length === 0)
    throw error("discard output", "Discard requires an explicit reason.");
  if (operation.attempt.output?.kind === "applied")
    throw error("discard output", "Applied output cannot be discarded.");
  removeWorktree(operation.target.checkoutRoot, operation.worktreePath, true);
  gitDir(operation.target.commonDir, ["update-ref", "-d", operation.outputRef], true);
  return { ...operation.attempt, output: { kind: "discarded", reason, completedAt: at } };
}
function baseCommit(attempt: Attempt): string {
  if (attempt.base.kind !== "repository")
    throw error("inspect output", "Attempt has no repository base.");
  return attempt.base.baseCommit;
}
function candidateRoot(attempt: Attempt): string {
  return attempt.lineage?.candidateRoot ?? baseCommit(attempt);
}
function mergeResult(
  commonDir: string,
  destination: string,
  source: string,
  attemptId: string,
): string {
  if (isAncestor(commonDir, destination, source)) return source;
  const tree = gitDir(commonDir, ["merge-tree", "--write-tree", destination, source]);
  return gitDir(commonDir, [
    "commit-tree",
    tree,
    "-p",
    destination,
    "-p",
    source,
    "-m",
    `Integrate Workgraph output ${attemptId}`,
  ]);
}
function removeWorktree(checkoutRoot: string, path: string, force = false): void {
  try {
    git(checkoutRoot, ["worktree", "remove", ...(force ? ["--force"] : []), path], true);
  } catch (cause) {
    if (!force) throw cause;
    rmSync(path, { recursive: true, force: true });
    git(checkoutRoot, ["worktree", "prune"], true);
  }
}
function isCommit(commonDir: string, revision: string): boolean {
  try {
    gitDir(commonDir, ["cat-file", "-e", `${revision}^{commit}`], true);
    return true;
  } catch {
    return false;
  }
}
function git(cwd: string, args: string[], allowEmpty = false): string {
  return command(["-C", cwd, ...args], allowEmpty);
}
function gitDir(commonDir: string, args: string[], allowEmpty = false): string {
  return command([`--git-dir=${commonDir}`, ...args], allowEmpty);
}
function command(args: string[], allowEmpty = false): string {
  try {
    const output = execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!allowEmpty && output.length === 0) throw new Error("Git returned no output.");
    return output;
  } catch (cause) {
    throw error(args.join(" "), "Git operation failed.", cause);
  }
}
function error(operation: string, message: string, cause?: unknown): GitError {
  return new GitError({ operation, message, cause });
}
