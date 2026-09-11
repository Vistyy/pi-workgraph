import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";

import {
  calmActivityLines,
  createCalmActivityTracker,
  isCalmActivityActive,
  isCoordinatorScope,
} from "../src/calm.js";
import { discoverCalmChat } from "../src/calm-projection.js";
import type { CalmChatRuntime } from "../src/pi-chat-runtime.js";
import {
  assistantMessage,
  classificationChecks,
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
  strip,
  textPart,
  thinkingPart,
  toolCallPart,
} from "./calm-fixture.js";
import {
  calmHarness,
  command,
  fakeTheme,
  fakeTuiRoot,
  fixture,
  messageUpdate,
  shutdown,
  start,
} from "./calm-harness.js";

initTheme("dark", false);

interface RenderOverridable {
  render(width: number): string[];
}

class CountingRow implements Component {
  renders = 0;
  clicks = 0;
  readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  render(): string[] {
    this.renders += 1;
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

/**
 * A projection Container that counts externally meaningful child add/clear operations, so a rebuild
 * of the displayed membership is observable without any test-only production API.
 */
class CounterContainer extends FixtureContainer {
  static readonly instances: CounterContainer[] = [];
  adds = 0;
  clears = 0;

  constructor() {
    super();
    CounterContainer.instances.push(this);
  }

  override addChild(component: Component): void {
    this.adds += 1;
    super.addChild(component);
  }

  override clear(): void {
    this.clears += 1;
    super.clear();
  }
}

const counterRuntime: CalmChatRuntime = { ...fixtureRuntime, container: CounterContainer };

/** A live assistant whose native update path fails, so deferred restoration must contain it. */
class FailingRefreshAssistant extends FixtureAssistant {
  attempts = 0;
  readonly #failure: string;

  constructor(failure: string) {
    super();
    this.#failure = failure;
  }

  override updateContent(_message: AssistantMessage, _isStreaming?: boolean): void {
    this.attempts += 1;
    throw new Error(this.#failure);
  }
}

/** A live chat whose native invalidation fails, so restoration must contain that too. */
class ThrowingInvalidateContainer extends FixtureContainer {
  invalidations = 0;

  override invalidate(): void {
    this.invalidations += 1;
    throw new Error("native invalidation failed");
  }
}

void test("Calm hides excluded rows, keeps assistant adjacency, and renders stably", () => {
  const chat = new FixtureContainer();
  const user = new FixtureUser("hello there");
  const first = new FixtureAssistant(assistantMessage([textPart("first answer")]));
  const hiddenTool = new FixtureToolExecution("read");
  const second = new FixtureAssistant(assistantMessage([textPart("second answer")]));
  const hiddenWorkstream = new FixtureCustomMessage(customMessage("pi-workgraph-workstream"));
  const hiddenAttention = new FixtureCustomMessage(customMessage("pi-workgraph-attention"));
  chat.addChild(user);
  chat.addChild(first);
  chat.addChild(hiddenTool);
  chat.addChild(second);
  chat.addChild(hiddenWorkstream);
  chat.addChild(hiddenAttention);
  const projection = projected(chat);
  try {
    const lines = renderedLines(chat);
    assert.deepEqual(lines, ["hello there", "first answer", "---", "second answer"]);
    for (let frame = 0; frame < 5; frame += 1) assert.deepEqual(renderedLines(chat), lines);
    assert.equal(hiddenTool.renders, 0);
    assert.equal(hiddenWorkstream.renders, 0);
    assert.equal(hiddenAttention.renders, 0);
  } finally {
    projection.detach();
  }
  assert.ok(renderedLines(chat).includes("[tool] read"));
  assert.ok(renderedLines(chat).includes("[pi-workgraph-workstream] payload"));
});

void test("animation frames neither classify nor render excluded native history", () => {
  const chat = new FixtureContainer();
  const hidden: FixtureToolExecution[] = [];
  for (let index = 0; index < 50; index += 1) {
    const row = new FixtureToolExecution(`tool-${index}`);
    hidden.push(row);
    chat.addChild(row);
    chat.addChild(new FixtureAssistant(assistantMessage([textPart(`answer ${index}`)])));
  }
  const projection = projected(chat);
  try {
    const checks = classificationChecks();
    for (let frame = 0; frame < 20; frame += 1) chat.render(80);
    assert.equal(classificationChecks(), checks);
    for (const row of hidden) assert.equal(row.renders, 0);
  } finally {
    projection.detach();
  }
});

void test("thinking-only and tool-only assistant records create neither rows nor phantom separators", () => {
  const chat = new FixtureContainer();
  const visibleFirst = new FixtureAssistant(assistantMessage([textPart("visible one")]));
  const thinkingOnly = new FixtureAssistant(assistantMessage([thinkingPart("private reasoning")]));
  const toolOnly = new FixtureAssistant(assistantMessage([toolCallPart("read")]));
  const visibleSecond = new FixtureAssistant(assistantMessage([textPart("visible two")]));
  const hiddenTool = new FixtureToolExecution("write");
  chat.addChild(visibleFirst);
  chat.addChild(thinkingOnly);
  chat.addChild(hiddenTool);
  chat.addChild(visibleSecond);
  chat.addChild(toolOnly);
  const projection = projected(chat);
  try {
    assert.deepEqual(renderedLines(chat), ["visible one", "---", "visible two"]);
    assert.equal(hiddenTool.renders, 0);
    assert.doesNotMatch(renderedLines(chat).join("\n"), /private reasoning|\[tool\]/);
  } finally {
    projection.detach();
  }
});

void test("assistant terminal notices stay visible with no prose and keep stopReason", () => {
  const chat = new FixtureContainer();
  const aborted = assistantMessage([]);
  aborted.stopReason = "aborted";
  const errored = assistantMessage([]);
  errored.stopReason = "error";
  errored.errorMessage = "provider exploded";
  const truncated = assistantMessage([]);
  truncated.stopReason = "length";
  chat.addChild(new FixtureAssistant(aborted));
  chat.addChild(new FixtureAssistant(errored));
  chat.addChild(new FixtureAssistant(truncated));
  const projection = projected(chat);
  try {
    const lines = renderedLines(chat).join("\n");
    assert.match(lines, /Operation aborted/);
    assert.match(lines, /Error: provider exploded/);
    assert.match(lines, /Response was truncated before completion\./);
  } finally {
    projection.detach();
  }
});

void test("an interrupted turn keeps its notice after tool-call filtering", () => {
  const chat = new FixtureContainer();
  const interrupted = assistantMessage([toolCallPart("read"), textPart("partial answer")]);
  interrupted.stopReason = "aborted";
  const errored = assistantMessage([toolCallPart("write")]);
  errored.stopReason = "error";
  errored.errorMessage = "stream failed";
  const hiddenTool = new FixtureToolExecution("read");
  chat.addChild(new FixtureAssistant(interrupted));
  chat.addChild(hiddenTool);
  chat.addChild(new FixtureAssistant(errored));
  const projection = projected(chat);
  try {
    const lines = renderedLines(chat).join("\n");
    assert.match(lines, /partial answer/);
    assert.match(lines, /Operation aborted/);
    assert.match(lines, /Error: stream failed/);
    assert.equal(hiddenTool.renders, 0);
    assert.doesNotMatch(lines, /\[tool\]/);
  } finally {
    projection.detach();
  }
});

void test("visible native rows break assistant adjacency while hidden tools do not", () => {
  const withHiddenTool = new FixtureContainer();
  withHiddenTool.addChild(new FixtureAssistant(assistantMessage([textPart("a")])));
  withHiddenTool.addChild(new FixtureToolExecution("read"));
  withHiddenTool.addChild(new FixtureAssistant(assistantMessage([textPart("b")])));
  const hiddenProjection = projected(withHiddenTool);
  try {
    assert.deepEqual(renderedLines(withHiddenTool), ["a", "---", "b"]);
  } finally {
    hiddenProjection.detach();
  }

  const withNotice = new FixtureContainer();
  const warning = new CountingRow("warning: cache miss");
  withNotice.addChild(new FixtureAssistant(assistantMessage([textPart("a")])));
  withNotice.addChild(warning);
  withNotice.addChild(new FixtureAssistant(assistantMessage([textPart("b")])));
  const noticeProjection = projected(withNotice);
  try {
    assert.deepEqual(renderedLines(withNotice), ["a", "warning: cache miss", "b"]);
    assert.equal(warning.renders, 1);
  } finally {
    noticeProjection.detach();
  }
});

void test("native, unknown, and non-Workgraph custom rows stay visible by default", () => {
  const chat = new FixtureContainer();
  const cache = new CountingRow("cache: read 1024 tokens");
  const unknown = new CountingRow("future-native-widget");
  const custom = new FixtureCustomMessage(customMessage("pi-lavish-report", "report body"));
  const bash = new CountingRow("$ git status clean");
  chat.addChild(new FixtureUser("hello"));
  chat.addChild(cache);
  chat.addChild(unknown);
  chat.addChild(custom);
  chat.addChild(bash);
  chat.addChild(new FixtureAssistant(assistantMessage([textPart("answer")])));
  const projection = projected(chat);
  try {
    assert.deepEqual(renderedLines(chat), [
      "hello",
      "cache: read 1024 tokens",
      "future-native-widget",
      "[pi-lavish-report] report body",
      "$ git status clean",
      "answer",
    ]);
    assert.equal(custom.renders, 1);
    assert.equal(bash.renders, 1);
  } finally {
    projection.detach();
  }
});

void test("only the two Workgraph custom types are excluded", () => {
  const chat = new FixtureContainer();
  const excluded = [
    new FixtureCustomMessage(customMessage("pi-workgraph-workstream")),
    new FixtureCustomMessage(customMessage("pi-workgraph-attention")),
  ];
  for (const row of excluded) chat.addChild(row);
  chat.addChild(new FixtureCustomMessage(customMessage("pi-workgraph-other")));
  const projection = projected(chat);
  try {
    assert.deepEqual(renderedLines(chat), ["[pi-workgraph-other] payload"]);
    for (const row of excluded) assert.equal(row.renders, 0);
  } finally {
    projection.detach();
  }
});

void test("a malformed custom message metadata seam fails open and detaches", () => {
  const chat = new FixtureContainer();
  const diagnostics: string[] = [];
  const projection = projected(chat, fixtureRuntime, (message) => diagnostics.push(message));
  const broken = new FixtureCustomMessage(customMessage("third-party"));
  Reflect.deleteProperty(broken, "message");
  chat.addChild(broken);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0] ?? "", /custom message metadata seam is missing/);
  assert.equal(Object.getOwnPropertyDescriptor(chat, "render"), undefined);
  projection.detach();

  const wrongType = new FixtureContainer();
  const typeDiagnostics: string[] = [];
  const wrongProjection = projected(wrongType, fixtureRuntime, (message) =>
    typeDiagnostics.push(message),
  );
  const malformed = new FixtureCustomMessage(customMessage("third-party"));
  Object.defineProperty(malformed, "message", { configurable: true, value: { content: "x" } });
  wrongType.addChild(malformed);
  assert.equal(typeDiagnostics.length, 1);
  assert.match(typeDiagnostics[0] ?? "", /custom message metadata seam is malformed/);
  wrongProjection.detach();
});

void test("Calm off leaves the native transcript and updates unchanged", () => {
  const chat = new FixtureContainer();
  const tool = new FixtureToolExecution("read");
  const custom = new FixtureCustomMessage(customMessage("pi-workgraph-workstream"));
  const assistant = new FixtureAssistant(
    assistantMessage([thinkingPart("hidden reasoning"), textPart("answer")]),
  );
  chat.addChild(tool);
  chat.addChild(custom);
  chat.addChild(assistant);
  const projection = projected(chat);
  projection.setEnabled(false);
  try {
    const native = renderedLines(chat).join("\n");
    assert.match(native, /\[tool\] read/);
    assert.match(native, /\[pi-workgraph-workstream\] payload/);
    assert.match(native, /hidden reasoning/);
    assert.match(native, /answer/);
    assistant.updateContent(assistantMessage([textPart("native update")]));
    assert.match(renderedLines(chat).join("\n"), /native update/);
  } finally {
    projection.detach();
  }
});

void test("skill pairing follows metadata, not the next user sibling", () => {
  // A skill-only invocation followed by an unrelated user message keeps its compact line.
  const skillOnly = new FixtureContainer();
  skillOnly.addChild(new FixtureSkill(skillBlock("calm")));
  skillOnly.addChild(new FixtureUser("an unrelated follow-up"));
  const skillProjection = projected(skillOnly);
  try {
    assert.deepEqual(renderedLines(skillOnly), ["/skill:calm", "an unrelated follow-up"]);
    assert.doesNotMatch(renderedLines(skillOnly).join("\n"), /INJECTED-SKILL-CONTENT|\[skill\]/);
  } finally {
    skillProjection.detach();
  }

  // An actual skill + user pairing hides only the injected skill details.
  const skillWithUser = new FixtureContainer();
  skillWithUser.addChild(new FixtureSkill(skillBlock("calm", "please do the thing")));
  skillWithUser.addChild(new FixtureUser("please do the thing"));
  const withUserProjection = projected(skillWithUser);
  try {
    assert.deepEqual(renderedLines(skillWithUser), ["please do the thing"]);
    assert.doesNotMatch(
      renderedLines(skillWithUser).join("\n"),
      /INJECTED-SKILL-CONTENT|\[skill\]/,
    );
  } finally {
    withUserProjection.detach();
  }
});

void test("streaming updates only the projected assistant and finalizes streaming state", () => {
  const chat = new FixtureContainer();
  const projection = projected(chat);
  const beforeInstances = FixtureAssistant.instances.length;
  const streaming = new FixtureAssistant();
  try {
    chat.addChild(streaming);
    assert.deepEqual(renderedLines(chat), []);
    streaming.updateContent(assistantMessage([thinkingPart("hmm")]), true);
    assert.deepEqual(renderedLines(chat), []);
    streaming.updateContent(assistantMessage([textPart("streamed answer")]), true);
    assert.deepEqual(renderedLines(chat), ["streamed answer"]);
    // Calm owns the visible assistant; the hidden native assistant must not be rebuilt for deltas.
    assert.equal(streaming.updates, 0);
    const projectedAssistant = FixtureAssistant.instances
      .slice(beforeInstances)
      .find((instance) => instance !== streaming);
    assert.ok(projectedAssistant);
    assert.equal(projectedAssistant.isStreaming, true);

    // Identical prose with a changed streaming state must still update the projected copy.
    const updates = projectedAssistant.updates;
    streaming.updateContent(assistantMessage([textPart("streamed answer")]), false);
    assert.equal(streaming.updates, 0, "finalization must not build the hidden native assistant");
    assert.equal(projectedAssistant.updates, updates + 1);
    assert.equal(projectedAssistant.isStreaming, false);
    assert.deepEqual(renderedLines(chat), ["streamed answer"]);

    // Restoring native presentation folds the retained latest source back into the native tree.
    projection.setEnabled(false);
    assert.equal(streaming.updates, 1);
    assert.deepEqual(renderedLines(chat), ["streamed answer"]);

    projection.setEnabled(true);
    chat.clear();
    assert.deepEqual(renderedLines(chat), []);
    const replacement = new FixtureAssistant(assistantMessage([textPart("replayed answer")]));
    chat.addChild(replacement);
    assert.deepEqual(renderedLines(chat), ["replayed answer"]);
  } finally {
    projection.detach();
  }
});

void test("repeated toggles restore native rendering and assistant thinking", () => {
  const chat = new FixtureContainer();
  const assistant = new FixtureAssistant(
    assistantMessage([thinkingPart("hidden reasoning"), textPart("answer")]),
  );
  chat.addChild(assistant);
  chat.addChild(new FixtureToolExecution("bash"));
  const projection = projected(chat);
  try {
    for (let toggle = 0; toggle < 3; toggle += 1) {
      projection.setEnabled(true);
      assert.deepEqual(renderedLines(chat), ["answer"]);
      projection.setEnabled(false);
      const native = renderedLines(chat).join("\n");
      assert.match(native, /hidden reasoning/);
      assert.match(native, /answer/);
      assert.match(native, /\[tool\] bash/);
    }
    // A Calm-off/Calm-on cycle re-arms restoration for the next deferred streaming update.
    const deferred = new FixtureAssistant();
    chat.addChild(deferred);
    projection.setEnabled(true);
    deferred.updateContent(assistantMessage([textPart("second answer")]), true);
    assert.equal(deferred.updates, 0);
    projection.setEnabled(false);
    assert.equal(deferred.updates, 1);
    assert.match(renderedLines(chat).join("\n"), /second answer/);
  } finally {
    projection.detach();
  }
});

void test("detach restores native rendering, update behavior, and mouse dispatch", () => {
  const chat = new FixtureContainer();
  const user = new MouseUser("hi");
  const first = new FixtureAssistant(assistantMessage([textPart("first")]));
  const hiddenTool = new FixtureToolExecution("read");
  const second = new FixtureAssistant(assistantMessage([textPart("second")]));
  chat.addChild(user);
  chat.addChild(first);
  chat.addChild(hiddenTool);
  chat.addChild(second);
  const width = 40;
  const projection = projected(chat);
  const userHeight = user.render(width).length;
  const firstHeight = first.render(width).length;
  const projectedLines = chat.render(width);
  try {
    assert.equal(chat.handleMouse({ y: 0, width, height: projectedLines.length }), undefined);
    assert.equal(user.clicks, 1);
    assert.equal(
      chat.handleMouse({ y: userHeight + firstHeight, width, height: projectedLines.length }),
      undefined,
    );
    assert.equal(hiddenTool.clicks, 0);
  } finally {
    projection.detach();
  }
  assert.equal(
    Object.getOwnPropertyDescriptor(first, "updateContent"),
    undefined,
    "detach must restore the native assistant update seam",
  );
  const nativeLines = chat.render(width);
  assert.ok(nativeLines.some((line) => strip(line).includes("[tool] read")));
  chat.handleMouse({ y: userHeight + firstHeight, width, height: nativeLines.length });
  assert.equal(hiddenTool.clicks, 1);

  first.updateContent(assistantMessage([textPart("updated natively")]));
  assert.match(renderedLines(chat).join("\n"), /updated natively/);
});

void test("projection invalidation follows native chat invalidation", () => {
  const chat = new FixtureContainer();
  chat.addChild(new FixtureUser("hello"));
  chat.addChild(new FixtureAssistant(assistantMessage([textPart("answer")])));
  const before = new Set(FixtureAssistant.instances);
  const projection = projected(chat);
  try {
    const projectedAssistants = FixtureAssistant.instances.filter(
      (instance) => !before.has(instance),
    );
    assert.ok(projectedAssistants.length >= 1);
    const invalidations = projectedAssistants.map((instance) => instance.invalidations);
    chat.invalidate();
    projectedAssistants.forEach((instance, index) => {
      assert.equal(instance.invalidations, (invalidations[index] ?? 0) + 1);
    });
    assert.deepEqual(renderedLines(chat), ["hello", "answer"]);
  } finally {
    projection.detach();
  }
});

void test("Calm-on invalidation refreshes the projection without traversing native history", () => {
  const chat = new FixtureContainer();
  const user = new FixtureUser("hello");
  const first = new FixtureAssistant(assistantMessage([textPart("first")]));
  const second = new FixtureAssistant(assistantMessage([textPart("second")]));
  chat.addChild(user);
  chat.addChild(first);
  chat.addChild(second);
  const projection = projected(chat);
  try {
    const nativeInvalidations = first.invalidations + second.invalidations;
    const userInvalidations = user.invalidations;
    chat.invalidate();
    assert.equal(
      first.invalidations + second.invalidations,
      nativeInvalidations,
      "hidden native assistants must not be traversed while Calm is on",
    );
    assert.equal(
      user.invalidations,
      userInvalidations + 1,
      "the reused user row must be invalidated exactly once",
    );
    assert.deepEqual(renderedLines(chat), ["hello", "first", "---", "second"]);
  } finally {
    projection.detach();
  }
});

void test("tail conversation additions append rows instead of rebuilding the projection", () => {
  CounterContainer.instances.length = 0;
  const chat = new CounterContainer();
  const projection = projected(chat, counterRuntime);
  try {
    const surface = CounterContainer.instances.find((instance) => instance !== chat);
    assert.ok(surface, "the projected Container is discoverable");
    surface.clears = 0;
    surface.adds = 0;

    chat.addChild(new FixtureUser("one"));
    assert.deepEqual(renderedLines(chat), ["one"]);
    assert.equal(surface.clears, 0, "a user row must not rebuild the projection");
    assert.equal(surface.adds, 1);

    chat.addChild(new FixtureAssistant(assistantMessage([textPart("a")])));
    assert.equal(surface.clears, 0, "an assistant row must not rebuild the projection");
    assert.equal(surface.adds, 2);

    chat.addChild(new FixtureUser("two"));
    assert.equal(surface.clears, 0);
    assert.equal(surface.adds, 3);

    chat.addChild(new FixtureAssistant(assistantMessage([textPart("b")])));
    assert.equal(surface.clears, 0);
    assert.equal(surface.adds, 4);

    const third = new FixtureAssistant();
    chat.addChild(third);
    third.updateContent(assistantMessage([textPart("c")]), true);
    assert.equal(surface.clears, 0);
    assert.equal(surface.adds, 6, "a second adjacent assistant appends a separator and its row");
    assert.deepEqual(renderedLines(chat), ["one", "a", "two", "b", "---", "c"]);

    const adds = surface.adds;
    third.updateContent(assistantMessage([textPart("c continues")]), true);
    assert.equal(surface.adds, adds, "streaming prose updates the projected row in place");
    assert.equal(surface.clears, 0);

    const userOne = chat.children[0];
    assert.ok(userOne);
    chat.removeChild(userOne);
    assert.ok(surface.clears > 0, "a non-tail removal genuinely changes order and rebuilds");
    assert.deepEqual(renderedLines(chat), ["a", "two", "b", "---", "c continues"]);

    const clears = surface.clears;
    chat.removeChild(third);
    assert.equal(surface.clears, clears, "a tail removal truncates without rebuilding");
    assert.deepEqual(renderedLines(chat), ["a", "two", "b"]);
  } finally {
    projection.detach();
  }
});

void test("a superseded session's runtime rejection cannot disable the current attachment", async () => {
  const chat = new FixtureContainer();
  const tui = fakeTuiRoot(() => new FixtureContainer(), chat);
  const pending: {
    resolve: (runtime: CalmChatRuntime) => void;
    reject: (error: Error) => void;
  }[] = [];
  const { ui, pi, context } = calmHarness({
    runtime: fixtureRuntime,
    tui,
    preferences: { load: () => Promise.resolve(true), save: () => Promise.resolve() },
    loadRuntime: () =>
      // oxlint-disable-next-line effecttsgo/new-promise -- The session lifecycle under test settles this promise directly to reproduce a stale load rejection.
      new Promise<CalmChatRuntime>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  });
  const unusable = (): number =>
    ui.notifications.filter((message) => message.includes("Calm unavailable")).length;

  const first = start(pi, context);
  await delay(0);
  const second = start(pi, context);
  await delay(0);
  assert.equal(pending.length, 2, "each session start loads its own runtime");

  pending[0]?.reject(new Error("stale bundle"));
  await first;
  await delay(0);
  assert.equal(
    unusable(),
    0,
    "a superseded rejection must not report or disable the current session",
  );

  pending[1]?.reject(new Error("stale bundle"));
  await second;
  await delay(0);
  assert.equal(unusable(), 1, "the current session reports its real compatibility failure");

  const third = start(pi, context);
  await delay(0);
  pending[2]?.reject(new Error("stale bundle"));
  await third;
  await delay(0);
  assert.equal(unusable(), 2, "the same failure is reported again in a later session");
  await shutdown(pi, context);
});

void test("separators stay width-safe and truncate with the viewport", () => {
  const chat = new FixtureContainer();
  chat.addChild(new FixtureAssistant(assistantMessage([textPart("a")])));
  chat.addChild(new FixtureAssistant(assistantMessage([textPart("b")])));
  const projection = projected(chat);
  try {
    assert.deepEqual(renderedLines(chat, 40), ["a", "---", "b"]);
    assert.ok(renderedLines(chat, 2).includes("--"));
    assert.ok(renderedLines(chat, 1).includes("-"));
    for (const width of [1, 2, 5, 80]) {
      const separators = renderedLines(chat, width).filter((line) => /^-+$/.test(line));
      assert.ok(separators.length >= 1);
      for (const line of separators) assert.ok(visibleWidth(line) <= width);
    }
  } finally {
    projection.detach();
  }
});

void test("discovery validates the inspected TUI layout and returns the live chat", () => {
  const chat = new FixtureContainer();
  const tui = fakeTuiRoot(() => new FixtureContainer(), chat);
  assert.equal(discoverCalmChat(tui, fixtureRuntime), chat);
  const malformed = fakeTuiRoot(() => new FixtureContainer());
  malformed.children.length = 0;
  const document = new FixtureContainer();
  document.addChild(new FixtureContainer());
  malformed.addChild(document);
  assert.throws(() => discoverCalmChat(malformed, fixtureRuntime), /document layout seam/);
});

void test("classification failure fails open, detaches, and refuses re-enabling", () => {
  const chat = new FixtureContainer();
  const hidden = new FixtureToolExecution("read");
  chat.addChild(hidden);
  const diagnostics: string[] = [];
  const projection = projected(chat, fixtureRuntime, (message) => diagnostics.push(message));
  try {
    assert.deepEqual(renderedLines(chat), []);
    // An empty skill name is type-valid but fails the guarded metadata check at classification.
    chat.addChild(new FixtureSkill(skillBlock("")));
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0] ?? "", /skill invocation metadata seam is malformed/);
    assert.ok(renderedLines(chat).includes("[tool] read"));
    // The incompatibility is terminal for this attachment: re-enabling cannot claim filtering.
    projection.setEnabled(true);
    assert.ok(renderedLines(chat).includes("[tool] read"));
  } finally {
    projection.detach();
  }
});

