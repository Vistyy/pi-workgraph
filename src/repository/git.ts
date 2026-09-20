import { existsSync, realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Data, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { TaskTarget } from "../domain/records.js";
import { childProcessLayer } from "../node-platform.js";

export type RepositoryTarget = Extract<TaskTarget, { kind: "repository" }>;

export class GitError extends Data.TaggedError("GitError")<{
  readonly operation: string;
  readonly message: string;
}> {}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly timeout?: number;
}

export interface WorktreeRegistration {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly locked: boolean;
}

export type ResolvedTaskTarget =
  | { readonly target: Extract<TaskTarget, { kind: "directory" }> }
  | { readonly target: RepositoryTarget; readonly commit: string };

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

    const [inside, bare] = yield* Effect.all([
      git(path, ["rev-parse", "--is-inside-work-tree"]),
      git(path, ["rev-parse", "--is-bare-repository"]),
    ]);

    if (inside !== "true" || bare !== "false")
      return yield* fail("resolve target", "Bare repositories are not valid Task targets.");

    const checkoutRoot = yield* git(path, ["rev-parse", "--show-toplevel"]).pipe(
      Effect.flatMap((root) => filesystem("resolve checkout root", () => realpath(root))),
    );

    const commonText = yield* git(path, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);

    const commonDir = yield* filesystem("resolve common directory", () =>
      realpath(resolve(path, commonText)),
    );

    const commit = yield* exactCommit(commonDir, input.revision ?? "HEAD", "resolve target", path);

    return { target: { kind: "repository" as const, checkoutRoot, commonDir }, commit };
  });
}

export function revalidate(target: RepositoryTarget): Effect.Effect<void, GitError> {
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

    const [inside, bare] = yield* Effect.all([
      git(root, ["rev-parse", "--is-inside-work-tree"]),
      git(root, ["rev-parse", "--is-bare-repository"]),
    ]);

    if (
      root !== target.checkoutRoot ||
      common !== target.commonDir ||
      inside !== "true" ||
      bare !== "false"
    )
      return yield* fail("revalidate repository", "Stored Task repository identity changed.");
  });
}

export function worktreeRegistrations(
  commonDir: string,
): Effect.Effect<WorktreeRegistration[], GitError> {
  return gitDir(commonDir, ["worktree", "list", "--porcelain", "-z"]).pipe(
    Effect.map(parseWorktreeRegistrations),
  );
}

function parseWorktreeRegistrations(text: string): WorktreeRegistration[] {
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
}

function applyWorktreeField(
  registration: WorktreeRegistration,
  field: string,
): WorktreeRegistration {
  if (field.startsWith("HEAD ")) return { ...registration, head: field.slice(5) };

  if (field.startsWith("branch ")) return { ...registration, branch: field.slice(7) };

  if (field === "locked" || field.startsWith("locked ")) return { ...registration, locked: true };

  return registration;
}

export function registeredWorktree(
  commonDir: string,
  path: string,
): Effect.Effect<WorktreeRegistration | undefined, GitError> {
  return worktreeRegistrations(commonDir).pipe(
    Effect.map((registrations) =>
      registrations.find((registration) => resolve(registration.path) === path),
    ),
  );
}

export function ancestry(
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

export function exactCommit(
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

export function dirty(cwd: string, includeScratch: boolean): Effect.Effect<boolean, GitError> {
  const statusArgs = [
    "status",
    "--porcelain",
    includeScratch ? "--untracked-files=all" : "--untracked-files=no",
  ];

  if (includeScratch) statusArgs.push("--ignored=matching");

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

export function filesystem<A>(
  operation: string,
  run: () => Promise<A>,
): Effect.Effect<A, GitError> {
  return Effect.tryPromise({
    try: run,
    catch: () => error(operation, "Filesystem operation failed."),
  });
}

export function git(
  cwd: string,
  args: string[],
  allowEmpty = false,
): Effect.Effect<string, GitError> {
  return gitResult(cwd, args).pipe(Effect.flatMap((result) => checked(args, result, allowEmpty)));
}

export function gitDir(
  commonDir: string,
  args: string[],
  allowEmpty = false,
): Effect.Effect<string, GitError> {
  return gitDirResult(commonDir, args).pipe(
    Effect.flatMap((result) => checked(args, result, allowEmpty)),
  );
}

export function gitDirResult(
  commonDir: string,
  args: string[],
  options?: GitCommandOptions,
): Effect.Effect<CommandResult, GitError> {
  return command([`--git-dir=${commonDir}`, ...args], options);
}

export function gitResult(
  cwd: string,
  args: string[],
  options?: GitCommandOptions,
): Effect.Effect<CommandResult, GitError> {
  return command(["-C", cwd, ...args], options);
}

export function gitDirWithOptions(
  commonDir: string,
  args: string[],
  options: GitCommandOptions,
  allowEmpty = false,
): Effect.Effect<string, GitError> {
  return gitDirResult(commonDir, args, options).pipe(
    Effect.flatMap((result) => checked(args, result, allowEmpty)),
  );
}

export function fail(operation: string, message: string): Effect.Effect<never, GitError> {
  return Effect.fail(error(operation, message));
}

export function error(operation: string, message: string): GitError {
  return new GitError({ operation, message });
}

export function isErrno(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

export function canonicalFuturePath(path: string): string {
  const missing: string[] = [];
  let ancestor = resolve(path);

  while (!existsSync(ancestor)) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }

  return join(realpathSync(ancestor), ...missing);
}

function command(
  args: string[],
  options: GitCommandOptions = {},
): Effect.Effect<CommandResult, GitError> {
  const process = ChildProcess.make("git", args, {
    cwd: globalThis.process.cwd(),
    stdin: "ignore",
    env: options.env,
  });

  const execution = Effect.scoped(
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
  );

  return (
    options.timeout === undefined
      ? execution
      : execution.pipe(
          Effect.timeoutOrElse({
            duration: options.timeout,
            orElse: () => fail(args.join(" "), "Git command timed out."),
          }),
        )
  ).pipe(
    Effect.mapError((cause) =>
      cause instanceof GitError ? cause : error(args.join(" "), "Git process failed."),
    ),
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
