import { Clock, Data, DateTime, Effect, Schedule } from "effect";
import {
  decodeAgent,
  decodeAgentResponse,
  decodeCoordinatorAgentResponse,
  decodeCoordinatorSnapshotResponse,
  decodePaneResponse,
  decodeProcessInfoResponse,
  decodeSnapshotResponse,
  decodeSuccessResponse,
  decodeWorkspaceCreateResponse,
} from "./herdr-decoder.js";
import {
  assertCoordinatorPlacement,
  assertIdentity,
  assertResource,
  identityOf,
  type ParsedAgent,
  parseAgent,
  parseCoordinator,
  resourceOf,
} from "./herdr-identity.js";
import {
  CoordinatorLaunchError,
  type CoordinatorLaunchRequest,
  type CoordinatorLaunchResource,
  HerdrWorkerLauncher,
  type WorkerLaunchEffectRequest,
  type WorkerLaunchError,
  WorkerLaunchReadinessError,
} from "./herdr-launch.js";
import { herdrCoordinatorNames } from "./herdr-naming.js";
import {
  decodeInspection,
  type HerdrCommandResult,
  HerdrCommandTransport,
  type HerdrProtocolError,
  isNotFound,
  protocolCommandError,
  protocolDecode,
  protocolError,
  protocolFailure,
  protocolTry,
} from "./herdr-protocol.js";

export { WorkerLaunchPlacementError } from "./herdr-identity.js";
export {
  CoordinatorLaunchError,
  type CoordinatorLaunchRequest,
  type CoordinatorLaunchResource,
  type WorkerLaunchEffectRequest,
  WorkerLaunchError,
  WorkerLaunchReadinessError,
} from "./herdr-launch.js";
export type { WorkerNamingContext, WorkerRole } from "./herdr-naming.js";
export {
  herdrCoordinatorNames,
  herdrWorkerName,
  herdrWorkerTabLabel,
} from "./herdr-naming.js";
export { HERDR_PROTOCOL_OUTPUT_LIMIT, HerdrProtocolError } from "./herdr-protocol.js";

import type {
  CoordinatorRuntimeIdentity,
  WorkerIdentity,
  WorkerObservationStatus,
  WorkerResourceIdentity,
} from "./types.js";

export type HerdrAgentStatus = WorkerObservationStatus;

export interface HerdrObservation {
  identity: WorkerIdentity;
  status: HerdrAgentStatus;
  observedAt: string;
}

export interface HerdrAbsentObservation {
  identity: WorkerIdentity;
  status: "absent";
  observedAt: string;
  detail: string;
}

export type HerdrInspection = HerdrObservation | HerdrAbsentObservation;

export interface WorkerRecoveryRequest {
  workspaceId: string;
  agentName: string;
  sessionFile: string;
  cwd: string;
  resource?: WorkerResourceIdentity;
}

/** Exact retained handles for startup inspection before a native agent identity exists. */
export interface WorkerLaunchInspectionRequest {
  workspaceId: string;
  /** Present when startup advanced far enough to retain the full native resource. */
  tabId?: string;
  paneId: string;
  /** Present when startup advanced far enough to retain the full native resource. */
  terminalId?: string;
  sessionFile: string;
  cwd: string;
}

export interface WorkerPaneObservation {
  workspaceId: string;
  tabId: string;
  paneId: string;
  terminalId: string;
  cwd: string;
}

export interface WorkerProcessObservation {
  shellPid: number;
  foregroundProcessGroupId: number;
  foregroundProcesses: readonly WorkerForegroundProcess[];
}

export type WorkerForegroundProcess = string | { readonly name?: string; readonly pid?: number };

export type WorkerLaunchAgentEvidence =
  | { state: "present"; identity: WorkerIdentity; status: HerdrAgentStatus }
  | { state: "absent"; detail: string }
  | { state: "unknown"; detail: string };

export type WorkerLaunchProcessEvidence =
  | { state: "observed"; process: WorkerProcessObservation }
  | { state: "unknown"; detail: string };

export interface WorkerLaunchInspectionEvidence {
  resource: WorkerLaunchInspectionRequest;
  pane: WorkerPaneObservation | { state: "absent" | "unknown"; detail: string };
  process: WorkerLaunchProcessEvidence;
  agent: WorkerLaunchAgentEvidence;
}

