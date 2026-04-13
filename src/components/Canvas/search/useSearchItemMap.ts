/**
 * useSearchItemMap
 *
 * Builds a live ordered list of SearchItem for every *matched* result item
 * currently visible in the active search dropdown section.
 *
 * "Matched" means the item contains a highlighted-term span — parent nodes
 * shown only for tree context are excluded.
 *
 * canvasEl is optional — set when the IRI matches a canvas element in the
 * current view.  viewMode encodes which canvas the item belongs to:
 *   'tbox' → Classes / Link-types section
 *   'abox' → Entities section
 *
 * DOM side:
 *   Classes:  a.reactodia-class-tree-item__body[href]
 *             that contain .reactodia-class-tree-item__highlighted-term
 *   Entities: li.reactodia-list-element-view[title] (all are matches)
 */
import { useEffect, useRef, useState } from 'react';
import * as Reactodia from '@reactodia/workspace';

export interface SearchItem {
  /** The DOM element inside the search dropdown */
  domEl: HTMLElement;
  /** The matching canvas Element in the current view, if present */
  canvasEl: Reactodia.Element | null;
  /** The entity/type IRI */
  iri: string;
  /** Which canvas view this item lives in */
  viewMode: 'abox' | 'tbox';
}

/** Extract IRI from an entity <li> title attribute.
 *  Title format: "Label <iri>\nTypes: ..." */
function extractIriFromTitle(title: string): string | null {
  const firstLine = title.split('\n')[0];
  const m = firstLine.match(/<([^>]+)>/);
  return m ? m[1] : null;
}

/**
 * Build two lookup maps:
 *  iriMap:     IRI → Element  (exact match, covers EntityElement.iri and EntityGroup members)
 *  typeMap:    typeIRI → first EntityElement of that type  (A-Box fallback for class search)
 */
function buildMaps(model: Reactodia.DataDiagramModel): {
  iriMap: Map<string, Reactodia.Element>;
  typeMap: Map<string, Reactodia.EntityElement>;
} {
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

/** Scan the active section and return only matched items. */
function buildItems(
  panel: HTMLElement,
  iriMap: Map<string, Reactodia.Element>,
  typeMap: Map<string, Reactodia.EntityElement>
): SearchItem[] {
  const active = panel.querySelector('.reactodia-unified-search__section--active');
  if (!active) return [];

  const items: SearchItem[] = [];

  // Classes — only anchors that contain a highlighted-term span → T-Box
  active.querySelectorAll<HTMLAnchorElement>(
    'a.reactodia-class-tree-item__body[href]'
  ).forEach(anchor => {
    if (!anchor.querySelector('.reactodia-class-tree-item__highlighted-term')) return;
    const iri = anchor.getAttribute('href');
    if (!iri) return;
    items.push({ domEl: anchor, canvasEl: resolveCanvasEl(iri, iriMap, typeMap), iri, viewMode: 'tbox' });
  });

  // Entities — all shown items are matches → A-Box
  active.querySelectorAll<HTMLElement>(
    'li.reactodia-list-element-view[title]'
  ).forEach(li => {
    const iri = extractIriFromTitle(li.title);
    if (!iri) return;
    items.push({ domEl: li, canvasEl: resolveCanvasEl(iri, iriMap, typeMap), iri, viewMode: 'abox' });
  });

  return items;
}

/** True when every mutation only involves our injected vg-search-nav-btn nodes */
function isOwnMutation(mutations: MutationRecord[]): boolean {
  return mutations.every(m => {
    const allAdded = Array.from(m.addedNodes).every(
      n => (n as Element).classList?.contains('vg-search-nav-btn')
    );
    const allRemoved = Array.from(m.removedNodes).every(
      n => (n as Element).classList?.contains('vg-search-nav-btn')
    );
    return allAdded && allRemoved || (m.addedNodes.length === 0 && m.removedNodes.length === 0);
  });
}

export function useSearchItemMap(
  panelRef: React.RefObject<HTMLElement | null>
): SearchItem[] {
  const { model } = Reactodia.useWorkspace();
  const mapsRef = useRef<{
    iriMap: Map<string, Reactodia.Element>;
    typeMap: Map<string, Reactodia.EntityElement>;
  }>({ iriMap: new Map(), typeMap: new Map() });
  const [items, setItems] = useState<SearchItem[]>([]);

  // Rebuild maps when canvas elements change
  useEffect(() => {
    mapsRef.current = buildMaps(model);

    const rebuild = () => {
      mapsRef.current = buildMaps(model);
      const panel = panelRef.current;
      if (panel) {
        const { iriMap, typeMap } = mapsRef.current;
        setItems(buildItems(panel, iriMap, typeMap));
      }
    };

    model.events.on('changeCells', rebuild);
    return () => model.events.off('changeCells', rebuild);
  }, [model, panelRef]);

  // MutationObserver: rescan DOM when search results render/update,
  // but ignore mutations caused by our own nav button injection.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const scan = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const { iriMap, typeMap } = mapsRef.current;
        setItems(buildItems(panel, iriMap, typeMap));
      }, 80);
    };

    const observer = new MutationObserver((mutations) => {
      if (isOwnMutation(mutations)) return;
      scan();
    });
    observer.observe(panel, { childList: true, subtree: true });

    // Tab switches toggle a CSS class on sections — childList won't fire,
    // so rescan when a section tab button is clicked.
    const onTabClick = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest('.reactodia-unified-search__section-tab')) {
        scan();
      }
    };
    panel.addEventListener('click', onTabClick);

    scan(); // initial scan

    return () => {
      observer.disconnect();
      panel.removeEventListener('click', onTabClick);
      if (timer) clearTimeout(timer);
    };
  }, [panelRef]);

  return items;
}
