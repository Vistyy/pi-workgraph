# Workgraph verification boundaries

This document owns project-specific evidence requirements. It does not prescribe a test layout or a mandatory pipeline. Start with the affected promise and use the smallest supported flow that distinguishes correct behavior from consequential failure. Component checks establish only their local contract; they do not establish that the registered extension, runtime, or installed package works.

## Consequential supported flows

### Session records

The Store is one lazily created SQLite file under the Pi agent data directory, partitioned by exact Pi session. Tasks are immutable and self-contained, including their directory or repository target. Attempt specifications are likewise immutable and contain the execution selection, base, and any candidate lineage needed by their callers. Worker and output checkpoints are focused writes; an Outcome is embedded in its Attempt and may be written only once. `effectiveModels` may be empty when no model was effectively observed.

Use native SQLite to establish initialization, transaction rollback, session isolation, write-once behavior, file privacy, and strict decoding of every field read from an actual persisted row. Unknown schema versions fail closed. There is no migration claim: tests should not require old formats to open or be transformed.

### Worker lifecycle

Establish the staged facts for session creation, workspace placement, tab, agent, and kickoff independently. A successful response may be lost after any external effect, so recovery observes exact persisted and native identity and never relaunches the same Attempt or replays an uncertain tab, agent, kickoff prompt, or close effect. A missing Worker eventually becomes a bounded unreported Outcome rather than waiting forever.

Normal settlement records the Outcome before requesting exact Worker closure. Cancellation closes the exact Worker, proves its absence, and records the cancelled result; repeated or ambiguous observation must not duplicate close. Steering is an explicit supported action separate from cancellation. Runtime shutdown stops owned coordination activity but does not close independent Workers or delete their sessions or output.

### Repository output

Repository output is classified only after Worker closure. Use a detached checkout for execution and create the private exact-Attempt output ref before removing a clean checkout. Unchanged clean output may disappear; changed clean output retains its exact ref. Dirty, untracked, ignored, moved, foreign, or uncertain output remains physically preserved until an explicit exact disposition can prove ownership.

Application is an explicit per-Attempt operation. Preparation must not mutate destination bytes, HEAD, or ref; application rechecks the exact source and attached clean destination, handles conflicts before mutation, and accepts only a structurally proven result on recovery. Irreversible discard requires an explicit reason and exact owned ref/check-out facts. It checkpoints the disposition before deletion and recovers only from proven postconditions. No ordinary settlement path may delete dirty output, and no failure or retry may remove foreign or uncertain resources.

### Worker behavior

Implementation uses one guide-to-executor Prewalk in the same Pi session. Cutover occurs after both a valid 1–9 item TODO and one successful direct edit or write, in either order. Failed mutations, shell commands, and observations do not qualify. Prove model and thinking selection, one executor-start marker, guide-policy replacement, stable objective/context, and a later executor assistant message before changed completion. Selection failure stays guide-owned, emits one visible diagnostic, blocks further mutation, permits truthful failure or escalation, and is not retried automatically.

Each Worker role receives only its supported tools and report shape. Exercise settings failures, objective validation, model-event capture, report readback, and compaction recovery through real Pi session records. Restore the objective and current TODO only after genuine compaction, not ordinary reload or message traffic.

### Coordinator surface

Exercise public behavior through the registered Coordinator tools, not direct calls to private runtime helpers. Validate strict tool inputs, externally visible results, inspection of current records and blockers, explicit model-policy selection, and no assignment effects when policy or selection is invalid. Memo evidence covers its bounded current snapshot, ordinary mutations, and compaction restoration; it does not infer meaning from conversation text.

Use deterministic Herdr transport for orchestration flows while preserving real runtime and tool entry points. An actual Herdr run is needed only for claims about the installed native configuration. Bound observations and retries, and expose unresolved identity or effect uncertainty instead of guessing.

### Calm

Verify Calm through rendered interaction with the live Pi chat seam: projection and native fallback, streaming updates, toggling, session preference behavior, attachment replacement, shutdown restoration, and bounded activity presentation. Failure must restore native presentation without taking ownership of foreign UI state. Render-cost or responsiveness claims require representative measurement of history traversal, updates, and requested renders; unit assertions about callbacks are not performance evidence.

