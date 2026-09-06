# Pi Workgraph

Workgraph coordinates bounded repository work within a normal Pi conversation.
Research, disposable experiments, maintained implementation, and selective review are capabilities, not phases of a mandatory pipeline.
The durable rationale for this direction is in [DESIGN.md](DESIGN.md).

## Run

Use Node.js 24 or newer, Git, Pi, and a Herdr-managed pane with Herdr's Pi state integration installed.
The current integration is checked against Pi 0.84.4 and Herdr 0.8.2.

```bash
pnpm install
pi -e /absolute/path/to/pi-workgraph
```

Start from the project directory and ask the coordinator to delegate the needed work.
Composition still requires a clean destination at the maintained-application boundary.

### Coordinator Calm

The coordinator extension registers `/calm` to toggle hiding operational tool rows and Workgraph notification rows for the current session.
`/calm default on` or `/calm default off` saves the startup preference for new coordinator sessions without changing any existing session.
The default is initially off and is stored atomically in `workgraph/calm-default` beneath Pi's agent directory (normally `~/.pi/agent`, respecting `PI_CODING_AGENT_DIR`).
Each session retains its own choice across reload and resume; new and forked sessions start from the saved default.
The preference is session metadata, not a model message, and does not modify conversation content, tool execution, or worker tabs.
Calm shows a full-width signal garden with gently traveling light; non-Calm shows the same factual activity in a compact line with tools still visible.
Both replace the ordinary working row instead of stacking another spinner above it.
The garden is decorative, not a progress bar or a one-flower-per-worker map, and narrows to the compact view in small terminals.
The default hidden tool-name list covers Pi builtins, installed search tools, Workgraph tools, and `herdr_rename`.
Override it with `PI_WORKGRAPH_CALM_HIDDEN_TOOLS=tool_a,tool_b` before starting Pi.
The internal adapter targets Pi's exported `ToolExecutionComponent` and `CustomMessageComponent` render seams, so it is compatibility-limited to Pi versions exposing those classes.
If the seam is unavailable or changes shape, Calm stays visible and emits a warning rather than hiding content or changing execution.
Activity labels distinguish coordinating, active worker counts, and genuine blocking extension UI prompts awaiting input; an unanswered response note alone does not imply that work is blocked.
The display clears when no activity remains, and shutdown restores Pi's ordinary working indicator.
The coordinator gate prevents the extension from loading in worker sessions.
First delegation creates a workstream automatically; `workgraph_begin` is optional.
Workers run in visible Herdr tabs with ordinary Pi package/configuration loading and fresh context.
Worker tab labels show only bounded task text - at most 18 display characters, with readable word-boundary shortening when possible.
Native agent names retain bounded sanitized assignment text, the capability role, and a short identity suffix so repeated attempts remain distinguishable.
Use concise, semantic 1-2 word assignment IDs when practical; tab labels are display text only, while native names and stored resource IDs provide identity and recovery.
Forked coordinator workspaces use the target repository basename and a short identity suffix rather than exposing the full path or inventing a user purpose.
Workspace, tab, pane, terminal, session, and stored resource IDs remain authoritative for ownership, observation, and cleanup; display labels are never cleanup targets.
Retained states launched before task-first names remain recoverable through their stored exact resource identity, with the legacy name accepted only when that resource identity was not retained.
Read-only research and review use the existing coordinator project directory, so they observe live tracked and untracked changes without a clean-tree prerequisite or copying.
Implementation and disposable experiments use owned isolated Git worktrees; those worktrees are not operating-system sandboxes.
Read-only is an instruction and authority boundary, not a filesystem sandbox, and shared files may change while research runs.

## Conversation tools

| Tool | Purpose |
| --- | --- |
| `workgraph_research` | Delegate focused evidence gathering, or an explicitly authorized disposable experiment with effects, stopping rules, and retained artifact paths. Optional repeated attempts use policy-selected models. |
| `workgraph_implement` | Delegate one bounded maintained slice with acceptance requirements under the established human-backed intent. Independent slices may share an exact base revision. |
| `workgraph_review` | Independently inspect a retained result, artifact, exact revision, or comparison of retained results for a specified concern. |
| `workgraph_intent` | Explicitly record the coordinator's changed semantic scope against an actual retained human input receipt. |
| `workgraph_inspect` | Unified bounded inspection of overview, retained context, semantic tasks, complete assignments, outcomes/evidence/reports, coordinator judgments, and exact recovery; large content has lossless continuation handles. |
| `workgraph_control` | Suspend/resume work or cancel/steer a specific live attempt. |
| `workgraph_adopt` | Attach retained work without forking the conversation or implicitly resuming suspension. |
| `workgraph_fork` | Explicitly fork the coordinator conversation into a new no-focus Herdr workspace; workers remain tabs in their owning workspace. |
| `workgraph_complete` | Record a conclusion, evidence, and limitations after workers and owned resources settle. |
| `workgraph_models` | Inspect or explicitly change model defaults. |
| `workgraph_note` | Record, update, supersede, or resolve one batch of session-owned compact reminders for substantive human-facing answers, requested outcomes, or status awaiting a later human response. |

