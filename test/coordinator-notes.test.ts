import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises"; // oxlint-disable-line effecttsgo/node-builtin-import -- The fixture uses real isolated session storage.
import { tmpdir } from "node:os";
import { join } from "node:path"; // oxlint-disable-line effecttsgo/node-builtin-import -- The fixture path is an isolated session/repository identity.
import test from "node:test";
import { Type } from "typebox";
import {
  configureFixtureEnvironment,
  decodeTestValue,
  restoreFixtureEnvironment,
} from "./decoders.js";
import { extensionFixture } from "./helpers.js";

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-notepad-"));
  const root = join(parent, "repo");
  await mkdir(root);
  const previous = configureFixtureEnvironment({
    PI_CODING_AGENT_DIR: join(parent, "agent"),
    PI_WORKGRAPH_MODE: null,
    HERDR_ENV: null,
    HERDR_WORKSPACE_ID: null,
  });
  const pi = await extensionFixture("coordinator", root, parent);
  return {
    ...pi,
    async dispose() {
      await pi.close();
      restoreFixtureEnvironment(previous);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

const NotepadDetailsSchema = Type.Object({
  notepad: Type.Object({
    version: Type.Literal(2),
    items: Type.Array(Type.Object({ id: Type.String(), text: Type.String() })),
  }),
});

async function reminderText(f: Awaited<ReturnType<typeof fixture>>): Promise<string | undefined> {
  const result = await f.runner.emitBeforeAgentStart("next", undefined, "Fixture", {
    cwd: f.session.getCwd(),
  });
  const message = result?.messages?.find(
    (candidate) => candidate.customType === "pi-workgraph-coordinator-notepad",
  );
  if (message === undefined) return undefined;
  return Array.isArray(message.content)
    ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
    : message.content;
}

void test("coordinator exposes only the read/add/update/remove notepad and edits need no receipt", async () => {
  const f = await fixture();
  try {
    await f.runner.emit({ type: "session_start", reason: "startup" });
    assert.ok(f.runner.getToolDefinition("workgraph_notepad"));
    assert.equal(f.runner.getToolDefinition("workgraph_note"), undefined);

    let response = await f.call("workgraph_notepad", { action: "read" });
    assert.deepEqual(decodeTestValue(NotepadDetailsSchema, response.details).notepad.items, []);
    await f.call("workgraph_notepad", { action: "add", id: "check", text: "Verify later." });
    response = await f.call("workgraph_notepad", {
      action: "update",
      id: "check",
      text: "Verify the exact result later.",
    });
    assert.deepEqual(decodeTestValue(NotepadDetailsSchema, response.details).notepad.items, [
      { id: "check", text: "Verify the exact result later." },
    ]);
    response = await f.call("workgraph_notepad", { action: "remove", id: "check" });
    assert.deepEqual(decodeTestValue(NotepadDetailsSchema, response.details).notepad.items, []);
    await assert.rejects(
      f.call("workgraph_notepad", { action: "remove", id: "missing" }),
      /Unknown pending item/,
    );
  } finally {
    await f.dispose();
  }
});

void test("notepad stays on demand during ordinary turns and restores only nonempty state after compaction", async () => {
  const f = await fixture();
  try {
    await f.runner.emit({ type: "session_start", reason: "startup" });
    assert.equal(await reminderText(f), undefined);
    await f.call("workgraph_notepad", { action: "add", id: "later", text: "Follow up." });
    assert.equal(await reminderText(f), undefined);
    assert.equal(f.messages.length, 0);

    await f.runner.emit({ type: "session_shutdown", reason: "reload" });
    await f.runner.emit({ type: "session_start", reason: "reload" });
    assert.equal(await reminderText(f), undefined);
    const restored = await f.call("workgraph_notepad", { action: "read" });
    assert.deepEqual(decodeTestValue(NotepadDetailsSchema, restored.details).notepad.items, [
      { id: "later", text: "Follow up." },
    ]);

    const kept = f.session.appendMessage({
      role: "user",
      content: "A later request",
      // oxlint-disable-next-line effecttsgo/global-date -- Pi session fixture requires a current native timestamp.
      timestamp: Date.now(),
    });
    f.session.appendCompaction("Compacted", kept, 100);
    const compaction = f.session.getLeafEntry();
    assert.ok(compaction?.type === "compaction");
    await f.runner.emit({
      type: "session_compact",
      compactionEntry: compaction,
      fromExtension: false,
      reason: "manual",
      willRetry: false,
    });
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0]?.customType, "pi-workgraph-coordinator-notepad");
    const content = f.messages[0]?.content;
    const text = Array.isArray(content)
      ? content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
      : content;
    assert.match(text ?? "", /^\[WORKGRAPH PENDING ITEMS\]/);
    assert.match(text ?? "", /later: Follow up\./);

    f.session.appendCustomMessageEntry("pi-workgraph-coordinator-notepad", text ?? "", false);
    await f.runner.emit({
      type: "session_compact",
      compactionEntry: compaction,
      fromExtension: false,
      reason: "manual",
      willRetry: false,
    });
    assert.equal(f.messages.length, 1);

    await f.call("workgraph_notepad", { action: "remove", id: "later" });
    await f.runner.emit({
      type: "session_compact",
      compactionEntry: compaction,
      fromExtension: false,
      reason: "manual",
      willRetry: false,
    });
    assert.equal(f.messages.length, 1);
  } finally {
    await f.dispose();
  }
});

void test("legacy pending note substance migrates once without restoring ledger state", async () => {
  const f = await fixture();
  try {
    f.session.appendCustomEntry("pi-workgraph-coordinator-note-state", {
      version: 1,
      notes: [
        {
          id: "pending",
          summary: "Keep this pending substance.",
          status: "pending",
          presentations: [],
        },
        { id: "done", summary: "Do not restore this.", status: "resolved", presentations: [] },
      ],
      drafts: [
        {
          operation: "record",
          id: "draft-only",
          summary: "Not presented; do not restore.",
          toolCallId: "old-call",
          supersedes: [],
        },
      ],
    });
    await f.runner.emit({ type: "session_start", reason: "startup" });
    const response = await f.call("workgraph_notepad", { action: "read" });
    assert.deepEqual(decodeTestValue(NotepadDetailsSchema, response.details).notepad.items, [
      { id: "pending", text: "Keep this pending substance." },
    ]);
    assert.equal(
      f.session
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "pi-workgraph-coordinator-notepad-state",
        ).length,
      1,
    );
  } finally {
    await f.dispose();
  }
});
