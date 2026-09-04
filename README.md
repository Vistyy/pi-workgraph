# Pi Workgraph

Pi Workgraph is a durable local orchestrator for consequential repository work.

It keeps one coordinator conversation while discovery, isolated implementation, exact-revision verification, assurance, and lifecycle recovery are recorded in the repository's Workgraph state.

## Use the Pi package

Install dependencies and run the deterministic checks.

```bash
pnpm install
pnpm check
```

Run Pi from the repository you want to change and load this package.

```bash
pi -e /absolute/path/to/pi-workgraph
```

Start a run with `workgraph_begin` when the request has material ambiguity or structural consequence.

The run records an outcome kind, outcome statement, completion predicate, optional milestones, plans, attempts, evidence, and final judgment.

The coordinator remains a normal Pi session with its configured tools, extensions, skills, and prompt templates.

Worker sessions are ordinary Pi sessions launched in visible Herdr panes with an isolated Git worktree.

A worker reports one typed terminal result, and the supervisor records its Herdr identity, session, model provenance, timing, heartbeat, and resource cleanup state.

Product-change execution requires a conversational agreement and an approved versioned plan before delegated writes.

There is no modal approval dialog and no hidden worker fallback.

## Command fallback

The `pi-workgraph` executable exposes the same durable registry, state, Git, session, and Herdr services when a Pi tool call is not convenient.

```bash
pi-workgraph status --run-id RUN_ID
pi-workgraph adopt --run-id RUN_ID --session-id SESSION_ID --session-file SESSION_FILE
pi-workgraph fork --parent-session-file SESSION_FILE --target-cwd PATH --workspace WORKSPACE_ID
pi-workgraph suspend --run-id RUN_ID --reason "Pause for review"
pi-workgraph resume --run-id RUN_ID --reason "Review complete"
pi-workgraph abandon --run-id RUN_ID --reason "Stop this run"
pi-workgraph archive --run-id RUN_ID --reason "Archive settled state"
pi-workgraph recovery --run-id RUN_ID
pi-workgraph cleanup --run-id RUN_ID
```

Use `--registry PATH` with an isolated registry and `--state PATH` when operating on a state file directly.

Command results are JSON on stdout, and command failures are JSON on stderr with a non-zero exit code.

Adoption uses the supplied current session identity and never forks a replacement session.

Forking requires a visible Herdr workspace and starts a normal Pi coordinator with the selected conversation branch and target working directory.

## Skills

The package exposes composable Workgraph procedure skills and Workgraph-owned verification guidance through Pi's native package manifest.

Procedure skills provide guidance only and do not own runtime state or lifecycle transitions.

Verification guidance prefers repository-native checks, then a project-local verification skill, then the appropriate live CLI, TUI, browser, or trace surface.

Unavailable required control surfaces produce inconclusive verification.

## Verification

```bash
pnpm check
pnpm pack --dry-run
pnpm smoke:herdr
pnpm smoke:real
pnpm smoke:coordinator
```

`smoke:herdr` creates a disposable Git repository, an isolated Workgraph registry, and a new Herdr workspace.

It exercises command fallback, visible coordinator identity, shell resources, worktree isolation, recovery, interruption, lifecycle, and identity-checked cleanup.

It closes only the workspace, tabs, and workers created by that invocation.

The other smoke commands exercise direct engine and coordinator package boundaries when configured models are authenticated.
