---
name: workgraph-pause-safely
description: Optional composable guidance for pause-safely tasks when it matches the current outcome.
---

# Pause safely

## Purpose

Use this skill only when the user requests a pause, a restart is necessary, or context must be handed off before the current run completes.
A safe pause leaves enough durable evidence for a cold-start coordinator to resume without guessing or duplicating work.
Do not interpret "keep going" or unattended execution as a pause request.

## Completion predicate

The pause is complete when no state-changing operation is uncertain, repository and Workgraph state are durable, active work has a known terminal or reconciled state, and the first resume action is explicit.

## Step 1: `settle`

Stop at an atomic boundary.
Allow an in-flight operation to finish when its result will be known promptly, or cancel it and reconcile the resulting state.
Do not stop midway through a known-broken product edit without making that condition explicit and durable.
Inspect child session, worktree, branch, commit, and coordinator repository after an uncertain result.
Do not retry merely to create a cleaner stopping point.

## Step 2: `stop`

Start no new discovery lane, implementation node, verification process, or assurance reviewer.
Cancel children only when cancellation is safer than waiting and record their terminal classification.
Do not cross a new irreversible boundary merely to package the pause.
This implementation does not create or push pull requests as part of pausing.
Mark unfinished skill milestones as pending rather than skipping them.

## Step 3: `persist`

Confirm that Workgraph state is written under the repository Git common directory.
Ensure every known child has a session path and every composed node has an exact commit record.
Leave completed implementation changes committed and the coordinator worktree clean.
Retain unresolved worker worktrees when their result is uncertain or inspection is still required.
Do not delete artifacts needed to interpret current verification or failure state.

## Step 4: `record`

Write a compact resume note outside volatile conversational context.
Include the requested outcome, completion predicate, selected guidance, current phase, approved envelope, completed and pending milestones, node and commit status, evidence revision, open findings, and first next operation.
Point to the durable state and session paths instead of copying reports.
State what is verified, not verified, and inconclusive.
Record standing restrictions that a resumed worker must reconstruct.

## Step 5: `pause`

Read the resume note against actual repository and state data.
Confirm that it does not claim completion for a pending operation or stale revision.
Return the durable locations, cleanliness state, retained worktrees, and first action on resume.
End without scheduling more work.
Session pickup owns continuation.

## Failure and recovery

If state cannot be reconciled, preserve all potentially authoritative artifacts and report the uncertainty rather than cleaning them up.
If the repository is dirty from unrelated user work, do not modify or commit it to make the pause look clean.
State the conflict and ask how to proceed only when it blocks durable preservation.
