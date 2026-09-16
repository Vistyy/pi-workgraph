# Workgraph design

This document owns Workgraph's integrated architecture and durable constraints.

| Subject | Owner |
| --- | --- |
| Installation and public operation | [`README.md`](README.md) |
| Domain language | [`GLOSSARY.md`](GLOSSARY.md) |
| Verification boundaries | [`VERIFICATION.md`](VERIFICATION.md) |
| Focused trade-offs | [`docs/adr/`](docs/adr/) |

## Decision records

- [ADR 0001: Own record schemas, effects, and host adapters](docs/adr/0001-own-schemas-effects-and-host-adapters.md)
- [ADR 0002: Project Calm over the live Pi chat](docs/adr/0002-project-calm-over-the-live-pi-chat.md)
- [ADR 0003: Keep Prewalk in one live Worker trajectory](docs/adr/0003-keep-prewalk-in-one-live-worker-trajectory.md)

## Source ownership

```text
extensions/                 # thin Pi host entry points
src/
├── coordinator/            # records, models, checkouts, orchestration, Worker placement
├── worker/                 # policy, execution trajectory, TODO state, Pi session behavior
├── calm/                   # presentation feature and guarded Pi compatibility seam
├── domain/                 # shared structural vocabulary
├── repository.ts           # Git custody
└── node-platform.ts        # shared Effect/Node bridge
references/
└── delivery.md             # post-choice delivery procedures

test/
└── support/                # shared test construction
```

Tests are grouped by supported responsibility rather than by individual source module.

## Coordination model

The exact Coordinator Pi session is the unit of ownership.

```text
Coordinator session
├── Coordinator checkout per repository
├── Task
│   ├── Attempt → Outcome
│   └── Attempt → Outcome + retained Candidate
└── Task
    └── Attempt → Outcome
```

Another session cannot enumerate or take over these records. Session identity also contributes to deterministic Coordinator checkout placement, so separate sessions receive separate Git resources for the same repository.

Delegation is optional. The Coordinator remains responsible for:

- consequential decisions;
- Candidate evaluation;
- final synthesis;
- verification; and
- the delivery choice.

Worker reports provide evidence. They do not create authority, approval, or acceptance.

### Stable and mutable state

| Record | Stable state | Mutable operational state |
| --- | --- | --- |
| Task | Contract and resolved Target | None |
| Attempt | Task, model selection, repository base when applicable, optional Candidate lineage | Worker, repository output, write-once Outcome |
| Outcome | Reported, unreported, or cancelled result; observed effective models | None after insertion |

Effective models may be absent when execution never established one. They may differ from the frozen selection when Pi's actual session trajectory differs.

### Task roles

| Role | Authority and result |
| --- | --- |
| Research | Read-only evidence gathering. |
| Consultation | Read-only advice from the policy-selected advisor. |
| Review | Read-only assessment of relevant accessible material; exact revision only when the request requires it. |
| Experiment | Explicit effect kind, scope, lifetime, and hard cutoff in a detached repository worktree. Output is inspectable but never an applicable Candidate. |
| Implementation | Repository change that may produce a Candidate. |

A read-only Task's `cwd` is placement and starting context—not evidence scope, subject, provenance, or authority.

Experiment authority is granted independently to every Attempt. The complete effect lifetime, including authorized teardown, must fit the cutoff.

Workgraph provides no automatic deadline enforcement, rollback, or post-cutoff cleanup exception.

## Record store

All Coordinator sessions share one private database:

```text
<agentDir>/workgraph/workgraph.sqlite
```

Exact session identity partitions every supported query and mutation.

| Table | Content |
| --- | --- |
| `tasks` | Immutable Task JSON under `(session_id, task_id)` |
| `attempts` | Immutable Attempt specification plus nullable Worker, output, and Outcome JSON |

The store guarantees:

