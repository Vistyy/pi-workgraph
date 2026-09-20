import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CheckoutDeliveryState } from "../../src/coordinator/delivery-state.js";
import { RecordStore } from "../../src/coordinator/store.js";
import { configureFixtureEnvironment, restoreFixtureEnvironment } from "../support/decoders.js";
import { extensionFixture, fixturePolicy, git } from "../support/helpers.js";

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-delivery-"));
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
    async dispose() {
      await pi.close();
      restoreFixtureEnvironment(previous);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

type AllocatedCheckout = {
  checkoutId: string;
  managedPath: string;
  repositoryCommonDir: string;
  ownedBranch: string;
};

async function allocateAccepted(
  f: Awaited<ReturnType<typeof fixture>>,
  name = "accepted.txt",
): Promise<AllocatedCheckout & { accepted: string }> {
  // SAFETY: Successful registered checkout results expose the asserted compact receipt.
  const allocated = (await f.call("workgraph_checkout", {})).details as AllocatedCheckout;
  await writeFile(join(allocated.managedPath, name), `${name}\n`);
  await git(allocated.managedPath, "add", name);
  await git(allocated.managedPath, "commit", "-m", `accept ${name}`);

  return { ...allocated, accepted: await git(allocated.managedPath, "rev-parse", "HEAD") };
}

function checkpoint(
  f: Awaited<ReturnType<typeof fixture>>,
  allocated: AllocatedCheckout,
  state: CheckoutDeliveryState,
): void {
  const store = new RecordStore(join(f.parent, "agent"), f.session.getSessionId());
  const record = store.readCheckout(allocated.repositoryCommonDir);

  assert.ok(record !== undefined);
  store.checkpointCheckout({ ...record, state });
  store.close();
}

void test("local delivery preserves disjoint destination bytes, cleans exact resources, and permits fresh allocation", async () => {
  const f = await fixture();

  try {
    // SAFETY: Successful registered checkout results expose the asserted compact receipt.
    const allocated = (await f.call("workgraph_checkout", {})).details as {
      checkoutId: string;
      managedPath: string;
      ownedBranch: string;
    };

    await writeFile(join(allocated.managedPath, "accepted.txt"), "accepted\n");
    await git(allocated.managedPath, "add", "accepted.txt");
    await git(allocated.managedPath, "commit", "-m", "accepted");
    const accepted = await git(allocated.managedPath, "rev-parse", "HEAD");

    await writeFile(join(f.root, "destination.txt"), "destination commit\n");
    await git(f.root, "add", "destination.txt");
    await git(f.root, "commit", "-m", "destination advance");
    await writeFile(join(f.root, "staged.txt"), "staged\n");
    await git(f.root, "add", "staged.txt");
    await writeFile(join(f.root, "untracked.txt"), "untracked\n");
    await writeFile(join(f.root, "ignored.txt"), "ignored\n");

    // SAFETY: Successful registered delivery results expose the asserted compact state receipt.
    const delivered = (
      await f.call("workgraph_deliver", {
        checkoutId: allocated.checkoutId,
        route: "local",
        revision: accepted,
      })
    ).details as { state: { kind: string; destinationRevision: string } };

    assert.equal(delivered.state.kind, "complete");
    assert.equal(await git(f.root, "rev-parse", "HEAD"), delivered.state.destinationRevision);
    assert.equal(await readFile(join(f.root, "accepted.txt"), "utf8"), "accepted\n");
    assert.equal(await readFile(join(f.root, "staged.txt"), "utf8"), "staged\n");
    assert.equal(await readFile(join(f.root, "untracked.txt"), "utf8"), "untracked\n");
    assert.equal(await readFile(join(f.root, "ignored.txt"), "utf8"), "ignored\n");
    assert.match(
      await git(f.root, "status", "--porcelain", "--ignored=matching"),
      /A {2}staged\.txt/u,
    );
    assert.equal(existsSync(allocated.managedPath), false);
    await assert.rejects(git(f.root, "rev-parse", "--verify", allocated.ownedBranch));

    await git(
      f.root,
      "worktree",
      "add",
      "-b",
      allocated.ownedBranch.slice("refs/heads/".length),
      allocated.managedPath,
      delivered.state.destinationRevision,
    );
    await assert.rejects(
      f.call("workgraph_checkout", {}),
      /Completed Coordinator checkout still has native owned resources/u,
    );
    await git(f.root, "worktree", "remove", allocated.managedPath);
    await git(f.root, "branch", "-d", allocated.ownedBranch.slice("refs/heads/".length));

    // SAFETY: Successful registered checkout results expose the asserted compact receipt.
    const fresh = (await f.call("workgraph_checkout", {})).details as {
      checkoutId: string;
      managedPath: string;
      head: string;
      state: { kind: string };
    };

    assert.equal(fresh.checkoutId, allocated.checkoutId);
    assert.equal(fresh.head, delivered.state.destinationRevision);
    assert.equal(fresh.state.kind, "available");
    assert.equal(existsSync(fresh.managedPath), true);
  } finally {
    await f.dispose();
  }
});

void test("pull-request delivery integrates merge, squash, and rebase results from an ordinary fork", async () => {
  for (const method of ["merge", "squash", "rebase"] as const) {
    const f = await fixture();
    // SAFETY: This only gives a name to the optional process PATH used by the bounded CLI fixture.
    const environment = process.env as NodeJS.ProcessEnv & { PATH: string | undefined };
    const priorPath = environment.PATH;

    try {
      const baseBare = join(f.parent, "base.git");
      const forkBare = join(f.parent, "fork.git");
      await git(f.parent, "init", "--bare", baseBare);
      await git(f.parent, "init", "--bare", forkBare);
      await git(f.root, "remote", "add", "upstream", "https://github.com/base/repo.git");
      await git(f.root, "remote", "add", "fork", "https://github.com/fork/repo.git");
      await git(f.root, "config", `url.${baseBare}.insteadOf`, "https://github.com/base/repo.git");
      await git(f.root, "config", `url.${forkBare}.insteadOf`, "https://github.com/fork/repo.git");
      await git(f.root, "push", "upstream", "main");
      const allocated = await allocateAccepted(f, `${method}.txt`);
      const branch = allocated.ownedBranch.slice("refs/heads/".length);
      await git(
        allocated.managedPath,
        "push",
        "fork",
        `${allocated.ownedBranch}:${allocated.ownedBranch}`,
      );

      const bin = join(f.parent, "bin");
      const response = join(f.parent, "gh-response.json");
      await mkdir(bin);
      await writeFile(join(bin, "gh"), `#!/bin/sh\ncat ${JSON.stringify(response)}\n`);
      await chmod(join(bin, "gh"), 0o700);
      environment.PATH = `${bin}:${priorPath ?? ""}`;
      const url = "https://github.com/base/repo/pull/7";

      const facts = (state: "OPEN" | "MERGED", merge: string | null) => ({
        url,
        state,
        headRefOid: allocated.accepted,
        headRefName: branch,
        headRepository: { nameWithOwner: "fork/repo" },
        baseRefName: "main",
        baseRepository: { nameWithOwner: "base/repo" },
        mergeCommit: merge === null ? null : { oid: merge },
      });

      await writeFile(response, JSON.stringify(facts("OPEN", null)));

      await f.call("workgraph_deliver", {
        checkoutId: allocated.checkoutId,
        route: "pull_request",
        revision: allocated.accepted,
        url,
        remote: "fork",
      });

      const mergeClone = join(f.parent, "merge-clone");
      await git(f.parent, "clone", baseBare, mergeClone);
      await git(mergeClone, "config", "user.name", "Maintainer");
      await git(mergeClone, "config", "user.email", "maintainer@example.invalid");
      await git(mergeClone, "remote", "add", "fork", forkBare);
      await git(mergeClone, "fetch", "fork", branch);

      if (method === "merge")
        await git(mergeClone, "merge", "--no-ff", "FETCH_HEAD", "-m", "merge pull request");
      else if (method === "squash") {
        await git(mergeClone, "merge", "--squash", "FETCH_HEAD");
        await git(mergeClone, "commit", "-m", "squash pull request");
      } else await git(mergeClone, "cherry-pick", allocated.accepted);

      const merged = await git(mergeClone, "rev-parse", "HEAD");
      await writeFile(join(mergeClone, "current-base.txt"), `${method}\n`);
      await git(mergeClone, "add", "current-base.txt");
      await git(mergeClone, "commit", "-m", "advance current base");
      const currentBase = await git(mergeClone, "rev-parse", "HEAD");
      await git(mergeClone, "push", "origin", "main");
      await writeFile(response, JSON.stringify(facts("MERGED", merged)));

      // SAFETY: Successful registered delivery results expose the asserted compact state receipt.
      const completed = (await f.call("workgraph_deliver", { checkoutId: allocated.checkoutId }))
        .details as {
        state: { kind: string; mergedRevision: string; destinationRevision: string };
      };

      assert.equal(completed.state.kind, "complete");
      assert.equal(completed.state.mergedRevision, merged);
      assert.equal(completed.state.destinationRevision, currentBase);
      assert.equal(await git(f.root, "rev-parse", "HEAD"), currentBase);
      assert.equal(await readFile(join(f.root, `${method}.txt`), "utf8"), `${method}.txt\n`);
      assert.equal(await readFile(join(f.root, "current-base.txt"), "utf8"), `${method}\n`);
      await assert.rejects(git(f.root, "ls-remote", "--exit-code", "fork", allocated.ownedBranch));
      assert.equal(existsSync(allocated.managedPath), false);
    } finally {
      environment.PATH = priorPath;
      await f.dispose();
    }
  }
});

void test("local delivery refuses a destination collision without advancing or cleaning", async () => {
  const f = await fixture();

  try {
    // SAFETY: Successful registered checkout results expose the asserted compact receipt.
    const allocated = (await f.call("workgraph_checkout", {})).details as {
      checkoutId: string;
      managedPath: string;
      ownedBranch: string;
    };

    await writeFile(join(allocated.managedPath, "collision.txt"), "accepted\n");
    await git(allocated.managedPath, "add", "collision.txt");
    await git(allocated.managedPath, "commit", "-m", "accepted collision");
    const accepted = await git(allocated.managedPath, "rev-parse", "HEAD");
    const before = await git(f.root, "rev-parse", "HEAD");
    await writeFile(join(f.root, "collision.txt"), "local bytes\n");

    await assert.rejects(
      f.call("workgraph_deliver", {
        checkoutId: allocated.checkoutId,
        route: "local",
        revision: accepted,
      }),
    );
    assert.equal(await git(f.root, "rev-parse", "HEAD"), before);
    assert.equal(await readFile(join(f.root, "collision.txt"), "utf8"), "local bytes\n");
    assert.equal(existsSync(allocated.managedPath), true);
    assert.equal(await git(f.root, "rev-parse", "--verify", allocated.ownedBranch), accepted);

    // SAFETY: Successful registered inspection results expose the asserted compact state receipt.
    const inspected = (
      await f.call("workgraph_inspect", { section: "checkout", checkoutId: allocated.checkoutId })
    ).details as { state: { kind: string } };

    assert.equal(inspected.state.kind, "local_prepared");
  } finally {
    await f.dispose();
  }
});

void test("preserve retains an exact dirty owned checkout without changing bytes", async () => {
  const f = await fixture();

  try {
    // SAFETY: Successful registered checkout results expose the asserted compact receipt.
    const allocated = (await f.call("workgraph_checkout", {})).details as AllocatedCheckout;
    await writeFile(join(allocated.managedPath, "dirty.txt"), "dirty\n");
    const head = await git(allocated.managedPath, "rev-parse", "HEAD");

    // SAFETY: Successful registered delivery results expose the asserted compact state receipt.
    const preserved = (
      await f.call("workgraph_deliver", { checkoutId: allocated.checkoutId, route: "preserve" })
    ).details as { state: { kind: string; revision: string } };

    assert.deepEqual(preserved.state, { kind: "preserved", revision: head });
    assert.equal(await readFile(join(allocated.managedPath, "dirty.txt"), "utf8"), "dirty\n");
  } finally {
    await f.dispose();
  }
});

void test("local continuation recovers completed integration and interrupted cleanup from native state", async () => {
  for (const interruption of ["integration", "cleanup"] as const) {
    const f = await fixture();

    try {
      const allocated = await allocateAccepted(f, `${interruption}.txt`);
      const before = await git(f.root, "rev-parse", "HEAD");
      await git(f.root, "merge", "--ff-only", allocated.accepted);

      checkpoint(
        f,
        allocated,
        interruption === "integration"
          ? {
              kind: "local_prepared",
              acceptedRevision: allocated.accepted,
              destinationBefore: before,
              destinationRevision: allocated.accepted,
            }
          : {
              kind: "local_integrated",
              acceptedRevision: allocated.accepted,
              destinationRevision: allocated.accepted,
            },
      );

      if (interruption === "cleanup")
        await git(f.root, "worktree", "remove", allocated.managedPath);

      // SAFETY: Successful registered delivery results expose the asserted compact state receipt.
      const completed = (await f.call("workgraph_deliver", { checkoutId: allocated.checkoutId }))
        .details as { state: { kind: string } };

      assert.equal(completed.state.kind, "complete");
      assert.equal(existsSync(allocated.managedPath), false);
      await assert.rejects(git(f.root, "rev-parse", "--verify", allocated.ownedBranch));
    } finally {
      await f.dispose();
    }
  }
});

void test("local continuation preserves a later destination commit after integration response loss", async () => {
  const f = await fixture();

  try {
    const allocated = await allocateAccepted(f, "descendant.txt");
    const before = await git(f.root, "rev-parse", "HEAD");
    await git(f.root, "merge", "--ff-only", allocated.accepted);
    await writeFile(join(f.root, "later.txt"), "later\n");
    await git(f.root, "add", "later.txt");
    await git(f.root, "commit", "-m", "later destination commit");
    const later = await git(f.root, "rev-parse", "HEAD");

    checkpoint(f, allocated, {
      kind: "local_prepared",
      acceptedRevision: allocated.accepted,
      destinationBefore: before,
      destinationRevision: allocated.accepted,
    });

    // SAFETY: Successful registered delivery results expose the asserted compact state receipt.
    const completed = (await f.call("workgraph_deliver", { checkoutId: allocated.checkoutId }))
      .details as { state: { kind: string; destinationRevision: string } };

    assert.equal(completed.state.kind, "complete");
    assert.equal(completed.state.destinationRevision, later);
    assert.equal(await git(f.root, "rev-parse", "HEAD"), later);
    assert.equal(await readFile(join(f.root, "later.txt"), "utf8"), "later\n");
    assert.equal(existsSync(allocated.managedPath), false);
  } finally {
    await f.dispose();
  }
});

void test("cleanup waits for an unrelated current-session queued Worker then continues once settled", async () => {
  const f = await fixture();

  try {
    const allocated = await allocateAccepted(f, "gated.txt");
    await git(f.root, "merge", "--ff-only", allocated.accepted);
    checkpoint(f, allocated, {
      kind: "local_integrated",
      acceptedRevision: allocated.accepted,
      destinationRevision: allocated.accepted,
    });

    const store = new RecordStore(join(f.parent, "agent"), f.session.getSessionId());
    store.createTaskWithAttempt(
      "queued-global",
      {
        target: { kind: "directory", path: f.parent },
        contract: { kind: "research", question: "hold cleanup" },
      },
      "queued-global-attempt",
      {
        selection: { kind: "target", target: fixturePolicy.roles.research[0] },
        base: { kind: "directory" },
      },
    );

    await assert.rejects(
      f.call("workgraph_deliver", { checkoutId: allocated.checkoutId }),
      /active Worker or unresolved Candidate/u,
    );
    assert.equal(existsSync(allocated.managedPath), true);

    store.recordOutcome("queued-global-attempt", {
      result: { kind: "cancelled", reason: "fixture released" },
      effectiveModels: [],
    });
    store.close();

    // SAFETY: Successful registered delivery results expose the asserted compact state receipt.
    const completed = (await f.call("workgraph_deliver", { checkoutId: allocated.checkoutId }))
      .details as { state: { kind: string } };

    assert.equal(completed.state.kind, "complete");
  } finally {
    await f.dispose();
  }
});

void test("open and closed-unmerged pull requests continue as stable pending and retained states", async () => {
  const f = await fixture();
  // SAFETY: This only gives a name to the optional process PATH used by the bounded CLI fixture.
  const environment = process.env as NodeJS.ProcessEnv & { PATH: string | undefined };
  const priorPath = environment.PATH;

  try {
    await git(f.root, "remote", "add", "base", "https://github.com/base/repo.git");
    await git(f.root, "remote", "add", "fork", "https://github.com/fork/repo.git");
    const allocated = await allocateAccepted(f, "pending.txt");
    const branch = allocated.ownedBranch.slice("refs/heads/".length);
    const bin = join(f.parent, "bin");
    const response = join(f.parent, "gh-response.json");
    await mkdir(bin);
    await writeFile(join(bin, "gh"), `#!/bin/sh\ncat ${JSON.stringify(response)}\n`);
    await chmod(join(bin, "gh"), 0o700);
    environment.PATH = `${bin}:${priorPath ?? ""}`;
    const url = "https://github.com/base/repo/pull/9";

    const facts = (state: "OPEN" | "CLOSED", head = allocated.accepted) => ({
      url,
      state,
      headRefOid: head,
      headRefName: branch,
      headRepository: { nameWithOwner: "fork/repo" },
      baseRefName: "main",
      baseRepository: { nameWithOwner: "base/repo" },
      mergeCommit: null,
    });

    await writeFile(response, JSON.stringify(facts("OPEN")));
    await git(f.root, "config", "remote.fork.pushurl", "https://github.com/other/repo.git");
    await assert.rejects(
      f.call("workgraph_deliver", {
        checkoutId: allocated.checkoutId,
        route: "pull_request",
        revision: allocated.accepted,
        url,
        remote: "fork",
      }),
      /Publication remote/u,
    );
    await git(f.root, "config", "--unset-all", "remote.fork.pushurl");

    await f.call("workgraph_deliver", {
      checkoutId: allocated.checkoutId,
      route: "pull_request",
      revision: allocated.accepted,
      url,
      remote: "fork",
    });

    await writeFile(join(allocated.managedPath, "replacement.txt"), "replacement\n");
    await git(allocated.managedPath, "add", "replacement.txt");
    await git(allocated.managedPath, "commit", "-m", "replace open authorization");
    const replacement = await git(allocated.managedPath, "rev-parse", "HEAD");

    await writeFile(response, JSON.stringify(facts("OPEN", replacement)));

    // SAFETY: Successful registered delivery results expose the asserted compact state receipt.
    const replaced = (
      await f.call("workgraph_deliver", {
        checkoutId: allocated.checkoutId,
        route: "pull_request",
        revision: replacement,
        url,
        remote: "fork",
      })
    ).details as { state: { acceptedRevision: string; observation: string } };

    assert.equal(replaced.state.acceptedRevision, replacement);

    // SAFETY: Successful registered delivery results expose the asserted compact state receipt.
    const open = (await f.call("workgraph_deliver", { checkoutId: allocated.checkoutId }))
      .details as { state: { kind: string; observation: string } };

    assert.equal(open.state.observation, "open");

    await writeFile(response, JSON.stringify(facts("CLOSED", replacement)));

    // SAFETY: Successful registered delivery results expose the asserted compact state receipt.
    const closed = (await f.call("workgraph_deliver", { checkoutId: allocated.checkoutId }))
      .details as { state: { kind: string; observation: string } };

    assert.equal(closed.state.observation, "closed_unmerged");

    await writeFile(response, "not json");

    // SAFETY: Successful registered delivery results expose the asserted compact state receipt.
    const retained = (await f.call("workgraph_deliver", { checkoutId: allocated.checkoutId }))
      .details as { state: { kind: string; observation: string } };

    assert.deepEqual(retained.state, closed.state);
    assert.equal(existsSync(allocated.managedPath), true);
  } finally {
    environment.PATH = priorPath;
    await f.dispose();
  }
});

void test("pull-request cleanup blocks changed tips, source drift, and changed remote identities; absent tips recover", async () => {
  for (const scenario of [
    "changed-tip",
    "source-drift",
    "push-identity",
    "fetch-identity",
    "absent",
  ] as const) {
    const f = await fixture();

    try {
      const forkBare = join(f.parent, "fork.git");
      await git(f.parent, "init", "--bare", forkBare);
      await git(f.root, "remote", "add", "fork", "https://github.com/fork/repo.git");
      await git(f.root, "config", `url.${forkBare}.insteadOf`, "https://github.com/fork/repo.git");
      const allocated = await allocateAccepted(f, `${scenario}.txt`);
      const branch = allocated.ownedBranch.slice("refs/heads/".length);
      await git(
        allocated.managedPath,
        "push",
        "fork",
        `${allocated.ownedBranch}:${allocated.ownedBranch}`,
      );
      await git(f.root, "merge", "--ff-only", allocated.accepted);
      checkpoint(f, allocated, {
        kind: "pull_request_integrated",
        acceptedRevision: allocated.accepted,
        url: "https://github.com/base/repo/pull/11",
        remote: "fork",
        publicationRepository: "fork/repo",
        mergedRevision: allocated.accepted,
        headBranch: branch,
        destinationRevision: allocated.accepted,
      });

      if (scenario === "changed-tip") {
        const clone = join(f.parent, "changed-clone");
        await git(f.parent, "clone", forkBare, clone);
        await git(clone, "config", "user.name", "Changer");
        await git(clone, "config", "user.email", "changer@example.invalid");
        await git(clone, "checkout", branch);
        await writeFile(join(clone, "changed.txt"), "changed\n");
        await git(clone, "add", "changed.txt");
        await git(clone, "commit", "-m", "change published tip");
        await git(clone, "push", "origin", branch);
      } else if (scenario === "source-drift") {
        await writeFile(join(allocated.managedPath, "dirty.txt"), "dirty\n");
      } else if (scenario === "push-identity") {
        await git(f.root, "config", "remote.fork.pushurl", "https://github.com/other/repo.git");
      } else if (scenario === "fetch-identity") {
        await git(f.root, "config", "remote.fork.pushurl", "https://github.com/fork/repo.git");
        await git(f.root, "config", "remote.fork.url", "https://github.com/other/repo.git");
      } else {
        await git(f.root, "push", "fork", `:${allocated.ownedBranch}`);
      }

      if (scenario === "absent") {
        // SAFETY: Successful registered delivery results expose the asserted compact state receipt.
        const completed = (await f.call("workgraph_deliver", { checkoutId: allocated.checkoutId }))
          .details as { state: { kind: string } };

        assert.equal(completed.state.kind, "complete");
        assert.equal(existsSync(allocated.managedPath), false);
      } else {
        await assert.rejects(f.call("workgraph_deliver", { checkoutId: allocated.checkoutId }));
        assert.equal(existsSync(allocated.managedPath), true);
        assert.equal(
          await git(f.root, "--git-dir", forkBare, "rev-parse", "--verify", allocated.ownedBranch),
          scenario === "changed-tip"
            ? await git(f.root, "--git-dir", forkBare, "rev-parse", allocated.ownedBranch)
            : allocated.accepted,
        );
      }
    } finally {
      await f.dispose();
    }
  }
});
