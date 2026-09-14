import { createHash } from "node:crypto";

type WorkerRole = "consultation" | "experiment" | "implementation" | "research" | "review";

export interface WorkerNamingContext {
  readonly taskId: string;
  readonly attemptId: string;
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
  const suffix = identitySuffix(context);
  return `wg-${context.role}-${suffix}`.slice(0, AGENT_LIMIT);
}

export function herdrWorkerTabLabel(context: WorkerNamingContext): string {
  const prefix = `↳ [${ROLE_MARKER[context.role]}] `;
  const suffix = identitySuffix(context);
  const subject = words(context.taskId);
  const available = LABEL_LIMIT - prefix.length - suffix.length - 1;
  return `${prefix}${boundAtWord(subject, available) || "task"}-${suffix}`;
}

function identitySuffix(context: WorkerNamingContext): string {
  return createHash("sha256")
    .update(`${context.taskId}\0${context.attemptId}\0${context.role}`)
    .digest("hex")
    .slice(0, SUFFIX_LENGTH);
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
