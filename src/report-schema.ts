import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { WorkerReport, WorkerReportInput, WorkerSessionMode } from "./types.js";

const EvidenceFields = {
  label: Type.String(),
  observation: Type.String(),
  class: Type.Optional(StringEnum(["direct", "inference", "conflict", "unknown"] as const)),
  command: Type.Optional(Type.String()),
  artifact: Type.Optional(Type.String()),
};
const FindingFields = {
  severity: StringEnum(["info", "warning", "error", "blocker"] as const),
  title: Type.String(),
  detail: Type.String(),
};

// Retained reports were historically decoded with open nested evidence and finding objects.
export const EvidenceSchema = Type.Object(EvidenceFields, { additionalProperties: true });
const FindingSchema = Type.Object(FindingFields, { additionalProperties: true });
const StrictEvidenceSchema = Type.Object(EvidenceFields, { additionalProperties: false });
const StrictFindingSchema = Type.Object(FindingFields, { additionalProperties: false });

function reportContentFields(evidence: typeof EvidenceSchema, finding: typeof FindingSchema) {
  return {
    summary: Type.String(),
    uncertainty: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
    evidence: Type.Array(evidence, { maxItems: 20 }),
    findings: Type.Array(finding, { maxItems: 20 }),
  };
}

const LegacyReportContentFields = reportContentFields(EvidenceSchema, FindingSchema);
const StrictReportContentFields = reportContentFields(StrictEvidenceSchema, StrictFindingSchema);

type ReportContentFields = typeof LegacyReportContentFields;

function readOnlyReportSchema<const Kind extends "research" | "review">(
  kind: Kind,
  content: ReportContentFields,
  additionalProperties: boolean,
) {
  return Type.Object(
    {
      kind: Type.Literal(kind),
      status: StringEnum(["completed", "escalated", "failed"] as const),
      ...content,
    },
    { additionalProperties },
  );
}

function implementationReportSchema(content: ReportContentFields) {
  return Type.Union([
    Type.Object(
      {
        kind: Type.Literal("implementation"),
        status: Type.Literal("completed"),
        outcome: Type.Literal("changed"),
        ...content,
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
        ...content,
        revision: Type.String({ pattern: "^[0-9a-f]{40,64}$" }),
        reason: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("implementation"),
        status: StringEnum(["escalated", "failed"] as const),
        ...content,
      },
      { additionalProperties: false },
    ),
  ]);
}

// These schemas decode retained reports and preserve fields accepted by the old contracts.
const ResearchReportSchema = readOnlyReportSchema("research", LegacyReportContentFields, true);
const ReviewReportSchema = readOnlyReportSchema("review", LegacyReportContentFields, true);
const ConsultationReportSchemaInternal = Type.Object(
  {
    kind: Type.Literal("consultation"),
    status: StringEnum(["completed", "escalated", "failed"] as const),
    text: Type.String({ minLength: 1, maxLength: 100_000 }),
    ...LegacyReportContentFields,
  },
  { additionalProperties: true },
);
const EnrichmentEvidenceSchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 500 }),
    observation: Type.String({ minLength: 1, maxLength: 10_000 }),
    class: Type.Optional(StringEnum(["direct", "inference", "conflict", "unknown"] as const)),
    command: Type.Optional(Type.String({ maxLength: 4_000 })),
    artifact: Type.Optional(Type.String({ maxLength: 2_000 })),
  },
  { additionalProperties: false },
);
export const EnrichmentPacketSchema = Type.Object(
  {
    sourceObservations: Type.Array(EnrichmentEvidenceSchema, { minItems: 1, maxItems: 20 }),
    counterevidence: Type.Array(EnrichmentEvidenceSchema, { maxItems: 20 }),
    gaps: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 20 }),
    localState: Type.Object(
      {
        repository: Type.String({ minLength: 1, maxLength: 1000 }),
        revision: Type.String({ minLength: 1, maxLength: 128 }),
        workingTree: Type.String({ minLength: 1, maxLength: 4000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const ConsultationReportSchema = ConsultationReportSchemaInternal;
export const ImplementationReportSchema = implementationReportSchema(LegacyReportContentFields);
export const WorkerReportSchema = Type.Union([
  ResearchReportSchema,
  ReviewReportSchema,
  ConsultationReportSchemaInternal,
  ImplementationReportSchema,
]);

// These schemas exclusively own new worker tool input and reject every undeclared field.
const ResearchReportInputSchema = readOnlyReportSchema(
  "research",
  StrictReportContentFields,
  false,
);
const ReviewReportInputSchema = readOnlyReportSchema("review", StrictReportContentFields, false);
const ConsultationReportInputSchema = Type.Object(
  {
    kind: Type.Literal("consultation"),
    status: StringEnum(["completed", "escalated", "failed"] as const),
    text: Type.String({ minLength: 1, maxLength: 100_000 }),
    ...StrictReportContentFields,
  },
  { additionalProperties: false },
);
const ImplementationReportInputSchema = implementationReportSchema(StrictReportContentFields);
export const WorkerReportInputSchema = Type.Union([
  ResearchReportInputSchema,
  ReviewReportInputSchema,
  ConsultationReportInputSchema,
  ImplementationReportInputSchema,
]);

export function reportSchemaForMode(mode: WorkerSessionMode) {
  switch (mode) {
    case "research":
      return ResearchReportInputSchema;
    case "review":
      return ReviewReportInputSchema;
    case "implementation":
      return ImplementationReportInputSchema;
    case "consultation":
      return ConsultationReportInputSchema;
    case "consultation_enricher":
      return EnrichmentPacketSchema;
  }
}

export function isWorkerReport(value: unknown): value is WorkerReport {
  return Value.Check(WorkerReportSchema, value);
}

export function isWorkerReportInput(value: unknown): value is WorkerReportInput {
  return Value.Check(WorkerReportInputSchema, value);
}
