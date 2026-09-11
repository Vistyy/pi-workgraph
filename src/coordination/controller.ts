/* oxlint-disable effecttsgo/any-unknown-in-error-context, effecttsgo/global-error-in-effect-failure, typescript/no-this-alias, anti-slop/no-conditional-empty-object-spread, anti-slop/no-runtime-typeof -- The controller composes independently typed workstream/host failures at the single Pi Promise boundary; messages are bounded before presentation, optional properties retain exact external schemas, and the delivery closure must retain its controller owner. */
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
import type { HumanInputReceiptData } from "../domain/workstream.js";
import {
  type CoordinatorIdentity,
  createWorkstream,
  type HandoffCheckpoint,
  type HandoffGrant,
  HerdrDeadObservationSchema,
  type Intent,
  type RepositoryIdentity,
  type Workstream,
  WorkstreamSchema,
} from "../domain/workstream.js";
import { GitRepository, inspectRepository } from "../git.js";
import {
  deterministicChildSessionId,
  handoffChildWorkstreamId,
  prepareHandoffSession,
  priorDiscussion,
} from "../handoff-session.js";
import { HerdrCliRuntime } from "../herdr.js";
import type { CoordinatorLaunchResource, WorkerIdentity } from "../herdr-identity.js";
import { herdrCoordinatorNames } from "../herdr-naming.js";
import { WorkstreamStore, type WorkstreamStoreAttachment } from "../storage/workstream-store.js";
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
import { WorkstreamRuntime, type WorkstreamRuntimeOwnership } from "./runtime.js";

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
const PointerBase = {
  version: Type.Literal(1),
  path: NonBlank,
  workstreamId: NonBlank,
  repository: PointerRepositorySchema,
};
export const WorkstreamPointerSchema = Type.Union([
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
  readonly runtime: WorkstreamRuntime;
  readonly scope: Scope.Closeable;
  readonly path: string;
  readonly id: string;
  readonly repository: RepositoryIdentity;
  readonly owner: CoordinatorIdentity;
};

export class WorkstreamCoordinatorController {
  private active: Active | undefined;
  private pointerBlocked = false;
  private startupFailure: string | undefined;
  private readonly semaphore = Semaphore.makeUnsafe(1);

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
    return this.semaphore.withPermit(effect);
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
        const { discovered, ownership } = yield* this.prepareRestoration(pointer, owner);
        const next = yield* this.acquire(ctx, discovered, ownership, owner);
        this.active = next;
        if (pointer.phase === "prepared") yield* this.persistPointer(attachedPointer(pointer));
        else this.pointerBlocked = false;
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
  ): Effect.Effect<
    { discovered: WorkstreamStoreAttachment; ownership: WorkstreamRuntimeOwnership },
    unknown,
    Requirements
  > {
    return Effect.gen(
      function* (this: WorkstreamCoordinatorController) {
        if (pointer.phase === "prepared" && pointer.operation.kind === "create") {
          if (
            !pointerMatches(pointer, pointer.operation.initial) ||
            !sameOwner(pointer.operation.initial.coordinator, owner)
          )
            return yield* Effect.fail(new Error("Prepared creation identity changed."));
          yield* this.proveRepository(pointer.operation.initial.repository);
          const discovered = yield* Effect.scoped(
            WorkstreamStore.resumeCreate(pointer.operation.initial),
          );
          return { discovered, ownership: { kind: "recover" } as const };
        }
        const discovered = yield* this.discover(pointer.path);
        if (!pointerMatches(pointer, discovered.state))
          return yield* Effect.fail(
            new Error("Workstream pointer identity does not match its aggregate."),
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
            return yield* projectWorkstreamAction(yield* active.runtime.inspectionSnapshot(), {
              action: "workgraph_intent",
            });
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
            phase: "prepared",
            path,
            workstreamId: id,
            repository,
            operation: { kind: "create", initial: structuredClone(initial) },
          };
          yield* this.persistPointer(pointer);
          const discovered = yield* Effect.scoped(WorkstreamStore.resumeCreate(initial));
          const next = yield* this.acquire(ctx, discovered, { kind: "attach" }, this.owner(ctx));
          this.active = next;
          yield* this.persistPointer(attachedPointer(pointer));
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
    request: { request: string; forkContext: boolean; targetRepository: string | undefined },
  ): Effect.Effect<object, unknown, Requirements> {
    return this.serialize(
      Effect.gen(
        function* (this: WorkstreamCoordinatorController) {
          const active = yield* requireActive(this.active);
          const target = yield* inspectRepository(
            request.targetRepository ?? active.repository.projectRoot,
          );
          const targetRepository = { projectRoot: target.root, gitCommonDir: target.commonDir };
          let state = yield* active.runtime.read();
          let checkpoint = resolveHandoff(state, toolCallId, request, targetRepository);
          if (checkpoint === undefined) {
            if (state.lifecycle !== "active")
              return yield* Effect.fail(
                new Error(
                  "Only an active, unsuspended parent Workstream can issue a Handoff Grant.",
                ),
              );
            const intentIndex = state.intents.length - 1;
            const intent = state.intents[intentIndex];
            if (intent === undefined)
              return yield* Effect.fail(new Error("Parent Workstream has no current Intent."));
            const parentReceipt =
              intent.grounding.kind === "handoff_grant"
                ? intent.grounding.parentReceipt
                : intent.grounding;
            const issuedAt = yield* nowIso;
            const id = `grant-${randomUUID()}`;
            const grant: HandoffGrant = {
              kind: "handoff_grant",
              id,
              parentReceipt: structuredClone(parentReceipt),
              parentWorkstreamId: state.id,
              parentRepository: structuredClone(state.repository),
              parentIntentIndex: intentIndex,
              parentIntentStatement: intent.statement,
              parentIntentConstraints: [...intent.constraints],
              narrowedRequest: request.request,
              targetRepository,
              issuedAt,
            };
            checkpoint = {
              phase: "prepared",
              id,
              toolCallId,
              request: request.request,
              forkContext: request.forkContext,
              grant,
              childSessionId: deterministicChildSessionId(id),
            };
            state = yield* active.runtime.issueHandoff(checkpoint);
          }
          if (state.lifecycle !== "active" && checkpoint.phase !== "launched")
            return yield* Effect.fail(
              new Error("Only an active, unsuspended parent Workstream can progress a Handoff."),
            );
          return yield* this.advanceHandoff(active, ctx, checkpoint);
        }.bind(this),
      ),
    );
  }

  // biome-ignore-start lint/complexity/noExcessiveCognitiveComplexity: ordered checkpoints keep each remote effect and recovery classification explicit.
  private advanceHandoff(
    active: Active,
    ctx: ExtensionContext,
    initial: HandoffCheckpoint,
  ): Effect.Effect<object, unknown, Requirements> {
    return Effect.gen(
      function* (this: WorkstreamCoordinatorController) {
        let checkpoint = initial;
        const workers = this.options.workers?.() ?? new HerdrCliRuntime();
        if (checkpoint.phase === "prepared") {
          const discussion = checkpoint.forkContext
            ? priorDiscussion(ctx.sessionManager, checkpoint.toolCallId)
            : [];
          const prepared = yield* prepareHandoffSession(
            checkpoint.grant.targetRepository.projectRoot,
            checkpoint.childSessionId,
            checkpoint.grant,
            discussion,
          );
          checkpoint = {
            ...checkpoint,
            phase: "session_ready",
            childSessionFile: prepared.sessionFile,
          };
          yield* active.runtime.checkpointHandoff(checkpoint);
        }
        if (checkpoint.phase === "session_ready") {
          const names = herdrCoordinatorNames({
            cwd: checkpoint.grant.targetRepository.projectRoot,
            sessionFile: checkpoint.childSessionFile,
          });
          checkpoint = {
            ...checkpoint,
            phase: "workspace_submitting",
            workspaceLabel: names.label,
            agentName: names.agentName,
          };
          yield* active.runtime.checkpointHandoff(checkpoint);
        }
        if (checkpoint.phase === "workspace_submitting") {
          const launchRequest = {
            cwd: checkpoint.grant.targetRepository.projectRoot,
            sessionFile: checkpoint.childSessionFile,
          };
          const observed = yield* workers.probeCoordinatorLaunch(launchRequest);
          if (observed.state === "ambiguous") return yield* Effect.fail(new Error(observed.detail));
          if (observed.state === "launched") {
            const workspace = workspaceCheckpoint(checkpoint, observed.identity);
            yield* active.runtime.checkpointHandoff(workspace);
            const submitting = { ...workspace, phase: "start_submitting" as const };
            yield* active.runtime.checkpointHandoff(submitting);
            checkpoint = launchedCheckpoint(submitting, observed.identity, yield* nowIso);
            yield* active.runtime.checkpointHandoff(checkpoint);
          } else {
            let resource: CoordinatorLaunchResource;
            if (observed.state === "workspace") {
              resource = observed.resource;
              checkpoint = { ...checkpoint, phase: "workspace_ready", ...resourceFields(resource) };
              yield* active.runtime.checkpointHandoff(checkpoint);
            } else {
              yield* active.runtime.checkOwnership();
              const submitting = checkpoint;
              checkpoint = yield* Effect.uninterruptibleMask((restore) =>
                restore(workers.createCoordinatorWorkspace(launchRequest)).pipe(
                  Effect.flatMap((created) => {
                    const ready: Extract<HandoffCheckpoint, { phase: "workspace_ready" }> = {
                      ...submitting,
                      phase: "workspace_ready",
                      ...resourceFields(created),
                    };
                    return active.runtime.checkpointHandoff(ready).pipe(Effect.as(ready));
                  }),
                ),
              );
            }
          }
        }
        if (checkpoint.phase === "workspace_ready") {
          checkpoint = { ...checkpoint, phase: "start_submitting" };
          yield* active.runtime.checkpointHandoff(checkpoint);
          yield* active.runtime.checkOwnership();
          const submitting = checkpoint;
          checkpoint = yield* Effect.uninterruptibleMask((restore) =>
            restore(workers.startCoordinatorAgent(resourceFrom(submitting))).pipe(
              Effect.flatMap((identity) =>
                Effect.flatMap(nowIso, (launchedAt) => {
                  const launched = launchedCheckpoint(submitting, identity, launchedAt);
                  return active.runtime.checkpointHandoff(launched).pipe(Effect.as(launched));
                }),
              ),
            ),
          );
        } else if (checkpoint.phase === "start_submitting") {
          const observed = yield* workers.probeCoordinatorLaunch({
            cwd: checkpoint.grant.targetRepository.projectRoot,
            sessionFile: checkpoint.childSessionFile,
          });
          if (observed.state !== "launched")
            return yield* Effect.fail(
              new Error(
                observed.state === "ambiguous"
                  ? observed.detail
                  : "Handoff agent start is uncertain and exact child identity is not observable; no resubmission was attempted.",
              ),
            );
          checkpoint = launchedCheckpoint(checkpoint, observed.identity, yield* nowIso);
          yield* active.runtime.checkpointHandoff(checkpoint);
        }
        if (checkpoint.phase !== "launched")
          return yield* Effect.fail(new Error("Handoff launch did not reach an exact identity."));
        return {
          grantId: checkpoint.id,
          childSessionId: checkpoint.childSessionId,
          childSessionFile: checkpoint.childSessionFile,
          workspaceId: checkpoint.workspaceId,
          tabId: checkpoint.tabId,
          paneId: checkpoint.paneId,
          terminalId: checkpoint.terminalId,
          agentName: checkpoint.agentName,
          cwd: checkpoint.grant.targetRepository.projectRoot,
          resultChannel: "none",
        };
      }.bind(this),
    );
  }

  // biome-ignore-end lint/complexity/noExcessiveCognitiveComplexity: ordered checkpoint boundary ends here.
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
          const id = handoffChildWorkstreamId(grant.id);
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
            phase: "prepared",
            path,
            workstreamId: id,
            repository: structuredClone(grant.targetRepository),
            operation: { kind: "create", initial },
          };
          yield* this.persistPointer(pointer);
          const discovered = yield* Effect.scoped(WorkstreamStore.resumeCreate(initial));
          const next = yield* this.acquire(ctx, discovered, { kind: "attach" }, owner);
          this.active = next;
          yield* this.persistPointer(attachedPointer(pointer));
          this.publish(ctx, yield* next.runtime.snapshot());
        }.bind(this),
      ),
    );
  }

  adopt(
    ctx: ExtensionContext,
    statePath: string,
  ): Effect.Effect<WorkstreamActionProjection, unknown, Requirements> {
    return this.serialize(
      Effect.gen(
        function* (this: WorkstreamCoordinatorController) {
          const discovered = yield* this.discover(statePath);
          yield* this.proveRepository(discovered.state.repository);
          const owner = this.owner(ctx);
          const prior = discovered.state.coordinator;
          let ownership: WorkstreamRuntimeOwnership;
          let pointer: WorkstreamPointer;
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
          return yield* projectWorkstreamAction(yield* next.runtime.inspectionSnapshot(), {
            action: "workgraph_adopt",
          });
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
    operation: (runtime: WorkstreamRuntime) => Effect.Effect<Workstream, unknown, Requirements>,
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
          return yield* projectWorkstreamAction(
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
        return yield* Effect.fail(
          new Error("Workstream aggregate repository identity does not match Git."),
        );
    });
  }

  private acquire(
    ctx: ExtensionContext,
    attachment: WorkstreamStoreAttachment,
    ownership: WorkstreamRuntimeOwnership,
    owner: CoordinatorIdentity,
  ): Effect.Effect<Active, unknown, Requirements> {
    return Effect.gen(
      function* (this: WorkstreamCoordinatorController) {
        const scope = yield* Scope.make("sequential");
        const workers = this.options.workers?.() ?? new HerdrCliRuntime();
        const git = new GitRepository(
          attachment.state.repository.projectRoot,
          attachment.state.repository.gitCommonDir,
        );
        let runtime: WorkstreamRuntime | undefined;
        const controller = this;
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
            ownership,
            driver,
            commands: liveWorkstreamCommandPorts(git, workers),
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
        const closed = yield* Effect.exit(active.runtime.close());
        yield* Scope.close(active.scope, closed);
        this.publish(ctx, undefined);
        return yield* closed;
      }.bind(this),
    );
  }

  private persistPointer(pointer: WorkstreamPointer): Effect.Effect<void, CoordinatorHostError> {
    if (pointer.phase === "prepared") this.pointerBlocked = true;
    return Effect.map(
      hostTry(() => this.pi.appendEntry(WORKSTREAM_POINTER_ENTRY, structuredClone(pointer))),
      () => {
        if (pointer.phase === "attached") this.pointerBlocked = false;
      },
    );
  }
}

const nowIso = Clock.clockWith((clock) =>
  Effect.sync(() => DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()))),
);

