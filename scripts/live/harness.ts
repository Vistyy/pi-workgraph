import assert from "node:assert/strict";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
  // oxlint-disable-next-line effecttsgo/node-builtin-import -- This live harness intentionally validates native filesystem behavior.
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This exact native smoke boundary preserves host payload, Promise, filesystem, timing, and cleanup semantics.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Clock, Config, ConfigProvider, Effect, Option } from "effect";
import { type StaticDecode, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { runProcess } from "../../src/git.js";
import type { WorkerIdentity } from "../../src/types.js";
import { type WorkstreamState, WorkstreamStore } from "../../src/workstream.js";

const LiveEnvironmentConfig = Config.all({
  herdrEnvironment: Config.string("HERDR_ENV").pipe(Config.withDefault("")),
  sourceAgent: Config.string("PI_CODING_AGENT_DIR").pipe(Config.option),
  herdrExtension: Config.string("PI_WORKGRAPH_HERDR_EXTENSION").pipe(Config.option),
  coordinatorModel: Config.string("PI_WORKGRAPH_COORDINATOR_MODEL").pipe(
    Config.withDefault("openai-codex/gpt-6-astra"),
  ),
  currentWorkspace: Config.string("HERDR_WORKSPACE_ID").pipe(Config.option),
});
const HostConfigProvider = ConfigProvider.fromEnvRecord(process.env);
const liveEnvironment = Effect.runSync(LiveEnvironmentConfig.parse(HostConfigProvider));
const COPIED_AGENT_FILES = ["auth.json", "models.json", "workgraph/models.json"] as const;
export const liveCoordinatorModel = liveEnvironment.coordinatorModel;
export function command(
  cwd: string,
  executable: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<string> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* Effect.promise(() => runProcess(executable, args, { cwd, timeoutMs }));
      if (result.exitCode !== 0)
        throw new Error(
          `${executable} ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
        );
      return result.stdout.trim();
    }),
  );
}
// oxlint-disable-next-line effecttsgo/async-function -- Native Herdr Promise interoperability is decoded against the command-specific schema.
export async function herdr<T extends TSchema>(
  cwd: string,
  resultSchema: T,
  ...args: string[]
): Promise<StaticDecode<T>> {
  const envelopeSchema = Type.Object({ result: Type.Unknown() });
  const parsed: unknown = JSON.parse(await command(cwd, "herdr", args, 60_000));
  assert.ok(Value.Check(envelopeSchema, parsed), `Invalid Herdr response for ${args.join(" ")}`);
  const decoded = Value.Decode(envelopeSchema, parsed);
  // oxlint-disable-next-line typescript/no-unsafe-return -- TypeBox preserves the caller schema at runtime but its generic StaticDecode return is erased in this boundary helper.
  return Value.Decode(resultSchema, decoded.result);
}
export function waitFor<T>(
  observe: () => Promise<T | undefined>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
      while ((yield* Clock.currentTimeMillis) < deadline) {
        const result = yield* Effect.promise(observe);
        if (result !== undefined) return result;
        yield* Effect.sleep("500 millis");
      }
      throw new Error(`Timed out after ${timeoutMs}ms: ${description}`);
    }),
  );
}

export interface OwnedWorkspaceCheckpoint {
  workspaceId: string;
  paneId: string;
  rootTab?: string;
}

export interface LiveFixtureCheckpoint {
  label: string;
  copiedAgentFiles: string[];
  ownedWorkspaces: OwnedWorkspaceCheckpoint[];
  parent?: string;
  root?: string;
  agentDir?: string;
  candidate?: string;
  revision?: string;
}

export function createFixtureCheckpoint(label: string): LiveFixtureCheckpoint {
  return { label, copiedAgentFiles: [], ownedWorkspaces: [] };
}

// oxlint-disable-next-line effecttsgo/async-function -- Checkpoint persistence is part of the native Promise fixture boundary.
async function persistCheckpoint(checkpoint: LiveFixtureCheckpoint): Promise<void> {
  if (checkpoint.parent === undefined) return;
  await writeFile(
    join(checkpoint.parent, "ownership-checkpoint.json"),
    JSON.stringify(checkpoint, null, 2),
  );
}

// oxlint-disable-next-line effecttsgo/async-function -- Exact Herdr ownership is checkpointed through the native Promise boundary.
export async function registerOwnedWorkspace(
  checkpoint: LiveFixtureCheckpoint,
  workspace: OwnedWorkspaceCheckpoint,
): Promise<void> {
  const existing = checkpoint.ownedWorkspaces.find(
    (item) => item.workspaceId === workspace.workspaceId,
  );
  if (existing === undefined) checkpoint.ownedWorkspaces.push(workspace);
  else Object.assign(existing, workspace);
  await persistCheckpoint(checkpoint);
}

// oxlint-disable-next-line effecttsgo/async-function -- This exact native smoke boundary preserves host payload, Promise, filesystem, timing, and cleanup semantics.
export async function createLiveFixture(label: string, checkpoint: LiveFixtureCheckpoint) {
  if (liveEnvironment.herdrEnvironment !== "1")
    throw new Error("This live scenario requires a Herdr-managed pane.");
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  assert.equal(
    await command(packageRoot, "git", ["status", "--porcelain"]),
    "",
    "Use a clean committed candidate",
  );
  const revision = await command(packageRoot, "git", ["rev-parse", "HEAD"]);
  const sourceAgent = Option.getOrElse(liveEnvironment.sourceAgent, () =>
    join(homedir(), ".pi", "agent"),
  );
  const integration = Option.getOrElse(liveEnvironment.herdrExtension, () =>
    join(sourceAgent, "extensions", "herdr-agent-state.ts"),
  );
  await access(integration);
  const parent = await mkdtemp(join(tmpdir(), "workgraph-live-"));
  // mkdtemp creates a private directory. Evidence can include copied authentication and sessions.
  const root = join(parent, "fixture");
  const agentDir = join(parent, "agent");
  const candidate = join(parent, "candidate");
  Object.assign(checkpoint, { parent, root, agentDir, candidate, revision });
  process.stderr.write(`Retaining private live evidence at ${parent}\n`);
  await persistCheckpoint(checkpoint);
  await writeFile(
    join(parent, "setup.json"),
    JSON.stringify({ parent, root, agentDir, candidate, revision, label }, null, 2),
  );
  await Promise.all([
    mkdir(root),
    mkdir(join(agentDir, "extensions"), { recursive: true }),
    mkdir(join(agentDir, "workgraph"), { recursive: true }),
    mkdir(candidate),
  ]);
  await command(packageRoot, "git", [
    "archive",
    "--output",
    join(parent, "candidate.tar"),
    revision,
  ]);
  await command(parent, "tar", ["-xf", join(parent, "candidate.tar"), "-C", candidate]);
  await symlink(join(packageRoot, "node_modules"), join(candidate, "node_modules"));
  for (const file of COPIED_AGENT_FILES) {
    const copiedFile = join(agentDir, file);
    try {
      await copyFile(join(sourceAgent, file), copiedFile);
      checkpoint.copiedAgentFiles.push(copiedFile);
      await persistCheckpoint(checkpoint);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  await symlink(integration, join(agentDir, "extensions", "herdr-agent-state.ts"));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [candidate] }));
  await writeFile(
    join(root, "README.md"),
    "# Fixture\n\nMarker: AMBER.\n\nThe parser's normalized marker is used for the correction decision.\n",
  );
  await writeFile(
    join(root, "parse-marker.mjs"),
    'import { readFileSync } from "node:fs";\nconst text = readFileSync("README.md", "utf8");\nconst raw = text.match(/^Marker:\\s*(.+)$/m)?.[1] ?? "";\nconst parsed = raw.replace(/[.!?]+$/, "");\nconsole.log(JSON.stringify({ raw, parsed }));\n',
  );
  await writeFile(join(root, "value.txt"), "before\n");
  await writeFile(
    join(root, "verify.mjs"),
    'import assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\nassert.equal(readFileSync("value.txt", "utf8"), "after\\n");\nconsole.log("value verified");\n',
  );
  await command(root, "git", ["init", "-b", "main"]);
  await command(root, "git", ["config", "user.email", "fixture@example.test"]);
  await command(root, "git", ["config", "user.name", "Workgraph live fixture"]);
  await command(root, "git", ["add", "."]);
  await command(root, "git", ["commit", "-m", "Fixture"]);
  const base = await command(root, "git", ["rev-parse", "HEAD"]);
  const workspaceListSchema = Type.Object({
    workspaces: Type.Array(Type.Object({ workspace_id: Type.String() })),
  });
  const before = (await herdr(root, workspaceListSchema, "workspace", "list")).workspaces.map(
    (item) => item.workspace_id,
  );
  await writeFile(join(parent, "workspaces-before.json"), JSON.stringify(before));
  const created = await herdr(
    root,
    Type.Object({
      workspace: Type.Object({ workspace_id: Type.String() }),
      root_pane: Type.Object({ pane_id: Type.String() }),
    }),
    "workspace",
    "create",
    "--cwd",
    root,
    "--label",
    label,
    "--no-focus",
    "--env",
    `PI_CODING_AGENT_DIR=${agentDir}`,
    "--env",
    "PI_WORKGRAPH_MODE=",
  );
  const workspaceId = created.workspace.workspace_id;
  const paneId = created.root_pane.pane_id;
  await registerOwnedWorkspace(checkpoint, { workspaceId, paneId });
  await writeFile(join(parent, "workspace-created.json"), JSON.stringify(created, null, 2));
  assert.ok(
    !before.includes(workspaceId) &&
      Option.getOrUndefined(liveEnvironment.currentWorkspace) !== workspaceId,
  );
  const tabListSchema = Type.Object({ tabs: Type.Array(Type.Object({ tab_id: Type.String() })) });
  const tabs = (await herdr(root, tabListSchema, "tab", "list", "--workspace", workspaceId)).tabs;
  assert.equal(tabs.length, 1);
  const rootTab = tabs[0]?.tab_id;
  assert.ok(rootTab !== undefined);
  await registerOwnedWorkspace(checkpoint, { workspaceId, paneId, rootTab });
  const metadata = {
    parent,
    root,
    agentDir,
    candidate,
    revision,
    base,
    workspaceId,
    rootTab,
    paneId,
    checkpoint,
  };
  await writeFile(join(parent, "evidence.json"), JSON.stringify(metadata, null, 2));
  return metadata;
}
export type LiveFixture = Awaited<ReturnType<typeof createLiveFixture>>;

// oxlint-disable-next-line effecttsgo/async-function -- This exact native smoke boundary preserves host payload, Promise, filesystem, timing, and cleanup semantics.
export async function startCoordinator(f: LiveFixture): Promise<WorkerIdentity> {
  const session = SessionManager.create(f.root, join(f.parent, "coordinator-sessions"));
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Fixture initialized; await the human request." }],
    api: "test",
    provider: "fixture",
    model: "fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Effect.runSync(Clock.currentTimeMillis),
  });
  const sessionFile = session.getSessionFile();
  assert.ok(sessionFile !== undefined);
  const agentName = `wg-live-${Effect.runSync(Clock.currentTimeMillis).toString(36)}`;
  await writeFile(
    join(f.parent, "coordinator-start.json"),
    JSON.stringify(
      {
        agentName,
        sessionFile,
        paneId: f.paneId,
        workspaceId: f.workspaceId,
        cwd: f.root,
      },
      null,
      2,
    ),
  );
  const result = await herdr(
    f.root,
    Type.Object({ agent: Type.Object({ terminal_id: Type.String() }) }),
    "agent",
    "start",
    agentName,
    "--kind",
    "pi",
    "--pane",
    f.paneId,
    "--",
    "--session",
    sessionFile,
    "--model",
    liveEnvironment.coordinatorModel,
    "--thinking",
    "high",
  );
  const identity = {
    workspaceId: f.workspaceId,
    tabId: f.rootTab,
    paneId: f.paneId,
    terminalId: result.agent.terminal_id,
    agentName,
    cwd: f.root,
    sessionFile,
  };
  await writeFile(join(f.parent, "coordinator-identity.json"), JSON.stringify(identity, null, 2));
  const observedAgentSchema = Type.Object({
    agent: Type.Object({
      cwd: Type.String(),
      terminal_id: Type.String(),
      agent_status: Type.String(),
      agent_session: Type.Optional(Type.Object({ value: Type.String() })),
    }),
  });
  await waitFor(
    () =>
      herdr(f.root, observedAgentSchema, "agent", "get", f.paneId).then((result) => {
        const observed = result.agent;
        assert.equal(observed.cwd, f.root);
        assert.equal(observed.terminal_id, identity.terminalId);
        if (observed.agent_status === "blocked")
          throw new Error("Pi requires operator action; no prompt was submitted.");
        if (observed.agent_session === undefined) return undefined;
        assert.equal(observed.agent_session.value, sessionFile);
        return identity;
      }),
    30_000,
    "native coordinator identity (inspect trust/startup UI, do not approve blindly)",
  );
  return identity;
}

// oxlint-disable-next-line effecttsgo/async-function -- This exact native smoke boundary preserves host payload, Promise, filesystem, timing, and cleanup semantics.
export async function closeOwnedWorkspace(
  f: LiveFixture,
  coordinator?: WorkerIdentity,
): Promise<void> {
  if (coordinator !== undefined) {
    const agentSchema = Type.Object({
      agent: Type.Object({
        agent_session: Type.Object({ value: Type.String() }),
        terminal_id: Type.String(),
        cwd: Type.String(),
        agent_status: Type.String(),
      }),
    });
    await waitFor(
      () =>
        herdr(f.root, agentSchema, "agent", "get", coordinator.paneId).then((result) => {
          const agent = result.agent;
          assert.equal(agent.agent_session.value, coordinator.sessionFile);
          assert.equal(agent.terminal_id, coordinator.terminalId);
          assert.equal(agent.cwd, coordinator.cwd);
          return ["idle", "done"].includes(agent.agent_status) ? true : undefined;
        }),
      30_000,
      "coordinator settlement before exact workspace closure",
    );
  }
  const tabSchema = Type.Object({ tabs: Type.Array(Type.Object({ tab_id: Type.String() })) });
  const tabs = (await herdr(f.root, tabSchema, "tab", "list", "--workspace", f.workspaceId)).tabs;
  assert.deepEqual(
    tabs.map((tab) => tab.tab_id),
    [f.rootTab],
    "Worker or unknown tabs remain; preserve the workspace for reconciliation",
  );
  await herdr(f.root, Type.Object({}), "workspace", "close", f.workspaceId);
  const workspaceSchema = Type.Object({
    workspaces: Type.Array(Type.Object({ workspace_id: Type.String() })),
  });
  assert.ok(
    (await herdr(f.root, workspaceSchema, "workspace", "list")).workspaces.every(
      (workspace) => workspace.workspace_id !== f.workspaceId,
    ),
  );
  await writeFile(
    join(f.parent, "workspace-closed.json"),
    JSON.stringify({ workspaceId: f.workspaceId, absenceVerified: true }),
  );
}

function projectWorkstreamState(state: WorkstreamState) {
  return {
    id: state.id,
    lifecycle: state.lifecycle,
    assignments: state.assignments.map((item) => item.id),
    attempts: state.attempts.map((attempt) => ({
      id: attempt.id,
      state: attempt.state,
      worker: attempt.worker,
      resource: attempt.resource,
      error: attempt.error,
      cleanup: attempt.cleanup,
      application: attempt.application,
    })),
    results: state.results.map((result) => ({
      id: result.id,
      assignmentId: result.assignmentId,
      validity: result.validity,
    })),
  };
}

// oxlint-disable-next-line effecttsgo/async-function -- One state inspection is normalized into retained failure evidence.
async function inspectRetainedStateFile(directory: string, name: string) {
  try {
    return projectWorkstreamState(
      await WorkstreamStore.inspect(join(directory, name, "workstream.json")),
    );
  } catch (error) {
    return { name, diagnostic: error instanceof Error ? error.message : String(error) };
  }
}

// oxlint-disable-next-line effecttsgo/async-function -- Failure inspection must retain native filesystem and store diagnostics.
async function inspectRetainedState(root: string) {
  const directory = join(root, ".git", "pi-workgraph", "workstreams");
  const names = await readdir(directory);
  return Promise.all(names.map((name) => inspectRetainedStateFile(directory, name)));
}

function reconciliationInstructions(checkpoint: LiveFixtureCheckpoint): string[] {
  const instructions = checkpoint.ownedWorkspaces.flatMap((workspace) => [
    `Inspect exact workspace: herdr workspace get ${workspace.workspaceId}`,
    `After matching pane ${workspace.paneId}${workspace.rootTab !== undefined ? ` and root tab ${workspace.rootTab}` : ""}, inspect all agents/tabs and close only exact workspace ${workspace.workspaceId}.`,
  ]);
  if (checkpoint.root !== undefined)
    instructions.push(
      `Inspect fixture worktrees and branches before removal: git -C ${checkpoint.root} worktree list --porcelain`,
    );
  if (checkpoint.copiedAgentFiles.length > 0)
    instructions.push(
      `After every retained agent is settled and exact workspaces are absent, remove only copied agent files: ${checkpoint.copiedAgentFiles.join(", ")}`,
    );
  return instructions;
}

// oxlint-disable-next-line effecttsgo/async-function -- Success curation removes an exact checkpointed native file set.
export async function removeCopiedAgentFiles(checkpoint: LiveFixtureCheckpoint): Promise<string[]> {
  const agentDir = checkpoint.agentDir;
  if (agentDir === undefined)
    throw new Error("Cannot curate copied files without the exact fixture agent directory.");
  const allowed = new Set(COPIED_AGENT_FILES.map((file) => join(agentDir, file)));
  const files = [...checkpoint.copiedAgentFiles];
  assert.ok(
    files.every((path) => allowed.has(path)),
    "Refusing to remove a file outside the exact copied fixture-agent set",
  );
  await Promise.all(files.map((path) => rm(path, { force: true })));
  return files;
}

// oxlint-disable-next-line effecttsgo/async-function -- Finalization verifies native Herdr absence before exact evidence curation.
export async function finalizeSuccessfulFixture(fixture: LiveFixture): Promise<{
  resourceCleanup: string;
  evidenceCleanup: string;
  removedCopiedAgentFiles: string[];
}> {
  const workspaceSchema = Type.Object({
    workspaces: Type.Array(Type.Object({ workspace_id: Type.String() })),
  });
  const present = (await herdr(fixture.root, workspaceSchema, "workspace", "list")).workspaces;
  const ownedIds = new Set(fixture.checkpoint.ownedWorkspaces.map((item) => item.workspaceId));
  assert.ok(
    present.every((workspace) => !ownedIds.has(workspace.workspace_id)),
    "An exact owned workspace remains; preserve copied agent files for reconciliation",
  );
  const removedCopiedAgentFiles = await removeCopiedAgentFiles(fixture.checkpoint);
  const cleanup = {
    resourceCleanup: "Every checkpointed Herdr workspace was independently absent.",
    evidenceCleanup:
      "Only copied agent credential/configuration files were removed; private sessions and useful scenario evidence were retained.",
    removedCopiedAgentFiles,
  };
  await writeFile(
    join(fixture.parent, "successful-cleanup.json"),
    JSON.stringify(cleanup, null, 2),
  );
  return cleanup;
}

export interface NativeSessionUsage {
  source: "native assistant message usage";
  sessionCount: number;
  assistantMessagesWithUsage: number;
  totalTokens?: number;
  totalCostUsd?: number;
  limitation: string;
}

export function observeNativeSessionUsage(sessionFiles: string[]): NativeSessionUsage {
  let assistantMessagesWithUsage = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  for (const sessionFile of new Set(sessionFiles)) {
    for (const entry of SessionManager.open(sessionFile).getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      assistantMessagesWithUsage += 1;
      totalTokens += entry.message.usage.totalTokens;
      totalCostUsd += entry.message.usage.cost.total;
    }
  }
  const summary: NativeSessionUsage = {
    source: "native assistant message usage",
    sessionCount: new Set(sessionFiles).size,
    assistantMessagesWithUsage,
    limitation:
      "Counts usage attached to retained native assistant messages; it does not measure hidden provider requests or unavailable provider-side accounting.",
  };
  if (assistantMessagesWithUsage > 0) {
    summary.totalTokens = totalTokens;
    summary.totalCostUsd = totalCostUsd;
  }
  return summary;
}

interface RetainedFailureRecord {
  status: "failed";
  error: string;
  fixture: string | undefined;
  ownedWorkspaces: OwnedWorkspaceCheckpoint[];
  copiedAgentFiles: string[];
  limitation: string;
  cleanupInstructions: string[];
  diagnostic?: string;
}

// oxlint-disable-next-line effecttsgo/async-function -- This native boundary retains exact external failure evidence without cleanup.
export async function retainFailure(
  checkpoint: LiveFixtureCheckpoint,
  error: Error | string,
): Promise<void> {
  const failure: RetainedFailureRecord = {
    status: "failed",
    error: error instanceof Error ? error.message : error,
    fixture: checkpoint.parent,
    ownedWorkspaces: checkpoint.ownedWorkspaces,
    copiedAgentFiles: checkpoint.copiedAgentFiles,
    limitation:
      "Checkpointed resources and private evidence are retained. Inspect exact identities before cleanup; no blind retry or broad workspace deletion was attempted.",
    cleanupInstructions: reconciliationInstructions(checkpoint),
  };
  if (checkpoint.parent !== undefined) {
    if (checkpoint.root !== undefined) {
      try {
        const states = await inspectRetainedState(checkpoint.root);
        await writeFile(
          join(checkpoint.parent, "state-observation.json"),
          JSON.stringify(states, null, 2),
        );
      } catch (stateError) {
        failure.diagnostic = stateError instanceof Error ? stateError.message : String(stateError);
      }
    }
    await writeFile(join(checkpoint.parent, "failure.json"), JSON.stringify(failure, null, 2));
  }
  process.stderr.write(`${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
}
