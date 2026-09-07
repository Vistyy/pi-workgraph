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

Coordinator pending items are session-owned compact id/text reminders for future coordination, persisted independently of WorkstreamStoreEffects and injected only as a cache-friendly hidden snapshot when needed.
The coordinator-only notepad exposes read, add, update, and remove; removing a mistaken item is ordinary editing, with no receipt, presentation, acknowledgment, auto-expiry, or authority semantics.
Pending items do not replace genuine human input receipts or intent authority, and never block workstream completion.
Legacy response-note snapshots migrate only their currently pending substance into the notepad; presentation, draft, resolution, and supersession ledger metadata are not continued.
Compaction, reload, resume, and branch restoration recover the latest valid notepad snapshot; malformed state is retained and warned about rather than guessed or cleared.
The implementation must not parse task prose or replies to infer repository choice or item removal.

Optimize for total tokens, calls, and correct decisions across the task rather than minimizing or maximizing tool use in isolation.
A direct answer can be better than delegation, and one well-bounded delegation can be better than repeated coordinator work.

### Select one repository, derive all mechanics

A workstream has one explicit target repository. Its root and Git common directory are inspected once when the workstream is created, retained in state, and compared on subsequent explicit target requests.
Coordinator cwd is only the default when no target is supplied; it is not an authority or placement identity. Adoption and runtime construction use the retained project root, so a coordinator may live in another directory.
Base revisions, isolated worktrees, shared placements, exact-revision review instructions, worker working directories, commit requirements, and recovery checks are generated from that fixed repository and persisted attempt state rather than task-prose parsing.

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
It must keep mechanical settlement distinct from human judgment and current-intent authority; reports and application facts must not manufacture either one.

Preserve genuine authority, input and model provenance, exact resource ownership, and the scope under which evidence was produced.
Represent uncertainty explicitly, especially when an operation may have taken effect despite an interrupted response.
Recovery should inspect authoritative state before retrying and should retain conflicting or blocked work when safe automatic settlement is not justified.

### Separate worker, output, and coordination lifetime

A stopped worker closes independently of whether its report is successful, malformed, or failed and independently of whether its owned output remains useful.
A disposable experiment and an unapplied implementation retain their complete owned isolated worktree; report settlement never mutates the destination repository.
The coordinator may apply current maintained output only through one explicit action carrying the exact attempt, reported source commit, and freshly observed destination HEAD. Existing Git cleanliness, direct-commit, ownership, and current-intent checks remain authoritative; the recorded application revision is an observed postcondition, not an approval ledger.
The coordinator releases unselected retained output through one exact-attempt operation with a recorded destructive reason. Cancellation closes the worker but preserves disposable experiment output until the coordinator explicitly releases it. Intentionally retained output may outlive semantic coordination completion and remains releasable under the same serialized, fenced runtime without launching or resuming work.
Release may remove only the verified owned worktree and branch; foreign, dirty-mismatched, unknown-presence, or uncertain resources remain intact with useful diagnostics.

Exceptional application or output-release state is evidence to inspect, not a specialized automatic repair pipeline.
Reattachment may conservatively observe exact identities and postconditions, but it must not blindly retry or manufacture retained-not-applied state.

### Keep lifecycle ownership explicit

Effect 4 provides one structured lifecycle and concurrency model for the active coordination runtime rather than a parallel public workflow interface.
The workstream runtime owns its scoped registry and lease, serialized operations, background fibers, and shutdown.
Its acquisition is eager and returns only after the lease-backed handle is ready; acquisition failures therefore fail attachment directly rather than leaving a lazy, partially initialized runtime.
An Effect semaphore serializes mutations, caller interruption cancels queued or running coordinator operations through ordinary fiber interruption, and a scoped FiberSet interrupts and joins owned operations before lease release.
Owned-worker cancellation is a separate durable boundary: it records the cancellation request, interrupts a retained worker when possible, and settles without a report only after cleanup verifies idle-worker closure or exact external absence; unknown presence remains blocked.
One idempotent close boundary handles explicit shutdown and fatal lease loss; custom request queues, request settlement signals, and separate ready/start/fatal lifecycle channels are unnecessary because the Effect primitives already provide those guarantees.
The Effect-native process owner owns each child from acquisition through timeout, interruption, and release; host-facing boundaries are the only places that convert it to a Promise.
The workstream store owns serialized atomic state-file mutation, while the registry owns only the durable index and fenced lease records.
These boundaries keep resource lifetime and persistence responsibility with the component that can verify their postconditions.

### Evolve one cohesive system

Prefer the smallest maintainable design with cohesive ownership boundaries.
When a design is superseded, simplify or delete the old path and its incidental machinery rather than preserving scars.
Do not create parallel interfaces, frameworks, or compatibility layers without a concrete current need.
Keep rationale, interface reference, runtime behavior, and verification guidance with their respective owners instead of duplicating them.
