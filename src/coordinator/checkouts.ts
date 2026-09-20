/* oxlint-disable effecttsgo/async-function, anti-slop/require-readable-spacing -- This module is the thin Promise boundary around repository-owned Effects. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { type CheckoutRecord, CommitSchema } from "../domain/records.js";
import {
  applyCoordinatorAdvancement,
  type CoordinatorAdvancement,
  type CoordinatorCheckoutIdentity,
  configuredRemoteUrl,
  coordinatorCheckoutHead,
  coordinatorSourceFacts,
  deleteCoordinatorBranch,
  deleteRemoteBranchExpected,
  ensureCoordinatorCheckout,
  fetchRemoteBranch,
  prepareCoordinatorAdvancement,
  remoteBranchTip,
  removeCoordinatorWorktree,
  requireAcceptedCoordinatorSource,
  requireCoordinatorCheckoutAbsent,
  requireRemoteContains,
  retryCoordinatorAdvancement,
  verifyCoordinatorAdvancement,
} from "../repository.js";
import type { RecordStore } from "./store.js";

export interface CheckoutFacts {
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
  readonly lifecycle: CheckoutRecord["disposition"];
  readonly diagnostic?: string;
}

type Identity = CoordinatorCheckoutIdentity & { readonly checkoutId: string };

type LocalDisposition = Extract<CheckoutRecord["disposition"], { kind: "local" }>;
type PullRequestDisposition = Extract<CheckoutRecord["disposition"], { kind: "pull_request" }>;

type Destination = { readonly cwd: string; readonly ref: string };
type PullRequestUrlIdentity = {
  readonly host: string;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
};
type GitHubRepositoryIdentity = Omit<PullRequestUrlIdentity, "number">;

const GitHubPullResponseSchema = Type.Object(
  {
    html_url: Type.String({ minLength: 1 }),
    number: Type.Integer({ minimum: 1 }),
    state: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
    merged: Type.Boolean(),
    merge_commit_sha: Type.Union([Type.Null(), CommitSchema]),
    head: Type.Object(
      {
        sha: CommitSchema,
        ref: Type.String({ minLength: 1 }),
        repo: Type.Object(
          {
            name: Type.String({ minLength: 1 }),
            owner: Type.Object(
              { login: Type.String({ minLength: 1 }) },
              { additionalProperties: true },
            ),
          },
          { additionalProperties: true },
        ),
      },
      { additionalProperties: true },
    ),
    base: Type.Object(
      {
        ref: Type.String({ minLength: 1 }),
        repo: Type.Object(
          {
            name: Type.String({ minLength: 1 }),
            owner: Type.Object(
              { login: Type.String({ minLength: 1 }) },
              { additionalProperties: true },
            ),
          },
          { additionalProperties: true },
        ),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);
type GitHubPullResponse = Static<typeof GitHubPullResponseSchema>;

export interface PullRequestFacts {
  readonly url: string;
  readonly number: number;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly mergeCommitSha?: string;
  readonly headSha: string;
  readonly headBranch: string;
  readonly headOwner: string;
  readonly headRepository: string;
  readonly baseBranch: string;
  readonly baseOwner: string;
  readonly baseRepository: string;
}

export interface GitHubReader {
  readonly readPullRequest: (url: string) => Promise<PullRequestFacts>;
}

const executeFile = promisify(execFile);

/** Explicit allocation checkpoints identity only after proving absent or adopting a recorded resource. */
export async function createCheckout(input: {
  readonly agentDir: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly path?: string;
  readonly store: RecordStore;
}): Promise<CheckoutFacts> {
  const source = await Effect.runPromise(coordinatorSourceFacts(input.cwd, input.path));
  const identity = await checkoutIdentity(input.agentDir, input.sessionId, source.target.commonDir);
  const prior = input.store.readCheckout(source.target.commonDir);

  if (prior !== undefined && prior.disposition.kind !== "complete") {
    const receipt = await Effect.runPromise(
      ensureCoordinatorCheckout({
        target: source.target,
        commit: prior.sourceHead,
        identity,
        recoverCheckpointedBranch: prior.disposition.kind === "creating",
      }),
    );

    if (prior.disposition.kind === "creating" && receipt.head !== prior.sourceHead)
      throw new Error("Interrupted checkout creation does not match its recorded source HEAD.");

    if (prior.disposition.kind !== "creating") return facts(prior, receipt);
    const active = input.store.checkpointCheckout({
      ...prior,
      disposition: { kind: "active", head: receipt.head },
    });

    return facts(active, receipt);
  }

  await Effect.runPromise(requireCoordinatorCheckoutAbsent(identity));

  const creatingBase = {
    ...identity,
    sourceCheckoutRoot: source.target.checkoutRoot,
    sourceHead: source.head,
    disposition: { kind: "creating" as const },
  };

  const creating: CheckoutRecord =
    source.ref === undefined ? creatingBase : { ...creatingBase, sourceRef: source.ref };

  input.store.checkpointCheckout(creating);

  const receipt = await Effect.runPromise(
    ensureCoordinatorCheckout({
      target: source.target,
      commit: source.head,
      identity,
      recoverCheckpointedBranch: true,
    }),
  );

  const active = input.store.checkpointCheckout({
    ...creating,
    disposition: { kind: "active", head: receipt.head },
  });

  return facts(active, receipt);
}

