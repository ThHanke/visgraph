# Remove Fat Map — Reactodia DataProvider Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fat map (ontology class/property index built via reconcile) with on-demand queries to the N3DataProvider, which is extended to also receive ontology graph quads.

**Architecture:** N3DataProvider gains a `getDomainRange()` method for synchronous schema queries. A new `ontologyQueries.ts` provides `fetchClasses`, `fetchLinkTypes`, and `scoreLinkTypes`. ReactodiaCanvas is changed to feed `urn:vg:ontologies` quads into the DataProvider. EntityAutoComplete loads from DataProvider; LinkPropertyEditor passes scoring context. Fat map code in ontologyStore, rdfManager, and storeHelpers is deleted.

**Tech Stack:** TypeScript, React, Vitest, @reactodia/workspace RdfDataProvider, Zustand

---

## File Map

| File | Change |
|------|--------|
| `src/providers/N3DataProvider.ts` | Add `getDomainRange(iri): {domains, ranges}` method |
| `src/utils/ontologyQueries.ts` | **Create** — `fetchClasses`, `fetchLinkTypes`, `scoreLinkTypes` |
| `src/providers/N3DataProvider.test.ts` | Add `getDomainRange` tests |
| `src/utils/__tests__/ontologyQueries.test.ts` | **Create** — unit tests |
| `src/components/Canvas/ReactodiaCanvas.tsx` | Feed ontology quads to dataProvider; simplify metadataProvider construction |
| `src/providers/RdfMetadataProvider.ts` | Replace OntologyAccessor with N3DataProvider in canConnect |
| `src/providers/__tests__/RdfMetadataProvider.test.ts` | Update for new constructor |
| `src/components/ui/EntityAutoComplete.tsx` | Load from DataProvider; add tier separators |
| `src/components/Canvas/LinkPropertyEditor.tsx` | Pass `dataProvider`/`sourceClassIri`/`targetClassIri` to EntityAutoComplete |
| `src/stores/ontologyStore.ts` | Delete fat map state and functions |
| `src/utils/rdfManager.impl.ts` | Delete `runReconcile` fat map branches |
| `src/utils/storeHelpers.ts` | Delete `getAvailableProperties`, `getAvailableClasses`, `fatMapToEntities` |
| `src/__tests__/stores/updateFatMap.*.test.ts` | Delete (fat map gone) |

---

### Task 1: Add `getDomainRange` to N3DataProvider

**Files:**
- Modify: `src/providers/N3DataProvider.ts`
- Modify: `src/providers/__tests__/N3DataProvider.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/providers/__tests__/N3DataProvider.test.ts`:

```typescript
import { DataFactory } from 'n3';
const { namedNode, quad, defaultGraph } = DataFactory;

const RDFS_DOMAIN = 'http://www.w3.org/2000/01/rdf-schema#domain';
const RDFS_RANGE  = 'http://www.w3.org/2000/01/rdf-schema#range';
const RDF_TYPE    = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

describe('N3DataProvider.getDomainRange', () => {
  it('returns domains and ranges declared for a property', () => {
    const p = new N3DataProvider();
    p.addGraph([
      quad(namedNode('http://ex.org/knows'), namedNode(RDFS_DOMAIN), namedNode('http://ex.org/Person'), defaultGraph()),
      quad(namedNode('http://ex.org/knows'), namedNode(RDFS_RANGE),  namedNode('http://ex.org/Person'), defaultGraph()),
    ]);
    const { domains, ranges } = p.getDomainRange('http://ex.org/knows');
    expect(domains).toEqual(['http://ex.org/Person']);
    expect(ranges).toEqual(['http://ex.org/Person']);
  });

  it('returns empty arrays when no domain/range declared', () => {
    const p = new N3DataProvider();
    const { domains, ranges } = p.getDomainRange('http://ex.org/unknownProp');
    expect(domains).toEqual([]);
    expect(ranges).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /home/hanke/visgraph && npx vitest run src/providers/__tests__/N3DataProvider.test.ts 2>&1 | tail -20
```

Expected: FAIL — `getDomainRange is not a function`

- [ ] **Step 3: Add `getDomainRange` to N3DataProvider**

In `src/providers/N3DataProvider.ts`, add after the `clear()` line:

```typescript
getDomainRange(propertyIri: string): { domains: string[]; ranges: string[] } {
  const RDFS_DOMAIN = 'http://www.w3.org/2000/01/rdf-schema#domain';
  const RDFS_RANGE  = 'http://www.w3.org/2000/01/rdf-schema#range';
  const dataset = (this.inner as any).dataset;
  const propNode    = this.inner.factory.namedNode(propertyIri);
  const domainPred  = this.inner.factory.namedNode(RDFS_DOMAIN);
  const rangePred   = this.inner.factory.namedNode(RDFS_RANGE);
  const domains = [...dataset.iterateMatches(propNode, domainPred, null)].map((q: any) => q.object.value);
  const ranges  = [...dataset.iterateMatches(propNode, rangePred,  null)].map((q: any) => q.object.value);
  return { domains, ranges };
}
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
cd /home/hanke/visgraph && npx vitest run src/providers/__tests__/N3DataProvider.test.ts 2>&1 | tail -10
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/hanke/visgraph && git add src/providers/N3DataProvider.ts src/providers/__tests__/N3DataProvider.test.ts
git commit -m "feat(N3DataProvider): add getDomainRange for synchronous schema queries"
```

---

### Task 2: Create `ontologyQueries.ts`

