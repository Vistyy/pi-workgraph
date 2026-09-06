import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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

/** The garden is decorative, not a progress bar or a worker-to-flower mapping. */
export function calmActivityLines(
  state: CalmActivityState,
  frame: number,
  width: number,
  theme: ActivityTheme,
  garden = true,
): string[] {
  if (width < 1 || !isCalmActivityActive(state)) return [];
  const title = theme.fg("accent", "Workgraph");
  const detail = theme.fg("muted", label(state));
  const heading = `${title}  ${theme.fg("muted", "·")}  ${detail}`;
  if (!garden || width < 36) {
    const pulse = state.waitingForInput === true ? "◇" : (["○", "◦", "•", "◦"][frame % 4] ?? "○");
    return [truncateToWidth(`${theme.fg("accent", pulse)} ${heading}`, width, "")];
  }

  const count = Math.min(7, Math.max(3, Math.floor(width / 16)));
  const stems = Array.from(
    { length: count },
    (_, i) => Math.round(((i + 0.5) * (width - 4)) / count) + 2,
  );
  // A single firefly drifts along the path and back; speed is independent of worker count.
  const span = width - 1;
  const phase = frame % (span * 2);
  const firefly = phase <= span ? phase : span * 2 - phase;
  const blooms = Array.from({ length: width }, () => " ");
  for (const [index, stem] of stems.entries()) {
    const awake = Math.abs(stem - firefly) <= 3;
    blooms[stem - 1] = theme.fg("muted", "╭");
    blooms[stem] = theme.fg(awake ? "accent" : "muted", awake ? "✦" : "○");
    blooms[stem + 1] = theme.fg("muted", index % 2 === 0 ? "╮" : "·");
  }
  const path = Array.from({ length: width }, (_, column) => {
    if (column === firefly && (state.waitingForInput !== true || state.activeWorkers > 0))
      return theme.fg("accent", "•");
    return theme.fg("muted", stems.includes(column) ? "┴" : "─");
  }).join("");
  return [
    truncateToWidth(heading, width, "") + " ".repeat(Math.max(0, width - visibleWidth(heading))),
    blooms.join(""),
    path,
  ];
}
