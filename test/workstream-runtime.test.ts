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
import workgraphCoordinator from "../extensions/coordinator.js";
import { inspectView } from "../src/agent-facing.js";
import { openRepository, type WorktreePlacement } from "../src/git.js";
import { DEFAULT_MODEL_POLICY } from "../src/model-policy.js";
import { liveLayer } from "../src/node-platform.js";
import { processEffect } from "../src/process.js";
import { WorkgraphRegistry } from "../src/registry.js";
import { type WorkstreamState, WorkstreamStoreEffects } from "../src/workstream.js";
import { type Lease, SqliteWorkstreamDatabase } from "../src/workstream-persistence.js";
import {
  type RuntimeEffect,
  type RuntimeOwnership,
  WorkstreamRuntime,
} from "../src/workstream-runtime.js";
import { RuntimeHostError } from "../src/workstream-runtime-services.js";
import { WorkstreamStoreOperationError } from "../src/workstream-state.js";
import {
  configureFixtureEnvironment,
  decodeTestValue,
  required,
  restoreFixtureEnvironment,
} from "./decoders.js";
import {
  FIXTURE_TIMESTAMP,
  researchReport,
  usage,
  Worker,
  workerEnvironment,
} from "./fixture-worker.js";
import { extensionFixture } from "./helpers.js";

const PersistedSqliteRowSchema = Type.Object({ state_json: Type.String() });
const TaskInspectionDetailsSchema = Type.Object({
  inspection: Type.Object({
    idPreview: Type.String(),
    capability: Type.String(),
    objective: Type.String(),
    intentVersion: Type.Number(),
    attemptCount: Type.Number(),
    latestAttempt: Type.Optional(
      Type.Object({
        handle: Type.String(),
        state: Type.String(),
        outcome: Type.Optional(Type.String()),
      }),
    ),
  }),
});
const OutcomeInspectionDetailsSchema = Type.Object({
  inspection: Type.Object({
    result: Type.String(),
    report: Type.Object({
      validity: Type.String(),
      kind: Type.String(),
      status: Type.String(),
      outcome: Type.String(),
      reportedCommit: Type.String(),
    }),
    settlement: Type.Object({
      application: Type.Object({
        state: Type.String(),
        revision: Type.Optional(Type.String()),
      }),
    }),
  }),
});
const ReviewOutcomeInspectionDetailsSchema = Type.Object({
  inspection: Type.Object({
    result: Type.String(),
    report: Type.Object({ validity: Type.String(), kind: Type.String(), status: Type.String() }),
  }),
});
const RecoveryInspectionDetailsSchema = Type.Object({
  inspection: Type.Object({
    recordedFacts: Type.Object({
      cleanup: Type.Object({ state: Type.String(), workerClosed: Type.Boolean() }),
      retainedOutput: Type.Object({ state: Type.String(), path: Type.Optional(Type.String()) }),
    }),
  }),
});
const RetainedOutputRecoveryInspectionDetailsSchema = Type.Object({
  inspection: Type.Object({
    recordedFacts: Type.Object({
      cleanup: Type.Object({
        state: Type.String(),
        workerClosed: Type.Optional(Type.Boolean()),
      }),
      retainedOutput: Type.Object({
        state: Type.String(),
        path: Type.Optional(Type.String()),
        checkout: Type.Optional(Type.String()),
        branch: Type.Optional(Type.String()),
        releaseState: Type.Optional(Type.String()),
        blocker: Type.Optional(Type.String()),
      }),
    }),
  }),
});
const ControlActionDetailsSchema = Type.Object({
  view: Type.Object({
    action: Type.Object({ name: Type.String(), outcome: Type.String() }),
  }),
});
const CompletionActionDetailsSchema = Type.Object({
  view: Type.Object({
    workstream: Type.Object({ lifecycle: Type.String() }),
    action: Type.Object({ name: Type.String(), outcome: Type.String() }),
  }),
});
type OutcomeInspectionRequest = { section: "outcome"; result: string; task?: string };

const ImplementationActionDetailsSchema = Type.Object({
  view: Type.Object({
    action: Type.Object({
      name: Type.String(),
      authorityContext: Type.Object({
        selectedScope: Type.Object({
          intentVersion: Type.Number(),
          authorityReceiptId: Type.String(),
        }),
        latestObservedInput: Type.Optional(
          Type.Object({ receiptId: Type.String(), source: Type.String() }),
        ),
      }),
    }),
    affected: Type.Object({
      task: Type.Object({
        idPreview: Type.String(),
        capability: Type.String(),
        intentVersion: Type.Number(),
      }),
      attempt: Type.Object({
        handle: Type.String(),
        state: Type.String(),
        models: Type.Object({
          selected: Type.Object({
            guide: Type.Object({ model: Type.String() }),
            executor: Type.Object({ model: Type.String() }),
          }),
        }),
      }),
    }),
  }),
});

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

function nativeLeaseTimestamp(): number {
  // oxlint-disable-next-line effecttsgo/global-date -- The injected test clock must align with WorkgraphRegistry's native Date lease checks.
  return Date.now();
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

async function registeredFixture() {
  const parent = await mkdtemp(join(tmpdir(), "workstream-registered-"));
  const root = join(parent, "repo");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "fixture@example.test");
  await git(root, "config", "user.name", "Registered runtime test");
  await writeFile(join(root, "value.txt"), "initial\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  const previous = configureFixtureEnvironment({
    PI_CODING_AGENT_DIR: join(parent, "agent"),
    PI_WORKGRAPH_MODE: null,
    HERDR_ENV: null,
    HERDR_WORKSPACE_ID: "w1",
  });
  const workers = new Worker();
  let workerFactoryCalls = 0;
  try {
    const pi = await extensionFixture("coordinator", root, parent, {}, [
      {
        name: "fixture-coordinator",
        factory: (extension) =>
          workgraphCoordinator(extension, () => {
            workerFactoryCalls++;
            return workers;
          }),
      },
    ]);
    return {
      ...pi,
      root,
      parent,
      workers,
      get workerFactoryCalls() {
        return workerFactoryCalls;
      },
      async dispose() {
        try {
          await pi.close();
        } finally {
          restoreFixtureEnvironment(previous);
        }
        await rm(parent, { recursive: true, force: true });
      },
    };
  } catch (error) {
    restoreFixtureEnvironment(previous);
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}

