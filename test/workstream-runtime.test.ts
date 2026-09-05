import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { GitRepository, runProcess } from "../src/git.js";
import {
  type HerdrObservation,
  herdrAgentName,
  type VisibleWorkerRuntime,
  type WorkerLaunchRequest,
  type WorkerRecoveryRequest,
} from "../src/herdr.js";
import { DEFAULT_MODEL_POLICY } from "../src/model-policy.js";
import { WorkgraphRegistry } from "../src/registry.js";
import type { WorkerIdentity, WorkerReport } from "../src/types.js";
import { type WorkstreamState, WorkstreamStore } from "../src/workstream.js";
import { WorkstreamRuntime } from "../src/workstream-runtime.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess("git", ["-C", cwd, ...args], {
    cwd,
    timeoutMs: 30_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const researchReport: WorkerReport = {
  kind: "research",
  status: "completed",
  summary: "Read fixture",
  evidence: [
    { label: "file", observation: "value.txt says initial", class: "direct" },
  ],
  findings: [],
};

class Worker implements VisibleWorkerRuntime {
  readonly available = true;
  readonly requests: WorkerLaunchRequest[] = [];
  readonly identities = new Map<string, WorkerIdentity>();
  promptCount = 0;
  cleanupCount = 0;
  deferWork = false;
  status: HerdrObservation["status"] = "idle";
  failBeforeSubmission = false;
  failAfterSubmission = false;
  onWork: (request: WorkerLaunchRequest) => Promise<unknown> = async () =>
    researchReport;

