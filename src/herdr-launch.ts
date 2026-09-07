import { Clock, Data, DateTime, Effect } from "effect";
import type { HerdrObservation } from "./herdr.js";
import {
  decodeAgentResponse,
  decodeSuccessResponse,
  decodeTabCreateResponse,
} from "./herdr-decoder.js";
import { assertWorkerLaunchPlacement, parseAgent, resourceOf } from "./herdr-identity.js";
import { herdrWorkerName, herdrWorkerTabLabel, type WorkerRole } from "./herdr-naming.js";
import {
  type HerdrCommandTransport,
  type HerdrProtocolError,
  protocolTry,
} from "./herdr-protocol.js";
import type { ThinkingLevel, WorkerIdentity, WorkerResourceIdentity } from "./types.js";

export interface WorkerLaunchBaseRequest {
  workspaceId: string;
  runId: string;
  nodeId: string;
  attemptId: string;
  /** Naming context is optional for retained/custom transports; production launches provide it. */
  assignmentId?: string;
  objective?: string;
  role?: WorkerRole;
  cwd: string;
  sessionFile: string;
  prompt?: string;
  model?: string;
  thinking?: ThinkingLevel;
  env: Record<string, string>;
}

export interface WorkerPaneLocator {
  readonly workspaceId: string;
  readonly paneId: string;
}

export type WorkerLaunchLocator = WorkerPaneLocator | WorkerResourceIdentity;

/** Primary launch port. Checkpoint failures and requirements remain typed in the returned Effect. */
export interface WorkerLaunchEffectRequest<E = never, R = never> extends WorkerLaunchBaseRequest {
  onTab?: (tab: WorkerPaneLocator) => Effect.Effect<void, E, R>;
  onResource?: (resource: WorkerResourceIdentity) => Effect.Effect<void, E, R>;
  onIdentity?: (identity: WorkerIdentity) => Effect.Effect<void, E, R>;
  onSubmitted?: () => Effect.Effect<void, E, R>;
}

export class WorkerLaunchReadinessError extends Data.TaggedError("WorkerLaunchReadinessError")<{
  readonly resource: WorkerResourceIdentity;
  readonly message: string;
}> {
  constructor(resource: WorkerResourceIdentity, message: string) {
    super({ resource, message });
  }
}

export class WorkerLaunchError<Cause = unknown> extends Data.TaggedError("WorkerLaunchError")<{
  readonly phase: "onTab" | "onResource" | "onIdentity" | "onSubmitted";
  readonly locator: WorkerLaunchLocator;
  readonly resource: WorkerResourceIdentity | undefined;
  readonly cause: Cause;
}> {
  override get message(): string {
    return `Herdr worker launch ${this.phase} checkpoint failed.`;
  }
}

export interface CoordinatorLaunchRequest {
  cwd: string;
  sessionFile: string;
}

export interface CoordinatorLaunchResource {
  workspaceId: string;
  tabId: string;
  paneId: string;
  agentName: string;
  terminalId?: string;
  sessionFile: string;
  cwd: string;
}

export class CoordinatorLaunchError extends Data.TaggedError("CoordinatorLaunchError")<{
  readonly resource: CoordinatorLaunchResource | undefined;
  readonly message: string;
  readonly cause?: unknown;
}> {
  constructor(resource: CoordinatorLaunchResource | undefined, message: string, cause?: unknown) {
    super({ resource, message, cause });
  }
}

interface WorkerLaunchHost {
  readonly transport: HerdrCommandTransport;
  readonly awaitNativeIdentity: (
    resource: WorkerResourceIdentity,
    expectedSessionFile: string,
  ) => Effect.Effect<WorkerIdentity, HerdrProtocolError | WorkerLaunchReadinessError>;
  readonly observe: (
    identity: WorkerIdentity,
  ) => Effect.Effect<HerdrObservation, HerdrProtocolError>;
}

/** Owns worker launch sequencing and durable checkpoint handoffs. */
export class HerdrWorkerLauncher {
  constructor(private readonly host: WorkerLaunchHost) {}

