---
status: accepted
---

# Use TypeBox for schemas, Effect for lifecycles, and Node at host boundaries

## Context

Workgraph is a Pi extension built around Effect 4, but it also exchanges JSON with Pi, persists JSON in SQLite, and controls native host resources. Using every available library for every layer would create overlapping schema systems, adapters, and lifecycle models rather than remove complexity.

Pi 0.84.4 defines tool parameters as TypeBox `TSchema` values and derives handler input through `Static<T>`. Workgraph's tool contracts and persisted domain model also share evidence, model-target, and review-subject shapes. Effect Schema can emit JSON Schema, but making it the internal owner would leave TypeBox at the Pi boundary and introduce generated-schema typing, optional-property, strictness, and provider-compatibility obligations.

Effect provides the structured resource, interruption, concurrency, and platform-service model used by the coordination runtime. Some required host guarantees are not represented by those services: Effect's filesystem service has no `lstat`, SQLite file ownership and permissions remain application concerns, and Workgraph's child-process cleanup has stricter ownership semantics than the general platform process adapter.

## Decision

TypeBox is the single owner of Workgraph's structural JSON schemas. It owns Pi tool parameters, shared wire shapes, persisted Workstream state, configuration, protocol payloads, and narrow database-row decoding. Cross-record domain invariants remain explicit domain logic rather than being forced into a schema language.

Effect owns effectful application flow and resource lifetime. Runtime and persistence operations use Effect errors, interruption, `Scope`, `acquireRelease`, `Semaphore`, `FiberSet`, `FileSystem`, and `Path` where those capabilities apply.

Direct Node APIs are confined to narrow, documented host boundaries whose guarantees are not supplied more simply by the current Effect services. These include:

- `node:sqlite` for the private aggregate-and-lease transaction;
- no-follow filesystem identity checks and atomic private file creation or permissions;
- child-process ownership and shutdown behavior;
- synchronous host identity utilities such as paths, UUIDs, and hashes where introducing an Effect service would add no lifecycle or test benefit.

Each lint suppression for a Node built-in must identify the concrete host guarantee it owns. Ordinary effectful filesystem and path work should not bypass the existing Effect platform services.

Workgraph will not add Effect Schema or `@effect/sql-sqlite-node` for this design. The SQLite decision may be revisited if persistence grows materially beyond the private aggregate and lease tables, or if the official driver later removes more application code than it introduces.

## Consequences

- TypeBox remains an intentional peer dependency because Pi requires it; Effect remains the runtime and lifecycle dependency.
- Persisted and tool schemas can share definitions without translation or duplicate validation.
- The SQLite adapter remains small and native while exposing Effect-based operations to its callers.
- Native adapters require explicit ownership rationale and focused boundary tests.

## Alternatives considered

### Effect Schema internally and TypeBox only for Pi

Rejected because it retains TypeBox, splits shared schema ownership, and adds generated JSON Schema or duplicate boundary definitions. It does not remove Workgraph's relational domain invariants.

### Effect SQL for SQLite

Rejected for the current two-table persistence boundary. The matching Effect driver is itself a `node:sqlite` adapter, adds release-coupled package and scoped-client plumbing, and does not own Workgraph's private-file permissions or symlink fence.

### Direct Node APIs throughout

Rejected because it would duplicate Effect's existing lifecycle, interruption, filesystem, path, and concurrency capabilities and weaken the runtime's single structured ownership model.
