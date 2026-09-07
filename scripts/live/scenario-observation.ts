import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { WorkstreamState } from "../../src/workstream.js";

const TextSchema = Type.String();
const TextBlockSchema = Type.Object({ type: Type.Literal("text"), text: Type.String() });
const ResultNotificationSchema = Type.Object({ resultId: Type.String() });
const ResearchArgumentsSchema = Type.Object({ id: Type.String() });

export const CAPABILITY_SCENARIO_IDS = {
  baselineResearch: "baseline-research",
  uppercaseExperiment: "uppercase-experiment",
  updateValue: "initial-candidate",
  concurrentReadme: "concurrent-readme",
  correctionCandidate: "candidate-correction",
  exactRevisionReview: "pre-apply-review",
  integrationCandidate: "moved-integration",
} as const;

/** The model-driven scenario keeps candidate application, correction, and drift refusal explicit. */
export function capabilityScenarioPrompt(privateToken: string): string {
  return `Use Workgraph capability tools to exercise this single bounded retained-candidate scenario without another approval ceremony.
Coordinator-only context: ${privateToken}. Never include that token in worker assignments.
First delegate read-only research id ${CAPABILITY_SCENARIO_IDS.baselineResearch} to gather cheap evidence about the README marker and exact current value.txt bytes, then use the returned findings to decide what bounded work is justified. End your turn when only workers are running and resume on actual results.
Next delegate disposable experiment id ${CAPABILITY_SCENARIO_IDS.uppercaseExperiment}, explicitly authorized to read value.txt and write only probe.txt containing its uppercase bytes. Stop after one observation and retain probe.txt; never apply scratch code.
Then delegate maintained implementation id ${CAPABILITY_SCENARIO_IDS.updateValue}, explicitly authorized to create candidate.txt containing exactly candidate followed by one newline and change no other fixture file. Use policy guide/executor defaults, report the exact candidate commit, and keep it unapplied and retained.
Immediately after queueing the initial candidate, before waiting for its result, queue read-only research id ${CAPABILITY_SCENARIO_IDS.concurrentReadme} to read the README marker, demonstrating interleaving.
After the initial candidate result settles, use its exact retained attempt handle as candidateOf to delegate maintained correction id ${CAPABILITY_SCENARIO_IDS.correctionCandidate}. The correction is authorized to continue the candidate directly, preserve candidate.txt, and change only value.txt to exactly after followed by one newline; report one clean direct correction commit and do not apply it yet.
Before any application, delegate independent exact-revision review id ${CAPABILITY_SCENARIO_IDS.exactRevisionReview} for the correction's exact reported commit. The review must inspect its isolated review cwd at that SHA, verify candidate.txt and value.txt bytes, and report its actual cwd/revision; do not apply from a notification alone.
After that review settles, explicitly apply the correction with workgraph_control action apply, its exact correction attempt and sourceCommit, and the freshly observed destinationHead. The destination must still be the original fixture base at this point; this is the complete-chain application and must retain both initial and correction commits rather than squashing.
Next deliberately test drift refusal: after the correction application, wait until the fixture-owned disposable drift commit is visible as drift.txt containing exactly DRIFT followed by a newline. Do not create or modify drift.txt yourself. Then explicitly try to apply the retained initial candidate attempt with its exact initial sourceCommit and freshly observed drift destinationHead; this must be refused and retained as a blocked application without changing destination bytes.
After observing that refusal, delegate maintained integration id ${CAPABILITY_SCENARIO_IDS.integrationCandidate} with candidateOf set to the retained initial candidate attempt and baseRevision set to the exact moved destination HEAD. In that isolated integration, preserve candidate.txt and value.txt=after followed by a newline, create integration.txt containing exactly INTEGRATED followed by a newline, and report one new current-base commit. Explicitly apply that integration with its exact sourceCommit and freshly observed destinationHead.
You may run read-only verification yourself but do not edit the fixture directly, and do not delegate extra workers or change model policy. The fixture harness alone creates the one explicitly authorized disposable destination drift commit.
Handle result notifications automatically and inspect execution, findings, evidence, uncertainty, and cleanup through workgraph_inspect only when a blocker, repeated attempt, uncertainty, or truncation requires it. After queueing useful independent work, end your turn to receive notifications; do not poll, run waits for workers, or wait inside shell commands.
Verify before the correction application that the destination HEAD is unchanged at the fixture base, verify its application retains the complete initial-to-correction history, verify the separate initial-candidate drift refusal leaves the moved destination unchanged, verify the moved integration applies one current-base commit, retain probe.txt, and confirm all workers settle and every non-retained output is cleaned. Leave the workstream active because the intentionally blocked drift-refusal evidence must remain inspectable; do not claim semantic completion while that blocker is retained. Report a blocker instead of claiming success if any required boundary is unavailable.`;
}

