import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";

import {
  calmActivityLines,
  createCalmActivityTracker,
  isCalmActivityActive,
  isCoordinatorScope,
} from "../src/calm.js";
import { discoverCalmChat } from "../src/calm-projection.js";
import {
  assistantMessage,
  customMessage,
  FixtureAssistant,
  FixtureContainer,
  FixtureCustomMessage,
  FixtureSkill,
  FixtureToolExecution,
  FixtureUser,
  fixtureRuntime,
  projected,
  renderedLines,
  skillBlock,
  textPart,
  thinkingPart,
  toolCallPart,
} from "./calm-fixture.js";
import {
  calmHarness,
  command,
  fakeTheme,
  fakeTuiRoot,
  messageUpdate,
  shutdown,
  start,
} from "./calm-harness.js";

initTheme("dark", false);

class CountingRow implements Component {
  clicks = 0;
  readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  render(): string[] {
    return [this.label];
  }

  invalidate(): void {}

  handleMouse(): undefined {
    this.clicks += 1;
    return undefined;
  }
}

class MouseUser extends FixtureUser {
  clicks = 0;

  override handleMouse(): undefined {
    this.clicks += 1;
    return undefined;
  }
}

void test("Calm projects the current visible transcript with final exclusions and adjacency", () => {
  const chat = new FixtureContainer();
  chat.addChild(new FixtureUser("hello"));
  chat.addChild(
    new FixtureAssistant(assistantMessage([thinkingPart("secret"), textPart("first")])),
  );
  chat.addChild(new FixtureToolExecution("read"));
  chat.addChild(new FixtureAssistant(assistantMessage([textPart("second")])));
  chat.addChild(new FixtureCustomMessage(customMessage("pi-workgraph-outcome")));
  chat.addChild(new FixtureCustomMessage(customMessage("pi-workgraph-unknown")));
  chat.addChild(new FixtureCustomMessage(customMessage("pi-workgraph-attention")));
  const projection = projected(chat);
  try {
    assert.deepEqual(renderedLines(chat), [
      "hello",
      "first",
      "---",
      "second",
      "[pi-workgraph-unknown] payload",
      "[pi-workgraph-attention] payload",
    ]);
  } finally {
    projection.detach();
  }
});

void test("render observes streaming, finalization, terminal notices, and direct splices", () => {
  const chat = new FixtureContainer();
  const assistant = new FixtureAssistant();
  chat.addChild(assistant);
  const projection = projected(chat);
  try {
    assistant.updateContent(assistantMessage([textPart("partial")]), true);
    assert.deepEqual(renderedLines(chat), ["partial"]);
    const copy = FixtureAssistant.instances.at(-1);
    assert.ok(copy !== undefined && copy !== assistant);
    assert.equal(copy.isStreaming, true);
    const updates = copy.updates;
    assert.deepEqual(renderedLines(chat), ["partial"]);
    assert.equal(copy.updates, updates, "an unchanged render reuses the cached assistant");

    assistant.updateContent(assistantMessage([textPart("complete")]), false);
    assert.deepEqual(renderedLines(chat), ["complete"]);
    assert.equal(copy.isStreaming, false);
    assistant.updateContent(
      { ...assistantMessage([toolCallPart("read")]), stopReason: "aborted" },
      false,
    );
    assert.deepEqual(renderedLines(chat), ["Operation aborted"]);

    chat.children.splice(0, 0, new CountingRow("spliced"));
    assert.deepEqual(renderedLines(chat), ["spliced", "Operation aborted"]);
  } finally {
    projection.detach();
  }
});

