import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Data, Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { EnrichmentPacketSchema, isWorkerReport } from "./report-schema.js";
import type { EnrichmentPacket, WorkerReport, WorkerSessionMode } from "./types.js";

type Generation = { runId: string; nodeId: string };
const GenerationDataSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  nodeId: Type.String({ minLength: 1 }),
});
const ReportDetailsSchema = Type.Object({ report: Type.Unknown() });
const EnrichmentDetailsSchema = Type.Intersect([
  GenerationDataSchema,
  Type.Object({ packet: EnrichmentPacketSchema }),
]);
const NativeSubmissionMarkerSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
    nodeId: Type.String({ minLength: 1 }),
    state: Type.Union([Type.Literal("not_submitted"), Type.Literal("submitted")]),
  },
  { additionalProperties: false },
);
const ProviderAvailabilityMarkerSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
    nodeId: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 1 }),
    thinking: Type.String({ minLength: 1 }),
    availability: Type.Literal("unavailable"),
    submission: Type.Literal("not_submitted"),
    reason: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
const ModelPreflightSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
    nodeId: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 1 }),
    thinking: Type.String({ minLength: 1 }),
    state: Type.Union([
      Type.Literal("ready"),
      Type.Literal("missing_model"),
      Type.Literal("missing_credentials"),
      Type.Literal("unsupported_thinking"),
    ]),
    detail: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
/** Provider adapters may append these generation-scoped entries; absence is never proof of non-submission. */
export const NATIVE_SUBMISSION_MARKER = "pi-workgraph-native-submission" as const;
export const PROVIDER_AVAILABILITY_MARKER = "pi-workgraph-provider-availability" as const;
export const MODEL_PREFLIGHT_MARKER = "pi-workgraph-model-preflight" as const;
const EffectiveModelSchema = Type.Intersect([
  GenerationDataSchema,
  Type.Object({ model: Type.String({ minLength: 1 }), thinking: Type.String({ minLength: 1 }) }),
]);
type EffectiveModel = Static<typeof EffectiveModelSchema>;
export type NativeFailureCategory = "provider-rate-limit" | "native-abort" | "native-error";
const PROVIDER_RATE_LIMIT_PATTERN = /(?:\b429\b|rate[\s_-]*limit|too many requests)/i;

export type PiSessionOperation =
  | "open-parent"
  | "validate-entry"
  | "fork"
  | "branch"
  | "create"
  | "append-objective"
  | "persist-new-session"
  | "resolve-session-file";

export class PiSessionError extends Data.TaggedError("PiSessionError")<{
  readonly operation: PiSessionOperation;
  readonly message: string;
  readonly cause?: unknown;
}> {}

type ForkConversationRequest = {
  parentSessionFile: string;
  targetCwd: string;
  entryId?: string;
};

export function forkConversationSessionEffect(
  request: ForkConversationRequest,
): Effect.Effect<string, PiSessionError> {
  return Effect.gen(function* () {
    const parent = yield* nativeSession("open-parent", () =>
      SessionManager.open(request.parentSessionFile),
    );
    const { entryId } = request;
    if (entryId !== undefined) {
      const entry = yield* nativeSession("validate-entry", () => parent.getEntry(entryId));
      if (!entry)
        return yield* new PiSessionError({
          operation: "validate-entry",
          message: `Unknown conversation entry: ${entryId}`,
        });
    }
    const child = yield* nativeSession("fork", () =>
      SessionManager.forkFrom(request.parentSessionFile, request.targetCwd),
    );
    if (entryId !== undefined) yield* nativeSession("branch", () => child.branch(entryId));
    const file = yield* nativeSession("resolve-session-file", () => child.getSessionFile());
    if (file === undefined)
      return yield* new PiSessionError({
        operation: "resolve-session-file",
        message: "Forked coordinator session did not produce a session file.",
      });
    return file;
  });
}

type CreateWorkerRequest = Generation & {
  targetCwd: string;
  sessionDir: string;
  objective: string;
  mode: WorkerSessionMode;
  continuationSessionFile?: string;
};

