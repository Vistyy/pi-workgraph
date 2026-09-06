// oxlint-disable-next-line effecttsgo/node-builtin-import -- This adapter validates real Node filesystem identities around Git worktrees.
import { lstat, mkdir, realpath } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Node path operations are the lexical identity boundary for Git worktrees.
import { basename, dirname, join, resolve } from "node:path";
import { Data, Effect } from "effect";
import { type ProcessExecutionError, type ProcessResult, processEffect } from "./process.js";

export { runProcess } from "./process.js";

export interface RepositoryInfo {
  root: string;
  commonDir: string;
  head: string;
  status: string;
}

export interface WorktreePlacement {
  path: string;
  branch: string;
  baseCommit: string;
}

export interface ValidatedCommit {
  commit: string;
  changedFiles: string[];
}

export interface WorktreeCleanupResult {
  state: "completed" | "blocked";
  path: string;
  branch: string;
  expectedHead: string;
  detail: string;
}

interface WorktreeRecord {
  path: string;
  branch?: string;
}

interface WorktreeIdentity {
  worktreeRoot: string;
  placement: WorktreePlacement;
}

type RefInspection = { state: "absent" } | { state: "present"; head: string };

class GitOperationError extends Data.TaggedError("GitOperationError")<{
  readonly message: string;
}> {}

class GitFileSystemError extends Data.TaggedError("GitFileSystemError")<{
  readonly message: string;
  readonly code: string;
}> {}

type GitFailure = GitOperationError | GitFileSystemError | ProcessExecutionError;
type GitEffect<A> = Effect.Effect<A, GitFailure>;

export class GitRepository {
  constructor(
    readonly root: string,
    readonly commonDir: string,
  ) {}

