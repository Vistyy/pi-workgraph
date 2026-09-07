import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This exact Node, Pi, or live smoke boundary preserves its native callback and payload contract; validation remains in the boundary body.
import { readdir, readFile, writeFile } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This exact Node, Pi, or live smoke boundary preserves its native callback and payload contract; validation remains in the boundary body.
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Config, ConfigProvider, Effect } from "effect";
import { Type } from "typebox";
import { loadModelPolicy } from "../../src/model-policy.js";
import { hasNativeAgentSettled } from "../../src/pi-process.js";
import { WorkstreamStore } from "../../src/workstream.js";
import {
  closeOwnedWorkspace,
  command,
  createFixtureCheckpoint,
  createLiveFixture,
  finalizeSuccessfulFixture,
  herdr,
  liveCoordinatorModel,
  observeNativeSessionUsage,
  retainFailure,
  startCoordinator,
  waitFor,
} from "./harness.js";
import {
  observeCoordinatorTurn,
  observeDelegatedOutcome,
  observeDirectEffect,
  observeIsolatedGitResourceAbsence,
  type RepositorySnapshot,
} from "./scenario-observation.js";

function snapshotWorkingTree(root: string): Promise<RepositorySnapshot> {
  return Promise.all([
    command(root, "git", ["ls-files", "-z"]),
    command(root, "git", ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]).then(([tracked, untracked]) => {
    const paths = new Set(`${tracked}\0${untracked}`.split("\0").filter((path) => path.length > 0));
    return Promise.all(
      [...paths].map((path) =>
        readFile(join(root, path))
          .then((bytes) => [path, bytes.toString("base64")] as const)
          // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native filesystem rejection is decoded before missing-file recovery.
          .catch((error: unknown) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT")
              return [path, "<missing>"] as const;
            throw error;
          }),
      ),
    ).then((entries) => new Map(entries));
  });
}

function inspectWorkstream(root: string) {
  const directory = join(root, ".git", "pi-workgraph", "workstreams");
  return (
    readdir(directory)
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native filesystem rejection is decoded before absent-workstream recovery.
      .catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
      })
      .then((names) => {
        if (names.length > 1)
          throw new Error(`Natural scenario created multiple workstreams: ${names.join(", ")}`);
        if (names.length === 0) return undefined;
        const workstreamName = names[0];
        assert.ok(workstreamName !== undefined);
        return WorkstreamStore.inspect(join(directory, workstreamName, "workstream.json"));
      })
  );
}

function assertNativeCoordinatorIdentity(
  root: string,
  coordinator: Awaited<ReturnType<typeof startCoordinator>>,
): Promise<void> {
  return herdr(
    root,
    Type.Object({
      agent: Type.Object({
        terminal_id: Type.String(),
        cwd: Type.String(),
        agent_session: Type.Object({ value: Type.String() }),
        agent_status: Type.String(),
      }),
    }),
    "agent",
    "get",
    coordinator.paneId,
  ).then(({ agent: observed }) => {
    if (observed.terminal_id !== coordinator.terminalId)
      throw new Error("Native coordinator terminal identity changed while observing the request.");
    if (observed.cwd !== coordinator.cwd)
      throw new Error("Native coordinator cwd changed while observing the request.");
    if (observed.agent_session.value !== coordinator.sessionFile)
      throw new Error("Native coordinator session changed while observing the request.");
    if (observed.agent_status === "blocked")
      throw new Error(
        "Native coordinator is blocked and requires operator action; request cannot complete.",
      );
  });
}

function verifyDelegatedSettlements(
  workspaceId: string,
  state: Awaited<ReturnType<typeof WorkstreamStore.inspect>>,
): void {
  for (const attempt of state.attempts) {
    if (
      attempt.sessionFile === undefined ||
      !hasNativeAgentSettled(attempt.sessionFile, state.id, attempt.id)
    )
      throw new Error(
        `Delegated attempt ${attempt.id} has no native settled marker for its exact generation.`,
      );
    const worker = attempt.worker;
    if (worker === undefined || worker.workspaceId !== workspaceId)
      throw new Error(
        `Delegated attempt ${attempt.id} is not attributable to the owned workspace.`,
      );
    if (attempt.placement === undefined || worker.cwd !== attempt.placement.path)
      throw new Error(
        `Delegated attempt ${attempt.id} has an unexpected worker placement identity.`,
      );
  }
}

