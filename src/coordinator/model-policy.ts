import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Data, Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { type ModelTarget, ModelTargetSchema } from "../domain/model-target.js";
import { runNodePlatformPromise } from "../node-platform.js";

const MODEL_LIST_ROLES = ["research", "review"] as const;

export type ListModelRole = (typeof MODEL_LIST_ROLES)[number];

type ModelTargetList = [ModelTarget, ...ModelTarget[]];

const ModelTargetListSchema = Type.Array(ModelTargetSchema, { minItems: 1 });

const ModelPolicySchema = Type.Object(
  {
    roles: Type.Object(
      {
        research: ModelTargetListSchema,
        "implementation.guide": ModelTargetSchema,
        "implementation.executor": ModelTargetSchema,
        "implementation.escalationExecutor": Type.Optional(ModelTargetSchema),
        review: ModelTargetListSchema,
        "consultation.advisor": ModelTargetSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export interface ModelPolicy {
  roles: Record<ListModelRole, ModelTargetList> & {
    "implementation.guide": ModelTarget;
    "implementation.executor": ModelTarget;
    "implementation.escalationExecutor"?: ModelTarget;
    "consultation.advisor": ModelTarget;
  };
}

export const SelectionRequestSchema = Type.Object(
  {
    count: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 32,
        description: "Number of initial Attempts to create; defaults to one.",
      }),
    ),
    distinctModels: Type.Optional(
      Type.Boolean({ description: "Require each selected Attempt to use a distinct model." }),
    ),
  },
  {
    additionalProperties: false,
    description: "Optional initial Attempt selection policy.",
  },
);

export type SelectionRequest = Static<typeof SelectionRequestSchema>;

type ModelPolicyOperation = "read" | "parse" | "decode";

class ModelPolicyError extends Data.TaggedError("ModelPolicyError")<{
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

function loadModelPolicyEffect(
  path = modelPolicyPath(),
): Effect.Effect<ModelPolicy, ModelPolicyError | PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    const contents = yield* fileSystem.readFileString(path).pipe(
      Effect.catchReason(
        "PlatformError",
        "NotFound",
        () =>
          new ModelPolicyError({
            operation: "read",
            path,
            message: `Workgraph model policy is required at ${path}. Create a complete policy before using Workgraph.`,
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
  const issue = Value.Errors(ModelPolicySchema, value)[0];

  if (issue !== undefined) {
    const location = issue.instancePath === "" ? "/" : issue.instancePath;
    throw new Error(`Invalid Workgraph model policy at ${location}: ${issue.message}.`);
  }

  // SAFETY: strict schema validation establishes the complete shape; tuple casts are checked below as nonempty lists.
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

export function resolveSelection<Role extends ListModelRole>(
  role: Role,
  request: SelectionRequest | undefined,
  policy: ModelPolicy,
): SelectionReceipt<Role> {
  const normalized = request ?? {};

  if (!Value.Check(SelectionRequestSchema, normalized))
    throw new Error(`Invalid model selection request for ${role}.`);
  const count = normalized.count ?? 1;
  const distinctModels = normalized.distinctModels ?? false;
  let selected: ModelTarget[];

  if (distinctModels) {
    const configured = policy.roles[role];

    if (configured.length < count)
      throw new Error(
        `Requested ${count} distinct ${role} models, but policy configures only ${configured.length}.`,
      );
    selected = configured.slice(0, count).map(exactTarget);
  } else {
    selected = Array.from({ length: count }, () => exactTarget(policy.roles[role][0]));
  }

  return { role, count, distinctModels, selected };
}

export interface SelectionReceipt<Role extends ListModelRole = ListModelRole> {
  role: Role;
  count: number;
  distinctModels: boolean;
  selected: ModelTarget[];
}

/**
 * Exact implementation guide plus the configured default executor or, only when
 * the caller explicitly requests it, the configured escalation executor.
 */
export function implementationTargets(policy: ModelPolicy, useEscalationExecutor: boolean) {
  const executor = useEscalationExecutor
    ? policy.roles["implementation.escalationExecutor"]
    : policy.roles["implementation.executor"];

  if (executor === undefined)
    throw new Error(
      "The required Workgraph model policy configures no implementation.escalationExecutor.",
    );

  return {
    guide: exactTarget(policy.roles["implementation.guide"]),
    executor: exactTarget(executor),
  };
}

function exactTarget(target: ModelTarget): ModelTarget {
  return { model: target.model, thinking: target.thinking };
}