  async produce(request: WorkerLaunchRequest): Promise<void> {
    this.promptCount++;
    const session = SessionManager.open(request.sessionFile);
    session.appendCustomEntry("pi-workgraph-agent-running", {
      runId: request.runId,
      nodeId: request.nodeId,
    });
    const report = await this.onWork(request);
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Actual fixture worker evidence" }],
      api: "test",
      provider: "test",
      model: "worker",
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    });
    if (report !== undefined)
      session.appendMessage({
        role: "toolResult",
        toolCallId: "report",
        toolName: "workgraph_report",
        content: [{ type: "text", text: "report" }],
        details: { report },
        isError: false,
        timestamp: Date.now(),
      });
    session.appendCustomEntry("pi-workgraph-agent-settled", {
      runId: request.runId,
      nodeId: request.nodeId,
    });
  }
  async launch(request: WorkerLaunchRequest): Promise<HerdrObservation> {
    this.requests.push(request);
    const index = this.requests.length;
    const identity = {
      workspaceId: request.workspaceId,
      tabId: `w1:t${index}`,
      paneId: `w1:p${index}`,
      terminalId: `term${index}`,
      agentName: herdrAgentName(
        request.runId,
        request.nodeId,
        request.attemptId,
      ),
      sessionFile: request.sessionFile,
      cwd: request.cwd,
    };
    this.identities.set(identity.agentName, identity);
    await request.onResource?.({
      workspaceId: identity.workspaceId,
      tabId: identity.tabId,
      paneId: identity.paneId,
      terminalId: identity.terminalId,
      agentName: identity.agentName,
      cwd: identity.cwd,
    });
    if (this.failBeforeSubmission)
      throw new Error("fixture readiness interruption");
    await request.onIdentity?.(identity);
    if (!this.deferWork) await this.produce(request);
    if (this.failAfterSubmission)
      throw new Error("fixture uncertain prompt acknowledgment");
    await request.onSubmitted?.();
    return {
      identity,
      status: "working",
      observedAt: new Date().toISOString(),
    };
  }
  async observe(identity: WorkerIdentity): Promise<HerdrObservation> {
    return {
      identity,
      status: this.status,
      observedAt: new Date().toISOString(),
    };
  }
  async recover(
    request: WorkerRecoveryRequest,
  ): Promise<HerdrObservation | undefined> {
    const identity = this.identities.get(request.agentName);
    return identity ? this.observe(identity) : undefined;
  }
  async steer(identity: WorkerIdentity, _instruction: string): Promise<void> {
    const request = this.requests.find(
      (item) => item.sessionFile === identity.sessionFile,
    );
    assert.ok(request);
    await this.produce(request);
  }
  async interrupt(identity: WorkerIdentity): Promise<HerdrObservation> {
    return this.observe(identity);
  }
  async cleanup(identity: WorkerIdentity) {
    this.cleanupCount++;
    return {
      state: "completed" as const,
      identity,
      observedAt: new Date().toISOString(),
      detail: "Exact fixture worker closed.",
    };
  }
}

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "workstream-runtime-"));
  const root = join(parent, "repo");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "fixture@example.test");
  await git(root, "config", "user.name", "Runtime test");
  await writeFile(join(root, "value.txt"), "initial\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  const repository = await GitRepository.open(root);
  const session = SessionManager.create(root, join(parent, "sessions"));
  session.appendMessage({
    role: "user",
    content: "UNRELATED_PARENT_SECRET",
    timestamp: Date.now(),
  });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "parent" }],
    api: "test",
    provider: "test",
    model: "parent",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const sessionFile =
    session.getSessionFile() ?? assert.fail("Fixture session must persist.");
  const owner = { sessionId: session.getSessionId(), sessionFile };
  const { store } = await WorkstreamStore.create({
    id: "ws-fixture",
    purpose: "Investigate and implement the authorized fixture",
    projectRoot: root,
    gitCommonDir: repository.commonDir,
    coordinator: owner,
  });
  const registry = new WorkgraphRegistry(join(parent, "registry.sqlite"));
  const workers = new Worker();
  const delivered: string[] = [];
  const errors: string[] = [];
  const runtimes: WorkstreamRuntime[] = [];
  function runtime(
    onResult: (id: string, state: WorkstreamState) => Promise<void> = async (
      id,
    ) => {
      delivered.push(id);
    },
    options: ConstructorParameters<typeof WorkstreamRuntime>[6] = {},
  ) {
    const value = new WorkstreamRuntime(
      store,
      repository,
      workers,
      { workspaceId: "w1" },
      onResult,
      (error) => {
        errors.push(error.message);
      },
      { registry, policy: DEFAULT_MODEL_POLICY, ...options },
    );
    runtimes.push(value);
    return value;
  }
  async function authority(active: WorkstreamRuntime) {
    return active.perform(async () => {
      const recorded = await store.recordInputEvent({
        ...owner,
        source: "interactive",
        text: "Implement value.txt and run bounded disposable experiments in this repository.",
      });
      await store.reviseIntent({
        authorityReceiptId: recorded.receipt.id,
        statement: "Change fixture safely",
        constraints: [],
      });
      return { receiptId: recorded.receipt.id, intentVersion: 1 };
    });
  }
  async function dispose() {
    for (const active of runtimes) await active.stop();
    registry.close();
    await rm(parent, { recursive: true, force: true });
  }
  return {
    root,
    parent,
    owner,
    sessionFile,
    store,
    registry,
    repository,
    workers,
    delivered,
    errors,
    runtime,
    authority,
    dispose,
  };
}
const research = (id: string, intentVersion = 0) => ({
  id,
  capability: "research" as const,
  artifactIntent: "evidence_only" as const,
  objective: "Inspect value.txt",
  intentVersion,
  expectedEvidence: ["File evidence"],
});

test("multi-attempt queueing resolves one shared validated base and exact-review conflicts have no effects", async () => {
  const f = await fixture();
  try {
    const active = f.runtime();
    const initial = await f.repository.head();
    const queued = await active.queue(research("shared-base"), {
      selection: { count: 2, diversity: "distinct-models" },
    });
    assert.deepEqual(
      queued.attempts.map((attempt) => attempt.baseRevision),
      [initial, initial],
    );
    await writeFile(join(f.root, "moved.txt"), "moved\n");
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-m", "move head");
    const moved = await f.repository.head();
    assert.notEqual(moved, initial);
    const retainedBefore = (await f.store.load()).assignments.length;
    await assert.rejects(
      active.queue(
        {
          id: "conflicting-review",
          capability: "review",
          artifactIntent: "evidence_only",
          objective: "Review an exact revision",
          intentVersion: 0,
          subject: { kind: "revision", revision: initial },
          concern: "Conflicting base must fail before queueing",
        },
        { baseRevision: moved },
      ),
      /conflicts with its exact subject/,
    );
    const state = await f.store.load();
    assert.equal(state.assignments.length, retainedBefore);
    assert.equal(state.attempts.length, 2);
  } finally {
    await f.dispose();
  }
});

