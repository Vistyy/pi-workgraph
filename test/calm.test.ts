import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  type ExtensionAPI,
  type ExtensionContext,
  initTheme,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

// SAFETY: These fakes terminate at the test boundary; production Pi values are decoded by the adapter.
// oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion
import {
  activeWorkerCount,
  attachCalmPresentation,
  calmActivityLines,
  calmHiddenTools,
  createCalmActivityTracker,
  DEFAULT_CALM_HIDDEN_TOOLS,
  installCalmMode,
  isCalmActivityActive,
  isCoordinatorScope,
} from "../src/calm.js";
import { attachCalmThinking } from "../src/calm-thinking.js";

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

  render(this: FakeToolRow, width: number): string[] {
    return [`tool:${this.toolName}:${width}`];
  }

  handleMouse(this: void, event: FakeMouseEvent): FakeMouseEvent {
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

type FakeAssistantPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string }
  | { readonly type: "toolCall"; readonly name: string };
type FakeAssistantMessage = {
  readonly role: "assistant";
  readonly content: readonly FakeAssistantPart[];
  readonly stopReason?: string;
};

class FakeAssistantRow extends FakeContainer {
  lines: string[];
  lastMessage?: FakeAssistantMessage;
  isStreaming = false;

  constructor(...lines: string[]) {
    super();
    this.lines = lines;
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Model Pi's runtime message seam in the fixture.
  updateContent(message: unknown, isStreaming = false): void {
    // SAFETY: The fixture only calls this Pi-compatible seam with assistant messages.
    const assistantMessage = message as FakeAssistantMessage;
    this.lastMessage = assistantMessage;
    this.isStreaming = isStreaming;
    this.lines = assistantMessage.content.map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return `thinking:${part.thinking}`;
      return `tool:${part.name}`;
    });
  }

  invalidate(): void {
    if (this.lastMessage !== undefined) this.updateContent(this.lastMessage, this.isStreaming);
  }

  setHideThinkingBlock(): void {
    if (this.lastMessage !== undefined) this.updateContent(this.lastMessage);
  }

  setHiddenThinkingLabel(): void {
    if (this.lastMessage !== undefined) this.updateContent(this.lastMessage);
  }

  setOutputPad(): void {
    if (this.lastMessage !== undefined) this.updateContent(this.lastMessage);
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

  render(this: FakeMessageRow, width: number): string[] {
    return [`message:${this.message.customType}:${width}`];
  }

  handleMouse(this: void, event: FakeMouseEvent): FakeMouseEvent {
    return event;
  }
}

type FakeTheme = {
  fg(color: string, text: string): string;
  italic(text: string): string;
};

function fakeTheme(): FakeTheme {
  return {
    fg: (color, text) => `\u001b[38;5;${color === "accent" ? 183 : 146}m${text}\u001b[39m`,
    italic: (text) => `\u001b[3m${text}\u001b[23m`,
  };
}

function fakeUi() {
  const statuses = new Map<string, string | undefined>();
  type WorkingIndicator = { readonly frames?: readonly string[]; readonly intervalMs?: number };
  type CalmWidget = { render(width: number): string[] };
  type Widget = (tui: { requestRender(): void }, theme: FakeTheme) => CalmWidget;
  const widgets = new Map<string, Widget | undefined>();
  const notifications: string[] = [];
  const ui = {
    statuses,
    indicator: undefined as WorkingIndicator | undefined,
    workingVisible: true,
    widgets,
    notifications,
    theme: fakeTheme(),
    setStatus(key: string, text: string | undefined) {
      statuses.set(key, text);
    },
    setWorkingIndicator(options?: WorkingIndicator) {
      ui.indicator = options;
    },
    setWorkingVisible(visible: boolean) {
      ui.workingVisible = visible;
    },
    setWidget(key: string, content: Widget | undefined) {
      widgets.set(key, content);
    },
    notify(message: string) {
      notifications.push(message);
    },
  };
  return ui;
}

