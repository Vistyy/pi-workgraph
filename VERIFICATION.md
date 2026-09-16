# Workgraph verification boundaries

This document owns project-specific evidence requirements. Begin with the supported promise and use the smallest real boundary that distinguishes correct behavior from consequential failure. A component check establishes only its local contract; it does not establish that the registered extension, real Pi session, installed Calm adapter, or packaged consumer works.

## Session records

Exercise the native SQLite store through separate exact-session instances. Establish that:

- `tasks` and `attempts` are strict tables with their required relationships;
- Task plus first Attempt creation is atomic;
- failed creation leaves neither half-record;
- another Attempt can reference only a Task in the same session;
- identical Task IDs in separate sessions remain isolated;
- Task and Attempt specifications cannot be replaced;
- Outcome insertion is write-once; and
- each persisted JSON field and SQL scalar used by a supported read is strictly decoded at that use.

Use actual rows and transaction failure, not only TypeBox value checks. A decoder test should mutate the one field whose supported-read rejection is being established, then remove the disposable database. Do not build a durable corruption matrix: arbitrary external database tampering is not a supported recovery interface.

Do not add migration, aggregate-reconstruction, cross-session-discovery, lease, or concurrent same-session process fixtures unless those become supported responsibilities. The current schema is version 1 and must fail closed on unknown existing versions.

## Worker lifecycle

Drive orchestration through the real session runtime and deterministic Herdr transport. Observe the staged native effects and their persisted checkpoints for Worker session creation, workspace, tab, agent, kickoff persistence, kickoff submission, close, and exact absence.

At each effect boundary, simulate a lost response or interruption and re-enter through the supported runtime. The evidence must show no replay of a possibly completed workspace placement, tab creation, agent start, kickoff prompt, steering prompt, or close request. Ambiguous, partial, and foreign identity must produce a bounded blocker rather than a replacement Worker or guessed settlement.

Normal settlement must record the semantic Outcome before checkpointing or requesting close, issue close at most once, and mark the Worker closed only after exact absence. A permanently missing Worker must become a bounded unreported Outcome. Cancellation of an active Worker must checkpoint its reason before one close, prove absence, and then atomically record closed Worker state with a cancelled Outcome. Cancelling a queued Attempt must not launch a Worker. Runtime shutdown must interrupt owned coordination activity while preserving Coordinator checkouts, independent Worker sessions, Herdr resources, and repository resources.

Assert ordering from persisted records and transport observations. Private helper call counts alone do not establish the supported flow.

## Semantic Outcome and models

Read the actual Worker Pi session used by an Attempt. Establish that a valid terminal report becomes a reported Outcome, malformed or unavailable terminal evidence becomes a truthful bounded unreported result, and cancellation remains distinct. The Outcome must be immutable once present.

Use controlled providers to emit real Pi model-change entries. Verify that the Attempt freezes requested targets before launch while `effectiveModels` comes from actual ordered session markers, deduplicates exact targets, can differ from selection, and is empty when no effective model was observed. Never infer model use from report prose or from the requested policy alone.

## Repository targets and output

Use real disposable Git repositories through the registered coordinator/runtime boundary. Verify the exact filesystem and Git facts rather than a mocked status summary:

- directory targets resolve to one real path and never create Git output;
- repository targets freeze checkout root and common directory;
- each repository Attempt freezes an exact base commit and runs in its exact detached worktree;
- placement recovery requires the clean exact base before agent start, while later execution dirtiness cannot prevent reported or unreported settlement;
- `candidateOf: extend` requires the exact retained source Candidate ref, preserves its root, starts from its tip, and prevents source discard until successor placement;
- `candidateOf: integrate` preserves an explicit base, exact source Candidate-producing Attempt, and source tip;
- a completed report retains only commits: unchanged HEAD produces no output, changed HEAD creates `refs/pi-workgraph/outputs/<attemptId>`, and the whole worktree is removed in either case;
- failed, escalated, unreported, and cancelled Attempts preserve dirty, ignored, and untracked bytes while compacting clean commit state normally;
- complete absence recovers compacted output, while external deletion or pruning remains unsupported; and
- moved, foreign, incomplete, unrelated, or ambiguous resources remain physically present and blocked.