void test("a failing native assistant refresh releases every wrapper, continues, and reports once", () => {
  const chat = new FixtureContainer();
  const diagnostics: string[] = [];
  const projection = projected(chat, fixtureRuntime, (message) => diagnostics.push(message));
  const first = new FailingRefreshAssistant("first native update failed");
  const middle = new FixtureAssistant();
  const last = new FailingRefreshAssistant("last native update failed");
  chat.addChild(first);
  chat.addChild(middle);
  chat.addChild(last);
  first.updateContent(assistantMessage([textPart("one")]), true);
  middle.updateContent(assistantMessage([textPart("two")]), true);
  last.updateContent(assistantMessage([textPart("three")]), true);
  assert.deepEqual(renderedLines(chat), ["one", "---", "two", "---", "three"]);

  projection.setEnabled(false);

  // Every assistant is attempted exactly once; cleanup never recursively retries the failing refresh.
  assert.equal(first.attempts, 1);
  assert.equal(last.attempts, 1);
  // Cleanup continued past the first failure and restored the healthy assistant in between.
  assert.equal(middle.updates, 1);
  // No adapter-owned assistant or chat seam survives the failure.
  for (const assistant of [first, middle, last])
    assert.equal(Object.getOwnPropertyDescriptor(assistant, "updateContent"), undefined);
  assert.equal(Object.getOwnPropertyDescriptor(chat, "render"), undefined);
  assert.equal(Object.getOwnPropertyDescriptor(chat, "invalidate"), undefined);
  // The combined, most useful detail is reported exactly once.
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0] ?? "", /first native update failed/);
  assert.match(diagnostics[0] ?? "", /last native update failed/);
  // The attachment is terminal: re-enabling cannot claim filtering after a failed teardown.
  projection.setEnabled(true);
  assert.equal(first.attempts, 1);
  assert.deepEqual(renderedLines(chat), ["two"]);
});

