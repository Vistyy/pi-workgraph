/* biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: observation performs one cohesive exact native identity proof. */
/* biome-ignore-all lint/complexity/useLiteralKeys: ProcessEnv keys require indexed access under noPropertyAccessFromIndexSignature. */
import { Data, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { childProcessLayer } from "../node-platform.js";
import { herdrWorkerName, herdrWorkerTabLabel, type WorkerNamingContext } from "./worker-naming.js";

const Text = Type.String({ minLength: 1 });

const ReadyStatus = Type.Union([Type.Literal("idle"), Type.Literal("working")]);

const AgentStatus = Type.Union([
  ReadyStatus,
  Type.Literal("blocked"),
  Type.Literal("done"),
  Type.Literal("unknown"),
]);

const Agent = Type.Object({
  workspace_id: Text,
  tab_id: Text,
  pane_id: Text,
  agent_status: AgentStatus,
  cwd: Text,
  name: Type.Optional(Text),
  agent_session: Type.Optional(Type.Object({ value: Text })),
});

const StartedAgent = Type.Intersect([
  Agent,
  Type.Object({
    name: Text,
    agent_session: Type.Object({ value: Text }),
    interactive_ready: Type.Literal(true),
  }),
]);

const AgentStartEnvelope = Type.Object({ result: Type.Object({ agent: StartedAgent }) });

const AgentListEnvelope = Type.Object({ result: Type.Object({ agents: Type.Array(Agent) }) });

const TabCreateEnvelope = Type.Object({
  result: Type.Object({
    tab: Type.Object({ workspace_id: Text, tab_id: Text }),
    root_pane: Type.Object({ workspace_id: Text, tab_id: Text, pane_id: Text, cwd: Text }),
  }),
});

const TabListEnvelope = Type.Object({
  result: Type.Object({
    tabs: Type.Array(Type.Object({ workspace_id: Text, tab_id: Text, label: Type.Optional(Text) })),
  }),
});

const PaneListEnvelope = Type.Object({
  result: Type.Object({
    panes: Type.Array(Type.Object({ workspace_id: Text, tab_id: Text, pane_id: Text, cwd: Text })),
  }),
});

const SuccessEnvelope = Type.Object({ result: Type.Object({}) });

const ErrorEnvelope = Type.Object({
  error: Type.Object({ code: Text, message: Type.Optional(Type.String()) }),
});

export interface WorkerRequest extends WorkerNamingContext {
  readonly workspaceId: string;
  readonly cwd: string;
  readonly sessionFile: string;
  readonly model: string;
  readonly thinking: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface WorkerTab {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
}

export interface ExactWorker extends WorkerTab {
  readonly state: "agent";
  readonly status: "idle" | "working" | "blocked" | "done" | "unknown";
}

export interface ReadyWorker extends ExactWorker {
  readonly status: "idle" | "working";
}

export interface PartialWorker extends WorkerTab {
  readonly state: "partial";
}

export type WorkerObservation = ExactWorker | PartialWorker | { readonly state: "absent" };

export type WorkerLocator =
  | { readonly state: "uncertain"; readonly workspaceId: string }
  | ({ readonly state: "ready" } & WorkerTab);

export class HerdrError extends Data.TaggedError("HerdrError")<{
  readonly operation: string;
  readonly message: string;
}> {}

/** Exact Worker-only Herdr command adapter. */
export class HerdrCliRuntime {
  readonly available: boolean;
  constructor(
    // Herdr launch configuration belongs to this exact host adapter.
    // oxlint-disable-next-line effecttsgo/process-env
    private readonly executable = process.env["PI_WORKGRAPH_HERDR_BIN"] ?? "herdr",
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.available =
      environment["HERDR_ENV"] === "1" && environment["HERDR_WORKSPACE_ID"] !== undefined;
  }

  createWorkerTab(request: WorkerRequest): Effect.Effect<WorkerTab, HerdrError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        yield* this.requireAvailable();

        const response = yield* this.command(
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
          TabCreateEnvelope,
        );

        const { tab, root_pane: pane } = response.result;

        if (
          tab.workspace_id !== request.workspaceId ||
          pane.workspace_id !== request.workspaceId ||
          pane.tab_id !== tab.tab_id ||
          pane.cwd !== request.cwd
        )
          return yield* this.fail(
            "tab create",
            "Created Worker tab has mismatched native identity; resources were retained.",
          );

        return { workspaceId: request.workspaceId, tabId: tab.tab_id, paneId: pane.pane_id };
      }.bind(this),
    );
  }

  startWorker(tab: WorkerTab, request: WorkerRequest): Effect.Effect<ReadyWorker, HerdrError> {
    return this.command(
      [
        "agent",
        "start",
        herdrWorkerName(request),
        "--kind",
        "pi",
        "--pane",
        tab.paneId,
        "--timeout",
        "40000",
        "--",
        "--session",
        request.sessionFile,
        "--model",
        request.model,
        "--thinking",
        request.thinking,
      ],
      AgentStartEnvelope,
      45_000,
    ).pipe(
      Effect.flatMap(({ result }) => exactReady(request, tab, result.agent, "agent start")),
      Effect.mapError(
        (cause) =>
          new HerdrError({
            operation: cause.operation,
            message: `${cause.message} Agent start is uncertain; do not replay it.`,
          }),
      ),
    );
  }

  observeWorker(
    request: WorkerRequest,
    locator: WorkerLocator,
  ): Effect.Effect<WorkerObservation, HerdrError> {
    return Effect.gen(
      function* (this: HerdrCliRuntime) {
        yield* this.requireAvailable();
        const agents = (yield* this.command(["agent", "list"], AgentListEnvelope)).result.agents;

        const sessionAgents = agents.filter(
          (agent) => agent.agent_session?.value === request.sessionFile,
        );

        if (sessionAgents.length > 1)
          return yield* this.fail("observe Worker", "Worker session identity is ambiguous.");
        const sessionAgent = sessionAgents[0];

        if (sessionAgent !== undefined) {
          const tab =
            locator.state === "ready"
              ? locator
              : {
                  workspaceId: locator.workspaceId,
                  tabId: sessionAgent.tab_id,
                  paneId: sessionAgent.pane_id,
                };

          return yield* exactWorker(request, tab, sessionAgent, "observe Worker");
        }

        const tabs = (yield* this.command(
          ["tab", "list", "--workspace", locator.workspaceId],
          TabListEnvelope,
        )).result.tabs;

        const matches =
          locator.state === "ready"
            ? tabs.filter(
                (tab) => tab.workspace_id === locator.workspaceId && tab.tab_id === locator.tabId,
              )
            : tabs.filter(
                (tab) =>
                  tab.workspace_id === locator.workspaceId &&
                  tab.label === herdrWorkerTabLabel(request),
              );

        if (matches.length === 0) return { state: "absent" as const };

        if (matches.length !== 1)
          return yield* this.fail("observe Worker", "Worker tab identity is ambiguous.");
        const tab = matches[0];

        if (tab === undefined)
          return yield* this.fail("observe Worker", "Worker tab identity is incomplete.");

        if (agents.some((agent) => agent.tab_id === tab.tab_id))
          return yield* this.fail(
            "observe Worker",
            "Worker tab contains a foreign or incomplete agent identity.",
          );

        const panes = (yield* this.command(
          ["pane", "list", "--workspace", locator.workspaceId],
          PaneListEnvelope,
        )).result.panes.filter((pane) => pane.tab_id === tab.tab_id);

        const pane = panes[0];

        if (
          panes.length !== 1 ||
          pane === undefined ||
          pane.workspace_id !== locator.workspaceId ||
          pane.cwd !== request.cwd ||
          (locator.state === "ready" && pane.pane_id !== locator.paneId)
        )
          return yield* this.fail(
            "observe Worker",
            "Worker pane identity is ambiguous, foreign, or incomplete.",
          );

        return {
          state: "partial" as const,
          workspaceId: locator.workspaceId,
          tabId: tab.tab_id,
          paneId: pane.pane_id,
        };
      }.bind(this),
    );
  }

  prompt(worker: ExactWorker, text: string): Effect.Effect<void, HerdrError> {
    if (worker.status !== "idle" && worker.status !== "working")
      return this.fail("agent prompt", `Worker is not ready (status=${worker.status}).`);
    const prompt = text.trim();

    if (prompt.length === 0) return this.fail("agent prompt", "Worker prompt cannot be blank.");

    return this.command(["agent", "prompt", worker.paneId, prompt], SuccessEnvelope, 15_000).pipe(
      Effect.asVoid,
    );
  }

  closeObservedWorker(
    request: WorkerRequest,
    worker: ExactWorker | PartialWorker,
  ): Effect.Effect<"absent" | "present", HerdrError> {
    const locator: WorkerLocator = {
      state: "ready",
      workspaceId: worker.workspaceId,
      tabId: worker.tabId,
      paneId: worker.paneId,
    };

    return Effect.result(this.command(["tab", "close", worker.tabId], SuccessEnvelope)).pipe(
      Effect.andThen(this.observeWorker(request, locator)),
      Effect.map((observed) =>
        observed.state === "absent" ? ("absent" as const) : ("present" as const),
      ),
    );
  }

  private requireAvailable(): Effect.Effect<void, HerdrError> {
    return this.available
      ? Effect.void
      : this.fail("availability", "Herdr runtime is unavailable.");
  }
  private fail(operation: string, message: string): Effect.Effect<never, HerdrError> {
    return Effect.fail(new HerdrError({ operation, message }));
  }
  private command<const S extends TSchema>(
    args: string[],
    schema: S,
    timeout = 30_000,
  ): Effect.Effect<Static<S>, HerdrError> {
    const operation = args.slice(0, 2).join(" ");

    const process = ChildProcess.make(this.executable, args, {
      cwd: globalThis.process.cwd(),
      stdin: "ignore",
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(process);

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
        duration: timeout,
        orElse: () => this.fail(operation, `herdr ${operation} timed out.`),
      }),
      Effect.mapError((cause) =>
        cause instanceof HerdrError
          ? cause
          : new HerdrError({ operation, message: `Unable to execute herdr ${operation}.` }),
      ),
      Effect.flatMap((result) => decode(result, operation, schema)),
      Effect.provide(childProcessLayer),
    );
  }
}

