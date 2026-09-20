import { Data, Effect } from "effect";
import type { GitError } from "../repository/git.js";
import { cleanupCoordinatorCheckout, observeAcceptedCheckout } from "./checkout-git.js";
import {
  advanceDestination,
  deletePublishedHead,
  prepareAdvancement,
  prepareMergedPullRequest,
  proveDestination,
  verifyPullRequest,
} from "./delivery-git.js";
import type { CheckoutDeliveryRecord, CheckoutDeliveryState } from "./delivery-state.js";
import { type PullRequestFacts, readPullRequest } from "./github.js";
import type { RecordStore } from "./store.js";

export class DeliveryError extends Data.TaggedError("DeliveryError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

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

export function deliver(
  store: RecordStore,
  input: DeliveryInput,
): Effect.Effect<CheckoutDeliveryRecord, GitError | DeliveryError> {
  const record = store.listCheckouts().find((value) => value.checkoutId === input.checkoutId);

  if (record === undefined)
    return deliveryFail("Coordinator checkout is not recorded for this session.");

  if (!("route" in input)) return continueDelivery(store, record);

  if (record.destinationRef === undefined)
    return deliveryFail("Detached checkout allocation has no authorized delivery destination.");

  if (input.route === "preserve") return preserveCheckout(store, record);

  if (input.route === "local") return selectLocal(store, record, input.revision);

  return selectPullRequest(store, record, input);
}

function preserveCheckout(store: RecordStore, record: CheckoutDeliveryRecord) {
  if (record.state.kind !== "available" && record.state.kind !== "preserved")
    return deliveryFail("Preserve cannot pause or erase a delivery effect already in progress.");

  return observeAcceptedCheckout(record, undefined, false).pipe(
    Effect.map((revision) => checkpoint(store, record, { kind: "preserved", revision })),
  );
}

function selectLocal(store: RecordStore, record: CheckoutDeliveryRecord, revision: string) {
  if (record.state.kind !== "available" && record.state.kind !== "preserved")
    return deliveryFail("A delivery route is already recorded; continue it without route inputs.");

  return Effect.gen(function* () {
    yield* observeAcceptedCheckout(record, revision);

    const prepared = yield* prepareAdvancement(record, revision);

    const selected = checkpoint(store, record, {
      kind: "local_prepared",
      acceptedRevision: revision,
      ...prepared,
    });

    return yield* continueDelivery(store, selected);
  });
}

function selectPullRequest(
  store: RecordStore,
  record: CheckoutDeliveryRecord,
  input: Extract<DeliveryInput, { route: "pull_request" }>,
): Effect.Effect<CheckoutDeliveryRecord, GitError | DeliveryError> {
  return Effect.gen(function* () {
    const replaceOpen =
      record.state.kind === "pull_request" &&
      record.state.observation === "open" &&
      record.state.url === input.url;

    if (!replaceOpen && record.state.kind !== "available" && record.state.kind !== "preserved")
      return yield* deliveryFail(
        "A delivery route is already recorded; continue it without route inputs.",
      );

    yield* observeAcceptedCheckout(record, input.revision);

    const facts = yield* pullRequest(input.url);

    const binding = yield* verifyPullRequest(
      record,
      input.remote,
      input.revision,
      input.url,
      facts,
    );

    const authorization = {
      acceptedRevision: input.revision,
      url: input.url,
      remote: input.remote,
      publicationRepository: binding.publicationRepository,
    };

    if (facts.state === "OPEN")
      return checkpoint(store, record, {
        kind: "pull_request",
        ...authorization,
        observation: "open",
      });

    if (facts.state === "CLOSED")
      return checkpoint(store, record, {
        kind: "pull_request",
        ...authorization,
        observation: "closed_unmerged",
      });

    if (facts.mergeCommit === null)
      return yield* deliveryFail("Merged pull request has no actual merge result.");

    const prepared = yield* prepareMergedPullRequest(
      record,
      binding.baseRemote,
      binding.baseRepository,
      facts.baseRefName,
      facts.mergeCommit.oid,
    );

    const next = checkpoint(store, record, {
      kind: "pull_request_prepared",
      ...authorization,
      mergedRevision: facts.mergeCommit.oid,
      headBranch: facts.headRefName,
      baseRemote: binding.baseRemote,
      baseRepository: binding.baseRepository,
      baseBranch: facts.baseRefName,
      ...prepared,
    });

    return yield* continueDelivery(store, next);
  });
}

function continueDelivery(
  store: RecordStore,
  initial: CheckoutDeliveryRecord,
): Effect.Effect<CheckoutDeliveryRecord, GitError | DeliveryError> {
  return Effect.gen(function* () {
    let record = initial;

    if (record.state.kind === "pull_request") {
      record = yield* refreshPullRequest(store, record, record.state);

      if (record.state.kind === "pull_request") return record;
    }

    record = yield* integratePrepared(store, record);

    if (record.state.kind === "complete" || record.state.kind === "preserved") return record;

    if (record.state.kind === "local_integrated")
      return yield* completeLocal(store, record, record.state);

    if (record.state.kind === "pull_request_integrated")
      return yield* completePullRequest(store, record, record.state);

    return yield* deliveryFail("Recorded checkout has no route to continue.");
  });
}

function completeLocal(
  store: RecordStore,
  record: CheckoutDeliveryRecord,
  state: Extract<CheckoutDeliveryState, { kind: "local_integrated" }>,
) {
  return Effect.gen(function* () {
    const destinationRevision = yield* proveDestination(record, state.destinationRevision);
    yield* requireCleanupAvailable(store, record);
    yield* cleanupCoordinatorCheckout(record, state.acceptedRevision);

    return checkpoint(store, record, {
      kind: "complete",
      route: "local",
      acceptedRevision: state.acceptedRevision,
      destinationRevision,
    });
  });
}

function completePullRequest(
  store: RecordStore,
  record: CheckoutDeliveryRecord,
  state: Extract<CheckoutDeliveryState, { kind: "pull_request_integrated" }>,
) {
  return Effect.gen(function* () {
    const destinationRevision = yield* proveDestination(record, state.destinationRevision);
    yield* requireCleanupAvailable(store, record);
    yield* deletePublishedHead(record, state);
    yield* cleanupCoordinatorCheckout(record, state.acceptedRevision);

    return checkpoint(store, record, {
      kind: "complete",
      route: "pull_request",
      acceptedRevision: state.acceptedRevision,
      destinationRevision,
      url: state.url,
      mergedRevision: state.mergedRevision,
    });
  });
}

function requireCleanupAvailable(store: RecordStore, record: CheckoutDeliveryRecord) {
  if (store.checkoutCleanupBlocked(record.managedPath))
    return deliveryFail("Checkout cleanup is blocked by an active Worker or unresolved Candidate.");

  return Effect.void;
}

function refreshPullRequest(
  store: RecordStore,
  record: CheckoutDeliveryRecord,
  state: Extract<CheckoutDeliveryState, { kind: "pull_request" }>,
): Effect.Effect<CheckoutDeliveryRecord, GitError | DeliveryError> {
  return Effect.gen(function* () {
    if (state.observation === "closed_unmerged") return record;

    const facts = yield* pullRequest(state.url);

    const binding = yield* verifyPullRequest(
      record,
      state.remote,
      state.acceptedRevision,
      state.url,
      facts,
    );

    if (binding.publicationRepository !== state.publicationRepository)
      return yield* deliveryFail("Pull request publication identity changed.");

    if (facts.state === "OPEN") return record;

    if (facts.state === "CLOSED")
      return checkpoint(store, record, { ...state, observation: "closed_unmerged" });

    if (facts.mergeCommit === null)
      return yield* deliveryFail("Merged pull request has no actual merge result.");

    const prepared = yield* prepareMergedPullRequest(
      record,
      binding.baseRemote,
      binding.baseRepository,
      facts.baseRefName,
      facts.mergeCommit.oid,
    );

    return checkpoint(store, record, {
      kind: "pull_request_prepared",
      acceptedRevision: state.acceptedRevision,
      url: state.url,
      remote: state.remote,
      publicationRepository: state.publicationRepository,
      mergedRevision: facts.mergeCommit.oid,
      headBranch: facts.headRefName,
      baseRemote: binding.baseRemote,
      baseRepository: binding.baseRepository,
      baseBranch: facts.baseRefName,
      ...prepared,
    });
  });
}

function integratePrepared(
  store: RecordStore,
  record: CheckoutDeliveryRecord,
): Effect.Effect<CheckoutDeliveryRecord, GitError> {
  return Effect.gen(function* () {
    if (record.state.kind === "local_prepared") {
      const destinationRevision = yield* advanceDestination(record, record.state);

      return checkpoint(store, record, {
        kind: "local_integrated",
        acceptedRevision: record.state.acceptedRevision,
        destinationRevision,
      });
    }

    if (record.state.kind !== "pull_request_prepared") return record;
    const destinationRevision = yield* advanceDestination(record, record.state);

    return checkpoint(store, record, {
      kind: "pull_request_integrated",
      acceptedRevision: record.state.acceptedRevision,
      destinationRevision,
      url: record.state.url,
      mergedRevision: record.state.mergedRevision,
      remote: record.state.remote,
      publicationRepository: record.state.publicationRepository,
      headBranch: record.state.headBranch,
    });
  });
}

function pullRequest(url: string): Effect.Effect<PullRequestFacts, DeliveryError> {
  return Effect.tryPromise({
    try: () => readPullRequest(url),
    catch: (cause) => new DeliveryError({ message: "Pull request read failed.", cause }),
  });
}

function checkpoint(
  store: RecordStore,
  record: CheckoutDeliveryRecord,
  state: CheckoutDeliveryState,
) {
  return store.checkpointCheckout({ ...record, state });
}

function deliveryFail(message: string): Effect.Effect<never, DeliveryError> {
  return Effect.fail(new DeliveryError({ message }));
}
