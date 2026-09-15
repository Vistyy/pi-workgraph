import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { CoordinatorCheckout } from "../domain/records.js";
import {
  applyCoordinatorCheckout,
  coordinatorPlacement,
  ensureCoordinatorCheckout,
  type GitError,
  inspectCoordinatorCheckout,
  prepareCoordinatorApplication,
  prepareCoordinatorDiscard,
  removeAppliedCoordinatorWorktree,
  removeCoordinatorBranch,
  removeDiscardedCoordinatorWorktree,
  resolveCoordinatorRepository,
  validateCoordinatorDestination,
  validateCoordinatorWorktreeRemoval,
} from "../repository.js";
import { type RecordStore, StoreError } from "./store.js";

export interface CheckoutIdentity {
  readonly checkoutId: string;
  readonly managedPath: string;
  readonly destinationCheckout: string;
  readonly repositoryCommonDir: string;
  readonly baseCommit: string;
  readonly ownedBranch: string;
  readonly destinationBranch: string;
}

export interface CheckoutFacts extends CheckoutIdentity {
  readonly lifecycle: CoordinatorCheckout["state"]["kind"];
  readonly sourceHead: string;
  readonly sourceDirty: boolean;
  readonly sourcePresent: boolean;
  readonly destinationHead: string;
  readonly destinationDirty: boolean;
}

export interface BlockedCheckoutFacts extends CheckoutIdentity {
  readonly lifecycle: CoordinatorCheckout["state"]["kind"];
  readonly blocked: string;
}

type CheckoutError = GitError | StoreError;

type CheckoutOwner = {
  readonly store: RecordStore;
  readonly agentDir: string;
};

export function createCheckout(
  owner: CheckoutOwner,
  cwd: string,
  path?: string,
): Effect.Effect<
  CheckoutFacts & { readonly created: boolean; readonly reused: boolean },
  CheckoutError
> {
  return Effect.gen(function* () {
    const resolved = yield* resolveCoordinatorRepository(cwd, path);

    const existing = yield* store("find Coordinator checkout", () =>
      owner.store.findCoordinatorCheckout(resolved.target.commonDir),
    );

    if (existing !== undefined) {
      const checkout = yield* ensureReady(owner.store, existing);
      const facts = yield* checkoutFacts(checkout);

      return { ...facts, created: false, reused: true };
    }

    const destination = yield* validateCoordinatorDestination(resolved);
    const checkoutId = randomUUID();
    const placement = coordinatorPlacement({ agentDir: owner.agentDir, checkoutId });

    const proposed: CoordinatorCheckout = {
      checkoutId,
      target: resolved.target,
      managedPath: placement.managedPath,
      branchRef: placement.branchRef,
      baseCommit: resolved.commit,
      destinationRef: destination.destinationRef,
      state: { kind: "placing" },
    };

    const stored = yield* store("create Coordinator checkout", () =>
      owner.store.createCoordinatorCheckout(proposed),
    );

    const checkout = yield* ensureReady(owner.store, stored.checkout);
    const facts = yield* checkoutFacts(checkout);

    return { ...facts, created: stored.created, reused: !stored.created };
  });
}

export function inspectCheckout(
  storeOwner: RecordStore,
  checkoutId: string,
): Effect.Effect<CheckoutFacts, CheckoutError> {
  return Effect.gen(function* () {
    const checkout = yield* read(storeOwner, checkoutId);

    return yield* checkoutFacts(checkout);
  });
}

export function listCheckouts(
  storeOwner: RecordStore,
  offset: number,
  limit: number,
): Effect.Effect<readonly (CheckoutFacts | BlockedCheckoutFacts)[], CheckoutError> {
  return Effect.gen(function* () {
    const checkouts = yield* store("list Coordinator checkouts", () =>
      storeOwner.listCoordinatorCheckouts(offset, limit),
    );

    return yield* Effect.forEach(
      checkouts,
      (checkout) =>
        Effect.result(checkoutFacts(checkout)).pipe(
          Effect.map((result) =>
            result._tag === "Success"
              ? result.success
              : {
                  ...checkoutIdentity(checkout),
                  lifecycle: checkout.state.kind,
                  blocked: result.failure.message,
                },
          ),
        ),
      { concurrency: "unbounded" },
    );
  });
}

export function applyCheckout(
  storeOwner: RecordStore,
  checkoutId: string,
): Effect.Effect<
  CheckoutIdentity & {
    readonly lifecycle: "applied";
    readonly revision: string;
    readonly released: true;
  },
  CheckoutError