export type WorkerLaunchInspection =
  | {
      state: "live";
      identity: WorkerIdentity;
      evidence: WorkerLaunchInspectionEvidence;
      detail: string;
    }
  | {
      state: "absent" | "unknown";
      evidence: WorkerLaunchInspectionEvidence;
      detail: string;
    };

export interface CoordinatorObservationRequest {
  paneId: string;
  sessionFile: string;
  cwd: string;
}

export interface WorkerCleanupResult {
  state: "pending" | "completed" | "blocked";
  identity: WorkerIdentity;
  observedAt: string;
  detail: string;
}

export interface HerdrEffects {
  readonly launchCoordinator: (
    request: CoordinatorLaunchRequest,
  ) => Effect.Effect<WorkerIdentity, CoordinatorLaunchError | HerdrProtocolError>;
  readonly coordinatorLiveness: (
    sessionFile: string,
  ) => Effect.Effect<"alive" | "dead" | "unknown", HerdrProtocolError>;
  readonly observeCurrentCoordinator: (
    request: CoordinatorObservationRequest,
  ) => Effect.Effect<CoordinatorRuntimeIdentity, HerdrProtocolError>;
  readonly launch: <E, R>(
    request: WorkerLaunchEffectRequest<E, R>,
  ) => Effect.Effect<
    HerdrObservation,
    HerdrProtocolError | WorkerLaunchReadinessError | WorkerLaunchError<E>,
    R
  >;
  readonly recover: (
    request: WorkerRecoveryRequest,
  ) => Effect.Effect<HerdrObservation | undefined, HerdrProtocolError | WorkerLaunchReadinessError>;
  readonly inspectLaunch: (
    request: WorkerLaunchInspectionRequest,
  ) => Effect.Effect<WorkerLaunchInspection, HerdrProtocolError>;
  readonly inspect: (
    identity: WorkerIdentity,
  ) => Effect.Effect<HerdrInspection, HerdrProtocolError>;
  readonly observe: (
    identity: WorkerIdentity,
  ) => Effect.Effect<HerdrObservation, HerdrProtocolError>;
  readonly interrupt: (
    identity: WorkerIdentity,
  ) => Effect.Effect<HerdrObservation, HerdrProtocolError>;
  readonly steer: (
    identity: WorkerIdentity,
    instruction: string,
  ) => Effect.Effect<void, HerdrProtocolError>;
  readonly cleanup: (
    identity: WorkerIdentity,
  ) => Effect.Effect<WorkerCleanupResult, HerdrProtocolError>;
}

interface HerdrProcessEnvironment extends NodeJS.ProcessEnv {
  HERDR_ENV?: string;
  HERDR_WORKSPACE_ID?: string;
  PI_CODING_AGENT_DIR?: string;
  PI_WORKGRAPH_HERDR_BIN?: string;
}

interface CoordinatorEnvironment extends Record<string, string> {
  PI_CODING_AGENT_DIR?: string;
}

const hostEnvironment: HerdrProcessEnvironment = process.env;

export class HerdrCliRuntime {
  readonly available: boolean;
  readonly effects: HerdrEffects;
  private readonly coordinatorEnvironment: Record<string, string>;
  private readonly transport: HerdrCommandTransport;
  private readonly workerLauncher: HerdrWorkerLauncher;

  constructor(
    command = hostEnvironment.PI_WORKGRAPH_HERDR_BIN ?? "herdr",
    env: NodeJS.ProcessEnv = hostEnvironment,
  ) {
    const herdrEnvironment: HerdrProcessEnvironment = env;
    this.available =
      herdrEnvironment.HERDR_ENV === "1" && herdrEnvironment.HERDR_WORKSPACE_ID !== undefined;
    this.coordinatorEnvironment = coordinatorEnvironment(herdrEnvironment);
    this.transport = new HerdrCommandTransport(command);
    this.workerLauncher = new HerdrWorkerLauncher({
      transport: this.transport,
      awaitNativeIdentity: (resource, sessionFile) =>
        this.awaitNativeIdentity(resource, sessionFile),
      observe: (identity) => this.observeEffect(identity),
    });
    this.effects = {
      launchCoordinator: (request) => this.launchCoordinatorEffect(request),
      coordinatorLiveness: (sessionFile) => this.coordinatorLivenessEffect(sessionFile),
      observeCurrentCoordinator: (request) => this.observeCurrentCoordinatorEffect(request),
      launch: (request) => this.launchEffect(request),
      recover: (request) => this.recoverEffect(request),
      inspectLaunch: (request) => this.inspectLaunchEffect(request),
      inspect: (identity) => this.inspectEffect(identity),
      observe: (identity) => this.observeEffect(identity),
      interrupt: (identity) => this.interruptEffect(identity),
      steer: (identity, instruction) => this.steerEffect(identity, instruction),
      cleanup: (identity) => this.cleanupEffect(identity),
    };
  }

