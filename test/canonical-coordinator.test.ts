/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-runtime-typeof -- This supported-boundary fixture inspects Pi session entries and native SQLite rows after their production schemas have accepted and persisted them. */
import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The integration fixture owns real temporary Git and SQLite filesystem resources.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native fixture paths identify real temporary repositories.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ExtensionActions, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Value } from "typebox/value";
import canonicalCoordinator from "../extensions/canonical-coordinator.js";
import { CANONICAL_POINTER_ENTRY } from "../src/canonical-coordinator-controller.js";
import { CanonicalWorkstreamStore } from "../src/canonical-workstream-store.js";
import { createWorkstream } from "../src/domain/workstream.js";
import { HerdrCliRuntime } from "../src/herdr.js";
import { liveLayer } from "../src/node-platform.js";
import { configureFixtureEnvironment, restoreFixtureEnvironment } from "./decoders.js";
import { extensionFixture, git } from "./helpers.js";

const TARGET_TOOLS = [
  "workgraph_models",
  "workgraph_intent",
  "workgraph_research",
  "workgraph_consult",
  "workgraph_implement",
  "workgraph_review",
  "workgraph_attempt",
  "workgraph_inspect",
  "workgraph_control",
  "workgraph_adopt",
  "workgraph_complete",
  "workgraph_notepad",
] as const;

