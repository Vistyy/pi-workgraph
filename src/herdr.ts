import { Clock, Data, DateTime, Effect, Schedule } from "effect";
import {
  decodeAgent,
  decodeAgentResponse,
  decodeCoordinatorAgentResponse,
  decodeCoordinatorSnapshotResponse,
  decodeErrorResponse,
  decodePaneResponse,
  decodeProcessInfoResponse,
  decodeSnapshotResponse,
  decodeSuccessResponse,
  decodeTabCreateResponse,
  decodeWorkspaceCreateResponse,
  type HerdrAgent,
  type HerdrCoordinatorAgent,
} from "./herdr-decoder.js";
import {
  herdrCoordinatorNames,
  herdrWorkerName,
  herdrWorkerTabLabel,
  type WorkerRole,
} from "./herdr-naming.js";
import { processEffect } from "./process.js";

export type { WorkerNamingContext, WorkerRole } from "./herdr-naming.js";
export {
  herdrAgentName,
  herdrCoordinatorNames,
  herdrWorkerName,
  herdrWorkerTabLabel,
  legacyHerdrAgentName,
  legacyObjectiveHerdrWorkerName,
} from "./herdr-naming.js";

import type {
  CoordinatorRuntimeIdentity,
  ThinkingLevel,
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

export interface WorkerLaunchRequest {
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
  onTab?: (tab: { workspaceId: string; paneId: string }) => void | Promise<void>;
  onResource?: (resource: WorkerResourceIdentity) => void | Promise<void>;
  onIdentity?: (identity: WorkerIdentity) => void | Promise<void>;
  onSubmitted?: () => void | Promise<void>;
}

export interface WorkerRecoveryRequest {
  workspaceId: string;
  agentName: string;
  compatibleAgentNames?: readonly string[];
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

export class WorkerLaunchReadinessError extends Data.TaggedError("WorkerLaunchReadinessError")<{
  readonly resource: WorkerResourceIdentity;
  readonly message: string;
}> {
  constructor(resource: WorkerResourceIdentity, message: string) {
    super({ resource, message });
  }
}

export class WorkerLaunchError extends Data.TaggedError("WorkerLaunchError")<{
  readonly phase: "onTab" | "onResource" | "onIdentity" | "onSubmitted";
  readonly resource?: WorkerResourceIdentity;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Herdr worker launch ${this.phase} callback failed.`;
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

export class HerdrProtocolError extends Data.TaggedError("HerdrProtocolError")<{
  readonly operation: string;
  readonly reason: "process" | "command" | "overflow" | "malformed" | "identity" | "unavailable";
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.detail;
  }
}

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

export interface VisibleWorkerRuntime {
  readonly available: boolean;
  launch(request: WorkerLaunchRequest): Promise<HerdrObservation>;
  recover?(request: WorkerRecoveryRequest): Promise<HerdrObservation | undefined>;
  inspectLaunch?(request: WorkerLaunchInspectionRequest): Promise<WorkerLaunchInspection>;
  inspect(identity: WorkerIdentity): Promise<HerdrInspection>;
  observe(identity: WorkerIdentity): Promise<HerdrObservation>;
  interrupt(identity: WorkerIdentity): Promise<HerdrObservation>;
  steer?(identity: WorkerIdentity, instruction: string): Promise<void>;
  cleanup?(identity: WorkerIdentity): Promise<WorkerCleanupResult>;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
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
  readonly launch: (
    request: WorkerLaunchRequest,
  ) => Effect.Effect<
    HerdrObservation,
    HerdrProtocolError | WorkerLaunchReadinessError | WorkerLaunchError
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

export class HerdrCliRuntime implements VisibleWorkerRuntime {
  readonly available: boolean;
  readonly effects: HerdrEffects;
  private readonly coordinatorEnvironment: Record<string, string>;

  constructor(
    private readonly command = hostEnvironment.PI_WORKGRAPH_HERDR_BIN ?? "herdr",
    env: NodeJS.ProcessEnv = hostEnvironment,
  ) {
    const herdrEnvironment: HerdrProcessEnvironment = env;
    this.available =
      herdrEnvironment.HERDR_ENV === "1" && herdrEnvironment.HERDR_WORKSPACE_ID !== undefined;
    this.coordinatorEnvironment = coordinatorEnvironment(herdrEnvironment);
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

  launchCoordinator(request: CoordinatorLaunchRequest): Promise<WorkerIdentity> {
    return Effect.runPromise(this.effects.launchCoordinator(request));
  }

  coordinatorLiveness(sessionFile: string): Promise<"alive" | "dead" | "unknown"> {
    return Effect.runPromise(this.effects.coordinatorLiveness(sessionFile));
  }

  observeCurrentCoordinator(
    request: CoordinatorObservationRequest,
  ): Promise<CoordinatorRuntimeIdentity> {
    return Effect.runPromise(this.effects.observeCurrentCoordinator(request));
  }

  launch(request: WorkerLaunchRequest): Promise<HerdrObservation> {
    return Effect.runPromise(this.effects.launch(request));
  }

  recover(request: WorkerRecoveryRequest): Promise<HerdrObservation | undefined> {
    return Effect.runPromise(this.effects.recover(request));
  }

  inspectLaunch(request: WorkerLaunchInspectionRequest): Promise<WorkerLaunchInspection> {
    return Effect.runPromise(this.effects.inspectLaunch(request));
  }

  inspect(identity: WorkerIdentity): Promise<HerdrInspection> {
    return Effect.runPromise(this.effects.inspect(identity));
  }

  observe(identity: WorkerIdentity): Promise<HerdrObservation> {
    return Effect.runPromise(this.effects.observe(identity));
  }

  interrupt(identity: WorkerIdentity): Promise<HerdrObservation> {
    return Effect.runPromise(this.effects.interrupt(identity));
  }

  steer(identity: WorkerIdentity, instruction: string): Promise<void> {
    return Effect.runPromise(this.effects.steer(identity, instruction));
  }

  cleanup(identity: WorkerIdentity): Promise<WorkerCleanupResult> {
    return Effect.runPromise(this.effects.cleanup(identity));
  }

  private launchCoordinatorEffect(
    request: CoordinatorLaunchRequest,
  ): Effect.Effect<WorkerIdentity, CoordinatorLaunchError | HerdrProtocolError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        yield* this.requireAvailable("coordinator");
        const { agentName, label } = herdrCoordinatorNames(request);
        const created = yield* this.call(
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
        ).pipe(
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
            const started = yield* this.call(
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
            ).pipe(
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
    return this.call(["api", "snapshot"], decodeCoordinatorSnapshotResponse).pipe(
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
        const decoded = yield* this.call(
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

  private launchEffect(
    request: WorkerLaunchRequest,
  ): Effect.Effect<
    HerdrObservation,
    HerdrProtocolError | WorkerLaunchReadinessError | WorkerLaunchError
  > {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        yield* this.requireAvailable("worker");
        const workerName = herdrWorkerName(request);
        const paneId = yield* this.call(
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
        );
        yield* invokeLaunchCallback("onTab", request.onTab, {
          workspaceId: request.workspaceId,
          paneId,
        });
        const args = [
          "agent",
          "start",
          workerName,
          "--kind",
          "pi",
          "--pane",
          paneId,
          "--",
          "--session",
          request.sessionFile,
        ];
        if (request.model !== undefined) args.push("--model", request.model);
        if (request.thinking !== undefined) args.push("--thinking", request.thinking);
        const decoded = yield* this.call(args, decodeAgentResponse, 45_000);
        const started = yield* protocolTry(args, () => parseAgent(decoded));
        const resource = resourceOf(started);
        yield* protocolTry(args, () =>
          assertResource({ ...resource, agentName: workerName }, started),
        );
        yield* invokeLaunchCallback("onResource", request.onResource, resource, resource);
        const identity = yield* this.awaitNativeIdentity(resource, request.sessionFile);
        yield* invokeLaunchCallback("onIdentity", request.onIdentity, identity, resource);
        if (request.prompt !== undefined) {
          yield* this.call(
            ["agent", "prompt", workerName, request.prompt],
            decodeSuccessResponse,
            15_000,
          );
          yield* invokeLaunchCallback("onSubmitted", request.onSubmitted, undefined, resource);
          return {
            identity,
            status: "working" as const,
            observedAt: yield* observedAt,
          };
        }
        return yield* this.observeEffect(identity);
      }.bind(this),
    );
  }

  private recoverEffect(
    request: WorkerRecoveryRequest,
  ): Effect.Effect<HerdrObservation | undefined, HerdrProtocolError | WorkerLaunchReadinessError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        const agents = yield* this.call(["api", "snapshot"], decodeSnapshotResponse);
        const compatibleAgentNames = new Set([
          request.agentName,
          ...(request.compatibleAgentNames ?? []),
        ]);
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
              compatibleAgentNames.has(candidate.name) &&
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
        const decoded = yield* this.call(["agent", "get", resource.paneId], decodeAgentResponse);
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
        yield* this.call(["agent", "send-keys", identity.agentName, "esc"], decodeSuccessResponse);
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
        yield* this.call(["agent", "prompt", identity.agentName, trimmed], decodeSuccessResponse);
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
        yield* this.call(["tab", "close", identity.tabId], decodeSuccessResponse);
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

  private call<Decoded>(
    args: string[],
    decode: HerdrResponseDecoder<Decoded>,
    timeoutMs = 30_000,
  ): Effect.Effect<Decoded, HerdrProtocolError> {
    return this.spawnCommand(args, timeoutMs).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? protocolDecode(result, args, decode)
          : Effect.fail(protocolCommandError(args, result)),
      ),
    );
  }

  private spawnCommand(
    args: string[],
    timeoutMs: number,
  ): Effect.Effect<CommandResult, HerdrProtocolError> {
    return processEffect(this.command, args, {
      cwd: process.cwd(),
      timeoutMs,
      outputLimit: HERDR_PROTOCOL_OUTPUT_LIMIT,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new HerdrProtocolError({
            operation: operationName(args),
            reason: "process",
            detail: `Herdr process failed for ${operationName(args)}.`,
            cause,
          }),
      ),
      Effect.flatMap((result) =>
        result.stdoutTruncated
          ? protocolFailure(
              args,
              "overflow",
              `Herdr protocol output exceeded ${HERDR_PROTOCOL_OUTPUT_LIMIT} bytes for ${operationName(args)}; no truncated JSON was decoded.`,
            )
          : Effect.succeed({
              code: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              timedOut: result.timedOut,
              stdoutTruncated: result.stdoutTruncated,
            }),
      ),
    );
  }

  private requireAvailable(
    kind: "coordinator" | "worker",
  ): Effect.Effect<void, HerdrProtocolError> {
    return this.available
      ? Effect.void
      : protocolFailure([], "unavailable", `Herdr ${kind} runtime is unavailable.`);
  }
}
interface ParsedAgent {
  workspaceId: string;
  tabId: string;
  paneId: string;
  terminalId: string;
  name: string;
  status: HerdrAgentStatus;
  sessionFile?: string;
  cwd: string;
}

function parseCoordinator(decoded: HerdrCoordinatorAgent): CoordinatorRuntimeIdentity {
  const identity: CoordinatorRuntimeIdentity = {
    workspaceId: decoded.workspace_id,
    tabId: decoded.tab_id,
    paneId: decoded.pane_id,
    terminalId: decoded.terminal_id,
    sessionFile: decoded.agent_session.value,
    cwd: decoded.cwd,
  };
  if (decoded.name !== undefined) identity.agentName = decoded.name;
  return identity;
}

function parseAgent(decoded: HerdrAgent): ParsedAgent {
  const result: ParsedAgent = {
    workspaceId: decoded.workspace_id,
    tabId: decoded.tab_id,
    paneId: decoded.pane_id,
    terminalId: decoded.terminal_id,
    name: decoded.name,
    status: decoded.agent_status,
    cwd: decoded.cwd,
  };
  if (decoded.agent_session !== undefined) result.sessionFile = decoded.agent_session.value;
  return result;
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
  result: CommandResult,
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
  result: CommandResult,
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

function resourceOf(actual: ParsedAgent): WorkerResourceIdentity {
  return {
    workspaceId: actual.workspaceId,
    tabId: actual.tabId,
    paneId: actual.paneId,
    terminalId: actual.terminalId,
    agentName: actual.name,
    cwd: actual.cwd,
  };
}

function assertResource(expected: WorkerResourceIdentity, actual: ParsedAgent): void {
  if (
    expected.workspaceId !== actual.workspaceId ||
    expected.tabId !== actual.tabId ||
    expected.paneId !== actual.paneId ||
    expected.terminalId !== actual.terminalId ||
    expected.agentName !== actual.name
  ) {
    throw new Error("Herdr worker resource identity changed.");
  }
  if (actual.cwd !== expected.cwd) throw new Error("Herdr worker cwd changed.");
}

function assertCoordinatorPlacement(
  expected: CoordinatorLaunchResource,
  actual: ParsedAgent,
): void {
  if (
    actual.workspaceId !== expected.workspaceId ||
    actual.tabId !== expected.tabId ||
    actual.paneId !== expected.paneId ||
    actual.name !== expected.agentName
  )
    throw new Error("Herdr coordinator resource identity changed.");
  if (actual.cwd !== expected.cwd) throw new Error("Herdr coordinator cwd changed.");
}

function assertIdentity(expected: WorkerIdentity, actual: ParsedAgent): void {
  assertResource(expected, actual);
  if (actual.sessionFile === undefined)
    throw new Error(
      "Herdr response omitted agent_session; native Pi session identity is not available.",
    );
  if (actual.sessionFile !== expected.sessionFile)
    throw new Error("Herdr native Pi session changed.");
}

function identityOf(expected: WorkerResourceIdentity, actual: ParsedAgent): WorkerIdentity {
  if (actual.sessionFile === undefined)
    throw new Error(
      "Herdr response omitted agent_session; native Pi session identity is not available.",
    );
  return { ...expected, sessionFile: actual.sessionFile };
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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Each supplied decoder validates this raw Herdr protocol value.
type HerdrResponseDecoder<Decoded> = (value: unknown) => Decoded;

/** Herdr control responses and full snapshots are expected to remain well below one MiB. */
export const HERDR_PROTOCOL_OUTPUT_LIMIT = 1024 * 1024;

class NativeIdentityPending extends Data.TaggedError("NativeIdentityPending") {}

class InvalidInspection extends Data.TaggedClass("InvalidInspection")<{
  readonly message: string;
}> {}

type InspectionDecode<Decoded> =
  | { readonly _tag: "DecodedInspection"; readonly value: Decoded }
  | InvalidInspection;

const observedAt = Clock.currentTimeMillis.pipe(
  Effect.map((timestamp) => DateTime.formatIso(DateTime.makeUnsafe(timestamp))),
);

function operationName(args: readonly string[]): string {
  return args.slice(0, 2).join(" ") || "availability";
}

function protocolFailure(
  args: readonly string[],
  reason: HerdrProtocolError["reason"],
  detail: string,
  cause?: unknown,
): Effect.Effect<never, HerdrProtocolError> {
  return Effect.fail(protocolError(args, reason, detail, cause));
}

function protocolError(
  args: readonly string[],
  reason: HerdrProtocolError["reason"],
  detail: string,
  cause?: unknown,
): HerdrProtocolError {
  return new HerdrProtocolError({ operation: operationName(args), reason, detail, cause });
}

function protocolTry<A>(
  args: readonly string[],
  evaluate: () => A,
): Effect.Effect<A, HerdrProtocolError> {
  return Effect.try({
    try: evaluate,
    catch: (cause) =>
      new HerdrProtocolError({
        operation: operationName(args),
        reason: "identity",
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
}

function protocolDecode<Decoded>(
  result: CommandResult,
  args: string[],
  decode: HerdrResponseDecoder<Decoded>,
): Effect.Effect<Decoded, HerdrProtocolError> {
  return Effect.try({
    try: () => decodeCommandResponse(result, args, decode),
    catch: (cause) =>
      cause instanceof HerdrProtocolError
        ? cause
        : new HerdrProtocolError({
            operation: operationName(args),
            reason: "malformed",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
  });
}

function decodeInspection<Decoded>(
  result: CommandResult,
  args: string[],
  decode: HerdrResponseDecoder<Decoded>,
): Effect.Effect<InspectionDecode<Decoded>> {
  return Effect.sync(() => {
    try {
      return {
        _tag: "DecodedInspection" as const,
        value: decodeCommandResponse(result, args, decode),
      };
    } catch (cause) {
      return new InvalidInspection({
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  });
}

function decodeCommandResponse<Decoded>(
  result: CommandResult,
  args: string[],
  decode: HerdrResponseDecoder<Decoded>,
): Decoded {
  if (result.stdoutTruncated)
    throw new HerdrProtocolError({
      operation: operationName(args),
      reason: "overflow",
      detail: `Herdr protocol output exceeded ${HERDR_PROTOCOL_OUTPUT_LIMIT} bytes for ${operationName(args)}; no truncated JSON was decoded.`,
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (cause) {
    throw new HerdrProtocolError({
      operation: operationName(args),
      reason: "malformed",
      detail: `Herdr returned invalid JSON for ${operationName(args)}.`,
      cause,
    });
  }
  return decode(parsed);
}

function invokeLaunchCallback<A>(
  phase: WorkerLaunchError["phase"],
  callback: ((value: A) => void | Promise<void>) | undefined,
  value: A,
  resource?: WorkerResourceIdentity,
): Effect.Effect<void, WorkerLaunchError> {
  if (callback === undefined) return Effect.void;
  return Effect.callback((resume) => {
    try {
      Promise.resolve(callback(value)).then(
        () => resume(Effect.void),
        (cause: unknown) => resume(Effect.fail(workerLaunchError(phase, resource, cause))),
      );
    } catch (cause) {
      resume(Effect.fail(workerLaunchError(phase, resource, cause)));
    }
  });
}

function workerLaunchError(
  phase: WorkerLaunchError["phase"],
  resource: WorkerResourceIdentity | undefined,
  cause: unknown,
): WorkerLaunchError {
  if (resource === undefined) return new WorkerLaunchError({ phase, cause });
  return new WorkerLaunchError({ phase, resource, cause });
}

function isNotFound(
  result: CommandResult,
  expectedCode: "agent_not_found" | "pane_not_found" | "tab_not_found",
): boolean {
  if (result.stdoutTruncated) return false;
  for (const candidate of [result.stderr, result.stdout]) {
    try {
      const error = decodeErrorResponse(JSON.parse(candidate));
      if (error?.code === expectedCode) return true;
    } catch {}
  }
  return false;
}

function protocolCommandError(args: string[], result: CommandResult): HerdrProtocolError {
  let message = result.timedOut
    ? "command timed out"
    : result.stderr || result.stdout || `Herdr exited ${result.code}.`;
  for (const candidate of [result.stderr, result.stdout]) {
    try {
      const error = decodeErrorResponse(JSON.parse(candidate));
      if (error === undefined) continue;
      const details = [error.code, error.message].filter(
        (part) => part !== undefined && part !== "",
      );
      if (details.length > 0) message = details.join(": ");
      break;
    } catch {}
  }
  return new HerdrProtocolError({
    operation: operationName(args),
    reason: "command",
    detail: `herdr ${operationName(args)} failed: ${message}`,
  });
}