void test("a failing native chat invalidation still releases every wrapper and reports once", () => {
  const chat = new ThrowingInvalidateContainer();
  const assistant = new FixtureAssistant(assistantMessage([textPart("answer")]));
  chat.addChild(assistant);
  const diagnostics: string[] = [];
  const projection = projected(chat, fixtureRuntime, (message) => diagnostics.push(message));
  assert.equal(chat.invalidations, 0);
  // Calm owns the hidden native tree, so this update is deferred until Calm turns off.
  assistant.updateContent(assistantMessage([textPart("answer")]), true);
  const updatesBefore = assistant.updates;

  // Turning Calm off restores the native assistant first, then fails on the native chat invalidation.
  projection.setEnabled(false);
  assert.equal(chat.invalidations, 1);
  assert.equal(assistant.updates, updatesBefore + 1, "native rows are restored before the failure");
  assert.equal(Object.getOwnPropertyDescriptor(assistant, "updateContent"), undefined);
  assert.equal(Object.getOwnPropertyDescriptor(chat, "invalidate"), undefined);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0] ?? "", /native invalidation failed/);
  // The terminal failure is not retried or reported a second time through cleanup or re-enabling.
  projection.detach();
  projection.setEnabled(false);
  assert.equal(chat.invalidations, 1);
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(renderedLines(chat), ["answer"]);
});

