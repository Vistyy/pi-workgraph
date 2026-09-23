/* oxlint-disable effecttsgo/global-timers, effecttsgo/new-promise -- This bounded integration owns disposable native files and waits for Pi's asynchronous follow-up. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { startControlledProvider } from "../../scripts/live/controlled-provider.js";
import { configureFixtureEnvironment, restoreFixtureEnvironment } from "../support/decoders.js";

function model(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 1_000,
  };
}

void test("real Pi runs the minimal guide-to-executor trajectory and semantic report", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-worker-pi-"));
  const cwd = join(parent, "repo");
  await mkdir(cwd);

  const previous = configureFixtureEnvironment({
    PI_CODING_AGENT_DIR: join(parent, "agent"),
    PI_WORKGRAPH_ROLE: "implementation",
  });

  const provider = await startControlledProvider([
    (request) => {
      assert.equal(request.model, "guide");
      assert.match(request.raw, /IMPLEMENTATION GUIDE POLICY/);
      assert.doesNotMatch(request.raw, /IMPLEMENTATION EXECUTOR POLICY/);

      return {
        tool: {
          id: "plan",
          name: "workgraph_plan",
          arguments: {
            action: "set",
            todos: [
              {
                id: "change",
                text: "Change value.txt.",
                validation: "value.txt contains after.",
              },
            ],
          },
        },
      };
    },
    () => ({
      tool: { id: "write", name: "write", arguments: { path: "value.txt", content: "after\n" } },
    }),
    (request) => {
      assert.equal(request.model, "executor");
      assert.match(request.raw, /IMPLEMENTATION EXECUTOR POLICY/);
      assert.match(request.raw, /EXECUTOR COMPLETION CHECKLIST/);
      assert.doesNotMatch(request.raw, /IMPLEMENTATION GUIDE POLICY/);

      return { text: "Executor verified the bounded edit." };
    },
    (request) => {
      assert.match(request.raw, /IMPLEMENTATION EXECUTOR POLICY/);
      assert.doesNotMatch(request.raw, /EXECUTOR COMPLETION CHECKLIST/);

      return {
        tool: {
          id: "report",
          name: "workgraph_report",
          arguments: {
            status: "completed",
            outcome: "changed",
            summary: "Changed value.txt.",
            details: "value.txt contains the verified after newline.",
          },
        },
      };
    },
  ]);

  let session: AgentSession | undefined;

  try {
    const agentDir = join(parent, "agent");

    const models = await ModelRuntime.create({
      authPath: join(parent, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(parent, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });

    models.registerProvider("fixture", {
      name: "fixture",
      api: "openai-completions",
      apiKey: "fixture",
      baseUrl: provider.baseUrl,
      models: [model("guide"), model("executor")],
    });

    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });

    const manager = SessionManager.create(cwd, join(parent, "sessions"), { id: "attempt" });
    manager.appendCustomMessageEntry(
      "pi-workgraph-objective",
      "[WORKGRAPH WORKER OBJECTIVE]\nPurpose: exercise real Pi\nObjective: change value.txt",
      true,
      {
        taskId: "worker",
        attemptId: "attempt",
        role: "implementation",
        executor: { model: "fixture/executor", thinking: "off" },
      },
    );

    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: settings,
      additionalExtensionPaths: [resolve("extensions/worker.ts")],
      noContextFiles: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      systemPrompt: "Controlled Worker.",
    });

    await loader.reload();
    const guide = models.getModel("fixture", "guide");
    assert.ok(guide);

    const created = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: models,
      model: guide,
      thinkingLevel: "off",
      tools: ["write", "workgraph_plan", "workgraph_report"],
      resourceLoader: loader,
      sessionManager: manager,
      settingsManager: settings,
    });

    session = created.session;
    await session.bindExtensions({});
    await session.prompt("Begin the assigned Workgraph task", { source: "rpc" });

    for (let index = 0; index < 100 && provider.requests.length < 4; index += 1) {
      await new Promise((resolveDelay) => {
        setTimeout(resolveDelay, 10);
      });
    }

    await session.agent.waitForIdle();
    provider.assertComplete();
    assert.equal(await readFile(join(cwd, "value.txt"), "utf8"), "after\n");
    const branch = manager.getBranch();
    assert.equal(
      branch.filter(
        (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-executor-start",
      ).length,
      1,
    );
    assert.deepEqual(
      branch
        .filter(
          (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-effective-model",
        )
        .map((entry) => (entry.type === "custom" ? entry.data : undefined)),
      [
        { model: "fixture/guide", thinking: "off" },
        { model: "fixture/executor", thinking: "off" },
      ],
    );

    const report = branch.findLast(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "workgraph_report",
    );

    assert.ok(report?.type === "message" && report.message.role === "toolResult");
    assert.deepEqual(Object.keys(report.message.details as object), ["report"]);
  } finally {
    await session?.abort();
    session?.dispose();
    await provider.close();
    restoreFixtureEnvironment(previous);
    await rm(parent, { recursive: true, force: true });
  }
});

void test("real Pi restores the exact guide before continuing after executor selection failure", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-worker-pi-failure-"));
  const cwd = join(parent, "repo");
  await mkdir(cwd);

  const previous = configureFixtureEnvironment({
    PI_CODING_AGENT_DIR: join(parent, "agent"),
    PI_WORKGRAPH_ROLE: "implementation",
  });

  const provider = await startControlledProvider([
    () => ({
      tool: {
        id: "plan",
        name: "workgraph_plan",
        arguments: {
          action: "set",
          todos: [
            {
              id: "change",
              text: "Change value.txt.",
              validation: "value.txt contains after.",
            },
          ],
        },
      },
    }),
    () => ({
      tool: { id: "write", name: "write", arguments: { path: "value.txt", content: "after\n" } },
    }),
    (request) => {
      assert.equal(request.model, "guide");
      assert.match(request.raw, /IMPLEMENTATION GUIDE POLICY/);
      assert.doesNotMatch(request.raw, /IMPLEMENTATION EXECUTOR POLICY/);
      assert.match(request.raw, /EXECUTOR SELECTION FAILED/);

      return {
        tool: {
          id: "report",
          name: "workgraph_report",
          arguments: {
            status: "failed",
            summary: "The frozen executor target was unavailable.",
            details: "Executor model selection failed before execution.",
          },
        },
      };
    },
  ]);

  let session: AgentSession | undefined;

  try {
    const agentDir = join(parent, "agent");

    const models = await ModelRuntime.create({
      authPath: join(parent, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(parent, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });

    models.registerProvider("fixture", {
      name: "fixture",
      api: "openai-completions",
      apiKey: "fixture",
      baseUrl: provider.baseUrl,
      models: [model("guide"), model("executor")],
    });

    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });

    const manager = SessionManager.create(cwd, join(parent, "sessions"), { id: "attempt" });
    manager.appendCustomMessageEntry(
      "pi-workgraph-objective",
      "[WORKGRAPH WORKER OBJECTIVE]\nPurpose: exercise failed cutover\nObjective: change value.txt",
      true,
      {
        taskId: "worker",
        attemptId: "attempt",
        role: "implementation",
        executor: { model: "fixture/executor", thinking: "high" },
      },
    );

    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: settings,
      additionalExtensionPaths: [resolve("extensions/worker.ts")],
      noContextFiles: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      systemPrompt: "Controlled Worker.",
    });

    await loader.reload();
    const guide = models.getModel("fixture", "guide");
    assert.ok(guide);

    const created = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: models,
      model: guide,
      thinkingLevel: "off",
      tools: ["write", "workgraph_plan", "workgraph_report"],
      resourceLoader: loader,
      sessionManager: manager,
      settingsManager: settings,
    });

    session = created.session;
    await session.bindExtensions({});
    await session.prompt("Begin the assigned Workgraph task", { source: "rpc" });
    await session.agent.waitForIdle();
    provider.assertComplete();
    assert.equal(session.model?.id, "guide");
    assert.equal(
      manager
        .getBranch()
        .some(
          (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-executor-start",
        ),
      false,
    );
  } finally {
    await session?.abort();
    session?.dispose();
    await provider.close();
    restoreFixtureEnvironment(previous);
    await rm(parent, { recursive: true, force: true });
  }
});