**Files:**
- Create: `src/utils/ontologyQueries.ts`
- Create: `src/utils/__tests__/ontologyQueries.test.ts`

- [ ] **Step 1: Create the test file**

Create `src/utils/__tests__/ontologyQueries.test.ts`:

```typescript
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { fetchClasses, fetchLinkTypes, scoreLinkTypes } from '../ontologyQueries';
import type { N3DataProvider } from '../../providers/N3DataProvider';

function mockDataProvider(overrides: Partial<N3DataProvider> = {}): N3DataProvider {
  return {
    knownElementTypes: vi.fn().mockResolvedValue({
      elementTypes: [
        { id: 'http://ex.org/Person', label: { en: 'Person' } },
        { id: 'http://ex.org/Animal', label: {} },
      ],
      subtypes: new Map(),
    }),
    knownLinkTypes: vi.fn().mockResolvedValue([
      { id: 'http://ex.org/knows',   label: { en: 'knows' } },
      { id: 'http://ex.org/hasPet',  label: { en: 'hasPet' } },
    ]),
    getDomainRange: vi.fn().mockReturnValue({ domains: [], ranges: [] }),
    factory: { namedNode: (s: string) => ({ value: s }) },
    ...overrides,
  } as unknown as N3DataProvider;
}

describe('fetchClasses', () => {
  it('maps ElementTypeModel to FatMapEntity with iri and label', async () => {
    const dp = mockDataProvider();
    const result = await fetchClasses(dp);
    expect(result).toHaveLength(2);
    expect(result[0].iri).toBe('http://ex.org/Person');
    expect(result[0].label).toBe('Person');
  });

  it('returns empty array when no element types', async () => {
    const dp = mockDataProvider({
      knownElementTypes: vi.fn().mockResolvedValue({ elementTypes: [], subtypes: new Map() }),
    } as any);
    const result = await fetchClasses(dp);
    expect(result).toEqual([]);
  });
});

describe('fetchLinkTypes', () => {
  it('maps LinkTypeModel to FatMapEntity with iri and label', async () => {
    const dp = mockDataProvider();
    const result = await fetchLinkTypes(dp);
    expect(result).toHaveLength(2);
    expect(result[0].iri).toBe('http://ex.org/knows');
    expect(result[0].label).toBe('knows');
  });
});

describe('scoreLinkTypes', () => {
  it('returns entities unchanged when no source or target class', () => {
    const dp = mockDataProvider();
    const entities = [{ iri: 'http://ex.org/knows' }];
    const result = scoreLinkTypes(entities, undefined, undefined, dp);
    expect(result[0].domainRangeScore).toBeUndefined();
  });

  it('scores exact match as 0', () => {
    const dp = mockDataProvider({
      getDomainRange: vi.fn().mockReturnValue({
        domains: ['http://ex.org/Person'],
        ranges:  ['http://ex.org/Animal'],
      }),
    } as any);
    const entities = [{ iri: 'http://ex.org/hasPet' }];
    const result = scoreLinkTypes(entities, 'http://ex.org/Person', 'http://ex.org/Animal', dp);
    expect(result[0].domainRangeScore).toBe(0);
  });

  it('scores unconstrained property as 2', () => {
    const dp = mockDataProvider({
      getDomainRange: vi.fn().mockReturnValue({ domains: [], ranges: [] }),
    } as any);
    const entities = [{ iri: 'http://ex.org/knows' }];
    const result = scoreLinkTypes(entities, 'http://ex.org/Person', 'http://ex.org/Person', dp);
    expect(result[0].domainRangeScore).toBe(2);
  });

  it('scores domain-only match as 1', () => {
    const dp = mockDataProvider({
      getDomainRange: vi.fn().mockReturnValue({
        domains: ['http://ex.org/Person'],
        ranges:  ['http://ex.org/Org'], // mismatch on range
      }),
    } as any);
    const entities = [{ iri: 'http://ex.org/knows' }];
    const result = scoreLinkTypes(entities, 'http://ex.org/Person', 'http://ex.org/Animal', dp);
    expect(result[0].domainRangeScore).toBe(1);
  });

  it('scores full mismatch as 3', () => {
    const dp = mockDataProvider({
      getDomainRange: vi.fn().mockReturnValue({
        domains: ['http://ex.org/Robot'],
        ranges:  ['http://ex.org/Robot'],
      }),
    } as any);
    const entities = [{ iri: 'http://ex.org/knows' }];
    const result = scoreLinkTypes(entities, 'http://ex.org/Person', 'http://ex.org/Animal', dp);
    expect(result[0].domainRangeScore).toBe(3);
  });

  it('sorts by score ascending', () => {
    const scores: Record<string, { domains: string[]; ranges: string[] }> = {
      'http://ex.org/a': { domains: ['http://ex.org/X'], ranges: ['http://ex.org/Y'] }, // mismatch → 3
      'http://ex.org/b': { domains: [], ranges: [] }, // unconstrained → 2
      'http://ex.org/c': { domains: ['http://ex.org/Person'], ranges: ['http://ex.org/Person'] }, // exact → 0
    };
    const dp = mockDataProvider({
      getDomainRange: vi.fn().mockImplementation((iri: string) => scores[iri] ?? { domains: [], ranges: [] }),
    } as any);
    const entities = [
      { iri: 'http://ex.org/a' },
      { iri: 'http://ex.org/b' },
      { iri: 'http://ex.org/c' },
    ];
    const result = scoreLinkTypes(entities, 'http://ex.org/Person', 'http://ex.org/Person', dp);
    expect(result.map(e => e.domainRangeScore)).toEqual([0, 2, 3]);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/hanke/visgraph && npx vitest run src/utils/__tests__/ontologyQueries.test.ts 2>&1 | tail -10
```

