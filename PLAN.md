# Pi Workgraph Implementation Envelope

## Status

The user approved this revised implementation envelope in the parent Pi session on 2026-09-03.
This file is the durable authority for the current Workgraph implementation.

## Outcome

Build a Pi package that lets one coordinator dynamically compose proven coding playbooks while Workgraph makes delegation, model selection, isolation, evidence, composition, and recovery reliable.
The user should provide a goal and completion condition without managing agents or seeing routine worker events.
The coordinator should surface only the initial agreement, genuine authority-changing decisions, material blockers, and the final evidenced result.

## Current structural boundary

Workgraph retains a structured lifecycle around one implementation DAG:

```text
playbook selection
  -> bounded discovery
  -> agreement
  -> implementation DAG
  -> composition and product verification
  -> assurance review and synthesis
  -> completion or bounded correction
```

Discovery, implementation, verification, and assurance will not become arbitrary mixed graph node kinds in this implementation.
The question of whether unrelated branches continue while one branch awaits a human decision remains open until real use establishes a need.
The implementation DAG continues to support parallel non-overlapping nodes and dependency-ordered waves.

## Coordinator contract

The coordinator owns playbook selection, semantic synthesis, agreement, worker briefs, correction routing, and final judgment.
The coordinator keeps its normal Pi tools throughout the run.
Workgraph must not add, remove, or mechanically block coordinator tools based on phase.
The coordinator follows injected instructions to establish agreement before substantial implementation.
The stable tool inventory preserves provider prompt-prefix caching and avoids encoding coordinator judgment as a tool restriction.

## Playbooks and methods

Workgraph owns its playbooks and does not depend on PStack at runtime.
The initial playbook families are:

- Understand with Investigation, Runtime forensics, and Trace forensics.
- Decide with Prototype, Architecture, Arena, and Eval.
- Change with Bug fix, Feature, Refactoring, Performance, and Visual parity.
- Operate with Autonomous run, Pause safely, Session pickup, and Figure it out when no narrower playbook fits.

The coordinator loads one matching playbook through a stable Workgraph tool.
The selected playbook, completion predicate, ordered steps, completed steps, and explicit skip reasons are durable run state.
The coordinator may compose partitioned exploration, replicated investigation, evidence-source investigation, synthesis, prototype, arena, swarm, and review methods as a playbook requires.
The runtime must not force every method into every run.

## Discovery topology

Every discovery call declares why work is parallel:

- Partition assigns different evidence slices and requires coverage of the requested slices.
- Replicate sends the same consequential question to different model families and preserves convergence and disagreement.
- Evidence assigns distinct evidence categories when historical or operational rationale affects the decision.

Partitioned exploration uses the configured explorer target unless the coordinator supplies a justified override.
Replicated discovery selects a bounded subset of the configured heterogeneous panel.
Every requested lane must settle as completed, failed, timed out, cancelled, or superseded.
The coordinator must see dropouts instead of silently receiving a smaller panel.
Substantial fan-out may receive a synthesis operation, while ordinary discovery is synthesized directly by the Sol coordinator.

## Model policy

Workgraph owns a durable role-to-model configuration independent of PStack.
The initial defaults copy the user's current Pi PStack choices:

- Partitioned exploration uses `opencode-go/muse-spark-1.3-contributor` with high thinking.
- Replicated investigation draws from Muse Spark, `openai-codex/gpt-5.6-terra`, `opencode-go/glm-5.3-flash`, and `opencode-go/deepseek-v4-flash`, all with high thinking.
- Local Prewalk uses `openai-codex/gpt-5.6-sol` as guide and `openai-codex/gpt-5.6-luna` as executor, both with high thinking.
- Assurance responsibilities have independently configurable targets.
- Assurance synthesis uses `openai-codex/gpt-5.6-luna` with high thinking.

Model selection is role-based and may be overridden per operation.
The runtime validates availability before starting a configured panel and reports unavailable members as explicit dropouts.
The coordinator should use two or three replicated discovery models ordinarily and reserve the full panel for consequential decisions.
The initial assurance-role assignments are provisional and must remain configurable until role-specific evaluation provides better evidence.
Cost is material when models provide comparable results, with Muse Spark treated as the lowest-cost default under the user's supplied pricing relationship.

## Worker brief

Every spawned worker receives one bounded brief with these fields:

- Goal states the owned outcome.
- Scope states claimed paths and forbidden scope.
- Context points to required source, decisions, and upstream reports.
- Acceptance contains observable completion conditions.
- Verify names commands or the product-verification procedure.
- Timebox states when to return partial evidence instead of wandering.
- Forbidden states prohibited operations and changes.
- Report defines the terminal result contract.

A dependency is both an ordering edge and a context relay.
The coordinator must pass required upstream evidence into downstream briefs rather than assuming workers can inspect sibling sessions.
Workers cannot recursively delegate.

## Local Prewalk

An implementation worker starts in an inherited parent-session fork and an isolated Git worktree.
The Sol guide inspects local context, records bounded TODOs, and makes the first successful edit.
The same session then switches to the Luna executor, which completes, verifies, commits, and reports.
The scheduler validates the actual commit, changed paths, and worktree state instead of trusting the report.

## Product verification and evidence

