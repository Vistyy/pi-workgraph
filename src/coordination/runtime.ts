/* oxlint-disable typescript/no-this-alias, effecttsgo/try-catch-in-effect-gen, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread, anti-slop/no-known-value-widening -- Effect owns runtime serialization; store pages and reports are decoded before use, while exact optional runtime facts remain omitted. */
import { randomUUID } from "node:crypto";
import { Data, DateTime, Effect, Schedule, type Scope, Semaphore } from "effect";
import { Value } from "typebox/value";
import type { ModelTarget } from "../domain/model-target.js";
import type {
  Attempt,
  AttemptLineage,
  AttemptRecord,
  AttemptSelection,
  CoordinatorOwner,
  Outcome,
  OutcomeRecord,
  Task,
  TaskContract,
  TaskRecord,
  TaskTarget,
  WorkstreamMetadata,
} from "../domain/records.js";
import { WorkerReportSchema } from "../domain/report.js";
import {
  applyOutput,
  classifyOutput,
  cleanupAppliedOutput,
  currentRevision,
  detachedPlacement,
  discardOutput,
  ensureDetachedWorktree,
  isAncestor,
  prepareApplication,
  prepareDiscard,
  type RepositoryOperation,
  resolveRevision,
  validateRetainedCandidate,
} from "../git.js";
import { StoreError, type WorkstreamStore } from "../storage/workstream-store.js";

interface WorkerIdentity {
  readonly sessionFile: string;
  readonly paneId: string;
  readonly tabId: string;
  readonly terminalId: string;
}
interface WorkerEvidence {
  readonly state: "working" | "idle" | "done" | "blocked" | "absent" | "unknown";
  readonly outcome?: {
    readonly kind: "reported" | "failed";
    readonly result: unknown;
    readonly effectiveModels: readonly ModelTarget[];
  };
}
type WorkerOperation = WorkerIdentity & {
  readonly workstreamId: string;
  readonly attemptId: string;
  readonly taskId: string;
  readonly cwd: string;
  readonly objective: string;
  readonly role: "consultation" | "implement" | "research" | "review";
};
interface WorkerPort {
  createSession(
    input: Omit<WorkerOperation, keyof WorkerIdentity> & { environment: Record<string, string> },
  ): Promise<string>;
  launch(
    input: Omit<WorkerOperation, keyof WorkerIdentity> & Pick<WorkerIdentity, "sessionFile">,
  ): Promise<Omit<WorkerIdentity, "sessionFile">>;
  inspect(identity: WorkerOperation): Promise<WorkerEvidence>;
  prompt(identity: WorkerOperation, text: string): Promise<void>;
  close(identity: WorkerOperation): Promise<"absent" | "present" | "unknown">;
  readSession(
    sessionFile: string,
    workstreamId: string,
    attemptId: string,
  ): Promise<WorkerEvidence>;
}
interface DeliveryPort {
  deliver(outcome: OutcomeRecord): Promise<void>;
}
interface RuntimePorts {
  readonly worker: WorkerPort;
  readonly delivery: DeliveryPort;
}

