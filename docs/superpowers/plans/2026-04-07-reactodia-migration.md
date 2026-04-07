# Reactodia Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace React Flow with reactodia as the canvas rendering and editing engine, keeping the N3 store (rdfManager) as the single source of truth.

**Architecture:** `N3DataProvider` wraps reactodia's `RdfDataProvider` and is fed from the N3 store via `addGraph()`/`clear()`. A `RdfMetadataProvider` writes edits back to `rdfManager.applyBatch()`. The canvas subscribes to `rdfManager.onSubjectsChange` for incremental element updates. All custom React Flow node/edge components are replaced by reactodia templates and built-in widgets.

**Tech Stack:** `@reactodia/workspace` (^0.33.0), `n3`, `zustand`, `vite` (ES module workers), `vitest`, `@testing-library/react`

**Spec:** `docs/superpowers/specs/2026-04-07-reactodia-migration-design.md`

---

## File Structure

### New Files
| Path | Responsibility |
|---|---|
| `src/providers/N3DataProvider.ts` | Implements `DataProvider` over N3 store via `RdfDataProvider.addGraph()`; view mode filter on `lookup()` |
| `src/providers/RdfMetadataProvider.ts` | Implements `MetadataProvider`; writes to `rdfManager.applyBatch()`; exposes `suppressSync` flag |
| `src/providers/RdfValidationProvider.ts` | Implements `ValidationProvider`; reads reasoning errors from `urn:vg:inferred` graph |
| `src/providers/__tests__/N3DataProvider.test.ts` | Unit tests for DataProvider |
| `src/providers/__tests__/RdfMetadataProvider.test.ts` | Unit tests for write-back and suppress guard |
| `src/templates/RdfElementTemplate.tsx` | Custom `ElementTemplate` — label, type badge, namespace color bar, inferred props |
| `src/templates/RdfLinkTemplate.tsx` | Custom `LinkTemplate` — prefixed label, arrow, dashed inferred style |
| `src/templates/__tests__/RdfElementTemplate.test.tsx` | Render tests for element template |
| `src/components/Canvas/ReactodiaCanvas.tsx` | Main canvas component — replaces `KnowledgeCanvas.tsx` |

### Modified Files
| Path | Change |
|---|---|
| `package.json` | Add `@reactodia/workspace`; remove `@xyflow/react`, `reactflow` |
| `src/pages/Index.tsx` | Import `ReactodiaCanvas` instead of `KnowledgeCanvas` |
| `src/components/Canvas/TopBar.tsx` | Replace React Flow–specific layout/cluster callbacks with reactodia equivalents |
| `src/hooks/useCanvasState.ts` | Remove React Flow viewport ref; expose workspace ref accessor |
| `src/stores/appConfigStore.ts` | Remove React Flow–specific layout type values |

### Deleted Files (Task 15)
`KnowledgeCanvas.tsx`, `RDFNode.tsx`, `ActivityNode.tsx` (defer), `ClusterNode.tsx`, `ObjectPropertyEdge.tsx`, `ClusterPropertyEdge.tsx`, `ClusterEdge.tsx`, `FloatingConnectionLine.tsx`, `LayoutManager.ts`, `core/mappingHelpers.ts`, `core/diagramChangeHelpers.ts`, `NodePropertyEditor.tsx`, `LinkPropertyEditor.tsx`, `SearchOverlay.tsx`, `NodeSearch.tsx`

---

## Background Knowledge for Implementer

### rdfManager API (critical)
```typescript
// src/utils/rdfManager.ts exports a singleton:
import { rdfManager } from '@/utils/rdfManager';

// Subscribe to RDF changes:
rdfManager.onSubjectsChange((subjects: string[], quads?: WorkerQuad[]) => { ... });
rdfManager.offSubjectsChange(callback);

// Write quads back:
await rdfManager.applyBatch({ adds: WorkerQuad[], removes: WorkerQuad[] }, graphName?);

// Read namespaces:
rdfManager.getNamespaces(); // Record<prefix, uri>
```

`WorkerQuad` is a plain JS object: `{ subject: WorkerTerm, predicate: WorkerTerm, object: WorkerTerm, graph: WorkerTerm }` where `WorkerTerm = { termType: 'NamedNode'|'BlankNode'|'Literal', value: string, language?: string, datatype?: { value: string } }`.

### Reactodia bootstrap pattern (critical)
```typescript
import * as Reactodia from '@reactodia/workspace';
import '@reactodia/workspace/styles'; // CSS

// Layout worker — MUST be defined at module scope, not inside a component
const Layouts = Reactodia.defineLayoutWorker(() =>
  new Worker(new URL('@reactodia/workspace/layout.worker', import.meta.url), { type: 'module' })
);

function MyCanvas() {
  const { defaultLayout } = Reactodia.useWorker(Layouts);

  const { onMount } = Reactodia.useLoadedWorkspace(async ({ context, signal }) => {
    const { model } = context;
    // populate data here
  }, []);

  return (
    <Reactodia.Workspace
      ref={onMount}
      defaultLayout={defaultLayout}          // REQUIRED — compile error if omitted
      metadataProvider={myMetadataProvider}
      validationProvider={myValidationProvider}
    >
      <Reactodia.Canvas
        elementTemplateResolver={myElementResolver}
        linkTemplateResolver={myLinkResolver}
      >
        {/* widgets go here as children */}
      </Reactodia.Canvas>
    </Reactodia.Workspace>
  );
}
```

### RdfDataProvider API
```typescript
import { RdfDataProvider } from '@reactodia/workspace';

const provider = new RdfDataProvider();       // no constructor args
provider.addGraph(quads: Iterable<Rdf.Quad>); // append quads
provider.clear();                             // empty internal dataset
```

`RdfDataProvider.addGraph()` needs **RDF.js Quad objects**, not `WorkerQuad` objects.
Convert using the factory from `@reactodia/workspace`:
```typescript
import { Rdf } from '@reactodia/workspace';
const factory = Rdf.OntodiaDataFactory; // or new N3.DataFactory()
const quad = factory.quad(
  factory.namedNode(wq.subject.value),
  factory.namedNode(wq.predicate.value),
  wq.object.termType === 'Literal'
    ? factory.literal(wq.object.value, wq.object.language || factory.namedNode(wq.object.datatype?.value ?? ''))
    : factory.namedNode(wq.object.value),
  wq.graph?.value ? factory.namedNode(wq.graph.value) : factory.defaultGraph()
);
```

### DataDiagramModel API
```typescript
const { model } = useWorkspace(); // inside Workspace tree

await model.createNewDiagram({ dataProvider });
const element = model.createElement(iri as ElementIri); // add entity to canvas
// element.redraw() — force re-read from DataProvider
```

### N3 store iteration
The N3 store lives inside `rdfManager` (private). To get all subject IRIs, subscribe to `rdfManager.onSubjectsChange` — it fires with every batch of changed subjects. For initial load, track all accumulated subjects since startup in a `Set<string>`.

---

## Task 1: Package Setup

**Files:** `package.json`, `vite.config.ts`, `src/main.tsx`

- [ ] Install reactodia, remove React Flow

```bash
npm install @reactodia/workspace
npm uninstall @xyflow/react reactflow
```

- [ ] Start dev server — TypeScript errors in KnowledgeCanvas are expected, ignore them

```bash
npm run dev
```

- [ ] Confirm `vite.config.ts` has ES worker support. Find the `defineConfig({})` block and ensure it contains:

