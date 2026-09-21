/* oxlint-disable anti-slop/require-readable-spacing -- Git safety checks stay grouped with their immediate observations and effects. */
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect } from "effect";
import {
  type CommandResult,
  dirty,
  error,
  exactCommit,
  fail,
  filesystem,
  type GitError,
  git,
  gitDirResult,
  gitResult,
  isErrno,
  type RepositoryTarget,
  revalidate,
  type WorktreeRegistration,
  worktreeRegistrations,
} from "../repository/git.js";

export interface CoordinatorCheckoutReceipt {
  readonly head: string;
  readonly created: boolean;
  readonly reused: boolean;
  readonly diagnostic?: string;
}

export interface CoordinatorCheckoutIdentity {
  readonly managedPath: string;
  readonly repositoryCommonDir: string;
  readonly ownedBranch: string;
}

type Observation =
  | { readonly kind: "absent" }
  | { readonly kind: "branch"; readonly head: string }
  | {
      readonly kind: "worktree";
      readonly head: string;
      readonly attached: boolean;
      readonly registration: WorktreeRegistration;
    };

export function ensureCoordinatorCheckout(input: {
  readonly target: RepositoryTarget;
  readonly commit: string;
  readonly identity: CoordinatorCheckoutIdentity;
}): Effect.Effect<CoordinatorCheckoutReceipt, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(input.target);
    const initial = yield* observe(input.identity);

    if (initial.kind === "worktree" && initial.attached)
      return { head: initial.head, created: false, reused: true };

    if (initial.kind !== "absent")
      return yield* fail(
        "create Coordinator checkout",
        "Coordinator checkout resources are partial or have the wrong identity.",
      );

    yield* filesystem("create Coordinator checkout parent", () =>
      mkdir(dirname(input.identity.managedPath), { recursive: true, mode: 0o700 }),
    );
    const placement = yield* gitResult(input.target.checkoutRoot, [
      "worktree",
      "add",
      "-b",
      input.identity.ownedBranch.slice("refs/heads/".length),
      input.identity.managedPath,
      input.commit,
    ]);
    const postcondition = yield* observe(input.identity);

    if (postcondition.kind === "worktree" && postcondition.attached)
      return yield* finishCreation(input.commit, placement, postcondition.head);

    return yield* fail(
      "create Coordinator checkout",
      "Created checkout failed exact post-validation.",
    );
  });
}

export function cleanupCoordinatorCheckout(
  identity: CoordinatorCheckoutIdentity,
  sourcePath: string,
  expectedHead: string,
): Effect.Effect<void, GitError> {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Destructive validation and cleanup ordering stays visible as one safety boundary.
  return Effect.gen(function* () {
    const initial = yield* observe(identity);

    if (initial.kind === "absent") return;

    if (initial.head !== expectedHead)
      return yield* fail(
        "finish Coordinator checkout",
        "Owned checkout branch or HEAD changed; resources were preserved.",
      );

    if (initial.kind === "worktree") {
      if (yield* dirty(identity.managedPath, true))
        return yield* fail(
          "finish Coordinator checkout",
          "Managed checkout has tracked, staged, untracked, ignored, or merge state.",
        );

      const removal = yield* gitResult(sourcePath, ["worktree", "remove", identity.managedPath]);
      const afterRemoval = yield* observe(identity);

      if (afterRemoval.kind !== "branch" || afterRemoval.head !== expectedHead)
        return yield* fail(
          "finish Coordinator checkout",
          removal.stderr || removal.stdout || "Exact worktree removal was not proven.",
        );
    }

    const deletion = yield* gitDirResult(identity.repositoryCommonDir, [
      "update-ref",
      "-d",
      identity.ownedBranch,
      expectedHead,
    ]);

    if (deletion.code !== 0)
      return yield* fail(
        "finish Coordinator checkout",
        deletion.stderr || deletion.stdout || "Owned branch compare-and-delete failed.",
      );

    if ((yield* observe(identity)).kind !== "absent")
      return yield* fail(
        "finish Coordinator checkout",
        "Owned checkout cleanup postcondition is not absent.",
      );
  });
}

