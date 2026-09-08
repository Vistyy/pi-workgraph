import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Herdr tests exercise real native fixture state at the node:test boundary.
import { existsSync } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Herdr tests exercise real native fixture state at the node:test boundary.
import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Fixture paths are exact native Herdr resource identities.
import { join } from "node:path";
import test from "node:test";
import { Deferred, Effect } from "effect";
import {
  CoordinatorLaunchError,
  HERDR_PROTOCOL_OUTPUT_LIMIT,
  HerdrCliRuntime,
  HerdrProtocolError,
  herdrCoordinatorNames,
  herdrWorkerName,
  herdrWorkerTabLabel,
  WorkerLaunchError,
  WorkerLaunchPlacementError,
} from "../src/herdr.js";
import type { WorkerIdentity, WorkerResourceIdentity } from "../src/types.js";

const runEffect = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

await test("worker tabs use concise task text while native names remain unique and role-specific", () => {
  const request = {
    runId: "RUN/with spaces and symbols",
    nodeId: "attempt-one",
    attemptId: "attempt-one",
    assignmentId: "meaningful-agent-names",
    objective: "Implement parser support for accented input and a very long trailing explanation",
    role: "implement" as const,
  };
  const first = herdrWorkerName(request);
  const second = herdrWorkerName({ ...request, attemptId: "attempt-two" });
  const label = herdrWorkerTabLabel(request);
  assert.match(first, /implement/);
  assert.notEqual(first, herdrWorkerName({ ...request, role: "research" }));
  assert.match(first, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.match(label, /meaningful/i);
  assert.ok(label.length <= 18);
  assert.doesNotMatch(label, /implement|[a-f0-9]{6}/i);
  assert.equal(herdrWorkerTabLabel({ ...request, attemptId: "attempt-two" }), label);
  assert.notEqual(first, second);
  const fallback = herdrWorkerTabLabel({
    ...request,
    assignmentId: "assignment-123456789abcdef0",
    objective: "Implement parser support",
  });
  assert.match(fallback, /implement/i);
  assert.ok(fallback.length <= 18);
  const semanticId = herdrWorkerTabLabel({
    ...request,
    assignmentId: "tool-design",
    objective: "Implement the tool design",
  });
  assert.match(semanticId, /tool/i);
  assert.ok(semanticId.length <= 18);
});

await test("coordinator fork names use repository context without exposing paths", () => {
  const names = herdrCoordinatorNames({
    cwd: "/private/Customer Work/repo-name",
    sessionFile: "/private/session.jsonl",
  });
  assert.match(names.agentName, /repo-name/);
  assert.match(names.agentName, /coordinator/);
  assert.match(names.agentName, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.match(names.label, /repo name/);
  assert.match(names.label, /coordinator/);
  assert.equal(names.label.includes("Customer"), false);
  assert.equal(names.label.includes("/"), false);
});

await test("Herdr identity validation rejects missing and mismatched native session or cwd", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-herdr-identity-"));
  const responsePath = join(parent, "agent.json");
  const command = join(parent, "fake-herdr-identity.mjs");
  const identity: WorkerIdentity = {
    workspaceId: "workspace-1",
    tabId: "workspace-1:tab-1",
    paneId: "workspace-1:pane-1",
    terminalId: "terminal-1",
    agentName: herdrWorkerName({ runId: "run", nodeId: "node", attemptId: "attempt" }),
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
    // SAFETY: The fixture line is JSON.parse output and the surrounding test validates its command-record shape.
    const missingSession = structuredClone(valid) as Partial<typeof valid>;
    delete missingSession.agent_session;
    await writeFile(responsePath, JSON.stringify(missingSession));
    await assert.rejects(() => runEffect(runtime.effects.observe(identity)), /agent_session/);

    // SAFETY: The fixture line is JSON.parse output and the surrounding test validates its command-record shape.
    const missingCwd = structuredClone(valid) as Partial<typeof valid>;
    delete missingCwd.cwd;
    await writeFile(responsePath, JSON.stringify(missingCwd));
    await assert.rejects(() => runEffect(runtime.effects.observe(identity)), /cwd/);

    await writeFile(
      responsePath,
      JSON.stringify({
        ...valid,
        agent_session: { value: join(parent, "other.jsonl") },
      }),
    );
    await assert.rejects(
      () => runEffect(runtime.effects.observe(identity)),
      /native Pi session changed/,
    );

    await writeFile(
      responsePath,
      JSON.stringify({ ...valid, cwd: join(parent, "other-worktree") }),
    );
    await assert.rejects(() => runEffect(runtime.effects.observe(identity)), /worker cwd changed/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

await test("current-session coordinator observation accepts an unnamed detected Pi pane without weakening worker identity", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-herdr-coordinator-"));
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
    const coordinator = await runEffect(
      runtime.effects.observeCurrentCoordinator({
        paneId: agent.pane_id,
        sessionFile,
        cwd,
      }),
    );
    assert.equal(coordinator.agentName, undefined);
    assert.equal(coordinator.sessionFile, sessionFile);
    await assert.rejects(
      () =>
        runEffect(runtime.effects.observe({ ...coordinator, agentName: "required-worker-name" })),
      /omitted string name/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

await test("exact worker recover succeeds despite unrelated unnamed snapshot entry", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-herdr-recover-"));
  const responsePath = join(parent, "snapshot.json");
  const command = join(parent, "fake-herdr-recover.mjs");
  const identity: WorkerIdentity = {
    workspaceId: "workspace-1",
    tabId: "workspace-1:tab-1",
    paneId: "workspace-1:pane-1",
    terminalId: "terminal-1",
    agentName: "owned-worker",
    sessionFile: join(parent, "worker.jsonl"),
    cwd: join(parent, "worktree"),
  };
  const exactWorker = {
    workspace_id: identity.workspaceId,
    tab_id: identity.tabId,
    pane_id: identity.paneId,
    terminal_id: identity.terminalId,
    agent_status: "working",
    name: identity.agentName,
    cwd: identity.cwd,
    agent_session: { value: identity.sessionFile },
  };
  const unrelatedUnnamed = {
    workspace_id: "wW4",
    tab_id: "wW4:t1",
    pane_id: "wW4:p1",
    terminal_id: "unrelated-terminal",
    agent_status: "idle",
    cwd: parent,
  };
  await writeFile(
    command,
    `#!/usr/bin/env node\nimport { readFileSync } from "node:fs";\nconst agents = JSON.parse(readFileSync(${JSON.stringify(responsePath)}, "utf8"));\nconsole.log(JSON.stringify({result:{snapshot:{agents}}}));\n`,
  );
  await chmod(command, 0o755);
  const runtime = new HerdrCliRuntime(command, {
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: identity.workspaceId,
  });
  const request = {
    workspaceId: identity.workspaceId,
    agentName: identity.agentName,
    sessionFile: identity.sessionFile,
    cwd: identity.cwd,
  };
  try {
    await writeFile(responsePath, JSON.stringify([unrelatedUnnamed, exactWorker]));
    const recovered = await runEffect(runtime.effects.recover(request));
    assert.deepEqual(recovered?.identity, identity);
    assert.equal(recovered?.status, "working");

    await writeFile(
      responsePath,
      JSON.stringify([unrelatedUnnamed, { ...exactWorker, name: "foreign-worker" }]),
    );
    assert.equal(await runEffect(runtime.effects.recover(request)), undefined);

    await writeFile(responsePath, JSON.stringify([]));
    assert.equal(
      await runEffect(runtime.effects.recover({ ...request, resource: identity })),
      undefined,
    );

    // SAFETY: This mutable partial fixture intentionally removes native session evidence.
    const noNativeIdentity = structuredClone(exactWorker) as Partial<typeof exactWorker>;
    delete noNativeIdentity.agent_session;
    await writeFile(responsePath, JSON.stringify([unrelatedUnnamed, noNativeIdentity]));
    await assert.rejects(
      () => runEffect(runtime.effects.recover({ ...request, resource: identity })),
      /still has no native Pi session identity/,
    );

    // SAFETY: This intentionally incomplete protocol fixture verifies that a matching worker is not converted without exact identity fields.
    const malformedWorker = structuredClone(exactWorker) as Partial<typeof exactWorker>;
    delete malformedWorker.terminal_id;
    await writeFile(responsePath, JSON.stringify([unrelatedUnnamed, malformedWorker]));
    await assert.rejects(
      () => runEffect(runtime.effects.recover(request)),
      /snapshot response omitted valid agents/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

await test("coordinator forks into a new unfocused workspace with isolated Pi identity", async () => {
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
    const identity = await runEffect(runtime.effects.launchCoordinator({ cwd, sessionFile }));
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
    // SAFETY: Each fixture process writes only JSON-encoded string argument arrays to this private log.
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const create = calls.find((args) => args[0] === "workspace" && args[1] === "create");
    assert.ok(create, "workspace creation command was recorded");
    assert.equal(create.includes("--workspace"), false);
    assert.equal(create.includes("--no-focus"), true);
    assert.ok(create.includes(`PI_CODING_AGENT_DIR=${join(parent, "private-agent")}`));
    for (const key of [
      "PI_WORKGRAPH_MODE",
      "PI_WORKGRAPH_RUN_ID",
      "PI_WORKGRAPH_NODE_ID",
      "PI_WORKGRAPH_BASE_COMMIT",
      "PI_WORKGRAPH_EXECUTOR_MODEL",
      "PI_WORKGRAPH_EXECUTOR_THINKING",
    ])
      assert.ok(create.includes(`${key}=`));
    const start = calls.find((args) => args[0] === "agent" && args[1] === "start");
    assert.ok(start, "agent start command was recorded");
    assert.deepEqual(start.slice(0, 3), ["agent", "start", identity.agentName]);
    const separator = start.indexOf("--");
    assert.ok(separator > 2);
    const options = start.slice(3, separator);
    assert.ok(options.includes("--kind"));
    assert.ok(options.includes("--pane"));
    assert.equal(options[options.indexOf("--kind") + 1], "pi");
    assert.equal(options[options.indexOf("--pane") + 1], identity.paneId);
    assert.deepEqual(start.slice(separator + 1), ["--session", sessionFile]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

await test("uncertain coordinator startup retains the exact created workspace handles", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-herdr-fork-failure-"));
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
      () => runEffect(runtime.effects.launchCoordinator({ cwd, sessionFile })),
      (error) => {
        assert.ok(error instanceof CoordinatorLaunchError);
        const resource = error.resource;
        assert.ok(resource !== undefined);
        assert.deepEqual(resource, {
          workspaceId: "child-workspace",
          tabId: "child-workspace:tab-1",
          paneId: "child-workspace:pane-1",
          agentName: resource.agentName,
          terminalId: "child-terminal",
          sessionFile,
          cwd,
        });
        assert.match(String(error), /Inspect these exact handles before retrying/);
        return true;
      },
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

await test("cleanup rejects mismatched cwd, verifies exact tab absence and tolerates already completed closure", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-herdr-deleted-cleanup-"));
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
    `#!/usr/bin/env node\nimport { existsSync, writeFileSync } from "node:fs";\nconst args=process.argv.slice(2);\nconst closed=${JSON.stringify(closed)};\nif(args[0]==="agent"&&args[1]==="get"){if(existsSync(closed)){console.error(JSON.stringify({error:{code:"pane_not_found",message:"gone"}}));process.exit(1)}console.log(JSON.stringify({result:{agent:${JSON.stringify(agent)}}}))}\nelse if(args[0]==="tab"&&args[1]==="close"){writeFileSync(closed,args[2]);console.log(JSON.stringify({result:{type:"ok"}}))}\nelse if(args[0]==="tab"&&args[1]==="get"&&existsSync(closed)){console.error(JSON.stringify({error:{code:"tab_not_found",message:"gone"}}));process.exit(1)}\nelse console.log(JSON.stringify({result:{tab:{tab_id:${JSON.stringify(identity.tabId)}}}}));\n`,
  );
  await chmod(command, 0o755);
  try {
    const runtime = new HerdrCliRuntime(command, {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: identity.workspaceId,
    });
    await assert.rejects(
      () => runEffect(runtime.effects.cleanup({ ...identity, cwd: `${cwd}-different` })),
      /worker cwd changed/,
    );
    assert.equal(existsSync(closed), false, "identity refusal must not close any tab");
    const result = await runEffect(runtime.effects.cleanup(identity));
    assert.equal(result.state, "completed");
    assert.equal(await readFile(closed, "utf8"), identity.tabId);
    assert.equal((await runEffect(runtime.effects.cleanup(identity))).state, "completed");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

await test("Herdr launch submits one non-waiting prompt and cleanup preserves a working tab", async () => {
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
    const observation = await runEffect(
      runtime.effects.launch({
        workspaceId: "workspace-1",
        ...naming,
        cwd,
        sessionFile,
        prompt: "Continue now.",
        env: { PI_WORKGRAPH_MODE: "implementation" },
        onIdentity: (identity) =>
          Effect.sync(() => {
            retained = identity;
          }).pipe(Effect.asVoid),
      }),
    );
    assert.deepEqual(retained, observation.identity);
    assert.equal(observation.identity.workspaceId, "workspace-1");
    assert.equal(observation.identity.paneId, "workspace-1:pane-1");
    assert.equal(observation.identity.sessionFile, sessionFile);
    const pendingCleanup = await runEffect(runtime.effects.cleanup(observation.identity));
    assert.equal(pendingCleanup.state, "pending");
    // SAFETY: Each fixture process writes only JSON-encoded string argument arrays to this private log.
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const prompts = calls.filter((args) => args[0] === "agent" && args[1] === "prompt");
    assert.deepEqual(prompts, [["agent", "prompt", agentName, "Continue now."]]);
    assert.equal(
      calls.some((args) => args[0] === "tab" && args[1] === "close"),
      false,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

await test("the Herdr launch can wait for native session identity without submitting a prompt", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-herdr-readiness-"));
  const log = join(parent, "commands.jsonl");
  const command = join(parent, "fake-herdr-readiness.mjs");
  const cwd = join(parent, "worktree");
  const sessionFile = join(parent, "worker.jsonl");
  const agentName = herdrWorkerName({ runId: "run", nodeId: "node", attemptId: "attempt" });
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
    const observation = await runEffect(
      runtime.effects.launch({
        workspaceId: "workspace-1",
        runId: "run",
        nodeId: "node",
        attemptId: "attempt",
        cwd,
        sessionFile,
        env: {},
        onResource: (resourceValue) =>
          Effect.sync(() => {
            retainedResource = resourceValue;
          }).pipe(Effect.asVoid),
        onIdentity: (identity) =>
          Effect.sync(() => {
            retainedIdentity = identity;
          }).pipe(Effect.asVoid),
      }),
    );
    assert.deepEqual(retainedResource, {
      workspaceId: "workspace-1",
      tabId: "workspace-1:tab-1",
      paneId: "workspace-1:pane-1",
      terminalId: "terminal-1",
      agentName,
      cwd,
    });
    assert.deepEqual(retainedIdentity, observation.identity);
    // SAFETY: Each fixture process writes only JSON-encoded string argument arrays to this private log.
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const promptIndex = calls.findIndex((args) => args[0] === "agent" && args[1] === "prompt");
    const getIndex = calls.findIndex((args) => args[0] === "agent" && args[1] === "get");
    assert.equal(promptIndex, -1);
    assert.ok(getIndex >= 0);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

await test("the Herdr launch retains a blocked resource without submitting an assignment", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-herdr-blocked-"));
  const log = join(parent, "commands.jsonl");
  const command = join(parent, "fake-herdr-blocked.mjs");
  const cwd = join(parent, "worktree");
  const sessionFile = join(parent, "worker.jsonl");
  const agentName = herdrWorkerName({ runId: "run", nodeId: "node", attemptId: "attempt" });
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
        runEffect(
          runtime.effects.launch({
            workspaceId: "workspace-1",
            runId: "run",
            nodeId: "node",
            attemptId: "attempt",
            cwd,
            sessionFile,
            prompt: "Do not submit.",
            env: {},
            onResource: (resource) =>
              Effect.sync(() => {
                retainedResource = resource;
              }).pipe(Effect.asVoid),
          }),
        ),
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
    // SAFETY: Each fixture process writes only JSON-encoded string argument arrays to this private log.
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

await test("read-only startup inspection distinguishes exact live, absent, and mismatched retained panes", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-herdr-startup-inspection-"));
  const command = join(parent, "fake-herdr-startup.mjs");
  const modePath = join(parent, "mode");
  const cwd = join(parent, "worktree");
  const sessionFile = join(parent, "worker.jsonl");
  const request = {
    workspaceId: "workspace-1",
    tabId: "workspace-1:tab-1",
    paneId: "workspace-1:pane-1",
    terminalId: "terminal-1",
    sessionFile,
    cwd,
  };
  const agentName = herdrWorkerName({ runId: "run", nodeId: "node", attemptId: "attempt" });
  const pane = {
    workspace_id: request.workspaceId,
    tab_id: request.tabId,
    pane_id: request.paneId,
    terminal_id: request.terminalId,
    cwd: request.cwd,
  };
  const agent = {
    ...pane,
    agent_status: "working",
    name: agentName,
    agent_session: { value: sessionFile },
  };
  await writeFile(
    command,
    `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const mode = readFileSync(${JSON.stringify(modePath)}, "utf8");
if (mode === "absent") { console.error(JSON.stringify({error:{code:"pane_not_found",message:"gone"}})); process.exit(1); }
if (mode === "agent-absent" && args[0] === "agent") { console.error(JSON.stringify({error:{code:"agent_not_found",message:"gone"}})); process.exit(1); }
if (mode === "process-unknown" && args[0] === "pane" && args[1] === "process-info") { console.error(JSON.stringify({error:{code:"inspection_failed",message:"unknown"}})); process.exit(1); }
if (args[0] === "pane" && args[1] === "get") console.log(JSON.stringify({result:{pane:${JSON.stringify(pane)}}}));
else if (args[0] === "pane" && args[1] === "process-info") console.log(JSON.stringify({result:{shell_pid:10,foreground_process_group_id:11,foreground_processes:["fish","atuin"]}}));
else if (args[0] === "agent" && args[1] === "get") console.log(JSON.stringify({result:{agent:${JSON.stringify(agent)}}}));
else console.log(JSON.stringify({result:{accepted:true}}));
`,
  );
  await chmod(command, 0o755);
  try {
    const runtime = new HerdrCliRuntime(command, {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: request.workspaceId,
    });
    await writeFile(modePath, "live");
    const live = await runEffect(runtime.effects.inspectLaunch(request));
    assert.equal(live.state, "live");
    if (live.state === "live") {
      assert.equal(live.identity.agentName, agentName);
      assert.equal(live.evidence.process.state, "observed");
    }
    const launchPaneOnly = await runEffect(
      runtime.effects.inspectLaunch({
        workspaceId: request.workspaceId,
        paneId: request.paneId,
        sessionFile: request.sessionFile,
        cwd: request.cwd,
      }),
    );
    assert.equal(launchPaneOnly.state, "live");
    if (launchPaneOnly.state === "live") {
      assert.equal(launchPaneOnly.identity.tabId, request.tabId);
      assert.equal(launchPaneOnly.identity.terminalId, request.terminalId);
    }
    await writeFile(modePath, "process-unknown");
    const liveWithoutProcessEvidence = await runEffect(runtime.effects.inspectLaunch(request));
    assert.equal(liveWithoutProcessEvidence.state, "live");
    assert.equal(liveWithoutProcessEvidence.evidence.process.state, "unknown");
    await writeFile(modePath, "agent-absent");
    const paneWithoutAgent = await runEffect(runtime.effects.inspectLaunch(request));
    assert.equal(paneWithoutAgent.state, "unknown");
    assert.equal(paneWithoutAgent.evidence.process.state, "observed");
    assert.equal(paneWithoutAgent.evidence.agent.state, "absent");
    assert.match(paneWithoutAgent.detail, /no relaunch or cleanup is authorized/);
    await writeFile(modePath, "absent");
    const absent = await runEffect(runtime.effects.inspectLaunch(request));
    assert.equal(absent.state, "absent");
    assert.match(absent.detail, /pane .* absent/);
    await writeFile(modePath, "live");
    const mismatch = await runEffect(
      runtime.effects.inspectLaunch({ ...request, cwd: `${cwd}-expected` }),
    );
    assert.equal(mismatch.state, "unknown");
    assert.match(mismatch.detail, /does not match/);
    assert.match(JSON.stringify(mismatch.evidence), /workspace-1/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

await test("bounded protocol output fails before a valid truncated JSON suffix can imply absence", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-herdr-protocol-bound-"));
  const command = join(parent, "fake-herdr-bound.mjs");
  const mode = join(parent, "mode");
  const cwd = join(parent, "worktree");
  const identity: WorkerIdentity = {
    workspaceId: "workspace-1",
    tabId: "workspace-1:tab-1",
    paneId: "workspace-1:pane-1",
    terminalId: "terminal-1",
    agentName: "owned-worker",
    sessionFile: join(parent, "worker.jsonl"),
    cwd,
  };
  await writeFile(
    command,
    `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const mode = readFileSync(${JSON.stringify(mode)}, "utf8");
if (mode === "overflow") {
  process.stdout.write(" ".repeat(${HERDR_PROTOCOL_OUTPUT_LIMIT + 128}) + JSON.stringify({error:{code:"pane_not_found",message:"gone"}}));
  process.exitCode = 1;
} else if (mode === "stderr-overflow") {
  process.stderr.write(" ".repeat(${HERDR_PROTOCOL_OUTPUT_LIMIT + 128}) + JSON.stringify({error:{code:"pane_not_found",message:"gone"}}));
  process.exitCode = 1;
} else {
  process.stdout.write("{malformed");
}
`,
  );
  await chmod(command, 0o755);
  const runtime = new HerdrCliRuntime(command, {
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: identity.workspaceId,
  });
  try {
    await writeFile(mode, "overflow");
    await assert.rejects(
      () => Effect.runPromise(runtime.effects.inspect(identity)),
      (error) => {
        assert.ok(error instanceof HerdrProtocolError);
        assert.equal(error.reason, "overflow");
        assert.match(error.message, /no truncated stdout or stderr was decoded/);
        return true;
      },
    );

    await writeFile(mode, "stderr-overflow");
    await assert.rejects(
      () => Effect.runPromise(runtime.effects.inspect(identity)),
      (error) => {
        assert.ok(error instanceof HerdrProtocolError);
        assert.equal(error.reason, "overflow");
        assert.match(error.message, /no truncated stdout or stderr was decoded/);
        return true;
      },
    );

    await writeFile(mode, "malformed");
    await assert.rejects(
      () => Effect.runPromise(runtime.effects.observe(identity)),
      (error) => {
        assert.ok(error instanceof HerdrProtocolError);
        assert.equal(error.reason, "malformed");
        return true;
      },
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

await test("cancelling Effect-native readiness terminates its owned native child", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-herdr-cancel-readiness-"));
  const command = join(parent, "fake-herdr-cancel.mjs");
  const getStarted = join(parent, "get-started");
  const terminated = join(parent, "terminated");
  const cwd = join(parent, "worktree");
  const sessionFile = join(parent, "worker.jsonl");
  const agentName = herdrWorkerName({ runId: "run", nodeId: "node", attemptId: "attempt" });
  const resource = {
    workspace_id: "workspace-1",
    tab_id: "workspace-1:tab-1",
    pane_id: "workspace-1:pane-1",
    terminal_id: "terminal-1",
    agent_status: "idle",
    name: agentName,
    cwd,
  };
  await writeFile(
    command,
    `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "tab") console.log(JSON.stringify({result:{root_pane:{pane_id:"workspace-1:pane-1"}}}));
else if (args[0] === "agent" && args[1] === "start") console.log(JSON.stringify({result:{agent:${JSON.stringify(resource)}}}));
else if (args[0] === "agent" && args[1] === "get") {
  writeFileSync(${JSON.stringify(getStarted)}, "started");
  process.on("SIGTERM", () => { appendFileSync(${JSON.stringify(terminated)}, "terminated"); process.exit(0); });
  setInterval(() => {}, 1000);
}
`,
  );
  await chmod(command, 0o755);
  const runtime = new HerdrCliRuntime(command, {
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: resource.workspace_id,
  });
  const controller = new AbortController();
  const callbacks: string[] = [];
  try {
    const running = Effect.runPromise(
      runtime.effects.launch({
        workspaceId: resource.workspace_id,
        runId: "run",
        nodeId: "node",
        attemptId: "attempt",
        cwd,
        sessionFile,
        env: {},
        onTab: () => Effect.sync(() => callbacks.push("tab")).pipe(Effect.asVoid),
        onResource: () => Effect.sync(() => callbacks.push("resource")).pipe(Effect.asVoid),
        onIdentity: () => Effect.sync(() => callbacks.push("identity")).pipe(Effect.asVoid),
        onSubmitted: () => Effect.sync(() => callbacks.push("submitted")).pipe(Effect.asVoid),
      }),
      { signal: controller.signal },
    );
    await waitForPath(getStarted);
    controller.abort();
    await assert.rejects(running);
    assert.equal(await readFile(terminated, "utf8"), "terminated");
    assert.deepEqual(callbacks, ["tab", "resource"]);
  } finally {
    controller.abort();
    await rm(parent, { recursive: true, force: true });
  }
});

await test("launch rejects conflicting returned placement without adopting or prompting it", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-herdr-placement-"));
  const command = join(parent, "fake-herdr-placement.mjs");
  const log = join(parent, "commands.jsonl");
  const cwd = join(parent, "worktree");
  const foreign = {
    workspace_id: "foreign-workspace",
    tab_id: "foreign-workspace:tab-9",
    pane_id: "foreign-workspace:pane-9",
    terminal_id: "foreign-terminal",
    agent_status: "idle",
    name: herdrWorkerName({ runId: "run", nodeId: "node", attemptId: "attempt" }),
    cwd: join(parent, "foreign-worktree"),
  };
  await writeFile(
    command,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "tab") console.log(JSON.stringify({result:{root_pane:{pane_id:"workspace-1:pane-1"}}}));
else if (args[0] === "agent" && args[1] === "start") console.log(JSON.stringify({result:{agent:${JSON.stringify(foreign)}}}));
else console.log(JSON.stringify({result:{accepted:true}}));
`,
  );
  await chmod(command, 0o755);
  const runtime = new HerdrCliRuntime(command, {
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: "workspace-1",
  });
  let adopted = false;
  try {
    await assert.rejects(
      () =>
        runEffect(
          runtime.effects.launch({
            workspaceId: "workspace-1",
            runId: "run",
            nodeId: "node",
            attemptId: "attempt",
            cwd,
            sessionFile: join(parent, "worker.jsonl"),
            prompt: "must not be sent",
            env: {},
            onResource: () =>
              Effect.sync(() => {
                adopted = true;
              }).pipe(Effect.asVoid),
          }),
        ),
      (error) => {
        assert.ok(error instanceof HerdrProtocolError);
        assert.equal(error.reason, "identity");
        assert.ok(error.cause instanceof WorkerLaunchPlacementError);
        assert.equal(error.cause.expected.workspaceId, "workspace-1");
        assert.equal(error.cause.expected.paneId, "workspace-1:pane-1");
        assert.equal(error.cause.observed.workspaceId, "foreign-workspace");
        assert.equal(error.cause.observed.paneId, "foreign-workspace:pane-9");
        assert.match(error.message, /not adopted or cleaned up/);
        return true;
      },
    );
    assert.equal(adopted, false);
    const calls = await commandLog(log);
    assert.equal(
      calls.some((args) => args[0] === "agent" && args[1] === "get"),
      false,
    );
    assert.equal(
      calls.some((args) => args[0] === "agent" && args[1] === "prompt"),
      false,
    );
    assert.equal(
      calls.some((args) => args[0] === "tab" && args[1] === "close"),
      false,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

await test("onTab failure reports the exact created pane and prevents agent start", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-herdr-tab-checkpoint-"));
  const command = join(parent, "fake-herdr-tab-checkpoint.mjs");
  const log = join(parent, "commands.jsonl");
  await writeFile(
    command,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
console.log(JSON.stringify({result:{root_pane:{pane_id:"workspace-1:pane-created"}}}));
`,
  );
  await chmod(command, 0o755);
  const runtime = new HerdrCliRuntime(command, {
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: "workspace-1",
  });
  try {
    await assert.rejects(
      () =>
        runEffect(
          runtime.effects.launch({
            workspaceId: "workspace-1",
            runId: "run",
            nodeId: "node",
            attemptId: "attempt",
            cwd: parent,
            sessionFile: join(parent, "worker.jsonl"),
            env: {},
            onTab: () =>
              Effect.fail(
                new HerdrProtocolError({
                  operation: "fixture onTab",
                  reason: "process",
                  detail: "durable pane write failed",
                }),
              ),
          }),
        ),
      (error) => {
        assert.ok(error instanceof WorkerLaunchError);
        assert.equal(error.phase, "onTab");
        assert.deepEqual(error.locator, {
          workspaceId: "workspace-1",
          paneId: "workspace-1:pane-created",
        });
        assert.equal(error.resource, undefined);
        assert.ok(error.cause instanceof Error);
        assert.match(error.cause.message, /durable pane write failed/);
        return true;
      },
    );
    const calls = await commandLog(log);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.slice(0, 2), ["tab", "create"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

await test("cancellation waits for every Effect checkpoint and starts no later operation", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-herdr-checkpoint-cancel-"));
  const command = join(parent, "fake-herdr-checkpoints.mjs");
  const log = join(parent, "commands.jsonl");
  const durable = join(parent, "durable.jsonl");
  const cwd = join(parent, "worktree");
  const sessionFile = join(parent, "worker.jsonl");
  const agentName = herdrWorkerName({ runId: "run", nodeId: "node", attemptId: "attempt" });
  const agent = {
    workspace_id: "workspace-1",
    tab_id: "workspace-1:tab-1",
    pane_id: "workspace-1:pane-1",
    terminal_id: "terminal-1",
    agent_status: "idle",
    name: agentName,
    cwd,
    agent_session: { value: sessionFile },
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
  const runtime = new HerdrCliRuntime(command, {
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: "workspace-1",
  });
  const phases = ["onTab", "onResource", "onIdentity", "onSubmitted"] as const;
  try {
    for (const phase of phases) {
      await writeFile(log, "");
      await writeFile(durable, "");
      const entered = await Effect.runPromise(Deferred.make<void>());
      const release = await Effect.runPromise(Deferred.make<void>());
      const reached: string[] = [];
      const checkpoint = (name: (typeof phases)[number]) =>
        name === phase
          ? Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              yield* Effect.tryPromise(() => appendFile(durable, `${name}:settled\\n`));
              reached.push(name);
            })
          : Effect.sync(() => {
              reached.push(name);
            });
      const controller = new AbortController();
      const running = Effect.runPromise(
        runtime.effects.launch({
          workspaceId: "workspace-1",
          runId: "run",
          nodeId: "node",
          attemptId: "attempt",
          cwd,
          sessionFile,
          prompt: "Continue.",
          env: {},
          onTab: () => checkpoint("onTab"),
          onResource: () => checkpoint("onResource"),
          onIdentity: () => checkpoint("onIdentity"),
          onSubmitted: () => checkpoint("onSubmitted"),
        }),
        { signal: controller.signal },
      );
      await Effect.runPromise(Deferred.await(entered));
      controller.abort();
      const premature = await Promise.race([
        running.then(
          () => "settled",
          () => "settled",
        ),
        Effect.runPromise(Effect.sleep(25)).then(() => "pending"),
      ]);
      assert.equal(premature, "pending", `${phase} must finish before cancellation returns`);
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await assert.rejects(running);
      assert.equal(await readFile(durable, "utf8"), `${phase}:settled\\n`);
      assert.equal(reached.includes(phase), true);
      const calls = await commandLog(log);
      if (phase === "onTab")
        assert.equal(
          calls.some((args) => args[0] === "agent" && args[1] === "start"),
          false,
        );
      if (phase === "onResource")
        assert.equal(
          calls.some((args) => args[0] === "agent" && args[1] === "get"),
          false,
        );
      if (phase === "onIdentity")
        assert.equal(
          calls.some((args) => args[0] === "agent" && args[1] === "prompt"),
          false,
        );
      if (phase === "onSubmitted")
        assert.equal(calls.filter((args) => args[0] === "agent" && args[1] === "prompt").length, 1);
      const callCount = calls.length;
      await Effect.runPromise(Effect.sleep(25));
      assert.equal((await commandLog(log)).length, callCount, `${phase} launched detached work`);
      assert.equal(await readFile(durable, "utf8"), `${phase}:settled\\n`);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

async function commandLog(path: string): Promise<string[][]> {
  const text = await readFile(path, "utf8");
  if (!text.trim()) return [];
  // SAFETY: The fixture child writes one JSON-encoded string argument array per line.
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await Effect.runPromise(Effect.sleep(10));
  }
  throw new Error(`Timed out waiting for ${path}.`);
}
