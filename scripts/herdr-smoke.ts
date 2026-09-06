import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This exact Node, Pi, or live smoke boundary preserves its native callback and payload contract; validation remains in the boundary body.
import { writeFile } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This exact Node, Pi, or live smoke boundary preserves its native callback and payload contract; validation remains in the boundary body.
import { join } from "node:path";
import { Config, ConfigProvider, Effect } from "effect";
import { Type } from "typebox";
import { GitRepository } from "../src/git.js";
import {
  CoordinatorLaunchError,
  HerdrCliRuntime,
  herdrCoordinatorNames,
  herdrWorkerTabLabel,
} from "../src/herdr.js";
import { createWorkerSession, forkConversationSession } from "../src/pi-process.js";
import {
  closeOwnedWorkspace,
  createLiveFixture,
  herdr,
  type LiveFixture,
  retainFailure,
  startCoordinator,
  waitFor,
} from "./live-fixture.js";

const hostEnvironment = process.env;
const herdrBin = Effect.runSync(
  Config.string("PI_WORKGRAPH_HERDR_BIN")
    .pipe(Config.withDefault("herdr"))
    .parse(ConfigProvider.fromEnvRecord(hostEnvironment)),
);
const tabsSchema = Type.Object({
  tabs: Type.Array(Type.Object({ tab_id: Type.String(), label: Type.String() })),
});

let fixture: LiveFixture | undefined;
try {
  fixture = await createLiveFixture("Workgraph Herdr boundary scenario");
  const f = fixture;
  const coordinator = await startCoordinator(f);
  const runtime = new HerdrCliRuntime(herdrBin, {
    ...hostEnvironment,
    PI_CODING_AGENT_DIR: f.agentDir,
  });
  await herdr(f.root, Type.Object({}), "agent", "rename", coordinator.paneId, "--clear");
  const observed = await runtime.observeCurrentCoordinator({
    paneId: coordinator.paneId,
    sessionFile: coordinator.sessionFile,
    cwd: f.root,
  });
  assert.equal(observed.agentName, undefined);
  assert.equal(await runtime.coordinatorLiveness(coordinator.sessionFile), "alive");
  const parentTabsBeforeFork = (
    await herdr(f.root, tabsSchema, "tab", "list", "--workspace", f.workspaceId)
  ).tabs.map((tab) => tab.tab_id);
  const childSessionFile = await forkConversationSession({
    parentSessionFile: coordinator.sessionFile,
    targetCwd: f.root,
  });
  const childCoordinator = await runtime.launchCoordinator({
    cwd: f.root,
    sessionFile: childSessionFile,
  });
  await writeFile(join(f.parent, "fork-identity.json"), JSON.stringify(childCoordinator, null, 2));
  assert.notEqual(childCoordinator.workspaceId, f.workspaceId);
  const childWorkspace = (
    await herdr(
      f.root,
      Type.Object({
        workspace: Type.Object({ focused: Type.Boolean(), label: Type.String() }),
      }),
      "workspace",
      "get",
      childCoordinator.workspaceId,
    )
  ).workspace;
  assert.equal(childWorkspace.focused, false);
  assert.equal(
    childWorkspace.label,
    herdrCoordinatorNames({
      cwd: f.root,
      sessionFile: childSessionFile,
    }).label,
  );
  const childObserved = await runtime.observeCurrentCoordinator({
    paneId: childCoordinator.paneId,
    sessionFile: childSessionFile,
    cwd: f.root,
  });
  assert.equal(childObserved.workspaceId, childCoordinator.workspaceId);
  assert.equal(childObserved.sessionFile, childSessionFile);
  assert.deepEqual(
    (await herdr(f.root, tabsSchema, "tab", "list", "--workspace", f.workspaceId)).tabs.map(
      (tab) => tab.tab_id,
    ),
    parentTabsBeforeFork,
  );
  await herdr(
    f.root,
    Type.Object({}),
    "agent",
    "rename",
    coordinator.paneId,
    coordinator.agentName,
  );
  const repository = await GitRepository.open(f.root);
  const placement = await repository.createWorktree("herdr-smoke", "worker", f.base);
  const sessionFile = await createWorkerSession({
    runId: "herdr-smoke",
    nodeId: "worker",
    targetCwd: placement.path,
    sessionDir: join(f.parent, "worker-sessions"),
    mode: "research",
    objective: "This boundary fixture remains idle. No model prompt will be submitted.",
  });
  const workerNaming = {
    runId: "herdr-smoke",
    nodeId: "worker",
    attemptId: "worker",
    assignmentId: "meaningful-agent-names",
    objective: "This boundary fixture remains idle. No model prompt will be submitted",
    role: "research" as const,
  };
  const workerObservation = await runtime.launch({
    workspaceId: childCoordinator.workspaceId,
    ...workerNaming,
    cwd: placement.path,
    sessionFile,
    env: {
      PI_CODING_AGENT_DIR: f.agentDir,
      PI_WORKGRAPH_MODE: "research",
      PI_WORKGRAPH_RUN_ID: workerNaming.runId,
      PI_WORKGRAPH_NODE_ID: workerNaming.nodeId,
    },
  });
  const worker = await waitFor(
    () =>
      runtime.observe(workerObservation.identity).then((current) => {
        if (current.status === "blocked")
          throw new Error("Worker requires operator action; no prompt submitted.");
        return ["idle", "done"].includes(current.status) ? current.identity : undefined;
      }),
    30_000,
    "native idle worker identity",
  );
  const workerTab = (
    await herdr(f.root, tabsSchema, "tab", "list", "--workspace", worker.workspaceId)
  ).tabs.find((tab) => tab.tab_id === worker.tabId);
  assert.ok(workerTab !== undefined, "Production launch tab is present in native list");
  assert.equal(workerTab.label, herdrWorkerTabLabel(workerNaming));
  await writeFile(join(f.parent, "worker-identity.json"), JSON.stringify(worker, null, 2));
  assert.equal(workerObservation.identity.sessionFile, sessionFile);
  assert.notEqual(workerObservation.status, "blocked");
  await assert.rejects(
    runtime.cleanup({ ...worker, cwd: join(f.parent, "different-worktree") }),
    /cwd/,
  );
  const workerCleanup = await runtime.cleanup(worker);
  assert.equal(workerCleanup.state, "completed");
  assert.equal(workerCleanup.identity.tabId, worker.tabId);
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
        childWorkspaceLabel: childWorkspace.label,
        worker,
        workerTabLabel: workerTab.label,
        workerCleanup,
        gitCleanup,
        checks:
          "native parent and fork identity, meaningful native fork and worker labels, production runtime.launch without a model prompt, child tab-scoped worker, identity-mismatch refusal, exact Herdr closure before Git removal and verified workspace absence",
      },
      null,
      2,
    ),
  );
  // oxlint-disable-next-line effecttsgo/global-console -- This exact Node, Pi, or live smoke boundary preserves its native callback and payload contract; validation remains in the boundary body.
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