void test("skill pairing is metadata-driven and unknown rows pass through", () => {
  const chat = new FixtureContainer();
  chat.addChild(new FixtureSkill(skillBlock("calm")));
  chat.addChild(new FixtureUser("unrelated"));
  chat.addChild(new FixtureSkill(skillBlock("review", "paired request")));
  chat.addChild(new FixtureUser("paired request"));
  chat.addChild(new CountingRow("future native row"));
  const projection = projected(chat);
  try {
    assert.deepEqual(renderedLines(chat), [
      "/skill:calm",
      "unrelated",
      "paired request",
      "future native row",
    ]);
  } finally {
    projection.detach();
  }
});

void test("toggle, mouse routing, invalidate freshness, and detach preserve native fallback", () => {
  const chat = new FixtureContainer();
  const user = new MouseUser("click me");
  const assistant = new FixtureAssistant(
    assistantMessage([thinkingPart("native"), textPart("answer")]),
  );
  const tool = new FixtureToolExecution("read");
  chat.addChild(user);
  chat.addChild(assistant);
  chat.addChild(tool);
  const projection = projected(chat);
  assert.deepEqual(renderedLines(chat), ["click me", "answer"]);
  const height = chat.render(80).length;
  chat.handleMouse({ y: 0, height, width: 80 });
  assert.equal(user.clicks, 1);
  assert.equal(tool.clicks, 0);

  const nativeInvalidations = assistant.invalidations;
  chat.invalidate();
  assert.ok(assistant.invalidations > nativeInvalidations, "native invalidation always runs");
  assert.deepEqual(renderedLines(chat), ["click me", "answer"]);

  projection.setEnabled(false);
  assert.deepEqual(renderedLines(chat), ["click me", "native", "answer", "[tool] read"]);
  const nativeHeight = chat.render(80).length;
  chat.handleMouse({ y: nativeHeight - 1, height: nativeHeight, width: 80 });
  assert.equal(tool.clicks, 1);
  projection.setEnabled(true);
  assert.deepEqual(renderedLines(chat), ["click me", "answer"]);
  projection.detach();
  assert.deepEqual(renderedLines(chat), ["click me", "native", "answer", "[tool] read"]);
});

void test("separators are width-safe and a render incompatibility fails open once", () => {
  const chat = new FixtureContainer();
  chat.addChild(new FixtureAssistant(assistantMessage([textPart("a")])));
  chat.addChild(new FixtureAssistant(assistantMessage([textPart("b")])));
  const diagnostics: string[] = [];
  const projection = projected(chat, fixtureRuntime, (message) => diagnostics.push(message));
  assert.deepEqual(renderedLines(chat, 2), ["a", "--", "b"]);
  const malformed = new FixtureCustomMessage(customMessage("bad"));
  Reflect.set(malformed.message, "customType", 42);
  chat.addChild(malformed);
  assert.match(renderedLines(chat).join("\n"), /\[42\] payload/);
  assert.equal(diagnostics.length, 1);
  projection.setEnabled(true);
  assert.match(renderedLines(chat).join("\n"), /\[42\] payload/);
  assert.equal(diagnostics.length, 1);
  projection.detach();
});

void test("discovery validates the live document and chat class identity", () => {
  const chat = new FixtureContainer();
  const tui = fakeTuiRoot(() => new FixtureContainer(), chat);
  assert.equal(discoverCalmChat(tui, fixtureRuntime), chat);
  tui.children.length = 0;
  assert.throws(() => discoverCalmChat(tui, fixtureRuntime), /document layout seam/);
});

