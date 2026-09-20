/* oxlint-disable anti-slop/require-readable-spacing -- Fixture setup and assertions remain grouped by observable flow. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

async function administrationDir(managedPath: string): Promise<string> {
  const backlink = await readFile(join(managedPath, ".git"), "utf8");
  const match = /^gitdir: (.+)\r?\n?$/.exec(backlink);

  assert.ok(match?.[1] !== undefined);
  return match[1];
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
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Registered TypeBox validation guards tool details before this test projection.
    facts: (details: unknown) => {
      // SAFETY: Every caller projects details returned by a successful workgraph_checkout invocation.
      return details as Facts;
    },
    async dispose() {
      await pi.close();
      restoreFixtureEnvironment(previous);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

void test("checkout startup is read-only and allocation is stable across linked checkouts and reloads", async () => {
  const f = await fixture();
  const linked = join(f.parent, "linked");

  try {
    assert.equal(existsSync(join(f.agentDir, "workgraph", "coordinator-checkouts")), false);
    await git(f.root, "worktree", "add", "-b", "linked", linked);
    const first = f.facts((await f.call("workgraph_checkout", {})).details);
    const linkedReuse = f.facts((await f.call("workgraph_checkout", { cwd: linked })).details);

    assert.equal(first.created, true);
    assert.equal(linkedReuse.reused, true);
    assert.equal(linkedReuse.checkoutId, first.checkoutId);
    assert.equal(linkedReuse.managedPath, first.managedPath);

    await f.runner.emit({ type: "session_shutdown", reason: "reload" });
    assert.equal(existsSync(first.managedPath), true);
    await f.runner.emit({ type: "session_start", reason: "reload" });
    const afterReload = f.facts((await f.call("workgraph_checkout", {})).details);
    assert.equal(afterReload.reused, true);
    assert.equal(afterReload.checkoutId, first.checkoutId);
  } finally {
    await f.dispose();
  }
});

void test("different sessions receive isolated deterministic checkouts", async () => {
  const f = await fixture();
  const otherSession = persistentSession(f.root, join(f.parent, "other-sessions"));
  const other = await extensionFixture("coordinator", f.root, f.parent, {}, [], otherSession);

  try {
    await other.runner.emit({ type: "session_start", reason: "startup" });
    const first = f.facts((await f.call("workgraph_checkout", {})).details);
    const second = f.facts((await other.call("workgraph_checkout", {})).details);

    assert.notEqual(second.checkoutId, first.checkoutId);
    assert.notEqual(second.managedPath, first.managedPath);
    assert.notEqual(second.ownedBranch, first.ownedBranch);
  } finally {
    await other.close();
    await f.dispose();
  }
});

void test("dirty detached source snapshots only committed HEAD", async () => {
  const f = await fixture();

  try {
    const committed = await git(f.root, "rev-parse", "HEAD");
    await git(f.root, "checkout", "--detach", committed);
    await writeFile(join(f.root, "tracked.txt"), "dirty tracked\n");
    await writeFile(join(f.root, "untracked.txt"), "untracked\n");
    await writeFile(join(f.root, "ignored.txt"), "ignored\n");
    const created = f.facts((await f.call("workgraph_checkout", {})).details);

    assert.equal(created.head, committed);
    assert.equal(await readFile(join(created.managedPath, "tracked.txt"), "utf8"), "base\n");
    assert.equal(existsSync(join(created.managedPath, "untracked.txt")), false);
    assert.equal(existsSync(join(created.managedPath, "ignored.txt")), false);
    assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), "dirty tracked\n");
    assert.equal(await readFile(join(f.root, "untracked.txt"), "utf8"), "untracked\n");
    assert.equal(await readFile(join(f.root, "ignored.txt"), "utf8"), "ignored\n");
  } finally {
    await f.dispose();
  }
});

void test("exact modified and advanced managed checkout reuses without mutation", async () => {
  const f = await fixture();

  try {
    const first = f.facts((await f.call("workgraph_checkout", {})).details);
    await writeFile(join(first.managedPath, "advanced.txt"), "committed\n");
    await git(first.managedPath, "add", "advanced.txt");
    await git(first.managedPath, "commit", "-m", "advance managed checkout");
    const advanced = await git(first.managedPath, "rev-parse", "HEAD");
    await writeFile(join(first.managedPath, "tracked.txt"), "managed dirty\n");
    await writeFile(join(first.managedPath, "untracked.txt"), "managed untracked\n");
    await writeFile(join(first.managedPath, "ignored.txt"), "managed ignored\n");

    const reused = f.facts((await f.call("workgraph_checkout", {})).details);
    assert.equal(reused.reused, true);
    assert.equal(reused.head, advanced);
    assert.equal(await git(first.managedPath, "rev-parse", "HEAD"), advanced);
    assert.equal(await readFile(join(first.managedPath, "tracked.txt"), "utf8"), "managed dirty\n");
    assert.equal(
      await readFile(join(first.managedPath, "untracked.txt"), "utf8"),
      "managed untracked\n",
    );
    assert.equal(
      await readFile(join(first.managedPath, "ignored.txt"), "utf8"),
      "managed ignored\n",
    );
  } finally {
    await f.dispose();
  }
});

void test("locked, duplicate-branch, and reverse-backlink identities block without repair", async () => {
  const locked = await fixture();

  try {
    const facts = locked.facts((await locked.call("workgraph_checkout", {})).details);
    await git(locked.root, "worktree", "lock", "--reason", "initializing", facts.managedPath);
    await assert.rejects(locked.call("workgraph_checkout", {}), /registration is locked/);
    assert.equal(existsSync(facts.managedPath), true);
    assert.match(
      await readFile(join(await administrationDir(facts.managedPath), "locked"), "utf8"),
      /initializing/,
    );
  } finally {
    await locked.dispose();
  }

  const duplicate = await fixture();

  try {
    const facts = duplicate.facts((await duplicate.call("workgraph_checkout", {})).details);
    const otherPath = join(duplicate.parent, "other-worktree");
    await git(duplicate.root, "worktree", "add", "--detach", otherPath, facts.head);
    await writeFile(
      join(await administrationDir(otherPath), "HEAD"),
      `ref: ${facts.ownedBranch}\n`,
    );
    await assert.rejects(duplicate.call("workgraph_checkout", {}), /partial or duplicated/);
    assert.equal(existsSync(facts.managedPath), true);
    assert.equal(existsSync(otherPath), true);
  } finally {
    await duplicate.dispose();
  }

  const reverse = await fixture();

  try {
    const facts = reverse.facts((await reverse.call("workgraph_checkout", {})).details);
    const adminDir = await administrationDir(facts.managedPath);
    await writeFile(join(adminDir, "gitdir"), `${join(reverse.root, ".git")}\n`);
    await assert.rejects(reverse.call("workgraph_checkout", {}), /partial or duplicated/);
    assert.equal(existsSync(facts.managedPath), true);
  } finally {
    await reverse.dispose();
  }
});

void test("failed native creation is recovered only at the exact requested commit", async () => {
  // SAFETY: This only gives names to optional process environment keys used by this bounded fixture.
  const environment = process.env as NodeJS.ProcessEnv & {
    PATH: string | undefined;
    WORKGRAPH_TEST_REAL_GIT: string | undefined;
    WORKGRAPH_TEST_GIT_MODE: string | undefined;
  };
  const originalPath = environment.PATH;
  const originalRealGit = environment.WORKGRAPH_TEST_REAL_GIT;
  const originalMode = environment.WORKGRAPH_TEST_GIT_MODE;
  const realGit = originalPath
    ?.split(":")
    .map((directory) => join(directory, "git"))
    .find((candidate) => existsSync(candidate));
  assert.ok(realGit !== undefined);

  async function installWrapper(parent: string) {
    const bin = join(parent, "bin");
    const wrapper = join(bin, "git");
    await mkdir(bin);
    await writeFile(
      wrapper,
      `#!/bin/sh\nprev=""\nlast=""\nfor arg do prev="$last"; last="$arg"; done\n"$WORKGRAPH_TEST_REAL_GIT" "$@"\nstatus=$?\n[ $status -eq 0 ] || exit $status\ncase " $* " in\n  *" worktree add "*)\n    if [ "$WORKGRAPH_TEST_GIT_MODE" = wrong ]; then\n      printf 'wrong\\n' > "$prev/wrong.txt"\n      "$WORKGRAPH_TEST_REAL_GIT" -C "$prev" add wrong.txt\n      "$WORKGRAPH_TEST_REAL_GIT" -C "$prev" commit -m wrong-post-create >/dev/null\n    fi\n    exit 17\n    ;;
esac\n`,
    );
    await chmod(wrapper, 0o700);
    environment.WORKGRAPH_TEST_REAL_GIT = realGit;
    environment.PATH = `${bin}:${originalPath ?? ""}`;
  }

  const recovered = await fixture();

  try {
    await installWrapper(recovered.parent);
    environment.WORKGRAPH_TEST_GIT_MODE = "failed-exact";
    const facts = recovered.facts((await recovered.call("workgraph_checkout", {})).details);
    assert.equal(facts.created, true);
    assert.equal(facts.head, await git(recovered.root, "rev-parse", "main"));
  } finally {
    environment.PATH = originalPath;
    environment.WORKGRAPH_TEST_REAL_GIT = originalRealGit;
    environment.WORKGRAPH_TEST_GIT_MODE = originalMode;
    await recovered.dispose();
  }

  const mismatched = await fixture();

  try {
    await installWrapper(mismatched.parent);
    environment.WORKGRAPH_TEST_GIT_MODE = "wrong";
    await assert.rejects(
      mismatched.call("workgraph_checkout", {}),
      /does not match the exact requested commit/,
    );
    const checkoutRoot = join(mismatched.agentDir, "workgraph", "coordinator-checkouts");
    const [managed] = await readdir(checkoutRoot);
    assert.ok(managed !== undefined);
    assert.equal(existsSync(join(checkoutRoot, managed, "wrong.txt")), true);
  } finally {
    environment.PATH = originalPath;
    environment.WORKGRAPH_TEST_REAL_GIT = originalRealGit;
    environment.WORKGRAPH_TEST_GIT_MODE = originalMode;
    await mismatched.dispose();
  }
});

void test("partial and switched resources remain present and block", async () => {
  const partial = await fixture();

  try {
    const facts = partial.facts((await partial.call("workgraph_checkout", {})).details);
    await git(partial.root, "worktree", "remove", facts.managedPath);
    await assert.rejects(partial.call("workgraph_checkout", {}), /partial or duplicated/);
    assert.equal(await git(partial.root, "rev-parse", "--verify", facts.ownedBranch), facts.head);
  } finally {
    await partial.dispose();
  }

  const switched = await fixture();

  try {
    const facts = switched.facts((await switched.call("workgraph_checkout", {})).details);
    await git(facts.managedPath, "switch", "-c", "foreign-branch");
    await assert.rejects(switched.call("workgraph_checkout", {}), /partial or duplicated/);
    assert.equal(existsSync(facts.managedPath), true);
    assert.equal(await git(facts.managedPath, "branch", "--show-current"), "foreign-branch");
  } finally {
    await switched.dispose();
  }
});

void test("registered local delivery advances the original destination, cleans ownership, and permits a fresh allocation", async () => {
  const f = await fixture();

  try {
    const first = f.facts((await f.call("workgraph_checkout", {})).details);
    await writeFile(join(first.managedPath, "delivered.txt"), "accepted\n");
    await git(first.managedPath, "add", "delivered.txt");
    await git(first.managedPath, "commit", "-m", "accepted local change");
    const accepted = await git(first.managedPath, "rev-parse", "HEAD");

    const delivered = await f.call("workgraph_deliver", {
      checkoutId: first.checkoutId,
      route: "local",
      revision: accepted,
    });

    // SAFETY: The registered delivery tool returns the persisted checkout record as details.
    assert.deepEqual((delivered.details as { disposition: unknown }).disposition, {
      kind: "complete",
      route: "local",
      revision: accepted,
      destinationRevision: accepted,
    });
    assert.equal(await readFile(join(f.root, "delivered.txt"), "utf8"), "accepted\n");
    assert.equal(existsSync(first.managedPath), false);
    await assert.rejects(git(f.root, "rev-parse", "--verify", first.ownedBranch));

    const fresh = f.facts((await f.call("workgraph_checkout", {})).details);
    assert.equal(fresh.checkoutId, first.checkoutId);
    assert.equal(fresh.created, true);
    assert.equal(fresh.head, accepted);
    assert.equal(await readFile(join(fresh.managedPath, "delivered.txt"), "utf8"), "accepted\n");
  } finally {
    await f.dispose();
  }
});

void test("local delivery preserves disjoint dirty destination bytes and blocks overlap", async () => {
  const f = await fixture();

  try {
    const first = f.facts((await f.call("workgraph_checkout", {})).details);
    await writeFile(join(first.managedPath, "delivered.txt"), "accepted\n");
    await git(first.managedPath, "add", "delivered.txt");
    await git(first.managedPath, "commit", "-m", "accepted local change");
    const accepted = await git(first.managedPath, "rev-parse", "HEAD");
    await writeFile(join(f.root, "tracked.txt"), "dirty but disjoint\n");
    await writeFile(join(f.root, "untracked.txt"), "preserve\n");
    await writeFile(join(f.root, "ignored.txt"), "preserve ignored\n");

    await f.call("workgraph_deliver", {
      checkoutId: first.checkoutId,
      route: "local",
      revision: accepted,
    });
    assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), "dirty but disjoint\n");
    assert.equal(await readFile(join(f.root, "untracked.txt"), "utf8"), "preserve\n");
    assert.equal(await readFile(join(f.root, "ignored.txt"), "utf8"), "preserve ignored\n");

    await git(f.root, "reset", "--hard");
    await rm(join(f.root, "untracked.txt"));
    const second = f.facts((await f.call("workgraph_checkout", {})).details);
    await writeFile(join(second.managedPath, "tracked.txt"), "accepted overlap\n");
    await git(second.managedPath, "commit", "-am", "overlapping change");
    const overlap = await git(second.managedPath, "rev-parse", "HEAD");
    await writeFile(join(f.root, "tracked.txt"), "destination overlap\n");

    await assert.rejects(
      f.call("workgraph_deliver", {
        checkoutId: second.checkoutId,
        route: "local",
        revision: overlap,
      }),
      /overlaps the prepared change/,
    );
    assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), "destination overlap\n");
    assert.equal(existsSync(second.managedPath), true);
  } finally {
    await f.dispose();
  }
});

void test("retained implementation Candidate applies only into the managed checkout", async () => {
  const f = await fixture();

  try {
    const facts = f.facts((await f.call("workgraph_checkout", {})).details);
    const attemptId = "attempt-checkout-candidate";
    const outputRef = `refs/pi-workgraph/outputs/${attemptId}`;
    const workerPath = join(f.parent, "candidate-worktree");
    await git(f.root, "worktree", "add", "--detach", workerPath, facts.head);
    await writeFile(join(workerPath, "candidate.txt"), "worker candidate\n");
    await git(workerPath, "add", "candidate.txt");
    await git(workerPath, "commit", "-m", "worker candidate");
    const candidateTip = await git(workerPath, "rev-parse", "HEAD");
    await git(f.root, "worktree", "remove", workerPath);
    await git(f.root, "update-ref", outputRef, candidateTip);
    const store = new RecordStore(f.agentDir, f.session.getSessionId());
    const task = {
      target: {
        kind: "repository",
        checkoutRoot: facts.managedPath,
        commonDir: facts.repositoryCommonDir,
      },
      contract: {
        kind: "implementation",
        objective: "Apply one retained Candidate.",
        acceptance: ["Candidate reaches only the managed checkout."],
      },
    } satisfies Task;
    const spec = {
      selection: {
        kind: "implementation",
        guide: { model: "fixture/guide", thinking: "high" },
        executor: { model: "fixture/executor", thinking: "high" },
      },
      base: { kind: "repository", baseCommit: facts.head },
    } satisfies AttemptSpec;

    store.createTaskWithAttempt("checkout-candidate", task, attemptId, spec);
    store.recordOutcome(attemptId, {
      result: {
        kind: "reported",
        report: {
          role: "implementation",
          status: "completed",
          outcome: "changed",
          summary: "Produced the Candidate.",
          details: "The Candidate was committed and verified.",
        },
      },
      effectiveModels: [],
    });
    store.checkpointOutput(attemptId, {
      kind: "retained",
      tip: candidateTip,
      reason: "Committed implementation output",
    });
    store.close();

    const applied = await f.call("workgraph_control", { action: "apply", attemptId });
    // SAFETY: Successful control receipts expose the exact post-operation Attempt view.
    assert.deepEqual(
      {
        action: (applied.details as { action: string }).action,
        target: (applied.details as { attempt: { task: { target: Task["target"] } } }).attempt.task
          .target,
        output: (applied.details as { attempt: { output: unknown } }).attempt.output,
      },
      {
        action: "apply",
        target: task.target,
        output: { kind: "applied", revision: candidateTip },
      },
    );

    // SAFETY: The successful control receipt contains the exact reported Outcome preview.
    const attemptView = applied.details as {
      attempt: {
        outcome: { kind: string; reportStatus: string; reportOutcome: string; summary: string };
        reportPreview: { text: string; totalChars: number; truncated: boolean };
      };
    };
    assert.deepEqual(attemptView.attempt.outcome, {
      kind: "reported",
      reportStatus: "completed",
      reportOutcome: "changed",
      summary: "Produced the Candidate.",
    });
    assert.match(attemptView.attempt.reportPreview.text, /Produced the Candidate/);
    assert.ok(attemptView.attempt.reportPreview.totalChars > 0);
    assert.equal(attemptView.attempt.reportPreview.truncated, false);
    assert.equal(
      await readFile(join(facts.managedPath, "candidate.txt"), "utf8"),
      "worker candidate\n",
    );
    assert.equal(existsSync(join(f.root, "candidate.txt")), false);
    await assert.rejects(f.call("workgraph_control", { action: "apply", attemptId }));
  } finally {
    await f.dispose();
  }
});
