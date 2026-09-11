import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Disposable Git flows use real filesystem boundaries.
import { existsSync } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Disposable Git flows use real filesystem boundaries.
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Fixture paths are real repository identities.
import { join } from "node:path";
import test from "node:test";
import type { FileSystem, Path } from "effect";
import { Effect, type Scope } from "effect";
import {
  WorkstreamCommandError,
  type WorkstreamCommandPorts,
} from "../src/coordination/commands.js";
import {
  makeWorkstreamReconciliationDriver,
  type WorkstreamGitPort,
  type WorkstreamReconciliationPorts,
  type WorkstreamSessionPort,
} from "../src/coordination/driver.js";
import {
  liveGitPort,
  liveWorkstreamCommandPorts,
  makeLiveWorkstreamReconciliationDriver,
} from "../src/coordination/host.js";
import {
  type ReconciliationContext,
  type ReconciliationDriver,
  ReconciliationDriverError,
} from "../src/coordination/reconciliation.js";
import { WorkstreamRuntime, type WorkstreamRuntimeError } from "../src/coordination/runtime.js";
import type { WorkerReport } from "../src/domain/report.js";
import {
  type Attempt,
  type AttemptKey,
  activateAttempt,
  checkpointApplication,
  checkpointCancellation,
  checkpointCleanup,
  checkpointOutputRelease,
  createTask,
  createWorkstream,
  type Intent,
  type Placement,
  type RepositoryIdentity,
  recordWorkerExecution,
  type Task,
  type TerminalObservation,
  terminalizeAttempt,
  type Workstream,
} from "../src/domain/workstream.js";
import { type GitRepository, openRepository } from "../src/git.js";
import { HerdrCliRuntime } from "../src/herdr.js";
import type { HerdrAgentStatus } from "../src/herdr-decoder.js";
import type { WorkerIdentity } from "../src/herdr-identity.js";
import type { ModelPolicy } from "../src/model-policy.js";
import { liveLayer } from "../src/node-platform.js";
import type { NativeFailureCategory, WorkerSessionResolution } from "../src/pi-process.js";
import { WorkstreamStore } from "../src/storage/workstream-store.js";
import { git } from "./helpers.js";

const ID = "driver";
const ATTEMPT = "attempt-1";
const COORDINATOR = { sessionId: "coordinator-a", sessionFile: "/sessions/coordinator-a.jsonl" };
const T0 = "2024-01-01T00:00:00.000Z";
const GUIDE = { model: "fixture/guide", thinking: "high" } as const;
const EXECUTOR = { model: "fixture/executor", thinking: "xhigh" } as const;
const POLICY: ModelPolicy = {
  version: 6,
  roles: {
    research: [{ model: "fixture/research", thinking: "high" }],
    review: [{ model: "fixture/review", thinking: "high" }],
    "implementation.guide": GUIDE,
    "implementation.executor": EXECUTOR,
    "consultation.advisor": [{ model: "fixture/advisor", thinking: "low" }],
  },
};

type Step = (state: Workstream) => Workstream;
const key = (attemptId = ATTEMPT): AttemptKey => ({ taskId: "task-1", attemptId });

interface SessionRecord {
  readonly sessionFile: string;
  readonly generation: { runId: string; nodeId: string };
  report?: WorkerReport;
  text?: string;
  failure?: NativeFailureCategory;
  models?: { model: string; thinking?: string; source: "selection" | "message" }[];
  started?: boolean;
  settled?: boolean;
}

interface SessionControlState {
  createCount: number;
  inspectCount: number;
  startedChecks: number;
  ambiguity: string | undefined;
}

interface Harness {
  readonly parent: string;
  readonly repository: RepositoryIdentity;
  readonly git: GitRepository;
  readonly policyPath: string;
  readonly commands: ReturnType<typeof liveWorkstreamCommandPorts>;
  readonly sessions: Map<string, SessionRecord>;
  readonly worker: {
    inspectLaunch: "live" | "absent" | "unknown";
    inspectLaunchCount: number;
    presence: HerdrAgentStatus | "absent";
    cleanupState: "pending" | "completed" | "blocked";
    cleanupCount: number;
    presenceChecks: number;
    interrupts: number;
    launches: number;
  };
  readonly sessionControl: SessionControlState;
  readonly gitControl: {
    failEnsure: boolean;
    failHead: boolean;
    ensureCount: number;
    headReadCount: number;
    cleanupCount: number;
  };
  readonly deliveryControl: { failures: number; calls: ReconciliationContext[] };
  /** Driver block details surfaced through the runtime attention boundary. */
  readonly attention: string[];
  readonly ports: WorkstreamReconciliationPorts;
}

function liveIdentity(sessionFile: string, cwd: string): WorkerIdentity {
  return {
    workspaceId: "ws-test",
    tabId: "tab-1",
    paneId: "pane-1",
    terminalId: "term-1",
    agentName: "agent-1",
    sessionFile,
    cwd,
  };
}

