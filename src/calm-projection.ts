import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AssistantMessageComponent,
  SkillInvocationMessageComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { Component, Container, TUI } from "@earendil-works/pi-tui";
import type { CalmChatRuntime, CalmComponentConstructor } from "./pi-chat-runtime.js";

/**
 * Calm renders the live Pi chat through a separate projection container.
 *
 * Pi exposes the live chat only as an internal layout detail. Discovery therefore validates the
 * inspected TUI shape and every wrapped seam, and any mismatch fails the whole projection instead
 * of silently rendering a partial conversation. Native chat children are never rewritten; the
 * projection keeps its own membership and delegates rendering and mouse dispatch back to Pi when
 * Calm is disabled.
 *
 * Classification is exclusion-based: tool executions and two Workgraph custom types are hidden;
 * every other row observed through the wrapped lifecycle is projected unchanged.
 *
 * Known limitation: a row inserted directly into `chat.children` never passes a wrapped lifecycle
 * seam, so it is neither classified nor projected and stays native-only. The inspected Pi
 * 0.84.4/0.85.1 takes that path for its streaming custom-entry row, which it inserts with
 * `chat.children.splice`; the adapter does not scan children per frame to recover it.
 */

// SAFETY: This module is the guarded Pi chat compatibility boundary; live component instances are
// inspected structurally and every seam is validated before use.
// oxlint-disable anti-slop/no-object-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters

const OWNER = Symbol.for("@vistyy/pi-workgraph/calm-chat-projection");
const SEPARATOR = "---";
const DOCUMENT_INDEX = 0;
const DOCUMENT_CHILD_COUNT = 3;
const CHAT_INDEX = 2;
// Pi keeps assistant presentation settings in private instance fields; mirroring the descriptors
// lets the projection render with the same theme, padding, and transforms as the native component.
const ASSISTANT_PRESENTATION_FIELDS = [
  "markdownTheme",
  "hiddenThinkingLabel",
  "outputPad",
  "markdownTransformers",
  "hideThinkingBlock",
] as const;

type SeparatorStyle = (text: string) => string;
type Diagnostic = (message: string) => void;
type AssistantUpdate = (message: AssistantMessage, isStreaming?: boolean) => void;

/** Collect independent clean-up failures so one throwing seam cannot hide the remaining ones. */
class CleanupFailures {
  readonly #details: string[] = [];

  /** Run one best-effort step, recording its failure instead of letting it interrupt the sweep. */
  run(step: string, operation: () => void): void {
    try {
      operation();
    } catch (error) {
      this.#details.push(`${step} (${describeFailure(error)})`);
    }
  }