function exactWorker(
  request: WorkerRequest,
  expected: WorkerTab,
  agent: Static<typeof Agent>,
  operation: string,
): Effect.Effect<ExactWorker, HerdrError> {
  if (
    agent.workspace_id !== expected.workspaceId ||
    agent.tab_id !== expected.tabId ||
    agent.pane_id !== expected.paneId ||
    agent.cwd !== request.cwd ||
    agent.agent_session?.value !== request.sessionFile ||
    agent.name !== herdrWorkerName(request)
  )
    return Effect.fail(
      new HerdrError({
        operation,
        message: "Worker native identity is foreign or mismatched; no mutation was issued.",
      }),
    );

  return Effect.succeed({ ...expected, state: "agent", status: agent.agent_status });
}

function exactReady(
  request: WorkerRequest,
  expected: WorkerTab,
  agent: Static<typeof Agent>,
  operation: string,
): Effect.Effect<ReadyWorker, HerdrError> {
  return exactWorker(request, expected, agent, operation).pipe(
    Effect.filterOrFail(
      (worker): worker is ReadyWorker => worker.status === "idle" || worker.status === "working",
      (worker) =>
        new HerdrError({ operation, message: `Worker is not ready (status=${worker.status}).` }),
    ),
  );
}

function decode<const S extends TSchema>(
  result: { readonly code: number; readonly stdout: string; readonly stderr: string },
  operation: string,
  schema: S,
): Effect.Effect<Static<S>, HerdrError> {
  const code = Number(result.code);
  const text = (code === 0 ? result.stdout : result.stderr || result.stdout).trim();
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return Effect.fail(
      new HerdrError({ operation, message: `herdr ${operation} returned invalid JSON.` }),
    );
  }

  if (code !== 0) {
    const detail = Value.Check(ErrorEnvelope, value)
      ? Value.Decode(ErrorEnvelope, value).error
      : undefined;

    return Effect.fail(
      new HerdrError({
        operation,
        message:
          detail === undefined
            ? `herdr ${operation} returned an invalid error envelope.`
            : `herdr ${operation} failed: ${detail.code}${detail.message === undefined ? "" : `: ${detail.message}`}`,
      }),
    );
  }

  return Value.Check(schema, value)
    ? Effect.succeed(Value.Decode(schema, value) as Static<S>)
    : Effect.fail(
        new HerdrError({
          operation,
          message: `herdr ${operation} returned an invalid success envelope.`,
        }),
      );
}

function environmentArgs(environment: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(environment)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}
