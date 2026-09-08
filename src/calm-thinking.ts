// SAFETY: This module is the narrowly guarded internal Pi assistant presentation compatibility
// boundary. Runtime reflection is used only to validate the installed Pi seam and falls back
// visibly when it changes.
// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-reflect-get

type Render = (width: number) => string[];
type AssistantUpdate = {
  bivarianceHack(message: unknown, isStreaming?: boolean): void;
}["bivarianceHack"];

type AssistantPresentationInstance = {
  render: Render;
  updateContent: AssistantUpdate;
};
type AssistantPresentationPrototype = AssistantPresentationInstance & {
  readonly [PATCH_OWNER]?: unknown;
};
export type AssistantPresentationConstructor = {
  prototype: AssistantPresentationPrototype;
};
type Diagnostic = (message: string) => void;

type SourceRecord = {
  source: unknown;
  presented: unknown;
  streaming: boolean | undefined;
  calmOn: boolean;
};

const PATCH_OWNER = Symbol.for("@vistyy/pi-workgraph/calm-presentation");

export function attachCalmThinking(
  prototype: AssistantPresentationPrototype,
  calmOn: () => boolean,
  diagnostic: Diagnostic,
): () => void {
  if (typeof prototype?.render !== "function" || typeof prototype.updateContent !== "function")
    throw new Error("the Pi assistant message presentation seam is missing.");
  if (readProperty(prototype, PATCH_OWNER) !== undefined)
    throw new Error("the Pi assistant message presentation seam is already adapted.");

  const renderDescriptor = Object.getOwnPropertyDescriptor(prototype, "render");
  const updateDescriptor = Object.getOwnPropertyDescriptor(prototype, "updateContent");
  if (renderDescriptor === undefined || updateDescriptor === undefined)
    throw new Error("the Pi assistant message presentation descriptors are missing.");

  const originalRender = prototype.render;
  const originalUpdate = prototype.updateContent;
  const records = new WeakMap<object, SourceRecord>();
  const touched = new Set<AssistantPresentationInstance>();
  let metadataWarning = false;

  const presentationMessage = (source: unknown): unknown => {
    if (!calmOn()) return source;
    try {
      const content = readProperty(source, "content");
      if (!Array.isArray(content)) {
        if (!metadataWarning) {
          metadataWarning = true;
          diagnostic("the Pi assistant message content seam changed.");
        }
        return source;
      }
      const filtered = content.filter((part) => readStringProperty(part, "type") !== "thinking");
      return filtered.length === content.length
        ? source
        : Object.assign({}, source, { content: filtered });
    } catch (error) {
      diagnostic(`the Pi assistant message filter failed: ${errorMessage(error)}.`);
      return source;
    }
  };

  const sourceFor = (component: AssistantPresentationInstance): SourceRecord | undefined => {
    const existing = records.get(component);
    if (existing !== undefined) return existing;
    const source = readProperty(component, "lastMessage");
    if (source === undefined) return undefined;
    const record: SourceRecord = {
      source,
      presented: source,
      calmOn: false,
      streaming: undefined,
    };
    records.set(component, record);
    touched.add(component);
    return record;
  };

  const apply = (
    component: AssistantPresentationInstance,
    record: SourceRecord,
    includeStreaming: boolean,
    streaming?: boolean,
  ): void => {
    const presented = presentationMessage(record.source);
    if (includeStreaming) originalUpdate.call(component, presented, streaming);
    else originalUpdate.call(component, presented);
    record.presented = presented;
    record.calmOn = calmOn();
    if (includeStreaming) record.streaming = streaming;
  };

  const wrappedUpdate: AssistantUpdate = function (
    this: AssistantPresentationInstance,
    ...args: [message: unknown, isStreaming?: boolean]
  ): void {
    const [message, streaming] = args;
    let record = records.get(this);
    const replay = record !== undefined && message === record.presented;
    if (record === undefined) {
      record = {
        source: message,
        presented: message,
        calmOn: false,
        streaming: undefined,
      };
      records.set(this, record);
      touched.add(this);
    } else if (!replay) {
      // A new object identity is the supported source-update signal. In particular, the exact
      // filtered snapshot emitted by our adapter never replaces the retained full source.
      record.source = message;
    }

    if (replay && args.length < 2) apply(this, record, false);
    else apply(this, record, true, streaming);
  };

  const reconcile = (component: AssistantPresentationInstance): void => {
    const record = sourceFor(component);
    if (record === undefined || record.calmOn === calmOn()) return;
    apply(component, record, false);
  };
  const wrappedRender: Render = function (this: AssistantPresentationInstance, width): string[] {
    reconcile(this);
    return originalRender.call(this, width);
  };

  const restore = (): void => {
    for (const component of touched) {
      const record = records.get(component);
      if (record === undefined) continue;
      try {
        // Restore live component content while the native update seam is still available.
        if (record.streaming === undefined) originalUpdate.call(component, record.source);
        else originalUpdate.call(component, record.source, record.streaming);
      } catch (error) {
        diagnostic(`the Pi assistant message content cleanup failed: ${errorMessage(error)}.`);
      }
    }
    Object.defineProperty(prototype, "render", renderDescriptor);
    Object.defineProperty(prototype, "updateContent", updateDescriptor);
    Reflect.deleteProperty(prototype, PATCH_OWNER);
  };

  try {
    Object.defineProperty(prototype, "render", { ...renderDescriptor, value: wrappedRender });
    Object.defineProperty(prototype, "updateContent", {
      ...updateDescriptor,
      value: wrappedUpdate,
    });
    Object.defineProperty(prototype, PATCH_OWNER, {
      configurable: true,
      value: wrappedRender,
    });
  } catch (error) {
    restore();
    throw error;
  }

  let attached = true;
  return () => {
    if (!attached) return;
    attached = false;
    if (prototype.render !== wrappedRender)
      diagnostic("the Pi assistant message render seam changed before cleanup.");
    if (prototype.updateContent !== wrappedUpdate)
      diagnostic("the Pi assistant message update seam changed before cleanup.");
    restore();
  };
}

function readProperty(value: unknown, key: PropertyKey): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null)
    return undefined;
  return Reflect.get(value, key);
}

function readStringProperty(value: unknown, key: PropertyKey): string | undefined {
  const property = readProperty(value, key);
  return typeof property === "string" ? property : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
