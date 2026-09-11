import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const EvidenceSchema = Type.Object(
  {
    label: Type.String(),
    observation: Type.String(),
    class: Type.Optional(StringEnum(["direct", "inference", "conflict", "unknown"] as const)),
    command: Type.Optional(Type.String()),
    artifact: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const FindingSchema = Type.Object(
  {
    severity: StringEnum(["info", "warning", "error", "blocker"] as const),
    title: Type.String(),
    detail: Type.String(),
  },
  { additionalProperties: false },
);
const ReportContentFields = {
  summary: Type.String(),
  uncertainty: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
  evidence: Type.Array(EvidenceSchema, { maxItems: 20 }),
  findings: Type.Array(FindingSchema, { maxItems: 20 }),
};

function readOnlyReportSchema<const Kind extends "research" | "review">(kind: Kind) {
  return Type.Object(
    {
      kind: Type.Literal(kind),
      status: StringEnum(["completed", "escalated", "failed"] as const),
      ...ReportContentFields,
    },
    { additionalProperties: false },
  );
}

const ResearchReportSchema = readOnlyReportSchema("research");
const ReviewReportSchema = readOnlyReportSchema("review");
const ImplementationReportSchema = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Literal("implementation"),
        status: Type.Literal("completed"),
        outcome: Type.Literal("changed"),
        ...ReportContentFields,
        commit: Type.Optional(Type.String()),
        changedFiles: Type.Optional(Type.Array(Type.String())),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("implementation"),
        status: Type.Literal("completed"),
        outcome: Type.Literal("no_change"),
        ...ReportContentFields,
        revision: Type.String({ pattern: "^[0-9a-f]{40,64}$" }),
        reason: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("implementation"),
        status: StringEnum(["escalated", "failed"] as const),
        ...ReportContentFields,
      },
      { additionalProperties: false },
    ),
  ],
  { type: "object" },
);
export const WorkerReportSchema = Type.Union([
  ResearchReportSchema,
  ReviewReportSchema,
  ImplementationReportSchema,
]);

export type WorkerReport = Static<typeof WorkerReportSchema>;
export type ImplementationReport = Static<typeof ImplementationReportSchema>;
export type WorkerMode = WorkerReport["kind"];
export type WorkerSessionMode = WorkerMode;

export function reportSchemaForMode(mode: WorkerSessionMode) {
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
