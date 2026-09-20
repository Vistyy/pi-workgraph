/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-conditional-empty-object-spread -- Effect generators keep sequential custody checks and exact optional facts grouped. */
import { existsSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Data, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { AttemptOutput, AttemptSpec, TaskTarget } from "./domain/records.js";
import { childProcessLayer } from "./node-platform.js";

type RepositoryTarget = Extract<TaskTarget, { kind: "repository" }>;

export interface RepositoryOperation {
  readonly attemptId: string;
  readonly spec: AttemptSpec;
  readonly output?: AttemptOutput;
  readonly target: RepositoryTarget;
  readonly worktreePath: string;
  readonly outputRef: string;
}

export class GitError extends Data.TaggedError("GitError")<{
  readonly operation: string;
  readonly message: string;
}> {}

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface CheckoutState {
  readonly head: string;
  readonly dirty: boolean;
}

export type ResolvedTaskTarget =
  | { readonly target: Extract<TaskTarget, { kind: "directory" }> }
  | {
      readonly target: Extract<TaskTarget, { kind: "repository" }>;
      readonly commit: string;
    };

/** Resolve one immutable Task target and retain the exact commit validated for a repository. */
export function resolveTaskTarget(
  input:
    | { readonly cwd: string; readonly path?: string; readonly kind: "directory" }
    | {
        readonly cwd: string;
        readonly path?: string;
        readonly kind: "repository";
        readonly revision?: string;
      },
): Effect.Effect<ResolvedTaskTarget, GitError> {
  return Effect.gen(function* () {
    const path = yield* filesystem("resolve target", () =>
      realpath(resolve(input.cwd, input.path ?? ".")),
    );

    const targetStat = yield* filesystem("resolve target", () => stat(path));

    if (!targetStat.isDirectory())
      return yield* fail("resolve target", "Target is not a directory.");

    if (input.kind === "directory") return { target: { kind: "directory" as const, path } };

    const discovery = yield* gitResult(path, ["rev-parse", "--git-dir"]);

    if (discovery.code !== 0)
      return yield* fail("resolve target", "Target is not an initialized Git work tree.");
    const inside = yield* git(path, ["rev-parse", "--is-inside-work-tree"]);
    const bare = yield* git(path, ["rev-parse", "--is-bare-repository"]);

    if (inside !== "true" || bare !== "false")
      return yield* fail("resolve target", "Bare repositories are not valid Task targets.");
    const checkoutText = yield* git(path, ["rev-parse", "--show-toplevel"]);
    const checkoutRoot = yield* filesystem("resolve checkout root", () => realpath(checkoutText));

    const commonText = yield* git(path, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);

    const commonDir = yield* filesystem("resolve common directory", () =>
      realpath(resolve(path, commonText)),
    );

    const commit = yield* exactCommit(commonDir, input.revision ?? "HEAD", "resolve target", path);

    return {
      target: { kind: "repository" as const, checkoutRoot, commonDir },
      commit,
    };
  });
}

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

type WorktreeRegistration = {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly locked: boolean;
};

type CoordinatorCheckoutClassification =
  | { readonly kind: "absent" }
  | { readonly kind: "exact"; readonly head: string };

function resolveCoordinatorRepository(
  cwd: string,
  path?: string,
): Effect.Effect<{ readonly target: RepositoryTarget; readonly commit: string }, GitError> {
  return Effect.gen(function* () {
    const resolved = yield* path === undefined
      ? resolveTaskTarget({ cwd, kind: "repository" })
      : resolveTaskTarget({ cwd, path, kind: "repository" });

    if (resolved.target.kind !== "repository" || !("commit" in resolved))
      return yield* fail("resolve Coordinator checkout", "Repository target resolution failed.");

    return resolved;
  });
}

export function requireCoordinatorCheckoutAbsent(
  identity: CoordinatorCheckoutIdentity,
): Effect.Effect<void, GitError> {
  return classifyCoordinatorCheckout(identity).pipe(
    Effect.flatMap((classification) =>
      classification.kind === "absent"
        ? Effect.void
        : fail("create Coordinator checkout", "Coordinator checkout resources already exist."),
    ),
  );
}

/** Allocate or reuse the one exact Coordinator-owned linked checkout. */
export function ensureCoordinatorCheckout(input: {
  readonly target: RepositoryTarget;
  readonly commit: string;
  readonly identity: CoordinatorCheckoutIdentity;
  readonly recoverCheckpointedBranch?: boolean;
}): Effect.Effect<CoordinatorCheckoutReceipt, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(input.target);
    const initial = yield* classifyCoordinatorCheckout(
      input.identity,
      input.recoverCheckpointedBranch === true,
    );

    if (initial.kind === "exact") return { head: initial.head, created: false, reused: true };

    yield* ensureCoordinatorCheckoutParent(input.identity.managedPath);
    const branch = input.identity.ownedBranch.slice("refs/heads/".length);
    const existing = yield* directReference(
      input.identity.repositoryCommonDir,
      input.identity.ownedBranch,
    );

    if (existing !== undefined && existing !== input.commit)
      return yield* fail(
        "create Coordinator checkout",
        "Checkpointed owned branch no longer matches the requested commit.",
      );

    const placement = yield* gitResult(
      input.target.checkoutRoot,
      existing === undefined
        ? ["worktree", "add", "-b", branch, input.identity.managedPath, input.commit]
        : ["worktree", "add", input.identity.managedPath, branch],
    );
    const postcondition = yield* classifyCoordinatorCheckout(input.identity);

    return yield* finishCoordinatorCreation(input.commit, placement, postcondition);
  });
}

function finishCoordinatorCreation(
  commit: string,
  placement: CommandResult,
  postcondition: CoordinatorCheckoutClassification,
): Effect.Effect<CoordinatorCheckoutReceipt, GitError> {
  if (postcondition.kind === "exact" && postcondition.head === commit) {
    const diagnostic =
      placement.code === 0
        ? undefined
        : boundedDiagnostic(placement.stderr || placement.stdout || "Git returned a failure.");
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

  return fail(
    "create Coordinator checkout",
    `Git worktree creation failed without allocating resources: ${boundedDiagnostic(
      placement.stderr || placement.stdout || "Git returned a failure.",
    )}`,
  );
}

function ensureCoordinatorCheckoutParent(managedPath: string): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    const checkoutRoot = dirname(managedPath);
    const workgraphRoot = dirname(checkoutRoot);

    for (const path of [workgraphRoot, checkoutRoot]) {
      yield* filesystem("create Coordinator checkout parent", () =>
        mkdir(path, { mode: 0o700 }).catch((cause: unknown) => {
          if (!isErrno(cause, "EEXIST")) throw cause;
        }),
      );
      const entry = yield* filesystem("inspect Coordinator checkout parent", () => lstat(path));
      const actual = yield* filesystem("inspect Coordinator checkout parent", () => realpath(path));

      if (!entry.isDirectory() || entry.isSymbolicLink() || actual !== path)
        return yield* fail(
          "inspect Coordinator checkout parent",
          "Coordinator checkout parent is not an owned directory.",
        );
      yield* filesystem("secure Coordinator checkout parent", () => chmod(path, 0o700));
    }
  });
}

