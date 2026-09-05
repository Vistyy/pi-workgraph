import { mkdir } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isWorkerReport } from "./report-schema.js";
import type { WorkerMode, WorkerReport } from "./types.js";

type Generation = { runId: string; nodeId: string };

export async function forkConversationSession(request: {
  parentSessionFile: string;
  targetCwd: string;
  entryId?: string;
}): Promise<string> {
  const parent = SessionManager.open(request.parentSessionFile);
  if (request.entryId && !parent.getEntry(request.entryId))
    throw new Error(`Unknown conversation entry: ${request.entryId}`);
  const child = SessionManager.forkFrom(
    request.parentSessionFile,
    request.targetCwd,
  );
  if (request.entryId) child.branch(request.entryId);
  const file = child.getSessionFile();
  if (!file)
    throw new Error(
      "Forked coordinator session did not produce a session file.",
    );
  return file;
}

/** Workers are fresh by default. Continuation explicitly names an earlier worker session. */
export async function createWorkerSession(
  request: Generation & {
    targetCwd: string;
    sessionDir: string;
    objective: string;
    mode: WorkerMode;
    continuationSessionFile?: string;
  },
): Promise<string> {
  await mkdir(request.sessionDir, { recursive: true });
  const child = request.continuationSessionFile
    ? SessionManager.forkFrom(
        request.continuationSessionFile,
        request.targetCwd,
        request.sessionDir,
      )
    : SessionManager.create(request.targetCwd, request.sessionDir);
  child.appendCustomMessageEntry(
    "pi-workgraph-objective",
    [
      `[WORKGRAPH ${request.mode.toUpperCase()} OBJECTIVE]`,
      `Workstream: ${request.runId}`,
      `Attempt: ${request.nodeId}`,
      "",
      request.objective.trim(),
    ].join("\n"),
    false,
    { runId: request.runId, nodeId: request.nodeId, mode: request.mode },
  );
  if (!request.continuationSessionFile) {
    // Pi defers a new session's disk flush until its first assistant message.
    // This local persistence marker is excluded from worker evidence/model observations.
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
      timestamp: Date.now(),
    });
  }
  const file = child.getSessionFile();
  if (!file) throw new Error("Worker session did not produce a session file.");
  return file;
}

export interface WorkgraphReportRead {
  report?: WorkerReport;
  invalid: boolean;
  unreadable: boolean;
  error?: string;
}

export function readWorkgraphReportResult(
  sessionFile: string,
  generation: Generation,
): WorkgraphReportRead {
  try {
    const messages = attemptMessages(sessionFile, generation);
    for (const message of messages.reverse()) {
      if (
        message.role !== "toolResult" ||
        message.toolName !== "workgraph_report"
      )
        continue;
      if (message.isError)
        return {
          invalid: true,
          unreadable: false,
          error: "The Workgraph report tool returned an error.",
        };
      const details = isRecord(message.details) ? message.details : undefined;
      if (isWorkerReport(details?.report))
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

export function hasNativeAgentStarted(
  sessionFile: string,
  runId: string,
  nodeId: string,
): boolean {
  return hasNativeMarker(sessionFile, "pi-workgraph-agent-running", {
    runId,
    nodeId,
  });
}

export function hasNativeAgentSettled(
  sessionFile: string,
  runId: string,
  nodeId: string,
): boolean {
  return hasNativeMarker(sessionFile, "pi-workgraph-agent-settled", {
    runId,
    nodeId,
  });
}

function hasNativeMarker(
  sessionFile: string,
  customType: string,
  generation: Generation,
): boolean {
  try {
    for (const entry of attemptEntries(sessionFile, generation).reverse()) {
      if (entry.type !== "custom" || !markerMatches(entry.data, generation))
        continue;
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

function markerMatches(value: unknown, generation: Generation): boolean {
  return (
    isRecord(value) &&
    value.runId === generation.runId &&
    value.nodeId === generation.nodeId
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function attemptEntries(sessionFile: string, generation: Generation) {
  const entries = SessionManager.open(sessionFile).getBranch();
  const boundary = entries.findLastIndex(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === "pi-workgraph-objective" &&
      markerMatches(entry.details, generation),
  );
  if (boundary < 0)
    throw new Error(
      "Session has no objective for the current attempt generation.",
    );
  return entries.slice(boundary + 1);
}

function attemptMessages(sessionFile: string, generation: Generation) {
  return attemptEntries(sessionFile, generation).flatMap((entry) =>
    entry.type === "message" ? [entry.message] : [],
  );
}

export function effectiveModelObservations(
  sessionFile: string,
  generation: Generation,
) {
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
        !isRecord(entry.data) ||
        !markerMatches(entry.data, generation)
      )
        return [];
      if (
        typeof entry.data.model !== "string" ||
        typeof entry.data.thinking !== "string"
      )
        return [];
      return [
        {
          model: entry.data.model,
          thinking: entry.data.thinking,
          source: "selection",
        },
      ];
    },
  );
}

export function readTerminalText(
  sessionFile: string,
  generation: Generation,
): string | undefined {
  try {
    for (const message of attemptMessages(sessionFile, generation).reverse()) {
      if (message.role !== "assistant" || message.provider === "workgraph")
        continue;
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