test("new runtime drives fresh research through native evidence, durable retryable delivery and exact Git cleanup", async () => {
  const f = await fixture();
  try {
    const first = f.runtime(async () => {
      throw new Error("notification interrupted");
    });
    await first.queue(research("inspect"));
    await first.reconcile();
    const request = f.workers.requests[0];
    assert.ok(request);
    assert.match(
      await readFile(request.sessionFile, "utf8"),
      /Expected evidence: File evidence/,
    );
    assert.equal(
      (await readFile(request.sessionFile, "utf8")).includes(
        "UNRELATED_PARENT_SECRET",
      ),
      false,
    );
    let state = await first.reconcile();
    assert.equal(state.results[0]?.validity, "typed");
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(state.deliveries[0]?.state, "pending");
    assert.equal(state.attempts[0]?.effectiveModels?.[0]?.model, "test/worker");
    await first.reconcile();
    assert.equal(f.workers.promptCount, 1);
    await first.stop();
    const next = f.runtime();
    state = await next.reconcile();
    assert.equal(state.results.length, 1);
    assert.equal(state.deliveries[0]?.state, "delivered");
    assert.deepEqual(f.delivered, [state.results[0]?.id]);
    await next.perform(() =>
      f.store.acknowledge(state.results[0]!.id, "Read evidence"),
    );
    await next.reconcile();
    assert.equal(f.delivered.length, 1);
    assert.equal(f.workers.cleanupCount, 1);
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).split("worktree ")
        .length - 1,
      1,
    );
  } finally {
    await f.dispose();
  }
});

test("cleaned history has constant reconciliation reads while error clearing and pending delivery remain independent", async (t) => {
  const f = await fixture();
  try {
    const active = f.runtime(async () => {
      throw new Error("interrupted notification");
    });
    await active.perform(async () => undefined);
    const reads = t.mock.method(f.store, "load");
    await active.reconcile();
    const emptyReads = reads.mock.callCount();
    for (let index = 0; index < 4; index++)
      await active.queue(research(`read-${index}`));
    await active.reconcile();
    let state = await active.reconcile();
    assert.ok(
      state.attempts.every((attempt) => attempt.cleanup?.state === "completed"),
    );
    assert.ok(
      state.deliveries.every((delivery) => delivery.state === "pending"),
    );
    let before = reads.mock.callCount();
    await active.reconcile();
    assert.equal(
      reads.mock.callCount() - before,
      emptyReads,
      "Cleaned attempts must not add per-attempt durable loads",
    );
    const id = state.attempts[0]!.id;
    await active.perform(() =>
      f.store.recordAttention(id, "retained stale attention"),
    );
    const updates = t.mock.method(f.store, "clearAttention");
    state = await active.reconcile();
    assert.equal(updates.mock.callCount(), 1);
    assert.equal(state.attempts[0]?.error, undefined);
    assert.equal(
      state.attempts[0]?.attentionHistory?.[0]?.detail,
      "retained stale attention",
    );
    before = reads.mock.callCount();
    await active.reconcile();
    assert.equal(reads.mock.callCount() - before, emptyReads);
    assert.equal(
      updates.mock.callCount(),
      1,
      "Resolved attention must only be cleared once",
    );
    await active.stop();
    const recovered = f.runtime();
    state = await recovered.reconcile();
    assert.equal(
      f.delivered.length,
      4,
      "Terminal skipping must not skip pending delivery on reattachment",
    );
    assert.ok(
      state.deliveries.every((delivery) => delivery.state === "delivered"),
    );
    assert.equal(f.workers.cleanupCount, 4);

    // A blocked (not completed) cleanup must still be inspected and recoverable.
    await recovered.queue(research("blocked-cleanup"));
    await recovered.reconcile();
    const request = f.workers.requests.at(-1)!;
    const obstruction = join(request.cwd, "unattributed.txt");
    await writeFile(
      obstruction,
      "Created by this fixture after worker settlement\n",
    );
    state = await recovered.reconcile();
    const blocked = state.attempts.at(-1)!;
    assert.equal(blocked.cleanup?.state, "blocked");
    before = reads.mock.callCount();
    await recovered.reconcile();
    assert.ok(reads.mock.callCount() - before > emptyReads);
    await rm(obstruction);
    // Rearm only after inspecting/removing the exact fixture-owned obstruction.
    assert.ok(blocked.cleanup);
    await recovered.perform(() => f.store.retryCleanup(blocked.id));
    state = await recovered.reconcile();
    assert.equal(state.attempts.at(-1)?.cleanup?.state, "completed");
    assert.equal(state.attempts.at(-1)?.error, undefined);
  } finally {
    await f.dispose();
  }
});

