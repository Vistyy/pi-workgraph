/** Pure classification of current SQLite facts for the coalesced reconciler. */
import { DateTime } from "effect";
import {
  type Attempt,
  type AttemptKey,
  type CancellationCheckpoint,
  type Delivery,
  isOperationallyStable,
  type LaunchCheckpoint,
  type Placement,
  type Task,
  type WorkerExecution,
  type Workstream,
} from "../domain/workstream.js";

/**
 * Exact ready Worker identity a driver may poll. Polling needs the Pi session
 * file as well as the Herdr resource fields, so partial identity never polls.
 */
interface ReadyWorkerIdentity {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly terminalId: string;
  readonly agentName: string;
  readonly cwd: string;
  readonly sessionFile: string;
}

const DELIVERY_RETRY_BASE_MILLIS = 1_000;
const DELIVERY_RETRY_CAP_MILLIS = 30_000;
export const WORKER_POLL_INTERVAL_MILLIS = 1_000;

/** Shared ordering for classification, replacement, and transient bookkeeping. */
export const FRONTIER_KIND_ORDER = [
  "queued",
  "placement_recovery",
  "worker_poll",
  "cancellation",
  "delivery",
  "cleanup",
] as const;

export type FrontierEntry = Readonly<
  | {
      readonly kind: "queued";
      readonly key: AttemptKey;
      readonly taskKind: Task["kind"];
    }
  | {
      readonly kind: "placement_recovery";
      readonly key: AttemptKey;
      readonly placement: Placement;
      readonly sessionFile?: string;
      readonly launch?: LaunchCheckpoint;
    }
  | {
      readonly kind: "worker_poll";
      readonly key: AttemptKey;
      readonly worker: ReadyWorkerIdentity;
    }
  | {
      readonly kind: "cancellation";
      readonly key: AttemptKey;
      readonly cancellation: CancellationCheckpoint;
      readonly placement: Placement;
      readonly sessionFile?: string;
      readonly launch?: LaunchCheckpoint;
      readonly worker?: ReadyWorkerIdentity;
    }
  | {
      readonly kind: "cleanup";
      readonly key: AttemptKey;
      readonly cleanup?: NonNullable<Attempt["cleanup"]>;
      readonly sessionFile?: string;
      readonly launch?: LaunchCheckpoint;
      readonly worker?: ReadyWorkerIdentity;
    }
  | {
      readonly kind: "delivery";
      readonly key: AttemptKey;
      readonly outcomeId: string;
      /** Absent means immediately eligible; present means not before this instant. */
      readonly dueAt?: string;
    }
>;

/**
 * Bounded exponential backoff for one pending delivery: the initial pending
 * delivery is immediately eligible, then after each failure the wait doubles
 * from one second to a thirty-second cap. The wait is measured from the last
 * recorded failure, so it is derived transiently and never persisted.
 */
function deliveryRetryDelayMillis(failureCount: number): number {
  if (failureCount <= 0) return 0;
  return Math.min(DELIVERY_RETRY_BASE_MILLIS * 2 ** (failureCount - 1), DELIVERY_RETRY_CAP_MILLIS);
}

function deliveryDueAt(delivery: Delivery | undefined): string | undefined {
  if (delivery === undefined || delivery.state !== "pending") return undefined;
  const lastFailure = delivery.failureHistory.at(-1);
  if (lastFailure === undefined) return undefined;
  const recorded = Date.parse(lastFailure.at);
  if (Number.isNaN(recorded)) return undefined;
  const due = recorded + deliveryRetryDelayMillis(delivery.failureHistory.length);
  return DateTime.toDate(DateTime.makeUnsafe(due)).toISOString();
}

/** Preserve record order and per-Attempt kind order. */
/** Classify directly queried actionable rows without assembling a Workstream. */
export function classifyActionable(
  lifecycle: Workstream["lifecycle"],
  currentIntentIndex: number,
  records: readonly Readonly<{ task: Task; attempt: Attempt }>[],
): FrontierEntry[] {
  return records.flatMap(({ task, attempt }) =>
    classifyAttempt(task, attempt, currentIntentIndex, lifecycle),
  );
}

function classifyAttempt(
  task: Task,
  attempt: Attempt,
  currentIntentIndex: number,
  lifecycle: Workstream["lifecycle"],
): FrontierEntry[] {
  if (attempt.state === "queued")
    return lifecycle === "active" ? classifyQueued(task, attempt, currentIntentIndex) : [];
  if (attempt.state === "active") return classifyActive(task, attempt, lifecycle);
  return classifyFinished(task, attempt, lifecycle);
}