export type DeliverInput =
  | { readonly checkoutId: string; readonly route: "preserve" }
  | {
      readonly checkoutId: string;
      readonly route: "local";
      readonly revision: string;
      readonly destination?: Destination;
    }
  | {
      readonly checkoutId: string;
      readonly route: "pull_request";
      readonly revision: string;
      readonly url: string;
      readonly remote: string;
      readonly baseRemote?: string;
      readonly destination?: Destination;
    }
  | { readonly checkoutId: string };

export async function deliverCheckout(input: {
  readonly request: DeliverInput;
  readonly store: RecordStore;
  readonly blockCleanup: () => string | undefined;
  readonly github?: GitHubReader;
}): Promise<CheckoutRecord> {
  const record = input.store
    .listCheckouts()
    .find(({ checkoutId }) => checkoutId === input.request.checkoutId);

  if (record === undefined)
    throw new Error("Coordinator checkout record is absent in this session.");
  if ("route" in input.request && input.request.route === "preserve")
    return preserveCheckout(record, input.store);
  if (record.disposition.kind === "complete") return record;

  if ("route" in input.request && input.request.route === "local") {
    const selected = await selectLocal(record, input.request, input.store);

    return continueLocal(selected, input.store, input.blockCleanup);
  }
  if ("route" in input.request && input.request.route === "pull_request") {
    const selected = await selectPullRequest(
      record,
      input.request,
      input.store,
      input.github ?? nativeGitHubReader,
    );

    return continuePullRequest(selected, input.store, input.blockCleanup, input.github);
  }
  if (record.disposition.kind === "local") {
    if (record.disposition.paused === true)
      throw new Error("Paused local delivery requires an explicit local route to resume.");

    return continueLocal(record, input.store, input.blockCleanup);
  }
  if (record.disposition.kind === "pull_request") {
    if (record.disposition.paused === true)
      throw new Error(
        "Paused pull-request delivery requires an explicit pull_request route to resume.",
      );

    return continuePullRequest(record, input.store, input.blockCleanup, input.github);
  }

  throw new Error("Resume requires an already-recorded disposition.");
}

async function continueLocal(
  record: CheckoutRecord,
  store: RecordStore,
  blockCleanup: () => string | undefined,
): Promise<CheckoutRecord> {
  let current = record;
  let local = requireLocal(current);

  if (local.integrated !== true) {
    const revision = await Effect.runPromise(
      applyCoordinatorAdvancement({
        identity: current,
        acceptedRevision: local.acceptedRevision,
        advancement: local,
      }),
    );

    if (revision !== local.preparedRevision)
      throw new Error("Integrated revision differs from the prepared revision.");
    current = store.checkpointCheckout({
      ...current,
      disposition: { ...local, integrated: true },
    });
    local = requireLocal(current);
  }

  const destinationRevision = await Effect.runPromise(
    verifyCoordinatorAdvancement({
      identity: current,
      acceptedRevision: local.acceptedRevision,
      advancement: local,
    }),
  );
  const blocker = blockCleanup();

  if (blocker !== undefined) throw new Error(`Cleanup blocked: ${blocker}`);
  current = await cleanupLocal(current, store);
  local = requireLocal(current);

  return store.checkpointCheckout({
    ...current,
    disposition: {
      kind: "complete",
      route: "local",
      revision: local.acceptedRevision,
      destinationRoot: local.destinationRoot,
      destinationRef: local.destinationRef,
      destinationRevision,
    },
  });
}

