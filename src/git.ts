// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native mkdir establishes the validated placement parent while lstat and realpath fence exact worktree identity.
import { lstat, mkdir, realpath } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Node path operations are the lexical identity boundary for Git worktrees.
import { basename, dirname, join, resolve } from "node:path";
import { Data, Effect } from "effect";
import { ProcessExecutionError, type ProcessResult, processEffect } from "./process.js";

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

export interface ValidatedCandidate extends ValidatedCommit {
  rootCommit: string;
  commits: string[];
}

export interface CandidateApplicationSource {
  rootCommit: string;
  commit: string;
  commits: string[];
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

export interface GitProcessRequest {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly digestStdout: boolean;
}

export type GitProcessRunner = (
  request: GitProcessRequest,
) => Effect.Effect<ProcessResult, ProcessExecutionError>;

interface GitClient {
  readonly process: (
    cwd: string,
    args: readonly string[],
    timeoutMs?: number,
    digestStdout?: boolean,
  ) => GitEffect<ProcessResult>;
  readonly text: (cwd: string, args: readonly string[], allowEmpty?: boolean) => GitEffect<string>;
}

class GitOperationError extends Data.TaggedError("GitOperationError")<{
  readonly message: string;
}> {}

class GitFileSystemError extends Data.TaggedError("GitFileSystemError")<{
  readonly message: string;
  readonly code: string;
}> {}

export class GitParseError extends Data.TaggedError("GitParseError")<{
  readonly message: string;
  readonly output: string;
}> {}

export class GitStateUncertainError extends Data.TaggedError("GitStateUncertainError")<{
  readonly message: string;
  readonly operationDiagnostic: string;
  readonly followupDiagnostic: string;
}> {}

export type GitFailure =
  | GitOperationError
  | GitFileSystemError
  | GitParseError
  | GitStateUncertainError
  | ProcessExecutionError;
export type GitEffect<A> = Effect.Effect<A, GitFailure>;

export class GitRepository {
  private readonly git: GitClient;

  constructor(
    readonly root: string,
    readonly commonDir: string,
    processRunner: GitProcessRunner = liveGitProcessRunner,
  ) {
    this.git = makeGitClient(processRunner);
  }

  readonly head = (cwd: string = this.root): GitEffect<string> =>
    this.git.text(cwd, ["rev-parse", "HEAD"]);

  readonly resolveRevision = (revision: string): GitEffect<string> =>
    resolveRevision(this.git, this.root, revision);

  readonly status = (cwd: string = this.root): GitEffect<string> =>
    this.git.text(cwd, ["status", "--porcelain", "--untracked-files=all"], true);

  readonly assertClean = (cwd: string = this.root): GitEffect<void> => assertClean(this.git, cwd);

  readonly createWorktree = (
    runId: string,
    nodeId: string,
    baseCommit: string,
  ): GitEffect<WorktreePlacement> => {
    const root = this.root;
    const git = this.git;
    return Effect.gen(function* () {
      const identity = yield* worktreeIdentity(root, runId, nodeId, baseCommit);
      const resolvedBase = yield* resolveRevision(git, root, baseCommit);
      if (resolvedBase !== baseCommit) {
        return yield* fail("Worktree base must be an exact commit id.");
      }
      yield* filesystemPromise(() => mkdir(identity.worktreeRoot, { recursive: true }));

      const records = yield* worktreeRecords(git, root);
      const registered = yield* registeredPlacement(records, identity, nodeId);
      if (registered !== undefined) {
        yield* verifyExistingPlacement(git, identity);
        return identity.placement;
      }

      yield* createUnregisteredWorktree(git, root, identity, nodeId);
      return identity.placement;
    });
  };