```typescript
worker: { format: 'es' },
```

If missing, add it.

- [ ] Add reactodia CSS to `src/main.tsx` after existing imports:

```typescript
import '@reactodia/workspace/styles';
```

- [ ] Commit

```bash
git add package.json package-lock.json src/main.tsx vite.config.ts
git commit -m "chore: install @reactodia/workspace, remove @xyflow/react"
```

---

## Task 2: N3DataProvider

**Files:**
- Create: `src/providers/N3DataProvider.ts`
- Create: `src/providers/__tests__/N3DataProvider.test.ts`

Implements reactodia's `DataProvider` by delegating to an internal `RdfDataProvider`. Exposes `addGraph()`/`clear()` for syncing from the N3 store. Filters `lookup()` results by view mode (ABox = individuals, TBox = classes/properties).

- [ ] Write failing test — `src/providers/__tests__/N3DataProvider.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { N3DataProvider } from '../N3DataProvider';

describe('N3DataProvider', () => {
  it('instantiates and exposes factory', () => {
    const p = new N3DataProvider();
    expect(p.factory).toBeDefined();
  });
  it('addGraph and clear do not throw', () => {
    const p = new N3DataProvider();
    expect(() => p.addGraph([])).not.toThrow();
    expect(() => p.clear()).not.toThrow();
  });
  it('setViewMode accepts abox and tbox', () => {
    const p = new N3DataProvider();
    expect(() => p.setViewMode('abox')).not.toThrow();
    expect(() => p.setViewMode('tbox')).not.toThrow();
  });
});
```

- [ ] Run — expect FAIL

```bash
npx vitest run src/providers/__tests__/N3DataProvider.test.ts
```

- [ ] Implement `src/providers/N3DataProvider.ts`

```typescript
import {
  RdfDataProvider,
  type DataProvider, type ElementIri, type ElementTypeIri, type LinkTypeIri,
  type PropertyTypeIri, type ElementTypeGraph, type ElementTypeModel,
  type LinkTypeModel, type PropertyTypeModel, type ElementModel, type LinkModel,
  type DataProviderLinkCount, type DataProviderLookupParams, type DataProviderLookupItem,
  Rdf,
} from '@reactodia/workspace';

export type ViewMode = 'abox' | 'tbox';

const ABOX_TYPES = new Set([
  'http://www.w3.org/2002/07/owl#NamedIndividual',
  'http://www.w3.org/2004/02/skos/core#Concept',
]);
const TBOX_TYPES = new Set([
  'http://www.w3.org/2002/07/owl#Class',
  'http://www.w3.org/2000/01/rdf-schema#Class',
  'http://www.w3.org/2002/07/owl#ObjectProperty',
  'http://www.w3.org/2002/07/owl#DatatypeProperty',
  'http://www.w3.org/2002/07/owl#AnnotationProperty',
]);

export class N3DataProvider implements DataProvider {
  private inner = new RdfDataProvider();
  private viewMode: ViewMode = 'abox';

  addGraph(quads: Iterable<Rdf.Quad>): void { this.inner.addGraph(quads); }
  clear(): void { this.inner.clear(); }
  setViewMode(mode: ViewMode): void { this.viewMode = mode; }

  knownElementTypes(p: { signal?: AbortSignal }): Promise<ElementTypeGraph> {
    return this.inner.knownElementTypes(p);
  }
  knownLinkTypes(p: { signal?: AbortSignal }): Promise<LinkTypeModel[]> {
    return this.inner.knownLinkTypes(p);
  }
  elementTypes(p: { classIds: readonly ElementTypeIri[]; signal?: AbortSignal }): Promise<Map<ElementTypeIri, ElementTypeModel>> {
    return this.inner.elementTypes(p);
  }
  linkTypes(p: { linkTypeIds: readonly LinkTypeIri[]; signal?: AbortSignal }): Promise<Map<LinkTypeIri, LinkTypeModel>> {
    return this.inner.linkTypes(p);
  }
  propertyTypes(p: { propertyIds: readonly PropertyTypeIri[]; signal?: AbortSignal }): Promise<Map<PropertyTypeIri, PropertyTypeModel>> {
    return this.inner.propertyTypes(p);
  }
  elements(p: { elementIds: readonly ElementIri[]; signal?: AbortSignal }): Promise<Map<ElementIri, ElementModel>> {
    return this.inner.elements(p);
  }
  links(p: { primary: readonly ElementIri[]; secondary: readonly ElementIri[]; linkTypeIds?: readonly LinkTypeIri[]; signal?: AbortSignal }): Promise<LinkModel[]> {
    return this.inner.links(p);
  }
  connectedLinkStats(p: { elementId: ElementIri; inexactCount?: boolean; signal?: AbortSignal }): Promise<DataProviderLinkCount[]> {
    return this.inner.connectedLinkStats(p);
  }
  async lookup(p: DataProviderLookupParams): Promise<DataProviderLookupItem[]> {
    const results = await this.inner.lookup(p);
    return results.filter(item => this.matchesViewMode(item.element.types));
  }

  private matchesViewMode(types: readonly ElementTypeIri[]): boolean {
    const s = new Set(types as string[]);
    const isA = [...s].some(t => ABOX_TYPES.has(t));
    const isT = [...s].some(t => TBOX_TYPES.has(t));
    if (isA && isT) return true; // punned — show in both
    if (this.viewMode === 'abox') return isA || (!isA && !isT);
    return isT;
  }
}
```

- [ ] Run — expect PASS

```bash
npx vitest run src/providers/__tests__/N3DataProvider.test.ts
```

- [ ] Commit

```bash
git add src/providers/N3DataProvider.ts src/providers/__tests__/N3DataProvider.test.ts
git commit -m "feat: add N3DataProvider wrapping RdfDataProvider with view mode filter"
```

---

## Task 3: WorkerQuad → RDF.js Quad Converter

> **Why this is required:** The N3 store lives entirely in `src/workers/rdfManager.worker.ts` (a Web Worker). When it emits the `subjects` event, quads cross the `postMessage` boundary via structured clone, which strips all prototype methods. What arrives on the main thread via `onSubjectsChange(subjects, quads)` are plain `WorkerQuad` objects — `{ termType, value, ... }` with no `.equals()` method. `RdfDataProvider.addGraph()` requires proper RDF.js Term objects. The converter is also needed for inference: inferred quads from `pyodide.worker.ts` arrive the same way and must be fed into the DataProvider to render dashed edges.

**Files:**
- Create: `src/providers/quadConverter.ts`
- Create: `src/providers/__tests__/quadConverter.test.ts`

Converts `WorkerQuad` plain objects from rdfManager into RDF.js `Quad` objects for `RdfDataProvider.addGraph()`.