function blockedEstablishmentError(diagnostic: string | undefined): Error {
  return new Error(
    diagnostic === undefined
      ? "A retained workstream pointer must be recovered or explicitly adopted."
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
    : Effect.fail(
        new Error("Workstream pointer belongs to a different coordinator; use explicit adoption."),
      );
}

function preparedAdoptionOwnership(
  state: Workstream,
  operation: Extract<
    Extract<WorkstreamPointer, { phase: "prepared" }>["operation"],
    { kind: "adopt" }
  >,
  owner: CoordinatorIdentity,
): Effect.Effect<WorkstreamRuntimeOwnership, Error> {
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

function pointerMatches(pointer: WorkstreamPointer, state: Workstream): boolean {
  return (
    pointer.workstreamId === state.id &&
    Value.Equal(pointer.repository, state.repository) &&
    pointer.path.length > 0
  );
}

function attachedPointer(pointer: WorkstreamPointer): WorkstreamPointer {
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
    Extract<WorkstreamPointer, { phase: "prepared" }>["operation"],
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

function resolveHandoff(
  state: Workstream,
  toolCallId: string,
  request: { request: string; forkContext: boolean; targetRepository: string | undefined },
  targetRepository: RepositoryIdentity,
): HandoffCheckpoint | undefined {
  const exactCall = (state.handoffs ?? []).findLast((handoff) => handoff.toolCallId === toolCallId);
  if (exactCall !== undefined) {
    requireMatchingHandoff(exactCall, request, targetRepository);
    return exactCall;
  }
  const unresolved = (state.handoffs ?? []).findLast((handoff) => handoff.phase !== "launched");
  if (unresolved === undefined) return undefined;
  requireMatchingHandoff(unresolved, request, targetRepository);
  return unresolved;
}

function requireMatchingHandoff(
  handoff: HandoffCheckpoint,
  request: { request: string; forkContext: boolean; targetRepository: string | undefined },
  targetRepository: RepositoryIdentity,
): void {
  if (
    handoff.request !== request.request ||
    handoff.forkContext !== request.forkContext ||
    !Value.Equal(handoff.grant.targetRepository, targetRepository)
  )
    throw new Error(
      `Unresolved Handoff ${handoff.id} has different request, context, or target repository parameters.`,
    );
}

function resourceFields(
  resource: Pick<CoordinatorLaunchResource, "workspaceId" | "tabId" | "paneId">,
) {
  return {
    workspaceId: resource.workspaceId,
    tabId: resource.tabId,
    paneId: resource.paneId,
  };
}

function resourceFrom(
  checkpoint: Extract<HandoffCheckpoint, { phase: "workspace_ready" | "start_submitting" }>,
): CoordinatorLaunchResource {
  return {
    ...resourceFields(checkpoint),
    agentName: checkpoint.agentName,
    sessionFile: checkpoint.childSessionFile,
    cwd: checkpoint.grant.targetRepository.projectRoot,
  };
}

function workspaceCheckpoint(
  checkpoint: Extract<HandoffCheckpoint, { phase: "workspace_submitting" }>,
  identity: WorkerIdentity,
): Extract<HandoffCheckpoint, { phase: "workspace_ready" }> {
  return {
    ...checkpoint,
    phase: "workspace_ready",
    workspaceId: identity.workspaceId,
    tabId: identity.tabId,
    paneId: identity.paneId,
  };
}

function launchedCheckpoint(
  checkpoint: Extract<HandoffCheckpoint, { phase: "start_submitting" }>,
  identity: WorkerIdentity,
  launchedAt: string,
): Extract<HandoffCheckpoint, { phase: "launched" }> {
  if (
    checkpoint.workspaceId !== identity.workspaceId ||
    checkpoint.tabId !== identity.tabId ||
    checkpoint.paneId !== identity.paneId ||
    checkpoint.agentName !== identity.agentName ||
    checkpoint.childSessionFile !== identity.sessionFile ||
    checkpoint.grant.targetRepository.projectRoot !== identity.cwd
  )
    throw new Error("Observed Herdr launch identity conflicts with the prepared Handoff.");
  return {
    ...checkpoint,
    phase: "launched",
    terminalId: identity.terminalId,
    launchedAt,
  };
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
