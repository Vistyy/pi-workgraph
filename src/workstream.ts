import { randomUUID } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Workstream paths are pure host paths and do not require an Effect service.
import { resolve } from "node:path";
import { DateTime, Effect, Semaphore } from "effect";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { EvidenceSchema } from "./report-schema.js";
import {
  AtomicWorkstreamFile,
  claimWorkstreamDirectory,
  domainEffect,
  removeWorkstreamDirectory,
  type StoreEffect,
  type WorkstreamStoreError,
} from "./workstream-persistence.js";
import {
  type ArtifactRetention,
  AssignmentSchema,
  type AttemptPlacementSchema,
  type AuthorityReference,
  type CompletionAccounting,
  type HumanInputReceipt,
  type HumanInputSource,
  type Intent,
  InvalidWorkstreamStateError,
  pathForWorkstream,
  type ResultDisposition,
  ResultSchema,
  type ResultSubject,
  ResultSubjectSchema,
  type RetainedArtifact,
  type SessionIdentity,
  UnsupportedWorkstreamStateError,
  WORKSTREAM_FORMAT,
  WORKSTREAM_STATE_VERSION,
  type WorkAssignment,
  type WorkAttempt,
  type WorkResult,
  type WorkstreamReattachmentInspection,
  type WorkstreamState,
  WorkstreamStateSchema,
  WorkstreamStoreOperationError,
} from "./workstream-state.js";
import {
  accountingTaskId,
  deriveCompletionAccounting,
  hasActiveOrUncleanAttempt,
  recordInputTransition,
  startAttemptTransition,
  transitionWorkstreamState,
} from "./workstream-transitions.js";
import {
  decodeState,
  isActiveHistoricalState,
  isKnownHistoricalWorkstreamVersion,
  type JsonObject,
  type JsonValue,
  requireText,
  retainedTerminalInspection,
  validateArtifactsForAssignment,
  validateAuthority,
  validateId,
  validateSession,
  validateStoredPath,
  validateSubject,
} from "./workstream-validation.js";

export type {
  ArtifactRetention,
  AuthorityReference,
  CompletionAccounting,
  HumanInputReceipt,
  HumanInputSource,
  Intent,
  ResultDisposition,
  ResultSubject,
  RetainedArtifact,
  SessionIdentity,
  StoreEffect,
  WorkAssignment,
  WorkAttempt,
  WorkResult,
  WorkstreamReattachmentInspection,
  WorkstreamState,
  WorkstreamStoreError,
};
export {
  InvalidWorkstreamStateError,
  UnsupportedWorkstreamStateError,
  WORKSTREAM_STATE_VERSION,
  WorkstreamStateSchema,
};

type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type AssignmentInput = OmitEach<WorkAssignment, "createdAt">;
type ResultInput = OmitEach<WorkResult, "observedAt" | "artifacts"> & {
  artifacts?: RetainedArtifact[];
};

export class WorkstreamStoreEffects {
  private readonly writeSemaphore = Semaphore.makeUnsafe(1);

  private mutationGuard: (() => void) | undefined;

  private readonly file: AtomicWorkstreamFile;

  private constructor(
    readonly path: string,
    private owner: SessionIdentity,
  ) {
    this.file = new AtomicWorkstreamFile(path, () => this.mutationGuard);
  }

  bindMutationGuard(guard: () => void): void {
    this.mutationGuard = guard;
  }

  adopt(owner: SessionIdentity): StoreEffect<WorkstreamState> {
    return this.prepared(
      () => validateSession(owner),
      () =>
        this.update(
          (draft) => {
            draft.coordinator = { ...owner };
          },
          undefined,
          ["active", "suspended"],
        ).pipe(
          Effect.tap(() =>
            domainEffect(() => {
              this.owner = { ...owner };
            }),
          ),
        ),
    );
  }

  static pathFor(gitCommonDir: string, id: string): string {
    validateId(id, "Workstream id");
    return pathForWorkstream(gitCommonDir, id);
  }

  static create(input: {
    id: string;
    purpose: string;
    projectRoot: string;
    gitCommonDir: string;
    coordinator: SessionIdentity;
    now?: Date;
  }): StoreEffect<{ store: WorkstreamStoreEffects; state: WorkstreamState }> {
    return domainEffect(() => {
      validateId(input.id, "Workstream id");
      requireText(input.purpose, "Workstream purpose");
      requireText(input.projectRoot, "Project root");
      requireText(input.gitCommonDir, "Git common directory");
      validateSession(input.coordinator);
      const path = WorkstreamStoreEffects.pathFor(input.gitCommonDir, input.id);
      const now = (input.now ?? currentDate()).toISOString();
      const state: WorkstreamState = {
        format: WORKSTREAM_FORMAT,
        version: WORKSTREAM_STATE_VERSION,
        revision: 0,
        id: input.id,
        purpose: input.purpose.trim(),
        projectRoot: input.projectRoot,
        gitCommonDir: input.gitCommonDir,
        statePath: path,
        coordinator: { ...input.coordinator },
        lifecycle: {
          state: "active",
          changedAt: now,
          reason: "Workstream created.",
        },
        inputs: [],
        intents: [
          {
            version: 0,
            statement: input.purpose.trim(),
            constraints: [],
            authorityReceiptIds: [],
            recordedAt: now,
          },
        ],
        assignments: [],
        results: [],
        dispositions: [],
        attempts: [],
        deliveries: [],
        createdAt: now,
        updatedAt: now,
      };
      return { path, state, store: new WorkstreamStoreEffects(path, input.coordinator) };
    }).pipe(
      Effect.flatMap(({ path, state, store }) =>
        claimWorkstreamDirectory(path).pipe(
          Effect.andThen(
            store.write(state).pipe(
              Effect.catch((error) =>
                removeWorkstreamDirectory(path).pipe(
                  Effect.matchEffect({
                    onFailure: (cleanupError) =>
                      Effect.fail(
                        new WorkstreamStoreOperationError({
                          code: "workstream_store_operation_failed",
                          message: "Workstream creation and cleanup both failed.",
                          cause: new AggregateError([error, cleanupError]),
                        }),
                      ),
                    onSuccess: () => Effect.fail(error),
                  }),
                ),
              ),
            ),
          ),
          Effect.as({ store, state: structuredClone(state) }),
        ),
      ),
    );
  }

  static open(path: string, owner: SessionIdentity): WorkstreamStoreEffects {
    validateSession(owner);
    return new WorkstreamStoreEffects(resolve(path), owner);
  }

  static inspect(path: string): StoreEffect<WorkstreamState> {
    const resolvedPath = resolve(path);
    return new AtomicWorkstreamFile(resolvedPath, () => undefined).readState();
  }

