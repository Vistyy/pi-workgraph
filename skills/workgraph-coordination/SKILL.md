---
name: workgraph-coordination
description: Use when delegating or recovering repository work with Workgraph.
---

# Workgraph coordination

Choose assignments for the information, isolation, or independence the work needs, not a mandatory pipeline.
Use a separate coordinator conversation for unrelated work.

## Assign useful work

Give research a question and required observations, disposable experiments explicitly authorized effects and a stopping condition, and maintained changes concrete acceptance requirements.
Make assignments bounded enough that their results can be judged independently.
Choose separate assignments for different concerns or maintained slices; multiple attempts provide independent views of the same assignment, including across models.
Workers start fresh; request continuation only when a settled worker's retained trajectory is useful.

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
Choose whether to apply maintained output or retain it for further work; settlement does not apply it or require acceptance.
Release unselected output only when it is no longer useful.
For uncertain launches, application, release, or ownership, inspect exact retained identities and resulting effects before retrying; preserve blocked work rather than manufacturing cleanup or completion.
Before recovery or adoption, read [OPERATIONS.md](../../OPERATIONS.md).
For setup and everyday controls, read [README.md](../../README.md); before choosing boundary checks or running live scenarios, read [VERIFICATION.md](../../VERIFICATION.md).
