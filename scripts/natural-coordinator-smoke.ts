import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hasNativeAgentSettled } from "../src/pi-process.js";
import { WorkstreamStore } from "../src/workstream.js";
import {
  closeOwnedWorkspace,
  command,
  createLiveFixture,
  herdr,
  retainFailure,
  startCoordinator,
  waitFor,
} from "./live-fixture.js";

let fixture: Awaited<ReturnType<typeof createLiveFixture>> | undefined;
let latest: Awaited<ReturnType<typeof WorkstreamStore.inspect>> | undefined;
try {
  fixture = await createLiveFixture("Workgraph natural bounded correction");
  const f = fixture;
  const coordinator = await startCoordinator(f);
  const prompt = `Inspect the fixture's parser and marker bytes to determine the concrete normalization issue, using the least expensive useful evidence. A disposable scratch effect is permitted only for a small, isolated observation and only if reading the supplied files does not resolve the question; retain any resulting observation. If the evidence supports a correction, make the smallest authorized change so value.txt contains exactly after followed by one newline, without changing any other maintained file. Verify the final bytes, parser/verifier behavior, exact changed-file set, and every owned worker/resource cleanup before concluding. If any check cannot be established, report the concrete blocker instead of claiming success.`;
  await writeFile(join(f.parent, "initial-request.txt"), prompt);
  await herdr(f.root, "agent", "prompt", coordinator.agentName, prompt);
  latest = await waitFor(
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
      if (names.length !== 1) return undefined;
      const state = await WorkstreamStore.inspect(
        join(directory, names[0]!, "workstream.json"),
      );
      const done =
        state.lifecycle.state === "completed" &&
        state.completion &&
        state.attempts.every(
          (attempt) =>
            attempt.cleanup?.state === "completed" &&
            hasNativeAgentSettled(attempt.sessionFile!, state.id, attempt.id),
        );
      return done ? state : undefined;
    },
    Number(process.env.PI_WORKGRAPH_SMOKE_TIMEOUT_MS || 1_800_000),
    "natural coordinator completion",
  );
  assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "after\n");
  assert.deepEqual(
    JSON.parse(await command(f.root, "node", ["parse-marker.mjs"])),
    { raw: "AMBER.", parsed: "AMBER" },
  );
  assert.equal(await command(f.root, "node", ["verify.mjs"]), "value verified");
  assert.equal(await command(f.root, "git", ["status", "--porcelain"]), "");
  assert.equal(
    await command(f.root, "git", ["diff", "--name-only", f.base, "HEAD"]),
    "value.txt",
  );
  assert.ok(latest.results.length >= 1);
  const observations = {
    delegationExercised: latest.attempts.length > 0,
    ...(latest.attempts.length === 0
      ? { evidenceLimit: "No delegation was exercised; fixture outcome only." }
      : {}),
    strategy: latest.assignments.map((assignment) => ({
      id: assignment.id,
      capability: assignment.capability,
      artifactIntent: assignment.artifactIntent,
      objective: assignment.objective,
    })),
    selectedModels: latest.attempts.map((attempt) => ({
      id: attempt.id,
      models: attempt.models,
      effectiveModels: attempt.effectiveModels,
    })),
    findings: latest.results.map((result) =>
      result.validity === "typed"
        ? {
            id: result.id,
            summary: result.report.summary,
            findings: result.report.findings,
            evidence: result.report.evidence,
            artifacts: result.artifacts,
          }
        : { id: result.id, validity: result.validity },
    ),
    effects: latest.results.flatMap((result) => result.artifacts),
    finalRevision: await command(f.root, "git", ["rev-parse", "HEAD"]),
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
          "fixture parser bytes, exact goal bytes, verifier, changed files, native settlement and exact cleanup",
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
