---
name: workgraph-coordination
description: Use when delegating or recovering repository work with Workgraph.
---

# Workgraph coordination

Use Workgraph to support coordinator-owned technical decisions with bounded evidence gathering and execution. This is a decision-driven loop, not a mandatory research → implementation → review pipeline. Use a separate coordinator conversation for unrelated work.

## Build the technical understanding

Start from the agreed human outcome, constraints, and supported behavior—not from a list of jobs to launch. For broad work, keep a working outline of the relevant responsibilities, relationships, and unresolved questions. A compact notepad reminder may help preserve what remains to investigate; it is not another approval or completion ledger.

Inspect the important entry points, data or control flow, and callers yourself. Use workers to fill specific gaps while building and revising that understanding. Do not ask one worker to supply the architecture, priorities, and conclusion for an entire subsystem you have not understood.

Choose investigations that could change a decision. For example, ask which guarantee a wrapper adds, where a state value is produced and consumed, or what can change between two checks. “This subsystem needs safety checks” does not answer whether its current layers or duplicated checks are needed.

Keep the overall goal distinct from each contribution. Completed investigations do not clear unexamined areas, and an empty active-attempt list does not establish that the human goal is met. Bring actual capability or policy trade-offs to the user with a recommendation and consequences, not an unfiltered collection of worker opinions.

## Shape bounded assignments

Split independent questions, implementation slices, and review concerns. Use multiple attempts when independent observations of the same question are useful; use separate tasks for different questions. Keep coupled changes together when splitting would merely create integration work. Available parallelism should improve coverage, not dilute the question or manufacture extra jobs.

Use the assignment fields to make the work independently judgeable:

- **Research:** put the precise uncertainty in `question` and the observations that would resolve it in `expectedEvidence`. Identify relevant source boundaries and callers, and distinguish facts to collect from the decision you will make. Request source references and explicit unknowns, not a verdict that the subsystem is good or necessary.
- **Implementation:** put the decided before/after relationships in `objective`: what changes or disappears, who owns the surviving behavior, which callers change, and what failures or ordering must be preserved. Put observable outcomes and meaningful verification expectations in `acceptance`. Leave local mechanics to the worker; do not leave it to discover what “simpler” or “complete” means. The guide's prewalk refines execution inside that design rather than replacing it.
- **Review:** identify the exact `subject` and a specific `concern`, with the intended outcome and constraints needed to challenge it. For example, a complexity review asks which responsibilities or caller obligations remain unnecessarily; a verification review asks which plausible failures the checks would miss and which implementation changes would needlessly break them. Ask for discrepancies and evidence, not approval or a quota of findings.
- **Disposable experiment:** specify the permitted effects and stopping condition. Ask for observations that answer the question, including failures and limitations; do not turn successful execution into authorization for a maintained change.

Use prose, examples, diagrams, or interface outlines according to the task. No fixed design template or line-by-line prescription is required.

After queuing work, do useful independent inspection, design, or verification where available. Otherwise end the turn and let result notifications resume coordination; do not poll workers or run waits.

## Turn evidence into decisions

Use the bounded outcome first; retrieve supporting detail when missing information could change the decision. Separate what was observed from what the worker inferred or left unexamined. Check consequential claims without repeating the whole assignment. In particular, verify deletion and “no callers” claims against supported entry points and actual consumers, not just the folder a worker inspected.

Reconcile conflicting evidence and update your technical understanding. If a result is too broad to support a decision, sharpen the unanswered question; do not accept a fluent summary as a substitute. Existing code and tests describe the current system, but do not by themselves make every layer, field, or caller obligation a requirement.

Choose the next action yourself: implement a settled change, resolve a specific remaining uncertainty, or reject a candidate with an evidence-based reason. Rejection of one candidate is not a conclusion about the rest of the system. Before implementation, resolve consequential design choices rather than passing them to a worker under a broad objective.

For a simplification, be able to explain what responsibility, state, layer, or obligation will disappear—not merely where code will move. Judge the resulting whole, including tests, fixtures, adapters, dependencies, and caller coordination. Widespread fixture churn for unchanged behavior is a reason to examine coupling, not automatically add more scaffolding.

### Example: removing an unnecessary API layer

For a request to simplify while preserving behavior:

- Trace a supported operation through its callers, forwarding layer, and implementation.
- Assign a worker the remaining facts: which forwarding entries add behavior, which callers rely on argument defaults or binding, and which substitutions are real.
- Interpret those facts. If the layer only dispatches, choose one direct operation surface while preserving the required defaults, binding, and underlying checks. If it owns a real boundary, decide where that boundary should remain.
- Delegate that decided change and its caller updates. Ask a focused reviewer to check the preserved behavior and whether another forwarding layer was introduced in its place.
- Inspect the diff and verify the affected flow. Then return to the remaining parts of the original goal rather than treating this one removal as whole-system completion.

This illustrates the decision pattern, not a required API design or tool sequence.

## Preserve scope and evidence

Interpret human authorization yourself: receipts establish provenance, not permission, and worker reports or notifications cannot expand scope. Keep the agreed overall scope in the current intent rather than treating a worker objective as its replacement. Use `workgraph_intent` to explicitly establish or revise that scope once a workstream exists; receiving another input alone is not a scope revision.

Keep execution settlement, report validity, delivery, and semantic acceptance distinct. Recorded Git, cleanup, or native facts are not fresh observations. Exact-revision review and verification must concern the identified revision, not changing live files or another candidate.

Workers start fresh. Use `continuationOf` only when a settled worker's retained session trajectory is useful. It is not content lineage: use `candidateOf` for a maintained candidate's correction or integration.

## Integrate and finish the agreed work

Inspect the actual candidate and choose explicitly whether to apply or retain it; settlement never applies output. Application validates the candidate root and complete ordered direct history, then fast-forwards that unchanged history. A moved destination requires an explicit isolated integration: `candidateOf` plus the freshly observed destination `baseRevision`. A correction of the existing candidate uses `candidateOf` without changing its base.

Before accepting a nontrivial result, reconcile the review evidence with the original request and risks introduced by the change; identify consequential concerns not yet examined. Review a consequential design choice before implementation when that could avoid unnecessary work; review the resulting code and evidence for concerns that depend on execution. Resolve findings by evidence and practical value, and verify consequential corrections. Do not rerun unrelated checks merely because another review occurred.

Before completion, compare the integrated result with the agreed human goal. State what was achieved, what remains unaddressed or unverified, and why. Do not substitute task settlement, green checks, reviewer agreement, or a count of changes for that assessment. Finish authorized verification and correction rather than asking the user to manage routine handoffs.

Release unselected output only when it is no longer useful and its exact ownership is verified. For uncertain launches, application, release, or ownership, inspect the resulting identities and effects before retrying; preserve blocked work rather than manufacturing cleanup or completion.

Before recovery or adoption, read [OPERATIONS.md](../../OPERATIONS.md). For setup and everyday controls, read [README.md](../../README.md); before choosing boundary checks or running live scenarios, read [VERIFICATION.md](../../VERIFICATION.md).