/** Workers are fresh by default. Continuation explicitly names an earlier worker session. */
export function createWorkerSessionEffect(
  request: CreateWorkerRequest,
): Effect.Effect<string, PiSessionError | PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(request.sessionDir, { recursive: true });
    const child = yield* nativeSession(
      request.continuationSessionFile === undefined ? "create" : "fork",
      () =>
        request.continuationSessionFile !== undefined
          ? SessionManager.forkFrom(
              request.continuationSessionFile,
              request.targetCwd,
              request.sessionDir,
            )
          : SessionManager.create(request.targetCwd, request.sessionDir),
    );
    yield* nativeSession("append-objective", () =>
      child.appendCustomMessageEntry(
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
    if (request.continuationSessionFile === undefined) {
      // Pi defers a new session's disk flush until its first assistant message.
      // This local persistence marker is excluded from worker evidence/model observations.
      yield* nativeSession("persist-new-session", () =>
        child.appendMessage({
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
          // oxlint-disable-next-line effecttsgo/global-date -- Pi's native persisted message contract requires an epoch timestamp.
          timestamp: Date.now(),
        }),
      );
    }
    const file = yield* nativeSession("resolve-session-file", () => child.getSessionFile());
    if (file === undefined)
      return yield* new PiSessionError({
        operation: "resolve-session-file",
        message: "Worker session did not produce a session file.",
      });
    return file;
  });
}

function nativeSession<A>(
  operation: PiSessionOperation,
  run: () => A,
): Effect.Effect<A, PiSessionError> {
  return Effect.try({
    try: run,
    catch: (cause) =>
      new PiSessionError({
        operation,
        message: `Pi SessionManager ${operation} failed.`,
        cause,
      }),
  });
}

export interface WorkgraphReportRead {
  report?: WorkerReport;
  invalid: boolean;
  unreadable: boolean;
  error?: string;
}

export interface EnrichmentPacketRead {
  packet?: EnrichmentPacket;
  invalid: boolean;
  unreadable: boolean;
  error?: string;
}

export type NativeSubmissionEvidence = "not_submitted" | "submitted" | "contradictory" | "absent";
export type ModelPreflight = {
  state: "ready" | "missing_model" | "missing_credentials" | "unsupported_thinking";
  model: string;
  thinking: string;
  detail: string;
};
export type ProviderAvailabilityEvidence =
  | { state: "unavailable"; model: string; thinking: string; reason: string }
  | "contradictory"
  | "absent";

