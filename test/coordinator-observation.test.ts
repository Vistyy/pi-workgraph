import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { notificationDrivenProgress } from "../scripts/coordinator-observation.js";
import { usage } from "./helpers.js";

function assistant(session: SessionManager, experiment = false) {
  session.appendMessage({
    role: "assistant",
    content: experiment
      ? [
          {
            type: "toolCall",
            id: "experiment",
            name: "workgraph_research",
            arguments: { id: "uppercase-experiment" },
          },
        ]
      : [{ type: "text", text: "Handle retained evidence" }],
    api: "test",
    provider: "test",
    model: "fixture",
    usage,
    stopReason: experiment ? "toolUse" : "stop",
    timestamp: Date.now(),
  });
}
function notify(session: SessionManager, resultId: string) {
  session.appendCustomMessageEntry(
    "pi-workgraph-workstream",
    "Retained result",
    true,
    { resultId },
  );
}

test("live observer requires actual notifications and dependent generation, and waits for trailing followUps", () => {
  const session = SessionManager.inMemory();
  const observe = () =>
    notificationDrivenProgress(
      session.getBranch(),
      ["baseline", "other"],
      "baseline",
    );
  assert.equal(observe(), false);
  // Neither unrelated notifications nor transport metadata establishes receipt.
  session.appendCustomEntry("delivery", {
    resultId: "baseline",
    state: "delivered",
  });
  notify(session, "unrelated");
  assistant(session);
  assert.equal(observe(), false);
  notify(session, "baseline");
  assert.equal(observe(), false);
  assistant(session, true);
  assert.equal(observe(), false);
  // Workstream completion alone need not mean the final followUp has drained.
  session.appendCustomEntry("completion", { state: "completed" });
  assert.equal(observe(), false);
  notify(session, "other");
  assert.equal(observe(), false);
  assistant(session);
  assert.equal(observe(), true);
});

test("late queue drainage cannot pass as notification-driven progression", () => {
  const session = SessionManager.inMemory();
  assistant(session, true);
  const observe = () =>
    notificationDrivenProgress(session.getBranch(), ["baseline"], "baseline");
  assert.throws(observe, /before the actual baseline/);
  notify(session, "baseline");
  assistant(session);
  assert.throws(observe, /before the actual baseline/);
});
