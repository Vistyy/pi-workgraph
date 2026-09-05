import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CliError, runCli } from "../src/cli.js";
import { WorkgraphEngine } from "../src/engine.js";
import { GitRepository, runProcess } from "../src/git.js";
import { WorkgraphRegistry } from "../src/registry.js";
import { testOutcome } from "./helpers.js";

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-cli-"));
  const root = join(parent, "repo");
  await runProcess("mkdir", ["-p", root], { cwd: parent, timeoutMs: 5_000 });
  await runProcess("git", ["-C", root, "init", "-b", "main"], { cwd: root, timeoutMs: 30_000 });
  await runProcess("git", ["-C", root, "config", "user.email", "workgraph@example.test"], { cwd: root, timeoutMs: 30_000 });
  await runProcess("git", ["-C", root, "config", "user.name", "Workgraph CLI"], { cwd: root, timeoutMs: 30_000 });
  await writeFile(join(root, "value.txt"), "value\n");
  await runProcess("git", ["-C", root, "add", "."], { cwd: root, timeoutMs: 30_000 });
  await runProcess("git", ["-C", root, "commit", "-m", "fixture"], { cwd: root, timeoutMs: 30_000 });
  const repository = await GitRepository.open(root);
  const registry = new WorkgraphRegistry(join(parent, "registry.sqlite"));
  const begun = await WorkgraphEngine.begin({ request: "Historical fixture.", projectRoot: root, gitCommonDir: repository.commonDir, parentSessionId: "session", parentSessionFile: join(parent, "session.jsonl"), baseCommit: await repository.head(), outcome: testOutcome.outcome }, { repository, registry });
  return { parent, registry, begun };
}

test("CLI status is read-only historical inspection", async () => {
  const value = await fixture();
  try {
    const status = await runCli(["status", "--run-id", value.begun.run.runId, "--registry", value.registry.path]);
    assert.equal(status.run?.runId, value.begun.run.runId);
  } finally { value.registry.close(); await rm(value.parent, { recursive: true, force: true }); }
});

test("CLI rejects retired legacy mutation commands", async () => {
  for (const command of ["adopt", "suspend", "resume", "abandon", "archive", "recovery", "cleanup"]) {
    await assert.rejects(() => runCli([command]), (error: unknown) => error instanceof CliError && error.code === "unsupported");
  }
});
