import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"; // oxlint-disable-line effecttsgo/node-builtin-import -- Runtime integration fixtures exercise real host filesystem, Git worktree, and session boundaries.
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Fixture paths identify real host repositories, worktrees, sessions, and retained artifacts.
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Deferred, Effect } from "effect";
import { TestClock } from "effect/testing";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { inspectView } from "../src/agent-facing.js";
import { openRepository } from "../src/git.js";
import {
  type HerdrObservation,
  HerdrProtocolError,
  herdrWorkerName,
  type WorkerLaunchEffectRequest,
  WorkerLaunchError,
  type WorkerRecoveryRequest,
} from "../src/herdr.js";
import { DEFAULT_MODEL_POLICY } from "../src/model-policy.js";
import { liveLayer } from "../src/node-platform.js";
import { processEffect } from "../src/process.js";
import { WorkgraphRegistry } from "../src/registry.js";
import type { WorkerIdentity, WorkerReport } from "../src/types.js";
import { type WorkstreamState, WorkstreamStoreEffects } from "../src/workstream.js";
import { type Lease, SqliteWorkstreamDatabase } from "../src/workstream-persistence.js";
import {
  type RuntimeEffect,
  type RuntimeOwnership,
  WorkstreamRuntime,
} from "../src/workstream-runtime.js";
import { RuntimeHostError } from "../src/workstream-runtime-services.js";
import { WorkstreamStoreOperationError } from "../src/workstream-state.js";
import { required } from "./decoders.js";

const FIXTURE_TIMESTAMP = 1_700_000_000_000;
const FIXTURE_OBSERVED_AT = "2023-11-14T22:13:20.000Z";
const PersistedSqliteRowSchema = Type.Object({ state_json: Type.String() });

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await Effect.runPromise(
    processEffect("git", ["-C", cwd, ...args], {
      cwd,
      timeoutMs: 30_000,
    }),
  );
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

type WorkerEnvironmentVariable =
  | "PI_WORKGRAPH_BASE_COMMIT"
  | "PI_WORKGRAPH_EXECUTOR_MODEL"
  | "PI_WORKGRAPH_EXPERIMENT"
  | "PI_WORKGRAPH_MODE";

type FixtureLaunchRequest = Pick<
  WorkerLaunchEffectRequest,
  | "runId"
  | "nodeId"
  | "attemptId"
  | "assignmentId"
  | "objective"
  | "role"
  | "cwd"
  | "sessionFile"
  | "prompt"
  | "model"
  | "env"
>;

function workerEnvironment(
  request: FixtureLaunchRequest,
  variable: WorkerEnvironmentVariable,
): string {
  return required(request.env[variable], `${variable} environment variable`);
}

function nativeLeaseTimestamp(): number {
  // oxlint-disable-next-line effecttsgo/global-date -- The injected test clock must align with WorkgraphRegistry's native Date lease checks.
  return Date.now();
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
  evidence: [{ label: "file", observation: "value.txt says initial", class: "direct" }],
  findings: [],
};

function fixtureCheckpoint<E, R, A>(
  phase: WorkerLaunchError<E>["phase"],
  checkpoint: ((value: A) => Effect.Effect<void, E, R>) | undefined,
  value: A,
  locator: WorkerLaunchError<E>["locator"],
): Effect.Effect<void, WorkerLaunchError<E>, R> {
  if (checkpoint === undefined) return Effect.void;
  return checkpoint(value).pipe(
    Effect.mapError(
      (cause) =>
        new WorkerLaunchError({
          phase,
          locator,
          resource: "terminalId" in locator ? locator : undefined,
          cause,
        }),
    ),
  );
}

class Worker {
  readonly available = true;
  readonly requests: FixtureLaunchRequest[] = [];
  readonly identities = new Map<string, WorkerIdentity>();
  private readonly producers = new Map<string, () => Promise<void>>();
  promptCount = 0;
  interruptCount = 0;
  deferWork = false;
  absent = false;
  status: HerdrObservation["status"] = "idle";
  failBeforePane = false;
  failBeforeSubmission = false;
  failAfterSubmission = false;
  onWork: (request: FixtureLaunchRequest) => Promise<WorkerReport | undefined> = async () =>
    researchReport;
  onInspect: () => void = () => {};
  readonly launch = <E, R>(request: WorkerLaunchEffectRequest<E, R>) =>
    Effect.gen(
      function* (this: Worker) {
        const index = this.requests.length + 1;
        this.requests.push(request);
        const identity: WorkerIdentity = {
          workspaceId: request.workspaceId,
          tabId: `w1:t${index}`,
          paneId: `w1:p${index}`,
          terminalId: `term${index}`,
          agentName: herdrWorkerName(request),
          sessionFile: request.sessionFile,
          cwd: request.cwd,
        };
        const resource = {
          workspaceId: identity.workspaceId,
          tabId: identity.tabId,
          paneId: identity.paneId,
          terminalId: identity.terminalId,
          agentName: identity.agentName,
          cwd: identity.cwd,
        };
        this.producers.set(request.sessionFile, () => this.produce(request));
        if (this.failBeforePane)
          return yield* new HerdrProtocolError({
            operation: "launch fixture worker",
            reason: "process",
            detail: "fixture tab creation response interrupted",
          });
        const pane = { workspaceId: identity.workspaceId, paneId: identity.paneId };
        yield* fixtureCheckpoint("onTab", request.onTab, pane, pane);
        this.identities.set(identity.agentName, identity);
        yield* fixtureCheckpoint("onResource", request.onResource, resource, resource);
        if (this.failBeforeSubmission)
          return yield* new HerdrProtocolError({
            operation: "launch fixture worker",
            reason: "process",
            detail: "fixture readiness interruption",
          });
        yield* fixtureCheckpoint("onIdentity", request.onIdentity, identity, identity);
        yield* this.deferWork ? Effect.void : this.produceEffect(request.sessionFile);
        if (this.failAfterSubmission)
          return yield* new HerdrProtocolError({
            operation: "launch fixture worker",
            reason: "process",
            detail: "fixture uncertain prompt receipt",
          });
        const onSubmitted = request.onSubmitted;
        yield* fixtureCheckpoint(
          "onSubmitted",
          onSubmitted === undefined ? undefined : () => onSubmitted(),
          undefined,
          resource,
        );
        return { identity, status: "working" as const, observedAt: FIXTURE_OBSERVED_AT };
      }.bind(this),
    );

  readonly recover = (request: WorkerRecoveryRequest) => {
    const identity = [...this.identities.values()].find(
      (item) => item.agentName === request.agentName,
    );
    return identity === undefined ? Effect.as(Effect.void, undefined) : this.observe(identity);
  };

  readonly inspectLaunch = () =>
    Effect.fail(
      new HerdrProtocolError({
        operation: "inspect fixture launch",
        reason: "process",
        detail: "No launch inspection.",
      }),
    );

  readonly inspect = (identity: WorkerIdentity) =>
    Effect.sync(() => {
      this.onInspect();
      return this.absent
        ? {
            identity,
            status: "absent" as const,
            observedAt: FIXTURE_OBSERVED_AT,
            detail: "Exact fixture worker is absent.",
          }
        : this.observation(identity);
    });

  readonly observe = (identity: WorkerIdentity) =>
    this.absent
      ? Effect.fail(
          new HerdrProtocolError({
            operation: "observe fixture worker",
            reason: "process",
            detail: "Exact fixture worker is absent.",
          }),
        )
      : Effect.succeed(this.observation(identity));

  readonly interrupt = (identity: WorkerIdentity) =>
    Effect.sync(() => {
      this.interruptCount++;
      return this.observation(identity);
    });

  readonly steer = (identity: WorkerIdentity) => {
    const produce = this.producers.get(identity.sessionFile);
    if (produce === undefined)
      return Effect.fail(
        new HerdrProtocolError({
          operation: "steer fixture worker",
          reason: "process",
          detail: "No fixture worker request exists for the identity.",
        }),
      );
    return this.produceEffect(identity.sessionFile);
  };

  readonly cleanup = (identity: WorkerIdentity) =>
    Effect.sync(() => {
      if (this.status === "working")
        return {
          state: "pending" as const,
          identity,
          observedAt: FIXTURE_OBSERVED_AT,
          detail: "Fixture worker is still working.",
        };
      if (this.status === "blocked" || this.status === "unknown")
        return {
          state: "blocked" as const,
          identity,
          observedAt: FIXTURE_OBSERVED_AT,
          detail: `Fixture worker is ${this.status}.`,
        };
      return {
        state: "completed" as const,
        identity,
        observedAt: FIXTURE_OBSERVED_AT,
        detail: this.absent ? "Exact fixture worker is absent." : "Exact fixture worker closed.",
      };
    });

