import { posix } from "node:path";
import type { NodeState, WorkNode, WorkNodeSpec, WorkgraphRun } from "./types.js";

const NODE_TRANSITIONS: Record<NodeState, readonly NodeState[]> = {
  pending: ["running", "failed", "cancelled"],
  running: ["completed", "escalated", "failed", "cancelled"],
  completed: ["composed", "failed"],
  composed: [],
  escalated: ["superseded"],
  failed: ["superseded"],
  cancelled: ["superseded"],
  superseded: [],
};

export function addNodes(run: WorkgraphRun, specs: WorkNodeSpec[]): WorkNode[] {
  if (specs.length === 0) throw new Error("At least one work node is required.");
  const existingIds = new Set(run.nodes.map((node) => node.id));
  const incomingIds = new Set<string>();
  for (const spec of specs) {
    validateNodeSpec(spec);
    if (existingIds.has(spec.id) || incomingIds.has(spec.id)) {
      throw new Error(`Duplicate work node id: ${spec.id}`);
    }
    incomingIds.add(spec.id);
  }

  const allIds = new Set([...existingIds, ...incomingIds]);
  const replacements = new Map<string, string>();
  for (const spec of specs) {
    for (const supersededId of spec.supersedes) {
      if (replacements.has(supersededId)) throw new Error(`Work node ${supersededId} has more than one replacement.`);
      const superseded = run.nodes.find((node) => node.id === supersededId);
      if (!superseded) throw new Error(`Work node ${spec.id} cannot supersede unknown node ${supersededId}.`);
      if (superseded.state !== "failed" && superseded.state !== "escalated" && superseded.state !== "cancelled") {
        throw new Error(`Work node ${spec.id} can only supersede a failed, escalated, or cancelled node, not ${supersededId} in ${superseded.state}.`);
      }
      replacements.set(supersededId, spec.id);
    }
  }
  for (const spec of specs) {
    for (const originalDependency of spec.dependencies) {
      const dependency = replacements.get(originalDependency) ?? originalDependency;
      if (!allIds.has(dependency)) {
        throw new Error(`Work node ${spec.id} has unknown dependency ${dependency}.`);
      }
      if (dependency === spec.id) {
        throw new Error(`Work node ${spec.id} cannot depend on itself or a node it supersedes.`);
      }
    }
    if (spec.continuationOf) {
      const original = run.nodes.find((node) => node.id === spec.continuationOf);
      if (!original) throw new Error(`Work node ${spec.id} cannot continue unknown node ${spec.continuationOf}.`);
      if (original.state !== "composed" || !original.sessionFile) {
        throw new Error(`Work node ${spec.id} can only continue a composed node with a retained session.`);
      }
    }
  }

  for (const node of run.nodes) {
    if (node.state !== "pending") continue;
    node.dependencies = node.dependencies.map((dependency) => replacements.get(dependency) ?? dependency);
  }
  const nodes = specs.map<WorkNode>((spec) => ({
    ...spec,
    brief: {
      ...spec.brief,
      context: [...spec.brief.context],
      acceptance: [...spec.brief.acceptance],
      forbidden: [...spec.brief.forbidden],
    },
    claimedPaths: spec.claimedPaths.map(normalizeClaim),
    dependencies: [...new Set(spec.dependencies.map((dependency) => replacements.get(dependency) ?? dependency))],
    verificationCommands: [...spec.verificationCommands],
    supersedes: [...new Set(spec.supersedes)],
    state: "pending",
  }));
  for (const [supersededId, replacementId] of replacements) {
    const superseded = run.nodes.find((node) => node.id === supersededId)!;
    transitionNode(superseded, "superseded");
    superseded.supersededBy = replacementId;
  }
  assertAcyclic([...run.nodes, ...nodes]);
  run.nodes.push(...nodes);
  return nodes;
}

