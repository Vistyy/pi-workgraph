import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import { installNotepad } from "../../src/coordinator/notepad.js";
import { extensionFixture } from "../support/helpers.js";

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-notepad-"));
  const root = join(parent, "repo");
  await mkdir(root);
  const pi = await extensionFixture("coordinator", root, parent, {}, [installNotepad]);

  return {
    ...pi,
    parent,
    async dispose() {
      await pi.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

void test("workgraph_notepad has only the strict bounded action shapes", async () => {
  const f = await fixture();

  try {
    const tool = f.runner.getToolDefinition("workgraph_notepad");
    assert.ok(tool !== undefined);
    assert.equal(Value.Check(tool.parameters, { action: "read" }), true);
    assert.equal(Value.Check(tool.parameters, { action: "clear" }), true);
    assert.equal(
      Value.Check(tool.parameters, { action: "replace", text: "x".repeat(4_000) }),
      true,
    );

    assert.equal(Value.Check(tool.parameters, { action: "read", text: "extra" }), false);
    assert.equal(Value.Check(tool.parameters, { action: "clear", id: "old" }), false);
    assert.equal(Value.Check(tool.parameters, { action: "replace" }), false);
    assert.equal(Value.Check(tool.parameters, { action: "replace", text: "" }), false);
    assert.equal(
      Value.Check(tool.parameters, { action: "replace", text: "x".repeat(4_001) }),
      false,
    );
    assert.equal(Value.Check(tool.parameters, { action: "list" }), false);
  } finally {
    await f.dispose();
  }
});

void test("latest replacements and clears are branch-local and mutation results do not disclose text", async () => {
  const f = await fixture();

  try {
    const firstText = "first private memo";

    const firstResult = await f.call("workgraph_notepad", {
      action: "replace",
      text: firstText,
    });

    assert.equal(JSON.stringify(firstResult).includes(firstText), false);
    const firstLeaf = f.session.getLeafId();
    assert.ok(firstLeaf !== null);
    const firstEntry = f.session.getEntry(firstLeaf);
    assert.ok(firstEntry?.type === "custom");
    assert.equal(firstEntry.customType, "pi-workgraph-notepad");
    assert.deepEqual(firstEntry.data, { text: firstText });

    const secondText = "alternate private memo";

    const secondResult = await f.call("workgraph_notepad", {
      action: "replace",
      text: secondText,
    });

    assert.equal(JSON.stringify(secondResult).includes(secondText), false);
    const secondLeaf = f.session.getLeafId();
    assert.ok(secondLeaf !== null);

    f.session.branch(firstLeaf);
    const firstRead = await f.call("workgraph_notepad", { action: "read" });
    assert.deepEqual(firstRead.details, { text: firstText });
    assert.equal(
      firstRead.content[0]?.type === "text" ? firstRead.content[0].text : undefined,
      firstText,
    );

    const clearResult = await f.call("workgraph_notepad", { action: "clear" });
    assert.equal(JSON.stringify(clearResult).includes(firstText), false);
    assert.deepEqual(clearResult.details, {});
    const clearLeaf = f.session.getLeafId();
    assert.ok(clearLeaf !== null);
    const clearEntry = f.session.getEntry(clearLeaf);
    assert.ok(clearEntry?.type === "custom");
    assert.deepEqual(clearEntry.data, { text: "" });
    assert.deepEqual((await f.call("workgraph_notepad", { action: "read" })).details, { text: "" });

    f.session.branch(secondLeaf);
    assert.deepEqual((await f.call("workgraph_notepad", { action: "read" })).details, {
      text: secondText,
    });
    assert.equal(f.messages.length, 0);
  } finally {
    await f.dispose();
  }
});

void test("only successful compaction recovers one nonempty current-branch memo", async () => {
  const f = await fixture();

  try {
    const text = "recover this memo";
    await f.call("workgraph_notepad", { action: "replace", text });

    await f.runner.emit({ type: "session_start", reason: "reload" });
    await f.runner.emit({
      type: "session_tree",
      oldLeafId: f.session.getLeafId(),
      newLeafId: f.session.getLeafId(),
    });
    assert.equal(f.messages.length, 0);

    const firstKeptEntryId = f.session.getBranch()[0]?.id;
    assert.ok(firstKeptEntryId !== undefined);
    const compactionId = f.session.appendCompaction("fixture summary", firstKeptEntryId, 10);
    const compactionEntry = f.session.getEntry(compactionId);
    assert.ok(compactionEntry?.type === "compaction");
    await f.runner.emit({
      type: "session_compact",
      compactionEntry,
      fromExtension: false,
      reason: "manual",
      willRetry: false,
    });
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0]?.display, false);
    assert.equal(f.messages[0]?.content, `Current Workgraph notepad:\n${text}`);

    await f.call("workgraph_notepad", { action: "clear" });
    const emptyCompactionId = f.session.appendCompaction("empty summary", firstKeptEntryId, 10);
    const emptyCompactionEntry = f.session.getEntry(emptyCompactionId);
    assert.ok(emptyCompactionEntry?.type === "compaction");
    await f.runner.emit({
      type: "session_compact",
      compactionEntry: emptyCompactionEntry,
      fromExtension: false,
      reason: "threshold",
      willRetry: false,
    });
    assert.equal(f.messages.length, 1);
  } finally {
    await f.dispose();
  }
});
