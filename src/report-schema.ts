import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { WorkerMode, WorkerReport } from "./types.js";

const StatusSchema = StringEnum(["completed", "escalated", "failed"] as const);
const EnvelopeImpactSchema = StringEnum([
  "none",
  "outcome",
  "non_goal",
  "owner",
  "public_interface",
  "dependency",
  "security",
  "scale",
  "reuse",
] as const);

export const EvidenceSchema = Type.Object({
  label: Type.String(),
  observation: Type.String(),
  class: Type.Optional(StringEnum(["direct", "inference", "conflict", "unknown"] as const)),
  command: Type.Optional(Type.String()),
  artifact: Type.Optional(Type.String()),
});

export const FindingSchema = Type.Object({
  severity: StringEnum(["info", "warning", "error", "blocker"] as const),
  title: Type.String(),
  detail: Type.String(),
  envelopeImpact: EnvelopeImpactSchema,
});

export const AssuranceFindingSchema = Type.Object({
  id: Type.String(),
  category: Type.String(),
  violatedInvariant: Type.String(),
  evidence: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
  reachableScenario: Type.String(),
  consequence: Type.String(),
  simplestResponse: Type.String(),
  complexityEffect: StringEnum(["reduces", "neutral", "adds"] as const),
  confidence: StringEnum(["low", "medium", "high"] as const),
  envelopeImpact: EnvelopeImpactSchema,
  ownerNodeId: Type.Optional(Type.String()),
});

export const DiscoveryReportSchema = Type.Object({
  kind: Type.Literal("discovery"),
  status: StatusSchema,
  summary: Type.String(),
  evidence: Type.Array(EvidenceSchema, { maxItems: 20 }),
  findings: Type.Array(FindingSchema, { maxItems: 20 }),
});

export const ReviewReportSchema = Type.Object({
  kind: Type.Literal("review"),
  status: StatusSchema,
  summary: Type.String(),
  evidence: Type.Array(EvidenceSchema, { maxItems: 20 }),
  findings: Type.Array(FindingSchema, { maxItems: 20 }),
});

export const ImplementationReportSchema = Type.Object({
  kind: Type.Literal("implementation"),
  status: StatusSchema,
  summary: Type.String(),
  evidence: Type.Array(EvidenceSchema, { maxItems: 20 }),
  findings: Type.Array(FindingSchema, { maxItems: 20 }),
  commit: Type.Optional(Type.String()),
  changedFiles: Type.Optional(Type.Array(Type.String())),
});

export const VerificationReportSchema = Type.Object({
  kind: Type.Literal("verification"),
  status: StatusSchema,
  summary: Type.String(),
  evidence: Type.Array(EvidenceSchema, { maxItems: 30 }),
  verdict: StringEnum(["verified", "failed", "inconclusive"] as const),
  findings: Type.Array(FindingSchema, { maxItems: 20 }),
});

export const AssuranceReviewReportSchema = Type.Object({
  kind: Type.Literal("assurance_review"),
  status: StatusSchema,
  summary: Type.String(),
  evidence: Type.Array(EvidenceSchema, { maxItems: 20 }),
  responsibility: StringEnum(["behavior", "structure", "evidence"] as const),
  recommendation: StringEnum(["approve", "changes_required", "inconclusive"] as const),
  findings: Type.Array(AssuranceFindingSchema, { maxItems: 20 }),
});

export const AssuranceSynthesisReportSchema = Type.Object({
  kind: Type.Literal("assurance_synthesis"),
  status: StatusSchema,
  summary: Type.String(),
  evidence: Type.Array(EvidenceSchema, { maxItems: 20 }),
  verdict: StringEnum(["approve", "revision_required", "needs_decision", "inconclusive"] as const),
  dispositions: Type.Array(Type.Object({
    finding: AssuranceFindingSchema,
    disposition: StringEnum(["accept", "optional", "dismiss"] as const),
    reason: Type.String(),
  }), { maxItems: 40 }),
});

export const WorkerReportSchema = Type.Union([
  DiscoveryReportSchema,
  ReviewReportSchema,
  ImplementationReportSchema,
  VerificationReportSchema,
  AssuranceReviewReportSchema,
  AssuranceSynthesisReportSchema,
]);

export function reportSchemaForMode(mode: WorkerMode) {
  switch (mode) {
    case "discovery": return DiscoveryReportSchema;
    case "review": return ReviewReportSchema;
    case "implementation": return ImplementationReportSchema;
    case "verification": return VerificationReportSchema;
    case "assurance_review": return AssuranceReviewReportSchema;
    case "assurance_synthesis": return AssuranceSynthesisReportSchema;
  }
}

export function isWorkerReport(value: unknown): value is WorkerReport {
  return Value.Check(WorkerReportSchema, value);
}
