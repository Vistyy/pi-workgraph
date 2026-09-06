import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const AgentStatusSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("working"),
  Type.Literal("blocked"),
  Type.Literal("done"),
  Type.Literal("unknown"),
]);
const AgentSessionSchema = Type.Object({ value: Type.String({ minLength: 1 }) });
const AgentObservationProperties = {
  workspace_id: Type.String({ minLength: 1 }),
  tab_id: Type.String({ minLength: 1 }),
  pane_id: Type.String({ minLength: 1 }),
  terminal_id: Type.String({ minLength: 1 }),
  agent_status: AgentStatusSchema,
  cwd: Type.String({ minLength: 1 }),
  agent_session: Type.Optional(AgentSessionSchema),
};
const AgentSchema = Type.Object({
  ...AgentObservationProperties,
  name: Type.String({ minLength: 1 }),
});
const SnapshotAgentSchema = Type.Object({
  ...AgentObservationProperties,
  name: Type.Optional(Type.String({ minLength: 1 })),
});
const CoordinatorAgentSchema = Type.Object({
  workspace_id: Type.String({ minLength: 1 }),
  tab_id: Type.String({ minLength: 1 }),
  pane_id: Type.String({ minLength: 1 }),
  terminal_id: Type.String({ minLength: 1 }),
  cwd: Type.String({ minLength: 1 }),
  agent_session: AgentSessionSchema,
  name: Type.Optional(Type.String({ minLength: 1 })),
});
const PaneSchema = Type.Object({
  workspace_id: Type.String({ minLength: 1 }),
  tab_id: Type.String({ minLength: 1 }),
  pane_id: Type.String({ minLength: 1 }),
  terminal_id: Type.String({ minLength: 1 }),
  cwd: Type.String({ minLength: 1 }),
});
const ForegroundProcessSchema = Type.Union([
  Type.String(),
  Type.Object({
    name: Type.Optional(Type.String({ minLength: 1 })),
    pid: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
]);
const ProcessInfoSchema = Type.Object({
  shell_pid: Type.Integer({ minimum: 1 }),
  foreground_process_group_id: Type.Integer({ minimum: 1 }),
  foreground_processes: Type.Array(ForegroundProcessSchema),
});

const AgentResponseSchema = Type.Object({ result: Type.Object({ agent: AgentSchema }) });
const CoordinatorAgentResponseSchema = Type.Object({
  result: Type.Object({ agent: CoordinatorAgentSchema }),
});
const SnapshotResponseSchema = Type.Object({
  result: Type.Object({ snapshot: Type.Object({ agents: Type.Array(SnapshotAgentSchema) }) }),
});
const CoordinatorSnapshotResponseSchema = Type.Object({
  result: Type.Object({
    snapshot: Type.Object({
      agents: Type.Array(
        Type.Object({
          agent_session: Type.Optional(
            Type.Object({ value: Type.Optional(Type.String({ minLength: 1 })) }),
          ),
        }),
      ),
    }),
  }),
});
const WorkspaceCreateResponseSchema = Type.Object({
  result: Type.Object({
    workspace: Type.Object({ workspace_id: Type.String({ minLength: 1 }) }),
    tab: Type.Object({ tab_id: Type.String({ minLength: 1 }) }),
    root_pane: Type.Object({ pane_id: Type.String({ minLength: 1 }) }),
  }),
});
const TabCreateResponseSchema = Type.Object({
  result: Type.Object({ root_pane: Type.Object({ pane_id: Type.String({ minLength: 1 }) }) }),
});
const PaneResponseSchema = Type.Union([
  Type.Object({ result: PaneSchema }),
  Type.Object({ result: Type.Object({ pane: PaneSchema }) }),
]);
const ProcessInfoResponseSchema = Type.Union([
  Type.Object({ result: ProcessInfoSchema }),
  Type.Object({ result: Type.Object({ process_info: ProcessInfoSchema }) }),
]);
const SuccessResponseSchema = Type.Object({ result: Type.Object({}) });
const ErrorResponseSchema = Type.Object({
  error: Type.Object({
    code: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
  }),
});

type DecodedAgent = Static<typeof AgentSchema>;
type DecodedSnapshotAgent = Static<typeof SnapshotAgentSchema>;
type DecodedCoordinatorAgent = Static<typeof CoordinatorAgentSchema>;
type DecodedPane = Static<typeof PaneSchema>;
type DecodedProcessInfo = Static<typeof ProcessInfoSchema>;
type DecodedError = Static<typeof ErrorResponseSchema>["error"];

export type HerdrAgentStatus = Static<typeof AgentStatusSchema>;
export type HerdrAgent = DecodedAgent;
export type HerdrCoordinatorAgent = DecodedCoordinatorAgent;

export interface DecodedWorkspaceCreation {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
}

export interface DecodedPaneObservation {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly terminalId: string;
  readonly cwd: string;
}

export interface DecodedProcessObservation {
  readonly shellPid: number;
  readonly foregroundProcessGroupId: number;
  readonly foregroundProcesses: readonly Static<typeof ForegroundProcessSchema>[];
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This named decoder validates a raw Herdr protocol boundary.
export function decodeAgent(value: unknown): DecodedAgent {
  if (!Value.Check(AgentSchema, value)) {
    const detail = [...Value.Errors(AgentSchema, value)][0]?.message ?? "invalid shape";
    throw invalidAgentShape(detail);
  }
  return Value.Decode(AgentSchema, value);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This named decoder validates a raw Herdr protocol boundary.
export function decodeCoordinatorAgent(value: unknown): DecodedCoordinatorAgent {
  if (!Value.Check(CoordinatorAgentSchema, value)) {
    const detail = [...Value.Errors(CoordinatorAgentSchema, value)][0]?.message ?? "invalid shape";
    throw invalidAgentShape(detail);
  }
  return Value.Decode(CoordinatorAgentSchema, value);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This named decoder validates the complete Herdr agent response.
export function decodeAgentResponse(value: unknown): DecodedAgent {
  if (!Value.Check(AgentResponseSchema, value)) {
    const detail = [...Value.Errors(AgentResponseSchema, value)][0]?.message ?? "invalid shape";
    throw invalidAgentShape(detail);
  }
  return Value.Decode(AgentResponseSchema, value).result.agent;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This named decoder validates the complete Herdr coordinator response.
export function decodeCoordinatorAgentResponse(value: unknown): DecodedCoordinatorAgent {
  if (!Value.Check(CoordinatorAgentResponseSchema, value)) {
    const detail =
      [...Value.Errors(CoordinatorAgentResponseSchema, value)][0]?.message ?? "invalid shape";
    throw invalidAgentShape(detail);
  }
  return Value.Decode(CoordinatorAgentResponseSchema, value).result.agent;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This named decoder validates coordinator session evidence from the complete Herdr snapshot response.
export function decodeCoordinatorSnapshotResponse(value: unknown): readonly (string | undefined)[] {
  if (!Value.Check(CoordinatorSnapshotResponseSchema, value))
    throw new Error("Herdr snapshot response omitted coordinator session evidence.");
  return Value.Decode(CoordinatorSnapshotResponseSchema, value).result.snapshot.agents.map(
    (agent) => agent.agent_session?.value,
  );
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This named decoder validates the complete Herdr worker snapshot response.
export function decodeSnapshotResponse(value: unknown): readonly DecodedSnapshotAgent[] {
  if (!Value.Check(SnapshotResponseSchema, value))
    throw new Error("Herdr snapshot response omitted valid agents.");
  return Value.Decode(SnapshotResponseSchema, value).result.snapshot.agents;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This named decoder validates the complete Herdr workspace response.
export function decodeWorkspaceCreateResponse(value: unknown): DecodedWorkspaceCreation {
  if (!Value.Check(WorkspaceCreateResponseSchema, value))
    throw new Error("Herdr workspace response omitted exact created handles.");
  const decoded = Value.Decode(WorkspaceCreateResponseSchema, value).result;
  return {
    workspaceId: decoded.workspace.workspace_id,
    tabId: decoded.tab.tab_id,
    paneId: decoded.root_pane.pane_id,
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This named decoder validates the complete Herdr tab response.
export function decodeTabCreateResponse(value: unknown): string {
  if (!Value.Check(TabCreateResponseSchema, value))
    throw new Error("Herdr tab response omitted the created root pane.");
  return Value.Decode(TabCreateResponseSchema, value).result.root_pane.pane_id;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This named decoder validates the complete Herdr pane response.
export function decodePaneResponse(value: unknown): DecodedPaneObservation {
  if (!Value.Check(PaneResponseSchema, value))
    throw new Error("Herdr pane response omitted exact identity fields.");
  const result = Value.Decode(PaneResponseSchema, value).result;
  const decoded: DecodedPane = "pane" in result ? result.pane : result;
  return {
    workspaceId: decoded.workspace_id,
    tabId: decoded.tab_id,
    paneId: decoded.pane_id,
    terminalId: decoded.terminal_id,
    cwd: decoded.cwd,
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This named decoder validates the complete Herdr process response.
export function decodeProcessInfoResponse(value: unknown): DecodedProcessObservation {
  if (!Value.Check(ProcessInfoResponseSchema, value))
    throw new Error("Herdr process information omitted bounded process fields.");
  const result = Value.Decode(ProcessInfoResponseSchema, value).result;
  const decoded: DecodedProcessInfo = "process_info" in result ? result.process_info : result;
  return {
    shellPid: decoded.shell_pid,
    foregroundProcessGroupId: decoded.foreground_process_group_id,
    foregroundProcesses: decoded.foreground_processes,
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This named decoder validates the generic Herdr success envelope before payload decoding.
export function decodeSuccessResponse(value: unknown): void {
  if (!Value.Check(SuccessResponseSchema, value))
    throw new Error("Herdr returned an invalid success response.");
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This named decoder validates a raw Herdr error response without inventing error evidence.
export function decodeErrorResponse(value: unknown): DecodedError | undefined {
  if (!Value.Check(ErrorResponseSchema, value)) return undefined;
  return Value.Decode(ErrorResponseSchema, value).error;
}

function invalidAgentShape(detail: string): Error {
  for (const field of [
    "agent_session",
    "workspace_id",
    "tab_id",
    "pane_id",
    "terminal_id",
    "agent_status",
    "name",
    "cwd",
  ]) {
    if (!detail.includes(field)) continue;
    if (field === "name") return new Error("Herdr response omitted string name.");
    if (field === "cwd") return new Error("Herdr response omitted string cwd.");
    return new Error(`Herdr response omitted or invalid ${field}.`);
  }
  return new Error("Herdr agent response has an invalid shape.");
}