export class RuntimeError extends Data.TaggedError("RuntimeError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}
export type Attachment =
  | { readonly state: "detached" }
  | { readonly state: "blocked"; readonly reason: string }
  | { readonly state: "attached"; readonly runtime: WorkstreamRuntime };

export class WorkstreamRuntime {
  private blocker: string | undefined;
  private closed = false;
  private constructor(
    readonly store: WorkstreamStore,
    readonly owner: CoordinatorOwner,
    readonly agentDir: string,
    private readonly ports: RuntimePorts,
    private readonly semaphore: Semaphore.Semaphore,
  ) {}

  static acquire(input: {
    store: WorkstreamStore;
    owner: CoordinatorOwner;
    agentDir: string;
    ports: RuntimePorts;
  }): Effect.Effect<Attachment, never, Scope.Scope> {
    return Effect.gen(function* () {
      let metadata: WorkstreamMetadata;
      try {
        metadata = input.store.readMetadata();
      } catch (cause) {
        return { state: "blocked" as const, reason: message(cause) };
      }
      if (!sameOwner(metadata.owner, input.owner))
        return { state: "blocked" as const, reason: "Workstream belongs to another Coordinator." };
      const semaphore = yield* Semaphore.make(1);
      const runtime = new WorkstreamRuntime(
        input.store,
        input.owner,
        input.agentDir,
        input.ports,
        semaphore,
      );
      yield* Effect.forkScoped(runtime.reconciliation());
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtime.closed = true;
          input.store.close();
        }),
      );
      return { state: "attached" as const, runtime };
    });
  }

  status(): { lifecycle: WorkstreamMetadata["lifecycle"]; blocker?: string } {
    const status = { lifecycle: this.store.readMetadata().lifecycle };
    return this.blocker === undefined ? status : { ...status, blocker: this.blocker };
  }

  createTask(input: {
    id: string;
    target: TaskTarget;
    contract: TaskContract;
    selection: AttemptSelection;
    lineage?: AttemptLineage;
    baseCommit?: string;
  }): Effect.Effect<AttemptRecord, RuntimeError> {
    const self = this;
    return this.serializedEffect(
      "create Task",
      Effect.gen(function* () {
        const task: Task = { target: input.target, contract: input.contract, createdAt: now() };
        const attemptId = `${input.id}-1`;
        const attempt = yield* self.newAttempt(
          task,
          input.selection,
          input.lineage,
          input.baseCommit,
        );
        const records = self.store.createTaskWithAttempt(
          self.owner,
          self.store.readLatestIntent().index,
          input.id,
          task,
          attemptId,
          attempt,
        );
        yield* self.ensureRepository(records.task, records.attempt);
        return records.attempt;
      }).pipe(Effect.mapError((cause) => runtimeError("create Task", cause))),
    );
  }

  createAttempt(input: {
    taskId: string;
    selection: AttemptSelection;
    lineage?: AttemptLineage;
    baseCommit?: string;
  }): Effect.Effect<AttemptRecord, RuntimeError> {
    const self = this;
    return this.serializedEffect(
      "create Attempt",
      Effect.gen(function* () {
        const task = self.store.readTask(input.taskId);
        const attemptId = `${task.id}-${randomUUID()}`;
        const attempt = yield* self.newAttempt(
          task.task,
          input.selection,
          input.lineage,
          input.baseCommit,
        );
        const record = self.store.appendAttempt(self.owner, task.id, attemptId, attempt);
        yield* self.ensureRepository(task, record);
        return record;
      }).pipe(Effect.mapError((cause) => runtimeError("create Attempt", cause))),
    );
  }

  launch(attemptId: string): Effect.Effect<AttemptRecord, RuntimeError> {
    const self = this;
    return this.serializedEffect(
      "launch Worker",
      Effect.gen(function* () {
        let record = self.store.readAttempt(attemptId);
        let attempt = record.attempt;
        if (attempt.execution !== undefined)
          return yield* new RuntimeError({
            operation: "launch Worker",
            message: "Attempt already owns a Worker session.",
          });
        const task = self.store.readTask(record.taskId);
        yield* self
          .ensureRepository(task, record)
          .pipe(Effect.mapError((cause) => runtimeError("launch Worker", cause)));
        const context = self.workerContext(record, task);
        const sessionFile = yield* promise("create Worker session", () =>
          self.ports.worker.createSession({
            ...context,
            environment: workerEnvironment(attempt, task.task),
          }),
        );
        attempt = { ...attempt, execution: { sessionFile, submission: "absent" } };
        record = self.store.checkpointAttempt(self.owner, attemptId, attempt);
        const launched = yield* promise("launch Worker", () =>
          self.ports.worker.launch({ ...context, sessionFile }),
        );
        attempt = { ...attempt, execution: { sessionFile, ...launched, submission: "uncertain" } };
        record = self.store.checkpointAttempt(self.owner, attemptId, attempt);
        yield* promise("submit Worker assignment", () =>
          self.ports.worker.prompt(
            { ...context, sessionFile, ...launched },
            "Continue the assigned Workgraph objective now.",
          ),
        );
        attempt = { ...attempt, execution: { sessionFile, ...launched, submission: "confirmed" } };
        return self.store.checkpointAttempt(self.owner, attemptId, attempt);
      }),
    );
  }

  steer(attemptId: string, instruction: string): Effect.Effect<void, RuntimeError> {
    return this.serializedEffect(
      "steer Worker",
      promise("steer Worker", () =>
        this.ports.worker.prompt(this.workerOperation(attemptId), instruction),
      ),
    );
  }

  cancel(attemptId: string, reason: string): Effect.Effect<OutcomeRecord, RuntimeError> {
    const self = this;
    return this.serializedEffect(
      "cancel Worker",
      Effect.gen(function* () {
        let record = self.store.readAttempt(attemptId);
        if (self.store.readOutcome(attemptId) !== undefined)
          return yield* new RuntimeError({
            operation: "cancel Worker",
            message: "Attempt already has an Outcome.",
          });
        const execution = record.attempt.execution;
        if (execution === undefined)
          return yield* new RuntimeError({
            operation: "cancel Worker",
            message: "Attempt has no Worker checkpoint.",
          });
        const requestedAt = now();
        record = self.store.checkpointAttempt(self.owner, attemptId, {
          ...record.attempt,
          execution: {
            ...execution,
            cancellation: { reason, requestedAt, closeAttemptedAt: requestedAt },
          },
        });
        const closed = yield* promise("close Worker", () =>
          self.ports.worker.close(self.workerOperation(attemptId)),
        );
        if (closed !== "absent")
          return yield* new RuntimeError({
            operation: "cancel Worker",
            message: "Exact Worker absence was not established.",
          });
        const observedAt = now();
        const closingExecution = record.attempt.execution;
        if (closingExecution === undefined)
          return yield* new RuntimeError({
            operation: "cancel Worker",
            message: "Attempt lost its Worker checkpoint.",
          });
        record = self.store.checkpointAttempt(self.owner, attemptId, {
          ...record.attempt,
          execution: { ...closingExecution, closedAt: observedAt },
        });
        const outcome = outcomeFor(
          { kind: "cancelled", reason },
          selectedModels(record.attempt),
          observedAt,
        );
        const saved = self.store.insertOutcome(
          self.owner,
          `${attemptId}-outcome`,
          attemptId,
          outcome,
        );
        yield* self.classify(record, false);
        return saved;
      }),
    );
  }

  observe(attemptId: string): Effect.Effect<OutcomeRecord | undefined, RuntimeError> {
    const self = this;
    return this.serializedEffect(
      "observe Worker",
      Effect.gen(function* () {
        const record = self.store.readAttempt(attemptId);
        const existing = self.store.readOutcome(attemptId);
        if (existing !== undefined) return yield* self.settleRecordedOutcome(record, existing);
        const identity = self.workerOperation(attemptId);
        const observed = yield* promise("inspect Worker", () =>
          self.ports.worker.inspect(identity),
        );
        if (observed.state === "working" || observed.state === "idle") return undefined;
        if (observed.state !== "done")
          return yield* new RuntimeError({
            operation: "observe Worker",
            message: `Worker observation is ${observed.state}.`,
          });
        const evidence =
          observed.outcome ??
          (yield* promise("read Worker session", () =>
            self.ports.worker.readSession(identity.sessionFile, self.store.id, attemptId),
          )).outcome;
        if (evidence === undefined)
          return yield* new RuntimeError({
            operation: "observe Worker",
            message: "Worker settled without semantic session evidence.",
          });
        const observedAt = now();
        const result = semanticResult(evidence);
        const saved = self.store.insertOutcome(
          self.owner,
          `${attemptId}-outcome`,
          attemptId,
          outcomeFor(result, evidence.effectiveModels, observedAt),
        );
        return yield* self.settleRecordedOutcome(record, saved);
      }),
    );
  }

  apply(attemptId: string): Effect.Effect<AttemptRecord, RuntimeError> {
    const self = this;
    return this.serializedEffect(
      "apply output",
      Effect.gen(function* () {
        let record = self.store.readAttempt(attemptId);
        let prepared = yield* prepareApplication(self.repositoryOperation(record));
        record = self.store.checkpointAttempt(self.owner, attemptId, prepared);
        prepared = yield* prepareApplication(self.repositoryOperation(record));
        record = self.store.checkpointAttempt(self.owner, attemptId, prepared);
        const applied = yield* applyOutput(self.repositoryOperation(record), now());
        record = self.store.checkpointAttempt(self.owner, attemptId, applied);
        const cleaned = yield* cleanupAppliedOutput(self.repositoryOperation(record));
        return self.store.checkpointAttempt(self.owner, attemptId, cleaned);
      }).pipe(Effect.mapError((cause) => runtimeError("apply output", cause))),
    );
  }
  discard(attemptId: string, reason: string): Effect.Effect<AttemptRecord, RuntimeError> {
    const self = this;
    return this.serializedEffect(
      "discard output",
      Effect.gen(function* () {
        let record = self.store.readAttempt(attemptId);
        if (record.attempt.execution?.closedAt === undefined)
          return yield* new RuntimeError({
            operation: "discard output",
            message: "Worker must be definitively closed first.",
          });
        const checkpoint = prepareDiscard(self.repositoryOperation(record), reason);
        record = self.store.checkpointAttempt(self.owner, attemptId, checkpoint);
        const discarded = yield* discardOutput(self.repositoryOperation(record), now());
        return self.store.checkpointAttempt(self.owner, attemptId, discarded);
      }).pipe(Effect.mapError((cause) => runtimeError("discard output", cause))),
    );
  }
  inspect(
    section: "intents" | "tasks" | "attempts" | "outcomes",
    after = -1,
    limit = 20,
  ): Effect.Effect<{ records: unknown[]; nextAfter?: number }, RuntimeError> {
    return this.serialized("inspect records", () => {
      const records = this.store.page(section, after, limit);
      const last = records.at(-1) as { index?: number } | undefined;
      return records.length < limit || last?.index === undefined
        ? { records }
        : { records, nextAfter: last.index };
    });
  }
  complete(input: {
    conclusion: string;
    evidence: string[];
    limitations?: string[];
  }): Effect.Effect<WorkstreamMetadata, RuntimeError> {
    return this.serialized("complete Workstream", () =>
      this.store.complete(this.owner, {
        ...input,
        limitations: input.limitations ?? [],
        completedAt: now(),
      }),
    );
  }

  private newAttempt(
    task: Task,
    selection: AttemptSelection,
    lineage?: AttemptLineage,
    requestedBase?: string,
  ): Effect.Effect<Attempt, RuntimeError> {
    if (task.target.kind === "directory") {
      if (lineage !== undefined || requestedBase !== undefined)
        throw new RuntimeError({
          operation: "create Attempt",
          message: "Directory Tasks cannot carry candidate lineage.",
        });
      return Effect.succeed({ selection, base: { kind: "directory" } });
    }
    return this.repositoryAttempt(task.target, selection, lineage, requestedBase).pipe(
      Effect.mapError((cause) => runtimeError("create Attempt", cause)),
    );
  }
  private repositoryAttempt(
    target: Extract<TaskTarget, { kind: "repository" }>,
    selection: AttemptSelection,
    lineage?: AttemptLineage,
    requestedBase?: string,
  ): Effect.Effect<Attempt, RuntimeError | import("../git.js").GitError> {
    const self = this;
    return Effect.gen(function* () {
      const baseCommit =
        requestedBase === undefined
          ? yield* currentRevision(target)
          : yield* resolveRevision(target, requestedBase);
      if (lineage?.candidateOf === undefined)
        return { selection, base: { kind: "repository" as const, baseCommit } };
      const facts = yield* self.candidateFacts(
        target,
        { ...lineage, candidateOf: lineage.candidateOf },
        baseCommit,
        requestedBase,
      );
      return {
        selection,
        base: { kind: "repository" as const, baseCommit: facts.baseCommit },
        lineage: facts.lineage,
      };
    });
  }
  private candidateFacts(
    target: Extract<TaskTarget, { kind: "repository" }>,
    lineage: AttemptLineage & { candidateOf: NonNullable<AttemptLineage["candidateOf"]> },
    baseCommit: string,
    requestedBase?: string,
  ): Effect.Effect<
    { baseCommit: string; lineage: AttemptLineage },
    RuntimeError | import("../git.js").GitError
  > {
    const parentRecord = this.store.readAttempt(lineage.candidateOf.attemptId);
    const parent = parentRecord.attempt;
    if (parent.output?.kind !== "retained")
      return Effect.fail(
        new RuntimeError({
          operation: "create Attempt",
          message: "Candidate parent has no retained output.",
        }),
      );
    const parentOperation = this.repositoryOperation(parentRecord);
    if (parentOperation.target.commonDir !== target.commonDir)
      return Effect.fail(
        new RuntimeError({
          operation: "create Attempt",
          message: "Candidate parent belongs to another Task repository.",
        }),
      );
    return validateRetainedCandidate(parentOperation).pipe(
      Effect.flatMap(() =>
        lineage.candidateOf.kind === "extend"
          ? this.extendFacts(target, parentRecord, baseCommit, requestedBase)
          : this.integrateFacts(lineage, parentRecord, baseCommit),
      ),
    );
  }
  private extendFacts(
    target: Extract<TaskTarget, { kind: "repository" }>,
    parentRecord: AttemptRecord,
    requestedCommit: string,
    requestedBase?: string,
  ): Effect.Effect<
    { baseCommit: string; lineage: AttemptLineage },
    RuntimeError | import("../git.js").GitError
  > {
    const parent = parentRecord.attempt;
    if (parent.output?.kind !== "retained")
      return Effect.fail(
        new RuntimeError({
          operation: "create Attempt",
          message: "Candidate parent is not retained.",
        }),
      );
    const parentTip = parent.output.tip;
    if (requestedBase !== undefined && requestedCommit !== parentTip)
      return Effect.fail(
        new RuntimeError({
          operation: "create Attempt",
          message: "Extend must start at the parent candidate tip.",
        }),
      );
    const inheritedRoot =
      parent.lineage?.candidateRoot ??
      (parent.base.kind === "repository" ? parent.base.baseCommit : parentTip);
    return isAncestor(target, inheritedRoot, parentTip).pipe(
      Effect.flatMap((present) =>
        present
          ? Effect.succeed({
              baseCommit: parentTip,
              lineage: {
                candidateRoot: inheritedRoot,
                candidateOf: { kind: "extend", attemptId: parentRecord.id },
              },
            })
          : Effect.fail(
              new RuntimeError({
                operation: "create Attempt",
                message: "Candidate lineage is not present in the Task repository.",
              }),
            ),
      ),
    );
  }
  private integrateFacts(
    lineage: AttemptLineage & { candidateOf: NonNullable<AttemptLineage["candidateOf"]> },
    parentRecord: AttemptRecord,
    baseCommit: string,
  ): Effect.Effect<{ baseCommit: string; lineage: AttemptLineage }, RuntimeError> {
    const parent = parentRecord.attempt;
    if (
      parent.output?.kind !== "retained" ||
      lineage.candidateOf.kind !== "integrate" ||
      lineage.candidateOf.sourceTip !== parent.output.tip
    )
      return Effect.fail(
        new RuntimeError({
          operation: "create Attempt",
          message: "Integration source tip no longer matches its retained parent.",
        }),
      );
    return Effect.succeed({
      baseCommit,
      lineage: {
        candidateRoot: baseCommit,
        candidateOf: {
          kind: "integrate",
          attemptId: parentRecord.id,
          sourceTip: parent.output.tip,
        },
      },
    });
  }
  private ensureRepository(
    task: TaskRecord,
    attempt: AttemptRecord,
  ): Effect.Effect<void, import("../git.js").GitError> {
    return task.task.target.kind === "repository"
      ? ensureDetachedWorktree(this.repositoryOperation(attempt))
      : Effect.void;
  }
  private repositoryOperation(record: AttemptRecord): RepositoryOperation {
    const task = this.store.readTask(record.taskId).task;
    if (task.target.kind !== "repository")
      throw new RuntimeError({
        operation: "inspect output",
        message: "Attempt Task has no repository target.",
      });
    return {
      attemptId: record.id,
      attempt: record.attempt,
      target: task.target,
      ...detachedPlacement({
        agentDir: this.agentDir,
        workstreamId: this.store.id,
        attemptId: record.id,
      }),
      applicable: task.contract.kind === "implementation",
    };
  }
  private settleRecordedOutcome(
    record: AttemptRecord,
    outcome: OutcomeRecord,
  ): Effect.Effect<OutcomeRecord, RuntimeError> {
    if (record.attempt.execution?.closedAt !== undefined) return Effect.succeed(outcome);
    const self = this;
    return Effect.gen(function* () {
      const closed = yield* promise("close Worker", () =>
        self.ports.worker.close(self.workerOperation(record.id)),
      );
      if (closed !== "absent")
        return yield* new RuntimeError({
          operation: "observe Worker",
          message: "Outcome is durable, but exact Worker closure is unresolved.",
        });
      const execution = record.attempt.execution;
      if (execution === undefined)
        return yield* new RuntimeError({
          operation: "observe Worker",
          message: "Attempt has no Worker checkpoint.",
        });
      const closedRecord = self.store.checkpointAttempt(self.owner, record.id, {
        ...record.attempt,
        execution: { ...execution, closedAt: now() },
      });
      yield* self.classify(closedRecord, outcome.outcome.result.kind === "reported");
      return outcome;
    });
  }
  private classify(record: AttemptRecord, _successful: boolean): Effect.Effect<void, RuntimeError> {
    if (record.attempt.base.kind !== "repository") return Effect.void;
    return classifyOutput(this.repositoryOperation(record), now()).pipe(
      Effect.flatMap((attempt) =>
        effect("classify repository output", () => {
          this.store.checkpointAttempt(this.owner, record.id, attempt);
        }),
      ),
      Effect.mapError((cause) => runtimeError("classify repository output", cause)),
    );
  }
  private workerOperation(attemptId: string): WorkerOperation {
    const attempt = this.store.readAttempt(attemptId);
    const task = this.store.readTask(attempt.taskId);
    const execution = attempt.attempt.execution;
    if (
      execution?.sessionFile === undefined ||
      execution.paneId === undefined ||
      execution.tabId === undefined ||
      execution.terminalId === undefined
    )
      throw new RuntimeError({
        operation: "inspect Worker",
        message: "Attempt has no exact Worker identity.",
      });
    return {
      sessionFile: execution.sessionFile,
      paneId: execution.paneId,
      tabId: execution.tabId,
      terminalId: execution.terminalId,
      ...this.workerContext(attempt, task),
    };
  }
  private workerContext(attempt: AttemptRecord, task: TaskRecord) {
    const target = task.task.target;
    const cwd =
      target.kind === "directory" ? target.path : this.repositoryOperation(attempt).worktreePath;
    const kind = task.task.contract.kind;
    return {
      workstreamId: this.store.id,
      attemptId: attempt.id,
      taskId: task.id,
      cwd,
      objective: objective(task.task.contract),
      role:
        kind === "implementation"
          ? ("implement" as const)
          : kind === "review"
            ? ("review" as const)
            : kind === "consultation"
              ? ("consultation" as const)
              : ("research" as const),
    };
  }
  private reconciliation(): Effect.Effect<never, never> {
    const tick = Effect.gen(
      function* (this: WorkstreamRuntime) {
        const unsettled = yield* this.serialized("read unsettled records", () =>
          this.store.unsettled(),
        );
        for (const item of unsettled) {
          if (item.attempt.attempt.execution?.submission === "uncertain") {
            this.blocker = `Attempt ${item.attempt.id} has uncertain submission; inspect before retrying.`;
            continue;
          }
          if (
            item.outcome === undefined &&
            item.attempt.attempt.execution?.submission === "confirmed"
          )
            yield* this.observe(item.attempt.id).pipe(Effect.ignore);
          if (item.outcome !== undefined && item.outcome.outcome.delivery.deliveredAt === undefined)
            yield* this.deliver(item.outcome).pipe(Effect.ignore);
        }
      }.bind(this),
    ).pipe(Effect.ignore);
    return Effect.repeat(tick, Schedule.spaced("1 second")) as Effect.Effect<never, never>;
  }
  private deliver(record: OutcomeRecord): Effect.Effect<void, RuntimeError> {
    const self = this;
    return this.serializedEffect(
      "deliver Outcome",
      Effect.gen(function* () {
        const requested = { ...record.outcome.delivery, requestedAt: now() };
        let current = self.store.updateDelivery(self.owner, record.attemptId, requested);
        const delivered = yield* Effect.result(
          promise("deliver Outcome", () => self.ports.delivery.deliver(current)),
        );
        const delivery =
          delivered._tag === "Success"
            ? { ...current.outcome.delivery, deliveredAt: now() }
            : {
                ...current.outcome.delivery,
                failures: [
                  ...current.outcome.delivery.failures,
                  { at: now(), detail: message(delivered.failure) },
                ],
              };
        current = self.store.updateDelivery(self.owner, record.attemptId, delivery);
      }),
    );
  }
  private serialized<A>(operation: string, run: () => A): Effect.Effect<A, RuntimeError> {
    return this.serializedEffect(operation, effect(operation, run));
  }
  private serializedEffect<A>(
    operation: string,
    value: Effect.Effect<A, RuntimeError>,
  ): Effect.Effect<A, RuntimeError> {
    if (this.closed)
      return Effect.fail(new RuntimeError({ operation, message: "Runtime is closed." }));
    return this.semaphore.withPermit(value);
  }
}

