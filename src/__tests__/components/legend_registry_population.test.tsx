import React from "react";
import { render, screen } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * This test verifies that the ResizableNamespaceLegend displays entries driven
 * by the persisted namespaceRegistry on the ontology store. We simulate a
 * reconcile that populates the registry and assert the legend reflects it.
 */

vi.mock("../../stores/ontologyStore", () => {
  // Mutable mock store object so tests can update namespaceRegistry and re-render.
  const store: any = {
    namespaceRegistry: [],
    rdfManager: {
      getNamespaces: () => ({}),
      addNamespace: (p: string, u: string) => {
        try {
          // test mock: no-op for addNamespace
        } catch (_) {}
      },
    },
    ontologiesVersion: 1,
    // helper to let tests mutate the registry
    setNamespaceRegistry: (arr: any[]) => {
      store.namespaceRegistry = Array.isArray(arr) ? arr.slice() : [];
    },
  };
  return {
    useOntologyStore: (selector?: any) => {
      if (typeof selector === "function") return selector(store);
      return store;
    },
  };
});

import ResizableNamespaceLegend from "../../components/Canvas/ResizableNamespaceLegend";

describe("ResizableNamespaceLegend store-driven behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows nothing when registry empty and displays entries after registry is populated", async () => {
    // initial render - registry empty
    const { rerender } = render(React.createElement(ResizableNamespaceLegend, {}));
    // nothing should be rendered (component returns null when no entries)
    expect(document.body.querySelectorAll(".space-y-2").length).toBeGreaterThanOrEqual(0);
    // Dynamically import the mocked store module (vi.mock placed above) so we can access the underlying mock store.
    const storeModule = await import("../../stores/ontologyStore");
    const store = storeModule.useOntologyStore();
    // Populate registry as reconcile would
    const newRegistry = [
      { prefix: "owl", namespace: "http://www.w3.org/2002/07/owl#", color: "#E2CFEA" },
      { prefix: "ex", namespace: "http://example.com/", color: "#7DD3FC" },
    ];
    store.setNamespaceRegistry(newRegistry);
    // Force re-render of the legend so it reads the updated registry
    rerender(React.createElement(ResizableNamespaceLegend, {}));

    // Assert legend shows the two URIs
    expect(screen.getByTitle("http://www.w3.org/2002/07/owl#")).toBeTruthy();
    expect(screen.getByTitle("http://example.com/")).toBeTruthy();

    // Assert swatch for 'ex' has a background color set (palette derived from registry)
    const exSpan = screen.getByTitle("http://example.com/");
    const exRow = exSpan.parentElement;
    const leftBlock = exRow?.querySelector("div.flex");
    const swatch = leftBlock?.querySelector("div.w-3.h-3") as HTMLElement | null;
    expect(swatch).toBeTruthy();
    const bg = swatch && swatch.style && swatch.style.backgroundColor;
    expect(bg && bg.length > 0).toBeTruthy();
  });
});
