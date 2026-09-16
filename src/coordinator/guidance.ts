import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MarkdownLink = /\[([^\]\n]+)\]\(([^)\s]+)\)/gu;

const ExternalLink = /^(?:https?:|mailto:)/iu;

const UriScheme = /^[a-z][a-z\d+.-]*:/iu;

function codeSpan(value: string): string {
  const longestRun = Math.max(0, ...(value.match(/`+/gu)?.map((run) => run.length) ?? []));
  const delimiter = "`".repeat(longestRun + 1);

  return `${delimiter}${value}${delimiter}`;
}

function resolvePackagePath(target: string, source: URL, packageRoot: string) {
  if (target.startsWith("/") || UriScheme.test(target))
    throw new Error(`Coordinator reference is not package-relative: ${target}`);

  const resolvedUrl = new URL(target, source);
  const fragment = resolvedUrl.hash;
  resolvedUrl.hash = "";
  const resolvedPath = fileURLToPath(resolvedUrl);
  const packagePath = relative(packageRoot, resolvedPath);

  if (packagePath === ".." || packagePath.startsWith(`..${sep}`) || isAbsolute(packagePath))
    throw new Error(`Coordinator reference escapes its package: ${target}`);

  if (!existsSync(resolvedPath) || !lstatSync(resolvedPath).isFile())
    throw new Error(`Coordinator reference is not a packaged file: ${resolvedPath}`);

  if (/[\r\n]/u.test(resolvedPath))
    throw new Error(`Coordinator reference path contains a line break: ${resolvedPath}`);

  return { fragment, resolvedPath };
}

function renderReference(label: string, resolvedPath: string, fragment: string): string {
  const location = codeSpan(resolvedPath);

  return fragment === ""
    ? `${label} at ${location}`
    : `${label} at ${location}, section ${codeSpan(fragment)}`;
}

export function resolvePackagedLinks(markdown: string, source: URL): string {
  const packageRoot = fileURLToPath(new URL(".", source));

  return markdown.replace(MarkdownLink, (link, label: string, target: string) => {
    if (target.startsWith("#") || ExternalLink.test(target)) return link;

    const { fragment, resolvedPath } = resolvePackagePath(target, source, packageRoot);

    return renderReference(label, resolvedPath, fragment);
  });
}
