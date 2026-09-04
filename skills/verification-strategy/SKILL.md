---
name: workgraph-verification-strategy
description: Choose and execute evidence for a Workgraph product outcome, including repository-native and interactive verification routing.
---

# Verification strategy

Start with the completion predicate and identify the real product boundary it names.
Prefer a repository-native harness when it directly observes that boundary.
Use the project-local verification skill when the repository provides one.
Use the appropriate Workgraph control skill when the project skill cannot provide the required surface.
Return inconclusive when the required control surface is unavailable.
Distinguish direct evidence, inference, conflicts, and unknowns.
For blast-radius-sensitive changes, prove the external safety fact at the actual dependent boundary.
Keep read-only product verification separate from skills that create or maintain repository verification infrastructure.
