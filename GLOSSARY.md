# Glossary

Canonical language for Pi Workgraph's session-owned coordination records and retained repository output.

## Coordinator

The Pi session that decides what work to delegate, evaluates its evidence, and owns final synthesis and verification.

## Task

An immutable, decision-complete assignment contract and its exact target. A Task may have multiple Attempts.

## Attempt

One immutable execution specification for a Task, with mutable Worker and output facts and one optional write-once Outcome.

## Worker

The fresh delegated Pi session that executes one Attempt.

## Outcome

The Attempt's write-once semantic result and the models actually observed while producing it. An Outcome is distinct from repository output.

## Target

The resolved directory or repository recorded by a Task and inherited by every Attempt of that Task.

## Selection

The model target and thinking level frozen into an Attempt specification; implementation selections contain both guide and executor targets.

## `candidateOf: extend`

Lineage that continues from an exact retained Attempt candidate and therefore inherits that candidate's tip as its base.

## `candidateOf: integrate`

Lineage that starts from an explicit base and incorporates an exact retained Attempt candidate identified by its source tip.

## Output states

The operational custody state of an Attempt's repository result: retained, applying, discarding, no output, applied, or discarded.

## Calm

A coordinator-only render-time projection of Pi's live chat that hides Workgraph noise while leaving the native transcript unchanged.

## Notepad

A bounded, branch-local memo for pending coordinator context; it is not authority, durable work state, or an acceptance record.
