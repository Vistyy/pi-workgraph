# Workgraph verification boundaries

Use the smallest real boundary that distinguishes the supported promise from consequential failure.

A component check establishes only its local contract. It does not establish that the registered extension, real Pi session, installed Calm adapter, or packaged consumer works.

## Assurance map

| Area | Smallest meaningful boundary |
| --- | --- |
| Session records | Native SQLite store through separate exact-session instances |
| Worker lifecycle and reports | Real Worker Pi session with deterministic Herdr transport |
| Repository output and checkout custody | Disposable real Git repositories through registered tools |
| Coordinator tools | Pi extension registration surface |
| Calm | Installed Pi using the running CLI's component constructors |
| Package | Packed artifact installed in a disposable consumer |
| Native integration | Explicit operator-controlled live check |

## Session records

Exercise the native SQLite store through separate exact-session instances.

Establish that:

- `tasks` and `attempts` are strict tables with required relationships;
- Task plus first Attempt creation is atomic;
- failed creation leaves neither half-record;
- another Attempt can reference only a Task in the same session;
- identical Task IDs remain isolated across sessions;
- Task and Attempt specifications cannot be replaced;
- Outcome insertion is write-once; and
- every persisted JSON field and SQL scalar is strictly decoded when a supported read uses it.

Use actual rows and transaction failure, not only TypeBox value checks.

For Worker reports, prove that:

- runtime injects the exact Research, Experiment, Consultation, Review, or Implementation role;
- store-side consistency rejects a role mismatch; and
- a focused decoder mutation causes the supported read to reject that exact invalid field.

Remove disposable databases after the check. Do not maintain a general corruption matrix: arbitrary external database tampering is not a supported recovery interface.

Do not add fixtures for migration, aggregate reconstruction, cross-session discovery, leases, or concurrent use of one session unless those become supported responsibilities. Schema version 1 must fail closed on an unknown existing version.

## Worker lifecycle

Drive orchestration through the real session runtime and deterministic Herdr transport.

Observe these native effects and their persisted checkpoints:

1. Worker session creation;
2. workspace placement;
3. tab creation;
4. agent start;
5. kickoff persistence;
6. kickoff submission;
7. close; and
8. exact absence.

At each effect boundary, simulate a lost response or interruption. Re-enter through the supported runtime.

Establish that it does not replay a possibly completed placement, tab creation, agent start, kickoff, steering prompt, or close request.

Ambiguous, partial, or foreign identity must produce a bounded blocker—not a replacement Worker or guessed settlement.

### Settlement and cancellation

Establish this order for normal settlement:

```text
record semantic Outcome
  → checkpoint close
  → request close once
  → prove exact absence
  → mark Worker closed
```

Also establish that:

- a permanently missing Worker becomes a bounded unreported Outcome;
- cancelling a queued Attempt launches no Worker;
- cancelling an active Attempt checkpoints its reason before one close;
- active cancellation proves absence before recording closed state and cancelled Outcome together; and
- runtime shutdown preserves checkouts, Worker sessions, Herdr resources, and repository resources while stopping owned coordination activity.

Assert order from persisted records and transport observations. Private helper call counts are insufficient.

## Semantic Outcomes and models

Read the actual Worker session associated with the Attempt.

### Reports

Verify that:

- each role exposes the correct strict report input;
- the model cannot submit a role;
- blank summary or details, missing required fields, and undeclared fields reject;
- runtime injects the immutable role;
- a valid terminal report becomes one persisted readable Outcome;
- malformed or unavailable terminal evidence becomes a bounded unreported result;
- unreadable or malformed Worker settings permit only a truthful `failed` report;
- cancellation remains distinct;
- `completed`, `needs_decision`, and `failed` preserve their exact semantics;
- Implementation alone supports completed `changed` or `no_change`; and
- changed completion requires an executor assistant message after cutover.

The Outcome must remain immutable after insertion.

### Models

Use controlled providers to emit real Pi model-change entries.

Establish that:

- the Attempt freezes requested targets before launch;
- `effectiveModels` comes from ordered session markers;
- exact duplicates are removed;
- effective models may differ from the selection; and
- effective models are empty when execution observed none.

Never infer model use from report prose or requested policy alone.

Decode the current strict model policy:

- Research and Review require duplicate-free nonempty lists;
- Consultation requires one target;
- invalid policy or selection fails before record creation; and
- inspection and control of frozen Attempts do not depend on current policy loading.

## Repository targets and output

Use real disposable Git repositories through the registered Coordinator/runtime boundary.

### Placement and lineage

Establish that:

- directory Targets resolve to one real path and create no Git output;
- repository Targets freeze checkout root and Git common directory;
- each repository Attempt freezes an exact base commit in its detached worktree;
- placement recovery requires the exact clean base before agent start;
- later execution dirtiness does not prevent settlement;
- `candidateOf: extend` requires the exact retained source Candidate, preserves its root, starts at its tip, and pins source until successor placement; and
- `candidateOf: integrate` preserves its explicit base, source-producing Attempt, and exact source tip.

