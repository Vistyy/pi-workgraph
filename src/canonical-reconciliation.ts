/**
 * Canonical transient reconciliation scheduler. It consumes one pure
 * `FrontierEntry` at a time and hands it, plus an exact-key runtime-owned
 * `ReconciliationControl`, to the injected driver (the driver owns external effects).
 * Attachment, manual reconcile, and committed affected-key notifications are
 * its only frontier inputs; it never reads or parses the SQLite aggregate.
 *
 * It runs as one caller-Scope/FiberSet-owned fiber, owns one capacity-one
 * coalesced wake plus per-entry transient deadlines and in-memory blocks, and
 * sleeps whenever there is no transient work. Scheduler-local Refs are
 * serialized only against each other, deliberately not under the runtime
 * mutation Semaphore, which owns durable commits and snapshot replacement.
 * Attachment intentionally wakes recovery so a rebuilt frontier is inspected
 * promptly.
 */
import { Cause, Data, Effect, Exit, type FileSystem, Option, type Path, Queue, Ref } from "effect";
import {
  applyAffectedKeys,
  classifyWorkstream,
  FRONTIER_KIND_ORDER,
  type FrontierEntry,
  WORKER_POLL_INTERVAL_MILLIS,
} from "./canonical-frontier.js";
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
} from "./domain/workstream.js";

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
  /** Present only for review Tasks; references are resolved to canonical content. */
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

export interface ReconciliationCommitReceipt {
  readonly key: AttemptKey;
  readonly revision: number;
  readonly context: ReconciliationContext;
}

/**
 * One commit attempt. `committed` always means the aggregate changed and its
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

/** Narrow canonical port: one immutable entry plus its exact-key control. */
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

export type ControlFactory = (key: AttemptKey) => ReconciliationControl;

interface SchedulerState {
  readonly entries: readonly FrontierEntry[];
  readonly blocked: ReadonlySet<string>;
  readonly nextAtMillis: ReadonlyMap<string, number>;
}

const EMPTY_STATE: SchedulerState = {
  entries: [],
  blocked: new Set(),
  nextAtMillis: new Map(),
};

/**
 * Lease-lifetime reconciliation scheduler. Durable mutation happens only
 * through the runtime's Semaphore-backed control, while scheduler-local
 * frontier and deadline Refs are serialized only against each other. The
 * frontier therefore never observes a partial durable aggregate transition.
 */
export class ReconciliationScheduler {
  private constructor(
    private readonly driver: ReconciliationDriver,
    private readonly attention: ReconciliationAttention,
    private readonly controls: Ref.Ref<ControlFactory | undefined>,
    private readonly state: Ref.Ref<SchedulerState>,
    private readonly wake: Queue.Queue<void>,
  ) {}

  static make(
    driver: ReconciliationDriver,
    attention: ReconciliationAttention,
  ): Effect.Effect<ReconciliationScheduler> {
    return Effect.gen(function* () {
      const state = yield* Ref.make<SchedulerState>(EMPTY_STATE);
      const wake = yield* Queue.dropping<void>(1);
      const controls = yield* Ref.make<ControlFactory | undefined>(undefined);
      return new ReconciliationScheduler(driver, attention, controls, state, wake);
    });
  }

  /**
   * Install the exact-key control factory. The runtime calls this while the
   * scheduler is still asleep, so the first dispatch always has a usable
   * control and there is no circular runtime capture.
   */
  readonly provideControls = (factory: ControlFactory): Effect.Effect<void> =>
    Ref.set(this.controls, factory);

  /**
   * Full classification: one authoritative aggregate read, transient state
   * cleared. Attachment and manual reconcile share this single implementation.
   */
  readonly attach = (workstream: Workstream): Effect.Effect<void> =>
    Ref.set(this.state, {
      entries: classifyWorkstream(workstream),
      blocked: new Set<string>(),
      nextAtMillis: new Map<string, number>(),
    }).pipe(Effect.andThen(this.signal()));

