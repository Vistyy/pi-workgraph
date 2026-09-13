/* oxlint-disable effecttsgo/process-env -- This concrete host adapter snapshots the Herdr process environment at construction. */
import { DateTime, Effect, Schedule } from "effect";
import {
  decodeAgentResponse,
  decodeSnapshotResponse,
  decodeSuccessResponse,
  decodeTabCreateResponse,
  decodeWorkspaceCreateResponse,
  type HerdrAgentStatus,
} from "./herdr-decoder.js";
import {
  assertCoordinatorPlacement,
  assertIdentity,
  assertWorkerLaunchPlacement,
  identityOf,
  parseAgent,
  resourceOf,
  type WorkerIdentity,
  type WorkerResourceIdentity,
} from "./herdr-identity.js";
import {
  herdrCoordinatorNames,
  herdrWorkerName,
  herdrWorkerTabLabel,
  type WorkerRole,
} from "./herdr-naming.js";
import {
  HerdrCommandTransport,
  HerdrProtocolError,
  isNotFound,
  protocolCommandError,
  protocolDecode,
  protocolTry,
} from "./herdr-protocol.js";

export interface HerdrLaunchRequest {
  readonly workspaceId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly assignmentId?: string;
  readonly objective?: string;
  readonly role?: WorkerRole;
  readonly cwd: string;
  readonly sessionFile: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly env: Record<string, string>;
}
interface HerdrObservation {
  readonly identity: WorkerIdentity;
  readonly status: HerdrAgentStatus;
  readonly observedAt: string;
}
export type HerdrInspection =
  | HerdrObservation
  | { readonly identity: WorkerIdentity; readonly status: "absent"; readonly observedAt: string };

/** One strict Herdr resource owner: launch, inspect, prompt, and close exact identities. */
export class HerdrCliRuntime {
  readonly available: boolean;
  private readonly transport: HerdrCommandTransport;
  private readonly environment: Record<string, string>;

  constructor(
    command = process.env["PI_WORKGRAPH_HERDR_BIN"] ?? "herdr",
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.available = env["HERDR_ENV"] === "1" && env["HERDR_WORKSPACE_ID"] !== undefined;
    this.transport = new HerdrCommandTransport(command);
    this.environment =
      env["PI_CODING_AGENT_DIR"] === undefined
        ? {}
        : { PI_CODING_AGENT_DIR: env["PI_CODING_AGENT_DIR"] };
  }