- [ ] Write failing test — `src/providers/__tests__/quadConverter.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { workerQuadsToRdf } from '../quadConverter';

describe('workerQuadsToRdf', () => {
  it('converts a named-node quad', () => {
    const wq = {
      subject: { termType: 'NamedNode', value: 'http://ex.org/s' },
      predicate: { termType: 'NamedNode', value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' },
      object: { termType: 'NamedNode', value: 'http://ex.org/Class' },
      graph: { termType: 'NamedNode', value: 'urn:vg:data' },
    };
    const [q] = workerQuadsToRdf([wq as any]);
    expect(q.subject.value).toBe('http://ex.org/s');
    expect(q.object.value).toBe('http://ex.org/Class');
  });
  it('converts a language-tagged literal', () => {
    const wq = {
      subject: { termType: 'NamedNode', value: 'http://ex.org/s' },
      predicate: { termType: 'NamedNode', value: 'http://www.w3.org/2000/01/rdf-schema#label' },
      object: { termType: 'Literal', value: 'Hello', language: 'en' },
      graph: { termType: 'DefaultGraph', value: '' },
    };
    const [q] = workerQuadsToRdf([wq as any]);
    expect(q.object.termType).toBe('Literal');
    expect(q.object.language).toBe('en');
  });
  it('converts a blank node', () => {
    const wq = {
      subject: { termType: 'BlankNode', value: 'b0' },
      predicate: { termType: 'NamedNode', value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' },
      object: { termType: 'NamedNode', value: 'http://ex.org/Class' },
      graph: { termType: 'DefaultGraph', value: '' },
    };
    const [q] = workerQuadsToRdf([wq as any]);
    expect(q.subject.termType).toBe('BlankNode');
  });
});
```

- [ ] Run — expect FAIL

```bash
npx vitest run src/providers/__tests__/quadConverter.test.ts
```

- [ ] Implement `src/providers/quadConverter.ts`

Use `N3.DataFactory` — N3 is already a dependency and fully implements the RDF.js DataFactory spec. `N3.Quad` satisfies `RDF.Quad`, so the output is accepted directly by `RdfDataProvider.addGraph()`. Do NOT use `Rdf.OntodiaDataFactory` from reactodia — that would couple the conversion to reactodia's internals unnecessarily.

```typescript
import { DataFactory as f, type Quad, type Term } from 'n3';

interface WorkerTerm {
  termType: string;
  value: string;
  language?: string;
  datatype?: { value: string };
}
export interface WorkerQuad {
  subject: WorkerTerm;
  predicate: WorkerTerm;
  object: WorkerTerm;
  graph: WorkerTerm;
}

function toTerm(t: WorkerTerm): Term {
  if (t.termType === 'BlankNode') return f.blankNode(t.value);
  if (t.termType === 'Literal') {
    if (t.language) return f.literal(t.value, t.language);
    return f.literal(t.value, t.datatype ? f.namedNode(t.datatype.value) : undefined);
  }
  return f.namedNode(t.value);
}

export function workerQuadsToRdf(wqs: WorkerQuad[]): Quad[] {
  return wqs.map(wq => {
    const graph =
      !wq.graph || wq.graph.termType === 'DefaultGraph' || !wq.graph.value
        ? f.defaultGraph()
        : f.namedNode(wq.graph.value);
    return f.quad(
      toTerm(wq.subject) as ReturnType<typeof f.namedNode>,
      toTerm(wq.predicate) as ReturnType<typeof f.namedNode>,
      toTerm(wq.object),
      graph
    );
  });
}
```

- [ ] Run — expect PASS

```bash
npx vitest run src/providers/__tests__/quadConverter.test.ts
```

- [ ] Commit

```bash
git add src/providers/quadConverter.ts src/providers/__tests__/quadConverter.test.ts
git commit -m "feat: add WorkerQuad to RDF.js Quad converter"
```

---

## Task 4: RdfMetadataProvider stub

**Files:**
- Create: `src/providers/RdfMetadataProvider.ts`
- Create: `src/providers/__tests__/RdfMetadataProvider.test.ts`

Implements reactodia's `MetadataProvider` interface. In this stub all 8 methods return permissive defaults. `createEntity`/`createRelation` write to rdfManager. The `suppressSync` flag prevents circular re-renders when writing.

- [ ] Write failing test — `src/providers/__tests__/RdfMetadataProvider.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest';
import { RdfMetadataProvider } from '../RdfMetadataProvider';

const mockRdfManager = {
  applyBatch: vi.fn().mockResolvedValue(undefined),
  getNamespaces: vi.fn().mockReturnValue({}),
};

describe('RdfMetadataProvider', () => {
  it('instantiates', () => {
    expect(new RdfMetadataProvider(mockRdfManager as any)).toBeDefined();
  });
  it('getLiteralLanguages returns at least one language', () => {
    const p = new RdfMetadataProvider(mockRdfManager as any);
    expect(p.getLiteralLanguages().length).toBeGreaterThan(0);
  });
  it('suppressSync starts false', () => {
    const p = new RdfMetadataProvider(mockRdfManager as any);
    expect(p.suppressSync).toBe(false);
  });
  it('canConnect always resolves', async () => {
    const p = new RdfMetadataProvider(mockRdfManager as any);
    const result = await p.canConnect({} as any);
    expect(Array.isArray(result)).toBe(true);
  });
});
```

- [ ] Run — expect FAIL

```bash
npx vitest run src/providers/__tests__/RdfMetadataProvider.test.ts
```

- [ ] Implement `src/providers/RdfMetadataProvider.ts`

```typescript
import {
  BaseMetadataProvider,
  type MetadataProvider, type MetadataCanConnect, type MetadataCanModifyEntity,
  type MetadataCanModifyRelation, type MetadataCreatedEntity, type MetadataCreatedRelation,
  type MetadataEntityShape, type MetadataRelationShape,
  type ElementTypeIri, type ElementIri, type LinkTypeIri,
  Rdf,
} from '@reactodia/workspace';

interface RdfManagerLike {
  applyBatch(changes: { adds?: any[]; removes?: any[] }, graph?: string): Promise<void>;
  getNamespaces(): Record<string, string>;
}

export class RdfMetadataProvider implements MetadataProvider {
  /** Set to true before writing to rdfManager to suppress the sync loop */
  suppressSync = false;

  constructor(private readonly rdfManager: RdfManagerLike) {}

  getLiteralLanguages(): readonly string[] {
    return ['en', 'de', 'fr'];
  }

  // createEntity: returns { data: ElementModel } — NOT { iri }
  async createEntity(
    type: ElementTypeIri,
    options: { id?: ElementIri; language?: string; signal?: AbortSignal }
  ): Promise<MetadataCreatedEntity> {
    const iri = (options.id ?? `urn:vg:entity:${Date.now()}`) as ElementIri;
    const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    this.suppressSync = true;
    try {
      await this.rdfManager.applyBatch({
        adds: [
          { subject: { termType: 'NamedNode', value: iri }, predicate: { termType: 'NamedNode', value: rdfType }, object: { termType: 'NamedNode', value: type }, graph: { termType: 'NamedNode', value: 'urn:vg:data' } },
        ],
      });
    } finally {
      this.suppressSync = false;
    }
    // Return full ElementModel as required by MetadataCreatedEntity
    const data: Reactodia.ElementModel = { id: iri, types: [type], properties: {} };
    return { data };
  }

  // createRelation: source/target are ElementModel, not ElementIri
  async createRelation(
    source: Reactodia.ElementModel,
    target: Reactodia.ElementModel,
    linkType: LinkTypeIri,
    options: { language?: string; signal?: AbortSignal }
  ): Promise<MetadataCreatedRelation> {
    this.suppressSync = true;
    try {
      await this.rdfManager.applyBatch({
        adds: [
          { subject: { termType: 'NamedNode', value: source.id }, predicate: { termType: 'NamedNode', value: linkType }, object: { termType: 'NamedNode', value: target.id }, graph: { termType: 'NamedNode', value: 'urn:vg:data' } },
        ],
      });
    } finally {
      this.suppressSync = false;
    }
    const data: Reactodia.LinkModel = { linkTypeId: linkType, sourceId: source.id, targetId: target.id, properties: {} };
    return { data };
  }

  async canConnect(_params: unknown): Promise<MetadataCanConnect[]> {
    return []; // empty = unrestricted
  }

  async canModifyEntity(_params: unknown): Promise<MetadataCanModifyEntity> {
    return { canEdit: true, canDelete: true };
  }

  async canModifyRelation(_params: unknown): Promise<MetadataCanModifyRelation> {
    return { canEdit: true, canDelete: true };
  }

  // getEntityShape: properties must be ReadonlyMap, not []
  async getEntityShape(
    _types: ReadonlyArray<ElementTypeIri>,
    _options: unknown
  ): Promise<MetadataEntityShape> {
    return { properties: new Map() };
  }

  // getRelationShape takes 4 params: (linkType, source, target, options)
  async getRelationShape(
    _linkType: LinkTypeIri,
    _source: Reactodia.ElementModel,
    _target: Reactodia.ElementModel,
    _options: unknown
  ): Promise<MetadataRelationShape> {
    return { properties: new Map() };
  }

  async filterConstructibleTypes(
    types: ReadonlySet<ElementTypeIri>,
    _options: unknown
  ): Promise<ReadonlySet<ElementTypeIri>> {
    return types;
  }
}
```

