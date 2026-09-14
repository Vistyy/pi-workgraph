import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { Data, Effect, FileSystem, Result } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { type ModelTarget, ModelTargetSchema } from "../domain/model-target.js";
import { isWorkerReport, type WorkerReport } from "../domain/report.js";

const Text = Type.String({ minLength: 1, pattern: "\\S" });

const RoleSchema = Type.Union([
  Type.Literal("research"),
  Type.Literal("experiment"),
  Type.Literal("consultation"),
  Type.Literal("review"),
  Type.Literal("implementation"),
]);

export const WorkerObjectiveDetailsSchema = Type.Object(
  {
    taskId: Text,
    attemptId: Text,
    role: RoleSchema,
    executor: Type.Optional(ModelTargetSchema),
  },
  { additionalProperties: false },
);

const ReportDetailsSchema = Type.Object(
  { report: Type.Unknown() },
  { additionalProperties: false },
);

export const WORKER_KICKOFF = "Begin the assigned Workgraph task";

const EffectiveModelSchema = Type.Object(
  {
    model: ModelTargetSchema.properties.model,
    thinking: ModelTargetSchema.properties.thinking,
  },
  { additionalProperties: false },
);

export type WorkerRole = Static<typeof RoleSchema>;

export type WorkerObjectiveDetails = Static<typeof WorkerObjectiveDetailsSchema>;

export interface WorkerObjective {
  readonly content: string;
  readonly details: WorkerObjectiveDetails;
}

export class PiSessionError extends Data.TaggedError("PiSessionError")<{
  readonly operation: "create" | "recover" | "append-objective" | "persist" | "resolve";
  readonly message: string;
}> {}

export interface WorkerSessionCreation {
  readonly sessionFile: string;
  /** True only for the fresh session persisted by this uninterrupted call. */
  readonly fresh: boolean;
}

/** Create or recover the one exact Pi session owned by an Attempt. */
export function createWorkerSessionEffect(request: {
  readonly cwd: string;
  readonly sessionDir: string;
  readonly objective: WorkerObjective;
}): Effect.Effect<WorkerSessionCreation, PiSessionError | PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    if (!validObjective(request.objective))
      return yield* new PiSessionError({
        operation: "create",
        message: "Worker objective is malformed.",
      });
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(request.sessionDir, { recursive: true });

    const matches = yield* nativePromise("recover", () =>
      SessionManager.listAll(request.sessionDir),
    );

    const sameId = matches.filter((entry) => entry.id === request.objective.details.attemptId);

    if (sameId.length > 1)
      return yield* new PiSessionError({
        operation: "recover",
        message: "Multiple Worker sessions claim the exact Attempt session id.",
      });
    const existing = sameId[0];

    if (existing !== undefined) {
      const session = yield* native("recover", () => SessionManager.open(existing.path));

      if (!exactSession(session, request))
        return yield* new PiSessionError({
          operation: "recover",
          message: "Existing Worker session does not match its exact header and objective.",
        });

      return { sessionFile: existing.path, fresh: false };
    }

    const session = yield* native("create", () =>
      SessionManager.create(request.cwd, request.sessionDir, {
        id: request.objective.details.attemptId,
      }),
    );

    yield* native("append-objective", () =>
      session.appendCustomMessageEntry(
        "pi-workgraph-objective",
        request.objective.content,
        true,
        request.objective.details,
      ),
    );
    // Pi otherwise defers the new file until provider activity.
    yield* native("persist", () =>
      session.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Workgraph assignment loaded." }],
        api: "openai-responses",
        provider: "workgraph",
        model: "workgraph",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        // Pi requires an epoch timestamp for the synthetic persistence marker.
        // oxlint-disable-next-line effecttsgo/global-date
        timestamp: Date.now(),
      }),
    );
    const file = session.getSessionFile();

    if (file === undefined)
      return yield* new PiSessionError({
        operation: "resolve",
        message: "Worker session did not produce a session file.",
      });

    return { sessionFile: file, fresh: true };
  });
}

export type WorkerSessionRead =
  | {
      readonly unreadable: true;
      readonly error: string;
      readonly started: false;
      readonly kickoffPersisted: false;
      readonly settled: false;
      readonly effectiveModels: readonly [];
    }
  | {
      readonly unreadable: false;
      readonly started: boolean;
      readonly kickoffPersisted: boolean;
      readonly settled: boolean;
      readonly report?: WorkerReport;
      readonly reportError?: string;
      readonly effectiveModels: readonly ModelTarget[];
    };

