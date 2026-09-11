/* oxlint-disable effecttsgo/any-unknown-in-error-context, effecttsgo/global-error-in-effect-failure, typescript/no-this-alias, anti-slop/no-conditional-empty-object-spread, anti-slop/no-runtime-typeof -- The controller composes independently typed canonical/host failures at the single Pi Promise boundary; messages are bounded before presentation, optional properties retain exact external schemas, and the delivery closure must retain its controller owner. */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Clock,
  Data,
  DateTime,
  Effect,
  Exit,
  type FileSystem,
  type Path,
  Scope,
  Semaphore,
} from "effect";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  type CanonicalHostOptions,
  liveCanonicalCommandPorts,
  makeLiveCanonicalReconciliationDriver,
} from "./canonical-host.js";
import {
  type CanonicalActionProjection,
  type CanonicalInspectionRequest,
  type CanonicalInspectionView,
  canonicalOutcomeNotification,
  inspectCanonical,
  projectCanonicalAction,
} from "./canonical-inspection.js";
import { ReconciliationDriverError } from "./canonical-reconciliation.js";
import { CanonicalRuntime, type CanonicalRuntimeOwnership } from "./canonical-runtime.js";
import {
  type CanonicalStoreAttachment,
  CanonicalWorkstreamStore,
} from "./canonical-workstream-store.js";
import type { CanonicalHumanInputReceipt } from "./coordinator-notepad.js";
import {
  type CoordinatorIdentity,
  createWorkstream,
  HerdrDeadObservationSchema,
  type Intent,
  type RepositoryIdentity,
  type Workstream,
  WorkstreamSchema,
} from "./domain/workstream.js";
import { GitRepository, inspectRepository } from "./git.js";
import { HerdrCliRuntime } from "./herdr.js";

export const CANONICAL_POINTER_ENTRY = "pi-workgraph-canonical-workstream";
const CANONICAL_MESSAGE = "pi-workgraph-workstream";
const ATTENTION_MESSAGE = "pi-workgraph-attention";

class CoordinatorHostError extends Data.TaggedError("CoordinatorHostError")<{
  readonly message: string;
}> {}

