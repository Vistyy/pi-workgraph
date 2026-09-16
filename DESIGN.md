# Workgraph design

This document owns the integrated rationale and durable constraints for Workgraph's session-owned coordination design. Public operation belongs in [`README.md`](README.md), domain definitions in [`GLOSSARY.md`](GLOSSARY.md), verification boundaries in [`VERIFICATION.md`](VERIFICATION.md), and focused trade-offs in [`docs/adr/`](docs/adr/).

## Decision records

- [ADR 0001: Own record schemas, effects, and host adapters](docs/adr/0001-own-schemas-effects-and-host-adapters.md)
- [ADR 0002: Project Calm over the live Pi chat](docs/adr/0002-project-calm-over-the-live-pi-chat.md)
- [ADR 0003: Keep Prewalk in one live Worker trajectory](docs/adr/0003-keep-prewalk-in-one-live-worker-trajectory.md)

## Source ownership

Files follow cohesive feature ownership rather than generic technical layers:

```text
extensions/                 # thin Pi host entry points
src/
├── coordinator/            # session orchestration, records, models, checkouts, Worker placement
├── worker/                 # Worker policy, execution trajectory, TODO state, Pi session behavior
├── calm/                   # complete presentation feature and Pi compatibility seam
├── domain/                 # shared structural vocabulary
├── repository.ts           # all Git custody
└── node-platform.ts        # small shared Effect/Node bridge
references/
└── publish-pr.md           # post-choice PR publication procedure

test/
└── support/                # shared test construction only
```

Tests are grouped by the supported responsibility they exercise rather than mechanically mirroring source modules.

## Coordination ownership

The coordinator's exact Pi session is the unit of ownership. Its Tasks and Attempts are private coordination records, not a shared project board. Its session identity also contributes to deterministic Coordinator checkout placement, so another session receives different Git resources for the same repository. Other sessions cannot enumerate or take over its records. Session shutdown releases coordinator-owned runtime activity while preserving Coordinator checkouts, independent Worker sessions, native resources, and repository output.

Delegation is optional. The coordinator remains responsible for decisions, Candidate evaluation, final synthesis, and verification. Task contracts are decision-complete and method-light: they externalize the desired contribution, settled context, references, scope, constraints, known options, and evidence expectations at enough fidelity that a Worker need not reconstruct consequential decisions, while leaving local method and conclusions to the Worker. Optional context never expands role authority. Reports provide evidence; they do not create authority, approval, or acceptance.

A Task is immutable and owns a contract plus one resolved target. An Attempt is one immutable execution specification for that Task: model selection, target-appropriate base, and optional Candidate lineage. It embeds one optional write-once Outcome. Only operational facts about its Worker and repository output are mutable. This split keeps semantic evidence stable while allowing exact recovery checkpoints to advance.

An Outcome records a reported, unreported, or cancelled semantic result and the effective model targets observed in the Worker session. It does not represent repository custody or authorize a Git operation. Effective models may be empty when execution never established one, and may differ from the frozen selection when Pi's actual session trajectory differs.

Research and Experiment are separate Task contracts. Research is read-only and keeps a question with optional context and expected evidence. Consultation keeps a question and optional context; its advisor remains policy-selected and frozen in the Attempt. Review is a read-only natural-language request with optional context and may assess any relevant accessible material without typed subjects, source-Outcome gates, revision pins, snapshots, or provenance and reproducibility promises.

Experiment keeps a question, optional context and expected evidence, nonblank permitted effects, and a hard stop cutoff in a repository worktree. Each Attempt independently receives authority defining effect kind, scope, and lifetime. An operation may begin only when its complete effectful lifetime, including authorized cancellation or teardown, fits the cutoff. Workgraph claims no automatic deadline enforcement, rollback, or post-cutoff cleanup exception. Experiment commits may remain as retained repository output for inspection or discard but never become applicable Candidates; uncommitted worktree bytes are scratch.

## Record store

All coordinator sessions share one private `<agentDir>/workgraph/workgraph.sqlite` file. Exact session identity partitions every supported query and mutation. The database stores two strict session record types:

- `tasks` stores immutable Task JSON under `(session_id, task_id)`;
- `attempts` stores immutable specification JSON and nullable Worker, output, and Outcome JSON, linked to its session's Task.