async function makeHarness(): Promise<Harness> {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-driver-"));
  const root = join(parent, "repo");
  await mkdir(root);
  await chmod(parent, 0o700);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "fixture@example.test");
  await git(root, "config", "user.name", "Fixture");
  await writeFile(join(root, "data.txt"), "base\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "Initial fixture");
  await git(root, "commit", "--allow-empty", "-m", "Assigned base");
  const gitRepository = await Effect.runPromise(openRepository(root));
  const repository: RepositoryIdentity = {
    projectRoot: gitRepository.root,
    gitCommonDir: gitRepository.commonDir,
  };
  const policyPath = join(parent, "models.json");
  await writeFile(policyPath, `${JSON.stringify(POLICY)}\n`, { mode: 0o600 });

  const sessions = new Map<string, SessionRecord>();
  const worker: Harness["worker"] = {
    inspectLaunch: "live",
    inspectLaunchCount: 0,
    presence: "idle",
    cleanupState: "completed",
    cleanupCount: 0,
    presenceChecks: 0,
    interrupts: 0,
    launches: 0,
  };
  const sessionControl: SessionControlState = {
    createCount: 0,
    inspectCount: 0,
    startedChecks: 0,
    ambiguity: undefined,
  };
  const gitControl = {
    failEnsure: false,
    failHead: false,
    ensureCount: 0,
    headReadCount: 0,
    cleanupCount: 0,
  };
  const deliveryCalls: ReconciliationContext[] = [];
  const deliveryControl = { failures: 0, calls: deliveryCalls };
  const attention: string[] = [];

  const realGit = liveGitPort(gitRepository);
  const gitPort: WorkstreamGitPort = {
    ...realGit,
    ensureWorktree: (runId, nodeId, placement) =>
      Effect.gen(function* () {
        gitControl.ensureCount += 1;
        if (gitControl.failEnsure)
          return yield* new ReconciliationDriverError({ detail: "controlled ensure failure" });
        return yield* realGit.ensureWorktree(runId, nodeId, placement);
      }),
    currentHead: (cwd) =>
      Effect.gen(function* () {
        gitControl.headReadCount += 1;
        if (gitControl.failHead)
          return yield* new ReconciliationDriverError({ detail: "controlled HEAD read failure" });
        return yield* realGit.currentHead(cwd);
      }),
    cleanupWorktree: (placement, expectedHead, retainBranch) =>
      Effect.gen(function* () {
        gitControl.cleanupCount += 1;
        yield* realGit.cleanupWorktree(placement, expectedHead, retainBranch);
      }),
  };

  const workerPort: WorkstreamReconciliationPorts["workers"] = {
    workspaceId: "ws-test",
    launch: (request) =>
      Effect.gen(function* () {
        worker.launches += 1;
        const identity = liveIdentity(request.sessionFile, request.cwd);
        yield* request.onTab?.({
          workspaceId: request.workspaceId,
          paneId: identity.paneId,
        }) ?? Effect.void;
        yield* request.onResource?.({
          workspaceId: identity.workspaceId,
          tabId: identity.tabId,
          paneId: identity.paneId,
          terminalId: identity.terminalId,
          agentName: identity.agentName,
          cwd: identity.cwd,
        }) ?? Effect.void;
        yield* request.onIdentity?.(identity) ?? Effect.void;
        if (request.prompt !== undefined) {
          yield* request.onPreflight?.() ?? Effect.void;
          yield* request.onSubmitted?.() ?? Effect.void;
        }
      }),
    inspectLaunch: (request) =>
      Effect.sync(() => {
        worker.inspectLaunchCount += 1;
        const evidence = {
          resource: request,
          pane: { state: "unknown" as const, detail: "controlled" },
          process: { state: "unknown" as const, detail: "controlled" },
          agent: { state: "unknown" as const, detail: "controlled" },
        };
        if (worker.inspectLaunch !== "live")
          return {
            state: worker.inspectLaunch,
            evidence,
            detail: `controlled ${worker.inspectLaunch}`,
          };
        return {
          state: "live" as const,
          identity: liveIdentity(request.sessionFile, request.cwd),
          evidence: {
            ...evidence,
            pane: {
              workspaceId: request.workspaceId,
              tabId: "tab-1",
              paneId: request.paneId,
              terminalId: "term-1",
              cwd: request.cwd,
            },
          },
          detail: "controlled live",
        };
      }),
    inspect: () =>
      Effect.sync(() => {
        worker.presenceChecks += 1;
        return worker.presence;
      }),
    interrupt: () =>
      Effect.sync(() => {
        worker.interrupts += 1;
        return worker.presence === "absent" ? ("absent" as const) : ("working" as const);
      }),
    steer: () => Effect.void,
    cleanup: () =>
      Effect.sync(() => {
        worker.cleanupCount += 1;
        return { state: worker.cleanupState, detail: "controlled cleanup" };
      }),
  };

  const sessionPort: WorkstreamSessionPort = {
    sessionDirectory: (runId) =>
      Effect.succeed(join(repository.gitCommonDir, "pi-workgraph", "worker-sessions", runId)),
    inspectDirectory: (sessionDir, generation) =>
      Effect.sync((): WorkerSessionResolution => {
        sessionControl.inspectCount += 1;
        if (sessionControl.ambiguity !== undefined)
          return { state: "ambiguous", detail: sessionControl.ambiguity };
        const matches = [...sessions.values()].filter(
          (record) =>
            record.generation.runId === generation.runId &&
            record.generation.nodeId === generation.nodeId &&
            record.sessionFile.startsWith(sessionDir),
        );
        if (matches.length === 0) return { state: "none" };
        const [first] = matches;
        if (matches.length === 1 && first !== undefined)
          return { state: "exact", sessionFile: first.sessionFile };
        return { state: "ambiguous", detail: "controlled ambiguity" };
      }),
    create: (request) =>
      Effect.sync(() => {
        sessionControl.createCount += 1;
        const sessionFile = join(request.sessionDir, `${request.nodeId}.jsonl`);
        sessions.set(sessionFile, {
          sessionFile,
          generation: { runId: request.runId, nodeId: request.nodeId },
        });
        return sessionFile;
      }),
    readReport: (sessionFile) => {
      const record = sessions.get(sessionFile);
      return record?.report === undefined
        ? { invalid: false, unreadable: false }
        : { report: record.report, invalid: false, unreadable: false };
    },
    readText: (sessionFile) => sessions.get(sessionFile)?.text,
    observeFailure: (sessionFile) => sessions.get(sessionFile)?.failure,
    models: (sessionFile) => sessions.get(sessionFile)?.models ?? [],
    started: (sessionFile) => {
      sessionControl.startedChecks += 1;
      return sessions.get(sessionFile)?.started === true;
    },
    settled: (sessionFile) => sessions.get(sessionFile)?.settled === true,
  };

  const delivery = {
    deliver: (context: ReconciliationContext) =>
      Effect.gen(function* () {
        deliveryControl.calls.push(context);
        if (deliveryControl.failures > 0) {
          deliveryControl.failures -= 1;
          return yield* new ReconciliationDriverError({ detail: "controlled delivery failure" });
        }
      }),
  };

  return {
    parent,
    repository,
    git: gitRepository,
    policyPath,
    commands: liveWorkstreamCommandPorts(gitRepository, new HerdrCliRuntime("herdr", {})),
    sessions,
    worker,
    sessionControl,
    gitControl,
    deliveryControl,
    attention,
    ports: { git: gitPort, workers: workerPort, sessions: sessionPort, delivery, host: {} },
  };
}

function runScoped<A, E>(
  program: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Promise<A> {
  return Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(liveLayer)));
}

/** One disposable repository plus workstream store, removed after the flow. */
async function withHarness(body: (h: Harness) => Promise<void>): Promise<void> {
  const h = await makeHarness();
  try {
    await body(h);
  } finally {
    await rm(h.parent, { recursive: true, force: true });
  }
}

function baseAttempt(id: string, extra: Partial<Attempt> = {}): Attempt {
  const baseRevision = extra.baseRevision ?? "a".repeat(40);
  return {
    id,
    state: "queued",
    createdAt: T0,
    updatedAt: T0,
    baseRevision,
    candidate: { kind: "initial", rootCommit: baseRevision },
    selection: { role: "implementation", guide: GUIDE, executor: EXECUTOR, source: "policy" },
    ...extra,
  };
}

function implementationTask(attempt: Attempt): Task {
  return {
    id: "task-1",
    objective: "Implement",
    intentIndex: 0,
    createdAt: T0,
    kind: "implementation",
    acceptance: ["Works"],
    attempts: [attempt],
  };
}

function intent(): Intent {
  return {
    statement: "Own the driver.",
    constraints: [],
    grounding: {
      kind: "human_input_receipt",
      id: "receipt-1",
      sessionId: COORDINATOR.sessionId,
      sessionFile: COORDINATOR.sessionFile,
      source: "interactive",
      text: "Own the driver.",
      receivedAt: T0,
    },
    recordedAt: T0,
  };
}

function emptyWorkstream(repository: RepositoryIdentity): Workstream {
  return createWorkstream({
    id: ID,
    purpose: "Own the driver.",
    repository,
    coordinator: COORDINATOR,
    intent: intent(),
    createdAt: T0,
  });
}

/** The deterministic isolated placement and base for the fixture Attempt. */
async function isolated(
  h: Harness,
): Promise<{ base: string; placement: Extract<Placement, { kind: "isolated_worktree" }> }> {
  const base = await Effect.runPromise(h.git.head());
  const derived = h.git.deriveWorktreePlacement(ID, ATTEMPT, base);
  assert.ok(derived);
  return {
    base,
    placement: { kind: "isolated_worktree", path: derived.path, branch: derived.branch },
  };
}

const sharedPlacement = (h: Harness): Placement => ({
  kind: "shared_project",
  path: h.repository.projectRoot,
});