### Classification

Verify the supported outcomes:

| Attempt result | Repository result |
| --- | --- |
| Completed, unchanged `HEAD` | No output; remove worktree. |
| Completed, changed `HEAD` | Retain `refs/pi-workgraph/outputs/<attemptId>`; remove worktree. |
| Noncompleted, dirty or uncertain state | Preserve worktree and bytes. |
| Clean compactable state | Compact under current rules. |

A completed report retains only commits and relinquishes uncommitted scratch. Complete absence may recover compacted output; external deletion or pruning remains unsupported.

Moved, foreign, incomplete, unrelated, or ambiguous resources must remain present and blocked.

### Apply and discard

Application preparation must leave destination bytes, `HEAD`, and refs unchanged while proving:

- source ref and base;
- Candidate lineage;
- destination identity and cleanliness;
- ancestry and tree mergeability; and
- ignored-path safety.

Applying must produce only the prepared structural result, record its exact revision, then release output. It must refuse to overwrite an ignored destination path tracked by the Candidate while preserving unrelated ignored artifacts.

Recovery accepts only the exact expected Git structure. A switched, unrelated, or advanced destination blocks without rollback or automatic retry.

Discard must checkpoint its reason before deleting exact verified output. Separately prove that:

- completed cleanup removes only its exact worktree;
- noncompleted Outcomes preserve dirty bytes; and
- failed cleanup preserves uncertain resources.

No repository-custody operation pushes or publishes.

## Coordinator checkouts

Drive `workgraph_checkout` through the registered tool and real disposable repositories.

### Create and reuse

Establish that:

- read-only startup creates nothing;
- creation snapshots exact committed `HEAD` from attached or detached source;
- source tracked, untracked, and ignored bytes are not copied or changed;
- repeated calls converge for one session and Git common directory across reloads and linked worktrees; and
- separate sessions receive different paths and branches.

Observe:

- the filesystem entry;
- direct branch ref;
- exhaustive worktree registrations;
- attached managed `HEAD`;
- repository common directory; and
- both linked-worktree backlinks.

Exact unlocked identity may reuse modified, deleted, untracked, ignored, advanced, or rewritten managed content.

### Blocked and uncertain state

One-sided, duplicate, moved, symlinked, foreign, wrong-branch, wrong-repository, locked, or unreadable resources must remain present and blocked. Model interrupted population with Git's locked initialization state.

When native creation reports failure after creating the worktree, recover success with a bounded diagnostic only if immediate observation proves the exact requested commit and complete identity. Wrong commit or any partial postcondition blocks without retry.

Ordinary shutdown preserves the checkout. There is no database row, startup reconstruction, cache, background reconciliation, automatic cleanup, or path interception.

### Supported flow

Make a direct committed change in the managed checkout. Target an Implementation Task there and prove that its detached Worker Candidate applies into the managed checkout rather than the source checkout.

Publication, continued observation, final integration, and cleanup belong to native repository, forge, or session capabilities—not Workgraph checkout operations. Do not retain lifecycle fixtures for those native effects.

Inspect the packaged Coordinator contract and delivery reference to establish that:

- no explicit route means stop and request a delivery choice;
- a selected route loads its procedure without expanding authority;
- pull-request delivery verifies the exact result and reports whether observation was established;
- local integration affects only the exact authorized destination through ordinary non-force Git;
- preserving the checkout performs no delivery or cleanup effect;
- delivered observations grant no authority;
- same-scope correction remains within existing task and delivery authority;
- observation-availability failure may remain user-visible without an agent turn; and
- force, unrelated work, and expanded scope or authority remain forbidden.

## Worker behavior

Exercise every role through a real Worker Pi session and installed Worker extension.

Verify:

- role-specific tool gates;
- immutable assignment context;
- narrative report schema and exact role injection;
- report readback;
- model markers; and
- compaction recovery from genuine Pi branch history.

Assignment policy must preserve evidence beyond read-only `cwd` and the Experiment's hard lifetime cutoff, including authorized teardown and the absence of automatic enforcement or post-cutoff cleanup authority.

### Implementation trajectory

Exercise one guide-to-executor trajectory in the same session.

Establish that:

- TODO initialization accepts 1–9 items without caller-supplied statuses;
- runtime marks the first item `in_progress` and the rest `pending`;
- set and update return complete current-state receipts;
- duplicate initialization rejects;
- cutover requires both a valid TODO and one successful direct edit or write;
- failed mutations, shell commands, and observations do not qualify;
- executor model and thinking selection are exact;
- one executor-start marker is written;
- guide policy is replaced on the next provider request;
- assignment context remains stable; and
- changed completion requires an executor assistant message.

Selection failure must stay guide-owned, emit one diagnostic, block further mutation, permit truthful `failed` or `needs_decision` reporting, and never retry automatically.

