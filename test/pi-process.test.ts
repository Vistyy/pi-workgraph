import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createWorkerSession,
  hasNativeAgentSettled,
  hasNativeAgentStarted,
  readTerminalText,
  readWorkgraphReportResult,
} from "../src/pi-process.js";
import { usage } from "./helpers.js";

test("fresh worker context, explicit continuation, native generation markers and invalid reports remain distinct", async () => {
  const root = await mkdtemp(join(tmpdir(), "workgraph-session-"));
  const generation = { runId: "fixture", nodeId: "first" };
  try {
    const file = await createWorkerSession({
      ...generation,
      targetCwd: root,
      sessionDir: join(root, "sessions"),
      objective: "Observe exact bytes",
      mode: "research",
    });
    assert.match(await readFile(file, "utf8"), /Observe exact bytes/);
    const session = SessionManager.open(file);
    assert.equal(session.getHeader()?.parentSession, undefined);
    assert.equal(readTerminalText(file, generation), undefined);
    session.appendCustomEntry("pi-workgraph-agent-running", generation);
    assert.equal(
      hasNativeAgentStarted(file, generation.runId, generation.nodeId),
      true,
    );
    assert.equal(
      hasNativeAgentSettled(file, generation.runId, generation.nodeId),
      false,
    );
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Useful prose, not a typed report" }],
      api: "test",
      provider: "test",
      model: "fixture",
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    });
    session.appendCustomEntry("pi-workgraph-agent-settled", generation);
    assert.equal(
      readTerminalText(file, generation),
      "Useful prose, not a typed report",
    );
    assert.equal(readWorkgraphReportResult(file, generation).report, undefined);
    assert.equal(
      hasNativeAgentSettled(file, generation.runId, generation.nodeId),
      true,
    );
    session.appendMessage({
      role: "toolResult",
      toolCallId: "invalid",
      toolName: "workgraph_report",
      content: [],
      details: { report: { kind: "research", status: "completed" } },
      isError: false,
      timestamp: Date.now(),
    });
    assert.equal(readWorkgraphReportResult(file, generation).invalid, true);
    const next = { ...generation, nodeId: "second" };
    const continuation = await createWorkerSession({
      ...next,
      targetCwd: root,
      sessionDir: join(root, "sessions"),
      objective: "Follow up",
      mode: "research",
      continuationSessionFile: file,
    });
    assert.equal(
      SessionManager.open(continuation).getHeader()?.parentSession,
      file,
    );
    assert.equal(
      hasNativeAgentSettled(continuation, next.runId, next.nodeId),
      false,
    );
    assert.equal(readWorkgraphReportResult(continuation, next).invalid, false);
    assert.equal(
      readWorkgraphReportResult(continuation, next).report,
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
