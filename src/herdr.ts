/* oxlint-disable effecttsgo/process-env -- This concrete host adapter snapshots the Herdr process environment at construction. */
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import { Data, DateTime, Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import {
  herdrCoordinatorNames,
  herdrWorkerName,
  herdrWorkerTabLabel,
  type WorkerRole,
} from "./herdr-naming.js";
import { liveLayer } from "./node-platform.js";

const NonBlank = Type.String({ minLength: 1 });
const AgentStatusSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("working"),
  Type.Literal("blocked"),
  Type.Literal("done"),
  Type.Literal("unknown"),
]);
const AgentSessionSchema = Type.Object({ value: NonBlank });
const AgentSchema = Type.Object({
  workspace_id: NonBlank,
  tab_id: NonBlank,
  pane_id: NonBlank,
  terminal_id: NonBlank,
  agent_status: AgentStatusSchema,
  cwd: NonBlank,
  name: Type.Optional(NonBlank),
  agent_session: AgentSessionSchema,
});
const StartedAgentSchema = Type.Object({
  workspace_id: NonBlank,
  tab_id: NonBlank,
  pane_id: NonBlank,
  terminal_id: NonBlank,
  agent_status: AgentStatusSchema,
  cwd: NonBlank,
  name: NonBlank,
  agent_session: AgentSessionSchema,
  interactive_ready: Type.Literal(true),
});
const AgentResponseSchema = Type.Object({
  result: Type.Object({ type: Type.Optional(Type.String()), agent: AgentSchema }),
});
const AgentStartResponseSchema = Type.Object({
  result: Type.Object({ type: Type.Optional(Type.String()), agent: StartedAgentSchema }),
});
const ListedAgentSchema = Type.Object({
  workspace_id: NonBlank,
  tab_id: NonBlank,
  pane_id: NonBlank,
  terminal_id: NonBlank,
  agent_status: AgentStatusSchema,
  cwd: NonBlank,
  name: Type.Optional(NonBlank),
  agent_session: Type.Optional(AgentSessionSchema),
});
const AgentListResponseSchema = Type.Object({
  result: Type.Object({
    type: Type.Optional(Type.String()),
    agents: Type.Array(ListedAgentSchema),
  }),
});
const TabListResponseSchema = Type.Object({
  result: Type.Object({
    type: Type.Optional(Type.String()),
    tabs: Type.Array(
      Type.Object({
        tab_id: NonBlank,
        workspace_id: NonBlank,
        label: Type.Optional(NonBlank),
      }),
    ),
  }),
});
const PaneListResponseSchema = Type.Object({
  result: Type.Object({
    type: Type.Optional(Type.String()),
    panes: Type.Array(
      Type.Object({
        workspace_id: NonBlank,
        tab_id: NonBlank,
        pane_id: NonBlank,
        terminal_id: NonBlank,
        cwd: NonBlank,
        name: Type.Optional(NonBlank),
      }),
    ),
  }),
});
const TabCreateResponseSchema = Type.Object({
  result: Type.Object({
    type: Type.Optional(Type.String()),
    tab: Type.Object({ tab_id: NonBlank, workspace_id: NonBlank }),
    root_pane: Type.Object({
      pane_id: NonBlank,
      workspace_id: NonBlank,
      tab_id: NonBlank,
      cwd: NonBlank,
    }),
  }),
});
const WorkspaceCreateResponseSchema = Type.Object({
  result: Type.Object({
    type: Type.Optional(Type.String()),
    workspace: Type.Object({ workspace_id: NonBlank }),
    tab: Type.Object({ tab_id: NonBlank, workspace_id: NonBlank }),
    root_pane: Type.Object({
      pane_id: NonBlank,
      workspace_id: NonBlank,
      tab_id: NonBlank,
      cwd: NonBlank,
    }),
  }),
});
const SuccessResponseSchema = Type.Object({ result: Type.Object({}) });
const ErrorResponseSchema = Type.Object({
  error: Type.Object({ code: NonBlank, message: Type.Optional(Type.String()) }),
});
const childProcessLayer = NodeChildProcessSpawner.layer.pipe(Layer.provide(liveLayer));
const NOT_FOUND = Symbol("HerdrNotFound");

