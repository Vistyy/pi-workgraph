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
The coordinator explicitly establishes the overall intent before delegating. Assignment objectives contribute to that intent; they do not create, replace, or authorize it. New input alone does not revise scope. The current goal must remain visible independently of running jobs.

Coordinator pending items are session-owned compact id/text reminders for future coordination, persisted independently of WorkstreamStoreEffects and injected only as a cache-friendly hidden snapshot when needed.
The coordinator-only notepad exposes read, add, update, and remove; removing a mistaken item is ordinary editing, with no receipt, presentation, acknowledgment, auto-expiry, or authority semantics.
Pending items do not replace genuine human input receipts or intent authority, and never block workstream completion.
Legacy response-note snapshots migrate only their currently pending substance into the notepad; presentation, draft, resolution, and supersession ledger metadata are not continued.
Compaction, reload, resume, and branch restoration recover the latest valid notepad snapshot; malformed state is retained and warned about rather than guessed or cleared.
The implementation must not parse task prose or replies to infer repository choice or item removal.
Worker implementation prewalk owns one bounded current plan with an approach, rationale and constraints, risks, and concrete implementation/verification steps. The guide owns its local execution approach, rationale, and initial risks within the coordinator's settled assignment; the executor may inspect it and target individual steps and notes to execute the inherited approach across handoff, reload, and compaction. Consequential approach conflicts require escalation, not inferred scope. One static plan tool enforces phase permissions at execution time, with tool-assigned stable step IDs and removal by retained supersession; all retained steps count toward the eight-step bound. Full snapshots persist in raw custom entries and new tool results convey updates without rewriting earlier model-visible history or changing the system prompt or tool definitions. Plan statuses are navigation only, never correctness evidence, authority, or a completion gate. The plan is persisted with the exact workstream/attempt identity, and malformed or foreign snapshots are ignored conservatively rather than guessed. Recovery independently restores the latest exact current-attempt objective from raw session state, while unfinished actionable steps may cause only a persisted, named, bounded reconciliation follow-up; blocked-only plans and terminal reports do not cause a loop or delay native settlement.

Optimize for total tokens, calls, and correct decisions across the task rather than minimizing or maximizing tool use in isolation.
A direct answer can be better than delegation, and one well-bounded delegation can be better than repeated coordinator work.

### Select one repository, derive all mechanics

A workstream's explicit intent selects one target repository. Its root and Git common directory are inspected when the workstream is created and retained in state. Assignments inherit that identity and the current intent's authority rather than selecting them again; a scope revision cannot silently retarget the repository.
Coordinator cwd is only the default when no target is supplied; it is not an authority or placement identity. Adoption and runtime construction use the retained project root, so a coordinator may live in another directory.
Base revisions, isolated worktrees, shared placements, exact-revision review instructions, worker working directories, commit requirements, and recovery checks are generated from that fixed repository and persisted attempt state rather than task-prose parsing. Exact-revision reviews use owned worktrees at the requested existing SHA, without requiring a prior Workgraph result to make that revision reviewable; ordinary shared research and non-revision review keep their live-project behavior.

### Present outcomes, retain substance

Routine notifications should communicate a useful bounded outcome without replaying the work history.
Optional drill-down should expose the complete retained evidence, findings, uncertainty, provenance, and recovery details without loss.
Concise presentation must not erase information needed for a later decision. Worker reports should retain concrete evidence, findings, and uncertainty without mandatory classifications that add no distinct decision or evidence value; historical raw content remains readable.

User-facing task handles should be short and semantic so people can discuss purpose rather than storage mechanics.
Internal identities must remain exact and authoritative wherever ownership, settlement, cleanup, or recovery depends on them.
Display names and semantic handles must not be mistaken for resource identity.

### Derive mechanics, expose judgment

The runtime should derive mechanical state when it can establish it from authoritative events and repository or resource facts.
It should not require agents to narrate bookkeeping that the runtime can compute reliably.
It must keep mechanical settlement distinct from human judgment and current-intent authority; reports and application facts must not manufacture either one.
Completion retains the coordinator's goal-level conclusion, evidence, and limitations alongside automatically derived operational accounting. Failed, unapplied, and undelivered work remains visible without requiring the coordinator to reconstruct its identifier/reason map. Resource-settlement checks do not establish goal coverage or fulfillment.

Per-assignment model inputs express actual choices in one form per capability. Omitted components resolve from role policy, and the runtime records resolved targets and selection provenance without requiring a caller-written justification. Unsupported options must reject rather than silently do nothing. Historical provenance and saved model-policy compatibility are separate from new-input aliases.

Consultation is an optional decision-aid capability, not a mandatory workflow phase. One consultation assignment owns one outer attempt and a persisted enricher-to-advisor envelope. The enricher is mandatory within that capability: it runs read-only in a fresh session and may terminate only with a strict bounded packet containing source observations, counterevidence, local-state identity, and explicit gaps. The packet is durably retained before closing the enricher. A fresh read-only advisor then receives the question, constraints, coordinator context, and frozen packet, but no enricher transcript; its terminal text is retained as consultation evidence. Neither phase changes authority, scope, acceptance, or completion judgment.