  /** The combined, de-duplicated detail for the failed steps, or nothing when all succeeded. */
  error(context: string): Error | undefined {
    if (this.#details.length === 0) return undefined;
    return new Error(`${context}: ${[...new Set(this.#details)].join("; ")}`);
  }
}

/** Avoid TypeScript narrowing cross-constructor `instanceof` checks to `never`. */
function isLiveInstance(value: unknown, ctor: CalmComponentConstructor): boolean {
  return value instanceof ctor;
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface MouseEventLike {
  readonly y: number;
  readonly height: number;
  readonly width: number;
}

/** The published Container type omits Pi's runtime mouse members, which the chat instance owns. */
interface MouseDelegatingContainer extends Container {
  handleMouse?: (event: MouseEventLike) => MouseEventLike | undefined;
}

type AssistantContentPart = AssistantMessage["content"][number];
type AssistantTextPart = Extract<AssistantContentPart, { readonly type: "text" }>;

interface AssistantEntry {
  readonly kind: "assistant";
  readonly source: AssistantMessageComponent;
  readonly nativeUpdate: AssistantUpdate;
  readonly ownUpdate: PropertyDescriptor | undefined;
  wrappedUpdate: AssistantUpdate | undefined;
  latest: AssistantMessage | undefined;
  latestStreaming: boolean;
  nativeStale: boolean;
  projected: AssistantMessageComponent | undefined;
  key: string;
  streaming: boolean | undefined;
  visible: boolean;
}

interface UserEntry {
  readonly kind: "user";
  readonly source: UserMessageComponent;
}

interface SkillEntry {
  readonly kind: "skill";
  readonly source: SkillInvocationMessageComponent;
  readonly synthetic: UserMessageComponent;
  readonly paired: boolean;
}

interface PassThroughEntry {
  readonly kind: "passthrough";
  readonly source: Component;
}

type ProjectionEntry = AssistantEntry | UserEntry | SkillEntry | PassThroughEntry;

const EXCLUDED_CUSTOM_TYPES: ReadonlySet<string> = new Set([
  "pi-workgraph-workstream",
  "pi-workgraph-attention",
]);

interface OwnedSeam {
  readonly target: object;
  readonly key: PropertyKey;
  readonly installed: unknown;
  readonly original: PropertyDescriptor | undefined;
}

export interface CalmProjectionOptions {
  readonly runtime: CalmChatRuntime;
  readonly styleSeparator: SeparatorStyle;
  /** Report an incompatibility that disables Calm and restores native presentation. */
  readonly onIncompatible: Diagnostic;
  /** Report a non-fatal compatibility concern, such as a seam replaced by another adapter. */
  readonly onWarning?: Diagnostic;
}

export interface CalmProjection {
  setEnabled(enabled: boolean): void;
  detach(): void;
}

// A skill invocation that carries an accompanying user message contributes only that message; a
// skill-only invocation contributes its compact synthetic line. Pairing uses the guarded
// `skillBlock.userMessage` metadata, never the following sibling, so an unrelated user message
// after a skill-only invocation keeps the compact line.
function visibleEntry(entry: ProjectionEntry): Component[] {
  if (entry.kind === "user") return [entry.source];
  if (entry.kind === "passthrough") return [entry.source];
  if (entry.kind === "skill") return entry.paired ? [] : [entry.synthetic];
  return entry.visible && entry.projected !== undefined ? [entry.projected] : [];
}

function createSeparator(styleSeparator: SeparatorStyle): Component {
  return {
    render: (width: number) => (width < 1 ? [] : [styleSeparator(SEPARATOR.slice(0, width))]),
    invalidate: () => {},
  };
}

/** Restore only what this adapter still owns; another adapter's wrapper is left untouched. */
function restoreSeam(seam: OwnedSeam, warn: Diagnostic): void {
  const current = Object.getOwnPropertyDescriptor(seam.target, seam.key);
  if (current === undefined || current.value !== seam.installed) {
    if (current !== undefined) warn(`the Pi ${String(seam.key)} seam changed before Calm cleanup.`);
    return;
  }
  if (seam.original === undefined) Reflect.deleteProperty(seam.target, seam.key);
  else Object.defineProperty(seam.target, seam.key, seam.original);
}

function restoreAssistantSeam(entry: AssistantEntry, warn: Diagnostic): void {
  if (entry.wrappedUpdate === undefined) return;
  restoreSeam(
    {
      target: entry.source,
      key: "updateContent",
      installed: entry.wrappedUpdate,
      original: entry.ownUpdate,
    },
    warn,
  );
}

/**
 * Preserve terminal metadata while projecting only prose. Removing tool calls is essential because
 * Pi otherwise suppresses abort/error notices in favor of the hidden tool row.
 */
function projectableProse(
  message: AssistantMessage,
): { readonly key: string; readonly message: AssistantMessage } | undefined {
  const parts = message.content.filter(isVisibleTextPart);
  if (parts.length === 0 && !hasTerminalNotice(message)) return undefined;
  return {
    key: [
      parts.map((part) => part.text).join("\u0000"),
      message.stopReason,
      message.errorMessage ?? "",
    ].join("\u0001"),
    message: { ...message, content: parts },
  };
}

function hasTerminalNotice(message: AssistantMessage): boolean {
  return (
    message.stopReason === "aborted" ||
    message.stopReason === "error" ||
    message.stopReason === "length"
  );
}

function isVisibleTextPart(part: AssistantContentPart): part is AssistantTextPart {
  return part.type === "text" && part.text.trim() !== "";
}

/**
 * Read Pi's own `lastMessage` field. Pi declares it as an instance field, so a missing descriptor
 * means an incompatible assistant component. A present-but-undefined value is the legitimate empty
 * streaming state; any other value must be a well-formed assistant message.
 */
function readAssistantMessage(component: object): AssistantMessage | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(component, "lastMessage");
  if (descriptor === undefined || !("value" in descriptor))
    throw new Error("the Pi assistant lastMessage field is missing.");
  const value: unknown = descriptor.value;
  if (value === undefined) return undefined;
  if (!isAssistantMessage(value))
    throw new Error("the Pi assistant lastMessage field is malformed.");
  return value;
}

/**
 * Read Pi's own `isStreaming` field. A supported assistant always declares it as a boolean instance
 * field. A missing descriptor or a non-boolean value is an incompatible assistant, not an omitted
 * argument, so it must fail the whole projection rather than silently keeping a stale streaming
 * state; only an omitted `updateContent` argument legitimately resolves from what this returns.
 */
function readAssistantStreaming(component: object): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(component, "isStreaming");
  if (descriptor === undefined || !("value" in descriptor))
    throw new Error("the Pi assistant isStreaming field is missing.");
  const value: unknown = descriptor.value;
  if (typeof value !== "boolean")
    throw new Error("the Pi assistant isStreaming field is malformed.");
  return value;
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  if (typeof value !== "object" || value === null) return false;
  const role: unknown = Object.getOwnPropertyDescriptor(value, "role")?.value;
  const content: unknown = Object.getOwnPropertyDescriptor(value, "content")?.value;
  return role === "assistant" && Array.isArray(content);
}

