import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import * as Reactodia from '@reactodia/workspace';
import type { ElementModel, ElementTypeGraph, ElementTypeIri } from '@reactodia/workspace';
import { dataProvider } from '../ReactodiaCanvas';
import { rdfManager } from '@/utils/rdfManager';
import { classifyEntityView } from '@/providers/N3DataProvider';
import type { SearchFilter, SearchIndexContext } from './SearchIndexContext';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

function entityLabel(entity: ElementModel): string {
  const labels = entity.properties[RDFS_LABEL];
  if (labels && labels.length > 0) {
    const lit = labels[0];
    if (lit.termType === 'Literal' && lit.value) return lit.value;
  }
  return (entity.id.split(/[/#]/).pop() ?? entity.id);
}

export interface LinkEntry {
  readonly typeId: string;
  readonly sourceId: string;
  readonly targetId: string;
}

export function filterEntities(
  entities: ReadonlyArray<ElementModel>,
  text: string,
  activeFilter: SearchFilter,
  canvasLinks: ReadonlyArray<LinkEntry>
): ElementModel[] {
  const textLower = text.toLowerCase();

  let result = entities as ElementModel[];

  if (textLower) {
    result = result.filter(e => entityLabel(e).toLowerCase().includes(textLower));
  }

  if (activeFilter) {
    if (activeFilter.kind === 'type') {
      result = result.filter(e => e.types.includes(activeFilter.iri as ElementTypeIri));
    } else if (activeFilter.kind === 'predicate') {
      const predIri = activeFilter.iri as string;
      const connected = new Set<string>();
      for (const link of canvasLinks) {
        if (link.typeId === predIri) {
          connected.add(link.sourceId);
          connected.add(link.targetId);
        }
      }
      result = result.filter(e => connected.has(e.id as string));
    }
  }

  return result;
}

export function computeClassHitCounts(
  entities: ReadonlyArray<ElementModel>
): ReadonlyMap<ElementTypeIri, number> {
  const counts = new Map<ElementTypeIri, number>();
  for (const entity of entities) {
    for (const typeIri of entity.types) {
      counts.set(typeIri, (counts.get(typeIri) ?? 0) + 1);
    }
  }
  return counts;
}

const EMPTY_GRAPH: ElementTypeGraph = { elementTypes: [], subtypeOf: [] };

export function useSearchIndex(): SearchIndexContext {
  const { model } = Reactodia.useWorkspace();

  const [classGraph, setClassGraph] = useState<ElementTypeGraph>(EMPTY_GRAPH);
  const [allEntities, setAllEntities] = useState<ReadonlyArray<ElementModel>>([]);
  const [loading, setLoading] = useState(true);
  const [searchText, setSearchText] = useState('');
  const [activeFilter, setActiveFilter] = useState<SearchFilter>(null);
  const [currentIndex, setCurrentIndex] = useState(-1);

  const abortRef = useRef<AbortController | null>(null);

  const fetchIndex = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    try {
      const [graph, lookupItems] = await Promise.all([
        dataProvider.knownElementTypes({ signal: ac.signal }),
        dataProvider.lookupAll({ signal: ac.signal }),
      ]);
      if (ac.signal.aborted) return;
      setClassGraph(graph);
      setAllEntities(lookupItems.map(item => item.element));
    } catch (err) {
      if (!(err instanceof Error) || err.name !== 'AbortError') {
        console.warn('[useSearchIndex] fetch failed', err);
      }
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial fetch — may return empty if the RDF store isn't populated yet.
    // The rdfManager subscription below will re-fetch once data arrives.
    void fetchIndex();

    // Re-fetch whenever the RDF store changes (debounced to avoid thrashing
    // during the initial emitAllSubjects burst which fires many updates).
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void fetchIndex(), 300);
    };
    rdfManager.onSubjectsChange(handler);
    return () => {
      rdfManager.offSubjectsChange(handler);
      if (debounceTimer) clearTimeout(debounceTimer);
      abortRef.current?.abort();
    };
  }, [fetchIndex]);

  const canvasLinks = useMemo((): LinkEntry[] =>
    model.links
      .filter((l): l is Reactodia.RelationLink => l instanceof Reactodia.RelationLink)
      .map(l => ({ typeId: l.typeId, sourceId: l.data.sourceId, targetId: l.data.targetId })),
    [model.links]
  );

  const textFilteredEntities = useMemo(
    () => filterEntities(allEntities, searchText, null, canvasLinks),
    [allEntities, searchText, canvasLinks]
  );

  const filteredEntities = useMemo(
    () => activeFilter ? filterEntities(textFilteredEntities, '', activeFilter, canvasLinks) : textFilteredEntities,
    [textFilteredEntities, activeFilter, canvasLinks]
  );

  const classHitCounts = useMemo(
    () => computeClassHitCounts(textFilteredEntities),
    [textFilteredEntities]
  );

  // Classify every known IRI as abox or tbox from its RDF types — no view rendering needed.
  const iriViewMap = useMemo((): ReadonlyMap<string, 'abox' | 'tbox'> => {
    const map = new Map<string, 'abox' | 'tbox'>();
    for (const entity of allEntities) {
      const classification = classifyEntityView(entity.types);
      // 'both' → prefer abox (entity is in both views, abox is a safe default)
      const view: 'abox' | 'tbox' = classification === 'tbox' ? 'tbox' : 'abox';
      map.set(entity.id as string, view);
    }
    return map;
  }, [allEntities]);

  const clearFilter = useCallback(() => setActiveFilter(null), []);

  return {
    classGraph,
    allEntities,
    filteredEntities,
    classHitCounts,
    iriViewMap,
    loading,
    searchText,
    setSearchText,
    activeFilter,
    setActiveFilter,
    clearFilter,
    currentIndex,
    setCurrentIndex,
    // Overridden by SearchMatchCounterInner once navigate is available.
    onSelectEntity: (_index: number) => {},
  };
}
