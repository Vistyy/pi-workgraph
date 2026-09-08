import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  type HerdrObservation,
  HerdrProtocolError,
  herdrWorkerName,
  type WorkerLaunchEffectRequest,
  WorkerLaunchError,
  type WorkerRecoveryRequest,
} from "../src/herdr.js";
import {
  MODEL_PREFLIGHT_MARKER,
  NATIVE_SUBMISSION_MARKER,
  PROVIDER_AVAILABILITY_MARKER,
} from "../src/pi-process.js";
import type {
  EnrichmentPacket,
  WorkerIdentity,
  WorkerReport,
  WorkerResourceIdentity,
} from "../src/types.js";
import { required } from "./decoders.js";

export const FIXTURE_TIMESTAMP = 1_700_000_000_000;
const FIXTURE_OBSERVED_AT = "2023-11-14T22:13:20.000Z";

export const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
export const researchReport: WorkerReport = {
  kind: "research",
  status: "completed",
  summary: "Read fixture",
  evidence: [{ label: "file", observation: "value.txt says initial", class: "direct" }],
  findings: [],
};

type WorkerEnvironmentVariable =
  | "PI_WORKGRAPH_BASE_COMMIT"
  | "PI_WORKGRAPH_EXECUTOR_MODEL"
  | "PI_WORKGRAPH_EXPERIMENT"
  | "PI_WORKGRAPH_MODE";

export type FixtureLaunchRequest = Pick<
  WorkerLaunchEffectRequest,
  | "runId"
  | "nodeId"
  | "attemptId"
  | "assignmentId"
  | "objective"
  | "role"
  | "cwd"
  | "sessionFile"
  | "prompt"
  | "model"
  | "env"
>;

export function workerEnvironment(
  request: FixtureLaunchRequest,
  variable: WorkerEnvironmentVariable,
): string {
  return required(request.env[variable], `${variable} environment variable`);
}

function requestEnv(
  request: { env: Record<string, string> },
  variable: string,
): string | undefined {
  return request.env[variable];
}

function fixtureCheckpoint<E, R, A>(
  phase: WorkerLaunchError<E>["phase"],
  checkpoint: ((value: A) => Effect.Effect<void, E, R>) | undefined,
  value: A,
  locator: WorkerLaunchError<E>["locator"],
): Effect.Effect<void, WorkerLaunchError<E>, R> {
  if (checkpoint === undefined) return Effect.void;
  return checkpoint(value).pipe(
    Effect.mapError(
      (cause) =>
        new WorkerLaunchError({
          phase,
          locator,
          resource: "terminalId" in locator ? locator : undefined,
          cause,
        }),
    ),
  );
}

/** Controlled WorkerPort used by integration tests; it retains the production runtime seam. */
export class Worker {
  readonly requests: FixtureLaunchRequest[] = [];
  readonly identities = new Map<string, WorkerIdentity>();
  private readonly producers = new Map<string, () => Promise<void>>();
  promptCount = 0;
  interruptCount = 0;
  readonly cleanupIdentities: WorkerIdentity[] = [];
  readonly checkpointEvents: string[] = [];
  deferWork = false;
  absent = false;
  status: HerdrObservation["status"] = "idle";
  failBeforePane = false;
  failBeforeSubmission = false;
  readonly failBeforeSubmissionForModels = new Set<string>();
  readonly unavailableBeforeSubmissionForModels = new Set<string>();
  readonly settledUnavailableForModels = new Set<string>();
  readonly settledUnavailableSuccessfulModels = new Set<string>();
  readonly settledUnavailableSubmittedMarkerModels = new Set<string>();
  readonly settledUnavailableContradictoryMarkerModels = new Set<string>();
  readonly preflightStateForModels = new Map<
    string,
    "missing_model" | "missing_credentials" | "unsupported_thinking"
  >();
  failAfterSubmission = false;
  readonly failAfterSubmissionForModels = new Set<string>();
  readonly settledFailureForModels = new Map<string, "error" | "aborted">();
  enrichmentPacket: ((request: FixtureLaunchRequest) => EnrichmentPacket | undefined) | undefined;
  enrichmentTranscript: string | undefined;
  // oxlint-disable-next-line effecttsgo/async-function -- The controlled worker callback preserves the existing Promise-based RuntimeWorkerPort seam.
  onWork: (request: FixtureLaunchRequest) => Promise<WorkerReport | undefined> = async () =>
    researchReport;
  onInspect: () => void = () => {};

  private failsBeforeSubmission(request: WorkerLaunchEffectRequest<unknown, unknown>): boolean {
    return (
      this.failBeforeSubmission ||
      (request.model !== undefined && this.failBeforeSubmissionForModels.has(request.model))
    );
  }

