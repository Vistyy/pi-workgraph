import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

/** Decode an untyped Pi or JSON test-boundary value before asserting its fields. */
export function decodeTestValue<const Schema extends TSchema>(
  schema: Schema,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Pi tool details and JSON.parse values enter tests without a static contract and are decoded here.
  value: unknown,
): Static<Schema> {
  if (!Value.Check(schema, value)) {
    throw new Error("test boundary value did not match its expected contract");
  }
  // SAFETY: Value.Check established the complete supplied TypeBox schema while preserving additional protocol fields.
  // oxlint-disable-next-line typescript/no-unsafe-return -- TypeBox Static generics are reported as any by this rule despite the checked schema contract.
  return value as Static<Schema>;
}

/** Require a fixture value before using the resource identity it carries. */
export function required<Value>(value: Value | null | undefined, description: string): Value {
  if (value === undefined || value === null) {
    throw new Error(`${description} must be present`);
  }
  return value;
}

type FixtureVariable =
  | "HERDR_ENV"
  | "HERDR_WORKSPACE_ID"
  | "PI_CODING_AGENT_DIR"
  | "PI_WORKGRAPH_BASE_COMMIT"
  | "PI_WORKGRAPH_EXECUTOR_MODEL"
  | "PI_WORKGRAPH_EXECUTOR_THINKING"
  | "PI_WORKGRAPH_EXPERIMENT"
  | "PI_WORKGRAPH_IMPLEMENTATION_START"
  | "PI_WORKGRAPH_MODE"
  | "PI_WORKGRAPH_NODE_ID"
  | "PI_WORKGRAPH_RUN_ID"
  | "PI_WORKGRAPH_HERDR_BIN"
  | "PATH";

type FixtureEnvironment = Partial<Record<FixtureVariable, string | null>>;

export function configureFixtureEnvironment(changes: FixtureEnvironment): NodeJS.ProcessEnv {
  const previous = { ...process.env };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) {
      Reflect.deleteProperty(process.env, key);
    } else {
      Reflect.set(process.env, key, value);
    }
  }
  return previous;
}

export function restoreFixtureEnvironment(previous: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in previous)) {
      Reflect.deleteProperty(process.env, key);
    }
  }
  Object.assign(process.env, previous);
}
