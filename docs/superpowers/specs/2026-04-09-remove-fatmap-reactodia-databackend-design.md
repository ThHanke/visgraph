# Design: Replace Fat Map with Reactodia DataProvider Backend

**Date:** 2026-04-09  
**Status:** Approved

## Summary

Remove the fat map (in-memory class/property index built via reconcile pipeline) and replace it with on-demand queries to the `N3DataProvider`. The key change: also feed `urn:vg:ontologies` quads into the DataProvider (currently only `urn:vg:data` is synced), giving it a complete in-memory copy of both instance and schema data. This makes `knownElementTypes()` / `knownLinkTypes()` fully aware of the ontology, and makes rdfs:domain/rdfs:range queryable synchronously from the DataProvider's in-memory dataset — no worker round-trips, no separate index.

---

## Data Layer

### The Core Change: Sync Ontology Quads into DataProvider

**File:** `src/components/Canvas/ReactodiaCanvas.tsx`

Currently, the subjects handler filters incoming quads to only `urn:vg:data` / `urn:vg:inferred` before calling `dataProvider.addGraph()`. Remove this filter so ontology quads from `urn:vg:ontologies` are also added to the DataProvider.

The DataProvider's view mode filtering already controls what gets rendered as diagram elements, so ontology class/property declarations will not appear as unwanted nodes in the canvas.

When the N3DataProvider is updated (data or ontology reloaded), both graphs are present — schema data refreshes alongside instance data, mirroring the old reconcile update pattern.

### Remove

- `buildFatMap()`, `updateFatMap()`, `updateFatMapFromWorker()` from `ontologyStore.ts`
- `availableProperties` and `availableClasses` Zustand state from `ontologyStore.ts`
- The fat-map branches in `runReconcile()` in `rdfManager.impl.ts`
- `WorkerReconcileSubjectSnapshotPayload` handling that feeds the fat map (if only used for fat map)
- `getAvailableProperties()`, `getAvailableClasses()`, `fatMapToEntities()` from `storeHelpers.ts`
- `OntologyAccessor` interface and its instantiation in `ReactodiaCanvas.tsx`
- `getCompatibleProperties()` from `ontologyStore.ts`
- `INITIAL_SCHEMA_PROPERTIES` seeding in `ontologyStore.ts`

### Add

Three utility functions in a new `src/utils/ontologyQueries.ts`:

```typescript
// Fetch all classes — calls DataProvider.knownElementTypes(), returns flat list
fetchClasses(dataProvider: DataProvider): Promise<ElementTypeModel[]>

// Fetch all link types — calls DataProvider.knownLinkTypes()
fetchLinkTypes(dataProvider: DataProvider): Promise<LinkTypeModel[]>

// Score and sort link types by domain/range fit.
// Queries rdfs:domain / rdfs:range from the DataProvider's in-memory dataset (synchronous).
scoreLinkTypes(
  linkTypes: LinkTypeModel[],
  sourceClassIri: string | undefined,
  targetClassIri: string | undefined,
  dataProvider: N3DataProvider
): ScoredLinkType[]
```

`scoreLinkTypes` accesses `(dataProvider.inner as any).dataset` — the same pattern already used in `N3DataProvider.replaceSubjectQuads()` — to query rdfs:domain/rdfs:range quads synchronously.

**Scoring tiers:**

| Score | Tier | Condition |
|-------|------|-----------|
| 0 | Exact match | domain matches sourceClass AND range matches targetClass |
| 1 | Partial match | domain OR range matches; or one end has no constraint |
| 2 | Unconstrained | no rdfs:domain and no rdfs:range declared |
| 3 | Mismatch | declared domain/range that does not match |

Result sorted ascending by score. All tiers included (none hidden).

```typescript
interface ScoredLinkType extends LinkTypeModel {
  domainRangeScore: 0 | 1 | 2 | 3;
}
```

---

## EntityAutoComplete

