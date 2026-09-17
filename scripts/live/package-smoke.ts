/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/global-timers -- This disposable consumer owns native package commands, timing, deadline, and cleanup. */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
  parent = await mkdtemp(join(tmpdir(), "workgraph package smoke ()-"));
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

  const packageRoot = join(consumer, "node_modules/@syzom/pi-workgraph");
  const deliveryReferencePath = join(packageRoot, "references/delivery.md");
  const deliveryReference = await readFile(deliveryReferencePath, "utf8");

  if (!deliveryReference.includes("# Deliver an accepted repository change"))
    throw new Error("Packaged delivery reference is missing or invalid.");

  const agentDir = join(parent, "agent");
  const sessionDir = join(parent, "sessions");
  await mkdir(agentDir);

  const modules = ["extensions/coordinator.ts", "extensions/worker.ts"].map((path) =>
    join(packageRoot, path),
  );

  await command(consumer, "node", [
    "--input-type=module",
    "--eval",
    `
      import {
        discoverAndLoadExtensions,
        ExtensionRunner,
        ModelRegistry,
        ModelRuntime,
        SessionManager,
      } from "@earendil-works/pi-coding-agent";
      const [coordinatorPath, workerPath] = ${JSON.stringify(modules)};
      const agentDir = ${JSON.stringify(agentDir)};
      const sessionDir = ${JSON.stringify(sessionDir)};
      const deliveryReferencePath = ${JSON.stringify(deliveryReferencePath)};
      const one = (result, label, path) => {
        if (result.errors.length > 0)
          throw new Error(label + " load failed: " + JSON.stringify(result.errors));
        const loaded = result.extensions.find((extension) => extension.resolvedPath === path);
        if (loaded === undefined) throw new Error(label + " factory was not loaded.");
        return loaded;
      };
      delete process.env.PI_WORKGRAPH_ROLE;
      const coordinatorResult = await discoverAndLoadExtensions(
        [coordinatorPath],
        process.cwd(),
        agentDir,
      );
      const coordinator = one(coordinatorResult, "coordinator", coordinatorPath);
      if (!coordinator.tools.has("workgraph_implement") || !coordinator.commands.has("calm"))
        throw new Error("Packaged coordinator factory did not register its extension surface.");

      const modelRuntime = await ModelRuntime.create({
        authPath: ${JSON.stringify(join(parent, "auth.json"))},
        modelsPath: null,
        modelsStorePath: ${JSON.stringify(join(parent, "catalog.json"))},
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      const runner = new ExtensionRunner(
        coordinatorResult.extensions,
        coordinatorResult.runtime,
        process.cwd(),
        SessionManager.create(process.cwd(), sessionDir),
        new ModelRegistry(modelRuntime),
      );
      const injected = await runner.emitBeforeAgentStart(
        "Coordinate the request",
        undefined,
        "Base coordinator prompt",
        { cwd: process.cwd() },
      );
      const expectedReference = "Delivery procedure at " + JSON.stringify(deliveryReferencePath);
      if (!injected?.systemPrompt?.includes(expectedReference))
        throw new Error("Packaged coordinator prompt did not resolve its delivery reference.");
      if (injected.systemPrompt.includes("](references/delivery.md)"))
        throw new Error("Packaged coordinator prompt retained its source-relative delivery link.");
      if (injected.systemPrompt.includes("# Deliver an accepted repository change"))
        throw new Error("Packaged coordinator prompt eagerly included the delivery procedure.");

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
    `${JSON.stringify({ status: "passed", boundary: "pack/install/load/inject/extensions-and-reference", totalMs: Date.now() - started })}\n`,
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