export function readWorkgraphReportResult(
  sessionFile: string,
  generation: Generation,
): WorkgraphReportRead {
  try {
    const messages = attemptMessages(sessionFile, generation);
    for (const message of messages.reverse()) {
      if (message.role !== "toolResult" || message.toolName !== "workgraph_report") continue;
      if (message.isError)
        return {
          invalid: true,
          unreadable: false,
          error: "The Workgraph report tool returned an error.",
        };
      const details = Value.Check(ReportDetailsSchema, message.details)
        ? Value.Decode(ReportDetailsSchema, message.details)
        : undefined;
      if (details !== undefined && isWorkerReport(details.report))
        return { report: details.report, invalid: false, unreadable: false };
      return {
        invalid: true,
        unreadable: false,
        error: "The latest Workgraph report has an invalid shape.",
      };
    }
  } catch (error) {
    return {
      invalid: false,
      unreadable: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { invalid: false, unreadable: false };
}

export function readEnrichmentPacketResult(
  sessionFile: string,
  generation: Generation,
): EnrichmentPacketRead {
  try {
    const entries = attemptEntries(sessionFile, generation);
    for (const entry of [...entries].reverse()) {
      if (entry.type !== "custom" || entry.customType !== "pi-workgraph-enrichment") continue;
      if (!markerMatches(entry.data, generation)) continue;
      const details = Value.Check(EnrichmentDetailsSchema, entry.data)
        ? Value.Decode(EnrichmentDetailsSchema, entry.data)
        : undefined;
      if (details === undefined)
        return {
          invalid: true,
          unreadable: false,
          error: "The enrichment packet has an invalid shape.",
        };
      return { packet: details.packet, invalid: false, unreadable: false };
    }
  } catch (error) {
    return {
      invalid: false,
      unreadable: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { invalid: false, unreadable: false };
}

export function readModelPreflight(
  sessionFile: string,
  generation: Generation,
): ModelPreflight | undefined {
  try {
    let matched: ModelPreflight | undefined;
    for (const entry of attemptEntries(sessionFile, generation)) {
      if (entry.type !== "custom" || entry.customType !== MODEL_PREFLIGHT_MARKER) continue;
      if (!Value.Check(ModelPreflightSchema, entry.data)) return undefined;
      const data = Value.Decode(ModelPreflightSchema, entry.data);
      if (!markerMatches(data, generation)) continue;
      const current = {
        state: data.state,
        model: data.model,
        thinking: data.thinking,
        detail: data.detail,
      };
      if (matched !== undefined && !samePreflight(matched, current)) return undefined;
      matched = current;
    }
    return matched;
  } catch {
    return undefined;
  }
}

function samePreflight(left: ModelPreflight, right: ModelPreflight): boolean {
  return (
    left.state === right.state &&
    left.model === right.model &&
    left.thinking === right.thinking &&
    left.detail === right.detail
  );
}

export function providerAvailabilityEvidence(
  sessionFile: string,
  generation: Generation,
  target: { model: string; thinking: string },
): ProviderAvailabilityEvidence {
  try {
    let matched: Extract<ProviderAvailabilityEvidence, { state: "unavailable" }> | undefined;
    for (const entry of attemptEntries(sessionFile, generation)) {
      const observation = providerAvailabilityObservation(entry, generation, target);
      if (observation === "ignore") continue;
      if (observation === "contradictory") return observation;
      if (matched !== undefined && matched.reason !== observation.reason) return "contradictory";
      matched = observation;
    }
    return matched ?? "absent";
  } catch {
    return "absent";
  }
}

function providerAvailabilityObservation(
  entry: SessionEntry,
  generation: Generation,
  target: { model: string; thinking: string },
): Extract<ProviderAvailabilityEvidence, { state: "unavailable" }> | "ignore" | "contradictory" {
  if (entry.type !== "custom" || entry.customType !== PROVIDER_AVAILABILITY_MARKER) return "ignore";
  if (!Value.Check(ProviderAvailabilityMarkerSchema, entry.data)) return "contradictory";
  const data = Value.Decode(ProviderAvailabilityMarkerSchema, entry.data);
  if (
    !markerMatches(data, generation) ||
    data.model !== target.model ||
    data.thinking !== target.thinking
  )
    return "ignore";
  const reason = data.reason.trim();
  if (reason === "") return "contradictory";
  return { state: data.availability, model: data.model, thinking: data.thinking, reason };
}

export function nativeSubmissionEvidence(
  sessionFile: string,
  generation: Generation,
): NativeSubmissionEvidence {
  try {
    let marker: "not_submitted" | "submitted" | undefined;
    for (const entry of attemptEntries(sessionFile, generation)) {
      const observation = submissionEntryObservation(entry, generation);
      const next = mergeSubmissionObservation(marker, observation);
      if (next === "contradictory") return next;
      marker = next;
    }
    return marker ?? "absent";
  } catch {
    return "absent";
  }
}

function mergeSubmissionObservation(
  previous: "not_submitted" | "submitted" | undefined,
  observation: "not_submitted" | "submitted" | "contradictory" | undefined,
): "not_submitted" | "submitted" | "contradictory" | undefined {
  if (observation === undefined) return previous;
  if (observation === "contradictory") return observation;
  return previous === undefined || previous === observation ? observation : "contradictory";
}

function submissionEntryObservation(
  entry: SessionEntry,
  generation: Generation,
): "not_submitted" | "submitted" | "contradictory" | undefined {
  if (
    entry.type === "message" &&
    entry.message.role === "assistant" &&
    entry.message.provider !== "workgraph" &&
    ["stop", "length", "toolUse", "pending"].includes(entry.message.stopReason)
  )
    return "submitted";
  if (entry.type !== "custom" || entry.customType !== NATIVE_SUBMISSION_MARKER) return undefined;
  if (!Value.Check(NativeSubmissionMarkerSchema, entry.data)) return "contradictory";
  const data = Value.Decode(NativeSubmissionMarkerSchema, entry.data);
  if (!markerMatches(data, generation)) return undefined;
  return data.state;
}

export function hasNativeAgentStarted(sessionFile: string, runId: string, nodeId: string): boolean {
  return hasNativeMarker(sessionFile, "pi-workgraph-agent-running", {
    runId,
    nodeId,
  });
}

export function hasNativeAgentSettled(sessionFile: string, runId: string, nodeId: string): boolean {
  return hasNativeMarker(sessionFile, "pi-workgraph-agent-settled", {
    runId,
    nodeId,
  });
}

function hasNativeMarker(sessionFile: string, customType: string, generation: Generation): boolean {
  try {
    for (const entry of attemptEntries(sessionFile, generation).reverse()) {
      if (entry.type !== "custom" || !markerMatches(entry.data, generation)) continue;
      if (entry.customType === customType) return true;
      if (
        entry.customType === "pi-workgraph-agent-running" &&
        customType === "pi-workgraph-agent-settled"
      )
        return false;
    }
  } catch {
    return false;
  }
  return false;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SessionManager custom entry data is a native unknown boundary decoded immediately here.
function markerMatches(value: unknown, generation: Generation): boolean {
  if (!Value.Check(GenerationDataSchema, value)) return false;
  const data = Value.Decode(GenerationDataSchema, value);
  return data.runId === generation.runId && data.nodeId === generation.nodeId;
}

function attemptEntries(sessionFile: string, generation: Generation) {
  const entries = SessionManager.open(sessionFile).getBranch();
  const boundary = entries.findLastIndex(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === "pi-workgraph-objective" &&
      markerMatches(entry.details, generation),
  );
  if (boundary < 0) throw new Error("Session has no objective for the current attempt generation.");
  return entries.slice(boundary + 1);
}

function attemptMessages(sessionFile: string, generation: Generation) {
  return attemptEntries(sessionFile, generation).flatMap((entry) =>
    entry.type === "message" ? [entry.message] : [],
  );
}

export function effectiveModelObservations(sessionFile: string, generation: Generation) {
  return attemptEntries(sessionFile, generation).flatMap(
    (
      entry,
    ): Array<{
      model: string;
      thinking?: string;
      source: "selection" | "message";
    }> => {
      if (
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.provider !== "workgraph"
      )
        return [
          {
            model: `${entry.message.provider}/${entry.message.model}`,
            source: "message",
          },
        ];
      if (
        entry.type !== "custom" ||
        entry.customType !== "pi-workgraph-effective-model" ||
        !Value.Check(EffectiveModelSchema, entry.data)
      )
        return [];
      const data: EffectiveModel = Value.Decode(EffectiveModelSchema, entry.data);
      if (!markerMatches(data, generation)) return [];
      return [{ model: data.model, thinking: data.thinking, source: "selection" }];
    },
  );
}

export function observeNativeFailure(
  sessionFile: string,
  generation: Generation,
): NativeFailureCategory | undefined {
  try {
    for (const message of attemptMessages(sessionFile, generation).reverse()) {
      if (message.role !== "assistant" || message.provider === "workgraph") continue;
      if (message.stopReason === "aborted") return "native-abort";
      if (message.stopReason !== "error") return undefined;
      return message.errorMessage !== undefined &&
        PROVIDER_RATE_LIMIT_PATTERN.test(message.errorMessage)
        ? "provider-rate-limit"
        : "native-error";
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function readWorkerText(sessionFile: string, generation: Generation): string | undefined {
  try {
    for (const message of attemptMessages(sessionFile, generation).reverse()) {
      if (message.role !== "assistant" || message.provider === "workgraph") continue;
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Returns text only when the latest provider assistant message is terminal success. */
export function readTerminalText(sessionFile: string, generation: Generation): string | undefined {
  try {
    for (const message of attemptMessages(sessionFile, generation).reverse()) {
      if (message.role !== "assistant" || message.provider === "workgraph") continue;
      if (message.stopReason !== "stop") return undefined;
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      return text.trim() === "" ? undefined : text;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
