import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolvePackagedLinks } from "../../src/coordinator/guidance.js";

void test("packaged guidance resolves only package-local regular files", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workgraph guidance (#)-"));
  const packageRoot = join(parent, "package (`)");
  const references = join(packageRoot, "references");
  const delivery = join(references, "delivery.md");
  const outside = join(parent, "outside.md");
  const linkedOutside = join(references, "linked.md");

  try {
    await mkdir(references, { recursive: true });
    await writeFile(delivery, "# Delivery\n");
    await writeFile(outside, "# Outside\n");
    await symlink(outside, linkedOutside);

    const source = pathToFileURL(join(packageRoot, "COORDINATOR.md"));

    assert.equal(
      resolvePackagedLinks(
        "[delivery](references/delivery.md#route) [web](https://example.com) [section](#local)",
        source,
      ),
      `delivery at \`\`${delivery}\`\`, section \`#route\` [web](https://example.com) [section](#local)`,
    );
    assert.throws(
      () => resolvePackagedLinks("[outside](../outside.md)", source),
      /escapes its package/,
    );
    assert.throws(
      () => resolvePackagedLinks("[absolute](/tmp/outside.md)", source),
      /is not package-relative/,
    );
    assert.throws(
      () => resolvePackagedLinks("[file](file:///tmp/outside.md)", source),
      /is not package-relative/,
    );
    assert.throws(
      () => resolvePackagedLinks("[directory](references)", source),
      /is not a packaged file/,
    );
    assert.throws(
      () => resolvePackagedLinks("[symlink](references/linked.md)", source),
      /is not a packaged file/,
    );
    assert.throws(
      () => resolvePackagedLinks("[missing](references/missing.md)", source),
      /is not a packaged file/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