  private launchCoordinatorEffect(
    request: CoordinatorLaunchRequest,
  ): Effect.Effect<WorkerIdentity, CoordinatorLaunchError | HerdrProtocolError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        yield* this.requireAvailable("coordinator");
        const { agentName, label } = herdrCoordinatorNames(request);
        const created = yield* this.transport
          .call(
            [
              "workspace",
              "create",
              "--cwd",
              request.cwd,
              "--label",
              label,
              "--no-focus",
              ...envArgs(this.coordinatorEnvironment),
            ],
            decodeWorkspaceCreateResponse,
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new CoordinatorLaunchError(
                  undefined,
                  `Coordinator workspace creation is uncertain for session ${request.sessionFile} at ${request.cwd} with exact label ${JSON.stringify(label)}: ${cause.message} Inspect that label before retrying; no tab fallback or cleanup was attempted.`,
                  cause,
                ),
            ),
          );
        const resource: CoordinatorLaunchResource = {
          workspaceId: created.workspaceId,
          tabId: created.tabId,
          paneId: created.paneId,
          agentName,
          sessionFile: request.sessionFile,
          cwd: request.cwd,
        };
        let retainedResource = resource;
        const launched = Effect.gen(
          function* (this: HerdrCliRuntime) {
            const started = yield* this.transport
              .call(
                [
                  "agent",
                  "start",
                  agentName,
                  "--kind",
                  "pi",
                  "--pane",
                  resource.paneId,
                  "--",
                  "--session",
                  request.sessionFile,
                ],
                decodeAgentResponse,
                45_000,
              )
              .pipe(
                Effect.flatMap((agent) => protocolTry(["agent", "start"], () => parseAgent(agent))),
              );
            yield* protocolTry(["agent", "start"], () =>
              assertCoordinatorPlacement(resource, started),
            );
            const startedResource = resourceOf(started);
            retainedResource = { ...resource, terminalId: startedResource.terminalId };
            return yield* this.awaitNativeIdentity(startedResource, request.sessionFile);
          }.bind(this),
        );
        return yield* launched.pipe(
          Effect.mapError(
            (cause) =>
              new CoordinatorLaunchError(
                retainedResource,
                `Coordinator launch is uncertain in workspace ${resource.workspaceId}, tab ${resource.tabId}, pane ${resource.paneId}, agent ${agentName}, session ${request.sessionFile}, cwd ${request.cwd}: ${cause.message} Inspect these exact handles before retrying; the workspace was retained.`,
                cause,
              ),
          ),
        );
      }.bind(this),
    );
  }

  private coordinatorLivenessEffect(
    sessionFile: string,
  ): Effect.Effect<"alive" | "dead" | "unknown", HerdrProtocolError> {
    if (!this.available) return Effect.succeed("unknown");
    return this.transport.call(["api", "snapshot"], decodeCoordinatorSnapshotResponse).pipe(
      Effect.map((sessionFiles) => {
        let unknown = false;
        for (const sessionFileValue of sessionFiles) {
          if (sessionFileValue === undefined) unknown = true;
          else if (sessionFileValue === sessionFile) return "alive" as const;
        }
        return unknown ? ("unknown" as const) : ("dead" as const);
      }),
    );
  }

  private observeCurrentCoordinatorEffect(
    request: CoordinatorObservationRequest,
  ): Effect.Effect<CoordinatorRuntimeIdentity, HerdrProtocolError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        yield* this.requireAvailable("coordinator");
        const decoded = yield* this.transport.call(
          ["agent", "get", request.paneId],
          decodeCoordinatorAgentResponse,
        );
        const current = yield* protocolTry(["agent", "get"], () => parseCoordinator(decoded));
        yield* protocolTry(["agent", "get"], () => {
          if (current.sessionFile !== request.sessionFile)
            throw new Error("Current Herdr pane does not own the requested Pi session.");
          if (current.cwd !== request.cwd)
            throw new Error("Current Herdr pane cwd does not match the repository.");
        });
        return current;
      }.bind(this),
    );
  }

  private launchEffect<E, R>(
    request: WorkerLaunchEffectRequest<E, R>,
  ): Effect.Effect<
    HerdrObservation,
    HerdrProtocolError | WorkerLaunchReadinessError | WorkerLaunchError<E>,
    R
  > {
    return this.requireAvailable("worker").pipe(
      Effect.andThen(this.workerLauncher.launch(request)),
    );
  }

  private recoverEffect(
    request: WorkerRecoveryRequest,
  ): Effect.Effect<HerdrObservation | undefined, HerdrProtocolError | WorkerLaunchReadinessError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        const agents = yield* this.transport.call(["api", "snapshot"], decodeSnapshotResponse);
        const matches = agents.filter((candidate) => {
          if (candidate.name === undefined) return false;
          const sessionFile = candidate.agent_session?.value;
          const resource = request.resource;
          const resourceMatches = resource
            ? candidate.workspace_id === resource.workspaceId &&
              candidate.tab_id === resource.tabId &&
              candidate.pane_id === resource.paneId &&
              candidate.terminal_id === resource.terminalId &&
              candidate.name === resource.agentName &&
              candidate.cwd === resource.cwd
            : candidate.workspace_id === request.workspaceId &&
              candidate.name === request.agentName &&
              candidate.cwd === request.cwd;
          return (
            resourceMatches &&
            (resource
              ? sessionFile === undefined || sessionFile === request.sessionFile
              : sessionFile === request.sessionFile)
          );
        });
        if (matches.length === 0) return undefined;
        if (matches.length !== 1)
          return yield* protocolFailure(
            ["api", "snapshot"],
            "identity",
            `Herdr recovery found ${matches.length} workers for ${request.agentName}.`,
          );
        const match = matches[0];
        if (match === undefined) return undefined;
        const current = yield* protocolTry(["api", "snapshot"], () =>
          parseAgent(decodeAgent(match)),
        );
        const resource = request.resource ?? resourceOf(current);
        yield* protocolTry(["api", "snapshot"], () => assertResource(resource, current));
        if (current.sessionFile === undefined)
          return yield* new WorkerLaunchReadinessError(
            resource,
            "Recovered Herdr resource still has no native Pi session identity; operator action is required before assignment submission.",
          );
        const identity = identityOf(resource, current);
        yield* protocolTry(["api", "snapshot"], () => assertIdentity(identity, current));
        return { identity, status: current.status, observedAt: yield* observedAt };
      }.bind(this),
    );
  }

  private inspectLaunchEffect(
    request: WorkerLaunchInspectionRequest,
  ): Effect.Effect<WorkerLaunchInspection, HerdrProtocolError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        const paneResult = yield* this.spawnCommand(["pane", "get", request.paneId], 30_000);
        if (paneResult.code !== 0) return unavailablePaneInspection(request, paneResult);
        const decoded = yield* decodeInspection(paneResult, ["pane", "get"], decodePaneResponse);
        if (decoded._tag === "InvalidInspection")
          return invalidPaneInspection(request, decoded.message);
        const pane: WorkerPaneObservation = decoded.value;
        const evidence = initialLaunchEvidence(request, pane);
        if (!samePaneResource(request, pane)) {
          const detail = "Retained Herdr pane identity or cwd does not match startup state.";
          return { state: "unknown" as const, evidence, detail };
        }
        evidence.process = yield* this.inspectLaunchProcess(request.paneId);
        return yield* this.inspectLaunchAgent(request, pane, evidence);
      }.bind(this),
    );
  }

  private inspectLaunchProcess(
    paneId: string,
  ): Effect.Effect<WorkerLaunchProcessEvidence, HerdrProtocolError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        const result = yield* this.spawnCommand(["pane", "process-info", "--pane", paneId], 30_000);
        if (result.code !== 0)
          return {
            state: "unknown" as const,
            detail:
              "Herdr pane process information was unavailable; no process conclusion was made.",
          };
        const decoded = yield* decodeInspection(
          result,
          ["pane", "process-info"],
          decodeProcessInfoResponse,
        );
        if (decoded._tag === "InvalidInspection")
          return {
            state: "unknown" as const,
            detail: `Herdr pane process information had an invalid shape: ${decoded.message}`,
          };
        return { state: "observed" as const, process: decoded.value };
      }.bind(this),
    );
  }

  private inspectLaunchAgent(
    request: WorkerLaunchInspectionRequest,
    pane: WorkerPaneObservation,
    evidence: WorkerLaunchInspectionEvidence,
  ): Effect.Effect<WorkerLaunchInspection, HerdrProtocolError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        const result = yield* this.spawnCommand(["agent", "get", request.paneId], 30_000);
        if (result.code !== 0) return unavailableLaunchAgent(result, evidence);
        const decoded = yield* decodeInspection(result, ["agent", "get"], decodeAgentResponse);
        if (decoded._tag === "InvalidInspection") {
          evidence.agent = {
            state: "unknown",
            detail: `Herdr native agent response was invalid: ${decoded.message}`,
          };
          return { state: "unknown" as const, evidence, detail: evidence.agent.detail };
        }
        const current = parseAgent(decoded.value);
        if (!sameLaunchAgent(request, pane, current)) {
          evidence.agent = {
            state: "unknown",
            detail: "Herdr native agent identity does not match the retained startup resource.",
          };
          return { state: "unknown" as const, evidence, detail: evidence.agent.detail };
        }
        const identity: WorkerIdentity = {
          workspaceId: current.workspaceId,
          tabId: current.tabId,
          paneId: current.paneId,
          terminalId: current.terminalId,
          agentName: current.name,
          sessionFile: request.sessionFile,
          cwd: request.cwd,
        };
        evidence.agent = { state: "present", identity, status: current.status };
        return {
          state: "live" as const,
          identity,
          evidence,
          detail: "Exact retained pane and native Pi session identity are live.",
        };
      }.bind(this),
    );
  }

  private awaitNativeIdentity(
    resource: WorkerResourceIdentity,
    expectedSessionFile: string,
    timeoutMs = 15_000,
  ): Effect.Effect<WorkerIdentity, HerdrProtocolError | WorkerLaunchReadinessError> {
    let last = "Native Pi session identity is not available yet.";
    const poll = Effect.gen(
      function* (this: HerdrCliRuntime) {
        const decoded = yield* this.transport.call(
          ["agent", "get", resource.paneId],
          decodeAgentResponse,
        );
        const current = yield* protocolTry(["agent", "get"], () => parseAgent(decoded));
        yield* protocolTry(["agent", "get"], () => assertResource(resource, current));
        if (current.sessionFile !== undefined) {
          const identity = identityOf(resource, current);
          yield* protocolTry(["agent", "get"], () =>
            assertIdentity({ ...identity, sessionFile: expectedSessionFile }, current),
          );
          return identity;
        }
        if (current.status === "blocked")
          return yield* new WorkerLaunchReadinessError(
            resource,
            "Worker is blocked at a Pi trust or approval prompt; operator action is required before assignment submission.",
          );
        last = `Worker is ${current.status}, but Herdr has not exposed its native Pi session identity.`;
        return yield* new NativeIdentityPending();
      }.bind(this),
    );
    return poll.pipe(
      Effect.retry({
        schedule: Schedule.spaced(250),
        while: (error) => error instanceof NativeIdentityPending,
      }),
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(
            new WorkerLaunchReadinessError(
              resource,
              `${last} Launch readiness timed out after ${timeoutMs}ms. No assignment prompt was submitted.`,
            ),
          ),
      }),
      Effect.catchTag("NativeIdentityPending", () =>
        Effect.fail(
          new WorkerLaunchReadinessError(
            resource,
            `${last} Launch readiness timed out after ${timeoutMs}ms. No assignment prompt was submitted.`,
          ),
        ),
      ),
    );
  }

  private inspectEffect(
    identity: WorkerIdentity,
  ): Effect.Effect<HerdrInspection, HerdrProtocolError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        const result = yield* this.spawnCommand(["agent", "get", identity.paneId], 30_000);
        if (result.code !== 0) {
          if (
            (isNotFound(result, "agent_not_found") || isNotFound(result, "pane_not_found")) &&
            (yield* this.tabAbsent(identity.tabId))
          )
            return {
              identity,
              status: "absent" as const,
              observedAt: yield* observedAt,
              detail: `Exact Herdr tab ${identity.tabId} is absent.`,
            };
          return yield* protocolCommandError(["agent", "get", identity.paneId], result);
        }
        const decoded = yield* protocolDecode(
          result,
          ["agent", "get", identity.paneId],
          decodeAgentResponse,
        );
        const current = parseAgent(decoded);
        yield* protocolTry(["agent", "get"], () => assertIdentity(identity, current));
        return { identity, status: current.status, observedAt: yield* observedAt };
      }.bind(this),
    );
  }

  private observeEffect(
    identity: WorkerIdentity,
  ): Effect.Effect<HerdrObservation, HerdrProtocolError> {
    return this.inspectEffect(identity).pipe(
      Effect.filterOrFail(
        (inspection): inspection is HerdrObservation => inspection.status !== "absent",
        (inspection) =>
          protocolError(
            ["agent", "get"],
            "identity",
            inspection.status === "absent" ? inspection.detail : "Herdr worker is absent.",
          ),
      ),
    );
  }

  private interruptEffect(
    identity: WorkerIdentity,
  ): Effect.Effect<HerdrObservation, HerdrProtocolError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        yield* this.observeEffect(identity);
        yield* this.transport.call(
          ["agent", "send-keys", identity.agentName, "esc"],
          decodeSuccessResponse,
        );
        return yield* this.observeEffect(identity);
      }.bind(this),
    );
  }

  private steerEffect(
    identity: WorkerIdentity,
    instruction: string,
  ): Effect.Effect<void, HerdrProtocolError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        const trimmed = instruction.trim();
        if (!trimmed)
          return yield* protocolFailure(
            ["agent", "prompt"],
            "identity",
            "Worker steering requires an instruction.",
          );
        const current = yield* this.observeEffect(identity);
        if (current.status === "blocked")
          return yield* protocolFailure(
            ["agent", "prompt"],
            "identity",
            "Worker is blocked and cannot receive steering.",
          );
        yield* this.transport.call(
          ["agent", "prompt", identity.agentName, trimmed],
          decodeSuccessResponse,
        );
      }.bind(this),
    );
  }

  private cleanupEffect(
    identity: WorkerIdentity,
  ): Effect.Effect<WorkerCleanupResult, HerdrProtocolError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        const observation = yield* this.inspectEffect(identity);
        if (observation.status === "absent")
          return {
            state: "completed" as const,
            identity,
            observedAt: observation.observedAt,
            detail: observation.detail,
          };
        if (observation.status === "working")
          return {
            state: "pending" as const,
            identity,
            observedAt: observation.observedAt,
            detail: "Worker is still working; exact cleanup remains pending.",
          };
        if (observation.status === "blocked" || observation.status === "unknown")
          return {
            state: "blocked" as const,
            identity,
            observedAt: observation.observedAt,
            detail: `Worker is ${observation.status}; cleanup requires a verified idle or done worker.`,
          };
        yield* this.transport.call(["tab", "close", identity.tabId], decodeSuccessResponse);
        if (!(yield* this.tabAbsent(identity.tabId)))
          return yield* protocolFailure(
            ["tab", "get"],
            "identity",
            `Herdr tab ${identity.tabId} still exists after cleanup.`,
          );
        return {
          state: "completed" as const,
          identity,
          observedAt: yield* observedAt,
          detail: `Closed and verified exact Herdr tab ${identity.tabId}.`,
        };
      }.bind(this),
    );
  }

  private tabAbsent(tabId: string): Effect.Effect<boolean, HerdrProtocolError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        const result = yield* this.spawnCommand(["tab", "get", tabId], 30_000);
        if (result.code === 0) return false;
        if (isNotFound(result, "tab_not_found")) return true;
        return yield* protocolCommandError(["tab", "get", tabId], result);
      }.bind(this),
    );
  }

  private spawnCommand(
    args: string[],
    timeoutMs: number,
  ): Effect.Effect<HerdrCommandResult, HerdrProtocolError> {
    return this.transport.spawn(args, timeoutMs);
  }

  private requireAvailable(
    kind: "coordinator" | "worker",
  ): Effect.Effect<void, HerdrProtocolError> {
    return this.available
      ? Effect.void
      : protocolFailure([], "unavailable", `Herdr ${kind} runtime is unavailable.`);
  }
}

