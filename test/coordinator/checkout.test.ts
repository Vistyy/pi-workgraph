/* oxlint-disable anti-slop/require-readable-spacing -- Fixture setup and assertions remain grouped by observable flow. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Effect } from "effect";
import coordinator from "../../extensions/coordinator.js";
import type { GitHubReader, PullRequestFacts } from "../../src/coordinator/checkouts.js";
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
  readonly sourceCheckoutRoot: string;
  readonly sourceHead: string;
  readonly sourceRef?: string;
  readonly lifecycle: unknown;
};

async function administrationDir(managedPath: string): Promise<string> {
  const backlink = await readFile(join(managedPath, ".git"), "utf8");
  const match = /^gitdir: (.+)\r?\n?$/.exec(backlink);

  assert.ok(match?.[1] !== undefined);
  return match[1];
}

async function fixture(github?: GitHubReader) {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-checkout-"));
  const root = join(parent, "repo");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Workgraph Test");
  await git(root, "config", "user.email", "workgraph@example.invalid");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, "tracked.txt"), "base\n");
  await writeFile(join(root, "unstaged.txt"), "base unstaged\n");
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
  const pi = await extensionFixture(
    "coordinator",
    root,
    parent,
    {},
    github === undefined ? [] : [(piApi) => coordinator(piApi, { github })],
  );

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

async function pullRequestFixture() {
  let current: PullRequestFacts | undefined;
  const github: GitHubReader = {
    readPullRequest(url) {
      if (current === undefined) throw new Error(`No controlled PR response for ${url}`);

      return Promise.resolve(current);
    },
  };
  const f = await fixture(github);
  const remote = join(f.parent, "remote.git");
  const remoteUrl = "https://github.test/upstream/project.git";
  await git(f.parent, "init", "--bare", remote);
  await git(f.root, "config", `url.file://${remote}.insteadOf`, remoteUrl);
  await git(f.root, "remote", "add", "origin", remoteUrl);
  await git(f.root, "push", "-u", "origin", "main");

  return {
    ...f,
    remote,
    remoteUrl,
    url: "https://github.test/upstream/project/pull/7",
    setPullRequest(facts: PullRequestFacts) {
      current = facts;
    },
  };
}

function pullRequestFacts(input: {
  readonly url: string;
  readonly accepted: string;
  readonly branch: string;
  readonly merged?: string;
  readonly state?: "open" | "closed";
  readonly baseBranch?: string;
}): PullRequestFacts {
  const facts: PullRequestFacts = {
    url: input.url,
    number: 7,
    state: input.state ?? (input.merged === undefined ? "open" : "closed"),
    merged: input.merged !== undefined,
    headSha: input.accepted,
    headBranch: input.branch,
    headOwner: "upstream",
    headRepository: "project",
    baseBranch: input.baseBranch ?? "main",
    baseOwner: "upstream",
    baseRepository: "project",
  };

  return input.merged === undefined ? facts : { ...facts, mergeCommitSha: input.merged };
}

async function mergePublishedPullRequest(
  f: Awaited<ReturnType<typeof pullRequestFixture>>,
  branch: string,
  method: "merge" | "squash" | "rebase",
): Promise<string> {
  const integration = join(f.parent, `integration-${method}`);
  await git(f.parent, "clone", f.remote, integration);
  await git(integration, "config", "user.name", "Workgraph Test");
  await git(integration, "config", "user.email", "workgraph@example.invalid");
  await writeFile(join(integration, `base-${method}.txt`), `advanced ${method}\n`);
  await git(integration, "add", ".");
  await git(integration, "commit", "-m", `advance base for ${method}`);

  if (method === "merge") {
    await git(integration, "merge", "--no-ff", `origin/${branch}`, "-m", "merge PR");
  } else if (method === "squash") {
    await git(integration, "merge", "--squash", `origin/${branch}`);
    await git(integration, "commit", "-m", "squash PR");
  } else {
    await git(integration, "cherry-pick", `origin/${branch}`);
  }
  const result = await git(integration, "rev-parse", "HEAD");
  await git(integration, "push", "origin", "HEAD:main");

  return result;
}

void test("explicit checkout reuse records an exact pre-existing owned checkout without changing its work", async () => {
  const f = await fixture();

  try {
    const owned = f.facts((await f.call("workgraph_checkout", {})).details);
    await writeFile(join(owned.managedPath, "existing.txt"), "existing committed work\n");
    await git(owned.managedPath, "add", "existing.txt");
    await git(owned.managedPath, "commit", "-m", "existing owned change");
    const head = await git(owned.managedPath, "rev-parse", "HEAD");
    await writeFile(join(owned.managedPath, "tracked.txt"), "existing uncommitted work\n");
    await f.runner.emit({ type: "session_shutdown", reason: "reload" });
    // Model the previous schema, which recorded Tasks and Attempts but not Coordinator checkouts.
    const database = new DatabaseSync(join(f.agentDir, "workgraph", "workgraph.sqlite"));
    database.exec("DROP TABLE coordinator_checkouts");
    database.close();
    await f.runner.emit({ type: "session_start", reason: "reload" });

    const reused = f.facts((await f.call("workgraph_checkout", {})).details);
    assert.equal(reused.created, false);
    assert.equal(reused.reused, true);
    assert.equal(reused.head, head);
    assert.equal(reused.sourceCheckoutRoot, f.root);
    assert.equal(
      await readFile(join(reused.managedPath, "existing.txt"), "utf8"),
      "existing committed work\n",
    );
    assert.equal(
      await readFile(join(reused.managedPath, "tracked.txt"), "utf8"),
      "existing uncommitted work\n",
    );
  } finally {
    await f.dispose();
  }
});

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
    await mismatched.runner.emit({ type: "session_shutdown", reason: "reload" });
    await mismatched.runner.emit({ type: "session_start", reason: "reload" });
    await assert.rejects(
      mismatched.call("workgraph_checkout", {}),
      /recorded source HEAD|requested commit/,
    );
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
      destinationRoot: f.root,
      destinationRef: "refs/heads/main",
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
    await git(f.root, "add", "tracked.txt");
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

void test("verified pull-request merge methods reconcile current remote base and clean exact ownership", async (t) => {
  for (const method of ["merge", "squash", "rebase"] as const) {
    await t.test(method, async () => {
      const f = await pullRequestFixture();

      try {
        const checkout = f.facts((await f.call("workgraph_checkout", {})).details);
        const branch = checkout.ownedBranch.slice("refs/heads/".length);
        await writeFile(join(checkout.managedPath, "accepted-pr.txt"), `${method}\n`);
        await git(checkout.managedPath, "add", "accepted-pr.txt");
        await git(checkout.managedPath, "commit", "-m", `accepted ${method} PR`);
        const accepted = await git(checkout.managedPath, "rev-parse", "HEAD");
        await git(checkout.managedPath, "push", "origin", `${branch}:${branch}`);
        f.setPullRequest(pullRequestFacts({ url: f.url, accepted, branch }));

        const pending = await f.call("workgraph_deliver", {
          checkoutId: checkout.checkoutId,
          route: "pull_request",
          revision: accepted,
          url: f.url,
          remote: "origin",
        });
        // SAFETY: Successful delivery details contain the persisted strict checkout record.
        assert.equal(
          (pending.details as { disposition: { kind: string } }).disposition.kind,
          "pull_request",
        );
        assert.equal(existsSync(checkout.managedPath), true);

        const merged = await mergePublishedPullRequest(f, branch, method);
        f.setPullRequest(pullRequestFacts({ url: f.url, accepted, branch, merged }));
        await writeFile(join(f.root, "local-only.txt"), `local ${method}\n`);
        await git(f.root, "add", "local-only.txt");
        await git(f.root, "commit", "-m", `unpublished local ${method}`);
        const localCommit = await git(f.root, "rev-parse", "HEAD");
        await writeFile(join(f.root, "staged-only.txt"), "staged survives\n");
        await git(f.root, "add", "staged-only.txt");
        await writeFile(join(f.root, "unstaged.txt"), "unstaged survives\n");
        await writeFile(join(f.root, "untracked-pr.txt"), "untracked survives\n");
        await writeFile(join(f.root, "ignored.txt"), "ignored survives\n");

        if (method === "squash") await git(f.root, "push", "origin", `:refs/heads/${branch}`);
        const delivered = await f.call("workgraph_deliver", {
          checkoutId: checkout.checkoutId,
        });
        // SAFETY: Successful delivery details contain the persisted strict checkout record.
        const disposition = (
          delivered.details as {
            disposition: {
              kind: string;
              route: string;
              revision: string;
              destinationRoot: string;
              mergedRevision: string;
            };
          }
        ).disposition;
        assert.equal(disposition.kind, "complete");
        assert.equal(disposition.route, "pull_request");
        assert.equal(disposition.revision, accepted);
        assert.equal(disposition.mergedRevision, merged);
        assert.equal(disposition.destinationRoot, f.root);
        assert.equal(await readFile(join(f.root, "accepted-pr.txt"), "utf8"), `${method}\n`);
        assert.equal(
          await readFile(join(f.root, `base-${method}.txt`), "utf8"),
          `advanced ${method}\n`,
        );
        assert.equal(await git(f.root, "show", ":staged-only.txt"), "staged survives");
        assert.equal(await readFile(join(f.root, "unstaged.txt"), "utf8"), "unstaged survives\n");
        assert.equal(
          await readFile(join(f.root, "untracked-pr.txt"), "utf8"),
          "untracked survives\n",
        );
        assert.equal(await readFile(join(f.root, "ignored.txt"), "utf8"), "ignored survives\n");
        assert.equal(existsSync(checkout.managedPath), false);
        await assert.rejects(git(f.root, "rev-parse", "--verify", checkout.ownedBranch));
        await assert.rejects(
          git(f.root, "ls-remote", "--exit-code", "origin", `refs/heads/${branch}`),
        );
        const remoteMain = await git(f.root, "ls-remote", "origin", "refs/heads/main");
        const remoteMainRevision = remoteMain.split(/\s+/u)[0];
        assert.ok(remoteMainRevision !== undefined);
        await assert.rejects(
          git(f.root, "merge-base", "--is-ancestor", localCommit, remoteMainRevision),
        );
        const fresh = f.facts((await f.call("workgraph_checkout", {})).details);
        assert.equal(fresh.created, true);
        assert.equal(fresh.head, await git(f.root, "rev-parse", "HEAD"));
      } finally {
        await f.dispose();
      }
    });
  }
});

void test("pull-request mismatches and closed-unmerged disposition preserve owned work", async () => {
  const f = await pullRequestFixture();

  try {
    const checkout = f.facts((await f.call("workgraph_checkout", {})).details);
    const branch = checkout.ownedBranch.slice("refs/heads/".length);
    await writeFile(join(checkout.managedPath, "accepted-pr.txt"), "accepted\n");
    await git(checkout.managedPath, "add", "accepted-pr.txt");
    await git(checkout.managedPath, "commit", "-m", "accepted PR");
    const accepted = await git(checkout.managedPath, "rev-parse", "HEAD");
    await git(checkout.managedPath, "push", "origin", `${branch}:${branch}`);
    f.setPullRequest(pullRequestFacts({ url: f.url, accepted: checkout.sourceHead, branch }));
    await assert.rejects(
      f.call("workgraph_deliver", {
        checkoutId: checkout.checkoutId,
        route: "pull_request",
        revision: accepted,
        url: f.url,
        remote: "origin",
      }),
      /head does not match/,
    );
    f.setPullRequest(pullRequestFacts({ url: f.url, accepted, branch }));
    await f.call("workgraph_deliver", {
      checkoutId: checkout.checkoutId,
      route: "pull_request",
      revision: accepted,
      url: f.url,
      remote: "origin",
    });
    await writeFile(join(checkout.managedPath, "correction.txt"), "corrected\n");
    await git(checkout.managedPath, "add", "correction.txt");
    await git(checkout.managedPath, "commit", "-m", "non-force correction");
    const corrected = await git(checkout.managedPath, "rev-parse", "HEAD");
    await git(checkout.managedPath, "push", "origin", `${branch}:${branch}`);
    f.setPullRequest(pullRequestFacts({ url: f.url, accepted: corrected, branch }));
    const updated = await f.call("workgraph_deliver", {
      checkoutId: checkout.checkoutId,
      route: "pull_request",
      revision: corrected,
      url: f.url,
      remote: "origin",
    });
    // SAFETY: Successful delivery details contain the persisted strict checkout record.
    assert.equal(
      (updated.details as { disposition: { acceptedRevision: string } }).disposition
        .acceptedRevision,
      corrected,
    );
    f.setPullRequest(
      pullRequestFacts({ url: f.url, accepted: corrected, branch, state: "closed" }),
    );
    const retained = await f.call("workgraph_deliver", { checkoutId: checkout.checkoutId });
    // SAFETY: Successful delivery details contain the persisted strict checkout record.
    const disposition = (
      retained.details as {
        disposition: { retained?: string; paused?: true };
      }
    ).disposition;
    assert.equal(disposition.retained, "closed_unmerged");
    assert.equal(disposition.paused, true);
    assert.equal(existsSync(checkout.managedPath), true);
    assert.equal(
      await git(f.root, "ls-remote", "origin", `refs/heads/${branch}`).then(Boolean),
      true,
    );
  } finally {
    await f.dispose();
  }
});

void test("session restart observes an uncertain successful remote deletion without replay", async () => {
  // SAFETY: This fixture temporarily redirects Git only for its task-owned disposable repositories.
  const environment = process.env as NodeJS.ProcessEnv & {
    PATH: string | undefined;
    WORKGRAPH_TEST_REAL_GIT: string | undefined;
  };
  const originalPath = environment.PATH;
  const originalRealGit = environment.WORKGRAPH_TEST_REAL_GIT;
  const realGit = originalPath
    ?.split(":")
    .map((directory) => join(directory, "git"))
    .find((candidate) => existsSync(candidate));
  assert.ok(realGit !== undefined);
  const f = await pullRequestFixture();

  try {
    const checkout = f.facts((await f.call("workgraph_checkout", {})).details);
    const branch = checkout.ownedBranch.slice("refs/heads/".length);
    await writeFile(join(checkout.managedPath, "accepted-pr.txt"), "accepted\n");
    await git(checkout.managedPath, "add", "accepted-pr.txt");
    await git(checkout.managedPath, "commit", "-m", "accepted PR");
    const accepted = await git(checkout.managedPath, "rev-parse", "HEAD");
    await git(checkout.managedPath, "push", "origin", `${branch}:${branch}`);
    f.setPullRequest(pullRequestFacts({ url: f.url, accepted, branch }));
    await f.call("workgraph_deliver", {
      checkoutId: checkout.checkoutId,
      route: "pull_request",
      revision: accepted,
      url: f.url,
      remote: "origin",
    });
    const merged = await mergePublishedPullRequest(f, branch, "merge");
    f.setPullRequest(pullRequestFacts({ url: f.url, accepted, branch, merged }));
    const bin = join(f.parent, "uncertain-delete-bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\ncase " $* " in\n  *" push --force-with-lease="*" :refs/heads/"*)\n    "$WORKGRAPH_TEST_REAL_GIT" "$@"\n    status=$?\n    [ $status -eq 0 ] || exit $status\n    exit 17\n    ;;\nesac\nexec "$WORKGRAPH_TEST_REAL_GIT" "$@"\n`,
    );
    await chmod(join(bin, "git"), 0o700);
    environment.WORKGRAPH_TEST_REAL_GIT = realGit;
    environment.PATH = `${bin}:${originalPath ?? ""}`;

    await f.runner.emit({ type: "session_shutdown", reason: "reload" });
    await f.runner.emit({ type: "session_start", reason: "reload" });
    const state = new RecordStore(f.agentDir, f.session.getSessionId());
    const disposition = state.readCheckout(checkout.repositoryCommonDir)?.disposition;
    state.close();
    assert.equal(disposition?.kind, "complete");
    assert.equal(disposition?.kind === "complete" ? disposition.route : undefined, "pull_request");
    assert.equal(existsSync(checkout.managedPath), false);
    await assert.rejects(git(f.root, "rev-parse", "--verify", checkout.ownedBranch));
    await assert.rejects(git(f.root, "ls-remote", "--exit-code", "origin", `refs/heads/${branch}`));
  } finally {
    environment.PATH = originalPath;
    environment.WORKGRAPH_TEST_REAL_GIT = originalRealGit;
    await f.dispose();
  }
});

void test("changed published tip blocks deletion after integration and preservation retains proof", async () => {
  const f = await pullRequestFixture();

  try {
    const checkout = f.facts((await f.call("workgraph_checkout", {})).details);
    const branch = checkout.ownedBranch.slice("refs/heads/".length);
    await writeFile(join(checkout.managedPath, "accepted-pr.txt"), "accepted\n");
    await git(checkout.managedPath, "add", "accepted-pr.txt");
    await git(checkout.managedPath, "commit", "-m", "accepted PR");
    const accepted = await git(checkout.managedPath, "rev-parse", "HEAD");
    await git(checkout.managedPath, "push", "origin", `${branch}:${branch}`);
    f.setPullRequest(pullRequestFacts({ url: f.url, accepted, branch }));
    await f.call("workgraph_deliver", {
      checkoutId: checkout.checkoutId,
      route: "pull_request",
      revision: accepted,
      url: f.url,
      remote: "origin",
    });
    const merged = await mergePublishedPullRequest(f, branch, "merge");
    f.setPullRequest(pullRequestFacts({ url: f.url, accepted, branch, merged }));
    const changed = join(f.parent, "changed-published-branch");
    await git(f.parent, "clone", f.remote, changed);
    await git(changed, "config", "user.name", "Workgraph Test");
    await git(changed, "config", "user.email", "workgraph@example.invalid");
    await git(changed, "switch", "--track", `origin/${branch}`);
    await writeFile(join(changed, "post-acceptance.txt"), "changed\n");
    await git(changed, "add", ".");
    await git(changed, "commit", "-m", "post-acceptance branch change");
    const changedTip = await git(changed, "rev-parse", "HEAD");
    await git(changed, "push", "origin", `HEAD:${branch}`);

    await assert.rejects(
      f.call("workgraph_deliver", { checkoutId: checkout.checkoutId }),
      /changed after acceptance and was preserved/,
    );
    assert.equal(await readFile(join(f.root, "accepted-pr.txt"), "utf8"), "accepted\n");
    assert.equal(existsSync(checkout.managedPath), true);
    assert.match(
      await git(f.root, "ls-remote", "origin", `refs/heads/${branch}`),
      new RegExp(`^${changedTip}`),
    );
    const state = new RecordStore(f.agentDir, f.session.getSessionId());
    const integrated = state.readCheckout(checkout.repositoryCommonDir)?.disposition;
    state.close();
    assert.equal(integrated?.kind, "pull_request");
    assert.equal(integrated?.kind === "pull_request" ? integrated.integrated : false, true);
    assert.equal(
      integrated?.kind === "pull_request" ? integrated.cleanup : undefined,
      "remote_branch",
    );
    const preserved = await f.call("workgraph_deliver", {
      checkoutId: checkout.checkoutId,
      route: "preserve",
    });
    // SAFETY: Successful delivery details contain the persisted strict checkout record.
    const paused = (
      preserved.details as {
        disposition: { integrated?: true; cleanup?: string; paused?: true };
      }
    ).disposition;
    assert.equal(paused.integrated, true);
    assert.equal(paused.cleanup, "remote_branch");
    assert.equal(paused.paused, true);
  } finally {
    await f.dispose();
  }
});

void test("integrated paused local delivery explicitly reaccepts new clean source work", async () => {
  const f = await fixture();

  try {
    const checkout = f.facts((await f.call("workgraph_checkout", {})).details);
    await writeFile(join(checkout.managedPath, "first.txt"), "first\n");
    await git(checkout.managedPath, "add", "first.txt");
    await git(checkout.managedPath, "commit", "-m", "first accepted change");
    const first = await git(checkout.managedPath, "rev-parse", "HEAD");
    const store = new RecordStore(f.agentDir, f.session.getSessionId());
    store.createTaskWithAttempt(
      "cleanup-blocker",
      {
        target: { kind: "directory", path: checkout.managedPath },
        contract: { kind: "research", question: "Keep cleanup blocked." },
      },
      "attempt-cleanup-blocker",
      {
        selection: {
          kind: "target",
          target: { model: "fixture/research", thinking: "high" },
        },
        base: { kind: "directory" },
      },
    );
    store.close();
    await assert.rejects(
      f.call("workgraph_deliver", {
        checkoutId: checkout.checkoutId,
        route: "local",
        revision: first,
      }),
      /Cleanup blocked/,
    );
    await f.call("workgraph_deliver", { checkoutId: checkout.checkoutId, route: "preserve" });
    await writeFile(join(checkout.managedPath, "second.txt"), "second\n");
    await git(checkout.managedPath, "add", "second.txt");
    await git(checkout.managedPath, "commit", "-m", "second accepted change");
    const second = await git(checkout.managedPath, "rev-parse", "HEAD");
    const settled = new RecordStore(f.agentDir, f.session.getSessionId());
    settled.recordOutcome("attempt-cleanup-blocker", {
      result: { kind: "cancelled", reason: "Cleanup may continue." },
      effectiveModels: [],
    });
    settled.close();

    const delivered = await f.call("workgraph_deliver", {
      checkoutId: checkout.checkoutId,
      route: "local",
      revision: second,
    });
    // SAFETY: Successful delivery details contain the persisted strict checkout record.
    assert.equal(
      (delivered.details as { disposition: { revision: string } }).disposition.revision,
      second,
    );
    assert.equal(await readFile(join(f.root, "first.txt"), "utf8"), "first\n");
    assert.equal(await readFile(join(f.root, "second.txt"), "utf8"), "second\n");
  } finally {
    await f.dispose();
  }
});

void test("pull-request registration validates destination, freezes binding, and retains a closed PR with no branch", async () => {
  const f = await pullRequestFixture();

  try {
    const checkout = f.facts((await f.call("workgraph_checkout", {})).details);
    const branch = checkout.ownedBranch.slice("refs/heads/".length);
    await writeFile(join(checkout.managedPath, "accepted-pr.txt"), "accepted\n");
    await git(checkout.managedPath, "add", "accepted-pr.txt");
    await git(checkout.managedPath, "commit", "-m", "accepted PR");
    const accepted = await git(checkout.managedPath, "rev-parse", "HEAD");
    await git(checkout.managedPath, "push", "origin", `${branch}:${branch}`);
    f.setPullRequest(pullRequestFacts({ url: f.url, accepted, branch }));
    const foreign = join(f.parent, "foreign-destination");
    await mkdir(foreign);
    await git(foreign, "init", "-b", "main");
    await git(foreign, "config", "user.name", "Workgraph Test");
    await git(foreign, "config", "user.email", "workgraph@example.invalid");
    await writeFile(join(foreign, "foreign.txt"), "foreign\n");
    await git(foreign, "add", ".");
    await git(foreign, "commit", "-m", "foreign");
    await assert.rejects(
      f.call("workgraph_deliver", {
        checkoutId: checkout.checkoutId,
        route: "pull_request",
        revision: accepted,
        url: f.url,
        remote: "origin",
        destination: { cwd: foreign, ref: "refs/heads/main" },
      }),
      /another repository/,
    );
    await git(f.root, "checkout", "--detach");
    await assert.rejects(
      f.call("workgraph_deliver", {
        checkoutId: checkout.checkoutId,
        route: "pull_request",
        revision: accepted,
        url: f.url,
        remote: "origin",
        destination: { cwd: f.root, ref: "refs/heads/main" },
      }),
      /not attached to the authorized ref/,
    );
    await git(f.root, "switch", "main");
    await f.call("workgraph_deliver", {
      checkoutId: checkout.checkoutId,
      route: "pull_request",
      revision: accepted,
      url: f.url,
      remote: "origin",
    });
    f.setPullRequest(pullRequestFacts({ url: f.url, accepted, branch, baseBranch: "retargeted" }));
    await assert.rejects(
      f.call("workgraph_deliver", {
        checkoutId: checkout.checkoutId,
        route: "pull_request",
        revision: accepted,
        url: f.url,
        remote: "origin",
      }),
      /cannot rebind its recorded repository or branches/,
    );
    await git(f.root, "push", "origin", `:refs/heads/${branch}`);
    f.setPullRequest(pullRequestFacts({ url: f.url, accepted, branch, state: "closed" }));
    const retained = await f.call("workgraph_deliver", { checkoutId: checkout.checkoutId });
    // SAFETY: Successful delivery details contain the persisted strict checkout record.
    const disposition = (retained.details as { disposition: { retained?: string; paused?: true } })
      .disposition;
    assert.equal(disposition.retained, "closed_unmerged");
    assert.equal(disposition.paused, true);
    assert.equal(existsSync(checkout.managedPath), true);
  } finally {
    await f.dispose();
  }
});

void test("explicit pull-request retry replans an absent integration against the merged base", async () => {
  // SAFETY: This fixture temporarily redirects Git only for its task-owned disposable repositories.
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
  const f = await pullRequestFixture();

  try {
    const checkout = f.facts((await f.call("workgraph_checkout", {})).details);
    const branch = checkout.ownedBranch.slice("refs/heads/".length);
    await writeFile(join(checkout.managedPath, "accepted-pr.txt"), "accepted\n");
    await git(checkout.managedPath, "add", "accepted-pr.txt");
    await git(checkout.managedPath, "commit", "-m", "accepted PR");
    const accepted = await git(checkout.managedPath, "rev-parse", "HEAD");
    await git(checkout.managedPath, "push", "origin", `${branch}:${branch}`);
    f.setPullRequest(pullRequestFacts({ url: f.url, accepted, branch }));
    await f.call("workgraph_deliver", {
      checkoutId: checkout.checkoutId,
      route: "pull_request",
      revision: accepted,
      url: f.url,
      remote: "origin",
    });
    const merged = await mergePublishedPullRequest(f, branch, "squash");
    f.setPullRequest(pullRequestFacts({ url: f.url, accepted, branch, merged }));
    const bin = join(f.parent, "retry-pr-bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\ncase " $* " in\n  *" merge --ff-only "*) [ "$WORKGRAPH_TEST_GIT_MODE" = fail ] && exit 17 ;;\nesac\nexec "$WORKGRAPH_TEST_REAL_GIT" "$@"\n`,
    );
    await chmod(join(bin, "git"), 0o700);
    environment.WORKGRAPH_TEST_REAL_GIT = realGit;
    environment.WORKGRAPH_TEST_GIT_MODE = "fail";
    environment.PATH = `${bin}:${originalPath ?? ""}`;
    await assert.rejects(
      f.call("workgraph_deliver", { checkoutId: checkout.checkoutId }),
      /Git refused the prepared advancement/,
    );
    await writeFile(join(f.root, "local-after-prepare.txt"), "local\n");
    await git(f.root, "add", "local-after-prepare.txt");
    await git(f.root, "commit", "-m", "advance destination after failed effect");
    environment.WORKGRAPH_TEST_GIT_MODE = "normal";

    await f.call("workgraph_deliver", {
      checkoutId: checkout.checkoutId,
      route: "pull_request",
      revision: accepted,
      url: f.url,
      remote: "origin",
    });
    assert.equal(await readFile(join(f.root, "accepted-pr.txt"), "utf8"), "accepted\n");
    assert.equal(await readFile(join(f.root, "local-after-prepare.txt"), "utf8"), "local\n");
  } finally {
    environment.PATH = originalPath;
    environment.WORKGRAPH_TEST_REAL_GIT = originalRealGit;
    environment.WORKGRAPH_TEST_GIT_MODE = originalMode;
    await f.dispose();
  }
});

void test("pull-request cleanup recovers failed removal responses without resurrection and blocks dangling paths", async () => {
  // SAFETY: This fixture temporarily redirects Git only for its task-owned disposable repositories.
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
  const f = await pullRequestFixture();

  try {
    const checkout = f.facts((await f.call("workgraph_checkout", {})).details);
    const branch = checkout.ownedBranch.slice("refs/heads/".length);
    await writeFile(join(checkout.managedPath, "accepted-pr.txt"), "accepted\n");
    await git(checkout.managedPath, "add", "accepted-pr.txt");
    await git(checkout.managedPath, "commit", "-m", "accepted PR");
    const accepted = await git(checkout.managedPath, "rev-parse", "HEAD");
    await git(checkout.managedPath, "push", "origin", `${branch}:${branch}`);
    f.setPullRequest(pullRequestFacts({ url: f.url, accepted, branch }));
    await f.call("workgraph_deliver", {
      checkoutId: checkout.checkoutId,
      route: "pull_request",
      revision: accepted,
      url: f.url,
      remote: "origin",
    });
    const merged = await mergePublishedPullRequest(f, branch, "merge");
    f.setPullRequest(pullRequestFacts({ url: f.url, accepted, branch, merged }));
    const bin = join(f.parent, "cleanup-recovery-bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\ncase " $* " in\n  *" worktree remove --force "*)\n    if [ "$WORKGRAPH_TEST_GIT_MODE" = dangling ]; then\n      last=""; for arg do last="$arg"; done\n      "$WORKGRAPH_TEST_REAL_GIT" "$@" || exit $?\n      ln -s "$last-missing" "$last"\n      exit 17\n    fi\n    ;;\n  *" update-ref -d "*)\n    if [ "$WORKGRAPH_TEST_GIT_MODE" = branch-error ]; then\n      "$WORKGRAPH_TEST_REAL_GIT" "$@" || exit $?\n      exit 17\n    fi\n    ;;\nesac\nexec "$WORKGRAPH_TEST_REAL_GIT" "$@"\n`,
    );
    await chmod(join(bin, "git"), 0o700);
    environment.WORKGRAPH_TEST_REAL_GIT = realGit;
    environment.WORKGRAPH_TEST_GIT_MODE = "dangling";
    environment.PATH = `${bin}:${originalPath ?? ""}`;
    await assert.rejects(
      f.call("workgraph_deliver", { checkoutId: checkout.checkoutId }),
      /Owned worktree removal was not established/,
    );
    await f.call("workgraph_deliver", {
      checkoutId: checkout.checkoutId,
      route: "preserve",
    });
    assert.equal(existsSync(checkout.managedPath), false);
    assert.equal(await git(f.root, "rev-parse", "--verify", checkout.ownedBranch), accepted);
    await f.runner.emit({ type: "session_shutdown", reason: "reload" });
    await f.runner.emit({ type: "session_start", reason: "reload" });
    await assert.rejects(f.call("workgraph_checkout", {}), /partial or duplicated|absent/);
    assert.equal(await git(f.root, "rev-parse", "--verify", checkout.ownedBranch), accepted);
    await rm(checkout.managedPath);
    environment.WORKGRAPH_TEST_GIT_MODE = "branch-error";
    const delivered = await f.call("workgraph_deliver", {
      checkoutId: checkout.checkoutId,
      route: "pull_request",
      revision: accepted,
      url: f.url,
      remote: "origin",
    });
    // SAFETY: Successful delivery details contain the persisted strict checkout record.
    assert.equal(
      (delivered.details as { disposition: { kind: string } }).disposition.kind,
      "complete",
    );
    await f.runner.emit({ type: "session_shutdown", reason: "reload" });
    await f.runner.emit({ type: "session_start", reason: "reload" });
    await assert.rejects(git(f.root, "rev-parse", "--verify", checkout.ownedBranch));
  } finally {
    environment.PATH = originalPath;
    environment.WORKGRAPH_TEST_REAL_GIT = originalRealGit;
    environment.WORKGRAPH_TEST_GIT_MODE = originalMode;
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

void test("preserve observes the current owned head and self-delivery is rejected", async () => {
  const f = await fixture();

  try {
    const first = f.facts((await f.call("workgraph_checkout", {})).details);
    await writeFile(join(first.managedPath, "preserved.txt"), "one\n");
    await git(first.managedPath, "add", "preserved.txt");
    await git(first.managedPath, "commit", "-m", "preserve one");
    const one = await git(first.managedPath, "rev-parse", "HEAD");
    const preserved = await f.call("workgraph_deliver", {
      checkoutId: first.checkoutId,
      route: "preserve",
    });
    // SAFETY: Successful delivery details contain the persisted strict checkout record.
    assert.equal((preserved.details as { disposition: { head: string } }).disposition.head, one);

    await writeFile(join(first.managedPath, "preserved.txt"), "two\n");
    await git(first.managedPath, "commit", "-am", "preserve two");
    const two = await git(first.managedPath, "rev-parse", "HEAD");
    const repeated = await f.call("workgraph_deliver", {
      checkoutId: first.checkoutId,
      route: "preserve",
    });
    // SAFETY: Successful delivery details contain the persisted strict checkout record.
    assert.equal((repeated.details as { disposition: { head: string } }).disposition.head, two);

    const fresh = f.facts((await f.call("workgraph_checkout", {})).details);
    assert.equal(fresh.reused, true);
    assert.equal(fresh.head, two);
    assert.equal(fresh.sourceHead, first.sourceHead);
    const mergeHead = await git(fresh.managedPath, "rev-parse", "--git-path", "MERGE_HEAD");
    await writeFile(mergeHead, `${two}\n`);
    await assert.rejects(
      f.call("workgraph_deliver", {
        checkoutId: first.checkoutId,
        route: "local",
        revision: two,
      }),
      /merge or rebase operation in progress/,
    );
    await rm(mergeHead);
    await assert.rejects(
      f.call("workgraph_deliver", {
        checkoutId: first.checkoutId,
        route: "local",
        revision: two,
        destination: { cwd: first.managedPath, ref: first.ownedBranch },
      }),
      /cannot be its own delivery destination/,
    );
    assert.equal(existsSync(first.managedPath), true);
  } finally {
    await f.dispose();
  }
});

void test("integrated destination proof and pending Candidate cleanup gate destructive checkout cleanup", async () => {
  const f = await fixture();

  try {
    const checkout = f.facts((await f.call("workgraph_checkout", {})).details);
    const original = await git(f.root, "rev-parse", "HEAD");
    await writeFile(join(checkout.managedPath, "accepted.txt"), "accepted\n");
    await git(checkout.managedPath, "add", "accepted.txt");
    await git(checkout.managedPath, "commit", "-m", "accepted");
    const accepted = await git(checkout.managedPath, "rev-parse", "HEAD");
    const store = new RecordStore(f.agentDir, f.session.getSessionId());
    const selection = {
      kind: "implementation" as const,
      guide: { model: "fixture/guide", thinking: "high" as const },
      executor: { model: "fixture/executor", thinking: "high" as const },
    };
    store.createTaskWithAttempt(
      "active-directory",
      {
        target: { kind: "directory", path: join(checkout.managedPath, "nested") },
        contract: { kind: "research", question: "Keep checkout in use." },
      },
      "attempt-active-directory",
      { selection: { kind: "target", target: selection.guide }, base: { kind: "directory" } },
    );
    store.createTaskWithAttempt(
      "pending-cleanup",
      {
        target: {
          kind: "repository",
          checkoutRoot: checkout.managedPath,
          commonDir: checkout.repositoryCommonDir,
        },
        contract: {
          kind: "implementation",
          objective: "Retain cleanup custody.",
          acceptance: ["Private ref is released."],
        },
      },
      "attempt-pending-cleanup",
      { selection, base: { kind: "repository", baseCommit: checkout.sourceHead } },
    );
    store.recordOutcome("attempt-pending-cleanup", {
      result: {
        kind: "reported",
        report: {
          role: "implementation",
          status: "completed",
          outcome: "changed",
          summary: "Applied.",
          details: "Cleanup remains.",
        },
      },
      effectiveModels: [],
    });
    await git(f.root, "update-ref", "refs/pi-workgraph/outputs/attempt-pending-cleanup", accepted);
    // Hold the native ref effect pending so background reconciliation cannot race the assertions.
    const cleanupLock = join(
      checkout.repositoryCommonDir,
      "refs/pi-workgraph/outputs/attempt-pending-cleanup.lock",
    );
    await writeFile(cleanupLock, "fixture-owned pending ref transaction\n", { flag: "wx" });
    store.checkpointOutput("attempt-pending-cleanup", {
      kind: "applied",
      revision: accepted,
      cleanupTip: accepted,
    });
    store.close();

    await assert.rejects(
      f.call("workgraph_deliver", {
        checkoutId: checkout.checkoutId,
        route: "local",
        revision: accepted,
      }),
      /Cleanup blocked/,
    );
    const state = new RecordStore(f.agentDir, f.session.getSessionId());
    const local = state.readCheckout(checkout.repositoryCommonDir)?.disposition;
    assert.equal(local?.kind, "local");
    assert.equal(local.kind === "local" ? local.integrated : false, true);
    const prepared = local.kind === "local" ? local.preparedRevision : "";
    state.recordOutcome("attempt-active-directory", {
      result: { kind: "cancelled", reason: "Dependency ended." },
      effectiveModels: [],
    });
    state.close();
    await assert.rejects(
      f.call("workgraph_deliver", { checkoutId: checkout.checkoutId }),
      /Cleanup blocked: 1 Worker or Candidate disposition/,
    );
    await f.call("workgraph_deliver", {
      checkoutId: checkout.checkoutId,
      route: "preserve",
    });
    await rm(cleanupLock);
    await f.runner.emit({ type: "session_shutdown", reason: "reload" });
    await f.runner.emit({ type: "session_start", reason: "reload" });
    for (let index = 0; index < 40; index += 1) {
      const observed = new RecordStore(f.agentDir, f.session.getSessionId());
      const output = observed.readAttempt("attempt-pending-cleanup").output;
      observed.close();
      if (output?.kind === "applied" && output.cleanupTip === undefined) break;
      await Effect.runPromise(Effect.sleep("50 millis"));
    }
    const cleaned = new RecordStore(f.agentDir, f.session.getSessionId());
    const applied = cleaned.readAttempt("attempt-pending-cleanup").output;
    cleaned.close();
    assert.equal(applied?.kind, "applied");
    assert.equal(applied?.kind === "applied" ? applied.cleanupTip : "unexpected", undefined);
    await assert.rejects(
      git(f.root, "rev-parse", "--verify", "refs/pi-workgraph/outputs/attempt-pending-cleanup"),
    );
    await git(f.root, "reset", "--hard", original);
    await assert.rejects(
      f.call("workgraph_deliver", {
        checkoutId: checkout.checkoutId,
        route: "local",
        revision: accepted,
      }),
      /no longer contains the recorded integrated revision/,
    );
    assert.equal(existsSync(checkout.managedPath), true);
    await git(f.root, "reset", "--hard", prepared);
    await f.call("workgraph_deliver", {
      checkoutId: checkout.checkoutId,
      route: "local",
      revision: accepted,
    });
    assert.equal(existsSync(checkout.managedPath), false);
  } finally {
    await f.dispose();
  }
});

void test("branch cleanup refuses a foreign worktree registration", async () => {
  const f = await fixture();

  try {
    const checkout = f.facts((await f.call("workgraph_checkout", {})).details);
    await writeFile(join(checkout.managedPath, "accepted.txt"), "accepted\n");
    await git(checkout.managedPath, "add", "accepted.txt");
    await git(checkout.managedPath, "commit", "-m", "accepted");
    const accepted = await git(checkout.managedPath, "rev-parse", "HEAD");
    const store = new RecordStore(f.agentDir, f.session.getSessionId());
    store.createTaskWithAttempt(
      "active-blocker",
      {
        target: { kind: "directory", path: checkout.managedPath },
        contract: { kind: "research", question: "Block cleanup." },
      },
      "attempt-active-blocker",
      {
        selection: {
          kind: "target",
          target: { model: "fixture/research", thinking: "high" },
        },
        base: { kind: "directory" },
      },
    );
    store.close();
    await assert.rejects(
      f.call("workgraph_deliver", {
        checkoutId: checkout.checkoutId,
        route: "local",
        revision: accepted,
      }),
      /Cleanup blocked/,
    );
    await git(f.root, "worktree", "remove", "--force", checkout.managedPath);
    const foreign = join(f.parent, "foreign-owned-branch");
    await git(f.root, "worktree", "add", foreign, checkout.ownedBranch.slice("refs/heads/".length));
    const settle = new RecordStore(f.agentDir, f.session.getSessionId());
    settle.recordOutcome("attempt-active-blocker", {
      result: { kind: "cancelled", reason: "Dependency ended." },
      effectiveModels: [],
    });
    settle.close();

    await assert.rejects(
      f.call("workgraph_deliver", { checkoutId: checkout.checkoutId }),
      /still used by a worktree registration/,
    );
    assert.equal(existsSync(foreign), true);
    assert.equal(await git(f.root, "rev-parse", "--verify", checkout.ownedBranch), accepted);
    await git(f.root, "worktree", "remove", foreign);
    await f.call("workgraph_deliver", { checkoutId: checkout.checkoutId });
    await assert.rejects(git(f.root, "rev-parse", "--verify", checkout.ownedBranch));
  } finally {
    await f.dispose();
  }
});

void test("checkpointed branch-only creation resumes and explicit local retry replans after an absent effect", async () => {
  // SAFETY: This bounded fixture temporarily prepends one task-owned Git wrapper.
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
  const f = await fixture();

  try {
    const bin = join(f.parent, "interrupt-bin");
    const wrapper = join(bin, "git");
    await mkdir(bin);
    await writeFile(
      wrapper,
      `#!/bin/sh\ncase " $* " in\n  *" worktree add "*)\n    if [ "$WORKGRAPH_TEST_GIT_MODE" = branch-only ]; then\n      branch=""; prev=""; last=""\n      for arg do\n        [ "$prev" = "-b" ] && branch="$arg"\n        prev="$arg"; last="$arg"\n      done\n      "$WORKGRAPH_TEST_REAL_GIT" -C "$2" update-ref "refs/heads/$branch" "$last"\n      exit 17\n    fi\n    ;;\n  *" merge --ff-only "*)\n    [ "$WORKGRAPH_TEST_GIT_MODE" = fail-merge ] && exit 17\n    ;;\nesac\nexec "$WORKGRAPH_TEST_REAL_GIT" "$@"\n`,
    );
    await chmod(wrapper, 0o700);
    environment.WORKGRAPH_TEST_REAL_GIT = realGit;
    environment.PATH = `${bin}:${originalPath ?? ""}`;
    environment.WORKGRAPH_TEST_GIT_MODE = "branch-only";
    await assert.rejects(f.call("workgraph_checkout", {}), /partial or duplicated/);
    environment.WORKGRAPH_TEST_GIT_MODE = "normal";
    const checkout = f.facts((await f.call("workgraph_checkout", {})).details);
    assert.equal(checkout.created, true);
    assert.equal(checkout.head, checkout.sourceHead);

    await writeFile(join(checkout.managedPath, "accepted.txt"), "accepted\n");
    await git(checkout.managedPath, "add", "accepted.txt");
    await git(checkout.managedPath, "commit", "-m", "accepted");
    const accepted = await git(checkout.managedPath, "rev-parse", "HEAD");
    environment.WORKGRAPH_TEST_GIT_MODE = "fail-merge";
    await assert.rejects(
      f.call("workgraph_deliver", {
        checkoutId: checkout.checkoutId,
        route: "local",
        revision: accepted,
      }),
      /Git refused the prepared advancement/,
    );
    await f.call("workgraph_deliver", { checkoutId: checkout.checkoutId, route: "preserve" });
    await writeFile(join(f.root, "destination.txt"), "advanced\n");
    await git(f.root, "add", "destination.txt");
    await git(f.root, "commit", "-m", "advance destination");
    environment.WORKGRAPH_TEST_GIT_MODE = "normal";
    await f.call("workgraph_deliver", {
      checkoutId: checkout.checkoutId,
      route: "local",
      revision: accepted,
    });
    assert.equal(await readFile(join(f.root, "accepted.txt"), "utf8"), "accepted\n");
    assert.equal(await readFile(join(f.root, "destination.txt"), "utf8"), "advanced\n");
    assert.equal(existsSync(checkout.managedPath), false);

    const retained = f.facts((await f.call("workgraph_checkout", {})).details);
    await writeFile(join(retained.managedPath, "preserve-after-local.txt"), "retained\n");
    await git(retained.managedPath, "add", "preserve-after-local.txt");
    await git(retained.managedPath, "commit", "-m", "retain after local selection");
    const retainedHead = await git(retained.managedPath, "rev-parse", "HEAD");
    environment.WORKGRAPH_TEST_GIT_MODE = "fail-merge";
    await assert.rejects(
      f.call("workgraph_deliver", {
        checkoutId: retained.checkoutId,
        route: "local",
        revision: retainedHead,
      }),
      /Git refused the prepared advancement/,
    );
    await writeFile(join(retained.managedPath, "source-drift.txt"), "drift\n");
    await git(retained.managedPath, "add", "source-drift.txt");
    await git(retained.managedPath, "commit", "-m", "source drift");
    const drifted = await git(retained.managedPath, "rev-parse", "HEAD");
    await assert.rejects(
      f.call("workgraph_deliver", { checkoutId: retained.checkoutId }),
      /Accepted source revision changed/,
    );
    const preserved = await f.call("workgraph_deliver", {
      checkoutId: retained.checkoutId,
      route: "preserve",
    });
    // SAFETY: Successful delivery details contain the persisted strict checkout record.
    const paused = (
      preserved.details as {
        disposition: { kind: string; acceptedRevision: string; paused?: true };
      }
    ).disposition;
    assert.equal(paused.kind, "local");
    assert.equal(paused.acceptedRevision, retainedHead);
    assert.equal(paused.paused, true);
    assert.equal(await git(retained.managedPath, "rev-parse", "HEAD"), drifted);
    assert.equal(existsSync(retained.managedPath), true);
    environment.WORKGRAPH_TEST_GIT_MODE = "normal";
    await f.call("workgraph_deliver", {
      checkoutId: retained.checkoutId,
      route: "local",
      revision: drifted,
    });
    assert.equal(await readFile(join(f.root, "preserve-after-local.txt"), "utf8"), "retained\n");
    assert.equal(await readFile(join(f.root, "source-drift.txt"), "utf8"), "drift\n");
    assert.equal(existsSync(retained.managedPath), false);
  } finally {
    environment.PATH = originalPath;
    environment.WORKGRAPH_TEST_REAL_GIT = originalRealGit;
    environment.WORKGRAPH_TEST_GIT_MODE = originalMode;
    await f.dispose();
  }
});

void test("registered Workgraph control applies an extended Candidate directly to the original managed root", async () => {
  const f = await fixture();

  try {
    const checkout = f.facts((await f.call("workgraph_checkout", {})).details);
    const workerPath = join(f.parent, "extended-candidate-worktree");
    await git(f.root, "worktree", "add", "--detach", workerPath, checkout.head);
    await writeFile(join(workerPath, "parent.txt"), "parent\n");
    await git(workerPath, "add", "parent.txt");
    await git(workerPath, "commit", "-m", "parent candidate");
    const parentTip = await git(workerPath, "rev-parse", "HEAD");
    await writeFile(join(workerPath, "child.txt"), "child\n");
    await git(workerPath, "add", "child.txt");
    await git(workerPath, "commit", "-m", "child candidate");
    const childTip = await git(workerPath, "rev-parse", "HEAD");
    await git(f.root, "worktree", "remove", workerPath);
    await git(f.root, "update-ref", "refs/pi-workgraph/outputs/attempt-parent", parentTip);
    await git(f.root, "update-ref", "refs/pi-workgraph/outputs/attempt-child", childTip);
    const store = new RecordStore(f.agentDir, f.session.getSessionId());
    const task = {
      target: {
        kind: "repository",
        checkoutRoot: checkout.managedPath,
        commonDir: checkout.repositoryCommonDir,
      },
      contract: {
        kind: "implementation",
        objective: "Apply an extended Candidate.",
        acceptance: ["Parent and child history reach the managed checkout."],
      },
    } satisfies Task;
    const selection = {
      kind: "implementation" as const,
      guide: { model: "fixture/guide", thinking: "high" as const },
      executor: { model: "fixture/executor", thinking: "high" as const },
    };
    store.createTaskWithAttempt("extended-candidate", task, "attempt-parent", {
      selection,
      base: { kind: "repository", baseCommit: checkout.head },
    });
    store.createAttempt("extended-candidate", "attempt-child", {
      selection,
      base: { kind: "repository", baseCommit: parentTip },
      lineage: {
        candidateRoot: checkout.head,
        candidateOf: { kind: "extend", attemptId: "attempt-parent" },
      },
    });
    for (const attemptId of ["attempt-parent", "attempt-child"]) {
      store.recordOutcome(attemptId, {
        result: {
          kind: "reported",
          report: {
            role: "implementation",
            status: "completed",
            outcome: "changed",
            summary: "Produced Candidate history.",
            details: "Committed and verified.",
          },
        },
        effectiveModels: [],
      });
    }
    store.checkpointOutput("attempt-parent", {
      kind: "retained",
      tip: parentTip,
      reason: "Parent Candidate",
    });
    store.checkpointOutput("attempt-child", {
      kind: "retained",
      tip: childTip,
      reason: "Extended Candidate",
    });
    store.close();

    await f.call("workgraph_control", { action: "apply", attemptId: "attempt-child" });
    assert.equal(await readFile(join(checkout.managedPath, "parent.txt"), "utf8"), "parent\n");
    assert.equal(await readFile(join(checkout.managedPath, "child.txt"), "utf8"), "child\n");
    assert.equal(existsSync(join(f.root, "parent.txt")), false);
    assert.equal(existsSync(join(f.root, "child.txt")), false);
    assert.equal(await git(checkout.managedPath, "rev-parse", "HEAD"), childTip);
  } finally {
    await f.dispose();
  }
});