interface SkillMetadata {
  readonly name: string;
  readonly paired: boolean;
}

/**
 * Read the guarded `skillBlock` metadata. `userMessage` is the accompanying user text when Pi
 * detected one; absence or an empty string means the compact skill line is the whole invocation.
 */
function readSkillMetadata(component: object): SkillMetadata {
  const descriptor = Object.getOwnPropertyDescriptor(component, "skillBlock");
  if (descriptor === undefined || !("value" in descriptor))
    throw new Error("the Pi skill invocation metadata seam is missing.");
  const block: unknown = descriptor.value;
  if (typeof block !== "object" || block === null)
    throw new Error("the Pi skill invocation metadata seam is malformed.");
  const name: unknown = Object.getOwnPropertyDescriptor(block, "name")?.value;
  if (typeof name !== "string" || name.trim() === "")
    throw new Error("the Pi skill invocation metadata seam is malformed.");
  const userMessage: unknown = Object.getOwnPropertyDescriptor(block, "userMessage")?.value;
  if (userMessage === undefined) return { name, paired: false };
  if (typeof userMessage !== "string")
    throw new Error("the Pi skill invocation metadata seam is malformed.");
  return { name, paired: userMessage.trim() !== "" };
}

/**
 * Read the guarded `message.customType` of a live custom message component. Pi stores the entry on
 * a private instance field, so a missing or malformed seam is an incompatibility rather than an
 * empty custom type that would silently pass through.
 */
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

/** Locate the live chat Container from the TUI root that Pi hands to widget factories. */
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
  if (Object.getOwnPropertyDescriptor(chat, OWNER) !== undefined)
    throw new Error("the Pi live chat is already adapted.");
  const adapter = new ChatProjectionAdapter(chat, options);
  adapter.attach();
  return adapter;
}

/**
 * One guarded adapter owns every seam of the exact live chat instance. Keeping it as a class keeps
 * each ownership operation reviewable on its own instead of one deeply nested closure.
 */