function initialLaunchEvidence(
  request: WorkerLaunchInspectionRequest,
  pane: WorkerPaneObservation,
): WorkerLaunchInspectionEvidence {
  return {
    resource: request,
    pane,
    process: {
      state: "unknown",
      detail: "Herdr pane process information was not observed.",
    },
    agent: {
      state: "unknown",
      detail: "Herdr agent identity was not observed.",
    },
  };
}

function unavailablePaneInspection(
  request: WorkerLaunchInspectionRequest,
  result: HerdrCommandResult,
): WorkerLaunchInspection {
  const state = isNotFound(result, "pane_not_found") ? "absent" : "unknown";
  const detail =
    state === "absent"
      ? `Exact Herdr pane ${request.paneId} is absent.`
      : "Herdr pane inspection failed; retained startup state is unknown.";
  return {
    state,
    evidence: {
      resource: request,
      pane: { state, detail },
      process: {
        state: "unknown",
        detail: "Herdr pane process information was not observed.",
      },
      agent: {
        state: "unknown",
        detail: "Herdr agent identity was not observed.",
      },
    },
    detail,
  };
}

function invalidPaneInspection(
  request: WorkerLaunchInspectionRequest,
  error: string,
): WorkerLaunchInspection {
  const detail = `Herdr pane inspection returned an invalid retained-resource shape: ${error}`;
  return {
    state: "unknown",
    evidence: {
      resource: request,
      pane: { state: "unknown", detail },
      process: {
        state: "unknown",
        detail: "Herdr pane process information was not observed.",
      },
      agent: {
        state: "unknown",
        detail: "Herdr agent identity was not observed.",
      },
    },
    detail,
  };
}

