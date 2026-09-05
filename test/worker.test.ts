import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { extensionFixture, git, usage } from "./helpers.js";

function assistant(session: SessionManager, model = "gpt-4o") {
  return session.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "fixture",
        name: "workgraph_report",
        arguments: {
          kind: "implementation",
          status: "completed",
          summary: "Changed fixture",
          evidence: [],
          findings: [],
        },
      },
    ],
    api: "openai-responses",
    provider: "openai",
    model,
    usage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
}

async function fixture(mode: "implementation" | "review", continued = false) {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-worker-"));
  const root = join(parent, "repo");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "fixture@example.test");
  await git(root, "config", "user.name", "Fixture");
  await writeFile(join(root, "value.txt"), "before\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "Fixture");
  const previous = { ...process.env };
  process.env.PI_WORKGRAPH_MODE = mode;
  process.env.PI_WORKGRAPH_RUN_ID = "fixture";
  process.env.PI_WORKGRAPH_NODE_ID = "attempt";
  process.env.PI_WORKGRAPH_BASE_COMMIT = await git(root, "rev-parse", "HEAD");
  process.env.PI_WORKGRAPH_EXECUTOR_MODEL = "openai/gpt-4o";
  process.env.PI_WORKGRAPH_EXECUTOR_THINKING = "high";
  if (continued) process.env.PI_WORKGRAPH_IMPLEMENTATION_START = "executor";
  else delete process.env.PI_WORKGRAPH_IMPLEMENTATION_START;
  delete process.env.PI_WORKGRAPH_EXPERIMENT;
  const pi = await extensionFixture("worker", root, parent);
  return {
    ...pi,
    root,
    async dispose() {
      await pi.close();
      for (const key of Object.keys(process.env))
        if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

test("registered worker observes a non-edit mutation, switches locally, reports a direct commit and native settlement", async () => {
  const f = await fixture("implementation");
  try {
    assert.ok(f.registry.find("openai", "gpt-4o"));
    const report = {
      kind: "implementation",
      status: "completed",
      summary: "Changed fixture",
      evidence: [],
      findings: [],
    };
    // A forked trajectory's earlier attempt must not restore this attempt's phase.
    f.session.appendCustomEntry("pi-workgraph-worker-state", {
      runId: "fixture",
      nodeId: "prior-attempt",
      phase: "executor",
      switchedAt: new Date().toISOString(),
    });
    assistant(f.session);
    await f.runner.emit({ type: "session_start", reason: "startup" });
    await assert.rejects(
      f.call("workgraph_report", report),
      /first-edit model transition/,
    );
    await f.runner.emit({ type: "agent_start" });
    await f.runner.emit({
      type: "tool_execution_end",
      toolCallId: "read",
      toolName: "read",
      result: {},
      isError: false,
    });
    assert.deepEqual(f.selected, []);
    // Even guide == executor must produce a later generation, not merely select itself.
    assistant(f.session);
    await writeFile(join(f.root, "value.txt"), "after\n");
    await f.runner.emit({
      type: "tool_execution_end",
      toolCallId: "opaque",
      toolName: "custom_mutation",
      result: {},
      isError: false,
    });
    assert.deepEqual(f.selected, ["openai/gpt-4o"]);
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-m", "Changed value");
    // A clean direct commit and selection metadata cannot validate a batched guide report.
    await assert.rejects(
      f.call("workgraph_report", report),
      /actual executor assistant message/,
    );
    assistant(f.session, "wrong-model");
    await assert.rejects(
      f.call("workgraph_report", report),
      /actual executor assistant message/,
    );
    assistant(f.session);
    await f.runner.emit({ type: "session_start", reason: "reload" });
    const result = await f.call("workgraph_report", report);
    assert.equal(result.terminate, true);
    const details = result.details;
    assert.ok(
      details &&
        typeof details === "object" &&
        "state" in details &&
        "report" in details,
    );
    assert.ok(
      details.state &&
        typeof details.state === "object" &&
        "todos" in details.state &&
        "todoRecorded" in details.state,
    );
    assert.deepEqual(details.state.todos, []);
    assert.equal(details.state.todoRecorded, false);
    assert.ok(
      details.report &&
        typeof details.report === "object" &&
        "commit" in details.report,
    );
    assert.equal(details.report.commit, await git(f.root, "rev-parse", "HEAD"));
    await f.runner.emit({ type: "agent_settled" });
    const markers = f.session
      .getBranch()
      .filter((entry) => entry.type === "custom")
      .map((entry) => entry.customType);
    assert.ok(markers.includes("pi-workgraph-agent-running"));
    assert.ok(markers.includes("pi-workgraph-agent-settled"));
    await writeFile(join(f.root, "value.txt"), "third\n");
    await git(f.root, "commit", "-am", "Extra commit");
    await assert.rejects(
      f.call("workgraph_report", report),
      /exactly one direct commit/,
    );
  } finally {
    await f.dispose();
  }
});

test("continued implementation requires this attempt's native start and later executor message, not inherited evidence", async () => {
  const f = await fixture("implementation", true);
  const report = {
    kind: "implementation",
    status: "completed",
    summary: "Continued work",
    evidence: [],
    findings: [],
  };
  try {
    f.session.appendCustomEntry("pi-workgraph-worker-state", {
      runId: "fixture",
      nodeId: "prior-attempt",
      phase: "executor",
      switchedAt: new Date().toISOString(),
    });
    f.session.appendCustomEntry("pi-workgraph-agent-running", {
      runId: "fixture",
      nodeId: "prior-attempt",
    });
    assistant(f.session);
    await f.runner.emit({ type: "session_start", reason: "startup" });
    await writeFile(join(f.root, "value.txt"), "after\n");
    await git(f.root, "commit", "-am", "Continued change");
    await assert.rejects(
      f.call("workgraph_report", report),
      /actual executor assistant message/,
    );
    await f.runner.emit({ type: "agent_start" });
    await assert.rejects(
      f.call("workgraph_report", report),
      /actual executor assistant message/,
    );
    assistant(f.session);
    assert.equal((await f.call("workgraph_report", report)).terminate, true);
    await writeFile(join(f.root, "value.txt"), "dirty\n");
    await assert.rejects(f.call("workgraph_report", report), /clean worktree/);
  } finally {
    await f.dispose();
  }
});

test("read-only review rejects a committed revision change as well as dirty files", async () => {
  const f = await fixture("review");
  const report = {
    kind: "review",
    status: "completed",
    summary: "Reviewed",
    evidence: [],
    findings: [],
  };
  try {
    assert.equal((await f.call("workgraph_report", report)).terminate, true);
    await writeFile(join(f.root, "value.txt"), "changed\n");
    await assert.rejects(f.call("workgraph_report", report), /read-only/);
    await git(f.root, "commit", "-am", "Unauthorized change");
    await assert.rejects(
      f.call("workgraph_report", report),
      /assigned revision/,
    );
  } finally {
    await f.dispose();
  }
});
