import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const checkout = process.cwd();

const parent = mkdtempSync(join(tmpdir(), "workgraph-package-smoke-"));

const command = (cwd: string, file: string, args: readonly string[]): string =>
  execFileSync(file, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 2_000_000,
    timeout: 60_000,
  }).trim();

try {
  const packed = command(checkout, "pnpm", ["pack", "--pack-destination", parent]);
  const packedPath = packed.split("\n").at(-1);

  if (packedPath === undefined || packedPath === "")
    throw new Error("pnpm pack returned no tarball path.");

  const tarball = isAbsolute(packedPath) ? packedPath : join(parent, packedPath);
  const consumer = join(parent, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  command(consumer, "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball]);

  const packageRoot = join(consumer, "node_modules/@syzom/pi-workgraph");
  statSync(join(packageRoot, "references/delivery.md"));

  const modules = ["extensions/coordinator.ts", "extensions/worker.ts"].map((path) =>
    join(packageRoot, path),
  );

  command(consumer, "node", [
    "--input-type=module",
    "--eval",
    `
      import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
      const [coordinator, worker] = ${JSON.stringify(modules)};
      const agentDir = ${JSON.stringify(join(parent, "agent"))};
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const load = async (path, role) => {
        if (role === null) delete process.env.PI_WORKGRAPH_ROLE;
        else process.env.PI_WORKGRAPH_ROLE = role;
        const result = await discoverAndLoadExtensions([path], process.cwd(), agentDir);
        if (result.errors.length > 0)
          throw new Error(path + " failed to load: " + JSON.stringify(result.errors));
        if (!result.extensions.some((extension) => extension.resolvedPath === path))
          throw new Error(path + " factory was not loaded.");
      };
      await load(coordinator, null);
      await load(worker, "research");
    `,
  ]);

  process.stdout.write('{"status":"passed","boundary":"pack/install/load"}\n');
} catch (cause) {
  process.stderr.write(
    `verify:package failed at the pack/install/load boundary. ${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  process.exitCode = 1;
} finally {
  rmSync(parent, { recursive: true, force: true });
}