function fakePi() {
  // SAFETY: The fake dispatch table intentionally accepts each typed Pi event fixture.
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
  type FakeEvent = { readonly [key: string]: string | object | boolean | undefined };
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

void test("calm defaults own Pi and Workgraph tools while user additions are merged", () => {
  assert.equal(isCoordinatorScope({}), true);
  assert.equal(isCoordinatorScope({ PI_WORKGRAPH_MODE: "" }), true);
  assert.equal(isCoordinatorScope({ PI_WORKGRAPH_MODE: "implementation" }), false);
  const hidden = new Set<string>(calmHiddenTools());
  assert.deepEqual([...hidden], [...DEFAULT_CALM_HIDDEN_TOOLS]);
  assert.ok(hidden.has("bash"));
  assert.ok(hidden.has("workgraph_consult"));
  assert.ok(hidden.has("workgraph_report"));
  assert.ok(hidden.has("workgraph_notepad"));
  assert.ok(!hidden.has("web_search"));
  assert.ok(!hidden.has("rename_resource"));
  assert.ok(!hidden.has("herdr_rename"));
  assert.deepEqual(calmHiddenTools(["web_search", "rename_resource", "bash"]), [
    ...DEFAULT_CALM_HIDDEN_TOOLS,
    "web_search",
    "rename_resource",
  ]);
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

void test("Calm filters assistant thinking structurally and restores the original message on toggles", () => {
  const message: FakeAssistantMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "answer" },
      { type: "toolCall", name: "read" },
    ],
  };
  const row = new FakeAssistantRow();
  row.updateContent(message, true);
  const originalContent = [...message.content];
  const state = {
    on: true,
    hiddenTools: new Set<string>(),
    hiddenMessageTypes: new Set<string>(),
  };
  const diagnostics: string[] = [];
  let streamed: FakeAssistantMessage | undefined;
  const detach = attachCalmPresentation(moduleForFakeRows(), state, (diagnostic) =>
    diagnostics.push(diagnostic),
  );
  try {
    assert.deepEqual(row.render(80), ["answer", "tool:read"]);
    assert.deepEqual(message.content, originalContent);

    row.invalidate();
    row.setHideThinkingBlock();
    row.setHiddenThinkingLabel();
    row.setOutputPad();
    assert.deepEqual(row.render(80), ["answer", "tool:read"]);
    assert.deepEqual(row.lastMessage?.content, [
      { type: "text", text: "answer" },
      { type: "toolCall", name: "read" },
    ]);
    assert.deepEqual(message.content, originalContent);

    for (let toggle = 0; toggle < 3; toggle += 1) {
      state.on = false;
      assert.deepEqual(row.render(80), ["thinking:private reasoning", "answer", "tool:read"]);
      state.on = true;
      assert.deepEqual(row.render(80), ["answer", "tool:read"]);
      row.invalidate();
      row.setHideThinkingBlock();
    }

    streamed = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "updated reasoning" },
        { type: "text", text: "updated answer" },
      ],
    };
    row.updateContent(streamed, true);
    row.setHiddenThinkingLabel();
    row.setOutputPad();
    row.invalidate();
    assert.deepEqual(row.render(80), ["updated answer"]);
    state.on = false;
    assert.deepEqual(row.render(80), ["thinking:updated reasoning", "updated answer"]);
    assert.deepEqual(streamed.content, [
      { type: "thinking", thinking: "updated reasoning" },
      { type: "text", text: "updated answer" },
    ]);
    assert.deepEqual(diagnostics, []);
  } finally {
    detach();
  }
  assert.deepEqual(row.render(80), ["thinking:updated reasoning", "updated answer"]);
  assert.equal(row.lastMessage, streamed);
  assert.deepEqual(row.lastMessage?.content, streamed?.content);
});

