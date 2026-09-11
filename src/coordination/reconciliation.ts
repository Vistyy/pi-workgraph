/**
 * Workstream transient reconciliation scheduler. It consumes one pure
 * `FrontierEntry` at a time and hands it, plus an exact-key runtime-owned
 * `ReconciliationControl`, to the injected driver (the driver owns external effects).
 * It derives each candidate from the current SQLite record view. Attachment,
 * manual reconcile, and committed-key notifications only coalesce a wake; no
 * durable frontier or full-state mirror is retained.
 *
 * It runs as one caller-Scope/FiberSet-owned fiber with one capacity-one wake
 * and retains only transient deadlines and diagnostic blocks. The runtime's
 * single mutation Semaphore owns durable state and external-effect boundaries.
 */
import {
  Cause,
  Data,
  DateTime,
  Effect,
  Exit,
  type FileSystem,
  Option,
  type Path,
  Queue,
  Ref,
} from "effect";
import type {
  Attempt,
  AttemptKey,
  CancellationCheckpoint,
  Outcome,
  Placement,
  RetainedArtifact,
  TaskContract,
  TerminalObservation,
  WorkerExecution,
  Workstream,
} from "../domain/workstream.js";
import type { WorkstreamStoreError } from "../storage/workstream-store.js";
import {
  FRONTIER_KIND_ORDER,
  type FrontierEntry,
  WORKER_POLL_INTERVAL_MILLIS,
} from "./frontier.js";

export type ResolvedReviewInput = Readonly<
  | { kind: "revision"; revision: string }
  | { kind: "outcome"; outcome: Readonly<Outcome> }
  | { kind: "comparison"; outcomes: readonly Readonly<Outcome>[] }
  | {
      kind: "artifact";
      outcome: Readonly<Outcome>;
      artifact: Readonly<RetainedArtifact>;
    }
>;

/** Defensive exact-key facts for one dispatch. */
export interface ReconciliationContext {
  readonly workstreamId: string;
  readonly repository: Workstream["repository"];
  readonly intent: Readonly<{ index: number; value: Workstream["intents"][number] }>;
  readonly task: Readonly<TaskContract>;
  readonly attempt: Readonly<Attempt>;
  /** Present only for review Tasks; references are resolved to workstream content. */
  readonly reviewInput?: ResolvedReviewInput;
  /** Session trajectory resolved from `continuationOf`, when the parent exists. */
  readonly continuationSessionFile?: string;
}

/**
 * Closed set of automatic durable stages. Manual application and output
 * release are deliberately absent: they remain coordinator-guarded boundaries.
 */
export type ReconciliationMutation = Readonly<
  | { kind: "activate"; placement: Placement }
  | { kind: "record_worker_execution"; execution: WorkerExecution }
  | {
      kind: "record_effective_model";
      observation: NonNullable<Attempt["effectiveModels"]>[number];
    }
  | { kind: "checkpoint_cancellation"; checkpoint: CancellationCheckpoint }
  | { kind: "checkpoint_cleanup"; checkpoint: NonNullable<Attempt["cleanup"]> }
  | { kind: "terminalize"; observation: TerminalObservation }
  | { kind: "record_delivery_failure"; detail: string }
  | { kind: "record_delivery_success" }
>;

interface ReconciliationCommitReceipt {
  readonly key: AttemptKey;
  readonly revision: number;
  readonly context: ReconciliationContext;
}

/**
 * One commit attempt. `committed` always means records changed and its
 * exact key was notified; `no_change` means the transition was a durable no-op
 * and therefore manufactured no progress and notified nothing.
 */
export type ReconciliationCommit =
  | Readonly<{ kind: "committed"; receipt: ReconciliationCommitReceipt }>
  | Readonly<{ kind: "no_change" }>;