  static inspect(cwd: string): Promise<RepositoryInfo> {
    return runGitPromise(
      Effect.gen(function* () {
        const root = yield* gitText(cwd, ["rev-parse", "--show-toplevel"]);
        const commonDirText = yield* gitText(root, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]);
        const commonDir = resolve(root, commonDirText);
        const head = yield* gitText(root, ["rev-parse", "HEAD"]);
        const status = yield* gitText(
          root,
          ["status", "--porcelain", "--untracked-files=all"],
          true,
        );
        return { root, commonDir, head, status };
      }),
    );
  }

  static open(cwd: string): Promise<GitRepository> {
    return runGitPromise(
      Effect.map(
        Effect.tryPromise(() => GitRepository.inspect(cwd)),
        (info) => new GitRepository(info.root, info.commonDir),
      ),
    );
  }

  head(cwd = this.root): Promise<string> {
    return runGitPromise(gitText(cwd, ["rev-parse", "HEAD"]));
  }

  resolveRevision(revision: string): Promise<string> {
    return runGitPromise(resolveRevision(this.root, revision));
  }

  status(cwd = this.root): Promise<string> {
    return runGitPromise(gitText(cwd, ["status", "--porcelain", "--untracked-files=all"], true));
  }

  retainCommit(runId: string, attemptId: string, commit: string): Promise<string> {
    const root = this.root;
    return runGitPromise(
      Effect.gen(function* () {
        const ref = yield* retainedRef(runId, attemptId);
        const resolved = yield* resolveRevision(root, commit);
        const existing = yield* inspectRef(
          root,
          ref,
          () => `Could not inspect retained ref ${ref}.`,
        );
        if (existing.state === "present") {
          const current = yield* gitText(root, ["rev-parse", ref]);
          if (current !== resolved) {
            return yield* fail(`Retained ref ${ref} points to a different commit.`);
          }
          return ref;
        }

        const update = yield* gitProcess(root, ["update-ref", ref, resolved, ""]);
        yield* verifyRetainedRef(root, ref, resolved, update);
        return ref;
      }),
    );
  }

  assertClean(cwd = this.root): Promise<void> {
    return runGitPromise(assertClean(cwd));
  }

  createWorktree(runId: string, nodeId: string, baseCommit: string): Promise<WorktreePlacement> {
    const root = this.root;
    return runGitPromise(
      Effect.gen(function* () {
        const identity = yield* worktreeIdentity(root, runId, nodeId, baseCommit);
        const resolvedBase = yield* resolveRevision(root, baseCommit);
        if (resolvedBase !== baseCommit) {
          return yield* fail("Worktree base must be an exact commit id.");
        }
        yield* filesystemPromise(() => mkdir(identity.worktreeRoot, { recursive: true }));

        const records = yield* worktreeRecords(root);
        const registered = yield* registeredPlacement(records, identity, nodeId);
        if (registered !== undefined) {
          yield* verifyExistingPlacement(identity);
          return identity.placement;
        }

        yield* createUnregisteredWorktree(root, identity, nodeId);
        return identity.placement;
      }),
    );
  }

  validateWorkerNoChange(
    placement: WorktreePlacement,
    reportedRevision: string,
  ): Promise<{ revision: string; changedFiles: string[] }> {
    const root = this.root;
    return runGitPromise(
      Effect.gen(function* () {
        yield* validatePlacementIdentity(root, placement, "No-change validation");
        const status = yield* gitText(
          placement.path,
          ["status", "--porcelain", "--untracked-files=all"],
          true,
        );
        if (status.length > 0) {
          return yield* fail(`No-change worktree is not clean:\n${status}`);
        }
        const revision = yield* gitText(placement.path, ["rev-parse", "HEAD"]);
        if (reportedRevision !== revision) {
          return yield* fail(
            `Worker reported no-change revision ${reportedRevision}, but worktree HEAD is ${revision}.`,
          );
        }
        if (revision !== placement.baseCommit) {
          return yield* fail(
            `Worker reported no change, but isolated worktree HEAD advanced from ${placement.baseCommit} to ${revision}.`,
          );
        }
        yield* assertStableCleanHead(placement.path, revision, "No-change validation");
        return { revision, changedFiles: [] };
      }),
    );
  }

  validateWorkerCommit(
    placement: WorktreePlacement,
    reportedCommit?: string,
  ): Promise<ValidatedCommit> {
    const root = this.root;
    return runGitPromise(
      Effect.gen(function* () {
        yield* validatePlacementIdentity(root, placement, "Worker commit validation");
        yield* assertClean(placement.path);
        const commit = yield* gitText(placement.path, ["rev-parse", "HEAD"]);
        if (reportedCommit !== undefined && reportedCommit !== commit) {
          return yield* fail(
            `Worker reported commit ${reportedCommit}, but worktree HEAD is ${commit}.`,
          );
        }
        if (commit === placement.baseCommit) {
          return yield* fail("Worker completed without creating a commit.");
        }
        const commitCount = Number(
          yield* gitText(placement.path, [
            "rev-list",
            "--count",
            `${placement.baseCommit}..${commit}`,
          ]),
        );
        if (commitCount !== 1) {
          return yield* fail(
            `Worker must produce exactly one commit, but produced ${commitCount}.`,
          );
        }
        const parents = yield* gitText(placement.path, [
          "rev-list",
          "--parents",
          "-n",
          "1",
          commit,
        ]);
        if (parents !== `${commit} ${placement.baseCommit}`) {
          return yield* fail(
            `Worker commit ${commit} is not directly based on ${placement.baseCommit}.`,
          );
        }
        const changedText = yield* gitText(
          placement.path,
          ["diff", "--name-only", "--no-renames", placement.baseCommit, commit],
          true,
        );
        const changedFiles =
          changedText.length > 0
            ? changedText
                .split("\n")
                .filter((path) => path.length > 0)
                .sort()
            : [];
        if (changedFiles.length === 0) {
          return yield* fail("Worker commit does not change any files.");
        }
        yield* assertStableCleanHead(placement.path, commit, "Worker commit validation");
        return { commit, changedFiles };
      }),
    );
  }

  recoverComposition(
    expectedHead: string,
    source: { baseCommit: string; commit: string },
  ): Promise<{ head: string } | undefined> {
    const root = this.root;
    return runGitPromise(
      Effect.gen(function* () {
        yield* assertClean(root);
        const head = yield* gitText(root, ["rev-parse", "HEAD"]);
        if (head === expectedHead) return undefined;
        const parents = yield* gitText(root, ["rev-list", "--parents", "-n", "1", head]);
        if (parents !== `${head} ${expectedHead}`) {
          return yield* fail("Recovery requires one direct unrecorded composition commit.");
        }
        const rootDiff = yield* diffFingerprint(root, expectedHead, head);
        const workerDiff = yield* diffFingerprint(root, source.baseCommit, source.commit);
        if (workerDiff !== rootDiff) {
          return yield* fail(
            `Could not attribute unrecorded composition HEAD ${head} to ${source.commit}.`,
          );
        }
        yield* assertStableCleanHead(root, head, "Composition recovery");
        return { head };
      }),
    );
  }

  compose(commit: string, expectedHead: string): Promise<string> {
    const root = this.root;
    return runGitPromise(
      Effect.gen(function* () {
        yield* assertClean(root);
        const before = yield* gitText(root, ["rev-parse", "HEAD"]);
        if (before !== expectedHead) {
          return yield* fail(
            `Composition HEAD changed: expected ${expectedHead}, found ${before}.`,
          );
        }
        const result = yield* gitProcess(root, ["cherry-pick", commit], 120_000);
        if (result.exitCode !== 0) {
          const headAfterFailure = yield* gitText(root, ["rev-parse", "HEAD"]).pipe(
            Effect.orElseSucceed(() => before),
          );
          if (headAfterFailure !== before) {
            return yield* fail(
              `Cherry-pick returned failure after HEAD changed from ${before} to ${headAfterFailure}; inspect repository state before retrying.`,
            );
          }
          yield* gitProcess(root, ["cherry-pick", "--abort"]).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          return yield* fail(
            `Cherry-pick conflict or failure for ${commit}: ${diagnostic(result)}`,
          );
        }
        yield* assertClean(root);
        const head = yield* gitText(root, ["rev-parse", "HEAD"]);
        const parents = yield* gitText(root, ["rev-list", "--parents", "-n", "1", head]);
        if (parents !== `${head} ${expectedHead}`) {
          return yield* fail(
            `Cherry-pick completed after composition HEAD changed from ${expectedHead}; inspect repository state before retrying.`,
          );
        }
        return head;
      }),
    );
  }

  /** Discard only an explicitly disposable, stopped experiment at its recorded identity. */
  discardExperiment(placement: WorktreePlacement, expectedHead: string): Promise<void> {
    const root = this.root;
    return runGitPromise(
      Effect.gen(function* () {
        const records = parseWorktreeList(
          yield* gitText(root, ["worktree", "list", "--porcelain"], true),
        );
        const record = records.find((item) => resolve(item.path) === resolve(placement.path));
        if (record === undefined) return;
        const actualPath = yield* filesystemPromise(() => realpath(placement.path));
        const head = yield* gitText(placement.path, ["rev-parse", "HEAD"]);
        if (
          record.branch !== placement.branch ||
          actualPath !== resolve(placement.path) ||
          head !== expectedHead
        ) {
          return yield* fail(
            "Refusing disposable cleanup: experiment identity or revision changed.",
          );
        }
        const actualBranch = yield* gitText(placement.path, ["symbolic-ref", "--short", "HEAD"]);
        const actualRoot = yield* gitText(placement.path, ["rev-parse", "--show-toplevel"]);
        if (actualBranch !== placement.branch || resolve(actualRoot) !== resolve(placement.path)) {
          return yield* fail("Refusing disposable cleanup: worktree Git metadata changed.");
        }
        for (const args of [
          ["reset", "--hard", expectedHead],
          ["clean", "-fdx"],
        ]) {
          const result = yield* gitProcess(placement.path, args);
          if (result.exitCode !== 0) {
            return yield* fail(`Disposable cleanup failed: ${diagnostic(result)}`);
          }
        }
        yield* assertStableCleanHead(placement.path, expectedHead, "Disposable cleanup");
      }),
    );
  }

  cleanupWorktree(
    placement: WorktreePlacement,
    expectedHead: string,
  ): Promise<WorktreeCleanupResult> {
    const root = this.root;
    return runGitPromise(
      Effect.gen(function* () {
        const registered = yield* cleanupRegistration(yield* worktreeRecords(root), placement);
        const branchRef = `refs/heads/${placement.branch}`;
        const branch = yield* inspectRef(
          root,
          branchRef,
          (result) => `Could not inspect worker branch ${placement.branch}: ${diagnostic(result)}`,
        );
        yield* removeRegisteredWorktree(root, placement, expectedHead, registered);
        yield* removeWorkerBranch(root, placement.branch, branchRef, expectedHead, branch);
        yield* requirePlacementAbsent(root, placement);
        return {
          state: "completed" as const,
          path: placement.path,
          branch: placement.branch,
          expectedHead,
          detail: "Exact clean worktree and branch were removed, or were already absent.",
        };
      }),
    );
  }
}

