# Pi Workgraph

Pi Workgraph lets a Pi coordinator delegate repository and directory work to visible Workers in Herdr tabs. It can gather evidence, consult another model, implement in isolated Git worktrees, review exact results, and retain useful repository output for a deliberate local decision.

## Install

Requirements: Node.js 24+, Git, Pi, and a Herdr-managed Pi pane with Herdr's Pi state integration.

Install the published npm release:

```bash
pi install npm:@syzom/pi-workgraph@0.1.0
```

Or install the matching GitHub release:

```bash
pi install git:github.com/Vistyy/pi-workgraph@v0.1.0
```

For a development checkout:

```bash
pnpm install --frozen-lockfile
pi install /absolute/path/to/pi-workgraph
# Or load it for one run:
pi -e /absolute/path/to/pi-workgraph
```

Pi packages execute code with your user permissions. Review third-party source before installation.

## Configure models

Before using Workgraph, create `~/.pi/agent/workgraph/models.json`. Workgraph supplies no model defaults and never rewrites this file.

```json
{
  "roles": {
    "research": [
      { "model": "provider/research-model", "thinking": "high" }
    ],
    "implementation.guide": {
      "model": "provider/guide-model",
      "thinking": "medium"
    },
    "implementation.executor": {
      "model": "provider/executor-model",
      "thinking": "high"
    },
    "implementation.escalationExecutor": {
      "model": "provider/escalation-model",
      "thinking": "max"
    },
    "review": [
      { "model": "provider/review-model", "thinking": "high" }
    ],
    "consultation.advisor": [
      { "model": "provider/advisor-model", "thinking": "medium" }
    ]
  }
}
```

Replace every example ID with a model configured in Pi. Thinking may be `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

Research, review, and consultation roles are ordered nonempty lists; their first target is the default. The implementation guide and executor are single targets. `implementation.escalationExecutor` may be omitted; it is used only when the coordinator explicitly requests it, and such a request fails before Task creation when the role is absent. Additional list entries let the coordinator request model diversity. Model and thinking choices are frozen into each Attempt, while its Outcome records the models Pi actually used.

## Coordinator tools

Workgraph exposes exactly nine coordinator tools:

| Tool | Purpose |
| --- | --- |
| `workgraph_models` | List configured targets for a selectable role. |
| `workgraph_research` | Create evidence-seeking research or a bounded repository experiment. |
| `workgraph_consult` | Ask one configured advisor a precise, evidence-only question. |
| `workgraph_implement` | Create an implementation Task and its first Attempt. |
| `workgraph_review` | Review an exact Attempt, comparison, or repository revision. |
| `workgraph_attempt` | Create another fresh Attempt for an existing Task. |
| `workgraph_inspect` | Inspect this Pi session's Task, Attempt, Outcome, and operational records. |
| `workgraph_control` | Steer or cancel a Worker, or apply or discard exact repository output. |
| `workgraph_notepad` | Read, replace, or clear the current branch's bounded coordinator memo. |

Each coordinator Pi session owns its own records. All sessions share one private SQLite database under the Pi agent data directory, partitioned by exact session identity; records are not globally discoverable from other sessions.

A Task has one immutable resolved target. Directory targets record an exact path. Repository targets record the checkout root and Git common directory, so Tasks in one session may safely address different repositories without implying a transaction across them. Every Attempt inherits its Task target and starts one fresh Worker Pi session.

Repository Attempts execute in detached worktrees. On a completed report, only commits survive; commit intended output before reporting. Changed commits are retained at `refs/pi-workgraph/outputs/<attemptId>`, while non-completed dirty worktrees and uncertain resources are preserved. Implementation Attempts can start independently, extend a retained Candidate, or integrate one onto another base. Applying and discarding remain explicit local operations, and Workgraph never pushes.

Stopping or reloading the coordinator stops only coordinator-owned activity. Independent Worker sessions, Herdr tabs, retained refs, and uncertain resources remain available for inspection or deliberate action.

The notepad stores at most 4,000 characters in the current Pi branch and restores that memo after genuine context compaction. It is pending-memory only: it grants no authority and does not establish acceptance or correctness.

## Calm presentation

Calm is coordinator-only and is on by default; `/calm default on` preserves that default for new coordinator sessions. It projects the live Pi chat children on every render while leaving Pi's source transcript untouched.

The projection hides exact `pi-workgraph-outcome` rows and model tool-execution components. Assistant copies exclude thinking and tool-call parts but retain Pi's abort, error, and truncation notices. An unpaired skill invocation appears as compact `/skill:name` shorthand; paired skill metadata yields the accompanying user message instead. A subdued separator appears between adjacent assistant answers, while any visible native row breaks adjacency.

Because membership comes from the live child list at render time, rows inserted by direct child splices are observed and visible by default. Native warnings, status feedback, bash output, and unknown or future rows therefore remain visible unless they match an exact exclusion. Mouse events are routed through the projected layout. If discovery, classification, rendering, invalidation, or mouse seams are incompatible, Calm restores native rendering rather than applying a partial filter.

## Disable worker tools

Configure tools unavailable to every Worker in `~/.pi/agent/settings.json`:

```json
{
  "pi-workgraph": {
    "worker": {
      "disabledTools": ["rename_resource"]
    }
  }
}
```

`disabledTools` is deduplicated and preserves unknown future tool names. `workgraph_report` and the implementation-only `workgraph_plan` are protected and cannot be configured here. Missing settings disable nothing; unreadable or malformed settings fail closed before the first request and leave only truthful failed reporting available. Role gates remain independent: research, review, and consultation cannot edit; experiments and implementations can edit; bash remains role-eligible.

## Releasing

Update the package version and the installation examples above, commit and push, then push the matching `v<version>` tag. GitHub Actions verifies the tag, installs and packs with pnpm, and publishes the verified tarball through npm trusted publishing. The npm CLI is only the OIDC publication transport; pnpm owns installation and packing.
