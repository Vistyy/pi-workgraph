---
name: workgraph-architecture
description: Optional composable guidance for architecture tasks when it matches the current outcome.
---

# Architecture

## Purpose

Use this skill when ownership, public interfaces, state models, failure semantics, or expensive-to-reverse module boundaries must be decided before implementation.
Do not use it merely because more than one file changes.
The output is one coherent design package that implementation can follow and verification can test.

## Completion predicate

The run is complete when current-system constraints are grounded, at least two credible whole-shape designs have been considered where uncertainty is real, one design is selected against explicit trade-offs, and the implementation envelope names its owners and verification boundary.

## Step 1: `ground`

Trace callers, data flow, state ownership, side effects, failure paths, and the observable product boundary.
Use partitioned discovery for distinct subsystems and evidence discovery for history or external contracts.
The coordinator must distinguish observed contracts from conventions that happen to hold in current code.
Treat a fact as an invariant only when one owner enforces it for every supported path.
If a missing domain term affects ownership, resolve it from project authority before naming new APIs.
Skip this step only for genuinely greenfield work with no integration boundary.

## Step 2: `sketch`

Write the caller's usage first, then derive types, signatures, state transitions, and module ownership.
Generate at least two structurally distinct candidates when more than one ownership model is credible.
Use replicated discovery with the same neutral design brief and two or three heterogeneous models.
Each candidate must describe caller knowledge, invariant owner, failure behavior, migration shape, verification seam, and what it deletes.
Reject candidates that only rename layers, add pass-through wrappers, split code by temporal sequence, or require callers to know hidden rules.
Do not require artificial alternatives when evidence leaves only one coherent structure; record why the second design was not credible.

## Step 3: `compare`

Compare candidates on the controlling consequences rather than implementation effort alone.
Assess interface depth, invalid states, shared mutable state, reversibility, operational failure, migration burden, reader load, and testability.
Prefer a smaller public surface that hides complexity behind one enforced boundary.
Prefer separating independently owned state before introducing synchronization.
Prefer removing replaced concepts directly unless an accepted compatibility requirement demands coexistence.
For substantial fan-out, use an independent synthesis or judge that sees neutral candidate labels and the same criteria.
The coordinator must still inspect decisive claims before selecting.

## Step 4: `judge`

Select one design and explain why it dominates the credible alternatives.
State the fact, scale change, compatibility requirement, or operational constraint that would reverse the decision.
If the difference depends on user preference or product authority, present that one decision at the agreement checkpoint.
If the difference is technical and evidence-supported, the coordinator decides without transferring unfinished analysis to the user.
Record rejected shapes and their failure modes compactly.

## Step 5: `select`

Convert the design into the implementation envelope and bounded worker briefs.
Name the owner of every new invariant and the boundary where it is enforced.
Partition implementation only where workers can claim disjoint paths or dependency-ordered scopes.
Put shared primitives and verification scaffolding before dependent features.
Define how the composed result will be observed and whether independent product verification is required.
Do not let implementation begin while material ownership or interface decisions remain unresolved.

## Implementation feedback

The design is a contract, not a prohibition on learning.
Repeated escape hatches, duplicated special cases, leaked internal rules, or incompatible state assumptions indicate that the design is wrong.
When that pattern appears, stop affected work, preserve evidence, re-ground the new constraint, and redesign rather than adding patches.
A single difficult edge case is not enough to discard a coherent design.

## Failure and recovery

Failed or unavailable design lanes are explicit dropouts.
Proceed only when the remaining candidates still expose the relevant design space.
After a pause, restore the selected design and rejected-alternative record before resuming implementation.
