import assert from "node:assert/strict";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- These regressions exercise real artifact bytes, modes, links, and interruption cleanup.
import * as artifactFs from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Retained artifact path assertions use host path semantics.
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { Effect, Fiber, FileSystem, Layer, Path } from "effect";
import { ArtifactIoError, ArtifactStore, type ArtifactStoreError } from "../src/artifact-store.js";
import { liveLayer } from "../src/node-platform.js";
import { artifactFixture, transformArtifactStore } from "./artifact-fixture.js";

function testFailure(message: string): ArtifactIoError {
  return new ArtifactIoError({
    operation: "injected artifact test boundary",
    path: "artifact fixture",
    cause: new Error(message),
  });
}

function failAfterRetain(
  action: (reference: string) => Effect.Effect<void, ArtifactStoreError> = () => Effect.void,
): Layer.Layer<ArtifactStore> {
  let fail = true;
  return transformArtifactStore((store) => ({
    ...store,
    retain: (input, guard) =>
      store.retain(input, guard).pipe(
        Effect.tap((artifact) => (fail ? action(artifact.reference) : Effect.void)),
        Effect.flatMap((artifact) => {
          if (!fail) return Effect.succeed(artifact);
          fail = false;
          return new ArtifactIoError({
            operation: "lose artifact service response",
            path: artifact.reference,
            cause: new Error("artifact service response lost"),
          });
        }),
      ),
  }));
}

function effectWrite(path: string, contents: string): Effect.Effect<void, ArtifactIoError> {
  return Effect.tryPromise({
    try: () => artifactFs.writeFile(path, contents),
    catch: (cause) => new ArtifactIoError({ operation: "write test artifact", path, cause }),
  });
}

void test("reconciliation resumes a settled retry immediately after its pending checkpoint", async () => {
  const f = await artifactFixture();
  try {
    const before = await f.store.load();
    const originalReport = structuredClone(before.results[0]);
    await f.store.blockArtifactRetention(f.attemptId, "simulated first interruption");
    await f.store.retryArtifactRetention(f.attemptId);

    const runtime = f.runtime();
    const recovered = await runtime.reconcile();
    const attempt = recovered.attempts[0];
    const result = recovered.results[0];
    assert.equal(attempt?.artifactRetention?.state, "completed");
    assert.equal(attempt?.cleanup?.state, "completed");
    assert.deepEqual({ ...result, artifacts: [] }, originalReport);
    assert.equal(
      await artifactFs.readFile(result?.artifacts[0]?.reference ?? "", "utf8"),
      "retained evidence\n",
    );
    assert.equal(f.workers.cleanupCount, 1);
  } finally {
    await f.dispose();
  }
});

void test("owned partial staging from an interrupted operation is quarantined and rebuilt", async () => {
  const f = await artifactFixture();
  try {
    let partialPath = "";
    const interrupted = failAfterRetain((reference) => {
      partialPath = reference;
      return effectWrite(reference, "partial\n");
    });
    const first = f.runtime(interrupted);
    let state = await first.reconcile();
    assert.equal(state.attempts[0]?.artifactRetention?.state, "blocked");
    assert.equal(await artifactFs.readFile(partialPath, "utf8"), "partial\n");
    await first.stop();

    const retry = f.runtime();
    state = await retry.recoverAttempt({
      attemptId: f.attemptId,
      action: "retry",
      reason: "Rebuild the exact runtime-owned partial staging payload.",
    });
    assert.equal(state.attempts[0]?.artifactRetention?.state, "completed");
    const stagingRoot = state.attempts[0]?.artifactRetention?.stagingRoot ?? "";
    assert.equal(
      (await artifactFs.readdir(stagingRoot)).some((name) => name.includes(".quarantine-")),
      true,
    );
    assert.equal(
      await artifactFs.readFile(state.results[0]?.artifacts[0]?.reference ?? "", "utf8"),
      "retained evidence\n",
    );
  } finally {
    await f.dispose();
  }
});

void test("a complete owned payload reconciles without a second copy after its response is lost", async () => {
  const f = await artifactFixture();
  try {
    const first = f.runtime(failAfterRetain());
    let state = await first.reconcile();
    assert.equal(state.attempts[0]?.artifactRetention?.state, "blocked");
    const stagingRoot = state.attempts[0]?.artifactRetention?.stagingRoot ?? "";
    const payload = (await artifactFs.readdir(stagingRoot)).find((name) =>
      name.endsWith(".payload"),
    );
    if (payload === undefined) assert.fail("Owned payload was not created.");
    const retainedPath = join(stagingRoot, payload, "probe.txt");
    const before = await artifactFs.lstat(retainedPath);
    await first.stop();

    const retry = f.runtime();
    state = await retry.recoverAttempt({
      attemptId: f.attemptId,
      action: "retry",
      reason: "Reconcile the complete marker-owned payload without copying it again.",
    });
    assert.equal(state.attempts[0]?.artifactRetention?.state, "completed");
    assert.equal(state.results[0]?.artifacts[0]?.reference, retainedPath);
    assert.equal((await artifactFs.lstat(retainedPath)).ino, before.ino);
    assert.equal(
      await artifactFs.readFile(state.results[0]?.artifacts[0]?.reference ?? "", "utf8"),
      "retained evidence\n",
    );

    state = await retry.reconcile();
    assert.equal(state.attempts[0]?.artifactRetention?.state, "completed");
    assert.equal(
      (await artifactFs.readdir(stagingRoot)).filter((name) => name.endsWith(".payload")).length,
      1,
    );
  } finally {
    await f.dispose();
  }
});

