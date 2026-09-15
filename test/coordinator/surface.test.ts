import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { Value } from "typebox/value";
import { RecordStore } from "../../src/coordinator/store.js";
import type { AttemptSpec, Task } from "../../src/domain/records.js";
import {
  applyCoordinatorCheckout,
  prepareCoordinatorApplication,
  prepareCoordinatorDiscard,
  removeAppliedCoordinatorWorktree,
  removeDiscardedCoordinatorWorktree,
} from "../../src/repository.js";
import { configureFixtureEnvironment, restoreFixtureEnvironment } from "../support/decoders.js";
import { extensionFixture, git, persistentSession } from "../support/helpers.js";

const accepted = [
  "workgraph_models",
  "workgraph_checkout",
  "workgraph_research",
  "workgraph_consult",
  "workgraph_implement",
  "workgraph_review",
  "workgraph_attempt",
  "workgraph_inspect",
  "workgraph_control",
  "workgraph_notepad",
] as const;

async function fixture(
  available: boolean,
  workspaceId = available ? "workspace-exact" : null,
  role: string | null = null,
) {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-coordinator-"));
  const root = join(parent, "repo");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Workgraph Test");
  await git(root, "config", "user.email", "workgraph@example.invalid");
  await writeFile(join(root, "file.txt"), "base\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "base");

  const previous = configureFixtureEnvironment({
    PI_CODING_AGENT_DIR: join(parent, "agent"),
    PI_WORKGRAPH_ROLE: role,
    HERDR_ENV: available ? "1" : null,
    HERDR_WORKSPACE_ID: workspaceId,
    HERDR_TAB_ID: null,
    PI_WORKGRAPH_HERDR_BIN: "/bin/false",
  });

  const pi = await extensionFixture("coordinator", root, parent);

  return {
    ...pi,
    parent,
    root,
    agentDir: join(parent, "agent"),
    async dispose() {
      await pi.close();
      restoreFixtureEnvironment(previous);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

void test("coordinator registers exactly ten strict tools", async () => {
  const f = await fixture(false);

  try {
    const registered = f.runner
      .getAllRegisteredTools()
      .map((tool) => tool.definition.name)
      .filter((name) => name.startsWith("workgraph_"))
      .sort();

    assert.deepEqual(registered, [...accepted].sort());
    const implement = f.runner.getToolDefinition("workgraph_implement");
    assert.ok(implement !== undefined);
    assert.equal(
      Value.Check(implement.parameters, {
        id: "change",
        cwd: ".",
        objective: "Change it",
        acceptance: ["Works"],
        candidateOf: { attemptId: "attempt-old", mode: "integrate" },
        baseRevision: "a".repeat(40),
      }),
      true,
    );
    assert.equal(
      Value.Check(implement.parameters, {
        id: "change",
        objective: "Change it",
        acceptance: ["Works"],
        unexpected: true,
      }),
      false,
    );
    const control = f.runner.getToolDefinition("workgraph_control");
    assert.ok(control !== undefined);
    assert.equal(
      Value.Check(control.parameters, { action: "cancel", attemptId: "a", reason: "stop" }),
      true,
    );
    assert.equal(Value.Check(control.parameters, { action: "cancel", attemptId: "a" }), false);
    assert.equal(
      Value.Check(control.parameters, { action: "discard_output", attemptId: "a", reason: "old" }),
      true,
    );
    const checkout = f.runner.getToolDefinition("workgraph_checkout");
    assert.ok(checkout !== undefined);
    assert.equal(Value.Check(checkout.parameters, { action: "create", cwd: "." }), true);
    assert.equal(
      Value.Check(checkout.parameters, { action: "discard", checkoutId: "a", reason: " " }),
      false,
    );
    assert.equal(
      Value.Check(checkout.parameters, { action: "inspect", checkoutId: "a", extra: true }),
      false,
    );

    const guidance = (
      await readFile(new URL("../../COORDINATOR.md", import.meta.url), "utf8")
    ).trim();

    const injected = await f.runner.emitBeforeAgentStart(
      "Coordinate the request",
      undefined,
      "Base coordinator prompt",
      { cwd: f.root },
    );

    assert.equal(
      injected?.systemPrompt,
      `Base coordinator prompt\n\n${guidance}`,
      "the loaded coordinator extension injects the packaged guidance",
    );
  } finally {
    await f.dispose();
  }
});

void test("checkout create reuses one session placement and isolates another session", async () => {
  const f = await fixture(false);
  const otherSession = persistentSession(f.root, join(f.parent, "other-sessions"));
  const other = await extensionFixture("coordinator", f.root, f.parent, {}, [], otherSession);

  try {
    await f.runner.emit({ type: "session_start", reason: "startup" });
    await other.runner.emit({ type: "session_start", reason: "startup" });
    const first = await f.call("workgraph_checkout", { action: "create" });
    const repeated = await f.call("workgraph_checkout", { action: "create", cwd: "." });
    const second = await other.call("workgraph_checkout", { action: "create" });
    await writeFile(join(f.root, "destination-dirty.txt"), "not part of the checkout\n");
    const dirtyDestinationReuse = await f.call("workgraph_checkout", { action: "create" });

    // SAFETY: Checkout tool results own these exact identity and lifecycle fields.
    const firstFacts = first.details as {
      checkoutId: string;
      managedPath: string;
      ownedBranch: string;
      lifecycle: string;
      created: boolean;
    };

    // SAFETY: The repeated create has the same checkout receipt plus the reuse fact.
    const repeatedFacts = repeated.details as typeof firstFacts & { reused: boolean };

    // SAFETY: Reuse reports the existing identity and observed dirty destination.
    const dirtyReuseFacts = dirtyDestinationReuse.details as typeof repeatedFacts & {
      destinationDirty: boolean;
    };

    // SAFETY: The second session returns the same strict checkout receipt shape.
    const secondFacts = second.details as typeof firstFacts;

    assert.equal(firstFacts.created, true);
    assert.equal(firstFacts.lifecycle, "ready");
    assert.equal(repeatedFacts.checkoutId, firstFacts.checkoutId);
    assert.equal(repeatedFacts.managedPath, firstFacts.managedPath);
    assert.equal(repeatedFacts.reused, true);
    assert.equal(dirtyReuseFacts.checkoutId, firstFacts.checkoutId);
    assert.equal(dirtyReuseFacts.destinationDirty, true);
    assert.notEqual(secondFacts.checkoutId, firstFacts.checkoutId);
    assert.notEqual(secondFacts.managedPath, firstFacts.managedPath);
    assert.notEqual(secondFacts.ownedBranch, firstFacts.ownedBranch);
    assert.equal(existsSync(firstFacts.managedPath), true);
    assert.equal(existsSync(secondFacts.managedPath), true);
    await f.runner.emit({ type: "session_shutdown", reason: "reload" });
    assert.equal(existsSync(firstFacts.managedPath), true);
    assert.equal((await git(f.root, "show-ref", "--verify", firstFacts.ownedBranch)) !== "", true);
    await f.runner.emit({ type: "session_start", reason: "resume" });

    const resumed = await f.call("workgraph_checkout", {
      action: "inspect",
      checkoutId: firstFacts.checkoutId,
    });

    // SAFETY: Inspect returns the exact recorded checkout lifecycle.
    assert.equal((resumed.details as { lifecycle: string }).lifecycle, "ready");

    const listed = await f.call("workgraph_checkout", { action: "list", limit: 10 });
    // SAFETY: List returns the exact session's verified checkout projections.
    assert.deepEqual(
      (listed.details as { checkouts: Array<{ checkoutId: string }> }).checkouts.map(
        (entry) => entry.checkoutId,
      ),
      [firstFacts.checkoutId],
    );
    await f.call("workgraph_checkout", {
      action: "discard",
      checkoutId: firstFacts.checkoutId,
      reason: "Fixture cleanup",
    });
    await other.call("workgraph_checkout", {
      action: "discard",
      checkoutId: secondFacts.checkoutId,
      reason: "Fixture cleanup",
    });
  } finally {
    await other.close();
    await f.dispose();
  }
});

void test("checkout applies committed direct work after destination advancement", async () => {
  const f = await fixture(false);

  try {
    await f.runner.emit({ type: "session_start", reason: "startup" });
    const created = await f.call("workgraph_checkout", { action: "create" });

    // SAFETY: Create returns exact managed placement and branch identity.
    const facts = created.details as {
      checkoutId: string;
      managedPath: string;
      ownedBranch: string;
      baseCommit: string;
    };

    await writeFile(join(f.root, ".git", "info", "exclude"), "ignored.bin\n");
    await writeFile(join(facts.managedPath, "ignored.bin"), "allowed ignored artifact\n");
    await writeFile(join(facts.managedPath, "direct.txt"), "coordinator\n");
    await git(facts.managedPath, "add", "direct.txt");
    await git(facts.managedPath, "commit", "-m", "direct work");
    await writeFile(join(f.root, "destination.txt"), "advanced\n");
    await git(f.root, "add", "destination.txt");
    await git(f.root, "commit", "-m", "destination advancement");

    const applied = await f.call("workgraph_checkout", {
      action: "apply",
      checkoutId: facts.checkoutId,
    });

    // SAFETY: Apply returns the established destination revision and release status.
    const appliedFacts = applied.details as {
      lifecycle: string;
      revision: string;
      released: boolean;
    };

    assert.equal(appliedFacts.lifecycle, "applied");
    assert.equal(appliedFacts.released, true);
    assert.equal(await git(f.root, "rev-parse", "HEAD"), appliedFacts.revision);
    assert.equal(await readFile(join(f.root, "direct.txt"), "utf8"), "coordinator\n");
    assert.equal(await readFile(join(f.root, "destination.txt"), "utf8"), "advanced\n");
    assert.equal(existsSync(facts.managedPath), false);
    await assert.rejects(git(f.root, "show-ref", "--verify", facts.ownedBranch));
    const overview = await f.call("workgraph_inspect", { section: "overview" });

    // SAFETY: Overview returns the strict session-local counts projection.
    assert.equal(
      (overview.details as { counts: { coordinatorCheckouts: number } }).counts
        .coordinatorCheckouts,
      0,
    );
  } finally {
    await f.dispose();
  }
});

void test("apply resumes after uncertain integration and worktree-removal responses", async () => {
  const f = await fixture(false);

  try {
    await f.runner.emit({ type: "session_start", reason: "startup" });
    const created = await f.call("workgraph_checkout", { action: "create" });

    // SAFETY: Create returns exact managed placement identity.
    const facts = created.details as {
      checkoutId: string;
      managedPath: string;
      ownedBranch: string;
    };

    await writeFile(join(facts.managedPath, "resumed.txt"), "resumed apply\n");
    await git(facts.managedPath, "add", "resumed.txt");
    await git(facts.managedPath, "commit", "-m", "resumed apply");

    const store = new RecordStore(f.agentDir, f.session.getSessionId());
    let checkout = store.readCoordinatorCheckout(facts.checkoutId);

    checkout = await Effect.runPromise(prepareCoordinatorApplication(checkout));
    checkout = store.checkpointCoordinatorCheckout(checkout);
    const uncertainApplied = await Effect.runPromise(applyCoordinatorCheckout(checkout));

    assert.equal(uncertainApplied.state.kind, "applied");
    checkout = store.readCoordinatorCheckout(facts.checkoutId);
    checkout = await Effect.runPromise(prepareCoordinatorApplication(checkout));
    checkout = store.checkpointCoordinatorCheckout(checkout);
    checkout = await Effect.runPromise(applyCoordinatorCheckout(checkout));
    checkout = store.checkpointCoordinatorCheckout(checkout);

    if (checkout.state.kind !== "applied") throw new Error("Apply checkpoint was not retained.");
    checkout = store.checkpointCoordinatorCheckout({
      ...checkout,
      state: { ...checkout.state, worktreeRemoval: "requested" },
    });
    await Effect.runPromise(removeAppliedCoordinatorWorktree(checkout));
    store.close();

    const applied = await f.call("workgraph_checkout", {
      action: "apply",
      checkoutId: facts.checkoutId,
    });

    // SAFETY: Apply reports the exact recovered revision and release result.
    const appliedFacts = applied.details as { revision: string; released: boolean };

    assert.equal(appliedFacts.released, true);
    assert.equal(await readFile(join(f.root, "resumed.txt"), "utf8"), "resumed apply\n");
    assert.equal(existsSync(facts.managedPath), false);
    await assert.rejects(git(f.root, "show-ref", "--verify", facts.ownedBranch));
  } finally {
    await f.dispose();
  }
});

void test("implementation Candidate converges through the Coordinator checkout before final apply", async () => {
  const f = await fixture(false);

  try {
    await f.runner.emit({ type: "session_start", reason: "startup" });
    const created = await f.call("workgraph_checkout", { action: "create" });

    // SAFETY: Create returns exact managed placement identity.
    const facts = created.details as {
      checkoutId: string;
      managedPath: string;
      baseCommit: string;
    };

    const attemptId = "attempt-checkout-candidate";
    const outputRef = `refs/pi-workgraph/outputs/${attemptId}`;
    const workerPath = join(f.parent, "candidate-worktree");

    await git(f.root, "worktree", "add", "--detach", workerPath, facts.baseCommit);
    await writeFile(join(workerPath, "candidate.txt"), "worker candidate\n");
    await git(workerPath, "add", "candidate.txt");
    await git(workerPath, "commit", "-m", "worker candidate");

    const candidateTip = await git(workerPath, "rev-parse", "HEAD");
    await git(f.root, "worktree", "remove", workerPath);
    await git(f.root, "update-ref", outputRef, candidateTip);

    const store = new RecordStore(f.agentDir, f.session.getSessionId());

    const task = {
      target: {
        kind: "repository",
        checkoutRoot: facts.managedPath,
        commonDir: await git(
          facts.managedPath,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ),
      },
      contract: {
        kind: "implementation",
        objective: "Produce a Candidate in the Coordinator checkout.",
        acceptance: ["Candidate reaches the Coordinator checkout first."],
      },
    } satisfies Task;

    const spec = {
      selection: {
        kind: "implementation",
        guide: { model: "fixture/guide", thinking: "high" },
        executor: { model: "fixture/executor", thinking: "high" },
      },
      base: { kind: "repository", baseCommit: facts.baseCommit },
    } satisfies AttemptSpec;

    store.createTaskWithAttempt("checkout-candidate", task, attemptId, spec);
    store.recordOutcome(attemptId, {
      result: {
        kind: "reported",
        report: {
          kind: "implementation",
          status: "completed",
          outcome: "changed",
          summary: "Produced the Candidate.",
          evidence: [],
          findings: [],
        },
      },
      effectiveModels: [],
    });
    store.checkpointOutput(attemptId, {
      kind: "retained",
      tip: candidateTip,
      reason: "Committed implementation output",
    });
    store.close();

    await f.call("workgraph_control", { action: "apply", attemptId });
    assert.equal(
      await readFile(join(facts.managedPath, "candidate.txt"), "utf8"),
      "worker candidate\n",
    );
    assert.equal(existsSync(join(f.root, "candidate.txt")), false);

    await f.call("workgraph_checkout", { action: "apply", checkoutId: facts.checkoutId });
    assert.equal(await readFile(join(f.root, "candidate.txt"), "utf8"), "worker candidate\n");
    assert.equal(existsSync(facts.managedPath), false);
  } finally {
    await f.dispose();
  }
});

void test("unchanged checkout applies as a no-op after destination advancement", async () => {
  const f = await fixture(false);

  try {
    await f.runner.emit({ type: "session_start", reason: "startup" });
    const created = await f.call("workgraph_checkout", { action: "create" });

    // SAFETY: Create returns exact managed placement identity.
    const facts = created.details as { checkoutId: string; managedPath: string };

    await writeFile(join(f.root, "destination.txt"), "advanced\n");
    await git(f.root, "add", "destination.txt");
    await git(f.root, "commit", "-m", "destination advancement");

    const destinationHead = await git(f.root, "rev-parse", "HEAD");

    const applied = await f.call("workgraph_checkout", {
      action: "apply",
      checkoutId: facts.checkoutId,
    });

    // SAFETY: Apply returns the established destination revision and release status.
    const appliedFacts = applied.details as { revision: string; released: boolean };

    assert.equal(appliedFacts.revision, destinationHead);
    assert.equal(await git(f.root, "rev-parse", "HEAD"), destinationHead);
    assert.equal(appliedFacts.released, true);
    assert.equal(existsSync(facts.managedPath), false);
  } finally {
    await f.dispose();
  }
});

void test("externally missing worktree blocks release and preserves the owned branch", async () => {
  const f = await fixture(false);

  try {
    await f.runner.emit({ type: "session_start", reason: "startup" });
    const created = await f.call("workgraph_checkout", { action: "create" });

    // SAFETY: Create returns exact managed resource identity.
    const facts = created.details as {
      checkoutId: string;
      managedPath: string;
      ownedBranch: string;
    };

    await git(f.root, "worktree", "remove", "--force", facts.managedPath);
    await assert.rejects(
      f.call("workgraph_checkout", {
        action: "discard",
        checkoutId: facts.checkoutId,
        reason: "Must not infer ownership",
      }),
      /exact registered worktree/,
    );
    assert.equal((await git(f.root, "show-ref", "--verify", facts.ownedBranch)) !== "", true);

    const store = new RecordStore(f.agentDir, f.session.getSessionId());

    assert.equal(store.readCoordinatorCheckout(facts.checkoutId).state.kind, "ready");
    store.close();
  } finally {
    await f.dispose();
  }
});

void test("discard resumes after worktree removal succeeds without confirmation", async () => {
  const f = await fixture(false);

  try {
    await f.runner.emit({ type: "session_start", reason: "startup" });
    const created = await f.call("workgraph_checkout", { action: "create" });

    // SAFETY: Create returns exact managed resource identity.
    const facts = created.details as {
      checkoutId: string;
      managedPath: string;
      ownedBranch: string;
    };

    const store = new RecordStore(f.agentDir, f.session.getSessionId());
    let checkout = store.readCoordinatorCheckout(facts.checkoutId);

    checkout = await Effect.runPromise(prepareCoordinatorDiscard(checkout, "Persisted reason"));
    checkout = store.checkpointCoordinatorCheckout(checkout);

    if (checkout.state.kind !== "discarding")
      throw new Error("Discard checkpoint was not retained.");
    checkout = store.checkpointCoordinatorCheckout({
      ...checkout,
      state: { ...checkout.state, worktreeRemoval: "requested" },
    });
    await Effect.runPromise(removeDiscardedCoordinatorWorktree(checkout));
    store.close();

    const discarded = await f.call("workgraph_checkout", {
      action: "discard",
      checkoutId: facts.checkoutId,
      reason: "Replacement reason",
    });

    // SAFETY: Discard reports the exact persisted disposition and release result.
    const discardedFacts = discarded.details as {
      reason: string;
      released: boolean;
    };

    assert.equal(discardedFacts.reason, "Persisted reason");
    assert.equal(discardedFacts.released, true);
    assert.equal(existsSync(facts.managedPath), false);
    await assert.rejects(git(f.root, "show-ref", "--verify", facts.ownedBranch));
  } finally {
    await f.dispose();
  }
});

void test("checkout refuses dirty apply, discards dirty bytes, and preserves foreign placement", async () => {
  const f = await fixture(false);

  try {
    await f.runner.emit({ type: "session_start", reason: "startup" });
    const dirtyCreated = await f.call("workgraph_checkout", { action: "create" });

    // SAFETY: Create returns exact managed placement identity.
    const dirty = dirtyCreated.details as {
      checkoutId: string;
      managedPath: string;
      ownedBranch: string;
    };

    await writeFile(join(f.root, ".git", "info", "exclude"), "ignored.bin\n");
    await writeFile(join(dirty.managedPath, "file.txt"), "dirty\n");
    await writeFile(join(dirty.managedPath, "untracked.txt"), "untracked\n");
    await writeFile(join(dirty.managedPath, "ignored.bin"), "ignored\n");
    await assert.rejects(
      f.call("workgraph_checkout", { action: "apply", checkoutId: dirty.checkoutId }),
      /Managed checkout is dirty/,
    );
    await f.call("workgraph_checkout", {
      action: "discard",
      checkoutId: dirty.checkoutId,
      reason: "Abandon direct scratch",
    });
    assert.equal(existsSync(dirty.managedPath), false);
    await assert.rejects(git(f.root, "show-ref", "--verify", dirty.ownedBranch));

    const foreignCreated = await f.call("workgraph_checkout", { action: "create" });
    // SAFETY: This create returns the same strict managed placement identity.
    const foreign = foreignCreated.details as typeof dirty;

    await git(foreign.managedPath, "switch", "-c", "foreign-branch");
    const listed = await f.call("workgraph_checkout", { action: "list" });

    // SAFETY: List identifies each blocked durable record without failing enumeration.
    const blocked = (
      listed.details as { checkouts: Array<{ checkoutId: string; blocked?: string }> }
    ).checkouts[0];

    assert.equal(blocked?.checkoutId, foreign.checkoutId);
    assert.match(blocked?.blocked ?? "", /exact owned branch/);
    await assert.rejects(
      f.call("workgraph_checkout", {
        action: "discard",
        checkoutId: foreign.checkoutId,
        reason: "Must preserve mismatch",
      }),
      /exact owned branch/,
    );
    assert.equal(existsSync(foreign.managedPath), true);
    assert.equal(
      await git(foreign.managedPath, "symbolic-ref", "HEAD"),
      "refs/heads/foreign-branch",
    );
    assert.equal((await git(f.root, "show-ref", "--verify", foreign.ownedBranch)) !== "", true);
  } finally {
    await f.dispose();
  }
});

void test("coordinator extension remains inactive in Worker scope", async () => {
  const f = await fixture(false, null, "research");

  try {
    assert.deepEqual(
      f.runner
        .getAllRegisteredTools()
        .map((tool) => tool.definition.name)
        .filter((name) => name.startsWith("workgraph_")),
      [],
    );
    assert.equal(f.runner.getCommand("calm"), undefined);
    assert.equal(
      await f.runner.emitBeforeAgentStart("Work", undefined, "Worker prompt", { cwd: f.root }),
      undefined,
    );
  } finally {
    await f.dispose();
  }
});

void test("registered extension starts candidate extension from the exact retained tip", async () => {
  const f = await fixture(true);
  const sourceAttemptId = "attempt-source";
  const sourceRef = `refs/pi-workgraph/outputs/${sourceAttemptId}`;

  try {
    const base = await git(f.root, "rev-parse", "HEAD");
    await writeFile(join(f.root, "file.txt"), "candidate\n");
    await git(f.root, "commit", "-am", "candidate");
    const sourceTip = await git(f.root, "rev-parse", "HEAD");
    await git(f.root, "update-ref", sourceRef, sourceTip);
    await git(f.root, "reset", "--hard", base);

    const sourceTask = {
      target: {
        kind: "repository",
        checkoutRoot: await git(f.root, "rev-parse", "--show-toplevel"),
        commonDir: await git(f.root, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      },
      contract: {
        kind: "implementation",
        objective: "Produce the retained source Candidate",
        acceptance: ["The committed candidate is retained"],
      },
    } satisfies Task;

    const sourceSpec = {
      selection: {
        kind: "implementation",
        guide: { model: "fixture/guide", thinking: "high" },
        executor: { model: "fixture/executor", thinking: "xhigh" },
      },
      base: { kind: "repository", baseCommit: base },
    } satisfies AttemptSpec;

    const seed = new RecordStore(f.agentDir, f.session.getSessionId());
    seed.createTaskWithAttempt("source", sourceTask, sourceAttemptId, sourceSpec);
    seed.recordOutcome(sourceAttemptId, {
      result: {
        kind: "reported",
        report: {
          kind: "implementation",
          status: "completed",
          outcome: "changed",
          summary: "Produced the source Candidate.",
          evidence: [],
          findings: [],
        },
      },
      effectiveModels: [],
    });
    seed.checkpointOutput(sourceAttemptId, {
      kind: "retained",
      tip: sourceTip,
      reason: "Committed implementation output",
    });
    seed.close();

    await f.runner.emit({ type: "session_start", reason: "startup" });
    await git(f.root, "update-ref", sourceRef, base);
    await assert.rejects(
      f.call("workgraph_implement", {
        id: "invalid-extension",
        objective: "Extend an inexact Candidate",
        acceptance: ["Must not start"],
        candidateOf: { attemptId: sourceAttemptId, mode: "extend" },
      }),
      /Private output ref is absent or was repointed/,
    );
    const afterRejection = await f.call("workgraph_inspect", { section: "overview" });
    // SAFETY: The registered inspect tool owns this successful overview detail shape.
    assert.deepEqual(
      (afterRejection.details as { counts: { tasks: number; attempts: number } }).counts,
      { tasks: 1, attempts: 1, activeWorkers: 0, coordinatorCheckouts: 0 },
    );

    await git(f.root, "update-ref", sourceRef, sourceTip);

    const created = await f.call("workgraph_implement", {
      id: "extension",
      objective: "Extend the retained Candidate",
      acceptance: ["The successor starts at the source tip"],
      candidateOf: { attemptId: sourceAttemptId, mode: "extend" },
    });

    // SAFETY: The registered implementation tool returns this bounded creation receipt.
    const receipt = created.details as {
      attempts: { attemptId: string }[];
    };

    const successorId = receipt.attempts[0]?.attemptId;
    assert.ok(successorId !== undefined);

    const inspected = await f.call("workgraph_inspect", {
      section: "attempt",
      id: successorId,
    });

    // SAFETY: Exact Attempt inspection returns the strictly decoded persisted specification.
    const successor = (inspected.details as { spec: AttemptSpec }).spec;
    assert.deepEqual(successor.base, { kind: "repository", baseCommit: sourceTip });
    assert.deepEqual(successor.lineage, {
      candidateRoot: base,
      candidateOf: { kind: "extend", attemptId: sourceAttemptId },
    });

    const worktree = join(f.agentDir, "workgraph", "worktrees", successorId);
    let worktreeHead = "";

    for (let index = 0; index < 100 && worktreeHead === ""; index += 1) {
      worktreeHead = await git(worktree, "rev-parse", "HEAD").catch(() => "");

      if (worktreeHead === "") await Effect.runPromise(Effect.sleep(10));
    }

    assert.equal(worktreeHead, sourceTip);
    assert.equal(await git(f.root, "rev-parse", sourceRef), sourceTip);
    assert.equal(await git(f.root, "rev-parse", "HEAD"), base);
    assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), "base\n");
  } finally {
    await f.dispose();
  }
});

void test("one session creates frozen Task and Attempt records and inspects them boundedly", async () => {
  const f = await fixture(true);

  try {
    await f.runner.emit({ type: "session_start", reason: "startup" });
    const base = await git(f.root, "rev-parse", "HEAD");

    const created = await f.call("workgraph_implement", {
      id: "change",
      cwd: ".",
      objective: "Change the fixture",
      acceptance: ["The change is committed"],
    });

    // SAFETY: The registered implementation tool returns this bounded creation receipt.
    const details = created.details as {
      taskId: string;
      attempts: { taskId: string; attemptId: string }[];
    };

    assert.equal(details.taskId, "change");
    assert.equal(details.attempts.length, 1);
    const attemptId = details.attempts[0]?.attemptId;
    assert.ok(attemptId !== undefined);

    const task = await f.call("workgraph_inspect", { section: "task", id: "change" });
    // SAFETY: Exact Task inspection returns the strictly decoded persisted Task record.
    assert.deepEqual(
      (task.details as { task: { target: { checkoutRoot: string } } }).task.target.checkoutRoot,
      f.root,
    );
    const attempt = await f.call("workgraph_inspect", { section: "attempt", id: attemptId });
    // SAFETY: Exact Attempt inspection returns the strictly decoded persisted Attempt projection.
    assert.equal(
      (attempt.details as { spec: { base: { baseCommit: string } } }).spec.base.baseCommit,
      base,
    );
    // SAFETY: Pi tool details are object-shaped for every registered Workgraph result.
    assert.equal("report" in (attempt.details as object), false);

    const page = await f.call("workgraph_inspect", {
      section: "attempt",
      offset: 0,
      limit: 1,
    });

    // SAFETY: Attempt page inspection returns its bounded attempts array.
    assert.equal((page.details as { attempts: unknown[] }).attempts.length, 1);

    await f.call("workgraph_notepad", { action: "replace", text: "Keep the target frozen." });
    const note = await f.call("workgraph_notepad", { action: "read" });
    // SAFETY: The notepad read action returns its bounded text field.
    assert.equal((note.details as { text: string }).text, "Keep the target frozen.");

    await f.call("workgraph_research", {
      id: "read-only",
      question: "What is here?",
      expectedEvidence: ["Direct inspection"],
    });
    await assert.rejects(
      f.call("workgraph_attempt", { taskId: "read-only", baseRevision: base }),
      /baseRevision is supported only for repository Attempts/,
    );
    await assert.rejects(
      f.call("workgraph_attempt", { taskId: "read-only", useEscalationExecutor: true }),
      /useEscalationExecutor is supported only for implementation Attempts/,
    );
    const overview = await f.call("workgraph_inspect", { section: "overview" });
    // SAFETY: Overview returns exact session-local record counts.
    assert.equal((overview.details as { counts: { attempts: number } }).counts.attempts, 2);

    const other = new RecordStore(f.agentDir, "other-session");
    assert.deepEqual(other.counts(), {
      tasks: 0,
      attempts: 0,
      activeWorkers: 0,
      coordinatorCheckouts: 0,
    });
    other.close();

    await f.runner.emit({ type: "session_shutdown", reason: "reload" });
    const restored = new RecordStore(f.agentDir, f.session.getSessionId());
    assert.equal(restored.readAttempt(attemptId).spec.base.kind, "repository");
    assert.equal(restored.readAttempt(attemptId).taskId, "change");
    restored.close();
  } finally {
    await f.dispose();
  }
});

void test("without exact Herdr launch identity inspection remains usable and creation mutates nothing", async () => {
  for (const [available, workspaceId] of [
    [false, null],
    [true, ""],
  ] as const) {
    const f = await fixture(available, workspaceId);

    try {
      await f.runner.emit({ type: "session_start", reason: "startup" });
      const overview = await f.call("workgraph_inspect", { section: "overview" });
      // SAFETY: Overview inspection returns the RecordStore count projection.
      assert.deepEqual((overview.details as { counts: object }).counts, {
        tasks: 0,
        attempts: 0,
        activeWorkers: 0,
        coordinatorCheckouts: 0,
      });
      const models = await f.call("workgraph_models", { role: "research" });
      // SAFETY: Model inspection returns the strictly decoded configured target list.
      assert.equal((models.details as { targets: unknown[] }).targets.length, 2);
      await assert.rejects(
        f.call("workgraph_research", {
          id: "blocked",
          question: "What changed?",
          expectedEvidence: ["Direct inspection"],
        }),
        /Herdr runtime and exact workspace identity are unavailable/,
      );
      assert.equal(existsSync(join(f.agentDir, "workgraph", "workgraph.sqlite")), false);
    } finally {
      await f.dispose();
    }
  }
});