### Packaging

Pack the exact revision, install it in a disposable consumer, and import the supported coordinator and worker entry points outside the checkout. Inspecting the package file list alone does not establish startup.

## Evidence boundaries

| Claim | Evidence that establishes it | What a component check establishes instead |
| --- | --- | --- |
| Store persistence and decoding | Real native SQLite rows and transactions in the agent-wide file, observed through separate exact-session Store instances | Schema acceptance, transition predicates, or error mapping for supplied values |
| Worker events, model changes, context, and reports | Controlled providers through real Pi sessions and the installed Worker extension | Local event-handler behavior against synthetic callbacks |
| Placement, kickoff, closure, cancellation, steering, and shutdown | Deterministic Herdr transport through the real runtime/control entry points, with exact persisted and observed identities | Adapter request/response translation and local state decisions |
| Repository custody, application, discard, and recovery | Real disposable Git repositories through runtime/control entry points; inspect commits, ordered parents where meaningful, refs, HEAD, bytes, status, ignored files, worktrees, and absence/presence | A Git adapter's parsing or one isolated classification predicate |
| Registered tools, inspection, policy, and memo behavior | Invoke registered Coordinator tools and observe returned records, messages, blockers, and forbidden effects | Input schema or private method behavior only |
| Calm behavior and cost | Rendered interaction through the live chat seam plus representative measurements for cost claims | Pure projection or formatting behavior |
| Installed-native behavior | Opt-in, bounded run against the exact configured Pi/Herdr/provider environment | Deterministic transport behavior, not the installed environment |
| Packaged startup | Disposable consumer installation and import of supported entry points | Build success or expected archive contents |

A complete flow should assert meaningful positive facts, forbidden effects, and ordering only where the supported behavior depends on it. High-value negative observations include:

- no duplicate tab, agent, kickoff prompt, or close effect after an ambiguous checkpoint;
- no repository classification before exact Worker closure;
- no destination mutation during preparation or before explicit application;
- no dirty, foreign, or uncertain output deletion except an exact explicit discard;
- no Worker session or output deletion during runtime shutdown; and
- no memo restoration without a genuine compaction event.

Do not couple checks to private helper calls, incidental wording, collection positions, or an exhaustive matrix of representable states. Unsupported database tampering and corruption scenarios are not product guarantees. Expectations should come from supported behavior, not from reimplementing production decisions as the test oracle.

## Suite maintenance

Delete obsolete tests, fixtures, adapters, and setup when their architecture is removed; do not translate them mechanically into the replacement suite. Retain a focused component check only when it distinguishes a consequential failure that a complete flow does not establish clearly or cheaply. Widespread fixture churn is evidence of coupling and a reason to reconsider the boundary or harness.

Use temporary probes for one-off uncertainty. Use targeted mutation only when it is unclear whether a check would detect the failure it claims to protect against. There are no required file layouts, test counts, or layers for every change. Keep assertions stable across implementation changes while making resource identity, ordering, and forbidden effects explicit where they matter.

## Commands

[`package.json`](package.json) owns executable commands and their internals.

- `pnpm check` is the maintained static, export, and deterministic test gate.
- `pnpm typecheck` is an independent compiler diagnostic and is not implied by `pnpm check`.
- `pnpm verify:package` is the separate disposable-consumer package check.
- `pnpm verify:native` is an opt-in bounded native check for an operator-provided environment.

An autonomous coordinator or model run is never a routine gate. Use one only when model interpretation or a reproduced autonomous decision is itself the claim, and report its model, settings, bounded task, and evidence limits. Do not treat one model result as a deterministic oracle.

## Limits on claims

- Concurrent use of one Pi session by multiple Coordinator processes is unsupported.
- Ordinary concurrent user mutation of the destination checkout or destination ref during application is unsupported.
- Git worktrees and tool gates are not security sandboxes.
- Process-safe persistence does not claim durability across power loss.
- Native evidence applies only to the tested Pi, Herdr, Git, operating system, provider, model, and settings configuration.

Verification reports should identify the exact revision checked, concrete observations, unresolved uncertainty, and the boundary each observation establishes. Do not accumulate run history in this document.
