/* oxlint-disable effecttsgo/async-function -- This module is the native Git Promise boundary for explicit delivery calls. */
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { CheckoutDeliveryRecord, CheckoutDeliveryState } from "./delivery-state.js";
import type { PullRequestFacts } from "./github.js";

const exec = promisify(execFile);

const CommandFailureSchema = Type.Object(
  {
    code: Type.Integer(),
    stdout: Type.Optional(Type.String()),
    stderr: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export async function acceptedCheckout(
  record: CheckoutDeliveryRecord,
  requested: string | undefined,
): Promise<string> {
  const common = await git(
    record.managedPath,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );

  if ((await realpath(resolve(record.managedPath, common))) !== record.repositoryCommonDir)
    throw new Error("Managed checkout repository identity changed.");

  if ((await git(record.managedPath, "symbolic-ref", "-q", "HEAD")) !== record.ownedBranch)
    throw new Error("Managed checkout is not attached to its owned branch.");
  const head = await git(record.managedPath, "rev-parse", "--verify", "HEAD^{commit}");

  if (requested !== undefined && head !== requested)
    throw new Error("Accepted revision is not the exact managed checkout HEAD.");

  if (
    (
      await git(
        record.managedPath,
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--ignored=matching",
      )
    ).length > 0
  )
    throw new Error("Accepted managed checkout is not clean.");

  return head;
}

async function destination(record: CheckoutDeliveryRecord) {
  if (record.sourcePath === record.managedPath)
    throw new Error("Managed checkout cannot be its own delivery destination.");

  if ((await realpath(record.sourcePath)) !== record.sourcePath)
    throw new Error("Destination checkout path identity changed.");

  const common = await git(
    record.sourcePath,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );

  if ((await realpath(resolve(record.sourcePath, common))) !== record.repositoryCommonDir)
    throw new Error("Destination repository identity changed.");
  const ref = await git(record.sourcePath, "symbolic-ref", "-q", "HEAD");

  if (ref !== record.destinationRef) throw new Error("Destination ref changed.");

  return { ref, head: await git(record.sourcePath, "rev-parse", "--verify", "HEAD^{commit}") };
}

export async function prepareAdvancement(record: CheckoutDeliveryRecord, source: string) {
  const current = await destination(record);
  const revision = await advancementRevision(record, current.head, source);

  return { destinationBefore: current.head, destinationRevision: revision };
}

async function advancementRevision(
  record: CheckoutDeliveryRecord,
  destinationHead: string,
  source: string,
): Promise<string> {
  if (await ancestor(record.repositoryCommonDir, destinationHead, source)) return source;

  if (await ancestor(record.repositoryCommonDir, source, destinationHead)) return destinationHead;
  let tree: string;

  try {
    tree = await gitDir(
      record.repositoryCommonDir,
      "merge-tree",
      "--write-tree",
      destinationHead,
      source,
    );
  } catch (cause) {
    throw new Error("Accepted change conflicts with the destination; nothing was mutated.", {
      cause,
    });
  }

  const timestamp = await gitDir(
    record.repositoryCommonDir,
    "show",
    "-s",
    "--format=%ct",
    destinationHead,
  );

  const environment = {
    ...process.env,
    GIT_AUTHOR_NAME: "Workgraph",
    GIT_AUTHOR_EMAIL: "workgraph@example.invalid",
    GIT_AUTHOR_DATE: `${timestamp} +0000`,
    GIT_COMMITTER_NAME: "Workgraph",
    GIT_COMMITTER_EMAIL: "workgraph@example.invalid",
    GIT_COMMITTER_DATE: `${timestamp} +0000`,
  };

  return gitDirEnv(
    record.repositoryCommonDir,
    environment,
    "commit-tree",
    tree,
    "-p",
    destinationHead,
    "-p",
    source,
    "-m",
    `Integrate Workgraph checkout ${record.checkoutId}`,
  );
}

export async function advanceDestination(
  record: CheckoutDeliveryRecord,
  state: { destinationBefore: string; destinationRevision: string },
) {
  const current = await destination(record);

  if (current.head === state.destinationRevision) return;

  if (current.head !== state.destinationBefore)
    throw new Error("Destination changed after delivery preparation.");
  await git(
    record.sourcePath,
    "merge",
    "--ff-only",
    "--no-overwrite-ignore",
    state.destinationRevision,
  );
  await proveDestination(record, state.destinationRevision);
}

export async function proveDestination(record: CheckoutDeliveryRecord, revision: string) {
  const current = await destination(record);

  if (current.head !== revision) throw new Error("Destination integration proof is absent.");
}

export async function verifyPullRequest(
  record: CheckoutDeliveryRecord,
  remote: string,
  accepted: string,
  url: string,
  facts: PullRequestFacts,
) {
  if (facts.url !== url || facts.headRefOid !== accepted)
    throw new Error("Pull request URL or accepted head SHA does not match.");
  const owned = record.ownedBranch.slice("refs/heads/".length);

  if (facts.headRefName !== owned)
    throw new Error("Pull request head is not the owned checkout branch.");
  const remotes = (await git(record.sourcePath, "remote")).split("\n").filter(Boolean);

  if (!remotes.includes(remote)) throw new Error("Publication remote is not configured.");

  const identities = await Promise.all(
    remotes.map(async (name) => ({
      name,
      repository: githubRepository(
        await git(record.sourcePath, "config", "--get", `remote.${name}.url`),
      ),
    })),
  );

  const publication = identities.find((value) => value.name === remote);

  if (publication?.repository !== facts.headRepository.nameWithOwner.toLowerCase())
    throw new Error("Publication remote does not identify the pull request head repository.");

  const baseMatches = identities.filter(
    (value) => value.repository === facts.baseRepository.nameWithOwner.toLowerCase(),
  );

  if (baseMatches.length !== 1)
    throw new Error(
      "Exactly one configured remote must identify the pull request base repository.",
    );

  const base = baseMatches[0];

  if (base === undefined) throw new Error("Pull request base remote disappeared.");

  return { baseRemote: base.name };
}

export async function prepareMergedPullRequest(
  record: CheckoutDeliveryRecord,
  baseRemote: string,
  baseBranch: string,
  mergedRevision: string,
) {
  await git(record.sourcePath, "fetch", "--no-tags", baseRemote, `refs/heads/${baseBranch}`);
  const currentBase = await git(record.sourcePath, "rev-parse", "--verify", "FETCH_HEAD^{commit}");

  if (!(await ancestor(record.repositoryCommonDir, mergedRevision, currentBase)))
    throw new Error(
      "Actual merged result is not contained in the current pull request base branch.",
    );

  return prepareAdvancement(record, currentBase);
}

export async function deletePublishedHead(
  record: CheckoutDeliveryRecord,
  state: Extract<CheckoutDeliveryState, { kind: "integrated" }>,
) {
  if (state.remote === undefined || state.headBranch === undefined)
    throw new Error("Published head deletion proof is incomplete.");

  const result = await gitResult(
    record.sourcePath,
    "ls-remote",
    "--heads",
    state.remote,
    `refs/heads/${state.headBranch}`,
  );

  if (result.code !== 0) throw new Error("Published head tip could not be inspected.");

  if (result.stdout.length === 0) return;
  const fields = result.stdout.split(/\s+/u);

  if (fields[0] !== state.acceptedRevision || fields[1] !== `refs/heads/${state.headBranch}`)
    throw new Error("Published head changed; remote branch was preserved.");
  await git(
    record.sourcePath,
    "push",
    `--force-with-lease=refs/heads/${state.headBranch}:${state.acceptedRevision}`,
    state.remote,
    `:refs/heads/${state.headBranch}`,
  );
}

export async function cleanupLocal(record: CheckoutDeliveryRecord, accepted: string) {
  const pathEntry = await lstat(record.managedPath).catch((cause: unknown) =>
    isMissing(cause) ? undefined : Promise.reject(cause),
  );

  const registrations = await gitDir(
    record.repositoryCommonDir,
    "worktree",
    "list",
    "--porcelain",
    "-z",
  );

  const pathRegistered = registrations.includes(`worktree ${record.managedPath}\0`);
  const branchRegistered = registrations.includes(`branch ${record.ownedBranch}\0`);

  const branch = await gitResultDir(
    record.repositoryCommonDir,
    "rev-parse",
    "--verify",
    "--quiet",
    `${record.ownedBranch}^{commit}`,
  );

  const branchTip = branch.code === 0 ? branch.stdout : undefined;

  if (pathEntry !== undefined || pathRegistered || branchRegistered) {
    if (pathEntry === undefined || !pathRegistered || !branchRegistered)
      throw new Error("Owned checkout cleanup resources are partial or unexpected.");
    await acceptedCheckout(record, accepted);
    await git(record.sourcePath, "worktree", "remove", record.managedPath);
  }

  if (branchTip !== undefined && branchTip !== accepted)
    throw new Error("Owned checkout branch changed; it was preserved.");

  if (branchTip === accepted)
    await gitDir(record.repositoryCommonDir, "update-ref", "-d", record.ownedBranch, accepted);

  const afterPath = await lstat(record.managedPath).catch((cause: unknown) =>
    isMissing(cause) ? undefined : Promise.reject(cause),
  );

  const afterBranch = await gitResultDir(
    record.repositoryCommonDir,
    "rev-parse",
    "--verify",
    "--quiet",
    record.ownedBranch,
  );

  if (afterPath !== undefined || afterBranch.code === 0)
    throw new Error("Owned checkout cleanup postcondition is absent.");
}

function githubRepository(url: string): string | undefined {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/iu.exec(
    url.trim(),
  );

  return match?.[1]?.toLowerCase();
}

async function ancestor(commonDir: string, parent: string, child: string) {
  const result = await gitResultDir(commonDir, "merge-base", "--is-ancestor", parent, child);

  if (result.code === 0) return true;

  if (result.code === 1) return false;
  throw new Error("Git ancestry could not be inspected.");
}

async function git(cwd: string, ...args: string[]) {
  return (await run(["-C", cwd, ...args])).stdout;
}

async function gitDir(commonDir: string, ...args: string[]) {
  return (await run([`--git-dir=${commonDir}`, ...args])).stdout;
}

async function gitDirEnv(commonDir: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return (await run([`--git-dir=${commonDir}`, ...args], env)).stdout;
}

async function gitResult(cwd: string, ...args: string[]) {
  return runResult(["-C", cwd, ...args]);
}

async function gitResultDir(commonDir: string, ...args: string[]) {
  return runResult([`--git-dir=${commonDir}`, ...args]);
}

async function run(args: string[], env?: NodeJS.ProcessEnv) {
  const result = await runResult(args, env);

  if (result.code !== 0)
    throw new Error(result.stderr || result.stdout || `Git ${args.join(" ")} failed.`);

  return result;
}

async function runResult(args: string[], env?: NodeJS.ProcessEnv) {
  try {
    const result = await exec("git", args, { env });

    return { code: 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (cause) {
    if (Value.Check(CommandFailureSchema, cause)) {
      const value = Value.Decode(CommandFailureSchema, cause);

      return {
        code: value.code,
        stdout: value.stdout?.trim() ?? "",
        stderr: value.stderr?.trim() ?? "",
      };
    }

    throw cause;
  }
}

function isMissing(cause: unknown) {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