  produceEffect(sessionFile: string): Effect.Effect<void, HerdrProtocolError> {
    const produce = this.producers.get(sessionFile);
    if (produce === undefined)
      return Effect.fail(
        new HerdrProtocolError({
          operation: "produce fixture worker",
          reason: "process",
          detail: "No fixture worker request exists for the identity.",
        }),
      );
    return Effect.tryPromise({
      try: produce,
      catch: (cause) =>
        new HerdrProtocolError({
          operation: "produce fixture worker",
          reason: "process",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
  }

  private async produce<E, R>(request: WorkerLaunchEffectRequest<E, R>): Promise<void> {
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
      timestamp: FIXTURE_TIMESTAMP,
    });
    if (report !== undefined)
      session.appendMessage({
        role: "toolResult",
        toolCallId: "report",
        toolName: "workgraph_report",
        content: [{ type: "text", text: "report" }],
        details: { report },
        isError: false,
        timestamp: FIXTURE_TIMESTAMP,
      });
    session.appendCustomEntry("pi-workgraph-agent-settled", {
      runId: request.runId,
      nodeId: request.nodeId,
    });
  }

  private observation(identity: WorkerIdentity): HerdrObservation {
    return { identity, status: this.status, observedAt: FIXTURE_OBSERVED_AT };
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
  const repository = await Effect.runPromise(openRepository(root));
  const session = SessionManager.create(root, join(parent, "sessions"));
  session.appendMessage({
    role: "user",
    content: "UNRELATED_PARENT_SECRET",
    timestamp: FIXTURE_TIMESTAMP,
  });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "parent" }],
    api: "test",
    provider: "test",
    model: "parent",
    usage,
    stopReason: "stop",
    timestamp: FIXTURE_TIMESTAMP,
  });
  const sessionFile = session.getSessionFile() ?? assert.fail("Fixture session must persist.");
  const owner = { sessionId: session.getSessionId(), sessionFile };
  const { store } = await Effect.runPromise(
    WorkstreamStoreEffects.create({
      id: "ws-fixture",
      purpose: "Investigate and implement the authorized fixture",
      projectRoot: root,
      gitCommonDir: repository.commonDir,
      coordinator: owner,
    }).pipe(Effect.provide(liveLayer)),
  );
  const registry = new WorkgraphRegistry(join(parent, "registry.sqlite"));
  const workers = new Worker();
  const delivered: string[] = [];
  const errors: string[] = [];
  const runtimes: WorkstreamRuntime[] = [];
  async function runtime(
    onResult: (id: string, state: WorkstreamState) => Effect.Effect<void, RuntimeHostError> = (
      id,
    ) =>
      Effect.sync(() => {
        delivered.push(id);
      }),
    options: RuntimeOwnership = {},
  ) {
    const value = await Effect.runPromise(
      WorkstreamRuntime.acquire(
        store,
        repository,
        workers,
        { workspaceId: "w1" },
        onResult,
        (error) =>
          Effect.sync(() => {
            errors.push(error.message);
          }),
        { registry, policy: DEFAULT_MODEL_POLICY, ...options },
      ).pipe(Effect.provide(liveLayer)),
    );
    runtimes.push(value);
    return value;
  }
  async function authority(active: WorkstreamRuntime) {
    return submit(
      active,
      Effect.gen(function* () {
        const recorded = yield* store.recordInputEvent({
          ...owner,
          source: "interactive",
          text: "Implement value.txt and run bounded disposable experiments in this repository.",
        });
        yield* store.reviseIntent({
          authorityReceiptId: recorded.receipt.id,
          statement: "Change fixture safely",
          constraints: [],
        });
        return { receiptId: recorded.receipt.id, intentVersion: 1 };
      }),
    );
  }
  async function dispose(ignoreCloseErrors = false) {
    const closed = await Promise.allSettled(
      runtimes.map((active) => runRuntime(active.effects.close)),
    );
    registry.close();
    await rm(parent, { recursive: true, force: true });
    if (!ignoreCloseErrors && closed.some((result) => result.status === "rejected"))
      throw new Error("Runtime close failed during fixture disposal.");
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
function runRuntime<A, E>(effect: RuntimeEffect<A, E> | Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(liveLayer)));
}
function submit<A, E>(active: WorkstreamRuntime, effect: RuntimeEffect<A, E>): Promise<A> {
  return runRuntime(active.effects.submit(effect));
}

const research = (id: string, intentVersion = 0) => ({
  id,
  capability: "research" as const,
  artifactIntent: "evidence_only" as const,
  objective: "Inspect value.txt",
  intentVersion,
  expectedEvidence: ["File evidence"],
});

await test("multi-attempt queueing resolves one shared validated base and exact-review conflicts have no effects", async () => {
  const f = await fixture();
  try {
    const policy = structuredClone(DEFAULT_MODEL_POLICY);
    policy.roles.research = [
      { model: "fixture/research-first", thinking: "high" },
      { model: "fixture/research-second", thinking: "high" },
    ];
    const active = await f.runtime(undefined, { policy });
    const initial = await runRuntime(f.repository.head());
    const queued = await runRuntime(
      active.effects.queue(research("shared-base"), {
        selection: { count: 2, diversity: "distinct-models" },
      }),
    );
    assert.deepEqual(
      queued.attempts.map((attempt) => attempt.baseRevision),
      [undefined, undefined],
    );
    await writeFile(join(f.root, "moved.txt"), "moved\n");
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-m", "move head");
    const moved = await runRuntime(f.repository.head());
    assert.notEqual(moved, initial);
    const retainedBefore = (await runRuntime(f.store.load())).assignments.length;
    await assert.rejects(
      runRuntime(
        active.effects.queue(
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
      ),
      /conflicts with its exact subject/,
    );
    const state = await runRuntime(f.store.load());
    assert.equal(state.assignments.length, retainedBefore);
    assert.equal(state.attempts.length, 2);

    const directReview = await runRuntime(
      active.effects.queue(
        {
          id: "direct-review",
          capability: "review",
          artifactIntent: "evidence_only",
          objective: "Review the exact existing revision",
          intentVersion: 0,
          subject: { kind: "revision", revision: initial },
          concern: "Inspect this commit directly",
        },
        {},
      ),
    );
    const directAssignment = directReview.assignments.at(-1);
    assert.equal(directAssignment?.id, "direct-review");
    assert.equal(directReview.attempts.at(-1)?.baseRevision, initial);
    await assert.rejects(
      runRuntime(
        active.effects.queue(
          {
            id: "missing-direct-review",
            capability: "review",
            artifactIntent: "evidence_only",
            objective: "Review a missing revision",
            intentVersion: 0,
            subject: { kind: "revision", revision: "f".repeat(40) },
            concern: "Must refuse before queueing",
          },
          {},
        ),
      ),
      /git|revision|resolve/i,
    );
    const afterMissing = await runRuntime(f.store.load());
    assert.equal(
      afterMissing.assignments.some((item) => item.id === "missing-direct-review"),
      false,
    );
  } finally {
    await f.dispose();
  }
});

await test("direct exact revision review uses an owned exact-base checkout", async () => {
  const f = await fixture();
  try {
    const base = await git(f.root, "rev-parse", "HEAD");
    const oldBytes = await readFile(join(f.root, "value.txt"), "utf8");
    await writeFile(join(f.root, "value.txt"), "advanced destination\n");
    await git(f.root, "add", "value.txt");
    await git(f.root, "commit", "-m", "Advance destination");
    const destinationHead = await git(f.root, "rev-parse", "HEAD");
    const destinationBytes = "uncommitted destination\n";
    await writeFile(join(f.root, "value.txt"), destinationBytes);
    f.workers.onWork = async (request) => {
      assert.notEqual(request.cwd, f.root);
      assert.equal(await git(request.cwd, "rev-parse", "HEAD"), base);
      assert.equal(await readFile(join(request.cwd, "value.txt"), "utf8"), oldBytes);
      assert.equal(await git(request.cwd, "status", "--porcelain"), "");
      assert.equal(await git(f.root, "rev-parse", "HEAD"), destinationHead);
      assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), destinationBytes);
      return {
        kind: "review",
        status: "completed",
        summary: "Reviewed the exact existing revision.",
        evidence: [
          {
            label: "exact checkout",
            observation: `The worker checkout was rooted at ${base} with the selected historical bytes.`,
            class: "direct",
          },
        ],
        findings: [],
      };
    };
    const active = await f.runtime();
    const queued = await runRuntime(
      active.effects.queue(
        {
          id: "direct-exact-review",
          capability: "review",
          artifactIntent: "evidence_only",
          objective: "Review the exact existing revision directly",
          intentVersion: 0,
          subject: { kind: "revision", revision: base },
          concern: "Inspect only the exact commit",
        },
        {},
      ),
    );
    assert.equal(queued.results.length, 0);
    assert.equal(queued.attempts.at(-1)?.baseRevision, base);
    await runRuntime(active.effects.reconcile);
    await runRuntime(active.effects.reconcile);
    const state = await runRuntime(f.store.load());
    assert.equal(state.results[0]?.validity, "typed");
    assert.equal(
      state.results[0]?.validity === "typed" ? state.results[0].report.kind : undefined,
      "review",
    );
    assert.equal(state.attempts[0]?.baseRevision, base);
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(state.attempts[0]?.placement?.kind, "isolated_worktree");
    const outcome = inspectView(state, {
      section: "outcome",
      result: required(state.results[0], "exact-review result").id,
    });
    if (!("settlement" in outcome)) throw new Error("Expected exact-review outcome projection");
    assert.equal(outcome.settlement.retainedOutput.state, "not_applicable");
    const recovery = inspectView(state, {
      section: "recovery",
      attempt: required(state.attempts[0], "exact-review attempt").id,
    });
    if (!("guardedActions" in recovery) || !("recordedFacts" in recovery))
      throw new Error("Expected exact-review recovery projection");
    assert.equal(recovery.recordedFacts.retainedOutput.state, "not_applicable");
    assert.deepEqual(recovery.guardedActions, []);
    const exactPlacement = required(state.attempts[0], "exact-review attempt").placement;
    if (exactPlacement?.kind !== "isolated_worktree")
      throw new Error("Expected exact-review isolated placement");
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(exactPlacement.path),
      false,
    );
    assert.equal(await git(f.root, "rev-parse", "HEAD"), destinationHead);
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), destinationBytes);
  } finally {
    await f.dispose();
  }
});

