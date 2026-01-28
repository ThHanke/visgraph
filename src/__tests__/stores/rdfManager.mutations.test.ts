/**
 * Tests for RDFManager mutation APIs: addTriple, removeTriple, applyBatch, removeGraph, updateNode
 *
 * These tests use the shared rdfManager singleton with worker initialization.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { initRdfManagerWorker } from "../utils/initRdfManagerWorker";
import { rdfManager } from "../../utils/rdfManager";
import { RDF_TYPE } from "../../constants/vocabularies";

describe("RDFManager mutation APIs", () => {
  beforeEach(async () => {
    await initRdfManagerWorker();
    // Clear the store and wait for it to complete
    rdfManager.clear();
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  test("addTriple adds a triple to urn:vg:data", async () => {
    const subj = "http://example.com/s1";
    const pred = "http://example.com/p1";
    const obj = "http://example.com/o1";

    await rdfManager.applyBatch({
      adds: [{ subject: subj, predicate: pred, object: obj }]
    }, "urn:vg:data");

    // Wait for operation to complete
    await new Promise(resolve => setTimeout(resolve, 200));

    const result = await rdfManager.fetchQuadsPage({
      graphName: "urn:vg:data",
      limit: 100,
      serialize: true
    });

    const quads = result?.items || [];
    expect(quads.some((q: any) => q.subject === subj && q.predicate === pred && q.object === obj)).toBeTruthy();
  });

  test("removeTriple removes triples added previously", async () => {
    const subj = "http://example.com/s2";
    const pred = "http://example.com/p2";
    const obj = "literal-value";

    await rdfManager.applyBatch({
      adds: [{ subject: subj, predicate: pred, object: obj }]
    }, "urn:vg:data");
    await new Promise(resolve => setTimeout(resolve, 200));

    // Verify present
    let result = await rdfManager.fetchQuadsPage({
      graphName: "urn:vg:data",
      limit: 100,
      serialize: true
    });
    const quads = result?.items || [];
    expect(quads.length).toBeGreaterThan(0);

    await rdfManager.applyBatch({
      removes: [{ subject: subj, predicate: pred, object: obj }]
    }, "urn:vg:data");
    await new Promise(resolve => setTimeout(resolve, 200));

    result = await rdfManager.fetchQuadsPage({
      graphName: "urn:vg:data",
      limit: 100,
      serialize: true
    });
    const quads2 = result?.items || [];
    expect(quads2.some((q: any) => q.subject === subj && q.predicate === pred)).toBeFalsy();
  });

  test("applyBatch removes then adds triples atomically", async () => {
    const subj = "http://example.com/s3";
    const pred = "http://example.com/p3";
    const objOld = "old";
    const objNew = "new";

    // Seed
    await rdfManager.applyBatch({
      adds: [{ subject: subj, predicate: pred, object: objOld }]
    }, "urn:vg:data");
    await new Promise(resolve => setTimeout(resolve, 200));

    await rdfManager.applyBatch(
      {
        removes: [{ subject: subj, predicate: pred, object: objOld }],
        adds: [{ subject: subj, predicate: pred, object: objNew }]
      },
      "urn:vg:data"
    );

    await new Promise(resolve => setTimeout(resolve, 200));

    const result = await rdfManager.fetchQuadsPage({
      graphName: "urn:vg:data",
      limit: 100,
      serialize: true
    });

    const quads = result?.items || [];
    expect(quads.some((q: any) => q.subject === subj && q.object === objNew)).toBeTruthy();
    expect(quads.some((q: any) => q.subject === subj && q.object === objOld)).toBeFalsy();
  });

  test("applyParsedNodes (migrated) persists annotationProperties and rdfTypes via applyBatch", async () => {
    const node = {
      iri: "http://example.com/node4",
      annotationProperties: [{ property: "http://example.com/propA", value: "V" }],
      rdfTypes: ["http://example.com/TypeA"],
    };

    const adds: any[] = [];

    if (Array.isArray(node.annotationProperties)) {
      for (const ap of node.annotationProperties) {
        adds.push({
          subject: String(node.iri),
          predicate: String(ap.property),
          object: String(ap.value),
        });
      }
    }

    if (Array.isArray(node.rdfTypes)) {
      for (const t of node.rdfTypes) {
        adds.push({
          subject: String(node.iri),
          predicate: RDF_TYPE,
          object: String(t),
        });
      }
    }

    await rdfManager.applyBatch({ removes: [], adds }, "urn:vg:data");
    await new Promise(resolve => setTimeout(resolve, 200));

    const result = await rdfManager.fetchQuadsPage({
      graphName: "urn:vg:data",
      limit: 100,
      serialize: true
    });

    const quads = result?.items || [];
    expect(quads.some((q: any) => q.subject === node.iri && q.predicate === "http://example.com/propA")).toBeTruthy();
    expect(quads.some((q: any) => q.subject === node.iri && q.predicate === RDF_TYPE)).toBeTruthy();
  });

  test("removeGraph clears quads in the named graph", async () => {
    const subj = "http://example.com/s5";
    const pred = "http://example.com/p5";
    const obj = "http://example.com/o5";

    await rdfManager.applyBatch({
      adds: [{ subject: subj, predicate: pred, object: obj }]
    }, "urn:vg:toRemove");
    await new Promise(resolve => setTimeout(resolve, 200));

    // Verify present
    let result = await rdfManager.fetchQuadsPage({
      graphName: "urn:vg:toRemove",
      limit: 100,
      serialize: true
    });
    let quads = result?.items || [];
    expect(quads.length).toBeGreaterThan(0);

    rdfManager.removeGraph("urn:vg:toRemove");
    await new Promise(resolve => setTimeout(resolve, 200));

    result = await rdfManager.fetchQuadsPage({
      graphName: "urn:vg:toRemove",
      limit: 100,
      serialize: true
    });
    quads = result?.items || [];
    expect(quads.length).toBe(0);
  });

  test("updateNode persists annotationProperties and rdfTypes via applyBatch/addTriple", async () => {
    const iri = "http://example.com/node6";
    const updates = {
      adds: [
        { subject: iri, predicate: "http://example.com/ann", object: "v" },
        { subject: iri, predicate: RDF_TYPE, object: "http://example.com/Type6" }
      ]
    };

    rdfManager.updateNode(iri, updates);
    await new Promise(resolve => setTimeout(resolve, 200));

    const result = await rdfManager.fetchQuadsPage({
      graphName: "urn:vg:data",
      limit: 100,
      serialize: true
    });

    const quads = result?.items || [];
    expect(quads.some((q: any) => q.subject === iri && q.predicate === "http://example.com/ann")).toBeTruthy();
    expect(quads.some((q: any) => q.subject === iri && q.predicate === RDF_TYPE)).toBeTruthy();
  });
});
