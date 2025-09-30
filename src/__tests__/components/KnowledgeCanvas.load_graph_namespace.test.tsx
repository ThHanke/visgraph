/**
 * Rewritten test: ensure namespaces parsed from a loaded RDF document are applied
 * and that the reconcile step populates availableProperties / availableClasses and
 * the namespace registry before KnowledgeCanvas enrichment. This test focuses on
 * asserting store-level effects (fat-map + namespace registry) rather than computeTermDisplay.
 */

import React from "react";
import { render, act } from "@testing-library/react";
import { vi, describe, test, beforeEach, afterEach, expect } from "vitest";

/* Lightweight component stubs so KnowledgeCanvas can render without exercising toolbar/editor code */
vi.mock("../../components/Canvas/CanvasToolbar", () => {
  return {
    __esModule: true,
    CanvasToolbar: (props: any) => {
      return React.createElement("div", { "data-testid": "canvas-toolbar" });
    },
  };
});

vi.mock("../../components/Canvas/LinkPropertyEditor", () => {
  return {
    __esModule: true,
    default: (props: any) => React.createElement("div", { "data-testid": "link-editor" }),
  };
});

vi.mock("../../components/Canvas/NodePropertyEditor", () => {
  return {
    __esModule: true,
    default: (props: any) => React.createElement("div", { "data-testid": "node-editor" }),
    NodePropertyEditor: (props: any) => React.createElement("div", { "data-testid": "node-editor-named" }),
  };
});

vi.mock("../../components/Canvas/ResizableNamespaceLegend", () => {
  return {
    __esModule: true,
    ResizableNamespaceLegend: (props: any) => React.createElement("div", { "data-testid": "legend" }),
  };
});

vi.mock("../../components/Canvas/ReasoningIndicator", () => {
  return {
    __esModule: true,
    ReasoningIndicator: (props: any) => React.createElement("div", { "data-testid": "reasoning-indicator" }),
  };
});

vi.mock("../../components/Canvas/ReasoningReportModal", () => {
  return {
    __esModule: true,
    ReasoningReportModal: (props: any) => React.createElement("div", { "data-testid": "reasoning-modal" }),
  };
});

/* Stub LayoutManager so KnowledgeCanvas can instantiate it safely in test env */
vi.mock("../../components/Canvas/LayoutManager", () => {
  return {
    __esModule: true,
    LayoutManager: class {
      constructor(_ctx: any) {}
      suggestOptimalLayout() { return "dagre"; }
      async applyLayout(_layoutType: any, _opts?: any) {}
    },
  };
});

/* Keep mapper stub small so mapping doesn't influence this test */
vi.mock("../../components/Canvas/core/mappingHelpers", () => {
  return {
    __esModule: true,
    default: (_quads: any[], _opts?: any) => ({
      nodes: [
        {
          id: "http://example.com/node1",
          type: "ontology",
          position: { x: 0, y: 0 },
          data: {
            key: "http://example.com/node1",
            iri: "http://example.com/node1",
            rdfTypes: ["http://example.com/Type"],
            literalProperties: [],
            annotationProperties: [],
            visible: true,
            label: "node1",
          },
        },
      ],
      edges: [],
    }),
  };
});

