import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { WorkstreamState } from "../src/workstream.js";

export const CAPABILITY_SCENARIO_ASSIGNMENT_IDS = [
  "baseline-research",
  "uppercase-experiment",
  "update-value",
  "concurrent-readme",
  "exact-revision-review",
] as const;

/** The deterministic scenario's protocol is deliberately explicit and inspectable. */
export function capabilityScenarioPrompt(privateToken: string): string {
  return `Use Workgraph capability tools to complete this single bounded workstream without another approval ceremony.
Coordinator-only context: ${privateToken}. Never include that token in worker assignments.
First delegate read-only research id baseline-research to gather cheap evidence about the README marker and exact current value.txt bytes, then use the returned findings to decide what bounded work is justified. End your turn when only workers are running and resume on actual results.
Next delegate disposable experiment id uppercase-experiment, explicitly authorized to read value.txt and write only probe.txt containing its uppercase bytes. Stop after one observation, retain probe.txt, never compose scratch code.
Then delegate maintained implementation id update-value, explicitly authorized to change only value.txt to exactly after followed by one newline, with acceptance node verify.mjs and exact bytes/scope. Use policy guide/executor defaults.
Immediately after queueing implementation, before waiting for its result, queue read-only research id concurrent-readme to read the README marker, demonstrating interleaving.
After maintained composition, delegate independent review id exact-revision-review of that exact retained revision, concerned with scope, exact bytes, absence of probe.txt and node verify.mjs.
You may run read-only verification yourself but do not edit the fixture directly. Do not delegate extra workers or change model policy.
Handle result notifications automatically and inspect execution, findings, evidence, uncertainty, and cleanup. After queueing useful independent work, end your turn to receive notifications; do not poll status, run waits for workers, or wait inside shell commands. Status inspection for an actual result or attention is appropriate.
Independently verify retained probe.txt is BEFORE followed by a newline, maintained value.txt is after followed by a newline, only value.txt changed, node verify.mjs passes, and all owned attempts/resources settled and cleaned.
Complete with concrete evidence and honest limitations only after those conditions hold. Report a blocker instead of claiming success if a required boundary is unavailable.`;
}

/** Extract the assignment ids actually named in the emitted prompt. */
export function capabilityPromptAssignmentIds(prompt: string): string[] {
  return [...prompt.matchAll(/\bid\s+([a-z][a-z0-9-]*)\b/g)].map(
    (match) => match[1]!,
  );
}

export type CoordinatorTurnObservation =
  | { state: "waiting"; detail: string }
  | { state: "settled"; detail: string; assistantIndex: number }
  | { state: "failed"; detail: string; assistantIndex?: number }
  | { state: "blocked"; detail: string; assistantIndex?: number };

function messageText(entry: SessionEntry): string {
  if (entry.type !== "message" || !("content" in entry.message)) return "";
  const content = entry.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        Boolean(block) &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

/**
 * Observe the native Pi turn after the submitted human request.
 * Startup messages, idle metadata, tool-use stops, and queued delivery are not completion.
 */
export function observeCoordinatorTurn(
  entries: SessionEntry[],
  requestText: string,
): CoordinatorTurnObservation {
  const requestIndex = entries.findLastIndex(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "user" &&
      messageText(entry) === requestText,
  );
  if (requestIndex < 0)
    return {
      state: "waiting",
      detail: "Submitted request is not in the native session yet.",
    };

  let settled: CoordinatorTurnObservation | undefined;
  for (let index = requestIndex + 1; index < entries.length; index++) {
    const entry = entries[index]!;
    if (
      entry.type !== "message" ||
      entry.message.role !== "assistant" ||
      !("stopReason" in entry.message)
    )
      continue;
    const reason = entry.message.stopReason;
    if (reason === "error" || reason === "aborted")
      return {
        state: "failed",
        detail: `Native coordinator turn ended with ${reason}: ${messageText(entry) || "no diagnostic text"}`,
        assistantIndex: index,
      };
    if (reason === "length")
      return {
        state: "failed",
        detail: `Native coordinator turn ended incomplete (${reason}): ${messageText(entry) || "no diagnostic text"}`,
        assistantIndex: index,
      };
    if (reason === "stop") {
      const detail =
        messageText(entry) || "Native coordinator turn settled without text.";
      if (
        /(?:cannot|can't|unable|refus(?:e|ed|al)|blocked)\s+(?:complete|continue|proceed|the request)/i.test(
          detail,
        )
      )
        return {
          state: "blocked",
          detail: `Native coordinator reported a blocker: ${detail}`,
          assistantIndex: index,
        };
      settled = { state: "settled", detail, assistantIndex: index };
    }
  }
  return (
    settled ?? {
      state: "waiting",
      detail:
        "Native coordinator request is still progressing; no terminal assistant turn observed.",
    }
  );
}

export type RepositorySnapshot = ReadonlyMap<string, string>;

export function changedSnapshotPaths(
  before: RepositorySnapshot,
  after: RepositorySnapshot,
): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
}