test("maintained changes use guide/executor policy and review checks the requested earlier revision", async () => {
  const f = await fixture();
  try {
    const active = f.runtime();
    const authority = await f.authority(active);
    f.workers.onWork = async (request) => {
      if (request.env.PI_WORKGRAPH_MODE === "implementation") {
        assert.equal(request.model, "openai-codex/gpt-5.6-sol");
        assert.equal(
          request.env.PI_WORKGRAPH_EXECUTOR_MODEL,
          "openai-codex/gpt-5.6-luna",
        );
        assert.equal(
          request.env.PI_WORKGRAPH_BASE_COMMIT,
          await git(request.cwd, "rev-parse", "HEAD"),
        );
        await writeFile(join(request.cwd, "value.txt"), "maintained\n");
        await git(request.cwd, "add", ".");
        await git(request.cwd, "commit", "-m", "maintained change");
        return {
          kind: "implementation",
          status: "completed",
          summary: "Changed value",
          commit: await git(request.cwd, "rev-parse", "HEAD"),
          evidence: [],
          findings: [],
        };
      }
      assert.equal(
        await readFile(join(request.cwd, "value.txt"), "utf8"),
        "maintained\n",
      );
      return {
        kind: "review",
        status: "completed",
        summary: "Reviewed exact old revision",
        evidence: [],
        findings: [],
      };
    };
    await active.queue({
      id: "change",
      capability: "implement",
      artifactIntent: "maintained_change",
      objective: "Change value",
      intentVersion: 1,
      authority,
      acceptance: ["value is maintained"],
    });
    await active.reconcile();
    let state = await active.reconcile();
    assert.equal(
      await readFile(join(f.root, "value.txt"), "utf8"),
      "maintained\n",
    );
    const revision = state.attempts[0]?.composition?.revision;
    assert.ok(revision);
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    await writeFile(join(f.root, "value.txt"), "later\n");
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-m", "later unrelated change");
    await active.queue({
      id: "review",
      capability: "review",
      artifactIntent: "evidence_only",
      objective: "Review maintained change",
      intentVersion: 1,
      subject: { kind: "revision", revision },
      concern: "Exact content",
    });
    await active.reconcile();
    state = await active.reconcile();
    assert.equal(state.attempts[1]?.baseRevision, revision);
    assert.equal(state.results[1]?.validity, "typed");
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "later\n");
  } finally {
    await f.dispose();
  }
});

test("experiments retain authorized artifacts without composition, including failed and unsafe artifact results", async () => {
  const f = await fixture();
  try {
    const active = f.runtime();
    const authority = await f.authority(active);
    const initial = await f.repository.head();
    const input = (id: string) => ({
      id,
      capability: "research" as const,
      artifactIntent: "disposable_experiment" as const,
      objective: "Probe",
      intentVersion: 1,
      authority,
      permittedEffects: ["Scratch edits in isolated worktree"],
      stopCondition: "One observation",
      expectedEvidence: ["Probe output"],
      artifactPolicy: { retain: ["probe.txt"], discardOthers: true as const },
    });
    f.workers.onWork = async (request) => {
      assert.equal(request.env.PI_WORKGRAPH_EXPERIMENT, "1");
      assert.match(
        await readFile(request.sessionFile, "utf8"),
        /Expected evidence: Probe output/,
      );
      await writeFile(join(request.cwd, "probe.txt"), "observed\n");
      await writeFile(join(request.cwd, "scratch.txt"), "discardable\n");
      return researchReport;
    };
    await active.queue(input("probe"));
    await active.reconcile();
    let state = await active.reconcile();
    const artifact = state.results[0]?.artifacts[0];
    assert.ok(artifact);
    assert.equal(await readFile(artifact.reference, "utf8"), "observed\n");
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(await f.repository.head(), initial);
    f.workers.onWork = async () => ({
      ...researchReport,
      status: "failed",
      summary: "Probe failed before writing output",
    });
    await active.queue(input("failed-probe"));
    await active.reconcile();
    state = await active.reconcile();
    assert.equal(state.results[1]?.validity, "typed");
    assert.equal(state.results[1]?.artifacts.length, 0);
    assert.equal(state.attempts[1]?.cleanup?.state, "completed");
    f.workers.onWork = async (request) => {
      await symlink(join(f.root, "value.txt"), join(request.cwd, "probe.txt"));
      return researchReport;
    };
    await active.queue(input("unsafe-probe"));
    await active.reconcile();
    state = await active.reconcile();
    assert.equal(state.results[2]?.validity, "invalid");
    assert.equal(state.attempts[2]?.cleanup?.state, "blocked");
    assert.equal(
      await readFile(join(f.root, "value.txt"), "utf8"),
      "initial\n",
    );
  } finally {
    await f.dispose();
  }
});