async function cleanupLocal(record: CheckoutRecord, store: RecordStore): Promise<CheckoutRecord> {
  let current = record;
  let local = requireLocal(current);

  if (local.cleanup === undefined) {
    current = store.checkpointCheckout({
      ...current,
      disposition: { ...local, cleanup: "worktree" },
    });
    local = requireLocal(current);
  }
  if (local.cleanup === "worktree") {
    await Effect.runPromise(
      removeCoordinatorWorktree({ identity: current, expectedTip: local.acceptedRevision }),
    );
    current = store.checkpointCheckout({
      ...current,
      disposition: { ...local, cleanup: "branch" },
    });
    local = requireLocal(current);
  }
  await Effect.runPromise(
    deleteCoordinatorBranch({ identity: current, expectedTip: local.acceptedRevision }),
  );

  return current;
}

async function preserveCheckout(
  record: CheckoutRecord,
  store: RecordStore,
): Promise<CheckoutRecord> {
  if (record.disposition.kind === "complete") return record;
  if (record.disposition.kind === "local" || record.disposition.kind === "pull_request")
    return store.checkpointCheckout({
      ...record,
      disposition: { ...record.disposition, paused: true },
    });
  if (record.disposition.kind !== "active" && record.disposition.kind !== "preserved")
    throw new Error("Checkout cannot be preserved from its current lifecycle state.");
  const head = await Effect.runPromise(coordinatorCheckoutHead(record));

  return store.checkpointCheckout({ ...record, disposition: { kind: "preserved", head } });
}

async function selectLocal(
  record: CheckoutRecord,
  request: Extract<DeliverInput, { route: "local" }>,
  store: RecordStore,
): Promise<CheckoutRecord> {
  if (record.disposition.kind === "active" || record.disposition.kind === "preserved") {
    const destination = request.destination ?? defaultDestination(record);
    const prepared = await Effect.runPromise(
      prepareCoordinatorAdvancement({
        identity: record,
        acceptedRevision: request.revision,
        destinationRoot: destination.cwd,
        destinationRef: destination.ref,
      }),
    );

    return store.checkpointCheckout({
      ...record,
      disposition: { kind: "local", acceptedRevision: request.revision, ...prepared },
    });
  }
  if (record.disposition.kind !== "local")
    throw new Error("A local route cannot replace the recorded pull-request route.");
  if (request.revision !== record.disposition.acceptedRevision)
    throw new Error("Local resume must keep the exact accepted revision.");
  if (
    request.destination !== undefined &&
    (request.destination.cwd !== record.disposition.destinationRoot ||
      request.destination.ref !== record.disposition.destinationRef)
  )
    throw new Error("Local resume must keep the exact authorized destination.");
  const { paused, ...resumed } = record.disposition;

  if (paused === true || record.disposition.integrated === true)
    return store.checkpointCheckout({ ...record, disposition: resumed });
  const prepared = await Effect.runPromise(
    retryCoordinatorAdvancement({
      identity: record,
      acceptedRevision: record.disposition.acceptedRevision,
      advancement: record.disposition,
    }),
  );

  return store.checkpointCheckout({
    ...record,
    disposition: { ...resumed, ...prepared },
  });
}

function requireLocal(record: CheckoutRecord): LocalDisposition {
  if (record.disposition.kind !== "local") throw new Error("Local disposition is absent.");

  return record.disposition;
}

