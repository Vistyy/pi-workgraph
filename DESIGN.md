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

Coordinator response notes are session-owned semantic memory for substantive human-facing answers, requested outcomes, or status that may need a later human response.
A note is distinct from a human input receipt, Workstream delivery acknowledgment, evidence disposition, and intent authority.
A genuine later interactive or RPC receipt is required before a coordinator may resolve a note, but the model's resolution call remains an interpretation and does not grant workstream authority.
Notes retain the cited receipt and visible-assistant provenance, never infer that a human read an answer, and never block workstream completion.
Drafting a note does not prove that an answer was visible; presentation is associated with a finalized assistant entry when Pi exposes that boundary.
Operational notifications, tool delivery, unrelated input, and session settlement do not resolve notes automatically.
Partial replies resolve only the notes the coordinator explicitly judges addressed, while superseding status consolidates unresolved points without deleting their provenance.
The note state is persisted in the Pi session branch and supplied as compact hidden context independently of Calm and WorkstreamStore state.
Semantic address detection remains model judgment with ambiguity and terse-reply limitations, so the implementation must not claim actual read detection or demand acknowledgment ceremony.

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

### Keep lifecycle ownership explicit

Effect 4 provides one structured lifecycle and concurrency model for the active coordination runtime rather than a parallel public workflow interface.
The workstream runtime owns its scoped registry and lease, serialized operations, background fibers, and shutdown.
The process adapter owns each child from acquisition through timeout, interruption, and release, with a Promise adapter only at host-facing boundaries.
The workstream store owns serialized atomic state-file mutation, while the registry owns only the durable index and fenced lease records.
These boundaries keep resource lifetime and persistence responsibility with the component that can verify their postconditions.

### Evolve one cohesive system

Prefer the smallest maintainable design with cohesive ownership boundaries.
When a design is superseded, simplify or delete the old path and its incidental machinery rather than preserving scars.
Do not create parallel interfaces, frameworks, or compatibility layers without a concrete current need.
Keep rationale, interface reference, runtime behavior, and verification guidance with their respective owners instead of duplicating them.
