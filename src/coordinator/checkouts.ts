/* oxlint-disable effecttsgo/async-function -- Pi callbacks are the Promise boundary around repository-owned Effects. */
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { canonicalFuturePath, fail, gitResult, resolveTaskTarget } from "../repository/git.js";
import {
  type CoordinatorCheckoutIdentity,
  ensureCoordinatorCheckout,
  observeCoordinatorCheckout,
} from "./checkout-git.js";
import type { CheckoutDeliveryRecord } from "./delivery-state.js";
import type { RecordStore } from "./store.js";

export interface CheckoutFacts extends CheckoutDeliveryRecord {
  readonly head: string;
  readonly created: boolean;
  readonly reused: boolean;
  readonly diagnostic?: string;
}

type Identity = CoordinatorCheckoutIdentity & { readonly checkoutId: string };

/** Explicitly allocate, adopt, or reuse this session's one exact repository checkout. */
export async function createCheckout(input: {
  readonly agentDir: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly store: RecordStore;
  readonly path?: string;
}): Promise<CheckoutFacts> {
  const resolved = await Effect.runPromise(
    Effect.gen(function* () {
      const target = yield* input.path === undefined
        ? resolveTaskTarget({ cwd: input.cwd, kind: "repository" })
        : resolveTaskTarget({ cwd: input.cwd, path: input.path, kind: "repository" });

      if (target.target.kind !== "repository" || !("commit" in target))
        return yield* fail("resolve Coordinator checkout", "Repository target resolution failed.");

      return target;
    }),
  );

  const identity = await checkoutIdentity(
    input.agentDir,
    input.sessionId,
    resolved.target.commonDir,
  );

  const prior = input.store.readCheckout(resolved.target.commonDir);
  const observed = await Effect.runPromise(observeCoordinatorCheckout(identity));

  if (prior !== undefined && prior.checkoutId !== identity.checkoutId)
    throw new Error("Persisted Coordinator checkout identity does not match this session.");

  if (prior?.state.kind === "complete" && observed.kind !== "absent")
    return { ...prior, head: observed.head, created: false, reused: true };

  const receipt = await Effect.runPromise(
    ensureCoordinatorCheckout({ target: resolved.target, commit: resolved.commit, identity }),
  );

  if (prior !== undefined && prior.state.kind !== "complete") return { ...prior, ...receipt };

  const attached = await Effect.runPromise(
    gitResult(resolved.target.checkoutRoot, ["symbolic-ref", "-q", "HEAD"]),
  );

  const destinationRef =
    attached.code === 0 && attached.stdout.startsWith("refs/heads/") ? attached.stdout : undefined;

  const record: CheckoutDeliveryRecord = {
    ...identity,
    sourcePath: resolved.target.checkoutRoot,
    state: { kind: "available", allocatedRevision: receipt.head },
  };

  if (destinationRef !== undefined) record.destinationRef = destinationRef;
  input.store.checkpointCheckout(record);

  return { ...record, ...receipt };
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
    managedPath: canonicalFuturePath(
      join(canonicalAgentDir, "workgraph", "coordinator-checkouts", checkoutId),
    ),
    repositoryCommonDir: commonDir,
    ownedBranch: `refs/heads/pi-workgraph/coordinators/${checkoutId}`,
  };
}
