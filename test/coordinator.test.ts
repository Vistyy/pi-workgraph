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

void test("registered delegation keeps established scope until explicit intent revision", async () => {
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

    const firstHumanText = "Implement the maintained value change - private first context";
    await f.runner.emitInput(firstHumanText, undefined, "interactive");
    const firstResponse = await f.call("workgraph_implement", request);
    const firstAuthorized = resultState(firstResponse.details);
    const firstReceipt = required(firstAuthorized.inputs[0], "first retained human input").id;
    assert.equal(firstAuthorized.intents.at(-1)?.version, 1);
    assert.deepEqual(firstAuthorized.intents.at(-1)?.authorityReceiptIds, [firstReceipt]);
    assert.equal(firstAuthorized.assignments[1]?.intentVersion, 1);
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
    const secondReceipt = required(secondAuthorized.inputs[1], "second retained human input").id;
    assert.notEqual(secondReceipt, firstReceipt);
    assert.equal(secondAuthorized.intents.at(-1)?.version, 1);
    assert.deepEqual(secondAuthorized.intents.at(-1)?.authorityReceiptIds, [firstReceipt]);
    assert.deepEqual(
      secondAuthorized.assignments.slice(1).map((item) => item.intentVersion),
      [1, 1],
    );
    const continuedAssignment = secondAuthorized.assignments[2];
    assert.equal(continuedAssignment?.artifactIntent, "maintained_change");
    if (continuedAssignment?.artifactIntent !== "maintained_change")
      throw new Error("Expected the continued maintained assignment.");
    assert.deepEqual(continuedAssignment.authority, {
      receiptId: firstReceipt,
      intentVersion: 1,
    });
    const continuationAuthority = decodeTestValue(
      authorityActionDetailsSchema,
      secondResponse.details,
    ).view.action.authorityContext;
    assert.deepEqual(continuationAuthority.selectedScope, {
      intentVersion: 1,
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
      /not authority for current intent 1.*workgraph_intent/,
    );
    const afterRejectedReceipt = resultState(
      (await f.call("workgraph_inspect", { section: "overview" })).details,
    );
    assert.equal(afterRejectedReceipt.intents.at(-1)?.version, 1);
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
          authorityReceiptId: firstReceipt,
        })
      ).details,
    );
    assert.equal(explicitCurrent.intents.at(-1)?.version, 1);

    const changedScopeText =
      "Change the semantic scope to include the corrected follow-up - private changed context";
    await f.runner.emitInput(changedScopeText, undefined, "interactive");
    const beforeRevision = resultState(
      (await f.call("workgraph_inspect", { section: "overview" })).details,
    );
    const changedScopeReceipt = required(
      beforeRevision.inputs[2],
      "changed-scope retained human input",
    ).id;
    assert.equal(beforeRevision.intents.at(-1)?.version, 1);

    const revised = resultState(
      (
        await f.call("workgraph_intent", {
          authorityReceiptId: changedScopeReceipt,
          statement: "Apply the corrected follow-up scope",
          constraints: [],
        })
      ).details,
    );
    assert.equal(revised.intents.at(-1)?.version, 2);
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
    assert.equal(revisedAssignment.intentVersion, 2);
    assert.deepEqual(revisedAssignment.authority, {
      receiptId: changedScopeReceipt,
      intentVersion: 2,
    });
    assert.equal(changedScope.assignments[1]?.intentVersion, 1);
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
      /not authority for current intent 2.*workgraph_intent/,
    );
    assert.deepEqual(
      changedScope.intents.map((intent) => intent.statement),
      ["What is value.txt?", "Fix value", "Apply the corrected follow-up scope"],
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
    assert.equal(reloaded.inputs.length, 3);
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

    let assignmentText = "";
    let assignmentOffset = 0;
    for (;;) {
      const assignmentPage = await f.call("workgraph_inspect", {
        section: "assignment",
        task: "large-result",
        offset: assignmentOffset,
        maxChars: 173,
      });
      const page = decodeTestValue(contentDetailsSchema, assignmentPage.details).inspection.content;
      assignmentText += page.text;
      if (page.next === undefined) break;
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
          unresolved: [],
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

void test("registered model policy mutations require retained genuine input provenance", async () => {
  const f = await fixture();
  try {
    await f.call("workgraph_models", { action: "get" });
    await f.runner.emitInput("Extension model request", undefined, "extension");
    await assert.rejects(
      f.call("workgraph_models", {
        action: "set",
        role: "research",
        target: { model: "fixture/rejected", thinking: "low" },
      }),
      /actual retained human input/,
    );
    const afterExtensionOnly = await f.call("workgraph_models", { action: "get" });
    assert.equal(JSON.stringify(afterExtensionOnly).includes("fixture/rejected"), false);
    await f.runner.emitInput("Persist the first research model", undefined, "interactive");
    const firstMutation = decodeTestValue(
      modelPolicyDetailsSchema,
      (
        await f.call("workgraph_models", {
          action: "set",
          role: "research",
          target: { model: "fixture/default", thinking: "low" },
        })
      ).details,
    );
    const firstReceipt = required(firstMutation.authority, "first model authority").receiptId;
    assert.equal(firstMutation.authority?.source, "interactive");
    assert.match(JSON.stringify(firstMutation), new RegExp(firstReceipt));
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
    await f.runner.emitInput("Persist the changed research model", undefined, "rpc");
    const secondMutation = decodeTestValue(
      modelPolicyDetailsSchema,
      (
        await f.call("workgraph_models", {
          action: "set",
          role: "research",
          target: { model: "fixture/changed", thinking: "high" },
        })
      ).details,
    );
    assert.equal(secondMutation.authority?.source, "rpc");
    assert.notEqual(secondMutation.authority?.receiptId, firstReceipt);
    const explicitPoolMutation = decodeTestValue(
      modelPolicyDetailsSchema,
      (
        await f.call("workgraph_models", {
          action: "set_pool",
          authorityReceiptId: firstReceipt,
          pool: [{ model: "fixture/pool", thinking: "medium" }],
        })
      ).details,
    );
    assert.equal(explicitPoolMutation.authority?.receiptId, firstReceipt);
    await assert.rejects(
      f.call("workgraph_models", {
        action: "set_pool",
        authorityReceiptId: "extension-invented-receipt",
        pool: [{ model: "fixture/rejected-pool", thinking: "low" }],
      }),
      /Unknown retained human input receipt/,
    );
    const afterInventedReceipt = await f.call("workgraph_models", { action: "get" });
    assert.match(JSON.stringify(afterInventedReceipt), /fixture\/pool/);
    assert.equal(JSON.stringify(afterInventedReceipt).includes("fixture/rejected-pool"), false);
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