  launch<E, R>(
    request: WorkerLaunchEffectRequest<E, R>,
  ): Effect.Effect<
    HerdrObservation,
    HerdrProtocolError | WorkerLaunchReadinessError | WorkerLaunchError<E>,
    R
  > {
    return Effect.gen(
      function* (this: HerdrWorkerLauncher) {
        const workerName = herdrWorkerName(request);
        const paneLocator = yield* checkpointAfterRemote(
          this.host.transport
            .call(
              [
                "tab",
                "create",
                "--workspace",
                request.workspaceId,
                "--cwd",
                request.cwd,
                "--label",
                herdrWorkerTabLabel(request),
                "--no-focus",
                ...envArgs(request.env),
              ],
              decodeTabCreateResponse,
            )
            .pipe(Effect.map((paneId) => ({ workspaceId: request.workspaceId, paneId }))),
          "onTab",
          request.onTab,
          (locator) => locator,
        );
        const args = [
          "agent",
          "start",
          workerName,
          "--kind",
          "pi",
          "--pane",
          paneLocator.paneId,
          "--",
          "--session",
          request.sessionFile,
        ];
        if (request.model !== undefined) args.push("--model", request.model);
        if (request.thinking !== undefined) args.push("--thinking", request.thinking);
        const resource = yield* checkpointAfterRemote(
          this.host.transport.call(args, decodeAgentResponse, 45_000).pipe(
            Effect.flatMap((decoded) =>
              protocolTry(args, () => {
                const started = parseAgent(decoded);
                assertWorkerLaunchPlacement(
                  {
                    workspaceId: request.workspaceId,
                    paneId: paneLocator.paneId,
                    agentName: workerName,
                    cwd: request.cwd,
                  },
                  started,
                );
                return resourceOf(started);
              }),
            ),
          ),
          "onResource",
          request.onResource,
          (value) => value,
        );
        const identity = yield* checkpointAfterRemote(
          this.host.awaitNativeIdentity(resource, request.sessionFile),
          "onIdentity",
          request.onIdentity,
          () => resource,
        );
        if (request.prompt !== undefined) {
          const onSubmitted = request.onSubmitted;
          yield* checkpointAfterRemote(
            this.host.transport.call(
              ["agent", "prompt", workerName, request.prompt],
              decodeSuccessResponse,
              15_000,
            ),
            "onSubmitted",
            onSubmitted === undefined ? undefined : () => onSubmitted(),
            () => resource,
          );
          return {
            identity,
            status: "working" as const,
            observedAt: yield* observedAt,
          };
        }
        return yield* this.host.observe(identity);
      }.bind(this),
    );
  }
}

function checkpointAfterRemote<A, E, R, Locator extends WorkerLaunchLocator>(
  remote: Effect.Effect<A, HerdrProtocolError | WorkerLaunchReadinessError, R>,
  phase: WorkerLaunchError["phase"],
  checkpoint: ((value: A) => Effect.Effect<void, E, R>) | undefined,
  locatorOf: (value: A) => Locator,
): Effect.Effect<A, HerdrProtocolError | WorkerLaunchReadinessError | WorkerLaunchError<E>, R> {
  return Effect.uninterruptibleMask((restore) =>
    restore(remote).pipe(
      Effect.flatMap((value) =>
        invokeCheckpoint(phase, checkpoint, value, locatorOf(value)).pipe(Effect.as(value)),
      ),
    ),
  );
}

function invokeCheckpoint<A, E, R>(
  phase: WorkerLaunchError["phase"],
  checkpoint: ((value: A) => Effect.Effect<void, E, R>) | undefined,
  value: A,
  locator: WorkerLaunchLocator,
): Effect.Effect<void, WorkerLaunchError<E>, R> {
  if (checkpoint === undefined) return Effect.void;
  return checkpoint(value).pipe(
    Effect.mapError(
      (cause) =>
        new WorkerLaunchError({
          phase,
          locator,
          resource: "terminalId" in locator ? locator : undefined,
          cause,
        }),
    ),
  );
}

function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

const observedAt = Clock.currentTimeMillis.pipe(
  Effect.map((timestamp) => DateTime.formatIso(DateTime.makeUnsafe(timestamp))),
);
