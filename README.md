# Pi Workgraph

Workgraph coordinates bounded repository work within a normal Pi conversation.
Research, disposable experiments, maintained implementation, and selective review are capabilities, not phases of a mandatory pipeline.

## Run

Use Node.js 24 or newer, Git, Pi, and a Herdr-managed pane with Herdr's Pi state integration installed.
The current integration is checked against Pi 0.84.4 and Herdr 0.8.2.

```bash
pnpm install
pi -e /absolute/path/to/pi-workgraph
```

Start from a clean committed repository and ask the coordinator to delegate the needed work.
First delegation creates a workstream automatically; `workgraph_begin` is optional.
Workers run in visible Herdr tabs and isolated Git worktrees, with ordinary Pi package/configuration loading and fresh context.
There is no hidden print-process fallback or automatic trust approval.
Worktrees are not operating-system sandboxes.

## Conversation tools

| Tool | Purpose |
| --- | --- |
| `workgraph_research` | Delegate a question with `expectedEvidence`; optionally declare an authorized experiment's effects, stop condition, and retained paths. |
| `workgraph_implement` | Delegate a maintained change with acceptance requirements, using human-backed intent. |
| `workgraph_review` | Independently inspect a retained result, artifact, or exact revision for a specified concern. |
| `workgraph_intent` | Record changed scope against an actual retained human input receipt. |
| `workgraph_status` | Inspect attached work, input receipts, model observations, results, and resources. |
| `workgraph_acknowledge` | Record evidence actually read, independently of acceptance or notification transport success. |
| `workgraph_disposition` | Accept, reject, or request follow-up on retained evidence. |
| `workgraph_control` | Suspend/resume work or cancel/steer a specific live attempt. |
| `workgraph_adopt` | Attach retained work without forking the conversation or implicitly resuming suspension. |
| `workgraph_fork` | Explicitly fork the coordinator conversation into another visible session. |
| `workgraph_complete` | Record a conclusion, evidence, and limitations after workers and owned resources settle. |
| `workgraph_models` | Inspect or explicitly change model defaults. |

The coordinator interprets what a human request authorizes.
The runtime verifies input provenance, intent versions, references, Git postconditions, and ownership; a receipt is not a semantic approval oracle.
Extension notifications and worker reports do not grant authority.
New constraints leave historical evidence intact and tied to its original scope, while stale maintained output cannot compose into the current intent.
An experiment retains its named artifacts before scratch files are discarded; its code is never automatically composed.

Implementation uses Local Prewalk in the same worker session: a guide inspects the assignment and makes the first edit, then the executor continues.
A bounded TODO is useful telemetry, not an artificial prerequisite for accepting a valid implementation.
Both selected models and actual message models are retained.
A maintained result requires one clean direct commit on the assigned base before composition.
Worker settlement, report validity, coordinator acknowledgment, and acceptance remain separate facts.

## Models

Call `workgraph_models` with `action: "get"` to see the effective defaults and their file path.
The four roles are `research`, `implementation.guide`, `implementation.executor`, and `review`.
A persistent change uses `action: "set"`, `role`, and `target: { model, thinking }` when the user requests a policy change.
Assignment `model`, `thinking`, and implementation `executor` parameters override defaults without changing policy or the coordinator model.
Policy changes affect subsequent assignments, not already queued work.

Policy lives at `workgraph/models.json` under Pi's agent directory.
Version 1 settings are read without rewriting: research uses the first `discovery.evidence` target, review uses the first `verification.product` target, and guide/executor keep their corresponding first targets.
An explicit policy write stores only the four current roles in version 2 format.

## Recovery and inspection

Workstream state and worker sessions remain under Git's common directory, with the state path returned by the tools.
Only one runtime instance can hold a workstream lease, including within the same Pi session.
An unsuccessful adoption leaves the current attachment intact.
Expired ownership is not sufficient for takeover when the prior owner's liveness is unknown.

Suspension stops new launches and composition, while observations, evidence retention, and safe cleanup continue.
Result notifications have stable identifiers and can recur after an interrupted delivery; this is not an exactly-once transport.
After a notification failure, read the result through status and acknowledge that observation, or reattach to recover pending delivery.
The runtime does not repeatedly wake the coordinator on every poll.
Completion refuses pending deliveries until they are accounted for and refuses uncleaned owned resources.
Blocked work is preserved for inspection rather than force-deleted.

The CLI provides read-only state inspection and explicit conversation forking:

```bash
pi-workgraph status --state STATE_PATH
pi-workgraph status --run-id ID --registry REGISTRY_PATH
pi-workgraph fork --parent-session-file SESSION_PATH --target-cwd REPOSITORY --workspace WORKSPACE_ID
```

CLI results are JSON; failures exit nonzero.
Historical state is inspected as uninterpreted JSON, without automatic migration or mutation.
The active runtime uses workstream format version 3; earlier versions are not silently adopted.

## Development and live verification

```bash
pnpm check
pnpm pack --dry-run
pnpm smoke:herdr
pnpm smoke:coordinator
```

`pnpm check` owns full TypeScript checking, Biome formatting/recommended lint, targeted assertion checks, and deterministic tests.
The assertion check uses the already-installed TypeScript parser to reject type laundering through `unknown` and assertions to `never`, while permitting legitimate unknown inputs, ordinary narrowing, and `as const`.
Non-null assertions are not blanket-banned; their correctness depends on the enforced boundary.

Run live scenarios only from a Herdr-managed pane, against a clean committed candidate.
`smoke:herdr` starts idle Pi sessions without submitting model prompts and checks native identity, unnamed coordinator lookup, cleanup refusal for mismatched identity, and Herdr closure before Git removal.
`smoke:coordinator` submits one authorized request through a normal visible Pi coordinator and observes automatic handling of research, experiment retention/non-composition, implementation with guide/executor messages, concurrent research, exact-revision review, and resource cleanup.
It requires authenticated configured models and does not supply later approval or progress nudges.

Both scenarios freeze the candidate with Git archive and use a private temporary fixture, copied authentication/model configuration, isolated `PI_CODING_AGENT_DIR`, and the installed Herdr integration.
The integration defaults to `extensions/herdr-agent-state.ts` under the source Pi agent directory; set `PI_WORKGRAPH_HERDR_EXTENSION` if it is installed elsewhere.
`PI_WORKGRAPH_COORDINATOR_MODEL` overrides only the fixture coordinator selection, and `PI_WORKGRAPH_SMOKE_TIMEOUT_MS` overrides the capability scenario's 30-minute deadline.
No trust settings or approval bypass flags are supplied.
Successful scenarios verify exact workspace absence and retain their evidence directory.
Failures retain diagnostics and resources for identity-aware reconciliation instead of deleting uncertain work.
These private directories may contain copied credentials and must not be published wholesale.

The package skill supplies Workgraph-specific coordination guidance, not a replacement for design or verification methodology.
[VERIFICATION.md](VERIFICATION.md) records durable local evidence boundaries; executable commands own the checks.
