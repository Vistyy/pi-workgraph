import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import {
  reportSchemaForMode,
  WorkerReportInputSchema,
  WorkerReportSchema,
} from "../src/report-schema.js";
import type { WorkerMode } from "../src/types.js";

const reportContent = {
  summary: "Bounded result",
  evidence: [{ label: "Boundary", observation: "Observed" }],
  findings: [
    {
      severity: "info",
      title: "No concern",
      detail: "No actionable concern was found.",
      envelopeImpact: "none",
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

void test("historical report decoding preserves fields accepted by the legacy schema", () => {
  const reports = [
    {
      kind: "research",
      status: "completed",
      ...reportContent,
      legacyTopLevel: { source: "retained research bytes" },
      evidence: [{ ...reportContent.evidence[0], legacyEvidence: "retained" }],
      findings: [{ ...reportContent.findings[0], legacyFinding: "retained" }],
    },
    {
      kind: "review",
      status: "completed",
      ...reportContent,
      legacyTopLevel: { source: "retained review bytes" },
      evidence: [{ ...reportContent.evidence[0], legacyEvidence: "retained" }],
      findings: [{ ...reportContent.findings[0], legacyFinding: "retained" }],
    },
    {
      kind: "implementation",
      status: "failed",
      ...reportContent,
      evidence: [{ ...reportContent.evidence[0], legacyEvidence: "retained" }],
      findings: [{ ...reportContent.findings[0], legacyFinding: "retained" }],
    },
  ];

  for (const report of reports) {
    assert.equal(Value.Check(WorkerReportSchema, report), true, report.kind);
    assert.deepEqual(Value.Decode(WorkerReportSchema, report), report);
    assert.equal(Value.Check(WorkerReportInputSchema, report), false, report.kind);
  }
});