**File:** `src/components/ui/EntityAutoComplete.tsx`

### Props changes

```typescript
sourceClassIri?: string      // for domain/range scoring when mode="properties"
targetClassIri?: string
dataProvider?: DataProvider  // injected for fetching
```

### Behavior changes

- On mount, call `fetchClasses()` or `fetchLinkTypes()` based on `mode`, store result in local component state (replaces reading from Zustand `availableClasses`/`availableProperties`)
- When `mode="properties"` and `sourceClassIri`/`targetClassIri` are provided, apply `scoreLinkTypes()` on the loaded list before filtering
- Fuzzy filter runs on the already-scored+sorted list so ranking is preserved within filtered results
- Render a subtle visual separator between score tiers in the dropdown (e.g. group labels: "Best match", "Compatible", "General", "Other")

### No changes

- Fuzzy matching logic (substring, label/prefixed/IRI)
- Keyboard navigation
- `onChange` / `value` props interface

---

## LinkPropertyEditor

**File:** `src/components/Canvas/LinkPropertyEditor.tsx`

- Remove `getCompatibleProperties(sourceClass, targetClass)` call
- Pass `sourceClassIri` and `targetClassIri` (derived from node `classType` or `rdfTypes[0]`, same as current logic) as props to `EntityAutoComplete`
- Pass `dataProvider` down to `EntityAutoComplete`
- Remove any direct fat map imports

---

## RdfMetadataProvider

**File:** `src/providers/RdfMetadataProvider.ts`

- `canConnect()`: replace `accessor.getCompatibleProperties()` call with `scoreLinkTypes()` against the DataProvider
- Return all link types (scores 0–3); reactodia expects a permissive list
- Remove `OntologyAccessor` parameter from constructor; inject `N3DataProvider` directly
- Remove `getAllProperties()` / `getCompatibleProperties()` accessor calls

---

## ReactodiaCanvas

**File:** `src/components/Canvas/ReactodiaCanvas.tsx`

- Stop filtering out `urn:vg:ontologies` quads before `dataProvider.addGraph()` — pass all graphs through
- Remove `OntologyAccessor` lambda construction
- Construct `RdfMetadataProvider` with `dataProvider` instead of ontology accessor

---

## Removal Checklist

- [ ] `ReactodiaCanvas.tsx`: remove graph filter on `addGraph()`, remove `OntologyAccessor` lambda, rewire `RdfMetadataProvider` constructor
- [ ] `ontologyStore.ts`: remove `availableProperties`, `availableClasses`, `buildFatMap`, `updateFatMap`, `updateFatMapFromWorker`, `getCompatibleProperties`, `INITIAL_SCHEMA_PROPERTIES` seeding
- [ ] `rdfManager.impl.ts`: remove fat-map branches from `runReconcile()`
- [ ] `storeHelpers.ts`: remove `getAvailableProperties`, `getAvailableClasses`, `fatMapToEntities`
- [ ] `RdfMetadataProvider.ts`: remove `OntologyAccessor`, rewire `canConnect()` to use `scoreLinkTypes()`
- [ ] `LinkPropertyEditor.tsx`: remove `getCompatibleProperties`, pass `sourceClassIri`/`targetClassIri`/`dataProvider` to `EntityAutoComplete`
- [ ] `EntityAutoComplete.tsx`: rewire data source to DataProvider, add scoring display
- [ ] Add `src/utils/ontologyQueries.ts` with `fetchClasses`, `fetchLinkTypes`, `scoreLinkTypes`

---

## What Does NOT Change

- EntityAutoComplete UX (fuzzy search, keyboard nav, visual style)
- How RDF data is loaded into the worker store
- Reactodia's own unified search (already uses DataProvider)
- NodePropertyEditor class selection (uses `fetchClasses` via same EntityAutoComplete)
- N3DataProvider view mode logic (still controls what renders as diagram elements)