Expected: FAIL — module not found

- [ ] **Step 3: Create `src/utils/ontologyQueries.ts`**

```typescript
import type { N3DataProvider } from '../providers/N3DataProvider';
import { toPrefixed } from './termUtils';

export interface FatMapEntity {
  iri: string;
  label?: string;
  prefixed?: string;
  domainRangeScore?: 0 | 1 | 2 | 3;
  [k: string]: any;
}

function getLabel(label: Record<string, string> | undefined): string | undefined {
  if (!label) return undefined;
  return label['en'] ?? label[''] ?? Object.values(label)[0] ?? undefined;
}

function tryPrefixed(iri: string): string | undefined {
  try { return toPrefixed(iri) || undefined; } catch { return undefined; }
}

export async function fetchClasses(dataProvider: N3DataProvider): Promise<FatMapEntity[]> {
  const graph = await dataProvider.knownElementTypes({});
  return graph.elementTypes.map(t => ({
    iri:      t.id as string,
    label:    getLabel(t.label as Record<string, string> | undefined),
    prefixed: tryPrefixed(t.id as string),
  }));
}

export async function fetchLinkTypes(dataProvider: N3DataProvider): Promise<FatMapEntity[]> {
  const types = await dataProvider.knownLinkTypes({});
  return types.map(t => ({
    iri:      t.id as string,
    label:    getLabel(t.label as Record<string, string> | undefined),
    prefixed: tryPrefixed(t.id as string),
  }));
}

function computeScore(
  domains: string[], ranges: string[],
  src: string | undefined, tgt: string | undefined,
): 0 | 1 | 2 | 3 {
  const hasDomain = domains.length > 0;
  const hasRange  = ranges.length > 0;
  if (!hasDomain && !hasRange) return 2;
  const domainOk = !hasDomain || (!!src && domains.includes(src));
  const rangeOk  = !hasRange  || (!!tgt && ranges.includes(tgt));
  if (domainOk && rangeOk) return 0;
  if (domainOk || rangeOk) return 1;
  return 3;
}

export function scoreLinkTypes(
  entities: FatMapEntity[],
  sourceClassIri: string | undefined,
  targetClassIri: string | undefined,
  dataProvider: N3DataProvider,
): FatMapEntity[] {
  if (!sourceClassIri && !targetClassIri) return entities;
  return [...entities]
    .map(e => {
      const { domains, ranges } = dataProvider.getDomainRange(e.iri);
      return { ...e, domainRangeScore: computeScore(domains, ranges, sourceClassIri, targetClassIri) };
    })
    .sort((a, b) => (a.domainRangeScore ?? 2) - (b.domainRangeScore ?? 2));
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /home/hanke/visgraph && npx vitest run src/utils/__tests__/ontologyQueries.test.ts 2>&1 | tail -10
```

Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
cd /home/hanke/visgraph && git add src/utils/ontologyQueries.ts src/utils/__tests__/ontologyQueries.test.ts
git commit -m "feat: add ontologyQueries with fetchClasses, fetchLinkTypes, scoreLinkTypes"
```

---

### Task 3: Sync Ontology Quads into DataProvider in ReactodiaCanvas

**Files:**
- Modify: `src/components/Canvas/ReactodiaCanvas.tsx`

- [ ] **Step 1: Replace the graph filter with selective logic**

In `src/components/Canvas/ReactodiaCanvas.tsx`, replace lines 241–277 (the graph-name guard through the closing brace of the `if (quads …)` block) with:

```typescript
      const incomingGraphName = meta && typeof meta.graphName === 'string' ? meta.graphName : null;
      const isDataGraph = !incomingGraphName
        || incomingGraphName === 'urn:vg:data'
        || incomingGraphName === 'urn:vg:inferred';

      if (quads && quads.length > 0) {
        const rdfQuads = workerQuadsToRdf(quads as unknown as ConverterQuad[]);
        if (!isDataGraph) {
          // Ontology/schema graph: load into DataProvider for schema awareness only.
          // Do NOT manipulate canvas elements for these subjects.
          dataProvider.addGraph(rdfQuads);
        } else if (changed.length > 0) {
          dataProvider.replaceSubjectQuads(changed, rdfQuads);
          if (added.length > 0) {
            const addedSet = new Set(added);
            dataProvider.addGraph(rdfQuads.filter(q => q.subject.termType === 'NamedNode' && addedSet.has((q.subject as any).value)));
          }
        } else {
          dataProvider.addGraph(rdfQuads);
        }
      }

      if (!isDataGraph) return;
