# Pi Workgraph verification

The accepted result is the explicit outcome contract and its observed terminal operation.

## Required checks

Run `pnpm check` to type-check the runtime and execute deterministic tests.
Run `pnpm pack --dry-run` to verify that the package contains `skills/**` and no obsolete procedure resources.
Run `pnpm smoke:real` and `pnpm smoke:coordinator` when configured models are authenticated.

Deterministic tests cover answer, decision, operation, and product-change outcomes, optional milestone persistence, agreement gating, isolated composition, exact-revision verification, recovery, assurance, trusted capability diagnostics, and native package metadata.

## Evidence boundary

Direct evidence crosses the required product boundary.
Inference records reasoning that is not a direct observation.
Conflicts and unknowns remain explicit and cannot be treated as success.
Blast-radius-sensitive changes must prove the relevant external safety fact at the dependent boundary.

Product verification prefers repository-native harnesses, then a project-local verification skill, then Workgraph-owned browser or CLI/TUI control guidance.
A missing required control surface is inconclusive.
The read-only verifier cannot create or maintain verification infrastructure.

## Limits

Evidence covers the local supported Node.js, Pi, Git, and configured-model environment.
It does not establish arbitrary provider, operating-system, repository, or interactive-control behavior.
Workers are isolated Git worktrees rather than operating-system sandboxes.