void test("missing or non-boolean assistant isStreaming is a hard compatibility failure", () => {
  const chat = new FixtureContainer();
  chat.addChild(new FixtureToolExecution("read"));
  const diagnostics: string[] = [];
  const projection = projected(chat, fixtureRuntime, (message) => diagnostics.push(message));
  const assistant = new FixtureAssistant(assistantMessage([textPart("answer")]));
  chat.addChild(assistant);
  assert.deepEqual(renderedLines(chat), ["answer"]);

  // Pi's native updateContent keeps the component's current boolean; a malformed live value is not
  // an omitted argument and must fail the whole projection instead of keeping a stale state.
  Object.defineProperty(assistant, "isStreaming", {
    configurable: true,
    writable: true,
    value: "streaming",
  });
  assistant.updateContent(assistantMessage([textPart("answer again")]));
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0] ?? "", /isStreaming field is malformed/);
  assert.equal(Object.getOwnPropertyDescriptor(assistant, "updateContent"), undefined);
  assert.ok(renderedLines(chat).includes("[tool] read"));
  assert.ok(renderedLines(chat).includes("answer"));
  projection.detach();

  // A missing descriptor is equally terminal, whether it appears during classification or update.
  const missingChat = new FixtureContainer();
  const missingDiagnostics: string[] = [];
  const missingProjection = projected(missingChat, fixtureRuntime, (message) =>
    missingDiagnostics.push(message),
  );
  const broken = new FixtureAssistant(assistantMessage([textPart("broken")]));
  Reflect.deleteProperty(broken, "isStreaming");
  missingChat.addChild(broken);
  assert.equal(missingDiagnostics.length, 1);
  assert.match(missingDiagnostics[0] ?? "", /isStreaming field is missing/);
  assert.equal(Object.getOwnPropertyDescriptor(broken, "updateContent"), undefined);
  missingProjection.detach();
});

