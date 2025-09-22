import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { rdfManager } from "@/utils/rdfManager";
import { DataFactory } from "n3";
const { namedNode, literal, quad } = DataFactory;
import { useOntologyStore } from "@/stores/ontologyStore";
import { NodePropertyEditor } from "@/components/Canvas/NodePropertyEditor";
import { LinkPropertyEditor } from "@/components/Canvas/LinkPropertyEditor";

describe("Deletion handlers (node & edge)", () => {
  beforeEach(() => {
    // reset RDF store and ontology store between tests
    try {
      rdfManager.clear();
    } catch (_) {
      /* ignore */
    }
    try {
      // reset currentGraph
      (useOntologyStore as any).setState({ currentGraph: { nodes: [], edges: [] } });
    } catch (_) {
      /* ignore */
    }
    vi.restoreAllMocks();
  });

  it("node delete removes subject + object triples and updates currentGraph", async () => {
    const store = rdfManager.getStore();
    const g = namedNode("urn:vg:data");

    const nodeIri = "http://example.com/instance-node";
    const otherIri = "http://example.com/other-node";
    const p1 = "http://example.com/p1";
    const p2 = "http://example.com/p2";

    // Add a quad where nodeIri is subject
    store.addQuad(quad(namedNode(nodeIri), namedNode(p1), literal("v1"), g));
    // Add a quad where nodeIri is object
    store.addQuad(quad(namedNode(otherIri), namedNode(p2), namedNode(nodeIri), g));

    // seed currentGraph with node and an edge referencing it
    const nodeObj = {
      id: nodeIri,
      iri: nodeIri,
      data: { iri: nodeIri, individualName: "instance-node" },
    };
    const otherNodeObj = {
      id: otherIri,
      iri: otherIri,
      data: { iri: otherIri, individualName: "other-node" },
    };
    const edgeObj = {
      id: `${otherIri}-${nodeIri}-${encodeURIComponent(p2)}`,
      source: otherIri,
      target: nodeIri,
      data: { propertyUri: p2, propertyType: p2, label: "p2" },
    };

    (useOntologyStore as any).setState({
      currentGraph: { nodes: [nodeObj, otherNodeObj], edges: [edgeObj] },
    });

    // Render editor for the node
    render(
      <NodePropertyEditor
        open={true}
        onOpenChange={() => {}}
        nodeData={{ data: { iri: nodeIri } }}
        onSave={() => {}}
        availableEntities={[]}
      />
    );

    // Mock confirm to auto-confirm
    vi.stubGlobal("confirm", () => true);

    // Click the Delete button
    const del = await screen.findByRole("button", { name: /delete/i });
    fireEvent.click(del);

    // Wait for the deletion to be applied
    await waitFor(() => {
      const subjQuads = store.getQuads(namedNode(nodeIri), null, null, g) || [];
      const objQuads = store.getQuads(null, null, namedNode(nodeIri), g) || [];
      expect(subjQuads.length).toBe(0);
      expect(objQuads.length).toBe(0);

      const cg = (useOntologyStore as any).getState().currentGraph;
      const nodes = cg.nodes || [];
      const edges = cg.edges || [];
      expect(nodes.find((n: any) => String(n.id) === nodeIri)).toBeUndefined();
      expect(edges.find((e: any) => String(e.source) === nodeIri || String(e.target) === nodeIri)).toBeUndefined();
    });
  });

  it("edge delete removes the triple and updates currentGraph on first attempt", async () => {
    const store = rdfManager.getStore();
    const g = namedNode("urn:vg:data");

    const subj = "http://example.com/s";
    const obj = "http://example.com/o";
    const pred = "http://example.com/prop";

    // add the triple into the data graph
    store.addQuad(quad(namedNode(subj), namedNode(pred), namedNode(obj), g));

    // Seed currentGraph with nodes and an edge that matches the mapping id
    const nodeS = { id: subj, iri: subj, data: { iri: subj } };
    const nodeO = { id: obj, iri: obj, data: { iri: obj } };
    const edgeId = `${subj}-${obj}-${encodeURIComponent(pred)}`;
    const edge = {
      id: edgeId,
      source: subj,
      target: obj,
      data: { propertyUri: pred, propertyType: pred, label: "prop" },
    };

    (useOntologyStore as any).setState({
      currentGraph: { nodes: [nodeS, nodeO], edges: [edge] },
    });

    // Render LinkPropertyEditor configured to edit this edge
    render(
      <LinkPropertyEditor
        open={true}
        onOpenChange={() => {}}
        linkData={edge}
        sourceNode={nodeS}
        targetNode={nodeO}
        onSave={() => {}}
      />
    );

    // Mock confirm
    vi.stubGlobal("confirm", () => true);

    // Click Delete
    const del = await screen.findByRole("button", { name: /delete/i });
    fireEvent.click(del);

    // Wait for deletion and assert
    await waitFor(() => {
      const quads = store.getQuads(namedNode(subj), namedNode(pred), namedNode(obj), g) || [];
      expect(quads.length).toBe(0);

      const cg = (useOntologyStore as any).getState().currentGraph;
      const edges = cg.edges || [];
      expect(edges.find((e: any) => String(e.id) === edgeId)).toBeUndefined();
    });
  });
});
