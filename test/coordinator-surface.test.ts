import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"; // oxlint-disable-line effecttsgo/node-builtin-import -- Real isolated session and SQLite storage establish the registered boundary.
import { tmpdir } from "node:os";
import { join } from "node:path"; // oxlint-disable-line effecttsgo/node-builtin-import -- Fixture paths are exact disposable identities.
import test from "node:test";
import { Value } from "typebox/value";
import {
  type CoordinatorOwner,
  type Intent,
  WORKSTREAM_FORMAT,
  WORKSTREAM_SCHEMA_VERSION,
  type WorkstreamMetadata,
} from "../src/domain/records.js";
import { WorkstreamStore } from "../src/storage/workstream-store.js";
import { configureFixtureEnvironment, restoreFixtureEnvironment } from "./decoders.js";
import { extensionFixture } from "./helpers.js";

const toolNames = [
  "workgraph_models",
  "workgraph_intent",
  "workgraph_handoff",
  "workgraph_research",
  "workgraph_consult",
  "workgraph_implement",
  "workgraph_review",
  "workgraph_attempt",
  "workgraph_inspect",
  "workgraph_control",
  "workgraph_complete",
  "workgraph_adopt",
] as const;

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-coordinator-"));
  const root = join(parent, "repo");
  await mkdir(root);
  const previous = configureFixtureEnvironment({
    PI_CODING_AGENT_DIR: join(parent, "agent"),
    PI_WORKGRAPH_ROLE: null,
    HERDR_ENV: null,
    HERDR_WORKSPACE_ID: "workspace-exact",
    HERDR_TAB_ID: "tab-exact",
  });
  const pi = await extensionFixture("coordinator", root, parent);
  return {
    ...pi,
    parent,
    async dispose() {
      await pi.close();
      restoreFixtureEnvironment(previous);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

void test("coordinator registers exactly the accepted twelve tools and strict final schemas", async () => {
  const f = await fixture();
  try {
    for (const name of toolNames) assert.ok(f.runner.getToolDefinition(name), name);
    assert.equal(f.runner.getToolDefinition("workgraph_notepad"), undefined);
    assert.equal(f.runner.getToolDefinition("workgraph_continue"), undefined);
    assert.equal(f.runner.getToolDefinition("workgraph_suspend"), undefined);

    const intent = f.runner.getToolDefinition("workgraph_intent");
    assert.ok(intent !== undefined);
    assert.equal(Value.Check(intent.parameters, { statement: "Current goal" }), true);
    assert.equal(
      Value.Check(intent.parameters, { statement: "Current goal", authorityReceiptId: "old" }),
      false,
    );

    const implement = f.runner.getToolDefinition("workgraph_implement");
    assert.ok(implement !== undefined);
    assert.equal(
      Value.Check(implement.parameters, {
        taskId: "change",
        cwd: "./repo",
        objective: "Change it",
        acceptance: ["Works"],
        candidate: { attemptId: "prior-1", mode: "extend" },
      }),
      true,
    );
    assert.equal(
      Value.Check(implement.parameters, {
        taskId: "change",
        target: { path: "./repo", kind: "repository" },
        objective: "Change it",
        acceptance: ["Works"],
        candidateOf: "prior-1",
        integrate: false,
      }),
      false,
    );

    const adopt = f.runner.getToolDefinition("workgraph_adopt");
    assert.ok(adopt !== undefined);
    assert.equal(Value.Check(adopt.parameters, { workstreamId: "ws-1" }), true);
    assert.equal(Value.Check(adopt.parameters, { workstreamId: "ws-1", prior: {} }), false);
  } finally {
    await f.dispose();
  }
});

void test("human Intent creation appends the strict pointer before creating and reload attaches it", async () => {
  const f = await fixture();
  try {
    await f.runner.emit({ type: "session_start", reason: "startup" });
    await f.input("Please establish this initiative.");
    const result = await f.call("workgraph_intent", { statement: "Coordinate the initiative" });
    // SAFETY: workgraph_intent's registered result contract returns these two bounded receipt fields.
    const details = result.details as { workstreamId: string; intentIndex: number };
    assert.equal(details.intentIndex, 0);
    const pointer = f.session
      .getBranch()
      .findLast(
        (entry) =>
          entry.type === "custom" && entry.customType === "pi-workgraph-workstream-pointer",
      );
    assert.ok(pointer?.type === "custom");
    assert.deepEqual(pointer.data, { version: 1, workstreamId: details.workstreamId });
    assert.equal(
      f.session
        .getBranch()
        .some(
          (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-record-pointer",
        ),
      false,
    );
    await f.runner.emit({ type: "session_shutdown", reason: "reload" });
    await f.runner.emit({ type: "session_start", reason: "reload" });
    const overview = await f.call("workgraph_inspect", {
      section: "overview",
      workstreamId: details.workstreamId,
    });
    assert.equal(
      // SAFETY: exact overview inspection returns metadata decoded by WorkstreamStore.
      (overview.details as { metadata: { id: string } }).metadata.id,
      details.workstreamId,
    );

    const adopted = await f.call("workgraph_adopt", { workstreamId: details.workstreamId });
    assert.equal(
      // SAFETY: exact already-current adoption returns this bounded lost-response receipt.
      (adopted.details as { alreadyCurrent: boolean }).alreadyCurrent,
      true,
    );
    const beforeHandoff = WorkstreamStore.openReadOnly(
      join(f.parent, "agent"),
      details.workstreamId,
    );
    const metadataBefore = beforeHandoff.readMetadata();
    beforeHandoff.close();
    await assert.rejects(
      f.call("workgraph_handoff", { request: "Narrow independent investigation" }),
      /Handoff launch is uncertain; retained child session/,
    );
    const afterHandoff = WorkstreamStore.openReadOnly(
      join(f.parent, "agent"),
      details.workstreamId,
    );
    assert.deepEqual(afterHandoff.readMetadata(), metadataBefore);
    afterHandoff.close();
  } finally {
    await f.dispose();
  }
});

void test("global discovery is bounded, newest-first, filters settled completion, and surfaces invalid stores", async () => {
  const f = await fixture();
  const agentDir = join(f.parent, "agent");
  const owner: CoordinatorOwner = {
    sessionId: "owner-session",
    sessionFile: "/sessions/owner.jsonl",
    workspaceId: "owner-workspace",
    tabId: "owner-tab",
  };
  const create = (id: string, lifecycle: "active" | "completed") => {
    const at = "2026-01-01T00:00:00.000Z";
    const metadata: WorkstreamMetadata = {
      format: WORKSTREAM_FORMAT,
      schemaVersion: WORKSTREAM_SCHEMA_VERSION,
      id,
      owner,
      lifecycle: "active",
      createdAt: at,
      updatedAt: at,
    };
    const intent: Intent = {
      statement: id,
      constraints: [],
      authority: {
        receiptId: "receipt",
        sessionId: owner.sessionId,
        sessionFile: owner.sessionFile,
      },
      recordedAt: at,
    };
    const store = WorkstreamStore.create(agentDir, metadata, intent);
    if (lifecycle === "completed")
      store.complete(owner, {
        conclusion: "Done",
        evidence: [],
        limitations: [],
        completedAt: "2026-01-02T00:00:00.000Z",
      });
    store.close();
  };
  try {
    create("active-old", "active");
    create("completed-new", "completed");
    const activePath = WorkstreamStore.pathFor(agentDir, "active-old");
    const completedPath = WorkstreamStore.pathFor(agentDir, "completed-new");
    await utimes(activePath, 1, 1);
    await utimes(completedPath, 2, 2);
    const invalidDir = join(agentDir, "workgraph", "workstreams", "invalid");
    await mkdir(invalidDir, { recursive: true });
    await writeFile(join(invalidDir, "workstream.sqlite"), "not sqlite");

    const defaults = WorkstreamStore.discover(agentDir, false, 0, 10);
    assert.deepEqual(
      defaults.items.map((item) => item.workstreamId),
      ["active-old"],
    );
    assert.deepEqual(
      defaults.errors.map((item) => item.workstreamId),
      ["invalid"],
    );
    const all = WorkstreamStore.discover(agentDir, true, 0, 1);
    assert.deepEqual(
      all.items.map((item) => item.workstreamId),
      ["completed-new"],
    );
    assert.equal(all.nextOffset, 1);

    await assert.rejects(
      f.call("workgraph_adopt", { workstreamId: "active-old" }),
      /Herdr runtime is unavailable/,
    );
    const blocked = WorkstreamStore.openReadOnly(agentDir, "active-old");
    assert.deepEqual(blocked.readMetadata().owner, owner);
    blocked.close();
  } finally {
    await f.dispose();
  }
});