export interface CoordinatorSourceFacts {
  readonly target: RepositoryTarget;
  readonly head: string;
  readonly ref?: string;
}

export function coordinatorSourceFacts(
  cwd: string,
  path?: string,
): Effect.Effect<CoordinatorSourceFacts, GitError> {
  return Effect.gen(function* () {
    const resolved = yield* resolveCoordinatorRepository(cwd, path);
    const symbolic = yield* gitResult(resolved.target.checkoutRoot, ["symbolic-ref", "-q", "HEAD"]);

    return {
      target: resolved.target,
      head: resolved.commit,
      ...(symbolic.code === 0 && symbolic.stdout.startsWith("refs/heads/")
        ? { ref: symbolic.stdout }
        : {}),
    };
  });
}

export function coordinatorCheckoutHead(
  identity: CoordinatorCheckoutIdentity,
): Effect.Effect<string, GitError> {
  return classifyCoordinatorCheckout(identity).pipe(
    Effect.flatMap((classification) =>
      classification.kind === "exact"
        ? Effect.succeed(classification.head)
        : fail("inspect Coordinator checkout", "Coordinator checkout resources are absent."),
    ),
  );
}

function classifyCoordinatorCheckout(
  identity: CoordinatorCheckoutIdentity,
  allowCheckpointedBranch = false,
): Effect.Effect<CoordinatorCheckoutClassification, GitError> {
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
      pathRegistrations.length === 0 &&
      branchRegistrations.length === 0 &&
      (reference === undefined || allowCheckpointedBranch)
    )
      return { kind: "absent" as const };

    const pathRegistration = pathRegistrations[0];
    const branchRegistration = branchRegistrations[0];

    if (
      entry === undefined ||
      reference === undefined ||
      pathRegistrations.length !== 1 ||
      branchRegistrations.length !== 1 ||
      pathRegistration === undefined ||
      pathRegistration !== branchRegistration
    )
      return yield* fail(
        "inspect Coordinator checkout",
        "Coordinator checkout resources are partial or duplicated, or have the wrong identity.",
      );

    return yield* inspectCoordinatorCheckout(identity, entry, reference, pathRegistration);
  });
}

function inspectCoordinatorCheckout(
  identity: CoordinatorCheckoutIdentity,
  entry: Awaited<ReturnType<typeof lstat>>,
  reference: string,
  registration: WorktreeRegistration,
): Effect.Effect<CoordinatorCheckoutClassification, GitError> {
  return Effect.gen(function* () {
    yield* validateCoordinatorCheckoutPath(identity.managedPath, entry);

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

    yield* validateCoordinatorBacklink(identity);
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

function validateCoordinatorCheckoutPath(
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

function validateCoordinatorBacklink(
  identity: CoordinatorCheckoutIdentity,
): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    const dotGit = join(identity.managedPath, ".git");
    const gitEntry = yield* filesystem("inspect managed checkout backlink", () => lstat(dotGit));

    if (!gitEntry.isFile() || gitEntry.isSymbolicLink())
      return yield* fail(
        "inspect Coordinator checkout backlink",
        "Managed checkout backlink is not an owned regular file.",
      );
    const backlink = yield* filesystem("read managed checkout backlink", () =>
      readFile(dotGit, "utf8"),
    );
    const backlinkTarget = /^gitdir: (.+)\r?\n?$/.exec(backlink)?.[1];

    if (backlinkTarget === undefined)
      return yield* fail(
        "inspect Coordinator checkout backlink",
        "Managed checkout backlink is unreadable.",
      );
    const adminDir = yield* filesystem("resolve managed checkout backlink", () =>
      realpath(resolve(identity.managedPath, backlinkTarget)),
    );
    const adminEntry = yield* filesystem("inspect worktree administration entry", () =>
      lstat(adminDir),
    );
    const worktreesDir = yield* filesystem("resolve worktree administration directory", () =>
      realpath(join(identity.repositoryCommonDir, "worktrees")),
    );

    if (
      !adminEntry.isDirectory() ||
      adminEntry.isSymbolicLink() ||
      dirname(adminDir) !== worktreesDir
    )
      return yield* fail(
        "inspect Coordinator checkout backlink",
        "Managed checkout backlink resolves outside this repository's linked-worktree administration.",
      );

    const reversePath = join(adminDir, "gitdir");
    const reverseEntry = yield* filesystem("inspect reverse worktree backlink", () =>
      lstat(reversePath),
    );

    if (!reverseEntry.isFile() || reverseEntry.isSymbolicLink())
      return yield* fail(
        "inspect Coordinator checkout backlink",
        "Reverse worktree backlink is not an owned regular file.",
      );
    const reverse = yield* filesystem("read reverse worktree backlink", () =>
      readFile(reversePath, "utf8"),
    );
    const [reverseDotGit, actualDotGit] = yield* Effect.all([
      filesystem("resolve reverse worktree backlink", () =>
        realpath(resolve(adminDir, reverse.trim())),
      ),
      filesystem("resolve managed checkout backlink file", () => realpath(dotGit)),
    ]);

    if (reverseDotGit !== actualDotGit)
      return yield* fail(
        "inspect Coordinator checkout backlink",
        "Reverse worktree backlink does not resolve to the managed checkout.",
      );
  });
}

function directReference(
  commonDir: string,
  branch: string,
): Effect.Effect<string | undefined, GitError> {
  return gitDirResult(commonDir, [
    "for-each-ref",
    "--format=%(symref)%00%(objectname)",
    branch,
  ]).pipe(
    Effect.flatMap((result) => {
      if (result.code !== 0)
        return fail("inspect Coordinator checkout", "Owned branch could not be inspected.");

      // oxlint-disable-next-line effecttsgo/effect-succeed-with-void -- This branch inhabits the explicit optional-ref result.
      if (result.stdout.length === 0) return Effect.succeed<string | undefined>(undefined);
      const separator = result.stdout.indexOf("\0");

      if (separator < 0 || result.stdout.slice(0, separator).length > 0)
        return fail("inspect Coordinator checkout", "Owned branch identity is unreadable.");

      return exactCommit(commonDir, branch, "inspect Coordinator checkout").pipe(
        Effect.map((commit): string | undefined => commit),
      );
    }),
  );
}

function worktreeRegistrations(commonDir: string): Effect.Effect<WorktreeRegistration[], GitError> {
  return gitDir(commonDir, ["worktree", "list", "--porcelain", "-z"]).pipe(
    Effect.map((text) => {
      const registrations: WorktreeRegistration[] = [];
      let current: WorktreeRegistration | undefined;

      for (const field of text.split("\0")) {
        if (field.startsWith("worktree ")) {
          if (current !== undefined) registrations.push(current);
          current = { path: field.slice("worktree ".length), locked: false };
        } else if (current !== undefined) current = applyWorktreeField(current, field);
      }

      if (current !== undefined) registrations.push(current);

      return registrations;
    }),
  );
}

function applyWorktreeField(
  registration: WorktreeRegistration,
  field: string,
): WorktreeRegistration {
  if (field.startsWith("HEAD ")) return { ...registration, head: field.slice("HEAD ".length) };

  if (field.startsWith("branch "))
    return { ...registration, branch: field.slice("branch ".length) };

  if (field === "locked" || field.startsWith("locked ")) return { ...registration, locked: true };

  return registration;
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

function boundedDiagnostic(message: string): string {
  return message.replace(/\s+/g, " ").slice(0, 500);
}

export interface CoordinatorAdvancement {
  readonly destinationRoot: string;
  readonly destinationRef: string;
  readonly destinationHead: string;
  readonly preparedRevision: string;
}

export function prepareCoordinatorAdvancement(input: {
  readonly identity: CoordinatorCheckoutIdentity;
  readonly acceptedRevision: string;
  readonly destinationRoot: string;
  readonly destinationRef: string;
}): Effect.Effect<CoordinatorAdvancement, GitError> {
  return Effect.gen(function* () {
    yield* requireAcceptedCoordinatorSource(input.identity, input.acceptedRevision);
    const destination = yield* authorizedCoordinatorDestination(input);
    const destinationHead = destination.commit;
    const preparedRevision = yield* plannedRevision(
      input.identity.repositoryCommonDir,
      destinationHead,
      input.acceptedRevision,
      "Integrate accepted Workgraph checkout",
    );

    yield* requireDisjointDestinationChanges(
      destination.target.checkoutRoot,
      destinationHead,
      preparedRevision,
    );

    return {
      destinationRoot: destination.target.checkoutRoot,
      destinationRef: input.destinationRef,
      destinationHead,
      preparedRevision,
    };
  });
}

export function requireCoordinatorAdvancementAbsent(input: {
  readonly identity: CoordinatorCheckoutIdentity;
  readonly acceptedRevision: string;
  readonly advancement: CoordinatorAdvancement;
}): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    const destination = yield* resolveCoordinatorRepository(input.advancement.destinationRoot);

    if (destination.target.commonDir !== input.identity.repositoryCommonDir)
      return yield* fail("prepare local delivery", "Destination repository identity changed.");
    const ref = yield* gitResult(destination.target.checkoutRoot, ["symbolic-ref", "-q", "HEAD"]);

    if (ref.code !== 0 || ref.stdout !== input.advancement.destinationRef)
      return yield* fail("prepare local delivery", "Destination ref changed.");
    if (
      destination.commit === input.advancement.preparedRevision ||
      (yield* ancestry(
        input.identity.repositoryCommonDir,
        input.acceptedRevision,
        destination.commit,
      ))
    )
      return yield* fail(
        "prepare local delivery",
        "Destination may already contain the accepted revision; preserve existing integration proof.",
      );
  });
}

