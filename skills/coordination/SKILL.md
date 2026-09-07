---
name: workgraph-coordination
description: Use when delegating or recovering repository work with Workgraph.
---

# Workgraph coordination

Choose assignments by the information, isolation, or independence the work needs, rather than constructing a mandatory pipeline.
A small evidence check is often enough for a low-risk question, while an explicitly authorized experiment can resolve uncertainty with named effects, stopping conditions, and retained artifacts.
Independent repeated research or candidate work, a comparison review over retained results, parallel maintained slices, and an ordinary bounded integration assignment are available when their independence is meaningful.
First delegation creates a workstream; research can proceed before maintained implementation is authorized and alongside implementation or review.
Use a separate coordinator conversation for unrelated work.

## Review expectations

Prefer independent review for nontrivial maintained changes, with review effort proportionate to the consequences, complexity, and uncertainty of the work.
Correctness is the first priority, but working code is not the only goal: also consider simplicity, types that express the intended constraints, readability, and ease of maintenance.
Look for unnecessary machinery and opportunities to simplify, not speculative abstractions or cosmetic churn.
Choose the review timing, concerns, and number of reviewers that add useful independent judgment; these expectations are not a mandatory stage or a fixed checklist for every reviewer.
Small, low-risk changes may need only direct inspection and existing checks.
Give reviewers explicit concerns rather than relying on them to infer the desired quality bar.
Separate assignments can provide different lenses; repeated attempts on one assignment provide independent views of the same concern, even when they use different models.
Judge findings by their evidence and practical value; zero findings is valid.

## Assignment boundaries

Distinguish read-only research, explicitly authorized disposable experiments, and maintained changes.
Give research a question and required observations, experiments permitted effects and a stop condition, and implementation concrete acceptance requirements.
Name the exact retained proposal, artifact, or revision and the concern for independent review.
Workers start fresh with ordinary Pi configuration; request continuation only when a settled worker's retained trajectory is relevant.
A coordinator conversation fork is not a worker continuation or workstream adoption.

Interpret the scope of actual human requests yourself.
Receipt references prove provenance, not semantic authorization.
Receiving or selecting a new input receipt does not revise established scope or make in-flight work stale.
When intent version 0 has no human authority yet, an authorized maintained change or disposable experiment may establish it from a genuine retained input.
Otherwise, delegation defaults to the current intent's retained authority receipt, not the latest input.
Check the mutation's `authorityContext.selectedScope`; when `latestObservedInput` is also present, it is newer retained context and was not claimed as the assignment's authority.
If an explicit receipt is outside the current intent, use `workgraph_intent` first only when you judge that the human request changes semantic scope; do not infer a revision from receipt text or add an approval ceremony.
Historical evidence retains its original scope, and only an explicit intent revision makes older maintained work stale for application.
Persistent `workgraph_models` changes are separate and continue to use the latest genuine session input by default or an explicitly selected retained receipt.

## Returned work and recovery

Judge execution settlement, report validity, transport receipt, and semantic judgment separately.
Use the bounded outcome in a normal result notification for ordinary decisions.
Use `workgraph_inspect` only when uncertainty, a blocker, repeated attempts, or truncation requires it.
Its sections are `overview`, `context`, `task`, `assignment`, `outcome`, `evidence`, `report`, `judgments`, and `recovery`.
Use `context` for exact retained inputs and intent history, `assignment` for the complete delegation record, and `judgments` for coordinator dispositions and completion.
An explicitly selected pending attempt has no outcome disposition even when sibling attempts do; task-level selection may include all of the task's dispositions.
Character-bounded reads return a lossless `next` handle for every remaining character, including long assignments, judgments, and untyped or malformed reports.
Recorded settlement, cleanup, native, and Git facts are attributed as durable evidence, never presented as a fresh live observation.
Do not perform routine status/result polling or acknowledgement/disposition ceremony.
Pending notifications retry on reattachment, not every polling cycle; the same result identifier can recur after an interrupted delivery.
Do not blindly resubmit an uncertain worker prompt.
Inspect the retained native session and exact resource identities before deciding whether an operation needs recovery.
Suspension stops new work and application but preserves observations, results, and exact resources.
Adoption preserves suspension and rejects competing or uncertain ownership.
Keep blocked work and its evidence rather than rewriting state to claim cleanup or completion.
Worker settlement never applies output. Close a proven stopped worker even when its report is failed or malformed; inspect retained output separately.
Apply selected current maintained output only with `workgraph_control` action `apply`, its exact attempt, exact reported `sourceCommit`, and freshly observed current `destinationHead`. This uses existing human authority and is not another approval or mandatory-review step.
Experiments and unapplied implementations retain their complete isolated worktree. Release unselected output only when no longer needed with action `release_output`, its exact attempt, and a destructive reason; this remains available after semantic completion. Cancellation releases disposable experiment output after closure.
Do not retry interrupted application or release automatically. Unknown or foreign resources remain retained with explicit diagnostics.

When you need installation, tool, model-policy, or live-scenario details, read [README.md](../../README.md).