void test("a failing native refresh disables Calm, restores chrome, and refuses re-enabling", async () => {
  const chat = new FixtureContainer();
  const runtime: CalmChatRuntime = {
    ...fixtureRuntime,
    assistant: fixture<CalmChatRuntime["assistant"]>(FailingRefreshAssistant),
  };
  const { ui, pi, context } = calmHarness({
    runtime,
    tui: fakeTuiRoot(() => new runtime.container(), chat),
    preferences: { load: () => Promise.resolve(true), save: () => Promise.resolve() },
  });
  await start(pi, context);
  assert.ok(ui.statuses.get("calm") !== undefined, "Calm should attach");
  chat.addChild(new CountingRow("native-row"));
  const assistant = new FailingRefreshAssistant("native update failed");
  chat.addChild(assistant);
  assistant.updateContent(assistantMessage([textPart("answer")]), true);

  // Turning Calm off defers to the native refresh, which fails terminally exactly once.
  await command(pi, context);
  await delay(0);
  assert.ok(ui.notifications.some((message) => message.includes("Calm unavailable")));
  assert.equal(ui.statuses.get("calm"), undefined);
  assert.equal(ui.widgets.get("calm"), undefined);
  assert.equal(ui.workingVisible, true, "the working indicator is restored");
  assert.equal(assistant.attempts, 1);
  assert.ok(renderedLines(chat).includes("native-row"), "native presentation is restored");

  // The terminal failure is not retried, and /calm refuses to claim filtering again.
  await command(pi, context);
  assert.ok(ui.notifications.some((message) => message.includes("Calm is unavailable")));
  assert.equal(assistant.attempts, 1);
  await shutdown(pi, context);
});