/** The single outward conversion boundary preserving GitRepository's Promise API. */
function runGitPromise<A>(operation: GitEffect<A>): Promise<A> {
  return Effect.runPromise(operation);
}

function retainedRef(runId: string, attemptId: string): GitEffect<string> {
  if (!validIdentity(runId) || !validIdentity(attemptId)) {
    return fail("Invalid retained commit identity.");
  }
  return Effect.succeed(`refs/workgraph-retained/${runId}/${attemptId}`);
}

function inspectRef(
  root: string,
  ref: string,
  inspectionFailure: (result: ProcessResult) => string,
): GitEffect<RefInspection> {
  return Effect.gen(function* () {
    const result = yield* gitProcess(root, ["rev-parse", "--verify", "--quiet", ref]);
    if (result.exitCode === 0) {
      return { state: "present" as const, head: result.stdout };
    }
    if (result.exitCode === 1) return { state: "absent" as const };
    return yield* fail(inspectionFailure(result));
  });
}

function verifyRetainedRef(
  root: string,
  ref: string,
  resolved: string,
  update: ProcessResult,
): GitEffect<void> {
  return Effect.gen(function* () {
    if (update.exitCode !== 0) {
      const raced = yield* inspectRef(
        root,
        ref,
        () => `Could not retain commit ${resolved}: ${diagnostic(update)}`,
      );
      if (raced.state === "absent" || raced.head !== resolved) {
        return yield* fail(`Could not retain commit ${resolved}: ${diagnostic(update)}`);
      }
      return;
    }
    const current = yield* gitText(root, ["rev-parse", ref]);
    if (current !== resolved) {
      return yield* fail(`Retained ref ${ref} did not reach ${resolved}.`);
    }
  });
}

