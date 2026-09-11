/* oxlint-disable effecttsgo/any-unknown-in-error-context, effecttsgo/global-error-in-effect-failure, typescript/no-this-alias, anti-slop/no-conditional-empty-object-spread, anti-slop/no-runtime-typeof -- The controller composes independently typed workstream/host failures at the single Pi Promise boundary; messages are bounded before presentation, optional properties retain exact external schemas, and the delivery closure must retain its controller owner. */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Clock, Data, DateTime, Effect, Exit, type FileSystem, type Path, Semaphore } from "effect";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { HumanInputReceiptData } from "../domain/workstream.js";
import {
  type CoordinatorIdentity,
  createWorkstream,
  type HandoffGrant,
  type Intent,
  type RepositoryIdentity,
  type Workstream,
} from "../domain/workstream.js";
import { GitRepository, inspectRepository } from "../git.js";
import { handoffChildWorkstreamId } from "../handoff-session.js";
import { HerdrCliRuntime } from "../herdr.js";
import { WorkstreamStore, type WorkstreamStoreAttachment } from "../storage/workstream-store.js";
import { launchOneShotHandoff } from "./handoff.js";
import {
  liveWorkstreamCommandPorts,
  makeLiveWorkstreamReconciliationDriver,
  type WorkstreamHostOptions,
} from "./host.js";
import {
  inspectWorkstream,
  projectWorkstreamAction,
  type WorkstreamActionProjection,
  type WorkstreamInspectionRequest,
  type WorkstreamInspectionView,
  workstreamOutcomeNotification,
} from "./inspection.js";
import { ReconciliationDriverError } from "./reconciliation.js";
import { WorkstreamRuntime } from "./runtime.js";

export const WORKSTREAM_POINTER_ENTRY = "pi-workgraph-workstream-pointer";
const WORKSTREAM_MESSAGE = "pi-workgraph-workstream";
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
export const WorkstreamPointerSchema = Type.Object(
  {
    version: Type.Literal(1),
    path: NonBlank,
    workstreamId: NonBlank,
    repository: PointerRepositorySchema,
    owner: PointerOwnerSchema,
  },
  { additionalProperties: false },
);
export type WorkstreamPointer = Static<typeof WorkstreamPointerSchema>;
export type WorkstreamPointerRestoration = WorkstreamPointer | "malformed" | undefined;

export interface WorkstreamCoordinatorControllerOptions {
  readonly workers?: () => HerdrCliRuntime;
  readonly workspaceId?: string;
  readonly policyPath?: string;
  readonly hostOverrides?: WorkstreamHostOptions["overrides"];
}

type Requirements = FileSystem.FileSystem | Path.Path;
type Active = {
  readonly token: symbol;
  readonly runtime: WorkstreamRuntime;
  readonly path: string;
  readonly id: string;
  readonly repository: RepositoryIdentity;
  readonly owner: CoordinatorIdentity;
};

const PROCESS_LIFECYCLE = Semaphore.makeUnsafe(1);
const PROCESS_RUNTIMES = new Map<string, Active>();

