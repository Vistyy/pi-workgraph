import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type {
  CoordinatorRuntimeIdentity,
  ThinkingLevel,
  WorkerIdentity,
  WorkerObservationStatus,
  WorkerResourceIdentity,
} from "./types.js";

export type HerdrAgentStatus = WorkerObservationStatus;

export interface HerdrObservation {
  identity: WorkerIdentity;
  status: HerdrAgentStatus;
  observedAt: string;
}

export interface HerdrAbsentObservation {
  identity: WorkerIdentity;
  status: "absent";
  observedAt: string;
  detail: string;
}

export type HerdrInspection = HerdrObservation | HerdrAbsentObservation;

export type WorkerRole = "implement" | "research" | "review";

export interface WorkerNamingContext {
  runId: string;
  nodeId?: string;
  attemptId: string;
  assignmentId?: string;
  objective?: string;
  role?: WorkerRole;
}

export interface WorkerLaunchRequest {
  workspaceId: string;
  runId: string;
  nodeId: string;
  attemptId: string;
  /** Naming context is optional for retained/custom transports; production launches provide it. */
  assignmentId?: string;
  objective?: string;
  role?: WorkerRole;
  cwd: string;
  sessionFile: string;
  prompt?: string;
  model?: string;
  thinking?: ThinkingLevel;
  env: Record<string, string>;
  onTab?: (tab: {
    workspaceId: string;
    paneId: string;
  }) => void | Promise<void>;
  onResource?: (resource: WorkerResourceIdentity) => void | Promise<void>;
  onIdentity?: (identity: WorkerIdentity) => void | Promise<void>;
  onSubmitted?: () => void | Promise<void>;
}

export interface WorkerRecoveryRequest {
  workspaceId: string;
  agentName: string;
  compatibleAgentNames?: readonly string[];
  sessionFile: string;
  cwd: string;
  resource?: WorkerResourceIdentity;
}

export class WorkerLaunchReadinessError extends Error {
  constructor(
    readonly resource: WorkerResourceIdentity,
    message: string,
  ) {
    super(message);
    this.name = "WorkerLaunchReadinessError";
  }
}

export interface CoordinatorLaunchRequest {
  cwd: string;
  sessionFile: string;
}

export interface CoordinatorLaunchResource {
  workspaceId: string;
  tabId: string;
  paneId: string;
  agentName: string;
  terminalId?: string;
  sessionFile: string;
  cwd: string;
}

export class CoordinatorLaunchError extends Error {
  constructor(
    readonly resource: CoordinatorLaunchResource | undefined,
    message: string,
  ) {
    super(message);
    this.name = "CoordinatorLaunchError";
  }
}

export interface CoordinatorObservationRequest {
  paneId: string;
  sessionFile: string;
  cwd: string;
}

export interface WorkerCleanupResult {
  state: "pending" | "completed" | "blocked";
  identity: WorkerIdentity;
  observedAt: string;
  detail: string;
}

