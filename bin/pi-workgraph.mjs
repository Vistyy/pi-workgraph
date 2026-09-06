#!/usr/bin/env node
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native child-process spawning is this CLI bootstrap's adapter boundary.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const loader = import.meta.resolve("tsx");
const result = spawnSync(process.execPath, ["--import", loader, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
if (result.error !== undefined) {
  // oxlint-disable-next-line effecttsgo/global-console -- Native stderr is part of the executable bootstrap contract.
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
