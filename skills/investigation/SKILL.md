---
name: workgraph-investigation
description: Optional composable guidance for investigation tasks when it matches the current outcome.
---

# Investigation

## Purpose

Use this skill to answer a read-only question, test a premise, or recommend between alternatives.
The deliverable is a cited explanation or decision, not a repository change.
If the investigation establishes that code must change, finish this skill and route the new outcome through Bug fix, Feature, Refactoring, or Performance.

## Completion predicate

The run is complete when the original question has a direct answer supported by decisive source or runtime evidence, material contradictions are reconciled, and decision-relevant unknowns are stated.

## Step 1: `frame`

Rewrite the request as one bounded question in the user's terms.
State which observation could answer it and which uncertainty could materially reverse the answer.
Reject false premises explicitly instead of investigating around them.
Choose the fan-out shape before launching discovery.
Use partitioned discovery for distinct subsystem responsibilities, replicated discovery for independent judgment on the same uncertain question, and evidence discovery for current mechanics, history, or external constraints that require different sources.
Do not fan out when one short source trace can settle the question.

## Step 2: `trace`

Trace the current mechanism from entry point to observable result.
Require concrete file, symbol, command, state, or runtime pointers rather than summaries such as "the service handles it."
Use one partitioned lane per genuine subsystem seam when the question crosses boundaries.
Give every lane one responsibility and no overlapping obligation to produce the final answer.
The coordinator owns synthesis and must read the referenced evidence rather than trusting a worker's confidence.

## Step 3: `investigate`

Add historical or external investigation only when rationale or compatibility could change the conclusion.
Use evidence lanes with distinct source categories, such as code history, authoritative documentation, stored data, or live behavior.
Use a replicated panel when the task asks for judgment and one model's prior could dominate the answer.
Send the same neutral question to each replicated lane and preserve model diversity from the configured panel.
Account explicitly for completed, failed, timed-out, cancelled, and unavailable lanes.
Proceed after a dropout only when the remaining evidence still supports the completion predicate, and state the reduced confidence.

## Step 4: `reconcile`

Separate observations, inferences, conflicts, and unknowns.
Resolve conflicting reports by inspecting their cited sources or by running the smallest discriminating observation.
For a recommendation, compare only credible alternatives against the controlling trade-off.
Recommend the direction best supported by evidence and state what new fact would reverse it.
Do not average incompatible conclusions or turn every concern into an open decision.

## Step 5: `report`

Answer the bounded question first.
For explanatory work, describe the mechanism, where it lives, and the important failure or edge behavior.
For a decision, provide the recommendation, decisive trade-offs, and reversal condition.
Include compact source pointers and artifact paths instead of transcript dumps.
Mark any unsupported premise as unknown rather than presenting it as fact.

## Failure and escalation

A missing source is not automatically a human decision.
Try a different evidence surface or narrow the claim first.
Ask the user only when an answer depends on product intent, preference, or authority that repository and runtime evidence cannot establish.
Do not create implementation nodes under this skill.
