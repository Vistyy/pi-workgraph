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
      import {
        DefaultResourceLoader,
        ExtensionRunner,
        ModelRegistry,
        ModelRuntime,
        SessionManager,
        discoverAndLoadExtensions,
      } from "@earendil-works/pi-coding-agent";
      import { Value } from "typebox/value";
      const [coordinator, worker] = ${JSON.stringify(modules)};
      const agentDir = ${JSON.stringify(join(parent, "agent"))};
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const withRole = async (role, run) => {
        const previous = process.env.PI_WORKGRAPH_ROLE;
        try {
          if (role === null) delete process.env.PI_WORKGRAPH_ROLE;
          else process.env.PI_WORKGRAPH_ROLE = role;
          return await run();
        } finally {
          if (previous === undefined) delete process.env.PI_WORKGRAPH_ROLE;
          else process.env.PI_WORKGRAPH_ROLE = previous;
        }
      };
      const load = (path, role) => withRole(role, async () => {
        const result = await discoverAndLoadExtensions([path], process.cwd(), agentDir);
        if (result.errors.length > 0)
          throw new Error(path + " failed to load: " + JSON.stringify(result.errors));
        if (!result.extensions.some((extension) => extension.resolvedPath === path))
          throw new Error(path + " factory was not loaded.");
      });
      await load(coordinator, null);
      await load(worker, "research");

      await withRole(null, async () => {
        const resources = new DefaultResourceLoader({
          cwd: process.cwd(),
          agentDir,
          additionalExtensionPaths: [coordinator],
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        });
        await resources.reload();
        const loaded = resources.getExtensions();
        if (loaded.errors.length > 0)
          throw new Error("coordinator registration failed: " + JSON.stringify(loaded.errors));
        const models = await ModelRuntime.create({
          authPath: ${JSON.stringify(join(parent, "auth.json"))},
          modelsPath: null,
          modelsStorePath: ${JSON.stringify(join(parent, "catalog.json"))},
          refreshOnCreate: false,
          allowModelNetwork: false,
        });
        const session = SessionManager.create(process.cwd(), ${JSON.stringify(join(parent, "sessions"))});
        const runner = new ExtensionRunner(
          loaded.extensions,
          loaded.runtime,
          process.cwd(),
          session,
          new ModelRegistry(models),
        );
        const schema = runner.getToolDefinition("workgraph_checkout")?.parameters;
        if (schema === undefined) throw new Error("workgraph_checkout was not registered.");
        const id = "a".repeat(64);
        const head = "b".repeat(40);
        if (!Value.Check(schema, {}) || !Value.Check(schema, { cwd: "." }))
          throw new Error("checkout allocation schema rejected a compact allocation.");
        if (!Value.Check(schema, { finish: { checkoutId: id, expectedHead: head } }))
          throw new Error("checkout finish schema rejected a complete nested finish.");
        if (
          Value.Check(schema, { checkoutId: id, expectedHead: head }) ||
          Value.Check(schema, { finish: { checkoutId: id } }) ||
          Value.Check(schema, { finish: { checkoutId: id, expectedHead: head, extra: true } })
        ) throw new Error("checkout schema accepted a partial or undeclared finish form.");
      });
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
