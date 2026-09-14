import assert from "node:assert/strict";
import { existsSync } from "node:fs"; // oxlint-disable-line effecttsgo/node-builtin-import -- The pre-mutation assertion observes the real Store path.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"; // oxlint-disable-line effecttsgo/node-builtin-import -- Real isolated sessions and SQLite establish the registered boundary.
import { tmpdir } from "node:os";
import { join } from "node:path"; // oxlint-disable-line effecttsgo/node-builtin-import -- Fixture paths are exact disposable identities.
import test from "node:test";
import { Value } from "typebox/value";
import { RecordStore } from "../../src/coordinator/store.js";
import { configureFixtureEnvironment, restoreFixtureEnvironment } from "../support/decoders.js";
import { extensionFixture, git } from "../support/helpers.js";

const accepted = [
  "workgraph_models",
  "workgraph_research",
  "workgraph_consult",
  "workgraph_implement",
  "workgraph_review",
  "workgraph_attempt",
  "workgraph_inspect",
  "workgraph_control",
  "workgraph_notepad",
] as const;
async function fixture(available: boolean, workspaceId = available ? "workspace-exact" : null) {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-coordinator-"));
  const root = join(parent, "repo");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Workgraph Test");
  await git(root, "config", "user.email", "workgraph@example.invalid");
  await writeFile(join(root, "file.txt"), "base\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "base");
  const previous = configureFixtureEnvironment({
    PI_CODING_AGENT_DIR: join(parent, "agent"),
    PI_WORKGRAPH_ROLE: null,
    HERDR_ENV: available ? "1" : null,
    HERDR_WORKSPACE_ID: workspaceId,
    HERDR_TAB_ID: null,
    PI_WORKGRAPH_HERDR_BIN: "/bin/false",
  });
  const pi = await extensionFixture("coordinator", root, parent);
  return {
    ...pi,
    parent,
    root,
    agentDir: join(parent, "agent"),
    async dispose() {
      await pi.close();
      restoreFixtureEnvironment(previous);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

void test("coordinator registers exactly nine strict tools", async () => {
  const f = await fixture(false);
  try {
    const registered = f.runner
      .getAllRegisteredTools()
      .map((tool) => tool.definition.name)
      .filter((name) => name.startsWith("workgraph_"))
      .sort();
    assert.deepEqual(registered, [...accepted].sort());
    const implement = f.runner.getToolDefinition("workgraph_implement");
    assert.ok(implement !== undefined);
    assert.equal(
      Value.Check(implement.parameters, {
        id: "change",
        cwd: ".",
        objective: "Change it",
        acceptance: ["Works"],
        candidateOf: { attemptId: "attempt-old", mode: "integrate" },
        baseRevision: "a".repeat(40),
      }),
      true,
    );
    assert.equal(
      Value.Check(implement.parameters, {
        id: "change",
        objective: "Change it",
        acceptance: ["Works"],
        unexpected: true,
      }),
      false,
    );
    const control = f.runner.getToolDefinition("workgraph_control");
    assert.ok(control !== undefined);
    assert.equal(
      Value.Check(control.parameters, { action: "cancel", attemptId: "a", reason: "stop" }),
      true,
    );
    assert.equal(Value.Check(control.parameters, { action: "cancel", attemptId: "a" }), false);
    assert.equal(
      Value.Check(control.parameters, { action: "discard_output", attemptId: "a", reason: "old" }),
      true,
    );
  } finally {
    await f.dispose();
  }
});

void test("one session creates frozen Task and Attempt records and inspects them boundedly", async () => {
  const f = await fixture(true);
  try {
    await f.runner.emit({ type: "session_start", reason: "startup" });
    const base = await git(f.root, "rev-parse", "HEAD");
    const created = await f.call("workgraph_implement", {
      id: "change",
      cwd: ".",
      objective: "Change the fixture",
      acceptance: ["The change is committed"],
    });
    // SAFETY: The registered implementation tool returns this bounded creation receipt.
    const details = created.details as {
      taskId: string;
      attempts: { taskId: string; attemptId: string }[];
    };
    assert.equal(details.taskId, "change");
    assert.equal(details.attempts.length, 1);
    const attemptId = details.attempts[0]?.attemptId;
    assert.ok(attemptId !== undefined);

    const task = await f.call("workgraph_inspect", { section: "task", id: "change" });
    // SAFETY: Exact Task inspection returns the strictly decoded persisted Task record.
    assert.deepEqual(
      (task.details as { task: { target: { checkoutRoot: string } } }).task.target.checkoutRoot,
      f.root,
    );
    const attempt = await f.call("workgraph_inspect", { section: "attempt", id: attemptId });
    // SAFETY: Exact Attempt inspection returns the strictly decoded persisted Attempt projection.
    assert.equal(
      (attempt.details as { spec: { base: { baseCommit: string } } }).spec.base.baseCommit,
      base,
    );
    // SAFETY: Pi tool details are object-shaped for every registered Workgraph result.
    assert.equal("report" in (attempt.details as object), false);
    const page = await f.call("workgraph_inspect", {
      section: "attempt",
      offset: 0,
      limit: 1,
    });
    // SAFETY: Attempt page inspection returns its bounded attempts array.
    assert.equal((page.details as { attempts: unknown[] }).attempts.length, 1);

    await f.call("workgraph_notepad", { action: "replace", text: "Keep the target frozen." });
    const note = await f.call("workgraph_notepad", { action: "read" });
    // SAFETY: The notepad read action returns its bounded text field.
    assert.equal((note.details as { text: string }).text, "Keep the target frozen.");

    await f.call("workgraph_research", {
      id: "read-only",
      question: "What is here?",
      expectedEvidence: ["Direct inspection"],
    });
    await assert.rejects(
      f.call("workgraph_attempt", { taskId: "read-only", baseRevision: base }),
      /baseRevision is supported only for repository Attempts/,
    );
    await assert.rejects(
      f.call("workgraph_attempt", { taskId: "read-only", useEscalationExecutor: true }),
      /useEscalationExecutor is supported only for implementation Attempts/,
    );
    const overview = await f.call("workgraph_inspect", { section: "overview" });
    // SAFETY: Overview returns exact session-local record counts.
    assert.equal((overview.details as { counts: { attempts: number } }).counts.attempts, 2);

    const other = new RecordStore(f.agentDir, "other-session");
    assert.deepEqual(other.counts(), { tasks: 0, attempts: 0, activeWorkers: 0 });
    other.close();

    await f.runner.emit({ type: "session_shutdown", reason: "reload" });
    const restored = new RecordStore(f.agentDir, f.session.getSessionId());
    assert.equal(restored.readAttempt(attemptId).spec.base.kind, "repository");
    assert.equal(restored.readAttempt(attemptId).taskId, "change");
    restored.close();
  } finally {
    await f.dispose();
  }
});

void test("without exact Herdr launch identity inspection remains usable and creation mutates nothing", async () => {
  for (const [available, workspaceId] of [
    [false, null],
    [true, ""],
  ] as const) {
    const f = await fixture(available, workspaceId);
    try {
      await f.runner.emit({ type: "session_start", reason: "startup" });
      const overview = await f.call("workgraph_inspect", { section: "overview" });
      // SAFETY: Overview inspection returns the RecordStore count projection.
      assert.deepEqual((overview.details as { counts: object }).counts, {
        tasks: 0,
        attempts: 0,
        activeWorkers: 0,
      });
      const models = await f.call("workgraph_models", { role: "research" });
      // SAFETY: Model inspection returns the strictly decoded configured target list.
      assert.equal((models.details as { targets: unknown[] }).targets.length, 2);
      await assert.rejects(
        f.call("workgraph_research", {
          id: "blocked",
          question: "What changed?",
          expectedEvidence: ["Direct inspection"],
        }),
        /Herdr runtime and exact workspace identity are unavailable/,
      );
      assert.equal(existsSync(join(f.agentDir, "workgraph", "workgraph.sqlite")), false);
    } finally {
      await f.dispose();
    }
  }
});
