/* oxlint-disable effecttsgo/async-function, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/require-readable-spacing -- Native Git and filesystem observation are intentionally one Promise boundary; command failures are decoded below. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { resolveCoordinatorRepository } from "../repository.js";

const execFileAsync = promisify(execFile);

export interface CheckoutFacts {
  readonly checkoutId: string;
  readonly managedPath: string;
  readonly repositoryCommonDir: string;
  readonly ownedBranch: string;
  readonly sourceHead: string;
  readonly created: boolean;
  readonly reused: boolean;
  readonly diagnostic?: string;
}

type Identity = Omit<CheckoutFacts, "sourceHead" | "created" | "reused" | "diagnostic">;

type CommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

type WorktreeRegistration = {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
};

type Classification =
  | { readonly kind: "absent" }
  | { readonly kind: "exact"; readonly head: string };

export async function createCheckout(input: {
  readonly agentDir: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly path?: string;
}): Promise<CheckoutFacts> {
  const resolved = await Effect.runPromise(resolveCoordinatorRepository(input.cwd, input.path));
  const identity = await checkoutIdentity(
    input.agentDir,
    input.sessionId,
    resolved.target.commonDir,
  );
  const initial = await classify(identity);

  if (initial.kind === "exact") return checkoutFacts(identity, resolved.commit, false, true);

  await ensureAllocationParent(identity.managedPath);
  const branch = identity.ownedBranch.slice("refs/heads/".length);
  let placement: CommandResult;

  try {
    placement = await gitResult(resolved.target.checkoutRoot, [
      "worktree",
      "add",
      "-b",
      branch,
      identity.managedPath,
      resolved.commit,
    ]);
  } catch (cause) {
    placement = {
      code: -1,
      stdout: "",
      stderr: cause instanceof Error ? cause.message : "Git response was not observable.",
    };
  }

  const postcondition = await classify(identity);

  if (postcondition.kind === "exact") {
    const diagnostic =
      placement.code === 0
        ? undefined
        : boundedDiagnostic(placement.stderr || placement.stdout || "Git returned a failure.");

    const facts = checkoutFacts(identity, resolved.commit, true, false);

    return diagnostic === undefined ? facts : { ...facts, diagnostic };
  }

  if (placement.code === 0)
    throw new Error("Created Coordinator checkout failed exact post-validation.");

  throw new Error(
    `Git worktree creation failed without allocating resources: ${boundedDiagnostic(
      placement.stderr || placement.stdout || "Git returned a failure.",
    )}`,
  );
}

async function ensureAllocationParent(managedPath: string): Promise<void> {
  const checkoutRoot = dirname(managedPath);
  const workgraphRoot = dirname(checkoutRoot);

  for (const path of [workgraphRoot, checkoutRoot]) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
    }

    const entry = await observed("inspect allocation parent", () => lstat(path));

    if (!entry.isDirectory() || entry.isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error("Coordinator checkout parent is not an owned directory.");
    await chmod(path, 0o700);
  }
}

async function checkoutIdentity(
  agentDir: string,
  sessionId: string,
  commonDir: string,
): Promise<Identity> {
  const canonicalAgentDir = await realpath(agentDir);
  const checkoutId = createHash("sha256")
    .update(frame(sessionId))
    .update(frame(commonDir))
    .digest("hex");

  return {
    checkoutId,
    managedPath: join(canonicalAgentDir, "workgraph", "coordinator-checkouts", checkoutId),
    repositoryCommonDir: commonDir,
    ownedBranch: `refs/heads/pi-workgraph/coordinators/${checkoutId}`,
  };
}

function frame(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));

  return Buffer.concat([length, bytes]);
}

async function classify(identity: Identity): Promise<Classification> {
  const [entry, reference, registrations] = await Promise.all([
    pathEntry(identity.managedPath),
    directReference(identity.repositoryCommonDir, identity.ownedBranch),
    worktreeRegistrations(identity.repositoryCommonDir),
  ]);
  const registration = registrations.find(
    (candidate) => resolve(candidate.path) === identity.managedPath,
  );

  if (entry === undefined && reference === undefined && registration === undefined)
    return { kind: "absent" };

  if (entry === undefined || reference === undefined || registration === undefined)
    throw new Error("Coordinator checkout resources are partial or have the wrong identity.");

  return inspectExact(identity, entry, reference, registration);
}

async function inspectExact(
  identity: Identity,
  entry: Awaited<ReturnType<typeof lstat>>,
  reference: string,
  registration: WorktreeRegistration,
): Promise<Classification> {
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error("Managed checkout path is not an owned directory.");
  const actualPath = await observed("inspect managed checkout path", () =>
    realpath(identity.managedPath),
  );

  if (actualPath !== identity.managedPath)
    throw new Error("Managed checkout path is symlinked or moved.");

  if (registration.branch !== identity.ownedBranch || registration.head !== reference)
    throw new Error("Managed checkout registration does not match its owned branch.");
  const gitEntry = await observed("inspect managed checkout backlink", () =>
    lstat(join(identity.managedPath, ".git")),
  );

  if (!gitEntry.isFile() || gitEntry.isSymbolicLink())
    throw new Error("Managed checkout backlink is not an owned regular file.");
  const backlink = await observed("read managed checkout backlink", () =>
    readFile(join(identity.managedPath, ".git"), "utf8"),
  );
  const adminText = await git(identity.managedPath, ["rev-parse", "--absolute-git-dir"]);
  const adminDir = await observed("resolve managed checkout backlink", () => realpath(adminText));
  const backlinkMatch = /^gitdir: (.+)\r?\n?$/.exec(backlink);

  if (
    backlinkMatch?.[1] === undefined ||
    (await realpath(resolve(identity.managedPath, backlinkMatch[1]))) !== adminDir
  )
    throw new Error("Managed checkout backlink does not match its registration.");
  const commonText = await git(identity.managedPath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const commonDir = await observed("resolve managed repository identity", () =>
    realpath(commonText),
  );

  if (commonDir !== identity.repositoryCommonDir)
    throw new Error("Managed checkout belongs to another repository.");
  const attached = await gitResult(identity.managedPath, ["symbolic-ref", "-q", "HEAD"]);

  if (attached.code !== 0 || attached.stdout !== identity.ownedBranch)
    throw new Error("Managed checkout is detached or switched to another branch.");
  const head = await exactCommit(identity.managedPath, "HEAD");

  if (head !== reference) throw new Error("Managed checkout HEAD and owned branch disagree.");

  return { kind: "exact", head };
}

async function directReference(commonDir: string, branch: string): Promise<string | undefined> {
  const inspected = await gitDirResult(commonDir, [
    "for-each-ref",
    "--format=%(symref)%00%(objectname)",
    branch,
  ]);

  if (inspected.code !== 0) throw new Error("Owned Coordinator branch could not be inspected.");

  if (inspected.stdout.length === 0) return undefined;
  const separator = inspected.stdout.indexOf("\0");

  if (separator < 0) throw new Error("Owned Coordinator branch identity is unreadable.");

  if (inspected.stdout.slice(0, separator).length > 0)
    throw new Error("Owned Coordinator branch is a symbolic ref.");

  return exactCommit(commonDir, branch, true);
}

async function worktreeRegistrations(commonDir: string): Promise<WorktreeRegistration[]> {
  const text = await gitDir(commonDir, ["worktree", "list", "--porcelain", "-z"]);
  const registrations: WorktreeRegistration[] = [];
  let current: WorktreeRegistration | undefined;

  for (const field of text.split("\0")) {
    if (field.startsWith("worktree ")) {
      if (current !== undefined) registrations.push(current);
      current = { path: field.slice("worktree ".length) };
    } else if (current !== undefined && field.startsWith("HEAD ")) {
      current = { ...current, head: field.slice("HEAD ".length) };
    } else if (current !== undefined && field.startsWith("branch ")) {
      current = { ...current, branch: field.slice("branch ".length) };
    }
  }

  if (current !== undefined) registrations.push(current);

  return registrations;
}

async function pathEntry(path: string) {
  try {
    return await lstat(path);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw new Error("Managed checkout path could not be inspected.", { cause });
  }
}

async function exactCommit(cwdOrCommonDir: string, revision: string, gitDirectory = false) {
  const result = gitDirectory
    ? await gitDir(cwdOrCommonDir, ["rev-parse", "--verify", `${revision}^{commit}`])
    : await git(cwdOrCommonDir, ["rev-parse", "--verify", `${revision}^{commit}`]);

  if (!/^[0-9a-f]{40,64}$/.test(result))
    throw new Error("Revision did not resolve to one exact commit.");

  return result;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return checked(await gitResult(cwd, args));
}

async function gitDir(commonDir: string, args: string[]): Promise<string> {
  return checked(await gitDirResult(commonDir, args));
}

async function gitResult(cwd: string, args: string[]): Promise<CommandResult> {
  return command(["-C", cwd, ...args]);
}

async function gitDirResult(commonDir: string, args: string[]): Promise<CommandResult> {
  return command([`--git-dir=${commonDir}`, ...args]);
}

async function command(args: string[]): Promise<CommandResult> {
  try {
    const result = await execFileAsync("git", args, { encoding: "utf8" });

    return { code: 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && typeof cause.code === "number") {
      const failed = cause as Error & { code: number; stdout?: string; stderr?: string };

      return {
        code: failed.code,
        stdout: failed.stdout?.trim() ?? "",
        stderr: failed.stderr?.trim() ?? "",
      };
    }

    throw new Error("Git process could not be observed.", { cause });
  }
}

function checked(result: CommandResult): string {
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Git command failed.");

  return result.stdout;
}

function checkoutFacts(
  identity: Identity,
  sourceHead: string,
  created: boolean,
  reused: boolean,
): CheckoutFacts {
  return { ...identity, sourceHead, created, reused };
}

async function observed<A>(operation: string, run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch (cause) {
    throw new Error(`${operation} failed.`, { cause });
  }
}

function boundedDiagnostic(message: string): string {
  return message.replace(/\s+/g, " ").slice(0, 500);
}
