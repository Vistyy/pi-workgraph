import { type Static, Type } from "typebox";
import { CommitSchema } from "../domain/records.js";

const Text = Type.String({ minLength: 1, pattern: "\\S" });

const Ref = Type.String({ minLength: 1, pattern: "^refs/" });

const PullRequestFields = {
  acceptedRevision: CommitSchema,
  url: Type.String({ pattern: "^https://github\\.com/[^/]+/[^/]+/pull/[1-9][0-9]*$" }),
  remote: Text,
  publicationRepository: Text,
};

const AdvancementFields = {
  acceptedRevision: CommitSchema,
  destinationBefore: CommitSchema,
  destinationRevision: CommitSchema,
};

const StateSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("available"), allocatedRevision: CommitSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("preserved"), revision: CommitSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("local_prepared"), ...AdvancementFields },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("pull_request"),
      ...PullRequestFields,
      observation: Type.Union([Type.Literal("open"), Type.Literal("closed_unmerged")]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("pull_request_prepared"),
      ...PullRequestFields,
      mergedRevision: CommitSchema,
      headBranch: Text,
      baseRemote: Text,
      baseRepository: Text,
      baseBranch: Text,
      destinationBefore: CommitSchema,
      destinationRevision: CommitSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("local_integrated"),
      acceptedRevision: CommitSchema,
      destinationRevision: CommitSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("pull_request_integrated"),
      ...PullRequestFields,
      mergedRevision: CommitSchema,
      headBranch: Text,
      destinationRevision: CommitSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("complete"),
      route: Type.Literal("local"),
      acceptedRevision: CommitSchema,
      destinationRevision: CommitSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("complete"),
      route: Type.Literal("pull_request"),
      acceptedRevision: CommitSchema,
      destinationRevision: CommitSchema,
      url: Text,
      mergedRevision: CommitSchema,
    },
    { additionalProperties: false },
  ),
]);

export const CheckoutDeliveryRecordSchema = Type.Object(
  {
    checkoutId: Type.String({ minLength: 64, maxLength: 64 }),
    managedPath: Text,
    repositoryCommonDir: Text,
    ownedBranch: Ref,
    sourcePath: Text,
    destinationRef: Type.Optional(Ref),
    state: StateSchema,
  },
  { additionalProperties: false },
);

export type CheckoutDeliveryRecord = Static<typeof CheckoutDeliveryRecordSchema>;

export type CheckoutDeliveryState = CheckoutDeliveryRecord["state"];