The coordinator interprets what a human request authorizes and chooses which independent contributions are meaningful.
Research, experiments, implementation slices, comparison, review, and integration are optional capabilities rather than a prescribed route.
Receiving a new human input records a lossless receipt but does not change an established semantic scope or make existing assignments stale.
The first authorized maintained change or disposable experiment may establish intent version 1 from a genuine retained input when the workstream still has only intent version 0.
After scope is established, delegation defaults to a real authority receipt from the current intent even when a newer input has been retained.
Its mutation response reports `authorityContext.selectedScope` and also `authorityContext.latestObservedInput` when that newer retained receipt differs, so the response does not claim that the latest input authorized the assignment.
An explicitly supplied receipt outside the current intent is rejected with direction to use `workgraph_intent`; receipt age or text never manufactures a scope revision.
Use `workgraph_intent` when the coordinator judges that retained human input changes semantic scope, without adding an approval ceremony.
Routine mutation responses show the action outcome, workstream lifecycle, aggregate counts, affected assignment/attempt/result handles, authority context when applicable, and selected model provenance without replaying unrelated history.
`workgraph_inspect` is the only normal inspection surface: use `section: overview` for remaining work, `context` for exact retained inputs and intent history, `task` for a semantic task, `assignment` for its complete delegation record, `outcome`, `evidence`, or `report` for retained worker content, `judgments` for dispositions and completion, and `recovery` for exact resource and settlement evidence.
The `context`, `assignment`, `judgments`, `outcome`, `evidence`, and `report` sections return character-bounded content with a lossless `next` handle.
An explicitly selected pending attempt has no outcome judgment; only task-level judgment selection may include sibling attempt dispositions.
Notifications include a bounded actionable outcome, including evidence, limitations, applied versus merely reported revisions, blockers, uncertainty, and retained artifact locations.
When a current attempt settles without a typed or untyped report, the retained absent result may identify a provider rate limit, native abort, or native provider error from current-generation native metadata without copying the raw provider error text into workstream state or notifications.
When artifact details are truncated, follow the `retainedArtifacts.next` handle to recover them in full.
Use the returned `next` handle to retrieve every remaining character of typed, untyped, malformed, or large report content without silently selecting an ambiguous repeated attempt.
The runtime verifies input provenance, intent versions, references, Git postconditions, and ownership; a receipt is not a semantic acceptance oracle.
Completion derives mechanical unresolved accounting and accepts one explicit reason per unresolved semantic task only; it refuses live or blocked resources and never automatically accepts evidence.
Extension notifications and worker reports do not grant authority.
The coordinator also keeps session-owned response notes independently of Calm and WorkstreamStore state.
The single `workgraph_note` tool records or updates a substantive answer, requested outcome, or status only when the coordinator judges that a later human response may matter; it is not a notebook, inbox, read detector, supervisor, delivery acknowledgment, disposition, or authority mutation.
A finalized visible assistant answer is recorded as presentation provenance when practical, while a drafted note explicitly does not prove that its answer was shown.
Only a later genuine interactive or RPC input receipt can ground resolution, and the model must cite the addressed note ids and explain its semantic interpretation.
Unrelated or partial replies leave other notes pending, operational notifications never clear notes, and superseding status retains unresolved substance and provenance without arbitrary silent caps or loss.
Reload, resume, branch navigation, and compaction preserve the session-owned unresolved state; completed workstreams do not clear it, and note state never blocks `workgraph_complete`.
The hidden context contains compact reminder lines rather than repeated full answers.
Whether a reply addresses a note remains semantic model judgment with explicit limits: visibility, delivery, idle state, and a tool call cannot establish that a human read or acknowledged an answer, and ambiguous courtesy does not require clarification merely for bookkeeping.
An explicit semantic scope revision leaves historical evidence intact and tied to its original intent, while stale maintained output cannot compose into the current intent.
An experiment retains its named artifacts before scratch files are discarded; its code is never automatically composed.

Implementation uses Local Prewalk in the same worker session: a guide inspects the assignment and makes the first edit, then the executor continues.
A bounded TODO is useful telemetry, not an artificial prerequisite for accepting a valid implementation.
Both selected models and actual message models are retained.
A maintained result that changes code requires one clean direct commit on the assigned base before composition.
A maintained result may instead report `no_change` with a reason and the inspected base revision; the isolated worktree must be independently Git-validated clean and unchanged, and no composition is performed.
Worker settlement, report validity, coordinator acknowledgment, and acceptance remain separate facts.