function worktreeIdentity(
  root: string,
  runId: string,
  nodeId: string,
  baseCommit: string,
): GitEffect<WorktreeIdentity> {
  if (!validIdentity(runId) || !validIdentity(nodeId)) {
    return fail("Invalid worktree identity.");
  }
  const worktreeRoot = join(dirname(root), ".pi-workgraph-worktrees", basename(root), runId);
  return Effect.succeed({
    worktreeRoot,
    placement: {
      path: join(worktreeRoot, nodeId),
      branch: `pi-workgraph/${runId}/${nodeId}`,
      baseCommit,
    },
  });
}

function worktreeRecords(root: string): GitEffect<WorktreeRecord[]> {
  return Effect.map(gitText(root, ["worktree", "list", "--porcelain"], true), parseWorktreeList);
}

function validatePlacementIdentity(
  root: string,
  placement: WorktreePlacement,
  operation: string,
): GitEffect<void> {
  return Effect.gen(function* () {
    const records = yield* worktreeRecords(root);
    const registered = records.find(
      (worktree) => resolve(worktree.path) === resolve(placement.path),
    );
    if (registered === undefined || registered.branch !== placement.branch) {
      return yield* fail(
        `${operation} requires the recorded isolated worktree ${placement.path} on ${placement.branch}.`,
      );
    }
    if ((yield* filesystemPromise(() => realpath(placement.path))) !== resolve(placement.path)) {
      return yield* fail(`${operation} found a relocated worktree.`);
    }
    const actualRoot = yield* gitText(placement.path, ["rev-parse", "--show-toplevel"]);
    if (resolve(actualRoot) !== resolve(placement.path)) {
      return yield* fail(`${operation} found a changed worktree root.`);
    }
    const actualBranch = yield* gitText(placement.path, ["symbolic-ref", "--short", "HEAD"]);
    if (actualBranch !== placement.branch) {
      return yield* fail(`${operation} found a changed worktree branch.`);
    }
  });
}

