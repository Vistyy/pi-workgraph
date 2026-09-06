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
Historical evidence retains its original scope, and only an explicit intent revision makes older maintained work stale for composition.
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
Suspension stops new work and composition but preserves observations, results, and safe cleanup.
Adoption preserves suspension and rejects competing or uncertain ownership.
Keep blocked work and its evidence rather than rewriting state to claim cleanup or completion.

When you need installation, tool, model-policy, or live-scenario details, read [README.md](../../README.md).
