import { describe, it, expect } from "vitest";

/**
 * Regression test: merging enriched mapped nodes/edges into existing canvas state
 * must preserve unrelated nodes/edges (simulate edge-edit incremental mapping).
 *
 * This test reproduces the upsert/merge logic used by KnowledgeCanvas when applying
 * mapped nodes/edges and asserts unrelated nodes remain present.
 */

function mergeNodes(existingNodes: any[], mergedNodes: any[]) {
  const nodeById = new Map<string, any>();
  {
    (existingNodes || []).forEach((n) => nodeById.set(String(n.id), n));
  }

  {
    (mergedNodes || []).forEach((n) => {
      try {
        const id = String(n.id);
        const prev = nodeById.get(id);
        if (prev) {
          const mergedNode = { ...prev, ...n, position: prev.position || n.position || { x: 0, y: 0 } };
          if ((prev as any).__rf) (mergedNode as any).__rf = (prev as any).__rf;
          if ((prev as any).selected) (mergedNode as any).selected = true;
          nodeById.set(id, mergedNode);
        } else {
          nodeById.set(id, (n && (n as any).position) ? n : { ...n, position: n.position || { x: 0, y: 0 } });
        }
      } catch (_) { void 0; }
    });
  }

  return Array.from(nodeById.values()).filter(Boolean);
}

function mergeEdges(existingEdges: any[], mergedEdges: any[]) {
  const edgeById = new Map<string, any>();
  {
    (existingEdges || []).forEach((e) => edgeById.set(String(e.id), e));
  }

  {
    (mergedEdges || []).forEach((e) => {
      try {
        const id = String(e.id);
        edgeById.set(id, e);
      } catch (_) { void 0; }
    });
  }

  return Array.from(edgeById.values()).filter(Boolean);
}

describe("merge preserves unrelated nodes/edges", () => {
  it("keeps unrelated node when an edge edit maps only subject/object nodes", () => {
    const existingNodes = [
      { id: "http://example.com/A", data: { iri: "http://example.com/A" }, position: { x: 0, y: 0 } },
      { id: "http://example.com/B", data: { iri: "http://example.com/B" }, position: { x: 10, y: 10 } },
      { id: "http://example.com/C", data: { iri: "http://example.com/C" }, position: { x: 20, y: 20 } }, // unrelated node
    ];

    // Simulate mapping result after an edge edit between A and B only (C not present)
    const mappedNodes = [
      { id: "http://example.com/A", data: { iri: "http://example.com/A", annotationProperties: [] }, position: { x: 0, y: 0 } },
      { id: "http://example.com/B", data: { iri: "http://example.com/B", annotationProperties: [] }, position: { x: 15, y: 15 } },
    ];

    const final = mergeNodes(existingNodes, mappedNodes);

    // C must still be present
    const ids = final.map((n) => n.id).sort();
    expect(ids).toContain("http://example.com/C");
    // A and B should be present and B updated (position overwritten as merged uses prev position if present)
    expect(ids).toContain("http://example.com/A");
    expect(ids).toContain("http://example.com/B");
  });

  it("keeps unrelated edges when merging enriched edges", () => {
    const existingEdges = [
      { id: "E1", source: "http://example.com/A", target: "http://example.com/C" },
      { id: "E2", source: "http://example.com/B", target: "http://example.com/C" }, // unrelated edge
    ];

    // Incoming mapping includes only edge E3 between A and B (edited), not E2
    const mappedEdges = [
      { id: "E3", source: "http://example.com/A", target: "http://example.com/B" },
    ];

    const final = mergeEdges(existingEdges, mappedEdges);
    const ids = final.map((e) => e.id).sort();

    // Unrelated edge E2 must still be present
    expect(ids).toContain("E2");
    // New edge E3 must be added
    expect(ids).toContain("E3");
    // Existing edge E1 should remain unless replaced by incoming (it wasn't)
    expect(ids).toContain("E1");
  });
});
