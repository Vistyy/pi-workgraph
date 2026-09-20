---
status: accepted
---

# Own the checkout delivery lifecycle

Coordinator checkouts previously had deterministic native identity but no recorded disposition. Successful publication or integration did not settle their resources. Interrupted removal left unexplained branch collisions, while squash and rebase delivery defeated ancestry-based cleanup. Requiring the Coordinator to reconstruct those facts repeatedly left housekeeping with the user.

## Decision

Record one current checkout lifecycle per exact Coordinator session and repository in the existing SQLite store. This supersedes ADR 0001's decision that Coordinator checkouts add no database record; its schema and host-boundary decisions otherwise remain.

A selected local or pull-request route includes verified local integration and owned cleanup. Preservation pauses further effects without erasing progress. The deferred delivery capability checkpoints intent, observes native results, and resumes only recorded authority. Another session cannot take over, and no background janitor or additional PR observer is introduced.

The Coordinator still owns acceptance, sign-off handling, unpublished branch preparation, and native forge publication. Preparing the same owned unpublished branch before final acceptance avoids a second publication branch and a commit-transformation ledger. Existing observation capabilities return the Coordinator to unfinished delivery.

For a merged PR, proof connects the exact accepted head to the forge's actual merged result, then to the authorized local destination. It does not require original-commit ancestry after squash or rebase. Published-branch deletion is conditional on its exact delivered tip. Local deletion follows resource identity and verified delivery, not `git branch -d`'s ancestry heuristic.

Pi-facing delivery orchestration sequences durable checkpoints around scoped Git effects and bounded read-only GitHub queries. It shares native advancement and custody primitives with local integration, not Candidate output state. Workers and unresolved Candidate cleanup remain dependencies, not a second workflow graph.

## Consequences

Native Git state alone is no longer enough to decide whether an absent resource represents success. Known progress permits recovery; unknown or changed resources remain protected. Explicit checkout reuse may record an existing checkout only after its complete deterministic native identity is proven.

The current receipt survives completion until the next explicit allocation. Later work in the same session can start fresh from the source's current committed HEAD. This intentionally adds a small operational record rather than a cross-session resource registry, migration framework, or permanent delivery ledger.
