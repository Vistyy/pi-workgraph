import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { type AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadCalmChatRuntime } from "../../src/calm/pi-runtime.js";
import { discoverCalmChat } from "../../src/calm/projection.js";
import {
  assistantMessage,
  constructSkill,
  customMessage,
  projected,
  renderedLines,
  skillBlock,
  textPart,
  toolCallPart,
} from "./fixture.js";
import { fakeTuiRoot } from "./harness.js";

interface StubUi {
  requestRender(): void;
}

interface ToolExecutionArgs {
  readonly path?: string;
}

interface ToolExecutionOptions {
  readonly showImages?: boolean;
}

interface ToolDefinition {
  readonly renderShell?: "default" | "self";
}

interface ToolExecutionCtor {
  new (
    toolName: string,
    toolCallId: string,
    args: ToolExecutionArgs,
    options: ToolExecutionOptions | undefined,
    toolDefinition: ToolDefinition | undefined,
    ui: StubUi,
    cwd: string,
  ): Text;
}

interface CustomMessageCtor {
  new (message: { readonly customType: string; readonly content: string }): Text;
}

interface BashExecutionCtor {
  new (
    command: string,
    ui: StubUi,
    excludeFromContext?: boolean,
  ): Text & {
    setComplete(
      exitCode: number,
      cancelled: boolean,
      truncationResult: { readonly truncated?: boolean } | undefined,
      fullOutputPath: string | undefined,
    ): void;
  };
}

