import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

const SettingsSchema = Type.Object(
  {
    "pi-workgraph": Type.Optional(
      Type.Object(
        {
          delivery: Type.Optional(
            Type.Object(
              {
                deferredTools: Type.Array(Type.String({ minLength: 1, pattern: "^\\S+$" })),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

interface LoaderResult {
  readonly loaded: readonly string[];
  readonly missing: readonly string[];
}

export const deliverySettingsPath = (agentDir = getAgentDir()): string =>
  join(agentDir, "settings.json");

export function loadDeferredDeliveryTools(path = deliverySettingsPath()): readonly string[] {
  let source: string;

  try {
    source = readFileSync(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`Invalid JSON in ${path}.`);
  }

  if (!Value.Check(SettingsSchema, parsed))
    throw new Error(
      `Invalid pi-workgraph.delivery.deferredTools in ${path}; expected an array of non-whitespace tool names.`,
    );

  const configured = Value.Decode(SettingsSchema, parsed)["pi-workgraph"]?.delivery?.deferredTools;

  return configured === undefined ? [] : [...new Set(configured)];
}

const deliveryLoaderName = "workgraph_load_delivery_tools";

export function installDeliveryTools(pi: ExtensionAPI, configured: readonly string[]): void {
  const names = [...new Set(["workgraph_deliver", ...configured])];

  const setActiveTools = (next: readonly string[]): void => {
    const active = pi.getActiveTools();

    if (next.length !== active.length || next.some((name, index) => name !== active[index]))
      pi.setActiveTools([...next]);
  };

  const activate = (): LoaderResult => {
    const active = pi.getActiveTools();
    const available = new Set(pi.getAllTools().map(({ name }) => name));
    const loaded = names.filter((name) => available.has(name) && !active.includes(name));
    const missing = names.filter((name) => !available.has(name));

    setActiveTools([...active.filter((name) => name !== deliveryLoaderName), ...loaded]);

    return { loaded, missing };
  };

  const restore = (ctx: ExtensionContext): void => {
    const loaded = ctx.sessionManager
      .getBranch()
      .some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolName === deliveryLoaderName &&
          !entry.message.isError,
      );

    if (loaded) {
      activate();

      return;
    }

    const deferred = new Set(names);

    const active = pi
      .getActiveTools()
      .filter((name) => !deferred.has(name) && name !== deliveryLoaderName);

    setActiveTools([...active, deliveryLoaderName]);
  };

  pi.registerTool({
    name: deliveryLoaderName,
    label: "Load Delivery Tools",
    description:
      "Load the configured delivery tools when an accepted repository change reaches the delivery boundary. Loading a tool does not authorize delivery actions.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute() {
      const receipt = activate();

      return Promise.resolve({
        content: [{ type: "text" as const, text: JSON.stringify(receipt, null, 2) }],
        details: receipt,
      });
    },
  });

  const restoreIfAvailable = (ctx: ExtensionContext): void => {
    try {
      restore(ctx);
    } catch (cause) {
      if (!(cause instanceof Error && cause.message.includes("runtime not initialized")))
        throw cause;
    }
  };

  pi.on("session_start", (_event, ctx) => restoreIfAvailable(ctx));
  pi.on("session_tree", (_event, ctx) => restoreIfAvailable(ctx));
}
