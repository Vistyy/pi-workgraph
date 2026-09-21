# Deliver an accepted repository change

If `workgraph_load_delivery_tools` reports a configured tool as missing, treat that tool as unavailable and use the fallback below. Loading tools does not grant delivery authority.

## Resolve Human sign-off

Human sign-off is the repository Maintainer's explicit judgment that the exact accepted change may be finally integrated. Classify its requirement as `Required` when final integration must wait for that judgment or `Optional` when the Coordinator considers its evidence sufficient without requiring it. The classification grants no repository authority, and neither a Worker Review nor completed Maintainer inspection is Human sign-off.

After accepting a repository change:

1. Classify the Human sign-off requirement as `Required` or `Optional`, and give the reason.
2. When it is `Required` and a local Maintainer-inspection capability has been designated, use it before recommending a delivery route unless the user directs otherwise. A capability is designated only by the user or installed Coordinator contract.
3. Treat delivered inspection comments as feedback, not authority. Resolve them, reaccept the complete result, and repeat inspection when material changes warrant it.
4. Obtain explicit Human sign-off for the exact accepted change before final integration.

When no local capability is designated, a pull-request route may be selected and published to seek Human sign-off remotely. Publication is not final integration.

## Choose a delivery route

After applicable local sign-off handling:

1. Recommend pull-request delivery, local integration, or preserving the ready checkout.
2. If the user has not already selected a route for this exact change, stop before publishing, integrating, or cleaning up and wait.

A repository requirement for pull requests is never relaxed by change size. Implementation approval is not delivery authority.

## Route authority

Each route permits only its stated effects under the existing task authority. A selected route remains constrained by unresolved `Required` Human sign-off; route choice is sign-off only when the Maintainer explicitly accepts the exact change in the same instruction.

| Selected route | Authorizes | Does not authorize |
| --- | --- | --- |
| Pull request | Commit accepted content or same-scope corrections, non-force push the accepted branch, create or update the exact pull request, and establish continued observation. After verified merge, finish exact local Workgraph resources when nothing depends on them. | Merge the PR, force-push, add unrelated work, or expand scope. |
| Local integration | Integrate the exact accepted change into the exact authorized local destination with ordinary non-force Git operations, then finish exact local Workgraph resources. | Publish remotely, force, add unrelated work, or change the destination or scope. |
| Preserve checkout | Retain the exact Coordinator checkout and report its identity and state. | Integrate, publish, or clean up merely to make the handback neater. |

A pull request requests repository maintainer consideration. It does not satisfy `Required` Human sign-off for final integration.

## Confirm the accepted source

Before any delivery effect:

1. Work from the exact Coordinator checkout and accepted change.
2. Reinspect the final diff, commits, status, verification evidence, and material limitations.
3. Verify the selected route and every source, destination, branch, remote, or pull-request identity it will affect.

Stop when you find unrelated changes, uncertain identity or authority, doubt about the accepted content, or an uncertain result from an operation that may have changed repository or remote state.

After an uncertain effect, inspect current state before doing anything else. Never repeat the operation automatically.

## Pull-request delivery

### Prepare the source

1. Commit only accepted content that still needs a commit.
2. Pin the resulting clean revision.
3. Determine whether that head already has an open pull request.

Update the exact existing pull request instead of creating a duplicate.

### Explain the change

Open with:

1. why the change exists; and
2. its observable result.

Then choose the smallest representation that makes the important behavior, structure, risk, or evidence clear.

| Change shape | Prefer |
| --- | --- |
| Rule or algorithm | Compact pseudocode |
| Runtime control flow | Call tree or before/after flow |
| Ownership or file responsibility | Shallow annotated file tree |
| Component structure | Component tree with relevant state and boundaries |
| Interaction or data movement | Mermaid sequence or flow diagram |
| Modification to an existing shape | Fenced `diff` with `-` and `+` |
| Rendered behavior | Comparable before/after screenshots |
| Quantitative claim | Small table with measured values |

Use one strong visual rather than several representations of the same point. Use prose when it is clearer.

After the explanation, include:

- `Human sign-off requirement: Required` or `Human sign-off requirement: Optional`;
- a short reason for that classification;
- the specific sign-off focus when sign-off is required;
- evidence that directly supports the affected promises; and
- material limitations.

Omit empty sections and implementation chronology. Adapt the body to the change rather than forcing a fixed template.

Do not:

- claim evidence that was not observed;
- expose local paths, credentials, private logs, or unpublished local artifacts; or
- link screenshots or other media without a deliberate destination accessible to the repository maintainer.

### Publish and verify

1. Push the accepted branch with ordinary Git and forge tooling.
2. Create or update the exact pull request with the prepared title and body.
3. Verify its intended base and exact accepted head.
4. Establish continued observation through an available session capability that confirms the exact pull-request identity.

If observation is unavailable or confirmation fails, preserve the published pull request and report the limitation. Workgraph records no pull-request state.

Once observation is established, its availability may be reported directly to the user without starting an agent turn.

### Hand back publication

Report:

- the complete pull-request URL;
- the published revision;
- the Human sign-off requirement;
- whether observation was established; and
- material evidence limitations.

Then stop the publication turn.

### Continue observed work

A later delivered observation returns the Coordinator to the same pull-request work under the existing task and delivery authority.

1. Read current remote state once.
2. Reconcile the observation with the accepted change and current evidence.
3. When a same-scope correction is needed before merge, commit only that correction and non-force push the same branch.
4. When merged, prove the accepted result and any desired local synchronization through ordinary capabilities, then finish the exact local Workgraph checkout as described below.
5. When closed without merge, preserve the checkout unless the user authorizes another disposition.
6. Report the observed result and any preserved blocker.

Do not independently poll or keep observation available. An observation capability may report its own later availability failure directly to the user without starting an agent turn. Remote branch deletion uses repository configuration or ordinary forge/Git tooling; checkout finish never touches a remote.

If the needed response would merge, force-push, add unrelated work, or expand scope or authority, stop and return the decision to the user.

## Local integration

1. Verify the exact accepted source revision, authorized destination, current destination head, and authority to integrate them.
2. Use ordinary non-force Git operations. If Git refuses, conflicts, or leaves the result uncertain, stop and preserve both source and destination state.
3. Verify that the destination contains the accepted result and no unrelated state changed.
4. Finish the exact local Workgraph checkout as described below.
5. Report the accepted and resulting destination revisions, cleanup result, preserved blockers, verification evidence, and material limitations.

Local integration does not authorize publication.

## Finish the owned local checkout

Finish is housekeeping after delivery proof, not delivery evidence or authority.

1. Verify the deterministic checkout ID, its clean exact current `HEAD`, and that no retained work still needs it.
2. Call `workgraph_checkout` with a repository `cwd` when needed and `finish: { checkoutId, expectedHead }`.
3. Treat exact absence as completion. If finish reports dirty, changed, dependent, partial, moved, foreign, or ambiguous state, preserve it and inspect before retrying. Change `expectedHead` only after independently accepting that exact observed head, never merely to overcome a lease refusal.
4. Report whether local Workgraph resources were removed or preserved.

Finish removes no destination or remote resource. A selected local or merged pull-request route permits it only after that route's result has been independently proven.

## Preserve the ready checkout

Leave the accepted change and Coordinator checkout unchanged. Report the exact checkout path, current revision and status, verification evidence, material limitations, and anything still depending on the checkout.
