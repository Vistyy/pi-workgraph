import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkgraphEngine } from "../src/engine.js";
import { WorkgraphRegistry } from "../src/registry.js";
import { RunStateStore } from "../src/state-store.js";
import { GitRepository, runProcess } from "../src/git.js";
import { testOutcome } from "./helpers.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess("git", ["-C", cwd, ...args], { cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function makeFixture() {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-registry-"));
  const root = join(parent, "repo");
  await runProcess("mkdir", ["-p", root], { cwd: parent, timeoutMs: 5_000 });
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "workgraph@example.test");
  await git(root, "config", "user.name", "Workgraph Registry");
  await writeFile(join(root, "value.txt"), "value\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  const repository = await GitRepository.open(root);
  const registry = new WorkgraphRegistry(join(parent, "registry.sqlite"));
  const begun = await WorkgraphEngine.begin({
    request: "Registry fixture.", projectRoot: root, gitCommonDir: repository.commonDir,
    parentSessionId: "session-a", parentSessionFile: join(parent, "a.jsonl"), baseCommit: await repository.head(),
    outcome: testOutcome.outcome,
  }, { repository, registry });
  return { parent, root, repository, registry, begun };
}

test("registry grants one lease, renews it, and requires authoritative stale-owner reconciliation", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-lease-"));
  const registry = new WorkgraphRegistry(join(parent, "registry.sqlite"));
  try {
    const run = {
      runId: "run", statePath: join(parent, "state.json"), projectRoot: parent, gitCommonDir: join(parent, ".git"),
      phase: "discovery", lifecycle: "active" as const, updatedAt: new Date(0).toISOString(),
      coordinator: { sessionId: "a", sessionFile: join(parent, "a.jsonl"), boundAt: new Date(0).toISOString() },
    } as any;
    registry.indexRun(run);
    const first = registry.acquire("run", { sessionId: "a", sessionFile: run.coordinator.sessionFile }, new Date(0));
    assert.throws(() => registry.acquire("run", { sessionId: "b", sessionFile: join(parent, "b.jsonl") }, new Date(1)), /leased by session a/);
    const renewed = registry.renew(first, new Date(10));
    assert.equal(renewed.owner.sessionId, "a");
    assert.throws(() => registry.acquire("run", { sessionId: "b", sessionFile: join(parent, "b.jsonl") }, new Date(LEASE_END)), /liveness is unknown/);
    const takeover = registry.acquire("run", { sessionId: "b", sessionFile: join(parent, "b.jsonl") }, new Date(LEASE_END), "dead");
    assert.equal(takeover.owner.sessionId, "b");
  } finally { registry.close(); await rm(parent, { recursive: true, force: true }); }
});

const LEASE_END = 31_000;

test("engine adoption changes coordinator identity without forking and lifecycle transitions are explicit", async () => {
  const fixture = await makeFixture();
  try {
    fixture.begun.engine.releaseLease();
    const adopted = await fixture.begun.engine.adopt("session-b", join(fixture.parent, "b.jsonl"));
    assert.equal(adopted.coordinator.sessionId, "session-b");
    assert.equal(adopted.handoffs.at(-1)?.kind, "adopt");
    assert.equal(adopted.handoffs.at(-1)?.fromSessionId, "session-a");
    const suspended = await fixture.begun.engine.setLifecycle("suspended", "User paused the run.");
    assert.equal(suspended.lifecycle, "suspended");
    const resumed = await fixture.begun.engine.adopt("session-b", join(fixture.parent, "b.jsonl"));
    assert.equal(resumed.lifecycle, "active");
    await assert.rejects(() => fixture.begun.engine.setLifecycle("archived", "Not settled."), /Invalid lifecycle transition/);
    const completed = await fixture.begun.engine.setLifecycle("completed", "Work settled.");
    assert.equal(completed.lifecycle, "completed");
    await assert.rejects(() => fixture.begun.engine.setLifecycle("abandoned", "Too late."), /Invalid lifecycle transition/);
  } finally { fixture.registry.close(); await rm(fixture.parent, { recursive: true, force: true }); }
});

test("version 3 migration preserves reports, sessions, decisions, nodes, evidence, and commits", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-migration-"));
  try {
    const path = join(parent, "state.json");
    const legacy = {
      version: 3, revision: 7, runId: "legacy", request: "legacy", projectRoot: parent, gitCommonDir: join(parent, ".git"), statePath: path,
      parentSessionId: "legacy-session", parentSessionFile: join(parent, "legacy.jsonl"), phase: "approved", baseCommit: "base", composedCommit: "commit",
      createdAt: new Date(0).toISOString(), updatedAt: new Date(1).toISOString(), outcome: testOutcome.outcome,
      milestones: [], discoveries: [{ id: "d", lens: "d", objective: "d", model: "provider/model", thinking: "high", topology: "partition", state: "completed", sessionFile: "d.jsonl", report: { kind: "discovery", status: "completed", summary: "kept", evidence: [], findings: [] } }],
      nodes: [], composition: [], humanDecisions: [{ kind: "agreement", prompt: "kept", accepted: true, at: new Date(0).toISOString() }], globalVerification: [],
    };
    await writeFile(path, JSON.stringify(legacy));
    const run = await new RunStateStore(path).load();
    assert.equal(run.version, 4);
    assert.equal(run.lifecycle, "active");
    assert.equal(run.creator.sessionId, "legacy-session");
    assert.equal(run.discoveries[0]?.report?.summary, "kept");
    assert.equal(run.humanDecisions[0]?.prompt, "kept");
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, 4);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("registry rebuild indexes retained state without inventing ownership", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-workgraph-rebuild-"));
  const registry = new WorkgraphRegistry(join(parent, "registry.sqlite"));
  try {
    const runs = join(parent, "runs", "run");
    await runProcess("mkdir", ["-p", runs], { cwd: parent, timeoutMs: 5_000 });
    await writeFile(join(runs, "state.json"), JSON.stringify({ runId: "run", projectRoot: parent, gitCommonDir: join(parent, ".git"), statePath: join(runs, "state.json"), phase: "discovery", lifecycle: "active", updatedAt: new Date(0).toISOString(), coordinator: { sessionId: "s", sessionFile: "s.jsonl", boundAt: new Date(0).toISOString() } }));
    assert.equal(await registry.rebuild(join(parent, "runs")), 1);
    const indexed = registry.findRun("run");
    assert.equal(indexed?.ownerSessionId, undefined);
    assert.equal(indexed?.lifecycle, "active");
  } finally { registry.close(); await rm(parent, { recursive: true, force: true }); }
});
