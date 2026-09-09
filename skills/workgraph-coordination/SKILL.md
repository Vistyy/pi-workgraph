---
name: workgraph-coordination
description: Use when delegating or recovering repository work with Workgraph.
---

# Workgraph coordination

Use Workgraph to support coordinator-owned technical decisions with bounded evidence gathering and execution. This is a decision-driven loop, not a mandatory research → implementation → review pipeline. Use a separate coordinator conversation for unrelated work.

## Build the technical understanding

Start from the agreed human outcome, constraints, and supported behavior—not from a list of jobs to launch. Establish that scope and its target repository with `workgraph_intent` before delegating; assignments inherit them. This records the agreed scope, not another approval step. For broad work, keep a working outline of the relevant responsibilities, relationships, and unresolved questions. A compact notepad reminder may help preserve what remains to investigate; it is not another approval or completion ledger.

Inspect the important entry points, data or control flow, and callers yourself. Use workers to fill specific gaps while building and revising that understanding. Do not ask one worker to supply the architecture, priorities, and conclusion for an entire subsystem you have not understood.

Choose investigations that could change a decision. For example, ask which guarantee a wrapper adds, where a state value is produced and consumed, or what can change between two checks. “This subsystem needs safety checks” does not answer whether its current layers or duplicated checks are needed.

### Route consultation separately

Use consultation when the coordinator needs decision-oriented advice assembled from a precise question, rather than source observations for a research assignment, a subject-specific challenge for review, or an implementation change. Consultation is an optional capability, not a mandatory phase of every workstream or a replacement for those responsibilities. Route it through the dedicated consultation assignment/tool instead of disguising it as research or review.

A consultation delegation should supply:

- one precise decision question, including the decision or trade-off the advice should inform;
- coordinator-known context and constraints that materially affect that question;
- an optional focused enrichment request, without exhaustively preparing the evidence packet in the coordinator. The ordinary research enricher returns a standard report whose bounded evidence projection is frozen before its worker closes;
- one configured exact advisor target, or one complete exact per-assignment override. There is no ordered candidate list or silent fallback.

Treat consultation advice as non-authoritative input: it does not change intent, grant authority, accept work, or replace coordinator judgment. The fresh ordinary research advisor receives the precise question, coordinator context, and frozen projection, but no enricher transcript. Its standard research report is the sole consultation result. Failed or uncertain launch/settlement remains visible; do not issue a second submission automatically or infer success from a missing report.

Keep the overall goal distinct from each contribution. Completed investigations do not clear unexamined areas, and an empty active-attempt list does not establish that the human goal is met. Bring actual capability or policy trade-offs to the user with a recommendation and consequences, not an unfiltered collection of worker opinions.

## Settle the implementation boundary

Do not delegate a nontrivial implementation merely because the desired behavior and acceptance checks are known. Before calling `workgraph_implement`, externalize and settle the boundary design in the coordinator conversation when a change introduces or changes an interaction between independently responsible parts or actors; changes a shared contract or end-to-end flow; changes failure, ordering, precedence, concurrency, or lifetime semantics; or adds, removes, or replaces a mechanism. Judge this against the end-to-end requested operation and resulting system, not the size of one delegated slice: splitting cross-boundary work by file or task does not make its design local.

At that boundary, identify:

- which existing capabilities, components, roles, and mechanisms remain, which disappear, and who or what owns each surviving responsibility;
- the interaction contracts between them: inputs, outputs, assumptions, guarantees, invariants, and defaults, using signatures, types, or message shapes when those are the actual boundary;
- a compact diagram of the supported end-to-end interaction, choosing the relevant call, data, control, state, decision, or user flow and showing important persistence, external-system, or human handoffs;
- how integrations and affected consumers migrate, including failures, ordering, precedence, concurrency, lifetime, and forbidden effects that cross the boundary.

Use the vocabulary of the work while remaining concrete about actual existing surfaces. Software often needs modules, APIs, types, and call graphs; user interfaces, configuration, instructions, and operating workflows may instead need actors, artifacts, events, states, precedence rules, handoffs, and observable outcomes. Do not prescribe exact classes, functions, files, or local algorithms unless they are themselves a consequential boundary decision.

Present the boundary design to the human before implementation, with a recommendation and consequences for any trade-off that affects the requested outcome; settle routine technical details yourself rather than creating an approval ritual. The implementation assignment must carry this settled design; it must not be the first place the architecture appears. If any boundary item remains unknown, continue direct inspection, delegate a focused evidence question, or seek consultation instead of queuing implementation.

