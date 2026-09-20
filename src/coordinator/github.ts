import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const exec = promisify(execFile);

const GITHUB_READ_TIMEOUT_MS = 30_000;

const GITHUB_READ_MAX_BUFFER = 1024 * 1024;

const RepositorySchema = Type.Object(
  { nameWithOwner: Type.String({ minLength: 3, pattern: "^[^/]+/[^/]+$" }) },
  { additionalProperties: true },
);

const PullRequestSchema = Type.Object(
  {
    url: Type.String(),
    state: Type.Union([Type.Literal("OPEN"), Type.Literal("CLOSED"), Type.Literal("MERGED")]),
    headRefOid: Type.String({ pattern: "^[0-9a-f]{40,64}$" }),
    headRefName: Type.String({ minLength: 1 }),
    headRepository: RepositorySchema,
    baseRefName: Type.String({ minLength: 1 }),
    baseRepository: RepositorySchema,
    mergeCommit: Type.Union([
      Type.Null(),
      Type.Object(
        { oid: Type.String({ pattern: "^[0-9a-f]{40,64}$" }) },
        { additionalProperties: true },
      ),
    ]),
  },
  { additionalProperties: true },
);

export type PullRequestFacts = Static<typeof PullRequestSchema>;

/** One fresh, bounded GitHub CLI read; it never creates, updates, merges, or polls a PR. */
// oxlint-disable-next-line effecttsgo/async-function -- This narrow adapter owns the GitHub CLI Promise boundary.
export async function readPullRequest(url: string): Promise<PullRequestFacts> {
  let stdout: string;

  try {
    ({ stdout } = await exec(
      "gh",
      [
        "pr",
        "view",
        url,
        "--json",
        "url,state,headRefOid,headRefName,headRepository,baseRefName,baseRepository,mergeCommit",
      ],
      {
        timeout: GITHUB_READ_TIMEOUT_MS,
        maxBuffer: GITHUB_READ_MAX_BUFFER,
      },
    ));
  } catch (cause) {
    throw new Error("GitHub pull request facts are unavailable or unauthenticated.", { cause });
  }

  let value: unknown;

  try {
    value = JSON.parse(stdout);
  } catch (cause) {
    throw new Error("GitHub pull request response is malformed.", { cause });
  }

  if (!Value.Check(PullRequestSchema, value))
    throw new Error("GitHub pull request response lacks required identity facts.");

  return Value.Decode(PullRequestSchema, value);
}