Application preparation must leave destination bytes, HEAD, and ref unchanged while proving source ref, base, Candidate lineage, destination identity, cleanliness, ancestry, and tree mergeability. The explicit apply flow must produce only the prepared structural result, record its exact revision, then release output. It must refuse to overwrite an ignored destination path tracked by the Candidate while allowing and preserving unrelated ignored artifacts. Recovery accepts only the exact expected Git structure; a switched, unrelated, or advanced destination blocks without rollback or automatic retry.

Explicit discard must checkpoint its reason before deleting exact verified output. Separately prove that completed reports remove only their exact worktree, including uncommitted scratch, while non-completed Outcomes and failed cleanup preserve dirty or uncertain resources. No repository-custody operation pushes or publishes.

## Coordinator checkouts

Drive `workgraph_checkout` through the registered Coordinator tool and real disposable Git repositories. Establish that read-only session startup creates nothing; explicit creation snapshots the exact committed `HEAD` of an attached or detached source without copying or mutating tracked, untracked, or ignored working-tree bytes; repeated calls from the same session and Git common directory converge across linked worktrees and reloads; and separate sessions receive distinct paths and branches.

Observe the filesystem entry, direct branch ref, exhaustive worktree registrations, attached managed `HEAD`, repository common directory, and both directions of the linked-worktree backlink. Exact unlocked identity may reuse modified, deleted, untracked, ignored, advanced, or rewritten managed content. One-sided, duplicated, moved, symlinked, foreign, wrong-branch, wrong-repository, locked, and unreadable resources must remain present and blocked rather than being replaced or repaired. Model interrupted population with Git's locked initialization state.

Simulate a native creation command that returns failure after creating the exact worktree: only the exact requested commit and complete identity may recover as successful creation with a bounded diagnostic. A wrong post-create commit and every partial or uncertain postcondition must block without retry. Ordinary shutdown preserves the checkout; no database row, startup reconstruction, cache, background reconciliation, automatic cleanup, or path interception is involved.

Make direct committed changes in the managed checkout and target a repository implementation Task at that path. Prove that its detached Worker Candidate applies into the Coordinator checkout rather than the source checkout. Final integration, publication, and cleanup belong to native repository or forge tooling and are not Workgraph checkout operations; do not retain lifecycle fixtures for their native effects. Inspect the packaged Coordinator contract to establish that an accepted change without an explicit route stops for a delivery choice, and that only an already-selected pull-request route triggers the publication skill.

## Worker behavior

Exercise each role through a real Worker Pi session and installed Worker extension. Verify role-specific tool gates, immutable assignment context, report schema, report readback, model markers, and compaction recovery from genuine Pi branch history.

For implementation, establish one guide-to-executor Prewalk in the same session. Cutover requires both a valid 1–9 item TODO and a successful direct edit or write, in either order. Failed mutations, shell commands, and observations do not qualify. Verify exact executor model and thinking selection, one executor-start marker, guide-policy replacement on the next provider request, stable assignment context, and an executor assistant message before a changed terminal report. Selection failure must remain guide-owned, emit one diagnostic, block further mutation, permit truthful failure or escalation, and never retry automatically.

Restore assignment and current TODO after actual context compaction, not ordinary reload or message traffic. A TODO status is not a correctness oracle or report gate.

## Coordinator tools and notepad

Invoke every registered coordinator tool through Pi's extension surface. Verify strict tool inputs, failure before record creation for invalid policy or selection, Task/Attempt and Coordinator-checkout receipts, exact bounded inspection, and explicit control effects. Confirm that one fresh Worker session is associated with each Attempt and that inspection cannot enumerate another coordinator session's records.

