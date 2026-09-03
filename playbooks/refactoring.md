# Refactoring

## Purpose

Use this playbook when structure changes while supported behavior must remain stable.
A refactor may remove or reorganize code, but it must not silently introduce a feature or bug fix.
If investigation reveals a behavior change is necessary, split it into a separately agreed run.

## Completion predicate

The run is complete when the pre-change behavior contract is pinned, the target structure has lower reader load or fewer invalid states, every caller uses the new shape, replaced paths are removed, and composed behavior is proven equivalent.

## Step 1: `baseline`

Trace the current callers, data flow, state, side effects, and error behavior.
Capture a characterization, snapshot, replay, output comparison, or realistic product baseline before moving structure.
Type checking and linting are not behavior baselines.
Use partitioned discovery when several consumers express different parts of the contract.
Use history evidence only when compatibility or intentional odd behavior could constrain the refactor.
Record which behavior is supported and which accidental behavior is explicitly outside the contract.

## Step 2: `target`

Name the structural problem in terms of ownership, invalid states, duplication, indirection, or reader burden.
Describe the target call graph, module map, types, and public surface as if built today.
Use Architecture when the target crosses an ownership or interface boundary and more than one shape is credible.
The target must remove branches, invalid states, duplicated rules, or layers between question and answer.
Do not introduce an abstraction without an invariant to own or a demonstrated second consumer.
State a measurable reader-load delta before implementation.

## Step 3: `subtract`

Delete dead code, orphan references, redundant validation, one-caller pass-through wrappers, and superseded documentation before adding a replacement.
Keep only compatibility behavior that an accepted requirement demands.
Re-ground generated artifacts in their generator and regenerate rather than editing output directly.
Reject speculative cleanup that does not contribute to the target shape.
Use the structure reviewer later to challenge every newly introduced layer.
Preserve the behavior baseline while subtracting.

## Step 4: `migrate`

Decompose migration by disjoint caller groups only when one shared foundation can land first.
Give each worker exact renamed symbols, claimed paths, caller sets, baseline evidence, and forbidden behavior changes.
Migrate callers and delete the old API in the same bounded wave unless compatibility is approved.
Do not keep parallel old and new paths for convenience.
Spot-check strings, documentation, configuration, generated references, and indirect callers that mechanical rename tools can miss.
Compose and verify each dependency-ordered unit before advancing.
If implementation repeatedly needs casts, optional fields that are always present, or leaked internal rules, stop and redesign the target.

## Step 5: `prove`

Replay the pre-change baseline against the composed revision.
Use direct output equivalence, recorded interaction replay, or matching-surface product verification for larger changes.
Confirm every caller uses the intended boundary and the replaced API is absent.
Measure the promised reader-load change through fewer concepts, paths, branches, or layers.
Run structure assurance with a strong deletion bias and evidence assurance against duplicate or implementation-coupled tests.
Revert a reshape that fails to simplify ownership even if checks pass.

## Failure and recovery

A failing equivalence check means the behavior changed or the baseline was incomplete.
Classify which before modifying more code.
After a node failure, preserve completed migration units and replace only the failed scope.
An approved behavior change requires a new envelope rather than a relaxed baseline.

## Output

Report the pinned contract, old and new ownership shape, deleted concepts, caller migration, equivalence evidence, reader-load delta, exact revision, and any discovered behavior change excluded from this run.