await test("new runtime drives fresh research through native evidence, durable retryable delivery and exact Git cleanup", async () => {
  const f = await fixture();
  try {
    const first = await f.runtime(() =>
      Effect.fail(
        new RuntimeHostError({
          operation: "fixture notification",
          cause: new Error("notification interrupted"),
        }),
      ),
    );
    await runRuntime(first.effects.queue(research("inspect")));
    await runRuntime(first.effects.reconcile);
    const request = f.workers.requests[0];
    assert.ok(request);
    assert.equal(request.assignmentId, "inspect");
    assert.equal(request.objective, "Inspect value.txt");
    assert.equal(request.role, "research");
    assert.equal(request.cwd, f.root);
    assert.ok(required(request.prompt, "generated worker prompt").includes(f.root));
    const session = await readFile(request.sessionFile, "utf8");
    assert.ok(session.includes(f.root));
    assert.ok(session.includes("File evidence"));
    assert.equal(session.includes("UNRELATED_PARENT_SECRET"), false);
    let state = await runRuntime(first.effects.reconcile);
    assert.equal(state.results[0]?.validity, "typed");
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(state.deliveries[0]?.state, "pending");
    assert.equal(state.attempts[0]?.effectiveModels?.[0]?.model, "test/worker");
    await runRuntime(first.effects.reconcile);
    assert.equal(f.workers.promptCount, 1);
    await runRuntime(first.effects.close);
    const next = await f.runtime();
    state = await runRuntime(next.effects.reconcile);
    assert.equal(state.results.length, 1);
    assert.equal(state.deliveries[0]?.state, "delivered");
    assert.deepEqual(f.delivered, [state.results[0]?.id]);
    assert.ok(state.results[0], "delivered result");
    await runRuntime(next.effects.reconcile);
    assert.equal(f.delivered.length, 1);
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).split("worktree ").length - 1,
      1,
    );
  } finally {
    await f.dispose();
  }
});

await test("shared research sees dirty tracked and untracked files and leaves them untouched after closure and retry", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "value.txt"), "local tracked edit\\n");
    const local = join(f.root, "local-untracked.txt");
    await writeFile(local, "local untracked edit\\n");
    f.workers.onWork = async (request) => {
      assert.equal(request.cwd, f.root);
      assert.equal(await readFile(join(request.cwd, "value.txt"), "utf8"), "local tracked edit\\n");
      assert.equal(
        await readFile(join(request.cwd, "local-untracked.txt"), "utf8"),
        "local untracked edit\\n",
      );
      return researchReport;
    };
    const active = await f.runtime();
    await runRuntime(active.effects.queue(research("dirty-shared")));
    await runRuntime(active.effects.reconcile);
    let state = await runRuntime(active.effects.reconcile);
    assert.equal(state.attempts[0]?.placement?.kind, "shared_project");
    assert.equal(state.attempts[0]?.placement?.path, f.root);
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "local tracked edit\\n");
    assert.equal(await readFile(local, "utf8"), "local untracked edit\\n");
    await runRuntime(active.effects.close);
    const retry = await f.runtime();
    state = await runRuntime(retry.effects.reconcile);
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "local tracked edit\\n");
    assert.equal(await readFile(local, "utf8"), "local untracked edit\\n");
  } finally {
    await f.dispose();
  }
});

await test("completed no-change implementations retain explicit attribution, skip application, and clean only the isolated worker", async () => {
  const f = await fixture();
  try {
    const active = await f.runtime();
    const authority = await f.authority(active);
    const base = await runRuntime(f.repository.head());
    const before = await readFile(join(f.root, "value.txt"), "utf8");
    f.workers.onWork = async (request) => ({
      kind: "implementation",
      status: "completed",
      outcome: "no_change",
      summary: "No source change was needed.",
      revision: workerEnvironment(request, "PI_WORKGRAPH_BASE_COMMIT"),
      reason: "The requested behavior already holds on the inspected base.",
      evidence: [
        {
          label: "Git base",
          observation: workerEnvironment(request, "PI_WORKGRAPH_BASE_COMMIT"),
        },
      ],
      findings: [],
    });
    await runRuntime(
      active.effects.queue({
        id: "already-holds",
        capability: "implement",
        artifactIntent: "maintained_change",
        objective: "Confirm the existing behavior without changing source",
        intentVersion: 1,
        authority,
        acceptance: ["Existing behavior remains correct"],
      }),
    );
    await runRuntime(active.effects.reconcile);
    const state = await runRuntime(active.effects.reconcile);
    const attempt = required(state.attempts[0], "no-change attempt");
    const result = required(state.results[0], "no-change result");
    assert.equal(result.validity, "typed");
    assert.ok(result.report.kind === "implementation" && result.report.status === "completed");
    assert.equal(result.report.outcome, "no_change");
    assert.equal(result.report.revision, base);
    assert.equal(attempt.application, undefined);
    assert.equal(attempt.cleanup?.state, "completed");
    assert.equal(await runRuntime(f.repository.head()), base);
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), before);
    const outcome = inspectView(state, {
      section: "outcome",
      result: result.id,
    });
    if (!("settlement" in outcome)) throw new Error("Expected no-change outcome projection");
    assert.equal(outcome.settlement.application.state, "not_applicable");
    assert.equal(outcome.settlement.retainedOutput.state, "not_applicable");
    const recovery = inspectView(state, {
      section: "recovery",
      attempt: attempt.id,
    });
    if (!("guardedActions" in recovery) || !("recordedFacts" in recovery))
      throw new Error("Expected no-change recovery projection");
    assert.equal(recovery.recordedFacts.retainedOutput.state, "not_applicable");
    assert.deepEqual(recovery.guardedActions, []);
    const worktrees = await git(f.root, "worktree", "list", "--porcelain");
    assert.equal(worktrees.includes(attempt.placement?.path ?? ""), false);
  } finally {
    await f.dispose();
  }
});

await test("dirty isolated trees cannot settle a successful no-change implementation", async () => {
  const f = await fixture();
  try {
    const active = await f.runtime();
    const authority = await f.authority(active);
    const base = await runRuntime(f.repository.head());
    f.workers.onWork = async (request) => {
      await writeFile(join(request.cwd, "unreported.txt"), "dirty\n");
      return {
        kind: "implementation",
        status: "completed",
        outcome: "no_change",
        summary: "No source change was needed.",
        revision: workerEnvironment(request, "PI_WORKGRAPH_BASE_COMMIT"),
        reason: "The source already holds.",
        evidence: [],
        findings: [],
      };
    };
    await runRuntime(
      active.effects.queue({
        id: "false-no-change",
        capability: "implement",
        artifactIntent: "maintained_change",
        objective: "Confirm behavior",
        intentVersion: 1,
        authority,
        acceptance: ["Existing behavior remains correct"],
      }),
    );
    await runRuntime(active.effects.reconcile);
    const state = await runRuntime(active.effects.reconcile);
    assert.equal(state.results[0]?.validity, "invalid");
    assert.equal(state.attempts[0]?.application, undefined);
    assert.equal(state.attempts[0]?.cleanup?.state, "blocked");
    assert.equal(await runRuntime(f.repository.head()), base);
  } finally {
    await f.dispose();
  }
});