void test("the installed Pi assistant component remains compatible with Calm thinking filtering", () => {
  initTheme("dark", false);
  const source: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "visible answer" },
      { type: "toolCall", id: "tool-1", name: "read", arguments: {} },
    ],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  };
  const originalContent = [...source.content];
  const state = { on: true };
  const diagnostics: string[] = [];
  const detach = attachCalmThinking(
    AssistantMessageComponent.prototype,
    () => state.on,
    (diagnostic) => diagnostics.push(diagnostic),
  );
  const row = new AssistantMessageComponent();
  const visible = (): string => row.render(80).map(stripVTControlCharacters).join("\\n");
  try {
    row.updateContent(source, true);
    assert.doesNotMatch(visible(), /private reasoning/);
    assert.match(visible(), /visible answer/);
    assert.deepEqual(source.content, originalContent);

    row.invalidate();
    row.setHideThinkingBlock(true);
    row.setHiddenThinkingLabel("hidden");
    row.setOutputPad(0);
    assert.doesNotMatch(visible(), /private reasoning|hidden/);
    assert.match(visible(), /visible answer/);
    assert.deepEqual(source.content, originalContent);

    for (let toggle = 0; toggle < 2; toggle += 1) {
      state.on = false;
      row.setHideThinkingBlock(false);
      assert.match(visible(), /private reasoning/);
      state.on = true;
      assert.doesNotMatch(visible(), /private reasoning/);
      row.invalidate();
      row.setHideThinkingBlock(false);
      row.setHiddenThinkingLabel("still hidden");
      row.setOutputPad(1);
      assert.doesNotMatch(visible(), /private reasoning|still hidden/);
    }

    const updated: AssistantMessage = {
      ...source,
      content: [
        { type: "thinking", thinking: "updated private reasoning" },
        { type: "text", text: "updated visible answer" },
      ],
    };
    row.updateContent(updated, false);
    row.invalidate();
    assert.doesNotMatch(visible(), /updated private reasoning/);
    assert.match(visible(), /updated visible answer/);
    assert.deepEqual(updated.content, [
      { type: "thinking", thinking: "updated private reasoning" },
      { type: "text", text: "updated visible answer" },
    ]);
  } finally {
    detach();
  }
  assert.match(visible(), /updated visible answer/);
  assert.match(visible(), /updated private reasoning/);
  assert.deepEqual(source.content, originalContent);
  assert.deepEqual(diagnostics, []);
});

void test("thinking-only assistant rows do not create separators", () => {
  const hiddenThinking = new FakeAssistantRow();
  hiddenThinking.updateContent({
    role: "assistant",
    content: [{ type: "thinking", thinking: "only reasoning" }],
  });
  const visibleA = new FakeAssistantRow("answer A");
  const visibleB = new FakeAssistantRow("answer B");
  const chat = new FakeContainer();
  chat.addChild(visibleA);
  chat.addChild(hiddenThinking);
  chat.addChild(new FakeToolRow("read"));
  chat.addChild(visibleB);
  const state = {
    on: true,
    hiddenTools: new Set(["read"]),
    hiddenMessageTypes: new Set<string>(),
  };
  const detach = attachCalmPresentation(moduleForFakeRows(), state, () => {});
  try {
    assert.deepEqual(chat.render(40), ["answer A", "---", "answer B"]);
    assert.equal(chat.handleMouse({ y: 1, width: 40 }), undefined);
    assert.deepEqual(chat.handleMouse({ y: 2, width: 40 }), { y: 0, width: 40 });
    state.on = false;
    assert.deepEqual(chat.render(40), [
      "answer A",
      "thinking:only reasoning",
      "tool:read:40",
      "answer B",
    ]);
  } finally {
    detach();
  }
});

void test("assistant seam failures restore earlier patches and diagnose changed cleanup seams", () => {
  const tool = new FakeToolRow("read");
  const message = new FakeMessageRow("pi-workgraph-attention");
  const state = {
    on: true,
    hiddenTools: new Set(["read"]),
    hiddenMessageTypes: new Set(["pi-workgraph-attention"]),
  };
  const diagnostics: string[] = [];
  class MissingAssistant extends FakeContainer {
    override render(width: number): string[] {
      return [`missing:${width}`];
    }
  }
  const broken = {
    ...moduleForFakeRows(),
    AssistantMessageComponent: MissingAssistant,
  } as unknown as Parameters<typeof attachCalmPresentation>[0];
  assert.throws(
    () => attachCalmPresentation(broken, state, (diagnostic) => diagnostics.push(diagnostic)),
    /assistant message presentation seam/,
  );
  assert.deepEqual(tool.render(80), ["tool:read:80"]);
  assert.deepEqual(message.render(80), ["message:pi-workgraph-attention:80"]);

  // oxlint-disable-next-line typescript/unbound-method -- Capture the native seam for cleanup verification.
  const nativeUpdate = FakeAssistantRow.prototype.updateContent;
  const detach = attachCalmPresentation(moduleForFakeRows(), state, (diagnostic) =>
    diagnostics.push(diagnostic),
  );
  // oxlint-disable-next-line typescript/unbound-method -- Call through the temporarily replaced seam.
  const adaptedUpdate = FakeAssistantRow.prototype.updateContent;
  FakeAssistantRow.prototype.updateContent = function (
    message: FakeAssistantMessage,
    isStreaming?: boolean,
  ): void {
    adaptedUpdate.call(this, message, isStreaming);
  };
  detach();
  assert.ok(diagnostics.some((diagnostic) => diagnostic.includes("update seam changed")));
  // oxlint-disable-next-line typescript/unbound-method -- Verify cleanup restores the native seam.
  assert.equal(FakeAssistantRow.prototype.updateContent, nativeUpdate);
});