function launchSteps(
  placement: Placement,
  sessionFile: string,
  submission: "not_sent" | "uncertain" | "submitted",
): Step[] {
  const cwd = placement.path;
  const resource = {
    workspaceId: "ws-test",
    tabId: "tab-1",
    paneId: "pane-1",
    terminalId: "term-1",
    agentName: "agent-1",
    cwd,
  };
  const steps: Step[] = [
    (s) => recordWorkerExecution(s, key(), { sessionFile }, T0),
    (s) =>
      recordWorkerExecution(
        s,
        key(),
        { launch: { phase: "pane", workspaceId: "ws-test", paneId: "pane-1" } },
        T0,
      ),
    (s) => recordWorkerExecution(s, key(), { launch: { phase: "resource", ...resource } }, T0),
    (s) => recordWorkerExecution(s, key(), { launch: { phase: "ready", ...resource } }, T0),
  ];
  if (submission === "uncertain")
    steps.push((s) => recordWorkerExecution(s, key(), { submission: "uncertain" }, T0));
  if (submission === "submitted")
    steps.push(
      (s) => recordWorkerExecution(s, key(), { submission: "uncertain" }, T0),
      (s) => recordWorkerExecution(s, key(), { submission: "submitted" }, T0),
    );
  return steps;
}

/** Activation plus a session and retained pane handle, before any launch advance. */
function paneLaunchSteps(placement: Placement, sessionFile: string): Step[] {
  return [
    (s) => activateAttempt(s, key(), T0, { placement, submission: "not_sent" }),
    (s) => recordWorkerExecution(s, key(), { sessionFile }, T0),
    (s) =>
      recordWorkerExecution(
        s,
        key(),
        { launch: { phase: "pane", workspaceId: "ws-test", paneId: "pane-1" } },
        T0,
      ),
  ];
}

function reported(report: WorkerReport): TerminalObservation {
  return { kind: "reported", observedAt: T0, artifacts: [], deliveryRequestedAt: T0, report };
}

function noChangeReport(revision: string): WorkerReport {
  return {
    kind: "implementation",
    status: "completed",
    outcome: "no_change",
    revision,
    reason: "Already satisfied.",
    summary: "No change.",
    evidence: [],
    findings: [],
  };
}

/** Seed exact durable facts through the real store boundary, then run the driver. */
async function seeded(
  h: Harness,
  attempt: Attempt,
  steps: Step[],
  body: (
    runtime: WorkstreamRuntime,
  ) => Effect.Effect<void, WorkstreamRuntimeError, FileSystem.FileSystem | Path.Path | Scope.Scope>,
  driverOverride?: ReconciliationDriver,
  commandOverride: WorkstreamCommandPorts = h.commands,
): Promise<void> {
  const driver: ReconciliationDriver =
    driverOverride ?? makeWorkstreamReconciliationDriver(h.ports);
  h.gitControl.ensureCount = 0;
  h.gitControl.headReadCount = 0;
  h.gitControl.cleanupCount = 0;
  h.worker.launches = 0;
  h.worker.interrupts = 0;
  h.worker.inspectLaunchCount = 0;
  h.worker.cleanupCount = 0;
  h.worker.presenceChecks = 0;
  h.sessionControl.createCount = 0;
  h.sessionControl.inspectCount = 0;
  h.sessionControl.startedChecks = 0;
  h.attention.length = 0;
  // Reset only the workstream store; session fixtures under worker-sessions survive.
  await rm(join(h.repository.gitCommonDir, "pi-workgraph", "workstreams"), {
    recursive: true,
    force: true,
  });
  return runScoped(
    Effect.gen(function* () {
      const state = emptyWorkstream(h.repository);
      yield* WorkstreamStore.create(state);
      const attachment = yield* WorkstreamStore.open(ID, h.repository);
      const lease = yield* attachment.store.acquireLease(COORDINATOR);
      const all: Step[] = [(s) => createTask(s, implementationTask(attempt), T0), ...steps];
      for (const step of all) yield* attachment.store.transition(lease, step);
      yield* attachment.store.releaseLease(lease);
      const runtime = yield* WorkstreamRuntime.acquire({
        id: ID,
        repository: h.repository,
        coordinator: COORDINATOR,
        ownership: { kind: "attach" },
        policyPath: h.policyPath,
        driver,
        commands: commandOverride,
        onReconciliationAttention: (detail) =>
          Effect.sync(() => {
            h.attention.push(detail);
          }),
        heartbeatInterval: "1 hour",
      });
      yield* body(runtime);
      yield* runtime.close();
    }),
  );
}

/** Bounded polling with an iteration cap, not wall-clock time. */
async function until(
  runtime: WorkstreamRuntime,
  predicate: (attempt: Attempt | undefined) => boolean,
  maxPolls = 800,
): Promise<Attempt> {
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const state = await Effect.runPromise(runtime.snapshot());
    const attempt = state.tasks[0]?.attempts[0];
    if (predicate(attempt)) return attempt ?? assert.fail("attempt");
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
  const state = await Effect.runPromise(runtime.snapshot());
  throw new Error(
    `Timed out waiting for attempt state: ${JSON.stringify(state.tasks[0]?.attempts[0])}`,
  );
}

