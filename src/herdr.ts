import { createHash } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Herdr names are derived from the host repository path.
import { basename } from "node:path";
import { Effect } from "effect";
import {
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
import { processEffect } from "./process.js";
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

export type WorkerRole = "implement" | "research" | "review";

export interface WorkerNamingContext {
  runId: string;
  nodeId?: string;
  attemptId: string;
  assignmentId?: string;
  objective?: string;
  role?: WorkerRole;
}

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
  tabId: string;
  paneId: string;
  terminalId: string;
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

// oxlint-disable-next-line effecttsgo/extends-native-error -- This public adapter error preserves the existing Promise API.
export class WorkerLaunchReadinessError extends Error {
  constructor(
    readonly resource: WorkerResourceIdentity,
    message: string,
  ) {
    super(message);
    this.name = "WorkerLaunchReadinessError";
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

// oxlint-disable-next-line effecttsgo/extends-native-error -- This public adapter error preserves the existing Promise API.
export class CoordinatorLaunchError extends Error {
  constructor(
    readonly resource: CoordinatorLaunchResource | undefined,
    message: string,
  ) {
    super(message);
    this.name = "CoordinatorLaunchError";
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
  private readonly coordinatorEnvironment: Record<string, string>;

  constructor(
    private readonly command = hostEnvironment.PI_WORKGRAPH_HERDR_BIN ?? "herdr",
    env: NodeJS.ProcessEnv = hostEnvironment,
  ) {
    const herdrEnvironment: HerdrProcessEnvironment = env;
    this.available =
      herdrEnvironment.HERDR_ENV === "1" && herdrEnvironment.HERDR_WORKSPACE_ID !== undefined;
    this.coordinatorEnvironment = coordinatorEnvironment(herdrEnvironment);
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Herdr retains its Promise-facing adapter API at this native CLI boundary.
  async launchCoordinator(request: CoordinatorLaunchRequest): Promise<WorkerIdentity> {
    if (!this.available) throw new Error("Herdr coordinator runtime is unavailable.");
    const { agentName, label } = herdrCoordinatorNames(request);
    let resource: CoordinatorLaunchResource;
    try {
      const created = await this.call(
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
      );
      resource = {
        workspaceId: created.workspaceId,
        tabId: created.tabId,
        paneId: created.paneId,
        agentName,
        sessionFile: request.sessionFile,
        cwd: request.cwd,
      };
    } catch (error) {
      throw new CoordinatorLaunchError(
        undefined,
        `Coordinator workspace creation is uncertain for session ${request.sessionFile} at ${request.cwd} with exact label ${JSON.stringify(label)}: ${errorMessage(error instanceof Error ? error : String(error))} Inspect that label before retrying; no tab fallback or cleanup was attempted.`,
      );
    }
    const { workspaceId, tabId, paneId } = resource;
    let retainedResource = resource;
    try {
      const started = parseAgent(
        await this.call(
          [
            "agent",
            "start",
            agentName,
            "--kind",
            "pi",
            "--pane",
            paneId,
            "--",
            "--session",
            request.sessionFile,
          ],
          decodeAgentResponse,
          45_000,
        ),
      );
      assertCoordinatorPlacement(resource, started);
      const startedResource = resourceOf(started);
      retainedResource = {
        ...resource,
        terminalId: startedResource.terminalId,
      };
      return await this.awaitNativeIdentity(startedResource, request.sessionFile);
    } catch (error) {
      throw new CoordinatorLaunchError(
        retainedResource,
        `Coordinator launch is uncertain in workspace ${workspaceId}, tab ${tabId}, pane ${paneId}, agent ${agentName}, session ${request.sessionFile}, cwd ${request.cwd}: ${errorMessage(error instanceof Error ? error : String(error))} Inspect these exact handles before retrying; the workspace was retained.`,
      );
    }
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Herdr retains its Promise-facing adapter API at this native CLI boundary.
  async coordinatorLiveness(sessionFile: string): Promise<"alive" | "dead" | "unknown"> {
    if (!this.available) return "unknown";
    const sessionFiles = await this.call(["api", "snapshot"], decodeCoordinatorSnapshotResponse);
    let unknown = false;
    for (const sessionFileValue of sessionFiles) {
      if (sessionFileValue === undefined) {
        unknown = true;
        continue;
      }
      if (sessionFileValue === sessionFile) return "alive";
    }
    return unknown ? "unknown" : "dead";
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Herdr retains its Promise-facing adapter API at this native CLI boundary.
  async observeCurrentCoordinator(
    request: CoordinatorObservationRequest,
  ): Promise<CoordinatorRuntimeIdentity> {
    if (!this.available) throw new Error("Herdr coordinator runtime is unavailable.");
    const current = parseCoordinator(
      await this.call(["agent", "get", request.paneId], decodeCoordinatorAgentResponse),
    );
    if (current.sessionFile !== request.sessionFile)
      throw new Error("Current Herdr pane does not own the requested Pi session.");
    if (current.cwd !== request.cwd)
      throw new Error("Current Herdr pane cwd does not match the repository.");
    return current;
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Herdr retains its Promise-facing adapter API at this native CLI boundary.
  async launch(request: WorkerLaunchRequest): Promise<HerdrObservation> {
    if (!this.available) throw new Error("Herdr worker runtime is unavailable.");
    const workerName = herdrWorkerName(request);
    const paneId = await this.call(
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
    await request.onTab?.({ workspaceId: request.workspaceId, paneId });
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
    const started = parseAgent(await this.call(args, decodeAgentResponse, 45_000));
    const resource = resourceOf(started);
    assertResource({ ...resource, agentName: workerName }, started);
    await request.onResource?.(resource);
    const identity = await this.awaitNativeIdentity(resource, request.sessionFile);
    await request.onIdentity?.(identity);
    if (request.prompt !== undefined) {
      await this.call(
        ["agent", "prompt", workerName, request.prompt],
        decodeSuccessResponse,
        15_000,
      );
      await request.onSubmitted?.();
      return {
        identity,
        status: "working",
        // oxlint-disable-next-line effecttsgo/global-date -- Herdr protocol observations require the host timestamp at this adapter boundary.
        observedAt: new Date().toISOString(),
      };
    }
    return this.observe(identity);
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Herdr retains its Promise-facing adapter API at this native CLI boundary.
  async recover(request: WorkerRecoveryRequest): Promise<HerdrObservation | undefined> {
    const agents = await this.call(["api", "snapshot"], decodeSnapshotResponse);
    const compatibleAgentNames = new Set([
      request.agentName,
      ...(request.compatibleAgentNames ?? []),
    ]);
    const matches = agents.filter((candidate) => {
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
      throw new Error(`Herdr recovery found ${matches.length} workers for ${request.agentName}.`);
    const match = matches[0];
    if (match === undefined) return undefined;
    const current = parseAgent(match);
    const resource = request.resource ?? resourceOf(current);
    assertResource(resource, current);
    if (current.sessionFile === undefined)
      throw new WorkerLaunchReadinessError(
        resource,
        "Recovered Herdr resource still has no native Pi session identity; operator action is required before assignment submission.",
      );
    const identity = identityOf(resource, current);
    assertIdentity(identity, current);
    return {
      identity,
      status: current.status,
      // oxlint-disable-next-line effecttsgo/global-date -- Herdr protocol observations require the host timestamp at this adapter boundary.
      observedAt: new Date().toISOString(),
    };
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Herdr retains its Promise-facing adapter API at this native CLI boundary.
  async inspectLaunch(request: WorkerLaunchInspectionRequest): Promise<WorkerLaunchInspection> {
    const paneResult = await spawnCommand(this.command, ["pane", "get", request.paneId], 30_000);
    if (paneResult.code !== 0) return unavailablePaneInspection(request, paneResult);

    let pane: WorkerPaneObservation;
    try {
      pane = decodeCommandResponse(paneResult, ["pane", "get"], decodePaneResponse);
    } catch (error) {
      return invalidPaneInspection(
        request,
        errorMessage(error instanceof Error ? error : String(error)),
      );
    }
    const evidence = initialLaunchEvidence(request, pane);
    if (!samePaneResource(request, pane)) {
      const detail = "Retained Herdr pane identity or cwd does not match startup state.";
      return { state: "unknown", evidence, detail };
    }

    evidence.process = await this.inspectLaunchProcess(request.paneId);
    return this.inspectLaunchAgent(request, evidence);
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Herdr process inspection crosses the native CLI Promise boundary.
  private async inspectLaunchProcess(paneId: string): Promise<WorkerLaunchProcessEvidence> {
    const result = await spawnCommand(
      this.command,
      ["pane", "process-info", "--pane", paneId],
      30_000,
    );
    if (result.code !== 0) {
      return {
        state: "unknown",
        detail: "Herdr pane process information was unavailable; no process conclusion was made.",
      };
    }
    try {
      return {
        state: "observed",
        process: decodeCommandResponse(result, ["pane", "process-info"], decodeProcessInfoResponse),
      };
    } catch (error) {
      return {
        state: "unknown",
        detail: `Herdr pane process information had an invalid shape: ${errorMessage(error instanceof Error ? error : String(error))}`,
      };
    }
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Herdr agent inspection crosses the native CLI Promise boundary.
  private async inspectLaunchAgent(
    request: WorkerLaunchInspectionRequest,
    evidence: WorkerLaunchInspectionEvidence,
  ): Promise<WorkerLaunchInspection> {
    const result = await spawnCommand(this.command, ["agent", "get", request.paneId], 30_000);
    if (result.code !== 0) return unavailableLaunchAgent(result, evidence);

    try {
      const current = parseAgent(
        decodeCommandResponse(result, ["agent", "get"], decodeAgentResponse),
      );
      if (!sameLaunchAgent(request, current)) {
        evidence.agent = {
          state: "unknown",
          detail: "Herdr native agent identity does not match the retained startup resource.",
        };
        return { state: "unknown", evidence, detail: evidence.agent.detail };
      }
      const identity: WorkerIdentity = {
        workspaceId: request.workspaceId,
        tabId: request.tabId,
        paneId: request.paneId,
        terminalId: request.terminalId,
        agentName: current.name,
        sessionFile: request.sessionFile,
        cwd: request.cwd,
      };
      evidence.agent = { state: "present", identity, status: current.status };
      return {
        state: "live",
        identity,
        evidence,
        detail: "Exact retained pane and native Pi session identity are live.",
      };
    } catch (error) {
      evidence.agent = {
        state: "unknown",
        detail: `Herdr native agent response was invalid: ${errorMessage(error instanceof Error ? error : String(error))}`,
      };
      return { state: "unknown", evidence, detail: evidence.agent.detail };
    }
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Herdr retains its Promise-facing adapter API at this native CLI boundary.
  private async awaitNativeIdentity(
    resource: WorkerResourceIdentity,
    expectedSessionFile: string,
    timeoutMs = 15_000,
  ): Promise<WorkerIdentity> {
    // oxlint-disable-next-line effecttsgo/global-date -- Herdr protocol observations require the host timestamp at this adapter boundary.
    const deadline = Date.now() + timeoutMs;
    let last = "Native Pi session identity is not available yet.";
    // oxlint-disable-next-line effecttsgo/global-date -- Herdr protocol observations require the host timestamp at this adapter boundary.
    while (Date.now() < deadline) {
      const current = parseAgent(
        await this.call(["agent", "get", resource.paneId], decodeAgentResponse),
      );
      assertResource(resource, current);
      if (current.sessionFile !== undefined) {
        const identity = identityOf(resource, current);
        assertIdentity({ ...identity, sessionFile: expectedSessionFile }, current);
        return identity;
      }
      if (current.status === "blocked") {
        throw new WorkerLaunchReadinessError(
          resource,
          "Worker is blocked at a Pi trust or approval prompt; operator action is required before assignment submission.",
        );
      }
      last = `Worker is ${current.status}, but Herdr has not exposed its native Pi session identity.`;
      await Effect.runPromise(Effect.sleep(250));
    }
    throw new WorkerLaunchReadinessError(
      resource,
      `${last} Launch readiness timed out after ${timeoutMs}ms. No assignment prompt was submitted.`,
    );
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Herdr retains its Promise-facing adapter API at this native CLI boundary.
  async inspect(identity: WorkerIdentity): Promise<HerdrInspection> {
    const result = await spawnCommand(this.command, ["agent", "get", identity.paneId], 30_000);
    if (result.code !== 0) {
      if (
        (isNotFound(result, "agent_not_found") || isNotFound(result, "pane_not_found")) &&
        (await this.tabAbsent(identity.tabId))
      )
        return {
          identity,
          status: "absent",
          // oxlint-disable-next-line effecttsgo/global-date -- Herdr protocol observations require the host timestamp at this adapter boundary.
          observedAt: new Date().toISOString(),
          detail: `Exact Herdr tab ${identity.tabId} is absent.`,
        };
      throw herdrError(["agent", "get", identity.paneId], result);
    }
    const current = parseAgent(
      decodeCommandResponse(result, ["agent", "get", identity.paneId], decodeAgentResponse),
    );
    assertIdentity(identity, current);
    return {
      identity,
      status: current.status,
      // oxlint-disable-next-line effecttsgo/global-date -- Herdr protocol observations require the host timestamp at this adapter boundary.
      observedAt: new Date().toISOString(),
    };
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Herdr retains its Promise-facing adapter API at this native CLI boundary.
  async observe(identity: WorkerIdentity): Promise<HerdrObservation> {
    const inspection = await this.inspect(identity);
    if (inspection.status === "absent") throw new Error(inspection.detail);
    return inspection;
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Herdr retains its Promise-facing adapter API at this native CLI boundary.
  async interrupt(identity: WorkerIdentity): Promise<HerdrObservation> {
    await this.observe(identity);
    await this.call(["agent", "send-keys", identity.agentName, "esc"], decodeSuccessResponse);
    return this.observe(identity);
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Herdr retains its Promise-facing adapter API at this native CLI boundary.
  async steer(identity: WorkerIdentity, instruction: string): Promise<void> {
    if (!instruction.trim()) throw new Error("Worker steering requires an instruction.");
    const current = await this.observe(identity);
    if (current.status === "blocked")
      throw new Error("Worker is blocked and cannot receive steering.");
    await this.call(
      ["agent", "prompt", identity.agentName, instruction.trim()],
      decodeSuccessResponse,
    );
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Herdr retains its Promise-facing adapter API at this native CLI boundary.
  async cleanup(identity: WorkerIdentity): Promise<WorkerCleanupResult> {
    const observation = await this.inspect(identity);
    if (observation.status === "absent") {
      return {
        state: "completed",
        identity,
        observedAt: observation.observedAt,
        detail: observation.detail,
      };
    }
    if (observation.status === "working") {
      return {
        state: "pending",
        identity,
        observedAt: observation.observedAt,
        detail: "Worker is still working; exact cleanup remains pending.",
      };
    }
    if (observation.status === "blocked" || observation.status === "unknown") {
      return {
        state: "blocked",
        identity,
        observedAt: observation.observedAt,
        detail: `Worker is ${observation.status}; cleanup requires a verified idle or done worker.`,
      };
    }
    await this.call(["tab", "close", identity.tabId], decodeSuccessResponse);
    if (!(await this.tabAbsent(identity.tabId)))
      throw new Error(`Herdr tab ${identity.tabId} still exists after cleanup.`);
    return {
      state: "completed",
      identity,
      // oxlint-disable-next-line effecttsgo/global-date -- Herdr protocol observations require the host timestamp at this adapter boundary.
      observedAt: new Date().toISOString(),
      detail: `Closed and verified exact Herdr tab ${identity.tabId}.`,
    };
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Herdr retains its Promise-facing adapter API at this native CLI boundary.
  private async tabAbsent(tabId: string): Promise<boolean> {
    const result = await spawnCommand(this.command, ["tab", "get", tabId], 30_000);
    if (result.code === 0) return false;
    if (isNotFound(result, "tab_not_found")) return true;
    throw herdrError(["tab", "get", tabId], result);
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Herdr retains its Promise-facing adapter API at this native CLI boundary.
  private async call<Decoded>(
    args: string[],
    decode: HerdrResponseDecoder<Decoded>,
    timeoutMs = 30_000,
  ): Promise<Decoded> {
    const result = await spawnCommand(this.command, args, timeoutMs);
    if (result.code !== 0) throw herdrError(args, result);
    return decodeCommandResponse(result, args, decode);
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

function sameLaunchAgent(request: WorkerLaunchInspectionRequest, current: ParsedAgent): boolean {
  return (
    current.workspaceId === request.workspaceId &&
    current.tabId === request.tabId &&
    current.paneId === request.paneId &&
    current.terminalId === request.terminalId &&
    current.cwd === request.cwd &&
    current.sessionFile === request.sessionFile
  );
}

function samePaneResource(
  request: WorkerLaunchInspectionRequest,
  pane: WorkerPaneObservation,
): boolean {
  return (
    pane.workspaceId === request.workspaceId &&
    pane.tabId === request.tabId &&
    pane.paneId === request.paneId &&
    pane.terminalId === request.terminalId &&
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

function errorMessage(error: Error | string): string {
  return error instanceof Error ? error.message : error;
}

const HERDR_AGENT_NAME_LIMIT = 32;
const IDENTITY_SUFFIX_LENGTH = 6;
const WORKER_TAB_LABEL_LIMIT = 18;
const TAB_SUBJECT_LIMIT = 24;
const GENERIC_ASSIGNMENT_IDS = new Set([
  "assignment",
  "change",
  "implement",
  "implementation",
  "job",
  "node",
  "request",
  "research",
  "review",
  "task",
  "work",
  "worker",
]);

export function herdrWorkerName(request: WorkerNamingContext): string {
  if (
    request.assignmentId === undefined &&
    request.objective === undefined &&
    request.role === undefined
  )
    return herdrAgentName(request.runId, request.nodeId ?? "worker", request.attemptId);
  const role = request.role ?? "research";
  return readableIdentityName(
    readableSlug(workerSubject(request)) || "task",
    role,
    workerIdentity(request),
  );
}

/** Compatibility identity for workers launched by the first task-first release. */
export function legacyObjectiveHerdrWorkerName(request: WorkerNamingContext): string {
  const assignmentId = request.assignmentId ?? request.nodeId ?? "assignment";
  const objective = request.objective ?? request.nodeId ?? assignmentId;
  return readableIdentityName(
    readableSlug(objective) || readableSlug(assignmentId) || "task",
    request.role ?? "research",
    workerIdentity(request),
  );
}

export function herdrWorkerTabLabel(request: WorkerNamingContext): string {
  return boundAtWord(workerSubject(request), WORKER_TAB_LABEL_LIMIT);
}

export function herdrCoordinatorNames(request: CoordinatorLaunchRequest) {
  const repository = readableSlug(basename(request.cwd)) || "repository";
  const repositoryLabel = readableLabel(basename(request.cwd)) || "Repository";
  const identity = `${request.sessionFile}\0${request.cwd}`;
  const suffix = identitySuffix(identity, IDENTITY_SUFFIX_LENGTH);
  const agentName = readableIdentityName(repository, "coordinator", identity);
  return {
    agentName,
    label: `${bound(repositoryLabel, TAB_SUBJECT_LIMIT)} - coordinator - ${suffix}`,
  };
}

function workerIdentity(request: WorkerNamingContext): string {
  const assignmentId = request.assignmentId ?? request.nodeId ?? "assignment";
  return `${request.runId}\0${assignmentId}\0${request.attemptId}`;
}

function workerSubject(request: WorkerNamingContext): string {
  const assignmentId = request.assignmentId ?? request.nodeId ?? "";
  const assignmentLabel = readableLabel(assignmentId);
  if (isDescriptiveAssignmentId(assignmentId, assignmentLabel))
    return sentenceCase(assignmentLabel);
  const objectiveLabel = readableLabel(request.objective ?? "");
  return objectiveLabel || assignmentLabel || "Task";
}

function isDescriptiveAssignmentId(id: string, label: string): boolean {
  if (!label || label.length > 48) return false;
  const normalized = id.trim().toLowerCase();
  if (GENERIC_ASSIGNMENT_IDS.has(normalized)) return false;
  if (/^[0-9a-f]{8,}$/i.test(normalized)) return false;
  if (
    /^(?:assignment|attempt|job|node|request|task|work|worker)[-_](?:\d+|[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f-]{19,})$/i.test(
      normalized,
    )
  )
    return false;
  return true;
}

function sentenceCase(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}

/** Compatibility identity for resources launched before task-first names. */
export function legacyHerdrAgentName(runId: string, nodeId: string, attemptId: string): string {
  const node = legacySlug(nodeId).slice(0, 12) || "worker";
  return `wg-${node}-${identitySuffix(`${runId}\0${nodeId}\0${attemptId}`, 12)}`;
}

/** @deprecated Use herdrWorkerName with assignment context for new launches. */
export function herdrAgentName(runId: string, nodeId: string, attemptId: string): string {
  return legacyHerdrAgentName(runId, nodeId, attemptId);
}

function readableIdentityName(
  subject: string,
  role: WorkerRole | "coordinator",
  identity: string,
): string {
  const suffix = identitySuffix(identity, IDENTITY_SUFFIX_LENGTH);
  const subjectLimit = HERDR_AGENT_NAME_LIMIT - role.length - suffix.length - 2;
  const boundedSubject = subject.slice(0, subjectLimit).replace(/-+$/g, "");
  return `${boundedSubject || "task"}-${role}-${suffix}`;
}

function identitySuffix(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function bound(value: string, limit: number): string {
  return value.slice(0, limit).replace(/[ -]+$/g, "");
}

function boundAtWord(value: string, limit: number): string {
  const bounded = bound(value, limit);
  if (value.length <= limit) return bounded;
  const boundary = bounded.lastIndexOf(" ");
  return boundary > 0 ? bounded.slice(0, boundary) : bounded;
}

function readableLabel(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .replace(/ +/g, " ");
}

function readableSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/g, "");
}

function legacySlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/g, "");
}

type HerdrResponseDecoder<Decoded> = (value: Parameters<typeof decodeAgentResponse>[0]) => Decoded;

function decodeCommandResponse<Decoded>(
  result: CommandResult,
  args: string[],
  decode: HerdrResponseDecoder<Decoded>,
): Decoded {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Herdr returned invalid JSON for ${args.slice(0, 2).join(" ")}.`);
  }
  return decode(parsed);
}

function isNotFound(
  result: CommandResult,
  expectedCode: "agent_not_found" | "pane_not_found" | "tab_not_found",
): boolean {
  for (const candidate of [result.stderr, result.stdout]) {
    try {
      const error = decodeErrorResponse(JSON.parse(candidate));
      if (error?.code === expectedCode) return true;
    } catch {}
  }
  return false;
}

function herdrError(args: string[], result: CommandResult): Error {
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
  return new Error(`herdr ${args.slice(0, 2).join(" ")} failed: ${message}`);
}

// oxlint-disable-next-line effecttsgo/async-function -- Herdr retains its Promise-facing adapter API at this native CLI boundary.
async function spawnCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  const result = await Effect.runPromise(
    processEffect(command, args, {
      cwd: process.cwd(),
      timeoutMs,
      outputLimit: false,
    }),
  );
  return {
    code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
  };
}
