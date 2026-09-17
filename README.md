# Pi Workgraph

Pi Workgraph lets a Pi Coordinator delegate work to visible Workers in Herdr tabs. It supports read-only evidence gathering, consultation, bounded experiments, implementation in isolated Git worktrees, and review of relevant material.

Repository changes return to a session-owned Coordinator checkout for evaluation before any final integration or publication.

## Install

Requirements: Node.js 24+, Git, Pi, and a Herdr-managed Pi pane with Herdr's Pi state integration.

Install the published npm release:

```bash
pi install npm:@syzom/pi-workgraph@0.4.0
```

Or install the matching GitHub release:

```bash
pi install git:github.com/Vistyy/pi-workgraph@v0.4.0
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

Create `~/.pi/agent/workgraph/models.json`. Workgraph supplies no model defaults and never rewrites this file.

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
    "consultation.advisor": {
      "model": "provider/advisor-model",
      "thinking": "medium"
    }
  }
}
```

Replace every example ID with a model configured in Pi. Thinking may be `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

| Role | Selection |
| --- | --- |
| Research and Review | Ordered nonempty lists. The first target is the default; additional entries permit model-diverse initial Attempts. |
| Consultation | One advisor target. |
| Implementation | One guide and one default executor. |
| Escalation executor | Optional; used only when the Coordinator explicitly requests it. Creation fails if it is requested but absent. |

Selections are frozen into each Attempt. Its Outcome records the models Pi actually used.

## Supported workflow

```text
user request
  → Coordinator
      ├── read-only work → Task and Attempt → evidence
      └── repository mutation → Coordinator checkout
                                 → Task and Attempt
                                 → retained Candidate
  → Coordinator evaluation
  → applicable Maintainer inspection and Human sign-off
  → explicit delivery route
