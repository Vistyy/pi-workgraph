import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { hasNativeAgentSettled } from "../src/pi-process.js";
import { type WorkstreamState, WorkstreamStore } from "../src/workstream.js";
import {
  CAPABILITY_SCENARIO_IDS,
  capabilityScenarioPrompt,
  notificationDrivenProgress,
} from "./coordinator-observation.js";
import {
  closeOwnedWorkspace,
  command,
  createLiveFixture,
  herdr,
  type LiveFixture,
  retainFailure,
  startCoordinator,
  waitFor,
} from "./live-fixture.js";

let fixture: LiveFixture | undefined;
let latest: WorkstreamState | undefined;
try {
  fixture = await createLiveFixture("Workgraph capability scenario");
  const f = fixture;
  const coordinator = await startCoordinator(f);
  const privateToken = "PRIVATE_COORDINATOR_VIOLET";
  const prompt = capabilityScenarioPrompt(privateToken);
  await writeFile(join(f.parent, "initial-request.txt"), prompt);
  await herdr(f.root, "agent", "prompt", coordinator.agentName, prompt);
  const timeoutMs = Number(
    process.env.PI_WORKGRAPH_SMOKE_TIMEOUT_MS || 1_800_000,
  );
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0);
  const state = await waitFor(
    async () => {
      const directory = join(f.root, ".git", "pi-workgraph", "workstreams");
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return undefined;
        throw error;
      }
      assert.equal(names.length, 1, "Scenario must stay in one workstream");
      latest = await WorkstreamStore.inspect(
        join(directory, names[0]!, "workstream.json"),
      );
      const blocked = latest.attempts.find(
        (attempt) =>
          attempt.error ||
          attempt.cleanup?.state === "blocked" ||
          attempt.composition?.state === "blocked",
      );
      if (blocked)
        throw new Error(
          `Attempt requires reconciliation: ${JSON.stringify(blocked)}`,
        );
      if (
        latest.lifecycle.state !== "active" &&
        latest.lifecycle.state !== "completed"
      )
        throw new Error(`Unexpected lifecycle ${latest.lifecycle.state}`);
      const baseline = latest.results.find(
        (result) =>
          result.assignmentId === CAPABILITY_SCENARIO_IDS.baselineResearch,
      );
      if (!baseline && latest.lifecycle.state === "completed")
        throw new Error(
          `Completed state is missing required protocol assignment ${CAPABILITY_SCENARIO_IDS.baselineResearch}; observed assignments: ${latest.assignments.map((assignment) => assignment.id).join(", ")}.`,
        );
      const progressed =
        baseline &&
        notificationDrivenProgress(
          SessionManager.open(coordinator.sessionFile).getBranch(),
          latest.results.map((result) => result.id),
          baseline.id,
        );
      // Completion can precede the last queued followUp. Observe its actual
      // message and assistant continuation, without accepting late-only progression.
      return latest.lifecycle.state === "completed" && progressed
        ? latest
        : undefined;
    },
    timeoutMs,
    "notification-driven capability flow and actual assistant continuations; inspect retained coordinator session and workstream state",
  );
  await writeFile(
    join(f.parent, "state-observation.json"),
    JSON.stringify(state, null, 2),
  );
  assert.deepEqual(
    state.assignments.map((assignment) => assignment.id).sort(),
    Object.values(CAPABILITY_SCENARIO_IDS).sort(),
  );
  assert.equal(state.attempts.length, 5);
  assert.equal(state.results.length, 5);
  assert.ok(
    state.results.every(
      (result) =>
        result.validity === "typed" && result.report.status === "completed",
    ),
  );
  assert.equal(state.deliveries.length, 5);
  assert.ok(state.deliveries.every((delivery) => delivery.state !== "pending"));
  assert.deepEqual(state.completion?.accounting, []);
  for (const attempt of state.attempts) {
    assert.equal(attempt.state, "settled");
    assert.equal(attempt.cleanup?.state, "completed");
    assert.equal(attempt.cleanup?.workerClosed, true);
    assert.ok(attempt.worker && attempt.sessionFile);
    assert.equal(attempt.worker.workspaceId, f.workspaceId);
    const assignment = state.assignments.find(
      (item) => item.id === attempt.assignmentId,
    );
    assert.ok(assignment);
    assert.ok(attempt.placement);
    const isolated =
      assignment.capability === "implement" ||
      assignment.artifactIntent === "disposable_experiment";
    assert.equal(
      attempt.placement.kind,
      isolated ? "isolated_worktree" : "shared_project",
    );
    assert.equal(
      attempt.worker.cwd,
      isolated ? attempt.placement.path : f.root,
    );
    assert.ok(hasNativeAgentSettled(attempt.sessionFile, state.id, attempt.id));
    assert.ok(
      !(await readFile(attempt.sessionFile, "utf8")).includes(privateToken),
    );
  }
  const experiment = state.results.find(
    (result) =>
      result.assignmentId === CAPABILITY_SCENARIO_IDS.uppercaseExperiment,
  );
  const artifact = experiment?.artifacts.find(
    (item) => item.id === "probe.txt" && item.retention === "retained",
  );
  assert.ok(artifact);
  assert.equal(await readFile(artifact.reference, "utf8"), "BEFORE\n");
  await assert.rejects(readFile(join(f.root, "probe.txt")), /ENOENT/);
  assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "after\n");
  assert.equal(await command(f.root, "node", ["verify.mjs"]), "value verified");
  assert.equal(await command(f.root, "git", ["status", "--porcelain"]), "");
  assert.equal(
    await command(f.root, "git", ["diff", "--name-only", f.base, "HEAD"]),
    "value.txt",
  );
  const implementation = state.attempts.find(
    (attempt) => attempt.assignmentId === CAPABILITY_SCENARIO_IDS.updateValue,
  );
  const review = state.attempts.find(
    (attempt) =>
      attempt.assignmentId === CAPABILITY_SCENARIO_IDS.exactRevisionReview,
  );
  const concurrent = state.assignments.find(
    (assignment) => assignment.id === CAPABILITY_SCENARIO_IDS.concurrentReadme,
  );
  assert.ok(implementation && review && concurrent);
  assert.equal(review.baseRevision, implementation.composition?.revision);
  assert.equal(
    review.baseRevision,
    await command(f.root, "git", ["rev-parse", "HEAD"]),
  );
  const implementationResult = state.results.find(
    (result) => result.assignmentId === CAPABILITY_SCENARIO_IDS.updateValue,
  );
  assert.ok(
    implementationResult &&
      concurrent.createdAt < implementationResult.observedAt,
    "Research must be queued before implementation settles",
  );
  for (const role of [
    "implementation.guide",
    "implementation.executor",
  ] as const) {
    assert.ok(
      implementation.effectiveModels?.some(
        (model) =>
          model.source === "message" &&
          model.model === f.policy.roles[role].model,
      ),
      `No actual message observed for ${role}`,
    );
  }
  const workerEntries = SessionManager.open(
    implementation.sessionFile!,
  ).getBranch();
  assert.ok(
    workerEntries.some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "pi-workgraph-worker-state" &&
        entry.data !== null &&
        typeof entry.data === "object" &&
        "phase" in entry.data &&
        entry.data.phase === "executor",
    ),
  );
  const coordinatorEntries = SessionManager.open(
    coordinator.sessionFile,
  ).getBranch();
  assert.ok(
    !coordinatorEntries.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        [
          "workgraph_begin",
          "workgraph_status",
          "workgraph_result",
          "workgraph_acknowledge",
          "workgraph_disposition",
        ].includes(entry.message.toolName),
    ),
  );
  assert.equal(
    (await command(f.root, "git", ["worktree", "list", "--porcelain"])).split(
      "worktree ",
    ).length - 1,
    1,
  );
  await closeOwnedWorkspace(f, coordinator);
  await writeFile(
    join(f.parent, "passed.json"),
    JSON.stringify(
      {
        candidateRevision: f.revision,
        fixtureRevision: review.baseRevision,
        checks:
          "normal package loading, fresh worker isolation, actual notification-driven baseline-to-experiment progression and assistant continuations for every result, experiment retention/non-composition, maintained bytes/scope, model messages and Prewalk transition, concurrent research, exact revision review, native settlement and exact cleanup",
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
  if (fixture && latest)
    await writeFile(
      join(fixture.parent, "state-observation.json"),
      JSON.stringify(latest, null, 2),
    );
  await retainFailure(fixture, error);
}
