/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-runtime-typeof -- This supported-boundary fixture inspects Pi session entries and native SQLite rows after their production schemas have accepted and persisted them. */
import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The integration fixture owns real temporary Git and SQLite filesystem resources.
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native fixture paths identify real temporary repositories.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  type ExtensionActions,
  type InlineExtension,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Value } from "typebox/value";
import workstreamCoordinator from "../extensions/coordinator.js";
import { WORKSTREAM_POINTER_ENTRY } from "../src/coordination/controller.js";
import type { HandoffGrant } from "../src/domain/workstream.js";
import { createWorkstream } from "../src/domain/workstream.js";
import {
  deterministicChildSessionId,
  HANDOFF_KICKOFF_CLAIM_ENTRY,
  HANDOFF_KICKOFF_ENTRY,
  prepareHandoffSession,
} from "../src/handoff-session.js";
import { HerdrCliRuntime } from "../src/herdr.js";
import { liveLayer } from "../src/node-platform.js";
import { WorkstreamStore } from "../src/storage/workstream-store.js";
import { configureFixtureEnvironment, restoreFixtureEnvironment } from "./decoders.js";
import { extensionFixture, git, usage } from "./helpers.js";

function childGrant(
  repository: { projectRoot: string; gitCommonDir: string },
  id = "grant-bootstrap",
): HandoffGrant {
  return {
    kind: "handoff_grant",
    id,
    parentReceipt: {
      kind: "human_input_receipt",
      id: "root-receipt",
      sessionId: "parent-session",
      sessionFile: "/parent.jsonl",
      source: "interactive",
      text: "Parent request",
      receivedAt: "2026-01-01T00:00:00.000Z",
    },
    parentWorkstreamId: "parent-workstream",
    parentRepository: repository,
    parentIntentIndex: 0,
    parentIntentStatement: "Parent request",
    parentIntentConstraints: ["Inherited constraint"],
    narrowedRequest: "Focused child request",
    targetRepository: repository,
    issuedAt: "2026-01-01T00:00:01.000Z",
  };
}

const TARGET_TOOLS = [
  "workgraph_models",
  "workgraph_intent",
  "workgraph_handoff",
  "workgraph_research",
  "workgraph_consult",
  "workgraph_implement",
  "workgraph_review",
  "workgraph_attempt",
  "workgraph_inspect",
  "workgraph_control",
  "workgraph_adopt",
  "workgraph_complete",
  "workgraph_notepad",
] as const;

function appendHandoffInvocation(
  session: SessionManager,
  request: string,
  toolCallId = "fixture",
): void {
  session.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: toolCallId,
        name: "workgraph_handoff",
        arguments: { request },
      },
    ],
    api: "test",
    provider: "test",
    model: "fixture",
    usage,
    stopReason: "toolUse",
    timestamp: 1,
  });
}

