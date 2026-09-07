import { randomUUID } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native paths are part of the public configuration API.
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Data, Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { runNodePlatformPromise } from "./node-platform.js";

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

export type ModelPolicyOperation = "parse" | "decode" | "temporary-path";

export class ModelPolicyError extends Data.TaggedError("ModelPolicyError")<{
  readonly operation: ModelPolicyOperation;
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
}> {
  override readonly name = "Error";
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
  { model: "opencode-go/deepseek-v4-flash", thinking: "high" },
  { model: "opencode-go/glm-5.3-flash", thinking: "high" },
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

export function loadModelPolicyEffect(
  path = modelPolicyPath(),
): Effect.Effect<ModelPolicy, ModelPolicyError | PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const contents = yield* fileSystem.readFileString(path).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.void,
      ),
    );
    if (contents === undefined) return structuredClone(DEFAULT_MODEL_POLICY);
    const parsed = yield* Effect.try({
      // oxlint-disable-next-line anti-slop/no-unknown-returns, effecttsgo/prefer-schema-over-json -- The established TypeBox decoder immediately validates this external JSON value.
      try: (): unknown => JSON.parse(contents),
      catch: () =>
        new ModelPolicyError({
          operation: "parse",
          path,
          message: "Invalid Workgraph model policy JSON.",
        }),
    });
    return yield* decodeModelPolicyEffect(parsed, path);
  });
}

/** Promise facade for current Pi host callers. */
export function loadModelPolicy(path = modelPolicyPath()): Promise<ModelPolicy> {
  return runNodePlatformPromise(loadModelPolicyEffect(path));
}

function decodeModelPolicyEffect(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This boundary immediately validates the parsed JSON with the established TypeBox schema.
  parsed: unknown,
  path: string,
): Effect.Effect<ModelPolicy, ModelPolicyError> {
  return Effect.try({
    try: () => {
      const policy = decodeModelPolicyInput(parsed);
      const result = structuredClone(DEFAULT_MODEL_POLICY);
      applyConfiguredRoles(policy, result);
      if (policy.version === 3 && policy.workerPool !== undefined) {
        if (!Value.Check(WorkerPoolSchema, policy.workerPool))
          throw new Error("Invalid Workgraph worker pool.");
        result.workerPool = Value.Decode(WorkerPoolSchema, policy.workerPool);
      }
      return result;
    },
    catch: (cause) =>
      new ModelPolicyError({
        operation: "decode",
        path,
        message: cause instanceof Error ? cause.message : "Invalid Workgraph model policy.",
        cause,
      }),
  });
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

export function setModelPoolEffect(
  pool: ModelTarget[],
  path = modelPolicyPath(),
): Effect.Effect<ModelPolicy, ModelPolicyError | PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    if (!Value.Check(WorkerPoolSchema, pool))
      return yield* new ModelPolicyError({
        operation: "decode",
        path,
        message: "Invalid model pool.",
      });
    const policy = yield* loadModelPolicyEffect(path);
    policy.workerPool = structuredClone(pool);
    return yield* writeModelPolicyEffect(policy, path);
  });
}

/** Promise facade for current Pi host callers. */
export function setModelPool(pool: ModelTarget[], path = modelPolicyPath()): Promise<ModelPolicy> {
  return runNodePlatformPromise(setModelPoolEffect(pool, path));
}

export function setModelRoleEffect(
  role: ModelRole,
  target: ModelTarget,
  path = modelPolicyPath(),
): Effect.Effect<ModelPolicy, ModelPolicyError | PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    if (!MODEL_ROLES.includes(role) || !Value.Check(ModelTargetSchema, target))
      return yield* new ModelPolicyError({
        operation: "decode",
        path,
        message: "Invalid model role or target.",
      });
    const policy = yield* loadModelPolicyEffect(path);
    policy.roles[role] = Value.Decode(ModelTargetSchema, target);
    return yield* writeModelPolicyEffect(policy, path);
  });
}

/** Promise facade for current Pi host callers. */
export function setModelRole(
  role: ModelRole,
  target: ModelTarget,
  path = modelPolicyPath(),
): Promise<ModelPolicy> {
  return runNodePlatformPromise(setModelRoleEffect(role, target, path));
}

function writeModelPolicyEffect(
  pathPolicy: ModelPolicy,
  path: string,
): Effect.Effect<ModelPolicy, ModelPolicyError | PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    yield* fileSystem.makeDirectory(paths.dirname(path), { recursive: true });
    const temporaryPath = yield* Effect.try({
      try: () => `${path}.${process.pid}.${randomUUID()}.tmp`,
      catch: (cause) =>
        new ModelPolicyError({
          operation: "temporary-path",
          path,
          message: "Could not create a temporary model policy path.",
          cause,
        }),
    });
    const replace = Effect.gen(function* () {
      // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- The established TypeBox-owned policy is serialized in its existing human-readable format.
      yield* fileSystem.writeFileString(temporaryPath, `${JSON.stringify(pathPolicy, null, 2)}\n`, {
        mode: 0o600,
      });
      yield* fileSystem.rename(temporaryPath, path);
    });
    const replacement = yield* Effect.exit(replace);
    yield* fileSystem.remove(temporaryPath, { force: true });
    yield* replacement;
    return pathPolicy;
  });
}