async function selectPullRequest(
  record: CheckoutRecord,
  request: Extract<DeliverInput, { route: "pull_request" }>,
  store: RecordStore,
  github: GitHubReader,
): Promise<CheckoutRecord> {
  const destination = request.destination ?? defaultDestination(record);
  const prior = record.disposition.kind === "pull_request" ? record.disposition : undefined;
  validatePullRequestSelection(record, request, prior);
  const pr = await github.readPullRequest(request.url);
  const binding = await verifyPullRequestBinding({
    record,
    request,
    pr,
    destination:
      prior === undefined
        ? destination
        : {
            cwd: prior.destinationRoot,
            ref: prior.destinationRef,
          },
  });

  return store.checkpointCheckout({
    ...record,
    disposition: retainPullRequestProgress(binding, prior),
  });
}

function validatePullRequestSelection(
  record: CheckoutRecord,
  request: Extract<DeliverInput, { route: "pull_request" }>,
  prior: PullRequestDisposition | undefined,
): void {
  if (
    record.disposition.kind !== "active" &&
    record.disposition.kind !== "preserved" &&
    prior === undefined
  )
    throw new Error("A pull-request route cannot replace the recorded local route.");
  if (
    prior !== undefined &&
    (request.url !== prior.url ||
      request.remote !== prior.remote ||
      (request.baseRemote ?? request.remote) !== prior.baseRemote)
  )
    throw new Error("Pull-request resume cannot rebind the recorded PR or remotes.");
  if (
    prior !== undefined &&
    request.destination !== undefined &&
    (request.destination.cwd !== prior.destinationRoot ||
      request.destination.ref !== prior.destinationRef)
  )
    throw new Error("Pull-request resume must keep the exact authorized destination.");
  if (
    (prior?.integrated === true || prior?.mergedRevision !== undefined) &&
    request.revision !== prior.acceptedRevision
  )
    throw new Error("Merged pull-request delivery cannot change its accepted revision.");
}

function retainPullRequestProgress(
  binding: PullRequestDisposition,
  prior: PullRequestDisposition | undefined,
): PullRequestDisposition {
  if (prior === undefined) return binding;
  let retained = binding;

  if (prior.mergedRevision !== undefined)
    retained = { ...retained, mergedRevision: prior.mergedRevision };
  if (prior.remoteBaseRevision !== undefined)
    retained = { ...retained, remoteBaseRevision: prior.remoteBaseRevision };
  if (prior.destinationHead !== undefined)
    retained = { ...retained, destinationHead: prior.destinationHead };
  if (prior.preparedRevision !== undefined)
    retained = { ...retained, preparedRevision: prior.preparedRevision };
  if (prior.integrated !== undefined) retained = { ...retained, integrated: true };
  if (prior.cleanup !== undefined) retained = { ...retained, cleanup: prior.cleanup };

  return retained;
}

async function verifyPullRequestBinding(input: {
  readonly record: CheckoutRecord;
  readonly request: Extract<DeliverInput, { route: "pull_request" }>;
  readonly pr: PullRequestFacts;
  readonly destination: Destination;
}): Promise<PullRequestDisposition> {
  const parsed = parsePullRequestUrl(input.request.url);
  await Effect.runPromise(requireAcceptedCoordinatorSource(input.record, input.request.revision));

  if (
    input.pr.url !== input.request.url ||
    input.pr.number !== parsed.number ||
    input.pr.baseOwner !== parsed.owner ||
    input.pr.baseRepository !== parsed.repository
  )
    throw new Error("GitHub response does not match the exact requested pull request.");
  if (input.pr.headSha !== input.request.revision)
    throw new Error("Pull-request head does not match the accepted revision.");
  const ownedBranch = input.record.ownedBranch.slice("refs/heads/".length);

  if (input.pr.headBranch !== ownedBranch)
    throw new Error("Pull-request head branch is not the owned published branch.");
  const baseRemote = input.request.baseRemote ?? input.request.remote;
  const [remoteUrl, baseRemoteUrl] = await Promise.all([
    Effect.runPromise(
      configuredRemoteUrl({ identity: input.record, remote: input.request.remote }),
    ),
    Effect.runPromise(configuredRemoteUrl({ identity: input.record, remote: baseRemote })),
  ]);
  const headIdentity = parseGitHubRemote(remoteUrl);
  const baseIdentity = parseGitHubRemote(baseRemoteUrl);

  if (
    headIdentity.host !== parsed.host ||
    headIdentity.owner !== input.pr.headOwner ||
    headIdentity.repository !== input.pr.headRepository
  )
    throw new Error("Publication remote does not identify the pull-request head repository.");
  if (
    baseIdentity.host !== parsed.host ||
    baseIdentity.owner !== input.pr.baseOwner ||
    baseIdentity.repository !== input.pr.baseRepository
  )
    throw new Error("Base remote does not identify the pull-request base repository.");

  return {
    kind: "pull_request",
    acceptedRevision: input.request.revision,
    url: input.request.url,
    host: parsed.host,
    repositoryOwner: parsed.owner,
    repositoryName: parsed.repository,
    number: parsed.number,
    baseBranch: input.pr.baseBranch,
    headOwner: input.pr.headOwner,
    headRepository: input.pr.headRepository,
    headBranch: input.pr.headBranch,
    remote: input.request.remote,
    remoteUrl,
    baseRemote,
    baseRemoteUrl,
    destinationRoot: input.destination.cwd,
    destinationRef: input.destination.ref,
  };
}