await test("advanced isolated trees cannot settle a successful no-change implementation", async () => {
  const f = await fixture();
  try {
    const active = await f.runtime();
    const authority = await f.authority(active);
    const base = await runRuntime(f.repository.head());
    f.workers.onWork = async (request) => {
      await writeFile(join(request.cwd, "value.txt"), "advanced\n");
      await git(request.cwd, "add", "value.txt");
      await git(request.cwd, "commit", "-m", "unreported worker change");
      return {
        kind: "implementation",
        status: "completed",
        outcome: "no_change",
        summary: "No source change was needed.",
        revision: workerEnvironment(request, "PI_WORKGRAPH_BASE_COMMIT"),
        reason: "The source already holds.",
        evidence: [],
        findings: [],
      };
    };
    await runRuntime(
      active.effects.queue({
        id: "advanced-no-change",
        capability: "implement",
        artifactIntent: "maintained_change",
        objective: "Confirm behavior",
        intentVersion: 1,
        authority,
        acceptance: ["Existing behavior remains correct"],
      }),
    );
    await runRuntime(active.effects.reconcile);
    const state = await runRuntime(active.effects.reconcile);
    assert.equal(state.results[0]?.validity, "invalid");
    assert.equal(state.attempts[0]?.application, undefined);
    assert.equal(state.attempts[0]?.cleanup?.state, "blocked");
    assert.equal(await runRuntime(f.repository.head()), base);
  } finally {
    await f.dispose();
  }
});

await test("implementation role overrides resolve independently and invalid model inputs do not queue", async () => {
  const f = await fixture();
  try {
    const policy = structuredClone(DEFAULT_MODEL_POLICY);
    policy.roles["implementation.guide"] = {
      model: "fixture/guide-default",
      thinking: "high",
    };
    policy.roles["implementation.executor"] = {
      model: "fixture/executor-default",
      thinking: "medium",
    };
    const active = await f.runtime(undefined, { policy });
    const authority = await f.authority(active);
    const assignment = {
      id: "independent-role-overrides",
      capability: "implement" as const,
      artifactIntent: "maintained_change" as const,
      objective: "Change value",
      intentVersion: authority.intentVersion,
      authority,
      acceptance: ["value changes"],
    };
    await runRuntime(
      active.effects.queue(assignment, {
        models: {
          guide: { thinking: "low" },
          executor: { model: "fixture/executor-override" },
        },
      }),
    );
    let state = await runRuntime(f.store.load());
    assert.deepEqual(state.attempts[0]?.models, {
      guide: { model: "fixture/guide-default", thinking: "low" },
      executor: { model: "fixture/executor-override", thinking: "medium" },
      source: "override",
    });
    assert.equal(f.workers.requests.length, 0);

    await assert.rejects(
      runRuntime(
        active.effects.queue(
          { ...assignment, id: "empty-role-overrides" },
          { models: { guide: {} } },
        ),
      ),
      /Invalid model queue options/,
    );
    state = await runRuntime(f.store.load());
    assert.equal(state.assignments.length, 1);
    assert.equal(state.attempts.length, 1);
    assert.equal(f.workers.requests.length, 0);
  } finally {
    await f.dispose();
  }
});

await test("maintained changes keep semantic identity, use guide/executor policy, and review the requested earlier revision", async () => {
  const f = await fixture();
  try {
    const active = await f.runtime();
    const authority = await f.authority(active);
    const semanticId = "Fix Value With Spaces and a deliberately long task name";
    f.workers.onWork = async (request) => {
      if (workerEnvironment(request, "PI_WORKGRAPH_MODE") === "implementation") {
        assert.equal(request.model, "openai-codex/gpt-6-astra");
        assert.equal(
          workerEnvironment(request, "PI_WORKGRAPH_EXECUTOR_MODEL"),
          "openai-codex/gpt-5.6-luna",
        );
        assert.equal(
          workerEnvironment(request, "PI_WORKGRAPH_BASE_COMMIT"),
          await git(request.cwd, "rev-parse", "HEAD"),
        );
        await writeFile(join(request.cwd, "value.txt"), "maintained\n");
        await git(request.cwd, "add", ".");
        await git(request.cwd, "commit", "-m", "maintained change");
        return {
          kind: "implementation",
          status: "completed",
          outcome: "changed",
          summary: "Changed value",
          commit: await git(request.cwd, "rev-parse", "HEAD"),
          evidence: [],
          findings: [],
        };
      }
      assert.equal(
        await git(
          request.cwd,
          "show",
          `${workerEnvironment(request, "PI_WORKGRAPH_BASE_COMMIT")}:value.txt`,
        ),
        "maintained",
      );
      assert.notEqual(request.cwd, f.root);
      assert.equal(
        await git(request.cwd, "rev-parse", "HEAD"),
        workerEnvironment(request, "PI_WORKGRAPH_BASE_COMMIT"),
      );
      assert.equal(await readFile(join(request.cwd, "value.txt"), "utf8"), "maintained\n");
      return {
        kind: "review",
        status: "completed",
        summary: "Reviewed exact old revision",
        evidence: [],
        findings: [],
      };
    };
    await runRuntime(
      active.effects.queue({
        id: semanticId,
        capability: "implement",
        artifactIntent: "maintained_change",
        objective: "Change value",
        intentVersion: 1,
        authority,
        acceptance: ["value is maintained"],
      }),
    );
    await runRuntime(active.effects.reconcile);
    let state = await runRuntime(active.effects.reconcile);
    const implementationAttempt = required(state.attempts[0], "implementation attempt");
    const implementationResult = required(state.results[0], "implementation result");
    assert.equal(state.assignments[0]?.id, semanticId);
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "initial\n");
    assert.equal(implementationResult.validity, "typed");
    if (
      implementationResult.validity !== "typed" ||
      implementationResult.report.kind !== "implementation" ||
      implementationResult.report.status !== "completed" ||
      implementationResult.report.outcome !== "changed"
    )
      assert.fail("Expected changed implementation report.");
    state = await runRuntime(active.effects.apply(implementationAttempt.id));
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "maintained\n");
    const revision =
      state.attempts[0]?.application?.revision ??
      assert.fail("Application revision must be present.");
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    await writeFile(join(f.root, "value.txt"), "later\n");
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-m", "later unrelated change");
    await runRuntime(
      active.effects.queue({
        id: "review",
        capability: "review",
        artifactIntent: "evidence_only",
        objective: "Review maintained change",
        intentVersion: 1,
        subject: { kind: "revision", revision },
        concern: "Exact content",
      }),
    );
    await runRuntime(active.effects.reconcile);
    state = await runRuntime(active.effects.reconcile);
    assert.equal(state.attempts[1]?.baseRevision, revision);
    assert.equal(state.attempts[1]?.placement?.kind, "isolated_worktree");
    assert.equal(state.results[1]?.validity, "typed");
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "later\n");
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(
        state.attempts[1]?.placement?.path ?? "",
      ),
      false,
    );
  } finally {
    await f.dispose();
  }
});

await test("unapplied candidate revisions are reviewed in their retained exact worktree", async () => {
  const f = await fixture();
  try {
    const active = await f.runtime();
    const authority = await f.authority(active);
    f.workers.onWork = async (request) => {
      if (workerEnvironment(request, "PI_WORKGRAPH_MODE") === "review") {
        assert.notEqual(request.cwd, f.root);
        assert.equal(
          await git(request.cwd, "rev-parse", "HEAD"),
          workerEnvironment(request, "PI_WORKGRAPH_BASE_COMMIT"),
        );
        assert.equal(await readFile(join(request.cwd, "value.txt"), "utf8"), "candidate\n");
        return {
          kind: "review",
          status: "completed",
          summary: "Reviewed retained candidate",
          evidence: [],
          findings: [],
        };
      }
      await writeFile(join(request.cwd, "value.txt"), "candidate\n");
      await git(request.cwd, "add", ".");
      await git(request.cwd, "commit", "-m", "Candidate");
      return {
        kind: "implementation",
        status: "completed",
        outcome: "changed",
        summary: "Created candidate",
        commit: await git(request.cwd, "rev-parse", "HEAD"),
        evidence: [],
        findings: [],
      };
    };
    await runRuntime(
      active.effects.queue({
        id: "candidate",
        capability: "implement",
        artifactIntent: "maintained_change",
        objective: "Create a candidate",
        intentVersion: 1,
        authority,
        acceptance: ["candidate exists"],
      }),
    );
    await runRuntime(active.effects.reconcile);
    let state = await runRuntime(active.effects.reconcile);
    const result = required(state.results[0], "candidate result");
    const commit =
      result.validity === "typed" &&
      result.report.kind === "implementation" &&
      result.report.status === "completed" &&
      result.report.outcome === "changed"
        ? required(result.report.commit, "candidate commit")
        : assert.fail("Expected a changed candidate.");
    await runRuntime(
      active.effects.queue({
        id: "candidate-review",
        capability: "review",
        artifactIntent: "evidence_only",
        objective: "Review the unapplied candidate",
        intentVersion: 1,
        subject: { kind: "revision", revision: commit },
        concern: "Candidate bytes",
      }),
    );
    await runRuntime(active.effects.reconcile);
    state = await runRuntime(active.effects.reconcile);
    assert.equal(state.attempts[1]?.baseRevision, commit);
    assert.equal(state.attempts[1]?.placement?.kind, "isolated_worktree");
    assert.equal(state.attempts[1]?.cleanup?.state, "completed");
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "initial\n");
  } finally {
    await f.dispose();
  }
});

