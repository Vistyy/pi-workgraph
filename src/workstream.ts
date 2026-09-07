import { randomUUID } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Legacy source readback is a host filesystem identity check.
import { readFileSync } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Canonical workstream paths use host path identity at the synchronous store boundary.
import { resolve } from "node:path";
import { DateTime, Effect } from "effect";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { EvidenceSchema } from "./report-schema.js";
import {
  assertLegacySourceFile,
  claimWorkstreamDirectory,
  domainEffect,
  isNativeSqliteFile,
  type Lease,
  LeaseDecisionRequiredError,
  readLegacyCurrentState,
  readLegacyObject,
  readLegacyText,
  SqliteWorkstreamDatabase,
  type StoreEffect,
  type WorkstreamStoreError,
  type WorkstreamStoreRequirements,
} from "./workstream-persistence.js";
import {
  AssignmentSchema,
  type AttemptPlacementSchema,
  type AuthorityReference,
  type CandidateLineage,
  CommitSchema,
  type CompletionAccounting,
  type HumanInputReceipt,
  type HumanInputSource,
  type Intent,
  InvalidWorkstreamStateError,
  isLegacyWorkstreamPath,
  pathForWorkstream,
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
} from "./workstream-transitions.js";
import {
  decodeLegacyState,
  decodeState,
  isActiveHistoricalState,
  isKnownHistoricalWorkstreamVersion,
  type JsonObject,
  type JsonValue,
  parsePersistedObject,
  requireText,
  retainedTerminalInspection,
  validateAuthority,
  validateId,
  validateSession,
  validateStoredPath,
  validateSubject,
} from "./workstream-validation.js";

export type {
  AuthorityReference,
  CandidateLineage,
  CompletionAccounting,
  HumanInputReceipt,
  HumanInputSource,
  Intent,
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
  WorkstreamStoreRequirements,
};
export { InvalidWorkstreamStateError, UnsupportedWorkstreamStateError, WorkstreamStateSchema };

type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type AssignmentInput = OmitEach<WorkAssignment, "createdAt">;
type ResultInput = OmitEach<WorkResult, "observedAt" | "artifacts"> & {
  artifacts?: RetainedArtifact[];
};

export class WorkstreamStoreEffects {
  private readonly database: SqliteWorkstreamDatabase;
  private readonly leases = new Map<string, Lease>();
  private lease: Lease | undefined;

  private constructor(
    readonly path: string,
    private owner: SessionIdentity,
    database: SqliteWorkstreamDatabase,
  ) {
    this.database = database;
  }

  /** The SQLite handle is exposed for focused boundary checks, not as a second store API. */
  get db(): SqliteWorkstreamDatabase["db"] {
    return this.database.db;
  }