  readonly validateWorkerNoChange = (
    placement: WorktreePlacement,
    reportedRevision: string,
  ): GitEffect<{ revision: string; changedFiles: string[] }> => {
    const root = this.root;
    const git = this.git;
    return Effect.gen(function* () {
      yield* validatePlacementIdentity(git, root, placement, "No-change validation");
      const status = yield* git.text(
        placement.path,
        ["status", "--porcelain", "--untracked-files=all"],
        true,
      );
      if (status.length > 0) {
        return yield* fail(`No-change worktree is not clean:\n${status}`);
      }
      const revision = yield* git.text(placement.path, ["rev-parse", "HEAD"]);
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
      yield* assertStableCleanHead(git, placement.path, revision, "No-change validation");
      return { revision, changedFiles: [] };
    });
  };

  readonly validateWorkerCommit = (
    placement: WorktreePlacement,
    reportedCommit?: string,
  ): GitEffect<ValidatedCommit> => {
    const root = this.root;
    const git = this.git;
    return Effect.gen(function* () {
      yield* validatePlacementIdentity(git, root, placement, "Worker commit validation");
      yield* assertClean(git, placement.path);
      const commit = yield* git.text(placement.path, ["rev-parse", "HEAD"]);
      if (reportedCommit !== undefined && reportedCommit !== commit) {
        return yield* fail(
          `Worker reported commit ${reportedCommit}, but worktree HEAD is ${commit}.`,
        );
      }
      if (commit === placement.baseCommit) {
        return yield* fail("Worker completed without creating a commit.");
      }
      const commitCount = Number(
        yield* git.text(placement.path, [
          "rev-list",
          "--count",
          `${placement.baseCommit}..${commit}`,
        ]),
      );
      if (commitCount !== 1) {
        return yield* fail(`Worker must produce exactly one commit, but produced ${commitCount}.`);
      }
      const parents = yield* git.text(placement.path, ["rev-list", "--parents", "-n", "1", commit]);
      if (parents !== `${commit} ${placement.baseCommit}`) {
        return yield* fail(
          `Worker commit ${commit} is not directly based on ${placement.baseCommit}.`,
        );
      }
      const changedText = yield* git.text(
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
      yield* assertStableCleanHead(git, placement.path, commit, "Worker commit validation");
      return { commit, changedFiles };
    });
  };

  readonly validateCandidate = (
    placement: WorktreePlacement,
    rootCommit: string,
    reportedCommit?: string,
  ): GitEffect<ValidatedCandidate> => {
    if (!/^[0-9a-f]{40,64}$/.test(rootCommit))
      return fail("Candidate root must be an exact commit id.");
    return this.validateWorkerCommit(placement, reportedCommit).pipe(
      Effect.flatMap((validated) =>
        candidateCommitChain(this.git, this.root, rootCommit, validated.commit).pipe(
          Effect.map((commits) => ({ ...validated, rootCommit, commits })),
        ),
      ),
    );
  };
  readonly recoverCandidateApplication = (
    expectedHead: string,
    source: CandidateApplicationSource,
  ): GitEffect<{ head: string } | undefined> => {
    const root = this.root;
    const git = this.git;
    return Effect.gen(function* () {
      yield* assertClean(git, root);
      const head = yield* git.text(root, ["rev-parse", "HEAD"]);
      if (head === expectedHead) return undefined;
      if (expectedHead !== source.rootCommit || head !== source.commit) {
        return yield* fail(
          `Could not attribute unrecorded candidate application HEAD ${head} to ${source.commit} rooted at ${source.rootCommit}.`,
        );
      }
      const commits = yield* candidateCommitChain(git, root, source.rootCommit, source.commit);
      if (!sameCommitChain(commits, source.commits)) {
        return yield* fail("Candidate application recovery found a changed commit chain.");
      }
      yield* assertStableCleanHead(git, root, head, "Candidate application recovery");
      return { head };
    });
  };

  readonly applyCandidate = (
    source: CandidateApplicationSource,
    expectedHead: string,
  ): GitEffect<string> => {
    const root = this.root;
    const git = this.git;
    return Effect.gen(function* () {
      yield* assertClean(git, root);
      if (!/^[0-9a-f]{40,64}$/.test(expectedHead))
        return yield* fail("Application destination must be an exact commit id.");
      const resolvedRoot = yield* resolveRevision(git, root, source.rootCommit);
      const resolvedCommit = yield* resolveRevision(git, root, source.commit);
      if (resolvedRoot !== source.rootCommit || resolvedCommit !== source.commit)
        return yield* fail("Candidate application requires exact source revisions.");
      const commits = yield* candidateCommitChain(git, root, source.rootCommit, source.commit);
      if (!sameCommitChain(commits, source.commits))
        return yield* fail("Candidate source commit chain changed before application.");
      const before = yield* git.text(root, ["rev-parse", "HEAD"]);
      if (before !== expectedHead)
        return yield* fail(`Application HEAD changed: expected ${expectedHead}, found ${before}.`);
      if (before !== source.rootCommit)
        return yield* fail(
          `Destination HEAD ${before} does not equal candidate root ${source.rootCommit}; integrate the retained candidate onto the moved destination first.`,
        );
      const priorMerge = yield* inspectRef(
        git,
        root,
        "MERGE_HEAD",
        (result) => `Could not inspect pre-application merge state: ${diagnostic(result)}`,
      );
      if (priorMerge.state === "present")
        return yield* fail(
          `Application found pre-existing merge state at ${priorMerge.head}; no mutation was attempted.`,
        );
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const result = yield* git.process(
            root,
            ["merge", "--ff-only", "--no-edit", source.commit],
            120_000,
          );
          if (!processSucceeded(result)) {
            const after = yield* git
              .text(root, ["rev-parse", "HEAD"])
              .pipe(
                Effect.catch((error) =>
                  uncertain(
                    "Fast-forward application failed and the resulting HEAD is unavailable; no recovery mutation was attempted.",
                    `Fast-forward application of ${source.commit}: ${diagnostic(result)}`,
                    failureDiagnostic(error),
                  ),
                ),
              );
            if (after === before) {
              yield* assertStableCleanHead(
                git,
                root,
                before,
                "Fast-forward application failure",
              ).pipe(
                Effect.catch((error) =>
                  uncertain(
                    "Fast-forward application failed and its unchanged destination state is uncertain.",
                    `Fast-forward application of ${source.commit}: ${diagnostic(result)}`,
                    failureDiagnostic(error),
                  ),
                ),
              );
              return yield* fail(
                `Fast-forward application of ${source.commit} failed: ${diagnostic(result)}`,
              );
            }
            return yield* uncertain(
              "Fast-forward application returned failure after destination state changed; no rollback was attempted.",
              `Fast-forward application of ${source.commit}: ${diagnostic(result)}`,
              `Observed HEAD ${after}, expected unchanged ${before} or final ${source.commit}.`,
            );
          }
          yield* assertStableCleanHead(git, root, source.commit, "Fast-forward application");
          return source.commit;
        }),
      );
    });
  };

  /** Discard only an explicitly disposable, stopped experiment at its recorded identity. */
  readonly discardExperiment = (
    placement: WorktreePlacement,
    expectedHead: string,
  ): GitEffect<void> => {
    const root = this.root;
    const git = this.git;
    return Effect.gen(function* () {
      const records = yield* parseWorktreeList(
        yield* git.text(root, ["worktree", "list", "--porcelain", "-z"], true),
      );
      const record = records.find((item) => resolve(item.path) === resolve(placement.path));
      if (record === undefined) return;
      const actualPath = yield* filesystemPromise(() => realpath(placement.path));
      const head = yield* git.text(placement.path, ["rev-parse", "HEAD"]);
      if (
        record.branch !== placement.branch ||
        actualPath !== resolve(placement.path) ||
        head !== expectedHead
      ) {
        return yield* fail("Refusing disposable cleanup: experiment identity or revision changed.");
      }
      const actualBranch = yield* git.text(placement.path, ["symbolic-ref", "--short", "HEAD"]);
      const actualRoot = yield* git.text(placement.path, ["rev-parse", "--show-toplevel"]);
      if (actualBranch !== placement.branch || resolve(actualRoot) !== resolve(placement.path)) {
        return yield* fail("Refusing disposable cleanup: worktree Git metadata changed.");
      }
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          for (const args of [
            ["reset", "--hard", expectedHead],
            ["clean", "-fdx"],
          ]) {
            const result = yield* git.process(placement.path, args);
            if (!processSucceeded(result)) {
              return yield* fail(`Disposable cleanup failed: ${diagnostic(result)}`);
            }
          }
          yield* assertStableCleanHead(git, placement.path, expectedHead, "Disposable cleanup");
        }),
      );
    });
  };

  readonly cleanupWorktree = (
    placement: WorktreePlacement,
    expectedHead: string,
  ): GitEffect<WorktreeCleanupResult> => {
    const root = this.root;
    const git = this.git;
    return Effect.gen(function* () {
      const registered = yield* cleanupRegistration(yield* worktreeRecords(git, root), placement);
      const branchRef = `refs/heads/${placement.branch}`;
      const branch = yield* inspectRef(
        git,
        root,
        branchRef,
        (result) => `Could not inspect worker branch ${placement.branch}: ${diagnostic(result)}`,
      );
      yield* removeRegisteredWorktree(git, root, placement, expectedHead, registered);
      yield* removeWorkerBranch(git, root, placement.branch, branchRef, expectedHead, branch);
      yield* requireCleanupComplete(git, root, placement, branchRef);
      return {
        state: "completed" as const,
        path: placement.path,
        branch: placement.branch,
        expectedHead,
        detail: "Exact clean worktree and branch were removed, or were already absent.",
      };
    });
  };
}

