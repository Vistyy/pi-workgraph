# Workgraph design

This document owns the durable rationale and constraints for Workgraph's coordination design.
It describes the direction to preserve, not a claim that every target is already implemented.
API details, operating instructions, verification policy, and historical findings belong elsewhere.

## Decision records

Focused accepted decisions with meaningful reversal cost are recorded in [`docs/adr/`](docs/adr/). This document remains the integrated rationale for the complete system.

- [ADR 0001: Use TypeBox for schemas, Effect for lifecycles, and Node at host boundaries](docs/adr/0001-own-schemas-effects-and-host-adapters.md)
- [ADR 0002: Project Calm over the live Pi chat instead of filtering Pi components](docs/adr/0002-project-calm-over-the-live-pi-chat.md)

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
Compaction, reload, resume, and branch restoration recover the latest valid notepad snapshot; malformed state is retained and warned about rather than guessed or cleared.
The implementation must not parse task prose or replies to infer repository choice or item removal.
Implementation Prewalk is one same-session guide-to-executor trajectory. Its plan tool owns only the latest successful result-detail snapshot of a strict 1–9 item TODO; each item has a caller-owned id, text, validation, status, and optional note. The only operations are get, set, and update. TODO status is navigation, never correctness evidence, authority, or a completion gate.

The guide exposes only planning policy and may report no change, failure, or escalation without a cutover. Executor selection starts exactly after both a valid initialized TODO and one successful direct edit or write, regardless of order; failed mutations, bash, and Git observations are not evidence. Successful model and thinking selection is followed by one exact-attempt executor-start marker. The next provider request replaces the guide policy with the executor completion policy without changing assignment authority. A selection failure leaves no start marker, remains guide-owned, emits one model-visible diagnostic, disables further direct mutation, permits truthful failure or escalation, and is never retried automatically. Recovery derives TODO, mutation, selection failure, and phase from these same branch entries rather than mirrored phase state. Changed completion still requires a later executor assistant message. Actionable TODOs may cause only the accepted bounded settle reminders; blocked-only TODOs and terminal reports do not loop or delay settlement.

Optimize for total tokens, calls, and correct decisions across the task rather than minimizing or maximizing tool use in isolation.
A direct answer can be better than delegation, and one well-bounded delegation can be better than repeated coordinator work.

### Let Tasks own exact targets

A Workstream owns one repository-neutral initiative. Each immutable Task records one resolved directory or repository target, and its Attempts inherit that target. Coordinator cwd is only the default when no target is supplied; it is not authority or placement identity.
A Workstream may therefore coordinate Tasks in several repositories without distributed transactions, rollback, dependencies, or all-or-nothing application claims. Base revisions, isolated worktrees, exact-revision review instructions, Worker cwd, and Git recovery derive from each exact Task and Attempt rather than task-prose parsing. Apply, discard, and recovery remain per exact Attempt and repository.

### Present outcomes, retain substance

Routine notifications should communicate a useful bounded outcome without replaying the work history.
Optional drill-down should expose the complete retained evidence, findings, uncertainty, provenance, and recovery details without loss.
Concise presentation must not erase information needed for a later decision. Worker reports retain concrete evidence, findings, and uncertainty without mandatory classifications that add no distinct decision or evidence value; one strict current shape bounds tool input, persistence, and restoration alike.

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

Consultation is an optional evidence-only decision aid with the same worker lifecycle and report mode as ordinary read-only research, but a distinct stable advisor system policy owns its evidence-not-authority boundary. One `workgraph_consult` assignment launches one advisor with the precise question, coordinator-known context, and selected policy target; the advisor may inspect the repository and returns one standard research report. There is no enrichment phase, frozen packet, phase-transition state, conditional candidate annotation, provider preflight, fallback history, or automatic fallback submission. Advice does not change authority, scope, acceptance, or completion judgment.

Preserve genuine authority, input and model provenance, exact resource ownership, and the scope under which evidence was produced.
Represent uncertainty explicitly, especially when an operation may have taken effect despite an interrupted response.
Recovery should inspect authoritative state before retrying and should retain conflicting or blocked work when safe automatic settlement is not justified.

### Keep Handoff one-shot

A Handoff is a nonpersisted capability, not parent Workstream state. `workgraph_handoff(request, includeContext?)` reads the current Workstream and Intent only to derive one exact narrowed grant and its fixed repository. It creates no parent Task, checkpoint, reconciliation work, cancellation relation, completion gate, result channel, or retry obligation.

Each invocation creates one fresh parentless Pi session using Pi's default model configuration. The child session retains the exact grant needed to bootstrap its independent grant-grounded Workstream and one kickoff through the normal coordinator startup path. Optional context contains only the discussion before the persisted invoking tool call, excludes Workgraph-owned entries, and is explicitly non-authoritative.