function registeredPlacement(
  records: WorktreeRecord[],
  identity: WorktreeIdentity,
  nodeId: string,
): GitEffect<WorktreeRecord | undefined> {
  const { branch, path } = identity.placement;
  const registered = records.find(
    (worktree) => worktree.branch === branch || resolve(worktree.path) === resolve(path),
  );
  if (
    registered !== undefined &&
    (registered.branch !== branch || resolve(registered.path) !== resolve(path))
  ) {
    return fail(
      `Worktree identity collision for ${nodeId}: ${registered.path} on ${registered.branch ?? "detached HEAD"}.`,
    );
  }
  return Effect.succeed(registered);
}

function verifyExistingPlacement(identity: WorktreeIdentity): GitEffect<void> {
  const { baseCommit, path } = identity.placement;
  return Effect.gen(function* () {
    const existingHead = yield* gitText(path, ["rev-parse", "HEAD"]);
    const existingStatus = yield* gitText(
      path,
      ["status", "--porcelain", "--untracked-files=all"],
      true,
    );
    const fencedHead = yield* gitText(path, ["rev-parse", "HEAD"]);
    if (existingHead !== baseCommit || fencedHead !== existingHead || existingStatus.length > 0) {
      return yield* fail(
        `Existing worktree ${path} contains uncertain state at ${fencedHead}; inspect it before retrying.`,
      );
    }
  });
}

function inspectWorkerBranch(
  root: string,
  branchRef: string,
  branch: string,
  baseCommit: string,
): GitEffect<RefInspection> {
  return Effect.gen(function* () {
    const inspection = yield* inspectRef(
      root,
      branchRef,
      (result) => `Could not inspect worker branch ${branch}: ${diagnostic(result)}`,
    );
    if (inspection.state === "absent") return inspection;
    const current = yield* gitText(root, ["rev-parse", branchRef]);
    if (current !== baseCommit) {
      return yield* fail(
        `Existing worker branch ${branch} contains uncertain state at ${current}; inspect it before retrying.`,
      );
    }
    return { state: "present", head: current };
  });
}

function createUnregisteredWorktree(
  root: string,
  identity: WorktreeIdentity,
  nodeId: string,
): GitEffect<void> {
  const { baseCommit, branch, path } = identity.placement;
  const branchRef = `refs/heads/${branch}`;
  return Effect.gen(function* () {
    const branchInspection = yield* inspectWorkerBranch(root, branchRef, branch, baseCommit);
    if (yield* pathExists(path)) {
      return yield* fail(`Unregistered worktree path ${path} exists; inspect it before retrying.`);
    }
    if (branchInspection.state === "present") {
      const fencedHead = yield* gitText(root, ["rev-parse", branchRef]);
      if (fencedHead !== baseCommit) {
        return yield* fail(
          `Existing worker branch ${branch} contains uncertain state at ${fencedHead}; inspect it before retrying.`,
        );
      }
    }
    const args =
      branchInspection.state === "present"
        ? ["worktree", "add", path, branch]
        : ["worktree", "add", "-b", branch, path, baseCommit];
    const result = yield* gitProcess(root, args, 60_000);
    if (result.exitCode !== 0) {
      return yield* fail(`Could not create worktree ${nodeId}: ${diagnostic(result)}`);
    }
  });
}