function classifyQueued(task: Task, attempt: Attempt, currentIntentIndex: number): FrontierEntry[] {
  // Queued work is runnable only under the current Intent; stale-Intent work
  // stays durable but is never scheduled merely because it persists.
  if (task.intentIndex !== currentIntentIndex) return [];
  return [{ kind: "queued", key: attemptKey(task, attempt), taskKind: task.kind }];
}

function classifyActive(
  task: Task,
  attempt: Attempt,
  lifecycle: Workstream["lifecycle"],
): FrontierEntry[] {
  const key = attemptKey(task, attempt);
  const execution = attempt.execution;
  const placement = execution?.placement;
  // The durable placement declaration always exists for an active Attempt; a
  // violation is ambiguous persisted state, never runnable work.
  if (placement === undefined) return [];
  const worker = readyWorker(execution);
  const sessionFile = execution?.sessionFile;
  const launch = execution?.launch;
  const cancellation = execution?.cancellation;
  // An active cancellation stays in the frontier for every checkpoint state,
  // including terminated, until the Attempt terminalizes. Its exact
  // ready Worker, when present, is what supports repeated polling.
  if (cancellation !== undefined) {
    const entry: CancellationEntry = { kind: "cancellation", key, cancellation, placement };
    if (sessionFile !== undefined) entry.sessionFile = sessionFile;
    if (launch !== undefined) entry.launch = launch;
    if (worker !== undefined) entry.worker = worker;
    return [entry];
  }
  // A ready Worker identity is the only case that supports repeated exact
  // presence polling; it needs submission confirmation or settlement.
  if (worker !== undefined) {
    if (lifecycle === "suspended" && execution?.submission === "not_sent") return [];
    return [{ kind: "worker_poll", key, worker }];
  }
  if (lifecycle === "suspended") return [];
  const entry: PlacementRecoveryEntry = { kind: "placement_recovery", key, placement };
  if (sessionFile !== undefined) entry.sessionFile = sessionFile;
  if (launch !== undefined) entry.launch = launch;
  return [entry];
}

function classifyFinished(
  task: Task,
  attempt: Attempt,
  lifecycle: Workstream["lifecycle"],
): FrontierEntry[] {
  // Finished history: only unsettled obligations are runnable.
  if (isOperationallyStable(task, attempt)) return [];
  const key = attemptKey(task, attempt);
  const entries: FrontierEntry[] = [];
  const outcome = attempt.outcome;
  if (lifecycle !== "suspended" && outcome !== undefined && outcome.delivery.state === "pending")
    entries.push(deliveryEntry(key, outcome));
  const execution = attempt.execution;
  // Blocked cleanup and manual application/output release are never scheduled;
  // only a pending or not-yet-recorded cleanup is retry-safe.
  if (execution?.placement !== undefined && retrySafeCleanup(attempt)) {
    const entry: CleanupEntry = { kind: "cleanup", key };
    if (attempt.cleanup !== undefined) entry.cleanup = attempt.cleanup;
    if (execution.sessionFile !== undefined) entry.sessionFile = execution.sessionFile;
    if (execution.launch !== undefined) entry.launch = execution.launch;
    const worker = readyWorker(execution);
    if (worker !== undefined) entry.worker = worker;
    entries.push(entry);
  }
  return entries;
}

function deliveryEntry(key: AttemptKey, outcome: NonNullable<Attempt["outcome"]>): FrontierEntry {
  const dueAt = deliveryDueAt(outcome.delivery);
  return dueAt === undefined
    ? { kind: "delivery", key, outcomeId: outcome.id }
    : { kind: "delivery", key, outcomeId: outcome.id, dueAt };
}

function retrySafeCleanup(attempt: Attempt): boolean {
  return attempt.cleanup === undefined || attempt.cleanup.state === "pending";
}

function attemptKey(task: Task, attempt: Attempt): AttemptKey {
  return { taskId: task.id, attemptId: attempt.id };
}

function readyWorker(execution: WorkerExecution | undefined): ReadyWorkerIdentity | undefined {
  const launch = execution?.launch;
  const sessionFile = execution?.sessionFile;
  if (launch?.phase !== "ready" || sessionFile === undefined) return undefined;
  return {
    workspaceId: launch.workspaceId,
    tabId: launch.tabId,
    paneId: launch.paneId,
    terminalId: launch.terminalId,
    agentName: launch.agentName,
    cwd: launch.cwd,
    sessionFile,
  };
}

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };
type CancellationEntry = Mutable<Extract<FrontierEntry, { kind: "cancellation" }>>;
type CleanupEntry = Mutable<Extract<FrontierEntry, { kind: "cleanup" }>>;
type PlacementRecoveryEntry = Mutable<Extract<FrontierEntry, { kind: "placement_recovery" }>>;