export function retryCoordinatorAdvancement(input: {
  readonly identity: CoordinatorCheckoutIdentity;
  readonly acceptedRevision: string;
  readonly advancement: CoordinatorAdvancement;
}): Effect.Effect<CoordinatorAdvancement, GitError> {
  return Effect.gen(function* () {
    yield* requireCoordinatorAdvancementAbsent(input);

    return yield* prepareCoordinatorAdvancement({
      identity: input.identity,
      acceptedRevision: input.acceptedRevision,
      destinationRoot: input.advancement.destinationRoot,
      destinationRef: input.advancement.destinationRef,
    });
  });
}

export function verifyCoordinatorAdvancement(input: {
  readonly identity: CoordinatorCheckoutIdentity;
  readonly acceptedRevision: string;
  readonly advancement: CoordinatorAdvancement;
}): Effect.Effect<string, GitError> {
  return Effect.gen(function* () {
    const destination = yield* resolveCoordinatorRepository(input.advancement.destinationRoot);

    if (destination.target.commonDir !== input.identity.repositoryCommonDir)
      return yield* fail("verify local delivery", "Destination repository identity changed.");
    const ref = yield* gitResult(destination.target.checkoutRoot, ["symbolic-ref", "-q", "HEAD"]);

    if (ref.code !== 0 || ref.stdout !== input.advancement.destinationRef)
      return yield* fail("verify local delivery", "Destination ref changed after integration.");
    if (yield* operationInProgress(destination.target.checkoutRoot))
      return yield* fail(
        "verify local delivery",
        "Destination has a merge or rebase operation in progress.",
      );
    if (
      !(yield* ancestry(
        input.identity.repositoryCommonDir,
        input.advancement.preparedRevision,
        destination.commit,
      )) ||
      !(yield* ancestry(
        input.identity.repositoryCommonDir,
        input.acceptedRevision,
        destination.commit,
      ))
    )
      return yield* fail(
        "verify local delivery",
        "Destination no longer contains the recorded integrated revision.",
      );

    return destination.commit;
  });
}

export function applyCoordinatorAdvancement(input: {
  readonly identity: CoordinatorCheckoutIdentity;
  readonly acceptedRevision: string;
  readonly advancement: CoordinatorAdvancement;
}): Effect.Effect<string, GitError> {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Exact advancement observation and postconditions form one custody boundary.
  return Effect.gen(function* () {
    const source = yield* classifyCoordinatorCheckout(input.identity);

    if (source.kind !== "exact" || source.head !== input.acceptedRevision)
      return yield* fail("apply local delivery", "Accepted source revision changed.");
    if (yield* operationInProgress(input.identity.managedPath))
      return yield* fail(
        "apply local delivery",
        "Coordinator checkout has a merge or rebase operation in progress.",
      );
    if (yield* dirty(input.identity.managedPath, false))
      return yield* fail("apply local delivery", "Coordinator checkout has new changes.");
    const resolved = yield* resolveCoordinatorRepository(input.advancement.destinationRoot);

    if (resolved.target.commonDir !== input.identity.repositoryCommonDir)
      return yield* fail("apply local delivery", "Destination repository identity changed.");
    const ref = yield* gitResult(resolved.target.checkoutRoot, ["symbolic-ref", "-q", "HEAD"]);

    if (ref.code !== 0 || ref.stdout !== input.advancement.destinationRef)
      return yield* fail("apply local delivery", "Destination ref changed.");
    if (resolved.commit === input.advancement.preparedRevision) return resolved.commit;
    if (resolved.commit !== input.advancement.destinationHead)
      return yield* fail("apply local delivery", "Destination HEAD changed after preparation.");
    yield* requireDisjointDestinationChanges(
      resolved.target.checkoutRoot,
      input.advancement.destinationHead,
      input.advancement.preparedRevision,
    );
    const merge = yield* gitResult(resolved.target.checkoutRoot, [
      "merge",
      "--ff-only",
      "--no-overwrite-ignore",
      input.advancement.preparedRevision,
    ]);
    const observed = yield* resolveCoordinatorRepository(resolved.target.checkoutRoot);

    if (observed.commit !== input.advancement.preparedRevision) {
      if (merge.code !== 0)
        return yield* fail(
          "apply local delivery",
          `Git refused the prepared advancement: ${boundedDiagnostic(merge.stderr || merge.stdout)}`,
        );

      return yield* fail(
        "apply local delivery",
        "Prepared advancement failed exact post-validation.",
      );
    }
    if (
      !(yield* ancestry(
        input.identity.repositoryCommonDir,
        input.acceptedRevision,
        observed.commit,
      ))
    )
      return yield* fail(
        "apply local delivery",
        "Destination does not contain the accepted revision.",
      );

    return observed.commit;
  });
}