  private isSettledUnavailable(request: WorkerLaunchEffectRequest<unknown, unknown>): boolean {
    return (
      requestEnv(request, "PI_WORKGRAPH_MODE") === "consultation" &&
      request.model !== undefined &&
      this.settledUnavailableForModels.has(request.model)
    );
  }

  private failsAfterSubmission(request: WorkerLaunchEffectRequest<unknown, unknown>): boolean {
    return (
      this.failAfterSubmission ||
      (request.model !== undefined && this.failAfterSubmissionForModels.has(request.model))
    );
  }

  private appendPreflight(request: WorkerLaunchEffectRequest<unknown, unknown>): void {
    if (requestEnv(request, "PI_WORKGRAPH_MODE") !== "consultation") return;
    const preflightState =
      request.model === undefined ? undefined : this.preflightStateForModels.get(request.model);
    SessionManager.open(request.sessionFile).appendCustomEntry(MODEL_PREFLIGHT_MARKER, {
      runId: request.runId,
      nodeId: request.nodeId,
      model: request.model ?? "fixture/unknown",
      thinking: requestEnv(request, "PI_WORKGRAPH_TARGET_THINKING") ?? "high",
      state: preflightState ?? "ready",
      detail:
        preflightState === undefined
          ? "Fixture model passed local preflight."
          : `Fixture preflight rejected ${request.model} with ${preflightState}.`,
    });
  }

