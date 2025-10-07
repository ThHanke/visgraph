// Test environment polyfills for jsdom -> provide minimal DOMMatrix/DOMMatrixReadOnly
// used by @xyflow/react internals when running under jsdom in Vitest.
//
// This file is loaded by the test runner setup (see vitest config or package.json).
// It implements a forgiving DOMMatrixReadOnly that accepts CSS transform strings
// like "matrix(a, b, c, d, tx, ty)" and exposes m11/m12/m21/m22/m41/m42 (m41/m42 as tx/ty).
// If parsing fails, it falls back to the identity matrix.
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

    try {
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
    } catch (_) {
      // swallow parse errors and keep identity defaults
    }
  }

  // allow destructuring like: const { m22: zoom } = new DOMMatrixReadOnly(...)
  // expose toString for debugging if needed
  toString() {
    return `matrix(${this.m11},${this.m12},${this.m21},${this.m22},${this.m41},${this.m42})`;
  }
}

// Attach to globals used by libraries
try {
  // Node + jsdom environment: globalThis.window may exist
  (globalThis as any).DOMMatrixReadOnly = (globalThis as any).DOMMatrixReadOnly || SimpleDOMMatrixReadOnly;
  (globalThis as any).DOMMatrix = (globalThis as any).DOMMatrix || SimpleDOMMatrixReadOnly;
  if (typeof (globalThis as any).window !== "undefined") {
    (globalThis as any).window.DOMMatrixReadOnly = (globalThis as any).window.DOMMatrixReadOnly || SimpleDOMMatrixReadOnly;
    (globalThis as any).window.DOMMatrix = (globalThis as any).window.DOMMatrix || SimpleDOMMatrixReadOnly;
  }
} catch (_) {
  // best-effort
}

// Polyfill ResizeObserver for jsdom environment (minimal)
try {
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
} catch (_) {
  // ignore
}

// Some libraries access window.devicePixelRatio or call window.getComputedStyle expecting sensible defaults.
// Ensure a safe default exists for tests.
try {
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
} catch (_) {
  // ignore
}

 // Polyfill Element.scrollIntoView for jsdom (some UI libs call it)
try {
  if (typeof (globalThis as any).Element !== "undefined" && typeof (globalThis as any).Element.prototype.scrollIntoView === "undefined") {
    (globalThis as any).Element.prototype.scrollIntoView = function () { /* no-op for tests */ };
  }
} catch (_) {
  // ignore
}

/*
  Ensure tests run with tooltips disabled by default so tooltip DOM (and Radix
  context) doesn't interfere with unrelated tests. Individual tests can opt-in
  to enable tooltips by calling useAppConfigStore.getState().setTooltipEnabled(true)
  before importing UI components.
*/
void (async () => {
  try {
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
  } catch (_) {
    // best-effort; do not fail test setup
  }
})();