  /**
   * Read a startup pointer without writes or ownership changes.
   * A canonical terminal envelope from a known workstream version may be retained
   * without applying the current mutable schema or adopting its ownership.
   */
  static inspectForReattachment(path: string): StoreEffect<WorkstreamReattachmentInspection> {
    const resolvedPath = resolve(path);
    return new AtomicWorkstreamFile(resolvedPath, () => undefined)
      .readObject()
      .pipe(
        Effect.flatMap((value) =>
          domainEffect(() => inspectReattachmentValue(value, resolvedPath)),
        ),
      );
  }

  load(): StoreEffect<WorkstreamState> {
    return this.file
      .readState()
      .pipe(Effect.tap((state) => domainEffect(() => this.assertOwner(state))));
  }

  recordInputEvent(input: {
    id?: string;
    sessionId: string;
    sessionFile: string;
    source: HumanInputSource;
    text: string;
    now?: Date;
  }): StoreEffect<{ state: WorkstreamState; receipt: HumanInputReceipt }> {
    let receipt: HumanInputReceipt | undefined;
    return this.prepared(
      () => {
        if (input.source === "extension")
          throw new Error("Extension-generated input cannot create human authority.");
        validateSession(input);
        requireText(input.text, "Human input");
        return { id: input.id ?? randomUUID(), source: input.source };
      },
      (prepared) =>
        this.update(
          (draft, now) => {
            receipt = recordInputTransition(draft, {
              id: prepared.id,
              owner: input,
              source: prepared.source,
              text: input.text,
              receivedAt: (input.now ?? now).toISOString(),
            });
          },
          input.now,
          ["active", "suspended"],
        ).pipe(
          Effect.flatMap((state) =>
            domainEffect(() => {
              if (!receipt) throw new Error("Human input receipt was not recorded.");
              return { state, receipt };
            }),
          ),
        ),
    );
  }

  setLifecycle(input: {
    state: "active" | "suspended" | "abandoned" | "archived";
    reason: string;
    now?: Date;
  }): StoreEffect<WorkstreamState> {
    return this.prepared(
      () => requireText(input.reason, "Lifecycle reason"),
      () =>
        this.update(
          (draft, now) => {
            const from = draft.lifecycle.state;
            const allowed =
              from === "active"
                ? ["suspended", "abandoned", "archived"]
                : from === "suspended"
                  ? ["active", "abandoned", "archived"]
                  : [];
            if (!allowed.includes(input.state))
              throw new Error(
                `Cannot transition workstream lifecycle from ${from} to ${input.state}.`,
              );
            draft.lifecycle = {
              state: input.state,
              changedAt: (input.now ?? now).toISOString(),
              reason: input.reason.trim(),
            };
          },
          input.now,
          ["active", "suspended"],
        ),
    );
  }

  reviseIntent(input: {
    authorityReceiptId: string;
    statement: string;
    constraints: string[];
    now?: Date;
  }): StoreEffect<WorkstreamState> {
    return this.prepared(
      () => {
        requireText(input.statement, "Intent statement");
        requireTexts(input.constraints, "Intent constraints");
      },
      () =>
        this.update((draft, now) => {
          requireReceipt(draft, input.authorityReceiptId);
          const current = currentIntent(draft);
          draft.intents.push({
            version: current.version + 1,
            statement: input.statement.trim(),
            constraints: input.constraints.map((item) => item.trim()),
            authorityReceiptIds: [input.authorityReceiptId],
            recordedAt: (input.now ?? now).toISOString(),
          });
        }, input.now),
    );
  }

  assign(input: AssignmentInput & { now?: Date }): StoreEffect<WorkstreamState> {
    return this.update((draft, now) => addAssignment(draft, input, now), input.now);
  }

