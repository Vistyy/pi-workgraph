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

Consultation keeps its enricher and advisor phases under one attempt. The enricher's strict bounded packet is retained before its worker closes; the advisor then receives that frozen packet in a fresh session, without the enricher transcript. A configured policy advisor is skipped only when no remote submission is possible/proven and the exact generation/target has a local `missing_model`, `missing_credentials`, or `unsupported_thinking` preflight result, or a trusted provider marker explicitly records that target as unavailable and not submitted. The retained target and reason appear in fallback history and the final warning; a bare not-submitted observation, generic launch error, missing resource, or mismatched/malformed/contradictory evidence is not enough. Settlement-time provider unavailability still requires clean phase closure before advancing. Once submission may have occurred, an error, timeout, interrupt, absent marker, or contradictory marker is uncertain: do not retry or fall through, and preserve the exact advisor session/resource evidence for inspection. An exact per-assignment advisor override never falls through.

Suspension preserves work and evidence while stopping new launches and application. Adoption requires the previous owner's death to be established; an expired lease alone is insufficient, and adoption does not resume suspension.

Worker closure, output retention, and semantic completion are separate. A successful clean isolated attempt persists its report and exact Git identity before its checkout is compacted; changed implementations and advanced disposable experiments retain only their exact branch, while zero-commit experiments, no-change, and read-only output remove their temporary branch. A failed, cancelled, malformed, dirty, moved, foreign, or uncertain placement remains available and blocks completion until explicit exact-attempt release; after semantic completion, only useful branch output remains releasable.
Use `workgraph_control` with the exact `attempt` for application, cancellation, steering, or release. Application derives the source and expected root from the retained candidate branch; steering takes an `instruction`, and release requires its destructive `reason`. The tool's action-specific schema defines the required fields. A retained maintained candidate can be corrected with `workgraph_implement` and `candidateOf`; the correction records its exact parent and carries the complete direct history without requiring the parent's checkout. If a cleanup response is interrupted after worktree removal, retry only after inspecting the exact branch and persisted cleanup checkpoint. If the destination moved, use an explicit integration candidate with the freshly observed exact `baseRevision`; do not apply a moved candidate or silently cherry-pick only its tip.
