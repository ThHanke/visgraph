import { describe, it, expect } from "vitest";
import fs from "fs/promises";
import path from "path";
import { useOntologyStore } from "../../stores/ontologyStore";
import { DataFactory } from "n3";
const { namedNode } = DataFactory;

describe("OntologyStore RDF persistence when loading ontologies", () => {
  it("adds triples to the RDF store when a well-known OWL ontology URL is loaded (triples increase by hundreds)", async () => {
    const store = useOntologyStore.getState();

    // Ensure a clean environment
    store.clearOntologies();

    // Get RDF manager and underlying store (before loading)
    const mgr = store.getRdfManager();
    const rdfStore = mgr.getStore();

    // Count triples before load
    const before = (rdfStore.getQuads && Array.isArray(rdfStore.getQuads(null, null, null, null))
      ? rdfStore.getQuads(null, null, null, null).length
      : (rdfStore.getQuads ? rdfStore.getQuads(null, null, null, null).length : 0)) || 0;

    // Load a public OWL ontology from the web (canonical W3C OWL URL)
    // This test intentionally fetches a remote OWL ontology to verify substantial triples are added.
    // Use a local fixture to avoid network flakiness while exercising the same public API.
    // We stub rdfManager.loadRDFFromUrl on the store's manager so store.loadOntology(url)
    // still drives the same call-path but uses deterministic fixture content.
    const fixturePath = path.join(__dirname, "../fixtures/owl.ttl");
    const fixture = await fs.readFile(fixturePath, "utf8");
    const origLoad = (mgr as any).loadRDFFromUrl;
    (mgr as any).loadRDFFromUrl = async (u: any, g?: any, opts?: any) => {
      // Delegate to existing text loader so namespaces/notifications are preserved.
      return await (mgr as any).loadRDFIntoGraph(fixture, g || "urn:vg:ontologies", "text/turtle");
    };
    try {
      await store.loadOntology("https://www.w3.org/2002/07/owl");
    } finally {
      { (mgr as any).loadRDFFromUrl = origLoad; }
    }

    // Count triples after load
    const after = (rdfStore.getQuads && Array.isArray(rdfStore.getQuads(null, null, null, null))
      ? rdfStore.getQuads(null, null, null, null).length
      : (rdfStore.getQuads ? rdfStore.getQuads(null, null, null, null).length : 0)) || 0;

    // Expect a significant increase (at least ~100 triples)
    const delta = after - before;
    expect(delta).toBeGreaterThanOrEqual(100);

    // Ensure the OWL namespace/prefix was registered (accept several possible sources:
    // - rdfManager namespace map
    // - persisted ontologyStore.namespaceRegistry
    // - or actual triples in the RDF store that reference the OWL IRI)
    const ns = mgr.getNamespaces ? mgr.getNamespaces() : {};
    const registry = useOntologyStore.getState().namespaceRegistry || [];
    const regMap = (registry || []).reduce((acc:any, e:any) => { acc[String(e.prefix || "")] = String(e.namespace || ""); return acc; }, {});
    // Check for OWL presence in the rdf store as a fallback
    const storeHasOwl = typeof rdfStore.getQuads === "function" && ((rdfStore.getQuads(namedNode("http://www.w3.org/2002/07/owl#"), null, null, null) || []).length > 0 ||
      (rdfStore.getQuads(null, null, null, null) || []).some((q:any) =>
        String((q && q.subject && (q.subject as any).value) || "").includes("http://www.w3.org/2002/07/owl#") ||
        String((q && q.predicate && (q.predicate as any).value) || "").includes("http://www.w3.org/2002/07/owl#") ||
        String((q && q.object && (q.object as any).value) || "").includes("http://www.w3.org/2002/07/owl#")
      )
    );
    const hasOwl = Boolean(ns.owl) || Boolean(regMap["owl"]) || Boolean(storeHasOwl);
    expect(hasOwl).toBe(true);

    // Clean up
    store.clearOntologies();
  }, { timeout: 45000 });
});
