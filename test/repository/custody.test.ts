import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import type { AttemptOutput, AttemptSpec } from "../../src/domain/records.js";
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
} from "../../src/repository.js";
import { git } from "../support/helpers.js";

const selection = {
  kind: "implementation" as const,
  guide: { model: "fixture/guide", thinking: "high" as const },
  executor: { model: "fixture/executor", thinking: "high" as const },
};

async function repository() {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-git-"));
  const root = join(parent, "repository");
  const agentDir = join(parent, "agent");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Workgraph Test");
  await git(root, "config", "user.email", "workgraph@example.invalid");
  await writeFile(join(root, ".gitignore"), "ignored.bin\nnode_modules/\n");
  await writeFile(join(root, "file.txt"), "base\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "base");
  const base = await git(root, "rev-parse", "HEAD");
  const resolved = await Effect.runPromise(resolveTaskTarget({ cwd: root, kind: "repository" }));

  if (!("commit" in resolved)) throw new Error("Expected repository resolution.");
  assert.equal(resolved.target.kind, "repository");
  assert.equal(resolved.commit, base);

  return { parent, root, agentDir, base, target: resolved.target };
}

function operation(
  fixture: Awaited<ReturnType<typeof repository>>,
  attemptId: string,
  spec: AttemptSpec,
  output?: AttemptOutput,
): RepositoryOperation {
  const placement = detachedPlacement({ agentDir: fixture.agentDir, attemptId });
  assert.equal(placement.worktreePath, join(fixture.agentDir, "workgraph", "worktrees", attemptId));
  assert.equal(placement.outputRef, `refs/pi-workgraph/outputs/${attemptId}`);
  const base = { attemptId, spec, target: fixture.target, ...placement };

  return output === undefined ? base : { ...base, output };
}

function initial(baseCommit: string): AttemptSpec {
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
    const directory = await Effect.runPromise(resolveTaskTarget({ cwd: plain, kind: "directory" }));
    assert.deepEqual(directory, { target: { kind: "directory", path: plain } });
    await assert.rejects(
      Effect.runPromise(resolveTaskTarget({ cwd: plain, kind: "repository" })),
      GitError,
    );
    const file = join(plain, "file");
    await writeFile(file, "x");
    await assert.rejects(
      Effect.runPromise(resolveTaskTarget({ cwd: plain, path: file, kind: "directory" })),
      GitError,
    );

    const unborn = join(plain, "unborn");
    await mkdir(unborn);
    await git(unborn, "init");
    await assert.rejects(
      Effect.runPromise(resolveTaskTarget({ cwd: unborn, kind: "repository" })),
      GitError,
    );

    const realAgent = join(plain, "real-agent");
    const linkedAgent = join(plain, "linked-agent");
    await mkdir(realAgent);
    await symlink(realAgent, linkedAgent);
    assert.equal(
      detachedPlacement({ agentDir: linkedAgent, attemptId: "linked" }).worktreePath,
      join(realAgent, "workgraph", "worktrees", "linked"),
    );
    const nestedAgent = join(plain, "nested-agent");
    const realWorkgraph = join(plain, "real-workgraph");
    await mkdir(nestedAgent);
    await mkdir(realWorkgraph);
    await symlink(realWorkgraph, join(nestedAgent, "workgraph"));
    assert.equal(
      detachedPlacement({ agentDir: nestedAgent, attemptId: "nested" }).worktreePath,
      join(realWorkgraph, "worktrees", "nested"),
    );

    const fixture = await repository();

    try {
      const nested = join(fixture.root, "nested");
      await mkdir(nested);
      const link = join(fixture.parent, "linked");
      await symlink(nested, link);

      const target = await Effect.runPromise(
        resolveTaskTarget({ cwd: plain, path: link, kind: "repository", revision: fixture.base }),
      );

      assert.deepEqual(target, { target: fixture.target, commit: fixture.base });
      await assert.rejects(
        Effect.runPromise(
          resolveTaskTarget({ cwd: link, kind: "repository", revision: "f".repeat(40) }),
        ),
        GitError,
      );

      const symlinkedPlacement = detachedPlacement({
        agentDir: linkedAgent,
        attemptId: "symlinked",
      });

      const symlinkedOperation: RepositoryOperation = {
        attemptId: "symlinked",
        spec: initial(fixture.base),
        target: fixture.target,
        ...symlinkedPlacement,
      };

      await Effect.runPromise(ensureDetachedWorktree(symlinkedOperation));
      assert.deepEqual(await Effect.runPromise(classifyOutput(symlinkedOperation)), {
        kind: "no_output",
      });
    } finally {
      await rm(fixture.parent, { recursive: true, force: true });
    }
  } finally {
    await rm(plain, { recursive: true, force: true });
  }
});