export interface DirectEffectObservation {
  valid: boolean;
  changedPaths: string[];
  detail: string;
}

/** Validate direct native work against independent before/after file bytes. */
export function observeDirectEffect(
  before: RepositorySnapshot,
  after: RepositorySnapshot,
  expectedValueBytes: string,
): DirectEffectObservation {
  const changedPaths = changedSnapshotPaths(before, after);
  const valid =
    changedPaths.length === 1 &&
    changedPaths[0] === "value.txt" &&
    after.get("value.txt") === expectedValueBytes;
  return {
    valid,
    changedPaths,
    detail: valid
      ? "Direct coordinator effect changed only value.txt to the authorized bytes; no delegation was exercised."
      : `Direct coordinator effect is not authorized: changed paths ${changedPaths.join(", ") || "none"}; value.txt bytes are ${after.get("value.txt") ?? "missing"}.`,
  };
}

export interface DelegatedEffectObservation {
  valid: boolean;
  detail: string;
  delegationExercised: true;
  implementationOrigin: "direct" | "delegated";
  experiment: "verified" | "not-run";
}

/** Validate the state-level attribution and cleanup guarantees of a delegated natural strategy. */
export function observeDelegatedOutcome(
  state: WorkstreamState,
  directEffect: DirectEffectObservation,
): DelegatedEffectObservation {
  const problems: string[] = [];
  if (state.lifecycle.state !== "completed")
    problems.push(`workstream lifecycle is ${state.lifecycle.state}`);
  if (state.attempts.length === 0)
    problems.push("no delegated attempts are attributable");
  const assignmentsById = new Map(
    state.assignments.map((assignment) => [assignment.id, assignment]),
  );
  if (assignmentsById.size !== state.assignments.length)
    problems.push("delegated assignments are not uniquely attributable");
  for (const assignment of state.assignments) {
    if (
      !state.attempts.some((attempt) => attempt.assignmentId === assignment.id)
    )
      problems.push(`delegated assignment ${assignment.id} has no attempt`);
  }
  const resultOwners = new Set<string>();
  for (const attempt of state.attempts) {
    const assignment = assignmentsById.get(attempt.assignmentId);
    if (!assignment) {
      problems.push(`attempt ${attempt.id} has no delegated assignment`);
      continue;
    }
    if (!attempt.worker)
      problems.push(`attempt ${attempt.id} has no worker identity`);
    else if (
      !attempt.sessionFile ||
      attempt.worker.sessionFile !== attempt.sessionFile
    )
      problems.push(`attempt ${attempt.id} worker session is not attributable`);
    else if (
      attempt.worktreePath &&
      attempt.worker.cwd !== attempt.worktreePath
    )
      problems.push(`attempt ${attempt.id} worker cwd is not attributable`);
    if (!attempt.resultId)
      problems.push(`attempt ${attempt.id} has no retained result`);
    else {
      if (resultOwners.has(attempt.resultId))
        problems.push(`result ${attempt.resultId} has multiple attempt owners`);
      resultOwners.add(attempt.resultId);
      const result = state.results.find((item) => item.id === attempt.resultId);
      if (!result)
        problems.push(`attempt ${attempt.id} retained result is missing`);
      else if (result.assignmentId !== assignment.id)
        problems.push(`attempt ${attempt.id} result assignment is mismatched`);
      else if (result.assignmentIntentVersion !== assignment.intentVersion)
        problems.push(`attempt ${attempt.id} result intent is mismatched`);
    }
  }
  for (const result of state.results) {
    if (
      !state.attempts.some(
        (attempt) =>
          attempt.resultId === result.id &&
          attempt.assignmentId === result.assignmentId,
      )
    )
      problems.push(`result ${result.id} has no attributable attempt`);
  }
  if (state.attempts.some((attempt) => attempt.state !== "settled"))
    problems.push("one or more delegated attempts are not settled");
  if (
    state.attempts.some(
      (attempt) =>
        attempt.cleanup?.state !== "completed" ||
        attempt.cleanup.workerClosed !== true,
    )
  )
    problems.push(
      "one or more delegated resources lack exact completed cleanup",
    );
  if (
    state.results.some(
      (result) =>
        result.validity !== "typed" || result.report.status !== "completed",
    )
  )
    problems.push(
      "one or more delegated worker results are not typed completed outcomes",
    );

  const implementationAttempts = state.attempts.filter((attempt) =>
    state.assignments.some(
      (assignment) =>
        assignment.id === attempt.assignmentId &&
        assignment.capability === "implement",
    ),
  );
  const implementationOrigin: "direct" | "delegated" =
    implementationAttempts.length > 0 ? "delegated" : "direct";
  if (
    implementationOrigin === "delegated" &&
    implementationAttempts.some(
      (attempt) => attempt.composition?.state !== "composed",
    )
  )
    problems.push("attributable maintained implementation is not composed");
  if (
    implementationOrigin === "direct" &&
    state.attempts.some((attempt) => attempt.composition)
  )
    problems.push("a non-implementation delegation has a composition");

  const experimentAssignments = state.assignments.filter(
    (assignment) => assignment.artifactIntent === "disposable_experiment",
  );
  let experiment: "verified" | "not-run" = "not-run";
  if (experimentAssignments.length > 0) {
    experiment = "verified";
    for (const assignment of experimentAssignments) {
      const attempt = state.attempts.find(
        (item) => item.assignmentId === assignment.id,
      );
      const result = state.results.find(
        (item) => item.assignmentId === assignment.id,
      );
      if (!attempt || !result || attempt.composition)
        problems.push(
          `experiment ${assignment.id} lacks attributable non-composed outcome`,
        );
      if (result?.validity === "typed") {
        for (const artifactId of assignment.artifactPolicy.retain) {
          if (
            !result.artifacts.some(
              (artifact) =>
                artifact.id === artifactId && artifact.retention === "retained",
            )
          )
            problems.push(
              `experiment ${assignment.id} did not retain declared artifact ${artifactId}`,
            );
        }
      }
    }
  }
  if (!directEffect.valid) problems.push(directEffect.detail);
  return {
    valid: problems.length === 0,
    detail:
      problems.length === 0
        ? "Delegated outcomes, composition, cleanup, and authorized bytes are attributable and valid."
        : problems.join("; "),
    delegationExercised: true,
    implementationOrigin,
    experiment,
  };
}

