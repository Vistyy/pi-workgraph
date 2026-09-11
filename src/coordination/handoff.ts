import { randomUUID } from "node:crypto";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { Clock, Data, DateTime, Effect } from "effect";
import type { HandoffGrant } from "../domain/workstream.js";
import { HandoffSessionError, prepareHandoffSession, priorDiscussion } from "../handoff-session.js";
import type { HerdrCliRuntime } from "../herdr.js";
import type { WorkerIdentity } from "../herdr-identity.js";
import type { HandoffParentRecords } from "../storage/workstream-store.js";

export class HandoffGrantError extends Data.TaggedError("HandoffGrantError")<{
  readonly message: string;
}> {}

export interface OneShotHandoffRequest {
  readonly request: string;
  readonly includeContext: boolean;
  readonly toolCallId: string;
  readonly parentSession: Pick<SessionManager, "getBranch" | "getEntries">;
  readonly parent: HandoffParentRecords;
}

/**
 * Owns the complete one-shot Handoff decision and launch flow. It reads parent facts but never
 * persists a parent Task, checkpoint, retry claim, result channel, or completion obligation.
 */
export function launchOneShotHandoff(
  input: OneShotHandoffRequest,
  workers: HerdrCliRuntime,
): Effect.Effect<
  WorkerIdentity,
  | HandoffGrantError
  | HandoffSessionError
  | import("../herdr-launch.js").CoordinatorLaunchError
  | import("../herdr-protocol.js").HerdrProtocolError
> {
  return Effect.gen(function* () {
    const grant = yield* deriveGrant(input.parent, input.request);
    const discussion = input.includeContext
      ? yield* Effect.try({
          try: () => priorDiscussion(input.parentSession, input.toolCallId),
          catch: (cause) =>
            cause instanceof HandoffSessionError
              ? cause
              : new HandoffSessionError({
                  message: "Prior discussion capture failed.",
                  cause,
                }),
        })
      : [];
    const child = yield* prepareHandoffSession(
      grant.targetRepository.projectRoot,
      grant,
      discussion,
    );
    return yield* workers.launchCoordinator({
      cwd: grant.targetRepository.projectRoot,
      sessionFile: child.sessionFile,
    });
  });
}

function deriveGrant(
  parent: HandoffParentRecords,
  narrowedRequest: string,
): Effect.Effect<HandoffGrant, HandoffGrantError> {
  return Effect.gen(function* () {
    if (parent.lifecycle !== "active")
      return yield* new HandoffGrantError({
        message: "Only an active, unsuspended Workstream can issue a Handoff Grant.",
      });
    const parentIntentIndex = parent.currentIntentIndex;
    const intent = parent.currentIntent;
    const parentReceipt =
      intent.grounding.kind === "handoff_grant" ? intent.grounding.parentReceipt : intent.grounding;
    const issuedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    return {
      kind: "handoff_grant",
      id: `grant-${randomUUID()}`,
      parentReceipt: structuredClone(parentReceipt),
      parentWorkstreamId: parent.id,
      parentRepository: structuredClone(parent.repository),
      parentIntentIndex,
      parentIntentStatement: intent.statement,
      parentIntentConstraints: [...intent.constraints],
      narrowedRequest,
      targetRepository: structuredClone(parent.repository),
      issuedAt,
    };
  });
}
