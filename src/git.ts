/* oxlint-disable effecttsgo/node-builtin-import -- Git is an exact subprocess boundary. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Data } from "effect";
import type { AttemptRecord, TaskTarget } from "./domain/records.js";

class GitError extends Data.TaggedError("GitError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {
  constructor(operation: string, message: string, cause?: unknown) {
    super(cause === undefined ? { operation, message } : { operation, message, cause });
  }
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

export function currentRevision(target: Extract<TaskTarget, { kind: "repository" }>): string {
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

/** Ensure only the exact predeclared detached worktree, including lost-response recovery. */
export function ensureDetachedWorktree(repository: NonNullable<AttemptRecord["repository"]>): void {
  if (!isCommit(repository.commonDir, repository.baseRevision))
    throw new GitError("create worktree", "Base revision is not a commit in the Task repository.");
  if (existsSync(repository.worktreePath)) {
    const commonDir = resolve(
      repository.worktreePath,
      git(repository.worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    );
    const head = git(repository.worktreePath, ["rev-parse", "HEAD"]);
    if (commonDir !== repository.commonDir || head !== repository.baseRevision)
      throw new GitError(
        "create worktree",
        "Existing worktree does not match the Attempt declaration.",
      );
    return;
  }
  mkdirSync(dirname(repository.worktreePath), { recursive: true, mode: 0o700 });
  git(repository.checkoutRoot, [
    "worktree",
    "add",
    "--detach",
    repository.worktreePath,
    repository.baseRevision,
  ]);
}

export function classifyOutput(attempt: AttemptRecord, successful: boolean): AttemptRecord {
  const repository = requiredRepository(attempt);
  const head = git(repository.worktreePath, ["rev-parse", "HEAD"]);
  const dirty =
    git(repository.worktreePath, ["status", "--porcelain", "--untracked-files=all"], true).length >
    0;
  if (!dirty && head === repository.baseRevision) {
    removeWorktree(repository.checkoutRoot, repository.worktreePath);
    return { ...attempt, repository: { ...repository, output: "unchanged" } };
  }
  if (!dirty && successful && isAncestor(repository.commonDir, repository.baseRevision, head)) {
    gitDir(repository.commonDir, ["update-ref", repository.outputRef, head], true);
    removeWorktree(repository.checkoutRoot, repository.worktreePath);
    return {
      ...attempt,
      repository: { ...repository, candidateRevision: head, output: "retained" },
    };
  }
  return {
    ...attempt,
    repository: { ...repository, candidateRevision: head, output: dirty ? "dirty" : "retained" },
  };
}

export function prepareApplication(attempt: AttemptRecord): AttemptRecord {
  const { repository, source, symbolic, before } = applicationContext(attempt);
  const prior = repository.application;
  if (prior !== undefined && (before === prior.expectedHead || before === prior.expectedResult))
    return attempt;
  if (prior?.replanCount === 1)
    throw new GitError("apply output", "Destination changed after the bounded application replan.");
  assertDestinationAncestry(repository, before);
  const expectedResult = isAncestor(repository.commonDir, source, before)
    ? before
    : mergeResult(repository.commonDir, before, source, attempt.id);
  return {
    ...attempt,
    repository: {
      ...repository,
      application: {
        expectedRef: symbolic,
        expectedHead: before,
        expectedResult,
        replanCount: prior === undefined ? 0 : 1,
      },
    },
  };
}

export function applyOutput(attempt: AttemptRecord): AttemptRecord {
  if (attempt.repository?.output === "applied") return attempt;
  const { repository, source, symbolic, before } = applicationContext(attempt);
  const application = repository.application;
  if (application === undefined)
    throw new GitError("apply output", "Application has no durable pre-effect checkpoint.");
  if (symbolic !== application.expectedRef)
    throw new GitError("apply output", "Destination ref changed after the application checkpoint.");
  if (before === application.expectedResult) return releaseApplied(attempt);
  if (before !== application.expectedHead)
    throw new GitError("apply output", "Destination changed after the application checkpoint.");
  git(repository.checkoutRoot, ["merge", "--ff-only", application.expectedResult]);
  if (
    gitDir(repository.commonDir, ["rev-parse", symbolic]) !== application.expectedResult ||
    git(repository.checkoutRoot, ["rev-parse", "HEAD"]) !== application.expectedResult
  )
    throw new GitError("apply output", "Git application result is structurally ambiguous.");
  return releaseApplied({ ...attempt, repository: { ...repository, candidateRevision: source } });
}

function applicationContext(attempt: AttemptRecord) {
  const repository = requiredRepository(attempt);
  if (repository.experiment)
    throw new GitError("apply output", "Experiment output cannot be applied.");
  if (repository.output !== "retained" || repository.candidateRevision === undefined)
    throw new GitError("apply output", "Attempt has no clean retained candidate.");
  const source = gitDir(repository.commonDir, ["rev-parse", repository.outputRef]);
  if (source !== repository.candidateRevision)
    throw new GitError("apply output", "Private output ref was repointed.");
  const status = git(
    repository.checkoutRoot,
    ["status", "--porcelain", "--untracked-files=all"],
    true,
  );
  if (status.length > 0) throw new GitError("apply output", "Destination checkout is dirty.");
  return {
    repository,
    source,
    symbolic: git(repository.checkoutRoot, ["symbolic-ref", "-q", "HEAD"]),
    before: git(repository.checkoutRoot, ["rev-parse", "HEAD"]),
  };
}

function assertDestinationAncestry(
  repository: NonNullable<AttemptRecord["repository"]>,
  revision: string,
): void {
  if (!isAncestor(repository.commonDir, repository.baseRevision, revision))
    throw new GitError(
      "apply output",
      "Destination no longer descends from the exact Attempt base.",
    );
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

export function discardOutput(attempt: AttemptRecord, reason: string): AttemptRecord {
  if (reason.trim().length === 0)
    throw new GitError("discard output", "Discard requires an explicit reason.");
  const repository = requiredRepository(attempt);
  if (repository.output === "discarded") return attempt;
  if (repository.output === "applied")
    throw new GitError("discard output", "Applied output cannot be discarded.");
  if (repository.outputRef.length > 0) {
    const current = optionalGitDir(repository.commonDir, [
      "rev-parse",
      "--verify",
      repository.outputRef,
    ]);
    if (current !== undefined && repository.candidateRevision !== current)
      throw new GitError("discard output", "Private output ref does not match the Attempt.");
  }
  removeWorktree(repository.checkoutRoot, repository.worktreePath, true);
  gitDir(repository.commonDir, ["update-ref", "-d", repository.outputRef], true);
  return { ...attempt, repository: { ...repository, output: "discarded" } };
}

function releaseApplied(attempt: AttemptRecord): AttemptRecord {
  const repository = requiredRepository(attempt);
  gitDir(repository.commonDir, ["update-ref", "-d", repository.outputRef], true);
  return { ...attempt, repository: { ...repository, output: "applied" } };
}
function requiredRepository(attempt: AttemptRecord): NonNullable<AttemptRecord["repository"]> {
  if (attempt.repository === undefined)
    throw new GitError("inspect output", "Attempt has no repository output.");
  return attempt.repository;
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
function optionalGitDir(commonDir: string, args: string[]): string | undefined {
  try {
    return gitDir(commonDir, args);
  } catch {
    return undefined;
  }
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
    throw new GitError(args.join(" "), "Git operation failed.", cause);
  }
}
