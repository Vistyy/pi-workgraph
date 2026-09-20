import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  deliveryLoaderName,
  installDeliveryTools,
  loadDeferredDeliveryTools,
} from "../../src/coordinator/delivery-tools.js";
import { extensionFixture } from "../support/helpers.js";

const peerTools: InlineExtension = (pi: ExtensionAPI) => {
  for (const name of ["peer_review", "peer_follow", "unrelated"]) {
    pi.registerTool({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: () =>
        Promise.resolve({ content: [{ type: "text" as const, text: name }], details: undefined }),
    });
  }
};

async function fixture(configured: readonly string[]) {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-delivery-tools-"));
  const root = join(parent, "repo");
  await mkdir(root);
  const delivery: InlineExtension = (pi) => installDeliveryTools(pi, configured);

  let active = [
    "peer_review",
    "peer_follow",
    "unrelated",
    ...(configured.length > 0 ? [deliveryLoaderName] : []),
  ];

  const all = [...active];

  const f = await extensionFixture(
    "coordinator",
    root,
    parent,
    {
      getActiveTools: () => [...active],
      setActiveTools: (names) => {
        active = [...names];
      },
      getAllTools: () =>
        all.map((name) => ({
          name,
          description: name,
          parameters: Type.Object({}, { additionalProperties: false }),
          sourceInfo: {
            path: "fixture",
            source: "fixture",
            scope: "temporary" as const,
            origin: "top-level" as const,
          },
        })),
    },
    [peerTools, delivery],
  );

  return {
    ...f,
    parent,
    activeTools: () => [...active],
    async dispose() {
      await f.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

void test("delivery settings are explicit, strict, and deduplicated", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph-delivery-settings-"));
  const path = join(parent, "settings.json");

  try {
    assert.deepEqual(loadDeferredDeliveryTools(path), []);
    await writeFile(path, JSON.stringify({ other: true }));
    assert.deepEqual(loadDeferredDeliveryTools(path), []);
    await writeFile(
      path,
      JSON.stringify({
        "pi-workgraph": {
          delivery: { deferredTools: ["peer_review", "peer_review", "peer_follow"] },
        },
      }),
    );
    assert.deepEqual(loadDeferredDeliveryTools(path), ["peer_review", "peer_follow"]);

    for (const invalid of [
      "{",
      JSON.stringify({ "pi-workgraph": { delivery: {} } }),
      JSON.stringify({ "pi-workgraph": { delivery: { deferredTools: "peer_review" } } }),
      JSON.stringify({ "pi-workgraph": { delivery: { deferredTools: [" "] } } }),
      JSON.stringify({
        "pi-workgraph": { delivery: { deferredTools: [], unexpected: true } },
      }),
    ]) {
      await writeFile(path, invalid);
      assert.throws(() => loadDeferredDeliveryTools(path), /Invalid/);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("loader defers only configured tools and restores visibility from its branch result", async () => {
  const f = await fixture(["peer_review", "peer_review", "missing_peer"]);

  try {
    const loader = f.runner.getToolDefinition(deliveryLoaderName);
    assert.ok(loader !== undefined);
    assert.equal(Value.Check(loader.parameters, {}), true);
    assert.equal(Value.Check(loader.parameters, { extra: true }), false);

    await f.runner.emit({ type: "session_start", reason: "startup" });
    assert.deepEqual(f.activeTools().sort(), ["peer_follow", "unrelated", deliveryLoaderName]);
    const beforeMarker = f.session.getLeafId();
    assert.ok(beforeMarker !== null);

    const first = await f.call(deliveryLoaderName, {});
    assert.deepEqual(first.details, {
      loaded: ["peer_review"],
      alreadyActive: [],
      missing: ["missing_peer"],
    });
    assert.deepEqual(f.activeTools().sort(), [
      "peer_follow",
      "peer_review",
      "unrelated",
      deliveryLoaderName,
    ]);

    const second = await f.call(deliveryLoaderName, {});
    assert.deepEqual(second.details, {
      loaded: [],
      alreadyActive: ["peer_review"],
      missing: ["missing_peer"],
    });

    const marker = f.session.appendMessage({
      role: "toolResult",
      toolCallId: "load-delivery",
      toolName: deliveryLoaderName,
      content: first.content,
      details: first.details,
      isError: false,
      timestamp: 0,
    });

    await f.runner.emit({ type: "session_tree", oldLeafId: beforeMarker, newLeafId: marker });
    assert.equal(f.activeTools().includes("peer_review"), true);
    await f.runner.emit({ type: "session_start", reason: "reload" });
    await f.runner.emit({
      type: "session_start",
      reason: "fork",
      previousSessionFile: "parent.jsonl",
    });
    assert.equal(f.activeTools().includes("peer_review"), true);

    f.session.branch(beforeMarker);
    await f.runner.emit({ type: "session_tree", oldLeafId: marker, newLeafId: beforeMarker });
    assert.equal(f.activeTools().includes("peer_review"), false);
    assert.equal(f.activeTools().includes("peer_follow"), true);
    await f.runner.emit({
      type: "session_start",
      reason: "resume",
      previousSessionFile: "other.jsonl",
    });
    assert.equal(f.activeTools().includes("peer_review"), false);

    f.session.branch(marker);
    await f.runner.emit({ type: "session_tree", oldLeafId: beforeMarker, newLeafId: marker });
    assert.equal(f.activeTools().includes("peer_review"), true);
    assert.equal(f.activeTools().includes(deliveryLoaderName), true);
  } finally {
    await f.dispose();
  }
});

void test("empty configuration registers no loader and changes no peer visibility", async () => {
  const f = await fixture([]);

  try {
    await f.runner.emit({ type: "session_start", reason: "startup" });
    assert.equal(f.runner.getToolDefinition(deliveryLoaderName), undefined);
    assert.deepEqual(f.activeTools().sort(), ["peer_follow", "peer_review", "unrelated"]);
  } finally {
    await f.dispose();
  }
});
