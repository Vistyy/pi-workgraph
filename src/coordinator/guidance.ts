import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MarkdownLinkTarget = /(?<=\]\()[^)\s]+(?=\))/gu;

export function resolvePackagedLinks(markdown: string, source: URL): string {
  const packageRoot = fileURLToPath(new URL(".", source));

  return markdown.replace(MarkdownLinkTarget, (target) => {
    if (target.startsWith("#") || /^(?:https?:|mailto:)/iu.test(target)) return target;

    if (target.startsWith("/") || /^[a-z][a-z\d+.-]*:/iu.test(target))
      throw new Error(`Coordinator reference is not package-relative: ${target}`);

    const resolvedUrl = new URL(target, source);
    const fragment = resolvedUrl.hash;
    resolvedUrl.hash = "";
    const resolvedPath = fileURLToPath(resolvedUrl);
    const packagePath = relative(packageRoot, resolvedPath);

    if (packagePath === ".." || packagePath.startsWith(`..${sep}`) || isAbsolute(packagePath))
      throw new Error(`Coordinator reference escapes its package: ${target}`);

    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile())
      throw new Error(`Coordinator reference is not a packaged file: ${resolvedPath}`);

    return `${resolvedPath}${fragment}`;
  });
}