## Models

Call `workgraph_models` with `action: "get"` to see the effective defaults and their file path.
The four roles are `research`, `implementation.guide`, `implementation.executor`, and `review`.
A persistent change uses `action: "set"`, `role`, and `target: { model, thinking }` when the user requests a policy change.
Persistent model-policy mutation is separate from workstream semantic scope: it defaults to the latest genuine session input receipt, or uses the explicitly supplied retained receipt, and reports that authority receipt and source.
Assignment `model`, `thinking`, and implementation `executor` parameters override defaults without changing policy or the coordinator model.
Policy changes affect subsequent assignments, not already queued work.

Policy lives at `workgraph/models.json` under Pi's agent directory.
Versions 1 and 2 are read without rewriting and retain their historical role mapping.
The active version 3 policy stores the four role defaults and one ordered worker pool for optional research/review fan-out.
The default ordinary worker is Muse Spark, and pool order is a preference rather than a price or quality claim.
Explicit target overrides require a specific retained reason, and uncertain launches never trigger silent replacement.

## Recovery and inspection

Workstream state and worker sessions remain under Git's common directory, with the state path returned by the tools.
Only one runtime instance can hold a workstream lease, including within the same Pi session.
An unsuccessful adoption leaves the current attachment intact.
Expired ownership is not sufficient for takeover when the prior owner's liveness is unknown.

Suspension stops new launches and composition, while observations, evidence retention, and safe cleanup continue.
Result notifications have stable identifiers and can recur after an interrupted delivery; this is not an exactly-once transport.
The runtime records successful enqueue as delivery, but Pi exposes no supported selective cancellation or presentation/inspection receipt for one queued follow-up.
The notice therefore describes retained-result availability, not new outstanding work; it may appear after inspection or workstream completion and must not cause reprocessing or reopening solely because it surfaced.
After a notification failure, inspect the result through `workgraph_inspect` or reattach; notification recurrence is not new work and does not require acknowledgement or disposition.
The runtime does not repeatedly wake the coordinator on every poll.
Completion always refuses unfinished or blocked owned work and derives exact structured accounting for unresolved assignments, attempts, results, and undelivered results from current state.
The coordinator supplies one explicit reason by semantic task for actual unresolved exceptions; unknown or missing reasons are rejected.
A blocked boundary is recoverable only through the guarded coordinator recovery operation after exact native and Git inspection.
A conflicting implementation may be explicitly retained-not-applied under an owned reachable ref and reason, but is not reported as composed.
Routine completion does not require acknowledgement or disposition; inspection is read-only and semantic acceptance remains a separate coordinator judgment.
Blocked work is preserved for inspection rather than force-deleted.

`workgraph_control` supports guarded `recover` for an inspected transient cleanup or composition failure, and `retain_not_applied` with an exact integrated revision and reason for a deliberately un-applied conflicting commit.
Use a semantic task handle for control; repeated attempts require an explicit attempt handle and never silently select one.
Repeated inspections preserve delivery provenance and expose exact native, resource, cleanup, Git, applied-versus-reported revision, blocker, and uncertainty evidence.

The CLI provides read-only state inspection and explicit conversation forking:

```bash
pi-workgraph status --state STATE_PATH
pi-workgraph status --run-id ID --registry REGISTRY_PATH
pi-workgraph fork --parent-session-file SESSION_PATH --target-cwd REPOSITORY
```

CLI results are JSON; failures exit nonzero.
Historical state is inspected as uninterpreted JSON, without automatic migration or mutation.
The active runtime uses workstream format version 4; earlier versions are not silently adopted.
Default shared research evidence describes live working files rather than an immutable committed snapshot.
An explicit base revision is exact Git evidence; an exact-revision review must inspect that commit with Git rather than treating current working files as the revision.

## Runtime and persistence ownership

Effect `4.0.0-rc.112` is a runtime dependency used for structured lifecycle, concurrency, timing, configuration, and typed failures.
`WorkstreamRuntime` owns one scoped Effect `ManagedRuntime`, its serialized operation queue, lease lifetime, heartbeat, reconciliation fibers, and shutdown.
The `processEffect` adapter owns child acquisition, bounded output, timeout, interruption, and release, while `runProcess` preserves the outward Promise contract used by Git and Herdr callers.
`WorkstreamStore` owns validated workstream files, serializes mutations with an Effect semaphore, and publishes updates by atomic replacement; `WorkgraphRegistry` remains the SQLite owner of the workstream index and fenced leases.
Promise-returning Pi, Herdr, Git, and store APIs are compatibility boundaries around those owners rather than a second lifecycle system.