function observe(identity: CoordinatorCheckoutIdentity): Effect.Effect<Observation, GitError> {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Native identity classification is intentionally exhaustive and non-repairing.
  return Effect.gen(function* () {
    const [entry, reference, registrations] = yield* Effect.all([
      optionalPathEntry(identity.managedPath),
      directReference(identity.repositoryCommonDir, identity.ownedBranch),
      worktreeRegistrations(identity.repositoryCommonDir),
    ]);
    const paths = registrations.filter(
      (registration) => resolve(registration.path) === identity.managedPath,
    );
    const branches = registrations.filter(
      (registration) => registration.branch === identity.ownedBranch,
    );

    if (
      entry === undefined &&
      reference === undefined &&
      paths.length === 0 &&
      branches.length === 0
    )
      return { kind: "absent" as const };

    if (
      entry === undefined &&
      reference !== undefined &&
      paths.length === 0 &&
      branches.length === 0
    )
      return { kind: "branch" as const, head: reference };

    const registration = paths[0];

    if (
      entry === undefined ||
      reference === undefined ||
      paths.length !== 1 ||
      registration === undefined ||
      branches.length > 1 ||
      (branches.length === 1 && branches[0] !== registration) ||
      registration.locked ||
      registration.head !== reference
    )
      return yield* fail(
        "inspect Coordinator checkout",
        "Coordinator checkout is locked, partial, duplicated, moved, or has the wrong identity.",
      );

    yield* validateManagedPath(identity.managedPath, entry);
    const commonText = yield* git(identity.managedPath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const commonDir = yield* filesystem("inspect managed checkout repository", () =>
      realpath(resolve(identity.managedPath, commonText)),
    );

    if (commonDir !== identity.repositoryCommonDir)
      return yield* fail("inspect Coordinator checkout", "Managed checkout is foreign.");

    const attached = yield* gitResult(identity.managedPath, ["symbolic-ref", "-q", "HEAD"]);

    if (attached.code === 0 && attached.stdout !== identity.ownedBranch)
      return yield* fail(
        "inspect Coordinator checkout",
        "Managed checkout switched to another branch.",
      );

    if (attached.code !== 0 && attached.code !== 1)
      return yield* fail("inspect Coordinator checkout", "Managed checkout HEAD is unreadable.");

    const head = yield* exactCommit(
      identity.repositoryCommonDir,
      "HEAD",
      "inspect Coordinator checkout",
      identity.managedPath,
    );

    if (head !== reference)
      return yield* fail("inspect Coordinator checkout", "Managed checkout HEAD changed.");

    return {
      kind: "worktree" as const,
      head,
      attached: attached.code === 0,
      registration,
    };
  });
}

function validateManagedPath(
  managedPath: string,
  entry: Awaited<ReturnType<typeof lstat>>,
): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    if (!entry.isDirectory() || entry.isSymbolicLink())
      return yield* fail("inspect Coordinator checkout", "Managed checkout path is symlinked.");

    const actualPath = yield* filesystem("inspect managed checkout path", () =>
      realpath(managedPath),
    );

    if (actualPath !== managedPath)
      return yield* fail("inspect Coordinator checkout", "Managed checkout path is moved.");
  });
}

function directReference(
  commonDir: string,
  branch: string,
): Effect.Effect<string | undefined, GitError> {
  return gitDirResult(commonDir, [
    "for-each-ref",
    "--format=%(refname)%00%(symref)%00%(objectname)",
    branch,
  ]).pipe(
    Effect.flatMap((result) => {
      if (result.code !== 0)
        return fail("inspect Coordinator checkout", "Owned branch could not be inspected.");
      // oxlint-disable-next-line effecttsgo/effect-succeed-with-void -- This branch inhabits the explicit optional-ref result.
      if (result.stdout.length === 0) return Effect.succeed<string | undefined>(undefined);
      const fields = result.stdout.split("\0");

      if (fields.length !== 3 || fields[0] !== branch || fields[1] !== "")
        return fail("inspect Coordinator checkout", "Owned branch identity is unreadable.");

      return exactCommit(commonDir, branch, "inspect Coordinator checkout").pipe(
        Effect.map((commit): string | undefined => commit),
      );
    }),
  );
}

function optionalPathEntry(path: string) {
  return Effect.tryPromise({
    try: () =>
      lstat(path).catch((cause: unknown) => {
        if (isErrno(cause, "ENOENT")) return undefined;
        throw cause;
      }),
    catch: () => error("inspect Coordinator checkout", "Managed checkout path is unreadable."),
  });
}

function finishCreation(
  commit: string,
  placement: CommandResult,
  head: string,
): Effect.Effect<CoordinatorCheckoutReceipt, GitError> {
  if (head !== commit)
    return fail(
      "create Coordinator checkout",
      "Created checkout HEAD does not match the exact requested commit.",
    );
  const diagnostic =
    placement.code === 0
      ? undefined
      : (placement.stderr || placement.stdout || "Git returned a failure.")
          .replace(/\s+/g, " ")
          .slice(0, 500);
  const receipt = { head, created: true, reused: false } as const;

  return Effect.succeed(diagnostic === undefined ? receipt : { ...receipt, diagnostic });
}
