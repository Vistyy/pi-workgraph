# Workgraph

Canonical language for delegated Workgraph coordination and repository output.

## Language

**Coordinator**:
The Pi session responsible for understanding the user's goal, making consequential decisions, delegating where useful, and accepting the final result. It owns its Tasks, Attempts, and Coordinator checkouts.

**Coordinator checkout**:
A deterministically named branch-backed Git worktree created or exactly reused on a Coordinator's explicit request as that session's mutable integration destination for one repository. Direct Coordinator changes and Worker Candidates converge there before integration or publication through normal repository tooling; it is not a persisted Workgraph record.

_Avoid_: Workspace

**Task**:
A durable assignment with one purpose and exact Target. A Task may have multiple Attempts.

_Avoid_: Workstream

**Research**:
A read-only evidence-seeking Task with a question and optional context and expected evidence.

**Consultation**:
A read-only advice Task with a question and optional context, executed by the policy-selected advisor frozen into its Attempt.

**Review**:
A read-only Task expressed as a natural-language request with optional context. It may assess relevant accessible material without requiring a typed subject, provenance chain, or exact revision unless its request depends on one.

**Human sign-off**:
The final-integration classification defined by the packaged [delivery procedure](references/delivery.md#choose-a-delivery-route).

_Avoid_: Human review

**Maintainer**:
The human who gives or withholds Human sign-off. It is distinct from a Worker performing a Review.

**Experiment**:
An evidence-seeking Task whose contract independently grants each Attempt explicit effect kind, scope, and lifetime plus a hard stop cutoff. It shares research model selection, executes in a repository worktree, and does not produce an applicable Candidate.

**Attempt**:
One execution of a Task. Trying the same Task again creates a new Attempt rather than changing the existing one.

_Avoid_: Run

**Worker**:
A delegated Pi session that executes one Attempt.

**Worker worktree**:
The detached repository worktree assigned as one repository Attempt's execution root. An Implementation Worker changes and commits only that worktree; its Task Target remains the Candidate's destination identity rather than an execution checkout.

**Outcome**:
The semantic result of an Attempt: a report, an unreported ending, or cancellation. It is distinct from repository output.

**Worker report**:
A strict terminal narrative containing status, summary, details, and a runtime-injected exact role. `completed` is a bounded result rather than approval; `needs_decision` identifies missing consequential Coordinator choice or authority; `failed` identifies operational or contract inability.

_Avoid_: Output

**Target**:
The directory or repository to which a Task applies. Every Attempt for that Task inherits the same Target. For read-only roles, its resolved cwd is starting context rather than evidence scope, subject, provenance, or authority. For Experiment it identifies the repository whose committed base seeds the owned detached worktree.

**Candidate**:
A clean retained implementation repository output for which Workgraph can prove the exact producing Attempt, root, tip, and lineage. It may be reviewed, used as the source of a successor Candidate, applied, or discarded.

**Candidate lineage**:
The immutable relationship between a Candidate-producing Attempt and an exact source Candidate. Extension starts the successor Attempt at the source tip and preserves its root; integration starts from another explicit base and records the source tip to incorporate.

**Repository output**:
The commits, if any, produced by an Attempt together with Workgraph's custody state for them. Ignored, untracked, and uncommitted worktree bytes are execution scratch rather than repository output; a completed report relinquishes them.

_Avoid_: Outcome

**Calm**:
The Coordinator's filtered presentation of Pi's live conversation. Calm changes presentation without changing the native transcript.

**Notepad**:
A bounded, branch-local memo for pending Coordinator context. It is not Task state, evidence, authority, or acceptance.
