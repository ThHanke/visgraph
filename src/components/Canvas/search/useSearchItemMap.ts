/**
 * useSearchItemMap
 *
 * Builds a combined SearchItem list by querying the same data sources that
 * the three UnifiedSearch tabs use — without DOM scanning or MutationObserver.
 *
 * Sources (matching each tab):
 *   Classes    → dataProvider.knownElementTypes() filtered by label
 *   Entities   → dataProvider.lookup({ text })  (already view-mode filtered)
 *   Link types → dataProvider.knownLinkTypes() filtered by label (all dataset properties)
 *
 * The list is rebuilt whenever searchString changes (debounced 120 ms so the
 * provider isn't hammered on every keystroke).
 *
 * domEl is best-effort: after the data list is stable we look for the
 * corresponding DOM node in the rendered panel.  It is null when the tab
 * for that section has never been opened (lazy render) — navigation still
 * works; only the in-panel highlight is skipped.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Reactodia from '@reactodia/workspace';
import { dataProvider } from '../ReactodiaCanvas';

export type SearchItemKind = 'elementType' | 'entity' | 'linkType';

export interface SearchItem {
  /** DOM element inside the search panel (null if section not yet rendered) */
  domEl: HTMLElement | null;
  /** Matching canvas Element in the current view, if present */
  canvasEl: Reactodia.Element | null;
  iri: string;
  viewMode: 'abox' | 'tbox';
  kind: SearchItemKind;
}

// ─── canvas element resolution ────────────────────────────────────────────────

function buildMaps(model: Reactodia.DataDiagramModel) {
  const iriMap = new Map<string, Reactodia.Element>();
  const typeMap = new Map<string, Reactodia.EntityElement>();
  for (const el of model.elements) {
    if (el instanceof Reactodia.EntityElement) {
      iriMap.set(el.iri, el);
      for (const t of el.data.types) {
        if (!typeMap.has(t)) typeMap.set(t, el);
      }
    }
    if (el instanceof Reactodia.EntityGroup) {
      for (const item of el.items) {
        iriMap.set(item.data.id, el);
        for (const t of item.data.types) {
          if (!typeMap.has(t)) typeMap.set(t, el as unknown as Reactodia.EntityElement);
        }
      }
    }
  }
  return { iriMap, typeMap };
}

function resolveCanvasEl(
  iri: string,
  iriMap: Map<string, Reactodia.Element>,
  typeMap: Map<string, Reactodia.EntityElement>
): Reactodia.Element | null {
  return iriMap.get(iri) ?? typeMap.get(iri) ?? null;
}

// ─── DOM lookup (best-effort, per section) ────────────────────────────────────

/** Extract IRI from an entity <li> title attribute: "Label <iri>\nTypes: ..." */
function extractIriFromTitle(title: string): string | null {
  const m = title.split('\n')[0].match(/<([^>]+)>/);
  return m ? m[1] : null;
}

export function findDomEl(panel: HTMLElement, kind: SearchItemKind, iri: string): HTMLElement | null {
  switch (kind) {
    case 'elementType':
      return panel.querySelector<HTMLElement>(
        `.reactodia-search-section-element-types a.reactodia-class-tree-item__body[href="${CSS.escape(iri)}"]`
      );
    case 'entity': {
      // Title format varies — scan all entity items and match by extracted IRI
      const lis = panel.querySelectorAll<HTMLElement>(
        '.reactodia-search-section-entities li.reactodia-list-element-view[title]'
      );
      for (const li of lis) {
        if (extractIriFromTitle(li.title) === iri) return li;
      }
      return null;
    }
    case 'linkType':
      return panel.querySelector<HTMLElement>(
        `.reactodia-search-section-link-types li[data-linktypeid="${CSS.escape(iri)}"]`
      );
  }
}

// ─── hook ────────────────────────────────────────────────────────────────────

export function useSearchItemMap(
  panelRef: React.RefObject<HTMLElement | null>,
  searchString: string
): SearchItem[] {
  const { model, translation } = Reactodia.useWorkspace();
  const [items, setItems] = useState<SearchItem[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const buildItems = useCallback(async (text: string, signal: AbortSignal) => {
    const textLower = text.toLowerCase();
    const { iriMap, typeMap } = buildMaps(model);
    const results: SearchItem[] = [];

    // ── 1. Classes (T-Box) ──────────────────────────────────────────────────
    try {
      const graph = await dataProvider.knownElementTypes({ signal });
      if (signal.aborted) return;
      for (const et of graph.elementTypes) {
        const label = translation.formatLabel(et.label, et.id, model.language);
        if (!label.toLowerCase().includes(textLower)) continue;
        results.push({
          domEl: null,
          canvasEl: resolveCanvasEl(et.id, iriMap, typeMap),
          iri: et.id,
          viewMode: 'tbox',
          kind: 'elementType',
        });
      }
    } catch { /* aborted or provider error — skip */ }

    // ── 2. Entities (A-Box) ─────────────────────────────────────────────────
    try {
      const lookupItems = await dataProvider.lookup({ text, signal });
      if (signal.aborted) return;
      for (const item of lookupItems) {
        results.push({
          domEl: null,
          canvasEl: resolveCanvasEl(item.element.id, iriMap, typeMap),
          iri: item.element.id,
          viewMode: 'abox',
          kind: 'entity',
        });
      }
    } catch { /* aborted or provider error — skip */ }

    // ── 3. Link types (T-Box) ───────────────────────────────────────────────
    // Use knownLinkTypes() so ALL properties in the dataset are found, not just
    // those visible as links on the current canvas.
    try {
      const linkTypeModels = await dataProvider.knownLinkTypes({ signal });
      if (signal.aborted) return;
      for (const lt of linkTypeModels) {
        const label = translation.formatLabel(lt.label, lt.id, model.language);
        if (!label.toLowerCase().includes(textLower)) continue;
        results.push({
          domEl: null,
          canvasEl: null,
          iri: lt.id,
          viewMode: 'tbox',
          kind: 'linkType',
        });
      }
    } catch { /* aborted or provider error — skip */ }

    if (signal.aborted) return;

    // Best-effort: resolve domEl for each item from currently rendered panel
    const panel = panelRef.current;
    if (panel) {
      for (const item of results) {
        item.domEl = findDomEl(panel, item.kind, item.iri);
      }
    }

    setItems(results);
  }, [model, translation, panelRef]);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();

    if (!searchString) {
      setItems([]);
      return;
    }

    timerRef.current = setTimeout(() => {
      const ac = new AbortController();
      abortRef.current = ac;
      buildItems(searchString, ac.signal);
    }, 120);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, [searchString, buildItems]);

  return items;
}