- Task creation and its first Attempt are one transaction;
- another Attempt can reference only a Task from the same session;
- Outcome insertion is write-once;
- every JSON field is decoded with its strict TypeBox schema when a supported read uses it; and
- SQL row shape and scalar types are checked at that boundary.

The store has no aggregate mirror, global revision, cached frontier, cross-session lease, or process-coordination state. Coordinator checkouts have no database record.

Schema version 1 fails closed on an unknown version. Workgraph does not migrate another format. Operational updates replace only their owned field, so unrelated records require no reconstruction.

## Worker lifecycle

Every Attempt receives a fresh Pi session under:

```text
<agentDir>/workgraph/worker-sessions/
```

The session file is durable execution history. Herdr owns live workspace, tab, pane, and agent observations. Effect serializes command handling and reconciliation for one Coordinator session.

### Launch order

```text
place clean workspace
  → persist Worker session
  → create tab
  → start agent
  → persist kickoff
  → submit kickoff
```

Before agent start becomes uncertain, placement must remain at the exact clean Attempt base. After that checkpoint, execution dirtiness no longer blocks reconciliation.

Recovery observes persisted and native identity. It does not replay a possibly completed effect or guess ownership.

### Settlement and cancellation

Normal settlement derives its semantic Outcome independently of repository state, then follows this order:

1. Derive the semantic Outcome from the Worker session.
2. Record the Outcome.
3. Checkpoint and issue one exact close.
4. Observe exact absence.
5. Mark the Worker closed.

A missing Worker that can no longer report becomes a bounded unreported Outcome.

Cancellation differs by state:

| Worker state | Cancellation behavior |
| --- | --- |
| Queued | Record a cancelled Outcome without launching. |
| Active | Checkpoint the reason, close at most once, prove absence, then record closed Worker state and cancelled Outcome together. |

After a close checkpoint, recovery only observes; it never repeats close. Steering remains a separate prompt to an exact active Worker.

Coordinator shutdown interrupts and joins only owned coordination fibers and closes its database handle. It does not close Workers, remove sessions or checkouts, classify unfinished repositories, or delete retained or uncertain output.

## Coordinator checkout lifecycle

Read-only work creates no repository resource. The model must explicitly request a checkout before direct repository mutation or implementation delegation.

Creation snapshots the source checkout's committed `HEAD`. Tracked, untracked, and ignored source changes are neither copied nor changed.

A collision-resistant identity derived from exact Pi session and canonical Git common directory determines one private path and branch.

| Observed resource state | Result |
| --- | --- |
| Complete absence | Create a linked worktree and normal branch at the requested commit. |
| Complete exact identity | Reuse it, including modified or advanced managed content. |
| Partial, duplicate, locked, symlinked, foreign, moved, or unreadable state | Block without repair, reset, pruning, deletion, retry, or alternate placement. |

Exact reuse proves:

- real path and Git common directory;
- one direct owned branch;
- one matching unlocked worktree registration;
- attached `HEAD`; and
- both worktree backlinks.

A failed native creation response counts as success only when immediate observation proves the complete requested identity at the exact commit. An interrupted initialization remains locked and blocked.

Complete later absence permits deterministic creation at the same path. Routine shutdown preserves the checkout.

The managed checkout is the Coordinator's mutable integration destination.

Workgraph does not intercept file operations, redirect paths, inject checkout state into prompts, persist checkout records, or reconcile checkouts in a background loop.

### Delivery boundary

Final local integration and publication use ordinary repository, forge, or session capabilities. The Coordinator contract owns route selection and authority; the packaged reference owns the selected pull-request procedure.

For a pull-request route, the reference guides initial publication, exact-result verification, and establishment of continued observation when a capability is available.

Delivered observations return the Coordinator to the same work under its existing authority.

Workgraph owns no publication or observation state, merge authority, independent state checking, or observation-availability reporting.

Cleanup waits until no Worker, Candidate decision, or delivery choice depends on the checkout. It uses ordinary non-force Git operations and preserves resources after refusal or uncertainty.

## Implementation trajectory

