// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native paths are part of the public configuration API.
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Data, Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { runNodePlatformPromise } from "./node-platform.js";

export const MODEL_LIST_ROLES = ["research", "review", "consultation.advisor"] as const;
export type ListModelRole = (typeof MODEL_LIST_ROLES)[number];
export type ImplementationModelRole = "implementation.guide" | "implementation.executor";
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
export type ModelTargetList = [ModelTarget, ...ModelTarget[]];

const ModelTargetListSchema = Type.Array(ModelTargetSchema, { minItems: 1 });
const ModelPolicySchema = Type.Object(
  {
    version: Type.Literal(6),
    roles: Type.Object(
      {
        research: ModelTargetListSchema,
        "implementation.guide": ModelTargetSchema,
        "implementation.executor": ModelTargetSchema,
        review: ModelTargetListSchema,
        "consultation.enricher": ModelTargetSchema,
        "consultation.advisor": ModelTargetListSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export interface ModelPolicy {
  version: 6;
  roles: Record<ListModelRole, ModelTargetList> &
    Record<ImplementationModelRole | "consultation.enricher", ModelTarget>;
}

export const SelectionRequestSchema = Type.Object(
  {
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
    distinctModels: Type.Optional(Type.Boolean()),
    model: Type.Optional(Type.String({ pattern: "^[^/\\s]+/\\S+$" })),
  },
  { additionalProperties: false },
);
export type SelectionRequest = Static<typeof SelectionRequestSchema>;

export type ModelPolicyOperation = "read" | "parse" | "decode";

export class ModelPolicyError extends Data.TaggedError("ModelPolicyError")<{
  readonly operation: ModelPolicyOperation;
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
}> {
  override readonly name = "Error";
}

export function modelPolicyPath(agentDir = getAgentDir()): string {
  return join(agentDir, "workgraph", "models.json");
}

export function loadModelPolicyEffect(
  path = modelPolicyPath(),
): Effect.Effect<ModelPolicy, ModelPolicyError | PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const contents = yield* fileSystem.readFileString(path).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () =>
          new ModelPolicyError({
            operation: "read",
            path,
            message: `Workgraph model policy is required at ${path}. Create a complete version 6 policy before using Workgraph.`,
          }),
      ),
    );
    const parsed = yield* Effect.try({
      // oxlint-disable-next-line anti-slop/no-unknown-returns, effecttsgo/prefer-schema-over-json -- The strict decoder immediately validates this external JSON value.
      try: (): unknown => JSON.parse(contents),
      catch: () =>
        new ModelPolicyError({
          operation: "parse",
          path,
          message: `Invalid JSON in Workgraph model policy ${path}.`,
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
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This external boundary validates before returning the domain type.
  parsed: unknown,
  path: string,
): Effect.Effect<ModelPolicy, ModelPolicyError> {
  return Effect.try({
    try: () => decodeModelPolicy(parsed),
    catch: (cause) =>
      new ModelPolicyError({
        operation: "decode",
        path,
        message: cause instanceof Error ? cause.message : "Invalid Workgraph model policy.",
        cause,
      }),
  });
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Policy JSON is unknown until this strict boundary accepts it.
function decodeModelPolicy(value: unknown): ModelPolicy {
  if (!Value.Check(ModelPolicySchema, value)) {
    const issue = Value.Errors(ModelPolicySchema, value)[0];
    const location =
      issue?.instancePath !== undefined && issue.instancePath !== "" ? issue.instancePath : "/";
    const detail = issue?.message ?? "does not match schema version 6";
    throw new Error(`Invalid Workgraph model policy at ${location}: ${detail}.`);
  }
  // SAFETY: strict schema validation establishes the complete v6 shape; tuple casts are checked below as nonempty lists.
  const policy = Value.Decode(ModelPolicySchema, value) as ModelPolicy;
  for (const role of MODEL_LIST_ROLES) rejectDuplicateModels(role, policy.roles[role]);
  return policy;
}

function rejectDuplicateModels(role: ListModelRole, targets: ModelTargetList): void {
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.model))
      throw new Error(
        `Invalid Workgraph model policy: duplicate model ID ${target.model} in ${role}.`,
      );
    seen.add(target.model);
  }
}

export function configuredTarget(
  policy: ModelPolicy,
  role: ListModelRole,
  model?: string,
): ModelTarget {
  const targets = policy.roles[role];
  if (model === undefined) return exactTarget(targets[0]);
  const target = targets.find((candidate) => candidate.model === model);
  if (target === undefined)
    throw new Error(`Model ${model} is not configured for Workgraph role ${role}.`);
  return exactTarget(target);
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
  const distinctModels = normalized.distinctModels ?? false;
  if (distinctModels && normalized.model !== undefined)
    throw new Error(`model is incompatible with distinctModels=true for ${role}.`);

  let selected: ModelTarget[];
  if (distinctModels) {
    const configured = policy.roles[role];
    if (configured.length < count)
      throw new Error(
        `Requested ${count} distinct ${role} models, but policy configures only ${configured.length}.`,
      );
    selected = configured.slice(0, count).map(exactTarget);
  } else {
    const target = configuredTarget(policy, role, normalized.model);
    selected = Array.from({ length: count }, () => exactTarget(target));
  }
  return {
    role,
    count,
    distinctModels,
    selected,
    source: normalized.model === undefined ? "policy" : "requested-model",
  };
}

export interface SelectionReceipt {
  role: "research" | "review";
  count: number;
  distinctModels: boolean;
  selected: ModelTarget[];
  source: "policy" | "requested-model";
}

function exactTarget(target: ModelTarget): ModelTarget {
  return { model: target.model, thinking: target.thinking };
}
