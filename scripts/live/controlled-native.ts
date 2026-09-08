/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/global-timers, effecttsgo/new-promise, effecttsgo/node-builtin-import, effecttsgo/process-env, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, typescript/strict-boolean-expressions, typescript/no-unsafe-return */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  type ControlledReply,
  type ControlledRequest,
  startControlledProvider,
} from "./controlled-provider.js";

const exec = promisify(execFile);
const source = process.cwd();
const started = Date.now();
const evidence = {
  status: "failed" as "passed" | "failed",
  candidateRevision: undefined as string | undefined,
  versions: undefined as
    | { candidate: string; sdk: string; nativePi: string; herdr: string }
    | undefined,
  phases: [] as Array<{ name: string; ms: number }>,
  requests: [] as Array<{ index: number; model: string; messageCount: number }>,
  providerErrors: [] as string[],
  cleanup: [] as string[],
  failure: undefined as string | undefined,
  retained: undefined as string | undefined,
  successArtifact: undefined as string | undefined,
  settlementEvents: [] as unknown[],
  workspaceSnapshots: [] as unknown[],
};
let parent: string | undefined;
let repo: string | undefined;
let workspaceId: string | undefined;
let paneId: string | undefined;
let tabId: string | undefined;
let terminalId: string | undefined;
let sessionFile: string | undefined;
let checkpointFile: string | undefined;
let eventFile: string | undefined;
let provider: Awaited<ReturnType<typeof startControlledProvider>> | undefined;
let researchGate: ResearchGate | undefined;
let settlementBaseline = 0;
let lastBoundary = "initialization";

function env(name: string): string | undefined {
  return process.env[name];
}

function prop<T>(value: Record<string, unknown>, key: string): T {
  const result = value[key];
  if (result === undefined) throw new Error(`Missing Herdr response field ${key}.`);
  return result as T;
}

function checkSignal(signal: AbortSignal): void {
  signal.throwIfAborted();
}

async function command(
  cwd: string,
  file: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  checkSignal(signal);
  const result = await exec(file, args, {
    cwd,
    signal,
    timeout: 30_000,
    maxBuffer: 2_000_000,
  });
  checkSignal(signal);
  return result.stdout.trim();
}

async function herdr(
  cwd: string,
  signal: AbortSignal,
  ...args: string[]
): Promise<Record<string, unknown>> {
  const envelope: unknown = JSON.parse(await command(cwd, "herdr", args, signal));
  if (typeof envelope !== "object" || envelope === null || !("result" in envelope))
    throw new Error(`Invalid Herdr response for ${args.join(" ")}.`);
  const result = envelope.result;
  if (typeof result !== "object" || result === null)
    throw new Error(`Invalid Herdr result for ${args.join(" ")}.`);
  return result as Record<string, unknown>;
}

async function phase<T>(name: string, run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  lastBoundary = name;
  checkSignal(signal);
  const result = await run();
  checkSignal(signal);
  evidence.phases.push({ name, ms: Date.now() - started });
  return result;
}

