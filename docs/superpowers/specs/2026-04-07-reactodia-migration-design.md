# Reactodia Migration Design

**Date:** 2026-04-07
**Status:** Approved for implementation planning

## 1. Context and Goals

Visgraph currently renders knowledge graphs using React Flow (`@xyflow/react`). Reactodia has been evaluated and found to be significantly faster and architecturally more capable — it owns its own rendering pipeline, uses web-worker-based layout, WeakMap element memoization, rAF batching, and a 7-layer dependency-ordered rendering system.

**Goals:**
- Replace React Flow with reactodia for all canvas rendering and editing
- Keep the N3 store (`rdfManager`) as the single source of truth for RDF data
- Use reactodia's built-in widgets for editing, search, navigation, and element/link interaction
- Preserve the existing sidebar + topbar UI shell (no UX restructuring)
- Defer ActivityNode / workflow execution to a follow-up phase
- Drop all custom React Flow node/edge components and custom dialogs

---

## 2. What Changes

### Removed
| Item | Reason |
|---|---|
| `@xyflow/react`, `reactflow` (npm) | Replaced by `@reactodia/workspace` |
| `KnowledgeCanvas.tsx` (3600 lines) | Replaced by `ReactodiaCanvas.tsx` |
| `RDFNode.tsx` | Replaced by custom `ElementTemplate` |
| `ClusterNode.tsx` | Replaced by reactodia `EntityGroup` |
| `ObjectPropertyEdge.tsx` | Replaced by custom `LinkTemplate` |
| `ClusterPropertyEdge.tsx`, `ClusterEdge.tsx`, `FloatingConnectionLine.tsx` | Replaced by reactodia link system |
| `LayoutManager.ts` | Replaced by `layout/reactodiaLayouts.ts` |
| `core/mappingHelpers.ts` | Replaced by `RdfDataProvider` |
| `core/diagramChangeHelpers.ts` | Replaced by incremental model sync |
| `NodePropertyEditor.tsx`, `LinkPropertyEditor.tsx` | Replaced by reactodia `VisualAuthoring` |
| `SearchOverlay.tsx`, `NodeSearch.tsx` | Replaced by reactodia `InstancesSearch` + `UnifiedSearch` |

### Kept Unchanged
| Item | Notes |
|---|---|
| `src/utils/rdfManager.ts` | N3 store, file loading, reasoning, SPARQL — untouched |
| `src/stores/ontologyStore.ts` | RDF/OWL data, namespace registry |
| `src/stores/appConfigStore.ts` | Layout types updated, RF state removed |
| `src/components/Canvas/LeftSidebar.tsx` | Shell kept; workflow template cards still present |
| `src/components/Canvas/TopBar.tsx` | Shell kept; internals migrated to reactodia actions |
| `src/components/Canvas/core/namespacePalette.ts` | Used by `TypeStyleResolver` |
| `src/components/Canvas/core/clusterHelpers.ts` + algorithms | Algorithm code kept; output mapped to `EntityGroup` |
| `src/components/Canvas/core/exportHelpers.ts` | May be superseded by `CanvasApi.exportSvg/exportRaster` |

### New Files Created
| File | Purpose |
|---|---|
| `src/components/Canvas/ReactodiaCanvas.tsx` | Main canvas component (replaces KnowledgeCanvas) |
| `src/providers/N3DataProvider.ts` | Implements `DataProvider` interface over N3 store; uses `RdfDataProvider.addGraph()` for bulk sync |
| `src/providers/RdfMetadataProvider.ts` | `MetadataProvider` impl — writes to `rdfManager` |
| `src/providers/RdfTypeStyleResolver.ts` | Maps type IRI namespaces → namespace colors |
| `src/templates/RdfElementTemplate.tsx` | Custom element template for RDF entities |
| `src/templates/RdfLinkTemplate.tsx` | Custom link template for object properties |
| `src/layout/reactodiaLayouts.ts` | Dagre + ELK wrapped as `LayoutFunction` |

