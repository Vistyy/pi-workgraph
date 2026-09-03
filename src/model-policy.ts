import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./types.js";

export const MODEL_ROLES = [
  "discovery.partition",
  "discovery.evidence",
  "discovery.replicate",
  "discovery.synthesis",
  "implementation.guide",
  "implementation.executor",
  "verification.product",
  "assurance.behavior",
  "assurance.structure",
  "assurance.evidence",
  "assurance.synthesis",
] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];

export interface ModelTarget {
  model: string;
  thinking: ThinkingLevel;
}

export interface ModelPolicy {
  version: 1;
  roles: Record<ModelRole, ModelTarget[]>;
}

export const DEFAULT_MODEL_POLICY: ModelPolicy = {
  version: 1,
  roles: {
    "discovery.partition": [{ model: "opencode-go/muse-spark-1.3-contributor", thinking: "high" }],
    "discovery.evidence": [{ model: "opencode-go/muse-spark-1.3-contributor", thinking: "high" }],
    "discovery.replicate": [
      { model: "opencode-go/muse-spark-1.3-contributor", thinking: "high" },
      { model: "openai-codex/gpt-5.6-terra", thinking: "high" },
      { model: "opencode-go/glm-5.3-flash", thinking: "high" },
      { model: "opencode-go/deepseek-v4-flash", thinking: "high" },
    ],
    "discovery.synthesis": [{ model: "openai-codex/gpt-5.6-sol", thinking: "high" }],
    "implementation.guide": [{ model: "openai-codex/gpt-5.6-sol", thinking: "high" }],
    "implementation.executor": [{ model: "openai-codex/gpt-5.6-luna", thinking: "high" }],
    "verification.product": [{ model: "opencode-go/muse-spark-1.3-contributor", thinking: "high" }],
    "assurance.behavior": [{ model: "opencode-go/deepseek-v4-flash", thinking: "high" }],
    "assurance.structure": [{ model: "opencode-go/muse-spark-1.3-contributor", thinking: "high" }],
    "assurance.evidence": [{ model: "opencode-go/glm-5.3-flash", thinking: "high" }],
    "assurance.synthesis": [{ model: "openai-codex/gpt-5.6-luna", thinking: "high" }],
  },
};

export function modelPolicyPath(agentDir = getAgentDir()): string {
  return join(agentDir, "workgraph", "models.json");
}

export async function loadModelPolicy(path = modelPolicyPath()): Promise<ModelPolicy> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return validateModelPolicy(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_MODEL_POLICY);
    throw error;
  }
}

export async function setModelRole(role: ModelRole, targets: ModelTarget[], path = modelPolicyPath()): Promise<ModelPolicy> {
  if (targets.length < 1 || targets.length > 4) throw new Error("A model role requires between one and four targets.");
  const policy = await loadModelPolicy(path);
  policy.roles[role] = targets.map(validateModelTarget);
  await writePolicy(path, policy);
  return policy;
}

export function roleTargets(policy: ModelPolicy, role: ModelRole): ModelTarget[] {
  const targets = policy.roles[role];
  if (targets.length === 0) throw new Error(`Model role ${role} has no target.`);
  return targets.map((target) => ({ ...target }));
}

function validateModelPolicy(value: unknown): ModelPolicy {
  if (!value || typeof value !== "object") throw new Error("Workgraph model policy must be an object.");
  const candidate = value as { version?: unknown; roles?: unknown };
  if (candidate.version !== 1 || !candidate.roles || typeof candidate.roles !== "object") {
    throw new Error("Unsupported Workgraph model policy version.");
  }
  const roles = candidate.roles as Record<string, unknown>;
  const result = structuredClone(DEFAULT_MODEL_POLICY);
  for (const role of MODEL_ROLES) {
    const configured = roles[role];
    if (configured === undefined) continue;
    if (!Array.isArray(configured) || configured.length < 1 || configured.length > 4) {
      throw new Error(`Model role ${role} requires between one and four targets.`);
    }
    result.roles[role] = configured.map(validateModelTarget);
  }
  return result;
}

function validateModelTarget(value: unknown): ModelTarget {
  if (!value || typeof value !== "object") throw new Error("A model target must be an object.");
  const candidate = value as { model?: unknown; thinking?: unknown };
  if (typeof candidate.model !== "string" || !/^[^/]+\/.+$/.test(candidate.model)) {
    throw new Error(`Model target must use provider/model: ${String(candidate.model)}`);
  }
  const thinking = candidate.thinking;
  if (thinking !== "off" && thinking !== "minimal" && thinking !== "low" && thinking !== "medium" && thinking !== "high" && thinking !== "xhigh" && thinking !== "max") {
    throw new Error(`Invalid thinking level for ${candidate.model}: ${String(thinking)}`);
  }
  return { model: candidate.model, thinking };
}

async function writePolicy(path: string, policy: ModelPolicy): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(policy, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}
