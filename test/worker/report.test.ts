import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import {
  reportSchemaForMode,
  type WorkerMode,
  WorkerReportSchema,
} from "../../src/domain/report.js";

const reportContent = {
  summary: "Bounded result",
  evidence: [{ label: "Boundary", observation: "Observed" }],
  findings: [
    {
      severity: "info",
      title: "No concern",
      detail: "No actionable concern was found.",
    },
  ],
} as const;

function reportForMode(mode: WorkerMode) {
  return {
    kind: mode,
    status: "failed" as const,
    ...reportContent,
  };
}

void test("changed implementation reports remain semantic and exclude host-owned Git metadata", () => {
  const input = {
    kind: "implementation",
    status: "completed",
    outcome: "changed",
    ...reportContent,
  } as const;

  const inputSchema = reportSchemaForMode("implementation");
  assert.equal(Value.Check(inputSchema, input), true);
  assert.equal(Value.Check(WorkerReportSchema, input), true);

  for (const extra of [{ commit: "a".repeat(40) }, { changedFiles: ["change.ts"] }]) {
    assert.equal(Value.Check(inputSchema, { ...input, ...extra }), false);
    assert.equal(Value.Check(WorkerReportSchema, { ...input, ...extra }), false);
  }
});

void test("live report schemas reject undeclared top-level and nested sensitive fields in every mode", () => {
  for (const mode of ["research", "review", "implementation"] as const) {
    const schema = reportSchemaForMode(mode);
    const report = reportForMode(mode);
    assert.equal(Value.Check(schema, report), true, `${mode} baseline`);
    assert.equal(
      Value.Check(schema, { ...report, authorization: "Bearer retained-secret" }),
      false,
      `${mode} top-level extra`,
    );
    assert.equal(
      Value.Check(schema, {
        ...report,
        evidence: [{ ...report.evidence[0], rawProviderError: "credential-bearing failure" }],
      }),
      false,
      `${mode} evidence extra`,
    );
    assert.equal(
      Value.Check(schema, {
        ...report,
        findings: [{ ...report.findings[0], apiKey: "retained-secret" }],
      }),
      false,
      `${mode} finding extra`,
    );
  }
});
