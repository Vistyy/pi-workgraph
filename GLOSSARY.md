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

**Experiment**:
An evidence-seeking Task whose contract grants each Attempt explicit bounded effects and a stop condition. It shares research model selection and reporting, but executes in a repository worktree and does not produce an applicable Candidate.

**Attempt**:
One execution of a Task. Trying the same Task again creates a new Attempt rather than changing the existing one.

_Avoid_: Run

**Worker**:
A delegated Pi session that executes one Attempt.

**Worker worktree**:
The detached repository worktree assigned as one repository Attempt's execution root. An Implementation Worker changes and commits only that worktree; its Task Target remains the Candidate's destination identity rather than an execution checkout.

**Outcome**:
The semantic result of an Attempt: a report, an unreported ending, or cancellation. It is distinct from repository output.

_Avoid_: Output

**Target**:
The directory or repository to which a Task applies. Every Attempt for that Task inherits the same Target.

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