Consultation policy keeps a singleton exact enricher target and an ordered advisor list. Each advisor phase retains exact session/resource/submission/cleanup/model evidence in the envelope history. Ordered choices may carry presentation-only `useWhen` guidance; selected targets, overrides, and execution receipts remain exact `{model, thinking}` values. Pre-submission model availability and thinking support are checked without clamping. A policy advisor may advance only when no remote submission is possible/proven and the exact generation- and target-bound result is conclusive: local `missing_model`, `missing_credentials`, or `unsupported_thinking` preflight, or a trusted provider marker explicitly bound to model/thinking that says `unavailable` and `not_submitted` with a retained reason. Bare not-submitted observations, missing resources/workers, generic errors, absent/malformed/contradictory evidence, and mismatched targets do not authorize fallback. The pre-prompt rejection remains `not_sent`; a settled provider marker is handled only after clean phase closure. An exact override never falls through. After submission may have occurred, native errors or missing/contradictory not-submitted evidence are uncertain and must not trigger a second advisor submission. Advisor evidence is the latest successful terminal assistant text, including all text blocks; earlier, partial, error, and aborted text is not retained.

Preserve genuine authority, input and model provenance, exact resource ownership, and the scope under which evidence was produced.
Represent uncertainty explicitly, especially when an operation may have taken effect despite an interrupted response.
Recovery should inspect authoritative state before retrying and should retain conflicting or blocked work when safe automatic settlement is not justified.

### Separate worker, output, and coordination lifetime

A stopped worker closes independently of whether its report is successful, malformed, or failed and independently of whether its owned output remains useful.
A disposable experiment and an unapplied implementation retain their complete owned isolated worktree; report settlement never mutates the destination repository.
The coordinator may apply current maintained output only by explicitly selecting the exact attempt. The runtime derives the reported source commit and candidate root, observes the actual destination, and refuses known drift before beginning application. Copying those hashes back would add a transcription check, not independent Git evidence. Candidate validation establishes the immutable source history once before the durable application checkpoint; live Git, ownership, and current-intent checks after that checkpoint still protect the mutation and its observed postcondition. The recorded application revision is not an approval ledger. A retained maintained candidate may produce isolated correction attempts through separate content-lineage metadata, distinct from session `continuationOf`; the final candidate carries its root and every direct correction commit, and application fast-forwards that complete unchanged history. If the destination moved, application refuses without mutation; only an explicit isolated integration attempt rooted at the freshly observed destination may produce a new candidate scoped to that base.
The coordinator releases unselected retained output through one exact-attempt operation with a recorded destructive reason. Cancellation closes the worker but preserves disposable experiment output until the coordinator explicitly releases it. Intentionally retained output may outlive semantic coordination completion and remains releasable under the same serialized, fenced runtime without launching or resuming work.
Release may remove only the verified owned worktree and branch; foreign, dirty-mismatched, unknown-presence, or uncertain resources remain intact with useful diagnostics.

Exceptional application or output-release state is evidence to inspect, not a specialized automatic repair pipeline.
Reattachment may conservatively observe exact identities and postconditions, but it must not blindly retry or manufacture retained-not-applied state.

### Keep lifecycle ownership explicit

Effect 4 provides one structured lifecycle and concurrency model for the active coordination runtime rather than a parallel public workflow interface.
The workstream runtime owns its scoped discovery locator and private lease, serialized operations, background fibers, and shutdown.
Its acquisition is eager and returns only after the lease-backed handle is ready; acquisition failures therefore fail attachment directly rather than leaving a lazy, partially initialized runtime.
An Effect semaphore serializes mutations, caller interruption cancels queued or running coordinator operations through ordinary fiber interruption, and a scoped FiberSet interrupts and joins owned operations before lease release.
Owned-worker cancellation is a separate durable boundary: it records the cancellation request, interrupts a retained worker when possible, and settles without a report only after cleanup verifies idle-worker closure or exact external absence; unknown presence remains blocked. Reconciliation may re-enter only the guarded worker-closure stage for a pending `workerClosed:false` checkpoint, keeping ordinary working observations pending without attention; after `workerClosed:true`, it finishes automatically only for shared placement or output retained by cleanup policy, and preserves an isolated destructive placement for inspection.
One idempotent close boundary handles explicit shutdown and fatal lease loss; custom request queues, request settlement signals, and separate ready/start/fatal lifecycle channels are unnecessary because the Effect primitives already provide those guarantees.
The Effect-native process owner owns each child from acquisition through timeout, interruption, and release; host-facing boundaries are the only places that convert it to a Promise.
Each workstream owns one private `workstream.sqlite` database at its canonical state path. Its validated workstream state is one JSON aggregate row and its fenced lease is a sibling row; one SQLite transaction performs the read, validation, mutation, lease predicate, write, and commit. The global registry is only a run-id to state-path locator. Existing registries with historical lifecycle/project/phase columns retain their old tables and rows untouched; a small same-file current-locator table records new workstreams, and neither table is used for ownership.
Current JSON state is a read-only historical source. An explicit adoption may import one exact current JSON path to its derived SQLite path only after authoritative prior-owner death and a source readback check; startup reattachment never migrates a live JSON owner. Terminal JSON history remains lossless and inspectable.
These boundaries keep resource lifetime and persistence responsibility with the component that can verify their postconditions.

### Evolve one cohesive system

Prefer the smallest maintainable design with cohesive ownership boundaries.
When a design is superseded, simplify or delete the old path and its incidental machinery rather than preserving scars.
Do not create parallel interfaces, frameworks, or compatibility layers without a concrete current need.
Keep rationale, interface reference, runtime behavior, and verification guidance with their respective owners instead of duplicating them.