- [ ] Run — expect PASS

```bash
npx vitest run src/providers/__tests__/RdfMetadataProvider.test.ts
```

- [ ] Commit

```bash
git add src/providers/RdfMetadataProvider.ts src/providers/__tests__/RdfMetadataProvider.test.ts
git commit -m "feat: add RdfMetadataProvider stub with write-back and suppressSync guard"
```

---

## Task 5: Basic ReactodiaCanvas (shell only, no templates yet)

**Files:**
- Create: `src/components/Canvas/ReactodiaCanvas.tsx`
- Modify: `src/pages/Index.tsx`

Mounts the reactodia `Workspace` + `Canvas` with the N3DataProvider. On load, calls `createNewDiagram` and `createElement` for every subject that rdfManager has seen. Leaves templates as `undefined` (reactodia uses its default `StandardTemplate`). The goal of this task is a working canvas that shows entities — visual polish comes later.

- [ ] Create `src/components/Canvas/ReactodiaCanvas.tsx`

```typescript
import React, { useRef } from 'react';
import * as Reactodia from '@reactodia/workspace';
import { rdfManager } from '@/utils/rdfManager';
import { N3DataProvider } from '@/providers/N3DataProvider';
import { RdfMetadataProvider } from '@/providers/RdfMetadataProvider';
import { workerQuadsToRdf } from '@/providers/quadConverter';
import type { WorkerQuad } from '@/utils/rdfSerialization'; // existing type from rdfManager
import TopBar from './TopBar';
import LeftSidebar from './LeftSidebar';
import { useCanvasState } from '@/hooks/useCanvasState';
import { useAppConfigStore } from '@/stores/appConfigStore';

// Must be at module scope — not inside a component
const Layouts = Reactodia.defineLayoutWorker(() =>
  new Worker(new URL('@reactodia/workspace/layout.worker', import.meta.url), { type: 'module' })
);

// Singletons — one per app lifetime
const dataProvider = new N3DataProvider();
const metadataProvider = new RdfMetadataProvider(rdfManager);

// Track all subject IRIs ever seen (for initial load and incremental adds)
const knownSubjects = new Set<string>();

export default function ReactodiaCanvas() {
  const { defaultLayout } = Reactodia.useWorker(Layouts);
  const { state: canvasState, actions } = useCanvasState();
  const config = useAppConfigStore(s => s.config);
  const [sidebarExpanded, setSidebarExpanded] = React.useState(true);

  const { onMount } = Reactodia.useLoadedWorkspace(async ({ context, signal }) => {
    const { model } = context;

    actions.setLoading(true, 0, 'Initialising canvas...');

    // Sync whatever is already in the N3 store into RdfDataProvider
    // (rdfManager will have emitted subjects if files were loaded before mount)
    // Then create diagram
    await model.createNewDiagram({ dataProvider, signal });

    for (const iri of knownSubjects) {
      model.createElement(iri as Reactodia.ElementIri);
    }

    if (knownSubjects.size > 0) {
      await context.performLayout({ layoutFunction: defaultLayout, animate: false, signal });
    }

    actions.setLoading(false, 100, 'Canvas ready');
  }, [defaultLayout]);

  // Subscribe to rdfManager changes
  React.useEffect(() => {
    const handler = (subjects: string[], quads?: WorkerQuad[]) => {
      if (metadataProvider.suppressSync) return;

      if (quads && quads.length > 0) {
        dataProvider.addGraph(workerQuadsToRdf(quads));
      }

      // Note: we cannot access model here without a ref — handled in onMount subscription
      subjects.forEach(s => knownSubjects.add(s));
    };

    rdfManager.onSubjectsChange(handler as any);
    return () => rdfManager.offSubjectsChange(handler as any);
  }, []);

  return (
    <div className="w-full h-screen flex flex-col overflow-hidden">
      <Reactodia.Workspace
        ref={onMount}
        defaultLayout={defaultLayout}
        metadataProvider={metadataProvider}
      >
        <div className="flex flex-1 overflow-hidden">
          <LeftSidebar
            isExpanded={sidebarExpanded}
            onToggle={() => setSidebarExpanded(v => !v)}
            onLoadOntology={() => {}}
            onLoadFile={() => {}}
            onClearData={() => {}}
            onExport={() => {}}
            onSettings={() => {}}
          />
          <div className="flex flex-col flex-1 overflow-hidden">
            <TopBar
              onAddNode={() => {}}
              onToggleLegend={() => {}}
              showLegend={false}
              viewMode={canvasState.viewMode}
              onViewModeChange={() => {}}
              ontologyCount={0}
            />
            <Reactodia.Canvas>
              <Reactodia.Navigator />
              <Reactodia.ZoomControl />
            </Reactodia.Canvas>
          </div>
        </div>
      </Reactodia.Workspace>
    </div>
  );
}
```

- [ ] Update `src/pages/Index.tsx` to use ReactodiaCanvas

```typescript
import ReactodiaCanvas from '../components/Canvas/ReactodiaCanvas';

const Index = () => (
  <main className="w-full h-screen overflow-hidden">
    <ReactodiaCanvas />
  </main>
);

export default Index;
```

- [ ] Start dev server and verify the canvas mounts without a white screen

```bash
npm run dev
```

Open `http://localhost:8080` — expect reactodia canvas to render (empty if no data loaded).

- [ ] Load a Turtle file via the sidebar and verify entities appear on the canvas

- [ ] Commit

```bash
git add src/components/Canvas/ReactodiaCanvas.tsx src/pages/Index.tsx
git commit -m "feat: mount basic ReactodiaCanvas replacing KnowledgeCanvas shell"
```

---

## Task 6: Incremental Sync (onSubjectsChange → model)

**Files:**
- Modify: `src/components/Canvas/ReactodiaCanvas.tsx`

The Task 5 canvas subscribes to `onSubjectsChange` but cannot reach the model from outside `useLoadedWorkspace`. This task wires incremental adds/removes to the live model using a ref.

- [ ] Add model ref and incremental handler to `ReactodiaCanvas.tsx`

Replace the `useEffect` subscription section and add a `modelRef`:

```typescript
// At the top of the component, add:
const modelRef = useRef<Reactodia.DataDiagramModel | null>(null);

// Update useLoadedWorkspace to store model ref:
const { onMount } = Reactodia.useLoadedWorkspace(async ({ context, signal }) => {
  const { model } = context;
  modelRef.current = model; // store for incremental sync
  // ... rest of initialization unchanged
}, [defaultLayout]);

// Replace the useEffect subscription:
React.useEffect(() => {
  const handler = (subjects: string[], quads?: WorkerQuad[]) => {
    if (metadataProvider.suppressSync) return;

    const model = modelRef.current;

    // model.elements is ReadonlyArray<Element> — each element has .id (diagram id) and .data.id (IRI)
    const existingIris = new Set(
      model
        ? model.elements.map(el => (el.data as Reactodia.ElementModel | undefined)?.id ?? '')
        : []
    );
    const added = subjects.filter(s => !existingIris.has(s));
    const changed = subjects.filter(s => existingIris.has(s));

    subjects.forEach(s => knownSubjects.add(s));

    if (quads && quads.length > 0) {
      dataProvider.addGraph(workerQuadsToRdf(quads));
    }

    if (!model) return;

    for (const iri of added) {
      model.createElement(iri as Reactodia.ElementIri);
    }

    // Lookup element by IRI: scan elements array
    for (const iri of changed) {
      const el = model.elements.find(
        e => (e.data as Reactodia.ElementModel | undefined)?.id === iri
      );
      el?.redraw();
    }
  };

  rdfManager.onSubjectsChange(handler as any);
  return () => rdfManager.offSubjectsChange(handler as any);
}, []);
```

Note: `model.elements` is a `ReadonlyArray<Element>`. Each element's IRI is at `(el.data as ElementModel).id`. No `findElement(iri)` method exists — use `.find()` on the array.

- [ ] Verify: load a Turtle file → entities appear. Add a single triple via browser console → new node appears without full reload.

```javascript
// In browser console (for testing):
window.__vg_test_add = async () => {
  await window.rdfManager?.applyBatch({
    adds: [{ subject: {termType:'NamedNode',value:'http://test.org/NewNode'}, predicate: {termType:'NamedNode',value:'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'}, object: {termType:'NamedNode',value:'http://www.w3.org/2002/07/owl#NamedIndividual'}, graph: {termType:'NamedNode',value:'urn:vg:data'} }]
  });
};
```

- [ ] Commit

```bash
git add src/components/Canvas/ReactodiaCanvas.tsx
git commit -m "feat: wire incremental model sync from rdfManager.onSubjectsChange"
```

---

## Task 7: RdfElementTemplate

**Files:**
- Create: `src/templates/RdfElementTemplate.tsx`
- Modify: `src/components/Canvas/ReactodiaCanvas.tsx`

Custom `ElementTemplate` that replaces RDFNode visuals. Shows: namespace color bar, type badge, label, up to 6 literal properties, inferred properties section (italic + sparkle), reasoning error/warning border.

**Key reactodia template API:**
```typescript
// ElementTemplate interface:
interface ElementTemplate {
  renderElement(props: TemplateProps): React.ReactNode;
}
// Actual TemplateProps fields (NOT selectable/selected — those don't exist):
interface TemplateProps {
  elementId: string;          // diagram-internal id
  element: Reactodia.Element; // the diagram element object
  isExpanded: boolean;
  elementState: TemplateState;
  onlySelected: boolean;      // true when this element is the only selected one
}
// Get data: element.data as ElementModel
// ElementModel.types: readonly ElementTypeIri[]
// ElementModel.properties: { [propertyIri]: ReadonlyArray<Rdf.NamedNode | Rdf.Literal> }

// ElementTemplateResolver takes ONE argument (element), not (types, element):
type ElementTemplateResolver = (element: Element) => ElementTemplate | undefined;
```

- [ ] Implement `src/templates/RdfElementTemplate.tsx`

```typescript
import React from 'react';
import * as Reactodia from '@reactodia/workspace';
import { usePaletteFromRdfManager } from '@/components/Canvas/core/namespacePalette';

const RDF_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const INFERRED_GRAPH = 'urn:vg:inferred';
const MAX_PROPS = 6;

function extractNamespace(iri: string): string {
  const hash = iri.lastIndexOf('#');
  if (hash > 0) return iri.slice(0, hash + 1);
  const slash = iri.lastIndexOf('/');
  if (slash > 0) return iri.slice(0, slash + 1);
  return iri;
}

function getLabel(data: Reactodia.ElementModel, prefixes: Record<string, string>): string {
  const labels = data.properties[RDF_LABEL];
  if (labels && labels.length > 0) {
    const lit = labels[0];
    if (lit.termType === 'Literal') return lit.value;
  }
  // Prefix-shorten the IRI
  for (const [prefix, uri] of Object.entries(prefixes)) {
    if (data.id.startsWith(uri)) return `${prefix}:${data.id.slice(uri.length)}`;
  }
  return data.id.split(/[/#]/).pop() ?? data.id;
}

function RdfElementBody({ props }: { props: Reactodia.TemplateProps }) {
  const palette = usePaletteFromRdfManager();
  const data = props.element.data as Reactodia.ElementModel | undefined;
  if (!data) return <div className="p-2 text-xs text-muted-foreground">Loading…</div>;

  const primaryType = data.types[0] ?? '';
  const ns = extractNamespace(primaryType);
  const color = palette[ns] ?? '#94a3b8';
  const label = getLabel(data, {}); // prefixes wired in Task 9
  const propEntries = Object.entries(data.properties).slice(0, MAX_PROPS);

  return (
    <div
      className="flex rounded overflow-hidden text-sm bg-white dark:bg-slate-900 shadow"
      style={{ minWidth: 160, border: props.onlySelected ? `2px solid ${color}` : '1px solid #e2e8f0' }}
    >
      {/* Namespace color bar */}
      <div style={{ width: 6, background: color, flexShrink: 0 }} />
      <div className="flex flex-col flex-1 p-2 gap-1">
        {/* Type badge */}
        <div className="flex items-center gap-1">
          <span
            className="text-xs px-1 rounded truncate max-w-[120px]"
            style={{ background: color + '33', color }}
          >
            {primaryType.split(/[/#]/).pop()}
          </span>
        </div>
        {/* Label */}
        <div className="font-medium truncate">{label}</div>
        {/* Properties */}
        {propEntries.map(([predIri, vals]) => (
          <div key={predIri} className="flex gap-1 text-xs text-muted-foreground">
            <span className="truncate max-w-[60px]">{predIri.split(/[/#]/).pop()}</span>
            <span className="truncate flex-1">{vals[0]?.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export const RdfElementTemplate: Reactodia.ElementTemplate = {
  renderElement: (props) => <RdfElementBody props={props} />,
};

// ElementTemplateResolver takes ONE argument — the element, not (types, element)
export function rdfElementTemplateResolver(
  _element: Reactodia.Element
): Reactodia.ElementTemplate {
  return RdfElementTemplate;
}
```

- [ ] Wire template into `ReactodiaCanvas.tsx` — update the `Canvas` element:

```typescript
import { rdfElementTemplateResolver } from '@/templates/RdfElementTemplate';

// In JSX:
<Reactodia.Canvas elementTemplateResolver={rdfElementTemplateResolver}>
```

- [ ] Verify: load Turtle → nodes show label, color bar, type badge

- [ ] Commit

