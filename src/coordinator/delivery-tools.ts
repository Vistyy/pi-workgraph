import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const ToolNameSchema = Type.String({ minLength: 1, pattern: "^\\S+$" });

const DeliverySettingsSchema = Type.Object(
  { deferredTools: Type.Array(ToolNameSchema) },
  { additionalProperties: false },
);

const WorkgraphSettingsSchema = Type.Object(
  { delivery: Type.Optional(Type.Unknown()) },
  { additionalProperties: true },
);

const GlobalSettingsSchema = Type.Object(
  { "pi-workgraph": Type.Optional(Type.Unknown()) },
  { additionalProperties: true },
);

const LoaderResultSchema = Type.Object(
  {
    loaded: Type.Array(Type.String()),
    alreadyActive: Type.Array(Type.String()),
    missing: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

type LoaderResult = Static<typeof LoaderResultSchema>;

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

  if (!Value.Check(GlobalSettingsSchema, parsed))
    throw new Error(`Invalid pi-workgraph settings in ${path}.`);

  const workgraph = Value.Decode(GlobalSettingsSchema, parsed)["pi-workgraph"];

  if (workgraph === undefined) return [];

  if (!Value.Check(WorkgraphSettingsSchema, workgraph))
    throw new Error(`Invalid pi-workgraph.delivery settings in ${path}.`);

  const delivery = Value.Decode(WorkgraphSettingsSchema, workgraph).delivery;

  if (delivery === undefined) return [];

  if (!Value.Check(DeliverySettingsSchema, delivery))
    throw new Error(
      `Invalid pi-workgraph.delivery.deferredTools in ${path}; expected an array of non-whitespace tool names.`,
    );

  return [...new Set(Value.Decode(DeliverySettingsSchema, delivery).deferredTools)];
}

class DeliveryToolVisibility {
  readonly configured: readonly string[];

  constructor(configured: readonly string[]) {
    this.configured = [...new Set(configured)];
  }

  initial(active: readonly string[], loaderName: string): readonly string[] {
    const deferred = new Set(this.configured);
    const retained = active.filter((name) => !deferred.has(name) && name !== loaderName);

    return [...retained, loaderName];
  }

  load(active: readonly string[], available: readonly string[]): LoaderResult {
    const activeNames = new Set(active);
    const availableNames = new Set(available);
    const loaded: string[] = [];
    const alreadyActive: string[] = [];
    const missing: string[] = [];

    for (const name of this.configured) {
      if (activeNames.has(name)) alreadyActive.push(name);
      else if (availableNames.has(name)) {
        loaded.push(name);
        activeNames.add(name);
      } else missing.push(name);
    }

    return { loaded, alreadyActive, missing };
  }

  isLoaded(branch: readonly SessionEntry[], loaderName: string): boolean {
    return branch.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === loaderName &&
        !entry.message.isError &&
        Value.Check(LoaderResultSchema, entry.message.details),
    );
  }
}

export const deliveryLoaderName = "workgraph_load_delivery_tools";

export function installDeliveryTools(pi: ExtensionAPI, configured: readonly string[]): void {
  if (configured.length === 0) return;

  const visibility = new DeliveryToolVisibility(configured);
  const availableNames = (): string[] => pi.getAllTools().map(({ name }) => name);

  const activate = (): LoaderResult => {
    const active = pi.getActiveTools();
    const receipt = visibility.load(active, availableNames());
    const next = [...active, ...receipt.loaded];

    if (!next.includes(deliveryLoaderName)) next.push(deliveryLoaderName);

    if (next.length !== active.length || next.some((name, index) => name !== active[index]))
      pi.setActiveTools(next);

    return receipt;
  };

  const restore = (ctx: ExtensionContext): void => {
    const branch = ctx.sessionManager.getBranch();

    if (visibility.isLoaded(branch, deliveryLoaderName)) {
      activate();

      return;
    }

    const active = pi.getActiveTools();
    const next = visibility.initial(active, deliveryLoaderName);

    if (next.length !== active.length || next.some((name, index) => name !== active[index]))
      pi.setActiveTools([...next]);
  };

  pi.registerTool({
    name: deliveryLoaderName,
    label: "Load Delivery Tools",
    description:
      "Load configured tools for guided review and pull-request follow or unfollow. Use this at the delivery boundary or when the user asks for one of those capabilities. Loading a tool does not authorize its actions.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute() {
      const receipt = activate();

      return Promise.resolve({
        content: [{ type: "text" as const, text: JSON.stringify(receipt, null, 2) }],
        details: receipt,
      });
    },
  });

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
}
