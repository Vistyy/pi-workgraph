# Pi Workgraph

Pi Workgraph is a playbook-guided local orchestrator for consequential repository work.
It keeps one user-facing coordinator conversation while bounded discovery, isolated implementation, exact-revision product verification, and responsibility-specific assurance run in inherited Pi session forks.

This repository is a near-final local prototype rather than an unattended production service.
Its supported boundary is one clean local Git repository and one active Workgraph per coordinator session.
It has no PStack runtime dependency.

## Try it

Install dependencies and run the deterministic gate:

```bash
pnpm install
pnpm check
```

Run Pi from the Git repository you want to change and load this package:

```bash
pi -e /absolute/path/to/pi-workgraph
```

Describe the desired outcome normally.
For an explicit trial, ask Pi to use Workgraph end to end.
The target repository must have a clean worktree, the parent Pi session must be persistent, and assigned models must be authenticated.

## Lifecycle

```text
playbook selection
  -> bounded discovery
  -> implementation agreement
  -> implementation DAG and exact commit composition
  -> composed-product verification
  -> behavior, structure, and evidence assurance
  -> Luna synthesis
  -> Sol coordinator judgment
  -> completion, bounded correction, or one authority-changing decision
```

The implementation graph contains only implementation nodes.
Discovery, verification, and assurance remain structured lifecycle operations rather than arbitrary mixed node kinds.

The coordinator keeps its normal Pi tools for the entire run.
Workgraph does not call `setActiveTools`, remove coordinator tools, or intercept coordinator mutation tools.
The injected policy tells the coordinator to establish agreement before substantial product implementation while preserving a stable tool inventory for provider prompt-prefix caching.

## Playbooks

`workgraph_playbook` lists or loads Workgraph's own playbooks.
The catalog currently contains 16 playbooks in four families:

- Understand includes Investigation, Runtime forensics, and Trace forensics.
- Decide includes Prototype, Architecture, Arena, and Eval.
- Change includes Bug fix, Feature, Refactoring, Performance, and Visual parity.
- Operate includes Autonomous run, Pause safely, Session pickup, and Figure it out.

Each playbook defines a completion predicate, orchestration choices, evidence requirements, failure behavior, and explicit step contracts.
The selected playbook, completion predicate, ordered steps, completed steps, and skip reasons are durable run state.
`workgraph_progress` records a completed step or an explicit skip with a reason.
Assurance cannot begin while a selected playbook step remains pending.

## Discovery and synthesis

`workgraph_discover` requires one declared topology:

- `partition` assigns distinct responsibilities that together cover a question.
- `replicate` sends the same consequential question to a bounded heterogeneous model panel.
- `evidence` assigns distinct source categories when code, history, runtime, or external authority must be reconciled.

Every requested lane records its model, thinking level, child session, usage, report, and terminal state.
Unavailable models become explicit dropouts before process launch.
Failed, timed-out, cancelled, unavailable, and superseded lanes remain visible instead of silently shrinking the fan-out.
A later discovery call can replace a failed lane or add another method before agreement.

The Sol coordinator ordinarily synthesizes discovery directly.
For substantial fan-out, `workgraph_synthesize` gives two to five completed reports to one bounded synthesis child and records the resulting convergence, disagreement, evidence, and unknowns report.

## Model policy

Workgraph owns its model policy at:

```text
~/.pi/agent/workgraph/models.json
```

`workgraph_models` reads or updates one role without reading PStack configuration.
Missing roles inherit package defaults.
The initial defaults are:

- Partitioned discovery uses `opencode-go/muse-spark-1.3-contributor` with high thinking.
- Evidence discovery uses `opencode-go/muse-spark-1.3-contributor` with high thinking.
- Replicated discovery draws from Muse Spark, `openai-codex/gpt-5.6-terra`, `opencode-go/glm-5.3-flash`, and `opencode-go/deepseek-v4-flash`, all with high thinking.
- Discovery synthesis uses `openai-codex/gpt-5.6-sol` with high thinking.
- Local Prewalk uses `openai-codex/gpt-5.6-sol` as guide and `openai-codex/gpt-5.6-luna` as executor, both with high thinking.
- Product verification initially uses Muse Spark with high thinking.
- Behavior, structure, and evidence assurance initially use DeepSeek V4 Flash, Muse Spark, and GLM 5.3 Flash respectively, all with high thinking.
- Assurance synthesis uses `openai-codex/gpt-5.6-luna` with high thinking.

The assurance-role defaults are provisional and independently configurable.
The default replicated order keeps Muse Spark first because cost is material when models provide comparable results under the user's supplied pricing relationship.
Operations can override their assigned model and thinking level.

## Agreement and worker briefs

`workgraph_agree` presents one complete approval checkpoint through Pi's TUI or RPC UI.
The checkpoint records outcome, non-goals, reuse, ownership, scale, verification boundary, commands, verification method, procedure, required evidence, and unresolved decisions.
Implementation cannot start before approval or while a material decision remains unresolved.

Every implementation node receives a bounded brief with these fields:

- `GOAL` states the owned outcome.
- `SCOPE` is enforced through repository-relative claimed path prefixes.
- `CONTEXT` points to required decisions and upstream reports.
- `ACCEPTANCE` lists observable completion conditions.
- `VERIFY` lists node commands or procedures.
- `TIMEBOX` limits wandering and sets the child timeout.
- `FORBIDDEN` states prohibited operations and changes.
- `REPORT` states the terminal result contract.

Dependencies are ordering edges and context relays.
Workers do not receive the full playbook library and cannot recursively delegate.

## Implementation and correction

`workgraph_execute` schedules dependency-ready nodes with non-overlapping path claims.
Each ordinary node starts in an isolated Git worktree and inherited parent-session fork.
The Sol guide inspects local context, records bounded TODOs, and makes the first successful edit.
The same session then switches to the Luna executor, which completes the brief, verifies, creates one commit, and reports.

The scheduler independently checks worktree cleanliness, direct commit parentage, single-commit scope, changed paths, and node commands.
It composes exact commits in stable node-identifier order.
A conflicting cherry-pick is aborted without silent resolution.

Routine failures can be superseded by bounded replacement nodes inside the approved envelope.
A local accepted assurance finding can use `continuationOf` to fork the original implementer session into a fresh worktree based on the current composed commit and start directly in executor mode.
Cross-node findings become new correction or integration nodes.
Envelope-changing findings return to the serialized user agreement boundary.

## Product verification

The agreement selects `commands` or `independent` verification before implementation.
Composed-root commands always run first.
Command verification is sufficient only when those commands directly observe the agreed behavior boundary.

For interactive, visual, performance, judgment-laden, or otherwise unobserved behavior, execution enters `awaiting_verification`.
`workgraph_verify` starts an independent product verifier against the composed repository.
The verifier may run product-driving shell procedures but cannot use edit or write tools and must leave product files clean.
Its report can retain screenshot, browser state, console, network, trace, profile, command, and stored-value pointers.

Product evidence is keyed to the exact composed commit.
Workgraph checks repository cleanliness and exact `HEAD` before and after product verification and again before assurance and final judgment.
Unattributed repository state returns to `needs_decision` instead of being mistaken for composed work.
Scheduling a later node deletes prior assurance, reruns composed commands, and requires affected product verification again.
Implementation-worker evidence remains provisional until the composed result is observed.

## Assurance and final judgment

`workgraph_assure` runs one reviewer for each responsibility:

- Behavior covers realistic correctness, integration, failures, concurrency, recovery, security, and performance where relevant.
- Structure covers deletion, smallest coherent scope, types, ownership, boundaries, abstractions, reader load, and maintainability.
- Evidence covers whether artifacts and retained checks prove distinct consequential invariants without duplicate or implementation-detail test burden.

Reviewers receive no issue quota, and approval with no findings is valid.
A candidate finding must contain a violated invariant, concrete evidence, reachable scenario, material consequence, simplest response, confidence, envelope impact, complexity effect, and optional owning node.

Luna synthesizes all candidates without inventing or changing them.
It must account for each candidate exactly once as accepted, optional, or dismissed with a reason.
`workgraph_judge` then records the Sol coordinator's final disposition of every candidate.
No accepted findings completes the run, accepted internal findings produce bounded correction work, and accepted envelope-changing findings require a user decision.

## Durable state and recovery

Run state is stored at:

```text
<git-common-dir>/pi-workgraph/runs/<run-id>/state.json
```

Worker session files are stored beside that state.
Worktrees are created outside the target checkout under a sibling `.pi-workgraph-worktrees` directory.
Successful worktrees and branches are removed after composition.
Failed, escalated, or uncertain worktrees remain available for inspection.

The parent session stores a branch-aware pointer to the active state file.
Resume restores the active run and reconciles interrupted implementation, product verification, or assurance state before retrying.
Recovery can consume a terminal child report, validate and compose a worker commit, attribute one cherry-pick that landed before its state update, reuse a clean worktree created in the pre-state-write crash window, recover exact-revision verification, and preserve completed assurance reviews while retrying only failed or inconclusive responsibilities or synthesis.
Recovery does not reattach to an operating-system process.

State version 2 is intentionally not compatible with prototype state version 1.
An unsupported state file is preserved and reported rather than migrated or overwritten.

## Verification

```bash
pnpm check
pnpm smoke:real
pnpm smoke:coordinator
```

`pnpm check` is deterministic and does not call a model.
`pnpm smoke:real` exercises the engine, heterogeneous discovery, Local Prewalk, Git composition, composed-root evidence, three assurance responsibilities, Luna synthesis, and coordinator judgment in a disposable repository.
`pnpm smoke:coordinator` starts Pi in RPC mode and exercises the user-visible tools, one approval prompt, implementation, assurance, and final judgment.
Both smoke commands remove their disposable repositories after completion.
Set `PI_WORKGRAPH_KEEP_SMOKE=1` to retain the direct engine smoke fixture and child sessions.

See [VERIFICATION.md](VERIFICATION.md) for the retained evidence and its limits.

## Deferred scope

This implementation does not create, monitor, ship, or merge pull requests.
It does not integrate Herdr, remote workers, live panes, a dashboard, daemon supervision, recursive delegation, a general workflow language, or hundred-agent program machinery.
Child execution is not live-observable beyond coordinator progress updates, but sessions, reports, models, usage, worktrees, commits, and evidence remain inspectable afterward.