```bash
git add src/templates/RdfElementTemplate.tsx src/components/Canvas/ReactodiaCanvas.tsx
git commit -m "feat: add RdfElementTemplate with label, type badge, namespace color bar"
```

---

## Task 8: RdfLinkTemplate

**Files:**
- Create: `src/templates/RdfLinkTemplate.tsx`
- Modify: `src/components/Canvas/ReactodiaCanvas.tsx`

Custom `LinkTemplate` that replaces ObjectPropertyEdge. Shows prefix-shortened property label, arrow at target, dashed style for inferred links.

**Key reactodia link template API:**
```typescript
interface LinkTemplate {
  markerTarget?: React.ComponentType<LinkMarkerStyle>;
  renderLink(props: LinkTemplateProps): React.ReactNode;
}
interface LinkTemplateProps {
  link: Reactodia.Link;
  sizeProvider: SizeProvider;
  routedLink: RoutedLink; // has .vertices
}
// link.data as LinkModel — linkModel.properties for inferred flag
// link.typeId — the property IRI
```

- [ ] Implement `src/templates/RdfLinkTemplate.tsx`

```typescript
import React from 'react';
import * as Reactodia from '@reactodia/workspace';

const INFERRED_PRED = 'urn:vg:isInferred';

function isInferred(link: Reactodia.Link): boolean {
  const data = link.data as Reactodia.LinkModel | undefined;
  return !!(data?.properties?.[INFERRED_PRED]?.length);
}

function prefixShorten(iri: string, prefixes: Record<string, string>): string {
  for (const [prefix, uri] of Object.entries(prefixes)) {
    if (iri.startsWith(uri)) return `${prefix}:${iri.slice(uri.length)}`;
  }
  return iri.split(/[/#]/).pop() ?? iri;
}

function RdfLinkBody({ props }: { props: Reactodia.LinkTemplateProps }) {
  const inferred = isInferred(props.link);
  // StandardRelation has no `label` prop — it renders the link type label automatically
  // from model.getLinkType(link.typeId). Custom labels can be injected via `prependLabels`.
  return (
    <Reactodia.StandardRelation
      {...props}
      pathProps={{ strokeDasharray: inferred ? '6 3' : undefined }}
    />
  );
}

export const RdfLinkTemplate: Reactodia.LinkTemplate = {
  markerTarget: Reactodia.LinkMarkerArrowhead,
  renderLink: (props) => <RdfLinkBody props={props} />,
};

export function rdfLinkTemplateResolver(
  _typeId: Reactodia.LinkTypeIri | undefined,
  _link: Reactodia.Link
): Reactodia.LinkTemplate {
  return RdfLinkTemplate;
}
```

- [ ] Wire into `ReactodiaCanvas.tsx`:

```typescript
import { rdfLinkTemplateResolver } from '@/templates/RdfLinkTemplate';

<Reactodia.Canvas
  elementTemplateResolver={rdfElementTemplateResolver}
  linkTemplateResolver={rdfLinkTemplateResolver}
>
```

- [ ] Verify: load Turtle with object properties → edges show prefixed labels and arrows. Inferred edges (from `urn:vg:inferred` graph) should be dashed.

- [ ] Commit

```bash
git add src/templates/RdfLinkTemplate.tsx src/components/Canvas/ReactodiaCanvas.tsx
git commit -m "feat: add RdfLinkTemplate with prefixed label and inferred dash style"
```

---

## Task 9: TypeStyleResolver + prefix shortening

**Files:**
- Modify: `src/templates/RdfElementTemplate.tsx`
- Modify: `src/templates/RdfLinkTemplate.tsx`
- Modify: `src/components/Canvas/ReactodiaCanvas.tsx`

Wires `namespacePalette.ts` into reactodia's `TypeStyleResolver` and passes prefixes to templates.

**How `TypeStyleResolver` works:**
```typescript
// Passed to Workspace:
const typeStyleResolver: Reactodia.TypeStyleResolver = (types) => {
  const ns = extractNamespace(types[0] ?? '');
  const color = palette[ns];
  return color ? { color } : undefined;
};
<Reactodia.Workspace typeStyleResolver={typeStyleResolver} ...>
```

- [ ] Create a shared prefix util at `src/utils/prefixShorten.ts`:

```typescript
export function prefixShorten(iri: string, prefixes: Record<string, string>): string {
  for (const [prefix, uri] of Object.entries(prefixes)) {
    if (iri.startsWith(uri)) return `${prefix}:${iri.slice(uri.length)}`;
  }
  return iri.split(/[/#]/).pop() ?? iri;
}
```

- [ ] Update `ReactodiaCanvas.tsx` to pass `typeStyleResolver` to `Workspace`:

```typescript
import { usePaletteFromRdfManager } from '@/components/Canvas/core/namespacePalette';
import { useOntologyStore } from '@/stores/ontologyStore';

// Inside the component:
const palette = usePaletteFromRdfManager();
const namespaces = useOntologyStore(s => s.namespaceRegistry);
const prefixes = React.useMemo(
  () => Object.fromEntries(namespaces.map((n: any) => [n.prefix, n.uri ?? n.namespace])),
  [namespaces]
);

const typeStyleResolver = React.useCallback<Reactodia.TypeStyleResolver>(
  (types) => {
    const ns = extractNamespace(types[0] ?? '');
    const color = palette[ns];
    return color ? { color } : undefined;
  },
  [palette]
);

// Pass to Workspace:
<Reactodia.Workspace
  ref={onMount}
  defaultLayout={defaultLayout}
  metadataProvider={metadataProvider}
  typeStyleResolver={typeStyleResolver}
>
```

- [ ] Update `RdfElementTemplate` and `RdfLinkTemplate` to accept and use `prefixes` via React context:

Create `src/providers/PrefixContext.ts`:
```typescript
import React from 'react';
export const PrefixContext = React.createContext<Record<string, string>>({});
```

Wrap canvas in `ReactodiaCanvas.tsx`:
```typescript
import { PrefixContext } from '@/providers/PrefixContext';
// ... wrap Canvas:
<PrefixContext.Provider value={prefixes}>
  <Reactodia.Canvas ...>
```

In templates use `const prefixes = React.useContext(PrefixContext)`.

- [ ] Verify: nodes and edges show `owl:Class`, `rdfs:label` style shortened labels. Namespace color bar matches legend.

- [ ] Commit

```bash
git add src/templates/RdfElementTemplate.tsx src/templates/RdfLinkTemplate.tsx src/components/Canvas/ReactodiaCanvas.tsx src/providers/PrefixContext.ts src/utils/prefixShorten.ts
git commit -m "feat: wire TypeStyleResolver and prefix shortening from namespace registry"
```

---

## Task 10: ABox / TBox View Mode

**Files:**
- Modify: `src/components/Canvas/ReactodiaCanvas.tsx`

When the user toggles view mode, switch `N3DataProvider`'s filter and rebuild the canvas elements.

- [ ] Add view mode switching to `ReactodiaCanvas.tsx`

```typescript
// At module level (alongside dataProvider singleton):
let currentViewMode: ViewMode = 'abox';

// Inside component, subscribe to canvasState.viewMode changes:
React.useEffect(() => {
  const mode = canvasState.viewMode as ViewMode;
  if (mode === currentViewMode) return;
  currentViewMode = mode;

  const model = modelRef.current;
  if (!model) return;

  dataProvider.setViewMode(mode);

  // Remove all elements and re-add matching ones
  const allIris = [...knownSubjects];
  // model.elements is ReadonlyArray<Element> — copy before mutating
  for (const el of [...model.elements]) {
    model.removeElement(el.id); // el.id is the diagram-internal string id
  }
  for (const iri of allIris) {
    model.createElement(iri as Reactodia.ElementIri);
  }
}, [canvasState.viewMode]);
```