function cleanupRegistration(
  records: WorktreeRecord[],
  placement: WorktreePlacement,
): GitEffect<WorktreeRecord | undefined> {
  const registered = records.find((worktree) => resolve(worktree.path) === resolve(placement.path));
  const branchAtAnotherPath = records.find(
    (worktree) =>
      worktree.branch === placement.branch && resolve(worktree.path) !== resolve(placement.path),
  );
  return branchAtAnotherPath === undefined
    ? Effect.succeed(registered)
    : fail(
        `Refusing cleanup: branch ${placement.branch} is registered at ${branchAtAnotherPath.path}, not ${placement.path}.`,
      );
}

function removeRegisteredWorktree(
  root: string,
  placement: WorktreePlacement,
  expectedHead: string,
  registered: WorktreeRecord | undefined,
): GitEffect<void> {
  if (registered === undefined) return Effect.void;
  return Effect.gen(function* () {
    if (registered.branch !== placement.branch) {
      return yield* fail(
        `Refusing cleanup: ${placement.path} is registered on ${registered.branch ?? "detached HEAD"}, not ${placement.branch}.`,
      );
    }
    const head = yield* gitText(placement.path, ["rev-parse", "HEAD"]);
    const status = yield* gitText(
      placement.path,
      ["status", "--porcelain", "--untracked-files=all"],
      true,
    );
    const fencedHead = yield* gitText(placement.path, ["rev-parse", "HEAD"]);
    if (head !== expectedHead || fencedHead !== expectedHead) {
      return yield* fail(
        `Refusing cleanup: ${placement.path} HEAD is ${fencedHead}, expected ${expectedHead}.`,
      );
    }
    if (status.length > 0) {
      return yield* fail(`Refusing cleanup of dirty worktree ${placement.path}: ${status}`);
    }
    const result = yield* gitProcess(root, ["worktree", "remove", placement.path], 60_000);
    if (result.exitCode !== 0) {
      return yield* fail(`Could not remove worktree ${placement.path}: ${diagnostic(result)}`);
    }
  });
}

function removeWorkerBranch(
  root: string,
  branch: string,
  branchRef: string,
  expectedHead: string,
  inspection: RefInspection,
): GitEffect<void> {
  if (inspection.state === "absent") return Effect.void;
  return Effect.gen(function* () {
    const branchHead = yield* gitText(root, ["rev-parse", branchRef]);
    if (branchHead !== expectedHead) {
      return yield* fail(
        `Refusing cleanup: branch ${branch} points to ${branchHead}, expected ${expectedHead}.`,
      );
    }
    const result = yield* gitProcess(root, ["update-ref", "-d", branchRef, expectedHead]);
    if (result.exitCode !== 0) {
      return yield* fail(`Could not remove worker branch ${branch}: ${diagnostic(result)}`);
    }
  });
}

function requirePlacementAbsent(root: string, placement: WorktreePlacement): GitEffect<void> {
  return Effect.flatMap(worktreeRecords(root), (records) => {
    const remaining = records.find(
      (worktree) =>
        resolve(worktree.path) === resolve(placement.path) || worktree.branch === placement.branch,
    );
    return remaining === undefined
      ? Effect.void
      : fail(`Cleanup postcondition failed for ${placement.path}.`);
  });
}

