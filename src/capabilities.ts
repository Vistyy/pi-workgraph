import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const WEB_TOOLS = ["web_search", "source_check", "fetch_content", "get_search_content"] as const;
export const WEB_PACKAGE = "npm:pi-web-access@0.14.0" as const;
export const CODEX_PACKAGE = "pi-openai-remote-compaction" as const;
export interface ChildCapability { id: "web_access" | "codex_remote_compaction"; packageSource: string; resourceIdentity: string; resourcePath?: string; version?: string; tools: string[]; available: boolean; diagnostic?: string; }
type PackageJson = { name?: string; version?: string; pi?: { extensions?: string[] } };

export async function resolveChildCapabilities(mode: string, model: string, root = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")): Promise<ChildCapability[]> {
  const result: ChildCapability[] = [];
  if (mode === "discovery") result.push(await resolvePackage("web_access", "pi-web-access", WEB_PACKAGE, [...WEB_TOOLS], root));
  if (model.startsWith("openai-codex/")) result.push(await resolvePackage("codex_remote_compaction", "pi-openai-remote-compaction", CODEX_PACKAGE, [], root));
  return result;
}

async function resolvePackage(id: ChildCapability["id"], name: string, source: string, tools: string[], root: string): Promise<ChildCapability> {
  const base: ChildCapability = { id, packageSource: source, resourceIdentity: `${name}:extension`, tools, available: false };
  const paths = [join(root, "node_modules", name, "package.json"), join(root, "npm", "node_modules", name, "package.json"), join(root, "extensions", "openai-remote-compaction", "package.json")];
  let path: string | undefined;
  for (const candidate of paths) { try { await access(candidate); path = candidate; break; } catch {} }
  if (!path) return { ...base, diagnostic: `Capability ${source} is unavailable; install it once through Pi package management.` };
  let pkg: PackageJson;
  try { pkg = JSON.parse(await readFile(path, "utf8")) as PackageJson; } catch { return { ...base, diagnostic: `Capability metadata for ${source} is unreadable.` }; }
  const resource = pkg.pi?.extensions?.[0];
  if (!resource) return { ...base, ...(pkg.version ? { version: pkg.version } : {}), diagnostic: `Installed ${name} package declares no extension resource.` };
  const versionOk = id === "web_access" ? pkg.version === "0.14.0" : true;
  return { ...base, ...(pkg.version ? { version: pkg.version } : {}), resourceIdentity: `${pkg.name ?? name}:${resource}`, resourcePath: join(path.slice(0, -"package.json".length), resource), available: versionOk, ...(versionOk ? {} : { diagnostic: `Expected pi-web-access 0.14.0, found ${pkg.version ?? "unknown"}.` }) };
}
