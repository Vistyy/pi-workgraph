# Deliver an accepted repository change

Load `workgraph_load_delivery_tools`. Missing configured peer tools remain unavailable; loading tools grants no delivery authority.

## Resolve Human sign-off

Human sign-off is the Maintainer's explicit judgment that the exact accepted change may be finally integrated. Classify its requirement as `Required` when integration must wait for that judgment, or `Optional` when the Coordinator considers its evidence sufficient. Give the reason. Neither a Worker Review nor completed Maintainer inspection is Human sign-off.

When sign-off is required and `tuicr_review` is available, use it for local Maintainer inspection before recommending a route unless the user directs otherwise. Another local capability is designated only by the user. Resolve inspection feedback, reaccept the result, and repeat inspection when material changes warrant it.

Required sign-off must precede final integration. When no local inspection capability is designated, an authorized pull request may be published to seek sign-off remotely; publication is not final integration.

## Choose the complete route

Recommend local integration, pull-request delivery, or deliberate preservation. If the user has not already selected the route for this change, ask once. A repository's pull-request requirement still applies.

| Route | Authority |
| --- | --- |
| Local integration | Integrate the exact accepted revision into the authorized local destination, verify it, and clean up the owned checkout and local branch. No remote publication. |
| Pull request | Prepare and publish the accepted branch, maintain the same-scope PR, and follow it. After a verified merge, reconcile the authorized local destination and remove the owned checkout, local branch, and unchanged published branch. No agent-initiated merge or rewriting published history. |
| Preserve checkout | Deliberately retain the current checkout and its unfinished work. No integration, publication, or cleanup. |

Implementation approval is not delivery authority. Route selection does not bypass required sign-off, but it includes that route's housekeeping: do not ask again merely to update the local destination or remove completed owned resources.

## Prepare the accepted source

Keep the exact owned branch attached to the Coordinator checkout. Settle Workers and Candidate decisions that depend on its current base before changing that base.

For a PR, compare the proposed range against the intended remote base. If the checkout inherited unrelated unpublished local commits, prepare the same unpublished owned branch on the correct base using native Git. Do not create a second delivery branch or switch the managed checkout to another branch. Re-verify and reaccept the resulting complete diff before publication; a successful rebase is not acceptance. If the change depends on excluded work, resolve that dependency rather than silently omitting it.

Commit the accepted content. Preserve unaccepted or unrelated changes rather than including them to make delivery succeed. Published corrections remain non-force; rewriting published history requires a separate decision.

## Local integration

Use `workgraph_deliver` with the checkout identity, accepted revision, and selected local route. Confirm the recorded destination is the authorized one, or supply the explicit destination.

The operation owns Git preparation, integration, postcondition verification, and cleanup. Use its persisted receipt to distinguish integrated content from unfinished cleanup. Resolve a concrete blocker through inspection and, when needed, further verification before an explicit retry. Do not bypass the operation with cherry-picks, manual worktree removal, branch deletion, or detaching the original checkout.

Report the source and destination revisions, completion or the exact remaining blocker, verification evidence, and material limitations. No further cleanup approval is needed.

## Pull-request delivery

### Explain the change

Open with why the change exists and its observable result. Choose one small representation that makes the important behavior, structure, risk, or evidence clear:

| Change shape | Prefer |
| --- | --- |
| Rule or algorithm | Compact pseudocode |
| Runtime control flow | Call tree or before/after flow |
| Ownership or file responsibility | Shallow annotated file tree |
| Component structure | Component tree with relevant state and boundaries |
| Interaction or data movement | Mermaid sequence or flow diagram |
| Modification to an existing shape | Fenced `diff` |
| Rendered behavior | Comparable before/after screenshots |
| Quantitative claim | Small table with measured values |

Use prose when clearer. Include the Human sign-off classification and reason, its specific focus when required, direct verification evidence, and material limitations. Omit empty sections and implementation chronology.

Do not claim unobserved evidence, expose private paths or logs, or link media without a deliberate destination accessible to the Maintainer.

### Publish and register

Use ordinary Git and forge tools to non-force push the accepted owned branch and create or update its exact PR. Reuse an existing matching PR rather than creating a duplicate. An uncertain publication result requires inspection, not automatic resubmission.

Register the exact accepted revision, PR, remote, and authorized local destination with `workgraph_deliver`. Its verified receipt connects publication to the checkout's unfinished lifecycle. A URL or an assistant claim alone is not that receipt.

Establish observation with an available session capability. If observation is unavailable, retain the registered delivery and report that limitation; do not start another watcher or polling loop.

Hand back the complete PR URL, published revision, sign-off requirement, observation availability, and material evidence limitations. Describe this as publication, not completed delivery.

### Continue to disposition

A delivered observation returns the Coordinator to the same work and authority. Reconcile the recorded delivery with `workgraph_deliver`, which obtains the current PR facts. Review comments and other evidence remain inputs to Coordinator judgment.

For same-scope corrections, verify and accept the updated revision, non-force push the same owned branch, and update its recorded accepted head. Do not expand scope or merge the PR without separate authority.

After merge, the delivery operation verifies the exact accepted PR head and the forge's merged result, reconciles the local destination without overwriting unrelated work, and cleans up its resources. A squash or rebase merge is valid delivery even though the original commits are not ancestors of the destination. A published branch that no longer matches the delivered head is preserved, not deleted.

A PR closed without merge preserves its undelivered work. Do not interpret closure as permission to discard it.

Report the final disposition only after inspecting the receipt. If integration succeeded but housekeeping remains blocked, say so; neither publication nor a terminal PR notification alone completes the checkout lifecycle.

## Preserve or resume

Use the preserve route to deliberately retain work. It pauses further effects without erasing earlier integration or cleanup progress. Report the checkout identity, current revision and status, and why it remains open. Preservation is not a claim of delivery; continuing a paused delivery requires explicit route selection rather than reconciliation alone.

Unfinished delivery remains owned by this session. On resume, inspect its recorded state and reconcile the authorized route; do not reconstruct authority from branch ancestry or assume that a missing worktree means success. A failed or interrupted effect must be observed before another mutation.

After verified cleanup, later work in the same session starts with a fresh `workgraph_checkout` request from the intended source checkout's current committed HEAD. Do not recreate a completed checkout merely because the session resumed.
