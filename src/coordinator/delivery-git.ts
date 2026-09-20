import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect } from "effect";
import {
  ancestry,
  exactCommit,
  fail,
  filesystem,
  type GitError,
  git,
  gitDir,
  gitDirResult,
  gitDirWithOptions,
  gitResult,
} from "../repository/git.js";
import { observeAcceptedCheckout } from "./checkout-git.js";
import type { CheckoutDeliveryRecord, CheckoutDeliveryState } from "./delivery-state.js";
import type { PullRequestFacts } from "./github.js";

const NETWORK_TIMEOUT_MS = 30_000;

type PullRequestIntegrated = Extract<CheckoutDeliveryState, { kind: "pull_request_integrated" }>;

function destination(record: CheckoutDeliveryRecord) {
  return Effect.gen(function* () {
    if (record.sourcePath === record.managedPath)
      return yield* fail(
        "inspect delivery destination",
        "Managed checkout cannot be its own delivery destination.",
      );

    const path = yield* filesystem("inspect delivery destination", () =>
      realpath(record.sourcePath),
    );

    if (path !== record.sourcePath)
      return yield* fail(
        "inspect delivery destination",
        "Destination checkout path identity changed.",
      );

    const commonText = yield* git(record.sourcePath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);

    const common = yield* filesystem("inspect delivery destination", () =>
      realpath(resolve(record.sourcePath, commonText)),
    );

    if (common !== record.repositoryCommonDir)
      return yield* fail(
        "inspect delivery destination",
        "Destination repository identity changed.",
      );

    const ref = yield* git(record.sourcePath, ["symbolic-ref", "-q", "HEAD"]);

    if (ref !== record.destinationRef)
      return yield* fail("inspect delivery destination", "Destination ref changed.");

    return {
      head: yield* exactCommit(
        record.repositoryCommonDir,
        "HEAD",
        "inspect delivery destination",
        record.sourcePath,
      ),
    };
  });
}

export function prepareAdvancement(record: CheckoutDeliveryRecord, source: string) {
  return Effect.gen(function* () {
    const current = yield* destination(record);
    const revision = yield* advancementRevision(record, current.head, source);

    return { destinationBefore: current.head, destinationRevision: revision };
  });
}

function advancementRevision(
  record: CheckoutDeliveryRecord,
  destinationHead: string,
  source: string,
): Effect.Effect<string, GitError> {
  return Effect.gen(function* () {
    if (yield* ancestry(record.repositoryCommonDir, destinationHead, source)) return source;

    if (yield* ancestry(record.repositoryCommonDir, source, destinationHead))
      return destinationHead;

    const merge = yield* gitDirResult(record.repositoryCommonDir, [
      "merge-tree",
      "--write-tree",
      destinationHead,
      source,
    ]);

    if (merge.code !== 0 || merge.stdout.length === 0)
      return yield* fail(
        "prepare destination advancement",
        "Accepted change conflicts with the destination; nothing was mutated.",
      );

    const timestamp = yield* gitDir(record.repositoryCommonDir, [
      "show",
      "-s",
      "--format=%ct",
      destinationHead,
    ]);

    const environment = {
      ...globalThis.process.env,
      GIT_AUTHOR_NAME: "Workgraph",
      GIT_AUTHOR_EMAIL: "workgraph@example.invalid",
      GIT_AUTHOR_DATE: `${timestamp} +0000`,
      GIT_COMMITTER_NAME: "Workgraph",
      GIT_COMMITTER_EMAIL: "workgraph@example.invalid",
      GIT_COMMITTER_DATE: `${timestamp} +0000`,
    };

    return yield* gitDirWithOptions(
      record.repositoryCommonDir,
      [
        "commit-tree",
        merge.stdout,
        "-p",
        destinationHead,
        "-p",
        source,
        "-m",
        `Integrate Workgraph checkout ${record.checkoutId}`,
      ],
      { env: environment },
    );
  });
}

export function advanceDestination(
  record: CheckoutDeliveryRecord,
  state: { readonly destinationBefore: string; readonly destinationRevision: string },
) {
  return Effect.gen(function* () {
    const current = yield* destination(record);

    if (current.head === state.destinationRevision) return;

    if (current.head !== state.destinationBefore)
      return yield* fail(
        "advance delivery destination",
        "Destination changed after delivery preparation.",
      );

    const advancement = yield* gitResult(record.sourcePath, [
      "merge",
      "--ff-only",
      "--no-overwrite-ignore",
      state.destinationRevision,
    ]);

    if (advancement.code !== 0)
      return yield* fail(
        "advance delivery destination",
        advancement.stderr || advancement.stdout || "Git refused destination advancement.",
      );
    yield* proveDestination(record, state.destinationRevision);
  });
}

export function proveDestination(record: CheckoutDeliveryRecord, revision: string) {
  return Effect.gen(function* () {
    const current = yield* destination(record);

    if (current.head !== revision)
      return yield* fail(
        "prove destination integration",
        "Destination integration proof is absent.",
      );
  });
}

