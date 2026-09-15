---
status: accepted
---

# Keep Prewalk in one live Worker trajectory

Implementation needs broad exploration before a bounded executor can finish reliably. A detached plan document would discard useful tool results and local reasoning, while running the guide through completion would retain its higher execution cost. The handoff therefore needs to preserve one real Pi trajectory without treating planning state as proof of correctness.

## Decision

One Implementation Attempt uses one Worker session with two policy phases. The guide inspects the immutable assignment, initializes one concise 1–9 item TODO, and makes the first useful direct edit or write in its assigned worktree. Initialization omits statuses; the runtime marks the first item `in_progress` and the rest `pending`. Items describe meaningful implementation or verification work with explicit validation, never reporting, bookkeeping, or ceremonial padding.

Cutover requires both the initialized TODO and one successful direct edit or write, in either order. Shell commands, observations, dirtiness, and failed mutations do not qualify. On cutover, Workgraph selects the policy-owned executor target and replaces guide policy on the next provider request while retaining the exact assignment, messages, tool results, TODO, and first edit. The phase changes even when policy assigns the same model and thinking level to both roles. Selection failure remains guide-owned, blocks further direct mutation, and is not retried automatically.

The executor continues that trajectory and updates individual TODO items as navigation. TODO status is neither evidence nor a completion gate. If the executor settles without a report while `pending` or `in_progress` items remain, Workgraph sends at most two follow-up reminders to continue useful work or report truthfully. Genuine context compaction restores the immutable assignment and current TODO from session history. A changed completion requires an executor assistant message after cutover and one terminal report.

The assigned Worker worktree is the fixed mutable execution root for both phases. Assignment repository paths map into it, and changing shell cwd does not expand authority. The Worker may inspect elsewhere and change the Git state needed to commit its worktree, but it may not modify another checkout or publish. This is a behavioral custody rule rather than a security sandbox.

## Consequences

- The executor inherits exploration and the first concrete change instead of starting from a summary.
- Model economics remain policy-owned; Workgraph claims a model switch only when guide and executor targets differ.
- TODO initialization and updates remain small, explicit trajectory events, while completion is established by evidence and report review.
- Bounded reminders provide liveness without creating an unbounded autonomous loop.
- Workgraph maintains no second phase database record; the session marker, model events, TODO results, and branch history are the recovery evidence.

## Rejected alternatives

Switching on a TODO alone can leave the executor before the trajectory contains a concrete implementation direction. Switching on an edit alone provides no bounded route through the remaining work. Fixed turn or token thresholds do not correspond to either condition. A separate immutable plan handoff loses the live exploration trajectory and prevents useful progress updates. Returning to the guide after cutover adds a second coordination loop without a supported responsibility. Treating TODO completion as acceptance would make model-maintained navigation state its own correctness oracle.