/** Bounded polling for host-observed conditions that never reach the aggregate. */
async function waitFor(predicate: () => boolean, describe: string, maxPolls = 800): Promise<void> {
  for (let poll = 0; poll < maxPolls; poll += 1) {
    if (predicate()) return;
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
  throw new Error(`Timed out waiting for ${describe}`);
}

const currentAttempt = (runtime: WorkstreamRuntime) =>
  Effect.runPromise(runtime.snapshot()).then((state) => state.tasks[0]?.attempts[0]);

async function branchHead(h: Harness, branch: string): Promise<string | undefined> {
  try {
    return await git(h.repository.projectRoot, "rev-parse", "--verify", `refs/heads/${branch}`);
  } catch {
    return undefined;
  }
}

const sessionDirFor = (h: Harness) =>
  join(h.repository.gitCommonDir, "pi-workgraph", "worker-sessions", ID);

async function seedSessionRecord(h: Harness): Promise<string> {
  await mkdir(sessionDirFor(h), { recursive: true, mode: 0o700 });
  const sessionFile = join(sessionDirFor(h), `${ATTEMPT}.jsonl`);
  h.sessions.set(sessionFile, { sessionFile, generation: { runId: ID, nodeId: ATTEMPT } });
  return sessionFile;
}

void test("isolated activation declares placement and creates exactly once from its persisted base", async () => {
  await withHarness(async (h) => {
    const { base, placement } = await isolated(h);
    h.gitControl.failEnsure = true;
    await seeded(h, baseAttempt(ATTEMPT, { baseRevision: base }), [], (runtime) =>
      Effect.gen(function* () {
        const attempt = yield* Effect.promise(() =>
          until(runtime, (item) => item?.state === "active"),
        );
        assert.deepEqual(attempt.execution?.placement, placement);
        assert.equal(existsSync(placement.path), false);
        h.gitControl.failEnsure = false;
        yield* runtime.reconcile();
        yield* Effect.promise(() => waitFor(() => existsSync(placement.path), "worktree creation"));
        yield* runtime.reconcile();
        const listing = yield* Effect.promise(() =>
          git(h.repository.projectRoot, "worktree", "list", "--porcelain"),
        );
        assert.equal(
          listing.split("\n").filter((line) => line === `worktree ${placement.path}`).length,
          1,
        );
      }),
    );
  });
});

void test("session resolution adopts an unrecorded session and creates exactly one when absent", async () => {
  // An unrecorded current-generation session is adopted without creating another.
  await withHarness(async (h) => {
    const { base, placement } = await isolated(h);
    const sessionFile = await seedSessionRecord(h);
    await seeded(
      h,
      baseAttempt(ATTEMPT, { baseRevision: base }),
      [(s) => activateAttempt(s, key(), T0, { placement, submission: "not_sent" })],
      (runtime) =>
        Effect.gen(function* () {
          const attempt = yield* Effect.promise(() =>
            until(runtime, (item) => item?.execution?.submission === "submitted"),
          );
          assert.equal(attempt.execution?.sessionFile, sessionFile);
          assert.equal(h.sessionControl.createCount, 0);
          assert.equal(h.worker.launches, 1);
          const checks = h.worker.presenceChecks;
          yield* runtime.reconcile();
          yield* Effect.promise(() =>
            waitFor(() => h.worker.presenceChecks > checks, "worker poll re-entry"),
          );
          assert.equal(h.worker.launches, 1);
        }),
    );
  });

  // No session exists: exactly one is created before the single launch.
  await withHarness(async (h) => {
    const { base, placement } = await isolated(h);
    await seeded(
      h,
      baseAttempt(ATTEMPT, { baseRevision: base }),
      [(s) => activateAttempt(s, key(), T0, { placement, submission: "not_sent" })],
      (runtime) =>
        Effect.gen(function* () {
          const attempt = yield* Effect.promise(() =>
            until(runtime, (item) => item?.execution?.submission === "submitted"),
          );
          assert.equal(h.sessionControl.createCount, 1);
          assert.equal(attempt.execution?.submission, "submitted");
          assert.equal(h.worker.launches, 1);
        }),
    );
  });
});

void test("session resolution refuses to launch across a recorded launch gap or an ambiguous scan", async () => {
  // A recorded session without a launch checkpoint may already have launched.
  await withHarness(async (h) => {
    const { base, placement } = await isolated(h);
    const sessionFile = await seedSessionRecord(h);
    await seeded(
      h,
      baseAttempt(ATTEMPT, { baseRevision: base }),
      [
        (s) => activateAttempt(s, key(), T0, { placement, submission: "not_sent" }),
        (s) => recordWorkerExecution(s, key(), { sessionFile }, T0),
      ],
      (runtime) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => waitFor(() => h.attention.length > 0, "launch-gap block"));
          const attempt = yield* Effect.promise(() => currentAttempt(runtime));
          assert.equal(attempt?.state, "active");
          assert.equal(attempt?.execution?.launch, undefined);
          assert.equal(h.worker.launches, 0);
          assert.equal(h.sessionControl.createCount, 0);
          yield* runtime.reconcile();
          yield* Effect.promise(() => waitFor(() => h.attention.length > 1, "re-entry block"));
          assert.equal(h.worker.launches, 0);
        }),
    );
  });

  // An unreadable session scan cannot establish absence, so nothing is created or launched.
  await withHarness(async (h) => {
    const { base, placement } = await isolated(h);
    h.sessionControl.ambiguity = "unreadable candidate";
    await seeded(
      h,
      baseAttempt(ATTEMPT, { baseRevision: base }),
      [(s) => activateAttempt(s, key(), T0, { placement, submission: "not_sent" })],
      (runtime) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => waitFor(() => h.sessionControl.inspectCount > 0, "scan"));
          yield* Effect.promise(() => waitFor(() => h.attention.length > 0, "ambiguity block"));
          assert.equal(h.sessionControl.createCount, 0);
          assert.equal(h.worker.launches, 0);
          yield* runtime.reconcile();
          yield* Effect.promise(() => waitFor(() => h.attention.length > 1, "re-entry block"));
          assert.equal(h.worker.launches, 0);
        }),
    );
  });
});

void test("partial launch recovery advances a live retained resource and blocks proven absence", async () => {
  await withHarness(async (h) => {
    const { base, placement } = await isolated(h);
    await Effect.runPromise(h.git.createWorktree(ID, ATTEMPT, base));
    const sessionFile = await seedSessionRecord(h);
    const state = baseAttempt(ATTEMPT, { baseRevision: base });
    const steps = paneLaunchSteps(placement, sessionFile);

    h.worker.inspectLaunch = "live";
    await seeded(h, state, steps, (runtime) =>
      Effect.gen(function* () {
        const attempt = yield* Effect.promise(() =>
          until(runtime, (item) => item?.execution?.submission === "submitted"),
        );
        assert.equal(attempt.execution?.launch?.phase, "ready");
        assert.equal(h.worker.launches, 0);
      }),
    );

    h.worker.inspectLaunch = "absent";
    await seeded(h, state, steps, (runtime) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => waitFor(() => h.worker.inspectLaunchCount > 0, "inspection"));
        yield* Effect.promise(() => waitFor(() => h.attention.length > 0, "absence block"));
        const attempt = yield* Effect.promise(() => currentAttempt(runtime));
        assert.equal(attempt?.execution?.launch?.phase, "pane");
        assert.equal(h.worker.launches, 0);
      }),
    );
  });
});

void test("uncertain submission recovery never resends without a native start marker", async () => {
  await withHarness(async (h) => {
    const { base, placement } = await isolated(h);
    await Effect.runPromise(h.git.createWorktree(ID, ATTEMPT, base));
    const sessionFile = await seedSessionRecord(h);
    const state = baseAttempt(ATTEMPT, { baseRevision: base });
    const steps: Step[] = [
      (s) => activateAttempt(s, key(), T0, { placement, submission: "not_sent" }),
      ...launchSteps(placement, sessionFile, "uncertain"),
    ];

    await seeded(h, state, steps, (runtime) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          waitFor(() => h.sessionControl.startedChecks > 0, "start check"),
        );
        yield* Effect.promise(() => waitFor(() => h.attention.length > 0, "submission block"));
        const attempt = yield* Effect.promise(() => currentAttempt(runtime));
        assert.equal(attempt?.execution?.submission, "uncertain");
        assert.equal(h.worker.launches, 0);
      }),
    );

    const record = h.sessions.get(sessionFile);
    assert.ok(record);
    record.started = true;
    await seeded(h, state, steps, (runtime) =>
      Effect.gen(function* () {
        const attempt = yield* Effect.promise(() =>
          until(runtime, (item) => item?.execution?.submission === "started"),
        );
        assert.equal(attempt.execution?.submission, "started");
      }),
    );
  });
});

void test("settlement validates Git facts and terminalizes an unreported mismatch", async () => {
  await withHarness(async (h) => {
    const { base, placement } = await isolated(h);
    await Effect.runPromise(h.git.createWorktree(ID, ATTEMPT, base));
    const sessionFile = await seedSessionRecord(h);
    const record = h.sessions.get(sessionFile);
    assert.ok(record);
    record.settled = true;
    record.text = "Reported a revision that does not exist.";
    record.report = {
      kind: "implementation",
      status: "completed",
      outcome: "no_change",
      revision: "b".repeat(40),
      reason: "No change.",
      summary: "No change.",
      evidence: [],
      findings: [],
    };
    const steps: Step[] = [
      (s) => activateAttempt(s, key(), T0, { placement, submission: "not_sent" }),
      ...launchSteps(placement, sessionFile, "submitted"),
    ];
    await seeded(h, baseAttempt(ATTEMPT, { baseRevision: base }), steps, (runtime) =>
      Effect.gen(function* () {
        const attempt = yield* Effect.promise(() =>
          until(runtime, (item) => item?.state === "finished"),
        );
        assert.equal(attempt.outcome?.kind, "unreported");
        assert.match(
          attempt.outcome?.kind === "unreported" ? attempt.outcome.reason : "",
          /No-change validation failed/,
        );
      }),
    );
  });
});