const NonBlank = Type.String({ pattern: ".*\\S.*" });
const PointerRepositorySchema = Type.Object(
  { projectRoot: NonBlank, gitCommonDir: NonBlank },
  { additionalProperties: false },
);
const PointerOwnerSchema = Type.Object(
  { sessionId: NonBlank, sessionFile: NonBlank },
  { additionalProperties: false },
);
const PointerBase = {
  version: Type.Literal(1),
  path: NonBlank,
  workstreamId: NonBlank,
  repository: PointerRepositorySchema,
};
export const CanonicalWorkstreamPointerSchema = Type.Union([
  Type.Object(
    {
      ...PointerBase,
      phase: Type.Literal("attached"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...PointerBase,
      phase: Type.Literal("prepared"),
      operation: Type.Object(
        { kind: Type.Literal("create"), initial: WorkstreamSchema },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...PointerBase,
      phase: Type.Literal("prepared"),
      operation: Type.Object(
        {
          kind: Type.Literal("recover"),
          expectedOwner: PointerOwnerSchema,
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...PointerBase,
      phase: Type.Literal("prepared"),
      operation: Type.Object(
        {
          kind: Type.Literal("adopt"),
          expectedPriorOwner: PointerOwnerSchema,
          expectedOwner: PointerOwnerSchema,
          expectedRevision: Type.Integer({ minimum: 0 }),
          deathObservation: HerdrDeadObservationSchema,
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);
export type CanonicalWorkstreamPointer = Static<typeof CanonicalWorkstreamPointerSchema>;
export type CanonicalPointerRestoration = CanonicalWorkstreamPointer | "malformed" | undefined;

export interface CanonicalCoordinatorControllerOptions {
  readonly workers?: () => HerdrCliRuntime;
  readonly workspaceId?: string;
  readonly policyPath?: string;
  readonly hostOverrides?: CanonicalHostOptions["overrides"];
}

type Requirements = FileSystem.FileSystem | Path.Path;
type Active = {
  readonly runtime: CanonicalRuntime;
  readonly scope: Scope.Closeable;
  readonly path: string;
  readonly id: string;
  readonly repository: RepositoryIdentity;
  readonly owner: CoordinatorIdentity;
};

export class CanonicalCoordinatorController {
  private active: Active | undefined;
  private pointerBlocked = false;
  private readonly semaphore = Semaphore.makeUnsafe(1);

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly options: CanonicalCoordinatorControllerOptions,
    private readonly publish: (ctx: ExtensionContext, state?: Workstream) => void,
  ) {}

  owner(ctx: ExtensionContext): CoordinatorIdentity {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile === undefined || sessionFile === "")
      throw new Error("Workgraph requires a persistent Pi session.");
    return { sessionId: ctx.sessionManager.getSessionId(), sessionFile };
  }

  serialize<A, E>(effect: Effect.Effect<A, E, Requirements>): Effect.Effect<A, E, Requirements> {
    return this.semaphore.withPermit(effect);
  }

  restore(ctx: ExtensionContext, retained: () => CanonicalPointerRestoration) {
    return this.serialize(
      Effect.gen(
        function* (this: CanonicalCoordinatorController) {
          yield* this.closeOwned(ctx);
          const restoration = retained();
          this.pointerBlocked = restoration !== undefined;
          if (restoration === undefined) return;
          if (restoration === "malformed")
            return yield* Effect.fail(new Error("Canonical Workstream pointer is malformed."));
          const pointer = restoration;
          const owner = this.owner(ctx);
          const { discovered, ownership } = yield* this.prepareRestoration(pointer, owner);
          const next = yield* this.acquire(ctx, discovered, ownership, owner);
          this.active = next;
          if (pointer.phase === "prepared") yield* this.persistPointer(attachedPointer(pointer));
          else this.pointerBlocked = false;
          this.publish(ctx, yield* next.runtime.snapshot());
        }.bind(this),
      ),
    );
  }

  private prepareRestoration(
    pointer: CanonicalWorkstreamPointer,
    owner: CoordinatorIdentity,
  ): Effect.Effect<
    { discovered: CanonicalStoreAttachment; ownership: CanonicalRuntimeOwnership },
    unknown,
    Requirements
  > {
    return Effect.gen(
      function* (this: CanonicalCoordinatorController) {
        if (pointer.phase === "prepared" && pointer.operation.kind === "create") {
          if (
            !pointerMatches(pointer, pointer.operation.initial) ||
            !sameOwner(pointer.operation.initial.coordinator, owner)
          )
            return yield* Effect.fail(new Error("Prepared creation identity changed."));
          yield* this.proveRepository(pointer.operation.initial.repository);
          const discovered = yield* Effect.scoped(
            CanonicalWorkstreamStore.resumeCreate(pointer.operation.initial),
          );
          return { discovered, ownership: { kind: "recover" } as const };
        }
        const discovered = yield* this.discover(pointer.path);
        if (!pointerMatches(pointer, discovered.state))
          return yield* Effect.fail(
            new Error("Canonical pointer identity does not match its aggregate."),
          );
        yield* this.proveRepository(discovered.state.repository);
        if (pointer.phase === "attached") {
          yield* requireExactOwner(discovered.state.coordinator, owner);
          return { discovered, ownership: { kind: "recover" } as const };
        }
        if (pointer.operation.kind === "recover") {
          yield* requireExactOwner(pointer.operation.expectedOwner, owner);
          yield* requireExactOwner(discovered.state.coordinator, owner);
          return { discovered, ownership: { kind: "recover" } as const };
        }
        if (pointer.operation.kind === "adopt")
          return {
            discovered,
            ownership: yield* preparedAdoptionOwnership(discovered.state, pointer.operation, owner),
          };
        return yield* Effect.fail(new Error("Prepared creation pointer was not replayable."));
      }.bind(this),
    );
  }

  establish(
    ctx: ExtensionContext,
    receipt: CanonicalHumanInputReceipt,
    request: { statement: string; constraints: readonly string[]; targetRepository?: string },
  ): Effect.Effect<CanonicalActionProjection, unknown, Requirements> {
    return this.serialize(
      Effect.gen(
        function* (this: CanonicalCoordinatorController) {
          if (this.active !== undefined) {
            const active = this.active;
            if (request.targetRepository !== undefined) {
              const inspected = yield* inspectRepository(request.targetRepository);
              if (
                inspected.root !== active.repository.projectRoot ||
                inspected.commonDir !== active.repository.gitCommonDir
              )
                return yield* Effect.fail(new Error("Intent revision cannot switch repositories."));
            }
            const intent: Intent = {
              statement: request.statement,
              constraints: [...request.constraints],
              grounding: { kind: "human_input_receipt", ...receipt },
              recordedAt: yield* nowIso,
            };
            yield* active.runtime.reviseIntent(intent);
            return yield* projectCanonicalAction(yield* active.runtime.inspectionSnapshot(), {
              action: "workgraph_intent",
            });
          }
          if (this.pointerBlocked)
            return yield* Effect.fail(
              new Error("A retained canonical pointer must be recovered or explicitly adopted."),
            );
          const inspected = yield* inspectRepository(request.targetRepository ?? ctx.cwd);
          const repository = { projectRoot: inspected.root, gitCommonDir: inspected.commonDir };
          const id = `ws-${randomUUID()}`;
          const path = yield* CanonicalWorkstreamStore.pathFor(repository, id);
          const now = yield* nowIso;
          const intent: Intent = {
            statement: request.statement,
            constraints: [...request.constraints],
            grounding: { kind: "human_input_receipt", ...receipt },
            recordedAt: now,
          };
          const initial = createWorkstream({
            id,
            purpose: request.statement,
            repository,
            coordinator: this.owner(ctx),
            intent,
            createdAt: now,
          });
          const pointer: CanonicalWorkstreamPointer = {
            version: 1,
            phase: "prepared",
            path,
            workstreamId: id,
            repository,
            operation: { kind: "create", initial: structuredClone(initial) },
          };
          yield* this.persistPointer(pointer);
          const discovered = yield* Effect.scoped(CanonicalWorkstreamStore.resumeCreate(initial));
          const next = yield* this.acquire(ctx, discovered, { kind: "attach" }, this.owner(ctx));
          this.active = next;
          yield* this.persistPointer(attachedPointer(pointer));
          const state = yield* next.runtime.snapshot();
          this.publish(ctx, state);
          return yield* projectCanonicalAction(yield* next.runtime.inspectionSnapshot(), {
            action: "workgraph_intent",
          });
        }.bind(this),
      ),
    );
  }

  adopt(
    ctx: ExtensionContext,
    statePath: string,
  ): Effect.Effect<CanonicalActionProjection, unknown, Requirements> {
    return this.serialize(
      Effect.gen(
        function* (this: CanonicalCoordinatorController) {
          const discovered = yield* this.discover(statePath);
          yield* this.proveRepository(discovered.state.repository);
          const owner = this.owner(ctx);
          const prior = discovered.state.coordinator;
          let ownership: CanonicalRuntimeOwnership;
          let pointer: CanonicalWorkstreamPointer;
          if (sameOwner(prior, owner)) {
            ownership = { kind: "recover" };
            pointer = {
              version: 1,
              phase: "prepared",
              path: statePath,
              workstreamId: discovered.state.id,
              repository: structuredClone(discovered.state.repository),
              operation: { kind: "recover", expectedOwner: structuredClone(owner) },
            };
          } else {
            const workers = this.options.workers?.() ?? new HerdrCliRuntime();
            const liveness = yield* workers.coordinatorLiveness(prior.sessionFile);
            if (liveness !== "dead")
              return yield* Effect.fail(
                new Error(`Prior coordinator liveness is ${liveness}; adoption requires dead.`),
              );
            const deathObservation = {
              subject: structuredClone(prior),
              observedAt: yield* nowIso,
              source: "herdr_api_snapshot_dead" as const,
            };
            ownership = { kind: "adopt", deathObservation };
            pointer = {
              version: 1,
              phase: "prepared",
              path: statePath,
              workstreamId: discovered.state.id,
              repository: structuredClone(discovered.state.repository),
              operation: {
                kind: "adopt",
                expectedPriorOwner: structuredClone(prior),
                expectedOwner: structuredClone(owner),
                expectedRevision: discovered.state.revision,
                deathObservation,
              },
            };
          }
          yield* this.persistPointer(pointer);
          yield* this.closeOwned(ctx);
          const next = yield* this.acquire(ctx, discovered, ownership, owner);
          this.active = next;
          yield* this.persistPointer(attachedPointer(pointer));
          const state = yield* next.runtime.snapshot();
          this.publish(ctx, state);
          return yield* projectCanonicalAction(yield* next.runtime.inspectionSnapshot(), {
            action: "workgraph_adopt",
          });
        }.bind(this),
      ),
    );
  }

  inspect(
    request: CanonicalInspectionRequest,
  ): Effect.Effect<CanonicalInspectionView, unknown, Requirements> {
    return this.serialize(
      Effect.gen(
        function* (this: CanonicalCoordinatorController) {
          const active = yield* requireActive(this.active);
          const snapshot = yield* active.runtime.inspectionSnapshot();
          return yield* inspectCanonical(snapshot, request);
        }.bind(this),
      ),
    );
  }

  action(
    operation: (runtime: CanonicalRuntime) => Effect.Effect<Workstream, unknown, Requirements>,
    projection: {
      action: string;
      message?: string;
      taskId?: string;
      attemptId?: string;
      outcomeId?: string;
    },
  ): Effect.Effect<CanonicalActionProjection, unknown, Requirements> {
    return this.serialize(
      Effect.gen(
        function* (this: CanonicalCoordinatorController) {
          const active = yield* requireActive(this.active);
          yield* operation(active.runtime);
          return yield* projectCanonicalAction(
            yield* active.runtime.inspectionSnapshot(),
            projection,
          );
        }.bind(this),
      ),
    );
  }

  close(ctx: ExtensionContext): Effect.Effect<void, unknown, Requirements> {
    return this.serialize(this.closeOwned(ctx));
  }

  private discover(path: string): Effect.Effect<CanonicalStoreAttachment, unknown, Requirements> {
    return Effect.scoped(CanonicalWorkstreamStore.discover(path));
  }

  private proveRepository(repository: RepositoryIdentity): Effect.Effect<void, unknown> {
    return Effect.gen(function* () {
      const inspected = yield* inspectRepository(repository.projectRoot);
      if (
        inspected.root !== repository.projectRoot ||
        inspected.commonDir !== repository.gitCommonDir
      )
        return yield* Effect.fail(
          new Error("Canonical aggregate repository identity does not match Git."),
        );
    });
  }

  private acquire(
    ctx: ExtensionContext,
    attachment: CanonicalStoreAttachment,
    ownership: CanonicalRuntimeOwnership,
    owner: CoordinatorIdentity,
  ): Effect.Effect<Active, unknown, Requirements> {
    return Effect.gen(
      function* (this: CanonicalCoordinatorController) {
        const scope = yield* Scope.make("sequential");
        const workers = this.options.workers?.() ?? new HerdrCliRuntime();
        const git = new GitRepository(
          attachment.state.repository.projectRoot,
          attachment.state.repository.gitCommonDir,
        );
        let runtime: CanonicalRuntime | undefined;
        const controller = this;
        const { HERDR_WORKSPACE_ID: hostWorkspaceId, PI_CODING_AGENT_DIR: hostAgentDir } =
          process.env;
        const driver = makeLiveCanonicalReconciliationDriver({
          repository: attachment.state.repository,
          workspaceId: this.options.workspaceId ?? hostWorkspaceId ?? "",
          git,
          workers,
          delivery: {
            deliver: (context) =>
              Effect.gen(function* () {
                const ready = yield* deliveryTry(() => {
                  if (runtime === undefined)
                    throw new Error("Canonical runtime delivery is not ready.");
                  return runtime;
                });
                const snapshotEffect = yield* deliveryTry(() => ready.inspectionSnapshot());
                const snapshot = yield* snapshotEffect.pipe(
                  Effect.mapError(
                    (cause) => new ReconciliationDriverError({ detail: publicMessage(cause) }),
                  ),
                );
                const currentOwner = yield* deliveryTry(() => controller.owner(ctx));
                if (
                  currentOwner.sessionId !== owner.sessionId ||
                  currentOwner.sessionFile !== owner.sessionFile ||
                  !sameOwner(snapshot.workstream.coordinator, owner)
                )
                  return yield* new ReconciliationDriverError({
                    detail: "Coordinator session changed before Outcome delivery.",
                  });
                const outcomeId = yield* deliveryTry(() => {
                  const value = context.attempt.outcome?.id;
                  if (value === undefined) throw new Error("Delivery has no exact Outcome handle.");
                  return value;
                });
                const notificationEffect = yield* deliveryTry(() =>
                  canonicalOutcomeNotification(snapshot, outcomeId),
                );
                const content = yield* notificationEffect.pipe(
                  Effect.mapError(
                    (cause) => new ReconciliationDriverError({ detail: publicMessage(cause) }),
                  ),
                );
                yield* deliveryTry(() =>
                  controller.pi.sendMessage(
                    { customType: CANONICAL_MESSAGE, content, display: true },
                    { triggerTurn: true, deliverAs: "followUp" },
                  ),
                );
              }),
          },
          ...(hostAgentDir === undefined ? {} : { codingAgentDir: hostAgentDir }),
          ...(this.options.hostOverrides === undefined
            ? {}
            : { overrides: this.options.hostOverrides }),
        });
        const acquired = yield* Effect.exit(
          CanonicalRuntime.acquire({
            id: attachment.state.id,
            repository: attachment.state.repository,
            coordinator: owner,
            ownership,
            driver,
            commands: liveCanonicalCommandPorts(git, workers),
            onCommitted: (state) => Effect.sync(() => this.publish(ctx, state)).pipe(Effect.ignore),
            onReconciliationAttention: (detail) => this.attention(ctx, detail),
            onFatal: (error) => this.attention(ctx, publicMessage(error)),
            ...(this.options.policyPath === undefined
              ? {}
              : { policyPath: this.options.policyPath }),
          }).pipe(Scope.provide(scope)),
        );
        if (Exit.isFailure(acquired)) {
          yield* Scope.close(scope, acquired);
          return yield* Effect.failCause(acquired.cause);
        }
        runtime = acquired.value;
        return {
          runtime,
          scope,
          path: attachment.store.path,
          id: attachment.state.id,
          repository: structuredClone(attachment.state.repository),
          owner: structuredClone(owner),
        };
      }.bind(this),
    );
  }

  private attention(ctx: ExtensionContext, detail: string): Effect.Effect<void> {
    const bounded = publicMessage(detail);
    return Effect.gen(
      function* (this: CanonicalCoordinatorController) {
        yield* hostTry(() => ctx.ui.notify(`Workgraph: ${bounded}`, "warning")).pipe(Effect.ignore);
        yield* hostTry(() =>
          this.pi.sendMessage(
            {
              customType: ATTENTION_MESSAGE,
              content: `Workgraph requires attention: ${bounded}. Inspect retained canonical state; this message grants no authority.`,
              display: true,
            },
            { triggerTurn: true, deliverAs: "followUp" },
          ),
        ).pipe(Effect.ignore);
      }.bind(this),
    );
  }

  private closeOwned(ctx: ExtensionContext): Effect.Effect<void, unknown, Requirements> {
    return Effect.gen(
      function* (this: CanonicalCoordinatorController) {
        const active = this.active;
        if (active === undefined) return;
        this.active = undefined;
        const closed = yield* Effect.exit(active.runtime.close());
        yield* Scope.close(active.scope, closed);
        this.publish(ctx, undefined);
        return yield* closed;
      }.bind(this),
    );
  }

  private persistPointer(
    pointer: CanonicalWorkstreamPointer,
  ): Effect.Effect<void, CoordinatorHostError> {
    if (pointer.phase === "prepared") this.pointerBlocked = true;
    return Effect.map(
      hostTry(() => this.pi.appendEntry(CANONICAL_POINTER_ENTRY, structuredClone(pointer))),
      () => {
        if (pointer.phase === "attached") this.pointerBlocked = false;
      },
    );
  }
}

const nowIso = Clock.clockWith((clock) =>
  Effect.sync(() => DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()))),
);

function requireActive(active: Active | undefined): Effect.Effect<Active, Error> {
  return active === undefined
    ? Effect.fail(new Error("No canonical Workstream is attached."))
    : Effect.succeed(active);
}

function requireExactOwner(
  actual: CoordinatorIdentity,
  expected: CoordinatorIdentity,
): Effect.Effect<void, Error> {
  return sameOwner(actual, expected)
    ? Effect.void
    : Effect.fail(
        new Error("Canonical pointer belongs to a different coordinator; use explicit adoption."),
      );
}

function preparedAdoptionOwnership(
  state: Workstream,
  operation: Extract<
    Extract<CanonicalWorkstreamPointer, { phase: "prepared" }>["operation"],
    { kind: "adopt" }
  >,
  owner: CoordinatorIdentity,
): Effect.Effect<CanonicalRuntimeOwnership, Error> {
  if (!sameOwner(operation.expectedOwner, owner))
    return Effect.fail(new Error("Prepared adoption successor changed."));
  if (sameOwner(state.coordinator, operation.expectedPriorOwner))
    return state.revision === operation.expectedRevision
      ? Effect.succeed({ kind: "adopt", deathObservation: operation.deathObservation })
      : Effect.fail(new Error("Prepared adoption state changed."));
  return sameOwner(state.coordinator, owner) && transferMatches(state, operation)
    ? Effect.succeed({ kind: "recover" })
    : Effect.fail(new Error("Prepared adoption identity changed."));
}

function deliveryTry<A>(run: () => A): Effect.Effect<A, ReconciliationDriverError> {
  return Effect.try({
    try: run,
    catch: (cause) => new ReconciliationDriverError({ detail: publicMessage(cause) }),
  });
}

function hostTry<A>(run: () => A): Effect.Effect<A, CoordinatorHostError> {
  return Effect.try({
    try: run,
    catch: (cause) => new CoordinatorHostError({ message: publicMessage(cause) }),
  });
}

function sameOwner(left: CoordinatorIdentity, right: CoordinatorIdentity): boolean {
  return left.sessionId === right.sessionId && left.sessionFile === right.sessionFile;
}

function pointerMatches(pointer: CanonicalWorkstreamPointer, state: Workstream): boolean {
  return (
    pointer.workstreamId === state.id &&
    Value.Equal(pointer.repository, state.repository) &&
    pointer.path.length > 0
  );
}

function attachedPointer(pointer: CanonicalWorkstreamPointer): CanonicalWorkstreamPointer {
  return {
    version: pointer.version,
    phase: "attached",
    path: pointer.path,
    workstreamId: pointer.workstreamId,
    repository: structuredClone(pointer.repository),
  };
}

function transferMatches(
  state: Workstream,
  operation: Extract<
    Extract<CanonicalWorkstreamPointer, { phase: "prepared" }>["operation"],
    { kind: "adopt" }
  >,
): boolean {
  const transfer = state.coordinatorTransfers.at(-1);
  return (
    transfer !== undefined &&
    transfer.committedRevision === operation.expectedRevision + 1 &&
    sameOwner(transfer.from, operation.expectedPriorOwner) &&
    sameOwner(transfer.to, operation.expectedOwner) &&
    Value.Equal(transfer.deathObservation, operation.deathObservation)
  );
}

function publicMessage(cause: unknown): string {
  const message =
    cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "operation failed";
  return message.replace(/\s+/g, " ").slice(0, 500);
}