  enqueue(
    input: AssignmentInput,
    attempts:
      | {
          id: string;
          uuidAlias?: string;
          models: NonNullable<WorkAttempt["models"]>;
          continuationOf?: string;
          baseRevision?: string;
        }
      | Array<{
          id: string;
          uuidAlias?: string;
          models: NonNullable<WorkAttempt["models"]>;
          continuationOf?: string;
          baseRevision?: string;
        }>,
  ): StoreEffect<WorkstreamState> {
    return this.update((draft, now) => {
      addAssignment(draft, input, now);
      const entries = Array.isArray(attempts) ? attempts : [attempts];
      if (entries.length === 0) throw new Error("At least one attempt is required.");
      for (const attempt of entries) {
        validateId(attempt.id, "Attempt id");
        if (draft.attempts.some((item) => item.id === attempt.id))
          throw new Error("Duplicate attempt.");
        if (
          attempt.continuationOf !== undefined &&
          !draft.attempts.some(
            (item) =>
              item.id === attempt.continuationOf &&
              item.state === "settled" &&
              item.cleanup?.state === "completed" &&
              item.sessionFile !== undefined,
          )
        )
          throw new Error(
            "Continuation requires a settled, cleaned worker trajectory; retained blocked work must be inspected first.",
          );
        draft.attempts.push({
          ...attempt,
          assignmentId: input.id,
          state: "queued",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
      }
    });
  }

  retainResult(input: ResultInput & { now?: Date }): StoreEffect<WorkstreamState> {
    return this.prepared(
      () => validateId(input.id, "Result id"),
      () =>
        this.update(
          (draft, now) => {
            const assignment = requireAssignment(draft, input.assignmentId);
            const { now: _now, artifacts = [], ...fields } = input;
            validateArtifactsForAssignment(
              assignment,
              artifacts,
              input.validity === "typed" && input.report.status === "completed"
                ? "typed"
                : "absent",
            );
            retainResultTransition(draft, {
              ...fields,
              artifacts,
              observedAt: (input.now ?? now).toISOString(),
            });
          },
          input.now,
          ["active", "suspended"],
        ),
    );
  }

  retainResultPendingArtifacts(input: {
    attemptId: string;
    id: string;
    assignmentId: string;
    assignmentIntentVersion: number;
    report: Extract<WorkResult, { validity: "typed" }>["report"];
    sourceRoot: string;
    sourceIdentity: string;
    expectedHead: string;
    destinationRoot: string;
    stagingRoot: string;
    required: string[];
    now?: Date;
  }): StoreEffect<WorkstreamState> {
    return this.prepared(
      () => validateId(input.id, "Result id"),
      () =>
        this.update(
          (draft, now) => {
            const attempt = draft.attempts.find((item) => item.id === input.attemptId);
            if (!attempt) throw new Error(`Unknown attempt ${input.attemptId}.`);
            const assignment = requireAssignment(draft, input.assignmentId);
            if (
              assignment.artifactIntent !== "disposable_experiment" ||
              attempt.assignmentId !== assignment.id ||
              input.assignmentIntentVersion !== assignment.intentVersion ||
              input.report.status !== "completed" ||
              !sameValue(input.required, assignment.artifactPolicy.retain)
            )
              throw new Error(
                "Pending artifact retention does not match its experiment assignment.",
              );
            retainResultTransition(draft, {
              id: input.id,
              assignmentId: input.assignmentId,
              assignmentIntentVersion: input.assignmentIntentVersion,
              validity: "typed",
              report: structuredClone(input.report),
              artifacts: [],
              observedAt: (input.now ?? now).toISOString(),
            });
            attempt.artifactRetention = {
              state: "pending",
              resultId: input.id,
              assignmentIntentVersion: input.assignmentIntentVersion,
              sourceRoot: input.sourceRoot,
              sourceIdentity: input.sourceIdentity,
              expectedHead: input.expectedHead,
              destinationRoot: input.destinationRoot,
              stagingRoot: input.stagingRoot,
              required: [...input.required],
            };
          },
          input.now,
          ["active", "suspended"],
        ),
    );
  }

  startAttempt(input: {
    id: string;
    placement?: Static<typeof AttemptPlacementSchema>;
    worktreePath?: string;
    branch?: string;
    baseRevision?: string;
    now?: Date;
  }): StoreEffect<WorkstreamState> {
    return this.prepared(
      () =>
        input.placement ?? {
          kind: "isolated_worktree" as const,
          path: requireTextValue(input.worktreePath, "worktree"),
          branch: requireTextValue(input.branch, "branch"),
        },
      (placement) =>
        this.changeAttempt(
          input.id,
          (attempt) =>
            startAttemptTransition(attempt, {
              id: input.id,
              placement,
              baseRevision: input.baseRevision,
            }),
          input.now,
        ),
    );
  }

  recordSessionFile(id: string, sessionFile: string, now?: Date): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        requireText(sessionFile, "Worker session file");
        if (attempt.sessionFile !== undefined) {
          if (attempt.sessionFile === sessionFile) return;
          throw new Error(`Attempt ${id} has contradictory session identity.`);
        }
        if (attempt.state !== "starting") throw new Error(`Attempt ${id} is not starting.`);
        attempt.sessionFile = sessionFile;
      },
      now,
    );
  }

  recordLaunchPane(
    id: string,
    launchPane: NonNullable<WorkAttempt["launchPane"]>,
    now?: Date,
  ): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        if (!["starting", "running"].includes(attempt.state)) {
          if (attempt.launchPane && sameValue(attempt.launchPane, launchPane)) return;
          throw new Error(`Attempt ${id} is not accepting launch placement.`);
        }
        if (attempt.launchPane && !sameValue(attempt.launchPane, launchPane))
          throw new Error(`Attempt ${id} has contradictory launch placement.`);
        attempt.launchPane = launchPane;
      },
      now,
    );
  }

  recordResource(
    id: string,
    resource: NonNullable<WorkAttempt["resource"]>,
    now?: Date,
  ): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        if (!["starting", "running"].includes(attempt.state)) {
          if (attempt.resource && sameValue(attempt.resource, resource)) return;
          throw new Error(`Attempt ${id} is not accepting a resource.`);
        }
        if (attempt.resource !== undefined && !sameValue(attempt.resource, resource))
          throw new Error(`Attempt ${id} has contradictory resource identity.`);
        attempt.resource = resource;
      },
      now,
    );
  }

  recordWorker(
    id: string,
    worker: NonNullable<WorkAttempt["worker"]>,
    now?: Date,
  ): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        if (attempt.worker !== undefined) {
          if (sameValue(attempt.worker, worker)) return;
          throw new Error(`Attempt ${id} has contradictory worker identity.`);
        }
        if (attempt.sessionFile === undefined)
          throw new Error("Worker identity requires a session file.");
        if (!["starting", "running"].includes(attempt.state))
          throw new Error(`Attempt ${id} is not accepting worker identity.`);
        attempt.worker = worker;
      },
      now,
    );
  }

  markSubmission(
    id: string,
    state: NonNullable<WorkAttempt["submission"]>,
    now?: Date,
  ): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        if (attempt.sessionFile === undefined)
          throw new Error("Submission state requires a session file.");
        const previous = attempt.submission ?? "not_sent";
        const allowed =
          (previous === "not_sent" && state === "uncertain") ||
          (previous === "uncertain" && ["submitted", "started"].includes(state)) ||
          (previous === "submitted" && state === "started") ||
          previous === state;
        if (!allowed) throw new Error(`Cannot transition submission from ${previous} to ${state}.`);
        attempt.submission = state;
        if (state === "submitted") attempt.state = "running";
        if (state === "started" && attempt.state === "starting") attempt.state = "running";
      },
      now,
    );
  }

  settleAttempt(input: {
    id: string;
    resultId: string;
    effectiveModels: NonNullable<WorkAttempt["effectiveModels"]>;
    now?: Date;
  }): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      input.id,
      (attempt, draft) => {
        if (attempt.sessionFile === undefined)
          throw new Error("Settlement requires a session file.");
        if (!draft.results.some((result) => result.id === input.resultId))
          throw new Error(`Settlement references unknown result ${input.resultId}.`);
        if (attempt.state === "settled" || attempt.state === "cancelled") {
          if (
            attempt.resultId === input.resultId &&
            sameValue(attempt.effectiveModels, input.effectiveModels)
          )
            return;
          throw new Error(`Attempt ${input.id} has an immutable settlement.`);
        }
        if (!["running", "starting", "cancel_requested"].includes(attempt.state))
          throw new Error(`Attempt ${input.id} is not settleable.`);
        attempt.state = attempt.state === "cancel_requested" ? "cancelled" : "settled";
        attempt.resultId = input.resultId;
        attempt.effectiveModels = input.effectiveModels;
      },
      input.now,
    );
  }

  recordAttention(id: string, detail: string, now?: Date): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt, _draft, current) => {
        requireText(detail, "Attention detail");
        if (attempt.error === detail) return;
        attempt.error = detail;
        attempt.attentionHistory ??= [];
        attempt.attentionHistory.push({
          detail: detail.trim(),
          at: current.toISOString(),
        });
      },
      now,
    );
  }

  clearAttention(id: string, now?: Date): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        delete attempt.error;
      },
      now,
    );
  }

  beginComposition(input: {
    id: string;
    commit: string;
    expectedHead: string;
    now?: Date;
  }): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      input.id,
      (attempt) => {
        if (attempt.composition) {
          if (
            attempt.composition.state === "pending" &&
            attempt.composition.commit === input.commit &&
            attempt.composition.expectedHead === input.expectedHead
          )
            return;
          throw new Error(`Composition for ${input.id} is already recorded.`);
        }
        attempt.composition = {
          state: "pending",
          commit: input.commit,
          expectedHead: input.expectedHead,
        };
      },
      input.now,
    );
  }

  retryComposition(id: string, now?: Date, retainedRef?: string): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        const composition = attempt.composition;
        if (composition?.state !== "blocked")
          throw new Error(`Composition for ${id} is not blocked.`);
        const nextComposition: NonNullable<WorkAttempt["composition"]> = {
          state: "pending",
          commit: composition.commit,
          expectedHead: composition.expectedHead,
        };
        const nextRetainedRef = retainedRef ?? composition.retainedRef;
        if (nextRetainedRef !== undefined) nextComposition.retainedRef = nextRetainedRef;
        attempt.composition = nextComposition;
      },
      now,
    );
  }

  retainFailedProposalNotApplied(input: {
    id: string;
    commit: string;
    expectedHead: string;
    reason: string;
    retainedRef: string;
    integratedRevision: string;
    now?: Date;
  }): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      input.id,
      (attempt, draft) => {
        requireText(input.commit, "Failed proposal commit");
        requireText(input.expectedHead, "Failed proposal expected HEAD");
        requireText(input.reason, "Failed proposal retention reason");
        requireText(input.retainedRef, "Failed proposal retained ref");
        requireText(input.integratedRevision, "Integrated revision");
        if (attempt.composition !== undefined)
          throw new Error(`Composition for ${input.id} is already recorded.`);
        const assignment = requireAssignment(draft, attempt.assignmentId);
        const result = draft.results.find((item) => item.id === attempt.resultId);
        if (
          assignment.capability !== "implement" ||
          assignment.artifactIntent !== "maintained_change" ||
          result?.validity !== "typed" ||
          result.report.kind !== "implementation" ||
          result.report.status !== "failed"
        )
          throw new Error(
            `Attempt ${input.id} has no typed failed implementation proposal to retain.`,
          );
        if (result.artifacts.length > 0)
          throw new Error(`Result ${result.id} already has retained artifacts.`);
        const commit = input.commit.trim();
        const retainedRef = input.retainedRef.trim();
        attempt.composition = {
          state: "retained_not_applied",
          commit,
          expectedHead: input.expectedHead.trim(),
          reason: input.reason.trim(),
          retainedRef,
          integratedRevision: input.integratedRevision.trim(),
        };
        result.artifacts = [
          {
            id: "failed-proposal",
            kind: "revision",
            reference: commit,
            retention: "retained",
            summary: `Failed implementation proposal retained at ${retainedRef}; it was not applied.`,
          },
        ];
      },
      input.now,
    );
  }

  retainCompositionNotApplied(input: {
    id: string;
    reason: string;
    retainedRef: string;
    integratedRevision: string;
    now?: Date;
  }): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      input.id,
      (attempt) => {
        requireText(input.reason, "Retained-not-applied reason");
        requireText(input.retainedRef, "Retained commit ref");
        requireText(input.integratedRevision, "Integrated revision");
        const composition = attempt.composition;
        if (composition?.state !== "blocked")
          throw new Error(`Composition for ${input.id} is not blocked.`);
        attempt.composition = {
          ...composition,
          state: "retained_not_applied",
          reason: input.reason.trim(),
          retainedRef: input.retainedRef.trim(),
          integratedRevision: input.integratedRevision.trim(),
        };
      },
      input.now,
    );
  }

  finishComposition(id: string, revision: string, now?: Date): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        const composition = attempt.composition;
        if (composition?.state === "composed") {
          if (composition.revision === revision) return;
          throw new Error(`Composition for ${id} has an immutable revision.`);
        }
        if (composition?.state !== "pending")
          throw new Error(`Composition for ${id} is not pending.`);
        attempt.composition = { ...composition, state: "composed", revision };
      },
      now,
    );
  }

  blockComposition(id: string, error: string, now?: Date): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        requireText(error, "Composition error");
        const composition = attempt.composition;
        if (composition?.state === "blocked") {
          if (composition.error === error.trim()) return;
          throw new Error(`Composition for ${id} has contradictory failure evidence.`);
        }
        if (composition?.state !== "pending")
          throw new Error(`Composition for ${id} is not pending.`);
        attempt.composition = {
          ...composition,
          state: "blocked",
          error: error.trim(),
        };
      },
      now,
    );
  }

  beginCleanup(input: {
    id: string;
    expectedHead?: string;
    discard: boolean;
    now?: Date;
  }): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      input.id,
      (attempt) => beginCleanupTransition(attempt, input),
      input.now,
    );
  }

  markWorkerClosed(id: string, now?: Date): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt, draft) => {
        if (isLegacyArtifactRetentionFailure(draft, attempt))
          throw new Error(legacyArtifactRetentionLimitation());
        if (attempt.cleanup?.state === "completed") return;
        if (attempt.cleanup?.state !== "pending")
          throw new Error(`Cleanup for ${id} is not pending.`);
        if (attempt.cleanup.workerClosed === true) return;
        attempt.cleanup = { ...attempt.cleanup, workerClosed: true };
      },
      now,
    );
  }

  retryArtifactRetention(id: string, now?: Date): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        const retention = attempt.artifactRetention;
        if (retention === undefined || retention.state !== "blocked")
          throw new Error(`Artifact retention for ${id} is not blocked.`);
        attempt.artifactRetention = { ...retention, state: "pending" };
        delete attempt.artifactRetention.error;
      },
      now,
    );
  }

  finishArtifactRetention(
    id: string,
    artifacts: RetainedArtifact[],
    now?: Date,
  ): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt, draft) => {
        const retention = attempt.artifactRetention;
        if (retention?.state === "completed") {
          const result = draft.results.find((item) => item.id === retention.resultId);
          if (result && sameValue(result.artifacts, artifacts)) return;
          throw new Error(`Artifact retention for ${id} has contradictory completion evidence.`);
        }
        if (retention?.state !== "pending")
          throw new Error(`Artifact retention for ${id} is not pending.`);
        const result = draft.results.find((item) => item.id === retention.resultId);
        if (!result) throw new Error(`Unknown result ${retention.resultId}.`);
        if (result.artifacts.length > 0 && !sameValue(result.artifacts, artifacts))
          throw new Error(`Result ${result.id} artifacts are immutable after retention.`);
        result.artifacts = structuredClone(artifacts);
        attempt.artifactRetention = { ...retention, state: "completed" };
        delete attempt.artifactRetention.error;
      },
      now,
    );
  }

  blockArtifactRetention(id: string, error: string, now?: Date): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        requireText(error, "Artifact retention error");
        const retention = attempt.artifactRetention;
        if (retention === undefined || retention.state === "completed")
          throw new Error(`Artifact retention for ${id} is not blockable.`);
        if (retention.state === "blocked" && retention.error === error.trim()) return;
        if (retention.state === "blocked")
          throw new Error(`Artifact retention for ${id} has contradictory failure evidence.`);
        attempt.artifactRetention = {
          ...retention,
          state: "blocked",
          error: error.trim(),
        };
      },
      now,
    );
  }

  retryCleanup(id: string, now?: Date): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt, draft) => {
        if (isLegacyArtifactRetentionFailure(draft, attempt))
          throw new Error(legacyArtifactRetentionLimitation());
        const cleanup = attempt.cleanup;
        if (cleanup === undefined || cleanup.state !== "blocked")
          throw new Error(`Cleanup for ${id} is not blocked.`);
        attempt.cleanup = { ...cleanup, state: "pending" };
        delete attempt.cleanup.error;
      },
      now,
    );
  }

  finishCleanup(id: string, now?: Date): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt, draft) => {
        if (isLegacyArtifactRetentionFailure(draft, attempt))
          throw new Error(legacyArtifactRetentionLimitation());
        if (attempt.cleanup?.state === "completed") return;
        if (attempt.cleanup?.state !== "pending" || !attempt.cleanup.workerClosed)
          throw new Error(`Cleanup for ${id} requires a closed worker.`);
        attempt.cleanup = { ...attempt.cleanup, state: "completed" };
      },
      now,
    );
  }

  blockCleanup(id: string, error: string, now?: Date): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        requireText(error, "Cleanup error");
        if (!attempt.cleanup) throw new Error(`Cleanup for ${id} is not recorded.`);
        if (attempt.cleanup.state === "completed")
          throw new Error(`Cleanup for ${id} is already completed.`);
        if (attempt.cleanup.state === "blocked") {
          if (attempt.cleanup.error === error.trim()) return;
          throw new Error(`Cleanup for ${id} has contradictory failure evidence.`);
        }
        attempt.cleanup = {
          ...attempt.cleanup,
          state: "blocked",
          error: error.trim(),
        };
      },
      now,
    );
  }

  recordSteering(
    id: string,
    text: string,
    state: "uncertain" | "submitted",
    now?: Date,
  ): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        requireText(text, "Steering instruction");
        if (!attempt.worker) throw new Error("Steering requires a worker identity.");
        if (state === "submitted" && attempt.steering?.state !== "uncertain")
          throw new Error("Submitted steering requires an uncertain submission record.");
        attempt.steering = { text: text.trim(), state };
      },
      now,
    );
  }

  cancelAttempt(id: string, now?: Date): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        if (attempt.state === "queued") {
          attempt.state = "cancelled";
          return;
        }
        if (!["starting", "running"].includes(attempt.state))
          throw new Error(`Attempt ${id} is not active.`);
        attempt.state = "cancel_requested";
      },
      now,
    );
  }

  private changeAttempt(
    id: string,
    mutator: (attempt: WorkAttempt, draft: WorkstreamState, now: Date) => void,
    suppliedNow?: Date,
  ): StoreEffect<WorkstreamState> {
    return this.update(
      (draft, now) => {
        const attempt = draft.attempts.find((candidate) => candidate.id === id);
        if (!attempt) throw new Error(`Unknown attempt ${id}.`);
        mutator(attempt, draft, suppliedNow ?? now);
        attempt.updatedAt = (suppliedNow ?? now).toISOString();
      },
      suppliedNow,
      ["active", "suspended"],
    );
  }

  requestDelivery(resultId: string, now?: Date): StoreEffect<WorkstreamState> {
    return this.update(
      (draft, current) => {
        if (!draft.results.some((result) => result.id === resultId))
          throw new Error(`Unknown result ${resultId}.`);
        if (!draft.deliveries.some((delivery) => delivery.resultId === resultId)) {
          draft.deliveries.push({
            resultId,
            state: "pending",
            requestedAt: (now ?? current).toISOString(),
          });
        }
      },
      now,
      ["active", "suspended"],
    );
  }

  deliveryAttempt(resultId: string, owner: string, error?: string): StoreEffect<WorkstreamState> {
    return this.update(
      (draft, now) => {
        const delivery = draft.deliveries.find((item) => item.resultId === resultId);
        if (!delivery) throw new Error(`Unknown delivery ${resultId}.`);
        delivery.attemptedBy = owner;
        if (error !== undefined) {
          requireText(error, "Delivery failure");
          delivery.error = error.trim();
          delivery.failureHistory ??= [];
          delivery.failureHistory.push({
            at: now.toISOString(),
            detail: error.trim(),
          });
        }
      },
      undefined,
      ["active", "suspended"],
    );
  }

  addResultArtifacts(
    resultId: string,
    artifacts: RetainedArtifact[],
  ): StoreEffect<WorkstreamState> {
    return this.update(
      (draft) => {
        const result = draft.results.find((item) => item.id === resultId);
        if (!result) throw new Error(`Unknown result ${resultId}.`);
        if (sameValue(result.artifacts, artifacts)) return;
        if (result.artifacts.length === 0) {
          result.artifacts = artifacts;
          return;
        }
        throw new Error(`Result ${resultId} artifacts are immutable after retention.`);
      },
      undefined,
      ["active", "suspended"],
    );
  }

  /**
   * Record accepted notification enqueue or direct result-tool presentation.
   * Pi provides no queued-follow-up presentation receipt; this shared delivery
   * state alone proves neither queued presentation nor coordinator inspection.
   */
  markDelivered(resultId: string, now?: Date): StoreEffect<WorkstreamState> {
    return this.update(
      (draft, current) => {
        const delivery = draft.deliveries.find((candidate) => candidate.resultId === resultId);
        if (!delivery) throw new Error(`Result ${resultId} is not pending delivery.`);
        if (delivery.state !== "pending") return;
        delivery.state = "delivered";
        delivery.deliveredAt = (now ?? current).toISOString();
        delete delivery.error;
      },
      now,
      ["active", "suspended"],
    );
  }

  acknowledge(resultId: string, acknowledgment: string, now?: Date): StoreEffect<WorkstreamState> {
    return this.update(
      (draft, current) => {
        requireText(acknowledgment, "Acknowledgment");
        const delivery = draft.deliveries.find((candidate) => candidate.resultId === resultId);
        if (!delivery) throw new Error(`Unknown delivery ${resultId}.`);
        if (delivery.state === "acknowledged") return;
        // Explicit receipt also covers evidence read through status after an uncertain notification.
        // Do not invent deliveredAt: notification transport and coordinator receipt are different facts.
        delivery.state = "acknowledged";
        delete delivery.error;
        delivery.acknowledgedAt = (now ?? current).toISOString();
        delivery.acknowledgment = acknowledgment.trim();
      },
      now,
      ["active", "suspended"],
    );
  }

  disposition(input: {
    resultId: string;
    status: ResultDisposition["status"];
    reason: string;
    now?: Date;
  }): StoreEffect<WorkstreamState> {
    return this.update((draft, now) => {
      requireText(input.reason, "Disposition reason");
      requireActive(draft);
      if (!draft.results.some((result) => result.id === input.resultId))
        throw new Error(`Unknown result ${input.resultId}.`);
      draft.dispositions.push({
        resultId: input.resultId,
        status: input.status,
        reason: input.reason.trim(),
        recordedAt: (input.now ?? now).toISOString(),
      });
    }, input.now);
  }

  complete(input: {
    conclusion: string;
    evidence: Static<typeof EvidenceSchema>[];
    limitations: string[];
    /** One reason per unresolved semantic task; mechanical entries are derived below. */
    reasons: Array<{ taskId: string; reason: string }>;
    now?: Date;
  }): StoreEffect<WorkstreamState> {
    return this.update((draft, now) => {
      requireText(input.conclusion, "Completion conclusion");
      if (
        input.evidence.length === 0 ||
        !input.evidence.every((item) => Value.Check(EvidenceSchema, item))
      )
        throw new Error("Completion requires valid evidence.");
      requireTexts(input.limitations, "Completion limitations");
      requireActive(draft);
      if (draft.attempts.some(hasActiveOrUncleanAttempt)) {
        throw new Error(
          "Complete only after workers and owned resources have settled and cleaned up.",
        );
      }
      const expectedAccounting = deriveCompletionAccounting(draft);
      const expectedTasks = [
        ...new Set(
          expectedAccounting
            .map((entry) => accountingTaskId(draft, entry))
            .filter((taskId): taskId is string => taskId !== undefined),
        ),
      ];
      const reasonKeys = input.reasons.map((item) => item.taskId);
      if (
        reasonKeys.length !== new Set(reasonKeys).size ||
        input.reasons.some(
          (item) =>
            !draft.assignments.some((assignment) => assignment.id === item.taskId) ||
            !item.reason.trim(),
        ) ||
        expectedTasks.some((taskId) => !reasonKeys.includes(taskId)) ||
        reasonKeys.some((taskId) => !expectedTasks.includes(taskId))
      )
        throw new Error(
          `Completion requires exactly one reason per unresolved semantic task: ${expectedTasks.join(", ") || "none"}.`,
        );
      const reasonByTask = new Map(input.reasons.map((item) => [item.taskId, item.reason.trim()]));
      // Every mechanical unresolved entry inherits the reason of its semantic task.
      const resolvedAccounting = expectedAccounting.map((entry) => ({
        ...entry,
        reason: reasonByTask.get(accountingTaskId(draft, entry) ?? "") ?? entry.reason,
      }));
      const completedAt = (input.now ?? now).toISOString();
      draft.completion = {
        conclusion: input.conclusion.trim(),
        evidence: structuredClone(input.evidence),
        limitations: input.limitations.map((item) => item.trim()),
        accounting: resolvedAccounting,
        completedAt,
      };
      draft.lifecycle = {
        state: "completed",
        changedAt: completedAt,
        reason: "Coordinator completed the workstream with retained evidence.",
      };
    }, input.now);
  }

  isAssignmentCurrent(state: WorkstreamState, assignmentId: string): boolean {
    return requireAssignment(state, assignmentId).intentVersion === currentIntent(state).version;
  }

  isResultCurrent(state: WorkstreamState, resultId: string): boolean {
    const result = state.results.find((candidate) => candidate.id === resultId);
    if (!result) throw new Error(`Unknown result ${resultId}.`);
    return result.assignmentIntentVersion === currentIntent(state).version;
  }

  private prepared<Preparation, Success>(
    prepare: () => Preparation,
    operation: (prepared: Preparation) => StoreEffect<Success>,
  ): StoreEffect<Success> {
    return domainEffect(prepare).pipe(Effect.flatMap(operation));
  }

  private update(
    mutator: (draft: WorkstreamState, now: Date) => void,
    suppliedNow?: Date,
    allowedLifecycleStates: WorkstreamState["lifecycle"]["state"][] = ["active"],
  ): StoreEffect<WorkstreamState> {
    return this.writeSemaphore.withPermit(
      this.performUpdate(mutator, suppliedNow, allowedLifecycleStates),
    );
  }

  private performUpdate(
    mutator: (draft: WorkstreamState, now: Date) => void,
    suppliedNow: Date | undefined,
    allowedLifecycleStates: WorkstreamState["lifecycle"]["state"][],
  ): StoreEffect<WorkstreamState> {
    return domainEffect(() => this.mutationGuard?.()).pipe(
      Effect.andThen(this.file.readState()),
      Effect.flatMap((current) =>
        domainEffect(() => {
          this.assertOwner(current);
          if (!allowedLifecycleStates.includes(current.lifecycle.state))
            throw new Error(`Workstream is ${current.lifecycle.state}.`);
          return transitionWorkstreamState(current, mutator, suppliedNow ?? currentDate());
        }).pipe(Effect.flatMap((draft) => this.persistTransition(current, draft))),
      ),
    );
  }

  private persistTransition(
    current: WorkstreamState,
    draft: WorkstreamState,
  ): StoreEffect<WorkstreamState> {
    if (draft.revision === current.revision) return Effect.succeed(draft);
    return this.write(draft).pipe(Effect.as(structuredClone(draft)));
  }

  private assertOwner(state: WorkstreamState): void {
    if (
      state.coordinator.sessionId !== this.owner.sessionId ||
      state.coordinator.sessionFile !== this.owner.sessionFile
    ) {
      throw new Error("Workstream mutation owner does not match the bound coordinator.");
    }
  }

  private write(state: WorkstreamState): StoreEffect<void> {
    return this.file.writeState(state);
  }
}