async function poll<T>(read: () => Promise<T | undefined>, description: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read();
    if (value !== undefined) return value;
    await Effect.runPromise(Effect.sleep("25 millis"));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function taskInspection(f: Awaited<ReturnType<typeof registeredFixture>>, task: string) {
  const result = await f.call("workgraph_inspect", { section: "task", task });
  return decodeTestValue(TaskInspectionDetailsSchema, result.details).inspection;
}

async function outcomeInspection(
  f: Awaited<ReturnType<typeof registeredFixture>>,
  result: string,
  task?: string,
) {
  const request: OutcomeInspectionRequest = {
    section: "outcome",
    result,
  };
  if (task !== undefined) request.task = task;
  const output = await f.call("workgraph_inspect", request);
  return decodeTestValue(OutcomeInspectionDetailsSchema, output.details).inspection;
}

function worktreeBranch(worktrees: string, path: string): string {
  const record = worktrees
    .split("\n\n")
    .find((entry) => entry.split("\n").includes(`worktree ${path}`));
  const branch = record?.split("\n").find((line) => line.startsWith("branch refs/heads/"));
  return branch?.slice("branch refs/heads/".length) ?? assert.fail("Missing worker branch.");
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
const consultation = (id: string) => ({
  id,
  capability: "consultation" as const,
  artifactIntent: "evidence_only" as const,
  objective: "Which strategy should be retained?",
  question: "Which strategy should be retained?",
  context: "The coordinator needs a bounded recommendation.",
  intentVersion: 0,
});

await test("consultation uses two ordinary research sessions and delivers one bounded final result", async () => {
  const f = await fixture();
  try {
    const policy = structuredClone(DEFAULT_MODEL_POLICY);
    policy.roles["consultation.enricher"] = { model: "fixture/enricher", thinking: "high" };
    policy.roles["consultation.advisor"] = { model: "fixture/policy-advisor", thinking: "low" };
    const active = await f.runtime(undefined, { policy });
    const reports = [
      {
        kind: "research" as const,
        status: "completed" as const,
        summary: "E".repeat(8_000),
        evidence: [{ label: "source", observation: "enricher evidence" }],
        findings: [],
      },
      {
        kind: "research" as const,
        status: "completed" as const,
        summary: "Advisor conclusion",
        evidence: [{ label: "advice", observation: "fresh advisor evidence" }],
        findings: [],
      },
    ];
    f.workers.onWork = async (request) => {
      const report = reports[f.workers.requests.length - 1] ?? reports[1];
      if (f.workers.requests.length === 1)
        SessionManager.open(request.sessionFile).appendMessage({
          role: "assistant",
          content: [{ type: "text", text: "ENRICHER PRIVATE TRANSCRIPT" }],
          api: "test",
          provider: "test",
          model: "enricher",
          usage,
          stopReason: "stop",
          timestamp: FIXTURE_TIMESTAMP,
        });
      return report;
    };
    await runRuntime(
      active.effects.queue({
        id: "thin-consultation",
        capability: "consultation",
        artifactIntent: "evidence_only",
        objective: "Which file strategy should be retained?",
        question: "Which file strategy should be retained?",
        context: "The coordinator needs a bounded architecture recommendation.",
        advisorOverride: { model: "fixture/override-advisor", thinking: "max" },
        intentVersion: 0,
      }),
    );
    await runRuntime(active.effects.reconcile);
    await runRuntime(active.effects.reconcile);
    let state = await runRuntime(f.store.load());
    const enricher = required(state.attempts[0], "enricher attempt");
    assert.equal(enricher.consultation?.phase, "enricher");
    assert.equal(enricher.cleanup?.state, "completed");
    assert.equal(f.workers.requests.length, 1);
    assert.equal(f.workers.cleanupIdentities.length, 1);
    assert.ok((enricher.consultation?.frozenEvidence?.summary.length ?? 0) <= 4_000);
    await runRuntime(active.effects.reconcile);
    state = await runRuntime(f.store.load());
    assert.equal(state.attempts[0]?.consultation?.phase, "advisor");
    assert.deepEqual(state.attempts[0]?.consultation?.advisorTarget, {
      model: "fixture/override-advisor",
      thinking: "max",
    });
    assert.equal(state.attempts[0]?.models?.guide.model, "fixture/override-advisor");
    assert.equal(state.attempts[0]?.sessionFile, undefined);
    await runRuntime(active.effects.reconcile);
    await runRuntime(active.effects.reconcile);
    await runRuntime(active.effects.reconcile);
    state = await runRuntime(f.store.load());
    assert.equal(f.workers.requests.length, 2);
    assert.deepEqual(
      f.workers.requests.map((request) => [
        request.role,
        request.model,
        workerEnvironment(request, "PI_WORKGRAPH_MODE"),
      ]),
      [
        ["research", "fixture/enricher", "research"],
        ["research", "fixture/override-advisor", "research"],
      ],
    );
    const advisorFile = required(f.workers.requests[1], "advisor request").sessionFile;
    assert.notEqual(advisorFile, f.workers.requests[0]?.sessionFile);
    assert.equal(SessionManager.open(advisorFile).getHeader()?.parentSession, undefined);
    const advisorSession = JSON.stringify(SessionManager.open(advisorFile).getBranch());
    assert.equal(advisorSession.split("Which file strategy should be retained").length - 1, 1);
    assert.equal(
      advisorSession.split("The coordinator needs a bounded architecture recommendation.").length -
        1,
      1,
    );
    assert.match(advisorSession, /Advisor conclusion/);
    assert.match(advisorSession, /fresh advisor evidence/);
    assert.doesNotMatch(advisorSession, /ENRICHER PRIVATE TRANSCRIPT/);
    assert.equal(state.results.length, 1);
    assert.equal(state.results[0]?.validity, "typed");
    if (state.results[0]?.validity === "typed") {
      assert.equal(state.results[0].report.kind, "research");
      assert.equal(state.results[0].report.summary, "Advisor conclusion");
    }
    assert.equal(f.delivered.length, 1);
    assert.equal(f.delivered[0], state.results[0]?.id);
  } finally {
    await f.dispose();
  }
});

await test("cancelled consultation does not cross the frozen-enrichment cleanup boundary", async () => {
  const f = await fixture();
  try {
    const active = await f.runtime();
    await runRuntime(active.effects.queue(consultation("cancelled-consultation")));
    await runRuntime(active.effects.reconcile);
    f.workers.cleanupPending = true;
    await runRuntime(active.effects.reconcile);
    let state = await runRuntime(f.store.load());
    const attempt = required(state.attempts[0], "cancelled consultation attempt");
    assert.equal(attempt.state, "running");
    assert.equal(attempt.consultation?.phase, "enricher");
    assert.ok(attempt.consultation?.frozenEvidence);
    assert.equal(attempt.cleanup?.state, "pending");
    await runRuntime(active.effects.cancel(attempt.id));
    state = await runRuntime(f.store.load());
    assert.equal(state.attempts[0]?.state, "cancel_requested");
    assert.equal(state.attempts[0]?.cleanup?.state, "pending");
    await assert.rejects(
      submit(active, f.store.transitionConsultationToAdvisor(attempt.id)),
      /running enricher state/,
    );
    f.workers.cleanupPending = false;
    await runRuntime(active.effects.reconcile);
    await runRuntime(active.effects.reconcile);
    await runRuntime(active.effects.reconcile);
    state = await runRuntime(f.store.load());
    assert.equal(state.attempts[0]?.state, "cancelled");
    assert.equal(state.attempts[0]?.consultation?.phase, "enricher");
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    await assert.rejects(
      submit(active, f.store.transitionConsultationToAdvisor(attempt.id)),
      /running enricher state/,
    );
    assert.equal(state.results.length, 0);
    assert.equal(f.delivered.length, 0);
    assert.equal(f.workers.requests.length, 1);
    assert.equal(f.workers.promptCount, 1);
    assert.equal(f.workers.checkpointEvents.filter((event) => event === "onSubmitted").length, 1);
    assert.equal(f.workers.cleanupIdentities.length, 3);
  } finally {
    await f.dispose();
  }
});

await test("failed and escalated enrichment remain the sole consultation result", async () => {
  for (const status of ["failed", "escalated"] as const) {
    const f = await fixture();
    try {
      const active = await f.runtime();
      f.workers.onWork = async () => ({
        kind: "research",
        status,
        summary: `Enricher ${status}`,
        evidence: [],
        findings: [],
      });
      await runRuntime(active.effects.queue(consultation(`consultation-${status}`)));
      await runRuntime(active.effects.reconcile);
      await runRuntime(active.effects.reconcile);
      await runRuntime(active.effects.reconcile);
      await runRuntime(active.effects.reconcile);
      const state = await runRuntime(f.store.load());
      const result = required(state.results[0], `${status} consultation result`);
      assert.equal(result.validity, "typed");
      if (result.validity === "typed") {
        assert.equal(result.report.kind, "research");
        assert.equal(result.report.status, status);
      }
      assert.equal(state.attempts[0]?.consultation?.phase, "enricher");
      assert.equal(state.attempts[0]?.cleanup?.state, "completed");
      assert.equal(f.workers.requests.length, 1);
      assert.equal(f.delivered.length, 1);
    } finally {
      await f.dispose();
    }
  }
});

await test("uncertain consultation launch is retained without an automatic resend", async () => {
  const f = await fixture();
  try {
    const active = await f.runtime();
    f.workers.failAfterSubmission = true;
    f.workers.onWork = async () => undefined;
    await runRuntime(active.effects.queue(consultation("uncertain-consultation")));
    await runRuntime(active.effects.reconcile);
    await runRuntime(active.effects.reconcile);
    await runRuntime(active.effects.reconcile);
    const state = await runRuntime(f.store.load());
    assert.equal(f.workers.requests.length, 1);
    assert.equal(f.workers.promptCount, 1);
    assert.equal(state.results.length, 1);
    assert.equal(state.attempts[0]?.consultation?.phase, "enricher");
  } finally {
    await f.dispose();
  }
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

await test("disposable experiments remove zero-commit output and retain advanced ordinary history", async () => {
  const f = await fixture();
  try {
    const active = await f.runtime();
    const authority = await f.authority(active);
    const destinationHead = await runRuntime(f.repository.head());
    const destinationBytes = await readFile(join(f.root, "value.txt"), "utf8");
    f.workers.onWork = async (request) => {
      if (request.assignmentId === "zero-experiment") return researchReport;
      await writeFile(join(request.cwd, "experiment.txt"), "first\n");
      await git(request.cwd, "add", ".");
      await git(request.cwd, "commit", "-m", "Experiment first commit");
      await writeFile(join(request.cwd, "experiment.txt"), "second\n");
      await git(request.cwd, "add", ".");
      await git(request.cwd, "commit", "-m", "Experiment second commit");
      return researchReport;
    };
    const experiment = (id: string) => ({
      id,
      capability: "research" as const,
      artifactIntent: "disposable_experiment" as const,
      objective: `Run ${id}`,
      intentVersion: authority.intentVersion,
      authority,
      permittedEffects: ["Write only inside the isolated worktree"],
      stopCondition: "The experiment report is retained",
      expectedEvidence: ["The experiment output"],
    });

    await runRuntime(active.effects.queue(experiment("zero-experiment")));
    await runRuntime(active.effects.reconcile);
    let state = await runRuntime(active.effects.reconcile);
    const zero = required(state.attempts[0], "zero-commit experiment");
    assert.equal(zero.cleanup?.state, "completed");
    assert.deepEqual(state.results[0]?.artifacts, []);
    assert.equal(await git(f.root, "rev-parse", "HEAD"), destinationHead);
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), destinationBytes);
    const zeroPlacement = required(zero.placement, "zero experiment placement");
    if (zeroPlacement.kind !== "isolated_worktree")
      throw new Error("Zero experiment did not use an isolated placement.");
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(zeroPlacement.path),
      false,
    );
    assert.equal(await git(f.root, "branch", "--list", zeroPlacement.branch), "");

    await runRuntime(active.effects.queue(experiment("advanced-experiment")));
    await runRuntime(active.effects.reconcile);
    state = await runRuntime(active.effects.reconcile);
    const advanced = required(state.attempts[1], "advanced experiment");
    const placement = required(advanced.placement, "advanced experiment placement");
    if (placement.kind !== "isolated_worktree")
      throw new Error("Advanced experiment did not use an isolated placement.");
    assert.equal(advanced.cleanup?.state, "completed");
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(placement.path),
      false,
    );
    const advancedHead = await git(f.root, "rev-parse", placement.branch);
    assert.notEqual(advancedHead, required(advanced.baseRevision, "advanced experiment base"));
    assert.equal(
      await git(
        f.root,
        "rev-list",
        "--count",
        `${required(advanced.baseRevision, "advanced experiment base")}..${placement.branch}`,
      ),
      "2",
    );
    assert.deepEqual(
      state.results[1]?.artifacts.map((artifact) => artifact.reference),
      [placement.branch],
    );
    assert.equal(await git(f.root, "rev-parse", "HEAD"), destinationHead);
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), destinationBytes);
    await runRuntime(
      active.effects.releaseOutput(advanced.id, "Release the inspected experiment branch."),
    );
    state = await runRuntime(f.store.load());
    assert.equal(state.attempts[1]?.cleanup?.state, "completed");
    assert.equal(state.attempts[1]?.outputRelease?.state, "completed");
    assert.equal(await git(f.root, "branch", "--list", placement.branch), "");
  } finally {
    await f.dispose();
  }
});

