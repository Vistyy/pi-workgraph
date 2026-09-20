import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect } from "effect";
import {
  type CommandResult,
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

export type CoordinatorCheckoutObservation =
  | { readonly kind: "absent" }
  | { readonly kind: "exact"; readonly head: string };

export function ensureCoordinatorCheckout(input: {
  readonly target: RepositoryTarget;
  readonly commit: string;
  readonly identity: CoordinatorCheckoutIdentity;
}): Effect.Effect<CoordinatorCheckoutReceipt, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(input.target);
    const initial = yield* observeCoordinatorCheckout(input.identity);

    if (initial.kind === "exact") return { head: initial.head, created: false, reused: true };

    yield* filesystem("create Coordinator checkout parent", () =>
      mkdir(dirname(input.identity.managedPath), { recursive: true, mode: 0o700 }),
    );
    const branch = input.identity.ownedBranch.slice("refs/heads/".length);

    const placement = yield* gitResult(input.target.checkoutRoot, [
      "worktree",
      "add",
      "-b",
      branch,
      input.identity.managedPath,
      input.commit,
    ]);

    const postcondition = yield* observeCoordinatorCheckout(input.identity);

    return yield* finishCreation(input.commit, placement, postcondition);
  });
}

export function observeCoordinatorCheckout(
  identity: CoordinatorCheckoutIdentity,
): Effect.Effect<CoordinatorCheckoutObservation, GitError> {
  return Effect.gen(function* () {
    const [entry, reference, registrations] = yield* Effect.all([
      optionalPathEntry(identity.managedPath),
      directReference(identity.repositoryCommonDir, identity.ownedBranch),
      worktreeRegistrations(identity.repositoryCommonDir),
    ]);

    const pathRegistrations = registrations.filter(
      (registration) => resolve(registration.path) === identity.managedPath,
    );

    const branchRegistrations = registrations.filter(
      (registration) => registration.branch === identity.ownedBranch,
    );

    if (
      entry === undefined &&
      reference === undefined &&
      pathRegistrations.length === 0 &&
      branchRegistrations.length === 0
    )
      return { kind: "absent" as const };

    const registration = pathRegistrations[0];

    if (
      entry === undefined ||
      reference === undefined ||
      pathRegistrations.length !== 1 ||
      branchRegistrations.length !== 1 ||
      registration === undefined ||
      registration !== branchRegistrations[0]
    )
      return yield* fail(
        "inspect Coordinator checkout",
        "Coordinator checkout resources are partial or duplicated, or have the wrong identity.",
      );

    return yield* inspectExact(identity, entry, reference, registration);
  });
}

function inspectExact(
  identity: CoordinatorCheckoutIdentity,
  entry: Awaited<ReturnType<typeof lstat>>,
  reference: string,
  registration: WorktreeRegistration,
): Effect.Effect<CoordinatorCheckoutObservation, GitError> {
  return Effect.gen(function* () {
    yield* validateManagedPath(identity.managedPath, entry);

    if (registration.locked)
      return yield* fail(
        "inspect Coordinator checkout",
        "Managed checkout registration is locked and cannot be reused.",
      );

    if (registration.head !== reference)
      return yield* fail(
        "inspect Coordinator checkout",
        "Managed checkout registration does not match its owned branch.",
      );

    const commonText = yield* git(identity.managedPath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);

    const commonDir = yield* filesystem("inspect managed checkout repository", () =>
      realpath(resolve(identity.managedPath, commonText)),
    );

    if (commonDir !== identity.repositoryCommonDir)
      return yield* fail(
        "inspect Coordinator checkout",
        "Managed checkout belongs to another repository.",
      );

    const attached = yield* gitResult(identity.managedPath, ["symbolic-ref", "-q", "HEAD"]);

    if (attached.code !== 0 || attached.stdout !== identity.ownedBranch)
      return yield* fail(
        "inspect Coordinator checkout",
        "Managed checkout is detached or switched to another branch.",
      );

    const head = yield* exactCommit(
      identity.repositoryCommonDir,
      "HEAD",
      "inspect Coordinator checkout",
      identity.managedPath,
    );

    if (head !== reference)
      return yield* fail(
        "inspect Coordinator checkout",
        "Managed checkout HEAD and owned branch disagree.",
      );

    return { kind: "exact" as const, head };
  });
}

function validateManagedPath(
  managedPath: string,
  entry: Awaited<ReturnType<typeof lstat>>,
): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    if (!entry.isDirectory() || entry.isSymbolicLink())
      return yield* fail(
        "inspect Coordinator checkout",
        "Managed checkout path is not an owned directory.",
      );

    const actualPath = yield* filesystem("inspect managed checkout path", () =>
      realpath(managedPath),
    );

    if (actualPath !== managedPath)
      return yield* fail(
        "inspect Coordinator checkout",
        "Managed checkout path is symlinked or moved.",
      );
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

function optionalPathEntry(
  path: string,
): Effect.Effect<Awaited<ReturnType<typeof lstat>> | undefined, GitError> {
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
  postcondition: CoordinatorCheckoutObservation,
): Effect.Effect<CoordinatorCheckoutReceipt, GitError> {
  if (postcondition.kind === "exact" && postcondition.head === commit) {
    const diagnostic =
      placement.code === 0
        ? undefined
        : (placement.stderr || placement.stdout || "Git returned a failure.")
            .replace(/\s+/g, " ")
            .slice(0, 500);

    const receipt = { head: postcondition.head, created: true, reused: false } as const;

    return Effect.succeed(diagnostic === undefined ? receipt : { ...receipt, diagnostic });
  }

  if (postcondition.kind === "exact")
    return fail(
      "create Coordinator checkout",
      "Created checkout HEAD does not match the exact requested commit.",
    );

  if (placement.code === 0)
    return fail("create Coordinator checkout", "Created checkout failed exact post-validation.");

  const diagnostic = (placement.stderr || placement.stdout || "Git returned a failure.")
    .replace(/\s+/g, " ")
    .slice(0, 500);

  return fail(
    "create Coordinator checkout",
    `Git worktree creation failed without allocating resources: ${diagnostic}`,
  );
}
