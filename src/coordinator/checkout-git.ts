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
import type { CheckoutDeliveryRecord } from "./delivery-state.js";

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

export function observeAcceptedCheckout(
  record: CheckoutDeliveryRecord,
  requested?: string,
  requireClean = true,
): Effect.Effect<string, GitError> {
  return Effect.gen(function* () {
    const observed = yield* observeCoordinatorCheckout(record);

    if (observed.kind !== "exact")
      return yield* fail("inspect accepted checkout", "Managed checkout resources are absent.");

    if (requested !== undefined && observed.head !== requested)
      return yield* fail(
        "inspect accepted checkout",
        "Accepted revision is not the exact managed checkout HEAD.",
      );

    if (requireClean && (yield* dirty(record.managedPath, true)))
      return yield* fail("inspect accepted checkout", "Accepted managed checkout is not clean.");

    return observed.head;
  });
}

export function cleanupCoordinatorCheckout(record: CheckoutDeliveryRecord, accepted: string) {
  return Effect.gen(function* () {
    yield* removeOwnedWorktree(record, accepted);
    yield* deleteOwnedBranch(record, accepted);
    const resources = yield* localResources(record);

    if (
      resources.entry !== undefined ||
      resources.paths.length > 0 ||
      resources.branches.length > 0
    )
      return yield* fail(
        "clean up Coordinator checkout",
        "Owned checkout cleanup postcondition is absent.",
      );
    const branch = yield* branchTip(record);

    if (branch !== undefined)
      return yield* fail(
        "clean up Coordinator checkout",
        "Owned checkout cleanup postcondition is absent.",
      );
  });
}

function removeOwnedWorktree(record: CheckoutDeliveryRecord, accepted: string) {
  return Effect.gen(function* () {
    const resources = yield* localResources(record);

    if (
      resources.entry === undefined &&
      resources.paths.length === 0 &&
      resources.branches.length === 0
    )
      return;

    if (
      resources.entry === undefined ||
      resources.paths.length !== 1 ||
      resources.branches.length !== 1 ||
      resources.paths[0] !== resources.branches[0]
    )
      return yield* fail(
        "clean up Coordinator checkout",
        "Owned checkout cleanup resources are partial or unexpected.",
      );

    yield* observeAcceptedCheckout(record, accepted);
    const removal = yield* gitResult(record.sourcePath, ["worktree", "remove", record.managedPath]);
    const after = yield* localResources(record);

    if (after.entry !== undefined || after.paths.length > 0 || after.branches.length > 0)
      return yield* fail(
        "clean up Coordinator checkout",
        removal.stderr || removal.stdout || "Owned worktree removal was not proven.",
      );
  });
}

function deleteOwnedBranch(record: CheckoutDeliveryRecord, accepted: string) {
  return Effect.gen(function* () {
    const current = yield* branchTip(record);

    if (current === undefined) return;

    if (current !== accepted)
      return yield* fail(
        "clean up Coordinator checkout",
        "Owned checkout branch changed; it was preserved.",
      );

    const deletion = yield* gitDirResult(record.repositoryCommonDir, [
      "update-ref",
      "-d",
      record.ownedBranch,
      accepted,
    ]);

    if (deletion.code !== 0)
      return yield* fail(
        "clean up Coordinator checkout",
        deletion.stderr || deletion.stdout || "Owned branch deletion failed.",
      );
  });
}

function localResources(record: CheckoutDeliveryRecord) {
  return Effect.gen(function* () {
    const [entry, registrations] = yield* Effect.all([
      optionalPathEntry(record.managedPath),
      worktreeRegistrations(record.repositoryCommonDir),
    ]);

    return {
      entry,
      paths: registrations.filter(
        (registration) => resolve(registration.path) === record.managedPath,
      ),
      branches: registrations.filter((registration) => registration.branch === record.ownedBranch),
    };
  });
}

function branchTip(record: CheckoutDeliveryRecord) {
  return gitDirResult(record.repositoryCommonDir, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${record.ownedBranch}^{commit}`,
  ]).pipe(
    Effect.flatMap((result) => {
      if (result.code === 0) return Effect.succeed<string | undefined>(result.stdout);

      // oxlint-disable-next-line effecttsgo/effect-succeed-with-void -- This branch inhabits the explicit optional-tip result.
      if (result.code === 1) return Effect.succeed<string | undefined>(undefined);

      return fail("clean up Coordinator checkout", "Owned branch could not be inspected.");
    }),
  );
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
