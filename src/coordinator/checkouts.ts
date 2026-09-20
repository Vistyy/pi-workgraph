/* oxlint-disable effecttsgo/async-function, anti-slop/require-readable-spacing, anti-slop/no-conditional-empty-object-spread, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening -- Pi callbacks are the Promise boundary; strict records and checked discriminants own optional fields. */
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import type { CheckoutRecord } from "../domain/records.js";
import {
  applyCoordinatorAdvancement,
  type CoordinatorCheckoutIdentity,
  coordinatorSourceFacts,
  deleteCoordinatorBranch,
  ensureCoordinatorCheckout,
  prepareCoordinatorAdvancement,
  removeCoordinatorWorktree,
  resolveCoordinatorRepository,
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

/** Explicit allocation checkpoints identity before invoking native Git creation. */
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
      ensureCoordinatorCheckout({ target: source.target, commit: prior.sourceHead, identity }),
    );
    const active = input.store.checkpointCheckout({
      ...prior,
      disposition: { kind: "active", head: receipt.head },
    });

    return facts(active, receipt);
  }

  const creating: CheckoutRecord = {
    ...identity,
    sourceCheckoutRoot: source.target.checkoutRoot,
    sourceHead: source.head,
    ...(source.ref === undefined ? {} : { sourceRef: source.ref }),
    disposition: { kind: "creating" },
  };
  input.store.checkpointCheckout(creating);
  const receipt = await Effect.runPromise(
    ensureCoordinatorCheckout({ target: source.target, commit: source.head, identity }),
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Durable local delivery checkpoints intentionally keep effect ordering visible.
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
  if (record.disposition.kind === "complete") return record;

  if ("route" in input.request && input.request.route === "preserve") {
    if (record.disposition.kind !== "active" && record.disposition.kind !== "preserved")
      throw new Error("A recorded local disposition cannot be replaced by preserve.");

    return input.store.checkpointCheckout({
      ...record,
      disposition: {
        kind: "complete",
        route: "preserve",
        revision: record.disposition.head,
      },
    });
  }

  let current = record;

  if ("route" in input.request && input.request.route === "local") {
    if (record.disposition.kind !== "active")
      throw new Error("A new local disposition requires an active Coordinator checkout.");
    const destination = input.request.destination ?? defaultDestination(record);
    const prepared = await Effect.runPromise(
      prepareCoordinatorAdvancement({
        identity: record,
        acceptedRevision: input.request.revision,
        destinationRoot: destination.cwd,
        destinationRef: destination.ref,
      }),
    );
    current = input.store.checkpointCheckout({
      ...record,
      disposition: {
        kind: "local",
        acceptedRevision: input.request.revision,
        ...prepared,
      },
    });
  } else if (record.disposition.kind !== "local") {
    throw new Error("Resume requires an already-recorded disposition.");
  }

  if (current.disposition.kind !== "local") throw new Error("Local disposition is absent.");
  let local = current.disposition;

  if (local.integrated !== true) {
    const revision = await Effect.runPromise(
      applyCoordinatorAdvancement({
        commonDir: current.repositoryCommonDir,
        acceptedRevision: local.acceptedRevision,
        advancement: local,
      }),
    );
    current = input.store.checkpointCheckout({
      ...current,
      disposition: { ...local, integrated: true },
    });
    local = current.disposition as Extract<CheckoutRecord["disposition"], { kind: "local" }>;

    if (revision !== local.preparedRevision)
      throw new Error("Integrated revision differs from the prepared revision.");
  }

  const blocker = input.blockCleanup();

  if (blocker !== undefined) throw new Error(`Cleanup blocked: ${blocker}`);
  const source = await Effect.runPromise(resolveCoordinatorRepository(current.sourceCheckoutRoot));

  if (local.cleanup === undefined) {
    current = input.store.checkpointCheckout({
      ...current,
      disposition: { ...local, cleanup: "worktree" },
    });
    local = current.disposition as Extract<CheckoutRecord["disposition"], { kind: "local" }>;
  }

  if (local.cleanup === "worktree") {
    await Effect.runPromise(
      removeCoordinatorWorktree({
        target: source.target,
        identity: current,
        expectedTip: local.acceptedRevision,
      }),
    );
    current = input.store.checkpointCheckout({
      ...current,
      disposition: { ...local, cleanup: "branch" },
    });
    local = current.disposition as Extract<CheckoutRecord["disposition"], { kind: "local" }>;
  }

  await Effect.runPromise(
    deleteCoordinatorBranch({
      commonDir: current.repositoryCommonDir,
      branch: current.ownedBranch,
      expectedTip: local.acceptedRevision,
    }),
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

function defaultDestination(record: CheckoutRecord): { cwd: string; ref: string } {
  if (record.sourceRef === undefined)
    throw new Error("Original source was detached; an explicit attached destination is required.");

  return { cwd: record.sourceCheckoutRoot, ref: record.sourceRef };
}

function facts(
  record: CheckoutRecord,
  receipt: { head: string; created: boolean; reused: boolean; diagnostic?: string },
): CheckoutFacts {
  return {
    checkoutId: record.checkoutId,
    managedPath: record.managedPath,
    repositoryCommonDir: record.repositoryCommonDir,
    ownedBranch: record.ownedBranch,
    head: receipt.head,
    created: receipt.created,
    reused: receipt.reused,
    sourceCheckoutRoot: record.sourceCheckoutRoot,
    sourceHead: record.sourceHead,
    ...(record.sourceRef === undefined ? {} : { sourceRef: record.sourceRef }),
    lifecycle: record.disposition,
    ...(receipt.diagnostic === undefined ? {} : { diagnostic: receipt.diagnostic }),
  };
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
