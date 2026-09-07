import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

// SAFETY: These fakes terminate at the test boundary; production Pi values are decoded by the adapter.
// oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion
import {
  activeWorkerCount,
  attachCalmPresentation,
  calmActivityLines,
  DEFAULT_CALM_HIDDEN_TOOLS,
  installCalmMode,
  isCalmActivityActive,
  isCoordinatorScope,
  parseCalmHiddenTools,
} from "../src/calm.js";

type FakeMouseEvent = {
  readonly y?: number;
  readonly width?: number;
  readonly [key: string]: string | number | boolean | undefined;
};

class FakeToolRow {
  toolName: string;

  constructor(toolName: string) {
    this.toolName = toolName;
  }

  render(width: number): string[] {
    return [`tool:${this.toolName}:${width}`];
  }

  handleMouse(event: FakeMouseEvent): FakeMouseEvent {
    return event;
  }
}

class FakeContainer {
  children: Array<{
    render(width: number): string[];
    handleMouse?: (event: FakeMouseEvent) => FakeMouseEvent;
  }> = [];
  mouseLayout?: {
    width: number;
    children: Array<{
      component: {
        render(width: number): string[];
        handleMouse?: (event: FakeMouseEvent) => FakeMouseEvent;
      };
      height: number;
    }>;
  };

  addChild(component: (typeof this.children)[number]): void {
    this.children.push(component);
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const children = this.children.map((component) => {
      const rendered = component.render(width);
      lines.push(...rendered);
      return { component, height: rendered.length };
    });
    this.mouseLayout = { width, children };
    return lines;
  }

  handleMouse(event: FakeMouseEvent): FakeMouseEvent | undefined {
    const eventWidth = event.width ?? 0;
    const eventY = event.y ?? -1;
    const layout = this.mouseLayout;
    const children =
      layout?.width === eventWidth
        ? layout.children
        : this.children.map((component) => ({
            component,
            height: component.render(eventWidth).length,
          }));
    let childY = 0;
    for (const { component, height } of children) {
      if (eventY >= childY && eventY < childY + height)
        return component.handleMouse?.({ ...event, y: eventY - childY });
      childY += height;
    }
    return undefined;
  }
}

class FakeAssistantRow extends FakeContainer {
  readonly lines: string[];

  constructor(...lines: string[]) {
    super();
    this.lines = lines;
  }

  override render(_width: number): string[] {
    return [...this.lines];
  }

  override handleMouse(event: FakeMouseEvent): FakeMouseEvent {
    return event;
  }
}

class FakeUserRow extends FakeContainer {
  readonly lines: string[];

  constructor(...lines: string[]) {
    super();
    this.lines = lines;
  }

  override render(_width: number): string[] {
    return [...this.lines];
  }

  override handleMouse(event: FakeMouseEvent): FakeMouseEvent {
    return event;
  }
}

class FakeMessageRow {
  message: { customType: string };

  constructor(customType: string) {
    this.message = { customType };
  }

  render(width: number): string[] {
    return [`message:${this.message.customType}:${width}`];
  }

  handleMouse(event: FakeMouseEvent): FakeMouseEvent {
    return event;
  }
}

type FakeTheme = {
  fg(color: string, text: string): string;
};

function fakeTheme(): FakeTheme {
  return {
    fg: (color, text) => `\u001b[38;5;${color === "accent" ? 183 : 146}m${text}\u001b[39m`,
  };
}

function fakeUi() {
  const statuses: Array<[string, string | undefined]> = [];
  type WorkingIndicator = { readonly frames?: readonly string[]; readonly intervalMs?: number };
  type CalmWidget = { render(width: number): string[] };
  type Widget = (tui: { requestRender(): void }, theme: FakeTheme) => CalmWidget;
  const indicators: Array<WorkingIndicator | undefined> = [];
  const workingVisibility: boolean[] = [];
  const widgets: Array<[string, Widget | undefined]> = [];
  const notifications: string[] = [];
  const ui = {
    statuses,
    indicators,
    workingVisibility,
    widgets,
    notifications,
    theme: fakeTheme(),
    setStatus(key: string, text: string | undefined) {
      statuses.push([key, text]);
    },
    setWorkingIndicator(options?: WorkingIndicator) {
      indicators.push(options);
    },
    setWorkingVisible(visible: boolean) {
      workingVisibility.push(visible);
    },
    setWidget(key: string, content: Widget | undefined) {
      widgets.push([key, content]);
    },
    notify(message: string) {
      notifications.push(message);
    },
  };
  return ui;
}

