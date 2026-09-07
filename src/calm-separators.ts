import { type Component, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

// SAFETY: This is the guarded internal Pi Container compatibility boundary. The prototype
// comes from the installed assistant class, not a potentially different extension dependency.
// oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-reflect-get
const OWNER = Symbol.for("@vistyy/pi-workgraph/calm-separators");
const MESSAGE_MARKER = "·";

type MouseLayout = {
  readonly width: number;
  readonly children: readonly { readonly component: Component; readonly height: number }[];
};

type CalmContainer = {
  readonly children: readonly Component[];
  mouseLayout?: MouseLayout;
};

type ContainerRender = (this: CalmContainer, width: number) => string[];

type PrototypeOwner = {
  readonly render: (width: number) => string[];
  readonly [OWNER]?: unknown;
};
type ContainerPrototype = PrototypeOwner & {
  render: ContainerRender;
};

function isContainerPrototype(value: unknown): value is ContainerPrototype {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof Reflect.get(value, "render") === "function" &&
    typeof Reflect.get(value, "addChild") === "function"
  );
}

function isPrototypeInstance(prototype: PrototypeOwner | undefined, component: Component): boolean {
  return prototype !== undefined && Object.prototype.isPrototypeOf.call(prototype, component);
}

function hasComponentChildren(container: CalmContainer): boolean {
  return Array.isArray(container.children);
}

function firstVisibleRow(lines: readonly string[]): number | undefined {
  const index = lines.findIndex((line) => {
    const visible = stripTerminalSequences(line).trim();
    return visible !== "" && visibleWidth(visible) > 0;
  });
  return index === -1 ? undefined : index;
}

function csiSequenceLength(line: string, index: number): number | undefined {
  const final = /[\u0040-\u007e]/u.exec(line.slice(index + 2));
  return final === null ? undefined : final.index + 3;
}

function terminatedSequenceLength(line: string, index: number): number | undefined {
  const bell = line.indexOf("\u0007", index + 2);
  const stringTerminator = line.indexOf("\u001b\\", index + 2);
  if (bell === -1) return stringTerminator === -1 ? undefined : stringTerminator + 2 - index;
  if (stringTerminator === -1 || bell < stringTerminator) return bell + 1 - index;
  return stringTerminator + 2 - index;
}

function terminalSequenceLength(line: string, index: number): number | undefined {
  if (line[index] !== "\u001b") return undefined;
  const kind = line[index + 1];
  if (kind === "[") return csiSequenceLength(line, index);
  if (kind === "]" || kind === "_") return terminatedSequenceLength(line, index);
  return undefined;
}

function leadingPaddingIndex(line: string): number | undefined {
  let index = 0;
  while (index < line.length) {
    const sequenceLength = terminalSequenceLength(line, index);
    if (sequenceLength !== undefined) {
      index += sequenceLength;
      continue;
    }
    return line[index] === " " ? index : undefined;
  }
  return undefined;
}

function markFirstVisibleRow(line: string, style: (text: string) => string): string {
  const paddingIndex = leadingPaddingIndex(line);
  if (paddingIndex === undefined) return line;
  return `${line.slice(0, paddingIndex)}${style(MESSAGE_MARKER)}${line.slice(paddingIndex + 1)}`;
}

type CalmRender = {
  readonly lines: string[];
  readonly children: { component: Component; height: number }[];
};

function renderCalmChildren(
  sourceChildren: readonly Component[],
  assistantPrototype: PrototypeOwner,
  userPrototype: PrototypeOwner,
  width: number,
  style: (text: string) => string,
): CalmRender {
  const lines: string[] = [];
  const children: { component: Component; height: number }[] = [];
  let hasVisibleAssistant = false;
  for (const child of sourceChildren) {
    const rendered = child.render(width);
    const visibleRow = firstVisibleRow(rendered);
    const assistant = isPrototypeInstance(assistantPrototype, child);
    if (isPrototypeInstance(userPrototype, child) && visibleRow !== undefined) {
      // A user's background already separates the next assistant block from the previous one.
      hasVisibleAssistant = false;
    }
    let childLines = rendered;
    if (assistant && visibleRow !== undefined) {
      if (hasVisibleAssistant) {
        childLines = [...rendered];
        childLines[visibleRow] = markFirstVisibleRow(childLines[visibleRow] ?? "", style);
      }
      hasVisibleAssistant = true;
    }
    children.push({ component: child, height: rendered.length });
    lines.push(...childLines);
  }
  return { lines, children };
}

export function attachCalmSeparators(
  assistantPrototype: PrototypeOwner,
  userPrototype: PrototypeOwner,
  enabled: () => boolean,
  style: (text: string) => string,
  diagnostic: (message: string) => void,
): () => void {
  // SAFETY: Validate the inherited Container seam before adapting its render method.
  const parent = Reflect.getPrototypeOf(assistantPrototype);
  if (!isContainerPrototype(parent) || parent[OWNER] !== undefined)
    throw new Error("the Pi assistant Container render seam is missing or already adapted.");
  const descriptor = Object.getOwnPropertyDescriptor(parent, "render");
  if (descriptor === undefined)
    throw new Error("the Pi assistant Container render descriptor is missing.");
  const original = parent.render;
  const hasMouseLayout = typeof Reflect.get(parent, "handleMouse") === "function";
  const wrapped: ContainerRender = function (this: CalmContainer, width): string[] {
    if (
      !enabled() ||
      !hasComponentChildren(this) ||
      !this.children.some((child) => isPrototypeInstance(assistantPrototype, child))
    )
      return original.call(this, width);

    // Match Pi's Container layout, changing only ephemeral line strings. Never insert children or
    // touch messages; the parent-local layout is recomputed on every redraw.
    const rendered = renderCalmChildren(
      this.children,
      assistantPrototype,
      userPrototype,
      width,
      style,
    );
    // When the host Container has a mouse layout, its dispatcher consumes this render-owned
    // layout. Original child heights and local coordinates remain unchanged.
    if (hasMouseLayout) this.mouseLayout = { width, children: rendered.children };
    return rendered.lines;
  };

  try {
    Object.defineProperty(parent, "render", { ...descriptor, value: wrapped });
    Object.defineProperty(parent, OWNER, { configurable: true, value: wrapped });
  } catch (error) {
    Object.defineProperty(parent, "render", descriptor);
    Reflect.deleteProperty(parent, OWNER);
    throw error;
  }

  let attached = true;
  return () => {
    if (!attached) return;
    attached = false;
    if (parent.render !== wrapped)
      diagnostic("the Pi separator render seam changed before cleanup.");
    Object.defineProperty(parent, "render", descriptor);
    Reflect.deleteProperty(parent, OWNER);
  };
}
