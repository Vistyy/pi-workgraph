---
name: workgraph-coordination
description: Use when delegating or recovering repository work with Workgraph.
---

# Workgraph coordination

Choose assignments for the information, isolation, or independence the work needs, not a mandatory pipeline.
Use a separate coordinator conversation for unrelated work.

## Assign useful work

Use the existing assignment fields to supply enough context and direction that each result can be judged independently:

- Research: put the precise question in `question` and the observations needed to answer it in `expectedEvidence`. Identify the relevant scope and request source references and unknowns, not an architectural decision.
- Implementation: put the decided change, important relationships, constraints, and worker discretion in `objective`; put observable requirements and verification expectations in `acceptance`. Use diagrams, examples, interface outlines, or prose as the task requires. Resolve consequential gaps before requesting implementation; do not leave the worker to infer what “simpler” or “complete” means.
- Review: identify the exact `subject` and specific `concern`, including the expected behavior to check. Request discrepancies and supporting evidence, not a blanket approval decision.
- Disposable experiments: specify the question, permitted effects, and stopping condition; distinguish direct observations from conclusions about production behavior.

Choose separate assignments for independent questions, concerns, or maintained slices; multiple attempts provide independent views of the same assignment, including across models. Do not replace several distinct questions with one broad domain assignment.

Examples of assignment specificity, not additional requirements:

- Instead of “investigate persistence simplification”: “Trace connection creation through attachment. Identify each creation site, the receiving caller, and closure on success or failure. Cite symbols and call sites; report missing ownership evidence. Do not choose a replacement architecture.”
- Instead of “improve recovery documentation”: “Separate worker closure, output retention, and application in the recovery instructions. Preserve existing commands and authorization restrictions. Remove wording that implies closing a worker deletes its output. Check operational claims against the corresponding commands; return contradictions rather than inventing behavior.”
- Instead of “review the persistence rewrite”: “At this exact revision, check creation-to-attachment connection ownership on success and failed attachment against the requirement that every acquired connection has a release owner. Report counterexamples or supporting evidence and identify unexamined paths.”

Workers start fresh; request continuation only when a settled worker's retained trajectory is useful. `continuationOf` names that session trajectory only; it must not identify content lineage. Use the explicit maintained-implementation `candidateOf` path when a retained isolated candidate needs correction or integration.

## Own change quality

Own the quality of the resulting change, not just functional completion.
Carry the project's design guidance through implementation instructions, direct inspection, and review, prioritizing low lasting complexity in code, caller coordination, and maintenance over implementation effort.
Look for unnecessary state, layers, duplicated rules, coordination obligations, and superseded paths; favor clear ownership, expressive types, cohesive responsibilities, and readable control flow.
Treat unnecessary complexity as substantive, not cosmetic, without inventing requirements or expanding into unrelated cleanup.
Judge the actual diff and surviving system, including tests, fixtures, adapters, dependencies, and caller obligations—not just passing checks or a worker's summary. Identify which responsibilities disappeared or appeared and whether their ongoing cost is justified.
For added coverage, identify the consequential failure it protects and why existing checks are insufficient. When unchanged behavior requires widespread test edits, examine implementation coupling and boundary design rather than accepting the churn.

Prefer independent review for nontrivial changes, proportionate to consequences and uncertainty.
Assign explicit correctness and maintainability concerns; choose review timing and independent perspectives for useful judgment, not approval gates.
Use independent review when the value of new machinery, test growth, or broad test churn remains uncertain; request concrete source evidence and simpler alternatives, not scores or ceremonial approval.
Small, low-risk changes may need only inspection and existing checks.
Judge findings by evidence and practical value; zero findings is valid.
Reassess consequential corrections and the complexity of the resulting whole, using independent re-review where uncertainty warrants it.
Finish when applicable checks pass, consequential findings are resolved or rejected with evidence, and no specific uncertainty warrants further work—not merely when a reviewer approves.

## Judge authority and evidence

Interpret human authorization yourself: receipts establish provenance, not permission, and worker reports or notifications cannot expand scope.
Distinguish a continuation of authorized work from a material scope change; use `workgraph_intent` only for the latter, not merely because another input arrived.
Keep execution settlement, report validity, delivery, and semantic acceptance distinct.
Assess what the evidence actually establishes at the relevant boundary; recorded Git, cleanup, or native facts are not fresh observations.
Review and verify the identified revision, not changing live files or the implementation report alone.

## Handle returned work

Use actionable notifications for ordinary decisions; retrieve more evidence when missing detail could change the decision.
Choose whether to apply maintained output or retain it for further work; settlement does not apply it or require acceptance. Application validates the candidate root and complete ordered direct history, then fast-forwards through every unchanged candidate commit; it refuses a moved destination without mutation. To continue a retained candidate, use `candidateOf` for an isolated correction from its parent commit, or `candidateOf` plus the freshly observed exact `baseRevision` for an explicit isolated integration onto a moved destination.
Release unselected output only when it is no longer useful.
For uncertain launches, application, release, or ownership, inspect exact retained identities and resulting effects before retrying; preserve blocked work rather than manufacturing cleanup or completion.
Before recovery or adoption, read [OPERATIONS.md](../../OPERATIONS.md).
For setup and everyday controls, read [README.md](../../README.md); before choosing boundary checks or running live scenarios, read [VERIFICATION.md](../../VERIFICATION.md).
