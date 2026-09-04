---
name: workgraph-trace-forensics
description: Optional composable guidance for trace-forensics tasks when it matches the current outcome.
---

# Trace forensics

## Purpose

Use this skill when a fixed trace, profile, snapshot, dump, or diagnostic capture is already available.
Unlike Runtime forensics, this skill treats the artifact as an immutable dataset and does not depend on reproducing the live symptom.
The deliverable is the strongest diagnosis the artifact can support.

## Completion predicate

The run is complete when the artifact has been parsed with an appropriate method, narrowed to a material path or state, attributed to source when the artifact permits it, and classified as confirmed or provisional.

## Step 1: `identify`

Identify the artifact format, producer, capture time, target revision, environment, and expected symptom.
Choose a parser that preserves the fields needed for attribution.
Verify that the artifact is readable and complete before spending effort on analysis.
Treat truncation, missing symbols, mismatched versions, and absent metadata as evidence limitations.
Do not rerun the system merely because the artifact is unfamiliar.

## Step 2: `transform`

Convert large raw data into a queryable representation such as SQLite, normalized JSON, folded stacks, indexed text, or a summary table.
Delegate parsing to one bounded partitioned worker when it protects coordinator context.
The worker brief must name the input artifact, output path, query contract, and prohibited source changes.
Keep the transformation deterministic and record the command or script used.
Do not paste raw multi-megabyte artifacts into reports.

## Step 3: `narrow`

Query for the evidence shape appropriate to the artifact.
For CPU data, identify dominant frames and walk their call paths.
For memory data, identify retained classes and follow paths to roots.
For blocked processes, identify the active thread or wait reason.
For event traces, align the divergence with a concrete event sequence.
Test alternative interpretations against the same dataset instead of choosing the first plausible frame.

## Step 4: `resolve`

Resolve the narrowed finding to source file, symbol, and line when symbol information exists.
Compare a paired baseline or known-good artifact when available to distinguish regression signal from ordinary background work.
Use a small history evidence lane only when source attribution alone cannot explain why the path exists.
If no paired capture exists, lower confidence rather than manufacturing confirmation.
If the artifact cannot map to source, report the exact missing bridge.

## Step 5: `report`

Report artifact identity, transformation path, decisive query, narrowed finding, source attribution, confidence, and limitations.
Include artifact and reduced-data paths so the analysis can be audited.
State whether the artifact confirms the cause, supports a leading hypothesis, or is inconclusive.
Route requested code changes to Bug fix or Performance without discarding this evidence.

## Failure and recovery

Do not silently change parsers when a parser drops fields or fails.
Record the failed method and choose a replacement that preserves the required evidence.
After interruption, resume from the reduced queryable artifact rather than reprocessing the raw capture unless its integrity is in doubt.
