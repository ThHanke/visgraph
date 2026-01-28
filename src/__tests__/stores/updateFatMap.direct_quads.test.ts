import { test, expect } from "vitest";
import { useOntologyStore } from "../../stores/ontologyStore";
import { rdfManager } from "../../utils/rdfManager";
import { RDF_TYPE, RDFS_LABEL, OWL } from "../../constants/vocabularies";

/**
 * Simple helper utilities (inline to keep test focused)
 */
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForCondition(cond: () => boolean, timeout = 2000, interval = 50) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    {
      if (cond()) return true;
    }
    // give background tasks a chance to run
     
    await sleep(interval);
  }
  return false;
}

test("updateFatMap accepts parsed quads and populates availableProperties/availableClasses", async () => {
  // Reset state
  { rdfManager.clear(); }
  {
    useOntologyStore.setState({
      availableProperties: [],
      availableClasses: [],
      loadedOntologies: [],
      namespaceRegistry: [],
      ontologiesVersion: 0,
    } as any);
  }

  // Build a set of parsed quads (POJO shape) representing ontology TBox in urn:vg:ontologies
  const TTL_NS = "http://example.com/";

  const quads = [
    // ex:prop a owl:ObjectProperty ; rdfs:label "prop" .
    { subject: { value: `${TTL_NS}prop` }, predicate: { value: RDF_TYPE }, object: { value: OWL.ObjectProperty }, graph: { value: "urn:vg:ontologies" } },
    { subject: { value: `${TTL_NS}prop` }, predicate: { value: RDFS_LABEL }, object: { value: "prop" }, graph: { value: "urn:vg:ontologies" } },
    // ex:SomeClass a owl:Class ; rdfs:label "SomeClass" .
    { subject: { value: `${TTL_NS}SomeClass` }, predicate: { value: RDF_TYPE }, object: { value: OWL.Class }, graph: { value: "urn:vg:ontologies" } },
    { subject: { value: `${TTL_NS}SomeClass` }, predicate: { value: RDFS_LABEL }, object: { value: "SomeClass" }, graph: { value: "urn:vg:ontologies" } },
  ];

  // Call updateFatMap directly with parsed quads
  await useOntologyStore.getState().updateFatMap(quads as any);

  // Wait for availableProperties and availableClasses to be populated
  const found = await waitForCondition(() => {
    const st = useOntologyStore.getState();
    const hasProp = Array.isArray(st.availableProperties) && st.availableProperties.some((p: any) => String(p.iri) === `${TTL_NS}prop`);
    const hasClass = Array.isArray(st.availableClasses) && st.availableClasses.some((c: any) => String(c.iri) === `${TTL_NS}SomeClass`);
    return hasProp && hasClass;
  }, 2000, 50);

  expect(found).toBe(true);

  // Basic shape checks
  const st = useOntologyStore.getState();
  const propEntry = (st.availableProperties || []).find((p: any) => String(p.iri) === `${TTL_NS}prop`);
  const classEntry = (st.availableClasses || []).find((c: any) => String(c.iri) === `${TTL_NS}SomeClass`);
  expect(propEntry).toBeDefined();
  expect(classEntry).toBeDefined();
  expect(propEntry.label === "prop" || propEntry.label === `${TTL_NS}prop`).toBeTruthy();
  expect(classEntry.label === "SomeClass" || classEntry.label === `${TTL_NS}SomeClass`).toBeTruthy();
});