The capability submits one Herdr coordinator launch and waits within that call for exact identity across the session file, repository cwd, workspace, tab, pane, terminal, agent name, and native Pi identity; either Herdr `working` or `idle` is launch-ready once that identity is exact. Success returns only that identity. The current Herdr adapter has no conclusive prelaunch failure classification, so every launch failure is uncertain: retain the child session and every known native resource, and never speculate cleanup or retry. An interrupted caller may receive no adapter result and therefore no handles; this limitation does not authorize cleanup, resubmission, or parent recovery state.

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
A suspended Workstream retains one current reason and timestamp. Suspension excludes queued activation, incomplete placement launch, and Outcome delivery while preserving exact Worker settlement, cancellation, and retry-safe cleanup; a dispatch barrier orders full frontier reclassification with the lifecycle commit, and resumption derives eligible work from current durable facts rather than rebuilding history.
Its acquisition is eager and returns only after the lease-backed handle is ready; acquisition failures therefore fail attachment directly rather than leaving a lazy, partially initialized runtime.
An Effect semaphore serializes mutations, caller interruption cancels queued or running coordinator operations through ordinary fiber interruption, and a scoped FiberSet interrupts and joins owned operations before lease release.
Owned-worker cancellation is a separate durable boundary: it records the cancellation request before dispatch, closes only the retained exact Workgraph-owned Herdr tab regardless of Worker status, and settles without a report only after exact agent and tab absence are verified. A failed or uncertain close response is never blindly retried: exact post-call absence may complete, while continued presence, ambiguous inspection, or foreign identity blocks with evidence. Only verified absence permits `workerClosed:true`; cancelled isolated output remains physically retained for explicit disposition, and graceful steering remains separate from termination.
One idempotent close boundary handles explicit shutdown and fatal lease loss; custom request queues, request settlement signals, and separate ready/start/fatal lifecycle channels are unnecessary because the Effect primitives already provide those guarantees.
The Effect-native process owner owns each child from acquisition through timeout, interruption, and release; host-facing boundaries are the only places that convert it to a Promise.
Each workstream owns one private `workstream.sqlite` database at its authoritative state path. Its validated version-3 Workstream state is one strict JSON aggregate row and its fenced lease is a sibling row; the aggregate has no redundant schema label, and every persisted timestamp is one valid UTC-millisecond instant. One SQLite transaction performs the read, validation, mutation, lease predicate, write, and commit. The coordinator session retains one authoritative pointer to that database and restores only a pointer whose repository, Workstream, and operation identity agree with the aggregate. Current coordinator identity is durable ownership, and compact transfer facts retain the prior-to-successor chain and Intent-count boundaries so direct human receipts remain bound to the coordinator that owned each Intent. Different-session adoption is one dedicated transaction that validates the exact aggregate revision, prior coordinator, exact observed expired prior lease or exact observed absence, and an identity-bound Herdr-dead observation before appending one transfer, changing the current coordinator, and installing the successor lease. Generic transitions cannot alter coordinator ownership or its history.

Lease expiry never establishes generation death. Same-session replacement is limited to a compatible process-local generation registered under the exact authoritative path, Workstream, coordinator, and cryptographically unique lease token. A stable versioned `globalThis` registry serializes path acquisition, publishes the runtime handle before reconciliation or other external work, and retains shared shutdown/quiescence evidence; it is ephemeral evidence rather than a persisted locator or authority source. Replacement actively closes and joins the prior runtime, then re-observes SQLite: absence permits ordinary acquisition, while the unchanged exact row requires proven quiescence and an expired full-row compare-and-swap. Missing, incompatible, changed, unexpired, or uncertain evidence fails closed. Successful controlled reload is therefore quiesce/release followed by ordinary fresh acquisition, while different-session adoption remains a separate Herdr-backed authority boundary.
These boundaries keep resource lifetime and persistence responsibility with the component that can verify their postconditions.

### Evolve one cohesive system

Prefer the smallest maintainable design with cohesive ownership boundaries. Coordination flow lives under `src/coordination/`, durable SQLite ownership under `src/storage/`, and cohesive Calm, Herdr, Git, process, settings, notepad, and Pi adapters remain flat. Delegated Pi session JSONLs remain separately retained under `<agentDir>/workgraph/worker-sessions/<workstreamId>/`; retiring operational Workstream state must not delete or relocate them.
Worker reports contain semantic results only. Git revision, changed-file, status, cleanliness, and commit evidence belong to the runtime and exact Attempt output boundaries rather than the Worker report.
When a design is superseded, simplify or delete the old path and its incidental machinery rather than preserving scars.
Do not create parallel interfaces, frameworks, or compatibility layers without a concrete current need.
Keep rationale, interface reference, runtime behavior, and verification guidance with their respective owners instead of duplicating them.