async function continuePullRequest(
  record: CheckoutRecord,
  store: RecordStore,
  blockCleanup: () => string | undefined,
  github?: GitHubReader,
): Promise<CheckoutRecord> {
  let current = record;
  let pr = requirePullRequest(current);
  const facts = await (github ?? nativeGitHubReader).readPullRequest(pr.url);
  await reverifyStoredPullRequest(current, pr, facts);

  if (!facts.merged) {
    if (facts.state === "closed")
      return store.checkpointCheckout({
        ...current,
        disposition: { ...pr, retained: "closed_unmerged", paused: true },
      });

    return current;
  }
  if (facts.mergeCommitSha === undefined)
    throw new Error("Merged pull request has no actual merge result.");
  if (pr.mergedRevision === undefined) {
    const remoteBaseRevision = await Effect.runPromise(
      fetchRemoteBranch({ identity: current, remote: pr.baseRemote, branch: pr.baseBranch }),
    );
    await Effect.runPromise(
      requireRemoteContains({
        identity: current,
        revision: facts.mergeCommitSha,
        remoteRevision: remoteBaseRevision,
      }),
    );
    const prepared = await Effect.runPromise(
      prepareCoordinatorAdvancement({
        identity: current,
        acceptedRevision: pr.acceptedRevision,
        integrationRevision: remoteBaseRevision,
        destinationRoot: pr.destinationRoot,
        destinationRef: pr.destinationRef,
      }),
    );
    current = store.checkpointCheckout({
      ...current,
      disposition: {
        ...pr,
        mergedRevision: facts.mergeCommitSha,
        remoteBaseRevision,
        ...prepared,
      },
    });
    pr = requirePullRequest(current);
  }
  const advancement = requirePullRequestAdvancement(pr);
  const integrationRevision = pr.remoteBaseRevision;

  if (integrationRevision === undefined)
    throw new Error("Pull-request remote base proof is absent.");
  if (pr.integrated !== true) {
    const revision = await Effect.runPromise(
      applyCoordinatorAdvancement({
        identity: current,
        acceptedRevision: pr.acceptedRevision,
        integrationRevision,
        advancement,
      }),
    );

    if (revision !== pr.preparedRevision)
      throw new Error("Integrated revision differs from the prepared pull-request revision.");
    current = store.checkpointCheckout({
      ...current,
      disposition: { ...pr, integrated: true },
    });
    pr = requirePullRequest(current);
  }
  const destinationRevision = await Effect.runPromise(
    verifyCoordinatorAdvancement({
      identity: current,
      acceptedRevision: pr.acceptedRevision,
      integrationRevision,
      advancement: requirePullRequestAdvancement(pr),
    }),
  );
  await Effect.runPromise(requireAcceptedCoordinatorSource(current, pr.acceptedRevision));
  const blocker = blockCleanup();

  if (blocker !== undefined) throw new Error(`Cleanup blocked: ${blocker}`);
  if (pr.cleanup === undefined) {
    current = store.checkpointCheckout({
      ...current,
      disposition: { ...pr, cleanup: "remote_branch" },
    });
    pr = requirePullRequest(current);
  }
  if (pr.cleanup === "remote_branch") {
    await Effect.runPromise(
      deleteRemoteBranchExpected({
        identity: current,
        remote: pr.remote,
        branch: pr.headBranch,
        expectedTip: pr.acceptedRevision,
      }),
    );
    current = store.checkpointCheckout({
      ...current,
      disposition: { ...pr, cleanup: "worktree" },
    });
    pr = requirePullRequest(current);
  }
  if (pr.cleanup === "worktree") {
    await Effect.runPromise(
      removeCoordinatorWorktree({ identity: current, expectedTip: pr.acceptedRevision }),
    );
    current = store.checkpointCheckout({
      ...current,
      disposition: { ...pr, cleanup: "branch" },
    });
    pr = requirePullRequest(current);
  }
  await Effect.runPromise(
    deleteCoordinatorBranch({ identity: current, expectedTip: pr.acceptedRevision }),
  );

  return store.checkpointCheckout({
    ...current,
    disposition: {
      kind: "complete",
      route: "pull_request",
      revision: pr.acceptedRevision,
      destinationRoot: pr.destinationRoot,
      destinationRef: pr.destinationRef,
      destinationRevision,
      url: pr.url,
    },
  });
}