export class ReconciliationControlError extends Data.TaggedError("ReconciliationControlError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

/** Runtime-owned exact-key control. It cannot expose store or frontier internals. */
export interface ReconciliationControl {
  readonly context: () => ReconciliationContext;
  readonly checkOwnership: Effect.Effect<void, ReconciliationControlError, FileSystem.FileSystem>;
  readonly commit: (
    mutation: ReconciliationMutation,
  ) => Effect.Effect<ReconciliationCommit, ReconciliationControlError, FileSystem.FileSystem>;
}

export class ReconciliationDriverError extends Data.TaggedError("ReconciliationDriverError")<{
  readonly detail: string;
}> {}

/** A non-committing driver can only wait for exact observation or surface a block. */
export type ReconciliationOutcome =
  | { readonly kind: "waiting" }
  | { readonly kind: "blocked"; readonly detail: string };

/** Narrow workstream port: one immutable entry plus its exact-key control. */
export interface ReconciliationDriver {
  readonly reconcile: (
    entry: FrontierEntry,
    control: ReconciliationControl,
  ) => Effect.Effect<
    ReconciliationOutcome,
    ReconciliationDriverError | ReconciliationControlError,
    FileSystem.FileSystem | Path.Path
  >;
}

/** One attention reason; the scheduler never persists speculative state. */
export type ReconciliationAttention = (detail: string) => Effect.Effect<void, never>;

export type ControlFactory = (
  key: AttemptKey,
) => Effect.Effect<ReconciliationControl, ReconciliationControlError, FileSystem.FileSystem>;

export interface ReconciliationFrontierObservation {
  readonly entry: FrontierEntry;
  readonly deadlineAt?: string;
  readonly blockedReason?: string;
}

interface TransientEntryObservation {
  readonly deadlineMillis?: number;
  readonly blockedReason?: string;
}

interface SchedulerState {
  readonly observations: ReadonlyMap<string, TransientEntryObservation>;
}

const EMPTY_STATE: SchedulerState = { observations: new Map() };

/**
 * Runtime-lifetime reconciliation scheduler. Durable mutation happens only
 * through the runtime's Semaphore-backed control; scheduler Refs contain only
 * transient timing and diagnostic observations.
 */
export class ReconciliationScheduler {
  private constructor(
    private readonly driver: ReconciliationDriver,
    private readonly attention: ReconciliationAttention,
    private readonly controls: Ref.Ref<ControlFactory | undefined>,
    private readonly source: Ref.Ref<
      | (() => Effect.Effect<FrontierEntry[], WorkstreamStoreError, FileSystem.FileSystem>)
      | undefined
    >,
    private readonly state: Ref.Ref<SchedulerState>,
    private readonly wake: Queue.Queue<void>,
    private readonly dispatchPaused: Ref.Ref<boolean>,
    private readonly dispatching: Ref.Ref<boolean>,
  ) {}

  static make(
    driver: ReconciliationDriver,
    attention: ReconciliationAttention,
  ): Effect.Effect<ReconciliationScheduler> {
    return Effect.gen(function* () {
      const state = yield* Ref.make<SchedulerState>(EMPTY_STATE);
      const wake = yield* Queue.dropping<void>(1);
      const controls = yield* Ref.make<ControlFactory | undefined>(undefined);
      const source = yield* Ref.make<
        | (() => Effect.Effect<FrontierEntry[], WorkstreamStoreError, FileSystem.FileSystem>)
        | undefined
      >(undefined);
      const dispatchPaused = yield* Ref.make(false);
      const dispatching = yield* Ref.make(false);
      return new ReconciliationScheduler(
        driver,
        attention,
        controls,
        source,
        state,
        wake,
        dispatchPaused,
        dispatching,
      );
    });
  }

  /**
   * Install the exact-key control factory. The runtime calls this while the
   * scheduler is still asleep, so the first dispatch always has a usable
   * control and there is no circular runtime capture.
   */
  readonly provideControls = (factory: ControlFactory): Effect.Effect<void> =>
    Ref.set(this.controls, factory);

  readonly provideSource = (
    source: () => Effect.Effect<FrontierEntry[], WorkstreamStoreError, FileSystem.FileSystem>,
  ): Effect.Effect<void> => Ref.set(this.source, source);

  /**
   * Clear transient observations and coalesce one wake. Classification reads
   * current records when the reconciler actually runs.
   */
  readonly attach = (): Effect.Effect<void> =>
    Ref.set(this.state, EMPTY_STATE).pipe(Effect.andThen(this.signal()));

  /**
   * Incremental committed-transition hook: replace only the explicitly affected
   * Attempt keys and clear their transient blocks. Every committed transition
   * calls this with its exact keys after a successful commit.
   */
  readonly notifyCommitted = (
    _workstream: Workstream,
    keys: readonly AttemptKey[],
  ): Effect.Effect<void> =>
    Ref.update(this.state, (current) => {
      const observations = new Map(current.observations);
      for (const key of keys)
        for (const kind of FRONTIER_KIND_ORDER) observations.delete(identityOf(key, kind));
      return { observations };
    }).pipe(Effect.andThen(this.signal()));

  readonly snapshot = (): Effect.Effect<FrontierEntry[], never, FileSystem.FileSystem> =>
    this.currentEntries().pipe(
      Effect.orElseSucceed(() => []),
      Effect.map((entries) => structuredClone(entries)),
    );

  readonly inspectionSnapshot = (): Effect.Effect<
    ReconciliationFrontierObservation[],
    never,
    FileSystem.FileSystem
  > =>
    Effect.zip(
      this.currentEntries().pipe(Effect.orElseSucceed(() => [])),
      Ref.get(this.state),
    ).pipe(
      Effect.map(([entries, current]) =>
        structuredClone(
          entries.map((entry) => {
            const transient = current.observations.get(identityOf(entry.key, entry.kind));
            const deadlineMillis = Math.max(transient?.deadlineMillis ?? 0, entryDueMillis(entry));
            const observation: ReconciliationFrontierObservation = { entry };
            if (deadlineMillis > 0)
              Object.assign(observation, {
                deadlineAt: DateTime.toDate(DateTime.makeUnsafe(deadlineMillis)).toISOString(),
              });
            if (transient?.blockedReason !== undefined)
              Object.assign(observation, { blockedReason: transient.blockedReason });
            return observation;
          }),
        ),
      ),
    );

  /** One wake regardless of how many commits preceded it. */
  private readonly signal = (): Effect.Effect<void> => Queue.offer(this.wake, undefined);

  /** Wait for any dispatched operation, then exclude new dispatch through the supplied effect. */
  readonly withDispatchBarrier = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      Ref.set(this.dispatchPaused, true),
      () =>
        Effect.gen(
          function* (this: ReconciliationScheduler) {
            while (yield* Ref.get(this.dispatching)) yield* Effect.yieldNow;
            return yield* effect;
          }.bind(this),
        ),
      () => Ref.set(this.dispatchPaused, false).pipe(Effect.andThen(this.signal())),
    );

  /** The scheduler fiber body; interrupts and joins with its owning Scope. */
  readonly run = (): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(
      function* (this: ReconciliationScheduler) {
        while (true) {
          const now = yield* nowMillis();
          const state = yield* Ref.get(this.state);
          const entries = yield* this.currentEntries().pipe(Effect.orElseSucceed(() => []));
          const candidate = nextCandidate(entries, state, now);
          if (candidate === undefined) {
            // No transient work: sleep until an explicit wake (commit or manual
            // reconcile). No polling loop exists here.
            yield* Queue.take(this.wake);
            continue;
          }
          if (candidate.delayMillis > 0) {
            // Wait for either the next deadline or a coalesced wake; whichever
            // arrives first simply re-evaluates the transient frontier.
            yield* Effect.timeoutOrElse(Queue.take(this.wake), {
              duration: `${candidate.delayMillis} millis`,
              orElse: () => Effect.void,
            });
            continue;
          }
          if (yield* Ref.get(this.dispatchPaused)) {
            yield* Queue.take(this.wake);
            continue;
          }
          yield* this.dispatch(candidate.entry, now);
        }
      }.bind(this),
    );

  private dispatch(
    entry: FrontierEntry,
    now: number,
  ): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> {
    return Effect.acquireUseRelease(
      Ref.set(this.dispatching, true),
      () =>
        Effect.flatMap(this.dispatchAllowed(entry), (allowed) =>
          allowed ? this.dispatchEntry(entry, now) : Effect.void,
        ),
      () => Ref.set(this.dispatching, false),
    );
  }

  private dispatchAllowed(
    entry: FrontierEntry,
  ): Effect.Effect<boolean, never, FileSystem.FileSystem> {
    return Effect.zipWith(
      Ref.get(this.dispatchPaused),
      this.contains(entry),
      (paused, present) => !paused && present,
    );
  }

  private dispatchEntry(
    entry: FrontierEntry,
    now: number,
  ): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> {
    return Effect.gen(
      function* (this: ReconciliationScheduler) {
        const control = yield* this.resolveControl(entry);
        if (control === undefined) return;
        const exit = yield* Effect.exit(this.driver.reconcile(entry, control));
        // A control commit replaces this exact dispatched object through the
        // affected-key notification. When that happened, the driver's stale
        // outcome must not block or erase the replacement.
        const replaced = !(yield* this.contains(entry));
        if (Exit.isFailure(exit)) {
          // Only caller/scope interruption propagates; it carries no typed failure.
          if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt;
          const detail = `Reconciliation driver failed: ${describeCause(exit.cause)}`;
          if (replaced) {
            yield* this.consumeWake();
            yield* this.attention(detail);
            return;
          }
          yield* this.block(entry, detail);
          return;
        }
        if (replaced) {
          yield* this.consumeWake();
          return;
        }
        const outcome = exit.value;
        if (outcome.kind === "blocked") {
          yield* this.block(entry, outcome.detail);
          return;
        }
        yield* this.wait(entry, now);
      }.bind(this),
    );
  }

  private resolveControl(
    entry: FrontierEntry,
  ): Effect.Effect<ReconciliationControl | undefined, never, FileSystem.FileSystem> {
    return Effect.gen(
      function* (this: ReconciliationScheduler) {
        const factory = yield* Ref.get(this.controls);
        if (factory === undefined) {
          yield* this.block(entry, "Reconciliation control is not available; obligation retained.");
          return undefined;
        }
        const result = yield* Effect.result(factory(entry.key));
        if (result._tag === "Success") return result.success;
        yield* this.block(entry, result.failure.detail);
        return undefined;
      }.bind(this),
    );
  }

  private wait(entry: FrontierEntry, now: number): Effect.Effect<void> {
    const retry = retryDelayFor(entry);
    if (retry === undefined) {
      // Unresolved or unknown presence: block in memory until an affected state
      // change or explicit manual reconcile, never a durable success fact.
      return this.block(entry, `${entry.kind} remains unresolved without an exact identity.`);
    }
    return Ref.update(this.state, (current) => ({
      ...current,
      observations: new Map(current.observations).set(identityOf(entry.key, entry.kind), {
        deadlineMillis: now + retry,
      }),
    }));
  }

  private block(entry: FrontierEntry, detail: string): Effect.Effect<void> {
    return Ref.update(this.state, (current) => ({
      ...current,
      observations: new Map(current.observations).set(identityOf(entry.key, entry.kind), {
        blockedReason: detail,
      }),
    })).pipe(Effect.andThen(this.attention(detail)));
  }

  private contains(entry: FrontierEntry): Effect.Effect<boolean, never, FileSystem.FileSystem> {
    return this.currentEntries().pipe(
      Effect.map((entries) =>
        entries.some(
          (value) => identityOf(value.key, value.kind) === identityOf(entry.key, entry.kind),
        ),
      ),
      Effect.orElseSucceed(() => false),
    );
  }

  private currentEntries(): Effect.Effect<
    FrontierEntry[],
    WorkstreamStoreError,
    FileSystem.FileSystem
  > {
    return Effect.flatMap(Ref.get(this.source), (source) =>
      source === undefined ? Effect.succeed([]) : source(),
    );
  }

  /** Consume the coalesced wake produced by the commit that replaced this entry. */
  private consumeWake(): Effect.Effect<void> {
    return Queue.poll(this.wake).pipe(Effect.asVoid);
  }
}