await test("blocked exact-revision release recovers its cleanup checkpoint without a second Git release", async (t) => {
  const f = await fixture();
  try {
    const active = await f.runtime();
    const authority = await f.authority(active);
    const destinationHead = await runRuntime(f.repository.head());
    f.workers.onWork = async () => researchReport;
    await runRuntime(
      active.effects.queue({
        id: "malformed-review",
        capability: "review",
        artifactIntent: "evidence_only",
        objective: "Review the exact fixture revision",
        intentVersion: authority.intentVersion,
        subject: { kind: "revision", revision: destinationHead },
        concern: "The review report must be well-formed.",
      }),
    );
    await runRuntime(active.effects.reconcile);
    let state = await runRuntime(active.effects.reconcile);
    const attempt = required(state.attempts[0], "malformed review attempt");
    const placement = required(attempt.placement, "malformed review placement");
    if (placement.kind !== "isolated_worktree")
      throw new Error("Malformed review did not use an isolated placement.");
    assert.equal(state.results[0]?.validity, "invalid");
    assert.equal(attempt.cleanup?.state, "blocked");
    assert.equal(attempt.cleanup?.workerClosed, true);
    let releaseCalls = 0;
    const releaseOutput = f.repository.releaseOutput.bind(f.repository);
    t.mock.method(
      f.repository,
      "releaseOutput",
      (placement: WorktreePlacement, expectedHead: string) => {
        releaseCalls++;
        return releaseOutput(placement, expectedHead);
      },
    );
    const interruptedFinish = t.mock.method(f.store, "finishCleanup", () =>
      // oxlint-disable-next-line effecttsgo/global-error-in-effect-failure -- This test deliberately interrupts the post-release cleanup checkpoint.
      Effect.fail(new Error("simulated cleanup checkpoint interruption")),
    );
    await assert.rejects(
      runRuntime(active.effects.releaseOutput(attempt.id, "Release malformed review output.")),
      /simulated cleanup checkpoint interruption/,
    );
    state = await runRuntime(f.store.load());
    assert.equal(state.attempts[0]?.cleanup?.state, "blocked");
    assert.equal(state.attempts[0]?.outputRelease?.state, "completed");
    assert.equal(releaseCalls, 1);

    interruptedFinish.mock.restore();
    state = await runRuntime(active.effects.reconcile);
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(state.attempts[0]?.outputRelease?.state, "completed");
    await runRuntime(active.effects.releaseOutput(attempt.id, "Retry the completed release."));
    assert.equal(releaseCalls, 1);
    const worktrees = await git(f.root, "worktree", "list", "--porcelain");
    assert.match(worktrees, new RegExp(`worktree ${f.root}`));
    assert.doesNotMatch(worktrees, new RegExp(placement.path));
    assert.equal(await git(f.root, "branch", "--list", placement.branch), "");
    assert.equal(await git(f.root, "rev-parse", "HEAD"), destinationHead);
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
    let state = await runRuntime(active.effects.reconcile);
    assert.equal(state.results[0]?.validity, "invalid");
    assert.equal(state.attempts[0]?.application, undefined);
    assert.equal(state.attempts[0]?.cleanup?.state, "blocked");
    assert.equal(state.attempts[0]?.cleanup?.workerClosed, true);
    assert.equal(await runRuntime(f.repository.head()), base);
    const attempt = required(state.attempts[0], "dirty no-change attempt");
    await runRuntime(active.effects.releaseOutput(attempt.id, "Release dirty no-change output."));
    state = await runRuntime(f.store.load());
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(state.attempts[0]?.outputRelease?.state, "completed");
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

await test("registered maintained changes preserve identity, apply explicitly, and review an exact earlier revision", async () => {
  const f = await registeredFixture();
  try {
    assert.equal(f.workerFactoryCalls, 0, "worker runtime creation must remain lazy");
    const initialDestinationHead = await git(f.root, "rev-parse", "HEAD");
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
      assert.equal(workerEnvironment(request, "PI_WORKGRAPH_MODE"), "review");
      const base = workerEnvironment(request, "PI_WORKGRAPH_BASE_COMMIT");
      assert.equal(await git(request.cwd, "show", `${base}:value.txt`), "maintained");
      assert.notEqual(request.cwd, f.root);
      assert.equal(await git(request.cwd, "rev-parse", "HEAD"), base);
      assert.equal(await readFile(join(request.cwd, "value.txt"), "utf8"), "maintained\n");
      return {
        kind: "review",
        status: "completed",
        summary: "Reviewed exact old revision",
        evidence: [],
        findings: [],
      };
    };

    const input = await f.input(
      "Implement value.txt and preserve the current repository scope.",
      "interactive",
    );
    assert.equal(input.action, "continue");
    await f.call("workgraph_intent", {
      statement: "Implement the maintained value change in the current repository.",
      constraints: ["Keep the destination unchanged until explicit apply."],
    });
    const queued = await f.call("workgraph_implement", {
      id: semanticId,
      objective: "Change value",
      acceptance: ["value is maintained"],
    });
    const queuedView = decodeTestValue(ImplementationActionDetailsSchema, queued.details).view;
    assert.equal(queuedView.action.name, "workgraph_implement");
    assert.equal(queuedView.action.authorityContext.selectedScope.intentVersion, 1);
    assert.notEqual(queuedView.action.authorityContext.selectedScope.authorityReceiptId, "");
    assert.equal(queuedView.affected.task.idPreview, semanticId);
    assert.equal(queuedView.affected.task.capability, "implement");
    assert.equal(queuedView.affected.task.intentVersion, 1);
    assert.equal(
      queuedView.affected.attempt.models.selected.guide.model,
      "openai-codex/gpt-6-astra",
    );
    assert.equal(
      queuedView.affected.attempt.models.selected.executor.model,
      "openai-codex/gpt-5.6-luna",
    );

    const implementationTask = await poll(async () => {
      const view = await taskInspection(f, semanticId);
      return view.latestAttempt?.outcome === undefined ? undefined : view;
    }, "registered implementation result");
    const implementationAttempt = required(
      implementationTask.latestAttempt,
      "registered implementation attempt",
    );
    const implementationOutcome = await outcomeInspection(
      f,
      required(implementationAttempt.outcome, "registered implementation outcome"),
    );
    assert.equal(implementationTask.idPreview, semanticId);
    assert.equal(implementationTask.intentVersion, 1);
    assert.equal(implementationOutcome.report.validity, "typed");
    assert.equal(implementationOutcome.report.kind, "implementation");
    assert.equal(implementationOutcome.report.status, "completed");
    assert.equal(implementationOutcome.report.outcome, "changed");
    await poll(
      async () => (f.messages.length === 0 ? undefined : f.messages.at(-1)),
      "registered result notification",
    );
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "initial\n");
    const sourceCommit = implementationOutcome.report.reportedCommit;
    const implementationPath = required(f.workers.requests[0], "implementation worker").cwd;
    const implementationBranch =
      (await git(f.root, "branch", "--list", "pi-workgraph/*"))
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0) ??
      assert.fail("Expected a retained implementation branch.");
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(implementationPath),
      false,
    );
    assert.equal(await git(f.root, "rev-parse", implementationBranch), sourceCommit);
    assert.equal(await git(f.root, "rev-parse", "HEAD"), initialDestinationHead);
    const destinationHead = await git(f.root, "rev-parse", "HEAD");

    const applied = await f.call("workgraph_control", {
      action: "apply",
      attempt: implementationAttempt.handle,
    });
    const appliedView = decodeTestValue(ControlActionDetailsSchema, applied.details).view;
    assert.equal(appliedView.action.name, "workgraph_control:apply");
    assert.equal(appliedView.action.outcome, "recorded");
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "maintained\n");
    const appliedOutcome = await outcomeInspection(f, implementationOutcome.result, semanticId);
    assert.equal(appliedOutcome.settlement.application.state, "applied");
    const revision = required(appliedOutcome.settlement.application.revision, "applied revision");
    const actualHead = await git(f.root, "rev-parse", "HEAD");
    assert.equal(actualHead, sourceCommit);
    assert.equal(actualHead, revision);
    assert.notEqual(actualHead, destinationHead);
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(implementationPath),
      false,
    );
    assert.equal(await git(f.root, "branch", "--list", implementationBranch), "");

    await writeFile(join(f.root, "value.txt"), "later\n");
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-m", "later unrelated change");
    await f.call("workgraph_review", {
      id: "review",
      objective: "Review maintained change",
      concern: "Exact content",
      subject: { kind: "revision", revision },
    });
    assert.equal(f.workerFactoryCalls, 1, "same-store review must reuse the existing worker port");
    const reviewTask = await poll(async () => {
      const view = await taskInspection(f, "review");
      return view.latestAttempt?.outcome === undefined ? undefined : view;
    }, "registered exact-revision review result");
    const reviewAttempt = required(reviewTask.latestAttempt, "registered review attempt");
    const reviewOutcome = await f.call("workgraph_inspect", {
      section: "outcome",
      task: "review",
      result: required(reviewAttempt.outcome, "registered review outcome"),
    });
    const reviewView = decodeTestValue(ReviewOutcomeInspectionDetailsSchema, reviewOutcome.details);
    assert.equal(reviewView.inspection.report.validity, "typed");
    assert.equal(reviewView.inspection.report.kind, "review");
    assert.equal(reviewView.inspection.report.status, "completed");
    const reviewRequest = required(f.workers.requests[1], "review worker");
    assert.equal(workerEnvironment(reviewRequest, "PI_WORKGRAPH_BASE_COMMIT"), revision);
    assert.notEqual(reviewRequest.cwd, f.root);
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "later\n");
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(reviewRequest.cwd),
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
    const parentBranch =
      firstAttempt.placement?.kind === "isolated_worktree"
        ? firstAttempt.placement.branch
        : assert.fail("First candidate must retain an isolated placement.");
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(
        firstAttempt.placement?.kind === "isolated_worktree" ? firstAttempt.placement.path : "",
      ),
      false,
    );

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
    const correctionBranch =
      correctionAttempt.placement?.kind === "isolated_worktree"
        ? correctionAttempt.placement.branch
        : assert.fail("Correction must retain its exact output branch.");
    assert.doesNotMatch(
      await git(f.root, "worktree", "list", "--porcelain"),
      /\.pi-workgraph-worktrees/,
    );
    assert.equal(await git(f.root, "rev-parse", correctionBranch), correctionCommit);

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
    assert.equal(await git(f.root, "rev-parse", parentBranch), firstCommit);
    assert.equal(await git(f.root, "branch", "--list", correctionBranch), "");
    assert.doesNotMatch(
      await git(f.root, "worktree", "list", "--porcelain"),
      /\.pi-workgraph-worktrees/,
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
    const parentBranch =
      parent.placement?.kind === "isolated_worktree"
        ? parent.placement.branch
        : assert.fail("Candidate must retain its exact output branch.");

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
    assert.equal(await git(f.root, "rev-parse", parentBranch), parentCommit);

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
    assert.equal(await git(f.root, "rev-parse", parentBranch), parentCommit);
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
    assert.equal(state.attempts[0]?.cleanup?.state, "blocked");
    assert.equal(state.attempts[0]?.cleanup?.workerClosed, true);
    await runRuntime(
      active.effects.releaseOutput(
        required(state.attempts[0], "invalid output attempt").id,
        "Release malformed output after inspection.",
      ),
    );
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

await test("registered cancellation retains an experiment through completion until exact release", async () => {
  const f = await registeredFixture();
  try {
    assert.equal(f.workerFactoryCalls, 0, "worker runtime creation must remain lazy");
    f.workers.deferWork = true;
    const destinationHead = await git(f.root, "rev-parse", "HEAD");
    const input = await f.input(
      "Run a disposable experiment, then cancel it without producing a model result.",
      "rpc",
    );
    assert.equal(input.action, "continue");
    await f.call("workgraph_intent", {
      statement: "Run and inspect the disposable cancellation experiment.",
      constraints: ["Retain the isolated output until explicit release."],
    });
    const queued = await f.call("workgraph_research", {
      id: "cancel-experiment",
      question: "Cancel this isolated probe",
      expectedEvidence: ["No model turn"],
      experiment: {
        permittedEffects: ["Write only inside the isolated worktree"],
        stopCondition: "Cancellation requested",
      },
    });
    const queuedView = decodeTestValue(ControlActionDetailsSchema, queued.details).view;
    assert.equal(queuedView.action.name, "workgraph_research");
    assert.equal(queuedView.action.outcome, "queued");

    const queuedTask = await poll(async () => {
      const view = await taskInspection(f, "cancel-experiment");
      return f.workers.requests.length === 0 || view.latestAttempt === undefined ? undefined : view;
    }, "registered experiment worker launch");
    const experimentAttempt = required(queuedTask.latestAttempt, "registered experiment attempt");
    const experimentWorker = required(f.workers.requests[0], "experiment worker");
    const retainedFile = join(experimentWorker.cwd, "cancelled-output.txt");
    const experimentBranch = worktreeBranch(
      await git(f.root, "worktree", "list", "--porcelain"),
      experimentWorker.cwd,
    );
    await writeFile(retainedFile, "retained after cancellation\n");
    assert.equal(f.workers.promptCount, 0);

    const cancelled = await f.call("workgraph_control", {
      action: "cancel",
      attempt: experimentAttempt.handle,
    });
    const cancelledView = decodeTestValue(ControlActionDetailsSchema, cancelled.details).view;
    assert.equal(cancelledView.action.name, "workgraph_control:cancel");
    const cancelledTask = await poll(async () => {
      const view = await taskInspection(f, "cancel-experiment");
      return view.latestAttempt?.state === "cancelled" ? view : undefined;
    }, "registered cancellation settlement");
    assert.equal(cancelledTask.latestAttempt?.outcome, undefined);
    assert.equal(f.workers.promptCount, 0);
    assert.equal(f.workers.interruptCount, 1);
    const recovery = await f.call("workgraph_inspect", {
      section: "recovery",
      attempt: experimentAttempt.handle,
    });
    const recoveryView = decodeTestValue(RecoveryInspectionDetailsSchema, recovery.details);
    assert.equal(recoveryView.inspection.recordedFacts.cleanup.state, "blocked");
    assert.equal(recoveryView.inspection.recordedFacts.cleanup.workerClosed, true);
    assert.equal(recoveryView.inspection.recordedFacts.retainedOutput.state, "retained");
    assert.equal(recoveryView.inspection.recordedFacts.retainedOutput.path, experimentWorker.cwd);
    assert.equal(await readFile(retainedFile, "utf8"), "retained after cancellation\n");
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(experimentWorker.cwd),
      true,
    );
    assert.ok((await git(f.root, "branch", "--list", experimentBranch)).includes(experimentBranch));

    await assert.rejects(
      f.call("workgraph_complete", {
        conclusion: "The cancelled experiment remains available for inspection.",
        evidence: [{ label: "retained output", observation: "The cancelled worktree is intact." }],
        limitations: [],
      }),
      /settled and cleaned up/,
    );
    assert.equal(await readFile(retainedFile, "utf8"), "retained after cancellation\n");
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(experimentWorker.cwd),
      true,
    );
    assert.equal(f.workerFactoryCalls, 1, "completion must retain the attached runtime");

    const released = await f.call("workgraph_control", {
      action: "release_output",
      reason: "The cancelled experiment output is no longer needed.",
      attempt: experimentAttempt.handle,
    });
    const releasedView = decodeTestValue(ControlActionDetailsSchema, released.details).view;
    assert.equal(releasedView.action.name, "workgraph_control:release_output");
    await assert.rejects(readFile(retainedFile, "utf8"));
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(experimentWorker.cwd),
      false,
    );
    assert.equal(await git(f.root, "branch", "--list", experimentBranch), "");
    assert.equal(await git(f.root, "rev-parse", "HEAD"), destinationHead);
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "initial\n");
  } finally {
    await f.dispose();
  }
});

