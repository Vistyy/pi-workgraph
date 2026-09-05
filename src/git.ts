import { spawn } from "node:child_process";
import { mkdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { CommandEvidence } from "./types.js";

const OUTPUT_LIMIT = 50 * 1024;

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

export class GitRepository {
  constructor(readonly root: string, readonly commonDir: string) {}

  static async inspect(cwd: string): Promise<RepositoryInfo> {
    const root = await gitText(cwd, ["rev-parse", "--show-toplevel"]);
    const commonDirText = await gitText(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const commonDir = resolve(root, commonDirText);
    const head = await gitText(root, ["rev-parse", "HEAD"]);
    const status = await gitText(root, ["status", "--porcelain", "--untracked-files=all"], true);
    return { root, commonDir, head, status };
  }

  static async open(cwd: string): Promise<GitRepository> {
    const info = await GitRepository.inspect(cwd);
    return new GitRepository(info.root, info.commonDir);
  }

  async head(cwd = this.root): Promise<string> {
    return gitText(cwd, ["rev-parse", "HEAD"]);
  }

  async status(cwd = this.root): Promise<string> {
    return gitText(cwd, ["status", "--porcelain", "--untracked-files=all"], true);
  }

  async assertClean(cwd = this.root): Promise<void> {
    const status = await this.status(cwd);
    if (status) throw new Error(`Git working tree is not clean:\n${status}`);
  }

  async createWorktree(runId: string, nodeId: string, baseCommit: string): Promise<WorktreePlacement> {
    const worktreeRoot = join(dirname(this.root), ".pi-workgraph-worktrees", basename(this.root), runId);
    const path = join(worktreeRoot, nodeId);
    const branch = `pi-workgraph/${sanitizeRef(runId)}/${sanitizeRef(nodeId)}`;
    await mkdir(worktreeRoot, { recursive: true });

    const pruned = await runProcess("git", ["-C", this.root, "worktree", "prune"], {
      cwd: this.root,
      timeoutMs: 30_000,
    });
    if (pruned.exitCode !== 0) throw new Error(`Could not prune stale worktree records: ${pruned.stderr || pruned.stdout}`);
    const worktrees = parseWorktreeList(await gitText(this.root, ["worktree", "list", "--porcelain"], true));
    const registered = worktrees.find((worktree) => worktree.branch === branch || resolve(worktree.path) === resolve(path));
    if (registered) {
      if (registered.branch !== branch || resolve(registered.path) !== resolve(path)) {
        throw new Error(`Worktree identity collision for ${nodeId}: ${registered.path} on ${registered.branch ?? "detached HEAD"}.`);
      }
      const existingHead = await this.head(path);
      const existingStatus = await this.status(path);
      if (existingHead === baseCommit && !existingStatus) return { path, branch, baseCommit };
      throw new Error(`Existing worktree ${path} contains uncertain state at ${existingHead}; inspect it before retrying.`);
    }

    const branchRef = `refs/heads/${branch}`;
    const branchExists = await runProcess("git", ["-C", this.root, "rev-parse", "--verify", "--quiet", branchRef], {
      cwd: this.root,
      timeoutMs: 30_000,
    });
    if (branchExists.exitCode === 0) {
      const existingHead = await gitText(this.root, ["rev-parse", branchRef]);
      if (existingHead !== baseCommit) {
        throw new Error(`Existing worker branch ${branch} contains uncertain state at ${existingHead}; inspect it before retrying.`);
      }
      const deleted = await runProcess("git", ["-C", this.root, "branch", "-D", branch], {
        cwd: this.root,
        timeoutMs: 30_000,
      });
      if (deleted.exitCode !== 0) throw new Error(`Could not remove stale worker branch ${branch}: ${deleted.stderr || deleted.stdout}`);
    } else if (branchExists.exitCode !== 1) {
      throw new Error(`Could not inspect worker branch ${branch}: ${branchExists.stderr || branchExists.stdout}`);
    }

    await rm(path, { recursive: true, force: true });
    const result = await runProcess("git", ["-C", this.root, "worktree", "add", "-b", branch, path, baseCommit], {
      cwd: this.root,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Could not create worktree ${nodeId}: ${result.stderr || result.stdout}`);
    }
    return { path, branch, baseCommit };
  }

  async validateWorkerCommit(
    placement: WorktreePlacement,
    reportedCommit?: string,
  ): Promise<ValidatedCommit> {
    await this.assertClean(placement.path);
    const commit = await this.head(placement.path);
    if (reportedCommit && reportedCommit !== commit) {
      throw new Error(`Worker reported commit ${reportedCommit}, but worktree HEAD is ${commit}.`);
    }
    if (commit === placement.baseCommit) throw new Error("Worker completed without creating a commit.");
    const commitCount = Number(await gitText(placement.path, ["rev-list", "--count", `${placement.baseCommit}..${commit}`]));
    if (commitCount !== 1) throw new Error(`Worker must produce exactly one commit, but produced ${commitCount}.`);
    const parent = await gitText(placement.path, ["rev-parse", `${commit}^`]);
    if (parent !== placement.baseCommit) {
      throw new Error(`Worker commit ${commit} is not directly based on ${placement.baseCommit}.`);
    }
    const changedText = await gitText(
      placement.path,
      ["diff", "--name-only", "--no-renames", placement.baseCommit, commit],
      true,
    );
    const changedFiles = changedText ? changedText.split("\n").filter(Boolean).sort() : [];
    if (changedFiles.length === 0) throw new Error("Worker commit does not change any files.");
    return { commit, changedFiles };
  }

  async recoverComposedCandidate(
    expectedHead: string,
    candidates: Array<{ nodeId: string; baseCommit: string; commit: string }>,
  ): Promise<{ nodeId: string; sourceCommit: string; head: string } | undefined> {
    await this.assertClean();
    const head = await this.head();
    if (head === expectedHead) return undefined;
    const count = Number(await gitText(this.root, ["rev-list", "--count", `${expectedHead}..${head}`]));
    if (count !== 1) throw new Error(`Recovery expected at most one unrecorded composition commit, but found ${count}.`);
    const rootDiff = await gitText(this.root, ["diff", "--binary", expectedHead, head]);
    const matches: Array<{ nodeId: string; sourceCommit: string; head: string }> = [];
    for (const candidate of candidates) {
      const workerDiff = await gitText(this.root, ["diff", "--binary", candidate.baseCommit, candidate.commit]);
      if (workerDiff === rootDiff) matches.push({ nodeId: candidate.nodeId, sourceCommit: candidate.commit, head });
    }
    if (matches.length !== 1) {
      throw new Error(`Could not attribute unrecorded composition HEAD ${head} to exactly one completed node.`);
    }
    return matches[0];
  }

  async compose(commit: string, expectedHead: string): Promise<string> {
    await this.assertClean();
    const before = await this.head();
    if (before !== expectedHead) {
      throw new Error(`Composition HEAD changed: expected ${expectedHead}, found ${before}.`);
    }
    const result = await runProcess("git", ["-C", this.root, "cherry-pick", commit], {
      cwd: this.root,
      timeoutMs: 120_000,
    });
    if (result.exitCode !== 0) {
      const headAfterFailure = await this.head().catch(() => before);
      if (headAfterFailure !== before) {
        throw new Error(`Cherry-pick returned failure after HEAD changed from ${before} to ${headAfterFailure}; inspect repository state before retrying.`);
      }
      await runProcess("git", ["-C", this.root, "cherry-pick", "--abort"], {
        cwd: this.root,
        timeoutMs: 30_000,
      }).catch(() => undefined);
      throw new Error(`Cherry-pick conflict or failure for ${commit}: ${result.stderr || result.stdout}`);
    }
    await this.assertClean();
    return this.head();
  }

  /** Discard only an explicitly disposable, stopped experiment at its recorded identity. */
  async discardExperiment(placement: WorktreePlacement, expectedHead: string): Promise<void> {
    const records = parseWorktreeList(await gitText(this.root, ["worktree", "list", "--porcelain"], true));
    const record = records.find((item) => resolve(item.path) === resolve(placement.path));
    if (!record) return; // A prior cleanup already removed this exact placement.
    if (record.branch !== placement.branch || await realpath(placement.path) !== resolve(placement.path) || await this.head(placement.path) !== expectedHead) {
      throw new Error("Refusing disposable cleanup: experiment identity or revision changed.");
    }
    const actualBranch = await gitText(placement.path, ["symbolic-ref", "--short", "HEAD"]);
    const actualRoot = await gitText(placement.path, ["rev-parse", "--show-toplevel"]);
    if (actualBranch !== placement.branch || resolve(actualRoot) !== resolve(placement.path)) throw new Error("Refusing disposable cleanup: worktree Git metadata changed.");
    for (const args of [["reset", "--hard", expectedHead], ["clean", "-fdx"]]) {
      const result = await runProcess("git", ["-C", placement.path, ...args], { cwd: this.root, timeoutMs: 30_000 });
      if (result.exitCode !== 0) throw new Error(`Disposable cleanup failed: ${result.stderr || result.stdout}`);
    }
    await this.assertClean(placement.path);
  }

  async cleanupWorktree(placement: WorktreePlacement, expectedHead: string): Promise<WorktreeCleanupResult> {
    const records = parseWorktreeList(await gitText(this.root, ["worktree", "list", "--porcelain"], true));
    const registered = records.find((worktree) => resolve(worktree.path) === resolve(placement.path));
    const branchAtAnotherPath = records.find((worktree) => worktree.branch === placement.branch && resolve(worktree.path) !== resolve(placement.path));
    if (branchAtAnotherPath) throw new Error(`Refusing cleanup: branch ${placement.branch} is registered at ${branchAtAnotherPath.path}, not ${placement.path}.`);
    const branchRef = `refs/heads/${placement.branch}`;
    const branchExists = await runProcess("git", ["-C", this.root, "rev-parse", "--verify", "--quiet", branchRef], { cwd: this.root, timeoutMs: 30_000 });
    if (registered) {
      if (registered.branch !== placement.branch) throw new Error(`Refusing cleanup: ${placement.path} is registered on ${registered.branch ?? "detached HEAD"}, not ${placement.branch}.`);
      const head = await this.head(placement.path);
      const status = await this.status(placement.path);
      if (head !== expectedHead) throw new Error(`Refusing cleanup: ${placement.path} HEAD is ${head}, expected ${expectedHead}.`);
      if (status) throw new Error(`Refusing cleanup of dirty worktree ${placement.path}: ${status}`);
      const result = await runProcess("git", ["-C", this.root, "worktree", "remove", placement.path], { cwd: this.root, timeoutMs: 60_000 });
      if (result.exitCode !== 0) throw new Error(`Could not remove worktree ${placement.path}: ${result.stderr || result.stdout}`);
    }
    if (branchExists.exitCode === 0) {
      const branchHead = await gitText(this.root, ["rev-parse", branchRef]);
      if (branchHead !== expectedHead) throw new Error(`Refusing cleanup: branch ${placement.branch} points to ${branchHead}, expected ${expectedHead}.`);
      const branchResult = await runProcess("git", ["-C", this.root, "branch", "-D", placement.branch], { cwd: this.root, timeoutMs: 30_000 });
      if (branchResult.exitCode !== 0) throw new Error(`Could not remove worker branch ${placement.branch}: ${branchResult.stderr || branchResult.stdout}`);
    } else if (branchExists.exitCode !== 1) {
      throw new Error(`Could not inspect worker branch ${placement.branch}: ${branchExists.stderr || branchExists.stdout}`);
    }
    const remaining = parseWorktreeList(await gitText(this.root, ["worktree", "list", "--porcelain"], true)).find((worktree) => resolve(worktree.path) === resolve(placement.path) || worktree.branch === placement.branch);
    if (remaining) throw new Error(`Cleanup postcondition failed for ${placement.path}.`);
    return { state: "completed", path: placement.path, branch: placement.branch, expectedHead, detail: "Exact clean worktree and branch were removed, or were already absent." };
  }

  async removeWorktree(placement: WorktreePlacement): Promise<void> {
    await this.cleanupWorktree(placement, await this.head(placement.path));
  }

  async runCommands(commands: string[], cwd = this.root): Promise<CommandEvidence[]> {
    const evidence: CommandEvidence[] = [];
    for (const command of commands) {
      const started = Date.now();
      const result = await runProcess("bash", ["-lc", command], { cwd, timeoutMs: 300_000 });
      evidence.push({
        command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - started,
      });
      if (result.exitCode !== 0) break;
    }
    return evidence;
  }
}

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString();
      return Buffer.byteLength(next) <= OUTPUT_LIMIT ? next : next.slice(-OUTPUT_LIMIT);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });

    const stop = (): void => {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    timeout.unref();
    const onAbort = (): void => stop();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      if (signal && !timedOut && options.signal?.aborted) {
        stderr = `${stderr}\nAborted by signal ${signal}.`.trim();
      }
      resolvePromise({ exitCode: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim(), timedOut });
    });
  });
}

async function gitText(cwd: string, args: string[], allowEmpty = false): Promise<string> {
  const result = await runProcess("git", ["-C", cwd, ...args], { cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  if (!allowEmpty && !result.stdout) throw new Error(`git ${args.join(" ")} returned no output.`);
  return result.stdout;
}

function parseWorktreeList(value: string): Array<{ path: string; branch?: string }> {
  if (!value.trim()) return [];
  return value.trim().split(/\n\n+/).map((block) => {
    const lines = block.split("\n");
    const pathLine = lines.find((line) => line.startsWith("worktree "));
    if (!pathLine) throw new Error(`Invalid git worktree record: ${block}`);
    const branchLine = lines.find((line) => line.startsWith("branch refs/heads/"));
    return {
      path: pathLine.slice("worktree ".length),
      ...(branchLine ? { branch: branchLine.slice("branch refs/heads/".length) } : {}),
    };
  });
}

function sanitizeRef(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "work";
}