type AgentStatus = Static<typeof AgentStatusSchema>;
type NativeAgent = Static<typeof AgentSchema>;
type ListedAgent = Static<typeof ListedAgentSchema>;
type CommandOptions = { readonly timeout?: number; readonly notFound?: readonly string[] };
interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface WorkerIdentity {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly terminalId: string;
  readonly agentName: string;
  readonly sessionFile: string;
  readonly cwd: string;
}

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
  readonly environment: {
    readonly PI_WORKGRAPH_ROLE: string;
    readonly PI_CODING_AGENT_DIR?: string;
  };
}

export interface WorkerPane {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly agentName: string;
  readonly cwd: string;
}

interface HerdrObservation {
  readonly identity: WorkerIdentity;
  readonly status: AgentStatus;
  readonly observedAt: string;
}
export type WorkerObservation =
  | ({ readonly state: "ready" } & HerdrObservation)
  | {
      readonly state: "partial";
      readonly pane: WorkerPane;
      readonly observedAt: string;
      readonly detail: string;
    }
  | { readonly state: "absent"; readonly observedAt: string };
export type HerdrInspection =
  | HerdrObservation
  | { readonly identity: WorkerIdentity; readonly status: "absent"; readonly observedAt: string };
export type CoordinatorObservation =
  | { readonly state: "present" }
  | { readonly state: "absent"; readonly reason: "tab_absent" | "different_session" };

export class HerdrError extends Data.TaggedError("HerdrError")<{
  readonly operation: string;
  readonly message: string;
}> {}

/** Direct owner of the small Herdr command surface used by Workgraph. */
export class HerdrCliRuntime {
  readonly available: boolean;
  private readonly coordinatorEnvironment: readonly string[];

  constructor(
    private readonly executable = process.env["PI_WORKGRAPH_HERDR_BIN"] ?? "herdr",
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.available =
      environment["HERDR_ENV"] === "1" && environment["HERDR_WORKSPACE_ID"] !== undefined;
    const agentDir = environment["PI_CODING_AGENT_DIR"];
    this.coordinatorEnvironment =
      agentDir === undefined ? [] : ["--env", `PI_CODING_AGENT_DIR=${agentDir}`];
  }

  launch(request: HerdrLaunchRequest): Effect.Effect<HerdrObservation, HerdrError> {
    return this.createWorkerTab(request).pipe(
      Effect.flatMap((pane) => this.startWorker(pane, request)),
    );
  }

