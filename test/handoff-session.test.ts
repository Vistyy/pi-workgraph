import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The fixture removes only the exact fresh child session file it creates.
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  HANDOFF_CONTEXT_ENTRY,
  HANDOFF_GRANT_ENTRY,
  HANDOFF_SEAL_ENTRY,
  prepareHandoffSession,
  priorDiscussion,
  sealedHandoffGrant,
} from "../src/handoff-session.js";
import { usage } from "./helpers.js";

const repository = { projectRoot: "/tmp/handoff-target", gitCommonDir: "/tmp/handoff-target/.git" };
const grant = {
  kind: "handoff_grant" as const,
  id: "grant-session-flow",
  parentReceipt: {
    kind: "human_input_receipt" as const,
    id: "receipt",
    sessionId: "parent-session",
    sessionFile: "/parent.jsonl",
    source: "interactive" as const,
    text: "Parent request",
    receivedAt: "2026-01-01T00:00:00.000Z",
  },
  parentWorkstreamId: "parent-workstream",
  parentRepository: repository,
  parentIntentIndex: 0,
  parentIntentStatement: "Parent request",
  parentIntentConstraints: ["Stay bounded"],
  narrowedRequest: "Do one focused part",
  targetRepository: repository,
  issuedAt: "2026-01-01T00:00:01.000Z",
};

void test("handoff discussion ends before the invoking call and excludes Workgraph-owned content", () => {
  const parent = SessionManager.inMemory();
  parent.appendMessage({ role: "user", content: "Useful prior discussion", timestamp: 1 });
  parent.appendCustomMessageEntry("pi-workgraph-attention", "owned", false);
  const kept = parent.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Useful answer" }],
    api: "test",
    provider: "test",
    model: "fixture",
    usage,
    stopReason: "stop",
    timestamp: 2,
  });
  parent.appendCompaction("Compacted discussion", kept, 10);
  parent.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "handoff-call",
        name: "workgraph_handoff",
        arguments: { request: "x", includeContext: true },
      },
    ],
    api: "test",
    provider: "test",
    model: "fixture",
    usage,
    stopReason: "toolUse",
    timestamp: 3,
  });
  const discussion = priorDiscussion(parent, "handoff-call");
  assert.match(JSON.stringify(discussion), /Compacted discussion/);
  assert.match(JSON.stringify(discussion), /Useful answer/);
  assert.doesNotMatch(JSON.stringify(discussion), /Useful prior discussion/);
  assert.doesNotMatch(JSON.stringify(discussion), /owned|workgraph_handoff|handoff-call/);
});

void test("each prepared Handoff uses one fresh parentless Pi session and seals optional context", async () => {
  const discussion = [
    { role: "user" as const, content: "Non-authoritative context", timestamp: 1 },
  ];
  const first = await Effect.runPromise(
    prepareHandoffSession(repository.projectRoot, grant, discussion),
  );
  const second = await Effect.runPromise(
    prepareHandoffSession(repository.projectRoot, { ...grant, id: "grant-second" }, []),
  );
  try {
    assert.notEqual(first.childSessionId, second.childSessionId);
    assert.notEqual(first.sessionFile, second.sessionFile);
    const child = SessionManager.open(first.sessionFile);
    assert.equal(child.getHeader()?.parentSession, undefined);
    assert.equal(child.getHeader()?.cwd, repository.projectRoot);
    assert.deepEqual(sealedHandoffGrant(child), grant);
    const branch = child.getBranch();
    assert.equal(
      branch.filter((entry) => entry.type === "custom" && entry.customType === HANDOFF_GRANT_ENTRY)
        .length,
      1,
    );
    assert.equal(
      branch.filter(
        (entry) => entry.type === "custom_message" && entry.customType === HANDOFF_CONTEXT_ENTRY,
      ).length,
      1,
    );
    assert.equal(
      branch.filter((entry) => entry.type === "custom" && entry.customType === HANDOFF_SEAL_ENTRY)
        .length,
      1,
    );
    assert.match(await readFile(first.sessionFile, "utf8"), /NON-AUTHORITATIVE PRIOR DISCUSSION/);
    assert.equal(
      SessionManager.open(second.sessionFile)
        .getBranch()
        .some(
          (entry) => entry.type === "custom_message" && entry.customType === HANDOFF_CONTEXT_ENTRY,
        ),
      false,
    );
  } finally {
    await rm(first.sessionFile, { force: true });
    await rm(second.sessionFile, { force: true });
  }
});