void test("foreign markers, unproven payloads, and symlink payloads are preserved", async () => {
  for (const unsafe of ["unproven", "foreign-marker", "symlink"] as const) {
    const f = await artifactFixture();
    try {
      let staged = "";
      const first = f.runtime(
        failAfterRetain((reference) => {
          staged = reference;
          return effectWrite(reference, "partial without durable completion\n");
        }),
      );
      let state = await first.reconcile();
      await first.stop();
      const stagingRoot = state.attempts[0]?.artifactRetention?.stagingRoot ?? "";
      const marker = (await artifactFs.readdir(stagingRoot)).find((name) =>
        name.endsWith(".owner.json"),
      );
      if (marker === undefined) assert.fail("Ownership marker was not created.");
      const markerPath = join(stagingRoot, marker);
      if (unsafe === "unproven") await artifactFs.unlink(markerPath);
      if (unsafe === "foreign-marker")
        await artifactFs.writeFile(markerPath, "foreign ownership\n");
      if (unsafe === "symlink") {
        await artifactFs.unlink(staged);
        await artifactFs.symlink(join(f.sourceRoot, "probe.txt"), staged);
      }

      const retry = f.runtime();
      await retry.recoverAttempt({
        attemptId: f.attemptId,
        action: "retry",
        reason: "Unsafe or foreign staging must remain untouched.",
      });
      state = await f.store.load();
      assert.equal(state.attempts[0]?.artifactRetention?.state, "blocked");
      if (unsafe === "symlink")
        assert.equal((await artifactFs.lstat(staged)).isSymbolicLink(), true);
      else
        assert.equal(
          await artifactFs.readFile(staged, "utf8"),
          "partial without durable completion\n",
        );
      if (unsafe === "foreign-marker")
        assert.equal(await artifactFs.readFile(markerPath, "utf8"), "foreign ownership\n");
    } finally {
      await f.dispose();
    }
  }
});

void test("foreign destination bytes are never overwritten or published", async () => {
  const f = await artifactFixture();
  try {
    let foreignTarget = "";
    const layer = transformArtifactStore((store) => ({
      ...store,
      retain: (input, guard) =>
        store.retain(input, guard).pipe(
          Effect.tap((artifact) =>
            Effect.tryPromise({
              try: async () => {
                const state = await f.store.load();
                const destination = state.attempts[0]?.artifactRetention?.destinationRoot ?? "";
                await artifactFs.mkdir(destination, { recursive: true });
                foreignTarget = join(destination, "probe.txt");
                await artifactFs.writeFile(foreignTarget, "foreign bytes\n");
              },
              catch: (cause) =>
                new ArtifactIoError({
                  operation: "create foreign destination fixture",
                  path: artifact.reference,
                  cause,
                }),
            }),
          ),
        ),
    }));
    const runtime = f.runtime(layer);
    const state = await runtime.reconcile();
    const artifact = state.results[0]?.artifacts[0];
    assert.equal(state.attempts[0]?.artifactRetention?.state, "completed");
    assert.ok(artifact);
    assert.notEqual(artifact.reference, foreignTarget);
    assert.match(artifact.reference, /artifact-staging/);
    assert.equal(await artifactFs.readFile(artifact.reference, "utf8"), "retained evidence\n");
    assert.equal(await artifactFs.readFile(foreignTarget, "utf8"), "foreign bytes\n");
  } finally {
    await f.dispose();
  }
});

