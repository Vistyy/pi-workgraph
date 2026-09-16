import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { Value } from "typebox/value";
import { RecordStore } from "../../src/coordinator/store.js";
import type { AttemptSpec, Task } from "../../src/domain/records.js";
import { configureFixtureEnvironment, restoreFixtureEnvironment } from "../support/decoders.js";
import { extensionFixture, git } from "../support/helpers.js";

const accepted = [
  "workgraph_checkout",
  "workgraph_research",
  "workgraph_experiment",
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

void test("coordinator registers the exact strict tool surface", async () => {
  const f = await fixture(false);

  try {
    const registered = f.runner
      .getAllRegisteredTools()
      .map((tool) => tool.definition.name)
      .filter((name) => name.startsWith("workgraph_"))
      .sort();

    assert.deepEqual(registered, [...accepted].sort());
    const checkout = f.runner.getToolDefinition("workgraph_checkout");
    assert.ok(checkout !== undefined);
    assert.equal(Value.Check(checkout.parameters, {}), true);
    assert.equal(Value.Check(checkout.parameters, { cwd: "." }), true);
    assert.equal(Value.Check(checkout.parameters, { cwd: " " }), false);

    const experiment = f.runner.getToolDefinition("workgraph_experiment");
    assert.ok(experiment !== undefined);
    assert.equal(
      Value.Check(experiment.parameters, {
        id: "experiment",
        question: "Question?",
        expectedEvidence: ["Evidence"],
        permittedEffects: ["write"],
        stopCondition: "done",
        selection: { count: 2, distinctModels: true },
      }),
      true,
    );
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

    const coordinatorContract = (
      await readFile(new URL("../../COORDINATOR.md", import.meta.url), "utf8")
    ).trim();

    const publicationReferencePath = resolve("references/publish-pr.md");

    const guidance = `${coordinatorContract}\n\nPR publication reference path (content not loaded): ${publicationReferencePath}`;

    assert.equal(existsSync(publicationReferencePath), true);

    const injected = await f.runner.emitBeforeAgentStart(
      "Coordinate the request",
      undefined,
      "Base coordinator prompt",
      { cwd: f.root },
    );

    assert.equal(
      injected?.systemPrompt,
      `Base coordinator prompt\n\n${guidance}`,
      "the loaded coordinator extension injects the packaged guidance and reference path",
    );
    assert.equal(
      injected?.systemPrompt.includes("# Publish an accepted change as a pull request"),
      false,
      "publication-reference content stays out of the system prompt",
    );
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
      { tasks: 1, attempts: 1, activeWorkers: 0 },
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
      task: { id: string; kind: string; target: { kind: string } };
      attempts: { taskId: string; attemptId: string; spec: AttemptSpec }[];
    };

    assert.deepEqual(
      { id: details.task.id, kind: details.task.kind, targetKind: details.task.target.kind },
      { id: "change", kind: "implementation", targetKind: "repository" },
    );
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
    // SAFETY: Exact inspection includes bounded report facts even before settlement.
    assert.equal((attempt.details as { reportPreview: null }).reportPreview, null);

    // SAFETY: Exact Attempt inspection returns nullable Worker and blocker fields.
    let launched = attempt.details as {
      worker: null | { sessionFile: string };
      blocker: null | string;
    };

    for (
      let index = 0;
      index < 100 && (launched.worker === null || launched.blocker === null);
      index += 1
    ) {
      await Effect.runPromise(Effect.sleep(10));
      // SAFETY: Repeated exact Attempt inspection preserves the same decoded projection.
      launched = (await f.call("workgraph_inspect", { section: "attempt", id: attemptId }))
        .details as typeof launched;
    }

    assert.ok(launched.worker !== null);
    assert.ok(launched.blocker !== null, "exact Attempt inspection exposes its runtime blocker");

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

    const consultation = await f.call("workgraph_consult", {
      id: "advice",
      question: "Which bounded option is preferable?",
    });

    const consultationAttempt = await f.call("workgraph_attempt", { taskId: "advice" });

    const advisorSelection = {
      kind: "target",
      target: { model: "fixture/advisor", thinking: "low" },
    };

    // SAFETY: Creation receipts expose each exact immutable Attempt specification.
    assert.deepEqual(
      (consultation.details as { attempts: { spec: AttemptSpec }[] }).attempts[0]?.spec.selection,
      advisorSelection,
    );

    // SAFETY: Another-Attempt receipts contain the exact persisted identifiers and specification.
    const consultationReceipt = consultationAttempt.details as {
      taskId: string;
      attemptId: string;
      spec: AttemptSpec;
    };

    assert.deepEqual(consultationReceipt, {
      taskId: "advice",
      attemptId: consultationReceipt.attemptId,
      spec: { selection: advisorSelection, base: { kind: "directory" } },
    });

    const experiment = await f.call("workgraph_experiment", {
      id: "bounded-experiment",
      cwd: ".",
      question: "Can the probe run?",
      expectedEvidence: ["Probe output"],
      permittedEffects: ["Create probe.tmp in the assigned worktree"],
      stopCondition: "Stop after one probe",
      selection: { count: 2, distinctModels: true },
    });

    // SAFETY: The registered Experiment tool returns exact bounded creation receipts.
    assert.deepEqual(
      (experiment.details as { attempts: { spec: AttemptSpec }[] }).attempts.map(
        (item) => item.spec.selection,
      ),
      [
        {
          kind: "target",
          target: { model: "fixture/research", thinking: "high" },
        },
        {
          kind: "target",
          target: { model: "fixture/research-2", thinking: "medium" },
        },
      ],
      "Experiment uses the ordered research model list",
    );

    const experimentTask = await f.call("workgraph_inspect", {
      section: "task",
      id: "bounded-experiment",
    });

    // SAFETY: Exact Task inspection returns the strictly decoded persisted Task record.
    assert.deepEqual((experimentTask.details as { task: Task }).task.contract, {
      kind: "experiment",
      question: "Can the probe run?",
      expectedEvidence: ["Probe output"],
      permittedEffects: ["Create probe.tmp in the assigned worktree"],
      stopCondition: "Stop after one probe",
    });

    const overview = await f.call("workgraph_inspect", { section: "overview" });
    // SAFETY: Overview returns exact session-local record counts.
    assert.equal((overview.details as { counts: { attempts: number } }).counts.attempts, 6);

    const other = new RecordStore(f.agentDir, "other-session");
    assert.deepEqual(other.counts(), { tasks: 0, attempts: 0, activeWorkers: 0 });
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
      });
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