await test("retained-output release uses the cleanup fence after worktree absence and refuses a moved branch", async () => {
  for (const movedBranch of [false, true]) {
    const f = await registeredFixture();
    try {
      f.workers.onWork = async (request) => {
        await writeFile(join(request.cwd, "experiment.txt"), "experiment\n");
        await git(request.cwd, "add", ".");
        await git(request.cwd, "commit", "-m", "Successful experiment");
        return researchReport;
      };
      await f.input("Inspect a disposable output and decide when it can be released.", "rpc");
      await f.call("workgraph_intent", {
        statement: "Inspect and explicitly release the disposable output when finished.",
      });
      const task = movedBranch ? "absent-moved-branch" : "absent-exact-branch";
      const queued = await f.call("workgraph_research", {
        id: task,
        question: "Inspect the disposable output",
        expectedEvidence: ["The output is retained"],
        experiment: {
          permittedEffects: ["Write only inside the isolated worktree"],
          stopCondition: "The worker report is retained",
        },
      });
      const queuedView = decodeTestValue(ControlActionDetailsSchema, queued.details).view;
      assert.equal(queuedView.action.name, "workgraph_research");
      assert.equal(queuedView.action.outcome, "queued");

      const settled = await poll(async () => {
        const taskView = await taskInspection(f, task);
        const attempt = taskView.latestAttempt;
        const worker = f.workers.requests[0];
        if (attempt === undefined || worker === undefined) return undefined;
        const recovery = await f.call("workgraph_inspect", {
          section: "recovery",
          attempt: attempt.handle,
        });
        const recoveryView = decodeTestValue(
          RetainedOutputRecoveryInspectionDetailsSchema,
          recovery.details,
        ).inspection;
        return recoveryView.recordedFacts.cleanup.state === "completed" &&
          recoveryView.recordedFacts.cleanup.workerClosed === true
          ? { attempt, worker, recoveryView }
          : undefined;
      }, "retained output cleanup");
      const { attempt, worker, recoveryView } = settled;
      const placementPath = worker.cwd;
      const placementBranch =
        (await git(f.root, "branch", "--list", "pi-workgraph/*"))
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0) ?? assert.fail("Expected a retained experiment branch.");
      const expectedHead = await git(f.root, "rev-parse", placementBranch);
      assert.equal(recoveryView.recordedFacts.retainedOutput.state, "retained");
      assert.equal(recoveryView.recordedFacts.retainedOutput.checkout, "removed");
      assert.equal(recoveryView.recordedFacts.retainedOutput.path, undefined);
      assert.equal(recoveryView.recordedFacts.retainedOutput.branch, placementBranch);
      assert.equal(recoveryView.recordedFacts.retainedOutput.releaseState, undefined);

      assert.equal(
        (await git(f.root, "worktree", "list", "--porcelain")).includes(placementPath),
        false,
      );
      assert.equal(await git(f.root, "rev-parse", placementBranch), expectedHead);

      let movedHead: string | undefined;
      if (movedBranch) {
        await writeFile(join(f.root, "moved.txt"), "moved branch\n");
        await git(f.root, "add", "moved.txt");
        await git(f.root, "commit", "-m", "Move retained branch fence");
        movedHead = await git(f.root, "rev-parse", "HEAD");
        await git(f.root, "branch", "-f", placementBranch, movedHead);
        assert.notEqual(movedHead, expectedHead);
      }

      const completed = await f.call("workgraph_complete", {
        conclusion: "The disposable output was inspected.",
        evidence: [{ label: "retained output", observation: "The output was retained." }],
      });
      const completedView = decodeTestValue(CompletionActionDetailsSchema, completed.details).view;
      assert.equal(completedView.workstream.lifecycle, "completed");

      const release = {
        action: "release_output" as const,
        attempt: attempt.handle,
        reason: "The inspected disposable output is no longer needed.",
      };
      if (!movedBranch) {
        const released = await f.call("workgraph_control", release);
        const releasedView = decodeTestValue(ControlActionDetailsSchema, released.details).view;
        assert.equal(releasedView.action.name, "workgraph_control:release_output");
        const recovery = await f.call("workgraph_inspect", {
          section: "recovery",
          attempt: attempt.handle,
        });
        const releasedFacts = decodeTestValue(
          RetainedOutputRecoveryInspectionDetailsSchema,
          recovery.details,
        ).inspection.recordedFacts;
        assert.equal(releasedFacts.retainedOutput.state, "released");
        assert.equal(releasedFacts.retainedOutput.releaseState, "completed");
        assert.equal(await git(f.root, "branch", "--list", placementBranch), "");
      } else {
        await assert.rejects(f.call("workgraph_control", release), /Refusing cleanup: branch/);
        const recovery = await f.call("workgraph_inspect", {
          section: "recovery",
          attempt: attempt.handle,
        });
        const blockedFacts = decodeTestValue(
          RetainedOutputRecoveryInspectionDetailsSchema,
          recovery.details,
        ).inspection.recordedFacts;
        assert.equal(blockedFacts.retainedOutput.state, "retained");
        assert.equal(blockedFacts.retainedOutput.releaseState, "blocked");
        assert.match(blockedFacts.retainedOutput.blocker ?? "", /Refusing cleanup: branch/);
        assert.equal(await git(f.root, "rev-parse", placementBranch), movedHead);
        assert.equal(
          (await git(f.root, "branch", "--list", placementBranch)).includes(placementBranch),
          true,
        );
      }
    } finally {
      await f.dispose();
    }
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

await test("working cancellation stays pending and quiet until the exact worker becomes idle", async () => {
  const f = await fixture();
  try {
    f.workers.deferWork = true;
    const active = await f.runtime();
    const authority = await f.authority(active);
    await runRuntime(
      active.effects.queue({
        id: "cancel-working-retained",
        capability: "research",
        artifactIntent: "disposable_experiment",
        objective: "Cancel a working retained experiment",
        intentVersion: authority.intentVersion,
        authority,
        permittedEffects: ["Write only inside the isolated worktree"],
        stopCondition: "Cancellation requested",
        expectedEvidence: ["No fabricated result"],
      }),
    );
    await runRuntime(active.effects.reconcile);
    const attempt = required(
      (await runRuntime(f.store.load())).attempts[0],
      "working cancellation attempt",
    );
    const placement = required(attempt.placement, "working cancellation placement");
    const worker = required(attempt.worker, "working cancellation worker");
    f.workers.status = "working";
    await runRuntime(active.effects.cancel(attempt.id));
    let state = await runRuntime(f.store.load());
    assert.equal(state.attempts[0]?.state, "cancel_requested");
    assert.equal(state.attempts[0]?.cleanup?.state, "pending");
    assert.equal(state.attempts[0]?.cleanup?.workerClosed, false);
    assert.equal(state.attempts[0]?.error, undefined);
    assert.equal(state.results.length, 0);
    assert.deepEqual(f.workers.cleanupIdentities[0], worker);
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(placement.path),
      true,
    );

    state = await runRuntime(active.effects.reconcile);
    assert.equal(state.attempts[0]?.state, "cancel_requested");
    assert.equal(state.attempts[0]?.cleanup?.state, "pending");
    assert.equal(state.attempts[0]?.cleanup?.workerClosed, false);
    assert.equal(state.attempts[0]?.error, undefined);
    assert.equal(state.results.length, 0);
    assert.deepEqual(f.workers.cleanupIdentities[1], worker);
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(placement.path),
      true,
    );

    f.workers.status = "idle";
    state = await runRuntime(active.effects.reconcile);
    assert.equal(state.attempts[0]?.state, "cancelled");
    assert.equal(state.attempts[0]?.cleanup?.state, "blocked");
    assert.equal(state.attempts[0]?.cleanup?.workerClosed, true);
    assert.equal(state.results.length, 0);
    assert.deepEqual(f.workers.cleanupIdentities[2], worker);
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(placement.path),
      true,
    );
  } finally {
    await f.dispose();
  }
});