Note: `model.elements` is `ReadonlyArray<Element>`. Spread it before iterating if mutating. `el.id` is the diagram-internal id (not the IRI). `model.removeElement(id: string)` takes this diagram id.

- [ ] Wire `onViewModeChange` in TopBar to `useCanvasState`:

```typescript
// In ReactodiaCanvas.tsx TopBar props:
onViewModeChange={(mode) => actions.setViewMode(mode)}
```

- [ ] Verify: toggle ABox/TBox in TopBar → canvas shows correct subset of entities.

- [ ] Commit

```bash
git add src/components/Canvas/ReactodiaCanvas.tsx
git commit -m "feat: ABox/TBox view mode switches N3DataProvider filter and rebuilds canvas"
```

---

## Task 11: Widgets — Search, Navigation, Editing

**Files:**
- Modify: `src/components/Canvas/ReactodiaCanvas.tsx`

Wire reactodia's built-in widgets: `InstancesSearch` (entity search + drag onto canvas), `ClassTree` (class browser), `UnifiedSearch`, `DropOnCanvas`, `Selection` with actions, `VisualAuthoring`.

- [ ] Add widgets to the Canvas children in `ReactodiaCanvas.tsx`:

```typescript
import {
  Navigator, ZoomControl, InstancesSearch, ClassTree, UnifiedSearch,
  DropOnCanvas, Selection, SelectionActionRemove, SelectionActionZoomToFit,
  SelectionActionLayout, SelectionActionExpand, SelectionActionConnections,
  VisualAuthoring,
} from '@reactodia/workspace';

// Inside <Reactodia.Canvas>:
<Reactodia.Canvas
  elementTemplateResolver={rdfElementTemplateResolver}
  linkTemplateResolver={rdfLinkTemplateResolver}
>
  {/* Navigation */}
  <Reactodia.Navigator />
  <Reactodia.ZoomControl />

  {/* Drag-and-drop entities from search onto canvas */}
  <Reactodia.DropOnCanvas />

  {/* Selection toolbar shown on selected element */}
  <Reactodia.Selection>
    <Reactodia.SelectionActionRemove />
    <Reactodia.SelectionActionZoomToFit />
    <Reactodia.SelectionActionLayout />
    <Reactodia.SelectionActionExpand />
    <Reactodia.SelectionActionConnections />
  </Reactodia.Selection>

  {/* Editing — double-click node to edit properties */}
  <Reactodia.VisualAuthoring
    inputResolver={(property, inputProps) => {
      // Use default text inputs for all properties for now
      return undefined;
    }}
  />

  {/* Search panel — Ctrl+F opens UnifiedSearch */}
  <Reactodia.UnifiedSearch />
</Reactodia.Canvas>
```

- [ ] Add `InstancesSearch` and `ClassTree` as a side panel in the canvas layout (left of canvas, inside the flex row). This gives users a browseable class/entity panel for drag-drop:

```typescript
// In the flex row containing Canvas, add before <Reactodia.Canvas>:
<div className="w-64 border-r overflow-y-auto flex-shrink-0">
  <Reactodia.ClassTree />
</div>
```

- [ ] Wire the "Add Node" TopBar button to open `UnifiedSearch` via the command bus:

```typescript
import { UnifiedSearchTopic } from '@reactodia/workspace';

// Inside useLoadedWorkspace callback, store getCommandBus ref:
const commandBusRef = useRef<ReturnType<WorkspaceContext['getCommandBus']> | null>(null);

// In useLoadedWorkspace:
const { model, getCommandBus } = context;
commandBusRef.current = getCommandBus;

// In TopBar onAddNode callback:
onAddNode={() => {
  // UnifiedSearchTopic.focus opens the search panel
  // InstancesSearchTopic has no 'focus' command — only 'setCriteria' and 'findCapabilities'
  commandBusRef.current?.(UnifiedSearchTopic).trigger('focus', {});
}}
```

- [ ] Verify: clicking "Add Node" opens InstancesSearch. Dragging a class from ClassTree onto canvas creates an element. Double-clicking a node opens VisualAuthoring edit dialog.

- [ ] Commit

```bash
git add src/components/Canvas/ReactodiaCanvas.tsx
git commit -m "feat: add reactodia widgets — search, selection actions, visual authoring, class tree"
```

---

## Task 12: RdfValidationProvider + Reasoning Visualization

**Files:**
- Create: `src/providers/RdfValidationProvider.ts`
- Modify: `src/components/Canvas/ReactodiaCanvas.tsx`

Reads reasoning errors/warnings from the `urn:vg:inferred` graph via rdfManager and surfaces them as reactodia `ValidationResult`s. Reactodia passes these to element templates via the editor's validation state.

- [ ] Implement `src/providers/RdfValidationProvider.ts`

```typescript
import type { ValidationProvider, ElementIri, LinkKey } from '@reactodia/workspace';

const ERROR_PRED = 'urn:vg:reasoningError';
const WARNING_PRED = 'urn:vg:reasoningWarning';

interface RdfManagerLike {
  onSubjectsChange(cb: (...args: any[]) => void): void;
  offSubjectsChange(cb: (...args: any[]) => void): void;
}

export class RdfValidationProvider implements ValidationProvider {
  constructor(private readonly rdfManager: RdfManagerLike) {}

  async validate(params: {
    elements: ReadonlyMap<ElementIri, any>;
    links: ReadonlyMap<LinkKey, any>;
    signal?: AbortSignal;
  }): Promise<ReadonlyMap<ElementIri | LinkKey, any>> {
    const results = new Map<ElementIri | LinkKey, any>();

    for (const [iri, elementModel] of params.elements) {
      const errors = elementModel.properties?.[ERROR_PRED] ?? [];
      const warnings = elementModel.properties?.[WARNING_PRED] ?? [];

      if (errors.length > 0) {
        results.set(iri, { severity: 'error', message: errors[0]?.value ?? 'Reasoning error' });
      } else if (warnings.length > 0) {
        results.set(iri, { severity: 'warning', message: warnings[0]?.value ?? 'Reasoning warning' });
      }
    }

    return results;
  }
}
```

- [ ] Wire `validationProvider` to `Workspace` in `ReactodiaCanvas.tsx`:

```typescript
import { RdfValidationProvider } from '@/providers/RdfValidationProvider';

const validationProvider = new RdfValidationProvider(rdfManager);

// In Workspace:
<Reactodia.Workspace
  ref={onMount}
  defaultLayout={defaultLayout}
  metadataProvider={metadataProvider}
  validationProvider={validationProvider}
  typeStyleResolver={typeStyleResolver}
>
```

- [ ] Update `RdfElementTemplate.tsx` to render error/warning border using the element's validation state:

Reactodia sets `element.elementState` — read it to apply border styles. Check `EditorController.validationState.elements.get(element.iri)`:

```typescript
// In RdfElementBody, read from editor context:
const { editor } = Reactodia.useWorkspace();
const validation = editor?.validationState?.elements?.get(data.id as Reactodia.ElementIri);
const borderColor = validation?.severity === 'error' ? '#ef4444'
  : validation?.severity === 'warning' ? '#f59e0b'
  : undefined;

// Apply to outer div:
style={{ border: borderColor ? `2px solid ${borderColor}` : undefined }}
```

