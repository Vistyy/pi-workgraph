/* oxlint-disable effecttsgo/node-builtin-import -- These flows inspect real disposable Git repositories and bytes. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import type { Attempt, TaskTarget } from "../src/domain/records.js";
import {
  applyOutput,
  classifyOutput,
  cleanupAppliedOutput,
  detachedPlacement,
  discardOutput,
  ensureDetachedWorktree,
  GitError,
  prepareApplication,
  prepareDiscard,
  type RepositoryOperation,
  resolveTaskTarget,
} from "../src/git.js";
import { git } from "./helpers.js";

const at = "2026-03-20T12:00:00.000Z";
const selection = {
  kind: "implementation" as const,
  guide: { model: "fixture/guide", thinking: "high" as const },
  executor: { model: "fixture/executor", thinking: "high" as const },
};
type RepositoryTarget = Extract<TaskTarget, { kind: "repository" }>;

async function repository() {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-git-"));
  const root = join(parent, "repository");
  const agentDir = join(parent, "agent");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Workgraph Test");
  await git(root, "config", "user.email", "workgraph@example.invalid");
  await writeFile(join(root, ".gitignore"), "ignored.bin\n");
  await writeFile(join(root, "file.txt"), "base\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "base");
  const base = await git(root, "rev-parse", "HEAD");
  const resolved = await Effect.runPromise(resolveTaskTarget({ cwd: root, kind: "repository" }));
  assert.equal(resolved.kind, "repository");
  // SAFETY: The assertion above narrows this decoded target to the repository variant.
  return { parent, root, agentDir, base, target: resolved as RepositoryTarget };
}
function operation(
  fixture: Awaited<ReturnType<typeof repository>>,
  attemptId: string,
  attempt: Attempt,
): RepositoryOperation {
  return {
    attemptId,
    attempt,
    target: fixture.target,
    ...detachedPlacement({
      agentDir: fixture.agentDir,
      workstreamId: "ws-git",
      attemptId,
    }),
    applicable: true,
  };
}
function initial(baseCommit: string): Attempt {
  return { selection, base: { kind: "repository", baseCommit } };
}
async function commit(checkout: string, text: string, message = text): Promise<string> {
  await writeFile(join(checkout, "file.txt"), `${text}\n`);
  await git(checkout, "add", "file.txt");
  await git(checkout, "commit", "-m", message);
  return git(checkout, "rev-parse", "HEAD");
}

void test("target resolution preserves real nested Git identity and rejects invalid targets", async () => {
  const plain = await mkdtemp(join(tmpdir(), "workgraph-target-"));
  try {
    const directory = await Effect.runPromise(resolveTaskTarget({ cwd: plain }));
    assert.deepEqual(directory, { kind: "directory", path: plain });
    await assert.rejects(
      Effect.runPromise(resolveTaskTarget({ cwd: plain, kind: "repository" })),
      GitError,
    );
    const file = join(plain, "file");
    await writeFile(file, "x");
    await assert.rejects(
      Effect.runPromise(resolveTaskTarget({ cwd: plain, path: file })),
      GitError,
    );

    const unborn = join(plain, "unborn");
    await mkdir(unborn);
    await git(unborn, "init");
    await assert.rejects(Effect.runPromise(resolveTaskTarget({ cwd: unborn })), GitError);

    const fixture = await repository();
    try {
      const nested = join(fixture.root, "nested");
      await mkdir(nested);
      const link = join(fixture.parent, "linked");
      await symlink(nested, link);
      const target = await Effect.runPromise(
        resolveTaskTarget({ cwd: plain, path: link, revision: fixture.base }),
      );
      assert.deepEqual(target, fixture.target);
      await assert.rejects(
        Effect.runPromise(resolveTaskTarget({ cwd: link, revision: "f".repeat(40) })),
        GitError,
      );
    } finally {
      await rm(fixture.parent, { recursive: true, force: true });
    }
  } finally {
    await rm(plain, { recursive: true, force: true });
  }
});

void test("classification removes unchanged output, compacts every clean descendant, and preserves dirty bytes", async () => {
  const fixture = await repository();
  try {
    const unchanged = operation(fixture, "unchanged", initial(fixture.base));
    await Effect.runPromise(ensureDetachedWorktree(unchanged));
    const noOutput = await Effect.runPromise(classifyOutput(unchanged, at));
    assert.equal(noOutput.output?.kind, "no_output");
    await assert.rejects(readFile(join(unchanged.worktreePath, "file.txt")));
    assert.equal(
      await git(fixture.root, "show-ref", "--verify", "--quiet", unchanged.outputRef).catch(
        () => "absent",
      ),
      "absent",
    );

    const clean = operation(fixture, "clean", initial(fixture.base));
    await Effect.runPromise(ensureDetachedWorktree(clean));
    const cleanTip = await commit(clean.worktreePath, "candidate");
    const retained = await Effect.runPromise(classifyOutput(clean, at));
    assert.equal(retained.output?.kind, "retained");
    assert.equal(retained.output?.kind === "retained" ? retained.output.tip : "", cleanTip);
    assert.equal(await git(fixture.root, "rev-parse", clean.outputRef), cleanTip);
    await assert.rejects(readFile(join(clean.worktreePath, "file.txt")));

    const dirty = operation(fixture, "dirty", initial(fixture.base));
    await Effect.runPromise(ensureDetachedWorktree(dirty));
    await writeFile(join(dirty.worktreePath, "untracked.txt"), "untracked\n");
    await writeFile(join(dirty.worktreePath, "ignored.bin"), "ignored\n");
    const dirtyAttempt = await Effect.runPromise(classifyOutput(dirty, at));
    assert.equal(dirtyAttempt.output?.kind, "retained");
    assert.equal(await git(fixture.root, "rev-parse", dirty.outputRef), fixture.base);
    assert.equal(await readFile(join(dirty.worktreePath, "ignored.bin"), "utf8"), "ignored\n");
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

void test("fast-forward and divergent application recover structurally and clean only after checkpoint", async () => {
  const fixture = await repository();
  try {
    let fast = operation(fixture, "fast", initial(fixture.base));
    await Effect.runPromise(ensureDetachedWorktree(fast));
    const fastTip = await commit(fast.worktreePath, "fast");
    fast = { ...fast, attempt: await Effect.runPromise(classifyOutput(fast, at)) };
    const fastPrepared = await Effect.runPromise(prepareApplication(fast));
    fast = { ...fast, attempt: fastPrepared };
    const fastApplied = await Effect.runPromise(applyOutput(fast, at));
    assert.equal(fastApplied.output?.kind, "applied");
    assert.equal(await git(fixture.root, "rev-parse", "HEAD"), fastTip);
    assert.equal(await git(fixture.root, "rev-parse", fast.outputRef), fastTip);
    const fastCleaned = await Effect.runPromise(
      cleanupAppliedOutput({ ...fast, attempt: fastApplied }),
    );
    assert.equal(
      fastCleaned.output?.kind === "applied" ? fastCleaned.output.cleanupTip : "bad",
      undefined,
    );
    await assert.rejects(git(fixture.root, "rev-parse", fast.outputRef));

    const divergentBase = fastTip;
    let divergent = operation(fixture, "divergent", initial(divergentBase));
    await Effect.runPromise(ensureDetachedWorktree(divergent));
    const sourceTip = await commit(divergent.worktreePath, "source");
    divergent = { ...divergent, attempt: await Effect.runPromise(classifyOutput(divergent, at)) };
    await writeFile(join(fixture.root, "destination.txt"), "destination\n");
    await git(fixture.root, "add", "destination.txt");
    await git(fixture.root, "commit", "-m", "destination");
    const destinationTip = await git(fixture.root, "rev-parse", "HEAD");
    const applying = await Effect.runPromise(prepareApplication(divergent));
    divergent = { ...divergent, attempt: applying };
    const applied = await Effect.runPromise(applyOutput(divergent, at));
    assert.equal(applied.output?.kind, "applied");
    const merge = applied.output?.kind === "applied" ? applied.output.revision : "";
    assert.deepEqual((await git(fixture.root, "show", "-s", "--format=%P", merge)).split(" "), [
      destinationTip,
      sourceTip,
    ]);
    assert.equal(await git(fixture.root, "show", `${merge}:file.txt`), "source");
    const recovered = await Effect.runPromise(applyOutput(divergent, at));
    assert.equal(recovered.output?.kind === "applied" ? recovered.output.revision : "", merge);
    assert.equal(await git(fixture.root, "status", "--porcelain"), "");
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

void test("integration ancestry, conflicts, and reasoned discard preserve foreign content", async () => {
  const fixture = await repository();
  try {
    let source = operation(fixture, "source", initial(fixture.base));
    await Effect.runPromise(ensureDetachedWorktree(source));
    const sourceTip = await commit(source.worktreePath, "source");
    source = { ...source, attempt: await Effect.runPromise(classifyOutput(source, at)) };

    await git(fixture.root, "reset", "--hard", fixture.base);
    await writeFile(join(fixture.root, "destination.txt"), "destination\n");
    await git(fixture.root, "add", "destination.txt");
    await git(fixture.root, "commit", "-m", "destination");
    const destinationTip = await git(fixture.root, "rev-parse", "HEAD");
    let integration = operation(fixture, "integration", {
      ...initial(destinationTip),
      lineage: {
        candidateRoot: destinationTip,
        candidateOf: { kind: "integrate", attemptId: "source", sourceTip },
      },
    });
    await Effect.runPromise(ensureDetachedWorktree(integration));
    await git(integration.worktreePath, "merge", "--no-ff", "-m", "integrate", sourceTip);
    const integrationTip = await git(integration.worktreePath, "rev-parse", "HEAD");
    integration = {
      ...integration,
      attempt: await Effect.runPromise(classifyOutput(integration, at)),
    };
    assert.equal(
      integration.attempt.output?.kind === "retained" ? integration.attempt.output.tip : "",
      integrationTip,
    );

    await git(fixture.root, "reset", "--hard", fixture.base);
    await writeFile(join(fixture.root, "file.txt"), "conflict destination\n");
    await git(fixture.root, "commit", "-am", "conflict destination");
    const before = await git(fixture.root, "rev-parse", "HEAD");
    await assert.rejects(Effect.runPromise(prepareApplication(source)), GitError);
    assert.equal(await git(fixture.root, "rev-parse", "HEAD"), before);
    assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "conflict destination\n");

    let dirty = operation(fixture, "discard", initial(before));
    await Effect.runPromise(ensureDetachedWorktree(dirty));
    await writeFile(join(dirty.worktreePath, "ignored.bin"), "owned ignored bytes\n");
    dirty = { ...dirty, attempt: await Effect.runPromise(classifyOutput(dirty, at)) };
    const checkpoint = prepareDiscard(dirty, "No longer needed after inspection");
    const discarded = await Effect.runPromise(discardOutput({ ...dirty, attempt: checkpoint }, at));
    assert.equal(discarded.output?.kind, "discarded");
    await assert.rejects(readFile(join(dirty.worktreePath, "ignored.bin")));
    await assert.rejects(git(fixture.root, "rev-parse", dirty.outputRef));

    let foreign = operation(fixture, "foreign", initial(before));
    await Effect.runPromise(ensureDetachedWorktree(foreign));
    await writeFile(join(foreign.worktreePath, "untracked.txt"), "preserve me\n");
    foreign = { ...foreign, attempt: await Effect.runPromise(classifyOutput(foreign, at)) };
    await git(foreign.worktreePath, "add", "untracked.txt");
    await git(foreign.worktreePath, "commit", "-m", "foreign advancement");
    const refused = prepareDiscard(foreign, "Explicit but stale disposition");
    await assert.rejects(
      Effect.runPromise(discardOutput({ ...foreign, attempt: refused }, at)),
      GitError,
    );
    assert.equal(
      await readFile(join(foreign.worktreePath, "untracked.txt"), "utf8"),
      "preserve me\n",
    );
    assert.equal(await git(fixture.root, "rev-parse", foreign.outputRef), before);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});