/** Observe the capability scenario at Pi's actual message boundary, not queued delivery state. */
export function notificationDrivenProgress(
  entries: SessionEntry[],
  resultIds: string[],
  baselineResultId: string,
): boolean {
  const notificationIndex = (resultId: string) =>
    entries.findIndex(
      (entry) =>
        entry.type === "custom_message" &&
        entry.customType === "pi-workgraph-workstream" &&
        entry.details !== null &&
        typeof entry.details === "object" &&
        "resultId" in entry.details &&
        entry.details.resultId === resultId,
    );
  const experimentIndex = entries.findIndex(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.content.some(
        (block) =>
          block.type === "toolCall" &&
          block.name === "workgraph_research" &&
          block.arguments.id === "uppercase-experiment",
      ),
  );
  const baselineIndex = notificationIndex(baselineResultId);
  // A later drained notification cannot repair a transition made by polling.
  if (
    experimentIndex >= 0 &&
    (baselineIndex < 0 || experimentIndex < baselineIndex)
  )
    throw new Error(
      "Experiment was queued before the actual baseline result notification; notification-driven progression was not observed.",
    );
  return (
    experimentIndex >= 0 &&
    resultIds.every((resultId) => {
      const index = notificationIndex(resultId);
      return (
        index >= 0 &&
        entries
          .slice(index + 1)
          .some(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "assistant" &&
              !["error", "aborted", "pending"].includes(
                entry.message.stopReason,
              ),
          )
      );
    })
  );
}
