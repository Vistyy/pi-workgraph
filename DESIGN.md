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
For a nontrivial change, the coordinator's judgment includes an externalized boundary design before implementation: surviving responsibility ownership, reused and removed mechanisms, interaction contracts, end-to-end interaction and state flow, integrations and affected consumers, and failure, ordering, precedence, concurrency, and lifetime behavior. Express those boundaries in the vocabulary of the work: software may require modules, APIs, types, and call/data/control flow, while user interfaces, configuration, instructions, or operating workflows may require actors, artifacts, events, states, decisions, handoffs, and observable outcomes. Worker planning may choose implementation mechanics beneath those boundaries; it must not become the first owner of the design. This is a proportional readiness boundary, not a mandatory document format or approval pipeline: a local change beneath stable contracts needs only its direct contract and flow.

Coordinator pending items are session-owned compact id/text reminders for future coordination, persisted independently of WorkstreamStoreEffects and injected only as a cache-friendly hidden snapshot when needed.
The coordinator-only notepad exposes read, add, update, and remove; removing a mistaken item is ordinary editing, with no receipt, presentation, acknowledgment, auto-expiry, or authority semantics.
Pending items do not replace genuine human input receipts or intent authority, and never block workstream completion.
Legacy response-note snapshots migrate only their currently pending substance into the notepad; presentation, draft, resolution, and supersession ledger metadata are not continued.
Compaction, reload, resume, and branch restoration recover the latest valid notepad snapshot; malformed state is retained and warned about rather than guessed or cleared.
The implementation must not parse task prose or replies to infer repository choice or item removal.
Worker implementation prewalk owns one concise current plan with a local approach, rationale, risks, and concrete implementation/verification steps. Initial step count is guidance rather than a lifetime bound, and every explicit requirement remains represented. A separate serialized-size ceiling bounds recovery context. The guide establishes the initial plan within the coordinator's settled assignment; the executor may target its mutable local overview, steps, and notes as evidence changes, but the independently restored assignment remains authoritative and consequential conflicts require escalation rather than inferred scope. One static plan tool enforces phase permissions at execution time and assigns stable monotonic step IDs. Removal changes the current plan without reusing the removed identity; append-only session history preserves the operation. Plan mutations never rewrite earlier model-visible history or change the system prompt or tool definitions during the session, preserving the provider request prefix. Plan statuses are navigation only, never correctness evidence, authority, or a completion gate. The plan is persisted with the exact workstream/attempt identity, and malformed or foreign snapshots are ignored conservatively rather than guessed. Recovery independently restores the latest exact current-attempt objective from raw session state, while unfinished actionable steps may cause only a persisted, named, bounded reconciliation follow-up; blocked-only plans and terminal reports do not cause a loop or delay native settlement.

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

Coordinator guidance is package behavior rather than optional skill discovery. One plainly readable `COORDINATOR.md` is appended to the coordinator system prompt on every turn, never registered as a skill or persisted as repeated session messages. Its content should contain only cross-tool judgment and operational relationships that tool contracts and general agent instructions do not already establish.

### Derive mechanics, expose judgment

The runtime should derive mechanical state when it can establish it from authoritative events and repository or resource facts.
It should not require agents to narrate bookkeeping that the runtime can compute reliably.
It must keep mechanical settlement distinct from human judgment and current-intent authority; reports and application facts must not manufacture either one.
Completion retains the coordinator's goal-level conclusion, evidence, and limitations alongside automatically derived operational accounting. Failed, unapplied, and undelivered work remains visible without requiring the coordinator to reconstruct its identifier/reason map. Resource-settlement checks do not establish goal coverage or fulfillment.

A required, complete user-owned model policy is the sole source of executable targets and thinking levels. Research, review, and consultation advisors are ordered nonempty lists whose first target is the default; implementation guide and executor are single targets. The runtime reads this policy but never supplies defaults, fills missing roles, or rewrites it.

Worker count is independent of model diversity. Research and review may repeat their default or one configured model, or deliberately select distinct configured targets in policy order. Consultation may select one configured advisor model ID. Callers cannot supply arbitrary targets or thinking levels, and implementation exposes no per-assignment model choice. Unsupported or unconfigured choices fail before assignment state is created; persisted attempts retain resolved exact targets and minimal selection provenance.

Consultation is an optional evidence-only decision aid with the same worker lifecycle as ordinary read-only research. One `workgraph_consult` assignment launches one advisor with the precise question, coordinator-known context, and selected policy target; the advisor may inspect the repository and returns one standard research report. There is no enrichment phase, frozen packet, phase-transition state, conditional candidate annotation, provider preflight, fallback history, or automatic fallback submission. Advice does not change authority, scope, acceptance, or completion judgment.

Preserve genuine authority, input and model provenance, exact resource ownership, and the scope under which evidence was produced.
Represent uncertainty explicitly, especially when an operation may have taken effect despite an interrupted response.
Recovery should inspect authoritative state before retrying and should retain conflicting or blocked work when safe automatic settlement is not justified.

### Separate worker, output, and coordination lifetime