The agreement records the verification boundary and verification method before implementation.
The coordinator decides whether commands directly observe the required result or whether independent product verification is necessary.
The scheduler runs sufficient command-based verification directly when existing commands cross the real behavior boundary.
For interactive, visual, judgment-laden, or otherwise unobserved behavior, Workgraph starts an independent verifier after composition.
The verifier drives the composed product and produces evidence such as screenshots, interaction observations, console output, network records, traces, profiles, or stored values.
The implementer may provide provisional evidence, but independent composed-result evidence has higher authority.

Evidence is keyed to the exact composed commit.
A later commit invalidates an earlier verdict until the affected boundary is verified again.
One-time evidence does not automatically become durable test coverage.
A test is retained only when it protects a distinct enduring invariant at acceptable maintenance cost.

## Assurance

Assurance runs after composed-result verification.
It uses exactly one reviewer for each applicable responsibility rather than multiplying every responsibility across every model family.
The default responsibilities are:

- Behavior reviews realistic correctness, integration, failure behavior, concurrency, recovery, security, and performance where relevant.
- Structure reviews deletion opportunities, smallest coherent scope, types, ownership, boundaries, abstractions, reader load, and maintainability.
- Evidence reviews whether the observed artifacts and retained checks establish distinct consequential invariants without implementation-detail or duplicate-test burden.

Reviewers decide whether the change should be accepted and may return no findings.
They do not receive an issue quota or instructions to manufacture adversarial findings.
A candidate finding must identify a violated invariant, concrete evidence, a reachable scenario, material consequence, the simplest response, confidence, and whether the response deletes or adds complexity.
Impossible, immaterial, duplicate, speculative, or purely stylistic findings must not create correction work.
The structural reviewer begins by asking what can be removed while preserving the agreed behavior.
The evidence reviewer may recommend deleting redundant or implementation-coupled tests.

Luna synthesizes the responsibility reports by deduplicating findings, checking support, and classifying them as accepted, optional, dismissed, or inconclusive.
The Sol coordinator remains the final authority over which accepted findings become work.
A local finding resumes the original implementation trajectory in a fresh worktree based on the current composed commit when practical.
A cross-node finding becomes a bounded correction or integration node.
An envelope-changing finding returns to the serialized human decision boundary.
Corrections rerun affected product verification and assurance instead of looping until every reviewer is silent.

## Context and result relay

Child transcripts remain durable by path and are not copied wholesale into the coordinator context.
Children return bounded typed reports with evidence pointers.
A synthesis step reduces substantial fan-out before the coordinator consumes it.
Every spawned child is accounted for, including dropouts.
Progress records model, thinking level, state, turns, usage, and available context evidence without requiring a live dashboard.

## Durable orchestration

State remains atomic under the repository's Git common directory.
The state includes the selected playbook, completion predicate, steps, model assignments, discovery topology and lane outcomes, agreement, worker briefs, implementation nodes, child sessions, commits, composition records, product-verification evidence, assurance reports, synthesis verdict, human decisions, and usage.
Before retrying an uncertain operation, recovery inspects the session, worktree, branch, commit, and coordinator repository.
Retries depend on observed failure mode and remain bounded.
Unknown results are reconciled before replacement work begins.

## Selective operating mechanisms

Workgraph should adopt these mechanisms when the run earns their cost:

- A pilot unit before broad repeated fan-out when one bad brief would multiply.
- An append-only decision trail for long or unattended work.
- Persisted standing instructions reconstructed on worker resume.
- A completion inbox when genuine background execution replaces blocking batches.
- Reflection over completed runs to propose playbook or runtime improvements, with human approval before durable instruction changes.

These mechanisms must not become mandatory ceremony for ordinary work.

## Deferred scope

This implementation does not include pull request creation, PR babysitting, shipping, merging, or forge automation.
It does not include Herdr integration, live worker panes, a worker dashboard, or daemon supervision.
It accepts that child execution is not live-observable beyond coordinator progress updates, while durable sessions, reports, worktrees, commits, and usage remain inspectable afterward.
It does not include PStack as a dependency, remote workers, nested delegation, a general workflow language, or hundred-agent program machinery.

## Verification boundary

Deterministic checks must establish playbook loading and progress, stable coordinator tools, topology expansion, heterogeneous model assignment, dropout accounting, brief construction, existing scheduler and Git invariants, verification routing, evidence invalidation, responsibility-specific assurance synthesis, finding rejection, and correction routing.
Integration checks must use disposable Git repositories and real supported boundaries where model variability is not required.
A bounded model-backed run must establish at least one heterogeneous discovery, Local Prewalk transition, composition, composed-result verification, three responsibility reports, Luna synthesis, and concise coordinator completion.
Passing checks establish only the observed local Linux, Node.js 24, Pi 0.84.4, Git, and configured-model path.

## Implementation sequence

1. Add the playbook catalog, loader tool, durable playbook selection, and progress state.
2. Remove coordinator tool gating while retaining a stable coordination policy.
3. Add Workgraph model configuration and role resolution.
4. Replace same-model generic discovery with topology-aware lane expansion and explicit dropouts.
5. Deepen worker briefs and bounded result relay.
6. Add verification plans, exact-revision evidence, and optional independent verifier execution.
7. Replace single assurance with three responsibility reviewers and Luna synthesis.
8. Add deterministic and real-system verification, then revise only from observed failures.
