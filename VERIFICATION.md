# Verification

This file defines the retained verification boundary for Pi Workgraph.
The accepted result is the implementation envelope in [PLAN.md](PLAN.md), not unattended production orchestration.

## Required deterministic gate

Run this command before review:

```bash
pnpm check
```

The gate type-checks every runtime, extension, test, and smoke script before running 31 deterministic tests.

The retained checks establish these observed behaviors:

- The coordinator registers one stable Workgraph tool inventory and installs no coordinator `tool_call` mutation interceptor or active-tool changes.
- The catalog discovers all 16 playbooks, each playbook contains substantive completion, method, evidence, and failure instructions, and packaged files include the playbook directory.
- Selected playbook identity, completion predicate, completed steps, and explicit skip reasons survive durable reload.
- Workgraph rejects assurance while a selected playbook step remains pending.
- The default model policy contains the accepted heterogeneous discovery panel, Sol-to-Luna Local Prewalk roles, provisional independent assurance roles, and Luna synthesis.
- A model-role override persists in Workgraph's own configuration without reading PStack configuration.
- Replicated discovery sends one identical question to diverse model assignments and marks a preflight-unavailable model explicitly.
- Discovery records failed, unavailable, and superseded lanes without silently shrinking requested fan-out.
- A completed substantial fan-out can be reduced by a separately accounted synthesis child.
- Agreement-gated execution rejects implementation nodes before approval.
- Worker briefs carry GOAL, SCOPE, CONTEXT, ACCEPTANCE, VERIFY, TIMEBOX, FORBIDDEN, and REPORT fields, and the timebox controls child timeout.
- Node identifiers, dependencies, lifecycle transitions, path claims, replacement rewiring, and ready-wave ordering are validated deterministically.
- Non-overlapping nodes execute in isolated worktrees and compose in stable identifier order.
- A clean worktree created immediately before a coordinator crash is reused safely when the still-pending node resumes.
- Reported commits are checked against actual worktree commits, direct parentage, one-commit scope, clean state, and claimed paths.
- A cherry-pick conflict is aborted while preserving the pre-composition `HEAD` and a clean coordinator worktree.
- A child session branches before an unresolved parent orchestration call while retaining inherited trajectory and bounded objective context.
- Local Prewalk blocks premature edits, requires bounded TODOs, enforces path claims, switches to the executor after the first successful edit, and removes transient guide context.
- Routine failed implementation can be superseded inside the existing envelope without restarting settled work.
- Independent product evidence is keyed to the exact composed commit and is invalidated when a later correction changes that commit.
- Unattributed coordinator commits are detected before assurance and route to `needs_decision` instead of being accepted as composed work.
- A local correction can continue the original implementer session in a fresh current-head worktree and start directly in executor mode.
- Assurance runs exactly one behavior, structure, and evidence responsibility before synthesis.
- A required reviewer failure produces `assurance_inconclusive` rather than a false pass.
- Retrying a completed but inconclusive responsibility reruns only that responsibility and preserves the other completed reviews.
- Assurance synthesis cannot invent or change a responsibility reviewer's candidate finding.
- The coordinator must account for every assurance finding before completion.
- An accepted internal finding routes to `revision_required`, while an accepted envelope-changing finding routes to `needs_decision`.
- Recovery can consume a terminal implementation report and can attribute one cherry-pick that landed before its durable state update.
- Recovery can consume interrupted exact-revision product-verification evidence.
- Recovery preserves completed assurance reviews and retries only synthesis after an interrupted assurance run.
- Durable state can be reopened with its revision, playbook state, and composed commit intact.

These checks use deterministic fake child outcomes where model variability would obscure scheduler, state, and Git behavior.
They do not establish that an arbitrary configured model will follow the worker instructions.
The stable-inventory test establishes extension behavior but does not measure a provider cache hit.

## Direct engine smoke

Run this model-backed check when the configured models are authenticated and its cost is acceptable:

```bash
pnpm smoke:real
```

The retained successful run is in `artifacts/real-smoke.log`.
It observed these boundaries in one disposable Git repository:

