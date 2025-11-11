import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_NAMESPACE_URI,
  ensureDefaultNamespaceMap,
  ensureDefaultRegistry,
} from "../../constants/namespaces";

/**
 * This test verifies that the ResizableNamespaceLegend displays entries driven
 * by the persisted namespaceRegistry on the ontology store. We simulate a
 * reconcile that populates the registry and assert the legend reflects it.
 */

vi.mock("../../stores/ontologyStore", () => {
  // Mutable mock store object so tests can update namespaceRegistry and re-render.
  const namespaceMap: Record<string, string> = {};
  const applyNamespaceMap = (map: Record<string, string>) => {
    const normalized = ensureDefaultNamespaceMap(map);
    for (const key of Object.keys(namespaceMap)) {
      delete namespaceMap[key];
    }
    Object.assign(namespaceMap, normalized);
  };
  applyNamespaceMap({ "": DEFAULT_NAMESPACE_URI });
  const store: any = {
    namespaceRegistry: [],
    rdfManager: {
      getNamespaces: () => {
        applyNamespaceMap({ ...namespaceMap });
        return { ...namespaceMap };
      },
      addNamespace: vi.fn((p: string, u: string) => {
        namespaceMap[p] = u;
        applyNamespaceMap({ ...namespaceMap });
      }),
      setNamespaces: vi.fn((map: Record<string, string>, options?: { replace?: boolean }) => {
        if (options?.replace) {
          applyNamespaceMap(map);
          return;
        }
        const merged = { ...namespaceMap, ...map };
        applyNamespaceMap(merged);
      }),
      emitAllSubjects: vi.fn(() => Promise.resolve()),
    },
    ontologiesVersion: 1,
    // helper to let tests mutate the registry
    setNamespaceRegistry: (arr: any[]) => {
      const next = ensureDefaultRegistry(Array.isArray(arr) ? arr : []);
      store.namespaceRegistry = next.map((entry) => ({
        prefix: entry.prefix,
        namespace: entry.namespace,
        color: entry.color ?? "",
      }));
    },
    reset: () => {
      store.namespaceRegistry = ensureDefaultRegistry([
        { prefix: "", namespace: DEFAULT_NAMESPACE_URI, color: "" },
      ]).map((entry) => ({
        prefix: entry.prefix,
        namespace: entry.namespace,
        color: entry.color ?? "",
      }));
      applyNamespaceMap({ "": DEFAULT_NAMESPACE_URI });
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
  beforeEach(async () => {
    vi.clearAllMocks();
    const storeModule = await import("../../stores/ontologyStore");
    const store = storeModule.useOntologyStore();
    store.reset();
  });

  it("shows default namespace on load and displays entries after registry is populated", async () => {
    // initial render - registry empty
    const { rerender } = render(React.createElement(ResizableNamespaceLegend, {}));
    const colonEntries = screen.getAllByTitle(DEFAULT_NAMESPACE_URI);
    expect(colonEntries.length).toBe(1);
    expect(
      colonEntries[0].parentElement?.querySelector(".font-mono")?.textContent,
    ).toBe(":");
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
    const exampleEntries = screen.getAllByTitle("http://example.com/");
    expect(exampleEntries.length).toBe(1);
    expect(screen.getAllByTitle("Remove namespace").length).toBe(2);

    // Assert swatch for 'ex' has a background color set (palette derived from registry)
    const exSpan =
      exampleEntries.find((entry) => {
        const badge = entry.parentElement?.querySelector(".font-mono");
        return badge?.textContent === "ex";
      }) ?? exampleEntries[0];
    const exRow = exSpan.parentElement;
    const leftBlock = exRow?.querySelector("div.flex");
    const swatch = leftBlock?.querySelector("div.w-3.h-3") as HTMLElement | null;
    expect(swatch).toBeTruthy();
    const bg = swatch && swatch.style && swatch.style.backgroundColor;
    expect(bg && bg.length > 0).toBeTruthy();
  });

  it("removes only the targeted namespace and notifies rdf manager", async () => {
    const { rerender } = render(React.createElement(ResizableNamespaceLegend, {}));
    const storeModule = await import("../../stores/ontologyStore");
    const store = storeModule.useOntologyStore();
    const registry = [
      { prefix: "ex", namespace: "http://example.com/", color: "#7DD3FC" },
      { prefix: "owl", namespace: "http://www.w3.org/2002/07/owl#", color: "#E2CFEA" },
    ];
    store.setNamespaceRegistry(registry);
    rerender(React.createElement(ResizableNamespaceLegend, {}));

    const [owlSpan] = screen.getAllByTitle("http://www.w3.org/2002/07/owl#");
    const owlRow = owlSpan.parentElement;
    const removeButton = owlRow?.querySelector('button[title="Remove namespace"]') as HTMLButtonElement | null;
    expect(removeButton).toBeTruthy();
    fireEvent.click(removeButton!);

    rerender(React.createElement(ResizableNamespaceLegend, {}));

    expect(store.namespaceRegistry).toEqual([
      { prefix: "ex", namespace: "http://example.com/", color: "#7DD3FC" },
    ]);
    const rdfManagerMock = store.rdfManager;
    expect(rdfManagerMock.setNamespaces).toHaveBeenLastCalledWith(
      { ex: "http://example.com/" },
      { replace: true },
    );
    expect(rdfManagerMock.emitAllSubjects).toHaveBeenCalled();

    expect(store.rdfManager.getNamespaces()).toEqual({
      ex: "http://example.com/",
    });
  });

  it("allows removing the default ':' namespace entry", async () => {
    const { rerender } = render(React.createElement(ResizableNamespaceLegend, {}));
    const storeModule = await import("../../stores/ontologyStore");
    const store = storeModule.useOntologyStore();
    const registry = [
      { prefix: "", namespace: DEFAULT_NAMESPACE_URI, color: "#ABCDEF" },
      { prefix: "ex", namespace: "http://example.com/resource", color: "#7DD3FC" },
    ];
    store.setNamespaceRegistry(registry);
    rerender(React.createElement(ResizableNamespaceLegend, {}));

    const colonEntries = screen.getAllByTitle(DEFAULT_NAMESPACE_URI);
    const colonSpan =
      colonEntries.find((entry) => {
        const badge = entry.parentElement?.querySelector(".font-mono");
        return badge?.textContent === ":";
      }) ?? colonEntries[0];
    const colonRow = colonSpan.parentElement;
    const removeButton = colonRow?.querySelector('button[title="Remove namespace"]') as HTMLButtonElement | null;
    expect(removeButton).toBeTruthy();
    fireEvent.click(removeButton!);

    rerender(React.createElement(ResizableNamespaceLegend, {}));

    expect(store.namespaceRegistry).toEqual([
      { prefix: "ex", namespace: "http://example.com/resource", color: "#7DD3FC" },
    ]);
    expect(store.rdfManager.setNamespaces).toHaveBeenLastCalledWith(
      { ex: "http://example.com/resource" },
      { replace: true },
    );
    expect(store.rdfManager.getNamespaces()).toEqual({
      ex: "http://example.com/resource",
    });
  });
});