## Source-checkout development and live verification

These commands are checkout-only development tooling and are not included in the published package.

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck
pnpm pack --dry-run
pnpm smoke:herdr
pnpm smoke:coordinator
```

The root `packageManager` field and lockfile pin pnpm to `11.25.0`; local development and GitHub Actions use that same pin.
The project pins `@syzom/typescript-quality` to `0.2.0` and extends its shared Biome, base TypeScript, and root-spread Effect Oxlint configurations while retaining project-owned source selection and exceptions.
Development quality preparation runs `effect-tsgo patch --oxlint --no-typescript` as the first step of `pnpm quality` and `pnpm check` after devDependencies are installed, not as a published-package install requirement.
The optional `msgpackr-extract` native build is explicitly allowed in `pnpm-workspace.yaml`; Effect still works with its JavaScript fallback when the optional native package is unavailable.
`pnpm check` is the GitHub Actions entry point and runs quality preparation, Biome with warnings rejected, the type-aware Oxlint configuration, and every deterministic `node:test` test.
Oxlint owns the full TypeScript-aware check for this source selection, while `pnpm typecheck` remains an independent `tsc --noEmit` diagnostic and is not duplicated in `pnpm check`.
Only `effecttsgo/async-function` is disabled for `test/**/*.test.ts`, where `node:test` callbacks and fake Promise adapters must preserve framework contracts; every other shared and Effect rule remains enabled.
The shared blocking policy rejects non-null assertions, assertions to `never`, and chained assertions through the configured Biome and Oxlint checks.

A natural-use verification request should state the desired outcome, constraints, and uncertainty to resolve without naming Workgraph tools, worker counts, or model panels.
The explicitly optional `pnpm smoke:natural` UX observation asks the coordinator to resolve whether a disposable parser probe is justified and, only if it is, make one authorized small change.
It checks native request settlement, the actual direct or delegated strategy, exact bytes, retained outputs when present, and independent isolated worktree, branch, and workspace absence.
A natural pass is evidence of caller usability only and is never a substitute for the fixed capability scenario's lifecycle, composition, or model-transition coverage.
`pnpm pack --dry-run` verifies the published file list but not dependency resolution or executable startup in an installed consumer; [VERIFICATION.md](VERIFICATION.md) gives the disposable packed-consumer check.

Run live scenarios only from a Herdr-managed pane, against a clean committed candidate when the scenario itself requires composition.
Shared research is separately expected to start with local tracked or untracked changes and leave those bytes untouched after native worker closure and retry.
`smoke:herdr` starts idle Pi sessions without harness prompt submissions and checks native parent/fork identity, a distinct no-focus coordinator workspace, child tab-scoped workers, cleanup refusal for mismatched identity, and Herdr closure before Git removal.
It does not claim to measure provider-side model requests.
`smoke:coordinator` submits one authorized request through a normal visible Pi coordinator and observes automatic handling of research, experiment retention/non-composition, implementation with guide/executor messages, concurrent research, review launched against the exact implementation revision, and resource cleanup.
It requires authenticated configured models and does not supply later approval or progress nudges.
Before either model-driven scenario submits its request, it prints and privately records selected models and the expected attempt shape without imposing automatic model or retry decisions.
Available usage and cost attached to native assistant messages are recorded with an explicit limitation that provider-side requests or accounting may be unavailable.

All three scenarios freeze the candidate with Git archive and use a private temporary fixture, copied authentication/model configuration, isolated `PI_CODING_AGENT_DIR`, and the installed Herdr integration.
The integration defaults to `extensions/herdr-agent-state.ts` under the source Pi agent directory; set `PI_WORKGRAPH_HERDR_EXTENSION` if it is installed elsewhere.
`PI_WORKGRAPH_COORDINATOR_MODEL` overrides only the fixture coordinator selection, and `PI_WORKGRAPH_SMOKE_TIMEOUT_MS` overrides the capability scenario's 30-minute deadline.
No trust settings or approval bypass flags are supplied.
Successful scenarios verify exact checkpointed workspace absence, remove only copied agent credential/configuration files, and retain private sessions and useful evidence.
Failures retain checkpointed exact handles, diagnostics, copied files needed by potentially live agents, and explicit identity-aware cleanup instructions instead of deleting uncertain work.
These private directories can contain credentials after a failed or interrupted run and must not be published wholesale.

The package skill supplies Workgraph-specific coordination guidance, not a replacement for design or verification methodology.
[VERIFICATION.md](VERIFICATION.md) records durable local evidence boundaries; executable commands own the checks.
