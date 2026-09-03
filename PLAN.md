# Pi Workgraph Prototype Plan

## Status

The user approved this implementation envelope in the parent Pi session on 2026-09-02.
This file is the durable checkpoint for the prototype and remains the authority if the parent session is compacted.

## Outcome

Build a near-final Pi package that turns a materially ambiguous coding request into a visible agreement, then coordinates isolated implementation and assurance without making the user manage agents.
The user should experience one coordinator conversation, one explicit approval checkpoint, and one concise final result.
The implementation should prove the complete path on a disposable Git repository with real Pi sessions and configured models.

## Stop boundary

The prototype will support one local Git repository, one active workgraph per coordinator session, bounded parallelism, local Pi subprocesses, Git worktrees, exact-commit composition, and command-based verification.
It will not provide remote workers, pull request automation, a dashboard, a general workflow language, nested agent teams, long-running daemon supervision, or a reusable project-management backlog.
It will not automatically resolve semantic merge conflicts or silently broaden an approved implementation envelope.
It will not modify the user's global Pi settings to install itself.

## Reuse decision

The package will reuse Pi extension tools, extension lifecycle events, `SessionManager.forkFrom`, model selection, session persistence, and normal CLI model authentication.
It will reuse Git branches, worktrees, commits, diffs, and cherry-picks as the isolation and composition protocol.
It will reuse the strongest applicable project verification commands supplied in the approved envelope.
It will not depend on P-Stack or Herdr because their worker lifecycle and UI ownership introduce requirements that this prototype does not need.
It will use plain TypeScript and Node.js rather than Effect unless implementation evidence reveals a lifecycle or concurrency problem that Effect directly removes.

## Structural shape and ownership

```text
Coordinator Pi session
  -> agreement policy blocks product writes
  -> discovery runner forks read-only sessions
  -> approved implementation envelope
  -> durable scheduler selects ready work nodes
  -> worktree runner forks inherited sessions
       -> guide model verifies local context
       -> worker records bounded TODOs
       -> worker lands first successful edit
       -> same session switches to executor model
       -> worker verifies and commits
       -> worker returns a typed report
  -> composition owner validates and cherry-picks exact commits
  -> assurance runner inspects the composed result
  -> coordinator reports evidence or requests a human decision
```

The coordinator owns semantic synthesis, the agreement checkpoint, and interpretation of escalations.
The scheduler owns node identifiers, dependencies, states, exact commits, ready queues, and deterministic transition order.
The worker runtime owns one branch objective, one worktree, one inherited Pi session, the local Prewalk transition, and one typed result.
The composition module owns clean-worktree checks, claimed-path validation, exact cherry-picks, and conflict containment.
The assurance module owns read-only review of the composed result and typed findings.
The human decision queue owns all approval and authority-changing interactions and permits at most one unresolved prompt.

## Agreement policy

Entering a workgraph disables the coordinator's direct `edit` and `write` tools and blocks known mutating shell commands.
Discovery sessions are restricted to read-only tools.
The approval checkpoint must contain the outcome, non-goals, reuse decision, structural ownership, expected scale, verification boundary, and unresolved decisions.
Implementation cannot start until the user approves that checkpoint through Pi's UI.
Approval creates an implementation envelope rather than a frozen step list.
A worker may make local reversible decisions inside the envelope.
A discovery that changes the outcome, non-goals, owner, public interface, dependency, security guarantee, scale, or reuse-versus-custom decision must stop affected work and return an escalation.
The coordinator remains read-only after approval except for a demonstrably tiny integration correction inside the envelope.
The prototype will not automate that exception.

## Public prototype interface

The package will expose a small set of coordinator tools rather than a workflow language.

- `workgraph_begin` records the request, verifies repository preconditions, starts the durable run, and activates the write gate.
- `workgraph_discover` runs a bounded set of inherited-context read-only investigations in parallel and returns typed reports.
- `workgraph_agree` records the complete implementation envelope and serializes the user approval interaction.
- `workgraph_execute` adds or resumes a bounded dependency graph, runs ready workers, validates their results, and composes successful waves.
- `workgraph_assure` runs read-only assurance against the composed result and returns typed findings.
- `workgraph_status` reports durable run, node, worktree, session, and escalation state.

The exact schemas may be combined if implementation proves that fewer tools reduce caller knowledge without weakening phase gates.

## Durable state