export class WorkstreamCoordinatorController {
  private active: Active | undefined;
  private pointerBlocked = false;
  private startupFailure: string | undefined;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly options: WorkstreamCoordinatorControllerOptions,
    private readonly publish: (ctx: ExtensionContext, state?: Workstream) => void,
  ) {}

  owner(ctx: ExtensionContext): CoordinatorIdentity {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile === undefined || sessionFile === "")
      throw new Error("Workgraph requires a persistent Pi session.");
    return { sessionId: ctx.sessionManager.getSessionId(), sessionFile };
  }

  serialize<A, E>(effect: Effect.Effect<A, E, Requirements>): Effect.Effect<A, E, Requirements> {
    return PROCESS_LIFECYCLE.withPermit(effect);
  }

  restore(ctx: ExtensionContext, retained: () => WorkstreamPointerRestoration) {
    const restoration = Effect.gen(
      function* (this: WorkstreamCoordinatorController) {
        yield* this.closeOwned(ctx);
        const pointer = retained();
        this.pointerBlocked = pointer !== undefined;
        if (pointer === undefined) {
          this.startupFailure = undefined;
          return;
        }
        if (pointer === "malformed")
          return yield* Effect.fail(new Error("Workstream pointer is malformed."));
        const owner = this.owner(ctx);
        const discovered = yield* this.prepareRestoration(pointer, owner);
        const next = yield* this.acquire(ctx, discovered, owner);
        yield* this.activate(next);
        this.pointerBlocked = false;
        this.publish(ctx, yield* next.runtime.snapshot());
        this.startupFailure = undefined;
      }.bind(this),
    ).pipe(
      Effect.tapError((cause) =>
        Effect.sync(() => {
          this.startupFailure = publicMessage(cause);
        }),
      ),
    );
    return this.serialize(restoration);
  }

  private prepareRestoration(
    pointer: WorkstreamPointer,
    owner: CoordinatorIdentity,
  ): Effect.Effect<WorkstreamStoreAttachment, unknown, Requirements> {
    return Effect.gen(
      function* (this: WorkstreamCoordinatorController) {
        yield* requireExactOwner(pointer.owner, owner);
        const discovered = yield* this.discover(pointer.path);
        if (!pointerMatches(pointer, discovered.state))
          return yield* Effect.fail(
            new Error("Workstream pointer identity does not match its records."),
          );
        yield* this.proveRepository(discovered.state.repository);
        yield* requireExactOwner(discovered.state.coordinator, owner);
        return discovered;
      }.bind(this),
    );
  }

  establish(
    ctx: ExtensionContext,
    receipt: HumanInputReceiptData,
    request: { statement: string; constraints: readonly string[]; targetRepository?: string },
  ): Effect.Effect<WorkstreamActionProjection, unknown, Requirements> {
    return this.serialize(
      Effect.gen(
        function* (this: WorkstreamCoordinatorController) {
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
            const snapshot = yield* active.runtime.inspectionSnapshot();
            this.publish(ctx, snapshot.workstream);
            return yield* projectWorkstreamAction(snapshot, { action: "workgraph_intent" });
          }
          if (this.pointerBlocked)
            return yield* Effect.fail(blockedEstablishmentError(this.startupFailure));
          const inspected = yield* inspectRepository(request.targetRepository ?? ctx.cwd);
          const repository = { projectRoot: inspected.root, gitCommonDir: inspected.commonDir };
          const id = `ws-${randomUUID()}`;
          const path = yield* WorkstreamStore.pathFor(repository, id);
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
          const pointer: WorkstreamPointer = {
            version: 1,
            path,
            workstreamId: id,
            repository,
            owner: structuredClone(initial.coordinator),
          };
          yield* this.persistPointer(pointer);
          const discovered = yield* Effect.scoped(WorkstreamStore.resumeCreate(initial));
          const next = yield* this.acquire(ctx, discovered, this.owner(ctx));
          yield* this.activate(next);
          this.pointerBlocked = false;
          const state = yield* next.runtime.snapshot();
          this.publish(ctx, state);
          return yield* projectWorkstreamAction(yield* next.runtime.inspectionSnapshot(), {
            action: "workgraph_intent",
          });
        }.bind(this),
      ),
    );
  }

  handoff(
    ctx: ExtensionContext,
    toolCallId: string,
    request: { request: string; includeContext: boolean },
  ): Effect.Effect<object, unknown, Requirements> {
    return this.serialize(
      Effect.gen(
        function* (this: WorkstreamCoordinatorController) {
          const active = yield* requireActive(this.active);
          const parent = yield* active.runtime.read();
          const workers = this.options.workers?.() ?? new HerdrCliRuntime();
          return yield* launchOneShotHandoff(
            {
              request: request.request,
              includeContext: request.includeContext,
              toolCallId,
              parentSession: ctx.sessionManager,
              parent,
            },
            workers,
          );
        }.bind(this),
      ),
    );
  }

  bootstrapHandoff(
    ctx: ExtensionContext,
    grant: HandoffGrant,
  ): Effect.Effect<void, unknown, Requirements> {
    return this.serialize(
      Effect.gen(
        function* (this: WorkstreamCoordinatorController) {
          if (this.active !== undefined) {
            const state = yield* this.active.runtime.read();
            verifyGrantBootstrap(state, grant);
            return;
          }
          if (this.pointerBlocked)
            return yield* Effect.fail(
              new Error("Handoff Grant conflicts with a retained Workstream pointer."),
            );
          yield* this.proveRepository(grant.targetRepository);
          const owner = this.owner(ctx);
          const id = handoffChildWorkstreamId(ctx.sessionManager.getSessionId());
          const path = yield* WorkstreamStore.pathFor(grant.targetRepository, id);
          const now = yield* nowIso;
          const initial = createWorkstream({
            id,
            purpose: grant.narrowedRequest,
            repository: grant.targetRepository,
            coordinator: owner,
            intent: {
              statement: grant.narrowedRequest,
              constraints: [...grant.parentIntentConstraints],
              grounding: structuredClone(grant),
              recordedAt: now,
            },
            createdAt: now,
          });
          const pointer: WorkstreamPointer = {
            version: 1,
            path,
            workstreamId: id,
            repository: structuredClone(grant.targetRepository),
            owner: structuredClone(owner),
          };
          yield* this.persistPointer(pointer);
          const discovered = yield* Effect.scoped(WorkstreamStore.resumeCreate(initial));
          const next = yield* this.acquire(ctx, discovered, owner);
          yield* this.activate(next);
          this.pointerBlocked = false;
          this.publish(ctx, yield* next.runtime.snapshot());
        }.bind(this),
      ),
    );
  }

  inspect(
    request: WorkstreamInspectionRequest,
  ): Effect.Effect<WorkstreamInspectionView, unknown, Requirements> {
    return this.serialize(
      Effect.gen(
        function* (this: WorkstreamCoordinatorController) {
          const active = yield* requireActive(this.active);
          const snapshot = yield* active.runtime.inspectionSnapshot();
          return yield* inspectWorkstream(snapshot, request);
        }.bind(this),
      ),
    );
  }

  action(
    operation: (runtime: WorkstreamRuntime) => Effect.Effect<unknown, unknown, Requirements>,
    projection: {
      action: string;
      message?: string;
      taskId?: string;
      attemptId?: string;
      outcomeId?: string;
    },
  ): Effect.Effect<WorkstreamActionProjection, unknown, Requirements> {
    return this.serialize(
      Effect.gen(
        function* (this: WorkstreamCoordinatorController) {
          const active = yield* requireActive(this.active);
          yield* operation(active.runtime);
          const snapshot = yield* active.runtime.inspectionSnapshot();
          return yield* projectWorkstreamAction(snapshot, projection);
        }.bind(this),
      ),
    );
  }

  close(ctx: ExtensionContext): Effect.Effect<void, unknown, Requirements> {
    return this.serialize(this.closeOwned(ctx));
  }

  private discover(path: string): Effect.Effect<WorkstreamStoreAttachment, unknown, Requirements> {
    return Effect.scoped(WorkstreamStore.discover(path));
  }

  private proveRepository(repository: RepositoryIdentity): Effect.Effect<void, unknown> {
    return Effect.gen(function* () {
      const inspected = yield* inspectRepository(repository.projectRoot);
      if (
        inspected.root !== repository.projectRoot ||
        inspected.commonDir !== repository.gitCommonDir
      )
        return yield* Effect.fail(new Error("Workstream repository identity does not match Git."));
    });
  }

  private acquire(
    ctx: ExtensionContext,
    attachment: WorkstreamStoreAttachment,
    owner: CoordinatorIdentity,
  ): Effect.Effect<Active, unknown, Requirements> {
    return Effect.gen(
      function* (this: WorkstreamCoordinatorController) {
        const prior = PROCESS_RUNTIMES.get(attachment.store.path);
        if (prior !== undefined) {
          PROCESS_RUNTIMES.delete(attachment.store.path);
          yield* prior.runtime.close();
        }
        const workers = this.options.workers?.() ?? new HerdrCliRuntime();
        const git = new GitRepository(
          attachment.state.repository.projectRoot,
          attachment.state.repository.gitCommonDir,
        );
        let runtime: WorkstreamRuntime | undefined;
        const controller = this;
        const token = Symbol(attachment.state.id);
        const { HERDR_WORKSPACE_ID: hostWorkspaceId, PI_CODING_AGENT_DIR: hostAgentDir } =
          process.env;
        const driver = makeLiveWorkstreamReconciliationDriver({
          repository: attachment.state.repository,
          workspaceId: this.options.workspaceId ?? hostWorkspaceId ?? "",
          git,
          workers,
          delivery: {
            deliver: (context) =>
              Effect.gen(function* () {
                const ready = yield* deliveryTry(() => {
                  if (runtime === undefined)
                    throw new Error("Workstream runtime delivery is not ready.");
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
                  workstreamOutcomeNotification(snapshot, outcomeId),
                );
                const content = yield* notificationEffect.pipe(
                  Effect.mapError(
                    (cause) => new ReconciliationDriverError({ detail: publicMessage(cause) }),
                  ),
                );
                yield* deliveryTry(() =>
                  controller.pi.sendMessage(
                    { customType: WORKSTREAM_MESSAGE, content, display: true },
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
          WorkstreamRuntime.acquire({
            id: attachment.state.id,
            repository: attachment.state.repository,
            coordinator: owner,
            owns: () => PROCESS_RUNTIMES.get(attachment.store.path)?.token === token,
            driver,
            commands: liveWorkstreamCommandPorts(git, workers),
            onCommitted: (state) => Effect.sync(() => this.publish(ctx, state)).pipe(Effect.ignore),
            onReconciliationAttention: (detail) => this.attention(ctx, detail),
            onFatal: (error) => this.attention(ctx, publicMessage(error)),
            ...(this.options.policyPath === undefined
              ? {}
              : { policyPath: this.options.policyPath }),
          }),
        );
        if (Exit.isFailure(acquired)) return yield* Effect.failCause(acquired.cause);
        runtime = acquired.value;
        return {
          token,
          runtime,
          path: attachment.store.path,
          id: attachment.state.id,
          repository: structuredClone(attachment.state.repository),
          owner: structuredClone(owner),
        };
      }.bind(this),
    );
  }

  private activate(next: Active): Effect.Effect<void, unknown, Requirements> {
    this.active = next;
    PROCESS_RUNTIMES.set(next.path, next);
    return next.runtime.start().pipe(
      Effect.onError(() =>
        Effect.sync(() => {
          if (this.active?.token === next.token) this.active = undefined;
          if (PROCESS_RUNTIMES.get(next.path)?.token === next.token)
            PROCESS_RUNTIMES.delete(next.path);
        }).pipe(Effect.andThen(next.runtime.close()), Effect.ignore),
      ),
    );
  }

  private attention(ctx: ExtensionContext, detail: string): Effect.Effect<void> {
    const bounded = publicMessage(detail);
    return Effect.gen(
      function* (this: WorkstreamCoordinatorController) {
        yield* hostTry(() => ctx.ui.notify(`Workgraph: ${bounded}`, "warning")).pipe(Effect.ignore);
        yield* hostTry(() =>
          this.pi.sendMessage(
            {
              customType: ATTENTION_MESSAGE,
              content: `Workgraph requires attention: ${bounded}. Inspect retained workstream state; this message grants no authority.`,
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
      function* (this: WorkstreamCoordinatorController) {
        const active = this.active;
        if (active === undefined) return;
        this.active = undefined;
        if (PROCESS_RUNTIMES.get(active.path)?.token === active.token)
          PROCESS_RUNTIMES.delete(active.path);
        const closed = yield* Effect.exit(active.runtime.close());
        this.publish(ctx, undefined);
        return yield* closed;
      }.bind(this),
    );
  }

  private persistPointer(pointer: WorkstreamPointer): Effect.Effect<void, CoordinatorHostError> {
    this.pointerBlocked = true;
    return hostTry(() => this.pi.appendEntry(WORKSTREAM_POINTER_ENTRY, structuredClone(pointer)));
  }
}

const nowIso = Clock.clockWith((clock) =>
  Effect.sync(() => DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()))),
);

function blockedEstablishmentError(diagnostic: string | undefined): Error {
  return new Error(
    diagnostic === undefined
      ? "A retained workstream pointer must be recovered by its exact coordinator session."
      : `Workstream startup remains blocked by retained state: ${diagnostic}`,
  );
}

function requireActive(active: Active | undefined): Effect.Effect<Active, Error> {
  return active === undefined
    ? Effect.fail(new Error("No Workstream is attached."))
    : Effect.succeed(active);
}

function requireExactOwner(
  actual: CoordinatorIdentity,
  expected: CoordinatorIdentity,
): Effect.Effect<void, Error> {
  return sameOwner(actual, expected)
    ? Effect.void
    : Effect.fail(new Error("Workstream pointer belongs to a different coordinator session."));
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

function pointerMatches(pointer: WorkstreamPointer, state: Workstream): boolean {
  return (
    pointer.workstreamId === state.id &&
    Value.Equal(pointer.repository, state.repository) &&
    pointer.path.length > 0
  );
}

function verifyGrantBootstrap(state: Workstream, grant: HandoffGrant): void {
  const first = state.intents[0];
  if (
    first === undefined ||
    first.statement !== grant.narrowedRequest ||
    !Value.Equal(first.constraints, grant.parentIntentConstraints) ||
    !Value.Equal(first.grounding, grant)
  )
    throw new Error("Attached child Workstream first Intent does not match its Handoff Grant.");
}

function publicMessage(cause: unknown): string {
  const message =
    cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "operation failed";
  return message.replace(/\s+/g, " ").slice(0, 500);
}
