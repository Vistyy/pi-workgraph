# Pi Workgraph

Delegate repository work from a normal [Pi](https://github.com/earendil-works/pi-mono) conversation, with workers in visible Herdr tabs and retained results you can inspect.

The coordinator chooses research, disposable experiments, implementation, and independent review as needed—not as a mandatory pipeline.

## Get started

You need Node.js 24+, Git, Pi, and a Herdr-managed pane with Herdr's Pi state integration installed.

From this checkout:

```bash
pnpm install --frozen-lockfile
pi -e /absolute/path/to/pi-workgraph
```

Describe the outcome you want and any constraints. You don't need to prescribe tools or worker counts.

The coordinator first uses `workgraph_intent` to establish the agreed goal and create its workstream. The repository defaults to the coordinator's cwd; `targetRepository` on that intent can select another repository, fixed for the workstream. Assignments inherit the scope and repository rather than defining them.

## How work is handled

- **Research and ordinary review** are read-only assignments in the selected repository and can see uncommitted files. An exact-revision review instead runs in an owned worktree at the named existing Git revision; it does not need a prior Workgraph result.
- **Consultation** is an optional evidence-only decision aid: `workgraph_consult` sends a precise question and known context through mandatory enrichment, then gives a fresh advisor the frozen bounded packet. Advice is non-authoritative and is never acceptance or a scope change. A policy advisor falls through only when no remote submission is possible/proven and the exact target has matching generation-bound `missing_model`, `missing_credentials`, or `unsupported_thinking` preflight evidence, or a trusted target-bound provider marker stating `unavailable` and `not_submitted`; the retained reason and visible warning identify the skipped target. Bare, generic, mismatched, malformed, or contradictory evidence never authorizes fallback, and an exact override never falls through. After possible submission, the outcome is uncertain and no duplicate advisor is launched. Advisor final evidence is plain terminal assistant text; enrichment is the only consultation tool.
- **Implementation and experiments** run in isolated Git worktrees. This is not a filesystem or security sandbox.
- **Results are retained, not automatically applied.** The coordinator judges the evidence and explicitly selects the exact attempt to apply. The runtime derives its source/root and verifies the live destination. A retained candidate can be corrected with `workgraph_implement` and `candidateOf`, or explicitly integrated onto a moved destination with `candidateOf` and an exact current `baseRevision`; applying a correction fast-forwards its complete direct history without squashing.
- **Unselected output stays available** until explicitly released. Stopping a worker does not mean accepting its result or discarding its experiment.
- **Completion assesses the goal**, with evidence and limitations. Operational failures and unapplied work remain visible automatically; settled workers alone do not establish that the goal was met.

Tool descriptions explain arguments and restrictions. For delegation and quality judgment, see the [coordination skill](skills/workgraph-coordination/SKILL.md).

## Everyday controls

**Less visual noise:** `/calm` hides thinking/reasoning and operational rows while keeping assistant answers and an ephemeral current-activity whisper plus the compact Workgraph indicator visible. The whisper reports typed coordinator activity, temporarily hides its detail while a blocking UI prompt is open, and resumes the same activity afterward; it never enters execution or model context. `/calm default on` saves the preference for new sessions.

**Models:** ask the coordinator to inspect or change defaults with `workgraph_models`. Research/review use `selection` for replication, diversity, and overrides; consultation uses the ordered advisor policy and may receive one complete exact advisor override; implementation uses `models.guide` and `models.executor` overrides. Omitted model/thinking components use role defaults. Per-assignment choices do not change saved policy.

**Pending items:** `workgraph_notepad` holds compact coordinator reminders. They are not approvals or completion gates.

For interrupted work or missing evidence, see [Recovery and inspection](OPERATIONS.md).

## Contributing

```bash
pnpm check       # Quality checks and deterministic tests; no model or Herdr calls
pnpm typecheck   # Independent compiler check
pnpm verify:package  # Pack/install the exact tarball in a disposable consumer (needs network)
pnpm verify:native   # Opt-in controlled Herdr/provider continuation check (requires HERDR_ENV=1)
```

`verify:native` is not part of the routine gate and must be run only with an operator-owned Herdr pane. It uses a loopback scripted provider, performs one bounded coordinator notification continuation, and retains uncertain native resources for reconciliation. Optional real-model observations remain task-specific rather than a maintained mechanical smoke gate.

[Contributor instructions](AGENTS.md) · [Design](DESIGN.md) · [Verification](VERIFICATION.md)
