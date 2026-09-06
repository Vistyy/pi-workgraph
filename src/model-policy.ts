import { randomUUID } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This adapter preserves the host's Promise-based atomic file contract.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native paths are part of the public configuration API.
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
    diversity: Type.Optional(StringEnum(["same-model", "distinct-models"] as const)),
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

const RESEARCH_TARGET: ModelTarget = {
  model: "opencode-go/muse-spark-1.3-contributor",
  thinking: "high",
};
const EXECUTOR_TARGET: ModelTarget = {
  model: "openai-codex/gpt-5.6-luna",
  thinking: "high",
};

export const DEFAULT_WORKER_POOL: ModelTarget[] = [
  RESEARCH_TARGET,
  EXECUTOR_TARGET,
  { model: "deepseek/deepseek-v4-flash", thinking: "high" },
  { model: "zai/glm-5.3-flash", thinking: "high" },
  { model: "openai-codex/gpt-5.6-terra", thinking: "high" },
];

export const DEFAULT_MODEL_POLICY: ModelPolicy = {
  version: 3,
  roles: {
    research: RESEARCH_TARGET,
    "implementation.guide": {
      model: "openai-codex/gpt-5.6-sol",
      thinking: "high",
    },
    "implementation.executor": EXECUTOR_TARGET,
    review: RESEARCH_TARGET,
  },
  workerPool: DEFAULT_WORKER_POOL,
};

const PolicyRolesInputSchema = Type.Object(
  {
    research: Type.Optional(Type.Unknown()),
    "implementation.guide": Type.Optional(Type.Unknown()),
    "implementation.executor": Type.Optional(Type.Unknown()),
    review: Type.Optional(Type.Unknown()),
    "discovery.evidence": Type.Optional(Type.Unknown()),
    "verification.product": Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);
const ModelPolicyInputSchema = Type.Object(
  {
    version: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    roles: PolicyRolesInputSchema,
    workerPool: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);
const WorkerPoolSchema = Type.Array(ModelTargetSchema, { minItems: 1 });
type ModelPolicyInput = Static<typeof ModelPolicyInputSchema>;

export function modelPolicyPath(agentDir = getAgentDir()): string {
  return join(agentDir, "workgraph", "models.json");
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON.parse is the external policy boundary; this named decoder establishes its domain type.
function decodeModelPolicyInput(value: unknown): ModelPolicyInput {
  if (!Value.Check(ModelPolicyInputSchema, value))
    throw new Error("Unsupported Workgraph model policy.");
  return Value.Decode(ModelPolicyInputSchema, value);
}

function applyConfiguredRoles(policy: ModelPolicyInput, result: ModelPolicy): void {
  for (const role of MODEL_ROLES) {
    let configured: unknown;
    if (policy.version !== 1) configured = policy.roles[role];
    else {
      switch (role) {
        case "research":
          configured = policy.roles["discovery.evidence"];
          break;
        case "implementation.guide":
        case "implementation.executor":
          configured = policy.roles[role];
          break;
        case "review":
          configured = policy.roles["verification.product"];
          break;
      }
    }
    if (configured === undefined) continue;
    const target: unknown =
      policy.version === 1 && Array.isArray(configured) ? configured[0] : configured;
    if (!Value.Check(ModelTargetSchema, target))
      throw new Error(`Invalid model target for ${role}.`);
    result.roles[role] = Value.Decode(ModelTargetSchema, target);
  }
}

// oxlint-disable-next-line effecttsgo/async-function -- Public host callers and native file I/O use Promise interoperability.
export async function loadModelPolicy(path = modelPolicyPath()): Promise<ModelPolicy> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return structuredClone(DEFAULT_MODEL_POLICY);
    if (error instanceof SyntaxError) throw new Error("Invalid Workgraph model policy JSON.");
    throw error;
  }
  const policy = decodeModelPolicyInput(parsed);
  const result = structuredClone(DEFAULT_MODEL_POLICY);
  applyConfiguredRoles(policy, result);
  if (policy.version === 3 && policy.workerPool !== undefined) {
    if (!Value.Check(WorkerPoolSchema, policy.workerPool))
      throw new Error("Invalid Workgraph worker pool.");
    result.workerPool = Value.Decode(WorkerPoolSchema, policy.workerPool);
  }
  return result;
}

export function resolveSelection(
  role: "research" | "review",
  request: SelectionRequest | undefined,
  policy: ModelPolicy,
): SelectionReceipt {
  const normalized = request ?? {};
  const count = normalized.count ?? 1;
  const diversity = normalized.diversity ?? "same-model";
  if (normalized.override !== undefined)
    return overrideReceipt(role, normalized.override, count, diversity);
  const pool = policy.workerPool.length > 0 ? policy.workerPool : [policy.roles[role]];
  const selected =
    diversity === "same-model"
      ? Array.from({ length: count }, () => policy.roles[role])
      : uniqueTargets(pool).slice(0, count);
  return {
    role,
    requested: count,
    diversity,
    selected,
    unfulfilled:
      selected.length < count
        ? [`Requested ${count} distinct models but policy provides ${selected.length}.`]
        : [],
    source: "policy",
    reason:
      diversity === "distinct-models"
        ? "Selected the first eligible distinct targets in policy order."
        : "Used the role default; repeated independent attempts use the same target by request.",
  };
}

function overrideReceipt(
  role: "research" | "review",
  override: NonNullable<SelectionRequest["override"]>,
  count: number,
  diversity: "same-model" | "distinct-models",
): SelectionReceipt {
  const reason = override.reason.trim();
  if (reason.length === 0) throw new Error("A model override requires a specific reason.");
  const insufficientDiversity = diversity === "distinct-models" && count > 1;
  return {
    role,
    requested: count,
    diversity,
    selected: insufficientDiversity
      ? [override.target]
      : Array.from({ length: count }, () => override.target),
    unfulfilled: insufficientDiversity
      ? [`An explicit override supplies only one distinct model for ${count} requested attempts.`]
      : [],
    source: "override",
    reason,
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

// oxlint-disable-next-line effecttsgo/async-function -- Public host callers and native file I/O use Promise interoperability.
export async function setModelPool(
  pool: ModelTarget[],
  path = modelPolicyPath(),
): Promise<ModelPolicy> {
  if (!Value.Check(WorkerPoolSchema, pool)) throw new Error("Invalid model pool.");
  const policy = await loadModelPolicy(path);
  policy.workerPool = structuredClone(pool);
  return writeModelPolicy(policy, path);
}

// oxlint-disable-next-line effecttsgo/async-function -- Public host callers and native file I/O use Promise interoperability.
export async function setModelRole(
  role: ModelRole,
  target: ModelTarget,
  path = modelPolicyPath(),
): Promise<ModelPolicy> {
  if (!MODEL_ROLES.includes(role) || !Value.Check(ModelTargetSchema, target))
    throw new Error("Invalid model role or target.");
  const policy = await loadModelPolicy(path);
  policy.roles[role] = Value.Decode(ModelTargetSchema, target);
  return writeModelPolicy(policy, path);
}

// oxlint-disable-next-line effecttsgo/async-function -- Atomic native file replacement is deliberately owned by this Promise adapter.
async function writeModelPolicy(pathPolicy: ModelPolicy, path: string): Promise<ModelPolicy> {
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