export function inspectRepository(cwd: string): GitEffect<RepositoryInfo> {
  const git = makeGitClient(liveGitProcessRunner);
  return Effect.gen(function* () {
    const root = yield* git.text(cwd, ["rev-parse", "--show-toplevel"]);
    const commonDirText = yield* git.text(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const commonDir = resolve(root, commonDirText);
    const head = yield* git.text(root, ["rev-parse", "HEAD"]);
    const status = yield* git.text(root, ["status", "--porcelain", "--untracked-files=all"], true);
    return { root, commonDir, head, status };
  });
}

export function openRepository(cwd: string): GitEffect<GitRepository> {
  return Effect.map(inspectRepository(cwd), (info) => new GitRepository(info.root, info.commonDir));
}

function inspectRef(
  git: GitClient,
  root: string,
  ref: string,
  inspectionFailure: (result: ProcessResult) => string,
): GitEffect<RefInspection> {
  return Effect.gen(function* () {
    const result = yield* git.process(root, ["rev-parse", "--verify", "--quiet", ref]);
    if (result.timedOut || result.stdoutTruncated) {
      return yield* fail(inspectionFailure(result));
    }
    if (result.exitCode === 0) {
      if (result.stdout.length === 0) return yield* fail(inspectionFailure(result));
      return { state: "present" as const, head: result.stdout };
    }
    if (result.exitCode === 1) return { state: "absent" as const };
    return yield* fail(inspectionFailure(result));
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

function worktreeRecords(git: GitClient, root: string): GitEffect<WorktreeRecord[]> {
  return Effect.flatMap(
    git.text(root, ["worktree", "list", "--porcelain", "-z"], true),
    parseWorktreeList,
  );
}

function validatePlacementIdentity(
  git: GitClient,
  root: string,
  placement: WorktreePlacement,
  operation: string,
): GitEffect<void> {
  return Effect.gen(function* () {
    const records = yield* worktreeRecords(git, root);
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
    const actualRoot = yield* git.text(placement.path, ["rev-parse", "--show-toplevel"]);
    if (resolve(actualRoot) !== resolve(placement.path)) {
      return yield* fail(`${operation} found a changed worktree root.`);
    }
    const actualBranch = yield* git.text(placement.path, ["symbolic-ref", "--short", "HEAD"]);
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

function verifyExistingPlacement(git: GitClient, identity: WorktreeIdentity): GitEffect<void> {
  const { baseCommit, path } = identity.placement;
  return Effect.gen(function* () {
    const existingHead = yield* git.text(path, ["rev-parse", "HEAD"]);
    const existingStatus = yield* git.text(
      path,
      ["status", "--porcelain", "--untracked-files=all"],
      true,
    );
    const fencedHead = yield* git.text(path, ["rev-parse", "HEAD"]);
    if (existingHead !== baseCommit || fencedHead !== existingHead || existingStatus.length > 0) {
      return yield* fail(
        `Existing worktree ${path} contains uncertain state at ${fencedHead}; inspect it before retrying.`,
      );
    }
  });
}

function inspectWorkerBranch(
  git: GitClient,
  root: string,
  branchRef: string,
  branch: string,
  baseCommit: string,
): GitEffect<RefInspection> {
  return Effect.gen(function* () {
    const inspection = yield* inspectRef(
      git,
      root,
      branchRef,
      (result) => `Could not inspect worker branch ${branch}: ${diagnostic(result)}`,
    );
    if (inspection.state === "absent") return inspection;
    const current = yield* git.text(root, ["rev-parse", branchRef]);
    if (current !== baseCommit) {
      return yield* fail(
        `Existing worker branch ${branch} contains uncertain state at ${current}; inspect it before retrying.`,
      );
    }
    return { state: "present", head: current };
  });
}

function createUnregisteredWorktree(
  git: GitClient,
  root: string,
  identity: WorktreeIdentity,
  nodeId: string,
): GitEffect<void> {
  const { baseCommit, branch, path } = identity.placement;
  const branchRef = `refs/heads/${branch}`;
  return Effect.gen(function* () {
    const branchInspection = yield* inspectWorkerBranch(git, root, branchRef, branch, baseCommit);
    if (yield* pathExists(path)) {
      return yield* fail(`Unregistered worktree path ${path} exists; inspect it before retrying.`);
    }
    if (branchInspection.state === "present") {
      const fencedHead = yield* git.text(root, ["rev-parse", branchRef]);
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
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const result = yield* git.process(root, args, 60_000);
        if (!processSucceeded(result)) {
          return yield* fail(
            `Could not create worktree ${nodeId}: ${diagnostic(result)}; inspect worktree and branch state before retrying.`,
          );
        }
        yield* validatePlacementIdentity(git, root, identity.placement, "Worktree creation");
        yield* assertStableCleanHead(git, path, baseCommit, "Worktree creation");
      }),
    );
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
  git: GitClient,
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
    const head = yield* git.text(placement.path, ["rev-parse", "HEAD"]);
    const status = yield* git.text(
      placement.path,
      ["status", "--porcelain", "--untracked-files=all"],
      true,
    );
    const fencedHead = yield* git.text(placement.path, ["rev-parse", "HEAD"]);
    if (head !== expectedHead || fencedHead !== expectedHead) {
      return yield* fail(
        `Refusing cleanup: ${placement.path} HEAD is ${fencedHead}, expected ${expectedHead}.`,
      );
    }
    if (status.length > 0) {
      return yield* fail(`Refusing cleanup of dirty worktree ${placement.path}: ${status}`);
    }
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const result = yield* git.process(root, ["worktree", "remove", placement.path], 60_000);
        if (!processSucceeded(result)) {
          return yield* fail(
            `Could not remove worktree ${placement.path}: ${diagnostic(result)}; inspect registration before retrying.`,
          );
        }
        const records = yield* worktreeRecords(git, root);
        if (records.some((worktree) => resolve(worktree.path) === resolve(placement.path))) {
          return yield* fail(
            `Worktree removal postcondition failed for ${placement.path}; inspect registration before retrying.`,
          );
        }
      }),
    );
  });
}

function removeWorkerBranch(
  git: GitClient,
  root: string,
  branch: string,
  branchRef: string,
  expectedHead: string,
  inspection: RefInspection,
): GitEffect<void> {
  if (inspection.state === "absent") return Effect.void;
  return Effect.gen(function* () {
    const branchHead = yield* git.text(root, ["rev-parse", branchRef]);
    if (branchHead !== expectedHead) {
      return yield* fail(
        `Refusing cleanup: branch ${branch} points to ${branchHead}, expected ${expectedHead}.`,
      );
    }
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const result = yield* git.process(root, ["update-ref", "-d", branchRef, expectedHead]);
        if (!processSucceeded(result)) {
          return yield* fail(
            `Could not remove worker branch ${branch}: ${diagnostic(result)}; inspect the ref before retrying.`,
          );
        }
        const removed = yield* inspectRef(
          git,
          root,
          branchRef,
          (inspection) =>
            `Could not verify removal of worker branch ${branch}: ${diagnostic(inspection)}`,
        );
        if (removed.state !== "absent") {
          return yield* fail(`Worker branch removal postcondition failed for ${branch}.`);
        }
      }),
    );
  });
}