- Two replicated discovery lanes received the same request question.
- Muse Spark and `openai-codex/gpt-5.6-terra` independently recovered `ORBIT` and `MOON` from inherited parent context.
- Two non-overlapping implementation worktrees ran concurrently.
- Each implementation session used `openai-codex/gpt-5.6-sol` before its first edit and `openai-codex/gpt-5.6-luna` afterward.
- Each worker produced one isolated one-file commit and passed its owned script.
- Composition landed both exact changes in stable identifier order.
- Both composed-root commands passed against composed commit `d6e8f0448d8546384102dcef937fafa04afc3737`.
- The resulting files contained `ORBIT` and `MOON` exactly.
- DeepSeek V4 Flash performed behavior assurance, Muse Spark performed structure assurance, and GLM 5.3 Flash performed evidence assurance.
- All three responsibility reviewers returned approval with no findings.
- Luna synthesized the three reports without inventing findings.
- Final coordinator judgment accounted for the empty candidate set and moved the run to `complete`.

The child runs recorded 134,504 input tokens, 16,725 output tokens, 598,472 cache-read tokens, 62 child turns, and $0.153967971 in model cost.
The direct smoke does not include a separate coordinator-model usage record because it invokes the engine directly.

## Coordinator RPC smoke

Run this model-backed user-flow check when Sol and Luna are authenticated:

```bash
pnpm smoke:coordinator
```

The retained successful run is in `artifacts/coordinator-smoke.log`.
It started Pi in RPC mode with only this package loaded and submitted one organic feature request.
The observed coordinator tool sequence included:

- `workgraph_playbook`.
- `workgraph_begin`.
- `workgraph_discover`.
- `workgraph_synthesize` over both completed discovery reports.
- Five durable `workgraph_progress` updates.
- Exactly one `workgraph_agree` UI confirmation.
- `workgraph_execute`.
- `workgraph_status`.
- Normal coordinator `bash` inspections while Workgraph remained active.
- `workgraph_assure`.
- `workgraph_judge`.

The implementation child switched from Sol to Luna after its first successful edit.
The composed file contained `AURORA`, the composed-root command exited successfully, all three assurance reviews returned no findings, Luna synthesis returned approval, and final coordinator judgment moved the durable phase to `complete`.

Nested children recorded 111,076 input tokens, 9,864 output tokens, 260,096 cache-read tokens, 39 child turns, and $0.6601368 in model cost.
The script does not retain the RPC coordinator model's own usage, so this figure is not the total run cost.

## Packaging check

Run this command to inspect the package boundary:

```bash
pnpm pack --dry-run
```

The observed tarball listing included both extensions, every source module, all 16 playbooks, `README.md`, `PLAN.md`, and this verification document.

## Evidence limits

The evidence establishes one local Linux, Node.js 24, Pi 0.84.4, Git, and configured-model path.
It does not establish Windows support, remote execution, provider-independent behavior, semantic correctness for arbitrary repositories, or every crash timing.

Independent product verification is covered deterministically through the actual engine and disposable Git boundary, but this retained model-backed smoke used command verification because its commands directly observed the fixture outcome.
Interactive browser control, screenshot quality, trace capture, and performance-profile quality remain dependent on the verifier's available shell tooling and the target project.

Recovery reconciles retained terminal reports and exact repository state, but it does not reattach to a still-running operating-system process.
An interrupted child without a terminal report becomes an explicit failed or inconclusive record before any bounded retry.

The coordinator's decision to select Workgraph, choose a playbook, synthesize ordinary discovery, and classify final findings remains semantic model behavior.
Normal coordinator tools remain available, so there is no operating-system or extension-enforced prohibition against direct coordinator writes.
The stable policy instructs the coordinator to keep substantial product implementation behind agreement.

Workers validate final Git scope and cleanliness, but they are not operating-system sandboxes and cannot prove that arbitrary shell commands had no transient external effects.
The verification worker can run product-driving shell procedures but has no edit or write tools and must leave the repository clean before reporting.

The Eval playbook requires genuinely isolated blind candidate contexts for behavioral evaluation.
When the available runtime cannot provide those contexts, the playbook requires an explicit capability-gap result rather than a valid-eval claim.

No passing check should be interpreted as evidence beyond these observed boundaries.
