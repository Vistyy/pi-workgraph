import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HerdrCliRuntime,
  herdrAgentName,
  herdrCoordinatorNames,
  herdrWorkerName,
  herdrWorkerTabLabel,
  legacyHerdrAgentName,
  legacyObjectiveHerdrWorkerName,
} from "../src/herdr.js";
import type { WorkerIdentity, WorkerResourceIdentity } from "../src/types.js";

test("task-first Herdr names are bounded, readable, role-specific, and distinguish attempts", () => {
  const request = {
    runId: "RUN/with spaces and symbols",
    nodeId: "attempt-one",
    attemptId: "attempt-one",
    assignmentId: "meaningful-agent-names",
    objective:
      "Implement parser support for accented input and a very long trailing explanation",
    role: "implement" as const,
  };
  const first = herdrWorkerName(request);
  const second = herdrWorkerName({ ...request, attemptId: "attempt-two" });
  const label = herdrWorkerTabLabel(request);
  assert.match(first, /^meaningful-agen[a-z]*-implement-[a-f0-9]{6}$/);
  assert.match(first, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.match(label, /^Meaningful agent names - implement - [a-f0-9]{6}$/);
  assert.ok(label.length <= 48);
  assert.notEqual(first, second);
  const fallback = herdrWorkerTabLabel({
    ...request,
    assignmentId: "assignment-123456789abcdef0",
    objective: "Implement parser support",
  });
  assert.match(
    fallback,
    /^Implement parser support - implement - [a-f0-9]{6}$/,
  );
  assert.equal(
    herdrAgentName("run", "node", "attempt"),
    legacyHerdrAgentName("run", "node", "attempt"),
  );
  assert.notEqual(
    legacyObjectiveHerdrWorkerName(request),
    herdrWorkerName(request),
  );
});

test("coordinator fork names use repository context without exposing paths", () => {
  const names = herdrCoordinatorNames({
    cwd: "/private/Customer Work/repo-name",
    sessionFile: "/private/session.jsonl",
  });
  assert.match(names.agentName, /^repo-name-coordinator-[a-f0-9]{6}$/);
  assert.match(names.agentName, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.match(names.label, /^repo name - coordinator - [a-f0-9]{6}$/);
  assert.equal(names.label.includes("Customer"), false);
  assert.equal(names.label.includes("/"), false);
});

test("Herdr identity validation rejects missing and mismatched native session or cwd", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-herdr-identity-"));
  const responsePath = join(parent, "agent.json");
  const command = join(parent, "fake-herdr-identity.mjs");
  const identity: WorkerIdentity = {
    workspaceId: "workspace-1",
    tabId: "workspace-1:tab-1",
    paneId: "workspace-1:pane-1",
    terminalId: "terminal-1",
    agentName: herdrAgentName("run", "node", "attempt"),
    sessionFile: join(parent, "worker.jsonl"),
    cwd: join(parent, "worktree"),
  };
  const valid = {
    workspace_id: identity.workspaceId,
    tab_id: identity.tabId,
    pane_id: identity.paneId,
    terminal_id: identity.terminalId,
    agent_status: "working",
    name: identity.agentName,
    cwd: identity.cwd,
    agent_session: { value: identity.sessionFile },
  };
  await writeFile(
    command,
    `#!/usr/bin/env node\nimport { readFileSync } from "node:fs";\nconst agent = JSON.parse(readFileSync(${JSON.stringify(responsePath)}, "utf8"));\nconsole.log(JSON.stringify({result:{agent}}));\n`,
  );
  await chmod(command, 0o755);
  const runtime = new HerdrCliRuntime(command, {
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: identity.workspaceId,
  });
  try {
    const missingSession = structuredClone(valid) as Partial<typeof valid>;
    delete missingSession.agent_session;
    await writeFile(responsePath, JSON.stringify(missingSession));
    await assert.rejects(() => runtime.observe(identity), /agent_session/);

    const missingCwd = structuredClone(valid) as Partial<typeof valid>;
    delete missingCwd.cwd;
    await writeFile(responsePath, JSON.stringify(missingCwd));
    await assert.rejects(() => runtime.observe(identity), /cwd/);

    await writeFile(
      responsePath,
      JSON.stringify({
        ...valid,
        agent_session: { value: join(parent, "other.jsonl") },
      }),
    );
    await assert.rejects(
      () => runtime.observe(identity),
      /native Pi session changed/,
    );

    await writeFile(
      responsePath,
      JSON.stringify({ ...valid, cwd: join(parent, "other-worktree") }),
    );
    await assert.rejects(() => runtime.observe(identity), /worker cwd changed/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("current-session coordinator observation accepts an unnamed detected Pi pane without weakening worker identity", async () => {
  const parent = await mkdtemp(
    join(tmpdir(), "pi-workgraph-herdr-coordinator-"),
  );
  const command = join(parent, "fake-herdr-coordinator.mjs");
  const cwd = join(parent, "repo");
  const sessionFile = join(parent, "coordinator.jsonl");
  const agent = {
    workspace_id: "workspace-1",
    tab_id: "workspace-1:tab-1",
    pane_id: "workspace-1:pane-1",
    terminal_id: "terminal-1",
    agent_status: "working",
    cwd,
    agent_session: { value: sessionFile },
  };
  await writeFile(
    command,
    `#!/usr/bin/env node\nconsole.log(JSON.stringify({result:{agent:${JSON.stringify(agent)}}}));\n`,
  );
  await chmod(command, 0o755);
  try {
    const runtime = new HerdrCliRuntime(command, {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "workspace-1",
    });
    const coordinator = await runtime.observeCurrentCoordinator({
      paneId: agent.pane_id,
      sessionFile,
      cwd,
    });
    assert.equal(coordinator.agentName, undefined);
    assert.equal(coordinator.sessionFile, sessionFile);
    await assert.rejects(
      () =>
        runtime.observe({ ...coordinator, agentName: "required-worker-name" }),
      /omitted string name/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("coordinator forks into a new unfocused workspace with isolated Pi identity", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-herdr-fork-"));
  const log = join(parent, "commands.jsonl");
  const command = join(parent, "fake-herdr-fork.mjs");
  const cwd = join(parent, "child-repo");
  const sessionFile = join(parent, "child.jsonl");
  const coordinatorAgentName = herdrCoordinatorNames({
    cwd,
    sessionFile,
  }).agentName;
  await writeFile(
    command,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const agentName = ${JSON.stringify(coordinatorAgentName)};
const agent = (native) => ({workspace_id:"child-workspace",tab_id:"child-workspace:tab-1",pane_id:"child-workspace:pane-1",terminal_id:"child-terminal",agent_status:"idle",name:agentName,cwd:${JSON.stringify(cwd)},...(native ? {agent_session:{value:${JSON.stringify(sessionFile)}}} : {})});
if (args[0] === "workspace" && args[1] === "create") console.log(JSON.stringify({result:{workspace:{workspace_id:"child-workspace"},tab:{tab_id:"child-workspace:tab-1"},root_pane:{pane_id:"child-workspace:pane-1"}}}));
else if (args[0] === "agent" && args[1] === "start") console.log(JSON.stringify({result:{agent:agent(false)}}));
else if (args[0] === "agent" && args[1] === "get") console.log(JSON.stringify({result:{agent:agent(true)}}));
else console.log(JSON.stringify({result:{accepted:true}}));
`,
  );
  await chmod(command, 0o755);
  try {
    const runtime = new HerdrCliRuntime(command, {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "parent-workspace",
      PI_CODING_AGENT_DIR: join(parent, "private-agent"),
      PI_WORKGRAPH_MODE: "implementation",
      PI_WORKGRAPH_RUN_ID: "parent-run",
      PI_WORKGRAPH_NODE_ID: "parent-attempt",
      PI_WORKGRAPH_BASE_COMMIT: "deadbeef",
      PI_WORKGRAPH_EXECUTOR_MODEL: "private-model",
      PI_WORKGRAPH_EXECUTOR_THINKING: "high",
    });
    const identity = await runtime.launchCoordinator({ cwd, sessionFile });
    assert.deepEqual(identity, {
      workspaceId: "child-workspace",
      tabId: "child-workspace:tab-1",
      paneId: "child-workspace:pane-1",
      terminalId: "child-terminal",
      agentName: identity.agentName,
      sessionFile,
      cwd,
    });
    assert.notEqual(identity.workspaceId, "parent-workspace");
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const create = calls.find(
      (args) => args[0] === "workspace" && args[1] === "create",
    )!;
    assert.equal(create.includes("--workspace"), false);
    assert.equal(create.includes("--no-focus"), true);
    assert.ok(
      create.includes(`PI_CODING_AGENT_DIR=${join(parent, "private-agent")}`),
    );
    for (const key of [
      "PI_WORKGRAPH_MODE",
      "PI_WORKGRAPH_RUN_ID",
      "PI_WORKGRAPH_NODE_ID",
      "PI_WORKGRAPH_BASE_COMMIT",
      "PI_WORKGRAPH_EXECUTOR_MODEL",
      "PI_WORKGRAPH_EXECUTOR_THINKING",
    ])
      assert.ok(create.includes(`${key}=`));
    const start = calls.find(
      (args) => args[0] === "agent" && args[1] === "start",
    )!;
    assert.deepEqual(start.slice(0, 7), [
      "agent",
      "start",
      identity.agentName,
      "--kind",
      "pi",
      "--pane",
      identity.paneId,
    ]);
    assert.deepEqual(start.slice(-2), ["--session", sessionFile]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("uncertain coordinator startup retains the exact created workspace handles", async () => {
  const parent = await mkdtemp(
    join(tmpdir(), "pi-workgraph-herdr-fork-failure-"),
  );
  const command = join(parent, "fake-herdr-fork-failure.mjs");
  const cwd = join(parent, "child-repo");
  const sessionFile = join(parent, "child.jsonl");
  await writeFile(
    command,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const agent = {workspace_id:"child-workspace",tab_id:"child-workspace:tab-1",pane_id:"child-workspace:pane-1",terminal_id:"child-terminal",agent_status:"working",name:args[2] || "unknown",cwd:${JSON.stringify(cwd)}};
if (args[0] === "workspace") console.log(JSON.stringify({result:{workspace:{workspace_id:"child-workspace"},tab:{tab_id:"child-workspace:tab-1"},root_pane:{pane_id:"child-workspace:pane-1"}}}));
else if (args[0] === "agent" && args[1] === "start") console.log(JSON.stringify({result:{agent}}));
else if (args[0] === "agent" && args[1] === "get") console.log(JSON.stringify({result:{agent}}));
else console.log(JSON.stringify({result:{accepted:true}}));
`,
  );
  await chmod(command, 0o755);
  try {
    const runtime = new HerdrCliRuntime(command, {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "parent-workspace",
    });
    await assert.rejects(
      () => runtime.launchCoordinator({ cwd, sessionFile }),
      (error: unknown) => {
        assert.equal(
          error instanceof Error && error.name,
          "CoordinatorLaunchError",
        );
        const resource = (error as { resource?: unknown }).resource;
        assert.deepEqual(resource, {
          workspaceId: "child-workspace",
          tabId: "child-workspace:tab-1",
          paneId: "child-workspace:pane-1",
          agentName: (resource as { agentName: string }).agentName,
          terminalId: "child-terminal",
          sessionFile,
          cwd,
        });
        assert.match(
          String(error),
          /Inspect these exact handles before retrying/,
        );
        return true;
      },
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("cleanup rejects mismatched cwd, verifies exact tab absence and tolerates already completed closure", async () => {
  const parent = await mkdtemp(
    join(tmpdir(), "pi-workgraph-herdr-deleted-cleanup-"),
  );
  const command = join(parent, "fake-herdr-cleanup.mjs");
  const closed = join(parent, "closed");
  const cwd = join(parent, "worktree");
  const sessionFile = join(parent, "worker.jsonl");
  const identity: WorkerIdentity = {
    workspaceId: "workspace-1",
    tabId: "workspace-1:tab-1",
    paneId: "workspace-1:pane-1",
    terminalId: "terminal-1",
    agentName: "wg-cleanup",
    sessionFile,
    cwd,
  };
  const agent = {
    workspace_id: identity.workspaceId,
    tab_id: identity.tabId,
    pane_id: identity.paneId,
    terminal_id: identity.terminalId,
    agent_status: "idle",
    name: identity.agentName,
    cwd,
    agent_session: { value: sessionFile },
  };
  await writeFile(
    command,
    `#!/usr/bin/env node\nimport { existsSync, writeFileSync } from "node:fs";\nconst args=process.argv.slice(2);\nconst closed=${JSON.stringify(closed)};\nif(args[0]==="agent"&&args[1]==="get"){if(existsSync(closed)){console.error(JSON.stringify({error:{code:"pane_not_found",message:"gone"}}));process.exit(1)}console.log(JSON.stringify({result:{agent:${JSON.stringify(agent)}}}))}\nelse if(args[0]==="tab"&&args[1]==="close"){writeFileSync(closed,"");console.log(JSON.stringify({result:{type:"ok"}}))}\nelse if(args[0]==="tab"&&args[1]==="get"&&existsSync(closed)){console.error(JSON.stringify({error:{code:"tab_not_found",message:"gone"}}));process.exit(1)}\nelse console.log(JSON.stringify({result:{tab:{tab_id:${JSON.stringify(identity.tabId)}}}}));\n`,
  );
  await chmod(command, 0o755);
  try {
    const runtime = new HerdrCliRuntime(command, {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: identity.workspaceId,
    });
    await assert.rejects(
      () => runtime.cleanup({ ...identity, cwd: `${cwd}-different` }),
      /worker cwd changed/,
    );
    const result = await runtime.cleanup(identity);
    assert.equal(result.state, "completed");
    assert.match(result.detail, /Closed and verified exact Herdr tab/);
    assert.equal(existsSync(closed), true);
    assert.equal((await runtime.cleanup(identity)).state, "completed");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the Herdr adapter launches without waiting and validates exact identity before interrupt", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-herdr-"));
  const log = join(parent, "commands.jsonl");
  const command = join(parent, "fake-herdr.mjs");
  const cwd = join(parent, "worktree");
  const sessionFile = join(parent, "worker.jsonl");
  const naming = {
    runId: "run",
    nodeId: "node",
    attemptId: "attempt",
    assignmentId: "parse",
    objective: "Implement parser support",
    role: "implement" as const,
  };
  const agentName = herdrWorkerName(naming);
  const agent = {
    workspace_id: "workspace-1",
    tab_id: "workspace-1:tab-1",
    pane_id: "workspace-1:pane-1",
    terminal_id: "terminal-1",
    agent_status: "working",
    name: agentName,
    cwd,
    agent_session: { value: sessionFile },
  };
  await writeFile(
    command,
    `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");\nif (args[0] === "tab") console.log(JSON.stringify({result:{root_pane:{pane_id:"workspace-1:pane-1"}}}));\nelse if (args[0] === "api") console.log(JSON.stringify({result:{snapshot:{agents:[${JSON.stringify(agent)}]}}}));\nelse if (args[0] === "agent" && args[1] === "start") console.log(JSON.stringify({result:{agent:${JSON.stringify(agent)}}}));\nelse if (args[0] === "agent" && args[1] === "get") console.log(JSON.stringify({result:{agent:${JSON.stringify(agent)}}}));\nelse console.log(JSON.stringify({result:{accepted:true}}));\n`,
  );
  await chmod(command, 0o755);
  try {
    const runtime = new HerdrCliRuntime(command, {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "workspace-1",
    });
    let retained: WorkerIdentity | undefined;
    const observation = await runtime.launch({
      workspaceId: "workspace-1",
      ...naming,
      cwd,
      sessionFile,
      prompt: "Continue now.",
      env: { PI_WORKGRAPH_MODE: "implementation" },
      onIdentity(identity) {
        retained = identity;
      },
    });
    assert.deepEqual(retained, observation.identity);
    assert.equal(observation.identity.workspaceId, "workspace-1");
    assert.equal(observation.identity.paneId, "workspace-1:pane-1");
    assert.equal(observation.identity.sessionFile, sessionFile);
    const recovered = await runtime.recover({
      workspaceId: "workspace-1",
      agentName: herdrWorkerName({
        runId: "run",
        nodeId: "node",
        attemptId: "attempt",
        assignmentId: "assignment",
        objective: "Inspect the node",
        role: "research",
      }),
      compatibleAgentNames: [observation.identity.agentName],
      sessionFile,
      cwd,
    });
    assert.deepEqual(recovered?.identity, observation.identity);
    assert.equal(recovered?.status, "working");
    await runtime.interrupt(observation.identity);
    const pendingCleanup = await runtime.cleanup(observation.identity);
    assert.equal(pendingCleanup.state, "pending");
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const prompt = calls.find(
      (args) => args[0] === "agent" && args[1] === "prompt",
    )!;
    assert.equal(prompt.includes("--wait"), false);
    const tabCreate = calls.find(
      (args) => args[0] === "tab" && args[1] === "create",
    )!;
    assert.ok(tabCreate.includes(herdrWorkerTabLabel(naming)));
    assert.deepEqual(
      calls
        .find((args) => args[0] === "agent" && args[1] === "send-keys")
        ?.slice(-1),
      ["esc"],
    );
    assert.equal(
      calls.filter((args) => args[0] === "agent" && args[1] === "get").length,
      4,
    );
    assert.equal(
      calls.some((args) => args[0] === "tab" && args[1] === "close"),
      false,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the Herdr launch can wait for native session identity without submitting a prompt", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-herdr-readiness-"));
  const log = join(parent, "commands.jsonl");
  const command = join(parent, "fake-herdr-readiness.mjs");
  const cwd = join(parent, "worktree");
  const sessionFile = join(parent, "worker.jsonl");
  const agentName = herdrAgentName("run", "node", "attempt");
  const resource = {
    workspace_id: "workspace-1",
    tab_id: "workspace-1:tab-1",
    pane_id: "workspace-1:pane-1",
    terminal_id: "terminal-1",
    agent_status: "idle",
    name: agentName,
    cwd,
  };
  const native = { ...resource, agent_session: { value: sessionFile } };
  await writeFile(
    command,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "tab") console.log(JSON.stringify({result:{root_pane:{pane_id:"workspace-1:pane-1"}}}));
else if (args[0] === "agent" && args[1] === "start") console.log(JSON.stringify({result:{agent:${JSON.stringify(resource)}}}));
else if (args[0] === "agent" && args[1] === "get") console.log(JSON.stringify({result:{agent:${JSON.stringify(native)}}}));
else console.log(JSON.stringify({result:{accepted:true}}));
`,
  );
  await chmod(command, 0o755);
  try {
    const runtime = new HerdrCliRuntime(command, {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "workspace-1",
    });
    let retainedResource: WorkerResourceIdentity | undefined;
    let retainedIdentity: WorkerIdentity | undefined;
    const observation = await runtime.launch({
      workspaceId: "workspace-1",
      runId: "run",
      nodeId: "node",
      attemptId: "attempt",
      cwd,
      sessionFile,
      env: {},
      onResource(resourceValue) {
        retainedResource = resourceValue;
      },
      onIdentity(identity) {
        retainedIdentity = identity;
      },
    });
    assert.deepEqual(retainedResource, {
      workspaceId: "workspace-1",
      tabId: "workspace-1:tab-1",
      paneId: "workspace-1:pane-1",
      terminalId: "terminal-1",
      agentName,
      cwd,
    });
    assert.deepEqual(retainedIdentity, observation.identity);
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const promptIndex = calls.findIndex(
      (args) => args[0] === "agent" && args[1] === "prompt",
    );
    const getIndex = calls.findIndex(
      (args) => args[0] === "agent" && args[1] === "get",
    );
    assert.equal(promptIndex, -1);
    assert.ok(getIndex >= 0);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the Herdr launch retains a blocked resource without submitting an assignment", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-herdr-blocked-"));
  const log = join(parent, "commands.jsonl");
  const command = join(parent, "fake-herdr-blocked.mjs");
  const cwd = join(parent, "worktree");
  const sessionFile = join(parent, "worker.jsonl");
  const agentName = herdrAgentName("run", "node", "attempt");
  const agent = {
    workspace_id: "workspace-1",
    tab_id: "workspace-1:tab-1",
    pane_id: "workspace-1:pane-1",
    terminal_id: "terminal-1",
    agent_status: "blocked",
    name: agentName,
    cwd,
  };
  await writeFile(
    command,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "tab") console.log(JSON.stringify({result:{root_pane:{pane_id:"workspace-1:pane-1"}}}));
else if (args[0] === "agent" && (args[1] === "start" || args[1] === "get")) console.log(JSON.stringify({result:{agent:${JSON.stringify(agent)}}}));
else console.log(JSON.stringify({result:{accepted:true}}));
`,
  );
  await chmod(command, 0o755);
  try {
    const runtime = new HerdrCliRuntime(command, {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "workspace-1",
    });
    let retainedResource: WorkerResourceIdentity | undefined;
    await assert.rejects(
      () =>
        runtime.launch({
          workspaceId: "workspace-1",
          runId: "run",
          nodeId: "node",
          attemptId: "attempt",
          cwd,
          sessionFile,
          prompt: "Do not submit.",
          env: {},
          onResource(resource) {
            retainedResource = resource;
          },
        }),
      /operator action is required/,
    );
    assert.deepEqual(retainedResource, {
      workspaceId: "workspace-1",
      tabId: "workspace-1:tab-1",
      paneId: "workspace-1:pane-1",
      terminalId: "terminal-1",
      agentName,
      cwd,
    });
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.some((args) => args[0] === "agent" && args[1] === "prompt"),
      false,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