await test("reconcile proves exact absence after closure before its worker checkpoint", async (t) => {
  const f = await fixture();
  try {
    f.workers.deferWork = true;
    const active = await f.runtime();
    const authority = await f.authority(active);
    await runRuntime(
      active.effects.queue({
        id: "cancel-checkpoint-interruption",
        capability: "research",
        artifactIntent: "disposable_experiment",
        objective: "Recover cancellation after the native close checkpoint is interrupted",
        intentVersion: authority.intentVersion,
        authority,
        permittedEffects: ["Write only inside the isolated worktree"],
        stopCondition: "Cancellation requested",
        expectedEvidence: ["Exact worker absence"],
      }),
    );
    await runRuntime(active.effects.reconcile);
    const attempt = required(
      (await runRuntime(f.store.load())).attempts[0],
      "checkpoint interruption attempt",
    );
    const placement = required(attempt.placement, "checkpoint interruption placement");
    const worker = required(attempt.worker, "checkpoint interruption worker");
    f.workers.status = "idle";
    t.mock.method(f.store, "markWorkerClosed", () => Effect.never);
    await assert.rejects(
      runRuntime(active.effects.cancel(attempt.id).pipe(Effect.timeout("100 millis"))),
    );
    t.mock.restoreAll();

    let state = await runRuntime(f.store.load());
    assert.equal(state.attempts[0]?.state, "cancel_requested");
    assert.equal(state.attempts[0]?.cleanup?.state, "pending");
    assert.equal(state.attempts[0]?.cleanup?.workerClosed, false);
    assert.equal(state.results.length, 0);
    f.workers.absent = true;
    state = await runRuntime(active.effects.reconcile);
    assert.equal(state.attempts[0]?.state, "cancelled");
    assert.equal(state.attempts[0]?.cleanup?.state, "blocked");
    assert.equal(state.attempts[0]?.cleanup?.workerClosed, true);
    assert.equal(state.results.length, 0);
    assert.deepEqual(f.workers.cleanupIdentities, [worker, worker]);
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(placement.path),
      true,
    );
  } finally {
    await f.dispose();
  }
});