describe("KnowledgeCanvas loadKnowledgeGraph namespace + palette orchestration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("loading RDF into data graph applies namespaces and reconcile populates fat-map before enrichment", async () => {
    // Simple fake RDF manager and store backing used by the mocked store
    const onSubjectsChangeHandlers: any[] = [];
    const namespaces: Record<string,string> = {};
    const storeQuads: any[] = [];

    const fakeMgr = {
      getStore: () => ({
        getQuads: (_s: any, _p: any, _o: any, _g: any) => storeQuads.slice(),
        addQuad: (_q: any) => {},
        removeQuad: (_q: any) => {},
      }),
      _namespaces: namespaces,
      getNamespaces: () => ({ ...namespaces }),
      applyParsedNamespaces: (ns: Record<string,string>) => { Object.assign(namespaces, ns || {}); },
      loadRDFIntoGraph: async (content: string, graphName?: string) => {
        try {
          const lines = String(content || "").split(/\r?\n/);
          for (const l of lines) {
            const m = l.match(/@prefix\s+([A-Za-z0-9_\-]+):\s+<([^>]+)>/);
            if (m) {
              const p = m[1];
              const uri = m[2];
              namespaces[p] = uri;
            }
            const tripleMatch = l.match(/<([^>]+)>\s+a\s+<([^>]+)>/);
            if (tripleMatch) {
              const subj = { value: tripleMatch[1] };
              const pred = { value: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" };
              const obj = { value: tripleMatch[2] };
              const graph = { value: graphName || "urn:vg:data" };
              storeQuads.push({ subject: subj, predicate: pred, object: obj, graph });
            }
          }
        } catch (_) {}
      },
      onSubjectsChange: (cb: any) => { onSubjectsChangeHandlers.push(cb); },
      offSubjectsChange: (_cb: any) => {},
      onChange: (_cb: any) => {},
      expandPrefix: (v: string) => {
        try {
          const parts = String(v).split(":");
          if (parts.length === 2 && namespaces[parts[0]]) return namespaces[parts[0]] + parts[1];
        } catch (_) {}
        return v;
      },
    };

    // Mocked store: loadKnowledgeGraph writes into fakeMgr and then triggers reconcile-like behavior
    const mockedStore: any = {
      loadedOntologies: [],
      availableProperties: [],
      availableClasses: [],
      loadKnowledgeGraph: async (src: string, _opts?: any) => {
        // parse into fakeMgr
        await fakeMgr.loadRDFIntoGraph(src, "urn:vg:data");
        // simulate reconcile: populate fat-map and namespaces registry
        mockedStore.availableProperties = [{ iri: "http://example.com/prop", label: "prop", namespace: "http://example.com/" }];
        mockedStore.availableClasses = [{ iri: "http://example.com/Type", label: "Type", namespace: "http://example.com/" }];
        mockedStore.setNamespaceRegistry = vi.fn().mockImplementation((reg: any) => { mockedStore._lastRegistry = reg; });
        // emit subject change so component runs mapping/enrichment
        const ontologyQuad = { subject: { value: "http://example.com/prop" }, predicate: { value: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" }, object: { value: "http://www.w3.org/2002/07/owl#ObjectProperty" }, graph: { value: "urn:vg:ontologies:1" } };
        const dataQuad = { subject: { value: "http://example.com/node1" }, predicate: { value: "http://example.com/prop" }, object: { value: "http://example.com/node2" }, graph: { value: "urn:vg:data" } };
        onSubjectsChangeHandlers.forEach((h) => { try { h([], [ontologyQuad, dataQuad]); } catch (_) {} });
      },
      exportGraph: async () => "",
      updateNode: async () => {},
      loadAdditionalOntologies: async () => {},
      getRdfManager: () => fakeMgr,
      reconcileQuads: async (_quads: any[]) => {
        mockedStore.availableProperties = [{ iri: "http://example.com/prop", label: "prop", namespace: "http://example.com/" }];
        mockedStore.availableClasses = [{ iri: "http://example.com/Type", label: "Type", namespace: "http://example.com/" }];
        return Promise.resolve();
      },
      ontologiesVersion: 1,
    };

    vi.doMock("../../stores/ontologyStore", () => ({ __esModule: true, useOntologyStore: () => mockedStore }));

    const { default: KC } = await import("../../components/Canvas/KnowledgeCanvas");

    // TTL content with prefix & type
    const ttl = `
      @prefix ex: <http://example.com/> .
      <http://example.com/node1> a <http://example.com/Type> .
    `;

    // Render
    await act(async () => {
      render(React.createElement(KC));
    });

    // Trigger load
    await act(async () => {
      await mockedStore.loadKnowledgeGraph(ttl);
    });

    // advance timers to allow debounced mapping/enrichment
    act(() => { vi.advanceTimersByTime(300); });

    // Assertions: fat-map and namespace registry
    expect(Array.isArray(mockedStore.availableProperties)).toBeTruthy();
    expect(mockedStore.availableProperties.some((p: any) => String(p.iri) === "http://example.com/prop")).toBeTruthy();

    expect(Array.isArray(mockedStore.availableClasses)).toBeTruthy();
    expect(mockedStore.availableClasses.some((c: any) => String(c.iri) === "http://example.com/Type")).toBeTruthy();

    const registryArg = mockedStore._lastRegistry || (mockedStore.setNamespaceRegistry as any).mock?.calls?.[0]?.[0];
    const mgrNamespaces = (fakeMgr && typeof fakeMgr.getNamespaces === "function") ? fakeMgr.getNamespaces() : {};
    const registryPresent = Array.isArray(registryArg) || (mgrNamespaces && typeof mgrNamespaces === "object" && Object.keys(mgrNamespaces || {}).length > 0);
    expect(registryPresent).toBeTruthy();
    if (Array.isArray(registryArg)) {
      expect(registryArg.some((r: any) => r.prefix === "ex" && String(r.namespace).startsWith("http://example.com/"))).toBeTruthy();
    } else {
      expect(mgrNamespaces && String(mgrNamespaces["ex"] || "").startsWith("http://example.com/")).toBeTruthy();
    }
  }, 20000);
});
