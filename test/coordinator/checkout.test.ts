/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/require-readable-spacing, anti-slop/require-safety-comment-for-type-assertion, effecttsgo/process-env -- Registered TypeBox validation guards tool details before this test projection; the native Git shim is scoped and restored by each test. */
/* biome-ignore-all lint/complexity/useLiteralKeys: ProcessEnv keys require indexed access under noPropertyAccessFromIndexSignature. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
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
  process.env["PATH"] = `${bin}:${originalPath ?? ""}`;

  return () => {
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    delete process.env["WORKGRAPH_GIT_SHIM_MODE"];
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
    process.env["WORKGRAPH_GIT_SHIM_MODE"] = "remove-all-fail";
    process.env["WORKGRAPH_GIT_SHIM_BRANCH"] = absentAfterRemoval.ownedBranch;
    await f.finish(absentAfterRemoval);
    assert.equal(existsSync(absentAfterRemoval.managedPath), false);
    await assert.rejects(git(f.root, "rev-parse", "--verify", absentAfterRemoval.ownedBranch));

    delete process.env["WORKGRAPH_GIT_SHIM_BRANCH"];
    process.env["WORKGRAPH_GIT_SHIM_MODE"] = "remove-fail";
    const branchAfterRemoval = f.facts((await f.call("workgraph_checkout", {})).details);
    await f.finish(branchAfterRemoval);
    await assert.rejects(git(f.root, "rev-parse", "--verify", branchAfterRemoval.ownedBranch));

    delete process.env["WORKGRAPH_GIT_SHIM_MODE"];
    const branchOnly = f.facts((await f.call("workgraph_checkout", {})).details);
    await git(f.root, "worktree", "remove", branchOnly.managedPath);
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

void test("finish dependency blocking is targeted and preserves Candidate custody", async () => {
  const unrelated = await fixture();
  try {
    const facts = unrelated.facts((await unrelated.call("workgraph_checkout", {})).details);
    const store = new RecordStore(unrelated.agentDir, unrelated.session.getSessionId());
    const task: Task = {
      target: { kind: "directory", path: unrelated.root },
      contract: { kind: "research", question: "Unrelated?" },
    };
    store.createTaskWithAttempt("unrelated", task, "attempt-unrelated", directorySpec);
    store.close();
    await unrelated.finish(facts);
  } finally {
    await unrelated.dispose();
  }

  for (const kind of ["active", "candidate"] as const) {
    const f = await fixture();
    try {
      const facts = f.facts((await f.call("workgraph_checkout", {})).details);
      const store = new RecordStore(f.agentDir, f.session.getSessionId());
      if (kind === "active") {
        const task: Task = {
          target: { kind: "directory", path: join(facts.managedPath, "inside") },
          contract: { kind: "research", question: "Targeted?" },
        };
        store.createTaskWithAttempt("targeted", task, "attempt-targeted", directorySpec);
      } else {
        const task: Task = {
          target: {
            kind: "repository",
            checkoutRoot: facts.managedPath,
            commonDir: facts.repositoryCommonDir,
          },
          contract: { kind: "implementation", objective: "Candidate", acceptance: ["Retained"] },
        };
        store.createTaskWithAttempt(
          "candidate",
          task,
          "attempt-candidate",
          repositorySpec(facts.head),
        );
        store.recordOutcome("attempt-candidate", {
          result: { kind: "unreported", reason: "ended" },
          effectiveModels: [],
        });
        store.checkpointOutput("attempt-candidate", {
          kind: "retained",
          tip: facts.head,
          reason: "custody",
        });
      }
      store.close();
      if (kind === "active") await git(f.root, "worktree", "remove", facts.managedPath);
      await assert.rejects(f.finish(facts), /dependencies/);
      assert.equal(await git(f.root, "rev-parse", facts.ownedBranch), facts.head);
      if (kind === "candidate") assert.equal(existsSync(facts.managedPath), true);
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
