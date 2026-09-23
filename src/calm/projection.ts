import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AssistantMessageComponent,
  SkillInvocationMessageComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { Component, Container, TUI } from "@earendil-works/pi-tui";
import type { CalmChatRuntime, CalmComponentConstructor } from "./pi-runtime.js";

/**
 * Calm projects the current live Pi chat at render time. Native rows remain Pi-owned and untouched;
 * the adapter owns only the exact chat instance's render, invalidate, and mouse-dispatch seams.
 */

// oxlint-disable anti-slop/no-object-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns

const DOCUMENT_INDEX = 0;

const DOCUMENT_CHILD_COUNT = 3;

const CHAT_INDEX = 2;

const SEPARATOR = "---";

const EXCLUDED_CUSTOM_TYPE = "pi-workgraph-outcome";

const ATTACHED_CHATS = new WeakSet<Container>();

const ASSISTANT_PRESENTATION_FIELDS = [
  "markdownTheme",
  "outputPad",
  "markdownTransformers",
] as const;

type SeparatorStyle = (text: string) => string;

type Diagnostic = (message: string) => void;

type AssistantContentPart = AssistantMessage["content"][number];

type AssistantTextPart = Extract<AssistantContentPart, { readonly type: "text" }>;

type MouseEvent = Parameters<Container["handleMouse"]>[0];

type MouseResult = ReturnType<Container["handleMouse"]>;

interface NativeAssistantState {
  readonly message: AssistantMessage | undefined;
  readonly streaming: boolean;
}

interface AssistantSnapshot {
  readonly text: readonly string[];
  readonly stopReason: AssistantMessage["stopReason"];
  readonly errorMessage: string | undefined;
  readonly streaming: boolean;
  readonly presentation: readonly unknown[];
}

interface CachedAssistant {
  readonly projected: AssistantMessageComponent;
  snapshot: AssistantSnapshot | undefined;
}

interface SkillMetadata {
  readonly name: string;
  readonly paired: boolean;
}

interface OwnedSeam {
  readonly key: "render" | "invalidate" | "handleMouse";
  readonly installed: unknown;
  readonly original: PropertyDescriptor | undefined;
}

export interface CalmProjectionOptions {
  readonly runtime: CalmChatRuntime;
  readonly styleSeparator: SeparatorStyle;
  /** Report the one incompatibility that disables Calm and restores native presentation. */
  readonly onIncompatible: Diagnostic;
}

export interface CalmProjection {
  setEnabled(enabled: boolean): void;
  detach(): void;
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Avoid TypeScript narrowing cross-constructor `instanceof` checks to `never`. */
function isLiveInstance(value: unknown, ctor: CalmComponentConstructor): boolean {
  return value instanceof ctor;
}

function isVisibleTextPart(part: AssistantContentPart): part is AssistantTextPart {
  return part.type === "text" && part.text.trim() !== "";
}

function hasTerminalNotice(message: AssistantMessage): boolean {
  return (
    message.stopReason === "aborted" ||
    message.stopReason === "error" ||
    message.stopReason === "length"
  );
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  if (typeof value !== "object" || value === null) return false;
  const role: unknown = Object.getOwnPropertyDescriptor(value, "role")?.value;
  const content: unknown = Object.getOwnPropertyDescriptor(value, "content")?.value;

  return role === "assistant" && Array.isArray(content);
}

/** Read Pi's current native assistant state without changing it. */
function readAssistantState(component: object): NativeAssistantState {
  const messageDescriptor = Object.getOwnPropertyDescriptor(component, "lastMessage");

  if (messageDescriptor === undefined || !("value" in messageDescriptor))
    throw new Error("the Pi assistant lastMessage field is missing.");
  const message: unknown = messageDescriptor.value;

  if (message !== undefined && !isAssistantMessage(message))
    throw new Error("the Pi assistant lastMessage field is malformed.");

  const streamingDescriptor = Object.getOwnPropertyDescriptor(component, "isStreaming");

  if (streamingDescriptor === undefined || !("value" in streamingDescriptor))
    throw new Error("the Pi assistant isStreaming field is missing.");
  const streaming: unknown = streamingDescriptor.value;

  if (typeof streaming !== "boolean")
    throw new Error("the Pi assistant isStreaming field is malformed.");

  return { message, streaming };
}

function readPresentation(component: object): readonly unknown[] {
  return ASSISTANT_PRESENTATION_FIELDS.map((field): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(component, field);

    return descriptor?.value;
  });
}

function sameValues(left: readonly unknown[], right: readonly unknown[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  );
}

function sameSnapshot(left: AssistantSnapshot | undefined, right: AssistantSnapshot): boolean {
  return (
    left !== undefined &&
    sameValues(left.text, right.text) &&
    left.stopReason === right.stopReason &&
    left.errorMessage === right.errorMessage &&
    left.streaming === right.streaming &&
    sameValues(left.presentation, right.presentation)
  );
}

