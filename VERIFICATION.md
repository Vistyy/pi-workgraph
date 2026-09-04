# Pi Workgraph verification

The accepted result is the explicit outcome contract and its observed terminal operation.

## Required checks

Run `pnpm check` to type-check the runtime and execute deterministic tests.

Run `pnpm pack --dry-run` to verify that the package contains the executable fallback, runtime sources, extensions, skills, and current documentation.

Run `pnpm smoke:herdr` when Herdr 0.8.2 is available inside a Herdr-managed pane.

Run `pnpm smoke:real` and `pnpm smoke:coordinator` from that environment when the configured models are authenticated.

The deterministic tests cover answer, decision, operation, and product-change outcomes, milestone persistence, agreement and plan gating, isolated composition, recovery, visible worker control, lifecycle transitions, evidence routing, assurance, package metadata, and implementation report behavior when optional Local Prewalk telemetry is absent.

## Evidence boundary

Direct evidence crosses the required product boundary.

Inference records reasoning that is not a direct observation.

Conflicts and unknowns remain explicit and cannot be treated as success.

Product verification is tied to the exact composed revision named by the run.

Product verification prefers repository-native harnesses, then a project-local verification skill, then Workgraph-owned browser or CLI/TUI control guidance.

A missing required control surface is inconclusive.

The live Herdr smoke creates a disposable repository, isolated registry, and new workspace.

It verifies unnamed current-session rebind and records exact Herdr cleanup before Git worktree cleanup for a live worker.

The real smoke requires typed reports from replicated discovery, concurrent visible implementation, and assurance, and it verifies durable coordinator wakes, exact composition, command verification, final judgment, and cleanup for every attempt.

It fails promptly with node and attempt diagnostics if execution becomes idle while implementation work remains failed or escalated.

The coordinator smoke loads the candidate extension in an isolated Pi RPC process, supplies only an initial request and the exact approval reply, and requires automatic wake-driven continuation through independent verification, assurance, and judgment.

Each smoke verifies that only its root tab remains before closing its exact disposable workspace.

## Limits

Evidence covers the local supported Node.js, Pi, Git, Herdr 0.8.2, and configured-model environment.

It does not establish arbitrary provider, operating-system, repository, or interactive-control behavior.

Workers are isolated Git worktrees rather than operating-system sandboxes.

The command fallback does not replace Pi's normal package loading or coordinator conversation.
