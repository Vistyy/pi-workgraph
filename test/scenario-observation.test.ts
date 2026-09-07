import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  observeCoordinatorTurn,
  observeDirectEffect,
  observeIsolatedGitResourceAbsence,
} from "../scripts/live/scenario-observation.js";
import { usage } from "./helpers.js";

const request = "Inspect the fixture.";
const fixtureTimestamp = 1_788_235_200_000;

function settledAssistant(session: SessionManager, text = "Completed.") {
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "fixture",
    usage,
    stopReason: "stop",
    timestamp: fixtureTimestamp,
  });
}

function failedAssistant(session: SessionManager, stopReason: "error" | "aborted" | "length") {
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Unable to continue." }],
    api: "test",
    provider: "test",
    model: "fixture",
    usage,
    stopReason,
    timestamp: fixtureTimestamp,
  });
}

void test("direct native outcome accepts the authorized tracked edit and rejects untracked effects", () => {
  const before = new Map([
    ["README.md", "cmVhZG1l"],
    ["value.txt", "YmVmb3JlCg=="],
  ]);
  const after = new Map([
    ["README.md", "cmVhZG1l"],
    ["value.txt", "YWZ0ZXIK"],
  ]);
  const direct = observeDirectEffect(before, after, "YWZ0ZXIK");
  assert.equal(direct.valid, true);
  assert.deepEqual(direct.changedPaths, ["value.txt"]);

  const withScratch = new Map(after).set("probe.txt", "c2NyYXRjaA==");
  const rejected = observeDirectEffect(before, withScratch, "YWZ0ZXIK");
  assert.equal(rejected.valid, false);
  assert.deepEqual(rejected.changedPaths, ["probe.txt", "value.txt"]);
});

void test("isolated Git cleanup requires exact worktree path and branch absence", () => {
  const placement = { path: "/tmp/exact-worktree", branch: "pi-workgraph/run/attempt" };
  assert.equal(
    observeIsolatedGitResourceAbsence([placement], "worktree /tmp/root", "").valid,
    true,
  );
  assert.equal(
    observeIsolatedGitResourceAbsence(
      [placement],
      "worktree /tmp/root\nworktree /tmp/exact-worktree",
      "",
    ).valid,
    false,
  );
  assert.equal(
    observeIsolatedGitResourceAbsence(
      [placement],
      "worktree /tmp/root",
      "refs/heads/pi-workgraph/run/attempt",
    ).valid,
    false,
  );
});

void test("native observer requires request progression and reports early blocker or incomplete turns promptly", () => {
  const session = SessionManager.inMemory();
  assert.equal(observeCoordinatorTurn(session.getBranch(), request).state, "waiting");
  session.appendMessage({
    role: "user",
    content: request,
    timestamp: fixtureTimestamp,
  });
  assert.equal(observeCoordinatorTurn(session.getBranch(), request).state, "waiting");
  failedAssistant(session, "length");
  const incomplete = observeCoordinatorTurn(session.getBranch(), request);
  assert.equal(incomplete.state, "failed");

  const settled = SessionManager.inMemory();
  settled.appendMessage({
    role: "user",
    content: request,
    timestamp: fixtureTimestamp,
  });
  settledAssistant(settled);
  assert.equal(observeCoordinatorTurn(settled.getBranch(), request).state, "settled");

  const blocked = SessionManager.inMemory();
  blocked.appendMessage({
    role: "user",
    content: request,
    timestamp: fixtureTimestamp,
  });
  settledAssistant(blocked, "I cannot complete the request because access is unavailable.");
  const blocker = observeCoordinatorTurn(blocked.getBranch(), request);
  assert.equal(blocker.state, "blocked");

  const failed = SessionManager.inMemory();
  failed.appendMessage({
    role: "user",
    content: request,
    timestamp: fixtureTimestamp,
  });
  failedAssistant(failed, "error");
  const failure = observeCoordinatorTurn(failed.getBranch(), request);
  assert.equal(failure.state, "failed");
});
