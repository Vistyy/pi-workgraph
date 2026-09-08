import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Disposable Git tests use real filesystem boundaries.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Disposable Git tests use real path identities.
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
  GitParseError,
  type GitProcessRequest,
  type GitProcessRunner,
  GitRepository,
  GitStateUncertainError,
  openRepository,
  parseWorktreeList,
} from "../src/git.js";
import { ProcessExecutionError, type ProcessResult, processEffect } from "../src/process.js";
import { git } from "./helpers.js";

const runGit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await Effect.runPromise(Effect.sleep("10 millis"));
    }
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-git-"));
  const root = join(parent, "repo");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "fixture@example.test");
  await git(root, "config", "user.name", "Fixture");
  await writeFile(join(root, "data.txt"), "base\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "Initial fixture");
  await git(root, "commit", "--allow-empty", "-m", "Assigned base");
  const repository = await Effect.runPromise(openRepository(root));
  const { head } = repository;
  return { parent, root, repository, base: await runGit(head()) };
}

function processResult(
  overrides: Partial<Pick<ProcessResult, "exitCode" | "stderr" | "stdout" | "timedOut">>,
): ProcessResult {
  return {
    exitCode: overrides.exitCode ?? 0,
    stderr: overrides.stderr ?? "",
    stderrTruncated: false,
    stdout: overrides.stdout ?? "",
    stdoutTruncated: false,
    timedOut: overrides.timedOut ?? false,
  };
}

function liveProcess(request: GitProcessRequest) {
  return processEffect("git", ["-C", request.cwd, ...request.args], {
    cwd: request.cwd,
    timeoutMs: request.timeoutMs,
    digestStdout: request.digestStdout,
  });
}

function interceptProcess(
  intercept: (request: GitProcessRequest) => ReturnType<GitProcessRunner> | undefined,
): GitProcessRunner {
  return (request) => intercept(request) ?? liveProcess(request);
}

function processUnavailable(request: GitProcessRequest, message: string): ProcessExecutionError {
  return new ProcessExecutionError({
    command: "git",
    args: ["-C", request.cwd, ...request.args],
    cause: new Error(message),
  });
}

void test("Git worktree parsing rejects missing paths and preserves embedded newlines", async () => {
  const malformed = "branch refs/heads/missing-worktree\0\0";
  const failure = await Effect.runPromise(Effect.flip(parseWorktreeList(malformed)));
  assert.ok(failure instanceof GitParseError);
  assert.equal(failure.output, malformed);

  assert.deepEqual(
    await Effect.runPromise(
      parseWorktreeList(
        "worktree /tmp/path-with\na-newline\0HEAD 0123456789abcdef\0branch refs/heads/main\0\0",
      ),
    ),
    [{ path: "/tmp/path-with\na-newline", branch: "main" }],
  );
});