  createWorkerTab(request: HerdrLaunchRequest): Effect.Effect<WorkerPane, HerdrError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        yield* this.requireAvailable();
        const agentName = herdrWorkerName(request);
        const created = yield* this.command(
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
            ...environmentArgs(request.environment),
          ],
          TabCreateResponseSchema,
        ).pipe(
          Effect.mapError(
            (error) =>
              new HerdrError({
                operation: error.operation,
                message: `${error.message} Worker tab creation is uncertain for workspace=${request.workspaceId} cwd=${request.cwd}; do not retry or clean up.`,
              }),
          ),
        );
        if (created === NOT_FOUND)
          return yield* this.failure(
            "tab create",
            "Herdr reported an impossible not-found result.",
          );
        const tab = created.result.tab;
        const pane = created.result.root_pane;
        if (
          tab.workspace_id !== request.workspaceId ||
          pane.workspace_id !== request.workspaceId ||
          pane.tab_id !== tab.tab_id ||
          pane.cwd !== request.cwd
        )
          return yield* this.failure(
            "tab create",
            `Created Worker tab identity conflicts with workspace=${request.workspaceId} cwd=${request.cwd}; observed workspace=${pane.workspace_id} tab=${tab.tab_id} pane=${pane.pane_id} cwd=${pane.cwd}. Resources were retained.`,
          );
        return {
          workspaceId: request.workspaceId,
          tabId: tab.tab_id,
          paneId: pane.pane_id,
          agentName,
          cwd: request.cwd,
        };
      }.bind(this),
    );
  }

  startWorker(
    pane: WorkerPane,
    request: Pick<HerdrLaunchRequest, "sessionFile" | "model" | "thinking">,
  ): Effect.Effect<HerdrObservation, HerdrError> {
    const args = [
      "agent",
      "start",
      pane.agentName,
      "--kind",
      "pi",
      "--pane",
      pane.paneId,
      "--timeout",
      "40000",
      "--",
      "--session",
      request.sessionFile,
      ...agentSelectionArgs(request.model, request.thinking),
    ];
    return this.command(args, AgentStartResponseSchema, { timeout: 45_000 }).pipe(
      Effect.mapError(
        (error) =>
          new HerdrError({
            operation: error.operation,
            message: `${error.message} Worker launch may have created resources workspace=${pane.workspaceId} tab=${pane.tabId} pane=${pane.paneId}; resources were retained.`,
          }),
      ),
      Effect.flatMap((started) => {
        if (started === NOT_FOUND)
          return this.failure("agent start", "Herdr reported an impossible not-found result.");
        const observation = exactObservation(
          { ...pane, sessionFile: request.sessionFile },
          started.result.agent,
        );
        if (observation instanceof HerdrError) return Effect.fail(observation);
        return observation.status === "idle" || observation.status === "working"
          ? Effect.succeed(observation)
          : this.failure(
              "agent start",
              `Herdr start did not prove a ready Worker (status=${observation.status}); exact resources workspace=${observation.identity.workspaceId} tab=${observation.identity.tabId} pane=${observation.identity.paneId} terminal=${observation.identity.terminalId} were retained.`,
            );
      }),
    );
  }

  /** Derive current Worker identity from Herdr-owned native facts. */
  observeWorker(request: HerdrLaunchRequest): Effect.Effect<WorkerObservation, HerdrError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        yield* this.requireAvailable();
        const listed = yield* this.command(["agent", "list"], AgentListResponseSchema);
        if (listed === NOT_FOUND)
          return yield* this.failure(
            "agent list",
            "Herdr reported an impossible not-found result.",
          );
        const sessionAgents = listed.result.agents.filter(
          (agent) => agent.agent_session?.value === request.sessionFile,
        );
        const ready = sessionAgentObservation(request, sessionAgents);
        if (ready instanceof HerdrError) return yield* ready;
        return ready ?? (yield* this.observePartialWorker(request, listed.result.agents));
      }.bind(this),
    );
  }

  private observePartialWorker(
    request: HerdrLaunchRequest,
    agents: readonly ListedAgent[],
  ): Effect.Effect<WorkerObservation, HerdrError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        const listedTabs = yield* this.command(
          ["tab", "list", "--workspace", request.workspaceId],
          TabListResponseSchema,
        );
        if (listedTabs === NOT_FOUND)
          return yield* this.failure("tab list", "Herdr reported an impossible not-found result.");
        const label = herdrWorkerTabLabel(request);
        const tabs = listedTabs.result.tabs.filter(
          (tab) => tab.workspace_id === request.workspaceId && tab.label === label,
        );
        if (tabs.length === 0) return { state: "absent" as const, observedAt: now() };
        if (tabs.length > 1)
          return yield* this.failure(
            "observe Worker",
            `Worker label ${JSON.stringify(label)} identifies ${tabs.length} tabs; identity is ambiguous.`,
          );
        const tab = tabs[0];
        if (tab === undefined)
          return yield* this.failure("observe Worker", "Worker tab observation is incomplete.");
        if (agents.some((candidate) => candidate.tab_id === tab.tab_id))
          return yield* this.failure(
            "observe Worker",
            `Attempt-labelled tab=${tab.tab_id} contains a foreign or incomplete agent identity.`,
          );
        const listedPanes = yield* this.command(
          ["pane", "list", "--workspace", request.workspaceId],
          PaneListResponseSchema,
        );
        if (listedPanes === NOT_FOUND)
          return yield* this.failure("pane list", "Herdr reported an impossible not-found result.");
        const panes = listedPanes.result.panes.filter((pane) => pane.tab_id === tab.tab_id);
        const pane = panes[0];
        if (
          panes.length !== 1 ||
          pane === undefined ||
          pane.workspace_id !== request.workspaceId ||
          pane.cwd !== request.cwd
        )
          return yield* this.failure(
            "observe Worker",
            `Attempt-labelled tab=${tab.tab_id} has ambiguous or foreign pane identity.`,
          );
        return {
          state: "partial" as const,
          pane: {
            workspaceId: request.workspaceId,
            tabId: tab.tab_id,
            paneId: pane.pane_id,
            agentName: herdrWorkerName(request),
            cwd: request.cwd,
          },
          observedAt: now(),
          detail: `Attempt-labelled tab=${tab.tab_id} pane=${pane.pane_id} exists without the exact Pi session.`,
        };
      }.bind(this),
    );
  }

  /** Issue one close for an exactly observed Worker and verify through fresh observation. */
  closeObservedWorker(
    request: HerdrLaunchRequest,
    observed: Exclude<WorkerObservation, { readonly state: "absent" }>,
  ): Effect.Effect<"absent" | "present", HerdrError> {
    const tabId = observed.state === "ready" ? observed.identity.tabId : observed.pane.tabId;
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        yield* Effect.result(this.command(["tab", "close", tabId], SuccessResponseSchema));
        const after = yield* this.observeWorker(request);
        return after.state === "absent" ? ("absent" as const) : ("present" as const);
      }.bind(this),
    );
  }

  launchCoordinator(request: {
    readonly cwd: string;
    readonly sessionFile: string;
  }): Effect.Effect<WorkerIdentity, HerdrError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        yield* this.requireAvailable();
        const names = herdrCoordinatorNames(request);
        const created = yield* this.command(
          [
            "workspace",
            "create",
            "--cwd",
            request.cwd,
            "--label",
            names.label,
            "--no-focus",
            ...this.coordinatorEnvironment,
          ],
          WorkspaceCreateResponseSchema,
        ).pipe(
          Effect.mapError(
            (error) =>
              new HerdrError({
                operation: error.operation,
                message: `${error.message} Coordinator workspace creation is uncertain for session=${request.sessionFile} cwd=${request.cwd}; do not retry or clean up.`,
              }),
          ),
        );
        if (created === NOT_FOUND)
          return yield* this.failure(
            "workspace create",
            "Herdr reported an impossible not-found result.",
          );
        const workspace = created.result.workspace.workspace_id;
        const tab = created.result.tab;
        const pane = created.result.root_pane;
        if (
          tab.workspace_id !== workspace ||
          pane.workspace_id !== workspace ||
          pane.tab_id !== tab.tab_id ||
          pane.cwd !== request.cwd
        )
          return yield* this.failure(
            "workspace create",
            `Created Coordinator identity conflicts with cwd=${request.cwd}; observed workspace=${workspace} tab=${tab.tab_id} pane=${pane.pane_id} cwd=${pane.cwd}. Resources were retained.`,
          );
        const started = yield* this.command(
          [
            "agent",
            "start",
            names.agentName,
            "--kind",
            "pi",
            "--pane",
            pane.pane_id,
            "--timeout",
            "40000",
            "--",
            "--session",
            request.sessionFile,
          ],
          AgentStartResponseSchema,
          { timeout: 45_000 },
        ).pipe(
          Effect.mapError(
            (error) =>
              new HerdrError({
                operation: error.operation,
                message: `${error.message} Coordinator launch may have created resources workspace=${workspace} tab=${tab.tab_id} pane=${pane.pane_id}; the child session and resources were retained.`,
              }),
          ),
        );
        if (started === NOT_FOUND)
          return yield* this.failure(
            "agent start",
            "Herdr reported an impossible not-found result.",
          );
        const observation = exactObservation(
          {
            workspaceId: workspace,
            tabId: tab.tab_id,
            paneId: pane.pane_id,
            agentName: names.agentName,
            sessionFile: request.sessionFile,
            cwd: request.cwd,
          },
          started.result.agent,
        );
        if (observation instanceof HerdrError) return yield* observation;
        if (observation.status !== "idle" && observation.status !== "working")
          return yield* this.failure(
            "agent start",
            `Herdr start did not prove a ready Coordinator (status=${observation.status}); workspace=${workspace} tab=${tab.tab_id} pane=${pane.pane_id} terminal=${observation.identity.terminalId} were retained.`,
          );
        return observation.identity;
      }.bind(this),
    );
  }

  inspect(identity: WorkerIdentity): Effect.Effect<HerdrInspection, HerdrError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        const response = yield* this.command(
          ["agent", "get", identity.paneId],
          AgentResponseSchema,
          {
            notFound: ["agent_not_found", "pane_not_found"],
          },
        );
        if (response !== NOT_FOUND) {
          const observation = exactObservation(identity, response.result.agent);
          return observation instanceof HerdrError ? yield* observation : observation;
        }
        const tab = yield* this.command(["tab", "get", identity.tabId], SuccessResponseSchema, {
          notFound: ["tab_not_found"],
        });
        if (tab === NOT_FOUND) return { identity, status: "absent" as const, observedAt: now() };
        return yield* this.failure(
          "agent get",
          `Exact Worker is not observable but its tab remains present: workspace=${identity.workspaceId} tab=${identity.tabId} pane=${identity.paneId} terminal=${identity.terminalId}.`,
        );
      }.bind(this),
    );
  }

  prompt(identity: WorkerIdentity, text: string): Effect.Effect<void, HerdrError> {
    const prompt = text.trim();
    if (prompt.length === 0) return this.failure("agent prompt", "Worker prompt cannot be blank.");
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        const observed = yield* this.inspect(identity);
        if (observed.status !== "idle" && observed.status !== "working")
          return yield* this.failure(
            "agent prompt",
            `Exact Worker is not ready for a prompt (status=${observed.status}).`,
          );
        const response = yield* this.command(
          ["agent", "prompt", identity.paneId, prompt],
          SuccessResponseSchema,
          { timeout: 15_000 },
        );
        if (response === NOT_FOUND)
          return yield* this.failure(
            "agent prompt",
            "Herdr reported an impossible not-found result.",
          );
      }.bind(this),
    );
  }

  close(identity: WorkerIdentity): Effect.Effect<"absent" | "present" | "unknown", HerdrError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        const before = yield* this.inspect(identity);
        if (before.status === "absent") return "absent" as const;
        yield* Effect.result(this.command(["tab", "close", identity.tabId], SuccessResponseSchema));
        const after = yield* Effect.result(this.inspect(identity));
        if (after._tag === "Failure") return "unknown" as const;
        return after.success.status === "absent" ? ("absent" as const) : ("present" as const);
      }.bind(this),
    );
  }

  observeCoordinator(identity: {
    readonly workspaceId: string;
    readonly tabId: string;
    readonly sessionFile: string;
  }): Effect.Effect<CoordinatorObservation, HerdrError> {
    if (!this.available) return this.failure("agent list", "Herdr runtime is unavailable.");
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        const response = yield* this.command(["agent", "list"], AgentListResponseSchema);
        if (response === NOT_FOUND)
          return yield* this.failure(
            "agent list",
            "Herdr reported an impossible not-found result.",
          );
        const exactTab = response.result.agents.filter((agent) => agent.tab_id === identity.tabId);
        const displaced = response.result.agents.find(
          (agent) =>
            agent.agent_session?.value === identity.sessionFile && agent.tab_id !== identity.tabId,
        );
        if (displaced !== undefined)
          return yield* this.failure(
            "agent list",
            `Prior Coordinator session=${identity.sessionFile} moved to workspace=${displaced.workspace_id} tab=${displaced.tab_id}; adoption is blocked.`,
          );
        if (exactTab.some((agent) => agent.workspace_id !== identity.workspaceId))
          return yield* this.failure(
            "agent list",
            `Prior Coordinator tab=${identity.tabId} has a conflicting workspace identity; adoption is blocked.`,
          );
        if (exactTab.some((agent) => agent.agent_session?.value === identity.sessionFile))
          return { state: "present" as const };
        if (exactTab.length > 0 && exactTab.every((agent) => agent.agent_session !== undefined))
          return { state: "absent" as const, reason: "different_session" as const };
        if (exactTab.length > 0)
          return yield* this.failure(
            "agent list",
            `Prior Coordinator tab=${identity.tabId} does not expose a conclusive native Pi session identity; adoption is blocked.`,
          );
        const tab = yield* this.command(["tab", "get", identity.tabId], SuccessResponseSchema, {
          notFound: ["tab_not_found"],
        });
        if (tab === NOT_FOUND) return { state: "absent" as const, reason: "tab_absent" as const };
        return yield* this.failure(
          "agent list",
          `Prior Coordinator tab=${identity.tabId} remains but no conclusive native Pi session identity is available; adoption is blocked.`,
        );
      }.bind(this),
    );
  }

  private requireAvailable(): Effect.Effect<void, HerdrError> {
    return this.available
      ? Effect.void
      : this.failure("availability", "Herdr runtime is unavailable.");
  }

  private failure(operation: string, message: string): Effect.Effect<never, HerdrError> {
    return Effect.fail(new HerdrError({ operation, message }));
  }

  private command<const Schema extends TSchema>(
    args: string[],
    schema: Schema,
    options: CommandOptions = {},
  ): Effect.Effect<Static<Schema> | typeof NOT_FOUND, HerdrError> {
    const operation = args.slice(0, 2).join(" ");
    const command = ChildProcess.make(this.executable, args, {
      cwd: process.cwd(),
      stdin: "ignore",
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(command);
        return yield* Effect.all(
          {
            code: child.exitCode,
            stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
          },
          { concurrency: "unbounded" },
        );
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: options.timeout ?? 30_000,
        orElse: () =>
          this.failure(
            operation,
            `herdr ${operation} timed out after ${options.timeout ?? 30_000}ms.`,
          ),
      }),
      Effect.mapError((error) =>
        error instanceof HerdrError
          ? error
          : new HerdrError({
              operation,
              message: `Unable to execute herdr ${operation}: ${String(error)}`,
            }),
      ),
      Effect.flatMap((result) => decodeCommandResult(result, operation, schema, options)),
      Effect.provide(childProcessLayer),
    );
  }
}