void test("direct children.splice bypass stays native-only", () => {
  const chat = new FixtureContainer();
  const projection = projected(chat);
  const bypassed = new CountingRow("bypassed-row");
  // Pi's streaming custom-entry splice similarly bypasses the lifecycle seams after attachment.
  chat.children.push(bypassed);
  try {
    assert.deepEqual(renderedLines(chat), []);
    assert.equal(bypassed.renders, 0);
  } finally {
    projection.detach();
  }
  assert.deepEqual(renderedLines(chat), ["bypassed-row"]);
});

void test("detach restores only seams this adapter still owns", () => {
  const chat = new FixtureContainer();
  chat.addChild(new FixtureUser("hello"));
  const warnings: string[] = [];
  const projection = projected(
    chat,
    fixtureRuntime,
    () => {},
    (message) => warnings.push(message),
  );
  let foreignRenders = 0;
  const foreignRender = (): string[] => {
    foreignRenders += 1;
    return ["foreign"];
  };
  // SAFETY: The live chat instance exposes `render`; this names it for deliberate replacement.
  const overridable = chat as RenderOverridable;
  overridable.render = foreignRender;
  projection.detach();
  assert.equal(Object.getOwnPropertyDescriptor(chat, "render")?.value, foreignRender);
  assert.equal(foreignRenders, 0);
  assert.ok(warnings.some((message) => message.includes("render seam changed")));
  assert.equal(renderedLines(chat).join("\n"), "foreign");
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
  assert.equal(isCoordinatorScope({ PI_WORKGRAPH_MODE: "" }), true);
  assert.equal(isCoordinatorScope({ PI_WORKGRAPH_MODE: "implementation" }), false);
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
