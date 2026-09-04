# Pi Workgraph implementation

Pi Workgraph provides durable outcome-driven orchestration for answers, decisions, product changes, and operations.

## Runtime boundary

A run records an explicit outcome statement and completion predicate.

Optional named milestones record task progress without owning runtime lifecycle.

Product-change outcomes retain conversational agreement, versioned plans, isolated bounded implementation nodes, deterministic exact-commit composition, exact-revision verification, assurance, and final coordinator judgment.

Non-change outcomes finish through typed evidence and a coordinator conclusion without an implementation claim.

## Child boundary

Children use ordinary Pi configuration and retain the configured tools, extensions, skills, and prompt templates.

The Workgraph package is role-aware so coordinator tools load in coordinator sessions and assignment reporting support loads in worker sessions.

Each assignment records its Pi session, terminal result, usage, model provenance, visible Herdr identity, timing, heartbeat, and cleanup state.

Workers run in Git worktrees, and authoritative Git postconditions validate implementation commits before composition.

## Control and recovery

Scheduling persists the execution intent and returns before visible workers settle.

A background supervisor launches visible Herdr workers, reconciles their observations, settles typed reports, and records uncertain results for review.

Pause defaults to draining active work, while immediate cancellation sends one Escape to the exact recorded worker and waits for a verified settled state.

Lifecycle transitions are explicit, and inactivity never abandons a run.

The Pi tools and the `pi-workgraph` command fallback use the same registry, state, session, Git, and Herdr services.

The command fallback returns machine-readable JSON results and errors for status, adoption, forking, lifecycle transitions, recovery, and cleanup.

## Guidance and evidence

Procedure skills are composable guidance and do not own runtime state or lifecycle transitions.

Workgraph verification guidance selects repository-native checks before project-local or live control surfaces.

Discovery, verification, and assurance distinguish direct evidence, inference, conflicts, and unknowns.

A missing required control surface remains inconclusive.

## Verification

The retained gates are `pnpm check`, `pnpm pack --dry-run`, `pnpm smoke:herdr`, `pnpm smoke:real`, and `pnpm smoke:coordinator`.

The deterministic suite protects outcome contracts, milestone persistence, child accounting, ordinary resource loading, exact composition, recovery, evidence routing, assurance, lifecycle, and final judgment.

The bounded Herdr smoke uses disposable resources and exact identity checks for the live runtime boundary.

The model-backed smokes exercise direct engine and coordinator package boundaries when credentials are available.
