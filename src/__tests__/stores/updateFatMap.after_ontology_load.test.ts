import fs from "fs";
import path from "path";
import { expect, test } from "vitest";
import { rdfManager } from "../../utils/rdfManager";
import { useOntologyStore } from "../../stores/ontologyStore";

const fixturesDir = path.resolve(__dirname, "../fixtures");

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForCondition(cond: () => boolean, timeout = 5000, interval = 50) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (cond()) return true;
    } catch (_) {}
    // give background tasks a chance to run
     
    await sleep(interval);
  }
  return false;
}

/**
 * Integration test:
 * - Load data into urn:vg:data
 * - Then load an ontology into urn:vg:ontologies
 * - Verify the fat-map (availableProperties / availableClasses) is populated.
 */
test("rdfManager triggers store.updateFatMap at end of batch ontology load", async () => {
  // Reset RDF manager and ontology store to clean state
  rdfManager.clear();
  useOntologyStore.setState({
    availableProperties: [],
    availableClasses: [],
    loadedOntologies: [],
    namespaceRegistry: [],
    ontologiesVersion: 0,
  } as any);

  // Load data fixture into urn:vg:data
  const dataTtl = fs.readFileSync(path.join(fixturesDir, "minimal-data.ttl"), "utf8");
  await rdfManager.loadRDFIntoGraph(dataTtl, "urn:vg:data", "text/turtle");

  // Allow any incremental reconcile to run
  await sleep(100);

  const propsAfterData = useOntologyStore.getState().availableProperties || [];
  // The property ex:prop should not yet be present because ontology not loaded
  expect(propsAfterData.some((p: any) => String(p.iri) === "http://example.com/prop")).toBe(false);

  // Now load ontology fixture into urn:vg:ontologies — RDF manager should trigger store update at finalize
  const ontTtl = fs.readFileSync(path.join(fixturesDir, "minimal-ont.ttl"), "utf8");
  await rdfManager.loadRDFIntoGraph(ontTtl, "urn:vg:ontologies", "text/turtle");

  // Diagnostic dump: capture the store quads and ontologyStore snapshot to help diagnosis if assertion fails.
  const allQuads = rdfManager.getStore().getQuads(null, null, null, null) || [];
  const sample = allQuads.map((q: any) => ({
    subject: q.subject && q.subject.value,
    predicate: q.predicate && q.predicate.value,
    object: q.object && (q.object.value || q.object),
    graph: q.graph && (q.graph.value || q.graph),
  }));
   
  console.log("[TEST_DUMP] store.quads.count", allQuads.length, "quads:", sample);

  const stBefore = useOntologyStore.getState();
   
  console.log("[TEST_DUMP] ontologyStore availableProperties:", (stBefore.availableProperties || []).map((p:any)=>p.iri));
   
  console.log("[TEST_DUMP] ontologyStore availableClasses:", (stBefore.availableClasses || []).map((c:any)=>c.iri));
   
  console.log("[TEST_DUMP] ontologyStore ontologiesVersion:", stBefore.ontologiesVersion);

  // Wait for the fat-map to reflect the ontology entities
  const found = await waitForCondition(() => {
    const st = useOntologyStore.getState();
    const hasProp = Array.isArray(st.availableProperties) && st.availableProperties.some((p: any) => String(p.iri) === "http://example.com/prop");
    const hasClass = Array.isArray(st.availableClasses) && st.availableClasses.some((c: any) => String(c.iri) === "http://example.com/SomeClass");
    return hasProp && hasClass;
  }, 5000, 50);

  expect(found).toBe(true);
});