await test("checkpointed retained cleanup closes an absent worker without deleting its output", async (t) => {
  const f = await fixture();
  try {
    const active = await f.runtime();
    const authority = await f.authority(active);
    await runRuntime(
      active.effects.queue({
        id: "recover-retained-cleanup",
        capability: "research",
        artifactIntent: "disposable_experiment",
        objective: "Retain experiment output across cleanup recovery",
        intentVersion: authority.intentVersion,
        authority,
        permittedEffects: ["Write only inside the isolated worktree"],
        stopCondition: "The worker report is retained",
        expectedEvidence: ["Retained output"],
      }),
    );
    await runRuntime(active.effects.reconcile);
    const launched = required(
      (await runRuntime(f.store.load())).attempts[0],
      "retained cleanup attempt",
    );
    const placement = required(launched.placement, "retained cleanup placement");
    const worker = required(launched.worker, "retained cleanup worker");
    const retainedFile = join(placement.path, "retained.txt");
    await writeFile(retainedFile, "retained across cleanup recovery\n");
    const markWorkerClosed = t.mock.method(f.store, "markWorkerClosed", () => Effect.never);
    await assert.rejects(runRuntime(active.effects.reconcile.pipe(Effect.timeout("100 millis"))));
    markWorkerClosed.mock.restore();

    let state = await runRuntime(f.store.load());
    assert.equal(state.attempts[0]?.cleanup?.state, "pending");
    assert.equal(state.attempts[0]?.cleanup?.workerClosed, false);
    assert.equal(state.attempts[0]?.error, undefined);
    const retainedResult = required(state.results[0], "retained cleanup result");
    assert.equal(await readFile(retainedFile, "utf8"), "retained across cleanup recovery\n");
    assert.equal(await readFile(join(placement.path, "value.txt"), "utf8"), "initial\n");

    f.workers.absent = true;
    state = await runRuntime(active.effects.reconcile);
    assert.equal(state.attempts[0]?.cleanup?.state, "blocked");
    assert.equal(state.attempts[0]?.cleanup?.workerClosed, true);
    assert.match(state.attempts[0]?.cleanup?.error ?? "", /not clean|dirty worktree/);
    assert.deepEqual(state.results, [retainedResult]);
    assert.deepEqual(f.workers.cleanupIdentities, [worker, worker]);
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(placement.path),
      true,
    );
    assert.equal(await readFile(retainedFile, "utf8"), "retained across cleanup recovery\n");
    assert.equal(await readFile(join(placement.path, "value.txt"), "utf8"), "initial\n");

    state = await runRuntime(active.effects.reconcile);
    assert.equal(state.attempts[0]?.cleanup?.state, "blocked");
    assert.equal(state.attempts[0]?.cleanup?.workerClosed, true);
    assert.match(state.attempts[0]?.error ?? "", /not clean|dirty worktree/);
    assert.deepEqual(state.results, [retainedResult]);
    assert.equal(
      (await git(f.root, "worktree", "list", "--porcelain")).includes(placement.path),
      true,
    );
    assert.equal(await readFile(retainedFile, "utf8"), "retained across cleanup recovery\n");
    assert.equal(await readFile(join(placement.path, "value.txt"), "utf8"), "initial\n");
  } finally {
    await f.dispose();
  }
});

