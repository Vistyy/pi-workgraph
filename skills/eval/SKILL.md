---
name: workgraph-eval
description: Optional composable guidance for eval tasks when it matches the current outcome.
---

# Eval

## Purpose

Use this skill to measure how a prompt, instruction, model assignment, or orchestration variant changes agent behavior before adopting it.
The main threat is observer effect, because a candidate that knows the rubric or comparison purpose may behave differently.
Do not use this skill to compare ordinary product implementations when direct product verification can decide the outcome.

## Completion predicate

The run is complete when candidates ran under equivalent sanitized conditions, one blinded judge scored them on one private rubric, the coordinator inspected the actual outputs and sessions, and the recommendation states uncertainty and promotion criteria.

## Step 1: `rubric`

State the behavioral hypothesis and the specific variant under evaluation.
Define three to six concrete criteria that can be judged from produced artifacts and session behavior.
Keep the rubric private from candidates unless the criterion would naturally appear in an organic user request.
Name confounders such as model family, credentials, repository state, tool inventory, context length, and timing.
Decide the minimum number of candidates needed to separate the variant from ordinary model variance.

## Step 2: `sanitize`

Create one disposable environment per candidate with equivalent repository state and resources.
Use organic names and prompts that do not reveal words such as eval, judge, benchmark, candidate, score, or comparison.
Do not tell a candidate that other candidates exist.
Do not ask candidates to report which instructions or principles they followed, because self-report changes the behavior under measurement.
Keep the coordinator's private rubric and experiment notes outside candidate-visible paths.
If the current runtime cannot provide isolated blind candidate contexts for the behavior under test, stop and report that capability gap rather than claiming a valid eval.

## Step 3: `run`

Send every candidate the same organic task and allow only the intended variant to differ.
Use heterogeneous model assignments only when model robustness is itself part of the question; otherwise hold the model constant.
Keep writable candidate artifacts isolated and never compose them into the product repository.
Account for every candidate's terminal state, session path, model, usage, and artifact path.
A failed or unavailable candidate is a dropout, not a low score.
Do not inspect intermediate candidate output in a way that changes one run but not the others.

## Step 4: `judge`

Use one judge to score all candidates in a single pass so calibration remains stable.
Use neutral labels and hide model identity, variant identity, and directory clues.
Give the judge the private rubric and the actual output artifacts, not candidate self-assessments.
Require criterion-level scores, cited evidence, uncertainty, and a recommended result.
Use a different model family from the candidates when practical.
An unblinded or separately calibrated judgment is inconclusive and must be labeled as such.

## Step 5: `inspect`

Read every candidate artifact and the relevant session evidence yourself.
Check which instructions, files, tools, and branches the candidate actually used rather than trusting its summary.
Compare the coordinator's assessment with the blinded judge and investigate disagreements.
Recommend promotion only when the measured effect is material, repeatable enough for the decision, and does not introduce worse failure behavior.
Record the exact setup so a later run can reproduce or challenge the result.

## Failure and recovery

Do not repair one candidate's environment mid-run without applying the equivalent repair to all candidates and restarting the affected comparison.
Do not infer superiority from a smaller surviving sample after asymmetric dropouts.
After interruption, preserve blind labels and private metadata so resumption does not leak identities into the judgment.

## Output

Report the hypothesis, private rubric, environment contract, dropout accounting, criterion-level judgment, coordinator audit, uncertainty, and adoption recommendation.
Do not expose hidden rubric details to future candidate contexts when the eval will be repeated.
