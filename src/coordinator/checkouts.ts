/* oxlint-disable effecttsgo/async-function -- Pi callbacks are the Promise boundary around repository-owned Effects. */
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { canonicalFuturePath, fail, resolveTaskTarget } from "../repository/git.js";
import { ensureCoordinatorCheckout } from "./checkout-git.js";

export interface CheckoutFacts {
  readonly checkoutId: string;
  readonly managedPath: string;
  readonly repositoryCommonDir: string;
  readonly ownedBranch: string;
  readonly head: string;
  readonly created: boolean;
  readonly reused: boolean;
  readonly diagnostic?: string;
}

type Identity = Omit<CheckoutFacts, "head" | "created" | "reused" | "diagnostic">;

/** Keep Pi's async callback as the boundary around repository-owned Effects. */
export async function createCheckout(input: {
  readonly agentDir: string;
  readonly sessionId: string;
  readonly cwd: string;
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

  const receipt = await Effect.runPromise(
    ensureCoordinatorCheckout({ target: resolved.target, commit: resolved.commit, identity }),
  );

  return { ...identity, ...receipt };
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