```

Before repository mutation, the Coordinator calls `workgraph_checkout`. The returned branch-backed checkout starts from committed `HEAD` without changing the source checkout or copying its uncommitted files.

Implementation Workers use detached worktrees. Their committed results can become retained Candidates, which the Coordinator may apply into its managed checkout with `workgraph_control`.

Workgraph does not perform final integration or publication. When an accepted change reaches the delivery boundary, the Coordinator follows the packaged [delivery procedure](references/delivery.md) to classify the [Human sign-off requirement](references/delivery.md#resolve-human-sign-off), use a designated local Maintainer-inspection capability when applicable, recommend a route, and carry out only the selected route's authorized effects. Without an explicit route, it waits for the user's choice.

## Task types

| Task | Purpose | Effects and repository result |
| --- | --- | --- |
| Research | Answer an evidence-seeking question. | Read-only; no repository output. |
| Consultation | Obtain decision-oriented advice from the configured advisor. | Read-only; no repository output. |
| Review | Assess a natural-language request against relevant accessible material. | Read-only; no repository output. |
| Experiment | Gather evidence through explicitly permitted effects before a hard cutoff. | Uses a detached worktree; commits may be retained for inspection but never become applicable Candidates. |
| Implementation | Propose a repository change for Coordinator evaluation. | Uses a detached worktree; committed changes may become a Candidate. |

For read-only Tasks:

- `cwd` is placement and starting context—not evidence scope, provenance, subject, or authority;
- Review may assess uncommitted, mutable, partial, conceptual, report, comparative, Attempt-related, or committed material; and
- an exact revision is required only when the request depends on one.

Every Experiment Attempt independently receives its permitted effect kind, scope, and lifetime:

- begin an effect only when its complete lifetime, including authorized teardown, fits the cutoff;
- give a success-only condition a bounded exhaustion cutoff when needed; and
- do not assume automatic deadline enforcement, rollback, or cleanup authority after cutoff.

A completed Experiment relinquishes uncommitted scratch. Durable observations belong in its report, a commit, or another explicitly permitted artifact.

## Tasks, Attempts, and Outcomes

A Task has one immutable purpose and resolved target. Each Attempt is one fresh execution of that unchanged assignment in a new Worker session.

Use `workgraph_attempt` to try the same Task again. Create a new Task when the question, requested result, context, acceptance conditions, or authority changes.

Worker reports use these statuses:

| Status | Meaning |
| --- | --- |
| `completed` | A truthful bounded result, including negative, inconclusive, or no-change results. It is not approval. |
| `needs_decision` | A consequential Coordinator decision or additional authority is missing. |
| `failed` | The Attempt could not satisfy its operational or contractual requirements. |

Completed Implementation reports also state `changed` or `no_change`. The runtime adds the exact Worker role to every report.

## Repository output and custody

A completed repository Attempt retains only committed `HEAD`:

- unchanged `HEAD` produces no output;
- changed `HEAD` is retained at `refs/pi-workgraph/outputs/<attemptId>`; and
- the detached worktree is removed.

Uncommitted files are execution scratch and are relinquished by a completed report. Dirty worktrees from noncompleted Attempts and uncertain resources remain available for inspection.

Implementation Attempts may start independently, extend a retained Candidate, or integrate one onto another base. Applying or discarding output is always an explicit `workgraph_control` action.

A Worker may modify only its assigned worktree and the Git state needed to commit it. Changing shell directories does not expand that authority. Worktrees and tool policy establish custody, not a security sandbox.

## Coordinator tools

| Tool | Purpose |
| --- | --- |
| `workgraph_checkout` | Create or exactly reuse this session's deterministic Coordinator checkout. |
| `workgraph_research` | Create a read-only Research Task. |
| `workgraph_experiment` | Create an Experiment with explicit effects and a hard cutoff. |
| `workgraph_consult` | Ask the configured advisor a question. |
| `workgraph_implement` | Create an Implementation Task and its first Attempt. |
| `workgraph_review` | Assess a natural-language request against accessible material. |
| `workgraph_attempt` | Create another Attempt for an unchanged Task. |
| `workgraph_inspect` | Inspect bounded Task, Attempt, Outcome, and operational records. |
| `workgraph_control` | Cancel or steer a Worker, or apply or discard exact repository output. |
| `workgraph_notepad` | Read, replace, or clear the current branch's bounded Coordinator memo. |

## Session persistence

Each Coordinator session owns its records. Sessions share one private SQLite database under the Pi agent directory, partitioned by exact session identity; one session cannot enumerate another's records.

Stopping or reloading the Coordinator stops only its coordination activity. It preserves:

- Coordinator checkouts;
- independent Worker sessions and Herdr tabs;
- retained repository output; and
- uncertain resources.

The notepad stores at most 4,000 characters on the current Pi branch and restores a nonempty memo after genuine context compaction. It is pending memory only: it grants no authority and establishes neither acceptance nor correctness.

## Calm presentation

Calm is Coordinator-only and on by default.

- `/calm` toggles the current session.
- `/calm default on|off` saves the startup default for new Coordinator sessions.

Calm projects the live Pi chat without changing the source transcript:

- hide Workgraph Outcome rows and model tool-execution components;
- omit assistant thinking and tool calls; and
- preserve prose, terminal notices, native warnings, status feedback, bash output, and unknown rows; and
- show an unpaired skill invocation as `/skill:name`, while paired skill metadata yields its accompanying user message.

Mouse interaction follows the projected layout. If Calm cannot safely use Pi's presentation seams, it restores the complete native rendering rather than applying a partial filter.

## Disable Worker tools

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

`disabledTools` is deduplicated and may contain unknown future tool names. `workgraph_report` and the Implementation-only `workgraph_plan` cannot be disabled here.

Missing settings disable nothing. Unreadable or malformed settings fail closed before the first request and leave only truthful failed reporting available.

Role gates remain independent:

- Research, Review, and Consultation cannot edit;
- Experiment and Implementation can edit; and
- bash remains role-eligible.

## Supported limits

- One Coordinator process may operate a given Pi session at a time.
- Concurrent mutation of the same destination checkout or ref is unsupported.
- Multi-repository effects are independent; Workgraph provides no cross-repository transaction or rollback.
- Worktrees and tool gates are not security sandboxes.
