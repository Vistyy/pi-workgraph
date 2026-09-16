# Publish an accepted change as a pull request

The explicit pull-request choice authorizes one-time publication of the accepted change. It does not authorize merging the pull request, monitoring it, responding to later activity, or changing the agreed scope.

## Establish the publication source

Work from the exact Coordinator checkout and accepted change. Reinspect its final diff, commits, status, intended base, verification evidence, and any material limitations; do not reconstruct the result only from Worker reports. If accepted content still needs a commit, the explicit pull-request choice authorizes committing exactly that content. Stop on unrelated changes, an uncertain base or remote, or any doubt about what was accepted. Pin the resulting clean revision before writing or publishing its description.

Determine whether the accepted head already has an open pull request. Update that exact pull request instead of creating a duplicate. Never force-push. If an operation fails or returns an uncertain result after it may have changed the remote, inspect the remote state before doing anything else and do not automatically repeat it.

## Write for the reviewer

Make the body concise and layered rather than exhaustive:

- open with why the change exists and its observable result;
- use the smallest helpful visual—a diff-shaped sketch, shallow tree, control flow, Mermaid diagram, or screenshot—when it communicates faster than prose;
- state the Coordinator's already-decided `Human review: Required` or `Human review: Optional`, including a short reason and, when required, the specific review focus;
- present evidence that directly supports the affected promises, such as an exercised workflow, before/after screenshot, measurement, or relevant checks;
- include limitations only when they are material.

Omit empty sections and implementation chronology. Do not claim evidence that was not observed. Do not expose local paths, credentials, private logs, or unpublished local artifacts. Screenshots and other media must have a deliberate reviewer-accessible destination before they are linked.

A useful shape is:

````markdown
A short explanation of the problem and resulting behavior.

```text
before
  old flow

after
  new flow
```

**Human review:** Required — changes repository custody.
**Review focus:** Interruption recovery and ownership boundaries.

## Evidence

- The supported workflow produced the expected result.
- Relevant checks passed.

## Limitations

- Include only a material limitation.
````

Adapt the shape to the change instead of forcing every heading.

## Publish once

Push the accepted branch with ordinary Git and forge tooling, then create or update the pull request with the prepared title and body. Verify that the resulting pull request targets the intended base and exact accepted head. Report the complete pull-request URL, the published revision, the human-review classification, and any evidence limitation. Stop after this one-time publication.