await test("retained candidate corrections apply their complete history and keep the parent output", async () => {
  const f = await fixture();
  try {
    const active = await f.runtime();
    const authority = await f.authority(active);
    f.workers.onWork = async (request) => {
      if (workerEnvironment(request, "PI_WORKGRAPH_MODE") === "review")
        return {
          kind: "review",
          status: "completed",
          summary: "Reviewed candidate revision",
          evidence: [],
          findings: [],
        };
      const value = f.workers.requests.length === 1 ? "first\n" : "corrected\n";
      await writeFile(join(request.cwd, "value.txt"), value);
      await git(request.cwd, "add", ".");
      await git(request.cwd, "commit", "-m", value.trim());
      return {
        kind: "implementation",
        status: "completed",
        outcome: "changed",
        summary: "Changed value",
        commit: await git(request.cwd, "rev-parse", "HEAD"),
        evidence: [],
        findings: [],
      };
    };
    const base = await runRuntime(f.repository.head());
    await runRuntime(
      active.effects.queue({
        id: "first",
        capability: "implement",
        artifactIntent: "maintained_change",
        objective: "Make the first candidate",
        intentVersion: 1,
        authority,
        acceptance: ["value changes"],
      }),
    );
    await runRuntime(active.effects.reconcile);
    let state = await runRuntime(active.effects.reconcile);
    const firstAttempt = required(state.attempts[0], "first candidate attempt");
    const firstResult = required(state.results[0], "first candidate result");
    const firstCommit =
      firstResult.validity === "typed" &&
      firstResult.report.kind === "implementation" &&
      firstResult.report.status === "completed" &&
      firstResult.report.outcome === "changed"
        ? required(firstResult.report.commit, "first candidate commit")
        : assert.fail("First candidate must be a changed implementation.");
    assert.deepEqual(firstAttempt.candidate, { kind: "initial", rootCommit: base });
    const parentPath =
      firstAttempt.placement?.kind === "isolated_worktree"
        ? firstAttempt.placement.path
        : assert.fail("First candidate must retain an isolated worktree.");

    // SAFETY: This fixture updates only the known SQLite aggregate row to remove optional candidate metadata.
    const persistedRow = SqliteWorkstreamDatabase.use(f.store.path, (database) =>
      database.db.prepare("SELECT state_json FROM workstream_state WHERE singleton=1").get(),
    );
    assert.ok(Value.Check(PersistedSqliteRowSchema, persistedRow));
    // SAFETY: The validated SQLite aggregate row contains the JSON object whose attempts array is inspected only to remove optional metadata.
    const persisted = JSON.parse(
      Value.Decode(PersistedSqliteRowSchema, persistedRow).state_json,
    ) as {
      attempts: Array<{ id: string; candidate?: unknown }>;
    };
    const persistedParent = persisted.attempts.find((attempt) => attempt.id === firstAttempt.id);
    assert.ok(persistedParent !== undefined);
    delete persistedParent.candidate;
    SqliteWorkstreamDatabase.use(f.store.path, (database) => {
      database.db
        .prepare("UPDATE workstream_state SET state_json=? WHERE singleton=1")
        .run(JSON.stringify(persisted));
    });

    await runRuntime(
      active.effects.queue(
        {
          id: "correction",
          capability: "implement",
          artifactIntent: "maintained_change",
          objective: "Correct the first candidate",
          intentVersion: 1,
          authority,
          acceptance: ["value is corrected"],
        },
        { candidateOf: firstAttempt.id },
      ),
    );
    await runRuntime(active.effects.reconcile);
    state = await runRuntime(active.effects.reconcile);
    const correctionAttempt = required(state.attempts[1], "correction attempt");
    const correctionResult = required(state.results[1], "correction result");
    const correctionCommit =
      correctionResult.validity === "typed" &&
      correctionResult.report.kind === "implementation" &&
      correctionResult.report.status === "completed" &&
      correctionResult.report.outcome === "changed"
        ? required(correctionResult.report.commit, "correction commit")
        : assert.fail("Correction must be a changed implementation.");
    assert.deepEqual(correctionAttempt.candidate, {
      kind: "correction",
      rootCommit: base,
      parentAttemptId: firstAttempt.id,
      parentCommit: firstCommit,
    });
    assert.equal(correctionAttempt.baseRevision, firstCommit);
    assert.equal(await runRuntime(f.repository.head()), base);

    await runRuntime(
      active.effects.queue({
        id: "correction-review",
        capability: "review",
        artifactIntent: "evidence_only",
        objective: "Review the retained correction before application",
        intentVersion: 1,
        subject: { kind: "revision", revision: correctionCommit },
        concern: "Exact correction history",
      }),
    );
    await runRuntime(active.effects.reconcile);
    state = await runRuntime(active.effects.reconcile);
    assert.equal(state.attempts[2]?.cleanup?.state, "completed");
    assert.equal(state.results[2]?.validity, "typed");

    const beforeApplyBytes = await readFile(join(f.root, "value.txt"), "utf8");
    const fixtureDirt = join(f.root, "apply-dirty.txt");
    await writeFile(fixtureDirt, "fixture-owned dirt\n");
    const dirtyHead = await runRuntime(f.repository.head());
    await assert.rejects(
      runRuntime(active.effects.apply(correctionAttempt.id)),
      /Git working tree is not clean/,
    );
    state = await runRuntime(f.store.load());
    assert.equal(state.attempts[1]?.application, undefined);
    assert.equal(await runRuntime(f.repository.head()), dirtyHead);
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), beforeApplyBytes);
    assert.equal(await readFile(fixtureDirt, "utf8"), "fixture-owned dirt\n");
    const correctionPath =
      correctionAttempt.placement?.kind === "isolated_worktree"
        ? correctionAttempt.placement.path
        : assert.fail("Correction must retain its worktree before application.");
    assert.match(await git(f.root, "worktree", "list", "--porcelain"), new RegExp(correctionPath));

    await rm(fixtureDirt);
    assert.equal(await runRuntime(f.repository.status()), "");
    state = await runRuntime(active.effects.apply(correctionAttempt.id));
    assert.equal(await runRuntime(f.repository.head()), correctionCommit);
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "corrected\n");
    assert.equal(await git(f.root, "rev-list", "--count", `${base}..HEAD`), "2");
    assert.equal(await git(f.root, "rev-parse", `${correctionCommit}^`), firstCommit);
    assert.deepEqual(state.attempts[1]?.application?.commits, [firstCommit, correctionCommit]);
    assert.equal(state.attempts[1]?.application?.rootCommit, base);
    assert.equal(state.attempts[0]?.candidate, undefined);
    assert.equal(state.attempts[1]?.outputRelease?.state, "completed");
    const completed = await runRuntime(
      active.effects.submit(
        f.store.complete({
          conclusion: "The correction chain is complete.",
          evidence: [
            { label: "chain", observation: "The applied candidate retained both commits." },
          ],
          limitations: [],
        }),
      ),
    );
    assert.equal(completed.lifecycle.state, "completed");
    assert.deepEqual(completed.completion?.accounting, []);
    assert.match(await git(f.root, "worktree", "list", "--porcelain"), new RegExp(parentPath));
    assert.doesNotMatch(
      await git(f.root, "worktree", "list", "--porcelain"),
      new RegExp(state.attempts[1]?.placement?.path ?? "\\bdoes-not-exist\\b"),
    );
  } finally {
    await f.dispose();
  }
});

