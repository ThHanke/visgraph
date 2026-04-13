/**
 * SearchMatchCounter
 *
 * Wraps <Reactodia.UnifiedSearch> with the original built-in sections
 * (data retrieval unchanged).
 *
 * Counter badge is portaled into the __toggle input bar.
 * Uses useSearchItemMap to build a live SearchItem[] list.
 *
 * Collapse behaviour:
 *   Clicking outside hides the panel via CSS (.vg-search-panel-hidden) while
 *   keeping Reactodia's internal expanded state intact. This preserves the DOM
 *   so the item map and navigation (↑/↓) continue working while collapsed.
 *   Clicking the input or typing restores the panel.
 *
 * Navigation behaviour:
 *   - Same view, element on canvas → zoom to it
 *   - Different view → switch view, wait for model update, find by IRI, zoom
 *   - Same view, element not on canvas → createElement (add node), then zoom
 *
 * Current match position is reset only on a tab switch, not on collapse.
 */
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import ReactDOM from 'react-dom';
import * as Reactodia from '@reactodia/workspace';
import { useSearchItemMap } from './useSearchItemMap';
import { useCanvasState } from '@/hooks/useCanvasState';

// ─── counter badge ─────────────────────────────────────────────────────────────

interface CounterProps {
  total: number;
  current: number;
  onPrev: () => void;
  onNext: () => void;
}

