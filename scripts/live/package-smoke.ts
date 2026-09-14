/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/global-timers, effecttsgo/node-builtin-import -- This disposable consumer owns native package commands, timing, deadline, and cleanup. */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFilePromise = promisify(execFile);

const checkout = process.cwd();

const started = Date.now();

const controller = new AbortController();

const deadlineTimer = setTimeout(
  () => controller.abort(new Error("verify:package exceeded its 180-second overall deadline.")),
  180_000,
);

let parent: string | undefined;

async function command(cwd: string, file: string, args: string[]): Promise<string> {
  const result = await execFilePromise(file, args, {
    cwd,
    env: process.env,
    signal: controller.signal,
    timeout: 30_000,
    maxBuffer: 2_000_000,
  });

  return result.stdout.trim();
}

async function smokePackage(): Promise<void> {
  parent = await mkdtemp(join(tmpdir(), "workgraph-package-smoke-"));
  const packed = await command(checkout, "pnpm", ["pack", "--pack-destination", parent]);
  const tarball = packed.split("\n").at(-1);

  if (tarball === undefined || tarball === "")
    throw new Error("pnpm pack returned no tarball path.");
  const tarballPath = isAbsolute(tarball) ? tarball : join(parent, tarball);
  const consumer = join(parent, "consumer");
  await mkdir(consumer);
  await command(consumer, "npm", ["init", "--yes"]);
  await command(consumer, "npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    tarballPath,
  ]);
  const packageRoot = join(consumer, "node_modules/@vistyy/pi-workgraph");
  const agentDir = join(parent, "agent");
  await mkdir(agentDir);

  const modules = ["extensions/coordinator.ts", "extensions/worker.ts"].map((path) =>
    join(packageRoot, path),
  );

  await command(consumer, "node", [
    "--input-type=module",
    "--eval",
    `
      import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
      const [coordinatorPath, workerPath] = ${JSON.stringify(modules)};
      const agentDir = ${JSON.stringify(agentDir)};
      const one = (result, label, path) => {
        if (result.errors.length > 0)
          throw new Error(label + " load failed: " + JSON.stringify(result.errors));
        const loaded = result.extensions.find((extension) => extension.resolvedPath === path);
        if (loaded === undefined) throw new Error(label + " factory was not loaded.");
        return loaded;
      };
      delete process.env.PI_WORKGRAPH_ROLE;
      const coordinator = one(
        await discoverAndLoadExtensions([coordinatorPath], process.cwd(), agentDir),
        "coordinator",
        coordinatorPath,
      );
      if (!coordinator.tools.has("workgraph_implement") || !coordinator.commands.has("calm"))
        throw new Error("Packaged coordinator factory did not register its extension surface.");
      process.env.PI_WORKGRAPH_ROLE = "research";
      const worker = one(
        await discoverAndLoadExtensions([workerPath], process.cwd(), agentDir),
        "Worker",
        workerPath,
      );
      if (!worker.tools.has("workgraph_report") || worker.tools.has("workgraph_plan"))
        throw new Error("Packaged Worker factory did not register its research surface.");
    `,
  ]);
  process.stdout.write(
    `${JSON.stringify({ status: "passed", boundary: "pack/install/load/extension-factories", totalMs: Date.now() - started })}\n`,
  );
}

try {
  await smokePackage();
} catch (cause) {
  const failure: unknown = controller.signal.aborted ? controller.signal.reason : cause;
  process.stderr.write(
    `verify:package failed at the pack/install/load/extension-factories boundary. Installation may require registry access for uncached peers and dependencies. ${failure instanceof Error ? failure.message : String(failure)}\n`,
  );
  process.exitCode = 1;
} finally {
  clearTimeout(deadlineTimer);

  if (parent !== undefined) await rm(parent, { recursive: true, force: true });
}