function semanticResult(evidence: NonNullable<WorkerEvidence["outcome"]>): Outcome["result"] {
  if (evidence.kind === "reported" && Value.Check(WorkerReportSchema, evidence.result))
    return { kind: "reported", report: Value.Decode(WorkerReportSchema, evidence.result) };
  return {
    kind: "unreported",
    reason:
      evidence.kind === "failed"
        ? "Worker reported execution failure."
        : "Worker report was malformed.",
  };
}
function objective(contract: TaskContract): string {
  return contract.kind === "research" ||
    contract.kind === "experiment" ||
    contract.kind === "consultation"
    ? contract.question
    : contract.objective;
}
function selectedModels(attempt: Attempt) {
  return attempt.selection.kind === "target"
    ? [attempt.selection.target]
    : [attempt.selection.guide, attempt.selection.executor];
}
function outcomeFor(
  result: Outcome["result"],
  effectiveModels: readonly ModelTarget[],
  observedAt: string,
): Outcome {
  if (effectiveModels.length === 0)
    throw new RuntimeError({
      operation: "record Outcome",
      message: "No exact effective Worker model was observed.",
    });
  return {
    result,
    effectiveModels: [...effectiveModels],
    delivery: { requestedAt: observedAt, failures: [] },
    observedAt,
  };
}
function workerEnvironment(attempt: Attempt, task: Task): Record<string, string> {
  const mode =
    task.contract.kind === "implementation"
      ? "implementation"
      : task.contract.kind === "review"
        ? "review"
        : "research";
  const models = selectedModels(attempt);
  const initial = models[0];
  const executor =
    attempt.selection.kind === "implementation" ? attempt.selection.executor : undefined;
  return {
    PI_WORKGRAPH_MODE: mode,
    PI_WORKGRAPH_POLICY_ROLE:
      task.contract.kind === "consultation" ? "consultation" : task.contract.kind,
    ...(initial === undefined
      ? {}
      : {
          PI_WORKGRAPH_INITIAL_MODEL: initial.model,
          PI_WORKGRAPH_INITIAL_THINKING: initial.thinking,
        }),
    ...(attempt.base.kind === "repository"
      ? { PI_WORKGRAPH_BASE_COMMIT: attempt.base.baseCommit }
      : {}),
    ...(executor === undefined
      ? {}
      : {
          PI_WORKGRAPH_EXECUTOR_MODEL: executor.model,
          PI_WORKGRAPH_EXECUTOR_THINKING: executor.thinking,
        }),
  };
}
function runtimeError(operation: string, cause: unknown): RuntimeError {
  return cause instanceof RuntimeError
    ? cause
    : new RuntimeError({ operation, message: message(cause), cause });
}
function effect<A>(operation: string, run: () => A): Effect.Effect<A, RuntimeError> {
  return Effect.try({
    try: run,
    catch: (cause) => runtimeError(operation, cause),
  });
}
function promise<A>(operation: string, run: () => Promise<A>): Effect.Effect<A, RuntimeError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new RuntimeError({ operation, message: message(cause), cause }),
  });
}
function sameOwner(left: CoordinatorOwner, right: CoordinatorOwner): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.sessionFile === right.sessionFile &&
    left.workspaceId === right.workspaceId &&
    left.tabId === right.tabId
  );
}
function now(): string {
  return DateTime.formatIso(DateTime.nowUnsafe());
}
function message(cause: unknown): string {
  return cause instanceof StoreError || cause instanceof Error
    ? cause.message
    : "Operation failed.";
}
