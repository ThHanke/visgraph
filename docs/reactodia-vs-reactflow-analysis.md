# Reactodia vs React Flow: Performance Architecture Analysis

**Date:** 2026-04-07
**Scope:** Why reactodia renders knowledge graphs faster than visgraph's current React Flow implementation, and what notable architectural features it offers.

---

## 1. Executive Summary

The fundamental difference is ownership of the rendering pipeline.

**Reactodia** owns its own rendering pipeline end-to-end. It controls when elements are created, when they update, how events are routed, and how layout runs. Every layer of the system is designed around one goal: minimize unnecessary work.

**React Flow** is a general-purpose library that wraps React's reconciler. It provides a good default experience and handles many concerns automatically, but that abstraction comes at a cost: update propagation, event handling, and rendering decisions go through RF's own internal machinery before reaching your components. You cannot short-circuit it.

The practical result: reactodia can render and interact with knowledge graphs containing thousands of nodes at 60 FPS where React Flow begins to feel sluggish. The gap widens as graph size increases because reactodia's optimizations compound (fewer re-renders, fewer allocations, no scheduler overhead), while React Flow's internal costs grow linearly.

---

## 2. Rendering Architecture Comparison

| Aspect | Reactodia | Visgraph (React Flow) |
|---|---|---|
| **Rendering primitives** | SVG `<path>` for edges, HTML DOM for nodes — direct, no wrapper components | React Flow's `<NodeRenderer>` and `<EdgeRenderer>` wrappers around your components |
| **Update model** | 7-layer dependency DAG; only affected layers run | React reconciler; any state change triggers diff from root |
| **Batching** | Custom `Debouncer` — coalesces all changes per `requestAnimationFrame` tick | React 18 automatic batching — good, but no rAF coordination |
| **Element memoization** | WeakMap caches the `React.ReactElement` objects themselves | `memo()` skips re-renders but still allocates new element objects every pass |
| **Per-element update granularity** | Bitwise `RedrawFlags` — each element tracks exactly what needs updating | Binary: re-render or skip (no partial update within a component) |
| **Hit-testing** | Walk DOM tree via `data-element-id` / `data-link-id` attributes — O(depth) | React Flow's synthetic pointer event system — goes through React's event delegation |
| **Layout computation** | Web Worker via `@reactodia/worker-proxy` RPC — truly off main thread | ELK/Dagre — async Promise but runs on main thread |
| **Z-ordering** | Explicit layer containers (`underlay`, `overLinkGeometry`, `overLinks`, `overElements`) | CSS z-index on React Flow's internal layer divs |
| **Viewport transform** | `PaperTransform` with GPU-accelerated CSS `scale()`/`translate()` | React Flow's `transform` via `useViewport()` — similar, but more indirection |

---

## 3. Reactodia's Key Performance Techniques

### 3.1 — 7-Layer Rendering Pipeline
**File:** `src/diagram/renderingState.ts`

Reactodia processes renders through a strict dependency chain:

```
Element → ElementSize → LinkRoutes → PaperArea → Link → LinkLabel → Overlay
```

Each layer only runs when its inputs change. A node position change triggers `LinkRoutes` recalculation, but a node label change does not. Changes in later layers never propagate backwards. This is a DAG, not a reactive graph — no cycles, no cascading.

Layers are synchronized via `flushSync()` to batch all React updates within a layer into a single commit. Between layers, a `scheduleOnLayerUpdate()` debounce prevents runaway churn.

**Why it matters:** React Flow's update model has no equivalent concept. Any state change goes through React's reconciler, which diffs the entire component tree. Reactodia's pipeline skips layers that have nothing to do with the change.

---

### 3.2 — requestAnimationFrame Batching
**File:** `src/coreUtils/scheduler.ts`

```typescript
class Debouncer {
    // Uses requestAnimationFrame by default, not setTimeout(0)
    schedule(callback: () => void): void {
        if (this.scheduled === undefined) {
            this.scheduled = requestAnimationFrame(() => {
                this.scheduled = undefined;
                callback();
            });
        }
    }
}
```

All change requests within the same frame are coalesced into a single update. If 50 node positions are updated in rapid succession (e.g., during a force layout tick), only one render pass runs per frame.

`BufferingQueue` extends this for batched item processing, useful when adding many nodes incrementally.