void test("interrupting a long read-only Git effect waits for the Git child to close", async () => {
  const f = await fixture();
  const hook = join(f.parent, "fsmonitor-hook");
  const started = join(f.parent, "fsmonitor-started");
  const closed = join(f.parent, "git-closed");
  try {
    await writeFile(
      hook,
      `#!/bin/sh\nparent="$PPID"\nprintf '%s' "$parent" > ${JSON.stringify(started)}\nwhile kill -0 "$parent" 2>/dev/null; do sleep 0.02; done\nprintf closed > ${JSON.stringify(closed)}\n`,
    );
    await chmod(hook, 0o755);
    await git(f.root, "config", "core.fsmonitor", hook);

    const controller = new AbortController();
    const running = Effect.runPromise(f.repository.status(), {
      signal: controller.signal,
    });
    assert.match(await waitForFile(started), /^[0-9]+$/);
    controller.abort();
    await assert.rejects(running);
    assert.equal(await waitForFile(closed), "closed");
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

void test("Git placements preserve unknown data; cleanup requires exact clean identity and is idempotent", async () => {
  const f = await fixture();
  try {
    const unknown = join(f.parent, ".pi-workgraph-worktrees", "repo", "run", "unknown");
    await mkdir(unknown, { recursive: true });
    await writeFile(join(unknown, "mine.txt"), "unattributed bytes");
    await assert.rejects(
      () => runGit(f.repository.createWorktree("run", "unknown", f.base)),
      /Unregistered worktree path/,
    );
    assert.equal(await readFile(join(unknown, "mine.txt"), "utf8"), "unattributed bytes");
    await assert.rejects(
      () => runGit(f.repository.createWorktree("../escape", "worker", f.base)),
      /Invalid worktree identity/,
    );

    const placement = await runGit(f.repository.createWorktree("run", "worker", f.base));
    assert.deepEqual(await runGit(f.repository.createWorktree("run", "worker", f.base)), placement);
    await writeFile(join(placement.path, "data.txt"), "maintained\n");
    await assert.rejects(
      () => runGit(f.repository.createWorktree("run", "worker", f.base)),
      /uncertain state/,
    );
    await assert.rejects(
      () => runGit(f.repository.cleanupWorktree(placement, f.base)),
      /dirty worktree/,
    );
    await git(placement.path, "add", ".");
    await git(placement.path, "commit", "-m", "Maintained change");
    const commit = await runGit(f.repository.head(placement.path));
    assert.deepEqual(await runGit(f.repository.validateWorkerCommit(placement, commit)), {
      commit,
      changedFiles: ["data.txt"],
    });
    await assert.rejects(() => runGit(f.repository.cleanupWorktree(placement, f.base)), /HEAD is/);
    assert.equal(await readFile(join(placement.path, "data.txt"), "utf8"), "maintained\n");
    assert.equal(
      (await runGit(f.repository.cleanupWorktree(placement, commit))).state,
      "completed",
    );
    assert.equal(
      (await runGit(f.repository.cleanupWorktree(placement, commit))).state,
      "completed",
    );
    assert.equal(await readFile(join(unknown, "mine.txt"), "utf8"), "unattributed bytes");
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

void test("timed-out and unavailable ref observations never remove a real worker worktree or branch", async () => {
  const observationFailures = [
    {
      name: "timeout",
      run: () => Effect.succeed(processResult({ exitCode: 1, timedOut: true })),
      expected: /timed out before a reliable result/,
    },
    {
      name: "unavailable",
      run: (request: GitProcessRequest) =>
        Effect.fail(processUnavailable(request, "ref observation unavailable")),
      expected: /ref observation unavailable/,
    },
  ] as const;

  for (const observationFailure of observationFailures) {
    const f = await fixture();
    const placement = await runGit(f.repository.createWorktree("run", "worker", f.base));
    const branchRef = `refs/heads/${placement.branch}`;
    const repository = new GitRepository(
      f.root,
      f.repository.commonDir,
      interceptProcess((request) =>
        request.args.join("\0") === `rev-parse\0--verify\0--quiet\0${branchRef}`
          ? observationFailure.run(request)
          : undefined,
      ),
    );
    try {
      const failure = await Effect.runPromise(
        Effect.flip(repository.cleanupWorktree(placement, f.base)),
      );
      if (failure instanceof ProcessExecutionError) {
        const cause =
          failure.cause instanceof Error ? failure.cause.message : String(failure.cause);
        assert.match(cause, observationFailure.expected);
      } else {
        assert.match(failure.message, observationFailure.expected);
      }
      assert.equal(await git(f.root, "rev-parse", branchRef), f.base);
      assert.match(
        await git(f.root, "worktree", "list", "--porcelain"),
        new RegExp(placement.path),
      );
    } finally {
      await rm(f.parent, { recursive: true, force: true });
    }
  }
});

void test("cleanup independently rechecks the exact branch after worktree registration disappears", async () => {
  const f = await fixture();
  const placement = await runGit(f.repository.createWorktree("run", "worker", f.base));
  const branchRef = `refs/heads/${placement.branch}`;
  let refInspections = 0;
  const repository = new GitRepository(
    f.root,
    f.repository.commonDir,
    interceptProcess((request) => {
      if (request.args.join("\0") !== `rev-parse\0--verify\0--quiet\0${branchRef}`) {
        return undefined;
      }
      refInspections += 1;
      return refInspections === 1 ? Effect.succeed(processResult({ exitCode: 1 })) : undefined;
    }),
  );
  try {
    await assert.rejects(
      () => runGit(repository.cleanupWorktree(placement, f.base)),
      /Cleanup branch postcondition failed/,
    );
    assert.equal(await git(f.root, "rev-parse", branchRef), f.base);
    assert.doesNotMatch(
      await git(f.root, "worktree", "list", "--porcelain"),
      new RegExp(placement.path),
    );
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

void test("candidate validation retains the complete direct history and refuses moved or dirty destinations", async () => {
  const f = await fixture();
  try {
    const firstPlacement = await runGit(f.repository.createWorktree("run", "first", f.base));
    await writeFile(join(firstPlacement.path, "data.txt"), "first\n");
    await git(firstPlacement.path, "add", ".");
    await git(firstPlacement.path, "commit", "-m", "First candidate");
    const first = await runGit(f.repository.head(firstPlacement.path));
    const secondPlacement = await runGit(f.repository.createWorktree("run", "second", first));
    await writeFile(join(secondPlacement.path, "data.txt"), "second\n");
    await git(secondPlacement.path, "add", ".");
    await git(secondPlacement.path, "commit", "-m", "Second candidate");
    const second = await runGit(f.repository.head(secondPlacement.path));
    const validated = await runGit(f.repository.validateCandidate(secondPlacement, f.base, second));
    assert.deepEqual(validated, {
      commit: second,
      changedFiles: ["data.txt"],
      rootCommit: f.base,
      commits: [first, second],
    });
    const source = { rootCommit: f.base, commit: second, commits: [first, second] };
    assert.equal(await runGit(f.repository.recoverCandidateApplication(f.base, source)), undefined);
    await assert.rejects(
      () => runGit(f.repository.applyCandidate({ ...source, commits: [f.base] }, f.base)),
      /Candidate source commit chain changed before application/,
    );
    assert.equal(await runGit(f.repository.head()), f.base);
    const mergeHead = join(f.repository.commonDir, "MERGE_HEAD");
    await writeFile(mergeHead, `${first}\n`);
    try {
      await assert.rejects(
        () => runGit(f.repository.applyCandidate(source, f.base)),
        /pre-existing merge state/,
      );
      assert.equal(await runGit(f.repository.head()), f.base);
    } finally {
      await rm(mergeHead, { force: true });
    }
    const unchangedFailureRepository = new GitRepository(
      f.root,
      f.repository.commonDir,
      interceptProcess((request) =>
        request.args.join("\\0") === `merge\\0--ff-only\\0--no-edit\\0${second}`
          ? Effect.succeed(processResult({ exitCode: 7, stderr: "merge failed" }))
          : undefined,
      ),
    );
    await assert.rejects(
      () => runGit(unchangedFailureRepository.applyCandidate(source, f.base)),
      /Fast-forward application.*failed/,
    );
    assert.equal(await runGit(f.repository.head()), f.base);
    assert.equal(await runGit(f.repository.applyCandidate(source, f.base)), second);
    assert.equal(await runGit(f.repository.head()), second);
    assert.equal(await git(f.root, "rev-list", "--count", `${f.base}..HEAD`), "2");
    assert.deepEqual(await runGit(f.repository.recoverCandidateApplication(f.base, source)), {
      head: second,
    });

    await writeFile(join(f.root, "data.txt"), "moved\n");
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-m", "Move destination");
    const moved = await runGit(f.repository.head());
    const movedBytes = await readFile(join(f.root, "data.txt"), "utf8");
    await assert.rejects(
      () => runGit(f.repository.applyCandidate(source, moved)),
      /candidate root/,
    );
    assert.equal(await runGit(f.repository.head()), moved);
    assert.equal(await readFile(join(f.root, "data.txt"), "utf8"), movedBytes);
    await writeFile(join(f.root, "unrelated.txt"), "dirty\n");
    await assert.rejects(() => runGit(f.repository.applyCandidate(source, moved)), /not clean/);
    assert.equal(await runGit(f.repository.head()), moved);
    assert.equal(await readFile(join(f.root, "data.txt"), "utf8"), movedBytes);
    assert.equal(await readFile(join(f.root, "unrelated.txt"), "utf8"), "dirty\n");
    assert.match(
      await git(f.root, "worktree", "list", "--porcelain"),
      new RegExp(secondPlacement.path),
    );
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

void test("unavailable post-failure HEAD leaves candidate application uncertain without recovery mutation", async () => {
  const f = await fixture();
  const placement = await runGit(f.repository.createWorktree("run", "worker", f.base));
  try {
    await writeFile(join(placement.path, "data.txt"), "candidate\n");
    await git(placement.path, "add", ".");
    await git(placement.path, "commit", "-m", "Candidate output");
    const commit = await runGit(f.repository.head(placement.path));
    const source = { rootCommit: f.base, commit, commits: [commit] };
    let headObservations = 0;
    let mergeAttempts = 0;
    const repository = new GitRepository(
      f.root,
      f.repository.commonDir,
      interceptProcess((request) => {
        const args = request.args.join("\\0");
        if (args === "rev-parse\\0HEAD") {
          headObservations += 1;
          if (headObservations === 2)
            return Effect.fail(processUnavailable(request, "destination HEAD unavailable"));
        }
        if (args === `merge\\0--ff-only\\0--no-edit\\0${commit}`) {
          mergeAttempts += 1;
          return Effect.succeed(processResult({ exitCode: 7, stderr: "transport lost" }));
        }
        return undefined;
      }),
    );
    const failure = await Effect.runPromise(Effect.flip(repository.applyCandidate(source, f.base)));
    assert.ok(failure instanceof GitStateUncertainError);
    assert.match(failure.message, /resulting HEAD is unavailable/);
    assert.match(failure.operationDiagnostic, /Fast-forward application/);
    assert.match(failure.followupDiagnostic, /destination HEAD unavailable/);
    assert.equal(mergeAttempts, 1);
    assert.equal(await runGit(f.repository.head()), f.base);
    assert.equal(await runGit(f.repository.status()), "");
    assert.equal(await runGit(repository.recoverCandidateApplication(f.base, source)), undefined);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

void test("uncertain candidate application is attributed only after exact postcondition recovery", async () => {
  const f = await fixture();
  const placement = await runGit(f.repository.createWorktree("run", "worker", f.base));
  try {
    await writeFile(join(placement.path, "data.txt"), "candidate\n");
    await git(placement.path, "add", ".");
    await git(placement.path, "commit", "-m", "Candidate output");
    const commit = await runGit(f.repository.head(placement.path));
    const source = { rootCommit: f.base, commit, commits: [commit] };
    const repository = new GitRepository(
      f.root,
      f.repository.commonDir,
      interceptProcess((request) => {
        if (request.args.join("\\0") !== `merge\\0--ff-only\\0--no-edit\\0${commit}`)
          return undefined;
        return Effect.promise(async () => {
          await git(f.root, "merge", "--ff-only", "--no-edit", commit);
          return processResult({ exitCode: 7, stderr: "transport lost after merge" });
        });
      }),
    );
    const failure = await Effect.runPromise(Effect.flip(repository.applyCandidate(source, f.base)));
    assert.ok(failure instanceof GitStateUncertainError);
    assert.match(failure.message, /state changed/);
    assert.equal(await runGit(f.repository.head()), commit);
    assert.equal(await runGit(f.repository.status()), "");
    assert.deepEqual(await runGit(repository.recoverCandidateApplication(f.base, source)), {
      head: commit,
    });
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});
