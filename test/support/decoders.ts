type FixtureVariable =
  | "HERDR_ENV"
  | "HERDR_WORKSPACE_ID"
  | "HERDR_TAB_ID"
  | "PI_CODING_AGENT_DIR"
  | "PI_WORKGRAPH_ROLE"
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
