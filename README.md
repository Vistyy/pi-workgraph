# Pi Workgraph

Pi Workgraph is an agreement-gated local orchestrator for consequential repository changes.
It keeps one user-facing coordinator conversation while read-only discovery, isolated implementation, composition, and assurance run in inherited Pi session forks.

This repository is a working prototype rather than a production unattended service.
Its supported boundary is one clean local Git repository and one active Workgraph per coordinator session.

## Try it

Install dependencies in this package:

```bash
pnpm install
pnpm check
```

Run Pi from the Git repository you want to change and load the package without installing it globally:

```bash
pi -e /absolute/path/to/pi-workgraph
```

Describe the desired outcome normally.
The coordinator policy directs Pi to use Workgraph when the request is materially ambiguous or structurally consequential.
For an explicit trial, ask Pi to "use Workgraph end to end" for the request.

The target repository must have a clean worktree, the parent Pi session must be persistent, and the selected guide and executor models must be authenticated.
The default executor is `openai-codex/gpt-5.6-luna` when the coordinator uses `openai-codex/gpt-5.6-sol`; otherwise the executor defaults to the coordinator model.

## User-visible flow

```text
request
  -> parallel read-only discovery
  -> one implementation-envelope confirmation
  -> isolated workers and automatic clean composition
  -> read-only assurance
  -> concise result or one authority-changing decision
```

The confirmation includes the outcome, non-goals, reuse decision, structural ownership, expected scale, verification boundary, verification commands, and unresolved decisions.
Implementation cannot start while an unresolved decision remains or until the confirmation is accepted through Pi's TUI or RPC UI.

## Runtime behavior

`workgraph_begin` records the run under the repository's Git common directory and activates the coordinator write gate.
The gate removes `edit` and `write` and permits only a narrow set of read-only coordinator shell commands.

`workgraph_discover` forks the parent session before its unresolved orchestration tool call and runs one to five read-only investigations.
Each child receives the inherited trajectory plus its bounded objective and returns a typed report.

`workgraph_agree` serializes the initial approval and any later full-envelope revision, then records the accepted implementation envelope.
The accepted envelope permits local reversible implementation decisions but not changes to outcome, non-goals, ownership, public interfaces, dependencies, security guarantees, scale, or the reuse decision.

`workgraph_execute` schedules dependency-ready nodes with non-overlapping claimed path prefixes.
After recovery, an empty node list resumes already-recorded pending nodes.
A routine failed node enters `revision_required` and may be superseded inside the existing envelope without another human checkpoint.
A semantically escalated node requires a revised agreement before its replacement, and pending dependents are rewired to the replacement.
Each node starts in its own Git worktree and inherited Pi session.
The guide model must inspect the worktree, record bounded TODOs, and make the first edit through `edit` or `write`.
After that successful edit, the worker extension removes the transient guide instruction and switches the same session to the executor model.
The executor must finish, verify, create exactly one commit, leave a clean worktree, and emit a typed report.
The scheduler independently checks the commit parent, changed paths, clean state, and verification commands.
It cherry-picks successful commits in stable node-identifier order and aborts a conflicting cherry-pick without silently resolving it.

`workgraph_assure` gives a read-only reviewer the approved envelope, composed diff coordinates, node evidence, and scheduler-owned composed-root verification records.
An error inside the envelope produces `revision_required`, so the coordinator can add bounded corrective nodes.
A finding that changes the envelope produces `needs_decision`, so affected work stops for the user.

`workgraph_status` reads the durable run state, including node states, child sessions, commits, composition records, verification evidence, and pending decisions.

## Durable state

Run state is stored at:

```text
<git-common-dir>/pi-workgraph/runs/<run-id>/state.json
```

Worker session files are stored beside that state.
Worktrees are created outside the target checkout under a sibling `.pi-workgraph-worktrees` directory.
Successful worktrees and branches are removed after composition.
Failed or escalated worktrees remain available for inspection.

The parent session stores a branch-aware pointer to the active state file.
Resuming that session restores the coordinator gate and reconciles an interrupted `executing` phase before further work.
Recovery can consume a terminal child report, validate and compose the resulting commit, attribute one cherry-pick that landed before its state update, and return remaining pending nodes to the approved phase.
Recovery does not reattach to a still-running operating-system process.
A running node without a terminal report becomes an escalation whose retained worktree and child session must be inspected before a replacement node supersedes it.

## Verification

```bash
pnpm check
pnpm smoke:real
pnpm smoke:coordinator
```

`pnpm check` is deterministic and does not call a model.
`pnpm smoke:real` exercises inherited discovery, two parallel worktrees, Local Prewalk model switching, exact composition, composed-root checks, and assurance with configured models.
`pnpm smoke:coordinator` starts Pi in RPC mode, sends an organic request through the coordinator extension, answers the single approval prompt, and verifies the full user-visible path.
Both smoke commands create disposable repositories and remove them after completion.
Set `PI_WORKGRAPH_KEEP_SMOKE=1` for `smoke:real` when the disposable repository and child sessions must remain available for diagnosis.

See [VERIFICATION.md](VERIFICATION.md) for the retained evidence and its limits.