Exercise the branch notepad through `read`, `replace`, and `clear`, including its 4,000-character bound and latest-snapshot behavior. Genuine compaction should inject a nonempty current memo once for recovery; normal message traffic and reload should not. The notepad must not mutate Task, Attempt, Outcome, or repository state.

## Calm

Claims about Calm require an installed Pi instance using the running CLI's own component constructors. Drive rendered interaction through the live chat seam and observe:

- Calm is coordinator-only and defaults on;
- each render reflects the current live children, including a row inserted by direct child splice;
- exact tool-execution and `pi-workgraph-outcome` rows are absent;
- assistant thinking and tool-call parts are absent while prose and terminal notices remain;
- unpaired and paired skill presentation, assistant separators, and visible-row adjacency are correct;
- streaming source updates appear in projection and remain current after Calm is disabled;
- theme, width, invalidation, and mouse interaction use projected presentation;
- toggling, preference changes, attachment replacement, and shutdown restore native presentation; and
- any validated-seam incompatibility falls back to the complete native chat rather than partial filtering.

Representative render measurements are required for cost or responsiveness claims. Unit projection fixtures establish classification and caching behavior, not compatibility with the installed Pi build.

## Extension and package smoke

Load the registered coordinator and Worker extensions from the exact checkout through Pi's extension runtime, then drive session startup and shutdown to establish registration, role gating, guidance injection, Coordinator-only publication-skill discovery, and clean release of session-owned resources. Pack the exact revision, install it in a disposable consumer, load both supported entry-point factories through the installed Pi extension loader, and discover the installed publication skill through Pi's real skill loader. This disposable-consumer check establishes packaged extension loading, registration, and skill validity—not session lifecycle or a live forge publication; archive inspection, module import alone, or build success does not establish that boundary.

[`package.json`](package.json) owns command definitions:

- `pnpm check` runs the maintained static, export, and deterministic checks;
- `pnpm typecheck` is an independent compiler diagnostic;
- `pnpm verify:package` runs the disposable-consumer package check; and
- `pnpm verify:native` is an opt-in bounded check against operator-provided Pi, Herdr, provider, and model configuration.

## Test design and resource safety

Prefer complete supported flows and focused boundary checks that expose a distinct failure. Delete obsolete fixtures and adapters with their responsibility. Do not maintain exhaustive host simulations, hypothetical database-tampering suites, removed-format fixtures, or tests that duplicate production classification, lineage, or transition logic as their expected-value oracle. Use a temporary probe when evidence is needed once.

A complete flow should observe positive results, forbidden effects, and consequential order. Stable assertions target records, native identities, Git structure, rendered output, and externally visible errors—not private helper calls, incidental wording, collection positions, or internal scheduling.

Live native and destructive checks are operator-controlled. Use uniquely named disposable sessions, tabs, worktrees, refs, repositories, and temporary agent directories; bound every wait; verify exact identity before close or deletion; and clean up only resources created by that check. Preserve unrelated and pre-existing resources after success, failure, interruption, or uncertain response.

## Limits on evidence

- One coordinator process per Pi session is supported; concurrent use of the same session is not.
- Concurrent mutation of the destination checkout or destination ref by another session, process, or user during apply is unsupported; no repository-wide lock is claimed.
- Multi-repository effects are independent and have no cross-repository transaction or rollback.
- Worktrees and tool gates are not security sandboxes.
- SQLite process safety does not establish power-loss durability.
- Deterministic Herdr transport does not establish installed native behavior.
- Native evidence applies only to the tested Pi, Herdr, Git, operating system, provider, model, and settings configuration.
- One autonomous model run is evidence about that exact run, not a deterministic oracle.

Verification reports should identify the exact revision checked, direct observations, preserved resources, unresolved uncertainty, and the boundary each observation establishes. Do not accumulate run history here.
