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
import { liveLayer } from "../../src/node-platform.js";
import { hasNativeAgentSettled } from "../../src/pi-process.js";
import { type WorkstreamState, WorkstreamStoreEffects } from "../../src/workstream.js";
import {
  canonicalWorkstreamPath,
  closeOwnedWorkspace,
  command,
  createAuthorizedDestinationDrift,
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
  observeIsolatedGitResourceAbsence,
} from "./scenario-observation.js";

const smokeTimeout = Effect.runSync(
  Config.number("PI_WORKGRAPH_SMOKE_TIMEOUT_MS")
    .pipe(Config.withDefault(1_800_000))
    .parse(ConfigProvider.fromEnvRecord(process.env)),
);

const checkpoint = createFixtureCheckpoint("Workgraph capability scenario");
const retainedOutputReleaseReason =
  "The harness recorded the exact BEFORE newline bytes and no longer needs this disposable output.";
let fixture: LiveFixture | undefined;
let latest: WorkstreamState | undefined;
let driftPromise: Promise<{ path: string; revision: string } | undefined> | undefined;
let driftFailure: Error | undefined;
const driftAbort = new AbortController();

function sleepForDrift(signal: AbortSignal): Promise<void> {
  return Effect.runPromise(Effect.sleep("100 millis"), { signal });
}

// oxlint-disable-next-line effecttsgo/async-function -- This exact native smoke boundary observes the model-driven state before creating the one authorized disposable destination commit.
async function singleWorkstreamName(directory: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (names.length === 0) return undefined;
  if (names.length > 1) throw new Error("Scenario must stay in one workstream");
  return names[0];
}

// oxlint-disable-next-line effecttsgo/async-function -- This exact native smoke boundary observes the one persisted workstream without using a coordinator polling tool.
async function inspectSingleWorkstream(f: LiveFixture): Promise<WorkstreamState | undefined> {
  const directory = join(f.root, ".git", "pi-workgraph", "workstreams");
  const workstreamName = await singleWorkstreamName(directory);
  if (workstreamName === undefined) return undefined;
  return Effect.runPromise(
    Effect.provide(
      WorkstreamStoreEffects.inspect(canonicalWorkstreamPath(f.root, workstreamName)),
      liveLayer,
    ),
  );
}

// oxlint-disable-next-line effecttsgo/async-function -- This exact native smoke boundary waits for the coordinator's retained turn before submitting its next fixture event.
async function waitForCoordinatorIdle(
  f: LiveFixture,
  coordinator: { paneId: string; terminalId: string; cwd: string; sessionFile: string },
  timeoutMs: number,
  description: string,
): Promise<void> {
  const agentSchema = Type.Object({
    agent: Type.Object({
      agent_session: Type.Object({ value: Type.String() }),
      terminal_id: Type.String(),
      cwd: Type.String(),
      agent_status: Type.String(),
    }),
  });
  await waitFor(
    () =>
      herdr(f.root, agentSchema, "agent", "get", coordinator.paneId).then((result) => {
        assert.equal(result.agent.agent_session.value, coordinator.sessionFile);
        assert.equal(result.agent.terminal_id, coordinator.terminalId);
        assert.equal(result.agent.cwd, coordinator.cwd);
        return ["idle", "done"].includes(result.agent.agent_status) ? true : undefined;
      }),
    Math.min(timeoutMs, 120_000),
    description,
  );
}

function changedImplementationCommit(state: WorkstreamState, assignmentId: string): string {
  const result = state.results.find((item) => item.assignmentId === assignmentId);
  if (
    result?.validity !== "typed" ||
    result.report.kind !== "implementation" ||
    result.report.status !== "completed" ||
    result.report.outcome !== "changed" ||
    result.report.commit === undefined
  )
    throw new Error(`Missing changed implementation result for ${assignmentId}`);
  return result.report.commit;
}

