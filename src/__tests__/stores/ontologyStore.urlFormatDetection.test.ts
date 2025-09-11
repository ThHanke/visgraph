import { describe, it, expect, vi } from "vitest";
import { useOntologyStore } from "../../stores/ontologyStore";
import { FIXTURES } from "../fixtures/rdfFixtures";

describe("OntologyStore URL format detection and RDF loading", () => {
  it("loads Turtle from IOF-like URL and persists triples (count increases)", async () => {
    const store = useOntologyStore.getState();
    store.clearOntologies();

    const url = "https://spec.industrialontologies.org/iof/ontology/core/Core/";

    const ttl =
      FIXTURES["https://spec.industrialontologies.org/iof/ontology/core/Core/"];

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

    (global as any).fetch = mockFetch;

    const mgr = store.getRdfManager();
    const before = mgr.getStore().getQuads(null, null, null, null).length;

    await store.loadKnowledgeGraph(url, {
      onProgress: () => {},
      timeout: 5000,
    });

    expect(mockFetch).toHaveBeenCalled();
    const calledInit = mockFetch.mock.calls[0][1] || {};
    const acceptHeader = calledInit.headers
      ? calledInit.headers["Accept"] || calledInit.headers.Accept
      : undefined;
    if (typeof acceptHeader === "string") {
      expect(acceptHeader).toMatch(
        /text\/turtle|application\/ld\+json|application\/rdf\+xml/,
      );
    } else {
      const headerObj = calledInit.headers || {};
      const foundAccept = Object.values(headerObj).join(" ");
      expect(foundAccept).toMatch(
        /text\/turtle|application\/ld\+json|application\/rdf\+xml/,
      );
    }

    const all = mgr.getStore().getQuads(null, null, null, null) || [];
    const found = all.some((q: any) => {
      try {
        const obj = q.object && ((q.object && q.object.value) || q.object);
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

    const after = mgr.getStore().getQuads(null, null, null, null).length;
    expect(after).toBeGreaterThan(before);
    expect(found).toBe(true);

    store.clearOntologies();
    vi.restoreAllMocks();
  }, 10000);

  it("loads RDF/XML from a .owl file URL and persists triples (count increases)", async () => {
    const store = useOntologyStore.getState();
    store.clearOntologies();

    const url =
      "https://materialdigital.github.io/logistics-application-ontology/ontology.owl";

    const rdfXml = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:iof="https://spec.industrialontologies.org/iof/ontology/core/Core/"
         xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#">
  <rdf:Description rdf:about="http://example.com/subject">
    <rdf:type rdf:resource="https://spec.industrialontologies.org/iof/ontology/core/Core/Specimen"/>
    <rdfs:label>Example Specimen</rdfs:label>
  </rdf:Description>
</rdf:RDF>`;

    const mockFetch = vi.fn(async (input: any, init?: any) => {
      return {
        ok: true,
        url: typeof input === "string" ? input : (input && input.url) || url,
        headers: {
          get: (name: string) => {
            if (name.toLowerCase() === "content-type")
              return "application/rdf+xml";
            return null;
          },
        },
        text: async () => rdfXml,
      };
    });

    (global as any).fetch = mockFetch;

    const mgr = store.getRdfManager();
    const before = mgr.getStore().getQuads(null, null, null, null).length;

    await store.loadKnowledgeGraph(url, {
      onProgress: () => {},
      timeout: 5000,
    });

    expect(mockFetch).toHaveBeenCalled();

    const all = mgr.getStore().getQuads(null, null, null, null) || [];
    const found = all.some((q: any) => {
      try {
        const subj = q.subject && q.subject.value;
        const obj = q.object && q.object.value;
        return (
          (typeof subj === "string" && subj.includes("example.com/subject")) ||
          (typeof obj === "string" &&
            (obj.includes("Specimen") ||
              obj.endsWith("/Specimen") ||
              obj.endsWith("#Specimen")))
        );
      } catch {
        return false;
      }
    });

    const after = mgr.getStore().getQuads(null, null, null, null).length;
    expect(after).toBeGreaterThan(before);
    expect(found).toBe(true);

    store.clearOntologies();
    vi.restoreAllMocks();
  }, 10000);
});
