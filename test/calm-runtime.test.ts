import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The installed-Pi locator inspects real host symlinks and files.
import { existsSync, realpathSync } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The disposable bundle fixture uses real temporary host files.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The installed-Pi locator resolves real host bundle paths.
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { type Container, Text } from "@earendil-works/pi-tui";

import { discoverCalmChat } from "../src/calm-projection.js";
import { loadCalmChatRuntime } from "../src/pi-chat-runtime.js";
import {
  assistantMessage,
  constructSkill,
  customMessage,
  type FakeMouseEvent,
  projected,
  renderedLines,
  skillBlock,
  textPart,
  toolCallPart,
} from "./calm-fixture.js";
import { calmHarness, command, fakeTuiRoot, shutdown, start } from "./calm-harness.js";

/**
 * The compatibility boundary must load the classes the running Pi actually instantiates. The first
 * suite drives that loader through real module discovery in a disposable bundle layout; the second
 * runs the same adapter against the installed Pi 0.85.1 bundle when one is discoverable.
 */

interface CalmMouseContainer extends Container {
  handleMouse(event: FakeMouseEvent): boolean | undefined;
}

interface StubUi {
  requestRender(): void;
}

interface ToolExecutionArgs {
  readonly path?: string;
}
interface ToolExecutionOptions {
  readonly showImages?: boolean;
  readonly imageWidthCells?: number;
}
interface ToolRenderers {
  readonly renderShell?: "default" | "self";
}
interface CustomMessageLike {
  readonly customType: string;
  readonly content: string;
}
interface TruncationResult {
  readonly truncated?: boolean;
}

interface ToolExecutionCtor {
  new (
    toolName: string,
    toolCallId: string,
    args: ToolExecutionArgs,
    options: ToolExecutionOptions | undefined,
    toolDefinition: ToolRenderers | undefined,
    ui: StubUi,
    cwd: string,
  ): Container & { render(width: number): string[] };
}

interface CustomMessageCtor {
  new (message: CustomMessageLike): Container & { render(width: number): string[] };
}

interface BashExecutionCtor {
  new (
    command: string,
    ui: StubUi,
    excludeFromContext?: boolean,
  ): Container & {
    render(width: number): string[];
    setComplete(
      exitCode: number,
      cancelled: boolean,
      truncationResult: TruncationResult | undefined,
      fullOutputPath: string | undefined,
    ): void;
  };
}

async function writeBundleFixture(root: string, withIndex: boolean): Promise<string> {
  const chunks = join(root, "chunks");
  await mkdir(chunks, { recursive: true });
  const fixtureUrl = pathToFileURL(join(import.meta.dirname, "calm-fixture.ts")).href;
  await writeFile(
    join(chunks, "chunk-fixture.js"),
    `export { FixtureAssistant as AssistantMessageComponent, FixtureUser as UserMessageComponent, FixtureSkill as SkillInvocationMessageComponent, FixtureToolExecution as ToolExecutionComponent, FixtureCustomMessage as CustomMessageComponent } from ${JSON.stringify(fixtureUrl)};\n`,
  );
  const cli = join(root, "cli.js");
  await writeFile(cli, "export const main = () => {};\n");
  if (withIndex)
    await writeFile(join(root, "index.js"), 'export * from "./chunks/chunk-fixture.js";\n');
  return cli;
}