function fakePi() {
  type FakeEvent = Record<string, never>;
  type FakeContext = ExtensionContext;
  type FakeHandlerResult = void | Promise<void>;
  const events = new Map<string, (event: FakeEvent, context: FakeContext) => FakeHandlerResult>();
  const commands = new Map<string, (args: string, context: FakeContext) => FakeHandlerResult>();
  const session = SessionManager.inMemory();
  return {
    events,
    commands,
    session,
    appendEntry(customType: string, data: { sessionId: string; on: boolean }) {
      session.appendCustomEntry(customType, data);
    },
    on(name: string, handler: (event: FakeEvent, context: FakeContext) => FakeHandlerResult) {
      events.set(name, handler);
    },
    registerCommand(
      name: string,
      definition: { handler: (args: string, context: FakeContext) => FakeHandlerResult },
    ) {
      commands.set(name, definition.handler);
    },
  };
}

function moduleForFakeRows() {
  return {
    ToolExecutionComponent: FakeToolRow,
    CustomMessageComponent: FakeMessageRow,
    AssistantMessageComponent: FakeAssistantRow,
    UserMessageComponent: FakeUserRow,
  };
}

function stripAnsiLikeTheme(value: string): string {
  return stripVTControlCharacters(value);
}

void test("calm policy defaults cover builtins, search tools, and Workgraph tools", () => {
  assert.equal(isCoordinatorScope({}), true);
  assert.equal(isCoordinatorScope({ PI_WORKGRAPH_MODE: "" }), true);
  assert.equal(isCoordinatorScope({ PI_WORKGRAPH_MODE: "implementation" }), false);
  const hidden = parseCalmHiddenTools(undefined);
  assert.deepEqual(hidden, [...DEFAULT_CALM_HIDDEN_TOOLS]);
  assert.ok(hidden.includes("bash"));
  assert.ok(hidden.includes("web_search"));
  assert.ok(hidden.includes("workgraph_report"));
  assert.ok(hidden.includes("workgraph_notepad"));
  assert.deepEqual(parseCalmHiddenTools(" read,read, custom "), ["read", "custom"]);
  assert.ok(!parseCalmHiddenTools(" read,read, custom ").includes("workgraph_notepad"));
  assert.deepEqual(parseCalmHiddenTools(" , "), []);
});

void test("presentation adapter hides and restores existing tool and operational-message rows", () => {
  const tool = new FakeToolRow("read");
  const message = new FakeMessageRow("pi-workgraph-attention");
  const state = {
    on: true,
    hiddenTools: new Set(["read"]),
    hiddenMessageTypes: new Set(["pi-workgraph-attention"]),
  };
  const diagnostics: string[] = [];
  const detach = attachCalmPresentation(moduleForFakeRows(), state, (message) =>
    diagnostics.push(message),
  );
  try {
    assert.deepEqual(tool.render(80), []);
    assert.deepEqual(message.render(80), []);
    assert.equal(tool.handleMouse({ kind: "click" }), undefined);
    state.on = false;
    assert.deepEqual(tool.render(80), ["tool:read:80"]);
    assert.deepEqual(message.render(80), ["message:pi-workgraph-attention:80"]);
    const click = {};
    assert.equal(tool.handleMouse(click), click);
    assert.deepEqual(diagnostics, []);
  } finally {
    detach();
  }
  assert.deepEqual(tool.render(80), ["tool:read:80"]);
  assert.deepEqual(message.render(80), ["message:pi-workgraph-attention:80"]);
});