function copyPresentation(source: object, projected: object): void {
  for (const field of ASSISTANT_PRESENTATION_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(source, field);

    if (descriptor !== undefined) Object.defineProperty(projected, field, descriptor);
  }
}

function readSkillMetadata(component: object): SkillMetadata {
  const descriptor = Object.getOwnPropertyDescriptor(component, "skillBlock");

  if (descriptor === undefined || !("value" in descriptor))
    throw new Error("the Pi skill invocation metadata seam is missing.");
  const block: unknown = descriptor.value;

  if (typeof block !== "object" || block === null)
    throw new Error("the Pi skill invocation metadata seam is malformed.");
  const name: unknown = Object.getOwnPropertyDescriptor(block, "name")?.value;
  const userMessage: unknown = Object.getOwnPropertyDescriptor(block, "userMessage")?.value;

  if (
    typeof name !== "string" ||
    name.trim() === "" ||
    (userMessage !== undefined && typeof userMessage !== "string")
  )
    throw new Error("the Pi skill invocation metadata seam is malformed.");

  return { name, paired: userMessage?.trim() !== "" && userMessage !== undefined };
}

function readCustomType(component: object): string {
  const descriptor = Object.getOwnPropertyDescriptor(component, "message");

  if (descriptor === undefined || !("value" in descriptor))
    throw new Error("the Pi custom message metadata seam is missing.");
  const entry: unknown = descriptor.value;

  if (typeof entry !== "object" || entry === null)
    throw new Error("the Pi custom message metadata seam is malformed.");
  const customType: unknown = Object.getOwnPropertyDescriptor(entry, "customType")?.value;

  if (typeof customType !== "string")
    throw new Error("the Pi custom message metadata seam is malformed.");

  return customType;
}

function createSeparator(style: SeparatorStyle): Component {
  return {
    render: (width: number) => (width < 1 ? [] : [style(SEPARATOR.slice(0, width))]),
    invalidate: () => {},
  };
}

/** Locate the live chat Container from the TUI root handed to Pi widget factories. */
export function discoverCalmChat(tui: Pick<TUI, "children">, runtime: CalmChatRuntime): Container {
  const document = tui.children[DOCUMENT_INDEX];

  if (!(document instanceof runtime.container) || document.children.length !== DOCUMENT_CHILD_COUNT)
    throw new Error("the Pi document layout seam is missing.");
  const chat = document.children[CHAT_INDEX];

  if (!(chat instanceof runtime.container))
    throw new Error("the Pi live chat Container seam is missing.");

  return chat;
}

export function attachCalmProjection(
  chat: Container,
  options: CalmProjectionOptions,
): CalmProjection {
  if (!(chat instanceof options.runtime.container))
    throw new Error("the Pi live chat Container is incompatible.");

  if (ATTACHED_CHATS.has(chat)) throw new Error("the Pi live chat is already adapted.");
  const adapter = new ChatProjectionAdapter(chat, options);
  adapter.attach();

  return adapter;
}

class ChatProjectionAdapter implements CalmProjection {
  readonly #chat: Container;
  readonly #runtime: CalmChatRuntime;
  readonly #styleSeparator: SeparatorStyle;
  readonly #onIncompatible: Diagnostic;
  readonly #projection: Container;
  readonly #nativeRender: (width: number) => string[];
  readonly #nativeInvalidate: () => void;
  readonly #nativeMouse: (event: MouseEvent) => MouseResult;
  readonly #assistantCache = new WeakMap<AssistantMessageComponent, CachedAssistant>();
  readonly #skillUsers = new WeakMap<SkillInvocationMessageComponent, UserMessageComponent>();
  readonly #originals: Record<OwnedSeam["key"], PropertyDescriptor | undefined>;
  #attached = false;
  #enabled = false;
  #failed = false;

  readonly #wrappedRender = (width: number): string[] => {
    if (!this.#enabled) return this.#nativeRender(width);

    try {
      this.#rebuildProjection();

      return this.#projection.render(width);
    } catch (error) {
      this.#fail(error);

      return this.#nativeRender(width);
    }
  };

  readonly #wrappedInvalidate = (): void => {
    try {
      this.#nativeInvalidate();

      if (this.#enabled) this.#projection.invalidate();
    } catch (error) {
      this.#fail(error);
    }
  };

  readonly #wrappedMouse = (event: MouseEvent): MouseResult => {
    if (!this.#enabled) return this.#nativeMouse(event);

    try {
      return this.#projection.handleMouse(event);
    } catch (error) {
      this.#fail(error);

      return this.#nativeMouse(event);
    }
  };

