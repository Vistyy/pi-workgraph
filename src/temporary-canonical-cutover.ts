/* oxlint-disable effecttsgo/async-function, effecttsgo/any-unknown-in-error-context -- TEMPORARY cutover adapter is the sole Pi Promise/session facade over the v7 Effect workflow. */
// TEMPORARY: remove this complete module after the inspected v7 cutover and the
// final controlled reload have succeeded.
// Temporary-removal inventory: this complete module; src/temporary-v7-migration.ts;
// test/temporary-v7-migration.test.ts; the cutover bootstrap, retained-state
// startup diagnostic gate, positive attachment notice, and /workgraph-reload
// command plus their cases in extensions/canonical-coordinator.ts and
// test/canonical-coordinator.test.ts; CanonicalCoordinatorController
// temporaryBlockEstablishment and temporaryCloseForReload;
// CanonicalWorkstreamStore.importStaging and validateMigrationStaging plus its
// MIGRATION_TEMP_SUFFIX/isMigrationStagingPath helpers; and the predecessor
// extension/source/tests after post-attachment inspection authorizes deletion.
// Package canonical registration and canonical package-smoke/worker-cache references
// survive cutover; remove the temporary workgraph_reload tool-absence and
// workgraph-reload command-registration assertions. There are no temporary config
// additions to remove.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Clock, Data, DateTime, Effect } from "effect";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  CANONICAL_POINTER_ENTRY,
  type CanonicalCoordinatorController,
  type CanonicalPointerRestoration,
  type CanonicalWorkstreamPointer,
  CanonicalWorkstreamPointerSchema,
} from "./canonical-coordinator-controller.js";
import { inspectRepository } from "./git.js";
import {
  confirmCommittedV7Migration,
  declareV7MigrationSource,
  recoverV7Migration,
  V7_MIGRATION_BREADCRUMB_ENTRY,
  type V7MigrationBreadcrumb,
  type V7MigrationBreadcrumbPort,
  V7MigrationBreadcrumbSchema,
  type V7MigrationDeclaration,
  validateV7MigrationOwner,
} from "./temporary-v7-migration.js";

export const PREDECESSOR_POINTER_ENTRY = "pi-workgraph-workstream";

