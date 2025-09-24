import { it } from "vitest";
import { useOntologyStore } from "../../stores/ontologyStore";

// This demo test loads two well-known ontology URLs via the store.loadOntology
// path and prints the resulting loadedOntologies so you can inspect count/urls.
// It intentionally does not assert anything — it's a diagnostic script to observe behavior.
it("demo: load multiple ontologies and print loadedOntologies", async () => {
  const store = useOntologyStore.getState();

  // clear prior state
  store.clearOntologies();

  // Load FOAF and ORG well-known entries (matches test fixtures)
  await store.loadOntology("http://xmlns.com/foaf/0.1/");
  await store.loadOntology("https://www.w3.org/TR/vocab-org/");

  // Also load the FOAF URL again (different variant) to see deduplication behavior
  await store.loadOntology("https://xmlns.com/foaf/0.1/"); // variant to test normalization

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