type EffectOperationKeys = {
  [Key in keyof WorkstreamStoreEffects]: WorkstreamStoreEffects[Key] extends (
    ...args: never[]
  ) => StoreEffect<unknown>
    ? Key
    : never;
}[keyof WorkstreamStoreEffects];

type PromiseOperation<Operation> = Operation extends (
  ...args: infer Args
) => Effect.Effect<infer Success, infer _Error, infer _Requirements>
  ? (...args: Args) => Promise<Success>
  : never;

type WorkstreamPromiseOperations = {
  [Key in EffectOperationKeys]: PromiseOperation<WorkstreamStoreEffects[Key]>;
};

export type WorkstreamStore = WorkstreamPromiseOperations &
  Pick<
    WorkstreamStoreEffects,
    "path" | "bindMutationGuard" | "isAssignmentCurrent" | "isResultCurrent"
  > & {
    /** Primary typed store port. Promise methods on this facade are temporary outward adapters. */
    readonly effects: WorkstreamStoreEffects;
  };

type CreateInput = Parameters<typeof WorkstreamStoreEffects.create>[0];

interface WorkstreamStoreStatic {
  pathFor(gitCommonDir: string, id: string): string;
  create(input: CreateInput): Promise<{ store: WorkstreamStore; state: WorkstreamState }>;
  open(path: string, owner: SessionIdentity): WorkstreamStore;
  inspect(path: string): Promise<WorkstreamState>;
  inspectForReattachment(path: string): Promise<WorkstreamReattachmentInspection>;
}

