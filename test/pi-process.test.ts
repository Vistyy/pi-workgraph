import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This is a real native SessionManager filesystem boundary test.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native temporary paths are part of the SessionManager test boundary.
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { liveLayer } from "../src/node-platform.js";
import {
  createWorkerSession,
  createWorkerSessionEffect,
  effectiveModelObservations,
  forkConversationSessionEffect,
  hasNativeAgentSettled,
  hasNativeAgentStarted,
  observeNativeFailure,
  PiSessionError,
  readTerminalText,
  readWorkgraphReportResult,
} from "../src/pi-process.js";
import { usage } from "./helpers.js";

await test("fresh worker context, explicit continuation, native generation markers and invalid reports remain distinct", async () => {
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
    assert.equal(hasNativeAgentStarted(file, generation.runId, generation.nodeId), true);
    assert.equal(hasNativeAgentSettled(file, generation.runId, generation.nodeId), false);
    session.appendCustomEntry("pi-workgraph-effective-model", {
      ...generation,
      model: "policy/selected",
      thinking: "high",
    });
    session.appendCustomEntry("pi-workgraph-effective-model", {
      runId: generation.runId,
      nodeId: "other-generation",
      model: "secret/ignored",
      thinking: "max",
    });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Useful prose, not a typed report" }],
      api: "test",
      provider: "test",
      model: "fixture",
      usage,
      stopReason: "stop",
      timestamp: 1,
    });
    session.appendCustomEntry("pi-workgraph-agent-settled", generation);
    assert.deepEqual(effectiveModelObservations(file, generation), [
      { model: "policy/selected", thinking: "high", source: "selection" },
      { model: "test/fixture", source: "message" },
    ]);
    assert.equal(readTerminalText(file, generation), "Useful prose, not a typed report");
    assert.equal(readWorkgraphReportResult(file, generation).report, undefined);
    assert.equal(hasNativeAgentSettled(file, generation.runId, generation.nodeId), true);
    session.appendMessage({
      role: "toolResult",
      toolCallId: "invalid",
      toolName: "workgraph_report",
      content: [],
      details: { report: { kind: "research", status: "completed" } },
      isError: false,
      timestamp: 2,
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
    assert.equal(SessionManager.open(continuation).getHeader()?.parentSession, file);
    assert.equal(hasNativeAgentSettled(continuation, next.runId, next.nodeId), false);
    assert.equal(readWorkgraphReportResult(continuation, next).invalid, false);
    assert.equal(readWorkgraphReportResult(continuation, next).report, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("session Effects distinguish provider persistence failures from native lineage failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "workgraph-session-errors-"));
  const generation = { runId: "failure-fixture", nodeId: "first" };
  try {
    const blockedSessionDir = join(root, "not-a-directory");
    await writeFile(blockedSessionDir, "fixture");
    const providerFailure = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          createWorkerSessionEffect({
            ...generation,
            targetCwd: root,
            sessionDir: blockedSessionDir,
            objective: "Cannot persist",
            mode: "research",
          }),
          liveLayer,
        ),
      ),
    );
    assert.equal(providerFailure._tag, "PlatformError");

    const parentFile = await createWorkerSession({
      ...generation,
      targetCwd: root,
      sessionDir: join(root, "sessions"),
      objective: "Create parent",
      mode: "research",
    });
    const nativeFailure = await Effect.runPromise(
      Effect.flip(
        forkConversationSessionEffect({
          parentSessionFile: parentFile,
          targetCwd: root,
          entryId: "missing-entry",
        }),
      ),
    );
    assert.ok(nativeFailure instanceof PiSessionError);
    assert.equal(nativeFailure.operation, "validate-entry");
    assert.match(nativeFailure.message, /Unknown conversation entry/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("native failure observation is current-generation, latest-message, and category only", async () => {
  const root = await mkdtemp(join(tmpdir(), "workgraph-native-failure-"));
  const first = { runId: "native-fixture", nodeId: "first" };
  try {
    const file = await createWorkerSession({
      ...first,
      targetCwd: root,
      sessionDir: join(root, "sessions"),
      objective: "Observe native metadata",
      mode: "research",
    });
    const session = SessionManager.open(file);
    session.appendMessage({
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "fixture-provider",
      model: "fixture",
      usage,
      stopReason: "error",
      errorMessage:
        "HTTP 429 Too Many Requests at https://provider.example/private with Bearer RAW_SECRET",
      timestamp: 1,
    });
    assert.equal(observeNativeFailure(file, first), "provider-rate-limit");

    session.appendMessage({
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "fixture-provider",
      model: "fixture",
      usage,
      stopReason: "stop",
      timestamp: 2,
    });
    assert.equal(observeNativeFailure(file, first), undefined);

    session.appendMessage({
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "fixture-provider",
      model: "fixture",
      usage,
      stopReason: "error",
      errorMessage: "Connection exposed credential RAW_SECRET and arbitrary provider body",
      timestamp: 3,
    });
    const generic = observeNativeFailure(file, first);
    assert.equal(generic, "native-error");
    assert.equal(JSON.stringify(generic).includes("RAW_SECRET"), false);

    session.appendMessage({
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "workgraph",
      model: "synthetic",
      usage,
      stopReason: "aborted",
      errorMessage: "RAW_SYNTHETIC_SECRET",
      timestamp: 4,
    });
    assert.equal(observeNativeFailure(file, first), "native-error");

    const next = { ...first, nodeId: "second" };
    const continuation = await createWorkerSession({
      ...next,
      targetCwd: root,
      sessionDir: join(root, "sessions"),
      objective: "Observe only this generation",
      mode: "research",
      continuationSessionFile: file,
    });
    assert.equal(observeNativeFailure(continuation, next), undefined);
    const continued = SessionManager.open(continuation);
    continued.appendMessage({
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "fixture-provider",
      model: "fixture",
      usage,
      stopReason: "aborted",
      errorMessage: "Request aborted at https://private.example/?token=RAW_SECRET",
      timestamp: 5,
    });
    const aborted = observeNativeFailure(continuation, next);
    assert.equal(aborted, "native-abort");
    assert.equal(JSON.stringify(aborted).includes("RAW_SECRET"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