Each transition will be written atomically under the repository's Git common directory before its associated external operation is considered complete.
The state will include the run identifier, parent session identifier, base and composed commits, phase, approved envelope, nodes, dependencies, attempts, worktree paths, child session files, process outcomes, reports, exact commits, composition records, assurance findings, and human decisions.
A coordinator-session custom entry will point to the active run so state remains branch-aware and discoverable after resume.
On recovery, the scheduler must inspect Git and session state before retrying an operation whose result may already have landed.

## Work node contract

A work node has a stable identifier, objective, claimed paths, dependency identifiers, verification commands, guide model, executor model, and state.
The scheduler may run ready nodes concurrently only when their claimed paths do not overlap.
A worker result must report completion or escalation, summary, changed files, verification evidence, commit, and findings.
A worker cannot report completion with an uncommitted or dirty worktree.
The scheduler validates the reported commit and actual changed paths rather than trusting the report.

## Local Prewalk contract

The guide phase receives the inherited parent trajectory plus only the branch objective and execution envelope.
It must inspect the local worktree, record a bounded TODO list, and make the first successful edit.
The worker extension blocks an edit until the TODO list exists.
After the first successful `edit` or `write`, the extension removes transient guide instructions and switches the same Pi session to the executor model.
The executor continues from the same trajectory, completes the objective, verifies it, commits it, and emits the typed result.
A model switch does not preserve the guide model's provider cache, so the benefit claimed for the executor is reduced exploration and preserved trajectory rather than cross-model cache reuse.

## Composition and assurance

Each parallel wave starts from one recorded composition commit.
After a wave settles, the scheduler validates each successful commit and cherry-picks commits in stable node-identifier order.
A clean mechanical composition proceeds without user interaction.
A cherry-pick conflict is aborted and recorded as an integration escalation without discarding worker branches or worktrees.
Dependent nodes start only after their dependencies are composed.
Assurance runs read-only after composition and returns typed findings.
Required findings may become additional work nodes through another `workgraph_execute` call within the same approved envelope.
A finding outside the envelope enters the human decision queue instead.

## Expected implementation scale

The target is one Pi package with one coordinator extension, one worker extension, focused runtime modules, and tests.
The target size is roughly 1,500 to 2,500 lines of TypeScript plus instructions and verification fixtures.
The prototype should prefer direct code and explicit discriminated unions over adapters without a demonstrated variation.

## Verification boundary

Unit checks will cover state transitions, dependency readiness, claimed-path overlap, agreement gating, worker-report parsing, and composition failure containment.
An integration check will use a disposable Git fixture and deterministic fake worker processes to exercise begin, approval, parallel work, composition, assurance, and recovery state without model variability.
A real-system check will use actual Pi subprocesses and configured guide and executor models on a disposable Git fixture.
The real-system check must establish inherited session context, read-only discovery, TODO-before-edit enforcement, the post-edit model switch, isolated commits, exact composition, verification execution, typed assurance, and concise coordinator-visible evidence.
Passing checks will establish only the observed local prototype path and will not establish crash safety for every process timing or unattended production operation.

## Decision-driving hypothesis

Pi's existing extension, session, model, and CLI primitives plus Git are sufficient to implement this workflow without a separate orchestration framework or Herdr dependency.
The hypothesis is supported if the real-system fixture completes the entire path with durable inspectable state and no manual worker coordination.
The hypothesis is refuted if inherited-context forks, in-session model switching after the first edit, or reliable exact-commit composition cannot be implemented through supported Pi and Git interfaces.
The result is inconclusive if model availability or external service failure prevents the real-system boundary from running.

## Implementation sequence

1. Create package metadata, domain types, atomic state storage, and deterministic scheduler rules.
2. Implement Git repository, worktree, commit-validation, and composition operations.
3. Implement child session forking, subprocess event capture, typed result extraction, and bounded concurrency.
4. Implement the worker extension with read-only discovery mode and the Local Prewalk transition.
5. Implement coordinator tools, write gates, approval UI, persisted run linkage, and concise rendering.
6. Add deterministic tests and a disposable end-to-end fixture.
7. Run one bounded real-model end-to-end scenario, record evidence and cost, and correct defects within this envelope.
8. Document operation, verified guarantees, and remaining limitations.

## Unresolved local decisions

The exact number and grouping of public tools may change if tests show a simpler interface with the same phase guarantees.
The state schema may gain fields required for recovery evidence, but it must not become a general workflow definition.
The initial real-model fixture will use `openai-codex/gpt-5.6-sol` as the guide and `openai-codex/gpt-5.6-luna` as the executor unless availability changes.
These decisions are local and reversible inside the approved envelope.
