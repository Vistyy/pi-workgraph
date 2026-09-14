import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container } from "@earendil-works/pi-tui";
import type { CalmChatRuntime } from "../../src/calm/pi-runtime.js";
import { attachCalmProjection, type CalmProjection } from "../../src/calm/projection.js";

/**
 * Presentation fixtures and assertions shared by the Calm test suites.
 *
 * The fixture classes deliberately do not extend Pi's public message components, only the shared
 * Container. Classification must therefore go through the runtime-loaded classes: if the adapter
 * used a statically imported public class, every fixture row would be dropped. The
 * `Symbol.hasInstance` counters also make per-frame classification observable without a test-only
 * production counter.
 */

// SAFETY: These fixtures intentionally brand and inspect presentation instances to exercise the
// guarded compatibility boundary without Pi's public class identities.
// oxlint-disable anti-slop/no-object-parameters, anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion, typescript/unbound-method

export type ContentPart = AssistantMessage["content"][number];
export type FakeMouseEvent = {
  readonly y: number;
  readonly height: number;
  readonly width: number;
};

export function textPart(value: string): ContentPart {
  return { type: "text", text: value };
}

export function thinkingPart(value: string): ContentPart {
  return { type: "thinking", thinking: value };
}

export function toolCallPart(name: string): ContentPart {
  return { type: "toolCall", id: "call-1", name, arguments: {} };
}

export function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "fixture",
    model: "fixture-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

const KIND = Symbol("calm-fixture-kind");

function brand(value: object, kind: string): void {
  Object.defineProperty(value, KIND, { configurable: true, value: kind });
}

function isBranded(value: unknown, kind: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  return Object.getOwnPropertyDescriptor(value, KIND)?.value === kind;
}

export class FixtureContainer extends Container {
  handleMouse(event: FakeMouseEvent): FakeMouseEvent | undefined {
    if (event.y < 0 || event.y >= event.height) return undefined;
    let childY = 0;
    for (const child of this.children) {
      const height = child.render(event.width).length;
      if (event.y >= childY && event.y < childY + height) {
        const handler = (
          child as { handleMouse?(event: FakeMouseEvent): FakeMouseEvent | undefined }
        ).handleMouse;
        return handler?.call(child, { ...event, y: event.y - childY, height });
      }
      childY += height;
    }
    return undefined;
  }
}

export class FixtureAssistant extends FixtureContainer {
  static checks = 0;
  static instances: FixtureAssistant[] = [];

  static override [Symbol.hasInstance](value: unknown): boolean {
    FixtureAssistant.checks += 1;
    return isBranded(value, "assistant");
  }

  lastMessage: AssistantMessage | undefined = undefined;
  isStreaming = false;
  markdownTheme: unknown = undefined;
  hiddenThinkingLabel = "Thinking...";
  outputPad = 1;
  markdownTransformers: readonly unknown[] = [];
  updates = 0;
  invalidations = 0;

  constructor(message?: AssistantMessage) {
    super();
    brand(this, "assistant");
    FixtureAssistant.instances.push(this);
    if (message !== undefined) this.updateContent(message);
  }

  // Mirrors Pi's native default: an omitted streaming argument keeps the component's current state.
  updateContent(message: AssistantMessage, isStreaming: boolean = this.isStreaming): void {
    this.updates += 1;
    this.lastMessage = message;
    this.isStreaming = isStreaming;
    this.clear();
    for (const part of message.content) {
      if (part.type === "text" && part.text.trim() !== "")
        this.addChild(new FixtureText(part.text));
      else if (part.type === "thinking" && part.thinking.trim() !== "")
        this.addChild(new FixtureText(part.thinking));
    }
    const notice = terminalNotice(message);
    if (notice !== undefined) this.addChild(new FixtureText(notice));
  }

  override invalidate(): void {
    this.invalidations += 1;
    super.invalidate();
  }
}

export class FixtureUser extends FixtureContainer {
  static checks = 0;

  static override [Symbol.hasInstance](value: unknown): boolean {
    FixtureUser.checks += 1;
    return isBranded(value, "user");
  }

  invalidations = 0;
  readonly text: string;

  constructor(text: string) {
    super();
    brand(this, "user");
    this.text = text;
  }

  override render(_width: number): string[] {
    return [this.text];
  }

  override invalidate(): void {
    this.invalidations += 1;
    super.invalidate();
  }
}

