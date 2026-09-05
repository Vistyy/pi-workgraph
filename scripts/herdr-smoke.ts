import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitRepository } from "../src/git.js";
import { CoordinatorLaunchError, HerdrCliRuntime } from "../src/herdr.js";
import {
  createWorkerSession,
  forkConversationSession,
} from "../src/pi-process.js";
import {
  closeOwnedWorkspace,
  createLiveFixture,
  herdr,
  items,
  type LiveFixture,
  object,
  retainFailure,
  startCoordinator,
  text,
  waitFor,
} from "./live-fixture.js";

let fixture: LiveFixture | undefined;
try {
  fixture = await createLiveFixture("Workgraph Herdr boundary scenario");
  const f = fixture;
  const coordinator = await startCoordinator(f);
  const runtime = new HerdrCliRuntime(
    process.env.PI_WORKGRAPH_HERDR_BIN || "herdr",
    { ...process.env, PI_CODING_AGENT_DIR: f.agentDir },
  );
  await herdr(f.root, "agent", "rename", coordinator.paneId, "--clear");
  const observed = await runtime.observeCurrentCoordinator({
    paneId: coordinator.paneId,
    sessionFile: coordinator.sessionFile,
    cwd: f.root,
  });
  assert.equal(observed.agentName, undefined);
  assert.equal(
    await runtime.coordinatorLiveness(coordinator.sessionFile),
    "alive",
  );
  const parentTabsBeforeFork = items(
    (await herdr(f.root, "tab", "list", "--workspace", f.workspaceId)).tabs,
  ).map((tab) => text(tab.tab_id));
  const childSessionFile = await forkConversationSession({
    parentSessionFile: coordinator.sessionFile,
    targetCwd: f.root,
  });
  const childCoordinator = await runtime.launchCoordinator({
    cwd: f.root,
    sessionFile: childSessionFile,
  });
  await writeFile(
    join(f.parent, "fork-identity.json"),
    JSON.stringify(childCoordinator, null, 2),
  );
  assert.notEqual(childCoordinator.workspaceId, f.workspaceId);
  assert.equal(
    object(
      (await herdr(f.root, "workspace", "get", childCoordinator.workspaceId))
        .workspace,
    ).focused,
    false,
  );
  const childObserved = await runtime.observeCurrentCoordinator({
    paneId: childCoordinator.paneId,
    sessionFile: childSessionFile,
    cwd: f.root,
  });
  assert.equal(childObserved.workspaceId, childCoordinator.workspaceId);
  assert.equal(childObserved.sessionFile, childSessionFile);
  assert.deepEqual(
    items(
      (await herdr(f.root, "tab", "list", "--workspace", f.workspaceId)).tabs,
    ).map((tab) => text(tab.tab_id)),
    parentTabsBeforeFork,
  );
  await herdr(
    f.root,
    "agent",
    "rename",
    coordinator.paneId,
    coordinator.agentName,
  );
  const repository = await GitRepository.open(f.root);
  const placement = await repository.createWorktree(
    "herdr-smoke",
    "worker",
    f.base,
  );
  const sessionFile = await createWorkerSession({
    runId: "herdr-smoke",
    nodeId: "worker",
    targetCwd: placement.path,
    sessionDir: join(f.parent, "worker-sessions"),
    mode: "research",
    objective:
      "This boundary fixture remains idle. No model prompt will be submitted.",
  });
  const created = await herdr(
    f.root,
    "tab",
    "create",
    "--workspace",
    childCoordinator.workspaceId,
    "--cwd",
    placement.path,
    "--no-focus",
    "--env",
    `PI_CODING_AGENT_DIR=${f.agentDir}`,
    "--env",
    "PI_WORKGRAPH_MODE=research",
    "--env",
    "PI_WORKGRAPH_RUN_ID=herdr-smoke",
    "--env",
    "PI_WORKGRAPH_NODE_ID=worker",
  );
  const paneId = text(object(created.root_pane).pane_id);
  const agentName = `wg-boundary-${Date.now().toString(36)}`;
  const started = object(
    (
      await herdr(
        f.root,
        "agent",
        "start",
        agentName,
        "--kind",
        "pi",
        "--pane",
        paneId,
        "--",
        "--session",
        sessionFile,
      )
    ).agent,
  );
  const worker = {
    workspaceId: childCoordinator.workspaceId,
    tabId: text(started.tab_id),
    paneId,
    terminalId: text(started.terminal_id),
    agentName,
    sessionFile,
    cwd: placement.path,
  };
  await writeFile(
    join(f.parent, "worker-identity.json"),
    JSON.stringify(worker, null, 2),
  );
  await waitFor(
    async () => {
      const agent = object((await herdr(f.root, "agent", "get", paneId)).agent);
      if (agent.agent_status === "blocked")
        throw new Error(
          "Worker requires operator action; no prompt submitted.",
        );
      if (!agent.agent_session) return undefined;
      return runtime.observe(worker);
    },
    30_000,
    "native idle worker identity",
  );
  await assert.rejects(
    runtime.cleanup({ ...worker, cwd: join(f.parent, "different-worktree") }),
    /cwd/,
  );
  const workerCleanup = await runtime.cleanup(worker);
  assert.equal(workerCleanup.state, "completed");
  const gitCleanup = await repository.cleanupWorktree(placement, f.base);
  assert.equal(gitCleanup.state, "completed");
  const childFixture = {
    ...f,
    workspaceId: childCoordinator.workspaceId,
    rootTab: childCoordinator.tabId,
    paneId: childCoordinator.paneId,
  };
  await closeOwnedWorkspace(childFixture, childCoordinator);
  await closeOwnedWorkspace(f, coordinator);
  await writeFile(
    join(f.parent, "passed.json"),
    JSON.stringify(
      {
        candidateRevision: f.revision,
        modelPrompts: 0,
        observed,
        childObserved,
        childCoordinator,
        workerCleanup,
        gitCleanup,
        checks:
          "native parent and fork identity, distinct unfocused workspace, parent preservation, child tab-scoped worker, identity-mismatch refusal, exact Herdr closure before Git removal and verified workspace absence",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      status: "passed",
      evidence: f.parent,
      candidateRevision: f.revision,
    }),
  );
} catch (error) {
  if (fixture && error instanceof CoordinatorLaunchError && error.resource)
    await writeFile(
      join(fixture.parent, "fork-resource-retained.json"),
      JSON.stringify(error.resource, null, 2),
    );
  await retainFailure(fixture, error);
}
