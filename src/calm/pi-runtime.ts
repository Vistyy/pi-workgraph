// SAFETY: This module only reads the running Pi installation to locate its presentation module.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { readdir, readFile } from "node:fs/promises";
// SAFETY: These paths identify the read-only running Pi installation; no installed file is modified.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { dirname, join } from "node:path";
// SAFETY: This converts the discovered running module path to an import URL only.
import { pathToFileURL } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AssistantMessageComponent,
  SkillInvocationMessageComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { Component, Container } from "@earendil-works/pi-tui";

/**
 * Calm must classify the classes the running Pi actually instantiates.
 *
 * A bundled Pi CLI loads its own private copies of the presentation classes, so statically imported
 * public `@earendil-works` values compare unequal to the live instances. This boundary therefore
 * loads the *running* Pi module and validates its exports before Calm uses them; a mismatch fails
 * Calm visibly instead of silently rendering a partial transcript. It never rewrites Pi state.
 */

// SAFETY: The running Pi module is external input; exports and constructor shapes are validated here.
// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-reflect-get, anti-slop/no-chained-type-assertions, effecttsgo/async-function

type CalmAssistantConstructor = new (message?: AssistantMessage) => AssistantMessageComponent;
type CalmUserConstructor = new (text: string) => UserMessageComponent;
type CalmSkillConstructor = new (...args: never[]) => SkillInvocationMessageComponent;
export type CalmComponentConstructor = new (...args: never[]) => Component;
type CalmContainerConstructor = new () => Container;

export interface CalmChatRuntime {
  readonly assistant: CalmAssistantConstructor;
  readonly user: CalmUserConstructor;
  readonly skill: CalmSkillConstructor;
  readonly toolExecution: CalmComponentConstructor;
  readonly customMessage: CalmComponentConstructor;
  readonly container: CalmContainerConstructor;
}

const MESSAGE_EXPORTS = [
  "AssistantMessageComponent",
  "UserMessageComponent",
  "SkillInvocationMessageComponent",
  "ToolExecutionComponent",
  "CustomMessageComponent",
] as const;

/**
 * Load the presentation classes from the module the running Pi entrypoint actually uses.
 *
 * The running bundle re-exports its private classes from a sibling `index.js`, so that candidate is
 * tried first (its module graph is already loaded and cached). A `chunks` fallback covers layouts
 * that only expose hashed chunk files, and the entrypoint itself covers SDK-style public entries.
 */
export async function loadCalmChatRuntime(entrypoint = process.argv[1]): Promise<CalmChatRuntime> {
  if (entrypoint === undefined || entrypoint === "")
    throw new Error("the running Pi entrypoint is unknown.");
  for (const url of await runtimeModuleUrls(entrypoint)) {
    const runtime = await tryLoadRuntime(url);
    if (runtime !== undefined) return runtime;
  }
  throw new Error("the running Pi presentation module could not be loaded.");
}

async function runtimeModuleUrls(entrypoint: string): Promise<readonly string[]> {
  const directory = dirname(entrypoint);
  const urls = [pathToFileURL(join(directory, "index.js")).href];
  urls.push(...(await chunkModuleUrls(directory)));
  urls.push(pathToFileURL(entrypoint).href);
  return urls;
}

async function chunkModuleUrls(directory: string): Promise<readonly string[]> {
  const chunks = join(directory, "chunks");
  let names: readonly string[];
  try {
    names = await readdir(chunks);
  } catch {
    return [];
  }
  const urls: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".js")) continue;
    const path = join(chunks, name);
    try {
      const source = await readFile(path, "utf8");
      if (MESSAGE_EXPORTS.every((exportName) => source.includes(exportName)))
        urls.push(pathToFileURL(path).href);
    } catch {
      // An unreadable chunk is not a usable runtime module.
    }
  }
  return urls;
}

async function tryLoadRuntime(url: string): Promise<CalmChatRuntime | undefined> {
  let loaded: unknown;
  try {
    loaded = await import(url);
  } catch {
    return undefined;
  }
  return decodeCalmChatRuntime(loaded);
}

function decodeCalmChatRuntime(module: unknown): CalmChatRuntime | undefined {
  const assistant = readProperty(module, "AssistantMessageComponent");
  const user = readProperty(module, "UserMessageComponent");
  const skill = readProperty(module, "SkillInvocationMessageComponent");
  const toolExecution = readProperty(module, "ToolExecutionComponent");
  const customMessage = readProperty(module, "CustomMessageComponent");
  if (!isAssistantConstructor(assistant)) return undefined;
  if (
    !isComponentConstructor(user) ||
    !isComponentConstructor(skill) ||
    !isComponentConstructor(toolExecution) ||
    !isComponentConstructor(customMessage)
  )
    return undefined;
  // Pi's assistant component extends the same private Container the live chat uses; deriving the
  // container from that prototype parent keeps discovery and the projection aligned with Pi.
  const parent: unknown = Object.getPrototypeOf(assistant.prototype);
  const container: unknown = readProperty(parent, "constructor");
  if (!isComponentConstructor(container)) return undefined;
  // SAFETY: The guarded checks above established every constructor shape; this assertion only
  // names the validated runtime interface for callers.
  return {
    assistant,
    user,
    skill,
    toolExecution,
    customMessage,
    container,
  } as unknown as CalmChatRuntime;
}

function isComponentConstructor(value: unknown): value is new () => Component {
  if (typeof value !== "function") return false;
  const prototype = readProperty(value, "prototype");
  return typeof readProperty(prototype, "render") === "function";
}

function isAssistantConstructor(
  value: unknown,
): value is CalmAssistantConstructor & { prototype: object } {
  if (!isComponentConstructor(value)) return false;
  return typeof readProperty(value.prototype, "updateContent") === "function";
}

function readProperty(value: unknown, key: PropertyKey): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null)
    return undefined;
  return Reflect.get(value, key);
}