void test("file and nested directory payloads publish atomically after a lost state response", async () => {
  for (const kind of ["file", "directory"] as const) {
    const f = await artifactFixture();
    try {
      const source = join(f.sourceRoot, "probe.txt");
      if (kind === "directory") {
        await artifactFs.unlink(source);
        await artifactFs.mkdir(source);
        let nested = source;
        for (let index = 0; index < 24; index++) {
          nested = join(nested, `level-${index}`);
          await artifactFs.mkdir(nested);
        }
        await artifactFs.writeFile(join(nested, "evidence.txt"), "directory evidence\n");
      }

      const finish = f.store.finishArtifactRetention.bind(f.store);
      let loseResponse = true;
      f.store.finishArtifactRetention = (...input) =>
        finish(...input).then((state) => {
          if (loseResponse) {
            loseResponse = false;
            throw new Error("checkpoint response lost after atomic state replacement");
          }
          return state;
        });

      const first = f.runtime();
      await first.reconcile();
      assert.equal(loseResponse, false);
      let state = await f.store.load();
      const retention = state.attempts[0]?.artifactRetention;
      const artifact = state.results[0]?.artifacts[0];
      assert.equal(retention?.state, "completed");
      assert.ok(artifact);
      assert.equal(basename(artifact.reference), "probe.txt");
      await assert.rejects(
        artifactFs.readFile(join(retention?.destinationRoot ?? "", "probe.txt")),
        /ENOENT/,
      );
      if (kind === "file")
        assert.equal(await artifactFs.readFile(artifact.reference, "utf8"), "retained evidence\n");
      else {
        let nested = artifact.reference;
        for (let index = 0; index < 24; index++) nested = join(nested, `level-${index}`);
        assert.equal(
          await artifactFs.readFile(join(nested, "evidence.txt"), "utf8"),
          "directory evidence\n",
        );
      }

      await first.stop();
      const retry = f.runtime();
      state = await retry.reconcile();
      assert.equal(state.attempts[0]?.artifactRetention?.state, "completed");
      assert.equal(state.attempts[0]?.cleanup?.state, "completed");
      assert.equal(state.results[0]?.artifacts[0]?.reference, artifact.reference);
      assert.equal(
        (await artifactFs.readdir(retention?.stagingRoot ?? "")).filter((name) =>
          name.endsWith(".payload"),
        ).length,
        1,
      );
    } finally {
      await f.dispose();
    }
  }
});

void test("retained containers and regular files are private under permissive modes and umask", async () => {
  const previousUmask = process.umask(0);
  const f = await artifactFixture();
  try {
    const source = join(f.sourceRoot, "probe.txt");
    await artifactFs.unlink(source);
    await artifactFs.mkdir(source, { mode: 0o777 });
    const nested = join(source, "open-source");
    await artifactFs.mkdir(nested, { mode: 0o777 });
    const file = join(nested, "evidence.txt");
    await artifactFs.writeFile(file, "private retained evidence\n", { mode: 0o666 });
    await artifactFs.chmod(source, 0o777);
    await artifactFs.chmod(nested, 0o777);
    await artifactFs.chmod(file, 0o666);

    const runtime = f.runtime();
    const state = await runtime.reconcile();
    const reference = state.results[0]?.artifacts[0]?.reference ?? "";
    const stagingRoot = state.attempts[0]?.artifactRetention?.stagingRoot ?? "";
    const payloadRoot = dirname(reference);
    for (const directory of [stagingRoot, payloadRoot, reference, join(reference, "open-source")])
      assert.equal((await artifactFs.lstat(directory)).mode & 0o777, 0o700, directory);
    assert.equal(
      (await artifactFs.lstat(join(reference, "open-source", "evidence.txt"))).mode & 0o777,
      0o600,
    );
    for (const marker of (await artifactFs.readdir(stagingRoot)).filter((name) =>
      name.endsWith(".owner.json"),
    ))
      assert.equal((await artifactFs.lstat(join(stagingRoot, marker))).mode & 0o777, 0o600);
  } finally {
    process.umask(previousUmask);
    await f.dispose();
  }
});

void test("large streamed interruption releases the scoped source handle", async () => {
  const f = await artifactFixture();
  let activeHandles = 0;
  try {
    const source = join(f.sourceRoot, "probe.txt");
    const handle = await artifactFs.open(source, "w");
    try {
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      for (let index = 0; index < 128; index++) await handle.write(chunk);
    } finally {
      await handle.close();
    }
    const state = await f.store.load();
    const retention = state.attempts[0]?.artifactRetention;
    assert.ok(retention);

    const trackingFileSystem = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        return FileSystem.FileSystem.of({
          ...fileSystem,
          open: (path, options) =>
            Effect.acquireRelease(
              fileSystem.open(path, options).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    activeHandles++;
                  }),
                ),
              ),
              () =>
                Effect.sync(() => {
                  activeHandles--;
                }),
            ).pipe(
              Effect.map(
                (file) =>
                  new Proxy(file, {
                    get(target, property) {
                      if (property === "readAlloc")
                        return (size: FileSystem.SizeInput) =>
                          Effect.sleep("5 millis").pipe(Effect.andThen(target.readAlloc(size)));
                      switch (property) {
                        case FileSystem.FileTypeId:
                          return target[FileSystem.FileTypeId];
                        case "stat":
                          return target.stat;
                        case "sync":
                          return target.sync;
                        case "seek":
                          return target.seek.bind(target);
                        case "read":
                          return target.read.bind(target);
                        case "truncate":
                          return target.truncate.bind(target);
                        case "write":
                          return target.write.bind(target);
                        case "writeAll":
                          return target.writeAll.bind(target);
                        default:
                          return undefined;
                      }
                    },
                  }),
              ),
            ),
        });
      }),
    ).pipe(Layer.provide(liveLayer));
    const layer = ArtifactStore.layer.pipe(
      Layer.provide(Layer.merge(trackingFileSystem, Path.layer)),
    );
    const operation = ArtifactStore.use((store) =>
      store.retain({ retention, name: "probe.txt" }, () => Effect.void),
    ).pipe(Effect.provide(layer));
    const fiber = Effect.runFork(operation);
    while (activeHandles === 0) await Effect.runPromise(Effect.sleep("1 millis"));
    await Effect.runPromise(Fiber.interrupt(fiber));
    const exit = await Effect.runPromise(Fiber.await(fiber));
    assert.equal(exit._tag, "Failure");
    assert.equal(activeHandles, 0);

    const stagingRoot = retention.stagingRoot;
    const moved = `${stagingRoot}-after-interrupt`;
    try {
      await artifactFs.rename(stagingRoot, moved);
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    }
  } finally {
    await f.dispose();
  }
});

