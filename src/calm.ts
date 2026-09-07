// SAFETY: Pi's bundled runtime is inspected read-only to locate its actual presentation module.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { readdir, readFile } from "node:fs/promises";
// SAFETY: These paths locate the read-only installed Pi bundle; no installed file is modified.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { dirname, join } from "node:path";
// SAFETY: This converts the discovered installed module path to an import URL only.
import { pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  type CalmActivityState,
  calmActivityLines,
  isCalmActivityActive,
} from "./calm-activity.js";
import { type CalmPreferences, calmPreferences } from "./calm-preferences.js";
import { attachCalmSeparators } from "./calm-separators.js";

export { calmActivityLines, isCalmActivityActive } from "./calm-activity.js";

// SAFETY: This module is the narrowly guarded internal Pi rendering compatibility boundary.
// Its unknown/reflection checks parse runtime exports and instances so a changed seam falls back visibly.
// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-reflect-get

export const DEFAULT_CALM_HIDDEN_TOOLS = [
  "bash",
  "edit",
  "find",
  "grep",
  "ls",
  "powershell",
  "read",
  "write",
  "fetch_content",
  "get_search_content",
  "source_check",
  "web_search",
  "workgraph_notepad",
  "workgraph_models",
  "workgraph_research",
  "workgraph_intent",
  "workgraph_implement",
  "workgraph_review",
  "workgraph_inspect",
  "workgraph_control",
  "workgraph_adopt",
  "workgraph_fork",
  "workgraph_complete",
  "workgraph_todo",
  "workgraph_report",
  "herdr_rename",
] as const;

export const CALM_OPERATIONAL_MESSAGE_TYPES = [
  "pi-workgraph-workstream",
  "pi-workgraph-attention",
] as const;

const CALM_INTERVAL_MS = 400;
const CALM_SESSION_ENTRY = "pi-workgraph-calm-preference";
const CalmSessionSchema = Type.Object({ sessionId: Type.String(), on: Type.Boolean() });
const PATCH_OWNER = Symbol.for("@vistyy/pi-workgraph/calm-presentation");

type Render = (width: number) => string[];
type CalmMouseEvent = {
  readonly [key: string]: string | number | boolean | undefined;
};
type MouseHandler = (event: CalmMouseEvent) => CalmMouseEvent | undefined;
type PresentationInstance = {
  render: Render;
  handleMouse: MouseHandler | undefined;
};
type PresentationPrototype = PresentationInstance & {
  readonly [PATCH_OWNER]?: Render;
};
type PresentationConstructor = {
  prototype: PresentationPrototype;
};
export interface CalmPresentationModule {
  readonly ToolExecutionComponent: PresentationConstructor;
  readonly CustomMessageComponent: PresentationConstructor;
  readonly AssistantMessageComponent: PresentationConstructor;
}

export interface CalmPresentationState {
  on: boolean;
  readonly hiddenTools: ReadonlySet<string>;
  readonly hiddenMessageTypes: ReadonlySet<string>;
}

export interface CalmMode {
  setActiveWorkers(count: number): void;
}

type Detach = () => void;
type Diagnostic = (message: string) => void;
type PresentationLoader = () => Promise<unknown>;

export function isCoordinatorScope(env: { readonly PI_WORKGRAPH_MODE?: string }): boolean {
  return env.PI_WORKGRAPH_MODE === undefined || env.PI_WORKGRAPH_MODE === "";
}

