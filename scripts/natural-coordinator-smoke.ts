import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { hasNativeAgentSettled } from "../src/pi-process.js";
import { WorkstreamStore } from "../src/workstream.js";
import {
  observeCoordinatorTurn,
  observeDelegatedOutcome,
  observeDirectEffect,
  type RepositorySnapshot,
} from "./coordinator-observation.js";
import {
  closeOwnedWorkspace,
  command,
  createLiveFixture,
  herdr,
  object,
  retainFailure,
  startCoordinator,
  waitFor,
} from "./live-fixture.js";

async function snapshotWorkingTree(root: string): Promise<RepositorySnapshot> {
  const tracked = await command(root, "git", ["ls-files", "-z"]);
  const untracked = await command(root, "git", [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const paths = new Set(
    `${tracked}\0${untracked}`.split("\0").filter((path) => path.length > 0),
  );
  const snapshot = new Map<string, string>();
  for (const path of paths) {
    try {
      snapshot.set(path, (await readFile(join(root, path))).toString("base64"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        snapshot.set(path, "<missing>");
      else throw error;
    }
  }
  return snapshot;
}

async function inspectWorkstream(root: string) {
  const directory = join(root, ".git", "pi-workgraph", "workstreams");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
  if (names.length > 1)
    throw new Error(
      `Natural scenario created multiple workstreams: ${names.join(", ")}`,
    );
  if (names.length === 0) return undefined;
  return WorkstreamStore.inspect(join(directory, names[0]!, "workstream.json"));
}

async function assertNativeCoordinatorIdentity(
  root: string,
  coordinator: Awaited<ReturnType<typeof startCoordinator>>,
): Promise<void> {
  const observed = object(
    (await herdr(root, "agent", "get", coordinator.paneId)).agent,
  );
  if (observed.terminal_id !== coordinator.terminalId)
    throw new Error(
      "Native coordinator terminal identity changed while observing the request.",
    );
  if (observed.cwd !== coordinator.cwd)
    throw new Error(
      "Native coordinator cwd changed while observing the request.",
    );
  const session = object(observed.agent_session);
  if (session.value !== coordinator.sessionFile)
    throw new Error(
      "Native coordinator session changed while observing the request.",
    );
  if (observed.agent_status === "blocked")
    throw new Error(
      "Native coordinator is blocked and requires operator action; request cannot complete.",
    );
}

async function verifyDelegatedSettlements(
  workspaceId: string,
  state: Awaited<ReturnType<typeof WorkstreamStore.inspect>>,
): Promise<void> {
  for (const attempt of state.attempts) {
    if (
      !attempt.sessionFile ||
      !hasNativeAgentSettled(attempt.sessionFile, state.id, attempt.id)
    )
      throw new Error(
        `Delegated attempt ${attempt.id} has no native settled marker for its exact generation.`,
      );
    const worker = attempt.worker;
    if (!worker || worker.workspaceId !== workspaceId)
      throw new Error(
        `Delegated attempt ${attempt.id} is not attributable to the owned workspace.`,
      );
    if (!attempt.worktreePath || worker.cwd !== attempt.worktreePath)
      throw new Error(
        `Delegated attempt ${attempt.id} has an unexpected worker worktree identity.`,
      );
  }
}

async function verifyRetainedExperiments(
  state: Awaited<ReturnType<typeof WorkstreamStore.inspect>>,
): Promise<void> {
  for (const assignment of state.assignments) {
    if (assignment.artifactIntent !== "disposable_experiment") continue;
    const result = state.results.find(
      (item) => item.assignmentId === assignment.id,
    );
    if (result?.validity !== "typed")
      throw new Error(
        `Experiment ${assignment.id} has no typed result to verify retained outputs.`,
      );
    for (const artifactId of assignment.artifactPolicy.retain) {
      const artifact = result.artifacts.find(
        (item) => item.id === artifactId && item.retention === "retained",
      );
      if (!artifact)
        throw new Error(
          `Experiment ${assignment.id} did not declare retained output ${artifactId}.`,
        );
      try {
        await readFile(artifact.reference);
      } catch (error) {
        throw new Error(
          `Retained experiment output ${artifactId} is not readable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

let fixture: Awaited<ReturnType<typeof createLiveFixture>> | undefined;
let latest: Awaited<ReturnType<typeof WorkstreamStore.inspect>> | undefined;
try {
  fixture = await createLiveFixture("Workgraph natural bounded correction");
  const f = fixture;
  const coordinator = await startCoordinator(f);
  const prompt = `Inspect the fixture's parser and marker bytes to determine the concrete normalization issue, using the least expensive useful evidence. A disposable scratch effect is permitted only for a small, isolated observation and only if reading the supplied files does not resolve the question; retain any resulting observation. If the evidence supports a correction, make the smallest authorized change so value.txt contains exactly after followed by one newline, without changing any other maintained file. Verify the final bytes, parser/verifier behavior, exact changed-file set, and every owned worker/resource cleanup before concluding. If any check cannot be established, report the concrete blocker instead of claiming success.`;
  await writeFile(join(f.parent, "initial-request.txt"), prompt);
  const before = await snapshotWorkingTree(f.root);
  await herdr(f.root, "agent", "prompt", coordinator.agentName, prompt);
  const outcome = await waitFor(
    async () => {
      await assertNativeCoordinatorIdentity(f.root, coordinator);
      const turn = observeCoordinatorTurn(
        SessionManager.open(coordinator.sessionFile).getBranch(),
        prompt,
      );
      if (turn.state === "failed" || turn.state === "blocked")
        throw new Error(
          `Natural coordinator request did not complete: ${turn.detail}`,
        );
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
      if (
        latest.lifecycle.state !== "active" &&
        latest.lifecycle.state !== "completed"
      )
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
      await verifyDelegatedSettlements(f.workspaceId, latest);
      await verifyRetainedExperiments(latest);
      return { strategy: "delegated" as const, turn, directEffect, delegated };
    },
    Number(process.env.PI_WORKGRAPH_SMOKE_TIMEOUT_MS || 1_800_000),
    "native coordinator request settlement and truthful direct/delegated outcome",
  );

  assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "after\n");
  assert.deepEqual(
    JSON.parse(await command(f.root, "node", ["parse-marker.mjs"])),
    { raw: "AMBER.", parsed: "AMBER" },
  );
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
    delegationExercised: outcome.strategy === "delegated",
    ...(outcome.strategy === "direct"
      ? {
          evidenceLimit:
            "No delegation was exercised; native direct outcome only.",
        }
      : {
          experiment: outcome.delegated.experiment,
          delegatedOutcome: outcome.delegated.detail,
        }),
    nativeSettlement: outcome.turn.detail,
    changedPaths: directEffect.changedPaths,
    finalWorkingTreeBytesChecked: true,
    finalRevision: await command(f.root, "git", ["rev-parse", "HEAD"]),
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
  await closeOwnedWorkspace(f, coordinator);
  await writeFile(
    join(f.parent, "passed.json"),
    JSON.stringify(
      {
        status: "passed",
        candidateRevision: f.revision,
        finalRevision: observations.finalRevision,
        delegationExercised: observations.delegationExercised,
        checks:
          "native request message progression and identity, direct or delegated strategy, independent tracked/untracked bytes, parser, verifier, attributable outcomes, retained experiment outputs when present, and exact cleanup",
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