async function sessionEntries(): Promise<unknown[]> {
  assert.ok(sessionFile);
  const text = await readFile(sessionFile, "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function eventEntries(): Promise<unknown[]> {
  assert.ok(eventFile);
  try {
    const text = await readFile(eventFile, "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
}

async function waitFor(
  name: string,
  check: () => Promise<boolean>,
  signal: AbortSignal,
): Promise<void> {
  await phase(
    name,
    async () => {
      const until = Date.now() + 30_000;
      while (Date.now() < until) {
        checkSignal(signal);
        assertProviderHealthy();
        if (await check()) return;
        await sleep(200, undefined, { signal });
      }
      throw new Error(`Timed out at ${name}.`);
    },
    signal,
  );
}

function collectProviderErrors(): void {
  for (const error of provider?.errors ?? []) {
    if (!evidence.providerErrors.includes(error.message))
      evidence.providerErrors.push(error.message);
  }
}

function assertProviderHealthy(): void {
  collectProviderErrors();
  const error = provider?.errors[0];
  if (error !== undefined) throw error;
}

function settledEvents(entries: readonly unknown[], identity: string): unknown[] {
  return entries.filter(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "type" in entry &&
      entry.type === "agent_settled" &&
      "session" in entry &&
      entry.session === identity,
  );
}

function coordinatorResponse(request: ControlledRequest, count: number): ControlledReply {
  assert.equal(request.model, "coordinator");
  if (count === 1)
    return {
      tool: {
        id: "intent-request",
        name: "workgraph_intent",
        arguments: {
          statement: "Establish the read-only controlled-baseline scope.",
          constraints: ["Do not modify the fixture repository."],
        },
      },
    };
  if (count === 2) {
    const result = request.messages.find((message) =>
      JSON.stringify(message).includes('"tool_call_id":"intent-request"'),
    );
    assert.ok(result);
    assert.doesNotMatch(JSON.stringify(result), /isError.*true/);
    assert.match(JSON.stringify(result), /Recorded intent revision/);
    return {
      tool: {
        id: "research-request",
        name: "workgraph_research",
        arguments: {
          id: "controlled-baseline",
          question: "Read the fixture without changing it.",
          expectedEvidence: ["The fixture remains unchanged."],
          selection: { override: { model: "controlled/research", thinking: "off" } },
        },
      },
    };
  }
  if (count === 3) {
    const result = request.messages.find((message) =>
      JSON.stringify(message).includes('"tool_call_id":"research-request"'),
    );
    assert.ok(result);
    assert.doesNotMatch(JSON.stringify(result), /isError.*true/);
    return { text: "Initial coordinator turn settled independently." };
  }
  if (count === 4) {
    assert.match(JSON.stringify(request.messages), /\[WORKGRAPH OUTCOME\]/);
    return {
      tool: {
        id: "marker-call",
        name: "workgraph_notepad",
        arguments: {
          action: "add",
          id: "native-marker",
          text: "Native result triggered this turn.",
        },
      },
    };
  }
  assert.equal(count, 5);
  const marker = request.messages.find((message) =>
    JSON.stringify(message).includes('"tool_call_id":"marker-call"'),
  );
  assert.ok(marker);
  assert.doesNotMatch(JSON.stringify(marker), /isError.*true/);
  assert.match(JSON.stringify(marker), /Native result triggered this turn/);
  return { text: "Notification-driven continuation settled." };
}

interface ResearchGate {
  readonly promise: Promise<void>;
  readonly release: () => void;
  readonly reject: (cause: unknown) => void;
}

function createResearchGate(signal: AbortSignal): ResearchGate {
  let resolveGate: (() => void) | undefined;
  let rejectGate: ((cause: unknown) => void) | undefined;
  let settled = false;
  const cleanup = () => signal.removeEventListener("abort", abort);
  const settle = (settleGate: () => void) => {
    if (settled) return;
    settled = true;
    cleanup();
    settleGate();
    resolveGate = undefined;
    rejectGate = undefined;
  };
  const abort = () =>
    settle(() => rejectGate?.(signal.reason ?? new Error("Research release was aborted.")));
  const promise = new Promise<void>((resolve, reject) => {
    resolveGate = resolve;
    rejectGate = reject;
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  // The provider may not reach this promise before cleanup rejects it.
  void promise.catch(() => undefined);
  return {
    promise,
    release: () => settle(() => resolveGate?.()),
    reject: (cause) => settle(() => rejectGate?.(cause)),
  };
}

async function responseFor(
  request: ControlledRequest,
  counts: Map<string, number>,
  researchRelease: Promise<void>,
): Promise<ControlledReply> {
  evidence.requests.push({
    index: request.index,
    model: request.model,
    messageCount: request.messages.length,
  });
  const count = (counts.get(request.model) ?? 0) + 1;
  counts.set(request.model, count);
  if (request.model !== "research") return coordinatorResponse(request, count);
  assert.equal(count, 1);
  await researchRelease;
  return {
    tool: {
      id: "research-report",
      name: "workgraph_report",
      arguments: {
        kind: "research",
        status: "completed",
        summary: "Controlled research completed after coordinator settlement.",
        evidence: [{ label: "fixture", observation: "The controlled fixture is unchanged." }],
        findings: [],
      },
    },
  };
}

function modelConfig(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 1_000,
  };
}

async function persistCheckpoint(extra: Record<string, unknown> = {}): Promise<void> {
  assert.ok(checkpointFile);
  const previous = await readFile(checkpointFile, "utf8");
  const checkpoint = JSON.parse(previous) as Record<string, unknown>;
  await writeFile(checkpointFile, JSON.stringify({ ...checkpoint, ...extra }, null, 2));
}

async function workspaceSnapshot(signal: AbortSignal): Promise<Record<string, unknown>> {
  assert.ok(repo);
  const workspace = await herdr(repo, signal, "workspace", "list");
  const tabs = workspaceId
    ? await herdr(repo, signal, "tab", "list", "--workspace", workspaceId)
    : undefined;
  const panes = workspaceId
    ? await herdr(repo, signal, "pane", "list", "--workspace", workspaceId)
    : undefined;
  const snapshot = { workspace, tabs, panes };
  evidence.workspaceSnapshots.push(snapshot);
  return snapshot;
}

async function closeWorkspace(signal: AbortSignal): Promise<void> {
  if (
    repo === undefined ||
    workspaceId === undefined ||
    paneId === undefined ||
    tabId === undefined ||
    terminalId === undefined ||
    sessionFile === undefined
  )
    return;
  const info = prop<Record<string, unknown>>(
    await herdr(repo, signal, "workspace", "get", workspaceId),
    "workspace",
  );
  assert.equal(prop<string>(info, "workspace_id"), workspaceId);
  const tabs = prop<Array<Record<string, unknown>>>(
    await herdr(repo, signal, "tab", "list", "--workspace", workspaceId),
    "tabs",
  );
  const panes = prop<Array<Record<string, unknown>>>(
    await herdr(repo, signal, "pane", "list", "--workspace", workspaceId),
    "panes",
  );
  assert.equal(prop<number>(info, "tab_count"), tabs.length);
  assert.equal(prop<number>(info, "pane_count"), panes.length);
  assert.deepEqual(
    tabs.map((tab) => ({
      id: prop<string>(tab, "tab_id"),
      workspace: prop<string>(tab, "workspace_id"),
    })),
    [{ id: tabId, workspace: workspaceId }],
  );
  assert.deepEqual(
    panes.map((pane) => ({
      id: prop<string>(pane, "pane_id"),
      tab: prop<string>(pane, "tab_id"),
      workspace: prop<string>(pane, "workspace_id"),
      terminal: prop<string>(pane, "terminal_id"),
    })),
    [{ id: paneId, tab: tabId, workspace: workspaceId, terminal: terminalId }],
  );
  const observed = prop<Record<string, unknown>>(
    await herdr(repo, signal, "agent", "get", paneId),
    "agent",
  );
  assert.equal(prop<string>(observed, "workspace_id"), workspaceId);
  assert.equal(prop<string>(observed, "tab_id"), tabId);
  assert.equal(prop<string>(observed, "pane_id"), paneId);
  assert.equal(prop<string>(observed, "terminal_id"), terminalId);
  assert.equal(
    prop<string>(prop<Record<string, unknown>>(observed, "agent_session"), "value"),
    sessionFile,
  );
  assert.ok(["idle", "done"].includes(prop<string>(observed, "agent_status")));
  evidence.workspaceSnapshots.push({ beforeClose: { info, tabs, panes, agent: observed } });
  await herdr(repo, signal, "workspace", "close", workspaceId);
  const remaining = prop<Array<{ workspace_id: string }>>(
    await herdr(repo, signal, "workspace", "list"),
    "workspaces",
  );
  assert.ok(!remaining.some((item) => item.workspace_id === workspaceId));
  evidence.cleanup.push(
    "Exact owned workspace absence verified after checking its tab, pane, terminal, session, and idle agent identity.",
  );
}

async function run(signal: AbortSignal): Promise<void> {
  if (env("HERDR_ENV") !== "1")
    throw new Error("verify:native requires HERDR_ENV=1 and an operator-owned Herdr pane.");
  assert.equal(
    await command(source, "git", ["status", "--porcelain"], signal),
    "",
    "Use a clean committed candidate.",
  );
  evidence.candidateRevision = await command(source, "git", ["rev-parse", "HEAD"], signal);
  evidence.versions = {
    candidate: evidence.candidateRevision,
    sdk: "0.84.4 (package devDependency)",
    nativePi: await command(source, "pi", ["--version"], signal),
    herdr: await command(source, "herdr", ["--version"], signal),
  };
  parent = await phase(
    "fixture-created",
    () => mkdtemp(join(tmpdir(), "workgraph-controlled-native-")),
    signal,
  );
  repo = join(parent, "repo");
  const agentDir = join(parent, "agent");
  const home = join(parent, "home");
  const eventPath = join(parent, "events.jsonl");
  eventFile = eventPath;
  const sourceAgent = join(env("HOME") ?? tmpdir(), ".pi", "agent");
  await Promise.all([
    mkdir(repo),
    mkdir(join(agentDir, "extensions"), { recursive: true }),
    mkdir(join(agentDir, "workgraph"), { recursive: true }),
    mkdir(home),
  ]);
  await writeFile(join(parent, "OWNER"), parent);
  Reflect.set(process.env, "HOME", home);
  Reflect.set(process.env, "PI_CODING_AGENT_DIR", agentDir);
  Reflect.set(process.env, "PI_OFFLINE", "1");
  await command(repo, "git", ["init", "-b", "main"], signal);
  await command(repo, "git", ["config", "user.name", "Workgraph controlled native"], signal);
  await command(repo, "git", ["config", "user.email", "fixture@example.invalid"], signal);
  await writeFile(join(repo, "fixture.txt"), "unchanged\n");
  await command(repo, "git", ["add", "."], signal);
  await command(repo, "git", ["commit", "-m", "Fixture"], signal);
  await symlink(
    join(sourceAgent, "extensions", "herdr-agent-state.ts"),
    join(agentDir, "extensions", "herdr-agent-state.ts"),
  );
  const session = SessionManager.create(repo, join(parent, "coordinator-sessions"));
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Controlled native session initialized." }],
    api: "test",
    provider: "controlled",
    model: "coordinator",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  sessionFile = session.getSessionFile();
  assert.ok(sessionFile);
  const observer = `import { appendFileSync } from "node:fs";\nexport default function (pi) {\n  pi.on("agent_settled", (_event, ctx) => {\n    const session = ctx?.sessionManager?.getSessionFile?.();\n    if (session !== ${JSON.stringify(sessionFile)}) return;\n    appendFileSync(${JSON.stringify(eventPath)}, JSON.stringify({ type: "agent_settled", session, sessionId: ctx?.sessionManager?.getSessionId?.(), at: Date.now() }) + "\\n");\n  });\n}\n`;
  await writeFile(join(agentDir, "extensions", "observe-settlement.ts"), observer);
  const base = await command(repo, "git", ["rev-parse", "HEAD"], signal);
  checkpointFile = join(parent, "checkpoint.json");
  const before = await workspaceSnapshot(signal);
  await writeFile(
    checkpointFile,
    JSON.stringify(
      {
        sourceRevision: evidence.candidateRevision,
        fixture: parent,
        sessionFile,
        sourceRepository: source,
        baselineWorkspaceSnapshot: before,
        identities: {},
      },
      null,
      2,
    ),
  );
  const gate = createResearchGate(signal);
  researchGate = gate;
  const counts = new Map<string, number>();
  provider = await phase(
    "provider-listening",
    () =>
      startControlledProvider(
        Array.from(
          { length: 6 },
          () => (request: ControlledRequest) => responseFor(request, counts, gate.promise),
        ),
      ),
    signal,
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        controlled: {
          baseUrl: provider.baseUrl,
          api: "openai-completions",
          apiKey: "controlled-only-dummy",
          models: ["coordinator", "research"].map(modelConfig),
        },
      },
    }),
  );
  await writeFile(
    join(agentDir, "workgraph", "models.json"),
    JSON.stringify({
      version: 4,
      roles: {
        research: [{ model: "controlled/research", thinking: "off" }],
        review: [{ model: "controlled/research", thinking: "off" }],
        "implementation.guide": { model: "controlled/research", thinking: "off" },
        "implementation.executor": { model: "controlled/research", thinking: "off" },
      },
    }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [source], quietStartup: true, retry: { enabled: false } }),
  );
  const created = await phase(
    "workspace-created",
    () =>
      herdr(
        repo as string,
        signal,
        "workspace",
        "create",
        "--cwd",
        repo as string,
        "--label",
        "Controlled Workgraph verification",
        "--no-focus",
        "--env",
        `PI_CODING_AGENT_DIR=${agentDir}`,
        "--env",
        "PI_WORKGRAPH_MODE=",
        "--env",
        "PI_OFFLINE=1",
      ),
    signal,
  );
  workspaceId = prop<string>(prop(created, "workspace"), "workspace_id");
  await persistCheckpoint({ identities: { workspaceId } });
  paneId = prop<string>(prop(created, "root_pane"), "pane_id");
  await persistCheckpoint({ identities: { workspaceId, paneId } });
  tabId = prop<string>(prop(created, "tab"), "tab_id");
  await persistCheckpoint({ identities: { workspaceId, paneId, tabId } });
  const launched = await phase(
    "coordinator-started",
    () =>
      herdr(
        repo as string,
        signal,
        "agent",
        "start",
        "controlled-native-coordinator",
        "--kind",
        "pi",
        "--pane",
        paneId as string,
        "--timeout",
        "30000",
        "--",
        "--session",
        sessionFile as string,
        "--model",
        "controlled/coordinator",
        "--thinking",
        "off",
        "--offline",
        "--no-context-files",
        "--no-skills",
        "--no-prompt-templates",
      ),
    signal,
  );
  terminalId = prop<string>(prop(launched, "agent"), "terminal_id");
  await persistCheckpoint({ identities: { workspaceId, paneId, tabId, terminalId } });
  await waitFor(
    "coordinator-ready",
    async () => {
      const observed = prop<Record<string, unknown>>(
        await herdr(repo as string, signal, "agent", "get", paneId as string),
        "agent",
      );
      if (prop<string>(observed, "agent_status") === "blocked")
        throw new Error("Pi startup is blocked; no trust bypass was attempted.");
      assert.equal(prop<string>(observed, "cwd"), repo);
      assert.equal(prop<string>(observed, "terminal_id"), terminalId);
      return (
        prop<string>(prop<Record<string, unknown>>(observed, "agent_session"), "value") ===
        sessionFile
      );
    },
    signal,
  );
  settlementBaseline = settledEvents(await eventEntries(), sessionFile as string).length;
  await phase(
    "initial-prompt-submitted",
    () =>
      herdr(
        repo as string,
        signal,
        "agent",
        "prompt",
        paneId as string,
        "First establish the coordinator scope with workgraph_intent, then run exactly one read-only controlled-baseline research attempt, then stop. When its result arrives, record the continuation marker.",
      ),
    signal,
  );
  await waitFor(
    "initial-coordinator-settlement",
    async () =>
      settledEvents(await eventEntries(), sessionFile as string).length >= settlementBaseline + 1,
    signal,
  );
  gate.release();
  await gate.promise;
  await waitFor(
    "notification-requested",
    async () => (counts.get("coordinator") ?? 0) >= 4,
    signal,
  );
  await waitFor(
    "continuation-settlement",
    async () =>
      settledEvents(await eventEntries(), sessionFile as string).length >= settlementBaseline + 2 &&
      (counts.get("coordinator") ?? 0) === 5,
    signal,
  );
  evidence.settlementEvents = await eventEntries();
  const transcript = JSON.stringify(await sessionEntries());
  assert.match(transcript, /Native result triggered this turn/);
  assert.equal(await command(repo, "git", ["rev-parse", "HEAD"], signal), base);
  assert.equal(await readFile(join(repo, "fixture.txt"), "utf8"), "unchanged\n");
  assertProviderHealthy();
  provider.assertComplete();
  assert.equal(provider.requests.length, 6);
  assert.equal(provider.requests.filter((request) => request.model === "coordinator").length, 5);
  assert.equal(provider.requests.filter((request) => request.model === "research").length, 1);
  const providerRequests = provider.requests.map((request) => ({
    index: request.index,
    model: request.model,
    messages: request.messages,
  }));
  await phase("provider-cleanup", () => provider?.close() ?? Promise.resolve(), signal);
  await phase("native-cleanup", () => closeWorkspace(signal), signal);
  evidence.cleanup.push("Loopback provider closed after all requests.");
  const artifact = join(tmpdir(), `workgraph-controlled-native-success-${Date.now()}.json`);
  await writeFile(
    artifact,
    JSON.stringify(
      {
        candidate: evidence.candidateRevision,
        versions: evidence.versions,
        ownership: { fixture: parent, workspaceId, tabId, paneId, terminalId, sessionFile },
        closure: evidence.cleanup,
        settlementEvents: evidence.settlementEvents,
        providerRequests,
        chronology: evidence.phases,
      },
      null,
      2,
    ),
  );
  evidence.successArtifact = artifact;
  evidence.status = "passed";
}

