import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { canonicalFuturePath, fail, resolveTaskTarget } from "../repository/git.js";
import {
  type CoordinatorCheckoutIdentity,
  cleanupCoordinatorCheckout,
  ensureCoordinatorCheckout,
} from "./checkout-git.js";
import type { RecordStore, SessionAttemptSnapshot } from "./store.js";

export interface CheckoutFacts extends CoordinatorCheckoutIdentity {
  readonly checkoutId: string;
  readonly head: string;
  readonly created: boolean;
  readonly reused: boolean;
  readonly diagnostic?: string;
}

interface ResolvedIdentity {
  readonly identity: CoordinatorCheckoutIdentity & { readonly checkoutId: string };
  readonly sourcePath: string;
  readonly sourceHead: string;
}

/** Allocate or exactly reuse this session's deterministic repository checkout. */
// oxlint-disable-next-line effecttsgo/async-function -- Pi host callbacks and existing native Promise seams require this async boundary.
export async function createCheckout(input: {
  readonly agentDir: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly path?: string;
}): Promise<CheckoutFacts> {
  const resolved = await resolveIdentity(input);

  const receipt = await Effect.runPromise(
    ensureCoordinatorCheckout({
      target: {
        kind: "repository",
        checkoutRoot: resolved.sourcePath,
        commonDir: resolved.identity.repositoryCommonDir,
      },
      commit: resolved.sourceHead,
      identity: resolved.identity,
    }),
  );

  return { ...resolved.identity, ...receipt };
}

/** Remove only the exact clean owned checkout and compare-and-delete its unchanged branch. */
// oxlint-disable-next-line effecttsgo/async-function -- Pi host callbacks and existing native Promise seams require this async boundary.
export async function finishCheckout(input: {
  readonly agentDir: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly path?: string;
  readonly checkoutId: string;
  readonly expectedHead: string;
  readonly store: RecordStore;
}): Promise<{ readonly checkoutId: string; readonly finished: true }> {
  const resolved = await resolveIdentity(input);

  if (input.checkoutId !== resolved.identity.checkoutId)
    throw new Error("Coordinator checkout ID does not match this session and repository.");

  await Effect.runPromise(
    cleanupCoordinatorCheckout(resolved.identity, resolved.sourcePath, input.expectedHead, () =>
      hasCheckoutDependencies(resolved.identity.managedPath, input.store.currentSessionAttempts()),
    ),
  );

  return { checkoutId: resolved.identity.checkoutId, finished: true };
}

function hasCheckoutDependencies(
  checkoutPath: string,
  snapshots: readonly SessionAttemptSnapshot[],
): boolean {
  return snapshots.some(({ task, attempt }) => {
    const target = task.task.target;

    const targetsCheckout =
      target.kind === "repository"
        ? target.checkoutRoot === checkoutPath
        : target.path === checkoutPath || target.path.startsWith(`${checkoutPath}/`);

    const workerBlocks =
      targetsCheckout &&
      ((attempt.worker === undefined && attempt.outcome === undefined) ||
        (attempt.worker !== undefined && attempt.worker.closed !== true));

    const output = attempt.output;

    const candidateBlocks =
      target.kind === "repository" &&
      target.checkoutRoot === checkoutPath &&
      task.task.contract.kind === "implementation" &&
      (output === undefined ||
        output.kind === "retained" ||
        output.kind === "applying" ||
        output.kind === "discarding" ||
        (output.kind === "applied" && output.cleanupTip !== undefined));

    return workerBlocks || candidateBlocks;
  });
}

// oxlint-disable-next-line effecttsgo/async-function -- Pi host callbacks and existing native Promise seams require this async boundary.
async function resolveIdentity(input: {
  readonly agentDir: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly path?: string;
}): Promise<ResolvedIdentity> {
  const resolved = await Effect.runPromise(
    Effect.gen(function* () {
      const request =
        input.path === undefined
          ? { cwd: input.cwd, kind: "repository" as const }
          : { cwd: input.cwd, path: input.path, kind: "repository" as const };

      const target = yield* resolveTaskTarget(request);

      if (target.target.kind !== "repository" || !("commit" in target))
        return yield* fail("resolve Coordinator checkout", "Repository target resolution failed.");

      return target;
    }),
  );

  const canonicalAgentDir = await realpath(input.agentDir);

  const checkoutId = createHash("sha256")
    .update(JSON.stringify([input.sessionId, resolved.target.commonDir]))
    .digest("hex");

  return {
    identity: {
      checkoutId,
      managedPath: canonicalFuturePath(
        join(canonicalAgentDir, "workgraph", "coordinator-checkouts", checkoutId),
      ),
      repositoryCommonDir: resolved.target.commonDir,
      ownedBranch: `refs/heads/pi-workgraph/coordinators/${checkoutId}`,
    },
    sourcePath: resolved.target.checkoutRoot,
    sourceHead: resolved.commit,
  };
}
