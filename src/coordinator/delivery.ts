/* oxlint-disable effecttsgo/async-function -- Registered tool execution is the Promise boundary around native Git and GitHub CLI effects. */

import {
  acceptedCheckout,
  advanceDestination,
  cleanupLocal,
  deletePublishedHead,
  prepareAdvancement,
  prepareMergedPullRequest,
  proveDestination,
  verifyPullRequest,
} from "./delivery-git.js";
import type { CheckoutDeliveryRecord, CheckoutDeliveryState } from "./delivery-state.js";
import { readPullRequest } from "./github.js";
import type { RecordStore } from "./store.js";

type Completion = {
  kind: "complete";
  route: "local" | "pull_request";
  acceptedRevision: string;
  destinationRevision: string;
  url?: string;
  mergedRevision?: string;
};

export type DeliveryInput =
  | { readonly checkoutId: string }
  | { readonly checkoutId: string; readonly route: "preserve" }
  | { readonly checkoutId: string; readonly route: "local"; readonly revision: string }
  | {
      readonly checkoutId: string;
      readonly route: "pull_request";
      readonly revision: string;
      readonly url: string;
      readonly remote: string;
    };

export async function deliver(
  store: RecordStore,
  input: DeliveryInput,
): Promise<CheckoutDeliveryRecord> {
  const records = store.listCheckouts();
  let record = records.find((value) => value.checkoutId === input.checkoutId);

  if (record === undefined)
    throw new Error("Coordinator checkout is not recorded for this session.");

  if ("route" in input && record.destinationRef === undefined)
    throw new Error("Detached checkout allocation has no authorized delivery destination.");

  if ("route" in input && input.route === "preserve") {
    if (record.state.kind !== "available" && record.state.kind !== "preserved")
      throw new Error("Preserve cannot pause or erase a delivery effect already in progress.");
    const revision = await acceptedCheckout(record, undefined);
    record = checkpoint(store, record, { kind: "preserved", revision });

    return record;
  }

  if (!("route" in input)) return continueDelivery(store, record);

  if (input.route === "local") {
    if (record.state.kind !== "available" && record.state.kind !== "preserved")
      throw new Error("A delivery route is already recorded; continue it without route inputs.");
    await acceptedCheckout(record, input.revision);
    const prepared = await prepareAdvancement(record, input.revision);
    record = checkpoint(store, record, {
      kind: "local_prepared",
      acceptedRevision: input.revision,
      ...prepared,
    });

    return continueDelivery(store, record);
  }

  return selectPullRequest(store, record, input);
}

async function selectPullRequest(
  store: RecordStore,
  record: CheckoutDeliveryRecord,
  input: Extract<DeliveryInput, { route: "pull_request" }>,
): Promise<CheckoutDeliveryRecord> {
  const replaceOpen =
    record.state.kind === "pull_request" &&
    record.state.observation === "open" &&
    record.state.url === input.url;

  if (!replaceOpen && record.state.kind !== "available" && record.state.kind !== "preserved")
    throw new Error("A delivery route is already recorded; continue it without route inputs.");
  await acceptedCheckout(record, input.revision);
  const facts = await readPullRequest(input.url);
  const binding = await verifyPullRequest(record, input.remote, input.revision, input.url, facts);

  if (facts.state === "OPEN")
    return checkpoint(store, record, {
      kind: "pull_request",
      acceptedRevision: input.revision,
      url: input.url,
      remote: input.remote,
      observation: "open",
    });

  if (facts.state === "CLOSED")
    return checkpoint(store, record, {
      kind: "pull_request",
      acceptedRevision: input.revision,
      url: input.url,
      remote: input.remote,
      observation: "closed_unmerged",
    });

  if (facts.mergeCommit === null)
    throw new Error("Merged pull request has no actual merge result.");

  const prepared = await prepareMergedPullRequest(
    record,
    binding.baseRemote,
    facts.baseRefName,
    facts.mergeCommit.oid,
  );

  const next = checkpoint(store, record, {
    kind: "pull_request_prepared",
    acceptedRevision: input.revision,
    url: input.url,
    remote: input.remote,
    mergedRevision: facts.mergeCommit.oid,
    headBranch: facts.headRefName,
    baseRemote: binding.baseRemote,
    baseBranch: facts.baseRefName,
    ...prepared,
  });

  return continueDelivery(store, next);
}