const controller = new AbortController();
const overallTimer = setTimeout(
  () => controller.abort(new Error("verify:native exceeded its 180-second overall deadline.")),
  180_000,
);
try {
  await run(controller.signal);
} catch (cause) {
  if (!controller.signal.aborted) controller.abort(cause);
  collectProviderErrors();
  evidence.failure = `${lastBoundary} (${evidence.providerErrors.length > 0 ? "provider" : "native harness"}): ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`;
  evidence.retained = parent;
  process.exitCode = 1;
} finally {
  clearTimeout(overallTimer);
  if (evidence.status !== "passed")
    controller.abort(evidence.failure ?? new Error("Native run failed."));
  if (evidence.status !== "passed") researchGate?.reject(controller.signal.reason);
  const cleanupController = new AbortController();
  const cleanupTimer = setTimeout(
    () => cleanupController.abort(new Error("Native cleanup exceeded its 30-second deadline.")),
    30_000,
  );
  try {
    if (provider !== undefined) {
      await provider.close();
      collectProviderErrors();
      provider = undefined;
      evidence.cleanup.push("Loopback provider closure joined all request handlers.");
    }
    if (evidence.failure !== undefined && workspaceId !== undefined) {
      await closeWorkspace(cleanupController.signal);
    }
  } catch (cause) {
    evidence.cleanup.push(`Owned resources retained for reconciliation: ${String(cause)}`);
  } finally {
    clearTimeout(cleanupTimer);
  }
  if (parent !== undefined) {
    if (evidence.failure === undefined) {
      await rm(parent, { recursive: true, force: true });
    } else {
      await writeFile(join(parent, "failure.json"), JSON.stringify(evidence, null, 2));
    }
  }
  process.stdout.write(
    `${JSON.stringify({ ...evidence, lastBoundary, totalMs: Date.now() - started }, null, 2)}\n`,
  );
}
