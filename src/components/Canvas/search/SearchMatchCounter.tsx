import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as Reactodia from '@reactodia/workspace';

import {
  SearchIndexProvider,
  useSearchIndexContext,
} from './SearchIndexContext';
import { useCanvasState } from '../../../hooks/useCanvasState';
import { useSearchIndex } from './useSearchIndex';
import { VgClassesSection } from './VgClassesSection';
import { VgEntitiesSection } from './VgEntitiesSection';

// ─── Section definitions ────────────────────────────────────────────────────

const SECTIONS: ReadonlyArray<Reactodia.UnifiedSearchSection> = [
  {
    key: 'elementTypes',
    label: 'Classes',
    title: 'Search element types',
    component: <VgClassesSection />,
  },
  {
    key: 'entities',
    label: 'Entities',
    title: 'Search entities',
    component: <VgEntitiesSection />,
  },
];

// ─── Public component ────────────────────────────────────────────────────────

export function SearchMatchCounter() {
  const indexState = useSearchIndex();
  return (
    <SearchIndexProvider value={indexState}>
      <SearchMatchCounterInner />
    </SearchIndexProvider>
  );
}

// ─── IRI → canvas element lookup ─────────────────────────────────────────────

/** Build a map from entity IRI to canvas element using the live diagram model. */
function buildIriMap(
  elements: ReadonlyArray<Reactodia.Element>
): Map<string, Reactodia.EntityElement | Reactodia.EntityGroup> {
  const map = new Map<string, Reactodia.EntityElement | Reactodia.EntityGroup>();
  for (const el of elements) {
    if (el instanceof Reactodia.EntityElement) {
      map.set(el.iri, el);
    } else if (el instanceof Reactodia.EntityGroup) {
      for (const item of el.items) {
        map.set(item.data.id as string, el);
      }
    }
  }
  return map;
}

/** Paginate an EntityGroup so the member with the given IRI is on the visible page. */
function paginateGroupTo(group: Reactodia.EntityGroup, iri: string): void {
  const memberIdx = group.items.findIndex(item => item.data.id === iri);
  if (memberIdx < 0) return;
  const pageSize =
    (group.elementState.get(Reactodia.TemplateProperties.GroupPageSize) as number | undefined) ?? 10;
  const targetPage = Math.floor(memberIdx / pageSize);
  group.setElementState(
    group.elementState.set(Reactodia.TemplateProperties.GroupPageIndex, targetPage)
  );
}

// ─── Inner component (has access to context) ─────────────────────────────────