export function removeCoordinatorWorktree(input: {
  readonly identity: CoordinatorCheckoutIdentity;
  readonly expectedTip: string;
}): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    const [exists, registration] = yield* Effect.all([
      pathExists(input.identity.managedPath),
      registeredWorktree(input.identity.repositoryCommonDir, input.identity.managedPath),
    ]);

    if (!exists && registration === undefined) {
      yield* requireExactRef(
        input.identity.repositoryCommonDir,
        input.identity.ownedBranch,
        input.expectedTip,
      );

      return;
    }
    if (!exists || registration === undefined)
      return yield* fail("cleanup Coordinator checkout", "Owned worktree resources are partial.");
    const classification = yield* classifyCoordinatorCheckout(input.identity);

    if (classification.kind !== "exact" || classification.head !== input.expectedTip)
      return yield* fail(
        "cleanup Coordinator checkout",
        "Owned branch no longer has the accepted tip.",
      );
    yield* requireCleanCoordinatorCleanupSource(input.identity.managedPath);
    yield* gitDir(
      input.identity.repositoryCommonDir,
      ["worktree", "remove", "--force", input.identity.managedPath],
      true,
    );

    if (
      (yield* pathExists(input.identity.managedPath)) ||
      (yield* registeredWorktree(
        input.identity.repositoryCommonDir,
        input.identity.managedPath,
      )) !== undefined
    )
      return yield* fail(
        "cleanup Coordinator checkout",
        "Owned worktree removal was not established.",
      );
  });
}

function requireCleanCoordinatorCleanupSource(managedPath: string): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    if (yield* operationInProgress(managedPath))
      return yield* fail(
        "cleanup Coordinator checkout",
        "Coordinator checkout has a merge or rebase operation in progress.",
      );
    if (yield* dirty(managedPath, false))
      return yield* fail(
        "cleanup Coordinator checkout",
        "Coordinator checkout has new tracked or untracked changes.",
      );
  });
}

export function deleteCoordinatorBranch(input: {
  readonly identity: CoordinatorCheckoutIdentity;
  readonly expectedTip: string;
}): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    const [exists, registrations] = yield* Effect.all([
      pathExists(input.identity.managedPath),
      worktreeRegistrations(input.identity.repositoryCommonDir),
    ]);

    if (exists || hasCoordinatorRegistration(registrations, input.identity))
      return yield* fail(
        "cleanup Coordinator checkout",
        "Owned branch is still used by a worktree registration.",
      );
    yield* deleteExactRef(
      input.identity.repositoryCommonDir,
      input.identity.ownedBranch,
      input.expectedTip,
    );
  });
}

function requireAcceptedCoordinatorSource(
  identity: CoordinatorCheckoutIdentity,
  acceptedRevision: string,
): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    const source = yield* classifyCoordinatorCheckout(identity);

    if (source.kind !== "exact" || source.head !== acceptedRevision)
      return yield* fail(
        "prepare local delivery",
        "Accepted revision is not the owned branch HEAD.",
      );
    if (yield* operationInProgress(identity.managedPath))
      return yield* fail(
        "prepare local delivery",
        "Coordinator checkout has a merge or rebase operation in progress.",
      );
    if (yield* dirty(identity.managedPath, false))
      return yield* fail(
        "prepare local delivery",
        "Coordinator checkout has tracked or untracked changes.",
      );
  });
}

function authorizedCoordinatorDestination(input: {
  readonly identity: CoordinatorCheckoutIdentity;
  readonly destinationRoot: string;
  readonly destinationRef: string;
}): Effect.Effect<{ target: RepositoryTarget; commit: string }, GitError> {
  return Effect.gen(function* () {
    const destination = yield* resolveCoordinatorRepository(input.destinationRoot);

    if (destination.target.commonDir !== input.identity.repositoryCommonDir)
      return yield* fail("prepare local delivery", "Destination belongs to another repository.");
    if (
      destination.target.checkoutRoot === input.identity.managedPath ||
      input.destinationRef === input.identity.ownedBranch
    )
      return yield* fail(
        "prepare local delivery",
        "Owned Coordinator checkout cannot be its own delivery destination.",
      );
    const ref = yield* gitResult(destination.target.checkoutRoot, ["symbolic-ref", "-q", "HEAD"]);

    if (ref.code !== 0 || ref.stdout !== input.destinationRef)
      return yield* fail(
        "prepare local delivery",
        "Destination is not attached to the authorized ref.",
      );
    if (yield* operationInProgress(destination.target.checkoutRoot))
      return yield* fail(
        "prepare local delivery",
        "Destination has a merge or rebase operation in progress.",
      );

    return destination;
  });
}

function hasCoordinatorRegistration(
  registrations: readonly WorktreeRegistration[],
  identity: CoordinatorCheckoutIdentity,
): boolean {
  return registrations.some(
    ({ path, branch }) => resolve(path) === identity.managedPath || branch === identity.ownedBranch,
  );
}

function plannedRevision(
  commonDir: string,
  destination: string,
  source: string,
  message: string,
): Effect.Effect<string, GitError> {
  return Effect.gen(function* () {
    if (yield* ancestry(commonDir, destination, source)) return source;
    if (yield* ancestry(commonDir, source, destination)) return destination;
    const tree = yield* proveMergeable(commonDir, destination, source);

    return yield* gitDir(commonDir, [
      "commit-tree",
      tree,
      "-p",
      destination,
      "-p",
      source,
      "-m",
      message,
    ]);
  });
}

function requireDisjointDestinationChanges(
  cwd: string,
  from: string,
  to: string,
): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    if (yield* operationInProgress(cwd))
      return yield* fail(
        "prepare local delivery",
        "Destination has a merge or rebase operation in progress.",
      );
    const planned = new Set(
      (yield* git(cwd, ["diff", "--name-only", "-z", from, to], true)).split("\0").filter(Boolean),
    );
    const status = yield* git(
      cwd,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"],
      true,
    );

    for (const path of statusPaths(status)) {
      if (planned.has(path))
        return yield* fail(
          "prepare local delivery",
          `Destination path ${path} overlaps the prepared change.`,
        );
    }
  });
}

function statusPaths(status: string): string[] {
  const fields = status.split("\0").filter(Boolean);
  const paths: string[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];

    if (field === undefined || field.length < 3) continue;
    const pathStart = field[1] === " " && field[2] !== " " ? 2 : 3;
    paths.push(field.slice(pathStart));

    if (field[0] === "R" || field[0] === "C" || field[1] === "R" || field[1] === "C") index += 1;
  }

  return paths;
}