void test("Calm marks successive assistant blocks on their existing first row", () => {
  const state = {
    on: true,
    hiddenTools: new Set(["read"]),
    hiddenMessageTypes: new Set(["pi-workgraph-attention"]),
  };
  const width = 32;
  const fullWidthText = "full-width assistant response".padEnd(width, "!");
  const chat = new FakeContainer();
  const first = new FakeAssistantRow("", "  thinking", "  answer");
  const hiddenToolA = new FakeToolRow("read");
  const hiddenToolB = new FakeToolRow("read");
  const hiddenMessage = new FakeMessageRow("pi-workgraph-attention");
  const toolOnlyAssistant = new FakeAssistantRow();
  const second = new FakeAssistantRow("", "\u001b]133;B\u0007 follow-up", "  still attached");
  const user = new FakeUserRow(" user message");
  const afterUser = new FakeAssistantRow("", "  after user");
  const afterHiddenOperation = new FakeAssistantRow("", "  after hidden operation");
  const fullWidthAssistant = new FakeAssistantRow(fullWidthText);
  const originalChildren = chat.children;
  chat.addChild(first);
  chat.addChild(hiddenToolA);
  chat.addChild(hiddenToolB);
  chat.addChild(hiddenMessage);
  chat.addChild(toolOnlyAssistant);
  chat.addChild(second);
  chat.addChild(user);
  chat.addChild(afterUser);
  chat.addChild(hiddenToolA);
  chat.addChild(afterHiddenOperation);
  chat.addChild(fullWidthAssistant);
  const diagnostics: string[] = [];
  const styledMarkers: string[] = [];
  const detach = attachCalmPresentation(
    moduleForFakeRows(),
    state,
    (message) => diagnostics.push(message),
    (text) => {
      styledMarkers.push(text);
      return `\u001b[2m${text}\u001b[22m`;
    },
  );
  try {
    const calmLines = chat.render(width);
    assert.deepEqual(calmLines.map(stripAnsiLikeTheme), [
      "",
      "  thinking",
      "  answer",
      "",
      "·follow-up",
      "  still attached",
      " user message",
      "",
      "  after user",
      "",
      "· after hidden operation",
      fullWidthText,
    ]);
    assert.equal(calmLines.length, 12);
    assert.equal(calmLines[1], "  thinking");
    assert.equal(calmLines[11], fullWidthText);
    assert.equal(visibleWidth(calmLines[4] ?? ""), visibleWidth(" follow-up"));
    assert.equal(calmLines[4], "\u001b]133;B\u0007\u001b[2m·\u001b[22mfollow-up");
    assert.deepEqual(styledMarkers, ["·", "·"]);
    assert.equal(chat.children.length, 11);
    assert.equal(chat.children, originalChildren);
    assert.deepEqual(chat.render(width).map(stripAnsiLikeTheme), calmLines.map(stripAnsiLikeTheme));
    assert.deepEqual(styledMarkers, ["·", "·", "·", "·"]);

    // The marker consumes the existing one-column output padding, so child and mouse rows do not
    // move. The blank prefix in the second assistant remains attached to its thinking/content.
    assert.deepEqual(chat.handleMouse({ y: 3, width }), { y: 0, width });
    assert.deepEqual(chat.handleMouse({ y: 4, width }), { y: 1, width });
    assert.deepEqual(
      chat.mouseLayout?.children.map(({ height }) => height),
      [3, 0, 0, 0, 0, 3, 1, 2, 0, 2, 1],
    );

    const visibleToolsChat = new FakeContainer();
    visibleToolsChat.addChild(first);
    visibleToolsChat.addChild(new FakeToolRow("write"));
    visibleToolsChat.addChild(new FakeToolRow("write"));
    visibleToolsChat.addChild(second);
    assert.deepEqual(visibleToolsChat.render(width).map(stripAnsiLikeTheme), [
      "",
      "  thinking",
      "  answer",
      "tool:write:32",
      "tool:write:32",
      "",
      "·follow-up",
      "  still attached",
    ]);
    assert.equal(styledMarkers.length, 5);

    const thinkingOnlyChat = new FakeContainer();
    thinkingOnlyChat.addChild(new FakeAssistantRow("", "  thinking only"));
    thinkingOnlyChat.addChild(new FakeToolRow("read"));
    thinkingOnlyChat.addChild(new FakeAssistantRow("", "  after thinking"));
    assert.deepEqual(thinkingOnlyChat.render(width).map(stripAnsiLikeTheme), [
      "",
      "  thinking only",
      "",
      "· after thinking",
    ]);
    assert.equal(styledMarkers.length, 6);

    const emptyEdgesChat = new FakeContainer();
    emptyEdgesChat.addChild(new FakeAssistantRow());
    emptyEdgesChat.addChild(new FakeAssistantRow("only visible block"));
    emptyEdgesChat.addChild(new FakeAssistantRow());
    assert.deepEqual(emptyEdgesChat.render(width), ["only visible block"]);
    assert.equal(styledMarkers.length, 6);

    state.on = false;
    assert.deepEqual(chat.render(width).map(stripAnsiLikeTheme), [
      "",
      "  thinking",
      "  answer",
      "tool:read:32",
      "tool:read:32",
      "message:pi-workgraph-attention:32",
      "",
      " follow-up",
      "  still attached",
      " user message",
      "",
      "  after user",
      "tool:read:32",
      "",
      "  after hidden operation",
      fullWidthText,
    ]);
    assert.deepEqual(styledMarkers, ["·", "·", "·", "·", "·", "·"]);
    state.on = true;
  } finally {
    detach();
  }
  assert.deepEqual(chat.render(32), [
    "",
    "  thinking",
    "  answer",
    "tool:read:32",
    "tool:read:32",
    "message:pi-workgraph-attention:32",
    "",
    "\u001b]133;B\u0007 follow-up",
    "  still attached",
    " user message",
    "",
    "  after user",
    "tool:read:32",
    "",
    "  after hidden operation",
    fullWidthText,
  ]);
  assert.deepEqual(diagnostics, []);
});