**Why it matters:** React 18's automatic batching is good but doesn't align with the browser's rendering cycle. Reactodia's `Debouncer` ensures updates happen exactly once per animation frame — no more, no less. Visgraph has no equivalent coordination layer.

---

### 3.3 — WeakMap React Element Memoization
**Files:** `src/diagram/elementLayer.tsx`, `src/diagram/linkLayer.tsx`

```typescript
private readonly memoizedElements = new WeakMap<ElementState, React.ReactElement>();

// In render():
let element = this.memoizedElements.get(state);
if (!element) {
    element = <OverlaidElement key={state.element.id} ... />;
    this.memoizedElements.set(state, element);
}
return element; // Same object reference if nothing changed
```

This caches the *React element object* itself — not just the computed value. When React receives the same `React.ReactElement` object reference (via `===` equality), it can skip the reconciliation diff entirely. `memo()` in React Flow prevents re-renders at the component boundary, but the element object is still reallocated on every parent render pass.

WeakMaps allow garbage collection when the `ElementState` object is removed — no memory leak risk.

**Why it matters:** At 1000 nodes, every parent render that doesn't produce element changes saves allocating ~1000 React element objects and running ~1000 prop comparisons.

---

### 3.4 — Bitwise RedrawFlags and shouldComponentUpdate
**File:** `src/diagram/elementLayer.tsx`

```typescript
enum RedrawFlags {
    None               = 0,
    ScanCell           = 1,
    Render             = 2,
    RecomputeTemplate  = Render | 4,   // 6
    RecomputeBlurred   = Render | 8,   // 10
    Discard            = ScanCell | RecomputeTemplate | RecomputeBlurred | 16,
}
```

Each element in the redraw batch carries a bitmask describing exactly what changed. `TemplatedElement.shouldComponentUpdate()` checks whether the specific change flags require a re-render. `LinkMarker` components use `shouldComponentUpdate() { return false; }` — they never re-render after mount.

**Why it matters:** Visgraph's optimization boundary is `memo()` — either the component re-renders or it doesn't. Reactodia can say "re-render this node but only update its blur state, not its template."

---

### 3.5 — Reference Equality Preservation for Routes
**File:** `src/diagram/renderingState.ts`

```typescript
private updateRoutings = () => {
    const computedRoutes = this.linkRouter.route(this.model, this);
    previousRoutes.forEach((previous, linkId) => {
        const computed = computedRoutes.get(linkId);
        if (computed && sameRoutedLink(previous, computed)) {
            computedRoutes.set(linkId, previous); // Reuse old reference
        }
    });
    this.routings = computedRoutes;
};
```

After recomputing link routes, unchanged routes have their old object reference restored. Downstream components receive the same object reference → `memo()` / `shouldComponentUpdate()` skips them cleanly.

**Why it matters:** Without this, moving one node would cause every visible edge to re-render (because all routes are recomputed). With this, only the edges attached to the moved node re-render.

---

### 3.6 — Web Worker Layout Computation
**Files:** `src/layout.worker.ts`, `src/layout-sync.ts`

```typescript
// Worker-side:
class DefaultLayouts {
    forceLayout = async (graph, state, options) => blockingForceLayout(graph, state, options);
    flowLayout  = async (graph, state, options) => blockingFlowLayout(graph, state, options);
}
```

Layout algorithms (`forceLayout`, `flowLayout`, `defaultLayout`) run entirely in a Web Worker thread via `@reactodia/worker-proxy`, an RPC bridge. The main thread fires a layout request and continues handling user interactions. The result is posted back when ready.

Visgraph's ELK and Dagre layouts are `async` but run on the main thread. For large graphs, the JavaScript execution still blocks the event loop during the heavy computation phase.

**Why it matters:** Truly non-blocking layout means the UI remains interactive during layout calculation. Zoom, pan, selection — all continue responding while the layout runs.

---

### 3.7 — OrderedMap Data Structure
**File:** `src/coreUtils/collections.ts`

```typescript
export class OrderedMap<V> {
    private mapping = new Map<string, V>(); // O(1) keyed lookup
    private ordered: V[] = [];               // Stable render order

    reorder(compare: (a: V, b: V) => number): void { /* ... */ }
}
```