function operationInProgress(cwd: string): Effect.Effect<boolean, GitError> {
  return git(cwd, ["rev-parse", "--git-path", "MERGE_HEAD"]).pipe(
    Effect.flatMap((mergePath) =>
      git(cwd, ["rev-parse", "--git-path", "rebase-merge"]).pipe(
        Effect.flatMap((rebaseMerge) =>
          git(cwd, ["rev-parse", "--git-path", "rebase-apply"]).pipe(
            Effect.flatMap((rebaseApply) =>
              Effect.all([
                pathExists(resolve(cwd, mergePath)),
                pathExists(resolve(cwd, rebaseMerge)),
                pathExists(resolve(cwd, rebaseApply)),
              ]).pipe(Effect.map((entries) => entries.some(Boolean))),
            ),
          ),
        ),
      ),
    ),
  );
}

export function resolveRevision(
  target: RepositoryTarget,
  revision: string,
): Effect.Effect<string, GitError> {
  return revalidate(target).pipe(
    Effect.flatMap(() =>
      exactCommit(target.commonDir, revision, "resolve revision", target.checkoutRoot),
    ),
  );
}

/** A candidate parent is reusable only while its exact clean ref remains compacted. */
export function validateRetainedCandidate(
  operation: RepositoryOperation,
): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(operation.target);
    const output = operation.output;

    if (output?.kind !== "retained")
      return yield* fail("extend candidate", "Candidate parent has no retained output.");
    yield* requireCompactedCandidate(operation);
    yield* requireExactRef(operation.target.commonDir, operation.outputRef, output.tip);
  });
}

export function isAncestor(
  target: RepositoryTarget,
  parent: string,
  child: string,
): Effect.Effect<boolean, GitError> {
  return ancestry(target.commonDir, parent, child);
}

export function detachedPlacement(input: { agentDir: string; attemptId: string }) {
  const worktreeRoot = canonicalFuturePath(join(input.agentDir, "workgraph", "worktrees"));

  return {
    worktreePath: join(worktreeRoot, input.attemptId),
    outputRef: `refs/pi-workgraph/outputs/${input.attemptId}`,
  };
}

/** Create or recover only the exact clean detached checkout declared by the Attempt. */
export function ensureDetachedWorktree(
  operation: RepositoryOperation,
): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(operation.target);
    const base = baseCommit(operation.spec);
    yield* exactCommit(operation.target.commonDir, base, "create worktree");

    if ((yield* readRef(operation.target.commonDir, operation.outputRef)) !== undefined)
      return yield* fail("create worktree", "The Attempt private output ref already exists.");

    if (yield* recoverPlacement(operation, base)) return;
    yield* filesystem("create worktree directory", () =>
      mkdir(dirname(operation.worktreePath), { recursive: true, mode: 0o700 }),
    );
    yield* git(
      operation.target.checkoutRoot,
      ["worktree", "add", "--detach", operation.worktreePath, base],
      true,
    );
    const state = yield* ownedCheckout(operation, true);

    if (state.head !== base || state.dirty)
      return yield* fail("create worktree", "Created worktree failed exact post-validation.");
  });
}

function recoverPlacement(
  operation: RepositoryOperation,
  base: string,
): Effect.Effect<boolean, GitError> {
  return Effect.gen(function* () {
    const registration = yield* registeredWorktree(
      operation.target.commonDir,
      operation.worktreePath,
    );

    const exists = yield* pathExists(operation.worktreePath);

    if (registration === undefined && !exists) return false;

    if (registration === undefined || !exists)
      return yield* fail("create worktree", "Attempt placement is foreign or incomplete.");
    const state = yield* ownedCheckout(operation, true);

    if (state.head !== base || state.dirty)
      return yield* fail("create worktree", "Existing worktree is not the clean Attempt base.");

    return true;
  });
}

/** Classify repository commits after closure; completed reports relinquish uncommitted scratch. */
export function classifyOutput(
  operation: RepositoryOperation,
  reportCompleted = false,
): Effect.Effect<AttemptOutput, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(operation.target);

    const registration = yield* registeredWorktree(
      operation.target.commonDir,
      operation.worktreePath,
    );

    const exists = yield* pathExists(operation.worktreePath);
    const base = baseCommit(operation.spec);

    if (registration === undefined && !exists) return yield* classifyAbsentOutput(operation, base);

    if (registration === undefined || !exists)
      return yield* fail("classify output", "Attempt placement is foreign or incomplete.");

    return yield* classifyPresentOutput(operation, base, reportCompleted);
  });
}

function classifyPresentOutput(
  operation: RepositoryOperation,
  base: string,
  reportCompleted: boolean,
): Effect.Effect<AttemptOutput, GitError> {
  return Effect.gen(function* () {
    const state = yield* ownedCheckout(operation, true);

    if (!(yield* ancestry(operation.target.commonDir, base, state.head)))
      return yield* fail("classify output", "Attempt HEAD is unrelated to its exact base.");
    yield* validateCandidate(operation, state.head);

    if (!reportCompleted && state.dirty) {
      yield* createExactRef(operation.target.commonDir, operation.outputRef, state.head);

      return {
        kind: "retained" as const,
        tip: state.head,
        reason: "Dirty checkout is preserved for explicit disposition.",
      };
    }

    if (state.head === base) {
      yield* removeWorktree(operation, reportCompleted);

      return { kind: "no_output" as const };
    }

    yield* createExactRef(operation.target.commonDir, operation.outputRef, state.head);
    yield* removeWorktree(operation, reportCompleted);

    return {
      kind: "retained" as const,
      tip: state.head,
      reason: "Committed output is retained.",
    };
  });
}

function classifyAbsentOutput(
  operation: RepositoryOperation,
  base: string,
): Effect.Effect<AttemptOutput, GitError> {
  return Effect.gen(function* () {
    const tip = yield* readRef(operation.target.commonDir, operation.outputRef);

    if (tip === undefined) return { kind: "no_output" as const };

    if (!(yield* ancestry(operation.target.commonDir, base, tip)))
      return yield* fail("classify output", "Attempt output ref is unrelated to its exact base.");
    yield* validateCandidate(operation, tip);

    return { kind: "retained" as const, tip, reason: "Committed output is retained." };
  });
}

/** Validate a retained Candidate and checkpoint one exact destination advancement. */
export function prepareApplication(
  operation: RepositoryOperation,
): Effect.Effect<AttemptOutput, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(operation.target);

    return yield* prepareRetainedApplication(operation);
  });
}

/** Explicitly recover or freshly prepare after observation proves the prior effect absent. */
export function retryApplication(
  operation: RepositoryOperation,
): Effect.Effect<AttemptOutput, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(operation.target);
    const output = operation.output;

    if (output?.kind !== "applying")
      return yield* fail("apply output", "Application has no durable preparation checkpoint.");

    return yield* prepareApplicationRetry(operation, output);
  });
}