function requireCleanupComplete(
  git: GitClient,
  root: string,
  placement: WorktreePlacement,
  branchRef: string,
): GitEffect<void> {
  return Effect.gen(function* () {
    const records = yield* worktreeRecords(git, root);
    if (records.some((worktree) => resolve(worktree.path) === resolve(placement.path))) {
      return yield* fail(`Cleanup worktree postcondition failed for ${placement.path}.`);
    }
    if (records.some((worktree) => worktree.branch === placement.branch)) {
      return yield* fail(
        `Cleanup branch registration postcondition failed for ${placement.branch}.`,
      );
    }
    const branch = yield* inspectRef(
      git,
      root,
      branchRef,
      (result) =>
        `Could not verify cleanup of worker branch ${placement.branch}: ${diagnostic(result)}`,
    );
    if (branch.state === "present") {
      return yield* fail(
        `Cleanup branch postcondition failed: ${placement.branch} remains at ${branch.head}.`,
      );
    }
  });
}

function resolveRevision(git: GitClient, root: string, revision: string): GitEffect<string> {
  if (!/^[0-9a-f]{40,64}$/.test(revision)) {
    return fail("Revision must be an exact hexadecimal commit id.");
  }
  return git.text(root, ["rev-parse", "--verify", `${revision}^{commit}`]);
}

