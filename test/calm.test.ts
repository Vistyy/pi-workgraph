import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// SAFETY: These fakes terminate at the test boundary; production Pi values are decoded by the adapter.
// oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion
import {
  activeWorkerCount,
  attachCalmPresentation,
  calmActivityLines,
  calmStatus,
  calmWorkingIndicatorFrames,
  DEFAULT_CALM_HIDDEN_TOOLS,
  installCalmMode,
  isCalmActivityActive,
  isCoordinatorScope,
  parseCalmHiddenTools,
} from "../src/calm.js";

type FakeMouseEvent = {
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
    fg: (color, text) => `<${color}>${text}</${color}>`,
  };
}

function fakeUi() {
  const statuses: Array<[string, string | undefined]> = [];
  type WorkingIndicator = { readonly frames?: readonly string[]; readonly intervalMs?: number };
  type CalmWidget = { render(width: number): string[] };
  type Widget = (tui: { requestRender(): void }, theme: FakeTheme) => CalmWidget;
  const indicators: WorkingIndicator[] = [];
  const widgets: Array<[string, Widget | undefined]> = [];
  const notifications: string[] = [];
  const ui = {
    statuses,
    indicators,
    widgets,
    notifications,
    theme: fakeTheme(),
    setStatus(key: string, text: string | undefined) {
      statuses.push([key, text]);
    },
    setWorkingIndicator(options?: WorkingIndicator) {
      if (options !== undefined) indicators.push(options);
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
  return {
    events,
    commands,
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
  };
}

function stripAnsiLikeTheme(value: string): string {
  return value.replace(/<\/?[A-Za-z]+>/g, "");
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
  assert.deepEqual(parseCalmHiddenTools(" read,read, custom "), ["read", "custom"]);
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
  assert.match(calmStatus({ coordinatorActive: false, activeWorkers: 2 }, 2), /active workers/);
  assert.equal(
    activeWorkerCount({
      attempts: [{ state: "queued" }, { state: "starting" }, { state: "running" }],
    }),
    2,
  );
  assert.equal(calmStatus({ coordinatorActive: false, activeWorkers: 0 }, 3), "· calm");
});

void test("constellation frames are themed, compact, and width-safe", () => {
  const theme = fakeTheme();
  const active = { coordinatorActive: true, activeWorkers: 2 };
  const wideA = calmActivityLines(active, 2, 80, theme);
  const wideB = calmActivityLines(active, 8, 80, theme);
  assert.equal(wideA.length, 2);
  assert.notDeepEqual(wideA, wideB);
  assert.match(wideA[0] ?? "", /Workgraph/);
  assert.match(wideA[0] ?? "", /<accent>◆<\/?accent>/);
  assert.match(wideA[1] ?? "", /coordinator \+ 2 workers/);

  for (const width of [40, 24, 12, 3, 1]) {
    const lines = calmActivityLines(active, 4, width, theme);
    assert.ok(lines.every((line) => stripAnsiLikeTheme(line).length <= width));
  }
  assert.deepEqual(
    calmActivityLines({ coordinatorActive: false, activeWorkers: 0 }, 1, 80, theme),
    [],
  );
  assert.equal(calmWorkingIndicatorFrames(theme).length, 4);
  assert.notEqual(calmWorkingIndicatorFrames(theme)[0], calmWorkingIndicatorFrames(theme)[1]);
});

void test("coordinator calm command is off by default and uses the guarded adapter", async () => {
  const pi = fakePi();
  const ui = fakeUi();
  const calm = installCalmMode(pi as unknown as ExtensionAPI, {
    hiddenTools: ["read"],
    loadPresentation: async () => moduleForFakeRows(),
    intervalMs: 10_000,
  });
  // SAFETY: The fixture supplies only the ExtensionContext fields consumed by Calm.
  const context = {
    mode: "tui",
    ui,
  } as unknown as ExtensionContext;
  await pi.events.get("session_start")?.({}, context);
  const tool = new FakeToolRow("read");
  assert.deepEqual(tool.render(80), ["tool:read:80"]);
  calm.setActiveWorkers(1);
  await pi.commands.get("calm")?.("", context);
  assert.deepEqual(tool.render(80), []);
  assert.match(ui.statuses.at(-1)?.[1] ?? "", /calm/);
  assert.equal(ui.widgets.at(-1)?.[0], "calm");
  const widgetFactory = ui.widgets.at(-1)?.[1];
  assert.ok(widgetFactory);
  const widget = widgetFactory({ requestRender() {} }, ui.theme);
  assert.equal(widget.render(80).length, 2);
  assert.match(widget.render(80)[0] ?? "", /Workgraph/);
  calm.setActiveWorkers(0);
  assert.deepEqual(ui.widgets.at(-1), ["calm", undefined]);
  calm.setActiveWorkers(1);
  await pi.commands.get("calm")?.("", context);
  assert.deepEqual(tool.render(80), ["tool:read:80"]);
  assert.deepEqual(ui.widgets.at(-1), ["calm", undefined]);
  assert.equal(ui.statuses.at(-1)?.[1], undefined);
  await pi.events.get("session_shutdown")?.({}, context);
  assert.deepEqual(tool.render(80), ["tool:read:80"]);
});

void test("missing internal seam leaves rows visible and reports a diagnostic", async () => {
  const pi = fakePi();
  const ui = fakeUi();
  const calm = installCalmMode(pi as unknown as ExtensionAPI, {
    loadPresentation: async () => {
      throw new Error("unsupported Pi seam");
    },
  });
  // SAFETY: The fixture supplies only the ExtensionContext fields consumed by Calm.
  const context = { mode: "tui", ui } as unknown as ExtensionContext;
  await pi.events.get("session_start")?.({}, context);
  await Promise.resolve();
  await pi.commands.get("calm")?.("", context);
  assert.ok(ui.notifications.some((message) => message.includes("Rows remain visible")));
  calm.setActiveWorkers(0);
});
