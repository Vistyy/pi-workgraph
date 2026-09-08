import { createHash } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Herdr names are derived from the host repository path.
import { basename } from "node:path";

export type WorkerRole =
  | "implement"
  | "research"
  | "review"
  | "consultation"
  | "consultation_enricher";

export interface WorkerNamingContext {
  runId: string;
  nodeId?: string;
  attemptId: string;
  assignmentId?: string;
  objective?: string;
  role?: WorkerRole;
}

export interface CoordinatorNamingContext {
  cwd: string;
  sessionFile: string;
}

const HERDR_AGENT_NAME_LIMIT = 32;
const IDENTITY_SUFFIX_LENGTH = 6;
const WORKER_TAB_LABEL_LIMIT = 18;
const WORKER_TAB_PREFIX = "↳ ";
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
  const role = request.role ?? "research";
  return readableIdentityName(
    readableSlug(workerSubject(request)) || "task",
    role,
    workerIdentity(request),
  );
}

export function herdrWorkerTabLabel(request: WorkerNamingContext): string {
  const subject = boundAtWord(
    workerSubject(request),
    WORKER_TAB_LABEL_LIMIT - WORKER_TAB_PREFIX.length,
  );
  return `${WORKER_TAB_PREFIX}${subject}`;
}

export function herdrCoordinatorNames(request: CoordinatorNamingContext) {
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
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
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

function boundAtWord(value: string, limit: number): string {
  const bounded = bound(value, limit);
  if (value.length <= limit) return bounded;
  const boundary = bounded.lastIndexOf(" ");
  return boundary > 0 ? bounded.slice(0, boundary) : bounded;
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