- [ ] Verify: run reasoning → inferred edges appear dashed, nodes with reasoning errors get red border, warnings get amber border.

- [ ] Commit

```bash
git add src/providers/RdfValidationProvider.ts src/templates/RdfElementTemplate.tsx src/components/Canvas/ReactodiaCanvas.tsx
git commit -m "feat: add reasoning validation — error/warning borders via ValidationProvider"
```

---

## Task 13: Export (PNG and SVG)

**Files:**
- Modify: `src/components/Canvas/ReactodiaCanvas.tsx`
- Modify: `src/components/Canvas/LeftSidebar.tsx`

Wire the LeftSidebar export button to `canvasApi.exportRaster()` and `canvasApi.exportSvg()`.

- [ ] Store canvas API ref in ReactodiaCanvas.tsx:

```typescript
const canvasApiRef = useRef<Reactodia.CanvasApi | null>(null);

// In useLoadedWorkspace:
const { onMount } = Reactodia.useLoadedWorkspace(async ({ context, signal }) => {
  const { model, view } = context;
  // WorkspaceContext has no 'canvas' property — get canvas via view.findAnyCanvas()
  const canvas = view.findAnyCanvas();
  if (canvas) {
    canvasApiRef.current = canvas;
  }
  modelRef.current = model;
  // ... rest unchanged
}, [defaultLayout]);
```

- [ ] Add export helpers and expose via callback props:

```typescript
async function handleExport() {
  const canvas = canvasApiRef.current;
  if (!canvas) return;
  const dataUrl = await canvas.exportRaster({ pixelRatio: 2 });
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = 'knowledgegraph.png';
  a.click();
}

async function handleExportSvg() {
  const canvas = canvasApiRef.current;
  if (!canvas) return;
  const svgString = await canvas.exportSvg({});
  const blob = new Blob([svgString], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'knowledgegraph.svg';
  a.click();
  URL.revokeObjectURL(url);
}
```

- [ ] Pass `onExport={handleExport}` to LeftSidebar (already accepts this prop).

- [ ] Verify: clicking Export in sidebar downloads a PNG of the current canvas.

- [ ] Commit

```bash
git add src/components/Canvas/ReactodiaCanvas.tsx
git commit -m "feat: wire canvas PNG and SVG export via canvasApi.exportRaster/exportSvg"
```

---

## Task 14: Namespace Legend Port

**Files:**
- Modify: `src/components/Canvas/ReactodiaCanvas.tsx`

`ResizableNamespaceLegend.tsx` has no reactodia equivalent. Keep it as a floating panel over the canvas, toggled by the TopBar legend button, positioned via absolute CSS inside the canvas container div.

- [ ] In `ReactodiaCanvas.tsx`, add legend state and overlay:

```typescript
import ResizableNamespaceLegend from './ResizableNamespaceLegend';

// In component:
const { state: canvasState, actions } = useCanvasState();

// In JSX, inside the canvas container div (position: relative), after Reactodia.Canvas:
{canvasState.showLegend && (
  <div className="absolute bottom-4 left-4 z-10 pointer-events-auto">
    <ResizableNamespaceLegend />
  </div>
)}
```

- [ ] Wire TopBar legend toggle:

```typescript
onToggleLegend={() => actions.toggleLegend()}
showLegend={canvasState.showLegend}
```

- [ ] Verify: clicking legend icon in TopBar shows/hides the namespace legend panel.

- [ ] Commit

```bash
git add src/components/Canvas/ReactodiaCanvas.tsx
git commit -m "feat: port namespace legend as floating overlay over reactodia canvas"
```

---

## Task 15: Cleanup — Remove React Flow Code

**Files:** Multiple deletions and modifications

Delete all React Flow components and the old KnowledgeCanvas.

- [ ] Delete React Flow component files:

```bash
rm src/components/Canvas/KnowledgeCanvas.tsx
rm src/components/Canvas/RDFNode.tsx
rm src/components/Canvas/ClusterNode.tsx
rm src/components/Canvas/ObjectPropertyEdge.tsx
rm src/components/Canvas/ClusterPropertyEdge.tsx
rm src/components/Canvas/ClusterEdge.tsx
rm src/components/Canvas/FloatingConnectionLine.tsx
rm src/components/Canvas/LayoutManager.ts
rm src/components/Canvas/NodePropertyEditor.tsx
rm src/components/Canvas/LinkPropertyEditor.tsx
rm src/components/Canvas/SearchOverlay.tsx
rm src/components/Canvas/NodeSearch.tsx
rm src/components/Canvas/core/mappingHelpers.ts
rm src/components/Canvas/core/diagramChangeHelpers.ts
```

Do NOT delete:
- `ActivityNode.tsx` — deferred, keep for later
- `core/clusterHelpers.ts` + algorithm files — deferred clustering task
- `core/namespacePalette.ts` — still used
- `core/exportHelpers.ts` — may still have utility functions
- `ResizableNamespaceLegend.tsx`, `NamespaceLegendCore.tsx` — still used

- [ ] Fix any remaining TypeScript import errors caused by the deletions:

```bash
npx tsc --noEmit 2>&1 | grep "error TS"
```

Fix each error by updating or removing the broken import.

- [ ] Run full build:

```bash
npm run build
```

Expected: successful build with no errors (warnings OK).

- [ ] Smoke test: open app, load a Turtle file, verify full functionality.

- [ ] Commit

```bash
git add -A
git commit -m "chore: remove all React Flow components — migration complete"
```

---

## Task 16: Performance Test

No code changes. Verify the migration delivered the expected performance improvement.

- [ ] Load the large test graph (the one that was slow in React Flow):

Open the app, load a graph with 500+ nodes via the sidebar.

- [ ] Measure key metrics:

1. **Initial render time** — time from file load to canvas showing all nodes (check console for timing if any, or use browser DevTools Performance tab)
2. **Pan/zoom FPS** — hold drag on canvas and observe DevTools FPS overlay (should be 60fps)
3. **Node hover** — hover over nodes rapidly, verify no jank
4. **Large graph layout** — click layout button, verify UI stays interactive while layout runs (web worker)

- [ ] Compare with React Flow baseline from `docs/reactodia-vs-reactflow-analysis.md`.

- [ ] Document findings in a brief note appended to the analysis doc.

- [ ] Commit

```bash
git add docs/reactodia-vs-reactflow-analysis.md
git commit -m "docs: add performance test results after reactodia migration"
```

---

## Verification Checklist

After all 16 tasks:

- [ ] Load a Turtle file → entities appear on canvas with correct labels and namespace colors
- [ ] Load a file with object properties → edges appear with prefixed labels and arrows
- [ ] Toggle ABox/TBox → correct entity subset shown
- [ ] Click layout → canvas rearranges without UI stutter
- [ ] Drag entity from ClassTree onto canvas → new element appears
- [ ] Search with UnifiedSearch (Ctrl+F) → finds entities by label
- [ ] Double-click node → VisualAuthoring dialog opens
- [ ] Edit a property → change persisted to N3 store (verify via RDF export)
- [ ] Delete entity → removed from canvas and N3 store
- [ ] Run reasoning → inferred edges dashed, error/warning node borders
- [ ] Export PNG → downloads full canvas image
- [ ] No `@xyflow/react` or `reactflow` imports anywhere in src/
- [ ] `npm run build` produces zero TypeScript errors
