import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { hasNativeAgentSettled } from "../src/pi-process.js";
import { type WorkstreamState, WorkstreamStore } from "../src/workstream.js";
import { notificationDrivenProgress } from "./coordinator-observation.js";
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
  const prompt = `Use Workgraph capability tools to complete this single bounded workstream without another approval ceremony.
Coordinator-only context: ${privateToken}. Never include that token in worker assignments.
First gather cheap evidence about the README marker and exact current value.txt bytes, then use the returned findings to decide what bounded work is justified. End your turn when only workers are running and resume on actual results.
Next delegate disposable experiment id uppercase-experiment, explicitly authorized to read value.txt and write only probe.txt containing its uppercase bytes. Stop after one observation, retain probe.txt, never compose scratch code.
Then delegate maintained implementation id update-value, explicitly authorized to change only value.txt to exactly after followed by one newline, with acceptance node verify.mjs and exact bytes/scope. Use policy guide/executor defaults.
Immediately after queueing implementation, before waiting for its result, queue read-only research id concurrent-readme to read the README marker, demonstrating interleaving.
After maintained composition, delegate independent review id exact-revision-review of that exact retained revision, concerned with scope, exact bytes, absence of probe.txt and node verify.mjs.
You may run read-only verification yourself but do not edit the fixture directly. Do not delegate extra workers or change model policy.
Handle result notifications automatically and inspect execution, findings, evidence, uncertainty, and cleanup. After queueing useful independent work, end your turn to receive notifications; do not poll status, run waits for workers, or wait inside shell commands. Status inspection for an actual result or attention is appropriate.
Independently verify retained probe.txt is BEFORE followed by a newline, maintained value.txt is after followed by a newline, only value.txt changed, node verify.mjs passes, and all owned attempts/resources settled and cleaned.
Complete with concrete evidence and honest limitations only after those conditions hold. Report a blocker instead of claiming success if a required boundary is unavailable.`;
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
        (result) => result.assignmentId === "baseline-research",
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
    [
      "baseline-research",
      "concurrent-readme",
      "exact-revision-review",
      "update-value",
      "uppercase-experiment",
    ].sort(),
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
  assert.deepEqual(state.completion?.unresolvedAssignmentIds, []);
  for (const attempt of state.attempts) {
    assert.equal(attempt.state, "settled");
    assert.equal(attempt.cleanup?.state, "completed");
    assert.equal(attempt.cleanup?.workerClosed, true);
    assert.ok(attempt.worker && attempt.sessionFile);
    assert.equal(attempt.worker.workspaceId, f.workspaceId);
    assert.ok(hasNativeAgentSettled(attempt.sessionFile, state.id, attempt.id));
    assert.ok(
      !(await readFile(attempt.sessionFile, "utf8")).includes(privateToken),
    );
  }
  const experiment = state.results.find(
    (result) => result.assignmentId === "uppercase-experiment",
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
    (attempt) => attempt.assignmentId === "update-value",
  );
  const review = state.attempts.find(
    (attempt) => attempt.assignmentId === "exact-revision-review",
  );
  const concurrent = state.assignments.find(
    (assignment) => assignment.id === "concurrent-readme",
  );
  assert.ok(implementation && review && concurrent);
  assert.equal(review.baseRevision, implementation.composition?.revision);
  assert.equal(
    review.baseRevision,
    await command(f.root, "git", ["rev-parse", "HEAD"]),
  );
  const implementationResult = state.results.find(
    (result) => result.assignmentId === "update-value",
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
        entry.message.toolName === "workgraph_begin",
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
