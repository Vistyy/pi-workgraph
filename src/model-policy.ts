import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const MODEL_ROLES = [
  "research",
  "implementation.guide",
  "implementation.executor",
  "review",
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
export const ThinkingSchema = StringEnum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const);
export const ModelTargetSchema = Type.Object(
  {
    model: Type.String({ pattern: "^[^/\\s]+/\\S+$" }),
    thinking: ThinkingSchema,
  },
  { additionalProperties: false },
);
export type ModelTarget = Static<typeof ModelTargetSchema>;
export interface ModelPolicy {
  version: 2;
  roles: Record<ModelRole, ModelTarget>;
}
export const DEFAULT_MODEL_POLICY: ModelPolicy = {
  version: 2,
  roles: {
    research: {
      model: "opencode-go/muse-spark-1.3-contributor",
      thinking: "high",
    },
    "implementation.guide": {
      model: "openai-codex/gpt-5.6-sol",
      thinking: "high",
    },
    "implementation.executor": {
      model: "openai-codex/gpt-5.6-luna",
      thinking: "high",
    },
    review: {
      model: "opencode-go/muse-spark-1.3-contributor",
      thinking: "high",
    },
  },
};
const legacyRoles: Record<ModelRole, string> = {
  research: "discovery.evidence",
  "implementation.guide": "implementation.guide",
  "implementation.executor": "implementation.executor",
  review: "verification.product",
};

export function modelPolicyPath(agentDir = getAgentDir()): string {
  return join(agentDir, "workgraph", "models.json");
}

export async function loadModelPolicy(
  path = modelPolicyPath(),
): Promise<ModelPolicy> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return structuredClone(DEFAULT_MODEL_POLICY);
    throw error;
  }
  if (
    !isRecord(parsed) ||
    (parsed.version !== 1 && parsed.version !== 2) ||
    !isRecord(parsed.roles)
  )
    throw new Error("Unsupported Workgraph model policy.");
  const result = structuredClone(DEFAULT_MODEL_POLICY);
  for (const role of MODEL_ROLES) {
    const configured =
      parsed.roles[parsed.version === 1 ? legacyRoles[role] : role];
    if (configured === undefined) continue;
    // The old executor selected the first target. Read mapping never rewrites that file.
    const target: unknown =
      parsed.version === 1 && Array.isArray(configured)
        ? configured[0]
        : configured;
    if (!Value.Check(ModelTargetSchema, target))
      throw new Error(`Invalid model target for ${role}.`);
    result.roles[role] = target;
  }
  return result;
}

export async function setModelRole(
  role: ModelRole,
  target: ModelTarget,
  path = modelPolicyPath(),
): Promise<ModelPolicy> {
  if (!MODEL_ROLES.includes(role) || !Value.Check(ModelTargetSchema, target))
    throw new Error("Invalid model role or target.");
  const policy = await loadModelPolicy(path);
  policy.roles[role] = target;
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(policy, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return policy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