function cancelledSteps(
  placement: Placement,
  sessionFile: string,
  target: "uncertain" | "submitted_or_observed",
  evidence: "interrupt_submitted" | "idle" | "done" | "absent" = "idle",
): Step[] {
  const requested = { state: "requested" as const, requestedAt: T0, reason: "Stop." };
  const uncertain = { ...requested, state: "uncertain" as const, dispatchAt: T0 };
  const steps: Step[] = [
    (s) => activateAttempt(s, key(), T0, { placement, submission: "not_sent" }),
    ...launchSteps(placement, sessionFile, "submitted"),
    (s) => checkpointCancellation(s, key(), requested, T0),
    (s) => checkpointCancellation(s, key(), uncertain, T0),
  ];
  if (target === "submitted_or_observed")
    steps.push((s) =>
      checkpointCancellation(
        s,
        key(),
        { ...uncertain, state: "submitted_or_observed", observedAt: T0, evidence },
        T0,
      ),
    );
  return steps;
}

void test("uncertain cancellation recovery interrupts only after exact observation", async () => {
  await withHarness(async (h) => {
    const placement = sharedPlacement(h);
    const sessionFile = await seedSessionRecord(h);
    h.worker.presence = "working";
    await seeded(
      h,
      baseAttempt(ATTEMPT),
      cancelledSteps(placement, sessionFile, "uncertain"),
      (runtime) =>
        Effect.gen(function* () {
          const attempt = yield* Effect.promise(() =>
            until(runtime, (item) => item?.state === "finished"),
          );
          assert.equal(attempt.outcome?.kind, "cancelled");
          assert.equal(attempt.execution?.cancellation?.state, "submitted_or_observed");
          assert.equal(attempt.cleanup?.workerClosed, true);
          assert.equal(h.worker.interrupts, 1);
        }),
    );
  });
});

void test("idle and done cancellation observations advance without a new interrupt", async () => {
  for (const presence of ["idle", "done"] as const) {
    await withHarness(async (h) => {
      const placement = sharedPlacement(h);
      const sessionFile = await seedSessionRecord(h);
      h.worker.presence = presence;
      await seeded(
        h,
        baseAttempt(ATTEMPT),
        cancelledSteps(placement, sessionFile, "uncertain"),
        (runtime) =>
          Effect.gen(function* () {
            const attempt = yield* Effect.promise(() =>
              until(runtime, (item) => item?.state === "finished"),
            );
            assert.equal(attempt.outcome?.kind, "cancelled");
            assert.equal(
              attempt.execution?.cancellation?.state === "submitted_or_observed"
                ? attempt.execution.cancellation.evidence
                : undefined,
              presence,
            );
            assert.equal(h.worker.interrupts, 0);
          }),
      );
    });
  }
});

void test("cancellation blocks on a recorded launch gap or an ambiguous scan", async () => {
  const requested = { state: "requested" as const, requestedAt: T0, reason: "Stop." };
  const uncertain = { ...requested, state: "uncertain" as const, dispatchAt: T0 };

  // A recorded session without a launch checkpoint cannot be excluded from having launched.
  await withHarness(async (h) => {
    const sessionFile = await seedSessionRecord(h);
    await seeded(
      h,
      baseAttempt(ATTEMPT),
      [
        (s) =>
          activateAttempt(s, key(), T0, { placement: sharedPlacement(h), submission: "not_sent" }),
        (s) => recordWorkerExecution(s, key(), { sessionFile }, T0),
        (s) => checkpointCancellation(s, key(), requested, T0),
        (s) => checkpointCancellation(s, key(), uncertain, T0),
      ],
      (runtime) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => waitFor(() => h.attention.length > 0, "launch-gap block"));
          const attempt = yield* Effect.promise(() => currentAttempt(runtime));
          assert.equal(attempt?.state, "active");
          assert.equal(attempt?.outcome, undefined);
          assert.equal(attempt?.execution?.cancellation?.state, "uncertain");
          assert.equal(h.worker.launches, 0);
          assert.equal(h.worker.interrupts, 0);
        }),
    );
  });

  // An ambiguous session scan leaves unresolved presence blocked without terminalization.
  await withHarness(async (h) => {
    h.sessionControl.ambiguity = "unreadable candidate";
    await seeded(
      h,
      baseAttempt(ATTEMPT),
      [
        (s) =>
          activateAttempt(s, key(), T0, { placement: sharedPlacement(h), submission: "not_sent" }),
        (s) => checkpointCancellation(s, key(), requested, T0),
        (s) => checkpointCancellation(s, key(), uncertain, T0),
      ],
      (runtime) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => waitFor(() => h.attention.length > 0, "ambiguity block"));
          const attempt = yield* Effect.promise(() => currentAttempt(runtime));
          assert.equal(attempt?.state, "active");
          assert.equal(attempt?.outcome, undefined);
          assert.equal(h.worker.launches, 0);
        }),
    );
  });
});

/** One isolated cancelled Attempt whose retained pane launch precedes cancellation. */
async function partialCancellationFixture(
  h: Harness,
): Promise<{ base: string; placement: Placement; steps: Step[] }> {
  const { base, placement } = await isolated(h);
  await Effect.runPromise(h.git.createWorktree(ID, ATTEMPT, base));
  const sessionFile = await seedSessionRecord(h);
  const requested = { state: "requested" as const, requestedAt: T0, reason: "Stop." };
  const uncertain = { ...requested, state: "uncertain" as const, dispatchAt: T0 };
  const steps: Step[] = [
    ...paneLaunchSteps(placement, sessionFile),
    (s) => checkpointCancellation(s, key(), requested, T0),
    (s) => checkpointCancellation(s, key(), uncertain, T0),
  ];
  return { base, placement, steps };
}

void test("partial cancellation dispositions observe unknown, live, and proven-absent launches", async () => {
  await withHarness(async (h) => {
    const { base, placement, steps } = await partialCancellationFixture(h);
    const state = baseAttempt(ATTEMPT, { baseRevision: base });

    // Unknown presence stays blocked without inventing absence or a closure.
    h.worker.inspectLaunch = "unknown";
    await seeded(h, state, steps, (runtime) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => waitFor(() => h.attention.length > 0, "unknown block"));
        const attempt = yield* Effect.promise(() => currentAttempt(runtime));
        assert.equal(attempt?.state, "active");
        assert.equal(attempt?.execution?.cancellation?.state, "uncertain");
        assert.notEqual(attempt?.cleanup?.workerClosed, true);
        assert.equal(h.worker.interrupts, 0);
      }),
    );

    // A live resource advances to an exact identity and is interrupted.
    h.worker.inspectLaunch = "live";
    h.worker.presence = "working";
    await seeded(h, state, steps, (runtime) =>
      Effect.gen(function* () {
        const attempt = yield* Effect.promise(() =>
          until(runtime, (item) => item?.state === "finished"),
        );
        assert.equal(attempt.outcome?.kind, "cancelled");
        assert.equal(attempt.execution?.launch?.phase, "ready");
        assert.equal(attempt.cleanup?.workerClosed, true);
        assert.equal(h.worker.interrupts, 1);
      }),
    );

    // Exact observed absence closes the worker but preserves the checkout for release.
    h.worker.inspectLaunch = "absent";
    await seeded(h, state, steps, (runtime) =>
      Effect.gen(function* () {
        const attempt = yield* Effect.promise(() =>
          until(runtime, (item) => item?.cleanup?.state === "blocked"),
        );
        assert.equal(attempt.outcome?.kind, "cancelled");
        assert.equal(
          attempt.execution?.cancellation?.state === "submitted_or_observed"
            ? attempt.execution.cancellation.evidence
            : undefined,
          "absent",
        );
        assert.equal(attempt.cleanup?.workerClosed, true);
        assert.match(attempt.cleanup?.expectedHead ?? "", /^[0-9a-f]{40,64}$/);
        assert.equal(existsSync(placement.path), true);
        assert.equal(h.worker.launches, 0);
        const released = checkpointOutputRelease(
          yield* runtime.read(),
          key(),
          {
            state: "pending",
            expectedHead: attempt.cleanup?.expectedHead ?? "",
            reason: "Manual release of preserved output.",
          },
          T0,
        );
        assert.equal(released.tasks[0]?.attempts[0]?.outputRelease?.state, "pending");
      }),
    );
  });
});

