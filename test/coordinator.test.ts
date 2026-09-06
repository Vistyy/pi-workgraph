import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Coordinator integration fixtures use real host storage.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Fixture paths are real Git and session identities.
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { GitRepository } from "../src/git.js";
import { HerdrCliRuntime } from "../src/herdr.js";
import { WorkgraphRegistry } from "../src/registry.js";
import { WorkstreamStore } from "../src/workstream.js";
import { WorkstreamRuntime } from "../src/workstream-runtime.js";
import {
  configureFixtureEnvironment,
  decodeTestValue,
  required,
  restoreFixtureEnvironment,
} from "./decoders.js";
import { extensionFixture, git, researchReport, resultState } from "./helpers.js";

const textContentSchema = Type.Object({ type: Type.Literal("text"), text: Type.String() });
const actionDetailsSchema = Type.Object({
  view: Type.Object({
    action: Type.Object({ name: Type.String() }),
    affected: Type.Object({
      task: Type.Object({ idPreview: Type.String() }),
      attempt: Type.Object({
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
      offset: Type.Number(),
      truncated: Type.Boolean(),
      next: Type.Optional(Type.Object({ offset: Type.Number() })),
    }),
  }),
});
const persistedHeaderSchema = Type.Object({
  format: Type.String(),
  version: Type.Number(),
  id: Type.String(),
});

// oxlint-disable-next-line effecttsgo/async-function -- The node:test fixture composes native Promise-based Git, filesystem, and Pi adapters.
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
    // oxlint-disable-next-line effecttsgo/async-function -- Fixture teardown must await native Pi and filesystem cleanup.
    async dispose() {
      await pi.close();
      restoreFixtureEnvironment(previous);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

// oxlint-disable-next-line effecttsgo/async-function -- This fixture helper composes the Promise APIs under test.
async function emptyWorkstream(f: Awaited<ReturnType<typeof fixture>>) {
  const repository = await GitRepository.open(f.root);
  const created = await WorkstreamStore.create({
    id: "empty-fixture",
    purpose: "Fixture workstream",
    projectRoot: f.root,
    gitCommonDir: repository.commonDir,
    coordinator: {
      sessionId: f.session.getSessionId(),
      sessionFile: required(f.session.getSessionFile(), "coordinator session file"),
    },
  });
  f.session.appendCustomEntry("pi-workgraph-workstream", {
    path: created.store.path,
  });
  await f.runner.emit({ type: "session_start", reason: "new" });
  return created.state;
}

// oxlint-disable-next-line effecttsgo/async-function -- node:test owns and awaits this Promise callback.
void test("registered capability tools create work implicitly and retain only human input as authority across reload", async () => {
  const f = await fixture();
  try {
    const initial = resultState(
      (
        await f.call("workgraph_research", {
          id: "read-value",
          question: "What is value.txt?",
          expectedEvidence: ["Exact bytes"],
        })
      ).details,
    );
    assert.equal(initial.assignments[0]?.id, "read-value");
    const request = {
      id: "fix-value",
      objective: "Fix value",
      acceptance: ["Correct bytes"],
    };
    await f.runner.emitInput("Implement a change", undefined, "extension");
    await assert.rejects(f.call("workgraph_implement", request), /actual retained human input/);
    await f.runner.emitInput("Implement the maintained value change", undefined, "interactive");
    const authorized = resultState((await f.call("workgraph_implement", request)).details);
    assert.equal(authorized.inputs.length, 1);
    assert.equal(authorized.intents.at(-1)?.version, 1);
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
    assert.equal(reloaded.inputs.length, 1);
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

// oxlint-disable-next-line effecttsgo/async-function -- node:test owns and awaits this Promise callback.
void test("failed registered adoption preserves the attached runtime lease; same-target attachment reuses it", async () => {
  const f = await fixture();
  let competing: WorkstreamRuntime | undefined;
  const registry = new WorkgraphRegistry(join(f.parent, "agent", "workgraph", "registry.sqlite"));
  try {
    const a = await emptyWorkstream(f);
    const repository = await GitRepository.open(f.root);
    const otherOwner = {
      sessionId: "other",
      sessionFile: join(f.parent, "other.jsonl"),
    };
    const { store } = await WorkstreamStore.create({
      id: "other-work",
      purpose: "Other work",
      projectRoot: f.root,
      gitCommonDir: repository.commonDir,
      coordinator: otherOwner,
    });
    competing = new WorkstreamRuntime(
      store,
      repository,
      new HerdrCliRuntime(),
      { workspaceId: "" },
      () => {},
      () => {},
      { registry },
    );
    await competing.perform(() => Promise.resolve());
    await assert.rejects(f.call("workgraph_adopt", { statePath: store.path }), /runtime owner/);
    assert.equal(
      resultState((await f.call("workgraph_inspect", { section: "overview" })).details).id,
      a.id,
    );
    assert.throws(() => registry.acquire(a.id, a.coordinator), /runtime owner/);
    const same = resultState((await f.call("workgraph_adopt", { statePath: a.statePath })).details);
    assert.equal(same.id, a.id);
    await f.call("workgraph_control", {
      action: "suspend",
      reason: "Existing runtime is still usable",
    });
    await competing.stop();
    const adopted = resultState(
      (await f.call("workgraph_adopt", { statePath: store.path })).details,
    );
    assert.equal(adopted.id, "other-work");
    assert.equal(adopted.coordinator.sessionId, f.session.getSessionId());
    const released = registry.acquire(a.id, a.coordinator);
    registry.release(released);
  } finally {
    await competing?.stop();
    registry.close();
    await f.dispose();
  }
});

// oxlint-disable-next-line effecttsgo/async-function -- node:test owns and awaits this Promise callback.
void test("mutation responses stay action-focused while retaining handles, models, and exact read paths", async () => {
  const f = await fixture();
  try {
    const first = await f.call("workgraph_research", {
      id: "focused-research",
      question: "Inspect the focused fixture",
      expectedEvidence: ["bytes"],
      model: "fixture/research",
      modelReason: "The regression checks selected model provenance.",
      thinking: "low",
    });
    const firstText = decodeTestValue(textContentSchema, first.content[0]).text;
    const firstView = decodeTestValue(actionDetailsSchema, first.details).view;
    assert.equal(firstView.action.name, "workgraph_research");
    assert.equal(firstView.affected.task.idPreview, "focused-research");
    assert.equal(firstView.affected.attempt.models.selected.guide.model, "fixture/research");
    assert.match(firstText, /focused-research/);
    assert.doesNotMatch(firstText, /"assignments":\s*\[/);

    const initial = resultState(first.details);
    const owner = {
      sessionId: f.session.getSessionId(),
      sessionFile: required(f.session.getSessionFile(), "coordinator session file"),
    };
    const store = WorkstreamStore.open(initial.statePath, owner);
    for (let index = 0; index < 12; index++) {
      await store.assign({
        id: `unrelated-${index}`,
        capability: "research",
        artifactIntent: "evidence_only",
        objective: `Unrelated history ${index}`,
        intentVersion: 0,
        expectedEvidence: ["bytes"],
      });
    }
    const later = await f.call("workgraph_inspect", {
      section: "overview",
    });
    const laterText = decodeTestValue(textContentSchema, later.content[0]).text;
    assert.ok(laterText.length < 8_000);
    assert.match(laterText, /Unrelated history 0/);
    const laterView = decodeTestValue(overviewDetailsSchema, later.details).inspection;
    assert.equal(laterView.tasks.totalItems, 13);
    assert.deepEqual(laterView.attention.items, []);
  } finally {
    await f.dispose();
  }
});

// oxlint-disable-next-line effecttsgo/async-function -- node:test owns and awaits this Promise callback.
void test("registered status stays compact and focused result retrieval projects bounded sections", async () => {
  const f = await fixture();
  try {
    const initial = await emptyWorkstream(f);
    const owner = {
      sessionId: f.session.getSessionId(),
      sessionFile: required(f.session.getSessionFile(), "coordinator session file"),
    };
    const store = WorkstreamStore.open(initial.statePath, owner);
    const longObjective = `Retain bounded evidence ${"full assignment brief ".repeat(500)}`;
    await store.assign({
      id: "large-result",
      capability: "research",
      artifactIntent: "evidence_only",
      objective: longObjective,
      intentVersion: 0,
      expectedEvidence: ["evidence"],
    });
    await store.retainResult({
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
    });
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
    const findings = await f.call("workgraph_inspect", {
      section: "evidence",
      result: "large-result-1",
      offset: 0,
      maxChars: 100,
    });
    const findingsContent = decodeTestValue(contentDetailsSchema, findings.details).inspection
      .content;
    assert.equal(findingsContent.offset, 0);
    assert.equal(findingsContent.truncated, true);
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
          unresolved: [],
        })
      ).details,
    );
    assert.equal(completed.lifecycle.state, "completed");
  } finally {
    await f.dispose();
  }
});

// oxlint-disable-next-line effecttsgo/async-function -- node:test owns and awaits this Promise callback.
void test("registered session_start safely inspects retained and pointed workstreams", async () => {
  // oxlint-disable-next-line effecttsgo/async-function -- This local fixture helper composes the Promise APIs under test.
  async function createState(f: Awaited<ReturnType<typeof fixture>>, id: string) {
    const repository = await GitRepository.open(f.root);
    return WorkstreamStore.create({
      id,
      purpose: "Startup inspection fixture",
      projectRoot: f.root,
      gitCommonDir: repository.commonDir,
      coordinator: {
        sessionId: f.session.getSessionId(),
        sessionFile: required(f.session.getSessionFile(), "coordinator session file"),
      },
    });
  }

  {
    const f = await fixture();
    try {
      const { state } = await createState(f, "legacy-terminal");
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
        WorkstreamStore.inspect(state.statePath),
        /Unsupported workstream state/,
      );
      f.session.appendCustomEntry("pi-workgraph-workstream", {
        path: state.statePath,
      });
      await f.runner.emit({ type: "session_start", reason: "reload" });
      const inspection = await WorkstreamStore.inspectForReattachment(state.statePath);
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
      const { state } = await createState(f, "legacy-active");
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
      const { state: created } = await createState(f, "current-terminal");
      const state = await WorkstreamStore.open(created.statePath, created.coordinator).setLifecycle(
        {
          state: "abandoned",
          reason: "Current terminal startup fixture.",
        },
      );
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

// oxlint-disable-next-line effecttsgo/async-function -- node:test owns and awaits this Promise callback.
void test("registered model policy get/set affects later assignments but not overrides or coordinator selection", async () => {
  const f = await fixture();
  try {
    await f.call("workgraph_models", { action: "get" });
    await f.call("workgraph_models", {
      action: "set",
      role: "research",
      target: { model: "fixture/default", thinking: "low" },
    });
    let state = resultState(
      (
        await f.call("workgraph_research", {
          id: "first",
          question: "Read",
          expectedEvidence: ["bytes"],
        })
      ).details,
    );
    assert.deepEqual(state.attempts[0]?.models?.guide, {
      model: "fixture/default",
      thinking: "low",
    });
    await f.call("workgraph_models", {
      action: "set",
      role: "research",
      target: { model: "fixture/changed", thinking: "high" },
    });
    state = resultState(
      (
        await f.call("workgraph_research", {
          id: "second",
          question: "Read",
          expectedEvidence: ["bytes"],
          model: "fixture/override",
          modelReason: "The fixture checks explicit override provenance.",
        })
      ).details,
    );
    assert.equal(state.attempts[1]?.models?.guide.model, "fixture/override");
    assert.equal(state.attempts[1]?.models?.source, "override");
    state = resultState(
      (
        await f.call("workgraph_research", {
          id: "third",
          question: "Read",
          expectedEvidence: ["bytes"],
        })
      ).details,
    );
    assert.equal(state.attempts[2]?.models?.guide.model, "fixture/changed");
    assert.deepEqual(f.selected, []);
  } finally {
    await f.dispose();
  }
});