  launch(request: HerdrLaunchRequest): Effect.Effect<HerdrObservation, HerdrProtocolError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        yield* this.requireAvailable();
        const agentName = herdrWorkerName(request);
        const paneId = yield* this.transport.call(
          [
            "tab",
            "create",
            "--workspace",
            request.workspaceId,
            "--cwd",
            request.cwd,
            "--label",
            herdrWorkerTabLabel(request),
            "--no-focus",
            ...envArgs(request.env),
          ],
          decodeTabCreateResponse,
        );
        const args = [
          "agent",
          "start",
          agentName,
          "--kind",
          "pi",
          "--pane",
          paneId,
          "--",
          "--session",
          request.sessionFile,
        ];
        if (request.model !== undefined) args.push("--model", request.model);
        if (request.thinking !== undefined) args.push("--thinking", request.thinking);
        const started = yield* this.transport
          .call(args, decodeAgentResponse, 45_000)
          .pipe(Effect.flatMap((decoded) => protocolTry(args, () => parseAgent(decoded))));
        yield* protocolTry(args, () =>
          assertWorkerLaunchPlacement(
            { workspaceId: request.workspaceId, paneId, agentName, cwd: request.cwd },
            started,
          ),
        );
        const resource = resourceOf(started);
        const identity = yield* this.awaitIdentity(resource, request.sessionFile);
        const observation = yield* this.inspect(identity);
        if (observation.status === "absent")
          return yield* new HerdrProtocolError({
            operation: "agent start",
            reason: "identity",
            detail: "Launched Worker disappeared before exact observation.",
          });
        return observation;
      }.bind(this),
    );
  }

  launchCoordinator(request: {
    cwd: string;
    sessionFile: string;
  }): Effect.Effect<WorkerIdentity, HerdrProtocolError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        yield* this.requireAvailable();
        const names = herdrCoordinatorNames(request);
        const workspace = yield* this.transport.call(
          [
            "workspace",
            "create",
            "--cwd",
            request.cwd,
            "--label",
            names.label,
            "--no-focus",
            ...envArgs(this.environment),
          ],
          decodeWorkspaceCreateResponse,
        );
        const args = [
          "agent",
          "start",
          names.agentName,
          "--kind",
          "pi",
          "--pane",
          workspace.paneId,
          "--",
          "--session",
          request.sessionFile,
        ];
        const started = yield* this.transport
          .call(args, decodeAgentResponse, 45_000)
          .pipe(Effect.flatMap((decoded) => protocolTry(args, () => parseAgent(decoded))));
        yield* protocolTry(args, () =>
          assertCoordinatorPlacement(
            {
              workspaceId: workspace.workspaceId,
              tabId: workspace.tabId,
              paneId: workspace.paneId,
              agentName: names.agentName,
              sessionFile: request.sessionFile,
              cwd: request.cwd,
            },
            started,
          ),
        );
        return yield* this.awaitIdentity(resourceOf(started), request.sessionFile);
      }.bind(this),
    );
  }

  inspect(identity: WorkerIdentity): Effect.Effect<HerdrInspection, HerdrProtocolError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        const args = ["agent", "get", identity.paneId];
        const result = yield* this.transport.spawn(args, 30_000);
        if (result.code !== 0) {
          if (
            (isNotFound(result, "agent_not_found") || isNotFound(result, "pane_not_found")) &&
            (yield* this.tabAbsent(identity.tabId))
          )
            return { identity, status: "absent" as const, observedAt: now() };
          return yield* protocolCommandError(args, result);
        }
        const decoded = yield* protocolDecode(result, args, decodeAgentResponse);
        const current = yield* protocolTry(args, () => parseAgent(decoded));
        yield* protocolTry(args, () => assertIdentity(identity, current));
        return { identity, status: current.status, observedAt: now() };
      }.bind(this),
    );
  }

  prompt(identity: WorkerIdentity, text: string): Effect.Effect<void, HerdrProtocolError> {
    if (text.trim().length === 0)
      return Effect.fail(
        new HerdrProtocolError({
          operation: "agent prompt",
          reason: "identity",
          detail: "Worker prompt cannot be blank.",
        }),
      );
    return this.inspect(identity).pipe(
      Effect.filterOrFail(
        (value) =>
          value.status !== "absent" && value.status !== "blocked" && value.status !== "unknown",
        () =>
          new HerdrProtocolError({
            operation: "agent prompt",
            reason: "identity",
            detail: "Exact Worker cannot receive a prompt.",
          }),
      ),
      Effect.andThen(
        this.transport.call(
          ["agent", "prompt", identity.agentName, text.trim()],
          decodeSuccessResponse,
          15_000,
        ),
      ),
    );
  }

  close(
    identity: WorkerIdentity,
  ): Effect.Effect<"absent" | "present" | "unknown", HerdrProtocolError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        const before = yield* this.inspect(identity);
        if (before.status === "absent") return "absent" as const;
        yield* Effect.result(
          this.transport.call(["tab", "close", identity.tabId], decodeSuccessResponse),
        );
        const after = yield* Effect.result(this.inspect(identity));
        if (after._tag === "Failure") return "unknown" as const;
        return after.success.status === "absent" ? ("absent" as const) : ("present" as const);
      }.bind(this),
    );
  }

  coordinatorAbsent(identity: {
    sessionFile: string;
    tabId: string;
  }): Effect.Effect<boolean, HerdrProtocolError> {
    if (!this.available) return Effect.succeed(false);
    return this.transport
      .call(["api", "snapshot"], decodeSnapshotResponse)
      .pipe(
        Effect.map((agents) =>
          agents.every(
            (agent) =>
              agent.tab_id !== identity.tabId &&
              agent.agent_session?.value !== identity.sessionFile,
          ),
        ),
      );
  }

  private awaitIdentity(
    resource: WorkerResourceIdentity,
    sessionFile: string,
  ): Effect.Effect<WorkerIdentity, HerdrProtocolError> {
    const poll: Effect.Effect<WorkerIdentity, HerdrProtocolError> = Effect.gen(
      function* (this: HerdrCliRuntime) {
        const decoded = yield* this.transport.call(
          ["agent", "get", resource.paneId],
          decodeAgentResponse,
        );
        const actual = yield* protocolTry(["agent", "get"], () => parseAgent(decoded));
        if (actual.sessionFile === undefined)
          return yield* new HerdrProtocolError({
            operation: "agent get",
            reason: "identity",
            detail: "Exact native Pi session identity is not available yet.",
          });
        return yield* protocolTry(["agent", "get"], () => {
          if (actual.sessionFile !== sessionFile)
            throw new Error("Native Pi session identity does not match the requested session.");
          return identityOf(resource, actual);
        });
      }.bind(this),
    );
    return poll.pipe(
      Effect.retry({
        schedule: Schedule.spaced("250 millis"),
        times: 60,
        while: (error) => error.reason === "identity",
      }),
      Effect.timeoutOrElse({
        duration: 15_000,
        orElse: () =>
          Effect.fail(
            new HerdrProtocolError({
              operation: "agent get",
              reason: "identity",
              detail: "Exact native Pi session identity was not observed before timeout.",
            }),
          ),
      }),
    );
  }

  private tabAbsent(tabId: string): Effect.Effect<boolean, HerdrProtocolError> {
    return this.transport
      .spawn(["tab", "get", tabId], 30_000)
      .pipe(
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(false)
            : isNotFound(result, "tab_not_found")
              ? Effect.succeed(true)
              : Effect.fail(protocolCommandError(["tab", "get", tabId], result)),
        ),
      );
  }
  private requireAvailable(): Effect.Effect<void, HerdrProtocolError> {
    return this.available
      ? Effect.void
      : Effect.fail(
          new HerdrProtocolError({
            operation: "availability",
            reason: "unavailable",
            detail: "Herdr runtime is unavailable.",
          }),
        );
  }
}

function envArgs(environment: Record<string, string>): string[] {
  return Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}
function now(): string {
  return DateTime.formatIso(DateTime.nowUnsafe());
}