  adopt(owner: SessionIdentity): StoreEffect<WorkstreamState> {
    return this.prepared(
      () => validateSession(owner),
      () =>
        domainEffect(() => {
          const lease = this.lease;
          if (lease === undefined)
            throw new LeaseDecisionRequiredError("Workstream adoption requires its fenced lease.");
          if (
            lease.owner.sessionId !== owner.sessionId ||
            lease.owner.sessionFile !== owner.sessionFile
          )
            throw new LeaseDecisionRequiredError(
              "Workstream adoption owner does not hold its lease.",
            );
          const state = this.database.update(lease, (draft) => {
            draft.coordinator = { ...owner };
          });
          this.owner = { ...owner };
          return state;
        }),
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
        attempts: [],
        deliveries: [],
        createdAt: now,
        updatedAt: now,
      };
      return { path, state };
    }).pipe(
      Effect.flatMap(({ path, state }) =>
        claimWorkstreamDirectory(path).pipe(
          Effect.flatMap(() =>
            domainEffect(() => SqliteWorkstreamDatabase.create(path)).pipe(
              Effect.flatMap((database) =>
                domainEffect(() => database.initialize(state)).pipe(
                  Effect.catch((error) =>
                    Effect.sync(() => database.close()).pipe(
                      Effect.matchEffect({
                        onFailure: (closeError) =>
                          Effect.fail(
                            new WorkstreamStoreOperationError({
                              code: "workstream_store_operation_failed",
                              message:
                                "Workstream initialization failed and its SQLite handle could not be closed; the private artifact was retained for inspection.",
                              cause: new AggregateError([error, closeError]),
                            }),
                          ),
                        onSuccess: () => Effect.fail(error),
                      }),
                    ),
                  ),
                  Effect.map(
                    () =>
                      ({
                        store: new WorkstreamStoreEffects(path, input.coordinator, database),
                        state: structuredClone(state),
                      }) as const,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  static open(path: string, owner: SessionIdentity): WorkstreamStoreEffects {
    validateSession(owner);
    const resolvedPath = resolve(path);
    if (!isNativeSqliteFile(resolvedPath))
      throw new Error(
        `Legacy JSON workstream state is read-only; explicitly migrate it after proving the prior owner is dead: ${resolvedPath}.`,
      );
    return new WorkstreamStoreEffects(
      resolvedPath,
      owner,
      SqliteWorkstreamDatabase.open(resolvedPath),
    );
  }

  static inspect(path: string): StoreEffect<WorkstreamState> {
    const resolvedPath = resolve(path);
    return isNativeSqliteFile(resolvedPath)
      ? sqliteEffect(resolvedPath, (database) => database.state())
      : readLegacyCurrentState(resolvedPath);
  }

  static readRaw(path: string): StoreEffect<string> {
    const resolvedPath = resolve(path);
    return isNativeSqliteFile(resolvedPath)
      ? sqliteEffect(resolvedPath, (database) => database.rawState())
      : readLegacyText(resolvedPath);
  }

  /**
   * Read a startup pointer without writes or ownership changes. Historical JSON is
   * retained losslessly; active JSON is reported as legacy and is never attached.
   */
  static inspectForReattachment(path: string): StoreEffect<WorkstreamReattachmentInspection> {
    const resolvedPath = resolve(path);
    if (isNativeSqliteFile(resolvedPath))
      return sqliteEffect(resolvedPath, (database) => ({
        kind: "current" as const,
        state: database.state(),
      }));
    return readLegacyObject(resolvedPath).pipe(
      Effect.flatMap((value) => domainEffect(() => inspectReattachmentValue(value, resolvedPath))),
    );
  }

  /**
   * Import one quiescent current JSON state into its exact derived SQLite path.
   * The source is not removed or rewritten. This is intentionally explicit: a
   * live JSON owner is never migrated merely because a pointer was observed.
   */
  static migrateLegacy(
    path: string,
    priorOwnerLiveness: "alive" | "dead" | "unknown",
  ): StoreEffect<{ path: string; state: WorkstreamState }> {
    const resolvedPath = resolve(path);
    if (priorOwnerLiveness !== "dead")
      return domainEffect(() => {
        throw new LeaseDecisionRequiredError(
          "Legacy workstream migration requires authoritative proof that the prior owner is dead.",
        );
      });
    return Effect.gen(function* () {
      const source = yield* readLegacyText(resolvedPath);
      const legacy = yield* domainEffect(() => {
        const value = parsePersistedObject(source);
        if (value.format !== WORKSTREAM_FORMAT || value.version !== WORKSTREAM_STATE_VERSION)
          throw new UnsupportedWorkstreamStateError(value.format, value.version);
        return decodeLegacyState(value, resolvedPath);
      });
      const targetPath = pathForWorkstream(legacy.gitCommonDir, legacy.id);
      yield* domainEffect(() => assertLegacySourceFile(resolvedPath));
      yield* claimWorkstreamDirectory(targetPath, true);
      const imported = { ...structuredClone(legacy), statePath: targetPath };
      return yield* Effect.acquireUseRelease(
        domainEffect(() => SqliteWorkstreamDatabase.create(targetPath)),
        (database) =>
          domainEffect(() => {
            database.initialize(imported);
            if (readFileSync(resolvedPath, "utf8") !== source)
              throw new Error(
                `Legacy workstream source changed during bounded import; source was left untouched and the canonical artifact was retained at ${targetPath}.`,
              );
            return { path: targetPath, state: imported };
          }),
        (database) => Effect.sync(() => database.close()),
      );
    });
  }

  load(): StoreEffect<WorkstreamState> {
    return domainEffect(() => this.database.state()).pipe(
      Effect.tap((state) => domainEffect(() => this.assertOwner(state))),
    );
  }

  acquireLease(
    owner: SessionIdentity,
    liveness: "alive" | "dead" | "unknown" = "unknown",
  ): StoreEffect<Lease, never> {
    return domainEffect(() => {
      validateSession(owner);
      const lease = this.database.claimLease(owner, liveness);
      this.leases.set(lease.token, lease);
      this.lease = lease;
      return lease;
    });
  }

  assertLease(lease: Lease, now?: Date): void {
    this.database.assertLease(lease, now);
  }

  renewLease(lease: Lease): StoreEffect<Lease, never> {
    return domainEffect(() => {
      this.assertLocalLease(lease);
      const renewed = this.database.renewLease(lease);
      this.leases.set(renewed.token, renewed);
      if (this.lease?.token === lease.token) this.lease = renewed;
      return renewed;
    });
  }

  releaseLease(lease: Lease): StoreEffect<void, never> {
    return domainEffect(() => {
      this.assertLocalLease(lease);
      this.database.releaseLease(lease);
      this.leases.delete(lease.token);
      if (this.lease?.token === lease.token) this.lease = undefined;
    });
  }

  close(): void {
    this.database.close();
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

  enqueue(
    input: AssignmentInput,
    attempts:
      | {
          id: string;
          models: NonNullable<WorkAttempt["models"]>;
          continuationOf?: string;
          candidate?: CandidateLineage;
          baseRevision?: string;
        }
      | Array<{
          id: string;
          models: NonNullable<WorkAttempt["models"]>;
          continuationOf?: string;
          candidate?: CandidateLineage;
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
        validateCandidateLineage(draft, input, attempt);
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
            requireAssignment(draft, input.assignmentId);
            const { now: _now, artifacts = [], ...fields } = input;
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

  startAttempt(input: {
    id: string;
    placement: Static<typeof AttemptPlacementSchema>;
    baseRevision?: string;
    now?: Date;
  }): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      input.id,
      (attempt) =>
        startAttemptTransition(attempt, {
          id: input.id,
          placement: input.placement,
          baseRevision: input.baseRevision,
        }),
      input.now,
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

  beginApplication(input: {
    id: string;
    commit: string;
    expectedHead: string;
    rootCommit?: string;
    commits?: string[];
    now?: Date;
  }): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      input.id,
      (attempt) => {
        if (attempt.application !== undefined) {
          if (samePendingApplication(attempt.application, input)) return;
          throw new Error(`Application for ${input.id} is already recorded.`);
        }
        if (!Value.Check(CommitSchema, input.expectedHead))
          throw new Error("Application destination requires an exact commit id.");
        validateApplicationHistory(input.commit, input.rootCommit, input.commits);
        const application: NonNullable<WorkAttempt["application"]> = {
          state: "pending",
          commit: input.commit,
          expectedHead: input.expectedHead,
        };
        if (input.rootCommit !== undefined) application.rootCommit = input.rootCommit;
        if (input.commits !== undefined) application.commits = [...input.commits];
        attempt.application = application;
      },
      input.now,
    );
  }

  finishApplication(id: string, revision: string, now?: Date): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        const application = attempt.application;
        if (application?.state === "applied") {
          if (application.revision === revision) return;
          throw new Error(`Application for ${id} has an immutable revision.`);
        }
        if (application?.state !== "pending")
          throw new Error(`Application for ${id} is not pending.`);
        attempt.application = { ...application, state: "applied", revision };
      },
      now,
    );
  }

  blockApplication(id: string, error: string, now?: Date): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        requireText(error, "Application error");
        const application = attempt.application;
        if (application?.state === "blocked") {
          if (application.error === error.trim()) return;
          throw new Error(`Application for ${id} has contradictory failure evidence.`);
        }
        if (application?.state !== "pending")
          throw new Error(`Application for ${id} is not pending.`);
        attempt.application = {
          ...application,
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
      (attempt) => {
        if (attempt.cleanup?.state === "completed") return;
        if (attempt.cleanup?.state !== "pending")
          throw new Error(`Cleanup for ${id} is not pending.`);
        if (attempt.cleanup.workerClosed === true) return;
        attempt.cleanup = { ...attempt.cleanup, workerClosed: true };
      },
      now,
    );
  }

  finishCleanup(id: string, now?: Date): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        if (attempt.cleanup?.state === "completed") {
          if (attempt.state === "cancel_requested") attempt.state = "cancelled";
          return;
        }
        if (attempt.cleanup?.state !== "pending" || !attempt.cleanup.workerClosed)
          throw new Error(`Cleanup for ${id} requires a closed worker.`);
        attempt.cleanup = { ...attempt.cleanup, state: "completed" };
        if (attempt.state === "cancel_requested") attempt.state = "cancelled";
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

  beginOutputRelease(input: {
    id: string;
    expectedHead: string;
    reason: string;
    now?: Date;
  }): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      input.id,
      (attempt, draft) => {
        requireText(input.reason, "Retained-output release reason");
        const assignment = requireAssignment(draft, attempt.assignmentId);
        const releasableAssignment =
          assignment.artifactIntent === "disposable_experiment" ||
          assignment.capability === "implement";
        if (
          !releasableAssignment ||
          !["settled", "failed", "cancelled"].includes(attempt.state) ||
          attempt.placement?.kind !== "isolated_worktree" ||
          attempt.cleanup?.state !== "completed" ||
          !attempt.cleanup.workerClosed
        )
          throw new Error(
            "Retained-output release requires closed owned experiment or unapplied implementation output.",
          );
        if (attempt.outputRelease?.state === "completed") return;
        if (
          attempt.outputRelease !== undefined &&
          attempt.outputRelease.expectedHead !== input.expectedHead
        )
          throw new Error("Retained-output release HEAD does not match its retained identity.");
        attempt.outputRelease = {
          state: "pending",
          expectedHead: input.expectedHead,
          reason: input.reason.trim(),
        };
      },
      input.now,
      ["active", "suspended", "completed"],
    );
  }

  finishOutputRelease(id: string, now?: Date): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        if (attempt.outputRelease?.state === "completed") return;
        if (attempt.outputRelease?.state !== "pending")
          throw new Error(`Retained-output release for ${id} is not pending.`);
        attempt.outputRelease = { ...attempt.outputRelease, state: "completed" };
      },
      now,
      ["active", "suspended", "completed"],
    );
  }

  blockOutputRelease(id: string, error: string, now?: Date): StoreEffect<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        requireText(error, "Retained-output release error");
        if (attempt.outputRelease?.state !== "pending")
          throw new Error(`Retained-output release for ${id} is not pending.`);
        attempt.outputRelease = {
          ...attempt.outputRelease,
          state: "blocked",
          error: error.trim(),
        };
      },
      now,
      ["active", "suspended", "completed"],
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
    allowedStates: WorkstreamState["lifecycle"]["state"][] = ["active", "suspended"],
  ): StoreEffect<WorkstreamState> {
    return this.update(
      (draft, now) => {
        const attempt = draft.attempts.find((candidate) => candidate.id === id);
        if (!attempt) throw new Error(`Unknown attempt ${id}.`);
        mutator(attempt, draft, suppliedNow ?? now);
        attempt.updatedAt = (suppliedNow ?? now).toISOString();
      },
      suppliedNow,
      allowedStates,
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
        if (
          artifacts.every((artifact) =>
            result.artifacts.some((retained) => sameValue(retained, artifact)),
          )
        )
          return;
        for (const artifact of artifacts) {
          const retained = result.artifacts.find((item) => item.id === artifact.id);
          if (retained !== undefined)
            throw new Error(`Result ${resultId} artifact ${artifact.id} is immutable.`);
        }
        result.artifacts = [...result.artifacts, ...artifacts];
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
      if (draft.attempts.some((attempt) => hasActiveOrUncleanAttempt(draft, attempt))) {
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
    return domainEffect(() => {
      const lease = this.lease;
      if (lease === undefined)
        throw new LeaseDecisionRequiredError("Workstream mutation requires its fenced lease.");
      return this.database.update(lease, mutator, {
        expectedOwner: this.owner,
        suppliedNow,
        allowedLifecycleStates,
      });
    });
  }

  private assertOwner(state: WorkstreamState): void {
    if (
      state.coordinator.sessionId !== this.owner.sessionId ||
      state.coordinator.sessionFile !== this.owner.sessionFile
    ) {
      throw new Error("Workstream mutation owner does not match the bound coordinator.");
    }
  }

  private assertLocalLease(lease: Lease): void {
    const bound = this.leases.get(lease.token);
    if (
      bound === undefined ||
      bound.runId !== lease.runId ||
      bound.owner.sessionId !== lease.owner.sessionId ||
      bound.owner.sessionFile !== lease.owner.sessionFile
    )
      throw new LeaseDecisionRequiredError("Workstream lease is not bound to this store.");
  }
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
  try {
    const state = decodeState(value);
    validateStoredPath(state, resolvedPath);
    return { kind: "current", state: structuredClone(state) };
  } catch (cause) {
    if (isLegacyWorkstreamPath(resolvedPath)) {
      const state = decodeLegacyState(value, resolvedPath);
      return { kind: "legacy_current", state: structuredClone(state) };
    }
    throw cause;
  }
}

function sqliteEffect<A>(
  path: string,
  run: (database: SqliteWorkstreamDatabase) => A,
): StoreEffect<A, never> {
  return Effect.acquireUseRelease(
    domainEffect(() => SqliteWorkstreamDatabase.openReadOnly(path)),
    (database) => domainEffect(() => run(database)),
    (database) => Effect.sync(() => database.close()),
  );
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

function beginCleanupTransition(
  attempt: WorkAttempt,
  input: { expectedHead?: string; id: string },
): void {
  if (attempt.cleanup) {
    if (attempt.cleanup.state === "pending" && attempt.cleanup.expectedHead === input.expectedHead)
      return;
    throw new Error(`Cleanup for ${input.id} is already recorded.`);
  }
  const placement = attempt.placement;
  if (!placement) throw new Error("Cleanup requires an attempt placement.");
  if (placement.kind === "isolated_worktree" && input.expectedHead === undefined)
    throw new Error("Isolated worktree cleanup requires its exact HEAD.");
  const cleanup: NonNullable<WorkAttempt["cleanup"]> = {
    state: "pending",
    workerClosed: false,
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

function samePendingApplication(
  application: NonNullable<WorkAttempt["application"]>,
  input: { commit: string; expectedHead: string; rootCommit?: string; commits?: string[] },
): boolean {
  return (
    application.state === "pending" &&
    application.commit === input.commit &&
    application.expectedHead === input.expectedHead &&
    application.rootCommit === input.rootCommit &&
    sameValue(application.commits, input.commits)
  );
}

function validateApplicationHistory(
  commit: string,
  rootCommit: string | undefined,
  commits: string[] | undefined,
): void {
  if (!Value.Check(CommitSchema, commit))
    throw new Error("Application source requires an exact commit id.");
  if ((rootCommit === undefined) !== (commits === undefined))
    throw new Error("Application lineage requires both rootCommit and commits.");
  if (
    (rootCommit !== undefined && !Value.Check(CommitSchema, rootCommit)) ||
    (commits !== undefined &&
      (!Value.Check(Type.Array(CommitSchema, { minItems: 1 }), commits) ||
        commits.at(-1) !== commit))
  )
    throw new Error("Application lineage does not match the exact candidate history.");
}

function validateCandidateLineage(
  draft: WorkstreamState,
  assignment: AssignmentInput,
  attempt: { baseRevision?: string; candidate?: CandidateLineage },
): void {
  const candidate = attempt.candidate;
  if (candidate === undefined) return;
  validateCandidateBasics(assignment, attempt, candidate);
  if (candidate.kind === "initial") return;
  const parent = findCandidateParent(draft, candidate);
  validateCandidateParent(draft, assignment, parent, candidate.parentCommit);
  validateCandidateRelation(attempt, parent, candidate);
}

function validateCandidateBasics(
  assignment: AssignmentInput,
  attempt: { baseRevision?: string; candidate?: CandidateLineage },
  candidate: CandidateLineage,
): void {
  if (assignment.capability !== "implement")
    throw new Error("Candidate lineage is available only for maintained implementations.");
  if (attempt.baseRevision === undefined || !Value.Check(CommitSchema, attempt.baseRevision))
    throw new Error("Candidate lineage requires an exact assigned base revision.");
  if (!Value.Check(CommitSchema, candidate.rootCommit))
    throw new Error("Candidate lineage requires an exact root commit.");
  if (
    candidate.kind === "initial" &&
    (candidate.parentAttemptId !== undefined ||
      candidate.parentCommit !== undefined ||
      candidate.rootCommit !== attempt.baseRevision)
  )
    throw new Error("Initial candidate lineage must be rooted at its assigned base.");
  if (
    candidate.kind !== "initial" &&
    (candidate.parentAttemptId === undefined || candidate.parentCommit === undefined)
  )
    throw new Error(`${candidate.kind} candidate lineage requires a parent attempt and commit.`);
}

function findCandidateParent(draft: WorkstreamState, candidate: CandidateLineage): WorkAttempt {
  const parent = draft.attempts.find((item) => item.id === candidate.parentAttemptId);
  if (parent === undefined)
    throw new Error(
      `Candidate lineage references unknown parent attempt ${candidate.parentAttemptId}.`,
    );
  return parent;
}

function validateCandidateParent(
  draft: WorkstreamState,
  assignment: AssignmentInput,
  parent: WorkAttempt,
  parentCommit: string | undefined,
): void {
  const parentAssignment = requireAssignment(draft, parent.assignmentId);
  if (
    parentAssignment.capability !== "implement" ||
    parentAssignment.intentVersion !== assignment.intentVersion
  )
    throw new Error("Candidate parent is outside the current maintained implementation scope.");
  if (
    parent.state !== "settled" ||
    parent.cleanup?.state !== "completed" ||
    !parent.cleanup.workerClosed ||
    parent.placement?.kind !== "isolated_worktree" ||
    parent.outputRelease !== undefined ||
    (parent.application !== undefined && parent.application.state !== "blocked")
  )
    throw new Error("Candidate parent must be a settled retained isolated candidate.");
  const parentResult =
    parent.resultId === undefined
      ? undefined
      : draft.results.find((result) => result.id === parent.resultId);
  if (
    parentResult?.validity !== "typed" ||
    parentResult.report.kind !== "implementation" ||
    parentResult.report.status !== "completed" ||
    parentResult.report.outcome !== "changed" ||
    parentResult.report.commit !== parentCommit
  )
    throw new Error(
      "Candidate parent commit does not exactly match its retained implementation report.",
    );
  const parentCandidate = candidateLineageForAttempt(parent);
  if (parentCandidate === undefined)
    throw new Error("Candidate parent has no exact assigned base revision.");
}

function validateCandidateRelation(
  attempt: { baseRevision?: string },
  parent: WorkAttempt,
  candidate: CandidateLineage,
): void {
  const parentCandidate = candidateLineageForAttempt(parent);
  if (candidate.kind === "correction") {
    if (
      parentCandidate === undefined ||
      candidate.rootCommit !== parentCandidate.rootCommit ||
      attempt.baseRevision !== candidate.parentCommit
    )
      throw new Error("Correction candidate must continue directly from its retained parent.");
  } else if (attempt.baseRevision !== candidate.rootCommit) {
    throw new Error("Integration candidate must be rooted at its assigned destination base.");
  }
}

function candidateLineageForAttempt(
  attempt: Pick<WorkAttempt, "baseRevision" | "candidate">,
): CandidateLineage | undefined {
  if (attempt.candidate !== undefined) return attempt.candidate;
  if (attempt.baseRevision !== undefined && Value.Check(CommitSchema, attempt.baseRevision))
    return { kind: "initial", rootCommit: attempt.baseRevision };
  return undefined;
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

function requireTexts(values: string[], label: string): void {
  if (values.some((value) => !value.trim()))
    throw new Error(`${label} cannot contain blank entries.`);
}
