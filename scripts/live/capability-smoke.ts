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
// oxlint-disable-next-line effecttsgo/async-function -- This exact native smoke boundary observes the model-driven state without coordinator polling tools.
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
      const allAttemptsClosed =
        observed.attempts.length === launchPlan.expectedAttempts &&
        observed.attempts.every(
          (attempt) => attempt.state === "settled" && attempt.cleanup?.state === "completed",
        );
      return completeChainApplied &&
        correction?.outputRelease?.state === "completed" &&
        review?.cleanup?.state === "completed" &&
        initial?.application === undefined &&
        allAttemptsClosed &&
        progressed
        ? observed
        : undefined;
    },
    timeoutMs,
    "notification-driven capability flow through complete-chain correction application and exact review",
  );
  await writeFile(join(f.parent, "state-observation.json"), JSON.stringify(state, null, 2));
  assert.deepEqual(
    state.assignments.map((assignment) => assignment.id).sort(),
    Object.values(CAPABILITY_SCENARIO_IDS).sort(),
  );
  assert.equal(state.attempts.length, 6);
  assert.equal(state.results.length, 6);
  assert.ok(
    state.results.every(
      (result) => result.validity === "typed" && result.report.status === "completed",
    ),
  );
  assert.equal(state.deliveries.length, 6);
  assert.ok(state.deliveries.every((delivery) => delivery.state !== "pending"));
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
  assert.equal(await command(f.root, "node", ["verify.mjs"]), "value verified");
  assert.equal(await command(f.root, "git", ["status", "--porcelain"]), "");
  assert.equal(
    await command(f.root, "git", ["diff", "--name-only", f.base, "HEAD"]),
    "candidate.txt\nvalue.txt",
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
  const concurrent = state.assignments.find(
    (assignment) => assignment.id === CAPABILITY_SCENARIO_IDS.concurrentReadme,
  );
  assert.ok(initial !== undefined);
  assert.ok(correction !== undefined);
  assert.ok(review !== undefined);
  assert.ok(concurrent !== undefined);
  const changedCommit = (assignmentId: string): string =>
    changedImplementationCommit(state, assignmentId);
  const initialCommit = changedCommit(CAPABILITY_SCENARIO_IDS.updateValue);
  const correctionCommit = changedCommit(CAPABILITY_SCENARIO_IDS.correctionCandidate);
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
  assert.equal(initial.application, undefined);
  assert.equal(correction.outputRelease?.state, "completed");
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
  for (const implementation of [initial, correction]) {
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
  const releasePrompt = `The capability scenario has all six existing attempts settled. The workstream may remain active while the retained experiment output is released. Do not delegate, retry, inspect through another tool, alter any file, apply any output, or change intent. The harness has already established the exact retained bytes BEFORE followed by one newline at ${retainedProbe}. Invoke exactly one supported coordinator action now: workgraph_control with action release_output, attempt ${experimentAttempt.id}, and destructive reason "${retainedOutputReleaseReason}". Use that exact internal attempt id, not a task handle. Return only after the action result is recorded.`;
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
        implementationRevision: correctionCommit,
        launchPlan,
        usage,
        cleanup,
        checks:
          "normal package loading, fresh worker isolation, actual notification-driven baseline-to-correction progression and assistant continuations for every result, disposable experiment retention/non-composition, destination unchanged until explicit complete-chain correction application, exact isolated pre-apply review, candidate history, model messages and Prewalk transitions, native settlement, retained output resources, Herdr cleanup, and copied-agent-file cleanup",
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
