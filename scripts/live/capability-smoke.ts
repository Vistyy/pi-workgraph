import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This exact Node, Pi, or live smoke boundary preserves its native callback and payload contract; validation remains in the boundary body.
import { readdir, readFile, writeFile } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This exact Node, Pi, or live smoke boundary preserves its native callback and payload contract; validation remains in the boundary body.
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Config, ConfigProvider, Effect } from "effect";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { loadModelPolicy } from "../../src/model-policy.js";
import { hasNativeAgentSettled } from "../../src/pi-process.js";
import { type WorkstreamState, WorkstreamStore } from "../../src/workstream.js";
import {
  closeOwnedWorkspace,
  command,
  createFixtureCheckpoint,
  createLiveFixture,
  finalizeSuccessfulFixture,
  herdr,
  type LiveFixture,
  liveCoordinatorModel,
  observeNativeSessionUsage,
  retainFailure,
  startCoordinator,
  waitFor,
} from "./harness.js";
import {
  CAPABILITY_SCENARIO_IDS,
  capabilityScenarioPrompt,
  notificationDrivenProgress,
} from "./scenario-observation.js";

const smokeTimeout = Effect.runSync(
  Config.number("PI_WORKGRAPH_SMOKE_TIMEOUT_MS")
    .pipe(Config.withDefault(1_800_000))
    .parse(ConfigProvider.fromEnvRecord(process.env)),
);

