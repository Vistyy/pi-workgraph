import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli, CliError } from "../src/cli.js";
import { WorkgraphEngine } from "../src/engine.js";
import { GitRepository, runProcess } from "../src/git.js";
import { WorkgraphRegistry } from "../src/registry.js";
import { testOutcome } from "./helpers.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess("git", ["-C", cwd, ...args], { cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-cli-"));
  const root = join(parent, "repo");
  await runProcess("mkdir", ["-p", root], { cwd: parent, timeoutMs: 5_000 });
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "workgraph@example.test");
  await git(root, "config", "user.name", "Workgraph CLI");
  await writeFile(join(root, "value.txt"), "value\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  const repository = await GitRepository.open(root);
  const registryPath = join(parent, "registry.sqlite");
  const registry = new WorkgraphRegistry(registryPath);
  const begun = await WorkgraphEngine.begin({
    request: "Exercise the CLI fallback.",
    projectRoot: root,
    gitCommonDir: repository.commonDir,
    parentSessionId: "session-a",
    parentSessionFile: join(parent, "a.jsonl"),
    baseCommit: await repository.head(),
    outcome: testOutcome.outcome,
  }, { repository, registry });
  return { parent, root, registryPath, registry, begun };
}

test("CLI status and adoption use the durable registry and preserve the current session", async () => {
  const value = await fixture();
  try {
    const status = await runCli(["status", "--run-id", value.begun.run.runId, "--registry", value.registryPath]);
    assert.equal(status.run?.runId, value.begun.run.runId);
    const adopted = await runCli([
      "adopt", "--run-id", value.begun.run.runId, "--registry", value.registryPath,
      "--cwd", value.root, "--session-id", "session-a", "--session-file", value.begun.run.parentSessionFile,
    ], { ...process.env, HERDR_ENV: "", HERDR_WORKSPACE_ID: "" });
    assert.equal((adopted.result as { forked?: boolean } | undefined)?.forked, false);
    assert.equal(adopted.sessionFile, undefined);
    assert.equal(adopted.run?.coordinator.sessionFile, value.begun.run.parentSessionFile);
    assert.equal(adopted.run?.handoffs.at(-1)?.kind, "resume");
  } finally {
    value.registry.close();
    await rm(value.parent, { recursive: true, force: true });
  }
});

test("CLI lifecycle commands write explicit transitions and machine-readable errors", async () => {
  const value = await fixture();
  try {
    const suspended = await runCli(["suspend", "--run-id", value.begun.run.runId, "--registry", value.registryPath, "--reason", "Pause for review."]);
    assert.equal(suspended.run?.lifecycle, "suspended");
    const resumed = await runCli(["resume", "--run-id", value.begun.run.runId, "--registry", value.registryPath, "--reason", "Review complete."]);
    assert.equal(resumed.run?.lifecycle, "active");
    await assert.rejects(
      () => runCli(["archive", "--run-id", value.begun.run.runId, "--registry", value.registryPath, "--reason", "Too early."]),
      (error: unknown) => error instanceof Error && /Invalid lifecycle transition/.test(error.message),
    );
    await assert.rejects(
      () => runCli(["status", "--run-id", "missing", "--registry", value.registryPath]),
      (error: unknown) => error instanceof CliError && error.code === "unknown_run",
    );
  } finally {
    value.registry.close();
    await rm(value.parent, { recursive: true, force: true });
  }
});

test("CLI recovery and cleanup use the same state services without starting new work", async () => {
  const value = await fixture();
  try {
    await value.begun.engine.store.update((run) => { run.phase = "executing"; });
    const recovered = await runCli(["recovery", "--run-id", value.begun.run.runId, "--registry", value.registryPath]);
    assert.equal(recovered.run?.phase, "needs_decision");
    const cleaned = await runCli(["cleanup", "--run-id", value.begun.run.runId, "--registry", value.registryPath]);
    assert.deepEqual(cleaned.result, { cleanup: [] });
    const state = JSON.parse(await readFile(value.begun.run.statePath, "utf8")) as { attempts: unknown[] };
    assert.deepEqual(state.attempts, []);
  } finally {
    value.registry.close();
    await rm(value.parent, { recursive: true, force: true });
  }
});