Leave private algorithms, local helper structure, and other mechanics beneath the settled contracts to the worker. For a genuinely local end-to-end change beneath stable contracts, a short before/after contract and direct interaction flow is sufficient; do not manufacture a diagram or process ceremony. A mechanical correction or integration may reference an already-externalized design and state only its local delta; if a conflict changes that design, settle the affected boundary before continuing.

## Shape bounded assignments

Split independent questions, implementation slices, and review concerns. Use multiple attempts when independent observations of the same question are useful; use separate tasks for different questions. Keep coupled changes together when splitting would merely create integration work. Available parallelism should improve coverage, not dilute the question or manufacture extra jobs.

Use the assignment fields to make the work independently judgeable:

- **Research:** put the precise uncertainty in `question` and the observations that would resolve it in `expectedEvidence`. Identify relevant source boundaries and callers, and distinguish facts to collect from the decision you will make. Request source references and explicit unknowns, not a verdict that the subsystem is good or necessary.
- **Implementation:** carry the already-externalized boundary design in `objective`: the contracts and flow, what changes or disappears, who owns the surviving behavior, which consumers or integrations change, and what failures, ordering, or precedence must be preserved. Put observable outcomes and meaningful verification expectations in `acceptance`. Leave mechanics beneath those boundaries to the worker; do not leave it to discover what “simpler” or “complete” means. The guide's prewalk refines execution inside that design rather than replacing it.
- **Review:** identify the exact `subject` and a specific `concern`, with the intended outcome and constraints needed to challenge it. For example, a complexity review asks which responsibilities or caller obligations remain unnecessarily; a verification review asks which plausible failures the checks would miss and which implementation changes would needlessly break them. Ask for discrepancies and evidence, not approval or a quota of findings.
- **Disposable experiment:** specify the permitted effects and stopping condition. Ask for observations that answer the question, including failures and limitations; do not turn successful execution into authorization for a maintained change.

Use the smallest representation that makes the design unambiguous. Cross-boundary work requires a contract outline and compact interaction or flow diagram; a local stable-contract edit may need only a one-line flow. No fixed design template or line-by-line implementation prescription is required.

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

Interpret human authorization yourself: receipts establish provenance, not permission, and worker reports or notifications cannot expand scope. Use `workgraph_intent` to record an agreed scope revision, not a worker objective or a newly received input as its implicit replacement. Routine assignments inherit current-intent authority even when newer input has arrived.

Keep execution settlement, report validity, delivery, and semantic acceptance distinct. Recorded Git, cleanup, or native facts are not fresh observations. Exact-revision review and verification must concern the identified revision, not changing live files or another candidate.

Workers start fresh. Use `continuationOf` only when a settled worker's retained session trajectory is useful. It is not content lineage: use `candidateOf` for a maintained candidate's correction or integration.

## Integrate and finish the agreed work

Inspect the actual candidate and choose explicitly whether to apply or retain it; settlement never applies output. Select the exact attempt; application derives its source and root, verifies the live destination and complete ordered direct history, then fast-forwards that unchanged history. A moved destination requires an explicit isolated integration: `candidateOf` plus the freshly observed destination `baseRevision`. A correction of the existing candidate uses `candidateOf` without changing its base.

Before accepting a nontrivial result, reconcile the review evidence with the original request and risks introduced by the change; identify consequential concerns not yet examined. Review a consequential design choice before implementation when that could avoid unnecessary work; review the resulting code and evidence for concerns that depend on execution. Resolve findings by evidence and practical value, and verify consequential corrections. Do not rerun unrelated checks merely because another review occurred.

Before completion, compare the integrated result with the agreed human goal. State what was achieved, what remains unaddressed or unverified, and why. The runtime retains operational accounting; your conclusion assesses the goal. Do not substitute task settlement, green checks, reviewer agreement, or a count of changes for that assessment. Finish authorized verification and correction rather than asking the user to manage routine handoffs.

Release unselected output only when it is no longer useful and its exact ownership is verified. For uncertain launches, application, release, or ownership, inspect the resulting identities and effects before retrying; preserve blocked work rather than manufacturing cleanup or completion.

Before recovery or adoption, read [OPERATIONS.md](../../OPERATIONS.md). For setup and everyday controls, read [README.md](../../README.md); before choosing boundary checks or running live scenarios, read [VERIFICATION.md](../../VERIFICATION.md).
