import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The integration owns an isolated Git repository and Pi session directory.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The integration resolves the repository extension from its isolated checkout.
import { join, resolve } from "node:path";
import test from "node:test";
import { clearTimeout, setTimeout as setTimer } from "node:timers";
import {
  createAgentSession,
  DefaultResourceLoader,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type ControlledRequest,
  startControlledProvider,
} from "../scripts/live/controlled-provider.js";
import { configureFixtureEnvironment, restoreFixtureEnvironment } from "./decoders.js";
import { git } from "./helpers.js";

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-real-pi-"));
  const root = join(parent, "repo");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "fixture@example.test");
  await git(root, "config", "user.name", "Workgraph fixture");
  await writeFile(join(root, "value.txt"), "before\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "Fixture");
  const base = await git(root, "rev-parse", "HEAD");
  const previous = configureFixtureEnvironment({
    PI_CODING_AGENT_DIR: join(parent, "agent"),
    PI_WORKGRAPH_BASE_COMMIT: base,
    PI_WORKGRAPH_EXECUTOR_MODEL: "fixture/executor",
    PI_WORKGRAPH_EXECUTOR_THINKING: "off",
    PI_WORKGRAPH_IMPLEMENTATION_START: null,
    PI_WORKGRAPH_MODE: "implementation",
    PI_WORKGRAPH_NODE_ID: "attempt",
    PI_WORKGRAPH_RUN_ID: "fixture",
  });
  return { parent, root, base, previous };
}

function modelConfig(id: string) {
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

async function promptWithDeadline(
  agent: import("@earendil-works/pi-coding-agent").AgentSession,
  prompt: string,
): Promise<void> {
  let expired = false;
  // oxlint-disable-next-line effecttsgo/global-timers -- The test deadline must abort the real AgentSession.
  const timer = setTimer(() => {
    expired = true;
    void agent.abort().catch(() => undefined);
  }, 30_000);
  try {
    await agent.prompt(prompt, { source: "rpc" });
  } finally {
    clearTimeout(timer);
  }
  if (expired) throw new Error("real Pi integration prompt exceeded its 30-second deadline");
}

function assertPrefix(requests: readonly ControlledRequest[]): void {
  const first = requests[0];
  assert.ok(first);
  for (const request of requests) {
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.method, "POST");
    assert.deepEqual(request.tools, first.tools);
    assert.deepEqual(request.messages[0], first.messages[0]);
  }
  for (let index = 1; index < requests.length; index += 1) {
    const previous = requests[index - 1];
    const current = requests[index];
    assert.ok(previous && current);
    assert.ok(current.messages.length >= previous.messages.length);
    assert.deepEqual(current.messages.slice(0, previous.messages.length), previous.messages);
  }
}