test("wrong-mode and stale maintained results remain retained without composition or destructive cleanup", async () => {
  const f = await fixture();
  try {
    const active = f.runtime();
    const authority = await f.authority(active);
    const input = (id: string) => ({
      id,
      capability: "implement" as const,
      artifactIntent: "maintained_change" as const,
      objective: "Change",
      intentVersion: 1,
      authority,
      acceptance: ["Changed"],
    });
    await active.queue(input("wrong-mode"));
    await active.reconcile();
    let state = await active.reconcile();
    assert.equal(state.results[0]?.validity, "invalid");
    assert.equal(state.attempts[0]?.cleanup, undefined);
    f.workers.onWork = async (request) => {
      await writeFile(join(request.cwd, "value.txt"), "stale\n");
      await git(request.cwd, "add", ".");
      await git(request.cwd, "commit", "-m", "stale change");
      return {
        kind: "implementation",
        status: "completed",
        summary: "old constraint",
        evidence: [],
        findings: [],
        commit: await git(request.cwd, "rev-parse", "HEAD"),
      };
    };
    await active.queue(input("stale"));
    await active.reconcile();
    await active.perform(() =>
      f.store.reviseIntent({
        authorityReceiptId: authority.receiptId,
        statement: "New constraints",
        constraints: ["Do not apply old value"],
      }),
    );
    state = await active.reconcile();
    assert.equal(state.results[1]?.validity, "typed");
    assert.equal(state.attempts[1]?.composition?.state, "blocked");
    assert.equal(
      await readFile(join(f.root, "value.txt"), "utf8"),
      "initial\n",
    );
    assert.equal(f.workers.cleanupCount, 0);
    await assert.rejects(
      active.perform(() =>
        f.store.complete({
          conclusion: "done",
          evidence: [{ label: "limit", observation: "Not done" }],
          limitations: ["stale"],
        }),
      ),
      /workers and owned resources/,
    );
  } finally {
    await f.dispose();
  }
});

test("launch recovery distinguishes proven unsent from uncertain submitted generations", async () => {
  for (const window of ["before", "after"] as const) {
    const f = await fixture();
    try {
      const first = f.runtime();
      f.workers.failBeforeSubmission = window === "before";
      f.workers.failAfterSubmission = window === "after";
      await first.queue(research("inspect"));
      let state = await first.reconcile();
      assert.equal(
        state.attempts[0]?.submission,
        window === "before" ? "not_sent" : "uncertain",
      );
      await first.stop();
      const next = f.runtime();
      await next.reconcile();
      state = await next.reconcile();
      assert.equal(f.workers.requests.length, 1);
      assert.equal(f.workers.promptCount, 1);
      assert.equal(state.results.length, 1);
      assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    } finally {
      await f.dispose();
    }
  }
});

test("exclusive lease fences same-session duplicates and dead-owner adoption preserves suspended observations and receipts", async () => {
  const f = await fixture();
  try {
    const first = f.runtime();
    await f.authority(first);
    await first.queue(research("inspect", 1));
    await first.reconcile();
    const receipts = (await f.store.load()).inputs;
    const duplicate = f.runtime();
    await assert.rejects(duplicate.reconcile(), /already has a runtime owner/);
    await duplicate.stop();
    await first.perform(() =>
      f.store.setLifecycle({ state: "suspended", reason: "Keep stopped" }),
    );
    f.registry.db
      .prepare("UPDATE leases SET expires_at=? WHERE run_id=?")
      .run("2000-01-01T00:00:00.000Z", "ws-fixture");
    const nextOwner = {
      sessionId: "new-owner",
      sessionFile: join(f.parent, "new-session.jsonl"),
    };
    const adopted = f.runtime(undefined, {
      owner: nextOwner,
      priorOwnerLiveness: "dead",
    });
    const state = await adopted.reconcile();
    assert.equal(state.coordinator.sessionId, "new-owner");
    assert.equal(state.lifecycle.state, "suspended");
    assert.deepEqual(state.inputs, receipts);
    assert.equal(state.results.length, 1);
    assert.equal(state.deliveries[0]?.state, "pending");
    await assert.rejects(first.reconcile(), /live lease/);
    assert.equal(f.workers.requests.length, 1);
  } finally {
    await f.dispose();
  }
});

