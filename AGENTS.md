# Contributor map

This repository separates package-user guidance, coordinator instructions, architectural rationale, and verification policy. Update the owning document instead of duplicating guidance.

- `README.md` is the packaged human-user entry point: installation, model configuration, user-visible behavior, and human-facing settings.
- `COORDINATOR.md` is packaged behavior injected into every coordinator system prompt. It owns Workgraph workflow, delegation judgment, integrated-result quality, and the coordinator's handoff responsibility; tool descriptions own individual operation contracts.
- `DESIGN.md` is repository-only and owns durable rationale. Read it before changing coordination workflow, tool interfaces, persistence, resource ownership, or architecture.
- `VERIFICATION.md` is repository-only and owns project-specific evidence boundaries. Read it before choosing checks, changing verification strategy, or running a live scenario.

Keep `AGENTS.md`, `DESIGN.md`, and `VERIFICATION.md` out of the npm package. Runtime source, `COORDINATOR.md`, and the root README belong in the package.
