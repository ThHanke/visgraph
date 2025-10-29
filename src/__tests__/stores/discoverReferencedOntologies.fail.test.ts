import { expect, test, vi } from "vitest";
import { DataFactory } from "n3";
import { useOntologyStore } from "../../../src/stores/ontologyStore";

const { namedNode } = DataFactory;

test("discoverReferencedOntologies does not leave a loadedOntologies entry when load fails", async () => {
  // Prepare: snapshot original state so we can restore afterwards
  const storeApi = (useOntologyStore as any);
  const originalState = { ...storeApi.getState() };

  try {
    // Create a fake RDF store that exposes getQuads and returns one owl:imports triple
    const fakeStore = {
      getQuads: (s: any, p: any, o: any, g: any) => {
        const OWL_IMPORTS = "http://www.w3.org/2002/07/owl#imports";
        // Return a single quad when predicate matches owl:imports (and any graph)
        if (p && (p.value === OWL_IMPORTS || String(p) === OWL_IMPORTS)) {
          return [
            {
              subject: namedNode("http://example.org/ont"),
              predicate: namedNode(OWL_IMPORTS),
              object: namedNode("http://example.org/import1"),
              graph: g || namedNode("urn:vg:data"),
            },
          ];
        }
        return [];
      },
    };

    // Replace rdfManager with a minimal fake that returns our fakeStore
    const fakeMgr = { getStore: () => fakeStore };

    // Install fake manager into the store
    storeApi.setState({ rdfManager: fakeMgr, loadedOntologies: [] });

    // Mock the store's loadOntology to simulate a failure (network/CORS) for the import URL
    const failingUrl = "http://example.org/import1";
    const expectedNorm = failingUrl.startsWith("http://")
      ? failingUrl.replace(/^http:\/\//i, "https://")
      : failingUrl;
    const mockLoadOntology = vi.fn(async (url: string) => {
      if (url && url.indexOf("import1") !== -1) {
        throw new Error("Simulated network failure");
      }
      return;
    });

    // Install mocked loadOntology into store
    storeApi.setState({ loadOntology: mockLoadOntology });

    // Call discoverReferencedOntologies synchronously (we expect it to attempt the load and treat it as failed)
    const res = await (storeApi.getState() as any).discoverReferencedOntologies({
      graphName: "urn:vg:data",
      load: "sync",
      timeoutMs: 2000,
    });

    // Expect a candidate to have been discovered (normalized URL expected)
    expect(Array.isArray(res.candidates)).toBe(true);
    expect(res.candidates).toContain(expectedNorm);

    // Expect results to report the failure for that normalized URL
    expect(Array.isArray(res.results)).toBe(true);
    const resultEntry = (res.results || []).find((r: any) => (r.url || "") === expectedNorm);
    expect(resultEntry).toBeDefined();
    expect(resultEntry.status).toBe("fail");

    // Crucial assertion: the store's loadedOntologies must NOT include the failed URL (any variant)
    const loaded = (storeApi.getState() as any).loadedOntologies || [];
    const found = (loaded || []).some((o: any) => {
      const u = String(o.url || "");
      return u.includes("import1") || u === expectedNorm || u === failingUrl;
    });
    expect(found).toBe(false);
  } finally {
    // Restore original state to avoid polluting other tests
    try {
      // Use setState to restore only the keys we touched (rdfManager, loadedOntologies, loadOntology)
      storeApi.setState({
        rdfManager: (originalState as any).rdfManager || (undefined as any),
        loadedOntologies: (originalState as any).loadedOntologies || [],
        loadOntology: (originalState as any).loadOntology,
      });
    } catch (_) {
      // best-effort restore
    }
  }
});
