---
name: workgraph-arena
description: Optional composable guidance for arena tasks when it matches the current outcome.
---

# Arena

## Purpose

Use this skill when several independent attempts at the same non-trivial artifact could reveal a materially better shape.
Within the current Workgraph lifecycle, Arena is primarily a decision method for designs, plans, analyses, prompts, or other report-sized artifacts before implementation.
Do not schedule overlapping production implementations as ordinary DAG nodes, because composition would incorrectly treat every candidate as additive work.

## Completion predicate

The run is complete when every requested candidate is accounted for, every surviving candidate is read against the same rubric, one coherent base is selected, useful ideas are incorporated without mixing mental models, and the synthesized artifact is verified.

## Step 1: `criteria`

State the exact artifact each candidate must produce.
Derive three to six concrete criteria from the requested outcome.
Keep the criteria gradeable, such as "one owner enforces the invariant," rather than vague qualities such as "clean."
Give every candidate the same grounding pointers and neutral task wording.
Choose the panel size before fan-out.
Use two or three models ordinarily and reserve all four configured families for high-reversal-cost decisions.

## Step 2: `fanout`

Use replicated discovery so each configured model receives the same question independently.
Do not include other candidates' answers in a candidate's context.
Require each candidate to return the artifact, its assumptions, considered alternatives, and rejected choices.
Keep candidates report-sized unless a future isolated-candidate operation explicitly owns separate writable artifacts.
Record the exact model and thinking level for each lane.
Treat failed, timed-out, cancelled, and unavailable candidates as explicit dropouts and proceed with fewer only when the rubric can still be applied meaningfully.

## Step 3: `account`

Wait until every requested lane has a terminal state before judging.
Confirm that each completed candidate answered the same contract rather than a nearby task.
If candidates diverge because the brief was ambiguous, fix the brief and rerun instead of averaging incomparable answers.
If only one viable candidate survives, lower confidence and decide whether the reversal cost warrants another model.
Preserve compact candidate summaries and evidence pointers without copying whole transcripts.

## Step 4: `judge`

Use an independent synthesis operation for substantial arenas and a different model family when available.
Present candidates under neutral labels, the common rubric, and dropout records.
Score each criterion and recommend a base with reasons.
In parallel, the coordinator reads every candidate end to end and compares its own judgment with the synthesizer.
Disagreement signals bias, an ambiguous rubric, or missed evidence and must be resolved before selection.
Prefer the candidate with clearer invariant ownership and lower reader load when scores are otherwise tied.

## Step 5: `select`

Select one candidate as the coherent base.
Incorporate only ideas from losing candidates that fit the base's ownership and mental model.
Record each accepted idea, rejected idea, and convergence signal.
Do not paste together incompatible interfaces or split authority among candidates.
Verify the synthesized artifact against the original rubric and route it to the applicable skill.

## Failure and recovery

A model panel is not a vote.
Model agreement is useful evidence but cannot override a violated project contract.
A missing candidate is not a negative score and must not disappear from the record.
After interruption, judge only candidates with settled reports and do not restart completed lanes unless their inputs changed.