export type CoordinatorTurnObservation =
  | { state: "waiting"; detail: string }
  | { state: "settled"; detail: string; assistantIndex: number }
  | { state: "failed"; detail: string; assistantIndex?: number }
  | { state: "blocked"; detail: string; assistantIndex?: number };

function messageText(entry: SessionEntry): string {
  if (entry.type !== "message" || !("content" in entry.message)) return "";
  const content = entry.message.content;
  if (Value.Check(TextSchema, content)) return Value.Decode(TextSchema, content);
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => Value.Check(TextBlockSchema, block))
    .map((block) => Value.Decode(TextBlockSchema, block).text)
    .join("\n");
}

function classifyAssistantTurn(
  entry: SessionEntry,
  assistantIndex: number,
): CoordinatorTurnObservation | undefined {
  if (
    entry.type !== "message" ||
    entry.message.role !== "assistant" ||
    !("stopReason" in entry.message)
  )
    return undefined;
  const reason = entry.message.stopReason;
  const text = messageText(entry) || "no diagnostic text";
  if (reason === "error" || reason === "aborted")
    return {
      state: "failed",
      detail: `Native coordinator turn ended with ${reason}: ${text}`,
      assistantIndex,
    };
  if (reason === "length")
    return {
      state: "failed",
      detail: `Native coordinator turn ended incomplete (${reason}): ${text}`,
      assistantIndex,
    };
  if (reason !== "stop") return undefined;
  if (
    /(?:cannot|can't|unable|refus(?:e|ed|al)|blocked)\s+(?:complete|continue|proceed|the request)/i.test(
      text,
    )
  )
    return {
      state: "blocked",
      detail: `Native coordinator reported a blocker: ${text}`,
      assistantIndex,
    };
  return {
    state: "settled",
    detail: messageText(entry) || "Native coordinator turn settled without text.",
    assistantIndex,
  };
}

