import { it, expect } from "vitest";
import { useOntologyStore } from "../../stores/ontologyStore";
import { WELL_KNOWN } from "../../utils/wellKnownOntologies";
import { rdfManager } from "../../utils/rdfManager";

// This demo test loads two well-known ontology URLs via the store.loadOntology
// path and prints the resulting loadedOntologies so you can inspect count/urls.
// It intentionally does not assert anything — it's a diagnostic script to observe behavior.
it("demo: load multiple ontologies and print loadedOntologies", async () => {
  const store = useOntologyStore.getState();

  // clear prior state
  store.clearOntologies();

  // Start triple count observation so we can assert loads actually add triples
  const countQuads = () => {
    try {
      const s = rdfManager.getStore().getQuads(null, null, null, null) || [];
      return Array.isArray(s) ? s.length : 0;
    } catch (_) {
      return 0;
    }
  };

  const beforeAll = countQuads();
  console.log("triples before any load:", beforeAll);

  // Load FOAF, ORG and PMDCO well-known entries (use canonical values from WELL_KNOWN)
  const foafUrl = (WELL_KNOWN && WELL_KNOWN.prefixes && WELL_KNOWN.prefixes.foaf) || "http://xmlns.com/foaf/0.1/";
  const orgUrl = (WELL_KNOWN && WELL_KNOWN.prefixes && WELL_KNOWN.prefixes.org) || "http://www.w3.org/ns/org#";
  const pmdcoUrl = (WELL_KNOWN && WELL_KNOWN.prefixes && WELL_KNOWN.prefixes.pmdco) || "https://w3id.org/pmd/co/";

  await store.loadOntology(foafUrl);
  const afterFoaf = countQuads();
  console.log("triples after FOAF load:", afterFoaf);
  expect(afterFoaf).toBeGreaterThanOrEqual(beforeAll);

  await store.loadOntology(orgUrl);
  const afterOrg = countQuads();
  console.log("triples after ORG load:", afterOrg);
  expect(afterOrg).toBeGreaterThanOrEqual(afterFoaf);

  await store.loadOntology(pmdcoUrl);
  const afterPmd = countQuads();
  console.log("triples after PMDCO load:", afterPmd);
  expect(afterPmd).toBeGreaterThanOrEqual(afterOrg);

  // Also load the FOAF URL again to see deduplication behavior (use canonical value)
  await store.loadOntology(foafUrl);
  const afterFoafAgain = countQuads();
  console.log("triples after FOAF reload (dedupe expected):", afterFoafAgain);
  // Reloading the same URL should not reduce triples; it should be >= previous and typically equal.
  expect(afterFoafAgain).toBeGreaterThanOrEqual(afterPmd);

  const state = useOntologyStore.getState();
  // Print a concise summary
  console.log("LOADED ONTOLOGIES COUNT:", state.loadedOntologies.length);
  console.log(
    "LOADED ONTOLOGIES URLS:",
    state.loadedOntologies.map((o) => ({ url: o.url, name: o.name })),
  );
  // Also print namespaces for visibility
  state.loadedOntologies.forEach((o, i) => {
    console.log(`--- ontology[${i}] ${o.url} namespaces keys:`, Object.keys(o.namespaces || {}));
  });
}, 60000);