const PredecessorPointerSchema = Type.Object(
  { path: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

class TemporaryCutoverError extends Data.TaggedError("TemporaryCutoverError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface TemporaryCutoverBootstrap {
  readonly restoration: CanonicalPointerRestoration;
  readonly cutover: boolean;
}

export function temporaryCutoverBootstrap(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  controller: CanonicalCoordinatorController,
  ordinaryRestoration: () => CanonicalPointerRestoration,
): Effect.Effect<
  TemporaryCutoverBootstrap,
  unknown,
  import("effect").FileSystem.FileSystem | import("effect").Path.Path | import("effect").Scope.Scope
> {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: temporary bootstrap enumerates every retained-record state before allowing restore.
  return Effect.gen(function* () {
    const branch = ctx.sessionManager.getBranch();
    const predecessorEntries = branch.filter(
      (entry) => entry.type === "custom" && entry.customType === PREDECESSOR_POINTER_ENTRY,
    );
    const breadcrumbEntries = branch.filter(
      (entry) => entry.type === "custom" && entry.customType === V7_MIGRATION_BREADCRUMB_ENTRY,
    );
    if (predecessorEntries.length === 0) {
      if (breadcrumbEntries.length !== 0)
        return yield* cutoverError("Migration breadcrumbs have no retained predecessor pointer.");
      return { restoration: ordinaryRestoration(), cutover: false };
    }
    if (predecessorEntries.length !== 1)
      return yield* cutoverError("Cutover requires exactly one retained predecessor pointer.");
    const predecessor = predecessorEntries[0];
    if (predecessor?.type !== "custom" || !Value.Check(PredecessorPointerSchema, predecessor.data))
      return yield* cutoverError("Retained predecessor pointer is malformed.");
    const sourcePath = Value.Decode(PredecessorPointerSchema, predecessor.data).path;
    const port = piBreadcrumbPort(pi, ctx);
    const breadcrumbs = yield* readPort(port);
    const owner = controller.owner(ctx);
    const declaration =
      breadcrumbs.length === 0
        ? yield* declareV7MigrationSource(sourcePath, owner)
        : declarationFromBreadcrumbs(sourcePath, breadcrumbs);
    yield* validateV7MigrationOwner(declaration, owner);
    yield* proveRepository(declaration);

    const retainedCanonical = exactCutoverCanonicalPointer(ctx);
    if (retainedCanonical !== undefined) {
      yield* confirmCommittedV7Migration(declaration, port);
      requirePointerTarget(retainedCanonical, declaration, sourcePath);
      return { restoration: retainedCanonical, cutover: true };
    }

    const now = yield* Clock.currentTimeMillis;
    const recordedAt = DateTime.formatIso(DateTime.makeUnsafe(now));
    const committed = yield* recoverV7Migration(declaration, port, recordedAt);
    if (committed.phase !== "committed")
      return yield* cutoverError("v7 migration did not reach its committed record.");
    const attached: Extract<CanonicalWorkstreamPointer, { phase: "attached" }> = {
      version: 1,
      phase: "attached",
      path: committed.paths.target,
      workstreamId: committed.declaration.workstreamId,
      repository: structuredClone(committed.declaration.repository),
    };
    yield* appendCanonicalPointer(pi, ctx, attached);
    return { restoration: attached, cutover: true };
  });
}

export function temporaryReloadPointer(
  ctx: ExtensionContext,
  controller: CanonicalCoordinatorController,
): Effect.Effect<Extract<CanonicalWorkstreamPointer, { phase: "attached" }>, unknown> {
  return Effect.gen(function* () {
    const predecessors = ctx.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === PREDECESSOR_POINTER_ENTRY);
    if (predecessors.length !== 1)
      return yield* cutoverError(
        "Controlled reload requires the exact retained predecessor pointer.",
      );
    const predecessor = predecessors[0];
    if (predecessor?.type !== "custom" || !Value.Check(PredecessorPointerSchema, predecessor.data))
      return yield* cutoverError("Controlled reload predecessor pointer is malformed.");
    const sourcePath = Value.Decode(PredecessorPointerSchema, predecessor.data).path;
    const port = readOnlyBreadcrumbPort(ctx);
    const records = yield* readPort(port);
    const declaration = declarationFromBreadcrumbs(sourcePath, records);
    requireCommittedRecordHistory(records);
    yield* validateV7MigrationOwner(declaration, controller.owner(ctx));
    const pointer = exactCutoverCanonicalPointer(ctx);
    if (pointer?.phase !== "attached")
      return yield* cutoverError("Controlled reload has no exact current attached pointer.");
    requirePointerTarget(pointer, declaration, sourcePath);
    return pointer;
  });
}

function exactCutoverCanonicalPointer(
  ctx: ExtensionContext,
): CanonicalWorkstreamPointer | undefined {
  const entries = ctx.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === CANONICAL_POINTER_ENTRY);
  if (entries.length === 0) return undefined;
  const pointers = entries.map((entry) => {
    if (entry.type !== "custom" || !Value.Check(CanonicalWorkstreamPointerSchema, entry.data))
      throw cutoverError("Canonical cutover pointer history is malformed.");
    return Value.Decode(CanonicalWorkstreamPointerSchema, entry.data);
  });
  const attached = pointers[0];
  if (attached?.phase !== "attached")
    throw cutoverError("Canonical cutover pointer history must begin with migration attachment.");
  for (const pointer of pointers) {
    if (!samePointerTarget(pointer, attached))
      throw cutoverError("Canonical cutover pointer history contains conflicting targets.");
  }
  return pointers.at(-1);
}

function samePointerTarget(
  left: CanonicalWorkstreamPointer,
  right: CanonicalWorkstreamPointer,
): boolean {
  return (
    left.path === right.path &&
    left.workstreamId === right.workstreamId &&
    Value.Equal(left.repository, right.repository)
  );
}

function piBreadcrumbPort(pi: ExtensionAPI, ctx: ExtensionContext): V7MigrationBreadcrumbPort {
  const read = () => readBreadcrumbs(ctx);
  return {
    read,
    append: async (record) => {
      pi.appendEntry(V7_MIGRATION_BREADCRUMB_ENTRY, structuredClone(record));
      const retained = await read();
      requireSingleMigrationIdentity(record.paths.source, retained);
      const matches = retained.filter((item) => Value.Equal(item, record));
      if (matches.length !== 1)
        throw cutoverError(`Pi did not confirm exactly one ${record.phase} migration breadcrumb.`);
    },
  };
}

function readOnlyBreadcrumbPort(ctx: ExtensionContext): V7MigrationBreadcrumbPort {
  return {
    read: () => readBreadcrumbs(ctx),
    append: async () => {
      throw cutoverError("Controlled reload cannot append migration breadcrumbs.");
    },
  };
}

