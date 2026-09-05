import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitRepository } from "../src/git.js";
import { HerdrCliRuntime } from "../src/herdr.js";
import { createWorkerSession } from "../src/pi-process.js";
import {
  closeOwnedWorkspace,
  createLiveFixture,
  herdr,
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
  const runtime = new HerdrCliRuntime();
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
    f.workspaceId,
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
    workspaceId: f.workspaceId,
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
  await closeOwnedWorkspace(f, coordinator);
  await writeFile(
    join(f.parent, "passed.json"),
    JSON.stringify(
      {
        candidateRevision: f.revision,
        modelPrompts: 0,
        observed,
        workerCleanup,
        gitCleanup,
        checks:
          "native identity, unnamed coordinator lookup, identity-mismatch refusal, exact Herdr closure before Git removal and verified workspace absence",
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
  await retainFailure(fixture, error);
}