  /**
   * Incremental committed-transition hook: replace only the explicitly affected
   * Attempt keys and clear their transient blocks. Every committed transition
   * calls this with its exact keys after a successful commit.
   */
  readonly notifyCommitted = (
    workstream: Workstream,
    keys: readonly AttemptKey[],
  ): Effect.Effect<void> =>
    Ref.update(this.state, (current) => {
      const blocked = new Set(current.blocked);
      const nextAtMillis = new Map(current.nextAtMillis);
      for (const key of keys) {
        for (const kind of FRONTIER_KIND_ORDER) {
          const identity = identityOf(key, kind);
          blocked.delete(identity);
          nextAtMillis.delete(identity);
        }
      }
      return {
        entries: applyAffectedKeys(current.entries, workstream, keys),
        blocked,
        nextAtMillis,
      };
    }).pipe(Effect.andThen(this.signal()));

  readonly snapshot = (): Effect.Effect<FrontierEntry[]> =>
    Ref.get(this.state).pipe(Effect.map((current) => structuredClone([...current.entries])));

  /** One wake regardless of how many commits preceded it. */
  private readonly signal = (): Effect.Effect<void> => Queue.offer(this.wake, undefined);

  /** The scheduler fiber body; interrupts and joins with its owning Scope. */
  readonly run = (): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(
      function* (this: ReconciliationScheduler) {
        while (true) {
          const now = yield* nowMillis();
          const state = yield* Ref.get(this.state);
          const candidate = nextCandidate(state, now);
          if (candidate === undefined) {
            // No transient work: sleep until an explicit wake (commit or manual
            // reconcile). No aggregate reconciliation loop exists here.
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
          yield* this.dispatch(candidate.entry, now);
        }
      }.bind(this),
    );

  private dispatch(
    entry: FrontierEntry,
    now: number,
  ): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> {
    return Effect.gen(
      function* (this: ReconciliationScheduler) {
        const factory = yield* Ref.get(this.controls);
        if (factory === undefined) {
          yield* this.block(entry, "Reconciliation control is not available; obligation retained.");
          return;
        }
        const exit = yield* Effect.exit(this.driver.reconcile(entry, factory(entry.key)));
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

  private wait(entry: FrontierEntry, now: number): Effect.Effect<void> {
    const retry = retryDelayFor(entry);
    if (retry === undefined) {
      // Unresolved or unknown presence: block in memory until an affected state
      // change or explicit manual reconcile, never a durable success fact.
      return this.block(entry, `${entry.kind} remains unresolved without an exact identity.`);
    }
    return Ref.update(this.state, (current) => ({
      ...current,
      nextAtMillis: new Map(current.nextAtMillis).set(
        identityOf(entry.key, entry.kind),
        now + retry,
      ),
    }));
  }

  private block(entry: FrontierEntry, detail: string): Effect.Effect<void> {
    return Ref.update(this.state, (current) => ({
      ...current,
      blocked: new Set(current.blocked).add(identityOf(entry.key, entry.kind)),
    })).pipe(Effect.andThen(this.attention(detail)));
  }

  private contains(entry: FrontierEntry): Effect.Effect<boolean> {
    return Ref.get(this.state).pipe(Effect.map((current) => current.entries.includes(entry)));
  }

  /** Consume the coalesced wake produced by the commit that replaced this entry. */
  private consumeWake(): Effect.Effect<void> {
    return Queue.poll(this.wake).pipe(Effect.asVoid);
  }
}

function nextCandidate(
  state: SchedulerState,
  now: number,
): { readonly entry: FrontierEntry; readonly delayMillis: number } | undefined {
  let best: { entry: FrontierEntry; due: number } | undefined;
  for (const entry of state.entries) {
    const identity = identityOf(entry.key, entry.kind);
    if (state.blocked.has(identity)) continue;
    const due = Math.max(state.nextAtMillis.get(identity) ?? 0, entryDueMillis(entry));
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
