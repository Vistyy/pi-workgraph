import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const NonBlankText = Type.String({ minLength: 1, pattern: "\\S" });

const ReportStatusSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("needs_decision"),
  Type.Literal("failed"),
]);

const ReadOnlyOrExperimentRoleSchema = Type.Union([
  Type.Literal("research"),
  Type.Literal("experiment"),
  Type.Literal("consultation"),
  Type.Literal("review"),
]);

const WorkerRoleSchema = Type.Union([
  ReadOnlyOrExperimentRoleSchema,
  Type.Literal("implementation"),
]);

const NarrativeFields = {
  status: ReportStatusSchema,
  summary: NonBlankText,
  details: NonBlankText,
};

const NarrativeInputSchema = Type.Object(NarrativeFields, { additionalProperties: false });

const ImplementationCompletedInputSchema = Type.Object(
  {
    status: Type.Literal("completed"),
    outcome: Type.Union([Type.Literal("changed"), Type.Literal("no_change")]),
    summary: NonBlankText,
    details: NonBlankText,
  },
  { additionalProperties: false },
);

const ImplementationIncompleteInputSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("needs_decision"), Type.Literal("failed")]),
    summary: NonBlankText,
    details: NonBlankText,
  },
  { additionalProperties: false },
);

const ImplementationReportInputSchema = Type.Union(
  [ImplementationCompletedInputSchema, ImplementationIncompleteInputSchema],
  { type: "object" },
);

const WorkerReportInputSchema = Type.Union(
  [NarrativeInputSchema, ImplementationReportInputSchema],
  { type: "object" },
);

export const WorkerReportSchema = Type.Union(
  [
    Type.Object(
      { role: ReadOnlyOrExperimentRoleSchema, ...NarrativeFields },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        role: Type.Literal("implementation"),
        status: Type.Literal("completed"),
        outcome: Type.Union([Type.Literal("changed"), Type.Literal("no_change")]),
        summary: NonBlankText,
        details: NonBlankText,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        role: Type.Literal("implementation"),
        status: Type.Union([Type.Literal("needs_decision"), Type.Literal("failed")]),
        summary: NonBlankText,
        details: NonBlankText,
      },
      { additionalProperties: false },
    ),
  ],
  { type: "object" },
);

export type WorkerReportInput = Static<typeof WorkerReportInputSchema>;

export type WorkerReport = Static<typeof WorkerReportSchema>;

type WorkerRole = Static<typeof WorkerRoleSchema>;

export type WorkerSessionMode = WorkerRole;

export function reportSchemaForMode(mode: WorkerSessionMode) {
  return mode === "implementation" ? ImplementationReportInputSchema : NarrativeInputSchema;
}

export function isWorkerReport(value: unknown): value is WorkerReport {
  return Value.Check(WorkerReportSchema, value);
}