async function fixture(
  actions: Partial<ExtensionActions> = {},
  extensionFactories: InlineExtension[] = [canonicalCoordinator],
) {
  const parent = await mkdtemp(join(tmpdir(), "canonical-coordinator-"));
  const root = join(parent, "repo");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "fixture@example.test");
  await git(root, "config", "user.name", "Fixture");
  await writeFile(join(root, "tracked.txt"), "fixture\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  const previous = configureFixtureEnvironment({
    PI_WORKGRAPH_MODE: null,
    PI_CODING_AGENT_DIR: join(parent, "agent"),
  });
  const pi = await extensionFixture("coordinator", root, parent, actions, extensionFactories);
  return {
    ...pi,
    root,
    parent,
    async dispose() {
      await pi.close();
      restoreFixtureEnvironment(previous);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

void test("staged factory registers only canonical tools in coordinator scope", async () => {
  const f = await fixture();
  try {
    for (const name of TARGET_TOOLS)
      assert.ok(f.runner.getToolDefinition(name) !== undefined, `missing ${name}`);
    assert.equal(f.runner.getToolDefinition("workgraph_handoff"), undefined);
    assert.equal(f.runner.getToolDefinition("workgraph_fork"), undefined);
  } finally {
    await f.dispose();
  }
});

void test("canonical tool schemas expose release_output and every runtime facade returns a Promise without an attachment", async () => {
  const f = await fixture();
  try {
    const control = f.runner.getToolDefinition("workgraph_control");
    assert.ok(control !== undefined);
    assert.equal(
      Value.Check(control.parameters, {
        action: "release_output",
        attempt: "attempt-1",
        reason: "retire exact output",
      }),
      true,
    );
    assert.equal(
      Value.Check(control.parameters, {
        action: "release",
        attempt: "attempt-1",
        reason: "retire exact output",
      }),
      false,
    );
    assert.equal(Value.Check(control.parameters, { action: "suspend", reason: "   " }), false);

    const calls: Array<[string, object]> = [
      ["workgraph_research", { id: "r", question: "q", expectedEvidence: ["e"] }],
      ["workgraph_consult", { id: "c", question: "q" }],
      ["workgraph_implement", { id: "i", objective: "o", acceptance: ["a"] }],
      [
        "workgraph_review",
        {
          id: "v",
          objective: "o",
          concern: "c",
          subject: { kind: "revision", revision: "a".repeat(40) },
        },
      ],
      ["workgraph_attempt", { task: "t" }],
      ["workgraph_control", { action: "resume", reason: "continue" }],
      ["workgraph_complete", { conclusion: "done", evidence: [{ label: "e", observation: "o" }] }],
    ];
    for (const [name, params] of calls) {
      const tool = f.runner.getToolDefinition(name);
      assert.ok(tool !== undefined && Value.Check(tool.parameters, params));
      const result = tool.execute(
        "promise-check",
        Value.Decode(tool.parameters, params),
        undefined,
        undefined,
        f.runner.createContext(),
      );
      assert.ok(result instanceof Promise, `${name} must return a Promise`);
      await assert.rejects(result, /No canonical Workstream is attached/);
    }
  } finally {
    await f.dispose();
  }
});

void test("session_start closes the attached runtime before rejecting a different malformed pointer", async () => {
  const f = await fixture();
  try {
    await f.input("Create the original Workstream");
    await f.call("workgraph_intent", { statement: "Create the original Workstream" });
    const originalPointer = f.session
      .getBranch()
      .findLast((entry) => entry.type === "custom" && entry.customType === CANONICAL_POINTER_ENTRY);
    assert.ok(originalPointer?.type === "custom");
    const originalPath = (originalPointer.data as { path: string }).path;
    const original = await Effect.runPromise(
      Effect.scoped(CanonicalWorkstreamStore.discover(originalPath)).pipe(
        Effect.provide(liveLayer),
      ),
    );
    const intent = original.state.intents[0];
    assert.ok(intent !== undefined);
    const targetState = createWorkstream({
      id: "malformed-target",
      purpose: "Must remain untouched",
      repository: original.state.repository,
      coordinator: original.state.coordinator,
      intent,
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    const target = await Effect.runPromise(
      Effect.scoped(CanonicalWorkstreamStore.create(targetState)).pipe(Effect.provide(liveLayer)),
    );
    const targetBefore = await readFile(target.store.path);
    const originalStateBefore = original.state;

    f.session.appendCustomEntry(CANONICAL_POINTER_ENTRY, {
      version: 1,
      phase: "attached",
      path: target.store.path,
      workstreamId: targetState.id,
    });
    await f.runner.emit({ type: "session_start", reason: "reload" });

    await assert.rejects(
      f.call("workgraph_inspect", { section: "overview" }),
      /No canonical Workstream is attached/,
    );
    const database = new DatabaseSync(originalPath, { readOnly: true });
    const lease = database.prepare("SELECT token FROM lease WHERE singleton=1").get();
    const row = database.prepare("SELECT state_json FROM workstream WHERE singleton=1").get() as {
      state_json: string;
    };
    database.close();
    assert.equal(lease, undefined);
    assert.deepEqual(JSON.parse(row.state_json), originalStateBefore);
    assert.deepEqual(await readFile(target.store.path), targetBefore);

    await f.input("Do not create another Workstream");
    await assert.rejects(
      f.call("workgraph_intent", { statement: "Do not create another Workstream" }),
      /retained canonical pointer/,
    );
    assert.equal(
      f.session
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === CANONICAL_POINTER_ENTRY)
        .length,
      3,
    );
  } finally {
    await f.dispose();
  }
});

void test("prepared pointer append failure creates no canonical store", async () => {
  let session: Awaited<ReturnType<typeof extensionFixture>>["session"] | undefined;
  let pointerAppends = 0;
  const f = await fixture({
    appendEntry(type, data) {
      session?.appendCustomEntry(type, data);
      if (type === CANONICAL_POINTER_ENTRY) {
        pointerAppends += 1;
        throw new Error("pointer append failed");
      }
    },
  });
  session = f.session;
  try {
    await f.input("Do not persist without the declaration");
    await assert.rejects(
      f.call("workgraph_intent", { statement: "Do not persist without the declaration" }),
      /pointer append failed/,
    );
    await assert.rejects(readdir(join(f.root, ".git", "pi-workgraph")), /ENOENT/);

    await f.input("Do not create a second Workstream");
    await assert.rejects(
      f.call("workgraph_intent", { statement: "Do not create a second Workstream" }),
      /retained canonical pointer/,
    );
    assert.equal(pointerAppends, 1);
    const pointers = f.session
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === CANONICAL_POINTER_ENTRY);
    assert.equal(pointers.length, 1);
    assert.ok(pointers[0]?.type === "custom");
    assert.equal((pointers[0].data as { phase?: unknown }).phase, "prepared");
    await assert.rejects(readdir(join(f.root, ".git", "pi-workgraph")), /ENOENT/);
  } finally {
    await f.dispose();
  }
});

void test("repository proof rejects a crafted aggregate before lease or pointer effects", async () => {
  const f = await fixture();
  try {
    const foreignRoot = join(f.parent, "not-a-repository");
    await mkdir(foreignRoot);
    const ctx = f.runner.createContext();
    const sessionFile = ctx.sessionManager.getSessionFile();
    assert.ok(sessionFile !== undefined);
    const repository = { projectRoot: foreignRoot, gitCommonDir: join(f.root, ".git") };
    const initial = createWorkstream({
      id: "crafted-repository",
      purpose: "Must not attach",
      repository,
      coordinator: { sessionId: ctx.sessionManager.getSessionId(), sessionFile },
      intent: {
        statement: "Must not attach",
        constraints: [],
        grounding: {
          kind: "human_input_receipt",
          id: "receipt",
          sessionId: ctx.sessionManager.getSessionId(),
          sessionFile,
          source: "interactive",
          text: "Must not attach",
          receivedAt: "2024-01-01T00:00:00.000Z",
        },
        recordedAt: "2024-01-01T00:00:00.000Z",
      },
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    const attachment = await Effect.runPromise(
      Effect.scoped(CanonicalWorkstreamStore.create(initial)).pipe(Effect.provide(liveLayer)),
    );
    f.session.appendCustomEntry(CANONICAL_POINTER_ENTRY, {
      version: 1,
      phase: "attached",
      path: attachment.store.path,
      workstreamId: initial.id,
      repository,
    });
    const before = await readFile(attachment.store.path);
    await f.runner.emit({ type: "session_start", reason: "reload" });
    assert.deepEqual(await readFile(attachment.store.path), before);
    const database = new DatabaseSync(attachment.store.path, { readOnly: true });
    assert.equal(database.prepare("SELECT token FROM lease").get(), undefined);
    database.close();
    assert.equal(
      f.session
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === CANONICAL_POINTER_ENTRY)
        .length,
      1,
    );
  } finally {
    await f.dispose();
  }
});

void test("genuine Pi input creates one receipt-grounded private canonical Workstream", async () => {
  const f = await fixture();
  try {
    await f.input("Build the canonical target", "interactive");
    await f.call("workgraph_intent", {
      statement: "Build the canonical target",
      constraints: ["Keep the predecessor loaded"],
    });
    const branch = f.session.getBranch();
    const receipts = branch.filter(
      (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-human-input",
    );
    assert.equal(receipts.length, 1);
    const receipt = receipts[0];
    assert.ok(receipt?.type === "custom");
    assert.equal(typeof (receipt.data as { receivedAt?: unknown }).receivedAt, "string");
    const pointers = branch.filter(
      (entry) => entry.type === "custom" && entry.customType === CANONICAL_POINTER_ENTRY,
    );
    assert.equal(pointers.length, 2);
    const prepared = pointers[0];
    const attached = pointers[1];
    assert.ok(prepared?.type === "custom" && attached?.type === "custom");
    assert.equal((prepared.data as { phase: string }).phase, "prepared");
    assert.equal((attached.data as { phase: string }).phase, "attached");
    const path = (attached.data as { path: string }).path;
    const database = new DatabaseSync(path, { readOnly: true });
    const row = database.prepare("SELECT state_json FROM workstream WHERE singleton=1").get() as {
      state_json: string;
    };
    const lease = database.prepare("SELECT owner_session_id FROM lease WHERE singleton=1").get();
    database.close();
    const state = JSON.parse(row.state_json) as {
      intents: Array<{ grounding: { id: string; receivedAt: string } }>;
    };
    assert.equal(state.intents.length, 1);
    assert.equal(state.intents[0]?.grounding.id, (receipt.data as { id: string }).id);
    assert.equal(
      state.intents[0]?.grounding.receivedAt,
      (receipt.data as { receivedAt: string }).receivedAt,
    );
    assert.ok(lease !== undefined);
    const discovered = await Effect.runPromise(
      Effect.scoped(CanonicalWorkstreamStore.discover(path)).pipe(Effect.provide(liveLayer)),
    );
    assert.equal(discovered.state.intents.length, 1);

    await f.runner.emit({ type: "session_shutdown", reason: "reload" });
    f.session.appendCustomEntry(CANONICAL_POINTER_ENTRY, structuredClone(prepared.data));
    await f.runner.emit({ type: "session_start", reason: "reload" });
    const replayed = f.session
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === CANONICAL_POINTER_ENTRY);
    assert.equal(replayed.length, 4);
    const replayAttachment = replayed.at(-1);
    assert.ok(replayAttachment?.type === "custom");
    assert.equal((replayAttachment.data as { phase: string }).phase, "attached");
    assert.equal((replayAttachment.data as { path: string }).path, path);
  } finally {
    await f.dispose();
  }
});

void test("prepared adoption replays an already-committed exact transfer once", async () => {
  const source = await fixture();
  let successor: Awaited<ReturnType<typeof extensionFixture>> | undefined;
  try {
    await source.input("Create an adoptable Workstream");
    await source.call("workgraph_intent", { statement: "Create an adoptable Workstream" });
    const pointer = source.session
      .getBranch()
      .findLast((entry) => entry.type === "custom" && entry.customType === CANONICAL_POINTER_ENTRY);
    assert.ok(pointer?.type === "custom");
    const statePath = (pointer.data as { path: string }).path;
    await source.runner.emit({ type: "session_shutdown", reason: "reload" });

    const successorParent = join(source.parent, "successor");
    await mkdir(successorParent);
    Reflect.set(process.env, "PI_CODING_AGENT_DIR", join(successorParent, "agent"));
    let successorSession: Awaited<ReturnType<typeof extensionFixture>>["session"] | undefined;
    let interruptAttached = true;
    const workers = new HerdrCliRuntime("unused", {});
    Object.defineProperty(workers, "coordinatorLiveness", {
      value: () => Effect.succeed("dead" as const),
    });
    successor = await extensionFixture(
      "coordinator",
      source.root,
      successorParent,
      {
        appendEntry(type, data) {
          if (type === CANONICAL_POINTER_ENTRY) {
            const phase = (data as { phase?: unknown }).phase;
            if (phase === "attached" && interruptAttached) {
              interruptAttached = false;
              throw new Error("interrupt after transfer");
            }
          }
          successorSession?.appendCustomEntry(type, data);
        },
      },
      [(pi) => canonicalCoordinator(pi, { workers: () => workers })],
    );
    successorSession = successor.session;
    await assert.rejects(
      successor.call("workgraph_adopt", { statePath }),
      /interrupt after transfer/,
    );
    await successor.runner.emit({ type: "session_shutdown", reason: "reload" });
    await successor.runner.emit({ type: "session_start", reason: "reload" });
    const discovered = await Effect.runPromise(
      Effect.scoped(CanonicalWorkstreamStore.discover(statePath)).pipe(Effect.provide(liveLayer)),
    );
    assert.equal(discovered.state.coordinatorTransfers.length, 1);
    const retainedPointers = successor.session
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === CANONICAL_POINTER_ENTRY);
    assert.deepEqual(
      retainedPointers.map((entry) =>
        entry.type === "custom" ? (entry.data as { phase: string }).phase : "invalid",
      ),
      ["prepared", "attached"],
    );
  } finally {
    if (successor !== undefined) await successor.close();
    await source.dispose();
  }
});

void test("intent revision selects the latest eligible receipt and rejects repository switching before mutation", async () => {
  const f = await fixture();
  try {
    await f.input("Initial scope");
    await f.call("workgraph_intent", { statement: "Initial scope" });
    await f.input("Revised scope", "rpc");
    await f.call("workgraph_intent", { statement: "Revised scope" });
    const pointer = f.session
      .getBranch()
      .findLast((entry) => entry.type === "custom" && entry.customType === CANONICAL_POINTER_ENTRY);
    assert.ok(pointer?.type === "custom");
    const path = (pointer.data as { path: string }).path;
    const readState = () => {
      const database = new DatabaseSync(path, { readOnly: true });
      const row = database.prepare("SELECT state_json FROM workstream WHERE singleton=1").get() as {
        state_json: string;
      };
      database.close();
      return JSON.parse(row.state_json) as {
        revision: number;
        intents: Array<{ statement: string; grounding: { text: string; source: string } }>;
      };
    };
    const revised = readState();
    assert.equal(revised.revision, 1);
    assert.equal(revised.intents[1]?.grounding.text, "Revised scope");
    assert.equal(revised.intents[1]?.grounding.source, "rpc");

    const foreign = join(f.parent, "foreign");
    await mkdir(foreign);
    await git(foreign, "init", "-b", "main");
    await git(foreign, "config", "user.email", "fixture@example.test");
    await git(foreign, "config", "user.name", "Fixture");
    await writeFile(join(foreign, "foreign.txt"), "foreign\n");
    await git(foreign, "add", ".");
    await git(foreign, "commit", "-m", "foreign");
    await assert.rejects(
      f.call("workgraph_intent", {
        statement: "Do not retarget",
        targetRepository: foreign,
      }),
      /cannot switch repositories/,
    );
    assert.equal(readState().revision, 1);
  } finally {
    await f.dispose();
  }
});

void test("missing receipt rejects before canonical storage or pointer creation", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.call("workgraph_intent", { statement: "Unauthorized" }),
      /eligible current-session human input receipt/,
    );
    assert.equal(
      f.session
        .getBranch()
        .some((entry) => entry.type === "custom" && entry.customType === CANONICAL_POINTER_ENTRY),
      false,
    );
  } finally {
    await f.dispose();
  }
});