async function reverifyStoredPullRequest(
  record: CheckoutRecord,
  pr: PullRequestDisposition,
  facts: PullRequestFacts,
): Promise<void> {
  if (
    facts.url !== pr.url ||
    facts.number !== pr.number ||
    facts.headSha !== pr.acceptedRevision ||
    facts.headBranch !== pr.headBranch ||
    facts.headOwner !== pr.headOwner ||
    facts.headRepository !== pr.headRepository ||
    facts.baseOwner !== pr.repositoryOwner ||
    facts.baseRepository !== pr.repositoryName ||
    facts.baseBranch !== pr.baseBranch
  )
    throw new Error("Pull-request identity or accepted head changed.");
  const [remoteUrl, baseRemoteUrl] = await Promise.all([
    Effect.runPromise(configuredRemoteUrl({ identity: record, remote: pr.remote })),
    Effect.runPromise(configuredRemoteUrl({ identity: record, remote: pr.baseRemote })),
  ]);

  if (remoteUrl !== pr.remoteUrl || baseRemoteUrl !== pr.baseRemoteUrl)
    throw new Error("Recorded pull-request remote identity changed.");
  const tip = await Effect.runPromise(
    remoteBranchTip({ identity: record, remote: pr.remote, branch: pr.headBranch }),
  );

  if (!facts.merged && tip !== pr.acceptedRevision)
    throw new Error("Published branch no longer has the accepted revision.");
}

function requirePullRequest(record: CheckoutRecord): PullRequestDisposition {
  if (record.disposition.kind !== "pull_request")
    throw new Error("Pull-request disposition is absent.");

  return record.disposition;
}

function requirePullRequestAdvancement(pr: PullRequestDisposition): CoordinatorAdvancement {
  if (
    pr.destinationHead === undefined ||
    pr.preparedRevision === undefined ||
    pr.remoteBaseRevision === undefined
  )
    throw new Error("Pull-request integration preparation is incomplete.");

  return {
    destinationRoot: pr.destinationRoot,
    destinationRef: pr.destinationRef,
    destinationHead: pr.destinationHead,
    preparedRevision: pr.preparedRevision,
  };
}

function defaultDestination(record: CheckoutRecord): Destination {
  if (record.sourceRef === undefined)
    throw new Error("Original source was detached; an explicit attached destination is required.");

  return { cwd: record.sourceCheckoutRoot, ref: record.sourceRef };
}

