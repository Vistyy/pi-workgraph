# Pi Workgraph

Pi Workgraph lets Pi coordinate repository work through workers in visible Herdr tabs. It can gather evidence, seek a second opinion, implement changes in isolated Git worktrees, and review retained results without applying them automatically.

## Install

Requirements: Node.js 24+, Git, Pi, and a Herdr-managed Pi pane with Herdr's Pi state integration.

```bash
pi install git:github.com/Vistyy/pi-workgraph
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

Before using Workgraph, create `~/.pi/agent/workgraph/models.json`. It must be a complete version 6 policy. Workgraph supplies no model defaults and never rewrites this file.

```json
{
  "version": 6,
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

Research, review, and consultation advisors are ordered lists; the first target is the default. Implementation guide and executor are single targets. Additional list entries let the coordinator choose another configured model when a task benefits from it. Thinking levels always come from this policy.

## Use Workgraph

Describe the outcome you want and any important constraints. A Workstream owns that initiative rather than a repository. Each immutable Task records its resolved directory or repository target, so one Workstream may coordinate several repositories without claiming cross-repository transactions, rollback, or all-or-nothing application.

Directory Tasks run at their recorded path and produce no Git output. Repository Tasks record their checkout root and Git common directory. Their Attempts use detached worktrees below the Pi agent data directory; useful clean output is retained at a private `refs/pi-workgraph/outputs/<workstream>/<attempt>` ref until deliberately applied or discarded. These are ownership boundaries, not security sandboxes.

Each Workstream has one private SQLite database at `<agentDir>/workgraph/workstreams/<workstreamId>/workstream.sqlite`. Worker session history is retained separately below the agent data directory. An Attempt persists its Pi `sessionFile`, while Herdr remains authoritative for current tab, pane, and terminal identity. Only the uninterrupted call that creates and checkpoints a fresh session launches it; later recovery observes the exact session or uniquely labelled partial tab and never relaunches it. An Outcome is recorded from semantic Worker-session evidence before ordinary Worker closure; delivery and retained-output settlement remain independent of Workstream completion. Cancellation and normal settlement each issue close at most once. If the process stops between the durable cancellation/Outcome record and that close, the user must deliberately close the retained resource before Workgraph can observe absence and finish closure.

`workgraph_handoff(request, includeContext?)` launches one independent child coordinator from the current coordinator cwd. It creates a fresh parentless Pi session with the default model configuration and has no parent Task, persisted launch lifecycle, result channel, automatic retry, or completion obligation. Treat an interrupted or failed launch as uncertain: retain the child session and known native resources rather than cleaning up or retrying.

## Calm presentation

`/calm` hides model tool executions and the Workgraph workstream/attention rows, then shows your messages, assistant prose, and compact skill invocations. Rows Pi adds through the chat lifecycle that Calm observes stay visible by default, including native Pi warnings and errors, cache/status/summary feedback, user-entered bash output, and unknown or future components. Assistant prose drops thinking and tool-call parts but keeps Pi's abort, error, and truncation notices. Pi currently inserts its streaming custom-entry row by splicing the chat directly, bypassing that lifecycle, so such a row stays in the native transcript while Calm is on. A subdued separator appears between adjacent assistant answers, and any visible native row breaks that adjacency. Coordinator activity stays in a bounded rail above the editor. `/calm default on` saves that preference for new coordinator sessions.

## Disable worker tools

Configure tools unavailable to every worker in `~/.pi/agent/settings.json`:

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