export const WorkstreamStore: WorkstreamStoreStatic = {
  pathFor: (gitCommonDir, id) => WorkstreamStoreEffects.pathFor(gitCommonDir, id),
  create: (input) =>
    runStorePromise(WorkstreamStoreEffects.create(input)).then(({ store, state }) => ({
      store: promiseFacade(store),
      state,
    })),
  open: (path, owner) => promiseFacade(WorkstreamStoreEffects.open(path, owner)),
  inspect: (path) => runStorePromise(WorkstreamStoreEffects.inspect(path)),
  inspectForReattachment: (path) =>
    runStorePromise(WorkstreamStoreEffects.inspectForReattachment(path)),
};

function promiseFacade(effects: WorkstreamStoreEffects): WorkstreamStore {
  return {
    effects,
    path: effects.path,
    bindMutationGuard: (guard) => effects.bindMutationGuard(guard),
    isAssignmentCurrent: (state, assignmentId) => effects.isAssignmentCurrent(state, assignmentId),
    isResultCurrent: (state, resultId) => effects.isResultCurrent(state, resultId),
    adopt: promiseOperation((...args) => effects.adopt(...args)),
    load: promiseOperation((...args) => effects.load(...args)),
    recordInputEvent: promiseOperation((...args) => effects.recordInputEvent(...args)),
    setLifecycle: promiseOperation((...args) => effects.setLifecycle(...args)),
    reviseIntent: promiseOperation((...args) => effects.reviseIntent(...args)),
    assign: promiseOperation((...args) => effects.assign(...args)),
    enqueue: promiseOperation((...args) => effects.enqueue(...args)),
    retainResult: promiseOperation((...args) => effects.retainResult(...args)),
    retainResultPendingArtifacts: promiseOperation((...args) =>
      effects.retainResultPendingArtifacts(...args),
    ),
    startAttempt: promiseOperation((...args) => effects.startAttempt(...args)),
    recordSessionFile: promiseOperation((...args) => effects.recordSessionFile(...args)),
    recordLaunchPane: promiseOperation((...args) => effects.recordLaunchPane(...args)),
    recordResource: promiseOperation((...args) => effects.recordResource(...args)),
    recordWorker: promiseOperation((...args) => effects.recordWorker(...args)),
    markSubmission: promiseOperation((...args) => effects.markSubmission(...args)),
    settleAttempt: promiseOperation((...args) => effects.settleAttempt(...args)),
    recordAttention: promiseOperation((...args) => effects.recordAttention(...args)),
    clearAttention: promiseOperation((...args) => effects.clearAttention(...args)),
    beginComposition: promiseOperation((...args) => effects.beginComposition(...args)),
    retryComposition: promiseOperation((...args) => effects.retryComposition(...args)),
    retainFailedProposalNotApplied: promiseOperation((...args) =>
      effects.retainFailedProposalNotApplied(...args),
    ),
    retainCompositionNotApplied: promiseOperation((...args) =>
      effects.retainCompositionNotApplied(...args),
    ),
    finishComposition: promiseOperation((...args) => effects.finishComposition(...args)),
    blockComposition: promiseOperation((...args) => effects.blockComposition(...args)),
    beginCleanup: promiseOperation((...args) => effects.beginCleanup(...args)),
    markWorkerClosed: promiseOperation((...args) => effects.markWorkerClosed(...args)),
    retryArtifactRetention: promiseOperation((...args) => effects.retryArtifactRetention(...args)),
    finishArtifactRetention: promiseOperation((...args) =>
      effects.finishArtifactRetention(...args),
    ),
    blockArtifactRetention: promiseOperation((...args) => effects.blockArtifactRetention(...args)),
    retryCleanup: promiseOperation((...args) => effects.retryCleanup(...args)),
    finishCleanup: promiseOperation((...args) => effects.finishCleanup(...args)),
    blockCleanup: promiseOperation((...args) => effects.blockCleanup(...args)),
    recordSteering: promiseOperation((...args) => effects.recordSteering(...args)),
    cancelAttempt: promiseOperation((...args) => effects.cancelAttempt(...args)),
    requestDelivery: promiseOperation((...args) => effects.requestDelivery(...args)),
    deliveryAttempt: promiseOperation((...args) => effects.deliveryAttempt(...args)),
    addResultArtifacts: promiseOperation((...args) => effects.addResultArtifacts(...args)),
    markDelivered: promiseOperation((...args) => effects.markDelivered(...args)),
    acknowledge: promiseOperation((...args) => effects.acknowledge(...args)),
    disposition: promiseOperation((...args) => effects.disposition(...args)),
    complete: promiseOperation((...args) => effects.complete(...args)),
  };
}

