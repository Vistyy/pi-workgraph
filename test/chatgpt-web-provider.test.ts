import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- These tests exercise the package filesystem boundary with a fake client.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The test resolves the package-relative bundled client.
import { join } from "node:path";
import test from "node:test";
import { setTimeout as setTimer } from "node:timers/promises";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import registerProvider, {
  CHATGPT_WEB_API,
  CHATGPT_WEB_MODEL,
  CHATGPT_WEB_PROVIDER,
  chatGPTWebArtifactPath,
  extractResearchObjective,
  RESEARCH_OBJECTIVE_MAX_BYTES,
} from "../extensions/chatgpt-web-provider.js";

const objective = "[WORKGRAPH RESEARCH OBJECTIVE]\nAnswer the bounded fixture question.";

function objectiveMessages(text = objective): Context["messages"] {
  return convertToLlm([
    { role: "custom", customType: "workgraph", content: text, display: true, timestamp: 1 },
  ]);
}

async function fakeBridge(root: string): Promise<string> {
  const script = join(root, "fake-consult.py");
  await writeFile(
    script,
    `import json, os, pathlib, sys, time
root = pathlib.Path(os.environ["CODEX_WEB_GPT_HEADLESS_ROOT"])
prompt = pathlib.Path(sys.argv[1]).read_text()
(root / "received-prompt.txt").write_text(prompt)
count = root / "invocations"
count.write_text(str(int(count.read_text()) + 1) if count.exists() else "1")
out = pathlib.Path(sys.argv[sys.argv.index("--output") + 1])
out.mkdir(mode=0o700, parents=True)
model = "chatgpt-web/pro"
if "FAIL" in prompt:
    (out / "status.json").write_text(json.dumps({"state":"submission_uncertain","requested_model":model}))
    raise SystemExit(3)
(out / "status.json").write_text(json.dumps({"state":"submission_uncertain","requested_model":model}))
if "LOCK" in prompt or "ABORT" in prompt:
    time.sleep(30)
answer = "WEB ANSWER\\n"
(out / "response.json").write_text(json.dumps({"status":"completed","model":model}))
(out / "answer.md").write_text(answer)
(out / "status.json").write_text(json.dumps({"state":"completed","requested_model":model,"response_model":model}))
print(answer, end="")
`,
    { mode: 0o600 },
  );
  await writeFile(join(root, "invocations"), "0", { mode: 0o600 });
  return script;
}

function setEnvironment(changes: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    // oxlint-disable-next-line effecttsgo/process-env -- Tests deliberately inject provider boundary settings.
    else process.env[key] = value;
  }
}

function restore(previous: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env))
    if (!(key in previous)) Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, previous);
}

async function withFixture(
  name: string,
  callback: (root: string, config: ProviderConfig) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `pi-workgraph-chatgpt-${name}-`));
  const client = await fakeBridge(root);
  const previous = { ...process.env };
  setEnvironment({
    CODEX_WEB_GPT_HEADLESS_ROOT: root,
    PI_WORKGRAPH_CHATGPT_WEB_CLIENT: client,
    PI_WORKGRAPH_MODE: "research",
    PI_WORKGRAPH_RUN_ID: `run-${name}`,
    PI_WORKGRAPH_NODE_ID: `node-${name}`,
  });
  try {
    await callback(root, providerConfig());
  } finally {
    restore(previous);
    await rm(root, { recursive: true, force: true });
  }
}

async function waitForInvocation(root: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await readFile(join(root, "invocations"), "utf8")) === expected) return;
    await setTimer(10);
  }
  throw new Error(`fake bridge did not reach invocation count ${expected}`);
}

function providerConfig(): ProviderConfig {
  let config: ProviderConfig | undefined;
  // SAFETY: The fixture intentionally supplies only the registration member used by this test.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The fixture intentionally supplies only the registration member used by this test.
  registerProvider({
    registerProvider: (_name: string, value: ProviderConfig) => (config = value),
  } as unknown as ExtensionAPI);
  assert.ok(config);
  return config;
}

function model(): Model<Api> {
  return {
    id: CHATGPT_WEB_MODEL,
    name: "ChatGPT Web Pro",
    provider: CHATGPT_WEB_PROVIDER,
    api: CHATGPT_WEB_API,
    baseUrl: "http://127.0.0.1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400_000,
    maxTokens: 128_000,
  };
}

async function runProvider(
  config: ProviderConfig,
  messages: Context["messages"],
  signal?: AbortSignal,
) {
  assert.ok(config.streamSimple);
  const stream = config.streamSimple(
    model(),
    { messages, tools: [] },
    signal === undefined ? undefined : { signal },
  );
  for await (const _event of stream) {
    // Consume the supported stream boundary before reading its terminal result.
  }
  return stream.result();
}

