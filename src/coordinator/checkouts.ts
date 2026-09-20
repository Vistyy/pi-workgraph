/* oxlint-disable effecttsgo/async-function -- This module is the thin Promise boundary around repository-owned Effects. */
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import type { CheckoutRecord } from "../domain/records.js";
import {
  applyCoordinatorAdvancement,
  type CoordinatorCheckoutIdentity,
  coordinatorCheckoutHead,
  coordinatorSourceFacts,
  deleteCoordinatorBranch,
  ensureCoordinatorCheckout,
  prepareCoordinatorAdvancement,
  removeCoordinatorWorktree,
  requireCoordinatorAdvancementAbsent,
  requireCoordinatorCheckoutAbsent,
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

type Destination = { readonly cwd: string; readonly ref: string };

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
    if (prior.disposition.kind !== "creating" && prior.disposition.kind !== "active")
      throw new Error(
        "Coordinator checkout has an unfinished disposition; inspect or resume delivery first.",
      );

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

    const active = input.store.checkpointCheckout({
      ...prior,
      disposition: { kind: "active", head: receipt.head },
    });

    return facts(active, receipt);
  }

  if (prior?.disposition.kind === "complete" && prior.disposition.route === "preserve") {
    const receipt = await Effect.runPromise(
      ensureCoordinatorCheckout({ target: source.target, commit: prior.sourceHead, identity }),
    );

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
      readonly destination?: { readonly cwd: string; readonly ref: string };
    }
  | { readonly checkoutId: string };

export async function deliverCheckout(input: {
  readonly request: DeliverInput;
  readonly store: RecordStore;
  readonly blockCleanup: () => string | undefined;
}): Promise<CheckoutRecord> {
  const record = input.store
    .listCheckouts()
    .find(({ checkoutId }) => checkoutId === input.request.checkoutId);

  if (record === undefined)
    throw new Error("Coordinator checkout record is absent in this session.");

  if ("route" in input.request && input.request.route === "preserve")
    return preserveCheckout(record, input.store);

  if (record.disposition.kind === "complete") return record;
  let current = record;

  if ("route" in input.request && input.request.route === "local") {
    current = await selectOrRetryLocal(record, input.request, input.store);
  } else if (record.disposition.kind !== "local") {
    throw new Error("Resume requires an already-recorded disposition.");
  }

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
    current = input.store.checkpointCheckout({
      ...current,
      disposition: { ...local, integrated: true },
    });
    local = requireLocal(current);
  }

  await Effect.runPromise(
    verifyCoordinatorAdvancement({
      identity: current,
      acceptedRevision: local.acceptedRevision,
      advancement: local,
    }),
  );
  const blocker = input.blockCleanup();

  if (blocker !== undefined) throw new Error(`Cleanup blocked: ${blocker}`);

  if (local.cleanup === undefined) {
    current = input.store.checkpointCheckout({
      ...current,
      disposition: { ...local, cleanup: "worktree" },
    });
    local = requireLocal(current);
  }

  if (local.cleanup === "worktree") {
    await Effect.runPromise(
      removeCoordinatorWorktree({ identity: current, expectedTip: local.acceptedRevision }),
    );
    current = input.store.checkpointCheckout({
      ...current,
      disposition: { ...local, cleanup: "branch" },
    });
    local = requireLocal(current);
  }

  await Effect.runPromise(
    deleteCoordinatorBranch({ identity: current, expectedTip: local.acceptedRevision }),
  );

  return input.store.checkpointCheckout({
    ...current,
    disposition: {
      kind: "complete",
      route: "local",
      revision: local.acceptedRevision,
      destinationRevision: local.preparedRevision,
    },
  });
}

async function preserveCheckout(
  record: CheckoutRecord,
  store: RecordStore,
): Promise<CheckoutRecord> {
  if (record.disposition.kind === "complete" && record.disposition.route === "local") return record;

  if (record.disposition.kind === "local") {
    if (record.disposition.integrated === true)
      throw new Error("Verified local integration cannot be replaced by preserve.");
    await Effect.runPromise(
      requireCoordinatorAdvancementAbsent({
        identity: record,
        acceptedRevision: record.disposition.acceptedRevision,
        advancement: record.disposition,
      }),
    );
  } else if (
    record.disposition.kind !== "active" &&
    record.disposition.kind !== "preserved" &&
    !(record.disposition.kind === "complete" && record.disposition.route === "preserve")
  ) {
    throw new Error("Checkout cannot be preserved from its current lifecycle state.");
  }

  const head = await Effect.runPromise(coordinatorCheckoutHead(record));

  return store.checkpointCheckout({
    ...record,
    disposition: { kind: "complete", route: "preserve", revision: head },
  });
}

async function selectOrRetryLocal(
  record: CheckoutRecord,
  request: Extract<DeliverInput, { route: "local" }>,
  store: RecordStore,
): Promise<CheckoutRecord> {
  if (record.disposition.kind === "active") {
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
    throw new Error("A new local disposition requires an active Coordinator checkout.");

  if (record.disposition.integrated === true)
    throw new Error("Integrated local delivery can only be reconciled, not replanned.");

  if (request.revision !== record.disposition.acceptedRevision)
    throw new Error("Local retry must keep the exact accepted revision.");

  if (
    request.destination !== undefined &&
    (request.destination.cwd !== record.disposition.destinationRoot ||
      request.destination.ref !== record.disposition.destinationRef)
  )
    throw new Error("Local retry must keep the exact authorized destination.");

  const prepared = await Effect.runPromise(
    retryCoordinatorAdvancement({
      identity: record,
      acceptedRevision: record.disposition.acceptedRevision,
      advancement: record.disposition,
    }),
  );

  return store.checkpointCheckout({
    ...record,
    disposition: { ...record.disposition, ...prepared },
  });
}

function requireLocal(record: CheckoutRecord): LocalDisposition {
  if (record.disposition.kind !== "local") throw new Error("Local disposition is absent.");

  return record.disposition;
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