function promiseOperation<Args extends readonly unknown[], Success>(
  operation: (...args: Args) => StoreEffect<Success>,
): (...args: Args) => Promise<Success> {
  return (...args) => runStorePromise(operation(...args));
}

function runStorePromise<A>(operation: StoreEffect<A>): Promise<A> {
  return Effect.runPromise(operation).catch((failure) => {
    if (failure instanceof WorkstreamStoreOperationError) throw failure.cause;
    throw failure;
  });
}

function inspectReattachmentValue(
  value: JsonObject,
  resolvedPath: string,
): WorkstreamReattachmentInspection {
  const format = value.format;
  const version = value.version;
  if (format === WORKSTREAM_FORMAT && version === WORKSTREAM_STATE_VERSION)
    return inspectCurrentReattachment(value, resolvedPath);
  if (format === WORKSTREAM_FORMAT && isKnownHistoricalWorkstreamVersion(version))
    return inspectHistoricalReattachment(value, resolvedPath, format, version);
  throw new UnsupportedWorkstreamStateError(format, version);
}

function inspectCurrentReattachment(
  value: JsonObject,
  resolvedPath: string,
): WorkstreamReattachmentInspection {
  const state = decodeState(value);
  validateStoredPath(state, resolvedPath);
  return { kind: "current", state: structuredClone(state) };
}