// oxlint-disable-next-line effecttsgo/async-function -- This exact native smoke boundary observes the model-driven state before creating the one authorized disposable destination commit.
async function waitForCorrectionAndCreateDrift(
  f: LiveFixture,
  correctionAssignmentId: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ path: string; revision: string }> {
  const directory = join(f.root, ".git", "pi-workgraph", "workstreams");
  const polls = Math.max(1, Math.ceil(timeoutMs / 100));
  for (let poll = 0; poll < polls; poll += 1) {
    if (signal.aborted) throw new Error("Destination drift observation was interrupted.");
    const workstreamName = await singleWorkstreamName(directory);
    if (workstreamName === undefined) {
      await sleepForDrift(signal);
      continue;
    }
    const observed = await Effect.runPromise(
      Effect.provide(
        WorkstreamStoreEffects.inspect(canonicalWorkstreamPath(f.root, workstreamName)),
        liveLayer,
      ),
    );
    const correction = observed.attempts.find(
      (attempt) => attempt.assignmentId === correctionAssignmentId,
    );
    if (correction?.application?.state === "applied") {
      assert.equal(correction.application.expectedHead, f.base);
      assert.ok(correction.application.revision !== undefined);
      assert.equal(
        await command(f.root, "git", ["rev-parse", "HEAD"]),
        correction.application.revision,
      );
      return createAuthorizedDestinationDrift(f);
    }
    await sleepForDrift(signal);
  }
  throw new Error(
    `Timed out waiting for correction ${correctionAssignmentId} application before creating fixture drift.`,
  );
}

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
  driftPromise = waitForCorrectionAndCreateDrift(
    f,
    CAPABILITY_SCENARIO_IDS.correctionCandidate,
    timeoutMs,
    driftAbort.signal,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native background failure is normalized before the smoke boundary observes it.
  ).catch((error: unknown) => {
    driftFailure = error instanceof Error ? error : new Error(String(error));
    return undefined;
  });
  await waitFor(
    // oxlint-disable-next-line effecttsgo/async-function -- This exact Node, Pi, or live smoke boundary preserves its native callback and payload contract; validation remains in the boundary body.
    async () => {
      const observed = await inspectSingleWorkstream(f);
      if (observed === undefined) return undefined;
      latest = observed;
      if (observed.attempts.length > launchPlan.expectedAttempts)
        throw new Error(
          `Fixed scenario exceeded ${launchPlan.expectedAttempts} expected attempts; no automatic retries are authorized.`,
        );
      if (observed.lifecycle.state !== "active")
        throw new Error(
          `Expected the scenario to remain active before the harness drift event, found ${observed.lifecycle.state}`,
        );
      const initial = observed.attempts.find(
        (attempt) => attempt.assignmentId === CAPABILITY_SCENARIO_IDS.updateValue,
      );
      const correction = observed.attempts.find(
        (attempt) => attempt.assignmentId === CAPABILITY_SCENARIO_IDS.correctionCandidate,
      );
      const review = observed.attempts.find(
        (attempt) => attempt.assignmentId === CAPABILITY_SCENARIO_IDS.exactRevisionReview,
      );
      const baseline = observed.results.find(
        (result) => result.assignmentId === CAPABILITY_SCENARIO_IDS.baselineResearch,
      );
      const progressed =
        baseline !== undefined &&
        notificationDrivenProgress(
          SessionManager.open(coordinator.sessionFile).getBranch(),
          observed.results.map((result) => result.id),
          baseline.id,
        );
      const completeChainApplied =
        correction?.application?.state === "applied" &&
        correction.application.expectedHead === f.base &&
        correction.application.commits?.length === 2;
      return completeChainApplied &&
        review?.cleanup?.state === "completed" &&
        initial?.application === undefined &&
        progressed
        ? observed
        : undefined;
    },
    timeoutMs,
    "notification-driven capability flow through complete-chain correction application before the harness drift event",
  );
  assert.ok(driftPromise !== undefined);
  const drift = await driftPromise;
  if (drift === undefined)
    throw driftFailure ?? new Error("Destination drift was not created after correction apply.");
  await waitForCoordinatorIdle(
    f,
    coordinator,
    timeoutMs,
    "coordinator settlement before the harness drift-refusal continuation",
  );
  const driftRefusalPrompt = `The fixture harness has now completed its one authorized destination drift event. Do not create or modify drift.txt. Its exact path is ${drift.path} and its exact destination HEAD is ${drift.revision}. Continue the retained-candidate scenario now with exactly one next decision: inspect the retained initial-candidate attempt and apply it through workgraph_control with its exact reported sourceCommit and freshly observed destinationHead ${drift.revision}. The application must refuse without changing the moved destination and remain durably blocked. Do not queue integration in this turn, do not retry the blocked application, and do not delegate any other assignment; end after the refusal is recorded so the next continuation can handle integration.`;
  await writeFile(join(f.parent, "drift-refusal-request.txt"), driftRefusalPrompt);
  await herdr(
    f.root,
    Type.Object({}),
    "agent",
    "prompt",
    coordinator.agentName,
    driftRefusalPrompt,
  );
  const refusedState = await waitFor(
    // oxlint-disable-next-line effecttsgo/async-function -- This exact Node, Pi, or live smoke boundary preserves its native callback and payload contract; validation remains in the boundary body.
    async () => {
      const observed = await inspectSingleWorkstream(f);
      if (observed === undefined) return undefined;
      latest = observed;
      if (observed.attempts.length > launchPlan.expectedAttempts)
        throw new Error(
          `Fixed scenario exceeded ${launchPlan.expectedAttempts} expected attempts; no automatic retries are authorized.`,
        );
      const initial = observed.attempts.find(
        (attempt) => attempt.assignmentId === CAPABILITY_SCENARIO_IDS.updateValue,
      );
      return initial?.application?.state === "blocked" ? observed : undefined;
    },
    timeoutMs,
    "model-driven destination-drift refusal for the retained initial candidate",
  );
  const initialAttempt = refusedState.attempts.find(
    (attempt) => attempt.assignmentId === CAPABILITY_SCENARIO_IDS.updateValue,
  );
  assert.ok(initialAttempt !== undefined);
  const existingIntegration = refusedState.attempts.find(
    (attempt) => attempt.assignmentId === CAPABILITY_SCENARIO_IDS.integrationCandidate,
  );
  if (existingIntegration?.application?.state !== "applied") {
    await waitForCoordinatorIdle(
      f,
      coordinator,
      timeoutMs,
      "coordinator settlement before the moved-base integration continuation",
    );
    const integrationPrompt = `The retained initial candidate application is now durably blocked because destination HEAD moved to exact revision ${drift.revision}; do not retry it. Continue the same scenario without creating any other assignment. If moved-integration is not already queued, invoke workgraph_implement with id ${CAPABILITY_SCENARIO_IDS.integrationCandidate}, candidateOf set to the exact retained initial attempt ${initialAttempt.id}, and baseRevision set to exact current destination ${drift.revision}. Its isolated worker must preserve candidate.txt and value.txt=after followed by one newline, create integration.txt=INTEGRATED followed by one newline, and report one clean direct current-base commit. After that result settles, explicitly apply moved-integration with its exact reported sourceCommit and freshly observed destinationHead; leave the workstream active because the initial refusal remains a deliberate blocker. Do not retry the blocked initial candidate or delegate any other assignment.`;
    await writeFile(join(f.parent, "integration-request.txt"), integrationPrompt);
    await herdr(
      f.root,
      Type.Object({}),
      "agent",
      "prompt",
      coordinator.agentName,
      integrationPrompt,
    );
  }
  const state = await waitFor(
    // oxlint-disable-next-line effecttsgo/async-function -- This exact Node, Pi, or live smoke boundary preserves its native callback and payload contract; validation remains in the boundary body.
    async () => {
      const observed = await inspectSingleWorkstream(f);
      if (observed === undefined) return undefined;
      latest = observed;
      if (observed.attempts.length > launchPlan.expectedAttempts)
        throw new Error(
          `Fixed scenario exceeded ${launchPlan.expectedAttempts} expected attempts; no automatic retries are authorized.`,
        );
      if (observed.lifecycle.state !== "active")
        throw new Error(
          `Expected the scenario to remain active with its preserved drift blocker, found ${observed.lifecycle.state}`,
        );
      const driftAttempt = observed.attempts.find(
        (attempt) => attempt.assignmentId === CAPABILITY_SCENARIO_IDS.updateValue,
      );
      const unexpected = observed.attempts.find(
        (attempt) =>
          attempt.assignmentId !== CAPABILITY_SCENARIO_IDS.updateValue &&
          (attempt.error !== undefined ||
            attempt.cleanup?.state === "blocked" ||
            attempt.application?.state === "blocked"),
      );
      if (unexpected !== undefined)
        throw new Error(`Attempt requires reconciliation: ${JSON.stringify(unexpected)}`);
      const correction = observed.attempts.find(
        (attempt) => attempt.assignmentId === CAPABILITY_SCENARIO_IDS.correctionCandidate,
      );
      const integration = observed.attempts.find(
        (attempt) => attempt.assignmentId === CAPABILITY_SCENARIO_IDS.integrationCandidate,
      );
      const completeChainApplied =
        correction?.application?.state === "applied" &&
        correction.application.expectedHead === f.base &&
        correction.application.commits?.length === 2;
      const driftRefused = driftAttempt?.application?.state === "blocked";
      const integrationApplied = integration?.application?.state === "applied";
      const nonRetainedOutputsReleased =
        correction?.outputRelease?.state === "completed" &&
        integration?.outputRelease?.state === "completed";
      const allAttemptsClosed =
        observed.attempts.length === launchPlan.expectedAttempts &&
        observed.attempts.every(
          (attempt) => attempt.state === "settled" && attempt.cleanup?.state === "completed",
        );
      const baseline = observed.results.find(
        (result) => result.assignmentId === CAPABILITY_SCENARIO_IDS.baselineResearch,
      );
      const progressed =
        baseline !== undefined &&
        notificationDrivenProgress(
          SessionManager.open(coordinator.sessionFile).getBranch(),
          observed.results.map((result) => result.id),
          baseline.id,
        );
      // The preserved blocked attempt intentionally prevents semantic completion.
      return completeChainApplied &&
        driftRefused &&
        integrationApplied &&
        nonRetainedOutputsReleased &&
        allAttemptsClosed &&
        progressed
        ? observed
        : undefined;
    },
    timeoutMs,
    "notification-driven capability flow and actual assistant continuations; inspect retained coordinator session and workstream state",
  );
  await writeFile(join(f.parent, "state-observation.json"), JSON.stringify(state, null, 2));
  assert.deepEqual(
    state.assignments.map((assignment) => assignment.id).sort(),
    Object.values(CAPABILITY_SCENARIO_IDS).sort(),
  );
  assert.equal(state.attempts.length, 7);
  assert.equal(state.results.length, 7);
  assert.ok(
    state.results.every(
      (result) => result.validity === "typed" && result.report.status === "completed",
    ),
  );
  assert.equal(state.deliveries.length, 7);
  assert.ok(state.deliveries.every((delivery) => delivery.state !== "pending"));
  assert.equal(state.completion, undefined);
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
      assignment.artifactIntent === "disposable_experiment" ||
      (assignment.capability === "review" && assignment.subject.kind === "revision");
    assert.equal(attempt.placement.kind, isolated ? "isolated_worktree" : "shared_project");
    assert.equal(attempt.worker.cwd, isolated ? attempt.placement.path : f.root);
    assert.ok(hasNativeAgentSettled(attempt.sessionFile, state.id, attempt.id));
    assert.ok(!(await readFile(attempt.sessionFile, "utf8")).includes(privateToken));
  }
  const experiment = state.results.find(
    (result) => result.assignmentId === CAPABILITY_SCENARIO_IDS.uppercaseExperiment,
  );
  const artifact = experiment?.artifacts.find(
    (item) =>
      item.id === "retained-output-worktree" &&
      item.kind === "path" &&
      item.retention === "retained",
  );
  assert.ok(artifact);
  const experimentAttempt = state.attempts.find(
    (attempt) => attempt.assignmentId === CAPABILITY_SCENARIO_IDS.uppercaseExperiment,
  );
  assert.ok(experimentAttempt !== undefined);
  const experimentPlacement = experimentAttempt.placement;
  assert.ok(experimentPlacement?.kind === "isolated_worktree");
  assert.equal(artifact.reference, experimentPlacement.path);
  const retainedProbe = join(experimentPlacement.path, "probe.txt");
  assert.deepEqual(await readFile(retainedProbe), Buffer.from("BEFORE\n"));
  const retainedWorktreeHead = await command(experimentPlacement.path, "git", [
    "rev-parse",
    "HEAD",
  ]);
  await writeFile(
    join(f.parent, "retained-output-before-release.json"),
    JSON.stringify(
      {
        candidateRevision: f.revision,
        workstreamId: state.id,
        attemptId: experimentAttempt.id,
        worktree: experimentPlacement.path,
        branch: experimentPlacement.branch,
        probePath: retainedProbe,
        probeBytes: "BEFORE\n",
        release: "not requested; bytes established before final workspace closure",
      },
      null,
      2,
    ),
  );
  await assert.rejects(readFile(join(f.root, "probe.txt")), /ENOENT/);
  const retainedResources = observeIsolatedGitResourceAbsence(
    [experimentPlacement],
    await command(f.root, "git", ["worktree", "list", "--porcelain"]),
    await command(f.root, "git", ["for-each-ref", "--format=%(refname)", "refs/heads"]),
  );
  assert.equal(retainedResources.resources[0]?.worktreeAbsent, false);
  assert.equal(retainedResources.resources[0]?.branchAbsent, false);
  assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "after\n");
  assert.equal(await readFile(join(f.root, "candidate.txt"), "utf8"), "candidate\n");
  assert.equal(await readFile(join(f.root, "drift.txt"), "utf8"), "DRIFT\n");
  assert.equal(await readFile(join(f.root, "integration.txt"), "utf8"), "INTEGRATED\n");
  assert.equal(await command(f.root, "node", ["verify.mjs"]), "value verified");
  assert.equal(await command(f.root, "git", ["status", "--porcelain"]), "");
  assert.equal(
    await command(f.root, "git", ["diff", "--name-only", f.base, "HEAD"]),
    "candidate.txt\ndrift.txt\nintegration.txt\nvalue.txt",
  );
  const initial = state.attempts.find(
    (attempt) => attempt.assignmentId === CAPABILITY_SCENARIO_IDS.updateValue,
  );
  const correction = state.attempts.find(
    (attempt) => attempt.assignmentId === CAPABILITY_SCENARIO_IDS.correctionCandidate,
  );
  const review = state.attempts.find(
    (attempt) => attempt.assignmentId === CAPABILITY_SCENARIO_IDS.exactRevisionReview,
  );
  const integration = state.attempts.find(
    (attempt) => attempt.assignmentId === CAPABILITY_SCENARIO_IDS.integrationCandidate,
  );
  const concurrent = state.assignments.find(
    (assignment) => assignment.id === CAPABILITY_SCENARIO_IDS.concurrentReadme,
  );
  assert.ok(initial !== undefined);
  assert.ok(correction !== undefined);
  assert.ok(review !== undefined);
  assert.ok(integration !== undefined);
  assert.ok(concurrent !== undefined);
  const changedCommit = (assignmentId: string): string =>
    changedImplementationCommit(state, assignmentId);
  const initialCommit = changedCommit(CAPABILITY_SCENARIO_IDS.updateValue);
  const correctionCommit = changedCommit(CAPABILITY_SCENARIO_IDS.correctionCandidate);
  const integrationCommit = changedCommit(CAPABILITY_SCENARIO_IDS.integrationCandidate);
  assert.deepEqual(initial.candidate, { kind: "initial", rootCommit: f.base });
  assert.deepEqual(correction.candidate, {
    kind: "correction",
    rootCommit: f.base,
    parentAttemptId: initial.id,
    parentCommit: initialCommit,
  });
  assert.equal(correction.baseRevision, initialCommit);
  assert.equal(correction.application?.state, "applied");
  assert.equal(correction.application.expectedHead, f.base);
  assert.equal(correction.application.revision, correctionCommit);
  assert.deepEqual(correction.application.commits, [initialCommit, correctionCommit]);
  assert.equal(
    await command(f.root, "git", ["rev-list", "--count", `${f.base}..${correctionCommit}`]),
    "2",
  );
  assert.equal(await command(f.root, "git", ["rev-parse", `${correctionCommit}^`]), initialCommit);
  assert.equal(initial.application?.state, "blocked");
  assert.equal(initial.application?.commit, initialCommit);
  assert.equal(initial.application?.expectedHead, drift.revision);
  assert.equal(await readFile(drift.path, "utf8"), "DRIFT\n");
  assert.deepEqual(integration.candidate, {
    kind: "integration",
    rootCommit: drift.revision,
    parentAttemptId: initial.id,
    parentCommit: initialCommit,
  });
  assert.equal(integration.baseRevision, drift.revision);
  assert.equal(integration.application?.state, "applied");
  assert.equal(integration.application.rootCommit, drift.revision);
  assert.deepEqual(integration.application.commits, [integrationCommit]);
  assert.equal(integration.application.revision, integrationCommit);
  assert.equal(
    await command(f.root, "git", [
      "rev-list",
      "--count",
      `${drift.revision}..${integrationCommit}`,
    ]),
    "1",
  );
  assert.equal(correction.outputRelease?.state, "completed");
  assert.equal(integration.outputRelease?.state, "completed");
  assert.equal(initial.outputRelease, undefined);
  assert.equal(review.baseRevision, correctionCommit);
  assert.equal(review.placement?.kind, "isolated_worktree");
  assert.equal(review.worker?.cwd, review.placement?.path);
  assert.equal(review.cleanup?.state, "completed");
  const initialResult = state.results.find(
    (result) => result.assignmentId === CAPABILITY_SCENARIO_IDS.updateValue,
  );
  assert.ok(initialResult !== undefined);
  assert.ok(
    concurrent.createdAt < initialResult.observedAt,
    "Research must be queued before the initial candidate settles",
  );
  for (const implementation of [initial, correction, integration]) {
    for (const role of ["implementation.guide", "implementation.executor"] as const) {
      assert.ok(
        implementation.effectiveModels?.some(
          (model) => model.source === "message" && model.model === policy.roles[role].model,
        ) === true,
        `No actual message observed for ${role} in ${implementation.id}`,
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
      `No executor transition observed in ${implementation.id}`,
    );
  }
  const coordinatorEntries = SessionManager.open(coordinator.sessionFile).getBranch();
  assert.ok(
    !coordinatorEntries.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        ["workgraph_begin", "workgraph_status", "workgraph_result"].includes(
          entry.message.toolName,
        ),
    ),
  );
  const worktreePorcelain = await command(f.root, "git", ["worktree", "list", "--porcelain"]);
  assert.equal(worktreePorcelain.split("worktree ").length - 1, 3);
  assert.ok(initial.placement?.kind === "isolated_worktree");
  assert.match(worktreePorcelain, new RegExp(initial.placement.path));
  assert.match(worktreePorcelain, new RegExp(artifact.reference));
  const releasePrompt = `The capability scenario has all seven existing attempts settled, but the workstream remains active because its deliberate moved-destination refusal is preserved. Do not delegate, retry, inspect through another tool, alter any file, apply any output, or change intent. The harness has already established the exact retained bytes BEFORE followed by one newline at ${retainedProbe}. Invoke exactly one supported coordinator action now: workgraph_control with action release_output, attempt ${experimentAttempt.id}, and destructive reason "${retainedOutputReleaseReason}". Use that exact internal attempt id, not a task handle. Return only after the action result is recorded.`;
  await writeFile(join(f.parent, "release-request.txt"), releasePrompt);
  await herdr(f.root, Type.Object({}), "agent", "prompt", coordinator.agentName, releasePrompt);
  const releasedState = await waitFor(
    // oxlint-disable-next-line effecttsgo/async-function -- This exact Node, Pi, or live smoke boundary preserves its native callback and payload contract; validation remains in the boundary body.
    async () => {
      const observed = await inspectSingleWorkstream(f);
      if (observed === undefined) return undefined;
      latest = observed;
      const attempt = observed.attempts.find((item) => item.id === experimentAttempt.id);
      assert.ok(attempt !== undefined);
      if (attempt.outputRelease?.state === "blocked")
        throw new Error(
          `Retained output release is blocked: ${JSON.stringify(attempt.outputRelease)}`,
        );
      return attempt.outputRelease?.state === "completed" ? observed : undefined;
    },
    timeoutMs,
    "exact retained-output release and recorded state transition",
  );
  assert.equal(releasedState.lifecycle.state, "active");
  assert.equal(releasedState.completion, undefined);
  assert.equal(releasedState.attempts.length, state.attempts.length);
  assert.deepEqual(
    releasedState.assignments.map((assignment) => assignment.id).sort(),
    state.assignments.map((assignment) => assignment.id).sort(),
  );
  assert.equal(releasedState.results.length, state.results.length);
  assert.equal(releasedState.deliveries.length, state.deliveries.length);
  const releasedAttempt = releasedState.attempts.find(
    (attempt) => attempt.id === experimentAttempt.id,
  );
  assert.ok(releasedAttempt !== undefined);
  assert.equal(releasedAttempt.outputRelease?.state, "completed");
  assert.equal(releasedAttempt.outputRelease?.expectedHead, retainedWorktreeHead);
  assert.equal(releasedAttempt.outputRelease?.reason, retainedOutputReleaseReason);
  await writeFile(
    join(f.parent, "release-state-observation.json"),
    JSON.stringify(releasedState, null, 2),
  );
  const releaseEntries = SessionManager.open(coordinator.sessionFile).getBranch();
  assert.ok(
    releaseEntries.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.content.some(
          (block) =>
            block.type === "toolCall" &&
            block.name === "workgraph_control" &&
            Value.Check(
              Type.Object({
                action: Type.Literal("release_output"),
                attempt: Type.Literal(experimentAttempt.id),
                reason: Type.String({ minLength: 1 }),
              }),
              block.arguments,
            ),
        ),
    ),
    "No exact coordinator release_output action was observed",
  );
  await assert.rejects(readFile(retainedProbe), /ENOENT/);
  const releasedResources = observeIsolatedGitResourceAbsence(
    [experimentPlacement],
    await command(f.root, "git", ["worktree", "list", "--porcelain"]),
    await command(f.root, "git", ["for-each-ref", "--format=%(refname)", "refs/heads"]),
  );
  assert.ok(
    releasedResources.valid,
    `Released experiment Git resources remain: ${JSON.stringify(releasedResources.resources)}`,
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
        implementationRevision: integrationCommit,
        destinationDrift: drift,
        launchPlan,
        usage,
        cleanup,
        checks:
          "normal package loading, fresh worker isolation, actual notification-driven baseline-to-correction progression and assistant continuations for every result, disposable experiment retention/non-composition, destination unchanged until explicit complete-chain correction application, exact isolated pre-apply review, preserved drift refusal, moved-base integration, candidate history, model messages and Prewalk transitions, native settlement, retained output resources, Herdr cleanup, and copied-agent-file cleanup",
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
  driftAbort.abort();
  if (fixture && latest)
    await writeFile(
      join(fixture.parent, "state-observation.json"),
      JSON.stringify(latest, null, 2),
    );
  await retainFailure(checkpoint, error instanceof Error ? error : String(error));
}