async function readBreadcrumbs(ctx: ExtensionContext): Promise<readonly V7MigrationBreadcrumb[]> {
  const entries = ctx.sessionManager
    .getBranch()
    .filter(
      (entry) => entry.type === "custom" && entry.customType === V7_MIGRATION_BREADCRUMB_ENTRY,
    );
  return entries.map((entry) => {
    if (entry.type !== "custom" || !Value.Check(V7MigrationBreadcrumbSchema, entry.data))
      throw cutoverError("Pi branch contains a malformed v7 migration breadcrumb.");
    return Value.Decode(V7MigrationBreadcrumbSchema, entry.data);
  });
}

function readPort(
  port: V7MigrationBreadcrumbPort,
): Effect.Effect<readonly V7MigrationBreadcrumb[], TemporaryCutoverError> {
  return Effect.tryPromise({
    try: () => port.read(),
    catch: (cause) =>
      cutoverError(`Failed to read retained migration breadcrumbs: ${causeMessage(cause)}`, cause),
  });
}

function declarationFromBreadcrumbs(
  sourcePath: string,
  records: readonly V7MigrationBreadcrumb[],
): V7MigrationDeclaration {
  const first = records[0];
  if (first === undefined) throw cutoverError("Committed cutover history is absent.");
  requireSingleMigrationIdentity(sourcePath, records);
  return structuredClone(first.declaration);
}

function requireSingleMigrationIdentity(
  sourcePath: string,
  records: readonly V7MigrationBreadcrumb[],
): void {
  const first = records[0];
  if (
    first === undefined ||
    records.some(
      (record) =>
        record.paths.source !== sourcePath ||
        record.paths.target !== sourcePath ||
        record.migrationId !== first.migrationId ||
        !Value.Equal(record.declaration, first.declaration) ||
        !Value.Equal(record.paths, first.paths) ||
        record.canonicalStateSha256 !== first.canonicalStateSha256,
    )
  )
    throw cutoverError("Migration breadcrumbs contain multiple or conflicting identities.");
}

function requireCommittedRecordHistory(records: readonly V7MigrationBreadcrumb[]): void {
  const prepared = records[0];
  const committed = records[1];
  if (
    records.length !== 2 ||
    prepared?.phase !== "prepared" ||
    committed?.phase !== "committed" ||
    prepared.migrationId !== committed.migrationId ||
    !Value.Equal(prepared.declaration, committed.declaration) ||
    !Value.Equal(prepared.paths, committed.paths) ||
    prepared.canonicalStateSha256 !== committed.canonicalStateSha256
  )
    throw cutoverError(
      "Controlled reload requires exact prepared then committed migration history.",
    );
}

function requirePointerTarget(
  pointer: CanonicalWorkstreamPointer,
  declaration: V7MigrationDeclaration,
  sourcePath: string,
): void {
  if (
    pointer.path !== sourcePath ||
    pointer.workstreamId !== declaration.workstreamId ||
    !Value.Equal(pointer.repository, declaration.repository)
  )
    throw cutoverError("Canonical pointer conflicts with the committed migration target.");
}

function appendCanonicalPointer(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  pointer: Extract<CanonicalWorkstreamPointer, { phase: "attached" }>,
): Effect.Effect<void, TemporaryCutoverError> {
  return Effect.try({
    try: () => {
      if (exactCutoverCanonicalPointer(ctx) !== undefined)
        throw cutoverError("Canonical pointer appeared before its cutover append.");
      pi.appendEntry(CANONICAL_POINTER_ENTRY, structuredClone(pointer));
      const retained = exactCutoverCanonicalPointer(ctx);
      if (retained === undefined || !Value.Equal(retained, pointer))
        throw cutoverError("Pi did not confirm the exact canonical attached pointer.");
    },
    catch: (cause) =>
      cause instanceof TemporaryCutoverError
        ? cause
        : cutoverError("Canonical attached pointer append was not confirmed.", cause),
  });
}

function proveRepository(
  declaration: V7MigrationDeclaration,
): Effect.Effect<
  void,
  unknown,
  import("effect").FileSystem.FileSystem | import("effect").Path.Path
> {
  return Effect.gen(function* () {
    const inspected = yield* inspectRepository(declaration.repository.projectRoot);
    if (
      inspected.root !== declaration.repository.projectRoot ||
      inspected.commonDir !== declaration.repository.gitCommonDir
    )
      return yield* cutoverError("v7 declaration repository identity does not match Git.");
  });
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function cutoverError(message: string, cause?: unknown): TemporaryCutoverError {
  return new TemporaryCutoverError({ message, cause });
}