/** Decode exact current-branch Worker evidence without transcript duplication. */
export function readWorkerSession(
  sessionFile: string,
  expectedCwd: string,
  expected: WorkerObjective,
): WorkerSessionRead {
  let session: SessionManager;
  let entries: SessionEntry[];

  try {
    session = SessionManager.open(sessionFile);
    const header = session.getHeader();

    if (
      header === null ||
      header.id !== expected.details.attemptId ||
      header.cwd !== expectedCwd ||
      header.parentSession !== undefined
    )
      return unreadable("Worker session header does not match the exact Attempt.");
    entries = session.getBranch();
  } catch {
    return unreadable("Worker session file or header is unreadable.");
  }

  const objective = attemptBranch(entries, expected);
  const branch = Result.isSuccess(objective) ? objective.success : entries;
  const effectiveModels = orderedEffectiveModels(branch);
  const started = effectiveModels.length > 0;

  const kickoffPersisted =
    Result.isSuccess(objective) &&
    branch.some((entry) => {
      if (entry.type !== "message" || entry.message.role !== "user") return false;
      const { content } = entry.message;

      return (
        content === WORKER_KICKOFF ||
        (Array.isArray(content) &&
          content.length === 1 &&
          content[0]?.type === "text" &&
          content[0].text === WORKER_KICKOFF)
      );
    });

  const settled = branch.some(
    (entry) => entry.type === "custom" && entry.customType === "pi-workgraph-agent-settled",
  );

  if (Result.isFailure(objective))
    return {
      unreadable: false,
      started,
      kickoffPersisted,
      settled,
      reportError: bounded(objective.failure),
      effectiveModels,
    };

  let reportDetails: unknown;
  let reportFound = false;

  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch.at(index);

    if (
      entry?.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.toolName === "workgraph_report" &&
      entry.message.isError !== true
    ) {
      reportDetails = entry.message.details;
      reportFound = true;
      break;
    }
  }

  if (!reportFound)
    return settled
      ? {
          unreadable: false,
          started,
          kickoffPersisted,
          settled,
          reportError: "Settled Worker session has no successful terminal report.",
          effectiveModels,
        }
      : { unreadable: false, started, kickoffPersisted, settled, effectiveModels };

  if (!Value.Check(ReportDetailsSchema, reportDetails))
    return {
      unreadable: false,
      started,
      kickoffPersisted,
      settled,
      reportError: "Worker terminal report details are malformed.",
      effectiveModels,
    };
  const report = Value.Decode(ReportDetailsSchema, reportDetails).report;

  return isWorkerReport(report)
    ? { unreadable: false, started, kickoffPersisted, settled, report, effectiveModels }
    : {
        unreadable: false,
        started,
        kickoffPersisted,
        settled,
        reportError: "Worker terminal report is malformed.",
        effectiveModels,
      };
}

function validObjective(objective: WorkerObjective): boolean {
  return (
    objective.content.trim().length > 0 &&
    Value.Check(WorkerObjectiveDetailsSchema, objective.details) &&
    (objective.details.role === "implementation"
      ? objective.details.executor !== undefined
      : objective.details.executor === undefined)
  );
}

function exactSession(
  session: SessionManager,
  request: { readonly cwd: string; readonly objective: WorkerObjective },
): boolean {
  const header = session.getHeader();

  return (
    header !== null &&
    header.id === request.objective.details.attemptId &&
    header.cwd === request.cwd &&
    header.parentSession === undefined &&
    Result.isSuccess(attemptBranch(session.getBranch(), request.objective))
  );
}

function attemptBranch(
  entries: readonly SessionEntry[],
  objective: WorkerObjective,
): Result.Result<SessionEntry[], string> {
  const objectiveEntries = entries.filter(
    (entry) => entry.type === "custom_message" && entry.customType === "pi-workgraph-objective",
  );

  const match = objectiveEntries[0];

  if (
    objectiveEntries.length !== 1 ||
    match?.type !== "custom_message" ||
    match.content !== objective.content ||
    !Value.Check(WorkerObjectiveDetailsSchema, match.details) ||
    !sameObjectiveDetails(
      Value.Decode(WorkerObjectiveDetailsSchema, match.details),
      objective.details,
    )
  )
    return Result.fail("Exact Worker objective is absent, malformed, or mismatched.");

  return Result.succeed(entries.slice(entries.indexOf(match)));
}

function orderedEffectiveModels(entries: readonly SessionEntry[]): ModelTarget[] {
  const result: ModelTarget[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (
      entry.type !== "custom" ||
      entry.customType !== "pi-workgraph-effective-model" ||
      !Value.Check(EffectiveModelSchema, entry.data)
    )
      continue;
    const marker = Value.Decode(EffectiveModelSchema, entry.data);
    const key = `${marker.model}\0${marker.thinking}`;

    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ model: marker.model, thinking: marker.thinking });
  }

  return result;
}

function sameObjectiveDetails(
  actual: WorkerObjectiveDetails,
  expected: WorkerObjectiveDetails,
): boolean {
  return (
    actual.taskId === expected.taskId &&
    actual.attemptId === expected.attemptId &&
    actual.role === expected.role &&
    actual.executor?.model === expected.executor?.model &&
    actual.executor?.thinking === expected.executor?.thinking
  );
}

function unreadable(error: string): WorkerSessionRead {
  return {
    unreadable: true,
    error: bounded(error),
    started: false,
    kickoffPersisted: false,
    settled: false,
    effectiveModels: [],
  };
}

function bounded(message: string): string {
  return message.replace(/\s+/g, " ").slice(0, 300);
}

function native<A>(
  operation: PiSessionError["operation"],
  run: () => A,
): Effect.Effect<A, PiSessionError> {
  return Effect.try({
    try: run,
    catch: () =>
      new PiSessionError({ operation, message: `Pi SessionManager ${operation} failed.` }),
  });
}

function nativePromise<A>(
  operation: PiSessionError["operation"],
  run: () => Promise<A>,
): Effect.Effect<A, PiSessionError> {
  return Effect.tryPromise({
    try: run,
    catch: () =>
      new PiSessionError({ operation, message: `Pi SessionManager ${operation} failed.` }),
  });
}
