# Workgraph verification boundaries

[`DESIGN.md`](DESIGN.md) owns the behavior Workgraph promises, and [`package.json`](package.json) owns executable checks. This document records only the project-specific evidence distinctions that contributors could otherwise miss or establish at an unnecessarily expensive boundary.

Use the smallest real boundary that distinguishes the supported promise from consequential failure. A component check establishes only its local contract; it does not establish that the registered extension, native store, real Pi session, Git resource, installed Calm adapter, or packed consumer works.

## Assurance map

| Claim area | Smallest meaningful boundary |
| --- | --- |
| Persisted records and Outcomes | Native SQLite store through separate exact-session instances |
| Worker lifecycle, reports, and observed models | Real Worker Pi session with deterministic Herdr transport |
| Repository output, Candidates, Coordinator checkouts, and local delivery | Disposable real Git repositories through registered tools |
| PR completion | Registered delivery tool, controlled forge responses, and a real disposable bare remote |
| Coordinator surface | Pi extension registration and returned persisted facts |
| Implementation trajectory | Real Pi Worker session with controlled providers |
| Calm | Installed Pi using the running CLI's component constructors |
| Package | Packed artifact installed in a disposable consumer |
| Installed-native integration | Explicit operator-controlled live check |

## Persisted and external coordination state

### Records and Outcomes

