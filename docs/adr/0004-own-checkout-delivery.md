---
status: accepted
---

# Own checkout delivery

A Coordinator checkout previously ended at an accepted branch-backed worktree. Local integration, merged-PR reconciliation, and removal of Workgraph-owned branches and worktrees were manual delivery steps. Interrupted effects had no durable authorization or proof, so the Coordinator could not continue safely without reconstructing prior actions.

## Decision

Persist one current checkout record for each exact Coordinator session and repository. Explicit `workgraph_checkout` allocation creates or adopts the record. Explicit `workgraph_deliver` route selection authorizes local delivery, GitHub pull-request delivery, or preservation; opening or resuming a session never performs delivery effects.

The record contains the original attached destination, accepted revision, selected route, and only the prepared or observed revisions needed to distinguish an absent effect from a completed one. Repeating delivery continues that recorded route. Changed or ambiguous ownership blocks without repair.

Local delivery prepares one deterministic advancement, advances through native fast-forward machinery, proves the result, then removes the exact clean owned worktree and branch after Worker and Candidate dependencies settle. Pull-request delivery verifies the accepted published head and configured GitHub remotes, observes the actual merge result, integrates the current base, conditionally deletes only the unchanged published head, then uses the same local cleanup. `follow_pr` remains an independent observer; it supplies no delivery proof or authority.

Git primitives, Candidate custody, and Coordinator checkout custody have separate module owners. They share scoped Git execution, ancestry, ref, and worktree-registration primitives rather than a generic lifecycle abstraction.

## Consequences

Delivery no longer returns routine cleanup bookkeeping to the Maintainer after route selection. Its explicit call may be retried after interruption, while startup remains read-only. Squash and rebase delivery use the forge's actual merged result rather than source ancestry.

The SQLite store gains an additive checkout table under the existing schema version. Older version-one databases create it lazily on the first checkout checkpoint; there is no general migration framework.

The supported PR topology is deliberately narrow: the publication remote must identify the PR head repository, and exactly one configured fetch remote must identify its base repository. Unsupported, changed, or ambiguous topology preserves resources.