export function parseCalmHiddenTools(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_CALM_HIDDEN_TOOLS];
  return [
    ...new Set(
      raw
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
}

export function attachCalmPresentation(
  module: CalmPresentationModule,
  state: CalmPresentationState,
  diagnostic: Diagnostic,
  separatorStyle: (text: string) => string = (text) => text,
): Detach {
  const detachTool = patchPrototype(
    module.ToolExecutionComponent.prototype,
    "tool rows",
    (component) => readStringProperty(component, "toolName"),
    (name) => state.hiddenTools.has(name),
    state,
    diagnostic,
  );
  try {
    const detachMessage = patchPrototype(
      module.CustomMessageComponent.prototype,
      "custom messages",
      (component) => readStringProperty(readProperty(component, "message"), "customType"),
      (name) => state.hiddenMessageTypes.has(name),
      state,
      diagnostic,
    );
    try {
      const detachSeparators = attachCalmSeparators(
        module.AssistantMessageComponent.prototype,
        () => state.on,
        separatorStyle,
        diagnostic,
      );
      return () => {
        detachSeparators();
        detachMessage();
        detachTool();
      };
    } catch (error) {
      detachMessage();
      throw error;
    }
  } catch (error) {
    detachTool();
    throw error;
  }
}

export function installCalmMode(
  pi: ExtensionAPI,
  options: {
    readonly hiddenTools?: readonly string[];
    readonly loadPresentation?: PresentationLoader;
    readonly intervalMs?: number;
    readonly preferences?: CalmPreferences;
  } = {},
): CalmMode {
  const state: CalmPresentationState = {
    on: false,
    hiddenTools: new Set(
      options.hiddenTools ??
        parseCalmHiddenTools(readEnvironmentVariable("PI_WORKGRAPH_CALM_HIDDEN_TOOLS")),
    ),
    hiddenMessageTypes: new Set(CALM_OPERATIONAL_MESSAGE_TYPES),
  };
  const preferences = options.preferences ?? calmPreferences();
  const loadPresentation = options.loadPresentation ?? loadPiPresentation;
  const intervalMs = options.intervalMs ?? CALM_INTERVAL_MS;
  let ui: ExtensionUIContext | undefined;
  let detach: Detach | undefined;
  let adapterReady = false;
  let coordinatorActive = false;
  let waitingForInput = false;
  let activeWorkers = 0;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  let widgetVisible = false;
  let requestWidgetRender: (() => void) | undefined;
  const diagnosed = new Set<string>();

  const activity = (): CalmActivityState => ({ coordinatorActive, activeWorkers, waitingForInput });
  const stopTimer = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const renderStatus = (): void => {
    if (!state.on || ui === undefined) return;
    ui.setStatus("calm", ui.theme.fg("dim", "calm"));
  };
  const clearWidget = (): void => {
    if (widgetVisible && ui !== undefined) ui.setWidget("calm", undefined);
    widgetVisible = false;
    requestWidgetRender = undefined;
  };
  const syncWidget = (): void => {
    if (ui === undefined || !isCalmActivityActive(activity())) {
      clearWidget();
      return;
    }
    if (widgetVisible) {
      requestWidgetRender?.();
      return;
    }
    widgetVisible = true;
    ui.setWidget("calm", (tui, theme) => {
      const request = (): void => tui.requestRender();
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
    if (
      ui === undefined ||
      !isCalmActivityActive(activity()) ||
      (waitingForInput && activeWorkers === 0)
    ) {
      stopTimer();
      return;
    }
    if (timer !== undefined) return;
    // SAFETY: This timer only drives presentation animation and is cleared by stopTimer/shutdown.
    // oxlint-disable-next-line effecttsgo/global-timers
    timer = setInterval(() => {
      frame += 1;
      requestWidgetRender?.();
    }, intervalMs);
  };
  const syncChrome = (): void => {
    if (ui === undefined) return;
    // Both views own the single activity surface; never stack Pi's spinner above it.
    ui.setWorkingVisible(false);
    if (state.on) renderStatus();
    else ui.setStatus("calm", undefined);
    syncWidget();
    syncTimer();
  };
  const diagnose = (message: string): void => {
    if (diagnosed.has(message)) return;
    diagnosed.add(message);
    queueMicrotask(() =>
      ui?.notify(`Calm unavailable: ${message} Rows remain visible.`, "warning"),
    );
  };
  const detachPresentation = (): void => {
    detach?.();
    detach = undefined;
    adapterReady = false;
  };
  const shutdown = (): void => {
    generation += 1;
    state.on = false;
    stopTimer();
    detachPresentation();
    if (ui !== undefined) {
      clearWidget();
      ui.setStatus("calm", undefined);
      ui.setWorkingIndicator();
      ui.setWorkingVisible(true);
    }
    ui = undefined;
    coordinatorActive = false;
    waitingForInput = false;
    activeWorkers = 0;
    frame = 0;
  };

  pi.on("session_start", (_event, ctx) => {
    shutdown();
    if (ctx.mode !== "tui") return;
    ui = ctx.ui;
    coordinatorActive = !ctx.isIdle();
    const currentGeneration = generation;
    const sessionId = ctx.sessionManager.getSessionId();
    const saved = ctx.sessionManager
      .getEntries()
      .findLast(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === CALM_SESSION_ENTRY &&
          Value.Check(CalmSessionSchema, entry.data) &&
          entry.data.sessionId === sessionId,
      );
    const sessionChoice =
      saved?.type === "custom" && Value.Check(CalmSessionSchema, saved.data)
        ? saved.data.on
        : undefined;
    const initial =
      sessionChoice === undefined
        ? preferences.load().catch((error: unknown) => {
            if (currentGeneration === generation)
              ctx.ui.notify(`Could not load Calm default: ${errorMessage(error)}`, "warning");
            return false;
          })
        : Promise.resolve(sessionChoice);
    return initial
      .then((on) => {
        if (currentGeneration !== generation) return;
        if (sessionChoice === undefined) pi.appendEntry(CALM_SESSION_ENTRY, { sessionId, on });
        state.on = on;
        return loadPresentation();
      })
      .then((loaded) => {
        if (currentGeneration !== generation) return;
        const presentation = decodePresentationModule(loaded);
        if (presentation === undefined)
          throw new Error("this Pi version does not expose the expected component classes.");
        detach = attachCalmPresentation(
          presentation,
          state,
          diagnose,
          (text) => ui?.theme.fg("dim", text) ?? text,
        );
        adapterReady = true;
        syncChrome();
      })
      .catch((error: unknown) => {
        if (currentGeneration !== generation) return;
        detachPresentation();
        state.on = false;
        syncChrome();
        diagnose(errorMessage(error));
      });
  });
  pi.on("agent_start", () => {
    coordinatorActive = true;
    renderStatus();
    syncWidget();
    syncTimer();
  });
  pi.on("agent_settled", () => {
    coordinatorActive = false;
    frame = 0;
    renderStatus();
    syncWidget();
    syncTimer();
  });
  pi.on("ui_prompt_start", () => {
    waitingForInput = true;
    syncWidget();
    syncTimer();
  });
  pi.on("ui_prompt_end", () => {
    waitingForInput = false;
    syncWidget();
    syncTimer();
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
        .catch((error: unknown) => {
          ctx.ui.notify(`Could not save Calm preference: ${errorMessage(error)}`, "error");
        }),
  });

  return {
    setActiveWorkers(count: number): void {
      activeWorkers = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
      renderStatus();
      syncWidget();
      syncTimer();
    },
  };
}

function patchPrototype(
  prototype: PresentationPrototype,
  label: string,
  readName: (component: unknown) => string | undefined,
  shouldHideName: (name: string) => boolean,
  state: CalmPresentationState,
  diagnostic: Diagnostic,
): Detach {
  if (typeof prototype?.render !== "function")
    throw new Error(`the Pi ${label} render seam is missing.`);
  if (readProperty(prototype, PATCH_OWNER) !== undefined)
    throw new Error(`the Pi ${label} render seam is already adapted.`);
  const originalRender = prototype.render;
  const originalRenderDescriptor = Object.getOwnPropertyDescriptor(prototype, "render");
  const originalMouse = prototype.handleMouse;
  const originalMouseDescriptor = Object.getOwnPropertyDescriptor(prototype, "handleMouse");
  let metadataWarning = false;
  const hidden = (component: unknown): boolean => {
    if (!state.on) return false;
    const name = readName(component);
    if (name !== undefined) return shouldHideName(name);
    if (!metadataWarning) {
      metadataWarning = true;
      diagnostic(`the Pi ${label} metadata seam changed.`);
    }
    return false;
  };
  const wrappedRender: Render = function (this: PresentationInstance, width): string[] {
    try {
      if (hidden(this)) return [];
    } catch (error) {
      diagnostic(`the Pi ${label} filter failed: ${errorMessage(error)}.`);
    }
    return originalRender.call(this, width);
  };
  const wrappedMouse: MouseHandler | undefined =
    originalMouse === undefined
      ? undefined
      : function (this: PresentationInstance, event): CalmMouseEvent | undefined {
          try {
            if (hidden(this)) return undefined;
          } catch (error) {
            diagnostic(`the Pi ${label} mouse filter failed: ${errorMessage(error)}.`);
          }
          return originalMouse.call(this, event);
        };

  const restore = (): void => {
    if (originalRenderDescriptor === undefined) Reflect.deleteProperty(prototype, "render");
    else Object.defineProperty(prototype, "render", originalRenderDescriptor);
    if (wrappedMouse !== undefined) {
      if (originalMouseDescriptor === undefined) Reflect.deleteProperty(prototype, "handleMouse");
      else Object.defineProperty(prototype, "handleMouse", originalMouseDescriptor);
    }
    Reflect.deleteProperty(prototype, PATCH_OWNER);
  };
  try {
    prototype.render = wrappedRender;
    if (wrappedMouse !== undefined) prototype.handleMouse = wrappedMouse;
    Object.defineProperty(prototype, PATCH_OWNER, {
      configurable: true,
      value: wrappedRender,
    });
  } catch (error) {
    restore();
    throw error;
  }
  let attached = true;
  return () => {
    if (!attached) return;
    attached = false;
    if (prototype.render !== wrappedRender)
      diagnostic(`the Pi ${label} render seam changed before cleanup.`);
    if (wrappedMouse !== undefined && prototype.handleMouse !== wrappedMouse)
      diagnostic(`the Pi ${label} mouse seam changed before cleanup.`);
    restore();
  };
}

function decodePresentationModule(value: unknown): CalmPresentationModule | undefined {
  const tool = readProperty(value, "ToolExecutionComponent");
  const custom = readProperty(value, "CustomMessageComponent");
  const assistant = readProperty(value, "AssistantMessageComponent");
  if (
    !isPresentationConstructor(tool) ||
    !isPresentationConstructor(custom) ||
    !isPresentationConstructor(assistant)
  )
    return undefined;
  return {
    ToolExecutionComponent: tool,
    CustomMessageComponent: custom,
    AssistantMessageComponent: assistant,
  };
}

function isPresentationConstructor(value: unknown): value is PresentationConstructor {
  if (typeof value !== "function") return false;
  const prototype = readProperty(value, "prototype");
  return readProperty(prototype, "render") instanceof Function;
}

function readProperty(value: unknown, key: PropertyKey): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null)
    return undefined;
  return Reflect.get(value, key);
}

function readStringProperty(value: unknown, key: PropertyKey): string | undefined {
  const property = readProperty(value, key);
  return typeof property === "string" ? property : undefined;
}

function readEnvironmentVariable(name: string): string | undefined {
  const value = Reflect.get(process.env, name);
  return typeof value === "string" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function activeWorkerCount(state: {
  readonly attempts: readonly { readonly state: string }[];
}): number {
  return state.attempts.filter(
    (attempt) => attempt.state === "running" || attempt.state === "starting",
  ).length;
}

export function updateCalmWorkers(
  calm: CalmMode,
  state: Parameters<typeof activeWorkerCount>[0],
): void {
  calm.setActiveWorkers(activeWorkerCount(state));
}

function loadPiPresentation(): Promise<unknown> {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined || entrypoint === "")
    return import("@earendil-works/pi-coding-agent");
  const chunks = join(dirname(entrypoint), "chunks");
  return readdir(chunks, { withFileTypes: true })
    .then((entries) =>
      Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
          .map((entry) => {
            const path = join(chunks, entry.name);
            return readFile(path, "utf8").then((source) => ({ path, source }));
          }),
      ),
    )
    .then((candidates) => {
      const match = candidates.find(
        ({ source }) =>
          source.includes("ToolExecutionComponent") &&
          source.includes("CustomMessageComponent") &&
          source.includes("AssistantMessageComponent"),
      );
      return match === undefined
        ? import("@earendil-works/pi-coding-agent")
        : import(pathToFileURL(match.path).href);
    })
    .catch(() => import("@earendil-works/pi-coding-agent"));
}

export type CalmContext = Pick<ExtensionContext, "mode" | "ui">;