Implementation uses the Prewalk design: one live Worker trajectory moves from guide to executor without a summary handoff.

Worker behavior is enforced through the real Pi session, role policy, tool gates, and one terminal report. Research, Consultation, and Review are read-only. Experiment effects remain limited to their assignment.

Implementation uses one Worker trajectory with two policy phases:

```text
Guide
  ├── inspect assignment
  ├── initialize TODO
  └── make first useful edit/write
       ↓ both conditions satisfied
Executor
  ├── continue same history and assignment
  ├── maintain TODO as navigation
  ├── complete and verify
  └── report
```

### Guide and cutover

The guide initializes one concise TODO with 1–9 meaningful implementation or verification items. The runtime marks the first item `in_progress` and the rest `pending`.

Cutover requires both:

- a valid initialized TODO; and
- one successful direct edit or write.

Shell commands, observations, dirtiness, and failed mutations do not qualify.

On cutover, Workgraph records the selected executor and replaces guide policy on the next provider request. It preserves the assignment, messages, tool results, TODO, and first edit.

Selection failure remains guide-owned, blocks further direct mutation, is not retried automatically, and still permits a truthful `failed` or `needs_decision` report.

### Executor and report

TODO status is navigation, not evidence or a completion gate. If the executor settles without a report while actionable items remain, Workgraph sends at most two reminders to continue useful work or report truthfully.

A changed completion requires an executor assistant message after cutover. Genuine context compaction restores the immutable assignment and current TODO from session history.

Reports contain strict nonblank status, summary, and narrative details. The runtime injects the immutable role and validates it against the Task.

| Status | Meaning |
| --- | --- |
| `completed` | Truthful bounded result, not approval. |
| `needs_decision` | Missing consequential Coordinator decision or authority. |
| `failed` | Operational or contractual inability. |

Completed Implementation reports also state `changed` or `no_change`. Git revisions, cleanliness, and custody remain runtime facts rather than Worker assertions.

An Implementation Worker's fixed worktree is its only mutable execution root. Repository paths in the assignment map there.

The Worker may inspect elsewhere and modify Git state needed to commit its own worktree. It may not change another checkout or publish. A request that inherently requires another mutation is reported as a conflict.

[ADR 0003](docs/adr/0003-keep-prewalk-in-one-live-worker-trajectory.md) owns the retained one-trajectory trade-off.

## Models

The user-owned model policy is the only executable source of model IDs and thinking levels.

| Role | Policy shape |
| --- | --- |
| Research and Review | Ordered nonempty target lists |
| Experiment | Research target list |
| Consultation | One advisor |
| Implementation | One guide and one default or explicitly requested escalation executor |

Tool calls never name a model. Invalid policy or selection fails before record creation. Frozen Attempts remain inspectable without loading current policy.

The Outcome derives effective models from persisted Pi model events in trajectory order. It never infers them from requested policy or report prose.

## Targets and Candidate lineage

A Task resolves either:

- one exact directory path; or
- a repository identity containing checkout root and Git common directory.

Every Attempt inherits that Target. The Coordinator's current directory is only a resolution input.

Repository Attempts freeze an exact base commit and execute in detached worktrees under:

```text
<agentDir>/workgraph/worktrees/<attemptId>
```

Directory Attempts have no Git output.

Candidate lineage supports two explicit relationships:

| Mode | Starting point | Preserved relationship |
| --- | --- | --- |
| `extend` | Exact retained source Candidate tip | Preserve the Candidate root; pin source until successor placement. |
| `integrate` | A separately explicit base | Record the source-producing Attempt and exact source tip to incorporate. |

A root Candidate is rooted at its Attempt's explicit base. Lineage is immutable and checked against retained refs. Session continuation is not content ancestry.

Repository implementation Tasks target the Coordinator checkout passed as `cwd`. Their Candidates therefore return to that managed destination rather than the original source checkout.

## Repository custody