await test("moved candidate application is blocked without mutation and supports explicit integration from current base", async () => {
  const f = await fixture();
  try {
    const active = await f.runtime();
    const authority = await f.authority(active);
    f.workers.onWork = async (request) => {
      const value = f.workers.requests.length === 1 ? "candidate\n" : "integrated\n";
      await writeFile(join(request.cwd, "value.txt"), value);
      await git(request.cwd, "add", ".");
      await git(request.cwd, "commit", "-m", value.trim());
      return {
        kind: "implementation",
        status: "completed",
        outcome: "changed",
        summary: "Changed value",
        commit: await git(request.cwd, "rev-parse", "HEAD"),
        evidence: [],
        findings: [],
      };
    };
    const original = await runRuntime(f.repository.head());
    await runRuntime(
      active.effects.queue({
        id: "candidate",
        capability: "implement",
        artifactIntent: "maintained_change",
        objective: "Make a candidate",
        intentVersion: 1,
        authority,
        acceptance: ["candidate value"],
      }),
    );
    await runRuntime(active.effects.reconcile);
    let state = await runRuntime(active.effects.reconcile);
    const parent = required(state.attempts[0], "retained candidate");
    const result = required(state.results[0], "retained candidate result");
    const parentCommit =
      result.validity === "typed" &&
      result.report.kind === "implementation" &&
      result.report.status === "completed" &&
      result.report.outcome === "changed"
        ? required(result.report.commit, "retained candidate commit")
        : assert.fail("Expected changed candidate.");
    const parentPath =
      parent.placement?.kind === "isolated_worktree"
        ? parent.placement.path
        : assert.fail("Candidate must retain its worktree.");

    await writeFile(join(f.root, "value.txt"), "moved\n");
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-m", "Move destination");
    const moved = await runRuntime(f.repository.head());
    await assert.rejects(
      runRuntime(active.effects.apply(parent.id)),
      /Destination HEAD .*candidate root/,
    );
    state = await runRuntime(f.store.load());
    assert.equal(state.attempts[0]?.application, undefined);
    assert.equal(await runRuntime(f.repository.head()), moved);
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "moved\n");
    assert.match(await git(f.root, "worktree", "list", "--porcelain"), new RegExp(parentPath));

    await runRuntime(
      active.effects.queue(
        {
          id: "integration",
          capability: "implement",
          artifactIntent: "maintained_change",
          objective: "Integrate candidate content into the moved base",
          intentVersion: 1,
          authority,
          acceptance: ["integrated value"],
        },
        { candidateOf: parent.id, baseRevision: moved },
      ),
    );
    await runRuntime(active.effects.reconcile);
    state = await runRuntime(active.effects.reconcile);
    const integration = required(state.attempts[1], "integration attempt");
    const integrationResult = required(state.results[1], "integration result");
    const integrationCommit =
      integrationResult.validity === "typed" &&
      integrationResult.report.kind === "implementation" &&
      integrationResult.report.status === "completed" &&
      integrationResult.report.outcome === "changed"
        ? required(integrationResult.report.commit, "integration commit")
        : assert.fail("Expected changed integration.");
    assert.deepEqual(integration.candidate, {
      kind: "integration",
      rootCommit: moved,
      parentAttemptId: parent.id,
      parentCommit,
    });
    assert.equal(integration.baseRevision, moved);
    assert.equal(await runRuntime(f.repository.head()), moved);
    state = await runRuntime(active.effects.apply(integration.id));
    assert.equal(await runRuntime(f.repository.head()), integrationCommit);
    assert.equal(await git(f.root, "rev-list", "--count", `${moved}..HEAD`), "1");
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "integrated\n");
    assert.equal(state.attempts[1]?.application?.rootCommit, moved);
    assert.deepEqual(state.attempts[1]?.application?.commits, [integrationCommit]);
    assert.match(await git(f.root, "worktree", "list", "--porcelain"), new RegExp(parentPath));
    assert.notEqual(original, moved);
  } finally {
    await f.dispose();
  }
});

await test("wrong-mode and stale maintained results remain retained without application or destructive cleanup", async () => {
  const f = await fixture();
  try {
    const active = await f.runtime();
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
    await runRuntime(active.effects.queue(input("wrong-mode")));
    await runRuntime(active.effects.reconcile);
    let state = await runRuntime(active.effects.reconcile);
    assert.equal(state.results[0]?.validity, "invalid");
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(state.attempts[0]?.cleanup?.workerClosed, true);
    f.workers.onWork = async (request) => {
      await writeFile(join(request.cwd, "value.txt"), "stale\n");
      await git(request.cwd, "add", ".");
      await git(request.cwd, "commit", "-m", "stale change");
      return {
        kind: "implementation",
        status: "completed",
        outcome: "changed",
        summary: "old constraint",
        evidence: [],
        findings: [],
        commit: await git(request.cwd, "rev-parse", "HEAD"),
      };
    };
    await runRuntime(active.effects.queue(input("stale")));
    await runRuntime(active.effects.reconcile);
    await submit(
      active,
      f.store.reviseIntent({
        authorityReceiptId: authority.receiptId,
        statement: "New constraints",
        constraints: ["Do not apply old value"],
      }),
    );
    state = await runRuntime(active.effects.reconcile);
    assert.equal(state.results[1]?.validity, "typed");
    assert.equal(state.attempts[1]?.application, undefined);
    assert.equal(state.attempts[1]?.cleanup?.state, "completed");
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "initial\n");
    const completed = await submit(
      active,
      f.store.complete({
        conclusion: "done",
        evidence: [{ label: "limit", observation: "Not done" }],
        limitations: ["stale"],
      }),
    );
    assert.equal(completed.lifecycle.state, "completed");
    assert.equal(
      completed.completion?.accounting.some((item) =>
        item.reason.includes("not applied or superseded"),
      ) ?? false,
      true,
    );
  } finally {
    await f.dispose();
  }
});

await test("launch recovery distinguishes proven unsent from uncertain submitted generations", async () => {
  for (const window of ["before", "after"] as const) {
    const f = await fixture();
    try {
      const first = await f.runtime();
      f.workers.failBeforeSubmission = window === "before";
      f.workers.failAfterSubmission = window === "after";
      await runRuntime(first.effects.queue(research("inspect")));
      let state = await runRuntime(first.effects.reconcile);
      assert.equal(state.attempts[0]?.submission, window === "before" ? "not_sent" : "uncertain");
      await runRuntime(first.effects.close);
      const next = await f.runtime();
      await runRuntime(next.effects.reconcile);
      state = await runRuntime(next.effects.reconcile);
      assert.equal(f.workers.requests.length, 1);
      assert.equal(f.workers.promptCount, 1);
      assert.equal(state.results.length, 1);
      assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    } finally {
      await f.dispose();
    }
  }
});

await test("exclusive lease fences same-session duplicates and dead-owner adoption preserves suspended observations and receipts", async () => {
  const f = await fixture();
  try {
    const first = await f.runtime();
    await f.authority(first);
    await runRuntime(first.effects.queue(research("inspect", 1)));
    await runRuntime(first.effects.reconcile);
    const receipts = (await runRuntime(f.store.load())).inputs;
    await assert.rejects(f.runtime(), /already has a runtime owner/);
    await submit(first, f.store.setLifecycle({ state: "suspended", reason: "Keep stopped" }));
    SqliteWorkstreamDatabase.use(f.store.path, (database) => {
      database.db
        .prepare("UPDATE lease SET expires_at=? WHERE singleton=1")
        .run("2000-01-01T00:00:00.000Z");
    });
    const nextOwner = {
      sessionId: "new-owner",
      sessionFile: join(f.parent, "new-session.jsonl"),
    };
    const adopted = await f.runtime(undefined, {
      owner: nextOwner,
      priorOwnerLiveness: "dead",
    });
    const state = await runRuntime(adopted.effects.reconcile);
    assert.equal(state.coordinator.sessionId, "new-owner");
    assert.equal(state.lifecycle.state, "suspended");
    assert.deepEqual(state.inputs, receipts);
    assert.equal(state.results.length, 1);
    assert.equal(state.deliveries[0]?.state, "pending");
    await assert.rejects(runRuntime(first.effects.reconcile), /live lease/);
    assert.equal(f.workers.requests.length, 1);
  } finally {
    await f.dispose();
  }
});

await test("worker continuation uses an isolated new workspace and current generation, not the earlier report", async () => {
  const f = await fixture();
  try {
    const active = await f.runtime();
    await runRuntime(active.effects.queue(research("first")));
    await runRuntime(active.effects.reconcile);
    let state = await runRuntime(active.effects.reconcile);
    const previous = state.attempts[0];
    assert.ok(previous);
    f.workers.onWork = async () => undefined;
    await runRuntime(
      active.effects.queue(research("followup"), {
        continuationOf: previous.id,
        selection: { override: { model: "provider/other", thinking: "low" } },
      }),
    );
    await runRuntime(active.effects.reconcile);
    state = await runRuntime(active.effects.reconcile);
    assert.equal(state.results[1]?.validity, "untyped");
    assert.equal(state.attempts[1]?.placement?.kind, "shared_project");
    assert.equal(state.attempts[1]?.placement?.path, f.root);
    assert.notEqual(state.attempts[1]?.sessionFile, previous.sessionFile);
    assert.equal(state.attempts[1]?.models?.guide.model, "provider/other");
    assert.equal(state.attempts[1]?.models?.source, "override");
  } finally {
    await f.dispose();
  }
});

