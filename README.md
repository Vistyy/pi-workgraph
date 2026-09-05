# Pi Workgraph

Workgraph coordinates bounded repository work within a normal Pi conversation.
Research, disposable experiments, maintained implementation, and selective review are capabilities, not phases of a mandatory pipeline.

## Run

Use Node.js 24 or newer, Git, Pi, and a Herdr-managed pane with Herdr's Pi state integration installed.
The current integration is checked against Pi 0.84.4 and Herdr 0.8.2.

```bash
pnpm install
pi -e /absolute/path/to/pi-workgraph
```

Start from the project directory and ask the coordinator to delegate the needed work.
Composition still requires a clean destination at the maintained-application boundary.
First delegation creates a workstream automatically; `workgraph_begin` is optional.
Workers run in visible Herdr tabs with ordinary Pi package/configuration loading and fresh context.
Read-only research and review use the existing coordinator project directory, so they observe live tracked and untracked changes without a clean-tree prerequisite or copying.
Implementation and disposable experiments use owned isolated Git worktrees; those worktrees are not operating-system sandboxes.
Read-only is an instruction and authority boundary, not a filesystem sandbox, and shared files may change while research runs.

## Conversation tools

| Tool | Purpose |
| --- | --- |
| `workgraph_research` | Delegate focused evidence gathering, or an explicitly authorized disposable experiment with effects, stopping rules, and retained artifact paths. Optional repeated attempts use policy-selected models. |
| `workgraph_implement` | Delegate one bounded maintained slice with acceptance requirements and human-backed intent. Independent slices may share an exact base revision. |
| `workgraph_review` | Independently inspect a retained result, artifact, exact revision, or comparison of retained results for a specified concern. |
| `workgraph_intent` | Record changed scope against an actual retained human input receipt. |
| `workgraph_status` | Inspect a compact view of assignments, selected models and reasons, findings, evidence, uncertainty, delivery, and resource recovery. |
| `workgraph_acknowledge` | Optionally record that evidence was actually read after a transport interruption. It is not required for ordinary result use. |
| `workgraph_disposition` | Optionally record explicit coordinator judgment of retained evidence. Presentation and validity do not imply acceptance. |
| `workgraph_control` | Suspend/resume work or cancel/steer a specific live attempt. |
| `workgraph_adopt` | Attach retained work without forking the conversation or implicitly resuming suspension. |
| `workgraph_fork` | Explicitly fork the coordinator conversation into a new no-focus Herdr workspace; workers remain tabs in their owning workspace. |
| `workgraph_complete` | Record a conclusion, evidence, and limitations after workers and owned resources settle. |
| `workgraph_models` | Inspect or explicitly change model defaults. |

The coordinator interprets what a human request authorizes and chooses which independent contributions are meaningful.
Research, experiments, implementation slices, comparison, review, and integration are optional capabilities rather than a prescribed route.
Routine coordinator responses show concise purpose, assignment and result outcomes, lifecycle, actionable attention, model selection reasons, and bounded effective-model transitions with counts.
Focused result retrieval retains substantive findings, evidence, uncertainty, and recovery attention.
The runtime verifies input provenance, intent versions, references, Git postconditions, and ownership; a receipt is not a semantic approval oracle.
Extension notifications and worker reports do not grant authority.
New constraints leave historical evidence intact and tied to its original scope, while stale maintained output cannot compose into the current intent.
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
After a notification failure, read the result through status or reattach; acknowledgment remains available as an explicit receipt but is not needed to use the result.
The runtime does not repeatedly wake the coordinator on every poll.
Completion always refuses unfinished or blocked owned work and requires one exact structured accounting entry with an explicit reason for every unresolved assignment, attempt, result, and undelivered result; unknown or extra accounting identities are rejected. A blocked boundary is recoverable only through the guarded coordinator recovery operation after exact native and Git inspection. A conflicting implementation may be explicitly retained-not-applied under an owned reachable ref and reason, but is not reported as composed.
Routine completion does not require acknowledgment or disposition; focused presentation is the transport receipt and those remain separate optional facts.
Blocked work is preserved for inspection rather than force-deleted.

`workgraph_control` supports guarded `recover` for an inspected transient cleanup or composition failure, and `retain_not_applied` with an exact integrated revision and reason for a deliberately un-applied conflicting commit. Repeated result reads preserve the first delivery timestamp and retain failed-wake history. Status and result views are bounded, count their history, provide continuation offsets, and expose accounting and retained-not-applied reasons.

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

## Development and live verification

```bash
pnpm check
pnpm pack --dry-run
pnpm smoke:herdr
pnpm smoke:coordinator
```

A natural-use verification request should state the desired outcome, constraints, and uncertainty to resolve without naming Workgraph tools, worker counts, or model panels.
The runnable `pnpm smoke:natural` fixture asks the coordinator to resolve whether a disposable parser probe is justified and, only if it is, make one authorized small change, then checks native request settlement, the actual direct or delegated strategy, exact bytes, retained outputs when present, and cleanup.
This natural procedure is evidence of caller usability, while the deterministic smoke remains a protocol check of identity, retention, composition, and cleanup boundaries.
`pnpm check` owns full TypeScript checking, Biome formatting/recommended lint, targeted assertion checks, and deterministic tests.
The assertion check uses the already-installed TypeScript parser to reject type laundering through `unknown` and assertions to `never`, while permitting legitimate unknown inputs, ordinary narrowing, and `as const`.
Non-null assertions are not blanket-banned; their correctness depends on the enforced boundary.

Run live scenarios only from a Herdr-managed pane, against a clean committed candidate when the scenario itself requires composition.
Shared research is separately expected to start with local tracked or untracked changes and leave those bytes untouched after native worker closure and retry.
`smoke:herdr` starts idle Pi sessions without submitting model prompts and checks native parent/fork identity, a distinct no-focus coordinator workspace, child tab-scoped workers, cleanup refusal for mismatched identity, and Herdr closure before Git removal.
`smoke:coordinator` submits one authorized request through a normal visible Pi coordinator and observes automatic handling of research, experiment retention/non-composition, implementation with guide/executor messages, concurrent research, exact-revision review, and resource cleanup.
It requires authenticated configured models and does not supply later approval or progress nudges.

Both scenarios freeze the candidate with Git archive and use a private temporary fixture, copied authentication/model configuration, isolated `PI_CODING_AGENT_DIR`, and the installed Herdr integration.
The integration defaults to `extensions/herdr-agent-state.ts` under the source Pi agent directory; set `PI_WORKGRAPH_HERDR_EXTENSION` if it is installed elsewhere.
`PI_WORKGRAPH_COORDINATOR_MODEL` overrides only the fixture coordinator selection, and `PI_WORKGRAPH_SMOKE_TIMEOUT_MS` overrides the capability scenario's 30-minute deadline.
No trust settings or approval bypass flags are supplied.
Successful scenarios verify exact workspace absence and retain their evidence directory.
Failures retain diagnostics and resources for identity-aware reconciliation instead of deleting uncertain work.
These private directories may contain copied credentials and must not be published wholesale.

The package skill supplies Workgraph-specific coordination guidance, not a replacement for design or verification methodology.
[VERIFICATION.md](VERIFICATION.md) records durable local evidence boundaries; executable commands own the checks.