> {
  return Effect.gen(function* () {
    let checkout = yield* read(storeOwner, checkoutId);

    if (checkout.state.kind !== "applied") {
      checkout = yield* prepareCoordinatorApplication(checkout);
      checkout = yield* checkpoint(storeOwner, checkout);
      checkout = yield* applyCoordinatorCheckout(checkout);
      checkout = yield* checkpoint(storeOwner, checkout);
    }

    if (checkout.state.kind !== "applied")
      return yield* Effect.die("Applied Coordinator checkout lost its lifecycle state.");

    if (checkout.state.worktreeRemoval === undefined) {
      yield* validateCoordinatorWorktreeRemoval(checkout);
      checkout = yield* checkpoint(storeOwner, {
        ...checkout,
        state: { ...checkout.state, worktreeRemoval: "requested" },
      });
    }

    if (checkout.state.kind !== "applied")
      return yield* Effect.die("Applied Coordinator checkout lost its lifecycle state.");

    if (checkout.state.worktreeRemoval === "requested") {
      yield* removeAppliedCoordinatorWorktree(checkout);
      checkout = yield* checkpoint(storeOwner, {
        ...checkout,
        state: { ...checkout.state, worktreeRemoval: "confirmed" },
      });
    }

    yield* removeCoordinatorBranch(checkout);
    yield* store("remove Coordinator checkout", () =>
      storeOwner.removeCoordinatorCheckout(checkout),
    );
    const applied = checkout.state;

    if (applied.kind !== "applied")
      return yield* Effect.die("Applied Coordinator checkout lost its lifecycle state.");

    return {
      ...checkoutIdentity(checkout),
      lifecycle: "applied" as const,
      revision: applied.revision,
      released: true as const,
    };
  });
}

export function discardCheckout(
  storeOwner: RecordStore,
  checkoutId: string,
  reason: string,
): Effect.Effect<
  CheckoutIdentity & {
    readonly lifecycle: "discarded";
    readonly reason: string;
    readonly released: true;
  },
  CheckoutError
> {
  return Effect.gen(function* () {
    let checkout = yield* read(storeOwner, checkoutId);

    checkout = yield* prepareCoordinatorDiscard(checkout, reason);
    checkout = yield* checkpoint(storeOwner, checkout);

    if (checkout.state.kind !== "discarding")
      return yield* Effect.die("Discarding Coordinator checkout lost its lifecycle state.");

    if (checkout.state.worktreeRemoval === undefined) {
      yield* validateCoordinatorWorktreeRemoval(checkout);
      checkout = yield* checkpoint(storeOwner, {
        ...checkout,
        state: { ...checkout.state, worktreeRemoval: "requested" },
      });
    }

    if (checkout.state.kind !== "discarding")
      return yield* Effect.die("Discarding Coordinator checkout lost its lifecycle state.");

    if (checkout.state.worktreeRemoval === "requested") {
      yield* removeDiscardedCoordinatorWorktree(checkout);
      checkout = yield* checkpoint(storeOwner, {
        ...checkout,
        state: { ...checkout.state, worktreeRemoval: "confirmed" },
      });
    }

    yield* removeCoordinatorBranch(checkout);
    yield* store("remove Coordinator checkout", () =>
      storeOwner.removeCoordinatorCheckout(checkout),
    );
    const discarded = checkout.state;

    if (discarded.kind !== "discarding")
      return yield* Effect.die("Discarding Coordinator checkout lost its lifecycle state.");

    return {
      ...checkoutIdentity(checkout),
      lifecycle: "discarded" as const,
      reason: discarded.reason,
      released: true as const,
    };
  });
}

function ensureReady(
  storeOwner: RecordStore,
  checkout: CoordinatorCheckout,
): Effect.Effect<CoordinatorCheckout, CheckoutError> {
  if (checkout.state.kind !== "placing") return Effect.succeed(checkout);

  return ensureCoordinatorCheckout(checkout).pipe(
    Effect.andThen(() => checkpoint(storeOwner, { ...checkout, state: { kind: "ready" } })),
  );
}

function checkoutFacts(checkout: CoordinatorCheckout): Effect.Effect<CheckoutFacts, GitError> {
  return inspectCoordinatorCheckout(checkout).pipe(
    Effect.map((facts) => ({
      ...checkoutIdentity(checkout),
      lifecycle: checkout.state.kind,
      sourceHead: facts.head,
      sourceDirty: facts.dirty,
      sourcePresent: facts.sourcePresent,
      destinationHead: facts.destinationHead,
      destinationDirty: facts.destinationDirty,
    })),
  );
}

function checkoutIdentity(checkout: CoordinatorCheckout): CheckoutIdentity {
  return {
    checkoutId: checkout.checkoutId,
    managedPath: checkout.managedPath,
    destinationCheckout: checkout.target.checkoutRoot,
    repositoryCommonDir: checkout.target.commonDir,
    baseCommit: checkout.baseCommit,
    ownedBranch: checkout.branchRef,
    destinationBranch: checkout.destinationRef,
  };
}

function read(
  storeOwner: RecordStore,
  checkoutId: string,
): Effect.Effect<CoordinatorCheckout, StoreError> {
  return store("read Coordinator checkout", () => storeOwner.readCoordinatorCheckout(checkoutId));
}

function checkpoint(
  storeOwner: RecordStore,
  checkout: CoordinatorCheckout,
): Effect.Effect<CoordinatorCheckout, StoreError> {
  return store("checkpoint Coordinator checkout", () =>
    storeOwner.checkpointCoordinatorCheckout(checkout),
  );
}

function store<A>(operation: string, run: () => A): Effect.Effect<A, StoreError> {
  return Effect.try({
    try: run,
    catch: (cause) =>
      cause instanceof StoreError
        ? cause
        : new StoreError({ operation, message: "Record Store operation failed.", cause }),
  });
}
