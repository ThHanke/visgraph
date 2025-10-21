import { it, expect, beforeEach } from "vitest";
import { rdfManager } from "../../utils/rdfManager";

beforeEach(() => {
  rdfManager.clear();
});

it("parses RDF/XML string with filename hint via rdf-parse", async () => {
  const rdfXml = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#">
  <rdf:Description rdf:about="http://example.com/subject">
    <rdfs:label>Example</rdfs:label>
  </rdf:Description>
</rdf:RDF>`;

  await rdfManager.loadRDFIntoGraph(rdfXml, "urn:vg:test", undefined, "ontology.rdf");
  const quads = rdfManager.getStore().getQuads(
    "http://example.com/subject",
    null,
    null,
    "urn:vg:test",
  ) || [];
  expect(quads.length).toBeGreaterThanOrEqual(1);
});

it("parses RDF/XML string without filename (content-detection)", async () => {
  const rdfXml = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#">
  <rdf:Description rdf:about="http://example.com/subject2">
    <rdfs:label>Example2</rdfs:label>
  </rdf:Description>
</rdf:RDF>`;

  await rdfManager.loadRDFIntoGraph(rdfXml, "urn:vg:test2");
  const quads = rdfManager.getStore().getQuads(
    "http://example.com/subject2",
    null,
    null,
    "urn:vg:test2",
  ) || [];
  expect(quads.length).toBeGreaterThanOrEqual(1);
});
