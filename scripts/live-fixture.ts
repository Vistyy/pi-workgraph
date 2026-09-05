import assert from "node:assert/strict";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { runProcess } from "../src/git.js";
import { loadModelPolicy } from "../src/model-policy.js";
import type { WorkerIdentity } from "../src/types.js";
import { WorkstreamStore } from "../src/workstream.js";

export function object(value: unknown): Record<string, unknown> {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    "Expected a Herdr object",
  );
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}
export function items(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(object);
}
export async function command(
  cwd: string,
  executable: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<string> {
  const result = await runProcess(executable, args, { cwd, timeoutMs });
  if (result.exitCode !== 0)
    throw new Error(
      `${executable} ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  return result.stdout.trim();
}
export async function herdr(
  cwd: string,
  ...args: string[]
): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await command(cwd, "herdr", args, 60_000));
  return object(object(parsed).result);
}
export async function waitFor<T>(
  observe: () => Promise<T | undefined>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await observe();
    if (result !== undefined) return result;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`Timed out after ${timeoutMs}ms: ${description}`);
}

export async function createLiveFixture(label: string) {
  if (process.env.HERDR_ENV !== "1")
    throw new Error("This live scenario requires a Herdr-managed pane.");
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  assert.equal(
    await command(packageRoot, "git", ["status", "--porcelain"]),
    "",
    "Use a clean committed candidate",
  );
  const revision = await command(packageRoot, "git", ["rev-parse", "HEAD"]);
  const sourceAgent =
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const integration =
    process.env.PI_WORKGRAPH_HERDR_EXTENSION ||
    join(sourceAgent, "extensions", "herdr-agent-state.ts");
  await access(integration);
  const parent = await mkdtemp(join(tmpdir(), "workgraph-live-"));
  // mkdtemp creates a private directory. Evidence can include copied authentication and sessions.
  const root = join(parent, "fixture");
  const agentDir = join(parent, "agent");
  const candidate = join(parent, "candidate");
  console.error(`Retaining live evidence at ${parent}`);
  await writeFile(
    join(parent, "setup.json"),
    JSON.stringify(
      { parent, root, agentDir, candidate, revision, label },
      null,
      2,
    ),
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
  await command(parent, "tar", [
    "-xf",
    join(parent, "candidate.tar"),
    "-C",
    candidate,
  ]);
  await symlink(
    join(packageRoot, "node_modules"),
    join(candidate, "node_modules"),
  );
  for (const file of ["auth.json", "models.json", "workgraph/models.json"]) {
    try {
      await copyFile(join(sourceAgent, file), join(agentDir, file));
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
  }
  await symlink(
    integration,
    join(agentDir, "extensions", "herdr-agent-state.ts"),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [candidate] }),
  );
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
  const policy = await loadModelPolicy(
    join(agentDir, "workgraph", "models.json"),
  );
  const before = items((await herdr(root, "workspace", "list")).workspaces).map(
    (item) => text(item.workspace_id),
  );
  await writeFile(
    join(parent, "workspaces-before.json"),
    JSON.stringify(before),
  );
  const created = await herdr(
    root,
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
  await writeFile(
    join(parent, "workspace-created.json"),
    JSON.stringify(created, null, 2),
  );
  const workspace = object(created.workspace);
  const workspaceId = text(workspace.workspace_id);
  assert.ok(
    !before.includes(workspaceId) &&
      workspaceId !== process.env.HERDR_WORKSPACE_ID,
  );
  const tabs = items(
    (await herdr(root, "tab", "list", "--workspace", workspaceId)).tabs,
  );
  assert.equal(tabs.length, 1);
  const rootTab = text(tabs[0]?.tab_id);
  const paneId = text(object(created.root_pane).pane_id);
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
    policy,
  };
  await writeFile(
    join(parent, "evidence.json"),
    JSON.stringify(metadata, null, 2),
  );
  return metadata;
}
export type LiveFixture = Awaited<ReturnType<typeof createLiveFixture>>;

export async function startCoordinator(
  f: LiveFixture,
): Promise<WorkerIdentity> {
  const session = SessionManager.create(
    f.root,
    join(f.parent, "coordinator-sessions"),
  );
  session.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "Fixture initialized; await the human request." },
    ],
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
    timestamp: Date.now(),
  });
  const sessionFile = session.getSessionFile();
  assert.ok(sessionFile);
  const agentName = `wg-live-${Date.now().toString(36)}`;
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
    process.env.PI_WORKGRAPH_COORDINATOR_MODEL || "openai-codex/gpt-6-astra",
    "--thinking",
    "high",
  );
  const agent = object(result.agent);
  const identity = {
    workspaceId: f.workspaceId,
    tabId: f.rootTab,
    paneId: f.paneId,
    terminalId: text(agent.terminal_id),
    agentName,
    cwd: f.root,
    sessionFile,
  };
  await writeFile(
    join(f.parent, "coordinator-identity.json"),
    JSON.stringify(identity, null, 2),
  );
  await waitFor(
    async () => {
      const observed = object(
        (await herdr(f.root, "agent", "get", f.paneId)).agent,
      );
      assert.equal(observed.cwd, f.root);
      assert.equal(observed.terminal_id, identity.terminalId);
      if (observed.agent_status === "blocked")
        throw new Error(
          "Pi requires operator action; no prompt was submitted.",
        );
      if (!observed.agent_session) return undefined;
      assert.equal(object(observed.agent_session).value, sessionFile);
      return identity;
    },
    30_000,
    "native coordinator identity (inspect trust/startup UI, do not approve blindly)",
  );
  return identity;
}

export async function closeOwnedWorkspace(
  f: LiveFixture,
  coordinator?: WorkerIdentity,
): Promise<void> {
  if (coordinator)
    await waitFor(
      async () => {
        const agent = object(
          (await herdr(f.root, "agent", "get", coordinator.paneId)).agent,
        );
        assert.equal(
          object(agent.agent_session).value,
          coordinator.sessionFile,
        );
        assert.equal(agent.terminal_id, coordinator.terminalId);
        assert.equal(agent.cwd, coordinator.cwd);
        return ["idle", "done"].includes(text(agent.agent_status))
          ? true
          : undefined;
      },
      30_000,
      "coordinator settlement before exact workspace closure",
    );
  const tabs = items(
    (await herdr(f.root, "tab", "list", "--workspace", f.workspaceId)).tabs,
  );
  assert.deepEqual(
    tabs.map((tab) => tab.tab_id),
    [f.rootTab],
    "Worker or unknown tabs remain; preserve the workspace for reconciliation",
  );
  await herdr(f.root, "workspace", "close", f.workspaceId);
  assert.ok(
    items((await herdr(f.root, "workspace", "list")).workspaces).every(
      (workspace) => workspace.workspace_id !== f.workspaceId,
    ),
  );
  await writeFile(
    join(f.parent, "workspace-closed.json"),
    JSON.stringify({ workspaceId: f.workspaceId, absenceVerified: true }),
  );
}

export async function retainFailure(
  f: LiveFixture | undefined,
  error: unknown,
): Promise<void> {
  const failure = {
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
    fixture: f?.parent,
    workspaceId: f?.workspaceId,
    limitation:
      "Owned resources and evidence are retained. Inspect identities and worker state before cleanup; no blind retry or broad workspace deletion was attempted.",
    diagnostic: undefined as string | undefined,
  };
  if (f) {
    try {
      const directory = join(f.root, ".git", "pi-workgraph", "workstreams");
      const names = await readdir(directory);
      const states = [];
      for (const name of names) {
        try {
          const state = await WorkstreamStore.inspect(
            join(directory, name, "workstream.json"),
          );
          states.push({
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
              composition: attempt.composition,
            })),
            results: state.results.map((result) => ({
              id: result.id,
              assignmentId: result.assignmentId,
              validity: result.validity,
            })),
          });
        } catch (stateError) {
          states.push({
            name,
            diagnostic:
              stateError instanceof Error
                ? stateError.message
                : String(stateError),
          });
        }
      }
      await writeFile(
        join(f.parent, "state-observation.json"),
        JSON.stringify(states, null, 2),
      );
    } catch (stateError) {
      failure.diagnostic =
        stateError instanceof Error ? stateError.message : String(stateError);
    }
    await writeFile(
      join(f.parent, "failure.json"),
      JSON.stringify(failure, null, 2),
    );
  }
  console.error(JSON.stringify(failure));
  process.exitCode = 1;
}
