import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** These two assertions bypass boundary checking; ordinary narrowing and as const remain valid. */
export function assertionFindings(text: string, path = "input.ts"): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const findings: string[] = [];
  const assertion = (
    node: ts.Node,
  ): node is ts.AsExpression | ts.TypeAssertion =>
    ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
  function visit(node: ts.Node): void {
    if (assertion(node)) {
      let expression = node.expression;
      while (ts.isParenthesizedExpression(expression))
        expression = expression.expression;
      if (
        node.type.kind === ts.SyntaxKind.NeverKeyword ||
        (assertion(expression) &&
          expression.type.kind === ts.SyntaxKind.UnknownKeyword)
      ) {
        const line =
          source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        findings.push(
          `${path}:${line}: ${node.type.kind === ts.SyntaxKind.NeverKeyword ? "Do not assert never" : "Do not launder a type through unknown"}; validate or narrow at the boundary.`,
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return findings;
}

async function main(): Promise<void> {
  const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
  if (config.error)
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
    );
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    process.cwd(),
  );
  if (parsed.errors.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: process.cwd,
        getNewLine: () => "\n",
      }),
    );
  const findings = (
    await Promise.all(
      parsed.fileNames.map(async (path) =>
        assertionFindings(await readFile(path, "utf8"), path),
      ),
    )
  ).flat();
  if (findings.length) {
    console.error(findings.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      `Assertion boundaries checked in ${parsed.fileNames.length} TypeScript files.`,
    );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main();
