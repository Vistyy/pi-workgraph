# Deliver an accepted repository change

Read this procedure only when an accepted repository change reaches the delivery boundary, or when a later delivered observation returns the Coordinator to its pull request.

This procedure supplies mechanics, not authority.

## Choose a delivery route

Human sign-off is the repository maintainer's judgment that an accepted change may be finally integrated. `Required` means final integration waits for that judgment; `Optional` means the Coordinator considers its evidence sufficient without requiring it. Classification itself grants no repository authority, and a Worker Review is not Human sign-off.

After accepting a repository change:

1. Classify Human sign-off as `Required` or `Optional`, and give the reason.
2. Recommend pull-request delivery, local integration, or preserving the ready checkout.
3. If the user has not already selected a route for this exact change, stop before publishing, integrating, or cleaning up and wait.

A repository requirement for pull requests is never relaxed by change size. Implementation approval is not delivery authority.

## Route authority

Each route permits only its stated effects under the existing task authority.

| Selected route | Authorizes | Does not authorize |
| --- | --- | --- |
| Pull request | Commit accepted content or same-scope corrections, non-force push the accepted branch, create or update the exact pull request, and establish continued observation. | Merge or finally integrate, force-push, add unrelated work, or expand scope. |
| Local integration | Integrate the exact accepted change into the exact authorized local destination with ordinary non-force Git operations. | Publish remotely, force, add unrelated work, or change the destination or scope. |
| Preserve checkout | Retain the exact Coordinator checkout and report its identity and state. | Commit, integrate, publish, or clean up merely to make the handback neater. |

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

- `Human sign-off: Required` or `Human sign-off: Optional`;
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

If no observation capability is available or confirmation fails, preserve the published pull request and report the limitation.

Once observation is established, its availability may be reported directly to the user without starting an agent turn.

### Hand back publication

Report:

- the complete pull-request URL;
- the published revision;
- the Human sign-off classification;
- whether observation was established; and
- material evidence limitations.

Then stop the publication turn.

### Continue observed work

A later delivered observation returns the Coordinator to the same pull-request work under the existing task and delivery authority.

1. Read current remote state once.
2. Reconcile the observation with the accepted change and current evidence.
3. When a same-scope correction is needed, commit only that correction and non-force push the same branch.
4. Report a delivered merged or closed state, which ends the Coordinator's responsibility.

Do not independently poll or keep observation available. The observation capability may report its own later availability failure directly to the user without starting an agent turn.

If the needed response would merge, force-push, add unrelated work, or expand scope or authority, stop and return the decision to the user.

## Local integration

1. Verify the exact accepted source revision, destination repository and ref, current destination head, and authority to integrate them.
2. Commit only accepted source content that must be committed for integration.
3. Use ordinary non-force Git operations. If Git refuses, conflicts, or leaves the result uncertain, stop and preserve both source and destination state.
4. Verify that the destination contains the exact accepted change and that no unrelated state changed.

Report the source and resulting destination revisions, the observed integration result, verification evidence, and material limitations. Do not publish or clean up unless separately authorized.

## Preserve the ready checkout

Leave the accepted change and Coordinator checkout unchanged. Report the exact checkout path, current revision and status, verification evidence, material limitations, and anything still depending on the checkout.
