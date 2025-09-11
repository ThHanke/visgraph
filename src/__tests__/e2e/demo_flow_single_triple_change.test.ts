/**
 * e2e/demo_flow_single_triple_change.test.ts
 *
 * Purpose:
 * - Provide a concise map of key functions and where they are called (helpful to find duplications).
 * - Implement a single E2E-style Vitest test that performs the demo dataset flow:
 *     1. load demo dataset (TTL)
 *     2. parsing -> rdfManager store population
 *     3. populate currentGraph (setCurrentGraph)
 *     4. simulate editing a node by adding an annotation property (updateNode)
 *     5. assert that only one triple was added to the RDF store (diff of quads)
 *     6. assert that Turtle export contains the new literal
 *
 * Goal: only one change (one triple) should be created by the annotation addition.
 *
 * Call map (high level) - functions -> representative call sites
 * - loadOntologyFromRDF(rdfContent, onProgress?, preserveGraph?)
 *     - src/stores/ontologyStore.ts (primary implementation / entry point for raw RDF payloads)
 *     - Called from: Canvas (loadKnowledgeGraph flow), tests (many)
 *
 * - loadOntology(url)
 *     - src/stores/ontologyStore.ts (loads well-known mocks or fetches remote ontologies)
 *     - Called from: CanvasToolbar, tests
 *
 * - loadKnowledgeGraph(source, options?)
 *     - src/stores/ontologyStore.ts (wraps loadOntologyFromRDF for files/URLs)
 *     - Called from: Canvas (app init)
 *
 * - rdfManager.loadRDF(rdfContent)
 *     - src/utils/rdfManager.ts (direct N3 parser -> store)
 *     - Called from: ontologyStore (best-effort store population), tests
 *
 * - rdfManager.applyParsedNamespaces(namespaces)
 *   rdfManager.applyParsedNodes(parsedNodes, options)
 *     - src/utils/rdfManager.ts (centralized idempotent persistence)
 *     - Called from: ontologyStore after parseRDFFile
 *
 * - parseRDFFile(content, onProgress?)
 *     - src/utils/rdfParser.ts (returns parsed graph with nodes/edges/namespaces)
 *     - Called from: ontologyStore.loadOntologyFromRDF and loadOntology
 *
 * - updateNode(entityUri, updates)
 *     - src/utils/rdfManager.ts (low-level store mutation)
 *     - src/stores/ontologyStore.ts (exposes store-level API and updates currentGraph mapping)
 *     - Called from: NodePropertyEditor, tests, internal reapply paths
 *
 * - setCurrentGraph(nodes, edges)
 *     - src/stores/ontologyStore.ts
 *     - Called from: tests, loadOntologyFromRDF to populate diagram graph
 *
 * - exportGraph(format)
 *     - src/stores/ontologyStore.ts -> delegates to rdfManager.exportToTurtle / exportToJsonLD / exportToRdfXml
 *     - Called from: KnowledgeGraphCanvas toolbar and tests
 *
 * Notes on duplication:
 * - The main duplication candidates are: rdfManager.loadRDF (raw parse->store) versus parseRDFFile -> applyParsedNodes. We made both present but idempotent; this test ensures behavior and guards against accidental double-write.
 *
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useOntologyStore } from "../../stores/ontologyStore";
import { FIXTURES } from "../fixtures/rdfFixtures";

describe("Demo flow: single triple change on annotation addition", () => {
  beforeEach(() => {
    const store = useOntologyStore.getState();
    store.clearOntologies();
  });

  it("creates exactly one new triple when adding an annotation property to a demo node", async () => {
    const store = useOntologyStore.getState();

    // Demo TTL (centralized fixture)
    const demoTtl =
      FIXTURES[
        "https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/main/example.ttl"
      ];

    // Step 1: load demo RDF (parsing + store population)
    await store.loadOntologyFromRDF(demoTtl, undefined, false);

    const entityUri =
      "https://github.com/Mat-O-Lab/IOFMaterialsTutorial/SpecimenLength";
    const rdfManager = store.rdfManager;
    const rdfStore = rdfManager.getStore();

    // Snapshot before: serialize quads minimally as "sub|pred|obj"
    const before = rdfStore.getQuads(null, null, null, null).map((q) => {
      const subj = (q.subject && (q.subject as any).value) || String(q.subject);
      const pred =
        (q.predicate && (q.predicate as any).value) || String(q.predicate);
      const obj = (q.object && (q.object as any).value) || String(q.object);
      return `${subj}|${pred}|${obj}`;
    });

    // Step 2: simulate NodePropertyEditor saving a new annotation property (rdfs:label)
    store.updateNode(entityUri, {
      annotationProperties: [
        {
          propertyUri: "rdfs:label",
          value: "Specimen Length Property",
          type: "xsd:string",
        },
      ],
    });

    // Step 3: update currentGraph to reflect the edit (typical canvas behavior)
    const currentGraph = store.currentGraph;
    const updatedNodes = currentGraph.nodes.map((node) => {
      const nodeData = (node as any).data || node;
      const nodeUri =
        nodeData.uri || nodeData.iri || (node as any).uri || (node as any).id;
      if (nodeUri === entityUri) {
        const literalProperties = (nodeData.literalProperties || []).slice();
        literalProperties.push({
          key: "rdfs:label",
          value: "Specimen Length Property",
          type: "xsd:string",
        });
        return { ...node, data: { ...nodeData, literalProperties } };
      }
      return node;
    });
    store.setCurrentGraph(updatedNodes, currentGraph.edges);

    // Step 4: snapshot after update
    const after = rdfStore.getQuads(null, null, null, null).map((q) => {
      const subj = (q.subject && (q.subject as any).value) || String(q.subject);
      const pred =
        (q.predicate && (q.predicate as any).value) || String(q.predicate);
      const obj = (q.object && (q.object as any).value) || String(q.object);
      return `${subj}|${pred}|${obj}`;
    });

    // Compute diff: values present in after but not in before
    const beforeSet = new Set(before);
    const added = after.filter((x) => !beforeSet.has(x));

    // Expect exactly one new triple
    expect(added.length).toBe(1);

    // Check that the added triple is the expected rdfs:label literal
    const addedTriple = added[0];
    expect(addedTriple).toContain(entityUri);
    expect(addedTriple).toContain("http://www.w3.org/2000/01/rdf-schema#label");
    expect(addedTriple).toContain("Specimen Length Property");

    // Export Turtle and confirm the label appears in exported output
    const exported = await store.exportGraph("turtle");
    expect(exported).toContain("Specimen Length Property");
    expect(exported).toContain("rdfs:label");
  });
});