function retainedExperimentReferences(
  state: Awaited<ReturnType<typeof WorkstreamStore.inspect>>,
): Array<{ artifactId: string; reference: string }> {
  const references: Array<{ artifactId: string; reference: string }> = [];
  const experiments = state.assignments.filter(
    (assignment) => assignment.artifactIntent === "disposable_experiment",
  );
  for (const assignment of experiments) {
    const result = state.results.find((item) => item.assignmentId === assignment.id);
    if (result?.validity !== "typed")
      throw new Error(`Experiment ${assignment.id} has no typed retained result.`);
    assert.ok(
      result.artifacts.some(
        (artifact) => artifact.id === "experiment-worktree" && artifact.retention === "retained",
      ),
    );
  }
  return references;
}

function verifyRetainedExperiments(
  state: Awaited<ReturnType<typeof WorkstreamStore.inspect>>,
): Promise<void> {
  return Promise.all(
    retainedExperimentReferences(state).map(({ artifactId, reference }) =>
      readFile(reference)
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native filesystem rejection is normalized into retained-artifact evidence.
        .catch((error: unknown) => {
          throw new Error(
            `Retained experiment output ${artifactId} is not readable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
    ),
  ).then(() => undefined);
}

// oxlint-disable-next-line effecttsgo/async-function -- This live oracle independently queries native Git worktree and ref state.
async function verifyIsolatedGitResourcesAbsent(
  root: string,
  state: Awaited<ReturnType<typeof WorkstreamStore.inspect>>,
) {
  const placements = state.attempts.flatMap((attempt) =>
    attempt.placement?.kind === "isolated_worktree" ? [attempt.placement] : [],
  );
  const observation = observeIsolatedGitResourceAbsence(
    placements,
    await command(root, "git", ["worktree", "list", "--porcelain"]),
    await command(root, "git", ["for-each-ref", "--format=%(refname)", "refs/heads"]),
  );
  assert.ok(
    observation.valid,
    `Isolated Git resources remain: ${JSON.stringify(observation.resources)}`,
  );
  return observation.resources;
}

const smokeTimeout = Effect.runSync(
  Config.number("PI_WORKGRAPH_SMOKE_TIMEOUT_MS")
    .pipe(Config.withDefault(1_800_000))
    .parse(ConfigProvider.fromEnvRecord(process.env)),
);

const checkpoint = createFixtureCheckpoint("Workgraph optional natural UX observation");
let fixture: Awaited<ReturnType<typeof createLiveFixture>> | undefined;
let latest: Awaited<ReturnType<typeof WorkstreamStore.inspect>> | undefined;
try {
  fixture = await createLiveFixture("Workgraph optional natural UX observation", checkpoint);
  const f = fixture;
  const policy = await loadModelPolicy(join(f.agentDir, "workgraph", "models.json"));
  const launchPlan = {
    coordinatorModel: liveCoordinatorModel,
    expectedAttempts:
      "Not predetermined; the coordinator may choose a direct or delegated strategy.",
    selectedWorkerModelsIfDelegated: policy.roles,
  };
  await writeFile(join(f.parent, "launch-plan.json"), JSON.stringify(launchPlan, null, 2));
  process.stderr.write(`Optional natural scenario launch plan: ${JSON.stringify(launchPlan)}\n`);
  const coordinator = await startCoordinator(f);
  const prompt = `Inspect the fixture's parser and marker bytes to determine the concrete normalization issue, using the least expensive useful evidence. A disposable scratch effect is permitted only for a small, isolated observation and only if reading the supplied files does not resolve the question; retain any resulting observation. If the evidence supports a correction, make the smallest authorized change so value.txt contains exactly after followed by one newline, without changing any other maintained file. Verify the final bytes, parser/verifier behavior, exact changed-file set, and every owned worker/resource cleanup before concluding. If any check cannot be established, report the concrete blocker instead of claiming success.`;
  await writeFile(join(f.parent, "initial-request.txt"), prompt);
  const before = await snapshotWorkingTree(f.root);
  await herdr(f.root, Type.Object({}), "agent", "prompt", coordinator.agentName, prompt);
  const outcome = await waitFor(
    // oxlint-disable-next-line effecttsgo/async-function -- This exact Node, Pi, or live smoke boundary preserves its native callback and payload contract; validation remains in the boundary body.
    async () => {
      await assertNativeCoordinatorIdentity(f.root, coordinator);
      const turn = observeCoordinatorTurn(
        SessionManager.open(coordinator.sessionFile).getBranch(),
        prompt,
      );
      if (turn.state === "failed" || turn.state === "blocked")
        throw new Error(`Natural coordinator request did not complete: ${turn.detail}`);
      if (turn.state === "waiting") return undefined;

      latest = await inspectWorkstream(f.root);
      const after = await snapshotWorkingTree(f.root);
      const directEffect = observeDirectEffect(
        before,
        after,
        Buffer.from("after\n").toString("base64"),
      );
      if (!latest) {
        if (!directEffect.valid)
          throw new Error(
            `Settled direct request produced an invalid result: ${directEffect.detail}`,
          );
        return { strategy: "direct" as const, turn, directEffect };
      }
      if (latest.lifecycle.state !== "active" && latest.lifecycle.state !== "completed")
        throw new Error(
          `Natural delegated request reached ${latest.lifecycle.state}: ${latest.lifecycle.reason}`,
        );
      if (
        latest.attempts.some(
          (attempt) =>
            attempt.state === "failed" ||
            attempt.cleanup?.state === "blocked" ||
            attempt.composition?.state === "blocked",
        )
      )
        throw new Error(
          "Natural delegated request has a failed or blocked attempt; no further wait is justified.",
        );
      if (latest.lifecycle.state !== "completed") return undefined;
      const delegated = observeDelegatedOutcome(latest, directEffect);
      if (!delegated.valid)
        throw new Error(
          `Settled delegated request produced an invalid result: ${delegated.detail}`,
        );
      verifyDelegatedSettlements(f.workspaceId, latest);
      await verifyRetainedExperiments(latest);
      return {
        strategy: delegated.implementationOrigin === "direct" ? "mixed" : "delegated",
        implementationOrigin: delegated.implementationOrigin,
        turn,
        directEffect,
        delegated,
      };
    },
    smokeTimeout,
    "native coordinator request settlement and truthful direct/delegated outcome",
  );

  assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "after\n");
  assert.deepEqual(JSON.parse(await command(f.root, "node", ["parse-marker.mjs"])), {
    raw: "AMBER.",
    parsed: "AMBER",
  });
  assert.equal(await command(f.root, "node", ["verify.mjs"]), "value verified");
  const after = await snapshotWorkingTree(f.root);
  const directEffect = observeDirectEffect(
    before,
    after,
    Buffer.from("after\n").toString("base64"),
  );
  assert.deepEqual(directEffect.changedPaths, ["value.txt"]);

  const observations = {
    strategy: outcome.strategy,
    delegationExercised: outcome.strategy !== "direct",
    implementationOrigin: outcome.strategy === "direct" ? "direct" : outcome.implementationOrigin,
    ...(outcome.strategy === "direct"
      ? {
          evidenceLimit: "No delegation was exercised; native direct outcome only.",
        }
      : {
          experiment: outcome.delegated?.experiment,
          delegatedOutcome: outcome.delegated?.detail,
        }),
    nativeSettlement: outcome.turn.detail,
    changedPaths: directEffect.changedPaths,
    finalWorkingTreeBytesChecked: true,
    finalRevision: await command(f.root, "git", ["rev-parse", "HEAD"]),
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- This exact Node, Pi, or live smoke boundary preserves its native callback and payload contract; validation remains in the boundary body.
    ...(latest
      ? {
          assignments: latest.assignments.map((assignment) => ({
            id: assignment.id,
            capability: assignment.capability,
            artifactIntent: assignment.artifactIntent,
          })),
          results: latest.results.map((result) => ({
            id: result.id,
            assignmentId: result.assignmentId,
            validity: result.validity,
          })),
        }
      : {}),
  };
  await writeFile(
    join(f.parent, "natural-observations.json"),
    JSON.stringify(observations, null, 2),
  );
  const gitResourceCleanup = latest ? await verifyIsolatedGitResourcesAbsent(f.root, latest) : [];
  const usage = observeNativeSessionUsage([
    coordinator.sessionFile,
    ...(latest?.attempts.flatMap((attempt) =>
      attempt.sessionFile === undefined ? [] : [attempt.sessionFile],
    ) ?? []),
  ]);
  await writeFile(join(f.parent, "usage.json"), JSON.stringify(usage, null, 2));
  await closeOwnedWorkspace(f, coordinator);
  const cleanup = await finalizeSuccessfulFixture(f);
  await writeFile(
    join(f.parent, "passed.json"),
    JSON.stringify(
      {
        status: "passed",
        evidenceScope: "optional-ux-observation-not-lifecycle-gate",
        candidateRevision: f.revision,
        finalRevision: observations.finalRevision,
        delegationExercised: observations.delegationExercised,
        launchPlan,
        usage,
        gitResourceCleanup,
        cleanup,
        checks:
          "native request message progression and identity, direct or delegated strategy, independent tracked/untracked bytes, parser, verifier, attributable outcomes, retained experiment outputs when present, independent isolated worktree/branch absence, exact workspace absence, and copied-agent-file cleanup; this optional UX observation is not a worker lifecycle gate",
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      evidenceScope: "optional-ux-observation-not-lifecycle-gate",
      evidence: f.parent,
      candidateRevision: f.revision,
    })}\n`,
  );
} catch (error) {
  await retainFailure(checkpoint, error instanceof Error ? error : String(error));
}