void test("intent and lease loss after byte retention fence state publication", async () => {
  const stale = await artifactFixture();
  try {
    const input = (await stale.store.load()).inputs[0];
    assert.ok(input);
    const layer = transformArtifactStore((store) => ({
      ...store,
      retain: (artifact, guard) =>
        store.retain(artifact, guard).pipe(
          Effect.tap(() =>
            Effect.tryPromise({
              try: () =>
                stale.store.reviseIntent({
                  authorityReceiptId: input.id,
                  statement: "Supersede the probe before publication.",
                  constraints: ["Do not publish the old probe."],
                }),
              catch: () => testFailure("could not supersede intent"),
            }),
          ),
        ),
    }));
    const runtime = stale.runtime(layer);
    await runtime.reconcile();
    const state = await stale.store.load();
    const retention = state.attempts[0]?.artifactRetention;
    assert.equal(retention?.state, "blocked");
    await assert.rejects(
      artifactFs.readFile(join(retention?.destinationRoot ?? "", "probe.txt")),
      /ENOENT/,
    );
  } finally {
    await stale.dispose();
  }

  const lostLease = await artifactFixture();
  try {
    const layer = transformArtifactStore((store) => ({
      ...store,
      retain: (artifact, guard) =>
        store.retain(artifact, guard).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              lostLease.registry.db
                .prepare("DELETE FROM leases WHERE run_id=?")
                .run("artifact-recovery");
            }),
          ),
        ),
    }));
    const runtime = lostLease.runtime(layer);
    await assert.rejects(runtime.reconcile(), /lease|owner/i);
    const state = await lostLease.store.load();
    const retention = state.attempts[0]?.artifactRetention;
    assert.equal(retention?.state, "pending");
    await assert.rejects(
      artifactFs.readFile(join(retention?.destinationRoot ?? "", "probe.txt")),
      /ENOENT/,
    );
  } finally {
    await lostLease.dispose();
  }
});

void test("legacy pending and blocked cleanup preserve ignored required output and report history", async () => {
  for (const cleanupState of ["pending", "blocked"] as const) {
    const f = await artifactFixture({ legacyCleanup: cleanupState });
    try {
      const before = await f.store.load();
      const result = structuredClone(before.results[0]);
      const history = structuredClone(before.attempts[0]?.attentionHistory);
      const runtime = f.runtime();
      await assert.rejects(
        runtime.recoverAttempt({
          attemptId: f.attemptId,
          action: "retry",
          reason: "Legacy evidence cannot be reconstructed.",
        }),
        /no independently retained report and source checkpoint/,
      );
      if (cleanupState === "pending") {
        await assert.rejects(
          runtime.perform(() => f.store.markWorkerClosed(f.attemptId)),
          /no independently retained report and source checkpoint/,
        );
        await runtime.reconcile();
      } else {
        await assert.rejects(
          runtime.perform(() => f.store.retryCleanup(f.attemptId)),
          /no independently retained report and source checkpoint/,
        );
      }
      const after = await f.store.load();
      assert.deepEqual(after.results[0], result);
      assert.deepEqual(after.attempts[0]?.attentionHistory, history);
      assert.equal(after.attempts[0]?.cleanup?.state, cleanupState);
      assert.equal(
        await artifactFs.readFile(join(f.sourceRoot, "probe.txt"), "utf8"),
        "retained evidence\n",
      );
      assert.equal(await f.repository.status(f.sourceRoot), "");
      assert.equal(f.workers.cleanupCount, 0);
    } finally {
      await f.dispose();
    }
  }
});
