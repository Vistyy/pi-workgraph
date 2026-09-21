---
status: accepted
---

# Own record schemas, effects, and host adapters

Workgraph is a Pi extension that accepts tool input, persists coordination records in SQLite, runs structured asynchronous lifecycles, and controls host resources. Those boundaries need one schema owner and clear effect ownership without introducing parallel representations.

## Decision

TypeBox is the single owner of structural JSON contracts. It defines Pi tool parameters, model policy, Worker reports, Task and Attempt specifications, and mutable Worker, output, and Outcome records. The same strict schemas decode every persisted JSON field when a supported read uses it. Relational and lifecycle invariants remain explicit domain logic rather than being encoded as a second schema system.

Persistence is one native SQLite file partitioned by exact Pi session. Strict tables store Tasks and Attempts. Task creation with its first Attempt, focused operational checkpoints, and write-once Outcome insertion use narrow transactions. The store has no in-memory aggregate copy, revision protocol, or lifecycle authority outside those rows.

Effect owns asynchronous control flow, typed operational failure, interruption, serialization, scoped acquisition and release, fibers, queues, and resource finalization. The core remains Effect-native; Pi callbacks are the narrow Promise boundary.

Direct host APIs are confined to adapters with a concrete guarantee:

- `node:sqlite` owns the small record transaction boundary;
- filesystem calls own private path creation, permissions, real-path and no-follow identity checks;
- Effect's child-process support owns Git process lifetime and interruption;
- Pi session and Herdr adapters own their exact native protocols;
- synchronous host utilities provide paths, cryptographic IDs, and hashes where a lifecycle abstraction would add no guarantee.

Each direct Node use documents the guarantee that keeps it at that boundary. Workgraph does not add Effect Schema or an SQLite framework around the small fixed record store.

## Consequences

- Tool input, persisted JSON, and report records share one schema vocabulary without translation.
- SQLite code stays record-oriented and small while callers retain Effect composition and typed failure.
- Host adapters can prove resource-specific identity and cleanup facts without spreading native APIs through coordination logic.
- Cross-record invariants need focused domain checks in addition to structural decoding.
- A broader persistence library is justified only if the supported relational model grows enough for it to remove more code and obligations than it adds.

## Alternatives

Effect Schema plus TypeBox at the Pi boundary would retain two schema systems and add conversion obligations without owning relational invariants. A general SQLite layer would add client and resource plumbing around a small fixed set of tables while leaving file ownership checks in application code. Direct Node APIs throughout would weaken structured interruption and resource lifetime ownership.