void test("adapter diagnostics fall back to visible rendering when row metadata changes", () => {
  const tool = new FakeToolRow("read");
  Object.defineProperty(tool, "toolName", { get: () => 42 });
  const diagnostics: string[] = [];
  const state = {
    on: true,
    hiddenTools: new Set(["read"]),
    hiddenMessageTypes: new Set<string>(),
  };
  const detach = attachCalmPresentation(moduleForFakeRows(), state, (message) =>
    diagnostics.push(message),
  );
  try {
    assert.deepEqual(tool.render(80), ["tool:42:80"]);
    assert.equal(diagnostics.length, 1);
  } finally {
    detach();
  }
});

void test("activity indicator remains active for coordinator or workers and settles cleanly", () => {
  assert.equal(isCalmActivityActive({ coordinatorActive: false, activeWorkers: 0 }), false);
  assert.equal(isCalmActivityActive({ coordinatorActive: true, activeWorkers: 0 }), true);
  assert.equal(isCalmActivityActive({ coordinatorActive: false, activeWorkers: 2 }), true);
  assert.equal(
    activeWorkerCount({
      attempts: [{ state: "queued" }, { state: "starting" }, { state: "running" }],
    }),
    2,
  );
});

void test("minimal activity pulses without layout changes and keeps truthful width-safe labels", () => {
  const theme = fakeTheme();
  const coordinator = { coordinatorActive: true, activeWorkers: 0 };
  const workers = { coordinatorActive: false, activeWorkers: 2 };
  const combined = { coordinatorActive: true, activeWorkers: 2 };
  const wideA = calmActivityLines(coordinator, 1, 80, theme);
  const wideB = calmActivityLines(coordinator, 2, 80, theme);
  assert.equal(wideA.length, 1);
  assert.notDeepEqual(wideA, wideB);
  assert.equal(stripAnsiLikeTheme(wideA[0] ?? ""), "• Workgraph · coordinating");
  assert.equal(stripAnsiLikeTheme(wideA[0] ?? ""), stripAnsiLikeTheme(wideB[0] ?? ""));
  assert.match(
    stripAnsiLikeTheme(calmActivityLines(workers, 0, 80, theme)[0] ?? ""),
    /2 workers active/,
  );
  assert.match(
    stripAnsiLikeTheme(calmActivityLines(combined, 0, 80, theme)[0] ?? ""),
    /Workgraph · coordinating · 2 workers active/,
  );
  assert.doesNotMatch(
    stripAnsiLikeTheme(calmActivityLines(workers, 0, 80, theme)[0] ?? ""),
    /coordinating/,
  );

  for (const width of [160, 80, 40, 36, 35, 24, 12, 8, 3, 1]) {
    const lines = calmActivityLines(combined, 4, width, theme);
    assert.equal(lines.length, 1);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
  assert.match(
    stripAnsiLikeTheme(
      calmActivityLines({ ...coordinator, waitingForInput: true }, 0, 80, theme)[0] ?? "",
    ),
    /awaiting input/,
  );
  assert.deepEqual(
    calmActivityLines({ coordinatorActive: false, activeWorkers: 0 }, 1, 80, theme),
    [],
  );
});

void test("coordinator calm command defaults to hiding workgraph notes and restores them when off", async () => {
  const pi = fakePi();
  const ui = fakeUi();
  const calm = installCalmMode(pi as unknown as ExtensionAPI, {
    loadPresentation: async () => moduleForFakeRows(),
    intervalMs: 10_000,
    preferences: { load: async () => false, save: async () => {} },
  });
  // SAFETY: The fixture supplies only the ExtensionContext fields consumed by Calm.
  const context = {
    mode: "tui",
    ui,
    isIdle: () => true,
    sessionManager: pi.session,
  } as unknown as ExtensionContext;
  await pi.events.get("session_start")?.({}, context);
  const tool = new FakeToolRow("workgraph_notepad");
  assert.deepEqual(tool.render(80), ["tool:workgraph_notepad:80"]);
  calm.setActiveWorkers(1);
  await pi.commands.get("calm")?.("", context);
  assert.deepEqual(tool.render(80), []);
  assert.match(ui.statuses.at(-1)?.[1] ?? "", /calm/);
  assert.equal(ui.widgets.at(-1)?.[0], "calm");
  const widgetFactory = ui.widgets.at(-1)?.[1];
  assert.ok(widgetFactory);
  const widget = widgetFactory({ requestRender() {} }, ui.theme);
  assert.equal(widget.render(80).length, 1);
  assert.match(widget.render(80)[0] ?? "", /Workgraph/);
  assert.ok(ui.workingVisibility.includes(false));
  calm.setActiveWorkers(0);
  assert.deepEqual(ui.widgets.at(-1), ["calm", undefined]);
  calm.setActiveWorkers(1);
  await pi.commands.get("calm")?.("", context);
  assert.deepEqual(tool.render(80), ["tool:workgraph_notepad:80"]);
  assert.equal(widget.render(80).length, 1);
  assert.equal(ui.statuses.at(-1)?.[1], undefined);
  assert.equal(ui.workingVisibility.at(-1), false);
  await pi.events.get("session_shutdown")?.({}, context);
  assert.deepEqual(ui.widgets.at(-1), ["calm", undefined]);
  assert.equal(ui.workingVisibility.at(-1), true);
  assert.deepEqual(tool.render(80), ["tool:workgraph_notepad:80"]);
});

void test("missing internal seam leaves rows visible and reports a diagnostic", async () => {
  const pi = fakePi();
  const ui = fakeUi();
  const calm = installCalmMode(pi as unknown as ExtensionAPI, {
    loadPresentation: async () => {
      throw new Error("unsupported Pi seam");
    },
    preferences: { load: async () => false, save: async () => {} },
  });
  // SAFETY: The fixture supplies only the ExtensionContext fields consumed by Calm.
  const context = {
    mode: "tui",
    ui,
    isIdle: () => true,
    sessionManager: pi.session,
  } as unknown as ExtensionContext;
  await pi.events.get("session_start")?.({}, context);
  await Promise.resolve();
  await pi.commands.get("calm")?.("", context);
  assert.ok(ui.notifications.some((message) => message.includes("Rows remain visible")));
  calm.setActiveWorkers(0);
});

void test("saved default affects new sessions, while local choice survives reload and resume", async () => {
  const pi = fakePi();
  const ui = fakeUi();
  let defaultOn = false;
  let saves = 0;
  installCalmMode(pi as unknown as ExtensionAPI, {
    loadPresentation: async () => moduleForFakeRows(),
    preferences: {
      load: async () => defaultOn,
      save: async (on) => {
        defaultOn = on;
        saves += 1;
      },
    },
    intervalMs: 10_000,
  });
  const context = {
    mode: "tui",
    ui,
    isIdle: () => true,
    sessionManager: pi.session,
  } as unknown as ExtensionContext;
  const row = new FakeToolRow("read");
  const start = () => pi.events.get("session_start")?.({}, context);
  const shutdown = () => pi.events.get("session_shutdown")?.({}, context);
  const command = (args: string) => pi.commands.get("calm")?.(args, context);
  try {
    await start();
    await command("default on");
    assert.equal(defaultOn, true);
    assert.notDeepEqual(row.render(80), []); // Existing session unchanged.
    await shutdown();
    await start();
    assert.notDeepEqual(row.render(80), []); // Frozen startup choice survives reload.
    await command("");
    assert.deepEqual(row.render(80), []);
    await shutdown();
    await start();
    assert.deepEqual(row.render(80), []); // Local override restored from actual session entries.
    await command("");
    assert.equal(saves, 1); // Debug toggle never writes global default.
    await command("default maybe");
    assert.equal(saves, 1);
    await shutdown();
    pi.session.newSession();
    await start();
    assert.deepEqual(row.render(80), []); // New session follows saved default.
    await command("default off");
    assert.deepEqual(row.render(80), []); // Changing default never flips current state.
  } finally {
    await shutdown();
  }
});

void test("activity uses compact mode outside Calm and freezes for a genuine UI prompt", async () => {
  const pi = fakePi();
  const ui = fakeUi();
  const calm = installCalmMode(pi as unknown as ExtensionAPI, {
    loadPresentation: async () => moduleForFakeRows(),
    preferences: { load: async () => false, save: async () => {} },
    intervalMs: 10_000,
  });
  const context = {
    mode: "tui",
    ui,
    isIdle: () => true,
    sessionManager: pi.session,
  } as unknown as ExtensionContext;
  try {
    await pi.events.get("session_start")?.({}, context);
    await pi.events.get("agent_start")?.({}, context);
    const factory = ui.widgets.at(-1)?.[1];
    assert.ok(factory);
    const widget = factory({ requestRender() {} }, ui.theme);
    assert.equal(widget.render(80).length, 1);
    assert.equal(ui.workingVisibility.at(-1), false);
    await pi.commands.get("calm")?.("", context);
    assert.equal(widget.render(80).length, 1);
    await pi.events.get("ui_prompt_start")?.({}, context);
    assert.match(stripAnsiLikeTheme(widget.render(80)[0] ?? ""), /awaiting input/);
    await pi.events.get("ui_prompt_end")?.({}, context);
    calm.setActiveWorkers(2);
    await pi.events.get("agent_settled")?.({}, context);
    assert.match(stripAnsiLikeTheme(widget.render(80)[0] ?? ""), /2 workers active/);
    assert.doesNotMatch(stripAnsiLikeTheme(widget.render(80)[0] ?? ""), /coordinating/);
    calm.setActiveWorkers(0);
    assert.deepEqual(ui.widgets.at(-1), ["calm", undefined]);
  } finally {
    await pi.events.get("session_shutdown")?.({}, context);
  }
});