void test("loader reads the running bundle module and its distinct class identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "calm-bundle-"));
  try {
    const publicPi = await import("@earendil-works/pi-coding-agent");
    const publicTui = await import("@earendil-works/pi-tui");
    for (const withIndex of [true, false]) {
      const cli = await writeBundleFixture(
        join(root, withIndex ? "indexed" : "chunked"),
        withIndex,
      );
      const runtime = await loadCalmChatRuntime(cli);
      // Loading the *running* module must not alias the statically imported public classes.
      assert.notEqual(runtime.assistant, publicPi.AssistantMessageComponent);
      assert.notEqual(runtime.user, publicPi.UserMessageComponent);
      assert.notEqual(runtime.skill, publicPi.SkillInvocationMessageComponent);
      assert.notEqual(runtime.toolExecution, publicPi.ToolExecutionComponent);
      assert.notEqual(runtime.customMessage, publicPi.CustomMessageComponent);
      assert.notEqual(runtime.container, publicTui.Container);
      assert.equal(Object.getPrototypeOf(runtime.assistant.prototype), runtime.container.prototype);

      const chat = new runtime.container();
      const tui = fakeTuiRoot(() => new runtime.container(), chat);
      assert.equal(discoverCalmChat(tui, runtime), chat);
      const projection = projected(chat, runtime);
      try {
        chat.addChild(new runtime.user("hello"));
        const assistant = new runtime.assistant();
        chat.addChild(assistant);
        assistant.updateContent(assistantMessage([textPart("answer")]), true);
        chat.addChild(constructSkill(runtime, skillBlock("calm")));
        assert.deepEqual(renderedLines(chat), ["hello", "answer", "/skill:calm"]);
        assert.doesNotMatch(renderedLines(chat).join("\n"), /INJECTED-SKILL-CONTENT|\[skill\]/);
      } finally {
        projection.detach();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function installedPiInDirectory(directory: string): string | undefined {
  const binary = join(directory, "pi");
  if (!existsSync(binary)) return undefined;
  let real: string;
  try {
    real = realpathSync(binary);
  } catch {
    return undefined;
  }
  if (real.endsWith(".js")) return real;
  const layouts = [
    join(dirname(real), "..", "lib", "node_modules", "pi-monorepo", "dist", "bundle", "cli.js"),
    join(dirname(real), "..", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
    join(dirname(real), "..", "pi-coding-agent", "dist", "bundle", "cli.js"),
  ];
  return layouts.find((layout) => existsSync(layout));
}

function locateInstalledPiEntrypoint(): string | undefined {
  const { PI_WORKGRAPH_PI_ENTRYPOINT: configured, PATH: path = "" } = process.env;
  if (configured !== undefined && existsSync(configured)) return configured;
  const candidates: string[] = [];
  for (const directory of path.split(":")) {
    const found = installedPiInDirectory(directory);
    if (found !== undefined && !candidates.includes(found)) candidates.push(found);
  }
  // Prefer the installed CLI over the checkout's own dev dependency, which `pnpm` puts first.
  const checkoutModules = join(dirname(import.meta.dirname), "node_modules");
  return candidates.find((candidate) => !candidate.startsWith(checkoutModules)) ?? candidates[0];
}

const installedEntrypoint = locateInstalledPiEntrypoint();

void test("classifies the real installed Pi bundle classes through capture, discovery, and detach", {
  skip: installedEntrypoint === undefined ? "no installed Pi entrypoint on PATH" : false,
}, async () => {
  initTheme("dark", false);
  const runtime = await loadCalmChatRuntime(installedEntrypoint);
  const publicPi = await import("@earendil-works/pi-coding-agent");
  const publicTui = await import("@earendil-works/pi-tui");
  assert.notEqual(runtime.assistant, publicPi.AssistantMessageComponent);
  assert.notEqual(runtime.user, publicPi.UserMessageComponent);
  assert.notEqual(runtime.skill, publicPi.SkillInvocationMessageComponent);
  assert.notEqual(runtime.container, publicTui.Container);
  assert.equal(Object.getPrototypeOf(runtime.assistant.prototype), runtime.container.prototype);

  const chat = new runtime.container();
  const tui = fakeTuiRoot(() => new runtime.container(), chat);
  const { ui, pi, context } = calmHarness({
    runtime,
    tui,
    preferences: { load: () => Promise.resolve(true), save: () => Promise.resolve() },
  });
  await start(pi, context);
  assert.ok(ui.statuses.get("calm") !== undefined, "Calm should attach through widget capture");
  assert.equal(discoverCalmChat(tui, runtime), chat);

  chat.addChild(new runtime.user("hello there"));
  const assistant = new runtime.assistant();
  chat.addChild(assistant);
  assistant.updateContent(assistantMessage([textPart("streamed answer")]), true);
  assert.ok(renderedLines(chat).some((line) => line.includes("streamed answer")));
  // Calm-on must not build the hidden native assistant for deltas...
  assert.equal(assistant.render(80).length, 0);
  // ...including an identical-prose finalization that only changes streaming state.
  assistant.updateContent(assistantMessage([textPart("streamed answer")]), false);
  assert.ok(renderedLines(chat).some((line) => line.includes("streamed answer")));
  assert.equal(assistant.render(80).length, 0);

  // Skill-only keeps a compact line; a real skill+user pairing hides the injected details.
  chat.addChild(constructSkill(runtime, skillBlock("calm")));
  assert.ok(renderedLines(chat).some((line) => line.includes("/skill:calm")));
  chat.addChild(constructSkill(runtime, skillBlock("calm", "do the thing")));
  chat.addChild(new runtime.user("do the thing"));
  assert.doesNotMatch(renderedLines(chat).join("\n"), /INJECTED-SKILL-CONTENT|\[skill\]/);

  // Projection invalidation follows native chat invalidation and keeps the copy renderable.
  chat.invalidate();
  assert.ok(renderedLines(chat).some((line) => line.includes("streamed answer")));

  // Mouse dispatch is delegated to the projected children while Calm is on.
  class CountingUser extends runtime.user {
    clicks = 0;

    handleMouse(): undefined {
      this.clicks += 1;
      return undefined;
    }
  }
  const counting = new CountingUser("click me");
  chat.addChild(counting);
  const width = 60;
  const height = chat.render(width).length;
  // SAFETY: The live 0.85.1 Container exposes `handleMouse`; the pinned dev type predates it.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The public dev Container type lacks the mouse member the live instance has.
  const mouseChat = chat as unknown as CalmMouseContainer;
  assert.ok("handleMouse" in mouseChat);
  mouseChat.handleMouse({ y: height - 1, width, height });
  assert.equal(counting.clicks, 1);

  // A classification incompatibility detaches everything and makes /calm refuse re-enabling.
  chat.addChild(constructSkill(runtime, skillBlock("")));
  await delay(0);
  assert.ok(ui.notifications.some((message) => message.includes("Calm unavailable")));
  assert.equal(ui.statuses.get("calm"), undefined);
  assert.equal(ui.widgets.get("calm"), undefined);
  assert.equal(ui.workingVisible, true);
  assert.ok(
    renderedLines(chat).some((line) => line.includes("streamed answer")),
    "native presentation should be restored after failure",
  );
  await command(pi, context);
  assert.ok(
    ui.notifications.some((message) => message.includes("Calm is unavailable")),
    "/calm must refuse rather than claim success",
  );
  await shutdown(pi, context);
});

// SAFETY: Pi's pinned public type marks its presentation state private; the live 0.85.1 component
// stores it as a public instance field, which this reflection probe reads without a cast.
const streamingOf = (component: AssistantMessageComponent): boolean =>
  Object.getOwnPropertyDescriptor(component, "isStreaming")?.value === true;

const installedRuntimeTest = (name: string, body: () => Promise<void>): void =>
  void test(
    name,
    {
      skip: installedEntrypoint === undefined ? "no installed Pi entrypoint on PATH" : false,
    },
    body,
  );

installedRuntimeTest(
  "real 0.85.1 assistant keeps streaming context for one-argument updateContent",
  async () => {
    initTheme("dark", false);
    const runtime = await loadCalmChatRuntime(installedEntrypoint);
    const markStreaming = (markdown: string, context: { isStreaming?: boolean }): string =>
      `${markdown} ${context.isStreaming === true ? "S1" : "S0"}`;

    // A native control assistant runs the same calls without any Calm wrapper.
    const control = new runtime.assistant();
    Reflect.set(control, "markdownTransformers", [markStreaming]);
    control.updateContent(assistantMessage([textPart("streamed")]), true);
    control.updateContent(assistantMessage([textPart("streamed further")]));
    control.setOutputPad(3);
    control.setHiddenThinkingLabel("Working...");
    control.setHideThinkingBlock(true);
    assert.equal(
      streamingOf(control),
      true,
      "the control keeps streaming across one-argument calls",
    );

    const chat = new runtime.container();
    const projection = projected(chat, runtime);
    try {
      const assistant = new runtime.assistant();
      Reflect.set(assistant, "markdownTransformers", [markStreaming]);
      chat.addChild(assistant);
      assistant.updateContent(assistantMessage([textPart("streamed")]), true);
      assert.equal(streamingOf(assistant), true);

      // Pi's setters and invalidate rebuild through updateContent(message) with streaming omitted.
      assistant.updateContent(assistantMessage([textPart("streamed further")]));
      assert.equal(
        streamingOf(assistant),
        true,
        "omitted streaming resolves from the source state",
      );
      assistant.setOutputPad(3);
      assert.equal(streamingOf(assistant), true);
      assistant.setHiddenThinkingLabel("Working...");
      assert.equal(streamingOf(assistant), true);
      assistant.setHideThinkingBlock(true);
      assert.equal(streamingOf(assistant), true);

      // The projected copy must match the native control's rendering, including transformer context.
      assert.deepEqual(chat.render(80), control.render(80));

      // Switching off restores the exact native state the control reports.
      projection.setEnabled(false);
      assert.equal(streamingOf(assistant), true);
      assert.deepEqual(chat.render(80), control.render(80));
    } finally {
      projection.detach();
    }
  },
);

installedRuntimeTest(
  "real 0.85.1 Calm-on invalidation refreshes only the displayed projection",
  async () => {
    initTheme("dark", false);
    const runtime = await loadCalmChatRuntime(installedEntrypoint);
    class CountingAssistant extends runtime.assistant {
      invalidations = 0;

      override invalidate(): void {
        this.invalidations += 1;
        super.invalidate();
      }
    }
    class CountingUser extends runtime.user {
      invalidations = 0;

      override invalidate(): void {
        this.invalidations += 1;
        super.invalidate();
      }
    }

    const chat = new runtime.container();
    const user = new CountingUser("hello");
    const first = new CountingAssistant();
    const second = new CountingAssistant();
    chat.addChild(user);
    chat.addChild(first);
    chat.addChild(second);
    first.updateContent(assistantMessage([textPart("first")]), false);
    second.updateContent(assistantMessage([textPart("second")]), false);
    const projection = projected(chat, runtime);
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
  },
);

installedRuntimeTest(
  "real 0.85.1 native refresh failure releases every adapter-owned wrapper",
  async () => {
    initTheme("dark", false);
    const runtime = await loadCalmChatRuntime(installedEntrypoint);
    class FailingAssistant extends runtime.assistant {
      attempts = 0;

      override updateContent(_message: AssistantMessage, _isStreaming?: boolean): void {
        this.attempts += 1;
        throw new Error("native assistant update failed");
      }
    }

    const chat = new runtime.container();
    const diagnostics: string[] = [];
    const projection = projected(chat, runtime, (message) => diagnostics.push(message));
    try {
      const assistant = new FailingAssistant();
      chat.addChild(assistant);
      assistant.updateContent(assistantMessage([textPart("streamed answer")]), true);
      assert.equal(assistant.attempts, 0, "Calm-on must not rebuild the hidden native assistant");

      projection.setEnabled(false);
      // The failing refresh is attempted exactly once and never retried by the terminal cleanup.
      assert.equal(assistant.attempts, 1);
      assert.equal(Object.getOwnPropertyDescriptor(assistant, "updateContent"), undefined);
      assert.equal(Object.getOwnPropertyDescriptor(chat, "render"), undefined);
      assert.equal(diagnostics.length, 1);
      assert.match(diagnostics[0] ?? "", /native assistant update failed/);
      // The attachment is terminal; Calm cannot claim filtering after native restoration failed.
      projection.setEnabled(true);
      assert.equal(assistant.attempts, 1);
    } finally {
      projection.detach();
    }
  },
);

installedRuntimeTest(
  "real 0.85.1 missing assistant isStreaming returns to native presentation",
  async () => {
    initTheme("dark", false);
    const runtime = await loadCalmChatRuntime(installedEntrypoint);
    const chat = new runtime.container();
    const assistant = new runtime.assistant();
    chat.addChild(assistant);
    assistant.updateContent(assistantMessage([textPart("answer")]), false);
    const diagnostics: string[] = [];
    const projection = projected(chat, runtime, (message) => diagnostics.push(message));
    try {
      assert.ok(renderedLines(chat).some((line) => line.includes("answer")));

      // A missing live field is a hard compatibility failure, not an omitted streaming argument.
      Reflect.deleteProperty(assistant, "isStreaming");
      assistant.updateContent(assistantMessage([textPart("answer again")]));
      assert.equal(diagnostics.length, 1);
      assert.match(diagnostics[0] ?? "", /isStreaming field is missing/);
      assert.equal(Object.getOwnPropertyDescriptor(assistant, "updateContent"), undefined);
      assert.ok(renderedLines(chat).some((line) => line.includes("answer")));
    } finally {
      projection.detach();
    }
  },
);

installedRuntimeTest(
  "real 0.85.1 keeps native feedback visible and terminal notices after filtering",
  async () => {
    initTheme("dark", false);
    const entrypoint = installedEntrypoint;
    if (entrypoint === undefined) return;
    const runtime = await loadCalmChatRuntime(entrypoint);
    // SAFETY: This is the bundle module already validated by the runtime loader.
    const bundle = (await import(pathToFileURL(join(dirname(entrypoint), "index.js")).href)) as {
      readonly BashExecutionComponent: BashExecutionCtor;
    };
    // SAFETY: The runtime decoder validated this exact live constructor.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Runtime types it only for identity checks.
    const ToolExecution = runtime.toolExecution as unknown as ToolExecutionCtor;
    // SAFETY: The runtime decoder validated this exact live constructor.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Runtime types it only for identity checks.
    const CustomMessage = runtime.customMessage as unknown as CustomMessageCtor;
    const stubUi = { requestRender: () => {} };

    const chat = new runtime.container();
    const projection = projected(chat, runtime);
    try {
      const bash = new bundle.BashExecutionComponent("echo hi", stubUi, false);
      bash.setComplete(0, false, undefined, undefined);
      chat.addChild(new Text("warning: cache miss", 0, 0));
      chat.addChild(bash);
      chat.addChild(new Text("future-native-widget", 0, 0));
      chat.addChild(new CustomMessage(customMessage("pi-lavish-report", "report body")));
      chat.addChild(new CustomMessage(customMessage("pi-workgraph-workstream", "hidden")));
      const hiddenTool = new ToolExecution(
        "fixture-hidden-tool",
        "call-1",
        {},
        undefined,
        undefined,
        stubUi,
        "/tmp",
      );
      chat.addChild(hiddenTool);

      const lines = renderedLines(chat).join("\n");
      assert.match(lines, /warning: cache miss/);
      assert.match(lines, /\$ echo hi/);
      assert.match(lines, /future-native-widget/);
      assert.match(lines, /\[pi-lavish-report\]/);
      assert.match(lines, /report body/);
      assert.doesNotMatch(lines, /pi-workgraph-workstream/);
      assert.doesNotMatch(lines, /fixture-hidden-tool/);

      const interrupted = new runtime.assistant();
      chat.addChild(interrupted);
      interrupted.updateContent(
        { ...assistantMessage([toolCallPart("read")]), stopReason: "aborted" },
        false,
      );
      assert.match(renderedLines(chat).join("\n"), /Operation aborted/);

      // Hiding is Calm's own effect: native rendering restores the tool row and Pi's native rule
      // that suppresses the aborted notice when the source carried tool calls.
      projection.setEnabled(false);
      const native = renderedLines(chat).join("\n");
      assert.match(native, /fixture-hidden-tool/);
      assert.match(native, /\[pi-workgraph-workstream\]/);
      assert.doesNotMatch(native, /Operation aborted/);
      projection.setEnabled(true);
    } finally {
      projection.detach();
    }

    const adjacency = new runtime.container();
    const adjacencyProjection = projected(adjacency, runtime);
    try {
      adjacency.addChild(new runtime.assistant(assistantMessage([textPart("a")])));
      adjacency.addChild(
        new ToolExecution("adjacency-tool", "call-2", {}, undefined, undefined, stubUi, "/tmp"),
      );
      adjacency.addChild(new runtime.assistant(assistantMessage([textPart("b")])));
      assert.deepEqual(renderedLines(adjacency), ["a", "---", "b"]);

      adjacency.addChild(new CustomMessage(customMessage("pi-lavish-report", "note")));
      adjacency.addChild(new runtime.assistant(assistantMessage([textPart("c")])));
      assert.deepEqual(renderedLines(adjacency), [
        "a",
        "---",
        "b",
        "[pi-lavish-report]",
        "note",
        "c",
      ]);
    } finally {
      adjacencyProjection.detach();
    }
  },
);
