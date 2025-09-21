import React from "react";
import { render, waitFor } from "@testing-library/react";
import { test, expect, vi } from "vitest";
import ReactFlowCanvas from "../components/Canvas/ReactFlowCanvas";
import { useOntologyStore } from "../stores/ontologyStore";

/**
 * Unit-style test:
 * - Sets window.location.search to include the startup URL used in package.json dev script
 * - Enables persisted auto-load so the component initializer will run
 * - Mocks the ontology store's loadKnowledgeGraph to avoid a real network fetch
 * - Verifies that the mocked loader is invoked and that the store receives a loaded ontology
 */

const DEV_STARTUP_URL =
  "https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/refs/heads/main/LengthMeasurement.ttl";

test(
  "invokes loadKnowledgeGraph when url query parameter is present",
  async () => {
    // Arrange: set query param and enable persisted autoload
    (window as any).__VG_ALLOW_PERSISTED_AUTOLOAD = true;
    const params = `?url=${encodeURIComponent(DEV_STARTUP_URL)}`;
    const base = window.location.href.split("?")[0];
    window.history.replaceState({}, "test", `${base}${params}`);

    // Replace the store's loadKnowledgeGraph with a mock that writes a loaded ontology
    const originalLoad = useOntologyStore.getState().loadKnowledgeGraph;
    const mockLoad = vi.fn(async (source: string, options?: any) => {
      // simulate the real loader by adding a loaded ontology entry into the store
      useOntologyStore.setState({
        loadedOntologies: [
          {
            url: source,
            name: "LengthMeasurement (mocked)",
            classes: [],
            properties: [],
            namespaces: {},
          },
        ],
      });
    });
    // Apply mock
    useOntologyStore.setState({ loadKnowledgeGraph: mockLoad } as any);

    // Act: render the canvas which runs initialization on mount
    render(<ReactFlowCanvas />);

    // Trigger the explicit initializer (ensure initializeApp runs in test env)
    if (typeof (window as any).__VG_INIT_APP === "function") {
      try {
        await (window as any).__VG_INIT_APP({ force: true });
      } catch (_) {
        // ignore initializer errors in test harness
      }
    }

    // Assert: wait for mock to be called and for the store to contain the mocked ontology
    await waitFor(
      () => {
        expect(mockLoad).toHaveBeenCalled();
        const loaded = useOntologyStore.getState().loadedOntologies || [];
        expect(loaded.length).toBeGreaterThan(0);
        expect(String(loaded[0].url)).toContain("LengthMeasurement");
      },
      { timeout: 5000, interval: 200 },
    );

    // Cleanup: restore original loader and clear flag/query
    useOntologyStore.setState({ loadKnowledgeGraph: originalLoad } as any);
    delete (window as any).__VG_ALLOW_PERSISTED_AUTOLOAD;
    window.history.replaceState({}, "test", base);
  },
  10000,
);
