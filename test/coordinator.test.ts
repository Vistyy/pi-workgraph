import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Coordinator integration fixtures use real host storage.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Fixture paths are real Git and session identities.
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { Type } from "typebox";
import { openRepository } from "../src/git.js";
import { HerdrCliRuntime } from "../src/herdr.js";
import { liveLayer } from "../src/node-platform.js";
import { WorkgraphRegistry } from "../src/registry.js";
import { type StoreEffect, WorkstreamStoreEffects } from "../src/workstream.js";
import { SqliteWorkstreamDatabase } from "../src/workstream-persistence.js";
import { WorkstreamRuntime } from "../src/workstream-runtime.js";
import { legacyPathForWorkstream } from "../src/workstream-state.js";
import { parsePersistedObject } from "../src/workstream-validation.js";
import {
  configureFixtureEnvironment,
  decodeTestValue,
  required,
  restoreFixtureEnvironment,
} from "./decoders.js";
import { extensionFixture, git, researchReport, resultState } from "./helpers.js";

function runStore<A>(effect: StoreEffect<A>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(liveLayer)));
}

async function settleFixtureAttempt(
  store: WorkstreamStoreEffects,
  attemptId: string,
  resultId: string,
): Promise<void> {
  const projectRoot = (await runStore(store.load())).projectRoot;
  await runStore(
    store.startAttempt({
      id: attemptId,
      placement: { kind: "shared_project", path: projectRoot },
    }),
  );
  await runStore(store.recordSessionFile(attemptId, `/tmp/${attemptId}.jsonl`));
  await runStore(
    store.settleAttempt({
      id: attemptId,
      resultId,
      effectiveModels: [{ model: "fixture/model", thinking: "low" }],
    }),
  );
  await runStore(store.beginCleanup({ id: attemptId }));
  await runStore(store.markWorkerClosed(attemptId));
  await runStore(store.finishCleanup(attemptId));
}

