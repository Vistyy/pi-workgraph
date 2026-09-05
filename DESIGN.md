# Workgraph design

This document owns the durable rationale and constraints for Workgraph's coordination design.
It describes the direction to preserve, not a claim that every target is already implemented.
API details, operating instructions, verification policy, and historical findings belong elsewhere.

## Vision

Workgraph should help an agent make better coordination decisions while preserving the facts needed to trust, inspect, and recover those decisions.
Coordination machinery should support the work rather than turn bookkeeping into the work.

## Design constraints

### Keep judgment primary

The human request is the source of authority, and the coordinating agent decides which contributions are useful within it.
Delegated research, experiments, implementation, review, and integration are capabilities, not mandatory phases or an approval pipeline.
Mechanical receipts, validation, and settlement must not manufacture authority or replace human judgment.

Optimize for total tokens, calls, and correct decisions across the task rather than minimizing or maximizing tool use in isolation.
A direct answer can be better than delegation, and one well-bounded delegation can be better than repeated coordinator work.

### Present outcomes, retain substance

Routine notifications should communicate a useful bounded outcome without replaying the work history.
Optional drill-down should expose the complete retained evidence, findings, uncertainty, provenance, and recovery details without loss.
Concise presentation must not erase information needed for a later decision.

User-facing task handles should be short and semantic so people can discuss purpose rather than storage mechanics.
Internal identities must remain exact and authoritative wherever ownership, settlement, cleanup, or recovery depends on them.
Display names and semantic handles must not be mistaken for resource identity.

### Derive mechanics, expose judgment

The runtime should derive mechanical state when it can establish it from authoritative events and repository or resource facts.
It should not require agents to narrate bookkeeping that the runtime can compute reliably.
It must keep mechanical settlement distinct from semantic acceptance, disposition, and other judgments that belong to a human or coordinating agent.

Preserve genuine authority, input and model provenance, exact resource ownership, and the scope under which evidence was produced.
Represent uncertainty explicitly, especially when an operation may have taken effect despite an interrupted response.
Recovery should inspect authoritative state before retrying and should retain conflicting or blocked work when safe automatic settlement is not justified.

### Evolve one cohesive system

Prefer the smallest maintainable design with cohesive ownership boundaries.
When a design is superseded, simplify or delete the old path and its incidental machinery rather than preserving scars.
Do not create parallel interfaces, frameworks, or compatibility layers without a concrete current need.
Keep rationale, interface reference, runtime behavior, and verification guidance with their respective owners instead of duplicating them.