void test("cancellation and cleanup without a launch prove absence from the session directory", async () => {
  const requested = { state: "requested" as const, requestedAt: T0, reason: "Stop." };
  const uncertain = { ...requested, state: "uncertain" as const, dispatchAt: T0 };

  await withHarness(async (h) => {
    await seeded(
      h,
      baseAttempt(ATTEMPT),
      [
        (s) =>
          activateAttempt(s, key(), T0, { placement: sharedPlacement(h), submission: "not_sent" }),
        (s) => checkpointCancellation(s, key(), requested, T0),
        (s) => checkpointCancellation(s, key(), uncertain, T0),
      ],
      (runtime) =>
        Effect.gen(function* () {
          const attempt = yield* Effect.promise(() =>
            until(runtime, (item) => item?.state === "finished"),
          );
          assert.equal(attempt.outcome?.kind, "cancelled");
          assert.equal(attempt.cleanup?.workerClosed, true);
          assert.equal(h.worker.launches, 0);
          assert.equal(h.worker.interrupts, 0);
        }),
    );
  });

  await withHarness(async (h) => {
    await seeded(
      h,
      baseAttempt(ATTEMPT),
      [
        (s) =>
          activateAttempt(s, key(), T0, { placement: sharedPlacement(h), submission: "not_sent" }),
        (s) =>
          terminalizeAttempt(
            s,
            key(),
            {
              kind: "unreported",
              observedAt: T0,
              artifacts: [],
              reason: "Pi settled without a report.",
              deliveryRequestedAt: T0,
            },
            T0,
          ),
        (s) => checkpointCleanup(s, key(), { state: "pending", workerClosed: false }, T0),
      ],
      (runtime) =>
        Effect.gen(function* () {
          const attempt = yield* Effect.promise(() =>
            until(runtime, (item) => item?.cleanup?.state === "completed"),
          );
          assert.equal(attempt.cleanup?.workerClosed, true);
          assert.equal(h.worker.launches, 0);
        }),
    );
  });
});

void test("cancelled settlement blocks until exact worker closure and then terminalizes", async () => {
  await withHarness(async (h) => {
    const placement = sharedPlacement(h);
    const sessionFile = await seedSessionRecord(h);
    const state = baseAttempt(ATTEMPT);
    const steps = cancelledSteps(placement, sessionFile, "submitted_or_observed", "idle");

    h.worker.cleanupState = "blocked";
    await seeded(h, state, steps, (runtime) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => waitFor(() => h.worker.cleanupCount > 0, "cleanup attempt"));
        yield* Effect.promise(() => waitFor(() => h.attention.length > 0, "closure block"));
        const attempt = yield* Effect.promise(() => currentAttempt(runtime));
        assert.equal(attempt?.state, "active");
        assert.notEqual(attempt?.cleanup?.workerClosed, true);
      }),
    );

    h.worker.cleanupState = "completed";
    await seeded(h, state, steps, (runtime) =>
      Effect.gen(function* () {
        const attempt = yield* Effect.promise(() =>
          until(runtime, (item) => item?.state === "finished"),
        );
        assert.equal(attempt.outcome?.kind, "cancelled");
        assert.equal(attempt.cleanup?.workerClosed, true);
      }),
    );
  });
});

void test("cleanup observes the exact HEAD after closure and a HEAD read failure blocks", async () => {
  await withHarness(async (h) => {
    const { base, placement } = await isolated(h);
    await Effect.runPromise(h.git.createWorktree(ID, ATTEMPT, base));
    const state = baseAttempt(ATTEMPT, { baseRevision: base });
    const steps: Step[] = [
      (s) => activateAttempt(s, key(), T0, { placement, submission: "not_sent" }),
      ...launchSteps(placement, "/sessions/no-head.jsonl", "submitted"),
      (s) => terminalizeAttempt(s, key(), reported(noChangeReport(base)), T0),
      // No expectedHead recorded yet: cleanup must observe it after closure.
      (s) => checkpointCleanup(s, key(), { state: "pending", workerClosed: true }, T0),
    ];
    await seeded(h, state, steps, (runtime) =>
      Effect.gen(function* () {
        const attempt = yield* Effect.promise(() =>
          until(runtime, (item) => item?.cleanup?.state === "completed"),
        );
        assert.equal(attempt.cleanup?.expectedHead, base);
        assert.equal(existsSync(placement.path), false);
      }),
    );

    // A host HEAD read failure blocks instead of converting uncertainty to absence.
    h.gitControl.failHead = true;
    await Effect.runPromise(h.git.createWorktree(ID, ATTEMPT, base));
    await seeded(h, state, steps, (runtime) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => waitFor(() => h.gitControl.headReadCount > 0, "HEAD read"));
        yield* Effect.promise(() => waitFor(() => h.attention.length > 0, "HEAD block"));
        const attempt = yield* Effect.promise(() => currentAttempt(runtime));
        assert.equal(attempt?.cleanup?.state, "pending");
        assert.equal(attempt?.cleanup?.expectedHead, undefined);
        assert.equal(attempt?.cleanup?.workerClosed, true);
      }),
    );
  });
});

function finishedSteps(
  placement: Placement,
  sessionFile: string,
  report: WorkerReport,
  expectedHead: string,
): Step[] {
  return [
    (s) => activateAttempt(s, key(), T0, { placement, submission: "not_sent" }),
    ...launchSteps(placement, sessionFile, "submitted"),
    (s) => terminalizeAttempt(s, key(), reported(report), T0),
    (s) => checkpointCleanup(s, key(), { state: "pending", workerClosed: true, expectedHead }, T0),
  ];
}

void test("finished cleanup removes proven no-change output and replays idempotently", async () => {
  await withHarness(async (h) => {
    const { base, placement } = await isolated(h);
    await Effect.runPromise(h.git.createWorktree(ID, ATTEMPT, base));
    const state = baseAttempt(ATTEMPT, { baseRevision: base });
    const steps = finishedSteps(placement, "/sessions/no-change.jsonl", noChangeReport(base), base);
    await seeded(h, state, steps, (runtime) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => until(runtime, (item) => item?.cleanup?.state === "completed"));
        assert.equal(existsSync(placement.path), false);
        assert.equal(yield* Effect.promise(() => branchHead(h, placement.branch)), undefined);
        assert.ok(!(yield* runtime.reconcile()).some((item) => item.kind === "cleanup"));
      }),
    );
  });
});