void test("real Pi worker preserves provider prefix and performs guide-to-executor handoff", async () => {
  const f = await fixture();
  const provider = await startControlledProvider([
    (request) => {
      assert.equal(request.model, "guide");
      assert.ok(
        request.messages.some((message) =>
          JSON.stringify(message).includes("[WORKGRAPH LOCAL PREWALK - GUIDE]"),
        ),
      );
      return {
        tool: {
          id: "plan-call",
          name: "workgraph_plan",
          arguments: {
            action: "update",
            plan: {
              approach: "Make the one authorized fixture edit.",
              rationale: "Exercise the real worker handoff.",
              risks: "The provider must not receive a second synthetic prefix.",
              steps: [{ text: "Write and commit value.txt.", status: "pending" }],
            },
          },
        },
      };
    },
    (request) => {
      assert.equal(request.model, "guide");
      const result = request.messages.find((message) =>
        JSON.stringify(message).includes('"tool_call_id":"plan-call"'),
      );
      if (result === undefined)
        throw new Error("Initial plan tool result did not reach the next request.");
      assert.match(JSON.stringify(result), /Make the one authorized fixture edit/);
      return {
        tool: {
          id: "targeted-plan-call",
          name: "workgraph_plan",
          arguments: {
            action: "update_step",
            id: "step-1",
            patch: {
              status: "in_progress",
              note: "Targeted update crossed a real tool-result boundary.",
            },
          },
        },
      };
    },
    (request) => {
      assert.equal(request.model, "guide");
      const result = request.messages.find((message) =>
        JSON.stringify(message).includes('"tool_call_id":"targeted-plan-call"'),
      );
      if (result === undefined)
        throw new Error("Targeted plan result did not reach the next request.");
      assert.match(JSON.stringify(result), /Targeted update crossed a real tool-result boundary/);
      return {
        tool: {
          id: "write-call",
          name: "write",
          arguments: { path: "value.txt", content: "after\n" },
        },
      };
    },
    (request) => {
      assert.equal(request.model, "executor");
      assert.ok(
        request.messages.some((message) =>
          JSON.stringify(message).includes("[WORKGRAPH EXECUTOR]"),
        ),
      );
      return {
        tool: {
          id: "overview-call",
          name: "workgraph_plan",
          arguments: {
            action: "update_overview",
            patch: {
              approach: "Commit the observed authorized edit and report its direct evidence.",
              rationale:
                "The first edit confirmed the fixture path without changing assignment scope.",
              risks: "Mutable implementation knowledge must append without rewriting the prefix.",
            },
          },
        },
      };
    },
    (request) => {
      assert.equal(request.model, "executor");
      const result = request.messages.find((message) =>
        JSON.stringify(message).includes('"tool_call_id":"overview-call"'),
      );
      if (result === undefined)
        throw new Error("Executor overview result did not reach the next request.");
      assert.match(JSON.stringify(result), /without rewriting the prefix/);
      return {
        tool: {
          id: "add-step-call",
          name: "workgraph_plan",
          arguments: {
            action: "add_step",
            text: "Confirm the committed fixture bytes.",
          },
        },
      };
    },
    (request) => {
      assert.equal(request.model, "executor");
      const result = request.messages.find((message) =>
        JSON.stringify(message).includes('"tool_call_id":"add-step-call"'),
      );
      if (result === undefined)
        throw new Error("Added step result did not reach the next request.");
      assert.match(JSON.stringify(result), /step-2 pending/);
      return {
        tool: {
          id: "remove-step-call",
          name: "workgraph_plan",
          arguments: {
            action: "remove_step",
            id: "step-2",
            reason:
              "The existing verification evidence already covers this separate navigation row.",
          },
        },
      };
    },
    (request) => {
      assert.equal(request.model, "executor");
      const result = request.messages.find((message) =>
        JSON.stringify(message).includes('"tool_call_id":"remove-step-call"'),
      );
      if (result === undefined)
        throw new Error("Removed step result did not reach the next request.");
      assert.doesNotMatch(JSON.stringify(result), /step-2 pending/);
      return {
        tool: {
          id: "commit-call",
          name: "bash",
          arguments: { command: "git add value.txt && git commit -m 'Changed value'" },
        },
      };
    },
    (request) => {
      assert.equal(request.model, "executor");
      return {
        tool: {
          id: "report-call",
          name: "workgraph_report",
          arguments: {
            kind: "implementation",
            status: "completed",
            outcome: "changed",
            summary: "Changed value.txt through the executor.",
            evidence: [{ label: "bytes", observation: "value.txt contains after newline." }],
            findings: [],
          },
        },
      };
    },
  ]);
  let session: ReturnType<typeof SessionManager.create> | undefined;
  let agent: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
  try {
    const modelRuntime = await ModelRuntime.create({
      authPath: join(f.parent, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(f.parent, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    modelRuntime.registerProvider("fixture", {
      name: "Loopback fixture",
      api: "openai-completions",
      apiKey: "fixture-only",
      baseUrl: provider.baseUrl,
      models: [modelConfig("guide"), modelConfig("executor")],
    });
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    session = SessionManager.create(f.root, join(f.parent, "sessions"));
    session.appendCustomMessageEntry(
      "pi-workgraph-objective",
      "[WORKGRAPH IMPLEMENTATION OBJECTIVE]\nAuthorized: change only value.txt to after followed by one newline.",
      false,
      { runId: "fixture", nodeId: "attempt", mode: "implementation" },
    );
    const loader = new DefaultResourceLoader({
      cwd: f.root,
      agentDir: join(f.parent, "agent"),
      settingsManager: settings,
      additionalExtensionPaths: [resolve("extensions/worker.ts")],
      noContextFiles: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      systemPrompt: "Controlled worker integration.",
    });
    await loader.reload();
    const model = modelRuntime.getModel("fixture", "guide");
    assert.ok(model);
    const created = await createAgentSession({
      cwd: f.root,
      agentDir: join(f.parent, "agent"),
      modelRuntime,
      model,
      thinkingLevel: "off",
      tools: ["bash", "write", "workgraph_plan", "workgraph_report"],
      resourceLoader: loader,
      sessionManager: session,
      settingsManager: settings,
    });
    agent = created.session;
    await agent.bindExtensions({});
    await promptWithDeadline(agent, "Make the authorized fixture edit.");

    provider.assertComplete();
    assertPrefix(provider.requests);
    for (const request of provider.requests) {
      const messages = JSON.stringify(request.messages);
      assert.equal(messages.split("[WORKGRAPH LOCAL PREWALK - GUIDE]").length - 1, 1);
      assert.equal(
        messages.split("[WORKGRAPH EXECUTOR]").length - 1,
        request.model === "executor" ? 1 : 0,
      );
    }
    assert.ok(
      provider.requests.some((request) =>
        request.messages.some((message) =>
          JSON.stringify(message).includes("Mutable implementation knowledge must append"),
        ),
      ),
    );
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "after\n");
    assert.equal(await git(f.root, "status", "--porcelain"), "");
    assert.equal(await git(f.root, "rev-parse", "HEAD^"), f.base);
    const report = session
      .getBranch()
      .findLast(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolName === "workgraph_report" &&
          !entry.message.isError,
      );
    assert.ok(report?.type === "message");
    assert.match(JSON.stringify(report), /Changed value\.txt through the executor/);
    assert.ok(
      session
        .getBranch()
        .some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "pi-workgraph-worker-state" &&
            JSON.stringify(entry.data).includes('"phase":"executor"'),
        ),
    );
  } finally {
    await agent?.abort();
    agent?.dispose();
    await provider.close();
    restoreFixtureEnvironment(f.previous);
    await rm(f.parent, { recursive: true, force: true });
  }
});

void test("real Pi worker excludes configured built-in and extension tools before initial and dynamic follow-up requests", async () => {
  const f = await fixture();
  const previous = configureFixtureEnvironment({
    PI_CODING_AGENT_DIR: join(f.parent, "agent"),
    PI_WORKGRAPH_BASE_COMMIT: f.base,
    PI_WORKGRAPH_EXECUTOR_MODEL: "fixture/executor",
    PI_WORKGRAPH_EXECUTOR_THINKING: "off",
    PI_WORKGRAPH_IMPLEMENTATION_START: null,
    PI_WORKGRAPH_MODE: "research",
    PI_WORKGRAPH_NODE_ID: "attempt",
    PI_WORKGRAPH_RUN_ID: "fixture",
  });
  await mkdir(join(f.parent, "agent"), { recursive: true });
  await writeFile(
    join(f.parent, "agent", "settings.json"),
    JSON.stringify({
      "pi-workgraph": {
        worker: { disabledTools: ["read", "session_denied", "dynamic_denied"] },
      },
    }),
  );
  const companion: InlineExtension = {
    name: "worker-denylist-companion",
    factory(pi) {
      pi.registerTool({
        name: "activate_dynamic",
        label: "Activate dynamic",
        description: "Register a denied tool during execution.",
        parameters: Type.Object({}),
        async execute() {
          pi.registerTool({
            name: "dynamic_denied",
            label: "Dynamic denied",
            description: "Must not reach another provider request.",
            parameters: Type.Object({}),
            async execute() {
              return { content: [{ type: "text", text: "forbidden" }], details: {} };
            },
          });
          pi.setActiveTools([...new Set([...pi.getActiveTools(), "dynamic_denied"])]);
          return { content: [{ type: "text", text: "Dynamic tool registered." }], details: {} };
        },
      });
      pi.on("session_start", () => {
        pi.registerTool({
          name: "session_denied",
          label: "Session denied",
          description: "Registered after the worker session_start handler.",
          parameters: Type.Object({}),
          async execute() {
            return { content: [{ type: "text", text: "forbidden" }], details: {} };
          },
        });
      });
    },
  };
  const provider = await startControlledProvider([
    (request) => {
      const schemas = JSON.stringify(request.tools);
      assert.doesNotMatch(schemas, /"read"/);
      assert.doesNotMatch(schemas, /"session_denied"/);
      assert.doesNotMatch(schemas, /"dynamic_denied"/);
      assert.match(schemas, /"activate_dynamic"/);
      return { tool: { id: "activate", name: "activate_dynamic", arguments: {} } };
    },
    (request) => {
      const schemas = JSON.stringify(request.tools);
      assert.doesNotMatch(schemas, /"read"/);
      assert.doesNotMatch(schemas, /"session_denied"/);
      assert.doesNotMatch(schemas, /"dynamic_denied"/);
      return {
        tool: {
          id: "report",
          name: "workgraph_report",
          arguments: {
            kind: "research",
            status: "completed",
            summary: "Configured worker tools stayed unavailable.",
            evidence: [],
            findings: [],
          },
        },
      };
    },
  ]);
  let agent: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(f.parent, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(f.parent, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerProvider("fixture", {
      name: "Loopback fixture",
      api: "openai-completions",
      apiKey: "fixture-only",
      baseUrl: provider.baseUrl,
      models: [modelConfig("worker")],
    });
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const session = SessionManager.create(f.root, join(f.parent, "worker-denylist-sessions"));
    const loader = new DefaultResourceLoader({
      cwd: f.root,
      agentDir: join(f.parent, "agent"),
      settingsManager: settings,
      additionalExtensionPaths: [resolve("extensions/worker.ts")],
      extensionFactories: [companion],
      noContextFiles: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      systemPrompt: "Controlled worker denylist integration.",
    });
    await loader.reload();
    const model = runtime.getModel("fixture", "worker");
    assert.ok(model);
    const created = await createAgentSession({
      cwd: f.root,
      agentDir: join(f.parent, "agent"),
      modelRuntime: runtime,
      model,
      thinkingLevel: "off",
      tools: [
        "read",
        "bash",
        "activate_dynamic",
        "session_denied",
        "dynamic_denied",
        "workgraph_report",
      ],
      resourceLoader: loader,
      sessionManager: session,
      settingsManager: settings,
    });
    agent = created.session;
    await agent.bindExtensions({});
    await promptWithDeadline(agent, "Exercise the worker denylist.");
    provider.assertComplete();
    assert.equal(provider.requests.length, 2);
    assert.ok(
      session
        .getBranch()
        .some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "pi-workgraph-worker-tools" &&
            JSON.stringify(entry.data).includes("dynamic_denied"),
        ),
    );
  } finally {
    await agent?.abort();
    agent?.dispose();
    await provider.close();
    restoreFixtureEnvironment(previous);
    restoreFixtureEnvironment(f.previous);
    await rm(f.parent, { recursive: true, force: true });
  }
});

void test("real Pi coordinator transports a notepad result through the bound extension", async () => {
  const f = await fixture();
  const previous = configureFixtureEnvironment({
    PI_WORKGRAPH_MODE: null,
    PI_WORKGRAPH_BASE_COMMIT: null,
    PI_WORKGRAPH_EXECUTOR_MODEL: null,
    PI_WORKGRAPH_EXECUTOR_THINKING: null,
    PI_WORKGRAPH_IMPLEMENTATION_START: null,
  });
  const provider = await startControlledProvider([
    (request) => {
      assert.equal(request.model, "coordinator");
      assert.ok(request.tools.some((tool) => JSON.stringify(tool).includes("workgraph_notepad")));
      return {
        tool: {
          id: "notepad-call",
          name: "workgraph_notepad",
          arguments: {
            action: "add",
            id: "controlled",
            text: "Result crossed the real Pi boundary.",
          },
        },
      };
    },
    (request) => {
      const result = request.messages.find((message) =>
        JSON.stringify(message).includes('"tool_call_id":"notepad-call"'),
      );
      if (result === undefined)
        throw new Error("Notepad tool result did not reach the next request.");
      assert.match(JSON.stringify(result), /Result crossed the real Pi boundary/);
      return { text: "Notepad result received." };
    },
  ]);
  let agent: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(f.parent, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(f.parent, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerProvider("fixture", {
      name: "Loopback fixture",
      api: "openai-completions",
      apiKey: "fixture-only",
      baseUrl: provider.baseUrl,
      models: [modelConfig("coordinator")],
    });
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const session = SessionManager.create(f.root, join(f.parent, "coordinator-sessions"));
    const loader = new DefaultResourceLoader({
      cwd: f.root,
      agentDir: join(f.parent, "agent"),
      settingsManager: settings,
      additionalExtensionPaths: [resolve("extensions/coordinator.ts")],
      noContextFiles: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      systemPrompt: "Controlled coordinator integration.",
    });
    await loader.reload();
    const model = runtime.getModel("fixture", "coordinator");
    assert.ok(model);
    const created = await createAgentSession({
      cwd: f.root,
      agentDir: join(f.parent, "agent"),
      modelRuntime: runtime,
      model,
      thinkingLevel: "off",
      tools: ["workgraph_notepad"],
      resourceLoader: loader,
      sessionManager: session,
      settingsManager: settings,
    });
    agent = created.session;
    await agent.bindExtensions({});
    await promptWithDeadline(agent, "Add the controlled pending item.");
    provider.assertComplete();
    assertPrefix(provider.requests);
    assert.ok(JSON.stringify(session.getBranch()).includes("Result crossed the real Pi boundary."));
  } finally {
    await agent?.abort();
    agent?.dispose();
    await provider.close();
    restoreFixtureEnvironment(previous);
    restoreFixtureEnvironment(f.previous);
    await rm(f.parent, { recursive: true, force: true });
  }
});