function nextCandidate(
  entries: readonly FrontierEntry[],
  state: SchedulerState,
  now: number,
): { readonly entry: FrontierEntry; readonly delayMillis: number } | undefined {
  let best: { entry: FrontierEntry; due: number } | undefined;
  for (const entry of entries) {
    const identity = identityOf(entry.key, entry.kind);
    const transient = state.observations.get(identity);
    if (transient?.blockedReason !== undefined) continue;
    const due = Math.max(transient?.deadlineMillis ?? 0, entryDueMillis(entry));
    if (best === undefined || due < best.due) best = { entry, due };
  }
  return best === undefined
    ? undefined
    : { entry: best.entry, delayMillis: Math.max(0, best.due - now) };
}

function entryDueMillis(entry: FrontierEntry): number {
  if (entry.kind !== "delivery" || entry.dueAt === undefined) return 0;
  const due = Date.parse(entry.dueAt);
  return Number.isNaN(due) ? 0 : due;
}

/**
 * Only an exact ready Worker identity supports approximately one-second
 * polling. Delivery eligibility is a committed due time, so a delivery driver
 * that returns `waiting` without committing simply blocks and surfaces
 * attention instead of hot-looping.
 */
function retryDelayFor(entry: FrontierEntry): number | undefined {
  if (entry.kind === "worker_poll") return WORKER_POLL_INTERVAL_MILLIS;
  if (entry.kind === "cancellation" && entry.worker !== undefined)
    return WORKER_POLL_INTERVAL_MILLIS;
  if (entry.kind === "cleanup" && entry.worker !== undefined) return WORKER_POLL_INTERVAL_MILLIS;
  return undefined;
}

function identityOf(key: AttemptKey, kind: FrontierEntry["kind"]): string {
  return `${key.taskId}\u0000${key.attemptId}\u0000${kind}`;
}

function nowMillis(): Effect.Effect<number> {
  return Effect.clockWith((clock) => Effect.sync(() => clock.currentTimeMillisUnsafe()));
}

function describeCause(cause: Cause.Cause<unknown>): string {
  const failure = Cause.findErrorOption(cause);
  const value: unknown = Option.isSome(failure) ? failure.value : Cause.squash(cause);
  if (value instanceof ReconciliationDriverError || value instanceof ReconciliationControlError)
    return value.detail;
  if (value instanceof Error) return value.message;
  return cause.toString().slice(0, 300);
}
