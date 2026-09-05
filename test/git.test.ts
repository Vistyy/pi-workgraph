import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitRepository, runProcess } from "../src/git.js";
import { git } from "./helpers.js";

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
  const repository = await GitRepository.open(root);
  return { parent, root, repository, base: await repository.head() };
}

test("Git placements preserve unknown data; cleanup requires exact clean identity and is idempotent", async () => {
  const f = await fixture();
  try {
    const unknown = join(
      f.parent,
      ".pi-workgraph-worktrees",
      "repo",
      "run",
      "unknown",
    );
    await mkdir(unknown, { recursive: true });
    await writeFile(join(unknown, "mine.txt"), "unattributed bytes");
    await assert.rejects(
      () => f.repository.createWorktree("run", "unknown", f.base),
      /Unregistered worktree path/,
    );
    assert.equal(
      await readFile(join(unknown, "mine.txt"), "utf8"),
      "unattributed bytes",
    );
    await assert.rejects(
      () => f.repository.createWorktree("../escape", "worker", f.base),
      /Invalid worktree identity/,
    );

    const placement = await f.repository.createWorktree(
      "run",
      "worker",
      f.base,
    );
    assert.deepEqual(
      await f.repository.createWorktree("run", "worker", f.base),
      placement,
    );
    await writeFile(join(placement.path, "data.txt"), "maintained\n");
    await assert.rejects(
      () => f.repository.createWorktree("run", "worker", f.base),
      /uncertain state/,
    );
    await assert.rejects(
      () => f.repository.cleanupWorktree(placement, f.base),
      /dirty worktree/,
    );
    await git(placement.path, "add", ".");
    await git(placement.path, "commit", "-m", "Maintained change");
    const commit = await f.repository.head(placement.path);
    assert.deepEqual(
      await f.repository.validateWorkerCommit(placement, commit),
      { commit, changedFiles: ["data.txt"] },
    );
    await assert.rejects(
      () => f.repository.cleanupWorktree(placement, f.base),
      /HEAD is/,
    );
    assert.equal(
      await readFile(join(placement.path, "data.txt"), "utf8"),
      "maintained\n",
    );
    assert.equal(
      (await f.repository.cleanupWorktree(placement, commit)).state,
      "completed",
    );
    assert.equal(
      (await f.repository.cleanupWorktree(placement, commit)).state,
      "completed",
    );
    assert.equal(
      await readFile(join(unknown, "mine.txt"), "utf8"),
      "unattributed bytes",
    );
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("composition recovery compares complete large patches and rejects non-direct worker commits", async () => {
  const f = await fixture();
  try {
    const placement = await f.repository.createWorktree(
      "run",
      "worker",
      f.base,
    );
    const suffix = "identical large suffix\n".repeat(8_000);
    await writeFile(
      join(placement.path, "data.txt"),
      `expected-prefix\n${suffix}`,
    );
    await git(placement.path, "add", ".");
    await git(placement.path, "commit", "-m", "Worker output");
    const source = {
      baseCommit: f.base,
      commit: await f.repository.head(placement.path),
    };
    await writeFile(join(f.root, "data.txt"), `wrong-prefix\n${suffix}`);
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-m", "Unattributed output");
    const rootDiff = await runProcess(
      "git",
      ["diff", "--binary", f.base, "HEAD"],
      { cwd: f.root, timeoutMs: 30_000 },
    );
    const workerDiff = await runProcess(
      "git",
      ["diff", "--binary", f.base, source.commit],
      { cwd: f.root, timeoutMs: 30_000 },
    );
    assert.equal(rootDiff.stdoutTruncated, true);
    assert.equal(workerDiff.stdoutTruncated, true);
    assert.equal(
      rootDiff.stdout,
      workerDiff.stdout,
      "The old diagnostic-tail comparison would falsely attribute this commit",
    );
    await assert.rejects(
      () => f.repository.recoverComposition(f.base, source),
      /Could not attribute/,
    );

    await git(f.root, "revert", "--no-edit", "HEAD");
    const before = await f.repository.head();
    assert.equal(
      await f.repository.recoverComposition(before, source),
      undefined,
    );
    const head = await f.repository.compose(source.commit, before);
    assert.deepEqual(await f.repository.recoverComposition(before, source), {
      head,
    });
    assert.equal(
      await readFile(join(f.root, "data.txt"), "utf8"),
      `expected-prefix\n${suffix}`,
    );

    const tree = await git(f.root, "rev-parse", `${source.commit}^{tree}`);
    const merge = await git(
      f.root,
      "commit-tree",
      tree,
      "-p",
      f.base,
      "-p",
      `${f.base}^`,
      "-m",
      "Non-direct worker output",
    );
    await git(placement.path, "reset", "--hard", merge);
    assert.equal(
      await git(placement.path, "rev-list", "--count", `${f.base}..HEAD`),
      "1",
    );
    await assert.rejects(
      () => f.repository.validateWorkerCommit(placement, merge),
      /not directly based/,
    );
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});
