import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Disposable Git tests use real filesystem boundaries.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Disposable Git tests use real path identities.
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
  type CandidateApplicationDestination,
  type CandidateApplicationSource,
  GitParseError,
  GitRepository,
  openRepository,
  parseWorktreeList,
} from "../src/git.js";
import { git } from "./helpers.js";

const runGit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

async function applyCandidate(
  repository: GitRepository,
  source: CandidateApplicationSource,
  destination: CandidateApplicationDestination,
): Promise<string> {
  return runGit(repository.applyCandidate(source, destination));
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
    await assert.rejects(
      () => runGit(f.repository.cleanupWorktree(placement, f.base)),
      /branch .* expected|HEAD is/,
    );
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

void test("successful compaction retains an exact branch for validation and explicit discard", async () => {
  const f = await fixture();
  try {
    const placement = await runGit(f.repository.createWorktree("run", "candidate", f.base));
    await writeFile(join(placement.path, "data.txt"), "candidate\n");
    await git(placement.path, "add", ".");
    await git(placement.path, "commit", "-m", "Candidate");
    const commit = await runGit(f.repository.head(placement.path));
    assert.equal(
      (await runGit(f.repository.cleanupWorktree(placement, commit, true))).state,
      "completed",
    );
    assert.equal(
      (await git(f.root, "branch", "--list", placement.branch)).trim(),
      placement.branch,
    );
    await assert.rejects(readFile(placement.path, "utf8"));
    const validated = await runGit(f.repository.validateCandidate(placement, f.base, commit));
    assert.deepEqual(validated, {
      commit,
      changedFiles: ["data.txt"],
      rootCommit: f.base,
      commits: [commit],
    });
    assert.equal(
      (await runGit(f.repository.cleanupWorktree(placement, commit, true))).state,
      "completed",
    );
    assert.equal((await runGit(f.repository.discardOutput(placement, commit))).state, "completed");
    assert.equal(await git(f.root, "branch", "--list", placement.branch), "");
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

void test("discard removes dirty, untracked, and ignored owned content only after common-directory identity", async () => {
  const f = await fixture();
  try {
    const placement = await runGit(f.repository.createWorktree("run", "discard", f.base));
    await writeFile(join(placement.path, ".gitignore"), "ignored.txt\n");
    await writeFile(join(placement.path, "candidate.txt"), "candidate\n");
    await git(placement.path, "add", ".");
    await git(placement.path, "commit", "-m", "Discard candidate");
    const commit = await runGit(f.repository.head(placement.path));
    await writeFile(join(placement.path, "candidate.txt"), "dirty\n");
    await writeFile(join(placement.path, "untracked.txt"), "untracked\n");
    await writeFile(join(placement.path, "ignored.txt"), "ignored\n");

    const foreign = new GitRepository(f.root, join(f.parent, "foreign-common"));
    await assert.rejects(
      () => runGit(foreign.discardOutput(placement, commit)),
      /common directory/,
    );
    assert.equal(await readFile(join(placement.path, "candidate.txt"), "utf8"), "dirty\n");
    assert.equal(await readFile(join(placement.path, "untracked.txt"), "utf8"), "untracked\n");
    assert.equal(await readFile(join(placement.path, "ignored.txt"), "utf8"), "ignored\n");

    const discarded = await runGit(f.repository.discardOutput(placement, commit));
    assert.match(discarded.detail, /dirty, untracked, and ignored/);
    assert.doesNotMatch(
      await git(f.root, "worktree", "list", "--porcelain"),
      new RegExp(placement.path),
    );
    assert.equal(await git(f.root, "branch", "--list", placement.branch), "");
    await assert.rejects(readFile(placement.path));
    assert.equal((await runGit(f.repository.discardOutput(placement, commit))).state, "completed");
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

void test("discard refuses moved placement and HEAD mismatch without deleting output", async () => {
  const f = await fixture();
  try {
    const movedPlacement = await runGit(
      f.repository.createWorktree("run", "moved-discard", f.base),
    );
    const movedPath = `${movedPlacement.path}-elsewhere`;
    await git(f.root, "worktree", "move", movedPlacement.path, movedPath);
    await assert.rejects(
      () => runGit(f.repository.discardOutput(movedPlacement, f.base)),
      /registered at .* not/,
    );
    assert.equal(await runGit(f.repository.head(movedPath)), f.base);
    assert.equal(await git(f.root, "rev-parse", `refs/heads/${movedPlacement.branch}`), f.base);

    const changedPlacement = await runGit(
      f.repository.createWorktree("run", "changed-discard", f.base),
    );
    await writeFile(join(changedPlacement.path, "changed.txt"), "changed\n");
    await git(changedPlacement.path, "add", ".");
    await git(changedPlacement.path, "commit", "-m", "Unexpected head");
    const changedHead = await runGit(f.repository.head(changedPlacement.path));
    await assert.rejects(
      () => runGit(f.repository.discardOutput(changedPlacement, f.base)),
      /points to .* expected/,
    );
    assert.equal(await readFile(join(changedPlacement.path, "changed.txt"), "utf8"), "changed\n");
    assert.equal(
      await git(f.root, "rev-parse", `refs/heads/${changedPlacement.branch}`),
      changedHead,
    );
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

void test("candidate application validates lineage, ref identity, and fast-forwards once", async () => {
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
    const destination = await runGit(f.repository.inspectCandidateApplication(source));
    assert.equal(
      await runGit(f.repository.recoverCandidateApplication(destination, source)),
      undefined,
    );
    await git(f.root, "branch", "switched-recovery", f.base);
    await git(f.root, "switch", "switched-recovery");
    await assert.rejects(
      () => runGit(f.repository.recoverCandidateApplication(destination, source)),
      /destination ref .* expected/,
    );
    assert.equal(await runGit(f.repository.head()), f.base);
    await git(f.root, "switch", "main");
    await git(f.root, "branch", "-D", "switched-recovery");
    await assert.rejects(
      () => applyCandidate(f.repository, { ...source, commits: [f.base] }, destination),
      /exact source revisions/,
    );
    assert.equal(await runGit(f.repository.head()), f.base);
    const mergeHead = join(f.repository.commonDir, "MERGE_HEAD");
    await writeFile(mergeHead, `${first}\n`);
    try {
      await assert.rejects(
        () => applyCandidate(f.repository, source, destination),
        /pre-existing merge state/,
      );
      assert.equal(await runGit(f.repository.head()), f.base);
    } finally {
      await rm(mergeHead, { force: true });
    }
    await git(f.root, "branch", "switched-ff", f.base);
    await git(f.root, "switch", "switched-ff");
    try {
      await assert.rejects(
        () => runGit(f.repository.applyCandidate(source, destination)),
        /Application destination changed/,
      );
    } finally {
      await git(f.root, "switch", "main");
      await git(f.root, "branch", "-D", "switched-ff");
    }
    assert.equal(await applyCandidate(f.repository, source, destination), second);
    assert.equal(await runGit(f.repository.head()), second);
    assert.equal(await git(f.root, "rev-list", "--count", `${f.base}..HEAD`), "2");
    assert.deepEqual(await runGit(f.repository.recoverCandidateApplication(destination, source)), {
      head: second,
    });
    await writeFile(join(f.root, "data.txt"), "moved\n");
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-m", "Move destination");
    const moved = await runGit(f.repository.head());
    const movedBytes = await readFile(join(f.root, "data.txt"), "utf8");
    assert.equal(
      await applyCandidate(f.repository, source, {
        expectedRef: "refs/heads/main",
        expectedHead: moved,
      }),
      moved,
    );
    assert.equal(await runGit(f.repository.head()), moved);
    assert.equal(await readFile(join(f.root, "data.txt"), "utf8"), movedBytes);
    await writeFile(join(f.root, "unrelated.txt"), "dirty\n");
    await assert.rejects(
      () =>
        applyCandidate(f.repository, source, {
          expectedRef: "refs/heads/main",
          expectedHead: moved,
        }),
      /not clean/,
    );
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

void test("candidate application rejects unrelated destination history without mutation", async () => {
  const f = await fixture();
  try {
    const placement = await runGit(f.repository.createWorktree("run", "unrelated", f.base));
    await writeFile(join(placement.path, "candidate.txt"), "candidate\n");
    await git(placement.path, "add", ".");
    await git(placement.path, "commit", "-m", "Candidate");
    const candidate = await runGit(f.repository.head(placement.path));
    const source = { rootCommit: f.base, commit: candidate, commits: [candidate] };

    await git(f.root, "switch", "--orphan", "unrelated-destination");
    await writeFile(join(f.root, "unrelated.txt"), "unrelated\n");
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-m", "Unrelated destination");
    const destination = await runGit(f.repository.head());
    await assert.rejects(
      () => runGit(f.repository.inspectCandidateApplication(source)),
      /not descended from candidate root/,
    );
    assert.equal(await runGit(f.repository.head()), destination);
    assert.equal(await readFile(join(f.root, "unrelated.txt"), "utf8"), "unrelated\n");
    assert.equal(await runGit(f.repository.status()), "");
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

void test("candidate inspection rejects conflicts before destination mutation or merge state", async () => {
  const f = await fixture();
  try {
    const placement = await runGit(f.repository.createWorktree("run", "conflict", f.base));
    await writeFile(join(placement.path, "data.txt"), "candidate\n");
    await git(placement.path, "add", ".");
    await git(placement.path, "commit", "-m", "Candidate conflict");
    const candidate = await runGit(f.repository.head(placement.path));
    await writeFile(join(f.root, "data.txt"), "destination\n");
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-m", "Destination conflict");
    const destination = await runGit(f.repository.head());
    const source = { rootCommit: f.base, commit: candidate, commits: [candidate] };

    await assert.rejects(
      () => runGit(f.repository.inspectCandidateApplication(source)),
      /conflict preview failed/,
    );
    assert.equal(await runGit(f.repository.head()), destination);
    assert.equal(await readFile(join(f.root, "data.txt"), "utf8"), "destination\n");
    assert.equal(await runGit(f.repository.status()), "");
    await assert.rejects(readFile(join(f.repository.commonDir, "MERGE_HEAD")));
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

void test("candidate application creates the exact off-checkout merge tree", async () => {
  const f = await fixture();
  const placement = await runGit(f.repository.createWorktree("run", "candidate", f.base));
  try {
    await writeFile(join(placement.path, "data.txt"), "candidate\n");
    await git(placement.path, "add", ".");
    await git(placement.path, "commit", "-m", "Candidate");
    const candidate = await runGit(f.repository.head(placement.path));
    await writeFile(join(f.root, "other.txt"), "destination\n");
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-m", "Destination");
    const destinationHead = await runGit(f.repository.head());
    const source = { rootCommit: f.base, commit: candidate, commits: [candidate] };
    const destination = await runGit(f.repository.inspectCandidateApplication(source));
    const expectedTree = (
      await git(f.root, "merge-tree", "--write-tree", "--messages", destinationHead, candidate)
    ).split("\n", 1)[0];
    const applied = await applyCandidate(f.repository, source, destination);
    assert.equal(
      await git(f.root, "rev-list", "--parents", "-n", "1", applied),
      `${applied} ${destinationHead} ${candidate}`,
    );
    assert.equal(await git(f.root, "rev-parse", `${applied}^{tree}`), expectedTree);
    assert.equal(await readFile(join(f.root, "data.txt"), "utf8"), "candidate\n");
    assert.equal(await readFile(join(f.root, "other.txt"), "utf8"), "destination\n");
    assert.deepEqual(await runGit(f.repository.recoverCandidateApplication(destination, source)), {
      head: applied,
    });
    await writeFile(join(f.root, "after.txt"), "later\n");
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-m", "Descendant after application");
    await assert.rejects(
      () => runGit(f.repository.recoverCandidateApplication(destination, source)),
      /ambiguous/,
    );
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});