function decodeCommandResult<const Schema extends TSchema>(
  result: CommandResult,
  operation: string,
  schema: Schema,
  options: CommandOptions,
): Effect.Effect<Static<Schema> | typeof NOT_FOUND, HerdrError> {
  const code = Number(result.code);
  const output = code === 0 ? result.stdout.trim() : result.stderr.trim() || result.stdout.trim();
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return Effect.fail(
      new HerdrError({
        operation,
        message: `herdr ${operation} returned invalid JSON${code === 0 ? "." : ` and exited ${code}.`}`,
      }),
    );
  }
  if (code !== 0) return decodeCommandFailure(value, operation, code, options.notFound);
  return Value.Check(schema, value)
    ? Effect.succeed(Value.Decode(schema, value))
    : Effect.fail(
        new HerdrError({
          operation,
          message: `herdr ${operation} returned an invalid success envelope.`,
        }),
      );
}

function decodeCommandFailure(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This function strictly decodes a raw Herdr error envelope.
  value: unknown,
  operation: string,
  code: number,
  notFound: readonly string[] | undefined,
): Effect.Effect<typeof NOT_FOUND, HerdrError> {
  if (!Value.Check(ErrorResponseSchema, value))
    return Effect.fail(
      new HerdrError({
        operation,
        message: `herdr ${operation} exited ${code} with an invalid error envelope.`,
      }),
    );
  const error = Value.Decode(ErrorResponseSchema, value).error;
  if (notFound?.includes(error.code) === true) return Effect.succeed(NOT_FOUND);
  return Effect.fail(
    new HerdrError({
      operation,
      message: `herdr ${operation} failed: ${error.code}${error.message === undefined ? "" : `: ${error.message}`}`,
    }),
  );
}

