import { Data } from "effect";
import type { HerdrAgentStatus } from "./herdr.js";
import type { HerdrAgent, HerdrCoordinatorAgent } from "./herdr-decoder.js";
import type { CoordinatorLaunchResource } from "./herdr-launch.js";
import type {
  CoordinatorRuntimeIdentity,
  WorkerIdentity,
  WorkerResourceIdentity,
} from "./types.js";

export interface ParsedAgent {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly terminalId: string;
  readonly name: string;
  readonly status: HerdrAgentStatus;
  readonly sessionFile?: string;
  readonly cwd: string;
}

export interface WorkerLaunchPlacement {
  readonly workspaceId: string;
  readonly paneId: string;
  readonly agentName: string;
  readonly cwd: string;
}

export class WorkerLaunchPlacementError extends Data.TaggedError("WorkerLaunchPlacementError")<{
  readonly expected: WorkerLaunchPlacement;
  readonly observed: WorkerResourceIdentity;
}> {
  override get message(): string {
    return "Herdr agent start returned a conflicting resource identity; the observed resource was not adopted or cleaned up. Inspect the requested pane and observed handles before retrying.";
  }
}

export function parseCoordinator(decoded: HerdrCoordinatorAgent): CoordinatorRuntimeIdentity {
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

export function parseAgent(decoded: HerdrAgent): ParsedAgent {
  const result: ParsedAgent = {
    workspaceId: decoded.workspace_id,
    tabId: decoded.tab_id,
    paneId: decoded.pane_id,
    terminalId: decoded.terminal_id,
    name: decoded.name,
    status: decoded.agent_status,
    cwd: decoded.cwd,
  };
  if (decoded.agent_session !== undefined)
    return { ...result, sessionFile: decoded.agent_session.value };
  return result;
}

export function resourceOf(actual: ParsedAgent): WorkerResourceIdentity {
  return {
    workspaceId: actual.workspaceId,
    tabId: actual.tabId,
    paneId: actual.paneId,
    terminalId: actual.terminalId,
    agentName: actual.name,
    cwd: actual.cwd,
  };
}

export function assertWorkerLaunchPlacement(
  expected: WorkerLaunchPlacement,
  actual: ParsedAgent,
): void {
  if (
    actual.workspaceId !== expected.workspaceId ||
    actual.paneId !== expected.paneId ||
    actual.name !== expected.agentName ||
    actual.cwd !== expected.cwd
  )
    throw new WorkerLaunchPlacementError({ expected, observed: resourceOf(actual) });
}

export function assertResource(expected: WorkerResourceIdentity, actual: ParsedAgent): void {
  if (
    expected.workspaceId !== actual.workspaceId ||
    expected.tabId !== actual.tabId ||
    expected.paneId !== actual.paneId ||
    expected.terminalId !== actual.terminalId ||
    expected.agentName !== actual.name
  )
    throw new Error("Herdr worker resource identity changed.");
  if (actual.cwd !== expected.cwd) throw new Error("Herdr worker cwd changed.");
}

export function assertCoordinatorPlacement(
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

export function assertIdentity(expected: WorkerIdentity, actual: ParsedAgent): void {
  assertResource(expected, actual);
  if (actual.sessionFile === undefined)
    throw new Error(
      "Herdr response omitted agent_session; native Pi session identity is not available.",
    );
  if (actual.sessionFile !== expected.sessionFile)
    throw new Error("Herdr native Pi session changed.");
}

export function identityOf(expected: WorkerResourceIdentity, actual: ParsedAgent): WorkerIdentity {
  if (actual.sessionFile === undefined)
    throw new Error(
      "Herdr response omitted agent_session; native Pi session identity is not available.",
    );
  return { ...expected, sessionFile: actual.sessionFile };
}
