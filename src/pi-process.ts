/* oxlint-disable effecttsgo/global-date, anti-slop/no-unknown-parameters -- Pi requires an epoch timestamp; persisted entry identity is decoded here. */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Data, Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { type ModelTarget, ModelTargetSchema } from "./domain/model-target.js";
import { isWorkerReport, type WorkerReport, type WorkerSessionMode } from "./domain/report.js";

type Generation = { runId: string; nodeId: string };
const IdentitySchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  nodeId: Type.String({ minLength: 1 }),
});
const ReportDetailsSchema = Type.Object({ report: Type.Unknown() });
const EffectiveModelSchema = Type.Intersect([
  IdentitySchema,
  Type.Object({
    model: ModelTargetSchema.properties.model,
    thinking: ModelTargetSchema.properties.thinking,
  }),
]);

export class PiSessionError extends Data.TaggedError("PiSessionError")<{
  readonly operation: "create" | "append-objective" | "persist" | "resolve";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Create one fresh Worker session; Attempts never continue a prior Pi conversation. */
export function createWorkerSessionEffect(
  request: Generation & {
    targetCwd: string;
    sessionDir: string;
    objective: string;
    mode: WorkerSessionMode;
  },
): Effect.Effect<string, PiSessionError | PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(request.sessionDir, { recursive: true });
    const session = yield* native("create", () =>
      SessionManager.create(request.targetCwd, request.sessionDir),
    );
    yield* native("append-objective", () =>
      session.appendCustomMessageEntry(
        "pi-workgraph-objective",
        [
          `[WORKGRAPH ${request.mode.toUpperCase()} OBJECTIVE]`,
          `Workstream: ${request.runId}`,
          `Attempt: ${request.nodeId}`,
          "",
          request.objective.trim(),
        ].join("\n"),
        true,
        { runId: request.runId, nodeId: request.nodeId, mode: request.mode },
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
        timestamp: Date.now(),
      }),
    );
    const file = yield* native("resolve", () => session.getSessionFile());
    if (file === undefined)
      return yield* new PiSessionError({
        operation: "resolve",
        message: "Worker session did not produce a session file.",
      });
    return file;
  });
}

export interface WorkgraphReportRead {
  readonly report?: WorkerReport;
  readonly effectiveModels: readonly ModelTarget[];
  readonly invalid: boolean;
  readonly unreadable: boolean;
  readonly error?: string;
}

/** Read only semantic report evidence from the exact Attempt segment. */
export function readWorkgraphReportResult(
  sessionFile: string,
  generation: Generation,
): WorkgraphReportRead {
  try {
    const entries = attemptEntries(sessionFile, generation);
    const effectiveModels = orderedEffectiveModels(entries, generation);
    for (const entry of [...entries].reverse()) {
      if (
        entry.type !== "message" ||
        entry.message.role !== "toolResult" ||
        entry.message.toolName !== "workgraph_report" ||
        entry.message.isError === true
      )
        continue;
      if (!Value.Check(ReportDetailsSchema, entry.message.details))
        return { effectiveModels, invalid: true, unreadable: false };
      const report = Value.Decode(ReportDetailsSchema, entry.message.details).report;
      return isWorkerReport(report)
        ? { report, effectiveModels, invalid: false, unreadable: false }
        : { effectiveModels, invalid: true, unreadable: false };
    }
    return { effectiveModels, invalid: false, unreadable: false };
  } catch (cause) {
    return {
      effectiveModels: [],
      invalid: false,
      unreadable: true,
      error: cause instanceof Error ? cause.message.slice(0, 300) : "Worker session is unreadable.",
    };
  }
}

export function hasNativeAgentSettled(sessionFile: string, runId: string, nodeId: string): boolean {
  try {
    return attemptEntries(sessionFile, { runId, nodeId }).some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "pi-workgraph-agent-settled" &&
        sameIdentity(entry.data, { runId, nodeId }),
    );
  } catch {
    return false;
  }
}

function attemptEntries(sessionFile: string, generation: Generation) {
  const entries = SessionManager.open(sessionFile).getBranch();
  const start = entries.findLastIndex(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === "pi-workgraph-objective" &&
      sameIdentity(entry.details, generation),
  );
  if (start < 0) throw new Error("Exact Attempt objective is absent.");
  return entries.slice(start);
}
function orderedEffectiveModels(
  entries: ReturnType<typeof attemptEntries>,
  generation: Generation,
): ModelTarget[] {
  const targets: ModelTarget[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (
      entry.type !== "custom" ||
      entry.customType !== "pi-workgraph-effective-model" ||
      !Value.Check(EffectiveModelSchema, entry.data)
    )
      continue;
    const fact = Value.Decode(EffectiveModelSchema, entry.data);
    if (!sameIdentity(fact, generation)) continue;
    const key = `${fact.model}\0${fact.thinking}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ model: fact.model, thinking: fact.thinking });
  }
  return targets;
}
function sameIdentity(value: unknown, expected: Generation): boolean {
  if (!Value.Check(IdentitySchema, value)) return false;
  const identity = Value.Decode(IdentitySchema, value);
  return identity.runId === expected.runId && identity.nodeId === expected.nodeId;
}
function native<A>(
  operation: PiSessionError["operation"],
  run: () => A,
): Effect.Effect<A, PiSessionError> {
  return Effect.try({
    try: run,
    catch: (cause) =>
      new PiSessionError({ operation, message: `Pi SessionManager ${operation} failed.`, cause }),
  });
}
