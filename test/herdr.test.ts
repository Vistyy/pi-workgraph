import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HerdrCliRuntime, herdrAgentName } from "../src/herdr.js";
import type { WorkerIdentity, WorkerResourceIdentity } from "../src/types.js";

test("Herdr agent names satisfy the authoritative boundary and distinguish attempts", () => {
  const first = herdrAgentName(
    "RUN/with spaces and symbols",
    "123-VERY-LONG-NODE-NAME-with_symbols",
    "attempt-one",
  );
  const second = herdrAgentName(
    "RUN/with spaces and symbols",
    "123-VERY-LONG-NODE-NAME-with_symbols",
    "attempt-two",
  );
  assert.match(first, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.match(second, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.notEqual(first, second);
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
  const agentName = herdrAgentName("run", "node", "attempt");
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
      runId: "run",
      nodeId: "node",
      attemptId: "attempt",
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
      agentName: observation.identity.agentName,
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

test("the Herdr launch waits for native session identity before submitting work", async () => {
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
      prompt: "Submit only after readiness.",
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
    assert.ok(getIndex >= 0 && getIndex < promptIndex);
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