void test("Calm separates visible assistant blocks with inert, width-safe rows", () => {
  const state = {
    on: true,
    hiddenTools: new Set(["read"]),
    hiddenMessageTypes: new Set(["pi-workgraph-attention"]),
  };
  const width = 32;
  const chat = new FakeContainer();
  chat.addChild(new FakeAssistantRow("first"));
  chat.addChild(new FakeToolRow("read"));
  chat.addChild(new FakeMessageRow("pi-workgraph-attention"));
  chat.addChild(new FakeAssistantRow("second"));
  const detach = attachCalmPresentation(moduleForFakeRows(), state, () => {});
  try {
    assert.deepEqual(chat.render(width), ["first", "---", "second"]);
    assert.equal(chat.handleMouse({ y: 1, width }), undefined);
    assert.deepEqual(chat.handleMouse({ y: 2, width }), { y: 0, width });

    const narrowChat = new FakeContainer();
    narrowChat.addChild(new FakeAssistantRow("a"));
    narrowChat.addChild(new FakeAssistantRow("b"));
    const narrowLines = narrowChat.render(2);
    assert.deepEqual(narrowLines, ["a", "--", "b"]);
    assert.ok(narrowLines.every((line) => visibleWidth(line) <= 2));
  } finally {
    detach();
  }
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

void test("activity tracker derives static phases, allowlisted hints, and ID-scoped concurrency", () => {
  let changes = 0;
  const tracker = createCalmActivityTracker(() => {
    changes += 1;
  });
  tracker.startAgent();
  tracker.messageUpdate("thinking_delta");
  assert.deepEqual(tracker.snapshot(), { phase: "thinking", activeTools: [] });
  tracker.messageUpdate("text_delta");
  assert.deepEqual(tracker.snapshot(), { phase: "responding", activeTools: [] });
  tracker.toolStart("a", "read", { path: "/private/calm.ts", command: "do not show" });
  assert.deepEqual(tracker.snapshot().activeTools, [
    { toolCallId: "a", toolName: "read", pathHint: "calm.ts" },
  ]);
  tracker.toolStart("b", "bash", { command: "secret --query never-render" });
  tracker.toolStart("a", "write", { path: "/tmp/output.txt", arbitrary: "hidden" });
  assert.deepEqual(tracker.snapshot().activeTools, [
    { toolCallId: "a", toolName: "write", pathHint: "output.txt" },
    { toolCallId: "b", toolName: "bash" },
  ]);
  tracker.toolEnd("b");
  assert.deepEqual(tracker.snapshot().activeTools, [
    { toolCallId: "a", toolName: "write", pathHint: "output.txt" },
  ]);
  tracker.toolEnd("a");
  assert.deepEqual(tracker.snapshot(), { phase: "thinking", activeTools: [] });
  tracker.clear();
  assert.deepEqual(tracker.snapshot(), { phase: undefined, activeTools: [] });
  assert.ok(changes >= 7);

  for (const args of [
    { path: "unsafe\u0001.ts" },
    { path: "unsafe\u0085.ts" },
    { path: "unsafe\u001b[31m.ts" },
    { path: "unsafe\u202e.ts" },
    { path: "unsafe name.ts" },
    { path: "unsafe-\u{1f4a5}.ts" },
    { path: 42 },
    { command: "secret", query: "private" },
    null,
    "not-an-object",
  ] as unknown[]) {
    tracker.toolStart("unsafe", "read", args);
    const unsafeActivity = (tracker.snapshot().activeTools ?? []).at(-1);
    assert.ok(unsafeActivity);
    assert.deepEqual(unsafeActivity, {
      toolCallId: "unsafe",
      toolName: "read",
    });
    const unsafeLines = calmActivityLines(
      {
        calmOn: true,
        coordinatorActive: true,
        activeWorkers: 0,
        activeTools: tracker.snapshot().activeTools,
      },
      0,
      80,
      fakeTheme(),
    );
    assert.equal(stripAnsiLikeTheme(unsafeLines[0] ?? ""), "read");
    tracker.toolEnd("unsafe");
  }
  const getterArgs = {};
  Object.defineProperty(getterArgs, "path", {
    get: () => {
      throw new Error("path getter must not run");
    },
  });
  tracker.toolStart("getter", "read", getterArgs);
  const getterActivity = (tracker.snapshot().activeTools ?? []).at(-1);
  assert.ok(getterActivity);
  assert.deepEqual(getterActivity, {
    toolCallId: "getter",
    toolName: "read",
  });
  const getterLines = calmActivityLines(
    {
      calmOn: true,
      coordinatorActive: true,
      activeWorkers: 0,
      activeTools: tracker.snapshot().activeTools,
    },
    0,
    80,
    fakeTheme(),
  );
  assert.equal(stripAnsiLikeTheme(getterLines[0] ?? ""), "read");
  tracker.toolEnd("getter");

  const theme = fakeTheme();
  const thinking = calmActivityLines(
    { calmOn: true, coordinatorActive: true, activeWorkers: 0, phase: "thinking" },
    0,
    80,
    theme,
  );
  assert.deepEqual(thinking.map(stripAnsiLikeTheme), ["thinking", "• Workgraph · coordinating"]);
  const thinkingAtNextFrame = calmActivityLines(
    { calmOn: true, coordinatorActive: true, activeWorkers: 0, phase: "thinking" },
    1,
    80,
    theme,
  );
  assert.equal(thinkingAtNextFrame[0], thinking[0]);
  assert.deepEqual(thinkingAtNextFrame.map(stripAnsiLikeTheme), thinking.map(stripAnsiLikeTheme));
  const responding = calmActivityLines(
    { calmOn: true, coordinatorActive: true, activeWorkers: 0, phase: "responding" },
    0,
    80,
    theme,
  );
  assert.equal(stripAnsiLikeTheme(responding[0] ?? ""), "responding");
  assert.ok(!stripAnsiLikeTheme(responding[0] ?? "").includes("•"));
  assert.ok(visibleWidth(responding[0] ?? "") <= 80 && visibleWidth(responding[1] ?? "") <= 80);
  const unsafe = calmActivityLines(
    {
      calmOn: true,
      coordinatorActive: true,
      activeWorkers: 0,
      activeTools: [
        { toolCallId: "a", toolName: "bash" },
        { toolCallId: "b", toolName: "web_search" },
      ],
    },
    0,
    80,
    theme,
  );
  assert.equal(stripAnsiLikeTheme(unsafe[0] ?? ""), "bash · web_search");
  assert.doesNotMatch(stripAnsiLikeTheme(unsafe[0] ?? ""), /secret|query|never-render/);
  const parallel = calmActivityLines(
    {
      calmOn: true,
      coordinatorActive: true,
      activeWorkers: 0,
      activeTools: [
        { toolCallId: "1", toolName: "read" },
        { toolCallId: "2", toolName: "edit" },
        { toolCallId: "3", toolName: "write" },
        { toolCallId: "4", toolName: "bash" },
        { toolCallId: "5", toolName: "web_search" },
      ],
    },
    0,
    12,
    theme,
  );
  assert.equal(parallel.length, 2);
  assert.ok(parallel.every((line) => visibleWidth(line) <= 12));
  assert.doesNotMatch(stripAnsiLikeTheme(parallel[0] ?? ""), /never/);
  assert.equal(
    calmActivityLines(
      {
        calmOn: false,
        coordinatorActive: true,
        activeWorkers: 0,
        phase: "thinking",
      },
      0,
      80,
      theme,
    ).length,
    1,
  );
});

void test("coordinator calm command defaults to hiding workgraph notes and restores them when off", async () => {
  const pi = fakePi();
  const ui = fakeUi();
  const calm = installCalmMode(pi as unknown as ExtensionAPI, {
    loadAdditionalHiddenTools: async () => ["web_search"],
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
  const addedTool = new FakeToolRow("web_search");
  assert.deepEqual(tool.render(80), ["tool:workgraph_notepad:80"]);
  assert.deepEqual(addedTool.render(80), ["tool:web_search:80"]);
  calm.setActiveWorkers(1);
  await pi.commands.get("calm")?.("", context);
  assert.deepEqual(tool.render(80), []);
  assert.deepEqual(addedTool.render(80), []);
  assert.match(ui.statuses.get("calm") ?? "", /calm/);
  const widgetFactory = ui.widgets.get("calm");
  assert.ok(widgetFactory);
  const widget = widgetFactory({ requestRender() {} }, ui.theme);
  assert.equal(widget.render(80).length, 1);
  assert.match(widget.render(80)[0] ?? "", /Workgraph/);
  assert.equal(ui.workingVisible, false);
  calm.setActiveWorkers(0);
  assert.equal(ui.widgets.get("calm"), undefined);
  calm.setActiveWorkers(1);
  await pi.commands.get("calm")?.("", context);
  assert.deepEqual(tool.render(80), ["tool:workgraph_notepad:80"]);
  assert.deepEqual(addedTool.render(80), ["tool:web_search:80"]);
  const compactFactory = ui.widgets.get("calm");
  assert.ok(compactFactory);
  assert.equal(compactFactory({ requestRender() {} }, ui.theme).render(80).length, 1);
  assert.equal(ui.statuses.get("calm"), undefined);
  assert.equal(ui.workingVisible, false);
  await pi.events.get("session_shutdown")?.({}, context);
  assert.equal(ui.widgets.get("calm"), undefined);
  assert.equal(ui.workingVisible, true);
  assert.deepEqual(tool.render(80), ["tool:workgraph_notepad:80"]);
});

void test("invalid Calm tool additions warn and retain package defaults", async () => {
  const pi = fakePi();
  const ui = fakeUi();
  installCalmMode(pi as unknown as ExtensionAPI, {
    loadAdditionalHiddenTools: async () => {
      throw new Error("invalid global additions");
    },
    loadPresentation: async () => moduleForFakeRows(),
    preferences: { load: async () => true, save: async () => {} },
  });
  const context = {
    mode: "tui",
    ui,
    isIdle: () => true,
    sessionManager: pi.session,
  } as unknown as ExtensionContext;
  try {
    await pi.events.get("session_start")?.({}, context);
    assert.deepEqual(new FakeToolRow("read").render(80), []);
    assert.deepEqual(new FakeToolRow("web_search").render(80), ["tool:web_search:80"]);
    assert.ok(
      ui.notifications.some((notification) => notification.includes("Using built-in defaults")),
    );
  } finally {
    await pi.events.get("session_shutdown")?.({}, context);
  }
});

void test("missing internal seam leaves rows visible and reports a diagnostic", async () => {
  const tool = new FakeToolRow("read");
  const message = new FakeMessageRow("pi-workgraph-attention");
  const toolOutput = tool.render(80);
  const messageOutput = message.render(80);
  const toolClick = { kind: "tool-click" };
  const messageClick = { kind: "message-click" };
  const pi = fakePi();
  const ui = fakeUi();
  const calm = installCalmMode(pi as unknown as ExtensionAPI, {
    loadPresentation: async () => {
      throw new Error("unsupported Pi seam");
    },
    preferences: { load: async () => false, save: async () => {} },
    intervalMs: 5,
  });
  // SAFETY: The fixture supplies only the ExtensionContext fields consumed by Calm.
  const context = {
    mode: "tui",
    ui,
    isIdle: () => true,
    sessionManager: pi.session,
  } as unknown as ExtensionContext;
  let renderRequests = 0;
  try {
    await pi.events.get("session_start")?.({}, context);
    calm.setActiveWorkers(1);
    const widgetFactory = ui.widgets.get("calm");
    assert.ok(widgetFactory);
    widgetFactory({ requestRender: () => renderRequests++ }, ui.theme);
    await delay(20);
    assert.ok(renderRequests > 0);

    await pi.commands.get("calm")?.("", context);
    assert.deepEqual(tool.render(80), toolOutput);
    assert.deepEqual(message.render(80), messageOutput);
    assert.equal(tool.handleMouse(toolClick), toolClick);
    assert.equal(message.handleMouse(messageClick), messageClick);
    assert.ok(
      ui.notifications.some((notification) => notification.includes("Rows remain visible")),
    );
  } finally {
    await pi.events.get("session_shutdown")?.({}, context);
    const requestsAfterShutdown = renderRequests;
    await delay(20);
    assert.equal(renderRequests, requestsAfterShutdown);
    assert.equal(ui.widgets.get("calm"), undefined);
    assert.equal(ui.indicator, undefined);
    assert.equal(ui.workingVisible, true);
  }
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

void test("activity uses compact mode outside Calm and freezes for registered fixture prompt state", async () => {
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
    const factory = ui.widgets.get("calm");
    assert.ok(factory);
    const widget = factory({ requestRender() {} }, ui.theme);
    assert.equal(widget.render(80).length, 1);
    assert.equal(ui.workingVisible, false);
    await pi.commands.get("calm")?.("", context);
    assert.equal(widget.render(80).length, 2);
    assert.equal(stripAnsiLikeTheme(widget.render(80)[0] ?? ""), "thinking");
    await pi.events.get("message_update")?.(
      {
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta" },
      },
      context,
    );
    assert.equal(stripAnsiLikeTheme(widget.render(80)[0] ?? ""), "responding");
    await pi.events.get("tool_execution_start")?.(
      {
        toolCallId: "read-1",
        toolName: "read",
        args: { path: "/workspace/calm.ts", command: "never show" },
      },
      context,
    );
    assert.equal(stripAnsiLikeTheme(widget.render(80)[0] ?? ""), "read · calm.ts");
    await pi.events.get("tool_execution_start")?.(
      {
        toolCallId: "bash-1",
        toolName: "bash",
        args: { command: "secret query never show" },
      },
      context,
    );
    assert.equal(stripAnsiLikeTheme(widget.render(80)[0] ?? ""), "read · bash");
    await pi.events.get("tool_execution_end")?.(
      {
        toolCallId: "read-1",
        toolName: "read",
        result: [{ type: "text", text: "never show" }],
        isError: false,
      },
      context,
    );
    assert.equal(stripAnsiLikeTheme(widget.render(80)[0] ?? ""), "bash");
    await pi.events.get("ui_prompt_start")?.({}, context);
    assert.equal(widget.render(80).length, 1);
    assert.match(stripAnsiLikeTheme(widget.render(80)[0] ?? ""), /awaiting input/);
    await pi.events.get("ui_prompt_end")?.({}, context);
    assert.equal(stripAnsiLikeTheme(widget.render(80)[0] ?? ""), "bash");
    await pi.events.get("tool_execution_end")?.(
      {
        toolCallId: "bash-1",
        toolName: "bash",
        result: [{ type: "text", text: "never show" }],
        isError: false,
      },
      context,
    );
    assert.equal(stripAnsiLikeTheme(widget.render(80)[0] ?? ""), "thinking");
    calm.setActiveWorkers(2);
    await pi.events.get("agent_settled")?.({}, context);
    assert.match(stripAnsiLikeTheme(widget.render(80)[0] ?? ""), /2 workers active/);
    assert.doesNotMatch(stripAnsiLikeTheme(widget.render(80)[0] ?? ""), /coordinating/);
    calm.setActiveWorkers(0);
    assert.equal(ui.widgets.get("calm"), undefined);
  } finally {
    await pi.events.get("session_shutdown")?.({}, context);
  }
});