export interface SkillBlockFixture {
  readonly name: string;
  readonly location: string;
  readonly content: string;
  readonly userMessage: string | undefined;
}

export interface CustomMessageFixture {
  readonly customType: string;
  readonly content: string;
}

export class FixtureToolExecution extends FixtureContainer {
  static checks = 0;

  static override [Symbol.hasInstance](value: unknown): boolean {
    FixtureToolExecution.checks += 1;
    return isBranded(value, "tool");
  }

  renders = 0;
  clicks = 0;
  readonly toolName: string;

  constructor(toolName = "read") {
    super();
    brand(this, "tool");
    this.toolName = toolName;
  }

  override render(): string[] {
    this.renders += 1;
    return [`[tool] ${this.toolName}`];
  }

  override handleMouse(): undefined {
    this.clicks += 1;
    return undefined;
  }

  override invalidate(): void {}
}

export class FixtureCustomMessage extends FixtureContainer {
  static checks = 0;

  static override [Symbol.hasInstance](value: unknown): boolean {
    FixtureCustomMessage.checks += 1;
    return isBranded(value, "custom");
  }

  renders = 0;
  readonly message: CustomMessageFixture;

  constructor(message: CustomMessageFixture) {
    super();
    brand(this, "custom");
    this.message = message;
  }

  override render(): string[] {
    this.renders += 1;
    return [`[${this.message.customType}] ${this.message.content}`];
  }

  override invalidate(): void {}
}

export class FixtureSkill extends FixtureContainer {
  static checks = 0;

  static override [Symbol.hasInstance](value: unknown): boolean {
    FixtureSkill.checks += 1;
    return isBranded(value, "skill");
  }

  readonly skillBlock: SkillBlockFixture;

  constructor(skillBlock: SkillBlockFixture) {
    super();
    brand(this, "skill");
    this.skillBlock = skillBlock;
  }

  override render(_width: number): string[] {
    return [`[skill] ${this.skillBlock.name}`];
  }
}

/** Mirror Pi's terminal notice rules so projection visibility is observable through rendering. */
function terminalNotice(message: AssistantMessage): string | undefined {
  const hasToolCalls = message.content.some((part) => part.type === "toolCall");
  if (message.stopReason === "length") return "Response was truncated before completion.";
  if (hasToolCalls) return undefined;
  if (message.stopReason === "aborted")
    return message.errorMessage !== undefined && message.errorMessage !== "Request was aborted"
      ? message.errorMessage
      : "Operation aborted";
  if (message.stopReason === "error") return `Error: ${message.errorMessage ?? "Unknown error"}`;
  return undefined;
}

export class FixtureText implements Component {
  renders = 0;
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  render(): string[] {
    this.renders += 1;
    return [this.#text];
  }

  invalidate(): void {}
}

export const fixtureRuntime = {
  assistant: FixtureAssistant,
  user: FixtureUser,
  skill: FixtureSkill,
  toolExecution: FixtureToolExecution,
  customMessage: FixtureCustomMessage,
  container: FixtureContainer,
} as unknown as CalmChatRuntime;

export function customMessage(customType: string, content = "payload"): CustomMessageFixture {
  return { customType, content };
}

export function skillBlock(name: string, userMessage?: string): SkillBlockFixture {
  return { name, location: `/skills/${name}.md`, content: "INJECTED-SKILL-CONTENT", userMessage };
}

export function strip(value: string): string {
  return stripVTControlCharacters(value);
}

export function renderedLines(
  component: { render(width: number): string[] },
  width = 80,
): string[] {
  return component
    .render(width)
    .map((line) => strip(line).trim())
    .filter((line) => line !== "");
}

export function projected(
  chat: Container,
  runtime: CalmChatRuntime = fixtureRuntime,
  onIncompatible: (message: string) => void = () => {},
): CalmProjection {
  const projection = attachCalmProjection(chat, {
    runtime,
    styleSeparator: (text) => text,
    onIncompatible,
  });
  projection.setEnabled(true);
  return projection;
}

export function constructSkill(runtime: CalmChatRuntime, block: SkillBlockFixture): Component {
  const Skill = runtime.skill as unknown as new (skillBlock: SkillBlockFixture) => Component;
  return new Skill(block);
}

export function classificationChecks(): number {
  return (
    FixtureUser.checks +
    FixtureSkill.checks +
    FixtureAssistant.checks +
    FixtureToolExecution.checks +
    FixtureCustomMessage.checks
  );
}