async function fixture(
  actions: Partial<ExtensionActions> = {},
  extensionFactories: InlineExtension[] = [workstreamCoordinator],
  childGrant?: (repository: { projectRoot: string; gitCommonDir: string }) => HandoffGrant,
) {
  const parent = await mkdtemp(join(tmpdir(), "workstream-coordinator-"));
  const root = join(parent, "repo");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "fixture@example.test");
  await git(root, "config", "user.name", "Fixture");
  await writeFile(join(root, "tracked.txt"), "fixture\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  const previous = configureFixtureEnvironment({
    PI_WORKGRAPH_MODE: null,
    PI_CODING_AGENT_DIR: join(parent, "agent"),
  });
  const commonDir = await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const grant = childGrant?.({ projectRoot: root, gitCommonDir: commonDir });
  const prepared =
    grant === undefined
      ? undefined
      : await Effect.runPromise(
          prepareHandoffSession(root, deterministicChildSessionId(grant.id), grant, []).pipe(
            Effect.provide(liveLayer),
          ),
        );
  const session = prepared === undefined ? undefined : SessionManager.open(prepared.sessionFile);
  const pi = await extensionFixture(
    "coordinator",
    root,
    parent,
    actions,
    extensionFactories,
    session,
  );
  return {
    ...pi,
    root,
    parent,
    grant,
    childSessionFile: prepared?.sessionFile,
    async dispose() {
      await pi.close();
      restoreFixtureEnvironment(previous);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

void test("package and staged factory register only the workstream coordinator and worker", async () => {
  const packaged = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
    pi: { extensions: string[] };
  };
  assert.deepEqual(packaged.pi.extensions, [
    "./extensions/coordinator.ts",
    "./extensions/worker.ts",
  ]);
  const f = await fixture();
  try {
    for (const name of TARGET_TOOLS)
      assert.ok(f.runner.getToolDefinition(name) !== undefined, `missing ${name}`);
    assert.equal(f.runner.getToolDefinition("workgraph_fork"), undefined);
    assert.equal(f.runner.getToolDefinition("workgraph_reload"), undefined);
  } finally {
    await f.dispose();
  }
});

void test("child session bootstrap creates the grant-grounded first Intent and triggers kickoff once", async () => {
  const f = await fixture({}, [workstreamCoordinator], childGrant);
  try {
    assert.ok(f.grant !== undefined);
    await f.runner.emit({ type: "session_start", reason: "new" });
    const inspection = await f.call("workgraph_inspect", { section: "context" });
    assert.match(JSON.stringify(inspection.details), /Focused child request/);
    assert.match(JSON.stringify(inspection.details), /handoff_grant/);
    assert.equal(
      f.messages.filter((message) => message.customType === HANDOFF_KICKOFF_ENTRY).length,
      1,
    );

    const identity = {
      grantId: f.grant.id,
      childSessionId: deterministicChildSessionId(f.grant.id),
    };
    const claim = f.session
      .getBranch()
      .find((entry) => entry.type === "custom" && entry.customType === HANDOFF_KICKOFF_CLAIM_ENTRY);
    assert.ok(claim?.type === "custom");
    assert.deepEqual(claim.data, identity);
    f.session.appendCustomMessageEntry(HANDOFF_KICKOFF_ENTRY, "retained kickoff", true, identity);
    await f.runner.emit({ type: "session_start", reason: "reload" });
    assert.equal(
      f.messages.filter((message) => message.customType === HANDOFF_KICKOFF_ENTRY).length,
      1,
    );
    assert.ok(f.notifications.some((item) => /not duplicated/.test(item.message)));
  } finally {
    await f.dispose();
  }
});

void test("conflicting first grounding disables an attached child Workstream", async () => {
  const f = await fixture({}, [workstreamCoordinator], (repository) =>
    childGrant(repository, "grant-conflicting-grounding"),
  );
  try {
    await f.runner.emit({ type: "session_start", reason: "new" });
    const pointer = f.session
      .getBranch()
      .findLast(
        (entry) => entry.type === "custom" && entry.customType === WORKSTREAM_POINTER_ENTRY,
      );
    assert.ok(pointer?.type === "custom");
    const path = (pointer.data as { path: string }).path;
    await f.runner.emit({ type: "session_shutdown", reason: "reload" });

    const database = new DatabaseSync(path);
    const row = database.prepare("SELECT state_json FROM workstream WHERE singleton=1").get() as {
      state_json: string;
    };
    const state = JSON.parse(row.state_json) as { intents: Array<{ statement: string }> };
    const first = state.intents[0];
    assert.ok(first !== undefined);
    first.statement = "Conflicting first grounding";
    database
      .prepare("UPDATE workstream SET state_json=? WHERE singleton=1")
      .run(JSON.stringify(state));
    database.close();

    await f.runner.emit({ type: "session_start", reason: "reload" });
    await assert.rejects(
      f.call("workgraph_inspect", { section: "overview" }),
      /No Workstream is attached/,
    );
    const readback = new DatabaseSync(path, { readOnly: true });
    assert.equal(readback.prepare("SELECT token FROM lease WHERE singleton=1").get(), undefined);
    readback.close();
    assert.ok(f.notifications.some((item) => /first Intent does not match/.test(item.message)));
  } finally {
    await f.dispose();
  }
});

void test("kickoff host failure leaves a durable uncertain claim and never resends", async () => {
  const f = await fixture(
    {
      sendMessage() {
        throw new Error("native send failed");
      },
    },
    [workstreamCoordinator],
    (repository) => childGrant(repository, "grant-kickoff-host-failure"),
  );
  try {
    assert.ok(f.grant !== undefined);
    await f.runner.emit({ type: "session_start", reason: "new" });
    const claims = f.session
      .getBranch()
      .filter(
        (entry) => entry.type === "custom" && entry.customType === HANDOFF_KICKOFF_CLAIM_ENTRY,
      );
    assert.equal(claims.length, 1);
    assert.ok(
      f.notifications.some((item) =>
        /Handoff child session start failed: native send failed/.test(item.message),
      ),
    );
    await assert.rejects(
      f.call("workgraph_inspect", { section: "overview" }),
      /No Workstream is attached/,
    );

    await f.runner.emit({ type: "session_start", reason: "reload" });
    assert.equal(
      f.session
        .getBranch()
        .filter(
          (entry) => entry.type === "custom" && entry.customType === HANDOFF_KICKOFF_CLAIM_ENTRY,
        ).length,
      1,
    );
    assert.ok(f.notifications.some((item) => /submission is uncertain/.test(item.message)));
    await f.call("workgraph_inspect", { section: "overview" });
  } finally {
    await f.dispose();
  }
});

void test("handoff tool checkpoints one successful independent launch and exact replay mutates no remote", async () => {
  const native = await mkdtemp(join(tmpdir(), "workstream-handoff-herdr-"));
  const command = join(native, "herdr.mjs");
  const stateFile = join(native, "state.json");
  const logFile = join(native, "calls.jsonl");
  await writeFile(
    command,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
const read = () => existsSync(${JSON.stringify(stateFile)}) ? JSON.parse(readFileSync(${JSON.stringify(stateFile)}, "utf8")) : undefined;
if (args[0] === "workspace" && args[1] === "list") console.log(JSON.stringify({result:{workspaces:[]}}));
else if (args[0] === "workspace" && args[1] === "create") { const cwd=args[args.indexOf("--cwd")+1]; writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify({cwd})); console.log(JSON.stringify({result:{workspace:{workspace_id:"handoff-workspace"},tab:{tab_id:"handoff-tab"},root_pane:{pane_id:"handoff-pane"}}})); }
else if (args[0] === "agent" && args[1] === "start") { const prior=read(); const session=args[args.indexOf("--session")+1]; writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify({...prior,name:args[2],session})); console.log(JSON.stringify({result:{agent:{workspace_id:"handoff-workspace",tab_id:"handoff-tab",pane_id:"handoff-pane",terminal_id:"handoff-terminal",agent_status:"working",name:args[2],cwd:prior.cwd}}})); }
else if (args[0] === "agent" && args[1] === "get") { const value=read(); console.log(JSON.stringify({result:{agent:{workspace_id:"handoff-workspace",tab_id:"handoff-tab",pane_id:"handoff-pane",terminal_id:"handoff-terminal",agent_status:"working",name:value.name,cwd:value.cwd,agent_session:{value:value.session}}}})); }
else console.log(JSON.stringify({result:{}}));
`,
  );
  await chmod(command, 0o755);
  const runtime = new HerdrCliRuntime(command, { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "parent" });
  const f = await fixture({}, [(pi) => workstreamCoordinator(pi, { workers: () => runtime })]);
  try {
    await f.input("Coordinate the parent request");
    await f.call("workgraph_intent", {
      statement: "Coordinate the parent request",
      constraints: ["Keep scope narrow"],
    });
    const first = await f.call("workgraph_handoff", { request: "Perform the focused child part" });
    assert.equal((first.details as { resultChannel?: string }).resultChannel, "none");
    const beforeReplay = await readFile(logFile, "utf8");
    const replay = await f.call("workgraph_handoff", { request: "Perform the focused child part" });
    assert.equal(
      (replay.details as { childSessionFile?: string }).childSessionFile,
      (first.details as { childSessionFile?: string }).childSessionFile,
    );
    assert.equal(await readFile(logFile, "utf8"), beforeReplay);
    const pointerEntry = f.session
      .getBranch()
      .findLast(
        (entry) => entry.type === "custom" && entry.customType === WORKSTREAM_POINTER_ENTRY,
      );
    assert.ok(pointerEntry?.type === "custom");
    const attachment = await Effect.runPromise(
      Effect.scoped(WorkstreamStore.discover((pointerEntry.data as { path: string }).path)).pipe(
        Effect.provide(liveLayer),
      ),
    );
    assert.equal(attachment.state.handoffs?.[0]?.phase, "launched");
    await rm((first.details as { childSessionFile: string }).childSessionFile, { force: true });
  } finally {
    await f.dispose();
    await rm(native, { recursive: true, force: true });
  }
});

void test("handoff recovery probes exact workspace and child agent after interrupted remote responses", async () => {
  for (const failure of ["workspace", "start"] as const) {
    const native = await mkdtemp(join(tmpdir(), `workstream-handoff-${failure}-`));
    const command = join(native, "herdr.mjs");
    const stateFile = join(native, "state.json");
    const failedFile = join(native, "failed");
    const logFile = join(native, "calls.jsonl");
    await writeFile(
      command,
      `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args=process.argv.slice(2); appendFileSync(${JSON.stringify(logFile)},JSON.stringify(args)+"\\n");
const load=()=>existsSync(${JSON.stringify(stateFile)})?JSON.parse(readFileSync(${JSON.stringify(stateFile)},"utf8")):undefined;
const save=(v)=>writeFileSync(${JSON.stringify(stateFile)},JSON.stringify(v));
const current=load();
const agent=(v,native)=>({workspace_id:"w",tab_id:"t",pane_id:"p",terminal_id:"terminal",agent_status:"working",name:v.name,cwd:v.cwd,...(native?{agent_session:{value:v.session}}:{})});
if(args[0]==="workspace"&&args[1]==="list") console.log(JSON.stringify({result:{workspaces:current?[{workspace_id:"w",label:current.label}]:[]}}));
else if(args[0]==="tab"&&args[1]==="list") console.log(JSON.stringify({result:{tabs:[{tab_id:"t"}]}}));
else if(args[0]==="pane"&&args[1]==="list") console.log(JSON.stringify({result:{panes:[{workspace_id:"w",tab_id:"t",pane_id:"p",terminal_id:"terminal",cwd:current.cwd}]}}));
else if(args[0]==="api"&&args[1]==="snapshot") console.log(JSON.stringify({result:{snapshot:{agents:current?.session?[agent(current,true)]:[]}}}));
else if(args[0]==="workspace"&&args[1]==="create") { const value={cwd:args[args.indexOf("--cwd")+1],label:args[args.indexOf("--label")+1]}; save(value); if(${JSON.stringify(failure)}==="workspace"&&!existsSync(${JSON.stringify(failedFile)})){writeFileSync(${JSON.stringify(failedFile)},"");process.exit(1)} console.log(JSON.stringify({result:{workspace:{workspace_id:"w"},tab:{tab_id:"t"},root_pane:{pane_id:"p"}}})); }
else if(args[0]==="agent"&&args[1]==="start") { const value={...current,name:args[2],session:args[args.indexOf("--session")+1]}; save(value); if(${JSON.stringify(failure)}==="start"&&!existsSync(${JSON.stringify(failedFile)})){writeFileSync(${JSON.stringify(failedFile)},"");process.exit(1)} console.log(JSON.stringify({result:{agent:agent(value,false)}})); }
else if(args[0]==="agent"&&args[1]==="get") console.log(JSON.stringify({result:{agent:agent(load(),true)}}));
else console.log(JSON.stringify({result:{}}));
`,
    );
    await chmod(command, 0o755);
    const runtime = new HerdrCliRuntime(command, { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "parent" });
    const f = await fixture({}, [(pi) => workstreamCoordinator(pi, { workers: () => runtime })]);
    try {
      await f.input("Parent request");
      await f.call("workgraph_intent", { statement: "Parent request" });
      appendHandoffInvocation(f.session, `Recover ${failure}`, "original-call");
      await assert.rejects(
        f.callWithId("original-call", "workgraph_handoff", { request: `Recover ${failure}` }),
      );
      const beforeMismatch = await readFile(logFile, "utf8");
      await assert.rejects(
        f.callWithId("different-call", "workgraph_handoff", {
          request: `Different ${failure}`,
        }),
        /different request/,
      );
      assert.equal(await readFile(logFile, "utf8"), beforeMismatch);
      const recovered = await f.callWithId("recovery-call", "workgraph_handoff", {
        request: `Recover ${failure}`,
      });
      const calls = (await readFile(logFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.equal(
        calls.filter((args) => args[0] === "workspace" && args[1] === "create").length,
        1,
      );
      assert.equal(calls.filter((args) => args[0] === "agent" && args[1] === "start").length, 1);
      const pointer = f.session
        .getBranch()
        .findLast(
          (entry) => entry.type === "custom" && entry.customType === WORKSTREAM_POINTER_ENTRY,
        );
      assert.ok(pointer?.type === "custom");
      const attachment = await Effect.runPromise(
        Effect.scoped(WorkstreamStore.discover((pointer.data as { path: string }).path)).pipe(
          Effect.provide(liveLayer),
        ),
      );
      assert.equal(attachment.state.handoffs?.length, 1);
      assert.equal(attachment.state.handoffs?.[0]?.toolCallId, "original-call");
      assert.equal(
        attachment.state.handoffs?.[0]?.childSessionId,
        (recovered.details as { childSessionId: string }).childSessionId,
      );
      await rm((recovered.details as { childSessionFile: string }).childSessionFile, {
        force: true,
      });
    } finally {
      await f.dispose();
      await rm(native, { recursive: true, force: true });
    }
  }
});

void test("workstream tool schemas expose release_output and every runtime facade returns a Promise without an attachment", async () => {
  const f = await fixture();
  try {
    const control = f.runner.getToolDefinition("workgraph_control");
    assert.ok(control !== undefined);
    assert.equal(
      Value.Check(control.parameters, {
        action: "release_output",
        attempt: "attempt-1",
        reason: "retire exact output",
      }),
      true,
    );
    assert.equal(
      Value.Check(control.parameters, {
        action: "release",
        attempt: "attempt-1",
        reason: "retire exact output",
      }),
      false,
    );
    assert.equal(Value.Check(control.parameters, { action: "suspend", reason: "   " }), false);

    const calls: Array<[string, object]> = [
      ["workgraph_research", { id: "r", question: "q", expectedEvidence: ["e"] }],
      ["workgraph_consult", { id: "c", question: "q" }],
      ["workgraph_implement", { id: "i", objective: "o", acceptance: ["a"] }],
      [
        "workgraph_review",
        {
          id: "v",
          objective: "o",
          concern: "c",
          subject: { kind: "revision", revision: "a".repeat(40) },
        },
      ],
      ["workgraph_attempt", { task: "t" }],
      ["workgraph_control", { action: "resume", reason: "continue" }],
      ["workgraph_complete", { conclusion: "done", evidence: [{ label: "e", observation: "o" }] }],
    ];
    for (const [name, params] of calls) {
      const tool = f.runner.getToolDefinition(name);
      assert.ok(tool !== undefined && Value.Check(tool.parameters, params));
      const result = tool.execute(
        "promise-check",
        Value.Decode(tool.parameters, params),
        undefined,
        undefined,
        f.runner.createContext(),
      );
      assert.ok(result instanceof Promise, `${name} must return a Promise`);
      await assert.rejects(result, /No Workstream is attached/);
    }
  } finally {
    await f.dispose();
  }
});

void test("session_start closes the attached runtime before rejecting a different malformed pointer", async () => {
  const f = await fixture();
  try {
    await f.input("Create the original Workstream");
    await f.call("workgraph_intent", { statement: "Create the original Workstream" });
    const originalPointer = f.session
      .getBranch()
      .findLast(
        (entry) => entry.type === "custom" && entry.customType === WORKSTREAM_POINTER_ENTRY,
      );
    assert.ok(originalPointer?.type === "custom");
    const originalPath = (originalPointer.data as { path: string }).path;
    const original = await Effect.runPromise(
      Effect.scoped(WorkstreamStore.discover(originalPath)).pipe(Effect.provide(liveLayer)),
    );
    const intent = original.state.intents[0];
    assert.ok(intent !== undefined);
    const targetState = createWorkstream({
      id: "malformed-target",
      purpose: "Must remain untouched",
      repository: original.state.repository,
      coordinator: original.state.coordinator,
      intent,
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    const target = await Effect.runPromise(
      Effect.scoped(WorkstreamStore.create(targetState)).pipe(Effect.provide(liveLayer)),
    );
    const targetBefore = await readFile(target.store.path);
    const originalStateBefore = original.state;

    f.session.appendCustomEntry(WORKSTREAM_POINTER_ENTRY, {
      version: 1,
      phase: "attached",
      path: target.store.path,
      workstreamId: targetState.id,
    });
    await f.runner.emit({ type: "session_start", reason: "reload" });

    await assert.rejects(
      f.call("workgraph_inspect", { section: "overview" }),
      /No Workstream is attached/,
    );
    const database = new DatabaseSync(originalPath, { readOnly: true });
    const lease = database.prepare("SELECT token FROM lease WHERE singleton=1").get();
    const row = database.prepare("SELECT state_json FROM workstream WHERE singleton=1").get() as {
      state_json: string;
    };
    database.close();
    assert.equal(lease, undefined);
    assert.deepEqual(JSON.parse(row.state_json), originalStateBefore);
    assert.deepEqual(await readFile(target.store.path), targetBefore);

    await f.input("Do not create another Workstream");
    await assert.rejects(
      f.call("workgraph_intent", { statement: "Do not create another Workstream" }),
      /startup remains blocked.*pointer is malformed/,
    );
    assert.equal(
      f.session
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === WORKSTREAM_POINTER_ENTRY)
        .length,
      3,
    );
  } finally {
    await f.dispose();
  }
});

void test("prepared pointer append failure creates no workstream store", async () => {
  let session: Awaited<ReturnType<typeof extensionFixture>>["session"] | undefined;
  let pointerAppends = 0;
  const f = await fixture({
    appendEntry(type, data) {
      session?.appendCustomEntry(type, data);
      if (type === WORKSTREAM_POINTER_ENTRY) {
        pointerAppends += 1;
        throw new Error("pointer append failed");
      }
    },
  });
  session = f.session;
  try {
    await f.input("Do not persist without the declaration");
    await assert.rejects(
      f.call("workgraph_intent", { statement: "Do not persist without the declaration" }),
      /pointer append failed/,
    );
    await assert.rejects(readdir(join(f.root, ".git", "pi-workgraph")), /ENOENT/);

    await f.input("Do not create a second Workstream");
    await assert.rejects(
      f.call("workgraph_intent", { statement: "Do not create a second Workstream" }),
      /retained workstream pointer/,
    );
    assert.equal(pointerAppends, 1);
    const pointers = f.session
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === WORKSTREAM_POINTER_ENTRY);
    assert.equal(pointers.length, 1);
    assert.ok(pointers[0]?.type === "custom");
    assert.equal((pointers[0].data as { phase?: unknown }).phase, "prepared");
    await assert.rejects(readdir(join(f.root, ".git", "pi-workgraph")), /ENOENT/);
  } finally {
    await f.dispose();
  }
});

void test("repository proof rejects a crafted aggregate before lease or pointer effects", async () => {
  const f = await fixture();
  try {
    const foreignRoot = join(f.parent, "not-a-repository");
    await mkdir(foreignRoot);
    const ctx = f.runner.createContext();
    const sessionFile = ctx.sessionManager.getSessionFile();
    assert.ok(sessionFile !== undefined);
    const repository = { projectRoot: foreignRoot, gitCommonDir: join(f.root, ".git") };
    const initial = createWorkstream({
      id: "crafted-repository",
      purpose: "Must not attach",
      repository,
      coordinator: { sessionId: ctx.sessionManager.getSessionId(), sessionFile },
      intent: {
        statement: "Must not attach",
        constraints: [],
        grounding: {
          kind: "human_input_receipt",
          id: "receipt",
          sessionId: ctx.sessionManager.getSessionId(),
          sessionFile,
          source: "interactive",
          text: "Must not attach",
          receivedAt: "2024-01-01T00:00:00.000Z",
        },
        recordedAt: "2024-01-01T00:00:00.000Z",
      },
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    const attachment = await Effect.runPromise(
      Effect.scoped(WorkstreamStore.create(initial)).pipe(Effect.provide(liveLayer)),
    );
    f.session.appendCustomEntry(WORKSTREAM_POINTER_ENTRY, {
      version: 1,
      phase: "attached",
      path: attachment.store.path,
      workstreamId: initial.id,
      repository,
    });
    const before = await readFile(attachment.store.path);
    await f.runner.emit({ type: "session_start", reason: "reload" });
    assert.deepEqual(await readFile(attachment.store.path), before);
    const database = new DatabaseSync(attachment.store.path, { readOnly: true });
    assert.equal(database.prepare("SELECT token FROM lease").get(), undefined);
    database.close();
    assert.equal(
      f.session
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === WORKSTREAM_POINTER_ENTRY)
        .length,
      1,
    );
  } finally {
    await f.dispose();
  }
});

void test("current Pi input survives session restoration and grounds one private Workstream", async () => {
  const f = await fixture();
  try {
    await f.input("Build the workstream target", "interactive");
    const receipt = f.session
      .getBranch()
      .find((entry) => entry.type === "custom" && entry.customType === "pi-workgraph-human-input");
    assert.ok(receipt?.type === "custom");
    assert.equal(typeof (receipt.data as { receivedAt?: unknown }).receivedAt, "string");
    assert.equal("kind" in (receipt.data as object), false);

    await f.runner.emit({ type: "session_shutdown", reason: "reload" });
    await f.runner.emit({ type: "session_start", reason: "reload" });
    await f.call("workgraph_intent", {
      statement: "Build the workstream target",
      constraints: ["Keep the current state loaded"],
      authorityReceiptId: (receipt.data as { id: string }).id,
    });
    const branch = f.session.getBranch();
    const receipts = branch.filter(
      (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-human-input",
    );
    assert.equal(receipts.length, 1);
    const pointers = branch.filter(
      (entry) => entry.type === "custom" && entry.customType === WORKSTREAM_POINTER_ENTRY,
    );
    assert.equal(pointers.length, 2);
    const prepared = pointers[0];
    const attached = pointers[1];
    assert.ok(prepared?.type === "custom" && attached?.type === "custom");
    assert.equal((prepared.data as { phase: string }).phase, "prepared");
    assert.equal((attached.data as { phase: string }).phase, "attached");
    const path = (attached.data as { path: string }).path;
    const database = new DatabaseSync(path, { readOnly: true });
    const row = database.prepare("SELECT state_json FROM workstream WHERE singleton=1").get() as {
      state_json: string;
    };
    const lease = database.prepare("SELECT owner_session_id FROM lease WHERE singleton=1").get();
    database.close();
    const state = JSON.parse(row.state_json) as {
      intents: Array<{ grounding: { id: string; receivedAt: string } }>;
    };
    assert.equal(state.intents.length, 1);
    assert.equal(state.intents[0]?.grounding.id, (receipt.data as { id: string }).id);
    assert.equal(
      state.intents[0]?.grounding.receivedAt,
      (receipt.data as { receivedAt: string }).receivedAt,
    );
    assert.ok(lease !== undefined);
    const discovered = await Effect.runPromise(
      Effect.scoped(WorkstreamStore.discover(path)).pipe(Effect.provide(liveLayer)),
    );
    assert.equal(discovered.state.intents.length, 1);

    await f.runner.emit({ type: "session_shutdown", reason: "reload" });
    f.session.appendCustomEntry(WORKSTREAM_POINTER_ENTRY, structuredClone(prepared.data));
    await f.runner.emit({ type: "session_start", reason: "reload" });
    const replayed = f.session
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === WORKSTREAM_POINTER_ENTRY);
    assert.equal(replayed.length, 4);
    const replayAttachment = replayed.at(-1);
    assert.ok(replayAttachment?.type === "custom");
    assert.equal((replayAttachment.data as { phase: string }).phase, "attached");
    assert.equal((replayAttachment.data as { path: string }).path, path);
  } finally {
    await f.dispose();
  }
});

void test("prepared adoption replays an already-committed exact transfer once", async () => {
  const source = await fixture();
  let successor: Awaited<ReturnType<typeof extensionFixture>> | undefined;
  try {
    await source.input("Create an adoptable Workstream");
    await source.call("workgraph_intent", { statement: "Create an adoptable Workstream" });
    const pointer = source.session
      .getBranch()
      .findLast(
        (entry) => entry.type === "custom" && entry.customType === WORKSTREAM_POINTER_ENTRY,
      );
    assert.ok(pointer?.type === "custom");
    const statePath = (pointer.data as { path: string }).path;
    await source.runner.emit({ type: "session_shutdown", reason: "reload" });

    const successorParent = join(source.parent, "successor");
    await mkdir(successorParent);
    Reflect.set(process.env, "PI_CODING_AGENT_DIR", join(successorParent, "agent"));
    let successorSession: Awaited<ReturnType<typeof extensionFixture>>["session"] | undefined;
    let interruptAttached = true;
    const workers = new HerdrCliRuntime("unused", {});
    Object.defineProperty(workers, "coordinatorLiveness", {
      value: () => Effect.succeed("dead" as const),
    });
    successor = await extensionFixture(
      "coordinator",
      source.root,
      successorParent,
      {
        appendEntry(type, data) {
          if (type === WORKSTREAM_POINTER_ENTRY) {
            const phase = (data as { phase?: unknown }).phase;
            if (phase === "attached" && interruptAttached) {
              interruptAttached = false;
              throw new Error("interrupt after transfer");
            }
          }
          successorSession?.appendCustomEntry(type, data);
        },
      },
      [(pi) => workstreamCoordinator(pi, { workers: () => workers })],
    );
    successorSession = successor.session;
    await assert.rejects(
      successor.call("workgraph_adopt", { statePath }),
      /interrupt after transfer/,
    );
    await successor.runner.emit({ type: "session_shutdown", reason: "reload" });
    await successor.runner.emit({ type: "session_start", reason: "reload" });
    const discovered = await Effect.runPromise(
      Effect.scoped(WorkstreamStore.discover(statePath)).pipe(Effect.provide(liveLayer)),
    );
    assert.equal(discovered.state.coordinatorTransfers.length, 1);
    const retainedPointers = successor.session
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === WORKSTREAM_POINTER_ENTRY);
    assert.deepEqual(
      retainedPointers.map((entry) =>
        entry.type === "custom" ? (entry.data as { phase: string }).phase : "invalid",
      ),
      ["prepared", "attached"],
    );
  } finally {
    if (successor !== undefined) await successor.close();
    await source.dispose();
  }
});

void test("intent revision selects the latest eligible receipt and rejects repository switching before mutation", async () => {
  const f = await fixture();
  try {
    await f.input("Initial scope");
    await f.call("workgraph_intent", { statement: "Initial scope" });
    await f.input("Revised scope", "rpc");
    await f.call("workgraph_intent", { statement: "Revised scope" });
    const pointer = f.session
      .getBranch()
      .findLast(
        (entry) => entry.type === "custom" && entry.customType === WORKSTREAM_POINTER_ENTRY,
      );
    assert.ok(pointer?.type === "custom");
    const path = (pointer.data as { path: string }).path;
    const readState = () => {
      const database = new DatabaseSync(path, { readOnly: true });
      const row = database.prepare("SELECT state_json FROM workstream WHERE singleton=1").get() as {
        state_json: string;
      };
      database.close();
      return JSON.parse(row.state_json) as {
        revision: number;
        intents: Array<{ statement: string; grounding: { text: string; source: string } }>;
      };
    };
    const revised = readState();
    assert.equal(revised.revision, 1);
    assert.equal(revised.intents[1]?.grounding.text, "Revised scope");
    assert.equal(revised.intents[1]?.grounding.source, "rpc");

    const foreign = join(f.parent, "foreign");
    await mkdir(foreign);
    await git(foreign, "init", "-b", "main");
    await git(foreign, "config", "user.email", "fixture@example.test");
    await git(foreign, "config", "user.name", "Fixture");
    await writeFile(join(foreign, "foreign.txt"), "foreign\n");
    await git(foreign, "add", ".");
    await git(foreign, "commit", "-m", "foreign");
    await assert.rejects(
      f.call("workgraph_intent", {
        statement: "Do not retarget",
        targetRepository: foreign,
      }),
      /cannot switch repositories/,
    );
    assert.equal(readState().revision, 1);
  } finally {
    await f.dispose();
  }
});

void test("missing receipt rejects before workstream storage or pointer creation", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.call("workgraph_intent", { statement: "Unauthorized" }),
      /eligible current-session human input receipt/,
    );
    assert.equal(
      f.session
        .getBranch()
        .some((entry) => entry.type === "custom" && entry.customType === WORKSTREAM_POINTER_ENTRY),
      false,
    );
  } finally {
    await f.dispose();
  }
});