void test("retained changed output applies with exact checkpoints and releases its branch", async () => {
  await withHarness(async (h) => {
    const { base, placement } = await isolated(h);
    await Effect.runPromise(h.git.createWorktree(ID, ATTEMPT, base));
    const worktreeRepository = await Effect.runPromise(openRepository(h.repository.projectRoot));
    await writeFile(join(placement.path, "change.txt"), "changed\n");
    await git(placement.path, "add", ".");
    await git(placement.path, "commit", "-m", "Change");
    const candidate = await git(placement.path, "rev-parse", "HEAD");
    const validated = await Effect.runPromise(
      worktreeRepository.validateWorkerCommit({
        path: placement.path,
        branch: placement.branch,
        baseCommit: base,
      }),
    );
    assert.equal(validated.commit, candidate);
    const steps = finishedSteps(
      placement,
      "/sessions/changed.jsonl",
      {
        kind: "implementation",
        status: "completed",
        outcome: "changed",
        commit: candidate,
        changedFiles: ["change.txt"],
        summary: "Changed.",
        evidence: [],
        findings: [],
      },
      candidate,
    );
    let releaseCalls = 0;
    const commands: WorkstreamCommandPorts = {
      ...h.commands,
      git: {
        ...h.commands.git,
        releaseOutput: (ownedPlacement, expectedHead) => {
          releaseCalls += 1;
          return releaseCalls === 1
            ? Effect.succeed({
                state: "blocked" as const,
                path: ownedPlacement.path,
                branch: ownedPlacement.branch,
                expectedHead,
                detail: "Retain until application.",
              })
            : h.commands.git.releaseOutput(ownedPlacement, expectedHead);
        },
      },
    };
    await seeded(
      h,
      baseAttempt(ATTEMPT, { baseRevision: base }),
      steps,
      (runtime) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            until(runtime, (item) => item?.cleanup?.state === "completed"),
          );
          assert.equal(existsSync(placement.path), false);
          assert.equal(yield* Effect.promise(() => branchHead(h, placement.branch)), candidate);
          const correction = yield* runtime.appendAttempts({
            taskId: "task-1",
            candidateOf: ATTEMPT,
          });
          const correctionAttempt = correction.tasks[0]?.attempts[1];
          assert.equal(correctionAttempt?.baseRevision, candidate);
          assert.deepEqual(correctionAttempt?.candidate, {
            kind: "correction",
            rootCommit: base,
            parentAttemptId: ATTEMPT,
            parentCommit: candidate,
          });
          const suspended = yield* runtime.suspend({ reason: "Hold automatic work." });
          assert.equal(suspended.lifecycle, "suspended");
          const blocked = yield* runtime.releaseOutput({
            attemptId: ATTEMPT,
            reason: "Reviewed before application.",
          });
          assert.equal(blocked.tasks[0]?.attempts[0]?.outputRelease?.state, "blocked");
          const applied = yield* runtime.apply({ attemptId: ATTEMPT });
          const attempt = applied.tasks[0]?.attempts[0];
          assert.ok(attempt);
          assert.equal(attempt.application?.state, "applied");
          assert.equal(attempt.application?.revision, candidate);
          assert.equal(attempt.outputRelease?.state, "completed");
          assert.equal(attempt.outputRelease.reason, "Reviewed before application.");
          assert.equal(releaseCalls, 2);
          assert.equal(yield* h.commands.git.head, candidate);
          assert.equal(yield* Effect.promise(() => branchHead(h, placement.branch)), undefined);
          const replay = yield* runtime.apply({ attemptId: ATTEMPT });
          assert.deepEqual(replay.tasks[0]?.attempts[0]?.application, attempt.application);
          assert.deepEqual(replay.tasks[0]?.attempts[0]?.outputRelease, attempt.outputRelease);
          assert.equal(yield* Effect.promise(() => branchHead(h, placement.branch)), undefined);
        }),
      undefined,
      commands,
    );
  });
});

void test("completed output release replay preserves its reason and repairs cleanup without Git", async () => {
  await withHarness(async (h) => {
    const { base, placement } = await isolated(h);
    await Effect.runPromise(h.git.createWorktree(ID, ATTEMPT, base));
    await writeFile(join(placement.path, "released.txt"), "released\n");
    await git(placement.path, "add", ".");
    await git(placement.path, "commit", "-m", "Released");
    const candidate = await git(placement.path, "rev-parse", "HEAD");
    const released = await Effect.runPromise(
      h.commands.git.releaseOutput(
        { path: placement.path, branch: placement.branch, baseCommit: base },
        candidate,
      ),
    );
    assert.equal(released.state, "completed");
    const reason = "Reviewed before release.";
    const steps = [
      ...finishedSteps(
        placement,
        "/sessions/released.jsonl",
        {
          kind: "implementation" as const,
          status: "completed" as const,
          outcome: "changed" as const,
          commit: candidate,
          changedFiles: ["released.txt"],
          summary: "Released.",
          evidence: [],
          findings: [],
        },
        candidate,
      ),
      (s: Workstream) =>
        checkpointCleanup(
          s,
          key(),
          { state: "blocked", workerClosed: true, expectedHead: candidate, error: "Interrupted." },
          T0,
        ),
      (s: Workstream) =>
        checkpointOutputRelease(
          s,
          key(),
          { state: "pending", expectedHead: candidate, reason },
          T0,
        ),
      (s: Workstream) =>
        checkpointOutputRelease(
          s,
          key(),
          { state: "completed", expectedHead: candidate, reason },
          T0,
        ),
    ];
    let releaseCalls = 0;
    const commands: WorkstreamCommandPorts = {
      ...h.commands,
      git: {
        ...h.commands.git,
        releaseOutput: (...args) => {
          releaseCalls += 1;
          return h.commands.git.releaseOutput(...args);
        },
      },
    };
    await seeded(
      h,
      baseAttempt(ATTEMPT, { baseRevision: base }),
      steps,
      (runtime) =>
        Effect.gen(function* () {
          const before = yield* runtime.read();
          const conflicting = yield* Effect.result(
            runtime.releaseOutput({ attemptId: ATTEMPT, reason: "Different reason." }),
          );
          assert.equal(conflicting._tag, "Failure");
          assert.deepEqual(yield* runtime.read(), before);
          assert.equal(releaseCalls, 0);

          const repaired = yield* runtime.releaseOutput({ attemptId: ATTEMPT, reason });
          assert.equal(repaired.tasks[0]?.attempts[0]?.cleanup?.state, "completed");
          assert.equal(repaired.tasks[0]?.attempts[0]?.outputRelease?.reason, reason);
          assert.equal(releaseCalls, 0);
        }),
      undefined,
      commands,
    );
  });
});

