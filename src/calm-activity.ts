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
  readonly completedTools?: readonly CalmToolActivity[] | undefined;
  readonly activeTools?: readonly CalmToolActivity[] | undefined;
}
type ActivityTheme = Pick<ExtensionUIContext["theme"], "fg" | "italic">;

const MAX_ACTIVITY_CRUMBS = 3;
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
  readonly settle: (preserveHistory: boolean) => void;
  readonly clear: () => void;
  readonly snapshot: () => Pick<CalmActivityState, "phase" | "completedTools" | "activeTools">;
}

export function isCalmActivityActive(state: CalmActivityState): boolean {
  return state.coordinatorActive || state.activeWorkers > 0 || state.waitingForInput === true;
}

function detailLabel(state: CalmActivityState): string | undefined {
  const workers = `${state.activeWorkers} worker${state.activeWorkers === 1 ? "" : "s"} active`;
  if (state.waitingForInput === true)
    return state.activeWorkers > 0 ? `awaiting input · ${workers}` : "awaiting input";
  return state.activeWorkers > 0 ? workers : undefined;
}

function safeToolName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_:-]/g, "").slice(0, MAX_TOOL_NAME_WIDTH);
  return safe === "" ? "tool" : safe;
}

function toolLabel(tool: CalmToolActivity): string {
  const name = safeToolName(tool.toolName);
  if (tool.pathHint === undefined) return name;
  return `${name} ${truncateToWidth(tool.pathHint, MAX_PATH_HINT_WIDTH, "")}`;
}

function activeToolLabels(tools: readonly CalmToolActivity[]): string[] {
  if (tools.length <= MAX_ACTIVITY_CRUMBS) return tools.map(toolLabel);
  return [
    ...tools.slice(0, MAX_ACTIVITY_CRUMBS - 1).map(toolLabel),
    `+${tools.length - (MAX_ACTIVITY_CRUMBS - 1)} tools`,
  ];
}

function activityLabel(state: CalmActivityState): string | undefined {
  if (state.calmOn !== true || state.waitingForInput === true) return undefined;
  const active = activeToolLabels(state.activeTools ?? []);
  const phase = active.length === 0 && state.coordinatorActive ? state.phase : undefined;
  const live = phase === undefined ? active : [phase];
  const historySlots = MAX_ACTIVITY_CRUMBS - live.length;
  const history =
    historySlots === 0 ? [] : (state.completedTools ?? []).slice(-historySlots).map(toolLabel);
  const crumbs = [...history, ...live];
  return crumbs.length === 0 ? undefined : crumbs.join(" › ");
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
  const detail = detailLabel(state);
  const styledDetail = detail === undefined ? "" : theme.fg("muted", ` · ${detail}`);
  const status = truncateToWidth(`${pulse} ${title}${styledDetail}`, width, "");
  const current = activityLabel(state);
  if (current === undefined) return [status];
  return [truncateToWidth(theme.italic(theme.fg("dim", current)), width, ""), status];
}

export function createCalmActivityTracker(onChange: () => void = () => {}): CalmActivityTracker {
  let phase: CalmActivityPhase | undefined;
  const completedTools: CalmToolActivity[] = [];
  const tools = new Map<string, CalmToolActivity>();
  const changed = (): void => onChange();
  const clearCurrent = (): void => {
    phase = undefined;
    tools.clear();
  };

  return {
    startAgent(): void {
      completedTools.length = 0;
      tools.clear();
      phase = "thinking";
      changed();
    },
    messageUpdate(eventType: string): void {
      if (eventType.startsWith("thinking_")) phase = "thinking";
      else if (eventType.startsWith("text_")) phase = "responding";
      else return;
      changed();
    },
    toolStart(toolCallId: string, toolName: string, args: unknown): void {
      phase = undefined;
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
      const tool = tools.get(toolCallId);
      if (tool === undefined) return;
      tools.delete(toolCallId);
      completedTools.push(tool);
      if (completedTools.length > MAX_ACTIVITY_CRUMBS)
        completedTools.splice(0, completedTools.length - MAX_ACTIVITY_CRUMBS);
      changed();
    },
    settle(preserveHistory: boolean): void {
      const hadCurrent = phase !== undefined || tools.size > 0;
      const hadHistory = completedTools.length > 0;
      clearCurrent();
      if (!preserveHistory) completedTools.length = 0;
      if (hadCurrent || (!preserveHistory && hadHistory)) changed();
    },
    clear(): void {
      if (phase === undefined && completedTools.length === 0 && tools.size === 0) return;
      clearCurrent();
      completedTools.length = 0;
      changed();
    },
    snapshot(): Pick<CalmActivityState, "phase" | "completedTools" | "activeTools"> {
      return { phase, completedTools: [...completedTools], activeTools: [...tools.values()] };
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