await test("failed notification is not retried by polling and pending delivery remains explicit", async () => {
  const f = await fixture();
  try {
    let notifications = 0;
    const active = await f.runtime(() => {
      notifications++;
      return Effect.fail(
        new RuntimeHostError({
          operation: "fixture notification",
          cause: new Error("uncertain transport"),
        }),
      );
    });
    await runRuntime(active.effects.queue(research("read")));
    await runRuntime(active.effects.reconcile);
    const state = await runRuntime(active.effects.reconcile);
    const result = state.results[0];
    assert.ok(result);
    const completion = {
      conclusion: "The bounded question is answered",
      evidence: [{ label: "Read", observation: "value.txt says initial" }],
      limitations: [],
    };
    const completed = await submit(active, f.store.complete(completion));
    assert.equal(completed.lifecycle.state, "completed");
    assert.equal(
      completed.completion?.accounting.some((item) =>
        item.reason.includes("delivery is pending"),
      ) ?? false,
      true,
    );
    await runRuntime(active.effects.reconcile);
    await runRuntime(active.effects.reconcile);
    assert.equal(notifications, 1);
    const pending = await runRuntime(active.effects.reconcile);
    assert.equal(pending.deliveries[0]?.state, "pending");
    assert.equal(notifications, 1);
  } finally {
    await f.dispose();
  }
});

await test("partial adoption failure releases the acquired lease before runtime failure", async (t) => {
  const f = await fixture();
  try {
    const adoptionFailure = new Error("fixture adoption failure");
    t.mock.method(f.store, "adopt", () =>
      Effect.fail(
        new WorkstreamStoreOperationError({
          code: "workstream_store_operation_failed",
          message: adoptionFailure.message,
          cause: adoptionFailure,
        }),
      ),
    );
    await assert.rejects(
      f.runtime(undefined, {
        owner: {
          sessionId: "adopting-owner",
          sessionFile: join(f.parent, "adopting-session.jsonl"),
        },
      }),
      /adoption failure/,
    );
    assert.equal(
      SqliteWorkstreamDatabase.use(f.store.path, (database) =>
        database.db.prepare("SELECT 1 FROM lease WHERE singleton=1").get(),
      ),
      undefined,
    );
  } finally {
    await f.dispose();
  }
});

await test("Effect-owned fibers use deterministic cadence and close before releasing the lease", async () => {
  const f = await fixture();
  const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));
  await Effect.runPromise(clock.setTime(nativeLeaseTimestamp()));
  try {
    const active = await f.runtime(undefined, { clock });
    await runRuntime(active.effects.queue(research("clocked")));
    await Effect.runPromise(clock.adjust("999 millis"));
    assert.equal(f.workers.requests.length, 0);
    await Effect.runPromise(clock.adjust("1 millis"));
    await submit(active, Effect.void);
    assert.equal(f.workers.requests.length, 1);
    await runRuntime(active.effects.close);
    await assert.rejects(submit(active, Effect.void), /stopped|lease/i);
  } finally {
    await f.dispose();
  }
});

await test("fatal heartbeat loss releases ownership and permits a clean reattachment", async () => {
  const f = await fixture();
  const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));
  await Effect.runPromise(clock.setTime(nativeLeaseTimestamp()));
  try {
    const active = await f.runtime(undefined, { clock });
    await submit(active, Effect.void);
    SqliteWorkstreamDatabase.use(f.store.path, (database) =>
      database.db.prepare("DELETE FROM lease WHERE singleton=1").run(),
    );
    await Effect.runPromise(clock.adjust("5 seconds"));
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0] ?? "", /lease|owner/i);
    assert.equal(
      SqliteWorkstreamDatabase.use(f.store.path, (database) =>
        database.db.prepare("SELECT 1 FROM lease WHERE singleton=1").get(),
      ),
      undefined,
    );
    const reattached = await f.runtime();
    await submit(reattached, Effect.void);
    await runRuntime(active.effects.close);
  } finally {
    await f.dispose();
  }
});

await test("Effect submissions cancel queued work immediately and await running interruption", async () => {
  const f = await fixture();
  try {
    const active = await f.runtime();
    await submit(active, Effect.void);
    const entered = Deferred.makeUnsafe<void>();
    const interrupted = Deferred.makeUnsafe<void>();
    let queuedMutationRan = false;
    const runningController = new AbortController();
    const running = Effect.runPromise(
      active.effects
        .submit(
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid)),
          ),
        )
        .pipe(Effect.provide(liveLayer)),
      { signal: runningController.signal },
    );
    await Effect.runPromise(Deferred.await(entered));

    const queuedController = new AbortController();
    const queued = Effect.runPromise(
      active.effects
        .submit(
          Effect.sync(() => {
            queuedMutationRan = true;
          }),
        )
        .pipe(Effect.provide(liveLayer)),
      { signal: queuedController.signal },
    );
    queuedController.abort();
    await assert.rejects(queued, /abort|interrupt/i);
    assert.equal(queuedMutationRan, false);

    runningController.abort();
    await assert.rejects(running, /abort|interrupt/i);
    await Effect.runPromise(Deferred.await(interrupted));
    await submit(active, Effect.void);
    assert.equal(queuedMutationRan, false);
  } finally {
    await f.dispose();
  }
});

await test("close interrupts a suspended store operation and fails queued replies before releasing the lease", {
  timeout: 30_000,
}, async () => {
  const f = await fixture();
  const entered = Deferred.makeUnsafe<void>();
  const finalizerEntered = Deferred.makeUnsafe<void>();
  const releaseFinalizer = Deferred.makeUnsafe<void>();
  let queuedMutationRan = false;
  let closeSettled = false;
  let active: WorkstreamRuntime | undefined;
  let running: Promise<unknown> | undefined;
  let queued: Promise<unknown> | undefined;
  let close: Promise<void> | undefined;
  try {
    active = await f.runtime();
    await submit(active, Effect.void);
    running = runRuntime(
      active.effects.submit(
        f.store
          .load()
          .pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.uninterruptible(
                Deferred.succeed(finalizerEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseFinalizer)),
                ),
              ),
            ),
          ),
      ),
    );
    void running.catch(() => undefined);
    await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout("5 seconds")));

    queued = runRuntime(
      active.effects.submit(
        Effect.sync(() => {
          queuedMutationRan = true;
        }),
      ),
    );
    void queued.catch(() => undefined);
    const leaseBeforeClose = SqliteWorkstreamDatabase.use(f.store.path, (database) =>
      database.db
        .prepare(
          `SELECT token, owner_session_id, owner_session_file, acquired_at, heartbeat_at, expires_at
             FROM lease WHERE singleton=1`,
        )
        .get(),
    );
    assert.notEqual(leaseBeforeClose, undefined);

    close = runRuntime(active.effects.close);
    void close.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );
    await Effect.runPromise(Deferred.await(finalizerEntered).pipe(Effect.timeout("5 seconds")));

    assert.deepEqual(
      SqliteWorkstreamDatabase.use(f.store.path, (database) =>
        database.db
          .prepare(
            `SELECT token, owner_session_id, owner_session_file, acquired_at, heartbeat_at, expires_at
               FROM lease WHERE singleton=1`,
          )
          .get(),
      ),
      leaseBeforeClose,
    );
    assert.equal(closeSettled, false);
    assert.equal(queuedMutationRan, false);

    await Effect.runPromise(Deferred.succeed(releaseFinalizer, undefined));
    const closePromise = close;
    assert.notEqual(closePromise, undefined);
    await runRuntime(Effect.tryPromise(() => closePromise).pipe(Effect.timeout("5 seconds")));
    await assert.rejects(running, /stopped|interrupt/i);
    await assert.rejects(queued, /stopped|interrupt/i);
    assert.equal(
      SqliteWorkstreamDatabase.use(f.store.path, (database) =>
        database.db.prepare("SELECT 1 FROM lease WHERE singleton=1").get(),
      ),
      undefined,
    );
  } finally {
    await Effect.runPromise(Deferred.succeed(releaseFinalizer, undefined));
    if (close === undefined && active !== undefined) close = runRuntime(active.effects.close);
    if (close !== undefined)
      await runRuntime(
        Effect.tryPromise(() => Promise.allSettled([close])).pipe(Effect.timeout("5 seconds")),
      );
    if (running !== undefined || queued !== undefined)
      await runRuntime(
        Effect.tryPromise(() =>
          Promise.allSettled([
            ...(running === undefined ? [] : [running]),
            ...(queued === undefined ? [] : [queued]),
          ]),
        ).pipe(Effect.timeout("5 seconds")),
      );
    await f.dispose();
  }
});

