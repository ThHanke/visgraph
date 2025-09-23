import React from "react";
import { describe, test, expect, beforeEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { act } from "react-dom/test-utils";
import KnowledgeCanvas from "../../../src/components/Canvas/KnowledgeCanvas";
import { rdfManager } from "../../../src/utils/rdfManager";
import { FIXTURES } from "../fixtures/rdfFixtures";

  describe("KnowledgeCanvas incremental mapping preserves nodes when ontologies load", () => {

  const dataFixtureUrl = "https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/main/specimen.ttl";
  // ontology fixture will be loaded from local FIXTURES (foaf_test_data)

  beforeEach(() => {
    // ensure a fresh clean store
    try { rdfManager.clear(); } catch (_) { void 0; }
  });

  test("loads data then ontology and node/edge counts do not decrease", async () => {
    // Render the canvas
    const { container } = render(<KnowledgeCanvas />);

    // Wait for component readiness hook (integration tests use this)
    await waitFor(() => {
      if (!(window as any).__VG_KNOWLEDGE_CANVAS_READY) throw new Error("not ready");
    }, { timeout: 5000 });

    // Load data fixture into the data graph using local fixture (avoid network in tests)
    await rdfManager.loadRDFIntoGraph(
      FIXTURES["https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/main/specimen.ttl"],
      "urn:vg:data",
      "text/turtle",
    );

    // Drain pending animation frames / microtasks to give React Flow a chance to mount nodes.
    // We run several requestAnimationFrame ticks and an extra short timeout to simulate
    // the browser frame loop that xyflow/react expects.
    try {
      for (let i = 0; i < 8; i++) {
        // eslint-disable-next-line no-await-in-loop
        await act(() => new Promise((res) => requestAnimationFrame(() => res(undefined))));
      }
      // one extra macrotask tick
      // eslint-disable-next-line no-await-in-loop
      await act(() => new Promise((res) => setTimeout(res, 20)));
    } catch (_) {
      // best-effort only
    }

    // Wait for the React Flow instance and its internal node/edge arrays to be populated.
    await waitFor(() => {
      const inst = (window as any).__VG_RF_INSTANCE;
      if (!inst) throw new Error("waiting for reactflow instance");
      const n = typeof inst.getNodes === "function" ? inst.getNodes() : (inst && inst.nodes) || [];
      const e = typeof inst.getEdges === "function" ? inst.getEdges() : (inst && inst.edges) || [];
      // require at least 2 nodes and 1 edge produced by the mapper
      if (!Array.isArray(n) || n.length < 2 || !Array.isArray(e) || e.length < 1)
        throw new Error("waiting for data nodes/edges on instance");
    }, { timeout: 10000, interval: 100 });

    // Record counts after data load using the ReactFlow instance (reliable)
    const inst = (window as any).__VG_RF_INSTANCE;
    const nodesAfterData = inst && typeof inst.getNodes === "function" ? inst.getNodes() : (inst && inst.nodes) || [];
    const edgesAfterData = inst && typeof inst.getEdges === "function" ? inst.getEdges() : (inst && inst.edges) || [];
    const nodeCountAfterData = Array.isArray(nodesAfterData) ? nodesAfterData.length : 0;
    const edgeCountAfterData = Array.isArray(edgesAfterData) ? edgesAfterData.length : 0;

    expect(nodeCountAfterData).toBeGreaterThanOrEqual(2);
    expect(edgeCountAfterData).toBeGreaterThanOrEqual(1);

    // Now load the FOAF ontology fixture into the ontology graph (from local FIXTURES)
    await rdfManager.loadRDFIntoGraph(FIXTURES.foaf_test_data, "urn:vg:ontologies", "text/turtle");

    // Allow the manager to flush subject-level changes and the canvas to react.
    // Wait until the ReactFlow instance reports counts at least as large as after data load.
    await waitFor(() => {
      const inst = (window as any).__VG_RF_INSTANCE;
      if (!inst) throw new Error("waiting for reactflow instance after ontology load");
      const n = typeof inst.getNodes === "function" ? inst.getNodes() : (inst && inst.nodes) || [];
      const e = typeof inst.getEdges === "function" ? inst.getEdges() : (inst && inst.edges) || [];
      if (!Array.isArray(n) || n.length < nodeCountAfterData || !Array.isArray(e) || e.length < edgeCountAfterData) {
        throw new Error("waiting for counts to stabilize on instance after ontology load");
      }
    }, { timeout: 10000, interval: 100 });

    // Re-check counts from the ReactFlow instance
    const instAfter = (window as any).__VG_RF_INSTANCE;
    const nodesAfterOntology = instAfter && typeof instAfter.getNodes === "function" ? instAfter.getNodes() : (instAfter && instAfter.nodes) || [];
    const edgesAfterOntology = instAfter && typeof instAfter.getEdges === "function" ? instAfter.getEdges() : (instAfter && instAfter.edges) || [];
    const nodeCountAfterOntology = Array.isArray(nodesAfterOntology) ? nodesAfterOntology.length : 0;
    const edgeCountAfterOntology = Array.isArray(edgesAfterOntology) ? edgesAfterOntology.length : 0;

    // The key assertion: counts should not have decreased after ontology load
    expect(nodeCountAfterOntology).toBeGreaterThanOrEqual(nodeCountAfterData);
    expect(edgeCountAfterOntology).toBeGreaterThanOrEqual(edgeCountAfterData);
  }, 30000);
});