function prepareApplicationRetry(
  operation: RepositoryOperation,
  output: Extract<AttemptOutput, { kind: "applying" }>,
): Effect.Effect<AttemptOutput, GitError> {
  return Effect.gen(function* () {
    const destination = yield* destinationState(operation.target);

    if (destination.ref !== output.destinationRef)
      return yield* fail("apply output", "Destination ref changed.");

    if (destination.dirty) return yield* fail("apply output", "Destination checkout is dirty.");

    if (
      destination.head === output.destinationHead ||
      (yield* isAppliedStructure(operation.target.commonDir, output, destination.head))
    )
      return output;

    if (yield* ancestry(operation.target.commonDir, output.sourceTip, destination.head))
      return yield* fail("apply output", "Destination advanced beyond the exact candidate result.");

    if (!(yield* ancestry(operation.target.commonDir, output.sourceRoot, destination.head)))
      return yield* fail("apply output", "Destination no longer descends from the Candidate root.");
    yield* proveMergeable(operation.target.commonDir, destination.head, output.sourceTip);

    return { ...output, destinationHead: destination.head };
  });
}

function prepareRetainedApplication(
  operation: RepositoryOperation,
): Effect.Effect<AttemptOutput, GitError> {
  return Effect.gen(function* () {
    const output = operation.output;

    if (output?.kind !== "retained")
      return yield* fail("apply output", "Attempt has no retained output.");
    yield* requireCompactedCandidate(operation);

    const source = yield* requireExactRef(
      operation.target.commonDir,
      operation.outputRef,
      output.tip,
    );

    const root = candidateRoot(operation.spec);

    if (!(yield* ancestry(operation.target.commonDir, root, source)))
      return yield* fail("apply output", "Candidate does not contain its source root.");
    const destination = yield* destinationState(operation.target);

    if (destination.dirty) return yield* fail("apply output", "Destination checkout is dirty.");

    if (!(yield* ancestry(operation.target.commonDir, root, destination.head)))
      return yield* fail("apply output", "Destination no longer descends from the Candidate root.");
    yield* proveMergeable(operation.target.commonDir, destination.head, source);

    return {
      kind: "applying" as const,
      sourceRoot: root,
      sourceTip: source,
      destinationRef: destination.ref,
      destinationHead: destination.head,
    };
  });
}

/** Recover structurally or advance only the prepared attached destination with merge --ff-only. */
export function applyOutput(
  operation: RepositoryOperation,
): Effect.Effect<AttemptOutput, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(operation.target);
    const output = operation.output;

    if (output?.kind !== "applying")
      return yield* fail("apply output", "Application has no durable preparation checkpoint.");
    yield* requireCompactedCandidate(operation);
    yield* requireExactRef(operation.target.commonDir, operation.outputRef, output.sourceTip);
    const destination = yield* destinationState(operation.target);

    if (destination.ref !== output.destinationRef)
      return yield* fail("apply output", "Destination ref changed.");

    if (destination.dirty) return yield* fail("apply output", "Destination checkout is dirty.");

    const revision = yield* applicationRevision(operation, output, destination.head);
    const final = yield* destinationState(operation.target);

    if (
      final.ref !== output.destinationRef ||
      final.head !== revision ||
      final.dirty ||
      !(yield* ancestry(operation.target.commonDir, output.sourceRoot, revision)) ||
      !(yield* ancestry(operation.target.commonDir, output.sourceTip, revision))
    )
      return yield* fail("apply output", "Applied destination failed exact post-validation.");

    return { kind: "applied" as const, revision, cleanupTip: output.sourceTip };
  });
}

function applicationRevision(
  operation: RepositoryOperation,
  output: Extract<AttemptOutput, { kind: "applying" }>,
  head: string,
): Effect.Effect<string, GitError> {
  return Effect.gen(function* () {
    if (yield* isAppliedStructure(operation.target.commonDir, output, head)) return head;

    if (head !== output.destinationHead)
      return yield* fail("apply output", "Destination changed after application preparation.");

    if (yield* ancestry(operation.target.commonDir, output.sourceTip, head)) return head;

    if (yield* ancestry(operation.target.commonDir, head, output.sourceTip)) {
      yield* mergeIntoDestination(operation.target.checkoutRoot, output.sourceTip);

      return output.sourceTip;
    }

    const tree = yield* proveMergeable(operation.target.commonDir, head, output.sourceTip);

    const merge = yield* gitDir(operation.target.commonDir, [
      "commit-tree",
      tree,
      "-p",
      head,
      "-p",
      output.sourceTip,
      "-m",
      `Integrate Workgraph output ${operation.attemptId}`,
    ]);

    yield* mergeIntoDestination(operation.target.checkoutRoot, merge);

    return merge;
  });
}

function mergeIntoDestination(cwd: string, revision: string): Effect.Effect<string, GitError> {
  return git(cwd, ["merge", "--ff-only", "--no-overwrite-ignore", revision]);
}

/** Remove still-exact clean source resources only after the applied checkpoint is durable. */
export function cleanupAppliedOutput(
  operation: RepositoryOperation,
): Effect.Effect<AttemptOutput, GitError> {
  return Effect.gen(function* () {
    const output = operation.output;

    if (output?.kind !== "applied")
      return yield* fail("cleanup applied output", "Attempt has no applied output to clean up.");

    if (output.cleanupTip === undefined) return output;
    yield* revalidate(operation.target);
    yield* requireCompactedCandidate(operation);
    yield* deleteExactRef(operation.target.commonDir, operation.outputRef, output.cleanupTip);
    const { cleanupTip: _cleanupTip, ...cleaned } = output;

    return cleaned;
  });
}

export function prepareDiscard(
  operation: RepositoryOperation,
  reason: string,
): Effect.Effect<AttemptOutput, GitError> {
  if (reason.trim().length === 0)
    return Effect.fail(error("discard output", "Discard requires a reason."));
  const output = operation.output;

  if (output?.kind === "discarding") return Effect.succeed(output);

  if (output?.kind === "retained")
    return Effect.succeed({ kind: "discarding", tip: output.tip, reason });

  if (output?.kind === "applied" && output.cleanupTip !== undefined)
    return Effect.succeed({
      kind: "discarding",
      tip: output.cleanupTip,
      reason,
      applied: { revision: output.revision },
    });

  return Effect.fail(error("discard output", "Attempt has no releasable output."));
}