```

Note: `changed` and `added` are computed from `subjects` and `existingIris` — those lines (251–260) stay unchanged and must appear before this block. The `subjects.forEach(s => knownSubjects.add(s))` line (261) also stays, but move it to after `if (!isDataGraph) return;` so only data-graph subjects enter `knownSubjects`.

- [ ] **Step 2: Update `metadataProvider` construction**

In `src/components/Canvas/ReactodiaCanvas.tsx`, replace lines 46–54:

```typescript
const metadataProvider = new RdfMetadataProvider(rdfManager, (): OntologyAccessor => {
  const s = (useOntologyStore as any).getState();
  return {
    getCompatibleProperties: (src, tgt) =>
      typeof s.getCompatibleProperties === 'function' ? s.getCompatibleProperties(src, tgt) : [],
    getAllProperties: () =>
      Array.isArray(s.availableProperties) ? s.availableProperties : [],
  };
});
```

with:

```typescript
const metadataProvider = new RdfMetadataProvider(rdfManager, dataProvider);
```

- [ ] **Step 3: Remove the `OntologyAccessor` import from ReactodiaCanvas**

Find and remove the import of `OntologyAccessor` from `RdfMetadataProvider`. It will look like:
```typescript
import { RdfMetadataProvider, type OntologyAccessor } from '../../providers/RdfMetadataProvider';
```
Change it to:
```typescript
import { RdfMetadataProvider } from '../../providers/RdfMetadataProvider';
```

- [ ] **Step 4: Check TypeScript compiles**

```bash
cd /home/hanke/visgraph && npx tsc --noEmit 2>&1 | head -30
```

Expected: errors only about `RdfMetadataProvider` constructor signature mismatch (fixed in Task 4) and possibly `OntologyAccessor` still exported. If unrelated errors appear, fix them.

- [ ] **Step 5: Commit**

```bash
cd /home/hanke/visgraph && git add src/components/Canvas/ReactodiaCanvas.tsx
git commit -m "feat(ReactodiaCanvas): sync ontology quads into DataProvider for schema awareness"
```

---

### Task 4: Rewire `RdfMetadataProvider` to use DataProvider

**Files:**
- Modify: `src/providers/RdfMetadataProvider.ts`
- Modify: `src/providers/__tests__/RdfMetadataProvider.test.ts`

- [ ] **Step 1: Update the test first**

Replace the contents of `src/providers/__tests__/RdfMetadataProvider.test.ts`:

```typescript
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { RdfMetadataProvider } from '../RdfMetadataProvider';
import type { N3DataProvider } from '../N3DataProvider';

const mockRdfManager = {
  applyBatch: vi.fn().mockResolvedValue(undefined),
  getNamespaces: vi.fn().mockReturnValue({}),
};

function mockDataProvider(): N3DataProvider {
  return {
    knownLinkTypes: vi.fn().mockResolvedValue([
      { id: 'http://ex.org/knows', label: { en: 'knows' } },
    ]),
    getDomainRange: vi.fn().mockReturnValue({ domains: [], ranges: [] }),
  } as unknown as N3DataProvider;
}

