import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This test exercises native SessionManager and Git filesystem boundaries.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native temporary paths are part of the runtime integration boundary.
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resultNotification } from "../src/agent-facing.js";
import { GitRepository } from "../src/git.js";
import {
  type HerdrInspection,
  type HerdrObservation,
  herdrAgentName,
  type VisibleWorkerRuntime,
  type WorkerLaunchRequest,
} from "../src/herdr.js";
import { DEFAULT_MODEL_POLICY } from "../src/model-policy.js";
import { WorkgraphRegistry } from "../src/registry.js";
import type { WorkerIdentity } from "../src/types.js";
import { WorkstreamStore } from "../src/workstream.js";
import { WorkstreamRuntime } from "../src/workstream-runtime.js";
import { git, persistentSession, researchReport, usage } from "./helpers.js";
import { promiseWorkerEffects } from "./runtime-worker-port.js";

const RAW_SECRET = "Bearer fixture-secret at https://provider.example/private";

class NativeFailureWorker implements VisibleWorkerRuntime {
  readonly available = true;
  readonly effects = promiseWorkerEffects(this);

  async launch(request: WorkerLaunchRequest): Promise<HerdrObservation> {
    const identity: WorkerIdentity = {
      workspaceId: request.workspaceId,
      tabId: `tab-${request.attemptId}`,
      paneId: `pane-${request.attemptId}`,
      terminalId: `terminal-${request.attemptId}`,
      agentName: herdrAgentName(request.runId, request.nodeId, request.attemptId),
      sessionFile: request.sessionFile,
      cwd: request.cwd,
    };
    await request.onResource?.({
      workspaceId: identity.workspaceId,
      tabId: identity.tabId,
      paneId: identity.paneId,
      terminalId: identity.terminalId,
      agentName: identity.agentName,
      cwd: identity.cwd,
    });
    await request.onIdentity?.(identity);
    const session = SessionManager.open(request.sessionFile);
    const generation = { runId: request.runId, nodeId: request.nodeId };
    session.appendCustomEntry("pi-workgraph-agent-running", generation);
    if (request.assignmentId === "untyped")
      session.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Useful untyped result." }],
        api: "openai-responses",
        provider: "fixture-provider",
        model: "fixture",
        usage,
        stopReason: "stop",
        timestamp: 1,
      });
    if (request.assignmentId !== "fallback") {
      const stopReason = request.assignmentId === "abort" ? "aborted" : "error";
      const errorMessage =
        request.assignmentId === "generic"
          ? `Arbitrary provider failure: ${RAW_SECRET}`
          : `HTTP 429 Too Many Requests: ${RAW_SECRET}`;
      session.appendMessage({
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "fixture-provider",
        model: "fixture",
        usage,
        stopReason,
        errorMessage,
        timestamp: 2,
      });
    }
    if (request.assignmentId === "typed") {
      session.appendMessage({
        role: "toolResult",
        toolCallId: "report",
        toolName: "workgraph_report",
        content: [],
        details: { report: researchReport("Typed report remains authoritative.") },
        isError: false,
        timestamp: 3,
      });
    }
    session.appendCustomEntry("pi-workgraph-agent-settled", generation);
    await request.onSubmitted?.();
    return this.observation(identity);
  }

  async inspect(identity: WorkerIdentity): Promise<HerdrInspection> {
    return this.observation(identity);
  }

  async observe(identity: WorkerIdentity): Promise<HerdrObservation> {
    return this.observation(identity);
  }

  async interrupt(identity: WorkerIdentity): Promise<HerdrObservation> {
    return this.observation(identity);
  }

  async cleanup(identity: WorkerIdentity) {
    return {
      state: "completed" as const,
      identity,
      observedAt: "2026-01-01T00:00:00.000Z",
      detail: "Native fixture closed.",
    };
  }

  private observation(identity: WorkerIdentity): HerdrObservation {
    return { identity, status: "done", observedAt: "2026-01-01T00:00:00.000Z" };
  }
}