When the executor becomes idle with actionable items and no report, verify at most two continuation reminders. TODO status is never a report gate or correctness oracle.

Restore assignment and current TODO after actual context compaction—not ordinary reload or message traffic.

## Coordinator tools and notepad

Invoke every Coordinator tool through Pi's registered extension surface.

### Tool contracts

Verify strict current schemas for:

- read-only Research;
- effectful Experiment;
- configured Consultation;
- flexible Review;
- Implementation and Candidate lineage;
- inspection and control; and
- checkout and notepad operations.

Optional context and expected evidence must survive or omit exactly. Experiment effect entries must be nonblank, and cutoff semantics must reach immutable assignment and policy.

Create Review against a live dirty directory without an Attempt, Outcome, or revision. Observe resolved starting context plus request and optional context.

Use a real repository placement to distinguish Experiment from directory Research without treating Experiment scratch as a Candidate.

Verify failure before record creation for invalid policy or selection. Creation receipts identify immutable specifications. Successful control receipts expose requested action and persisted facts without claiming acceptance.

Exact Attempt inspection must include:

- Task contract and Target;
- report status and bounded preview; and
- the exact blocker, even beyond overview pagination.

For effects that can fail after a durable checkpoint, establish preserved partial facts and an inspect-before-retry response. Do not add rollback or ledger fixtures.

Confirm one fresh Worker session per Attempt and cross-session record isolation.

### Notepad

Exercise `read`, `replace`, and `clear`, including:

- the 4,000-character bound;
- latest-snapshot behavior;
- one recovery injection after genuine compaction; and
- no injection from ordinary message traffic or reload.

The notepad must not change Task, Attempt, Outcome, or repository state.

## Calm

Claims about Calm require an installed Pi instance using the running CLI's own component constructors.

Observe that:

- Calm is Coordinator-only and defaults on;
- each render reflects current live children, including direct child splices;
- exact tool-execution and `pi-workgraph-outcome` rows are absent;
- assistant thinking and tool-call parts are absent;
- prose and terminal notices remain;
- unpaired skill invocation appears as `/skill:name`, while paired metadata yields its accompanying user message;
- separators follow visible-row adjacency;
- streaming source updates appear in the projection and remain current after Calm is disabled;
- theme, width, invalidation, and mouse behavior use projected presentation;
- toggling, preference changes, attachment replacement, and shutdown restore native presentation; and
- any validated-seam incompatibility restores the complete native chat.

Representative render measurements are required for cost or responsiveness claims. Projection fixtures establish classification and caching, not compatibility with the installed Pi build.

## Extension and package smoke

Load the Coordinator and Worker extensions from the exact checkout through Pi's extension runtime. Drive startup and shutdown to establish:

- registration;
- role gating;
- Coordinator guidance injection with the exact delivery-reference path; and
- clean release of session-owned resources.

Pack the exact revision, install it in a disposable consumer, load both entry-point factories through the installed Pi extension loader, and read the installed delivery reference.

This package check establishes installed loading, registration, and reference availability.

Archive inspection, module import, or build success alone does not establish that boundary. The package check does not establish session lifecycle or live forge publication.

[`package.json`](package.json) owns command definitions:

- `pnpm check` runs maintained static, export, and deterministic checks;
- `pnpm typecheck` runs an independent compiler diagnostic;
- `pnpm verify:package` runs the disposable-consumer check; and
- `pnpm verify:native` runs the opt-in native check against operator-provided configuration.

## Test design and resource safety

Prefer complete supported flows and focused checks that expose a distinct failure.

- Observe positive results, forbidden effects, and consequential order.
- Assert records, native identities, Git structure, rendered output, and external errors—not private helper calls or incidental wording.
- Delete obsolete fixtures and adapters with their responsibility.
- Avoid exhaustive host simulations, hypothetical tampering suites, removed-format fixtures, and duplicated production logic as an oracle.
- Use temporary probes for one-off evidence.

Live and destructive checks are operator-controlled.

- Use uniquely named disposable sessions, tabs, worktrees, refs, repositories, and agent directories.
- Bound every wait.
- Verify exact identity before deletion.
- Clean up only task-owned resources.

Preserve unrelated and pre-existing resources after success, failure, interruption, or uncertain response.

## Evidence limits

Do not claim beyond these boundaries:

- one Coordinator process per Pi session;
- no support for concurrent destination or ref mutation;
- no transaction or rollback across repositories;
- no security sandbox from worktrees or tool gates;
- no power-loss durability claim from SQLite process safety;
- no installed-native claim from deterministic Herdr transport;
- native evidence applies only to the tested Pi, Herdr, Git, operating system, provider, model, and settings configuration; and
- no general model reliability claim from one autonomous run.

Verification reports identify the exact revision, direct observations, preserved resources, unresolved uncertainty, and the boundary each observation establishes. Do not accumulate run history here.
