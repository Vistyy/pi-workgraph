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
  const prompt = `Determine why the fixture's marker is ambiguous for a tiny parser, using the least expensive useful evidence. If a disposable probe can resolve that uncertainty, run it with only the permitted scratch effect and retain the observed output. If the evidence supports a correction, make the smallest authorized change so value.txt contains exactly after followed by one newline. Do not change any other file. Verify the final bytes, the existing verifier, the exact changed-file set, and that every worker and owned workspace resource is clean before concluding. If any check cannot be established, report the concrete blocker instead of claiming success.`;
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
  assert.equal(await command(f.root, "node", ["verify.mjs"]), "value verified");
  assert.equal(await command(f.root, "git", ["status", "--porcelain"]), "");
  assert.equal(
    await command(f.root, "git", ["diff", "--name-only", f.base, "HEAD"]),
    "value.txt",
  );
  assert.ok(latest.results.length >= 1);
  await closeOwnedWorkspace(f, coordinator);
  await writeFile(
    join(f.parent, "passed.json"),
    JSON.stringify(
      {
        status: "passed",
        candidateRevision: f.revision,
        checks:
          "natural uncertainty, bounded probe, exact bytes, verifier, changed files, native settlement and cleanup",
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
