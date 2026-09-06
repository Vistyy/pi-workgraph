import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The fixture uses isolated real Git and Pi session storage.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The fixture path is an isolated real repository.
import { join } from "node:path";
import test from "node:test";
import type { TextContent } from "@earendil-works/pi-ai";
import { Clock, Effect } from "effect";
import { Value } from "typebox/value";
import { HumanInputReceiptSchema } from "../src/coordinator-notes.js";
import { runProcess } from "../src/git.js";
import { configureFixtureEnvironment, restoreFixtureEnvironment } from "./decoders.js";
import { extensionFixture, usage } from "./helpers.js";

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await runProcess("git", ["-C", cwd, ...args], { cwd, timeoutMs: 30_000 });
  assert.equal(result.exitCode, 0, result.stderr);
}

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-notes-"));
  const root = join(parent, "repo");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "fixture@example.test");
  await git(root, "config", "user.name", "Fixture");
  const previous = configureFixtureEnvironment({
    PI_CODING_AGENT_DIR: join(parent, "agent"),
    PI_WORKGRAPH_MODE: null,
    HERDR_ENV: null,
    HERDR_WORKSPACE_ID: null,
  });
  const pi = await extensionFixture("coordinator", root, parent);
  return {
    ...pi,
    async dispose() {
      await pi.close();
      restoreFixtureEnvironment(previous);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

function assistant(text: string, timestamp = Effect.runSync(Clock.currentTimeMillis)) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "test",
    provider: "test",
    model: "fixture",
    usage,
    stopReason: "stop" as const,
    timestamp,
  };
}

async function present(f: Awaited<ReturnType<typeof fixture>>, text: string) {
  const message = assistant(text);
  f.session.appendMessage(message);
  await f.runner.emit({ type: "turn_end", turnIndex: 0, message, toolResults: [] });
}

function latestReceipt(f: Awaited<ReturnType<typeof fixture>>) {
  const entry = [...f.session.getBranch()]
    .reverse()
    .find(
      (candidate) =>
        candidate.type === "custom" && candidate.customType === "pi-workgraph-human-input",
    );
  if (entry === undefined || entry.type !== "custom")
    throw new Error("Missing human input receipt.");
  if (!Value.Check(HumanInputReceiptSchema, entry.data))
    throw new Error("Malformed human input receipt.");
  return Value.Decode(HumanInputReceiptSchema, entry.data);
}

async function contextText(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const messages = await f.runner.emitContext([
    { role: "user", content: "next", timestamp: Effect.runSync(Clock.currentTimeMillis) },
  ]);
  return messages
    .filter((message) => message.role === "custom")
    .map((message) =>
      Array.isArray(message.content)
        ? message.content
            .filter((part): part is TextContent => part.type === "text")
            .map((part) => part.text)
            .join("\n")
        : message.content,
    )
    .join("\n");
}

void test("coordinator notes persist visible-answer provenance, partial resolution, superseding, and reload", async () => {
  const f = await fixture();
  try {
    await f.runner.emit({ type: "session_start", reason: "startup" });

    const drafted = await f.call("workgraph_note", {
      changes: [
        { operation: "record", id: "decision", summary: "Need the human's choice of parser." },
      ],
    });
    assert.match(JSON.stringify(drafted.content), /not evidence that an answer was shown/);
    assert.match(await contextText(f), /Drafted but not yet grounded/);

    await present(f, "Which parser should I use?");
    let text = await contextText(f);
    assert.match(text, /decision: Need the human's choice of parser/);
    assert.equal(text.includes("Which parser should I use?"), false);

    await f.runner.emitInput("Thanks, continue the investigation", undefined, "interactive");
    text = await contextText(f);
    assert.match(text, /decision:/, "unrelated human input does not auto-resolve a note");

    await f.call("workgraph_note", {
      changes: [
        { operation: "record", id: "one", summary: "Need answer about the first option." },
        { operation: "record", id: "two", summary: "Need answer about the second option." },
      ],
    });
    await present(f, "Please answer each option separately.");
    await f.runner.emitInput("The first option is preferred", undefined, "rpc");
    const receipt = latestReceipt(f);
    await f.call("workgraph_note", {
      changes: [
        {
          operation: "resolve",
          id: "one",
          receiptId: receipt.id,
          interpretation: "The reply selects the first option only.",
        },
      ],
    });
    text = await contextText(f);
    assert.doesNotMatch(text, /one: Need answer/);
    assert.match(text, /two: Need answer/);

    await f.call("workgraph_note", {
      changes: [
        {
          operation: "supersede",
          id: "two-follow-up",
          summary: "Need the remaining second-option answer after the latest status.",
          supersedes: ["two"],
        },
      ],
    });
    await present(f, "The latest status narrows the remaining request.");
    text = await contextText(f);
    assert.doesNotMatch(text, /two: Need answer/);
    assert.match(text, /two-follow-up: Need the remaining/);

    await f.runner.emit({ type: "session_shutdown", reason: "reload" });
    await f.runner.emit({ type: "session_start", reason: "reload" });
    text = await contextText(f);
    assert.doesNotMatch(text, /one: Need answer/);
    assert.doesNotMatch(text, /two: Need answer/);
    assert.match(text, /two-follow-up: Need the remaining/);
  } finally {
    await f.dispose();
  }
});

void test("coordinator note resolution requires a later genuine receipt and visible assistant entry", async () => {
  const f = await fixture();
  try {
    await f.runner.emit({ type: "session_start", reason: "startup" });
    await f.call("workgraph_note", {
      changes: [{ operation: "record", id: "unshown", summary: "Need a later human response." }],
    });
    await f.runner.emitInput("A reply before the answer", undefined, "rpc");
    const receipt = latestReceipt(f);
    await assert.rejects(
      f.call("workgraph_note", {
        changes: [
          {
            operation: "resolve",
            id: "unshown",
            receiptId: receipt.id,
            interpretation: "This is the answer.",
          },
        ],
      }),
      /drafted but has no finalized visible assistant answer/,
    );
    assert.match(await contextText(f), /unshown: Need a later/);
  } finally {
    await f.dispose();
  }
});