void test("retained candidate integration resolves only the clean current destination HEAD", async () => {
  await withHarness(async (h) => {
    const { base, placement } = await isolated(h);
    await Effect.runPromise(h.git.createWorktree(ID, ATTEMPT, base));
    await writeFile(join(placement.path, "candidate.txt"), "candidate\n");
    await git(placement.path, "add", ".");
    await git(placement.path, "commit", "-m", "Candidate");
    const candidate = await git(placement.path, "rev-parse", "HEAD");
    await writeFile(join(h.repository.projectRoot, "destination.txt"), "destination\n");
    await git(h.repository.projectRoot, "add", ".");
    await git(h.repository.projectRoot, "commit", "-m", "Destination");
    const destination = await git(h.repository.projectRoot, "rev-parse", "HEAD");
    const steps = finishedSteps(
      placement,
      "/sessions/integration.jsonl",
      {
        kind: "implementation",
        status: "completed",
        outcome: "changed",
        commit: candidate,
        changedFiles: ["candidate.txt"],
        summary: "Candidate.",
        evidence: [],
        findings: [],
      },
      candidate,
    );
    await seeded(h, baseAttempt(ATTEMPT, { baseRevision: base }), steps, (runtime) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => until(runtime, (item) => item?.cleanup?.state === "completed"));
        yield* runtime.reviseIntent({
          statement: "Integrate the retained candidate.",
          constraints: [],
          grounding: {
            ...intent().grounding,
            id: "receipt-2",
            text: "Integrate the retained candidate.",
          },
          recordedAt: T0,
        });
        const suspended = yield* runtime.suspend({ reason: "Keep stale output manual." });
        const staleRevision = suspended.revision;
        const staleHead = yield* h.commands.git.head;
        const staleBranch = yield* Effect.promise(() => branchHead(h, placement.branch));
        for (const operation of [
          runtime.apply({ attemptId: ATTEMPT }),
          runtime.releaseOutput({ attemptId: ATTEMPT, reason: "Do not release stale output." }),
        ]) {
          const rejected = yield* Effect.result(operation);
          assert.equal(rejected._tag, "Failure");
          assert.equal((yield* runtime.read()).revision, staleRevision);
          assert.equal(yield* h.commands.git.head, staleHead);
          assert.equal(yield* Effect.promise(() => branchHead(h, placement.branch)), staleBranch);
        }
        yield* runtime.resume({ reason: "Continue with the current Intent." });
        const beforeInvalid = yield* runtime.read();
        const invalid = yield* Effect.result(
          runtime.enqueue({
            taskId: "forged-task",
            kind: "implementation",
            objective: "Forge lineage",
            acceptance: ["Must fail"],
            candidateOf: "missing-attempt",
            baseRevision: destination,
          }),
        );
        assert.equal(invalid._tag, "Failure");
        if (invalid._tag === "Failure")
          assert.ok(invalid.failure instanceof WorkstreamCommandError);
        assert.deepEqual(yield* runtime.read(), beforeInvalid);
        const integrated = yield* runtime.enqueue({
          taskId: "task-2",
          kind: "implementation",
          objective: "Integrate",
          acceptance: ["Candidate is integrated"],
          candidateOf: ATTEMPT,
          baseRevision: destination,
        });
        const attempt = integrated.tasks[1]?.attempts[0];
        assert.equal(attempt?.baseRevision, destination);
        assert.deepEqual(attempt?.candidate, {
          kind: "integration",
          rootCommit: destination,
          parentAttemptId: ATTEMPT,
          parentCommit: candidate,
        });
      }),
    );
  });
});

void test("pending application recovery blocks an incompatible destination without releasing output", async () => {
  await withHarness(async (h) => {
    const { base, placement } = await isolated(h);
    const worktree = await Effect.runPromise(h.git.createWorktree(ID, ATTEMPT, base));
    await writeFile(join(placement.path, "candidate.txt"), "candidate\n");
    await git(placement.path, "add", ".");
    await git(placement.path, "commit", "-m", "Candidate");
    const candidate = await git(placement.path, "rev-parse", "HEAD");
    await Effect.runPromise(h.git.cleanupWorktree(worktree, candidate, true));
    await writeFile(join(h.repository.projectRoot, "destination.txt"), "destination\n");
    await git(h.repository.projectRoot, "add", ".");
    await git(h.repository.projectRoot, "commit", "-m", "Destination moved");
    const destination = await git(h.repository.projectRoot, "rev-parse", "HEAD");
    const report: WorkerReport = {
      kind: "implementation",
      status: "completed",
      outcome: "changed",
      commit: candidate,
      changedFiles: ["candidate.txt"],
      summary: "Candidate.",
      evidence: [],
      findings: [],
    };
    const steps: Step[] = [
      (s) => activateAttempt(s, key(), T0, { placement, submission: "not_sent" }),
      ...launchSteps(placement, "/sessions/pending.jsonl", "submitted"),
      (s) => terminalizeAttempt(s, key(), reported(report), T0),
      (s) =>
        checkpointCleanup(
          s,
          key(),
          { state: "completed", workerClosed: true, expectedHead: candidate },
          T0,
        ),
      (s) =>
        checkpointApplication(
          s,
          key(),
          {
            state: "pending",
            commit: candidate,
            rootCommit: base,
            commits: [candidate],
            expectedRef: "refs/heads/main",
            expectedHead: base,
          },
          T0,
        ),
    ];
    await seeded(h, baseAttempt(ATTEMPT, { baseRevision: base }), steps, (runtime) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(runtime.apply({ attemptId: ATTEMPT }));
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.ok(result.failure instanceof WorkstreamCommandError);
        const attempt = (yield* runtime.readAttempt(ATTEMPT)).attempt;
        assert.equal(attempt.application?.state, "blocked");
        assert.equal(yield* h.commands.git.head, destination);
        assert.equal(yield* Effect.promise(() => branchHead(h, placement.branch)), candidate);
        assert.equal(attempt.outputRelease, undefined);
      }),
    );
  });
});

void test("same-owner pending delivery retries under backoff and delivers exact context", async () => {
  await withHarness(async (h) => {
    h.deliveryControl.failures = 1;
    const steps: Step[] = [
      (s) =>
        activateAttempt(s, key(), T0, { placement: sharedPlacement(h), submission: "not_sent" }),
      (s) => terminalizeAttempt(s, key(), reported(noChangeReport("a".repeat(40))), T0),
      (s) => checkpointCleanup(s, key(), { state: "completed", workerClosed: true }, T0),
    ];
    await seeded(h, baseAttempt(ATTEMPT), steps, (runtime) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          until(runtime, (item) => item?.outcome?.delivery.state === "delivered"),
        );
        assert.equal(h.deliveryControl.calls.length, 2);
        const first = h.deliveryControl.calls[0];
        assert.equal(first?.workstreamId, ID);
        assert.equal(first?.attempt.id, ATTEMPT);
        assert.equal(first?.attempt.outcome?.id, `${ATTEMPT}:outcome`);
      }),
    );
  });
});

void test("the production factory composes live Git with injected Worker/session/delivery ports", async () => {
  await withHarness(async (h) => {
    const { base, placement } = await isolated(h);
    const driver = makeLiveWorkstreamReconciliationDriver({
      repository: h.repository,
      workspaceId: "ws-test",
      git: h.git,
      workers: new HerdrCliRuntime("herdr", {}),
      delivery: h.ports.delivery,
      overrides: { workers: h.ports.workers, sessions: h.ports.sessions },
    });
    await seeded(
      h,
      baseAttempt(ATTEMPT, { baseRevision: base }),
      [],
      (runtime) =>
        Effect.gen(function* () {
          const attempt = yield* Effect.promise(() =>
            until(runtime, (item) => item?.execution?.submission === "submitted"),
          );
          assert.equal(attempt.execution?.launch?.phase, "ready");
          assert.equal(existsSync(placement.path), true);
        }),
      driver,
    );
  });
});
