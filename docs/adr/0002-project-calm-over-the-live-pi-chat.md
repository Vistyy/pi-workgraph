---
status: accepted
---

# Project Calm over the live Pi chat instead of filtering Pi components

## Context

Calm shows the coordinator conversation without operational rows: user messages, assistant prose, compact skill invocations, and subdued separators between adjacent assistant answers. The earlier implementation patched several Pi component prototypes (`ToolExecutionComponent`, `CustomMessageComponent`, `AssistantMessageComponent`, `UserMessageComponent`), hid a configured tool-name list, filtered assistant thinking by rewriting the message handed to Pi's renderer, and inserted separators by re-rendering the whole native child list on every frame.

That approach depended on name/type lists that miss arbitrary built-in and third-party rows, leaked presentation filtering into Pi's own component state, and classified and rendered the full native transcript on animation frames. It also had to retrofit assistant thinking visibility onto native components rather than owning a separate presentation.

Pi's live chat is an internal layout detail. The inspected 0.84.4/0.85.1 interactive mode mounts a document `Container` whose third child is the chat `Container`; chat mutation flows use `addChild`, `removeChild`, and `clear`. Pi 0.85.1 adds `Container.handleMouse` and `mouseLayout` for mouse dispatch. A bundled Pi CLI loads private copies of its presentation classes, so statically imported public `@earendil-works` classes compare unequal to the live instances.

## Decision

Calm owns one guarded compatibility adapter bound to the exact live chat instance. It loads the presentation classes from the module the running Pi entrypoint actually uses, validates them, and injects them into discovery, classification, and the projection; a load failure disables Calm rather than classifying with public classes that the live chat never instantiates. Discovery validates the inspected TUI root layout and fails visibly when it changes. The adapter keeps a separate extension-owned projection `Container` derived from the live assistant's parent `Container` and wraps only the chat instance's `render`, mouse dispatch, invalidation, and child-lifecycle methods:

- Membership is maintained incrementally from those lifecycle calls, seeded once from the existing children. Each direct child is either a semantic user message, an assistant record with visible prose, a skill invocation, or excluded. No tool, custom-message, warning, or summary name list is required.
- Streaming assistant updates flow through the same instance `updateContent` seam that Pi uses. While Calm is on, the hidden native assistant is not rebuilt for deltas: the adapter retains the latest source and streaming state and restores the native tree before Calm off, detach, or shutdown, so text and thinking streaming never build both native and projected assistant trees.
- Projection membership and separators are rebuilt only when an entry's visibility or membership changes, so ordinary prose deltas update only the current projected assistant.
- Skill pairing reads the guarded `skillBlock.userMessage` metadata rather than the next sibling. A skill-only invocation renders a compact `/skill:name` line; an accompanying user message is shown and the injected skill block is hidden.
- Truncation, abort, and provider-error notices rendered by Pi's assistant component are operational rows and stay out of the projected conversation; they remain untouched natively and reappear when Calm is off.
- The projection renders only its own children and follows native chat invalidation, so theme and width changes cannot leave projected copies stale. `Container.render`/`handleMouse` are never run over the native transcript on render frames, and the native children are untouched when Calm is off.
- Calm state is pushed into the adapter with `setEnabled`. Disabling, detaching, shutdown, and any discovery, binding, classification, or seam failure restore native rendering, mouse dispatch, and Pi's working indicator; failures are reported as Calm unavailable and `/calm` refuses to re-enable filtering in that session. Cleanup restores only seams the adapter still owns.

The rail, status text, session preference, and worker accounting remain independent Calm chrome driven by extension events. Worker count and semantic activity publication are equality-guarded, and the animation timer requests a frame only when the visible pulse changes.

## Consequences

- Calm depends on a small, inspected set of Pi internals. The adapter validates each seam and fails open; it does not degrade into partial filtering.
- Assistant thinking is excluded by projection rather than by mutating the message Pi renders, so Calm-off preserves native thinking behavior without restoration bookkeeping.
- Pi's own per-frame cost of rendering native children remains when Calm is off. Calm-on frames render only the semantic projection.
- A caller that mutates `chat.children` directly with `push`/`splice` bypasses the owned lifecycle seams; such a row stays native-only and is deliberately not scanned or projected.
