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
  createWorkerSessionEffect,
  effectiveModelObservations,
  forkConversationSessionEffect,
  hasNativeAgentSettled,
  hasNativeAgentStarted,
  MODEL_PREFLIGHT_MARKER,
  NATIVE_SUBMISSION_MARKER,
  nativeSubmissionEvidence,
  observeNativeFailure,
  PiSessionError,
  PROVIDER_AVAILABILITY_MARKER,
  providerAvailabilityEvidence,
  readEnrichmentPacketResult,
  readModelPreflight,
  readTerminalText,
  readWorkgraphReportResult,
} from "../src/pi-process.js";
import { usage } from "./helpers.js";

const runSession = (request: Parameters<typeof createWorkerSessionEffect>[0]) =>
  Effect.runPromise(Effect.provide(createWorkerSessionEffect(request), liveLayer));

await test("fresh worker context, explicit continuation, native generation markers and invalid reports remain distinct", async () => {
  const root = await mkdtemp(join(tmpdir(), "workgraph-session-"));
  const generation = { runId: "fixture", nodeId: "first" };
  try {
    const file = await runSession({
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
    const continuation = await runSession({
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

await test("consultation packet and native submission evidence stay generation-scoped and conservative", async () => {
  const root = await mkdtemp(join(tmpdir(), "workgraph-consultation-session-"));
  const generation = { runId: "consultation-fixture", nodeId: "first" };
  try {
    const file = await runSession({
      ...generation,
      targetCwd: root,
      sessionDir: join(root, "sessions"),
      objective: "Consult on exact evidence",
      mode: "consultation_enricher",
    });
    const session = SessionManager.open(file);
    assert.equal(nativeSubmissionEvidence(file, generation), "absent");
    session.appendCustomEntry("pi-workgraph-enrichment", {
      ...generation,
      packet: {
        sourceObservations: [{ label: "source", observation: "Observed", class: "direct" }],
        counterevidence: [],
        gaps: ["A bounded gap"],
        localState: { repository: root, revision: "fixture-revision", workingTree: "clean" },
      },
    });
    assert.equal(readEnrichmentPacketResult(file, generation).packet?.gaps[0], "A bounded gap");
    session.appendCustomEntry("pi-workgraph-enrichment", {
      runId: generation.runId,
      nodeId: "other-generation",
      packet: {
        sourceObservations: [{ label: "foreign", observation: "Ignored", class: "direct" }],
        counterevidence: [],
        gaps: ["Foreign gap"],
        localState: { repository: root, revision: "foreign", workingTree: "clean" },
      },
    });
    assert.equal(readEnrichmentPacketResult(file, generation).packet?.gaps[0], "A bounded gap");
    session.appendCustomEntry(NATIVE_SUBMISSION_MARKER, {
      runId: generation.runId,
      nodeId: "other-generation",
      state: "submitted",
    });
    assert.equal(nativeSubmissionEvidence(file, generation), "absent");
    session.appendCustomEntry(NATIVE_SUBMISSION_MARKER, { ...generation, state: "not_submitted" });
    assert.equal(nativeSubmissionEvidence(file, generation), "not_submitted");
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "A provider response" }],
      api: "test",
      provider: "fixture",
      model: "advisor",
      usage,
      stopReason: "stop",
      timestamp: 1,
    });
    assert.equal(nativeSubmissionEvidence(file, generation), "contradictory");
    session.appendCustomEntry(MODEL_PREFLIGHT_MARKER, {
      ...generation,
      model: "fixture/advisor",
      thinking: "high",
      state: "ready",
      detail: "Ready",
    });
    assert.deepEqual(readModelPreflight(file, generation), {
      model: "fixture/advisor",
      thinking: "high",
      state: "ready",
      detail: "Ready",
    });
    session.appendCustomEntry(MODEL_PREFLIGHT_MARKER, {
      runId: generation.runId,
      nodeId: "other-generation",
      model: "foreign/model",
      thinking: "off",
      state: "missing_model",
      detail: "Ignored",
    });
    assert.deepEqual(readModelPreflight(file, generation), {
      model: "fixture/advisor",
      thinking: "high",
      state: "ready",
      detail: "Ready",
    });
    session.appendCustomEntry(MODEL_PREFLIGHT_MARKER, {
      ...generation,
      model: "fixture/advisor",
      thinking: "high",
      state: "ready",
      detail: "Malformed preflight has an undeclared field.",
      extra: true,
    });
    assert.equal(readModelPreflight(file, generation), undefined);
    session.appendCustomEntry(MODEL_PREFLIGHT_MARKER, {
      ...generation,
      model: "fixture/advisor",
      thinking: "high",
      state: "missing_credentials",
      detail: "Contradictory preflight.",
    });
    assert.equal(readModelPreflight(file, generation), undefined);
    session.appendCustomEntry(PROVIDER_AVAILABILITY_MARKER, {
      ...generation,
      model: "fixture/advisor",
      thinking: "high",
      availability: "unavailable",
      submission: "not_submitted",
      reason: "The fixture provider is disabled for this target.",
    });
    assert.deepEqual(
      providerAvailabilityEvidence(file, generation, {
        model: "fixture/advisor",
        thinking: "high",
      }),
      {
        state: "unavailable",
        model: "fixture/advisor",
        thinking: "high",
        reason: "The fixture provider is disabled for this target.",
      },
    );
    session.appendCustomEntry(PROVIDER_AVAILABILITY_MARKER, {
      ...generation,
      model: "other/advisor",
      thinking: "high",
      availability: "unavailable",
      submission: "not_submitted",
      reason: "Mismatched target.",
    });
    assert.notEqual(
      providerAvailabilityEvidence(file, generation, {
        model: "fixture/advisor",
        thinking: "high",
      }),
      "contradictory",
    );
    session.appendCustomEntry(PROVIDER_AVAILABILITY_MARKER, {
      ...generation,
      model: "fixture/advisor",
      thinking: "high",
      availability: "unavailable",
      submission: "not_submitted",
      reason: "Malformed marker has an undeclared field.",
      extra: true,
    });
    assert.equal(
      providerAvailabilityEvidence(file, generation, {
        model: "fixture/advisor",
        thinking: "high",
      }),
      "contradictory",
    );
    session.appendCustomEntry(PROVIDER_AVAILABILITY_MARKER, {
      ...generation,
      model: "fixture/advisor",
      thinking: "high",
      availability: "unavailable",
      submission: "not_submitted",
      reason: "A contradictory retained reason.",
    });
    assert.equal(
      providerAvailabilityEvidence(file, generation, {
        model: "fixture/advisor",
        thinking: "high",
      }),
      "contradictory",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("native submission evidence treats possible provider responses as submission", async () => {
  const root = await mkdtemp(join(tmpdir(), "workgraph-submission-evidence-"));
  const generation = { runId: "submission-evidence-fixture", nodeId: "first" };
  try {
    for (const [index, stopReason] of (
      ["stop", "length", "toolUse", "pending"] as const
    ).entries()) {
      const file = await runSession({
        ...generation,
        targetCwd: root,
        sessionDir: join(root, `sessions-${stopReason}`),
        objective: "Observe provider submission evidence",
        mode: "consultation",
      });
      const session = SessionManager.open(file);
      session.appendCustomEntry(NATIVE_SUBMISSION_MARKER, {
        ...generation,
        state: "not_submitted",
      });
      session.appendMessage({
        role: "assistant",
        content: stopReason === "toolUse" ? [{ type: "text", text: "Pending tool call" }] : [],
        api: "test",
        provider: "fixture",
        model: "advisor",
        usage,
        stopReason,
        timestamp: index + 1,
      });
      assert.equal(nativeSubmissionEvidence(file, generation), "contradictory", stopReason);
    }

    for (const [index, stopReason] of (["error", "aborted"] as const).entries()) {
      const file = await runSession({
        ...generation,
        targetCwd: root,
        sessionDir: join(root, `error-sessions-${stopReason}`),
        objective: "Observe provider submission evidence",
        mode: "consultation",
      });
      const session = SessionManager.open(file);
      const message = {
        role: "assistant" as const,
        content: [],
        api: "test",
        provider: "fixture",
        model: "advisor",
        usage,
        stopReason,
        timestamp: index + 1,
      };
      if (stopReason === "error")
        session.appendMessage({ ...message, errorMessage: "Provider bridge unavailable." });
      else session.appendMessage(message);
      assert.equal(nativeSubmissionEvidence(file, generation), "absent", stopReason);
      session.appendCustomEntry(NATIVE_SUBMISSION_MARKER, {
        ...generation,
        state: "not_submitted",
      });
      assert.equal(nativeSubmissionEvidence(file, generation), "not_submitted", stopReason);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("terminal consultation text keeps only the latest successful assistant message and all text blocks", async () => {
  const root = await mkdtemp(join(tmpdir(), "workgraph-terminal-text-"));
  const generation = { runId: "terminal-fixture", nodeId: "first" };
  try {
    const file = await runSession({
      ...generation,
      targetCwd: root,
      sessionDir: join(root, "sessions"),
      objective: "Read terminal text",
      mode: "consultation",
    });
    const session = SessionManager.open(file);
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Earlier advice" }],
      api: "test",
      provider: "fixture",
      model: "advisor",
      usage,
      stopReason: "stop",
      timestamp: 1,
    });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Partial advice" }],
      api: "test",
      provider: "fixture",
      model: "advisor",
      usage,
      stopReason: "toolUse",
      timestamp: 2,
    });
    session.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Latest advice" },
        { type: "text", text: "Second block" },
      ],
      api: "test",
      provider: "fixture",
      model: "advisor",
      usage,
      stopReason: "stop",
      timestamp: 3,
    });
    assert.equal(readTerminalText(file, generation), "Latest advice\nSecond block");
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Tool-use advice" }],
      api: "test",
      provider: "fixture",
      model: "advisor",
      usage,
      stopReason: "toolUse",
      timestamp: 4,
    });
    assert.equal(readTerminalText(file, generation), undefined);
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Provider failed" }],
      api: "test",
      provider: "fixture",
      model: "advisor",
      usage,
      stopReason: "error",
      errorMessage: "provider failure",
      timestamp: 5,
    });
    assert.equal(readTerminalText(file, generation), undefined);
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Aborted advice" }],
      api: "test",
      provider: "fixture",
      model: "advisor",
      usage,
      stopReason: "aborted",
      timestamp: 6,
    });
    assert.equal(readTerminalText(file, generation), undefined);
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

    const parentFile = await runSession({
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
    const file = await runSession({
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
    const continuation = await runSession({
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
