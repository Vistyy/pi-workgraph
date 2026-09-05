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
export type Thinking = Static<typeof ThinkingSchema>;
export const ModelTargetSchema = Type.Object(
  {
    model: Type.String({ pattern: "^[^/\\s]+/\\S+$" }),
    thinking: ThinkingSchema,
  },
  { additionalProperties: false },
);
export type ModelTarget = Static<typeof ModelTargetSchema>;
export const SelectionRequestSchema = Type.Object(
  {
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
    diversity: Type.Optional(
      StringEnum(["same-model", "distinct-models"] as const),
    ),
    override: Type.Optional(
      Type.Object(
        { target: ModelTargetSchema, reason: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type SelectionRequest = Static<typeof SelectionRequestSchema>;

export interface ModelPolicy {
  version: 3;
  roles: Record<ModelRole, ModelTarget>;
  workerPool: ModelTarget[];
}

export const DEFAULT_WORKER_POOL: ModelTarget[] = [
  {
    model: "opencode-go/muse-spark-1.3-contributor",
    thinking: "high",
  },
  { model: "openai-codex/gpt-5.6-luna", thinking: "high" },
  { model: "deepseek/deepseek-v4-flash", thinking: "high" },
  { model: "zai/glm-5.3-flash", thinking: "high" },
  { model: "openai-codex/gpt-5.6-terra", thinking: "high" },
];

export const DEFAULT_MODEL_POLICY: ModelPolicy = {
  version: 3,
  roles: {
    research: DEFAULT_WORKER_POOL[0]!,
    "implementation.guide": {
      model: "openai-codex/gpt-5.6-sol",
      thinking: "high",
    },
    "implementation.executor": DEFAULT_WORKER_POOL[1]!,
    review: DEFAULT_WORKER_POOL[0]!,
  },
  workerPool: DEFAULT_WORKER_POOL,
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
    ![1, 2, 3].includes(parsed.version as number) ||
    !isRecord(parsed.roles)
  )
    throw new Error("Unsupported Workgraph model policy.");

  const result = structuredClone(DEFAULT_MODEL_POLICY);
  for (const role of MODEL_ROLES) {
    const configured =
      parsed.roles[parsed.version === 1 ? legacyRoles[role] : role];
    if (configured === undefined) continue;
    const target: unknown =
      parsed.version === 1 && Array.isArray(configured)
        ? configured[0]
        : configured;
    if (!Value.Check(ModelTargetSchema, target))
      throw new Error(`Invalid model target for ${role}.`);
    result.roles[role] = target;
  }
  if (parsed.version === 3 && parsed.workerPool !== undefined) {
    if (
      !Array.isArray(parsed.workerPool) ||
      parsed.workerPool.length === 0 ||
      !parsed.workerPool.every((target) =>
        Value.Check(ModelTargetSchema, target),
      )
    )
      throw new Error("Invalid Workgraph worker pool.");
    result.workerPool = parsed.workerPool as ModelTarget[];
  }
  return result;
}

export function resolveSelection(
  role: "research" | "review",
  request: SelectionRequest | undefined,
  policy: ModelPolicy,
): SelectionReceipt {
  const normalized = request ?? {};
  const override = normalized.override;
  if (override) {
    if (!override.reason.trim())
      throw new Error("A model override requires a specific reason.");
    const count = normalized.count ?? 1;
    const diversity = normalized.diversity ?? "same-model";
    return {
      role,
      requested: count,
      diversity,
      selected:
        diversity === "distinct-models" && count > 1
          ? [override.target]
          : Array.from({ length: count }, () => override.target),
      unfulfilled:
        diversity === "distinct-models" && count > 1
          ? [
              `An explicit override supplies only one distinct model for ${count} requested attempts.`,
            ]
          : [],
      source: "override",
      reason: override.reason.trim(),
    };
  }
  const count = normalized.count ?? 1;
  const diversity = normalized.diversity ?? "same-model";
  const pool =
    policy.workerPool.length > 0 ? policy.workerPool : [policy.roles[role]];
  const selected =
    diversity === "same-model"
      ? Array.from({ length: count }, () => policy.roles[role])
      : uniqueTargets(pool).slice(0, count);
  const unfulfilled =
    selected.length < count
      ? [
          `Requested ${count} distinct models but policy provides ${selected.length}.`,
        ]
      : [];
  return {
    role,
    requested: count,
    diversity,
    selected,
    unfulfilled,
    source: "policy",
    reason:
      diversity === "distinct-models"
        ? "Selected the first eligible distinct targets in policy order."
        : "Used the role default; repeated independent attempts use the same target by request.",
  };
}

export interface SelectionReceipt {
  role: "research" | "review";
  requested: number;
  diversity: "same-model" | "distinct-models";
  selected: ModelTarget[];
  unfulfilled: string[];
  source: "policy" | "override";
  reason: string;
}

function uniqueTargets(targets: ModelTarget[]): ModelTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.model}\0${target.thinking}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function setModelPool(
  pool: ModelTarget[],
  path = modelPolicyPath(),
): Promise<ModelPolicy> {
  if (
    pool.length === 0 ||
    !pool.every((target) => Value.Check(ModelTargetSchema, target))
  )
    throw new Error("Invalid model pool.");
  const policy = await loadModelPolicy(path);
  policy.workerPool = structuredClone(pool);
  return writeModelPolicy(policy, path);
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
  if (role === "research" || role === "review") {
    policy.workerPool = [
      target,
      ...policy.workerPool.filter(
        (candidate) => candidate.model !== target.model,
      ),
    ];
  }
  return writeModelPolicy(policy, path);
}

async function writeModelPolicy(
  pathPolicy: ModelPolicy,
  path: string,
): Promise<ModelPolicy> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(pathPolicy, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return pathPolicy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
