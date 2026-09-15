/* oxlint-disable effecttsgo/async-function, anti-slop/require-readable-spacing -- Pi callbacks are the Promise boundary around repository-owned Effects. */
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { ensureCoordinatorCheckout, resolveCoordinatorRepository } from "../repository.js";

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
  const resolved = await Effect.runPromise(resolveCoordinatorRepository(input.cwd, input.path));
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
    .update(frame(sessionId))
    .update(frame(commonDir))
    .digest("hex");

  return {
    checkoutId,
    managedPath: join(canonicalAgentDir, "workgraph", "coordinator-checkouts", checkoutId),
    repositoryCommonDir: commonDir,
    ownedBranch: `refs/heads/pi-workgraph/coordinators/${checkoutId}`,
  };
}

function frame(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));

  return Buffer.concat([length, bytes]);
}
