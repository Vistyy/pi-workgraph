import type { Component } from "@earendil-works/pi-tui";

// SAFETY: This is the guarded internal Pi Container compatibility boundary. The prototype
// comes from the installed assistant class, not a potentially different extension dependency.
// oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-reflect-get
const OWNER = Symbol.for("@vistyy/pi-workgraph/calm-separators");
const RULE_WIDTH = 8;
const RULE_CHARACTER = "─";

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

function isAssistantPrototype(prototype: PrototypeOwner, component: Component): boolean {
  return Object.prototype.isPrototypeOf.call(prototype, component);
}

function hasComponentChildren(container: CalmContainer): boolean {
  return Array.isArray(container.children);
}

function separatorComponent(lines: readonly string[]): Component {
  return {
    render: () => [...lines],
    invalidate() {},
  };
}

type CalmRender = {
  readonly lines: string[];
  readonly children: { component: Component; height: number }[];
};

function renderCalmChildren(
  sourceChildren: readonly Component[],
  assistantPrototype: PrototypeOwner,
  width: number,
  style: (text: string) => string,
): CalmRender {
  const lines: string[] = [];
  const children: { component: Component; height: number }[] = [];
  let hasVisibleAssistant = false;
  for (const child of sourceChildren) {
    const rendered = child.render(width);
    const assistant = isAssistantPrototype(assistantPrototype, child);
    if (assistant && rendered.length > 0) {
      if (hasVisibleAssistant && width > 0) {
        const rule = style(
          RULE_CHARACTER.repeat(Math.min(RULE_WIDTH, Math.max(1, Math.floor(width)))),
        );
        const separatorLines = ["", rule, ""];
        lines.push(...separatorLines);
        children.push({
          component: separatorComponent(separatorLines),
          height: separatorLines.length,
        });
      }
      hasVisibleAssistant = true;
    }
    children.push({ component: child, height: rendered.length });
    lines.push(...rendered);
  }
  return { lines, children };
}

export function attachCalmSeparators(
  assistantPrototype: PrototypeOwner,
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
      !this.children.some((child) => isAssistantPrototype(assistantPrototype, child))
    )
      return original.call(this, width);

    // Match Pi's Container layout, adding only ephemeral rows. Never insert children or touch
    // messages; the parent-local layout is recomputed on every redraw.
    const rendered = renderCalmChildren(this.children, assistantPrototype, width, style);
    // When the host Container has a mouse layout, its dispatcher consumes this render-owned
    // layout. Separator rows absorb events while original children retain their local coordinates.
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
