import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { reportSchemaForMode, WorkerReportSchema } from "../../src/domain/report.js";
import { workerSystemPolicy } from "../../src/worker/context.js";

const narrative = {
  status: "completed" as const,
  summary: "Bounded result",
  details: "Observed the requested boundary and found no actionable issue.",
};

void test("every exact role has a strict narrative input and persisted runtime role", () => {
  for (const role of ["research", "experiment", "consultation", "review"] as const) {
    const input = reportSchemaForMode(role);
    assert.equal(Value.Check(input, { ...narrative, role }), false, `${role} cannot supply role`);
    assert.equal(
      Value.Check(WorkerReportSchema, { role, ...narrative }),
      true,
      `${role} persisted`,
    );
  }
});

void test("implementation completed requires outcome while noncompleted forbids it", () => {
  const schema = reportSchemaForMode("implementation");
  assert.equal(Value.Check(schema, { ...narrative, outcome: "changed" }), true);
  assert.equal(Value.Check(schema, narrative), false);
  assert.equal(
    Value.Check(schema, {
      status: "needs_decision",
      summary: "Decision required",
      details: "Choose A or B because the authority differs.",
    }),
    true,
  );
  assert.equal(
    Value.Check(schema, {
      status: "failed",
      outcome: "no_change",
      summary: "Blocked",
      details: "The runtime was unavailable.",
    }),
    false,
  );
});

void test("Experiment and Review policies preserve their redesigned authority boundaries", () => {
  const experiment = workerSystemPolicy("experiment", "guide");
  assert.match(experiment, /Each Attempt independently receives/);
  assert.match(experiment, /hard cutoff on the whole effectful lifetime/);
  assert.match(experiment, /authorized cancellation or teardown/);
  assert.match(
    experiment,
    /no automatic deadline enforcement, rollback, or post-cutoff cleanup exception/,
  );

  const review = workerSystemPolicy("review", "guide");
  assert.match(review, /independent perspective/);
  assert.match(review, /best justified complete result/);
  assert.match(review, /Prioritize simplification and total maintained complexity/);
  assert.match(review, /focused request supports only a focused conclusion/);
  assert.match(review, /uncommitted, mutable, partial, conceptual, report, Attempt-related/);
  assert.match(review, /exact revision only when the request depends on one/);
  assert.doesNotMatch(review, /exact stated base and candidate revisions/);
});

void test("schemas reject blanks and undeclared or obsolete structured fields", () => {
  for (const role of [
    "research",
    "experiment",
    "consultation",
    "review",
    "implementation",
  ] as const) {
    const schema = reportSchemaForMode(role);
    const report = role === "implementation" ? { ...narrative, outcome: "no_change" } : narrative;
    assert.equal(Value.Check(schema, report), true, `${role} baseline`);
    assert.equal(Value.Check(schema, { ...report, summary: " " }), false, `${role} blank summary`);
    assert.equal(Value.Check(schema, { ...report, details: "\n" }), false, `${role} blank details`);
    assert.equal(Value.Check(schema, { ...report, extra: true }), false, `${role} extra`);
  }
});