async function continueDelivery(
  store: RecordStore,
  record: CheckoutDeliveryRecord,
): Promise<CheckoutDeliveryRecord> {
  if (record.state.kind === "pull_request")
    record = await refreshPullRequest(store, record, record.state);
  record = await integratePrepared(store, record);

  if (record.state.kind !== "integrated") {
    if (record.state.kind === "complete" || record.state.kind === "preserved") return record;
    throw new Error("Recorded checkout has no route to continue.");
  }

  await proveDestination(record, record.state.destinationRevision);

  if (store.checkoutCleanupBlocked(record.managedPath))
    throw new Error("Checkout cleanup is blocked by an active Worker or unresolved Candidate.");

  if (record.state.route === "pull_request") await deletePublishedHead(record, record.state);
  await cleanupLocal(record, record.state.acceptedRevision);

  const complete: Completion = {
    kind: "complete",
    route: record.state.route,
    acceptedRevision: record.state.acceptedRevision,
    destinationRevision: record.state.destinationRevision,
  };

  if (record.state.url !== undefined) complete.url = record.state.url;

  if (record.state.mergedRevision !== undefined)
    complete.mergedRevision = record.state.mergedRevision;

  return checkpoint(store, record, complete);
}

async function refreshPullRequest(
  store: RecordStore,
  record: CheckoutDeliveryRecord,
  state: Extract<CheckoutDeliveryState, { kind: "pull_request" }>,
): Promise<CheckoutDeliveryRecord> {
  if (state.observation === "closed_unmerged") return record;
  const facts = await readPullRequest(state.url);

  const binding = await verifyPullRequest(
    record,
    state.remote,
    state.acceptedRevision,
    state.url,
    facts,
  );

  if (facts.state === "OPEN") return record;

  if (facts.state === "CLOSED")
    return checkpoint(store, record, { ...state, observation: "closed_unmerged" });

  if (facts.mergeCommit === null)
    throw new Error("Merged pull request has no actual merge result.");

  const prepared = await prepareMergedPullRequest(
    record,
    binding.baseRemote,
    facts.baseRefName,
    facts.mergeCommit.oid,
  );

  return checkpoint(store, record, {
    kind: "pull_request_prepared",
    acceptedRevision: state.acceptedRevision,
    url: state.url,
    remote: state.remote,
    mergedRevision: facts.mergeCommit.oid,
    headBranch: facts.headRefName,
    baseRemote: binding.baseRemote,
    baseBranch: facts.baseRefName,
    ...prepared,
  });
}

async function integratePrepared(
  store: RecordStore,
  record: CheckoutDeliveryRecord,
): Promise<CheckoutDeliveryRecord> {
  if (record.state.kind === "local_prepared") {
    await advanceDestination(record, record.state);

    return checkpoint(store, record, {
      kind: "integrated",
      route: "local",
      acceptedRevision: record.state.acceptedRevision,
      destinationRevision: record.state.destinationRevision,
    });
  }

  if (record.state.kind !== "pull_request_prepared") return record;
  await advanceDestination(record, record.state);

  return checkpoint(store, record, {
    kind: "integrated",
    route: "pull_request",
    acceptedRevision: record.state.acceptedRevision,
    destinationRevision: record.state.destinationRevision,
    url: record.state.url,
    mergedRevision: record.state.mergedRevision,
    remote: record.state.remote,
    headBranch: record.state.headBranch,
  });
}

function checkpoint(
  store: RecordStore,
  record: CheckoutDeliveryRecord,
  state: CheckoutDeliveryState,
) {
  return store.checkpointCheckout({ ...record, state });
}
