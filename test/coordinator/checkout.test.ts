import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { finishCheckout } from "../../src/coordinator/checkouts.js";
import { RecordStore } from "../../src/coordinator/store.js";
import type { AttemptSpec, Task } from "../../src/domain/records.js";
import { configureFixtureEnvironment, restoreFixtureEnvironment } from "../support/decoders.js";
import { extensionFixture, git, persistentSession } from "../support/helpers.js";

type Facts = {
  readonly checkoutId: string;
  readonly managedPath: string;
  readonly repositoryCommonDir: string;
  readonly ownedBranch: string;
  readonly head: string;
  readonly created: boolean;
  readonly reused: boolean;
};

const execFilePromise = promisify(execFile);

const model = { model: "fixture/model", thinking: "high" } as const;

const directorySpec: AttemptSpec = {
  selection: { kind: "target", target: model },
  base: { kind: "directory" },
};

const repositorySpec = (head: string): AttemptSpec => ({
  selection: { kind: "implementation", guide: model, executor: model },
  base: { kind: "repository", baseCommit: head },
});

async function installGitShim(parent: string): Promise<() => void> {
  // oxlint-disable-next-line effecttsgo/process-env -- This owned host boundary reads or restores process environment state.
  const originalPath = process.env["PATH"];
  const realGit = (await execFilePromise("sh", ["-c", "command -v git"])).stdout.trim();
  const bin = join(parent, "bin");
  const shim = join(bin, "git");
  await mkdir(bin);
  await writeFile(
    shim,
    `#!/bin/sh
mode="$WORKGRAPH_GIT_SHIM_MODE"
case "$mode:$*" in
  create-fail:*" worktree add "*)
    echo "simulated bounded creation failure detail" >&2
    exit 23
    ;;
  remove-all-fail:*" worktree remove "*)
    ${realGit} "$@"
    ${realGit} -C "$2" update-ref -d "$WORKGRAPH_GIT_SHIM_BRANCH"
    echo "simulated remove response loss after complete cleanup" >&2
    exit 23
    ;;
  remove-fail:*" worktree remove "*)
    ${realGit} "$@"
    echo "simulated remove response loss" >&2
    exit 23
    ;;
  delete-fail:*" update-ref -d "*)
    ${realGit} "$@"
    echo "simulated delete response loss" >&2
    exit 23
    ;;
esac
exec ${realGit} "$@"
`,
  );
  await chmod(shim, 0o755);
  // oxlint-disable-next-line effecttsgo/process-env -- This owned host boundary reads or restores process environment state.
  process.env["PATH"] = `${bin}:${originalPath ?? ""}`;

  return () => {
    // oxlint-disable-next-line effecttsgo/process-env -- This owned host boundary reads or restores process environment state.
    if (originalPath === undefined) delete process.env["PATH"];
    // oxlint-disable-next-line effecttsgo/process-env -- This owned host boundary reads or restores process environment state.
    else process.env["PATH"] = originalPath;
    // oxlint-disable-next-line effecttsgo/process-env -- This owned host boundary reads or restores process environment state.
    delete process.env["WORKGRAPH_GIT_SHIM_MODE"];
    // oxlint-disable-next-line effecttsgo/process-env -- This owned host boundary reads or restores process environment state.
    delete process.env["WORKGRAPH_GIT_SHIM_BRANCH"];
  };
}

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-checkout-"));
  const root = join(parent, "repo");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Workgraph Test");
  await git(root, "config", "user.email", "workgraph@example.invalid");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, "tracked.txt"), "base\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "base");

  const previous = configureFixtureEnvironment({
    PI_CODING_AGENT_DIR: join(parent, "agent"),
    PI_WORKGRAPH_ROLE: null,
    HERDR_ENV: null,
    HERDR_WORKSPACE_ID: null,
    HERDR_TAB_ID: null,
    PI_WORKGRAPH_HERDR_BIN: "/bin/false",
  });

  const pi = await extensionFixture("coordinator", root, parent);
  await pi.runner.emit({ type: "session_start", reason: "startup" });

  return {
    ...pi,
    parent,
    root,
    agentDir: join(parent, "agent"),
    // oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- This private I/O boundary validates the untyped host value before use. The assertion projects a schema-checked or native SQLite value into its owned test or boundary type.
    facts: (details: unknown) => details as Facts,
    finish: (facts: Facts, cwd = root) =>
      pi.call("workgraph_checkout", {
        cwd,
        finish: { checkoutId: facts.checkoutId, expectedHead: facts.head },
      }),
    async dispose() {
      await pi.close();
      restoreFixtureEnvironment(previous);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

void test("allocation is deterministic, native-only, session-isolated, and reusable", async () => {
  const f = await fixture();
  const otherSession = persistentSession(f.root, join(f.parent, "sessions"));
  const other = await extensionFixture("coordinator", f.root, f.parent, {}, [], otherSession);

  try {
    const first = f.facts((await f.call("workgraph_checkout", {})).details);
    const reused = f.facts((await f.call("workgraph_checkout", {})).details);
    assert.equal(reused.reused, true);
    assert.equal(reused.checkoutId, first.checkoutId);
    assert.equal(existsSync(first.managedPath), true);
    assert.equal(existsSync(join(f.agentDir, "workgraph", "workgraph.sqlite")), false);

    await other.runner.emit({ type: "session_start", reason: "startup" });
    const isolated = f.facts((await other.call("workgraph_checkout", {})).details);
    assert.notEqual(isolated.checkoutId, first.checkoutId);
  } finally {
    await other.close();
    await f.dispose();
  }
});

void test("normal, interrupted, and complete finish are exact and permit fresh allocation", async () => {
  const f = await fixture();

  try {
    const first = f.facts((await f.call("workgraph_checkout", {})).details);
    await f.finish(first);
    assert.equal(existsSync(first.managedPath), false);
    await assert.rejects(git(f.root, "rev-parse", "--verify", first.ownedBranch));
    await f.finish(first);

    await writeFile(join(f.root, "source.txt"), "next\n");
    await git(f.root, "add", "source.txt");
    await git(f.root, "commit", "-m", "advance source");
    const fresh = f.facts((await f.call("workgraph_checkout", {})).details);
    assert.equal(fresh.created, true);
    assert.notEqual(fresh.head, first.head);

    await git(f.root, "worktree", "remove", fresh.managedPath);
    assert.equal(await git(f.root, "rev-parse", fresh.ownedBranch), fresh.head);
    await f.finish(fresh);
    await assert.rejects(git(f.root, "rev-parse", "--verify", fresh.ownedBranch));
  } finally {
    await f.dispose();
  }
});

void test("finish treats destructive command responses by exact observed postconditions", async () => {
  const f = await fixture();
  const restoreGit = await installGitShim(f.parent);

  try {
    const absentAfterRemoval = f.facts((await f.call("workgraph_checkout", {})).details);
    // oxlint-disable-next-line effecttsgo/process-env -- This owned host boundary reads or restores process environment state.
    process.env["WORKGRAPH_GIT_SHIM_MODE"] = "remove-all-fail";
    // oxlint-disable-next-line effecttsgo/process-env -- This owned host boundary reads or restores process environment state.
    process.env["WORKGRAPH_GIT_SHIM_BRANCH"] = absentAfterRemoval.ownedBranch;
    await f.finish(absentAfterRemoval);
    assert.equal(existsSync(absentAfterRemoval.managedPath), false);
    await assert.rejects(git(f.root, "rev-parse", "--verify", absentAfterRemoval.ownedBranch));

    // oxlint-disable-next-line effecttsgo/process-env -- This owned host boundary reads or restores process environment state.
    delete process.env["WORKGRAPH_GIT_SHIM_BRANCH"];
    // oxlint-disable-next-line effecttsgo/process-env -- This owned host boundary reads or restores process environment state.
    process.env["WORKGRAPH_GIT_SHIM_MODE"] = "remove-fail";
    const branchAfterRemoval = f.facts((await f.call("workgraph_checkout", {})).details);
    await f.finish(branchAfterRemoval);
    await assert.rejects(git(f.root, "rev-parse", "--verify", branchAfterRemoval.ownedBranch));

    // oxlint-disable-next-line effecttsgo/process-env -- This owned host boundary reads or restores process environment state.
    delete process.env["WORKGRAPH_GIT_SHIM_MODE"];
    const branchOnly = f.facts((await f.call("workgraph_checkout", {})).details);
    await git(f.root, "worktree", "remove", branchOnly.managedPath);
    // oxlint-disable-next-line effecttsgo/process-env -- This owned host boundary reads or restores process environment state.
    process.env["WORKGRAPH_GIT_SHIM_MODE"] = "delete-fail";
    await f.finish(branchOnly);
    await assert.rejects(git(f.root, "rev-parse", "--verify", branchOnly.ownedBranch));
  } finally {
    restoreGit();
    await f.dispose();
  }
});

void test("failed native creation reports bounded Git diagnostics", async () => {
  const f = await fixture();
  const restoreGit = await installGitShim(f.parent);

  try {
    // oxlint-disable-next-line effecttsgo/process-env -- This owned host boundary reads or restores process environment state.
    process.env["WORKGRAPH_GIT_SHIM_MODE"] = "create-fail";
    await assert.rejects(
      f.call("workgraph_checkout", {}),
      /failed exact post-validation: simulated bounded creation failure detail/,
    );
  } finally {
    restoreGit();
    await f.dispose();
  }
});

void test("finish accepts only a clean equivalent detached checkout with unchanged owned branch", async () => {
  const f = await fixture();

  try {
    const facts = f.facts((await f.call("workgraph_checkout", {})).details);
    await git(facts.managedPath, "checkout", "--detach", facts.head);
    assert.equal(await git(f.root, "rev-parse", facts.ownedBranch), facts.head);
    await f.finish(facts, facts.managedPath);
    assert.equal(existsSync(facts.managedPath), false);
  } finally {
    await f.dispose();
  }
});

for (const [name, dirty] of [
  ["tracked", async (path: string) => writeFile(join(path, "tracked.txt"), "dirty\n")],
  [
    "staged",
    async (path: string) => {
      await writeFile(join(path, "staged.txt"), "staged\n");
      await git(path, "add", "staged.txt");
    },
  ],
  ["untracked", async (path: string) => writeFile(join(path, "scratch.txt"), "scratch\n")],
  ["ignored", async (path: string) => writeFile(join(path, "ignored.txt"), "ignored\n")],
  [
    "merge",
    async (path: string) =>
      writeFile(
        await git(path, "rev-parse", "--git-path", "MERGE_HEAD"),
        await git(path, "rev-parse", "HEAD"),
      ),
  ],
] as const) {
  void test(`finish preserves ${name} state`, async () => {
    const f = await fixture();

    try {
      const facts = f.facts((await f.call("workgraph_checkout", {})).details);
      await dirty(facts.managedPath);
      await assert.rejects(f.finish(facts), /tracked, staged, untracked, ignored, or merge/);
      assert.equal(existsSync(facts.managedPath), true);
    } finally {
      await f.dispose();
    }
  });
}

void test("finish refuses changed leases, switched, locked, moved, symlinked, and foreign identities", async (t) => {
  await t.test("changed branch tip", async () => {
    const f = await fixture();

    try {
      const facts = f.facts((await f.call("workgraph_checkout", {})).details);
      await writeFile(join(facts.managedPath, "next.txt"), "next\n");
      await git(facts.managedPath, "add", "next.txt");
      await git(facts.managedPath, "commit", "-m", "next");
      await assert.rejects(f.finish(facts), /branch or HEAD changed/);
      assert.equal(
        await git(f.root, "rev-parse", facts.ownedBranch),
        await git(facts.managedPath, "rev-parse", "HEAD"),
      );
    } finally {
      await f.dispose();
    }
  });

  for (const mode of ["switched", "locked", "moved", "symlinked", "foreign"] as const) {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One table-driven test keeps all identity mutations under the same refusal assertions.
    await t.test(mode, async () => {
      const f = await fixture();

      try {
        const facts = f.facts((await f.call("workgraph_checkout", {})).details);

        if (mode === "switched") await git(facts.managedPath, "switch", "-c", "foreign");

        if (mode === "locked") await git(f.root, "worktree", "lock", facts.managedPath);

        if (mode === "moved") await rename(facts.managedPath, `${facts.managedPath}-moved`);

        if (mode === "symlinked") {
          await git(f.root, "worktree", "remove", facts.managedPath);
          await symlink(f.root, facts.managedPath);
        }

        if (mode === "foreign") {
          await git(f.root, "worktree", "remove", facts.managedPath);
          await mkdir(facts.managedPath);
        }

        await assert.rejects(f.finish(facts));
        assert.equal(await git(f.root, "rev-parse", facts.ownedBranch), facts.head);

        if (mode === "moved") {
          assert.equal(existsSync(`${facts.managedPath}-moved`), true);
          assert.match(
            await git(f.root, "worktree", "list", "--porcelain"),
            new RegExp(facts.managedPath),
          );
        }
      } finally {
        await f.dispose();
      }
    });
  }
});

void test("complete absence is idempotent even when a targeted dependency exists", async () => {
  const f = await fixture();

  try {
    const facts = f.facts((await f.call("workgraph_checkout", {})).details);
    await git(f.root, "worktree", "remove", facts.managedPath);
    await git(f.root, "update-ref", "-d", facts.ownedBranch, facts.head);
    const store = new RecordStore(f.agentDir, f.session.getSessionId());
    store.createTaskWithAttempt(
      "targeted-absent",
      {
        target: { kind: "directory", path: join(facts.managedPath, "inside") },
        contract: { kind: "research", question: "Targeted after cleanup?" },
      },
      "attempt-targeted-absent",
      directorySpec,
    );
    store.close();

    await f.finish(facts);
  } finally {
    await f.dispose();
  }
});

void test("branch-only advanced tips fail CAS and remain preserved", async () => {
  const f = await fixture();

  try {
    const facts = f.facts((await f.call("workgraph_checkout", {})).details);
    await git(f.root, "worktree", "remove", facts.managedPath);
    await writeFile(join(f.root, "advanced.txt"), "advanced\n");
    await git(f.root, "add", "advanced.txt");
    await git(f.root, "commit", "-m", "advanced branch source");
    const advanced = await git(f.root, "rev-parse", "HEAD");
    await git(f.root, "update-ref", facts.ownedBranch, advanced, facts.head);

    await assert.rejects(f.finish(facts), /branch or HEAD changed/);
    assert.equal(await git(f.root, "rev-parse", facts.ownedBranch), advanced);
  } finally {
    await f.dispose();
  }
});

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The boundary matrix keeps each persisted state adjacent to its observable finish result.
void test("finish dependency rules preserve exact Worker and Candidate boundaries", async () => {
  const cases = [
    { name: "pre-start directory descendant", blocked: true },
    { name: "active repository target", blocked: true },
    { name: "closed terminal Worker", blocked: false },
    { name: "similarly prefixed directory", blocked: false },
    { name: "differently cased directory", blocked: false },
    { name: "similarly prefixed repository", blocked: false },
    { name: "unrelated session", blocked: false },
    { name: "Candidate without classified output", blocked: true },
    { name: "retained Candidate", blocked: true },
    { name: "applying Candidate", blocked: true },
    { name: "discarding Candidate", blocked: true },
    { name: "applied Candidate awaiting cleanup", blocked: true },
    { name: "no-output terminal Candidate", blocked: false },
    { name: "discarded terminal Candidate", blocked: false },
    { name: "applied clean terminal Candidate", blocked: false },
  ] as const;

  for (const scenario of cases) {
    const f = await fixture();

    try {
      const facts = f.facts((await f.call("workgraph_checkout", {})).details);
      const currentSessionId = f.session.getSessionId();
      await f.runner.emit({ type: "session_shutdown", reason: "quit" });

      const dependencySessionId =
        scenario.name === "unrelated session" ? "another-session" : currentSessionId;

      const store = new RecordStore(f.agentDir, dependencySessionId);

      const repositoryTarget = {
        kind: "repository" as const,
        checkoutRoot:
          scenario.name === "similarly prefixed repository"
            ? `${facts.managedPath}-other`
            : facts.managedPath,
        commonDir: facts.repositoryCommonDir,
      };

      const directoryPath =
        // oxlint-disable-next-line anti-slop-effect/prefer-effect-match -- This test-only state matrix is clearer as a compact literal branch.
        scenario.name === "similarly prefixed directory"
          ? `${facts.managedPath}-other/inside`
          : scenario.name === "differently cased directory"
            ? `${facts.managedPath.toUpperCase()}/inside`
            : join(facts.managedPath, "inside");

      const candidate = scenario.name.includes("Candidate");

      const task: Task = {
        target:
          candidate ||
          scenario.name === "active repository target" ||
          scenario.name === "similarly prefixed repository"
            ? repositoryTarget
            : { kind: "directory", path: directoryPath },
        contract: candidate
          ? { kind: "implementation", objective: "Candidate", acceptance: ["Classified"] }
          : { kind: "research", question: "Does this block cleanup?" },
      };

      const attemptId = "dependency-attempt";
      store.createTaskWithAttempt(
        "dependency",
        task,
        attemptId,
        task.target.kind === "repository" ? repositorySpec(facts.head) : directorySpec,
      );

      if (scenario.name === "active repository target") {
        store.checkpointWorker(attemptId, {
          sessionFile: "/tmp/session.jsonl",
          workspaceId: "workspace",
        });
      } else if (scenario.name === "closed terminal Worker") {
        store.checkpointWorker(attemptId, {
          sessionFile: "/tmp/session.jsonl",
          workspaceId: "workspace",
          closed: true,
        });
        store.recordOutcome(attemptId, {
          result: { kind: "unreported", reason: "ended" },
          effectiveModels: [],
        });
      } else if (candidate) {
        store.recordOutcome(attemptId, {
          result: { kind: "unreported", reason: "ended" },
          effectiveModels: [],
        });

        if (scenario.name === "retained Candidate")
          store.checkpointOutput(attemptId, {
            kind: "retained",
            tip: facts.head,
            reason: "custody",
          });

        if (scenario.name === "applying Candidate")
          store.checkpointOutput(attemptId, {
            kind: "applying",
            sourceRoot: facts.head,
            sourceTip: facts.head,
            destinationRef: facts.ownedBranch,
            destinationHead: facts.head,
          });

        if (scenario.name === "discarding Candidate")
          store.checkpointOutput(attemptId, {
            kind: "discarding",
            tip: facts.head,
            reason: "cleanup",
          });

        if (scenario.name === "applied Candidate awaiting cleanup")
          store.checkpointOutput(attemptId, {
            kind: "applied",
            revision: facts.head,
            cleanupTip: facts.head,
            cleanupReason: "cleanup",
          });

        if (scenario.name === "no-output terminal Candidate")
          store.checkpointOutput(attemptId, { kind: "no_output" });

        if (scenario.name === "discarded terminal Candidate")
          store.checkpointOutput(attemptId, { kind: "discarded", reason: "done" });

        if (scenario.name === "applied clean terminal Candidate")
          store.checkpointOutput(attemptId, { kind: "applied", revision: facts.head });
      }

      const finishStore =
        dependencySessionId === currentSessionId
          ? store
          : new RecordStore(f.agentDir, currentSessionId);

      const finish = () =>
        finishCheckout({
          agentDir: f.agentDir,
          sessionId: currentSessionId,
          cwd: f.root,
          checkoutId: facts.checkoutId,
          expectedHead: facts.head,
          store: finishStore,
        });

      if (scenario.blocked) {
        await assert.rejects(finish(), /dependencies/, scenario.name);
        assert.equal(await git(f.root, "rev-parse", facts.ownedBranch), facts.head);
        assert.equal(existsSync(facts.managedPath), true);
      } else {
        await finish();
        assert.equal(existsSync(facts.managedPath), false, scenario.name);
      }

      store.close();

      if (finishStore !== store) finishStore.close();
    } finally {
      await f.dispose();
    }
  }
});

void test("finish recomputes identity and rejects another repository or checkout ID", async () => {
  const f = await fixture();

  try {
    const facts = f.facts((await f.call("workgraph_checkout", {})).details);
    await assert.rejects(
      f.call("workgraph_checkout", {
        finish: { checkoutId: "0".repeat(64), expectedHead: facts.head },
      }),
      /does not match/,
    );
    assert.equal(await readFile(join(facts.managedPath, "tracked.txt"), "utf8"), "base\n");
  } finally {
    await f.dispose();
  }
});
