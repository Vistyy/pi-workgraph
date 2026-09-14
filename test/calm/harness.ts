import {
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, Container } from "@earendil-works/pi-tui";
import { installCalmMode } from "../../src/calm/index.js";
import type { CalmChatRuntime } from "../../src/calm/pi-runtime.js";
import type { CalmPreferences } from "../../src/calm/preferences.js";

/**
 * Host fixtures for Calm integration tests. The fake UI captures the widget factory and TUI root
 * exactly as Pi does, so Calm's own widget capture and chat discovery run for real; only the host
 * callbacks are replaced.
 */

export interface FakeTheme {
  fg(color: string, text: string): string;
  italic(text: string): string;
}

export function fakeTheme(): FakeTheme {
  return { fg: (_color, text) => text, italic: (text) => text };
}

export interface FakeWidget {
  render(width: number): string[];
  invalidate?(): void;
  dispose?(): void;
}

export type FakeWidgetFactory = (tui: FakeTui, theme: FakeTheme) => FakeWidget;

export class FakeTui implements Component {
  children: Component[] = [];
  requests = 0;

  addChild(component: Component): void {
    this.children.push(component);
  }

  render(): string[] {
    return [];
  }

  invalidate(): void {}

  requestRender(): void {
    this.requests += 1;
  }
}

/** Mirror Pi's widget capture path: the factory receives the TUI root that Calm inspects. */
export function fakeUi(tui: FakeTui) {
  const statuses = new Map<string, string | undefined>();
  const widgets = new Map<string, FakeWidget | undefined>();
  const notifications: string[] = [];
  const theme = fakeTheme();
  let workingVisible = true;
  const ui = {
    statuses,
    widgets,
    notifications,
    theme,
    get workingVisible(): boolean {
      return workingVisible;
    },
    setStatus(key: string, text: string | undefined): void {
      statuses.set(key, text);
    },
    setWorkingVisible(visible: boolean): void {
      workingVisible = visible;
    },
    setWidget(key: string, content: FakeWidgetFactory | FakeWidget | string[] | undefined): void {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Pi's widget callback may be a factory or plain lines.
      if (typeof content !== "function") {
        widgets.set(key, undefined);
        return;
      }
      widgets.set(key, content(tui, theme));
    },
    notify(message: string): void {
      notifications.push(message);
    },
  };
  return ui;
}

export function fakeTuiRoot(container: () => Container, chat?: Container): FakeTui {
  const document = container();
  document.addChild(container());
  document.addChild(container());
  document.addChild(chat ?? container());
  const tui = new FakeTui();
  tui.addChild(document);
  return tui;
}

interface FakeEvent {
  readonly message?: { readonly role: string };
  readonly assistantMessageEvent?: { readonly type: string };
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly args?: { readonly path?: string };
}

export function fakePi() {
  type Handler = (event: FakeEvent, context: ExtensionContext) => void | Promise<void>;
  const events = new Map<string, Handler>();
  const commands = new Map<
    string,
    (args: string, context: ExtensionContext) => void | Promise<void>
  >();
  const session = SessionManager.inMemory();
  return {
    events,
    commands,
    session,
    appendEntry(customType: string, data: { sessionId: string; on: boolean }): void {
      session.appendCustomEntry(customType, data);
    },
    on(name: string, handler: Handler): void {
      events.set(name, handler);
    },
    registerCommand(
      name: string,
      definition: { handler: (args: string, context: ExtensionContext) => void | Promise<void> },
    ): void {
      commands.set(name, definition.handler);
    },
  };
}

/** Feed a structurally partial fixture into a guarded host boundary. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The adapter, not the fixture type, owns validation of this partial host value.
export function fixture<T>(value: unknown): T {
  // SAFETY: Fixtures supply only the fields Calm consumes; the adapter validates the rest.
  return value as T;
}

export function calmHarness(options: {
  runtime: CalmChatRuntime;
  tui?: FakeTui;
  preferences?: CalmPreferences;
  intervalMs?: number;
  loadRuntime?: () => Promise<CalmChatRuntime>;
}) {
  const tui = options.tui ?? fakeTuiRoot(() => new options.runtime.container());
  const ui = fakeUi(tui);
  const pi = fakePi();
  const calm = installCalmMode(fixture<ExtensionAPI>(pi), {
    intervalMs: options.intervalMs ?? 10_000,
    preferences: options.preferences ?? {
      load: () => Promise.resolve(false),
      save: () => Promise.resolve(),
    },
    loadRuntime: options.loadRuntime ?? (() => Promise.resolve(options.runtime)),
  });
  // SAFETY: The fixture supplies only the ExtensionContext fields Calm consumes.
  const context = fixture<ExtensionContext>({
    mode: "tui",
    ui,
    isIdle: () => true,
    sessionManager: pi.session,
  });
  return { tui, ui, pi, calm, context };
}

export const start = (pi: ReturnType<typeof fakePi>, context: ExtensionContext) =>
  pi.events.get("session_start")?.({}, context);
export const shutdown = (pi: ReturnType<typeof fakePi>, context: ExtensionContext) =>
  pi.events.get("session_shutdown")?.({}, context);
export const command = (pi: ReturnType<typeof fakePi>, context: ExtensionContext, args = "") =>
  pi.commands.get("calm")?.(args, context);
export const messageUpdate = (
  pi: ReturnType<typeof fakePi>,
  context: ExtensionContext,
  type: string,
) =>
  pi.events.get("message_update")?.(
    { message: { role: "assistant" }, assistantMessageEvent: { type } },
    context,
  );
