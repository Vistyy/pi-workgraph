import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

// SAFETY: Pi exposes tool arguments as an untyped runtime value. This module deliberately accepts
// unknown and applies a fail-closed structural guard before reading the one allowlisted property.
// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof

export type CalmActivityPhase = "thinking" | "responding";
export type CalmToolActivity = {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly pathHint?: string;
};

export interface CalmActivityState {
  readonly calmOn?: boolean;
  readonly coordinatorActive: boolean;
  readonly activeWorkers: number;
  readonly waitingForInput?: boolean;
  readonly phase?: CalmActivityPhase | undefined;
  readonly activeTools?: readonly CalmToolActivity[] | undefined;
}
type ActivityTheme = Pick<ExtensionUIContext["theme"], "fg" | "italic">;

const MAX_TOOL_NAMES = 4;
const MAX_TOOL_NAME_WIDTH = 24;
const MAX_PATH_HINT_WIDTH = 32;
const PATH_HINT_TOOLS = new Set(["read", "edit", "write"]);

interface MutableToolActivity {
  toolCallId: string;
  toolName: string;
  pathHint?: string;
}
export interface CalmActivityTracker {
  readonly startAgent: () => void;
  readonly messageUpdate: (eventType: string) => void;
  readonly toolStart: (toolCallId: string, toolName: string, args: unknown) => void;
  readonly toolEnd: (toolCallId: string) => void;
  readonly clear: () => void;
  readonly snapshot: () => Pick<CalmActivityState, "phase" | "activeTools">;
}

export function isCalmActivityActive(state: CalmActivityState): boolean {
  return state.coordinatorActive || state.activeWorkers > 0 || state.waitingForInput === true;
}

function label(state: CalmActivityState): string {
  const workers = `${state.activeWorkers} worker${state.activeWorkers === 1 ? "" : "s"} active`;
  const coordinator = state.waitingForInput === true ? "awaiting input" : "coordinating";
  if (state.coordinatorActive || state.waitingForInput === true)
    return state.activeWorkers > 0 ? `${coordinator} · ${workers}` : coordinator;
  return workers;
}

function safeToolName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_:-]/g, "").slice(0, MAX_TOOL_NAME_WIDTH);
  return safe === "" ? "tool" : safe;
}

function activityLabel(state: CalmActivityState): string | undefined {
  if (state.calmOn !== true || !state.coordinatorActive || state.waitingForInput === true)
    return undefined;
  const tools = state.activeTools ?? [];
  if (tools.length > 0) {
    const names = tools.slice(0, MAX_TOOL_NAMES).map((tool) => safeToolName(tool.toolName));
    if (tools.length > MAX_TOOL_NAMES) names.push(`+${tools.length - MAX_TOOL_NAMES}`);
    if (tools.length === 1 && tools[0]?.pathHint !== undefined) {
      const hint = truncateToWidth(tools[0].pathHint, MAX_PATH_HINT_WIDTH, "");
      return `${names[0]} · ${hint}`;
    }
    return names.join(" · ");
  }
  return state.phase;
}

export function calmActivityLines(
  state: CalmActivityState,
  frame: number,
  width: number,
  theme: ActivityTheme,
): string[] {
  if (width < 1 || !isCalmActivityActive(state)) return [];
  const waiting = state.waitingForInput === true && state.activeWorkers === 0;
  const pulse = theme.fg(waiting || frame % 4 < 2 ? "muted" : "accent", "•");
  const title = theme.fg("text", "Workgraph");
  const detail = theme.fg("muted", ` · ${label(state)}`);
  const status = truncateToWidth(`${pulse} ${title}${detail}`, width, "");
  const current = activityLabel(state);
  if (current === undefined) return [status];
  return [truncateToWidth(theme.italic(theme.fg("dim", current)), width, ""), status];
}

export function createCalmActivityTracker(onChange: () => void = () => {}): CalmActivityTracker {
  let phase: CalmActivityPhase | undefined;
  const tools = new Map<string, CalmToolActivity>();
  const changed = (): void => onChange();

  return {
    startAgent(): void {
      phase = "thinking";
      tools.clear();
      changed();
    },
    messageUpdate(eventType: string): void {
      if (eventType.startsWith("thinking_")) phase = "thinking";
      else if (eventType.startsWith("text_")) phase = "responding";
      else return;
      changed();
    },
    toolStart(toolCallId: string, toolName: string, args: unknown): void {
      const pathHint = PATH_HINT_TOOLS.has(toolName) ? validatedPathBasename(args) : undefined;
      const tool: MutableToolActivity = {
        toolCallId,
        toolName,
      };
      if (pathHint !== undefined) tool.pathHint = pathHint;
      tools.set(toolCallId, tool);
      changed();
    },
    toolEnd(toolCallId: string): void {
      if (!tools.delete(toolCallId)) return;
      if (tools.size === 0) phase = "thinking";
      changed();
    },
    clear(): void {
      if (phase === undefined && tools.size === 0) return;
      phase = undefined;
      tools.clear();
      changed();
    },
    snapshot(): Pick<CalmActivityState, "phase" | "activeTools"> {
      return { phase, activeTools: [...tools.values()] };
    },
  };
}

function validatedPathBasename(args: unknown): string | undefined {
  // SAFETY: Pi tool arguments are untrusted. Accept only an own data property so malformed
  // getters and proxies fail closed without exposing arbitrary fields.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(args, "path");
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    const path: unknown = descriptor.value;
    if (typeof path !== "string") return undefined;
    const basename = path.split(/[\\/]/u).filter(Boolean).at(-1);
    if (
      basename === undefined ||
      basename === "." ||
      basename === ".." ||
      !/^[A-Za-z0-9._-]+$/.test(basename)
    )
      return undefined;
    return truncateToWidth(basename, MAX_PATH_HINT_WIDTH, "");
  } catch {
    return undefined;
  }
}
