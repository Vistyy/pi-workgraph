# Workgraph design

This document owns the integrated rationale and durable constraints for Workgraph's session-owned coordination design. Public operation belongs in [`README.md`](README.md), domain definitions in [`GLOSSARY.md`](GLOSSARY.md), verification boundaries in [`VERIFICATION.md`](VERIFICATION.md), and focused trade-offs in [`docs/adr/`](docs/adr/).

## Decision records

- [ADR 0001: Own record schemas, effects, and host adapters](docs/adr/0001-own-schemas-effects-and-host-adapters.md)
- [ADR 0002: Project Calm over the live Pi chat](docs/adr/0002-project-calm-over-the-live-pi-chat.md)

## Source ownership

Production source is grouped by cohesive feature ownership rather than generic technical layers. `src/coordinator/` owns coordinator-session orchestration, record persistence, Coordinator checkouts, model policy, pending memory, and native Worker placement. `src/worker/` owns Worker policy, execution trajectory, TODO state, and Pi session behavior. `src/calm/` owns the complete presentation feature and its Pi compatibility seam. Shared structural vocabulary lives in `src/domain/`; repository custody remains one cohesive `src/repository.ts` boundary; and the small shared Effect/Node bridge remains `src/node-platform.ts`. The two files in `extensions/` are thin Pi host entry points.

Tests are grouped by the supported responsibility they exercise rather than mechanically mirroring each source module. Shared test construction lives only under `test/support/`.

## Coordination ownership

The coordinator's exact Pi session is the unit of ownership. Its Tasks, Attempts, and Coordinator checkouts are private coordination records, not a shared project board. Other sessions cannot enumerate or take over those records. Session shutdown releases coordinator-owned runtime activity while preserving Coordinator checkouts, independent Worker sessions, native resources, and repository output.

Delegation is optional. The coordinator remains responsible for decisions, Candidate evaluation, final synthesis, and verification. Task contracts externalize enough settled context for a Worker to act without reconstructing consequential design. Reports provide evidence; they do not create authority or prove acceptance.

A Task is immutable and owns a contract plus one resolved target. An Attempt is one immutable execution specification for that Task: model selection, target-appropriate base, and optional Candidate lineage. It embeds one optional write-once Outcome. Only operational facts about its Worker and repository output are mutable. This split keeps semantic evidence stable while allowing exact recovery checkpoints to advance.

An Outcome records a reported, unreported, or cancelled semantic result and the effective model targets observed in the Worker session. It does not represent repository custody or authorize a Git operation. Effective models may be empty when execution never established one, and may differ from the frozen selection when Pi's actual session trajectory differs.

## Record store

All coordinator sessions share one private `<agentDir>/workgraph/workgraph.sqlite` file. Exact session identity partitions every supported query and mutation. The database has three strict tables:

- `tasks` stores immutable Task JSON under `(session_id, task_id)`;
- `attempts` stores immutable specification JSON and nullable Worker, output, and Outcome JSON, linked to its session's Task;
- `coordinator_checkouts` stores one live Coordinator-checkout record per `(session_id, repository common directory)`.

Creating a Task and its first Attempt is one SQLite transaction. Creating another Attempt first proves the Task in the same session. Recording an Outcome uses a write-once predicate. Coordinator-checkout transitions checkpoint exact placement or disposition facts before uncertain native effects and remove the live record only after exact resource absence is established. Each JSON column is decoded against its strict TypeBox record schema whenever a supported read uses it; SQL row shape and scalar types are checked at the same boundary.

The store has no aggregate mirror, global revision, cached frontier, cross-session lease, or process coordination state. It opens the one current schema and fails closed on an unknown schema version; it does not migrate an older format. Operational updates write only the owned record field, so unrelated Attempts and sessions need no reconstruction.

## Worker lifecycle and recovery

Every Attempt receives a fresh Worker Pi session under `<agentDir>/workgraph/worker-sessions/`. The Worker session file is its durable execution history; Herdr owns current workspace, tab, pane, and agent observations. The runtime serializes commands and reconciliation for one coordinator session with Effect primitives.

Launching establishes the exact clean workspace placement, persists the Worker session, creates the tab, starts the agent, persists the kickoff, then submits it. Placement must remain at the clean Attempt base until agent start is checkpointed as uncertain; afterward mutable worktree state no longer gates Worker reconciliation. Recovery observes exact persisted and native identity without replaying uncertain effects or guessing ownership.

Normal settlement derives a semantic Outcome from the Worker session independently of repository state and records it before checkpointing and issuing one exact close. It then observes exact absence before marking the Worker closed. A missing Worker that can no longer report becomes a bounded unreported Outcome rather than an endless wait.

Cancellation is definitive rather than graceful steering. A queued Attempt records a cancelled Outcome without creating a Worker. An active Attempt first checkpoints the cancellation reason, issues close at most once, proves exact absence, and then records the closed Worker and cancelled Outcome together. Recovery after either close checkpoint observes only; it never repeats close. Steering remains a separate prompt to an exact active Worker.

Coordinator shutdown interrupts and joins only owned coordination fibers and closes its store handle. It does not close independent Workers, remove session files or Coordinator checkouts, classify unfinished repositories, or delete retained or uncertain output.

## Coordinator checkout lifecycle

