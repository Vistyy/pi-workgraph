import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The native SessionManager fixture owns removal of its exact default-directory child session file.
import { rm } from "node:fs/promises";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  deterministicChildSessionId,
  HANDOFF_CONTEXT_ENTRY,
  HANDOFF_GRANT_ENTRY,
  HANDOFF_SEAL_ENTRY,
  prepareHandoffSession,
  priorDiscussion,
} from "../src/handoff-session.js";
import { liveLayer } from "../src/node-platform.js";
import { usage } from "./helpers.js";

const repository = { projectRoot: "/tmp/handoff-target", gitCommonDir: "/tmp/handoff-target/.git" };
const receipt = {
  kind: "human_input_receipt" as const,
  id: "receipt",
  sessionId: "parent-session",
  sessionFile: "/parent.jsonl",
  source: "interactive" as const,
  text: "Parent request",
  receivedAt: "2026-01-01T00:00:00.000Z",
};
const grant = {
  kind: "handoff_grant" as const,
  id: "grant-session-flow",
  parentReceipt: receipt,
  parentWorkstreamId: "parent-workstream",
  parentRepository: repository,
  parentIntentIndex: 0,
  parentIntentStatement: "Parent request",
  parentIntentConstraints: ["Stay bounded"],
  narrowedRequest: "Do one focused part",
  targetRepository: repository,
  issuedAt: "2026-01-01T00:00:01.000Z",
};

void test("handoff discussion forks before the invoking call and excludes Workgraph-owned content", () => {
  const parent = SessionManager.inMemory();
  parent.appendMessage({ role: "user", content: "Useful prior discussion", timestamp: 1 });
  parent.appendCustomMessageEntry("pi-workgraph-attention", "owned", false);
  parent.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Useful answer" }],
    api: "test",
    provider: "test",
    model: "fixture",
    usage,
    stopReason: "stop",
    timestamp: 2,
  });
  parent.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "handoff-call",
        name: "workgraph_handoff",
        arguments: { request: "x" },
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
  assert.match(JSON.stringify(discussion), /Useful prior discussion/);
  assert.match(JSON.stringify(discussion), /Useful answer/);
  assert.doesNotMatch(JSON.stringify(discussion), /owned|workgraph_handoff|handoff-call/);
});

void test("deterministic child session has no parent pointer, replays exactly, and seals optional context", async () => {
  const childSessionId = deterministicChildSessionId(grant.id);
  const discussion = [
    { role: "user" as const, content: "Non-authoritative context", timestamp: 1 },
  ];
  const first = await Effect.runPromise(
    prepareHandoffSession(repository.projectRoot, childSessionId, grant, discussion).pipe(
      Effect.provide(liveLayer),
    ),
  );
  try {
    const replay = await Effect.runPromise(
      prepareHandoffSession(repository.projectRoot, childSessionId, grant, discussion).pipe(
        Effect.provide(liveLayer),
      ),
    );
    assert.equal(replay.sessionFile, first.sessionFile);
    const child = SessionManager.open(first.sessionFile);
    assert.equal(child.getHeader()?.id, childSessionId);
    assert.equal(child.getHeader()?.parentSession, undefined);
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
    const seal = branch.at(-1);
    assert.equal(seal?.type, "custom");
    assert.equal(seal?.type === "custom" ? seal.customType : undefined, HANDOFF_SEAL_ENTRY);
    await assert.rejects(
      Effect.runPromise(
        prepareHandoffSession(
          repository.projectRoot,
          childSessionId,
          { ...grant, narrowedRequest: "conflict" },
          discussion,
        ).pipe(Effect.provide(liveLayer)),
      ),
      /malformed, truncated, or conflicts/,
    );
  } finally {
    await rm(first.sessionFile, { force: true });
  }
});