class ChatProjectionAdapter implements CalmProjection {
  readonly #chat: Container;
  readonly #runtime: CalmChatRuntime;
  readonly #styleSeparator: SeparatorStyle;
  readonly #warn: Diagnostic;
  readonly #onIncompatible: Diagnostic;
  readonly #projection: MouseDelegatingContainer;
  readonly #surface: MouseDelegatingContainer;
  readonly #nativeRender: (width: number) => string[];
  readonly #nativeAddChild: (component: Component) => void;
  readonly #nativeRemoveChild: (component: Component) => void;
  readonly #nativeClear: () => void;
  readonly #nativeInvalidate: () => void;
  readonly #nativeMouse: ((event: MouseEventLike) => MouseEventLike | undefined) | undefined;
  readonly #ownDescriptors: {
    readonly render: PropertyDescriptor | undefined;
    readonly addChild: PropertyDescriptor | undefined;
    readonly removeChild: PropertyDescriptor | undefined;
    readonly clear: PropertyDescriptor | undefined;
    readonly invalidate: PropertyDescriptor | undefined;
    readonly handleMouse: PropertyDescriptor | undefined;
  };
  readonly #entries: ProjectionEntry[] = [];
  readonly #separators = new WeakSet<Component>();
  #attached = true;
  #enabled = false;
  #failed = false;
  #rebuildSuppressed = false;
  #refreshingNative = false;
  #nativeRestoreAttempted = false;

  readonly #wrappedRender = (width: number): string[] =>
    this.#enabled ? this.#projection.render(width) : this.#nativeRender(width);

  readonly #wrappedAddChild = (component: Component): void => {
    this.#nativeAddChild(component);
    if (!this.#attached) return;
    try {
      const entry = this.#classify(component);
      if (entry === undefined) return;
      this.#entries.push(entry);
      if (entry.kind === "assistant") this.#applyAssistant(entry);
      else this.#appendVisible(entry);
    } catch (error) {
      this.#incompatible(error);
    }
  };

  readonly #wrappedRemoveChild = (component: Component): void => {
    this.#nativeRemoveChild(component);
    this.#removeEntry(component);
  };

  readonly #wrappedClear = (): void => {
    this.#nativeClear();
    this.#clearEntries();
  };

  // Calm owns the visible transcript while enabled, so only the projection is invalidated. Traversing
  // the hidden native subtree would rebuild excluded history and re-invalidate the user rows the
  // projection already reuses. When Calm is off the native subtree is the display and is invalidated
  // exactly as Pi does.
  readonly #wrappedInvalidate = (): void => {
    if (this.#enabled) {
      this.#projection.invalidate();
      return;
    }
    this.#nativeInvalidate();
  };

  readonly #wrappedMouse: ((event: MouseEventLike) => MouseEventLike | undefined) | undefined;

  constructor(chat: Container, options: CalmProjectionOptions) {
    const surface: MouseDelegatingContainer = chat;
    this.#chat = chat;
    this.#runtime = options.runtime;
    this.#styleSeparator = options.styleSeparator;
    this.#onIncompatible = options.onIncompatible;
    this.#warn = options.onWarning ?? (() => {});
    this.#projection = new options.runtime.container();
    this.#surface = surface;
    this.#nativeRender = chat.render.bind(chat);
    this.#nativeAddChild = chat.addChild.bind(chat);
    this.#nativeRemoveChild = chat.removeChild.bind(chat);
    this.#nativeClear = chat.clear.bind(chat);
    this.#nativeInvalidate = chat.invalidate.bind(chat);
    this.#nativeMouse = surface.handleMouse?.bind(surface);
    this.#wrappedMouse =
      this.#nativeMouse === undefined
        ? undefined
        : (event: MouseEventLike): MouseEventLike | undefined =>
            this.#enabled ? this.#projection.handleMouse?.(event) : this.#nativeMouse?.(event);
    this.#ownDescriptors = {
      render: Object.getOwnPropertyDescriptor(chat, "render"),
      addChild: Object.getOwnPropertyDescriptor(chat, "addChild"),
      removeChild: Object.getOwnPropertyDescriptor(chat, "removeChild"),
      clear: Object.getOwnPropertyDescriptor(chat, "clear"),
      invalidate: Object.getOwnPropertyDescriptor(chat, "invalidate"),
      handleMouse: Object.getOwnPropertyDescriptor(chat, "handleMouse"),
    };
  }

  attach(): void {
    try {
      for (const child of this.#chat.children) {
        const entry = this.#classify(child);
        if (entry !== undefined) this.#entries.push(entry);
      }
    } catch (error) {
      this.#clearEntries(new CleanupFailures());
      throw error;
    }
    try {
      this.#chat.render = this.#wrappedRender;
      this.#chat.addChild = this.#wrappedAddChild;
      this.#chat.removeChild = this.#wrappedRemoveChild;
      this.#chat.clear = this.#wrappedClear;
      this.#chat.invalidate = this.#wrappedInvalidate;
      if (this.#wrappedMouse !== undefined) this.#surface.handleMouse = this.#wrappedMouse;
      Object.defineProperty(this.#chat, OWNER, { configurable: true, value: this.#projection });
    } catch (error) {
      const failures = new CleanupFailures();
      this.#restoreOwnedSeams(failures);
      this.#clearEntries(failures);
      throw error;
    }
  }

  setEnabled(value: boolean): void {
    const next = this.#attached && !this.#failed && value;
    if (next === this.#enabled) return;
    this.#enabled = next;
    if (!next) {
      const failures = new CleanupFailures();
      this.#restoreNative(failures);
      const failure = failures.error("Calm could not restore native presentation");
      if (failure !== undefined) this.#incompatible(failure);
      return;
    }
    this.#rebuildSuppressed = true;
    // Re-arm the one-shot restoration guard: a later Calm-off must refresh deferred updates again.
    this.#nativeRestoreAttempted = false;
    try {
      for (const entry of this.#entries)
        if (entry.kind === "assistant") this.#applyAssistant(entry, true);
    } finally {
      this.#rebuildSuppressed = false;
    }
    this.#rebuildMembership();
  }

  /**
   * Rebuild every native assistant and refresh the native rows Calm hid while it owned the display.
   *
   * Restoration is best effort by design. One failing native update must not stop the remaining
   * assistants from being restored or skip the hidden rows entirely, and a failed update is never
   * recorded as fresh. At most one attempt is made per attachment, so turning a failure into an
   * incompatibility cannot recursively retry the same failing refresh.
   */
  #restoreNative(failures: CleanupFailures): void {
    if (this.#nativeRestoreAttempted) return;
    this.#nativeRestoreAttempted = true;
    for (const entry of this.#entries) {
      if (entry.kind !== "assistant" || !entry.nativeStale) continue;
      if (entry.latest === undefined) {
        entry.nativeStale = false;
        continue;
      }
      const { latest, latestStreaming } = entry;
      failures.run("native assistant refresh", () => {
        entry.nativeUpdate(latest, latestStreaming);
        entry.nativeStale = false;
      });
    }
    this.#refreshingNative = true;
    try {
      failures.run("native chat invalidation", () => this.#nativeInvalidate());
    } finally {
      this.#refreshingNative = false;
    }
  }

  detach(): void {
    const failure = this.#release(true);
    if (failure !== undefined) this.#reportIncompatible(failure);
  }

  #separator(): Component {
    const separator = createSeparator(this.#styleSeparator);
    this.#separators.add(separator);
    return separator;
  }

  #rebuildMembership(): void {
    this.#projection.clear();
    let previousWasAssistant = false;
    for (const entry of this.#entries) {
      for (const child of visibleEntry(entry)) {
        const isAssistant = child instanceof this.#runtime.assistant;
        if (isAssistant && previousWasAssistant) this.#projection.addChild(this.#separator());
        this.#projection.addChild(child);
        previousWasAssistant = isAssistant;
      }
    }
  }

  /** Append one entry's visible rows at the tail; only a rebuild changes existing membership. */
  #appendVisible(entry: ProjectionEntry): void {
    if (!this.#enabled || this.#rebuildSuppressed) return;
    for (const child of visibleEntry(entry)) {
      if (child instanceof this.#runtime.assistant && this.#lastProjectedIsAssistant())
        this.#projection.addChild(this.#separator());
      this.#projection.addChild(child);
    }
  }

  #lastProjectedIsAssistant(): boolean {
    const last = this.#projection.children.at(-1);
    return last !== undefined && last instanceof this.#runtime.assistant;
  }

  /** Drop a removed tail entry's rows without rebuilding the rows before it. */
  #truncateVisible(entry: ProjectionEntry): boolean {
    const visible = visibleEntry(entry);
    const projected = visible.at(-1);
    if (projected === undefined) return true;
    const children = this.#projection.children;
    if (children.at(-1) !== projected) return false;
    for (let index = visible.length - 1; index >= 0; index -= 1) {
      const child = visible[index];
      if (child !== undefined) this.#projection.removeChild(child);
    }
    // Separators only ever sit between two assistants, so a trailing one is now dangling.
    const trailing = children.at(-1);
    if (trailing !== undefined && this.#separators.has(trailing))
      this.#projection.removeChild(trailing);
    return true;
  }

  // Separators depend only on which entries are visible and their order, so membership and
  // separators are rebuilt on visibility or membership changes, never on ordinary prose deltas.
  #requestRebuild(): void {
    if (!this.#enabled || this.#rebuildSuppressed) return;
    this.#rebuildMembership();
  }

  /**
   * Pi keeps assistant presentation in private instance fields. Mirror the current descriptors onto
   * the projected copy before it rebuilds so its theme, padding, transforms, and thinking label track
   * whatever Pi most recently set on the source.
   */
  #syncAssistantPresentation(entry: AssistantEntry): void {
    const projected = entry.projected;
    if (projected === undefined) return;
    for (const field of ASSISTANT_PRESENTATION_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(entry.source, field);
      if (descriptor !== undefined) Object.defineProperty(projected, field, descriptor);
    }
  }

  /**
   * Compare the projected copy against the source's current presentation fields, so a native setter
   * that rebuilds with unchanged prose still refreshes the projection.
   */
  #presentationChanged(entry: AssistantEntry): boolean {
    const projected = entry.projected;
    if (projected === undefined) return true;
    for (const field of ASSISTANT_PRESENTATION_FIELDS) {
      const source = Object.getOwnPropertyDescriptor(entry.source, field);
      if (source === undefined) continue;
      const current = Object.getOwnPropertyDescriptor(projected, field);
      if (current === undefined || current.value !== source.value) return true;
    }
    return false;
  }

  #applyAssistant(entry: AssistantEntry, force = false): void {
    if (!this.#enabled) return;
    const presentationChanged = this.#presentationChanged(entry);
    const prose = entry.latest === undefined ? undefined : projectableProse(entry.latest);
    if (prose === undefined) {
      if (!entry.visible) return;
      entry.visible = false;
      entry.key = "";
      this.#requestRebuild();
      return;
    }
    // Identical prose still needs a projection update when streaming state or a presentation field
    // changed, because Pi renders streamed/completed content differently and native setters rebuild
    // in place. Unchanged text, streaming, and presentation together are a true no-op.
    if (
      !force &&
      !presentationChanged &&
      entry.visible &&
      entry.key === prose.key &&
      entry.streaming === entry.latestStreaming
    )
      return;
    entry.projected ??= new this.#runtime.assistant();
    this.#syncAssistantPresentation(entry);
    entry.projected.updateContent(prose.message, entry.latestStreaming);
    const becameVisible = !entry.visible;
    entry.visible = true;
    entry.key = prose.key;
    entry.streaming = entry.latestStreaming;
    if (!becameVisible) return;
    // A tail visibility change is an ordinary append; anything else changes existing order.
    if (this.#entries.at(-1) === entry) this.#appendVisible(entry);
    else this.#rebuildMembership();
  }

  #createAssistantEntry(source: AssistantMessageComponent): AssistantEntry {
    const entry: AssistantEntry = {
      kind: "assistant",
      source,
      nativeUpdate: source.updateContent.bind(source),
      ownUpdate: Object.getOwnPropertyDescriptor(source, "updateContent"),
      wrappedUpdate: undefined,
      latest: readAssistantMessage(source),
      latestStreaming: readAssistantStreaming(source),
      nativeStale: false,
      projected: undefined,
      key: "",
      streaming: undefined,
      visible: false,
    };
    const wrapped: AssistantUpdate = (message, isStreaming) => {
      // A throw here is observed through Pi's own update path, so route it to the one terminal
      // incompatibility instead of breaking Pi's call or leaving a half-updated wrapper behind.
      try {
        this.#updateAssistant(entry, message, isStreaming);
      } catch (error) {
        this.#incompatible(error);
      }
    };
    entry.wrappedUpdate = wrapped;
    source.updateContent = wrapped;
    return entry;
  }

  #updateAssistant(
    entry: AssistantEntry,
    message: AssistantMessage,
    isStreaming: boolean | undefined,
  ): void {
    // Pi's native updateContent defaults an omitted/undefined isStreaming to the component's own
    // current streaming state. Resolve it here, before mutating fields, so one-argument calls from
    // Pi's presentation setters and invalidate keep the exact true/false state. A missing or
    // non-boolean live field is a compatibility failure, not an omitted argument.
    const streaming = isStreaming ?? readAssistantStreaming(entry.source);
    entry.latest = message;
    entry.latestStreaming = streaming;
    // Keep Pi's own instance fields current without building the native tree, so a width/theme
    // invalidation cannot feed a stale message back through the wrapper.
    Reflect.set(entry.source, "lastMessage", message);
    Reflect.set(entry.source, "isStreaming", streaming);
    if (this.#enabled) {
      // Calm owns the visible assistant; the hidden native tree is restored before Calm off.
      entry.nativeStale = true;
      this.#applyAssistant(entry);
      return;
    }
    // The refresh pass already rebuilt this native assistant; skip the duplicate traversal rebuild.
    if (this.#refreshingNative) return;
    entry.nativeUpdate(message, streaming);
    // Only a completed native update may mark the native tree fresh again.
    entry.nativeStale = false;
  }

  #classify(component: Component): ProjectionEntry | undefined {
    if (component instanceof this.#runtime.user) return { kind: "user", source: component };
    if (component instanceof this.#runtime.skill) {
      const metadata = readSkillMetadata(component);
      return {
        kind: "skill",
        source: component,
        synthetic: new this.#runtime.user(`/skill:${metadata.name}`),
        paired: metadata.paired,
      };
    }
    if (component instanceof this.#runtime.assistant) return this.#createAssistantEntry(component);
    if (isLiveInstance(component, this.#runtime.toolExecution)) return undefined;
    if (isLiveInstance(component, this.#runtime.customMessage)) {
      if (EXCLUDED_CUSTOM_TYPES.has(readCustomType(component))) return undefined;
      return { kind: "passthrough", source: component };
    }
    return { kind: "passthrough", source: component };
  }

  #removeEntry(component: Component): void {
    const index = this.#entries.findIndex((entry) => entry.source === component);
    if (index === -1) return;
    const isTail = index === this.#entries.length - 1;
    const [removed] = this.#entries.splice(index, 1);
    if (removed?.kind === "assistant") restoreAssistantSeam(removed, this.#warn);
    if (removed === undefined || !this.#enabled || this.#rebuildSuppressed) return;
    // Removing the last entry only drops trailing rows; a non-tail removal shifts order.
    if (isTail && this.#truncateVisible(removed)) return;
    this.#rebuildMembership();
  }

  #clearEntries(failures: CleanupFailures = new CleanupFailures()): void {
    for (const entry of this.#entries)
      if (entry.kind === "assistant")
        failures.run("native assistant update seam", () => restoreAssistantSeam(entry, this.#warn));
    this.#entries.length = 0;
    failures.run("Calm projection children", () => this.#projection.clear());
  }

  #ownedSeams(): OwnedSeam[] {
    const seams: OwnedSeam[] = [
      {
        target: this.#chat,
        key: "render",
        installed: this.#wrappedRender,
        original: this.#ownDescriptors.render,
      },
      {
        target: this.#chat,
        key: "addChild",
        installed: this.#wrappedAddChild,
        original: this.#ownDescriptors.addChild,
      },
      {
        target: this.#chat,
        key: "removeChild",
        installed: this.#wrappedRemoveChild,
        original: this.#ownDescriptors.removeChild,
      },
      {
        target: this.#chat,
        key: "clear",
        installed: this.#wrappedClear,
        original: this.#ownDescriptors.clear,
      },
      {
        target: this.#chat,
        key: "invalidate",
        installed: this.#wrappedInvalidate,
        original: this.#ownDescriptors.invalidate,
      },
    ];
    if (this.#wrappedMouse !== undefined)
      seams.push({
        target: this.#surface,
        key: "handleMouse",
        installed: this.#wrappedMouse,
        original: this.#ownDescriptors.handleMouse,
      });
    return seams;
  }

  #restoreOwnedSeams(failures: CleanupFailures): void {
    for (const seam of this.#ownedSeams())
      failures.run(`Pi ${String(seam.key)} seam`, () => restoreSeam(seam, this.#warn));
  }

  /**
   * Idempotent full release. Native presentation is restored first when requested, then every owned
   * entry, chat seam, projection child, and the ownership marker are released best effort, so one
   * failing seam cannot strand the rest. Returns the combined failure needing surfacing, if any.
   */
  #release(refreshNative: boolean): Error | undefined {
    if (!this.#attached) return undefined;
    this.#attached = false;
    this.#enabled = false;
    const failures = new CleanupFailures();
    if (refreshNative) this.#restoreNative(failures);
    this.#clearEntries(failures);
    this.#restoreOwnedSeams(failures);
    failures.run("Calm ownership marker", () => {
      Reflect.deleteProperty(this.#chat, OWNER);
    });
    return failures.error("Calm cleanup could not fully restore Pi");
  }

  #incompatible(error: unknown): void {
    if (this.#failed) return;
    const cleanup = this.#release(true);
    this.#reportIncompatible(
      cleanup === undefined ? error : `${describeFailure(error)}; ${cleanup.message}`,
    );
  }

  #reportIncompatible(error: unknown): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#onIncompatible(describeFailure(error));
  }
}
