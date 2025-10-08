import { it } from "vitest";
import { useOntologyStore } from "../../stores/ontologyStore";
import { WELL_KNOWN } from "../../utils/wellKnownOntologies";

// This demo test loads two well-known ontology URLs via the store.loadOntology
// path and prints the resulting loadedOntologies so you can inspect count/urls.
// It intentionally does not assert anything — it's a diagnostic script to observe behavior.
it("demo: load multiple ontologies and print loadedOntologies", async () => {
  const store = useOntologyStore.getState();

  // clear prior state
  store.clearOntologies();

  // Load FOAF and ORG well-known entries (use canonical values from WELL_KNOWN)
  const foafUrl = (WELL_KNOWN && WELL_KNOWN.prefixes && WELL_KNOWN.prefixes.foaf) || "http://xmlns.com/foaf/0.1/";
  const orgUrl = (WELL_KNOWN && WELL_KNOWN.prefixes && WELL_KNOWN.prefixes.org) || "http://www.w3.org/ns/org#";

  await store.loadOntology(foafUrl);
  await store.loadOntology(orgUrl);

  // Also load the FOAF URL again to see deduplication behavior (use canonical value)
  await store.loadOntology(foafUrl);

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
});