  constructor(chat: Container, options: CalmProjectionOptions) {
    if (typeof chat.handleMouse !== "function")
      throw new Error("the Pi live chat handleMouse seam is missing.");
    this.#chat = chat;
    this.#runtime = options.runtime;
    this.#styleSeparator = options.styleSeparator;
    this.#onIncompatible = options.onIncompatible;
    this.#projection = new options.runtime.container();
    this.#nativeRender = chat.render.bind(chat);
    this.#nativeInvalidate = chat.invalidate.bind(chat);
    this.#nativeMouse = chat.handleMouse.bind(chat);
    this.#originals = {
      render: Object.getOwnPropertyDescriptor(chat, "render"),
      invalidate: Object.getOwnPropertyDescriptor(chat, "invalidate"),
      handleMouse: Object.getOwnPropertyDescriptor(chat, "handleMouse"),
    };
  }

  attach(): void {
    ATTACHED_CHATS.add(this.#chat);
    this.#attached = true;

    try {
      this.#chat.render = this.#wrappedRender;
      this.#chat.invalidate = this.#wrappedInvalidate;
      this.#chat.handleMouse = this.#wrappedMouse;
    } catch (error) {
      this.#restore();
      throw error;
    }
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = this.#attached && !this.#failed && enabled;
  }

  detach(): void {
    this.#enabled = false;
    this.#restore();
  }

  #assistant(source: AssistantMessageComponent): Component | undefined {
    const state = readAssistantState(source);

    if (state.message === undefined) return undefined;
    const visibleContent = state.message.content.filter(isVisibleTextPart);
    const text = visibleContent.map((part) => part.text);

    if (text.length === 0 && !hasTerminalNotice(state.message)) return undefined;
    let cached = this.#assistantCache.get(source);

    if (cached === undefined) {
      cached = { projected: new this.#runtime.assistant(), snapshot: undefined };
      this.#assistantCache.set(source, cached);
    }

    const snapshot: AssistantSnapshot = {
      text,
      stopReason: state.message.stopReason,
      errorMessage: state.message.errorMessage,
      streaming: state.streaming,
      presentation: readPresentation(source),
    };

    if (!sameSnapshot(cached.snapshot, snapshot)) {
      copyPresentation(source, cached.projected);
      cached.projected.updateContent(
        { ...state.message, content: visibleContent },
        state.streaming,
      );
      cached.snapshot = snapshot;
    }

    return cached.projected;
  }

  #skill(source: SkillInvocationMessageComponent): Component | undefined {
    const metadata = readSkillMetadata(source);

    if (metadata.paired) return undefined;
    let synthetic = this.#skillUsers.get(source);

    if (synthetic === undefined) {
      synthetic = new this.#runtime.user(`/skill:${metadata.name}`);
      this.#skillUsers.set(source, synthetic);
    }

    return synthetic;
  }

  #visible(component: Component): Component | undefined {
    if (component instanceof this.#runtime.user) return component;

    if (component instanceof this.#runtime.skill) return this.#skill(component);

    if (component instanceof this.#runtime.assistant) return this.#assistant(component);

    if (isLiveInstance(component, this.#runtime.toolExecution)) return undefined;

    if (
      isLiveInstance(component, this.#runtime.customMessage) &&
      readCustomType(component) === EXCLUDED_CUSTOM_TYPE
    )
      return undefined;

    return component;
  }

  #rebuildProjection(): void {
    this.#projection.clear();
    let previousWasAssistant = false;

    for (const source of this.#chat.children) {
      const visible = this.#visible(source);

      if (visible === undefined) continue;
      const assistant = visible instanceof this.#runtime.assistant;

      if (assistant && previousWasAssistant)
        this.#projection.addChild(createSeparator(this.#styleSeparator));
      this.#projection.addChild(visible);
      previousWasAssistant = assistant;
    }
  }

  #ownedSeams(): readonly OwnedSeam[] {
    return [
      { key: "render", installed: this.#wrappedRender, original: this.#originals.render },
      {
        key: "invalidate",
        installed: this.#wrappedInvalidate,
        original: this.#originals.invalidate,
      },
      { key: "handleMouse", installed: this.#wrappedMouse, original: this.#originals.handleMouse },
    ];
  }

  #restore(): void {
    if (!this.#attached) return;
    this.#attached = false;
    ATTACHED_CHATS.delete(this.#chat);

    for (const seam of this.#ownedSeams()) {
      const current = Object.getOwnPropertyDescriptor(this.#chat, seam.key);

      if (current?.value !== seam.installed) continue;

      if (seam.original === undefined) Reflect.deleteProperty(this.#chat, seam.key);
      else Object.defineProperty(this.#chat, seam.key, seam.original);
    }
  }

  #fail(error: unknown): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#enabled = false;
    this.#restore();
    this.#onIncompatible(describeFailure(error));
  }
}