void test("classification compacts completed commits, releases completed scratch, and preserves uncertain bytes", async () => {
  const fixture = await repository();

  try {
    const unchanged = operation(fixture, "unchanged", initial(fixture.base));
    await Effect.runPromise(ensureDetachedWorktree(unchanged));
    const noOutput = await Effect.runPromise(classifyOutput(unchanged));
    assert.equal(noOutput.kind, "no_output");
    await assert.rejects(readFile(join(unchanged.worktreePath, "file.txt")));
    assert.equal(
      await git(fixture.root, "show-ref", "--verify", "--quiet", unchanged.outputRef).catch(
        () => "absent",
      ),
      "absent",
    );
    const unchangedRecovery = operation(fixture, "unchanged-recovery", initial(fixture.base));
    await Effect.runPromise(ensureDetachedWorktree(unchangedRecovery));
    await git(fixture.root, "worktree", "remove", unchangedRecovery.worktreePath);
    const recoveredNoOutput = await Effect.runPromise(classifyOutput(unchangedRecovery));
    assert.equal(recoveredNoOutput.kind, "no_output");

    const clean = operation(fixture, "clean", initial(fixture.base));
    await Effect.runPromise(ensureDetachedWorktree(clean));
    const cleanTip = await commit(clean.worktreePath, "candidate");
    const retained = await Effect.runPromise(classifyOutput(clean));
    assert.equal(retained.kind, "retained");
    assert.equal(retained.kind === "retained" ? retained.tip : "", cleanTip);
    assert.equal(await git(fixture.root, "rev-parse", clean.outputRef), cleanTip);
    await assert.rejects(readFile(join(clean.worktreePath, "file.txt")));
    const cleanRecovery = operation(fixture, "clean-recovery", initial(fixture.base));
    await Effect.runPromise(ensureDetachedWorktree(cleanRecovery));
    const recoveryTip = await commit(cleanRecovery.worktreePath, "recovered candidate");
    await git(fixture.root, "update-ref", cleanRecovery.outputRef, recoveryTip);
    await git(fixture.root, "worktree", "remove", cleanRecovery.worktreePath);
    const recoveredRetained = await Effect.runPromise(classifyOutput(cleanRecovery));
    assert.equal(recoveredRetained.kind === "retained" ? recoveredRetained.tip : "", recoveryTip);

    const dirty = operation(fixture, "dirty", initial(fixture.base));
    await Effect.runPromise(ensureDetachedWorktree(dirty));
    await writeFile(join(dirty.worktreePath, "untracked.txt"), "untracked\n");
    await writeFile(join(dirty.worktreePath, "ignored.bin"), "ignored\n");
    const dirtyAttempt = await Effect.runPromise(classifyOutput(dirty));
    assert.equal(dirtyAttempt.kind, "retained");
    assert.equal(await git(fixture.root, "rev-parse", dirty.outputRef), fixture.base);
    assert.equal(await readFile(join(dirty.worktreePath, "ignored.bin"), "utf8"), "ignored\n");

    const completedUnchanged = operation(fixture, "completed-unchanged", initial(fixture.base));
    await Effect.runPromise(ensureDetachedWorktree(completedUnchanged));
    await mkdir(join(completedUnchanged.worktreePath, "node_modules"));
    await writeFile(
      join(completedUnchanged.worktreePath, "node_modules", "artifact.js"),
      "scratch\n",
    );
    assert.deepEqual(await Effect.runPromise(classifyOutput(completedUnchanged, true)), {
      kind: "no_output",
    });
    await assert.rejects(
      readFile(join(completedUnchanged.worktreePath, "node_modules", "artifact.js")),
    );

    const completedChanged = operation(fixture, "completed-changed", initial(fixture.base));
    await Effect.runPromise(ensureDetachedWorktree(completedChanged));
    const completedTip = await commit(completedChanged.worktreePath, "committed output");
    await writeFile(join(completedChanged.worktreePath, "file.txt"), "uncommitted scratch\n");
    await writeFile(join(completedChanged.worktreePath, "ignored.bin"), "ignored scratch\n");
    const completedOutput = await Effect.runPromise(classifyOutput(completedChanged, true));
    assert.equal(completedOutput.kind === "retained" ? completedOutput.tip : "", completedTip);
    assert.equal(await git(fixture.root, "rev-parse", completedChanged.outputRef), completedTip);
    assert.equal(await git(fixture.root, "show", `${completedTip}:file.txt`), "committed output");
    await assert.rejects(readFile(join(completedChanged.worktreePath, "file.txt")));
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

void test("application accepts ignored destination artifacts and recovers structurally before cleanup", async () => {
  const fixture = await repository();

  try {
    let fast = operation(fixture, "fast", initial(fixture.base));
    await Effect.runPromise(ensureDetachedWorktree(fast));
    const fastTip = await commit(fast.worktreePath, "fast");
    fast = { ...fast, output: await Effect.runPromise(classifyOutput(fast)) };
    await mkdir(join(fixture.root, "node_modules"));
    await writeFile(join(fixture.root, "node_modules", "artifact.js"), "ignored artifact\n");
    const fastPrepared = await Effect.runPromise(prepareApplication(fast));
    fast = { ...fast, output: fastPrepared };
    const fastApplied = await Effect.runPromise(applyOutput(fast));
    assert.equal(fastApplied.kind, "applied");
    assert.equal(await git(fixture.root, "rev-parse", "HEAD"), fastTip);
    assert.equal(await git(fixture.root, "rev-parse", fast.outputRef), fastTip);
    assert.equal(
      await readFile(join(fixture.root, "node_modules", "artifact.js"), "utf8"),
      "ignored artifact\n",
    );

    const fastCleaned = await Effect.runPromise(
      cleanupAppliedOutput({ ...fast, output: fastApplied }),
    );

    assert.equal(fastCleaned.kind === "applied" ? fastCleaned.cleanupTip : "bad", undefined);
    await assert.rejects(git(fixture.root, "rev-parse", fast.outputRef));

    let ignoredCollision = operation(fixture, "ignored-collision", initial(fastTip));
    await Effect.runPromise(ensureDetachedWorktree(ignoredCollision));
    await writeFile(join(ignoredCollision.worktreePath, "ignored.bin"), "candidate artifact\n");
    await git(ignoredCollision.worktreePath, "add", "-f", "ignored.bin");
    await git(ignoredCollision.worktreePath, "commit", "-m", "track ignored artifact");
    const ignoredCollisionTip = await git(ignoredCollision.worktreePath, "rev-parse", "HEAD");
    ignoredCollision = {
      ...ignoredCollision,
      output: await Effect.runPromise(classifyOutput(ignoredCollision)),
    };
    await writeFile(join(fixture.root, "ignored.bin"), "destination artifact\n");
    const collisionHead = await git(fixture.root, "rev-parse", "HEAD");
    const collisionPrepared = await Effect.runPromise(prepareApplication(ignoredCollision));
    ignoredCollision = { ...ignoredCollision, output: collisionPrepared };
    await assert.rejects(Effect.runPromise(applyOutput(ignoredCollision)), GitError);
    assert.equal(await git(fixture.root, "rev-parse", "HEAD"), collisionHead);
    assert.equal(
      await readFile(join(fixture.root, "ignored.bin"), "utf8"),
      "destination artifact\n",
    );
    assert.equal(
      await git(fixture.root, "rev-parse", ignoredCollision.outputRef),
      ignoredCollisionTip,
    );
    await rm(join(fixture.root, "ignored.bin"));

    let untrackedCollision = operation(fixture, "untracked-collision", initial(fastTip));
    await Effect.runPromise(ensureDetachedWorktree(untrackedCollision));
    await writeFile(join(untrackedCollision.worktreePath, "untracked.txt"), "candidate bytes\n");
    await git(untrackedCollision.worktreePath, "add", "untracked.txt");
    await git(untrackedCollision.worktreePath, "commit", "-m", "track untracked collision");
    untrackedCollision = {
      ...untrackedCollision,
      output: await Effect.runPromise(classifyOutput(untrackedCollision)),
    };
    await writeFile(join(fixture.root, "untracked.txt"), "destination bytes\n");
    const untrackedHead = await git(fixture.root, "rev-parse", "HEAD");
    const untrackedIndex = await git(fixture.root, "diff", "--cached", "--binary");
    untrackedCollision = {
      ...untrackedCollision,
      output: await Effect.runPromise(prepareApplication(untrackedCollision)),
    };
    await assert.rejects(Effect.runPromise(applyOutput(untrackedCollision)), GitError);
    assert.equal(await git(fixture.root, "rev-parse", "HEAD"), untrackedHead);
    assert.equal(await git(fixture.root, "diff", "--cached", "--binary"), untrackedIndex);
    assert.equal(
      await readFile(join(fixture.root, "untracked.txt"), "utf8"),
      "destination bytes\n",
    );
    await rm(join(fixture.root, "untracked.txt"));

    await writeFile(join(fixture.root, "file.txt"), "staged destination bytes\n");
    await git(fixture.root, "add", "file.txt");
    const stagedIndex = await git(fixture.root, "diff", "--cached", "--binary");
    await assert.rejects(Effect.runPromise(prepareApplication(untrackedCollision)), GitError);
    assert.equal(await git(fixture.root, "rev-parse", "HEAD"), untrackedHead);
    assert.equal(await git(fixture.root, "diff", "--cached", "--binary"), stagedIndex);
    assert.equal(
      await readFile(join(fixture.root, "file.txt"), "utf8"),
      "staged destination bytes\n",
    );
    await git(fixture.root, "reset", "--hard", fastTip);

    let changedDestination = operation(fixture, "changed-destination", initial(fastTip));
    await Effect.runPromise(ensureDetachedWorktree(changedDestination));
    await commit(changedDestination.worktreePath, "prepared source");
    changedDestination = {
      ...changedDestination,
      output: await Effect.runPromise(classifyOutput(changedDestination)),
    };
    changedDestination = {
      ...changedDestination,
      output: await Effect.runPromise(prepareApplication(changedDestination)),
    };
    await writeFile(join(fixture.root, "changed-destination.txt"), "advanced\n");
    await git(fixture.root, "add", "changed-destination.txt");
    await git(fixture.root, "commit", "-m", "advance after preparation");
    const advancedDestination = await git(fixture.root, "rev-parse", "HEAD");
    await assert.rejects(Effect.runPromise(prepareApplication(changedDestination)), GitError);
    await assert.rejects(Effect.runPromise(applyOutput(changedDestination)), GitError);
    assert.equal(await git(fixture.root, "rev-parse", "HEAD"), advancedDestination);

    const divergentBase = fastTip;
    let divergent = operation(fixture, "divergent", initial(divergentBase));
    await Effect.runPromise(ensureDetachedWorktree(divergent));
    const sourceTip = await commit(divergent.worktreePath, "source");
    divergent = { ...divergent, output: await Effect.runPromise(classifyOutput(divergent)) };
    await writeFile(join(fixture.root, "destination.txt"), "destination\n");
    await git(fixture.root, "add", "destination.txt");
    await git(fixture.root, "commit", "-m", "destination");
    const destinationTip = await git(fixture.root, "rev-parse", "HEAD");
    const applying = await Effect.runPromise(prepareApplication(divergent));
    divergent = { ...divergent, output: applying };
    const applied = await Effect.runPromise(applyOutput(divergent));
    assert.equal(applied.kind, "applied");
    const merge = applied.kind === "applied" ? applied.revision : "";
    assert.deepEqual((await git(fixture.root, "show", "-s", "--format=%P", merge)).split(" "), [
      destinationTip,
      sourceTip,
    ]);
    assert.equal(await git(fixture.root, "show", `${merge}:file.txt`), "source");
    const recovered = await Effect.runPromise(applyOutput(divergent));
    assert.equal(recovered.kind === "applied" ? recovered.revision : "", merge);
    assert.equal(await git(fixture.root, "status", "--porcelain"), "");

    await git(fixture.root, "reset", "--hard", divergentBase);
    await writeFile(join(fixture.root, "file.txt"), "source\n");
    await git(fixture.root, "commit", "-am", "equivalent destination");
    await git(fixture.root, "merge", "--no-commit", sourceTip);
    assert.equal(await git(fixture.root, "status", "--porcelain"), "");
    assert.equal(await git(fixture.root, "rev-parse", "--verify", "MERGE_HEAD"), sourceTip);
    await assert.rejects(Effect.runPromise(prepareApplication(divergent)), GitError);
    assert.equal(await git(fixture.root, "rev-parse", "--verify", "MERGE_HEAD"), sourceTip);
    await git(fixture.root, "merge", "--abort");
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
    source = { ...source, output: await Effect.runPromise(classifyOutput(source)) };

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
      output: await Effect.runPromise(classifyOutput(integration)),
    };
    assert.equal(
      integration.output?.kind === "retained" ? integration.output.tip : "",
      integrationTip,
    );

    await git(fixture.root, "reset", "--hard", fixture.base);
    await writeFile(join(fixture.root, "file.txt"), "conflict destination\n");
    await git(fixture.root, "commit", "-am", "conflict destination");
    const before = await git(fixture.root, "rev-parse", "HEAD");
    await assert.rejects(Effect.runPromise(prepareApplication(source)), GitError);
    assert.equal(await git(fixture.root, "rev-parse", "HEAD"), before);
    assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "conflict destination\n");
    await assert.rejects(
      Effect.runPromise(
        prepareDiscard(operation(fixture, "not-releasable", initial(before)), "Not retained"),
      ),
      GitError,
    );

    let dirty = operation(fixture, "discard", initial(before));
    await Effect.runPromise(ensureDetachedWorktree(dirty));
    await writeFile(join(dirty.worktreePath, "ignored.bin"), "owned ignored bytes\n");
    dirty = { ...dirty, output: await Effect.runPromise(classifyOutput(dirty)) };

    const checkpoint = await Effect.runPromise(
      prepareDiscard(dirty, "No longer needed after inspection"),
    );

    const discarded = await Effect.runPromise(discardOutput({ ...dirty, output: checkpoint }));
    assert.equal(discarded.kind, "discarded");
    await assert.rejects(readFile(join(dirty.worktreePath, "ignored.bin")));
    await assert.rejects(git(fixture.root, "rev-parse", dirty.outputRef));

    let foreign = operation(fixture, "foreign", initial(before));
    await Effect.runPromise(ensureDetachedWorktree(foreign));
    await writeFile(join(foreign.worktreePath, "untracked.txt"), "preserve me\n");
    foreign = { ...foreign, output: await Effect.runPromise(classifyOutput(foreign)) };
    await git(foreign.worktreePath, "add", "untracked.txt");
    await git(foreign.worktreePath, "commit", "-m", "foreign advancement");

    const refused = await Effect.runPromise(
      prepareDiscard(foreign, "Explicit but stale disposition"),
    );

    await assert.rejects(
      Effect.runPromise(discardOutput({ ...foreign, output: refused })),
      GitError,
    );
    assert.equal(
      await readFile(join(foreign.worktreePath, "untracked.txt"), "utf8"),
      "preserve me\n",
    );
    assert.equal(await git(fixture.root, "rev-parse", foreign.outputRef), before);

    let missingRef = operation(fixture, "missing-ref", initial(before));
    await Effect.runPromise(ensureDetachedWorktree(missingRef));
    await writeFile(join(missingRef.worktreePath, "ignored.bin"), "must survive\n");
    missingRef = {
      ...missingRef,
      output: await Effect.runPromise(classifyOutput(missingRef)),
    };
    await git(fixture.root, "update-ref", "-d", missingRef.outputRef);

    const missingCheckpoint = await Effect.runPromise(
      prepareDiscard(missingRef, "Discard only with exact ref ownership"),
    );

    await assert.rejects(
      Effect.runPromise(discardOutput({ ...missingRef, output: missingCheckpoint })),
      GitError,
    );
    assert.equal(
      await readFile(join(missingRef.worktreePath, "ignored.bin"), "utf8"),
      "must survive\n",
    );
    assert.equal(await git(missingRef.worktreePath, "rev-parse", "HEAD"), before);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});