await test("production text blocks succeed and completed artifacts replay", async () => {
  await withFixture("success", async (root, config) => {
    const converted = [...objectiveMessages(`${objective} older`), ...objectiveMessages()];
    assert.deepEqual(converted.at(-1)?.content, [{ type: "text", text: objective }]);
    const first = await runProvider(config, converted);
    assert.equal(first.stopReason, "toolUse");
    const call = first.content[0];
    assert.ok(call?.type === "toolCall");
    assert.equal(call.name, "workgraph_report");
    assert.equal(call.arguments["summary"], "WEB ANSWER\n");
    assert.equal(await readFile(join(root, "received-prompt.txt"), "utf8"), objective);
    assert.equal(await readFile(join(root, "invocations"), "utf8"), "1");

    setEnvironment({ PI_WORKGRAPH_CHATGPT_WEB_CLIENT: join(root, "missing.py") });
    const replay = await runProvider(config, objectiveMessages());
    assert.equal(replay.stopReason, "toolUse");
    assert.equal(replay.content[0]?.type, "toolCall");
    assert.equal(await readFile(join(root, "invocations"), "utf8"), "1");
  });
});

await test("malformed artifacts and invalid objectives block before invocation", async () => {
  await withFixture("blocked", async (root, config) => {
    setEnvironment({ PI_WORKGRAPH_CHATGPT_WEB_CLIENT: join(root, "missing.py") });
    const setupFailure = await runProvider(config, objectiveMessages());
    assert.equal(setupFailure.stopReason, "error");
    assert.match(setupFailure.errorMessage ?? "", /before submission/);
    assert.equal(await readFile(join(root, "invocations"), "utf8"), "0");
    setEnvironment({ PI_WORKGRAPH_CHATGPT_WEB_CLIENT: join(root, "fake-consult.py") });

    const artifact = chatGPTWebArtifactPath("run-blocked", "node-blocked");
    await mkdir(artifact, { recursive: true, mode: 0o700 });
    await writeFile(join(artifact, "status.json"), JSON.stringify({ state: "completed" }));
    await writeFile(join(artifact, "answer.md"), "answer\n");
    const malformed = await runProvider(config, objectiveMessages());
    assert.equal(malformed.stopReason, "error");
    assert.match(malformed.errorMessage ?? "", /retained artifact/);
    assert.equal(await readFile(join(root, "invocations"), "utf8"), "0");

    for (const [input, pattern] of [
      ["[WORKGRAPH RESEARCH OBJECTIVE]", /empty/],
      [`[WORKGRAPH RESEARCH OBJECTIVE]\n${"x".repeat(RESEARCH_OBJECTIVE_MAX_BYTES)}`, /400 KiB/],
      ["unrelated", /Missing/],
    ] as const)
      assert.throws(
        () => extractResearchObjective([{ role: "user", content: input, timestamp: 1 }]),
        pattern,
      );
  });
});

await test("explicit Workgraph research mode is required before invocation", async () => {
  await withFixture("routing", async (root, config) => {
    setEnvironment({ PI_WORKGRAPH_MODE: "implementation" });
    const result = await runProvider(config, objectiveMessages());
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /research/);
    assert.equal(await readFile(join(root, "invocations"), "utf8"), "0");
  });
});

await test("kernel flock rejects an overlapping call without uncertain submission", async () => {
  await withFixture("lock", async (root, config) => {
    const controller = new AbortController();
    const owner = runProvider(config, objectiveMessages(`${objective} LOCK`), controller.signal);
    await waitForInvocation(root, "1");
    setEnvironment({ PI_WORKGRAPH_RUN_ID: "run-lock-contender" });
    const contender = await runProvider(config, objectiveMessages(`${objective} LOCK`));
    assert.equal(contender.stopReason, "error");
    assert.match(contender.errorMessage ?? "", /in progress/);
    assert.doesNotMatch(contender.errorMessage ?? "", /uncertain/);
    assert.equal(await readFile(join(root, "invocations"), "utf8"), "1");
    controller.abort();
    assert.equal((await owner).stopReason, "aborted");
  });
});

await test("nonzero and aborted calls retain uncertainty and never resubmit", async () => {
  await withFixture("uncertain", async (root, config) => {
    const failed = await runProvider(config, objectiveMessages(`${objective} FAIL`));
    assert.equal(failed.stopReason, "error");
    assert.match(failed.errorMessage ?? "", /uncertain/);
    assert.equal(
      (await runProvider(config, objectiveMessages(`${objective} FAIL`))).stopReason,
      "error",
    );
    assert.equal(await readFile(join(root, "invocations"), "utf8"), "1");

    setEnvironment({ PI_WORKGRAPH_RUN_ID: "run-abort" });
    const controller = new AbortController();
    const pending = runProvider(config, objectiveMessages(`${objective} ABORT`), controller.signal);
    await waitForInvocation(root, "2");
    await setTimer(100);
    controller.abort();
    const aborted = await pending;
    assert.equal(aborted.stopReason, "aborted");
    assert.match(aborted.errorMessage ?? "", /artifact/);
    assert.equal(
      (await runProvider(config, objectiveMessages(`${objective} ABORT`))).stopReason,
      "error",
    );
    assert.equal(await readFile(join(root, "invocations"), "utf8"), "2");
  });
});
