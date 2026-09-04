---
name: workgraph-session-pickup
description: Optional composable guidance for session-pickup tasks when it matches the current outcome.
---

# Session pickup

## Purpose

Use this skill to continue a prior Workgraph, session, branch, worktree, or explicit resume note.
Pickup is inheritance, so the prior run's durable evidence should prevent unnecessary re-investigation.
Do not trust a prior summary where repository or state evidence contradicts it.

## Completion predicate

The pickup is complete when operational state is reconciled, completed and pending work are distinguished, the exact resume point is named, the remaining task is routed to the applicable skill, and inherited claims are checked at their authoritative boundary.

## Step 1: `read`

Locate the Workgraph state path, parent session, child sessions, resume note, branch, and retained worktrees.
Read state metadata and the latest material events before scanning older context.
For a long transcript, use a bounded parser or evidence lane to produce a reduced timeline and decision list.
Capture the original request, completion predicate, agreement, model roles, and standing restrictions.
Do not start by re-reading the entire repository.

## Step 2: `reconcile`

Inspect repository HEAD, cleanliness, composition records, worker branches, worktrees, session reports, and running-state markers.
If the run stopped during execution, call the reconciliation boundary before scheduling replacements.
Confirm whether each state-changing operation completed, failed, or remains uncertain.
Attribute coordinator repository changes to exact worker commits where possible.
Preserve unattributed state and return to a decision boundary instead of resetting it.
Do not retry an operation whose success has not been checked.

## Step 3: `separate`

List settled discovery, approved decisions, composed nodes, verified evidence, assurance results, and pending work.
Compare evidence revision with the current composed commit and invalidate stale verdicts.
Do not rerun completed discovery merely to rebuild personal confidence.
Recheck a prior claim only when its authority is weak, its input changed, or repository evidence conflicts.
Name the first unsettled operation and the reason it remains necessary.

## Step 4: `route`

Continue through the already selected guidance when its outcome and predicate remain valid.
Route to a narrower skill when the inherited run intentionally ended at a diagnosis or design decision.
Use a revised agreement when new evidence changes outcome, non-goal, owner, public interface, dependency, security guarantee, scale, or reuse decision.
Use bounded replacement or correction nodes for failures inside the existing envelope.
Preserve original implementer trajectory for local correction when practical.
Do not create a second active graph owner.

## Step 5: `verify`

Verify inherited claims at the boundary that gives them authority.
Use exact commits for composition, actual repository status for cleanliness, typed terminal reports for worker completion, and product artifacts for behavior.
A prior worker statement that checks passed is not equivalent to retained command or product evidence.
Run only the checks affected by changed or stale inputs during pickup, then continue normal lifecycle verification.
Update durable skill progress and the resume note if another interruption is likely.

## Failure and recovery

If the prior state version is unsupported, preserve its file and reconstruct manually without overwriting it.
If sessions are missing but commits and product evidence are decisive, continue with the reduced context and note the loss.
If neither state nor repository can establish what happened, stop before mutation and ask only the authority needed to choose preservation or replacement.

## Output

Report what was inherited, what was reconciled, what was not redone, the exact resume point, the routed skill, stale evidence, and the next operation.