`src/repository.ts` owns shared Git custody for Worker output and Coordinator checkout allocation. `src/coordinator/checkouts.ts` owns deterministic checkout identity and the thin Pi Promise boundary.

The two paths share target revalidation, Git process ownership, and worktree-registration parsing while keeping each resource's identity checks separate.

### Classifying output

After exact Worker closure:

| Outcome and Git state | Custody result |
| --- | --- |
| Completed, unchanged `HEAD` | No output; remove worktree. |
| Completed, changed committed `HEAD` | Retain private ref; remove worktree. |
| Noncompleted, dirty worktree | Preserve it. |
| Clean compactable placement | Compact under current classification rules. |
| Missing, moved, foreign, partial, or ambiguous resource | Preserve or block; never guess. |

A completed report relinquishes ignored, untracked, and uncommitted scratch. External deletion or pruning of managed resources is unsupported.

### Applying a Candidate

Application is serialized within one Coordinator session. Concurrent destination mutation by another session or process is unsupported.

Before the checkpointed fast-forward, Workgraph proves:

- private source ref and exact Candidate lineage;
- destination identity and state;
- ancestry and tree mergeability; and
- that no Candidate path would overwrite an ignored destination artifact.

Unrelated ignored artifacts remain intact. Recovery accepts only the exact expected Git structure. A changed destination blocks without rollback or automatic retry. Output is released only after application is recorded.

### Discarding output

Discard is explicit and requires a reason. Workgraph checkpoints the exact retained tip and disposition before deleting only the verified private ref or owned worktree.

An unplaced extension child or unclassified integration child pins its source. Recovery accepts only proven postconditions and never removes foreign or uncertain resources. Outcomes and shutdown cannot discard output.

Applying a Candidate changes only its recorded local destination. Workgraph never publishes or finally integrates a Coordinator checkout.

Mutation tools return persisted Attempt facts, not a generic success flag. Exact Attempt inspection combines semantic and repository state with any runtime blocker.

After a failure that may follow a durable checkpoint, callers inspect the affected record before retrying.

## Calm and pending memory

Calm is a Coordinator-only projection over Pi's live chat. It:

- classifies the current source children on every render;
- hides exact model tool-execution and `pi-workgraph-outcome` rows;
- removes thinking and tool-call parts from projected assistant messages;
- preserves prose, terminal notices, and unknown rows;
- reuses native pass-through components;
- inserts separators only between adjacent projected assistant answers; and
- routes mouse input through projected geometry.

Pi retains the native chat state. If discovery, classification, rendering, invalidation, or mouse handling becomes incompatible, Calm restores native presentation as one unit.

[ADR 0002](docs/adr/0002-project-calm-over-the-live-pi-chat.md) owns this seam trade-off.

The notepad is a bounded latest-snapshot entry on the current Pi branch. It supports read, replace, and clear, and restores a nonempty memo after genuine compaction. It is not Task state, evidence, authority, or acceptance.

## Effect and host boundaries

Effect owns:

- serialized application flow;
- interruption and resource finalization;
- fibers, queues, and semaphores;
- filesystem services; and
- typed operational failures.

Promise conversion occurs only at Pi host callbacks.

Direct native adapters remain narrow owners for SQLite, no-follow private-file checks, cryptographic identity, Git child processes, Pi session files, and Herdr requests. TypeBox owns strict external and persisted record shapes.

[ADR 0001](docs/adr/0001-own-schemas-effects-and-host-adapters.md) owns the dependency and boundary rationale.

## Supported limits

- One Coordinator process may operate a Pi session at a time.
- Concurrent mutation of a destination checkout or ref is unsupported and blocks when detected.
- Multi-repository effects have no shared transaction or rollback.
- Worktrees and tool gates are ownership boundaries, not security sandboxes.
- SQLite process safety does not establish power-loss durability.
- Native behavior depends on the observed Pi, Herdr, Git, operating system, provider, and model versions.
- Calm deliberately falls back to native presentation when its guarded Pi seams change.
