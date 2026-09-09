# Recovery and inspection

Use this reference when operating Workgraph encounters missing evidence, interrupted operations, or ownership uncertainty. Tool descriptions own call arguments and restrictions.

## Inspect evidence

Ordinary notifications contain actionable summaries. When missing detail could change a decision, use `workgraph_inspect` and follow its `next` handle for truncated content.
Notifications can recur after inspection or completion; a repeated result ID is not new work and needs no separate coordination action.

State and worker sessions live under Git's common directory. Tools return the exact state path. For offline, read-only inspection:

```bash
pi-workgraph status --state STATE_PATH
```

Historical JSON remains inspectable without mutation. Current JSON state is read-only until explicit `workgraph_adopt` proves the prior coordinator dead; that bounded import preserves the source, requires the exact identity-derived `.sqlite` destination to be absent, and verifies the source readback. Startup reattachment never migrates a live JSON owner.

## Recover uncertain work

A failed response does not prove that nothing happened. Before retrying a launch, application, or release, inspect the retained native session, exact resource identities, and resulting Git or filesystem effects.
Recorded observations are historical evidence, not fresh proof of the current state.
If ownership or effects remain uncertain, preserve the resources and report the blocker rather than forcing cleanup or resubmitting blindly.

Consultation keeps its enricher and advisor phases under one attempt. Both phases are ordinary research workers using fresh sessions and the standard `workgraph_report`; the enricher's bounded report projection is persisted before its worker closes, then the advisor receives the question, coordinator context, and frozen projection without the enricher transcript. Policy and per-assignment configuration each provide one exact advisor target. Failed or uncertain launch/settlement remains visible; inspect the retained exact session and resource identity, and do not resubmit automatically. Only the advisor's standard research report is delivered as the consultation result.

Suspension preserves work and evidence while stopping new launches and application. Adoption requires the previous owner's death to be established; an expired lease alone is insufficient, and adoption does not resume suspension.

Worker closure, output retention, and semantic completion are separate. A successful clean isolated attempt persists its report and exact Git identity before its checkout is compacted; changed implementations and advanced disposable experiments retain only their exact branch, while zero-commit experiments, no-change, and read-only output remove their temporary branch. A failed, cancelled, malformed, dirty, moved, foreign, or uncertain placement remains available and blocks completion until explicit exact-attempt release; after semantic completion, only useful branch output remains releasable.
Use `workgraph_control` with the exact `attempt` for application, cancellation, steering, or release. Application derives the source and expected root from the retained candidate branch; steering takes an `instruction`, and release requires its destructive `reason`. The tool's action-specific schema defines the required fields. A retained maintained candidate can be corrected with `workgraph_implement` and `candidateOf`; the correction records its exact parent and carries the complete direct history without requiring the parent's checkout. If a cleanup response is interrupted after worktree removal, retry only after inspecting the exact branch and persisted cleanup checkpoint. If the destination moved, use an explicit integration candidate with the freshly observed exact `baseRevision`; do not apply a moved candidate or silently cherry-pick only its tip.
