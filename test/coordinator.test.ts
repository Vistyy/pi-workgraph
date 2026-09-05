import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitRepository } from "../src/git.js";
import { HerdrCliRuntime } from "../src/herdr.js";
import { WorkgraphRegistry } from "../src/registry.js";
import { WorkstreamStore } from "../src/workstream.js";
import { WorkstreamRuntime } from "../src/workstream-runtime.js";
import { extensionFixture, git, resultState } from "./helpers.js";

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-coordinator-"));
  const root = join(parent, "repo");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "fixture@example.test");
  await git(root, "config", "user.name", "Fixture");
  await writeFile(join(root, "value.txt"), "before\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "Fixture");
  const previous = { ...process.env };
  process.env.PI_CODING_AGENT_DIR = join(parent, "agent");
  delete process.env.PI_WORKGRAPH_MODE;
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_WORKSPACE_ID;
  const pi = await extensionFixture("coordinator", root, parent);
  return {
    ...pi,
    root,
    parent,
    async dispose() {
      await pi.close();
      for (const key of Object.keys(process.env))
        if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

test("registered capability tools create work implicitly and retain only human input as authority across reload", async () => {
  const f = await fixture();
  try {
    const initial = resultState(
      (
        await f.call("workgraph_research", {
          id: "read-value",
          question: "What is value.txt?",
          expectedEvidence: ["Exact bytes"],
        })
      ).details,
    );
    assert.equal(initial.assignments[0]?.id, "read-value");
    const request = {
      id: "fix-value",
      objective: "Fix value",
      acceptance: ["Correct bytes"],
    };
    await f.runner.emitInput("Implement a change", undefined, "extension");
    await assert.rejects(
      f.call("workgraph_implement", request),
      /actual retained human input/,
    );
    await f.runner.emitInput(
      "Implement the maintained value change",
      undefined,
      "interactive",
    );
    const authorized = resultState(
      (await f.call("workgraph_implement", request)).details,
    );
    assert.equal(authorized.inputs.length, 1);
    assert.equal(authorized.intents.at(-1)?.version, 1);
    await f.call("workgraph_control", {
      action: "suspend",
      reason: "Pause fixture",
    });
    await f.runner.emit({ type: "session_shutdown", reason: "reload" });
    await f.runner.emit({ type: "session_start", reason: "reload" });
    const reloaded = resultState(
      (await f.call("workgraph_status", {})).details,
    );
    assert.equal(reloaded.lifecycle.state, "suspended");
    assert.equal(reloaded.inputs.length, 1);
    await assert.rejects(
      f.call("workgraph_research", {
        id: "while-paused",
        question: "Read again",
        expectedEvidence: ["bytes"],
      }),
      /suspended/,
    );
  } finally {
    await f.dispose();
  }
});

test("failed registered adoption preserves the attached runtime lease; same-target attachment reuses it", async () => {
  const f = await fixture();
  let competing: WorkstreamRuntime | undefined;
  const registry = new WorkgraphRegistry(
    join(f.parent, "agent", "workgraph", "registry.sqlite"),
  );
  try {
    const a = resultState(
      (await f.call("workgraph_begin", { purpose: "Current work" })).details,
    );
    const repository = await GitRepository.open(f.root);
    const otherOwner = {
      sessionId: "other",
      sessionFile: join(f.parent, "other.jsonl"),
    };
    const { store } = await WorkstreamStore.create({
      id: "other-work",
      purpose: "Other work",
      projectRoot: f.root,
      gitCommonDir: repository.commonDir,
      coordinator: otherOwner,
    });
    competing = new WorkstreamRuntime(
      store,
      repository,
      new HerdrCliRuntime(),
      { workspaceId: "" },
      () => {},
      () => {},
      { registry },
    );
    await competing.perform(async () => undefined);
    await assert.rejects(
      f.call("workgraph_adopt", { statePath: store.path }),
      /runtime owner/,
    );
    assert.equal(
      resultState((await f.call("workgraph_status", {})).details).id,
      a.id,
    );
    assert.throws(() => registry.acquire(a.id, a.coordinator), /runtime owner/);
    const same = resultState(
      (await f.call("workgraph_adopt", { statePath: a.statePath })).details,
    );
    assert.equal(same.id, a.id);
    await f.call("workgraph_control", {
      action: "suspend",
      reason: "Existing runtime is still usable",
    });
    await competing.stop();
    const adopted = resultState(
      (await f.call("workgraph_adopt", { statePath: store.path })).details,
    );
    assert.equal(adopted.id, "other-work");
    assert.equal(adopted.coordinator.sessionId, f.session.getSessionId());
    const released = registry.acquire(a.id, a.coordinator);
    registry.release(released);
  } finally {
    await competing?.stop();
    registry.close();
    await f.dispose();
  }
});

test("registered model policy get/set affects later assignments but not overrides or coordinator selection", async () => {
  const f = await fixture();
  try {
    await f.call("workgraph_models", { action: "get" });
    await f.call("workgraph_models", {
      action: "set",
      role: "research",
      target: { model: "fixture/default", thinking: "low" },
    });
    let state = resultState(
      (
        await f.call("workgraph_research", {
          id: "first",
          question: "Read",
          expectedEvidence: ["bytes"],
        })
      ).details,
    );
    assert.deepEqual(state.attempts[0]?.models?.guide, {
      model: "fixture/default",
      thinking: "low",
    });
    await f.call("workgraph_models", {
      action: "set",
      role: "research",
      target: { model: "fixture/changed", thinking: "high" },
    });
    state = resultState(
      (
        await f.call("workgraph_research", {
          id: "second",
          question: "Read",
          expectedEvidence: ["bytes"],
          model: "fixture/override",
        })
      ).details,
    );
    assert.equal(state.attempts[1]?.models?.guide.model, "fixture/override");
    assert.equal(state.attempts[1]?.models?.source, "override");
    state = resultState(
      (
        await f.call("workgraph_research", {
          id: "third",
          question: "Read",
          expectedEvidence: ["bytes"],
        })
      ).details,
    );
    assert.equal(state.attempts[2]?.models?.guide.model, "fixture/changed");
    assert.deepEqual(f.selected, []);
  } finally {
    await f.dispose();
  }
});