---

## 3. Data Architecture

### 3.1 Read Path: N3 Store → Canvas

**Important:** `RdfDataProvider` does **not** accept an external dataset in its constructor — it owns an internal dataset and exposes `addGraph(quads)` / `clear()` for population. There is no live-reference mechanism. `N3DataProvider` wraps `RdfDataProvider` and calls `clear()` + `addGraph(store)` on each sync cycle to push fresh data in.

```
rdfManager (N3 Store)
      |
      v  on load / reasoning / bulk change
N3DataProvider.sync():
  rdfDataProvider.clear()
  rdfDataProvider.addGraph(n3Store)  // copies current quads into RdfDataProvider
      |
      v  reactodia queries on-demand
DataDiagramModel
      |
      v  initial load: createNewDiagram({ dataProvider })
      v  then: createElement(iri) for each subject IRI in store
      v  restore: importLayout({ dataProvider, diagram: savedLayout })
      |
      v
Canvas renders all elements
```

**Initial load flow:**
```typescript
// Populate RdfDataProvider from current N3 store
rdfDataProvider.addGraph(n3Store);

// Create the diagram and add all current subjects
await model.createNewDiagram({ dataProvider });
for (const iri of allSubjectIris) {
  model.createElement(iri);
}

// Run layout to position elements
await performLayout({ layoutFunction: defaultLayout, animate: false });
```

*(Optional future: `model.importLayout({ dataProvider, diagram: savedLayout })` to restore user-arranged positions across page reloads — separate task.)*

### 3.2 Write Path: Canvas Edits → N3 Store

```
User creates/edits/deletes entity or relation in reactodia UI
      |
      v
VisualAuthoring widget → MetadataProvider
      |
      v  (custom impl)
RdfMetadataProvider implements MetadataProvider (8 required methods):
  createEntity(), createRelation()    → add quads to rdfManager
  canConnect()                        → check OWL domain/range constraints
  canModifyEntity(), canModifyRelation() → always-allow (or OWL-constrained)
  getEntityShape(), getRelationShape() → return property shapes from ontology
  filterConstructibleTypes()          → return classes from TBox
  getLiteralLanguages()               → from namespace registry
      |
      v
rdfManager.applyBatch({ adds: Quad[], removes: Quad[] })
      |
      v
N3 Store updated → onSubjectsChange fires → canvas sync (see 3.3)
```

### 3.3 Store Sync: N3 Changes → Canvas

Two strategies, chosen based on change magnitude:

Sync strategy mirrors visgraph's existing `onSubjectsChange` subscription, but routes to RdfDataProvider + reactodia model instead of React Flow state. No `importLayout` needed — canvas elements keep their positions; only the affected elements are touched.

**Additions** (new subjects in store):
```
rdfDataProvider.addGraph(newQuads)   // append-only, no clear
model.createElement(iri)             // for each new subject IRI
```

**Removals** (subjects deleted from store):
```
rdfDataProvider.clear()
rdfDataProvider.addGraph(n3Store)    // full resync — no removeGraph() exists
editor.deleteEntity(element)         // remove each deleted subject from canvas
```

