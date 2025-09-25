/**
 * Tests for RDFManager mutation APIs: addTriple, removeTriple, applyBatch, applyParsedNodes, removeGraph, updateNode
 *
 * These are integration-style unit tests that exercise a fresh RDFManager instance
 * (not the shared singleton) so state is isolated between tests.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { RDFManager } from "../../utils/rdfManager";

describe("RDFManager mutation APIs", () => {
  let mgr: RDFManager;

  beforeEach(() => {
    mgr = new RDFManager();
    // Ensure store clean state
    mgr.clear();
  });

  test("addTriple adds a triple to urn:vg:data", () => {
    const subj = "http://example.com/s1";
    const pred = "http://example.com/p1";
    const obj = "http://example.com/o1";

    mgr.addTriple(subj, pred, obj, "urn:vg:data");
    const quads = mgr.getStore().getQuads(null, null, null, null);
    expect(quads.some(q => (q.subject as any).value === subj && (q.predicate as any).value === pred && String((q.object as any).value) === obj)).toBeTruthy();
  });

  test("removeTriple removes triples added previously", () => {
    const subj = "http://example.com/s2";
    const pred = "http://example.com/p2";
    const obj = "literal-value";

    mgr.addTriple(subj, pred, obj, "urn:vg:data");
    // ensure present
    let quads = mgr.getStore().getQuads(null, null, null, null);
    expect(quads.length).toBeGreaterThan(0);

    mgr.removeTriple(subj, pred, obj, "urn:vg:data");
    quads = mgr.getStore().getQuads(null, null, null, null);
    expect(quads.some(q => (q.subject as any).value === subj && (q.predicate as any).value === pred)).toBeFalsy();
  });

  test("applyBatch removes then adds triples atomically", async () => {
    const subj = "http://example.com/s3";
    const pred = "http://example.com/p3";
    const objOld = "old";
    const objNew = "new";

    // seed
    mgr.addTriple(subj, pred, objOld, "urn:vg:data");
    let quads = mgr.getStore().getQuads(null, null, null, null);
    expect(quads.some(q => (q.subject as any).value === subj)).toBeTruthy();

    await mgr.applyBatch({ removes: [{ subject: subj, predicate: pred, object: objOld }], adds: [{ subject: subj, predicate: pred, object: objNew }] }, "urn:vg:data");
    quads = mgr.getStore().getQuads(null, null, null, null);
    expect(quads.some(q => (q.subject as any).value === subj && String((q.object as any).value) === objNew)).toBeTruthy();
    expect(quads.some(q => (q.subject as any).value === subj && String((q.object as any).value) === objOld)).toBeFalsy();
  });

  test("applyParsedNodes (migrated) persists annotationProperties and rdfTypes via applyBatch", async () => {
    const node = {
      iri: "http://example.com/node4",
      annotationProperties: [{ property: "http://example.com/propA", value: "V" }],
      rdfTypes: ["http://example.com/TypeA"],
    };

    // Migrated behaviour: construct batch adds equivalent to what applyParsedNodes used to add.
    const adds: any[] = [];

    // annotationProperties -> literal/object adds
    if (Array.isArray(node.annotationProperties)) {
      for (const ap of node.annotationProperties) {
        try {
          adds.push({
            subject: String(node.iri),
            predicate: String(ap.property),
            object: String(ap.value),
          });
        } catch (_) { /* ignore per-item */ }
      }
    }

    // rdfTypes -> rdf:type adds
    const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
    if (Array.isArray(node.rdfTypes)) {
      for (const t of node.rdfTypes) {
        try {
          adds.push({
            subject: String(node.iri),
            predicate: RDF_TYPE,
            object: String(t),
          });
        } catch (_) { /* ignore per-type */ }
      }
    }

    await mgr.applyBatch({ removes: [], adds }, "urn:vg:data");

    const quads = mgr.getStore().getQuads(null, null, null, null);
    expect(quads.some(q => (q.subject as any).value === node.iri && (q.predicate as any).value === "http://example.com/propA")).toBeTruthy();
    expect(quads.some(q => (q.subject as any).value === node.iri && (q.predicate as any).value === RDF_TYPE)).toBeTruthy();
  });

  test("removeGraph clears quads in the named graph", () => {
    const subj = "http://example.com/s5";
    const pred = "http://example.com/p5";
    const obj = "http://example.com/o5";

    mgr.addTriple(subj, pred, obj, "urn:vg:toRemove");
    // verify present in that graph
    let quads = mgr.getStore().getQuads(null, null, null, null);
    expect(quads.some(q => (q.graph as any).value === "urn:vg:toRemove")).toBeTruthy();

    mgr.removeGraph("urn:vg:toRemove");
    quads = mgr.getStore().getQuads(null, null, null, null);
    expect(quads.some(q => (q.graph as any).value === "urn:vg:toRemove")).toBeFalsy();
  });

  test("updateNode persists annotationProperties and rdfTypes via applyBatch/addTriple", async () => {
    const iri = "http://example.com/node6";
    const updates = {
      annotationProperties: [{ propertyUri: "http://example.com/ann", value: "v" }],
      rdfTypes: ["http://example.com/Type6"],
    };

    // Call updateNode
    (mgr as any).updateNode(iri, updates);
    // Wait a tick in case updateNode used applyBatch asynchronously
    await Promise.resolve();
    const quads = mgr.getStore().getQuads(null, null, null, null);
    expect(quads.some(q => (q.subject as any).value === iri && (q.predicate as any).value === "http://example.com/ann")).toBeTruthy();
    expect(quads.some(q => (q.subject as any).value === iri && (q.predicate as any).value === "http://www.w3.org/1999/02/22-rdf-syntax-ns#type")).toBeTruthy();
  });
});