Read-only work creates no repository resource. Before direct repository mutation or implementation delegation, the model explicitly requests a Coordinator checkout from the intended destination. The destination must be a clean attached branch checkout. Workgraph records exact placement before creating a normal owned branch and worktree at the destination's exact `HEAD`; one session reuses its one live checkout for that repository, while another session receives independent resources.

The managed path is the session's mutable integration destination. The Coordinator edits and verifies there, and repository implementation Tasks target it so detached Worker Candidates apply there through the existing Candidate flow. Workgraph does not intercept edits or shell commands, redirect paths, inject checkout state into prompts, cache checkout records, or reconcile them in a background loop. Every checkout operation reads its session-partitioned record and validates the referenced Git identity before acting.

Local application requires committed clean source state on the exact owned branch. It permits the recorded destination branch to advance from the checkout base, preserves an already-contained destination without creating a commit, proves any required fast-forward or merge, checkpoints preparation before mutation, and then removes only the exact managed worktree and branch after the destination result is established. Explicit discard checkpoints the exact source before destructive disposition. Both dispositions prove the exact live worktree before recording its removal request, confirm established absence after the native effect, then delete the branch and remove the live record last. Missing, moved, one-sided, foreign, or mismatched resources block without repair, replacement, or cleanup. Routine shutdown preserves the checkout exactly.

The Coordinator may instead publish the managed branch with ordinary Git and `gh`. Publication, pull-request state, remote safety, and post-publication cleanup remain outside Workgraph.

## Worker Pi trajectory

Worker behavior is enforced through the real Pi session, role policy, tool gates, and one terminal report. Research, consultation, and review are read-only. Repository experiments may make only their explicitly permitted changes. Implementation uses one same-session Prewalk trajectory from guide to executor.

The guide receives the immutable assignment and a strict 1–9 item TODO tool. TODO status is navigation, not evidence or an acceptance gate. Executor cutover becomes eligible only after both a valid initialized TODO and a successful direct edit or write, in either order. Shell commands, observations, and failed mutations do not qualify. The selected executor target and thinking level are recorded in one exact session marker; the next provider request replaces guide policy with executor policy while preserving the assignment and session history. Selection failure remains guide-owned, blocks further direct mutation, is not retried automatically, and still permits a truthful failure or escalation report. A changed implementation result requires an executor assistant message after cutover.

Reports contain semantic result, concrete evidence, findings, and uncertainty. Git revisions, changed-file observations, cleanliness, and ownership remain runtime facts rather than Worker assertions. Compaction recovery restores assignment context and current TODO from the Worker session's real branch entries without maintaining a second phase record.

## Models

The user-owned model policy is the only source of executable model IDs and thinking levels. Research, review, and consultation have ordered nonempty target lists; implementation freezes one guide and one default or explicitly requested escalation executor into each Attempt. Invalid policy or selection fails before record creation.

Actual effective models are derived from persisted Pi model events in trajectory order and written with the Outcome. Frozen selection explains what was requested; effective models explain what ran. Neither is inferred from report prose.

## Targets and Candidate lineage

A Task resolves either an exact directory path or a repository identity consisting of checkout root and Git common directory. Every Attempt inherits that immutable target. The coordinator's current directory is only a resolution input, never later placement authority. Repository implementation Tasks resolve the Coordinator checkout passed as `cwd`, so their Candidates return to that attached branch rather than the original destination. This permits Tasks in several repositories within one session without distributed transactions, dependencies, rollback, or all-or-nothing application claims.

Repository Attempt bases are exact commits. A root Candidate is rooted at its Attempt's explicit base. `candidateOf: extend` starts the successor Attempt from the exact retained source Candidate tip, preserves its root, and prevents source discard until successor placement. `candidateOf: integrate` starts from a separately explicit base and records both the exact source Candidate-producing Attempt and source tip to incorporate. Candidate lineage is immutable and checked against exact retained refs; session continuation is not content ancestry.

Directory Attempts have no Git output. Repository Attempts execute in detached worktrees at `<agentDir>/workgraph/worktrees/<attemptId>` and never borrow the destination checkout as execution state.

## Repository custody

After exact Worker closure, a completed report retains only committed HEAD and removes the worktree; unchanged HEAD produces no output. Non-completed Attempts preserve dirty worktrees. Complete absence recovers compacted output; external deletion or pruning of Workgraph-managed resources is unsupported. One-sided, moved, foreign, unrelated, or otherwise ambiguous resources block.

Repository custody is serialized within one coordinator session, not across sessions or processes. Concurrent mutation of the same destination checkout is unsupported. Application proves the private source ref, Candidate lineage, destination identity and state, ancestry, and tree mergeability before its checkpointed fast-forward. The merge preserves unrelated ignored artifacts and refuses to overwrite an ignored destination path. Recovery accepts only the exact expected Git structure; changed destination state blocks without rollback or automatic retry. Output cleanup occurs only after application is recorded.

Discard is explicitly destructive and requires a reason. It checkpoints the exact retained tip and disposition before deleting only the verified private ref or owned worktree. An unplaced extension child and an unclassified integration child pin their source output. Interruption recovery accepts only proven postconditions and never removes foreign or uncertain resources. Semantic Outcomes and routine shutdown cannot discard output.

Applying a Candidate or Coordinator checkout changes a local repository only. Workgraph never pushes or publishes; a Coordinator may use ordinary Git and `gh` from its managed branch as a separate deliberate action.

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
