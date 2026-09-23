# Contributor map

Keep guidance with its owning document instead of duplicating it.

- `README.md` is the packaged human-facing introduction and operating guide. Read it when changing user-visible behavior, installation, or configuration.
- `COORDINATOR.md` owns cross-tool coordinator behavior. Operation-specific inputs, effects, receipts, and execution rules belong to their tool schemas, descriptions, or Worker policy; do not repeat them in the coordinator prompt.
- `DESIGN.md` describes the extension's integrated current design. Read it before changing architecture, persistence, lifecycle, tool boundaries, or resource ownership.
- `VERIFICATION.md` records project-specific evidence requirements not evident from code or ordinary commands. Read it before changing verification strategy or running live or destructive checks.
- `GLOSSARY.md` owns canonical project language. Read it before changing domain terms, relationships, or ownership.
- `RELEASING.md` owns the contributor release procedure. Read it before preparing or publishing a release.
- `docs/adr/` records focused architectural decisions and their rationale. Read the relevant ADR before changing its decision.

Package only what installed operation needs: runtime entry points and source, injected Coordinator guidance and its references, and the human-facing guide. Keep contributor instructions, design rationale, verification policy, domain language, and decision records in the repository rather than the npm package.

Production names and comments describe durable responsibilities, contracts, invariants, or safety facts, never delivery phases or change history.