Nodes and edges are stored in `OrderedMap`, providing O(1) lookup by ID and a stable ordered array for rendering. Changing an element's position in the graph doesn't rebuild the array from scratch.

**Why it matters:** Maintaining both O(1) lookup and ordered rendering is something plain JS `Map` or `Array` handle separately. The combined structure eliminates the need to choose between them.

---

### 3.8 — Adjacency List via WeakMap
**File:** `src/diagram/graph.ts`

```typescript
private readonly elementLinks = new WeakMap<Element, Link[]>();
```

Each `Element` object maps directly to its array of connected links. Finding all edges for a node is O(1). The WeakMap ensures the adjacency data is garbage-collected when an element is removed.

**Why it matters:** React Flow stores edges as a flat array. Finding all edges connected to a node requires O(edges) scan or building a secondary index manually. Reactodia's index is always current.

---

### 3.9 — Data Attribute Hit-Testing
**File:** `src/diagram/paper.tsx`

```typescript
function findCell(bottom: Element, top: Element, model: DiagramModel): Cell | undefined {
    let target: Node | null = bottom;
    while (true) {
        if (target instanceof Element) {
            if (target.hasAttribute('data-element-id')) {
                return model.getElement(target.getAttribute('data-element-id')!);
            } else if (target.hasAttribute('data-link-id')) {
                return model.getLink(target.getAttribute('data-link-id')!);
            }
        }
        if (!target || target === top) break;
        target = target.parentNode;
    }
}
```

Mouse events hit-test by walking up the DOM tree looking for `data-element-id` or `data-link-id` attributes. No spatial index, no bounding box math. The depth of a typical component tree is small (~10 levels), so this is effectively O(1) in practice.

**Why it matters:** React Flow uses synthetic events routed through React's delegation system. Reactodia bypasses this entirely — a native `mousedown` event on a node element immediately resolves to the model object in a few DOM traversal steps.

---

### 3.10 — CSS `display:contents` Portals
**File:** `src/diagram/placeLayer.tsx`

```typescript
const containers: Record<CanvasPlaceAtLayer, HTMLElement> = {
    underlay:         document.createElement('div'),
    overLinkGeometry: document.createElement('div'),
    overLinks:        document.createElement('div'),
    overElements:     document.createElement('div'),
};
for (const container of Object.values(containers)) {
    container.style.display = 'contents'; // Does not create a layout/stacking context
}
```

Widget layers are plain `div` elements with `display: contents`, placed via React portals. They participate in rendering order without creating new layout boxes or stacking contexts. The z-ordering comes from DOM order, not CSS `z-index` battles.

**Why it matters:** Avoids the CSS specificity and stacking context complexity that typically comes with overlays in graph libraries.

---

## 4. Visgraph Current State

### What is already optimized

- `onlyRenderVisibleElements={true}` — React Flow's built-in viewport culling is active. Nodes/edges outside the viewport are not in the DOM.
- All node/edge components wrapped in `memo()` — prevents re-renders when props are reference-equal.
- Extensive `useMemo` for derived values (filtered nodes, edge styles, annotations, predicate classifiers).
- `useRef`-based coordination (`mappingInProgressRef`, `layoutPendingRef`) prevents concurrent mapping/layout races.
- Pure `mapQuadsToDiagram()` function — RDF quads are converted to React Flow shapes in a single pure pass with no store lookups.
- `applyDiagramChangeSmart()` reconciliation — existing node positions and flags are preserved during updates.

### Where the ceiling is

- **React Flow's internal reconciler cost:** Even with `memo()`, every React Flow render pass touches all nodes in the internal `NodeRenderer`. At 5,000+ nodes, this overhead is measurable.
- **No WeakMap element caching:** New `React.ReactElement` objects are allocated on every render pass for every visible node. GC pressure increases with graph size.
- **Layout on main thread:** ELK and Dagre run as `async` promises but are not off-thread. During heavy layout computation, frame drops are possible.
- **No reference equality preservation for edges:** Bidirectional edge offset calculation runs O(n log n) per reconciliation. All edges get new object references, triggering `memo()` comparisons.
- **No per-element update granularity:** Update or skip — there is no middle ground. A selection state change causes full re-renders of affected nodes.

---

## 5. Notable Reactodia Features Beyond Raw Speed