**Changes** (subject's quads updated, same IRI):
```
rdfDataProvider.addGraph(changedQuads)   // or clear+resync if quads removed
element.redraw()                          // element re-reads fresh data from provider
```

**Write-origin guard** (prevents circular loop when `MetadataProvider` writes to rdfManager):
```typescript
let suppressSync = false;

// In RdfMetadataProvider, before any rdfManager write:
suppressSync = true;
await rdfManager.applyBatch({ ... });
suppressSync = false;

// In onSubjectsChange handler:
if (suppressSync) return; // reactodia already handled this visually
```

`importLayout` is **not used in the sync loop**. It is only relevant as an optional feature for persisting/restoring the user's manual layout across page refreshes (separate task).

### 3.4 ABox / TBox View Mode

The current view mode (ABox = individuals, TBox = classes/properties) is implemented as a filter in `N3DataProvider`. The `lookup()` method filters results by RDF type:

```typescript
// ABox mode: return owl:NamedIndividual, skos:Concept, etc.
// TBox mode: return owl:Class, owl:ObjectProperty, owl:DatatypeProperty, etc.
// Both: return punned entities
```

When the user switches view mode, a full reimport is triggered (Section 3.3 strategy B). Element positions from the other view mode are saved per-view in app state.

---

## 4. Custom Element Template

`RdfElementTemplate` replaces `RDFNode.tsx`. It implements the `ElementTemplate` interface and is registered via `elementTemplateResolver` on the `Canvas` component.

**Visual features preserved:**
- Namespace color bar (left side stripe, from `TypeStyleResolver`)
- Type badge (primary RDF type, namespace-colored background)
- Primary label (`rdfs:label` or prefix-shortened IRI)
- Literal properties list (up to 6, from `ElementModel.properties`)
- Inferred properties section (separate, with visual distinction)
- Reasoning error / warning borders (read from `TemplateState` set by MetadataProvider validation)
- Collapse/expand button (via `TemplateProperties.Expanded`)
- Selection ring (reactodia handles natively)
- NodeToolbar replaced by reactodia's `Halo` widget

**Namespace colors:**
```typescript
const typeStyleResolver: TypeStyleResolver = (types) => {
  const namespace = extractNamespace(types[0]);
  return { color: namespacePalette.getColor(namespace) };
};
```

**ActivityNode:** Deferred. Kept as an isolated component, not migrated in this phase.

---

## 5. Custom Link Template

`RdfLinkTemplate` replaces `ObjectPropertyEdge.tsx`. Registered via `linkTemplateResolver` on `Canvas`.

**Visual features preserved:**
- Prefix-shortened property label (from `LinkModel.linkTypeId`)
- Dashed style for inferred links (from `LinkModel.properties`)
- Reasoning error/warning color coding
- Arrow at target end (via `markerTarget`)
- Bidirectional edge offset (via `DefaultLinkRouter` with `gap` option, or custom router)

**Draggable label:** Reactodia's `LinkVertex` system supports editable waypoints. The label offset is stored via `link.vertices` rather than a custom `shift` field.

**Bidirectional edges:** Multiple links between the same two nodes are handled by reactodia's `DefaultLinkRouter` which applies gaps automatically.

---

## 6. Layout

**This phase uses reactodia's built-in Cola-based layout only.** Dagre and ELK migration is deferred to a separate task after the core pipeline is validated.

Reactodia built-in layout worker setup (provides `defaultLayout`, `forceLayout`, `flowLayout` via Cola):
```typescript
const Layouts = Reactodia.defineLayoutWorker(() =>
  new Worker(new URL('@reactodia/workspace/layout.worker', import.meta.url), { type: 'module' })
);
const { defaultLayout } = Reactodia.useWorker(Layouts);
// defaultLayout is a REQUIRED Workspace prop — omitting it is a compile error
```

Layout is triggered via:
```typescript
const { performLayout } = useWorkspace();
await performLayout({ layoutFunction: defaultLayout, animate: true });
// Note: param is `layoutFunction`, not `layouter`
```

> **TODO (separate task):** Wrap visgraph's existing Dagre + ELK algorithms as `LayoutFunction` implementations in `src/layout/reactodiaLayouts.ts`. Dagre/ELK cannot share reactodia's built-in worker — they need a dedicated layout worker or run as async main-thread functions.

---

## 7. Widgets and UI Migration

### Toolbar (TopBar)
`TopBar.tsx` shell is kept. Internal buttons are replaced with reactodia `ToolbarAction*` components or custom actions:

| Current | Replacement |
|---|---|
| Add Node button | `InstancesSearch` command bus trigger |
| ABox/TBox toggle | Custom `ToolbarAction` calling `N3DataProvider.setViewMode()` |
| Layout dropdown | Custom `ToolbarAction` calling `performLayout()` |
| Spacing slider | Custom `ToolbarAction` with layout options |
| Expand/collapse clusters | Custom `ToolbarAction` calling group API |
| Reasoning badge | Custom status display (kept from existing) |
| Legend toggle | Custom `ToolbarAction` |

### Search and Discovery
| Current | Replacement |
|---|---|
| `SearchOverlay.tsx` (Ctrl+F) | `UnifiedSearch` widget (reactodia built-in) |
| `NodeSearch.tsx` | `InstancesSearch` widget |
| Class browser (planned) | `ClassTree` widget — drag entities onto canvas |

`DropOnCanvas` enables drag-and-drop from `ClassTree` / `InstancesSearch` directly onto the canvas.

### Navigation and Canvas Controls
| Current | Replacement |
|---|---|
| React Flow `<MiniMap />` | `Navigator` widget |
| React Flow `<Controls />` | `ZoomControl` widget |
| React Flow `<Background />` | Custom SVG layer or reactodia paper background |

### Namespace Legend
`ResizableNamespaceLegend.tsx` is kept as a custom widget, placed inside the canvas via `HtmlPaperLayer` or as a sidebar overlay. No reactodia equivalent exists.

### Editing
| Current | Replacement |
|---|---|
| `NodePropertyEditor.tsx` | `VisualAuthoring` widget with `RdfMetadataProvider` |
| `LinkPropertyEditor.tsx` | `VisualAuthoring` widget (link editing built in) |
| Property autocomplete | Reactodia `ConnectionsMenu` + `InstancesSearch` built-in lookup |
| IRI input | `VisualAuthoring` `inputResolver` with namespace-aware field |

`VisualAuthoring` is configured with:
```typescript
// inputResolver takes (property: PropertyTypeIri, inputProps: FormInputMultiProps)
// and must return a rendered React.ReactElement, not a component reference
<VisualAuthoring
  inputResolver={(property, inputProps) => {
    if (isObjectProperty(property)) return <IriSelectorInput {...inputProps} />;
    return undefined; // reactodia default text input
  }}
/>
```

---

## 8. Clustering

> **TODO (separate task):** Migrate clustering to reactodia's `EntityGroup` system after core pipeline performance is validated.
>
> Clustering code (`core/clusterHelpers.ts` + algorithms) is **kept unchanged** but not wired to the canvas in this phase. The global `__VG_EXPAND_CLUSTER` / `__VG_COLLAPSE_TO_CLUSTER` window functions are removed; cluster UI is disabled until the follow-up task.
>
> **When implementing:** `workspace.group({ elements: EntityElement[], canvas })` requires all member elements to already be on the canvas. Run clustering after all entities are placed. For ungroup: `workspace.ungroupAll({ groups, canvas })` and `workspace.ungroupSome({ group, entities, canvas })`.

---

## 9. Reasoning Visualization

Inferred edges (dashed style), reasoning error/warning indicators on nodes are preserved via:

1. **Inferred links:** `LinkModel.properties` includes a custom `vg:inferred` property. The `RdfLinkTemplate` checks for this and applies dashed stroke style.
2. **Node reasoning state:** Implement `ValidationProvider.validate()` to read reasoning errors/warnings from the `urn:vg:inferred` graph and return `ValidationResult` objects. `ValidationProvider` is passed as a **`Workspace` prop** (not a `VisualAuthoring` prop) — it is wired at the workspace level and managed via `EditorController.validationState`. Element templates read validation state from `TemplateState` via the element's data.
   ```tsx
   <Workspace
     defaultLayout={defaultLayout}
     validationProvider={new RdfValidationProvider(rdfManager)}
     metadataProvider={new RdfMetadataProvider(rdfManager)}
   >
   ```
3. **ReasoningReportModal** and `ReasoningIndicator` are kept as-is — they interact with `rdfManager` directly, not with the canvas.

---

## 10. Export

| Feature | Implementation |
|---|---|
| PNG export | `canvasApi.exportRaster()` — returns data URL; replaces `html-to-image` |
| SVG export | `canvasApi.exportSvg()` — returns SVG string; replaces manual SVG serialization |
| RDF export | `rdfManager.exportGraph(format)` — unchanged |

---

## 11. Deferred Features

These are explicitly **not** part of this migration phase:

| Feature | Reason |
|---|---|
| `ActivityNode` (PROV-O execution) | Complex unique UX — implement as a custom `ElementTemplate` in a separate task after core migration |
| Workflow catalog drag-and-drop from sidebar | Depends on ActivityNode being migrated first |
| Clustering → `EntityGroup` | Test core pipeline performance first; separate task |
| Custom cluster pill-shape template | Depends on clustering task |
| Cluster-level layout | Depends on clustering task |
| Dagre / ELK as `LayoutFunction` | Use reactodia's built-in Cola layout initially; Dagre/ELK migration is a separate task |

---

## 12. Implementation Order

1. **Package setup** — install `@reactodia/workspace`, remove React Flow packages, configure webpack/vite worker bundling
2. **Data bridge** — implement `N3DataProvider` (implementing `DataProvider`, using `RdfDataProvider.addGraph()` internally), basic `RdfMetadataProvider` stub (all 8 methods, `canConnect`/`canModify` return always-allow initially)
3. **Basic canvas** — `ReactodiaCanvas.tsx` with `Workspace` (required `defaultLayout` prop) + `Canvas`; use `useLoadedWorkspace` hook for safe async model init; initial `createNewDiagram` + `createElement` per subject IRI
4. **Element template** — `RdfElementTemplate` with label, type badge, namespace color
5. **Link template** — `RdfLinkTemplate` with label, arrow, inferred dashes
6. **TypeStyleResolver** — namespace → color mapping
7. **Layout** — reactodia built-in Cola layout via `defineLayoutWorker` + `useWorker`
8. **Incremental sync** — wire `rdfManager.onSubjectsChange` → `addGraph`/`clear`+resync + model `createElement`/`redraw`
9. **ABox/TBox view mode** — DataProvider filter + view-switch trigger
10. **Widgets** — toolbar actions, `InstancesSearch`, `ClassTree`, `Navigator`, `ZoomControl`
11. **Editing** — `VisualAuthoring` + `MetadataProvider` write-back to rdfManager
12. **Reasoning visualization** — `ValidationProvider`, inferred link style
13. **Export** — wire `canvasApi.exportSvg()` / `canvasApi.exportRaster()`
14. **Namespace legend** — port as custom widget
15. **Cleanup** — remove all React Flow code, old node/edge components
16. **Performance test** — load large graph, measure render FPS and interaction latency vs old React Flow baseline

*(Clustering, Dagre/ELK layout, ActivityNode, workflow catalog: separate follow-up tasks)*

---

## 13. Verification

End-to-end test after each phase milestone:

- **Phase 1–3:** Load a Turtle file → N3 store populated → entities appear on reactodia canvas
- **Phase 4–6:** Nodes show correct labels, namespace colors, link labels
- **Phase 7:** Layout button positions nodes correctly, no UI stutter (layout off main thread)
- **Phase 8:** Add a triple via `rdfManager` → new node appears on canvas without full reload
- **Phase 9:** Toggle ABox/TBox → correct entity subset shown
- **Phase 10:** Search for entity → appears in `InstancesSearch`, drag onto canvas
- **Phase 11:** Double-click node → `VisualAuthoring` dialog opens; save → quad written to N3 store
- **Phase 12:** Run reasoning → inferred edges dashed, error nodes have warning border
- **Phase 13:** Export PNG/SVG → full canvas captured correctly
- **Phase 14–15:** Cleanup + smoke test full app with no React Flow dependencies remaining
- **Phase 16:** Load a large graph (500+ nodes) — measure render time and interaction FPS vs React Flow baseline