void test("Calm rail keeps activity first, worker status second, and clears when Calm turns off", async () => {
  const chat = new FixtureContainer();
  const { ui, pi, context } = calmHarness({
    runtime: fixtureRuntime,
    tui: fakeTuiRoot(() => new FixtureContainer(), chat),
  });
  await start(pi, context);
  await command(pi, context);
  await pi.events.get("agent_start")?.({}, context);
  const rail = ui.widgets.get("calm");
  assert.ok(rail);
  const activityLines = renderedLines(rail);
  assert.equal(activityLines.length, 2);
  assert.match(activityLines[0] ?? "", /thinking/);
  assert.match(activityLines[1] ?? "", /Workgraph/);
  assert.equal(ui.workingVisible, false);

  await pi.events.get("tool_execution_start")?.(
    { toolCallId: "read-1", toolName: "read", args: { path: "/workspace/calm.ts" } },
    context,
  );
  const withTool = renderedLines(rail);
  assert.equal(withTool.length, 2);
  assert.match(withTool[0] ?? "", /read calm\.ts/);
  assert.match(withTool[1] ?? "", /Workgraph/);

  await command(pi, context);
  assert.equal(ui.widgets.get("calm"), undefined);
  assert.equal(ui.statuses.get("calm"), undefined);
  assert.equal(ui.workingVisible, true);
  await shutdown(pi, context);
});

void test("Calm animation runs only for active non-waiting coordinator execution", async () => {
  const { tui, ui, pi, calm, context } = calmHarness({ runtime: fixtureRuntime, intervalMs: 5 });
  await start(pi, context);
  await command(pi, context);
  await pi.events.get("agent_start")?.({}, context);
  const before = tui.requests;
  await delay(40);
  assert.ok(tui.requests > before, "coordinator execution should animate");

  await pi.events.get("ui_prompt_start")?.({}, context);
  const waiting = tui.requests;
  await delay(40);
  assert.equal(tui.requests, waiting, "waiting for input must stay static");

  await pi.events.get("ui_prompt_end")?.({}, context);
  await pi.events.get("agent_settled")?.({}, context);
  calm.setActiveWorkers(2);
  const workerOnly = tui.requests;
  const rail = ui.widgets.get("calm");
  assert.ok(rail);
  assert.match(renderedLines(rail).join(" "), /2 workers active/);
  calm.setActiveWorkers(2);
  assert.equal(tui.requests, workerOnly, "an unchanged worker count must not request a render");
  await delay(40);
  assert.equal(tui.requests, workerOnly, "worker-only state must stay static");
  await shutdown(pi, context);
});

void test("semantic no-op updates do not request renders", async () => {
  const { tui, pi, context } = calmHarness({ runtime: fixtureRuntime });
  await start(pi, context);
  await command(pi, context);
  await pi.events.get("agent_start")?.({}, context);
  const before = tui.requests;
  await messageUpdate(pi, context, "text_delta");
  assert.equal(tui.requests, before + 1);
  await messageUpdate(pi, context, "text_delta");
  assert.equal(tui.requests, before + 1, "a repeated semantic state must not request a render");
  await shutdown(pi, context);
});

void test("Calm presentation is unavailable when the chat seam cannot be discovered", async () => {
  const malformed = fakeTuiRoot(() => new FixtureContainer());
  malformed.children.length = 0;
  const document = new FixtureContainer();
  document.addChild(new FixtureContainer());
  malformed.addChild(document);
  const { ui, pi, context } = calmHarness({ runtime: fixtureRuntime, tui: malformed });
  await start(pi, context);
  await delay(0);
  assert.ok(ui.notifications.some((message) => message.includes("Calm unavailable")));
  await command(pi, context);
  assert.equal(ui.widgets.get("calm"), undefined);
  assert.equal(ui.workingVisible, true);
  await shutdown(pi, context);
});

