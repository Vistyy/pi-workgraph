import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const playbookDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..", "playbooks");

export const PLAYBOOKS = [
  { id: "investigation", title: "Investigation", family: "understand", summary: "Answer a bounded read-only question from decisive evidence.", steps: ["frame", "trace", "investigate", "reconcile", "report"] },
  { id: "runtime-forensics", title: "Runtime forensics", family: "understand", summary: "Diagnose a live runtime symptom before proposing a fix.", steps: ["capture", "reduce", "perturb", "map", "report"] },
  { id: "trace-forensics", title: "Trace forensics", family: "understand", summary: "Explain a fixed trace, profile, or snapshot.", steps: ["identify", "transform", "narrow", "resolve", "report"] },
  { id: "prototype", title: "Prototype", family: "decide", summary: "Resolve an empirical design question with throwaway evidence.", steps: ["decision", "build", "compare", "observe", "recommend"] },
  { id: "architecture", title: "Architecture", family: "decide", summary: "Choose ownership and interface boundaries before implementation.", steps: ["ground", "sketch", "compare", "judge", "select"] },
  { id: "arena", title: "Arena", family: "decide", summary: "Compare independent attempts at the same artifact.", steps: ["criteria", "fanout", "account", "judge", "select"] },
  { id: "eval", title: "Eval", family: "decide", summary: "Measure behavior differences between agent or instruction variants.", steps: ["rubric", "sanitize", "run", "judge", "inspect"] },
  { id: "bug-fix", title: "Bug fix", family: "change", summary: "Reproduce, diagnose, correct, and retest a defect.", steps: ["reproduce", "diagnose", "design", "implement", "verify"] },
  { id: "feature", title: "Feature", family: "change", summary: "Add a complete behavior through explicit design and verification.", steps: ["understand", "design", "decompose", "implement", "verify"] },
  { id: "refactoring", title: "Refactoring", family: "change", summary: "Simplify structure while proving supported behavior remains stable.", steps: ["baseline", "target", "subtract", "migrate", "prove"] },
  { id: "performance", title: "Performance", family: "change", summary: "Improve a measured cost through one confirmed mechanism.", steps: ["baseline", "trace", "hypothesize", "change", "compare"] },
  { id: "visual-parity", title: "Visual parity", family: "change", summary: "Match visual behavior against an untouched baseline.", steps: ["baseline", "separate", "implement", "compare", "interact"] },
  { id: "autonomous-run", title: "Autonomous run", family: "operate", summary: "Drive one bounded task to a checkable exit condition.", steps: ["predicate", "execute", "verify", "record", "stop"] },
  { id: "pause-safely", title: "Pause safely", family: "operate", summary: "Make interrupted work durable and unambiguous to resume.", steps: ["settle", "stop", "persist", "record", "pause"] },
  { id: "session-pickup", title: "Session pickup", family: "operate", summary: "Reconcile and continue a prior durable run.", steps: ["read", "reconcile", "separate", "route", "verify"] },
  { id: "figure-it-out", title: "Figure it out", family: "operate", summary: "Construct a bounded workflow when no narrower playbook fits.", steps: ["predicate", "design", "experiment", "record", "verify"] },
] as const;

export type PlaybookId = (typeof PLAYBOOKS)[number]["id"];
export type PlaybookFamily = (typeof PLAYBOOKS)[number]["family"];
export type PlaybookDefinition = (typeof PLAYBOOKS)[number];

export function listPlaybooks(): Array<{ id: PlaybookId; title: string; family: PlaybookFamily; summary: string }> {
  return PLAYBOOKS.map(({ id, title, family, summary }) => ({ id, title, family, summary }));
}

export function getPlaybook(id: string): PlaybookDefinition {
  const playbook = PLAYBOOKS.find((candidate) => candidate.id === id);
  if (!playbook) throw new Error(`Unknown Workgraph playbook: ${id}`);
  return playbook;
}

export async function loadPlaybook(id: string): Promise<{ definition: PlaybookDefinition; content: string }> {
  const definition = getPlaybook(id);
  const content = await readFile(resolve(playbookDirectory, `${definition.id}.md`), "utf8");
  return { definition, content };
}
