import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const AgentStatusSchema = Type.Union([
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
const AgentResponseSchema = Type.Object({ result: Type.Object({ agent: AgentSchema }) });
const SnapshotResponseSchema = Type.Object({
  result: Type.Object({ snapshot: Type.Object({ agents: Type.Array(SnapshotAgentSchema) }) }),
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
const SuccessResponseSchema = Type.Object({ result: Type.Object({}) });
const ErrorResponseSchema = Type.Object({
  error: Type.Object({
    code: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
  }),
});

type DecodedAgent = Static<typeof AgentSchema>;
type DecodedSnapshotAgent = Static<typeof SnapshotAgentSchema>;
type DecodedError = Static<typeof ErrorResponseSchema>["error"];

export type HerdrAgentStatus = Static<typeof AgentStatusSchema>;
export type HerdrAgent = DecodedAgent;

export interface DecodedWorkspaceCreation {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This named decoder validates the complete Herdr agent response.
export function decodeAgentResponse(value: unknown): DecodedAgent {
  if (!Value.Check(AgentResponseSchema, value)) {
    const detail = [...Value.Errors(AgentResponseSchema, value)][0]?.message ?? "invalid shape";
    throw invalidAgentShape(detail);
  }
  return Value.Decode(AgentResponseSchema, value).result.agent;
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