function unavailableLaunchAgent(
  result: HerdrCommandResult,
  evidence: WorkerLaunchInspectionEvidence,
): WorkerLaunchInspection {
  evidence.agent = isNotFound(result, "agent_not_found")
    ? {
        state: "absent",
        detail:
          "Herdr reports no agent identity for this pane. This is not proof that the pane has no process.",
      }
    : {
        state: "unknown",
        detail: "Herdr agent inspection failed; no identity conclusion was made.",
      };
  return {
    state: "unknown",
    evidence,
    detail:
      "The exact retained pane is live, but native agent identity is absent or unknown; no relaunch or cleanup is authorized.",
  };
}

function sameLaunchAgent(
  request: WorkerLaunchInspectionRequest,
  pane: WorkerPaneObservation,
  current: ParsedAgent,
): boolean {
  return (
    current.workspaceId === pane.workspaceId &&
    current.tabId === pane.tabId &&
    current.paneId === pane.paneId &&
    current.terminalId === pane.terminalId &&
    current.cwd === pane.cwd &&
    current.sessionFile === request.sessionFile
  );
}

function samePaneResource(
  request: WorkerLaunchInspectionRequest,
  pane: WorkerPaneObservation,
): boolean {
  return (
    pane.workspaceId === request.workspaceId &&
    (request.tabId === undefined || pane.tabId === request.tabId) &&
    pane.paneId === request.paneId &&
    (request.terminalId === undefined || pane.terminalId === request.terminalId) &&
    pane.cwd === request.cwd
  );
}

function coordinatorEnvironment(env: HerdrProcessEnvironment) {
  const result: CoordinatorEnvironment = {};
  const agentDirectory = env.PI_CODING_AGENT_DIR;
  if (agentDirectory !== undefined && agentDirectory !== "")
    result.PI_CODING_AGENT_DIR = agentDirectory;
  for (const key of [
    "PI_WORKGRAPH_MODE",
    "PI_WORKGRAPH_RUN_ID",
    "PI_WORKGRAPH_NODE_ID",
    "PI_WORKGRAPH_BASE_COMMIT",
    "PI_WORKGRAPH_EXPERIMENT",
    "PI_WORKGRAPH_IMPLEMENTATION_START",
    "PI_WORKGRAPH_EXECUTOR_MODEL",
    "PI_WORKGRAPH_EXECUTOR_THINKING",
  ])
    result[key] = "";
  return result;
}

function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

class NativeIdentityPending extends Data.TaggedError("NativeIdentityPending") {}

const observedAt = Clock.currentTimeMillis.pipe(
  Effect.map((timestamp) => DateTime.formatIso(DateTime.makeUnsafe(timestamp))),
);
