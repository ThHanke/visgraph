import { test, expect } from "vitest";
import mapQuadsToDiagram from "../../components/Canvas/core/mappingHelpers";
import { RDF_TYPE, RDFS, OWL } from "../../constants/vocabularies";

test("mappingHelpers tbox/annotation property examples - human friendly output", () => {
  // Build a batch of quads (all in urn:vg:data) that exercise TBox / AnnotationProperty / blank node cases.
  const G = { value: "urn:vg:data" };

  const quads: any[] = [
    // AnnotationProperty triples (as rdf:type statements)
    { subject: { value: RDFS.label }, predicate: { value: RDF_TYPE }, object: { value: OWL.AnnotationProperty, termType: "NamedNode" }, graph: G },
    { subject: { value: "http://purl.org/dc/terms/abstract" }, predicate: { value: RDF_TYPE }, object: { value: OWL.AnnotationProperty, termType: "NamedNode" }, graph: G },
    { subject: { value: "http://purl.org/dc/terms/creator" }, predicate: { value: RDF_TYPE }, object: { value: OWL.AnnotationProperty, termType: "NamedNode" }, graph: G },
    { subject: { value: "http://purl.org/dc/terms/license" }, predicate: { value: RDF_TYPE }, object: { value: OWL.AnnotationProperty, termType: "NamedNode" }, graph: G },
    { subject: { value: OWL.namespace + "versionInfo" }, predicate: { value: RDF_TYPE }, object: { value: OWL.AnnotationProperty, termType: "NamedNode" }, graph: G },

    // Class and ObjectProperty as TBox examples
    { subject: { value: "http://example.org/TestClass" }, predicate: { value: RDF_TYPE }, object: { value: OWL.Class, termType: "NamedNode" }, graph: G },
    { subject: { value: "http://example.org/hasFriend" }, predicate: { value: RDF_TYPE }, object: { value: OWL.ObjectProperty, termType: "NamedNode" }, graph: G },

    // Blank node subject example (bn is also typed)
    { subject: { value: "_:b1" }, predicate: { value: RDF_TYPE }, object: { value: "http://example.org/SomeBlankNodeClass", termType: "NamedNode" }, graph: G },
    { subject: { value: "_:b1" }, predicate: { value: RDFS.label }, object: { value: "Blank node label", termType: "Literal" }, graph: G },

    // Data triple referencing the object property and a label
    { subject: { value: "http://example.com/instance1" }, predicate: { value: "http://example.org/hasFriend" }, object: { value: "http://example.com/instance2", termType: "NamedNode" }, graph: G },
    { subject: { value: "http://example.com/instance1" }, predicate: { value: RDFS.label }, object: { value: "Instance 1", termType: "Literal" }, graph: G },
  ];

  // Provide options with a simple fat-map and registry snapshot
  const options: any = {
    availableProperties: [
      { iri: "http://example.org/hasFriend", label: "hasFriend", namespace: "http://example.org/" },
      { iri: RDFS.label, label: "rdfs:label", namespace: RDFS.namespace },
    ],
    availableClasses: [
      { iri: "http://example.org/TestClass", label: "TestClass", namespace: "http://example.org/" },
    ],
    registry: [
      { prefix: "ex", namespace: "http://example.org/", color: "" },
      { prefix: "rdfs", namespace: RDFS.namespace, color: "" },
      { prefix: "owl", namespace: OWL.namespace, color: "" },
      { prefix: "dct", namespace: "http://purl.org/dc/terms/", color: "" },
      { prefix: "", namespace: "http://example.com/", color: "" },
    ],
  };

  const diagram = mapQuadsToDiagram(quads, options);
  const nodes = diagram.nodes || [];
  const edges = diagram.edges || [];

  const annotationNode = nodes.find((n: any) => String(n.id) === RDFS.label);
  expect(annotationNode).toBeTruthy();
  expect(annotationNode?.data?.isTBox).toBe(true);
  const classNode = nodes.find((n: any) => String(n.id) === "http://example.org/TestClass");
  expect(classNode).toBeTruthy();
  expect(classNode?.data?.isTBox).toBe(true);
  const instanceNode = nodes.find((n: any) => String(n.id) === "http://example.com/instance1");
  expect(instanceNode).toBeTruthy();
  expect(instanceNode?.data?.isTBox).toBe(false);

  // Human-friendly output
  console.log("");
  console.log("=== mappingHelpers tbox test - human friendly output ===");
  console.log("Nodes produced:", nodes.length);
  for (const n of nodes) {
    {
      const d = n.data || {};
      console.log(`- Node id=${String(n.id)} iri=${String(d.iri || n.id)}`);
      console.log(`    rdfTypes: ${JSON.stringify(d.rdfTypes || [])}`);
      console.log(`    displayPrefixed: ${String(d.displayPrefixed || "")}`);
      console.log(`    displayclassType: ${String(d.displayclassType || "")}`);
      console.log(`    isTBox: ${Boolean(d.isTBox)}`);
      console.log(`    label: ${String(d.label || "")}`);
    }
  }
  console.log("Edges produced:", edges.length);
  for (const e of edges) {
    {
      const dd = e.data || {};
      console.log(`- Edge id=${e.id} ${e.source} -> ${e.target} prop=${String(dd.propertyUri || dd.propertyType || dd.label || "")}`);
    }
  }
  console.log("=== end ===");
  console.log("");

  expect(diagram).toBeDefined();
});