Creating a Task and its first Attempt is one SQLite transaction. Creating another Attempt first proves the Task in the same session. Recording an Outcome uses a write-once predicate. Each JSON column is decoded against its strict TypeBox record schema whenever a supported read uses it; SQL row shape and scalar types are checked at the same boundary.

The store has no Coordinator checkout records, aggregate mirror, global revision, cached frontier, cross-session lease, or process coordination state. It opens schema version 1 and fails closed on an unknown version; it does not migrate another format. Operational updates write only the owned record field, so unrelated Attempts and sessions need no reconstruction.

## Worker lifecycle and recovery

Every Attempt receives a fresh Worker Pi session under `<agentDir>/workgraph/worker-sessions/`. The Worker session file is its durable execution history; Herdr owns current workspace, tab, pane, and agent observations. The runtime serializes commands and reconciliation for one coordinator session with Effect primitives.

Launching establishes the exact clean workspace placement, persists the Worker session, creates the tab, starts the agent, persists the kickoff, then submits it. Placement must remain at the clean Attempt base until agent start is checkpointed as uncertain; afterward mutable worktree state no longer gates Worker reconciliation. Recovery observes exact persisted and native identity without replaying uncertain effects or guessing ownership.

Normal settlement derives a semantic Outcome from the Worker session independently of repository state and records it before checkpointing and issuing one exact close. It then observes exact absence before marking the Worker closed. A missing Worker that can no longer report becomes a bounded unreported Outcome rather than an endless wait.

Cancellation is definitive rather than graceful steering. A queued Attempt records a cancelled Outcome without creating a Worker. An active Attempt first checkpoints the cancellation reason, issues close at most once, proves exact absence, and then records the closed Worker and cancelled Outcome together. Recovery after either close checkpoint observes only; it never repeats close. Steering remains a separate prompt to an exact active Worker.

Coordinator shutdown interrupts and joins only owned coordination fibers and closes its store handle. It does not close independent Workers, remove session files or Coordinator checkouts, classify unfinished repositories, or delete retained or uncertain output.

## Coordinator checkout allocation

Read-only work creates no repository resource. Before direct repository mutation or implementation delegation, the model explicitly requests a Coordinator checkout from the intended repository. Creation accepts an attached or detached source worktree with a committed `HEAD`; tracked, untracked, and ignored source changes are neither copied nor mutated. The exact source commit seeds a new linked worktree and normal branch.

A collision-resistant identity derived from the exact Pi session and canonical Git common directory determines one private path and branch. Complete resource absence permits creation. Complete exact identity permits reuse, including when the managed branch or working tree has changed. Reuse proves the real path, repository common directory, one direct owned branch, one matching unlocked worktree registration, attached `HEAD`, and bidirectional worktree backlinks. Partial, duplicated, locked, symlinked, foreign, or unreadable state blocks without retry, repair, pruning, reset, deletion, or alternate placement. A failed native creation response is accepted only when immediate observation proves the exact requested commit and identity; an interrupted initialization remains locked and blocked.

The managed path is the session's mutable integration destination. The Coordinator edits, commits, and verifies there, and repository implementation Tasks target it so detached Worker Candidates apply there through the existing Candidate flow. Workgraph does not intercept or redirect file operations, inject checkout state into prompts, persist checkout state, or reconcile resources in a background loop.

Final local integration and publication use normal repository or forge tooling rather than Workgraph repository operations. After accepting a change, the Coordinator classifies human-review need and recommends a delivery route, but stops for the user's choice unless that route was already explicit. Pull-request choice triggers the packaged publication reference; the reference guides one-time push and pull-request creation or update without discovery outside that contract, Workgraph publication state, merge authority, or monitoring. Cleanup waits until no Worker, pending Candidate decision, or delivery choice depends on the checkout and uses ordinary non-force Git operations; refusal or uncertainty preserves remaining resources for explicit reporting. Complete later absence permits deterministic creation at the same path, while routine shutdown preserves the checkout.

## Worker Pi trajectory

