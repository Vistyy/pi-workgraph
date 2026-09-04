---
name: workgraph-visual-parity
description: Optional composable guidance for visual-parity tasks when it matches the current outcome.
---

# Visual parity

## Purpose

Use this skill when one rendered interface must match an existing baseline across specified states and viewports.
The untouched baseline is the specification.
Visual equivalence is established by image evidence and interaction observation, not source similarity or unaided memory.

## Completion predicate

The run is complete when every agreed component, state, and viewport matches its preserved baseline within the explicit tolerance, interaction behavior remains correct, and the exact composed revision has reproducible visual evidence.

## Step 1: `baseline`

Capture the pre-change or target rendering before implementation.
Enumerate components, states, themes, viewport sizes, data conditions, and interaction stages in scope.
Store screenshots and harness configuration outside implementation-owned paths.
Record fonts, browser or renderer version, device scale, animation state, and nondeterministic content controls.
No visual parity claim is possible without a usable baseline.
If the baseline itself appears wrong, stop and return that product decision rather than editing it.

## Step 2: `separate`

Define anti-shortcut rules in the implementation envelope.
Workers may not modify baseline images, tolerances, harness logic, or target data to make differences disappear.
Migrate shared visual primitives as a blocking node before dependent components.
Partition independent components into disjoint path claims and serialize scopes that share styles, tokens, or layout state.
Use a pilot component before broad repeated fan-out when one mistaken brief would multiply.
Keep the baseline owner separate from implementation ownership.

## Step 3: `implement`

Give each worker exact component states, baseline paths, claimed source paths, interaction conditions, and prohibited harness changes.
Change one independently verifiable visual scope per node.
Use Local Prewalk and compose exact commits against the shared foundation.
Do not restructure components solely to hide or crop a difference.
Do not accept "looks close" in worker reports.
If the target behavior requires a product decision not represented in the baseline, stop the affected scope and return to agreement.

## Step 4: `compare`

Run screenshot capture and image comparison against the composed revision on the matching surface.
Inspect nonzero differences by location and cause rather than relaxing global tolerance.
Retain baseline, actual, and diff artifacts with exact revision identity.
Use independent product verification because the result is visual and judgment-laden.
Require the verifier to detect blank, missing, clipped, offscreen, or wrong-state captures that can falsely satisfy a naive diff.
For intentionally tolerated rendering variance, state the bounded tolerance and why it does not hide product differences.

## Step 5: `interact`

Drive interactions whose correctness cannot be inferred from static screenshots.
Observe focus, keyboard and pointer behavior, transitions, scrolling, overlays, responsive changes, and failure states where applicable.
Capture before, action, and after evidence rather than only the final frame.
Run behavior assurance for interaction regressions, structure assurance for styling ownership, and evidence assurance for harness integrity and duplicate snapshots.
Repeat affected captures after every corrective commit.

## Failure and recovery

A nonzero unexplained diff is a failure, not an assurance preference.
A flaky baseline requires fixing or replacing the observation method before implementation continues.
Do not regenerate accepted baselines from the changed implementation.
After interruption, restore exact environment metadata and compare only artifacts tied to the current composed revision.

## Output

Report the state and viewport matrix, baseline location, per-scope diff result, interaction evidence, exact revision, tolerated variance, and any states not verified.
