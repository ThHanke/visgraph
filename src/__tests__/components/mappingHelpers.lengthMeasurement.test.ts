import { test, expect } from "vitest";
import { FIXTURES } from "../fixtures/rdfFixtures";
import mapQuadsToDiagram from "../../components/Canvas/core/mappingHelpers";
import { Parser as N3Parser } from "n3";
import { RDF, RDFS, OWL } from "../../constants/vocabularies";

test("mappingHelpers length measurement fixture (parsed via rdf store/parser) - human friendly output", async () => {
  // Use the provided fixture content (local, no network)
  const ttl = FIXTURES["https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/refs/heads/main/LengthMeasurement.ttl"];
  expect(ttl).toBeTruthy();

  // Parse TTL into N3 quads and normalize to the plain POJO shape mapQuadsToDiagram expects.
  const parser = new N3Parser({ format: "text/turtle" });
  const parsed = parser.parse(ttl);
  const quads: any[] = [];
  for (const q of parsed) {
    {
      const subj = q.subject && q.subject.value ? { value: String(q.subject.value) } : undefined;
      const pred = q.predicate && q.predicate.value ? { value: String(q.predicate.value) } : undefined;
      const objRaw = q.object;
      let obj: any = undefined;
      if (objRaw) {
        if (objRaw.termType === "Literal") {
          obj = {
            value: String(objRaw.value),
            termType: "Literal",
            datatype: objRaw.datatype && objRaw.datatype.value ? { value: String(objRaw.datatype.value) } : undefined,
            language: objRaw.language || undefined,
          };
        } else {
          obj = { value: String(objRaw.value), termType: String(objRaw.termType) };
        }
      }
      if (subj && pred && obj) {
        // Place everything into urn:vg:data graph to simulate data-graph load per request
        quads.push({ subject: subj, predicate: pred, object: obj, graph: { value: "urn:vg:data" } });
      }
    }
  }

  // Derive fat-map (availableProperties / availableClasses) from the parsed quads so mapper can emit edges.
  const propIris = new Set<string>();
  const classIris = new Set<string>();
  const labels = new Map<string, string>();

  // Use the raw parsed N3 quads to derive types and labels
  for (const q of parsed) {
    {
      const pred = q.predicate && q.predicate.value ? String(q.predicate.value) : "";
      const subj = q.subject && q.subject.value ? String(q.subject.value) : "";
      const obj = q.object && q.object.value ? String(q.object.value) : "";

      if (!pred || !subj) continue;

      if (pred === RDF.type) {
        if (obj === OWL.ObjectProperty || obj === OWL.AnnotationProperty || /Property$/.test(obj)) {
          propIris.add(subj);
        }
        if (obj === OWL.Class || /Class$/.test(obj)) {
          classIris.add(subj);
        }
      }

      if (pred === RDFS.label && q.object && q.object.value) {
        labels.set(subj, String(q.object.value));
      }
    }
  }

    const availableProperties = Array.from(propIris).map((iri) => {
    const label = labels.get(iri) || String(iri).split(new RegExp('[#/]')).filter(Boolean).pop() || iri;
    const nsMatch = iri.match(new RegExp('^(.*[/#])'));
    return { iri, label, namespace: nsMatch && nsMatch[1] ? nsMatch[1] : "" };
  });

  const availableClasses = Array.from(classIris).map((iri) => {
    const label = labels.get(iri) || String(iri).split(new RegExp('[#/]')).filter(Boolean).pop() || iri;
    const nsMatch = iri.match(new RegExp('^(.*[/#])'));
    return { iri, label, namespace: nsMatch && nsMatch[1] ? nsMatch[1] : "" };
  });

  const options: any = {
    availableProperties,
    availableClasses,
    registry: [
      { prefix: "ex", namespace: "https://github.com/Mat-O-Lab/IOFMaterialsTutorial/", color: "" },
      { prefix: "dct", namespace: "http://purl.org/dc/terms/", color: "" },
      { prefix: "iof", namespace: "https://spec.industrialontologies.org/ontology/core/Core/", color: "" },
      { prefix: "iof-mat", namespace: "https://spec.industrialontologies.org/ontology/materials/Materials/", color: "" },
      { prefix: "iof-qual", namespace: "https://spec.industrialontologies.org/ontology/qualities/", color: "" },
      { prefix: "owl", namespace: OWL.namespace, color: "" },
      { prefix: "rdfs", namespace: RDFS.namespace, color: "" },
    ],
  };

  // Run mapper
  const diagram = mapQuadsToDiagram(quads, options);
  const nodes = diagram.nodes || [];
  const edges = diagram.edges || [];

  // Human-friendly output
  console.log("");
  console.log("=== mappingHelpers LengthMeasurement fixture output ===");
  console.log("Total quads parsed:", quads.length);
  console.log("Nodes produced:", nodes.length);
  for (const n of nodes) {
    {
      const d = (n.data || {}) as any;
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
      const dd = (e.data || {}) as any;
      console.log(`- Edge id=${e.id} ${e.source} -> ${e.target} prop=${String(dd.propertyUri || dd.propertyType || dd.label || "")}`);
    }
  }
  console.log("=== end ===");
  console.log("");

  expect(diagram).toBeDefined();
  // Basic assertions so test is meaningful
  expect(nodes.length).toBeGreaterThan(0);
});