/** Observe the native Pi turn after the submitted human request. */
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
    return { state: "waiting", detail: "Submitted request is not in the native session yet." };
  const observations = entries
    .slice(requestIndex + 1)
    .map((entry, offset) => classifyAssistantTurn(entry, requestIndex + offset + 1))
    .filter((item) => item !== undefined);
  const interruption = observations.find(
    (item) => item.state === "failed" || item.state === "blocked",
  );
  if (interruption !== undefined) return interruption;
  return (
    observations.findLast((item) => item.state === "settled") ?? {
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

export interface IsolatedGitPlacement {
  path: string;
  branch: string;
}

export function observeIsolatedGitResourceAbsence(
  placements: IsolatedGitPlacement[],
  worktreePorcelain: string,
  branchRefLines: string,
) {
  const worktreePaths = worktreePorcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  const branchRefs = new Set(branchRefLines.split("\n").filter(Boolean));
  const resources = placements.map((placement) => ({
    path: placement.path,
    branch: placement.branch,
    worktreeAbsent: !worktreePaths.includes(placement.path),
    branchAbsent: !branchRefs.has(`refs/heads/${placement.branch}`),
  }));
  return {
    valid: resources.every((resource) => resource.worktreeAbsent && resource.branchAbsent),
    resources,
  };
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

function validateAssignmentAttribution(state: WorkstreamState): string[] {
  const problems: string[] = [];
  const assignmentsById = new Map(
    state.assignments.map((assignment) => [assignment.id, assignment]),
  );
  if (assignmentsById.size !== state.assignments.length)
    problems.push("delegated assignments are not uniquely attributable");
  for (const assignment of state.assignments) {
    if (!state.attempts.some((attempt) => attempt.assignmentId === assignment.id))
      problems.push(`delegated assignment ${assignment.id} has no attempt`);
  }
  for (const attempt of state.attempts) {
    const assignment = assignmentsById.get(attempt.assignmentId);
    if (assignment === undefined) {
      problems.push(`attempt ${attempt.id} has no delegated assignment`);
      continue;
    }
    if (attempt.worker === undefined) problems.push(`attempt ${attempt.id} has no worker identity`);
    else if (
      attempt.sessionFile === undefined ||
      attempt.worker.sessionFile !== attempt.sessionFile
    )
      problems.push(`attempt ${attempt.id} worker session is not attributable`);
    else if (attempt.placement !== undefined && attempt.worker.cwd !== attempt.placement.path)
      problems.push(`attempt ${attempt.id} worker cwd is not attributable`);
  }
  return problems;
}

function validateResultAttribution(state: WorkstreamState): string[] {
  const problems: string[] = [];
  const resultOwners = new Set<string>();
  for (const attempt of state.attempts) {
    if (attempt.resultId === undefined) {
      problems.push(`attempt ${attempt.id} has no retained result`);
      continue;
    }
    if (resultOwners.has(attempt.resultId))
      problems.push(`result ${attempt.resultId} has multiple attempt owners`);
    resultOwners.add(attempt.resultId);
    const result = state.results.find((item) => item.id === attempt.resultId);
    const assignment = state.assignments.find((item) => item.id === attempt.assignmentId);
    if (result === undefined) problems.push(`attempt ${attempt.id} retained result is missing`);
    else if (result.assignmentId !== attempt.assignmentId)
      problems.push(`attempt ${attempt.id} result assignment is mismatched`);
    else if (
      assignment !== undefined &&
      result.assignmentIntentVersion !== assignment.intentVersion
    )
      problems.push(`attempt ${attempt.id} result intent is mismatched`);
  }
  for (const result of state.results) {
    if (
      !state.attempts.some(
        (attempt) => attempt.resultId === result.id && attempt.assignmentId === result.assignmentId,
      )
    )
      problems.push(`result ${result.id} has no attributable attempt`);
  }
  return problems;
}

function validateSettlements(state: WorkstreamState): string[] {
  const problems: string[] = [];
  if (state.lifecycle.state !== "completed")
    problems.push(`workstream lifecycle is ${state.lifecycle.state}`);
  if (state.attempts.length === 0) problems.push("no delegated attempts are attributable");
  if (state.attempts.some((attempt) => attempt.state !== "settled"))
    problems.push("one or more delegated attempts are not settled");
  if (
    state.attempts.some(
      (attempt) => attempt.cleanup?.state !== "completed" || attempt.cleanup.workerClosed !== true,
    )
  )
    problems.push("one or more delegated resources lack exact completed cleanup");
  if (
    state.results.some(
      (result) => result.validity !== "typed" || result.report.status !== "completed",
    )
  )
    problems.push("one or more delegated worker results are not typed completed outcomes");
  return problems;
}

function validateImplementation(state: WorkstreamState) {
  const attempts = state.attempts.filter((attempt) =>
    state.assignments.some(
      (assignment) =>
        assignment.id === attempt.assignmentId && assignment.capability === "implement",
    ),
  );
  const origin: "delegated" | "direct" = attempts.length > 0 ? "delegated" : "direct";
  const problems: string[] = [];
  if (
    origin === "delegated" &&
    attempts.some((attempt) => attempt.application?.state !== "applied")
  )
    problems.push("attributable maintained implementation is not applied");
  if (origin === "direct" && state.attempts.some((attempt) => attempt.application !== undefined))
    problems.push("a non-implementation delegation has an application");
  return { problems, origin };
}

function validateExperiments(state: WorkstreamState) {
  const assignments = state.assignments.filter(
    (assignment) => assignment.artifactIntent === "disposable_experiment",
  );
  const problems: string[] = [];
  for (const assignment of assignments) {
    const attempt = state.attempts.find((item) => item.assignmentId === assignment.id);
    const result = state.results.find((item) => item.assignmentId === assignment.id);
    if (attempt === undefined || result === undefined || attempt.application !== undefined)
      problems.push(`experiment ${assignment.id} lacks attributable non-applied outcome`);
    if (result?.validity !== "typed") continue;
    if (
      attempt?.placement?.kind !== "isolated_worktree" ||
      !result.artifacts.some(
        (artifact) =>
          artifact.id === "retained-output-worktree" &&
          artifact.kind === "path" &&
          artifact.reference === attempt.placement?.path &&
          artifact.retention === "retained",
      )
    )
      problems.push(`experiment ${assignment.id} did not retain its isolated worktree`);
  }
  const experiment: "verified" | "not-run" = assignments.length > 0 ? "verified" : "not-run";
  return { problems, experiment };
}

/** Validate state-level attribution and cleanup guarantees of a delegated natural strategy. */
export function observeDelegatedOutcome(
  state: WorkstreamState,
  directEffect: DirectEffectObservation,
): DelegatedEffectObservation {
  const implementation = validateImplementation(state);
  const experiments = validateExperiments(state);
  const problems = [
    ...validateAssignmentAttribution(state),
    ...validateResultAttribution(state),
    ...validateSettlements(state),
    ...implementation.problems,
    ...experiments.problems,
  ];
  if (!directEffect.valid) problems.push(directEffect.detail);
  return {
    valid: problems.length === 0,
    detail:
      problems.length === 0
        ? "Delegated outcomes, application, cleanup, and authorized bytes are attributable and valid."
        : problems.join("; "),
    delegationExercised: true,
    implementationOrigin: implementation.origin,
    experiment: experiments.experiment,
  };
}

/** Observe capability progress at Pi's actual message boundary, not queued delivery state. */
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
        Value.Check(ResultNotificationSchema, entry.details) &&
        Value.Decode(ResultNotificationSchema, entry.details).resultId === resultId,
    );
  const experimentIndex = entries.findIndex(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.content.some(
        (block) =>
          block.type === "toolCall" &&
          block.name === "workgraph_research" &&
          Value.Check(ResearchArgumentsSchema, block.arguments) &&
          Value.Decode(ResearchArgumentsSchema, block.arguments).id ===
            CAPABILITY_SCENARIO_IDS.uppercaseExperiment,
      ),
  );
  const baselineIndex = notificationIndex(baselineResultId);
  if (experimentIndex >= 0 && (baselineIndex < 0 || experimentIndex < baselineIndex))
    throw new Error(
      "Experiment was queued before the actual baseline result notification; notification-driven progression was not observed.",
    );
  return (
    experimentIndex >= 0 &&
    resultIds.every((resultId) => {
      const index = notificationIndex(resultId);
      return index >= 0 && entries.slice(index + 1).some(isActualAssistantContinuation);
    })
  );
}

function isActualAssistantContinuation(entry: SessionEntry): boolean {
  return (
    entry.type === "message" &&
    entry.message.role === "assistant" &&
    !["error", "aborted", "pending"].includes(entry.message.stopReason)
  );
}
