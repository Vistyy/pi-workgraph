# Type assertion evidence

Review TypeScript type assertions added or changed in the requested code scope, and existing assertions whose supporting validation changes. Ignore `as const` and quoted examples or deliberately failing test fixtures.

For each possible issue, trace the value from its source through the checks or contracts relied on at the point of use. Report an assertion when it claims a type or property the code has not established. If straightforward narrowing or decoding would establish the missing invariant, explain that concrete alternative. A `SAFETY:` comment or lint suppression is not evidence that the assertion is sound. Do not flag an assertion merely because it exists or demand runtime validation when a concrete static or host contract already establishes the needed invariant.

For each finding, cite the file and location, the missing evidence, the resulting risk, and the smallest sound alternative. If no such issue is substantiated, say so; disclose any relevant scope you could not inspect. Do not repeat a deterministic lint diagnostic without identifying the underlying risk.
