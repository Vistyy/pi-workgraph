# Bug fix

## Purpose

Use this playbook to correct observable behavior that violates an established expectation.
Every shipped line must trace to evidence about the root mechanism or to a necessary verification boundary.
Do not add protective changes that merely might help.

## Completion predicate

The run is complete when the original defect is reproduced, one root mechanism is confirmed, the smallest evidence-supported correction is composed, the original scenario passes on the matching surface, and assurance accepts the exact verified revision.

## Step 1: `reproduce`

Describe the defect as trigger, observed result, expected result, environment, and affected revision.
Drive the matching product surface directly and retain the failing observation.
Use an existing test only when it crosses the same behavior boundary as the report.
If the defect does not reproduce, tighten conditions, inspect stored state, or instrument the runtime before changing code.
A source-level suspicion without an observed failure is not a reproduction.
Record the artifact, command, screenshot, trace, or state value that will later distinguish fixed from unfixed.

## Step 2: `diagnose`

Trace the affected subsystem with partitioned discovery when responsibilities are distinct.
Use evidence discovery for regression history or runtime rationale when it could constrain the correction.
List candidate mechanisms and test the observation that most sharply separates them.
For live-only behavior, route through Runtime forensics.
For an existing profile or dump, route through Trace forensics.
Do not enter design until runtime or repository evidence confirms the surviving mechanism.
Revert or discard any experiment motivated by a refuted hypothesis.

## Step 3: `design`

State the violated invariant, its rightful owner, and why the current boundary permits the defect.
Choose the smallest correction that restores that invariant without adding parallel validation or compatibility paths.
Use Architecture only when the correction changes ownership, an interface, or a difficult-to-reverse boundary.
Decide whether a durable regression test protects a distinct enduring invariant at acceptable maintenance cost.
A durable test is not mandatory when the real boundary is integration-heavy, visual, transient, or better captured by product verification.
Present the complete implementation and verification envelope for approval before product writes.

## Step 4: `implement`

Create bounded implementation nodes with disjoint claimed paths or explicit dependencies.
Give each worker the failing evidence pointer, root mechanism, owned invariant, acceptance conditions, verification commands, timebox, forbidden scope, and report contract.
Use Local Prewalk for the first implementation attempt.
Keep unrelated cleanup outside the correction.
If implementation reveals that the diagnosed mechanism is wrong, stop the affected node and return to diagnosis instead of layering another fix.
Compose exact commits in deterministic order and retain worker sessions.

## Step 5: `verify`

Repeat the original failing scenario against the composed revision.
Run nearby checks only in proportion to affected invariants.
Use independent product verification when commands cannot observe the reported boundary.
A unit test that passes below the failure surface does not prove the bug absent.
Treat NOT VERIFIED or INCONCLUSIVE as failure to complete.
Run behavior, structure, and evidence assurance after product verification.
Route accepted internal findings to bounded correction nodes and rerun affected evidence.

## Failure and recovery

A worker process failure is not evidence against the design.
Inspect session, worktree, commit, and repository state before retrying, then replace only the failed node.
A semantic escalation that changes outcome, owner, public interface, dependency, security guarantee, scale, reuse decision, or non-goal returns to the user agreement boundary.
Do not restart settled discovery after a routine implementation failure.

## Output

Report the failing observation, confirmed root mechanism, correction boundary, exact composed revision, before-and-after product evidence, retained checks, and assurance result.