/** Destructively remove only resources named by a durable exact-attempt discard checkpoint. */
export function discardOutput(
  operation: RepositoryOperation,
): Effect.Effect<AttemptOutput, GitError> {
  return Effect.gen(function* () {
    yield* revalidate(operation.target);
    const output = operation.output;

    if (output?.kind !== "discarding")
      return yield* fail("discard output", "Discard has no durable checkpoint.");

    const registration = yield* registeredWorktree(
      operation.target.commonDir,
      operation.worktreePath,
    );

    const exists = yield* pathExists(operation.worktreePath);

    if (registration === undefined && !exists) {
      yield* deleteExactRef(operation.target.commonDir, operation.outputRef, output.tip);
    } else {
      if (registration === undefined || !exists)
        return yield* fail("discard output", "Attempt placement is foreign or incomplete.");
      yield* requireExactRef(operation.target.commonDir, operation.outputRef, output.tip);
      const state = yield* ownedCheckout(operation, true);

      if (state.head !== output.tip)
        return yield* fail(
          "discard output",
          "Attempt checkout HEAD no longer matches its checkpoint.",
        );
      yield* git(operation.worktreePath, ["reset", "--hard", output.tip]);
      yield* git(operation.worktreePath, ["clean", "-fdx"], true);
      yield* removeWorktree(operation);
      yield* deleteExactRef(operation.target.commonDir, operation.outputRef, output.tip);
    }

    return output.applied === undefined
      ? { kind: "discarded" as const, reason: output.reason }
      : { kind: "applied" as const, ...output.applied, cleanupReason: output.reason };
  });
}

function baseCommit(spec: AttemptSpec): string {
  if (spec.base.kind !== "repository")
    throw error("inspect output", "Attempt has no repository base.");

  return spec.base.baseCommit;
}

function candidateRoot(spec: AttemptSpec): string {
  return spec.lineage?.candidateRoot ?? baseCommit(spec);
}

function validateCandidate(
  operation: RepositoryOperation,
  head: string,
): Effect.Effect<void, GitError> {
  const lineage = operation.spec.lineage?.candidateOf;

  if (lineage?.kind !== "integrate") return Effect.void;

  return Effect.all([
    ancestry(operation.target.commonDir, baseCommit(operation.spec), head),
    ancestry(operation.target.commonDir, lineage.sourceTip, head),
  ]).pipe(
    Effect.flatMap(([destination, source]) =>
      destination && source
        ? Effect.void
        : fail(
            "classify output",
            "Integration output lacks required destination or source ancestry.",
          ),
    ),
  );
}

function requireCompactedCandidate(operation: RepositoryOperation): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    const registration = yield* registeredWorktree(
      operation.target.commonDir,
      operation.worktreePath,
    );

    const exists = yield* pathExists(operation.worktreePath);

    if (registration !== undefined || exists)
      return yield* fail("apply output", "Only clean compacted candidate output can be applied.");
  });
}

function destinationState(
  target: RepositoryTarget,
): Effect.Effect<{ ref: string; head: string; dirty: boolean }, GitError> {
  return Effect.gen(function* () {
    const refResult = yield* gitResult(target.checkoutRoot, ["symbolic-ref", "-q", "HEAD"]);

    if (refResult.code !== 0 || !refResult.stdout.startsWith("refs/heads/"))
      return yield* fail("apply output", "Destination must be an attached branch checkout.");

    return {
      ref: refResult.stdout,
      head: yield* exactCommit(target.commonDir, "HEAD", "apply output", target.checkoutRoot),
      dirty: yield* destinationDirty(target.checkoutRoot),
    };
  });
}

function isAppliedStructure(
  commonDir: string,
  output: Extract<AttemptOutput, { kind: "applying" }>,
  revision: string,
): Effect.Effect<boolean, GitError> {
  return Effect.gen(function* () {
    if (
      revision === output.sourceTip &&
      (yield* ancestry(commonDir, output.destinationHead, revision))
    )
      return true;
    const parentsText = yield* gitDir(commonDir, ["show", "-s", "--format=%P", revision], true);
    const parents = parentsText.length === 0 ? [] : parentsText.split(" ");

    if (
      parents.length !== 2 ||
      parents[0] !== output.destinationHead ||
      parents[1] !== output.sourceTip
    )
      return false;
    const expectedTree = yield* proveMergeable(commonDir, output.destinationHead, output.sourceTip);
    const actualTree = yield* gitDir(commonDir, ["show", "-s", "--format=%T", revision]);

    return actualTree === expectedTree;
  });
}

function proveMergeable(
  commonDir: string,
  destination: string,
  source: string,
): Effect.Effect<string, GitError> {
  return gitDir(commonDir, ["merge-tree", "--write-tree", destination, source]).pipe(
    Effect.mapError(() =>
      error("apply output", "Candidate conflicts with the destination; nothing was mutated."),
    ),
  );
}

function ownedCheckout(
  operation: RepositoryOperation,
  requireDetached: boolean,
): Effect.Effect<CheckoutState, GitError> {
  return Effect.gen(function* () {
    const registered = yield* registeredWorktree(
      operation.target.commonDir,
      operation.worktreePath,
    );

    if (registered === undefined)
      return yield* fail("inspect output", "Attempt checkout is not an exact registered worktree.");
    const actualPath = yield* filesystem("inspect output", () => realpath(operation.worktreePath));

    if (actualPath !== operation.worktreePath)
      return yield* fail("inspect output", "Attempt checkout path is not its real placement.");

    const common = yield* git(operation.worktreePath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);

    const actualCommon = yield* filesystem("inspect output", () =>
      realpath(resolve(operation.worktreePath, common)),
    );

    if (actualCommon !== operation.target.commonDir)
      return yield* fail("inspect output", "Attempt checkout belongs to another repository.");

    if (requireDetached) {
      const symbolic = yield* gitResult(operation.worktreePath, ["symbolic-ref", "-q", "HEAD"]);

      if (symbolic.code === 0)
        return yield* fail("inspect output", "Attempt checkout is no longer detached.");
    }

    return {
      head: yield* exactCommit(
        operation.target.commonDir,
        "HEAD",
        "inspect output",
        operation.worktreePath,
      ),
      dirty: yield* attemptDirty(operation.worktreePath),
    };
  });
}

function removeWorktree(
  operation: RepositoryOperation,
  force = false,
): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    const state = yield* ownedCheckout(operation, false);

    if (!force && state.dirty)
      return yield* fail("remove worktree", "Refusing to remove a dirty Attempt checkout.");
    yield* git(
      operation.target.checkoutRoot,
      ["worktree", "remove", ...(force ? ["--force"] : []), operation.worktreePath],
      true,
    );

    if (
      (yield* pathExists(operation.worktreePath)) ||
      (yield* registeredWorktree(operation.target.commonDir, operation.worktreePath)) !== undefined
    )
      return yield* fail("remove worktree", "Attempt checkout removal could not be established.");
  });
}

function revalidate(target: RepositoryTarget): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    const root = yield* filesystem("revalidate repository", () => realpath(target.checkoutRoot));

    const commonText = yield* git(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);

    const common = yield* filesystem("revalidate repository", () =>
      realpath(resolve(root, commonText)),
    );

    const inside = yield* git(root, ["rev-parse", "--is-inside-work-tree"]);
    const bare = yield* git(root, ["rev-parse", "--is-bare-repository"]);

    if (
      root !== target.checkoutRoot ||
      common !== target.commonDir ||
      inside !== "true" ||
      bare !== "false"
    )
      return yield* fail("revalidate repository", "Stored Task repository identity changed.");
  });
}

