import { describe, test, expect, beforeEach } from "vitest";
import mapQuadsToDiagram from "../../components/Canvas/core/mappingHelpers";
import { rdfManager } from "../../utils/rdfManager";
import { FIXTURES } from "../fixtures/rdfFixtures";

describe("mapQuadsToDiagram - specimen fixture integration", () => {
  beforeEach(() => {
    rdfManager.clear();
  });

  test("Specimen node from fixture should be ABox and have classType set to iof-mat:Specimen (prefixed)", async () => {
    const ttl = FIXTURES["https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/main/specimen.ttl"];
    // Load into data graph so mapper picks it up
    await rdfManager.loadRDFIntoGraph(ttl, "urn:vg:data", "text/turtle");

    const store = rdfManager.getStore();
    // Collect all quads and filter to the data graph (avoid passing non-term graph objects to N3)
    const allQuads = store.getQuads(null, null, null, null) || [];
    const all = (allQuads || []).filter((q: any) => {
      try {
        const g = q && q.graph ? (q.graph.value || q.graph.id || q.graph) : undefined;
        return String(g || "").includes("urn:vg:data");
      } catch (_) {
        return false;
      }
    });

    // Map to diagram (no fat-map available via rdfManager in this test; pass empty availableProperties)
    const diagram = mapQuadsToDiagram(all, { availableProperties: [] });

    // Find specimen node id (subject IRI in fixture)
    const specimenIri = "https://github.com/Mat-O-Lab/IOFMaterialsTutorial/Specimen";
    const node = (diagram.nodes || []).find((n: any) => String(n.id) === specimenIri);
    expect(node).toBeDefined();

    // It should be marked as ABox (isTBox === false)
    expect(node.data.isTBox).toBe(false);

    // classType should be the iof-mat:Specimen full IRI (or prefixed later by UI) — ensure the stored classType contains the iof-mat namespace
    const classType = node.data.classType as string | undefined;
    expect(classType).toBeTruthy();
    expect(classType).toContain("spec.industrialontologies.org/ontology/materials/Materials");

    // displayPrefixed (for the node) should not be used as the badge; instead the class display should be available.
    // compute prefixed form for the classType using rdfManager namespaces (toPrefixed inside UI will do this),
    // here simply ensure the classType is not the same as the node IRI (i.e., not showing ':Specimen' as the class badge)
    expect(classType).not.toBe(specimenIri);

    // Additionally assert that the node.displayPrefixed exists (prefixed for the node itself)
    expect(node.data.displayPrefixed).toBeTruthy();
  }, 20000);
});
