import { createHash } from "node:crypto";

export type WorkerRole = "consultation" | "experiment" | "implementation" | "research" | "review";

export interface WorkerNamingContext {
  readonly taskId: string;
  readonly attemptId: string;
  readonly objective: string;
  readonly role: WorkerRole;
}

const AGENT_LIMIT = 32;
const LABEL_LIMIT = 18;
const SUFFIX_LENGTH = 6;
const ROLE_MARKER: Record<WorkerRole, string> = {
  consultation: "C",
  experiment: "E",
  implementation: "I",
  research: "R",
  review: "V",
};

export function herdrWorkerName(context: WorkerNamingContext): string {
  const role = context.role === "implementation" ? "implement" : context.role;
  const suffix = identitySuffix(context);
  const subject = slug(subjectOf(context)) || "task";
  const available = AGENT_LIMIT - role.length - suffix.length - 2;
  return `${subject.slice(0, available).replace(/-+$/g, "") || "task"}-${role}-${suffix}`;
}

export function herdrWorkerTabLabel(context: WorkerNamingContext): string {
  const prefix = `↳ [${ROLE_MARKER[context.role]}] `;
  const suffix = identitySuffix(context);
  const subject = words(subjectOf(context));
  const available = LABEL_LIMIT - prefix.length - suffix.length - 1;
  return `${prefix}${boundAtWord(subject, available) || "task"}-${suffix}`;
}

function identitySuffix(context: WorkerNamingContext): string {
  return createHash("sha256")
    .update(`${context.taskId}\0${context.attemptId}\0${context.role}`)
    .digest("hex")
    .slice(0, SUFFIX_LENGTH);
}

function subjectOf(context: WorkerNamingContext): string {
  const task = words(context.taskId);
  return descriptiveTaskId(context.taskId, task) ? task : words(context.objective) || task;
}

function descriptiveTaskId(id: string, label: string): boolean {
  if (!label || label.length > 48) return false;
  return !/^(?:attempt|job|request|task|work|worker)(?:[-_](?:\d+|[0-9a-f-]{8,}))?$/i.test(id);
}

function boundAtWord(value: string, limit: number): string {
  const bounded = value.slice(0, limit).replace(/[ -]+$/g, "");
  if (value.length <= limit) return bounded;
  const boundary = bounded.lastIndexOf(" ");
  return boundary > 0 ? bounded.slice(0, boundary) : bounded;
}

function words(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .replace(/ +/g, " ");
}

function slug(value: string): string {
  return words(value)
    .toLowerCase()
    .replace(/ +/g, "-")
    .replace(/^[^a-z]+/, "");
}
