 // Test environment polyfills for jsdom -> provide minimal DOMMatrix/DOMMatrixReadOnly
 // used by @xyflow/react internals when running under jsdom in Vitest.
 //
 // This file is loaded by the test runner setup (see vitest config or package.json).
 // It implements a forgiving DOMMatrixReadOnly that accepts CSS transform strings
 // like "matrix(a, b, c, d, tx, ty)" and exposes m11/m12/m21/m22/m41/m42 (m41/m42 as tx/ty).
 // If parsing fails, it falls back to the identity matrix.
 //
 // Ensure a `window` global exists in the test environment (some runtimes may not provide it).
 // Point it at globalThis so libraries that reference `window` work under Vitest/jsdom.
 if (typeof (globalThis as any).window === "undefined") {
   (globalThis as any).window = globalThis;
 }
//
// Keep this file minimal and robust; it's only needed so xyflow/react can compute
// element transforms during tests that render ReactFlow components.
class SimpleDOMMatrixReadOnly {
  m11: number;
  m12: number;
  m21: number;
  m22: number;
  m41: number;
  m42: number;

  constructor(init?: string) {
    // identity defaults
    this.m11 = 1;
    this.m12 = 0;
    this.m21 = 0;
    this.m22 = 1;
    this.m41 = 0;
    this.m42 = 0;

    {
      const s = String(init || "").trim();
      if (!s || s === "none") return;

      // matrix(a, b, c, d, tx, ty)
      const m = s.match(/matrix\(([^)]+)\)/i);
      if (m && m[1]) {
        const parts = m[1].split(",").map((p) => parseFloat(p.trim())).filter((n) => !Number.isNaN(n));
        if (parts.length === 6) {
          this.m11 = parts[0];
          this.m12 = parts[1];
          this.m21 = parts[2];
          this.m22 = parts[3];
          this.m41 = parts[4];
          this.m42 = parts[5];
          return;
        }
      }

      // matrix3d(...) -> take relevant entries (m11,m12,m21,m22, m41,m42)
      const m3 = s.match(/matrix3d\(([^)]+)\)/i);
      if (m3 && m3[1]) {
        const parts = m3[1].split(",").map((p) => parseFloat(p.trim())).filter((n) => !Number.isNaN(n));
        if (parts.length === 16) {
          // matrix3d is column-major in CSS; indices:
          // m11 = parts[0], m12 = parts[1], m21 = parts[4], m22 = parts[5], m41 = parts[12], m42 = parts[13]
          this.m11 = parts[0];
          this.m12 = parts[1];
          this.m21 = parts[4];
          this.m22 = parts[5];
          this.m41 = parts[12];
          this.m42 = parts[13];
          return;
        }
      }
    }
  }

  // allow destructuring like: const { m22: zoom } = new DOMMatrixReadOnly(...)
  // expose toString for debugging if needed
  toString() {
    return `matrix(${this.m11},${this.m12},${this.m21},${this.m22},${this.m41},${this.m42})`;
  }
}

// Attach to globals used by libraries
{
  // Node + jsdom environment: globalThis.window may exist
  (globalThis as any).DOMMatrixReadOnly = (globalThis as any).DOMMatrixReadOnly || SimpleDOMMatrixReadOnly;
  (globalThis as any).DOMMatrix = (globalThis as any).DOMMatrix || SimpleDOMMatrixReadOnly;
  if (typeof (globalThis as any).window !== "undefined") {
    (globalThis as any).window.DOMMatrixReadOnly = (globalThis as any).window.DOMMatrixReadOnly || SimpleDOMMatrixReadOnly;
    (globalThis as any).window.DOMMatrix = (globalThis as any).window.DOMMatrix || SimpleDOMMatrixReadOnly;
  }
}

// Polyfill ResizeObserver for jsdom environment (minimal)
{
  if (typeof (globalThis as any).ResizeObserver === "undefined") {
    class MockResizeObserver {
      private cb: any;
      constructor(cb: any) {
        this.cb = cb;
      }
      observe(_target?: any) {
        // no-op
      }
      unobserve(_target?: any) {
        // no-op
      }
      disconnect() {
        // no-op
      }
    }
    (globalThis as any).ResizeObserver = MockResizeObserver;
    if (typeof (globalThis as any).window !== "undefined") {
      (globalThis as any).window.ResizeObserver = MockResizeObserver;
    }
  }
}