await test("close surfaces private lease release failures after attempting the exact release", async (t) => {
  const f = await fixture();
  const active = await f.runtime();
  await submit(active, Effect.void);
  const release = f.store.releaseLease.bind(f.store);
  t.mock.method(f.store, "releaseLease", (lease: Lease) =>
    release(lease).pipe(
      // oxlint-disable-next-line effecttsgo/global-error-in-effect-failure -- This test deliberately injects an untyped host finalizer failure.
      Effect.andThen(Effect.fail(new Error("fixture private lease release failure"))),
    ),
  );
  try {
    await assert.rejects(runRuntime(active.effects.close), /private lease release failure/);
    assert.match(f.errors[0] ?? "", /private lease release failure/);
    assert.equal(
      SqliteWorkstreamDatabase.use(f.store.path, (database) =>
        database.db.prepare("SELECT 1 FROM lease WHERE singleton=1").get(),
      ),
      undefined,
    );
  } finally {
    f.registry.close();
    await rm(f.parent, { recursive: true, force: true });
  }
});

await test("owned idle-worker cancellation closes without a model turn or fabricated report", async () => {
  const f = await fixture();
  try {
    f.workers.deferWork = true;
    const active = await f.runtime();
    await runRuntime(active.effects.queue(research("cancel-idle-no-turn")));
    await runRuntime(active.effects.reconcile);
    const attempt = required((await runRuntime(f.store.load())).attempts[0], "idle worker attempt");
    assert.equal(f.workers.promptCount, 0);
    await runRuntime(active.effects.cancel(attempt.id));
    const state = await runRuntime(f.store.load());
    assert.equal(state.attempts[0]?.state, "cancelled");
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(state.results.length, 0);
    assert.equal(f.workers.interruptCount, 1);
    assert.equal(f.workers.promptCount, 0);
  } finally {
    await f.dispose();
  }
});

await test("cancelling a disposable experiment retains output through reconciliation and completion until explicit release", async () => {
  const f = await fixture();
  try {
    f.workers.deferWork = true;
    const active = await f.runtime();
    const authority = await f.authority(active);
    await runRuntime(
      active.effects.queue({
        id: "cancel-experiment",
        capability: "research",
        artifactIntent: "disposable_experiment",
        objective: "Cancel this isolated probe",
        intentVersion: authority.intentVersion,
        authority,
        permittedEffects: ["Write only inside the isolated worktree"],
        stopCondition: "Cancellation requested",
        expectedEvidence: ["No model turn"],
      }),
    );
    await runRuntime(active.effects.reconcile);
    const attempt = required((await runRuntime(f.store.load())).attempts[0], "experiment attempt");
    const placement = required(attempt.placement, "experiment placement");
    if (placement.kind !== "isolated_worktree")
      throw new Error("Experiment placement must be isolated.");
    const retainedFile = join(placement.path, "cancelled-output.txt");
    await writeFile(retainedFile, "retained after cancellation\n");
    await runRuntime(active.effects.cancel(attempt.id));
    let state = await runRuntime(f.store.load());
    assert.equal(state.attempts[0]?.state, "cancelled");
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(state.attempts[0]?.cleanup?.workerClosed, true);
    assert.equal(state.attempts[0]?.outputRelease, undefined);
    assert.equal(await readFile(retainedFile, "utf8"), "retained after cancellation\n");
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(placement.path),
      true,
    );
    assert.equal(
      (await git(f.root, "branch", "--list", placement.branch)).includes(placement.branch),
      true,
    );
    assert.equal(f.workers.promptCount, 0);

    state = await runRuntime(active.effects.reconcile);
    assert.equal(state.attempts[0]?.state, "cancelled");
    assert.equal(state.attempts[0]?.outputRelease, undefined);
    assert.equal(await readFile(retainedFile, "utf8"), "retained after cancellation\n");

    state = await submit(
      active,
      f.store.complete({
        conclusion: "The cancelled experiment remains available for inspection.",
        evidence: [{ label: "retained output", observation: "The cancelled worktree is intact." }],
        limitations: [],
      }),
    );
    assert.equal(state.lifecycle.state, "completed");
    assert.equal(await readFile(retainedFile, "utf8"), "retained after cancellation\n");
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(placement.path),
      true,
    );

    state = await runRuntime(
      active.effects.releaseOutput(
        attempt.id,
        "The cancelled experiment output is no longer needed.",
      ),
    );
    assert.equal(state.attempts[0]?.outputRelease?.state, "completed");
    await assert.rejects(readFile(retainedFile, "utf8"));
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(placement.path),
      false,
    );
    assert.equal(await git(f.root, "branch", "--list", placement.branch), "");
  } finally {
    await f.dispose();
  }
});

await test("reconcile settles cancellation only after proven external worker absence", async () => {
  const f = await fixture();
  try {
    f.workers.deferWork = true;
    const active = await f.runtime();
    await runRuntime(active.effects.queue(research("cancel-externally-absent")));
    await runRuntime(active.effects.reconcile);
    const attempt = required(
      (await runRuntime(f.store.load())).attempts[0],
      "absent worker attempt",
    );
    await submit(active, f.store.cancelAttempt(attempt.id));
    f.workers.absent = true;
    const state = await runRuntime(active.effects.reconcile);
    assert.equal(state.attempts[0]?.state, "cancelled");
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(state.results.length, 0);
  } finally {
    await f.dispose();
  }
});

await test("unknown worker state remains blocked rather than becoming absent", async () => {
  const f = await fixture();
  try {
    f.workers.deferWork = true;
    const active = await f.runtime();
    await runRuntime(active.effects.queue(research("cancel-unknown-worker")));
    await runRuntime(active.effects.reconcile);
    const attempt = required(
      (await runRuntime(f.store.load())).attempts[0],
      "unknown worker attempt",
    );
    await submit(active, f.store.cancelAttempt(attempt.id));
    f.workers.status = "unknown";
    const state = await runRuntime(active.effects.reconcile);
    assert.equal(state.attempts[0]?.state, "cancel_requested");
    assert.equal(state.attempts[0]?.cleanup?.state, "blocked");
    assert.equal(state.results.length, 0);
  } finally {
    await f.dispose();
  }
});

await test("pre-session cancellation cleans only the known placement and never launches Herdr", async (t) => {
  const f = await fixture();
  try {
    const active = await f.runtime();
    const authority = await f.authority(active);
    const checkpointFailure = new Error("fixture session checkpoint failure");
    t.mock.method(f.store, "recordSessionFile", () =>
      Effect.fail(
        new WorkstreamStoreOperationError({
          code: "workstream_store_operation_failed",
          message: checkpointFailure.message,
          cause: checkpointFailure,
        }),
      ),
    );
    await runRuntime(
      active.effects.queue({
        id: "cancel-before-session-checkpoint",
        capability: "research",
        artifactIntent: "disposable_experiment",
        objective: "Cancel before the session checkpoint",
        intentVersion: authority.intentVersion,
        authority,
        permittedEffects: ["Write only inside the isolated worktree"],
        stopCondition: "Cancellation requested",
        expectedEvidence: ["No native worker is launched"],
      }),
    );
    await runRuntime(active.effects.reconcile);
    let state = await runRuntime(f.store.load());
    const attempt = required(state.attempts[0], "pre-session attempt");
    assert.equal(attempt.state, "starting");
    assert.equal(attempt.sessionFile, undefined);
    assert.equal(attempt.launchPane, undefined);
    assert.equal(f.workers.requests.length, 0);
    await runRuntime(active.effects.cancel(attempt.id));
    state = await runRuntime(f.store.load());
    assert.equal(state.attempts[0]?.state, "cancelled");
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(state.attempts[0]?.outputRelease, undefined);
    assert.equal(f.workers.requests.length, 0);
    assert.ok(attempt.placement);
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(attempt.placement.path),
      true,
    );
  } finally {
    await f.dispose();
  }
});

await test("healthy startup/running is quiet; a blocked boundary is recorded once and cleared after observed recovery", async () => {
  const f = await fixture();
  try {
    f.workers.deferWork = true;
    const active = await f.runtime();
    await runRuntime(active.effects.queue(research("read")));
    await runRuntime(active.effects.reconcile);
    let state = await runRuntime(active.effects.reconcile);
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
    state = await runRuntime(active.effects.reconcile);
    assert.equal(state.attempts[0]?.submission, "started");
    assert.equal(state.attempts[0]?.error, undefined);
    assert.deepEqual(f.errors, []);
    f.workers.status = "blocked";
    await runRuntime(active.effects.reconcile);
    await runRuntime(active.effects.reconcile);
    assert.equal(f.errors.length, 1);
    f.workers.status = "working";
    state = await runRuntime(active.effects.reconcile);
    assert.equal(state.attempts[0]?.error, undefined);
    assert.equal(state.attempts[0]?.attentionHistory?.length, 1);
    await runRuntime(f.workers.produceEffect(request.sessionFile));
    f.workers.status = "idle";
    state = await runRuntime(active.effects.reconcile);
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(state.attempts[0]?.error, undefined);
    assert.match(state.attempts[0]?.attentionHistory?.[0]?.detail ?? "", /blocked/);
    assert.equal(f.errors.length, 1);
  } finally {
    await f.dispose();
  }
});