Worker behavior is enforced through the real Pi session, role policy, tool gates, and one terminal report. Research, consultation, and review are read-only. Repository experiments may make only their explicitly permitted changes. Implementation uses one same-session Prewalk trajectory from guide to executor.

The guide receives the immutable assignment and initializes one strict 1–9 item TODO without caller-supplied statuses. The runtime marks the first item `in_progress` and the rest `pending`; subsequent progress uses focused item updates. Items name meaningful implementation or verification work with explicit validation, not reporting, bookkeeping, or padding. TODO status is navigation, not evidence or an acceptance gate.

Executor cutover becomes eligible only after both a valid initialized TODO and a successful direct edit or write, in either order. Shell commands, observations, and failed mutations do not qualify. The selected executor target and thinking level are recorded in one exact session marker; the next provider request replaces guide policy with executor policy while preserving the assignment and session history. Selection failure remains guide-owned, blocks further direct mutation, is not retried automatically, and still permits a truthful `failed` or `needs_decision` report. A changed implementation result requires an executor assistant message after cutover. If the executor settles without a report while `pending` or `in_progress` items remain, at most two follow-up reminders ask it to continue useful work or report truthfully.

An Implementation Worker's fixed assigned worktree is its mutable execution root. Assignment repository paths map into that worktree; changing shell cwd does not expand authority. The Worker may inspect elsewhere and may change the Git state needed to commit its worktree, but it may not modify another checkout or publish. A request that inherently requires another mutation is reported as a conflict. This is a behavioral custody contract, not sandbox enforcement, and does not replace repository validation.

Workers submit strict nonblank status, summary, and narrative details. Status is `completed`, `needs_decision`, or `failed`; completed Implementation reports additionally state `changed` or `no_change`. The runtime injects the immutable exact Worker role into the persisted self-describing report, and the store validates all five roles against their Task. Narrative details carry role-appropriate result, evidence, tradeoffs or findings, actual effects, verification, and uncertainty. `completed` is a truthful bounded terminal result rather than approval; `needs_decision` is terminal for a missing consequential Coordinator decision or additional authority; `failed` is an operational or contract inability. Git revisions, changed-file observations, cleanliness, and ownership remain runtime facts rather than Worker assertions. Compaction recovery restores assignment context and current TODO from the Worker session's real branch entries without maintaining a second phase record. [ADR 0003](docs/adr/0003-keep-prewalk-in-one-live-worker-trajectory.md) owns the retained Prewalk trade-off.

## Models

The user-owned model policy is the only source of executable model IDs and thinking levels. Research and review have ordered nonempty target lists; Experiment shares the research list. Consultation has one advisor target. Implementation freezes one guide and one default or explicitly requested escalation executor into each Attempt. Tool calls never name a concrete model. Invalid policy or selection fails before record creation, and frozen Attempts remain inspectable without loading current policy.

Actual effective models are derived from persisted Pi model events in trajectory order and written with the Outcome. Frozen selection explains what was requested; effective models explain what ran. Neither is inferred from report prose.

## Targets and Candidate lineage

A Task resolves either an exact directory path or a repository identity consisting of checkout root and Git common directory. Every Attempt inherits that immutable target. The coordinator's current directory is only a resolution input, never later placement authority. For read-only roles, resolved cwd is Worker placement and starting context—not evidence scope, semantic subject, provenance, or authority. For Experiment, cwd is the owned detached worktree seeded from the resolved repository's committed base and does not authorize source-checkout mutation. Repository implementation Tasks resolve the Coordinator checkout passed as `cwd`, so their Candidates return to that attached branch rather than the original destination. This permits Tasks in several repositories within one session without distributed transactions, dependencies, rollback, or all-or-nothing application claims.

Repository Attempt bases are exact commits. A root Candidate is rooted at its Attempt's explicit base. `candidateOf: extend` starts the successor Attempt from the exact retained source Candidate tip, preserves its root, and prevents source discard until successor placement. `candidateOf: integrate` starts from a separately explicit base and records both the exact source Candidate-producing Attempt and source tip to incorporate. Candidate lineage is immutable and checked against exact retained refs; session continuation is not content ancestry.

Directory Attempts have no Git output. Repository Attempts execute in detached worktrees at `<agentDir>/workgraph/worktrees/<attemptId>` and never borrow the destination checkout as execution state.

