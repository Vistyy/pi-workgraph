import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { CommitSchema, ReviewSubjectSchema, TaskIdSchema } from "../domain/records.js";
import { MODEL_LIST_ROLES, SelectionRequestSchema } from "./model-policy.js";

const Text = Type.String({ minLength: 1, pattern: "\\S" });

const nonBlank = (description: string) =>
  Type.String({ minLength: 1, pattern: "\\S", description });

const CandidateOf = Type.Optional(
  Type.Object(
    {
      attemptId: nonBlank("Exact parent Attempt ID."),
      mode: StringEnum(["extend", "integrate"] as const, {
        description:
          "extend continues from the parent's Candidate; integrate starts from the destination and includes the parent's retained output.",
      }),
    },
    { additionalProperties: false },
  ),
);

const Selection = Type.Optional(SelectionRequestSchema);

const TaskFields = {
  id: TaskIdSchema,
  cwd: Type.Optional(nonBlank("Directory or repository that owns the Task target.")),
};

const PageFields = {
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based result offset." })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 100, description: "Maximum records to return." }),
  ),
};

export const ModelsParameters = Type.Object(
  {
    role: StringEnum(MODEL_LIST_ROLES, {
      description: "Configured role whose exact model targets should be listed.",
    }),
  },
  { additionalProperties: false },
);

export const CheckoutParameters = Type.Union([
  Type.Object(
    {
      action: Type.Literal("create", {
        description:
          "Create or reuse this repository's checkout from committed HEAD; leave destination working files untouched.",
      }),
      cwd: Type.Optional(nonBlank("Destination checkout; defaults to the session cwd.")),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("inspect", {
        description: "Validate and report one exact recorded checkout.",
      }),
      checkoutId: TaskIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("list", {
        description: "List this session's checkouts and report blocked records individually.",
      }),
      ...PageFields,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("apply", {
        description:
          "Integrate clean committed work into the recorded clean local destination, then release exact owned resources.",
      }),
      checkoutId: TaskIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("discard", {
        description: "Destructively remove the verified managed checkout and branch.",
      }),
      checkoutId: TaskIdSchema,
      reason: nonBlank("Why the checkout is being discarded."),
    },
    { additionalProperties: false },
  ),
]);

export const ResearchParameters = Type.Object(
  {
    ...TaskFields,
    question: nonBlank("Question the Research Task must answer."),
    expectedEvidence: Type.Array(Text, {
      minItems: 1,
      description: "Evidence the Research Outcome must provide.",
    }),
    selection: Selection,
    experiment: Type.Optional(
      Type.Object(
        {
          permittedEffects: Type.Array(Text, {
            minItems: 1,
            description: "Effects the experiment is authorized to perform.",
          }),
          stopCondition: nonBlank("Condition that ends the experiment."),
        },
        {
          additionalProperties: false,
          description: "Optional bounded experiment authority for repository research.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

export const ConsultParameters = Type.Object(
  {
    ...TaskFields,
    question: nonBlank("Question for the consultation advisor."),
    context: Type.Optional(
      Type.String({
        maxLength: 20_000,
        description: "Relevant context not already available in the target directory.",
      }),
    ),
    advisor: Type.Optional(nonBlank("Exact configured advisor model ID override.")),
  },
  { additionalProperties: false },
);

export const ImplementParameters = Type.Object(
  {
    ...TaskFields,
    objective: nonBlank("Implementation outcome the Worker must produce."),
    acceptance: Type.Array(Text, {
      minItems: 1,
      description: "Observable acceptance conditions for the Candidate.",
    }),
    useEscalationExecutor: Type.Optional(
      Type.Boolean({ description: "Use the configured escalation executor." }),
    ),
    candidateOf: CandidateOf,
    baseRevision: Type.Optional(CommitSchema),
  },
  { additionalProperties: false },
);

export const ReviewParameters = Type.Object(
  {
    ...TaskFields,
    objective: nonBlank("Outcome or behavior the review should assess."),
    concern: nonBlank("Specific risk or quality concern to investigate."),
    subject: ReviewSubjectSchema,
    selection: Selection,
  },
  { additionalProperties: false },
);

export const AttemptParameters = Type.Object(
  {
    taskId: TaskIdSchema,
    candidateOf: CandidateOf,
    baseRevision: Type.Optional(CommitSchema),
    useEscalationExecutor: Type.Optional(
      Type.Boolean({ description: "Use the configured escalation executor." }),
    ),
  },
  { additionalProperties: false },
);

export const InspectParameters = Type.Union([
  Type.Object(
    {
      section: Type.Literal("overview", {
        description: "Summarize Task and Attempt state for this session.",
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      section: Type.Literal("task", { description: "Read one exact Task by ID." }),
      id: TaskIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      section: Type.Literal("task", { description: "List Tasks for this session." }),
      ...PageFields,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      section: Type.Literal("attempt", { description: "Read one exact Attempt by ID." }),
      id: nonBlank("Exact Attempt ID."),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      section: Type.Literal("attempt", {
        description: "List Attempts, optionally limited to one Task.",
      }),
      taskId: Type.Optional(TaskIdSchema),
      ...PageFields,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      section: Type.Literal("report", {
        description: "Read a bounded slice of one Attempt's Worker report.",
      }),
      attemptId: nonBlank("Exact Attempt ID."),
      offset: Type.Optional(
        Type.Integer({ minimum: 0, description: "Zero-based character offset." }),
      ),
      maxChars: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 20_000,
          description: "Maximum report characters to return.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
]);

export const ControlParameters = Type.Union([
  Type.Object(
    {
      action: Type.Literal("cancel", {
        description: "Cancel the exact active Attempt and close its Worker.",
      }),
      attemptId: nonBlank("Exact Attempt ID."),
      reason: nonBlank("Why the Attempt is being cancelled."),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("steer", {
        description: "Send an instruction to the exact active Attempt.",
      }),
      attemptId: nonBlank("Exact Attempt ID."),
      instruction: nonBlank("Focused instruction for the active Worker."),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("apply", {
        description: "Apply the exact retained Candidate to its recorded destination.",
      }),
      attemptId: nonBlank("Exact Attempt ID."),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("discard_output", {
        description: "Explicitly discard the exact retained Candidate output.",
      }),
      attemptId: nonBlank("Exact Attempt ID."),
      reason: nonBlank("Why the retained output is being discarded."),
    },
    { additionalProperties: false },
  ),
]);