function SearchMatchCounterInner() {
  const { model, view } = Reactodia.useWorkspace();
  const { state: canvasState, actions: canvasActions } = useCanvasState();

  const { filteredEntities, activeFilter, setCurrentIndex, iriViewMap } = useSearchIndexContext();

  const [current, setCurrent] = React.useState(-1);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const [toggleEl, setToggleEl] = React.useState<HTMLElement | null>(null);

  // IRI to zoom to once the diagram model has loaded it (after a view switch).
  const pendingIriRef = React.useRef<string | null>(null);

  // Live IRI → canvas element map for the currently active view.
  // Rebuilt whenever layoutVersion bumps (canvas layout/clustering cycle complete) or
  // model.elements changes (element add/remove between layout cycles).
  // layoutVersion is bumped by ReactodiaCanvas after initialLayoutDone is set, which is
  // after groups are fully populated — so we don't need the changeItems subscription.
  const [iriMap, setIriMap] = React.useState(() => buildIriMap(model.elements));
  React.useEffect(() => {
    setIriMap(buildIriMap(model.elements));
  }, [model.elements, canvasState.layoutVersion]);


  // Re-query the toggle element after every render so the portal mounts as soon as
  // UnifiedSearch adds the element to the DOM.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    const el = wrapperRef.current?.querySelector<HTMLElement>(
      '.reactodia-unified-search__toggle'
    ) ?? null;
    setToggleEl(prev => (prev === el ? prev : el));
  });

  // Auto-select first match whenever the result list changes.
  React.useEffect(() => {
    const first = filteredEntities.length > 0 ? 0 : -1;
    setCurrent(first);
    setCurrentIndex(first);
  }, [filteredEntities, setCurrentIndex]);

  // When iriMap updates (canvas reloaded after view switch), resolve any pending navigation.
  // Zoom is deferred with a double-rAF so the canvas has completed layout and
  // element sizes are available before zoomToFitRect runs.
  React.useEffect(() => {
    const iri = pendingIriRef.current;
    if (!iri) return;
    const el = iriMap.get(iri);
    if (el) {
      pendingIriRef.current = null;
      if (el instanceof Reactodia.EntityGroup) paginateGroupTo(el, iri);
      const canvas = view.findAnyCanvas();
      const raf1 = requestAnimationFrame(() => {
        const raf2 = requestAnimationFrame(() => {
          zoomToElement(canvas, el);
        });
        return () => cancelAnimationFrame(raf2);
      });
      return () => cancelAnimationFrame(raf1);
    } else {
      // View switched but element still not in iriMap. If iriViewMap points to a
      // different view than the current one, switch now (view may have changed
      // underneath us). Otherwise give up — changeItems subscription will rebuild
      // iriMap if the element appears later.
      const targetView = iriViewMap.get(iri);
      if (targetView && targetView !== canvasState.viewMode) {
        console.debug('[SearchMatchCounter] iriMap missing element, switching to', targetView, 'for:', iri);
        canvasActions.setViewMode(targetView);
      } else {
        console.debug('[SearchMatchCounter] giving up on pending IRI (not on canvas):', iri);
        pendingIriRef.current = null;
      }
    }
  }, [iriMap, iriViewMap, canvasState.viewMode, canvasActions, view]);

  const predicateLinks = React.useMemo(() =>
    activeFilter?.kind === 'predicate'
      ? model.links.filter(
          (l): l is Reactodia.RelationLink =>
            l instanceof Reactodia.RelationLink && l.typeId === activeFilter.iri
        )
      : null,
    [model.links, activeFilter]
  );

  const total = predicateLinks !== null
    ? predicateLinks.length
    : filteredEntities.length;

  const navigateTo = React.useCallback((index: number) => {
    if (predicateLinks !== null) {
      const link = predicateLinks[index];
      if (!link) return;
      const canvas = view.findAnyCanvas();
      if (!canvas) return;
      const source = iriMap.get(link.data.sourceId);
      const target = iriMap.get(link.data.targetId);
      if (!source || !target) {
        console.warn('[SearchMatchCounter] link traversal: source or target not on canvas', link);
        return;
      }
      const x = Math.min(source.position.x, target.position.x) - 80;
      const y = Math.min(source.position.y, target.position.y) - 80;
      const x2 = Math.max(source.position.x, target.position.x) + 240;
      const y2 = Math.max(source.position.y, target.position.y) + 240;
      void canvas.zoomToFitRect({ x, y, width: x2 - x, height: y2 - y }, { animate: true, duration: 350 });
      return;
    }

    const entity = filteredEntities[index];
    if (!entity) return;
    const iri = entity.id as string;

    const canvasEl = iriMap.get(iri);

    if (canvasEl) {
      // Element is in the current view — paginate group if needed, then zoom.
      if (canvasEl instanceof Reactodia.EntityGroup) paginateGroupTo(canvasEl, iri);
      zoomToElement(view.findAnyCanvas(), canvasEl);
    } else {
      const targetView = iriViewMap.get(iri);
      if (!targetView) {
        console.debug('[SearchMatchCounter] IRI not in view map (unknown entity):', iri);
        return;
      }
      if (targetView === canvasState.viewMode) {
        // Correct view is already active but the element isn't in iriMap yet.
        // The changeItems subscription on EntityGroups will rebuild iriMap once
        // clustering finishes — no view switch needed.
        console.debug('[SearchMatchCounter] waiting for iriMap to populate for:', iri);
        return;
      }
      pendingIriRef.current = iri;
      console.debug('[SearchMatchCounter] switching to', targetView, 'for:', iri);
      canvasActions.setViewMode(targetView);
    }
  }, [iriMap, iriViewMap, view, canvasState.viewMode, canvasActions, filteredEntities, predicateLinks]);

  const navigate = React.useCallback((next: number) => {
    setCurrent(next);
    setCurrentIndex(next);
    navigateTo(next);
  }, [navigateTo, setCurrentIndex]);

  const onPrev = React.useCallback(() =>
    navigate(current <= 0 ? total - 1 : current - 1),
  [navigate, current, total]);

  const onNext = React.useCallback(() =>
    navigate(current < 0 || current >= total - 1 ? 0 : current + 1),
  [navigate, current, total]);

  const onKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const target = e.target as HTMLElement;
    if (!target.classList.contains('reactodia-unified-search__search-input')) return;
    e.preventDefault();
    onNext();
  }, [onNext]);

  return (
    <div ref={wrapperRef} className="vg-search-counter-wrapper" onKeyDown={onKeyDown}>
      <Reactodia.UnifiedSearch sections={SECTIONS} />
      {toggleEl && total > 0 &&
        ReactDOM.createPortal(
          <Counter total={total} current={current} onPrev={onPrev} onNext={onNext} />,
          toggleEl
        )
      }
    </div>
  );
}

// ─── Counter badge ───────────────────────────────────────────────────────────

interface CounterProps {
  total: number;
  current: number;
  onPrev: () => void;
  onNext: () => void;
}

// ─── Zoom helper ─────────────────────────────────────────────────────────────

function zoomToElement(
  canvas: Reactodia.CanvasApi | undefined,
  el: Reactodia.EntityElement | Reactodia.EntityGroup
): void {
  if (!canvas) return;
  const size = canvas.renderingState.getElementSize(el) ?? { width: 160, height: 80 };
  const padding = 80;
  void canvas.zoomToFitRect(
    {
      x: el.position.x - padding,
      y: el.position.y - padding,
      width: size.width + padding * 2,
      height: size.height + padding * 2,
    },
    { animate: true, duration: 350 }
  );
}

function Counter({ total, current, onPrev, onNext }: CounterProps) {
  const label = current < 0 ? `${total}` : `${current + 1}/${total}`;
  return (
    <div className="vg-search-counter">
      <button className="vg-search-counter__btn" onMouseDown={e => { e.preventDefault(); onPrev(); }}>↑</button>
      <span className="vg-search-counter__label">{label}</span>
      <button className="vg-search-counter__btn" onMouseDown={e => { e.preventDefault(); onNext(); }}>↓</button>
    </div>
  );
}
