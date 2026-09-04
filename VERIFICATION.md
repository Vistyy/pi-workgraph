# Pi Workgraph verification

The accepted result is the explicit outcome contract and its observed terminal operation.

## Required checks

Run `pnpm check` to type-check the runtime and execute deterministic tests.

Run `pnpm pack --dry-run` to verify that the package contains the executable fallback, runtime sources, extensions, skills, and current documentation.

Run `pnpm smoke:herdr` when Herdr 0.8.2 is available inside a Herdr-managed pane.

Run `pnpm smoke:real` and `pnpm smoke:coordinator` when configured models are authenticated.

The deterministic tests cover answer, decision, operation, and product-change outcomes, milestone persistence, agreement and plan gating, isolated composition, recovery, visible worker control, lifecycle transitions, evidence routing, assurance, and package metadata.

## Evidence boundary

Direct evidence crosses the required product boundary.

Inference records reasoning that is not a direct observation.

Conflicts and unknowns remain explicit and cannot be treated as success.

Product verification is tied to the exact composed revision named by the run.

Product verification prefers repository-native harnesses, then a project-local verification skill, then Workgraph-owned browser or CLI/TUI control guidance.

A missing required control surface is inconclusive.

The live Herdr smoke creates a disposable repository, isolated registry, and new workspace, records every created resource, and removes only those exact resources after verification.

## Limits

Evidence covers the local supported Node.js, Pi, Git, Herdr 0.8.2, and configured-model environment.

It does not establish arbitrary provider, operating-system, repository, or interactive-control behavior.

Workers are isolated Git worktrees rather than operating-system sandboxes.

The command fallback does not replace Pi's normal package loading or coordinator conversation.
