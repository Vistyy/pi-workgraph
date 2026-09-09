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
  "consultation.enricher",
  "consultation.advisor",
] as const;
const MODEL_LIST_ROLES = ["research", "review"] as const;
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
export const ModelChoiceSchema = ModelTargetSchema;
export type ModelChoice = Static<typeof ModelChoiceSchema>;

/** Policy values are exact executable targets; list order is only a research/review selection choice. */
function exactTarget(target: ModelTarget): ModelTarget {
  return { model: target.model, thinking: target.thinking };
}
const TargetOverrideSchema = Type.Object(
  {
    model: Type.Optional(Type.String({ pattern: "^[^/\\s]+/\\S+$" })),
    thinking: Type.Optional(ThinkingSchema),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type TargetOverride = Static<typeof TargetOverrideSchema>;
export const ImplementationModelOverridesSchema = Type.Object(
  {
    guide: Type.Optional(TargetOverrideSchema),
    executor: Type.Optional(TargetOverrideSchema),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type ImplementationModelOverrides = Static<typeof ImplementationModelOverridesSchema>;
export const SelectionRequestSchema = Type.Object(
  {
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
    diversity: Type.Optional(StringEnum(["same-model", "distinct-models"] as const)),
    override: Type.Optional(TargetOverrideSchema),
  },
  { additionalProperties: false },
);
export type SelectionRequest = Static<typeof SelectionRequestSchema>;

export type ListModelRole = "research" | "review";
export type ImplementationModelRole = "implementation.guide" | "implementation.executor";
export type ModelTargetList = [ModelChoice, ...ModelChoice[]];

export interface ModelPolicy {
  version: 5;
  roles: Record<
    ImplementationModelRole | "consultation.enricher" | "consultation.advisor",
    ModelTarget
  > &
    Record<ListModelRole, ModelTargetList>;
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

const DEFAULT_RESEARCH_MODELS: ModelTargetList = [
  { model: "openai-codex/gpt-5.6-luna", thinking: "high" },
];
const DEFAULT_REVIEW_MODELS: ModelTargetList = [
  { model: "openai-codex/gpt-5.6-terra", thinking: "high" },
  { model: "opencode-go/deepseek-v4-flash", thinking: "high" },
  { model: "opencode-go/glm-5.3-flash", thinking: "high" },
];
const DEFAULT_GUIDE_TARGET: ModelTarget = {
  model: "openai-codex/gpt-6-astra",
  thinking: "low",
};
const DEFAULT_EXECUTOR_TARGET: ModelTarget = {
  model: "openai-codex/gpt-5.6-luna",
  thinking: "xhigh",
};

export const DEFAULT_MODEL_POLICY: ModelPolicy = {
  version: 5,
  roles: {
    "consultation.enricher": { model: "openai-codex/gpt-5.6-luna", thinking: "high" },
    "consultation.advisor": { model: "openai-codex/gpt-6-astra", thinking: "high" },
    research: DEFAULT_RESEARCH_MODELS,
    "implementation.guide": DEFAULT_GUIDE_TARGET,
    "implementation.executor": DEFAULT_EXECUTOR_TARGET,
    review: DEFAULT_REVIEW_MODELS,
  },
};

const PolicyRolesInputSchema = Type.Object(
  {
    research: Type.Optional(Type.Unknown()),
    "implementation.guide": Type.Optional(Type.Unknown()),
    "implementation.executor": Type.Optional(Type.Unknown()),
    review: Type.Optional(Type.Unknown()),
    "consultation.enricher": Type.Optional(Type.Unknown()),
    "consultation.advisor": Type.Optional(Type.Unknown()),
    "discovery.evidence": Type.Optional(Type.Unknown()),
    "verification.product": Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);
const ModelPolicyInputSchema = Type.Object(
  {
    version: Type.Union([
      Type.Literal(1),
      Type.Literal(2),
      Type.Literal(3),
      Type.Literal(4),
      Type.Literal(5),
    ]),
    roles: PolicyRolesInputSchema,
    // Version 3 used one shared pool. It is accepted only to read and migrate that legacy shape.
    workerPool: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);
const ModelTargetListSchema = Type.Array(ModelChoiceSchema, { minItems: 1 });
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
  for (const role of MODEL_ROLES) applyConfiguredRole(policy, result, role);
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- Legacy and current role fields intentionally enter this decoder as unknown before version-specific validation.
function configuredRole(policy: ModelPolicyInput, role: ModelRole): unknown {
  if (policy.version !== 1) return policy.roles[role];
  switch (role) {
    case "research":
      return policy.roles["discovery.evidence"];
    case "implementation.guide":
    case "implementation.executor":
    case "consultation.enricher":
    case "consultation.advisor":
      return policy.roles[role];
    case "review":
      return policy.roles["verification.product"];
  }
}

function applyConfiguredRole(policy: ModelPolicyInput, result: ModelPolicy, role: ModelRole): void {
  const configured = configuredRole(policy, role);
  if (configured === undefined) return;
  if (isListModelRole(role)) {
    if (policy.version >= 4) {
      result.roles[role] = decodeModelList(configured, role);
      return;
    }
    result.roles[role] = [decodeLegacyTarget(configured, role)];
    return;
  }
  result.roles[role] = decodeTarget(
    policy.version === 1 && Array.isArray(configured) ? configured[0] : configured,
    role,
  );
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A role list is parsed and checked by this decoder before it enters the typed policy.
function decodeModelList(value: unknown, role: ModelRole): ModelTargetList {
  if (!Value.Check(ModelTargetListSchema, value))
    throw new Error(`Invalid model list for ${role}.`);
  // SAFETY: The preceding Value.Check establishes a nonempty array of ModelTarget values.
  const decoded = Value.Decode(ModelTargetListSchema, value) as ModelTargetList;
  return decoded;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Legacy role values are checked as targets before they enter the typed policy.
function decodeLegacyTarget(value: unknown, role: ModelRole): ModelTarget {
  return decodeTarget(Array.isArray(value) ? value[0] : value, role);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the final TypeBox validation boundary for an external role value.
function decodeTarget(value: unknown, role: ModelRole): ModelTarget {
  if (!Value.Check(ModelTargetSchema, value)) throw new Error(`Invalid model target for ${role}.`);
  return Value.Decode(ModelTargetSchema, value);
}

function migrateLegacyWorkerPool(policy: ModelPolicyInput, result: ModelPolicy): void {
  if (policy.version !== 3 || policy.workerPool === undefined) return;
  if (!Value.Check(ModelTargetListSchema, policy.workerPool))
    throw new Error("Invalid Workgraph worker pool.");
  const pool = uniqueTargets(Value.Decode(ModelTargetListSchema, policy.workerPool));
  for (const role of MODEL_LIST_ROLES) {
    const defaultTarget = result.roles[role][0];
    result.roles[role] = [
      defaultTarget,
      ...pool.filter((target) => targetKey(target) !== targetKey(defaultTarget)),
    ];
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
      if (policy.version >= 4 && policy.workerPool !== undefined)
        throw new Error(
          "The shared worker pool is unsupported in model policy version 4 or later.",
        );
      migrateLegacyWorkerPool(policy, result);
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
  if (!Value.Check(SelectionRequestSchema, normalized))
    throw new Error(`Invalid model selection request for ${role}.`);
  const count = normalized.count ?? 1;
  const diversity = normalized.diversity ?? "same-model";
  if (normalized.override !== undefined)
    return overrideReceipt(role, normalized.override, policy.roles[role][0], count, diversity);
  const models = policy.roles[role];
  const selected =
    diversity === "same-model"
      ? Array.from({ length: count }, () => models[0])
      : uniqueTargets(models).slice(0, count);
  return {
    role,
    requested: count,
    diversity,
    selected: selected.map(exactTarget),
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
  policyDefault: ModelTarget,
  count: number,
  diversity: "same-model" | "distinct-models",
): SelectionReceipt {
  const target = resolveTargetOverride(override, policyDefault);
  const overridden = [
    override.model === undefined ? undefined : "model",
    override.thinking === undefined ? undefined : "thinking",
  ]
    .filter((component) => component !== undefined)
    .join(" and ");
  const insufficientDiversity = diversity === "distinct-models" && count > 1;
  return {
    role,
    requested: count,
    diversity,
    selected: insufficientDiversity ? [target] : Array.from({ length: count }, () => target),
    unfulfilled: insufficientDiversity
      ? [`An explicit override supplies only one distinct model for ${count} requested attempts.`]
      : [],
    source: "override",
    reason: `Explicit ${overridden} override; unspecified components use the ${role} policy default.`,
  };
}

export function resolveTargetOverride(
  override: TargetOverride,
  policyDefault: ModelTarget,
): ModelTarget {
  if (
    !Value.Check(TargetOverrideSchema, override) ||
    (override.model === undefined && override.thinking === undefined)
  )
    throw new Error("Invalid model target override: provide model or thinking.");
  return {
    model: override.model ?? policyDefault.model,
    thinking: override.thinking ?? policyDefault.thinking,
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
    const key = targetKey(target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function targetKey(target: ModelTarget): string {
  return `${target.model}\0${target.thinking}`;
}

function isListModelRole(role: ModelRole): role is ListModelRole {
  return role === "research" || role === "review";
}

export function setModelListEffect(
  role: ListModelRole,
  list: ModelChoice[],
  path = modelPolicyPath(),
): Effect.Effect<ModelPolicy, ModelPolicyError | PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    if (!isListModelRole(role) || !Value.Check(ModelTargetListSchema, list))
      return yield* new ModelPolicyError({
        operation: "decode",
        path,
        message: "Invalid model list or role.",
      });
    const policy = yield* loadModelPolicyEffect(path);
    policy.roles[role] = decodeModelList(list, role);
    return yield* writeModelPolicyEffect(policy, path);
  });
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
    const decoded = Value.Decode(ModelTargetSchema, target);
    if (isListModelRole(role)) policy.roles[role] = [decoded];
    else policy.roles[role] = decoded;
    return yield* writeModelPolicyEffect(policy, path);
  });
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
