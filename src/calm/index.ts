import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  type CalmActivityState,
  calmActivityLines,
  createCalmActivityTracker,
  isCalmActivityActive,
} from "./activity.js";
import { type CalmChatRuntime, loadCalmChatRuntime } from "./pi-runtime.js";
import { type CalmPreferences, calmPreferences } from "./preferences.js";
import { attachCalmProjection, type CalmProjection, discoverCalmChat } from "./projection.js";

export {
  calmActivityLines,
  createCalmActivityTracker,
  isCalmActivityActive,
} from "./activity.js";

const CALM_INTERVAL_MS = 400;

const CALM_WIDGET = "calm";

const CALM_PROBE_WIDGET = "calm-probe";

const CALM_STATUS = "calm";

const CALM_SESSION_ENTRY = "pi-workgraph-calm-preference";

const CalmSessionSchema = Type.Object({ sessionId: Type.String(), on: Type.Boolean() });

export interface CalmMode {
  setActiveWorkers(count: number): void;
}

type Diagnostic = (message: string) => void;

export function isCoordinatorScope(env: { readonly PI_WORKGRAPH_ROLE?: string }): boolean {
  return env.PI_WORKGRAPH_ROLE === undefined || env.PI_WORKGRAPH_ROLE === "";
}

interface CalmSessionEntryLike {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

/** Read the last saved Calm on/off choice for one session from Pi's persisted entries. */
function savedCalmChoice(
  entries: readonly CalmSessionEntryLike[],
  sessionId: string,
): boolean | undefined {
  const saved = entries.findLast(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === CALM_SESSION_ENTRY &&
      Value.Check(CalmSessionSchema, entry.data) &&
      entry.data.sessionId === sessionId,
  );

  if (saved === undefined || !Value.Check(CalmSessionSchema, saved.data)) return undefined;

  return saved.data.on;
}

/** Load the saved startup default, reporting a read failure once as a non-fatal warning. */
function loadDefaultCalm(
  ui: ExtensionUIContext,
  preferences: CalmPreferences,
  isCurrent: () => boolean,
): Promise<boolean> {
  return preferences.load().catch((error) => {
    if (isCurrent())
      ui.notify(
        `Could not load Calm default: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );

    return false;
  });
}

/**
 * Calm replaces coordinator presentation, not coordination state.
 *
 * It discovers the live Pi chat once, binds one guarded projection adapter to that exact instance,
 * and pushes Calm on/off through the adapter. Any discovery, binding, or classification failure
 * disables the projection and returns the native transcript instead of leaving partial filtering.
 */
export function installCalmMode(
  pi: ExtensionAPI,
  options: {
    readonly intervalMs?: number;
    readonly preferences?: CalmPreferences;
    /** Tests inject the running Pi presentation classes; production loads them from the live CLI. */
    readonly loadRuntime?: () => Promise<CalmChatRuntime>;
  } = {},
): CalmMode {
  const preferences = options.preferences ?? calmPreferences();
  const loadRuntime = options.loadRuntime ?? loadCalmChatRuntime;
  const intervalMs = options.intervalMs ?? CALM_INTERVAL_MS;
  const state = { on: false };
  let ui: ExtensionUIContext | undefined;
  let projection: CalmProjection | undefined;
  let adapterReady = false;
  let coordinatorActive = false;
  let waitingForInput = false;
  let activeWorkers = 0;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  let widgetVisible = false;
  let widgetSignature: string | undefined;
  let statusPublished = false;
  let workingHidden = false;
  let requestWidgetRender: (() => void) | undefined;
  // Report each real incompatibility once per session.
  const diagnosed = new Set<string>();
  let activityTracker: ReturnType<typeof createCalmActivityTracker>;

  const activity = (): CalmActivityState => ({
    calmOn: state.on,
    coordinatorActive,
    activeWorkers,
    waitingForInput,
    ...activityTracker.snapshot(),
  });

  const pulsing = (): boolean => state.on && coordinatorActive && !waitingForInput;

  const renderSignature = (current: CalmActivityState): string =>
    JSON.stringify([current, pulsing() ? frame % 4 < 2 : false]);

  const stopTimer = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  const publishStatus = (visible: boolean): void => {
    if (ui === undefined || visible === statusPublished) return;
    statusPublished = visible;
    ui.setStatus(CALM_STATUS, visible ? ui.theme.fg("dim", "calm") : undefined);
  };

  const clearWidget = (): void => {
    if (widgetVisible && ui !== undefined) ui.setWidget(CALM_WIDGET, undefined);
    widgetVisible = false;
    widgetSignature = undefined;
    requestWidgetRender = undefined;
  };

  const syncWidget = (): void => {
    if (ui === undefined || !state.on) {
      clearWidget();

      return;
    }

    const current = activity();

    if (!isCalmActivityActive(current)) {
      clearWidget();

      return;
    }

    const signature = renderSignature(current);

    if (widgetVisible) {
      if (signature === widgetSignature) return;
      widgetSignature = signature;
      requestWidgetRender?.();

      return;
    }

    widgetVisible = true;
    widgetSignature = signature;
    ui.setWidget(CALM_WIDGET, (tui, theme) => {
      const request: () => void = () => tui.requestRender();
      requestWidgetRender = request;

      return {
        render: (width) => calmActivityLines(activity(), frame, width, theme),
        invalidate() {},
        dispose() {
          if (requestWidgetRender === request) requestWidgetRender = undefined;
        },
      };
    });
  };

  const syncTimer = (): void => {
    if (ui === undefined || !pulsing()) {
      stopTimer();

      return;
    }

    if (timer !== undefined) return;
    // SAFETY: This timer only advances the rail pulse and is cleared by stopTimer and shutdown.
    // oxlint-disable-next-line effecttsgo/global-timers
    timer = setInterval(() => {
      frame += 1;
      syncWidget();
    }, intervalMs);
  };

  activityTracker = createCalmActivityTracker(() => {
    syncWidget();
    syncTimer();
  });

  const syncChrome = (): void => {
    if (ui === undefined) return;
    projection?.setEnabled(state.on);

    if (state.on) {
      if (!workingHidden) {
        // Calm owns the single activity surface; Pi keeps its working indicator hidden.
        ui.setWorkingVisible(false);
        workingHidden = true;
      }

      publishStatus(true);
    } else {
      if (workingHidden) {
        ui.setWorkingVisible(true);
        workingHidden = false;
      }

      publishStatus(false);
    }

    syncWidget();
    syncTimer();
  };

  // Calm becomes unavailable only for a real incompatibility that disables the projection.
  const diagnose: Diagnostic = (message) => {
    if (diagnosed.has(message)) return;
    diagnosed.add(message);
    const diagnosedGeneration = generation;
    queueMicrotask(() => {
      // A stale failure must not disable a newer attachment or rewrite current chrome.
      if (diagnosedGeneration !== generation) return;

      if (state.on) state.on = false;
      adapterReady = false;
      const current = projection;
      projection = undefined;
      current?.detach();
      syncChrome();
      ui?.notify(`Calm unavailable: ${message} Native rows remain visible.`, "warning");
    });
  };

  const shutdown = (): void => {
    generation += 1;
    diagnosed.clear();
    state.on = false;
    activityTracker.clear();
    stopTimer();
    projection?.detach();
    projection = undefined;
    adapterReady = false;

    if (ui !== undefined) {
      clearWidget();
      publishStatus(false);

      if (workingHidden) {
        ui.setWorkingVisible(true);
        workingHidden = false;
      }
    }

    ui = undefined;
    coordinatorActive = false;
    waitingForInput = false;
    activeWorkers = 0;
    frame = 0;
  };

  const captureTui = (context: ExtensionUIContext): TUI | undefined => {
    let captured: TUI | undefined;
    context.setWidget(CALM_PROBE_WIDGET, (tui) => {
      captured = tui;

      return { render: () => [], invalidate() {}, dispose() {} };
    });
    context.setWidget(CALM_PROBE_WIDGET, undefined);

    return captured;
  };

  const attachProjection = (chatRuntime: CalmChatRuntime): void => {
    if (ui === undefined) throw new Error("the Pi TUI is unavailable.");
    const tui = captureTui(ui);

    if (tui === undefined) throw new Error("the Pi TUI root seam is missing.");
    projection = attachCalmProjection(discoverCalmChat(tui, chatRuntime), {
      runtime: chatRuntime,
      styleSeparator: (text) => ui?.theme.fg("dim", text) ?? text,
      onIncompatible: diagnose,
    });
  };

  // Loading the running Pi module is a native dynamic import that must settle before attachment.
  // oxlint-disable-next-line effecttsgo/async-function
  const startSession = async (
    currentGeneration: number,
    on: boolean,
    appendSavedChoice: ((on: boolean) => void) | undefined,
  ): Promise<void> => {
    if (currentGeneration !== generation) return;
    appendSavedChoice?.(on);
    state.on = on;

    try {
      const chatRuntime = await loadRuntime();

      if (currentGeneration !== generation) return;
      attachProjection(chatRuntime);
      adapterReady = true;
    } catch (error) {
      // A superseded session's rejection must not mutate or report through the current one.
      if (currentGeneration !== generation) return;
      adapterReady = false;
      state.on = false;
      diagnose(error instanceof Error ? error.message : String(error));
    }

    syncChrome();
  };

  pi.on("session_start", (_event, ctx) => {
    shutdown();

    if (ctx.mode !== "tui") return;
    ui = ctx.ui;
    coordinatorActive = !ctx.isIdle();
    const currentGeneration = generation;
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionChoice = savedCalmChoice(ctx.sessionManager.getEntries(), sessionId);

    const initial =
      sessionChoice === undefined
        ? loadDefaultCalm(ctx.ui, preferences, () => currentGeneration === generation)
        : Promise.resolve(sessionChoice);

    return initial.then((on) =>
      startSession(
        currentGeneration,
        on,
        sessionChoice === undefined
          ? (value) => pi.appendEntry(CALM_SESSION_ENTRY, { sessionId, on: value })
          : undefined,
      ),
    );
  });
  pi.on("agent_start", () => {
    coordinatorActive = true;
    frame = 0;
    activityTracker.startAgent();
    syncChrome();
  });
  pi.on("message_update", (event) => {
    if (event.message.role === "assistant")
      activityTracker.messageUpdate(event.assistantMessageEvent.type);
  });
  pi.on("tool_execution_start", (event) => {
    // Pi exposes tool args without a runtime-safe static shape; the activity tracker guards them.
    activityTracker.toolStart(event.toolCallId, event.toolName, event.args);
  });
  pi.on("tool_execution_end", (event) => {
    activityTracker.toolEnd(event.toolCallId);
  });
  pi.on("agent_settled", () => {
    coordinatorActive = false;
    activityTracker.settle(activeWorkers > 0);
    frame = 0;
    syncChrome();
  });
  pi.on("ui_prompt_start", () => {
    waitingForInput = true;
    syncChrome();
  });
  pi.on("ui_prompt_end", () => {
    waitingForInput = false;

    if (!coordinatorActive && activeWorkers === 0) activityTracker.clear();
    syncChrome();
  });
  pi.on("session_shutdown", () => shutdown());

  pi.registerCommand("calm", {
    description: "Toggle Calm for this session; /calm default on|off saves the startup default",
    getArgumentCompletions: (prefix) =>
      ["default on", "default off"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: (args, ctx) =>
      Promise.resolve()
        .then(() => {
          const command = args.trim();

          if (command === "default on" || command === "default off") {
            const currentGeneration = generation;

            return preferences.save(command === "default on").then(() => {
              if (currentGeneration === generation)
                ctx.ui.notify(
                  `Calm default ${command === "default on" ? "on" : "off"} saved for new coordinator sessions. This session is unchanged.`,
                  "info",
                );
            });
          }

          if (command !== "") {
            ctx.ui.notify("Usage: /calm or /calm default on|off", "warning");

            return;
          }

          if (!state.on && (!adapterReady || ctx.mode !== "tui")) {
            ctx.ui.notify(
              "Calm is unavailable in this session; operational rows remain visible.",
              "warning",
            );

            return;
          }

          pi.appendEntry(CALM_SESSION_ENTRY, {
            sessionId: ctx.sessionManager.getSessionId(),
            on: !state.on,
          });
          state.on = !state.on;
          frame = 0;
          syncChrome();
          ctx.ui.notify(
            `Calm ${state.on ? "on" : "off"} for this session (saved default unchanged).`,
            "info",
          );

          return;
        })
        .catch((error) => {
          ctx.ui.notify(
            `Could not save Calm preference: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }),
  });

  return {
    setActiveWorkers(count: number): void {
      const next = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;

      if (next === activeWorkers) return;
      activeWorkers = next;

      if (activeWorkers === 0 && !coordinatorActive && !waitingForInput) activityTracker.clear();
      syncChrome();
    },
  };
}
