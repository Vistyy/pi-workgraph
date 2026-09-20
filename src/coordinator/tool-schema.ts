import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  AssignmentContextSchema,
  ExpectedEvidenceSchema,
  TaskIdSchema,
} from "../domain/records.js";
import { SelectionRequestSchema } from "./model-policy.js";

export const Text = Type.String({ minLength: 1, pattern: "\\S" });

export const nonBlank = (description: string) =>
  Type.String({ minLength: 1, pattern: "\\S", description });

export const CandidateOf = Type.Optional(
  Type.Object(
    {
      attemptId: nonBlank("Parent Candidate Attempt ID."),
      mode: StringEnum(["extend", "integrate"] as const, {
        description:
          "extend starts at the parent Candidate; integrate starts at the destination and incorporates it.",
      }),
    },
    { additionalProperties: false, description: "Optional parent Candidate relationship." },
  ),
);

export const Selection = Type.Optional(SelectionRequestSchema);

export const Context = Type.Optional(AssignmentContextSchema);

export const ExpectedEvidence = Type.Optional(ExpectedEvidenceSchema);

export const TaskFields = {
  id: TaskIdSchema,
  cwd: Type.Optional(
    nonBlank(
      "Read-only starting directory, Experiment repository seed, or Implementation destination; defaults to session cwd and grants no authority.",
    ),
  ),
};

export const PageFields = {
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based result offset." })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 100, description: "Maximum records to return." }),
  ),
};