// Some libraries access window.devicePixelRatio or call window.getComputedStyle expecting sensible defaults.
// Ensure a safe default exists for tests.
{
  if (typeof (globalThis as any).window !== "undefined") {
    if (typeof (globalThis as any).window.devicePixelRatio === "undefined") {
      (globalThis as any).window.devicePixelRatio = 1;
    }
    // Guarantee getComputedStyle exists (jsdom provides it), but ensure style.transform returns "none" by default.
    const origGetComputedStyle = (globalThis as any).window.getComputedStyle;
    (globalThis as any).window.getComputedStyle = function (el: any) {
      const style = origGetComputedStyle ? origGetComputedStyle.call((globalThis as any).window, el) : {};
      // Provide a safe transform property if absent
      if (!style || typeof style.transform === "undefined") {
        return { ...style, transform: "none" };
      }
      return style;
    };
  }
}

 // Polyfill Element.scrollIntoView for jsdom (some UI libs call it)
{
  if (typeof (globalThis as any).Element !== "undefined" && typeof (globalThis as any).Element.prototype.scrollIntoView === "undefined") {
    (globalThis as any).Element.prototype.scrollIntoView = function () { /* no-op for tests */ };
  }
}

/*
  Ensure tests run with tooltips disabled by default so tooltip DOM (and Radix
  context) doesn't interfere with unrelated tests. Individual tests can opt-in
  to enable tooltips by calling useAppConfigStore.getState().setTooltipEnabled(true)
  before importing UI components.
*/
void (async () => {
  {
    const mod = await import('./stores/appConfigStore');
    // The store exports a named `useAppConfigStore`. Access it via `any` to avoid
    // TypeScript errors in the test setup environment.
    const useAppConfigStore = (mod as any).useAppConfigStore;
    if (useAppConfigStore && typeof useAppConfigStore.getState === 'function') {
      try {
        useAppConfigStore.getState().setTooltipEnabled(false);
      } catch (_) {
        // ignore if setter not present yet
      }
    }
  }
})();
 
// Additional lightweight polyfills to help React/ReactDOM and reactflow internals in jsdom tests.
// Provide window.getSelection, document.activeElement helpers and a minimal global React Flow instance
// so tests that query window.__VG_RF_INSTANCE or inspect selection/activeElement do not crash.
{
  if (typeof (globalThis as any).window !== "undefined") {
    const w: any = globalThis.window;

    // getSelection used by react-dom internals
    if (typeof w.getSelection === "undefined") {
      w.getSelection = () => {
        return {
          removeAllRanges: () => {},
          addRange: () => {},
          getRangeAt: () => undefined,
          toString: () => "",
        } as any;
      };
    }

    // requestAnimationFrame / cancelAnimationFrame -> map to setTimeout so RAF-based queues run in tests
    if (typeof w.requestAnimationFrame === "undefined") {
      w.requestAnimationFrame = (cb: FrameRequestCallback) => {
        return setTimeout(() => {
          try { cb(Date.now()); } catch (_) { /* swallow */ }
        }, 0) as unknown as number;
      };
    }
    if (typeof w.cancelAnimationFrame === "undefined") {
      w.cancelAnimationFrame = (id: number) => clearTimeout(id as any);
    }

    // document.activeElement / getActiveElementDeep used by react-dom - provide sane defaults
    if (typeof (globalThis as any).document !== "undefined") {
      try {
        if (typeof (globalThis as any).document.activeElement === "undefined") {
          (globalThis as any).document.activeElement = null;
        }
      } catch (_) { /* ignore */ }
    }

    // Provide a minimal global React Flow instance used by some tests to introspect nodes/edges.
    // Tests will replace this as needed. Shape mirrors the small API used in tests: getNodes/getEdges.
    if (typeof w.__VG_RF_INSTANCE === "undefined") {
      w.__VG_RF_INSTANCE = {
        _nodes: [] as any[],
        _edges: [] as any[],
        getNodes() {
          return Array.isArray(this._nodes) ? this._nodes : [];
        },
        getEdges() {
          return Array.isArray(this._edges) ? this._edges : [];
        },
        setNodes(nodes: any[]) {
          this._nodes = Array.isArray(nodes) ? nodes : [];
        },
        setEdges(edges: any[]) {
          this._edges = Array.isArray(edges) ? edges : [];
        },
      };
    }
  }
}
