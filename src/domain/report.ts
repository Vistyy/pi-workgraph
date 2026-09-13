import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const ReportStatusSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("escalated"),
  Type.Literal("failed"),
]);

const EvidenceSchema = Type.Object(
  {
    label: Type.String(),
    observation: Type.String(),
    class: Type.Optional(
      Type.Union([
        Type.Literal("direct"),
        Type.Literal("inference"),
        Type.Literal("conflict"),
        Type.Literal("unknown"),
      ]),
    ),
    command: Type.Optional(Type.String()),
    artifact: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const FindingSchema = Type.Object(
  {
    severity: Type.Union([
      Type.Literal("info"),
      Type.Literal("warning"),
      Type.Literal("error"),
      Type.Literal("blocker"),
    ]),
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
      status: ReportStatusSchema,
      ...ReportContentFields,
    },
    { additionalProperties: false },
  );
}

const ResearchReportSchema = readOnlyReportSchema("research");
const ReviewReportSchema = readOnlyReportSchema("review");
const ImplementationNoChangeReportSchema = Type.Object(
  {
    kind: Type.Literal("implementation"),
    status: Type.Literal("completed"),
    outcome: Type.Literal("no_change"),
    ...ReportContentFields,
    reason: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
const ImplementationIncompleteReportSchema = Type.Object(
  {
    kind: Type.Literal("implementation"),
    status: Type.Union([Type.Literal("escalated"), Type.Literal("failed")]),
    ...ReportContentFields,
  },
  { additionalProperties: false },
);
const ImplementationChangedInputSchema = Type.Object(
  {
    kind: Type.Literal("implementation"),
    status: Type.Literal("completed"),
    outcome: Type.Literal("changed"),
    ...ReportContentFields,
  },
  { additionalProperties: false },
);
const ImplementationChangedReportSchema = ImplementationChangedInputSchema;
const ImplementationReportInputSchema = Type.Union(
  [
    ImplementationChangedInputSchema,
    ImplementationNoChangeReportSchema,
    ImplementationIncompleteReportSchema,
  ],
  { type: "object" },
);
const ImplementationReportSchema = Type.Union(
  [
    ImplementationChangedReportSchema,
    ImplementationNoChangeReportSchema,
    ImplementationIncompleteReportSchema,
  ],
  { type: "object" },
);
const WorkerReportInputSchema = Type.Union([
  ResearchReportSchema,
  ReviewReportSchema,
  ImplementationReportInputSchema,
]);
export const WorkerReportSchema = Type.Union([
  ResearchReportSchema,
  ReviewReportSchema,
  ImplementationReportSchema,
]);

export type WorkerReportInput = Static<typeof WorkerReportInputSchema>;
export type WorkerReport = Static<typeof WorkerReportSchema>;
export type WorkerMode = WorkerReportInput["kind"];
export type WorkerSessionMode = WorkerMode;

export function reportSchemaForMode(mode: WorkerSessionMode) {
  switch (mode) {
    case "research":
      return ResearchReportSchema;
    case "review":
      return ReviewReportSchema;
    case "implementation":
      return ImplementationReportInputSchema;
  }
}

export function isWorkerReportInput(value: unknown): value is WorkerReportInput {
  return Value.Check(WorkerReportInputSchema, value);
}

export function isWorkerReport(value: unknown): value is WorkerReport {
  return Value.Check(WorkerReportSchema, value);
}
