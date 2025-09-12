/**
 * @fileoverview Comprehensive unit tests for RDF store workflow
 * Tests the complete flow from entity updates to export and reasoning integration
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useOntologyStore } from "../../stores/ontologyStore";
import { RDFManager } from "../../utils/rdfManager";
import { FIXTURES } from "../fixtures/rdfFixtures";
import { useReasoningStore } from "../../stores/reasoningStore";

describe("RDF Store Workflow Integration Tests", () => {
  beforeEach(() => {
    // Reset the store before each test
    const store = useOntologyStore.getState();
    store.clearOntologies();
  });

  describe("Entity Update Workflow", () => {
    it("should update RDF store when entity properties are modified via NodePropertyEditor", async () => {
      const store = useOntologyStore.getState();

      // Load initial dataset (centralized fixture)
      const initialRdf =
        FIXTURES[
          "https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/main/example.ttl"
        ];

      await store.loadOntologyFromRDF(initialRdf, undefined, false);

      const entityUri =
        "https://github.com/Mat-O-Lab/IOFMaterialsTutorial/SpecimenLength";

      // Simulate NodePropertyEditor save - this is what happens when user edits
      const updatedNodeData = {
       iri: entityUri,
        classType: "Length",
        namespace: "iof-qual",
        annotationProperties: [
          {
            property: "rdfs:label",
            key: "rdfs:label",
            value: "Specimen Length Property",
            type: "xsd:string",
          },
          {
            property: "rdfs:comment",
            key: "rdfs:comment",
            value: "Length measurement of specimen",
            type: "xsd:string",
          },
        ],
      };

      // This should happen in the canvas when NodePropertyEditor calls onSave
      store.updateNode(entityUri, {
        annotationProperties: updatedNodeData.annotationProperties.map(
          (prop) => ({
            propertyUri: prop.key,
            value: prop.value,
            type: prop.type,
          }),
        ),
      });

      // Update the graph state as well
      const currentGraph = store.currentGraph;
      const updatedNodes = currentGraph.nodes.map((node) => {
        if (node.data.iri === entityUri) {
          return {
            ...node,
            data: {
              ...node.data,
              literalProperties: updatedNodeData.annotationProperties.map(
                (prop) => ({
                  key: prop.key,
                  value: prop.value,
                  type: prop.type,
                }),
              ),
            },
          };
        }
        return node;
      });
      store.setCurrentGraph(updatedNodes, currentGraph.edges);

      // Verify RDF store contains the updates
      const rdfStore = store.rdfManager.getStore();

      const labelQuads = rdfStore.getQuads(
        entityUri,
        "http://www.w3.org/2000/01/rdf-schema#label",
        null,
        null,
      );
      expect(labelQuads).toHaveLength(1);
      expect(labelQuads[0].object.value).toBe("Specimen Length Property");

      const commentQuads = rdfStore.getQuads(
        entityUri,
        "http://www.w3.org/2000/01/rdf-schema#comment",
        null,
        null,
      );
      expect(commentQuads).toHaveLength(1);
      expect(commentQuads[0].object.value).toBe(
        "Length measurement of specimen",
      );
    });

    it("should preserve entity updates in export after loading additional ontology", async () => {
      const store = useOntologyStore.getState();

      // Step 1: Load initial dataset
      const initialRdf =
        FIXTURES[
          "https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/main/example.ttl"
        ];

      await store.loadOntologyFromRDF(initialRdf, undefined, false);

      // Step 2: User edits entity (adds rdfs:label)
      const entityUri =
        "https://github.com/Mat-O-Lab/IOFMaterialsTutorial/SpecimenLength";

      store.updateNode(entityUri, {
        annotationProperties: [
          {
            propertyUri: "rdfs:label",
            value: "Specimen Length Property",
            type: "xsd:string",
          },
        ],
      });

      // Step 3: Load additional IOF ontology
      const iofOntologyRdf =
        FIXTURES["https://spec.industrialontologies.org/ontology/core/Core/"];

      await store.loadOntologyFromRDF(iofOntologyRdf, undefined, true);

      // Step 4: Export and verify rdfs:label is preserved
      const exportedTurtle = await store.exportGraph("turtle");

      expect(exportedTurtle).toContain("SpecimenLength");
      expect(exportedTurtle).toContain("rdfs:label");
      expect(exportedTurtle).toContain("Specimen Length Property");

      // Also verify directly in RDF store
      const rdfStore = store.rdfManager.getStore();
      const labelQuads = rdfStore.getQuads(
        entityUri,
        "http://www.w3.org/2000/01/rdf-schema#label",
        null,
        null,
      );
      expect(labelQuads).toHaveLength(1);
      expect(labelQuads[0].object.value).toBe("Specimen Length Property");
    });

    it("should load ontologies into RDF store when using loadOntology function", async () => {
      const store = useOntologyStore.getState();

      // Mock the loadOntology to use actual RDF content
      const mockOntologyRdf = FIXTURES["foaf_test_data"];

      // Simulate loadOntology by loading RDF content
      await store.loadOntologyFromRDF(mockOntologyRdf, undefined, false);

      // Verify ontology classes are in RDF store
      const rdfStore = store.rdfManager.getStore();

      // Check Person class
      const personClassQuads = rdfStore.getQuads(
        "http://xmlns.com/foaf/0.1/Person",
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
        "http://www.w3.org/2002/07/owl#Class",
        null,
      );
      expect(personClassQuads).toHaveLength(1);

      // Check Person label
      const personLabelQuads = rdfStore.getQuads(
        "http://xmlns.com/foaf/0.1/Person",
        "http://www.w3.org/2000/01/rdf-schema#label",
        null,
        null,
      );
      expect(personLabelQuads).toHaveLength(1);
      expect(personLabelQuads[0].object.value).toBe("Person");

      // Verify namespaces are loaded
      const namespaces = store.rdfManager.getNamespaces();
      expect(namespaces).toHaveProperty("foaf");
      expect(namespaces["foaf"]).toBe("http://xmlns.com/foaf/0.1/");
    });
  });

  describe("Export Functionality", () => {
    it("should export complete RDF store including user modifications", async () => {
      const store = useOntologyStore.getState();

      // Load base ontology
      const baseRdf = `
        @prefix ex: <http://example.com/> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
        @prefix owl: <http://www.w3.org/2002/07/owl#> .

        ex:TestClass a owl:Class ;
            rdfs:label "Test Class" .

        ex:testInstance a ex:TestClass .
      `;

      await store.loadOntologyFromRDF(baseRdf, undefined, false);

      // Add user modifications
      store.updateNode("http://example.com/testInstance", {
        type: "ex:TestClass",
        annotationProperties: [
          {
            propertyUri: "rdfs:label",
            value: "My Test Instance",
            type: "xsd:string",
          },
          {
            propertyUri: "rdfs:comment",
            value: "This is a test",
            type: "xsd:string",
          },
          {
            propertyUri: "ex:customProperty",
            value: "custom value",
            type: "xsd:string",
          },
        ],
      });

      // Export in different formats
      const turtleExport = await store.exportGraph("turtle");
      const jsonldExport = await store.exportGraph("json-ld");
      const rdfxmlExport = await store.exportGraph("rdf-xml");

      // Verify turtle export contains modifications
      expect(turtleExport).toContain("testInstance");
      expect(turtleExport).toContain("My Test Instance");
      expect(turtleExport).toContain("This is a test");
      expect(turtleExport).toContain("custom value");

      // Verify JSON-LD export contains modifications
      expect(jsonldExport).toContain("testInstance");
      expect(jsonldExport).toContain("My Test Instance");

      // Verify RDF/XML export contains modifications
      expect(rdfxmlExport).toContain("testInstance");
      expect(rdfxmlExport).toContain("My Test Instance");

      console.log("Turtle export:", turtleExport);
    });

    it("should maintain prefix mappings in exports", async () => {
      const store = useOntologyStore.getState();

      const rdfWithPrefixes =
        FIXTURES["foaf_test_data"] +
        `
@prefix ex: <http://example.com/> .
@prefix dc: <http://purl.org/dc/elements/1.1/> .

ex:person1 a foaf:Person ;
  foaf:name "John Doe" ;
  dc:description "A test person" ;
  rdfs:label "John" .
`;

      await store.loadOntologyFromRDF(rdfWithPrefixes, undefined, false);

      const exported = await store.exportGraph("turtle");

      // Check that prefixes are preserved
      expect(exported).toContain("@prefix ex:");
      expect(exported).toContain("@prefix foaf:");
      expect(exported).toContain("@prefix dc:");
      expect(exported).toContain("@prefix rdfs:");

      // Check that prefixed URIs are used
      expect(exported).toContain("foaf:Person");
      expect(exported).toContain("foaf:name");
      expect(exported).toContain("dc:description");
    });
  });

  describe("Reasoner Integration", () => {
    it("should use RDF store data for reasoning", async () => {
      const store = useOntologyStore.getState();

      // Load ontology with domain/range restrictions
      const ontologyRdf = FIXTURES["foaf_test_data"];

      await store.loadOntologyFromRDF(ontologyRdf, undefined, false);

      // Create instances in RDF store
      store.updateNode("http://example.com/john", {
        type: "foaf:Person",
        annotationProperties: [
          { propertyUri: "foaf:name", value: "John Doe", type: "xsd:string" },
        ],
      });

      store.updateNode("http://example.com/acme", {
        type: "foaf:Organization",
        annotationProperties: [
          { propertyUri: "foaf:name", value: "ACME Corp", type: "xsd:string" },
        ],
      });

      // Trigger reasoning explicitly so derived information (from domain/range rules)
      // is computed and applied into the RDF store before assertions. Some test
      // environments disable automatic reasoning, so run it here to ensure parity.
      await useReasoningStore
        .getState()
        .startReasoning([], [], store.rdfManager.getStore());

      // Verify reasoner can access the RDF store data
      const rdfStore = store.rdfManager.getStore();
      const allQuads = rdfStore.getQuads(null, null, null, null);

      expect(allQuads.length).toBeGreaterThan(0);

      // Verify domain/range information is available for reasoning
      const domainQuads = rdfStore.getQuads(
        "http://xmlns.com/foaf/0.1/memberOf",
        "http://www.w3.org/2000/01/rdf-schema#domain",
        null,
        null,
      );
      expect(domainQuads).toHaveLength(1);

      const rangeQuads = rdfStore.getQuads(
        "http://xmlns.com/foaf/0.1/memberOf",
        "http://www.w3.org/2000/01/rdf-schema#range",
        null,
        null,
      );
      expect(rangeQuads).toHaveLength(1);
    });
  });

  describe("RDF Manager Direct Tests", () => {
    it("should properly expand prefixes", () => {
      const rdfManager = new RDFManager();

      rdfManager.addNamespace("rdfs", "http://www.w3.org/2000/01/rdf-schema#");
      rdfManager.addNamespace("foaf", "http://xmlns.com/foaf/0.1/");

      expect(rdfManager.expandPrefix("rdfs:label")).toBe(
        "http://www.w3.org/2000/01/rdf-schema#label",
      );
      expect(rdfManager.expandPrefix("foaf:name")).toBe(
        "http://xmlns.com/foaf/0.1/name",
      );
      expect(rdfManager.expandPrefix("http://example.com/full")).toBe(
        "http://example.com/full",
      );
    });

    it("should update and remove entity properties correctly", async () => {
      const rdfManager = new RDFManager();

      rdfManager.addNamespace("rdfs", "http://www.w3.org/2000/01/rdf-schema#");
      rdfManager.addNamespace("ex", "http://example.com/");

      const entityUri = "http://example.com/entity1";

      // Add initial properties
      rdfManager.updateNode(entityUri, {
        annotationProperties: [
          {
            propertyUri: "rdfs:label",
            value: "Initial Label",
            type: "xsd:string",
          },
          {
            propertyUri: "rdfs:comment",
            value: "Initial Comment",
            type: "xsd:string",
          },
        ],
      });

      const store = rdfManager.getStore();

      // Verify initial properties
      let labelQuads = store.getQuads(
        entityUri,
        "http://www.w3.org/2000/01/rdf-schema#label",
        null,
        null,
      );
      expect(labelQuads).toHaveLength(1);
      expect(labelQuads[0].object.value).toBe("Initial Label");

      // Update properties (should replace, not add)
      rdfManager.updateNode(entityUri, {
        annotationProperties: [
          {
            propertyUri: "rdfs:label",
            value: "Updated Label",
            type: "xsd:string",
          },
          {
            propertyUri: "ex:newProperty",
            value: "New Value",
            type: "xsd:string",
          },
        ],
      });

      // Verify old label is replaced
      labelQuads = store.getQuads(
        entityUri,
        "http://www.w3.org/2000/01/rdf-schema#label",
        null,
        null,
      );
      expect(labelQuads).toHaveLength(1);
      expect(labelQuads[0].object.value).toBe("Updated Label");

      // Verify comment is removed (not in update)
      const commentQuads = store.getQuads(
        entityUri,
        "http://www.w3.org/2000/01/rdf-schema#comment",
        null,
        null,
      );
      expect(commentQuads).toHaveLength(0);

      // Verify new property is added
      const newPropQuads = store.getQuads(
        entityUri,
        "http://example.com/newProperty",
        null,
        null,
      );
      expect(newPropQuads).toHaveLength(1);
      expect(newPropQuads[0].object.value).toBe("New Value");
    });

    it("should export with correct prefixes and formatting", async () => {
      const rdfManager = new RDFManager();

      rdfManager.addNamespace("ex", "http://example.com/");
      rdfManager.addNamespace("rdfs", "http://www.w3.org/2000/01/rdf-schema#");
      rdfManager.addNamespace("foaf", "http://xmlns.com/foaf/0.1/");

      // Add some test data
      rdfManager.updateNode("http://example.com/person1", {
        type: "foaf:Person",
        annotationProperties: [
          { propertyUri: "rdfs:label", value: "John Doe", type: "xsd:string" },
          { propertyUri: "foaf:name", value: "John", type: "xsd:string" },
        ],
      });

      const turtle = await rdfManager.exportToTurtle();
      const jsonld = await rdfManager.exportToJsonLD();

      expect(turtle).toContain("@prefix ex:");
      expect(turtle).toContain("@prefix rdfs:");
      expect(turtle).toContain("@prefix foaf:");
      expect(turtle).toContain("person1");
      expect(turtle).toContain("John Doe");

      expect(jsonld).toContain("person1");
      expect(jsonld).toContain("John Doe");

      console.log("Exported Turtle:", turtle);
    });
  });
});
