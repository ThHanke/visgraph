// @vitest-environment node
/**
 * Regression test: asserted-triple dedup logic.
 *
 * Konclude's materialize() re-infers triples already present as asserted data.
 * The pipeline dedup (rdfManager.runtime.ts) suppresses these so asserted types
 * keep default styling (not amber "inferred").
 *
 * This test exercises the dedup logic in isolation (no WASM dependency) by
 * simulating what materialize produces and verifying the filter.
 */
import { describe, it, expect } from "vitest";
import * as N3 from "n3";

const { namedNode, quad } = N3.DataFactory;
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDFS_SUBCLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const INFERRED_GRAPH = "urn:vg:inferred";
const EX = "http://example.com/";

/**
 * Simulate the pipeline dedup: build a set of asserted S/P/O keys from the
 * shared store (excluding the inferred graph), then filter out inferred quads
 * whose S/P/O matches.
 */
function dedupInferred(store: N3.Store): N3.Quad[] {
  const inferredGraphNode = namedNode(INFERRED_GRAPH);
  const inferredQuads = store.getQuads(null, null, null, inferredGraphNode);

  const assertedKeys = new Set<string>();
  for (const q of store.getQuads(null, null, null, null)) {
    if (q.graph.value !== INFERRED_GRAPH) {
      assertedKeys.add(`${q.subject.value}\0${q.predicate.value}\0${q.object.value}`);
    }
  }

  return inferredQuads.filter(
    (q) => !assertedKeys.has(`${q.subject.value}\0${q.predicate.value}\0${q.object.value}`),
  );
}

describe("asserted-triple dedup in pipeline", () => {
  it("asserted rdf:type is suppressed from inferred output", () => {
    const store = new N3.Store();
    const ig = namedNode(INFERRED_GRAPH);

    // Asserted: alice rdf:type Employee
    store.addQuad(quad(namedNode(`${EX}alice`), namedNode(RDF_TYPE), namedNode(`${EX}Employee`)));
    // Asserted: Employee rdfs:subClassOf Person
    store.addQuad(quad(namedNode(`${EX}Employee`), namedNode(RDFS_SUBCLASS_OF), namedNode(`${EX}Person`)));

    // Simulated inferred output (what materialize would produce):
    // Re-inferred: alice rdf:type Employee (duplicate of asserted)
    store.addQuad(quad(namedNode(`${EX}alice`), namedNode(RDF_TYPE), namedNode(`${EX}Employee`), ig));
    // Genuinely inferred: alice rdf:type Person
    store.addQuad(quad(namedNode(`${EX}alice`), namedNode(RDF_TYPE), namedNode(`${EX}Person`), ig));

    const deduped = dedupInferred(store);

    // alice rdf:type Employee is asserted → suppressed
    expect(deduped.some(
      (q) => q.subject.value === `${EX}alice` && q.object.value === `${EX}Employee`,
    )).toBe(false);

    // alice rdf:type Person is only inferred → preserved
    expect(deduped.some(
      (q) => q.subject.value === `${EX}alice` && q.object.value === `${EX}Person`,
    )).toBe(true);
  });

  it("triple that is both asserted and inferred — asserted version stays, inferred copy suppressed", () => {
    const store = new N3.Store();
    const ig = namedNode(INFERRED_GRAPH);

    store.addQuad(quad(namedNode(`${EX}A`), namedNode(RDFS_SUBCLASS_OF), namedNode(`${EX}B`)));
    store.addQuad(quad(namedNode(`${EX}A`), namedNode(RDFS_SUBCLASS_OF), namedNode(`${EX}B`), ig));

    const deduped = dedupInferred(store);
    expect(deduped.length).toBe(0);

    // Asserted version still in store
    const asserted = store.getQuads(namedNode(`${EX}A`), namedNode(RDFS_SUBCLASS_OF), namedNode(`${EX}B`), N3.DataFactory.defaultGraph());
    expect(asserted.length).toBe(1);
  });

  it("purely inferred triple with no asserted match survives dedup", () => {
    const store = new N3.Store();
    const ig = namedNode(INFERRED_GRAPH);

    store.addQuad(quad(namedNode(`${EX}alice`), namedNode(RDF_TYPE), namedNode(`${EX}Employee`)));
    store.addQuad(quad(namedNode(`${EX}alice`), namedNode(RDF_TYPE), namedNode(`${EX}Manager`), ig));

    const deduped = dedupInferred(store);
    expect(deduped.length).toBe(1);
    expect(deduped[0].object.value).toBe(`${EX}Manager`);
  });
});