describe('RdfMetadataProvider', () => {
  it('instantiates without dataProvider', () => {
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

  it('canConnect resolves to an array when no dataProvider', async () => {
    const p = new RdfMetadataProvider(mockRdfManager as any);
    const result = await p.canConnect({} as any, undefined, undefined, {});
    expect(Array.isArray(result)).toBe(true);
  });

  it('canConnect returns all link types as outLinks when dataProvider provided', async () => {
    const dp = mockDataProvider();
    const p = new RdfMetadataProvider(mockRdfManager as any, dp);
    const src = { id: 'http://ex.org/alice', types: ['http://ex.org/Person'], properties: {} } as any;
    const tgt = { id: 'http://ex.org/bob',   types: ['http://ex.org/Person'], properties: {} } as any;
    const result = await p.canConnect(src, tgt, undefined, {});
    expect(result[0].outLinks).toContain('http://ex.org/knows');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/hanke/visgraph && npx vitest run src/providers/__tests__/RdfMetadataProvider.test.ts 2>&1 | tail -15
```

Expected: FAIL on constructor and `canConnect` tests.

- [ ] **Step 3: Rewrite `RdfMetadataProvider.ts`**

Replace the entire file content:

```typescript
import {
  type MetadataProvider,
  type MetadataCreateOptions,
  type MetadataCanConnect,
  type MetadataCanModifyEntity,
  type MetadataCanModifyRelation,
  type MetadataCreatedEntity,
  type MetadataCreatedRelation,
  type MetadataEntityShape,
  type MetadataRelationShape,
  type ElementTypeIri,
  type ElementIri,
  type LinkTypeIri,
  type ElementModel,
  type LinkModel,
} from '@reactodia/workspace';
import type { N3DataProvider } from './N3DataProvider';
import { fetchLinkTypes, scoreLinkTypes } from '../utils/ontologyQueries';

interface RdfManagerLike {
  applyBatch(changes: { adds?: any[]; removes?: any[] }, graph?: string): Promise<void>;
  getNamespaces(): Record<string, string>;
}

export class RdfMetadataProvider implements MetadataProvider {
  /** Set to true externally to suppress the canvas sync loop during direct RDF writes */
  suppressSync = false;

  constructor(
    private readonly rdfManager: RdfManagerLike,
    private readonly dataProvider?: N3DataProvider,
  ) {}

  getLiteralLanguages(): ReadonlyArray<string> {
    return ['en', 'de', 'fr'];
  }

  async createEntity(
    type: ElementTypeIri,
    options: MetadataCreateOptions,
  ): Promise<MetadataCreatedEntity> {
    const iri = `urn:vg:entity:${Date.now()}` as ElementIri;
    const data: ElementModel = { id: iri, types: [type], properties: {} };
    return { data };
  }

  async createRelation(
    source: ElementModel,
    target: ElementModel,
    linkType: LinkTypeIri,
    options: MetadataCreateOptions,
  ): Promise<MetadataCreatedRelation> {
    const data: LinkModel = {
      linkTypeId: linkType,
      sourceId: source.id,
      targetId: target.id,
      properties: {},
    };
    return { data };
  }

  async canConnect(
    source: ElementModel,
    target: ElementModel | undefined,
    linkType: LinkTypeIri | undefined,
    options: { readonly signal?: AbortSignal },
  ): Promise<MetadataCanConnect[]> {
    if (!this.dataProvider) {
      return [{ targetTypes: new Set<ElementTypeIri>(), inLinks: [], outLinks: [] }];
    }

    const allEntities = await fetchLinkTypes(this.dataProvider);
    if (allEntities.length === 0) {
      return [{ targetTypes: new Set<ElementTypeIri>(), inLinks: [], outLinks: [] }];
    }

    const allOutLinks = allEntities.map(e => e.iri as LinkTypeIri);

    if (!target) {
      return [{ targetTypes: new Set<ElementTypeIri>(), inLinks: [], outLinks: allOutLinks }];
    }

    const srcType = source.types[0];
    const tgtType = target.types[0];

    const scored = scoreLinkTypes(allEntities, srcType, tgtType, this.dataProvider);
    const outLinks = scored.map(e => e.iri as LinkTypeIri);

    return [{
      targetTypes: new Set(target.types as ElementTypeIri[]),
      inLinks: [],
      outLinks,
    }];
  }

  async canModifyEntity(
    entity: ElementModel,
    options: { readonly signal?: AbortSignal },
  ): Promise<MetadataCanModifyEntity> {
    return { canEdit: true, canDelete: true };
  }

  async canModifyRelation(
    link: LinkModel,
    source: ElementModel,
    target: ElementModel,
    options: { readonly signal?: AbortSignal },
  ): Promise<MetadataCanModifyRelation> {
    return { canChangeType: true, canEdit: true, canDelete: true };
  }

  async getEntityShape(
    types: ReadonlyArray<ElementTypeIri>,
    options: { readonly signal?: AbortSignal },
  ): Promise<MetadataEntityShape> {
    return {
      extraProperty: { valueShape: { termType: 'Literal' } },
      properties: new Map(),
    };
  }

  async getRelationShape(
    linkType: LinkTypeIri,
    source: ElementModel,
    target: ElementModel,
    options: { readonly signal?: AbortSignal },
  ): Promise<MetadataRelationShape> {
    return { properties: new Map() };
  }

  async filterConstructibleTypes(
    types: ReadonlySet<ElementTypeIri>,
    options: { readonly signal?: AbortSignal },
  ): Promise<ReadonlySet<ElementTypeIri>> {
    return types;
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /home/hanke/visgraph && npx vitest run src/providers/__tests__/RdfMetadataProvider.test.ts 2>&1 | tail -10
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/hanke/visgraph && git add src/providers/RdfMetadataProvider.ts src/providers/__tests__/RdfMetadataProvider.test.ts
git commit -m "feat(RdfMetadataProvider): replace OntologyAccessor with N3DataProvider + scoreLinkTypes"
```

---

### Task 5: Rewire EntityAutoComplete

**Files:**
- Modify: `src/components/ui/EntityAutoComplete.tsx`
- Modify: `src/__tests__/components/EntityAutoComplete.prefixedLookup.test.tsx`

- [ ] **Step 1: Add a test for dataProvider-based loading**

Append to `src/__tests__/components/EntityAutoComplete.prefixedLookup.test.tsx`:

```typescript
import { vi } from 'vitest';
import type { N3DataProvider } from '../../providers/N3DataProvider';

function mockDataProvider(linkTypes: Array<{ id: string; label?: Record<string, string> }> = []): N3DataProvider {
  return {
    knownLinkTypes: vi.fn().mockResolvedValue(linkTypes),
    knownElementTypes: vi.fn().mockResolvedValue({ elementTypes: [], subtypes: new Map() }),
    getDomainRange: vi.fn().mockReturnValue({ domains: [], ranges: [] }),
  } as unknown as N3DataProvider;
}

describe('EntityAutoComplete - dataProvider mode', () => {
  it('loads link types from dataProvider when mode=properties', async () => {
    const dp = mockDataProvider([{ id: 'http://ex.org/knows', label: { en: 'knows' } }]);
    const { container } = render(
      <EntityAutoComplete mode="properties" dataProvider={dp} onChange={() => {}} />
    );
    const input = container.querySelector('input')!;
    fireEvent.focus(input);
    await waitFor(() => {
      expect(screen.getByText('knows')).toBeTruthy();
    });
  });

  it('shows tier separator when sourceClassIri and targetClassIri provided', async () => {
    const dp = mockDataProvider([{ id: 'http://ex.org/knows', label: { en: 'knows' } }]);
    render(
      <EntityAutoComplete
        mode="properties"
        dataProvider={dp}
        sourceClassIri="http://ex.org/Person"
        targetClassIri="http://ex.org/Person"
        autoOpen
        onChange={() => {}}
      />
    );
    await waitFor(() => {
      // Score 2 (unconstrained) → should show "General" tier label
      expect(screen.getByText('General')).toBeTruthy();
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm the new ones fail**

```bash
cd /home/hanke/visgraph && npx vitest run src/__tests__/components/EntityAutoComplete.prefixedLookup.test.tsx 2>&1 | tail -15
```

Expected: existing tests pass, new 2 fail.

- [ ] **Step 3: Rewrite EntityAutoComplete**

Replace the entire `src/components/ui/EntityAutoComplete.tsx`:

```typescript
import React, { useMemo, useState, useEffect, useRef } from 'react';
import { toPrefixed } from '../../utils/termUtils';
import { cn } from '../../lib/utils';
import { fetchClasses, fetchLinkTypes, scoreLinkTypes, type FatMapEntity } from '../../utils/ontologyQueries';
import type { N3DataProvider } from '../../providers/N3DataProvider';

// Re-export so existing importers of FatMapEntity from this file keep working
export type { FatMapEntity };

interface Props {
  mode?: 'classes' | 'properties';
  entities?: FatMapEntity[];
  dataProvider?: N3DataProvider;
  sourceClassIri?: string;
  targetClassIri?: string;
  optionsLimit?: number;
  value?: string;
  onChange?: (entity: FatMapEntity | null) => void;
  placeholder?: string;
  emptyMessage?: string;
  className?: string;
  autoOpen?: boolean;
  disabled?: boolean;
}

const TIER_LABELS: Record<number, string> = { 0: 'Best match', 1: 'Compatible', 2: 'General', 3: 'Other' };

function escapeRegExp(s: string) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default function EntityAutoComplete({
  mode,
  entities,
  dataProvider,
  sourceClassIri,
  targetClassIri,
  optionsLimit = 8,
  value,
  onChange,
  placeholder = 'Select option...',
  emptyMessage = 'No options found.',
  className,
  autoOpen = false,
  disabled = false,
}: Props) {
  const [loadedItems, setLoadedItems] = useState<FatMapEntity[]>([]);

  // Async load from DataProvider when mode is set
  useEffect(() => {
    if (!dataProvider || !mode) return;
    let cancelled = false;
    const load = async () => {
      const result = mode === 'classes'
        ? await fetchClasses(dataProvider)
        : await fetchLinkTypes(dataProvider);
      if (!cancelled) setLoadedItems(result);
    };
    load();
    return () => { cancelled = true; };
  }, [dataProvider, mode]);

  // Decide source: explicit entities prop overrides everything
  const baseSource = useMemo<FatMapEntity[]>(() => {
    if (Array.isArray(entities) && entities.length > 0) return entities as FatMapEntity[];
    if (dataProvider && mode) return loadedItems;
    return Array.isArray(entities) ? (entities as FatMapEntity[]) : [];
  }, [entities, dataProvider, mode, loadedItems]);

  // Apply domain/range scoring when context is available
  const source = useMemo<FatMapEntity[]>(() => {
    if (mode === 'properties' && dataProvider && (sourceClassIri || targetClassIri)) {
      return scoreLinkTypes(baseSource, sourceClassIri, targetClassIri, dataProvider);
    }
    return baseSource;
  }, [baseSource, mode, dataProvider, sourceClassIri, targetClassIri]);

  const [open, setOpen] = useState<boolean>(Boolean(autoOpen));
  const [query, setQuery] = useState<string>('');
  const [highlight, setHighlight] = useState<number>(-1);
  const [initialDisplay, setInitialDisplay] = useState<string>('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const isFocusedRef = useRef<boolean>(false);

  const selectedEntity = useMemo(() => {
    if (!value) return null;
    return source.find(e => String(e.iri || '') === String(value)) || null;
  }, [value, source]);

  useEffect(() => { setOpen(Boolean(autoOpen)); }, [autoOpen]);

  useEffect(() => {
    if (isFocusedRef.current) return;
    if (!value) { setInitialDisplay(''); return; }
    const found = source.find(e => String(e.iri || '') === String(value));
    setInitialDisplay(found ? (found.prefixed || String(found.iri)) : value);
  }, [value, source]);

  const filtered = useMemo<FatMapEntity[]>(() => {
    if (!query || String(query).trim() === '') {
      return optionsLimit > 0 ? source.slice(0, optionsLimit) : source;
    }
    const rx = new RegExp(escapeRegExp(String(query).trim()), 'i');
    const matched = source.filter(e => {
      if (rx.test(String(e?.label || ''))) return true;
      if (rx.test(String(e?.prefixed || ''))) return true;
      if (rx.test(String(e?.iri || ''))) return true;
      if (!e?.prefixed && e?.iri) {
        try { const c = String(toPrefixed(e.iri) || ''); if (c && rx.test(c)) return true; } catch {}
      }
      return false;
    });
    return optionsLimit > 0 ? matched.slice(0, optionsLimit) : matched;
  }, [source, query, optionsLimit]);

  const hasTiers = filtered.some(e => typeof e.domainRangeScore === 'number');

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      setHighlight(h => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(h => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && highlight >= 0 && highlight < filtered.length) {
        const ent = filtered[highlight];
        onChange?.(ent || null);
        setOpen(false);
        setQuery('');
        try { setInitialDisplay(ent?.prefixed ? String(ent.prefixed) : ''); } catch { setInitialDisplay(''); }
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      setHighlight(-1);
      setQuery('');
      onChange?.(null);
      setInitialDisplay('');
    }
  };

  const handleSelect = (ent: FatMapEntity) => {
    onChange?.(ent || null);
    setOpen(false);
    setQuery('');
    try { setInitialDisplay(ent?.prefixed ? String(ent.prefixed) : ''); } catch { setInitialDisplay(''); }
    inputRef.current?.focus();
  };

  const inputValue = query !== '' ? query : initialDisplay;

  // Build list items with tier separators
  const listItems: React.ReactNode[] = [];
  let lastScore: number | undefined = undefined;
  let flatIdx = 0;
  for (const ent of filtered) {
    const score = typeof ent.domainRangeScore === 'number' ? ent.domainRangeScore : undefined;
    if (hasTiers && score !== undefined && score !== lastScore) {
      listItems.push(
        <li key={`sep-${score}`} className="px-3 py-1 text-xs font-semibold text-muted-foreground border-t first:border-t-0 bg-muted/40 select-none">
          {TIER_LABELS[score]}
        </li>
      );
      lastScore = score;
    }
    const idx = flatIdx++;
    const isHighlighted = idx === highlight;
    listItems.push(
      <li
        key={String(ent.iri || idx)}
        role="option"
        aria-selected={isHighlighted}
        onMouseEnter={() => setHighlight(idx)}
        onMouseDown={ev => { ev.preventDefault(); handleSelect(ent); }}
        className={cn(
          'cursor-pointer px-3 py-2',
          isHighlighted ? 'bg-accent text-accent-foreground' : 'bg-transparent text-foreground',
        )}
      >
        <div className="text-sm font-medium">{ent.prefixed || String(ent.iri)}</div>
        <div className="text-xs text-muted-foreground">{ent.label || ''}</div>
      </li>
    );
  }

  return (
    <div className={cn(className || 'relative w-full')} style={{ minWidth: 0 }}>
      <div role="combobox" aria-expanded={open} aria-haspopup="listbox" className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          className={cn(
            'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
          )}
          placeholder={placeholder}
          value={inputValue}
          onChange={ev => {
            const v = ev.target.value;
            setQuery(v);
            if (String(v).trim() !== '') { setOpen(true); } else { setInitialDisplay(''); }
            setHighlight(0);
          }}
          onFocus={() => {
            if (!isFocusedRef.current) {
              isFocusedRef.current = true;
              setTimeout(() => inputRef.current?.select(), 0);
            }
            setOpen(true);
          }}
          onBlur={() => { isFocusedRef.current = false; }}
          onKeyDown={onKeyDown}
          disabled={disabled}
          aria-controls="entity-autocomplete-list"
          aria-autocomplete="list"
        />
      </div>

      {open && (
        <ul
          id="entity-autocomplete-list"
          role="listbox"
          ref={listRef}
          className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded border bg-popover shadow"
        >
          {filtered.length === 0
            ? <li className="px-3 py-2 text-sm text-muted-foreground">{emptyMessage}</li>
            : listItems
          }
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run all EntityAutoComplete tests**

```bash
cd /home/hanke/visgraph && npx vitest run src/__tests__/components/EntityAutoComplete.prefixedLookup.test.tsx 2>&1 | tail -15
```

Expected: all pass

- [ ] **Step 5: Commit**

```bash
cd /home/hanke/visgraph && git add src/components/ui/EntityAutoComplete.tsx src/__tests__/components/EntityAutoComplete.prefixedLookup.test.tsx
git commit -m "feat(EntityAutoComplete): load from DataProvider with scored domain/range tier display"
```

---

### Task 6: Rewire LinkPropertyEditor

**Files:**
- Modify: `src/components/Canvas/LinkPropertyEditor.tsx`

- [ ] **Step 1: Replace fat-map usage in LinkPropertyEditor**

In `src/components/Canvas/LinkPropertyEditor.tsx`:

a) Remove these imports:
```typescript
import { useOntologyStore } from '../../stores/ontologyStore';
```

b) Add this import (dataProvider singleton is already module-level in ReactodiaCanvas; expose it or import directly):
```typescript
import { dataProvider } from './ReactodiaCanvas';
```

> **Note:** If `dataProvider` is not currently exported from ReactodiaCanvas, add `export` to its declaration: change `const dataProvider = new N3DataProvider();` to `export const dataProvider = new N3DataProvider();` in ReactodiaCanvas.tsx.

c) Remove lines 57–76 (the `availableProperties`, `getCompatibleProperties`, and `computedAllObjectProperties` logic). Replace the `<EntityAutoComplete>` usage in the JSX (which currently passes `entities={computedAllObjectProperties}`) with:

```typescript
<EntityAutoComplete
  mode="properties"
  dataProvider={dataProvider}
  sourceClassIri={sourceClassIri}
  targetClassIri={targetClassIri}
  value={displayValue}
  onChange={(ent) => setSelectedProperty(ent?.iri ?? '')}
  placeholder="Select property..."
  optionsLimit={12}
/>
```

d) Keep `sourceClassIri` and `targetClassIri` derivation (lines 60–62) — those lines are unchanged:
```typescript
const sourceClassIri: string = String(sourceNode?.classType ?? sourceNode?.rdfTypes?.[0] ?? '');
const targetClassIri: string = String(targetNode?.classType ?? targetNode?.rdfTypes?.[0] ?? '');
```

- [ ] **Step 2: Check TypeScript**

```bash
cd /home/hanke/visgraph && npx tsc --noEmit 2>&1 | grep -i 'linkpropertyeditor\|ontologystore\|fatmap' | head -20
```

Expected: no errors for these files.

- [ ] **Step 3: Commit**

```bash
cd /home/hanke/visgraph && git add src/components/Canvas/LinkPropertyEditor.tsx src/components/Canvas/ReactodiaCanvas.tsx
git commit -m "feat(LinkPropertyEditor): pass dataProvider and class context to EntityAutoComplete"
```

---

### Task 7: Remove Fat Map from `ontologyStore`

**Files:**
- Modify: `src/stores/ontologyStore.ts`

- [ ] **Step 1: Delete fat map state and functions**

In `src/stores/ontologyStore.ts`, delete:

- The `INITIAL_SCHEMA_PROPERTIES` constant (lines 43–57)
- `availableProperties: OntologyProperty[]` state field and its initial value
- `availableClasses: OntologyClass[]` state field and its initial value
- `getCompatibleProperties(...)` action
- `updateFatMap(...)` action
- `updateFatMapFromWorker(...)` action
- The `buildFatMap(...)` standalone function

Also remove any `seeding` of `INITIAL_SCHEMA_PROPERTIES` into the initial state.

> **How to find them:** The signatures are at lines 43–57 (INITIAL_SCHEMA_PROPERTIES), 477 (availableClasses), 478 (availableProperties), 533–536 (getCompatibleProperties), 1569 (updateFatMap), 1742 (updateFatMapFromWorker), 2097 (buildFatMap). Search for each and delete the full declaration including any trailing comma.

- [ ] **Step 2: Check TypeScript for ontologyStore-related errors**

```bash
cd /home/hanke/visgraph && npx tsc --noEmit 2>&1 | grep -v 'node_modules' | head -40
```

Fix any remaining references to the deleted items (imports, usages in other files not yet updated). The most likely remaining references are in `storeHelpers.ts` (cleaned in Task 9) and any components still importing from ontologyStore for fat map data.

- [ ] **Step 3: Commit**

```bash
cd /home/hanke/visgraph && git add src/stores/ontologyStore.ts
git commit -m "refactor(ontologyStore): remove fat map state, buildFatMap, updateFatMap, getCompatibleProperties"
```

---

### Task 8: Remove Fat Map Branches from `rdfManager.impl.ts`

**Files:**
- Modify: `src/utils/rdfManager.impl.ts`

- [ ] **Step 1: Simplify `runReconcile`**

In `src/utils/rdfManager.impl.ts`, replace the entire `runReconcile` method body with a no-op (the method can be removed entirely if nothing else calls it, otherwise keep the shell):

```typescript
private async runReconcile(
  _quads?: WorkerQuad[],
  _snapshot?: WorkerReconcileSubjectSnapshotPayload[],
): Promise<void> {
  // Fat map removed — DataProvider is updated directly via ReactodiaCanvas subjects handler.
}
```

If `runReconcile` is never called from outside the class (check with grep), delete the method entirely.

Also remove:
- Import of `WorkerReconcileSubjectSnapshotPayload` if only used in `runReconcile`
- Import of `workerQuadToFatEntry` if only used in `runReconcile`
- The `reconcileInProgress` property if only used in `runReconcile`

```bash
cd /home/hanke/visgraph && grep -n 'runReconcile\|workerQuadToFatEntry\|reconcileInProgress\|WorkerReconcileSubjectSnapshotPayload' src/utils/rdfManager.impl.ts
```

Delete or stub out each item that is only used in the fat map path.

- [ ] **Step 2: Verify TypeScript**

```bash
cd /home/hanke/visgraph && npx tsc --noEmit 2>&1 | grep -v 'node_modules' | head -20
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
cd /home/hanke/visgraph && git add src/utils/rdfManager.impl.ts
git commit -m "refactor(rdfManager): remove runReconcile fat map branches"
```

---

### Task 9: Remove Fat Map Helpers from `storeHelpers.ts`

**Files:**
- Modify: `src/utils/storeHelpers.ts`

- [ ] **Step 1: Delete the three fat map functions**

In `src/utils/storeHelpers.ts`, delete:
- `getAvailableProperties()` (lines 57–64)
- `getAvailableClasses()` (lines 70–77)
- `fatMapToEntities()` (lines 108–116)

```bash
cd /home/hanke/visgraph && grep -rn 'getAvailableProperties\|getAvailableClasses\|fatMapToEntities' src/ --include='*.ts' --include='*.tsx' | grep -v 'storeHelpers.ts'
```

If any files still import these, update them to use `fetchClasses`/`fetchLinkTypes` from `ontologyQueries.ts` instead.

- [ ] **Step 2: Verify TypeScript**

```bash
cd /home/hanke/visgraph && npx tsc --noEmit 2>&1 | grep -v 'node_modules' | head -20
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd /home/hanke/visgraph && git add src/utils/storeHelpers.ts
git commit -m "refactor(storeHelpers): remove getAvailableProperties, getAvailableClasses, fatMapToEntities"
```

---

### Task 10: Delete Fat Map Tests and Run Full Suite

**Files:**
- Delete: `src/__tests__/stores/updateFatMap.*.test.ts` (all files matching this pattern)
- Run full test suite

- [ ] **Step 1: Find and delete fat map test files**

```bash
cd /home/hanke/visgraph && ls src/__tests__/stores/updateFatMap*.test.ts
```

Delete each file found:
```bash
cd /home/hanke/visgraph && rm src/__tests__/stores/updateFatMap*.test.ts
```

- [ ] **Step 2: Run the full test suite**

```bash
cd /home/hanke/visgraph && npx vitest run 2>&1 | tail -30
```

Expected: all remaining tests pass. Fix any failures caused by removed exports or changed signatures before proceeding.

- [ ] **Step 3: Final TypeScript check**

```bash
cd /home/hanke/visgraph && npx tsc --noEmit 2>&1 | grep -v 'node_modules'
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /home/hanke/visgraph && git add -u && git add src/
git commit -m "chore: delete updateFatMap tests, all tests passing"
```