await test("checkpointed non-retained isolated cleanup stays pending for diagnosis", async (t) => {
  const f = await fixture();
  try {
    const active = await f.runtime();
    const authority = await f.authority(active);
    const base = await runRuntime(f.repository.head());
    f.workers.onWork = async (request) => ({
      kind: "implementation",
      status: "completed",
      outcome: "no_change",
      summary: "No source change was needed.",
      revision: workerEnvironment(request, "PI_WORKGRAPH_BASE_COMMIT"),
      reason: "The requested behavior already holds.",
      evidence: [],
      findings: [],
    });
    await runRuntime(
      active.effects.queue({
        id: "preserve-destructive-cleanup-boundary",
        capability: "implement",
        artifactIntent: "maintained_change",
        objective: "Confirm the existing implementation behavior",
        intentVersion: authority.intentVersion,
        authority,
        acceptance: ["The existing behavior remains correct"],
      }),
    );
    await runRuntime(active.effects.reconcile);
    const launched = required(
      (await runRuntime(f.store.load())).attempts[0],
      "non-retained cleanup attempt",
    );
    const placement = required(launched.placement, "non-retained cleanup placement");
    t.mock.method(f.repository, "cleanupWorktree", () => Effect.never);
    await assert.rejects(runRuntime(active.effects.reconcile.pipe(Effect.timeout("2 seconds"))));
    t.mock.restoreAll();

    let state = await runRuntime(f.store.load());
    assert.equal(state.attempts[0]?.cleanup?.state, "pending");
    assert.equal(state.attempts[0]?.cleanup?.workerClosed, true);
    state = await runRuntime(active.effects.reconcile);
    assert.equal(state.attempts[0]?.cleanup?.state, "completed");
    assert.equal(state.attempts[0]?.cleanup?.workerClosed, true);
    assert.equal(state.attempts[0]?.error, undefined);
    assert.equal(state.attempts[0]?.resultId !== undefined, true);
    assert.equal(base, await runRuntime(f.repository.head()));
    assert.doesNotMatch(
      await git(f.root, "worktree", "list", "--porcelain"),
      new RegExp(placement.path),
    );
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
    assert.equal(state.attempts[0]?.cleanup?.state, "blocked");
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
