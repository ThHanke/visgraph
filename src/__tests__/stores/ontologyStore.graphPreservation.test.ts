/**
 * @fileoverview Unit tests for graph preservation functionality in OntologyStore
 * Tests that changes to the current graph are preserved when loading additional ontologies
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useOntologyStore } from "../../stores/ontologyStore";
import { FIXTURES } from "../fixtures/rdfFixtures";

describe("OntologyStore - Graph Preservation", () => {
  beforeEach(() => {
    // Reset the store before each test
    const store = useOntologyStore.getState();
    store.clearOntologies();
  });

  it("should preserve existing graph changes when loading additional ontology", async () => {
    const store = useOntologyStore.getState();

    // Set up initial graph with some nodes and changes
    const initialNodes = [
      {
        id: "node1",
        data: {
          uri: "http://example.com/node1",
          classType: "Person",
          namespace: "foaf",
          literalProperties: [
            { key: "foaf:name", value: "John Doe", type: "xsd:string" },
            { key: "foaf:age", value: "30", type: "xsd:int" },
          ],
        },
      },
      {
        id: "node2",
        data: {
          uri: "http://example.com/node2",
          classType: "Organization",
          namespace: "foaf",
          literalProperties: [
            { key: "foaf:name", value: "ACME Corp", type: "xsd:string" },
          ],
        },
      },
    ];

    const initialEdges = [
      {
        id: "edge1",
        source: "node1",
        target: "node2",
        data: {
          propertyType: "foaf:memberOf",
          label: "member of",
        },
      },
    ];

    // Set the initial graph
    store.setCurrentGraph(initialNodes, initialEdges);

    // Verify initial state (read fresh)
    const state = useOntologyStore.getState();
    expect(state.currentGraph.nodes).toHaveLength(2);
    expect(state.currentGraph.edges).toHaveLength(1);
    expect(state.currentGraph.nodes[0].data.literalProperties).toHaveLength(2);

    // Create mock RDF content for additional ontology
    const additionalRdfContent =
      FIXTURES["foaf_test_data"] +
      `
@prefix ex: <http://example.com/new/> .

ex:newPerson a foaf:Person ;
  foaf:name "Jane Smith" ;
  foaf:email "jane@example.com" .

ex:newOrg a foaf:Organization ;
  foaf:name "New Company" .
`;

    // Load additional ontology with preservation enabled
    await store.loadOntologyFromRDF(additionalRdfContent, undefined, true);

    // Verify that original nodes are preserved (read fresh state)
    const state2 = useOntologyStore.getState();
    const currentNodes = state2.currentGraph.nodes;
    const currentEdges = state2.currentGraph.edges;

    // Check that original nodes still exist
    const originalNode1 = currentNodes.find((n) => n.id === "node1");
    const originalNode2 = currentNodes.find((n) => n.id === "node2");
    const originalEdge1 = currentEdges.find((e) => e.id === "edge1");

    expect(originalNode1).toBeDefined();
    expect(originalNode2).toBeDefined();
    expect(originalEdge1).toBeDefined();

    // Verify that changes are preserved
    expect(originalNode1?.data.literalProperties).toHaveLength(2);
    expect(originalNode1?.data.literalProperties[0].value).toBe("John Doe");
    expect(originalNode1?.data.literalProperties[1].value).toBe("30");

    expect(originalNode2?.data.literalProperties).toHaveLength(1);
    expect(originalNode2?.data.literalProperties[0].value).toBe("ACME Corp");

    // Verify that new nodes from the loaded ontology are also present
    expect(currentNodes.length).toBeGreaterThan(2);

    // Check that RDF manager was updated with the changes (read fresh rdfManager)
    const rdfManager = useOntologyStore.getState().rdfManager;
    const namespaces = rdfManager.getNamespaces();
    expect(namespaces).toHaveProperty("foaf");
    expect(namespaces).toHaveProperty("ex");
  });

  it("should update RDF store when entity properties are modified", async () => {
    const store = useOntologyStore.getState();

    // Create an entity
    const entityUri = "http://example.com/testEntity";
    const updates = {
      type: "foaf:Person",
      annotationProperties: [
        { propertyUri: "foaf:name", value: "Test Person", type: "xsd:string" },
        { propertyUri: "foaf:age", value: "25", type: "xsd:int" },
      ],
    };

    // Update entity in RDF store
    store.updateNode(entityUri, updates);

    // Load the entity into current graph
    const testNode = {
      id: "test1",
      data: {
        uri: entityUri,
        classType: "Person",
        namespace: "foaf",
        literalProperties: updates.annotationProperties.map((prop) => ({
          key: prop.propertyUri,
          value: prop.value,
          type: prop.type,
        })),
      },
    };

    store.setCurrentGraph([testNode], []);

    // Load additional ontology - this should preserve the changes
    const additionalRdf =
      FIXTURES["foaf_test_data"] +
      `
@prefix ex: <http://example.com/> .

ex:anotherPerson a foaf:Person ;
  foaf:name "Another Person" .
`;

    await store.loadOntologyFromRDF(additionalRdf, undefined, true);

    // Verify the original entity is still in the graph with its changes
    const preservedNode = useOntologyStore
      .getState()
      .currentGraph.nodes.find((n) => n.id === "test1");
    expect(preservedNode).toBeDefined();
    expect(preservedNode?.data.literalProperties).toHaveLength(2);
    expect(
      preservedNode?.data.literalProperties.find((p) => p.key === "foaf:name")
        ?.value,
    ).toBe("Test Person");
    expect(
      preservedNode?.data.literalProperties.find((p) => p.key === "foaf:age")
        ?.value,
    ).toBe("25");
  });

  it("should not duplicate nodes when loading ontology with same entities", async () => {
    const store = useOntologyStore.getState();

    // Set up initial graph
    const initialNodes = [
      {
        id: "node1",
        data: {
          uri: "http://example.com/person1",
          classType: "Person",
          namespace: "foaf",
        },
      },
    ];

    store.setCurrentGraph(initialNodes, []);

    // Load ontology that contains the same entity
    const rdfContent =
      FIXTURES["foaf_test_data"] +
      `
@prefix ex: <http://example.com/> .

ex:person1 a foaf:Person ;
  foaf:name "John Doe" .

ex:person2 a foaf:Person ;
  foaf:name "Jane Doe" .
`;

    await store.loadOntologyFromRDF(rdfContent, undefined, true);

    // Check that no duplicate nodes exist
    const nodes = useOntologyStore.getState().currentGraph.nodes;
    const nodeIds = nodes.map((n) => n.id);
    const uniqueNodeIds = [...new Set(nodeIds)];
    expect(nodeIds).toHaveLength(uniqueNodeIds.length);

    // Should have the original node plus new ones, but no duplicates
    expect(nodes.length).toBeGreaterThan(1);
    expect(nodes.find((n) => n.id === "node1")).toBeDefined();
  });
});