function inspectHistoricalReattachment(
  value: import("./workstream-validation.js").JsonObject,
  resolvedPath: string,
  format: typeof WORKSTREAM_FORMAT,
  version: JsonValue | undefined,
): WorkstreamReattachmentInspection {
  const retained = retainedTerminalInspection(value, resolvedPath);
  if (retained) return retained;
  if (isActiveHistoricalState(value)) throw new UnsupportedWorkstreamStateError(format, version);
  throw new InvalidWorkstreamStateError(
    `Historical workstream state version ${describeJsonValue(version)} cannot be classified as canonical terminal history.`,
  );
}

const DiagnosticStringSchema = Type.String();
const DiagnosticScalarSchema = Type.Union([Type.Number(), Type.Boolean()]);

function describeJsonValue(value: JsonValue | undefined): string {
  if (Value.Check(DiagnosticStringSchema, value)) return JSON.stringify(value.slice(0, 80));
  if (Value.Check(DiagnosticScalarSchema, value)) return String(value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return Array.isArray(value) ? "[array]" : "[object]";
}

export function isLegacyArtifactRetentionFailure(
  state: WorkstreamState,
  attempt: WorkAttempt,
): boolean {
  if (attempt.artifactRetention !== undefined || attempt.resultId === undefined) return false;
  const assignment = state.assignments.find((item) => item.id === attempt.assignmentId);
  const result = state.results.find((item) => item.id === attempt.resultId);
  return (
    assignment?.artifactIntent === "disposable_experiment" &&
    result?.validity === "invalid" &&
    result.detail.startsWith("Artifact retention failed:")
  );
}

export function legacyArtifactRetentionLimitation(): string {
  return "Legacy artifact-retention failure has no independently retained report and source checkpoint; preserve it for inspection rather than inventing validity or retrying cleanup.";
}

function beginCleanupTransition(
  attempt: WorkAttempt,
  input: { expectedHead?: string; discard: boolean; id: string },
): void {
  if (attempt.artifactRetention !== undefined && attempt.artifactRetention.state !== "completed")
    throw new Error(`Cleanup for ${input.id} requires completed artifact retention.`);
  if (attempt.cleanup) {
    if (
      attempt.cleanup.state === "pending" &&
      attempt.cleanup.expectedHead === input.expectedHead &&
      attempt.cleanup.discard === input.discard
    )
      return;
    throw new Error(`Cleanup for ${input.id} is already recorded.`);
  }
  const placement = attempt.placement;
  if (!placement) throw new Error("Cleanup requires an attempt placement.");
  if (placement.kind === "isolated_worktree" && input.expectedHead === undefined)
    throw new Error("Isolated worktree cleanup requires its exact HEAD.");
  if (placement.kind === "shared_project" && input.discard)
    throw new Error("Shared project cleanup cannot discard files.");
  const cleanup: NonNullable<WorkAttempt["cleanup"]> = {
    state: "pending",
    workerClosed: false,
    discard: input.discard,
  };
  if (input.expectedHead !== undefined) cleanup.expectedHead = input.expectedHead;
  attempt.cleanup = cleanup;
}

function retainResultTransition(draft: WorkstreamState, result: WorkResult): void {
  if (draft.results.some((item) => item.id === result.id))
    throw new Error(`Duplicate result ${result.id}.`);
  const assignment = requireAssignment(draft, result.assignmentId);
  if (result.assignmentIntentVersion !== assignment.intentVersion)
    throw new Error("Result intent version does not match its assignment.");
  if (!Value.Check(ResultSchema, result))
    throw new Error("Result input does not satisfy its validity contract.");
  draft.results.push(result);
}

function currentDate(): Date {
  return DateTime.toDate(DateTime.nowUnsafe());
}

function addAssignment(
  draft: WorkstreamState,
  input: AssignmentInput & { now?: Date },
  now: Date,
): void {
  requireText(input.id, "Assignment id");
  requireText(input.objective, "Assignment objective");
  requireActive(draft);
  if (draft.assignments.some((item) => item.id === input.id))
    throw new Error(`Duplicate assignment ${input.id}.`);
  const current = currentIntent(draft);
  if (input.intentVersion !== current.version)
    throw new Error(
      `Intent version ${input.intentVersion} is stale; current version is ${current.version}.`,
    );
  if (input.artifactIntent === "disposable_experiment" || input.capability === "implement") {
    requireAuthority(draft, input.authority);
    if (input.authority.intentVersion !== input.intentVersion)
      throw new Error("Assignment authority intent does not match the assignment intent.");
  }
  if (input.capability === "review") requireSubject(draft, input.subject);
  const { now: suppliedNow, ...fields } = input;
  const assignment = {
    ...fields,
    createdAt: (suppliedNow ?? now).toISOString(),
  };
  if (!Value.Check(AssignmentSchema, assignment))
    throw new Error("Assignment input does not satisfy its capability contract.");
  draft.assignments.push(assignment);
}

function currentIntent(state: WorkstreamState): Intent {
  const intent = state.intents.at(-1);
  if (!intent) throw new InvalidWorkstreamStateError("Workstream has no current intent.");
  return intent;
}

function requireReceipt(state: WorkstreamState, id: string): HumanInputReceipt {
  const receipt = state.inputs.find((candidate) => candidate.id === id);
  if (!receipt) throw new Error(`Unknown human input receipt ${id}.`);
  return receipt;
}

function requireAssignment(state: WorkstreamState, id: string): WorkAssignment {
  const assignment = state.assignments.find((candidate) => candidate.id === id);
  if (!assignment) throw new Error(`Unknown assignment ${id}.`);
  return assignment;
}

function requireAuthority(state: WorkstreamState, authority: AuthorityReference): void {
  validateAuthority(state, authority);
  const current = currentIntent(state);
  if (authority.intentVersion !== current.version)
    throw new Error(
      `Authority intent ${authority.intentVersion} is stale; current version is ${current.version}.`,
    );
  if (!current.authorityReceiptIds.includes(authority.receiptId))
    throw new Error("Authority receipt does not authorize the current intent.");
}

function requireSubject(state: WorkstreamState, subject: ResultSubject): void {
  if (!Value.Check(ResultSubjectSchema, subject))
    throw new Error("Review requires an identified subject.");
  validateSubject(state, subject);
}

function sameValue<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireActive(state: WorkstreamState): void {
  if (state.lifecycle.state !== "active")
    throw new Error(`Workstream is ${state.lifecycle.state}.`);
}

function requireTextValue(value: string | undefined, label: string): string {
  if (value === undefined || value.trim().length === 0) throw new Error(`${label} is required.`);
  return value;
}

function requireTexts(values: string[], label: string): void {
  if (values.some((value) => !value.trim()))
    throw new Error(`${label} cannot contain blank entries.`);
}
