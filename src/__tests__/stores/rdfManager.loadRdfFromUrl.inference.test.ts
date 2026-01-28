import { describe, expect, it, vi, beforeEach } from "vitest";
import { rdfManager } from "../../utils/rdfManager";
import { initRdfManagerWorker } from "../utils/initRdfManagerWorker";

describe("rdfManager.loadRDFFromUrl - content type inference", () => {
  beforeEach(async () => {
    await initRdfManagerWorker();
  });

  it("treats text/plain TTL responses as text/turtle", async () => {
    const ttl = `
@prefix ex: <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
ex:measurement a ex:LengthMeasurement ;
  ex:value "42.0"^^xsd:decimal .
`.trim();

    const headers = {
      get: (name: string) => (name.toLowerCase() === "content-type" ? "text/plain" : null),
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => ({ ok: true, headers, text: async () => ttl }) as any);
    const loadSpy = vi.spyOn(rdfManager as any, "loadRDFIntoGraph").mockResolvedValue(undefined);

    try {
      await rdfManager.loadRDFFromUrl(
        "https://example.org/assets/LengthMeasurement.ttl?raw=1",
        "urn:vg:data",
      );

      expect(loadSpy).toHaveBeenCalledTimes(1);
      const [, , mediaType] = loadSpy.mock.calls[0];
      expect(mediaType).toBe("text/turtle");
    } finally {
      loadSpy.mockRestore();
      fetchMock.mockRestore();
    }
  });
});