A stopped worker closes independently of whether its report is successful, malformed, or failed and independently of whether its owned output remains useful.
A stopped isolated attempt first persists its report and exact Git identity, then closes its worker. A successful clean attempt compacts its checkout with ordinary `git worktree remove`; changed implementations and advanced disposable experiments retain only their exact worker branch, while zero-commit experiments, successful no-change, and read-only output remove both checkout and temporary branch. Failed, cancelled, malformed, dirty, moved, foreign, or uncertain output remains physically retained and blocks completion until explicit exact-attempt release; report settlement never mutates the destination repository.
The coordinator may apply current maintained output only by explicitly selecting the exact attempt. The runtime proves the complete candidate history, previews a clean attached destination and conflicts with Git's off-checkout merge tree, then checkpoints only source lineage and expected ref/HEAD. After the checkpoint it re-proves current intent, ownership, candidate tip, and destination while preparing an already-integrated result, a linear fast-forward, or a fresh ordered-parent merge commit; mutation uses only `git merge --ff-only`, and the prepared expected ref remains ephemeral while the returned revision is post-checked against that clean attached ref. A retained maintained candidate may produce isolated correction attempts through separate content-lineage metadata, distinct from session `continuationOf`; conflict, rewritten/unrelated history, or semantic integration instead requires an explicit `candidateOf` integration onto the exact current `baseRevision`. Recovery proves final structure rather than causality: an unchanged non-ancestral destination remains retryable, exact candidate or merge shape counts as applied, and every other state—including a descendant beyond the exact expected result or a switched ref—blocks without rollback or automatic retry. An applied checkpoint retry skips Git and resumes exact output release; the recorded application revision is not an approval ledger.
The coordinator releases retained branches or cleanup-blocked physical output through one exact-attempt operation with a recorded destructive reason. Release is allowed only after worker closure and removes only verified owned resources. Branch-only useful output may outlive semantic coordination completion and remains explicitly releasable under the same serialized, fenced runtime. If checkout removal succeeds before the response is interrupted, retry is safe only when the exact branch and its expected commit remain; any unproven postcondition stays blocked.

Exceptional application or output-release state is evidence to inspect, not a specialized automatic repair pipeline.
Reattachment may conservatively observe exact identities and postconditions, but it must not blindly retry or manufacture retained-not-applied state.

### Keep lifecycle ownership explicit

Effect 4 provides one structured lifecycle and concurrency model for the active coordination runtime rather than a parallel public workflow interface.
The workstream runtime owns its scoped discovery locator and private lease, serialized operations, background fibers, and shutdown.
Its acquisition is eager and returns only after the lease-backed handle is ready; acquisition failures therefore fail attachment directly rather than leaving a lazy, partially initialized runtime.
An Effect semaphore serializes mutations, caller interruption cancels queued or running coordinator operations through ordinary fiber interruption, and a scoped FiberSet interrupts and joins owned operations before lease release.
Owned-worker cancellation is a separate durable boundary: it records the cancellation request, interrupts a retained worker when possible, and settles without a report only after cleanup verifies idle-worker closure or exact external absence; unknown presence remains blocked. Reconciliation may re-enter only the guarded worker-closure stage for a pending `workerClosed:false` checkpoint, keeping ordinary working observations pending without attention; after `workerClosed:true`, successful clean output may compact according to its exact report, while cancelled or otherwise uncertain isolated output remains blocked for explicit release.
One idempotent close boundary handles explicit shutdown and fatal lease loss; custom request queues, request settlement signals, and separate ready/start/fatal lifecycle channels are unnecessary because the Effect primitives already provide those guarantees.
The Effect-native process owner owns each child from acquisition through timeout, interruption, and release; host-facing boundaries are the only places that convert it to a Promise.
Each workstream owns one private `workstream.sqlite` database at its canonical state path. Its validated workstream state is one JSON aggregate row and its fenced lease is a sibling row; one SQLite transaction performs the read, validation, mutation, lease predicate, write, and commit. The global registry is only a run-id to state-path locator. Existing registries with historical lifecycle/project/phase columns retain their old tables and rows untouched; a small same-file current-locator table records new workstreams, and neither table is used for ownership.
Current JSON state is a read-only historical source. An explicit adoption may import one exact current JSON path to its derived SQLite path only after authoritative prior-owner death and a source readback check; startup reattachment never migrates a live JSON owner. Terminal JSON history remains lossless and inspectable. Predecessor model metadata written under the current Workstream version is normalized only at the read boundary; ordinary reads do not rewrite it, and the next legitimate state mutation persists only the current minimal shape.
These boundaries keep resource lifetime and persistence responsibility with the component that can verify their postconditions.

### Evolve one cohesive system

Prefer the smallest maintainable design with cohesive ownership boundaries.
When a design is superseded, simplify or delete the old path and its incidental machinery rather than preserving scars.
Do not create parallel interfaces, frameworks, or compatibility layers without a concrete current need.
Keep rationale, interface reference, runtime behavior, and verification guidance with their respective owners instead of duplicating them.