async function writeBundleFixture(root: string, withIndex: boolean): Promise<string> {
  const chunks = join(root, "chunks");
  await mkdir(chunks, { recursive: true });
  const fixtureUrl = pathToFileURL(join(import.meta.dirname, "fixture.ts")).href;
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

void test("loader uses the running bundle's class identities", async () => {
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
      assert.notEqual(runtime.assistant, publicPi.AssistantMessageComponent);
      assert.notEqual(runtime.container, publicTui.Container);
      assert.equal(Object.getPrototypeOf(runtime.assistant.prototype), runtime.container.prototype);

      const chat = new runtime.container();
      assert.equal(
        discoverCalmChat(
          fakeTuiRoot(() => new runtime.container(), chat),
          runtime,
        ),
        chat,
      );
      const projection = projected(chat, runtime);

      try {
        chat.addChild(new runtime.user("hello"));
        const assistant = new runtime.assistant();
        chat.addChild(assistant);
        assistant.updateContent(assistantMessage([textPart("answer")]), true);
        chat.addChild(constructSkill(runtime, skillBlock("calm")));
        assert.deepEqual(renderedLines(chat), ["hello", "answer", "/skill:calm"]);
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

  const checkoutModules = join(import.meta.dirname, "..", "..", "node_modules");

  return candidates.find((candidate) => candidate.startsWith(checkoutModules)) ?? candidates[0];
}

const installedEntrypoint = locateInstalledPiEntrypoint();

const installedRuntimeTest = (name: string, body: () => Promise<void>): void =>
  void test(
    name,
    { skip: installedEntrypoint === undefined ? "no installed Pi entrypoint on PATH" : false },
    body,
  );

const streamingOf = (component: AssistantMessageComponent): boolean =>
  Object.getOwnPropertyDescriptor(component, "isStreaming")?.value === true;

installedRuntimeTest(
  "installed Pi projects current rows and restores native rendering",
  async () => {
    initTheme("dark", false);
    const runtime = await loadCalmChatRuntime(installedEntrypoint);
    const publicPi = await import("@earendil-works/pi-coding-agent");
    assert.notEqual(runtime.assistant, publicPi.AssistantMessageComponent);

    const stubUi = { requestRender: () => {} };
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Runtime classes need constructor signatures for this flow.
    const ToolExecution = runtime.toolExecution as unknown as ToolExecutionCtor;
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Runtime classes need constructor signatures for this flow.
    const CustomMessage = runtime.customMessage as unknown as CustomMessageCtor;
    const chat = new runtime.container();
    const projection = projected(chat, runtime);

    try {
      chat.addChild(new runtime.user("hello"));
      const assistant = new runtime.assistant();
      chat.addChild(assistant);
      assistant.updateContent(assistantMessage([textPart("streamed")]), true);
      chat.children.splice(0, 0, new Text("direct splice", 0, 0));
      chat.addChild(new CustomMessage(customMessage("pi-workgraph-outcome", "hidden")));
      chat.addChild(new CustomMessage(customMessage("pi-workgraph-unknown", "visible")));
      chat.addChild(
        new ToolExecution("hidden-tool", "call-1", {}, undefined, undefined, stubUi, "/tmp"),
      );
      assert.match(renderedLines(chat).join("\n"), /direct splice/);
      assert.match(renderedLines(chat).join("\n"), /pi-workgraph-unknown/);
      assert.doesNotMatch(renderedLines(chat).join("\n"), /pi-workgraph-outcome|hidden-tool/);
      chat.invalidate();
      assert.match(renderedLines(chat).join("\n"), /streamed/);

      projection.setEnabled(false);
      const native = renderedLines(chat).join("\n");
      assert.match(native, /pi-workgraph-outcome|hidden-tool/);
    } finally {
      projection.detach();
    }
  },
);

installedRuntimeTest(
  "installed Pi streaming and markdown transforms remain byte-equivalent",
  async () => {
    initTheme("dark", false);
    const runtime = await loadCalmChatRuntime(installedEntrypoint);

    const markStreaming = (markdown: string, context: { isStreaming?: boolean }): string =>
      `${markdown} ${context.isStreaming === true ? "S1" : "S0"}`;

    const message = assistantMessage([textPart("streamed further")]);

    const control = new runtime.assistant();
    Reflect.set(control, "markdownTransformers", [markStreaming]);
    control.updateContent(assistantMessage([textPart("streamed")]), true);
    control.updateContent(message);
    control.setOutputPad(3);
    control.setHiddenThinkingLabel("Working...");
    control.setHideThinkingBlock(true);

    const chat = new runtime.container();
    const projection = projected(chat, runtime);

    try {
      const assistant = new runtime.assistant();
      Reflect.set(assistant, "markdownTransformers", [markStreaming]);
      chat.addChild(assistant);
      assistant.updateContent(assistantMessage([textPart("streamed")]), true);
      assistant.updateContent(message);
      assistant.setOutputPad(3);
      assistant.setHiddenThinkingLabel("Working...");
      assistant.setHideThinkingBlock(true);
      assert.equal(streamingOf(assistant), true);
      assert.deepEqual(chat.render(80), control.render(80));
      projection.setEnabled(false);
      assert.deepEqual(chat.render(80), control.render(80));
    } finally {
      projection.detach();
    }
  },
);

installedRuntimeTest(
  "installed Pi passes native feedback and preserves terminal notices",
  async () => {
    initTheme("dark", false);
    const entrypoint = installedEntrypoint;

    if (entrypoint === undefined) return;
    const runtime = await loadCalmChatRuntime(entrypoint);

    const bundle = (await import(pathToFileURL(join(dirname(entrypoint), "index.js")).href)) as {
      readonly BashExecutionComponent: BashExecutionCtor;
    };

    const stubUi = { requestRender: () => {} };
    const chat = new runtime.container();
    const projection = projected(chat, runtime);

    try {
      const bash = new bundle.BashExecutionComponent("echo hi", stubUi, false);
      bash.setComplete(0, false, undefined, undefined);
      chat.addChild(new Text("warning: cache miss", 0, 0));
      chat.addChild(bash);
      const interrupted = new runtime.assistant();
      chat.addChild(interrupted);
      interrupted.updateContent(
        { ...assistantMessage([toolCallPart("read")]), stopReason: "aborted" },
        false,
      );
      const lines = renderedLines(chat).join("\n");
      assert.match(lines, /warning: cache miss/);
      assert.match(lines, /\$ echo hi/);
      assert.match(lines, /Operation aborted/);
    } finally {
      projection.detach();
    }
  },
);
