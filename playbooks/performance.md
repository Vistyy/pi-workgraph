# Performance

## Purpose

Use this playbook for a measured latency, throughput, CPU, memory, I/O, startup, or responsiveness problem.
The measurement story controls the work.
Do not optimize from source inspection alone or keep changes whose effect is indistinguishable from noise.

## Completion predicate

The run is complete when a realistic baseline identifies a dominant cost, one mechanism-specific change materially improves the agreed metric under comparable conditions, behavior remains correct, and the exact composed revision has retained before-and-after evidence.

## Step 1: `baseline`

Define the metric, workload, environment, warmup, repetition count, and acceptable threshold.
Capture a baseline on the matching surface before changing code.
Use Runtime forensics when a live process must be instrumented and Trace forensics when a fixed capture already exists.
Preserve raw artifacts and a repeatable collection command or procedure.
Measure variance so a later delta can be distinguished from noise.
Do not substitute a microbenchmark when the reported cost occurs at an integration boundary unless the relationship is established.

## Step 2: `trace`

Reduce the measurement to the dominant path, wait, allocation, query, transfer, or rendered frame.
Use partitioned discovery to ground only the owners that appear on that path.
Consider elimination before optimization by asking whether the work must run at all.
Use mechanism families such as reduced input, caching with explicit invalidation, batching, scheduling, lazy work, indexing, or parallelism only as hypothesis generators.
A strategy earns an implementation attempt only when the trace exhibits its expected signal.
State operational trade-offs such as memory growth, staleness, load amplification, or tail risk.

## Step 3: `hypothesize`

State one falsifiable mechanism and the expected movement in the agreed metric.
Identify the invariant that must remain true and the smallest code boundary that can test the hypothesis.
Use Architecture if the change moves ownership, introduces shared state, or adds an invalidation contract.
Use Prototype when a small isolated experiment can reject an expensive direction before production implementation.
Define the before-and-after comparison and stopping threshold in the agreement.
Reject bundled optimizations because they hide which mechanism caused the movement.

## Step 4: `change`

Implement one bounded change per measurable hypothesis.
Give the worker baseline artifacts, hot-path source pointers, expected metric movement, behavior acceptance, and forbidden unrelated optimization.
Run node checks for correctness, but reserve performance judgment for composed-product measurement.
If the metric does not advance beyond noise, discard or revert the change rather than leaving it as speculative complexity.
For multiple independent hypotheses, test sequentially unless their effects and paths are truly separable.
Keep measurement instrumentation only when it has enduring operational value.

## Step 5: `compare`

Capture the post-change measurement under equivalent conditions.
Prefer interleaved or repeated before-and-after runs when environmental drift is material.
Compare raw and reduced artifacts, report absolute and relative delta, variance, and any resource trade-off.
Run product verification for functional behavior as well as the metric.
Use behavior assurance for correctness and operational regressions, structure assurance for complexity cost, and evidence assurance for measurement validity.
Treat an inconclusive or wrong-surface result as not verified.

## Failure and recovery

A noisy benchmark is an instrument problem, not permission to declare a win.
Improve isolation, sample size, or metric choice before adding code.
A regression in another material resource invalidates the optimization unless the trade-off was approved.
After interruption, preserve environment metadata and artifact paths so resumed measurements remain comparable.

## Output

Report baseline, post-change result, absolute and relative delta, variance, raw artifact paths, confirmed mechanism, behavior evidence, complexity cost, and exact revision.