test("worker continuation uses an isolated new workspace and current generation, not the earlier report", async () => {
  const f = await fixture();
  try {
    const active = f.runtime();
    await active.queue(research("first"));
    await active.reconcile();
    let state = await active.reconcile();
    const previous = state.attempts[0];
    assert.ok(previous);
    f.workers.onWork = async () => undefined;
    await active.queue(research("followup"), {
      continuationOf: previous.id,
      model: "provider/other",
      modelReason: "Test an explicitly selected continuation model.",
      thinking: "low",
    });
    await active.reconcile();
    state = await active.reconcile();
    assert.equal(state.results[1]?.validity, "untyped");
    assert.notEqual(state.attempts[1]?.worktreePath, previous.worktreePath);
    assert.notEqual(state.attempts[1]?.sessionFile, previous.sessionFile);
    assert.equal(state.attempts[1]?.models?.guide.model, "provider/other");
    assert.equal(state.attempts[1]?.models?.source, "override");
  } finally {
    await f.dispose();
  }
});

test("failed notification is not retried by polling and manual observed receipt permits completion without claiming transport success", async () => {
  const f = await fixture();
  try {
    let notifications = 0;
    const active = f.runtime(async () => {
      notifications++;
      throw new Error("uncertain transport");
    });
    await active.queue(research("read"));
    await active.reconcile();
    const state = await active.reconcile();
    const result = state.results[0];
    assert.ok(result);
    await active.perform(() =>
      f.store.disposition({
        resultId: result.id,
        status: "accepted",
        reason: "Read the exact retained evidence through status",
      }),
    );
    const completion = {
      conclusion: "The bounded question is answered",
      evidence: [{ label: "Read", observation: "value.txt says initial" }],
      limitations: [],
    };
    await assert.rejects(
      active.perform(() => f.store.complete(completion)),
      /Pending result delivery/,
    );
    await active.reconcile();
    await active.reconcile();
    assert.equal(notifications, 1);
    await active.perform(() =>
      f.store.acknowledge(result.id, "Read the retained report through status"),
    );
    const acknowledged = await active.reconcile();
    assert.equal(acknowledged.deliveries[0]?.state, "acknowledged");
    assert.equal(acknowledged.deliveries[0]?.deliveredAt, undefined);
    assert.equal(notifications, 1);
    assert.equal(
      (await active.perform(() => f.store.complete(completion))).lifecycle
        .state,
      "completed",
    );
  } finally {
    await f.dispose();
  }
});

test("healthy startup/running is quiet; a blocked boundary is recorded once and cleared after observed recovery", async () => {
  const f = await fixture();
  try {
    f.workers.deferWork = true;
    const active = f.runtime();
    await active.queue(research("read"));
    await active.reconcile();
    let state = await active.reconcile();
    assert.equal(state.attempts[0]?.error, undefined);
    assert.deepEqual(f.errors, []);
    const request = f.workers.requests[0];
    assert.ok(request);
    const session = SessionManager.open(request.sessionFile);
    session.appendCustomEntry("pi-workgraph-agent-running", {
      runId: request.runId,
      nodeId: request.nodeId,
    });
    f.workers.status = "working";
    state = await active.reconcile();
    assert.equal(state.attempts[0]?.submission, "started");
    assert.equal(state.attempts[0]?.error, undefined);
    assert.deepEqual(f.errors, []);
    f.workers.status = "blocked";
    await active.reconcile();
    await active.reconcile();
    assert.equal(f.errors.length, 1);
    f.workers.status = "working";
    state = await active.reconcile();
    assert.equal(state.attempts[0]?.error, undefined);
    assert.equal(state.attempts[0]?.attentionHistory?.length, 1);
    await f.workers.produce(request);
    f.workers.status = "idle";
    state = await active.reconcile();
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(state.attempts[0]?.error, undefined);
    assert.match(
      state.attempts[0]?.attentionHistory?.[0]?.detail ?? "",
      /blocked/,
    );
    assert.equal(f.errors.length, 1);
  } finally {
    await f.dispose();
  }
});