function sessionAgentObservation(
  request: HerdrLaunchRequest,
  agents: readonly ListedAgent[],
): Extract<WorkerObservation, { readonly state: "ready" }> | HerdrError | undefined {
  if (agents.length > 1)
    return new HerdrError({
      operation: "observe Worker",
      message: `Worker session has ${agents.length} native agents; identity is ambiguous.`,
    });
  const agent = agents[0];
  if (agent === undefined) return undefined;
  const agentName = herdrWorkerName(request);
  if (
    agent.workspace_id !== request.workspaceId ||
    agent.cwd !== request.cwd ||
    (agent.name !== undefined && agent.name !== agentName)
  )
    return new HerdrError({
      operation: "observe Worker",
      message: `Worker session has foreign native identity workspace=${agent.workspace_id} tab=${agent.tab_id} pane=${agent.pane_id} cwd=${agent.cwd} name=${agent.name ?? "omitted"}.`,
    });
  const observation = exactObservation(
    {
      workspaceId: request.workspaceId,
      tabId: agent.tab_id,
      paneId: agent.pane_id,
      agentName,
      sessionFile: request.sessionFile,
      cwd: request.cwd,
    },
    { ...agent, agent_session: { value: request.sessionFile } },
  );
  return observation instanceof HerdrError
    ? observation
    : { state: "ready" as const, ...observation };
}

