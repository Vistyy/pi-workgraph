---
name: workgraph-prototype
description: Optional composable guidance for prototype tasks when it matches the current outcome.
---

# Prototype

## Purpose

Use this skill to settle a consequential design, interaction, layout, timing, or integration question by observing a cheap throwaway artifact.
The prototype is a decision instrument, not an early production implementation.
Do not use this skill when the desired behavior and implementation shape are already established; route directly to Feature.

## Completion predicate

The run is complete when the deciding question has been observed on the matching surface, credible alternatives have been compared when necessary, one direction is recommended, and all prototype artifacts are clearly separated from production code.

## Step 1: `decision`

State the single decision the prototype must resolve.
Name the observation that would discriminate between credible outcomes.
If there is no unresolved empirical decision, skip the prototype and route to the applicable change skill.
Use a short evidence discovery lane to gather prior art or API constraints only when those inputs could eliminate an option before building.
Record expected prototype lifetime and cleanup location.

## Step 2: `build`

Build the smallest artifact that can produce the deciding observation.
Place it in an isolated scratch directory outside production source unless the agreement explicitly owns a prototype path.
The coordinator may use its normal tools for this scratch artifact because coordinator tool availability is stable, but it must not turn pre-agreement scratch work into product changes.
Use the lightest viable stack and avoid production abstractions, migration scaffolding, compatibility code, and durable tests.
Keep irreversible actions and real user data outside the prototype.

## Step 3: `compare`

When two or more options remain credible, expose them through one comparable surface with neutral labels.
Keep inputs, environment, and observation method equivalent across variants.
For a consequential judgment call, use replicated discovery to collect independent critiques of the same variants from two or three configured model families.
Use the full replicated panel only when reversal cost or ambiguity warrants it.
Account for every panel dropout and do not treat missing criticism as support.
Do not average variants into a compromised design when one coherent model is required.

## Step 4: `observe`

Drive the prototype on the matching product surface.
For visual work, retain screenshots at the relevant states and viewports.
For behavioral work, retain output, state transitions, network or console records, and failure observations.
For timing work, retain repeated measurements and enough context to distinguish signal from noise.
An assertion that bypasses the behavior being decided is not sufficient evidence.
If the observation is inconclusive, adjust the instrument or reduce the question instead of polishing the prototype.

## Step 5: `recommend`

Compare each option against the decision criteria and state one recommendation.
Record what was rejected and why, because rejected alternatives prevent later re-litigation.
State which observation would reverse the recommendation.
Delete the scratch artifact when it has no continuing review value, or preserve its path explicitly as evidence.
Route the chosen direction to Architecture when ownership remains open or to Feature when the shape is ready.

## Agreement and handoff

The prototype may happen before the implementation agreement only while it stays outside production source and remains reversible.
The implementation agreement must describe the chosen outcome without treating prototype code as an approved production design.
A worker implementing the real change receives the decision and evidence pointers, not the prototype's accidental structure.

## Failure and recovery

A prototype that cannot reach the matching surface is inconclusive.
Do not compensate by adding detail to a mock that does not exercise the deciding behavior.
After interruption, resume from the saved artifact and evidence instead of rebuilding unless the environment no longer matches.
