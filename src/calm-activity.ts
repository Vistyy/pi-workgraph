import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export interface CalmActivityState {
  readonly coordinatorActive: boolean;
  readonly activeWorkers: number;
  readonly waitingForInput?: boolean;
}
type ActivityTheme = Pick<ExtensionUIContext["theme"], "fg">;

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
  return [truncateToWidth(`${pulse} ${title}${detail}`, width, "")];
}