function exactObservation(
  expected: Omit<WorkerIdentity, "terminalId"> & { readonly terminalId?: string },
  actual: NativeAgent,
): HerdrObservation | HerdrError {
  const observed = `workspace=${actual.workspace_id} tab=${actual.tab_id} pane=${actual.pane_id} terminal=${actual.terminal_id} cwd=${actual.cwd} name=${actual.name} session=${actual.agent_session.value}`;
  if (
    actual.workspace_id !== expected.workspaceId ||
    actual.tab_id !== expected.tabId ||
    actual.pane_id !== expected.paneId ||
    (expected.terminalId !== undefined && actual.terminal_id !== expected.terminalId) ||
    actual.cwd !== expected.cwd ||
    (actual.name !== undefined && actual.name !== expected.agentName) ||
    actual.agent_session.value !== expected.sessionFile
  )
    return new HerdrError({
      operation: "agent identity",
      message: `Herdr native identity mismatch; observed ${observed}. No resource was adopted or cleaned up.`,
    });
  return {
    identity: {
      workspaceId: actual.workspace_id,
      tabId: actual.tab_id,
      paneId: actual.pane_id,
      terminalId: actual.terminal_id,
      agentName: expected.agentName,
      sessionFile: actual.agent_session.value,
      cwd: actual.cwd,
    },
    status: actual.agent_status,
    observedAt: now(),
  };
}

function agentSelectionArgs(model: string | undefined, thinking: string | undefined): string[] {
  return [
    ...(model === undefined ? [] : ["--model", model]),
    ...(thinking === undefined ? [] : ["--thinking", thinking]),
  ];
}

function environmentArgs(environment: HerdrLaunchRequest["environment"]): string[] {
  return Object.entries(environment)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

function now(): string {
  return DateTime.formatIso(DateTime.nowUnsafe());
}