const checkpoint = createFixtureCheckpoint("Workgraph capability scenario");
let fixture: LiveFixture | undefined;
let latest: WorkstreamState | undefined;
try {
  fixture = await createLiveFixture("Workgraph capability scenario", checkpoint);
  const f = fixture;
  const policy = await loadModelPolicy(join(f.agentDir, "workgraph", "models.json"));
  const launchPlan = {
    coordinatorModel: liveCoordinatorModel,
    expectedAttempts: Object.keys(CAPABILITY_SCENARIO_IDS).length,
    selectedWorkerModels: policy.roles,
  };
  await writeFile(join(f.parent, "launch-plan.json"), JSON.stringify(launchPlan, null, 2));
  process.stderr.write(`Capability scenario launch plan: ${JSON.stringify(launchPlan)}\n`);
  const coordinator = await startCoordinator(f);
  const privateToken = "PRIVATE_COORDINATOR_VIOLET";
  const prompt = capabilityScenarioPrompt(privateToken);
  await writeFile(join(f.parent, "initial-request.txt"), prompt);
  await herdr(f.root, Type.Object({}), "agent", "prompt", coordinator.agentName, prompt);
  const timeoutMs = smokeTimeout;
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0);
  const state = await waitFor(
    // oxlint-disable-next-line effecttsgo/async-function -- This exact Node, Pi, or live smoke boundary preserves its native callback and payload contract; validation remains in the boundary body.
    async () => {
      const directory = join(f.root, ".git", "pi-workgraph", "workstreams");
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
      assert.equal(names.length, 1, "Scenario must stay in one workstream");
      const workstreamName = names[0];
      assert.ok(workstreamName !== undefined);
      latest = await WorkstreamStore.inspect(join(directory, workstreamName, "workstream.json"));
      if (latest.attempts.length > launchPlan.expectedAttempts)
        throw new Error(
          `Fixed scenario exceeded ${launchPlan.expectedAttempts} expected attempts; no automatic retries are authorized.`,
        );
      const blocked = latest.attempts.find(
        (attempt) =>
          attempt.error !== undefined ||
          attempt.cleanup?.state === "blocked" ||
          attempt.application?.state === "blocked",
      );
      if (blocked !== undefined)
        throw new Error(`Attempt requires reconciliation: ${JSON.stringify(blocked)}`);
      if (latest.lifecycle.state !== "active" && latest.lifecycle.state !== "completed")
        throw new Error(`Unexpected lifecycle ${latest.lifecycle.state}`);
      const baseline = latest.results.find(
        (result) => result.assignmentId === CAPABILITY_SCENARIO_IDS.baselineResearch,
      );
      if (baseline === undefined && latest.lifecycle.state === "completed")
        throw new Error(
          `Completed state is missing required protocol assignment ${CAPABILITY_SCENARIO_IDS.baselineResearch}; observed assignments: ${latest.assignments.map((assignment) => assignment.id).join(", ")}.`,
        );
      const progressed =
        baseline !== undefined &&
        notificationDrivenProgress(
          SessionManager.open(coordinator.sessionFile).getBranch(),
          latest.results.map((result) => result.id),
          baseline.id,
        );
      // Completion can precede the last queued followUp. Observe its actual
      // message and assistant continuation, without accepting late-only progression.
      return latest.lifecycle.state === "completed" && progressed ? latest : undefined;
    },
    timeoutMs,
    "notification-driven capability flow and actual assistant continuations; inspect retained coordinator session and workstream state",
  );
  await writeFile(join(f.parent, "state-observation.json"), JSON.stringify(state, null, 2));
  assert.deepEqual(
    state.assignments.map((assignment) => assignment.id).sort(),
    Object.values(CAPABILITY_SCENARIO_IDS).sort(),
  );
  assert.equal(state.attempts.length, 5);
  assert.equal(state.results.length, 5);
  assert.ok(
    state.results.every(
      (result) => result.validity === "typed" && result.report.status === "completed",
    ),
  );
  assert.equal(state.deliveries.length, 5);
  assert.ok(state.deliveries.every((delivery) => delivery.state !== "pending"));
  assert.deepEqual(state.completion?.accounting, []);
  for (const attempt of state.attempts) {
    assert.equal(attempt.state, "settled");
    assert.equal(attempt.cleanup?.state, "completed");
    assert.equal(attempt.cleanup?.workerClosed, true);
    assert.ok(attempt.worker !== undefined);
    assert.ok(attempt.sessionFile !== undefined);
    assert.equal(attempt.worker.workspaceId, f.workspaceId);
    const assignment = state.assignments.find((item) => item.id === attempt.assignmentId);
    assert.ok(assignment !== undefined);
    assert.ok(attempt.placement !== undefined);
    const isolated =
      assignment.capability === "implement" ||
      assignment.artifactIntent === "disposable_experiment";
    assert.equal(attempt.placement.kind, isolated ? "isolated_worktree" : "shared_project");
    assert.equal(attempt.worker.cwd, isolated ? attempt.placement.path : f.root);
    assert.ok(hasNativeAgentSettled(attempt.sessionFile, state.id, attempt.id));
    assert.ok(!(await readFile(attempt.sessionFile, "utf8")).includes(privateToken));
  }
  const experiment = state.results.find(
    (result) => result.assignmentId === CAPABILITY_SCENARIO_IDS.uppercaseExperiment,
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
  assert.equal(await command(f.root, "git", ["diff", "--name-only", f.base, "HEAD"]), "value.txt");
  const implementation = state.attempts.find(
    (attempt) => attempt.assignmentId === CAPABILITY_SCENARIO_IDS.updateValue,
  );
  const review = state.attempts.find(
    (attempt) => attempt.assignmentId === CAPABILITY_SCENARIO_IDS.exactRevisionReview,
  );
  const concurrent = state.assignments.find(
    (assignment) => assignment.id === CAPABILITY_SCENARIO_IDS.concurrentReadme,
  );
  assert.ok(implementation !== undefined);
  assert.ok(review !== undefined);
  assert.ok(concurrent !== undefined);
  assert.equal(review.baseRevision, implementation.application?.revision);
  assert.equal(review.baseRevision, await command(f.root, "git", ["rev-parse", "HEAD"]));
  const implementationResult = state.results.find(
    (result) => result.assignmentId === CAPABILITY_SCENARIO_IDS.updateValue,
  );
  assert.ok(implementationResult !== undefined);
  assert.ok(
    concurrent.createdAt < implementationResult.observedAt,
    "Research must be queued before implementation settles",
  );
  for (const role of ["implementation.guide", "implementation.executor"] as const) {
    assert.ok(
      implementation.effectiveModels?.some(
        (model) => model.source === "message" && model.model === policy.roles[role].model,
      ) === true,
      `No actual message observed for ${role}`,
    );
  }
  const implementationSession = implementation.sessionFile;
  assert.ok(implementationSession !== undefined);
  const workerEntries = SessionManager.open(implementationSession).getBranch();
  const workerPhaseSchema = Type.Object({ phase: Type.Literal("executor") });
  assert.ok(
    workerEntries.some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "pi-workgraph-worker-state" &&
        Value.Check(workerPhaseSchema, entry.data),
    ),
  );
  const coordinatorEntries = SessionManager.open(coordinator.sessionFile).getBranch();
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
    (await command(f.root, "git", ["worktree", "list", "--porcelain"])).split("worktree ").length -
      1,
    1,
  );
  const usage = observeNativeSessionUsage([
    coordinator.sessionFile,
    ...state.attempts.flatMap((attempt) =>
      attempt.sessionFile === undefined ? [] : [attempt.sessionFile],
    ),
  ]);
  await writeFile(join(f.parent, "usage.json"), JSON.stringify(usage, null, 2));
  await closeOwnedWorkspace(f, coordinator);
  const cleanup = await finalizeSuccessfulFixture(f);
  await writeFile(
    join(f.parent, "passed.json"),
    JSON.stringify(
      {
        candidateRevision: f.revision,
        implementationRevision: review.baseRevision,
        launchPlan,
        usage,
        cleanup,
        checks:
          "normal package loading, fresh worker isolation, actual notification-driven baseline-to-experiment progression and assistant continuations for every result, experiment retention/non-composition, maintained bytes/scope, model messages and Prewalk transition, concurrent research, review launched against the exact implementation revision, native settlement, resource cleanup, and copied-agent-file cleanup",
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      evidence: f.parent,
      candidateRevision: f.revision,
    })}\n`,
  );
} catch (error) {
  if (fixture && latest)
    await writeFile(
      join(fixture.parent, "state-observation.json"),
      JSON.stringify(latest, null, 2),
    );
  await retainFailure(checkpoint, error instanceof Error ? error : String(error));
}
