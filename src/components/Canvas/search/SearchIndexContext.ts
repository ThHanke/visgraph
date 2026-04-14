import { createContext, useContext } from 'react';
import type { ElementModel, ElementTypeGraph, ElementTypeIri, LinkTypeIri } from '@reactodia/workspace';

/** A filter that narrows the entity list. */
export type SearchFilter =
  | { readonly kind: 'type'; readonly iri: ElementTypeIri }
  | { readonly kind: 'predicate'; readonly iri: LinkTypeIri }
  | null;

/** The full shared search state provided to all search sections and the counter. */
export interface SearchIndexState {
  /** Full ontology hierarchy — used to build the class tree. */
  readonly classGraph: ElementTypeGraph;
  /** All entities from the N3 store across both ABox and TBox views. */
  readonly allEntities: ReadonlyArray<ElementModel>;
  /**
   * Entities matching the current text search, filtered by activeFilter if set.
   * This is the source for the counter and the entities tab list.
   */
  readonly filteredEntities: ReadonlyArray<ElementModel>;
  /**
   * Hit counts per class IRI — derived from text-filtered entities only,
   * NOT further filtered by activeFilter. Drives the count badge in the class tree.
   */
  readonly classHitCounts: ReadonlyMap<ElementTypeIri, number>;
  /**
   * Static view classification for every known IRI, derived from RDF types.
   * Maps entity IRI → 'abox' | 'tbox' without requiring either view to be rendered.
   */
  readonly iriViewMap: ReadonlyMap<string, 'abox' | 'tbox'>;
  /** Whether the initial data fetch is in progress. */
  readonly loading: boolean;
}

export interface SearchIndexActions {
  readonly searchText: string;
  readonly setSearchText: (text: string) => void;
  readonly activeFilter: SearchFilter;
  readonly setActiveFilter: (filter: SearchFilter) => void;
  readonly clearFilter: () => void;
  /** Index into filteredEntities of the currently navigated match (-1 = none). */
  readonly currentIndex: number;
  readonly setCurrentIndex: (index: number) => void;
}

export interface SearchIndexContext extends SearchIndexState, SearchIndexActions {}

const Ctx = createContext<SearchIndexContext | null>(null);

export const SearchIndexProvider = Ctx.Provider;

export function useSearchIndexContext(): SearchIndexContext {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error('useSearchIndexContext must be used inside a SearchIndexProvider (mounted by SearchMatchCounter)');
  }
  return ctx;
}