### Z-Layer Placement System
Widgets and decorators can be explicitly placed at one of four canvas layers: `underlay`, `overLinkGeometry`, `overLinks`, `overElements`. This is useful for background grids, selection halos, edge decorators, and floating panels — each at the right visual depth without z-index hacks.

### Template-Based Node Rendering
Node appearance is driven by templates that can be swapped per node type at runtime. The template system is decoupled from the data model — you can change how a node renders without changing its data. Visgraph hardcodes node types into `nodeTypes` at initialization.

### Blurred / Overlay Element States
Elements can be put into a "blurred" state (reduced opacity, non-interactive) while other elements are highlighted. This is a first-class rendering state tracked by `RedrawFlags.RecomputeBlurred`, not a CSS class toggle. Useful for focus modes in dense graphs.

### Built-in Web Worker RPC (`@reactodia/worker-proxy`)
The worker communication pattern is encapsulated in a reusable `connectWorker()` utility. Any computation-heavy function can be moved off-thread with minimal ceremony. This is a general-purpose pattern applicable beyond layout.

### Custom Link Routing with Geometry
Link routes are computed as full geometry paths (not just start/end points). The router produces waypoints, curves, and vertex data. Unchanged routes preserve reference equality to avoid downstream re-renders. Visgraph's edge geometry is computed per-render inside `ObjectPropertyEdge` components.

### `useFrameDebouncedStore` / `useLayerDebouncedStore` Hooks
**File:** `src/coreUtils/hooks.ts`

Custom hooks that debounce store subscriptions to the animation frame or to a specific rendering layer update. Prevents subscriber callbacks from firing more than once per frame, even if the underlying store emits many rapid changes.

```typescript
export function useFrameDebouncedStore(subscribe: SyncStore): SyncStore {
    return React.useCallback<SyncStore>(onChange => {
        let scheduled: number | undefined;
        const onFrame = () => { scheduled = undefined; onChange(); };
        const dispose = subscribe(() => {
            if (scheduled === undefined) {
                scheduled = requestAnimationFrame(onFrame);
            }
        });
        return () => { cancelAnimationFrame(scheduled!); dispose(); };
    }, [subscribe]);
}
```

---

## 6. Conclusion and Takeaways

### Summary Table

| Technique | Benefit | Portable to React Flow? |
|---|---|---|
| 7-Layer rendering pipeline | No cascading re-renders | No — requires owning render pipeline |
| rAF Debouncer | One update per frame | Partially — can wrap RF state updates |
| WeakMap element memoization | Skip React element allocation | No — RF controls element creation |
| Bitwise RedrawFlags | Sub-component update granularity | No — requires class component control |
| Reference equality preservation | Prevents edge re-renders after node move | Partially — can preserve edge object refs in reconciliation |
| Web Worker layout | Non-blocking layout | Yes — ELK has a web worker mode |
| OrderedMap | O(1) lookup + ordered iteration | Yes — can implement alongside RF |
| Adjacency list WeakMap | O(1) edge-by-node lookup | Yes — can build on top of RF state |
| Data attribute hit-testing | Fast event routing | No — RF owns pointer events |
| `display:contents` portals | Clean z-layer management | Partially — can use portals within RF |

### Techniques borrowable into the current React Flow setup

1. **ELK web worker mode** — `elkjs` supports running in a worker. Switching from `new ELK()` to `new ELK({ workerFactory: ... })` moves layout off the main thread with minimal code change.
2. **Reference equality preservation in reconciliation** — `applyDiagramChangeSmart()` already preserves node references. Extending this to edges (preserving edge object identity when only position changes) would reduce `memo()` comparisons.
3. **Adjacency index** — a `Map<nodeId, Set<edgeId>>` maintained alongside React Flow state enables O(1) edge-by-node lookups instead of scanning the edges array.
4. **rAF-gated state updates** — batching multiple RDF manager events into a single `setNodes()`/`setEdges()` call per animation frame would reduce RF re-render frequency.

### Techniques that require migrating off React Flow

- 7-layer pipeline, WeakMap element caching, RedrawFlags, data-attribute hit-testing — these require owning the rendering pipeline from scratch. They are not achievable as add-ons to React Flow.

If maximum performance for very large graphs (10k+ nodes) becomes a requirement, migrating to reactodia (or a similar custom renderer) would be the only path to closing the full gap.
