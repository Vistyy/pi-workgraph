import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This regression validates exact native fixture files.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This regression validates exact native fixture paths.
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  createFixtureCheckpoint,
  registerOwnedWorkspace,
  removeCopiedAgentFiles,
} from "../scripts/live/harness.js";

void test("live fixture checkpoint persists exact partial workspace ownership", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-checkpoint-test-"));
  try {
    const checkpoint = createFixtureCheckpoint("partial fixture");
    Object.assign(checkpoint, {
      parent,
      root: join(parent, "fixture"),
      agentDir: join(parent, "agent"),
      candidate: join(parent, "candidate"),
      revision: "a".repeat(40),
    });
    await registerOwnedWorkspace(checkpoint, {
      workspaceId: "workspace-exact",
      paneId: "pane-exact",
    });
    await registerOwnedWorkspace(checkpoint, {
      workspaceId: "workspace-exact",
      paneId: "pane-exact",
      rootTab: "tab-exact",
    });

    const persisted: unknown = JSON.parse(
      await readFile(join(parent, "ownership-checkpoint.json"), "utf8"),
    );
    const checkpointSchema = Type.Object({
      ownedWorkspaces: Type.Array(
        Type.Object({
          workspaceId: Type.String(),
          paneId: Type.String(),
          rootTab: Type.Optional(Type.String()),
        }),
      ),
    });
    assert.ok(Value.Check(checkpointSchema, persisted));
    assert.deepEqual(Value.Decode(checkpointSchema, persisted).ownedWorkspaces, [
      {
        workspaceId: "workspace-exact",
        paneId: "pane-exact",
        rootTab: "tab-exact",
      },
    ]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("successful evidence curation removes only checkpointed copied agent files", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-evidence-test-"));
  try {
    const copied = join(parent, "auth.json");
    const evidence = join(parent, "session.jsonl");
    const unrelated = join(parent, "operator-note.txt");
    await Promise.all([
      writeFile(copied, "credential"),
      writeFile(evidence, "useful evidence"),
      writeFile(unrelated, "preserve"),
    ]);
    const checkpoint = createFixtureCheckpoint("successful fixture");
    checkpoint.parent = parent;
    checkpoint.agentDir = parent;
    checkpoint.copiedAgentFiles.push(copied);

    assert.deepEqual(await removeCopiedAgentFiles(checkpoint), [copied]);
    await assert.rejects(readFile(copied), /ENOENT/);
    assert.equal(await readFile(evidence, "utf8"), "useful evidence");
    assert.equal(await readFile(unrelated, "utf8"), "preserve");

    const unsafe = createFixtureCheckpoint("unsafe fixture");
    unsafe.agentDir = join(parent, "agent");
    unsafe.copiedAgentFiles.push(unrelated);
    await assert.rejects(removeCopiedAgentFiles(unsafe), /outside the exact copied/);
    assert.equal(await readFile(unrelated, "utf8"), "preserve");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
