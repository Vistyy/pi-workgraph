# Verification

This file defines the retained verification boundary for Pi Workgraph.
The accepted result is the prototype envelope in [PLAN.md](PLAN.md), not unattended production orchestration.

## Required deterministic gate

Run the following command before review:

```bash
pnpm check
```

The gate type-checks every runtime, extension, test, and smoke script before running the deterministic test suite.

The retained checks establish these behaviors:

- Agreement-gated execution rejects work nodes before approval.
- Node identifiers, dependencies, lifecycle transitions, path claims, and ready-wave ordering are validated deterministically.
- Non-overlapping nodes execute in isolated worktrees and compose in stable identifier order.
- Reported commits are checked against actual worktree commits and claimed paths.
- A cherry-pick conflict is aborted while preserving the pre-composition `HEAD` and a clean coordinator worktree.
- A child session branches before an unresolved parent orchestration tool call while retaining inherited trajectory and objective context.
- Local Prewalk blocks the first edit until TODOs exist, blocks paths outside the claim, switches to the executor after the first successful edit, and removes transient guide context.
- A batch containing `workgraph_begin` activates the write gate before any sibling tool executes, regardless of tool-call order.
- Typed failed discovery and assurance reports cannot become successful phases.
- A routine failed node can be superseded inside the existing envelope, while an escalation remains on the serialized human-decision path, and pending dependents are rewired to the replacement.
- Recovery can consume a terminal worker report and can attribute one cherry-pick that landed before its durable state update.
- Durable state can be reopened with its revision and composed commit intact.

These checks use deterministic fake child outcomes where model variability would obscure scheduler and Git behavior.
They do not establish that a configured model will follow the child instructions.

## Real-system checks

Run these checks only when the configured models are authenticated and their cost is acceptable:

```bash
pnpm smoke:real
pnpm smoke:coordinator
```

`smoke:real` exercises Pi subprocesses and Git directly in a disposable repository.
Its successful retained run observed two read-only discoveries recovering `ORBIT` and `MOON` from inherited parent context, two parallel implementation sessions, one Sol-to-Luna transition in each session, two isolated one-file commits, stable exact-commit composition, two successful composed-root commands, and assurance with no findings.
The successful run used 56,777 input tokens, 4,671 output tokens, 72,192 cache-read tokens, 24 child turns, and $0.34008124 of recorded child-model cost.
The raw run output is retained in `artifacts/real-smoke.log`.

`smoke:coordinator` starts Pi in RPC mode with the coordinator extension and submits one normal request.
Its successful retained run observed `workgraph_begin`, read-only coordinator inspection, `workgraph_discover`, exactly one `workgraph_agree` confirmation, `workgraph_execute`, and `workgraph_assure` in one parent run.
The implementation child used `openai-codex/gpt-5.6-sol` before its first edit and `openai-codex/gpt-5.6-luna` afterward.
The composed file contained `AURORA`, the composed-root command exited successfully, assurance returned no findings, and the durable phase was `complete`.
Nested children used 47,096 input tokens, 3,694 output tokens, 77,312 cache-read tokens, 20 turns, and $0.31661264 of recorded cost.
The coordinator model's own usage was not retained by this script, so that figure is not the total cost of the RPC run.
The raw run output is retained in `artifacts/coordinator-smoke.log`.

A prior real-system run reached correct composition but assurance returned `needs_decision` because the assurance prompt omitted scheduler-owned composed-root evidence.
That run recorded $0.29063740 of child-model cost and directly exposed the evidence-handoff defect.
The implementation now includes the composed-root records in the assurance objective, and both later successful smoke checks crossed that boundary.
Known recorded child-model cost across these three retained diagnostic runs was $0.94733128, excluding the successful RPC coordinator model's own unretained usage.

## Evidence limits

The evidence establishes one local Linux, Node.js 24, Pi 0.84.4, Git, Sol, and Luna path.
It does not establish Windows support, remote execution, provider-independent behavior, semantic correctness for arbitrary repositories, or every crash timing.
Recovery reconciles terminal reports and one unrecorded composition commit, but it does not reattach to a still-running operating-system process.
A worker without a terminal report is escalated for inspection instead of being retried with an uncertain result.
The coordinator's decision to classify a request as consequential remains semantic model behavior; mechanical write prohibition begins after `workgraph_begin` activates the gate.
The worker validates committed path scope, but it is not an operating-system sandbox and does not prove that arbitrary executor shell commands had no transient external effects.
No passing check should be interpreted as evidence beyond these observed boundaries.