await test("absent native failures project sanitized actionable notifications without affecting typed reports", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-native-runtime-"));
  let runtime: WorkstreamRuntime | undefined;
  let registry: WorkgraphRegistry | undefined;
  try {
    const root = join(parent, "repo");
    await mkdir(root);
    await git(root, "init", "-b", "main");
    await git(root, "config", "user.email", "fixture@example.test");
    await git(root, "config", "user.name", "Native failure test");
    await writeFile(join(root, "value.txt"), "fixture\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "fixture");
    const repository = await GitRepository.open(root);
    const coordinator = persistentSession(root, join(parent, "coordinator-sessions"));
    const coordinatorFile = coordinator.getSessionFile();
    assert.ok(coordinatorFile !== undefined);
    const { store } = await WorkstreamStore.create({
      id: "native-failure-fixture",
      purpose: "Observe bounded native failure outcomes",
      projectRoot: root,
      gitCommonDir: repository.commonDir,
      coordinator: { sessionId: coordinator.getSessionId(), sessionFile: coordinatorFile },
    });
    registry = new WorkgraphRegistry(join(parent, "registry.sqlite"));
    const notifications: string[] = [];
    runtime = new WorkstreamRuntime(
      store,
      repository,
      new NativeFailureWorker(),
      { workspaceId: "fixture-workspace" },
      (resultId, state) => {
        notifications.push(resultNotification(state, resultId));
      },
      assert.fail,
      { registry, policy: DEFAULT_MODEL_POLICY },
    );
    for (const id of ["rate-limit", "abort", "generic", "fallback", "untyped", "typed"])
      await runtime.queue({
        id,
        capability: "research",
        artifactIntent: "evidence_only",
        objective: `Observe ${id}`,
        intentVersion: 0,
        expectedEvidence: ["Native metadata"],
      });

    await runtime.reconcile();
    const state = await runtime.reconcile();
    const rateLimit = state.results.find((result) => result.assignmentId === "rate-limit");
    const aborted = state.results.find((result) => result.assignmentId === "abort");
    const generic = state.results.find((result) => result.assignmentId === "generic");
    const fallback = state.results.find((result) => result.assignmentId === "fallback");
    const untyped = state.results.find((result) => result.assignmentId === "untyped");
    const typed = state.results.find((result) => result.assignmentId === "typed");
    assert.equal(rateLimit?.assignmentIntentVersion, 0);
    assert.equal(rateLimit?.validity, "absent");
    if (rateLimit?.validity === "absent")
      assert.equal(
        rateLimit.detail,
        "Pi settled without a current-attempt report after a provider rate limit.",
      );
    assert.equal(aborted?.validity, "absent");
    if (aborted?.validity === "absent")
      assert.equal(
        aborted.detail,
        "Pi settled without a current-attempt report after the native turn was aborted.",
      );
    assert.equal(generic?.validity, "absent");
    if (generic?.validity === "absent")
      assert.equal(
        generic.detail,
        "Pi settled without a current-attempt report after a native provider error.",
      );
    assert.equal(fallback?.validity, "absent");
    if (fallback?.validity === "absent")
      assert.equal(fallback.detail, "Pi settled without a current-attempt report.");
    assert.equal(untyped?.validity, "untyped");
    if (untyped?.validity === "untyped") assert.equal(untyped.text, "Useful untyped result.");
    assert.equal(typed?.validity, "typed");
    if (typed?.validity === "typed")
      assert.equal(typed.report.summary, "Typed report remains authoritative.");

    const projected = notifications.join("\n");
    assert.match(projected, /after a provider rate limit/);
    assert.match(projected, /after the native turn was aborted/);
    assert.match(projected, /after a native provider error/);
    assert.match(projected, /Useful untyped result/);
    assert.match(projected, /Typed report remains authoritative/);
    assert.equal(projected.includes(RAW_SECRET), false);
    assert.equal(JSON.stringify(state).includes(RAW_SECRET), false);
  } finally {
    if (runtime !== undefined) await runtime.stop();
    registry?.close();
    await rm(parent, { recursive: true, force: true });
  }
});
