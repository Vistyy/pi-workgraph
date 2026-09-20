import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureFixtureEnvironment, restoreFixtureEnvironment } from "../support/decoders.js";
import { extensionFixture, git } from "../support/helpers.js";

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

void test("pull-request delivery observes open then merged fork state, integrates current base, and deletes the exact published head", async () => {
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

    // SAFETY: Successful registered checkout results expose the asserted compact receipt.
    const allocated = (await f.call("workgraph_checkout", {})).details as {
      checkoutId: string;
      managedPath: string;
      ownedBranch: string;
    };

    await writeFile(join(allocated.managedPath, "pr.txt"), "pull request\n");
    await git(allocated.managedPath, "add", "pr.txt");
    await git(allocated.managedPath, "commit", "-m", "pull request change");
    const accepted = await git(allocated.managedPath, "rev-parse", "HEAD");
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
      headRefOid: accepted,
      headRefName: branch,
      headRepository: { nameWithOwner: "fork/repo" },
      baseRefName: "main",
      baseRepository: { nameWithOwner: "base/repo" },
      mergeCommit: merge === null ? null : { oid: merge },
    });

    await writeFile(response, JSON.stringify(facts("OPEN", null)));

    // SAFETY: Successful registered delivery results expose the asserted compact state receipt.
    const pending = (
      await f.call("workgraph_deliver", {
        checkoutId: allocated.checkoutId,
        route: "pull_request",
        revision: accepted,
        url,
        remote: "fork",
      })
    ).details as { state: { kind: string; observation: string } };

    assert.deepEqual(pending.state, {
      kind: "pull_request",
      acceptedRevision: accepted,
      url,
      remote: "fork",
      observation: "open",
    });

    const mergeClone = join(f.parent, "merge-clone");
    await git(f.parent, "clone", baseBare, mergeClone);
    await git(mergeClone, "config", "user.name", "Maintainer");
    await git(mergeClone, "config", "user.email", "maintainer@example.invalid");
    await git(mergeClone, "remote", "add", "fork", forkBare);
    await git(mergeClone, "fetch", "fork", branch);
    await git(mergeClone, "cherry-pick", accepted);
    const merged = await git(mergeClone, "rev-parse", "HEAD");
    await git(mergeClone, "push", "origin", "main");
    await writeFile(response, JSON.stringify(facts("MERGED", merged)));

    // SAFETY: Successful registered delivery results expose the asserted compact state receipt.
    const completed = (await f.call("workgraph_deliver", { checkoutId: allocated.checkoutId }))
      .details as {
      state: { kind: string; mergedRevision: string; destinationRevision: string };
    };

    assert.equal(completed.state.kind, "complete");
    assert.equal(completed.state.mergedRevision, merged);
    assert.equal(await git(f.root, "rev-parse", "HEAD"), completed.state.destinationRevision);
    assert.equal(await readFile(join(f.root, "pr.txt"), "utf8"), "pull request\n");
    await assert.rejects(git(f.root, "ls-remote", "--exit-code", "fork", allocated.ownedBranch));
    assert.equal(existsSync(allocated.managedPath), false);
  } finally {
    environment.PATH = priorPath;
    await f.dispose();
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