function resolveRevision(root: string, revision: string): GitEffect<string> {
  if (!/^[0-9a-f]{40,64}$/.test(revision)) {
    return fail("Revision must be an exact hexadecimal commit id.");
  }
  return gitText(root, ["rev-parse", "--verify", `${revision}^{commit}`]);
}

function assertClean(cwd: string): GitEffect<void> {
  return Effect.gen(function* () {
    const status = yield* gitText(cwd, ["status", "--porcelain", "--untracked-files=all"], true);
    if (status.length > 0) {
      return yield* fail(`Git working tree is not clean:\n${status}`);
    }
  });
}

function assertStableCleanHead(
  cwd: string,
  expectedHead: string,
  operation: string,
): GitEffect<void> {
  return Effect.gen(function* () {
    const status = yield* gitText(cwd, ["status", "--porcelain", "--untracked-files=all"], true);
    const head = yield* gitText(cwd, ["rev-parse", "HEAD"]);
    if (status.length > 0 || head !== expectedHead) {
      return yield* fail(
        `${operation} observed asynchronous Git state changes; inspect ${cwd} before retrying.`,
      );
    }
  });
}

function gitText(cwd: string, args: readonly string[], allowEmpty = false): GitEffect<string> {
  return Effect.gen(function* () {
    const result = yield* gitProcess(cwd, args);
    if (result.exitCode !== 0) {
      return yield* fail(`git ${args.join(" ")} failed: ${diagnostic(result)}`);
    }
    if (result.stdoutTruncated) {
      return yield* fail(
        `git ${args.join(" ")} exceeded the inspection output limit; partial output cannot establish Git identity.`,
      );
    }
    if (!allowEmpty && result.stdout.length === 0) {
      return yield* fail(`git ${args.join(" ")} returned no output.`);
    }
    return result.stdout;
  });
}

function diffFingerprint(cwd: string, base: string, head: string): GitEffect<string> {
  return Effect.gen(function* () {
    const result = yield* gitProcess(
      cwd,
      ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", base, head],
      30_000,
      true,
    );
    if (result.exitCode !== 0 || result.stdoutDigest === undefined) {
      return yield* fail(`Could not fingerprint Git change: ${diagnostic(result)}`);
    }
    return result.stdoutDigest;
  });
}

function gitProcess(
  cwd: string,
  args: readonly string[],
  timeoutMs = 30_000,
  digestStdout = false,
): GitEffect<ProcessResult> {
  return processEffect("git", ["-C", cwd, ...args], {
    cwd,
    timeoutMs,
    digestStdout,
  });
}

function filesystemPromise<A>(operation: () => Promise<A>): GitEffect<A> {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new GitFileSystemError({
        message: cause instanceof Error ? cause.message : String(cause),
        code: cause instanceof Error && "code" in cause ? String(cause.code) : "UNKNOWN",
      }),
  });
}

function pathExists(path: string): GitEffect<boolean> {
  return filesystemPromise(() => lstat(path)).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error): error is GitFileSystemError =>
        error instanceof GitFileSystemError && error.code === "ENOENT",
      () => Effect.succeed(false),
    ),
  );
}

function fail(message: string): GitEffect<never> {
  return Effect.fail(new GitOperationError({ message }));
}

function diagnostic(result: ProcessResult): string {
  return result.stderr.length > 0 ? result.stderr : result.stdout;
}

function validIdentity(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

function parseWorktreeList(value: string): WorktreeRecord[] {
  if (value.trim().length === 0) return [];
  return value
    .trim()
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split("\n");
      const pathLine = lines.find((line) => line.startsWith("worktree "));
      if (pathLine === undefined) {
        throw new Error(`Invalid git worktree record: ${block}`);
      }
      const branchLine = lines.find((line) => line.startsWith("branch refs/heads/"));
      const worktree: WorktreeRecord = {
        path: pathLine.slice("worktree ".length),
      };
      if (branchLine !== undefined) {
        worktree.branch = branchLine.slice("branch refs/heads/".length);
      }
      return worktree;
    });
}
