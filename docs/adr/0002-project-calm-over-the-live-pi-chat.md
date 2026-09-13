---
status: accepted
---

# Project Calm over the live Pi chat

Calm must hide a narrow class of coordinator noise while preserving Pi's native transcript, unfamiliar rows, streaming state, terminal notices, layout, and mouse behavior. Pi's public component imports are not sufficient for reliable classification because a running bundled CLI may use private class instances.

## Decision

Calm binds to the exact live chat container discovered from the running Pi instance and validates constructors loaded from that same runtime. Its entire mutation surface is a three-instance-seam adapter over that chat's `render`, `invalidate`, and `handleMouse` methods. It does not patch component prototypes or alter source children.

On every Calm-on render, the adapter traverses the current live child list and rebuilds an extension-owned projection container. Render-time membership means direct `children` splices are observed without lifecycle hooks. Classification is exact and exclusion-based:

- live tool-execution instances are hidden;
- custom messages are hidden only when guarded metadata has `customType` equal to `pi-workgraph-outcome`;
- assistant copies contain visible text parts and Pi terminal notices, but no thinking or tool-call parts;
- unpaired skill invocations use compact `/skill:name` user components;
- native user rows and every unknown or otherwise unclassified row pass through unchanged;
- adjacent projected assistant answers receive a subdued separator, and any visible intervening row breaks adjacency.

WeakMap caches bind each source assistant to its projected assistant and each unpaired skill row to its synthetic shorthand. Snapshot comparison updates a projected assistant only when visible text, terminal state, streaming state, or presentation dependencies change. Pi continues to update the native source assistant while it is hidden, so disabling Calm immediately reveals an up-to-date native transcript without reconstruction.

The wrapped invalidation always invalidates the native chat and, while enabled, the projection. The wrapped mouse method dispatches against projected geometry. Rendering and mouse failures restore and use the native methods. Discovery, constructor loading, metadata classification, or seam incompatibility disables Calm for that attachment and restores only methods still owned by the adapter; there is no partial filtering mode.

## Consequences

- Calm depends on a small guarded set of Pi internals and fails visibly to native presentation when they change.
- Current native children are detected at render time, including direct child splices and unknown future rows, which favors visibility and compatibility over maximum quiet.
- Source native components continue receiving updates while hidden; this retains Pi correctness at the cost of that native update work.
- Pass-through rows keep their native render cost, while excluded model executions are not rendered by the projection.
- WeakMap caches avoid owning source lifetimes and avoid rebuilding unchanged projected assistants or skill shorthand.
- A native invalidation may also reach a reused pass-through child through the projection, producing a rare duplicate invalidation. Invalidation is required to be harmless, so this is accepted in exchange for simple, correct theme and width propagation.
- Mouse routing follows what Calm renders rather than hidden native layout.