  private appendSettledUnavailable(
    session: ReturnType<typeof SessionManager.open>,
    request: WorkerLaunchEffectRequest<unknown, unknown>,
  ): void {
    session.appendCustomEntry(PROVIDER_AVAILABILITY_MARKER, {
      runId: request.runId,
      nodeId: request.nodeId,
      model: request.model ?? "fixture/unknown",
      thinking: requestEnv(request, "PI_WORKGRAPH_TARGET_THINKING") ?? "high",
      availability: "unavailable",
      submission: "not_submitted",
      reason: `Fixture provider cannot use ${request.model ?? "the selected target"}.`,
    });
    session.appendMessage({
      role: "assistant",
      content: [],
      api: "test",
      provider: "test",
      model: "worker",
      usage,
      stopReason: "error",
      errorMessage: "Fixture provider bridge unavailable before remote submission.",
      timestamp: FIXTURE_TIMESTAMP,
    });
    if (this.settledUnavailableSuccessfulModels.has(request.model ?? ""))
      session.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Unexpected remote provider response" }],
        api: "test",
        provider: "test",
        model: "worker",
        usage,
        stopReason: "stop",
        timestamp: FIXTURE_TIMESTAMP,
      });
    if (this.settledUnavailableSubmittedMarkerModels.has(request.model ?? ""))
      session.appendCustomEntry(NATIVE_SUBMISSION_MARKER, {
        runId: request.runId,
        nodeId: request.nodeId,
        state: "submitted",
      });
    if (this.settledUnavailableContradictoryMarkerModels.has(request.model ?? "")) {
      session.appendCustomEntry(NATIVE_SUBMISSION_MARKER, {
        runId: request.runId,
        nodeId: request.nodeId,
        state: "not_submitted",
      });
      session.appendCustomEntry(NATIVE_SUBMISSION_MARKER, {
        runId: request.runId,
        nodeId: request.nodeId,
        state: "submitted",
      });
    }
  }

  private submittedCheckpoint<E, R>(
    request: WorkerLaunchEffectRequest<E, R>,
    resource: WorkerResourceIdentity,
  ): Effect.Effect<void, WorkerLaunchError<E>, R> {
    this.checkpointEvents.push("onSubmitted");
    const onSubmitted = request.onSubmitted;
    return fixtureCheckpoint(
      "onSubmitted",
      onSubmitted === undefined ? undefined : () => onSubmitted(),
      undefined,
      resource,
    );
  }

  private launchAfterPreflight<E, R>(
    request: WorkerLaunchEffectRequest<E, R>,
    resource: WorkerResourceIdentity,
  ) {
    return Effect.gen(
      function* (this: Worker) {
        const settledUnavailable = this.isSettledUnavailable(request);
        if (settledUnavailable) {
          // Pi records local prompt delivery before the provider performs its bridge check.
          yield* this.submittedCheckpoint(request, resource);
          yield* this.deferWork ? Effect.void : this.produceEffect(request.sessionFile);
        } else {
          yield* this.deferWork ? Effect.void : this.produceEffect(request.sessionFile);
          if (this.failsAfterSubmission(request))
            return yield* new HerdrProtocolError({
              operation: "launch fixture worker",
              reason: "process",
              detail: "fixture uncertain prompt receipt",
            });
          yield* this.submittedCheckpoint(request, resource);
        }
      }.bind(this),
    );
  }

  readonly launch = <E, R>(request: WorkerLaunchEffectRequest<E, R>) =>
    Effect.gen(
      function* (this: Worker) {
        const index = this.requests.length + 1;
        this.requests.push(request);
        const identity: WorkerIdentity = {
          workspaceId: request.workspaceId,
          tabId: `w1:t${index}`,
          paneId: `w1:p${index}`,
          terminalId: `term${index}`,
          agentName: herdrWorkerName(request),
          sessionFile: request.sessionFile,
          cwd: request.cwd,
        };
        const resource = {
          workspaceId: identity.workspaceId,
          tabId: identity.tabId,
          paneId: identity.paneId,
          terminalId: identity.terminalId,
          agentName: identity.agentName,
          cwd: identity.cwd,
        };
        this.producers.set(request.sessionFile, () => this.produce(request));
        if (this.failBeforePane)
          return yield* new HerdrProtocolError({
            operation: "launch fixture worker",
            reason: "process",
            detail: "fixture tab creation response interrupted",
          });
        const pane = { workspaceId: identity.workspaceId, paneId: identity.paneId };
        this.checkpointEvents.push("onTab");
        yield* fixtureCheckpoint("onTab", request.onTab, pane, pane);
        this.identities.set(identity.agentName, identity);
        this.checkpointEvents.push("onResource");
        yield* fixtureCheckpoint("onResource", request.onResource, resource, resource);
        if (this.failsBeforeSubmission(request)) {
          if (
            request.model !== undefined &&
            this.unavailableBeforeSubmissionForModels.has(request.model)
          )
            this.markConsultationUnavailable(request);
          else this.markConsultationNotSubmitted(request);
          return yield* new HerdrProtocolError({
            operation: "launch fixture worker",
            reason: "process",
            detail: "fixture readiness interruption",
          });
        }
        this.checkpointEvents.push("onIdentity");
        yield* fixtureCheckpoint("onIdentity", request.onIdentity, identity, identity);
        // The real worker writes this generation-scoped marker at session start;
        // the fixture writes the equivalent ready evidence before the launch preflight.
        this.appendPreflight(request);
        this.checkpointEvents.push("onPreflight");
        yield* fixtureCheckpoint("onPreflight", request.onPreflight, undefined, resource);
        yield* this.launchAfterPreflight(request, resource);
        return { identity, status: "working" as const, observedAt: FIXTURE_OBSERVED_AT };
      }.bind(this),
    );

  readonly recover = (request: WorkerRecoveryRequest) => {
    const identity = [...this.identities.values()].find(
      (item) => item.agentName === request.agentName,
    );
    return identity === undefined ? Effect.as(Effect.void, undefined) : this.observe(identity);
  };

  readonly inspectLaunch = () =>
    Effect.fail(
      new HerdrProtocolError({
        operation: "inspect fixture launch",
        reason: "process",
        detail: "No launch inspection.",
      }),
    );

  readonly inspect = (identity: WorkerIdentity) =>
    Effect.sync(() => {
      this.onInspect();
      return this.absent
        ? {
            identity,
            status: "absent" as const,
            observedAt: FIXTURE_OBSERVED_AT,
            detail: "Exact fixture worker is absent.",
          }
        : this.observation(identity);
    });

  readonly observe = (identity: WorkerIdentity) =>
    this.absent
      ? Effect.fail(
          new HerdrProtocolError({
            operation: "observe fixture worker",
            reason: "process",
            detail: "Exact fixture worker is absent.",
          }),
        )
      : Effect.succeed(this.observation(identity));

  readonly interrupt = (identity: WorkerIdentity) =>
    Effect.sync(() => {
      this.interruptCount++;
      return this.observation(identity);
    });

  readonly steer = (identity: WorkerIdentity) => {
    const produce = this.producers.get(identity.sessionFile);
    if (produce === undefined)
      return Effect.fail(
        new HerdrProtocolError({
          operation: "steer fixture worker",
          reason: "process",
          detail: "No fixture worker request exists for the identity.",
        }),
      );
    return this.produceEffect(identity.sessionFile);
  };

  readonly cleanup = (identity: WorkerIdentity) =>
    Effect.sync(() => {
      this.cleanupIdentities.push(identity);
      if (this.status === "working")
        return {
          state: "pending" as const,
          identity,
          observedAt: FIXTURE_OBSERVED_AT,
          detail: "Fixture worker is still working.",
        };
      if (this.status === "blocked" || this.status === "unknown")
        return {
          state: "blocked" as const,
          identity,
          observedAt: FIXTURE_OBSERVED_AT,
          detail: `Fixture worker is ${this.status}.`,
        };
      return {
        state: "completed" as const,
        identity,
        observedAt: FIXTURE_OBSERVED_AT,
        detail: this.absent ? "Exact fixture worker is absent." : "Exact fixture worker closed.",
      };
    });

  private markConsultationNotSubmitted(request: FixtureLaunchRequest): void {
    if (requestEnv(request, "PI_WORKGRAPH_MODE") !== "consultation") return;
    SessionManager.open(request.sessionFile).appendCustomEntry("pi-workgraph-native-submission", {
      runId: request.runId,
      nodeId: request.nodeId,
      state: "not_submitted",
    });
  }

  private markConsultationUnavailable(request: FixtureLaunchRequest): void {
    if (requestEnv(request, "PI_WORKGRAPH_MODE") !== "consultation") return;
    const model = request.model;
    if (model === undefined) return;
    SessionManager.open(request.sessionFile).appendCustomEntry(PROVIDER_AVAILABILITY_MARKER, {
      runId: request.runId,
      nodeId: request.nodeId,
      model,
      thinking: requestEnv(request, "PI_WORKGRAPH_TARGET_THINKING") ?? "high",
      availability: "unavailable",
      submission: "not_submitted",
      reason: `Fixture provider cannot use ${model}.`,
    });
  }

  produceEffect(sessionFile: string): Effect.Effect<void, HerdrProtocolError> {
    const produce = this.producers.get(sessionFile);
    if (produce === undefined)
      return Effect.fail(
        new HerdrProtocolError({
          operation: "produce fixture worker",
          reason: "process",
          detail: "No fixture worker request exists for the identity.",
        }),
      );
    return Effect.tryPromise({
      try: produce,
      catch: (cause) =>
        new HerdrProtocolError({
          operation: "produce fixture worker",
          reason: "process",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
  }

  // oxlint-disable-next-line effecttsgo/async-function -- The controlled worker writes real persisted Pi session messages at the native worker seam.
  private async produce<E, R>(request: WorkerLaunchEffectRequest<E, R>): Promise<void> {
    this.promptCount++;
    const session = SessionManager.open(request.sessionFile);
    const settledUnavailable = this.isSettledUnavailable(request);
    if (!settledUnavailable)
      session.appendCustomEntry("pi-workgraph-agent-running", {
        runId: request.runId,
        nodeId: request.nodeId,
      });
    const report = await this.onWork(request);
    if (requestEnv(request, "PI_WORKGRAPH_MODE") === "consultation_enricher") {
      if (this.enrichmentTranscript !== undefined)
        session.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: this.enrichmentTranscript }],
          api: "test",
          provider: "test",
          model: "enricher",
          usage,
          stopReason: "stop",
          timestamp: FIXTURE_TIMESTAMP,
        });
      const packet = this.enrichmentPacket?.(request);
      if (packet !== undefined)
        session.appendCustomEntry("pi-workgraph-enrichment", {
          runId: request.runId,
          nodeId: request.nodeId,
          packet,
        });
    }
    // The provider checks its bridge after Pi records local prompt delivery. Its
    // unavailable marker plus error must still prove that no remote request occurred.
    const settledFailure =
      request.model === undefined ? undefined : this.settledFailureForModels.get(request.model);
    if (settledUnavailable) this.appendSettledUnavailable(session, request);
    else if (settledFailure !== undefined)
      session.appendMessage({
        role: "assistant",
        content: [],
        api: "test",
        provider: "test",
        model: "worker",
        usage,
        stopReason: settledFailure,
        errorMessage: `Fixture settled with ${settledFailure}.`,
        timestamp: FIXTURE_TIMESTAMP,
      });
    else
      session.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Actual fixture worker evidence" }],
        api: "test",
        provider: "test",
        model: "worker",
        usage,
        stopReason: "stop",
        timestamp: FIXTURE_TIMESTAMP,
      });
    if (report !== undefined && requestEnv(request, "PI_WORKGRAPH_MODE") !== "consultation")
      session.appendMessage({
        role: "toolResult",
        toolCallId: "report",
        toolName: "workgraph_report",
        content: [{ type: "text", text: "report" }],
        details: { report },
        isError: false,
        timestamp: FIXTURE_TIMESTAMP,
      });
    session.appendCustomEntry("pi-workgraph-agent-settled", {
      runId: request.runId,
      nodeId: request.nodeId,
    });
  }

  private observation(identity: WorkerIdentity): HerdrObservation {
    return { identity, status: this.status, observedAt: FIXTURE_OBSERVED_AT };
  }
}
