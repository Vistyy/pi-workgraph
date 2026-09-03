# Feature

## Purpose

Use this playbook for new product behavior or an intentional change to existing behavior.
The coordinator owns design, decomposition, evidence, and final judgment while bounded workers own implementation scopes.
Do not let a solution-shaped request substitute for establishing the desired outcome and ownership.

## Completion predicate

The run is complete when the approved outcome is implemented at one coherent ownership boundary, the composed revision is observed on the matching product surface, and assurance accepts behavior, structure, and evidence.

## Step 1: `understand`

Trace the affected subsystem from caller to observable result.
Use partitioned discovery for separate layers or services and evidence discovery for history or external contracts.
Identify existing capabilities that can provide the outcome before proposing custom machinery.
State observations, inferred constraints, and unknowns separately.
Ask the user only about decisions that depend on product intent, preference, or authority.
Do not broaden examples or preventive ideas into requirements without acceptance.

## Step 2: `design`

Name the observable outcome, non-goals, reuse decision, expected scale, owner, public interface, and verification boundary.
Use Architecture when several ownership or interface shapes are credible.
Use Prototype when a live observation can settle an interaction or integration decision cheaply.
Use Arena when multiple independent designs would expose a consequential shape choice.
Choose a state machine, registry, typed model, reducer, or other organizing structure only when the domain relationship requires it.
Assign every new invariant one owner and one enforcement boundary.
Present one complete agreement with no unresolved material decisions before implementation.

## Step 3: `decompose`

Declare the implementation DAG before launching workers.
Identify blocking foundations, independent workstreams, shared mutable state, and the smallest safe decomposition.
Parallelize disjoint paths or independently owned components.
Serialize real dependencies and pass upstream evidence into downstream briefs.
Split shared targets before adding synchronization where the domain permits it.
Use one node when decomposition would increase coordination or obscure one invariant owner.
For repeated fan-out, run a pilot unit first when a bad brief would multiply expensive errors.

## Step 4: `implement`

Give every worker a complete GOAL, SCOPE, CONTEXT, ACCEPTANCE, VERIFY, TIMEBOX, FORBIDDEN, and REPORT brief.
Workers cannot delegate and must not infer sibling results from unseen sessions.
Use Local Prewalk with the configured guide and executor roles.
Require one clean commit inside claimed paths and validate the commit independently.
Compose completed nodes in deterministic order against the current composed head.
If a worker discovers an envelope-changing need, stop only affected work and return that decision to the agreement boundary.
If a routine node fails, reconcile uncertain state before scheduling a bounded replacement.

## Step 5: `verify`

Run composed-root commands only when they directly observe the required behavior.
Schedule independent product verification for interactive, visual, judgment-laden, or otherwise unobserved outcomes.
Tie every verdict and artifact to the exact composed commit.
Treat implementation-worker evidence as provisional until the composed product is observed.
Run one behavior, one structure, and one evidence reviewer after product verification.
Have synthesis deduplicate candidates, then have the coordinator accept or dismiss each material finding.
A later correction invalidates affected evidence and must rerun product verification and assurance.

## Correction routing

Continue a local accepted finding from the original implementer session in a fresh worktree at the current composed head when practical.
Use a new integration node for a finding that crosses node boundaries.
Return an envelope-changing finding to the user rather than silently expanding scope.
Do not rerun the whole graph when only one bounded correction is required.

## Output

Report what behavior changed, the selected ownership and why, node-to-commit mapping, product evidence for the exact revision, retained durable checks, assurance decisions, and any explicitly deferred work.
