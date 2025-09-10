/**
 * Test setup for vitest: mock global fetch for ontology URLs used in tests.
 * Also ensure a minimal jsdom environment is present for tests that call DOM APIs,
 * and load testing-library matchers.
 */

import { JSDOM } from 'jsdom';

// Provide a lightweight jsdom environment if one isn't already present.
// Vitest typically does this for us (environment: "jsdom"), but some runners
// or earlier misconfigurations can leave globals undefined; this guarantees tests run.
if (typeof globalThis.document === 'undefined') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  // Expose minimal browser globals expected by testing-library and components
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  (globalThis as any).navigator = dom.window.navigator;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
  (globalThis as any).HTMLCanvasElement = dom.window.HTMLCanvasElement;
  (globalThis as any).Node = dom.window.Node;
}

// Polyfills for jsdom missing browser APIs used by the app when rendering in tests.
// These are intentionally lightweight stubs to allow components that check for
// matchMedia or create/operate on <canvas> to mount without requiring heavyweight
// native modules or a real browser environment.

// Basic matchMedia polyfill (used by some UI libraries to detect reduced-motion / prefers-color-scheme).
if (typeof (globalThis as any).window?.matchMedia !== 'function') {
  (globalThis as any).window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as any;
}

 // Stub getContext on HTMLCanvasElement so libraries that expect a 2D context (e.g. )
 // do not throw. We return a minimal object implementing commonly used methods and props.
 if (typeof (globalThis as any).HTMLCanvasElement !== 'undefined') {
   const proto = (globalThis as any).HTMLCanvasElement.prototype;
   // Capture any original implementation and wrap it: try original first and fall back to a safe stub
   const originalGetContext = proto.getContext;
   proto.getContext = function (this: any, type: string) {
     try {
       if (typeof originalGetContext === 'function') {
         const res = originalGetContext.call(this, type);
         if (res) return res;
       }
     } catch {
       // fall through to stub implementation when original throws "Not implemented"
     }
 
     if (type === '2d') {
       return {
         fillStyle: '',
         strokeStyle: '',
         globalAlpha: 1,
         lineWidth: 1,
         beginPath: () => {},
         rect: () => {},
         fillRect: () => {},
         moveTo: () => {},
         lineTo: () => {},
         closePath: () => {},
         stroke: () => {},
         fill: () => {},
         clearRect: () => {},
         measureText: () => ({ width: 0 }),
         createLinearGradient: () => ({ addColorStop: () => {} }),
         setLineDash: () => {},
       };
     }
     return null;
   };
 }

 // Add jest-dom matchers for better assertions in tests (load asynchronously to avoid ReferenceError
 // if the test runner hasn't initialized the global `expect` yet).
 // Dynamic import is used so the module's top-level evaluation (which calls `expect.extend`) is
 // captured as a rejected promise instead of throwing synchronously.
/*
  Provide lightweight global diagnostic stubs used by instrumented code during tests.
  These are no-ops by design so tests can opt-in to inspect them via the startup debug API.
*/
(globalThis as any).fallback = (eventName?: string, meta?: any, opts?: any) => { /* no-op in tests */ };
(globalThis as any).debug = (..._args: any[]) => { /* no-op in tests */ };
(globalThis as any).debugLog = (..._args: any[]) => { /* no-op in tests */ };

/*
   test mock removed —  is no longer a project dependency.
  If tests require diagram-related stubs, add targeted mocks in those tests.
*/

/* Load jest-dom matchers for better assertions in tests.
   Use dynamic import so environments without ESM support don't throw synchronously.
*/
 // @ts-expect-error - dynamic import may resolve to a types-only declaration in some environments
void import('@testing-library/jest-dom').catch(() => { /* intentionally ignore import failures in some runtimes */ });

// --- existing fixture-based fetch mocking (kept) ---

const fixtures: Record<string, string> = {
  'http://xmlns.com/foaf/0.1/': `
    @prefix foaf: <http://xmlns.com/foaf/0.1/> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    @prefix : <http://example.org/> .

    foaf:Person a rdfs:Class .
    foaf:Organization a rdfs:Class .
    foaf:name a rdfs:Property .
  `,
  'https://www.w3.org/TR/vocab-org/': `
    @prefix org: <https://www.w3.org/TR/vocab-org/> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    @prefix : <http://example.org/> .

    org:Organization a rdfs:Class .
  `,
  // IOF core and materials fixtures to cover tests that reference those prefixes/URLs
  'https://spec.industrialontologies.org/ontology/core/Core/': `
    @prefix iof: <https://spec.industrialontologies.org/ontology/core/Core/> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

    iof:MeasurementProcess a rdfs:Class ;
        rdfs:label "Measurement Process" .
  `,
  'https://spec.industrialontologies.org/ontology/materials/Materials/': `
    @prefix iof-mat: <https://spec.industrialontologies.org/ontology/materials/Materials/> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

    iof-mat:MeasurementDevice a rdfs:Class ;
        rdfs:label "Measurement Device" .
  `,
  'https://spec.industrialontologies.org/ontology/qualities/': `
    @prefix iof-qual: <https://spec.industrialontologies.org/ontology/qualities/> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

    iof-qual:Length a rdfs:Class .
  `,
  // Demo graph entries used by tests (github IOF materials tutorial) and startupFileUrl variants
  'https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/main/example.ttl': `
    @prefix iof-qual: <https://spec.industrialontologies.org/ontology/qualities/> .
    @prefix : <https://github.com/Mat-O-Lab/IOFMaterialsTutorial/> .
    :SpecimenLength a iof-qual:Length .
    :Caliper a <https://spec.industrialontologies.org/ontology/materials/Materials/MeasurementDevice> .
  `,
  'https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/refs/heads/main/LengthMeasurement.ttl': `
    @prefix : <https://github.com/Mat-O-Lab/IOFMaterialsTutorial/> .
    @prefix iof-qual: <https://spec.industrialontologies.org/ontology/qualities/> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

    :SpecimenLength a iof-qual:Length ;
        rdfs:label "Specimen Length" .
  `
};

// Duplicate http->https variants so loadOntology's https-first candidate URL will match fixtures
Object.keys(fixtures).forEach((k) => {
  if (k.startsWith('http://')) {
    fixtures[k.replace(/^http:/, 'https:')] = fixtures[k];
  }
});

// Create a simple fetch mock that returns fixture text if known, otherwise a minimal TTL
function makeResponse(text: string) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    headers: {
      get: (k: string) => k === 'content-type' ? 'text/turtle; charset=utf-8' : undefined,
      forEach: (fn: (v: string, k: string) => void) => {
        fn('text/turtle; charset=utf-8', 'content-type');
      }
    }
  } as any);
}

if (typeof globalThis.fetch === 'undefined') {
  globalThis.fetch = (input: RequestInfo | URL, init?: any) => {
    const url = String(input);
    const key = Object.keys(fixtures).find(k => url.startsWith(k));
    if (key) return makeResponse(fixtures[key]);
    // fallback: return an empty Turtle document with common prefixes
    const fallback = `
      @prefix : <http://example.org/> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
    `;
    return makeResponse(fallback);
  };
} else {
  // If native fetch exists (node 18+), monkeypatch to intercept known URLs
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: any) => {
    const url = String(input);
    const key = Object.keys(fixtures).find(k => url.startsWith(k));
    if (key) return makeResponse(fixtures[key]);
    return originalFetch(input, init);
  };
}
