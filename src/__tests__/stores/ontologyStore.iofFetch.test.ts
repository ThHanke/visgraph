import { describe, it, expect, vi } from "vitest";
import { useOntologyStore } from "../../stores/ontologyStore";
import { FIXTURES } from "../fixtures/rdfFixtures";

describe("IOF ontology fetch and RDF persistence", () => {
  it("fetches IOF ontology with correct Accept header and loads triples into RDF store", async () => {
    const store = useOntologyStore.getState();
    store.clearOntologies();

    const url = "https://spec.industrialontologies.org/ontology/core/Core/";

    // Minimal Turtle that defines a class instance using the IOF namespace
    const ttl =
      FIXTURES["https://spec.industrialontologies.org/ontology/core/Core/"];

    // Mock global.fetch to return Turtle and capture headers
    const mockFetch = vi.fn(async (input: any, init?: any) => {
      return {
        ok: true,
        url: typeof input === "string" ? input : (input && input.url) || url,
        headers: {
          get: (name: string) => {
            if (name.toLowerCase() === "content-type") return "text/turtle";
            return null;
          },
        },
        text: async () => ttl,
      };
    });

    // Install the mock
    (global as any).fetch = mockFetch;

    // Call loadKnowledgeGraph which should fetch the URL and eventually populate the RDF store
    await store.loadKnowledgeGraph(url, {
      onProgress: () => {},
      timeout: 5000,
    });

    // Assert fetch was called and Accept header included text/turtle
    expect(mockFetch).toHaveBeenCalled();
    const calledInit = mockFetch.mock.calls[0][1] || {};
    const acceptHeader = calledInit.headers
      ? calledInit.headers["Accept"] || calledInit.headers.Accept
      : undefined;
    // Older environments may pass headers differently; accept either object or plain header string
    if (typeof acceptHeader === "string") {
      expect(acceptHeader).toMatch(
        /text\/turtle|application\/ld\+json|application\/rdf\+xml/,
      );
    } else {
      // If headers is an object, inspect common header value locations
      const headerObj = calledInit.headers || {};
      const foundAccept = Object.values(headerObj).join(" ");
      expect(foundAccept).toMatch(
        /text\/turtle|application\/ld\+json|application\/rdf\+xml/,
      );
    }

    // Verify the RDF store contains a triple referencing 'Specimen' (expanded IRI or prefixed)
    const mgr = store.getRdfManager();
    const all = mgr.getStore().getQuads(null, null, null, null) || [];
    const found = all.some((q: any) => {
      try {
        const obj = q.object && q.object.value;
        return (
          typeof obj === "string" &&
          (obj.includes("Specimen") ||
            obj.endsWith("/Specimen") ||
            obj.endsWith("#Specimen") ||
            obj.includes(":Specimen"))
        );
      } catch {
        return false;
      }
    });

    expect(found).toBe(true);

    // Cleanup
    store.clearOntologies();
    vi.restoreAllMocks();
  }, 10000);
});
