import assert from "node:assert/strict";
import test from "node:test";
import { assertionFindings } from "../scripts/check-assertions.js";

test("structural checks catch type laundering without rejecting unknown boundaries or const assertions", () => {
  for (const source of [
    "value as unknown as Target",
    "(value as unknown) as Target",
    "value as never",
    "<never>value",
    "<Target>(<unknown>value)",
  ])
    assert.equal(assertionFindings(source).length, 1, source);
  for (const source of [
    "const input: unknown = JSON.parse(text);",
    "const roles = ['research'] as const;",
    "const value = input as Target;",
    "const input = value as unknown;",
    "function exhaustive(value: never) {}",
    "const text = 'value as never';",
  ])
    assert.deepEqual(assertionFindings(source), [], source);
});
