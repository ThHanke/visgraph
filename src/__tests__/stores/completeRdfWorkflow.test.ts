/**
 * @fileoverview Complete RDF Workflow Unit Tests
 * Tests the complete data flow from file loading -> RDF store -> canvas -> updates -> export
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Store, DataFactory } from "n3";
const { namedNode, literal, blankNode } = DataFactory;
import { useOntologyStore } from "../../stores/ontologyStore";
import { RDFManager } from "../../utils/rdfManager";
import { FIXTURES } from "../fixtures/rdfFixtures";
import mapQuadsToDiagram from "../../components/Canvas/core/mappingHelpers";

describe("Complete RDF Workflow", () => {
  beforeEach(() => {
    // Reset the store before each test
    const store = useOntologyStore.getState();
    store.clearOntologies();
  });

  describe("Step 1: File Loading to RDF Store", () => {
    it("should load demo file entities into RDF store", async () => {
      const store = useOntologyStore.getState();

      const demoRdf =
        FIXTURES[
          "https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/main/example.ttl"
        ];

      await store.loadOntologyFromRDF(demoRdf, undefined, false);

      // Verify entities are in RDF store (read fresh state)
      const rdfManager = useOntologyStore.getState().rdfManager;
      // Use exported Turtle as a robust check that the entities were loaded into the RDF store.
      const exportTtl = await (rdfManager && typeof rdfManager.exportToTurtle === "function"
        ? rdfManager.exportToTurtle()
        : Promise.resolve(""));
      expect(typeof exportTtl).toBe("string");
      expect(exportTtl.length).toBeGreaterThan(0);
      expect(exportTtl).toContain("SpecimenLength");
      expect(exportTtl).toContain("Caliper");
      // also verify canvas nodes were created via the pure mapper (store -> mapper -> UI)
      const dataGraph = namedNode("urn:vg:data");
      const quads = (rdfManager && rdfManager.getStore)
        ? (rdfManager.getStore().getQuads(null, null, null, dataGraph) || [])
        : [];
      const propsSnapshot = Array.isArray(useOntologyStore.getState().availableProperties)
        ? useOntologyStore.getState().availableProperties.slice()
        : [];
      const diagram = mapQuadsToDiagram(quads, { availableProperties: propsSnapshot });

      // Expect mapper to produce the two data-driven nodes (SpecimenLength, Caliper)
      expect(Array.isArray(diagram.nodes)).toBeTruthy();
      expect(diagram.nodes.length).toBeGreaterThanOrEqual(2);

      const nodeIds = (diagram.nodes || []).map((n: any) => String(n.id));
      const hasSpecimen = nodeIds.some((id: string) => id.includes("SpecimenLength"));
      expect(hasSpecimen).toBeTruthy();

      const hasCaliper = nodeIds.some((id: string) => id.includes("Caliper"));
      expect(hasCaliper).toBeTruthy();
    });
  });

  describe("Step 2: Canvas Changes Reflected in RDF Store", () => {
    it("should update RDF store when canvas entity properties are modified", async () => {
      const store = useOntologyStore.getState();

      // Load initial data
      const initialRdf =
        FIXTURES[
          "https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/main/example.ttl"
        ];

      await store.loadOntologyFromRDF(initialRdf, undefined, false);

      const entityUri =
        "https://github.com/Mat-O-Lab/IOFMaterialsTutorial/SpecimenLength";

      // Simulate canvas entity update
      store.updateNode(entityUri, {
        annotationProperties: [
          {
            propertyUri: "rdfs:label",
            value: "My Specimen Length",
            type: "xsd:string",
          },
          {
            propertyUri: "rdfs:comment",
            value: "Length measurement",
            type: "xsd:string",
          },
        ],
      });

      // Also update the canvas state
      const currentGraph = store.currentGraph;
      const updatedNodes = currentGraph.nodes.map((node) => {
        if (node.data.iri === entityUri) {
          return {
            ...node,
            data: {
              ...node.data,
              literalProperties: [
                {
                  key: "rdfs:label",
                  value: "My Specimen Length",
                  type: "xsd:string",
                },
                {
                  key: "rdfs:comment",
                  value: "Length measurement",
                  type: "xsd:string",
                },
              ],
            },
          };
        }
        return node;
      });
      store.setCurrentGraph(updatedNodes, currentGraph.edges);

      // Verify RDF store contains the updates
      const rdfStore = store.rdfManager.getStore();

      const rdfManager = store.rdfManager;
      const exportTtl = await (rdfManager && typeof rdfManager.exportToTurtle === "function"
        ? rdfManager.exportToTurtle()
        : Promise.resolve(""));
      expect(exportTtl).toContain("My Specimen Length");

      expect(exportTtl).toContain("Length measurement");
    });
  });

  describe("Step 3: Ontology Loading Preserves RDF Store", () => {
    it("should preserve entity updates when loading additional ontology", async () => {
      const store = useOntologyStore.getState();

      // Step 1: Load initial dataset
      const initialRdf =
        FIXTURES[
          "https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/main/example.ttl"
        ];

      await store.loadOntologyFromRDF(initialRdf, undefined, false);

      const entityUri =
        "https://github.com/Mat-O-Lab/IOFMaterialsTutorial/SpecimenLength";

      // Step 2: User modifies entity (simulating NodePropertyEditor)
      store.updateNode(entityUri, {
        annotationProperties: [
          {
            propertyUri: "rdfs:label",
            value: "User Added Label",
            type: "xsd:string",
          },
        ],
      });

      // Also update canvas state
      const currentGraph = store.currentGraph;
      const updatedNodes = currentGraph.nodes.map((node) => {
        if (node.data.iri === entityUri) {
          return {
            ...node,
            data: {
              ...node.data,
              literalProperties: [
                {
                  key: "rdfs:label",
                  value: "User Added Label",
                  type: "xsd:string",
                },
              ],
            },
          };
        }
        return node;
      });
      store.setCurrentGraph(updatedNodes, currentGraph.edges);

      // Step 3: Load additional ontology (simulating "Load Ontology" button)
      const additionalOntologyRdf = FIXTURES["foaf_test_data"];

      await store.loadOntologyFromRDF(additionalOntologyRdf, undefined, true);

      // Step 4: Verify user's label is still preserved in RDF store (read fresh state)
      const rdfManager2 = useOntologyStore.getState().rdfManager;
      const exportTtl2 = await (rdfManager2 && typeof rdfManager2.exportToTurtle === "function"
        ? rdfManager2.exportToTurtle()
        : Promise.resolve(""));
      expect(exportTtl2).toContain("User Added Label");

      // Step 5: Verify new ontology is also loaded
      // verify FOAF class was loaded (check export or namespaces)
      const ns = store.rdfManager.getNamespaces();
      expect(ns).toHaveProperty("foaf");
      expect(exportTtl2).toContain("foaf:Person");

      // Step 6: Verify namespaces from both ontologies are present
      const namespaces = store.rdfManager.getNamespaces();
      expect(namespaces).toHaveProperty("foaf");
      expect(namespaces).toHaveProperty("iof-qual");
    });
  });

  describe("Step 4: Export Contains All Changes", () => {
    it("should export complete RDF including user modifications and loaded ontologies", async () => {
      const store = useOntologyStore.getState();

      // Load demo data
      const demoRdf =
        FIXTURES[
          "https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/main/example.ttl"
        ];

      await store.loadOntologyFromRDF(demoRdf, undefined, false);

      // User adds properties
      const specimenUri =
        "https://github.com/Mat-O-Lab/IOFMaterialsTutorial/SpecimenLength";
      store.updateNode(specimenUri, {
        annotationProperties: [
          {
            propertyUri: "rdfs:label",
            value: "Specimen Length Property",
            type: "xsd:string",
          },
          {
            propertyUri: "rdfs:comment",
            value: "Measures specimen length",
            type: "xsd:string",
          },
        ],
      });

      // Load additional ontology
      const foafOntology = FIXTURES["foaf_test_data"];

      await store.loadOntologyFromRDF(foafOntology, undefined, true);

      // Export and verify all data is present
      const turtleExport = await store.exportGraph("turtle");

      // Should contain original entities
      expect(turtleExport).toContain("SpecimenLength");
      expect(turtleExport).toContain("Caliper");

      // Should contain user modifications
      expect(turtleExport).toContain("Specimen Length Property");
      expect(turtleExport).toContain("Measures specimen length");

      // Should contain loaded ontology
      expect(turtleExport).toContain("foaf:Person");
      expect(turtleExport).toContain("@prefix foaf:");

      console.log("Complete export test result:", turtleExport);
    });
  });

  describe("Step 5: Reasoner Integration", () => {
    it("should use complete RDF store for reasoning (no phantom inferences)", async () => {
      const store = useOntologyStore.getState();

      // Load only basic data without foaf
      const basicRdf = `
        @prefix ex: <http://example.com/> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

        ex:john_doe a ex:Person ;
            rdfs:label "John Doe" .
      `;

      await store.loadOntologyFromRDF(basicRdf, undefined, false);

      // Verify RDF store does NOT contain foaf:Agent type for john_doe (read fresh state)
      const rdfManager3 = useOntologyStore.getState().rdfManager;
      const exportTtl3 = await (rdfManager3 && typeof rdfManager3.exportToTurtle === "function"
        ? rdfManager3.exportToTurtle()
        : Promise.resolve(""));
      // foaf:Agent should not be present
      expect(exportTtl3.includes("foaf:Agent")).toBe(false);
      // our Person type should be present — accept either expanded IRI or a prefixed form
      const mgrForPerson = useOntologyStore.getState().rdfManager;
      const nsForPerson =
        mgrForPerson && typeof mgrForPerson.getNamespaces === "function"
          ? mgrForPerson.getNamespaces()
          : {};
      const personPresent =
        exportTtl3.includes("http://example.com/Person") ||
        exportTtl3.includes("ex:Person") ||
        (nsForPerson && nsForPerson["ex"] && exportTtl3.includes(String(nsForPerson["ex"]) + "Person"));
      expect(personPresent).toBeTruthy();

      // Verify foaf namespace is not loaded
      const namespaces = store.rdfManager.getNamespaces();
      expect(namespaces).not.toHaveProperty("foaf");
    });
  });

  describe("RDF Manager Consistency", () => {
    it("should maintain consistency between store operations", async () => {
      const rdfManager = new RDFManager();

      // Add namespaces by loading a small Turtle snippet so the prefixes / triples exist in the store.
      await rdfManager.loadRDF('@prefix ex: <http://example.com/> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .');

      // Load initial data
      const initialRdf = `
        @prefix ex: <http://example.com/> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

        ex:entity1 a ex:TestClass .
      `;

      await rdfManager.loadRDF(initialRdf);

      // Update entity
      rdfManager.updateNode("http://example.com/entity1", {
        annotationProperties: [
          {
            propertyUri: "rdfs:label",
            value: "Test Entity",
            type: "xsd:string",
          },
        ],
      });

      // Load additional RDF (simulating ontology load)
      const additionalRdf = `
        @prefix owl: <http://www.w3.org/2002/07/owl#> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

        owl:Thing a owl:Class ;
            rdfs:label "Thing" .
      `;

      await rdfManager.loadRDF(additionalRdf);

      // Verify original entity and its modifications are preserved
      const store = rdfManager.getStore();

      const labelQuads = store.getQuads(
        namedNode("http://example.com/entity1"),
        namedNode("http://www.w3.org/2000/01/rdf-schema#label"),
        null,
        null,
      );
      expect(labelQuads).toHaveLength(1);
      expect(labelQuads[0].object.value).toBe("Test Entity");

      // Verify new ontology data is also present
      const thingQuads = store.getQuads(
        "http://www.w3.org/2002/07/owl#Thing",
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
        "http://www.w3.org/2002/07/owl#Class",
        null,
      );
      expect(thingQuads).toHaveLength(1);

      // Export and verify all data is present
      const exported = await rdfManager.exportToTurtle();
      expect(exported).toContain("entity1");
      expect(exported).toContain("Test Entity");
      expect(exported).toContain("owl:Thing");
    });
  });
});