The record contract is defined by [Record store](DESIGN.md#record-store) and [Stable and mutable state](DESIGN.md#stable-and-mutable-state).

Exercise the native SQLite store through separate instances for exact Coordinator sessions. Establish transaction rollback, session partitioning, immutable Task and Attempt specifications, write-once Outcomes, and strict decoding from actual persisted rows. A focused mutation of one persisted field should make the supported read reject that field; TypeBox acceptance of supplied values does not establish this boundary.

Worker report consistency must be checked where the runtime-injected role meets persisted Outcome insertion. A nonempty database with an unsupported schema version must reject before initialization; this focused version gate is distinct from arbitrary corruption or migration coverage.

Arbitrary external database tampering is not a supported recovery interface, so do not maintain a general corruption matrix. Likewise, do not add migration, aggregate-reconstruction, lease, or cross-session-discovery fixtures unless those become supported responsibilities.

### Worker lifecycle, reports, and models

Drive the [Worker lifecycle](DESIGN.md#worker-lifecycle) through the real session runtime and deterministic Herdr transport. At each checkpointed external effect—placement, tab creation, agent start, kickoff submission, and close—simulate a lost response or interruption, re-enter through the supported runtime, and observe persisted facts plus native identity. Adapter call tests do not establish that a possibly completed effect is not replayed.

Meaningful lifecycle evidence includes:

- semantic Outcome recorded before one checkpointed close;
- exact absence established before a Worker becomes closed;
- queued cancellation launching nothing;
- active cancellation checkpointing its reason and closing at most once; and
- runtime shutdown preserving Worker sessions, checkouts, Herdr resources, and repository output.

Read reports and effective models from the actual Worker session. Use controlled providers to produce real model-change entries and establish that observed models come from session markers rather than requested policy or report prose. Malformed terminal evidence must remain distinguishable from cancellation and operational failure.

A deterministic Herdr transport establishes runtime recovery behavior, not compatibility with the operator's installed Herdr configuration.

## Repository custody

Use disposable real Git repositories through registered Workgraph entry points. Inspect commits, refs, `HEAD`, status, ignored files, worktree registrations, backlinks, and preserved bytes. A parser or isolated classification predicate establishes only its own result.

### Worker output and Candidates

The current contracts are [Targets and Candidate lineage](DESIGN.md#targets-and-candidate-lineage) and [Repository custody](DESIGN.md#repository-custody).

Exercise exact-base placement and both Candidate lineage modes before testing output classification. An extension flow must reach application: place the child from the parent tip, then apply the child directly to the untouched original destination and observe both changes. Placement-only evidence misses an incorrect parent-first application requirement. Classification must occur only after exact Worker closure. Distinguish unchanged completion, committed changed completion, relinquished scratch, preserved noncompletion, and ambiguous or foreign resources by observing native Git state—not Worker report claims.

Application preparation must leave destination bytes, `HEAD`, and branch refs unchanged while proving source lineage, destination identity, ancestry, mergeability, and ignored-path safety. The applied result must match the prepared advancement before output is released. Recovery must distinguish an effect that already completed from an effect still eligible to execute. A moved destination must not be silently replanned by background reconciliation; exercise the explicit retry path as well as its refusal conditions.

Discard evidence must show the reason and exact retained tip checkpointed before deletion, with foreign, pinned, moved, dirty, or uncertain resources preserved. No repository-custody check should push or publish.

### Coordinator checkouts

Drive `workgraph_checkout` through the registered tool. For [Coordinator checkout lifecycle](DESIGN.md#coordinator-checkout-lifecycle), observe the filesystem path, direct branch ref, exhaustive worktree registrations, attached `HEAD`, Git common directory, and both backlinks.

Establish that identity is deterministic for one session and repository, isolated across sessions, and based on committed source `HEAD` without copying or changing source checkout bytes. Exact current state may be reused even when managed content changed. Distinguish checkpointed partial operations from unknown partial, duplicate, locked, symlinked, foreign, moved, or unreadable state: durable intent permits only its own proven recovery, not general repair.

A failed native creation response counts as recovered success only when immediate observation proves the complete requested identity at the exact commit. Wrong-commit or partial state must remain visible and blocked.

The supported end-to-end flow is: create the managed checkout, make a direct committed change there, target an Implementation Task there, and apply its Candidate back into that managed destination. This distinguishes Coordinator checkout custody from ordinary Worker output and from the original source checkout.

### Delivery and cleanup

Exercise the whole lifecycle through registered tools: allocate, change, accept a revision, select local delivery, observe destination content and history, observe worktree and branch absence, then allocate again in the same session from an advanced source. A complete receipt must not hide a remaining resource, and a completed record must not recreate resources merely on session resume.

Use independent native Store instances to establish session partitioning and durable progress. Interrupt around integration and each cleanup effect, resume through supported entry points, and inspect actual refs, registrations, and files. The worktree-removed/branch-remaining case is essential: it previously made later allocation fail. Records or helper calls alone do not prove cleanup.

Observe preserved staged, unstaged, untracked, and ignored destination bytes for disjoint changes, and refusal without destructive effects for overlaps or conflicts. Also observe that an advanced or dirty source, active dependencies, or retained output prevents cleanup. Ignored build artifacts in an accepted completed source must not require manual housekeeping.

For PR completion, combine controlled forge responses with real Git remotes and histories. Cover merge, squash, and rebase results, exact accepted-head mismatch, closed-unmerged preservation, already-absent published branches, and changed remote tips. A deletion must compare the expected delivered tip, not merely check it before an unconditional delete. Verify local reconciliation preserves pre-existing unpublished commits and publishes none of them.

A forge response's base SHA is not necessarily the current remote base tip. Establish the actual merged result and current remote ancestry separately. Controlled responses establish adapter and lifecycle behavior, not live publication, authentication, or the independent observer's availability. No maintained test should create a live PR or mutate an installed session.

Inspection of the packaged Coordinator contract and delivery reference establishes the remaining judgment and authority boundary. Do not duplicate runtime checks as prose-matching tests.

## Installed Pi surfaces

### Worker trajectory

Exercise the [Implementation trajectory](DESIGN.md#implementation-trajectory) in one real Pi Worker session with the installed Worker extension. Establish role-specific tool gates, immutable assignment context, report readback, and genuine compaction restoration from Pi branch history.

For guide-to-executor cutover, distinguish the two required facts—a valid TODO and a successful direct edit or write—from shell commands, observations, failed mutations, and Git dirtiness. Observe exact model and thinking selection, one executor marker, guide-policy replacement on the next provider request, and an executor assistant message before changed completion. Selection failure must stay guide-owned, block further direct mutation, remain reportable, and never retry automatically.

When an executor becomes idle with actionable TODOs and no report, establish through the Worker session that it receives at most two continuation reminders and may still report truthfully; TODO status is navigation, not a completion gate.

Synthetic event-handler calls are useful component checks, but they do not establish the real provider-request trajectory or compaction boundary.

### Coordinator surface and notepad

Invoke Coordinator behavior through Pi's registered extension surface. Establish role gating, strict public inputs, failure before record creation when policy or selection is invalid, and receipts that expose persisted facts without claiming acceptance.

Use live dirty material for Review and a real repository placement for Experiment so those roles are not accidentally constrained to Attempt provenance or confused with Candidate-producing implementation. For Experiment, establish that each Attempt receives its frozen permitted effects and hard cutoff in Worker policy; repository placement alone grants no general mutation or post-cutoff cleanup authority. For any control effect that may fail after a checkpoint, inspect the exact Attempt and preserved partial facts before retrying.

Notepad evidence needs only its bounded latest-snapshot behavior, branch locality, and one restoration after genuine compaction. Ordinary reload or message traffic must not inject it, and notepad operations must not alter Task, Attempt, Outcome, or repository state.

### Calm

Claims about [Calm](DESIGN.md#calm-and-pending-memory) require an installed Pi instance using the running CLI's component constructors. Observe live projection, streaming updates, adjacency, mouse and invalidation behavior, preference changes, toggling, attachment replacement, shutdown restoration, and complete native fallback after a validated-seam incompatibility.

Projection fixtures establish classification and caching, not compatibility with the installed Pi build. Cost or responsiveness claims require representative render measurements rather than callback counts.

### Extension and package

Load Coordinator and Worker extensions from the exact checkout through Pi's extension runtime to establish registration, role gating, guidance injection with resolved package-local reference links, and clean release of session-owned resources.

Pack the exact revision, install it in a disposable consumer, load both supported extension entry points, emit the installed Coordinator's guidance injection, and read the installed delivery reference. Assert that the injected link resolves inside the installed package while the reference body stays unloaded. Archive inspection, source-tree import, or build success does not establish installed package loading. The package check does not establish real Worker lifecycle, native integration, or forge publication.

## Suite and resource policy

Prefer complete supported flows and retain focused component checks only when they expose a distinct consequential failure more clearly or cheaply. Observe positive results, forbidden effects, and ordering where the promise depends on them. Assert persisted records, native identities, Git structure, rendered output, and external errors rather than private helper calls, incidental wording, or collection position.

Do not build exhaustive host simulations, hypothetical tampering suites, removed-format fixtures, or duplicated production logic as an oracle. Delete obsolete fixtures and adapters with the responsibility they served; use temporary probes for one-off uncertainty.

Live and destructive checks are operator-controlled. Use uniquely named disposable sessions, tabs, worktrees, refs, repositories, and agent directories; bound every wait; verify exact identity before deletion; and clean up only task-owned resources. Preserve unrelated or uncertain resources after success, failure, interruption, or an ambiguous response.

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