function registeredWorktree(
  commonDir: string,
  path: string,
): Effect.Effect<string | undefined, GitError> {
  return gitDir(commonDir, ["worktree", "list", "--porcelain", "-z"]).pipe(
    Effect.map((text) => {
      for (const field of text.split("\0")) {
        if (!field.startsWith("worktree ")) continue;
        const candidate = field.slice("worktree ".length);

        if (resolve(candidate) === path) return candidate;
      }

      return undefined;
    }),
  );
}

function destinationDirty(cwd: string): Effect.Effect<boolean, GitError> {
  return dirty(cwd, false);
}

function attemptDirty(cwd: string): Effect.Effect<boolean, GitError> {
  return dirty(cwd, true);
}

function dirty(cwd: string, includeIgnored: boolean): Effect.Effect<boolean, GitError> {
  const statusArgs = ["status", "--porcelain", "--untracked-files=all"];

  if (includeIgnored) statusArgs.push("--ignored=matching");

  return Effect.all([
    git(cwd, statusArgs, true),
    gitResult(cwd, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]),
  ]).pipe(
    Effect.flatMap(([status, mergeHead]) => {
      if (mergeHead.code !== 0 && mergeHead.code !== 1)
        return fail("inspect checkout", "Git could not inspect merge state.");

      return Effect.succeed(status.length > 0 || mergeHead.code === 0);
    }),
  );
}

function ancestry(
  commonDir: string,
  parent: string,
  child: string,
): Effect.Effect<boolean, GitError> {
  return gitDirResult(commonDir, ["merge-base", "--is-ancestor", parent, child]).pipe(
    Effect.flatMap((result) => {
      if (result.code === 0) return Effect.succeed(true);

      if (result.code === 1) return Effect.succeed(false);

      return fail("inspect ancestry", "Git could not inspect candidate ancestry.");
    }),
  );
}

function exactCommit(
  commonDir: string,
  revision: string,
  operation: string,
  cwd?: string,
): Effect.Effect<string, GitError> {
  const command =
    cwd === undefined
      ? gitDir(commonDir, ["rev-parse", "--verify", `${revision}^{commit}`])
      : git(cwd, ["rev-parse", "--verify", `${revision}^{commit}`]);

  return command.pipe(
    Effect.filterOrFail(
      (commit) => /^[0-9a-f]{40,64}$/.test(commit),
      () => error(operation, "Revision did not resolve to one exact commit."),
    ),
    Effect.mapError(() => error(operation, "Revision did not resolve to one exact commit.")),
  );
}

function readRef(commonDir: string, ref: string): Effect.Effect<string | undefined, GitError> {
  return gitDirResult(commonDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).pipe(
    Effect.flatMap((result) => {
      if (result.code === 0) return Effect.succeed(result.stdout);

      // oxlint-disable-next-line effecttsgo/effect-succeed-with-void -- This branch inhabits the explicit optional-ref result.
      if (result.code === 1) return Effect.succeed<string | undefined>(undefined);

      return fail("inspect output ref", "Private output ref could not be inspected.");
    }),
  );
}

function requireExactRef(
  commonDir: string,
  ref: string,
  tip: string,
): Effect.Effect<string, GitError> {
  return readRef(commonDir, ref).pipe(
    Effect.filterOrFail(
      (actual): actual is string => actual === tip,
      () => error("inspect output ref", "Private output ref is absent or was repointed."),
    ),
  );
}

function createExactRef(
  commonDir: string,
  ref: string,
  tip: string,
): Effect.Effect<void, GitError> {
  return readRef(commonDir, ref).pipe(
    Effect.flatMap((actual) => {
      if (actual === tip) return Effect.void;

      if (actual !== undefined)
        return fail("retain output", "Private output ref was already owned by other content.");

      return gitDir(commonDir, ["update-ref", ref, tip, "0".repeat(tip.length)], true).pipe(
        Effect.asVoid,
      );
    }),
  );
}

function deleteExactRef(
  commonDir: string,
  ref: string,
  tip: string,
): Effect.Effect<void, GitError> {
  return readRef(commonDir, ref).pipe(
    Effect.flatMap((actual) => {
      if (actual === undefined) return Effect.void;

      if (actual !== tip)
        return fail("discard output", "Private output ref was repointed; nothing was deleted.");

      return gitDir(commonDir, ["update-ref", "-d", ref, tip], true).pipe(Effect.asVoid);
    }),
  );
}

function pathExists(path: string): Effect.Effect<boolean, GitError> {
  return Effect.tryPromise({
    try: () =>
      stat(path).then(
        () => true,
        (cause: unknown) => {
          if (isErrno(cause, "ENOENT")) return false;
          throw cause;
        },
      ),
    catch: () => error("inspect path", "Attempt placement could not be inspected."),
  });
}

function isErrno(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

function filesystem<A>(operation: string, run: () => Promise<A>): Effect.Effect<A, GitError> {
  return Effect.tryPromise({
    try: run,
    catch: () => error(operation, "Filesystem operation failed."),
  });
}

function git(cwd: string, args: string[], allowEmpty = false): Effect.Effect<string, GitError> {
  return gitResult(cwd, args).pipe(Effect.flatMap((result) => checked(args, result, allowEmpty)));
}

function gitDir(
  commonDir: string,
  args: string[],
  allowEmpty = false,
): Effect.Effect<string, GitError> {
  return gitDirResult(commonDir, args).pipe(
    Effect.flatMap((result) => checked(args, result, allowEmpty)),
  );
}

function gitDirResult(commonDir: string, args: string[]): Effect.Effect<CommandResult, GitError> {
  return command([`--git-dir=${commonDir}`, ...args]);
}

function gitResult(cwd: string, args: string[]): Effect.Effect<CommandResult, GitError> {
  return command(["-C", cwd, ...args]);
}

function command(args: string[]): Effect.Effect<CommandResult, GitError> {
  const process = ChildProcess.make("git", args, {
    cwd: globalThis.process.cwd(),
    stdin: "ignore",
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(process);

      const result = yield* Effect.all(
        {
          code: child.exitCode,
          stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        },
        { concurrency: "unbounded" },
      );

      return {
        code: Number(result.code),
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      };
    }),
  ).pipe(
    Effect.mapError(() => error(args.join(" "), "Git process failed.")),
    Effect.provide(childProcessLayer),
  );
}

function checked(
  args: readonly string[],
  result: CommandResult,
  allowEmpty: boolean,
): Effect.Effect<string, GitError> {
  if (result.code !== 0)
    return fail(args.join(" "), result.stderr || result.stdout || "Git command failed.");

  if (!allowEmpty && result.stdout.length === 0)
    return fail(args.join(" "), "Git returned no output.");

  return Effect.succeed(result.stdout);
}

function fail(operation: string, message: string): Effect.Effect<never, GitError> {
  return Effect.fail(error(operation, message));
}

function error(operation: string, message: string): GitError {
  return new GitError({ operation, message });
}

function canonicalFuturePath(path: string): string {
  const missing: string[] = [];
  let ancestor = resolve(path);

  while (!existsSync(ancestor)) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }

  return join(realpathSync(ancestor), ...missing);
}
