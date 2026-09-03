# Runtime forensics

## Purpose

Use this playbook to diagnose a symptom in a live process, such as a leak, spin, intermittent failure, stale state, or visual glitch.
The live system is the primary evidence surface.
Reading source can generate hypotheses, but source alone cannot establish the runtime cause.
The deliverable is a diagnosis and evidence package, not a fix.

## Completion predicate

The run is complete when a captured live signal is reduced to a specific mechanism, the mechanism is confirmed by a discriminating runtime observation, and the responsible source location is identified or explicitly unresolved.

## Step 1: `capture`

Define the symptom in observable terms, including trigger, timing, environment, and expected behavior.
Use the matching control surface to capture a real artifact before changing the process.
Examples include a CPU profile, heap snapshot, trace, console and network capture, process sample, stored-state snapshot, or screenshot sequence.
Preserve the raw artifact outside implementation-owned paths and record the exact revision and environment.
If the symptom is intermittent, increase observability or synthesize the trigger instead of substituting a guess.

## Step 2: `reduce`

Transform a large artifact into a queryable or summarized representation before loading it into coordinator context.
Use a bounded partitioned worker for parsing when the raw artifact would crowd out the reasoning context.
Reduce CPU evidence to the hot path, memory evidence to a retainer chain, waiting evidence to the blocked resource, and visual evidence to the smallest divergent event or frame.
Keep the raw path and the reduction procedure so another reviewer can reproduce the result.
Do not discard counterexamples or samples that disagree with the dominant pattern.

## Step 3: `perturb`

State the leading mechanism as a falsifiable hypothesis.
Run the smallest live perturbation that distinguishes it from the strongest alternative.
Examples include temporary instrumentation, controlled input changes, disabling one scheduler, changing one state value, or observing whether the suspected call stops.
Do not convert a plausible correlation into a confirmed cause without this step.
If the perturbation could damage data or cross authority, stop and obtain the relevant decision first.

## Step 4: `map`

Trace the confirmed runtime mechanism back to its owner in source.
Identify the file, symbol, allocation, scheduling point, state transition, or boundary that produces the signal.
Use partitioned discovery only when attribution crosses genuinely separate subsystems.
Use history evidence when the current behavior appears intentional and that intent would constrain a later fix.
If symbols or source maps are missing, state that limitation and do not overclaim attribution.

## Step 5: `report`

Report the captured symptom, reduced signal, discriminating observation, source attribution, confidence, and artifact paths.
Distinguish a confirmed mechanism from the strongest remaining hypothesis.
State the smallest likely correction boundary without implementing it.
Route a requested correction into Bug fix or Performance with this evidence as context.

## Failure and recovery

If the live surface cannot be reached, explain the specific missing capability and switch to Trace forensics only when a fixed artifact exists.
A failed capture is an explicit inconclusive result, not evidence that the symptom is absent.
Retain artifacts and commands across pause or session pickup so the next run does not repeat expensive collection.
