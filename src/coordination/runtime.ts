/* oxlint-disable typescript/no-this-alias, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread, effecttsgo/try-catch-in-effect-gen -- Effect generators retain the runtime owner; report payloads are schema-decoded at the Worker session boundary. */
import { Data, DateTime, Effect, Schedule, type Scope, Semaphore } from "effect";
import type {
  AttemptRecord,
  CoordinatorOwner,
  OutcomeRecord,
  TaskRecord,
  TaskTarget,
  WorkstreamMetadata,
} from "../domain/records.js";
import {
  applyOutput,
  classifyOutput,
  currentRevision,
  detachedPlacement,
  discardOutput,
  ensureDetachedWorktree,
  isAncestor,
  prepareApplication,
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
    readonly result: Record<string, unknown>;
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
  createSession(input: {
    workstreamId: string;
    attemptId: string;
    taskId: string;
    role: WorkerOperation["role"];
    cwd: string;
    objective: string;
    environment: Record<string, string>;
  }): Promise<string>;
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
}> {
  constructor(operation: string, message: string, cause?: unknown) {
    super(cause === undefined ? { operation, message } : { operation, message, cause });
  }
}
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
        metadata = input.store.metadata();
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
    const status = { lifecycle: this.store.metadata().lifecycle };
    return this.blocker === undefined ? status : { ...status, blocker: this.blocker };
  }

  createTask(input: {
    id: string;
    kind: TaskRecord["kind"];
    objective: string;
    target: TaskTarget;
    contract?: Record<string, unknown>;
  }): Effect.Effect<TaskRecord, RuntimeError> {
    return this.serialized("create task", () => {
      const task: TaskRecord = {
        id: input.id,
        workstreamId: this.store.id,
        intentIndex: this.store.currentIntent().index,
        kind: input.kind,
        objective: input.objective,
        target: input.target,
        contract: input.contract ?? {},
        createdAt: now(),
      };
      this.store.createTask(this.owner, task);
      return task;
    });
  }

  createAttempt(input: {
    taskId: string;
    models: AttemptRecord["models"];
    lineage?: AttemptRecord["lineage"];
    baseRevision?: string;
    experiment?: boolean;
  }): Effect.Effect<AttemptRecord, RuntimeError> {
    return this.serialized("create attempt", () => {
      const task = this.store.task(input.taskId);
      const attempts = this.store.page("attempts", 0, 100) as AttemptRecord[];
      const sequence = attempts.filter((item) => item.taskId === task.id).length;
      const id = `${task.id}-${sequence + 1}`;
      const createdAt = now();
      const immutable = {
        id,
        workstreamId: this.store.id,
        taskId: task.id,
        sequence,
        createdAt,
        models: input.models,
        ...(input.lineage === undefined ? {} : { lineage: input.lineage }),
      };
      let attempt: AttemptRecord;
      if (task.target.kind === "directory") {
        if (input.lineage !== undefined || input.baseRevision !== undefined)
          throw new RuntimeError("create attempt", "Directory Tasks cannot carry Git lineage.");
        attempt = immutable;
      } else {
        const baseRevision = input.baseRevision ?? currentRevision(task.target);
        this.validateLineage(input.lineage, baseRevision);
        const placement = detachedPlacement({
          agentDir: this.agentDir,
          workstreamId: this.store.id,
          attemptId: id,
        });
        attempt = {
          ...immutable,
          repository: {
            checkoutRoot: task.target.checkoutRoot,
            commonDir: task.target.commonDir,
            baseRevision,
            ...placement,
            experiment: input.experiment ?? task.kind === "experiment",
          },
        };
      }
      this.store.createAttempt(this.owner, attempt);
      if (attempt.repository !== undefined) ensureDetachedWorktree(attempt.repository);
      return attempt;
    });
  }

  launch(attemptId: string): Effect.Effect<AttemptRecord, RuntimeError> {
    const self = this;
    return this.serializedEffect(
      "launch worker",
      Effect.gen(function* () {
        let attempt = self.store.attempt(attemptId);
        if (attempt.worker !== undefined)
          throw new RuntimeError("launch worker", "Attempt already owns a Worker session.");
        const task = self.store.task(attempt.taskId);
        if (attempt.repository !== undefined) ensureDetachedWorktree(attempt.repository);
        const cwd =
          attempt.repository?.worktreePath ??
          (task.target.kind === "directory" ? task.target.path : task.target.checkoutRoot);
        const context = workerContext(attempt, task, cwd);
        const sessionFile = yield* promise("create Worker session", () =>
          self.ports.worker.createSession({
            ...context,
            environment: workerEnvironment(attempt, task),
          }),
        );
        attempt = {
          ...attempt,
          worker: { sessionFile, submission: "absent" },
        };
        self.store.checkpointAttempt(self.owner, attempt);
        const launched = yield* promise("launch Worker", () =>
          self.ports.worker.launch({ ...context, sessionFile }),
        );
        const worker = { sessionFile, ...launched, submission: "absent" as const };
        attempt = { ...attempt, worker };
        self.store.checkpointAttempt(self.owner, attempt);
        // Uncertain is the durable pre-effect checkpoint. A lost prompt response is never replayed.
        attempt = { ...attempt, worker: { ...worker, submission: "uncertain" } };
        self.store.checkpointAttempt(self.owner, attempt);
        yield* promise("submit Worker assignment", () =>
          self.ports.worker.prompt(
            { ...context, sessionFile, ...launched },
            "Continue the assigned Workgraph objective now.",
          ),
        );
        attempt = { ...attempt, worker: { ...worker, submission: "confirmed" } };
        self.store.checkpointAttempt(self.owner, attempt);
        return attempt;
      }),
    );
  }

  steer(attemptId: string, instruction: string): Effect.Effect<void, RuntimeError> {
    return this.serializedEffect(
      "steer worker",
      Effect.gen(
        function* (this: WorkstreamRuntime) {
          const identity = this.workerOperation(this.store.attempt(attemptId));
          yield* promise("steer Worker", () => this.ports.worker.prompt(identity, instruction));
        }.bind(this),
      ),
    );
  }

  cancel(attemptId: string, reason: string): Effect.Effect<OutcomeRecord, RuntimeError> {
    const self = this;
    return this.serializedEffect(
      "cancel worker",
      Effect.gen(function* () {
        let attempt = self.store.attempt(attemptId);
        const identity = self.workerOperation(attempt);
        const persistedWorker = attempt.worker;
        if (persistedWorker === undefined)
          throw new RuntimeError("cancel worker", "Attempt has no Worker checkpoint.");
        if (self.store.outcomeForAttempt(attemptId) !== undefined)
          throw new RuntimeError("cancel worker", "Attempt already has an Outcome.");
        const cancellingWorker = {
          ...persistedWorker,
          cancellation: { reason, requestedAt: now() },
        };
        attempt = { ...attempt, worker: cancellingWorker };
        self.store.checkpointAttempt(self.owner, attempt);
        const closed = yield* promise("close Worker", () => self.ports.worker.close(identity));
        if (closed !== "absent")
          throw new RuntimeError("cancel worker", "Exact Worker absence was not established.");
        const closedAt = now();
        attempt = { ...attempt, worker: { ...cancellingWorker, closedAt } };
        self.store.checkpointAttempt(self.owner, attempt);
        const outcome = outcomeFor(attempt, "cancelled", { reason }, closedAt);
        self.store.recordOutcome(self.owner, outcome);
        yield* self.classify(attempt, false);
        return outcome;
      }),
    );
  }

  observe(attemptId: string): Effect.Effect<OutcomeRecord | undefined, RuntimeError> {
    const self = this;
    return this.serializedEffect(
      "observe worker",
      Effect.gen(function* () {
        const attempt = self.store.attempt(attemptId);
        const existing = self.store.outcomeForAttempt(attemptId);
        if (existing !== undefined) return yield* self.settleRecordedOutcome(attempt, existing);
        const identity = self.workerOperation(attempt);
        const observed = yield* promise("inspect Worker", () =>
          self.ports.worker.inspect(identity),
        );
        if (observed.state === "working" || observed.state === "idle") return undefined;
        if (observed.state !== "done")
          throw new RuntimeError("observe worker", `Worker observation is ${observed.state}.`);
        const evidence =
          observed.outcome ??
          (yield* promise("read Worker session", () =>
            self.ports.worker.readSession(identity.sessionFile, attempt.workstreamId, attemptId),
          )).outcome;
        if (evidence === undefined)
          throw new RuntimeError(
            "observe worker",
            "Worker settled without semantic session evidence.",
          );
        const observedAt = now();
        const outcome = outcomeFor(attempt, evidence.kind, evidence.result, observedAt);
        self.store.recordOutcome(self.owner, outcome);
        return yield* self.settleRecordedOutcome(attempt, outcome);
      }),
    );
  }

  apply(attemptId: string): Effect.Effect<AttemptRecord, RuntimeError> {
    return this.serialized("apply output", () => {
      let attempt = prepareApplication(this.store.attempt(attemptId));
      this.store.checkpointAttempt(this.owner, attempt);
      // One same-ref replan is permitted between declaration and mutation.
      attempt = prepareApplication(attempt);
      this.store.checkpointAttempt(this.owner, attempt);
      const applied = applyOutput(attempt);
      this.store.checkpointAttempt(this.owner, applied);
      return applied;
    });
  }

  discard(attemptId: string, reason: string): Effect.Effect<AttemptRecord, RuntimeError> {
    return this.serialized("discard output", () => {
      const attempt = this.store.attempt(attemptId);
      if (attempt.worker?.closedAt === undefined)
        throw new RuntimeError("discard output", "Worker must be definitively closed first.");
      const discarded = discardOutput(attempt, reason);
      this.store.checkpointAttempt(this.owner, discarded);
      return discarded;
    });
  }

  inspect(
    section: "intents" | "tasks" | "attempts" | "outcomes",
    offset = 0,
    limit = 20,
  ): Effect.Effect<{ records: unknown[]; nextOffset?: number }, RuntimeError> {
    return this.serialized("inspect records", () => {
      const records = this.store.page(section, offset, limit);
      return records.length < limit
        ? { records }
        : { records, nextOffset: offset + records.length };
    });
  }

  complete(input: {
    conclusion: string;
    evidence: string[];
    limitations?: string[];
  }): Effect.Effect<WorkstreamMetadata, RuntimeError> {
    return this.serialized("complete workstream", () =>
      this.store.complete(this.owner, {
        ...input,
        limitations: input.limitations ?? [],
        completedAt: now(),
      }),
    );
  }

  private settleRecordedOutcome(
    attempt: AttemptRecord,
    outcome: OutcomeRecord,
  ): Effect.Effect<OutcomeRecord, RuntimeError> {
    if (attempt.worker?.closedAt !== undefined) return Effect.succeed(outcome);
    const self = this;
    return Effect.gen(function* () {
      const worker = attempt.worker;
      if (worker === undefined)
        return yield* new RuntimeError("observe worker", "Attempt has no Worker checkpoint.");
      const closed = yield* promise("close Worker", () =>
        self.ports.worker.close(self.workerOperation(attempt)),
      );
      if (closed !== "absent")
        return yield* new RuntimeError(
          "observe worker",
          "Outcome is durable, but exact Worker closure is unresolved.",
        );
      const checkpoint = { ...attempt, worker: { ...worker, closedAt: now() } };
      self.store.checkpointAttempt(self.owner, checkpoint);
      yield* self.classify(checkpoint, outcome.kind === "reported");
      return outcome;
    });
  }

  private workerOperation(attempt: AttemptRecord): WorkerOperation {
    const identity = workerIdentity(attempt);
    const task = this.store.task(attempt.taskId);
    const cwd =
      attempt.repository?.worktreePath ??
      (task.target.kind === "directory" ? task.target.path : task.target.checkoutRoot);
    return { ...identity, ...workerContext(attempt, task, cwd) };
  }

  private validateLineage(lineage: AttemptRecord["lineage"], baseRevision: string): void {
    if (lineage === undefined) return;
    const parent = this.store.attempt(lineage.parentAttemptId);
    const repository = parent.repository;
    if (repository?.candidateRevision !== lineage.parentCommit)
      throw new RuntimeError(
        "create attempt",
        "Parent output is not retained at the stated commit.",
      );
    if (!isAncestor(repository.commonDir, repository.baseRevision, lineage.parentCommit))
      throw new RuntimeError("create attempt", "Parent candidate ancestry is not accepted.");
    if (lineage.kind === "extend" && baseRevision !== lineage.parentCommit)
      throw new RuntimeError("create attempt", "Extend must start at the parent candidate.");
  }

  private classify(attempt: AttemptRecord, successful: boolean): Effect.Effect<void, RuntimeError> {
    if (attempt.repository === undefined) return Effect.void;
    return effect("classify repository output", () => {
      const classified = classifyOutput(attempt, successful);
      this.store.checkpointAttempt(this.owner, classified);
    });
  }

  private reconciliation(): Effect.Effect<never, never> {
    const tick = Effect.gen(
      function* (this: WorkstreamRuntime) {
        const unsettled = yield* this.serialized("read unsettled records", () =>
          this.store.unsettled(),
        );
        for (const item of unsettled) {
          if (item.attempt.worker?.submission === "uncertain") {
            this.blocker = `Attempt ${item.attempt.id} has uncertain submission; inspect before retrying.`;
            continue;
          }
          if (item.outcome === undefined && item.attempt.worker?.submission === "confirmed")
            yield* this.observe(item.attempt.id).pipe(Effect.ignore);
          if (item.outcome?.delivery.state === "pending")
            yield* this.deliver(item.outcome).pipe(Effect.ignore);
        }
      }.bind(this),
    ).pipe(Effect.ignore);
    return Effect.repeat(tick, Schedule.spaced("1 second")) as Effect.Effect<never, never>;
  }

  private deliver(outcome: OutcomeRecord): Effect.Effect<void, RuntimeError> {
    const self = this;
    return this.serializedEffect(
      "deliver Outcome",
      Effect.gen(function* () {
        const delivery: OutcomeRecord = {
          ...outcome,
          delivery: { ...outcome.delivery, attempts: outcome.delivery.attempts + 1 },
        };
        self.store.updateDelivery(self.owner, delivery);
        const delivered = yield* Effect.result(
          promise("deliver Outcome", () => self.ports.delivery.deliver(delivery)),
        );
        const next: OutcomeRecord =
          delivered._tag === "Success"
            ? {
                ...delivery,
                delivery: { ...delivery.delivery, state: "delivered", deliveredAt: now() },
              }
            : delivery;
        self.store.updateDelivery(self.owner, next);
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
    if (this.closed) return Effect.fail(new RuntimeError(operation, "Runtime is closed."));
    return this.semaphore.withPermit(value);
  }
}

function effect<A>(operation: string, run: () => A): Effect.Effect<A, RuntimeError> {
  return Effect.try({
    try: run,
    catch: (cause) =>
      cause instanceof RuntimeError ? cause : new RuntimeError(operation, message(cause), cause),
  });
}
function promise<A>(operation: string, run: () => Promise<A>): Effect.Effect<A, RuntimeError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new RuntimeError(operation, message(cause), cause),
  });
}
function outcomeFor(
  attempt: AttemptRecord,
  kind: OutcomeRecord["kind"],
  result: Record<string, unknown>,
  observedAt: string,
): OutcomeRecord {
  return {
    id: `${attempt.id}-outcome`,
    workstreamId: attempt.workstreamId,
    attemptId: attempt.id,
    kind,
    result,
    observedAt,
    delivery: { state: "pending", attempts: 0 },
  };
}
function workerIdentity(attempt: AttemptRecord): WorkerIdentity {
  const worker = attempt.worker;
  if (worker?.paneId === undefined || worker.tabId === undefined || worker.terminalId === undefined)
    throw new RuntimeError("inspect Worker", "Attempt has no exact Worker identity.");
  return {
    sessionFile: worker.sessionFile,
    paneId: worker.paneId,
    tabId: worker.tabId,
    terminalId: worker.terminalId,
  };
}
function workerContext(attempt: AttemptRecord, task: TaskRecord, cwd: string) {
  const role: WorkerOperation["role"] =
    task.kind === "implementation"
      ? "implement"
      : task.kind === "review"
        ? "review"
        : task.kind === "consultation"
          ? "consultation"
          : "research";
  return {
    workstreamId: attempt.workstreamId,
    attemptId: attempt.id,
    taskId: task.id,
    cwd,
    objective: task.objective,
    role,
  };
}
function workerEnvironment(attempt: AttemptRecord, task: TaskRecord): Record<string, string> {
  const mode =
    task.kind === "implementation"
      ? "implementation"
      : task.kind === "review"
        ? "review"
        : "research";
  const initial = attempt.models[0];
  const executor = attempt.models.find((model) => model.role === "executor");
  return {
    PI_WORKGRAPH_MODE: mode,
    PI_WORKGRAPH_POLICY_ROLE: task.kind === "consultation" ? "consultation" : task.kind,
    PI_WORKGRAPH_RUN_ID: attempt.workstreamId,
    PI_WORKGRAPH_NODE_ID: attempt.id,
    ...(initial === undefined
      ? {}
      : {
          PI_WORKGRAPH_INITIAL_MODEL: initial.model,
          PI_WORKGRAPH_INITIAL_THINKING: initial.thinking ?? "high",
        }),
    ...(attempt.repository === undefined
      ? {}
      : { PI_WORKGRAPH_BASE_COMMIT: attempt.repository.baseRevision }),
    ...(executor === undefined
      ? {}
      : {
          PI_WORKGRAPH_EXECUTOR_MODEL: executor.model,
          PI_WORKGRAPH_EXECUTOR_THINKING: executor.thinking ?? "high",
        }),
  };
}
function sameOwner(left: CoordinatorOwner, right: CoordinatorOwner): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.sessionFile === right.sessionFile &&
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