export interface VisibleWorkerRuntime {
  readonly available: boolean;
  launch(request: WorkerLaunchRequest): Promise<HerdrObservation>;
  recover?(
    request: WorkerRecoveryRequest,
  ): Promise<HerdrObservation | undefined>;
  inspect(identity: WorkerIdentity): Promise<HerdrInspection>;
  observe(identity: WorkerIdentity): Promise<HerdrObservation>;
  interrupt(identity: WorkerIdentity): Promise<HerdrObservation>;
  steer?(identity: WorkerIdentity, instruction: string): Promise<void>;
  cleanup?(identity: WorkerIdentity): Promise<WorkerCleanupResult>;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class HerdrCliRuntime implements VisibleWorkerRuntime {
  readonly available: boolean;
  private readonly coordinatorEnvironment: Record<string, string>;

  constructor(
    private readonly command = process.env.PI_WORKGRAPH_HERDR_BIN || "herdr",
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.available =
      env.HERDR_ENV === "1" && typeof env.HERDR_WORKSPACE_ID === "string";
    this.coordinatorEnvironment = coordinatorEnvironment(env);
  }

  async launchCoordinator(
    request: CoordinatorLaunchRequest,
  ): Promise<WorkerIdentity> {
    if (!this.available)
      throw new Error("Herdr coordinator runtime is unavailable.");
    const { agentName, label } = herdrCoordinatorNames(request);
    let resource: CoordinatorLaunchResource;
    try {
      const created = object(
        await this.call([
          "workspace",
          "create",
          "--cwd",
          request.cwd,
          "--label",
          label,
          "--no-focus",
          ...envArgs(this.coordinatorEnvironment),
        ]),
        "result",
      );
      resource = {
        workspaceId: string(object(created, "workspace"), "workspace_id"),
        tabId: string(object(created, "tab"), "tab_id"),
        paneId: string(object(created, "root_pane"), "pane_id"),
        agentName,
        sessionFile: request.sessionFile,
        cwd: request.cwd,
      };
    } catch (error) {
      throw new CoordinatorLaunchError(
        undefined,
        `Coordinator workspace creation is uncertain for session ${request.sessionFile} at ${request.cwd} with exact label ${JSON.stringify(label)}: ${errorMessage(error)} Inspect that label before retrying; no tab fallback or cleanup was attempted.`,
      );
    }
    const { workspaceId, tabId, paneId } = resource;
    let retainedResource = resource;
    try {
      const started = parseAgent(
        object(
          object(
            await this.call(
              [
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
              ],
              45_000,
            ),
            "result",
          ),
          "agent",
        ),
      );
      assertCoordinatorPlacement(resource, started);
      const startedResource = resourceOf(started);
      retainedResource = {
        ...resource,
        terminalId: startedResource.terminalId,
      };
      return await this.awaitNativeIdentity(
        startedResource,
        request.sessionFile,
      );
    } catch (error) {
      throw new CoordinatorLaunchError(
        retainedResource,
        `Coordinator launch is uncertain in workspace ${workspaceId}, tab ${tabId}, pane ${paneId}, agent ${agentName}, session ${request.sessionFile}, cwd ${request.cwd}: ${errorMessage(error)} Inspect these exact handles before retrying; the workspace was retained.`,
      );
    }
  }

  async coordinatorLiveness(
    sessionFile: string,
  ): Promise<"alive" | "dead" | "unknown"> {
    if (!this.available) return "unknown";
    const response = await this.call(["api", "snapshot"]);
    const agents = object(object(response, "result"), "snapshot").agents;
    if (!Array.isArray(agents))
      throw new Error(
        "Herdr snapshot omitted agents; owner liveness is unknown.",
      );
    let unknown = false;
    for (const agent of agents) {
      if (!agent || typeof agent !== "object" || !("agent_session" in agent)) {
        unknown = true;
        continue;
      }
      const session: unknown = agent.agent_session;
      if (
        !session ||
        typeof session !== "object" ||
        !("value" in session) ||
        typeof session.value !== "string"
      ) {
        unknown = true;
        continue;
      }
      if (session.value === sessionFile) return "alive";
    }
    return unknown ? "unknown" : "dead";
  }

  async observeCurrentCoordinator(
    request: CoordinatorObservationRequest,
  ): Promise<CoordinatorRuntimeIdentity> {
    if (!this.available)
      throw new Error("Herdr coordinator runtime is unavailable.");
    const current = parseCoordinator(
      object(
        object(await this.call(["agent", "get", request.paneId]), "result"),
        "agent",
      ),
    );
    if (current.sessionFile !== request.sessionFile)
      throw new Error(
        "Current Herdr pane does not own the requested Pi session.",
      );
    if (current.cwd !== request.cwd)
      throw new Error("Current Herdr pane cwd does not match the repository.");
    return current;
  }

  async launch(request: WorkerLaunchRequest): Promise<HerdrObservation> {
    if (!this.available)
      throw new Error("Herdr worker runtime is unavailable.");
    const workerName = herdrWorkerName(request);
    const tabResponse = await this.call([
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
    ]);
    const tabResult = object(tabResponse, "result");
    const pane = object(tabResult, "root_pane");
    const paneId = string(pane, "pane_id");
    await request.onTab?.({ workspaceId: request.workspaceId, paneId });
    const args = [
      "agent",
      "start",
      workerName,
      "--kind",
      "pi",
      "--pane",
      paneId,
      "--",
      "--session",
      request.sessionFile,
    ];
    if (request.model) args.push("--model", request.model);
    if (request.thinking) args.push("--thinking", request.thinking);
    const started = parseAgent(
      object(object(await this.call(args, 45_000), "result"), "agent"),
    );
    const resource = resourceOf(started);
    assertResource({ ...resource, agentName: workerName }, started);
    await request.onResource?.(resource);
    const identity = await this.awaitNativeIdentity(
      resource,
      request.sessionFile,
    );
    await request.onIdentity?.(identity);
    if (request.prompt !== undefined) {
      await this.call(["agent", "prompt", workerName, request.prompt], 15_000);
      await request.onSubmitted?.();
      return {
        identity,
        status: "working",
        observedAt: new Date().toISOString(),
      };
    }
    return this.observe(identity);
  }

  async recover(
    request: WorkerRecoveryRequest,
  ): Promise<HerdrObservation | undefined> {
    const response = await this.call(["api", "snapshot"]);
    const snapshot = object(object(response, "result"), "snapshot");
    const agents = snapshot.agents;
    if (!Array.isArray(agents))
      throw new Error("Herdr snapshot omitted agents.");
    const compatibleAgentNames = new Set([
      request.agentName,
      ...(request.compatibleAgentNames ?? []),
    ]);
    const matches = agents.filter(
      (candidate): candidate is Record<string, unknown> => {
        if (
          !candidate ||
          typeof candidate !== "object" ||
          Array.isArray(candidate)
        )
          return false;
        const value = candidate as Record<string, unknown>;
        const session = value.agent_session;
        const sessionFile =
          session && typeof session === "object"
            ? optionalString(session as Record<string, unknown>, "value")
            : undefined;
        const resource = request.resource;
        const resourceMatches = resource
          ? value.workspace_id === resource.workspaceId &&
            value.tab_id === resource.tabId &&
            value.pane_id === resource.paneId &&
            value.terminal_id === resource.terminalId &&
            value.name === resource.agentName &&
            value.cwd === resource.cwd
          : value.workspace_id === request.workspaceId &&
            compatibleAgentNames.has(String(value.name)) &&
            value.cwd === request.cwd;
        return (
          resourceMatches &&
          (resource
            ? !sessionFile || sessionFile === request.sessionFile
            : sessionFile === request.sessionFile)
        );
      },
    );
    if (matches.length === 0) return undefined;
    if (matches.length !== 1)
      throw new Error(
        `Herdr recovery found ${matches.length} workers for ${request.agentName}.`,
      );
    const current = parseAgent(matches[0]!);
    const resource = request.resource ?? resourceOf(current);
    assertResource(resource, current);
    if (!current.sessionFile)
      throw new WorkerLaunchReadinessError(
        resource,
        "Recovered Herdr resource still has no native Pi session identity; operator action is required before assignment submission.",
      );
    const identity = identityOf(resource, current);
    assertIdentity(identity, current);
    return {
      identity,
      status: current.status,
      observedAt: new Date().toISOString(),
    };
  }

  private async awaitNativeIdentity(
    resource: WorkerResourceIdentity,
    expectedSessionFile: string,
    timeoutMs = 15_000,
  ): Promise<WorkerIdentity> {
    const deadline = Date.now() + timeoutMs;
    let last = "Native Pi session identity is not available yet.";
    while (Date.now() < deadline) {
      const response = await this.call(["agent", "get", resource.paneId]);
      const current = parseAgent(object(object(response, "result"), "agent"));
      assertResource(resource, current);
      if (current.sessionFile) {
        const identity = identityOf(resource, current);
        assertIdentity(
          { ...identity, sessionFile: expectedSessionFile },
          current,
        );
        return identity;
      }
      if (current.status === "blocked") {
        throw new WorkerLaunchReadinessError(
          resource,
          "Worker is blocked at a Pi trust or approval prompt; operator action is required before assignment submission.",
        );
      }
      last = `Worker is ${current.status}, but Herdr has not exposed its native Pi session identity.`;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new WorkerLaunchReadinessError(
      resource,
      `${last} Launch readiness timed out after ${timeoutMs}ms. No assignment prompt was submitted.`,
    );
  }

  async inspect(identity: WorkerIdentity): Promise<HerdrInspection> {
    const result = await spawnCommand(
      this.command,
      ["agent", "get", identity.paneId],
      30_000,
    );
    if (result.code !== 0) {
      if (
        (isNotFound(result, "agent_not_found") ||
          isNotFound(result, "pane_not_found")) &&
        (await this.tabAbsent(identity.tabId))
      )
        return {
          identity,
          status: "absent",
          observedAt: new Date().toISOString(),
          detail: `Exact Herdr tab ${identity.tabId} is absent.`,
        };
      throw herdrError(["agent", "get", identity.paneId], result);
    }
    const parsed = parseSuccess(result, ["agent", "get", identity.paneId]);
    const current = parseAgent(object(object(parsed, "result"), "agent"));
    assertIdentity(identity, current);
    return {
      identity,
      status: current.status,
      observedAt: new Date().toISOString(),
    };
  }

  async observe(identity: WorkerIdentity): Promise<HerdrObservation> {
    const inspection = await this.inspect(identity);
    if (inspection.status === "absent") throw new Error(inspection.detail);
    return inspection;
  }

  async interrupt(identity: WorkerIdentity): Promise<HerdrObservation> {
    await this.observe(identity);
    await this.call(["agent", "send-keys", identity.agentName, "esc"]);
    return this.observe(identity);
  }

  async steer(identity: WorkerIdentity, instruction: string): Promise<void> {
    if (!instruction.trim())
      throw new Error("Worker steering requires an instruction.");
    const current = await this.observe(identity);
    if (current.status === "blocked")
      throw new Error("Worker is blocked and cannot receive steering.");
    await this.call([
      "agent",
      "prompt",
      identity.agentName,
      instruction.trim(),
    ]);
  }

  async cleanup(identity: WorkerIdentity): Promise<WorkerCleanupResult> {
    const observation = await this.inspect(identity);
    if (observation.status === "absent") {
      return {
        state: "completed",
        identity,
        observedAt: observation.observedAt,
        detail: observation.detail,
      };
    }
    if (observation.status === "working") {
      return {
        state: "pending",
        identity,
        observedAt: observation.observedAt,
        detail: "Worker is still working; exact cleanup remains pending.",
      };
    }
    if (observation.status === "blocked" || observation.status === "unknown") {
      return {
        state: "blocked",
        identity,
        observedAt: observation.observedAt,
        detail: `Worker is ${observation.status}; cleanup requires a verified idle or done worker.`,
      };
    }
    await this.call(["tab", "close", identity.tabId]);
    if (!(await this.tabAbsent(identity.tabId)))
      throw new Error(
        `Herdr tab ${identity.tabId} still exists after cleanup.`,
      );
    return {
      state: "completed",
      identity,
      observedAt: new Date().toISOString(),
      detail: `Closed and verified exact Herdr tab ${identity.tabId}.`,
    };
  }

  private async tabAbsent(tabId: string): Promise<boolean> {
    const result = await spawnCommand(
      this.command,
      ["tab", "get", tabId],
      30_000,
    );
    if (result.code === 0) return false;
    if (isNotFound(result, "tab_not_found")) return true;
    throw herdrError(["tab", "get", tabId], result);
  }

  private async call(
    args: string[],
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    const result = await spawnCommand(this.command, args, timeoutMs);
    if (result.code !== 0) throw herdrError(args, result);
    return parseSuccess(result, args);
  }
}

interface ParsedAgent {
  workspaceId: string;
  tabId: string;
  paneId: string;
  terminalId: string;
  name: string;
  status: HerdrAgentStatus;
  sessionFile?: string;
  cwd: string;
}

function parseCoordinator(
  value: Record<string, unknown>,
): CoordinatorRuntimeIdentity {
  const session = object(value, "agent_session");
  const agentName = optionalString(value, "name");
  return {
    workspaceId: string(value, "workspace_id"),
    tabId: string(value, "tab_id"),
    paneId: string(value, "pane_id"),
    terminalId: string(value, "terminal_id"),
    ...(agentName ? { agentName } : {}),
    sessionFile: string(session, "value"),
    cwd: string(value, "cwd"),
  };
}

function parseAgent(value: Record<string, unknown>): ParsedAgent {
  const status = string(value, "agent_status");
  if (!isAgentStatus(status))
    throw new Error(`Invalid Herdr agent status: ${status}`);
  const session = value.agent_session;
  const sessionFile =
    session && typeof session === "object" && !Array.isArray(session)
      ? optionalString(session as Record<string, unknown>, "value")
      : undefined;
  return {
    workspaceId: string(value, "workspace_id"),
    tabId: string(value, "tab_id"),
    paneId: string(value, "pane_id"),
    terminalId: string(value, "terminal_id"),
    name: string(value, "name"),
    status,
    cwd: string(value, "cwd"),
    ...(sessionFile ? { sessionFile } : {}),
  };
}

function resourceOf(actual: ParsedAgent): WorkerResourceIdentity {
  return {
    workspaceId: actual.workspaceId,
    tabId: actual.tabId,
    paneId: actual.paneId,
    terminalId: actual.terminalId,
    agentName: actual.name,
    cwd: actual.cwd,
  };
}

function assertResource(
  expected: WorkerResourceIdentity,
  actual: ParsedAgent,
): void {
  if (
    expected.workspaceId !== actual.workspaceId ||
    expected.tabId !== actual.tabId ||
    expected.paneId !== actual.paneId ||
    expected.terminalId !== actual.terminalId ||
    expected.agentName !== actual.name
  ) {
    throw new Error("Herdr worker resource identity changed.");
  }
  if (actual.cwd !== expected.cwd) throw new Error("Herdr worker cwd changed.");
}

function assertCoordinatorPlacement(
  expected: CoordinatorLaunchResource,
  actual: ParsedAgent,
): void {
  if (
    actual.workspaceId !== expected.workspaceId ||
    actual.tabId !== expected.tabId ||
    actual.paneId !== expected.paneId ||
    actual.name !== expected.agentName
  )
    throw new Error("Herdr coordinator resource identity changed.");
  if (actual.cwd !== expected.cwd)
    throw new Error("Herdr coordinator cwd changed.");
}

function assertIdentity(expected: WorkerIdentity, actual: ParsedAgent): void {
  assertResource(expected, actual);
  if (!actual.sessionFile)
    throw new Error(
      "Herdr response omitted agent_session; native Pi session identity is not available.",
    );
  if (actual.sessionFile !== expected.sessionFile)
    throw new Error("Herdr native Pi session changed.");
}

function identityOf(
  expected: WorkerResourceIdentity,
  actual: ParsedAgent,
): WorkerIdentity {
  if (!actual.sessionFile)
    throw new Error(
      "Herdr response omitted agent_session; native Pi session identity is not available.",
    );
  return { ...expected, sessionFile: actual.sessionFile };
}
function coordinatorEnvironment(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (env.PI_CODING_AGENT_DIR)
    result.PI_CODING_AGENT_DIR = env.PI_CODING_AGENT_DIR;
  for (const key of [
    "PI_WORKGRAPH_MODE",
    "PI_WORKGRAPH_RUN_ID",
    "PI_WORKGRAPH_NODE_ID",
    "PI_WORKGRAPH_BASE_COMMIT",
    "PI_WORKGRAPH_EXPERIMENT",
    "PI_WORKGRAPH_IMPLEMENTATION_START",
    "PI_WORKGRAPH_EXECUTOR_MODEL",
    "PI_WORKGRAPH_EXECUTOR_THINKING",
  ])
    result[key] = "";
  return result;
}

function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const HERDR_AGENT_NAME_LIMIT = 32;
const IDENTITY_SUFFIX_LENGTH = 6;
const TAB_SUBJECT_LIMIT = 24;
const GENERIC_ASSIGNMENT_IDS = new Set([
  "assignment",
  "change",
  "implement",
  "implementation",
  "job",
  "node",
  "request",
  "research",
  "review",
  "task",
  "work",
  "worker",
]);

export function herdrWorkerName(request: WorkerNamingContext): string {
  if (!request.assignmentId && !request.objective && !request.role)
    return herdrAgentName(
      request.runId,
      request.nodeId ?? "worker",
      request.attemptId,
    );
  const role = request.role ?? "research";
  return readableIdentityName(
    readableSlug(workerSubject(request)) || "task",
    role,
    workerIdentity(request),
  );
}

/** Compatibility identity for workers launched by the first task-first release. */
export function legacyObjectiveHerdrWorkerName(
  request: WorkerNamingContext,
): string {
  const assignmentId = request.assignmentId ?? request.nodeId ?? "assignment";
  const objective = request.objective ?? request.nodeId ?? assignmentId;
  return readableIdentityName(
    readableSlug(objective) || readableSlug(assignmentId) || "task",
    request.role ?? "research",
    workerIdentity(request),
  );
}

export function herdrWorkerTabLabel(request: WorkerNamingContext): string {
  const role = request.role ?? "research";
  const suffix = identitySuffix(
    workerIdentity(request),
    IDENTITY_SUFFIX_LENGTH,
  );
  return `${bound(workerSubject(request), TAB_SUBJECT_LIMIT)} - ${role} - ${suffix}`;
}

export function herdrCoordinatorNames(request: CoordinatorLaunchRequest): {
  agentName: string;
  label: string;
} {
  const repository = readableSlug(basename(request.cwd)) || "repository";
  const repositoryLabel = readableLabel(basename(request.cwd)) || "Repository";
  const identity = `${request.sessionFile}\0${request.cwd}`;
  const suffix = identitySuffix(identity, IDENTITY_SUFFIX_LENGTH);
  const agentName = readableIdentityName(repository, "coordinator", identity);
  return {
    agentName,
    label: `${bound(repositoryLabel, TAB_SUBJECT_LIMIT)} - coordinator - ${suffix}`,
  };
}

function workerIdentity(request: WorkerNamingContext): string {
  const assignmentId = request.assignmentId ?? request.nodeId ?? "assignment";
  return `${request.runId}\0${assignmentId}\0${request.attemptId}`;
}

function workerSubject(request: WorkerNamingContext): string {
  const assignmentId = request.assignmentId ?? request.nodeId ?? "";
  const assignmentLabel = readableLabel(assignmentId);
  if (isDescriptiveAssignmentId(assignmentId, assignmentLabel))
    return sentenceCase(assignmentLabel);
  const objectiveLabel = readableLabel(request.objective ?? "");
  return objectiveLabel || assignmentLabel || "Task";
}

function isDescriptiveAssignmentId(id: string, label: string): boolean {
  if (!label || label.length > 48) return false;
  const normalized = id.trim().toLowerCase();
  if (GENERIC_ASSIGNMENT_IDS.has(normalized)) return false;
  if (/^[0-9a-f]{8,}$/i.test(normalized)) return false;
  if (
    /^(?:assignment|attempt|job|node|request|task|work|worker)[-_](?:\d+|[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f-]{19,})$/i.test(
      normalized,
    )
  )
    return false;
  return true;
}

function sentenceCase(value: string): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}

/** Compatibility identity for resources launched before task-first names. */
export function legacyHerdrAgentName(
  runId: string,
  nodeId: string,
  attemptId: string,
): string {
  const node = legacySlug(nodeId).slice(0, 12) || "worker";
  return `wg-${node}-${identitySuffix(`${runId}\0${nodeId}\0${attemptId}`, 12)}`;
}

/** @deprecated Use herdrWorkerName with assignment context for new launches. */
export function herdrAgentName(
  runId: string,
  nodeId: string,
  attemptId: string,
): string {
  return legacyHerdrAgentName(runId, nodeId, attemptId);
}

function readableIdentityName(
  subject: string,
  role: WorkerRole | "coordinator",
  identity: string,
): string {
  const suffix = identitySuffix(identity, IDENTITY_SUFFIX_LENGTH);
  const subjectLimit = HERDR_AGENT_NAME_LIMIT - role.length - suffix.length - 2;
  const boundedSubject = subject.slice(0, subjectLimit).replace(/-+$/g, "");
  return `${boundedSubject || "task"}-${role}-${suffix}`;
}

function identitySuffix(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function bound(value: string, limit: number): string {
  return value.slice(0, limit).replace(/[ -]+$/g, "");
}

function readableLabel(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .replace(/ +/g, " ");
}

function readableSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/g, "");
}

function legacySlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/g, "");
}

function object(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const result = value[key];
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error(`Herdr response omitted object ${key}.`);
  return result as Record<string, unknown>;
}

function string(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || !result)
    throw new Error(`Herdr response omitted string ${key}.`);
  return result;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const result = value[key];
  return typeof result === "string" && result ? result : undefined;
}

function isAgentStatus(value: string): value is HerdrAgentStatus {
  return (
    value === "idle" ||
    value === "working" ||
    value === "blocked" ||
    value === "done" ||
    value === "unknown"
  );
}

function parseSuccess(
  result: CommandResult,
  args: string[],
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `Herdr returned invalid JSON for ${args.slice(0, 2).join(" ")}.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || !("result" in parsed)) {
    throw new Error(
      `Herdr returned an invalid success response for ${args.slice(0, 2).join(" ")}.`,
    );
  }
  return parsed as Record<string, unknown>;
}

function isNotFound(
  result: CommandResult,
  expectedCode: "agent_not_found" | "pane_not_found" | "tab_not_found",
): boolean {
  for (const candidate of [result.stderr, result.stdout]) {
    try {
      const parsed = JSON.parse(candidate) as { error?: { code?: string } };
      if (parsed.error?.code === expectedCode) return true;
    } catch {}
  }
  return false;
}

function herdrError(args: string[], result: CommandResult): Error {
  let message = result.timedOut
    ? "command timed out"
    : result.stderr || result.stdout || `Herdr exited ${result.code}.`;
  for (const candidate of [result.stderr, result.stdout]) {
    try {
      const parsed = JSON.parse(candidate) as {
        error?: { code?: string; message?: string };
      };
      message =
        [parsed.error?.code, parsed.error?.message]
          .filter(Boolean)
          .join(": ") || message;
      if (parsed.error) break;
    } catch {}
  }
  return new Error(`herdr ${args.slice(0, 2).join(" ")} failed: ${message}`);
}

function spawnCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        code: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
      });
    });
  });
}