## Repository custody

`src/repository.ts` is the single Git custody owner for both Worker Candidates and Coordinator checkout allocation. They share target revalidation, Git process ownership, and worktree registration parsing; each resource adds only the identity checks its supported lifecycle requires. `src/coordinator/checkouts.ts` owns deterministic checkout identity and the thin Pi Promise boundary.

After exact Worker closure, a completed report retains only committed HEAD and removes the worktree; unchanged HEAD produces no output. Noncompleted Attempts preserve dirty worktrees, while clean placement may compact under the existing classification rules. Complete absence recovers compacted output; external deletion or pruning of Workgraph-managed resources is unsupported. One-sided, moved, foreign, unrelated, or otherwise ambiguous resources block.

Repository custody is serialized within one coordinator session, not across sessions or processes. Concurrent mutation of the same destination checkout is unsupported. Application proves the private source ref, Candidate lineage, destination identity and state, ancestry, and tree mergeability before its checkpointed fast-forward. The merge preserves unrelated ignored artifacts and refuses to overwrite an ignored destination path. Recovery accepts only the exact expected Git structure; changed destination state blocks without rollback or automatic retry. Output cleanup occurs only after application is recorded.

Discard is explicitly destructive and requires a reason. It checkpoints the exact retained tip and disposition before deleting only the verified private ref or owned worktree. An unplaced extension child and an unclassified integration child pin their source output. Interruption recovery accepts only proven postconditions and never removes foreign or uncertain resources. Semantic Outcomes and routine shutdown cannot discard output.

Applying a Candidate changes its recorded local destination only. Workgraph repository operations never publish or finally integrate a Coordinator checkout; after the deliberate delivery choice, the Coordinator uses external repository or forge tooling from its managed branch.

Coordinator mutation tools return persisted post-operation Attempt facts rather than a generic success flag, and exact Attempt inspection combines durable semantic and repository state with any current runtime blocker. Operations that may have partially persisted state do not roll back or create an operation ledger; failures identify the affected record for inspection before retry.

## Calm and pending memory

Calm is a coordinator-only projection over the running Pi instance's live chat. On each render it classifies the current source children, reuses native pass-through rows, and builds filtered assistant and skill components from WeakMap caches. It hides exact model tool-execution instances and `pi-workgraph-outcome` rows, filters thinking and tool-call parts, retains terminal notices, inserts separators between adjacent projected assistant answers, and routes mouse interaction through projected layout. Native chat state remains Pi-owned. The adapter fails back to native rendering as one unit when its validated seams become incompatible. [ADR 0002](docs/adr/0002-project-calm-over-the-live-pi-chat.md) owns the internal seam trade-offs.

The notepad is a bounded latest-snapshot entry on the current Pi branch. It provides only read, replace, and clear, and is injected after genuine compaction when nonempty. It is pending-memory rather than Task state, authority, evidence, or acceptance.

## Effect and host boundaries

Effect owns serialized application flow, interruption, scoped acquisition and release, fibers, queues, semaphores, filesystem services, and typed operational failures. Promise conversion occurs only at Pi host callbacks. Direct Node and native adapters are narrow boundaries for SQLite, no-follow private-file ownership, cryptographic identity, Git child processes, Pi session files, and Herdr requests whose guarantees are not more simply provided by Effect. TypeBox owns strict external and persisted record shapes. [ADR 0001](docs/adr/0001-own-schemas-effects-and-host-adapters.md) owns the dependency and boundary trade-offs.

## Supported limits

- One coordinator process may operate a given Pi session at a time.
- Concurrent mutation of a destination checkout or ref by another session, process, or user during application is unsupported and causes a blocked result when detected.
- Multi-repository Tasks have independent effects; Workgraph provides no cross-repository transaction or rollback.
- Worktrees and tool gates are ownership boundaries, not security sandboxes.
- SQLite process safety does not claim durability across power loss.
- Native behavior depends on the observed Pi, Herdr, Git, operating system, provider, and model versions; uncertainty is preserved when exact identity or postconditions cannot be established.
- Calm depends on guarded Pi presentation internals and deliberately falls back to the native transcript when those seams change.
