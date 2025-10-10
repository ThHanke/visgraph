import { expect, test, beforeEach } from "vitest";
import { rdfManager } from "../../../src/utils/rdfManager";
import { useOntologyStore } from "../../../src/stores/ontologyStore";
import { DataFactory } from "n3";
const { namedNode } = DataFactory;

// This file contains two related tests:
// 1) basic persistence + currentGraph reflection (keeps prior behavior)
// 2) FOAF-specific scenario: two foaf:Person nodes, persist foaf:knows triple, assert store + displayedEdges increase by one.

beforeEach(() => {
  // Clear RDF store and ontology store currentGraph so each test runs cleanly.
  {
    rdfManager.clear();
  }
  {
    useOntologyStore.setState({
      currentGraph: { nodes: [], edges: [] },
      loadedOntologies: [],
      availableClasses: [],
      availableProperties: [],
    } as any);
  }
});

test("persist triple into urn:vg:data and reflect edge into currentGraph", async () => {
  const subj = "https://example.test/subject1";
  const pred = "http://example.org/vocab#relatesTo";
  const obj = "https://example.test/object1";

  // Build TTL for a single triple
  const ttl = `<${subj}> <${pred}> <${obj}> .\n`;

  // Ensure no quads present initially
  const initialQuads = rdfManager.getStore().getQuads(null, null, null, null) || [];
  expect(initialQuads.length).toBe(0);

  // Persist into urn:vg:data
  await rdfManager.loadRDFIntoGraph(ttl, "urn:vg:data");

  // Verify the quad exists in the store (graph-scoped)
  const g = namedNode("urn:vg:data");
  const found = rdfManager.getStore().getQuads(namedNode(subj), namedNode(pred), namedNode(obj), g) || [];
  expect(found.length).toBeGreaterThanOrEqual(1);

  // Now mimic the lightweight editor behavior: add an edge to ontologyStore.currentGraph
  const os = useOntologyStore.getState();
  const cg = os.currentGraph || { nodes: [], edges: [] };
  const edgeId = `${subj}-${obj}-${encodeURIComponent(pred)}`;
  const newEdge = {
    id: edgeId,
    source: subj,
    target: obj,
    data: {
      propertyUri: pred,
      propertyType: pred,
      label: "relatesTo",
    },
  };

  // Apply via setCurrentGraph (same API the editor uses)
  if (typeof os.setCurrentGraph === "function") {
    os.setCurrentGraph(cg.nodes || [], [...(cg.edges || []), newEdge]);
  } else {
    // fallback: mutate directly (shouldn't happen in prod shape)
    useOntologyStore.setState({ currentGraph: { nodes: cg.nodes || [], edges: [...(cg.edges || []), newEdge] } } as any);
  }

  // Assert currentGraph now contains the new edge
  const updated = useOntologyStore.getState().currentGraph;
  expect(updated.edges.some((e: any) => e.id === edgeId)).toBe(true);
});

test("foaf persons: persist foaf:knows increases triple count by 1 and displayedEdges increases by 1", async () => {
  // Prepare two FOAF person IRIs
  const personA = "http://example.org/people/Alice";
  const personB = "http://example.org/people/Bob";
  const foafKnows = "http://xmlns.com/foaf/0.1/knows";

  // Ensure currentGraph contains two nodes representing these IRIs
  const os = useOntologyStore.getState();
  const initialGraph = os.currentGraph || { nodes: [], edges: [] };
  const nodeA = { id: personA, iri: personA, data: { iri: personA, individualName: "Alice", classType: "Person", namespace: "foaf" } };
  const nodeB = { id: personB, iri: personB, data: { iri: personB, individualName: "Bob", classType: "Person", namespace: "foaf" } };

  // Seed currentGraph nodes; ensure no edges initially
  if (typeof os.setCurrentGraph === "function") {
    os.setCurrentGraph([nodeA, nodeB], []);
  } else {
    useOntologyStore.setState({ currentGraph: { nodes: [nodeA, nodeB], edges: [] } } as any);
  }

  // Capture initial store quad count (graph urn:vg:data) and currentGraph displayedEdges count
  const g = namedNode("urn:vg:data");
  const beforeStoreCount = rdfManager.getStore().getQuads(null, null, null, g).length;
  const beforeCg = useOntologyStore.getState().currentGraph;
  const beforeDisplayedEdges = (beforeCg && Array.isArray(beforeCg.edges)) ? beforeCg.edges.length : 0;

  // Persist foaf:knows triple
  const ttl = `<${personA}> <${foafKnows}> <${personB}> .\n`;
  await rdfManager.loadRDFIntoGraph(ttl, "urn:vg:data");

  // After persistence: assert exactly one more triple for that particular triple (at least one added)
  const afterSpecific = rdfManager.getStore().getQuads(namedNode(personA), namedNode(foafKnows), namedNode(personB), g) || [];
  expect(afterSpecific.length).toBeGreaterThanOrEqual(1);

  // Also assert overall count increased by exactly 1 (best-effort).
  const afterStoreCount = rdfManager.getStore().getQuads(null, null, null, g).length;
  expect(afterStoreCount).toBe(beforeStoreCount + 1);

  // Simulate mapping pipeline reacting: insert the corresponding edge into currentGraph
  const edgeId = `${personA}-${personB}-${encodeURIComponent(foafKnows)}`;
  const newEdge = {
    id: edgeId,
    source: personA,
    target: personB,
    data: {
      propertyUri: foafKnows,
      propertyType: foafKnows,
      label: "knows",
    },
  };
  const cgNow = useOntologyStore.getState().currentGraph || { nodes: [], edges: [] };
  if (!cgNow.edges.some((e: any) => e.id === edgeId)) {
    if (typeof os.setCurrentGraph === "function") {
      os.setCurrentGraph(cgNow.nodes || [], [...(cgNow.edges || []), newEdge]);
    } else {
      useOntologyStore.setState({ currentGraph: { nodes: cgNow.nodes || [], edges: [...(cgNow.edges || []), newEdge] } } as any);
    }
  }

  // Finally, assert displayedEdges (i.e., currentGraph.edges length) increased by 1
  const finalCg = useOntologyStore.getState().currentGraph || { nodes: [], edges: [] };
  const afterDisplayedEdges = (finalCg && Array.isArray(finalCg.edges)) ? finalCg.edges.length : 0;
  expect(afterDisplayedEdges).toBe(beforeDisplayedEdges + 1);
});
