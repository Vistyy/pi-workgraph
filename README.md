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

Describe the outcome you want and any important constraints. Workgraph fixes one repository for that effort, delegates only when useful, and retains evidence and implementation output for the coordinator to inspect.

Research and ordinary review can inspect the live repository, including uncommitted files. Implementation and authorized disposable experiments use isolated worktrees; these are ownership boundaries, not security sandboxes. Results remain unapplied until the coordinator has inspected them and deliberately integrates the selected output.

Workgraph stores each operational Workstream in a private SQLite database below the repository's Git common directory. Delegated Pi session history is retained separately under `pi-workgraph/worker-sessions/<workstreamId>/`; operational Workstream cleanup does not imply deleting or relocating that session history.

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

`disabledTools` changes model tool availability for workers; it does not prevent extensions, hooks, commands, skills, or context from loading.