export function readyWave(run: WorkgraphRun, maxConcurrency: number): WorkNode[] {
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error("maxConcurrency must be a positive integer.");
  }
  const byId = new Map(run.nodes.map((node) => [node.id, node]));
  const candidates = run.nodes
    .filter((node) => node.state === "pending")
    .filter((node) => node.dependencies.every((dependency) => byId.get(dependency)?.state === "composed"))
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id));

  const selected: WorkNode[] = [];
  for (const candidate of candidates) {
    if (selected.length >= maxConcurrency) break;
    if (selected.some((other) => claimsOverlap(candidate.claimedPaths, other.claimedPaths))) continue;
    selected.push(candidate);
  }
  return selected;
}

export function blockedPendingNodes(run: WorkgraphRun): WorkNode[] {
  const byId = new Map(run.nodes.map((node) => [node.id, node]));
  return run.nodes.filter((node) => node.state === "pending" && node.dependencies.some((dependency) => {
    const state = byId.get(dependency)?.state;
    return state === "failed" || state === "escalated";
  }));
}

export function transitionNode(node: WorkNode, next: NodeState): void {
  if (node.state === next) return;
  if (!NODE_TRANSITIONS[node.state].includes(next)) {
    throw new Error(`Invalid work node transition ${node.id}: ${node.state} -> ${next}.`);
  }
  node.state = next;
}

export function claimsOverlap(left: string[], right: string[]): boolean {
  return left.some((leftClaim) => right.some((rightClaim) => claimContains(leftClaim, rightClaim) || claimContains(rightClaim, leftClaim)));
}

export function allNodesComposed(run: WorkgraphRun): boolean {
  return run.nodes.length > 0 && run.nodes.every((node) => node.state === "composed" || node.state === "superseded");
}

function claimContains(parent: string, child: string): boolean {
  return parent === "." || parent === child || child.startsWith(`${parent}/`);
}

function validateNodeSpec(spec: WorkNodeSpec): void {
  if (!/^[a-z][a-z0-9_-]{0,47}$/.test(spec.id)) {
    throw new Error(`Work node id must match [a-z][a-z0-9_-]{0,47}: ${spec.id}`);
  }
  if (!spec.brief.goal.trim()) throw new Error(`Work node ${spec.id} requires a goal.`);
  if (spec.priority !== undefined && (!Number.isSafeInteger(spec.priority) || spec.priority < -1000 || spec.priority > 1000)) {
    throw new Error(`Work node ${spec.id} priority must be an integer from -1000 through 1000.`);
  }
  if (spec.brief.acceptance.length === 0 || spec.brief.acceptance.some((item) => !item.trim())) {
    throw new Error(`Work node ${spec.id} requires concrete acceptance conditions.`);
  }
  if (!Number.isSafeInteger(spec.brief.timeboxMinutes) || spec.brief.timeboxMinutes < 1) {
    throw new Error(`Work node ${spec.id} requires a positive timeboxMinutes value.`);
  }
  if (!spec.brief.report.trim()) throw new Error(`Work node ${spec.id} requires a report contract.`);
  if (spec.claimedPaths.length === 0) throw new Error(`Work node ${spec.id} requires at least one claimed path.`);
  for (const claim of spec.claimedPaths) normalizeClaim(claim);
  if (!spec.guideModel.includes("/")) throw new Error(`Work node ${spec.id} guideModel must be provider/model.`);
  if (!spec.executorModel.includes("/")) throw new Error(`Work node ${spec.id} executorModel must be provider/model.`);
}

function normalizeClaim(value: string): string {
  const slashPath = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  const normalized = posix.normalize(slashPath || ".");
  if (normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized)) {
    throw new Error(`Claimed path must stay within the repository: ${value}`);
  }
  if (/[*?{}[\]]/.test(normalized)) {
    throw new Error(`Claimed paths are prefixes, not glob patterns: ${value}`);
  }
  return normalized;
}

function assertAcyclic(nodes: WorkNode[]): void {
  const dependencies = new Map(nodes.map((node) => [node.id, node.dependencies]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Work graph contains a cycle at ${id}.`);
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };

  for (const node of nodes) visit(node.id);
}
