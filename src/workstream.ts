import { randomUUID } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Atomic replacement and file mode require the host Node filesystem Promise API at this compatibility boundary.
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Workstream paths are pure host paths and do not require an Effect service.
import { dirname, resolve } from "node:path";
import { DateTime, Effect, Semaphore } from "effect";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { EvidenceSchema } from "./report-schema.js";
import {
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
  decodeState,
  isActiveHistoricalState,
  isKnownHistoricalWorkstreamVersion,
  type JsonObject,
  type JsonValue,
  readState,
  readStateValue,
  requireText,
  retainedTerminalInspection,
  validateArtifactsForAssignment,
  validateAuthority,
  validateId,
  validateSession,
  validateState,
  validateStoredPath,
  validateSubject,
} from "./workstream-validation.js";

export type {
  AuthorityReference,
  CompletionAccounting,
  HumanInputReceipt,
  HumanInputSource,
  Intent,
  ResultDisposition,
  ResultSubject,
  RetainedArtifact,
  SessionIdentity,
  WorkAssignment,
  WorkAttempt,
  WorkResult,
  WorkstreamReattachmentInspection,
  WorkstreamState,
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

export class WorkstreamStore {
  private readonly writeSemaphore = Semaphore.makeUnsafe(1);

  private mutationGuard: (() => void) | undefined;

  private constructor(
    readonly path: string,
    private owner: SessionIdentity,
  ) {}

  bindMutationGuard(guard: () => void): void {
    this.mutationGuard = guard;
  }

  adopt(owner: SessionIdentity): Promise<WorkstreamState> {
    validateSession(owner);
    return this.update(
      (draft) => {
        draft.coordinator = { ...owner };
      },
      undefined,
      ["active", "suspended"],
    ).then((state) => {
      this.owner = { ...owner };
      return state;
    });
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
  }): Promise<{ store: WorkstreamStore; state: WorkstreamState }> {
    validateId(input.id, "Workstream id");
    requireText(input.purpose, "Workstream purpose");
    requireText(input.projectRoot, "Project root");
    requireText(input.gitCommonDir, "Git common directory");
    validateSession(input.coordinator);
    const path = WorkstreamStore.pathFor(input.gitCommonDir, input.id);
    return mkdir(dirname(dirname(path)), { recursive: true })
      .then(() => mkdir(dirname(path)))
      .then(() => {
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
        const store = new WorkstreamStore(path, input.coordinator);
        return store.write(state).then(
          () => ({ store, state: structuredClone(state) }),
          (error) =>
            rm(dirname(path), { recursive: true, force: true }).then(() => {
              throw error;
            }),
        );
      });
  }

  static open(path: string, owner: SessionIdentity): WorkstreamStore {
    validateSession(owner);
    return new WorkstreamStore(resolve(path), owner);
  }

  static inspect(path: string): Promise<WorkstreamState> {
    return readState(resolve(path));
  }

  /**
   * Read a startup pointer without writes or ownership changes.
   * A canonical terminal envelope from a known workstream version may be retained
   * without applying the current mutable schema or adopting its ownership.
   */
  static inspectForReattachment(path: string): Promise<WorkstreamReattachmentInspection> {
    const resolvedPath = resolve(path);
    return readStateValue(resolvedPath).then((value) =>
      inspectReattachmentValue(value, resolvedPath),
    );
  }

  load(): Promise<WorkstreamState> {
    return readState(this.path).then((state) => {
      this.assertOwner(state);
      return state;
    });
  }

  recordInputEvent(input: {
    id?: string;
    sessionId: string;
    sessionFile: string;
    source: HumanInputSource;
    text: string;
    now?: Date;
  }): Promise<{ state: WorkstreamState; receipt: HumanInputReceipt }> {
    if (input.source === "extension")
      return Promise.reject(new Error("Extension-generated input cannot create human authority."));
    const source: HumanInputReceipt["source"] = input.source;
    validateSession(input);
    requireText(input.text, "Human input");
    let receipt: HumanInputReceipt | undefined;
    return this.update(
      (draft, now) => {
        if (
          input.sessionId !== this.owner.sessionId ||
          input.sessionFile !== this.owner.sessionFile
        )
          throw new Error("Input receipt belongs to another session.");
        const previous =
          input.id === undefined ? undefined : draft.inputs.find((item) => item.id === input.id);
        if (previous) {
          if (
            previous.text !== input.text.trim() ||
            previous.source !== source ||
            previous.sessionId !== input.sessionId
          )
            throw new Error("Conflicting input receipt.");
          receipt = previous;
          return;
        }
        receipt = {
          id: input.id ?? randomUUID(),
          sessionId: input.sessionId,
          sessionFile: input.sessionFile,
          source,
          text: input.text.trim(),
          receivedAt: (input.now ?? now).toISOString(),
        };
        const recorded = receipt;
        if (recorded === undefined) throw new Error("Human input receipt was not recorded.");
        draft.inputs.push(recorded);
      },
      input.now,
      ["active", "suspended"],
    ).then((state) => {
      if (!receipt) throw new Error("Human input receipt was not recorded.");
      return { state, receipt };
    });
  }

  setLifecycle(input: {
    state: "active" | "suspended" | "abandoned" | "archived";
    reason: string;
    now?: Date;
  }): Promise<WorkstreamState> {
    requireText(input.reason, "Lifecycle reason");
    return this.update(
      (draft, now) => {
        const from = draft.lifecycle.state;
        const allowed =
          from === "active"
            ? ["suspended", "abandoned", "archived"]
            : from === "suspended"
              ? ["active", "abandoned", "archived"]
              : [];
        if (!allowed.includes(input.state))
          throw new Error(`Cannot transition workstream lifecycle from ${from} to ${input.state}.`);
        draft.lifecycle = {
          state: input.state,
          changedAt: (input.now ?? now).toISOString(),
          reason: input.reason.trim(),
        };
      },
      input.now,
      ["active", "suspended"],
    );
  }

  reviseIntent(input: {
    authorityReceiptId: string;
    statement: string;
    constraints: string[];
    now?: Date;
  }): Promise<WorkstreamState> {
    requireText(input.statement, "Intent statement");
    requireTexts(input.constraints, "Intent constraints");
    return this.update((draft, now) => {
      requireReceipt(draft, input.authorityReceiptId);
      const current = currentIntent(draft);
      draft.intents.push({
        version: current.version + 1,
        statement: input.statement.trim(),
        constraints: input.constraints.map((item) => item.trim()),
        authorityReceiptIds: [input.authorityReceiptId],
        recordedAt: (input.now ?? now).toISOString(),
      });
    }, input.now);
  }

  assign(input: AssignmentInput & { now?: Date }): Promise<WorkstreamState> {
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
  ): Promise<WorkstreamState> {
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

  retainResult(input: ResultInput & { now?: Date }): Promise<WorkstreamState> {
    validateId(input.id, "Result id");
    return this.update(
      (draft, now) => {
        if (draft.results.some((result) => result.id === input.id))
          throw new Error(`Duplicate result ${input.id}.`);
        const assignment = requireAssignment(draft, input.assignmentId);
        if (input.assignmentIntentVersion !== assignment.intentVersion)
          throw new Error("Result intent version does not match its assignment.");
        const { now: _now, artifacts = [], ...fields } = input;
        validateArtifactsForAssignment(
          assignment,
          artifacts,
          input.validity === "typed" && input.report.status === "completed" ? "typed" : "absent",
        );
        const result = {
          ...fields,
          artifacts,
          observedAt: (input.now ?? now).toISOString(),
        };
        if (!Value.Check(ResultSchema, result))
          throw new Error("Result input does not satisfy its validity contract.");
        draft.results.push(result);
      },
      input.now,
      ["active", "suspended"],
    );
  }

  startAttempt(input: {
    id: string;
    placement?: Static<typeof AttemptPlacementSchema>;
    worktreePath?: string;
    branch?: string;
    baseRevision?: string;
    now?: Date;
  }): Promise<WorkstreamState> {
    const placement = input.placement ?? {
      kind: "isolated_worktree" as const,
      path: requireTextValue(input.worktreePath, "worktree"),
      branch: requireTextValue(input.branch, "branch"),
    };
    return this.changeAttempt(
      input.id,
      (attempt) => {
        if (attempt.state === "starting") {
          if (
            sameValue(attempt.placement, placement) &&
            attempt.baseRevision === input.baseRevision
          )
            return;
          throw new Error(`Attempt ${input.id} has contradictory launch placement.`);
        }
        if (attempt.state !== "queued")
          throw new Error(`Attempt ${input.id} is not awaiting launch.`);
        attempt.state = "starting";
        attempt.placement = structuredClone(placement);
        if (placement.kind === "isolated_worktree") {
          attempt.worktreePath = placement.path;
          attempt.branch = placement.branch;
        } else {
          delete attempt.worktreePath;
          delete attempt.branch;
        }
        if (input.baseRevision !== undefined) attempt.baseRevision = input.baseRevision;
        else delete attempt.baseRevision;
        attempt.submission = "not_sent";
      },
      input.now,
    );
  }

  recordSessionFile(id: string, sessionFile: string, now?: Date): Promise<WorkstreamState> {
    requireText(sessionFile, "Worker session file");
    return this.changeAttempt(
      id,
      (attempt) => {
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
  ): Promise<WorkstreamState> {
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
  ): Promise<WorkstreamState> {
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
  ): Promise<WorkstreamState> {
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
  ): Promise<WorkstreamState> {
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
  }): Promise<WorkstreamState> {
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

  recordAttention(id: string, detail: string, now?: Date): Promise<WorkstreamState> {
    requireText(detail, "Attention detail");
    return this.changeAttempt(
      id,
      (attempt, _draft, current) => {
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

  clearAttention(id: string, now?: Date): Promise<WorkstreamState> {
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
  }): Promise<WorkstreamState> {
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

  retryComposition(id: string, now?: Date, retainedRef?: string): Promise<WorkstreamState> {
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

  retainCompositionNotApplied(input: {
    id: string;
    reason: string;
    retainedRef: string;
    integratedRevision: string;
    now?: Date;
  }): Promise<WorkstreamState> {
    requireText(input.reason, "Retained-not-applied reason");
    requireText(input.retainedRef, "Retained commit ref");
    requireText(input.integratedRevision, "Integrated revision");
    return this.changeAttempt(
      input.id,
      (attempt) => {
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

  finishComposition(id: string, revision: string, now?: Date): Promise<WorkstreamState> {
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

  blockComposition(id: string, error: string, now?: Date): Promise<WorkstreamState> {
    requireText(error, "Composition error");
    return this.changeAttempt(
      id,
      (attempt) => {
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
  }): Promise<WorkstreamState> {
    return this.changeAttempt(
      input.id,
      (attempt) => beginCleanupTransition(attempt, input),
      input.now,
    );
  }

  markWorkerClosed(id: string, now?: Date): Promise<WorkstreamState> {
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

  retryCleanup(id: string, now?: Date): Promise<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        const cleanup = attempt.cleanup;
        if (cleanup === undefined || cleanup.state !== "blocked")
          throw new Error(`Cleanup for ${id} is not blocked.`);
        attempt.cleanup = { ...cleanup, state: "pending" };
        delete attempt.cleanup.error;
      },
      now,
    );
  }

  finishCleanup(id: string, now?: Date): Promise<WorkstreamState> {
    return this.changeAttempt(
      id,
      (attempt) => {
        if (attempt.cleanup?.state === "completed") return;
        if (attempt.cleanup?.state !== "pending" || !attempt.cleanup.workerClosed)
          throw new Error(`Cleanup for ${id} requires a closed worker.`);
        attempt.cleanup = { ...attempt.cleanup, state: "completed" };
      },
      now,
    );
  }

  blockCleanup(id: string, error: string, now?: Date): Promise<WorkstreamState> {
    requireText(error, "Cleanup error");
    return this.changeAttempt(
      id,
      (attempt) => {
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
  ): Promise<WorkstreamState> {
    requireText(text, "Steering instruction");
    return this.changeAttempt(
      id,
      (attempt) => {
        if (!attempt.worker) throw new Error("Steering requires a worker identity.");
        if (state === "submitted" && attempt.steering?.state !== "uncertain")
          throw new Error("Submitted steering requires an uncertain submission record.");
        attempt.steering = { text: text.trim(), state };
      },
      now,
    );
  }

  cancelAttempt(id: string, now?: Date): Promise<WorkstreamState> {
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
  ): Promise<WorkstreamState> {
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

  requestDelivery(resultId: string, now?: Date): Promise<WorkstreamState> {
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

  deliveryAttempt(resultId: string, owner: string, error?: string): Promise<WorkstreamState> {
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

  addResultArtifacts(resultId: string, artifacts: RetainedArtifact[]): Promise<WorkstreamState> {
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
  markDelivered(resultId: string, now?: Date): Promise<WorkstreamState> {
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

  acknowledge(resultId: string, acknowledgment: string, now?: Date): Promise<WorkstreamState> {
    requireText(acknowledgment, "Acknowledgment");
    return this.update(
      (draft, current) => {
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
  }): Promise<WorkstreamState> {
    requireText(input.reason, "Disposition reason");
    return this.update((draft, now) => {
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
  }): Promise<WorkstreamState> {
    requireText(input.conclusion, "Completion conclusion");
    if (
      input.evidence.length === 0 ||
      !input.evidence.every((item) => Value.Check(EvidenceSchema, item))
    )
      throw new Error("Completion requires valid evidence.");
    requireTexts(input.limitations, "Completion limitations");
    return this.update((draft, now) => {
      requireActive(draft);
      if (
        draft.attempts.some(
          (attempt) =>
            ["queued", "starting", "running", "cancel_requested"].includes(attempt.state) ||
            (attempt.placement !== undefined && attempt.cleanup?.state !== "completed"),
        )
      ) {
        throw new Error(
          "Complete only after workers and owned resources have settled and cleaned up.",
        );
      }
      const expectedAccounting = completionAccounting(draft);
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

  private update(
    mutator: (draft: WorkstreamState, now: Date) => void,
    suppliedNow?: Date,
    allowedLifecycleStates: WorkstreamState["lifecycle"]["state"][] = ["active"],
  ): Promise<WorkstreamState> {
    const operation = this.writeSemaphore.withPermit(
      Effect.tryPromise({
        try: () => this.performUpdate(mutator, suppliedNow, allowedLifecycleStates),
        catch: (cause) =>
          new WorkstreamStoreOperationError({
            code: "workstream_store_operation_failed",
            message: "Workstream store operation failed.",
            cause,
          }),
      }),
    );
    return runStorePromise(operation);
  }

  private performUpdate(
    mutator: (draft: WorkstreamState, now: Date) => void,
    suppliedNow: Date | undefined,
    allowedLifecycleStates: WorkstreamState["lifecycle"]["state"][],
  ): Promise<WorkstreamState> {
    this.mutationGuard?.();
    return readState(this.path).then((current) => {
      this.assertOwner(current);
      if (!allowedLifecycleStates.includes(current.lifecycle.state))
        throw new Error(`Workstream is ${current.lifecycle.state}.`);
      const draft = structuredClone(current);
      const now = suppliedNow ?? currentDate();
      mutator(draft, now);
      if (sameValue(draft, current)) return structuredClone(current);
      draft.revision = current.revision + 1;
      draft.updatedAt = now.toISOString();
      return this.write(draft).then(() => structuredClone(draft));
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

  private write(state: WorkstreamState): Promise<void> {
    validateState(state);
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    return mkdir(dirname(this.path), { recursive: true }).then(() =>
      writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      })
        .then(() => {
          this.mutationGuard?.();
          return rename(temporaryPath, this.path);
        })
        .then(
          (result) => rm(temporaryPath, { force: true }).then(() => result),
          (error) =>
            rm(temporaryPath, { force: true }).then(() => {
              throw error;
            }),
        ),
    );
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
  } catch (error) {
    const retained = retainedTerminalInspection(value, resolvedPath);
    if (retained) return retained;
    throw error;
  }
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
  input: { expectedHead?: string; discard: boolean; id: string },
): void {
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

function runStorePromise<A, E>(operation: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(operation).catch((failure) => {
    if (failure instanceof WorkstreamStoreOperationError) throw failure.cause;
    throw failure;
  });
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
  if (input.artifactIntent === "disposable_experiment" || input.capability === "implement")
    requireAuthority(draft, input.authority);
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

function assignmentResolved(state: WorkstreamState, assignment: WorkAssignment): boolean {
  // Resolution closes this assignment's original scope, not the current intent.
  // Every requested attempt is an independent contribution; no later success hides a failure.
  const attempts = state.attempts.filter((attempt) => attempt.assignmentId === assignment.id);
  if (attempts.length > 0) return attempts.every((attempt) => attemptResolved(state, attempt));
  if (assignment.capability === "implement") return false;
  const results = state.results.filter((result) => result.assignmentId === assignment.id);
  return results.length > 0 && results.every((result) => !resultUnresolved(state, result.id));
}

function attemptResolved(state: WorkstreamState, attempt: WorkAttempt): boolean {
  const result =
    attempt.resultId === undefined
      ? undefined
      : state.results.find((candidate) => candidate.id === attempt.resultId);
  if (result === undefined || resultUnresolved(state, result.id)) return false;
  const assignment = state.assignments.find((item) => item.id === attempt.assignmentId);
  return (
    result.validity === "typed" &&
    result.report.status === "completed" &&
    (assignment?.capability !== "implement" ||
      attempt.composition?.state === "composed" ||
      (result.report.kind === "implementation" && result.report.outcome === "no_change"))
  );
}

function resultUnresolved(state: WorkstreamState, resultId: string): boolean {
  const result = state.results.find((candidate) => candidate.id === resultId);
  if (result?.validity !== "typed" || result.report.status !== "completed") return true;
  return state.dispositions.some(
    (disposition) => disposition.resultId === resultId && disposition.status !== "accepted",
  );
}

function completionAccounting(state: WorkstreamState): CompletionAccounting[] {
  const accounting: CompletionAccounting[] = [];
  for (const assignment of state.assignments)
    if (!assignmentResolved(state, assignment))
      accounting.push({
        kind: "unresolved_assignment",
        assignmentId: assignment.id,
        reason: "Unresolved assignment requires coordinator accounting.",
      });
  for (const attempt of state.attempts)
    if (!attemptResolved(state, attempt))
      accounting.push({
        kind: "unresolved_attempt",
        attemptId: attempt.id,
        reason: "Unresolved attempt requires coordinator accounting.",
      });
  for (const result of state.results)
    if (resultUnresolved(state, result.id))
      accounting.push({
        kind: "unresolved_result",
        resultId: result.id,
        reason: "Unresolved result requires coordinator accounting.",
      });
  for (const delivery of state.deliveries)
    if (delivery.state === "pending")
      accounting.push({
        kind: "undelivered_result",
        resultId: delivery.resultId,
        reason: "Undelivered result requires coordinator accounting.",
      });
  return accounting;
}

function accountingTaskId(state: WorkstreamState, item: CompletionAccounting): string | undefined {
  if (item.kind === "unresolved_assignment") return item.assignmentId;
  if (item.kind === "unresolved_attempt")
    return state.attempts.find((attempt) => attempt.id === item.attemptId)?.assignmentId;
  return state.results.find((result) => result.id === item.resultId)?.assignmentId;
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