export function verifyPullRequest(
  record: CheckoutDeliveryRecord,
  remote: string,
  accepted: string,
  url: string,
  facts: PullRequestFacts,
) {
  return Effect.gen(function* () {
    if (facts.url !== url || facts.headRefOid !== accepted)
      return yield* fail(
        "verify pull request",
        "Pull request URL or accepted head SHA does not match.",
      );

    const owned = record.ownedBranch.slice("refs/heads/".length);

    if (facts.headRefName !== owned)
      return yield* fail(
        "verify pull request",
        "Pull request head is not the owned checkout branch.",
      );

    const publicationRepository = facts.headRepository.nameWithOwner.toLowerCase();
    yield* verifyRemoteRepository(record, remote, publicationRepository, true);
    const baseRepository = facts.baseRepository.nameWithOwner.toLowerCase();
    const names = (yield* git(record.sourcePath, ["remote"], true)).split("\n").filter(Boolean);
    const matches: string[] = [];

    for (const name of names) {
      const repositories = yield* remoteRepositories(record, name, false);

      if (repositories.length === 1 && repositories[0] === baseRepository) matches.push(name);
    }

    if (matches.length !== 1)
      return yield* fail(
        "verify pull request",
        "Exactly one configured fetch remote must identify the pull request base repository.",
      );

    const baseRemote = matches[0];

    if (baseRemote === undefined)
      return yield* fail("verify pull request", "Pull request base remote disappeared.");

    return { publicationRepository, baseRepository, baseRemote };
  });
}

export function prepareMergedPullRequest(
  record: CheckoutDeliveryRecord,
  baseRemote: string,
  baseRepository: string,
  baseBranch: string,
  mergedRevision: string,
) {
  return Effect.gen(function* () {
    yield* verifyRemoteRepository(record, baseRemote, baseRepository, false);

    const fetched = yield* gitResult(
      record.sourcePath,
      ["fetch", "--no-tags", baseRemote, `refs/heads/${baseBranch}`],
      { timeout: NETWORK_TIMEOUT_MS },
    );

    if (fetched.code !== 0)
      return yield* fail(
        "fetch pull request base",
        fetched.stderr || fetched.stdout || "Current pull request base could not be fetched.",
      );

    const currentBase = yield* exactCommit(
      record.repositoryCommonDir,
      "FETCH_HEAD",
      "inspect fetched pull request base",
      record.sourcePath,
    );

    if (!(yield* ancestry(record.repositoryCommonDir, mergedRevision, currentBase)))
      return yield* fail(
        "verify merged pull request",
        "Actual merged result is not contained in the current pull request base branch.",
      );

    return yield* prepareAdvancement(record, currentBase);
  });
}

export function deletePublishedHead(record: CheckoutDeliveryRecord, state: PullRequestIntegrated) {
  return Effect.gen(function* () {
    const branchRef = `refs/heads/${state.headBranch}`;
    let tip = yield* publishedTip(record, state.remote, branchRef);

    if (tip === undefined) return;
    yield* observeAcceptedCheckout(record, state.acceptedRevision);
    yield* verifyRemoteRepository(record, state.remote, state.publicationRepository, true);
    tip = yield* publishedTip(record, state.remote, branchRef);

    if (tip === undefined) return;

    if (tip !== state.acceptedRevision)
      return yield* fail(
        "delete published head",
        "Published head changed; remote branch was preserved.",
      );

    const deletion = yield* gitResult(
      record.sourcePath,
      [
        "push",
        `--force-with-lease=${branchRef}:${state.acceptedRevision}`,
        state.remote,
        `:${branchRef}`,
      ],
      { timeout: NETWORK_TIMEOUT_MS },
    );

    const remaining = yield* publishedTip(record, state.remote, branchRef);

    if (remaining === undefined) return;

    if (remaining !== state.acceptedRevision)
      return yield* fail(
        "delete published head",
        "Published head changed during deletion; resources were preserved.",
      );

    return yield* fail(
      "delete published head",
      deletion.stderr || deletion.stdout || "Published head deletion was not proven.",
    );
  });
}

function verifyRemoteRepository(
  record: CheckoutDeliveryRecord,
  remote: string,
  expected: string,
  push: boolean,
) {
  return remoteRepositories(record, remote, push).pipe(
    Effect.flatMap((repositories) => {
      if (repositories.length !== 1 || repositories[0] !== expected)
        return fail(
          "verify Git remote identity",
          `${push ? "Publication" : "Base fetch"} remote does not have one unambiguous GitHub repository identity.`,
        );

      return Effect.void;
    }),
  );
}

function remoteRepositories(record: CheckoutDeliveryRecord, remote: string, push: boolean) {
  return Effect.gen(function* () {
    let result = yield* gitResult(record.sourcePath, [
      "config",
      "--get-all",
      `remote.${remote}.${push ? "pushurl" : "url"}`,
    ]);

    if (push && result.code === 1)
      result = yield* gitResult(record.sourcePath, ["config", "--get-all", `remote.${remote}.url`]);

    if (result.code !== 0)
      return yield* fail(
        "verify Git remote identity",
        "Configured Git remote could not be resolved.",
      );

    return result.stdout.split("\n").filter(Boolean).map(githubRepository);
  });
}

function publishedTip(record: CheckoutDeliveryRecord, remote: string, branchRef: string) {
  return gitResult(record.sourcePath, ["ls-remote", "--heads", remote, branchRef], {
    timeout: NETWORK_TIMEOUT_MS,
  }).pipe(
    Effect.flatMap((result) => {
      if (result.code !== 0)
        return fail("inspect published head", "Published head tip could not be inspected.");

      // oxlint-disable-next-line effecttsgo/effect-succeed-with-void -- This branch inhabits the explicit optional-tip result.
      if (result.stdout.length === 0) return Effect.succeed<string | undefined>(undefined);
      const lines = result.stdout.split("\n");

      if (lines.length !== 1)
        return fail("inspect published head", "Published head identity is ambiguous.");
      const fields = lines[0]?.split(/\s+/u);

      if (fields?.length !== 2 || fields[1] !== branchRef)
        return fail("inspect published head", "Published head response is malformed.");

      return Effect.succeed<string | undefined>(fields[0]);
    }),
  );
}

function githubRepository(url: string): string | undefined {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/iu.exec(
    url.trim(),
  );

  return match?.[1]?.toLowerCase();
}
