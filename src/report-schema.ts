import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { WorkerMode, WorkerReport } from "./types.js";

export const EvidenceSchema = Type.Object({
  label: Type.String(),
  observation: Type.String(),
  class: Type.Optional(
    StringEnum(["direct", "inference", "conflict", "unknown"] as const),
  ),
  command: Type.Optional(Type.String()),
  artifact: Type.Optional(Type.String()),
});
const FindingSchema = Type.Object({
  severity: StringEnum(["info", "warning", "error", "blocker"] as const),
  title: Type.String(),
  detail: Type.String(),
  envelopeImpact: StringEnum([
    "none",
    "outcome",
    "non_goal",
    "owner",
    "public_interface",
    "dependency",
    "security",
    "scale",
    "reuse",
  ] as const),
});
const ReportFields = {
  status: StringEnum(["completed", "escalated", "failed"] as const),
  summary: Type.String(),
  uncertainty: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
  evidence: Type.Array(EvidenceSchema, { maxItems: 20 }),
  findings: Type.Array(FindingSchema, { maxItems: 20 }),
};
const ResearchReportSchema = Type.Object({
  kind: Type.Literal("research"),
  ...ReportFields,
});
const ReviewReportSchema = Type.Object({
  kind: Type.Literal("review"),
  ...ReportFields,
});
export const ImplementationReportSchema = Type.Object({
  kind: Type.Literal("implementation"),
  ...ReportFields,
  commit: Type.Optional(Type.String()),
  changedFiles: Type.Optional(Type.Array(Type.String())),
});
export const WorkerReportSchema = Type.Union([
  ResearchReportSchema,
  ReviewReportSchema,
  ImplementationReportSchema,
]);

export function reportSchemaForMode(mode: WorkerMode) {
  switch (mode) {
    case "research":
      return ResearchReportSchema;
    case "review":
      return ReviewReportSchema;
    case "implementation":
      return ImplementationReportSchema;
  }
}

export function isWorkerReport(value: unknown): value is WorkerReport {
  return Value.Check(WorkerReportSchema, value);
}
