import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The regression exercises the native executable boundary.
import { spawnSync } from "node:child_process";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The test uses a real temporary filesystem boundary.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The test uses native temporary path identities.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import type { InspectSection } from "../src/agent-facing.js";
import { runCli } from "../src/cli.js";
import { inspectSections, parseCliRequest } from "../src/cli-parse.js";
import { WorkstreamStore } from "../src/workstream.js";
import { git, persistentSession } from "./helpers.js";

void test("CLI parser maps every inspection section and bounded option", () => {
  const sections: readonly InspectSection[] = inspectSections;
  for (const section of sections) {
    const parsed = parseCliRequest(["inspect", "--state", "state.json", "--section", section]);
    assert.equal(parsed.command, "inspect");
    if (parsed.command === "inspect") assert.equal(parsed.inspection.section, section);
  }
  assert.deepEqual(
    parseCliRequest([
      "inspect",
      "--run-id",
      "run",
      "--registry",
      "registry.sqlite",
      "--task",
      "task-1",
      "--attempt",
      "attempt-1",
      "--result",
      "result-1",
      "--offset",
      "2",
      "--max-chars",
      "3",
      "--item-offset",
      "4",
      "--max-items",
      "5",
    ]),
    {
      command: "inspect",
      selection: { state: undefined, runId: "run", registry: "registry.sqlite" },
      inspection: {
        section: "overview",
        task: "task-1",
        attempt: "attempt-1",
        result: "result-1",
        offset: 2,
        maxChars: 3,
        itemOffset: 4,
        maxItems: 5,
      },
    },
  );
  assert.throws(
    () => parseCliRequest(["inspect", "--state", "a", "--state", "b"]),
    /Invalid option/,
  );
  assert.throws(() => parseCliRequest(["status", "--section", "overview"]), /Invalid option/);
  assert.throws(() => parseCliRequest(["inspect", "--section", "unknown"]), /Invalid inspection/);
});

void test("CLI status preserves historical JSON and resolves a registered run read-only", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-cli-"));
  const path = join(parent, "retained.json");
  const registryPath = join(parent, "registry.sqlite");
  const bytes = '{ "version": 999, "retained": ["untouched"] }\n';
  try {
    await writeFile(path, bytes);
    const registry = new DatabaseSync(registryPath);
    registry.exec("CREATE TABLE runs (run_id TEXT PRIMARY KEY, state_path TEXT NOT NULL)");
    registry.prepare("INSERT INTO runs(run_id, state_path) VALUES (?, ?)").run("registered", path);
    registry.close();

    const direct = await runCli(["status", "--state", path], { PI_CODING_AGENT_DIR: parent });
    assert.equal(direct.command, "status");
    if (direct.command === "status")
      assert.deepEqual(direct.state, { version: 999, retained: ["untouched"] });
    const registered = await runCli([
      "status",
      "--run-id",
      "registered",
      "--registry",
      registryPath,
    ]);
    assert.equal(registered.command, "status");
    if (registered.command === "status") assert.equal(registered.statePath, path);
    assert.equal(await readFile(path, "utf8"), bytes);
    await assert.rejects(runCli(["status"]), /Provide/);
    await assert.rejects(runCli(["fork"], {}), /parent-session-file/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("CLI inspect wires new context and judgments sections through the native store Effect", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-cli-inspect-"));
  const gitCommonDir = join(parent, ".git");
  try {
    await mkdir(gitCommonDir);
    const { state } = await WorkstreamStore.create({
      id: "cli-inspect",
      purpose: "Inspect every current top-level section",
      projectRoot: parent,
      gitCommonDir,
      coordinator: { sessionId: "coordinator", sessionFile: join(parent, "session.jsonl") },
    });
    for (const section of ["overview", "context", "judgments"] as const) {
      const result = await runCli(["inspect", "--state", state.statePath, "--section", section]);
      assert.equal(result.command, "inspect");
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("CLI fork composes native Git and Pi effects with an injectable native Herdr effect", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-cli-fork-"));
  try {
    await git(parent, "init");
    await git(parent, "config", "user.email", "fixture@example.com");
    await git(parent, "config", "user.name", "Fixture");
    await writeFile(join(parent, "tracked.txt"), "fixture\n");
    await git(parent, "add", ".");
    await git(parent, "commit", "-m", "fixture");
    const session = persistentSession(parent, join(parent, "sessions"));
    const parentSessionFile = session.getSessionFile();
    assert.ok(parentSessionFile !== undefined);
    const result = await runCli(
      ["fork", "--parent-session-file", parentSessionFile, "--target-cwd", parent],
      { PI_WORKGRAPH_HERDR_BIN: "fake-herdr" },
      (command) => {
        assert.equal(command, "fake-herdr");
        return {
          available: true,
          effects: {
            launchCoordinator: (request) =>
              Effect.succeed({
                workspaceId: "workspace-1",
                tabId: "tab-1",
                paneId: "pane-1",
                terminalId: "terminal-1",
                agentName: "fixture-coordinator",
                sessionFile: request.sessionFile,
                cwd: request.cwd,
              }),
          },
        };
      },
    );
    assert.equal(result.command, "fork");
    if (result.command === "fork") {
      assert.equal(result.identity.cwd, parent);
      assert.equal(result.identity.sessionFile, result.sessionFile);
      assert.notEqual(result.sessionFile, parentSessionFile);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("CLI bootstrap resolves its loader from an unrelated caller cwd", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-cli-bootstrap-"));
  const bootstrap = fileURLToPath(new URL("../bin/pi-workgraph.mjs", import.meta.url));
  try {
    const result = spawnSync(process.execPath, [bootstrap, "--help"], {
      cwd: parent,
      env: process.env,
      encoding: "utf8",
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.match(result.stdout, /^\{"ok":true,"command":"help"/);
    assert.equal(result.stderr, "");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