const textContentSchema = Type.Object({ type: Type.Literal("text"), text: Type.String() });
const actionDetailsSchema = Type.Object({
  view: Type.Object({
    action: Type.Object({ name: Type.String() }),
    affected: Type.Object({
      task: Type.Object({ idPreview: Type.String() }),
      attempt: Type.Object({
        handle: Type.String(),
        models: Type.Object({
          selected: Type.Object({ guide: Type.Object({ model: Type.String() }) }),
        }),
      }),
    }),
  }),
});
const overviewDetailsSchema = Type.Object({
  inspection: Type.Object({
    tasks: Type.Object({ totalItems: Type.Number() }),
    attention: Type.Object({ items: Type.Array(Type.Object({})) }),
  }),
});
const authorityActionDetailsSchema = Type.Object({
  view: Type.Object({
    action: Type.Object({
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
  }),
});
const resultDetailsSchema = Type.Object({
  inspection: Type.Object({
    report: Type.Object({ summary: Type.String() }),
    fullReport: Type.Object({}),
    fullEvidence: Type.Object({}),
  }),
});
const contentDetailsSchema = Type.Object({
  inspection: Type.Object({
    content: Type.Object({
      text: Type.String(),
      offset: Type.Number(),
      truncated: Type.Boolean(),
      next: Type.Optional(Type.Object({ offset: Type.Number() })),
    }),
  }),
});
const contextDetailsSchema = Type.Object({
  inspection: Type.Object({
    records: Type.Object({ text: Type.String() }),
  }),
});
const modelPolicyDetailsSchema = Type.Object({
  authority: Type.Optional(
    Type.Object({
      receiptId: Type.String(),
      source: Type.String(),
    }),
  ),
});
const persistedHeaderSchema = Type.Object({
  format: Type.String(),
  version: Type.Number(),
  id: Type.String(),
});

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-coordinator-"));
  const root = join(parent, "repo");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "fixture@example.test");
  await git(root, "config", "user.name", "Fixture");
  await writeFile(join(root, "value.txt"), "before\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "Fixture");
  const previous = configureFixtureEnvironment({
    PI_CODING_AGENT_DIR: join(parent, "agent"),
    PI_WORKGRAPH_MODE: null,
    HERDR_ENV: null,
    HERDR_WORKSPACE_ID: null,
  });
  const pi = await extensionFixture("coordinator", root, parent);
  return {
    ...pi,
    root,
    parent,
    async dispose() {
      await pi.close();
      restoreFixtureEnvironment(previous);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

async function createUnattachedWorkstream(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const repository = await Effect.runPromise(openRepository(f.root));
  return runStore(
    WorkstreamStoreEffects.create({
      id,
      purpose: "Fixture workstream",
      projectRoot: f.root,
      gitCommonDir: repository.commonDir,
      coordinator: {
        sessionId: f.session.getSessionId(),
        sessionFile: required(f.session.getSessionFile(), "coordinator session file"),
      },
    }),
  );
}

async function emptyWorkstream(f: Awaited<ReturnType<typeof fixture>>) {
  const created = await createUnattachedWorkstream(f, "empty-fixture");
  f.session.appendCustomEntry("pi-workgraph-workstream", {
    path: created.store.path,
  });
  await f.runner.emit({ type: "session_start", reason: "new" });
  return created.state;
}

void test("registered control and completion inputs are closed and action-specific", async () => {
  const f = await fixture();
  try {
    await emptyWorkstream(f);
    await assert.rejects(
      f.call("workgraph_control", {
        action: "suspend",
        reason: "Pause before inspection",
        task: "obsolete-task",
      }),
      /Invalid fixture input to workgraph_control/,
    );
    await assert.rejects(
      f.call("workgraph_control", {
        action: "apply",
        attempt: "missing-attempt",
        sourceCommit: "a".repeat(40),
        destinationHead: "b".repeat(40),
      }),
      /Invalid fixture input to workgraph_control/,
    );
    await assert.rejects(
      f.call("workgraph_complete", {
        conclusion: "No unresolved work",
        evidence: [{ label: "state", observation: "No assignments were queued." }],
        limitations: [],
        unresolved: [],
      }),
      /Invalid fixture input to workgraph_complete/,
    );
    const state = resultState((await f.call("workgraph_inspect", { section: "overview" })).details);
    assert.equal(state.lifecycle.state, "active");
    assert.equal(state.attempts.length, 0);
    const completed = resultState(
      (
        await f.call("workgraph_complete", {
          conclusion: "No unresolved work",
          evidence: [{ label: "state", observation: "No assignments were queued." }],
        })
      ).details,
    );
    assert.equal(completed.lifecycle.state, "completed");
  } finally {
    await f.dispose();
  }
});

void test("explicit target repository is fixed independently of coordinator cwd", async () => {
  const f = await fixture();
  try {
    const target = join(f.parent, "target-repository");
    await mkdir(target);
    await git(target, "init", "-b", "main");
    await git(target, "config", "user.email", "fixture@example.test");
    await git(target, "config", "user.name", "Target fixture");
    await writeFile(join(target, "target.txt"), "target\\n");
    await git(target, "add", ".");
    await git(target, "commit", "-m", "Target base");

    await f.runner.emitInput("Inspect the explicit target repository", undefined, "interactive");
    await f.call("workgraph_intent", {
      statement: "Inspect the explicit target repository",
      targetRepository: target,
    });
    await assert.rejects(
      f.call("workgraph_research", {
        id: "removed-target",
        question: "Try to retarget delegation",
        expectedEvidence: ["bytes"],
        targetRepository: target,
      }),
      /Invalid fixture input to workgraph_research/,
    );
    const queued = resultState(
      (
        await f.call("workgraph_research", {
          id: "targeted",
          question: "Inspect the explicit target repository",
          expectedEvidence: ["target bytes"],
        })
      ).details,
    );
    assert.equal(queued.projectRoot, target);
    assert.equal(queued.attempts[0]?.placement, undefined);
    await assert.rejects(
      f.call("workgraph_intent", {
        statement: "Try to switch repositories",
        targetRepository: f.root,
      }),
      /does not match the fixed workstream repository/,
    );
  } finally {
    await f.dispose();
  }
});

void test("registered delegation keeps established scope until explicit intent revision", async () => {
  const f = await fixture();
  try {
    const request = {
      id: "fix-value",
      objective: "Fix value",
      acceptance: ["Correct bytes"],
    };
    await assert.rejects(
      f.call("workgraph_intent", { statement: "No human receipt yet" }),
      /actual retained human input/,
    );
    await assert.rejects(
      f.call("workgraph_research", {
        id: "without-scope",
        question: "No scope yet",
        expectedEvidence: ["No queued attempt"],
      }),
      /No attached workstream/,
    );
    await f.runner.emitInput("Implement a change", undefined, "extension");
    await assert.rejects(f.call("workgraph_implement", request), /No attached workstream/);

    const initialScopeText = "What is value.txt?";
    await f.runner.emitInput(initialScopeText, undefined, "interactive");
    await f.call("workgraph_intent", { statement: initialScopeText });
    const initial = resultState(
      (
        await f.call("workgraph_research", {
          id: "read-value",
          question: initialScopeText,
          expectedEvidence: ["Exact bytes"],
        })
      ).details,
    );
    assert.equal(initial.assignments[0]?.id, "read-value");

    const firstHumanText = "Implement the maintained value change - private first context";
    await f.runner.emitInput(firstHumanText, undefined, "interactive");
    await f.call("workgraph_intent", { statement: "Fix value" });
    const firstResponse = await f.call("workgraph_implement", request);
    const firstAuthorized = resultState(firstResponse.details);
    const firstReceipt = required(firstAuthorized.inputs[1], "first retained human input").id;
    assert.equal(firstAuthorized.intents.at(-1)?.version, 2);
    assert.deepEqual(firstAuthorized.intents.at(-1)?.authorityReceiptIds, [firstReceipt]);
    assert.equal(firstAuthorized.assignments[1]?.intentVersion, 2);
    assert.equal(JSON.stringify(firstResponse).includes(firstHumanText), false);

    const secondHumanText =
      "Acknowledged. Continue with a second maintained slice under the same scope - private second context";
    await f.runner.emitInput(secondHumanText, undefined, "rpc");
    const secondResponse = await f.call("workgraph_implement", {
      ...request,
      id: "fix-value-follow-up",
      objective: "Apply the second maintained slice",
    });
    const secondAuthorized = resultState(secondResponse.details);
    const secondReceipt = required(secondAuthorized.inputs[2], "second retained human input").id;
    assert.notEqual(secondReceipt, firstReceipt);
    assert.equal(secondAuthorized.intents.at(-1)?.version, 2);
    assert.deepEqual(secondAuthorized.intents.at(-1)?.authorityReceiptIds, [firstReceipt]);
    assert.deepEqual(
      secondAuthorized.assignments.slice(1).map((item) => item.intentVersion),
      [2, 2],
    );
    const continuedAssignment = secondAuthorized.assignments[2];
    assert.equal(continuedAssignment?.artifactIntent, "maintained_change");
    if (continuedAssignment?.artifactIntent !== "maintained_change")
      throw new Error("Expected the continued maintained assignment.");
    assert.deepEqual(continuedAssignment.authority, {
      receiptId: firstReceipt,
      intentVersion: 2,
    });
    const continuationAuthority = decodeTestValue(
      authorityActionDetailsSchema,
      secondResponse.details,
    ).view.action.authorityContext;
    assert.deepEqual(continuationAuthority.selectedScope, {
      intentVersion: 2,
      authorityReceiptId: firstReceipt,
    });
    assert.deepEqual(continuationAuthority.latestObservedInput, {
      receiptId: secondReceipt,
      source: "rpc",
    });
    assert.equal(JSON.stringify(secondResponse).includes(secondHumanText), false);

    await assert.rejects(
      f.call("workgraph_implement", {
        ...request,
        id: "new-receipt-without-scope-revision",
        authorityReceiptId: secondReceipt,
      }),
      /Invalid fixture input to workgraph_implement/,
    );
    const afterRejectedReceipt = resultState(
      (await f.call("workgraph_inspect", { section: "overview" })).details,
    );
    assert.equal(afterRejectedReceipt.intents.at(-1)?.version, 2);
    assert.equal(
      afterRejectedReceipt.assignments.some(
        (item) => item.id === "new-receipt-without-scope-revision",
      ),
      false,
    );

    const explicitCurrent = resultState(
      (
        await f.call("workgraph_implement", {
          ...request,
          id: "fix-value-original-scope",
          objective: "Apply the coordinator judgment under original scope",
        })
      ).details,
    );
    assert.equal(explicitCurrent.intents.at(-1)?.version, 2);

    const changedScopeText =
      "Change the semantic scope to include the corrected follow-up - private changed context";
    await f.runner.emitInput(changedScopeText, undefined, "interactive");
    const beforeRevision = resultState(
      (await f.call("workgraph_inspect", { section: "overview" })).details,
    );
    const changedScopeReceipt = required(
      beforeRevision.inputs[3],
      "changed-scope retained human input",
    ).id;
    assert.equal(beforeRevision.intents.at(-1)?.version, 2);

    const revised = resultState(
      (
        await f.call("workgraph_intent", {
          authorityReceiptId: changedScopeReceipt,
          statement: "Apply the corrected follow-up scope",
          constraints: [],
        })
      ).details,
    );
    assert.equal(revised.intents.at(-1)?.version, 3);
    assert.deepEqual(revised.intents.at(-1)?.authorityReceiptIds, [changedScopeReceipt]);

    const changedScope = resultState(
      (
        await f.call("workgraph_implement", {
          ...request,
          id: "fix-value-revised-scope",
          objective: "Apply the corrected follow-up",
        })
      ).details,
    );
    const revisedAssignment = changedScope.assignments.at(-1);
    assert.equal(revisedAssignment?.artifactIntent, "maintained_change");
    if (revisedAssignment?.artifactIntent !== "maintained_change")
      throw new Error("Expected the revised-scope maintained assignment.");
    assert.equal(revisedAssignment.intentVersion, 3);
    assert.deepEqual(revisedAssignment.authority, {
      receiptId: changedScopeReceipt,
      intentVersion: 3,
    });
    assert.equal(changedScope.assignments[1]?.intentVersion, 2);
    assert.notEqual(
      changedScope.assignments[1]?.intentVersion,
      changedScope.intents.at(-1)?.version,
    );
    await assert.rejects(
      f.call("workgraph_implement", {
        ...request,
        id: "old-receipt-after-scope-revision",
        authorityReceiptId: firstReceipt,
      }),
      /Invalid fixture input to workgraph_implement/,
    );
    assert.deepEqual(
      changedScope.intents.map((intent) => intent.statement),
      [
        "What is value.txt?",
        "What is value.txt?",
        "Fix value",
        "Apply the corrected follow-up scope",
      ],
    );

    const retainedContext = decodeTestValue(
      contextDetailsSchema,
      (await f.call("workgraph_inspect", { section: "context", maxChars: 8_000 })).details,
    ).inspection.records.text;
    assert.match(retainedContext, new RegExp(firstReceipt));
    assert.match(retainedContext, new RegExp(secondReceipt));
    assert.match(retainedContext, new RegExp(changedScopeReceipt));
    assert.match(retainedContext, /private first context/);
    assert.match(retainedContext, /private second context/);
    assert.match(retainedContext, /private changed context/);
    await f.call("workgraph_control", {
      action: "suspend",
      reason: "Pause fixture",
    });
    await f.runner.emit({ type: "session_shutdown", reason: "reload" });
    await f.runner.emit({ type: "session_start", reason: "reload" });
    const reloaded = resultState(
      (await f.call("workgraph_inspect", { section: "overview" })).details,
    );
    assert.equal(reloaded.lifecycle.state, "suspended");
    assert.equal(reloaded.inputs.length, 4);
    await assert.rejects(
      f.call("workgraph_research", {
        id: "while-paused",
        question: "Read again",
        expectedEvidence: ["bytes"],
      }),
      /suspended/,
    );
  } finally {
    await f.dispose();
  }
});

void test("concurrent registered tools share one explicitly scoped runtime", async () => {
  const f = await fixture();
  try {
    await f.runner.emitInput("Inspect concurrent boundaries", undefined, "interactive");
    await f.call("workgraph_intent", { statement: "Inspect concurrent boundaries" });
    const [first, second] = await Promise.all([
      f.call("workgraph_research", {
        id: "concurrent-first",
        question: "Inspect the first concurrent boundary",
        expectedEvidence: ["One shared runtime"],
      }),
      f.call("workgraph_research", {
        id: "concurrent-second",
        question: "Inspect the second concurrent boundary",
        expectedEvidence: ["One shared runtime"],
      }),
    ]);
    const firstState = resultState(first.details);
    const secondState = resultState(second.details);
    assert.equal(firstState.id, secondState.id);
    assert.equal(firstState.statePath, secondState.statePath);
    assert.deepEqual(secondState.assignments.map((assignment) => assignment.id).sort(), [
      "concurrent-first",
      "concurrent-second",
    ]);
  } finally {
    await f.dispose();
  }
});

void test("registered AbortSignal interrupts native coordinator work", async () => {
  const f = await fixture();
  let previousEnvironment: NodeJS.ProcessEnv | undefined;
  try {
    const bin = join(f.parent, "blocking-bin");
    const pidPath = join(f.parent, "blocking-git.pid");
    await mkdir(bin);
    const executable = join(bin, "git");
    await writeFile(
      executable,
      `#!/bin/sh\necho $$ > ${JSON.stringify(pidPath)}\ntrap 'exit 130' TERM INT\nwhile :; do sleep 1; done\n`,
    );
    await chmod(executable, 0o755);
    await f.runner.emitInput("Review the current commit", undefined, "interactive");
    await f.call("workgraph_intent", { statement: "Review the current commit" });
    const revision = await git(f.root, "rev-parse", "HEAD");
    previousEnvironment = configureFixtureEnvironment({ PATH: `${bin}:/usr/bin:/bin` });
    const controller = new AbortController();
    const running = f.call(
      "workgraph_review",
      {
        id: "cancel-native-inspection",
        objective: "Cancel the native repository inspection",
        concern: "No detached process",
        subject: { kind: "revision", revision },
      },
      controller.signal,
    );
    for (let index = 0; index < 100; index++) {
      try {
        await readFile(pidPath);
        break;
      } catch {
        await Effect.runPromise(Effect.sleep("10 millis"));
      }
    }
    const pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
    controller.abort();
    await assert.rejects(running, /abort|interrupt/i);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    if (previousEnvironment !== undefined) restoreFixtureEnvironment(previousEnvironment);
    await f.dispose();
  }
});

void test("registered adoption uses authoritative snapshots and fences a stale expired owner", {
  timeout: 30_000,
}, async (t) => {
  const f = await fixture();
  let competing: WorkstreamRuntime | undefined;
  let previousEnvironment: NodeJS.ProcessEnv | undefined;
  const registry = new WorkgraphRegistry(join(f.parent, "agent", "workgraph", "registry.sqlite"));
  const operationSignal = () => AbortSignal.any([t.signal, AbortSignal.timeout(5_000)]);
  const leaseRow = (path: string) =>
    SqliteWorkstreamDatabase.use(path, (database) =>
      database.db.prepare("SELECT * FROM lease WHERE singleton=1").get(),
    );
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SQLite rows enter as unknown and are validated against the exact identity schema below.
  const leaseIdentity = (row: unknown) => {
    const { token, owner_session_id, owner_session_file, acquired_at } = decodeTestValue(
      Type.Object({
        token: Type.String(),
        owner_session_id: Type.String(),
        owner_session_file: Type.String(),
        acquired_at: Type.String(),
      }),
      row,
    );
    return { token, owner_session_id, owner_session_file, acquired_at };
  };
  const repositorySnapshot = async () => ({
    head: await git(f.root, "rev-parse", "HEAD"),
    bytes: await readFile(join(f.root, "value.txt"), "utf8"),
    worktrees: await git(f.root, "worktree", "list", "--porcelain"),
  });
  try {
    // Establish retained authority and suspension through the registered coordinator lifecycle.
    const retained = await emptyWorkstream(f);
    // Pi's shared input and shutdown fixture APIs have no signal parameter; the test timeout
    // remains their last stopping guard. Registered tool calls receive a shorter real signal.
    await f.runner.emitInput("Retain this recovery receipt", undefined, "interactive");
    await f.call(
      "workgraph_control",
      {
        action: "suspend",
        reason: "Await authoritative recovery",
      },
      operationSignal(),
    );
    const retainedBefore = resultState(
      (await f.call("workgraph_inspect", { section: "overview" }, operationSignal())).details,
    );
    assert.equal(retainedBefore.lifecycle.state, "suspended");
    assert.equal(retainedBefore.inputs.length, 1);
    await f.runner.emit({ type: "session_shutdown", reason: "reload" });

    const repository = await Effect.runPromise(openRepository(f.root));
    const otherOwner = {
      sessionId: "other-owner",
      sessionFile: join(f.parent, "other-owner.jsonl"),
    };
    const retainedStore = WorkstreamStoreEffects.open(retained.statePath, retained.coordinator);
    const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));
    // The frozen Effect clock prevents the task-owned runtime from renewing after fault injection.
    competing = await Effect.runPromise(
      WorkstreamRuntime.acquire(
        retainedStore,
        repository,
        new HerdrCliRuntime(),
        { workspaceId: "" },
        () => Effect.void,
        () => Effect.void,
        { registry, owner: otherOwner, clock },
      ).pipe(Effect.provide(liveLayer)),
    );
    await Effect.runPromise(competing.effects.submit(Effect.void).pipe(Effect.provide(liveLayer)));

    const current = await createUnattachedWorkstream(f, "current-work");
    f.session.appendCustomEntry("pi-workgraph-workstream", { path: current.store.path });
    await f.runner.emit({ type: "session_start", reason: "reload" });
    await f.call("workgraph_intent", { statement: "Inspect the current recovery workstream" });
    const currentState = resultState(
      (await f.call("workgraph_inspect", { section: "overview" }, operationSignal())).details,
    );
    assert.equal(currentState.id, "current-work");
    const currentLease = leaseIdentity(leaseRow(current.store.path));
    const liveCompetingLease = leaseIdentity(leaseRow(retainedStore.path));

    // A non-expired owner still refuses adoption. Liveness is consulted, but the unavailable
    // host yields unknown without invoking a Herdr subprocess.
    await assert.rejects(
      f.call("workgraph_adopt", { statePath: retainedStore.path }, operationSignal()),
      /runtime owner/,
    );
    assert.deepEqual(leaseIdentity(leaseRow(current.store.path)), currentLease);
    assert.deepEqual(leaseIdentity(leaseRow(retainedStore.path)), liveCompetingLease);
    const same = resultState(
      (await f.call("workgraph_adopt", { statePath: current.store.path }, operationSignal()))
        .details,
    );
    assert.equal(same.id, currentState.id);
    assert.deepEqual(leaseIdentity(leaseRow(current.store.path)), currentLease);

    const snapshotPath = join(f.parent, "coordinator-snapshot.json");
    const commandLog = join(f.parent, "coordinator-herdr-argv.jsonl");
    const command = join(f.parent, "controlled-herdr.mjs");
    await writeFile(
      command,
      `#!/usr/bin/env node\nimport { appendFileSync, readFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(commandLog)}, JSON.stringify(args) + "\\n");\nif (args.length !== 2 || args[0] !== "api" || args[1] !== "snapshot") {\n  console.error("unexpected controlled Herdr command");\n  process.exit(64);\n}\nprocess.stdout.write(readFileSync(${JSON.stringify(snapshotPath)}, "utf8"));\n`,
    );
    await chmod(command, 0o755);
    previousEnvironment = configureFixtureEnvironment({
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "controlled-workspace",
      PI_WORKGRAPH_HERDR_BIN: command,
    });

    const adoptWithFreshSnapshot = async () => {
      await writeFile(commandLog, "");
      try {
        return await f.call(
          "workgraph_adopt",
          { statePath: retainedStore.path },
          operationSignal(),
        );
      } finally {
        const commands = (await readFile(commandLog, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => decodeTestValue(Type.Array(Type.String()), JSON.parse(line)));
        assert.ok(commands.length > 0, "each adoption must inspect the current native snapshot");
        for (const args of commands) assert.deepEqual(args, ["api", "snapshot"]);
      }
    };

    // Native SQLite expiry is explicit fault injection. Snapshot contents model the
    // authoritative native observation boundary; this is not a real Herdr process death.
    SqliteWorkstreamDatabase.use(retainedStore.path, (database) => {
      database.db
        .prepare("UPDATE lease SET expires_at=? WHERE singleton=1")
        .run("2000-01-01T00:00:00.000Z");
    });
    const expiredCompetingLease = leaseRow(retainedStore.path);
    const unchangedResources = await repositorySnapshot();
    const assertRefusalInvariants = async () => {
      const attached = resultState(
        (await f.call("workgraph_inspect", { section: "overview" }, operationSignal())).details,
      );
      assert.equal(attached.id, currentState.id);
      assert.deepEqual(leaseIdentity(leaseRow(current.store.path)), currentLease);
      assert.deepEqual(leaseRow(retainedStore.path), expiredCompetingLease);
      assert.deepEqual(await repositorySnapshot(), unchangedResources);
    };

    await writeFile(
      snapshotPath,
      JSON.stringify({
        result: { snapshot: { agents: [{ agent_session: { value: otherOwner.sessionFile } }] } },
      }),
    );
    await assert.rejects(adoptWithFreshSnapshot(), /runtime owner/);
    await assertRefusalInvariants();

    await writeFile(
      snapshotPath,
      JSON.stringify({ result: { snapshot: { agents: [{ agent_session: {} }] } } }),
    );
    await assert.rejects(adoptWithFreshSnapshot(), /runtime owner/);
    await assertRefusalInvariants();

    await writeFile(snapshotPath, JSON.stringify({ result: { snapshot: { agents: [] } } }));
    const adopted = resultState((await adoptWithFreshSnapshot()).details);
    assert.equal(adopted.id, retainedBefore.id);
    assert.equal(adopted.lifecycle.state, "suspended");
    assert.deepEqual(adopted.inputs, retainedBefore.inputs);
    assert.equal(adopted.projectRoot, retainedBefore.projectRoot);
    assert.equal(adopted.gitCommonDir, retainedBefore.gitCommonDir);
    assert.deepEqual(adopted.results, []);
    assert.equal(adopted.coordinator.sessionId, f.session.getSessionId());
    assert.equal(adopted.coordinator.sessionFile, f.session.getSessionFile());
    assert.deepEqual(await repositorySnapshot(), unchangedResources);
    const replacementLease = leaseIdentity(leaseRow(retainedStore.path));
    assert.notDeepEqual(replacementLease, leaseIdentity(expiredCompetingLease));
    assert.equal(leaseRow(current.store.path), undefined);

    await assert.rejects(
      Effect.runPromise(
        competing.effects
          .submit(
            retainedStore.setLifecycle({ state: "active", reason: "stale owner must not mutate" }),
          )
          .pipe(Effect.provide(liveLayer)),
      ),
      /live lease/,
    );
    await Effect.runPromise(competing.effects.close);
    competing = undefined;
    assert.deepEqual(leaseIdentity(leaseRow(retainedStore.path)), replacementLease);

    await f.runner.emit({ type: "session_shutdown", reason: "quit" });
    assert.equal(leaseRow(retainedStore.path), undefined);
    assert.equal(leaseRow(current.store.path), undefined);
    assert.deepEqual(await repositorySnapshot(), unchangedResources);
  } finally {
    if (previousEnvironment !== undefined) restoreFixtureEnvironment(previousEnvironment);
    if (competing !== undefined) await Effect.runPromise(competing.effects.close);
    registry.close();
    // dispose awaits the registered shutdown before deleting the fixture directory.
    await f.dispose();
  }
});

void test("mutation responses stay action-focused while retaining handles, models, and exact read paths", async () => {
  const f = await fixture();
  try {
    const seeded = await createUnattachedWorkstream(f, "focused-fixture");
    const lease = await runStore(seeded.store.acquireLease(seeded.state.coordinator));
    for (let index = 0; index < 12; index++) {
      await runStore(
        seeded.store.enqueue(
          {
            id: `unrelated-${index}`,
            capability: "research",
            artifactIntent: "evidence_only",
            objective: `Unrelated history ${index}`,
            intentVersion: 0,
            expectedEvidence: ["bytes"],
          },
          {
            id: `unrelated-${index}-attempt`,
            models: { guide: { model: "fixture/model", thinking: "low" }, source: "policy" },
          },
        ),
      );
    }
    await runStore(seeded.store.releaseLease(lease));
    f.session.appendCustomEntry("pi-workgraph-workstream", { path: seeded.state.statePath });
    await f.runner.emit({ type: "session_start", reason: "new" });
    await f.runner.emitInput("Inspect the focused fixture", undefined, "interactive");
    await f.call("workgraph_intent", { statement: "Inspect the focused fixture" });

    const first = await f.call("workgraph_research", {
      id: "focused-research",
      question: "Inspect the focused fixture",
      expectedEvidence: ["bytes"],
      selection: { override: { model: "fixture/research", thinking: "low" } },
    });
    const firstText = decodeTestValue(textContentSchema, first.content[0]).text;
    const firstView = decodeTestValue(actionDetailsSchema, first.details).view;
    assert.equal(firstView.action.name, "workgraph_research");
    assert.equal(firstView.affected.task.idPreview, "focused-research");
    assert.equal(firstView.affected.attempt.models.selected.guide.model, "fixture/research");
    assert.match(firstView.affected.attempt.handle, /^attempt-/);
    assert.match(firstText, /focused-research/);
    assert.doesNotMatch(firstText, /"assignments":\s*\[/);

    const second = await f.call("workgraph_research", {
      id: "focused-second",
      question: "Inspect the second focused fixture",
      expectedEvidence: ["bytes"],
    });
    const secondView = decodeTestValue(actionDetailsSchema, second.details).view;
    assert.equal(secondView.affected.task.idPreview, "focused-second");
    assert.notEqual(secondView.affected.attempt.handle, firstView.affected.attempt.handle);
    const cancelled = resultState(
      (
        await f.call("workgraph_control", {
          action: "cancel",
          attempt: firstView.affected.attempt.handle,
        })
      ).details,
    );
    assert.equal(
      cancelled.attempts.find((attempt) => attempt.id === firstView.affected.attempt.handle)?.state,
      "cancelled",
    );
    assert.equal(
      cancelled.attempts.find((attempt) => attempt.id === secondView.affected.attempt.handle)
        ?.state,
      "queued",
    );

    const later = await f.call("workgraph_inspect", {
      section: "overview",
    });
    const laterText = decodeTestValue(textContentSchema, later.content[0]).text;
    assert.ok(laterText.length < 8_000);
    assert.match(laterText, /Unrelated history 0/);
    const laterView = decodeTestValue(overviewDetailsSchema, later.details).inspection;
    assert.equal(laterView.tasks.totalItems, 14);
    assert.deepEqual(laterView.attention.items, []);
  } finally {
    await f.dispose();
  }
});

void test("registered implementation models resolve partial guide and executor overrides", async () => {
  const f = await fixture();
  try {
    await f.runner.emitInput("Implement the bounded fixture change", undefined, "interactive");
    await f.call("workgraph_intent", { statement: "Implement the bounded fixture change" });
    const state = resultState(
      (
        await f.call("workgraph_implement", {
          id: "partial-role-overrides",
          objective: "Change the fixture",
          acceptance: ["The fixture changes"],
          models: {
            guide: { thinking: "low" },
            executor: { model: "fixture/executor-override" },
          },
        })
      ).details,
    );
    assert.deepEqual(state.attempts[0]?.models, {
      guide: { model: "openai-codex/gpt-6-astra", thinking: "low" },
      executor: { model: "fixture/executor-override", thinking: "xhigh" },
      source: "override",
    });
  } finally {
    await f.dispose();
  }
});

void test("registered assignment model inputs reject empty, legacy, and cross-capability forms before queueing", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.call("workgraph_research", {
        id: "empty-selection-override",
        question: "Read",
        expectedEvidence: ["bytes"],
        selection: { override: {} },
      }),
      /Invalid fixture input to workgraph_research/,
    );
    await assert.rejects(
      f.call("workgraph_research", {
        id: "legacy-selection-override",
        question: "Read",
        expectedEvidence: ["bytes"],
        selection: { override: { target: { model: "fixture/old", thinking: "low" } } },
      }),
      /Invalid fixture input to workgraph_research/,
    );
    await assert.rejects(
      f.call("workgraph_research", {
        id: "legacy-top-level-model",
        question: "Read",
        expectedEvidence: ["bytes"],
        model: "fixture/old",
      }),
      /Invalid fixture input to workgraph_research/,
    );
    await assert.rejects(
      f.call("workgraph_implement", {
        id: "selection-on-implementation",
        objective: "Change",
        acceptance: ["changed"],
        selection: { count: 1 },
      }),
      /Invalid fixture input to workgraph_implement/,
    );
    await assert.rejects(
      f.call("workgraph_implement", {
        id: "empty-role-overrides",
        objective: "Change",
        acceptance: ["changed"],
        models: {},
      }),
      /Invalid fixture input to workgraph_implement/,
    );
    await assert.rejects(
      f.call("workgraph_implement", {
        id: "legacy-executor-alias",
        objective: "Change",
        acceptance: ["changed"],
        executor: { model: "fixture/old", thinking: "low" },
      }),
      /Invalid fixture input to workgraph_implement/,
    );
    assert.deepEqual(f.selected, []);
  } finally {
    await f.dispose();
  }
});

void test("registered status stays compact and focused result retrieval projects bounded sections", async () => {
  const f = await fixture();
  try {
    const created = await createUnattachedWorkstream(f, "status-fixture");
    const store = created.store;
    const lease = await runStore(store.acquireLease(created.state.coordinator));
    const longObjective = `Retain bounded evidence ${"full assignment brief ".repeat(500)}`;
    await runStore(
      store.enqueue(
        {
          id: "large-result",
          capability: "research",
          artifactIntent: "evidence_only",
          objective: longObjective,
          intentVersion: 0,
          expectedEvidence: ["evidence"],
        },
        {
          id: "large-result-attempt",
          models: { guide: { model: "fixture/model", thinking: "low" }, source: "policy" },
        },
      ),
    );
    await runStore(
      store.retainResult({
        id: "large-result-1",
        assignmentId: "large-result",
        assignmentIntentVersion: 0,
        validity: "typed",
        report: {
          ...researchReport("A bounded summary"),
          evidence: Array.from({ length: 6 }, (_, index) => ({
            label: `evidence-${index}`,
            observation: `observation-${index}`,
          })),
          findings: Array.from({ length: 4 }, (_, index) => ({
            severity: "info" as const,
            title: `finding-${index}`,
            detail: `detail-${index}`,
            envelopeImpact: "none" as const,
          })),
        },
      }),
    );
    await settleFixtureAttempt(store, "large-result-attempt", "large-result-1");
    await runStore(store.releaseLease(lease));
    f.session.appendCustomEntry("pi-workgraph-workstream", { path: created.state.statePath });
    await f.runner.emit({ type: "session_start", reason: "new" });
    const status = await f.call("workgraph_inspect", { section: "overview" });
    const statusText = decodeTestValue(textContentSchema, status.content[0]).text;
    assert.match(statusText, /large-result/);
    assert.doesNotMatch(statusText, /observation-0/);
    assert.equal(statusText.includes(longObjective), false);
    assert.ok(statusText.length < 8_000);
    const defaultResult = await f.call("workgraph_inspect", {
      section: "outcome",
      result: "large-result-1",
      maxChars: 100,
    });
    const defaultView = decodeTestValue(resultDetailsSchema, defaultResult.details).inspection;
    assert.equal(defaultView.report.summary, "A bounded summary");
    assert.match(
      decodeTestValue(textContentSchema, defaultResult.content[0]).text,
      /large-result-1/,
    );
    const evidence = await f.call("workgraph_inspect", {
      section: "evidence",
      result: "large-result-1",
      offset: 2,
      maxChars: 100,
    });
    const evidenceContent = decodeTestValue(contentDetailsSchema, evidence.details).inspection
      .content;
    assert.equal(evidenceContent.offset, 2);
    assert.equal(evidenceContent.truncated, true);
    assert.equal(required(evidenceContent.next, "next evidence page").offset > 2, true);
    let assignmentText = "";
    let assignmentOffset = 0;
    for (let pageCount = 0; ; pageCount++) {
      assert.ok(pageCount < 100, "assignment pagination exceeded the fixture's page budget");
      const assignmentPage = await f.call("workgraph_inspect", {
        section: "assignment",
        task: "large-result",
        offset: assignmentOffset,
        maxChars: 173,
      });
      const page = decodeTestValue(contentDetailsSchema, assignmentPage.details).inspection.content;
      assignmentText += page.text;
      if (page.next === undefined) break;
      assert.equal(page.next.offset, assignmentOffset + page.text.length);
      assert.ok(page.next.offset > assignmentOffset);
      assignmentOffset = page.next.offset;
    }
    assert.equal(
      decodeTestValue(Type.Object({ objective: Type.String() }), JSON.parse(assignmentText))
        .objective,
      longObjective,
    );
    const state = resultState((await f.call("workgraph_inspect", { section: "overview" })).details);
    assert.equal(state.deliveries.length, 0);
    const completed = resultState(
      (
        await f.call("workgraph_complete", {
          conclusion: "The retained evidence is available and bounded.",
          evidence: [
            {
              label: "focused retrieval",
              observation: "Evidence and findings were retrieved by section.",
            },
          ],
          limitations: [],
        })
      ).details,
    );
    assert.equal(completed.lifecycle.state, "completed");
  } finally {
    await f.dispose();
  }
});

void test("registered session_start safely inspects retained and pointed workstreams", async () => {
  async function createState(f: Awaited<ReturnType<typeof fixture>>, id: string) {
    const repository = await Effect.runPromise(openRepository(f.root));
    return runStore(
      WorkstreamStoreEffects.create({
        id,
        purpose: "Startup inspection fixture",
        projectRoot: f.root,
        gitCommonDir: repository.commonDir,
        coordinator: {
          sessionId: f.session.getSessionId(),
          sessionFile: required(f.session.getSessionFile(), "coordinator session file"),
        },
      }),
    );
  }

  async function createLegacyState(f: Awaited<ReturnType<typeof fixture>>, id: string) {
    const created = await createState(f, id);
    const path = legacyPathForWorkstream(created.state.gitCommonDir, created.state.id);
    const current = parsePersistedObject(
      await runStore(WorkstreamStoreEffects.readRaw(created.state.statePath)),
    );
    const state = { ...current, statePath: path };
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
    return { ...created, state: { ...created.state, statePath: path } };
  }

  {
    const f = await fixture();
    try {
      const { state } = await createLegacyState(f, "legacy-terminal");
      const current = decodeTestValue(
        persistedHeaderSchema,
        JSON.parse(await readFile(state.statePath, "utf8")),
      );
      const legacy = {
        ...current,
        version: 3,
        lifecycle: {
          state: "completed",
          changedAt: "2026-09-05T12:00:00.000Z",
          reason: "Retained legacy completion fixture.",
        },
        completion: {
          conclusion: "A bounded historical completion.",
          evidence: [{ label: "fixture", observation: "bounded" }],
          limitations: [],
          unresolvedAssignmentIds: [],
          completedAt: "2026-09-05T12:00:00.000Z",
        },
      };
      await writeFile(state.statePath, `${JSON.stringify(legacy, null, 2)}\n`);
      const before = await readFile(state.statePath);
      await assert.rejects(
        runStore(WorkstreamStoreEffects.inspect(state.statePath)),
        /Unsupported workstream state/,
      );
      f.session.appendCustomEntry("pi-workgraph-workstream", {
        path: state.statePath,
      });
      await f.runner.emit({ type: "session_start", reason: "reload" });
      const inspection = await runStore(
        WorkstreamStoreEffects.inspectForReattachment(state.statePath),
      );
      assert.equal(inspection.kind, "retained_terminal");
      assert.equal(
        f.notifications.some((notification) => notification.type === "warning"),
        false,
      );
      assert.match(
        f.notifications
          .filter((notification) => notification.type === "info")
          .map((notification) => notification.message)
          .join("\n"),
        /completed older history .*preserved and not attached/,
      );
      assert.deepEqual(await readFile(state.statePath), before);
      await assert.rejects(
        f.call("workgraph_inspect", { section: "overview" }),
        /No attached workstream/,
      );
    } finally {
      await f.dispose();
    }
  }

  {
    const f = await fixture();
    try {
      const { state } = await createLegacyState(f, "legacy-active");
      const current = decodeTestValue(
        persistedHeaderSchema,
        JSON.parse(await readFile(state.statePath, "utf8")),
      );
      const legacy = { ...current, version: 3 };
      await writeFile(state.statePath, `${JSON.stringify(legacy, null, 2)}\n`);
      f.session.appendCustomEntry("pi-workgraph-workstream", {
        path: state.statePath,
      });
      const before = await readFile(state.statePath);
      await f.runner.emit({ type: "session_start", reason: "reload" });
      assert.match(
        f.notifications
          .filter((notification) => notification.type === "warning")
          .map((notification) => notification.message)
          .join("\n"),
        /Unsupported workstream state.*Inspect the retained pointer and state.*reconcile explicitly/,
      );
      assert.deepEqual(await readFile(state.statePath), before);
      await assert.rejects(
        f.call("workgraph_inspect", { section: "overview" }),
        /No attached workstream/,
      );
    } finally {
      await f.dispose();
    }
  }

  for (const [label, pointer, diagnostic] of [
    ["malformed", { path: 42 }, /pointer is malformed.*repair it explicitly/],
    [
      "missing",
      { path: "/definitely/missing/workstream.json" },
      /ENOENT.*Inspect the retained pointer and state.*reconcile explicitly/,
    ],
    [
      "unsupported",
      { path: "/definitely/unsupported/workstream.json" },
      /Unsupported workstream state.*Inspect the retained pointer and state/,
    ],
  ] as const) {
    const f = await fixture();
    try {
      if (label === "unsupported") {
        const pointerPath = join(f.parent, "unsupported.json");
        await writeFile(
          pointerPath,
          JSON.stringify({
            format: "pi-workgraph-workstream",
            version: 99,
            id: "unsupported",
          }),
        );
        f.session.appendCustomEntry("pi-workgraph-workstream", {
          path: pointerPath,
        });
      } else {
        f.session.appendCustomEntry("pi-workgraph-workstream", pointer);
      }
      await f.runner.emit({ type: "session_start", reason: "reload" });
      assert.match(
        f.notifications
          .filter((notification) => notification.type === "warning")
          .map((notification) => notification.message)
          .join("\n"),
        diagnostic,
        label,
      );
      await assert.rejects(
        f.call("workgraph_inspect", { section: "overview" }),
        /No attached workstream/,
        label,
      );
    } finally {
      await f.dispose();
    }
  }

  {
    const f = await fixture();
    try {
      const { state } = await createState(f, "current-active");
      f.session.appendCustomEntry("pi-workgraph-workstream", {
        path: state.statePath,
      });
      await f.runner.emit({ type: "session_start", reason: "reload" });
      const attached = resultState(
        (await f.call("workgraph_inspect", { section: "overview" })).details,
      );
      assert.equal(attached.id, "current-active");
      assert.equal(attached.lifecycle.state, "active");
    } finally {
      await f.dispose();
    }
  }

  {
    const f = await fixture();
    try {
      const { state: created, store } = await createState(f, "current-terminal");
      const lease = await runStore(store.acquireLease(created.coordinator));
      const state = await runStore(
        store.setLifecycle({
          state: "abandoned",
          reason: "Current terminal startup fixture.",
        }),
      );
      await runStore(store.releaseLease(lease));
      f.session.appendCustomEntry("pi-workgraph-workstream", {
        path: state.statePath,
      });
      await f.runner.emit({ type: "session_start", reason: "reload" });
      await assert.rejects(
        f.call("workgraph_inspect", { section: "overview" }),
        /No attached workstream/,
      );
    } finally {
      await f.dispose();
    }
  }
});

void test("registered model policy selection requires genuine input and persists one mutation", async () => {
  const f = await fixture();
  try {
    await f.runner.emitInput("Extension model request", undefined, "extension");
    await assert.rejects(
      f.call("workgraph_models", {
        action: "set",
        role: "research",
        target: { model: "fixture/rejected", thinking: "low" },
      }),
      /actual retained human input/,
    );
    assert.equal(
      JSON.stringify(await f.call("workgraph_models", { action: "get" })).includes(
        "fixture/rejected",
      ),
      false,
    );

    await f.runner.emitInput("Persist the first research model", undefined, "interactive");
    const mutation = decodeTestValue(
      modelPolicyDetailsSchema,
      (
        await f.call("workgraph_models", {
          action: "set_list",
          role: "research",
          list: [{ model: "fixture/default", thinking: "low" }],
        })
      ).details,
    );
    const receipt = required(mutation.authority, "model authority").receiptId;
    assert.equal(mutation.authority?.source, "interactive");
    assert.match(JSON.stringify(mutation), new RegExp(receipt));
    await f.call("workgraph_intent", {
      statement: "Read",
      authorityReceiptId: receipt,
    });

    const selected = resultState(
      (
        await f.call("workgraph_research", {
          id: "first",
          question: "Read",
          expectedEvidence: ["bytes"],
        })
      ).details,
    );
    assert.deepEqual(selected.attempts[0]?.models?.guide, {
      model: "fixture/default",
      thinking: "low",
    });

    await assert.rejects(
      f.call("workgraph_models", {
        action: "set_list",
        authorityReceiptId: "extension-invented-receipt",
        role: "research",
        list: [{ model: "fixture/rejected-list", thinking: "low" }],
      }),
      /Unknown retained human input receipt/,
    );
    assert.equal(
      JSON.stringify(await f.call("workgraph_models", { action: "get" })).includes(
        "fixture/rejected-list",
      ),
      false,
    );
    assert.deepEqual(f.selected, []);
  } finally {
    await f.dispose();
  }
});