function CounterDisplay({ total, current, onPrev, onNext }: CounterProps) {
  return (
    <span className="vg-search-counter">
      <span className="vg-search-counter__label">
        {total > 0
          ? (current > 0 ? `${current}/${total}` : String(total))
          : '0'}
      </span>
      <button
        className="vg-search-counter__btn"
        title="Previous match"
        onMouseDown={e => { e.preventDefault(); onPrev(); }}
      >↑</button>
      <button
        className="vg-search-counter__btn"
        title="Next match"
        onMouseDown={e => { e.preventDefault(); onNext(); }}
      >↓</button>
    </span>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function isDropdownOpen(wrapper: HTMLElement): boolean {
  return !!wrapper.querySelector('.reactodia-unified-search__section--active');
}

/**
 * Waits for canvas layout to fully settle via rAF polling.
 *
 * Two-phase:
 *   1. Wait for isAnimatingGraph() to become true  (layout started)
 *   2. Wait for isAnimatingGraph() to become false (layout finished)
 *
 * If the canvas is not yet mounted, we keep polling until it appears.
 * If layout never starts within maxWaitMs, we resolve anyway — the canvas
 * was either empty or the layout completed synchronously before our first tick.
 */
function awaitLayoutSettled(
  getCanvas: () => Reactodia.CanvasApi | undefined,
  maxWaitMs = 4000
): Promise<void> {
  return new Promise(resolve => {
    const deadline = performance.now() + maxWaitMs;
    let layoutStarted = false;

    const tick = () => {
      if (performance.now() >= deadline) { resolve(); return; }
      const c = getCanvas();
      if (!c) {
        // Canvas not yet mounted — keep waiting
        requestAnimationFrame(tick);
        return;
      }
      const animating = c.isAnimatingGraph();
      if (animating) {
        layoutStarted = true;
        requestAnimationFrame(tick);
      } else if (!layoutStarted) {
        // Layout hasn't started yet — keep waiting for it to begin
        requestAnimationFrame(tick);
      } else {
        // Layout was running and has now stopped
        resolve();
      }
    };
    requestAnimationFrame(tick);
  });
}

/** Paginate an EntityGroup so the member identified by iri is on the visible page. */
function paginateGroupTo(group: Reactodia.EntityGroup, iri: string): void {
  const memberIdx = group.items.findIndex(item => item.data.id === iri);
  if (memberIdx < 0) return;
  const pageSize =
    group.elementState.get(Reactodia.TemplateProperties.GroupPageSize) ?? 10;
  const targetPage = Math.floor(memberIdx / pageSize);
  group.setElementState(
    group.elementState.set(Reactodia.TemplateProperties.GroupPageIndex, targetPage)
  );
}

// ─── public component ─────────────────────────────────────────────────────────

const SECTIONS: ReadonlyArray<Reactodia.UnifiedSearchSection> = [
  { key: 'elementTypes', label: 'Classes',    title: 'Search element types', component: <Reactodia.SearchSectionElementTypes /> },
  { key: 'entities',     label: 'Entities',   title: 'Search entities',      component: <Reactodia.SearchSectionEntities /> },
  { key: 'linkTypes',    label: 'Link types', title: 'Search link types',    component: <Reactodia.SearchSectionLinkTypes /> },
];


export function SearchMatchCounter() {
  const { canvas, model, view } = Reactodia.useWorkspace();
  const { state: canvasState, actions: canvasActions } = useCanvasState();

  const wrapperRef = useRef<HTMLDivElement>(null);
  const [toggleEl, setToggleEl] = useState<Element | null>(null);
  const [searchString, setSearchString] = useState('');
  const [current, setCurrent] = useState(0);
  // Whether the dropdown panel is visually shown (CSS toggle, independent of Reactodia state)
  const [panelVisible, setPanelVisible] = useState(true);

  // Track DOM element that currently has the active highlight class
  const activeItemRef = useRef<HTMLElement | null>(null);
  // The search string at the time of the last Enter-triggered navigation
  const lastNavigatedStringRef = useRef<string>('');

  // Live list of matched results (non-empty when Reactodia's dropdown is open & has results)
  const items = useSearchItemMap(wrapperRef);

  // Cache the last non-empty items so navigation works while panel is hidden.
  // Updated in an effect to avoid mutating a ref during render.
  const itemsCacheRef = useRef<typeof items>([]);
  useEffect(() => {
    if (items.length > 0) {
      itemsCacheRef.current = items;
    }
  }, [items]);

  const effectiveItems = items.length > 0 ? items : itemsCacheRef.current;
  const total = effectiveItems.length;

  // Reset current + active highlight when search string is cleared
  useEffect(() => {
    if (searchString.length === 0) {
      setCurrent(0);
      lastNavigatedStringRef.current = '';
      if (activeItemRef.current) {
        activeItemRef.current.classList.remove('vg-search-match--active');
        activeItemRef.current = null;
      }
      itemsCacheRef.current = [];
      setPanelVisible(true);
    }
  }, [searchString]);

  // Apply / remove the panel-hidden CSS class
  useEffect(() => {
    wrapperRef.current?.classList.toggle('vg-search-panel-hidden', !panelVisible);
  }, [panelVisible]);

  // Outside click → hide panel. Inside click or typing → show panel.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      if (wrapper.contains(e.target as Node)) {
        setPanelVisible(true);
      } else if (searchString.length > 0) {
        setPanelVisible(false);
      }
    };
    document.body.addEventListener('pointerdown', onPointerDown);
    return () => document.body.removeEventListener('pointerdown', onPointerDown);
  }, [searchString]);

  // Reset current + active highlight on tab switch only (not on collapse/hide)
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const onTabClick = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest('.reactodia-unified-search__section-tab')) {
        setCurrent(0);
        if (activeItemRef.current) {
          activeItemRef.current.classList.remove('vg-search-match--active');
          activeItemRef.current = null;
        }
      }
    };
    wrapper.addEventListener('click', onTabClick);
    return () => wrapper.removeEventListener('click', onTabClick);
  }, []);

  // Find the __toggle div (input bar) for the counter portal
  useEffect(() => {
    const el = wrapperRef.current?.querySelector('.reactodia-unified-search__toggle') ?? null;
    setToggleEl(el);
  }, []);

  // Track search string from native input events; also show panel when typing
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const onInput = (e: Event) => {
      const input = e.target as HTMLInputElement;
      if (input.classList?.contains('reactodia-unified-search__search-input')) {
        setSearchString(input.value);
        setPanelVisible(true);
      }
    };
    wrapper.addEventListener('input', onInput);
    return () => wrapper.removeEventListener('input', onInput);
  }, []);

  // Reactodia's clear button (×) updates its controlled input via React state,
  // not a native input event — so we detect the click separately and reset.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const onClearClick = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest('.reactodia-unified-search__clear-button')) {
        setSearchString('');
        setCurrent(0);
        if (activeItemRef.current) {
          activeItemRef.current.classList.remove('vg-search-match--active');
          activeItemRef.current = null;
        }
        itemsCacheRef.current = [];
        setPanelVisible(true);
      }
    };
    wrapper.addEventListener('click', onClearClick);
    return () => wrapper.removeEventListener('click', onClearClick);
  }, []);

  // Center the canvas on a canvas element using Reactodia's native centerTo API.
  // We read the rendered size if available; otherwise fall back to a typical node
  // size so position is still correct even before first render.
  const zoomToElement = useCallback((el: Reactodia.Element, targetCanvas?: Reactodia.CanvasApi) => {
    const c = targetCanvas ?? canvas;
    if (!c) return;
    const pos = el.position;
    const size = c.renderingState.getElementSize(el);
    const cx = pos.x + (size ? size.width  / 2 : 100);
    const cy = pos.y + (size ? size.height / 2 : 50);
    c.centerTo(
      { x: cx, y: cy },
      { scale: 1, animate: true, duration: 350 }
    ).catch(() => {/* ignore */});
  }, [canvas]);

  // Navigate to a match.
  //
  // Priority order:
  //   1. Item's viewMode differs from current canvas view
  //      → switch view, wait for model to repopulate, find element by IRI, zoom
  //   2. Same view and canvasEl present → zoom directly
  //   3. Same view, no canvasEl → createElement (add to canvas), then zoom
  //
  // DOM highlight/scroll is skipped when the panel is hidden.
  const navigateTo = useCallback((idx: number) => {
    const source = items.length > 0 ? items : itemsCacheRef.current;
    if (!source.length) return;
    const i = ((idx % source.length) + source.length) % source.length;
    const { domEl, canvasEl, iri, viewMode } = source[i];

    if (panelVisible) {
      if (activeItemRef.current && activeItemRef.current !== domEl) {
        activeItemRef.current.classList.remove('vg-search-match--active');
      }
      domEl.classList.add('vg-search-match--active');
      activeItemRef.current = domEl;
      domEl.scrollIntoView({ block: 'nearest' });
    }

    setCurrent(i + 1);

    const currentMode = canvasState.viewMode as 'abox' | 'tbox';

    if (viewMode !== currentMode) {
      // Switch to the correct view first — this must happen before any canvas
      // check because the canvas may be undefined while re-rendering.
      canvasActions.setViewMode(viewMode);
      // Wait for the canvas to settle after the view switch.
      // changeCells may NOT fire if the target view already has its elements loaded,
      // so we also arm a fallback timer that fires unconditionally after SWITCH_MS.
      const SETTLE_MS = 150;
      const SWITCH_MS = 400;
      let done = false;
      let settleTimer: ReturnType<typeof setTimeout> | null = null;

      const zoomAfterSwitch = async () => {
        if (done) return;
        done = true;
        model.events.off('changeCells', onCellsChanged);
        if (settleTimer) clearTimeout(settleTimer);
        // Wait for any ongoing layout animation to finish before reading positions.
        await awaitLayoutSettled(() => view.findAnyCanvas());
        const freshCanvas = view.findAnyCanvas();
        const el = model.elements.find(e => {
          if (e instanceof Reactodia.EntityElement) return e.iri === iri;
          if (e instanceof Reactodia.EntityGroup) {
            return e.items.some(item => item.data.id === iri);
          }
          return false;
        });
        if (el) {
          if (el instanceof Reactodia.EntityGroup) paginateGroupTo(el, iri);
          zoomToElement(el, freshCanvas);
        } else if (freshCanvas) {
          const newEl = model.createElement(iri as Reactodia.ElementIri);
          setTimeout(() => zoomToElement(newEl, view.findAnyCanvas()), 300);
        }
      };

      const onCellsChanged = () => {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(zoomAfterSwitch, SETTLE_MS);
      };
      model.events.on('changeCells', onCellsChanged);
      // Unconditional fallback in case changeCells never fires
      setTimeout(zoomAfterSwitch, SWITCH_MS);
      return;
    }

    // Always resolve canvas fresh — the closed-over `canvas` may be stale
    // or transiently undefined after a Reactodia re-render.
    const currentCanvas = view.findAnyCanvas();
    if (!currentCanvas) return;

    if (canvasEl) {
      // If the target is inside a group, scroll the group's paginator to the
      // page that contains the member before centering on the group node.
      if (canvasEl instanceof Reactodia.EntityGroup) paginateGroupTo(canvasEl, iri);
      zoomToElement(canvasEl, currentCanvas);
    } else {
      // Element exists in data but is not placed on the current canvas yet — add it
      const newEl = model.createElement(iri as Reactodia.ElementIri);
      setTimeout(() => zoomToElement(newEl, view.findAnyCanvas()), 300);
    }
  }, [items, panelVisible, canvasState.viewMode, canvasActions, model, view, zoomToElement]);

  // Enter on the search input: if the query hasn't changed since the last
  // navigation, step one match forward instead of re-triggering the search.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const input = e.target as HTMLInputElement;
      if (!input.classList?.contains('reactodia-unified-search__search-input')) return;
      if (input.value.length === 0) return;
      if (input.value === lastNavigatedStringRef.current) {
        e.preventDefault();
        e.stopPropagation();
        navigateTo(current);
      } else {
        lastNavigatedStringRef.current = input.value;
      }
    };
    wrapper.addEventListener('keydown', onKeyDown, { capture: true });
    return () => wrapper.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [navigateTo, current]);

  // Inject per-item ⊙ nav buttons for all items in the dropdown.
  // For class tree items (domEl is an <a>), appending a <button> inside <a> is
  // invalid HTML and browsers silently move it out. Instead we inject into the
  // nearest <li> ancestor so the button is a sibling of the anchor.
  useEffect(() => {
    if (!items.length) return;
    const cleanups: (() => void)[] = [];

    items.forEach((item) => {
      const idx = items.indexOf(item);
      const btn = document.createElement('button');
      btn.className = 'vg-search-nav-btn';
      btn.title = 'Navigate to element on canvas';
      btn.textContent = '⊙';
      const handler = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        navigateTo(idx);
      };
      btn.addEventListener('mousedown', handler);

      // For class tree items domEl is <a> — nesting <button> inside <a> is
      // invalid HTML. Use the __row div instead (same level as the create button).
      // For entity items domEl is already <li>, which is fine.
      const container =
        item.domEl.closest('.reactodia-class-tree-item__row') ??
        item.domEl.closest('li') ??
        item.domEl;
      container.appendChild(btn);

      cleanups.push(() => {
        btn.removeEventListener('mousedown', handler);
        btn.remove();
      });
    });

    return () => cleanups.forEach(fn => fn());
  }, [items, navigateTo]);

  const handleNext = useCallback(() => navigateTo(current),     [navigateTo, current]);
  const handlePrev = useCallback(() => navigateTo(current - 2), [navigateTo, current]);

  const showCounter = searchString.length > 0;

  return (
    <div ref={wrapperRef} style={{ display: 'contents' }}>
      <Reactodia.UnifiedSearch sections={SECTIONS} />
      {toggleEl && showCounter && ReactDOM.createPortal(
        <CounterDisplay
          total={total}
          current={current}
          onPrev={handlePrev}
          onNext={handleNext}
        />,
        toggleEl
      )}
    </div>
  );
}