function assertClean(git: GitClient, cwd: string): GitEffect<void> {
  return Effect.gen(function* () {
    const status = yield* git.text(cwd, ["status", "--porcelain", "--untracked-files=all"], true);
    if (status.length > 0) {
      return yield* fail(`Git working tree is not clean:\n${status}`);
    }
  });
}

function assertStableCleanHead(
  git: GitClient,
  cwd: string,
  expectedHead: string,
  operation: string,
): GitEffect<void> {
  return Effect.gen(function* () {
    const status = yield* git.text(cwd, ["status", "--porcelain", "--untracked-files=all"], true);
    const head = yield* git.text(cwd, ["rev-parse", "HEAD"]);
    if (status.length > 0 || head !== expectedHead) {
      return yield* fail(
        `${operation} observed asynchronous Git state changes; inspect ${cwd} before retrying.`,
      );
    }
  });
}

function gitText(
  process: GitClient["process"],
  cwd: string,
  args: readonly string[],
  allowEmpty = false,
): GitEffect<string> {
  return Effect.gen(function* () {
    const result = yield* process(cwd, args);
    if (!processSucceeded(result)) {
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

function candidateCommitChain(
  git: GitClient,
  root: string,
  rootCommit: string,
  commit: string,
): GitEffect<string[]> {
  return Effect.gen(function* () {
    if (rootCommit === commit) return yield* fail("Candidate must contain at least one commit.");
    const text = yield* git.text(
      root,
      ["rev-list", "--reverse", "--parents", `${rootCommit}..${commit}`],
      true,
    );
    const lines = text.length === 0 ? [] : text.split("\n");
    const commits: string[] = [];
    let parent = rootCommit;
    for (const line of lines) {
      const current = nextCandidateCommit(line, parent);
      if (current === undefined)
        return yield* fail(
          `Candidate ${commit} is not a complete linear history rooted at ${rootCommit}.`,
        );
      commits.push(current);
      parent = current;
    }
    if (commits.at(-1) !== commit)
      return yield* fail(`Candidate history does not terminate at exact source ${commit}.`);
    return commits;
  });
}

function sameCommitChain(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((commit, index) => commit === right[index]);
}

function nextCandidateCommit(line: string, parent: string): string | undefined {
  const parts = line.split(" ");
  const current = parts.length === 2 && parts[1] === parent ? parts[0] : undefined;
  return current !== undefined && /^[0-9a-f]{40,64}$/.test(current) ? current : undefined;
}

const liveGitProcessRunner: GitProcessRunner = ({ cwd, args, timeoutMs, digestStdout }) =>
  processEffect("git", ["-C", cwd, ...args], {
    cwd,
    timeoutMs,
    digestStdout,
  });

function makeGitClient(runner: GitProcessRunner): GitClient {
  const process: GitClient["process"] = (cwd, args, timeoutMs = 30_000, digestStdout = false) =>
    runner({ cwd, args, timeoutMs, digestStdout });
  return {
    process,
    text: (cwd, args, allowEmpty = false) => gitText(process, cwd, args, allowEmpty),
  };
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

function uncertain(
  summary: string,
  operationDiagnostic: string,
  followupDiagnostic: string,
): GitEffect<never> {
  return Effect.fail(
    new GitStateUncertainError({
      message: `${summary} Original operation: ${operationDiagnostic} Follow-up: ${followupDiagnostic}`,
      operationDiagnostic,
      followupDiagnostic,
    }),
  );
}

function processSucceeded(result: ProcessResult): boolean {
  return !result.timedOut && result.exitCode === 0;
}

function diagnostic(result: ProcessResult): string {
  const details = [`exit code ${result.exitCode}`];
  if (result.timedOut) details.push("timed out before a reliable result was observed");
  if (result.stderr.length > 0) details.push(result.stderr);
  else if (result.stdout.length > 0) details.push(result.stdout);
  return details.join("; ");
}

function failureDiagnostic(error: GitFailure): string {
  if (error instanceof ProcessExecutionError) {
    const cause = error.cause instanceof Error ? error.cause.message : String(error.cause);
    return `${error.command} ${error.args.join(" ")} could not execute: ${cause}`;
  }
  return error.message;
}

function validIdentity(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

export function parseWorktreeList(value: string): Effect.Effect<WorktreeRecord[], GitParseError> {
  return Effect.try({
    try: () => {
      if (value.length === 0) return [];
      if (!value.endsWith("\0\0")) {
        throw new Error("Invalid git worktree output: missing NUL record terminator.");
      }
      return value
        .slice(0, -2)
        .split("\0\0")
        .map((block) => {
          const fields = block.split("\0");
          const pathField = fields.find((field) => field.startsWith("worktree "));
          if (pathField === undefined) {
            throw new Error(`Invalid git worktree record: ${block}`);
          }
          const branchField = fields.find((field) => field.startsWith("branch refs/heads/"));
          const worktree: WorktreeRecord = {
            path: pathField.slice("worktree ".length),
          };
          if (branchField !== undefined) {
            worktree.branch = branchField.slice("branch refs/heads/".length);
          }
          return worktree;
        });
    },
    catch: (cause) =>
      new GitParseError({
        message: cause instanceof Error ? cause.message : String(cause),
        output: value,
      }),
  });
}