void test("Calm session default persists across reload, resume, and new sessions", async () => {
  let defaultOn = false;
  let saves = 0;
  const { ui, pi, context } = calmHarness({
    runtime: fixtureRuntime,
    preferences: {
      load: () => Promise.resolve(defaultOn),
      save: (on) => {
        defaultOn = on;
        saves += 1;
        return Promise.resolve();
      },
    },
  });
  const isOn = (): boolean => ui.statuses.get("calm") !== undefined;
  await start(pi, context);
  assert.equal(isOn(), false);
  await command(pi, context, "default on");
  assert.equal(defaultOn, true);
  assert.equal(isOn(), false, "changing the default must not flip this session");
  await shutdown(pi, context);
  await start(pi, context);
  assert.equal(isOn(), false, "a reload keeps the frozen startup choice");
  await command(pi, context);
  assert.equal(isOn(), true);
  await shutdown(pi, context);
  await start(pi, context);
  assert.equal(isOn(), true, "a resumed session restores its own choice");
  await command(pi, context);
  assert.equal(isOn(), false);
  await command(pi, context, "default maybe");
  assert.equal(saves, 1, "only real default changes save");
  await shutdown(pi, context);
  pi.session.newSession();
  await start(pi, context);
  assert.equal(isOn(), true, "a new session follows the saved default");
  await command(pi, context, "default off");
  assert.equal(isOn(), true, "changing the default still does not flip this session");
  await shutdown(pi, context);
});

void test("Calm on projects the chat while shutdown restores native presentation and stops timers", async () => {
  const chat = new FixtureContainer();
  const tui = fakeTuiRoot(() => new FixtureContainer(), chat);
  const { ui, pi, context } = calmHarness({
    runtime: fixtureRuntime,
    tui,
    preferences: {
      load: () => Promise.resolve(true),
      save: () => Promise.resolve(),
    },
  });
  await start(pi, context);
  const hidden = new FixtureToolExecution("read");
  chat.addChild(new FixtureAssistant(assistantMessage([textPart("answer")])));
  chat.addChild(hidden);
  assert.deepEqual(renderedLines(chat), ["answer"]);
  await pi.events.get("agent_start")?.({}, context);
  await shutdown(pi, context);
  assert.equal(ui.widgets.get("calm"), undefined);
  assert.equal(ui.statuses.get("calm"), undefined);
  assert.equal(ui.workingVisible, true);
  assert.ok(renderedLines(chat).includes("[tool] read"));
  const requests = tui.requests;
  await delay(40);
  assert.equal(tui.requests, requests, "shutdown must stop the pulse timer");
});

void test("coordinator scope and activity state remain unchanged", () => {
  assert.equal(isCoordinatorScope({}), true);
  assert.equal(isCoordinatorScope({ PI_WORKGRAPH_ROLE: "" }), true);
  assert.equal(isCoordinatorScope({ PI_WORKGRAPH_ROLE: "implementation" }), false);
  assert.equal(isCalmActivityActive({ coordinatorActive: false, activeWorkers: 0 }), false);
  assert.equal(isCalmActivityActive({ coordinatorActive: true, activeWorkers: 0 }), true);
  assert.equal(isCalmActivityActive({ coordinatorActive: false, activeWorkers: 2 }), true);
});

void test("activity tracker bounds history, live labels, width, and secrets", () => {
  const theme = fakeTheme();
  const tracker = createCalmActivityTracker();
  tracker.startAgent();
  tracker.messageUpdate("text_delta");
  tracker.toolStart("read-1", "read", { path: "/private/calm.ts", command: "secret" });
  tracker.toolStart("bash-1", "bash", { command: "secret --query never-render" });
  tracker.toolEnd("bash-1");
  assert.deepEqual(tracker.snapshot().activeTools, [
    { toolCallId: "read-1", toolName: "read", pathHint: "calm.ts" },
  ]);

  const lines = calmActivityLines(
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
  assert.equal(lines[0], "bash › web_search");
  assert.doesNotMatch(lines.join(" "), /secret|never-render/);

  const waiting = calmActivityLines(
    { coordinatorActive: false, activeWorkers: 2, waitingForInput: true },
    0,
    80,
    theme,
  );
  assert.match(waiting.join(" "), /awaiting input/);
  assert.match(waiting.join(" "), /2 workers active/);

  for (const width of [1, 8, 12, 80]) {
    assert.ok(
      calmActivityLines(
        { calmOn: true, coordinatorActive: true, activeWorkers: 0 },
        0,
        width,
        theme,
      ).every((line) => visibleWidth(line) <= width),
    );
  }
});