function facts(
  record: CheckoutRecord,
  receipt: { head: string; created: boolean; reused: boolean; diagnostic?: string },
): CheckoutFacts {
  const base = {
    checkoutId: record.checkoutId,
    managedPath: record.managedPath,
    repositoryCommonDir: record.repositoryCommonDir,
    ownedBranch: record.ownedBranch,
    head: receipt.head,
    created: receipt.created,
    reused: receipt.reused,
    sourceCheckoutRoot: record.sourceCheckoutRoot,
    sourceHead: record.sourceHead,
    lifecycle: record.disposition,
  };

  const withSource =
    record.sourceRef === undefined ? base : { ...base, sourceRef: record.sourceRef };

  return receipt.diagnostic === undefined
    ? withSource
    : { ...withSource, diagnostic: receipt.diagnostic };
}

function parsePullRequestUrl(url: string): PullRequestUrlIdentity {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Pull-request URL is invalid.");
  }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/u.exec(parsed.pathname);

  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    match?.[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  )
    throw new Error("Pull-request URL must be an exact GitHub HTTPS pull URL.");

  return {
    host: parsed.hostname.toLowerCase(),
    owner: match[1],
    repository: match[2],
    number: Number(match[3]),
  };
}

function parseGitHubRemote(url: string): GitHubRepositoryIdentity {
  const scp = /^(?:[^@]+@)?([^:]+):([^/]+)\/(.+)$/u.exec(url);
  let host: string;
  let path: string;

  if (scp?.[1] !== undefined && scp[2] !== undefined && scp[3] !== undefined) {
    host = scp[1];
    path = `${scp[2]}/${scp[3]}`;
  } else {
    let parsed: URL;

    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Configured remote is not a GitHub repository URL.");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:")
      throw new Error("Configured remote must use GitHub HTTPS or SSH identity.");
    host = parsed.hostname;
    path = parsed.pathname.replace(/^\//u, "");
  }
  const parts = path.replace(/\.git$/u, "").split("/");

  const owner = parts[0];
  const repository = parts[1];

  if (
    parts.length !== 2 ||
    owner === undefined ||
    repository === undefined ||
    owner.length === 0 ||
    repository.length === 0
  )
    throw new Error("Configured remote repository identity is ambiguous.");

  return { host: host.toLowerCase(), owner, repository };
}

const nativeGitHubReader: GitHubReader = {
  async readPullRequest(url) {
    const parsed = parsePullRequestUrl(url);
    let stdout: string;

    try {
      ({ stdout } = await executeFile(
        "gh",
        [
          "api",
          "--hostname",
          parsed.host,
          `/repos/${parsed.owner}/${parsed.repository}/pulls/${parsed.number}`,
        ],
        { encoding: "utf8", timeout: 30_000, maxBuffer: 1_000_000 },
      ));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "GitHub CLI failed.";
      throw new Error(`Unable to read pull request with gh: ${message}`);
    }
    let value: unknown;

    try {
      value = JSON.parse(stdout);
    } catch {
      throw new Error("GitHub CLI returned invalid JSON.");
    }

    if (!Value.Check(GitHubPullResponseSchema, value))
      throw new Error("GitHub response does not match the required pull-request fields.");
    const pr: GitHubPullResponse = Value.Decode(GitHubPullResponseSchema, value);
    const facts: PullRequestFacts = {
      url: pr.html_url,
      number: pr.number,
      state: pr.state,
      merged: pr.merged,
      headSha: pr.head.sha,
      headBranch: pr.head.ref,
      headOwner: pr.head.repo.owner.login,
      headRepository: pr.head.repo.name,
      baseBranch: pr.base.ref,
      baseOwner: pr.base.repo.owner.login,
      baseRepository: pr.base.repo.name,
    };

    return pr.merged && pr.merge_commit_sha !== null
      ? { ...facts, mergeCommitSha: pr.merge_commit_sha }
      : facts;
  },
};

async function checkoutIdentity(
  agentDir: string,
  sessionId: string,
  commonDir: string,
): Promise<Identity> {
  const canonicalAgentDir = await realpath(agentDir);

  const checkoutId = createHash("sha256")
    .update(JSON.stringify([sessionId, commonDir]))
    .digest("hex");

  return {
    checkoutId,
    managedPath: join(canonicalAgentDir, "workgraph", "coordinator-checkouts", checkoutId),
    repositoryCommonDir: commonDir,
    ownedBranch: `refs/heads/pi-workgraph/coordinators/${checkoutId}`,
  };
}
